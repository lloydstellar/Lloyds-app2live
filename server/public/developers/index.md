# LA2L for developers

LA2L (Lloyd's App2Live) is a Max for Live device that brings sounds from apps into Ableton Live. Your app sends WAV files with a short description of each sound. In Live the user clicks **Import**, and every sound becomes an audio track, named after your app, coloured, and warped to your tempo.

There is no API key and no developer account. The user pairs your app once with a code that LA2L shows in Live, and that code is the consent.

```js
import { LA2L, wavFromAudioBuffer } from 'la2l';

const la2l = new LA2L({ appName: 'Web808' }); // Live shows "Paired with Web808"
if (!la2l.paired) await la2l.pair(codeFromUser); // the code LA2L shows, like "K7P 42Q"

const delivery = await la2l.send({
  title: 'Treinbeat',
  bpm: 92,
  sounds: [{ name: 'Beat', audio: wavFromAudioBuffer(loopBuffer), kind: 'loop', role: 'drums' }],
});
await delivery.imported(); // the user clicked Import in Live
```

## Pick your way in

| Your app | Use | Read |
|---|---|---|
| A web app | `npm install la2l`, or the Send to Live button without a build step | [Web apps](web.md), [The button](button.md) |
| An Android app | Five HTTPS calls from Kotlin or Java | [Android](android.md) |
| A script, or any other language | `npx la2l send`, or the same five calls | [The REST API](rest-api.md) |
| Built with an AI tool | The LA2L skill, or the paste text for Lovable and Bolt | [AI tools](ai-tools.md) |

## What happens

1. **Pairing.** In Live, the user clicks **Pair app** in LA2L. It shows a code like `K7P 42Q`, valid for 10 minutes. The user types it into your app, and your app trades it for a token that it keeps.
2. **Sending.** Your app sends a package: one to 32 WAV files, and per sound whether it is a loop or a one-shot, what it plays (drums, bass, a vocal) and its tempo.
3. **Import.** The next time the user clicks Import in LA2L, every sound becomes a track. A loop is warped to the tempo you gave and loops; a one-shot plays exactly as your app rendered it. Your app sees that it arrived.

The description is what puts a sound in time. A loop sent without `kind: 'loop'` arrives as a one-shot, without warp. [The package description](manifest.md) has every field.

## Limits

- WAV only: PCM 16 or 24 bit (8 and 32 work too) or float 32 or 64 bit, mono or stereo, 8 to 192 kHz. The SDK turns Web Audio and mp3 or m4a files into WAV.
- 32 sounds and 200 MB per package, and 30 packages an hour per app.
- A package waits 24 hours for Import. Its result stays readable for your app for 7 days.

## Test without Ableton

The test receiver stands in for LA2L in Live: it shows a code, imports what you send, and says per sound what Live would do. It runs as a page, in a terminal, and inside your own tests, without internet. See [Testing](testing.md).

## All pages

- [Web apps](web.md): the npm package, Web Audio to WAV, following a send.
- [The button](button.md): `<la2l-send-button>`, and how to name LA2L and Ableton.
- [Android](android.md): sending from Kotlin or Java.
- [The REST API](rest-api.md): the five calls, the command line, and the OpenAPI file.
- [The package description](manifest.md): every field, and what LA2L does with it.
- [Testing](testing.md): the test receiver.
- [AI tools](ai-tools.md): the skill, the docs index for agents, the paste text, and `llms.txt`.

Every page is also there as Markdown: add `.md` to its address. All pages in one file: [llms-full.txt](../llms-full.txt).
