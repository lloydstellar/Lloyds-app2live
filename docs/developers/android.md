# Android

An Android app sends with the Android SDK, or with five HTTPS calls of its own (below, in Kotlin), or shares its WAV files with LA2L Sender without any network code: see [Sharing](sharing.md).

The Android SDK is `nl.lloydstellar:la2l` for Java, without dependencies, and `nl.lloydstellar:la2l-ktx` for Kotlin, for Android 7.0 (API 24) and newer. They are in LA2L's own Maven repository:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://lloydstellar.nl/la2l/maven/")
    }
}

// app/build.gradle.kts
dependencies {
    implementation("nl.lloydstellar:la2l-ktx:0.1.0") // or nl.lloydstellar:la2l:0.1.0 from Java
}
```

Every file in it is signed with the key at https://lloydstellar.nl/la2l/maven/signing-key.asc. Sending, in Kotlin:

```kotlin
import nl.lloydstellar.la2l.*
import nl.lloydstellar.la2l.ktx.* // pair, send, awaitImport as suspend functions

val la2l = La2l(context, "Web808") // Live shows "Paired with Web808"
if (!la2l.isPaired) la2l.pair(codeFromUser) // "K7P 42Q", from LA2L in Live

val delivery = la2l.send(title = "Treinbeat", bpm = 92.0) {
    sound("Kick", Wav.fromPcm16(kickSamples, 48000, 2), kind = Kind.LOOP, role = Role.DRUMS)
    sound("Robot hallo", robotWavFile, kind = Kind.ONESHOT, role = Role.VOCAL)
}
delivery.awaitImport() // the user clicked Import in Live
```

From Java, every call has a variant that reports to a `Callback` on the main thread, and one that returns a `CompletableFuture`:

```java
La2l la2l = new La2l(context, "Web808");
la2l.send(new SoundPackage("Treinbeat").bpm(92).add(Sound.loop("Kick", kickWav).role(Role.DRUMS)), new Callback<Delivery>() {
    @Override public void onSuccess(Delivery delivery) { status.setText("Waiting for Import in Live"); }
    @Override public void onError(La2lException error) { status.setText(error.getMessage()); }
});
```

- **Pairing**: a field for the code with this line above it: "In Live, click Pair app in LA2L and type the code it shows." The token stays in a private file that Android does not back up; never log it. Ask for a code again only after the code `NOT_PAIRED`.
- **Sounds**: WAV only. `Wav.fromPcm16` and `Wav.fromFloat` make one from interleaved samples, in memory or on disk; `WavCheck.check(file)` says whether LA2L can use a file. Make a loop exactly a whole number of beats long, `sampleRate * 60 / bpm * beats` frames, and give it its BPM.
- **Errors**: every failure is a `La2lException` with a `code` and a message to show as it is. `RATE_LIMITED` has `getRetryAfter()`; `IMPORT_FAILED` means the package stays and the next Import tries again.
- **Large uploads**: send from a WorkManager job, so the upload goes on when the user leaves the app. The README of `sdk/android` has the recipe.
- **Examples**: `examples/android-recorder` records a loop in time after a count-in and sends it; `examples/android-java` does the same with a tone from Java, and shares it with LA2L Sender.

## Without the SDK

For an app that wants no dependency: the same five HTTPS calls, in Kotlin with nothing but the Android platform: `HttpURLConnection`, `org.json` and `MessageDigest`. Run them off the main thread.

### 1. A WAV file

From 16-bit PCM, as `AudioRecord` gives it or as your audio engine renders it:

```kotlin
fun wav16(pcm: ShortArray, sampleRate: Int, channels: Int): ByteArray {
    val data = pcm.size * 2
    val b = java.nio.ByteBuffer.allocate(44 + data).order(java.nio.ByteOrder.LITTLE_ENDIAN)
    b.put("RIFF".toByteArray()).putInt(36 + data).put("WAVE".toByteArray())
    b.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(channels.toShort())
    b.putInt(sampleRate).putInt(sampleRate * channels * 2).putShort((channels * 2).toShort()).putShort(16)
    b.put("data".toByteArray()).putInt(data)
    pcm.forEach { b.putShort(it) }
    return b.array()
}

fun sha256Hex(bytes: ByteArray): String =
    java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
```

A loop must be a whole number of beats long: `sampleRate * 60 / bpm * beats` frames. An m4a or mp3 must be decoded first (`MediaCodec`): LA2L takes WAV only.

### 2. The calls

```kotlin
const val BASE = "https://lloydstellar.nl/la2l/api"

class Answer(val status: Int, val json: org.json.JSONObject, val retryAfter: Int?) {
    fun error(fallback: String) = java.io.IOException(json.optString("error").ifEmpty { fallback })
}

fun call(method: String, path: String, token: String?, body: ByteArray?, type: String = "application/json"): Answer {
    val c = java.net.URL(BASE + path).openConnection() as java.net.HttpURLConnection
    c.connectTimeout = 15_000
    c.readTimeout = 60_000
    c.requestMethod = method
    c.setRequestProperty("X-LA2L-Client", "my-app/1.0 (My app)")
    if (token != null) c.setRequestProperty("Authorization", "Bearer $token")
    try {
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", type)
            c.setFixedLengthStreamingMode(body.size)
            c.outputStream.use { it.write(body) }
        }
        val status = c.responseCode
        val text = (if (status < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        // An answer that is not JSON, such as an error page of a proxy, counts as an empty one.
        val json = try { org.json.JSONObject(text) } catch (e: org.json.JSONException) { org.json.JSONObject() }
        return Answer(status, json, c.getHeaderField("Retry-After")?.toIntOrNull())
    } finally {
        c.disconnect()
    }
}

fun pair(code: String, installId: String): String {
    val body = org.json.JSONObject().put("code", code).put("app_name", "My app").put("app_id", installId)
    val a = call("POST", "/pair/claim", null, body.toString().toByteArray())
    if (a.status != 200) throw a.error("Pairing failed.")
    return a.json.getString("app_token") // keep it in SharedPreferences, Context.MODE_PRIVATE
}

fun send(token: String, title: String, bpm: Double, name: String, wav: ByteArray): String {
    val item = org.json.JSONObject().put("file", "sound.wav").put("name", name).put("kind", "loop")
        .put("role", "drums").put("bytes", wav.size).put("sha256", sha256Hex(wav))
    val manifest = org.json.JSONObject().put("schema", "app2live/1").put("title", title)
        .put("source", org.json.JSONObject().put("app", "My app").put("platform", "android"))
        .put("tempo", org.json.JSONObject().put("bpm", bpm))
        .put("items", org.json.JSONArray().put(item))
    val created = call("POST", "/packages", token, manifest.toString().toByteArray())
    if (created.status != 201) throw created.error("Sending failed.")
    val id = created.json.getString("package_id")
    val put = call("PUT", created.json.getJSONObject("upload").getString("sound.wav"), token, wav, "audio/wav")
    if (put.status != 200) throw put.error("The upload failed.")
    val commit = call("POST", "/packages/$id/commit", token, "{}".toByteArray())
    if (commit.status != 200) throw commit.error("Sending failed.")
    return id // then GET /packages/$id/status every few seconds until "imported"
}
```

- **401** on any call: the user unpaired your app in Live. Forget the token and show the code field again.
- **429**: wait `retryAfter` seconds, from the `Retry-After` header. **5xx** or no connection: try again later.
- A large file does not fit in memory: stream it from disk with `setFixedLengthStreamingMode(file.length())` and copy a `FileInputStream` to `outputStream`.
- **422** names the sound and the problem, in plain English: show it.
- The field for the code: "In Live, click Pair app in LA2L and type the code it shows."
- Never log the token, and never put it in a URL.

### 3. Following it

`GET /packages/{id}/status` says `waiting` until the user clicks Import in Live, then `imported`, `partial` (with the result per sound), `failed` or `expired`. While your app is open, ask every few seconds and show "Waiting for Import in Live".

A large upload that must go on when the user leaves the app belongs in a WorkManager job.

Every call and field: [The REST API](rest-api.md) and [The package description](manifest.md).
