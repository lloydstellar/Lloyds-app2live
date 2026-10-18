# The Send to Live button

`<la2l-send-button>` is a button with the LA2L logo that pairs and sends. The first click asks for the code that LA2L shows in Live; after that one click sends, and the button says what happens: "Sending 2 sounds… 45%", "Waiting for Import in Live", "In Live".

## Without a build step

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/la2l@0.1.0/dist/button.min.js"
        integrity="sha384-dn1o9Tph7y4C/O1tkM+grXdkjsNCT03y/LIY/iEwXiCw0wyDQyAJMDDSiqcurWcl" crossorigin="anonymous"></script>
<la2l-send-button app-name="Web808"></la2l-send-button>
```

`button.min.js` is one module with the button, the client and the WAV helpers. Import the helpers from the same address:

```html
<script type="module">
  import { wavFromAudioBuffer } from 'https://cdn.jsdelivr.net/npm/la2l@0.1.0/dist/button.min.js';
</script>
```

The hash belongs to this version: take the line from the docs of the version you use.

## With a bundler

```js
import { wavFromAudioBuffer } from 'la2l/button'; // also registers <la2l-send-button>
```

With a bundler the button shares the client with `import ... from 'la2l'`, so the SDK is in your app once. The module can be imported on a server too (pre-rendering in Next.js, Nuxt or SvelteKit): there it does nothing.

## Giving it the sounds

The page renders only when the button is clicked:

```js
document.querySelector('la2l-send-button').sounds = async () => ({
  title: 'Treinbeat',
  bpm: 92,
  sounds: [{ name: 'Beat', audio: wavFromAudioBuffer(await renderLoop()), kind: 'loop', role: 'drums', lengthBeats: 4 }],
});
```

The function may also return just the list of sounds. `sounds` and `texts` can be set before the button's script has loaded; the button takes them over.

Or answer the `la2l-request` event. The listener must call `event.detail.provide(...)` before it returns, with the send or a promise of it:

```js
button.addEventListener('la2l-request', (event) => event.detail.provide(renderSend()));
```

## In React, Vue, Svelte and Angular

The button is a custom element, so every framework can use it. Give it `sounds` as a property, not as an attribute. In React, through a ref (React 18 passes only strings to a custom element), with one declaration per project so that TypeScript knows the element:

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
  return <la2l-send-button ref={ref} app-name="Web808" />;
}
```

- Vue: tell the compiler it is not a Vue component, in the Vue plugin of `vite.config`: `template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('la2l-') } }`. Then `<la2l-send-button app-name="Web808" :sounds.prop="sounds" />`.
- Svelte: `<la2l-send-button app-name="Web808" sounds={sounds}></la2l-send-button>`.
- Angular: add `CUSTOM_ELEMENTS_SCHEMA` to the `schemas` of the component, then `<la2l-send-button app-name="Web808" [sounds]="sounds"></la2l-send-button>`.

## Attributes, events, texts and looks

- Attributes: `app-name` (the name Live shows; without it, the page title), `server`, `app-id`: as the options of `new LA2L` ([api.md](api.md)).
- Events: `la2l-paired` (`detail.deviceName`), `la2l-sent` (the delivery), `la2l-imported` (the status), `la2l-error` (the error; check its `code`).
- `button.texts = { send: 'Naar Live sturen', ... }` replaces any text; the keys are in `TEXTS`. The error texts (`errorNetwork`, `errorServerFull`, `errorBadWav` and the others) are empty, so the button shows LA2L's own English text, which says exactly what went wrong; give them your own texts for another language.
- CSS custom properties: `--la2l-accent`, `--la2l-accent-text`, `--la2l-radius`, `--la2l-font`, `--la2l-text`, `--la2l-muted`, `--la2l-bad`, `--la2l-line`, `--la2l-focus`, `--la2l-dialog-background`, `--la2l-dialog-text`, and `--la2l-color-scheme` (`light` by default; `dark` for a dark dialog with dark colours of your own). Parts: `button`, `logo`, `status`, `dialog`.
- `await button.unpair()` unpairs the page; it rejects with `network` when the server cannot be reached, and the page stays paired.

It is a real `<button>` and a modal `<dialog>`, so it works with the keyboard and a screen reader; the focus comes back to the button when the dialog closes, and the status line is a live region that does not read out every percent.

## Content-Security-Policy

The styles go in as a constructed style sheet, which a strict policy allows. The page's policy must allow the LA2L server in `connect-src` (`https://lloydstellar.nl`), and the logo is a `data:` image: without `img-src data:` the button works, without its logo.

## Brand

The button says "Send to Live" with the LA2L logo. Do not add the Ableton logo: Ableton and Live are trademarks of Ableton, and this is not an Ableton feature.
