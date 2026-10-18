package nl.lloydstellar.la2l;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;

/**
 * Checks that a file is a WAV file Live can use, as LA2L in Live does it (src/node/wav.js), with
 * the same texts: PCM 8, 16, 24 or 32 bit, or float 32 or 64 bit, mono or stereo, 8 to 192 kHz.
 * Only the header is read, never the sound, so a file of 200 MB costs a few small reads.
 */
public final class WavCheck {
    private WavCheck() {}

    /** A file of a million empty chunks would keep the walk busy; it stops here, as the device does. */
    public static final int MAX_CHUNKS = 1000;

    private static final int PCM = 1;
    private static final int FLOAT = 3;
    private static final int EXTENSIBLE = 0xFFFE;

    /** Bytes with a size; a read past the end gives zeros, as the web SDK reads a Blob. */
    interface Source {
        long size();

        byte[] read(long position, int length) throws IOException;
    }

    /** The header of a WAV file on disk. A file that cannot be read gets a BAD_WAV error too. */
    public static WavInfo check(File file) throws La2lException {
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            final long size = raf.length();
            return check(new Source() {
                public long size() {
                    return size;
                }

                public byte[] read(long position, int length) throws IOException {
                    byte[] out = new byte[length];
                    if (position >= size) return out;
                    raf.seek(position);
                    int done = 0;
                    while (done < length) {
                        int n = raf.read(out, done, length - done);
                        if (n < 0) break;
                        done += n;
                    }
                    return out;
                }
            });
        } catch (IOException e) {
            throw bad("The file cannot be read.");
        }
    }

    /** The header of a WAV file in memory. */
    public static WavInfo check(final byte[] bytes) throws La2lException {
        try {
            return check(new Source() {
                public long size() {
                    return bytes.length;
                }

                public byte[] read(long position, int length) {
                    byte[] out = new byte[length];
                    if (position < bytes.length) System.arraycopy(bytes, (int) position, out, 0, (int) Math.min(length, bytes.length - position));
                    return out;
                }
            });
        } catch (IOException e) {
            throw bad("The file cannot be read.");
        }
    }

    static La2lException bad(String message) {
        return new La2lException(La2lException.Code.BAD_WAV, message);
    }

    private static int u16(byte[] b, int at) {
        return (b[at] & 0xFF) | ((b[at + 1] & 0xFF) << 8);
    }

    private static long u32(byte[] b, int at) {
        return (b[at] & 0xFFL) | ((b[at + 1] & 0xFFL) << 8) | ((b[at + 2] & 0xFFL) << 16) | ((b[at + 3] & 0xFFL) << 24);
    }

    private static String ascii(byte[] b, int from, int to) {
        return new String(b, from, to - from, StandardCharsets.ISO_8859_1);
    }

    static WavInfo check(Source file) throws La2lException, IOException {
        long size = file.size();
        if (size < 12) throw bad("The file is too short to be a WAV file.");
        byte[] head = file.read(0, 12);
        String riff = ascii(head, 0, 4);
        if (riff.equals("RF64") || riff.equals("BW64")) throw bad("RF64 files are not supported. Send a normal WAV file.");
        if (!riff.equals("RIFF") || !ascii(head, 8, 12).equals("WAVE")) throw bad("This is not a WAV file.");

        long pos = 12;
        int[] fmt = null; // formatTag, channels, sampleRate (as int bits), blockAlign, bitsPerSample
        long sampleRate = 0;
        long dataOffset = -1;
        long dataBytes = 0;
        int chunks = 0;
        // Walk the chunks. Large chunks that are not needed (LIST, bext, JUNK) are skipped, not read.
        while (pos + 8 <= size && !(fmt != null && dataOffset >= 0)) {
            if (++chunks > MAX_CHUNKS) throw bad("The WAV header is damaged.");
            byte[] hdr = file.read(pos, 8);
            String id = ascii(hdr, 0, 4);
            long len = u32(hdr, 4);
            long body = pos + 8;
            if (id.equals("fmt ")) {
                byte[] b = file.read(body, (int) Math.min(len, 64));
                if (b.length < 16) throw bad("The WAV header is damaged.");
                int formatTag = u16(b, 0);
                // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of a GUID.
                if (formatTag == EXTENSIBLE && b.length >= 26) formatTag = u16(b, 24);
                fmt = new int[] {formatTag, u16(b, 2), 0, u16(b, 12), u16(b, 14)};
                sampleRate = u32(b, 4);
            } else if (id.equals("data")) {
                // Some recorders leave the size at 0 or 0xFFFFFFFF while writing: use what is there.
                if (len == 0 || len == 0xFFFFFFFFL || body + len > size) len = size - body;
                dataOffset = body;
                dataBytes = len;
            }
            pos = body + len + (len & 1);
        }
        if (fmt == null) throw bad("The WAV file has no format block.");
        if (dataOffset < 0) throw bad("The WAV file has no sound data.");
        int formatTag = fmt[0];
        int channels = fmt[1];
        int bits = fmt[4];
        if (formatTag == PCM) {
            if (bits != 8 && bits != 16 && bits != 24 && bits != 32) throw bad(bits + "-bit PCM is not supported. Use 16 or 24 bit.");
        } else if (formatTag == FLOAT) {
            if (bits != 32 && bits != 64) throw bad(bits + "-bit float is not supported. Use 32-bit float.");
        } else {
            throw bad("This WAV file is compressed (format " + formatTag + "). Send plain PCM or float WAV.");
        }
        if (channels < 1 || channels > 2) throw bad("The WAV file has " + channels + " channels. Live places mono and stereo files only.");
        if (sampleRate < 8000 || sampleRate > 192000) throw bad("The sample rate " + sampleRate + " Hz is not supported.");
        int blockAlign = fmt[3] != 0 ? fmt[3] : (channels * bits) / 8;
        long frames = dataBytes / blockAlign;
        if (frames < 1) throw bad("The WAV file is empty.");
        return new WavInfo(formatTag == FLOAT ? "float" : "pcm", channels, sampleRate, bits, blockAlign, dataOffset, dataBytes, frames, size);
    }
}
