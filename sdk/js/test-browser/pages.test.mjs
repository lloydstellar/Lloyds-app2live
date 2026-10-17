// The pages of the server in headless Chromium, against the real server started in this process:
// the test receiver, which runs the checks of this package from server/public/vendor/la2l.js, and
// the big test of LA2L Sender. Run with "npm run test:browser". Chromium comes from
// "npx playwright-core install chromium", or from the path in LA2L_CHROMIUM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const helpers = require(path.join(ROOT, 'server', 'test', 'helpers.js'));

let s;
let browser;
test.before(async () => {
  s = await helpers.startServer();
  browser = await chromium.launch(process.env.LA2L_CHROMIUM ? { executablePath: process.env.LA2L_CHROMIUM } : {});
});
test.after(async () => {
  await browser.close();
  await s.stop();
});

// A fresh browser with its own localStorage, and every error of the page kept.
async function open(urlPath) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  await page.goto(s.origin + urlPath);
  return page;
}

// Opens the receiver and pairs an app with its code. Resolves to { page, token }.
async function pairedReceiver(appName) {
  const page = await open('/receiver');
  await page.waitForSelector('#code-box:not([hidden])');
  const code = (await page.textContent('#code')).replace(/\s/g, '');
  const claim = await s.request('POST', '/api/pair/claim', { body: { code, app_name: appName } });
  assert.equal(claim.status, 200);
  await page.waitForFunction((name) => document.querySelector('#paired-with').textContent.includes(name), appName);
  return { page, token: claim.json.app_token };
}

async function statusOf(token, id) {
  for (let i = 0; i < 40; i++) {
    const r = await s.request('GET', `/api/packages/${id}/status`, { token });
    if (r.json.status !== 'waiting') return r.json;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

test('the test receiver pairs, imports a loop as Live would, and the app sees it in "Live"', async () => {
  const { page, token } = await pairedReceiver('Web808');
  const loop = helpers.loopWav(135, 16);
  const sent = await helpers.sendPackage(s, token, [{ file: 'snare.wav', data: loop, name: 'Snare', kind: 'loop', role: 'drums' }], { title: 'Beat', tempo: { bpm: 135 } });
  await page.waitForSelector('.report .track');
  assert.equal(await page.textContent('.report .track'), 'Snare (LA2L Sender)');
  assert.match(await page.textContent('.report'), /Imported: 1 of 1 sound\..*Loop, warped in Beats mode at 135 BPM, 16 beats\./s);
  assert.deepEqual((await statusOf(token, sent.packageId)).items, [{ id: '1', name: 'Snare', status: 'imported' }]);
  // After a reload it is still paired, and keeps the report.
  await page.reload();
  await page.waitForSelector('#paired-box:not([hidden])');
  assert.equal(await page.locator('.report').count(), 1);
  // Stop: the app can no longer send, and a new code shows with a line that says so.
  await page.click('#stop');
  await page.waitForSelector('#code-box:not([hidden])');
  assert.equal(await page.textContent('#pair-message'), 'Stopped. The apps can no longer send to this receiver. Here is a new code.');
  assert.equal((await s.request('GET', '/api/app/me', { token })).status, 401);
  assert.deepEqual(page.errors, []);
});

test('a package that fails stays failed until Try again, as in Live until the next Import', async () => {
  const { page, token } = await pairedReceiver('Robot Voice');
  let downloads = 0;
  page.on('request', (r) => r.url().includes('/files/') && downloads++);
  // The file goes from the server's disk before the commit, so the receiver never sees it: the
  // download gets a 404, and the package fails and stays.
  const data = helpers.shotWav();
  const created = await s.request('POST', '/api/packages', { token, body: helpers.packageManifest([{ file: 'hit.wav', data, name: 'Hit', kind: 'oneshot' }]) });
  const sent = { packageId: created.json.package_id };
  assert.equal((await s.request('PUT', `/api/packages/${sent.packageId}/files/hit.wav`, { token, body: data })).status, 200);
  fs.rmSync(path.join(s.dataDir, 'packages', sent.packageId), { recursive: true, force: true });
  assert.equal((await s.request('POST', `/api/packages/${sent.packageId}/commit`, { token })).status, 200);
  await page.waitForSelector('.report .report-status.bad');
  assert.match(await page.textContent('.report'), /Not imported\..*Hit did not download: The server does not know this address \(404\)\. The file is gone\. Send it again\./s);
  assert.equal((await statusOf(token, sent.packageId)).status, 'failed');
  await page.waitForTimeout(7000); // more than two rounds of looking
  assert.equal(downloads, 1, 'no new download without Try again');
  await page.click('.report button:has-text("Try again")');
  await page.waitForTimeout(4000);
  assert.equal(downloads, 2);
  assert.deepEqual(page.errors, []);
});

// A proxy in front of the server that breaks off the first file download halfway: it sends the
// headers with the full Content-Length, half the body, and then closes the connection.
function breakingProxy() {
  let files = 0;
  const server = http.createServer((req, res) => {
    const out = http.request({ host: '127.0.0.1', port: s.port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      if (!(req.url.includes('/files/') && ++files === 1)) {
        res.writeHead(answer.statusCode, answer.headers);
        return answer.pipe(res);
      }
      const chunks = [];
      answer.on('data', (c) => chunks.push(c));
      answer.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(answer.statusCode, answer.headers);
        res.write(body.subarray(0, body.length >> 1), () => res.socket.destroy());
      });
    });
    req.pipe(out);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}`, files: () => files })));
}

test('a download that breaks off halfway is tried again, as the device does', async () => {
  const proxy = await breakingProxy();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(proxy.origin + '/receiver');
    await page.waitForSelector('#code-box:not([hidden])');
    const code = (await page.textContent('#code')).replace(/\s/g, '');
    const token = (await s.request('POST', '/api/pair/claim', { body: { code, app_name: 'Flaky' } })).json.app_token;
    const sent = await helpers.sendPackage(s, token, [{ file: 'loop.wav', data: helpers.loopWav(120), name: 'Loop', kind: 'loop' }], { tempo: { bpm: 120 } });
    await page.waitForSelector('.report .report-status:is(.ok, .bad)', { timeout: 20000 });
    assert.equal(await page.textContent('.report .report-status'), 'Imported: 1 of 1 sound.');
    assert.equal(proxy.files(), 2);
    assert.equal((await statusOf(token, sent.packageId)).status, 'imported');
    assert.deepEqual(errors, []);
  } finally {
    proxy.server.closeAllConnections();
    proxy.server.close();
  }
});

test('Pair another app clicked twice asks for one code, and the page keeps working', async () => {
  const { page } = await pairedReceiver('First');
  let starts = 0;
  page.on('request', (r) => r.url().endsWith('/api/pair/start') && starts++);
  await page.evaluate(() => {
    document.getElementById('add-app').click();
    document.getElementById('add-app').click();
  });
  await page.waitForSelector('#code-box:not([hidden])');
  const code = (await page.textContent('#code')).replace(/\s/g, '');
  assert.equal(starts, 1);
  const claim = await s.request('POST', '/api/pair/claim', { body: { code, app_name: 'Second' } });
  assert.equal(claim.status, 200, 'the code that shows is the one that works');
  await page.waitForFunction(() => document.querySelector('#paired-with').textContent === 'Paired with First and Second.');
  await page.waitForTimeout(1500); // a countdown left behind would throw every second
  assert.deepEqual(page.errors, []);
});

test('LA2L Sender with ?big sends 150 MB that the server takes as it is', async () => {
  const start = await helpers.pairStart(s, 'big-test-computer');
  const page = await open('/?big');
  await page.waitForSelector('#pair-form:not([hidden])');
  await page.fill('#code', start.code);
  await page.click('#pair-button');
  await page.waitForSelector('#paired:not([hidden])');
  await page.click('#big-button');
  // The button comes back when the send is over, whatever the outcome.
  await page.waitForFunction(() => !document.querySelector('#big-button').disabled && document.querySelector('#big-message').textContent !== '', null, { timeout: 120000 });
  assert.match(await page.textContent('#big-message'), /^Sent 150 MB in \d+:\d\d \([\d.]+ Mbit\/s\)\. Click Import in Live: it brings in Big test\.$/);
  const deviceToken = (await s.request('GET', '/api/pair/' + start.pair_id)).json.device_token;
  const inbox = (await s.request('GET', '/api/inbox', { token: deviceToken })).json.packages;
  assert.deepEqual(inbox.map((p) => [p.title, p.items]), [['Big test', 1]]);
  // Without ?big the card stays hidden.
  await page.goto(s.origin + '/');
  await page.waitForSelector('#paired:not([hidden])');
  assert.equal(await page.isVisible('#big'), false);
  assert.deepEqual(page.errors, []);
});
