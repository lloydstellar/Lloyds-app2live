---
name: la2l-send-to-ableton
description: Use when the user wants to send audio from an app to Ableton Live, wants a "Send to Live" button, or names LA2L (Lloyd's App2Live). Covers web apps (the npm package @lloydstellar/la2l, Web Audio to WAV, the <la2l-send-button> web component), scripts in any language (npx @lloydstellar/la2l send), Android (the REST API) and any other language through the REST API; pairing with the code LA2L shows in Live; describing each sound (loop or one-shot, role, BPM) so it arrives in time; and testing without Ableton through the LA2L test receiver.
license: Apache-2.0
compatibility: Web apps need a browser with Web Audio. The npm package and the local test receiver need Node.js 22.12 or newer (Deno and Bun work too).
metadata:
  author: Lloyd Stellar
  version: 0.1.0
  homepage: https://lloydstellar.nl/la2l/
---

# Send sounds to Ableton Live with LA2L

LA2L is a Max for Live device in Ableton Live. The user clicks **Pair app** in it once and types the six-character code it shows into the app. From then on the app can send packages: WAV files plus a short description of each sound. When the user clicks **Import** in LA2L, every sound becomes a new audio track, named, coloured, and warped to the tempo the app gave. No API key or developer account is needed: the code is the consent.

Do the steps below in order. Prefer the SDK over raw HTTP: ten lines instead of three hundred, and it checks everything the way LA2L does.

## 1. Find out the platform

| The app is | Use |
|---|---|
| A web app with npm and a bundler (React, Vue, Svelte, Next.js, Vite) | `npm install @lloydstellar/la2l`: the client, or the button from `@lloydstellar/la2l/button` |
| A web page without a build step | The button from jsDelivr (one `<script type="module">`) |
| A script (Python, shell, anything that can run a command) | `npx @lloydstellar/la2l pair` and `npx @lloydstellar/la2l send` |
| Android (Kotlin or Java) | The Android SDK `nl.lloydstellar:la2l-ktx` (Kotlin) or `nl.lloydstellar:la2l` (Java) from LA2L's Maven repository, the REST API without it, or a share with LA2L Sender: [references/android.md](references/android.md) |
| Anything else | The REST API: [references/api.md](references/api.md) |

## 2. Install

```bash
npm install @lloydstellar/la2l
```

ESM with type definitions, no dependencies. In a page without a build step:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@lloydstellar/la2l@0.1.0/dist/button.min.js"
        integrity="sha384-A/Nu56J/Oh1+eLYYZgGeFUEk9dgZSWIanzPgaba1I1IjsXk2135KwQ4TYD940D0C" crossorigin="anonymous"></script>
```

## 3. Pairing: one code field

Show a field for the code once, with exactly this line above it: "In Live, click Pair app in LA2L and type the code it shows." Then:

```js
import { LA2L } from '@lloydstellar/la2l';

const la2l = new LA2L({ appName: 'Web808' }); // your app's name; Live shows "Paired with Web808"
if (!la2l.paired) await la2l.pair(codeFromUser); // "K7P 42Q": case, spaces and dashes do not matter
```

The SDK keeps the token (localStorage in a browser, a private file in Node.js). Never put the token in a URL, a log line, an analytics event or an error report. With the button (`<la2l-send-button>`) the dialog for the code is built in.

## 4. Make WAV files

LA2L takes WAV only: PCM 16 or 24 bit (8 and 32 work too) or float 32 or 64 bit, mono or stereo, 8 to 192 kHz. Not MP3, not M4A, not OGG.

```js
import { wavFromAudioBuffer, wavFromSamples, toWav } from '@lloydstellar/la2l';

const wav = wavFromAudioBuffer(renderedBuffer, { bits: 24 }); // from an OfflineAudioContext
const wav2 = wavFromSamples([left, right], 48000);            // from Float32Arrays, -1 to 1
const wav3 = await toWav(mp3File);                             // mp3 or m4a, in a browser
```

**Render a loop of exactly a whole number of beats**: `seconds = 60 / bpm * beats`, so one bar of 4/4 at 120 BPM is exactly 2 seconds. A loop that is a little longer or shorter drifts. What rings past the end of the bar belongs at its start: render the bar plus the tail and add the tail to the start. See [references/web.md](references/web.md).

## 5. Describe every sound

| Field | |
|---|---|
| `kind` | **Required.** `'loop'`: warped to the tempo and looped. `'oneshot'`: plays exactly as it is. A loop without `kind: 'loop'` arrives as a one-shot, out of time. |
| `name` | The name of the sound, at most 40 characters: "Kick". Live adds the app name to the track: "Kick" becomes "Kick (Web808)", so never add it yourself. |
| `role` | `drums`, `bass`, `melodic`, `vocal`, `texture` or `fx`. It picks the warp mode of a loop: drums Beats, bass Tones, melodic and vocal Complex Pro. |
| `bpm` | The tempo, for the whole package (`send({ bpm })`) or per loop. A one-shot ignores it. |
| `lengthBeats` | The loop length in beats. Without it LA2L works it out from the file length and the tempo. |

The package as a whole has a `title`: the name of the scene in Live, and of the folder on disk. Limits: 32 sounds and 200 MB per package; send more in more packages.

## 6. Send, and show the status

```js
const delivery = await la2l.send({
  title: 'Treinbeat',
  bpm: 92,
  sounds: [
    { name: 'Beat', audio: wav, kind: 'loop', role: 'drums', lengthBeats: 4 },
    { name: 'Robot hallo', audio: voiceWav, kind: 'oneshot', role: 'vocal' },
  ],
  onProgress: (share) => (progress.value = share), // 0 to 1, the bytes uploaded
});
status.textContent = 'Waiting for Import in Live';
const result = await delivery.imported(); // resolves when the user clicked Import in Live
status.textContent = result.status === 'imported' ? 'In Live' : `In Live: ${result.sounds.filter((s) => s.status === 'imported').length} of ${result.sounds.length}`;
```

`send()` checks every WAV header and the whole description before the first byte goes out, with the same texts LA2L uses. Show `delivery.warnings` to the developer: they name what LA2L ignores.

With the button, all of this is one element:

```html
<la2l-send-button app-name="Web808"></la2l-send-button>
<script type="module">
  // Without a build step the helpers come from the same file as the button; with a bundler, from '@lloydstellar/la2l'.
  import { wavFromAudioBuffer } from 'https://cdn.jsdelivr.net/npm/@lloydstellar/la2l@0.1.0/dist/button.min.js';
  // renderLoop(bpm, schedule) renders one bar as an AudioBuffer: see references/web.md.
  document.querySelector('la2l-send-button').sounds = async () => ({
    title: 'Beat', bpm: 120,
    sounds: [{ name: 'Beat', audio: wavFromAudioBuffer(await renderLoop(120, schedule)), kind: 'loop', role: 'drums', lengthBeats: 4 }],
  });
</script>
```

## 7. Errors

Every error is a `La2lError` with a `code` and a `message` to show as it is.

| `code` | Show |
|---|---|
| `not_paired` | The code field again: the user unpaired in Live. |
| `bad_code` | The message ("This code does not work. Check the code in Live."), and ask again. |
| `bad_wav`, `bad_package` | The message: it names the sound and the problem. |
| `rate_limited` | Wait `retryAfter` seconds. |
| `server_full` | The message: often "Click Import in Live first". |
| `network`, `server` | Try again later. |
| `import_failed` | The message. The package stays: the next Import in Live tries again, so do not send it again. |
| `expired` | The message; send the sounds again. |

## Pitfalls

- Forgetting `kind: 'loop'` for a loop: it plays as a one-shot, without warp.
- A loop that is not a whole number of beats long, or a `bpm` that does not match the audio.
- Names over 40 characters: they are cut.
- MP3, M4A or OGG sent as if it were WAV: convert with `toWav` first.
- The token in a URL, a log line or an error report.
- Asking for the code at every send: pair once, and ask again only on `not_paired`.

## Check your own work, without Ableton

The test receiver stands in for LA2L in Live and says per sound what Live would do.

```bash
npx @lloydstellar/la2l test-receiver --local
```

It prints an address and a code, and runs until Ctrl+C: start it in the background, or in a second terminal, so you can go on. Point the app at the address with `new LA2L({ appName, server: '<address>' })` (or the button's `server` attribute), pair with the code, send, and read the report in the terminal. A loop must show up as `loop, warped in Beats mode at 120 BPM, 4 beats`, not as `one-shot`. In automated tests, use `startTestReceiver()` from `@lloydstellar/la2l/testing`: see [assets/check-with-test-receiver.mjs](assets/check-with-test-receiver.mjs). Against the real server, the page https://lloydstellar.nl/la2l/receiver does the same in a browser.

## More

- [references/api.md](references/api.md): the client API, and the five HTTP calls for any language.
- [references/manifest.md](references/manifest.md): every field of the description, and what LA2L does with it.
- [references/web.md](references/web.md): Web Audio, the button, and pages without a build step.
- [references/android.md](references/android.md): Android: the SDK, a share with LA2L Sender, and the REST calls in Kotlin.
- [assets/web-send.js](assets/web-send.js), [assets/button.html](assets/button.html): complete examples.
- The full docs: https://lloydstellar.nl/la2l/developers/ and `node_modules/@lloydstellar/la2l/docs` after `npm install @lloydstellar/la2l`. `npx @lloydstellar/la2l agents-md` writes an index of those docs into the project's `AGENTS.md` and `CLAUDE.md`, so later sessions find them too.
