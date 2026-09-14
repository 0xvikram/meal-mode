'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../content/lib.js');

const { parseDuration, remainingSec, fits, scoreCandidate, pickTopUps, extractCards } = lib;

// ---------------------------------------------------------------------------
// A tiny hand-written fake DOM — just enough of querySelectorAll,
// getAttribute, textContent and closest to exercise extractCards. No
// external dependencies (no jsdom).
// ---------------------------------------------------------------------------

class FakeEl {
  constructor(tag, attrs, text) {
    this.tag = tag.toLowerCase();
    this.attrs = Object.assign({}, attrs || {});
    this.text = text || '';
    this.children = [];
    this.parent = null;
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  get textContent() {
    let out = this.text || '';
    for (const child of this.children) out += child.textContent;
    return out;
  }

  descendants() {
    let out = [];
    for (const child of this.children) {
      out.push(child);
      out = out.concat(child.descendants());
    }
    return out;
  }

  querySelectorAll(selectorList) {
    const selectors = splitSelectorList(selectorList);
    return this.descendants().filter((el) => selectors.some((sel) => matchesSelector(el, sel)));
  }

  closest(selectorList) {
    const selectors = splitSelectorList(selectorList);
    let node = this;
    while (node) {
      if (selectors.some((sel) => matchesSelector(node, sel))) return node;
      node = node.parent;
    }
    return null;
  }
}

// Split a comma-separated selector list into trimmed individual selectors.
function splitSelectorList(selectorList) {
  return selectorList.split(',').map((s) => s.trim());
}

// Split a single selector on descendant-combinator whitespace, ignoring
// whitespace inside [...] attribute brackets (e.g. `[aria-label*="a b"]`).
function splitCombinator(sel) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of sel) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Supports simple descendant combinators ("ancestor descendant"): the last
// compound token must match the element itself, and each earlier token must
// match some strict ancestor, in order, walking up the tree.
function matchesSelector(el, sel) {
  const tokens = splitCombinator(sel.trim());
  if (tokens.length === 0) return false;
  const last = tokens[tokens.length - 1];
  if (!matchesCompound(el, last)) return false;

  let node = el.parent;
  for (let idx = tokens.length - 2; idx >= 0; idx--) {
    let found = false;
    while (node) {
      if (matchesCompound(node, tokens[idx])) {
        found = true;
        break;
      }
      node = node.parent;
    }
    if (!found) return false;
    node = node.parent;
  }
  return true;
}

function parseCompound(sel) {
  const m = sel.match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/);
  if (!m) throw new Error('unsupported test selector: ' + sel);
  const result = { tag: m[1] || null, id: null, classes: [], attrs: [] };
  const rest = m[2] || '';
  const partRe = /([#.])([\w-]+)|\[([^\]]+)\]/g;
  let pm;
  while ((pm = partRe.exec(rest))) {
    if (pm[1] === '#') result.id = pm[2];
    else if (pm[1] === '.') result.classes.push(pm[2]);
    else if (pm[3]) {
      const am = pm[3].match(/^([\w-]+)(?:([*^$]?=)"([^"]*)")?$/);
      if (am) result.attrs.push({ name: am[1], op: am[2] || null, value: am[3] || null });
    }
  }
  return result;
}

function matchesCompound(el, sel) {
  if (sel === '*') return true;
  const p = parseCompound(sel);
  if (p.tag && el.tag !== p.tag.toLowerCase()) return false;
  if (p.id && el.getAttribute('id') !== p.id) return false;
  if (p.classes.length) {
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    for (const c of p.classes) if (!cls.includes(c)) return false;
  }
  for (const a of p.attrs) {
    const val = el.getAttribute(a.name);
    if (val === null || val === undefined) return false;
    if (a.op === null) continue;
    if (a.op === '*=' && val.indexOf(a.value) === -1) return false;
    if (a.op === '^=' && val.indexOf(a.value) !== 0) return false;
    if (a.op === '$=' && val.slice(-a.value.length) !== a.value) return false;
    if (a.op === '=' && val !== a.value) return false;
  }
  return true;
}

function E(tag, attrs, text, children) {
  const el = new FakeEl(tag, attrs, text);
  (children || []).forEach((c) => el.appendChild(c));
  return el;
}

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

test('parseDuration: h:mm:ss', () => {
  assert.equal(parseDuration('1:02:33'), 3753);
});

test('parseDuration: m:ss', () => {
  assert.equal(parseDuration('12:05'), 725);
});

test('parseDuration: single-digit seconds like 0:45', () => {
  assert.equal(parseDuration('0:45'), 45);
});

test('parseDuration: LIVE -> null', () => {
  assert.equal(parseDuration('LIVE'), null);
});

test('parseDuration: PREMIERE -> null', () => {
  assert.equal(parseDuration('PREMIERE'), null);
});

test('parseDuration: empty string -> null', () => {
  assert.equal(parseDuration(''), null);
});

test('parseDuration: null -> null', () => {
  assert.equal(parseDuration(null), null);
});

test('parseDuration: undefined -> null', () => {
  assert.equal(parseDuration(undefined), null);
});

test('parseDuration: whitespace/newline padded -> trims and parses', () => {
  assert.equal(parseDuration(' 12:05\n'), 725);
});

test('parseDuration: extra label token before the time, takes last token', () => {
  assert.equal(parseDuration('Shorts\n0:45'), 45);
});

test('parseDuration: garbage text -> null', () => {
  assert.equal(parseDuration('not a duration'), null);
});

test('parseDuration: whitespace-only -> null', () => {
  assert.equal(parseDuration('   '), null);
});

test('parseDuration: too many colon groups -> null', () => {
  assert.equal(parseDuration('1:02:33:44'), null);
});

test('parseDuration: non-numeric colon token -> null', () => {
  assert.equal(parseDuration('ab:cd'), null);
});

test('parseDuration: numeric but not a string (number input) is stringified', () => {
  // Not a documented case, but should not throw and should fail closed.
  assert.equal(parseDuration(725), null);
});

// ---------------------------------------------------------------------------
// remainingSec
// ---------------------------------------------------------------------------

test('remainingSec: normal budget minus watched', () => {
  assert.equal(remainingSec({ budgetSec: 1200, watchedSec: 300 }), 900);
});

test('remainingSec: floors at 0 when watched exceeds budget', () => {
  assert.equal(remainingSec({ budgetSec: 600, watchedSec: 900 }), 0);
});

test('remainingSec: exact zero remaining', () => {
  assert.equal(remainingSec({ budgetSec: 600, watchedSec: 600 }), 0);
});

test('remainingSec: missing fields default to 0', () => {
  assert.equal(remainingSec({}), 0);
});

test('remainingSec: null/undefined session -> 0', () => {
  assert.equal(remainingSec(null), 0);
  assert.equal(remainingSec(undefined), 0);
});

// ---------------------------------------------------------------------------
// fits
// ---------------------------------------------------------------------------

test('fits: under remaining is true', () => {
  assert.equal(fits(300, 400, 120), true);
});

test('fits: exactly at remaining + tolerance boundary is true', () => {
  assert.equal(fits(520, 400, 120), true); // 400 + 120 = 520
});

test('fits: one second past remaining + tolerance is false', () => {
  assert.equal(fits(521, 400, 120), false);
});

test('fits: exactly at remaining (tolerance 0) is true', () => {
  assert.equal(fits(400, 400, 0), true);
});

test('fits: non-number durationSec is false', () => {
  assert.equal(fits(null, 400, 120), false);
  assert.equal(fits(undefined, 400, 120), false);
  assert.equal(fits(NaN, 400, 120), false);
});

// ---------------------------------------------------------------------------
// scoreCandidate
// ---------------------------------------------------------------------------

test('scoreCandidate: excludes Shorts', () => {
  assert.equal(scoreCandidate({ durationSec: 100, isShort: true }, 400, 120), null);
});

test('scoreCandidate: excludes live', () => {
  assert.equal(scoreCandidate({ durationSec: 100, isLive: true }, 400, 120), null);
});

test('scoreCandidate: excludes playlists/mixes', () => {
  assert.equal(scoreCandidate({ durationSec: 100, isPlaylist: true }, 400, 120), null);
});

test('scoreCandidate: excludes missing duration', () => {
  assert.equal(scoreCandidate({ durationSec: null }, 400, 120), null);
});

test('scoreCandidate: excludes durations over remaining + tolerance', () => {
  assert.equal(scoreCandidate({ durationSec: 521 }, 400, 120), null);
});

test('scoreCandidate: exact fit scores 0', () => {
  assert.equal(scoreCandidate({ durationSec: 400 }, 400, 120), 0);
});

test('scoreCandidate: excludes durations under 60s (too short for a real top-up)', () => {
  assert.equal(scoreCandidate({ durationSec: 59 }, 400, 120), null);
});

test('scoreCandidate: 60s duration is scored, not excluded', () => {
  assert.equal(scoreCandidate({ durationSec: 60 }, 400, 120), 340); // diffUnder = 400 - 60
});

test('scoreCandidate: ordering — closest-under-remaining first, then over-by-less-than-tolerance', () => {
  const remaining = 400;
  const tol = 120;
  const candidates = [
    { name: 'far-under', durationSec: 100 }, // diff 300
    { name: 'close-under', durationSec: 380 }, // diff 20
    { name: 'slightly-over', durationSec: 410 }, // over 10, within tol
    { name: 'more-over', durationSec: 450 }, // over 50, within tol
    { name: 'too-over', durationSec: 700 }, // over 300, excluded
    { name: 'short', durationSec: 100, isShort: true },
    { name: 'live', durationSec: 100, isLive: true },
  ];
  const scored = candidates
    .map((c) => ({ name: c.name, score: scoreCandidate(c, remaining, tol) }))
    .filter((s) => s.score !== null)
    .sort((a, b) => a.score - b.score);

  assert.deepEqual(
    scored.map((s) => s.name),
    ['close-under', 'far-under', 'slightly-over', 'more-over']
  );
});

test('scoreCandidate: boundary over-by-exactly-tolerance is included', () => {
  assert.equal(scoreCandidate({ durationSec: 520 }, 400, 120), 520); // remaining(400) + over(120)
});

test('scoreCandidate: boundary over-by-tolerance-plus-one is excluded', () => {
  assert.equal(scoreCandidate({ durationSec: 521 }, 400, 120), null);
});

// ---------------------------------------------------------------------------
// pickTopUps
// ---------------------------------------------------------------------------

test('pickTopUps: returns at most 3, best first', () => {
  const remaining = 400;
  const tol = 120;
  const cards = [
    { videoId: 'a', durationSec: 100 }, // diff 300
    { videoId: 'b', durationSec: 380 }, // diff 20 (best)
    { videoId: 'c', durationSec: 350 }, // diff 50
    { videoId: 'd', durationSec: 300 }, // diff 100
    { videoId: 'e', durationSec: 410 }, // over 10
  ];
  const top = pickTopUps(cards, remaining, tol, null);
  assert.equal(top.length, 3);
  assert.deepEqual(
    top.map((c) => c.videoId),
    ['b', 'c', 'd']
  );
});

test('pickTopUps: excludes the given videoId', () => {
  const remaining = 400;
  const tol = 120;
  const cards = [
    { videoId: 'a', durationSec: 380 }, // would be best
    { videoId: 'b', durationSec: 350 },
    { videoId: 'c', durationSec: 300 },
  ];
  const top = pickTopUps(cards, remaining, tol, 'a');
  assert.deepEqual(
    top.map((c) => c.videoId),
    ['b', 'c']
  );
});

test('pickTopUps: excludes Shorts, live and playlists from results', () => {
  const remaining = 400;
  const tol = 120;
  const cards = [
    { videoId: 'a', durationSec: 380, isShort: true },
    { videoId: 'b', durationSec: 380, isLive: true },
    { videoId: 'c', durationSec: 380, isPlaylist: true },
    { videoId: 'd', durationSec: 380 },
  ];
  const top = pickTopUps(cards, remaining, tol, null);
  assert.deepEqual(
    top.map((c) => c.videoId),
    ['d']
  );
});

test('pickTopUps: empty/invalid inputs return []', () => {
  assert.deepEqual(pickTopUps([], 400, 120, null), []);
  assert.deepEqual(pickTopUps(null, 400, 120, null), []);
  assert.deepEqual(pickTopUps(undefined, 400, 120, null), []);
});

// ---------------------------------------------------------------------------
// extractCards
// ---------------------------------------------------------------------------

test('extractCards: non-element root returns []', () => {
  assert.deepEqual(extractCards(null), []);
  assert.deepEqual(extractCards(undefined), []);
  assert.deepEqual(extractCards({}), []);
});

test('extractCards: root with no matching cards returns []', () => {
  const root = E('div', {}, '', [E('span', {}, 'nothing here', [])]);
  assert.deepEqual(extractCards(root), []);
});

test('extractCards: classic ytd-video-renderer with normal duration', () => {
  const root = E('div', {}, '', [
    E('ytd-video-renderer', {}, '', [
      E('a', { href: '/watch?v=abc123' }, '', []),
      E('span', { id: 'video-title' }, 'Cooking Pasta in 10 Minutes', []),
      E('span', { id: 'channel-name' }, 'Chef Channel', []),
      E('ytd-thumbnail-overlay-time-status-renderer', {}, '12:05', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].videoId, 'abc123');
  assert.equal(cards[0].title, 'Cooking Pasta in 10 Minutes');
  assert.equal(cards[0].channel, 'Chef Channel');
  assert.equal(cards[0].durationSec, 725);
  assert.equal(cards[0].isShort, false);
  assert.equal(cards[0].isLive, false);
  assert.equal(cards[0].isPlaylist, false);
});

test('extractCards: ytd-rich-item-renderer and ytd-compact-video-renderer also work', () => {
  const root = E('div', {}, '', [
    E('ytd-rich-item-renderer', {}, '', [
      E('a', { href: '/watch?v=rich1' }, '', []),
      E('span', { id: 'video-title' }, 'Rich Item Video', []),
      E('ytd-thumbnail-overlay-time-status-renderer', {}, '3:20', []),
    ]),
    E('ytd-compact-video-renderer', {}, '', [
      E('a', { href: '/watch?v=compact1' }, '', []),
      E('span', { id: 'video-title' }, 'Compact Video', []),
      E('span', { id: 'time-status' }, '1:00:00', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 2);
  const byId = Object.fromEntries(cards.map((c) => [c.videoId, c]));
  assert.equal(byId.rich1.durationSec, 200);
  assert.equal(byId.compact1.durationSec, 3600);
});

test('extractCards: new lockup layout with badge-shape duration and lockup title class', () => {
  const root = E('div', {}, '', [
    E('yt-lockup-view-model', {}, '', [
      E('a', { href: '/watch?v=lockup1' }, '', []),
      E('span', { class: 'yt-lockup-metadata-view-model-wiz__title' }, 'New Layout Video', []),
      E('span', { class: 'badge-shape-wiz__text' }, '8:15', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].videoId, 'lockup1');
  assert.equal(cards[0].title, 'New Layout Video');
  assert.equal(cards[0].durationSec, 495);
});

test('extractCards: [class*="badge-shape"] fallback selector matches duration', () => {
  const root = E('div', {}, '', [
    E('yt-lockup-view-model', {}, '', [
      E('a', { href: '/watch?v=lockup2' }, '', []),
      E('h3', {}, 'Fallback Badge Video', []),
      E('span', { class: 'badge-shape-wiz__thing-else' }, '2:30', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].durationSec, 150);
  assert.equal(cards[0].title, 'Fallback Badge Video');
});

test('extractCards: dedupes wrapper containing a nested card (lockup wrapped in rich-item)', () => {
  const root = E('div', {}, '', [
    E('ytd-rich-item-renderer', {}, '', [
      E('yt-lockup-view-model', {}, '', [
        E('a', { href: '/watch?v=wrapped1' }, '', []),
        E('span', { class: 'yt-lockup-metadata-view-model-wiz__title' }, 'Wrapped Video', []),
        E('span', { class: 'badge-shape-wiz__text' }, '4:44', []),
      ]),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].videoId, 'wrapped1');
  assert.equal(cards[0].durationSec, 284);
});

test('extractCards: Shorts card detected via /shorts/ link', () => {
  const root = E('div', {}, '', [
    E('ytd-rich-item-renderer', {}, '', [
      E('a', { href: '/shorts/short1' }, '', []),
      E('span', { id: 'video-title' }, 'A Short', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isShort, true);
  assert.equal(cards[0].videoId, null); // no /watch?v= link present
});

test('extractCards: live video with explicit LIVE duration text', () => {
  const root = E('div', {}, '', [
    E('ytd-video-renderer', {}, '', [
      E('a', { href: '/watch?v=live1' }, '', []),
      E('span', { id: 'video-title' }, 'Live Stream Now', []),
      E('ytd-thumbnail-overlay-time-status-renderer', { 'overlay-style': 'LIVE' }, 'LIVE', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isLive, true);
  assert.equal(cards[0].durationSec, null);
});

test('extractCards: live video with missing duration text but a live badge present', () => {
  const root = E('div', {}, '', [
    E('ytd-video-renderer', {}, '', [
      E('a', { href: '/watch?v=live2' }, '', []),
      E('span', { id: 'video-title' }, 'Live Stream No Duration', []),
      E('ytd-badge-supported-renderer', {}, 'LIVE', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isLive, true);
  assert.equal(cards[0].durationSec, null);
});

test('extractCards: missing duration text with no live badge is not live, duration null', () => {
  const root = E('div', {}, '', [
    E('ytd-video-renderer', {}, '', [
      E('a', { href: '/watch?v=noduration' }, '', []),
      E('span', { id: 'video-title' }, 'No Duration Shown', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isLive, false);
  assert.equal(cards[0].durationSec, null);
});

test('extractCards: PREMIERE duration text marks live/premiere with null duration', () => {
  const root = E('div', {}, '', [
    E('ytd-video-renderer', {}, '', [
      E('a', { href: '/watch?v=premiere1' }, '', []),
      E('span', { id: 'video-title' }, 'Upcoming Premiere', []),
      E('ytd-thumbnail-overlay-time-status-renderer', {}, 'PREMIERE', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isLive, true);
  assert.equal(cards[0].durationSec, null);
});

test('extractCards: playlist/mix detected via list= param on link', () => {
  const root = E('div', {}, '', [
    E('ytd-video-renderer', {}, '', [
      E('a', { href: '/watch?v=mix1&list=RDmix1' }, '', []),
      E('span', { id: 'video-title' }, 'Mix Video', []),
      E('ytd-thumbnail-overlay-time-status-renderer', {}, '5:00', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isPlaylist, true);
});

test('extractCards: title falls back to aria-label when text is empty', () => {
  const root = E('div', {}, '', [
    E('ytd-video-renderer', {}, '', [
      E('a', { href: '/watch?v=aria1' }, '', []),
      E('span', { id: 'video-title', 'aria-label': 'Aria Label Title' }, '', []),
      E('ytd-thumbnail-overlay-time-status-renderer', {}, '2:00', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Aria Label Title');
});

test('extractCards: duration text with surrounding whitespace/newlines and extra label token', () => {
  const root = E('div', {}, '', [
    E('ytd-video-renderer', {}, '', [
      E('a', { href: '/watch?v=whitespace1' }, '', []),
      E('span', { id: 'video-title' }, 'Whitespace Duration', []),
      E(
        'ytd-thumbnail-overlay-time-status-renderer',
        {},
        '',
        [E('span', {}, '\n  1:02:33  \n', [])]
      ),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].durationSec, 3753);
});

test('extractCards: unrelated nested watch link belonging to a different card is not stolen', () => {
  // Regression guard for the ownedBy/closest filtering: a card containing a
  // sub-element that itself is a full matching card (already covered by the
  // wrapper-dedup test) — here instead we check that el reference identity
  // is preserved and distinct across sibling cards.
  const root = E('div', {}, '', [
    E('ytd-video-renderer', {}, '', [
      E('a', { href: '/watch?v=first' }, '', []),
      E('span', { id: 'video-title' }, 'First', []),
      E('ytd-thumbnail-overlay-time-status-renderer', {}, '1:00', []),
    ]),
    E('ytd-video-renderer', {}, '', [
      E('a', { href: '/watch?v=second' }, '', []),
      E('span', { id: 'video-title' }, 'Second', []),
      E('ytd-thumbnail-overlay-time-status-renderer', {}, '2:00', []),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].el, root.children[0]);
  assert.equal(cards[1].el, root.children[1]);
});

test('extractCards: card with neither watch link nor shorts link is skipped', () => {
  const root = E('div', {}, '', [
    E('ytd-video-renderer', {}, '', [E('span', { id: 'video-title' }, 'Ad or empty slot', [])]),
  ]);
  assert.deepEqual(extractCards(root), []);
});

// ---------------------------------------------------------------------------
// extractCards — 2026 camelCase lockup markup (yt-thumbnail-badge-view-model /
// badge-shape / .ytBadgeShapeText, .ytLockupMetadataViewModelTitle, etc).
// Fixtures mirror the exact real-world structure: a ytd-rich-item-renderer
// wrapping a yt-lockup-view-model.
// ---------------------------------------------------------------------------

function camelDurationBadge(text, attrs) {
  return E('yt-thumbnail-badge-view-model', { class: 'ytThumbnailBadgeViewModelHost ytThumbnailBottomOverlayViewModelBadge' }, '', [
    E(
      'badge-shape',
      Object.assign(
        { class: 'ytBadgeShapeHost ytBadgeShapeThumbnailDefault ytBadgeShapeThumbnailBadge ytBadgeShapeTypography', role: 'img' },
        attrs || {}
      ),
      '',
      [E('div', { class: 'ytBadgeShapeText' }, text, [])]
    ),
  ]);
}

test('extractCards: 2026 lockup markup with "4:40" badge parses to 280s and is not a playlist', () => {
  const root = E('div', {}, '', [
    E('ytd-rich-item-renderer', {}, '', [
      E('yt-lockup-view-model', {}, '', [
        E('a', { href: '/watch?v=four40' }, '', []),
        E('h3', { class: 'ytLockupMetadataViewModelHeadingReset' }, '', [
          E('a', { class: 'ytLockupMetadataViewModelTitle', href: '/watch?v=four40' }, 'Weeknight Stir Fry', []),
        ]),
        camelDurationBadge('4:40', { 'aria-label': '4 minutes, 40 seconds' }),
      ]),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].videoId, 'four40');
  assert.equal(cards[0].title, 'Weeknight Stir Fry');
  assert.equal(cards[0].durationSec, 280);
  assert.equal(cards[0].isLive, false);
  assert.equal(cards[0].isPlaylist, false);
});

test('extractCards: 2026 lockup Mix card is detected as a playlist', () => {
  const root = E('div', {}, '', [
    E('ytd-rich-item-renderer', {}, '', [
      E('yt-lockup-view-model', {}, '', [
        E('a', { href: '/watch?v=mixstart&list=RDmixstart' }, '', []),
        E('h3', { class: 'ytLockupMetadataViewModelHeadingReset' }, '', [
          E('a', { class: 'ytLockupMetadataViewModelTitle', href: '/watch?v=mixstart&list=RDmixstart' }, 'Comfort Food Mix', []),
        ]),
        E('yt-collection-thumbnail-view-model', {}, '', []),
        camelDurationBadge('Mix'),
      ]),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isPlaylist, true);
});

test('extractCards: Mix badge text alone (no list param, no collection thumbnail) marks isPlaylist', () => {
  const root = E('div', {}, '', [
    E('yt-lockup-view-model', {}, '', [
      E('a', { href: '/watch?v=mixtextonly' }, '', []),
      E('h3', { class: 'ytLockupMetadataViewModelHeadingReset' }, '', [
        E('a', { class: 'ytLockupMetadataViewModelTitle', href: '/watch?v=mixtextonly' }, 'Just a Mix Label', []),
      ]),
      camelDurationBadge('Mix'),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isPlaylist, true);
});

test('extractCards: yt-collection-thumbnail-view-model alone marks isPlaylist', () => {
  const root = E('div', {}, '', [
    E('yt-lockup-view-model', {}, '', [
      E('a', { href: '/watch?v=collectiononly' }, '', []),
      E('h3', { class: 'ytLockupMetadataViewModelHeadingReset' }, '', [
        E('a', { class: 'ytLockupMetadataViewModelTitle', href: '/watch?v=collectiononly' }, 'Collection Only', []),
      ]),
      E('yt-collection-thumbnail-view-model', {}, '', []),
      camelDurationBadge('3:00'),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isPlaylist, true);
});

test('extractCards: a "New" badge does not shadow a later real duration badge ("12:05" -> 725)', () => {
  const root = E('div', {}, '', [
    E('ytd-rich-item-renderer', {}, '', [
      E('yt-lockup-view-model', {}, '', [
        E('a', { href: '/watch?v=newtest' }, '', []),
        E('h3', { class: 'ytLockupMetadataViewModelHeadingReset' }, '', [
          E('a', { class: 'ytLockupMetadataViewModelTitle', href: '/watch?v=newtest' }, 'Fresh Upload', []),
        ]),
        E('yt-thumbnail-badge-view-model', { class: 'ytThumbnailBadgeViewModelHost ytThumbnailTopBadge' }, '', [
          E('badge-shape', { class: 'ytBadgeShapeHost ytBadgeShapeThumbnailDefault' }, '', [
            E('div', { class: 'ytBadgeShapeText' }, 'New', []),
          ]),
        ]),
        camelDurationBadge('12:05', { 'aria-label': '12 minutes, 5 seconds' }),
      ]),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].durationSec, 725);
  assert.equal(cards[0].isPlaylist, false);
  assert.equal(cards[0].isLive, false);
});

test('extractCards: camelCase "Live" class on a badge-shape marks the card live', () => {
  const root = E('div', {}, '', [
    E('yt-lockup-view-model', {}, '', [
      E('a', { href: '/watch?v=camellive' }, '', []),
      E('h3', { class: 'ytLockupMetadataViewModelHeadingReset' }, '', [
        E('a', { class: 'ytLockupMetadataViewModelTitle', href: '/watch?v=camellive' }, 'Streaming Now', []),
      ]),
      E('yt-thumbnail-badge-view-model', {}, '', [
        E('badge-shape', { class: 'ytBadgeShapeHost ytBadgeShapeThumbnailLive' }, 'LIVE', []),
      ]),
    ]),
  ]);
  const cards = extractCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isLive, true);
  assert.equal(cards[0].durationSec, null);
});
