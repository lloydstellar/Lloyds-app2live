// la2l-ktx: the calls of la2l as suspend functions, and a builder for the sounds of a package.
//
//   import nl.lloydstellar.la2l.*
//   import nl.lloydstellar.la2l.ktx.*
//
//   val la2l = La2l(context, "Web808")
//   if (!la2l.isPaired) la2l.pair(codeFromUser)
//   val delivery = la2l.send(title = "Treinbeat", bpm = 92.0) {
//       sound("Kick", Wav.fromPcm16(kickSamples, 48000, 2), kind = Kind.LOOP, role = Role.DRUMS)
//       sound("Robot hallo", robotWavFile, kind = Kind.ONESHOT, role = Role.VOCAL)
//   }
//   delivery.awaitImport()
//
// Cancelling the coroutine stops the call, also an upload under way. Every failure is a
// La2lException with a code.
package nl.lloydstellar.la2l.ktx

import java.io.File
import kotlinx.coroutines.future.await
import nl.lloydstellar.la2l.Delivery
import nl.lloydstellar.la2l.DeliveryStatus
import nl.lloydstellar.la2l.Kind
import nl.lloydstellar.la2l.La2l
import nl.lloydstellar.la2l.Me
import nl.lloydstellar.la2l.Role
import nl.lloydstellar.la2l.Sound
import nl.lloydstellar.la2l.SoundPackage

/** Pairs this app with the computer that shows the code in LA2L. Returns the name of the computer. */
public suspend fun La2l.pair(code: String): String = pairAsync(code).await()

/** Which computer this app is paired with. NOT_PAIRED means: pair again. */
public suspend fun La2l.me(): Me = meAsync().await()

/** Unpairs this app: the server revokes the token, and it is forgotten here. */
public suspend fun La2l.unpair() {
    unpairAsync().await()
}

/** The sounds of a package, in the block of [send]. */
public class SoundsBuilder internal constructor() {
    internal val sounds: MutableList<Sound> = mutableListOf()

    /** A sound from a WAV file in memory, such as Wav.fromPcm16 makes. */
    public fun sound(
        name: String,
        wav: ByteArray,
        kind: Kind,
        role: Role? = null,
        bpm: Double? = null,
        lengthBeats: Double? = null,
        color: String? = null,
        gainDb: Double? = null,
        warpMode: String? = null,
        id: String? = null,
    ): Sound = add(Sound.of(name, wav, kind), role, bpm, lengthBeats, color, gainDb, warpMode, id)

    /** A sound from a WAV file on disk. */
    public fun sound(
        name: String,
        wav: File,
        kind: Kind,
        role: Role? = null,
        bpm: Double? = null,
        lengthBeats: Double? = null,
        color: String? = null,
        gainDb: Double? = null,
        warpMode: String? = null,
        id: String? = null,
    ): Sound = add(Sound.of(name, wav, kind), role, bpm, lengthBeats, color, gainDb, warpMode, id)

    private fun add(s: Sound, role: Role?, bpm: Double?, lengthBeats: Double?, color: String?, gainDb: Double?, warpMode: String?, id: String?): Sound {
        role?.let { s.role(it) }
        bpm?.let { s.bpm(it) }
        lengthBeats?.let { s.lengthBeats(it) }
        color?.let { s.color(it) }
        gainDb?.let { s.gainDb(it) }
        warpMode?.let { s.warpMode(it) }
        id?.let { s.id(it) }
        sounds.add(s)
        return s
    }
}

/**
 * Sends sounds to LA2L: checked first with LA2L's own texts, then uploaded and committed.
 * [onProgress] gets the share of all bytes uploaded, from 0 to 1, on the main thread.
 */
public suspend fun La2l.send(
    title: String,
    bpm: Double? = null,
    onProgress: ((share: Double) -> Unit)? = null,
    sounds: SoundsBuilder.() -> Unit,
): Delivery {
    val pkg = SoundPackage(title)
    if (bpm != null) pkg.bpm(bpm)
    SoundsBuilder().apply(sounds).sounds.forEach { pkg.add(it) }
    if (onProgress != null) pkg.onProgress { share, _, _ -> onProgress(share) }
    return sendAsync(pkg).await()
}

/** Where the package is now. */
public suspend fun Delivery.status(): DeliveryStatus = statusAsync().await()

/** Waits until the user clicks Import in Live: returns when the sounds are in Live. */
public suspend fun Delivery.awaitImport(): DeliveryStatus = importedAsync().await()

/** Takes the package back, until it is in Live. */
public suspend fun Delivery.cancel() {
    cancelAsync().await()
}
