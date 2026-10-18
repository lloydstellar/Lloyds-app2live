package nl.lloydstellar.la2l;

/**
 * Everything la2l can refuse or run into, so an app needs one catch. The message is a short text
 * in plain English that the app can show to the user as it is, mostly the server's own.
 */
public final class La2lException extends Exception {

    /** What went wrong, for an app to switch on. */
    public enum Code {
        /** No token, or the server no longer knows it: show the field for the code again. */
        NOT_PAIRED,
        /** The pairing code does not work. */
        BAD_CODE,
        /** Too many calls: wait {@link #getRetryAfter()} seconds. */
        RATE_LIMITED,
        /** The server or this computer has no room: try later, or Import in Live first. */
        SERVER_FULL,
        /** The server or LA2L would refuse the package as a whole. */
        BAD_PACKAGE,
        /** A file is not a WAV file that Live can use. */
        BAD_WAV,
        /** The package is gone: it expired, or it was not uploaded in time. */
        EXPIRED,
        /** LA2L in Live could not import the package; it stays, and the next Import tries again. */
        IMPORT_FAILED,
        /** The server could not be reached, or the connection broke off. */
        NETWORK,
        /** The app stopped it, by cancelling the future or the coroutine. */
        ABORTED,
        /** Any other answer from the server. */
        SERVER
    }

    private final Code code;
    private final int status;
    private final int retryAfter;

    public La2lException(Code code, String message) {
        this(code, message, 0, -1);
    }

    public La2lException(Code code, String message, int status, int retryAfter) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
    }

    public Code getCode() {
        return code;
    }

    /** The HTTP status of the server's answer, or 0 when there was none. */
    public int getStatus() {
        return status;
    }

    /** Seconds to wait before trying again, from Retry-After, or -1. */
    public int getRetryAfter() {
        return retryAfter;
    }
}
