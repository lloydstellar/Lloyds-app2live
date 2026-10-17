'use strict';
// End to end with the real device: the controller of LA2L 0.1.1 (src/node/app.js) with the
// simulated Live from the device tests (tests/mock-live.js, which runs the real v8 script),
// pointed at this server. This is what Erik does in Live, click for click.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, sendPackage, loopWav, shotWav } = require('./helpers');
const { App } = require('../../src/node/app');
const { MockLive, loadLiveScript } = require('../../tests/mock-live');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for ' + what);
}

let s;
test.before(async () => {
  // poll_ms 500, the shortest the device takes, so the tests do not wait two seconds per pairing.
  s = await startServer({ POLL_MS: '500' });
});
test.after(() => s.stop());

// A device as in tests/app.test.js: the controller, the Live script against a fake Live, and a
// settings folder of its own.
function device(o = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-home-'));
  const settings = Object.assign({ serverUrl: s.base }, o.settings);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ settings, pairing: o.pairing || null }));
  const mock = new MockLive(o.live);
  const outs = [];
  let app = null;
  const ctx = loadLiveScript(mock, (n, args) => {
    if (n === 0) setImmediate(() => app.handle('live', args[1]));
    else setTimeout(() => { mock.tick(); ctx.step(); }, 0);
  });
  app = new App({
    home,
    out: (name, ...args) => {
      outs.push([name, ...args]);
      if (name === 'tolive') setImmediate(() => ctx.request(args[1]));
    },
    timing: Object.assign({ liveTimeoutMs: 2000, importTimeoutMs: 5000, retryDelayMs: 5, liveRetryMs: 20, unpairConfirmMs: 2000 }, o.timing),
    openFolder: () => {},
  });
  ctx.init();
  const d = {
    app,
    mock,
    home,
    last: (name) => {
      for (let i = outs.length - 1; i >= 0; i--) if (outs[i][0] === name) return outs[i].slice(1);
      return null;
    },
    status: () => (d.last('status') || []).join(' '),
    view: () => (d.last('view') || [])[0],
    stored: () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')),
  };
  return d;
}

// Types the code the device shows into an "app", as the Sender page does.
async function claim(d, appName, appId) {
  const code = d.last('code').join(' '); // the device shows "K7P 42Q"
  const r = await s.request('POST', '/api/pair/claim', { body: { code, app_name: appName, app_id: appId } });
  assert.equal(r.status, 200, r.body.toString());
  return r.json;
}

test('Pair app, Self test, Add app, Unpair: as in Live', async () => {
  const d = device();
  d.app.start();

  // Pair app: the device shows a code and counts down.
  await d.app.handle('pair');
  assert.equal(d.view(), 'pairing');
  assert.match(d.last('code').join(''), /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(d.last('countdown').join(' '), /^This code works for (10:00|9:5\d)$/);

  // The code typed in the app: Live says it is paired.
  const first = await claim(d, 'LA2L Sender', 'browser-1');
  assert.equal(first.device_name, os.hostname().slice(0, 64));
  await waitFor(() => d.view() === 'paired', 'paired');
  assert.equal(d.status(), 'Paired with LA2L Sender. Send a sound from it and click Import.');
  const token = d.stored().pairing.token;
  assert.match(token, /^la2ld_/);

  // Self test while paired.
  await d.app.handle('selftest');
  assert.match(d.status(), /^Self test: Node v\d+\.\d+\.\d+ \/ folder OK \/ Live 12\.4\.6 OK \/ Set not saved \/ server OK \/ paired with 0 waiting$/);

  // Import with nothing sent yet.
  await d.app.handle('import');
  assert.equal(d.status(), 'Nothing new yet. Send a sound from your app first.');

  // Settings > Add app with a second browser: the same token, both apps listed.
  await d.app.handle('addapp');
  await waitFor(() => d.view() === 'pairing', 'the second code');
  const second = await claim(d, 'Robot Voice', 'browser-2');
  await waitFor(() => d.view() === 'paired', 'paired again');
  assert.equal(d.stored().pairing.token, token);
  assert.equal(d.last('pairedwith').join(' '), 'Paired with LA2L Sender and Robot Voice.');
  for (const t of [first.app_token, second.app_token]) assert.equal((await s.request('GET', '/api/app/me', { token: t })).status, 200);

  // Unpair (the device asks for a second click): both apps learn it from a 401.
  d.app.handle('settings', 1);
  await d.app.handle('unpair');
  assert.match(d.status(), /Click Unpair again/);
  await d.app.handle('unpair');
  assert.equal(d.status(), 'Unpaired. Apps can no longer send sounds to this computer.');
  assert.equal(d.stored().pairing, null);
  for (const t of [first.app_token, second.app_token]) assert.equal((await s.request('GET', '/api/app/me', { token: t })).status, 401);
});

test('Import: a loop and a one-shot sent through the app API become two tracks, at the tempo the app gave', async () => {
  const d = device();
  d.app.start();
  await d.app.handle('pair');
  const { app_token: appToken } = await claim(d, 'LA2L Sender', 'browser-import');
  await waitFor(() => d.view() === 'paired', 'paired');

  const { packageId } = await sendPackage(
    s,
    appToken,
    [
      { id: 'snare', file: 'test-file-voor-max.wav', data: loopWav(135, 4), name: 'Snare', kind: 'loop', role: 'drums' },
      { id: 'hit', file: 'hit.wav', data: shotWav(11025), name: 'Hit', kind: 'oneshot' },
    ],
    { title: 'Sender test', tempo: { bpm: 135 } }
  );
  await d.app.handle('import');
  assert.equal(d.status(), 'Sender test: 2 tracks imported.');
  assert.deepEqual(d.mock.song.tracks.map((t) => t.name).slice(2, 4), ['Snare (LA2L Sender)', 'Hit (LA2L Sender)']);
  const snare = d.mock.track(2).arrangement[0];
  assert.equal(snare.warping, 1);
  assert.equal(snare.warpMode, 0, 'Beats, for drums');
  assert.ok(Math.abs(d.mock.clipTempo(snare) - 135) < 0.05, `plays at ${d.mock.clipTempo(snare)} BPM`);
  assert.equal(d.mock.track(3).arrangement[0].warping, 0, 'the one-shot plays as it is');

  // The app reads the result; the files are gone from the server.
  const status = await s.request('GET', `/api/packages/${packageId}/status`, { token: appToken });
  assert.equal(status.json.status, 'imported');
  assert.deepEqual(status.json.items.map((it) => [it.id, it.status]), [['snare', 'imported'], ['hit', 'imported']]);
  assert.equal(fs.existsSync(path.join(s.dataDir, 'packages', packageId)), false);

  // A second Import finds nothing new.
  await d.app.handle('import');
  assert.equal(d.status(), 'Nothing new yet. Send a sound from your app first.');

  // Unpair (twice): the app token stops working.
  d.app.handle('settings', 1);
  await d.app.handle('unpair');
  await d.app.handle('unpair');
  assert.equal((await s.request('GET', '/api/app/me', { token: appToken })).status, 401);
});

test('Import: a package Live cannot use is confirmed as failed and stays for a later try', async () => {
  const d = device();
  d.app.start();
  await d.app.handle('pair');
  const { app_token: appToken } = await claim(d, 'LA2L Sender', 'browser-failed');
  await waitFor(() => d.view() === 'paired', 'paired');
  // A schema the device does not know yet. The server takes it only as app2live/1, so the
  // stored manifest is changed afterwards, as a newer server or app might have it.
  const { packageId } = await sendPackage(s, appToken, [{ file: 'a.wav', data: shotWav(), name: 'A' }], { title: 'Future' });
  const row = s.store.db.prepare('SELECT manifest FROM packages WHERE id = ?').get(packageId);
  const future = Object.assign(JSON.parse(row.manifest), { schema: 'app2live/2' });
  s.store.db.prepare('UPDATE packages SET manifest = ? WHERE id = ?').run(JSON.stringify(future), packageId);

  await d.app.handle('import');
  assert.match(d.status(), /^Future was not imported\. This package uses app2live\/2\. Update LA2L to import it\.$/);
  const status = (await s.request('GET', `/api/packages/${packageId}/status`, { token: appToken })).json;
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'This package uses app2live/2. Update LA2L to import it.');
  const inbox = (await s.request('GET', '/api/inbox', { token: d.stored().pairing.token })).json.packages;
  assert.deepEqual(inbox.map((p) => p.package_id), [packageId]);
});

test('Cancel in the device makes the code stop working', async () => {
  const d = device();
  d.app.start();
  await d.app.handle('pair');
  const code = d.last('code').join('');
  d.app.handle('cancelpair');
  assert.equal(d.status(), 'Pairing cancelled.');
  await waitFor(() => s.lines.some((l) => / pairing cancelled$/.test(l)), 'the cancel at the server');
  const r = await s.request('POST', '/api/pair/claim', { body: { code, app_name: 'Late' } });
  assert.equal(r.status, 404);
});

test('a device whose token was revoked goes back to Pair app on the next Import', async () => {
  const d = device();
  d.app.start();
  await d.app.handle('pair');
  await claim(d, 'LA2L Sender');
  await waitFor(() => d.view() === 'paired', 'paired');
  // The same computer pairs again elsewhere without its token (a second Live with a reset
  // settings file, say). The old token is revoked.
  const deviceId = d.stored().deviceId;
  const start = await s.request('POST', '/api/pair/start', { body: { device_id: deviceId, device_name: 'Same PC' } });
  await s.request('POST', '/api/pair/claim', { body: { code: start.json.code, app_name: 'Other' } });
  await d.app.handle('import');
  assert.equal(d.view(), 'unpaired');
  assert.equal(d.status(), 'This computer is no longer paired. Click Pair app to pair again.');
});
