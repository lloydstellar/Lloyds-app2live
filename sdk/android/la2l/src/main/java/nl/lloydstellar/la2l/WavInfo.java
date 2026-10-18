package nl.lloydstellar.la2l;

/** What the header of a WAV file says that Live can use. */
public final class WavInfo {
    /** "pcm" or "float". */
    public final String format;
    public final int channels;
    public final long sampleRate;
    public final int bitsPerSample;
    public final int blockAlign;
    /** Where the sound data starts, and how many bytes it has. */
    public final long dataOffset;
    public final long dataBytes;
    public final long frames;
    /** In seconds. */
    public final double duration;
    public final long fileBytes;

    WavInfo(String format, int channels, long sampleRate, int bitsPerSample, int blockAlign, long dataOffset, long dataBytes, long frames, long fileBytes) {
        this.format = format;
        this.channels = channels;
        this.sampleRate = sampleRate;
        this.bitsPerSample = bitsPerSample;
        this.blockAlign = blockAlign;
        this.dataOffset = dataOffset;
        this.dataBytes = dataBytes;
        this.frames = frames;
        this.duration = (double) frames / sampleRate;
        this.fileBytes = fileBytes;
    }
}
