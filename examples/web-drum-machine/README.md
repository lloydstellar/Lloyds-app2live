# Web808: a drum machine that sends to Live

A web drum machine of four sounds and sixteen steps, with a Send to Live button. It sends the one-bar loop, warped to its tempo, and each sound of the pattern as a one-shot, to LA2L in Ableton Live. The sounds are made in code, so there are no sample files.

Try it at https://lloydstellar.nl/la2l/examples/drum-machine/. It is also what the AI test of the developer kit asks tools to build (`docs/developers/ai-test.md`, from phase 3).

## How it sends

`drum-machine.js` does it in a few lines:

```js
import { wavFromAudioBuffer, wavFromSamples } from '@lloydstellar/la2l/button';

document.querySelector('la2l-send-button').sounds = async () => ({
  title: 'Web808 beat at 120 BPM',
  bpm: 120,
  sounds: [
    { name: 'Beat', audio: wavFromAudioBuffer(await renderLoop(120)), kind: 'loop', role: 'drums', lengthBeats: 4 },
    { name: 'Kick', audio: wavFromSamples(kickSamples, 48000), kind: 'oneshot', role: 'drums' },
  ],
});
```

The first click asks for the code that LA2L shows in Live (Pair app); after that one click sends.

## In your own page

The page here is served by the LA2L server, so it loads the button from `../../vendor/la2l-button.js` and sets `server="../../api"`. In your own page, leave `server` out and load the button from jsDelivr:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@lloydstellar/la2l@0.1.0/dist/button.min.js"></script>
<la2l-send-button app-name="Your app"></la2l-send-button>
```

or with a bundler: `npm install @lloydstellar/la2l`, then `import '@lloydstellar/la2l/button'`.
