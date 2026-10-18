# The description of a package (`app2live/1`)

The SDK writes it for you from `send({ title, bpm, sounds })`. Without the SDK, send this JSON to `POST /packages`.

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

This becomes two tracks, "Kick (Web808)" and "Robot hallo (Web808)". The kick is a 16-beat loop warped at 92 BPM in Beats mode; the voice plays as it is.

## The package

| Field | |
|---|---|
| `schema` | Required: `app2live/1`. |
| `title` | The scene name (with the app after it: "Treinbeat (Web808)") and the folder on disk. Default "Untitled". |
| `source.app` | Added to every track name. Default "App". |
| `tempo.bpm` | 20 to 999: the tempo of every loop without a `bpm` of its own. |
| `items` | 1 to 32 sounds, 200 MB in total. |

## A sound

| Field | |
|---|---|
| `file` | Required. A letter or digit first, then letters, digits, space, `.`, `_` or `-`, ending in `.wav`, at most 100 characters. Unique in the package. |
| `bytes`, `sha256` | Required by the server: the exact size, and the SHA-256 in hex. |
| `kind` | `loop` or `oneshot`. Without it the sound is a one-shot: always send it for a loop. |
| `name` | At most 40 characters; letters of any language, digits, space and `_ - ( ) . ' & + # !`. |
| `role` | `drums`, `bass`, `melodic`, `vocal`, `texture` or `fx`. |
| `bpm` | This loop's tempo, when it differs from `tempo.bpm`. |
| `length_beats` | The loop length in beats. |
| `warp_mode` | Overrides the role: `beats`, `tones`, `texture`, `repitch`, `complex`, `complex_pro`. |
| `color` | `#RRGGBB`. |
| `gain_db` | -70 to +24. |
| `id` | Your own id, sent back in the result. |

## What LA2L does with it

- **One-shot**: warp off, loop off. It plays exactly as the app rendered it.
- **Loop**: warp on, looped over its length. The warp mode follows the role: drums Beats, bass Tones, melodic and vocal Complex Pro, texture Texture, fx or none Complex.
- The tempo of a loop is its `bpm`, else `tempo.bpm`, else `60 × length_beats / seconds`. The length is `length_beats`, else `seconds × bpm / 60`, rounded to a whole beat when it is within 0.1 beat. Without any tempo, Live guesses.

The JSON Schema: https://github.com/lloydstellar/Lloyds-app2live/blob/main/docs/app2live-1.schema.json
