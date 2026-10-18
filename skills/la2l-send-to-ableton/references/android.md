# Android

An Android app sends to LA2L with five HTTPS calls, the same ones every SDK makes. An Android SDK (`nl.lloydstellar:la2l`) is being built; until it is released, this page shows the calls in Kotlin, with nothing but the Android platform: `HttpURLConnection`, `org.json` and `MessageDigest`. Run them off the main thread.

## 1. A WAV file

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

## 2. The calls

```kotlin
const val BASE = "https://lloydstellar.nl/la2l/api"

fun call(method: String, path: String, token: String?, body: ByteArray?, type: String = "application/json"): Pair<Int, String> {
    val c = java.net.URL(BASE + path).openConnection() as java.net.HttpURLConnection
    c.requestMethod = method
    c.setRequestProperty("X-LA2L-Client", "my-app/1.0 (My app)")
    if (token != null) c.setRequestProperty("Authorization", "Bearer $token")
    if (body != null) {
        c.doOutput = true
        c.setRequestProperty("Content-Type", type)
        c.setFixedLengthStreamingMode(body.size)
        c.outputStream.use { it.write(body) }
    }
    val status = c.responseCode
    val text = (if (status < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
    return status to text
}

fun pair(code: String, installId: String): String {
    val body = org.json.JSONObject().put("code", code).put("app_name", "My app").put("app_id", installId)
    val (status, text) = call("POST", "/pair/claim", null, body.toString().toByteArray())
    val json = org.json.JSONObject(text)
    if (status != 200) throw java.io.IOException(json.optString("error", "Pairing failed."))
    return json.getString("app_token") // keep it in SharedPreferences, Context.MODE_PRIVATE
}

fun send(token: String, title: String, bpm: Double, name: String, wav: ByteArray): String {
    val item = org.json.JSONObject().put("file", "sound.wav").put("name", name).put("kind", "loop")
        .put("role", "drums").put("bytes", wav.size).put("sha256", sha256Hex(wav))
    val manifest = org.json.JSONObject().put("schema", "app2live/1").put("title", title)
        .put("source", org.json.JSONObject().put("app", "My app").put("platform", "android"))
        .put("tempo", org.json.JSONObject().put("bpm", bpm))
        .put("items", org.json.JSONArray().put(item))
    val (status, text) = call("POST", "/packages", token, manifest.toString().toByteArray())
    val created = org.json.JSONObject(text)
    if (status != 201) throw java.io.IOException(created.optString("error", "Sending failed."))
    val id = created.getString("package_id")
    val put = call("PUT", created.getJSONObject("upload").getString("sound.wav"), token, wav, "audio/wav")
    if (put.first != 200) throw java.io.IOException(org.json.JSONObject(put.second).optString("error", "Upload failed."))
    val commit = call("POST", "/packages/$id/commit", token, "{}".toByteArray())
    if (commit.first != 200) throw java.io.IOException(org.json.JSONObject(commit.second).optString("error", "Sending failed."))
    return id // then GET /packages/$id/status every few seconds until "imported"
}
```

- **401** on any call: the user unpaired your app in Live. Forget the token and show the code field again.
- **429**: wait the seconds in `Retry-After`. **5xx** or no connection: try again later.
- **422** names the sound and the problem, in plain English: show it.
- The field for the code: "In Live, click Pair app in LA2L and type the code it shows."
- Never log the token, and never put it in a URL.

## 3. Following it

`GET /packages/{id}/status` says `waiting` until the user clicks Import in Live, then `imported`, `partial` (with the result per sound), `failed` or `expired`. While your app is open, ask every few seconds and show "Waiting for Import in Live".

A large upload that must go on when the user leaves the app belongs in a WorkManager job.

Every call and field: [api.md](api.md) and [manifest.md](manifest.md).
