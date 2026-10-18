package nl.lloydstellar.la2l;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
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
    private HttpServer server;
    private final List<String> calls = Collections.synchronizedList(new ArrayList<String>());
    private final List<String> clients = Collections.synchronizedList(new ArrayList<String>());
    private volatile byte[] uploaded;
    private int creates;
    private int puts;
    private int statuses;
    private volatile boolean stallUploads;

    private static void answer(HttpExchange x, int status, String json, String... headers) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        for (int i = 0; i < headers.length; i += 2) x.getResponseHeaders().add(headers[i], headers[i + 1]);
        x.getResponseHeaders().add("Content-Type", "application/json");
        x.sendResponseHeaders(status, body.length);
        try (OutputStream out = x.getResponseBody()) {
            out.write(body);
        }
    }

    private static byte[] read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    @Before
    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r);
            t.setDaemon(true);
            return t;
        }));
        server.createContext("/api", x -> {
            String call = x.getRequestMethod() + " " + x.getRequestURI().getPath().replaceFirst("^/api", "");
            calls.add(call);
            clients.add(x.getRequestHeaders().getFirst("X-LA2L-Client"));
            byte[] body = read(x.getRequestBody());
            if (stallUploads && call.startsWith("PUT ")) {
                // A link that stalls: no answer for 20 seconds.
                try {
                    Thread.sleep(20000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                answer(x, 500, "{}");
                return;
            }
            synchronized (this) {
                if (call.equals("POST /pair/claim")) answer(x, 200, "{\"app_token\":\"la2la_test\",\"device_name\":\"STUDIO-PC\"}");
                else if (call.equals("POST /packages")) {
                    if (creates++ == 0) answer(x, 503, "{\"error\":\"The server has a problem. Try again later.\"}");
                    else answer(x, 201, "{\"package_id\":\"p1\",\"upload\":{\"loop.wav\":\"/packages/p1/files/loop.wav\"},\"warnings\":[]}");
                } else if (call.startsWith("PUT /packages/p1/files/")) {
                    if (puts++ == 0) answer(x, 409, "{\"error\":\"This file is being uploaded already.\"}");
                    else if (puts == 2) answer(x, 422, "{\"error\":\"The file arrived damaged. Send it again.\"}");
                    else {
                        uploaded = body;
                        answer(x, 200, "{\"ok\":true}");
                    }
                } else if (call.equals("POST /packages/p1/commit")) answer(x, 200, "{\"ok\":true,\"status\":\"waiting\"}");
                else if (call.equals("GET /packages/p1/status")) {
                    if (statuses++ == 0) answer(x, 429, "{\"error\":\"Too many requests. Wait a minute.\"}", "Retry-After", "1");
                    else answer(x, 200, "{\"status\":\"imported\",\"items\":[{\"id\":\"sound-1\",\"name\":\"Loop\",\"status\":\"imported\"}]}");
                } else if (call.equals("DELETE /packages/p1")) answer(x, 200, "{\"ok\":true}");
                else if (call.equals("GET /app/me")) answer(x, 401, "{\"error\":\"This app is not paired any more.\"}");
                else answer(x, 404, "{\"error\":\"Not found.\"}");
            }
        });
        server.start();
    }

    @After
    public void stop() {
        server.stop(0);
    }

    private La2l client() throws Exception {
        La2l la2l = new La2l(new La2l.Options("Faulty test").server("http://127.0.0.1:" + server.getAddress().getPort() + "/api").storage(Storage.memory()));
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
