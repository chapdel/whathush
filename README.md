# WhatHush

A multi-account WhatsApp Web desktop client for Linux: several isolated accounts side by side, with Snooze, Focus, schedules, deep sleep and desktop integration.

- WhatHush is an independent project, not affiliated with WhatsApp LLC or Meta Platforms. It displays the official WhatsApp Web and does not reimplement any protocol.
- The interface is available in English and French, following the system language by default.

## Features

| Feature | How it works |
|---|---|
| Isolated accounts | one Chromium partition (`persist:wa-<uuid>`) per account, hardened by a single session factory |
| Instant switching | `Ctrl+1…9`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, even when WhatsApp has focus; order set by drag and drop |
| No stray read receipts | only the displayed account is visible; every other page sees itself as `hidden` |
| Per-account notifications | `window.Notification` is intercepted, prefixed with the account name, and a click opens the right account and chat; sender photos are fetched by the main process from `*.whatsapp.net` only |
| Unread counts | read from the page title, totalled in the sidebar, the tray (number, dot or nothing) and the launcher badge |
| Snooze | 30 min, 1 h, 4 h, tomorrow morning, Monday, until a date, until turned back on; the page's sound is muted, but a voice message started by the user keeps playing |
| Schedules and Focus | priority is manual > Focus > schedule; daylight saving and time-zone changes apply without a restart |
| Deep sleep | the view is destroyed and the session kept; waking needs no QR code; never during a call |
| Resources | memory per account, optional automatic sleep, a suggestion to sleep accounts above 2 GB, staggered start-up |
| Calls | microphone, camera and screen sharing are detected and shown in the sidebar and tray; screen sharing goes through the portal on Wayland, with a screen picker on X11 |
| Tray | full menu; detects GNOME without AppIndicator and falls back |
| Links | http, https and mailto open in the system browser, dangerous schemes are blocked, `wa.me` links ask which account to use |
| Downloads | Downloads folder, never overwritten, never opened automatically; history with retention, open, show in folder, missing files flagged |
| Clipboard | text and images, "Copy image", "Paste as plain text" (`Ctrl+Shift+V`) |
| Now playing | voice messages are tracked through the standard media API, with Pause / Resume in the sidebar, the tray and MPRIS |
| Zoom and shortcuts | zoom per account (`Ctrl+=`, `Ctrl+-`, `Ctrl+0`, `Ctrl`+wheel), interface scale, shortcut sheet (`Ctrl+/`); layout-aware, including AZERTY |
| Offline spell checking | English and French dictionaries are bundled; other languages are downloaded from Google only when explicitly chosen |
| Passcode lock | at start-up, when the window is hidden, after inactivity or with the session lock; growing delay after wrong codes; "Forgot code" signs out every account |
| Privacy veil | `Ctrl+Shift+H`, on focus loss or during screen sharing; optional per-message blur (experimental) |
| Per-account permissions | microphone, camera, location, screen sharing: allow, ask or deny |
| Proxy | HTTP, HTTPS and SOCKS5, global or per account, with encrypted credentials; a local relay handles authenticated SOCKS5 |
| Diagnostic report | a redacted file for the user to attach to a bug report; nothing is ever sent |
| Crash recovery | the view is recreated after 1 s, 5 s and 30 s, then stops and offers a "Reload" button |
| QR and sign-out detection | an isolated, read-only adapter, with a degraded mode if it stops responding |

## Install

Download the package for your distribution from the [latest release](https://github.com/chapdel/whathush/releases/latest) and check it against `SHA256SUMS`.

```bash
# AppImage (updates itself)
chmod +x WhatHush-0.2.0-x86_64.AppImage && ./WhatHush-0.2.0-x86_64.AppImage
# Debian / Ubuntu (also installs the AppArmor profile required on Ubuntu 24.04+)
sudo apt install ./whathush_0.2.0_amd64.deb
# Fedora
sudo dnf install ./whathush-0.2.0.x86_64.rpm
# Arch Linux (AUR)
yay -S whathush-bin
```

Flathub (`flatpak install flathub io.github.chapdel.mcdesk`) will follow once the submission is accepted.

On first launch, add an account and scan the QR code from your phone (WhatsApp → Linked devices). Each account uses one linked device (at most 4 per phone number).

## Develop

```bash
npm install
npm start            # build, then run against the real web.whatsapp.com
npm run demo         # run against a local fake WhatsApp page (no account needed)
```

Data lives in `~/.config/mcdesk/` (mode 0700; `~/.config/mcdesk-demo/` for the demo). Logs are in `logs/app.log` and never contain message content.

## Tests

| Command | What it checks |
|---|---|
| `npm run typecheck` | types across the whole project |
| `npm test` | 201 unit tests: policy, Snooze/Focus expiry, time zones, state machine, account manager, links, storage and v1 → v2 migrations, menus, IPC, the `app://` protocol, autostart, language catalogues, shortcuts, media playback, download history, permissions, lock, proxy and SOCKS5 relay (against a fake upstream proxy), encrypted credentials, veil, redacted report, context menu, tray menus, notification photos, spell checker |
| `npm run test:e2e` | 47 end-to-end tests (Playwright drives Electron headless against the fake page): keyboard, dialogs, resizing, themes and HiDPI, English interface, clipboard, playback, zoom, downloads, report, lock, veil, permissions, HTTP and SOCKS5 proxies, notification photos; screenshots go to `test-results/screens/` |
| `npm run test:native` | the visibility rule measured without Playwright (Playwright emulates page focus, which would skew the result), including while locked, and Snooze muting a sound started by a hidden page |
| `npm run build && ./node_modules/.bin/playwright test --config playwright.native.config.ts` | windows and tray on the current desktop, Wayland and X11 backends depending on the session; uses local test accounts |
| `cd lab && npm run smoke` | the [Feasibility Lab](lab/README.md) smoke test |
| `npm run icons` | regenerates the numbered tray icons (ImageMagick) |

When launched from KDE Wayland, the X11 backend runs through XWayland. Automated screenshots use the fake WhatsApp page.

## Packages

```bash
npm run build && npx electron-builder --linux AppImage tar.gz --publish never   # on the host
# .deb and .rpm: fpm needs libcrypt.so.1 (missing from Fedora 44) and rpmbuild,
# hence a container:
podman run --rm --security-opt label=disable -v "$PWD":/work -w /work \
  registry.fedoraproject.org/fedora:44 bash -c \
  "dnf install -y nodejs rpm-build libxcrypt-compat && npx electron-builder --linux rpm deb --prepackaged release/linux-unpacked --publish never"
# Flatpak, built from source and offline, like on Flathub
# (--no-documents-portal only works around a broken document portal on the host)
flatpak run --no-documents-portal org.flatpak.Builder --user --install-deps-from=flathub --force-clean \
  --repo=release/flatpak-repo release/flatpak-build packaging/flatpak/io.github.chapdel.mcdesk.yml
flatpak build-bundle release/flatpak-repo release/WhatHush-0.2.0.flatpak io.github.chapdel.mcdesk
```

After any change to `package-lock.json`, regenerate the Flatpak's npm sources with `packaging/flatpak/update-sources.sh` (needs [flatpak-node-generator](https://github.com/flatpak/flatpak-builder-tools/tree/master/node)). `npm run screenshots` regenerates the AppStream screenshots in `packaging/screenshots/`.

`whathush --self-test` actually starts the packaged application (with its fuses enabled), checks that the interface renders and prints a JSON summary, including the build fingerprint (`build`: commit and date). Comparing that fingerprint with `dist/build-info.json` proves the package contains the expected build rather than a stale cached one.

| Format | How it is verified |
|---|---|
| AppImage | self-test with interface rendering |
| `.deb` | installed in Ubuntu 24.04: dependencies, files, desktop entry, AppArmor profile, self-test with rendering |
| `.rpm` | installed in Fedora 44: dependencies, valid desktop entry, self-test with rendering |
| AUR (`packaging/aur/PKGBUILD`) | `makepkg` (checksums verified), then `pacman -U` in Arch Linux, self-test with rendering |
| Flatpak | built from source on the Electron 25.08 base app with zypak, installed, self-test with rendering inside the real sandbox, uninstalled |

The packaged binary has its Electron fuses set: no `RunAsNode`, no `NODE_OPTIONS`, no `--inspect`, cookie encryption on, and the app loads only from its ASAR archive.

## Architecture

```text
src/
  shared/                 constants, identity, zod schemas, IPC contract, display formats
  shared/i18n/            English and French catalogues
  main/core/              pure logic without Electron: policy, time zones, states, links,
                          permissions, menus, resources, adapter, lock, proxy, playback
  main/storage/           configuration files: atomic writes, migrations
  main/sessions/          hardened session factory
  main/views/             WebContentsView per account, visibility rule
  main/accounts/          account life cycle, crash recovery
  main/notifications/     notification interception and display
  main/policy/            Snooze, Focus and schedules applied
  main/links/             link and popup routing
  main/whatsapp-adapter/  the only code that reads WhatsApp's content
  main/security/          passcode lock
  main/privacy/           privacy veil
  main/proxy/             proxy and local SOCKS5 relay
  main/diagnostic/        diagnostic report
  main/app.ts             wiring, UI state, commands, IPC
  preload/                shell (typed API) and WhatsApp views (interception)
  renderer/               React interface: sidebar, home, dialogs, settings
tests/                    unit, end-to-end (fake WhatsApp page), native
packaging/                desktop entry, AppStream, PKGBUILD, Flatpak manifest
lab/                      Feasibility Lab, a separate throwaway project
```

## Releasing

1. Bump `version` in `package.json` and `pkgver` in `packaging/aur/PKGBUILD`, and add a `<release>` entry to `packaging/linux/io.github.chapdel.mcdesk.metainfo.xml`: its English text becomes the release notes.
2. Commit, then push a tag: `git tag v0.2.0 && git push origin master v0.2.0`. The [Release workflow](.github/workflows/release.yml) runs every test, builds the packages and creates a **draft** release with `SHA256SUMS` and `latest-linux.yml`.
3. Check the draft on GitHub, then publish it. Running AppImages pick up the update from then on.
4. **AUR**: `git clone ssh://aur@aur.archlinux.org/whathush-bin.git ../whathush-bin`, then `packaging/aur/update.sh ../whathush-bin` (checksums and `.SRCINFO`, computed in an Arch container with podman), then commit and push in `../whathush-bin`.
5. **Flathub**: `packaging/flatpak/prepare-flathub.sh <folder>` writes the manifest pinned to the tag, the npm sources and `flathub.json`. The first time, open a pull request against the `new-pr` branch of [flathub/flathub](https://github.com/flathub/flathub); afterwards, commit to the app's own Flathub repository.

## Project status

Version 0.2.0, not published yet.

- **Real-account validation**: the [Feasibility Lab](lab/README.md) protocol still has to be run with real accounts. It will confirm the features marked experimental: call notification recognition ("calls only" mode), the chat markers used by the adapter and the message blur, the shape of notification photos, MPRIS, the session lock on GNOME and KDE, and the keyring for proxy credentials.

## License

WhatHush is free software, released under the [GNU General Public License v3.0 or later](LICENSE). The bundled spell-checking dictionaries keep their own licenses (MPL 2.0 for French, SCOWL for English); see `build/dictionaries/NOTICE.txt`.
