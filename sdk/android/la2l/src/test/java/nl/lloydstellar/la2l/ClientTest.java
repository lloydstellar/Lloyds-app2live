package nl.lloydstellar.la2l;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

// The client against the real server of this repository, with the test receiver of the web SDK
// as LA2L in Live: pairing, sending a loop and a one-shot into "Live", the checks before anything
// goes out, following and taking back a package, and unpairing.
public class ClientTest {
    private static <T> T get(CompletableFuture<T> future) throws Exception {
        try {
            return future.get(90, TimeUnit.SECONDS);
        } catch (java.util.concurrent.ExecutionException e) {
            throw La2l.unwrap(e);
        }
    }

    private static La2lException refused(CompletableFuture<?> future) throws Exception {
        try {
            get(future);
        } catch (La2lException e) {
            return e;
        }
        fail("expected a La2lException");
        return null;
    }

    // One bar of 4/4 at 120 BPM, stereo: exactly 2 seconds.
    private static byte[] bar() {
        short[] samples = new short[96000 * 2];
        for (int i = 0; i < samples.length; i += 2) {
            short v = (short) ((i / 2) % 24000 < 2400 ? Math.round(Math.sin(i / 16.0) * 20000) : 0);
            samples[i] = v;
            samples[i + 1] = v;
        }
        return Wav.fromPcm16(samples, 48000, 2);
    }

    @Test
    public void pairsSendsIntoLiveFollowsAndUnpairs() throws Exception {
        try (LocalLa2l local = LocalLa2l.start()) {
            La2l la2l = new La2l(new La2l.Options("Java test").server(local.api).storage(Storage.memory()).appVersion("1.2.3"));
            assertFalse(la2l.isPaired());
            assertEquals(La2lException.Code.NOT_PAIRED, refused(la2l.meAsync()).getCode());

            // A code that cannot be one is refused here; one the server does not know, by the server.
            La2lException e = refused(la2l.pairAsync("K7P"));
            assertEquals(La2lException.Code.BAD_CODE, e.getCode());
            assertEquals("A code has 6 letters and digits, like K7P 42Q.", e.getMessage());
            e = refused(la2l.pairAsync("aaa-aaa"));
            assertEquals(La2lException.Code.BAD_CODE, e.getCode());
            assertEquals("This code does not work. Check the code in Live.", e.getMessage());
            assertEquals(404, e.getStatus());

            assertEquals("Test receiver", get(la2l.pairAsync(local.code.toLowerCase())));
            assertTrue(la2l.isPaired());
            assertEquals("Test receiver", la2l.getDeviceName());
            assertEquals("Test receiver", get(la2l.meAsync()).deviceName);
            assertEquals("Java test", get(la2l.meAsync()).appName);

            // What LA2L cannot use is refused before anything goes out, with LA2L's own words.
            e = refused(la2l.sendAsync(new SoundPackage("Bad").add(Sound.loop("Broken", new byte[10]))));
            assertEquals(La2lException.Code.BAD_WAV, e.getCode());
            assertEquals("Broken is not a usable WAV: The file is too short to be a WAV file.", e.getMessage());
            SoundPackage many = new SoundPackage("Many");
            for (int i = 0; i < 33; i++) many.add(Sound.oneShot("Hit " + i, Wav.fromFloat(new float[480], 48000, 1)));
            e = refused(la2l.sendAsync(many));
            assertEquals(La2lException.Code.BAD_PACKAGE, e.getCode());
            assertEquals("The package has 33 sounds. LA2L takes 32 at most. Send them in more packages.", e.getMessage());
            e = refused(la2l.sendAsync(new SoundPackage("Slow").bpm(5).add(Sound.loop("Beat", bar()))));
            assertEquals(La2lException.Code.BAD_PACKAGE, e.getCode());

            // A loop and a one-shot, into "Live".
            final List<Double> shares = new ArrayList<>();
            SoundPackage pkg = new SoundPackage("Java beat").bpm(120)
                .add(Sound.loop("Beat", bar()).role(Role.DRUMS).lengthBeats(4))
                .add(Sound.oneShot("Hit", Wav.fromFloat(new float[4800], 48000, 1)).role(Role.FX))
                .onProgress((share, sound, soundShare) -> {
                    synchronized (shares) {
                        shares.add(share);
                    }
                });
            Delivery delivery = get(la2l.sendAsync(pkg));
            assertTrue(delivery.getPackageId().length() > 10);
            assertEquals(new ArrayList<String>(), delivery.getWarnings());
            DeliveryStatus st = get(delivery.importedAsync());
            assertEquals("imported", st.status);
            assertEquals(2, st.sounds.size());
            assertEquals("Beat", st.sounds.get(0).name);
            assertEquals("imported", st.sounds.get(1).status);
            local.report("Java beat \\(Java test\\): imported 2 of 2 sounds");
            local.report("Beat \\(Java test\\): loop, warped in Beats mode at 120 BPM, 4 beats\\. 48 kHz, 16-bit, stereo, 2 s");
            local.report("Hit \\(Java test\\): one-shot, plays as it is\\. 48 kHz, 32-bit float, mono, 0\\.1 s");
            synchronized (shares) {
                assertEquals(1.0, shares.get(shares.size() - 1), 0);
            }
            // The server knows which SDK and app sent it.
            local.log("client=\"la2l-android/" + La2l.VERSION + " \\(Java test\\)\"");
            assertEquals("imported", get(la2l.delivery(delivery.getPackageId()).statusAsync()).status);

            // A package taken back before Import is gone; one the server does not know counts as expired.
            Delivery back = get(la2l.sendAsync(new SoundPackage("Back").add(Sound.oneShot("Hit", Wav.fromFloat(new float[4800], 48000, 1)))));
            try {
                get(back.cancelAsync());
            } catch (La2lException x) {
                // The test receiver looks every 3 seconds; it may just have taken it into "Live".
                assertEquals("This package is already in Live.", x.getMessage());
            }
            assertEquals("expired", get(la2l.delivery("no-such-package").statusAsync()).status);

            // Unpaired: the server revokes the token, and the app is asked for a code again.
            get(la2l.unpairAsync());
            assertFalse(la2l.isPaired());
            assertEquals(La2lException.Code.NOT_PAIRED, refused(la2l.meAsync()).getCode());
        }
    }

    @Test
    public void onlyHttpsLeavesThisComputer() {
        try {
            new La2l(new La2l.Options("x").server("http://lloydstellar.nl/la2l/api"));
            fail("plain http to another computer");
        } catch (IllegalArgumentException e) {
            assertEquals("Use https for http://lloydstellar.nl/la2l/api: plain http works for localhost only.", e.getMessage());
        }
        assertEquals("http://127.0.0.1:8787/api", new La2l(new La2l.Options("x").server("http://127.0.0.1:8787/api/")).getServer());
        assertEquals(La2l.DEFAULT_SERVER, new La2l(new La2l.Options("x")).getServer());
        assertEquals("Erik%E2%80%99s Beats", Http.headerValue("Erik’s Beats"));
    }
}
