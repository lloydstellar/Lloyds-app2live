// A small LA2L server in memory, on 127.0.0.1, for tests and AI agents: no internet and no rate
// limits. It answers the app side as la2l-server does, with the same texts (sdk/js/test/
// app-side.test.mjs runs the same tests against both), and the part of the device side that the
// test receiver uses. Node.js only.

import http from 'node:http';
import crypto from 'node:crypto';
import { checkManifest, isValidFileName } from '../manifest.js';
import { checkWav } from '../wav.js';
import { VERSION } from '../version.js';

const MAX_JSON = 1048576;
// Everything is kept in memory: at most this much sound at a time, as a server has its disk.
const MAX_STORED = 1024 * 1048576;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_TTL_S = 600;
const UPLOAD_TTL_MS = 3600000;
const PACKAGE_TTL_MS = 24 * 3600000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAIR_ID = /^[A-Za-z0-9_-]{20,100}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;

const WRONG_CODE = 'This code does not work. Check the code in Live.';
const APP_401 = 'Unknown token. Pair this app again.';
const DEVICE_401 = 'Unknown token. Pair this computer again.';
const UNKNOWN_PACKAGE = 'Unknown package.';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Retry-After' };
const PREFLIGHT = {
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-LA2L-Client',
  'Access-Control-Max-Age': '600',
};

class Answer extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
  }
}

interface Device {
  id: number;
  deviceId: string;
  name: string;
  token: string;
  revoked: boolean;
}
interface App {
  id: number;
  publicId: string;
  device: number;
  name: string;
  appId: string;
  token: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
}
interface Pairing {
  code: string;
  status: 'waiting' | 'paired' | 'cancelled';
  device: number | null;
  deviceId: string;
  deviceName: string;
  expiresAt: number;
  deviceToken?: string;
  appName?: string;
}
interface FileEntry {
  bytes: number;
  sha256: string;
  data: Buffer | null;
}
interface Package {
  id: string;
  device: number;
  app: number;
  title: string;
  appName: string;
  manifest: Record<string, unknown>;
  files: Map<string, FileEntry>;
  status: 'uploading' | 'waiting' | 'imported' | 'partial' | 'failed' | 'expired' | 'deleted';
  ack: Record<string, unknown> | null;
  createdAt: number;
  committedAt: string | null;
  expiresAt: number;
  updatedAt: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const random = () => crypto.randomBytes(32).toString('base64url');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function errorText(message: string): string {
  const t = String(message || '').replace(/\s+/g, ' ').trim() || 'Something went wrong.';
  if (t.length <= 80) return t;
  const cut = t.slice(0, 80);
  const space = cut.lastIndexOf(' ');
  return (space >= 60 ? cut.slice(0, space) : cut).trim();
}

function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('').trim();
}

function cleanName(name: unknown, fallback: string, max: number): string {
  const s = String(name == null ? '' : name)
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _\-().'&+#!]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (s.length > max ? s.slice(0, max).trim() : s) || fallback;
}

function bearer(header: unknown): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(typeof header === 'string' ? header : '');
  return m ? m[1] : null;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<{ data: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = Number(req.headers['content-length']) > limit;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) tooLarge = true;
      if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => resolve({ data: Buffer.concat(chunks), tooLarge }));
    req.on('error', reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const { data, tooLarge } = await readBody(req, MAX_JSON);
  if (tooLarge) throw new Answer(413, 'The request is larger than 1 MB.');
  if (!data.length) return {};
  if (!/^application\/json\s*(;.*)?$/i.test(String(req.headers['content-type'] || '').trim())) throw new Answer(415, 'Send JSON with Content-Type: application/json.');
  let v: unknown;
  try {
    v = JSON.parse(data.toString('utf8'));
  } catch (e) {
    throw new Answer(400, 'The request is not valid JSON.');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Answer(400, 'Send a JSON object.');
  return v as Record<string, unknown>;
}

type Handler = (req: http.IncomingMessage, params: Record<string, string>) => Promise<[number, unknown] | Buffer | void>;

export class LocalServer {
  private readonly devices = new Map<number, Device>();
  private readonly apps = new Map<number, App>();
  private readonly pairings = new Map<string, Pairing>();
  private readonly packages = new Map<string, Package>();
  private readonly routes: { method: string; re: RegExp; names: string[]; handler: Handler; notFound: string }[] = [];
  private readonly writing = new Set<string>();
  private nextId = 1;
  private http: http.Server | null = null;
  /** The address of the API, for the SDK's `server` option: http://127.0.0.1:<port>/api. */
  server = '';
  port = 0;

  constructor() {
    this.define();
  }

  /** Starts listening on 127.0.0.1. Resolves to the address of the API. */
  start(port = 0): Promise<string> {
    this.http = http.createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) this.send(res, 500, { error: 'The server has a problem. Try again later.' });
      });
    });
    return new Promise((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(port, '127.0.0.1', () => {
        this.port = (this.http!.address() as { port: number }).port;
        this.server = `http://127.0.0.1:${this.port}/api`;
        resolve(this.server);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }

  private add(method: string, pattern: string, handler: Handler, params: Record<string, RegExp | ((v: string) => boolean)> = {}, notFound = 'Not found.'): void {
    const names: string[] = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(seg.slice(1));
        return '([^/]+)';
      })
      .join('/');
    const wrapped: Handler = async (req, raw) => {
      for (const [name, test] of Object.entries(params)) {
        const ok = typeof test === 'function' ? test(raw[name]) : test.test(raw[name]);
        if (!ok) throw new Answer(404, notFound);
      }
      return handler(req, raw);
    };
    this.routes.push({ method, re: new RegExp(`^${source}$`), names, handler: wrapped, notFound });
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' }, CORS, headers));
    res.end(data);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = String(req.url || '/').split('?')[0];
    if (path !== '/api' && !path.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return void res.end('Not found.\n');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({}, CORS, PREFLIGHT));
      return void res.end();
    }
    this.cleanup();
    try {
      const allow: string[] = [];
      for (const route of this.routes) {
        const m = route.re.exec(path);
        if (!m) continue;
        if (route.method !== req.method && !(req.method === 'HEAD' && route.method === 'GET')) {
          allow.push(route.method);
          if (route.method === 'GET') allow.push('HEAD');
          continue;
        }
        const params: Record<string, string> = {};
        for (const [i, name] of route.names.entries()) {
          try {
            params[name] = decodeURIComponent(m[i + 1]);
          } catch (e) {
            throw new Answer(404, route.notFound);
          }
        }
        const out = await route.handler(req, params);
        if (Buffer.isBuffer(out)) {
          res.writeHead(200, Object.assign({ 'Content-Type': 'audio/wav', 'Content-Length': out.length, 'Cache-Control': 'no-store' }, CORS));
          return void res.end(req.method === 'HEAD' ? undefined : out);
        }
        const [status, body] = out as [number, unknown];
        return this.send(res, status, body);
      }
      if (allow.length) throw new Answer(405, 'This method is not allowed here.', { Allow: [...new Set(allow)].join(', ') });
      throw new Answer(404, 'Not found.');
    } catch (e) {
      if (e instanceof Answer) return this.send(res, e.status, { error: errorText(e.message) }, e.headers);
      throw e;
    }
  }

  // ---- who is calling ----

  private device(req: http.IncomingMessage): Device {
    const token = bearer(req.headers.authorization);
    const d = [...this.devices.values()].find((x) => x.token === token && !x.revoked);
    if (!token || !d) throw new Answer(401, DEVICE_401);
    return d;
  }

  private app(req: http.IncomingMessage): App {
    const token = bearer(req.headers.authorization);
    const a = [...this.apps.values()].find((x) => x.token === token && !x.revoked);
    if (!token || !a || this.devices.get(a.device)!.revoked) throw new Answer(401, APP_401);
    a.lastSeenAt = iso(Date.now());
    return a;
  }

  private statusOf(p: Package): Package['status'] {
    const now = Date.now();
    if ((p.status === 'waiting' || p.status === 'failed') && p.expiresAt <= now) return 'expired';
    if (p.status === 'uploading' && p.createdAt + UPLOAD_TTL_MS <= now) return 'expired';
    return p.status;
  }

  private dropPackage(id: string): void {
    this.packages.delete(id);
  }

  // What the cleanup of la2l-server would have removed by now: uploads not committed within an
  // hour, packages past their 24 hours. Runs before every request, so memory does not grow.
  private cleanup(): void {
    for (const p of [...this.packages.values()]) {
      const status = this.statusOf(p);
      if (p.status === 'uploading' && status === 'expired') this.dropPackage(p.id);
      else if (status === 'expired' && p.status !== 'expired') {
        p.status = 'expired';
        for (const f of p.files.values()) f.data = null;
      }
    }
  }

  private storedBytes(): number {
    let n = 0;
    for (const p of this.packages.values()) for (const f of p.files.values()) if (f.data) n += f.data.length;
    return n;
  }

  // ---- the routes, as in server/src/routes ----

  private define(): void {
    const PACKAGE = { id: UUID };

    this.add('GET', '/api/health', async () => [200, { ok: true, name: 'la2l test receiver', version: VERSION }]);

    // The device side, as far as the test receiver uses it.
    this.add('POST', '/api/pair/start', async (req) => {
      const body = await readJson(req);
      const deviceId = typeof body.device_id === 'string' ? body.device_id : '';
      if (!/^[A-Za-z0-9-]{1,100}$/.test(deviceId)) throw new Answer(400, 'device_id is missing.');
      const token = bearer(req.headers.authorization);
      const device = [...this.devices.values()].find((d) => d.token === token && !d.revoked) || null;
      for (const p of this.pairings.values()) if (p.deviceId === deviceId && p.status === 'waiting') p.status = 'cancelled';
      let code = '';
      do code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
      while ([...this.pairings.values()].some((p) => p.code === code && p.status === 'waiting'));
      const pairId = random();
      const expiresAt = Date.now() + PAIR_TTL_S * 1000;
      this.pairings.set(pairId, { code, status: 'waiting', device: device ? device.id : null, deviceId, deviceName: cleanText(body.device_name, 64) || 'Computer', expiresAt, deviceToken: device ? device.token : undefined });
      return [200, { pair_id: pairId, code, expires_in: PAIR_TTL_S, expires_at: iso(expiresAt), poll_ms: 500 }];
    });

    this.add(
      'GET',
      '/api/pair/:id',
      async (_req, { id }) => {
        const p = this.pairings.get(id);
        if (!p) throw new Answer(404, 'Unknown pairing.');
        if (p.status === 'waiting') return [200, { status: p.expiresAt <= Date.now() ? 'expired' : 'waiting' }];
        if (p.status === 'cancelled') return [200, { status: 'cancelled' }];
        return [200, { status: 'paired', device_token: p.deviceToken, app_name: p.appName }];
      },
      { id: PAIR_ID },
      'Unknown pairing.'
    );

    this.add(
      'POST',
      '/api/pair/:id/cancel',
      async (_req, { id }) => {
        const p = this.pairings.get(id);
        if (!p) throw new Answer(404, 'Unknown pairing.');
        if (p.status === 'waiting') p.status = 'cancelled';
        return [200, { ok: true }];
      },
      { id: PAIR_ID },
      'Unknown pairing.'
    );

    this.add('GET', '/api/inbox', async (req) => {
      const d = this.device(req);
      const now = Date.now();
      const packages = [...this.packages.values()]
        .filter((p) => p.device === d.id && (p.status === 'waiting' || p.status === 'failed') && p.expiresAt > now)
        .sort((a, b) => String(a.committedAt).localeCompare(String(b.committedAt)))
        .map((p) => ({ package_id: p.id, title: p.title, app: p.appName, items: p.files.size, created_at: p.committedAt }));
      return [200, { packages }];
    });

    this.add('GET', '/api/apps', async (req) => {
      const d = this.device(req);
      const apps = [...this.apps.values()].filter((a) => a.device === d.id && !a.revoked).map((a) => ({ id: a.publicId, name: a.name, paired_at: a.pairedAt, last_seen_at: a.lastSeenAt }));
      return [200, { apps }];
    });

    this.add(
      'DELETE',
      '/api/apps/:id',
      async (req, { id }) => {
        const d = this.device(req);
        const a = [...this.apps.values()].find((x) => x.publicId === id && x.device === d.id && !x.revoked);
        if (!a) throw new Answer(404, 'Unknown app.');
        a.revoked = true;
        for (const p of [...this.packages.values()]) if (p.app === a.id && ['uploading', 'waiting', 'failed'].includes(p.status)) this.dropPackage(p.id);
        return [200, { ok: true }];
      },
      { id: PUBLIC_ID },
      'Unknown app.'
    );

    const openPackage = (req: http.IncomingMessage, id: string) => {
      const d = this.device(req);
      const p = this.packages.get(id);
      if (!p || p.device !== d.id || !['waiting', 'failed'].includes(p.status) || p.expiresAt <= Date.now()) throw new Answer(404, UNKNOWN_PACKAGE);
      return p;
    };

    this.add('GET', '/api/packages/:id/manifest', async (req, { id }) => [200, openPackage(req, id).manifest], PACKAGE, UNKNOWN_PACKAGE);

    this.add(
      'GET',
      '/api/packages/:id/files/:file',
      async (req, { id, file }) => {
        const p = openPackage(req, id);
        const f = p.files.get(file);
        if (!f || !f.data) throw new Answer(404, 'Unknown file.');
        return f.data;
      },
      { id: UUID, file: isValidFileName },
      'Unknown file.'
    );

    this.add(
      'POST',
      '/api/packages/:id/ack',
      async (req, { id }) => {
        const d = this.device(req);
        const body = await readJson(req);
        if (!['imported', 'partial', 'failed'].includes(String(body.status))) throw new Answer(400, 'The ack needs a status: imported, partial or failed.');
        if (body.items !== undefined && !Array.isArray(body.items)) throw new Answer(400, 'The items of the ack must be a list.');
        const p = this.packages.get(id);
        if (!p || p.device !== d.id || p.status === 'uploading' || p.status === 'deleted') throw new Answer(404, UNKNOWN_PACKAGE);
        const hasFiles = p.status === 'waiting' || p.status === 'failed';
        const items = ((body.items as unknown[]) || []).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(0, 64) as Record<string, unknown>[];
        const ack: Record<string, unknown> = { status: body.status, items: items.map((it) => Object.fromEntries(['id', 'name', 'status', 'error'].filter((k) => typeof it[k] === 'string').map((k) => [k, cleanText(it[k], 200)]))) };
        if (cleanText(body.error, 200)) ack.error = cleanText(body.error, 200);
        if (cleanText(body.note, 200)) ack.note = cleanText(body.note, 200);
        const now = iso(Date.now());
        if (body.status === 'failed') {
          if (hasFiles) Object.assign(p, { status: 'failed', ack, updatedAt: now });
        } else {
          let status = String(body.status) as Package['status'];
          const before = p.ack;
          if (ack.note === 'imported before' && before && (before.status === 'imported' || before.status === 'partial')) {
            if (!(ack.items as unknown[]).length) ack.items = before.items || [];
            if (before.status === 'partial') status = 'partial';
          }
          ack.status = status;
          Object.assign(p, { status, ack, updatedAt: now });
          for (const f of p.files.values()) f.data = null;
        }
        return [200, { ok: true }];
      },
      PACKAGE,
      UNKNOWN_PACKAGE
    );

    this.add('POST', '/api/unpair', async (req) => {
      const d = this.device(req);
      await readJson(req);
      d.revoked = true;
      for (const a of this.apps.values()) if (a.device === d.id) a.revoked = true;
      for (const p of [...this.packages.values()]) if (p.device === d.id && ['uploading', 'waiting', 'failed'].includes(p.status)) this.dropPackage(p.id);
      return [200, { ok: true }];
    });

    // The app side (docs/server-api.md, "App side").
    this.add('POST', '/api/pair/claim', async (req) => {
      const body = await readJson(req);
      const code = typeof body.code === 'string' ? body.code.toUpperCase().replace(/[\s-]/g, '') : '';
      const p = [...this.pairings.values()].reverse().find((x) => x.code === code && x.status === 'waiting' && x.expiresAt > Date.now());
      if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code) || !p) throw new Answer(404, WRONG_CODE);
      let device = p.device !== null ? this.devices.get(p.device) || null : null;
      if (device && device.revoked) device = null;
      if (device) device.name = p.deviceName;
      if (!device) {
        device = { id: this.nextId++, deviceId: p.deviceId, name: p.deviceName, token: 'la2ld_' + random(), revoked: false };
        this.devices.set(device.id, device);
      }
      const appId = cleanText(body.app_id, 100);
      if (appId) for (const a of this.apps.values()) if (a.device === device.id && a.appId === appId) a.revoked = true;
      const app: App = {
        id: this.nextId++,
        publicId: crypto.randomBytes(16).toString('hex'),
        device: device.id,
        name: cleanName(typeof body.app_name === 'string' ? body.app_name : '', 'App', 40),
        appId,
        token: 'la2la_' + random(),
        pairedAt: iso(Date.now()),
        lastSeenAt: null,
        revoked: false,
      };
      this.apps.set(app.id, app);
      Object.assign(p, { status: 'paired', device: device.id, deviceToken: device.token, appName: app.name });
      return [200, { app_token: app.token, device_name: device.name }];
    });

    this.add('GET', '/api/app/me', async (req) => {
      const a = this.app(req);
      return [200, { device_name: this.devices.get(a.device)!.name, app_name: a.name, paired_at: a.pairedAt }];
    });

    this.add('POST', '/api/app/unpair', async (req) => {
      const a = this.app(req);
      await readJson(req);
      a.revoked = true;
      return [200, { ok: true }];
    });

    this.add('POST', '/api/packages', async (req) => {
      const a = this.app(req);
      const raw = await readJson(req);
      const check = checkManifest(raw);
      if (!check.ok) throw new Answer(check.status || 422, check.error);
      const id = crypto.randomUUID();
      const now = Date.now();
      const manifest = Object.assign(raw, { package_id: id });
      const files = new Map<string, FileEntry>();
      for (const item of check.package.items) files.set(item.file, { bytes: item.bytes as number, sha256: item.sha256 as string, data: null });
      const p: Package = {
        id,
        device: a.device,
        app: a.id,
        title: check.package.title,
        appName: check.package.app,
        manifest,
        files,
        status: 'uploading',
        ack: null,
        createdAt: now,
        committedAt: null,
        expiresAt: now + PACKAGE_TTL_MS,
        updatedAt: iso(now),
      };
      this.packages.set(id, p);
      const upload: Record<string, string> = {};
      for (const file of files.keys()) upload[file] = `/packages/${id}/files/${encodeURIComponent(file)}`;
      return [201, { package_id: id, upload, expires_at: iso(p.expiresAt), warnings: check.warnings }];
    });

    const uploadingPackage = (a: App, id: string) => {
      const p = this.packages.get(id);
      if (!p || p.app !== a.id || p.status === 'deleted') throw new Answer(404, UNKNOWN_PACKAGE);
      if (p.status !== 'uploading') throw new Answer(404, 'This package is sent already.');
      if (this.statusOf(p) === 'expired') throw new Answer(404, 'The upload took too long. Send the package again.');
      return p;
    };

    this.add(
      'PUT',
      '/api/packages/:id/files/:file',
      async (req, { id, file }) => {
        const a = this.app(req);
        const p = uploadingPackage(a, id);
        const f = p.files.get(file);
        if (!f) throw new Answer(404, 'This file is not in the package.');
        const key = `${id}/${file}`;
        if (this.writing.has(key)) throw new Answer(409, 'This file is being sent already.');
        this.writing.add(key);
        try {
          const { data, tooLarge } = await readBody(req, f.bytes);
          if (tooLarge) throw new Answer(413, 'The file is larger than the package said.');
          if (this.storedBytes() + data.length > MAX_STORED) throw new Answer(507, 'The server is full. Try again later.');
          if (data.length !== f.bytes || sha(data) !== f.sha256) throw new Answer(422, 'The file arrived damaged. Send it again.');
          try {
            await checkWav(data);
          } catch (e) {
            throw new Answer(422, (e as Error).message);
          }
          uploadingPackage(a, id);
          f.data = data;
        } finally {
          this.writing.delete(key);
        }
        return [200, { ok: true, file, bytes: f.bytes }];
      },
      { id: UUID, file: isValidFileName },
      'This file is not in the package.'
    );

    this.add(
      'POST',
      '/api/packages/:id/commit',
      async (req, { id }) => {
        const a = this.app(req);
        await readJson(req);
        const p = this.packages.get(id);
        if (!p || p.app !== a.id || p.status === 'deleted') throw new Answer(404, UNKNOWN_PACKAGE);
        if (p.status !== 'uploading') return [200, { ok: true, status: this.statusOf(p) }];
        uploadingPackage(a, id);
        const missing = [...p.files.entries()].filter(([, f]) => !f.data).map(([name]) => name);
        if (missing.length) throw new Answer(409, `Not all files are there yet: ${missing.join(', ')}`);
        const now = iso(Date.now());
        Object.assign(p, { status: 'waiting', committedAt: now, updatedAt: now });
        return [200, { ok: true, status: 'waiting' }];
      },
      PACKAGE,
      UNKNOWN_PACKAGE
    );

    this.add(
      'GET',
      '/api/packages/:id/status',
      async (req, { id }) => {
        const a = this.app(req);
        const p = this.packages.get(id);
        if (!p || p.app !== a.id || p.status === 'deleted') throw new Answer(404, UNKNOWN_PACKAGE);
        const answer: Record<string, unknown> = { status: this.statusOf(p), items: p.ack ? p.ack.items : [], updated_at: p.updatedAt };
        if (p.ack && p.ack.error) answer.error = p.ack.error;
        return [200, answer];
      },
      PACKAGE,
      UNKNOWN_PACKAGE
    );

    this.add(
      'DELETE',
      '/api/packages/:id',
      async (req, { id }) => {
        const a = this.app(req);
        const p = this.packages.get(id);
        if (!p || p.app !== a.id) throw new Answer(404, UNKNOWN_PACKAGE);
        if (p.status === 'imported' || p.status === 'partial') throw new Answer(409, 'This package is already in Live.');
        if (p.status !== 'deleted') Object.assign(p, { status: 'deleted', updatedAt: iso(Date.now()) });
        for (const f of p.files.values()) f.data = null;
        return [200, { ok: true }];
      },
      PACKAGE,
      UNKNOWN_PACKAGE
    );
  }
}
