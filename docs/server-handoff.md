# Handoff: the server is built (2026-10-17)

For the Claude that works on the LA2L device on Erik's Windows PC. Written by Claude Code on Erik's VPS, which built `la2l-server` from [server/BUILD-PROMPT.md](../server/BUILD-PROMPT.md) on 2026-10-16 and 17. Everything below is merged into `main`, so start with `git pull`.

## In short

- The server runs at `https://lloydstellar.nl/la2l/api`, the device's default `serverUrl`. Version 0.5.0; `https://lloydstellar.nl/la2l/api/health` shows it.
- LA2L Sender, at `https://lloydstellar.nl/la2l/`, pairs with the device and sends WAV files from a browser. Until the apps exist, it is the way to test Pair app and Import. It is also the reference client for the app side of the API (`server/public/sender.js`).
- Device 0.1.1 works with the server unchanged. Erik tested pairing, Add app, Import, Unpair and a server restart in Live 12.4.6 on Windows (details below).
- No device code was changed. `src/`, `tests/`, `tools/`, `devices/`, `package.json`, `docs/manifest.md` and `docs/design-notes.md` are exactly as you left them. The five files that did change outside `server/` are in the next section.

## What changed outside `server/`

| File | What changed | What it means for you |
|---|---|---|
| `docs/server-api.md` | The device side is the same contract. Sentences that start with "la2l-server ..." now say how the real server behaves: the `paired` answer comes again for 60 seconds and then 404; the inbox lists packages that wait or failed until they expire, with `created_at` as the time of the commit; the 404 texts; the ack answers `{"ok": true}`, keeps 64 sounds and 200 characters per text, and ignores a late `failed` for a package that is in Live; `HEAD` works on files. The app side is final. One correction on the device side: the device shows the server's error text for JSON calls only, not for file downloads (see open point 4). | Read the device side once; nothing there asks for a device change. |
| `docs/test-card-en.md` | Step 5 now expects `server OK`. A new step 6, Pairing and Import, uses LA2L Sender. Send back is step 7. The lines that said the server did not exist are gone. | It is still the 0.1.1 card: give it the new version and a "New in" list when you make the next build. |
| `README.md` | The server runs; LA2L Sender is mentioned; the `server/` row of the folder table points to `server/README.md`. | Nothing. |
| `CLAUDE.md` | The server's state. A new rule under Git: Erik does not merge on GitHub himself. When he has tested a pull request and says it works, Claude merges it with a merge commit, deletes the branch and tells him. | The rule is for you too. |
| `.github/workflows/test.yml` | New. On every push and pull request, on Node 24: the device tests (`npm test` in the root), the server tests, a build of the server's Docker image, and shellcheck on `server/deploy/*.sh`. | A device change now also runs the server tests. See the next section for why they can break. |

## Where the device and the server touch

- **Shared checks.** The server requires `src/node/manifest.js` (`validate`, `ManifestError`), `src/node/wav.js` (`readInfo`, `WavError`) and `src/node/text.js` (`cleanName`), so both ends judge a package the same way. A change there changes the server too. It needs a deploy on the VPS, and an update of `docs/server-api.md` when the server's answers change.
- **The Docker image.** `server/Dockerfile` copies `src/node/` and `src/ui/la2l-logo-big.png` (the logo on the Sender page) into the image. Moving or renaming them breaks the image build, and CI shows it.
- **Server tests that run device code.** `server/test/device-e2e.test.js` runs the device's controller (`src/node/app.js` with `tests/mock-live.js`) against the real server. Other server tests use the device's client (`src/node/server.js`, `src/node/http.js`). The end-to-end test checks some device texts word for word:
  - the Self test line, ending in `server OK / paired with 0 waiting`;
  - `This code works for 10:00`;
  - `Click Unpair again`;
  - `Sender test: 2 tracks imported.`

  When you change one of those, update that test in the same branch.
- **Running the server tests.** `cd server && npm test`, with Node 24; they also pass on Node 22. They are written for Linux: CI and the VPS run them there. I have not run them on Windows, and a few rely on Linux behaviour (file permissions, deleting files that are open), so trust CI for those.
- **The contract.** It stays `docs/server-api.md`, and device 0.1.1 must keep working, because it is installed. A device feature that needs something new from the server starts as a proposal in that file. The server part is then built and deployed on the VPS, and Erik tests both together. Erik passes the proposal on, or the VPS Claude picks it up from your branch.

## What was tested

### Automatically

- **Server, 84 tests.** They cover:
  - every route and error code of `docs/server-api.md`, CORS and the rate limits;
  - every cleanup rule, with a clock the test moves forward;
  - a restart with the same data, and the disk and storage limits;
  - that no token, pair id or code reaches the log;
  - the device's own client and controller against the real server: pairing, Self test, Import of a loop and a one-shot with the tempo checked in the simulated Live, Add app, Unpair, and a failed package that stays in the inbox.
- **Device, 110 of 110,** on Node 24 and Node 22, unchanged.
- **CI** is green on `main`.

### By Erik, in Live 12.4.6 on Windows, with device 0.1.1 and the real server

| Phase | What he did | What he saw |
|---|---|---|
| 1. Online | Self test | `server OK / not paired`. The website and the test file kept working. |
| 2. Pairing | Pair app, then the code typed on LA2L Sender | Live: "Paired with LA2L Sender". The page: "Paired with" and his computer's name. Self test: `server OK / paired with 0 waiting`. |
| | Settings > Add app, with a second browser | Worked. |
| | "Unpair this browser" on both pages | The pages forgot the pairing, but Live still said "Paired with LA2L Sender". That is open point 1. |
| | Unpair in Live | Worked; the page asked for a code again at its next load. |
| 3. Sounds | Sent a WAV from the page, then Import | It came in on a new track; three WAVs at once gave three tracks; an MP3 was refused by the page. |
| | The same, after a fix on the page | At first the sounds came in without warp and without BPM. The page then defaulted to One-shot, and the device rightly places a one-shot unwarped. Server 0.3.1 made Loop the default and greys out BPM for one-shots; Erik's retest at 135 BPM came in warped. |
| 4. Solid | `docker compose restart` with a package waiting | Still paired, and the package imported after the restart. |
| 5. Finished | The Actions tab on GitHub | Green. |

## Open points for the device

None of these is urgent. Each needs a new device version and a test in Live, so check with Erik before you start on one.

1. **"Paired with LA2L Sender" stays after every app unpaired itself.** The device learns app names only from the `paired` answer, and nothing tells it when an app goes. Erik has not decided how to handle this.

   My proposal: a device call that lists the active apps of this computer, for example `GET /api/apps` with the device token, answering `{"apps": [{"name": "LA2L Sender", "paired_at": "...", "last_seen_at": "..."}]}`. The device asks it at Self test and after an Import, and shows the list in Settings. The server does not have this call yet. Agree on it in `docs/server-api.md` first, then it gets built on both sides.

2. **A missing `kind` gives an unclear warning.** When a sound has no `kind`, `src/node/manifest.js` (line 157) says `Kick: kind "undefined" unknown, placed as one-shot`. `docs/manifest.md` makes `kind` optional, with one-shot as the default. The server passes these warnings on to apps (the `warnings` of `POST /packages`), so apps see that text too.

   Suggestion: for a missing `kind`, say `Kick: no kind, placed as one-shot`. The warning matters, because a one-shot is placed without warp; that is what Erik ran into in phase 3.

3. **`readInfo` in `src/node/wav.js` walks the chunks without a limit.** It reads 8 bytes per chunk, so a crafted file of millions of empty chunks takes many seconds. On the server that held up every other request, so the server now runs `readInfo` in a worker thread with a 10-second limit (`server/src/wav-check.js`). In the device the same walk runs in Node for Max during an Import.

   Suggestion: stop after about 1000 chunks without both `fmt ` and `data`, with `WavError('The WAV header is damaged.')`, the text the server already uses for its time limit. Real files have a handful of chunks before the data. The server keeps its worker either way.

4. **Download errors show only the device's own text.** `download()` in `src/node/http.js` calls `statusError(r.status, '', r.url)`. So a 404 for a file shows "The server does not know this address (404).", while the server sent `{"error": "The file is gone. Send it again."}`. The body went to `file.part`. Reading a small JSON error from it would let the device show the server's text, as it does for JSON calls.

5. **Docs to bring up to date with your next version:**
   - In `docs/design-notes.md`, step 2 of "Next steps" (the server) is done.
   - The "Proven" table could note that the whole chain with the real server works in Live 12.4.6 on Windows.
   - `docs/test-card-en.md` needs the new version, as described above.

6. **Not tested yet:** a Mac, both the device itself and the device against the server.

## Addresses and state

| | |
|---|---|
| API | `https://lloydstellar.nl/la2l/api` |
| Health | `https://lloydstellar.nl/la2l/api/health`: `{"ok":true,"name":"la2l-server","version":"0.5.0"}` |
| LA2L Sender | `https://lloydstellar.nl/la2l/` |
| Device | 0.1.1, unchanged |
| Server | 0.5.0. Pull requests #1 to #5 were the five phases, all merged. |
| Running and backing up the server | [server/README.md](../server/README.md), for the VPS |

## Follow-up: device 0.2.0 and server 0.6.0 (2026-10-17)

Erik asked for the open points above, plus one he found himself: in the Arrangement, an Import now always starts at 1.1.1 instead of at the playhead, which after playing could be minutes into the Set.

| Open point | What was done |
|---|---|
| 1. "Paired with" after every app unpaired | `GET /apps` as proposed, on both sides; the server is 0.6.0 for it. The device asks it when Live loads it, after every Import and in Self test. With no app left it says "No app paired. Add one in Settings." and stays paired. |
| 2. A missing `kind` | `Kick: no kind, placed as one-shot`. Values quoted in a warning are cut at 40 characters. |
| 3. `readInfo` without a limit | It stops after 1000 chunks with `The WAV header is damaged.` The server keeps its worker; its tests now check the quick refusal and the time limit (`wavCheckMs: 1`). |
| 4. Download errors | The device keeps the first 64 KB of an error answer to a download and shows the server's `error` text. |
| 5. Docs | `docs/design-notes.md` (next steps, the Proven table) and the test card for 0.2.0. |
| 6. A Mac | Still open. |

Erik tested 0.2.0 with server 0.6.0 in Live 12.4.6 on Windows, steps 1 to 7 of the test card, and it worked. After step 7 he asked for two changes, which device 0.2.1 makes without a server change: with no app left the device shows Pair app again instead of Import, keeping its token, so Pair app adds the next app to the same computer; and Copy code puts the pairing code on the clipboard.

Device 0.2.2, also without a server change, asks `GET /api/apps` every 15 seconds while an app is paired, so Pair app comes back by itself when the last app unpaired itself (Erik's question after testing 0.2.1). That is 4 calls a minute per computer, far under the token limit, but each is a line in the server log. If the log gets too busy, la2l-server could leave successful `GET /api/apps` lines out, as it does for Docker's own health check. Erik tested 0.2.2 in Live 12.4.6 on Windows on 2026-10-17: after Unpair this browser, Pair app came back by itself without a click in Live.

## Server 0.7.0: what the developer kit adds for the device (2026-10-17)

The developer kit of `sdk/BUILD-PROMPT.md` is being built on the VPS. Its phase 1 adds to the device side of the API without changing any call the device makes, so devices 0.1.1 and 0.2.x work as before:

- `GET /apps` gives every app an `id` of 32 hex characters. Devices 0.2.x ignore it.
- `DELETE /apps/{id}` with the device token removes one app, with its packages that still upload or wait. The brief plans a button for it in Settings in a later device version; check with Erik before you build it. `docs/server-api.md` describes the call.
- `POST /pair/start` takes `"test": true` from the test receiver at `https://lloydstellar.nl/la2l/receiver`, a page that stands in for Live while a developer tests an app. The server removes a test receiver after 7 days without a call.
- `sdk/fixtures/` holds WAV files and manifests with the device's verdict on each, and `tests/fixtures.test.js` runs them in `npm test`. The checks of `src/node/manifest.js`, `src/node/wav.js` and `src/node/text.js` are ported to TypeScript in `sdk/js/src` for the npm package `la2l`, with the same texts. So a change to a check or a text there now also needs `sdk/fixtures/make.js` and the port changed in the same branch; `sdk/js/test/parity.test.mjs` compares the port with the device code on thousands of random inputs.
