'use strict';
// Starts a real server for a test: port 0, a fresh data folder, rate limits off unless a test
// turns them on, every log line kept in `lines`, and optionally a clock the test moves forward.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { loadConfig } = require('../src/config');
const { start } = require('../src/main');
const { buildWav16 } = require('../../src/node/wav');
const { makeLoop } = require('../../src/node/testsound');

// One HTTP exchange with full control: the path goes out exactly as given (no normalising).
// A plain object as body is sent as JSON. Resolves to { status, headers, body, json }.
function request(port, method, urlPath, { headers = {}, body, token } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.Authorization = 'Bearer ' + token;
  let data;
  if (body !== undefined) {
    data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (typeof body === 'object' && !Buffer.isBuffer(body) && !h['Content-Type']) h['Content-Type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch (e) {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// A clock for the server that only moves when the test says so.
function fakeClock(startMs = Date.parse('2026-10-16T12:00:00.000Z')) {
  let now = startMs;
  const clock = () => now;
  clock.add = (ms) => {
    now += ms;
  };
  return clock;
}

// env: settings as environment variables. overrides: fields of the config object itself.
// opts.clock: a fakeClock(); opts.dataDir: reuse a data folder (a restart).
async function startServer(env = {}, overrides = {}, opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-server-'));
  const config = Object.assign(
    loadConfig(Object.assign({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, RATE_LIMITS: 'off', TRUST_PROXY: '0' }, env)),
    overrides
  );
  const lines = [];
  const s = await start(config, { log: (line) => lines.push(line), clock: opts.clock });
  const origin = `http://127.0.0.1:${s.port}`;
  return {
    port: s.port,
    origin,
    base: origin + '/api',
    config,
    dataDir,
    lines,
    store: s.store,
    // One run of the cleanup now, as the server does every minute. Returns the counts.
    cleanup: () => s.cleanup(),
    request: (method, urlPath, o) => request(s.port, method, urlPath, o),
    // Stops the server; the data folder goes too, unless keepData.
    async stop({ keepData = false } = {}) {
      await s.close();
      if (!keepData) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Pair start as device 0.1.1 sends it. Resolves to the answer's JSON.
async function pairStart(s, deviceId = 'dev-1', token) {
  const r = await s.request('POST', '/api/pair/start', {
    body: { device_id: deviceId, device_name: 'ERIK-PC', client: 'LA2L 0.1.1', platform: 'win32' },
    token,
  });
  if (r.status !== 200) throw new Error(`pair/start answered ${r.status}: ${r.body}`);
  return r.json;
}

// A whole pairing: start, claim, and the paired answer the device gets.
// Resolves to { pairId, code, appToken, deviceToken, deviceName }.
async function pairDevice(s, { deviceId = 'dev-1', appName = 'LA2L Sender', appId, token } = {}) {
  const start = await pairStart(s, deviceId, token);
  const claim = await s.request('POST', '/api/pair/claim', { body: { code: start.code, app_name: appName, app_id: appId } });
  if (claim.status !== 200) throw new Error(`pair/claim answered ${claim.status}: ${claim.body}`);
  const status = await s.request('GET', '/api/pair/' + start.pair_id);
  return { pairId: start.pair_id, code: start.code, appToken: claim.json.app_token, deviceToken: status.json.device_token, deviceName: claim.json.device_name };
}

// ---- packages ----

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Sounds for packages: a one-bar loop at a tempo, and a short one-shot.
const loopWav = (bpm = 120, beats = 4) => buildWav16(makeLoop(bpm, beats), 1, 44100);
const shotWav = (frames = 4410) => buildWav16(new Float32Array(frames).map((_, i) => Math.sin(i / 7) * 0.4), 1, 44100);

// A WAV header that says MP3 inside (format 85), as some converters write it.
function compressedWav() {
  const b = buildWav16(new Float32Array(100), 1, 44100);
  b.writeUInt16LE(85, 20);
  return b;
}

// A manifest for these sounds. sounds: [{ file, data, ...other item fields }]; bytes and sha256
// come from data unless the sound sets them.
function packageManifest(sounds, o = {}) {
  return Object.assign(
    {
      schema: 'app2live/1',
      title: 'Test package',
      source: { app: 'LA2L Sender', app_version: 'test', platform: 'web' },
      items: sounds.map(({ data, ...item }) => Object.assign({ bytes: data.length, sha256: sha256(data) }, item)),
    },
    o
  );
}

// A whole send as an app does it: the manifest, every file, the commit.
// Resolves to { packageId, upload, created }.
async function sendPackage(s, appToken, sounds, o = {}) {
  const created = await s.request('POST', '/api/packages', { token: appToken, body: packageManifest(sounds, o) });
  if (created.status !== 201) throw new Error(`POST /packages answered ${created.status}: ${created.body}`);
  const { package_id: packageId, upload } = created.json;
  for (const { file, data } of sounds) {
    const put = await s.request('PUT', '/api' + upload[file], { token: appToken, body: data, headers: { 'Content-Type': 'audio/wav' } });
    if (put.status !== 200) throw new Error(`PUT ${file} answered ${put.status}: ${put.body}`);
  }
  const commit = await s.request('POST', `/api/packages/${packageId}/commit`, { token: appToken });
  if (commit.status !== 200) throw new Error(`commit answered ${commit.status}: ${commit.body}`);
  return { packageId, upload, created: created.json };
}

module.exports = { startServer, request, fakeClock, pairStart, pairDevice, sha256, loopWav, shotWav, compressedWav, packageManifest, sendPackage };
