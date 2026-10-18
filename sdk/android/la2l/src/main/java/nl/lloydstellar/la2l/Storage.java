package nl.lloydstellar.la2l;

import android.content.Context;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Where la2l keeps the app token, the name of the computer and the app's own id. By default a
 * private file of the app that Android leaves out of its backups, so a phone restored from a
 * backup does not share the token of another; an app may pass its own, for example for tests.
 */
public interface Storage {
    String get(String key);

    void set(String key, String value);

    void remove(String key);

    /** Keeps everything in memory, for as long as the app runs. */
    static Storage memory() {
        final ConcurrentHashMap<String, String> values = new ConcurrentHashMap<>();
        return new Storage() {
            public String get(String key) {
                return values.get(key);
            }

            public void set(String key, String value) {
                values.put(key, value);
            }

            public void remove(String key) {
                values.remove(key);
            }
        };
    }

    /**
     * The file la2l.properties in the app's no-backup folder (Context.getNoBackupFilesDir): private
     * to the app, and not in Auto Backup or a transfer to a new phone.
     */
    static Storage privateFile(Context context) {
        final File file = new File(context.getApplicationContext().getNoBackupFilesDir(), "la2l.properties");
        return new Storage() {
            private Properties values;

            private Properties values() {
                if (values == null) {
                    values = new Properties();
                    if (file.isFile()) {
                        try (InputStream in = new FileInputStream(file)) {
                            values.load(in);
                        } catch (IOException e) {
                            // unreadable: as if nothing was kept
                        }
                    }
                }
                return values;
            }

            // Written next to it and renamed, so a crash never leaves half a file.
            private void save() {
                File next = new File(file.getPath() + ".new");
                try (FileOutputStream out = new FileOutputStream(next)) {
                    values().store(out, null);
                    out.getFD().sync();
                } catch (IOException e) {
                    throw new IllegalStateException("la2l cannot write " + file + ": " + e.getMessage());
                }
                if (!next.renameTo(file)) throw new IllegalStateException("la2l cannot write " + file);
            }

            public synchronized String get(String key) {
                return values().getProperty(key);
            }

            public synchronized void set(String key, String value) {
                values().setProperty(key, value);
                save();
            }

            public synchronized void remove(String key) {
                if (values().remove(key) != null) save();
            }
        };
    }
}
