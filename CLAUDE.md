# CLAUDE.md

Lloyd's App2Live (LA2L) brings sounds from apps (Android, web) into Ableton Live. An app sends a package (WAV files plus a short JSON description) to a server; the Max for Live device in Live imports it with one click, one new audio track per sound, named, coloured and warped to the tempo the app gave.

This repository holds the parts of that chain:

| Part | Where | Runs on | State |
|---|---|---|---|
| The device | the repository root: `src/`, `tests/`, `tools/`, `devices/la2l/` | Erik's computer, inside Live 12.4 or newer (Windows and Mac) | 0.2.2, tested in Live 12.4.6 on Windows |
| The server, `la2l-server` | `server/` | Erik's Linux VPS, at `https://lloydstellar.nl/la2l/` | 0.12.0; built from `server/BUILD-PROMPT.md`, run as `server/README.md` says |
| The developer kit: SDKs, skill and test receiver for app makers | `sdk/` (fixtures, `@lloydstellar/la2l` for npm in `sdk/js`, the Android SDK in `sdk/android`), `docs/openapi.yaml`, `docs/app2live-1.schema.json`, `docs/developers/`, `skills/`, `examples/`, the test receiver and the developer pages in `server/public/` | npm, our own Maven repository and the server's pages | Phases 1 to 5 of 5 built from `sdk/BUILD-PROMPT.md` on the VPS (`@lloydstellar/la2l` 0.1.0 with its button, command line and test receivers; the drum machine example; the skill and the developer pages; LA2L Sender as a share target on Android; the Android SDK 0.1.0, built in GitHub Actions). Published on 2026-10-18: `@lloydstellar/la2l` 0.1.0 on npm, and `nl.lloydstellar:la2l` and `la2l-ktx` 0.1.0 in the Maven repository; see `sdk/CLAUDE.md` |

The contract between the two is [docs/server-api.md](docs/server-api.md); the package format is [docs/manifest.md](docs/manifest.md). Change them only together with the code on both sides, and keep device 0.1.1 working: it may still be installed somewhere, and the server must not care which version calls it.

## Working with Erik

- Erik owns the project and knows his way around code. He writes Dutch: answer him in Dutch. Code, comments, commit messages, docs and every text a user sees are in English.
- Lead with what he must do or decide. When he must test, say exactly what to click and what he should see.
- Ask first before anything that cannot be undone or reaches outside this repository: deleting data, force-pushing, installing system packages, changing the web server, the firewall or another site on the VPS.

## The device

- `node tools/build.js` builds `devices/la2l/`: the `.amxd`, the bundled `la2l-node.js`, the v8 script `la2l-live.js` and the logos. Never save the device from the Max editor; `tools/gen-patch.js` generates the patch.
- `npm test` (in the root) runs the device tests against a simulated Live (`tests/mock-live.js`, which runs the real v8 script) and a simulated server (`tests/mock-server.js`).
- No npm packages in the device: Freeze does not pack them. Node's built-in modules only.
- The version is in `src/node/version.js` and in `var VERSION` in `src/live/la2l-live.js`; the build stops when they differ. Bump both, and `package.json`, for every build Erik tests.
- Live keeps a loaded device in memory, so Erik restarts Live after every new build.
- `docs/design-notes.md` explains the device and lists what real Live does through the API ("Proven and not yet proven"). Read it before you touch `src/live/la2l-live.js`; `tests/mock-live.js` must keep matching real Live.
- `docs/test-card-en.md` is the test Erik runs in Live. Update it with every version.
- `devices/release/lloyds-app2live.zip` is the download for Live users, linked from the README: one frozen `.amxd`, frozen by Erik in Max. When a new version is released, Erik freezes it, the zip is replaced, and the file name in the README's Install steps changes with it.

## The server

See [server/CLAUDE.md](server/CLAUDE.md). In short: Node.js in Docker on the VPS, behind the web server that already serves lloydstellar.nl. It reuses `src/node/manifest.js`, `src/node/wav.js` and `src/node/text.js` from the device, so both sides check a package the same way. Where the device and the server touch:

- A change to those three files changes the server too: deploy it, and update `docs/server-api.md` when the server's answers change. Their ports in `sdk/js` and `sdk/android` and the fixtures in `sdk/fixtures` change in the same branch ([sdk/CLAUDE.md](sdk/CLAUDE.md)).
- `server/Dockerfile` copies `src/node/` and `src/ui/la2l-logo-big.png` into the image; moving or renaming them breaks the build.
- `server/test/device-e2e.test.js` runs the device's controller against the real server, and checks some device texts word for word: the Self test line, `This code works for 10:00`, `Click Unpair again`. Change that test in the same branch as such a text.
- The open points of the device are under "Next steps" in `docs/design-notes.md`.

## Git

- `main` is what Erik runs. Work on a branch and open a pull request, unless Erik says otherwise.
- Erik does not merge on GitHub himself. When he has tested a pull request and says it works, merge it with a merge commit (so a branch stacked on it keeps working), delete the branch, and tell him.
- LA2L is open source under the Apache License 2.0 ([LICENSE](LICENSE)). The repository is public since 2026-10-18: no secrets, keys, tokens, real logs or private server configuration in a file, a commit, a pull request or an issue.
- GitHub guards `main` with a ruleset: changes come only through a pull request, merged with a merge commit after the checks `test`, `sdk-js-runtimes` and `android` pass; no force push, no deletion. When a job of `.github/workflows/test.yml` is renamed, change the ruleset too (Settings > Rules), or every merge stays blocked. The tags `js-v*` and `android-v*` publish, so a second ruleset lets only an admin (Erik's login) create, move or delete them. Secret scanning with push protection, Dependabot alerts and private vulnerability reporting are on; workflows of outside contributors wait for approval, and the workflow token can only read unless a workflow asks for more.
- Never commit secrets, `.env` files, the server's data folder or uploaded sounds.
