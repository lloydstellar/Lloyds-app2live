# Sharing to LA2L Sender

An Android app can send sounds to Live without any network code: it shares the WAV files with LA2L Sender, the installed web app of LA2L, and puts a description of the sounds in the text of the share. LA2L Sender shows them with loop or one-shot, BPM and role filled in, and the user taps Send.

The user installs LA2L Sender once from Chrome (any phone) or Samsung Internet (Samsung phones), at `https://lloydstellar.nl/la2l/`, opens it once and pairs it with Live. From then on it is in the share menu. Android only: not Firefox, not iOS.

## The share

```kotlin
val manifest = org.json.JSONObject()
    .put("schema", "app2live/1")
    .put("title", "Treinbeat")
    .put("source", org.json.JSONObject().put("app", "Web808")) // the tracks: "Kick (Web808)"
    .put("tempo", org.json.JSONObject().put("bpm", 92))
    .put("items", org.json.JSONArray()
        .put(org.json.JSONObject().put("file", "kick.wav").put("name", "Kick").put("kind", "loop").put("role", "drums").put("length_beats", 16))
        .put(org.json.JSONObject().put("file", "robot.wav").put("name", "Robot hallo").put("kind", "oneshot").put("role", "vocal")))

val uris = arrayListOf(kickWav, robotWav).map {
    androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.files", it)
}
val share = android.content.Intent(android.content.Intent.ACTION_SEND_MULTIPLE).apply {
    type = "audio/wav"
    putParcelableArrayListExtra(android.content.Intent.EXTRA_STREAM, ArrayList(uris))
    putExtra(android.content.Intent.EXTRA_TEXT, manifest.toString())
    putExtra(android.content.Intent.EXTRA_SUBJECT, "Treinbeat")
    addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
}
context.startActivity(android.content.Intent.createChooser(share, "Send to Live"))
```

The files are shared through a `FileProvider`, declared once in `AndroidManifest.xml`:

```xml
<provider
    android:name="androidx.core.content.FileProvider"
    android:authorities="${applicationId}.files"
    android:exported="false"
    android:grantUriPermissions="true">
    <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/shared_sounds" />
</provider>
```

with `res/xml/shared_sounds.xml` naming the folder the WAV files are in, for example `<paths><cache-path name="sounds" path="sounds/" /></paths>`.

## The description in the text

- One JSON object with `"schema": "app2live/1"`, as in [the package description](manifest.md). LA2L Sender reads from the first `{` to the last `}`, so a line of your own around it is fine: "Made with Web808: {...}".
- `items[].file` is the name of a shared file. Leave out `package_id`, `bytes` and `sha256`: LA2L Sender fills them in.
- A shared file without an item gets the defaults, a one-shot, which the user can change before sending.
- The title of the share (`EXTRA_SUBJECT`) becomes the title of the package when the description has none.
- Chrome passes on only the files, the title (`EXTRA_SUBJECT`) and one text (`EXTRA_TEXT`, a single string). Every other extra is dropped, so the description must be in `EXTRA_TEXT`.
- A file whose type, as your provider reports it, is not `audio/*`, `.wav` or a ZIP file is dropped without a word. The name LA2L Sender matches with `items[].file` is the provider's `DISPLAY_NAME`.
- The tracks carry the app name of the description, `source.app`: "Kick (Web808)". Without it, they carry "LA2L Sender".

## What LA2L Sender takes

- WAV files; mp3, m4a and other sound files the phone's browser can play, up to 10 MB each, which become WAV; and a ZIP file of them, up to 256 files. For a file in a ZIP, `items[].file` is its name without its folder. Not ZIP64, and no ZIP with a password.
- More than 32 sounds or 200 MB: LA2L Sender sends several packages, "Treinbeat (1 of 2)" and so on.
- One file: `ACTION_SEND` with one `EXTRA_STREAM` works the same way.

Any app that shares sound files works without a description too. Then the user sets loop or one-shot, BPM and role in LA2L Sender before sending.
