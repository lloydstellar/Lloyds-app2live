# LA2L: Send to Live

This app sends sounds to Ableton Live with LA2L (Lloyd's App2Live), through the npm package `la2l`. Follow these notes whenever you build or change that part. Full docs: https://lloydstellar.nl/la2l/llms-full.txt

## How it works

The user has LA2L, a Max for Live device, in Ableton Live. They click Pair app in it once and type the six-character code it shows into this app. After that the app sends WAV files with a description of each sound. When the user clicks Import in LA2L, each sound becomes a track in Live, warped to the tempo the app gave. No API key, no account.

## Install

```bash
npm install la2l
```

## The button

`<la2l-send-button>` asks for the code the first time, sends, and shows the status. Give it a function that returns the sounds at the moment of the click. In React with TypeScript:

```tsx
import { useEffect, useRef } from 'react';
import 'la2l/button';
import type { La2lSendButton } from 'la2l/button';
import { wavFromAudioBuffer } from 'la2l';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'la2l-send-button': React.DetailedHTMLProps<React.HTMLAttributes<La2lSendButton>, La2lSendButton> & { 'app-name'?: string; server?: string };
    }
  }
}

export function SendToLive({ bpm, render }: { bpm: number; render: () => Promise<AudioBuffer> }) {
  const ref = useRef<La2lSendButton>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.sounds = async () => ({
      title: `Beat at ${bpm} BPM`,
      bpm,
      sounds: [{ name: 'Beat', audio: wavFromAudioBuffer(await render()), kind: 'loop', role: 'drums', lengthBeats: 4 }],
    });
  }, [bpm, render]);
  return <la2l-send-button ref={ref} app-name="My app" />;
}
```

Set `sounds` through a ref as above; React 18 cannot pass a function to a custom element as a prop. In Vue, tell the compiler about the element: `isCustomElement: (tag) => tag.startsWith('la2l-')`.

## Without the button

```ts
import { LA2L, La2lError, wavFromAudioBuffer } from 'la2l';

const la2l = new LA2L({ appName: 'My app' }); // Live shows "Paired with My app"
// Pair once, from a field with this line above it:
// "In Live, click Pair app in LA2L and type the code it shows."
await la2l.pair(code);
const delivery = await la2l.send({ title: 'Beat', bpm: 120, sounds: [{ name: 'Beat', audio: wav, kind: 'loop', role: 'drums' }] });
// show "Waiting for Import in Live", then:
await delivery.imported(); // show "In Live"
```

Every error is a `La2lError` with a `code` and a `message` to show as it is. On the code `not_paired`, show the code field again.

## Rendering a loop

Render with an `OfflineAudioContext` exactly a whole number of beats: one bar of 4/4 is `4 * 60 / bpm` seconds, so `Math.round(48000 * 240 / bpm)` frames at 48 kHz. Render a second more, and add what rings past the end of the bar to its start, so the loop has no click and no gap:

```ts
const rate = 48000;
const bar = Math.round(rate * 240 / bpm);
const ctx = new OfflineAudioContext(2, bar + rate, rate);
// schedule every hit at step * 60 / bpm / 4 seconds, connected to ctx.destination
const out = await ctx.startRendering();
const loop = new AudioBuffer({ numberOfChannels: 2, length: bar, sampleRate: rate });
for (let c = 0; c < 2; c++) {
  const from = out.getChannelData(c), to = loop.getChannelData(c);
  to.set(from.subarray(0, bar));
  for (let i = bar; i < from.length; i++) to[i - bar] += from[i];
}
const wav = wavFromAudioBuffer(loop);
```

## Rules

- Every sound needs `kind`: `'loop'` is warped to the tempo and loops, `'oneshot'` plays as it is. A loop without `kind: 'loop'` arrives as a one-shot, out of time.
- Give loops a `bpm` (for the whole package, or per sound) and `lengthBeats` when you know it.
- `role` picks how Live warps a loop: `drums`, `bass`, `melodic`, `vocal`, `texture` or `fx`.
- WAV only: `wavFromAudioBuffer`, `wavFromSamples`, or `toWav` for an mp3 or m4a. Never send an mp3 as if it were WAV.
- Names have at most 40 characters. At most 32 sounds and 200 MB per package.
- Pair once. Never put the token in a URL, a log line or an error report.
- A page with a Content-Security-Policy needs `connect-src https://lloydstellar.nl` and `img-src data:`.
- Call it "Send to Live", with the LA2L logo the button has. Never use the Ableton logo.

## Testing it

Open https://lloydstellar.nl/la2l/receiver in another tab: it stands in for Live. Pair the app with the code it shows and send. The report must say "Loop, warped in Beats mode at 120 BPM, 4 beats" for a loop of one bar at 120 BPM, not "One-shot".
