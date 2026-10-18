package nl.lloydstellar.la2l;

import java.io.File;

/**
 * One sound to send: a WAV file (on disk or in memory) and what it is. A loop is warped to the
 * tempo and looped; a one-shot plays exactly as the app made it.
 *
 * <pre>
 * Sound.loop("Kick", kickWav).role(Role.DRUMS).lengthBeats(16)
 * Sound.oneShot("Robot hallo", robotFile).role(Role.VOCAL)
 * </pre>
 */
public final class Sound {
    final String name;
    final Kind kind;
    final File file;
    final byte[] bytes;
    Role role;
    Double bpm;
    Double lengthBeats;
    String warpMode;
    String color;
    Double gainDb;
    String id;
    String fileName;
    String sha256;

    private Sound(String name, Kind kind, File file, byte[] bytes) {
        if (kind == null) throw new IllegalArgumentException("A sound needs a kind: Kind.LOOP or Kind.ONESHOT.");
        if (file == null && bytes == null) throw new IllegalArgumentException("A sound needs a WAV file.");
        this.name = name;
        this.kind = kind;
        this.file = file;
        this.bytes = bytes;
    }

    /** A sound from a WAV file on disk. `name` is the track name in Live, at most 40 characters. */
    public static Sound of(String name, File wav, Kind kind) {
        return new Sound(name, kind, wav, null);
    }

    /** A sound from a WAV file in memory, such as Wav.fromPcm16 makes. */
    public static Sound of(String name, byte[] wav, Kind kind) {
        return new Sound(name, kind, null, wav);
    }

    public static Sound loop(String name, File wav) {
        return of(name, wav, Kind.LOOP);
    }

    public static Sound loop(String name, byte[] wav) {
        return of(name, wav, Kind.LOOP);
    }

    public static Sound oneShot(String name, File wav) {
        return of(name, wav, Kind.ONESHOT);
    }

    public static Sound oneShot(String name, byte[] wav) {
        return of(name, wav, Kind.ONESHOT);
    }

    /** Picks the warp mode of a loop: drums Beats, bass Tones, melodic and vocal Complex Pro. */
    public Sound role(Role role) {
        this.role = role;
        return this;
    }

    /** The tempo of this loop, when it differs from the package's. */
    public Sound bpm(double bpm) {
        this.bpm = bpm;
        return this;
    }

    /** The loop length in beats. Default: worked out from the length and the tempo. */
    public Sound lengthBeats(double beats) {
        this.lengthBeats = beats;
        return this;
    }

    /** Overrides the warp mode the role gives: beats, tones, texture, repitch, complex, complex_pro. */
    public Sound warpMode(String mode) {
        this.warpMode = mode;
        return this;
    }

    /** "#RRGGBB". */
    public Sound color(String color) {
        this.color = color;
        return this;
    }

    public Sound gainDb(double gainDb) {
        this.gainDb = gainDb;
        return this;
    }

    /** Your own id for this sound, sent back in the result. */
    public Sound id(String id) {
        this.id = id;
        return this;
    }

    /** The file name on the server. Default: made from the file's or the sound's name. */
    public Sound fileName(String fileName) {
        this.fileName = fileName;
        return this;
    }

    /** The SHA-256 of the file in hex, when you know it already, so a large file is not hashed again. */
    public Sound sha256(String sha256) {
        this.sha256 = sha256;
        return this;
    }

    long size() {
        return file != null ? file.length() : bytes.length;
    }
}
