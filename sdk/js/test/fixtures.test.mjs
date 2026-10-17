// sdk/fixtures against the checks of this package: checkWav, checkManifest (as the server and as
// the device) and planSound must give exactly the verdicts of expected.json, which the device and
// the server are held to as well.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWav, checkManifest, planSound, La2lError } from '../dist/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));
// The device gets a manifest from the server, which gives it a package_id first.
const delivered = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? { ...m, package_id: 'fixture-package' } : m);

for (const f of expected.wav) {
  test(`checkWav ${f.file}: ${f.about}`, async () => {
    const bytes = fs.readFileSync(path.join(FIXTURES, f.file));
    // A Blob as in a browser, and bytes as in Node: the same verdict.
    for (const source of [new Blob([bytes]), bytes, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)]) {
      if (!f.device.ok) {
        await assert.rejects(checkWav(source), (e) => e instanceof La2lError && e.code === 'bad_wav' && e.message === f.device.error);
        continue;
      }
      const info = await checkWav(source);
      for (const [key, value] of Object.entries(f.device)) if (key !== 'ok') assert.equal(info[key], value, key);
      assert.equal(info.fileBytes, bytes.length);
    }
  });
}

for (const f of expected.manifests) {
  test(`checkManifest ${f.file}: ${f.about}`, () => {
    const raw = read(f.file);
    const device = checkManifest(delivered(raw), { as: 'device' });
    if (!f.device.ok) assert.deepEqual(device, { ok: false, error: f.device.error, warnings: [] });
    else {
      assert.equal(device.ok, true);
      assert.deepEqual(device.warnings, f.device.warnings);
      assert.deepEqual(device.package.items.map((it) => ({ name: it.name, kind: it.kind, error: it.error })), f.device.items);
    }
    const server = checkManifest(raw);
    if (f.server.status === 201) {
      assert.equal(server.ok, true, server.error);
      assert.deepEqual(server.warnings, f.server.warnings);
    } else {
      assert.equal(server.ok, false);
      assert.equal(server.status, f.server.status);
      assert.equal(server.error, f.server.error);
    }
  });
}

for (const p of expected.plans) {
  test(`planSound: ${p.about}`, () => {
    const check = checkManifest(delivered(read(p.manifest)), { as: 'device' });
    const plan = planSound(check.package.items[p.item], check.package, p.duration);
    const { warp, looping, warpMode, bpm, lengthBeats, trackName } = plan;
    assert.deepEqual({ warp, looping, warpMode, bpm, lengthBeats }, p.plan);
    assert.equal(trackName, p.trackName);
  });
}
