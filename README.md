# Whose Is It

A desktop party game for Windows 11 and macOS. Everyone submits 1–3 photos of something personal. Each photo is scrambled with a different filter, so you can still tell **what** it is but not **whose** it is. Then everyone guesses during a slideshow.

- Lobbies have random 6-character codes. Open lobbies are listed, but you need the code to join.
- There are 4 filters: **Static** (100 pts), **Posterize** (150), **Sketch** (200) and **Ink** (250). Fast answers earn up to 50 bonus points, and you earn 25 for each player who guesses wrong on your photo.
- Photos are scrambled and encrypted **on the player's computer**. The server only relays ciphertext, deletes each image when its slide ends, and never writes anything to disk.
- The game window is excluded from screenshots, screen recordings and screen sharing (Windows and macOS).

Everything here is free: open-source tools, the free Tailscale plan and free GitHub Actions minutes.

---

## Quick start (one computer)

Install **Node.js 22 LTS** from https://nodejs.org, then run:

```bash
npm install
npm run playtest      # starts a server and 4 game windows
```

---

## Hosting for friends

You do this once. After that, friends install the app, type their name, and they're connected to your server automatically.

### 1. Run the server inside your app (host mode)
Open the app. On the sign-in screen, tick **Host the game server on this computer**. The server starts immediately, and from then on it starts every time you open the app.

To run it without the app instead, use `npm run server`.

### 2. Make it reachable with Tailscale Funnel (free, no router changes)
1. Install Tailscale from https://tailscale.com/download and sign in. The free Personal plan is enough.
2. Open a terminal (PowerShell on Windows) and run:
   ```bash
   tailscale funnel --bg 3000
   ```
   The first time, Tailscale asks you in the browser to enable HTTPS and Funnel. Approve both.
3. Tailscale prints your public address, for example `https://desktop-ab12.tail3f9c.ts.net`. Friends never need to see this address.

`--bg` keeps Funnel on across restarts. To turn it off, run `tailscale funnel reset`.

The connection is HTTPS and the encryption ends on your PC. Your home IP stays hidden and no router ports are opened. Your PC needs to be on, with the app open (or `npm run server` running), whenever people play.

### 3. Bake your address into the installers
See the next section. When you pass `--server`, every installer you build connects to your server by default. Players can still use **Use a different server** on the sign-in screen.

---

## Building the installers on GitHub

You need [Git](https://git-scm.com) and the [GitHub CLI](https://cli.github.com). On Windows:

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
```

Open a **new** terminal in this folder and run:

```bash
npm run github:setup -- --server https://desktop-ab12.tail3f9c.ts.net
```

This one command:
1. signs you in to GitHub in your browser (first time only),
2. creates a **private** repo called `whose-is-it` and pushes the project,
3. saves your server address as a repo variable (`GAME_SERVER_URL`), and
4. tags `v1.1.0`. That tag makes GitHub Actions build the Windows `.exe` and the macOS `.dmg` files and publish them as a **Release** (about 10 minutes).

The command prints the Release link. Download the installers there and send them to your friends.

Later on:

| Command | What it does |
|---|---|
| `npm run github:release` | Bumps the version, pushes, and builds a new release |
| `npm run github:server -- https://…` | Changes the baked-in server address. Run `github:release` afterwards. |

The build workflow lives at `ci/github-build.yml`. The setup command copies it to `.github/workflows/build.yml`.

### First launch on friends' computers (no paid code-signing)
- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** right-click the app, choose **Open**, then **Open** again. Use the `arm64` dmg on Apple Silicon Macs and the `x64` one on Intel Macs. If macOS says the app "is damaged", run this once:
  `xattr -cr "/Applications/Whose Is It.app"`

---

## How a round works

1. **Lobby.** The host shares the code. Everyone checks that the **verification code** (four words) matches on every screen. The host sets photos per player, time per slide, upload time and max players. At least 3 players are needed.
2. **Upload.** Each photo slot gets a different random filter. The photo is normalized (random crop, tilt and mirror; 512×512; metadata stripped), scrambled and then encrypted. Each scramble can be regenerated once. If a hard filter makes a photo unrecognizable, an easier one is used instead.
3. **Slideshow.** Slides are shuffled so one person's photos never appear back to back. Nothing is revealed between slides, and scores stay hidden.
4. **Results.** Shows the top three, the scoreboard, and who owned each slide and who guessed it. No images are shown.

---

## Security model

| Threat | Protection |
|---|---|
| Network eavesdropping | TLS via Tailscale Funnel (`https://`) |
| A compromised server or tunnel | End-to-end encryption. Each player has an ECDH P-256 key pair, and the host wraps a fresh AES-256-GCM game key for each player. Images are encrypted on the uploader's PC. |
| Key substitution (man in the middle) | The verification code (a hash of every public key) must match on all screens |
| Images lingering | The server zero-fills each image when its slide ends. Clients wipe the canvas. Nothing touches disk or logs, and keys live only in memory. |
| Screenshots, recording, screen share | `setContentProtection` (Windows `WDA_EXCLUDEFROMCAPTURE`, macOS `NSWindowSharingNone`). Images are also hidden whenever the window is inactive. |
| Extracting image bytes | Canvas-only rendering, DevTools and right-click disabled in installed builds, sandboxed renderer, strict CSP |
| Photos of the screen | A faint watermark with the viewer's name and time |
| Code guessing, spam | 31^6 possible codes. A 30-second lockout after 5 wrong tries. Rate limits, upload size and count limits, and idle lobbies closed after 10 minutes. |
| Cheating | Ownership stays on the server until the results. Guessing your own photo is rejected. |

**Limits.** A phone camera, a capture card or a virtual machine can't be blocked. Some newer macOS capture tools may ignore the window flag. Linux has no capture protection. The person running the server could inspect who submitted which slide during a game.

---

## Project layout

```
server/createServer.ts   game server (used by `npm run server` and by host mode)
server/lobbyManager.ts   lobby and game state machine, timers, image purge
server/game.ts           pure logic: codes, slide order, scoring
src/shared/protocol.ts   wire types, filter tiers, limits
src/main/                Electron main process: capture protection, host mode, clipboard
src/renderer/src/        React UI (screens/, components/), crypto.ts, obfuscate/
tests/                   vitest suites (npm test)
scripts/                 playtest.mjs, github.mjs
ci/github-build.yml      installer build + release workflow
build/icon.png           app icon
```

**Tuning:**
- Points: `src/shared/protocol.ts`
- Filter strength: `src/renderer/src/obfuscate/tiers.ts`
- Timers: `TIMING` in `server/lobbyManager.ts`
