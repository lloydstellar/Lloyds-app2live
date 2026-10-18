// Checks a send end to end without Ableton: an LA2L server in memory with a test receiver, the
// SDK pointed at it, and the report of what Live would do. Run with: node check-with-test-receiver.mjs
// In your own tests, send through your app's code instead of the send() below.
import { LA2L, memoryStorage, wavFromSamples } from '@lloydstellar/la2l';
import { startTestReceiver } from '@lloydstellar/la2l/testing';

const receiver = await startTestReceiver(); // no internet, no rate limits
try {
  const la2l = new LA2L({ appName: 'My app', server: receiver.server, storage: memoryStorage() });
  await la2l.pair(receiver.code);

  // A loop of exactly one bar at 120 BPM: 2 seconds.
  const bar = wavFromSamples(Float32Array.from({ length: 96000 }, (_, i) => (i % 24000 < 2400 ? Math.sin(i / 8) * 0.8 : 0)), 48000);
  const delivery = await la2l.send({ title: 'Check', bpm: 120, sounds: [{ name: 'Beat', audio: bar, kind: 'loop', role: 'drums' }] });
  await delivery.imported();

  const plan = (await receiver.nextReport()).sounds[0].plan;
  console.log(plan); // { warp: true, warpModeName: 'Beats', bpm: 120, lengthBeats: 4, trackName: 'Beat (My app)', ... }
  if (!plan.warp || plan.bpm !== 120 || plan.lengthBeats !== 4) throw new Error('Not a loop at 120 BPM of 4 beats: check kind, bpm and the length of the audio.');
  console.log('OK: Live would place it as a loop of 4 beats at 120 BPM.');
} finally {
  await receiver.close();
}
