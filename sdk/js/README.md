# la2l

Send sounds from your app to Ableton Live with [LA2L](https://lloydstellar.nl/la2l/) (Lloyd's App2Live). The user pairs your app once with the code LA2L shows in Live. After that, every send becomes new audio tracks in Live when they click Import: named, coloured, and warped to your tempo.

```bash
npm install la2l
```

```js
import { LA2L, wavFromAudioBuffer } from 'la2l';

const la2l = new LA2L({ appName: 'Web808' });
if (!la2l.paired) await la2l.pair(codeFromUser); // "K7P 42Q", from LA2L in Live

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

Or a ready-made button, without a build step:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/la2l@0.1.0/dist/button.min.js"
        integrity="sha384-DCfxAXK3uQxg3OATJBKMk0VOSXgO6PJAiyd+1SpwzTWa6Gbvc9GFc+kx1DhcRxGr" crossorigin="anonymous"></script>
<la2l-send-button app-name="Web808"></la2l-send-button>
```

From a script in any language:

```bash
npx la2l pair K7P42Q
npx la2l send kick.wav --loop --bpm 92 --role drums
```

## What is in it

- `la2l`: the client (`LA2L`, `Delivery`, `La2lError`), WAV files from Web Audio (`wavFromAudioBuffer`, `wavFromSamples`, `toWav`), and the checks of LA2L itself (`checkWav`, `checkManifest`, `planSound`, `sha256`), with the same texts.
- `la2l/button`: `<la2l-send-button>`, for a browser.
- `la2l/testing`: `startTestReceiver()`, an LA2L server in memory that imports what you send as Live would, for tests without Ableton or internet. Node.js only.
- `npx la2l`: pair, send, status, unpair, `test-receiver`, and `agents-md`, which writes an index of these docs into your project's `AGENTS.md` and `CLAUDE.md` for AI coding agents.

ESM with type definitions, for browsers, Node.js 22.12 and newer, Deno and Bun. No dependencies.

## Docs

In `node_modules/la2l/docs`, for the version you installed: [getting started](docs/getting-started.md), [the API](docs/api.md), [Web Audio](docs/web-audio.md), [the button](docs/button.md), [testing](docs/testing.md), [errors](docs/errors.md).

The HTTP API itself, for any language: https://github.com/lloydstellar/Lloyds-app2live/blob/main/docs/server-api.md and its [OpenAPI file](https://github.com/lloydstellar/Lloyds-app2live/blob/main/docs/openapi.yaml).

Apache License 2.0. Ableton and Live are trademarks of Ableton AG; LA2L is not made by Ableton.
