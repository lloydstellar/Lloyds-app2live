'use strict';
// Packages: the app sends a manifest and its WAV files, the device reads its inbox, downloads,
// and acks. Sections 7.5 to 7.8 and 8.5 to 8.9 of BUILD-PROMPT.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const helpers = require('./helpers');
const { startServer, pairDevice, fakeClock, sha256, loopWav, shotWav, compressedWav, packageManifest, sendPackage } = helpers;
const { Server, readInbox } = require('../../src/node/server');
const manifest = require('../../src/node/manifest');

const LOOP = loopWav(135);
const SHOT = shotWav();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let s;
test.before(async () => {
  s = await startServer();
});
test.after(() => s.stop());

let n = 0;
// A fresh computer with one app, so tests do not see each other's packages.
const pair = (o = {}) => pairDevice(s, Object.assign({ deviceId: `pkg-dev-${++n}` }, o));
const packageDir = (srv, id) => path.join(srv.dataDir, 'packages', id);

test('POST /packages: an id from the server, upload paths, and nothing for the device yet', async () => {
  const p = await pair();
  const body = packageManifest([{ id: 'snare', file: 'my snare.wav', data: LOOP, name: 'Snare', kind: 'loop', role: 'drums' }], {
    package_id: 'chosen-by-the-app',
    tempo: { bpm: 135 },
  });
  const r = await s.request('POST', '/api/packages', { token: p.appToken, body });
  assert.equal(r.status, 201, r.body.toString());
  const id = r.json.package_id;
  assert.match(id, UUID);
  assert.notEqual(id, 'chosen-by-the-app');
  assert.deepEqual(r.json.upload, { 'my snare.wav': `/packages/${id}/files/my%20snare.wav` });
  const hours = (Date.parse(r.json.expires_at) - Date.now()) / 3600000;
  assert.ok(hours > 23.9 && hours <= 24, `expires in ${hours} hours`);
  assert.deepEqual(r.json.warnings, []);
  // Not committed: the device does not see it.
  assert.deepEqual((await s.request('GET', '/api/inbox', { token: p.deviceToken })).json, { packages: [] });
  assert.equal((await s.request('GET', `/api/packages/${id}/manifest`, { token: p.deviceToken })).status, 404);
  assert.equal((await s.request('GET', `/api/packages/${id}/status`, { token: p.appToken })).json.status, 'uploading');
});

test('POST /packages: what the device would only warn about comes back as warnings', async () => {
  const p = await pair();
  const body = packageManifest([{ file: 'a.wav', data: SHOT, kind: 'drone', role: 'lead' }]);
  delete body.title;
  const r = await s.request('POST', '/api/packages', { token: p.appToken, body });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.warnings, ['no title', 'Sound 1: kind "drone" unknown, placed as one-shot', 'Sound 1: role "lead" unknown']);
});

test('POST /packages: every problem of a package or a sound is a 422 with a clear text', async () => {
  const p = await pair();
  const ok = { file: 'kick.wav', data: SHOT, name: 'Kick' };
  const cases = [
    [{ hello: 'world' }, 'This is not an App2Live package.'],
    [packageManifest([ok], { schema: 'app2live/2' }), 'This package uses app2live/2. Update LA2L to import it.'],
    [packageManifest([]), 'The package has no sounds.'],
    [packageManifest(Array.from({ length: 33 }, (_, i) => ({ file: `s${i}.wav`, data: SHOT }))), 'The package has 33 sounds. LA2L takes 32 at most.'],
    [packageManifest([{ file: '../kick.wav', data: SHOT, name: 'Kick' }]), 'Kick has no valid file name'],
    [packageManifest([{ file: 'kick.mp3', data: SHOT, name: 'Kick' }]), 'Kick has no valid file name'],
    [packageManifest([ok, { file: 'KICK.wav', data: SHOT, name: 'Kick 2' }]), 'Kick 2 uses the same file as another sound'],
    [packageManifest([{ file: 'kick.wav', data: SHOT, name: 'Kick', bytes: undefined }]), 'Kick needs bytes and sha256.'],
    [packageManifest([{ file: 'kick.wav', data: SHOT, name: 'Kick', sha256: 'abc' }]), 'Kick needs bytes and sha256.'],
    [packageManifest([{ file: 'kick.wav', data: SHOT, name: 'Kick', bytes: 0 }]), 'Kick needs bytes and sha256.'],
    [packageManifest([{ file: 'big.wav', data: SHOT, bytes: 201 * 1048576 }]), 'The package is 201 MB. LA2L takes 200 MB at most.'],
  ];
  for (const [body, error] of cases) {
    const r = await s.request('POST', '/api/packages', { token: p.appToken, body });
    assert.equal(r.status, 422, `${error}: ${r.body}`);
    assert.deepEqual(r.json, { error });
  }
  // The tokens: none, or the device's own, is a 401 here.
  assert.equal((await s.request('POST', '/api/packages', { body: packageManifest([ok]) })).status, 401);
  assert.equal((await s.request('POST', '/api/packages', { token: p.deviceToken, body: packageManifest([ok]) })).status, 401);
});

test('PUT: a file is only taken when its size, checksum and WAV header are right', async () => {
  const p = await pair();
  const sounds = [
    { file: 'loop.wav', data: LOOP },
    { file: 'shot.wav', data: SHOT },
  ];
  const created = await s.request('POST', '/api/packages', { token: p.appToken, body: packageManifest(sounds) });
  const id = created.json.package_id;
  const put = (file, body, o = {}) => s.request('PUT', `/api/packages/${id}/files/${file}`, Object.assign({ token: p.appToken, body }, o));

  // Same size, other bytes: the checksum tells.
  const damaged = Buffer.from(LOOP);
  damaged[damaged.length - 1] ^= 0xff;
  assert.deepEqual((await put('loop.wav', damaged)).json, { error: 'The file arrived damaged. Send it again.' });
  assert.equal((await put('loop.wav', LOOP.subarray(0, 1000))).status, 422, 'shorter');
  // Larger than the manifest said, with a Content-Length: refused before it is read.
  const larger = Buffer.concat([LOOP, Buffer.alloc(10)]);
  const r413 = await put('loop.wav', larger);
  assert.equal(r413.status, 413);
  assert.deepEqual(r413.json, { error: 'The file is larger than the package said.' });
  // A file that is not in the manifest, and names that cannot be one.
  assert.deepEqual((await put('other.wav', SHOT)).json, { error: 'This file is not in the package.' });
  assert.equal((await put('..%2Floop.wav', SHOT)).status, 404);
  assert.equal((await put('loop.wav.part', SHOT)).status, 404);
  // Nothing of it is left on disk.
  assert.deepEqual(fs.existsSync(packageDir(s, id)) ? fs.readdirSync(packageDir(s, id)) : [], []);

  assert.deepEqual((await put('loop.wav', LOOP)).json, { ok: true, file: 'loop.wav', bytes: LOOP.length });
  // Sending a file again replaces it.
  assert.equal((await put('loop.wav', LOOP)).status, 200);
  assert.deepEqual(fs.readdirSync(packageDir(s, id)), ['loop.wav']);
  assert.ok(fs.readFileSync(path.join(packageDir(s, id), 'loop.wav')).equals(LOOP));

  // Another app, or the device, cannot put files into it.
  const other = await pair();
  assert.deepEqual((await put('shot.wav', SHOT, { token: other.appToken })).json, { error: 'Unknown package.' });
  assert.equal((await put('shot.wav', SHOT, { token: p.deviceToken })).status, 401);
});

test('PUT: no WAV, or a compressed one, gets the message the device would show', async () => {
  const p = await pair();
  const text = Buffer.from('<html>This is an error page, saved as a WAV file.</html>');
  const mp3 = compressedWav();
  const created = await s.request('POST', '/api/packages', {
    token: p.appToken,
    body: packageManifest([
      { file: 'page.wav', data: text },
      { file: 'mp3.wav', data: mp3 },
    ]),
  });
  const id = created.json.package_id;
  const page = await s.request('PUT', `/api/packages/${id}/files/page.wav`, { token: p.appToken, body: text });
  assert.equal(page.status, 422);
  assert.deepEqual(page.json, { error: 'This is not a WAV file.' });
  const compressed = await s.request('PUT', `/api/packages/${id}/files/mp3.wav`, { token: p.appToken, body: mp3 });
  assert.deepEqual(compressed.json, { error: 'This WAV file is compressed (format 85). Send plain PCM or float WAV.' });
  assert.deepEqual(fs.readdirSync(packageDir(s, id)), []);
});

// A PUT that sends its body in chunks, without Content-Length. first: the bytes sent at once;
// rest: sent when the returned function is called. Resolves to { status, json }.
function chunkedPut(port, urlPath, token, first) {
  let req;
  const answer = new Promise((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: urlPath, headers: { Authorization: 'Bearer ' + token }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.write(first);
  });
  return { answer, finish: (rest) => req.end(rest) };
}

test('PUT without Content-Length: cut off one byte past the declared size; one upload per file at a time', async () => {
  const p = await pair();
  const created = await s.request('POST', '/api/packages', { token: p.appToken, body: packageManifest([{ file: 'loop.wav', data: LOOP }]) });
  const id = created.json.package_id;
  const urlPath = `/api/packages/${id}/files/loop.wav`;

  const tooMuch = chunkedPut(s.port, urlPath, p.appToken, LOOP);
  tooMuch.finish(Buffer.alloc(5000));
  const r = await tooMuch.answer;
  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { error: 'The file is larger than the package said.' });

  // While the first upload of a file is still coming in, a second one is refused.
  const slow = chunkedPut(s.port, urlPath, p.appToken, LOOP.subarray(0, 1000));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await s.request('PUT', urlPath, { token: p.appToken, body: LOOP });
  assert.equal(second.status, 409);
  assert.deepEqual(second.json, { error: 'This file is being sent already.' });
  slow.finish(LOOP.subarray(1000));
  assert.deepEqual((await slow.answer).json, { ok: true, file: 'loop.wav', bytes: LOOP.length });
});

test('commit: only with every file, then the device sees it; committing again is fine', async () => {
  const p = await pair();
  const created = await s.request('POST', '/api/packages', {
    token: p.appToken,
    body: packageManifest(
      [
        { file: 'a.wav', data: SHOT },
        { file: 'b.wav', data: LOOP },
        { file: 'c.wav', data: SHOT },
      ],
      { title: 'Three' }
    ),
  });
  const id = created.json.package_id;
  await s.request('PUT', `/api/packages/${id}/files/a.wav`, { token: p.appToken, body: SHOT });
  const early = await s.request('POST', `/api/packages/${id}/commit`, { token: p.appToken });
  assert.equal(early.status, 409);
  assert.deepEqual(early.json, { error: 'Not all files are there yet: b.wav, c.wav' });
  await s.request('PUT', `/api/packages/${id}/files/b.wav`, { token: p.appToken, body: LOOP });
  await s.request('PUT', `/api/packages/${id}/files/c.wav`, { token: p.appToken, body: SHOT });
  const before = Date.now();
  assert.deepEqual((await s.request('POST', `/api/packages/${id}/commit`, { token: p.appToken })).json, { ok: true, status: 'waiting' });
  assert.deepEqual((await s.request('POST', `/api/packages/${id}/commit`, { token: p.appToken })).json, { ok: true, status: 'waiting' });
  // No more files after the commit.
  assert.deepEqual((await s.request('PUT', `/api/packages/${id}/files/a.wav`, { token: p.appToken, body: SHOT })).json, {
    error: 'This package is sent already.',
  });

  const inbox = (await s.request('GET', '/api/inbox', { token: p.deviceToken })).json;
  assert.equal(inbox.packages.length, 1);
  const entry = inbox.packages[0];
  assert.deepEqual(Object.keys(entry), ['package_id', 'title', 'app', 'items', 'created_at']);
  assert.equal(entry.package_id, id);
  assert.equal(entry.title, 'Three');
  assert.equal(entry.app, 'LA2L Sender');
  assert.equal(entry.items, 3);
  assert.ok(Date.parse(entry.created_at) >= before - 5, 'created_at is the commit time');
  // Another computer does not see it.
  const other = await pair();
  assert.deepEqual((await s.request('GET', '/api/inbox', { token: other.deviceToken })).json, { packages: [] });
});

test('the device gets the manifest as the app sent it, and each file with its exact length', async () => {
  const p = await pair();
  const sounds = [
    { id: 'snare', file: 'snare loop.wav', data: LOOP, name: 'Snare', kind: 'loop', role: 'drums', bpm: 135, length_beats: 4, color: '#E5484D', gain_db: -3, warp_mode: 'beats' },
    { id: 'hit', file: 'hit.wav', data: SHOT, name: 'Hit', kind: 'oneshot' },
  ];
  const { packageId: id } = await sendPackage(s, p.appToken, sounds, { title: 'Exact', tempo: { bpm: 120, time_signature: [4, 4] }, extra: { kept: true } });

  const m = await s.request('GET', `/api/packages/${id}/manifest`, { token: p.deviceToken });
  assert.equal(m.status, 200);
  assert.equal(m.headers['cache-control'], 'no-store');
  const expected = packageManifest(sounds, { title: 'Exact', tempo: { bpm: 120, time_signature: [4, 4] }, extra: { kept: true } });
  expected.package_id = id;
  assert.deepEqual(m.json, expected);

  const file = await s.request('GET', `/api/packages/${id}/files/snare%20loop.wav`, { token: p.deviceToken });
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'audio/wav');
  assert.equal(file.headers['content-length'], String(LOOP.length));
  assert.equal(file.headers['cache-control'], 'no-store');
  assert.equal(file.headers['content-encoding'], undefined);
  assert.ok(file.body.equals(LOOP));
  const head = await s.request('HEAD', `/api/packages/${id}/files/hit.wav`, { token: p.deviceToken });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(SHOT.length));
  assert.equal(head.body.length, 0);

  // Not this device's, not in the package, not a package id: the same kind of 404.
  const other = await pair();
  assert.deepEqual((await s.request('GET', `/api/packages/${id}/manifest`, { token: other.deviceToken })).json, { error: 'Unknown package.' });
  assert.deepEqual((await s.request('GET', `/api/packages/${id}/files/hit.wav`, { token: other.deviceToken })).json, { error: 'Unknown package.' });
  assert.equal((await s.request('GET', `/api/packages/${id}/files/nope.wav`, { token: p.deviceToken })).status, 404);
  assert.equal((await s.request('GET', '/api/packages/not-an-id/manifest', { token: p.deviceToken })).status, 404);
  // The app token is not a device token.
  assert.equal((await s.request('GET', `/api/packages/${id}/manifest`, { token: p.appToken })).status, 401);
});

test('a file missing on disk: 404 "The file is gone", and the log says so loudly', async () => {
  const p = await pair();
  const { packageId: id } = await sendPackage(s, p.appToken, [{ file: 'gone.wav', data: SHOT }]);
  fs.rmSync(path.join(packageDir(s, id), 'gone.wav'));
  const r = await s.request('GET', `/api/packages/${id}/files/gone.wav`, { token: p.deviceToken });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: 'The file is gone. Send it again.' });
  assert.ok(s.lines.some((l) => l.includes(`ERROR package ${id}: the file gone.wav is missing on disk`)));
});

test('ack imported: the files go, the inbox is empty, the app reads the result', async () => {
  const p = await pair();
  const { packageId: id } = await sendPackage(s, p.appToken, [
    { id: 'kick', file: 'kick.wav', data: LOOP, name: 'Kick' },
    { id: 'hit', file: 'hit.wav', data: SHOT, name: 'Hit' },
  ]);
  const items = [
    { id: 'kick', name: 'Kick', status: 'imported' },
    { id: 'hit', name: 'Hit', status: 'imported' },
  ];
  const r = await s.request('POST', `/api/packages/${id}/ack`, { token: p.deviceToken, body: { status: 'imported', items } });
  assert.deepEqual(r.json, { ok: true });
  assert.equal(fs.existsSync(packageDir(s, id)), false, 'files deleted');
  assert.deepEqual((await s.request('GET', '/api/inbox', { token: p.deviceToken })).json, { packages: [] });
  assert.equal((await s.request('GET', `/api/packages/${id}/manifest`, { token: p.deviceToken })).status, 404);
  const status = (await s.request('GET', `/api/packages/${id}/status`, { token: p.appToken })).json;
  assert.equal(status.status, 'imported');
  assert.deepEqual(status.items, items);
  assert.ok(Date.parse(status.updated_at) > 0);
  // The app can no longer delete it.
  const del = await s.request('DELETE', `/api/packages/${id}`, { token: p.appToken });
  assert.equal(del.status, 409);
  assert.deepEqual(del.json, { error: 'This package is already in Live.' });
  // A late "failed" does not bring it back.
  await s.request('POST', `/api/packages/${id}/ack`, { token: p.deviceToken, body: { status: 'failed', error: 'late', items: [] } });
  assert.equal((await s.request('GET', `/api/packages/${id}/status`, { token: p.appToken })).json.status, 'imported');
});

test('ack failed: the package stays in the inbox with its files, so a later Import can bring it in', async () => {
  const p = await pair();
  const { packageId: id } = await sendPackage(s, p.appToken, [{ id: 'a', file: 'a.wav', data: SHOT, name: 'A' }]);
  const failed = { status: 'failed', error: 'This package uses app2live/2. Update LA2L to import it.', items: [] };
  assert.deepEqual((await s.request('POST', `/api/packages/${id}/ack`, { token: p.deviceToken, body: failed })).json, { ok: true });
  const status = (await s.request('GET', `/api/packages/${id}/status`, { token: p.appToken })).json;
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'This package uses app2live/2. Update LA2L to import it.');
  const inbox = (await s.request('GET', '/api/inbox', { token: p.deviceToken })).json.packages;
  assert.deepEqual(inbox.map((x) => x.package_id), [id]);
  assert.equal((await s.request('GET', `/api/packages/${id}/files/a.wav`, { token: p.deviceToken })).status, 200);
  // Tried again after an update: now it is in Live.
  await s.request('POST', `/api/packages/${id}/ack`, { token: p.deviceToken, body: { status: 'imported', items: [{ id: 'a', name: 'A', status: 'imported' }] } });
  assert.equal((await s.request('GET', `/api/packages/${id}/status`, { token: p.appToken })).json.status, 'imported');
  assert.equal(fs.existsSync(packageDir(s, id)), false);
});

test('ack "imported before": counts as imported, and keeps what an earlier ack said per sound', async () => {
  const p = await pair();
  const before = { status: 'imported', items: [], note: 'imported before' };
  // Without an earlier ack.
  const first = await sendPackage(s, p.appToken, [{ id: 'a', file: 'a.wav', data: SHOT }]);
  await s.request('POST', `/api/packages/${first.packageId}/ack`, { token: p.deviceToken, body: before });
  const st1 = (await s.request('GET', `/api/packages/${first.packageId}/status`, { token: p.appToken })).json;
  assert.equal(st1.status, 'imported');
  assert.deepEqual(st1.items, []);
  assert.equal(fs.existsSync(packageDir(s, first.packageId)), false);
  // After an earlier partial ack, which said per sound what happened.
  const second = await sendPackage(s, p.appToken, [
    { id: 'a', file: 'a.wav', data: SHOT },
    { id: 'b', file: 'b.wav', data: SHOT },
  ]);
  const items = [
    { id: 'a', name: 'Sound 1', status: 'imported' },
    { id: 'b', name: 'Sound 2', status: 'failed', error: 'did not download: The connection was broken off.' },
  ];
  await s.request('POST', `/api/packages/${second.packageId}/ack`, { token: p.deviceToken, body: { status: 'partial', items } });
  await s.request('POST', `/api/packages/${second.packageId}/ack`, { token: p.deviceToken, body: before });
  const st2 = (await s.request('GET', `/api/packages/${second.packageId}/status`, { token: p.appToken })).json;
  assert.equal(st2.status, 'partial');
  assert.deepEqual(st2.items, items);
  // After an earlier failed ack, its failures are not the result of the import.
  const third = await sendPackage(s, p.appToken, [{ id: 'a', file: 'a.wav', data: SHOT }]);
  await s.request('POST', `/api/packages/${third.packageId}/ack`, { token: p.deviceToken, body: { status: 'failed', items: [{ id: 'a', status: 'failed', error: 'x' }] } });
  await s.request('POST', `/api/packages/${third.packageId}/ack`, { token: p.deviceToken, body: before });
  const st3 = (await s.request('GET', `/api/packages/${third.packageId}/status`, { token: p.appToken })).json;
  assert.equal(st3.status, 'imported');
  assert.deepEqual(st3.items, []);
});

test('ack: a wrong shape is a 400, someone else\'s package a 404, and long texts are cut', async () => {
  const p = await pair();
  const { packageId: id } = await sendPackage(s, p.appToken, [{ file: 'a.wav', data: SHOT }]);
  const ack = (body, token = p.deviceToken) => s.request('POST', `/api/packages/${id}/ack`, { token, body });
  assert.deepEqual((await ack({ status: 'done' })).json, { error: 'The ack needs a status: imported, partial or failed.' });
  assert.equal((await ack({})).status, 400);
  assert.deepEqual((await ack({ status: 'imported', items: 'all' })).json, { error: 'The items of the ack must be a list.' });
  const other = await pair();
  assert.deepEqual((await ack({ status: 'imported', items: [] }, other.deviceToken)).json, { error: 'Unknown package.' });
  assert.equal((await ack({ status: 'imported', items: [] }, p.appToken)).status, 401);
  // 100 sounds of which 64 are kept, and every text at most 200 characters.
  const long = 'x'.repeat(500);
  const items = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, name: long, status: 'failed', error: long, extra: 'dropped' }));
  assert.equal((await ack({ status: 'failed', items, error: long, note: long })).status, 200);
  const status = (await s.request('GET', `/api/packages/${id}/status`, { token: p.appToken })).json;
  assert.equal(status.items.length, 64);
  assert.deepEqual(Object.keys(status.items[0]), ['id', 'name', 'status', 'error']);
  assert.equal(status.items[0].name.length, 200);
  assert.equal(status.error.length, 200);
  // An unfinished upload cannot be acked: the device never saw it.
  const created = await s.request('POST', '/api/packages', { token: p.appToken, body: packageManifest([{ file: 'u.wav', data: SHOT }]) });
  const r = await s.request('POST', `/api/packages/${created.json.package_id}/ack`, { token: p.deviceToken, body: { status: 'imported', items: [] } });
  assert.equal(r.status, 404);
});

test('status and DELETE: only for the app that sent it; deleting takes the files and the inbox entry', async () => {
  const p = await pair();
  const second = await pairDevice(s, { deviceId: 'pkg-dev-' + n, token: p.deviceToken, appName: 'Second', appId: 'second' });
  const { packageId: id } = await sendPackage(s, p.appToken, [{ file: 'a.wav', data: SHOT }]);
  // Another app of the same computer does not see it.
  assert.deepEqual((await s.request('GET', `/api/packages/${id}/status`, { token: second.appToken })).json, { error: 'Unknown package.' });
  assert.equal((await s.request('DELETE', `/api/packages/${id}`, { token: second.appToken })).status, 404);

  assert.deepEqual((await s.request('DELETE', `/api/packages/${id}`, { token: p.appToken })).json, { ok: true });
  assert.equal(fs.existsSync(packageDir(s, id)), false);
  assert.deepEqual((await s.request('GET', '/api/inbox', { token: p.deviceToken })).json, { packages: [] });
  assert.equal((await s.request('GET', `/api/packages/${id}/manifest`, { token: p.deviceToken })).status, 404);
  assert.equal((await s.request('GET', `/api/packages/${id}/status`, { token: p.appToken })).status, 404);
  assert.deepEqual((await s.request('DELETE', `/api/packages/${id}`, { token: p.appToken })).json, { ok: true }, 'again');
  // An upload can be taken back too.
  const created = await s.request('POST', '/api/packages', { token: p.appToken, body: packageManifest([{ file: 'u.wav', data: SHOT }]) });
  assert.equal((await s.request('DELETE', `/api/packages/${created.json.package_id}`, { token: p.appToken })).status, 200);
  assert.equal((await s.request('PUT', `/api/packages/${created.json.package_id}/files/u.wav`, { token: p.appToken, body: SHOT })).status, 404);
});

test('app/unpair: what the app sent still waits for the computer', async () => {
  const p = await pair();
  const { packageId: id } = await sendPackage(s, p.appToken, [{ file: 'a.wav', data: SHOT }]);
  await s.request('POST', '/api/app/unpair', { token: p.appToken });
  assert.deepEqual((await s.request('GET', '/api/inbox', { token: p.deviceToken })).json.packages.map((x) => x.package_id), [id]);
  assert.equal((await s.request('GET', `/api/packages/${id}/files/a.wav`, { token: p.deviceToken })).status, 200);
  assert.equal((await s.request('POST', `/api/packages/${id}/ack`, { token: p.deviceToken, body: { status: 'imported', items: [] } })).status, 200);
});

test('unpair in the device: its waiting packages and their files are deleted', async () => {
  const p = await pair();
  const waiting = await sendPackage(s, p.appToken, [{ file: 'a.wav', data: SHOT }]);
  const created = await s.request('POST', '/api/packages', { token: p.appToken, body: packageManifest([{ file: 'u.wav', data: SHOT }]) });
  await s.request('PUT', `/api/packages/${created.json.package_id}/files/u.wav`, { token: p.appToken, body: SHOT });
  assert.equal((await s.request('POST', '/api/unpair', { token: p.deviceToken, body: {} })).status, 200);
  assert.equal(fs.existsSync(packageDir(s, waiting.packageId)), false);
  assert.equal(fs.existsSync(packageDir(s, created.json.package_id)), false);
  const rows = s.store.db.prepare('SELECT COUNT(*) AS n FROM packages WHERE id IN (?, ?)').get(waiting.packageId, created.json.package_id);
  assert.equal(rows.n, 0);
  assert.ok(s.lines.some((l) => / unpaired: 1 app\(s\) revoked, 2 package\(s\) deleted$/.test(l)));
});

test('the device client of LA2L 0.1.1 reads the inbox and the manifest, downloads with checks, and acks', async () => {
  const p = await pair();
  const sounds = [
    { id: 'kick', file: 'kick.wav', data: LOOP, name: 'Kick', kind: 'loop', role: 'drums' },
    { id: 'robot', file: 'robot hallo.wav', data: SHOT, name: 'Robot hallo', kind: 'oneshot' },
  ];
  const { packageId: id } = await sendPackage(s, p.appToken, sounds, { title: 'Treinbeat', tempo: { bpm: 135 } });
  const server = new Server(s.base, () => p.deviceToken);
  const inbox = readInbox(await server.inbox());
  assert.deepEqual(inbox.map((x) => [x.id, x.title, x.app, x.items]), [[id, 'Treinbeat', 'LA2L Sender', 2]]);
  const { pkg, warnings } = manifest.validate(await server.manifest(id));
  assert.deepEqual(warnings, []);
  assert.equal(pkg.packageId, id);
  assert.equal(pkg.bpm, 135);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-dl-'));
  try {
    for (const item of pkg.items) {
      const target = path.join(dir, item.name + '.wav');
      const got = await server.downloadFile(id, item.file, target, { expectBytes: item.bytes, expectSha256: item.sha256, maxBytes: item.bytes });
      assert.equal(got.sha256, item.sha256);
      assert.equal(sha256(fs.readFileSync(target)), item.sha256);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await server.ack(id, { status: 'imported', items: pkg.items.map((it) => ({ id: it.id, name: it.name, status: 'imported' })) });
  assert.deepEqual(readInbox(await server.inbox()), []);
});

test('storage: a computer may keep MAX_DEVICE_STORAGE_MB waiting, the disk keeps MIN_FREE_DISK_MB free', async () => {
  const small = await startServer({ MAX_DEVICE_STORAGE_MB: '1' });
  try {
    const p = await pairDevice(small);
    const big = Buffer.concat([LOOP, Buffer.alloc(600000 - LOOP.length)]);
    const sounds = [{ file: 'big.wav', data: big }];
    const first = await small.request('POST', '/api/packages', { token: p.appToken, body: packageManifest(sounds) });
    assert.equal(first.status, 201);
    const second = await small.request('POST', '/api/packages', { token: p.appToken, body: packageManifest(sounds) });
    assert.equal(second.status, 507);
    assert.deepEqual(second.json, { error: 'Too many sounds wait for this computer. Click Import in Live first.' });
    // Another computer has room of its own.
    const other = await pairDevice(small, { deviceId: 'other' });
    assert.equal((await small.request('POST', '/api/packages', { token: other.appToken, body: packageManifest(sounds) })).status, 201);
    // Once the first is gone, there is room again.
    await small.request('DELETE', `/api/packages/${first.json.package_id}`, { token: p.appToken });
    assert.equal((await small.request('POST', '/api/packages', { token: p.appToken, body: packageManifest(sounds) })).status, 201);
  } finally {
    await small.stop();
  }
  // More free space asked than any disk has.
  const full = await startServer({}, { minFreeDiskBytes: Number.MAX_SAFE_INTEGER });
  try {
    const p = await pairDevice(full);
    const r = await full.request('POST', '/api/packages', { token: p.appToken, body: packageManifest([{ file: 'a.wav', data: SHOT }]) });
    assert.equal(r.status, 507);
    assert.deepEqual(r.json, { error: 'The server is full. Try again later.' });
  } finally {
    await full.stop();
  }
});

test('time: an upload has UPLOAD_TTL_MINUTES, a waiting package expires after PACKAGE_TTL_HOURS', async () => {
  const clock = fakeClock(Date.now());
  const t = await startServer({}, {}, { clock });
  try {
    const p = await pairDevice(t);
    const slow = await t.request('POST', '/api/packages', { token: p.appToken, body: packageManifest([{ file: 'a.wav', data: SHOT }]) });
    const sent = await sendPackage(t, p.appToken, [{ file: 'b.wav', data: SHOT }]);
    clock.add(61 * 60000);
    const late = await t.request('PUT', `/api/packages/${slow.json.package_id}/files/a.wav`, { token: p.appToken, body: SHOT });
    assert.equal(late.status, 404);
    assert.deepEqual(late.json, { error: 'The upload took too long. Send the package again.' });
    assert.equal((await t.request('GET', `/api/packages/${slow.json.package_id}/status`, { token: p.appToken })).json.status, 'expired');
    assert.equal((await t.request('POST', `/api/packages/${slow.json.package_id}/commit`, { token: p.appToken })).status, 404);
    // The committed one still waits, until 24 hours after its upload.
    assert.equal((await t.request('GET', '/api/inbox', { token: p.deviceToken })).json.packages.length, 1);
    clock.add(23 * 3600000);
    assert.deepEqual((await t.request('GET', '/api/inbox', { token: p.deviceToken })).json, { packages: [] });
    assert.equal((await t.request('GET', `/api/packages/${sent.packageId}/manifest`, { token: p.deviceToken })).status, 404);
    assert.equal((await t.request('GET', `/api/packages/${sent.packageId}/status`, { token: p.appToken })).json.status, 'expired');
  } finally {
    await t.stop();
  }
});

test('rate limit: 30 packages an hour per app, with Retry-After', async () => {
  const clock = fakeClock(Date.now());
  const t = await startServer({ RATE_LIMITS: 'on' }, {}, { clock });
  try {
    const p = await pairDevice(t);
    const body = packageManifest([{ file: 'a.wav', data: SHOT }]);
    for (let i = 0; i < 30; i++) assert.equal((await t.request('POST', '/api/packages', { token: p.appToken, body })).status, 201);
    const r = await t.request('POST', '/api/packages', { token: p.appToken, body });
    assert.equal(r.status, 429);
    assert.deepEqual(r.json, { error: 'Too many packages in an hour. Wait a while.' });
    assert.ok(Number(r.headers['retry-after']) > 3500);
    // Another app has its own count.
    const other = await pairDevice(t, { deviceId: 'other' });
    assert.equal((await t.request('POST', '/api/packages', { token: other.appToken, body })).status, 201);
    clock.add(3600000);
    assert.equal((await t.request('POST', '/api/packages', { token: p.appToken, body })).status, 201);
  } finally {
    await t.stop();
  }
});

test('restart: a waiting package and its files are still there', async () => {
  const t = await startServer();
  const p = await pairDevice(t);
  const { packageId: id } = await sendPackage(t, p.appToken, [{ file: 'a.wav', data: LOOP }]);
  await t.stop({ keepData: true });
  const again = await startServer({}, {}, { dataDir: t.dataDir });
  try {
    assert.deepEqual((await again.request('GET', '/api/inbox', { token: p.deviceToken })).json.packages.map((x) => x.package_id), [id]);
    assert.ok((await again.request('GET', `/api/packages/${id}/files/a.wav`, { token: p.deviceToken })).body.equals(LOOP));
  } finally {
    await again.stop();
  }
});

test('the log has no token, pair id, code, title or file name during a full send', async () => {
  const t = await startServer();
  try {
    const p = await pairDevice(t);
    const sounds = [{ id: 'secret-id', file: 'secret-file.wav', data: SHOT, name: 'Secret name' }];
    const { packageId: id } = await sendPackage(t, p.appToken, sounds, { title: 'Secret title' });
    await t.request('GET', `/api/packages/${id}/manifest`, { token: p.deviceToken });
    await t.request('GET', `/api/packages/${id}/files/secret-file.wav`, { token: p.deviceToken });
    await t.request('POST', `/api/packages/${id}/ack`, { token: p.deviceToken, body: { status: 'imported', items: [{ id: 'secret-id', name: 'Secret name', status: 'imported' }] } });
    await t.request('GET', `/api/packages/${id}/status`, { token: p.appToken });
    const log = t.lines.join('\n');
    for (const secret of [p.appToken, p.deviceToken, p.pairId, p.code, 'Secret title', 'secret-file', 'Secret name', 'secret-id']) {
      assert.ok(!log.includes(secret), `the log has ${secret.slice(0, 12)}`);
    }
    // But it does say what happened.
    for (const event of [`package ${id} created by app`, `package ${id} committed: 1 sound(s)`, `package ${id} acked by device`]) {
      assert.ok(log.includes(event), event);
    }
    assert.ok(t.lines.some((l) => / GET \/api\/packages\/:id\/files\/:file 200 /.test(l)));
  } finally {
    await t.stop();
  }
});
