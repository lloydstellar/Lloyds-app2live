package nl.lloydstellar.la2l;

import java.util.Collections;
import java.util.List;

/** Where a package is: waiting until Import in Live, then in Live, partly in Live, failed or expired. */
public final class DeliveryStatus {
    /** uploading, waiting, imported, partial, failed or expired. */
    public final String status;
    public final List<SoundResult> sounds;
    /** Why the package as a whole failed, when LA2L said so, or null. */
    public final String error;
    public final String updatedAt;

    DeliveryStatus(String status, List<SoundResult> sounds, String error, String updatedAt) {
        this.status = status;
        this.sounds = Collections.unmodifiableList(sounds);
        this.error = error;
        this.updatedAt = updatedAt;
    }

    /** What happened to one sound in Live. */
    public static final class SoundResult {
        public final String id;
        public final String name;
        /** imported or failed. */
        public final String status;
        /** Why it is not in Live, in LA2L's words, or null. */
        public final String error;

        SoundResult(String id, String name, String status, String error) {
            this.id = id;
            this.name = name;
            this.status = status;
            this.error = error;
        }
    }
}
