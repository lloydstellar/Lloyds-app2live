package nl.lloydstellar.la2l;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The package description (app2live/1, docs/manifest.md), checked as LA2L in Live does it
 * (src/node/manifest.js), with the same texts, and as la2l-server does it, which is stricter.
 * sdk/fixtures holds both to the same verdicts.
 */
public final class ManifestCheck {
    private ManifestCheck() {}

    public static final String SCHEMA = "app2live/1";
    public static final int MAX_ITEMS = 32;
    public static final long MAX_PACKAGE_BYTES = 200L * 1048576;
    /** The largest description the server takes, in bytes of JSON. */
    public static final int MAX_MANIFEST_BYTES = 1048576;

    static final String[] ROLES = {"drums", "bass", "melodic", "vocal", "texture", "fx"};
    private static final Map<String, Integer> WARP_MODES = new HashMap<>();

    static {
        WARP_MODES.put("beats", 0);
        WARP_MODES.put("tones", 1);
        WARP_MODES.put("texture", 2);
        WARP_MODES.put("repitch", 3);
        WARP_MODES.put("complex", 4);
        WARP_MODES.put("complexpro", 6);
    }

    private static final Pattern NUMBERED_SCHEMA = Pattern.compile("^app2live/\\d+$");
    private static final Pattern PACKAGE_ID = Pattern.compile("^[A-Za-z0-9._-]{1,100}$");
    private static final Pattern FILE = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$");
    private static final Pattern WAV_END = Pattern.compile("(?i)\\.wav$");
    private static final Pattern SHA256 = Pattern.compile("(?i)^[a-f0-9]{64}$");
    private static final Pattern COLOR = Pattern.compile("(?i)^#?([0-9a-f]{6})$");
    private static final Pattern SEPARATORS = Pattern.compile(Text.JS_SPACE.replace("[", "[_\\-"));
    // The server gives every package its own id before it checks it (server/src/routes/packages.js).
    private static final String SERVER_ID = "00000000-0000-0000-0000-000000000000";
    private static final int MAX_WARNINGS = 50;

    /** One sound of a package, as the device reads it. */
    public static final class CheckedSound {
        public final int index;
        public String id = "";
        public String file = "";
        public String sha256;
        public Long bytes;
        public String name;
        /** "loop" or "oneshot". */
        public String kind = "oneshot";
        public String role;
        public Double lengthBeats;
        /** A warp mode the description asked for, as Live's number. */
        public Integer warpMode;
        public Double bpm;
        /** 0xRRGGBB. */
        public Integer color;
        public Double gainDb;
        /** Why the device skips this sound, in its own words ("has no valid file name"), or null. */
        public String error;

        CheckedSound(int index) {
            this.index = index;
            this.name = "Sound " + (index + 1);
        }
    }

    /** A package as the device reads it. */
    public static final class CheckedPackage {
        public String packageId = "";
        public String title;
        /** source.app, added to every track name. */
        public String app;
        public String appVersion;
        public String platform;
        public String createdAt;
        public Double bpm;
        public int[] timeSignature;
        public final List<CheckedSound> items = new ArrayList<>();
        public int midiCount;
    }

    /** The verdict: ok with the package and its warnings, or the text of the refusal. */
    public static final class Result {
        public final boolean ok;
        public final CheckedPackage pkg;
        public final String error;
        public final List<String> warnings;
        /** As the server: the status of its answer (400, 413 or 422); 0 as the device. */
        public final int status;

        Result(CheckedPackage pkg, List<String> warnings) {
            this.ok = true;
            this.pkg = pkg;
            this.error = null;
            this.warnings = Collections.unmodifiableList(warnings);
            this.status = 0;
        }

        Result(String error, int status, List<String> warnings) {
            this.ok = false;
            this.pkg = null;
            this.error = error;
            this.warnings = Collections.unmodifiableList(warnings);
            this.status = status;
        }
    }

    private static final class ManifestError extends Exception {
        ManifestError(String message) {
            super(message);
        }
    }

    /** A value from the description, quoted in a warning, as JavaScript's String(v).slice(0, 40). */
    private static String shown(Object v) {
        String s = v == null || v == JSONObject.NULL ? "null" : Text.jsString(v);
        return s.length() > 40 ? s.substring(0, 40) : s;
    }

    /** "#E5484D" or "E5484D" to 0xE5484D, anything else to null. */
    public static Integer parseColor(Object v) {
        if (!(v instanceof String)) return null;
        java.util.regex.Matcher m = COLOR.matcher(Text.jsTrim((String) v));
        return m.matches() ? Integer.parseInt(m.group(1), 16) : null;
    }

    /** "Complex Pro", "complex_pro" or 6 to 6; anything Live does not know to null. */
    public static Integer parseWarpMode(Object v) {
        if (v instanceof Number) {
            Double d = Text.finite(v);
            if (d == null || d != Math.rint(d)) return null;
            int n = (int) (double) d;
            return n >= 0 && n <= 6 && n != 5 && d == n ? n : null;
        }
        if (!(v instanceof String)) return null;
        return WARP_MODES.get(SEPARATORS.matcher(Text.lower((String) v)).replaceAll(""));
    }

    private static String parseKind(Object v) {
        String k = v instanceof String ? SEPARATORS.matcher(Text.lower((String) v)).replaceAll("") : "";
        if (k.equals("loop")) return "loop";
        if (k.equals("oneshot")) return "oneshot";
        return null;
    }

    /**
     * A file name the server and the device take: a letter or digit first, then letters, digits,
     * space, ".", "_" or "-", ending in ".wav", at most 100 characters, and no "..".
     */
    public static boolean isValidFileName(Object v) {
        if (!(v instanceof String)) return false;
        String s = (String) v;
        return FILE.matcher(s).matches() && WAV_END.matcher(s).find() && !s.contains("..");
    }

    private static JSONObject objectOr(Object v) {
        return v instanceof JSONObject ? (JSONObject) v : new JSONObject();
    }

    private static String stringOr(Object v, int max) {
        if (!(v instanceof String)) return "";
        String s = (String) v;
        return s.length() > max ? s.substring(0, max) : s;
    }

    private static boolean isRole(String s) {
        for (String r : ROLES) if (r.equals(s)) return true;
        return false;
    }

    // src/node/manifest.js validate(), line by line. Throws a ManifestError for the package as a
    // whole; marks a sound with a problem (item.error) and goes on.
    private static CheckedPackage validate(Object rawValue, List<String> warnings) throws ManifestError {
        if (!(rawValue instanceof JSONObject)) throw new ManifestError("The package description is not valid.");
        JSONObject raw = (JSONObject) rawValue;
        Object schema = raw.opt("schema");
        if (!(schema instanceof String)) throw new ManifestError("This is not an App2Live package.");
        if (!schema.equals(SCHEMA)) {
            if (NUMBERED_SCHEMA.matcher((String) schema).matches()) throw new ManifestError("This package uses " + schema + ". Update LA2L to import it.");
            throw new ManifestError("This is not an App2Live package.");
        }
        Object packageId = raw.opt("package_id");
        if (!(packageId instanceof String) || !PACKAGE_ID.matcher((String) packageId).matches()) throw new ManifestError("The package has no valid package_id.");
        JSONObject source = objectOr(raw.opt("source"));
        JSONObject tempo = objectOr(raw.opt("tempo"));
        CheckedPackage pkg = new CheckedPackage();
        pkg.packageId = (String) packageId;
        pkg.title = Text.cleanName(raw.opt("title"), "Untitled", 60);
        pkg.app = Text.cleanName(source.opt("app"), "App", 40);
        pkg.appVersion = stringOr(source.opt("app_version"), 40);
        pkg.platform = stringOr(source.opt("platform"), 40);
        pkg.createdAt = stringOr(raw.opt("created_at"), 40);
        Object midi = raw.opt("midi");
        pkg.midiCount = midi instanceof JSONArray ? ((JSONArray) midi).length() : 0;
        if (!Text.truthy(raw.opt("title"))) warnings.add("no title");
        if (!Text.truthy(source.opt("app"))) warnings.add("no source.app");
        if (tempo.has("bpm")) {
            Double b = Text.finite(tempo.opt("bpm"));
            if (b != null && b >= 20 && b <= 999) pkg.bpm = b;
            else warnings.add("tempo.bpm is not a number from 20 to 999");
        }
        Object ts = tempo.opt("time_signature");
        if (ts instanceof JSONArray && ((JSONArray) ts).length() == 2 && Text.isInteger(((JSONArray) ts).opt(0)) && Text.isInteger(((JSONArray) ts).opt(1))) {
            pkg.timeSignature = new int[] {((Number) ((JSONArray) ts).opt(0)).intValue(), ((Number) ((JSONArray) ts).opt(1)).intValue()};
        }
        if (pkg.midiCount > 0) warnings.add(pkg.midiCount + " MIDI parts ignored (MIDI comes in a later version)");

        Object itemsValue = raw.opt("items");
        if (!(itemsValue instanceof JSONArray) || ((JSONArray) itemsValue).length() == 0) throw new ManifestError("The package has no sounds.");
        JSONArray items = (JSONArray) itemsValue;
        if (items.length() > MAX_ITEMS) throw new ManifestError("The package has " + items.length() + " sounds. LA2L takes " + MAX_ITEMS + " at most.");

        Set<String> files = new HashSet<>();
        long total = 0;
        for (int index = 0; index < items.length(); index++) {
            CheckedSound item = new CheckedSound(index);
            pkg.items.add(item);
            Object value = items.opt(index);
            if (!(value instanceof JSONObject)) {
                item.error = "is not described correctly";
                continue;
            }
            JSONObject it = (JSONObject) value;
            Object id = it.opt("id");
            item.id = id instanceof String && !((String) id).isEmpty() ? stringOr(id, 100) : String.valueOf(index + 1);
            item.name = Text.cleanName(it.opt("name"), "Sound " + (index + 1), 40);
            Object file = it.opt("file");
            if (!isValidFileName(file)) {
                item.error = "has no valid file name";
                continue;
            }
            if (files.contains(Text.lower((String) file))) {
                item.error = "uses the same file as another sound";
                continue;
            }
            files.add(Text.lower((String) file));
            item.file = (String) file;

            Object sha = it.opt("sha256");
            if (sha instanceof String && SHA256.matcher((String) sha).matches()) item.sha256 = Text.lower((String) sha);
            else if (it.has("sha256")) warnings.add(item.name + ": sha256 ignored");
            Object bytes = it.opt("bytes");
            if (Text.isInteger(bytes) && Text.finite(bytes) > 0) {
                item.bytes = (long) (double) Text.finite(bytes);
                total += item.bytes;
            } else if (it.has("bytes")) warnings.add(item.name + ": bytes ignored");

            Object kindValue = it.opt("kind");
            String kind = parseKind(kindValue);
            if (kind != null) item.kind = kind;
            else if (kindValue == null || kindValue == JSONObject.NULL || "".equals(kindValue)) warnings.add(item.name + ": no kind, placed as one-shot");
            else warnings.add(item.name + ": kind \"" + shown(kindValue) + "\" unknown, placed as one-shot");

            Object role = it.opt("role");
            if (role instanceof String && isRole(Text.lower((String) role))) item.role = Text.lower((String) role);
            else if (it.has("role")) warnings.add(item.name + ": role \"" + shown(role) + "\" unknown");

            if (it.has("length_beats")) {
                Double l = Text.finite(it.opt("length_beats"));
                if (l != null && l > 0 && l <= 4096) item.lengthBeats = l;
                else warnings.add(item.name + ": length_beats ignored");
            }
            if (it.has("warp_mode")) {
                item.warpMode = parseWarpMode(it.opt("warp_mode"));
                if (item.warpMode == null) warnings.add(item.name + ": warp_mode \"" + shown(it.opt("warp_mode")) + "\" unknown");
            }
            if (it.has("bpm")) {
                Double b = Text.finite(it.opt("bpm"));
                if (b != null && b >= 20 && b <= 999) item.bpm = b;
                else warnings.add(item.name + ": bpm ignored");
            }
            if (it.has("color")) {
                item.color = parseColor(it.opt("color"));
                if (item.color == null) warnings.add(item.name + ": color ignored");
            }
            if (it.has("gain_db")) {
                Double g = Text.finite(it.opt("gain_db"));
                if (g != null) item.gainDb = Math.max(-70, Math.min(24, g));
                else warnings.add(item.name + ": gain_db ignored");
            }
        }
        if (total > MAX_PACKAGE_BYTES) {
            throw new ManifestError("The package is " + Text.megabytes(total) + ". LA2L takes " + Text.megabytes(MAX_PACKAGE_BYTES) + " at most.");
        }
        return pkg;
    }

    /** As LA2L in Live judges a description it downloaded: a sound with a problem is skipped, the rest goes in. */
    public static Result asDevice(Object manifest) {
        List<String> warnings = new ArrayList<>();
        try {
            return new Result(validate(manifest, warnings), warnings);
        } catch (ManifestError e) {
            return new Result(e.getMessage(), 0, new ArrayList<String>());
        } catch (RuntimeException e) {
            return new Result("The package description is not valid.", 0, new ArrayList<String>());
        }
    }

    /**
     * As POST /packages judges it, for an app that is about to send: every sound must be valid and
     * have bytes and sha256. package_id is not needed: the server gives the package its own.
     */
    public static Result asServer(Object manifest) {
        String text = manifest instanceof JSONObject || manifest instanceof JSONArray ? manifest.toString() : null;
        if (text != null && text.getBytes(StandardCharsets.UTF_8).length > MAX_MANIFEST_BYTES) return tooLarge();
        if (!(manifest instanceof JSONObject)) return new Result("Send a JSON object.", 400, new ArrayList<String>());
        JSONObject sent;
        try {
            sent = new JSONObject(text);
            sent.put("package_id", SERVER_ID);
        } catch (JSONException e) {
            return new Result("Send a JSON object.", 400, new ArrayList<String>());
        }
        List<String> warnings = new ArrayList<>();
        CheckedPackage pkg;
        try {
            pkg = validate(sent, warnings);
        } catch (ManifestError e) {
            return new Result(e.getMessage(), 422, new ArrayList<String>());
        } catch (RuntimeException e) {
            return new Result("The package description is not valid.", 422, new ArrayList<String>());
        }
        // Stricter than the device: every sound must be right, with its size and checksum.
        for (CheckedSound item : pkg.items) {
            if (item.error != null) return new Result(item.name + " " + item.error, 422, warnings);
            if (item.bytes == null || item.sha256 == null) return new Result(item.name + " needs bytes and sha256.", 422, warnings);
        }
        // A tempo only changes a loop: Live plays a one-shot as it is.
        boolean loops = false;
        for (CheckedSound item : pkg.items) {
            if (item.kind.equals("loop")) loops = true;
            else if (item.bpm != null || item.lengthBeats != null) warnings.add(item.name + ": bpm and length_beats only apply to a loop");
        }
        if (pkg.bpm != null && !loops) warnings.add("tempo.bpm only applies to loops, and this package has none");
        // The server sends the description on with its own id, which may make it larger.
        if (sent.toString().getBytes(StandardCharsets.UTF_8).length > MAX_MANIFEST_BYTES) return tooLarge();
        pkg.packageId = "";
        return new Result(pkg, warnings.size() > MAX_WARNINGS ? new ArrayList<>(warnings.subList(0, MAX_WARNINGS)) : warnings);
    }

    private static Result tooLarge() {
        return new Result("The request is larger than 1 MB.", 413, new ArrayList<String>());
    }
}
