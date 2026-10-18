package nl.lloydstellar.la2l;

/** What a sound is to Live. */
public enum Kind {
    /** Warped to the tempo and looped over its length. */
    LOOP("loop"),
    /** Plays exactly as the app made it: no warp, no loop. */
    ONESHOT("oneshot");

    private final String value;

    Kind(String value) {
        this.value = value;
    }

    /** "loop" or "oneshot", as in the package description. */
    public String value() {
        return value;
    }
}
