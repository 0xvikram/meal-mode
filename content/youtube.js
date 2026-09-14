'use strict';

/**
 * Meal Mode - YouTube DOM integration.
 *
 * Every YouTube selector lives in SELECTORS below so a layout change only ever
 * needs one patch. Both the classic `ytd-*` renderers and the 2025+ lockup
 * view-model layout are covered.
 */
(() => {
  const SELECTORS = {
    /* ---- feeds (home / subscriptions / results) ---- */
    feedRoots: [
      'ytd-rich-grid-renderer #contents',
      'ytd-two-column-search-results-renderer #contents',
      'ytd-section-list-renderer #contents',
      'ytd-browse:not([hidden]) #contents',
      'ytd-search #contents',
      '#contents'
    ],
    /* ---- one feed/sidebar card, classic + lockup ---- */
    card: [
      'ytd-rich-item-renderer',
      'ytd-video-renderer',
      'ytd-compact-video-renderer',
      'yt-lockup-view-model'
    ].join(','),
    cardShorts: [
      'ytd-reel-item-renderer',
      'ytm-shorts-lockup-view-model',
      'ytd-rich-shelf-renderer[is-shorts]',
      'a[href^="/shorts/"]'
    ].join(','),
    /* ---- duration badges ---- */
    durationClassic: 'ytd-thumbnail-overlay-time-status-renderer',
    durationLockup: '.yt-badge-shape, .badge-shape-wiz__text, badge-shape-wiz__text',
    /* ---- links / metadata inside a card ---- */
    watchLink: 'a[href*="/watch?v="]',
    cardTitle: [
      '#video-title',
      'a#video-title-link',
      '.yt-lockup-metadata-view-model__title',
      'h3 a',
      'span[role="text"]'
    ],
    cardChannel: [
      'ytd-channel-name #text',
      '#channel-name #text',
      '.yt-content-metadata-view-model__metadata-row a',
      '.yt-content-metadata-view-model__metadata-row span'
    ],
    cardThumb: 'img',
    /* ---- whole shelves to hide during a session (no per-video duration) ---- */
    feedShelves: 'ytd-rich-section-renderer, ytd-rich-shelf-renderer, ytd-ad-slot-renderer',
    /* ---- watch page ---- */
    player: '#movie_player',
    video: 'video.html5-main-video',
    videoFallback: '#movie_player video, video',
    watchTitle: [
      'h1.ytd-watch-metadata yt-formatted-string',
      'h1.style-scope.ytd-watch-metadata',
      'h1.title yt-formatted-string',
      'h1'
    ],
    relatedRoots: [
      '#secondary',
      '#related',
      'ytd-watch-next-secondary-results-renderer',
      '#below ytd-item-section-renderer',
      '#items.ytd-watch-next-secondary-results-renderer'
    ],
    autonavToggle: '.ytp-autonav-toggle-button',
    playerControls: '.ytp-chrome-bottom'
  };

  const DEFAULT_SETTINGS = {
    defaultBudgetMin: 20,
    toleranceSec: 120,
    pickerAtPct: 0.9,
    autoPickSec: 8
  };

  const EMPTY_SESSION = {
    active: false,
    budgetSec: 0,
    watchedSec: 0,
    startedAt: null,
    lastVideoId: null,
    lastTitle: null
  };

  const TICK_BATCH_SEC = 5;
  const HIDDEN_ATTR = 'data-mealmode-hidden';

  const Lib = window.MealLib;

  const state = {
    booted: false,
    pageType: null,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    session: Object.assign({}, EMPTY_SESSION),
    tickTimer: null,
    filterTimer: null,
    observer: null,
    pendingSec: 0,
    inFlightSec: 0,
    videoId: null,
    pickerShownFor: null,
    pickerEl: null,
    pickerTimer: null,
    queuedVideoId: null,
    queuedCard: null,
    queueEl: null,
    bannerEl: null,
    bannerDismissedFor: null,
    pausedForBudget: false,
    autonavTries: 0,
    autonavRestoreDone: false,
    pillEl: null,
    generation: 0
  };

  /* ------------------------------------------------------------------ utils */

  function q(root, sel) {
    if (!root || !sel || typeof root.querySelector !== 'function') return null;
    try { return root.querySelector(sel); } catch (_) { return null; }
  }

  function qa(root, sel) {
    if (!root || !sel || typeof root.querySelectorAll !== 'function') return [];
    try { return Array.from(root.querySelectorAll(sel)); } catch (_) { return []; }
  }

  function firstOf(root, list) {
    if (!Array.isArray(list)) return null;
    for (const sel of list) {
      const el = q(root, sel);
      if (el) return el;
    }
    return null;
  }

  function allOf(root, list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const sel of list) {
      for (const el of qa(root, sel)) {
        if (!out.includes(el)) out.push(el);
      }
    }
    return out;
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError; // reading it suppresses the console error
          resolve(res || null);
        });
      } catch (_) {
        resolve(null); // extension context invalidated (reload/update)
      }
    });
  }

  function applyReply(reply) {
    if (!reply) return;
    if (reply.session) state.session = Object.assign({}, EMPTY_SESSION, reply.session);
    if (reply.settings) state.settings = Object.assign({}, DEFAULT_SETTINGS, reply.settings);
  }

  function mmss(totalSec) {
    const s = Math.max(0, Math.round(Number(totalSec) || 0));
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return String(m) + ':' + String(rest).padStart(2, '0');
  }

  /**
   * Remaining budget minus seconds watched locally but not yet reflected in
   * the session: pendingSec (not sent yet) plus inFlightSec (sent, reply not
   * back yet). Without the latter the pill would jump up by up to 5s on every
   * flush and fall back again when the reply lands.
   */
  function remaining() {
    let base = 0;
    try {
      base = Lib && typeof Lib.remainingSec === 'function'
        ? Lib.remainingSec(state.session)
        : Math.max(0, (state.session.budgetSec || 0) - (state.session.watchedSec || 0));
    } catch (_) {
      base = 0;
    }
    return Math.max(0, (Number(base) || 0) - state.pendingSec - state.inFlightSec);
  }

  function isActive() {
    return Boolean(state.session && state.session.active);
  }

  function fitsDuration(durationSec) {
    if (!Lib || typeof Lib.fits !== 'function') return true;
    try {
      return Boolean(Lib.fits(durationSec, remaining(), state.settings.toleranceSec));
    } catch (_) {
      return true;
    }
  }

  function currentVideoId() {
    try {
      const params = new URLSearchParams(location.search);
      const id = params.get('v');
      return id || null;
    } catch (_) {
      return null;
    }
  }

  function pageType() {
    const path = location.pathname || '/';
    if (path === '/watch') return 'watch';
    if (path === '/results') return 'results';
    if (path === '/' || path === '') return 'home';
    if (path.indexOf('/feed/') === 0) return 'feed';
    return 'other';
  }

  function isFeedPage(type) {
    return type === 'home' || type === 'results' || type === 'feed';
  }

  /* ------------------------------------------------------------- feed filter */

  function feedRoot() {
    return firstOf(document, SELECTORS.feedRoots);
  }

  /**
   * MealLib.extractCards() returns the innermost card element, which on the
   * 2025 layout is a yt-lockup-view-model nested inside a grid slot. Hiding
   * that leaf would leave an empty slot, so walk up to the outermost card.
   */
  function outerCardEl(el) {
    let node = el;
    for (let i = 0; i < 4 && node && node.parentElement; i += 1) {
      const up = typeof node.parentElement.closest === 'function'
        ? node.parentElement.closest(SELECTORS.card)
        : null;
      if (!up || up === node) break;
      node = up;
    }
    return node || el;
  }

  function hideCard(el) {
    if (!el || el.getAttribute(HIDDEN_ATTR) === '1') return;
    el.setAttribute(HIDDEN_ATTR, '1');
    el.classList.add('mm-filtered');
    el.hidden = true;
  }

  function unhideCard(el) {
    if (!el || el.getAttribute(HIDDEN_ATTR) !== '1') return;
    el.removeAttribute(HIDDEN_ATTR);
    el.classList.remove('mm-filtered');
    el.hidden = false;
  }

  function clearFeedFilter(scope) {
    const root = scope || document;
    for (const el of qa(root, '[' + HIDDEN_ATTR + '="1"]')) unhideCard(el);
  }

  function applyFeedFilter() {
    if (!isFeedPage(state.pageType)) return;
    const root = feedRoot();
    if (!root) return;
    if (!isActive()) {
      clearFeedFilter(document);
      return;
    }
    if (!Lib || typeof Lib.extractCards !== 'function') return;

    let cards = [];
    try {
      cards = Lib.extractCards(root) || [];
    } catch (_) {
      cards = [];
    }

    // Shelves without plain videos (Playables, Shorts rows, News) have no
    // duration to judge, so hide the whole shelf during a session.
    for (const shelf of qa(root, SELECTORS.feedShelves)) hideCard(shelf);

    for (const card of cards) {
      if (!card || !card.el || !card.el.isConnected) continue;
      const el = outerCardEl(card.el);
      const bad = card.isShort || card.isLive || card.isPlaylist ||
        card.durationSec == null || !fitsDuration(card.durationSec);
      if (bad) hideCard(el); else unhideCard(el);
    }
  }

  function scheduleFeedFilter() {
    if (state.filterTimer) return;
    state.filterTimer = setTimeout(() => {
      state.filterTimer = null;
      try { applyFeedFilter(); } catch (_) { /* never break the page */ }
    }, 200);
  }

  function startFeedObserver() {
    const root = feedRoot();
    if (!root || typeof MutationObserver !== 'function') return;
    try {
      state.observer = new MutationObserver(() => scheduleFeedFilter());
      state.observer.observe(root, { childList: true, subtree: true });
    } catch (_) {
      state.observer = null;
    }
  }

  /* ------------------------------------------------------------- status pill */

  function ensurePill() {
    if (!isActive()) { removePill(); return; }
    if (state.pillEl && state.pillEl.isConnected) return;
    if (!document.body) return;
    const pill = document.createElement('div');
    pill.className = 'mm-pill';
    pill.setAttribute('role', 'status');
    const icon = document.createElement('span');
    icon.className = 'mm-pill-icon';
    icon.textContent = '🍽';
    const text = document.createElement('span');
    text.className = 'mm-pill-text';
    pill.appendChild(icon);
    pill.appendChild(text);
    document.body.appendChild(pill);
    state.pillEl = pill;
  }

  function updatePill() {
    if (!isActive()) { removePill(); return; }
    ensurePill();
    const pill = state.pillEl;
    if (!pill) return;
    const text = q(pill, '.mm-pill-text');
    if (text) text.textContent = mmss(remaining()) + ' left';
    pill.classList.toggle('mm-pill-over', remaining() <= 0);
  }

  function removePill() {
    if (state.pillEl && state.pillEl.parentNode) {
      state.pillEl.parentNode.removeChild(state.pillEl);
    }
    state.pillEl = null;
  }

  /* ---------------------------------------------------------------- banner */

  function showBanner() {
    if (state.bannerEl && state.bannerEl.isConnected) return;
    if (!document.body) return;
    const banner = document.createElement('div');
    banner.className = 'mm-banner';
    banner.setAttribute('role', 'alert');

    const msg = document.createElement('span');
    msg.className = 'mm-banner-text';
    msg.textContent = 'Meal over. Enjoy your day.';

    const actions = document.createElement('span');
    actions.className = 'mm-banner-actions';

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'mm-btn mm-btn-primary';
    plus.textContent = '+5 min';
    plus.addEventListener('click', () => {
      send({ type: 'SESSION_EXTEND', sec: 300 }).then((reply) => {
        applyReply(reply);
        hideBanner();
        state.pausedForBudget = false;
        state.bannerDismissedFor = null;
        onSessionUpdate();
      });
    });

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'mm-btn';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      state.bannerDismissedFor = state.session.budgetSec;
      hideBanner();
    });

    actions.appendChild(plus);
    actions.appendChild(dismiss);
    banner.appendChild(msg);
    banner.appendChild(actions);
    document.body.appendChild(banner);
    state.bannerEl = banner;
  }

  function hideBanner() {
    if (state.bannerEl && state.bannerEl.parentNode) {
      state.bannerEl.parentNode.removeChild(state.bannerEl);
    }
    state.bannerEl = null;
  }

  function checkBudgetOver() {
    if (!isActive() || remaining() > 0) {
      hideBanner();
      return;
    }
    if (state.bannerDismissedFor !== state.session.budgetSec) showBanner();
    if (!state.pausedForBudget) {
      state.pausedForBudget = true;
      const video = findVideo();
      if (video && typeof video.pause === 'function' && !video.paused) {
        try { video.pause(); } catch (_) { /* ignore */ }
      }
    }
    closePicker();
    clearQueue(); // budget is gone: stop offering, queued pick included
  }

  /* ----------------------------------------------------------- watch player */

  function findVideo() {
    return q(document, SELECTORS.video) || q(document, SELECTORS.videoFallback);
  }

  function watchTitle() {
    const el = firstOf(document, SELECTORS.watchTitle);
    const text = el && (el.textContent || '').trim();
    if (text) return text;
    return (document.title || '').replace(/ - YouTube$/, '').trim() || null;
  }

  function flushTicks(force) {
    if (state.pendingSec <= 0) return;
    if (!force && state.pendingSec < TICK_BATCH_SEC) return;
    const sec = state.pendingSec;
    state.pendingSec = 0;
    state.inFlightSec += sec;
    send({
      type: 'SESSION_TICK',
      sec,
      videoId: state.videoId,
      title: watchTitle()
    }).then((reply) => {
      state.inFlightSec = Math.max(0, state.inFlightSec - sec);
      applyReply(reply);
    });
  }

  function disableAutonav() {
    if (!isActive() || state.autonavTries > 20) return;
    const toggle = q(document, SELECTORS.autonavToggle);
    if (!toggle) { state.autonavTries += 1; return; }
    const checked = toggle.getAttribute('aria-checked');
    if (checked === 'true') {
      try { toggle.click(); } catch (_) { /* ignore */ }
      // Remember that WE turned it off, so we can put it back on afterwards.
      state.autonavRestoreDone = false;
      try { chrome.storage.local.set({ autonavWasOn: true }); } catch (_) { /* ignore */ }
    }
    state.autonavTries = 99; // found it; stop looking
  }

  /**
   * Put YouTube's autoplay toggle back the way we found it, once, when the
   * session ends. Best effort only: watch page, one attempt, no retry loop.
   */
  function restoreAutonav() {
    if (state.pageType !== 'watch' || state.autonavRestoreDone) return;
    state.autonavRestoreDone = true;
    let pending = null;
    try { pending = chrome.storage.local.get('autonavWasOn'); } catch (_) { return; }
    if (!pending || typeof pending.then !== 'function') return;
    pending.then((got) => {
      if (!got || !got.autonavWasOn) return;
      const toggle = q(document, SELECTORS.autonavToggle);
      if (toggle && toggle.getAttribute('aria-checked') === 'false') {
        try { toggle.click(); } catch (_) { /* ignore */ }
      }
      try { chrome.storage.local.set({ autonavWasOn: false }); } catch (_) { /* ignore */ }
    }).catch(() => { /* ignore */ });
  }

  /* ----------------------------------------------------------- top-up picker */

  function collectCandidates() {
    if (!Lib || typeof Lib.extractCards !== 'function') return [];
    const roots = allOf(document, SELECTORS.relatedRoots);
    const seen = new Set();
    const out = [];
    for (const root of roots) {
      let cards = [];
      try { cards = Lib.extractCards(root) || []; } catch (_) { cards = []; }
      for (const card of cards) {
        if (!card || !card.videoId || seen.has(card.videoId)) continue;
        if (card.videoId === state.videoId) continue; // never top up with itself
        seen.add(card.videoId);
        out.push(card);
      }
    }
    return out;
  }

  function closePicker() {
    if (state.pickerTimer) {
      clearInterval(state.pickerTimer);
      state.pickerTimer = null;
    }
    if (state.pickerEl && state.pickerEl.parentNode) {
      state.pickerEl.parentNode.removeChild(state.pickerEl);
    }
    state.pickerEl = null;
  }

  /** True once the current video has run out (ended, or within 0.5s of it). */
  function videoFinished(video) {
    if (!video) return false;
    if (video.ended) return true;
    const duration = Number(video.duration);
    const current = Number(video.currentTime);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(current)) return false;
    return current >= duration - 0.5;
  }

  function clearQueue() {
    state.queuedVideoId = null;
    state.queuedCard = null;
    if (state.queueEl && state.queueEl.parentNode) {
      state.queueEl.parentNode.removeChild(state.queueEl);
    }
    state.queueEl = null;
  }

  /**
   * Prefer an SPA navigation: clicking YouTube's own anchor keeps the app
   * shell alive. location.assign() is a full reload and is the fallback only.
   */
  function goTo(videoId, card) {
    if (!videoId) return;
    clearQueue();
    closePicker();
    state.pickerShownFor = null; // let the picker fire again on the next video
    const anchor = card && card.el && typeof card.el.querySelector === 'function'
      ? q(card.el, SELECTORS.watchLink)
      : null;
    if (anchor && anchor.isConnected) {
      try { anchor.click(); return; } catch (_) { /* fall through */ }
    }
    try {
      location.assign('/watch?v=' + encodeURIComponent(videoId));
    } catch (_) { /* ignore */ }
  }

  function pickerHost() {
    const player = q(document, SELECTORS.player);
    return { player, host: player || document.body };
  }

  /** Compact "Up next" strip shown in place of the picker once a pick queues. */
  function renderQueueStrip(card) {
    const { player, host } = pickerHost();
    if (!host) return;

    const wrap = document.createElement('div');
    wrap.className = player ? 'mm-picker' : 'mm-picker mm-picker-fixed';

    const head = document.createElement('div');
    head.className = 'mm-picker-head';
    const text = document.createElement('span');
    text.className = 'mm-row-title';
    const parts = [card.title || 'Untitled'];
    if (card.durationSec != null) parts.push(mmss(card.durationSec));
    text.textContent = 'Up next: ' + parts.join(' \u00B7 ');
    head.appendChild(text);

    const foot = document.createElement('div');
    foot.className = 'mm-picker-foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mm-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => clearQueue());
    foot.appendChild(cancel);

    wrap.appendChild(head);
    wrap.appendChild(foot);
    wrap.addEventListener('click', (ev) => ev.stopPropagation());

    host.appendChild(wrap);
    state.queueEl = wrap;
  }

  /**
   * A pick QUEUES the next video instead of navigating, so the last stretch of
   * the current video is never cut off. If it has already finished, go now.
   */
  function queuePick(card) {
    if (!card || !card.videoId) return;
    const video = findVideo();
    if (videoFinished(video)) { goTo(card.videoId, card); return; }
    closePicker();
    clearQueue();
    state.queuedVideoId = card.videoId;
    state.queuedCard = card;
    renderQueueStrip(card);
  }

  function buildRow(card, index, onPick) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mm-row';
    row.addEventListener('click', () => onPick(card));

    const thumbWrap = document.createElement('span');
    thumbWrap.className = 'mm-row-thumb';
    const img = document.createElement('img');
    const srcEl = card.el ? q(card.el, SELECTORS.cardThumb) : null;
    const src = srcEl && (srcEl.currentSrc || srcEl.src);
    img.src = src || ('https://i.ytimg.com/vi/' + encodeURIComponent(card.videoId) + '/mqdefault.jpg');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    thumbWrap.appendChild(img);

    const meta = document.createElement('span');
    meta.className = 'mm-row-meta';

    const title = document.createElement('span');
    title.className = 'mm-row-title';
    title.textContent = card.title || 'Untitled';

    const sub = document.createElement('span');
    sub.className = 'mm-row-sub';
    sub.textContent = [card.channel, mmss(card.durationSec)].filter(Boolean).join(' · ');

    meta.appendChild(title);
    meta.appendChild(sub);

    const chip = document.createElement('span');
    chip.className = 'mm-chip';
    const over = Number(card.durationSec) > remaining();
    chip.classList.toggle('mm-chip-tight', over);
    chip.textContent = over ? 'just over' : 'fits';

    row.appendChild(thumbWrap);
    row.appendChild(meta);
    row.appendChild(chip);
    if (index === 0) row.classList.add('mm-row-first');
    return row;
  }

  function renderPicker(cards) {
    closePicker();
    const player = q(document, SELECTORS.player);
    const host = player || document.body;
    if (!host) return;

    const wrap = document.createElement('div');
    wrap.className = player ? 'mm-picker' : 'mm-picker mm-picker-fixed';

    const head = document.createElement('div');
    head.className = 'mm-picker-head';
    const headText = document.createElement('span');
    headText.textContent = mmss(remaining()) + ' of your meal left';
    const count = document.createElement('span');
    count.className = 'mm-count';
    head.appendChild(headText);
    head.appendChild(count);

    const list = document.createElement('div');
    list.className = 'mm-list';
    cards.forEach((card, i) => list.appendChild(buildRow(card, i, (picked) => queuePick(picked))));

    const foot = document.createElement('div');
    foot.className = 'mm-picker-foot';

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'mm-btn';
    skip.textContent = 'Skip';
    skip.addEventListener('click', () => closePicker());

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'mm-btn';
    plus.textContent = '+1 min';
    plus.addEventListener('click', () => {
      send({ type: 'SESSION_EXTEND', sec: 60 }).then((reply) => {
        applyReply(reply);
        if (headText) headText.textContent = mmss(remaining()) + ' of your meal left';
        updatePill();
      });
    });

    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'mm-btn mm-btn-primary';
    done.textContent = 'Done eating';
    done.addEventListener('click', () => {
      send({ type: 'SESSION_STOP' }).then((reply) => {
        applyReply(reply);
        closePicker();
        onSessionUpdate();
      });
    });

    foot.appendChild(skip);
    foot.appendChild(plus);
    foot.appendChild(done);

    wrap.appendChild(head);
    wrap.appendChild(list);
    wrap.appendChild(foot);

    // Stop clicks bubbling into the player (which would toggle play/pause).
    wrap.addEventListener('click', (ev) => ev.stopPropagation());

    host.appendChild(wrap);
    state.pickerEl = wrap;

    let left = Math.round(Number(state.settings.autoPickSec) || 0);
    const first = cards[0];
    if (left > 0 && first) {
      count.textContent = 'auto in ' + left + 's';
      state.pickerTimer = setInterval(() => {
        left -= 1;
        if (!state.pickerEl || !state.pickerEl.isConnected) { closePicker(); return; }
        if (left <= 0) { queuePick(first); return; }
        count.textContent = 'auto in ' + left + 's';
      }, 1000);
    } else {
      count.textContent = '';
    }
  }

  function maybeShowPicker(video) {
    if (!isActive() || !video) return;
    if (state.pickerEl) return;
    const id = state.videoId;
    if (!id || state.pickerShownFor === id) return;
    if (remaining() <= 60) return;

    const duration = Number(video.duration);
    const current = Number(video.currentTime);
    const pct = Number.isFinite(duration) && duration > 0 && Number.isFinite(current)
      ? current / duration
      : 0;
    const threshold = Number(state.settings.pickerAtPct) || DEFAULT_SETTINGS.pickerAtPct;
    if (!video.ended && pct < threshold) return;

    if (!Lib || typeof Lib.pickTopUps !== 'function') return;
    let picks = [];
    try {
      // MealLib.pickTopUps takes `exclude` as a single videoId.
      picks = Lib.pickTopUps(collectCandidates(), remaining(), state.settings.toleranceSec, id) || [];
    } catch (_) {
      picks = [];
    }
    if (!picks.length) return;

    state.pickerShownFor = id;
    renderPicker(picks.slice(0, 3));
  }

  /* ------------------------------------------------------------- master tick */

  function tick() {
    if (!isActive()) {
      updatePill();
      hideBanner();
      closePicker();
      clearQueue();
      return;
    }

    if (state.pageType === 'watch') {
      disableAutonav();
      const video = findVideo();
      if (video) {
        if (state.queuedVideoId && videoFinished(video)) {
          goTo(state.queuedVideoId, state.queuedCard);
          return;
        }
        if (!video.paused && !video.ended && remaining() > 0) {
          state.pendingSec += 1;
          flushTicks(false);
        }
        maybeShowPicker(video);
      }
    }

    updatePill();
    checkBudgetOver();

    // Cheap safety net: the observer covers most feed churn, this covers the rest.
    if (isFeedPage(state.pageType)) scheduleFeedFilter();
  }

  /* ------------------------------------------------------------------ boot */

  function onSessionUpdate() {
    if (!isActive()) {
      state.pendingSec = 0;
      state.inFlightSec = 0;
      state.pausedForBudget = false;
      state.bannerDismissedFor = null;
      clearFeedFilter(document);
      hideBanner();
      closePicker();
      clearQueue();
      removePill();
      restoreAutonav();
      return;
    }
    if (remaining() > 0) state.pausedForBudget = false;
    updatePill();
    if (isFeedPage(state.pageType)) scheduleFeedFilter();
    checkBudgetOver();
  }

  function cleanup() {
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    if (state.filterTimer) { clearTimeout(state.filterTimer); state.filterTimer = null; }
    if (state.observer) {
      try { state.observer.disconnect(); } catch (_) { /* ignore */ }
      state.observer = null;
    }
    flushTicks(true);
    closePicker();
    clearQueue(); // a manual navigation cancels any queued top-up
    hideBanner();
    removePill();
    clearFeedFilter(document);
    state.pendingSec = 0;
    state.pausedForBudget = false;
    state.autonavTries = 0;
  }

  async function init() {
    const generation = ++state.generation;
    cleanup(); // idempotent: safe to call init() any number of times

    state.pageType = pageType();
    state.videoId = state.pageType === 'watch' ? currentVideoId() : null;
    state.pickerShownFor = null;
    state.bannerDismissedFor = null;

    applyReply(await send({ type: 'SESSION_GET' }));
    if (generation !== state.generation) return; // a newer navigation won

    if (isFeedPage(state.pageType)) {
      applyFeedFilter();
      startFeedObserver();
    }

    updatePill();
    checkBudgetOver();

    state.tickTimer = setInterval(() => {
      try { tick(); } catch (_) { /* never break the page */ }
    }, 1000);
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;

    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.type !== 'SESSION_CHANGED') return;
        if (msg.session) state.session = Object.assign({}, EMPTY_SESSION, msg.session);
        try { onSessionUpdate(); } catch (_) { /* ignore */ }
      });
    } catch (_) { /* extension context gone */ }

    // YouTube dispatches yt-navigate-finish on the document; it bubbles to
    // window on some builds. Listen on both and coalesce so init runs once.
    let initTimer = null;
    const scheduleInit = () => {
      if (initTimer) clearTimeout(initTimer);
      initTimer = setTimeout(() => {
        initTimer = null;
        init().catch(() => {});
      }, 50);
    };
    document.addEventListener('yt-navigate-finish', scheduleInit, true);
    window.addEventListener('yt-navigate-finish', scheduleInit, true);
    window.addEventListener('popstate', scheduleInit);

    window.addEventListener('pagehide', () => {
      try { flushTicks(true); } catch (_) { /* ignore */ }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        try { flushTicks(true); } catch (_) { /* ignore */ }
      }
    });

    init().catch(() => {});
  }

  if (!Lib) {
    // lib.js failed to load - stay completely inert rather than throwing.
    return;
  }
  boot();
})();
