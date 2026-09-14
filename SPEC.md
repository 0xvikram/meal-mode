# Meal Mode — Chrome extension spec (v1)

Purpose: while eating, watch YouTube for exactly the meal's length. User sets a
budget (minutes). Extension filters feeds to videos that fit, tracks watched time,
and when a video is ending with budget left, offers 2–3 same-topic "top-up" videos
that fit the remaining minutes. When budget hits zero it stops offering and shows
a "meal over" banner.

Constraints: Manifest V3. Plain JS (ES2022), no bundler, no npm deps, no backend,
no API keys. Must work on youtube.com desktop only. 8GB laptop — keep it light.

## Files
- manifest.json
- background.js            service worker: session state
- content/lib.js           pure functions, exported for tests via a UMD-ish shim
- content/youtube.js       DOM integration
- content/styles.css
- popup/popup.html, popup.js, popup.css
- icons/16.png 48.png 128.png (simple plate/clock glyph)
- test/lib.test.js         node --test
- README.md                install (load unpacked) + usage

## Storage (chrome.storage.local)
settings: { defaultBudgetMin: 20, toleranceSec: 120, pickerAtPct: 0.9, autoPickSec: 8 }
session:  { active: bool, budgetSec, watchedSec, startedAt, lastVideoId, lastTitle }

## background.js messages (chrome.runtime.sendMessage, {type, ...})
- SESSION_START {budgetMin}      -> session
- SESSION_STOP                    -> session
- SESSION_EXTEND {sec}            -> session
- SESSION_TICK {sec, videoId, title}  content reports actually-played seconds
- SESSION_GET                     -> session
Broadcast SESSION_CHANGED to all youtube tabs on any change (tabs.sendMessage).
Session must survive service-worker restarts: always read/write storage, never
rely on in-memory state alone.

## content/lib.js (pure)
- parseDuration("1:02:33") -> 3753; "12:05" -> 725; "0:45" -> 45; invalid/LIVE/
  PREMIERE -> null
- remainingSec(session) = budgetSec - watchedSec (min 0)
- fits(durationSec, remainingSec, toleranceSec) -> durationSec <= remaining + tol
- scoreCandidate(c, remaining) -> prefer durations close to but <= remaining;
  slight penalty for > remaining up to tol; exclude Shorts, live, playlists/mixes
- extractCards(root) -> [{el, videoId, title, channel, durationSec, isShort,
  isLive}] from ytd-rich-item-renderer, ytd-video-renderer,
  ytd-compact-video-renderer, yt-lockup-view-model (new layout). Use
  data-attributes/hrefs, not class names, wherever possible.
- pickTopUps(cards, remaining, tol, exclude) -> top 3 by score

## content/youtube.js
1. On load and on `yt-navigate-finish`, re-init for the page type (home/results/
   subscriptions/watch).
2. Feed filter (home, subscriptions, results): if session active, for each card
   set el.hidden = !fits(...). Watch new cards with a MutationObserver on the
   feed container. When session inactive, unhide everything. Dim, don't remove,
   if that proves more stable.
3. Player watcher (watch page): find `video.html5-main-video`. Every 1s while
   !paused && !ended, send SESSION_TICK with sec=1 (accumulate and send in 5s
   batches to reduce messages). On navigate reset.
4. Top-up picker (watch page): when currentTime/duration >= pickerAtPct OR
   `ended`, and session active and remaining > 60s, and picker not shown for
   this videoId: extract candidates from the watch-page sidebar
   (#secondary, #related) plus below-player suggestions on new layout; call
   pickTopUps; render overlay (bottom-right of player, 3 rows: thumb, title,
   channel, duration, "fits" chip). Countdown autoPickSec, then navigate to
   first. Buttons: pick row, "Skip", "+1 min", "Done eating" (stops session).
   Navigate via location.assign(`/watch?v=ID`) which YouTube handles as SPA.
   Turn YouTube autoplay toggle off (.ytp-autonav-toggle-button aria-checked)
   while session active to avoid a race.
5. Budget-over: when remaining == 0, show a full-width top banner "Meal over.
   Enjoy your day." with Dismiss and "+5 min". Pause the video once.
6. Status pill: small fixed pill bottom-left "🍽 12:30 left" while session active.
7. Never touch YouTube ads. No ad-related DOM handling at all.

## popup
Slider 5–90 min (step 5, default from settings), big Start button; when active:
remaining mm:ss (poll SESSION_GET every 1s), +1 min, +5 min, Done. Settings
section: tolerance sec, picker % (collapsed).

## Quality bar
- No console errors on home, results, watch.
- lib.js 100% covered by node --test.
- No external network requests.
- All selectors in one SELECTORS object at top of youtube.js for easy patching.
