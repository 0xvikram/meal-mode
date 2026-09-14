'use strict';

/**
 * Meal Mode - service worker.
 *
 * Rule: chrome.storage.local is the single source of truth. Every message
 * handler reads the session back out of storage before acting and writes it
 * again afterwards, so a service-worker restart can never lose or stale a
 * session. Nothing is cached in module scope on purpose.
 */

const DEFAULT_SETTINGS = Object.freeze({
  defaultBudgetMin: 20,
  toleranceSec: 120,
  pickerAtPct: 0.9,
  autoPickSec: 8,
  recentGenres: []
});

/** Tokens that carry no topic signal and only dilute a search query. */
const TITLE_NOISE = new Set([
  'official', 'video', 'hd', '4k', 'full', 'episode', 'ep', 'part', 'ft',
  'feat', 'lyrics', 'audio', 'trailer', 'new', 'latest', '2024', '2025', '2026'
]);

/** Best-effort emoji/symbol strip; unicode property escapes may be missing. */
function stripSymbols(text) {
  try {
    return text.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ');
  } catch (_) {
    return text;
  }
}

function stripPunctuation(text) {
  try {
    return text.replace(/[^\p{L}\p{N}\s']/gu, ' ');
  } catch (_) {
    return text.replace(/[^A-Za-z0-9\s']/g, ' ');
  }
}

/**
 * Turn a video title into a search query for "more like this".
 * Pure: no DOM, no storage, no network.
 */
function queryFromTitle(title, author) {
  const rawTitle = typeof title === 'string' ? title : '';
  const rawAuthor = typeof author === 'string' ? author : '';

  let text = rawTitle.toLowerCase();
  text = text.replace(/\([^)]*\)/g, ' ')   // (...)
    .replace(/\[[^\]]*\]/g, ' ')          // [...]
    .replace(/\{[^}]*\}/g, ' ');           // {...}
  text = text.replace(/#[^\s#]+/g, ' ');   // hashtags
  text = stripSymbols(text);
  text = text.replace(/[|\-:]+/g, ' ');
  text = stripPunctuation(text);

  const words = text.split(/\s+/).filter((w) => w && !TITLE_NOISE.has(w));
  let picked = words.slice(0, 6);

  if (picked.length < 2) {
    // Too little left: lean on the channel plus the untouched title.
    const original = rawTitle.split(/\s+/).filter(Boolean).slice(0, 3);
    picked = (rawAuthor ? [rawAuthor] : []).concat(original);
  }

  const out = picked.join(' ').replace(/\s+/g, ' ').trim();
  return out || rawAuthor.trim() || rawTitle.trim();
}

/** Short, human label for the pill: first 4 cleaned words, Title Case. */
function labelFromTitle(title, author) {
  const words = queryFromTitle(title, author).split(/\s+/).filter(Boolean).slice(0, 4);
  const label = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 48);
  return label || (typeof title === 'string' ? title.trim().slice(0, 48) : '');
}

/** videoId from watch?v=, youtu.be/ and /shorts/ URL forms. */
function videoIdFromUrl(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return null;
  let m = raw.match(/youtu\.be\/([A-Za-z0-9_-]{6,20})/);
  if (m) return m[1];
  m = raw.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,20})/);
  if (m) return m[1];
  if (/youtube\.com\//.test(raw)) {
    m = raw.match(/[?&]v=([A-Za-z0-9_-]{6,20})/);
    if (m) return m[1];
  }
  return null;
}

/** Chip label -> a search query that actually returns watchable meal videos. */
const GENRE_QUERIES = Object.freeze({
  'comedy': 'stand up comedy full set',
  'podcast': 'podcast clip',
  'tech': 'tech explained',
  'documentary': 'mini documentary',
  'food': 'street food',
  'gaming': 'gaming highlights',
  'music': 'music video',
  'sports': 'sports highlights',
  'news': 'news explained',
  'motivation': 'motivational speech',
  'learn something': 'explained in minutes'
});

/**
 * YouTube's search "Duration" filter, as the `sp` query param.
 * These are the double-encoded forms YouTube itself puts in the address bar.
 * If a build ever rejects them, the single-encoded equivalents are
 * 'EgIYAQ%3D%3D' (under 4 min) and 'EgIYAw%3D%3D' (4-20 min).
 * Over 20 minutes gets no filter at all - our own feed filter handles it.
 */
const SP_UNDER_4_MIN = 'EgIYAQ%253D%253D';
const SP_4_TO_20_MIN = 'EgIYAw%253D%253D';
const MAX_RECENT_GENRES = 8;

const EMPTY_SESSION = Object.freeze({
  active: false,
  budgetSec: 0,
  watchedSec: 0,
  startedAt: null,
  lastVideoId: null,
  lastTitle: null,
  genre: null,
  query: null,
  fromLink: false,
  excludeVideoId: null
});

const YT_TAB_PATTERNS = ['*://www.youtube.com/*'];

/** Clamp helper that tolerates junk input from any caller. */
function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (typeof min === 'number' && n < min) return min;
  if (typeof max === 'number' && n > max) return max;
  return n;
}

async function readSettings() {
  let stored = null;
  try {
    const got = await chrome.storage.local.get('settings');
    stored = got && got.settings;
  } catch (_) {
    stored = null;
  }
  const merged = Object.assign({}, DEFAULT_SETTINGS, stored || {});
  return {
    defaultBudgetMin: num(merged.defaultBudgetMin, DEFAULT_SETTINGS.defaultBudgetMin, 5, 90),
    toleranceSec: num(merged.toleranceSec, DEFAULT_SETTINGS.toleranceSec, 0, 900),
    pickerAtPct: num(merged.pickerAtPct, DEFAULT_SETTINGS.pickerAtPct, 0.5, 1),
    autoPickSec: num(merged.autoPickSec, DEFAULT_SETTINGS.autoPickSec, 0, 60),
    recentGenres: cleanGenres(merged.recentGenres)
  };
}

/** Most-recent-first, de-duplicated, trimmed, capped. */
function cleanGenres(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().slice(0, 48);
    if (!value) continue;
    if (out.some((g) => g.toLowerCase() === value.toLowerCase())) continue;
    out.push(value);
    if (out.length >= MAX_RECENT_GENRES) break;
  }
  return out;
}

async function writeSettings(patch) {
  const current = await readSettings();
  const next = Object.assign({}, current, patch || {});
  const clean = {
    defaultBudgetMin: num(next.defaultBudgetMin, current.defaultBudgetMin, 5, 90),
    toleranceSec: num(next.toleranceSec, current.toleranceSec, 0, 900),
    pickerAtPct: num(next.pickerAtPct, current.pickerAtPct, 0.5, 1),
    autoPickSec: num(next.autoPickSec, current.autoPickSec, 0, 60),
    recentGenres: cleanGenres(next.recentGenres)
  };
  try {
    await chrome.storage.local.set({ settings: clean });
  } catch (_) {
    /* storage unavailable; return the computed value anyway */
  }
  return clean;
}

/** Always read the session from storage - never from memory. */
async function readSession() {
  let stored = null;
  try {
    const got = await chrome.storage.local.get('session');
    stored = got && got.session;
  } catch (_) {
    stored = null;
  }
  const merged = Object.assign({}, EMPTY_SESSION, stored || {});
  return {
    active: Boolean(merged.active),
    budgetSec: num(merged.budgetSec, 0, 0),
    watchedSec: num(merged.watchedSec, 0, 0),
    startedAt: merged.startedAt == null ? null : num(merged.startedAt, null, 0),
    lastVideoId: typeof merged.lastVideoId === 'string' ? merged.lastVideoId : null,
    lastTitle: typeof merged.lastTitle === 'string' ? merged.lastTitle : null,
    genre: typeof merged.genre === 'string' && merged.genre ? merged.genre : null,
    query: typeof merged.query === 'string' && merged.query ? merged.query : null,
    fromLink: Boolean(merged.fromLink),
    excludeVideoId: typeof merged.excludeVideoId === 'string' && merged.excludeVideoId
      ? merged.excludeVideoId
      : null
  };
}

async function writeSession(session) {
  try {
    await chrome.storage.local.set({ session });
  } catch (_) {
    /* ignore: the broadcast below still keeps open tabs in sync */
  }
  await broadcast(session);
  return session;
}

/** Tell every YouTube tab. Tabs without our content script simply throw; swallow. */
async function broadcast(session) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: YT_TAB_PATTERNS });
  } catch (_) {
    return;
  }
  if (!Array.isArray(tabs)) return;
  await Promise.all(tabs.map(async (tab) => {
    if (!tab || typeof tab.id !== 'number') return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SESSION_CHANGED', session });
    } catch (_) {
      /* no receiver in that tab - expected, ignore */
    }
  }));
}

async function startSession(msg) {
  const settings = await readSettings();
  const minutes = num(msg && msg.budgetMin, settings.defaultBudgetMin, 1, 600);
  // `label` is what the pill shows; it is deliberately distinct from the
  // search query, which may be a longer phrase derived from a video title.
  const raw = typeof (msg && msg.label) === 'string' && msg.label
    ? msg.label
    : (msg && msg.genre);
  const label = typeof raw === 'string' ? raw.trim().slice(0, 48) : '';
  const session = {
    active: true,
    budgetSec: Math.round(minutes * 60),
    watchedSec: 0,
    startedAt: Date.now(),
    lastVideoId: null,
    lastTitle: null,
    genre: label || null,
    query: typeof (msg && msg.query) === 'string' && msg.query
      ? msg.query.trim().slice(0, 120)
      : (label || null),
    fromLink: Boolean(msg && msg.fromLink),
    excludeVideoId: typeof (msg && msg.excludeVideoId) === 'string' && msg.excludeVideoId
      ? msg.excludeVideoId
      : null
  };
  return writeSession(session);
}

async function stopSession() {
  const current = await readSession();
  const session = Object.assign({}, current, { active: false });
  return writeSession(session);
}

async function extendSession(sec) {
  const current = await readSession();
  if (!current.active) return current;
  const add = num(sec, 0, 0, 3600);
  const session = Object.assign({}, current, {
    budgetSec: current.budgetSec + Math.round(add)
  });
  return writeSession(session);
}

async function tickSession(msg) {
  const current = await readSession();
  if (!current.active) return current;
  const add = num(msg && msg.sec, 0, 0, 120);
  const watchedSec = Math.min(current.budgetSec, current.watchedSec + Math.round(add));
  const session = Object.assign({}, current, {
    watchedSec,
    lastVideoId: typeof (msg && msg.videoId) === 'string' ? msg.videoId : current.lastVideoId,
    lastTitle: typeof (msg && msg.title) === 'string' ? msg.title : current.lastTitle
  });
  const changed = session.watchedSec !== current.watchedSec ||
    session.lastVideoId !== current.lastVideoId ||
    session.lastTitle !== current.lastTitle;
  if (!changed) return current;
  return writeSession(session);
}

/** Pick YouTube's duration filter from the budget (tolerance included). */
function durationParam(effectiveMin) {
  if (!Number.isFinite(effectiveMin)) return '';
  if (effectiveMin < 4) return SP_UNDER_4_MIN;
  // Up to 30 min: YouTube's 4-20 bucket is the best pool (everything fits).
  // Beyond that no bucket helps, so let our own feed filter do the work.
  if (effectiveMin <= 30) return SP_4_TO_20_MIN;
  return '';
}

function buildSearchUrl(query, effectiveMin) {
  // sp is already percent-encoded; only search_query gets encoded here.
  const sp = durationParam(effectiveMin);
  return 'https://www.youtube.com/results?search_query=' +
    encodeURIComponent(query) + (sp ? '&sp=' + sp : '');
}

function queryForGenre(genre) {
  const raw = typeof genre === 'string' ? genre.trim() : '';
  if (!raw) return '';
  const mapped = GENRE_QUERIES[raw.toLowerCase()];
  return mapped || raw;
}

/** Reuse the active tab when it is already on YouTube; otherwise open one. */
async function openSearch(url) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {
    tabs = [];
  }
  const tab = Array.isArray(tabs) ? tabs[0] : null;
  const onYouTube = tab && typeof tab.url === 'string' &&
    /^https?:\/\/(www\.)?youtube\.com\//.test(tab.url);
  if (tab && typeof tab.id === 'number' && onYouTube) {
    try {
      await chrome.tabs.update(tab.id, { url });
      return tab.id;
    } catch (_) { /* fall through to opening a new tab */ }
  }
  try {
    const created = await chrome.tabs.create({ url });
    return created && typeof created.id === 'number' ? created.id : null;
  } catch (_) {
    return null;
  }
}

/**
 * Look a pasted link up through YouTube's public oembed endpoint. No API key,
 * no third party - youtube.com only, which manifest host_permissions covers.
 */
async function resolveLink(msg) {
  const videoId = videoIdFromUrl(msg && msg.url);
  if (!videoId) return { ok: false, reason: 'not-a-youtube-link' };

  const target = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
  const endpoint = 'https://www.youtube.com/oembed?url=' +
    encodeURIComponent(target) + '&format=json';

  let data = null;
  try {
    const res = await fetch(endpoint, { credentials: 'omit' });
    if (!res || !res.ok) {
      return { ok: false, videoId, reason: res ? 'http-' + res.status : 'no-response' };
    }
    data = await res.json();
  } catch (_) {
    return { ok: false, videoId, reason: 'fetch-failed' };
  }

  const title = data && typeof data.title === 'string' ? data.title : '';
  const author = data && typeof data.author_name === 'string' ? data.author_name : '';
  if (!title && !author) return { ok: false, videoId, reason: 'no-metadata' };

  return {
    ok: true,
    videoId,
    title,
    author,
    query: queryFromTitle(title, author),
    label: labelFromTitle(title, author)
  };
}

async function findVideos(msg) {
  const settings = await readSettings();
  const query = queryForGenre(msg && msg.genre);
  if (!query) return { ok: false, url: null };
  const minutes = num(msg && msg.minutes, settings.defaultBudgetMin, 1, 600);
  const url = buildSearchUrl(query, minutes); // bucket from the budget itself; the <=30 rule already absorbs tolerance

  // Remember the source video so the feed filter can hide it from the results.
  const exclude = typeof (msg && msg.excludeVideoId) === 'string' && msg.excludeVideoId
    ? msg.excludeVideoId
    : null;
  if (exclude) {
    const current = await readSession();
    if (current.active && current.excludeVideoId !== exclude) {
      await writeSession(Object.assign({}, current, { excludeVideoId: exclude }));
    }
  }

  const tabId = await openSearch(url);
  return { ok: tabId != null, url, tabId };
}

async function handle(msg) {
  const type = msg && msg.type;
  switch (type) {
    case 'SESSION_START':
      return { session: await startSession(msg), settings: await readSettings() };
    case 'SESSION_STOP':
      return { session: await stopSession(), settings: await readSettings() };
    case 'SESSION_EXTEND':
      return { session: await extendSession(msg.sec), settings: await readSettings() };
    case 'SESSION_TICK':
      return { session: await tickSession(msg), settings: await readSettings() };
    case 'SESSION_GET':
      return { session: await readSession(), settings: await readSettings() };
    case 'SETTINGS_GET':
      return { session: await readSession(), settings: await readSettings() };
    case 'SETTINGS_SET':
      return { session: await readSession(), settings: await writeSettings(msg.settings) };
    case 'RESOLVE_LINK':
      return await resolveLink(msg);
    case 'FIND_VIDEOS': {
      const found = await findVideos(msg);
      return Object.assign({ session: await readSession(), settings: await readSettings() }, found);
    }
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg && msg.type;
  if (typeof type !== 'string') return false;
  handle(msg).then(
    (result) => {
      try { sendResponse(result); } catch (_) { /* port closed */ }
    },
    () => {
      try { sendResponse(null); } catch (_) { /* port closed */ }
    }
  );
  return true; // async response
});

chrome.runtime.onInstalled.addListener(() => {
  // Materialise defaults so the popup has something to read on first open.
  readSettings().then((settings) => writeSettings(settings)).catch(() => {});
  readSession().then((session) => {
    if (!session.active) return;
    return writeSession(session); // re-broadcast a session that survived an update
  }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  readSession().then((session) => broadcast(session)).catch(() => {});
});
