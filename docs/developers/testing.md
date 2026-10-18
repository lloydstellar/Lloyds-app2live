# Testing

The test receiver stands in for LA2L in Ableton Live, for whoever has no Ableton at hand: you, your CI, or an AI agent. It shows a code, imports every package you send as LA2L in Live would, and acks it, so your app sees the same status as with Live. Per sound it says what Live would do:

```
Beat test (Web808): imported 2 of 2 sounds
  Beat (Web808): loop, warped in Beats mode at 120 BPM, 4 beats. 48 kHz, 16-bit, stereo, 2 s
  Hit (Web808): one-shot, plays as it is. 48 kHz, 16-bit, mono, 0.1 s
```

A loop that shows up as a one-shot lacks `kind: 'loop'`. A loop at an odd length, such as 4.37 beats, is not rendered a whole number of beats long.

## In a browser

Open [the test receiver](../receiver). It shows a code; pair your app with it as you would with Live, and send. Each package gets a report on the page. It works against the real server, so your app needs no change at all.

## In a terminal

```bash
npx la2l test-receiver
```

The same, in a terminal. With `--local` it starts an LA2L server in memory on `127.0.0.1` as well: no internet and no rate limits. Point your app at the address it prints:

```bash
npx la2l test-receiver --local
#   LA2L test receiver, with an LA2L server in memory: http://127.0.0.1:41234/api
#   In your app, use that address as the server and pair with code K7P 42Q.
```

```js
const la2l = new LA2L({ appName: 'Web808', server: 'http://127.0.0.1:41234/api' });
```

The button takes it as an attribute: `<la2l-send-button server="http://127.0.0.1:41234/api">`.

## In your tests

`startTestReceiver()` from `la2l/testing` does the same inside a test, in Node.js:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { LA2L, memoryStorage } from 'la2l';
import { startTestReceiver } from 'la2l/testing';

test('the beat arrives in Live as a loop of one bar', async () => {
  const receiver = await startTestReceiver();
  try {
    const la2l = new LA2L({ appName: 'Web808', server: receiver.server, storage: memoryStorage() });
    await la2l.pair(receiver.code);
    const delivery = await la2l.send({ title: 'Beat', bpm: 120, sounds: [{ name: 'Beat', audio: renderBeat(), kind: 'loop', role: 'drums' }] });
    await delivery.imported();
    const { plan } = (await receiver.nextReport()).sounds[0];
    assert.deepEqual([plan.warp, plan.bpm, plan.lengthBeats], [true, 120, 4]);
  } finally {
    await receiver.close();
  }
});
```

`nextReport()` resolves to the next report; `reports` holds them all. Each sound has its `plan` (the track name, warp, warp mode, tempo and length in beats), the `info` of its WAV header, or the `error` Live would give.

## By hand

The five calls of [the REST API](rest-api.md) work against the test receiver too. With `--local`, use the address it prints as the base address.
