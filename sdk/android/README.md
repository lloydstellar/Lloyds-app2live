# LA2L for Android

Send sounds from an Android app to Ableton Live with [LA2L](https://lloydstellar.nl/la2l/) (Lloyd's App2Live). The user pairs your app once with the code LA2L shows in Live. After that, every send becomes new audio tracks in Live when they click Import: named, coloured, and warped to your tempo.

- `nl.lloydstellar:la2l`: the library, in Java, without dependencies. Android 7.0 (API 24) and newer.
- `nl.lloydstellar:la2l-ktx`: Kotlin on top, with suspend functions and a builder. It brings `kotlinx-coroutines-core`.

## Install

**Not published yet.** Version 0.1.0 is built and tested, and will be in LA2L's own Maven repository; until then `https://lloydstellar.nl/la2l/maven/` answers 404, and an app sends with the REST API (https://lloydstellar.nl/la2l/developers/android, "Without the SDK"). Once it is there:

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

la2l adds the `INTERNET` permission to your app. The token stays in a private file in the app's no-backup folder, so Auto Backup does not copy it to another phone.

## Kotlin

```kotlin
import nl.lloydstellar.la2l.*
import nl.lloydstellar.la2l.ktx.* // pair, send, awaitImport as suspend functions

val la2l = La2l(context, "Web808") // Live shows "Paired with Web808"
if (!la2l.isPaired) la2l.pair(codeFromUser) // "K7P 42Q", from LA2L in Live

val delivery = la2l.send(title = "Treinbeat", bpm = 92.0) {
    sound("Kick", Wav.fromPcm16(kickSamples, 48000, 2), kind = Kind.LOOP, role = Role.DRUMS)
    sound("Robot hallo", robotWavFile, kind = Kind.ONESHOT, role = Role.VOCAL)
}
delivery.awaitImport() // when the user clicks Import in Live
```

The functions suspend; cancelling the coroutine stops the call. Every failure is a `La2lException` with a `code`.

## Java

```java
La2l la2l = new La2l(context, "Web808");
SoundPackage pkg = new SoundPackage("Treinbeat").bpm(92)
    .add(Sound.loop("Kick", Wav.fromPcm16(kickSamples, 48000, 2)).role(Role.DRUMS))
    .add(Sound.oneShot("Robot hallo", robotWavFile).role(Role.VOCAL));
la2l.send(pkg, new Callback<Delivery>() {
    @Override public void onSuccess(Delivery delivery) { status.setText("Waiting for Import in Live"); }
    @Override public void onError(La2lException error) { status.setText(error.getMessage()); }
});
```

Every call has a variant with a `Callback`, which reports on the main thread, and one that returns a `CompletableFuture`: `pairAsync`, `meAsync`, `unpairAsync`, `sendAsync`, and on a `Delivery` `statusAsync`, `importedAsync`, `cancelAsync`. The Callback variants return the future too: cancel it in `onDestroy`, and the call stops and reports nothing.

## Pairing

Show a field for the code once, with this line above it: "In Live, click Pair app in LA2L and type the code it shows." Case, spaces and dashes do not matter. la2l keeps the token in your app's private `SharedPreferences` and sends it only in the `Authorization` header; never log it. Ask for a code again only after the code `NOT_PAIRED`: then the user unpaired your app in Live.

## Sounds

LA2L takes WAV only: PCM 16 or 24 bit (8 and 32 work too) or float 32 or 64 bit, mono or stereo, 8 to 192 kHz.

- `Wav.fromPcm16(samples, sampleRate, channels)` and `Wav.fromFloat(...)` make a WAV file from interleaved samples, in memory or, with a `File` as fourth argument, on disk.
- `WavCheck.check(file)` says before sending whether LA2L can use a file, in LA2L's own words.
- Every sound needs a kind. A loop (`Sound.loop`, `Kind.LOOP`) is warped to the tempo and loops: make it exactly a whole number of beats long, `sampleRate * 60 / bpm * beats` frames, and give the package or the sound its BPM. A one-shot (`Sound.oneShot`) plays as it is.
- The role picks the warp mode of a loop: drums Beats, bass Tones, melodic and vocal Complex Pro, texture Texture, fx Complex.
- Names have at most 40 characters. A package has at most 32 sounds and 200 MB.

## Errors

| `La2lException.Code` | What to do |
|---|---|
| `NOT_PAIRED` | Show the field for the code again. |
| `BAD_CODE` | Show the message, and ask for the code again. |
| `BAD_WAV`, `BAD_PACKAGE` | Show the message: it names the sound and what is wrong. |
| `RATE_LIMITED` | Wait `getRetryAfter()` seconds. |
| `SERVER_FULL` | Show the message, often "Click Import in Live first". |
| `NETWORK`, `SERVER` | Try again later. |
| `IMPORT_FAILED` | Show the message. The package stays: the next Import in Live tries again. |
| `EXPIRED` | Show the message; send the sounds again. |
| `ABORTED` | Your app stopped it. |

## Sharing with LA2L Sender, without network code

`La2lShare.intent` builds a share for LA2L Sender, the installed web app of LA2L: the WAV files, readable through la2l's own provider, and their description in the text, so LA2L Sender knows loop or one-shot, BPM and role.

```kotlin
// It copies the files: off the main thread, or with the Callback variant, which answers on it.
val share = withContext(Dispatchers.IO) {
    La2lShare.intent(context, SoundPackage("Treinbeat").bpm(92.0).add(Sound.loop("Kick", kickWav).role(Role.DRUMS)))
}
context.startActivity(Intent.createChooser(share, "Send to Live"))
```

No pairing in your app: the user installed LA2L Sender from Chrome and paired it with Live. See https://lloydstellar.nl/la2l/developers/sharing.

## Large uploads in the background

A send of many megabytes over a phone network can take minutes. To let it go on when the user leaves the app, send from a WorkManager job (`androidx.work:work-runtime-ktx`, not a dependency of la2l). Android stops a job after 10 minutes unless it runs in the foreground: for a large upload, call `setForeground` with a notification first.

```kotlin
class SendToLive(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val wav = File(inputData.getString("wav")!!)
        return try {
            La2l(applicationContext, "My app").send(title = inputData.getString("title") ?: "Untitled", bpm = inputData.getDouble("bpm", 120.0)) {
                sound(wav.nameWithoutExtension, wav, kind = Kind.LOOP)
            }
            Result.success()
        } catch (e: La2lException) {
            if (e.code == La2lException.Code.NETWORK || e.code == La2lException.Code.SERVER) Result.retry() else Result.failure()
        }
    }
}

WorkManager.getInstance(context).enqueue(
    OneTimeWorkRequestBuilder<SendToLive>()
        .setConstraints(Constraints(requiredNetworkType = NetworkType.CONNECTED))
        .setInputData(workDataOf("wav" to wav.path, "title" to "Treinbeat", "bpm" to 92.0))
        .build()
)
```

## Testing without Ableton

The test receiver stands in for LA2L in Live. Open https://lloydstellar.nl/la2l/receiver on a computer, pair your app with the code it shows, and send: the page says per sound what Live would do, and your app needs no change.

For tests that run on the computer (JVM tests, with `testImplementation("org.json:json:20260814")`, since Android's own org.json is not there), `npx la2l test-receiver --local` starts an LA2L server in memory: point the client at the address it prints, with `new La2l.Options("My app").server(address).storage(Storage.memory())`. A phone or an emulator reaches it after `adb reverse tcp:<port> tcp:<port>`, at `http://127.0.0.1:<port>/api`, if the app's network security config allows plain http to 127.0.0.1 (in a debug build only). la2l allows plain http for `localhost` and `127.0.0.1` only.

## Building

`sdk/android` is a Gradle build with both libraries and the two example apps in `examples/`. It is built in GitHub Actions (`.github/workflows/test.yml`, job `android`), never on the VPS: Gradle 8.14, the Android Gradle Plugin 8.13, Kotlin 2.3, JDK 17. The tests run against the real server of this repository and the test receiver of `sdk/js`.

Apache License 2.0. Ableton and Live are trademarks of Ableton AG; LA2L is not made by Ableton.
