'use strict';
// Pairing: the device routes of section 7 and the app routes of section 8 that pairing needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, fakeClock, pairStart, pairDevice } = require('./helpers');
const { Server, readApps } = require('../../src/node/server');
const { CODE_ALPHABET, sha256 } = require('../src/tokens');

const WRONG_CODE = { error: 'This code does not work. Check the code in Live.' };

let s;
let clock;
test.before(async () => {
  clock = fakeClock();
  s = await startServer({}, {}, { clock });
});
test.after(() => s.stop());

test('pair/start: a code, a long pair id, and the times the device counts with', async () => {
  const r = await s.request('POST', '/api/pair/start', { body: { device_id: 'a1b2-c3', device_name: 'ERIK-PC', client: 'LA2L 0.1.1', platform: 'win32' } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['code', 'expires_at', 'expires_in', 'pair_id', 'poll_ms']);
  assert.match(r.json.pair_id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.code.length, 6);
  for (const ch of r.json.code) assert.ok(CODE_ALPHABET.includes(ch), ch);
  assert.equal(r.json.expires_in, 600);
  assert.equal(r.json.expires_at, new Date(clock() + 600000).toISOString());
  assert.equal(r.json.poll_ms, 2000);
  assert.deepEqual((await s.request('GET', '/api/pair/' + r.json.pair_id)).json, { status: 'waiting' });
});

test('pair/start: device_id is required, and the other fields are cleaned', async () => {
  for (const body of [{}, { device_id: '' }, { device_id: 'has space' }, { device_id: 'x'.repeat(101) }, { device_id: 42 }]) {
    const r = await s.request('POST', '/api/pair/start', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.json, { error: 'device_id is missing.' });
  }
  const start = await s.request('POST', '/api/pair/start', { body: { device_id: 'clean-1', device_name: ' \u0007My​  PC\n' + 'x'.repeat(80) } });
  const claim = await s.request('POST', '/api/pair/claim', { body: { code: start.json.code, app_name: 'App' } });
  assert.equal(claim.json.device_name, ('My PC ' + 'x'.repeat(80)).slice(0, 64));
  const unnamed = await s.request('POST', '/api/pair/start', { body: { device_id: 'clean-2' } });
  const claim2 = await s.request('POST', '/api/pair/claim', { body: { code: unnamed.json.code } });
  assert.equal(claim2.json.device_name, 'Computer');
});

test('JSON bodies: invalid JSON 400, another type 415, larger than 1 MB 413', async () => {
  const bad = await s.request('POST', '/api/pair/start', { headers: { 'Content-Type': 'application/json' }, body: '{"device_id": ' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, { error: 'The request is not valid JSON.' });
  for (const notAnObject of ['null', '[1, 2]', '"text"', '42']) {
    const r = await s.request('POST', '/api/pair/start', { headers: { 'Content-Type': 'application/json' }, body: notAnObject });
    assert.equal(r.status, 400, notAnObject);
    assert.deepEqual(r.json, { error: 'Send a JSON object.' });
  }
  const type = await s.request('POST', '/api/pair/start', { headers: { 'Content-Type': 'text/plain' }, body: '{"device_id":"x"}' });
  assert.equal(type.status, 415);
  const charset = await s.request('POST', '/api/pair/start', { headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"device_id":"x"}' });
  assert.equal(charset.status, 200);
  const big = await s.request('POST', '/api/pair/start', { headers: { 'Content-Type': 'application/json' }, body: '{"x":"' + 'a'.repeat(1048576) + '"}' });
  assert.equal(big.status, 413);
});

test('claim: the paired device gets its token, twice within 60 seconds, then 404', async () => {
  const start = await pairStart(s, 'dev-claim');
  const claim = await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: 'LA2L Sender', app_id: 'browser-1' } });
  assert.equal(claim.status, 200);
  assert.match(claim.json.app_token, /^la2la_[A-Za-z0-9_-]{43}$/);
  assert.equal(claim.json.device_name, 'ERIK-PC');
  const first = await s.request('GET', '/api/pair/' + start.pair_id);
  assert.equal(first.json.status, 'paired');
  assert.match(first.json.device_token, /^la2ld_[A-Za-z0-9_-]{43}$/);
  assert.equal(first.json.app_name, 'LA2L Sender');
  clock.add(59000);
  assert.deepEqual((await s.request('GET', '/api/pair/' + start.pair_id)).json, first.json, 'the same answer again');
  clock.add(2000);
  const gone = await s.request('GET', '/api/pair/' + start.pair_id);
  assert.equal(gone.status, 404);
  assert.deepEqual(gone.json, { error: 'Unknown pairing.' });
  // Both tokens work.
  assert.deepEqual((await s.request('GET', '/api/inbox', { token: first.json.device_token })).json, { packages: [] });
  const me = await s.request('GET', '/api/app/me', { token: claim.json.app_token });
  assert.deepEqual(me.json, { device_name: 'ERIK-PC', app_name: 'LA2L Sender', paired_at: new Date(clock() - 61000).toISOString() });
});

test('claim: the code may be typed in any case, with spaces or a dash', async () => {
  for (const shape of [(c) => c.toLowerCase(), (c) => `${c.slice(0, 3)} ${c.slice(3)}`, (c) => `${c.slice(0, 3)}-${c.slice(3)}`, (c) => ` ${c} `]) {
    const start = await pairStart(s, 'dev-shape');
    const r = await s.request('POST', '/api/pair/claim', { body: { code: shape(start.code), app_name: 'A' } });
    assert.equal(r.status, 200, shape(start.code));
  }
});

test('claim: a wrong, a used, an expired and a cancelled code all get the same 404', async () => {
  for (const code of ['', 'ABC', 'IIIIII', 'OOOOOO', 'K7P42Q!', 12, null]) {
    const r = await s.request('POST', '/api/pair/claim', { body: { code, app_name: 'A' } });
    assert.equal(r.status, 404, String(code));
    assert.deepEqual(r.json, WRONG_CODE);
  }
  const used = await pairStart(s, 'dev-used');
  assert.equal((await s.request('POST', '/api/pair/claim', { body: { code: used.code } })).status, 200);
  assert.deepEqual((await s.request('POST', '/api/pair/claim', { body: { code: used.code } })).json, WRONG_CODE);

  const old = await pairStart(s, 'dev-expired');
  clock.add(600000);
  assert.deepEqual((await s.request('GET', '/api/pair/' + old.pair_id)).json, { status: 'expired' });
  assert.deepEqual((await s.request('POST', '/api/pair/claim', { body: { code: old.code } })).json, WRONG_CODE);

  const cancelled = await pairStart(s, 'dev-cancel');
  const c = await s.request('POST', `/api/pair/${cancelled.pair_id}/cancel`);
  assert.deepEqual(c.json, { ok: true });
  assert.deepEqual((await s.request('GET', '/api/pair/' + cancelled.pair_id)).json, { status: 'cancelled' });
  assert.deepEqual((await s.request('POST', '/api/pair/claim', { body: { code: cancelled.code } })).json, WRONG_CODE);
});

test('one code per computer: a new start cancels the older code', async () => {
  const first = await pairStart(s, 'dev-twice');
  const second = await pairStart(s, 'dev-twice');
  assert.deepEqual((await s.request('GET', '/api/pair/' + first.pair_id)).json, { status: 'cancelled' });
  assert.deepEqual((await s.request('GET', '/api/pair/' + second.pair_id)).json, { status: 'waiting' });
  assert.deepEqual((await s.request('POST', '/api/pair/claim', { body: { code: first.code } })).json, WRONG_CODE);
});

test('unknown pair ids: 404, also for ids that cannot be one', async () => {
  for (const id of ['x'.repeat(43), 'short', 'a'.repeat(101), '%E0%A4%A', '..%2F..%2Fetc', 'abc$def'.repeat(4)]) {
    for (const [method, suffix] of [['GET', ''], ['POST', '/cancel']]) {
      const r = await s.request(method, `/api/pair/${id}${suffix}`);
      assert.equal(r.status, 404, `${method} ${id}${suffix}`);
      assert.deepEqual(r.json, { error: 'Unknown pairing.' });
    }
  }
});

test('Add app: the second app joins the same computer, and the device keeps its token', async () => {
  const one = await pairDevice(s, { deviceId: 'dev-add', appName: 'Web808' });
  const start = await pairStart(s, 'dev-add', one.deviceToken);
  const claim = await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: 'Robot Voice' } });
  assert.equal(claim.status, 200);
  const paired = await s.request('GET', '/api/pair/' + start.pair_id);
  assert.equal(paired.json.device_token, one.deviceToken);
  assert.equal(paired.json.app_name, 'Robot Voice');
  assert.equal((await s.request('GET', '/api/app/me', { token: one.appToken })).status, 200, 'the first app still works');
  assert.equal((await s.request('GET', '/api/app/me', { token: claim.json.app_token })).status, 200);
  assert.equal((await s.request('GET', '/api/inbox', { token: one.deviceToken })).status, 200);
});

test('a revoked token on pair/start gives a fresh pairing with a new token', async () => {
  const one = await pairDevice(s, { deviceId: 'dev-revoked' });
  assert.deepEqual((await s.request('POST', '/api/unpair', { body: {}, token: one.deviceToken })).json, { ok: true });
  const start = await s.request('POST', '/api/pair/start', { body: { device_id: 'dev-revoked' }, token: one.deviceToken });
  assert.equal(start.status, 200, 'no 401: device 0.1.1 would stay stuck');
  await s.request('POST', '/api/pair/claim', { body: { code: start.json.code } });
  const paired = await s.request('GET', '/api/pair/' + start.json.pair_id);
  assert.notEqual(paired.json.device_token, one.deviceToken);
  assert.equal((await s.request('GET', '/api/inbox', { token: paired.json.device_token })).status, 200);
  assert.equal((await s.request('GET', '/api/inbox', { token: one.deviceToken })).status, 401);
});

test('a fresh pairing for a known computer revokes its old token and the apps of it', async () => {
  const old = await pairDevice(s, { deviceId: 'dev-lost', appName: 'Old app' });
  // The computer lost its token (unpaired while offline): it pairs without one.
  const fresh = await pairDevice(s, { deviceId: 'dev-lost', appName: 'New app' });
  assert.notEqual(fresh.deviceToken, old.deviceToken);
  assert.equal((await s.request('GET', '/api/inbox', { token: old.deviceToken })).status, 401);
  assert.equal((await s.request('GET', '/api/app/me', { token: old.appToken })).status, 401);
  assert.equal((await s.request('GET', '/api/app/me', { token: fresh.appToken })).status, 200);
});

test('pairing again with the same app_id replaces the old token of that app', async () => {
  const one = await pairDevice(s, { deviceId: 'dev-appid', appId: 'browser-x' });
  const start = await pairStart(s, 'dev-appid', one.deviceToken);
  const again = await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: 'LA2L Sender', app_id: 'browser-x' } });
  assert.equal((await s.request('GET', '/api/app/me', { token: one.appToken })).status, 401);
  assert.equal((await s.request('GET', '/api/app/me', { token: again.json.app_token })).status, 200);
});

test('claim: an app_name that is not text becomes "App"', async () => {
  for (const appName of [{ toString: 0 }, 808, ['a']]) {
    const start = await pairStart(s, 'odd-name');
    const r = await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: appName } });
    assert.equal(r.status, 200, r.body.toString());
    assert.equal((await s.request('GET', '/api/pair/' + start.pair_id)).json.app_name, 'App');
  }
});

test('app_name is cleaned like a track name, 40 characters at most', async () => {
  const start = await pairStart(s, 'dev-name');
  await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: 'Robot <b>Voice</b>; "x" ' + 'é'.repeat(50) } });
  const paired = await s.request('GET', '/api/pair/' + start.pair_id);
  assert.equal(paired.json.app_name, ('Robot b Voice b x ' + 'é'.repeat(50)).slice(0, 40));
  const none = await pairStart(s, 'dev-name-2');
  await s.request('POST', '/api/pair/claim', { body: { code: none.code } });
  assert.equal((await s.request('GET', '/api/pair/' + none.pair_id)).json.app_name, 'App');
});

test('401 only for an unknown or revoked token, and tokens only work on their own side', async () => {
  const p = await pairDevice(s, { deviceId: 'dev-401' });
  for (const [path, method] of [['/api/inbox', 'GET'], ['/api/apps', 'GET'], ['/api/unpair', 'POST'], ['/api/app/me', 'GET'], ['/api/app/unpair', 'POST']]) {
    for (const auth of [undefined, 'Bearer', 'Bearer short', 'Basic abc', `Bearer ${'x'.repeat(43)}`]) {
      const r = await s.request(method, path, { headers: auth ? { Authorization: auth } : {}, body: method === 'POST' ? {} : undefined });
      assert.equal(r.status, 401, `${method} ${path} ${auth}`);
      assert.equal(typeof r.json.error, 'string');
    }
  }
  assert.equal((await s.request('GET', '/api/app/me', { token: p.deviceToken })).status, 401, 'device token on an app route');
  assert.equal((await s.request('GET', '/api/inbox', { token: p.appToken })).status, 401, 'app token on a device route');
});

test('app/unpair: the app token stops working, the computer stays paired', async () => {
  const p = await pairDevice(s, { deviceId: 'dev-app-unpair' });
  assert.deepEqual((await s.request('POST', '/api/app/unpair', { token: p.appToken })).json, { ok: true });
  assert.equal((await s.request('GET', '/api/app/me', { token: p.appToken })).status, 401);
  assert.equal((await s.request('GET', '/api/inbox', { token: p.deviceToken })).status, 200);
});

test('unpair: the device token and every app token of that computer stop working', async () => {
  const p = await pairDevice(s, { deviceId: 'dev-unpair' });
  const start = await pairStart(s, 'dev-unpair', p.deviceToken);
  const second = await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: 'Second' } });
  assert.deepEqual((await s.request('POST', '/api/unpair', { body: {}, token: p.deviceToken })).json, { ok: true });
  assert.equal((await s.request('GET', '/api/inbox', { token: p.deviceToken })).status, 401);
  assert.equal((await s.request('GET', '/api/app/me', { token: p.appToken })).status, 401);
  assert.equal((await s.request('GET', '/api/app/me', { token: second.json.app_token })).status, 401);
});

test('GET /apps: the apps that can send to this computer now, oldest first', async () => {
  const at = () => new Date(clock()).toISOString();
  const list = async (token) => {
    const r = await s.request('GET', '/api/apps', { token });
    assert.equal(r.status, 200);
    return r.json.apps;
  };
  const addApp = async (deviceToken, appName, appId) => {
    const start = await pairStart(s, 'dev-apps', deviceToken);
    return (await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: appName, app_id: appId } })).json.app_token;
  };
  const first = await pairDevice(s, { deviceId: 'dev-apps', appName: 'LA2L Sender', appId: 'browser-1' });
  const t1 = at();
  assert.deepEqual(await list(first.deviceToken), [{ name: 'LA2L Sender', paired_at: t1, last_seen_at: null }]);

  // Add app twice: another app, and the same app in a second browser.
  clock.add(1000);
  const robot = await addApp(first.deviceToken, 'Robot Voice', 'robot-1');
  const t2 = at();
  clock.add(1000);
  const second = await addApp(first.deviceToken, 'LA2L Sender', 'browser-2');
  const t3 = at();
  clock.add(1000);
  await s.request('GET', '/api/app/me', { token: robot });
  assert.deepEqual(await list(first.deviceToken), [
    { name: 'LA2L Sender', paired_at: t1, last_seen_at: null },
    { name: 'Robot Voice', paired_at: t2, last_seen_at: at() },
    { name: 'LA2L Sender', paired_at: t3, last_seen_at: null },
  ]);

  // Pairing browser-1 again replaces its old entry; an app that unpairs itself is gone.
  clock.add(1000);
  const firstAgain = await addApp(first.deviceToken, 'LA2L Sender', 'browser-1');
  const t4 = at();
  await s.request('POST', '/api/app/unpair', { token: second });
  assert.deepEqual((await list(first.deviceToken)).map((a) => [a.name, a.paired_at]), [['Robot Voice', t2], ['LA2L Sender', t4]]);

  // The device's own client reads it; another computer's apps are not in it.
  const client = new Server(s.base, () => first.deviceToken);
  assert.deepEqual(readApps(await client.apps()), { count: 2, names: ['Robot Voice', 'LA2L Sender'] });
  const other = await pairDevice(s, { deviceId: 'dev-apps-other', appName: 'Elsewhere' });
  assert.deepEqual((await list(other.deviceToken)).map((a) => a.name), ['Elsewhere']);

  // Every app unpaired itself: an empty list, and the computer is still paired.
  for (const token of [robot, firstAgain]) await s.request('POST', '/api/app/unpair', { token });
  assert.deepEqual(await list(first.deviceToken), []);
  assert.equal((await s.request('GET', '/api/inbox', { token: first.deviceToken })).status, 200);
  // Unpair in Live: 401, as for every device call.
  await s.request('POST', '/api/unpair', { body: {}, token: first.deviceToken });
  assert.equal((await s.request('GET', '/api/apps', { token: first.deviceToken })).status, 401);
});

test('the device client of LA2L 0.1.1 pairs, reads the inbox and unpairs', async () => {
  let token = null;
  const server = new Server(s.base, () => token);
  const start = await server.pairStart({ device_id: 'dev-client', device_name: 'ERIK-PC', client: 'LA2L 0.1.1', platform: 'win32' });
  assert.deepEqual(await server.pairStatus(start.pair_id), { status: 'waiting' });
  await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: 'LA2L Sender' } });
  const paired = await server.pairStatus(start.pair_id);
  assert.equal(paired.status, 'paired');
  token = paired.device_token;
  assert.deepEqual(await server.inbox(), { packages: [] });
  assert.deepEqual(await server.unpair(), { ok: true });
  await assert.rejects(server.inbox(), (e) => e.kind === 'unauthorized');
  const other = await server.pairStart({ device_id: 'dev-client-2' });
  assert.deepEqual(await server.pairCancel(other.pair_id), { ok: true });
});

test('restart: pairings and tokens are still there', async () => {
  const c = fakeClock();
  const a = await startServer({}, {}, { clock: c });
  const p = await pairDevice(a, { deviceId: 'dev-restart' });
  const waiting = await pairStart(a, 'dev-restart-2');
  await a.stop({ keepData: true });
  const b = await startServer({}, {}, { clock: c, dataDir: a.dataDir });
  try {
    assert.equal((await b.request('GET', '/api/inbox', { token: p.deviceToken })).status, 200);
    assert.equal((await b.request('GET', '/api/app/me', { token: p.appToken })).status, 200);
    assert.deepEqual((await b.request('GET', '/api/pair/' + waiting.pair_id)).json, { status: 'waiting' });
  } finally {
    await b.stop();
  }
});

test('rate limits: codes per address, claims per address, with Retry-After', async () => {
  const c = fakeClock();
  const t = await startServer({ RATE_LIMITS: 'on', TRUST_PROXY: '1' }, {}, { clock: c });
  try {
    const from = (ip) => ({ 'X-Forwarded-For': ip });
    for (let i = 0; i < 10; i++) {
      assert.equal((await t.request('POST', '/api/pair/claim', { headers: from('203.0.113.7'), body: { code: 'AAAAAA' } })).status, 404);
    }
    const r = await t.request('POST', '/api/pair/claim', { headers: from('203.0.113.7'), body: { code: 'AAAAAA' } });
    assert.equal(r.status, 429);
    assert.deepEqual(r.json, { error: 'Too many tries. Wait a minute and try again.' });
    assert.equal(r.headers['retry-after'], '60');
    assert.equal((await t.request('POST', '/api/pair/claim', { headers: from('203.0.113.8'), body: { code: 'AAAAAA' } })).status, 404, 'another address');
    // IPv6: one /64 is one address.
    for (let i = 0; i < 10; i++) await t.request('POST', '/api/pair/claim', { headers: from(`2001:db8:1:2::${i + 1}`), body: { code: 'AAAAAA' } });
    assert.equal((await t.request('POST', '/api/pair/claim', { headers: from('2001:db8:1:2:aaaa::1'), body: { code: 'AAAAAA' } })).status, 429);
    c.add(60001);
    assert.equal((await t.request('POST', '/api/pair/claim', { headers: from('203.0.113.7'), body: { code: 'AAAAAA' } })).status, 404, 'a minute later');

    for (let i = 0; i < 20; i++) await t.request('POST', '/api/pair/start', { headers: from('198.51.100.1'), body: { device_id: 'rl-' + i } });
    const many = await t.request('POST', '/api/pair/start', { headers: from('198.51.100.1'), body: { device_id: 'rl-x' } });
    assert.equal(many.status, 429);
    assert.deepEqual(many.json, { error: 'Too many codes asked. Wait a few minutes.' });
  } finally {
    await t.stop();
  }
});

test('rate limits: status calls per address, and calls per token', async () => {
  const c = fakeClock();
  const t = await startServer({ RATE_LIMITS: 'on', TRUST_PROXY: '1' }, {}, { clock: c });
  try {
    const from = { 'X-Forwarded-For': '198.51.100.9' };
    const start = await t.request('POST', '/api/pair/start', { headers: from, body: { device_id: 'rl-status' } });
    // The device asks every 2 seconds, 30 times a minute; 120 is the limit.
    for (let i = 0; i < 120; i++) assert.equal((await t.request('GET', '/api/pair/' + start.json.pair_id, { headers: from })).status, 200);
    const status = await t.request('GET', '/api/pair/' + start.json.pair_id, { headers: from });
    assert.equal(status.status, 429);
    assert.deepEqual(status.json, { error: 'Too many requests. Wait a minute.' });

    c.add(60001);
    const p = await pairDevice(t, { deviceId: 'rl-token' });
    for (let i = 0; i < 600; i++) {
      const r = await t.request('GET', '/api/app/me', { token: p.appToken });
      if (r.status !== 200) assert.fail(`call ${i + 1} answered ${r.status}`);
    }
    const tooMany = await t.request('GET', '/api/app/me', { token: p.appToken });
    assert.equal(tooMany.status, 429);
    assert.ok(Number(tooMany.headers['retry-after']) >= 1);
    // The computer has a count of its own.
    assert.equal((await t.request('GET', '/api/inbox', { token: p.deviceToken })).status, 200);
  } finally {
    await t.stop();
  }
});

test('the database keeps hashes of tokens and pair ids; the device token only until the device has it', async () => {
  const clock = fakeClock();
  const t = await startServer({}, {}, { clock });
  try {
    const p = await pairDevice(t);
    const db = t.store.db;
    const one = (sql, ...args) => db.prepare(sql).get(...args);
    assert.ok(one('SELECT 1 AS x FROM devices WHERE token_hash = ?', sha256(p.deviceToken)));
    assert.ok(one('SELECT 1 AS x FROM apps WHERE token_hash = ?', sha256(p.appToken)));
    assert.ok(one('SELECT 1 AS x FROM pairings WHERE pair_hash = ?', sha256(p.pairId)));
    const dump = () => ['devices', 'apps', 'pairings', 'packages'].map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).join('');
    assert.ok(!dump().includes(p.appToken) && !dump().includes(p.pairId));
    // The paired answer hands the device token out for a minute after the first delivery.
    assert.ok(dump().includes(p.deviceToken));
    clock.add(61000);
    t.cleanup();
    assert.ok(!dump().includes(p.deviceToken));
  } finally {
    await t.stop();
  }
});

test('the log never has a token, a pair id or a code', async () => {
  const c = fakeClock();
  const t = await startServer({}, {}, { clock: c });
  try {
    const p = await pairDevice(t, { deviceId: 'dev-log' });
    await t.request('GET', '/api/inbox', { token: p.deviceToken });
    await t.request('GET', '/api/app/me', { token: p.appToken });
    await t.request('POST', '/api/app/unpair', { token: p.appToken });
    await t.request('POST', '/api/unpair', { body: {}, token: p.deviceToken });
    const text = t.lines.join('\n');
    for (const secret of [p.pairId, p.code, p.appToken, p.deviceToken, p.appToken.slice(6), p.deviceToken.slice(6), 'Bearer']) {
      assert.ok(!text.includes(secret), `${secret.slice(0, 10)}... in the log`);
    }
    assert.match(text, /GET \/api\/pair\/:id 200 .* device=\d+ /);
    assert.match(text, /pairing claimed: app \d+ on new device \d+/);
  } finally {
    await t.stop();
  }
});
