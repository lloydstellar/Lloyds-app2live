# CLAUDE.md for the LA2L developer kit

What app developers, and the AI tools they use, need to send sounds to LA2L in Ableton Live. It is built from [BUILD-PROMPT.md](BUILD-PROMPT.md), phase by phase; that brief has the decisions and the plan. Keep this file up to date as the parts get built; the next Claude starts from it.

## State

| Part | Where | State |
|---|---|---|
| The API for machines | `../docs/openapi.yaml` (OpenAPI 3.1, the app side) and `../docs/app2live-1.schema.json` (the manifest) | Phase 1 |
| Shared fixtures | `fixtures/` | Phase 1 |
| `la2l` for npm, 0.1.0 | `js/` | Phase 2: the client, the WAV helpers, the checks of the device, `<la2l-send-button>`, the command line, and the test receivers. Not published: that waits for Erik's yes (npm account, the name, a public repository) |
| The test receiver | the page `../server/public/receiver.html` (on `js/src/receiver.ts`, served as `vendor/la2l-receiver.js`), `npx la2l test-receiver [--local]`, `startTestReceiver()` from `la2l/testing` | Phases 1 and 2 |
| LA2L Sender on the SDK | `../server/public/sender.js`, on `vendor/la2l.js` | Phase 2 |
| Web808, the drum machine example | `../examples/web-drum-machine`, served at `https://lloydstellar.nl/la2l/examples/drum-machine/` | Phase 2 |
| The server changes | `../server`, la2l-server 0.7.0 (API) and 0.8.0 (pages) | Phases 1 and 2 |
| The skill, the developer pages, Android | | Phases 3 to 5 |

## Read first

1. [BUILD-PROMPT.md](BUILD-PROMPT.md): the assignment. Section 16 says what always waits for Erik's yes (publishing, making the repository public, accounts, keys, contacting anyone, large downloads).
2. [../docs/server-api.md](../docs/server-api.md) and [../docs/manifest.md](../docs/manifest.md): the contract in words. Both sides are final: add to them, never break them. Device 0.1.1 and today's LA2L Sender must keep working.
3. [fixtures/README.md](fixtures/README.md): how the device, the server and every SDK are held to the same verdicts.
4. [js/docs/](js/docs/): the manual of `la2l`, as it ships in the package.
5. [../server/CLAUDE.md](../server/CLAUDE.md): how the server is built, tested and deployed.

## `la2l` in `js/`

| Source | Is |
|---|---|
| `src/client.ts`, `src/http.ts`, `src/storage.ts` | `LA2L` and `Delivery`: pairing, sending with checks, retries and progress, following a package; where the token is kept |
| `src/audio.ts` | `wavFromSamples`, `wavFromAudioBuffer`, `toWav` |
| `src/manifest.ts`, `src/wav.ts`, `src/plan.ts`, `src/text.ts`, `src/sha256.ts` | The checks of the device, ported with the same texts, and SHA-256 in pieces |
| `src/receiver.ts` | `TestReceiver`: the device side, as the device does it. The page, the command line and `startTestReceiver` all run it |
| `src/testing/local-server.ts`, `src/testing/index.ts` | `la2l/testing`: an LA2L server in memory that answers the app side as la2l-server does |
| `src/button.ts`, `src/logo.ts` | `la2l/button`: `<la2l-send-button>`. `logo.ts` is made by `scripts/logo.mjs` from `assets/logo-48.png` |
| `src/cli/main.ts` | `npx la2l` |
| `docs/` | The manual in the package. The build writes the integrity hash of `dist/button.js` into it and into `README.md` |

## Commands

| Command | Where | Does |
|---|---|---|
| `npm ci` | `sdk/js` | Installs the pinned dev tools from the lockfile (TypeScript, esbuild, Redocly, Ajv, yaml, playwright-core). The package itself has no runtime dependencies |
| `npm run build` | `sdk/js` | `dist/` with tsc (what bundlers import, so `la2l` and `la2l/button` share one client), `dist/button.min.js` as one minified file for pages without a build step (jsDelivr), and `../server/public/vendor/` (`la2l.js`, `la2l-button.js` = `button.min.js`, `la2l-receiver.js`) with esbuild. It also writes the version and the integrity hash of `button.min.js` into the docs, the README and the examples. Commit those after every change in `src/` |
| `npm test` | `sdk/js` | The tests, on `dist/`: build first. Among them the same app-side tests against la2l-server and the local test receiver, the whole chain into the simulated Live, the command line, and the port held to the fixtures and to the device's own code |
| `npm run test:browser` | `sdk/js` | The test receiver page, LA2L Sender, the drum machine and the button in headless Chromium, against the real server. On the VPS: `LA2L_CHROMIUM=~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome npm run test:browser`, with the Chromium that is already there; CI installs its own |
| `npm run check:vendor` | `sdk/js` | Whether the committed vendor files and docs are what a fresh build makes (CI) |
| `deno run -A test-runtimes/smoke.mjs`, `bun test-runtimes/smoke.mjs` | `sdk/js` | A send through the local test receiver in Deno and in Bun, after a build. CI runs both; on the VPS run them in the `denoland/deno` and `oven/bun` images |
| `npm run lint` | `sdk/js` | Redocly on `docs/openapi.yaml`, with the strict recommended rules; `.redocly.lint-ignore.yaml` holds the one exception, with its reason |
| `node sdk/fixtures/make.js` | repository root | Makes the fixtures and `expected.json`; `--check` only checks them |
| `npm test` | repository root and `server/` | The device and the server tests; both run the fixtures |

The VPS has Node 22; the SDK supports 22.12 and newer, so its tests run there as they are. CI runs them on every Node.js version that still gets security fixes.

## Rules

- **The device is the source of truth.** `src/node/manifest.js`, `src/node/wav.js` and `src/node/text.js` are ported to `js/src` with the same texts. When a check in the device changes, change the port and `fixtures/make.js` in the same branch; `js/test/parity.test.mjs` compares the two on thousands of random inputs.
- **The local test receiver answers as la2l-server.** A change to the app side of the server changes `js/src/testing/local-server.ts` too; `js/test/app-side.test.mjs` runs the same tests against both.
- **No runtime dependencies** in the SDKs. `sdk/js` may have pinned devDependencies with its lockfile. The device and the server stay without npm packages: the server serves the SDK from the committed `server/public/vendor/`.
- **The schema describes a correct manifest.** It is stricter than the server about types, known values and 40-character names, and cannot see two sounds with one file or 200 MB in total. `expected.json` says per fixture what it accepts.
- **The OpenAPI file follows the server**: its version is the server's, every operation must be answered by the real server, and every error text in it must come from the server's code. `js/test/openapi.test.mjs` checks all three.
- **Never put a token in a URL, a log or an error message**, in the SDK or in a page.
- **Nothing is published by hand or without Erik's yes**: npm (also the placeholder 0.0.1), a tag that starts a publish workflow, Context7, skill directories.
- Every text a user sees is plain English, short, without em dashes.
