'use strict';
// What the developer kit added to the server (sdk/BUILD-PROMPT.md section 7, server 0.7.0):
// removing one app, test receivers, the storage limits per address and for the whole server,
// the X-LA2L-Client header, Retry-After for web apps, and the step of the database to schema 2.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, fakeClock, pairStart, pairDevice, sendPackage, packageManifest, loopWav, shotWav } = require('./helpers');
const { openDb, MIGRATIONS } = require('../src/db');

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const SHOT = shotWav();
// 600 KB: more than half of a limit of 1 MB.
const BIG = Buffer.concat([loopWav(120), Buffer.alloc(600000 - loopWav(120).length)]);

async function server(env = {}, overrides = {}) {
  const clock = fakeClock(Date.parse('2026-10-17T12:00:00.000Z'));
  const s = await startServer(env, overrides, { clock });
  s.clock = clock;
  s.row = (sql, ...args) => s.store.db.prepare(sql).get(...args);
  s.rows = (sql, ...args) => s.store.db.prepare(sql).all(...args);
  s.folder = (id) => path.join(s.dataDir, 'packages', id);
  return s;
}

// A second app for a paired computer, through Settings > Add app.
async function addApp(s, deviceToken, deviceId, appName, headers = {}) {
  const start = await pairStart(s, deviceId, deviceToken);
  const r = await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: appName }, headers });
  assert.equal(r.status, 200);
  await s.request('GET', '/api/pair/' + start.pair_id);
  return r.json.app_token;
}

// ---- DELETE /apps/{id} ----

test('DELETE /apps/{id}: one app stops, with its packages that upload or wait; the rest stays', async () => {
  const s = await server();
  try {
    const p = await pairDevice(s, { deviceId: 'dev-remove', appName: 'LA2L Sender', appId: 'browser-1' });
    const robot = await addApp(s, p.deviceToken, 'dev-remove', 'Robot Voice');
    const kept = await sendPackage(s, p.appToken, [{ file: 'a.wav', data: SHOT }]);
    const waiting = await sendPackage(s, robot, [{ file: 'b.wav', data: SHOT }]);
    const uploading = await s.request('POST', '/api/packages', { token: robot, body: packageManifest([{ file: 'c.wav', data: SHOT }]) });
    await s.request('PUT', `/api/packages/${uploading.json.package_id}/files/c.wav`, { token: robot, body: SHOT });

    const apps = (await s.request('GET', '/api/apps', { token: p.deviceToken })).json.apps;
    assert.deepEqual(apps.map((a) => a.name), ['LA2L Sender', 'Robot Voice']);
    // The id says nothing: not the row number, not the app's own app_id.
    const rows = s.rows('SELECT id, app_id, public_id FROM apps ORDER BY id');
    for (const [i, a] of apps.entries()) {
      assert.match(a.id, /^[0-9a-f]{32}$/);
      assert.equal(a.id, rows[i].public_id);
      assert.notEqual(a.id, String(rows[i].id));
      assert.notEqual(a.id, rows[i].app_id);
    }

    const r = await s.request('DELETE', `/api/apps/${apps[1].id}`, { token: p.deviceToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.ok(s.lines.some((l) => / app \d+ removed by device \d+: 2 package\(s\) deleted$/.test(l)), s.lines.join('\n'));
    assert.equal((await s.request('GET', '/api/app/me', { token: robot })).status, 401);
    assert.ok(!fs.existsSync(s.folder(waiting.packageId)));
    assert.ok(!fs.existsSync(s.folder(uploading.json.package_id)));
    assert.equal(s.row('SELECT COUNT(*) AS n FROM packages WHERE app_ref = (SELECT id FROM apps WHERE public_id = ?)', apps[1].id).n, 0);
    // The computer, its other app and that app's package are untouched.
    const inbox = (await s.request('GET', '/api/inbox', { token: p.deviceToken })).json.packages;
    assert.deepEqual(inbox.map((x) => x.package_id), [kept.packageId]);
    assert.equal((await s.request('GET', '/api/app/me', { token: p.appToken })).status, 200);
    assert.deepEqual((await s.request('GET', '/api/apps', { token: p.deviceToken })).json.apps.map((a) => a.name), ['LA2L Sender']);

    // Gone already, never there, not an id, or another computer's: the same 404.
    const other = await pairDevice(s, { deviceId: 'dev-other', appName: 'Elsewhere' });
    const otherId = (await s.request('GET', '/api/apps', { token: other.deviceToken })).json.apps[0].id;
    for (const id of [apps[1].id, 'f'.repeat(32), 'not-an-id', otherId]) {
      const again = await s.request('DELETE', `/api/apps/${id}`, { token: p.deviceToken });
      assert.equal(again.status, 404, id);
      assert.deepEqual(again.json, { error: 'Unknown app.' });
    }
    assert.equal((await s.request('GET', '/api/app/me', { token: other.appToken })).status, 200, 'the other computer kept its app');
    // Only the device token of that computer works here.
    assert.equal((await s.request('DELETE', `/api/apps/${apps[0].id}`, { token: p.appToken })).status, 401);
    assert.equal((await s.request('DELETE', `/api/apps/${apps[0].id}`)).status, 401);
    // The last app may go too: the computer stays paired, as after "Unpair this browser".
    assert.equal((await s.request('DELETE', `/api/apps/${apps[0].id}`, { token: p.deviceToken })).status, 200);
    assert.deepEqual((await s.request('GET', '/api/apps', { token: p.deviceToken })).json, { apps: [] });
    assert.equal((await s.request('GET', '/api/inbox', { token: p.deviceToken })).status, 200);
  } finally {
    await s.stop();
  }
});

// ---- test receivers ----

test('test receivers: marked at the start, removed with their apps and packages after 7 quiet days', async () => {
  const s = await server();
  try {
    const start = await s.request('POST', '/api/pair/start', { body: { device_id: 'receiver-1', device_name: 'Test receiver', client: 'la2l test receiver', platform: 'web', test: true } });
    assert.equal(start.status, 200);
    assert.ok(s.lines.some((l) => l.endsWith('pairing started: new test receiver')));
    const claim = await s.request('POST', '/api/pair/claim', { body: { code: start.json.code, app_name: 'Web808' } });
    assert.equal(claim.json.device_name, 'Test receiver');
    const deviceToken = (await s.request('GET', '/api/pair/' + start.json.pair_id)).json.device_token;
    const appToken = claim.json.app_token;
    const sent = await sendPackage(s, appToken, [{ file: 'a.wav', data: SHOT }]);
    const real = await pairDevice(s, { deviceId: 'real-computer' });
    // "test" only counts when the start makes a new computer, and only as true.
    const addApp = await s.request('POST', '/api/pair/start', { token: real.deviceToken, body: { device_id: 'real-computer', test: true } });
    assert.equal(addApp.status, 200);
    await s.request('POST', '/api/pair/start', { body: { device_id: 'not-a-test', test: 'yes' } });
    assert.deepEqual(
      s.rows('SELECT device_id, test FROM devices ORDER BY id').map((d) => [d.device_id, d.test]),
      [['receiver-1', 1], ['real-computer', 0]]
    );

    // Quiet for almost 7 days: still there. A call starts the 7 days again.
    s.clock.add(7 * DAY - MINUTE);
    assert.deepEqual(s.cleanup(), { 'pairing(s)': 4, 'expired package(s)': 1 });
    assert.equal((await s.request('GET', '/api/inbox', { token: deviceToken })).status, 200);
    s.clock.add(7 * DAY - MINUTE);
    assert.deepEqual(s.cleanup(), {});
    s.clock.add(2 * MINUTE);
    assert.deepEqual(s.cleanup(), { 'test receiver(s) quiet for 7 days': 1 });
    assert.equal((await s.request('GET', '/api/inbox', { token: deviceToken })).status, 401);
    assert.equal((await s.request('GET', '/api/app/me', { token: appToken })).status, 401);
    assert.equal(s.row("SELECT COUNT(*) AS n FROM devices WHERE device_id = 'receiver-1'").n, 0);
    assert.equal(s.row('SELECT COUNT(*) AS n FROM packages WHERE id = ?', sent.packageId).n, 0);
    assert.ok(!fs.existsSync(s.folder(sent.packageId)));
    // A real computer is never removed for being quiet.
    s.clock.add(365 * DAY);
    s.cleanup();
    assert.equal((await s.request('GET', '/api/inbox', { token: real.deviceToken })).status, 200);
  } finally {
    await s.stop();
  }
});

test('the state line at start counts test receivers apart', async () => {
  const s = await startServer();
  await pairDevice(s, { deviceId: 'real-1' });
  const start = await s.request('POST', '/api/pair/start', { body: { device_id: 'receiver-2', device_name: 'Test receiver', test: true } });
  await s.request('POST', '/api/pair/claim', { body: { code: start.json.code, app_name: 'Web808' } });
  await s.stop({ keepData: true });
  const again = await startServer({}, {}, { dataDir: s.dataDir });
  try {
    assert.ok(
      again.lines.some((l) => l.endsWith('state: 1 computer(s) and 1 app(s) paired, 0 package(s) waiting; test receivers: 1 with 1 app(s)')),
      again.lines.join('\n')
    );
  } finally {
    await again.stop();
  }
});

// ---- storage ----

test('storage per address: MAX_ADDRESS_STORAGE_MB for everything sent from one address, an IPv6 /64 as one', async () => {
  const s = await server({ MAX_ADDRESS_STORAGE_MB: '1', TRUST_PROXY: '1' });
  const from = (ip) => ({ 'X-Forwarded-For': ip });
  const sounds = [{ file: 'big.wav', data: BIG }];
  try {
    const a = await pairDevice(s, { deviceId: 'computer-a' });
    const b = await pairDevice(s, { deviceId: 'computer-b' });
    const first = await s.request('POST', '/api/packages', { token: a.appToken, body: packageManifest(sounds), headers: from('203.0.113.7') });
    assert.equal(first.status, 201);
    // Another computer, the same address: refused. Another address: fine.
    const second = await s.request('POST', '/api/packages', { token: b.appToken, body: packageManifest(sounds), headers: from('203.0.113.7') });
    assert.equal(second.status, 507);
    assert.deepEqual(second.json, { error: 'Too many sounds wait from this address. Try again later.' });
    assert.equal((await s.request('POST', '/api/packages', { token: b.appToken, body: packageManifest(sounds), headers: from('203.0.113.8') })).status, 201);
    // Two addresses of one IPv6 /64 count as one; another /64 has room of its own.
    const c = await pairDevice(s, { deviceId: 'computer-c' });
    const d = await pairDevice(s, { deviceId: 'computer-d' });
    assert.equal((await s.request('POST', '/api/packages', { token: c.appToken, body: packageManifest(sounds), headers: from('2001:db8:1:2::1') })).status, 201);
    assert.equal((await s.request('POST', '/api/packages', { token: d.appToken, body: packageManifest(sounds), headers: from('2001:db8:1:2:aaaa::9') })).status, 507);
    assert.equal((await s.request('POST', '/api/packages', { token: d.appToken, body: packageManifest(sounds), headers: from('2001:db8:1:3::1') })).status, 201);

    // The database never has the address itself, and keeps even its hash only while there are files.
    const senders = s.rows('SELECT sender FROM packages WHERE sender IS NOT NULL').map((r) => r.sender);
    assert.equal(senders.length, 4);
    for (const h of senders) assert.match(h, /^[0-9a-f]{32}$/);
    const dump = s.rows('SELECT * FROM packages').map((r) => JSON.stringify(r)).join('\n');
    for (const ip of ['203.0.113.7', '2001:db8:1:2']) assert.ok(!dump.includes(ip), ip);
    await s.request('DELETE', `/api/packages/${first.json.package_id}`, { token: a.appToken });
    assert.equal(s.row('SELECT sender FROM packages WHERE id = ?', first.json.package_id).sender, null);
    // So the address has room again.
    assert.equal((await s.request('POST', '/api/packages', { token: b.appToken, body: packageManifest(sounds), headers: from('203.0.113.7') })).status, 201);
  } finally {
    await s.stop();
  }
});

test('storage for the whole server: MAX_TOTAL_STORAGE_MB, with a warning at STORAGE_WARN_PERCENT at most once an hour', async () => {
  const s = await server({ MAX_TOTAL_STORAGE_MB: '1', STORAGE_WARN_PERCENT: '50' });
  const warnings = () => s.lines.filter((l) => l.includes('WARNING storage'));
  try {
    assert.equal(s.checkStorage(), false, 'nothing stored yet');
    const a = await pairDevice(s, { deviceId: 'computer-a' });
    const b = await pairDevice(s, { deviceId: 'computer-b' });
    const first = await sendPackage(s, a.appToken, [{ file: 'big.wav', data: BIG }]);
    const second = await s.request('POST', '/api/packages', { token: b.appToken, body: packageManifest([{ file: 'big.wav', data: BIG }]) });
    assert.equal(second.status, 507);
    assert.deepEqual(second.json, { error: 'The server is full. Try again later.' });

    assert.equal(s.checkStorage(), true);
    assert.match(warnings()[0], /Z WARNING storage: packages take 0\.0 GB of 0\.0 GB \(57%\)\. New packages are refused above 0\.0 GB \(MAX_TOTAL_STORAGE_MB\)\.$/);
    s.clock.add(59 * MINUTE);
    assert.equal(s.checkStorage(), false, 'once an hour');
    s.clock.add(MINUTE);
    assert.equal(s.checkStorage(), true);
    assert.equal(warnings().length, 2);
    // Below the line and over it again within the hour, as packages come and go: no new warning
    // until the hour is over.
    await s.request('POST', `/api/packages/${first.packageId}/ack`, { token: a.deviceToken, body: { status: 'imported', items: [] } });
    assert.equal(s.checkStorage(), false);
    await sendPackage(s, b.appToken, [{ file: 'big.wav', data: BIG }]);
    s.clock.add(59 * MINUTE);
    assert.equal(s.checkStorage(), false);
    s.clock.add(MINUTE);
    assert.equal(s.checkStorage(), true);
    assert.equal(warnings().length, 3);
  } finally {
    await s.stop();
  }
});

// ---- headers ----

test('X-LA2L-Client: on the log line, cleaned, and kept per app', async () => {
  const s = await server();
  try {
    const start = await pairStart(s, 'dev-client');
    const claim = await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: 'Web808' }, headers: { 'X-LA2L-Client': 'la2l-js/0.1.0 (Web808)' } });
    const token = claim.json.app_token;
    const claimLine = s.lines.find((l) => / POST \/api\/pair\/claim 200 /.test(l));
    assert.match(claimLine, / client="la2l-js\/0\.1\.0 \(Web808\)"$/);
    const client = () => s.row('SELECT client FROM apps WHERE name = ?', 'Web808').client;
    assert.equal(client(), 'la2l-js/0.1.0 (Web808)');
    // A newer version is kept; a call without the header changes nothing.
    await s.request('GET', '/api/app/me', { token, headers: { 'X-LA2L-Client': 'la2l-js/0.2.0 (Web808)' } });
    await s.request('GET', '/api/app/me', { token });
    assert.equal(client(), 'la2l-js/0.2.0 (Web808)');
    assert.doesNotMatch(s.lines[s.lines.length - 1], /client=/);
    // Quotes, control characters and length are cleaned before the log or the database see them.
    await s.request('GET', '/api/app/me', { token, headers: { 'X-LA2L-Client': 'evil "app"\t' + 'x'.repeat(200) } });
    const line = s.lines[s.lines.length - 1];
    const logged = /client="([^"]*)"$/.exec(line)[1];
    assert.equal(logged, `evil 'app' ${'x'.repeat(89)}`);
    assert.equal(client(), logged);
    assert.equal(logged.length, 100);
  } finally {
    await s.stop();
  }
});

test('a 429 tells a web app how long to wait: Retry-After is readable across origins', async () => {
  const s = await server({ RATE_LIMITS: 'on' });
  try {
    let r;
    for (let i = 0; i < 11; i++) r = await s.request('POST', '/api/pair/claim', { body: { code: 'AAAAAA', app_name: 'x' }, headers: { Origin: 'https://example.org' } });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers['retry-after']) >= 1);
    assert.match(r.headers['access-control-expose-headers'], /(^|, )Retry-After(,|$)/);
    assert.equal(r.headers['access-control-allow-origin'], '*');
  } finally {
    await s.stop();
  }
});

// ---- the database ----

test('schema 2: a database of server 0.6.0 is brought up to date and keeps everything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-schema-'));
  try {
    // A database as server 0.6.0 left it: schema 1, one computer with two apps and a package.
    const old = new DatabaseSync(path.join(dir, 'la2l.db'));
    old.exec(MIGRATIONS[0]);
    old.exec('PRAGMA user_version = 1');
    const now = '2026-10-17T10:00:00.000Z';
    old.prepare("INSERT INTO devices (device_id, name, token_hash, created_at) VALUES ('dev-old', 'ERIK-PC', ?, ?)").run('d'.repeat(64), now);
    for (const [name, hash] of [['LA2L Sender', 'a'], ['Robot Voice', 'b']]) {
      old.prepare('INSERT INTO apps (device_ref, name, token_hash, created_at) VALUES (1, ?, ?, ?)').run(name, hash.repeat(64), now);
    }
    old
      .prepare(
        "INSERT INTO packages (id, device_ref, app_ref, title, app_name, item_count, total_bytes, manifest, status, created_at, expires_at, updated_at) VALUES ('p1', 1, 1, 'Old', 'LA2L Sender', 1, 10, '{}', 'waiting', ?, ?, ?)"
      )
      .run(now, now, now);
    old.close();

    const db = openDb(dir);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
      assert.equal(MIGRATIONS.length, 2);
      const apps = db.prepare('SELECT name, public_id, client FROM apps ORDER BY id').all();
      assert.deepEqual(apps.map((a) => [a.name, a.client]), [['LA2L Sender', ''], ['Robot Voice', '']]);
      for (const a of apps) assert.match(a.public_id, /^[0-9a-f]{32}$/);
      assert.notEqual(apps[0].public_id, apps[1].public_id);
      assert.equal(db.prepare('SELECT test FROM devices').get().test, 0);
      assert.deepEqual({ ...db.prepare('SELECT status, sender FROM packages').get() }, { status: 'waiting', sender: null });
      assert.throws(() => db.prepare("UPDATE apps SET public_id = ? WHERE name = 'Robot Voice'").run(apps[0].public_id), /UNIQUE/);
    } finally {
      db.close();
    }
    // A database from a server newer than this one is not touched.
    const newer = new DatabaseSync(path.join(dir, 'la2l.db'));
    newer.exec('PRAGMA user_version = 3');
    newer.close();
    assert.throws(() => openDb(dir), { message: 'The database is from a newer la2l-server (schema 3, this one knows 2). Update the server.' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
