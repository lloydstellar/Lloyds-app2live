package nl.lloydstellar.la2l;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import org.junit.Test;

// The WAV writer: what it makes, LA2L takes, with the samples where they belong.
public class WavTest {
    @Test
    public void pcm16StereoIsAFileLiveCanUse() throws Exception {
        short[] samples = new short[96000 * 2]; // one bar at 120 BPM, stereo
        for (int i = 0; i < samples.length; i++) samples[i] = (short) (i % 2 == 0 ? 1000 : -1000);
        byte[] wav = Wav.fromPcm16(samples, 48000, 2);
        WavInfo info = WavCheck.check(wav);
        assertEquals("pcm", info.format);
        assertEquals(2, info.channels);
        assertEquals(48000, info.sampleRate);
        assertEquals(16, info.bitsPerSample);
        assertEquals(96000, info.frames);
        assertEquals(2.0, info.duration, 0);
        assertEquals(44, info.dataOffset);
        ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals(wav.length - 8, b.getInt(4));
        assertEquals(1000, b.getShort(44));
        assertEquals(-1000, b.getShort(46));
    }

    @Test
    public void floatMonoHasItsFactChunkAndExactSamples() throws Exception {
        float[] samples = {0f, 0.5f, -0.25f, 1f};
        File file = Wav.fromFloat(samples, 44100, 1, File.createTempFile("la2l", ".wav"));
        try {
            WavInfo info = WavCheck.check(file);
            assertEquals("float", info.format);
            assertEquals(32, info.bitsPerSample);
            assertEquals(4, info.frames);
            assertEquals(58, info.dataOffset);
            byte[] wav = Files.readAllBytes(file.toPath());
            assertArrayEquals(Wav.fromFloat(samples, 44100, 1), wav);
            ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
            assertEquals(0.5f, b.getFloat(58 + 4), 0);
            assertEquals(-0.25f, b.getFloat(58 + 8), 0);
        } finally {
            file.delete();
        }
    }

    @Test
    public void whatLiveCannotUseIsRefusedAtOnce() {
        assertThrows(IllegalArgumentException.class, () -> Wav.fromPcm16(new short[6], 48000, 3));
        assertThrows(IllegalArgumentException.class, () -> Wav.fromPcm16(new short[3], 48000, 2));
        assertThrows(IllegalArgumentException.class, () -> Wav.fromPcm16(new short[0], 48000, 1));
        assertThrows(IllegalArgumentException.class, () -> Wav.fromFloat(new float[2], 4000, 1));
    }

    @Test
    public void theVersionIsTheVersionOfTheBuild() {
        assertEquals(System.getProperty("la2l.version"), La2l.VERSION);
    }
}
