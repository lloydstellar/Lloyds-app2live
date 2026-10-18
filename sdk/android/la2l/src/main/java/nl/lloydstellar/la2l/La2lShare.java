package nl.lloydstellar.la2l;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Sounds for LA2L Sender, the installed web app of LA2L, through the share menu: no network code
 * and no pairing in the app. The WAV files go as files, their description (app2live/1) as the
 * text of the share, so LA2L Sender knows loop or one-shot, BPM and role. Android only passes on
 * the files, the title and the text of a share; LA2L Sender reads the description from the text.
 *
 * <pre>
 * Intent share = La2lShare.intent(context, new SoundPackage("Treinbeat").bpm(92)
 *     .add(Sound.loop("Kick", kickWav).role(Role.DRUMS)));
 * context.startActivity(Intent.createChooser(share, "Send to Live"));
 * </pre>
 */
public final class La2lShare {
    private La2lShare() {}

    static final String FOLDER = "la2l-share";
    private static final long KEEP_MS = 24 * 3600 * 1000L;

    /** The authority of the provider la2l adds to the app: <applicationId>.la2l.files. */
    static String authority(Context context) {
        return context.getPackageName() + ".la2l.files";
    }

    /**
     * A share intent with copies of the WAV files, readable by the app the user picks, and the
     * description in EXTRA_TEXT. Checks every file first, as a send would.
     */
    public static Intent intent(Context context, SoundPackage pkg) throws La2lException, IOException {
        if (pkg == null || pkg.sounds.isEmpty()) throw new La2lException(La2lException.Code.BAD_PACKAGE, "The package has no sounds.");
        File base = new File(context.getCacheDir(), FOLDER);
        clean(base);
        File folder = new File(base, UUID.randomUUID().toString());
        if (!folder.mkdirs()) throw new IOException("Cannot make " + folder);
        List<String> names = new ArrayList<>();
        Set<String> taken = new HashSet<>();
        ArrayList<Uri> uris = new ArrayList<>();
        for (int i = 0; i < pkg.sounds.size(); i++) {
            Sound s = pkg.sounds.get(i);
            String label = s.name != null && !s.name.trim().isEmpty() ? s.name.trim() : "Sound " + (i + 1);
            try {
                if (s.file != null) WavCheck.check(s.file);
                else WavCheck.check(s.bytes);
            } catch (La2lException e) {
                throw new La2lException(La2lException.Code.BAD_WAV, label + " is not a usable WAV: " + e.getMessage());
            }
            String name = s.fileName != null ? s.fileName : La2l.fileName(s.file != null ? s.file.getName() : label, i, taken);
            names.add(name);
            File copy = new File(folder, name);
            try (OutputStream out = new FileOutputStream(copy)) {
                if (s.bytes != null) out.write(s.bytes);
                else {
                    try (InputStream in = new java.io.FileInputStream(s.file)) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    }
                }
            }
            uris.add(new Uri.Builder().scheme("content").authority(authority(context)).appendPath(folder.getName()).appendPath(name).build());
        }
        Intent intent = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE);
        intent.setType("audio/wav");
        if (uris.size() == 1) intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
        else intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        intent.putExtra(Intent.EXTRA_TEXT, text(pkg, names));
        if (pkg.title != null) intent.putExtra(Intent.EXTRA_SUBJECT, pkg.title);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }

    /**
     * The description LA2L Sender reads from the text of a share: app2live/1 without bytes and
     * sha256, which LA2L Sender fills in itself (docs/manifest.md, "Sharing to LA2L Sender").
     */
    public static String text(SoundPackage pkg, List<String> fileNames) {
        JSONArray items = new JSONArray();
        for (int i = 0; i < pkg.sounds.size(); i++) {
            Sound s = pkg.sounds.get(i);
            items.put(La2l.json(
                "file", fileNames.get(i),
                "name", s.name,
                "kind", s.kind.value(),
                "role", s.role != null ? s.role.value() : null,
                "bpm", s.bpm,
                "length_beats", s.lengthBeats,
                "warp_mode", s.warpMode,
                "color", s.color,
                "gain_db", s.gainDb,
                "id", s.id));
        }
        JSONObject tempo = new JSONObject();
        try {
            if (pkg.bpm != null) tempo.put("bpm", (double) pkg.bpm);
        } catch (JSONException e) {
            throw new IllegalArgumentException("The BPM is not a number.");
        }
        return La2l.json("schema", ManifestCheck.SCHEMA, "title", pkg.title, "tempo", tempo.length() > 0 ? tempo : null, "items", items).toString();
    }

    // Shares older than a day go: the app the user picked has read them by then.
    private static void clean(File base) {
        File[] old = base.listFiles();
        if (old == null) return;
        long now = System.currentTimeMillis();
        for (File folder : old) {
            if (now - folder.lastModified() < KEEP_MS) continue;
            File[] files = folder.listFiles();
            if (files != null) for (File f : files) f.delete();
            folder.delete();
        }
    }
}
