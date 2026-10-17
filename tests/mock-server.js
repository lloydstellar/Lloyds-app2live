'use strict';
// A fake App2Live server for the tests, following docs/server-api.md.
// Everything lives in memory. Tests drive it with completePairing(), addPackage(), removeApp()
// and failNext(). appList = false makes it an older server without GET /apps.

const http = require('http');
const crypto = require('crypto');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

class MockServer {
  constructor() {
    this.pairs = new Map(); // pair_id -> { code, status, token, app, existing }
    this.tokens = new Map(); // token -> { apps }
    this.packages = new Map(); // package_id -> { manifest, files, createdAt }
    this.acks = [];
    this.log = [];
    this.failures = []; // { re, status, times }
    this.files = new Map(); // extra plain files, e.g. /test/snare.wav
    this.appList = true; // false: answers GET /apps with 404, as la2l-server before 0.6.0
  }

  start() {
    this.http = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve) => {
      this.http.listen(0, '127.0.0.1', () => {
        this.port = this.http.address().port;
        this.origin = `http://127.0.0.1:${this.port}`;
        this.base = this.origin + '/api';
        resolve(this.base);
      });
    });
  }

  stop() {
    return new Promise((resolve) => this.http.close(resolve));
  }

  // ---- test controls ----

  completePairing(appName) {
    const p = [...this.pairs.values()].reverse().find((x) => x.status === 'waiting');
    if (!p) throw new Error('nobody is waiting to pair');
    p.status = 'paired';
    p.token = p.existing || crypto.randomBytes(16).toString('hex');
    const t = this.tokens.get(p.token) || { apps: [] };
    t.apps.push(appName);
    this.tokens.set(p.token, t);
    p.app = appName;
  }

  expirePairing() {
    for (const p of this.pairs.values()) if (p.status === 'waiting') p.status = 'expired';
  }

  revokeAll() {
    this.tokens.clear();
  }

  // An app unpairs itself (POST /app/unpair in the real server): it drops out of every computer.
  removeApp(appName) {
    for (const t of this.tokens.values()) t.apps = t.apps.filter((a) => a !== appName);
  }

  // manifest: the package description. files: { 'kick.wav': Buffer }. sha256 and bytes are
  // filled in when the manifest leaves them out (set them to null to leave them out for real).
  addPackage(manifest, files, createdAt) {
    for (const it of manifest.items || []) {
      const b = files[it.file];
      if (b && it.sha256 === undefined) it.sha256 = sha256(b);
      if (b && it.bytes === undefined) it.bytes = b.length;
      if (it.sha256 === null) delete it.sha256;
      if (it.bytes === null) delete it.bytes;
    }
    this.packages.set(manifest.package_id, { manifest, files, createdAt: createdAt || new Date(Date.now() + this.packages.size).toISOString() });
  }

  failNext(re, status, times = 1) {
    this.failures.push({ re, status, times });
  }

  // ---- HTTP ----

  send(res, status, body, headers = {}) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({ 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length }, headers));
    res.end(data);
  }

  auth(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return m && this.tokens.has(m[1]) ? m[1] : null;
  }

  async body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  async handle(req, res) {
    const url = new URL(req.url, this.origin);
    const p = url.pathname;
    this.log.push(`${req.method} ${p}`);
    const f = this.failures.find((x) => x.re.test(p) && x.times > 0);
    if (f) {
      f.times--;
      return this.send(res, f.status, { error: 'simulated failure' });
    }
    if (this.files.has(p)) {
      const v = this.files.get(p);
      if (typeof v === 'function') return v(req, res);
      return this.send(res, 200, v);
    }
    let m;
    if (req.method === 'GET' && p === '/api/health') return this.send(res, 200, { ok: true, name: 'mock' });
    if (req.method === 'POST' && p === '/api/pair/start') {
      const body = await this.body(req);
      if (!body.device_id) return this.send(res, 400, { error: 'device_id missing' });
      const id = crypto.randomUUID();
      const code = 'K7P42Q';
      this.pairs.set(id, { code, status: 'waiting', existing: this.auth(req), device: body });
      return this.send(res, 200, { pair_id: id, code, expires_in: 600, expires_at: new Date(Date.now() + 600000).toISOString(), poll_ms: 500 });
    }
    if ((m = /^\/api\/pair\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      const pair = this.pairs.get(m[1]);
      if (!pair) return this.send(res, 404, { error: 'unknown pairing' });
      if (pair.status === 'paired') return this.send(res, 200, { status: 'paired', device_token: pair.token, app_name: pair.app });
      return this.send(res, 200, { status: pair.status });
    }
    if ((m = /^\/api\/pair\/([^/]+)\/cancel$/.exec(p)) && req.method === 'POST') {
      const pair = this.pairs.get(m[1]);
      if (pair) pair.status = 'cancelled';
      return this.send(res, 200, { ok: true });
    }
    const token = this.auth(req);
    if (p === '/api/inbox' || p.startsWith('/api/packages/') || p === '/api/unpair' || (p === '/api/apps' && this.appList)) {
      if (!token) return this.send(res, 401, { error: 'unknown token' });
    }
    if (req.method === 'GET' && p === '/api/inbox') {
      const packages = [...this.packages.entries()].map(([id, x]) => ({
        package_id: id,
        title: x.manifest.title,
        app: x.manifest.source && x.manifest.source.app,
        items: (x.manifest.items || []).length,
        created_at: x.createdAt,
      }));
      return this.send(res, 200, { packages });
    }
    if (req.method === 'GET' && p === '/api/apps' && this.appList) {
      const apps = this.tokens.get(token).apps.map((name) => ({ name, paired_at: '2026-10-17T10:00:00.000Z', last_seen_at: null }));
      return this.send(res, 200, { apps });
    }
    if ((m = /^\/api\/packages\/([^/]+)\/manifest$/.exec(p)) && req.method === 'GET') {
      const x = this.packages.get(decodeURIComponent(m[1]));
      return x ? this.send(res, 200, x.manifest) : this.send(res, 404, { error: 'unknown package' });
    }
    if ((m = /^\/api\/packages\/([^/]+)\/files\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      const x = this.packages.get(decodeURIComponent(m[1]));
      const file = x && x.files[decodeURIComponent(m[2])];
      return file ? this.send(res, 200, file, { 'Content-Type': 'audio/wav' }) : this.send(res, 404, { error: 'unknown file' });
    }
    if ((m = /^\/api\/packages\/([^/]+)\/ack$/.exec(p)) && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await this.body(req);
      this.acks.push({ id, body });
      if (body.status === 'imported' || body.status === 'partial') this.packages.delete(id);
      return this.send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/unpair') {
      this.tokens.delete(token);
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { error: 'not found' });
  }
}

module.exports = { MockServer, sha256 };
