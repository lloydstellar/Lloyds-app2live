# Design notes

Why LA2L is built the way it is, and what is still unproven in a real Live. Read this before changing the Live part.

## Three parts

| Part | Runs in | Does |
|---|---|---|
| Patch (`tools/gen-patch.js`) | Max | The interface. Shows one view at a time and passes clicks to Node. No logic. |
| Node (`src/node`, bundled to `la2l-node.js`) | Node for Max, its own process | Network, files, WAV check, manifest, settings, log, and every decision. |
| Live part (`src/live/la2l-live.js`) | `[v8]` on Max's main thread | The Live API: tracks, clips, warp, loop, names, colours. |

Node cannot reach the Live API, and the Live API cannot do network or file work without blocking Live. So Node prepares everything (downloaded, checked, with a plan per sound) and sends the v8 script one request per package:

- Node to Max: `tolive request <json>`. The patch routes it to the v8 script as `request <json>`. The JSON is one Max symbol, so spaces, commas and backslashes inside it are never parsed by Max.
- v8 to Node: `live <json>` with `type` `info`, `progress`, `result` or `log`, matched to the request by `id`. A progress message restarts Node's time-out, so a package of 32 sounds does not time out.
- The v8 script answers `getinfo` only after `init`, which the patch sends when `live.thisdevice` reports that the device is loaded. Before that, the Live API does not work.

`app.js` talks to Max only through `out(name, ...values)` and to Live only through `LiveBridge`, so the whole device runs in `node --test` against `tests/mock-live.js` (a simulated Live that runs the real v8 script) and `tests/mock-server.js`.

## An import is a generator

Live applies some clip changes a moment later (switching warp on, for example). The import in the v8 script is a generator: each `yield ms` hands control back, the patch waits that long with `[delay]`, moves to the low-priority thread with `[deferlow]`, and sends `step`. One package runs at a time; a second Import while one runs is told to wait.

## Placing a sound

1. A new audio track right after the device's track (or at the end), in the order of the package. With the device on a group track that is the top of the group: Live puts a track created right after a group's header into the group, and the Live API cannot move a track out of a group again. Every folded group the new tracks are in is unfolded, so they are in sight (from 0.2.2, Erik's choice). On the Main track or a return track the new tracks go at the end; in a rack the device counts as being on the rack's track.
2. Name and colour on the track.
3. `ClipSlot.create_audio_clip(path)` in a Session slot: in Session mode the slot in a new scene at the top of the Session (`Song.create_scene(0)`), in Arrangement mode slot 0 of the new track. The native path is tried first, then the same path with forward slashes, and the log says which form worked.
4. Warp, warp mode, tempo and loop (below), then clip gain.
5. Arrangement mode: `Track.duplicate_clip_to_arrangement(clip, time)` at 1.1.1 (beat 0), then the Session clip is deleted. Until 0.1.1 this was the playhead rounded to the nearest bar; after playing, the playhead can be minutes into the Set, and the new sounds then landed out of sight. `Track.create_audio_clip(path, time)` would put the clip straight into the Arrangement, but its length is then the whole file and cannot be changed afterwards; the copy of a looped Session clip gets exactly the loop length. If the copy fails, the clip stays in the Session slot and the log says why.
6. If anything fails, the new track is deleted again, so a failed sound never leaves an empty track. The other sounds of the package still go in. A new scene that got no clip at all is deleted too.
7. The first new track is selected and its clip shown.

The copy to the Arrangement is detected by the clip `duplicate_clip_to_arrangement` returns, or else by the number of Arrangement clips on the track, so a clip is never copied twice when Live answers in an unexpected form.

## Tempo with warp markers

There is no Live API call to set the tempo of an audio clip, so the script does it with warp markers. What Live 12.4.6 did in the first test (Windows):

- A clip made with `create_audio_clip` is not warped. `Clip.warp_markers` gives the first marker (beat 0, sample 0) plus a hidden marker 1/32 beat later. The hidden marker always sits 1/32 beat after the last visible marker and only carries the tempo of the last part; it is not at the end of the file.
- Switching warping on keeps those two markers. The clip then plays at the Set tempo of that moment, not at its own tempo.
- `add_warp_marker` works with a JS object `{beat_time, sample_time}`. The beat Live stores can differ a little from the one asked (0.03093755203130203 for 0.0309375).
- `move_warp_marker` and `remove_warp_marker` find a marker by its beat time. That works for the marker at beat 0, but silently does nothing for a marker at any other beat, even with the exact number Live gave back.

So the script never has to find a marker other than the one at beat 0:

1. Markers between the first and the hidden one, which only exist when Live auto-warped the clip, are removed if Live lets us. The first marker is put at sample 0 and beat 0.
2. **End marker**: one marker just before the end of the file (5 ms before it, or 1% of the file when that is shorter), at the beat that gives the wanted tempo. The first marker stays at beat 0, so the clip starts at 1.1.1.
3. **First marker**, when Live put that end marker at the old tempo after all (Live 12.4.6 on Windows did not need this): the first marker (at beat 0) is moved so that the part up to the end marker runs at the wanted tempo. The clip then starts before 1.1.1 in its own timeline; it still plays from the start of the file and stays in time.

After every step it reads the markers back. The report per sound says `exact` (Live's markers already fit, because the Set tempo was the sound's tempo), `exact (end marker)`, `exact (first marker)` or `approximate`, and the log has Live's original markers and the final ones.

`add_warp_marker` is tried as a JS object with `beat_time` and `sample_time` first, then with `beat_time` only (Live then keeps the current timing), then as a `Dict`; the log says when a later form was needed.

## Clip gain

`Clip.gain` runs from 0 to 1 and is not linear in dB. The script searches the value where `gain_display_string` starts to show the wanted dB and where it passes it, and takes the middle. That is within 0.05 dB of the target.

## Files and folders

- With a saved Set (`Song.file_path`), sounds go to `<project>/Samples/LA2L/<YYYY-MM-DD HHMM> <title>/`, so Collect All and Save keeps working. Otherwise to `Documents/Lloyds App2Live/Inbox/...`.
- File names come from the sound name, cleaned to letters, digits, space, `-` and `_`. Names from a package never become a path, and an existing file is never overwritten.
- A download goes to `<file>.part` and is renamed only when size and sha256 match. When the server answers a download with an error, the device keeps the first 64 KB of that answer and shows the server's `error` text after its own message, as for JSON calls.
- The WAV header is read by walking its chunks, 8 bytes at a time. After 1000 chunks without both `fmt ` and `data` the file is refused as damaged: real files have a handful, and a file built of millions of empty chunks would otherwise keep Node busy for seconds. The server uses the same check (`src/node/wav.js`).
- A Mac path in Max notation (`Macintosh HD:/Users/...`) loses its volume name before Node or Live uses it.

## Never twice

`settings.json` keeps the last 200 imported package ids. If the server did not get the confirmation (the ack), the package shows up again; the device then confirms it again without placing it.

## Which apps are paired

The device learns the name of an app from the `paired` answer when that app pairs. Nothing tells it when an app unpairs itself, so from 0.2.0 it asks the server (`GET /apps`) when Live loads the device, after every Import and in Self test, and shows what the server says. The server cannot reach the device, it only answers, so from 0.2.2 the device also asks every 15 seconds while Import shows (not while a code shows or an Import runs): Pair app then comes back by itself after the last app unpaired itself. A problem with that background call is logged once while it lasts, and a server without the call is not asked again until an Import or Self test gets a list. A server without that call (404) leaves the names as they were. An answer that comes back after a pairing finished is not used, so it cannot drop the app that just paired.

With no apps left, the device shows Pair app again instead of Import (from 0.2.1, Erik's choice after testing 0.2.0), but it keeps its token. Pair app then sends that token with `POST /pair/start`, as Add app does, so the new app joins the same computer, and packages that an app sent before it unpaired itself (the server keeps them until they expire) come in with the next Import. Only Unpair in Settings gives up the token.

While a code shows, Copy code puts it on the clipboard for an app on the same computer, such as LA2L Sender in a browser. Max has no object for the clipboard, so Node runs the system's own tool: `clip.exe` on Windows, `pbcopy` on a Mac, the way Open folder runs Explorer or Finder.

## The patch

These come from Lloyd's Sample Maker and are handled in `gen-patch.js`:

- All `live.*` controls are hidden parameters (`parameter_invisible` 2): not stored in the Set and not automatable, so nothing fires by itself when a Set loads. Settings come from `settings.json` and are set with `set`, which does not send anything back.
- Buttons send `bang` or `1`; both go through `[route bang 1]` into `[t b]`.
- Text for the display is sent as separate words and stripped of `, ; \ " $ { } [ ]` and backticks. An empty text arrives as `bang` and clears the field.
- Views are switched with `script show` and `script hide` on named objects; every view hides the tempo row, and Node shows it again when it applies.
- Live keeps a loaded device in memory. After a new build, restart Live before testing.
- Never save the device from the Max editor; build it with `node tools/build.js`.

## Proven and not yet proven in a real Live

The simulated Live follows the Live Object Model documentation and what Live 12.4.6 did in the first test on Windows. Every open point has a fallback, and the log shows what Live did:

| Question | So far | Where to look in `la2l.log` |
|---|---|---|
| Which path form `create_audio_clip` accepts | Windows: the native path (`C:\...`). Mac: not tested yet. | `create_audio_clip worked with path form 2`, or nothing when the first form worked |
| Which argument form `add_warp_marker` and `duplicate_clip_to_arrangement` take | Form 1 for both: a JS object, and `('id', n)` | `... worked with form N`, or nothing when the first form worked |
| How Live returns `warp_markers` | As described under Tempo above | `liveWarp` and `markers` in the `placed on track` line |
| Whether `add_warp_marker` keeps `beat_time` when `sample_time` is given too | Yes, on Windows: in the 0.1.1 test a 135 BPM loop in a 120 BPM Set showed BPM 135.00 and Start 1.1.1, so the end marker did it | `"tempo":"exact (end marker)"` means yes, `"exact (first marker)"` means no |
| Whether `Song.create_scene(0)` puts the new scene at the top | Yes, on Windows (0.1.1 test) | The Session View itself |
| Whether `Song.file_path` gives the Set's path | Yes, on Windows | `Set: <path>` in the `Live 12.x.x` line |
| Where `create_audio_track` puts a track next to a group | Right after a group's header: inside the group, at its top. Seen on Windows in the 0.2.2 test, as a [Max forum report](https://cycling74.com/forums/is-it-possible-to-create-grouped-tracks-with-lom) said. Not seen yet: unfolding a folded group through `fold_state`. The simulated Live assumes that a track at the end of the Set is in no group | `placed on track N in group "..."` and `Unfolded group` |
| Whether the whole chain works with the real server | Yes, on Windows: device 0.1.1 with la2l-server 0.5.0, for pairing, Add app, Import, Unpair and a server restart; device 0.2.0 with la2l-server 0.6.0 for the app list, Import at 1.1.1 and an app that unpaired itself; device 0.2.2 for Pair app coming back by itself after Unpair this browser | `Inbox:`, `Paired with` and `Apps of this computer` |

## Next steps

1. Test on a Mac: all steps of [test-card-en.md](test-card-en.md). Fix what the log shows. Nothing has been tested on a Mac yet, neither the device on its own nor with the server. On Windows, 0.2.2 passed steps 1, 7 and 8 up to its part 4 on 2026-10-17; parts 5 and 6 of step 8 (a folded group, the Main track) have not run yet.
2. Fix `parseWarpMode` in `src/node/manifest.js` with the next device version. It looks a name up with `key in WARP_MODES`, so `"warp_mode": "constructor"` (or another name every JavaScript object has) passes without the warning "warp_mode ... unknown" and gives Live a warp mode that is not a number. Use an own-property check, `Object.prototype.hasOwnProperty.call(WARP_MODES, key)`, also in the port in `sdk/js/src/manifest.ts`. The Java port in `sdk/android` already warns there; its parity test leaves such names out until the device is fixed. Found by the Android SDK on 2026-10-18.
3. Freeze for release: the bundled `la2l-node.js`, `la2l-live.js` and the logos must all be listed in the Max console when freezing.
4. MIDI parts (`midi` in the manifest): a MIDI track with a Simpler per drum sound.
5. A button in Settings that removes one app: `DELETE /apps/{id}` with the device token, in [server-api.md](server-api.md) since la2l-server 0.7.0. Ask Erik before building it.
