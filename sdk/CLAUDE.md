# CLAUDE.md for the LA2L developer kit

What app developers, and the AI tools they use, need to send sounds to LA2L in Ableton Live. It is built from [BUILD-PROMPT.md](BUILD-PROMPT.md), phase by phase; that brief has the decisions and the plan. Keep this file up to date as the parts get built; the next Claude starts from it.

## State

| Part | Where | State |
|---|---|---|
| The API for machines | `../docs/openapi.yaml` (OpenAPI 3.1, the app side) and `../docs/app2live-1.schema.json` (the manifest) | Phase 1 |
| Shared fixtures | `fixtures/` | Phase 1 |
| `@lloydstellar/la2l` for npm, 0.1.0 | `js/` | Phase 2: the client, the WAV helpers, the checks of the device, `<la2l-send-button>`, the command line, and the test receivers. Phase 3: `npx @lloydstellar/la2l agents-md`. Its command is `la2l`. npm refused the name `la2l` on 2026-10-18 (too much like other packages), so it is scoped. Not published: that waits for Erik's yes (the placeholder, a public repository) |
| The test receiver | the page `../server/public/receiver.html` (on `js/src/receiver.ts`, served as `vendor/la2l-receiver.js`), `npx @lloydstellar/la2l test-receiver [--local]`, `startTestReceiver()` from `@lloydstellar/la2l/testing` | Phases 1 and 2 |
| LA2L Sender on the SDK | `../server/public/sender.js`, on `vendor/la2l.js` | Phase 2 |
| Web808, the drum machine example | `../examples/web-drum-machine`, served at `https://lloydstellar.nl/la2l/examples/drum-machine/` | Phase 2 |
| The server changes | `../server`, la2l-server 0.7.0 (API), 0.8.0 (pages), 0.9.0 (the developer pages), 0.10.0 (LA2L Sender as a share target) and 0.11.0 (the developer pages on the Android SDK) | Phases 1 to 5 |
| The skill `la2l-send-to-ableton` | `../skills/la2l-send-to-ableton`; `../skills` is the root of its Claude Code plugin, listed in `../.claude-plugin/marketplace.json` | Phase 3. `npx skills add` and the plugin work once the repository is public |
| The developer pages | Sources in `../docs/developers/*.md`; `../tools/devpages.js` makes `../server/public/developers` (committed): a page and a `.md` twin each, `llms.txt`, `llms-full.txt`, and copies of the OpenAPI file and the schema. Served at `/la2l/developers/`, `/la2l/llms.txt` and `/la2l/llms-full.txt`, with `X-Robots-Tag: noindex` until the launch | Phase 3 |
| The paste text for Lovable and Bolt, the AI test, Context7 | `../docs/developers/paste-text.md` (also a page), `../docs/developers/ai-test.md` (the record, not a page), `../context7.json` | Phase 3. The AI test and Context7 wait for npm and a public repository |
| The privacy statement | `../docs/developers/privacy.md`: a draft, not served until Erik approves it; then it goes to `/la2l/privacy` | Phase 3 |
| LA2L Sender as a share target on Android | `../server/public/manifest.webmanifest`, `sw.js` (takes a share into IndexedDB), `share.js` (the description in the shared text), `zip.js` (ZIP files in the browser), `share.html` (a share that reaches the server), the icons (made by `../tools/pwa-icons.py`); the developer page `../docs/developers/sharing.md` | Phase 4 |
| The Android SDK, 0.1.0 | `android/`: `la2l` (Java, no dependencies, minSdk 24) and `la2l-ktx` (Kotlin, suspend functions and a builder), with `La2lShare` and its own file provider; the examples `../examples/android-recorder` (Kotlin) and `../examples/android-java` | Phase 5. Built and tested only in GitHub Actions (job `android`). Not published: the Maven repository at https://lloydstellar.nl/la2l/maven/ waits for Erik's yes, a signing key and the way the files reach the VPS |

## Read first

1. [BUILD-PROMPT.md](BUILD-PROMPT.md): the assignment. Section 16 says what always waits for Erik's yes (publishing, making the repository public, accounts, keys, contacting anyone, large downloads).
2. [../docs/server-api.md](../docs/server-api.md) and [../docs/manifest.md](../docs/manifest.md): the contract in words. Both sides are final: add to them, never break them. Device 0.1.1 and today's LA2L Sender must keep working.
3. [fixtures/README.md](fixtures/README.md): how the device, the server and every SDK are held to the same verdicts.
4. [js/docs/](js/docs/): the manual of `@lloydstellar/la2l`, as it ships in the package.
5. [../server/CLAUDE.md](../server/CLAUDE.md): how the server is built, tested and deployed.

## `@lloydstellar/la2l` in `js/`

| Source | Is |
|---|---|
| `src/client.ts`, `src/http.ts`, `src/storage.ts` | `LA2L` and `Delivery`: pairing, sending with checks, retries and progress, following a package; where the token is kept |
| `src/audio.ts` | `wavFromSamples`, `wavFromAudioBuffer`, `toWav` |
| `src/manifest.ts`, `src/wav.ts`, `src/plan.ts`, `src/text.ts`, `src/sha256.ts` | The checks of the device, ported with the same texts, and SHA-256 in pieces |
| `src/receiver.ts` | `TestReceiver`: the device side, as the device does it. The page, the command line and `startTestReceiver` all run it |
| `src/testing/local-server.ts`, `src/testing/index.ts` | `@lloydstellar/la2l/testing`: an LA2L server in memory that answers the app side as la2l-server does |
| `src/button.ts`, `src/logo.ts` | `@lloydstellar/la2l/button`: `<la2l-send-button>`. `logo.ts` is made by `scripts/logo.mjs` from `assets/logo-48.png` |
| `src/cli/main.ts`, `src/cli/agents-md.ts` | The command `la2l` (`npx @lloydstellar/la2l` without installing); `agents-md` writes the docs index for AI coding agents into `AGENTS.md` and `CLAUDE.md` |
| `docs/` | The manual in the package. The build writes the integrity hash of `dist/button.js` into it and into `README.md` |

## The Android SDK in `android/`

| Source | Is |
|---|---|
| `la2l/src/main/java/nl/lloydstellar/la2l/La2l.java`, `Http.java`, `Delivery.java`, `Storage.java`, `Job.java` | The client, as the web client does it: pairing, sending with checks, retries and progress, following a package; the token in a private file outside Android's backups. Every call returns a `CompletableFuture` (`pairAsync`, `sendAsync`, ...) and has a `Callback` variant on the main thread that returns it too; cancelling closes the open connection, and a cancelled call reports nothing |
| `WavCheck.java`, `ManifestCheck.java`, `Text.java` | The checks of the device, ported with the same texts; `FixturesTest` holds them to `../fixtures/expected.json` |
| `Wav.java` | WAV files from 16-bit or float samples, in memory or on disk |
| `La2lShare.java`, `La2lFileProvider.java` | A share for LA2L Sender with the description in `EXTRA_TEXT`, and the provider that lets the picked app read the files |
| `la2l-ktx/src/main/kotlin/.../La2lKtx.kt` | `pair`, `me`, `unpair`, `send { sound(...) }`, `status`, `awaitImport`, `cancel` as suspend functions |
| `la2l/src/test`, `la2l-ktx/src/test` | JVM tests; `ClientTest` and `La2lKtxTest` run against the real server of `../../server` and the test receiver of `js/`, `ParityTest` holds `ManifestCheck` to the web SDK on 600 random descriptions (Node and a build of `js/` needed); `FaultyServerTest` plays retries, a 409, a 429, a 401 and a cancel on a fake server |
| `publish.gradle.kts`, `../../.github/workflows/publish-android.yml` | A Maven repository in `build/maven`, signed when the secrets are there; a tag `android-v<version>` attaches it to a GitHub release |

The versions of Gradle (8.14), the Android Gradle Plugin (8.13) and Kotlin (2.3) are set in `android/build.gradle.kts` and in the workflows; `la2l-ktx` is compiled for Kotlin 2.1 and newer. The example apps target API 34: from 35 Android draws them under the system bars, which their small layouts do not handle.

## Commands

| Command | Where | Does |
|---|---|---|
| `npm ci` | `sdk/js` | Installs the pinned dev tools from the lockfile (TypeScript, esbuild, Redocly, Ajv, yaml, playwright-core, and React's types for the examples). The package itself has no runtime dependencies |
| `npm run build` | `sdk/js` | `dist/` with tsc (what bundlers import, so `@lloydstellar/la2l` and `@lloydstellar/la2l/button` share one client), `dist/button.min.js` as one minified file for pages without a build step (jsDelivr), and `../server/public/vendor/` (`la2l.js`, `la2l-button.js` = `button.min.js`, `la2l-receiver.js`) with esbuild. It also writes the version and the integrity hash of `button.min.js` into the docs, the README and the examples. Commit those after every change in `src/` |
| `npm test` | `sdk/js` | The tests, on `dist/`: build first. Among them the same app-side tests against la2l-server and the local test receiver, the whole chain into the simulated Live, the command line, and the port held to the fixtures and to the device's own code |
| `npm run test:browser` | `sdk/js` | The test receiver page, LA2L Sender, the drum machine and the button in headless Chromium, against the real server. On the VPS: `LA2L_CHROMIUM=~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome npm run test:browser`, with the Chromium that is already there; CI installs its own |
| `npm run check:vendor` | `sdk/js` | Whether the committed vendor files and docs are what a fresh build makes (CI) |
| `deno run -A test-runtimes/smoke.mjs`, `bun test-runtimes/smoke.mjs` | `sdk/js` | A send through the local test receiver in Deno and in Bun, after a build. CI runs both; on the VPS run them in the `denoland/deno` and `oven/bun` images |
| `npm run lint` | `sdk/js` | Redocly on `docs/openapi.yaml`, with the strict recommended rules; `.redocly.lint-ignore.yaml` holds the one exception, with its reason |
| `node sdk/fixtures/make.js` | repository root | Makes the fixtures and `expected.json`; `--check` only checks them |
| `npm test` | repository root and `server/` | The device and the server tests; both run the fixtures. The server's also check the developer pages and every link on them |
| `node tools/devpages.js` | repository root | Makes the developer pages from `docs/developers` into `server/public/developers`; `--check` only checks them (CI). Run it after `npm run build` in `sdk/js`, which writes the version and the integrity hash into the sources |
| `claude plugin validate ./skills`, `claude plugin validate .` | repository root | Checks the plugin and the marketplace entry of the skill |
| `gradle :la2l:testDebugUnitTest :la2l-ktx:testDebugUnitTest ...` | `sdk/android`, in GitHub Actions only | The Android tests, libraries, example apps and Maven repository; see the job `android` in `.github/workflows/test.yml`. Never on the VPS (Erik's decision): push, and read the result of the job. The example apps come out as the artifact `la2l-android` |

The VPS has Node 22; the SDK supports 22.12 and newer, so its tests run there as they are. CI runs them on every Node.js version that still gets security fixes.

## Rules

- **The device is the source of truth.** `src/node/manifest.js`, `src/node/wav.js` and `src/node/text.js` are ported to `js/src` with the same texts. When a check in the device changes, change the port and `fixtures/make.js` in the same branch; `js/test/parity.test.mjs` compares the two on thousands of random inputs.
- **The local test receiver answers as la2l-server.** A change to the app side of the server changes `js/src/testing/local-server.ts` too; `js/test/app-side.test.mjs` runs the same tests against both.
- **No runtime dependencies** in the SDKs. `sdk/js` may have pinned devDependencies with its lockfile. The device and the server stay without npm packages: the server serves the SDK from the committed `server/public/vendor/`.
- **The schema describes a correct manifest.** It is stricter than the server about types, known values and 40-character names, and cannot see two sounds with one file or 200 MB in total. `expected.json` says per fixture what it accepts.
- **The OpenAPI file follows the server**: its version is the server's, every operation must be answered by the real server, and every error text in it must come from the server's code. `js/test/openapi.test.mjs` checks all three.
- **Never put a token in a URL, a log or an error message**, in the SDK or in a page.
- **The examples of the skill and the docs are tested.** `js/test/skill.test.mjs` checks the form of the skill, its links, every name it imports, its package descriptions, and runs its example test; `js/test-browser/skill.test.mjs` runs `button.html` and `web-send.js` in Chromium; `js/test/snippets.test.mjs` type-checks every `tsx` example with React's types. The Kotlin of the skill is the Kotlin of `docs/developers/android.md`.
- **Nothing is published by hand or without Erik's yes**: npm (also the placeholder 0.0.1), a tag that starts a publish workflow, Context7, skill directories.
- Every text a user sees is plain English, short, without em dashes.
