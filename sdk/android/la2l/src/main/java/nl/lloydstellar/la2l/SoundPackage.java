package nl.lloydstellar.la2l;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * What to send: up to 32 sounds and 200 MB, with a title and a tempo.
 *
 * <pre>
 * new SoundPackage("Treinbeat").bpm(92).add(Sound.loop("Kick", kickWav).role(Role.DRUMS))
 * </pre>
 */
public final class SoundPackage {
    final String title;
    Double bpm;
    int[] timeSignature;
    final List<Sound> sounds = new ArrayList<>();
    ProgressListener progress;

    /** `title`: the scene name in Live, and the folder on disk. */
    public SoundPackage(String title) {
        this.title = title;
    }

    /** The tempo of every loop that has no bpm of its own. */
    public SoundPackage bpm(double bpm) {
        this.bpm = bpm;
        return this;
    }

    public SoundPackage timeSignature(int beats, int unit) {
        this.timeSignature = new int[] {beats, unit};
        return this;
    }

    public SoundPackage add(Sound... sounds) {
        this.sounds.addAll(Arrays.asList(sounds));
        return this;
    }

    /** Told how far the upload is; on the main thread of an Android app. */
    public SoundPackage onProgress(ProgressListener listener) {
        this.progress = listener;
        return this;
    }

    public List<Sound> sounds() {
        return Collections.unmodifiableList(sounds);
    }

    /** How far a send is. */
    public interface ProgressListener {
        /**
         * @param share the share of all bytes uploaded, from 0 to 1
         * @param sound the position of the sound being uploaded, from 0
         * @param soundShare how much of that sound is uploaded, from 0 to 1
         */
        void onProgress(double share, int sound, double soundShare);
    }
}
