package nl.lloydstellar.la2l.ktx

import java.io.File
import java.net.ServerSocket
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import nl.lloydstellar.la2l.Kind
import nl.lloydstellar.la2l.La2l
import nl.lloydstellar.la2l.La2lException
import nl.lloydstellar.la2l.Role
import nl.lloydstellar.la2l.Storage
import nl.lloydstellar.la2l.Wav
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

// The suspend functions and the builder against the real server of this repository, with the
// test receiver of the web SDK as LA2L in Live (as ClientTest of la2l does it for Java).
class La2lKtxTest {
    private class Local : AutoCloseable {
        val folder: File = Files.createTempDirectory("la2l-ktx-").toFile()
        val port = ServerSocket(0).use { it.localPort }
        val api = "http://127.0.0.1:$port/api"
        val serverLines = mutableListOf<String>()
        val receiverLines = mutableListOf<String>()
        private val repo = File(System.getProperty("la2l.repository")!!)
        private val server: Process
        private val receiver: Process
        val code: String

        init {
            server = ProcessBuilder("node", "--disable-warning=ExperimentalWarning", File(repo, "server/src/main.js").path).apply {
                environment().putAll(mapOf("PORT" to "$port", "HOST" to "127.0.0.1", "DATA_DIR" to File(folder, "data").path, "RATE_LIMITS" to "off", "TRUST_PROXY" to "0"))
                redirectErrorStream(true)
            }.start()
            read(server, serverLines)
            waitFor(serverLines, Regex("listening on"))
            receiver = ProcessBuilder("node", File(repo, "sdk/js/dist/cli/main.js").path, "test-receiver", "--server", api).apply {
                environment()["LA2L_CONFIG_DIR"] = File(folder, "config").path
                redirectErrorStream(true)
            }.start()
            read(receiver, receiverLines)
            code = Regex("pair with code ([A-Z0-9]{3} [A-Z0-9]{3})").find(waitFor(receiverLines, Regex("pair with code")))!!.groupValues[1]
        }

        private fun read(p: Process, into: MutableList<String>) {
            Thread {
                p.inputStream.bufferedReader().forEachLine { line ->
                    synchronized(into) {
                        into.add(line)
                        (into as Object).notifyAll()
                    }
                }
            }.apply { isDaemon = true }.start()
        }

        fun waitFor(lines: MutableList<String>, pattern: Regex, ms: Long = 30000): String {
            val until = System.currentTimeMillis() + ms
            synchronized(lines) {
                while (true) {
                    lines.firstOrNull { pattern.containsMatchIn(it) }?.let { return it }
                    val left = until - System.currentTimeMillis()
                    if (left <= 0) throw IllegalStateException("No line like $pattern in $lines")
                    (lines as Object).wait(left)
                }
            }
        }

        override fun close() {
            receiver.destroy()
            server.destroy()
            folder.deleteRecursively()
        }
    }

    // One bar of 4/4 at 92 BPM, stereo.
    private fun bar(bpm: Double): ByteArray {
        val frames = Math.round(48000 * 240 / bpm).toInt()
        val samples = ShortArray(frames * 2) { i -> if ((i / 2) % (frames / 4) < 2000) (Math.sin(i / 16.0) * 20000).toInt().toShort() else 0 }
        return Wav.fromPcm16(samples, 48000, 2)
    }

    @Test
    fun pairsSendsWithTheBuilderAndWaitsForTheImport() = runBlocking {
        Local().use { local ->
            val la2l = La2l(La2l.Options("Kotlin test").server(local.api).storage(Storage.memory()))
            try {
                la2l.pair("AAAAAA")
                fail("a code the server does not know")
            } catch (e: La2lException) {
                assertEquals(La2lException.Code.BAD_CODE, e.code)
            }
            assertEquals("Test receiver", la2l.pair(local.code))
            assertTrue(la2l.isPaired)
            assertEquals("Kotlin test", la2l.me().appName)
            val shares = mutableListOf<Double>()
            val delivery = la2l.send(title = "Treinbeat", bpm = 92.0, onProgress = { synchronized(shares) { shares.add(it) } }) {
                sound("Kick", bar(92.0), kind = Kind.LOOP, role = Role.DRUMS, lengthBeats = 4.0)
                sound("Robot hallo", Wav.fromFloat(FloatArray(4800), 48000, 1), kind = Kind.ONESHOT, role = Role.VOCAL)
            }
            val status = delivery.awaitImport()
            assertEquals("imported", status.status)
            assertEquals(listOf("Kick", "Robot hallo"), status.sounds.map { it.name })
            local.waitFor(local.receiverLines, Regex("""Kick \(Kotlin test\): loop, warped in Beats mode at 92 BPM, 4 beats"""))
            local.waitFor(local.receiverLines, Regex("""Robot hallo \(Kotlin test\): one-shot, plays as it is"""))
            assertEquals(1.0, synchronized(shares) { shares.last() }, 0.0)
            assertEquals("imported", delivery.status().status)
            la2l.unpair()
            assertFalse(la2l.isPaired)
        }
    }
}
