# App2Live server API

This is the contract between the LA2L device and the App2Live server, as version 0.1.1 of the device uses it. The first part (the device side) is implemented in `src/node/server.js` and simulated in `tests/mock-server.js`; a server that follows it works with the device as it is. The second part (the app side) is a proposal for when the server is built.

## Basics

- Base address: `https://lloydstellar.nl/la2l/api` (the `serverUrl` setting). The device only talks `https`, except to `localhost`, `127.0.0.1` and `[::1]` for testing.
- Requests and answers are JSON (`Content-Type: application/json`), except the WAV downloads.
- Calls marked **token** send `Authorization: Bearer <device_token>`.
- **401 means the token is unknown or revoked.** The device then forgets its pairing and shows Pair app again. Use 401 for nothing else. A 403 (for example from a firewall) does not unpair the device.
- Errors may carry `{"error": "short text"}`. For 4xx answers other than 401, the device shows that text (letters, digits and simple punctuation, at most 80 characters) after its own message, so keep it short and in plain English.
- Redirects are followed only to the same origin (scheme, host and port), at most 3.
- Time limits on the device: 15 seconds per JSON call, 10 minutes per file with at most 20 seconds without data. A JSON answer may be 1 MB at most.

## Device side (implemented)

### `GET /health`

No token. Used by Self test.

```json
{ "ok": true, "name": "la2l-server", "version": "0.1.0" }
```

The device only looks at `"ok": true`. When the server cannot store sounds (for example when its data folder is not writable), it answers `503` with `{"ok": false, "error": "The server cannot store sounds right now."}`.

### `POST /pair/start`

Starts pairing. The token is sent along when this computer is already paired (Settings > Add app); the new app must then be linked to the **same** token, so the computer keeps one token for all its apps. An unknown or revoked token is treated as no token: the server starts a fresh pairing, and the device gets a new token when the code is claimed. (Device 0.1.1 does not unpair itself on a 401 from this call, so a 401 here would leave it stuck.)

Request:

```json
{ "device_id": "0b6c4c58-1f0e-4a5e-9d64-0c7f2c1e8a10", "device_name": "ERIK-PC", "client": "LA2L 0.1.1", "platform": "win32" }
```

`device_id` is a random UUID made once per computer. `device_name` is the computer name, to show in the app.

Answer:

```json
{ "pair_id": "5d1f...", "code": "K7P42Q", "expires_in": 600, "expires_at": "2026-10-16T15:00:00Z", "poll_ms": 2000 }
```

- `code`: 6 characters from `A-Z` and `2-9` without the look-alikes `0 O 1 I`. The device shows it as `K7P 42Q`. Valid for 10 minutes, usable once.
- `expires_in` in seconds is what the device counts down from (it does not trust the computer's clock); it keeps it between 30 and 1800. `expires_at` is only used when `expires_in` is missing.
- `poll_ms`: how often the device asks for the status, 500 to 10000. Default 2000.
- `pair_id` is a long random id, known only to the device. The status call below has no token, so `pair_id` must not be guessable.

### `GET /pair/{pair_id}`

No token. The device asks this every `poll_ms` while the code shows.

```json
{ "status": "waiting" }
{ "status": "paired", "device_token": "c1a8...", "app_name": "Web808" }
{ "status": "expired" }
{ "status": "cancelled" }
```

- `device_token`: a long random secret. Give it out once: after the first `paired` answer, delete the pairing record (a later call may answer 404).
- `app_name`: shown in the device as "Paired with Web808".
- 404 counts as expired.

### `POST /pair/{pair_id}/cancel`

No token, no body. The code stops working. The answer is ignored.

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

### `GET /packages/{package_id}/manifest`  (token)

The package description, see [manifest.md](manifest.md).

### `GET /packages/{package_id}/files/{file}`  (token)

The bytes of one WAV file. `{file}` is the `file` field of the sound in the manifest, URL-encoded. Send `Content-Length` when possible: the device refuses a file larger than the `bytes` in the manifest, checks `bytes` and `sha256` after the download, and retries up to 3 times (after 1, 2 and 4 seconds) when the connection breaks, the checksum is wrong, or the server answers 5xx. A 404 is not retried.

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

### `POST /unpair`  (token)

Body `{}`. Revoke the token: no app can send to this computer any more. The device forgets the token even when this call fails.

## Retention and limits

- A package is deleted after an `imported` or `partial` ack, and at the latest **24 hours** after upload, whether it was imported or not. A shorter time (for example 12 hours) is fine; the device does not depend on it.
- A package has at most **32 sounds** and **200 MB** in total. Only WAV (PCM 8/16/24/32-bit or float 32/64-bit, mono or stereo, 8 to 192 kHz). The device checks this too, but the server should refuse anything larger at upload.
- Pairing: limit code attempts (for example 5 per minute per IP address), because a code is short.

## App side (proposal)

Not used by the device; written down so the server can be built in one go.

- `POST /pair/claim` with `{"code": "K7P42Q", "app_name": "Web808", "app_id": "..."}`. The server links the app to the waiting pairing (status `paired` for the device) and returns `{"app_token": "...", "device_name": "ERIK-PC"}`. Wrong or expired code: 404 with a short `error`.
- `POST /packages` (app token) with the manifest. The server checks the schema and the limits and answers `{"package_id": "...", "upload": {"kick.wav": "/packages/<id>/files/kick.wav"}}`.
- `PUT /packages/{package_id}/files/{file}` (app token) with the WAV bytes. The server checks `bytes` and `sha256` against the manifest.
- `POST /packages/{package_id}/commit` (app token). Only now does the package show in the device's inbox. Uncommitted packages are deleted after an hour.
- `GET /packages/{package_id}/status` (app token): `waiting`, `imported`, `partial` or `failed`, with the per-sound result from the ack, so the app can show "In Live".
