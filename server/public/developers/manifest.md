# The package description

Every package carries a short JSON description of its sounds, `app2live/1`. The SDKs write it from what you pass to `send()`; with the REST API you send it to `POST /packages` yourself.

```json
{
  "schema": "app2live/1",
  "title": "Treinbeat",
  "source": { "app": "Web808", "app_version": "1.0.0", "platform": "web" },
  "tempo": { "bpm": 92 },
  "items": [
    { "id": "kick", "file": "kick.wav", "bytes": 1693484, "sha256": "…", "name": "Kick", "kind": "loop", "role": "drums", "length_beats": 16 },
    { "id": "robot", "file": "robot.wav", "bytes": 420112, "sha256": "…", "name": "Robot hallo", "kind": "oneshot", "role": "vocal" }
  ]
}
```

In Live this becomes a scene "Treinbeat (Web808)" with two tracks, "Kick (Web808)" and "Robot hallo (Web808)". The kick is a loop of 16 beats, warped at 92 BPM in Beats mode. The voice plays exactly as the app recorded it.

## The package

| Field | |
|---|---|
| `schema` | Required: `"app2live/1"`. |
| `title` | The name of the scene, with the app after it, and of the folder on disk. Default "Untitled". |
| `source.app` | Added to every track name: "Kick (Web808)". Default "App". |
| `source.app_version`, `source.platform` | For your own use, and for support. |
| `tempo.bpm` | 20 to 999: the tempo of every loop without a `bpm` of its own. |
| `items` | 1 to 32 sounds, 200 MB together. |

## A sound

| Field | |
|---|---|
| `file` | Required. A letter or digit first, then letters, digits, space, `.`, `_` or `-`, ending in `.wav`, at most 100 characters, unique in the package. |
| `bytes`, `sha256` | Required by the server: the exact size of the file, and its SHA-256 in hex. |
| `kind` | `"loop"` or `"oneshot"`. Without it the sound is a one-shot, so always send it for a loop. |
| `name` | The track name, at most 40 characters: letters of any language, digits, space and `_ - ( ) . ' & + # !`. Default "Sound 1", by position. |
| `role` | `drums`, `bass`, `melodic`, `vocal`, `texture` or `fx`: it picks the warp mode of a loop. |
| `bpm` | The tempo of this loop, when it differs from `tempo.bpm`. |
| `length_beats` | The length of the loop in beats. |
| `warp_mode` | Overrides the role: `beats`, `tones`, `texture`, `repitch`, `complex` or `complex_pro`. |
| `color` | `"#RRGGBB"`; Live takes the nearest colour of its palette. Without it, all tracks of a package share one colour, and the next package gets the next one. |
| `gain_db` | The clip gain in dB, from -70 to +24. |
| `id` | Your own id, sent back with the result of this sound. Default: the position, from 1. |

## What LA2L does with it

- A **one-shot** plays as it is: warp off, loop off.
- A **loop** is warped and loops over its whole length. The warp mode follows the role: drums Beats, bass Tones, melodic and vocal Complex Pro, texture Texture, fx and no role Complex.
- The tempo of a loop is its `bpm`, else `tempo.bpm`, else what `length_beats` and the length of the file give. Its length is `length_beats`, else what the tempo and the length of the file give, rounded to a whole beat when it is within 0.1 beat of one. Without any of these, Live guesses the tempo.
- What LA2L does not know, it ignores, and says so in `warnings`: an unknown role, or a `bpm` on a one-shot. The package still goes through.

[app2live-1.schema.json](app2live-1.schema.json) is the JSON Schema of a description as an app sends it.
