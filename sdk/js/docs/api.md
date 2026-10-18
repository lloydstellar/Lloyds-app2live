# The API of `la2l`

ESM, with type definitions. Browsers, Node.js 22.12 and newer, Deno and Bun.

## `new LA2L(options)`

| Option | |
|---|---|
| `appName` | Required. Live shows "Paired with Web808", and every track is called "Kick (Web808)". |
| `appId` | This installation's own id. Default: a UUID made once and kept. Pairing again with the same id replaces the old token. |
| `appVersion` | Only logged. |
| `server` | Default `https://lloydstellar.nl/la2l/api`. The local test receiver prints its own ([testing.md](testing.md)). In a browser it may be relative, such as `"../api"`. Plain `http` works for localhost only, so the token never travels in clear text. |
| `storage` | Where the token is kept: `{ get(key), set(key, value), remove(key) }`, synchronous. Default: `localStorage` in a browser (keys `la2l.<app>.token` and so on), a file only the user can read in the user's config folder in Node.js (`LA2L_CONFIG_DIR` picks another folder; a folder that cannot be written falls back to memory, with a warning), else memory. `memoryStorage()` keeps it in memory. Every app name gets keys of its own. |
| `fetch` | A fetch of your own. |

## Pairing

- `la2l.paired`: whether there is a token. It can still turn out to be revoked: a call then fails with `not_paired`, and the token is forgotten.
- `la2l.deviceName`: the computer, as "Paired with ERIK-PC".
- `await la2l.pair(code)`: resolves to `{ deviceName }`. Case, spaces and dashes in the code do not matter.
- `await la2l.me()`: `{ deviceName, appName, pairedAt }`. Ask it when the app starts, to learn early that it was unpaired.
- `await la2l.unpair()`: the server revokes the token, and it is forgotten here. When the server cannot be reached it rejects with `network` and keeps the token, so you can try again.
- `la2l.forget()`: forgets the token here only. The server keeps it until LA2L in Live unpairs, but nobody has it any more.

## Sending

`await la2l.send({ title, bpm, timeSignature, sounds, onProgress, signal, appName })` checks everything before the first byte goes out, with the texts of the server and of LA2L: the sounds, every WAV header, the limits. Then it works out `bytes` and `sha256`, announces the package, uploads the files one by one, and commits. It resolves to a `Delivery`.

A sound:

| Field | |
|---|---|
| `audio` | Required. A WAV file: a `Blob`, a `File`, an `ArrayBuffer` or bytes. |
| `kind` | Required: `'loop'` or `'oneshot'`. |
| `name` | The track name, at most 40 characters. Default: the file name, or "Sound 1". |
| `role` | `drums`, `bass`, `melodic`, `vocal`, `texture` or `fx`. Picks the warp mode of a loop. |
| `bpm`, `lengthBeats` | The tempo and length of this loop, when they differ from the package. Without a length, LA2L works it out from the file and the tempo. |
| `warpMode`, `color`, `gainDb`, `id` | See the manifest: https://github.com/lloydstellar/Lloyds-app2live/blob/main/docs/manifest.md |
| `file` | The file name on the server. Default: made from the name. |
| `sha256` | The checksum, when you know it, so a large file is not read twice. |

`appName` sets the app name of this package, and so of its track names, for a send on behalf of another app, as LA2L Sender does with what an app shares. Without it, the client's own.

`onProgress(share, { stage, sound, soundShare })`: `share` is the part of all bytes uploaded, from 0 to 1.

More than 32 sounds or 200 MB: send them in more packages, for example "Beat (1 of 2)" and "Beat (2 of 2)".

Retries: a 5xx or a broken connection is tried again after 1, 2 and 4 seconds; a broken upload starts that file again, because the server cannot resume. When a phone switches networks, the server may hold the first upload for about a minute; the SDK waits that out. A 429 that asks to wait at most a minute is waited out; a longer one is an error with `retryAfter`. Every call carries `X-LA2L-Client: la2l-js/<version> (<appName>)`.

## `Delivery`

- `delivery.packageId`, `delivery.warnings` (what LA2L takes but ignores, such as an unknown role), `delivery.expiresAt`.
- `await delivery.status()`: `{ status, sounds, error, updatedAt }`. `status` is `uploading`, `waiting`, `imported`, `partial`, `failed` or `expired`; `sounds` holds per sound what LA2L said: `{ id, name, status: 'imported' | 'failed', error }`.
- `await delivery.imported({ intervalMs, signal })`: asks every 3 seconds, also through short trouble with the network; resolves on `imported` or `partial`, rejects with `import_failed` or `expired`.
- `await delivery.cancel()`: takes the package back, until it is in Live.
- `la2l.delivery(packageId)`: follows a package sent earlier, for example after a reload.

## The checks of LA2L

`checkWav(file)`, `checkManifest(manifest, { as: 'server' | 'device' })`, `planSound(sound, pkg, seconds)` and `sha256(file)`: the device's own checks, with the same texts. `planSound` says what Live will do: warp on or off, the warp mode, the tempo, the length in beats, the track name.
