# Fixtures

Small WAV files and manifests, good and bad, with the verdict on each in `expected.json`. Every part of LA2L that judges a package runs them:

| Who | Test |
|---|---|
| The device, the source of truth | `tests/fixtures.test.js` runs `src/node/wav.js` and `src/node/manifest.js` |
| la2l-server | `server/test/fixtures.test.js` sends every manifest to `POST /packages` and every WAV file through `PUT` |
| `@lloydstellar/la2l` on npm | `sdk/js/test/fixtures.test.mjs` runs `checkWav`, `checkManifest` and `planSound` |
| The JSON Schema | `sdk/js/test/schema.test.mjs` checks `docs/app2live-1.schema.json` against the `schema` verdicts |

When two of them disagree, the device is right, unless Erik decides otherwise.

## What `expected.json` holds

- `wav`: per file, the device's verdict. `ok: true` with the header fields of `readInfo` (`format`, `channels`, `sampleRate`, `bitsPerSample`, `frames`, `dataBytes`), or `ok: false` with the exact text of the error. The server checks uploads with the same code, so a `PUT` answers 422 with that text.
- `manifests`: per manifest as an app sends it:
  - `device`: what the device does with it once the server has given it a `package_id`: refused as a whole (`ok: false`, `error`), or its warnings and per sound the name, the kind and the error that skips that sound;
  - `server`: the answer to `POST /packages`: `status`, and `warnings` or `error`. The server is stricter: every sound must be valid and have `bytes` and `sha256`, and it warns about a tempo that only applies to loops;
  - `schema`: whether `docs/app2live-1.schema.json` accepts it. The schema describes a correct manifest, so it is stricter than the server about types, known values and the 40 characters of a name. It cannot see two sounds with one file, or 200 MB in total: those two it accepts, and the server refuses.
- `plans`: what the device does in Live with one sound of a manifest, given its length in seconds: warp on or off, the warp mode (Live's number: 0 Beats, 1 Tones, 2 Texture, 3 Re-Pitch, 4 Complex, 6 Complex Pro), the tempo, the length in beats, and the track name.

## Changing them

`make.js` makes every file here, with integer arithmetic, so they are the same on every machine. Change a fixture or a verdict there, never in the files, and run:

```bash
node sdk/fixtures/make.js           # write the files
node sdk/fixtures/make.js --check   # only check that they are up to date
```

The device tests do that check too, so CI fails when a fixture is not what `make.js` makes, or when a file here was not made by it.
