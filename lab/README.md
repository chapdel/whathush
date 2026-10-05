# Feasibility Lab

A **throwaway** prototype used to run the feasibility tests below before writing the real application. It has no polished UI: a sidebar, the WhatsApp views, and a log at the bottom.

What the lab already implements:

| Mechanism | Where to look |
|---|---|
| One `persist:wa-<uuid>` partition per account, hardened by a single factory | `sessionFor()` in `src/main.ts` |
| Chrome User-Agent without "Electron" | `page-env` event |
| `window.Notification` interception + click → right account | `src/preload-whatsapp.ts`, `notification` and `notification-click` events |
| Unread counter from the page title | `unread` event |
| Simple Snooze (mute everything) | Snooze button, `notification-dropped-snooze` event |
| Visibility of hidden accounts (read receipts) | `page-visibility` event (⚠ if a hidden page believes it is visible) |
| Sleep / wake, memory per account | buttons, `logs/metrics-*.csv` |
| Crash recovery with backoff | "Simulate crash" button, `render-process-gone` event |
| Permission allowlist, refusals logged | `permission-request` and `permission-check` events |
| Screen sharing through `desktopCapturer` / the portal | `display-media-*` events |
| Filtered external links (http, https, mailto) | `open-external` and `blocked-url` events |
| Microphone / camera / sharing detection (`getUserMedia` wrapper) | `media` event, 🎤 📷 🖥 icons |

## Install

```bash
cd lab
npm install
```

Requires Node 22 or later.

## Commands

| Command | Use |
|---|---|
| `npm start` | real WhatsApp accounts, default platform |
| `npm run start:wayland` | native Wayland + IME (`--enable-wayland-ime`) |
| `npm run start:x11` | X11 / XWayland |
| `npm run start:fake` | local fake WhatsApp page (no real account) |
| `npm run smoke` | automated test against the fake page, headless |
| `npm run smoke:visible` | same, with the window shown (real graphical session) |
| `npm run probe` | loads the real web.whatsapp.com **without an account** in a throwaway folder: User-Agent, service worker, requested permissions, screenshot (`LAB_PROBE_OUT=<folder>`) |
| `LAB_UA=electron npm run probe` | same with Electron's default User-Agent, for comparison |

Environment variables:

| Variable | Effect |
|---|---|
| `LAB_PERMISSIVE=1` | grants every permission (still logged): useful if WhatsApp breaks because of a refusal |
| `LAB_LOG_CONTENT=1` | logs notification titles and bodies. **Test accounts only** |
| `LAB_TARGET_URL=…` | loads another URL instead of `https://web.whatsapp.com/` |

Shortcuts: `Ctrl+1…9` and `Ctrl+Tab` switch accounts, `F12` opens the DevTools of the displayed account, right click → "Inspect element".

## Data and logs

| Mode | Folder |
|---|---|
| real accounts | `~/.config/feasibility-lab/` |
| fake page | `~/.config/feasibility-lab-fake/` |
| smoke test | temporary folder, deleted if everything passes |

In each folder, `logs/` holds, for every launch:

- `lab-<date>.jsonl`: one JSON event per line;
- `metrics-<date>.csv`: memory and CPU per account every 5 s, plus the application total.

Examples:

```bash
grep '"event":"notification"' ~/.config/feasibility-lab/logs/lab-*.jsonl
grep '"level":"warn"' ~/.config/feasibility-lab/logs/lab-*.jsonl
```

The `~/.config/feasibility-lab/Partitions/` folder holds the WhatsApp sessions: anyone who copies it can reuse the accounts. When the lab is over, remove the accounts in the lab **and** the linked devices from the phones (WhatsApp → Linked devices), then delete the folder.

## Test protocol

Record each result with its date and environment (desktop, Wayland or X11). Each account added uses one "linked device" on the phone (4 at most per number). The tests are ordered: an early failure can rule out a whole part of the product.

| # | Test | How | What to look at |
|---|---|---|---|
| 1 | Loading | `npm start`, add an account, scan the QR code | no "unsupported browser" screen; `page-env` without `problems` |
| 2 | Audio call | first in Chrome on web.whatsapp.com, then in the lab: call and be called from another phone | `permission-request` media, `media start/stop`, `window-open-allowed` (call popup?) |
| 3 | Interception | receive a message on a **hidden** account | system notification prefixed with the account name. A notification **without a prefix** bypassed the interception: look for `sw-notification` |
| 4 | Click | click the notification | the lab shows the right account and WhatsApp opens the chat |
| 5 | Read receipts | account B: open the chat with X; switch to A; X sends a message | on X's phone, no blue ticks until you return to B; B's `page-visibility` = `hidden` |
| 6 | Multiple partitions | 2, 3, then 5 accounts (5 numbers) | every account stays signed in, none signs out another |
| 7 | Restart | close, then relaunch the lab | no QR code requested |
| 8 | Sleep / wake | "Sleep", wait 10 s, "Wake" | memory drop in `metrics-*.csv`; no QR code on wake |
| 9 | Background latency | leave an account hidden for 1 h, then 8 h; send a message from another phone | gap between sending and the `notification` timestamp in the log (< 5 s) |
| 10 | Switching | repeated `Ctrl+1` / `Ctrl+2` | how it feels (no flash); `switch` only gives the main-process time |
| 11 | Memory | 1, 3, 5 accounts, 10 min to settle each | `metrics-*.csv` |
| 12 | Voice message | record a voice message | `permission-request` media audio granted, 🎤 while recording |
| 13 | Paste / drag | copy an image, then `Ctrl+V` in a chat; drag a file | refused `permission-check` events (`clipboard-read`?) |
| 14 | Video | video call | 📷, picture in both directions |
| 15 | Screen sharing | during a video call, share the screen; with `start:wayland`, then `start:x11` | `display-media-request` / `display-media-sources`; number of pickers shown |
| 16 | Call recognition | incoming call on a hidden account, with `LAB_LOG_CONTENT=1` on a test account | text and `tag` of the call notification; `audio` audible=true sustained |
| 17 | Remote sign-out | from the phone: Linked devices → sign out the lab | what the view shows; no generic event expected (confirms the need for the adapter) |
| 18 | Suspend / resume | put the PC to sleep for 10 min or more | `system-suspend`, `system-resume`, `post-resume-check` 30 s later; message received after wake-up |
| 19 | IME / emoji | `start:wayland`, then `start`; typing with fcitx5 / ibus, the desktop emoji picker | characters entered correctly |
| 20 | 72 h endurance | leave it running with 3 accounts | memory curve in `metrics-*.csv` |

Tests 21 to 28 cover features of WhatHush itself: run them with the application (`npm start` at the repository root), not with the lab.

| # | Test | How | What to look at |
|---|---|---|---|
| 21 | GNOME without AppIndicator | start WhatHush on GNOME without the AppIndicator extension | correct fallback without a tray |
| 22 | Notification photos | receive messages from contacts with a profile photo | actual icon format (`blob:`, `https://pps.whatsapp.net/…`, `data:`); photo shown. Fallback: notification without a photo |
| 23 | Message blur | enable the per-message blur, open chats | `[data-pre-plain-text]` markers and chat list previews recognised; messages, media and previews blurred. Fallback: the option turns itself off (self-test) |
| 24 | Now playing | play a voice message | message detected; player published on MPRIS on GNOME and KDE, with name and metadata. Fallback: in-app indicator only |
| 25 | Lock with the session | lock the desktop session on GNOME and KDE; stay idle on Wayland | `LockedHint` / `ScreenSaver.ActiveChanged` received; idle time measured on Wayland. Fallback: the other triggers (start-up, hidden window, manual) |
| 26 | Proxy | save proxy credentials, then call through the proxy | credentials encrypted by KWallet / GNOME Keyring; calls work behind the proxy. Fallback: credentials kept in memory, warning about calls |
| 27 | Clipboard | paste a screenshot, copy an image to GIMP, primary selection; on Wayland, then X11 | everything works. Fallback: adjust the allowlist (`clipboard-read`) |
| 28 | WhatsApp theme | set WhatsApp's theme to "System default" | where WhatsApp stores the setting. Fallback: the in-app hint only (already in place) |

GNOME-specific tests (and native X11 variants) need another machine or a VM if you are on KDE Plasma / Wayland.

## Setup findings

Probe of the real web.whatsapp.com, without an account (2026-10-04):

- **Electron's default User-Agent: refused.** WhatsApp shows "WhatsApp works with Google Chrome 100+". With a Chrome 152 User-Agent without "Electron": normal QR screen. The Client Hints (`Not?A_Brand`, `Chromium`) do not mention Electron in either case.
- The `window.Notification` override is in place before any WhatsApp script runs (`readyState` = `loading`, 0 scripts).
- WhatsApp registers a service worker (`https://web.whatsapp.com/sw.js`) that controls the page from the first load.
- On load, WhatsApp requests `persistent-storage` (now granted: it protects the session from storage eviction) and checks `background-sync` (refused for now, to watch).
- Electron 44 runs **natively on Wayland by default**: it starts without `DISPLAY`, whereas it fails when X11 is forced.
- Test 1 (loading) is partly validated: without an account, the QR screen appears with the Chrome User-Agent. It still has to be confirmed once signed in.

Lab mechanics:

- Smoke test against the fake page: 18/18 (User-Agent, Client Hints, `Notification` override before the page's scripts, interception, unread counts, visibility, click, storage isolation, sleep/wake, crash recovery, shell UI).
- `webContents.forcefullyCrashRenderer()` is not usable here: the renderer prints "Crashing because hung" but stays alive (more than 15 s observed) and `render-process-gone` never fires. Cause not verified (probably the system's handling of the crash dump). The lab therefore simulates crashes with `SIGKILL`. Consequence for crash recovery: a real crash might be detected late on Fedora; to watch.
