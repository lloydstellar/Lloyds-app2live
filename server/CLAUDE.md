# CLAUDE.md for la2l-server

The server between the apps and the LA2L device in Ableton Live. It runs on Erik's Linux VPS in Docker, behind the web server that already serves lloydstellar.nl:

- API: `https://lloydstellar.nl/la2l/api` (the device's default `serverUrl`)
- LA2L Sender, a test page that pairs and sends sounds from a browser: `https://lloydstellar.nl/la2l/`
- The test receiver, a page that stands in for Live for app developers: `https://lloydstellar.nl/la2l/receiver` (the developer kit, `../sdk/CLAUDE.md`)
- Web808, the drum machine example of the SDK: `https://lloydstellar.nl/la2l/examples/drum-machine/`, from `../examples/web-drum-machine`
- Code: the `server/` folder of [lloydstellar/Lloyds-app2live](https://github.com/lloydstellar/Lloyds-app2live), the same repository as the device, because the server reuses the device's checks. On the VPS the repository is cloned at `~/la2l-server`, so this folder is `~/la2l-server/server`.

The server was built from [BUILD-PROMPT.md](BUILD-PROMPT.md) in phases 0 to 5, finished on 2026-10-17; the brief stays as the record of what was decided and why. The developer kit ([../sdk/BUILD-PROMPT.md](../sdk/BUILD-PROMPT.md), section 7) adds to it from 0.7.0: storage limits per address and for the whole server, `DELETE /apps/{id}`, test receivers, the `X-LA2L-Client` header, and the pages of the kit. [README.md](README.md) says how to install, update, back up and troubleshoot it, and where the code is. Keep this file up to date when commands, layout or decisions change; the next Claude starts from it.

## What the server does

1. **Pairing.** The device asks for a 6-character code and shows it. The user types it in an app. The server links that app to that computer and gives the device a device token and the app an app token.
2. **Packages.** An app uploads a package: a manifest (`app2live/1`) and its WAV files. The server checks it and keeps it for that computer.
3. **Import.** When Erik clicks Import in the device, it reads its inbox, downloads the manifest and the WAV files, places them in Live, and sends an ack. The server then deletes the files and tells the app what happened.

## Read first

1. [../docs/server-api.md](../docs/server-api.md): the contract. Both sides are final. The device side is fixed: device 0.1.1 is installed and must keep working; device 0.2.0 added `GET /apps` (server 0.6.0). Apps are built against the app side, and LA2L Sender (`public/sender.js`) is its reference client. [../docs/openapi.yaml](../docs/openapi.yaml) is the app side for machines: a change to the app side changes it too, and `sdk/js` tests hold it to the server.
2. [../docs/manifest.md](../docs/manifest.md): the package format.
3. [../tests/mock-server.js](../tests/mock-server.js): the in-memory stand-in the device tests use. The real server answers every route the device calls the same way. The mock has none of what only the developer kit uses: the `id` in `GET /apps`, `DELETE /apps/{id}`, and test receivers.
4. [../src/node/server.js](../src/node/server.js) and [../src/node/http.js](../src/node/http.js): how the device calls the server (time-outs, redirects, sizes, which status means what).

## Commands

The server targets Node 24 (the image and CI use it). The VPS itself has Node 22, so run the server tests there in a `node:24` container (second row); they pass on Node 22 too, but Node 24 is what counts.

| Command | Where | Does |
|---|---|---|
| `npm test` | `server/` | Server tests, with an end-to-end test that runs the real device code (pairing and Import) against this server |
| `docker run --rm --user 1000:1000 -e HOME=/tmp -v "$PWD/..:/repo" -w /repo/server node:24-bookworm-slim npm test` | `server/` | The same on Node 24, on the VPS |
| `npm test` | repository root | Device tests; run them after any change to `src/node/manifest.js`, `src/node/wav.js` or the API |
| `npm run build && npm test` | `../sdk/js` | Builds `public/vendor/la2l.js` from the SDK, and runs its tests, which hold `docs/openapi.yaml` to this server. After `npm ci` there |
| `bash deploy/update.sh` | `server/` | Build and start what is checked out, after `git pull`. Saves the log of the old container to `~/la2l-server-logs` first (Docker drops it with the container), backs up the database, then waits for the health check |
| `bash deploy/backup.sh` | `server/` | Copies the database to `~/la2l-server-backups` and keeps the newest 30, whether the server runs or not |
| `bash deploy/restore.sh <backup>` | `server/` | Puts a backup back: checks it, asks, stops the server, backs up the current database, replaces it, starts, and prints how to undo it. Works whether the server runs, is stopped or keeps restarting |
| `docker run --rm -v "$PWD:/mnt:ro" koalaman/shellcheck:v0.11.0 deploy/*.sh` | `server/` | Checks the deploy scripts, as CI does |
| `docker compose logs -f --tail=200` | `server/` | Follow the log of the running container |
| `docker compose restart` | `server/` | Restart without a rebuild; the log stays |
| `curl -s https://lloydstellar.nl/la2l/api/health` | anywhere | Must answer `{"ok":true,...}` |
| `bash deploy/install-nginx.sh --check` | `server/` | Shows what the nginx install would change; no sudo needed |
| `sudo bash deploy/install-nginx.sh` | `server/` | Puts `deploy/nginx-la2l.conf` into nginx, or updates it after a change; `--remove` takes it out. Erik runs it: sudo needs his password |

## Rules that must not break

- **401 only for an unknown or revoked token.** The device forgets its pairing on a 401, and an app should too. Use 400, 403, 404, 409, 413, 415, 422, 429 or 507 for everything else.
- **Errors** are `{"error": "short plain English"}`: at most 80 characters, letters, digits and simple punctuation. The device shows the text to the user after its own message.
- **No redirects on `/api/...`.** The device follows only same-origin redirects, at most 3. No trailing-slash redirects there.
- **JSON answers** stay under 1 MB. **WAV downloads** have an exact `Content-Length` and `Content-Type: audio/wav`, and are never compressed.
- **Secrets**: tokens and pair ids come from `crypto.randomBytes`, codes from `crypto.randomInt`. Store only sha256 hashes of tokens and pair ids. Never log a token, a pair id, a code or an `Authorization` header.
- **Packages**: at most 32 sounds and 200 MB. WAV only: PCM 8, 16, 24 or 32 bit, or float 32 or 64 bit, mono or stereo, 8 to 192 kHz. Deleted right after an `imported` or `partial` ack, and at the latest 24 hours after upload.
- **The manifest the device downloads** carries the server's `package_id`, and `bytes` and `sha256` for every sound.
- **An API change** means: update `docs/server-api.md` in the same commit, keep device 0.1.1 working, and run both test suites.
- **Reuse, do not copy**: package and WAV checks come from `../src/node/manifest.js` and `../src/node/wav.js`. If they need a change, change them there and keep the device tests green; `../sdk/fixtures` and the port in `../sdk/js` change with them.
- **`public/vendor/` is built** from `../sdk/js` (`la2l.js`, `la2l-button.js`, `la2l-receiver.js`). Never edit it by hand; CI fails when it differs from a fresh build. LA2L Sender (`public/sender.js`) and the test receiver page run on it: a change in their behaviour may belong in the SDK.
- **Examples** are served from a folder of the repository (`static.js`, `EXAMPLES`), listed once at start; the Dockerfile copies them into the image.
- **Addresses** stay out of the database, except as a keyed hash with a package while it has files (the limit per address). The key lives only in the memory of the running server, so a restart forgets who sent what, as it forgets the rate limits. That is on purpose: a backup of the database cannot tell an address.

## Deployment

- Docker Compose. The container listens on `127.0.0.1:8787` only; the existing web server proxies `/la2l/` to it and keeps doing TLS.
- nginx: `deploy/nginx-la2l.conf` is installed as `/etc/nginx/snippets/la2l.conf` and included in the 443 server block of lloydstellar.nl by `deploy/install-nginx.sh`, which backs up the site file, tests with `nginx -t` and puts everything back when the test fails. After a change to the snippet, run the script again.
- The build context is the repository root (the server needs `src/node`), set in `compose.yaml`.
- Data (the SQLite database and the package files) lives in the Docker volume `la2l-server_la2l-data`, mounted at `/data`. At start the server removes leftovers there and marks packages whose files are gone as expired, so a restored database is consistent again.
- Update: `git pull && bash deploy/update.sh` in `server/`. A plain `docker compose up -d --build` works too, but loses the log of the old container and makes no backup.
- The database is at schema 2 since 0.7.0. Going back to 0.6.0 or older takes the backup `update.sh` made before the update to 0.7.0.
- Backups: only the database (`deploy/backup.sh`, made before every update). The WAV files wait 24 hours at most and are not backed up. Restoring is `deploy/restore.sh`; README.md has the details. Both scripts reach the database through a short-lived container of the server's image with its volume (`deploy/copy-db.js`, `deploy/check-db.js`), so they never depend on the server running. Test them on a scratch container (`LA2L_CONTAINER`, `LA2L_BACKUP_DIR`), never on the real one.
- GitHub: the clone on the VPS pushes and opens pull requests through the `gh` login of lloydstellar (https). No deploy key: Erik decided that on 2026-10-16, see section 13.1 of the build brief.
- The website on lloydstellar.nl must keep working, including `http://lloydstellar.nl/test/test-file-voor-max.wav`, which the device's Test import downloads.
- Ask Erik first before installing system packages, changing the web server, the firewall or another site, or deleting anything outside this repository and the server's volume.

## Working with Erik

Erik writes Dutch: answer him in Dutch, short, and lead with what he must do. Code, comments, commit messages, docs, API error texts and the Sender page are in English. When he must test, say what to click in the device or on the Sender page and what he should see.
