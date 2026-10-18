# Web apps

## Render a loop with Web Audio

Render exactly one bar (or a whole number of bars) at the tempo, and fold what rings past the end back to the start, so the loop has no seam:

```js
import { wavFromAudioBuffer } from 'la2l';

// One bar of 4/4 at `bpm` as an AudioBuffer: schedule(ctx) starts your sources on the context.
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
    for (let i = bar; i < from.length; i++) to[(i - bar) % bar] += from[i];
  }
  return loop;
}

const wav = wavFromAudioBuffer(await renderLoop(120, schedule));
```

Send that WAV with `kind: 'loop'`, the `bpm` and `lengthBeats: 4`.

## Files the user picks

```js
import { toWav, checkWav } from 'la2l';
const wav = await toWav(file); // mp3, m4a, ogg: decoded to WAV; a WAV LA2L takes comes back as it is
```

`checkWav(file)` says before sending whether LA2L can use a file, with LA2L's own text.

## The button

```html
<la2l-send-button app-name="Web808"></la2l-send-button>
```

- With a bundler: `import 'la2l/button'`. Without one: `<script type="module" src="https://cdn.jsdelivr.net/npm/la2l@0.1.0/dist/button.min.js"></script>`, and import the helpers from that same address.
- Give it the sounds: `button.sounds = async () => ({ title, bpm, sounds })`, called at the click.
- Events: `la2l-paired`, `la2l-sent`, `la2l-imported`, `la2l-error`.
- `button.texts = { send: 'Naar Live sturen' }` for another language; CSS custom properties such as `--la2l-accent` for the looks.
- Content-Security-Policy: allow the LA2L server in `connect-src` (`https://lloydstellar.nl`); the logo needs `img-src data:`.
- Brand: "Send to Live" with the LA2L logo. Never the Ableton logo: Ableton and Live are trademarks of Ableton.

## React, Vue, Svelte, Angular

Set `sounds` as a property. In React through a ref, and declare the element once for TypeScript:

```tsx
import { useEffect, useRef } from 'react';
import 'la2l/button';
import type { La2lSendButton, SoundsProvider } from 'la2l/button';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'la2l-send-button': React.DetailedHTMLProps<React.HTMLAttributes<La2lSendButton>, La2lSendButton> & { 'app-name'?: string; server?: string; 'app-id'?: string };
    }
  }
}

export function SendToLive({ sounds }: { sounds: SoundsProvider }) {
  const ref = useRef<La2lSendButton>(null);
  useEffect(() => {
    if (ref.current) ref.current.sounds = sounds;
  }, [sounds]);
  return <la2l-send-button ref={ref} app-name="My app" />;
}
```

Vue: `isCustomElement: (tag) => tag.startsWith('la2l-')` in the compiler options, and `:sounds.prop="sounds"`. Svelte: `sounds={sounds}`. Angular: `CUSTOM_ELEMENTS_SCHEMA` and `[sounds]="sounds"`.

## Server-side rendering

`la2l/button` can be imported on a server (Next.js, Nuxt, SvelteKit): it does nothing there. Call `la2l.send` only in the browser.
