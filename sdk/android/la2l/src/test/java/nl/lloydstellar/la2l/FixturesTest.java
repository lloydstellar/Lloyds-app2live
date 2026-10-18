package nl.lloydstellar.la2l;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;

// sdk/fixtures against the checks of this library: WavCheck and ManifestCheck (as the server and
// as the device) give exactly the verdicts of expected.json, which the device, the server and
// the web SDK are held to as well.
public class FixturesTest {
    private static JSONObject expected() throws Exception {
        return new JSONObject(Repo.read("sdk/fixtures/expected.json"));
    }

    @Test
    public void everyWavFixtureGetsTheVerdictOfTheDevice() throws Exception {
        JSONArray wavs = expected().getJSONArray("wav");
        assertTrue(wavs.length() > 20);
        for (int i = 0; i < wavs.length(); i++) {
            JSONObject f = wavs.getJSONObject(i);
            JSONObject device = f.getJSONObject("device");
            File file = Repo.file("sdk/fixtures/" + f.getString("file"));
            byte[] bytes = Files.readAllBytes(file.toPath());
            // From a file and from memory: the same verdict.
            for (int source = 0; source < 2; source++) {
                String where = f.getString("file") + (source == 0 ? " (file)" : " (bytes)");
                try {
                    WavInfo info = source == 0 ? WavCheck.check(file) : WavCheck.check(bytes);
                    assertTrue(where + " should be refused", device.getBoolean("ok"));
                    assertEquals(where, device.getString("format"), info.format);
                    assertEquals(where, device.getInt("channels"), info.channels);
                    assertEquals(where, device.getLong("sampleRate"), info.sampleRate);
                    assertEquals(where, device.getInt("bitsPerSample"), info.bitsPerSample);
                    assertEquals(where, device.getLong("frames"), info.frames);
                    assertEquals(where, device.getLong("dataBytes"), info.dataBytes);
                    assertEquals(where, bytes.length, info.fileBytes);
                } catch (La2lException e) {
                    assertFalse(where + ": " + e.getMessage(), device.getBoolean("ok"));
                    assertEquals(where, La2lException.Code.BAD_WAV, e.getCode());
                    assertEquals(where, device.getString("error"), e.getMessage());
                }
            }
        }
    }

    @Test
    public void everyManifestFixtureGetsTheVerdictsOfTheDeviceAndTheServer() throws Exception {
        JSONArray manifests = expected().getJSONArray("manifests");
        assertTrue(manifests.length() > 10);
        for (int i = 0; i < manifests.length(); i++) {
            JSONObject f = manifests.getJSONObject(i);
            String where = f.getString("file");
            Object raw = new JSONTokener(Repo.read("sdk/fixtures/" + where)).nextValue();
            // The device gets a manifest from the server, which gives it a package_id first.
            Object delivered = raw instanceof JSONObject ? new JSONObject(raw.toString()).put("package_id", "fixture-package") : raw;
            ManifestCheck.Result device = ManifestCheck.asDevice(delivered);
            JSONObject d = f.getJSONObject("device");
            if (!d.getBoolean("ok")) {
                assertFalse(where, device.ok);
                assertEquals(where, d.getString("error"), device.error);
                assertEquals(where, 0, device.warnings.size());
            } else {
                assertTrue(where + ": " + device.error, device.ok);
                assertEquals(where, strings(d.getJSONArray("warnings")), device.warnings);
                JSONArray items = d.getJSONArray("items");
                assertEquals(where, items.length(), device.pkg.items.size());
                for (int k = 0; k < items.length(); k++) {
                    JSONObject it = items.getJSONObject(k);
                    ManifestCheck.CheckedSound sound = device.pkg.items.get(k);
                    assertEquals(where, it.getString("name"), sound.name);
                    assertEquals(where, it.getString("kind"), sound.kind);
                    assertEquals(where, it.isNull("error") ? null : it.getString("error"), sound.error);
                }
            }
            ManifestCheck.Result server = ManifestCheck.asServer(raw);
            JSONObject s = f.getJSONObject("server");
            if (s.getInt("status") == 201) {
                assertTrue(where + ": " + server.error, server.ok);
                assertEquals(where, strings(s.getJSONArray("warnings")), server.warnings);
            } else {
                assertFalse(where, server.ok);
                assertEquals(where, s.getInt("status"), server.status);
                assertEquals(where, s.getString("error"), server.error);
            }
        }
    }

    private static List<String> strings(JSONArray a) throws Exception {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        return out;
    }

    @Test
    public void namesAndSizesAreWrittenAsTheDeviceWritesThem() {
        assertEquals("Robot hallo!", Text.cleanName("  Robot\thallo!? ", "x", 40));
        assertEquals("Kick (drums)", Text.cleanName("Kick (drums)", "x", 40));
        assertEquals("Битмейкер", Text.cleanName("Битмейкер", "x", 40));
        assertEquals("Sound 1", Text.cleanName(null, "Sound 1", 40));
        assertEquals("Sound 1", Text.cleanName("💥", "Sound 1", 40));
        assertEquals("abc", Text.cleanName("abcdef", "x", 3));
        assertEquals("1.6 MB", Text.megabytes(1693484));
        assertEquals("201 MB", Text.megabytes(210763776));
        assertEquals("92", Text.jsString(92.0));
        assertEquals("92.5", Text.jsString(92.5));
        assertEquals("true", Text.jsString(true));
    }

    @Test
    public void fileNamesAreOnesTheServerTakes() {
        java.util.Set<String> taken = new java.util.HashSet<>();
        assertEquals("Kick.wav", La2l.fileName("Kick", 0, taken));
        assertEquals("kick-2.wav", La2l.fileName("kick.WAV", 1, taken));
        assertEquals("Robot hallo.wav", La2l.fileName("Robot hallö", 2, taken));
        assertEquals("sound 4.wav", La2l.fileName("???", 3, taken));
        assertEquals("a.b.wav", La2l.fileName("..a..b...", 4, taken));
        for (String name : taken) assertTrue(name, ManifestCheck.isValidFileName(name));
        if (ManifestCheck.isValidFileName("../x.wav")) fail("a name that leads out of its folder");
    }
}
