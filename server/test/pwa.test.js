'use strict';
// LA2L Sender as an installed web app and a share target on Android (sdk/BUILD-PROMPT.md,
// section 11): the manifest and its icons, the service worker, the page for a share that reaches
// the server, and the ZIP reader of the page. The share itself runs in Chromium:
// sdk/js/test-browser/share.test.mjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, makeZip, loopWav, shotWav } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
let s;
test.before(async () => {
  s = await startServer();
});
test.after(() => s.stop());

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const SHARE_TEXT = 'Open LA2L Sender once from your home screen, then share again.';

test('the manifest makes LA2L Sender an installable app with a share target for sounds', async () => {
  const r = await s.request('GET', '/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/manifest+json; charset=utf-8');
  assert.equal(r.headers['content-security-policy'], CSP);
  const m = JSON.parse(r.body.toString());
  assert.equal(m.name, 'LA2L Sender');
  assert.deepEqual([m.start_url, m.scope, m.display], ['./', './', 'standalone']);
  // Relative to the manifest: under /la2l/ these are /la2l/ and /la2l/share.
  assert.deepEqual(m.share_target, {
    action: 'share',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: { title: 'title', text: 'text', files: [{ name: 'files', accept: ['audio/*', '.wav', '.zip', 'application/zip'] }] },
  });
  // Chrome installs an app with a 192 and a 512 pixel icon; Android cuts the maskable ones.
  for (const icon of m.icons) {
    const png = await s.request('GET', '/' + icon.src);
    assert.equal(png.status, 200, icon.src);
    assert.equal(png.headers['content-type'], 'image/png');
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.deepEqual([png.body.readUInt32BE(16), png.body.readUInt32BE(20)], [w, h], icon.src);
  }
  assert.deepEqual(m.icons.map((i) => `${i.sizes} ${i.purpose || 'any'}`).sort(), ['192x192 any', '192x192 maskable', '512x512 any', '512x512 maskable']);
  const page = (await s.request('GET', '/')).body.toString();
  assert.match(page, /<link rel="manifest" href="manifest.webmanifest">/);
});

test('the service worker, the share helpers and the ZIP reader are served as scripts', async () => {
  for (const p of ['/sw.js', '/share.js', '/zip.js']) {
    const r = await s.request('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8', p);
    assert.equal(r.headers['content-security-policy'], CSP, p);
  }
  // It keeps nothing in a cache, so the pages stay fresh.
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  assert.doesNotMatch(sw, /caches\./);
});

test('a share that reaches the server gets a page that says what to do, also with a body of megabytes', async () => {
  for (const method of ['GET', 'POST']) {
    const body = method === 'POST' ? Buffer.concat([Buffer.from('--x\r\nContent-Disposition: form-data; name="files"; filename="big.wav"\r\n\r\n'), Buffer.alloc(3 * 1048576, 7), Buffer.from('\r\n--x--\r\n')]) : undefined;
    const r = await s.request(method, '/share', { body, headers: body ? { 'Content-Type': 'multipart/form-data; boundary=x' } : {} });
    assert.equal(r.status, 200, method);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(r.body.toString(), new RegExp(SHARE_TEXT.replace(/\./g, '\\.')));
  }
  const put = await s.request('PUT', '/share', { body: 'x' });
  assert.deepEqual([put.status, put.headers.allow], [405, 'GET, HEAD, POST']);
  // The server goes on as before.
  assert.equal((await s.request('GET', '/api/health')).status, 200);
});

async function zip() {
  return import(path.join(PUBLIC, 'zip.js'));
}
const blob = (buf) => new Blob([buf]);

test('the ZIP reader: stored and deflated sounds, without folders, macOS leftovers and what keep turns down', async () => {
  const { readZip } = await zip();
  const loop = loopWav(120, 4);
  const shot = shotWav();
  const archive = makeZip([
    { name: 'Stems/', data: Buffer.alloc(0), method: 0 },
    { name: 'Stems/Drums.wav', data: loop, method: 8 },
    { name: 'Stems/Bass.wav', data: shot, method: 0 },
    { name: '__MACOSX/Stems/._Drums.wav', data: Buffer.from('junk'), method: 0 },
    { name: 'Stems/.DS_Store', data: Buffer.from('junk'), method: 0 },
    { name: 'Stems/readme.txt', data: Buffer.from('hello'), method: 8 },
    { name: 'Stems/Vocal ü.wav', data: shot, method: 8 },
  ]);
  const { files, skipped } = await readZip(blob(archive), (name) => /\.wav$/i.test(name));
  assert.deepEqual(files.map((f) => f.name), ['Drums.wav', 'Bass.wav', 'Vocal ü.wav']);
  assert.deepEqual(skipped, ['readme.txt']);
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), loop);
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), shot);
  assert.equal(files[0].type, 'audio/wav');
});

test('the ZIP reader refuses what it cannot read, with a text that says why', async () => {
  const { readZip } = await zip();
  const wav = shotWav();
  const cases = [
    [Buffer.from('not a zip at all'), 'This is not a ZIP file, or it is damaged.'],
    [makeZip([{ name: 'a.wav', data: wav, flags: 0x801 }]), 'a.wav is protected with a password. Share it without one.'],
    [makeZip([{ name: 'a.wav', data: wav, method: 12 }]), 'a.wav is packed in a way this page cannot read. Unpack the ZIP file and share the WAV files.'],
    [makeZip([{ name: 'a.wav', data: wav, size: wav.length + 1 }]), 'a.wav in the ZIP file is damaged.'],
    [makeZip([{ name: 'a.wav', data: wav, size: 0xffffffff }]), 'This ZIP file is too large to read here. Unpack it and share the WAV files.'],
  ];
  // A deflated entry whose bytes are garbage.
  const bad = makeZip([{ name: 'a.wav', data: wav, method: 8 }]);
  bad.fill(0xff, 40, 80);
  cases.push([bad, 'a.wav in the ZIP file is damaged.']);
  for (const [archive, message] of cases) await assert.rejects(readZip(blob(archive)), { message });
});

test('the ZIP reader: a data descriptor, an archive comment, and an old name in code page 437', async () => {
  const { readZip } = await zip();
  const shot = shotWav();
  const archive = makeZip(
    [
      { name: 'Streamed.wav', data: shot, method: 8, descriptor: true },
      { name: 'old', rawName: Buffer.from([0x47, 0x72, 0x81, 0xe1, 0x65, 0x2e, 0x77, 0x61, 0x76]), data: shot, method: 0, flags: 0 },
    ],
    'Made with n-Track'
  );
  const { files } = await readZip(blob(archive));
  assert.deepEqual(files.map((f) => f.name), ['Streamed.wav', 'Grüße.wav']);
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), shot);
});

test('the ZIP reader stops a ZIP bomb, a damaged byte and too much, before it fills the memory', async () => {
  const { readZip, LIMITS } = await zip();
  // 50 MB of silence that says it is 1 KB: stopped at the first piece past 1 KB.
  const silence = Buffer.alloc(50 * 1048576);
  const started = Date.now();
  await assert.rejects(readZip(blob(makeZip([{ name: 'bomb.wav', data: silence, size: 1024 }]))), { message: 'bomb.wav in the ZIP file is damaged.' });
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  // A stored sound with one byte changed: its CRC-32 tells.
  const shot = shotWav();
  const stored = makeZip([{ name: 'a.wav', data: shot, method: 0 }]);
  stored[30 + 5 + 100] ^= 0xff;
  await assert.rejects(readZip(blob(stored)), { message: 'a.wav in the ZIP file is damaged.' });
  // What an entry says it holds decides before a byte is unpacked.
  await assert.rejects(readZip(blob(makeZip([{ name: 'huge.wav', data: shot, size: 300 * 1048576 }]))), { message: 'huge.wav is 300 MB. LA2L takes 200 MB per package at most.' });
  const many = [];
  for (let i = 0; i <= LIMITS.entries; i++) many.push({ name: `s${i}.wav`, data: Buffer.from('x'), method: 0 });
  await assert.rejects(readZip(blob(makeZip(many))), { message: `This ZIP file holds ${LIMITS.entries + 1} files. LA2L Sender reads ${LIMITS.entries} at most.` });
});
