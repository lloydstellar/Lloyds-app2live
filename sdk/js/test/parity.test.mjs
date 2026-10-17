// The port next to the device itself, on inputs made at random: checkManifest (as the device)
// must give what src/node/manifest.js validate gives, checkWav what src/node/wav.js readInfo
// gives, and cleanName what src/node/text.js gives. The fixtures cover the known cases; this
// covers the combinations nobody wrote down.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checkManifest, checkWav, cleanName, planSound } from '../dist/index.js';

const require = createRequire(import.meta.url);
const device = {
  manifest: require('../../../src/node/manifest.js'),
  wav: require('../../../src/node/wav.js'),
  text: require('../../../src/node/text.js'),
};
const { DEFAULT_SETTINGS } = require('../../../src/node/settings.js');

// A small random generator with a seed, so a failure can be repeated.
function random(seed) {
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
  const pick = (list) => list[Math.floor(next() * list.length)];
  return { next, pick, int: (n) => Math.floor(next() * n) };
}

const VALUES = {
  name: [undefined, null, '', 'Kick', '  Snare  drum ', 'Robot hallo!', 'A'.repeat(45), 'Ünïcode 鼓 ♪', 'tab\there', 5, {}, ['x']],
  file: [undefined, 'kick.wav', 'KICK.WAV', 'my kick.wav', '../x.wav', '.hidden.wav', 'a..b.wav', 'kick.mp3', 'k'.repeat(101) + '.wav', 7, 'snare.wav', 'Kick.Wav'],
  kind: [undefined, null, '', 'loop', 'Loop', 'one-shot', 'ONE_SHOT', 'oneshot', 'drum', 3, true],
  role: [undefined, 'drums', 'Drums', 'bass', 'drum', '', 7, null, 'fx', 'vocal'],
  bpm: [undefined, 120, 19, 20, 999, 1000, '120', null, 92.5],
  length_beats: [undefined, 4, 0, -1, 4096, 4097, 15.95, '4'],
  warp_mode: [undefined, 'beats', 'Complex Pro', 'complex_pro', 6, 5, 'rex', null],
  color: [undefined, '#E5484D', 'e5484d', '#FFF', 'red', 123],
  gain_db: [undefined, 0, -100, 30, '3', -6.5],
  bytes: [undefined, 1000, 0, -5, 1.5, '1000', 104857600, 209715200],
  sha256: [undefined, 'a'.repeat(64), 'A'.repeat(64), 'abc', 5],
  id: [undefined, '', 'kick', 'x'.repeat(120), 4],
};

function sound(r) {
  if (r.next() < 0.03) return r.pick([null, 'kick', 5, []]);
  const it = {};
  for (const [key, list] of Object.entries(VALUES)) {
    const v = r.pick(list);
    if (v !== undefined) it[key] = v;
  }
  return it;
}

function manifest(r) {
  const m = {};
  m.schema = r.pick(['app2live/1', 'app2live/1', 'app2live/1', 'app2live/1', 'app2live/2', 'other', undefined, 1]);
  m.package_id = r.pick(['pkg-1', 'pkg-1', 'pkg-1', '', 'bad id!', undefined, 'x'.repeat(101)]);
  const title = r.pick([undefined, 'Treinbeat', '', 'T'.repeat(70), 9]);
  if (title !== undefined) m.title = title;
  const source = r.pick([undefined, {}, { app: 'Web808' }, { app: '', app_version: '1.0', platform: 'web' }, 'web']);
  if (source !== undefined) m.source = source;
  const tempo = r.pick([undefined, { bpm: 120 }, { bpm: 10 }, { bpm: '120' }, { time_signature: [4, 4] }, { bpm: 92, time_signature: [3, 4] }, 'fast']);
  if (tempo !== undefined) m.tempo = tempo;
  if (r.next() < 0.2) m.midi = r.pick([[], [{}], 'x']);
  const count = r.pick([0, 1, 1, 2, 3, 5, 33]);
  if (r.next() < 0.05) m.items = r.pick(['x', null, {}]);
  else m.items = Array.from({ length: count }, () => sound(r));
  return m;
}

test('checkManifest as the device: the same as validate() on 3000 random manifests', () => {
  const r = random(20261017);
  for (let n = 0; n < 3000; n++) {
    const m = manifest(r);
    let want;
    try {
      const { pkg, warnings } = device.manifest.validate(m);
      want = { ok: true, pkg, warnings };
    } catch (e) {
      want = { ok: false, error: e.message };
    }
    const got = checkManifest(m, { as: 'device' });
    const label = JSON.stringify(m).slice(0, 300);
    assert.equal(got.ok, want.ok, label);
    if (!want.ok) {
      assert.equal(got.error, want.error, label);
      continue;
    }
    assert.deepEqual(got.warnings, want.warnings, label);
    assert.deepEqual(JSON.parse(JSON.stringify(got.package)), JSON.parse(JSON.stringify(want.pkg)), label);
    // And the plan of every sound, for a few lengths.
    for (const item of want.pkg.items) {
      for (const duration of [0, 0.5, 2, 2.0004, 10.4348, 600]) {
        const plan = planSound(got.package.items[item.index], got.package, duration);
        const { warp, looping, warpMode, bpm, lengthBeats } = plan;
        assert.deepEqual({ warp, looping, warpMode, bpm, lengthBeats }, device.manifest.planItem(item, want.pkg, duration), label);
        assert.equal(plan.trackName, device.manifest.trackName(item, want.pkg, DEFAULT_SETTINGS));
      }
    }
  }
});

test('checkWav: the same as readInfo() on 2000 damaged WAV files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-parity-'));
  const r = random(42);
  const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'fixtures', 'wav');
  const seeds = fs.readdirSync(fixtures).map((f) => fs.readFileSync(path.join(fixtures, f)));
  try {
    for (let n = 0; n < 2000; n++) {
      const b = Buffer.from(r.pick(seeds));
      // Change a few bytes in the header, cut the file, or both.
      for (let k = r.int(4); k > 0; k--) if (b.length) b[r.int(Math.min(b.length, 80))] = r.int(256);
      const data = r.next() < 0.3 ? b.subarray(0, r.int(b.length + 1)) : b;
      const file = path.join(dir, `f${n}.wav`);
      fs.writeFileSync(file, data);
      let want;
      try {
        want = { ok: true, info: device.wav.readInfo(file) };
      } catch (e) {
        want = { ok: false, error: e.message };
      }
      let got;
      try {
        got = { ok: true, info: await checkWav(new Blob([data])) };
      } catch (e) {
        got = { ok: false, error: e.message };
      }
      assert.deepEqual(got, want, `file ${n}: ${data.subarray(0, 48).toString('hex')}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanName: the same as the device on odd names', () => {
  const r = random(7);
  const parts = ['Kick', ' ', '  ', '\t', '\n', 'é', 'é', '鼓', '♪', '😀', '(', ')', '.', "'", '&', '+', '#', '!', '/', '\\', ',', ';', '"', 'x'.repeat(30)];
  for (let n = 0; n < 3000; n++) {
    const name = Array.from({ length: r.int(8) }, () => r.pick(parts)).join('');
    for (const max of [40, 60, 5]) assert.equal(cleanName(name, 'Fallback', max), device.text.cleanName(name, 'Fallback', max), JSON.stringify(name));
  }
});
