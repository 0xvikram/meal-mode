# Meal Mode

A Chrome extension for eating in front of YouTube without doom-scrolling past
your meal. Set a budget in minutes, and Meal Mode:

- **Filters your feeds** (home, subscriptions, search results) down to videos
  that fit in the time you have left.
- **Tracks actually-watched time** on the video page (only counts time the
  video is really playing, not tab-open time).
- **Offers a "top-up"** of 2-3 same-length videos near the end of what you're
  watching, sized to whatever budget remains, with a short countdown to
  auto-pick one.
- **Stops offering and tells you "meal over"** once the budget hits zero.

It's local-only: plain JS, no build step, no npm dependencies, no backend, no
API keys, no network requests. Session state lives in
`chrome.storage.local` and survives the background service worker being
killed and restarted.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (`meal-mode/`).
4. Pin the extension so the popup is one click away.

There's nothing to build — Chrome loads the files directly.

## Usage

1. Click the Meal Mode icon.
2. Drag the slider to your meal length (5-90 min, 5 min steps) and hit
   **Start**.
3. Browse YouTube as usual. While a session is active:
   - Feed cards for videos that won't fit in your remaining time are
     hidden/dimmed automatically, on the home page, subscriptions, and
     search results.
   - A small pill in the bottom-left of the watch page shows time left,
     e.g. `🍽 12:30 left`.
   - Near the end of a video (or when it ends), a small overlay in the
     bottom-right of the player suggests 2-3 videos that fit your
     remaining time. Pick one, hit **Skip**, add **+1 min**, or tap
     **Done eating** to stop the session early. Left alone, it
     auto-advances to the top pick after a short countdown.
   - When your budget reaches zero, a banner appears: "Meal over. Enjoy
     your day." with **Dismiss** and **+5 min**.
4. From the popup at any time: **+1 min**, **+5 min**, or **Done** to end
   the session. Settings (tolerance seconds, when the picker appears) are in
   the collapsed settings section.

Meal Mode never touches YouTube ads and does no ad-related DOM handling.

## How it decides what "fits"

- `remaining = budget - watched` (in seconds), floored at 0.
- A video "fits" if `duration <= remaining + tolerance` (tolerance defaults
  to 120s, adjustable in settings) — so a video a couple of minutes over is
  still allowed, since abruptly cutting off a video you're mid-way through
  isn't the point.
- Shorts, live streams/premieres, and playlists/mixes are never offered as
  top-ups and are excluded from "fits" filtering logic used for scoring.
- Top-up candidates are ranked closest-to-remaining-without-going-over
  first, then by how little they go over (within tolerance).

All of this logic is pure and framework-free in `content/lib.js`.

## When YouTube changes its markup

YouTube regularly reshuffles class names and occasionally swaps renderer
layouts entirely (the 2025+ "lockup" `yt-lockup-view-model` cards vs. the
older `ytd-*` renderers). Two places hold selectors, kept deliberately
separate so a breakage is a one-line patch:

- **`content/youtube.js`** — a single `SELECTORS` object at the top of the
  file. This covers page-level DOM integration: feed containers to observe,
  the shorts/card selectors used to find cards to hide, title/channel
  selectors, the player video element, the related-videos sidebar, and the
  autonav toggle button. If feed filtering or the top-up sidebar stops
  finding cards, start here — open the file, find the relevant key in
  `SELECTORS`, and add/replace the CSS selector for the new markup. Where
  a key holds an array, `youtube.js` tries each selector in order and takes
  the first that matches, so you can usually just *add* a new selector
  rather than replacing the old one (keeps both old and new YouTube layouts
  working at once).
- **`content/lib.js`** — internal selector lists inside `extractCards()`
  (`CARD_SELECTORS`, `DURATION_SELECTORS`, `TITLE_SELECTORS`,
  `CHANNEL_SELECTORS`, `LIVE_BADGE_SELECTORS`, near the top of the file).
  These are used when *parsing* a card element that's already been found
  (title text, duration text, channel name, live-badge detection). If cards
  are found but fields come back empty/wrong (e.g. duration not parsing),
  patch here the same way — add a new selector to the relevant list.

After patching either file, re-run the tests (`node --test`) — the fake-DOM
fixtures in `test/lib.test.js` double as a quick sanity check that
`extractCards`/`parseDuration` still behave the way the rest of the
extension expects, and it's a good place to add a fixture for whatever new
markup you just saw.

## Running tests

`content/lib.js` is a plain UMD-ish module: it attaches `window.MealLib` in
the browser and also does `module.exports = ...` when `require`d from
Node, so the exact same code is exercised by the extension and by tests
(no mocks of the logic itself).

```sh
node --test
```

(Node's test runner auto-discovers files under `test/`; there are no
dependencies to install.) `test/lib.test.js` covers every exported
function — `parseDuration`, `remainingSec`, `fits`, `scoreCandidate`,
`pickTopUps`, `extractCards` — including duration edge cases (`h:mm:ss`,
`m:ss`, `0:45`, `LIVE`, `""`, `null`, padded whitespace), tolerance
boundaries, top-up ranking order, and DOM extraction against a tiny
hand-written fake DOM (no jsdom, no dependencies) covering classic
renderers, the new lockup layout, Shorts, live/premiere, playlists/mixes,
and nested-card de-duplication.

To see a coverage report (built into Node, no extra tooling):

```sh
node --test --experimental-test-coverage
```

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: session state in `chrome.storage.local`, message handling, broadcasts `SESSION_CHANGED` |
| `content/lib.js` | Pure logic: duration parsing, fit/scoring, card extraction (tested) |
| `content/youtube.js` | DOM integration: feed filtering, player watcher, top-up picker, banners, pill |
| `content/styles.css` | Styles for the injected overlay/banner/pill |
| `popup/` | Extension popup UI (start/stop, budget slider, live remaining time, settings) |
| `icons/16.png`, `48.png`, `128.png` | Extension icons |
| `test/lib.test.js` | `node --test` suite for `content/lib.js` |
