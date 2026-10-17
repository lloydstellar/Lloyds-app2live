# Sending from Web Audio

LA2L takes WAV files. These helpers make one from what your app has.

## An AudioBuffer

What an `OfflineAudioContext` renders, or what `decodeAudioData` gives:

```js
import { wavFromAudioBuffer } from 'la2l';

const context = new OfflineAudioContext(2, Math.round(48000 * 2), 48000); // two seconds
// ... connect your sources to context.destination and start them ...
const rendered = await context.startRendering();
const wav = wavFromAudioBuffer(rendered, { bits: 24 }); // a Blob
```

Render a loop of exactly a whole number of beats: `60 / bpm * beats` seconds. Then send it with `kind: 'loop'`, the `bpm`, and `lengthBeats`, and it plays in time at any tempo of the Set.

## Samples

```js
import { wavFromSamples } from 'la2l';

const wav = wavFromSamples([left, right], 44100); // two Float32Arrays, from -1 to 1
const mono = wavFromSamples(samples, 44100, { bits: 32 }); // 32: float
```

16 and 24 bit are integer PCM, kept between -1 and 1; 32 is float, kept as it is.

## mp3, m4a and other files

In a browser:

```js
import { toWav } from 'la2l';

const wav = await toWav(file); // a WAV that LA2L takes comes back as it is
```

`toWav` decodes through Web Audio, at 48 kHz unless you pass `sampleRate`, to 16 or 24 bit (`bits`). It needs a browser; in Node.js, convert with a tool such as ffmpeg first.
