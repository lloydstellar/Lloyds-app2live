'use strict';
// End-to-end tests of the Node part: the controller (app.js) talks to the fake server over real
// HTTP and to the real Live script (la2l-live.js) running against the fake Live.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { App } = require('../src/node/app');
const { MockLive, loadLiveScript } = require('./mock-live');
const { MockServer } = require('./mock-server');
const { buildWav16 } = require('../src/node/wav');
const { makeLoop } = require('../src/node/testsound');

const LOOP = buildWav16(makeLoop(92, 16), 1, 44100); // 4 bars at 92 BPM
const SHOT = buildWav16(new Float32Array(11025).map((_, i) => Math.sin(i / 7) * 0.4), 1, 44100);
const SNARE = buildWav16(makeLoop(135, 4), 1, 44100);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for ' + what);
}

let server;
test.before(async () => {
  server = new MockServer();
  await server.start();
  server.files.set('/test/snare.wav', SNARE);
  server.files.set('/test/moved.wav', (req, res) => {
    res.writeHead(302, { Location: '/test/snare.wav' });
    res.end();
  });
  server.files.set('/test/page.html', Buffer.from('<html>not a wav</html>'));
});
test.after(() => server.stop());

// A device: the controller, the Live script against a fake Live, and a settings folder of its own.
function device(o = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-home-'));
  const settings = Object.assign({ serverUrl: server.base, testUrl: server.origin + '/test/snare.wav' }, o.settings);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ settings, pairing: o.pairing || null }));
  const mock = new MockLive(o.live);
  const outs = [];
  const opened = [];
  const copied = [];
  let app = null;
  const ctx = loadLiveScript(mock, (n, args) => {
    if (n === 0) setImmediate(() => app.handle('live', args[1]));
    else setTimeout(() => { mock.tick(); ctx.step(); }, 0);
  });
  app = new App({
    home,
    out: (name, ...args) => {
      outs.push([name, ...args]);
      if (name === 'tolive' && o.liveAnswers !== false) setImmediate(() => ctx.request(args[1]));
    },
    // appsCheckMs: the background check of the app list only runs in the tests that ask for it.
    timing: Object.assign({ liveTimeoutMs: 2000, importTimeoutMs: 5000, retryDelayMs: 5, liveRetryMs: 20, unpairConfirmMs: 2000, appsCheckMs: 600000 }, o.timing),
    openFolder: (d) => opened.push(d),
    copyText: o.copyText || (async (text) => copied.push(text)),
  });
  if (o.liveAnswers !== false) ctx.init();
  const d = {
    app,
    mock,
    outs,
    opened,
    copied,
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

async function paired(o = {}) {
  const d = device(o);
  d.app.start();
  await d.app.handle('pair');
  await waitFor(() => d.view() === 'pairing', 'the code');
  server.completePairing(o.appName || 'Web808');
  await waitFor(() => d.view() === 'paired', 'paired');
  return d;
}

function manifest(id, items, o = {}) {
  return Object.assign({ schema: 'app2live/1', package_id: id, title: 'Treinbeat', source: { app: 'Web808', platform: 'web' }, tempo: { bpm: 92 }, items }, o);
}

test('start: settings to the patch, the unpaired view, Ready', async () => {
  const d = device();
  d.app.start();
  assert.deepEqual(d.last('placement'), [0]);
  assert.deepEqual(d.last('newtracks'), [0]);
  assert.equal(d.view(), 'unpaired');
  assert.equal(d.status(), 'Ready.');
  await waitFor(() => d.app.live, 'Live info');
  assert.equal(d.app.live.live.minor, 4);
  const log = fs.readFileSync(path.join(d.home, 'la2l.log'), 'utf8');
  assert.match(log, /Live 12\.4\.6\. Set: not saved/);
});

test('pairing: code, waiting, paired, token stored', async () => {
  const d = device();
  d.app.start();
  await d.app.handle('pair');
  assert.deepEqual(d.last('code'), ['K7P', '42Q']);
  assert.equal(d.view(), 'pairing');
  assert.match(d.last('countdown').join(' '), /This code works for (10:00|9:5\d)/);
  server.completePairing('Robot Voice');
  await waitFor(() => d.view() === 'paired', 'paired');
  assert.equal(d.last('pairedwith').join(' '), 'Paired with Robot Voice.');
  assert.match(d.status(), /Paired with Robot Voice/);
  const s = d.stored();
  assert.ok(s.pairing.token);
  assert.deepEqual(s.pairing.apps, ['Robot Voice']);
  assert.equal(d.app.pairing, null, 'timers stopped');
});

test('adding a second app keeps the token and lists both apps', async () => {
  const d = await paired({ appName: 'Web808' });
  const token = d.stored().pairing.token;
  await d.app.handle('addapp');
  await waitFor(() => d.view() === 'pairing', 'the code');
  server.completePairing('Robot Voice');
  await waitFor(() => d.view() === 'paired', 'paired again');
  assert.equal(d.stored().pairing.token, token);
  assert.equal(d.last('pairedwith').join(' '), 'Paired with Web808 and Robot Voice.');
});

test('pairing: cancel and expiry go back to the previous view', async () => {
  const d = device();
  d.app.start();
  await d.app.handle('pair');
  d.app.handle('cancelpair');
  assert.equal(d.view(), 'unpaired');
  assert.equal(d.status(), 'Pairing cancelled.');
  await d.app.handle('pair');
  server.expirePairing();
  await waitFor(() => d.view() === 'unpaired', 'expired');
  assert.match(d.status(), /The code expired/);
});

test('Copy code puts the code on the clipboard, without the space', async () => {
  const d = device();
  d.app.start();
  await d.app.handle('copycode');
  assert.deepEqual(d.copied, [], 'no code showing: nothing to copy');
  await d.app.handle('pair');
  await d.app.handle('copycode');
  assert.deepEqual(d.copied, ['K7P42Q']);
  assert.equal(d.status(), 'Code copied. Paste it in your app.');
  assert.equal(d.view(), 'pairing', 'the code keeps showing');
  d.app.handle('cancelpair');

  const broken = device({ copyText: async () => { throw new Error('clip.exe ended with code 1.'); } });
  broken.app.start();
  await broken.app.handle('pair');
  await broken.app.handle('copycode');
  assert.equal(broken.status(), 'Could not copy the code. Type it in your app.');
  assert.match(fs.readFileSync(path.join(broken.home, 'la2l.log'), 'utf8'), /Copy code: clip\.exe ended with code 1\./);
  broken.app.handle('cancelpair');
});

test('import: nothing waiting', async () => {
  const d = await paired();
  await d.app.handle('import');
  assert.match(d.status(), /Nothing new yet/);
});

test('import: a loop and a one-shot become two tracks, confirmed and remembered', async () => {
  const d = await paired();
  server.addPackage(
    manifest('pkg-1', [
      { id: 'kick', file: 'kick.wav', name: 'Kick', kind: 'loop', role: 'drums', color: '#E5484D' },
      { id: 'robot', file: 'robot.wav', name: 'Robot hallo', kind: 'oneshot', role: 'vocal' },
    ]),
    { 'kick.wav': LOOP, 'robot.wav': SHOT }
  );
  await d.app.handle('import');
  assert.equal(d.status(), 'Treinbeat: 2 tracks imported.');
  const names = d.mock.song.tracks.map((t) => t.name);
  assert.deepEqual(names.slice(2, 4), ['Kick (Web808)', 'Robot hallo (Web808)']);
  const kick = d.mock.track(2).arrangement[0];
  assert.equal(kick.warping, 1);
  assert.equal(kick.warpMode, 0);
  assert.ok(Math.abs(d.mock.clipTempo(kick) - 92) < 0.05);
  assert.ok(Math.abs(kick.loopEnd - kick.loopStart - 16) < 1e-6, 'four bars');
  assert.equal(d.mock.track(2).color, 0xe5484d);
  const robot = d.mock.track(3).arrangement[0];
  assert.equal(robot.warping, 0);
  const ack = server.acks.find((a) => a.id === 'pkg-1');
  assert.equal(ack.body.status, 'imported');
  assert.deepEqual(ack.body.items.map((i) => i.status), ['imported', 'imported']);
  assert.ok(!server.packages.has('pkg-1'), 'deleted on the server');
  assert.ok(d.stored().imported.some((x) => x.id === 'pkg-1'));
  // Not saved: the files are in Documents/Lloyds App2Live/Inbox/<date> Treinbeat.
  const inbox = path.join(d.home, 'Inbox');
  const folder = fs.readdirSync(inbox).find((f) => f.endsWith('Treinbeat'));
  assert.deepEqual(fs.readdirSync(path.join(inbox, folder)).sort(), ['Kick.wav', 'Robot hallo.wav']);
  // The tempo row offers the package tempo.
  assert.deepEqual(d.last('tempolabel'), ['Use 92 BPM']);
  assert.deepEqual(d.last('tempo'), [1]);
  await d.app.handle('usetempo');
  assert.equal(d.mock.song.tempo, 92);
  assert.deepEqual(d.last('tempo'), [0]);
  assert.match(d.status(), /The Set tempo is now 92 BPM/);
});

test('import into a saved Set: files go to its project folder, tracks into a new scene at the top', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'Song Project '));
  const d = await paired({ live: { filePath: path.join(project, 'Song.als') }, settings: { placement: 'session' } });
  server.addPackage(manifest('pkg-2', [{ file: 'kick.wav', name: 'Kick', kind: 'loop', role: 'drums' }], { title: 'Saved set test' }), { 'kick.wav': LOOP });
  await d.app.handle('import');
  assert.match(d.status(), /1 track imported/);
  const base = path.join(project, 'Samples', 'LA2L');
  const folder = fs.readdirSync(base)[0];
  assert.match(folder, /^\d{4}-\d{2}-\d{2} \d{4} Saved set test$/);
  assert.ok(fs.existsSync(path.join(base, folder, 'Kick.wav')));
  assert.equal(d.mock.song.scenes[0].name, 'Saved set test (Web808)');
  assert.ok(d.mock.track(2).slots[0].clip);
});

test('import: a loop whose tempo Live does not take exactly is named in the status line', async () => {
  // A pessimistic Live: it auto-warps new clips and does not let LA2L remove its markers.
  const d = await paired({ live: { initialWarp: 'autowarp', markerMatch: 'zeroOnly' } });
  server.addPackage(manifest('pkg-tempo', [{ file: 'kick.wav', name: 'Kick', kind: 'loop', role: 'drums' }]), { 'kick.wav': LOOP });
  await d.app.handle('import');
  assert.equal(d.status(), 'Treinbeat: 1 track imported. The tempo of Kick is not exact. See the log.');
  assert.equal(server.acks.find((a) => a.id === 'pkg-tempo').body.status, 'imported');
});

test('import: a damaged file is skipped, the rest goes in, the server hears partial', async () => {
  const d = await paired();
  server.addPackage(
    manifest('pkg-3', [
      { id: 'a', file: 'a.wav', name: 'Good', kind: 'loop', role: 'drums' },
      { id: 'b', file: 'b.wav', name: 'Broken', kind: 'loop', role: 'bass', sha256: 'f'.repeat(64) },
    ]),
    { 'a.wav': LOOP, 'b.wav': LOOP }
  );
  await d.app.handle('import');
  assert.match(d.status(), /1 of 2 tracks imported. Broken did not download: The file arrived damaged/);
  const ack = server.acks.find((a) => a.id === 'pkg-3');
  assert.equal(ack.body.status, 'partial');
  assert.equal(ack.body.items[1].status, 'failed');
  assert.deepEqual(d.mock.song.tracks.map((t) => t.name).slice(2, 4), ['Good (Web808)', '3-Audio']);
});

test('import: a package in a newer format is refused and reported to the server', async () => {
  const d = await paired();
  server.addPackage(manifest('pkg-4', [{ file: 'a.wav', name: 'A', kind: 'loop' }], { schema: 'app2live/2' }), { 'a.wav': LOOP });
  await d.app.handle('import');
  assert.match(d.status(), /Update LA2L/);
  assert.equal(server.acks.find((a) => a.id === 'pkg-4').body.status, 'failed');
  server.packages.delete('pkg-4');
});

test('import: a package placed before (confirmation lost) is confirmed again, not placed twice', async () => {
  const d = await paired();
  server.addPackage(manifest('pkg-5', [{ file: 'a.wav', name: 'Once', kind: 'oneshot' }]), { 'a.wav': SHOT });
  server.failNext(/\/ack$/, 500);
  await d.app.handle('import');
  assert.ok(server.packages.has('pkg-5'), 'still on the server');
  const before = d.mock.song.tracks.length;
  await d.app.handle('import');
  assert.equal(d.mock.song.tracks.length, before, 'no new tracks');
  assert.match(d.status(), /imported before/);
  assert.ok(!server.packages.has('pkg-5'));
});

test('import: two packages, oldest first, tracks in order', async () => {
  const d = await paired();
  server.addPackage(manifest('pkg-7', [{ file: 'b.wav', name: 'Second', kind: 'oneshot' }], { title: 'Two' }), { 'b.wav': SHOT }, '2026-10-16T10:00:02Z');
  server.addPackage(manifest('pkg-6', [{ file: 'a.wav', name: 'First', kind: 'oneshot' }], { title: 'One' }), { 'a.wav': SHOT }, '2026-10-16T10:00:01Z');
  await d.app.handle('import');
  assert.equal(d.status(), '2 packages done. 2 tracks imported.');
  assert.deepEqual(d.mock.song.tracks.map((t) => t.name).slice(2, 4), ['First (Web808)', 'Second (Web808)']);
});

test('a revoked token sends the device back to Pair app', async () => {
  const d = await paired();
  server.revokeAll();
  await d.app.handle('import');
  assert.equal(d.view(), 'unpaired');
  assert.match(d.status(), /no longer paired/);
  assert.equal(d.stored().pairing, null);
});

test('busy: a second click while importing is told to wait', async () => {
  const d = await paired();
  server.addPackage(manifest('pkg-8', [{ file: 'a.wav', name: 'A', kind: 'loop', role: 'drums' }]), { 'a.wav': LOOP });
  const first = d.app.handle('import');
  await d.app.handle('import');
  assert.equal(d.status(), 'Still importing. Wait a moment.');
  await first;
  assert.match(d.status(), /1 track imported/);
});

test('test import: downloads the test file and places it as a 135 BPM drum loop', async () => {
  const d = device();
  d.app.start();
  await d.app.handle('testimport');
  assert.equal(d.status(), 'Test done. Snare (LA2L) is in Live at 135 BPM.');
  const t = d.mock.track(2);
  assert.equal(t.name, 'Snare (LA2L)');
  const clip = t.arrangement[0];
  assert.ok(Math.abs(d.mock.clipTempo(clip) - 135) < 0.05);
  assert.equal(clip.warpMode, 0);
  assert.ok(Math.abs(clip.loopEnd - clip.loopStart - 4) < 1e-6);
});

test('test import follows a redirect', async () => {
  const d = device({ settings: { testUrl: server.origin + '/test/moved.wav' } });
  await d.app.handle('testimport');
  assert.equal(d.status(), 'Test done. Snare (LA2L) is in Live at 135 BPM.');
});

test('test import says so when Live does not take the tempo exactly', async () => {
  const d = device({ live: { initialWarp: 'autowarp', markerMatch: 'zeroOnly' } });
  await d.app.handle('testimport');
  assert.match(d.status(), /^Test done\. Snare \(LA2L\) is in Live but not at exactly 135 BPM \(Live plays it at [\d.]+\)\. The log has the details\.$/);
});

test('test import uses the built-in loop when the download fails or is not a WAV', async () => {
  for (const url of [server.origin + '/test/missing.wav', server.origin + '/test/page.html', 'http://127.0.0.1:1/nothing.wav']) {
    const d = device({ settings: { testUrl: url } });
    await d.app.handle('testimport');
    assert.match(d.status(), /built-in loop was used/, url);
    assert.ok(Math.abs(d.mock.clipTempo(d.mock.track(2).arrangement[0]) - 135) < 0.05);
  }
});

test('self test reports Node, folder, Live, server and pairing', async () => {
  const d = await paired();
  await d.app.handle('selftest');
  assert.match(d.status(), /^Self test: Node v\d+\.\d+\.\d+ \/ folder OK \/ Live 12\.4\.6 OK \/ Set not saved \/ server OK \/ paired with 1 app \/ 0 waiting$/);
  const off = device({ settings: { serverUrl: 'https://127.0.0.1:1/api' } });
  await off.app.handle('selftest');
  assert.match(off.status(), /server offline \/ not paired/);
});

test('self test says when the address is a web site without the App2Live server', async () => {
  // A web page with status 200, a 404, and JSON without "ok": true all mean: no App2Live server there.
  server.files.set('/site/health', Buffer.from('<html>Welcome</html>'));
  server.files.set('/other/health', { status: 'fine' });
  const host = new URL(server.origin).host;
  for (const base of ['/site', '/nothing', '/other']) {
    const d = device({ settings: { serverUrl: server.origin + base } });
    await d.app.handle('selftest');
    assert.match(d.status(), new RegExp(`/ no App2Live server at ${host.replace(/[.]/g, '\\.')} / not paired$`), base);
  }
});

test('an app that unpaired itself drops out of "Paired with" at the next Import or Self test', async () => {
  const d = await paired({ appName: 'Web808' });
  await d.app.handle('addapp');
  await waitFor(() => d.view() === 'pairing', 'the code');
  server.completePairing('Robot Voice');
  await waitFor(() => d.view() === 'paired', 'paired again');
  assert.equal(d.last('pairedwith').join(' '), 'Paired with Web808 and Robot Voice.');
  server.removeApp('Web808');
  await d.app.handle('import');
  assert.equal(d.status(), 'Nothing new yet. Send a sound from your app first.');
  assert.equal(d.last('pairedwith').join(' '), 'Paired with Robot Voice.');
  assert.deepEqual(d.stored().pairing.apps, ['Robot Voice']);
  server.removeApp('Robot Voice');
  await d.app.handle('settings', 1);
  await d.app.handle('selftest');
  assert.match(d.status(), / \/ server OK \/ no app paired \/ 0 waiting$/);
  assert.equal(d.view(), 'settings', 'Settings stays open');
  await d.app.handle('settings', 0);
  assert.equal(d.view(), 'unpaired', 'Pair app instead of Import');
  const token = d.stored().pairing.token;
  assert.ok(token, 'the computer keeps its token');
  // Pair app now adds an app to the same computer, as Add app does.
  await d.app.handle('pair');
  await waitFor(() => d.view() === 'pairing', 'the code');
  server.completePairing('Web808');
  await waitFor(() => d.view() === 'paired', 'paired again');
  assert.equal(d.stored().pairing.token, token);
  assert.equal(d.last('pairedwith').join(' '), 'Paired with Web808.');
});

test('with no app left, Import says so and the device shows Pair app', async () => {
  const d = await paired({ appName: 'Web808' });
  server.removeApp('Web808');
  await d.app.handle('import');
  assert.equal(d.status(), 'No app paired. Click Pair app to add one.');
  assert.equal(d.view(), 'unpaired');
  assert.ok(d.stored().pairing.token);
});

test('at start the device asks for its apps; a revoked token goes back to Pair app', async () => {
  const first = await paired({ appName: 'Web808' });
  const pairing = first.stored().pairing;
  server.removeApp('Web808');
  const d = device({ pairing });
  d.app.start();
  assert.equal(d.view(), 'paired', 'the stored list still has Web808');
  await d.app.startup;
  assert.equal(d.view(), 'unpaired');
  assert.equal(d.status(), 'No app paired. Click Pair app to add one.');
  assert.deepEqual(d.stored().pairing.apps, []);
  assert.equal(d.stored().pairing.token, pairing.token);
  // The next start begins with Pair app at once.
  const again = device({ pairing: d.stored().pairing });
  again.app.start();
  assert.equal(again.view(), 'unpaired');
  assert.equal(again.status(), 'Ready.');
  await again.app.startup;
  server.revokeAll();
  const gone = device({ pairing });
  gone.app.start();
  await gone.app.startup;
  assert.equal(gone.view(), 'unpaired');
  assert.equal(gone.status(), 'This computer is no longer paired. Click Pair app to pair again.');
  assert.equal(gone.stored().pairing, null);
});

test('while Import shows, the app list is checked in the background: Pair app comes back by itself', async () => {
  const d = await paired({ appName: 'Web808', timing: { appsCheckMs: 30 } });
  await d.app.startup;
  try {
    await sleep(120);
    assert.equal(d.view(), 'paired', 'nothing changes while the app is paired');
    // No check while a code shows: Add app, then the first app unpairs itself.
    await d.app.handle('addapp');
    await waitFor(() => d.view() === 'pairing', 'the code');
    server.removeApp('Web808');
    await sleep(120);
    assert.equal(d.view(), 'pairing');
    server.completePairing('Robot Voice');
    await waitFor(() => d.last('pairedwith').join(' ') === 'Paired with Robot Voice.', 'the list from the server');
    assert.equal(d.view(), 'paired');
    // "Unpair this browser" in the last app: Pair app comes back without a click.
    server.removeApp('Robot Voice');
    await waitFor(() => d.view() === 'unpaired', 'Pair app');
    assert.equal(d.status(), 'No app paired. Click Pair app to add one.');
    assert.ok(d.stored().pairing.token, 'the computer keeps its token');
    // With no app left the device stops asking.
    const asked = server.log.filter((l) => l === 'GET /api/apps').length;
    await sleep(120);
    assert.equal(server.log.filter((l) => l === 'GET /api/apps').length, asked);
  } finally {
    d.app.stop();
  }
});

test('the background check logs a server that does not answer once; a revoked token goes back to Pair app', async () => {
  const d = await paired({ appName: 'Web808', timing: { appsCheckMs: 20 } });
  await d.app.startup;
  const appLines = () => (fs.readFileSync(path.join(d.home, 'la2l.log'), 'utf8').match(/App list: /g) || []).length;
  try {
    server.failNext(/^\/api\/apps$/, 503, 1000);
    await sleep(200);
    server.failures = [];
    assert.equal(appLines(), 1, 'logged once, not at every check');
    assert.equal(d.view(), 'paired');
    server.revokeAll();
    await waitFor(() => d.view() === 'unpaired', 'Pair app');
    assert.equal(d.status(), 'This computer is no longer paired. Click Pair app to pair again.');
    assert.equal(d.stored().pairing, null);
  } finally {
    server.failures = [];
    d.app.stop();
  }
});

test('a server without the app list (older than 0.6.0): the device keeps the names it knows', async () => {
  server.appList = false;
  try {
    const d = await paired({ appName: 'Web808', timing: { appsCheckMs: 20 } });
    // After the first 404, the background check does not ask again.
    await waitFor(() => d.app.noAppList, 'the first background check');
    const asked = server.log.filter((l) => l === 'GET /api/apps').length;
    await sleep(100);
    assert.equal(server.log.filter((l) => l === 'GET /api/apps').length, asked);
    d.app.stop();
    await d.app.handle('selftest');
    assert.match(d.status(), / \/ server OK \/ paired \/ 0 waiting$/);
    await d.app.handle('import');
    assert.equal(d.last('pairedwith').join(' '), 'Paired with Web808.');
    assert.match(fs.readFileSync(path.join(d.home, 'la2l.log'), 'utf8'), /App list: this server does not give one/);
  } finally {
    server.appList = true;
  }
});

test('unpair needs a second click', async () => {
  const d = await paired();
  await d.app.handle('settings', 1);
  assert.equal(d.view(), 'settings');
  await d.app.handle('unpair');
  assert.match(d.status(), /Click Unpair again/);
  assert.ok(d.stored().pairing);
  await d.app.handle('unpair');
  assert.equal(d.stored().pairing, null);
  assert.equal(d.view(), 'unpaired');
  assert.deepEqual(d.last('settingsbutton'), [0]);
  assert.ok(server.log.includes('POST /api/unpair'), 'the server was told');
});

test('settings: placement and new tracks are stored, the view comes back', async () => {
  const d = device();
  d.app.start();
  d.app.handle('settings', 1);
  assert.equal(d.view(), 'settings');
  d.app.handle('placement', 1);
  d.app.handle('newtracks', 1);
  assert.equal(d.stored().settings.placement, 'session');
  assert.equal(d.stored().settings.newTracks, 'end');
  d.app.handle('settings', 0);
  assert.equal(d.view(), 'unpaired');
  d.app.handle('openfolder');
  assert.deepEqual(d.opened, [d.home]);
  // A second device (another Set) reads the same file.
  const again = new App({ home: d.home, out: () => {} });
  assert.equal(again.store.settings.placement, 'session');
});

test('Live part not answering: a clear message', async () => {
  const d = device({ liveAnswers: false, timing: { liveTimeoutMs: 100 } });
  await d.app.handle('testimport');
  assert.match(d.status(), /The Live part of LA2L does not answer. LA2L needs Live 12.4 or newer/);
});

test('a server address without https is refused', async () => {
  const d = device({ settings: { serverUrl: 'http://example.com/api' } });
  await d.app.handle('pair');
  assert.match(d.status(), /must start with https/);
});

test('unknown messages are only logged', () => {
  const d = device();
  assert.equal(d.app.handle('dance', 1, 2), undefined);
  assert.match(fs.readFileSync(path.join(d.home, 'la2l.log'), 'utf8'), /Unknown message from Max: dance 1 2/);
});
