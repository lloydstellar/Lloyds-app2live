package nl.lloydstellar.la2l;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

// The client against a server that misbehaves on purpose, as the web SDK's tests do it: a 5xx
// is tried again, a 409 during an upload is waited out, "arrived damaged" gets one more try, a
// short 429 is waited out, a 401 forgets the token, and cancelling stops an upload under way.
public class FaultyServerTest {
    // A small HTTP server on a socket: one request per connection, answered with JSON. Android's
    // unit tests compile against android.jar, which has no HTTP server of the JDK.
    private static final class Answer {
        final int status;
        final String json;
        final String[] headers;

        Answer(int status, String json, String... headers) {
            this.status = status;
            this.json = json;
            this.headers = headers;
        }
    }

    private interface Handler {
        Answer handle(String call, java.util.Map<String, String> headers, byte[] body) throws Exception;
    }

    private ServerSocket socket;
    private final List<String> calls = Collections.synchronizedList(new ArrayList<String>());
    private final List<String> clients = Collections.synchronizedList(new ArrayList<String>());
    private volatile byte[] uploaded;
    private int creates;
    private int puts;
    private int statuses;
    private volatile boolean stallUploads;

    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) >= 0 && b != '\n') if (b != '\r') out.write(b);
        return out.toString("UTF-8");
    }

    private void serve(Socket c, Handler handler) {
        try (Socket client = c) {
            InputStream in = new java.io.BufferedInputStream(client.getInputStream());
            String[] request = line(in).split(" ");
            java.util.Map<String, String> headers = new java.util.HashMap<>();
            for (String h; !(h = line(in)).isEmpty(); ) {
                int colon = h.indexOf(':');
                if (colon > 0) headers.put(h.substring(0, colon).trim().toLowerCase(java.util.Locale.ROOT), h.substring(colon + 1).trim());
            }
            int length = headers.containsKey("content-length") ? Integer.parseInt(headers.get("content-length")) : 0;
            byte[] body = new byte[length];
            for (int done = 0; done < length; ) {
                int n = in.read(body, done, length - done);
                if (n < 0) break;
                done += n;
            }
            Answer a = handler.handle(request[0] + " " + request[1].replaceFirst("^/api", ""), headers, body);
            byte[] json = a.json.getBytes(StandardCharsets.UTF_8);
            StringBuilder head = new StringBuilder("HTTP/1.1 " + a.status + " X\r\nContent-Type: application/json\r\nContent-Length: " + json.length + "\r\nConnection: close\r\n");
            for (int i = 0; i < a.headers.length; i += 2) head.append(a.headers[i]).append(": ").append(a.headers[i + 1]).append("\r\n");
            OutputStream out = client.getOutputStream();
            out.write(head.append("\r\n").toString().getBytes(StandardCharsets.UTF_8));
            out.write(json);
            out.flush();
        } catch (Exception e) {
            // the client went away
        }
    }

    @Before
    public void start() throws IOException {
        socket = new ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"));
        Handler handler = (call, headers, body) -> {
            calls.add(call);
            clients.add(headers.get("x-la2l-client"));
            if (stallUploads && call.startsWith("PUT ")) {
                Thread.sleep(20000); // a link that stalls: no answer for 20 seconds
                return new Answer(500, "{}");
            }
            synchronized (this) {
                if (call.equals("POST /pair/claim")) return new Answer(200, "{\"app_token\":\"la2la_test\",\"device_name\":\"STUDIO-PC\"}");
                if (call.equals("POST /packages")) {
                    if (creates++ == 0) return new Answer(503, "{\"error\":\"The server has a problem. Try again later.\"}");
                    return new Answer(201, "{\"package_id\":\"p1\",\"upload\":{\"loop.wav\":\"/packages/p1/files/loop.wav\"},\"warnings\":[]}");
                }
                if (call.startsWith("PUT /packages/p1/files/")) {
                    if (puts++ == 0) return new Answer(409, "{\"error\":\"This file is being uploaded already.\"}");
                    if (puts == 2) return new Answer(422, "{\"error\":\"The file arrived damaged. Send it again.\"}");
                    uploaded = body;
                    return new Answer(200, "{\"ok\":true}");
                }
                if (call.equals("POST /packages/p1/commit")) return new Answer(200, "{\"ok\":true,\"status\":\"waiting\"}");
                if (call.equals("GET /packages/p1/status")) {
                    if (statuses++ == 0) return new Answer(429, "{\"error\":\"Too many requests. Wait a minute.\"}", "Retry-After", "1");
                    return new Answer(200, "{\"status\":\"imported\",\"items\":[{\"id\":\"sound-1\",\"name\":\"Loop\",\"status\":\"imported\"}]}");
                }
                if (call.equals("DELETE /packages/p1")) return new Answer(200, "{\"ok\":true}");
                if (call.equals("GET /app/me")) return new Answer(401, "{\"error\":\"This app is not paired any more.\"}");
                return new Answer(404, "{\"error\":\"Not found.\"}");
            }
        };
        Thread accept = new Thread(() -> {
            while (!socket.isClosed()) {
                try {
                    Socket c = socket.accept();
                    Thread t = new Thread(() -> serve(c, handler));
                    t.setDaemon(true);
                    t.start();
                } catch (IOException e) {
                    return;
                }
            }
        });
        accept.setDaemon(true);
        accept.start();
    }

    @After
    public void stop() throws IOException {
        socket.close();
    }

    private La2l client() throws Exception {
        La2l la2l = new La2l(new La2l.Options("Faulty test").server("http://127.0.0.1:" + socket.getLocalPort() + "/api").storage(Storage.memory()));
        assertEquals("STUDIO-PC", la2l.pairAsync("K7P 42Q").get(10, TimeUnit.SECONDS));
        return la2l;
    }

    private static File loopFile() throws IOException {
        File file = File.createTempFile("la2l-loop", ".wav");
        file.deleteOnExit();
        return Wav.fromPcm16(new short[48000 * 2], 48000, 2, file);
    }

    @Test
    public void retriesWaitsAndForgetsAsTheWebClientDoes() throws Exception {
        La2l la2l = client();
        File file = loopFile();
        // A sound from a file: hashed and uploaded from disk.
        Delivery delivery = la2l.sendAsync(new SoundPackage("Faulty").bpm(120).add(Sound.loop("Loop", file).fileName("loop.wav"))).get(60, TimeUnit.SECONDS);
        assertEquals("p1", delivery.getPackageId());
        assertArrayEquals(Files.readAllBytes(file.toPath()), uploaded);
        // The 503 tried again; the 409 waited out; "arrived damaged" sent once more.
        assertEquals(java.util.Arrays.asList("POST /pair/claim", "POST /packages", "POST /packages", "PUT /packages/p1/files/loop.wav", "PUT /packages/p1/files/loop.wav", "PUT /packages/p1/files/loop.wav", "POST /packages/p1/commit"), new ArrayList<>(calls));
        for (String c : clients) assertEquals("la2l-android/" + La2l.VERSION + " (Faulty test)", c);
        // A 429 of one second is waited out.
        assertEquals("imported", delivery.importedAsync().get(30, TimeUnit.SECONDS).status);
        // A 401: the token is forgotten, and the app is told to pair again.
        try {
            la2l.meAsync().get(10, TimeUnit.SECONDS);
            fail("a 401 is NOT_PAIRED");
        } catch (java.util.concurrent.ExecutionException e) {
            La2lException x = La2l.unwrap(e);
            assertEquals(La2lException.Code.NOT_PAIRED, x.getCode());
            assertEquals("This app is not paired any more.", x.getMessage());
        }
        assertFalse(la2l.isPaired());
    }

    @Test
    public void cancellingStopsAnUploadUnderWayAndTakesThePackageBack() throws Exception {
        La2l la2l = client();
        stallUploads = true;
        synchronized (this) {
            creates = 1; // no 503 this time
        }
        CompletableFuture<Delivery> sending = la2l.sendAsync(new SoundPackage("Stalled").add(Sound.loop("Loop", loopFile()).fileName("loop.wav")));
        long until = System.currentTimeMillis() + 10000;
        while (!calls.contains("PUT /packages/p1/files/loop.wav") && System.currentTimeMillis() < until) Thread.sleep(20);
        assertTrue("the upload started", calls.contains("PUT /packages/p1/files/loop.wav"));
        long cancelled = System.currentTimeMillis();
        sending.cancel(true);
        try {
            sending.get();
            fail("cancelled");
        } catch (CancellationException e) {
            // as it should
        }
        // The worker stops at once, and takes back what it announced.
        until = System.currentTimeMillis() + 5000;
        while (!calls.contains("DELETE /packages/p1") && System.currentTimeMillis() < until) Thread.sleep(20);
        assertTrue("the package is taken back", calls.contains("DELETE /packages/p1"));
        assertTrue("within seconds, not after the server's 20", System.currentTimeMillis() - cancelled < 5000);
    }

    @Test
    public void aCancelledCallbackCallReportsNothing() throws Exception {
        La2l la2l = client();
        stallUploads = true;
        final List<String> reported = Collections.synchronizedList(new ArrayList<String>());
        CompletableFuture<Delivery> call = la2l.send(new SoundPackage("Quiet").add(Sound.loop("Loop", loopFile()).fileName("loop.wav")), new Callback<Delivery>() {
            @Override
            public void onSuccess(Delivery value) {
                reported.add("success");
            }

            @Override
            public void onError(La2lException error) {
                reported.add(error.getCode().name());
            }
        });
        Thread.sleep(300);
        call.cancel(true);
        Thread.sleep(500);
        assertEquals(new ArrayList<String>(), new ArrayList<>(reported));
    }
}
