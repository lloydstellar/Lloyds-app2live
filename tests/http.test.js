'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { requestJson, download, anyWebAddress, NetError } = require('../src/node/http');
const { checkServerUrl, readInbox } = require('../src/node/server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-http-'));
const DATA = crypto.randomBytes(50000);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');

let a; // the server under test
let b; // another origin, for redirects
let counts = {};
const routes = {
  '/json': (req, res) => res.end(JSON.stringify({ hello: 'world' })),
  '/echo': async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.end(JSON.stringify({ method: req.method, body: JSON.parse(Buffer.concat(chunks).toString()), auth: req.headers.authorization || '' }));
  },
  '/missing': (req, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'nope' }));
  },
  '/denied': (req, res) => {
    res.statusCode = 401;
    res.end('{}');
  },
  '/forbidden': (req, res) => {
    res.statusCode = 403;
    res.end('{}');
  },
  '/broken': (req, res) => res.end('not json'),
  '/gone': (req, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'The file is gone. Send it again.' }));
  },
  '/gone-big': (req, res) => {
    // An error answer far larger than the file may be: still read as an error, not "too large".
    res.writeHead(404, { 'Content-Length': String(70000 + 50000) });
    res.write(JSON.stringify({ error: 'x'.repeat(70000) }).slice(0, 70000));
    res.end(DATA);
  },
  '/page': (req, res) => {
    res.statusCode = 404;
    res.end('<html>Not here</html>');
  },
  '/data': (req, res) => res.end(DATA),
  '/flaky': (req, res) => {
    counts.flaky = (counts.flaky || 0) + 1;
    if (counts.flaky <= 2) {
      res.statusCode = 500;
      return res.end('{}');
    }
    res.end(DATA);
  },
  '/big': (req, res) => {
    res.setHeader('Content-Length', String(DATA.length));
    res.end(DATA);
  },
  '/chunked': (req, res) => {
    res.write(DATA);
    res.end(DATA);
  },
  '/hang': () => {},
  '/cut': (req, res) => {
    res.setHeader('Content-Length', '100000');
    res.write(DATA.subarray(0, 1000));
    setTimeout(() => res.destroy(), 20);
  },
  '/to-json': (req, res) => {
    res.writeHead(302, { Location: '/json' });
    res.end();
  },
  '/to-other': (req, res) => {
    res.writeHead(302, { Location: b.url + '/json' });
    res.end();
  },
  '/loop': (req, res) => {
    res.writeHead(302, { Location: '/loop' });
    res.end();
  },
};

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const fn = routes[new URL(req.url, 'http://x').pathname];
      if (fn) return fn(req, res);
      res.statusCode = 404;
      res.end('{}');
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

test.before(async () => {
  a = await serve();
  b = await serve();
});
test.after(() => {
  a.s.closeAllConnections && a.s.closeAllConnections();
  b.s.closeAllConnections && b.s.closeAllConnections();
  a.s.close();
  b.s.close();
});

test('JSON: get, post with a token, errors with the server message', async () => {
  assert.deepEqual(await requestJson(a.url + '/json'), { hello: 'world' });
  const echo = await requestJson(a.url + '/echo', { method: 'POST', json: { x: 1 }, headers: { Authorization: 'Bearer t' } });
  assert.deepEqual(echo, { method: 'POST', body: { x: 1 }, auth: 'Bearer t' });
  await assert.rejects(requestJson(a.url + '/missing'), (e) => e instanceof NetError && e.status === 404 && /404\)\. nope/.test(e.message));
  await assert.rejects(requestJson(a.url + '/denied'), (e) => e.kind === 'unauthorized');
  // A 403 (for example from a firewall) is not "unpaired": the device keeps its pairing.
  await assert.rejects(requestJson(a.url + '/forbidden'), (e) => e.kind === 'http' && e.status === 403);
  await assert.rejects(requestJson(a.url + '/broken'), (e) => e.kind === 'badjson');
});

test('redirects: same server yes, another server only when allowed, loops stop', async () => {
  assert.deepEqual(await requestJson(a.url + '/to-json'), { hello: 'world' });
  await assert.rejects(requestJson(a.url + '/to-other'), (e) => e.kind === 'redirect');
  assert.deepEqual(await requestJson(a.url + '/to-other', { allowRedirect: anyWebAddress }), { hello: 'world' });
  await assert.rejects(requestJson(a.url + '/loop'), (e) => e.kind === 'redirect' && /Too many/.test(e.message));
});

test('network errors in words', async () => {
  await assert.rejects(requestJson('http://127.0.0.1:1/x'), (e) => e.kind === 'offline' && /refused/.test(e.message));
  await assert.rejects(requestJson(a.url + '/hang', { idleMs: 100 }), (e) => e.kind === 'timeout');
  await assert.rejects(requestJson(a.url + '/hang', { timeoutMs: 100 }), (e) => e.kind === 'timeout');
  await assert.rejects(requestJson('ftp://example.com/x'), (e) => e.kind === 'address');
  await assert.rejects(requestJson('not a url'), (e) => e.kind === 'address');
});

test('download: checked by size and sha256, written only when complete', async () => {
  const f = path.join(dir, 'ok.wav');
  const r = await download(a.url + '/data', f, { expectBytes: DATA.length, expectSha256: SHA });
  assert.equal(r.bytes, DATA.length);
  assert.deepEqual(fs.readFileSync(f), DATA);
  assert.ok(!fs.existsSync(f + '.part'));
});

test('download: a wrong checksum is retried, then refused, nothing left behind', async () => {
  const f = path.join(dir, 'bad.wav');
  let retries = 0;
  await assert.rejects(
    download(a.url + '/data', f, { expectSha256: 'f'.repeat(64), retries: 3, retryDelayMs: 1, onRetry: () => retries++ }),
    (e) => e.kind === 'checksum' && /arrived damaged/.test(e.message)
  );
  assert.equal(retries, 3);
  assert.ok(!fs.existsSync(f));
  assert.ok(!fs.existsSync(f + '.part'));
});

test('download: server errors are retried with a wait', async () => {
  counts = {};
  const f = path.join(dir, 'flaky.wav');
  const r = await download(a.url + '/flaky', f, { retries: 3, retryDelayMs: 1 });
  assert.equal(r.sha256, SHA);
  assert.equal(counts.flaky, 3);
});

test('download: 404 is not retried; too large is refused', async () => {
  let retries = 0;
  await assert.rejects(download(a.url + '/missing', path.join(dir, 'm.wav'), { retryDelayMs: 1, onRetry: () => retries++ }), (e) => e.status === 404);
  assert.equal(retries, 0);
  await assert.rejects(download(a.url + '/big', path.join(dir, 'big.wav'), { maxBytes: 1000, retryDelayMs: 1 }), (e) => e.kind === 'toolarge');
  await assert.rejects(download(a.url + '/chunked', path.join(dir, 'ch.wav'), { maxBytes: 60000, retryDelayMs: 1 }), (e) => e.kind === 'toolarge');
  assert.ok(!fs.existsSync(path.join(dir, 'ch.wav.part')));
});

test('download: an error shows the server\'s own text after the device\'s', async () => {
  const f = path.join(dir, 'gone.wav');
  await assert.rejects(download(a.url + '/gone', f, { retryDelayMs: 1 }), (e) => {
    assert.equal(e.message, 'The server does not know this address (404). The file is gone. Send it again.');
    return true;
  });
  // Not JSON, or JSON cut off at the 64 KB the device keeps: only the device's own text.
  await assert.rejects(download(a.url + '/page', f, { retryDelayMs: 1 }), (e) => e.message === 'The server does not know this address (404).');
  await assert.rejects(download(a.url + '/gone-big', f, { maxBytes: 1000, retryDelayMs: 1 }), (e) => e.status === 404 && e.message === 'The server does not know this address (404).');
  assert.ok(!fs.existsSync(f));
  assert.ok(!fs.existsSync(f + '.part'));
});

test('download: a connection cut halfway is an error, not a short file', async () => {
  const f = path.join(dir, 'cut.wav');
  await assert.rejects(download(a.url + '/cut', f, { retries: 1, retryDelayMs: 1 }), (e) => e instanceof NetError);
  assert.ok(!fs.existsSync(f));
});

test('server address: https only, except on this computer', () => {
  assert.equal(checkServerUrl('https://lloydstellar.nl/la2l/api/'), 'https://lloydstellar.nl/la2l/api');
  assert.equal(checkServerUrl('http://localhost:8080/api'), 'http://localhost:8080/api');
  assert.equal(checkServerUrl('http://127.0.0.1:9/api'), 'http://127.0.0.1:9/api');
  assert.throws(() => checkServerUrl('http://lloydstellar.nl/api'), /must start with https/);
  assert.throws(() => checkServerUrl(''), /not valid/);
});

test('inbox: checked and sorted oldest first', () => {
  const list = readInbox({
    packages: [
      { package_id: 'b', title: 'B', created_at: '2026-10-16T10:00:02Z' },
      { package_id: '../evil', title: 'X' },
      { package_id: 'a', title: 'A', app: 'Web808', items: 3, created_at: '2026-10-16T10:00:01Z' },
      null,
    ],
  });
  assert.deepEqual(list.map((p) => p.id), ['a', 'b']);
  assert.equal(list[0].items, 3);
  assert.deepEqual(readInbox({}), []);
  assert.deepEqual(readInbox(null), []);
});
