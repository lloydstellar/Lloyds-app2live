// The examples of the skill la2l-send-to-ableton in headless Chromium, as an app would use them:
// assets/button.html with the button from jsDelivr (served here from dist/button.min.js, so its
// integrity hash is checked too), and assets/web-send.js with an import map for 'la2l'. Both send
// to a test receiver against the real server, started in this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const ASSETS = path.join(ROOT, 'skills', 'la2l-send-to-ableton', 'assets');
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

// A page of the server's origin with the given files in place, and every error of the page kept.
async function pageWith(files) {
  const context = await browser.newContext();
  for (const [url, body] of Object.entries(files)) {
    const type = url.endsWith('.html') ? 'text/html' : 'text/javascript';
    await context.route(url, (route) => route.fulfill({ body, contentType: type, headers: { 'Access-Control-Allow-Origin': '*' } }));
  }
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
  return page;
}

async function computer() {
  const { TestReceiver } = await import('../dist/testing/index.js');
  const reports = [];
  const receiver = new TestReceiver({ server: s.base, pollMs: 300, appsMs: 0, onReport: (r) => reports.push(r) });
  const code = await receiver.pair();
  return { receiver, code, reports };
}

// The example as the skill gives it, with the address of this server in the one place an app
// would put it. The test fails when that place is no longer in the example.
function pointed(file, from, to) {
  const text = fs.readFileSync(path.join(ASSETS, file), 'utf8');
  assert.ok(text.includes(from), `${file} no longer has ${from}`);
  return text.replace(from, to);
}

test('assets/button.html: one bar of four kicks arrives as a loop of 4 beats at 120 BPM', async () => {
  const c = await computer();
  try {
    const html = pointed('button.html', '<la2l-send-button app-name="My app">', `<la2l-send-button app-name="My app" server="${s.base}">`);
    const cdn = html.match(/src="(https:\/\/cdn\.jsdelivr\.net\/npm\/la2l@[\d.]+\/dist\/button\.min\.js)"/)[1];
    const page = await pageWith({ [s.origin + '/skill/button.html']: html, [cdn]: fs.readFileSync(path.join(HERE, '..', 'dist', 'button.min.js'), 'utf8') });
    await page.goto(s.origin + '/skill/button.html');
    await page.click('la2l-send-button >> button.send');
    await page.waitForSelector('la2l-send-button >> dialog[open]');
    await page.fill('la2l-send-button >> input', c.code);
    await page.click('la2l-send-button >> button[type=submit]');
    await page.waitForFunction(() => document.querySelector('la2l-send-button').shadowRoot.querySelector('.status').textContent === 'In Live', null, { timeout: 30000 });
    const sound = c.reports[0].sounds[0];
    assert.deepEqual([sound.plan.trackName, sound.plan.warp, sound.plan.warpModeName, sound.plan.bpm, sound.plan.lengthBeats], ['Kick loop (My app)', true, 'Beats', 120, 4]);
    assert.equal(c.reports[0].title, 'Four on the floor');
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});

test('assets/web-send.js: pairs, sends a loop and a one-shot, and reports In Live', async () => {
  const c = await computer();
  try {
    const page = await pageWith({
      [s.origin + '/skill/web-send.html']: `<!doctype html><script type="importmap">{"imports":{"la2l":"/vendor/la2l.js"}}</script><p>web-send</p>`,
      [s.origin + '/skill/web-send.js']: pointed('web-send.js', "new LA2L({ appName: 'My app' })", `new LA2L({ appName: 'My app', server: '${s.base}' })`),
    });
    await page.goto(s.origin + '/skill/web-send.html');
    const { early, paired, statuses } = await page.evaluate(async (code) => {
      const app = await import('/skill/web-send.js');
      const statuses = [];
      const loopBuffer = await new OfflineAudioContext(2, 96000, 48000).startRendering(); // one bar at 120 BPM
      const hit = new Float32Array(4800).fill(0.2);
      const early = [];
      await app.sendToLive({ loopBuffer, hit, bpm: 120, onStatus: (t) => early.push(t) });
      const paired = await app.pairWith(code);
      await app.sendToLive({ loopBuffer, hit, bpm: 120, onStatus: (t) => statuses.push(t) });
      return { early, paired, statuses };
    }, c.code);
    assert.deepEqual(early, ['Pair first: in Live, click Pair app in LA2L and type the code it shows.']);
    assert.equal(paired, 'Paired with Test receiver.');
    assert.equal(statuses.at(-1), 'In Live');
    assert.ok(statuses.includes('Waiting for Import in Live'));
    assert.ok(statuses.some((t) => /^Sending… \d+%$/.test(t)));
    const [beat, hit] = c.reports[0].sounds;
    assert.deepEqual([beat.plan.trackName, beat.plan.warpModeName, beat.plan.bpm, beat.plan.lengthBeats], ['Beat (My app)', 'Beats', 120, 4]);
    assert.deepEqual([hit.plan.trackName, hit.plan.warp], ['Hit (My app)', false]);
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});
