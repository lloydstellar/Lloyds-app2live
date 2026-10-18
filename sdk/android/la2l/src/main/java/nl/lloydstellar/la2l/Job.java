package nl.lloydstellar.la2l;

import java.net.HttpURLConnection;

// A call that the app may stop: by cancelling its future, or the coroutine that waits for it.
// Cancelling closes the connection the call has open, so a read or write that waits for the
// network ends at once, and wakes a call that waits before it tries again.
final class Job {
    private volatile boolean cancelled;
    private HttpURLConnection connection;

    void cancel() {
        HttpURLConnection open;
        synchronized (this) {
            cancelled = true;
            open = connection;
            notifyAll();
        }
        if (open != null) open.disconnect();
    }

    boolean isCancelled() {
        return cancelled;
    }

    /** The connection the call has open now; a cancel closes it. */
    void attach(HttpURLConnection c) {
        boolean stop;
        synchronized (this) {
            connection = c;
            stop = cancelled;
        }
        if (stop) c.disconnect();
    }

    synchronized void detach() {
        connection = null;
    }

    void check() throws La2lException {
        if (cancelled) throw aborted();
    }

    /** Waits, or stops with ABORTED as soon as the job is cancelled. */
    void sleep(long ms) throws La2lException {
        long until = System.currentTimeMillis() + ms;
        synchronized (this) {
            long left;
            while (!cancelled && (left = until - System.currentTimeMillis()) > 0) {
                try {
                    wait(left);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw aborted();
                }
            }
        }
        check();
    }

    static La2lException aborted() {
        return new La2lException(La2lException.Code.ABORTED, "Stopped.");
    }
}
