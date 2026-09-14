// content/lib.js — pure functions for Meal Mode.
// Works as a browser content script (attaches window.MealLib) and as a
// CommonJS module for `node --test` (module.exports = same object).
//
// Hard rule: no DOM access anywhere in this file except inside extractCards,
// and there only via querySelectorAll, getAttribute, textContent, closest.

(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // parseDuration
  // ---------------------------------------------------------------------
  // Accepts strings like "1:02:33", "12:05", "0:45", possibly padded with
  // stray whitespace/newlines/labels ("Shorts\n0:45"). Returns whole
  // seconds, or null for anything that isn't a clean h:mm:ss / m:ss token
  // (including "", null/undefined, "LIVE", "PREMIERE", "UPCOMING", etc).
  var TIME_TOKEN_RE = /^\d{1,2}(:\d{2}){1,2}$/;

  function parseDuration(text) {
    if (text === null || text === undefined) return null;
    var trimmed = String(text).trim();
    if (!trimmed) return null;

    var upper = trimmed.toUpperCase();
    if (
      upper.indexOf('LIVE') !== -1 ||
      upper.indexOf('PREMIERE') !== -1 ||
      upper.indexOf('UPCOMING') !== -1 ||
      upper.indexOf('SCHEDULED') !== -1
    ) {
      return null;
    }

    // Duration text may contain whitespace/newlines and other tokens
    // ("Shorts", bullets, etc). Take the last mm:ss-like token.
    var tokens = trimmed.split(/\s+/).filter(Boolean);
    var token = null;
    for (var i = tokens.length - 1; i >= 0; i--) {
      if (TIME_TOKEN_RE.test(tokens[i])) {
        token = tokens[i];
        break;
      }
    }
    if (!token) return null;

    var parts = token.split(':');
    var nums = [];
    for (var j = 0; j < parts.length; j++) {
      var n = parseInt(parts[j], 10);
      if (isNaN(n)) return null;
      nums.push(n);
    }

    // TIME_TOKEN_RE only ever admits 2 or 3 colon-separated groups.
    var seconds;
    if (nums.length === 3) {
      seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];
    } else {
      seconds = nums[0] * 60 + nums[1];
    }
    return seconds;
  }

  // ---------------------------------------------------------------------
  // remainingSec
  // ---------------------------------------------------------------------
  function remainingSec(session) {
    if (!session) return 0;
    var budget = typeof session.budgetSec === 'number' ? session.budgetSec : 0;
    var watched = typeof session.watchedSec === 'number' ? session.watchedSec : 0;
    var rem = budget - watched;
    return rem > 0 ? rem : 0;
  }

  // ---------------------------------------------------------------------
  // fits
  // ---------------------------------------------------------------------
  function fits(durationSec, remaining, toleranceSec) {
    if (typeof durationSec !== 'number' || isNaN(durationSec)) return false;
    var remainingNum = typeof remaining === 'number' && !isNaN(remaining) ? remaining : 0;
    var tol = typeof toleranceSec === 'number' && !isNaN(toleranceSec) ? toleranceSec : 0;
    return durationSec <= remainingNum + tol;
  }

  // ---------------------------------------------------------------------
  // scoreCandidate
  // ---------------------------------------------------------------------
  // Lower score = better. Returns null for anything ineligible (Shorts,
  // live, playlists/mixes, missing/invalid duration, or over remaining by
  // more than tolerance).
  //
  // Candidates that fit at or under `remaining` are scored by how close
  // they are to it (0 = exact fit). Candidates that go over `remaining`
  // but stay within tolerance are scored worse than every under-remaining
  // candidate (offset by `remaining` itself, which is always >= the best
  // possible "under" diff), ordered by how little they go over.
  function scoreCandidate(candidate, remaining, toleranceSec) {
    if (!candidate) return null;
    if (candidate.isShort || candidate.isLive || candidate.isPlaylist) return null;

    var durationSec = candidate.durationSec;
    if (typeof durationSec !== 'number' || isNaN(durationSec) || durationSec < 0) return null;
    if (durationSec < 60) return null; // too short to be a real top-up (Shorts are separately excluded)

    var remainingNum = typeof remaining === 'number' && !isNaN(remaining) ? remaining : 0;
    var tol = typeof toleranceSec === 'number' && !isNaN(toleranceSec) ? toleranceSec : 0;

    var diffUnder = remainingNum - durationSec;
    if (diffUnder >= 0) {
      return diffUnder;
    }

    var over = -diffUnder;
    if (over <= tol) {
      return remainingNum + over;
    }

    return null;
  }

  // ---------------------------------------------------------------------
  // pickTopUps
  // ---------------------------------------------------------------------
  function pickTopUps(cards, remaining, toleranceSec, exclude) {
    if (!Array.isArray(cards)) return [];
    var scored = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c) continue;
      if (exclude && c.videoId && c.videoId === exclude) continue;
      var score = scoreCandidate(c, remaining, toleranceSec);
      if (score === null) continue;
      scored.push({ card: c, score: score });
    }
    scored.sort(function (a, b) {
      return a.score - b.score;
    });
    var top = [];
    for (var k = 0; k < scored.length && k < 3; k++) {
      top.push(scored[k].card);
    }
    return top;
  }

  // ---------------------------------------------------------------------
  // extractCards — the only function allowed to touch the DOM, and only
  // via querySelectorAll / getAttribute / textContent / closest.
  // ---------------------------------------------------------------------
  var CARD_SELECTORS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'yt-lockup-view-model'
  ];
  var CARD_SELECTOR_JOINED = CARD_SELECTORS.join(', ');

  var DURATION_SELECTORS = [
    'ytd-thumbnail-overlay-time-status-renderer',
    '#time-status',
    '.badge-shape-wiz__text',
    '[class*="badge-shape"]',
    // 2026 camelCase lockup badges (yt-thumbnail-badge-view-model > badge-shape > div.ytBadgeShapeText)
    '.ytBadgeShapeText',
    'yt-thumbnail-badge-view-model badge-shape',
    '[class*="BadgeShapeText"]'
  ];

  var TITLE_SELECTORS = [
    '#video-title',
    '.ytLockupMetadataViewModelTitle',
    '.yt-lockup-metadata-view-model-wiz__title',
    'h3',
    'a[href*="/watch?v="][title]'
  ];

  var CHANNEL_SELECTORS = [
    '#channel-name',
    'ytd-channel-name',
    '.yt-content-metadata-view-model-wiz__metadata-text',
    '.ytContentMetadataViewModelMetadataText',
    '#text'
  ];

  var LIVE_BADGE_SELECTORS = [
    'ytd-badge-supported-renderer',
    '[class*="badge-shape-wiz--type-live"]',
    '[class*="BadgeShapeLive"]',
    'badge-shape',
    '[aria-label*="LIVE"]'
  ];

  function toArray(nodeList) {
    var out = [];
    if (!nodeList) return out;
    for (var i = 0; i < nodeList.length; i++) out.push(nodeList[i]);
    return out;
  }

  function ownedBy(node, cardEl) {
    // Ensure a descendant node belongs directly to cardEl, not to some
    // other, nested card element (e.g. a mix/shelf item embedded inside).
    if (!node || typeof node.closest !== 'function') return true;
    return node.closest(CARD_SELECTOR_JOINED) === cardEl;
  }

  function firstOwnedMatch(cardEl, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var matches = toArray(cardEl.querySelectorAll(selectors[i]));
      for (var j = 0; j < matches.length; j++) {
        if (ownedBy(matches[j], cardEl)) return matches[j];
      }
    }
    return null;
  }

  function textOf(node) {
    if (!node) return '';
    var t = node.textContent;
    return t == null ? '' : String(t).trim();
  }

  function attrOf(node, name) {
    if (!node || typeof node.getAttribute !== 'function') return null;
    return node.getAttribute(name);
  }

  function getVideoId(cardEl) {
    var a = firstOwnedMatch(cardEl, ['a[href*="/watch?v="]']);
    if (!a) return null;
    var href = attrOf(a, 'href');
    if (!href) return null;
    var qIndex = href.indexOf('?');
    if (qIndex === -1) return null;
    var params = new URLSearchParams(href.slice(qIndex + 1));
    return params.get('v');
  }

  function getIsShort(cardEl) {
    return !!firstOwnedMatch(cardEl, ['a[href*="/shorts/"]']);
  }

  function getIsPlaylist(cardEl) {
    var anchors = toArray(cardEl.querySelectorAll('a[href*="list="]'));
    for (var i = 0; i < anchors.length; i++) {
      if (!ownedBy(anchors[i], cardEl)) continue;
      var href = attrOf(anchors[i], 'href');
      if (!href) continue;
      var qIndex = href.indexOf('?');
      var query = qIndex === -1 ? '' : href.slice(qIndex + 1);
      var params = new URLSearchParams(query);
      if (params.get('list')) return true;
    }

    // Mix/playlist thumbnail stack (2026 lockup layout)
    var collectionThumbs = toArray(cardEl.querySelectorAll('yt-collection-thumbnail-view-model'));
    for (var c = 0; c < collectionThumbs.length; c++) {
      if (ownedBy(collectionThumbs[c], cardEl)) return true;
    }

    // "Mix" badge text (exact, or leading e.g. "Mix - ...")
    var badgeCandidates = findDurationBadgeCandidates(cardEl);
    for (var b = 0; b < badgeCandidates.length; b++) {
      var text = textOf(badgeCandidates[b]);
      if (text === 'Mix' || text.indexOf('Mix') === 0) return true;
    }

    return false;
  }

  function getTitle(cardEl) {
    var node = firstOwnedMatch(cardEl, TITLE_SELECTORS);
    if (!node) return '';
    var text = textOf(node);
    if (text) return text;
    var aria = attrOf(node, 'aria-label') || attrOf(node, 'title');
    return aria ? String(aria).trim() : '';
  }

  function getChannel(cardEl) {
    var node = firstOwnedMatch(cardEl, CHANNEL_SELECTORS);
    return node ? textOf(node) : '';
  }

  // A node "looks live" if its own text is/starts with LIVE, its class list
  // contains the (case-sensitive, camelCase) substring "Live", or its
  // aria-label mentions LIVE. Shared by hasLiveBadge and getDurationInfo.
  function looksLikeLiveNode(node) {
    var text = textOf(node).toUpperCase();
    var cls = attrOf(node, 'class') || '';
    var aria = (attrOf(node, 'aria-label') || '').toUpperCase();
    if (text === 'LIVE' || /^LIVE\b/.test(text)) return true;
    if (cls.indexOf('Live') !== -1) return true;
    if (aria.indexOf('LIVE') !== -1) return true;
    return false;
  }

  function hasLiveBadge(cardEl) {
    for (var i = 0; i < LIVE_BADGE_SELECTORS.length; i++) {
      var matches = toArray(cardEl.querySelectorAll(LIVE_BADGE_SELECTORS[i]));
      for (var j = 0; j < matches.length; j++) {
        var node = matches[j];
        if (!ownedBy(node, cardEl)) continue;
        if (looksLikeLiveNode(node)) return true;
      }
    }
    return false;
  }

  // Collect every node matching any DURATION_SELECTORS entry, owned by
  // cardEl, in selector-then-DOM order. A card can carry more than one
  // badge-shape (e.g. a "New" or "Mix" badge alongside the real duration
  // badge), so callers must scan past non-time badges rather than trusting
  // the first match.
  function findDurationBadgeCandidates(cardEl) {
    var out = [];
    for (var i = 0; i < DURATION_SELECTORS.length; i++) {
      var matches = toArray(cardEl.querySelectorAll(DURATION_SELECTORS[i]));
      for (var j = 0; j < matches.length; j++) {
        if (ownedBy(matches[j], cardEl)) out.push(matches[j]);
      }
    }
    return out;
  }

  function getDurationInfo(cardEl) {
    var candidates = findDurationBadgeCandidates(cardEl);
    var explicitLive = false;
    var explicitPremiere = false;
    var chosenText = '';
    var foundTimeToken = false;

    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i];
      var text = textOf(node);
      var overlayStyle = attrOf(node, 'overlay-style');
      var upper = text.toUpperCase();

      var nodeIsLive = overlayStyle === 'LIVE' || looksLikeLiveNode(node);
      var nodeIsPremiere =
        overlayStyle === 'UPCOMING' || upper.indexOf('PREMIER') !== -1 || upper.indexOf('SCHEDULED') !== -1;

      if (nodeIsLive) {
        explicitLive = true;
        break;
      }
      if (nodeIsPremiere) {
        explicitPremiere = true;
        break;
      }
      if (parseDuration(text) !== null) {
        chosenText = text;
        foundTimeToken = true;
        break;
      }
      // Not a time, not live/premiere (e.g. "New", "Mix") — keep looking.
    }

    var missing = !foundTimeToken && !explicitLive && !explicitPremiere;
    var isLive = explicitLive || explicitPremiere || (missing && hasLiveBadge(cardEl));
    var durationSec = explicitLive || explicitPremiere ? null : foundTimeToken ? parseDuration(chosenText) : null;

    return { durationSec: durationSec, isLive: isLive };
  }

  function extractOneCard(cardEl) {
    var videoId = getVideoId(cardEl);
    var isShort = getIsShort(cardEl);
    var durationInfo = getDurationInfo(cardEl);
    var title = getTitle(cardEl);
    var channel = getChannel(cardEl);
    var isPlaylist = getIsPlaylist(cardEl);

    if (!videoId && !isShort) return null; // not a real, usable video card

    return {
      el: cardEl,
      videoId: videoId,
      title: title,
      channel: channel,
      durationSec: durationInfo.durationSec,
      isShort: isShort,
      isLive: durationInfo.isLive,
      isPlaylist: isPlaylist
    };
  }

  function extractCards(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];

    var candidates = toArray(rootEl.querySelectorAll(CARD_SELECTOR_JOINED));

    // Drop wrapper elements that themselves contain another matched card
    // element (e.g. new-layout yt-lockup-view-model nested inside a
    // ytd-rich-item-renderer) so each video is only counted once.
    var leaves = candidates.filter(function (el) {
      return toArray(el.querySelectorAll(CARD_SELECTOR_JOINED)).length === 0;
    });

    var results = [];
    for (var i = 0; i < leaves.length; i++) {
      var card = extractOneCard(leaves[i]);
      if (card) results.push(card);
    }
    return results;
  }

  // ---------------------------------------------------------------------
  // exports
  // ---------------------------------------------------------------------
  var MealLib = {
    parseDuration: parseDuration,
    remainingSec: remainingSec,
    fits: fits,
    scoreCandidate: scoreCandidate,
    pickTopUps: pickTopUps,
    extractCards: extractCards
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MealLib;
  }
  if (root) {
    root.MealLib = MealLib;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
