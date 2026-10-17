// A smoke test for Deno and Bun: the public API of la2l, against the local test receiver of
// la2l/testing. Pair, send a loop, and wait until it is imported. Prints OK or throws.
//   deno run -A test-runtimes/smoke.mjs      bun test-runtimes/smoke.mjs
import { LA2L, memoryStorage, wavFromSamples, checkWav, sha256, VERSION } from '../dist/index.js';
import { startTestReceiver } from '../dist/testing/index.js';

const receiver = await startTestReceiver();
try {
  const la2l = new LA2L({ appName: 'Runtime check', server: receiver.server, storage: memoryStorage() });
  await la2l.pair(receiver.code);
  const loop = wavFromSamples(new Float32Array(48000).fill(0.1), 48000);
  const info = await checkWav(loop);
  const hash = await sha256(loop);
  if (info.frames !== 48000 || hash.length !== 64) throw new Error('checkWav or sha256 gave a wrong answer');
  const delivery = await la2l.send({ title: 'Runtime check', bpm: 120, sounds: [{ name: 'Loop', audio: loop, kind: 'loop', role: 'drums' }] });
  const st = await delivery.imported({ intervalMs: 1000 });
  const report = await receiver.nextReport();
  if (st.status !== 'imported' || report.sounds[0].plan.bpm !== 120) throw new Error(`not imported as it should: ${JSON.stringify(st)}`);
  console.log(`OK: la2l ${VERSION} sent and imported "${report.sounds[0].plan.trackName}".`);
} finally {
  await receiver.close();
}
