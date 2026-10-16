# CLAUDE.md for la2l-server

The server between the apps and the LA2L device in Ableton Live. It runs on Erik's Linux VPS in Docker, behind the web server that already serves lloydstellar.nl:

- API: `https://lloydstellar.nl/la2l/api` (the device's default `serverUrl`)
- LA2L Sender, a test page that pairs and sends sounds from a browser: `https://lloydstellar.nl/la2l/`
- Code: the `server/` folder of [lloydstellar/Lloyds-app2live](https://github.com/lloydstellar/Lloyds-app2live), the same repository as the device, because the server reuses the device's checks. On the VPS the repository is cloned at `~/la2l-server`, so this folder is `~/la2l-server/server`.

The first build follows [BUILD-PROMPT.md](BUILD-PROMPT.md). Keep this file up to date when commands, layout or decisions change; the next Claude starts from it.

## What the server does

1. **Pairing.** The device asks for a 6-character code and shows it. The user types it in an app. The server links that app to that computer and gives the device a device token and the app an app token.
2. **Packages.** An app uploads a package: a manifest (`app2live/1`) and its WAV files. The server checks it and keeps it for that computer.
3. **Import.** When Erik clicks Import in the device, it reads its inbox, downloads the manifest and the WAV files, places them in Live, and sends an ack. The server then deletes the files and tells the app what happened.

## Read first

1. [../docs/server-api.md](../docs/server-api.md): the contract. The device side is fixed: device 0.1.1 is installed and must keep working. The app side was a proposal; the server makes it final.
2. [../docs/manifest.md](../docs/manifest.md): the package format.
3. [../tests/mock-server.js](../tests/mock-server.js): the in-memory stand-in the device tests use. The real server answers every device route the same way.
4. [../src/node/server.js](../src/node/server.js) and [../src/node/http.js](../src/node/http.js): how the device calls the server (time-outs, redirects, sizes, which status means what).

## Commands

Planned in the build brief; correct them here once they exist.

| Command | Where | Does |
|---|---|---|
| `npm test` | `server/` | Server tests, including an end-to-end test that runs the real device code against this server |
| `npm test` | repository root | Device tests; run them after any change to `src/node/manifest.js`, `src/node/wav.js` or the API |
| `docker compose up -d --build` | `server/` | Build and start, or update after `git pull` |
| `docker compose logs -f --tail=200` | `server/` | Follow the log |
| `curl -s https://lloydstellar.nl/la2l/api/health` | anywhere | Must answer `{"ok":true,...}` |

## Rules that must not break

- **401 only for an unknown or revoked token.** The device forgets its pairing on a 401, and an app should too. Use 400, 403, 404, 409, 413, 415, 422, 429 or 507 for everything else.
- **Errors** are `{"error": "short plain English"}`: at most 80 characters, letters, digits and simple punctuation. The device shows the text to the user after its own message.
- **No redirects on `/api/...`.** The device follows only same-origin redirects, at most 3. No trailing-slash redirects there.
- **JSON answers** stay under 1 MB. **WAV downloads** have an exact `Content-Length` and `Content-Type: audio/wav`, and are never compressed.
- **Secrets**: tokens and pair ids come from `crypto.randomBytes`, codes from `crypto.randomInt`. Store only sha256 hashes of tokens and pair ids. Never log a token, a pair id, a code or an `Authorization` header.
- **Packages**: at most 32 sounds and 200 MB. WAV only: PCM 8, 16, 24 or 32 bit, or float 32 or 64 bit, mono or stereo, 8 to 192 kHz. Deleted right after an `imported` or `partial` ack, and at the latest 24 hours after upload.
- **The manifest the device downloads** carries the server's `package_id`, and `bytes` and `sha256` for every sound.
- **An API change** means: update `docs/server-api.md` in the same commit, keep device 0.1.1 working, and run both test suites.
- **Reuse, do not copy**: package and WAV checks come from `../src/node/manifest.js` and `../src/node/wav.js`. If they need a change, change them there and keep the device tests green.

## Deployment

- Docker Compose. The container listens on `127.0.0.1:8787` only; the existing web server proxies `/la2l/` to it and keeps doing TLS.
- The build context is the repository root (the server needs `src/node`), set in `compose.yaml`.
- Data (the SQLite database and the package files) lives in a Docker volume, mounted at `/data`.
- Update: `git pull && docker compose up -d --build` in `server/`.
- The website on lloydstellar.nl must keep working, including `http://lloydstellar.nl/test/test-file-voor-max.wav`, which the device's Test import downloads.
- Ask Erik first before installing system packages, changing the web server, the firewall or another site, or deleting anything outside this repository and the server's volume.

## Working with Erik

Erik writes Dutch: answer him in Dutch, short, and lead with what he must do. Code, comments, commit messages, docs, API error texts and the Sender page are in English. When he must test, say what to click in the device or on the Sender page and what he should see.
