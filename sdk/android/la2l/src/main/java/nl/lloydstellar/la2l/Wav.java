package nl.lloydstellar.la2l;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * WAV files from samples, as AudioRecord gives them or an audio engine renders them, in memory or
 * into a file. Samples are interleaved: left, right, left, right for stereo.
 *
 * <pre>
 * byte[] loop = Wav.fromPcm16(samples, 48000, 2);
 * File big = Wav.fromFloat(samples, 48000, 2, new File(getCacheDir(), "loop.wav"));
 * </pre>
 */
public final class Wav {
    private Wav() {}

    /** A 16-bit PCM WAV file in memory. */
    public static byte[] fromPcm16(short[] samples, int sampleRate, int channels) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(44 + samples.length * 2);
        try {
            writePcm16(samples, sampleRate, channels, out);
        } catch (IOException e) {
            throw new IllegalStateException(e); // a ByteArrayOutputStream does not fail
        }
        return out.toByteArray();
    }

    /** A 16-bit PCM WAV file on disk; returns the file. */
    public static File fromPcm16(short[] samples, int sampleRate, int channels, File file) throws IOException {
        try (OutputStream out = new BufferedOutputStream(new FileOutputStream(file), 65536)) {
            writePcm16(samples, sampleRate, channels, out);
        }
        return file;
    }

    /** A 32-bit float WAV file in memory, from samples from -1 to 1. */
    public static byte[] fromFloat(float[] samples, int sampleRate, int channels) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(58 + samples.length * 4);
        try {
            writeFloat(samples, sampleRate, channels, out);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        return out.toByteArray();
    }

    /** A 32-bit float WAV file on disk; returns the file. */
    public static File fromFloat(float[] samples, int sampleRate, int channels, File file) throws IOException {
        try (OutputStream out = new BufferedOutputStream(new FileOutputStream(file), 65536)) {
            writeFloat(samples, sampleRate, channels, out);
        }
        return file;
    }

    private static long frames(int length, int sampleRate, int channels, int bytes) {
        if (channels < 1 || channels > 2) throw new IllegalArgumentException("Give one channel (mono) or two (stereo): Live places mono and stereo files only.");
        if (sampleRate < 8000 || sampleRate > 192000) throw new IllegalArgumentException("The sample rate must be a whole number from 8000 to 192000.");
        if (length == 0) throw new IllegalArgumentException("There are no samples.");
        if (length % channels != 0) throw new IllegalArgumentException("Stereo samples come in pairs: left, right.");
        long frames = length / channels;
        if (frames * channels * bytes > 0xFFFFFFFFL - 58) throw new IllegalArgumentException("Too many samples for one WAV file.");
        return frames;
    }

    private static void writePcm16(short[] samples, int sampleRate, int channels, OutputStream out) throws IOException {
        long frames = frames(samples.length, sampleRate, channels, 2);
        int block = channels * 2;
        long dataBytes = frames * block;
        byte[] head = new byte[44];
        int at = text(head, 0, "RIFF");
        at = u32(head, at, 36 + dataBytes);
        at = text(head, at, "WAVE");
        at = text(head, at, "fmt ");
        at = u32(head, at, 16);
        at = u16(head, at, 1);
        at = u16(head, at, channels);
        at = u32(head, at, sampleRate);
        at = u32(head, at, (long) sampleRate * block);
        at = u16(head, at, block);
        at = u16(head, at, 16);
        at = text(head, at, "data");
        u32(head, at, dataBytes);
        out.write(head);
        byte[] chunk = new byte[8192];
        int n = 0;
        for (short s : samples) {
            chunk[n++] = (byte) s;
            chunk[n++] = (byte) (s >> 8);
            if (n == chunk.length) {
                out.write(chunk, 0, n);
                n = 0;
            }
        }
        out.write(chunk, 0, n);
    }

    // Float WAV as the web SDK writes it: an 18-byte fmt chunk and a fact chunk with the frames.
    private static void writeFloat(float[] samples, int sampleRate, int channels, OutputStream out) throws IOException {
        long frames = frames(samples.length, sampleRate, channels, 4);
        int block = channels * 4;
        long dataBytes = frames * block;
        byte[] head = new byte[58];
        int at = text(head, 0, "RIFF");
        at = u32(head, at, 50 + dataBytes);
        at = text(head, at, "WAVE");
        at = text(head, at, "fmt ");
        at = u32(head, at, 18);
        at = u16(head, at, 3);
        at = u16(head, at, channels);
        at = u32(head, at, sampleRate);
        at = u32(head, at, (long) sampleRate * block);
        at = u16(head, at, block);
        at = u16(head, at, 32);
        at = u16(head, at, 0);
        at = text(head, at, "fact");
        at = u32(head, at, 4);
        at = u32(head, at, frames);
        at = text(head, at, "data");
        u32(head, at, dataBytes);
        out.write(head);
        byte[] chunk = new byte[8192];
        int n = 0;
        for (float f : samples) {
            int bits = Float.floatToIntBits(Float.isNaN(f) ? 0f : f);
            chunk[n++] = (byte) bits;
            chunk[n++] = (byte) (bits >> 8);
            chunk[n++] = (byte) (bits >> 16);
            chunk[n++] = (byte) (bits >> 24);
            if (n == chunk.length) {
                out.write(chunk, 0, n);
                n = 0;
            }
        }
        out.write(chunk, 0, n);
    }

    private static int text(byte[] b, int at, String s) {
        for (int i = 0; i < s.length(); i++) b[at + i] = (byte) s.charAt(i);
        return at + s.length();
    }

    private static int u16(byte[] b, int at, int v) {
        b[at] = (byte) v;
        b[at + 1] = (byte) (v >> 8);
        return at + 2;
    }

    private static int u32(byte[] b, int at, long v) {
        b[at] = (byte) v;
        b[at + 1] = (byte) (v >> 8);
        b[at + 2] = (byte) (v >> 16);
        b[at + 3] = (byte) (v >> 24);
        return at + 4;
    }
}
