// LA2L Recorder: records a loop of a whole number of beats at the tempo you set, after a count-in,
// and sends it to LA2L in Ableton Live, where it plays in time. The example of the Android SDK.
package nl.lloydstellar.la2l.recorder

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nl.lloydstellar.la2l.Kind
import nl.lloydstellar.la2l.La2l
import nl.lloydstellar.la2l.La2lException
import nl.lloydstellar.la2l.Role
import nl.lloydstellar.la2l.Wav
import nl.lloydstellar.la2l.ktx.awaitImport
import nl.lloydstellar.la2l.ktx.pair
import nl.lloydstellar.la2l.ktx.send

class RecorderActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var la2l: La2l
    private lateinit var status: TextView
    private lateinit var codeField: EditText
    private lateinit var pairRow: LinearLayout
    private lateinit var bpmField: EditText
    private lateinit var beatsField: EditText
    private lateinit var recordButton: Button
    private lateinit var sendButton: Button
    private var loop: ByteArray? = null
    private var loopBpm = 120.0
    private var loopBeats = 4

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        la2l = La2l(this, "LA2L Recorder")
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        root.addView(TextView(this).apply { text = "Record a loop in time, then send it to Ableton Live." })

        root.addView(TextView(this).apply { text = "In Live, click Pair app in LA2L and type the code it shows." })
        codeField = EditText(this).apply { hint = "K7P 42Q"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS }
        pairRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(codeField, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(Button(this@RecorderActivity).apply { text = "Pair"; setOnClickListener { pairNow() } })
        }
        root.addView(pairRow)

        bpmField = EditText(this).apply { setText("120"); hint = "BPM"; inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL }
        beatsField = EditText(this).apply { setText("4"); hint = "Beats"; inputType = InputType.TYPE_CLASS_NUMBER }
        root.addView(TextView(this).apply { text = "BPM" })
        root.addView(bpmField)
        root.addView(TextView(this).apply { text = "Length in beats" })
        root.addView(beatsField)
        recordButton = Button(this).apply { text = "Record a loop"; setOnClickListener { record() } }
        sendButton = Button(this).apply { text = "Send to Live"; isEnabled = false; setOnClickListener { sendNow() } }
        root.addView(recordButton)
        root.addView(sendButton)
        status = TextView(this)
        root.addView(status)
        setContentView(root)
        showPairing()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun showPairing() {
        pairRow.visibility = if (la2l.isPaired) View.GONE else View.VISIBLE
        if (la2l.isPaired) status.text = "Paired with ${la2l.deviceName}."
    }

    private fun pairNow() = scope.launch {
        status.text = "Pairing..."
        try {
            val computer = la2l.pair(codeField.text.toString())
            codeField.setText("")
            status.text = "Paired with $computer. In a moment Live says: Paired with LA2L Recorder."
        } catch (e: La2lException) {
            status.text = e.message
        }
        showPairing()
    }

    private fun record() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
            return
        }
        val bpm = bpmField.text.toString().replace(',', '.').toDoubleOrNull()
        val beats = beatsField.text.toString().toIntOrNull()
        if (bpm == null || bpm < 40 || bpm > 300 || beats == null || beats < 1 || beats > 64) {
            status.text = "Set a BPM from 40 to 300 and a length of 1 to 64 beats."
            return
        }
        recordButton.isEnabled = false
        sendButton.isEnabled = false
        scope.launch {
            try {
                loop = recordLoop(bpm, beats)
                loopBpm = bpm
                loopBeats = beats
                status.text = "Recorded $beats beats at ${fmt(bpm)} BPM. Send it to Live, or record again."
                sendButton.isEnabled = true
            } catch (e: Exception) {
                status.text = "Recording did not work: ${e.message}"
            } finally {
                recordButton.isEnabled = true
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) record()
        else status.text = "LA2L Recorder needs the microphone to record a loop."
    }

    // Four clicks of count-in at the tempo, then exactly `beats` beats of mono 16-bit sound at 48
    // kHz: a loop of a whole number of beats, so it stays in time in Live. The microphone runs from
    // the first click, and exactly four beats of frames are dropped, so the downbeat is in.
    private suspend fun recordLoop(bpm: Double, beats: Int): ByteArray = withContext(Dispatchers.IO) {
        val rate = 48000
        val beatFrames = rate * 60.0 / bpm
        val countIn = Math.round(beatFrames * 4).toInt()
        val frames = Math.round(beatFrames * beats).toInt()
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        @Suppress("MissingPermission")
        val recorder = AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, rate))
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            throw IllegalStateException("the microphone could not be opened")
        }
        val clicks = ToneGenerator(AudioManager.STREAM_MUSIC, 80)
        val loop = ShortArray(frames)
        val piece = ShortArray(4096)
        var started = false
        try {
            recorder.startRecording()
            started = true
            var read = 0
            var click = 0
            while (read < countIn + frames) {
                ensureActive()
                // A click on each beat of the count-in, as the recording gets there.
                while (click < 4 && read >= Math.round(beatFrames * click)) {
                    clicks.startTone(if (click == 0) ToneGenerator.TONE_PROP_BEEP2 else ToneGenerator.TONE_PROP_BEEP, 60)
                    val left = 4 - click
                    withContext(Dispatchers.Main) { status.text = "$left" }
                    click++
                }
                val n = recorder.read(piece, 0, minOf(piece.size, countIn + frames - read))
                if (n < 0) throw IllegalStateException("the microphone answered $n")
                for (i in 0 until n) {
                    val at = read + i - countIn
                    if (at >= 0) loop[at] = piece[i]
                }
                if (read < countIn && read + n >= countIn) withContext(Dispatchers.Main) { status.text = "Recording..." }
                read += n
            }
        } finally {
            if (started) recorder.stop()
            recorder.release()
            clicks.release()
        }
        Wav.fromPcm16(loop, rate, 1)
    }

    private fun sendNow() {
        val wav = loop ?: return
        sendButton.isEnabled = false
        scope.launch {
            try {
                val delivery = la2l.send(title = "Recorder ${fmt(loopBpm)} BPM", bpm = loopBpm, onProgress = { share ->
                    status.text = "Sending... ${Math.round(share * 100)}%"
                }) {
                    sound("Loop", wav, kind = Kind.LOOP, role = Role.MELODIC, lengthBeats = loopBeats.toDouble())
                }
                status.text = "Waiting for Import in Live"
                val result = delivery.awaitImport()
                status.text = if (result.status == "imported") "In Live" else "In Live, partly"
            } catch (e: La2lException) {
                status.text = e.message
                if (e.code == La2lException.Code.NOT_PAIRED) showPairing()
            } finally {
                sendButton.isEnabled = true
            }
        }
    }

    private fun fmt(bpm: Double) = if (bpm == Math.rint(bpm)) bpm.toInt().toString() else bpm.toString()
}
