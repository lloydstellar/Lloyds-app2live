package nl.lloydstellar.la2l;

// A call that the app may stop: by cancelling its future, or the coroutine that waits for it.
// The work looks at it between steps, and between the pieces of an upload.
final class Job {
    private volatile boolean cancelled;

    void cancel() {
        cancelled = true;
    }

    void check() throws La2lException {
        if (cancelled) throw aborted();
    }

    /** Waits, or stops with ABORTED as soon as the job is cancelled. */
    void sleep(long ms) throws La2lException {
        long until = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < until) {
            check();
            try {
                Thread.sleep(Math.min(100, Math.max(1, until - System.currentTimeMillis())));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw aborted();
            }
        }
        check();
    }

    static La2lException aborted() {
        return new La2lException(La2lException.Code.ABORTED, "Stopped.");
    }
}
