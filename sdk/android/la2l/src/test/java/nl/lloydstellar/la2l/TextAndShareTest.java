package nl.lloydstellar.la2l;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

// Numbers printed as JavaScript prints them, and the description La2lShare puts in the text of a
// share, as LA2L Sender reads it (server/public/share.js).
public class TextAndShareTest {
    @Test
    public void numbersReadAsJavaScriptWritesThem() {
        // What node prints for String(n) of each.
        double[] n = {92, 92.5, 0.0005, 12345678.1, Math.pow(2, 60), 1e21, 1.5e-7, -0.1, 123e-20, Math.pow(2, 53) + 2, 1.0 / 3};
        String[] js = {"92", "92.5", "0.0005", "12345678.1", "1152921504606847000", "1e+21", "1.5e-7", "-0.1", "1.23e-18", "9007199254740994", "0.3333333333333333"};
        for (int i = 0; i < n.length; i++) assertEquals(js[i], Text.jsNumber(n[i]));
        assertEquals("6000000000000000000", Text.jsNumber(6e18));
        assertEquals("11444091796875 MB", Text.megabytes(2 * 6e18));
    }

    @Test
    public void theShareTextIsADescriptionLa2lSenderReads() throws Exception {
        SoundPackage pkg = new SoundPackage("Treinbeat").bpm(92)
            .add(Sound.loop("Kick", new byte[0]).role(Role.DRUMS).lengthBeats(16).color("#E5484D"))
            .add(Sound.oneShot("Robot hallo", new byte[0]).role(Role.VOCAL).gainDb(-3).id("robot"))
            .add(Sound.loop("Odd", new byte[0]).bpm(Double.NaN));
        JSONObject text = new JSONObject(La2lShare.text(pkg, Arrays.asList("kick.wav", "robot.wav", "odd.wav")));
        assertEquals("app2live/1", text.getString("schema"));
        assertEquals("Treinbeat", text.getString("title"));
        assertEquals(92.0, text.getJSONObject("tempo").getDouble("bpm"), 0);
        JSONArray items = text.getJSONArray("items");
        JSONObject kick = items.getJSONObject(0);
        assertEquals("kick.wav", kick.getString("file"));
        assertEquals("loop", kick.getString("kind"));
        assertEquals("drums", kick.getString("role"));
        assertEquals(16.0, kick.getDouble("length_beats"), 0);
        assertEquals("#E5484D", kick.getString("color"));
        // LA2L Sender fills these in itself.
        assertFalse(kick.has("bytes"));
        assertFalse(kick.has("sha256"));
        JSONObject robot = items.getJSONObject(1);
        assertEquals("oneshot", robot.getString("kind"));
        assertEquals(-3.0, robot.getDouble("gain_db"), 0);
        assertEquals("robot", robot.getString("id"));
        // NaN is no JSON number: it goes as null, and LA2L ignores it with a warning.
        assertTrue(items.getJSONObject(2).isNull("bpm"));
    }
}
