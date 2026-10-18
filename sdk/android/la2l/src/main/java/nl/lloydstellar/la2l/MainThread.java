package nl.lloydstellar.la2l;

import android.os.Handler;
import android.os.Looper;

// Callbacks and progress go to the main thread of an Android app, where the app may touch its
// views. Off Android (the JVM tests), there is no main looper: then they run where they are.
final class MainThread {
    private MainThread() {}

    static void post(Runnable r) {
        Looper main = null;
        try {
            main = Looper.getMainLooper();
        } catch (RuntimeException e) {
            // no Android here
        }
        if (main == null) {
            r.run();
            return;
        }
        if (Looper.myLooper() == main) r.run();
        else new Handler(main).post(r);
    }
}
