// The command line, against the local test receiver: pair, send, status, unpair, LA2L_TOKEN, and
// the test receiver itself with --local.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LA2L, memoryStorage, wavFromSamples } from '../dist/index.js';
import { startTestReceiver } from '../dist/testing/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'dist', 'cli', 'main.js');
const WAV = path.join(HERE, '..', '..', 'fixtures', 'wav', 'pcm16-stereo.wav');

let local;
let config;
test.before(async () => {
  local = await startTestReceiver();
  config = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-cli-'));
});
test.after(async () => {
  await local.close();
  fs.rmSync(config, { recursive: true, force: true });
});

// Runs the command line. Resolves to { code, out, err }.
function la2l(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: Object.assign({}, process.env, { LA2L_CONFIG_DIR: config, LA2L_SERVER: local.server }, env) }, (error, out, err) => {
      resolve({ code: error ? error.code : 0, out, err });
    });
  });
}

test('help, and a wrong command or option', async () => {
  const help = await la2l(['help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /la2l pair \[code\]/);
  assert.match(help.out, /la2l test-receiver/);
  assert.deepEqual(await la2l(['dance']).then((r) => [r.code, r.err]), [2, 'Unknown command dance. See la2l help.\n']);
  assert.deepEqual(await la2l(['constructor']).then((r) => [r.code, r.err]), [2, 'Unknown command constructor. See la2l help.\n']);
  assert.deepEqual(await la2l(['send', '--fast']).then((r) => [r.code, r.err]), [2, 'Unknown option --fast. See la2l help.\n']);
});

test('pair, send a loop and wait for Live, status, unpair', async () => {
  assert.deepEqual(await la2l(['pair', 'K7P42']).then((r) => [r.code, r.err]), [1, 'A code has 6 letters and digits, like K7P 42Q.\n']);
  const paired = await la2l(['pair', await local.newCode()]);
  assert.equal(paired.code, 0, paired.err);
  assert.match(paired.out, /^Paired with Test receiver\./);
  assert.deepEqual(await la2l(['send', WAV]).then((r) => [r.code, r.err]), [2, 'Say what the sounds are: --loop or --oneshot.\n']);
  assert.deepEqual(await la2l(['send', WAV, '--loop', '--role', 'drum']).then((r) => [r.code, r.err]), [2, '--role must be one of: drums, bass, melodic, vocal, texture, fx.\n']);
  const before = local.reports.length;
  const sent = await la2l(['send', WAV, '--loop', '--bpm', '120', '--role', 'drums', '--title', 'From the command line', '--name', 'Snare', '--wait']);
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.out, /^Sent: 1 sound\. Click Import in Live\. Package [0-9a-f-]{36}\nWaiting for Import in Live\.\.\.\nIn Live: 1 of 1\.\n$/);
  const report = local.reports[before];
  assert.deepEqual([report.title, report.sounds[0].plan.trackName, report.sounds[0].plan.warpModeName, report.sounds[0].plan.bpm], ['From the command line', 'Snare (la2l command line)', 'Beats', 120]);
  assert.match((await la2l(['status'])).out, /^[0-9a-f-]{36}: In Live: 1 of 1\.\n$/);
  assert.deepEqual(await la2l(['unpair']).then((r) => [r.code, r.out]), [0, 'Unpaired.\n']);
  assert.deepEqual(await la2l(['status']).then((r) => [r.code, r.err]), [1, 'This app is not paired. Type the code LA2L shows in Live. Pair first: la2l pair\n']);
});

test('LA2L_TOKEN: a token from the environment, kept nowhere', async () => {
  // An app token, as a CI system would keep it in a secret.
  const storage = memoryStorage();
  await new LA2L({ appName: 'CI job', server: local.server, storage }).pair(await local.newCode());
  const token = storage.get('token');
  const r = await la2l(['send', WAV, '--oneshot'], { LA2L_TOKEN: token, LA2L_APP_NAME: 'CI job', LA2L_CONFIG_DIR: path.join(config, 'other') });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Sent: 1 sound\./);
  const kept = fs.readdirSync(path.join(config, 'other')).find((f) => /^ci-job-[0-9a-f]{8}\.json$/.test(f));
  assert.ok(kept, 'the app id is kept for the CI job');
  assert.ok(!fs.readFileSync(path.join(config, 'other', kept), 'utf8').includes(token), 'the token from the environment is not written down');
});

test('test-receiver --local: an LA2L server in memory that imports what an app sends', async () => {
  const child = spawn(process.execPath, [CLI, 'test-receiver', '--local'], { env: Object.assign({}, process.env, { LA2L_CONFIG_DIR: config }) });
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  const until = async (re) => {
    for (let i = 0; i < 200 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    const m = re.exec(out);
    assert.ok(m, out);
    return m;
  };
  try {
    const [, server] = await until(/with an LA2L server in memory: (http:\/\/127\.0\.0\.1:\d+\/api)\n/);
    const [, code] = await until(/pair with code ([A-Z0-9]{3} [A-Z0-9]{3})\./);
    const app = new LA2L({ appName: 'Web808', server, storage: memoryStorage() });
    await app.pair(code);
    const delivery = await app.send({ title: 'Beat', bpm: 92, sounds: [{ name: 'Kick', audio: wavFromSamples(new Float32Array(48000).fill(0.1), 48000), kind: 'loop', role: 'drums' }] });
    assert.equal((await delivery.imported({ intervalMs: 1000 })).status, 'imported');
    await until(/Beat \(Web808\): imported 1 of 1 sound\n {2}Kick \(Web808\): loop, warped in Beats mode at 92 BPM, 1\.533 beats\. 48 kHz, 16-bit, mono, 1 s\n/);
  } finally {
    child.kill('SIGINT');
  }
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  assert.equal(code, 0);
});
