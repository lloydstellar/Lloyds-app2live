package nl.lloydstellar.la2l.javaexample;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import nl.lloydstellar.la2l.Callback;
import nl.lloydstellar.la2l.Delivery;
import nl.lloydstellar.la2l.DeliveryStatus;
import nl.lloydstellar.la2l.La2l;
import nl.lloydstellar.la2l.La2lException;
import nl.lloydstellar.la2l.La2lShare;
import nl.lloydstellar.la2l.Role;
import nl.lloydstellar.la2l.Sound;
import nl.lloydstellar.la2l.SoundPackage;
import nl.lloydstellar.la2l.Wav;

// The Java example of the Android SDK: pairs with LA2L in Live and sends a tone of two bars at
// 120 BPM that it makes itself, as a loop. Or shares it with LA2L Sender, without pairing.
public class ToneActivity extends Activity {
    private La2l la2l;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        la2l = new La2l(this, "LA2L Java example");
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);
        TextView how = new TextView(this);
        how.setText("In Live, click Pair app in LA2L and type the code it shows.");
        final EditText code = new EditText(this);
        code.setHint("K7P 42Q");
        Button pair = new Button(this);
        pair.setText("Pair");
        Button send = new Button(this);
        send.setText("Send a tone to Live");
        Button share = new Button(this);
        share.setText("Share it with LA2L Sender");
        status = new TextView(this);
        root.addView(how);
        root.addView(code);
        root.addView(pair);
        root.addView(send);
        root.addView(share);
        root.addView(status);
        setContentView(root);
        if (la2l.isPaired()) status.setText("Paired with " + la2l.getDeviceName() + ".");

        pair.setOnClickListener(v -> la2l.pair(code.getText().toString(), new Callback<String>() {
            @Override
            public void onSuccess(String computer) {
                status.setText("Paired with " + computer + ".");
            }

            @Override
            public void onError(La2lException error) {
                status.setText(error.getMessage());
            }
        }));

        send.setOnClickListener(v -> {
            status.setText("Sending...");
            la2l.send(tone().onProgress((part, sound, soundPart) -> status.setText("Sending... " + Math.round(part * 100) + "%")), new Callback<Delivery>() {
                @Override
                public void onSuccess(Delivery delivery) {
                    status.setText("Waiting for Import in Live");
                    delivery.imported(new Callback<DeliveryStatus>() {
                        @Override
                        public void onSuccess(DeliveryStatus result) {
                            status.setText("In Live");
                        }

                        @Override
                        public void onError(La2lException error) {
                            status.setText(error.getMessage());
                        }
                    });
                }

                @Override
                public void onError(La2lException error) {
                    status.setText(error.getMessage());
                }
            });
        });

        share.setOnClickListener(v -> {
            try {
                Intent intent = La2lShare.intent(this, tone());
                startActivity(Intent.createChooser(intent, "Send to Live"));
            } catch (Exception e) {
                status.setText(e.getMessage());
            }
        });
    }

    // Two bars of 4/4 at 120 BPM: an A on every beat, fading out. Exactly 4 seconds at 48 kHz.
    private static SoundPackage tone() {
        int rate = 48000;
        float[] samples = new float[rate * 4];
        for (int i = 0; i < samples.length; i++) {
            int inBeat = i % (rate / 2);
            samples[i] = (float) (Math.sin(2 * Math.PI * 440 * i / rate) * Math.exp(-inBeat / 4000.0) * 0.5);
        }
        return new SoundPackage("Java tone").bpm(120).add(Sound.loop("Tone", Wav.fromFloat(samples, rate, 1)).role(Role.MELODIC).lengthBeats(8));
    }
}
