'use strict';
// The shared fixtures of sdk/fixtures against the device's own checks. The device is the source
// of truth: when this test fails, either the device changed (then expected.json must follow,
// through sdk/fixtures/make.js) or the fixture is wrong. The server and every SDK are tested
// against the same expected.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const wav = require('../src/node/wav');
const manifest = require('../src/node/manifest');
const { DEFAULT_SETTINGS } = require('../src/node/settings');

const FIXTURES = path.join(__dirname, '..', 'sdk', 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));

// The device gets a manifest from the server, which gives it a package_id first.
const delivered = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? Object.assign({}, m, { package_id: 'fixture-package' }) : m);

test('the fixtures on disk are what make.js makes, and nothing else', () => {
  const { outputs } = require('../sdk/fixtures/make');
  const made = outputs();
  for (const [rel, body] of made) assert.ok(fs.readFileSync(path.join(FIXTURES, rel)).equals(body), `${rel}: run node sdk/fixtures/make.js`);
  for (const dir of ['wav', 'manifests']) {
    for (const f of fs.readdirSync(path.join(FIXTURES, dir))) assert.ok(made.has(`${dir}/${f}`), `${dir}/${f} is not made by make.js`);
  }
});

for (const f of expected.wav) {
  test(`WAV ${f.file}: ${f.about}`, () => {
    const file = path.join(FIXTURES, f.file);
    if (!f.device.ok) {
      assert.throws(() => wav.readInfo(file), (e) => e instanceof wav.WavError && e.message === f.device.error);
      return;
    }
    const info = wav.readInfo(file);
    for (const [key, value] of Object.entries(f.device)) if (key !== 'ok') assert.equal(info[key], value, key);
  });
}

for (const f of expected.manifests) {
  test(`manifest ${f.file}: ${f.about}`, () => {
    const raw = delivered(read(f.file));
    if (!f.device.ok) {
      assert.throws(() => manifest.validate(raw), (e) => e instanceof manifest.ManifestError && e.message === f.device.error);
      return;
    }
    const { pkg, warnings } = manifest.validate(raw);
    assert.deepEqual(warnings, f.device.warnings);
    assert.deepEqual(
      pkg.items.map((it) => ({ name: it.name, kind: it.kind, error: it.error })),
      f.device.items
    );
  });
}

for (const p of expected.plans) {
  test(`plan: ${p.about}`, () => {
    const { pkg } = manifest.validate(delivered(read(p.manifest)));
    const item = pkg.items[p.item];
    assert.deepEqual(manifest.planItem(item, pkg, p.duration), p.plan);
    assert.equal(manifest.trackName(item, pkg, DEFAULT_SETTINGS), p.trackName);
  });
}
