package nl.lloydstellar.la2l;

import android.content.Context;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Sends sounds from an Android app to LA2L in Ableton Live. Pair once with the code LA2L shows in
 * Live, then send sounds and follow them until they are in Live. The calls run on a background
 * thread: the Async methods return a CompletableFuture, the others report to a Callback on the
 * main thread. From Kotlin, la2l-ktx makes them suspend functions.
 *
 * <pre>
 * La2l la2l = new La2l(context, "Web808"); // Live shows "Paired with Web808"
 * if (!la2l.isPaired()) la2l.pairAsync(codeFromUser).get();
 * Delivery delivery = la2l.sendAsync(new SoundPackage("Treinbeat").bpm(92)
 *     .add(Sound.loop("Kick", Wav.fromPcm16(kick, 48000, 2)).role(Role.DRUMS))).get();
 * delivery.importedAsync().get(); // when the user clicks Import in Live
 * </pre>
 */
public final class La2l {
    /** The version of la2l; the X-LA2L-Client header says it to the server. */
    public static final String VERSION = "0.1.0";
    /** The LA2L server on lloydstellar.nl. */
    public static final String DEFAULT_SERVER = Http.DEFAULT_SERVER;

    private static final Pattern CODE = Pattern.compile("^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$");
    private static final String NO_CHECKSUM = "0000000000000000000000000000000000000000000000000000000000000000";
    private static final ExecutorService WORK = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "la2l");
        t.setDaemon(true);
        return t;
    });

    private final String appName;
    private final String appId;
    private final String appVersion;
    private final Storage storage;
    final Http http;

    /** What the client needs: the app name, and where to keep the token. */
    public static final class Options {
        final String appName;
        String appId;
        String appVersion = "";
        String server;
        Storage storage;

        /** The name LA2L shows in Live, "Paired with Web808", and in every track name: "Kick (Web808)". */
        public Options(String appName) {
            this.appName = appName;
        }

        /** This installation's own id. Default: a UUID made once and kept in the storage. */
        public Options appId(String appId) {
            this.appId = appId;
            return this;
        }

        /** The version of the app, for the description of a package. */
        public Options appVersion(String appVersion) {
            this.appVersion = appVersion == null ? "" : appVersion;
            return this;
        }

        /** The LA2L server. Default https://lloydstellar.nl/la2l/api; plain http only for localhost. */
        public Options server(String server) {
            this.server = server;
            return this;
        }

        /** Where the token is kept. Default with a Context: the app's private SharedPreferences. */
        public Options storage(Storage storage) {
            this.storage = storage;
            return this;
        }
    }

    /** The client for this app, with the token in the app's private SharedPreferences. */
    public La2l(Context context, String appName) {
        this(new Options(appName).storage(Storage.sharedPreferences(context)).appVersion(versionOf(context)));
    }

    public La2l(Options options) {
        if (options == null || options.appName == null || options.appName.trim().isEmpty()) {
            throw new IllegalArgumentException("Give the name of the app: Live shows it, \"Paired with Web808\".");
        }
        this.appName = options.appName.trim();
        this.storage = options.storage != null ? options.storage : Storage.memory();
        String id = options.appId;
        if (id == null || id.isEmpty()) id = storage.get("appId");
        if (id == null || id.isEmpty()) {
            id = UUID.randomUUID().toString();
            storage.set("appId", id);
        }
        this.appId = id;
        this.appVersion = options.appVersion;
        String name = appName.length() > 60 ? appName.substring(0, 60) : appName;
        this.http = new Http(Http.serverAddress(options.server), "la2l-android/" + VERSION + " (" + Http.headerValue(name) + ")");
    }

    private static String versionOf(Context context) {
        try {
            String v = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            return v == null ? "" : v;
        } catch (Exception e) {
            return "";
        }
    }

    public String getAppName() {
        return appName;
    }

    public String getAppId() {
        return appId;
    }

    public String getServer() {
        return http.server;
    }

    /** Whether this app has a token. A token can still turn out to be revoked: then a call gives NOT_PAIRED. */
    public boolean isPaired() {
        return storage.get("token") != null;
    }

    /** The name of the computer this app is paired with, as the server last said it, or null. */
    public String getDeviceName() {
        return isPaired() ? storage.get("deviceName") : null;
    }

    /** Forgets the pairing here only. unpair() also tells the server. */
    public void forget() {
        storage.remove("token");
        storage.remove("deviceName");
    }

    String token() throws La2lException {
        String token = storage.get("token");
        if (token == null) throw new La2lException(La2lException.Code.NOT_PAIRED, "This app is not paired. Type the code LA2L shows in Live.");
        return token;
    }

    /** Turns an error answer into a La2lException. A 401 means: the pairing is gone. */
    La2lException fail(Http.Answer answer, La2lException.Code codeFor4xx) {
        String message = answer.text();
        int status = answer.status;
        if (status == 401) {
            forget();
            return new La2lException(La2lException.Code.NOT_PAIRED, message, status, -1);
        }
        if (status == 429) return new La2lException(La2lException.Code.RATE_LIMITED, message, status, answer.retryAfter);
        if (status == 507) return new La2lException(La2lException.Code.SERVER_FULL, message, status, -1);
        if (status >= 500) return new La2lException(La2lException.Code.SERVER, message, status, -1);
        return new La2lException(codeFor4xx, message, status, -1);
    }

    // ---- running the calls ----

    interface Task<T> {
        T run(Job job) throws La2lException;
    }

    static <T> CompletableFuture<T> run(Task<T> task) {
        final CompletableFuture<T> future = new CompletableFuture<>();
        final Job job = new Job();
        future.whenComplete((v, e) -> {
            if (future.isCancelled()) job.cancel();
        });
        WORK.execute(() -> {
            try {
                future.complete(task.run(job));
            } catch (La2lException e) {
                future.completeExceptionally(e);
            } catch (RuntimeException e) {
                future.completeExceptionally(e);
            }
        });
        return future;
    }

    /** The La2lException behind what a future threw. */
    static La2lException unwrap(Throwable t) {
        while ((t instanceof CompletionException || t instanceof ExecutionException) && t.getCause() != null) t = t.getCause();
        if (t instanceof La2lException) return (La2lException) t;
        if (t instanceof CancellationException) return Job.aborted();
        return new La2lException(La2lException.Code.SERVER, t.getMessage() == null ? t.toString() : t.getMessage());
    }

    static <T> void deliver(CompletableFuture<T> future, Callback<T> callback) {
        future.whenComplete((value, error) -> MainThread.post(() -> {
            if (error == null) callback.onSuccess(value);
            else callback.onError(unwrap(error));
        }));
    }

    static JSONObject json(Object... keysAndValues) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i < keysAndValues.length; i += 2) {
                if (keysAndValues[i + 1] != null) o.put((String) keysAndValues[i], keysAndValues[i + 1]);
            }
        } catch (JSONException e) {
            throw new IllegalArgumentException(e.getMessage());
        }
        return o;
    }

    // ---- pairing ----

    /**
     * Pairs this app with the computer that shows the code. In Live the user clicks Pair app in
     * LA2L and reads a code like "K7P 42Q"; case, spaces and dashes do not matter. Resolves to the
     * name of the computer.
     */
    public CompletableFuture<String> pairAsync(final String code) {
        return run(job -> {
            String typed = code == null ? "" : code.toUpperCase(Locale.ROOT).replaceAll("[\\s-]", "");
            if (!CODE.matcher(typed).matches()) throw new La2lException(La2lException.Code.BAD_CODE, "A code has 6 letters and digits, like K7P 42Q.");
            Http.Answer answer = http.call("POST", "/pair/claim", json("code", typed, "app_name", appName, "app_id", appId), null, Http.Retry.NONE, job);
            if (answer.status == 404) throw new La2lException(La2lException.Code.BAD_CODE, answer.text(), 404, -1);
            String token = answer.json.optString("app_token", "");
            if (answer.status != 200 || token.isEmpty()) throw fail(answer, La2lException.Code.SERVER);
            String deviceName = answer.json.optString("device_name", "");
            if (deviceName.isEmpty()) deviceName = "your computer";
            storage.set("token", token);
            storage.set("deviceName", deviceName);
            return deviceName;
        });
    }

    public void pair(String code, Callback<String> callback) {
        deliver(pairAsync(code), callback);
    }

    /** Which computer this app is paired with. Ask it now and then; NOT_PAIRED means: pair again. */
    public CompletableFuture<Me> meAsync() {
        return run(job -> {
            Http.Answer answer = http.call("GET", "/app/me", null, token(), Http.Retry.ALL, job);
            if (answer.status != 200) throw fail(answer, La2lException.Code.SERVER);
            String deviceName = answer.json.optString("device_name", "");
            storage.set("deviceName", deviceName);
            return new Me(deviceName, answer.json.optString("app_name", ""), answer.json.optString("paired_at", ""));
        });
    }

    public void me(Callback<Me> callback) {
        deliver(meAsync(), callback);
    }

    /**
     * Unpairs this app: the server revokes the token, and it is forgotten here. When the server
     * cannot be reached, this fails with NETWORK and keeps the token, so the app can try again.
     */
    public CompletableFuture<Void> unpairAsync() {
        return run(job -> {
            String token = storage.get("token");
            if (token == null) return null;
            Http.Answer answer = http.call("POST", "/app/unpair", new JSONObject(), token, Http.Retry.ALL, job);
            if (answer.status != 200 && answer.status != 401) throw fail(answer, La2lException.Code.SERVER);
            forget();
            return null;
        });
    }

    public void unpair(Callback<Void> callback) {
        deliver(unpairAsync(), callback);
    }

    // ---- sending ----

    /**
     * Sends sounds to LA2L. Everything is checked before the first byte goes out, with the texts the
     * server and LA2L use. Then it announces the package, uploads the files one by one and commits.
     * Resolves to a Delivery, which follows the package until it is in Live.
     */
    public CompletableFuture<Delivery> sendAsync(final SoundPackage pkg) {
        return run(job -> send(pkg, job));
    }

    public void send(SoundPackage pkg, Callback<Delivery> callback) {
        deliver(sendAsync(pkg), callback);
    }

    /** Follows a package that was sent earlier, for example after the app restarted. */
    public Delivery delivery(String packageId) {
        return new Delivery(this, packageId, new ArrayList<String>(), null);
    }

    // A file name the server takes: letters, digits, space, "." "_" "-", ending in .wav, unique.
    static String fileName(String wanted, int index, Set<String> taken) {
        String base = Normalizer.normalize(wanted.replaceAll("(?i)\\.wav$", ""), Normalizer.Form.NFKD)
            .replaceAll("[^A-Za-z0-9 ._-]", "")
            .replaceAll("\\.{2,}", ".")
            .replaceAll("^[^A-Za-z0-9]+", "");
        if (base.length() > 90) base = base.substring(0, 90);
        base = base.replaceAll("[ ._-]+$", "");
        if (base.isEmpty()) base = "sound " + (index + 1);
        String file = base + ".wav";
        for (int n = 2; taken.contains(file.toLowerCase(Locale.ROOT)); n++) file = base + "-" + n + ".wav";
        taken.add(file.toLowerCase(Locale.ROOT));
        return file;
    }

    private static String now() {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date());
    }

    static String sha256(Sound s, Job job) throws La2lException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        if (s.bytes != null) digest.update(s.bytes);
        else {
            try (InputStream in = new FileInputStream(s.file)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    job.check();
                    digest.update(buf, 0, n);
                }
            } catch (IOException e) {
                throw new La2lException(La2lException.Code.BAD_WAV, "The file cannot be read.");
            }
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b & 0xFF));
        return hex.toString();
    }

    private void progress(final SoundPackage pkg, final double share, final int sound, final double soundShare) {
        if (pkg.progress != null) MainThread.post(() -> pkg.progress.onProgress(share, sound, soundShare));
    }

    private Delivery send(SoundPackage pkg, Job job) throws La2lException {
        String token = token();
        List<Sound> sounds = pkg == null ? new ArrayList<Sound>() : pkg.sounds;
        if (sounds.isEmpty()) throw new La2lException(La2lException.Code.BAD_PACKAGE, "The package has no sounds.");
        if (sounds.size() > ManifestCheck.MAX_ITEMS) {
            throw new La2lException(La2lException.Code.BAD_PACKAGE, "The package has " + sounds.size() + " sounds. LA2L takes " + ManifestCheck.MAX_ITEMS + " at most. Send them in more packages.");
        }

        // 1. The files: WAV files Live can use, of at most 200 MB together.
        Set<String> taken = new HashSet<>();
        List<JSONObject> items = new ArrayList<>();
        long total = 0;
        for (int i = 0; i < sounds.size(); i++) {
            Sound s = sounds.get(i);
            String fromFile = s.file != null ? s.file.getName() : "";
            String name = s.name != null && !s.name.trim().isEmpty() ? s.name.trim() : fromFile.replaceAll("\\.[^.]*$", "");
            if (name.isEmpty()) name = "Sound " + (i + 1);
            try {
                if (s.file != null) WavCheck.check(s.file);
                else WavCheck.check(s.bytes);
            } catch (La2lException e) {
                throw new La2lException(La2lException.Code.BAD_WAV, name + " is not a usable WAV: " + e.getMessage());
            }
            String file = s.fileName != null ? s.fileName : fileName(fromFile.isEmpty() ? name : fromFile, i, taken);
            if (s.fileName != null) taken.add(s.fileName.toLowerCase(Locale.ROOT));
            long bytes = s.size();
            total += bytes;
            items.add(json(
                "id", s.id != null ? s.id : "sound-" + (i + 1),
                "file", file,
                "bytes", bytes,
                "sha256", s.sha256 != null ? s.sha256 : NO_CHECKSUM,
                "name", name,
                "kind", s.kind.value(),
                "role", s.role != null ? s.role.value() : null,
                "bpm", s.bpm,
                "length_beats", s.lengthBeats,
                "warp_mode", s.warpMode,
                "color", s.color,
                "gain_db", s.gainDb));
        }
        if (total > ManifestCheck.MAX_PACKAGE_BYTES) {
            throw new La2lException(La2lException.Code.BAD_PACKAGE, "The package is " + Text.megabytes(total) + ". LA2L takes " + Text.megabytes(ManifestCheck.MAX_PACKAGE_BYTES) + " at most. Send the sounds in more packages.");
        }

        // 2. The description, as strict as the server.
        JSONArray list = new JSONArray();
        for (JSONObject item : items) list.put(item);
        JSONObject tempo = new JSONObject();
        try {
            if (pkg.bpm != null) tempo.put("bpm", (double) pkg.bpm);
            if (pkg.timeSignature != null) tempo.put("time_signature", new JSONArray().put(pkg.timeSignature[0]).put(pkg.timeSignature[1]));
        } catch (JSONException e) {
            throw new La2lException(La2lException.Code.BAD_PACKAGE, "tempo.bpm is not a number from 20 to 999");
        }
        JSONObject manifest = json(
            "schema", ManifestCheck.SCHEMA,
            "created_at", now(),
            "source", json("app", appName, "app_version", appVersion, "platform", "android"),
            "items", list,
            "title", pkg.title,
            "tempo", tempo.length() > 0 ? tempo : null);
        ManifestCheck.Result check = ManifestCheck.asServer(manifest);
        if (!check.ok) throw new La2lException(La2lException.Code.BAD_PACKAGE, check.error);

        // 3. The checksums, unless the app gave them.
        for (int i = 0; i < sounds.size(); i++) {
            job.check();
            progress(pkg, 0, i, 0);
            if (sounds.get(i).sha256 == null) {
                try {
                    items.get(i).put("sha256", sha256(sounds.get(i), job));
                } catch (JSONException e) {
                    throw new IllegalStateException(e);
                }
            }
        }

        // 4. Announce, upload, commit. Not tried again when the connection breaks: the package may exist already.
        Http.Answer created = http.call("POST", "/packages", manifest, token, Http.Retry.SERVER_ERRORS, job);
        String packageId = created.json.optString("package_id", "");
        if (created.status != 201 || packageId.isEmpty()) throw fail(created, La2lException.Code.BAD_PACKAGE);
        JSONObject upload = created.json.optJSONObject("upload");
        long sent = 0;
        try {
            for (int i = 0; i < sounds.size(); i++) {
                final Sound s = sounds.get(i);
                final int index = i;
                final long before = sent;
                final long all = total;
                final long size = s.size();
                String file = items.get(i).optString("file");
                String path = upload != null && upload.has(file) ? upload.optString(file) : "/packages/" + packageId + "/files/" + encode(file);
                uploadFile(path, s, token, part -> progress(pkg, all > 0 ? (before + part * size) / all : 1, index, part), job);
                sent += size;
            }
            Http.Answer commit = http.call("POST", "/packages/" + packageId + "/commit", new JSONObject(), token, Http.Retry.ALL, job);
            if (commit.status != 200) throw fail(commit, La2lException.Code.BAD_PACKAGE);
        } catch (La2lException e) {
            // The rest would only wait for an hour on the server.
            if (e.getCode() != La2lException.Code.NOT_PAIRED) {
                final String id = packageId;
                WORK.execute(() -> {
                    try {
                        http.call("DELETE", "/packages/" + id, null, token, Http.Retry.NONE, new Job());
                    } catch (La2lException ignored) {
                        // it goes by itself after an hour
                    }
                });
            }
            throw e;
        }
        progress(pkg, 1, sounds.size() - 1, 1);
        List<String> warnings = new ArrayList<>();
        JSONArray w = created.json.optJSONArray("warnings");
        if (w != null) for (int i = 0; i < w.length(); i++) warnings.add(w.optString(i));
        String expiresAt = created.json.optString("expires_at", "");
        return new Delivery(this, packageId, warnings, expiresAt.isEmpty() ? null : expiresAt);
    }

    static String encode(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    // One file, started again when the connection breaks or the server answers 5xx: the server
    // cannot resume an upload. After a connection broke without a word (a phone that switches from
    // Wi-Fi to 4G), the server still holds the first upload until it gives up on it, after about a
    // minute; until then it answers 409. Those are waited out too.
    private void uploadFile(String path, Sound s, String token, Http.Progress share, Job job) throws La2lException {
        long[] delays = {1000, 2000, 4000};
        long[] busyDelays = {5000, 10000, 20000, 40000};
        int tries = 0;
        int busyTries = 0;
        for (;;) {
            share.share(0);
            Http.Answer answer = null;
            La2lException failure = null;
            try {
                answer = http.upload(path, token, s, share, job);
            } catch (La2lException e) {
                if (e.getCode() == La2lException.Code.ABORTED) throw e;
                failure = e;
            }
            if (answer != null && answer.status == 200) return;
            // "The file arrived damaged" is worth one more try too.
            boolean damaged = answer != null && answer.status == 422 && answer.json.optString("error", "").contains("arrived damaged");
            boolean busy = answer != null && answer.status == 409;
            if (busy && busyTries < busyDelays.length) {
                job.sleep(busyDelays[busyTries++]);
                continue;
            }
            if ((failure != null || (answer != null && answer.status >= 500) || damaged) && tries < delays.length) {
                job.sleep(delays[tries++]);
                continue;
            }
            if (failure != null) throw failure;
            if (busy || damaged) throw new La2lException(La2lException.Code.NETWORK, answer.text(), answer.status, -1);
            if (answer.status == 422) throw new La2lException(La2lException.Code.BAD_WAV, answer.text(), 422, -1);
            if (answer.status == 404) throw new La2lException(La2lException.Code.EXPIRED, answer.text(), 404, -1);
            throw fail(answer, La2lException.Code.BAD_PACKAGE);
        }
    }
}
