// LA2L Sender as a share target, in headless Chromium against the real server: Android posts a
// share to /share as a form; here the page posts the same form. The service worker takes it,
// LA2L Sender opens with the sounds and the description in the text, and they go to a test
// receiver. Also: a ZIP of stems split over two packages, an mp3-like file made WAV, and a share
// that reaches the server because the service worker never ran.
import test from 'node:test';
import assert from 'node:assert/strict';
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
  const args = ['--autoplay-policy=no-user-gesture-required'];
  browser = await chromium.launch(process.env.LA2L_CHROMIUM ? { executablePath: process.env.LA2L_CHROMIUM, args } : { args });
});
test.after(async () => {
  await browser.close();
  await s.stop();
});

async function computer() {
  const { TestReceiver } = await import('../dist/testing/index.js');
  const reports = [];
  const receiver = new TestReceiver({ server: s.base, pollMs: 300, appsMs: 0, onReport: (r) => reports.push(r) });
  const code = await receiver.pair();
  return { receiver, code, reports };
}

// LA2L Sender in a fresh browser, its service worker in control; paired with the test receiver
// when there is a code.
async function sender(code, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  await page.goto(s.origin + '/');
  await page.waitForSelector('#pair-form:not([hidden])');
  if (code) await pair(page, code);
  if (options.serviceWorkers !== 'block') await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
  return page;
}

async function pair(page, code) {
  await page.fill('#code', code);
  await page.click('#pair-button');
  await page.waitForSelector('#paired:not([hidden])');
}

// What Android does for a share target: a form POST of title, text and files to /share.
async function share(page, { title = '', text = '', files }) {
  await page.evaluate(
    ({ title, text }) => {
      const form = Object.assign(document.createElement('form'), { method: 'post', action: 'share', enctype: 'multipart/form-data', id: 'android' });
      for (const [name, value] of Object.entries({ title, text })) form.append(Object.assign(document.createElement('input'), { type: 'hidden', name, value }));
      form.append(Object.assign(document.createElement('input'), { type: 'file', name: 'files', multiple: true, id: 'android-files' }));
      document.body.append(form);
    },
    { title, text }
  );
  await page.setInputFiles('#android-files', files);
  await page.evaluate(() => document.getElementById('android').submit());
}

const rowsOf = (page) =>
  page.$$eval('#sounds .sound', (els) =>
    els.map((el) => ({
      file: el.querySelector('.file-name').textContent,
      name: el.querySelector('.name').value,
      kind: el.querySelector('.kind').value,
      role: el.querySelector('.role').value,
      bpm: el.querySelector('.item-bpm').value,
      beats: el.querySelector('.beats').value,
      color: el.querySelector('.color').value,
      note: el.querySelector('.sound-message').textContent,
    }))
  );

async function sendAndWait(page, c, packages) {
  await page.click('#send-button');
  for (let i = 0; i < 150 && c.reports.length < packages; i++) await page.waitForTimeout(200);
  assert.equal(c.reports.length, packages);
}

test('a share with a description in its text: kept by the service worker, opened in LA2L Sender, sent as described', async () => {
  const c = await computer();
  try {
    const page = await sender(c.code);
    const manifest = {
      schema: 'app2live/1',
      title: 'Treinbeat',
      tempo: { bpm: 92 },
      items: [
        { file: 'kick.wav', name: 'Kick', kind: 'loop', role: 'drums', length_beats: 4, color: '#123456', gain_db: -3 },
        { file: 'robot.wav', name: 'Robot hallo', kind: 'oneshot', role: 'vocal' },
        { file: 'snare.wav', kind: 'loop' },
      ],
    };
    await share(page, {
      title: 'Shared from Web808',
      text: `Made with Web808: ${JSON.stringify(manifest)} Send it to Live with LA2L.`,
      files: [
        { name: 'kick.wav', mimeType: 'audio/wav', buffer: helpers.loopWav(92, 4) },
        { name: 'robot.wav', mimeType: 'audio/wav', buffer: helpers.shotWav() },
        { name: 'hat.wav', mimeType: 'audio/wav', buffer: helpers.shotWav() },
      ],
    });
    await page.waitForFunction(() => document.querySelectorAll('#sounds .sound').length === 3);
    assert.equal(new URL(page.url()).search, '', 'the address has no ?share any more');
    assert.deepEqual(await rowsOf(page), [
      { file: 'kick.wav', name: 'Kick', kind: 'loop', role: 'drums', bpm: '', beats: '4', color: '#123456', note: 'From the app: gain -3 dB.' },
      { file: 'robot.wav', name: 'Robot hallo', kind: 'oneshot', role: 'vocal', bpm: '', beats: '', color: '', note: '' },
      { file: 'hat.wav', name: 'hat', kind: 'oneshot', role: '', bpm: '', beats: '', color: '', note: '' },
    ]);
    assert.equal(await page.inputValue('#title'), 'Treinbeat');
    assert.equal(await page.inputValue('#bpm'), '92');
    assert.equal(
      await page.textContent('#send-message'),
      '3 sounds shared, described by the app. Check loop or one-shot, the BPM and the role, then send. The description also names snare.wav, which was not shared.'
    );
    // The share stays in IndexedDB until it is sent.
    const kept = () => page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('la2l-shared', 1);
      req.onsuccess = () => {
        const all = req.result.transaction('shares').objectStore('shares').count();
        all.onsuccess = () => resolve(all.result);
      };
    }));
    assert.equal(await kept(), 1);
    await sendAndWait(page, c, 1);
    await page.waitForSelector('#sent:not([hidden])');
    assert.equal(await kept(), 0);
    const report = c.reports[0];
    assert.equal(report.title, 'Treinbeat');
    const [kick, robot, hat] = report.sounds;
    assert.deepEqual([kick.plan.trackName, kick.plan.warpModeName, kick.plan.bpm, kick.plan.lengthBeats], ['Kick (LA2L Sender)', 'Beats', 92, 4]);
    assert.deepEqual([robot.plan.trackName, robot.plan.warp, hat.plan.trackName, hat.plan.warp], ['Robot hallo (LA2L Sender)', false, 'hat (LA2L Sender)', false]);
    await page.waitForFunction(() => /^In Live: 3 of 3 sounds\.$/.test(document.querySelector('#sent-status').textContent), null, { timeout: 30000 });
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});

test('a ZIP of 33 stems: read in the browser, what is not a sound left out, sent as two packages', async () => {
  const c = await computer();
  try {
    const page = await sender(c.code);
    const entries = [];
    for (let i = 1; i <= 33; i++) entries.push({ name: `Song stems/Stem ${String(i).padStart(2, '0')}.wav`, data: helpers.shotWav(), method: i % 2 ? 8 : 0 });
    entries.push({ name: 'Song stems/readme.txt', data: Buffer.from('Made with n-Track'), method: 8 });
    entries.push({ name: '__MACOSX/Song stems/._Stem 01.wav', data: Buffer.from('junk'), method: 0 });
    const title = 'Song stems of the long evening session in the old studio';
    await share(page, { title, files: [{ name: 'Song stems.zip', mimeType: 'application/zip', buffer: helpers.makeZip(entries) }] });
    await page.waitForFunction(() => document.querySelectorAll('#sounds .sound').length === 33, null, { timeout: 20000 });
    assert.equal(await page.inputValue('#title'), title);
    assert.equal(
      await page.textContent('#send-message'),
      '33 sounds shared. Check loop or one-shot, the BPM and the role, then send. Song stems.zip: left out readme.txt: not a sound.'
    );
    // Without a description the sounds keep the defaults of the page; here they are one-shots.
    await page.$$eval('#sounds .kind', (els) => els.forEach((el) => ((el.value = 'oneshot'), el.dispatchEvent(new Event('change')))));
    await sendAndWait(page, c, 2);
    // LA2L cuts a title at 60 characters: the part number stays.
    assert.deepEqual(c.reports.map((r) => [r.title, r.sounds.length, r.status]), [
      ['Song stems of the long evening session in the old s (1 of 2)', 32, 'imported'],
      ['Song stems of the long evening session in the old s (2 of 2)', 1, 'imported'],
    ]);
    assert.equal(c.reports[1].sounds[0].plan.trackName, 'Stem 33 (LA2L Sender)');
    await page.waitForSelector('#sent:not([hidden])');
    assert.match(await page.textContent('#sent-status'), /^Sent as 2 packages/);
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});

test('a sound that is not WAV, recorded in the browser, becomes WAV before it is sent', async () => {
  const c = await computer();
  try {
    const page = await sender(c.code);
    await page.evaluate(async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const out = ctx.createMediaStreamDestination();
      osc.connect(out);
      osc.start();
      const rec = new MediaRecorder(out.stream, { mimeType: 'audio/webm' });
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const stopped = new Promise((resolve) => (rec.onstop = resolve));
      rec.start();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      rec.stop();
      await stopped;
      const tone = new File(chunks, 'tone.webm', { type: 'audio/webm' });
      // A sound too long for the limit is refused before its WAV is made.
      const { toWav } = await import('./vendor/la2l.js');
      window.tooLong = await toWav(tone, { maxBytes: 1000 }).then(() => 'made', (e) => e.message);
      const files = new DataTransfer();
      files.items.add(tone);
      const input = document.getElementById('files');
      input.files = files.files;
      input.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(() => document.querySelectorAll('#sounds .sound').length === 1, null, { timeout: 20000 });
    const [row] = await rowsOf(page);
    assert.deepEqual([row.file, row.name], ['tone.webm, as WAV', 'tone']);
    assert.match(await page.evaluate(() => window.tooLong), /^This sound is too long: as WAV it would be 0\.\d MB\. LA2L takes 0\.0 MB at most\.$/);
    await page.selectOption('#sounds .kind', 'oneshot');
    await sendAndWait(page, c, 1);
    const sound = c.reports[0].sounds[0];
    assert.deepEqual([sound.plan.trackName, sound.info.format, sound.info.bits, sound.info.rate], ['tone (LA2L Sender)', 'pcm', 16, 48000]);
    assert.ok(sound.info.duration > 0.5, `${sound.info.duration} s`);
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});

test('a share that reaches the server, because the service worker never ran, gets the page that says what to do', async () => {
  const c = await computer();
  try {
    const page = await sender(c.code, { serviceWorkers: 'block' });
    await share(page, { files: [{ name: 'kick.wav', mimeType: 'audio/wav', buffer: helpers.shotWav() }] });
    await page.waitForSelector('#share-title');
    assert.equal(await page.textContent('main p'), 'Open LA2L Sender once from your home screen, then share again.');
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});

test('a share before pairing waits through the pairing, comes back after a reload, and is gone once it is sent', async () => {
  const c = await computer();
  try {
    const page = await sender(null);
    const manifest = { schema: 'app2live/1', source: { app: 'Web808' }, tempo: { bpm: 92 }, items: [{ file: 'kick.wav', name: 'Kick', kind: 'loop', role: 'drums' }] };
    await share(page, { text: JSON.stringify(manifest), files: [{ name: 'kick.wav', mimeType: 'audio/wav', buffer: helpers.loopWav(92, 4) }] });
    await page.waitForFunction(() => document.querySelector('#pair-message').textContent.startsWith('Pair this browser'));
    assert.equal(await page.textContent('#pair-message'), 'Pair this browser with Live first. Then the 1 shared sound is ready to send.');
    assert.equal(await page.inputValue('#title'), 'kick', 'a share without a title is named after its one file');
    // Android may close the page meanwhile: the share is still there when LA2L Sender opens again.
    await page.goto(s.origin + '/');
    await page.waitForFunction(() => document.querySelectorAll('#sounds .sound').length === 1);
    await pair(page, c.code);
    assert.equal(await page.textContent('#send-message'), '1 sound shared earlier, here again, described by the app. Check loop or one-shot, the BPM and the role, then send.');
    await page.click('#send-button');
    for (let i = 0; i < 150 && c.reports.length < 1; i++) await page.waitForTimeout(200);
    // The tracks carry the name of the app that shared, from its description.
    assert.equal(c.reports[0].sounds[0].plan.trackName, 'Kick (Web808)');
    assert.equal(c.reports[0].sounds[0].plan.bpm, 92);
    await page.waitForSelector('#sent:not([hidden])');
    await page.goto(s.origin + '/');
    await page.waitForSelector('#paired:not([hidden])');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#sounds .sound').count(), 0, 'a sent share does not come back');
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});

test('what goes wrong with a share is said: no room, gone, a description that does not work', async () => {
  const c = await computer();
  try {
    const page = await sender(c.code);
    await page.goto(s.origin + '/?share=failed');
    await page.waitForFunction(() => document.querySelector('#send-message').textContent !== '');
    assert.equal(await page.textContent('#send-message'), 'The shared sounds could not be kept on this device, maybe for lack of room. Share them again.');
    await page.goto(s.origin + '/?share=no-such-share');
    await page.waitForFunction(() => document.querySelector('#send-message').textContent !== '');
    assert.equal(await page.textContent('#send-message'), 'The shared sounds are no longer here. Share them again.');
    for (const [text, note] of [
      ['Made with Web808: {"schema": "app2live/1", "items": [}', 'The app shared a description of the sounds that is not valid JSON. Set them below.'],
      ['{"schema": "app2live/2", "items": []}', 'The app shared a description in app2live/2, which LA2L does not know. Set the sounds below.'],
      ['{"schema": {"toString": 0}, "tempo": {"bpm": {"valueOf": 0}}}', 'The app shared a description in an unknown form, which LA2L does not know. Set the sounds below.'],
    ]) {
      await page.goto(s.origin + '/');
      await page.waitForSelector('#paired:not([hidden])');
      await share(page, { text, files: [{ name: 'hit.wav', mimeType: 'audio/wav', buffer: helpers.shotWav() }] });
      await page.waitForFunction(() => document.querySelectorAll('#sounds .sound').length === 1);
      assert.equal(await page.textContent('#send-message'), `1 sound shared. Check loop or one-shot, the BPM and the role, then send. ${note}`);
      await page.click('#sounds .remove');
    }
    assert.deepEqual(page.errors, []);
  } finally {
    c.receiver.close();
  }
});
