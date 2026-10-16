'use strict';
// The cleanup of BUILD-PROMPT.md section 9, row by row, with a clock the test moves forward.
// Every test has a server of its own, because moving the clock moves it for everything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startServer, fakeClock, pairStart, pairDevice, sendPackage, packageManifest, shotWav } = require('./helpers');

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SHOT = shotWav();

async function server(env = {}) {
  const clock = fakeClock(Date.parse('2026-10-16T12:00:00.000Z'));
  const s = await startServer(env, {}, { clock });
  s.clock = clock;
  s.count = (sql, ...args) => s.store.db.prepare(sql).get(...args).n;
  s.folder = (id) => path.join(s.dataDir, 'packages', id);
  return s;
}

test('pairings: an expired one answers "expired" for an hour, a cancelled one is gone an hour after the cancel', async () => {
  const s = await server();
  try {
    const expired = await pairStart(s, 'dev-expired');
    const cancelled = await pairStart(s, 'dev-cancelled');
    await s.request('POST', `/api/pair/${cancelled.pair_id}/cancel`);
    s.clock.add(10 * MINUTE + 1000);
    assert.deepEqual(s.cleanup(), {});
    assert.deepEqual((await s.request('GET', '/api/pair/' + expired.pair_id)).json, { status: 'expired' });
    assert.deepEqual((await s.request('GET', '/api/pair/' + cancelled.pair_id)).json, { status: 'cancelled' });
    s.clock.add(HOUR);
    assert.deepEqual(s.cleanup(), { 'pairing(s)': 2 });
    assert.equal((await s.request('GET', '/api/pair/' + expired.pair_id)).status, 404);
    assert.equal((await s.request('GET', '/api/pair/' + cancelled.pair_id)).status, 404);
    assert.equal(s.count('SELECT COUNT(*) AS n FROM pairings'), 0);
  } finally {
    await s.stop();
  }
});

test('pairings: a paired one goes a minute after the device got its token, and its token_plain with it', async () => {
  const s = await server();
  try {
    const p = await pairDevice(s);
    s.clock.add(30000);
    assert.deepEqual(s.cleanup(), {});
    assert.equal((await s.request('GET', '/api/pair/' + p.pairId)).json.device_token, p.deviceToken, 'still there after 30 seconds');
    s.clock.add(31000);
    assert.deepEqual(s.cleanup(), { 'pairing(s)': 1 });
    assert.equal(s.count('SELECT COUNT(*) AS n FROM pairings'), 0);
    // The pairing went, the computer and its app stay.
    assert.equal((await s.request('GET', '/api/inbox', { token: p.deviceToken })).status, 200);
    assert.equal((await s.request('GET', '/api/app/me', { token: p.appToken })).status, 200);
  } finally {
    await s.stop();
  }
});

test('a claim the new computer never picked up: after 10 minutes the computer, its app and its packages go', async () => {
  const s = await server();
  try {
    const start = await pairStart(s, 'dev-lost');
    const claim = await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: 'Lost' } });
    const appToken = claim.json.app_token;
    // The app sends before the computer ever asked for its token.
    const { packageId } = await sendPackage(s, appToken, [{ file: 'a.wav', data: SHOT }]);
    assert.ok(fs.existsSync(s.folder(packageId)));
    s.clock.add(9 * MINUTE);
    assert.deepEqual(s.cleanup(), {});
    s.clock.add(2 * MINUTE);
    assert.deepEqual(s.cleanup(), { 'pairing(s)': 1, 'computer(s) that never got their token': 1 });
    assert.equal((await s.request('GET', '/api/app/me', { token: appToken })).status, 401);
    assert.equal((await s.request('GET', '/api/pair/' + start.pair_id)).status, 404);
    assert.equal(fs.existsSync(s.folder(packageId)), false);
    assert.equal(s.count('SELECT COUNT(*) AS n FROM devices'), 0);
    assert.equal(s.count('SELECT COUNT(*) AS n FROM apps'), 0);
    assert.equal(s.count('SELECT COUNT(*) AS n FROM packages'), 0);
  } finally {
    await s.stop();
  }
});

test('an Add app claim the computer never picked up: only the pairing goes, the app keeps working', async () => {
  const s = await server();
  try {
    const first = await pairDevice(s, { deviceId: 'dev-add' });
    const start = await pairStart(s, 'dev-add', first.deviceToken);
    const claim = await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: 'Second', app_id: 'second' } });
    s.clock.add(11 * MINUTE);
    // The pairing of the first app went a minute after its delivery; this one now too.
    assert.deepEqual(s.cleanup(), { 'pairing(s)': 2 });
    assert.equal((await s.request('GET', '/api/app/me', { token: claim.json.app_token })).status, 200);
    assert.equal((await s.request('GET', '/api/inbox', { token: first.deviceToken })).status, 200);
  } finally {
    await s.stop();
  }
});

test('an upload that is not committed within UPLOAD_TTL_MINUTES goes with its files; a committed one stays', async () => {
  const s = await server();
  try {
    const p = await pairDevice(s);
    const created = await s.request('POST', '/api/packages', { token: p.appToken, body: packageManifest([{ file: 'a.wav', data: SHOT }, { file: 'b.wav', data: SHOT }]) });
    const unfinished = created.json.package_id;
    await s.request('PUT', `/api/packages/${unfinished}/files/a.wav`, { token: p.appToken, body: SHOT });
    const sent = await sendPackage(s, p.appToken, [{ file: 'c.wav', data: SHOT }]);
    s.clock.add(59 * MINUTE);
    s.cleanup();
    assert.ok(fs.existsSync(s.folder(unfinished)), 'still uploading after 59 minutes');
    s.clock.add(2 * MINUTE);
    assert.equal(s.cleanup()['unfinished upload(s)'], 1);
    assert.equal(fs.existsSync(s.folder(unfinished)), false);
    assert.equal((await s.request('GET', `/api/packages/${unfinished}/status`, { token: p.appToken })).status, 404);
    assert.equal(s.count('SELECT COUNT(*) AS n FROM files WHERE package_id = ?', unfinished), 0);
    assert.ok(fs.existsSync(s.folder(sent.packageId)));
    assert.equal((await s.request('GET', '/api/inbox', { token: p.deviceToken })).json.packages.length, 1);
  } finally {
    await s.stop();
  }
});

test('waiting and failed packages expire 24 hours after the upload: files gone, status expired, row kept', async () => {
  const s = await server();
  try {
    const p = await pairDevice(s);
    const waiting = await sendPackage(s, p.appToken, [{ file: 'a.wav', data: SHOT }]);
    const failed = await sendPackage(s, p.appToken, [{ file: 'b.wav', data: SHOT }]);
    await s.request('POST', `/api/packages/${failed.packageId}/ack`, { token: p.deviceToken, body: { status: 'failed', error: 'Live stopped.', items: [] } });
    s.clock.add(23 * HOUR);
    s.cleanup();
    assert.equal((await s.request('GET', '/api/inbox', { token: p.deviceToken })).json.packages.length, 2);
    s.clock.add(HOUR + 1000);
    assert.equal(s.cleanup()['expired package(s)'], 2);
    for (const id of [waiting.packageId, failed.packageId]) {
      assert.equal(fs.existsSync(s.folder(id)), false);
      assert.equal((await s.request('GET', `/api/packages/${id}/status`, { token: p.appToken })).json.status, 'expired');
    }
    assert.equal(s.store.db.prepare('SELECT manifest FROM packages WHERE id = ?').get(waiting.packageId).manifest, '');
  } finally {
    await s.stop();
  }
});

test('results stay RESULT_TTL_DAYS after their last change, then the rows go', async () => {
  const s = await server();
  try {
    const p = await pairDevice(s);
    const imported = await sendPackage(s, p.appToken, [{ file: 'a.wav', data: SHOT }]);
    await s.request('POST', `/api/packages/${imported.packageId}/ack`, { token: p.deviceToken, body: { status: 'imported', items: [] } });
    const deleted = await sendPackage(s, p.appToken, [{ file: 'b.wav', data: SHOT }]);
    await s.request('DELETE', `/api/packages/${deleted.packageId}`, { token: p.appToken });
    const expired = await sendPackage(s, p.appToken, [{ file: 'c.wav', data: SHOT }]);
    s.clock.add(DAY + 1000);
    s.cleanup(); // expires the third; its last change is now
    s.clock.add(6 * DAY);
    assert.equal(s.cleanup()['old result(s)'], 2, 'imported and deleted: 7 days and a bit');
    assert.equal((await s.request('GET', `/api/packages/${imported.packageId}/status`, { token: p.appToken })).status, 404);
    assert.equal((await s.request('GET', `/api/packages/${expired.packageId}/status`, { token: p.appToken })).json.status, 'expired');
    s.clock.add(DAY);
    assert.equal(s.cleanup()['old result(s)'], 1);
    assert.equal(s.count('SELECT COUNT(*) AS n FROM packages'), 0);
  } finally {
    await s.stop();
  }
});

test('revoked computers and apps go 30 days after the revoke, once no package refers to them; quiet ones never', async () => {
  const s = await server({ RESULT_TTL_DAYS: '60' });
  try {
    const quiet = await pairDevice(s, { deviceId: 'dev-quiet' });
    const gone = await pairDevice(s, { deviceId: 'dev-gone' });
    const kept = await pairDevice(s, { deviceId: 'dev-kept' });
    // An imported package of "kept" refers to its app and computer for 60 days.
    const sent = await sendPackage(s, kept.appToken, [{ file: 'a.wav', data: SHOT }]);
    await s.request('POST', `/api/packages/${sent.packageId}/ack`, { token: kept.deviceToken, body: { status: 'imported', items: [] } });
    await s.request('POST', '/api/unpair', { token: gone.deviceToken, body: {} });
    await s.request('POST', '/api/unpair', { token: kept.deviceToken, body: {} });
    s.clock.add(29 * DAY);
    const before = s.cleanup();
    assert.equal(before['revoked app(s)'], undefined);
    s.clock.add(2 * DAY);
    const counts = s.cleanup();
    assert.equal(counts['revoked app(s)'], 1);
    assert.equal(counts['revoked computer(s)'], 1);
    assert.equal(s.count("SELECT COUNT(*) AS n FROM devices WHERE device_id = 'dev-gone'"), 0);
    assert.equal(s.count("SELECT COUNT(*) AS n FROM devices WHERE device_id = 'dev-kept'"), 1, 'a package still refers to it');
    s.clock.add(30 * DAY);
    assert.deepEqual(s.cleanup(), { 'old result(s)': 1, 'revoked app(s)': 1, 'revoked computer(s)': 1 });
    // A computer that does not import for a year is still paired.
    s.clock.add(300 * DAY);
    s.cleanup();
    assert.equal((await s.request('GET', '/api/inbox', { token: quiet.deviceToken })).status, 200);
    assert.equal((await s.request('GET', '/api/app/me', { token: quiet.appToken })).status, 200);
  } finally {
    await s.stop();
  }
});

test('at start: leftovers on disk go, the files of waiting packages stay', async () => {
  const s = await server();
  const p = await pairDevice(s);
  const waiting = await sendPackage(s, p.appToken, [{ file: 'a.wav', data: SHOT }]);
  const imported = await sendPackage(s, p.appToken, [{ file: 'b.wav', data: SHOT }]);
  await s.request('POST', `/api/packages/${imported.packageId}/ack`, { token: p.deviceToken, body: { status: 'imported', items: [] } });
  await s.stop({ keepData: true });
  // What a crash or a stop in the middle could leave behind.
  const root = path.join(s.dataDir, 'packages');
  const stray = crypto.randomUUID();
  fs.mkdirSync(path.join(root, stray));
  fs.writeFileSync(path.join(root, stray, 'x.wav'), SHOT);
  fs.mkdirSync(path.join(root, imported.packageId));
  fs.writeFileSync(path.join(root, imported.packageId, 'b.wav'), SHOT);
  fs.writeFileSync(path.join(root, waiting.packageId, 'a.wav.part'), 'half an upload');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not ours');

  const again = await startServer({}, {}, { dataDir: s.dataDir, clock: s.clock });
  try {
    assert.deepEqual(fs.readdirSync(root), [waiting.packageId]);
    assert.deepEqual(fs.readdirSync(path.join(root, waiting.packageId)), ['a.wav']);
    assert.ok(again.lines.some((l) => / cleanup: .*4 leftover file\(s\) and folder\(s\)$/.test(l)), again.lines.join('\n'));
    assert.ok((await again.request('GET', `/api/packages/${waiting.packageId}/files/a.wav`, { token: p.deviceToken })).body.equals(SHOT));
  } finally {
    await again.stop();
  }
});

test('the log has one cleanup line when something went, and none when nothing did', async () => {
  const s = await server();
  try {
    await pairStart(s, 'dev-log');
    s.clock.add(2 * HOUR);
    const linesBefore = s.lines.length;
    s.cleanup();
    s.cleanup();
    const cleanupLines = s.lines.slice(linesBefore).filter((l) => l.includes(' cleanup: '));
    assert.equal(cleanupLines.length, 1);
    assert.match(cleanupLines[0], /^2026-10-16T14:00:00\.000Z cleanup: 1 pairing\(s\)$/);
  } finally {
    await s.stop();
  }
});

test('a cleanup that fails is logged and does not stop the server', async () => {
  const s = await server();
  try {
    const original = s.store.deleteOldPairings;
    s.store.deleteOldPairings = () => {
      throw new Error('disk on fire');
    };
    assert.equal(s.cleanup(), null);
    assert.ok(s.lines.some((l) => l.includes('ERROR cleanup: Error: disk on fire')));
    s.store.deleteOldPairings = original;
    assert.equal((await s.request('GET', '/api/health')).status, 200);
    assert.deepEqual(s.cleanup(), {});
  } finally {
    await s.stop();
  }
});
