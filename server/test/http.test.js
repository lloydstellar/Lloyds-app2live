'use strict';
// The HTTP basics: health, headers, CORS, 404 and 405, the Sender page and the request log.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('./helpers');
const { Server } = require('../../src/node/server');
const { errorText } = require('../src/http-util');

const VERSION = require('../package.json').version;
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

let s;
test.before(async () => {
  s = await startServer();
});
test.after(() => s.stop());

test('health: ok, name and version, as exact JSON that is never cached', async () => {
  const r = await s.request('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, name: 'la2l-server', version: VERSION });
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(Number(r.headers['content-length']), r.body.length);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.equal(r.headers['access-control-expose-headers'], 'Content-Length, Retry-After');
  assert.equal(r.headers['content-encoding'], undefined);
});

test('health: HEAD gives the same headers without a body', async () => {
  const get = await s.request('GET', '/api/health');
  const head = await s.request('HEAD', '/api/health');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], get.headers['content-length']);
});

test('health: the device client of LA2L 0.1.1 accepts it', async () => {
  const h = await new Server(s.base).health();
  assert.equal(h.ok, true);
});

test('health: 503 when the server cannot store sounds', async () => {
  const t = await startServer();
  try {
    fs.rmSync(t.dataDir, { recursive: true, force: true });
    const r = await t.request('GET', '/api/health');
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { ok: false, error: 'The server cannot store sounds right now.' });
  } finally {
    await t.stop();
  }
});

test('unknown API paths: 404 as JSON, with CORS, and no redirect for a trailing slash', async () => {
  for (const p of ['/api/nope', '/api/health/', '/api', '/api/', '/api/../api/health', '/api//health']) {
    const r = await s.request('GET', p);
    assert.equal(r.status, 404, p);
    assert.deepEqual(r.json, { error: 'Not found.' }, p);
    assert.equal(r.headers['access-control-allow-origin'], '*', p);
    assert.equal(r.headers.location, undefined, p);
  }
});

test('a known path with another method: 405 with Allow', async () => {
  const r = await s.request('POST', '/api/health', { headers: { 'Content-Type': 'application/json' }, body: {} });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'GET, HEAD');
  assert.deepEqual(r.json, { error: 'This method is not allowed here.' });
});

test('CORS preflight on any API path: 204', async () => {
  for (const p of ['/api/packages', '/api/whatever']) {
    const r = await s.request('OPTIONS', p, {
      headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    assert.equal(r.status, 204, p);
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.headers['access-control-allow-methods'], 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
    assert.equal(r.headers['access-control-allow-headers'], 'Authorization, Content-Type, X-LA2L-Client');
    assert.equal(r.headers['access-control-max-age'], '600');
    assert.equal(r.body.length, 0);
  }
});

test('Sender page: the four files, with the security headers', async () => {
  const files = { '/': 'text/html; charset=utf-8', '/sender.css': 'text/css; charset=utf-8', '/sender.js': 'text/javascript; charset=utf-8', '/logo.png': 'image/png' };
  for (const [p, type] of Object.entries(files)) {
    const r = await s.request('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.equal(Number(r.headers['content-length']), r.body.length, p);
    assert.equal(r.headers['content-security-policy'], CSP, p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
    assert.equal(r.headers['access-control-allow-origin'], undefined, p);
  }
  const page = (await s.request('GET', '/')).body.toString();
  assert.match(page, /<h1>LA2L Sender<\/h1>/);
  assert.doesNotMatch(page, /style=|<style|<script>/, 'nothing inline: the CSP would block it');
  assert.equal((await s.request('GET', '/logo.png')).body.subarray(1, 4).toString(), 'PNG');
});

test('the test receiver, the big test and the SDK for the browser: served like the Sender page', async () => {
  const files = {
    '/receiver': 'text/html; charset=utf-8',
    '/receiver.js': 'text/javascript; charset=utf-8',
    '/receiver.css': 'text/css; charset=utf-8',
    '/big.js': 'text/javascript; charset=utf-8',
    '/vendor/la2l.js': 'text/javascript; charset=utf-8',
  };
  for (const [p, type] of Object.entries(files)) {
    const r = await s.request('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.equal(r.headers['content-security-policy'], CSP, p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
  }
  const page = (await s.request('GET', '/receiver')).body.toString();
  assert.match(page, /<h1>LA2L Test receiver<\/h1>/);
  assert.doesNotMatch(page, /style=|<style|<script>/, 'nothing inline: the CSP would block it');
  const sdk = (await s.request('GET', '/vendor/la2l.js')).body.toString();
  assert.match(sdk.split('\n')[0], /^\/\/ la2l \d+\.\d+\.\d+: for the browser/);
  for (const p of ['/vendor/', '/vendor', '/vendor/../sender.js', '/receiver/', '/receiver.html']) assert.equal((await s.request('GET', p)).status, 404, p);
});

test('the drum machine example and the vendor files of the SDK: served with the same headers', async () => {
  const files = {
    '/examples/drum-machine/': 'text/html; charset=utf-8',
    '/examples/drum-machine/drum-machine.js': 'text/javascript; charset=utf-8',
    '/examples/drum-machine/drum-machine.css': 'text/css; charset=utf-8',
    '/vendor/la2l-button.js': 'text/javascript; charset=utf-8',
    '/vendor/la2l-receiver.js': 'text/javascript; charset=utf-8',
  };
  for (const [p, type] of Object.entries(files)) {
    const r = await s.request('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.equal(r.headers['content-security-policy'], CSP, p);
  }
  // The folder without its "/" goes to the folder, so the page's relative addresses work.
  const bare = await s.request('GET', '/examples/drum-machine');
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.location, 'drum-machine/');
  // Only the listed files: no README, nothing outside the folder.
  for (const p of ['/examples/drum-machine/README.md', '/examples/drum-machine/index.html', '/examples/drum-machine/../../package.json', '/examples/', '/examples']) {
    assert.equal((await s.request('GET', p)).status, 404, p);
  }
  const page = (await s.request('GET', '/examples/drum-machine/')).body.toString();
  assert.doesNotMatch(page.replace(/<!--[\s\S]*?-->/g, ''), /style=|<style|<script>/, 'nothing inline: the CSP would block it');
});

test('Sender page: a known version comes back as 304', async () => {
  const first = await s.request('GET', '/sender.js');
  const again = await s.request('GET', '/sender.js', { headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
});

test('pages: only the listed files exist, and no path leads out of public/', async () => {
  for (const p of ['/nope', '/index.html', '/../package.json', '/%2e%2e/package.json', '/sender.js/..', '/src/main.js', '/test/helpers.js']) {
    const r = await s.request('GET', p);
    assert.equal(r.status, 404, p);
    assert.equal(r.body.toString(), 'Not found.\n', p);
  }
  const r = await s.request('POST', '/', { body: 'x' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'GET, HEAD');
});

test('error texts are cut to 80 characters, at a space when they can be', () => {
  assert.equal(errorText('Short.'), 'Short.');
  const long = 'Not all files are there yet: kick.wav snare.wav hihat.wav clap.wav tom.wav ride.wav crash.wav';
  const cut = errorText(long);
  assert.ok(cut.length <= 80);
  assert.ok(long.startsWith(cut));
  assert.match(cut, /\.wav$/);
  assert.equal(errorText('x'.repeat(200)).length, 80);
});

test('log: one line per request, with the route pattern and the client address', async () => {
  const t = await startServer({ TRUST_PROXY: '1' });
  try {
    await t.request('GET', '/api/health', { headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.9' } });
    await t.request('GET', '/api/health'); // like the Docker health check: not logged
    await t.request('GET', '/api/some/secret-looking-path');
    await t.request('GET', '/');
    const lines = t.lines.filter((l) => /Z (GET|HEAD|POST|PUT|DELETE|OPTIONS) /.test(l));
    assert.equal(lines.length, 3, lines.join('\n'));
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z GET \/api\/health 200 [\d.]+ms in=0 out=\d+ - 203\.0\.113\.9$/);
    assert.match(lines[1], / GET \(unknown\) 404 /);
    assert.doesNotMatch(lines.join('\n'), /secret-looking-path/);
    const page = (await t.request('GET', '/')).body.length;
    assert.match(lines[2], new RegExp(` GET / 200 [\\d.]+ms in=0 out=${page} - `), 'a page counts its bytes too');
  } finally {
    await t.stop();
  }
});
