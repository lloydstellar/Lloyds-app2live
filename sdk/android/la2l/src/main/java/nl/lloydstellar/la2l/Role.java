package nl.lloydstellar.la2l;

/**
 * What a sound plays. For a loop it picks the warp mode: drums Beats, bass Tones, melodic and
 * vocal Complex Pro, texture Texture, fx Complex.
 */
public enum Role {
    DRUMS("drums"),
    BASS("bass"),
    MELODIC("melodic"),
    VOCAL("vocal"),
    TEXTURE("texture"),
    FX("fx");

    private final String value;

    Role(String value) {
        this.value = value;
    }

    /** As in the package description: "drums", "bass" and so on. */
    public String value() {
        return value;
    }
}
