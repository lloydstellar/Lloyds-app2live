package nl.lloydstellar.la2l;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Where la2l keeps the app token, the name of the computer and the app's own id. By default the
 * app's private SharedPreferences; an app may pass its own, for example for tests.
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

    /** The app's private SharedPreferences "la2l" (MODE_PRIVATE): no other app can read them. */
    static Storage sharedPreferences(Context context) {
        final SharedPreferences prefs = context.getApplicationContext().getSharedPreferences("la2l", Context.MODE_PRIVATE);
        return new Storage() {
            public String get(String key) {
                return prefs.getString(key, null);
            }

            public void set(String key, String value) {
                prefs.edit().putString(key, value).apply();
            }

            public void remove(String key) {
                prefs.edit().remove(key).apply();
            }
        };
    }
}
