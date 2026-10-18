# Testing without Ableton Live

The test receiver stands in for LA2L in Live. It shows a code, imports every package as Live would, and says per sound what Live would do: the track name, loop or one-shot, the warp mode, the tempo, the length in beats. It acks the package too, so your app sees the same status as with Live.

## In a browser

Open https://lloydstellar.nl/la2l/receiver and pair your app with the code it shows. It works against the real server. A receiver that makes no call for 7 days is removed.

## In a terminal

```bash
npx @lloydstellar/la2l test-receiver           # against the real server, like the page
npx @lloydstellar/la2l test-receiver --local   # an LA2L server in memory on 127.0.0.1, without internet
```

`--local` prints an address and a code. Point your app at the address with the option `server`, and pair with the code. After an app used a code, or when a code ran out, it prints a new one for the next app. Against the real server, every run shows a fresh code; apps paired in an earlier run can still send.

## In your tests

```js
import { LA2L, memoryStorage } from '@lloydstellar/la2l';
import { startTestReceiver } from '@lloydstellar/la2l/testing';

const receiver = await startTestReceiver(); // no internet, no rate limits
const la2l = new LA2L({ appName: 'Web808', server: receiver.server, storage: memoryStorage() });
await la2l.pair(receiver.code);

const delivery = await la2l.send({ bpm: 120, sounds: [{ name: 'Beat', audio: wav, kind: 'loop', role: 'drums' }] });
await delivery.imported();
const report = await receiver.nextReport();
// report.sounds[0].plan: { warp: true, warpModeName: 'Beats', bpm: 120, lengthBeats: 4, trackName: 'Beat (Web808)' }

await receiver.close();
```

The local server answers the app side as the real one does, with the same texts; the tests of `@lloydstellar/la2l` run the same app-side tests against both. `receiver.nextReport()` gives the oldest report it did not give yet, so it also finds one that came before you asked. `receiver.code` is always a code that works: a new one comes after an app used it. `receiver.reports` holds them all.

## By hand

The command line sends files from any script:

```bash
npx @lloydstellar/la2l pair K7P42Q
npx @lloydstellar/la2l send kick.wav snare.wav --loop --bpm 92 --role drums --title "Beat" --wait
npx @lloydstellar/la2l status
```

The token is kept in a file only you can read, or taken from `LA2L_TOKEN`.
