package nl.lloydstellar.la2l;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

// The calls to the LA2L server, as the web SDK makes them (sdk/js/src/http.ts): JSON with a time
// limit and the X-LA2L-Client header, retries for a broken connection and a 5xx, a short wait
// after a 429, and uploads with progress.
final class Http {
    static final String DEFAULT_SERVER = "https://lloydstellar.nl/la2l/api";
    private static final int CONNECT_MS = 15000;
    private static final int JSON_MS = 30000;
    private static final int UPLOAD_ANSWER_MS = 120000;
    // A 429 that asks for a short wait is waited out; a longer one becomes a RATE_LIMITED error.
    private static final int MAX_WAIT_S = 60;
    private static final long[] RETRY_DELAYS_MS = {1000, 2000, 4000};

    enum Retry {
        /** Not again: only a 429 is waited out. */
        NONE,
        /** Again after 1, 2 and 4 seconds when the connection breaks or the server answers 5xx. */
        ALL,
        /** Only after a 5xx, for a call that must not run twice when its answer got lost. */
        SERVER_ERRORS
    }

    /** An answer: the status, the JSON body (empty when there is none) and Retry-After (-1 without). */
    static final class Answer {
        final int status;
        final JSONObject json;
        final int retryAfter;

        Answer(int status, JSONObject json, int retryAfter) {
            this.status = status;
            this.json = json;
            this.retryAfter = retryAfter;
        }

        /** The server's text from an error answer, or a line that says what happened. */
        String text() {
            String text = json.optString("error", "");
            return text.isEmpty() ? "The LA2L server answered " + status + "." : text;
        }
    }

    interface Progress {
        void share(double part);
    }

    final String server;
    private final String client;

    Http(String server, String client) {
        this.server = server;
        this.client = client;
    }

    static La2lException unreachable() {
        return new La2lException(La2lException.Code.NETWORK, "The LA2L server could not be reached. Check the internet connection.");
    }

    static La2lException tooSlow() {
        return new La2lException(La2lException.Code.NETWORK, "The LA2L server did not answer in time.");
    }

    /**
     * "https://x.nl/la2l/api/" to an address without the last "/". Plain http only for this
     * computer, as the device allows it: the token must not travel in clear text over a network.
     */
    static String serverAddress(String server) {
        String text = (server == null || server.trim().isEmpty() ? DEFAULT_SERVER : server).trim();
        URI uri;
        try {
            uri = new URI(text);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("Not a server address: " + text);
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(java.util.Locale.ROOT);
        String host = uri.getHost() == null ? "" : uri.getHost();
        if (scheme.equals("http") && !(host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]") || host.equals("::1"))) {
            throw new IllegalArgumentException("Use https for " + text + ": plain http works for localhost only.");
        }
        if (!scheme.equals("https") && !scheme.equals("http") || host.isEmpty()) throw new IllegalArgumentException("Not a server address: " + text);
        return text.replaceAll("/+$", "");
    }

    /**
     * A value an HTTP header can carry: printable ASCII as it is, every other character
     * percent-encoded, so "Erik’s Beats" or "Битмейкер" never make a call fail.
     */
    static String headerValue(String text) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            String ch = new String(Character.toChars(cp));
            if (cp >= 0x20 && cp <= 0x7e) out.append(ch);
            else {
                try {
                    out.append(URLEncoder.encode(ch, "UTF-8"));
                } catch (UnsupportedEncodingException e) {
                    throw new IllegalStateException(e);
                }
            }
            i += Character.charCount(cp);
        }
        return out.length() > 200 ? out.substring(0, 200) : out.toString();
    }

    private static int retryAfterOf(String value) {
        if (value == null) return -1;
        try {
            double n = Double.parseDouble(value.trim());
            return n >= 0 && !Double.isInfinite(n) ? (int) Math.ceil(n) : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private HttpURLConnection open(String method, String path, String token) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(server + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(CONNECT_MS);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("X-LA2L-Client", client);
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    // The answer of a connection: its status, its JSON object or {}, and Retry-After.
    private static Answer answerOf(HttpURLConnection c) throws IOException {
        int status = c.getResponseCode();
        InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
        String text = "";
        if (in != null) {
            try (InputStream body = in) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                // An answer of the server is small; more than 1 MB is not one of its answers.
                while ((n = body.read(buf)) > 0 && out.size() <= 1048576) out.write(buf, 0, n);
                text = new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
        }
        JSONObject json = new JSONObject();
        try {
            Object v = new JSONTokener(text).nextValue();
            if (v instanceof JSONObject) json = (JSONObject) v;
        } catch (JSONException e) {
            // no JSON body
        }
        return new Answer(status, json, retryAfterOf(c.getHeaderField("Retry-After")));
    }

    // One exchange. An exception when no answer came.
    private Answer once(String method, String path, JSONObject body, String token, Job job) throws La2lException {
        job.check();
        HttpURLConnection c = null;
        try {
            c = open(method, path, token);
            c.setReadTimeout(JSON_MS);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(bytes);
                }
            }
            return answerOf(c);
        } catch (SocketTimeoutException e) {
            throw tooSlow();
        } catch (IOException e) {
            job.check();
            throw unreachable();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** A JSON call. Returns the answer, whatever its status; throws only when none came. */
    Answer call(String method, String path, JSONObject body, String token, Retry retry, Job job) throws La2lException {
        int waits = 0;
        for (int attempt = 0; ; attempt++) {
            Answer answer = null;
            La2lException failure = null;
            try {
                answer = once(method, path, body, token, job);
            } catch (La2lException e) {
                if (e.getCode() == La2lException.Code.ABORTED) throw e;
                failure = e;
            }
            if (answer != null && answer.status == 429 && answer.retryAfter >= 0 && answer.retryAfter <= MAX_WAIT_S && waits < 2) {
                waits++;
                job.sleep(answer.retryAfter * 1000L);
                attempt--;
                continue;
            }
            boolean broken = failure != null && retry == Retry.ALL;
            boolean again = retry != Retry.NONE && attempt < RETRY_DELAYS_MS.length && (broken || (answer != null && answer.status >= 500));
            if (!again) {
                if (failure != null) throw failure;
                return answer;
            }
            job.sleep(RETRY_DELAYS_MS[attempt]);
        }
    }

    /** One file to the server, in pieces, with its progress. Returns the answer; throws when none came. */
    Answer upload(String path, String token, Sound sound, Progress progress, Job job) throws La2lException {
        job.check();
        HttpURLConnection c = null;
        long size = sound.size();
        try {
            c = open("PUT", path, token);
            c.setReadTimeout(UPLOAD_ANSWER_MS);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "audio/wav");
            c.setFixedLengthStreamingMode(size);
            try (InputStream in = sound.file != null ? new FileInputStream(sound.file) : new java.io.ByteArrayInputStream(sound.bytes);
                 OutputStream out = c.getOutputStream()) {
                byte[] buf = new byte[65536];
                long sent = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    job.check();
                    out.write(buf, 0, n);
                    sent += n;
                    progress.share(size > 0 ? (double) sent / size : 1);
                }
            }
            return answerOf(c);
        } catch (SocketTimeoutException e) {
            throw tooSlow();
        } catch (IOException e) {
            job.check();
            throw new La2lException(La2lException.Code.NETWORK, "The upload broke off. Check the internet connection.");
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
