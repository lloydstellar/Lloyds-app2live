// The client against the local test receiver, with a fetch in between that can break things: the
// header every call carries, the retries, a 429, a 401, an upload that breaks off, what is checked
// before the first byte goes out, the progress, the checksum an app gives, and AbortSignal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LA2L, La2lError, memoryStorage, wavFromSamples, VERSION } from '../dist/index.js';
import { startTestReceiver } from '../dist/testing/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'wav');

let local;
test.before(async () => {
  local = await startTestReceiver();
});
test.after(() => local.close());

// A fetch that records every call and fails the ones a rule matches, `times` times.
// fail: 'throw' (no answer), or { status, body, headers }.
function faultyFetch(rules = []) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method || 'GET';
    const where = String(url).replace(local.server, '');
    calls.push({ method, where, headers: init.headers || {} });
    for (const r of rules) {
      if (r.times > 0 && r.method === method && r.re.test(where)) {
        r.times--;
        if (r.fail === 'throw') throw new TypeError('fetch failed');
        return new Response(JSON.stringify(r.fail.body || {}), { status: r.fail.status, headers: Object.assign({ 'Content-Type': 'application/json' }, r.fail.headers) });
      }
    }
    return fetch(url, init);
  };
  f.calls = calls;
  return f;
}

async function paired(rules) {
  const fetchFn = faultyFetch(rules);
  const la2l = new LA2L({ appName: 'Web808', server: local.server, storage: memoryStorage(), fetch: fetchFn });
  await la2l.pair(await local.newCode());
  fetchFn.calls.length = 0;
  return { la2l, calls: fetchFn.calls };
}

const loop = (seconds = 2) => wavFromSamples(new Float32Array(Math.round(44100 * seconds)).fill(0.2), 44100);
const sound = (name = 'Loop', audio = loop()) => ({ name, audio, kind: 'loop', role: 'drums' });

test('every call says which SDK and which app make it', async () => {
  const { la2l, calls } = await paired();
  await (await la2l.send({ bpm: 120, sounds: [sound()] })).imported({ intervalMs: 1000 });
  assert.ok(calls.length >= 4);
  for (const c of calls) assert.equal(c.headers['X-LA2L-Client'], `la2l-js/${VERSION} (Web808)`, `${c.method} ${c.where}`);
  // The token goes in the header, never in an address.
  for (const c of calls) assert.doesNotMatch(c.where, /la2la_/);
});

test('a 5xx and a connection that breaks are tried again; a 401 forgets the token', async () => {
  const { la2l, calls } = await paired([
    { method: 'GET', re: /^\/app\/me$/, times: 1, fail: { status: 503, body: { error: 'Busy.' } } },
    { method: 'GET', re: /^\/app\/me$/, times: 1, fail: 'throw' },
  ]);
  const started = Date.now();
  assert.equal((await la2l.me()).deviceName, 'Test receiver');
  assert.equal(calls.length, 3);
  assert.ok(Date.now() - started >= 2900, 'after 1 and 2 seconds');
  const { la2l: gone } = await paired([{ method: 'GET', re: /^\/app\/me$/, times: 1, fail: { status: 401, body: { error: 'Unknown token. Pair this app again.' } } }]);
  await assert.rejects(gone.me(), (e) => e instanceof La2lError && e.code === 'not_paired' && e.status === 401 && e.message === 'Unknown token. Pair this app again.');
  assert.equal(gone.paired, false);
});

test('a 429 with a short wait is waited out; a long one is an error with retryAfter', async () => {
  const { la2l, calls } = await paired([{ method: 'GET', re: /^\/app\/me$/, times: 1, fail: { status: 429, body: { error: 'Too many requests. Wait a minute.' }, headers: { 'Retry-After': '1' } } }]);
  assert.equal((await la2l.me()).appName, 'Web808');
  assert.equal(calls.length, 2);
  const { la2l: slow } = await paired([{ method: 'POST', re: /^\/packages$/, times: 1, fail: { status: 429, body: { error: 'Too many packages in an hour. Wait a while.' }, headers: { 'Retry-After': '3500' } } }]);
  await assert.rejects(slow.send({ sounds: [sound()] }), (e) => e.code === 'rate_limited' && e.retryAfter === 3500 && e.message === 'Too many packages in an hour. Wait a while.');
});

test('an upload that breaks off starts that file again', async () => {
  const { la2l, calls } = await paired([{ method: 'PUT', re: /\/files\//, times: 1, fail: 'throw' }]);
  const delivery = await la2l.send({ bpm: 120, sounds: [sound()] });
  assert.equal((await delivery.imported({ intervalMs: 1000 })).status, 'imported');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 2);
});

test('everything is checked before the first byte goes out, with clear texts', async () => {
  const { la2l, calls } = await paired();
  const compressed = new Blob([fs.readFileSync(path.join(FIXTURES, 'compressed.wav'))]);
  const cases = [
    [{ sounds: [] }, 'bad_package', 'The package has no sounds.'],
    [{ sounds: Array.from({ length: 33 }, () => sound()) }, 'bad_package', 'The package has 33 sounds. LA2L takes 32 at most. Send them in more packages.'],
    [{ sounds: [{ name: 'Robot', audio: compressed, kind: 'oneshot' }] }, 'bad_wav', 'Robot is not a usable WAV: This WAV file is compressed (format 85). Send plain PCM or float WAV.'],
    [{ sounds: [{ name: 'Kick', audio: loop() }] }, 'bad_package', 'Kick: kind must be "loop" or "oneshot".'],
    [{ sounds: [{ name: 'Kick', audio: loop(), kind: 'loop', file: '../kick.wav' }] }, 'bad_package', 'Kick has no valid file name'],
  ];
  for (const [send, code, message] of cases) {
    await assert.rejects(la2l.send(send), (e) => e instanceof La2lError && e.code === code && e.message === message, message);
  }
  // More than 200 MB together.
  const big = new Blob([await loop().arrayBuffer(), new Uint8Array(105 * 1048576)]);
  await assert.rejects(la2l.send({ sounds: [sound('A', big), sound('B', big)] }), (e) => e.code === 'bad_package' && /^The package is 210 MB\. LA2L takes 200 MB at most\./.test(e.message));
  assert.deepEqual(calls, [], 'not one call went out');
});

test('onProgress gives the share of all bytes uploaded, per sound too', async () => {
  const { la2l } = await paired();
  const seen = [];
  await la2l.send({ bpm: 120, sounds: [sound('A', loop(1)), sound('B', loop(3))], onProgress: (share, p) => seen.push([share, p.stage, p.sound, p.soundShare]) });
  const uploading = seen.filter((x) => x[1] === 'uploading');
  for (let i = 1; i < uploading.length; i++) assert.ok(uploading[i][0] >= uploading[i - 1][0], 'never backwards');
  assert.deepEqual(uploading[uploading.length - 1].slice(0, 1), [1]);
  assert.ok(uploading.some((x) => x[2] === 0) && uploading.some((x) => x[2] === 1));
  const afterFirst = uploading.find((x) => x[2] === 1);
  assert.ok(Math.abs(afterFirst[0] - 0.25) < 0.01, `the first sound is a quarter of the bytes: ${afterFirst[0]}`);
});

test('a checksum the app gives is used as it is: a large file is not read twice', async () => {
  const { la2l } = await paired();
  const data = await loop(2).arrayBuffer();
  const hash = (await import('node:crypto')).createHash('sha256').update(Buffer.from(data)).digest('hex');
  const reads = [];
  class Watched extends Blob {
    slice(...args) {
      reads.push(args);
      return super.slice(...args);
    }
  }
  const audio = new Watched([data]);
  await la2l.send({ bpm: 120, sounds: [{ name: 'Loop', audio, kind: 'loop', sha256: hash }] });
  assert.ok(reads.every(([from = 0, to = audio.size]) => to - from <= 65536), `only the header was read: ${JSON.stringify(reads)}`);
});

test('AbortSignal stops a send, and what was uploaded goes from the server', async () => {
  const { la2l, calls } = await paired();
  const stop = new AbortController();
  const send = la2l.send({ bpm: 120, sounds: [sound('A'), sound('B')], signal: stop.signal, onProgress: (share, p) => p.stage === 'uploading' && p.sound === 1 && stop.abort() });
  await assert.rejects(send, (e) => e.code === 'aborted');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(calls.some((c) => c.method === 'DELETE' && /^\/packages\//.test(c.where)), 'the package was taken back');
});

test('imported() rejects when Live could not import it, or when the package expired', async () => {
  const fail = { method: 'GET', re: /\/status$/, times: 1, fail: { status: 200, body: { status: 'failed', items: [{ id: '1', name: 'Hit', status: 'failed', error: 'did not download: The file is gone.' }], updated_at: '2026-10-18T10:00:00.000Z' } } };
  const { la2l } = await paired([fail]);
  const d = la2l.delivery('3f0c1c55-4d47-4a64-b6a5-6d9a2d6e0e01');
  await assert.rejects(d.imported(), (e) => e.code === 'import_failed' && e.message === 'Live could not import it. Hit did not download: The file is gone.');
  await assert.rejects(d.imported(), (e) => e.code === 'expired');
});

test('the app id is made once and kept, and every app keeps its own token', async () => {
  const storage = memoryStorage();
  const a = new LA2L({ appName: 'Web808', server: local.server, storage });
  const again = new LA2L({ appName: 'Web808', server: local.server, storage });
  assert.equal(a.appId, again.appId);
  assert.match(a.appId, /^[0-9a-f-]{32,36}$/);
  await a.pair(await local.newCode());
  assert.equal(again.paired, true);
  assert.equal(new LA2L({ appName: 'Other', server: local.server, storage: memoryStorage() }).paired, false);
  assert.throws(() => new LA2L({}), /appName/);
  assert.throws(() => new LA2L({ appName: 'X', server: 'ftp://x' }), /Not a server address/);
});

test('any app name works: other alphabets, curly quotes and emoji go in the header encoded', async () => {
  const fetchFn = faultyFetch();
  const name = 'Битмейкер — Erik’s 🎵';
  const la2l = new LA2L({ appName: name, server: local.server, storage: memoryStorage(), fetch: fetchFn });
  await la2l.pair(await local.newCode());
  const delivery = await la2l.send({ bpm: 120, sounds: [sound('Бит')] });
  assert.equal((await delivery.imported({ intervalMs: 1000 })).status, 'imported');
  for (const c of fetchFn.calls) assert.match(c.headers['X-LA2L-Client'], /^[\x20-\x7e]+$/, 'printable ASCII only');
  assert.equal(fetchFn.calls[0].headers['X-LA2L-Client'], `la2l-js/${VERSION} (${encodeURIComponent('Битмейкер')} ${encodeURIComponent('—')} Erik${encodeURIComponent('’')}s ${encodeURIComponent('🎵')})`);
  const report = local.reports[local.reports.length - 1];
  assert.equal(report.sounds[0].plan.trackName, 'Бит (Битмейкер Erik s)');
});

test('an upload the server still holds (409, after a network switch) is waited out', async () => {
  const { la2l, calls } = await paired([{ method: 'PUT', re: /\/files\//, times: 1, fail: { status: 409, body: { error: 'This file is being sent already.' } } }]);
  const started = Date.now();
  const delivery = await la2l.send({ bpm: 120, sounds: [sound()] });
  assert.ok(Date.now() - started >= 4900, 'it waited 5 seconds');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 2);
  assert.equal((await delivery.imported({ intervalMs: 1000 })).status, 'imported');
});

test('unpair when the server cannot be reached: network, and the token stays; forget() drops it here', async () => {
  const { la2l } = await paired([{ method: 'POST', re: /^\/app\/unpair$/, times: 4, fail: 'throw' }]);
  await assert.rejects(la2l.unpair(), (e) => e.code === 'network');
  assert.equal(la2l.paired, true);
  la2l.forget();
  assert.equal(la2l.paired, false);
});

test('plain http only for this computer, so the token never travels in clear text', () => {
  for (const server of ['http://localhost:8787/api', 'http://127.0.0.1:1/api', 'http://[::1]:1/api', 'https://example.org/api']) {
    assert.doesNotThrow(() => new LA2L({ appName: 'X', server, storage: memoryStorage() }), server);
  }
  for (const server of ['http://example.org/api', 'http://192.168.1.20:8787/api']) {
    assert.throws(() => new LA2L({ appName: 'X', server, storage: memoryStorage() }), /plain http works for localhost only/, server);
  }
});

test('the local test receiver: a fresh code after every pairing, and nextReport finds a report that came first', async () => {
  const receiver = await startTestReceiver();
  try {
    const first = receiver.code;
    const a = new LA2L({ appName: 'A', server: receiver.server, storage: memoryStorage() });
    await a.pair(first);
    for (let i = 0; i < 50 && receiver.code === first; i++) await new Promise((r) => setTimeout(r, 100));
    assert.notEqual(receiver.code, first, 'a new code after the pairing');
    const b = new LA2L({ appName: 'B', server: receiver.server, storage: memoryStorage() });
    await b.pair(receiver.code);
    await (await b.send({ bpm: 120, sounds: [sound()] })).imported({ intervalMs: 1000 });
    // The report came before we asked for it.
    const report = await receiver.nextReport(2000);
    assert.equal(report.app, 'B');
    await assert.rejects(receiver.nextReport(300), /No package arrived/);
  } finally {
    await receiver.close();
  }
});

test('appName names the package and its tracks after another app, for a send on its behalf', async () => {
  const la2l = new LA2L({ appName: 'LA2L Sender', server: local.server, storage: memoryStorage() });
  await la2l.pair(await local.newCode());
  const audio = wavFromSamples(new Float32Array(4800).fill(0.1), 48000);
  const report = async (title) => {
    for (let i = 0; i < 50; i++) {
      const r = local.reports.find((x) => x.title === title);
      if (r) return r;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no report for ${title}`);
  };
  await (await la2l.send({ title: 'For Web808', appName: '  Web808 ', sounds: [{ name: 'Kick', audio, kind: 'oneshot' }] })).imported();
  const shared = await report('For Web808');
  assert.equal(shared.app, 'Web808');
  assert.equal(shared.sounds[0].plan.trackName, 'Kick (Web808)');
  // Without it, the client's own name.
  await (await la2l.send({ title: 'Own name', sounds: [{ name: 'Kick', audio, kind: 'oneshot' }] })).imported();
  assert.equal((await report('Own name')).sounds[0].plan.trackName, 'Kick (LA2L Sender)');
});
