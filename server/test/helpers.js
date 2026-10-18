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
    // The storage warning, as the server checks it every minute. True when it warned.
    checkStorage: () => s.checkStorage(),
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

// A ZIP archive, as a music app would share it: entries of { name, data, method } where method 0
// stores and 8 deflates. `flags` sets the general purpose flags (default: UTF-8 names); `rawName`
// gives the name as bytes; `descriptor` puts sizes and CRC after the data, as streaming writers
// do; `size`, `packedSize` and `crc` lie in the central directory. `comment` goes at the end.
function makeZip(entries, comment = '') {
  const zlib = require('zlib');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = e.rawName || Buffer.from(e.name);
    const method = e.method === undefined ? 8 : e.method;
    const packed = method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const crc = e.crc === undefined ? zlib.crc32(e.data) : e.crc;
    const flags = (e.flags === undefined ? 0x800 : e.flags) | (e.descriptor ? 0x08 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(e.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(e.descriptor ? 0 : packed.length, 18);
    local.writeUInt32LE(e.descriptor ? 0 : e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    if (e.descriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(packed.length, 8);
      d.writeUInt32LE(e.data.length, 12);
      parts.push(d);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(e.packedSize === undefined ? packed.length : e.packedSize, 20);
    c.writeUInt32LE(e.size === undefined ? e.data.length : e.size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + packed.length + (e.descriptor ? 16 : 0);
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...parts, dir, end, Buffer.from(comment)]);
}

module.exports = { startServer, request, fakeClock, pairStart, pairDevice, sha256, loopWav, shotWav, compressedWav, packageManifest, sendPackage, makeZip };
