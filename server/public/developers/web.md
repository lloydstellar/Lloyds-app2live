# Web apps

The npm package `la2l` pairs, checks, uploads and follows a send. It has no dependencies, and comes with types and its own docs.

```bash
npm install la2l
```

```js
import { LA2L, wavFromAudioBuffer } from 'la2l';

const la2l = new LA2L({ appName: 'Web808' });
if (!la2l.paired) await la2l.pair(codeFromUser);

const delivery = await la2l.send({
  title: 'Treinbeat',
  bpm: 92,
  sounds: [
    { name: 'Beat', audio: wavFromAudioBuffer(loopBuffer), kind: 'loop', role: 'drums', lengthBeats: 4 },
    { name: 'Robot hallo', audio: voiceWav, kind: 'oneshot', role: 'vocal' },
  ],
  onProgress: (share) => (bar.value = share), // 0 to 1
});
status.textContent = 'Waiting for Import in Live';
const result = await delivery.imported();
status.textContent = result.status === 'imported' ? 'In Live' : 'In Live, partly';
```

ESM for browsers, Node.js 22.12 and newer, Deno and Bun. A page without a build step loads the [button](button.md) from jsDelivr, which carries the same functions.

## Pairing

Show a field for the code once, with this line above it: "In Live, click Pair app in LA2L and type the code it shows." Case, spaces and dashes do not matter. The SDK keeps the token in `localStorage` (in Node.js, in a file only the user can read) and sends it only in the `Authorization` header. Never put it in a URL, a log line or an error report.

Ask for a code again only when a call fails with the code `not_paired`: then the user unpaired your app in Live. `la2l.me()` tells you which computer you are paired with; `la2l.unpair()` ends the pairing.

## Making WAV files

```js
import { wavFromAudioBuffer, wavFromSamples, toWav, checkWav } from 'la2l';

wavFromAudioBuffer(buffer);                 // an AudioBuffer, 16 bit; { bits: 24 } or { bits: 32 } (float)
wavFromSamples([left, right], 48000);       // Float32Arrays from -1 to 1
await toWav(file);                          // mp3, m4a, ogg: decoded by the browser
await checkWav(file);                       // can LA2L use it? With LA2L's own text if not
```

A loop must be a whole number of beats long: one bar of 4/4 lasts `4 * 60 / bpm` seconds, exactly 2 seconds at 120 BPM. Render it with an `OfflineAudioContext` of that length plus a tail, and add the tail to the start, so what rings past the end of the bar plays at the start of the next one:

```js
async function renderLoop(bpm, schedule, tailSeconds = 1) {
  const rate = 48000;
  const bar = Math.round(rate * (60 / bpm) * 4);
  const ctx = new OfflineAudioContext(2, bar + Math.round(rate * tailSeconds), rate);
  schedule(ctx); // start your sources at step * 60 / bpm / 4
  const rendered = await ctx.startRendering();
  const loop = new AudioBuffer({ numberOfChannels: 2, length: bar, sampleRate: rate });
  for (let c = 0; c < 2; c++) {
    const from = rendered.getChannelData(c);
    const to = loop.getChannelData(c);
    to.set(from.subarray(0, bar));
    for (let i = bar; i < from.length; i++) to[i - bar] += from[i];
  }
  return wavFromAudioBuffer(loop);
}
```

## Following a send

`send()` checks everything before the first byte goes out, with the texts LA2L itself uses, then uploads the files and commits them. It resolves to a `Delivery`:

- `delivery.imported()` waits until the user clicked Import, and resolves to the status: `imported`, or `partial` with the result per sound. It rejects when the package failed or expired.
- `delivery.status()` asks once; `delivery.cancel()` takes the package back until it is in Live.
- `delivery.warnings` names what LA2L will ignore, such as an unknown role. Show them to yourself, not to the user.

## Errors

Every error is a `La2lError` with a `code` and a `message` that you can show as it is.

| `code` | What to do |
|---|---|
| `not_paired` | Show the code field again. |
| `bad_code` | Show the message, and ask for the code again. |
| `bad_wav`, `bad_package` | Show the message: it names the sound and what is wrong. |
| `rate_limited` | Wait `retryAfter` seconds. |
| `server_full` | Show the message, often "Click Import in Live first". |
| `network`, `server` | Try again later. |
| `import_failed`, `expired` | Show the message; the sounds can be sent again. |
| `aborted` | Your app stopped it, with an `AbortSignal`. |

## Content-Security-Policy

A page with a CSP must allow the LA2L server: `connect-src https://lloydstellar.nl`. The button shows the LA2L logo as a `data:` image, so it also needs `img-src data:`.

## Server-side rendering

`la2l` and `la2l/button` can be imported where a page is rendered on a server (Next.js, Nuxt, SvelteKit): there the button does nothing. Call `send()` in the browser.

## An example

[Web808](../examples/drum-machine/), a drum machine of four sounds and 16 steps, sends its loop and every sound as a one-shot. Its source is in `examples/web-drum-machine` of the LA2L repository.

## The full docs

The package carries its docs, for the version you installed, in `node_modules/la2l/docs`: getting started, the API, Web Audio, the button, testing and errors. `npx la2l agents-md` points AI coding agents to them ([AI tools](ai-tools.md)).
