# CLAUDE.md for the LA2L developer kit

What app developers, and the AI tools they use, need to send sounds to LA2L in Ableton Live. It is built from [BUILD-PROMPT.md](BUILD-PROMPT.md), phase by phase; that brief has the decisions and the plan. Keep this file up to date as the parts get built; the next Claude starts from it.

## State

| Part | Where | State |
|---|---|---|
| The API for machines | `../docs/openapi.yaml` (OpenAPI 3.1, the app side) and `../docs/app2live-1.schema.json` (the manifest) | Phase 1 |
| Shared fixtures | `fixtures/` | Phase 1 |
| `la2l` on npm | `js/` | Phase 1: the checks of the device (`checkWav`, `checkManifest`, `planSound`, `sha256`). Not published. The client, the button and the CLI come in phase 2 |
| The test receiver page | `../server/public/receiver.html`, `receiver.js`, at `https://lloydstellar.nl/la2l/receiver` | Phase 1, with a browser test in `js/test-browser` |
| The server changes | `../server`, la2l-server 0.7.0 | Phase 1: storage limits, `DELETE /apps/{id}`, test receivers, `X-LA2L-Client`, `Retry-After` for web apps, `?big` on LA2L Sender |
| The skill, the developer pages, Android | | Phases 3 to 5 |

## Read first

1. [BUILD-PROMPT.md](BUILD-PROMPT.md): the assignment. Section 16 says what always waits for Erik's yes (publishing, making the repository public, accounts, keys, contacting anyone, large downloads).
2. [../docs/server-api.md](../docs/server-api.md) and [../docs/manifest.md](../docs/manifest.md): the contract in words. Both sides are final: add to them, never break them. Device 0.1.1 and today's LA2L Sender must keep working.
3. [fixtures/README.md](fixtures/README.md): how the device, the server and every SDK are held to the same verdicts.
4. [../server/CLAUDE.md](../server/CLAUDE.md): how the server is built, tested and deployed.

## Commands

| Command | Where | Does |
|---|---|---|
| `npm ci` | `sdk/js` | Installs the pinned dev tools from the lockfile (TypeScript, esbuild, Redocly, Ajv, yaml). The package itself has no runtime dependencies |
| `npm run build` | `sdk/js` | `dist/` with tsc, and `../server/public/vendor/la2l.js` with esbuild. Commit the vendor file after every change in `src/` |
| `npm test` | `sdk/js` | The tests, on `dist/`: build first. They hold the port to the fixtures and to the device's own code, and the OpenAPI file to the real server |
| `npm run check:vendor` | `sdk/js` | Whether the committed vendor file is what a fresh build makes (CI) |
| `npm run test:browser` | `sdk/js` | The test receiver and LA2L Sender in headless Chromium, against the real server. On the VPS: `LA2L_CHROMIUM=~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome npm run test:browser`, with the Chromium that is already there; CI installs its own |
| `npm run lint` | `sdk/js` | Redocly on `docs/openapi.yaml`, with the strict recommended rules |
| `node sdk/fixtures/make.js` | repository root | Makes the fixtures and `expected.json`; `--check` only checks them |
| `npm test` | repository root and `server/` | The device and the server tests; both run the fixtures |

The VPS has Node 22; the SDK supports 22.12 and newer, so `npm test` in `sdk/js` runs there as it is. CI runs it on every Node.js version that still gets security fixes.

## Rules

- **The device is the source of truth.** `src/node/manifest.js`, `src/node/wav.js` and `src/node/text.js` are ported to `js/src` with the same texts. When a check in the device changes, change the port and `fixtures/make.js` in the same branch; `js/test/parity.test.mjs` compares the two on thousands of random inputs.
- **No runtime dependencies** in the SDKs. `sdk/js` may have pinned devDependencies with its lockfile. The device and the server stay without npm packages: the server serves the SDK from the committed `server/public/vendor/la2l.js`.
- **The schema describes a correct manifest.** It is stricter than the server about types, known values and 40-character names, and cannot see two sounds with one file or 200 MB in total. `expected.json` says per fixture what it accepts.
- **The OpenAPI file follows the server**: its version is the server's, every operation must be answered by the real server, and every error text in it must come from the server's code. `js/test/openapi.test.mjs` checks all three.
- **Never put a token in a URL, a log or an error message**, in the SDK or in a page.
- Every text a user sees is plain English, short, without em dashes.
