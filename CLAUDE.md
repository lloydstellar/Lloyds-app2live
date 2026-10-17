# CLAUDE.md

Lloyd's App2Live (LA2L) brings sounds from apps (Android, web) into Ableton Live. An app sends a package (WAV files plus a short JSON description) to a server; the Max for Live device in Live imports it with one click, one new audio track per sound, named, coloured and warped to the tempo the app gave.

This repository holds both ends of that chain:

| Part | Where | Runs on | State |
|---|---|---|---|
| The device | the repository root: `src/`, `tests/`, `tools/`, `devices/la2l/` | Erik's computer, inside Live 12.4 or newer (Windows and Mac) | 0.2.1, tested in Live 12.4.6 on Windows |
| The server, `la2l-server` | `server/` | Erik's Linux VPS, at `https://lloydstellar.nl/la2l/` | 0.6.0, running; built from `server/BUILD-PROMPT.md`, run as `server/README.md` says |

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

## The server

See [server/CLAUDE.md](server/CLAUDE.md). In short: Node.js in Docker on the VPS, behind the web server that already serves lloydstellar.nl. It reuses `src/node/manifest.js` and `src/node/wav.js` from the device, so both sides check a package the same way. What the server build changed for the device side, what Erik tested, and the open device points: [docs/server-handoff.md](docs/server-handoff.md).

## Git

- `main` is what Erik runs. Work on a branch and open a pull request, unless Erik says otherwise.
- Erik does not merge on GitHub himself. When he has tested a pull request and says it works, merge it with a merge commit (so a branch stacked on it keeps working), delete the branch, and tell him.
- LA2L is open source under the Apache License 2.0 ([LICENSE](LICENSE)). The repository is private for now; write every file and commit as if it were public: no secrets, keys, tokens, real logs or private server configuration.
- Never commit secrets, `.env` files, the server's data folder or uploaded sounds.
