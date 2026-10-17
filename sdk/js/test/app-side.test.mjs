// The same app-side tests against the real server (server/src, started in this process) and
// against the local test receiver of la2l/testing: every status and every text must be the same,
// so an app tested against the local one works against lloydstellar.nl. In both, a test receiver
// plays the computer with LA2L, and imports what the apps send.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LA2L, La2lError, memoryStorage, wavFromSamples } from '../dist/index.js';
import { TestReceiver, startTestReceiver } from '../dist/testing/index.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURES = path.join(ROOT, 'sdk', 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const WRONG_CODE = { error: 'This code does not work. Check the code in Live.' };
const APP_401 = { error: 'Unknown token. Pair this app again.' };

// The two servers, each with a test receiver as its computer.
const TARGETS = {
  async 'la2l-server'() {
    const helpers = require(path.join(ROOT, 'server', 'test', 'helpers.js'));
    const s = await helpers.startServer({ POLL_MS: '500' });
    const reports = [];
    const receiver = new TestReceiver({ server: s.base, pollMs: 200, appsMs: 0, onReport: (r) => reports.push(r) });
    return { base: s.base, reports, code: () => receiver.pair(), close: async () => (receiver.close(), s.stop()) };
  },
  async 'local test receiver'() {
    const local = await startTestReceiver();
    let first = local.code;
    return {
      base: local.server,
      reports: local.reports,
      code: async () => {
        const c = first || (await local.newCode());
        first = null;
        return c;
      },
      close: () => local.close(),
    };
  },
};

async function call(base, method, p, { token, body, headers = {} } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.Authorization = 'Bearer ' + token;
  let data = body;
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
    data = JSON.stringify(body);
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
  }
  const r = await fetch(base + p, { method, headers: h, body: data });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = undefined;
  }
  return { status: r.status, headers: r.headers, json };
}

const until = async (cond, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for ' + what);
};

for (const [name, start] of Object.entries(TARGETS)) {
  test(`app side: ${name}`, async (t) => {
    const x = await start();
    const app = async (appName = 'Tester') => (await call(x.base, 'POST', '/pair/claim', { body: { code: await x.code(), app_name: appName } })).json.app_token;
    try {
      await t.test('health', async () => {
        const r = await call(x.base, 'GET', '/health');
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
      });

      await t.test('pairing: a wrong code, the right one, and the same one again', async () => {
        for (const code of ['AAAAAA', 'nonsense', '']) assert.deepEqual(await call(x.base, 'POST', '/pair/claim', { body: { code, app_name: 'X' } }).then((r) => [r.status, r.json]), [404, WRONG_CODE]);
        const code = await x.code();
        const r = await call(x.base, 'POST', '/pair/claim', { body: { code: code.toLowerCase().replace(/^(...)/, '$1 '), app_name: 'Web808', app_id: 'id-1' } });
        assert.equal(r.status, 200);
        assert.match(r.json.app_token, /^la2la_[A-Za-z0-9_-]{43}$/);
        assert.equal(r.json.device_name, 'Test receiver');
        assert.deepEqual(await call(x.base, 'POST', '/pair/claim', { body: { code, app_name: 'Web808' } }).then((a) => [a.status, a.json]), [404, WRONG_CODE]);
        const me = await call(x.base, 'GET', '/app/me', { token: r.json.app_token });
        assert.deepEqual([me.status, me.json.device_name, me.json.app_name], [200, 'Test receiver', 'Web808']);
        assert.deepEqual((await call(x.base, 'POST', '/app/unpair', { token: r.json.app_token })).json, { ok: true });
        assert.deepEqual(await call(x.base, 'GET', '/app/me', { token: r.json.app_token }).then((a) => [a.status, a.json]), [401, APP_401]);
      });

      await t.test('without a token, or with a wrong one: 401 with the same text', async () => {
        for (const [method, p] of [['GET', '/app/me'], ['POST', '/packages'], ['GET', `/packages/${crypto.randomUUID()}/status`]]) {
          for (const token of [undefined, 'la2la_' + 'x'.repeat(43)]) assert.deepEqual(await call(x.base, method, p, { token, body: method === 'POST' ? {} : undefined }).then((r) => [r.status, r.json]), [401, APP_401], `${method} ${p}`);
        }
      });

      const token = await app();

      await t.test('every fixture manifest gets the verdict of expected.json', async () => {
        for (const f of expected.manifests) {
          const r = await call(x.base, 'POST', '/packages', { token, body: fs.readFileSync(path.join(FIXTURES, f.file), 'utf8'), headers: { 'Content-Type': 'application/json' } });
          assert.equal(r.status, f.server.status, f.file);
          if (f.server.status === 201) assert.deepEqual(r.json.warnings, f.server.warnings, f.file);
          else assert.deepEqual(r.json, { error: f.server.error }, f.file);
          if (r.status === 201) await call(x.base, 'DELETE', `/packages/${r.json.package_id}`, { token });
        }
      });

      await t.test('every fixture WAV file gets the verdict of expected.json', async () => {
        for (const f of expected.wav) {
          const data = fs.readFileSync(path.join(FIXTURES, f.file));
          const c = await call(x.base, 'POST', '/packages', { token, body: { schema: 'app2live/1', items: [{ file: 'a.wav', bytes: data.length, sha256: sha(data), kind: 'loop' }] } });
          const r = await call(x.base, 'PUT', `/packages/${c.json.package_id}/files/a.wav`, { token, body: data });
          if (f.device.ok) assert.deepEqual([r.status, r.json], [200, { ok: true, file: 'a.wav', bytes: data.length }], f.file);
          else assert.deepEqual([r.status, r.json], [422, { error: f.device.error }], f.file);
          await call(x.base, 'DELETE', `/packages/${c.json.package_id}`, { token });
        }
      });

      await t.test('uploads: too large, damaged, unknown file, missing at the commit, sent already', async () => {
        const a = wavFromSamples(new Float32Array(4410).fill(0.1), 44100);
        const data = Buffer.from(await a.arrayBuffer());
        const c = await call(x.base, 'POST', '/packages', { token, body: { schema: 'app2live/1', title: 'Errors', items: [{ file: 'a.wav', bytes: data.length, sha256: sha(data), kind: 'loop' }, { file: 'b.wav', bytes: data.length, sha256: sha(data), kind: 'oneshot' }] } });
        assert.equal(c.status, 201);
        assert.deepEqual(Object.keys(c.json.upload), ['a.wav', 'b.wav']);
        const id = c.json.package_id;
        const put = (file, body) => call(x.base, 'PUT', `/packages/${id}/files/${file}`, { token, body });
        assert.deepEqual(await put('a.wav', Buffer.concat([data, Buffer.alloc(10)])).then((r) => [r.status, r.json]), [413, { error: 'The file is larger than the package said.' }]);
        const damaged = Buffer.from(data);
        damaged[100] ^= 1;
        assert.deepEqual(await put('a.wav', damaged).then((r) => [r.status, r.json]), [422, { error: 'The file arrived damaged. Send it again.' }]);
        assert.deepEqual(await put('c.wav', data).then((r) => [r.status, r.json]), [404, { error: 'This file is not in the package.' }]);
        assert.equal((await put('a.wav', data)).status, 200);
        assert.deepEqual(await call(x.base, 'POST', `/packages/${id}/commit`, { token }).then((r) => [r.status, r.json]), [409, { error: 'Not all files are there yet: b.wav' }]);
        assert.equal((await put('b.wav', data)).status, 200);
        assert.deepEqual((await call(x.base, 'POST', `/packages/${id}/commit`, { token })).json, { ok: true, status: 'waiting' });
        assert.deepEqual(await put('a.wav', data).then((r) => [r.status, r.json]), [404, { error: 'This package is sent already.' }]);
        // The computer imports it: the app sees it in Live, and can no longer take it back.
        await until(async () => (await call(x.base, 'GET', `/packages/${id}/status`, { token })).json.status !== 'waiting', 'the import');
        const st = await call(x.base, 'GET', `/packages/${id}/status`, { token });
        assert.equal(st.json.status, 'imported');
        assert.deepEqual(st.json.items.map((i) => [i.name, i.status]), [['Sound 1', 'imported'], ['Sound 2', 'imported']]);
        assert.deepEqual((await call(x.base, 'POST', `/packages/${id}/commit`, { token })).json, { ok: true, status: 'imported' });
        assert.deepEqual(await call(x.base, 'DELETE', `/packages/${id}`, { token }).then((r) => [r.status, r.json]), [409, { error: 'This package is already in Live.' }]);
        // Taken back before the commit: gone for the app.
        const d = await call(x.base, 'POST', '/packages', { token, body: { schema: 'app2live/1', items: [{ file: 'a.wav', bytes: data.length, sha256: sha(data), kind: 'loop' }] } });
        assert.deepEqual((await call(x.base, 'DELETE', `/packages/${d.json.package_id}`, { token })).json, { ok: true });
        assert.deepEqual(await call(x.base, 'GET', `/packages/${d.json.package_id}/status`, { token }).then((r) => [r.status, r.json]), [404, { error: 'Unknown package.' }]);
      });

      await t.test('the rules for JSON bodies, paths and methods, and CORS', async () => {
        assert.deepEqual(await call(x.base, 'POST', '/packages', { token, body: 'x', headers: { 'Content-Type': 'text/plain' } }).then((r) => [r.status, r.json]), [415, { error: 'Send JSON with Content-Type: application/json.' }]);
        assert.deepEqual(await call(x.base, 'POST', '/packages', { token, body: '{nope', headers: { 'Content-Type': 'application/json' } }).then((r) => [r.status, r.json]), [400, { error: 'The request is not valid JSON.' }]);
        assert.deepEqual(await call(x.base, 'POST', '/packages', { token, body: '[1]', headers: { 'Content-Type': 'application/json' } }).then((r) => [r.status, r.json]), [400, { error: 'Send a JSON object.' }]);
        assert.deepEqual(await call(x.base, 'POST', '/packages', { token, body: JSON.stringify({ x: 'y'.repeat(1048576) }), headers: { 'Content-Type': 'application/json' } }).then((r) => [r.status, r.json]), [413, { error: 'The request is larger than 1 MB.' }]);
        assert.deepEqual(await call(x.base, 'GET', '/nope').then((r) => [r.status, r.json]), [404, { error: 'Not found.' }]);
        const wrong = await call(x.base, 'DELETE', '/app/me', { token });
        assert.deepEqual([wrong.status, wrong.json, wrong.headers.get('allow')], [405, { error: 'This method is not allowed here.' }, 'GET, HEAD']);
        const pre = await fetch(x.base + '/packages', { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'PUT' } });
        assert.equal(pre.status, 204);
        assert.equal(pre.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, X-LA2L-Client');
        assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
        const any = await call(x.base, 'GET', '/app/me', { token });
        assert.equal(any.headers.get('access-control-allow-origin'), '*');
        assert.equal(any.headers.get('access-control-expose-headers'), 'Content-Length, Retry-After');
      });

      await t.test('the SDK: pair, send a loop and a one-shot, follow it into Live, take one back, unpair', async () => {
        const la2l = new LA2L({ appName: 'Web808', server: x.base, storage: memoryStorage() });
        await assert.rejects(la2l.pair('AAAAAA'), (e) => e instanceof La2lError && e.code === 'bad_code' && e.message === WRONG_CODE.error);
        assert.deepEqual(await la2l.pair(await x.code()), { deviceName: 'Test receiver' });
        const loop = wavFromSamples([new Float32Array(96000).fill(0.2), new Float32Array(96000).fill(-0.2)], 48000, { bits: 24 });
        const shot = wavFromSamples(new Float32Array(4800).fill(0.1), 48000, { bits: 32 });
        const before = x.reports.length;
        const delivery = await la2l.send({ title: 'SDK test', bpm: 120, sounds: [{ name: 'Loop', audio: loop, kind: 'loop', role: 'drums' }, { name: 'Hit', audio: shot, kind: 'oneshot' }] });
        assert.deepEqual(delivery.warnings, []);
        const st = await delivery.imported({ intervalMs: 1000 });
        assert.equal(st.status, 'imported');
        assert.deepEqual(st.sounds.map((s) => [s.name, s.status]), [['Loop', 'imported'], ['Hit', 'imported']]);
        const report = x.reports[before];
        assert.deepEqual([report.sounds[0].plan.trackName, report.sounds[0].plan.warpModeName, report.sounds[0].plan.bpm, report.sounds[0].plan.lengthBeats], ['Loop (Web808)', 'Beats', 120, 4]);
        assert.deepEqual([report.sounds[1].info.bits, report.sounds[1].info.format], [32, 'float']);
        // Taken back before the import.
        const later = await la2l.send({ sounds: [{ name: 'Later', audio: shot, kind: 'oneshot' }] });
        await later.cancel().catch(() => {}); // the computer may have imported it already
        const me = await la2l.me();
        assert.equal(me.appName, 'Web808');
        await la2l.unpair();
        assert.equal(la2l.paired, false);
        await assert.rejects(la2l.me(), (e) => e.code === 'not_paired');
      });
    } finally {
      await x.close();
    }
  });
}
