# Lloyd's App2Live (LA2L)

Lloyd's App2Live is an open source connection between Ableton Live and phone or web apps. An app (Android or web) sends a package of WAV files with a short description to a server. You click **Import** in the Max for Live device, and every sound lands on its own new audio track: named, coloured, and warped to the tempo the app gave.

This repository holds both ends of that chain: the Max for Live device (the root of the repository) and the server, `la2l-server` (in [`server/`](server/)). It also holds the developer kit for the apps (in [`sdk/`](sdk/)): `@lloydstellar/la2l` for JavaScript and TypeScript, with a Send to Live button, a command line and a test receiver that stands in for Live; the Android SDK `nl.lloydstellar:la2l` and `la2l-ktx` (in [`sdk/android/`](sdk/android/)) with two example apps; an example at `https://lloydstellar.nl/la2l/examples/drum-machine/`; the API for machines in [`docs/openapi.yaml`](docs/openapi.yaml); the developer pages at `https://lloydstellar.nl/la2l/developers/` (sources in [`docs/developers/`](docs/developers/)); and a skill for AI coding tools in [`skills/`](skills/).

The device is at version 0.2.2. It is tested against a simulated Live and a simulated server, and in Live 12.4.6 on Windows, with the real server too. The server runs at `https://lloydstellar.nl/la2l/`. Apps send to it with the developer kit; LA2L Sender on that address pairs with the device and sends WAV files from a browser. **Settings > Test import** places a test loop without a server, so the Live side can also be tested on its own.

## What the device does

- **Pair app** shows a six-character code. You type it in the app once; from then on that app can send sounds to this computer. **Copy code** puts the code on the clipboard, for an app on the same computer. The device says which apps are paired, and asks the server again when Live starts, after Import, in Self test and every 15 seconds while an app is paired, so an app that unpaired itself drops out; with no app left it shows Pair app again. *(needs the server)*
- **Import** gets every package that is waiting on the server, downloads the WAV files, checks their size and checksum, and puts each sound on a new audio track. By default the clips go into the Arrangement at 1.1.1, its start, wherever the playhead is. In Session mode each package gets its own new scene at the top of the Session.
- **Loops** are warped to the tempo the app sent. The warp mode follows what the sound is: Beats for drums, Tones for bass, Complex Pro for melodic parts and vocals. **One-shots** play exactly as the app made them: warp off, loop off.
- When a package has a different tempo than the Set, a **Use 92 BPM** button appears. The device never changes the Set tempo by itself.
- **Settings**: where new sounds go (Arrangement or Session), where new tracks go (after this track or at the end), Test import, Self test, Open folder, Add app, Unpair.

## Requirements

Ableton Live 12.4 or newer with Max for Live (Live Suite, or Live Standard with Max for Live), on Windows or Mac.

## Trying it in Live

1. Restart Live. Live keeps a loaded device and its scripts in memory, so a new version only shows after a restart.
2. Drag `devices/la2l/Lloyds App2Live.amxd` onto an audio track. The other files in `devices/la2l` must stay next to it. A group track, a return track or the Main track works too, and the sound passes through unchanged: on a group track new tracks go to the top of that group, on a return or the Main track after all other tracks.
3. Click **Settings**, then **Test import**.

The full test, with what you should see at every step, is in [docs/test-card-en.md](docs/test-card-en.md).

## Files on your computer

LA2L keeps its settings and log per computer, not in the Live Set, in `Documents/Lloyds App2Live`:

| File | What it is |
|---|---|
| `settings.json` | Settings, the pairing token and the list of imported packages. |
| `la2l.log` | What the device did, including the warp markers Live reported. Older lines move to `la2l.log.old` at 1 MB. |
| `Inbox/` | Sounds imported into a Set that was not saved yet. |

Sounds imported into a saved Set go to the project folder of that Set: `Samples/LA2L/<date> <time> <title>/`. Collect All and Save then works as usual.

**Settings > Open folder** opens this folder. The settings that have no button are in `settings.json`. LA2L reads that file again at every click, so a change made by hand works from the next click on:

| Setting | Default | |
|---|---|---|
| `serverUrl` | `https://lloydstellar.nl/la2l/api` | Only `https://`, except `http://localhost` for testing. |
| `appNameInTrackName` | `true` | "Kick (Web808)" instead of "Kick". |
| `testUrl` | `http://lloydstellar.nl/test/test-file-voor-max.wav` | The file Test import downloads. Any web address works here. |
| `testName`, `testBpm`, `testKind`, `testRole` | `Snare`, `135`, `loop`, `drums` | How Test import places that file. |

When the test file cannot be downloaded, Test import uses a loop built into the device (a snare on 2 and 4 at the test tempo), and the status line says so.

## Building

Only Node.js 18 or newer is needed; there are no npm packages.

```
node tools/build.js      # writes devices/la2l
npm test                 # runs the device tests (tests/*.test.js)
```

Never save the device from the Max editor. The patch is generated by `tools/gen-patch.js`; change that file or the code in `src/` and build again.

## Folder layout

| Path | |
|---|---|
| `src/node/` | The Node for Max part: server, downloads, WAV check, manifest, settings, and the controller `app.js`. |
| `src/live/la2l-live.js` | The Live part, a `[v8]` script: new tracks, clips, warp, loop, names, colours. |
| `src/ui/` | The logos. |
| `tools/gen-patch.js` | Generates and checks the Max patch. |
| `tools/build.js` | Builds `devices/la2l`: the `.amxd`, the bundled `la2l-node.js`, the v8 script and the logos. |
| `tests/` | Tests for every part, with a simulated Live (`mock-live.js`) and a simulated server (`mock-server.js`). |
| `docs/` | Server API, manifest format, design notes and the test card. |
| `devices/la2l/` | The built device. |
| `server/` | The App2Live server (`la2l-server`) and LA2L Sender. [server/README.md](server/README.md) says how to run, update and back it up. |

## How it fits together

The device has three parts:

- **The Max patch** is the interface: the logo, the code, the buttons and the status line. It shows one view at a time (not paired, showing a code, paired, settings).
- **Node for Max** (`la2l-node.js`) does the network, the files, the settings and all decisions. It only uses Node's built-in modules, because Freeze does not pack npm packages, and it is bundled into one file, because Freeze does not follow `require()`.
- **The v8 script** (`la2l-live.js`) is the only part that can use the Live API. Node sends it one request per package; it answers with progress and a result per sound.

More in [docs/design-notes.md](docs/design-notes.md). The server contract is in [docs/server-api.md](docs/server-api.md) and the package format in [docs/manifest.md](docs/manifest.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
