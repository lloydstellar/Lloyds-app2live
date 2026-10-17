'use strict';
// The shared fixtures of sdk/fixtures against the real server: every manifest through
// POST /packages, every WAV file through PUT. The verdicts are in sdk/fixtures/expected.json;
// tests/fixtures.test.js holds the device to the same file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, pairDevice, packageManifest } = require('./helpers');

const FIXTURES = path.join(__dirname, '..', '..', 'sdk', 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));

let s;
let p;
test.before(async () => {
  s = await startServer();
  p = await pairDevice(s, { deviceId: 'fixtures' });
});
test.after(() => s.stop());

for (const f of expected.manifests) {
  test(`POST /packages ${f.file}: ${f.about}`, async () => {
    const body = fs.readFileSync(path.join(FIXTURES, f.file));
    const r = await s.request('POST', '/api/packages', { token: p.appToken, body, headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, f.server.status, r.body.toString());
    if (f.server.status === 201) assert.deepEqual(r.json.warnings, f.server.warnings);
    else assert.deepEqual(r.json, { error: f.server.error });
    if (r.status === 201) await s.request('DELETE', `/api/packages/${r.json.package_id}`, { token: p.appToken });
  });
}

// A WAV file passes when the device can use it, with the device's own text when it cannot.
for (const f of expected.wav) {
  test(`PUT ${f.file}: ${f.about}`, async () => {
    const data = fs.readFileSync(path.join(FIXTURES, f.file));
    const created = await s.request('POST', '/api/packages', { token: p.appToken, body: packageManifest([{ file: 'sound.wav', data, kind: 'loop' }]) });
    assert.equal(created.status, 201);
    const id = created.json.package_id;
    const r = await s.request('PUT', `/api/packages/${id}/files/sound.wav`, { token: p.appToken, body: data });
    if (f.device.ok) assert.deepEqual([r.status, r.json], [200, { ok: true, file: 'sound.wav', bytes: data.length }]);
    else assert.deepEqual([r.status, r.json], [422, { error: f.device.error }]);
    await s.request('DELETE', `/api/packages/${id}`, { token: p.appToken });
  });
}
