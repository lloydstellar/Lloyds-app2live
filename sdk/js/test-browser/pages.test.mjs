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

// A computer for the pages to send to: the test receiver of the SDK, in this process, against the
// same server. Resolves to { receiver, code, reports }.
async function computer() {
  const { TestReceiver } = await import('../dist/testing/index.js');
  const reports = [];
  const receiver = new TestReceiver({ server: s.base, pollMs: 300, appsMs: 0, onReport: (r) => reports.push(r) });
  const code = await receiver.pair();
  return { receiver, code, reports };
}

test('the drum machine: Send to Live asks the code once, sends the loop and the one-shots, and says In Live', async () => {
  const c = await computer();
  try {
    const page = await open('/examples/drum-machine/');
    await page.waitForSelector('la2l-send-button');
    assert.equal(await page.locator('.step[aria-pressed="true"]').count(), 15);
    await page.click('la2l-send-button >> button.send');
    await page.waitForSelector('la2l-send-button >> dialog[open]');
    await page.fill('la2l-send-button >> input', c.code.toLowerCase());
    await page.click('la2l-send-button >> button[type=submit]');
    await page.waitForFunction(() => document.querySelector('la2l-send-button').shadowRoot.querySelector('.status').textContent === 'In Live', null, { timeout: 30000 });
    const report = c.reports[0];
    assert.equal(report.status, 'imported');
    assert.deepEqual(report.sounds.map((x) => x.plan.trackName), ['Beat (Web808)', 'Kick (Web808)', 'Snare (Web808)', 'Hat (Web808)', 'Clap (Web808)']);
    const beat = report.sounds[0];
    assert.deepEqual([beat.plan.warp, beat.plan.warpModeName, beat.plan.bpm, beat.plan.lengthBeats], [true, 'Beats', 120, 4]);
    assert.deepEqual([beat.info.rate, beat.info.channels], [48000, 2]);
    assert.equal(report.sounds[1].plan.warp, false);
    // A second send needs no code: the page keeps the token.
    await page.fill('#bpm', '92');
    await page.dispatchEvent('#bpm', 'change');
    await page.click('la2l-send-button >> button.send');
    for (let i = 0; i < 100 && c.reports.length < 2; i++) await page.waitForTimeout(200);
    await page.waitForFunction(() => document.querySelector('la2l-send-button').shadowRoot.querySelector('.status').textContent === 'In Live', null, { timeout: 30000 });
    assert.equal(c.reports[1].sounds[0].plan.bpm, 92);
    assert.equal(await page.locator('la2l-send-button >> dialog[open]').count(), 0);
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});

test('LA2L Sender on the SDK: pairs, refuses what Live cannot use, sends two files, and follows them into Live', async () => {
  const c = await computer();
  try {
    const page = await open('/');
    await page.waitForSelector('#pair-form:not([hidden])');
    await page.fill('#code', c.code);
    await page.click('#pair-button');
    await page.waitForSelector('#paired:not([hidden])');
    assert.equal(await page.textContent('#device-name'), 'Test receiver');
    // The keys of the page before the SDK, so paired browsers stay paired.
    const keys = await page.evaluate(() => Object.keys(localStorage).sort());
    assert.deepEqual(keys, ['la2l.appId', 'la2l.deviceName', 'la2l.token']);
    const FIX = path.join(ROOT, 'sdk', 'fixtures', 'wav');
    await page.setInputFiles('#files', [path.join(FIX, 'pcm24-stereo.wav'), path.join(FIX, 'compressed.wav'), path.join(FIX, 'float32-stereo.wav')]);
    await page.waitForSelector('.sound');
    assert.equal(await page.locator('.sound').count(), 2);
    assert.equal(await page.textContent('#send-message'), 'compressed.wav: This WAV file is compressed (format 85). Send plain PCM or float WAV.');
    await page.fill('#bpm', '120');
    await page.click('#send-button');
    await page.waitForFunction(() => /^In Live: 2 of 2 sounds\.$/.test(document.querySelector('#sent-status').textContent), null, { timeout: 30000 });
    assert.deepEqual(c.reports[0].sounds.map((x) => x.plan.trackName), ['pcm24-stereo (LA2L Sender)', 'float32-stereo (LA2L Sender)']);
    assert.equal(await page.locator('#recent li').count(), 1);
    // A reload: still paired, and the recent list remembers.
    await page.reload();
    await page.waitForSelector('#paired:not([hidden])');
    assert.match(await page.textContent('#recent'), /In Live: 2 of 2 sounds\./);
    // Unpair: the page asks for a code again.
    await page.click('#unpair-button');
    await page.waitForSelector('#pair-form:not([hidden])');
    assert.equal(await page.textContent('#pair-message'), 'This browser is unpaired.');
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});

test('a browser paired before the SDK stays paired: the old keys still work', async () => {
  const p = await helpers.pairDevice(s, { deviceId: 'old-browser', appName: 'LA2L Sender', appId: 'old-app-id' });
  const context = await browser.newContext();
  await context.addInitScript(([token]) => {
    if (!localStorage.getItem('la2l.token')) {
      localStorage.setItem('la2l.token', token);
      localStorage.setItem('la2l.deviceName', 'STUDIO-PC');
      localStorage.setItem('la2l.appId', 'old-app-id');
    }
  }, [p.appToken]);
  const page = await context.newPage();
  await page.goto(s.origin + '/');
  await page.waitForSelector('#paired:not([hidden])');
  assert.equal(await page.textContent('#device-name'), 'STUDIO-PC');
  assert.equal(await page.evaluate(() => localStorage.getItem('la2l.appId')), 'old-app-id');
});

test('the button: properties set before it loads, its own texts, focus back after the dialog', async () => {
  const c = await computer();
  try {
    // A page of the server that does not load the button: it comes later, as a framework would.
    const page = await open('/receiver');
    await page.evaluate(() => {
      const b = document.createElement('la2l-send-button');
      b.setAttribute('app-name', 'Late');
      b.setAttribute('server', 'api');
      b.texts = { send: 'Naar Live', errorBadCode: 'Die code werkt niet.' };
      b.sounds = async () => {
        const { wavFromSamples } = await import('./vendor/la2l-button.js');
        return { bpm: 120, sounds: [{ name: 'Late', audio: wavFromSamples(new Float32Array(48000).fill(0.1), 48000), kind: 'loop' }] };
      };
      document.body.prepend(b);
    });
    await page.evaluate(() => import('./vendor/la2l-button.js'));
    const shadowText = (sel) => page.evaluate((s) => document.querySelector('la2l-send-button').shadowRoot.querySelector(s).textContent, sel);
    assert.equal(await shadowText('button.send'), 'Naar Live');
    // A wrong code: the page's own text. Escape: the focus is back on the button.
    await page.click('la2l-send-button >> button.send');
    await page.waitForSelector('la2l-send-button >> dialog[open]');
    await page.fill('la2l-send-button >> input', 'AAAAAA');
    await page.click('la2l-send-button >> button[type=submit]');
    await page.waitForFunction(() => document.querySelector('la2l-send-button').shadowRoot.querySelector('.problem').textContent !== '');
    assert.equal(await shadowText('.problem'), 'Die code werkt niet.');
    await page.keyboard.press('Escape');
    await page.waitForSelector('la2l-send-button >> dialog:not([open])', { state: 'attached' });
    assert.equal(await page.evaluate(() => document.querySelector('la2l-send-button').shadowRoot.activeElement?.className), 'send');
    // The texts can change later too.
    await page.evaluate(() => (document.querySelector('la2l-send-button').texts = { send: 'Envoyer' }));
    assert.equal(await shadowText('button.send'), 'Envoyer');
    // And the sounds set before it loaded are the ones it sends.
    await page.click('la2l-send-button >> button.send');
    await page.fill('la2l-send-button >> input', c.code);
    await page.click('la2l-send-button >> button[type=submit]');
    await page.waitForFunction(() => document.querySelector('la2l-send-button').shadowRoot.querySelector('.status').textContent === 'In Live', null, { timeout: 30000 });
    assert.equal(c.reports[0].sounds[0].plan.trackName, 'Late (Late)');
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});

test('a full localStorage: the button pairs and sends anyway, without asking for the code again', async () => {
  const c = await computer();
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(s.origin + '/examples/drum-machine/');
    await page.waitForSelector('la2l-send-button');
    await page.click('la2l-send-button >> button.send');
    await page.fill('la2l-send-button >> input', c.code);
    await page.click('la2l-send-button >> button[type=submit]');
    await page.waitForFunction(() => document.querySelector('la2l-send-button').shadowRoot.querySelector('.status').textContent === 'In Live', null, { timeout: 30000 });
    // A second send in the same page needs no code: the token lives in memory.
    await page.click('la2l-send-button >> button.send');
    for (let i = 0; i < 100 && c.reports.length < 2; i++) await page.waitForTimeout(200);
    assert.equal(c.reports.length, 2);
    assert.equal(await page.locator('la2l-send-button >> dialog[open]').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    c.receiver.close();
  }
});
