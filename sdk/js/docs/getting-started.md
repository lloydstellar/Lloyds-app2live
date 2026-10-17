# Getting started

`la2l` sends sounds from your app to Ableton Live. The user has LA2L, a Max for Live device, in Live. They click **Pair app** in it once and type the code it shows into your app. After that, every send becomes new audio tracks in Live when they click **Import**: named, coloured, and warped to your tempo.

```bash
npm install la2l
```

```js
import { LA2L, wavFromAudioBuffer } from 'la2l';

const la2l = new LA2L({ appName: 'Web808' }); // Live shows "Paired with Web808"
if (!la2l.paired) await la2l.pair(codeFromUser); // the code LA2L shows, like "K7P 42Q"

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

Every sound needs a `kind`. A `loop` is warped to the tempo and loops; a `oneshot` plays as it is. A loop sent without `kind: 'loop'` would arrive as a one-shot, out of time, so the SDK asks for it.

LA2L takes WAV files only: PCM 16 or 24 bit (8 and 32 work too) or float 32 or 64 bit, mono or stereo, 8 to 192 kHz. Make one with `wavFromAudioBuffer` or `wavFromSamples`, or convert an mp3 or m4a with `toWav` in a browser ([web-audio.md](web-audio.md)).

For the code, show a field once, with this line: "In Live, click Pair app in LA2L and type the code it shows." Or use the ready-made button ([button.md](button.md)).

Without Ableton at hand, test against the test receiver: [testing.md](testing.md). Everything the client can do is in [api.md](api.md), and what each error means in [errors.md](errors.md).

Limits: 32 sounds and 200 MB per package, 30 packages an hour per app. A package waits 24 hours for Import.
