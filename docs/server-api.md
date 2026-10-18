# App2Live server API

This is the contract between the LA2L device and the App2Live server. The first part (the device side) is implemented in `src/node/server.js` and simulated in `tests/mock-server.js`; a server that follows it works with the device as it is. Device 0.1.1 uses every device call except `GET /apps`, which came with device 0.2.0 and la2l-server 0.6.0, and `DELETE /apps/{id}`, which came with la2l-server 0.7.0 for a later device. The test receiver (`https://lloydstellar.nl/la2l/receiver`) uses the device side too. The second part (the app side) is what apps use; it is final and served by `server/` (la2l-server).

For machines: the app side is also [openapi.yaml](openapi.yaml) (OpenAPI 3.1), and the manifest [app2live-1.schema.json](app2live-1.schema.json) (JSON Schema). Tests keep both in line with the server.

## Basics

- Base address: `https://lloydstellar.nl/la2l/api` (the `serverUrl` setting). The device only talks `https`, except to `localhost`, `127.0.0.1` and `[::1]` for testing.
- Requests and answers are JSON (`Content-Type: application/json`), except the WAV downloads.
- Calls marked **token** send `Authorization: Bearer <device_token>`.
- **401 means the token is unknown or revoked.** The device then forgets its pairing and shows Pair app again. Use 401 for nothing else. A 403 (for example from a firewall) does not unpair the device.
- Errors may carry `{"error": "short text"}`. For 4xx answers other than 401, the device shows that text (letters, digits and simple punctuation, at most 80 characters) after its own message, so keep it short and in plain English. Device 0.1.1 does this for JSON calls only and shows only its own message when a file download fails; 0.2.0 does it for file downloads too.
- Redirects are followed only to the same origin (scheme, host and port), at most 3.
- Time limits on the device: 15 seconds per JSON call, 10 minutes per file with at most 20 seconds without data. A JSON answer may be 1 MB at most.

## Device side (implemented)

### `GET /health`

No token. Used by Self test.

```json
{ "ok": true, "name": "la2l-server", "version": "0.9.0" }
```

The device only looks at `"ok": true`. When the server cannot store sounds (for example when its data folder is not writable), it answers `503` with `{"ok": false, "error": "The server cannot store sounds right now."}`.

### `POST /pair/start`

Starts pairing. The token is sent along when this computer is already paired (Settings > Add app); the new app must then be linked to the **same** token, so the computer keeps one token for all its apps. An unknown or revoked token is treated as no token: the server starts a fresh pairing, and the device gets a new token when the code is claimed. (Device 0.1.1 does not unpair itself on a 401 from this call, so a 401 here would leave it stuck.)

Request:

```json
{ "device_id": "0b6c4c58-1f0e-4a5e-9d64-0c7f2c1e8a10", "device_name": "STUDIO-PC", "client": "LA2L 0.1.1", "platform": "win32" }
```

`device_id` is a random UUID made once per computer. `device_name` is the computer name, to show in the app.

A test receiver, which stands in for Live while a developer tests an app, also sends `"test": true` (la2l-server 0.7.0). The server then marks the computer it makes as a test receiver, and removes it with its apps and packages after 7 days without a call. Only `true` counts, and only when the start makes a new computer; Add app keeps what the computer is.

Answer:

```json
{ "pair_id": "5d1f...", "code": "K7P42Q", "expires_in": 600, "expires_at": "2026-10-16T15:00:00Z", "poll_ms": 2000 }
```

- `code`: 6 characters from `A-Z` and `2-9` without the look-alikes `0 O 1 I`. The device shows it as `K7P 42Q`. Valid for 10 minutes, usable once.
- `expires_in` in seconds is what the device counts down from (it does not trust the computer's clock); it keeps it between 30 and 1800. `expires_at` is only used when `expires_in` is missing.
- `poll_ms`: how often the device asks for the status, 500 to 10000. Default 2000.
- `pair_id` is a long random id, known only to the device. The status call below has no token, so `pair_id` must not be guessable.
- One code per computer: a new start with the same `device_id` cancels its older code.
- `device_id` is required: 1 to 100 characters of `A-Z a-z 0-9 -`, else `400 {"error": "device_id is missing."}`. At most 20 starts per 10 minutes from one address, then 429.

### `GET /pair/{pair_id}`

No token. The device asks this every `poll_ms` while the code shows.

```json
{ "status": "waiting" }
{ "status": "paired", "device_token": "c1a8...", "app_name": "Web808" }
{ "status": "expired" }
{ "status": "cancelled" }
```

- `device_token`: a long random secret. Give it out once: after the first `paired` answer, delete the pairing record (a later call may answer 404). la2l-server gives the same `paired` answer for 60 seconds after the first one, in case that answer got lost, and answers 404 after that.
- `app_name`: shown in the device as "Paired with Web808".
- 404 counts as expired. At most 120 calls a minute from one address, then 429.

### `POST /pair/{pair_id}/cancel`

No token, no body. The code stops working. The answer is ignored; la2l-server answers `{"ok": true}`, or 404 for an unknown pairing.

### `GET /inbox`  (token)

The packages that are waiting for this computer.

```json
{
  "packages": [
    { "package_id": "7f3c2a9e-1b4d-4c8e-9a51-0d2e6f7b8c90", "title": "Treinbeat", "app": "Web808", "items": 5, "created_at": "2026-10-16T14:30:00Z" }
  ]
}
```

`package_id` must match `[A-Za-z0-9._-]{1,100}`; other entries are skipped. The device imports the packages oldest first, by `created_at` (ISO 8601, UTC).

la2l-server lists the packages that are committed and wait, and those whose import failed, until they expire. `created_at` is the time of the commit.

### `GET /apps`  (token)

Device 0.2.0 and la2l-server 0.6.0 and newer. The apps that can send to this computer now, oldest pairing first.

```json
{
  "apps": [
    { "id": "3f9c1e0a7b2d4c6e8f1a2b3c4d5e6f70", "name": "LA2L Sender", "paired_at": "2026-10-17T10:30:00.000Z", "last_seen_at": "2026-10-17T10:41:12.000Z" }
  ]
}
```

- An app that unpaired itself (`POST /app/unpair`), or that paired again with the same `app_id` (which replaces its old token), is not in the list. One name can be in it twice: the same app in two browsers.
- `last_seen_at`: the last call of that app, at most a minute off; `null` when it made none yet.
- The device asks this when Live loads it, after every Import and in Self test. From device 0.2.2 it also asks every 15 seconds while an app can send to this computer and no code shows, so Pair app comes back within 15 seconds after the last app unpaired itself: 4 calls a minute per computer. It shows every name once ("Paired with LA2L Sender and Robot Voice."). For an empty list it shows Pair app again instead of Import (device 0.2.1; 0.2.0 kept Import and said "No app paired. Add one in Settings."). It keeps its token then, so Pair app adds an app to the same computer, and packages that still wait come in with the next Import. Self test says `paired with 2 apps` or `no app paired`.
- A server without this call answers 404. The device then keeps the names it learned when pairing, and Self test says `paired`.
- `id` (la2l-server 0.7.0): 32 random hex characters, for `DELETE /apps/{id}`. It is not the app's own `app_id` and says nothing about the app. Devices before it ignore it.

### `DELETE /apps/{id}`  (token)

la2l-server 0.7.0, for a later device version. One app of this computer stops: for a token that leaked, or an app nobody wants any more. The server revokes that app token, so the app gets a 401, and deletes that app's packages that still upload or wait, with their files. The computer and its other apps stay paired; an empty `GET /apps` after it is fine.

- `200 {"ok": true}`.
- An unknown id, an app that is gone already, or an app of another computer: `404 {"error": "Unknown app."}`.

### `GET /packages/{package_id}/manifest`  (token)

The package description, see [manifest.md](manifest.md). la2l-server sends it as the app sent it, with its own `package_id`, and `bytes` and `sha256` on every sound. Only for this computer's packages that wait or failed and have not expired; anything else, also a package of another computer, gets `404 {"error": "Unknown package."}`.

### `GET /packages/{package_id}/files/{file}`  (token)

The bytes of one WAV file. `{file}` is the `file` field of the sound in the manifest, URL-encoded. Send `Content-Length` when possible: the device refuses a file larger than the `bytes` in the manifest, checks `bytes` and `sha256` after the download, and retries up to 3 times (after 1, 2 and 4 seconds) when the connection breaks, the checksum is wrong, or the server answers 5xx. A 404 is not retried.

la2l-server sends `Content-Type: audio/wav` and the exact `Content-Length`, never compressed; `HEAD` gives the same headers without the file. A name that is not in the manifest gets `404 {"error": "Unknown file."}`, and a file that is missing on the server `404 {"error": "The file is gone. Send it again."}`.

### `POST /packages/{package_id}/ack`  (token)

The device says what happened to a package.

```json
{
  "status": "partial",
  "items": [
    { "id": "kick", "name": "Kick", "status": "imported" },
    { "id": "robot", "name": "Robot hallo", "status": "failed", "error": "is not a usable WAV: This WAV file is compressed (format 85). Send plain PCM or float WAV." }
  ]
}
```

- `status`: `imported` (all sounds placed), `partial` (some placed) or `failed` (none placed). `failed` may carry an `error` for the whole package, for example when the manifest uses a newer schema.
- On `imported` and `partial`: delete the package and its files. The app can show the result per sound.
- On `failed`: keep the package until it expires, so the user can try again (for example after updating LA2L).
- A package the device imported before (because an earlier ack got lost) is confirmed again with `{"status": "imported", "items": [], "note": "imported before"}` and is not placed twice.
- Network trouble while downloading stops the import without an ack; the package stays and is tried again at the next Import.
- la2l-server answers `{"ok": true}`, and 404 for a package that is not this computer's. It keeps at most 64 sounds of an ack and 200 characters of every text. Another `status` is a 400. A `failed` for a package that is already in Live is ignored.

### `POST /unpair`  (token)

Body `{}`. Revoke the token: no app can send to this computer any more. The server also revokes every app token of this computer and deletes the packages that were still waiting for it. The device forgets the token even when this call fails.

## Retention and limits

- A package is deleted after an `imported` or `partial` ack, and at the latest **24 hours** after upload, whether it was imported or not. A shorter time (for example 12 hours) is fine; the device does not depend on it. la2l-server deletes the files at once after the ack and keeps the result for the app for 7 days. An upload that is not committed within an hour is deleted.
- la2l-server never removes a paired computer because it is quiet: a computer may not import for months. Unpaired computers and apps are removed 30 days after the unpair. A test receiver (`"test": true` at `POST /pair/start`) is the exception: after 7 days without a call it is removed with its apps and packages.
- A package has at most **32 sounds** and **200 MB** in total. Only WAV (PCM 8/16/24/32-bit or float 32/64-bit, mono or stereo, 8 to 192 kHz). The device checks this too; la2l-server refuses anything else at upload.
- Pairing: at most 10 code attempts per minute from one address (an IPv6 address counts by its /64), because a code is short.

## App side

For the Android and web apps, and for LA2L Sender, the test page at `https://lloydstellar.nl/la2l/`, which is the reference client (`server/public/sender.js`). Same base address; apps send `Authorization: Bearer <app_token>`.

- **401 means this app token is unknown or revoked**: the computer was unpaired in Live, or the app paired again. Forget the token and show the pair screen.
- **CORS**: every answer under `/api/` has `Access-Control-Allow-Origin: *`, and an `OPTIONS` preflight gets a 204, so a web app on any site can call the API. A web app can read `Content-Length` and `Retry-After`. The token always goes in the `Authorization` header, never in a cookie or a URL.
- **`X-LA2L-Client`** (optional, la2l-server 0.7.0): which SDK and app make the call, for example `la2l-js/0.1.0 (Web808)`. The SDKs send it with every call. The server writes it, cut at 100 characters, on the log line of the request and keeps the last one per app, so it is known which versions still run before anything is ever phased out. The preflight allows it.
- Errors are `{"error": "short plain English"}`, at most 80 characters. Show the text to the user as it is.
- JSON bodies are objects of at most 1 MB with `Content-Type: application/json`. Otherwise: 413 when larger, 415 for another type, 400 when it is not valid JSON or not an object. A call without a body may send none. An unknown path gets `404 {"error": "Not found."}`, a known path with another method 405 with `Allow`. A 500 (`"The server has a problem. Try again later."`) means a problem in the server; try again later.
- Every caller with a token may make 600 calls a minute; then 429 with `Retry-After` (in seconds).

### `POST /pair/claim`

No token. Links the app to the computer that shows the code.

```json
{ "code": "K7P 42Q", "app_name": "Web808", "app_id": "8f1c0e2a-..." }
```

- `code`: as the user typed it. Case, spaces and dashes do not matter.
- `app_name`: the device shows it: "Paired with Web808". 1 to 40 characters; letters of any language, digits, space and `_ - ( ) . ' & + # !`, anything else becomes a space. Default "App".
- `app_id`: optional, the app's own id for this installation (at most 100 characters; a UUID made once is best). Pairing again with the same `app_id` revokes the old token of that installation.

Answer:

```json
{ "app_token": "la2la_...", "device_name": "STUDIO-PC" }
```

A wrong, used or expired code: `404 {"error": "This code does not work. Check the code in Live."}`, the same answer for all three. At most 10 tries a minute from one address, then 429.

### `GET /app/me`  (app token)

```json
{ "device_name": "STUDIO-PC", "app_name": "Web808", "paired_at": "2026-10-16T14:30:00.000Z" }
```

So the app can show "Paired with STUDIO-PC". Ask this now and then, for example when the app starts; a 401 means it was unpaired.

### `POST /app/unpair`  (app token)

Body `{}` or none. Revokes this app token. The packages the app sent stay for the computer. Answer `{"ok": true}`.

### Packages

How an app sends sounds. LA2L Sender (`server/public/sender.js`) does exactly this.

1. Pair once with `POST /pair/claim` and keep the app token. Check it now and then with `GET /app/me`; on a 401, forget it and show the pair screen.
2. Per send: `POST /packages` with the manifest, then one `PUT` per file, then `POST /packages/{package_id}/commit`.
3. While the app is open, ask `GET /packages/{package_id}/status` every few seconds until it says `imported`, `partial`, `failed` or `expired`. Until then, show "Waiting for Import in Live".
4. Work out `bytes` and `sha256` of every file before you upload it. Send WAV only; convert in the app.

### `POST /packages`  (app token)

The manifest, see [manifest.md](manifest.md), at most 1 MB. The server gives the package its own `package_id` (one the app put there is replaced) and checks it as the device does, but stricter: every sound must be valid and must have `bytes` and `sha256`.

```json
{
  "package_id": "7f3c2a9e-1b4d-4c8e-9a51-0d2e6f7b8c90",
  "upload": { "kick.wav": "/packages/7f3c2a9e-1b4d-4c8e-9a51-0d2e6f7b8c90/files/kick.wav" },
  "expires_at": "2026-10-17T14:30:00.000Z",
  "warnings": []
}
```

- `201`. The `upload` paths go after the base address; a file name with a space comes URL-encoded (`my%20kick.wav`).
- `warnings`: what the device takes but ignores, for example `Kick: role "drum" unknown`, or `Hit: bpm and length_beats only apply to a loop` (Live plays a one-shot as it is, without warp). The package goes ahead; fix them in the app.
- Upload the files and commit within an hour; after that the package is gone. `expires_at` is when the package is deleted: 24 hours after this call, imported or not.
- `422` with the reason when the device would refuse the package or a sound: `"The package has no sounds."`, `"This package uses app2live/2. Update LA2L to import it."`, `"Kick has no valid file name"`, `"Kick needs bytes and sha256."`, `"The package is 201 MB. LA2L takes 200 MB at most."`.
- `507 {"error": "Too many sounds wait for this computer. Click Import in Live first."}` when this package would bring what waits for this computer above 1 GB.
- `507 {"error": "Too many sounds wait from this address. Try again later."}` when the packages sent from this address (an IPv6 address counts by its /64) would hold more than 2 GB together while they upload or wait, whichever computers they are for. la2l-server keeps a keyed hash of the address with a package only until its files are deleted. The key lives only in the memory of the running server, so a restart forgets who sent what, as it forgets the rate limits.
- `507 {"error": "The server is full. Try again later."}` when all packages together would pass the server's limit (`MAX_TOTAL_STORAGE_MB`), or its disk is nearly full.
- At most 30 packages an hour per app, then 429.

### `PUT /packages/{package_id}/files/{file}`  (app token)

The bytes of one WAV file, with any `Content-Type`, up to 200 MB. Only for a file of this package, before the commit.

- `200 {"ok": true, "file": "kick.wav", "bytes": 1693484}`.
- The server checks the size and `sha256` against the manifest, and the WAV header as the device does. Damaged on the way: `422 {"error": "The file arrived damaged. Send it again."}`. Not a WAV Live can use: `422` with the device's text, for example `"This WAV file is compressed (format 85). Send plain PCM or float WAV."`.
- Larger than the manifest said: `413 {"error": "The file is larger than the package said."}`, at once when `Content-Length` says so.
- `507 {"error": "The server is full. Try again later."}` when the disk fills up during the upload.
- Sending a file again replaces it. One upload per file at a time: a second one meanwhile gets 409.
- 404 for a file that is not in the package, a package that is committed or deleted, and an upload that took longer than an hour: `"The upload took too long. Send the package again."`, or `"Unknown package."` once the cleanup has removed it, within a minute after that hour.

### `POST /packages/{package_id}/commit`  (app token)

Body `{}` or none. Every file is there: from now on the device sees the package.

- `200 {"ok": true, "status": "waiting"}`. Committing again answers 200 with the status the package has now.
- Files missing: `409 {"error": "Not all files are there yet: kick.wav, robot.wav"}`.
- An hour after `POST /packages` the upload is gone: `404 {"error": "The upload took too long. Send the package again."}`, and `404 {"error": "Unknown package."}` once the cleanup has removed it.

### `GET /packages/{package_id}/status`  (app token)

```json
{
  "status": "partial",
  "items": [
    { "id": "kick", "name": "Kick", "status": "imported" },
    { "id": "robot", "name": "Robot hallo", "status": "failed", "error": "is not a usable WAV: This WAV file is compressed (format 85). Send plain PCM or float WAV." }
  ],
  "updated_at": "2026-10-16T14:31:05.000Z"
}
```

- `status`: `uploading`, `waiting`, `imported` (every sound is in Live), `partial` (some are), `failed` (none are; the package stays in the inbox, so a later Import can still bring it in) or `expired`.
- `items`: per sound what the device said in its ack, empty until then. `error`: why the package as a whole failed, when the device said so.
- Only for the app that sent the package, for 7 days. After that, and for anyone else: 404.

### `DELETE /packages/{package_id}`  (app token)

Takes a package back with its files, until it is in Live: `200 {"ok": true}`. After an import: `409 {"error": "This package is already in Live."}`.
