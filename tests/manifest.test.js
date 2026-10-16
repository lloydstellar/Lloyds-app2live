'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/node/manifest');
const { DEFAULT_SETTINGS } = require('../src/node/settings');

// The example from the plan, with the new schema name.
const example = () => ({
  schema: 'app2live/1',
  package_id: '7f3c2a9e-1b4d-4c8e-9a51-0d2e6f7b8c90',
  created_at: '2026-10-16T14:30:00Z',
  title: 'Treinbeat',
  source: { app: 'Web808', app_version: '1.0.0', platform: 'web' },
  tempo: { bpm: 92.0, time_signature: [4, 4] },
  items: [
    { id: 'kick', file: 'kick.wav', sha256: 'a'.repeat(64), bytes: 1693484, name: 'Kick', kind: 'loop', role: 'drums', length_beats: 16, color: '#E5484D' },
    { id: 'robot', file: 'robot.wav', sha256: 'b'.repeat(64), bytes: 420112, name: 'Robot hallo', kind: 'oneshot', role: 'vocal' },
  ],
  midi: [],
});

test('the example manifest from the plan', () => {
  const { pkg, warnings } = m.validate(example());
  assert.deepEqual(warnings, []);
  assert.equal(pkg.title, 'Treinbeat');
  assert.equal(pkg.app, 'Web808');
  assert.equal(pkg.bpm, 92);
  assert.deepEqual(pkg.timeSignature, [4, 4]);
  const [kick, robot] = pkg.items;
  assert.equal(kick.color, 0xe5484d);
  assert.equal(kick.lengthBeats, 16);
  assert.equal(robot.kind, 'oneshot');
  assert.deepEqual(m.planItem(kick, pkg, 10.4348), { warp: true, looping: true, warpMode: 0, bpm: 92, lengthBeats: 16 });
  assert.deepEqual(m.planItem(robot, pkg, 1.2), { warp: false, looping: false, warpMode: null, bpm: null, lengthBeats: null });
  assert.equal(m.trackName(kick, pkg, { appNameInTrackName: true }), 'Kick (Web808)');
  assert.equal(m.trackName(kick, pkg, { appNameInTrackName: false }), 'Kick');
  assert.equal(m.sceneName(pkg), 'Treinbeat (Web808)');
});

test('kind + role -> warp mode, as in the plan table', () => {
  const pkg = { bpm: 120 };
  const mode = (role) => m.planItem({ kind: 'loop', role, warpMode: null, bpm: null, lengthBeats: null }, pkg, 2).warpMode;
  assert.equal(mode('drums'), 0); // Beats
  assert.equal(mode('bass'), 1); // Tones
  assert.equal(mode('melodic'), 6); // Complex Pro
  assert.equal(mode('vocal'), 6); // Complex Pro
  assert.equal(mode('texture'), 2); // Texture
  assert.equal(mode('fx'), 4); // Complex
  assert.equal(mode(null), 4); // Complex
  const forced = m.planItem({ kind: 'loop', role: 'drums', warpMode: 6, bpm: null, lengthBeats: null }, pkg, 2);
  assert.equal(forced.warpMode, 6, 'warp_mode wins over role');
});

test('warp_mode names', () => {
  assert.equal(m.parseWarpMode('complex_pro'), 6);
  assert.equal(m.parseWarpMode('Complex Pro'), 6);
  assert.equal(m.parseWarpMode('Re-Pitch'), 3);
  assert.equal(m.parseWarpMode(5), null, 'REX is not for WAV');
  assert.equal(m.parseWarpMode('stretchy'), null);
});

test('tempo and length: bpm from the package, the sound, or the length', () => {
  const loop = (o) => Object.assign({ kind: 'loop', role: 'drums', warpMode: null, bpm: null, lengthBeats: null }, o);
  // 4 beats at 135 BPM = 1.7778 s
  assert.equal(m.planItem(loop({}), { bpm: 135 }, 1.7777).lengthBeats, 4);
  assert.equal(m.planItem(loop({ bpm: 90 }), { bpm: 135 }, 2.6667).lengthBeats, 4);
  const derived = m.planItem(loop({ lengthBeats: 8 }), { bpm: null }, 4);
  assert.equal(derived.bpm, 120);
  assert.equal(m.planItem(loop({}), { bpm: null }, 4).bpm, null);
  assert.equal(m.snapBeats(3.95), 4);
  assert.equal(m.snapBeats(4.09), 4);
  assert.equal(m.snapBeats(4.3), 4.3);
  assert.equal(m.snapBeats(0.05), 0.05);
});

test('package problems throw', () => {
  const bad = (change, re) => {
    const x = example();
    change(x);
    assert.throws(() => m.validate(x), re);
  };
  assert.throws(() => m.validate(null), /not valid/);
  assert.throws(() => m.validate([]), /not valid/);
  bad((x) => delete x.schema, /not an App2Live package/);
  bad((x) => (x.schema = 'phone2live/1'), /not an App2Live package/);
  bad((x) => (x.schema = 'app2live/2'), /uses app2live\/2. Update LA2L/);
  bad((x) => (x.package_id = '../x'), /package_id/);
  bad((x) => (x.items = []), /no sounds/);
  bad((x) => (x.items = Array.from({ length: 33 }, (_, i) => ({ file: `f${i}.wav`, kind: 'oneshot' }))), /33 sounds. LA2L takes 32/);
  bad((x) => (x.items[0].bytes = 201 * 1048576), /is 201 MB\. LA2L takes 200 MB at most/);
});

test('sound problems only mark that sound', () => {
  const x = example();
  x.items.push({ file: '../../evil.wav', name: 'Evil', kind: 'loop' });
  x.items.push({ file: 'song.mp3', name: 'Mp3', kind: 'loop' });
  x.items.push({ file: 'kick.wav', name: 'Twice', kind: 'loop' });
  x.items.push('nonsense');
  x.items.push({ file: 'odd.wav', name: 'Odd', kind: 'drone', role: 'lead', sha256: 'xyz', bytes: -1, color: 'red', gain_db: 'loud', bpm: 2000, length_beats: -4, warp_mode: 'fast' });
  const { pkg, warnings } = m.validate(x);
  assert.equal(pkg.items[0].error, null);
  assert.equal(pkg.items[2].error, 'has no valid file name');
  assert.equal(pkg.items[3].error, 'has no valid file name');
  assert.equal(pkg.items[4].error, 'uses the same file as another sound');
  assert.equal(pkg.items[5].error, 'is not described correctly');
  const odd = pkg.items[6];
  assert.equal(odd.error, null);
  assert.equal(odd.kind, 'oneshot', 'unknown kind plays as it is');
  assert.equal(odd.role, null);
  assert.equal(odd.sha256, null);
  assert.equal(odd.bytes, null);
  assert.equal(odd.color, null);
  assert.equal(odd.bpm, null);
  assert.equal(odd.lengthBeats, null);
  assert.equal(odd.warpMode, null);
  assert.equal(warnings.length, 9);
});

test('names are cleaned, missing ones get a default', () => {
  const x = example();
  x.title = 'Trein/beat; "live"';
  x.source.app = '';
  x.items[0].name = '';
  const { pkg } = m.validate(x);
  assert.equal(pkg.title, 'Trein beat live');
  assert.equal(pkg.app, 'App');
  assert.equal(pkg.items[0].name, 'Sound 1');
});

test('gain_db is kept within -70 and +24', () => {
  const x = example();
  x.items[0].gain_db = 40;
  x.items[1].gain_db = -6;
  const { pkg } = m.validate(x);
  assert.equal(pkg.items[0].gainDb, 24);
  assert.equal(pkg.items[1].gainDb, -6);
});

test('the test package is a valid package', () => {
  const { pkg } = m.validate(m.testManifest(DEFAULT_SETTINGS));
  assert.equal(pkg.title, 'Test import');
  assert.equal(pkg.app, 'LA2L');
  assert.equal(pkg.bpm, 135);
  assert.equal(pkg.items[0].name, 'Snare');
  assert.equal(pkg.items[0].kind, 'loop');
  assert.equal(pkg.items[0].role, 'drums');
});

test('palette colours repeat and are valid', () => {
  assert.equal(m.paletteColor(0), m.paletteColor(m.PALETTE.length));
  assert.equal(m.parseColor('E5484D'), 0xe5484d);
  assert.equal(m.parseColor('#e5484d'), 0xe5484d);
  assert.equal(m.parseColor('#12345'), null);
});
