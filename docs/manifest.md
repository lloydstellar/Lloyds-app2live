# App2Live package format (`app2live/1`)

A package is a set of WAV files plus one JSON manifest that says what each sound is. The app only describes the sounds (a loop or a one-shot, drums or vocals); the device decides the Live settings. The device checks the manifest in `src/node/manifest.js`.

## Example

```json
{
  "schema": "app2live/1",
  "package_id": "7f3c2a9e-1b4d-4c8e-9a51-0d2e6f7b8c90",
  "created_at": "2026-10-16T14:30:00Z",
  "title": "Treinbeat",
  "source": { "app": "Web808", "app_version": "1.0.0", "platform": "web" },
  "tempo": { "bpm": 92.0, "time_signature": [4, 4] },
  "items": [
    { "id": "kick", "file": "kick.wav", "sha256": "…", "bytes": 1693484, "name": "Kick", "kind": "loop", "role": "drums", "length_beats": 16, "color": "#E5484D" },
    { "id": "robot", "file": "robot.wav", "sha256": "…", "bytes": 420112, "name": "Robot hallo", "kind": "oneshot", "role": "vocal" }
  ],
  "midi": []
}
```

This becomes two new audio tracks, "Kick (Web808)" and "Robot hallo (Web808)". The kick is a 16-beat loop warped at 92 BPM in Beats mode; the voice plays as it is.

## The package

| Field | Required | |
|---|---|---|
| `schema` | yes | `app2live/1`. A device that gets `app2live/2` says "Update LA2L to import it" and confirms the package as failed. |
| `package_id` | yes | `[A-Za-z0-9._-]{1,100}`, a UUID is best. Must be the id the inbox gave. |
| `title` | no | The name of the scene (Session) and of the folder on disk. Default "Untitled". |
| `source.app` | no | The app name, added to every track name: "Kick (Web808)". Default "App". |
| `source.app_version`, `source.platform` | no | Only logged. |
| `created_at` | no | ISO 8601, only logged. |
| `tempo.bpm` | no | 20 to 999. The tempo of every loop in the package, unless a sound has its own `bpm`. |
| `tempo.time_signature` | no | `[4, 4]`. Read, not used yet. |
| `items` | yes | 1 to 32 sounds, 200 MB in total. |
| `midi` | no | Reserved for MIDI parts (a later version). Ignored now, with a note in the log. |

A problem with the package as a whole (no schema, no sounds, too many, too large) stops that package. A problem with one sound only skips that sound; the rest still goes in.

## A sound

| Field | Required | |
|---|---|---|
| `file` | yes | The file name on the server: starts with a letter or digit, then letters, digits, space, `.`, `_` or `-`, ends in `.wav`, at most 100 characters. Only used to download; on disk the file is named after `name`. Two sounds cannot use the same file. |
| `id` | no | Your own id, sent back in the ack. Default: the position, starting at 1. |
| `name` | no | Track and clip name, at most 40 characters. Letters of any language, digits and `space _ - ( ) . ' & + # !`. Default "Sound 1". |
| `kind` | no | `loop` or `oneshot`. Anything else is placed as a one-shot. |
| `role` | no | `drums`, `bass`, `melodic`, `vocal`, `texture` or `fx`. Picks the warp mode of a loop. |
| `bpm` | no | The tempo of this sound, when it differs from `tempo.bpm`. |
| `length_beats` | no | The loop length in beats. Without it the device works it out from the file length and the tempo. |
| `warp_mode` | no | Overrides the role: `beats`, `tones`, `texture`, `repitch`, `complex`, `complex_pro`, or Live's numbers 0, 1, 2, 3, 4, 6. |
| `color` | no | `#RRGGBB`. Live picks the nearest colour of its palette. Without it all tracks of a package share one colour, and the next package gets the next colour. |
| `gain_db` | no | Clip gain in dB, kept between -70 and +24. |
| `sha256`, `bytes` | no, but send them | Checked after the download. A damaged file is downloaded again, up to 3 times. |

## How a sound goes into Live

**One-shot**: warp off, loop off. It plays exactly as the app rendered it.

**Loop**: warp on, looped over its length, with this warp mode:

| `role` | Warp mode | Why |
|---|---|---|
| `drums` | Beats | Keeps the transients tight. |
| `bass` | Tones | Clear pitch, little smearing. |
| `melodic`, `vocal` | Complex Pro | Best on mixed or sung material. It costs the most CPU, so only these get it. |
| `texture` | Texture | For pads and noise. |
| `fx`, or no role | Complex | A safe middle. |

The tempo of a loop is the sound's `bpm`, else `tempo.bpm`, else `60 × length_beats / seconds`. The length is `length_beats`, else `seconds × bpm / 60`. A length within 0.1 beat of a whole number is rounded to it, because an app that renders 4 beats means 4 beats. The device makes Live play the file at that tempo with warp markers (see [design-notes.md](design-notes.md)), so the loop stays in time whatever the Set tempo is. A loop without any tempo is warped and looped as Live itself guesses it.

## Files

WAV only: PCM 8, 16, 24 or 32 bit, or float 32 or 64 bit, mono or stereo, 8 to 192 kHz. The device reads the header itself before Live sees the file, so a compressed WAV, an RF64 file, or an HTML error page saved as `.wav` gets a clear message instead of an empty track.
