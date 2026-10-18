# The REST API

Every SDK makes the same five kinds of calls, and any language can make them: pair once, announce a package, upload its files, commit, and follow it. JSON in and out, over HTTPS, without an API key.

Base address: `https://lloydstellar.nl/la2l/api`

For machines: [openapi.yaml](openapi.yaml) (OpenAPI 3.1) describes every call, answer and error text, and [app2live-1.schema.json](app2live-1.schema.json) (JSON Schema) the package description.

## From a script

With Node.js 22.12 or newer, the command line of `la2l` does it all:

```bash
npx la2l pair K7P42Q
npx la2l send kick.wav snare.wav --loop --bpm 92 --role drums --title "Beat" --wait
npx la2l status
```

`--oneshot` for sounds that play as they are. It keeps the token in a file only the user can read, or takes it from `LA2L_TOKEN`.

## The five calls, with curl

```bash
BASE=https://lloydstellar.nl/la2l/api

# 1. Pair, with the code LA2L shows in Live. Keep app_token like a password.
curl -sS -X POST $BASE/pair/claim -H 'Content-Type: application/json' \
  -d '{"code":"K7P 42Q","app_name":"curl test","app_id":"curl-1"}'
#   -> {"app_token":"la2la_...","device_name":"ERIK-PC"}
TOKEN=la2la_...

# 2. Announce the package, with bytes and sha256 of every file
BYTES=$(stat -c %s kick.wav); SHA=$(sha256sum kick.wav | cut -d' ' -f1)
curl -sS -X POST $BASE/packages -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "schema": "app2live/1", "title": "Curl test", "source": {"app": "curl test"}, "tempo": {"bpm": 120},
  "items": [{"id": "kick", "file": "kick.wav", "name": "Kick", "kind": "loop", "role": "drums",
             "bytes": '"$BYTES"', "sha256": "'"$SHA"'"}]}'
#   -> {"package_id":"<id>","upload":{"kick.wav":"/packages/<id>/files/kick.wav"},...}

# 3. Upload, 4. commit, 5. follow
curl -sS -X PUT "$BASE/packages/<id>/files/kick.wav" -H "Authorization: Bearer $TOKEN" --data-binary @kick.wav
curl -sS -X POST "$BASE/packages/<id>/commit" -H "Authorization: Bearer $TOKEN"
curl -sS "$BASE/packages/<id>/status" -H "Authorization: Bearer $TOKEN"
#   -> {"status":"waiting",...} until Import in Live, then {"status":"imported",...}
```

## Rules for every call

- The token goes in `Authorization: Bearer <app_token>`, never in a URL or a cookie.
- **401** means the token is unknown or revoked: the user unpaired your app in Live. Forget the token and ask for a code again. No other problem answers 401.
- Errors are `{"error": "short plain English"}`, at most 80 characters: show the text as it is.
- **429**: too many calls. `Retry-After` says how many seconds to wait. At most 600 calls a minute per token, 30 packages an hour per app, and 10 pairing tries a minute from one address.
- **507**: no room. Often "Click Import in Live first": the computer has a lot waiting already.
- **5xx**, or no answer: try again later. The SDKs retry a few times by themselves.
- Every answer allows any origin (CORS), so a web page anywhere can call the API, and read `Retry-After`.
- `X-LA2L-Client: my-app/1.0 (My app)` is optional: it says which app and version make the call.

## The calls

| Call | Does |
|---|---|
| `POST /pair/claim` | `{"code", "app_name", "app_id"}`: trades the code from Live for `{"app_token", "device_name"}`. A wrong, used or expired code: 404. |
| `GET /app/me` | `{"device_name", "app_name", "paired_at"}`: which computer this app is paired with. |
| `POST /app/unpair` | Revokes this token. |
| `POST /packages` | The package description, with `bytes` and `sha256` of every file. 201 with `package_id`, the `upload` path per file and `warnings`. 422 with the reason when LA2L would refuse it. |
| `PUT /packages/{id}/files/{file}` | The bytes of one WAV file, up to 200 MB. Checked against its size, checksum and WAV header. |
| `POST /packages/{id}/commit` | Every file is there: from now on Live sees the package. 409 names the files still missing. |
| `GET /packages/{id}/status` | `uploading`, `waiting`, `imported`, `partial`, `failed` or `expired`, with the result per sound after Import. |
| `DELETE /packages/{id}` | Takes a package back, until it is in Live. |

Upload the files and commit within an hour. A package waits 24 hours for Import; then it is deleted, imported or not. Its status stays readable for 7 days.

The package description itself: [The package description](manifest.md).
