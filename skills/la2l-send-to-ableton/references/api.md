# The LA2L API

## With the SDK (`npm install @lloydstellar/la2l`)

```js
import { LA2L } from '@lloydstellar/la2l';
const la2l = new LA2L({ appName: 'Web808' });
```

| Member | |
|---|---|
| `new LA2L({ appName, appId?, appVersion?, server?, storage?, fetch? })` | `appName` is required. `server` defaults to `https://lloydstellar.nl/la2l/api`; plain http works for localhost only. `storage` is `{ get, set, remove }` (synchronous); default localStorage in a browser, a private file in Node.js. |
| `la2l.paired`, `la2l.deviceName` | Whether there is a token; the name of the computer. |
| `await la2l.pair(code)` | Resolves to `{ deviceName }`. |
| `await la2l.me()` | `{ deviceName, appName, pairedAt }`. A `not_paired` error means: show the code field. |
| `await la2l.unpair()` | Revokes the token on the server and forgets it. Rejects with `network` when offline, and keeps the token. |
| `await la2l.send({ title, bpm, timeSignature, sounds, onProgress, signal })` | Checks, uploads and commits. Resolves to a `Delivery`. |
| `delivery.packageId`, `delivery.warnings` | The server's id; what LA2L ignores. |
| `await delivery.status()` | `{ status, sounds, error, updatedAt }`, status `uploading`, `waiting`, `imported`, `partial`, `failed` or `expired`. |
| `await delivery.imported()` | Waits for Import in Live: resolves on `imported` or `partial`, rejects on `failed` or `expired`. |
| `await delivery.cancel()` | Takes it back, until it is in Live. |
| `la2l.delivery(packageId)` | Follows an earlier send. |
| `checkWav(file)`, `checkManifest(manifest)`, `planSound(...)`, `sha256(file)` | LA2L's own checks. |

Every error is a `La2lError`: `code` (`not_paired`, `bad_code`, `rate_limited`, `server_full`, `bad_package`, `bad_wav`, `expired`, `import_failed`, `network`, `aborted`, `server`), `message`, `status`, `retryAfter`.

## The command line

```bash
npx @lloydstellar/la2l pair K7P42Q
npx @lloydstellar/la2l send kick.wav snare.wav --loop --bpm 92 --role drums --title "Beat" --wait
npx @lloydstellar/la2l status
npx @lloydstellar/la2l unpair
npx @lloydstellar/la2l test-receiver --local
```

The token is kept in a file only the user can read, or taken from `LA2L_TOKEN`.

## Without the SDK: five HTTP calls

Base address `https://lloydstellar.nl/la2l/api`. JSON in and out; errors are `{"error": "short plain English"}`, to show as they are. Every answer allows any origin (CORS). The full contract: https://github.com/lloydstellar/Lloyds-app2live/blob/main/docs/openapi.yaml

```bash
BASE=https://lloydstellar.nl/la2l/api

# 1. Pair once, with the code LA2L shows in Live. Keep app_token like a password.
curl -sS -X POST $BASE/pair/claim -H 'Content-Type: application/json' \
  -d '{"code":"K7P 42Q","app_name":"My app","app_id":"a-uuid-made-once"}'
#   -> {"app_token":"la2la_...","device_name":"STUDIO-PC"}
TOKEN=la2la_...

# 2. Announce the package: bytes and sha256 of every file.
curl -sS -X POST $BASE/packages -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "schema": "app2live/1", "title": "Beat", "source": {"app": "My app"}, "tempo": {"bpm": 120},
  "items": [{"id": "beat", "file": "beat.wav", "name": "Beat", "kind": "loop", "role": "drums",
             "bytes": 384044, "sha256": "<64 hex characters>"}]}'
#   -> 201 {"package_id":"<id>","upload":{"beat.wav":"/packages/<id>/files/beat.wav"},"warnings":[]}

# 3. Upload every file to its path. 4. Commit. 5. Follow it.
curl -sS -X PUT "$BASE/packages/<id>/files/beat.wav" -H "Authorization: Bearer $TOKEN" --data-binary @beat.wav
curl -sS -X POST "$BASE/packages/<id>/commit" -H "Authorization: Bearer $TOKEN"
curl -sS "$BASE/packages/<id>/status" -H "Authorization: Bearer $TOKEN"
#   -> {"status":"waiting"} until Import in Live, then {"status":"imported","items":[...]}
```

- 401 means the token is gone (the user unpaired in Live): forget it and show the code field.
- 429 has `Retry-After` in seconds. 30 packages an hour per app.
- 507 means no room: "Click Import in Live first", or try later.
- Upload and commit within an hour; a package waits 24 hours for Import.
- Send `X-LA2L-Client: <your-sdk>/<version> (<app name>)` with every call; it is optional.
