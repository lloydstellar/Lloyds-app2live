# The button

`<la2l-send-button>` is a Send to Live button with the LA2L logo. The first click asks for the code that LA2L shows in Live; after that one click sends, and the button says what happens: "Sending 2 sounds… 45%", "Waiting for Import in Live", "In Live".

## Without a build step

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@lloydstellar/la2l@0.1.0/dist/button.min.js"
        integrity="sha384-A/Nu56J/Oh1+eLYYZgGeFUEk9dgZSWIanzPgaba1I1IjsXk2135KwQ4TYD940D0C" crossorigin="anonymous"></script>
<la2l-send-button app-name="Web808"></la2l-send-button>
<script type="module">
  import { wavFromAudioBuffer } from 'https://cdn.jsdelivr.net/npm/@lloydstellar/la2l@0.1.0/dist/button.min.js';
  document.querySelector('la2l-send-button').sounds = async () => ({
    title: 'Treinbeat',
    bpm: 92,
    sounds: [{ name: 'Beat', audio: wavFromAudioBuffer(await renderLoop(92, schedule)), kind: 'loop', role: 'drums' }],
  });
</script>
```

The one file carries the button with `LA2L`, `La2lError`, `wavFromAudioBuffer`, `wavFromSamples` and `toWav`, so the page imports the WAV helpers from the same address. `renderLoop()` is yours: [Web apps](web.md) shows one that renders one bar as an `AudioBuffer`.

## With a bundler

```js
import '@lloydstellar/la2l/button';
import { wavFromAudioBuffer } from '@lloydstellar/la2l';
```

## Giving it the sounds

Set `sounds` to a function. The button calls it at the click, so it sends what the user has at that moment. It may return a promise, the options of `send()` (`title`, `bpm`, `sounds`), or only the list of sounds. A framework that cannot set a property can listen for the `la2l-request` event instead and call `event.detail.provide(value)` in it.

## In React, Vue, Svelte and Angular

The button is a custom element, so every framework can use it. Give it `sounds` as a property, not as an attribute. In React, through a ref (React 18 passes only strings to a custom element), with one declaration per project so that TypeScript knows the element:

```tsx
import { useEffect, useRef } from 'react';
import '@lloydstellar/la2l/button';
import type { La2lSendButton, SoundsProvider } from '@lloydstellar/la2l/button';

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
  return <la2l-send-button ref={ref} app-name="Web808" />;
}
```

- Vue: tell the compiler it is not a Vue component, in the Vue plugin of `vite.config`: `template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('la2l-') } }`. Then `<la2l-send-button app-name="Web808" :sounds.prop="sounds" />`.
- Svelte: `<la2l-send-button app-name="Web808" sounds={sounds}></la2l-send-button>`.
- Angular: add `CUSTOM_ELEMENTS_SCHEMA` to the `schemas` of the component, then `<la2l-send-button app-name="Web808" [sounds]="sounds"></la2l-send-button>`.

## Attributes, events, texts and looks

| Attribute | |
|---|---|
| `app-name` | The name Live shows: "Paired with Web808", and "Kick (Web808)" in every track name. Default: the page title. |
| `server` | Another LA2L server, such as a local test receiver. |
| `app-id` | Your own id for this installation. Default: one made once. |

| Event | `detail` |
|---|---|
| `la2l-paired` | `{ deviceName }` |
| `la2l-sent` | the `Delivery` |
| `la2l-imported` | the status, with the result per sound |
| `la2l-error` | the `La2lError` |

Another language: `button.texts = { send: 'Naar Live sturen', waiting: 'Wacht op Import in Live' }`. Every text you leave out stays English.

The looks follow CSS custom properties on the element: `--la2l-accent`, `--la2l-accent-text`, `--la2l-radius`, `--la2l-font`, `--la2l-text`, `--la2l-muted`, `--la2l-bad`, `--la2l-focus`, `--la2l-line`, `--la2l-dialog-background`, `--la2l-dialog-text` and `--la2l-color-scheme`.

```css
la2l-send-button { --la2l-accent: #2a6df4; --la2l-radius: 8px; }
```

## The brand

- Call it **Send to Live**, with the LA2L logo, as the button does. Use the LA2L logo as it is: [logo.png](../logo.png).
- Never use the Ableton logo, and do not make it look like a feature of Ableton. Ableton and Live are trademarks of Ableton AG, and LA2L is not made by Ableton.
- In your own words: "Sends your sounds to Ableton Live with LA2L."
