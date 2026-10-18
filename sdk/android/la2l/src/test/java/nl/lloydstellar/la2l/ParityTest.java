package nl.lloydstellar.la2l;

import static org.junit.Assert.assertEquals;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;

// ManifestCheck against the checks of the web SDK (sdk/js, whose parity test holds them to the
// device) on hundreds of random descriptions, odd ones on purpose: numbers as strings, nulls,
// huge numbers, names in any script, kinds and roles written every way. Needs Node.js and a
// build of sdk/js, as the integration tests do.
public class ParityTest {
    private static final Object NULL = JSONObject.NULL;
    private static final Object MISSING = new Object();
    private static final Object[] STRINGS = {"Kick", "Robot hallo", "  spaced   out ", "Битмейкер", "日本語の名前", "emoji 💥 boom", "a\tb\nc", "(drums) & bass #1!", "Ünïcödé", "../etc", "", "x", "A name that is longer than forty characters, for sure", 92, 92.5, true, NULL};
    private static final Object[] FILES = {"kick.wav", "Kick.WAV", "snare 2.wav", "a.b.wav", "..x.wav", "x/../y.wav", "x.mp3", "", "-x.wav", "kick.wav", "snare_3-final.wav", 5, NULL};
    private static final Object[] NUMBERS = {92, 92.5, 19, 20, 999, 1000, 0, -1, 4096, 4097, 0.5, 6e18, 1e19, 1.5, "92", NULL, 1e-7, 120};
    private static final Object[] KINDS = {"loop", "LOOP", "one-shot", "one_shot", "One Shot", "oneshot", "x", "", 5, NULL, "loop "};
    private static final Object[] ROLES = {"drums", "DRUMS", "drum", "fx", "texture", "vocal", 3, NULL, ""};
    private static final Object[] WARPS = {"Complex Pro", "complex_pro", "complex-pro", 6, 5, 4.0, "beats", "x", 7, NULL, 2.5};
    private static final Object[] COLORS = {"#E5484D", "e5484d", " #ABCDEF ", "#zzz", 5, NULL, "#e5484dff"};
    private static final Object[] GAINS = {-100, 0, 30, -3.5, "3", NULL, 24, -70};
    private static final Object[] IDS = {"kick", "", 7, NULL, "a-very-long-id"};
    private static final Object[] BYTES = {1000, 0, -1, 1.5, "10", 6e18, 104857600, 209715201, NULL, 44};
    private static final Object[] SHAS = {"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF", "abc", NULL, 64};

    private static Object pick(Random r, Object[] from) {
        return r.nextInt(6) == 0 ? MISSING : from[r.nextInt(from.length)];
    }

    private static void maybe(Random r, JSONObject o, String key, Object[] from) throws Exception {
        Object v = pick(r, from);
        if (v != MISSING) o.put(key, v);
    }

    private static Object randomManifest(Random r) throws Exception {
        if (r.nextInt(40) == 0) return new JSONArray().put(1);
        JSONObject m = new JSONObject();
        int schema = r.nextInt(20);
        if (schema < 17) m.put("schema", "app2live/1");
        else if (schema == 17) m.put("schema", "app2live/2");
        else if (schema == 18) m.put("schema", 5);
        maybe(r, m, "title", STRINGS);
        if (r.nextInt(4) > 0) {
            JSONObject source = new JSONObject();
            maybe(r, source, "app", STRINGS);
            maybe(r, source, "app_version", STRINGS);
            maybe(r, source, "platform", STRINGS);
            m.put("source", source);
        } else if (r.nextBoolean()) m.put("source", "web");
        if (r.nextInt(3) > 0) {
            JSONObject tempo = new JSONObject();
            maybe(r, tempo, "bpm", NUMBERS);
            if (r.nextInt(4) == 0) tempo.put("time_signature", r.nextBoolean() ? new JSONArray().put(4).put(4) : new JSONArray().put(4.5).put(4));
            m.put("tempo", tempo);
        }
        if (r.nextInt(15) == 0) m.put("midi", new JSONArray().put(new JSONObject()));
        int shape = r.nextInt(30);
        if (shape == 0) return m;
        if (shape == 1) return m.put("items", "not a list");
        int count = shape == 2 ? 33 : shape == 3 ? 0 : 1 + r.nextInt(4);
        JSONArray items = new JSONArray();
        for (int i = 0; i < count; i++) {
            if (r.nextInt(25) == 0) {
                items.put(r.nextBoolean() ? 5 : "a sound");
                continue;
            }
            JSONObject it = new JSONObject();
            maybe(r, it, "file", FILES);
            if (r.nextInt(3) == 0) it.put("file", "s" + i + ".wav");
            maybe(r, it, "name", STRINGS);
            maybe(r, it, "kind", KINDS);
            maybe(r, it, "role", ROLES);
            maybe(r, it, "bpm", NUMBERS);
            maybe(r, it, "length_beats", NUMBERS);
            maybe(r, it, "warp_mode", WARPS);
            maybe(r, it, "color", COLORS);
            maybe(r, it, "gain_db", GAINS);
            maybe(r, it, "id", IDS);
            maybe(r, it, "bytes", BYTES);
            maybe(r, it, "sha256", SHAS);
            items.put(it);
        }
        return m.put("items", items);
    }

    private static List<String> strings(JSONArray a) throws Exception {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        return out;
    }

    @Test
    public void randomDescriptionsGetTheVerdictsOfTheWebSdk() throws Exception {
        Random r = new Random(20261018);
        JSONArray inputs = new JSONArray();
        for (int i = 0; i < 600; i++) inputs.put(randomManifest(r));
        File dir = Files.createTempDirectory("la2l-parity-").toFile();
        File in = new File(dir, "in.json");
        File out = new File(dir, "out.json");
        File script = new File(dir, "check.mjs");
        Files.write(in.toPath(), inputs.toString().getBytes(StandardCharsets.UTF_8));
        Files.write(script.toPath(), String.join("\n",
            "import fs from 'node:fs';",
            "import { pathToFileURL } from 'node:url';",
            "const { checkManifest } = await import(pathToFileURL(process.argv[2]).href);",
            "const inputs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));",
            "const out = inputs.map((raw) => {",
            "  const delivered = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw, package_id: 'fixture-package' } : raw;",
            "  const d = checkManifest(delivered, { as: 'device' });",
            "  const s = checkManifest(raw);",
            "  return {",
            "    device: d.ok ? { ok: true, warnings: d.warnings, items: d.package.items.map((it) => ({ name: it.name, kind: it.kind, error: it.error })) } : { ok: false, error: d.error },",
            "    server: s.ok ? { ok: true, warnings: s.warnings } : { ok: false, status: s.status, error: s.error },",
            "  };",
            "});",
            "fs.writeFileSync(process.argv[4], JSON.stringify(out));").getBytes(StandardCharsets.UTF_8));
        Process node = new ProcessBuilder("node", script.getPath(), Repo.file("sdk/js/dist/index.js").getPath(), in.getPath(), out.getPath()).redirectErrorStream(true).start();
        String said = new String(node.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(said, 0, node.waitFor());
        JSONArray expected = new JSONArray(new String(Files.readAllBytes(out.toPath()), StandardCharsets.UTF_8));
        // Read back from the same text node read, so both sides see the same numbers.
        JSONArray same = new JSONArray(inputs.toString());
        List<String> differences = new ArrayList<>();
        for (int i = 0; i < same.length(); i++) {
            Object raw = same.get(i);
            Object delivered = raw instanceof JSONObject ? new JSONObject(raw.toString()).put("package_id", "fixture-package") : raw;
            ManifestCheck.Result device = ManifestCheck.asDevice(delivered);
            ManifestCheck.Result server = ManifestCheck.asServer(raw);
            JSONObject e = expected.getJSONObject(i);
            JSONObject d = e.getJSONObject("device");
            JSONObject s = e.getJSONObject("server");
            String mine = verdict(device, server);
            String theirs = verdict(d, s);
            if (!mine.equals(theirs)) differences.add("#" + i + " " + raw + "\n  java: " + mine + "\n  js:   " + theirs);
        }
        for (File f : dir.listFiles()) f.delete();
        dir.delete();
        assertEquals(String.join("\n", differences.subList(0, Math.min(5, differences.size()))), Collections.emptyList(), differences);
    }

    private static String verdict(ManifestCheck.Result d, ManifestCheck.Result s) {
        StringBuilder out = new StringBuilder("device ");
        if (!d.ok) out.append("refused: ").append(d.error);
        else {
            out.append("ok ").append(d.warnings);
            for (ManifestCheck.CheckedSound it : d.pkg.items) out.append(" [").append(it.name).append('|').append(it.kind).append('|').append(it.error).append(']');
        }
        out.append(" / server ");
        if (!s.ok) out.append("refused ").append(s.status).append(": ").append(s.error);
        else out.append("ok ").append(s.warnings);
        return out.toString();
    }

    private static String verdict(JSONObject d, JSONObject s) throws Exception {
        StringBuilder out = new StringBuilder("device ");
        if (!d.getBoolean("ok")) out.append("refused: ").append(d.getString("error"));
        else {
            out.append("ok ").append(strings(d.getJSONArray("warnings")));
            JSONArray items = d.getJSONArray("items");
            for (int k = 0; k < items.length(); k++) {
                JSONObject it = items.getJSONObject(k);
                out.append(" [").append(it.getString("name")).append('|').append(it.getString("kind")).append('|').append(it.isNull("error") ? null : it.getString("error")).append(']');
            }
        }
        out.append(" / server ");
        if (!s.getBoolean("ok")) out.append("refused ").append(s.getInt("status")).append(": ").append(s.getString("error"));
        else out.append("ok ").append(strings(s.getJSONArray("warnings")));
        return out.toString();
    }
}
