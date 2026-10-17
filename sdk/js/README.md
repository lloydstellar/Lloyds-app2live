# la2l

Send sounds from your app to Ableton Live with [LA2L](https://lloydstellar.nl/la2l/) (Lloyd's App2Live). The user clicks Import in LA2L, and every sound becomes a new audio track in Live, named, coloured and warped to your tempo.

This is version 0.1.0, still being built: it has the checks of LA2L, so your app judges a package and a WAV file exactly as LA2L in Live does, with the same texts. The client that pairs and sends, the Send to Live button and the command line come next.

```js
import { checkWav, checkManifest, planSound } from 'la2l';

const info = await checkWav(file); // rejects: "This WAV file is compressed (format 85). Send plain PCM or float WAV."
const check = checkManifest(manifest); // as the server judges it
if (!check.ok) console.log(check.error); // "Kick needs bytes and sha256."
```

- `checkWav(blob | bytes)`: the WAV header as LA2L reads it. PCM 8, 16, 24 or 32 bit, or float 32 or 64 bit, mono or stereo, 8 to 192 kHz.
- `checkManifest(manifest, { as: 'server' | 'device' })`: the manifest rules of the server (the default) or of LA2L in Live.
- `planSound(sound, pkg, seconds)`: what Live does with a sound: warp on or off, the warp mode, the tempo, the length in beats, the track name.
- `sha256(blob | bytes)`: the checksum the manifest needs, in pieces, so a file of 200 MB fits in a phone's memory.

ESM only, with type definitions, for browsers and for Node.js 22.12 and newer. No dependencies. Apache License 2.0.

The API: https://github.com/lloydstellar/Lloyds-app2live/blob/main/docs/server-api.md
