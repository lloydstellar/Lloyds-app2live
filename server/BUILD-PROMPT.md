# Build brief: la2l-server

You are Claude Code on Erik's Linux VPS, the machine behind lloydstellar.nl. Your job is to build, test and run the server of Lloyd's App2Live (LA2L) in this repository, on this machine. This brief is the whole assignment. Read it to the end before you start, then work phase by phase (section 15). After each phase, tell Erik in Dutch what to test, and wait for his answer before the next phase.

To start, Erik will say something like: *"Lees server/BUILD-PROMPT.md en begin met fase 0."*

---

## 1. LA2L in one minute

```
 App (Android, web,           la2l-server                  LA2L device in Ableton Live
 LA2L Sender test page)       (this brief)                 (done, version 0.1.1)

   pair with a code   ───▶   links app and computer  ◀───  shows the code, polls
   upload a package   ───▶   keeps it for 24 h at most
                             hands it over           ◀───  Import: inbox, manifest, WAV files
   "In Live"          ◀───   result                  ◀───  ack
        app token                                          device token
```

What the user sees:

1. In Live, the LA2L device shows **Pair app**. Clicked, it shows a code like `K7P 42Q` that works for 10 minutes.
2. The user types the code in an app. The device says "Paired with LA2L Sender".
3. In the app the user sends sounds: WAV files, each described as a loop or a one-shot, drums or bass, at a tempo.
4. In Live the user clicks **Import**. Every sound becomes a new audio track, named, coloured and warped to its tempo. The app says "In Live".

State of things:

- **The device is done**: version 0.1.1, tested in Live 12.4.6 on Windows. It is installed on Erik's computer and must keep working unchanged. Its server address is `https://lloydstellar.nl/la2l/api`. Today that address answers with the website's HTML, so the device's Self test says "no App2Live server at lloydstellar.nl".
- **The server does not exist yet.** That is you.
- **The apps do not exist yet**, apart from the test page you build here (LA2L Sender, section 11). Later Erik's own Android and web apps will send sounds, and an Android share target ("Share → To Ableton"). Design the app API for them too.

---

## 2. What exists: read in this order

| # | File | Why |
|---|---|---|
| 1 | `CLAUDE.md`, `server/CLAUDE.md` | How to work in this repository and with Erik. |
| 2 | `docs/server-api.md` | The contract. The **device side is binding**: build it exactly like this. The **app side is a proposal**: you make it final (section 8) and update the document. |
| 3 | `docs/manifest.md` | The package format `app2live/1`. |
| 4 | `src/node/server.js`, `src/node/http.js` | How the device calls the server. The facts that matter are listed below. |
| 5 | `tests/mock-server.js` | The in-memory stand-in the device tests use. For every device route, your server must answer the way this does. |
| 6 | `tests/app.test.js` | How the device is tested end to end. Your end-to-end test copies its `device()` helper (section 14.3). |
| 7 | `src/node/manifest.js`, `src/node/wav.js` | Package and WAV checks. **Reuse them**, do not copy them (section 5.6). |
| 8 | `docs/design-notes.md`, `README.md` | How the device works inside. Background only. |

How the device behaves as an HTTP client (from `src/node/http.js` and `src/node/server.js`):

- JSON calls time out after 15 seconds; `/health` after 8, `GET /pair/{id}` after 10, the cancel after 5, `/unpair` after 8.
- It sends `Accept: application/json`, `User-Agent: LA2L/0.1.1 (Max for Live; win32)` (or `darwin`), and `Content-Type: application/json` with a JSON body. It does **not** send `Accept-Encoding`, and it cannot read compressed answers: never compress.
- A JSON answer may be 1 MB at most. A 204 or an empty body counts as `{}`.
- It follows redirects only to the same origin (scheme, host and port), at most 3.
- **401: it forgets its pairing** and shows Pair app again. 403 does not. A 404 on `GET /pair/{id}` means expired. A 404 on a file download is not retried.
- Downloads: it refuses a `Content-Length` larger than the `bytes` in the manifest, allows 10 minutes per file and 20 seconds without data, then checks `bytes` and `sha256`. On a 5xx, a broken connection or a wrong checksum it tries again, up to 3 times, after 1, 2 and 4 seconds.
- It shows the server's error text from `{"error": "..."}` (or `"message"`): it keeps letters, digits, space and `. : ' ( ) -`, and cuts it to 80 characters.
- `/health` must answer `{"ok": true}`. Anything else (a web page, a 404, JSON without `"ok": true`) makes Self test say "no App2Live server at <host>".

---

## 3. Decisions already made

Do not change these without asking Erik.

| Decision | Why |
|---|---|
| Node.js 24 LTS, plain `node:http`, no framework | Same language as the device; the server can reuse the device's checks; `tests/mock-server.js` already shows the shape. |
| No npm dependencies. SQLite through the built-in `node:sqlite` | Nothing to install, no native builds, no supply chain. If `node:sqlite` turns out to lack something essential, `better-sqlite3` is the fallback: tell Erik why before you switch. |
| Docker Compose; the container listens on `127.0.0.1:8787` only | One command to start and update; the server cannot touch the rest of the VPS; it restarts by itself. |
| The existing web server proxies `https://lloydstellar.nl/la2l/` to the container and keeps doing TLS | The device already uses this address; the certificate stays where it is. |
| Polling only. No websockets, no push | The device asks for its inbox only when Erik clicks Import, and polls only while a code shows. |
| No user accounts | A **device** is one computer with one device token. An **app token** belongs to one app on one computer. A computer can have several apps: Settings > Add app keeps the same device token. |
| Packages: at most 32 sounds and 200 MB, WAV only, kept 24 hours at most, deleted after an `imported` or `partial` ack | Agreed with Erik; the device checks the same limits. |
| 401 only for an unknown or revoked token | The device unpairs itself on 401. |
| Every text a user can see is plain English | Erik's rule for the whole project. |
| Open source under the Apache License 2.0 (`LICENSE`). The repository is private for now | Erik decides when it goes public, so write every file and commit as if it were public already: no secrets, keys, tokens, real logs or private server configuration. |

---

## 4. Phase 0: look at the VPS before you change anything

Run these, then send Erik a short summary in Dutch: what runs, what you propose to change, and the one or two things you need his yes for.

```bash
cat /etc/os-release; uname -m; nproc; free -h; df -h /
docker --version; docker compose version; systemctl is-active docker
ss -tlnp | grep -E ':(80|443|8787)\b'
nginx -v 2>&1; apache2 -v 2>/dev/null || httpd -v 2>/dev/null; caddy version 2>/dev/null
ls -d /usr/local/psa /usr/local/cpanel /usr/local/directadmin /usr/local/hestia 2>/dev/null   # a control panel?
grep -rl "lloydstellar.nl" /etc/nginx /etc/apache2 /etc/httpd /etc/caddy 2>/dev/null
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://lloydstellar.nl/la2l/api/health
curl -sSI http://lloydstellar.nl/test/test-file-voor-max.wav | head -5
node --version 2>/dev/null
sudo -n true 2>/dev/null && echo "sudo without password" || echo "sudo needs a password, or none"
```

Questions to settle with Erik in that one message:

- **Docker** is missing: may you install Docker Engine and the compose plugin from Docker's own repository (docs.docker.com/engine/install)?
- **The web server**: show the exact lines you will add for `/la2l/` (section 12), where, and how you back up the file first. A control panel (Plesk, cPanel, DirectAdmin, HestiaCP) has its own place for extra directives: use that, so the panel does not overwrite your change.
- **GitHub**: you need write access to push (section 13.1).

Do not touch other sites, other containers, the firewall or system services beyond this.

---

## 5. Architecture

### 5.1 Layout

```
server/
  CLAUDE.md            keep up to date
  BUILD-PROMPT.md      this brief
  README.md            run, update, back up, troubleshoot (write it in phase 5)
  package.json         "name": "la2l-server", no dependencies; scripts: start, test
  .env.example         every setting with its default and one line of explanation
  Dockerfile           build context: the repository root
  compose.yaml
  src/
    main.js            reads the config, opens the database, starts HTTP and the cleanup timer
    config.js          environment variables, defaults, checks
    db.js              schema, migrations (PRAGMA user_version), queries
    router.js          method + path pattern -> handler; 404 and 405
    http-util.js       JSON body with a size limit, send(), errors, CORS, request log
    tokens.js          tokens, pair ids, codes, hashing
    ratelimit.js       in-memory windows per key
    storage.js         package folders, .part files, sha256 while streaming, free disk space
    cleanup.js         every expiry rule from section 9
    routes/device.js   section 7
    routes/app.js      section 8
    static.js          serves public/ with the right headers
  public/              LA2L Sender: index.html, sender.js, sender.css, the logo
  test/                node:test files; see section 14
  deploy/
    nginx-la2l.conf    the snippet for the web server, as installed
    apache-la2l.conf   only if Apache is what runs
```

### 5.2 Settings

All through environment variables, read once in `config.js`, with a clear error at start when one is invalid. `.env.example` lists them all.

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | Port inside the container. |
| `HOST` | `0.0.0.0` | Inside the container. Compose publishes it on `127.0.0.1` only. |
| `DATA_DIR` | `/data` | Database and package files. |
| `PUBLIC_URL` | `https://lloydstellar.nl/la2l` | Only for logs and the README; the code never builds absolute URLs. |
| `TRUST_PROXY` | `1` | Take the client IP from the last `X-Forwarded-For` hop (section 10.2). |
| `PAIR_TTL_SECONDS` | `600` | How long a code works. |
| `POLL_MS` | `2000` | How often the device asks while a code shows. |
| `PACKAGE_TTL_HOURS` | `24` | Packages are gone this long after upload, imported or not. |
| `UPLOAD_TTL_MINUTES` | `60` | A package that is not committed by then is deleted. |
| `RESULT_TTL_DAYS` | `7` | How long an app can still read the result of a package. |
| `MAX_DEVICE_STORAGE_MB` | `1024` | Waiting packages per computer, together. |
| `MIN_FREE_DISK_MB` | `2048` | Refuse uploads below this much free disk. |
| `RATE_LIMITS` | `on` | `off` only in tests. |

### 5.3 URLs

The container serves everything under `https://lloydstellar.nl/la2l/`; the web server strips the `/la2l` prefix:

| Public | In the container | |
|---|---|---|
| `https://lloydstellar.nl/la2l/api/...` | `/api/...` | The API. The device's `serverUrl` is `https://lloydstellar.nl/la2l/api`. |
| `https://lloydstellar.nl/la2l/` | `/` | LA2L Sender, the test page. |

The Sender page uses relative URLs (`api/pair/claim`), so it works under any prefix. `https://lloydstellar.nl/la2l` (no slash) must redirect to `/la2l/`; that is the web page, not the API, so a redirect is fine there.

### 5.4 Storage

- SQLite database `DATA_DIR/la2l.db`, WAL mode, `foreign_keys = ON`, `busy_timeout = 5000`. `node:sqlite` is synchronous; at this scale that is fine. Use a transaction where two requests could race (claiming a code, committing a package).
- Package files: `DATA_DIR/packages/<package_id>/<file>`. Uploads go to `<file>.part` and are renamed only when complete and checked.
- Every path is built from values the server made or checked itself: the package id is a server UUID, and a file name is only used after it was found in the `files` table of that package. Never build a path from a raw URL segment.

### 5.5 Requests

- One small router. Unknown route: 404 `{"error": "Not found."}`. Known path, wrong method: 405 with `Allow`.
- JSON bodies: at most 1 MB, `Content-Type: application/json` (with or without `charset`), otherwise 415. Invalid JSON: 400 `{"error": "The request is not valid JSON."}`. Routes without a body accept an empty one.
- Path parameters are decoded with `decodeURIComponent` inside a try, then checked against a strict pattern before any lookup.
- Every API answer: `Content-Type: application/json; charset=utf-8` (except WAV downloads), an exact `Content-Length`, `Cache-Control: no-store`.
- CORS headers on every `/api/...` answer, and preflight handled (section 8.1).
- Node's server time-outs: `headersTimeout` 20 s; `requestTimeout` 15 minutes, because a 200 MB upload from a phone can take long; per socket, 60 seconds without data closes it.

### 5.6 Reusing the device's checks

The server requires `../../src/node/manifest.js` and `../../src/node/wav.js` (relative to `server/src/`). In the image they sit at the same relative place (section 12.1).

- `manifest.validate(raw)` returns `{ pkg, warnings }` and throws a `ManifestError` with a user-friendly message for a problem with the whole package. A problem with one sound is in `pkg.items[i].error`. The server is stricter than the device: **every** sound must be valid, and must have `bytes` and `sha256`.
- `validate` needs a `package_id`. Put the server's id into the manifest **before** you validate it.
- `wav.readInfo(path)` reads the header of a WAV file and throws a `WavError` with a short message, for example "This WAV file is compressed (format 85). Send plain PCM or float WAV." Use it on every uploaded file before you accept it.
- If either module needs a change, make it there, run the device tests (`npm test` in the root), and mention it to Erik: a device change means a new device build.

---

## 6. Data model

A starting point. Times are ISO 8601 strings in UTC (`2026-10-16T14:30:00.000Z`).

```sql
CREATE TABLE devices (
  id            INTEGER PRIMARY KEY,
  device_id     TEXT NOT NULL,              -- the random UUID the device made once; not secret
  name          TEXT NOT NULL,              -- the computer name, shown in apps
  client        TEXT NOT NULL DEFAULT '',   -- "LA2L 0.1.1"
  platform      TEXT NOT NULL DEFAULT '',   -- win32, darwin
  token_hash    TEXT NOT NULL UNIQUE,       -- sha256 hex of the device token
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  revoked_at    TEXT
);

CREATE TABLE apps (
  id            INTEGER PRIMARY KEY,
  device_ref    INTEGER NOT NULL REFERENCES devices(id),
  name          TEXT NOT NULL,              -- shown in the device: "Paired with ..."
  app_id        TEXT NOT NULL DEFAULT '',   -- the app's own id per installation; not secret
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  revoked_at    TEXT
);

CREATE TABLE pairings (
  id            INTEGER PRIMARY KEY,
  pair_hash     TEXT NOT NULL UNIQUE,       -- sha256 of pair_id
  code          TEXT NOT NULL,              -- 6 characters; unique among waiting pairings
  status        TEXT NOT NULL,              -- waiting | paired | cancelled
  device_ref    INTEGER REFERENCES devices(id),  -- set at start for Add app, or at claim
  device_id     TEXT NOT NULL,
  device_name   TEXT NOT NULL,
  client        TEXT NOT NULL DEFAULT '',
  platform      TEXT NOT NULL DEFAULT '',
  app_ref       INTEGER REFERENCES apps(id),
  app_name      TEXT,
  token_plain   TEXT,                       -- the device token, only until the device has it (section 7.3)
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  claimed_at    TEXT,
  delivered_at  TEXT
);
CREATE INDEX pairings_code ON pairings(code, status);

CREATE TABLE packages (
  id            TEXT PRIMARY KEY,           -- package_id: a server UUID
  device_ref    INTEGER NOT NULL REFERENCES devices(id),
  app_ref       INTEGER NOT NULL REFERENCES apps(id),
  title         TEXT NOT NULL,
  app_name      TEXT NOT NULL,              -- source.app from the manifest
  item_count    INTEGER NOT NULL,
  total_bytes   INTEGER NOT NULL,
  manifest      TEXT NOT NULL,              -- JSON exactly as the device will get it
  status        TEXT NOT NULL,              -- uploading | waiting | imported | partial | failed | expired | deleted
  ack           TEXT,                       -- JSON of the last ack
  created_at    TEXT NOT NULL,
  committed_at  TEXT,
  acked_at      TEXT,
  expires_at    TEXT NOT NULL,              -- created_at + PACKAGE_TTL_HOURS
  updated_at    TEXT NOT NULL
);
CREATE INDEX packages_inbox ON packages(device_ref, status);

CREATE TABLE files (
  package_id    TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  file          TEXT NOT NULL,              -- exactly as in the manifest
  bytes         INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  received      INTEGER NOT NULL DEFAULT 0, -- 1 when size, checksum and WAV header were right
  PRIMARY KEY (package_id, file)
);
```

Migrations: keep the schema version in `PRAGMA user_version` and apply numbered steps at start, inside a transaction.

---

## 7. Device API (binding)

Build these exactly as `docs/server-api.md` describes; this section adds what the document leaves open. All paths are under `/api`.

### 7.1 `GET /health`

- No token, no rate limit.
- `200 {"ok": true, "name": "la2l-server", "version": "<server/package.json version>"}`.
- If the database does not answer or `DATA_DIR` is not writable: `503 {"ok": false, "error": "The server cannot store sounds right now."}`.

### 7.2 `POST /pair/start`

- Token optional. The device sends its token when it is already paired (Settings > Add app). A valid one links this pairing to that device (`device_ref`), and the device's own token goes into `token_plain` (it was just sent to you), because the paired answer must hand back the **same** token.
- An unknown or revoked token here is treated as **no token**: start a fresh pairing, no 401. Device 0.1.1 does not forget its pairing on a 401 from this call (it only shows "Could not start pairing. This computer is no longer paired."), so a 401 would leave it stuck with a dead token. A fresh pairing replaces that token as soon as the code is claimed.
- Body `{"device_id", "device_name", "client", "platform"}`. `device_id` is required: 1 to 100 characters of `A-Z a-z 0-9 -`, else 400 `{"error": "device_id is missing."}`. Clean the others: no control characters, trimmed; `device_name` at most 64 characters (default "Computer"), `client` 40, `platform` 20.
- A new start from the same `device_id` cancels its older waiting pairings: one code per computer at a time.
- Answer `200 {"pair_id", "code", "expires_in": 600, "expires_at", "poll_ms": 2000}`.
  - `pair_id`: 32 random bytes, base64url (43 characters). Store only its sha256.
  - `code`: 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (A to Z without I and O, 2 to 9), drawn with `crypto.randomInt`; draw again while it equals a waiting code.
- Rate limit: 20 per 10 minutes per IP, then `429 {"error": "Too many codes asked. Wait a few minutes."}`.

### 7.3 `GET /pair/{pair_id}`

- No token. `pair_id` must match `^[A-Za-z0-9_-]{20,100}$`, else 404.
- Waiting and not yet expired: `{"status": "waiting"}`.
- Past `expires_at` while waiting: `{"status": "expired"}`.
- Cancelled: `{"status": "cancelled"}`.
- Paired: `{"status": "paired", "device_token": "<token_plain>", "app_name": "<name>"}`. Set `delivered_at` the first time. Keep answering the same for **60 seconds** after the first delivery, in case that answer got lost on the way; then delete the row, and later calls get 404. That is allowed by the document ("a later call may answer 404").
- Unknown: `404 {"error": "Unknown pairing."}`. The device counts that as expired.
- Rate limit: 120 per minute per IP.

### 7.4 `POST /pair/{pair_id}/cancel`

No token, no body. Status `cancelled`; `200 {"ok": true}`. Unknown: 404. The device ignores the answer.

### 7.5 `GET /inbox` (device token)

- `200 {"packages": [{"package_id", "title", "app", "items", "created_at"}]}`: the device's packages with status `waiting` or `failed` that have not expired, oldest first. `created_at` is the commit time. `items` is an integer.
- Updates `devices.last_seen_at`.

### 7.6 `GET /packages/{package_id}/manifest` (device token)

- The stored manifest: the app's JSON, with the server's `package_id`, and `bytes` and `sha256` on every sound.
- Only for this device's packages with status `waiting` or `failed`. Anything else, including another device's package: `404 {"error": "Unknown package."}`. Never reveal that a package exists for someone else.

### 7.7 `GET /packages/{package_id}/files/{file}` (device token)

- Same access rule as the manifest. The file name is looked up in `files` for this package; it must be received.
- Stream it: `200`, `Content-Type: audio/wav`, exact `Content-Length`, `Cache-Control: no-store`. No compression, no `Content-Encoding`. `HEAD` gives the same headers without the body.
- A missing file on disk while the row says received: `404 {"error": "The file is gone. Send it again."}`, and log it loudly.

### 7.8 `POST /packages/{package_id}/ack` (device token)

- Body `{"status": "imported" | "partial" | "failed", "items": [{"id", "name", "status", "error"}], "error"?, "note"?}`. Check the shape; keep at most 64 items and cut every string to 200 characters. Store the whole ack as JSON.
- `imported` or `partial`: delete the package's files now, set the status, set `acked_at`. The row stays `RESULT_TTL_DAYS` days so the app can read the result.
- `failed`: store it and set the status `failed`; keep the files until the package expires. A failed package **stays in the inbox**, so the user can try again (for example after updating LA2L).
- `{"status": "imported", "items": [], "note": "imported before"}`: the device placed it before but its first ack got lost. Treat it as imported; keep the item results of an earlier ack if there is one.
- An ack for a package that was already acked: store the new one, answer 200. Unknown or someone else's: 404.
- Answer `200 {"ok": true}`.

### 7.9 `POST /unpair` (device token)

- Body `{}`. Revoke the device token and every app token of that device. Delete its packages that are still `uploading`, `waiting` or `failed`, with their files. `200 {"ok": true}`.
- The device forgets its token even when this call fails; nothing to do for that.

---

## 8. App API (make it final)

The proposal in `docs/server-api.md` becomes this. Update the document in the same commit: the app side is then no longer a proposal. All paths under `/api`; tokens as `Authorization: Bearer la2la_...`.

### 8.1 CORS

Browser apps run on other origins (a web 808 on another site, the Sender page). Authentication is a bearer token, never a cookie, so a wildcard is safe:

- On every `/api/...` answer: `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: Content-Length`.
- `OPTIONS` on any `/api/...` path: `204` with `Access-Control-Allow-Methods: GET, HEAD, POST, PUT, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Max-Age: 600`.

### 8.2 `POST /pair/claim` (no token)

- Body `{"code", "app_name", "app_id"?}`.
- The code: uppercase it, drop spaces and dashes; it must be 6 characters of the alphabet in 7.2, else the same 404 as a wrong code.
- In one transaction, find a waiting, unexpired pairing with that code:
  - Its device: `device_ref` when the pairing came from Add app; otherwise make a new device row with a new device token (`la2ld_` + 32 random bytes in base64url), store the token's hash, and keep the token in `token_plain` until the device has it.
  - A new device row for a `device_id` that still has an active device row: revoke the old row and its apps. That computer lost its old token (for example it unpaired while offline), and apps still linked to it would send sounds nobody imports; they learn it from a 401 and pair again.
  - Its app: when `app_id` is given and that device already has an active app with the same `app_id`, revoke that one first: pairing again replaces the old token. Then a new app row with a new app token (`la2la_` + 32 random bytes in base64url).
  - The pairing: status `paired`, `app_ref`, `app_name`, `claimed_at`.
- Answer `200 {"app_token": "la2la_...", "device_name": "ERIK-PC"}`.
- Wrong, used or expired code: `404 {"error": "This code does not work. Check the code in Live."}`. The same answer for all three, so a guesser learns nothing.
- `app_name`: cleaned like a track name (letters of any language, digits, space and `_ - ( ) . ' & + # !`), 1 to 40 characters, default "App"; `cleanName(value, 'App', 40)` from `src/node/text.js` does exactly that. The device shows it: "Paired with LA2L Sender".
- Rate limit: 10 per minute per IP.

### 8.3 `GET /app/me` (app token)

`200 {"device_name", "app_name", "paired_at"}`. So an app can show "Paired with ERIK-PC" and find out it was unpaired (401). Updates `apps.last_seen_at`.

### 8.4 `POST /app/unpair` (app token)

Revokes this app token. Packages it sent stay for the device. `200 {"ok": true}`.

### 8.5 `POST /packages` (app token)

- Body: the manifest (`docs/manifest.md`), at most 1 MB.
- The server makes the `package_id` (a UUID) and puts it in the manifest, replacing whatever the app sent. Then `manifest.validate()`:
  - `ManifestError`: `422 {"error": <its message>}`.
  - A sound with `item.error`: `422 {"error": "<name> <error>"}`, for example "Kick has no valid file name".
  - A sound without `bytes` (integer above 0) or `sha256` (64 hex characters): `422 {"error": "Kick needs bytes and sha256."}`.
- Space: the device's waiting packages plus this one must stay under `MAX_DEVICE_STORAGE_MB`, and the disk must keep `MIN_FREE_DISK_MB` free after it (`fs.statfsSync`). Otherwise `507 {"error": "The server is full. Try again later."}`.
- Rate limit: 30 packages per hour per app.
- Store the package (status `uploading`, `expires_at` = now + 24 h) and one `files` row per sound.
- Answer `201 {"package_id", "upload": {"kick.wav": "/packages/<id>/files/kick.wav", ...}, "expires_at"}`. The upload paths are relative to the API base: the app puts them after `https://lloydstellar.nl/la2l/api`.
- The manifest stays as the app wrote it (plus the server's `package_id`): the device reads `name`, `kind`, `role`, `bpm`, `length_beats`, `color`, `gain_db` and `warp_mode` itself. Do not rewrite fields the server does not own.

### 8.6 `PUT /packages/{package_id}/files/{file}` (app token)

- Only the app that made the package, only while it is `uploading`, only a file named in its manifest. Otherwise 404.
- Body: the raw WAV bytes, any `Content-Type`. With a `Content-Length` larger than the declared `bytes`: `413` at once. Without one (chunked), stop at the declared size plus one byte: `413 {"error": "The file is larger than the package said."}`.
- Stream to `<file>.part` while computing sha256. At the end: size and checksum must match the manifest, else `422 {"error": "The file arrived damaged. Send it again."}`. Then `wav.readInfo()` on the `.part` file; a `WavError` gives `422 {"error": <its message>}`. Only then rename it and mark the row received.
- Sending a file again replaces it.
- Answer `200 {"ok": true, "file", "bytes"}`.
- The web server must let 210 MB through and must not buffer the body (section 12).

### 8.7 `POST /packages/{package_id}/commit` (app token)

- Every file received: status `waiting`, `committed_at` = now. `200 {"ok": true, "status": "waiting"}`. From now on the device sees it.
- Files missing: `409 {"error": "Not all files are there yet: kick.wav"}` (cut to 80 characters).
- Committing a package that is already `waiting`: 200 again.

### 8.8 `GET /packages/{package_id}/status` (app token)

- `200 {"status", "items": [{"id", "name", "status", "error"}], "updated_at"}`. The status is one of `uploading`, `waiting`, `imported`, `partial`, `failed`, `expired`. `items` comes from the last ack, or is empty.
- Only for the app that sent it, and only while the row exists (`RESULT_TTL_DAYS`). Otherwise 404.

### 8.9 `DELETE /packages/{package_id}` (app token)

While `uploading`, `waiting` or `failed`: delete the files, status `deleted`. `200 {"ok": true}`. After an import: 409 `{"error": "This package is already in Live."}`.

### 8.10 How apps should use it

Write this in `docs/server-api.md` for the Android and web developers (Erik, and Claude in those repositories):

1. Pair once: `POST /pair/claim`, keep the app token. Check it now and then with `GET /app/me`; on 401, forget it and show the pair screen.
2. Per send: `POST /packages`, then one `PUT` per file, then `POST /packages/{id}/commit`.
3. Poll `GET /packages/{id}/status` every few seconds while the app is open, until `imported`, `partial`, `failed` or `expired`. Show "Waiting for Import in Live" until then.
4. Compute `sha256` and `bytes` before uploading. Send WAV only; convert in the app.

---

## 9. Lifecycle and cleanup

One function, run at start and every 60 seconds (`setInterval(...).unref()`). Count what it removes and log one line when it removed something.

| What | When | Then |
|---|---|---|
| Waiting pairing | Past `expires_at` | It answers `expired`; delete the row 1 hour later. |
| Cancelled pairing | 1 hour after it was cancelled | Delete the row. |
| Paired pairing | 60 seconds after the first delivery | Delete the row (and `token_plain` with it). |
| Paired pairing, never delivered | 10 minutes after the claim | The device never got its token. Delete the pairing, and, when the claim created the device, that device and its app too: an app token without a computer behind it is useless, and the app learns it from a 401. |
| Package `uploading` | `UPLOAD_TTL_MINUTES` after creation | Delete files and row. |
| Package `waiting` or `failed` | Past `expires_at` (24 hours after upload) | Delete the files; status `expired`. |
| Package `imported`, `partial`, `expired`, `deleted` | `RESULT_TTL_DAYS` after the last change | Delete the row. |
| Revoked device or app | 30 days after revoking | Delete the row, when no package refers to it. |
| Anything in `DATA_DIR/packages` without a package row, and every `.part` file not being written | At start | Delete it. |

Devices that are quiet are never deleted: a computer may not import for months.

---

## 10. Security

### 10.1 Tokens, pair ids and codes

- Device token `la2ld_` and app token `la2la_`, each followed by 32 random bytes in base64url. The prefix shows at a glance which kind leaked, and lets you find one in a log that should not have it.
- Store `sha256(token)` in hex; look tokens up by hash. Parse `Authorization` with `^Bearer ([A-Za-z0-9_-]{20,200})$`; anything else counts as no token.
- A device token on an app route, or an app token on a device route, is an unknown token: 401.
- `pair_id`: 32 random bytes in base64url, stored as a hash. It is the only secret of the status call, which has no token.
- Codes: `crypto.randomInt` over the 32-character alphabet: about a billion codes, of which only a handful are valid at any time, behind a rate limit.

### 10.2 Client IP and rate limits

- The container port is only reachable through the web server, so with `TRUST_PROXY=1` take the client IP from the **last** entry of `X-Forwarded-For`. Without the header, the socket address.
- In-memory sliding windows, cleared of old keys every few minutes. `429 {"error": "..."}` with `Retry-After`.

| Route | Limit | Key |
|---|---|---|
| `POST /pair/start` | 20 per 10 minutes | IP |
| `GET /pair/{id}` | 120 per minute | IP |
| `POST /pair/claim` | 10 per minute | IP |
| `POST /packages` | 30 per hour | app |
| Everything with a token | 600 per minute | token |

### 10.3 Input

- Every string from a request is checked for type and length before use. Names are cleaned: no control characters.
- Only JSON and WAV bodies are accepted, each with its own size limit.
- The Sender page gets `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

### 10.4 Logs

- One line per request on stdout: time, method, the **route pattern** (`/api/pair/:id`, never the real path with a pair id), status, milliseconds, bytes in and out, the internal device or app number, the client IP.
- One line per event: pairing started, claimed, delivered; package created, committed, acked (with the status); cleanup counts.
- Never a token, a pair id, a code, an `Authorization` header or a request body. Docker keeps the log (rotation in `compose.yaml`).

---

## 11. LA2L Sender, the test page

A small page at `https://lloydstellar.nl/la2l/` so Erik can test the whole chain from a browser, before any app exists. It is also the reference client for the app API. Plain HTML, CSS and JavaScript in `server/public/`, no build step, no external scripts or fonts (the CSP allows only the page itself). English, simple and clear, large buttons, readable on a phone.

**Header**: the LA2L logo (`src/ui/la2l-logo.png`, copied into the image), "LA2L Sender", one line: "A test page that sends sounds to the LA2L device in Ableton Live."

**Step 1, Pair**

- Without a token in `localStorage`: one field for the code (accepts `K7P 42Q`, `k7p42q`, `K7P-42Q`) and a **Pair** button. It sends `POST api/pair/claim` with `app_name` "LA2L Sender" and an `app_id`: a UUID made once and kept in `localStorage`.
- Done: "Paired with ERIK-PC" and an **Unpair this browser** button (`POST api/app/unpair`, then forget the token).
- At load with a token: `GET api/app/me`; a 401 forgets the token and shows step 1 again.
- Errors show the server's text: "This code does not work. Check the code in Live."

**Step 2, Send sounds** (only when paired)

- Package: **Title** (default "Sender test") and **BPM** (optional, 20 to 999).
- **Choose WAV files** (several at once, `accept=".wav,audio/wav,audio/x-wav"`). One row per file:
  - **Name** (from the file name, at most 40 characters), **Loop / One-shot**, **Role** (none, drums, bass, melodic, vocal, texture, fx), **BPM** (optional, overrides the package), **Length in beats** (optional), **Colour** (optional).
  - The page reads the first 12 bytes: no `RIFF....WAVE` means "This is not a WAV file", before anything is sent.
  - `sha256` with `crypto.subtle.digest` over the whole file; `bytes` from `file.size`.
- **Send**: `POST api/packages`, then each file with `XMLHttpRequest` `PUT` and a progress bar per file, then `POST .../commit`.
- Then the status: "Waiting for Import in Live", polled every 2 seconds, until "In Live: 2 of 2 sounds" or the error per sound from the ack.
- **Send more** clears the form.

**Recent**: the last 10 packages from this browser (`localStorage`), each with its current status and a refresh button.

---

## 12. Docker and the web server

### 12.1 `server/Dockerfile` (starting point)

```dockerfile
# Build context: the repository root (see compose.yaml). The server reuses the device's
# package and WAV checks from src/node, so they must be in the image too.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY src/node ./src/node
COPY src/ui/la2l-logo.png ./server/public/la2l-logo.png
COPY server/package.json ./server/
COPY server/src ./server/src
COPY server/public ./server/public
WORKDIR /app/server
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
```

Add a root `.dockerignore` (`.git`, `node_modules`, `devices`, `tests`, `tools`, `server/test`, `**/.env`, `docs`) so the context stays small.

### 12.2 `server/compose.yaml`

```yaml
services:
  la2l-server:
    build:
      context: ..
      dockerfile: server/Dockerfile
    image: la2l-server:local
    container_name: la2l-server
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - la2l-data:/data
    read_only: true
    tmpfs:
      - /tmp
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

volumes:
  la2l-data:
```

`.env` is made from `.env.example` on the VPS and never committed (it holds no secrets now, but it is the place for them later).

### 12.3 nginx

In the `server { ... }` block that serves `lloydstellar.nl` on port 443. `^~` makes this win over the site's own regular-expression locations (WordPress and the like):

```nginx
location = /la2l { return 301 /la2l/; }

location ^~ /la2l/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 210m;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;
    gzip off;
}
```

Back up the file first, then `nginx -t`, then `systemctl reload nginx`. Keep a copy of the snippet in `server/deploy/nginx-la2l.conf`.

### 12.4 Apache

In the `<VirtualHost *:443>` for `lloydstellar.nl`, with `mod_proxy`, `mod_proxy_http` and `mod_headers`:

```apache
RedirectMatch 301 ^/la2l$ /la2l/
ProxyPass        /la2l/ http://127.0.0.1:8787/ timeout=900
ProxyPassReverse /la2l/ http://127.0.0.1:8787/
RequestHeader set X-Forwarded-Proto "https"
<Location /la2l/>
    LimitRequestBody 220200960
    SetEnv no-gzip 1
</Location>
```

Then `apachectl configtest` and a graceful reload. If the site's `.htaccess` (WordPress) still catches `/la2l/`, add `RewriteRule ^la2l/ - [L]` at the top of its rules.

### 12.5 Control panels

Plesk ("Additional nginx directives" per domain), cPanel, DirectAdmin and HestiaCP overwrite hand-edited configs. Use the panel's own place for extra directives, and tell Erik where it is.

### 12.6 Check

```bash
curl -sS https://lloydstellar.nl/la2l/api/health          # {"ok":true,"name":"la2l-server",...}
curl -sSI https://lloydstellar.nl/la2l/ | head -3          # 200, text/html, the Sender page
curl -sSI https://lloydstellar.nl/ | head -3               # the website, unchanged
curl -sSI http://lloydstellar.nl/test/test-file-voor-max.wav | head -3   # still served
```

---

## 13. GitHub

### 13.1 Pushing from the VPS

**Decided with Erik on 2026-10-16:** the VPS already has `gh` logged in as lloydstellar (https, scopes `repo` and `workflow`), so the clone pushes and opens pull requests through `gh`. There is no deploy key. A deploy key only limits access while no broader login is on the machine. The steps below are for a VPS without `gh`.

Use a **deploy key** for this one repository, so the VPS can push here and nowhere else. If Erik already had you set one up to clone the repository, check that it has write access and skip to the last step.

1. `ssh-keygen -t ed25519 -C "la2l VPS" -f ~/.ssh/la2l_deploy -N ""`
2. Show Erik the public key (`cat ~/.ssh/la2l_deploy.pub`) and ask him to add it on GitHub: the repository, **Settings > Deploy keys > Add deploy key**, with **Allow write access** on.
3. `~/.ssh/config`:
   ```
   Host github-la2l
     HostName github.com
     User git
     IdentityFile ~/.ssh/la2l_deploy
     IdentitiesOnly yes
   ```
4. `git remote set-url origin git@github-la2l:lloydstellar/Lloyds-app2live.git`, then `git fetch` to check.

Work on a branch (for example `server-v1`), push, and open a pull request per phase, unless Erik says he wants commits on `main` directly. With only a deploy key you cannot open pull requests from the VPS; then push the branch and give Erik the link to open one (`https://github.com/lloydstellar/Lloyds-app2live/compare/server-v1`), or ask him for `gh auth login`.

### 13.2 Tests on every push

`.github/workflows/test.yml`: on push and pull request, Node 24 (`actions/setup-node`), then `npm test` in the root (device) and `npm test` in `server/`. Add a `docker build -f server/Dockerfile .` step so a broken Dockerfile shows up before it reaches the VPS.

### 13.3 Images on GitHub (optional, later)

Docker images can live on GitHub too, in the GitHub Container Registry (`ghcr.io`). A second workflow can build the image on every push to `main` and publish it as `ghcr.io/lloydstellar/la2l-server` with the built-in `GITHUB_TOKEN` (`permissions: packages: write`); the VPS then pulls it instead of building. For one VPS, building on the VPS from the repository is simpler, so do this only when Erik asks. An image on ghcr.io has its own visibility setting, separate from the repository; publishing an image, or making one public, is something to ask Erik about first.

---

## 14. Tests

`npm test` in `server/` runs `node --test "test/*.test.js"`. Start the server in the test process on port 0, with a fresh temporary `DATA_DIR`, `RATE_LIMITS=off` (except in the rate-limit test) and short times where a test needs them.

### 14.1 The server itself

- Every route of sections 7 and 8: the right answer, and every error code listed there.
- 401 only for unknown or revoked tokens; a device token on an app route is 401; the wrong package for a token is 404.
- CORS: preflight and headers.
- Pairing: start, claim, waiting, paired with the same token twice within 60 seconds, then 404; Add app hands back the same device token; a revoked token on `pair/start` gives a fresh pairing and a new token; one code per computer; an expired code; re-pairing an `app_id` revokes the old app token; a fresh pairing for a known `device_id` revokes the old device and its apps.
- Uploads: wrong checksum, too large (with and without `Content-Length`), not a WAV (a text file, a compressed WAV), a file that is not in the manifest, commit with a file missing.
- Ack: `imported` deletes files; `failed` keeps the package in the inbox; "imported before".
- Cleanup with short times: every row of the table in section 9.
- Restart: close and reopen with the same `DATA_DIR`; pairings and waiting packages are still there.
- Disk and storage limits (set them very low in the test).
- No token, pair id or code in the log: capture stdout during a full pairing and package run and search it.

### 14.2 The device's own client against the server

Use the device's `Server` class from `src/node/server.js` (with `http.js`) on the real server: `pairStart`, `pairStatus`, `inbox`, `manifest`, `downloadFile` (checks bytes and sha256), `ack`, `unpair`. This proves device 0.1.1 can talk to it.

### 14.3 End to end with the real device code

Copy the `device()` helper from `tests/app.test.js`: the device's controller (`src/node/app.js`) with the simulated Live (`tests/mock-live.js`, which runs the real v8 script), pointed at your server with `serverUrl: 'http://127.0.0.1:<port>/api'` (the device allows plain http only for localhost). Then:

1. `d.app.handle('pair')`; the code is in `d.last('code')` (for example `['K7P', '42Q']`).
2. `POST /api/pair/claim` with that code, as the Sender would.
3. Wait for `d.view() === 'paired'`.
4. Send a package through the app API: two sounds made with `buildWav16` and `makeLoop` from `src/node/wav.js` and `src/node/testsound.js`, one loop and one one-shot.
5. `d.app.handle('import')`. The status line says "<title>: 2 tracks imported."; the simulated Live has the two new tracks; the loop plays at its tempo (`d.mock.clipTempo`).
6. `GET /api/packages/{id}/status` says `imported`, and the files are gone from `DATA_DIR`.
7. `d.app.handle('unpair')` twice (the device asks to click again); the app token now gets 401.

### 14.4 The device tests stay green

`npm test` in the repository root after every change to `src/node`, and before every push.

---

## 15. Phases

Every phase ends with: all tests green (server and device), a commit on the branch, a push, the new version running on the VPS, and a short Dutch message to Erik that says what to test and what he should see. Then wait for him.

| Phase | Build | Erik tests |
|---|---|---|
| **0. Look** | Section 4. No changes. | Answers your questions: Docker, web server, GitHub key. |
| **1. Online** | Skeleton, config, `/api/health`, a placeholder Sender page, Dockerfile, compose, the web server snippet. | `https://lloydstellar.nl/la2l/api/health` in a browser shows `{"ok":true,...}`. In Live: **Settings > Self test** shows "... / server OK / not paired". The website and the test file still work. |
| **2. Pairing** | Database, device pairing routes, `/pair/claim`, `/app/me`, `/app/unpair`, `/unpair`, step 1 of the Sender page. | **Pair app** in Live shows a code. On `https://lloydstellar.nl/la2l/` he types it: Live says "Paired with LA2L Sender", the page says "Paired with <his computer>". **Self test** says "server OK / paired with 0 waiting". **Settings > Add app** with a second browser works. **Unpair** in Live: the page notices at its next load. |
| **3. Sounds** | Packages, uploads, inbox, manifest, files, ack, status, step 2 of the Sender page. | On the page: the test file (save `http://lloydstellar.nl/test/test-file-voor-max.wav` first) as **Loop**, **drums**, **135** BPM. **Import** in Live: a track "Snare (LA2L Sender)", BPM 135.00. The page says "In Live". Three files at once give three tracks. A non-WAV file is refused by the page. |
| **4. Solid** | Cleanup, rate limits, storage limits, logs, restart safety, the tests of section 14. | Restart the container (`docker compose restart`): still paired, a waiting package still imports. |
| **5. Finished** | `docs/server-api.md` final, `server/README.md`, `server/CLAUDE.md` with the real commands, the GitHub Actions workflow. | The Actions tab on GitHub shows green. |

---

## 16. Working with Erik

- Erik writes Dutch: answer in Dutch. Short, the answer first, then what he must do. Code, comments, commit messages, docs, API texts and the Sender page are English.
- Find out what you can on the VPS yourself; ask only what only he knows or decides.
- Always ask first before: installing system packages (Docker), changing the web server or a control panel, touching the firewall, other sites or other containers, deleting anything outside this repository and the server's volume, making the repository public, publishing images.
- Back up a config file before you change it, and say where the backup is.
- Show evidence: the `curl` output, the number of passing tests, the commit.
- When the device must change for the server (it should not), explain why first: a device change needs a new device version and a test in Live (see `CLAUDE.md`).
- Never put a token, a password or a deploy key in the repository, a commit message, a log or a message to Erik.

---

## 17. Done means

- Erik pairs from the Sender page, sends sounds, clicks Import in Live, and the sounds are there at the right tempo. The page says "In Live".
- Device 0.1.1 works unchanged: Self test says "server OK".
- The website on lloydstellar.nl works as before, and so does the test file.
- All tests are green, locally and on GitHub.
- `docs/server-api.md` describes the final API; `server/README.md` explains running, updating, backing up and reading the logs; `server/CLAUDE.md` has the real commands.

---

## Appendix A: what Erik sees in the device

The status line of the device, for each server behaviour, so you can tell him what to expect:

| When | The device says |
|---|---|
| Self test, `/health` answers `{"ok": true}` | `Self test: Node v22... / folder OK / Live 12.4.6 OK / ... / server OK / not paired` |
| Self test, `/health` is a web page, a 404, or JSON without `"ok": true` | `... / no App2Live server at lloydstellar.nl / ...` |
| Self test, no connection / time-out / bad certificate | `server offline` / `server no answer` / `server certificate problem` |
| Self test while paired | `... / server OK / paired with 2 waiting` (the number of inbox packages) |
| Pair app | `Asking the server for a code...`, then the code and `This code works for 9:59` |
| `pair/start` fails | `Could not start pairing.` followed by the device's message and your `error` text |
| Paired | `Paired with LA2L Sender. Send a sound from it and click Import.` |
| Import, empty inbox | `Nothing new yet. Send a sound from your app first.` |
| Import | `<title>: downloading 1 of 2...`, then `<title>: placing 2 sounds in Live...`, then `<title>: 2 tracks imported.` |
| Any 401 | `This computer is no longer paired. Click Pair app to pair again.` |
| Unpair (clicked twice) | `Unpaired. Apps can no longer send sounds to this computer.` |

## Appendix B: a pairing by hand

```bash
BASE=https://lloydstellar.nl/la2l/api
curl -sS $BASE/health
curl -sS -X POST $BASE/pair/start -H 'Content-Type: application/json' \
  -d '{"device_id":"curl-test","device_name":"curl","client":"curl","platform":"linux"}'
#   -> {"pair_id":"...","code":"K7P42Q","expires_in":600,...}
curl -sS -X POST $BASE/pair/claim -H 'Content-Type: application/json' \
  -d '{"code":"K7P 42Q","app_name":"curl app","app_id":"curl-1"}'
#   -> {"app_token":"la2la_...","device_name":"curl"}
curl -sS $BASE/pair/<pair_id>
#   -> {"status":"paired","device_token":"la2ld_...","app_name":"curl app"}
curl -sS $BASE/inbox -H "Authorization: Bearer la2ld_..."
#   -> {"packages":[]}
curl -sS -X POST $BASE/unpair -H "Authorization: Bearer la2ld_..." -H 'Content-Type: application/json' -d '{}'
```
