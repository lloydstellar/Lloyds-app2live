// The whole chain, as on every pull request: the SDK sends to the real server code, and the real
// device code (src/node/app.js) imports it into the simulated Live of the device tests
// (tests/mock-live.js, which runs the real v8 script). As server/test/device-e2e.test.js does it,
// with the SDK in the place of the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LA2L, memoryStorage, wavFromSamples } from '../dist/index.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { startServer } = require(path.join(ROOT, 'server', 'test', 'helpers.js'));
const { App } = require(path.join(ROOT, 'src', 'node', 'app.js'));
const { MockLive, loadLiveScript } = require(path.join(ROOT, 'tests', 'mock-live.js'));
const { makeLoop } = require(path.join(ROOT, 'src', 'node', 'testsound.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for ' + what);
}

// The device in Live, as in server/test/device-e2e.test.js.
function device(base) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-home-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ settings: { serverUrl: base }, pairing: null }));
  const mock = new MockLive();
  const outs = [];
  let app = null;
  const ctx = loadLiveScript(mock, (n, args) => {
    if (n === 0) setImmediate(() => app.handle('live', args[1]));
    else setTimeout(() => (mock.tick(), ctx.step()), 0);
  });
  app = new App({
    home,
    out: (name, ...args) => {
      outs.push([name, ...args]);
      if (name === 'tolive') setImmediate(() => ctx.request(args[1]));
    },
    timing: { liveTimeoutMs: 2000, importTimeoutMs: 5000, retryDelayMs: 5, liveRetryMs: 20, unpairConfirmMs: 2000, appsCheckMs: 600000 },
    openFolder: () => {},
  });
  ctx.init();
  const last = (name) => {
    for (let i = outs.length - 1; i >= 0; i--) if (outs[i][0] === name) return outs[i].slice(1);
    return null;
  };
  return { app, mock, home, last, status: () => (last('status') || []).join(' '), view: () => (last('view') || [])[0] };
}

let s;
test.before(async () => {
  s = await startServer({ POLL_MS: '500' });
});
test.after(() => s.stop());

test('the SDK sends a loop and a one-shot; Import in Live places them at the tempo the app gave', async () => {
  const d = device(s.base);
  d.app.start();
  await d.app.handle('pair');
  const code = d.last('code').join(' '); // "K7P 42Q", as the device shows it
  const la2l = new LA2L({ appName: 'Web808', server: s.base, storage: memoryStorage() });
  const { deviceName } = await la2l.pair(code);
  assert.equal((await la2l.me()).deviceName, deviceName, 'the name of this computer');
  await waitFor(() => d.view() === 'paired', 'Live says it is paired');
  assert.equal(d.last('pairedwith').join(' '), 'Paired with Web808.');

  // A 4-beat loop at 135 BPM, made the way the device makes its own test loop, and a short hit.
  const loop = wavFromSamples(Float32Array.from(makeLoop(135, 4)), 44100);
  const hit = wavFromSamples(Float32Array.from({ length: 11025 }, (_, i) => Math.sin(i / 7) * 0.4), 44100, { bits: 24 });
  const delivery = await la2l.send({
    title: 'Treinbeat',
    bpm: 135,
    sounds: [
      { id: 'snare', name: 'Snare', audio: loop, kind: 'loop', role: 'drums' },
      { id: 'hit', name: 'Hit', audio: hit, kind: 'oneshot' },
    ],
  });
  assert.equal((await delivery.status()).status, 'waiting');

  await d.app.handle('import');
  assert.equal(d.status(), 'Treinbeat: 2 tracks imported.');
  const names = d.mock.song.tracks.map((t) => t.name);
  assert.ok(names.includes('Snare (Web808)') && names.includes('Hit (Web808)'), names.join(', '));
  const snareTrack = d.mock.song.tracks.findIndex((t) => t.name === 'Snare (Web808)');
  const snare = d.mock.track(snareTrack).arrangement[0];
  assert.equal(snare.warping, 1);
  assert.equal(snare.warpMode, 0, 'Beats, for drums');
  assert.ok(Math.abs(d.mock.clipTempo(snare) - 135) < 0.05, `plays at ${d.mock.clipTempo(snare)} BPM`);
  assert.equal(d.mock.track(d.mock.song.tracks.findIndex((t) => t.name === 'Hit (Web808)')).arrangement[0].warping, 0, 'the one-shot plays as it is');

  const st = await delivery.imported({ intervalMs: 1000 });
  assert.equal(st.status, 'imported');
  assert.deepEqual(st.sounds.map((x) => [x.id, x.status]), [['snare', 'imported'], ['hit', 'imported']]);

  // Unpair in Live: the SDK learns it at its next call, and forgets the token.
  d.app.handle('settings', 1);
  await d.app.handle('unpair');
  await d.app.handle('unpair');
  await assert.rejects(la2l.me(), (e) => e.code === 'not_paired');
  assert.equal(la2l.paired, false);
});
