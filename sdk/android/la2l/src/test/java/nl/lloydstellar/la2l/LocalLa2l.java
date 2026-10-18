package nl.lloydstellar.la2l;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// la2l-server from this repository on 127.0.0.1, with a fresh data folder and no rate limits, and
// the test receiver of the web SDK (npx la2l test-receiver) paired to it as LA2L in Live would
// be. Needs Node.js 22 or newer, and a build of sdk/js (npm run build there); CI has both.
final class LocalLa2l implements AutoCloseable {
    /** The address for the client's server option. */
    final String api;
    /** The code the test receiver shows, as LA2L in Live would. */
    String code;
    private final File folder;
    private final List<String> serverLines = new ArrayList<>();
    private final List<String> receiverLines = new ArrayList<>();
    private Process server;
    private Process receiver;

    private LocalLa2l(File folder, int port) {
        this.folder = folder;
        this.api = "http://127.0.0.1:" + port + "/api";
    }

    static LocalLa2l start() throws Exception {
        File folder = Files.createTempDirectory("la2l-android-").toFile();
        int port;
        try (ServerSocket s = new ServerSocket(0)) {
            port = s.getLocalPort();
        }
        LocalLa2l l = new LocalLa2l(folder, port);
        try {
            ProcessBuilder sb = new ProcessBuilder("node", "--disable-warning=ExperimentalWarning", Repo.file("server/src/main.js").getPath());
            sb.environment().put("PORT", String.valueOf(port));
            sb.environment().put("HOST", "127.0.0.1");
            sb.environment().put("DATA_DIR", new File(folder, "data").getPath());
            sb.environment().put("RATE_LIMITS", "off");
            sb.environment().put("TRUST_PROXY", "0");
            sb.redirectErrorStream(true);
            l.server = sb.start();
            read(l.server, l.serverLines);
            waitFor(l.serverLines, Pattern.compile("listening on"), 20000);

            ProcessBuilder rb = new ProcessBuilder("node", Repo.file("sdk/js/dist/cli/main.js").getPath(), "test-receiver", "--server", l.api);
            rb.environment().put("LA2L_CONFIG_DIR", new File(folder, "config").getPath());
            rb.redirectErrorStream(true);
            l.receiver = rb.start();
            read(l.receiver, l.receiverLines);
            Matcher m = Pattern.compile("pair with code ([A-Z0-9]{3} [A-Z0-9]{3})").matcher(waitFor(l.receiverLines, Pattern.compile("pair with code"), 20000));
            if (!m.find()) throw new IllegalStateException("No code from the test receiver: " + l.receiverLines);
            l.code = m.group(1);
            return l;
        } catch (Exception e) {
            l.close();
            throw e;
        }
    }

    /** A line of the test receiver's report, as soon as it is there. */
    String report(String pattern) throws InterruptedException {
        return waitFor(receiverLines, Pattern.compile(pattern), 30000);
    }

    /** A line of the server's log, as soon as it is there. */
    String log(String pattern) throws InterruptedException {
        return waitFor(serverLines, Pattern.compile(pattern), 10000);
    }

    private static void read(final Process p, final List<String> into) {
        Thread t = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    synchronized (into) {
                        into.add(line);
                        into.notifyAll();
                    }
                }
            } catch (Exception e) {
                // the process ended
            }
        });
        t.setDaemon(true);
        t.start();
    }

    // The first line that matches, waiting for it at most `ms`.
    private static String waitFor(List<String> lines, Pattern pattern, long ms) throws InterruptedException {
        long until = System.currentTimeMillis() + ms;
        synchronized (lines) {
            for (;;) {
                for (String line : lines) if (pattern.matcher(line).find()) return line;
                long left = until - System.currentTimeMillis();
                if (left <= 0) throw new IllegalStateException("No line like " + pattern + " in " + lines);
                lines.wait(left);
            }
        }
    }

    @Override
    public void close() {
        if (receiver != null) receiver.destroy();
        if (server != null) server.destroy();
        deleteAll(folder);
    }

    private static void deleteAll(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteAll(c);
        f.delete();
    }
}
