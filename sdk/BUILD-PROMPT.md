# Build brief: the LA2L developer kit

You are Claude Code on Erik's Linux VPS, the machine that runs la2l-server. Your job is to build what app developers, and the AI tools they use, need to send sounds to LA2L: the API contract in a form machines read, a web SDK on npm, an Android SDK in a Maven repository of our own, a skill and docs for AI tools, LA2L Sender as a share target on Android, a test receiver that stands in for Ableton Live, and the server changes these need. This brief is the whole assignment. Read it to the end before you start, then work phase by phase (section 15). After each phase, tell Erik in Dutch what to test, and wait for his answer before the next phase.

To start, Erik will say something like: *"Lees sdk/BUILD-PROMPT.md en begin met fase 0."*

The plan behind this brief was worked out with Erik in Dutch; this is its buildable version. When you find a gap or a mistake in it, tell Erik and fix the brief in the same pull request.

---

## 1. What you build, in one minute

```
          Code written by a developer, or by an AI tool with the LA2L skill
   ┌──────────────────┬───────────────────────┬────────────────────────┐
 Web app           Android app            Any app that shares      Script, or another
 (Web Audio)       (Kotlin or Java)       audio, without LA2L code language
   │                  │                       │                        │
 la2l on npm       la2l for Android       LA2L Sender as a         REST API (OpenAPI),
 client, button,   in our own Maven repo  share target (PWA)       or npx la2l send
 CLI                  │                       │                        │
   └──────────────────┴───────────┬───────────┴────────────────────────┘
                                  ▼
                 la2l-server, https://lloydstellar.nl/la2l/api
                                  ▼
                LA2L in Ableton Live, or the test receiver
```

Today an app needs no SDK at all. Five kinds of HTTPS calls do the whole job, without an API key or a developer account (`docs/server-api.md`, app side):

1. **Pair.** The user types the code from Live into the app. The app sends `POST /pair/claim` with that code, an app name and its own `app_id`, and keeps the `app_token` it gets back.
2. **Announce the package.** `POST /packages` with the manifest (`app2live/1`): per sound the file name, `bytes`, `sha256`, name, loop or one-shot, role and BPM.
3. **Upload.** One `PUT` per WAV, to the path the server gave.
4. **Commit.** `POST /packages/{id}/commit`. From now on Live sees the package at the next Import.
5. **Follow.** `GET /packages/{id}/status` until `imported`, `partial`, `failed` or `expired`. A 401 means: pair again.

LA2L Sender (`server/public/sender.js`, about 500 lines) does exactly this. The kit exists because developers stumble on the same four things, and each part below takes one of them away:

- **Making a WAV.** Web Audio gives an `AudioBuffer`, Android gives PCM samples or an m4a. Both must become a valid WAV first.
- **Filling in the manifest.** Without `kind: "loop"` a loop arrives as a one-shot without warp. Names have 40 characters at most, and file names have their own rules.
- **Checksums and order.** First `bytes` and `sha256`, then the uploads, only then the commit.
- **Tokens and errors.** Keep the token, handle 401 and 429, retry on 5xx, show upload progress.

The limits, from `docs/server-api.md`: 32 sounds and 200 MB per package; WAV only (PCM 8, 16, 24 or 32 bit, or float 32 or 64 bit, mono or stereo, 8 to 192 kHz); 30 packages an hour per app; 600 calls a minute per token. A package lives 24 hours after upload; its result stays readable for 7 days.

---

## 2. What exists: read in this order

| # | File | Why |
|---|---|---|
| 1 | `CLAUDE.md`, `server/CLAUDE.md` | How to work in this repository, on this VPS and with Erik. |
| 2 | `docs/server-api.md`, `docs/manifest.md` | The contract. Both sides are final: you add to them, you never break them. |
| 3 | `server/public/sender.js`, `server/public/index.html` | The reference client. Everything the SDKs do, it does by hand today. |
| 4 | `src/node/manifest.js`, `src/node/wav.js`, `src/node/text.js` | How the device judges a package and a WAV file, with the exact texts. The server reuses these files; the SDKs must judge the same way (section 6.3). |
| 5 | `server/src/` (`main.js`, `http-util.js`, `static.js`, `config.js`, `routes/`), `server/test/helpers.js` | Where the server changes go, and the helpers that start a real server inside a test. |
| 6 | `tests/mock-server.js`, `tests/app.test.js`, `server/test/device-e2e.test.js` | The in-memory server of the device tests, and how the real device code runs against a server in a test. |
| 7 | `server/BUILD-PROMPT.md` | How the server was built. You work the same way here. |

---

## 3. Decisions

### 3.1 Made

Do not change these without asking Erik.

| Decision | Why |
|---|---|
| Two SDKs: TypeScript for the web; for Android a core that works from Java, with Kotlin on top. Not one Kotlin Multiplatform SDK. | TypeScript is the largest language on GitHub and what AI app builders write. Kotlin is in 51% of Play apps and 76% of installs; many audio apps upload from Java code. Kotlin's JavaScript export is still experimental (it cannot export suspend functions or enums), there would still be two registries, and device and server already judge packages in JavaScript. So the SDKs share a JSON Schema and test files, not code. |
| One repository for device, server, contract, SDKs, skill and examples | API, SDKs and skill change together and are tested together. |
| No API keys and no developer accounts | The code the user types is the consent. Limits stop abuse (section 7.1); a key would mostly slow down new apps. |
| The API stays backwards compatible | Device 0.1.1 and today's LA2L Sender keep working. New fields are optional. A breaking change would get `/api/v2` next to the old API, which keeps working for at least a year. |
| No runtime dependencies in the SDKs | Nothing for the apps that use them to audit or update. `sdk/js` may have pinned devDependencies with a lockfile (the TypeScript compiler, a bundler, test tools). The device and the server stay without npm packages. |
| iOS is out of scope | No web app can be a share target on iOS. That needs an app of its own with a Share Extension, later. |
| Not now: an MCP server of our own, plugin packages for Codex and Cursor, `.well-known` discovery | Too much upkeep for a project this size. A Claude Code plugin entry is in (section 10.2). |
| Apache License 2.0 for every package; every text a user sees in plain English | As in the rest of the project. |

### 3.2 Open: Erik confirms these in phase 0

The column "Default" is Claude's advice from the plan; build with it unless Erik says otherwise. Anything that cannot be undone or that reaches outside the repository still waits for his explicit yes when it comes up, even when he agreed in principle (section 16).

| # | Decision | Default | Why |
|---|---|---|---|
| 1 | Make the repository public | Yes, in phase 2. First the npm name is claimed and the history is checked for personal data, such as commit author e-mail addresses. If Erik wants those gone, the history must be rewritten before the repository goes public, which needs a force-push. A rewrite alone is not enough on GitHub: the pull requests keep their old commits, with the old addresses, and only GitHub Support can remove those. A new repository with the rewritten history avoids that, but leaves the pull requests behind. Phase 0 found an address of Erik's as the author of 23 commits. | npm provenance, and importing the skill in Lovable, Bolt and Replit, work only with a public repository. |
| 2 | Names | `la2l` on npm; `nl.lloydstellar:la2l` and `nl.lloydstellar:la2l-ktx` on Maven Central (since decision 8: in our own Maven repository); the skill `la2l-send-to-ableton` | Short, and the product's own name. On 2026-10-17 `la2l` was still free on npm, PyPI and pub.dev. |
| 3 | Order on Android | First LA2L Sender as a share target, then the Android SDK; an Android app of our own only when that is not enough | No Play account and no closed test needed, and it fits Erik's earlier choice for sharing on Android. The share target works only as a web app installed from Chrome or Samsung Internet. |
| 4 | Test receiver | Yes: a page, in the CLI, and a local variant without internet | Without Ableton, web developers and AI agents cannot test otherwise. The local variant keeps CI and AI agents off the real server. |
| 5 | Languages | Now TypeScript/JavaScript and Kotlin/Java; Python, Dart and React Native on request | That covers nearly all web and Android apps. Music apps with a C++ engine upload from their Kotlin or Java layer, so no C++ SDK is needed. |
| 6 | Developer registration | No API key; storage limits before the launch; an optional `X-LA2L-Client` header | See 3.1 and section 7. |
| 7 | Button and brand | "Send to Live" with the LA2L logo, no Ableton logo | Ableton and Live are Ableton's trademarks; the button must not look like an official Ableton feature. |
| 8 | Maven Central | Erik asks Sonatype, before phase 5, to confirm that the free Android SDK may be published free of charge | Since 2026-10-01 Maven Central asks a paid subscription for artifacts that support a commercial product or service, "service-dependent SDKs" included, and Sonatype does not say exactly what still counts as ordinary community open source. If Sonatype says no: a Maven repository of our own on lloydstellar.nl, which costs developers one extra line in Gradle. |

**Erik's answers (2026-10-18).** 1: yes, in phase 2, and his address may stay in the old commits; the switch itself still waits for his yes at that moment. 2 to 7: the defaults. 8: a Maven repository of our own on lloydstellar.nl right away, without asking Sonatype. 9: `MAX_TOTAL_STORAGE_MB` 10 GB. 10: the storage warning by e-mail from the VPS. 11: Android builds only in GitHub Actions, never on the VPS.

---

## 4. Phase 0: look before you change anything

```bash
cd ~/la2l-server && git status -sb && git log --oneline -3
node --version; npm --version; docker --version; docker compose version
nproc; free -h; df -h /; docker system df
java -version 2>&1 | head -1; echo "ANDROID_HOME=${ANDROID_HOME:-}"
gh auth status 2>&1 | head -3
npm view la2l name 2>&1 | tail -1          # an E404 means the name is still free
curl -sS https://lloydstellar.nl/la2l/api/health
(cd server && docker compose ps)
```

Then send Erik one message in Dutch:

- what you found, briefly, and what phase 1 changes on the server;
- the decisions of section 3.2, each with its default, numbered, so he can answer per number ("1 ja, 8 later");
- how he wants to hear that the server's storage fills up (section 7.1): an e-mail from the VPS, a message to a webhook he picks, or only the log for now;
- what Android builds would need on this machine (section 12.5), so he can say yes or no well before phase 5;
- which accounts he will need, and when: npm with 2FA (phase 2), Cursor and Lovable for the AI test (phase 3), the Central Portal of Sonatype with a DNS record on lloydstellar.nl and a GPG key (phase 5).

Change nothing on the VPS in this phase.

---

## 5. Layout

```
docs/
  server-api.md, manifest.md       the contract in words; you add to them
  openapi.yaml                     the app side, OpenAPI 3.1 (6.1)
  app2live-1.schema.json           the manifest, JSON Schema (6.2)
  developers/                      the developer pages, the paste text, the AI test results
sdk/
  BUILD-PROMPT.md                  this brief
  CLAUDE.md                        write it in phase 1 and keep it up to date, like server/CLAUDE.md
  fixtures/                        shared manifests and WAV files with the expected verdicts (6.3)
  js/                              npm: la2l (9)
  android/                         our Maven repository: nl.lloydstellar:la2l and la2l-ktx (12)
skills/la2l-send-to-ableton/       the skill (10.2); skills/ is the root of its Claude Code plugin
.claude-plugin/marketplace.json    the Claude Code plugin entry for the skill (10.2)
examples/
  web-drum-machine/                a web drum machine that sends its loop (9.8)
  android-recorder/                an Android app that records a loop and sends it (12.4)
server/public/                     gains the test receiver, vendor/la2l.js, the PWA files and the developer pages
```

The root `CLAUDE.md` has a row for the kit in its table of parts. Keep its "Where" and "State" up to date as the parts get built.

---

## 6. The contract, machine-readable (phase 1)

### 6.1 `docs/openapi.yaml`

OpenAPI 3.1 for the app side and `GET /health`: every path, parameter, body and answer of `docs/server-api.md`, every error status with its `{"error": "..."}` shape and the exact texts as examples, the bearer token as a security scheme, and `https://lloydstellar.nl/la2l/api` as the server. Write the descriptions in short plain English: AI tools read this file as documentation, and developers generate clients from it in any language. Leave the device side out; apps never call it.

A test proves that spec and server agree: every path and method in the spec is answered by the real server (not with 404 or 405), and every error text in the spec occurs in `server/src`. Lint the file with a pinned OpenAPI linter from the devDependencies of `sdk/js`.

### 6.2 `docs/app2live-1.schema.json`

JSON Schema (draft 2020-12) for the manifest as an app sends it to `POST /packages`, with the server's rules: every sound valid, `bytes` and `sha256` required. Field descriptions from `docs/manifest.md`. Say in its description that the device itself is more lenient: it imports a package without `bytes` and `sha256`. What a schema cannot say (two sounds with one file, 200 MB in total) the fixtures cover.

### 6.3 `sdk/fixtures/`

Manifests and small WAV files, good and bad, each with its verdict: accepted (with its warnings) or refused (with the exact text). A script makes the WAV files, so they stay small and reproducible. At least:

- **WAV**: PCM 8, 16 and 24 bit; float 32 and 64; mono and stereo; `WAVE_FORMAT_EXTENSIBLE`; a `LIST` chunk before `fmt `; a chunk of odd size; a data size of 0 or `0xFFFFFFFF` (a recorder that never finished the header); 12-bit PCM; a compressed WAV (format 85); RF64; 3 channels; 4 kHz; no `data` chunk; an empty `data` chunk; a text file named `.wav`; a file of 10 bytes.
- **Manifests**: the example of `docs/manifest.md`; no sounds; 33 sounds; more than 200 MB; `app2live/2`; a bad file name; two sounds with one file; a name of 41 characters; an unknown role; a one-shot with `bpm`; a sound without `bytes` or `sha256`.

`expected.json` holds the verdicts: the device's, and the server's where the server is stricter. The device is the source of truth: a new test in the root, `tests/fixtures.test.js`, runs `src/node/manifest.js` and `src/node/wav.js` over every fixture and must match `expected.json`. The server's tests run the same fixtures through `POST /packages` and `PUT`. Every SDK runs them through its own checks and follows the server's verdicts, because it sends to the server. When two parts disagree, the device is right unless Erik decides otherwise.

### 6.4 The share text

Android hands a web app only the shared files, a title and a text (section 11.1). So an app that shares sounds with LA2L Sender can put an `app2live/1` manifest in the text. Write this down in `docs/manifest.md` in phase 1; it is built in phases 4 and 5:

- The text holds one JSON object with `"schema": "app2live/1"`. LA2L Sender reads from the first `{` to the last `}`, so an app may put a line of its own around it.
- `items[].file` is the name of a shared file. `package_id`, `bytes` and `sha256` may be left out: LA2L Sender fills them in.
- A shared file without an item gets the defaults, which the user can change before sending. The shared title becomes the package's `title` when the manifest has none.

---

## 7. Server changes

All in `server/`, each with `docs/server-api.md` updated in the same commit, a new server version (0.7.0 for phase 1), both test suites green, and device 0.1.1 still working.

### 7.1 Storage limits (phase 1)

Today one address can make 120 computers an hour (`POST /pair/start`, 20 per 10 minutes), pair them with itself, and give each 1 GB of waiting packages. When the disk fills up, everyone gets 507, and the website on this VPS suffers too. Add:

- **Per address**: what the packages sent from one address hold together while they upload or wait, counted as the rate limits count (an IPv6 address by its /64). `MAX_ADDRESS_STORAGE_MB`, default 2048. Keep the address with a package only until its files are deleted. Over the limit: `507 {"error": "Too many sounds wait from this address. Try again later."}`.
- **For the whole server**: `MAX_TOTAL_STORAGE_MB`, set in phase 0 with Erik from the disk size, so the server stops taking sounds long before the disk is full. `MIN_FREE_DISK_MB` stays as the last line.
- **A warning** when the total passes `STORAGE_WARN_PERCENT` (default 80): a loud log line at most once an hour, plus the way Erik chose in phase 0.

### 7.2 Remove one app (phase 1)

Today Live can only unpair all apps at once. Add `DELETE /apps/{id}` (device token): it revokes that one app token and deletes that app's packages that still upload or wait. For a token that leaked, or an app nobody wants any more. `GET /apps` gains an opaque `id` per app: not the database row number, and not the app's own `app_id`. Older devices ignore it. An unknown app, or another computer's: `404 {"error": "Unknown app."}`.

The button for it in the device's Settings is a device change and not part of this brief. When this call is merged, tell Erik; the device gets the button in a later version, built and tested the usual way (`CLAUDE.md`).

### 7.3 Headers (phase 1)

- Add `Retry-After` to `Access-Control-Expose-Headers` in `server/src/http-util.js`. Today a web app cannot read how long to wait after a 429.
- Allow an optional `X-LA2L-Client` header, for example `la2l-js/0.1.0 (Web808)`: add it to `Access-Control-Allow-Headers`, write it on the request log line (cleaned, at most 100 characters), and keep the last value per app. Then the log shows which SDK versions still run, before anything is ever phased out. The SDKs send it from their first version.

### 7.4 Test receivers (phase 1)

To the server, a test receiver (section 8) is a computer. `POST /pair/start` accepts an optional `"test": true`, and the server marks that computer as a test receiver. A test receiver without a call for 7 days is unpaired and removed with its apps and packages, so forgotten receivers clean themselves up. Real computers are still never removed for being quiet (`server/BUILD-PROMPT.md`, section 9).

### 7.5 Static pages

Through the list of allowed files in `server/src/static.js`, with the same strict headers. A longer list may be built from a folder at start, as long as no URL path ever becomes a file path.

| What | Address under `https://lloydstellar.nl/la2l/` | Phase |
|---|---|---|
| The test receiver | `receiver` | 1 |
| The web SDK for the browser, built from `sdk/js` and committed (9.7) | `vendor/la2l.js` | 1, 2 |
| The drum machine example | `examples/drum-machine/` | 2 |
| The developer pages, each with a `.md` twin; `llms.txt` and `llms-full.txt`; the privacy statement | `developers/`, `llms.txt`, `llms-full.txt`, `privacy` | 3 |
| The PWA files, and an answer to the share POST | `manifest.webmanifest`, `sw.js`, icons, `share` | 4 |

### 7.6 A big upload from a phone (phase 1)

The server ends an upload after 15 minutes (`requestTimeout` in `server/src/main.js`), closes a connection that sends nothing for 60 seconds, and cannot resume an upload. Find out early whether that is enough, before phase 2 builds the SDK's uploads on it: Erik sends 150 MB from his phone over 4G.

So that he needs no large file on his phone, LA2L Sender gets a hidden option, `https://lloydstellar.nl/la2l/?big`, that makes a 150 MB WAV in the browser (a quiet tone) and sends it as a one-shot named "Big test". Make the file the same every time, so the page can carry its `bytes` and `sha256` as constants instead of hashing 150 MB on a phone. Show how long the upload took. If it fails, find out why (the phone, nginx, the time limits) and tell Erik before you go on.

---

## 8. The test receiver

A stand-in for LA2L in Ableton Live, for developers and AI agents without Ableton. It behaves as the device does, through the device side of the API only:

1. It asks for a code (`POST /pair/start` with `"test": true` and the name "Test receiver") and shows it. The app under test pairs with it as it would with Live.
2. It looks for new packages by itself, every few seconds.
3. Per package it downloads the manifest and the files, checks `bytes`, `sha256` and the WAV header as the device does, and works out what Live would do with every sound: the track name ("Kick (Web808)"), loop or one-shot, warp mode, tempo and length in beats.
4. It acks the package (`imported`, `partial` or `failed`, with the device's texts), so the app sees the same status as with Live.
5. It shows a report per package and keeps the last ones.

It comes in three forms:

| Form | What | Phase |
|---|---|---|
| A page | `https://lloydstellar.nl/la2l/receiver`, against the real server, with the checks of `sdk/js` (9.3) through `vendor/la2l.js`. It shares its origin with LA2L Sender, so it keeps its own keys in `localStorage` and never touches the Sender's. | 1 |
| `npx la2l test-receiver` | The same in a terminal, against the real server. | 2 |
| `npx la2l test-receiver --local`, and `startTestReceiver()` from `la2l/testing` | An in-memory server for the app side plus the simulated device, on `127.0.0.1`: no internet, no rate limits. It prints its address and a code, and the app under test points the SDK at it with the option `server`. For CI and AI agents. Start from the shape of `tests/mock-server.js`, and prove that it answers like la2l-server by running the same app-side tests against both. | 2 |

---

## 9. The web SDK: `la2l` on npm (phase 2; its checks in phase 1)

### 9.1 The package

- TypeScript, compiled to ESM only, with type definitions. It works in browsers, in Node.js 22.12 and newer (there `require()` loads ESM too, so CommonJS projects can use it), in Deno and in Bun. Node.js 20 is left out: it stopped getting security fixes in April 2026. No runtime dependencies.
- Entry points: `la2l` (client, audio, checks), `la2l/button` (the web component, browser only), `la2l/testing` (the test receiver, Node only), and the CLI as `bin`.
- Published files: `dist/`, `docs/`, `README.md`, `LICENSE`. Nothing else.

### 9.2 The client

The plan showed Erik this shape; keep it:

```js
import { LA2L, wavFromAudioBuffer } from 'la2l';

const la2l = new LA2L({ appName: 'Web808' });
if (!la2l.paired) await la2l.pair(codeFromUser); // "K7P 42Q"

const delivery = await la2l.send({
  title: 'Treinbeat',
  bpm: 92,
  sounds: [
    { name: 'Kick', audio: wavFromAudioBuffer(kickBuffer), kind: 'loop', role: 'drums' },
    { name: 'Robot hallo', audio: robotWavBlob, kind: 'oneshot', role: 'vocal' },
  ],
  onProgress: (share) => (bar.value = share),
});
await delivery.imported(); // when the user clicks Import in Live
```

- **Options**: `appName` (required); `appId` (default: a UUID made once and stored); `server` (default `https://lloydstellar.nl/la2l/api`, or the local test receiver's address); `storage` (default `localStorage` in a browser and a file in the user's config folder in Node, or the app's own `{ get, set, remove }`); `fetch`.
- Every app keeps its token under a key of its own (from `appId` or `appName`), so two apps on one domain do not revoke each other's token.
- `pair(code)`, `me()`, `unpair()`, and the properties `paired` and `deviceName`.
- `send()` checks everything before the first byte goes out, with the server's texts: the manifest rules (as strict as the server), the WAV headers, the limits. Then it works out `bytes` and `sha256`, announces the package, uploads the files one by one with progress, and commits. Over 32 sounds or 200 MB it refuses with a clear error, and the docs show how to split.
- **`Delivery`**: `packageId`, `status()`, `imported()` (asks every few seconds; resolves on `imported` or `partial` with the result per sound, rejects on `failed` or `expired`), `cancel()` (`DELETE`).
- **Errors** are one class, `La2lError`: the server's text as its message, the HTTP status, a `code` an app can switch on (`not_paired`, `bad_code`, `rate_limited`, `server_full`, `bad_package`, `bad_wav`, `network`, …) and `retryAfter`. On a 401 the client forgets the token and throws `not_paired`.
- **Retries**: a 429 after `Retry-After`; a 5xx or a broken connection after 1, 2 and 4 seconds. A failed upload starts that file again, because the server cannot resume.
- It sends `X-LA2L-Client: la2l-js/<version> (<appName>)` with every call.
- It never puts the token in a URL, a log or an error message.

### 9.3 Audio and checks

- `wavFromAudioBuffer(buffer, { bits: 16 | 24 | 32 })` and `wavFromSamples(channels, sampleRate, options)`: a WAV `Blob` from Web Audio or from raw samples (32 means float).
- `toWav(fileOrBlob)`: mp3, m4a and the other formats the browser can decode, through `decodeAudioData`, to a 16 or 24-bit WAV. Browser only.
- `checkWav(blob)`, `checkManifest(manifest)` and `planSound(...)`: the device's checks and its plan for a sound (warp mode, tempo, length, track name), ported from `src/node/manifest.js` and `src/node/wav.js` with the same texts, and proven against `sdk/fixtures` in CI. These come first, in phase 1, because the test receiver page needs them.
- SHA-256 in pieces, over slices of the `Blob`: WebCrypto can only hash a whole buffer at once, and a 200 MB file does not fit in a phone's memory. Use `node:crypto` where it exists. Test it against the standard test vectors, and against `node:crypto` on random data.

### 9.4 The button

`<la2l-send-button app-name="Web808">`, a web component in `la2l/button`:

- It shows "Send to Live" with the LA2L logo. Not paired yet: a small dialog with one field for the code, one sentence ("In Live, click Pair app in LA2L and type the code it shows."), and a link for people who do not have LA2L yet.
- The page gives it the sounds: a `sounds` property with a function that returns them when the button is clicked (so the page renders only then), or a `la2l-request` event.
- Then it shows the progress and the status in words: "Sending 2 sounds…", "Waiting for Import in Live", "In Live".
- Short, plain steps; it works with the keyboard and a screen reader; an app in another language can replace the texts; the looks can be changed with CSS custom properties.
- It works without a build step: one self-contained, minified file from jsDelivr, with a fixed version and an `integrity` hash per version in the docs:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/la2l@0.1.0/dist/button.js"
        integrity="sha384-..." crossorigin="anonymous"></script>
<la2l-send-button app-name="Web808"></la2l-send-button>
```

### 9.5 The CLI

`npx la2l pair`, `npx la2l send kick.wav --loop --bpm 92 --role drums` (several files, `--title`, `--name`), `npx la2l status`, `npx la2l unpair`, `npx la2l test-receiver [--local]`, and from phase 3 `npx la2l agents-md` (10.1). So scripts in Python or a shell can send too, without an SDK of their own. The token lives in a file only the user can read in the user's config folder, or in `LA2L_TOKEN`.

### 9.6 Docs in the package

The manual lives in `node_modules/la2l/docs`, matching the installed version: getting started, the API, sending from Web Audio, the button, testing with the test receiver, and the errors with what to do about each. Short pages with working examples first. AI tools find them there (section 10).

### 9.7 LA2L Sender on the SDK

LA2L Sender becomes the SDK's reference app and its best test: `server/public/sender.js` uses the SDK from `server/public/vendor/la2l.js`. A script builds that file from `sdk/js` and it is committed, so the server's Docker image still needs no npm; CI fails when the committed copy differs from a fresh build. The page looks and works as before, and browsers that are paired today stay paired: through the `storage` option the Sender keeps its keys `la2l.token`, `la2l.deviceName`, `la2l.appId` and `la2l.recent`.

### 9.8 The example

`examples/web-drum-machine/`: four sounds and 16 steps, rendered with an `OfflineAudioContext` and sent with the button, the loop and each sound as a one-shot. Hosted at `https://lloydstellar.nl/la2l/examples/drum-machine/`, so Erik can test it without installing anything. It is also what the AI test asks the tools to build (10.3).

### 9.9 Tests

- Unit tests for every part, in Node (it has `fetch`, `Blob` and WebCrypto), on every Node.js version that still gets security fixes.
- The whole chain on every pull request: the SDK sends a package to the real server code (`startServer` from `server/test/helpers.js`), and the real device code imports it in the simulated Live, as `server/test/device-e2e.test.js` does.
- The same app-side tests against the local test receiver and against the real server.
- One browser test in headless Chromium, for the button and LA2L Sender.

---

## 10. The AI layer (phase 3)

### 10.1 More than a skill

In Vercel's evals (January 2026) agents solved 53% of the tasks without docs, 53% with only a skill, and 79% with a skill plus the instruction to use it. A docs index of 8 KB in `AGENTS.md`, pointing to docs inside the project, reached 100%. An agent often leaves a skill unused. So the AI layer has six parts:

1. **The npm SDK, with types and with its docs in the package** (9.6). The less code an AI writes itself, the less goes wrong: ten lines instead of three hundred. Lovable, Bolt and v0 build in TypeScript and install npm packages.
2. **`npx la2l agents-md`** writes an index of a few KB into `AGENTS.md`, pointing to `node_modules/la2l/docs`, as Next.js does. It goes between markers, so a second run replaces it. When the project has a `CLAUDE.md`, the index goes there too.
3. **The skill `la2l-send-to-ableton`** (10.2).
4. **A paste text** for the Knowledge of Lovable or Bolt, `docs/developers/paste-text.md`. Those tools have no terminal, so the text must work on its own: install, the send example, the pitfalls, a link to the docs.
5. **`llms.txt`, `llms-full.txt` and a `.md` version of every developer page.** Cheap, but expect little: 97% of llms.txt files got no request at all in May 2026. It helps when the paste text or the skill points to it.
6. **Context7.** Erik adds the repository once (free for public repositories). Bolt and v0 offer Context7 as a ready-made connection.

### 10.2 The skill

`skills/la2l-send-to-ableton/`, following the Agent Skills specification (agentskills.io): a `SKILL.md` of at most 500 lines, `references/` (API, manifest, web, Android) and `assets/` (example code). Its description starts with "Use when…" and names Ableton Live, Send to Live and LA2L, so tools find it.

- **When**: the user wants to send audio from an app to Ableton Live, wants a Send to Live button, or names LA2L.
- **Steps**: find out the platform, install the SDK, add a pair screen with a code field, render the audio as WAV, fill in per sound the name, loop or one-shot, role and BPM, send, and show the status.
- **Pitfalls**: forgetting `kind: "loop"`, names over 40 characters, a file that is not a WAV, a token in a URL or a log.
- **Check your own work**: `npx la2l test-receiver --local` plays Live in the terminal, so the agent can test its work end to end without Ableton.

How it gets into each tool:

| Where | How |
|---|---|
| Claude Code, Codex, Cursor, Copilot, Gemini CLI | `npx skills add lloydstellar/Lloyds-app2live` |
| Claude Code, as a plugin | `/plugin marketplace add lloydstellar/Lloyds-app2live`, then `/plugin install la2l@la2l`. The marketplace entry `.claude-plugin/marketplace.json` points to `skills/` as the plugin, with `skills/.claude-plugin/plugin.json`, so the skill has one copy for every tool. `claude plugin validate` checks both. |
| Lovable, Bolt, Replit | Import the GitHub address of the skill folder (public repositories only) |
| claude.ai | Upload a ZIP of the skill folder |

### 10.3 The AI test

Before the launch, measure whether all this works. Claude Code, Cursor and Lovable each build the web drum machine five times from an empty project, with only the skill and the paste text, for this prompt:

> Build a small web drum machine with four sounds and a 16-step pattern. Add a Send to Live button that sends the loop to Ableton Live with LA2L.

A run passes when its package gets through the test receiver as a loop with a tempo. The phase passes when at least four of the five runs pass for each tool. Write the prompt, the check and every result (date, tool and version, passed or not, what went wrong) in `docs/developers/ai-test.md`. Erik runs Cursor and Lovable with his accounts; you may run Claude Code yourself (`claude -p` in an empty folder) when he agrees. When a tool fails, improve the skill, the paste text or the docs, never the test.

### 10.4 Developer pages and privacy

Under `https://lloydstellar.nl/la2l/developers/`: start here; web; Android; sharing to LA2L Sender from an app (11.4, built with phase 4, when LA2L Sender can take a share); the REST API, with `openapi.yaml`; testing; AI tools; the button and the brand rules. Short pages, examples first. One source per page for both the HTML and the `.md` version; a small converter in `tools/` is fine, without runtime dependencies on the server.

Until the launch the server asks search engines to leave the developer pages out (`X-Robots-Tag: noindex`; `DEVELOPER_PAGES_INDEXED` in `server/src/static.js`).

The privacy statement at `https://lloydstellar.nl/la2l/privacy`: what the server keeps (computer names, app names, packages for at most 24 hours, results for 7 days, addresses for the rate limits, the storage limits and the log), why, for how long, and who to ask. Erik approves the text before it goes online.

---

## 11. Android without code: LA2L Sender as a share target (phase 4)

LA2L Sender becomes an installable web app (PWA) that registers as a share target. The user installs it once from Chrome and pairs it once. From then on LA2L is in the share menu of every app that shares audio, without the Play Store and without a review. This phase needs only phase 2, so it may run alongside phase 3.

### 11.1 What arrives

Android hands a PWA only the files, a title and a text; every other extra is dropped (`WebApkShareTargetUtil.java` in Chromium). That is why the manifest travels in the text (6.4).

### 11.2 What it takes

- `audio/*`, `.wav` and `.zip`: n-Track exports stems as a ZIP of WAV files. Read ZIPs in the browser; `DecompressionStream('deflate-raw')` (Chrome 103 and newer) inflates their entries without a library.
- mp3 and m4a become WAV in the browser (`toWav`): BandLab on Android exports only M4A.
- The user fills in per sound: loop or one-shot, BPM and role. None of the music apps we looked at passes those on when it shares.
- More than 200 MB or 32 sounds: split into several packages, titled "Title (1 of 2)".

### 11.3 How

- `manifest.webmanifest`: name "LA2L Sender"; icons from the LA2L logo (192 and 512 pixels, also maskable); `start_url` and `scope` `/la2l/`; `display: standalone`; and `share_target` with `action: "/la2l/share"`, `method: "POST"`, `enctype: "multipart/form-data"`, and `params` for `title`, `text` and `files` (`audio/*`, `.wav`, `.zip`, `application/zip`).
- `sw.js`, scope `/la2l/`: it catches the POST to `/la2l/share`, keeps the files in IndexedDB, and opens LA2L Sender with them. It caches nothing else, so the pages stay as fresh as now.
- When the POST reaches the server anyway (the service worker was not running yet), the server answers with a clear page, "Open LA2L Sender once from your home screen, then share again.", instead of an error, without reading the body.
- Limits: Android only, installed from Chrome (any phone) or Samsung Internet (Samsung phones only). Not Firefox, not iOS. The pages say so.

### 11.4 For app makers

The developer pages show how an Android app shares WAV files with LA2L Sender, with a manifest in the text (`ACTION_SEND` or `ACTION_SEND_MULTIPLE` with `EXTRA_TEXT`). The Android SDK does it for them (`La2lShare`, 12.3). So an app without network code can still pass on its BPM and loops.

---

## 12. The Android SDK (phase 5)

### 12.1 Shape

The plan showed Erik this shape; keep it:

```kotlin
val la2l = La2l(context, appName = "Web808")
if (!la2l.isPaired) la2l.pair(codeFromUser)

val delivery = la2l.send(title = "Treinbeat", bpm = 92.0) {
    sound("Kick", Wav.fromPcm16(kickSamples, sampleRate = 48000, channels = 2), kind = Kind.LOOP, role = Role.DRUMS)
    sound("Robot hallo", robotWavFile, kind = Kind.ONESHOT, role = Role.VOCAL)
}
delivery.awaitImport()
```

- **`nl.lloydstellar:la2l`**: an Android library in Java, minSdk 24 (the AndroidX default), without dependencies. Calls run on a background executor and return a `CompletableFuture`; callback variants report on the main thread. HTTP through `HttpURLConnection`.
- **`nl.lloydstellar:la2l-ktx`**: Kotlin on top, with suspend functions and the `send { sound(...) }` builder above. It depends on `kotlinx-coroutines`, which is why it is a separate artifact, as AndroidX does with its `-ktx` libraries.
- The same client as on the web (9.2): pairing, sending, status, errors, retries, progress, and `X-LA2L-Client: la2l-android/<version> (<appName>)`.
- The token lives in the app's private storage (`SharedPreferences` in private mode).

### 12.2 Audio

`Wav.fromPcm16` and `Wav.fromFloat` turn PCM samples into a WAV, in memory or into a file. `WavCheck` and the manifest checks are the device's, with the same texts, proven against `sdk/fixtures`. SHA-256 streams through `MessageDigest`.

### 12.3 Sharing and the background

- `La2lShare.intent(context, sounds, ...)` builds a normal share intent with the WAV files (through the SDK's own `FileProvider`) and the manifest as `EXTRA_TEXT`, for apps that want no network code (11.4).
- A recipe in the docs for large uploads with WorkManager, so sending goes on when the app goes to the background. A recipe, not a dependency.

### 12.4 Example and tests

- `examples/android-recorder/`: it records with `AudioRecord`, lets the user mark a loop with its BPM, and sends it. Next to it a small Java example. CI builds both.
- JVM tests for the checks (with the fixtures), the WAV writer and the client, and integration tests against the real server code, started from the test (CI has Node).

### 12.5 Building on this VPS

Erik decided in phase 0: Android builds run only in GitHub Actions, never on the VPS (it has 3.8 GB of memory and serves other sites). GitHub's Ubuntu runners have a JDK 17 and the Android SDK, so CI needs nothing extra. An APK for Erik to install comes from CI as an artifact.

As built: Gradle 8.14 through `gradle/actions/setup-gradle` (no wrapper in the repository yet), the Android Gradle Plugin 8.13 and Kotlin 2.3, the last versions whose build files are well known; moving to the Android Gradle Plugin 9 is a later step. The Java library calls return a `CompletableFuture` (`pairAsync`, `sendAsync`) and have a `Callback` variant; in Kotlin, `la2l-ktx` gives `pair`, `send { }` and `awaitImport()` as suspend functions. A Java constructor cannot take named arguments, so the shape of 12.1 reads `La2l(context, "Web808")` and `Wav.fromPcm16(samples, 48000, 2)` in Kotlin.

---

## 13. Publishing and versions

Everything is published from GitHub Actions in this repository, never by hand from a computer, except the npm placeholder below.

| Where | How | What Erik arranges |
|---|---|---|
| npm, `la2l` | Trusted publishing from GitHub Actions (OIDC), so no npm token is stored as a secret. Provenance comes with it, but only from a public repository. A tag `js-v0.1.0` publishes. | An npm account with 2FA. Before the repository goes public he claims the name with an empty version 0.0.1 that he publishes himself (trusted publishing can only be set up for a package that exists), and then links this repository's workflow to it on npmjs.com. |
| A Maven repository of our own, `nl.lloydstellar:la2l` and `la2l-ktx` | At `https://lloydstellar.nl/la2l/maven/` (decision 8): developers add that address to `repositories` in Gradle. GitHub Actions builds and signs the artifacts on a tag `android-v0.1.0`; how they reach the VPS is settled with Erik in phase 5, for example a release asset that the VPS fetches, so no key to the VPS is stored on GitHub. Settled on 2026-10-18: the workflow attaches the repository to a GitHub release as a ZIP, and `server/deploy/maven-sync.sh` on the VPS fetches every release, checks its signatures and checksums, and puts it in the volume `la2l-maven` that la2l-server serves from 0.12.0. | A GPG key as a GitHub secret, in phase 5. Made on 2026-10-18, with Erik's yes: `SIGNING_KEY` and `SIGNING_PASSWORD`; the public key is `sdk/android/signing-key.asc`. |
| jsDelivr and unpkg | Automatic from npm. `dist/button.js` is self-contained and minified; the docs give its `integrity` hash per version. | Nothing. |
| Skills | Straight from the repository; there is no registry. | Nothing. |
| Context7 | Added once. | Adds the repository. |

Versions:

- The SDKs follow semver: 0.x until real apps run on them, 1.0 when the app side is declared stable.
- The server gets a new version with every change, as now. The device changes only when it must.
- The npm SDK is ESM only, for Node.js 22.12 and newer. The Android SDK needs minSdk 24.

---

## 14. CI

Extend `.github/workflows/test.yml`, so every push and pull request runs:

- the device tests and the server tests, as now, both with the fixtures (6.3);
- `sdk/js`: install from the lockfile, build, test on every Node.js version that still gets security fixes, the browser test, and the check that `server/public/vendor/la2l.js` matches a fresh build;
- `docs/openapi.yaml` and `docs/app2live-1.schema.json`: linted, and their agreement with the server tested;
- from phase 5, `sdk/android`: the Gradle tests and builds with Node for the integration tests, and both example apps.

Publishing has workflows of its own, started by tags, each with only the permissions it needs.

---

## 15. Phases

Every phase ends with: all tests green, locally and on GitHub; a pull request; the server deployed when the phase changed it (`git pull && bash deploy/update.sh` in `server/`, as `server/CLAUDE.md` says); and a short Dutch message to Erik that says what to test and what he should see. Then wait for him. After his yes: merge with a merge commit, delete the branch, and keep main what runs on the VPS. After a no: fix it, or put main back on the VPS.

| Phase | Build | Erik tests |
|---|---|---|
| **0. Look** | Section 4. No changes. | Answers the decisions and the questions. |
| **1. Foundation** | `openapi.yaml`, the JSON Schema, the fixtures with their tests on device and server; `sdk/js` with the ported checks and the build of `vendor/la2l.js`, no client yet; the server changes of 7.1 to 7.4 (server 0.7.0); the test receiver page; the big upload option (7.6); the share text in `docs/manifest.md`; `sdk/CLAUDE.md`; CI. | He opens a private browser window, because pairing LA2L Sender with a new code replaces its pairing with Live. In one tab of it he opens `https://lloydstellar.nl/la2l/receiver`, which shows a code. In a second tab LA2L Sender pairs with that code and sends the test snare (`test-file-voor-max.wav` from `lloydstellar.nl/test/`) as a loop named Snare, role drums, 135 BPM. The receiver shows "Snare (LA2L Sender)" as a loop at 135 BPM in Beats mode, and the Sender says "In Live: 1 of 1 sound." Then on his phone, paired with Live, over 4G with Wi-Fi off: `https://lloydstellar.nl/la2l/?big` sends 150 MB, and Import in Live brings in "Big test". Self test in Live still says "server OK", and a normal send and Import still work. |
| **2. Web SDK** | `la2l` 0.1.0: client, audio, button, CLI, docs, the CLI and local test receivers; LA2L Sender on the SDK; the drum machine example; with Erik's yes, the repository public and 0.1.0 on npm. | On `https://lloydstellar.nl/la2l/examples/drum-machine/` he makes a beat, clicks Send to Live and pairs with Live. After Import the loop plays in time, also at another Set tempo. LA2L Sender still works, and his browsers are still paired. |
| **3. AI layer** | The skill and its plugin entry, `agents-md`, the paste text, `llms.txt` and `llms-full.txt`, the developer pages, the privacy statement, Context7, the AI test. | Runs the AI test in Cursor and Lovable: at least 4 of 5 runs per tool pass. Reads the developer pages, and approves the privacy statement. |
| **Launch** | Not part of this brief: device 1.0 can be downloaded (frozen with Freeze and tested on a Mac), and the developer pages are online. | Picks the moment. |
| **4. Android without code** | The PWA and the share target (section 11), with a new server version. | Installs LA2L Sender from Chrome on his Android phone and pairs it with Live. In FL Studio Mobile or n-Track he exports a WAV, shares it to LA2L Sender, marks it as a loop with its BPM and sends it. Import in Live brings it in, in time. |
| **5. Android SDK** | `la2l` and `la2l-ktx` 0.1.0, `La2lShare`, the recorder example and the Java example; with Erik's yes, in our own Maven repository on lloydstellar.nl. | Installs the example app (an APK from CI), records a loop and sends it. After Import it plays at the right tempo in Live. |

---

## 16. Working with Erik

- Erik writes Dutch: answer in Dutch. Short, the answer first, then what he must do. Code, comments, commit messages, docs, API texts and every page are in English.
- Find out what you can yourself; ask only what only he knows or decides.
- Always ask first, at the moment it comes up, before:
  - publishing anything: npm (the 0.0.1 too), Maven Central, Context7, a skill directory;
  - making the repository public, rewriting its history, or force-pushing;
  - creating accounts, keys or secrets; DNS changes are Erik's to make;
  - contacting anyone outside the project, such as Sonatype;
  - installing system packages or large toolchains, or changing the web server, the firewall, other sites or other containers;
  - deleting anything outside this repository and the server's volume;
  - anything that costs money.
- Show evidence: the number of passing tests, `curl` output, the commit, the CI run.
- Never put a token, a password or a key in the repository, a commit message, a log or a message to Erik.
- When the device must change (only the button of 7.2 is planned), say why first: a device change needs a new device version and a test in Live (`CLAUDE.md`).
- When this brief turns out wrong about something, say so, and fix the brief in the same pull request.

---

## 17. Done means

- A web developer installs `la2l`, writes about ten lines, and the user's sounds arrive in Live, in time. Without Ableton they test it with the test receiver.
- An AI tool with the skill or the paste text builds that in at least 4 of 5 tries.
- An Android user shares a WAV from a music app to LA2L Sender, and it arrives in Live.
- An Android developer adds `nl.lloydstellar:la2l` and sends from Java or Kotlin.
- Device 0.1.1 and today's LA2L Sender still work. All tests are green, locally and on GitHub.
- `docs/server-api.md`, `docs/manifest.md`, `docs/openapi.yaml`, the schema, `sdk/CLAUDE.md` and the developer pages describe what was built.

---

## Appendix A: sending by hand

What every SDK does, with `curl`, for the docs and for a quick check:

```bash
BASE=https://lloydstellar.nl/la2l/api

# 1. Pair, with the code LA2L shows in Live
curl -sS -X POST $BASE/pair/claim -H 'Content-Type: application/json' \
  -d '{"code":"K7P 42Q","app_name":"curl test","app_id":"curl-1"}'
#   -> {"app_token":"la2la_...","device_name":"STUDIO-PC"}
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

## Appendix B: sources

Checked on 2026-10-17. Check again before you rely on one for something that cannot be undone.

- Agent Skills: https://agentskills.io/specification; `npx skills`: https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem
- Vercel's evals, skills against `AGENTS.md`: https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals
- Skills in Lovable, Bolt and Replit: https://docs.lovable.dev/features/skills.md, https://support.bolt.new/building/skills.md, https://docs.replit.com/features/agent/skills
- Context7 in Bolt and v0: https://bolt.new/blog/introducing-connectors, https://v0.app/docs/MCP
- llms.txt use: https://ppc.land/llms-txt-adoption-rises-8-8x-but-97-of-files-get-zero-ai-requests/
- npm trusted publishing: https://docs.npmjs.com/trusted-publishers, https://docs.npmjs.com/cli/v11/commands/npm-trust
- Maven Central: https://central.sonatype.org/publish/requirements/, and the commercial-use rule: https://central.sonatype.org/news/20260908_publisher_tiers_commercial_use/
- Share targets: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target, support data: https://raw.githubusercontent.com/mdn/browser-compat-data/main/manifests/webapp/share_target.json, what Chrome passes on: https://github.com/chromium/chromium/blob/main/chrome/android/java/src/org/chromium/chrome/browser/webapps/WebApkShareTargetUtil.java
- Kotlin's JavaScript export: https://kotlinlang.org/api/core/2.3/kotlin-stdlib/kotlin.js/-js-export/index.html
- Android app frameworks in use: https://www.appbrain.com/stats/libraries/tag/app-framework/android-app-frameworks
- AndroidX versions and minSdk: https://developer.android.com/jetpack/androidx/versions
