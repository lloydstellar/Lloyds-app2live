// The test receiver: a stand-in for LA2L in Ableton Live (sdk/BUILD-PROMPT.md, section 8). It
// uses only the device side of the API, as the device does: it shows a code, looks for packages
// every few seconds, downloads and checks every file with the device's own checks, works out what
// Live would do with each sound, and acks, so the app sees the same status as with Live. The page
// at /la2l/receiver, `npx @lloydstellar/la2l test-receiver` and startTestReceiver() all run this.

import { La2lError } from './errors.js';
import { checkManifest, LIMITS, type Kind } from './manifest.js';
import { checkWav } from './wav.js';
import { planSound, type SoundPlan } from './plan.js';
import { sha256 } from './sha256.js';
import { memoryStorage, type La2lStorage } from './storage.js';
import { serverAddress } from './http.js';

/** One sound of a package, as the test receiver saw it. */
export interface ReceivedSound {
  name: string;
  kind: Kind;
  /** What Live would do with it, when it could be placed. */
  plan?: SoundPlan;
  /** The WAV header, when it could be placed. */
  info?: { format: 'pcm' | 'float'; bits: number; channels: number; rate: number; duration: number; bytes: number };
  /** Why Live would skip it, in LA2L's words: "did not download: ...". */
  error?: string;
}

/** What the test receiver did with one package. */
export interface ReceiverReport {
  id: string;
  title: string;
  app: string;
  /** ISO time. */
  at: string;
  status: 'imported' | 'partial' | 'failed';
  /** How many sounds would be in Live. */
  placed: number;
  /** Why the package as a whole was refused. */
  error?: string;
  /** What LA2L takes but ignores. */
  warnings: string[];
  sounds: ReceivedSound[];
}

export interface TestReceiverOptions {
  /** The LA2L server. Default https://lloydstellar.nl/la2l/api. */
  server?: string;
  /** The name apps see: "Paired with Test receiver". */
  name?: string;
  /** Keeps the device id, the token and the packages it imported. Default: memory. */
  storage?: La2lStorage;
  fetch?: typeof fetch;
  /** How often it looks for packages. Default 3 seconds, as the page does. */
  pollMs?: number;
  /** How often it asks which apps are paired. Default 15 seconds; 0: never by itself. */
  appsMs?: number;
  /** A code for an app to type, and when it stops working (ms since 1970). */
  onCode?: (code: string, expiresAt: number) => void;
  /** An app typed the code. */
  onPaired?: (appName: string) => void;
  /** The names of the apps that can send now. */
  onApps?: (names: string[]) => void;
  /** A package was imported, or not. */
  onReport?: (report: ReceiverReport) => void;
  /** The code ran out or was cancelled before an app typed it. */
  onCodeEnded?: (why: 'expired' | 'cancelled') => void;
  /** The server no longer knows this receiver; a new code follows. */
  onLost?: () => void;
  onError?: (e: unknown) => void;
}

export class Unpaired extends Error {}

const ID = /^[A-Za-z0-9._-]{1,100}$/;
// The time limits of the device: 15 seconds for a JSON call, 10 minutes for a file.
const JSON_MS = 15000;
const FILE_MS = 600000;
// A package whose manifest did not come is looked at again after this long.
const LATER_MS = 30000;

const timeout = (ms: number) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The server's text from an error answer, cleaned as the device cleans it.
const serverText = (json: Record<string, unknown>) => String(json.error || json.message || '').replace(/[^\w .:'()-]/g, '').slice(0, 80);

/** An HTTP status in the device's words (src/node/http.js statusError). */
export function statusText(status: number, text: string): string {
  const extra = text ? ` ${text}` : '';
  if (status === 401) return 'This computer is no longer paired.';
  if (status === 403) return `The server refused this (403).${extra}`;
  if (status === 404) return `The server does not know this address (404).${extra}`;
  if (status === 410) return `This is no longer on the server (410).${extra}`;
  if (status === 413) return `Too large for the server (413).${extra}`;
  if (status === 429) return 'The server is busy. Wait a minute and try again.';
  if (status >= 500) return `The server has a problem (${status}). Try again later.`;
  return `The server answered ${status}.${extra}`;
}

// A network problem in the device's words: a time limit, or a connection that broke off.
const netError = (e: unknown) =>
  new Error(e && typeof e === 'object' && ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') ? 'The server did not answer in time.' : 'The connection was broken off.');

interface Pairing {
  pairId: string;
  expiresAt: number;
  pollMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class TestReceiver {
  readonly server: string;
  readonly name: string;
  private readonly storage: La2lStorage;
  private readonly fetchFn: typeof fetch;
  private readonly o: TestReceiverOptions;
  private pairing: Pairing | null = null;
  private asking: Promise<string | null> | null = null;
  private watching: { inbox: ReturnType<typeof setInterval>; apps?: ReturnType<typeof setInterval> } | null = null;
  private busy: Promise<void> | null = null;
  // Packages not to import now: package id -> until when. A package that failed stays in the inbox
  // until it expires; Live tries it again only when the user clicks Import, and the receiver only
  // after retry().
  private readonly later = new Map<string, number>();
  private closed = false;

  constructor(options: TestReceiverOptions = {}) {
    this.o = options;
    this.server = serverAddress(options.server);
    this.name = options.name || 'Test receiver';
    this.storage = options.storage || memoryStorage();
    this.fetchFn = typeof options.fetch === 'function' ? options.fetch : (...args: Parameters<typeof fetch>) => fetch(...args);
  }

  /** Whether the receiver has a token. */
  get paired(): boolean {
    return !!this.storage.get('token');
  }

  private deviceId(): string {
    let id = this.storage.get('deviceId');
    if (!id) {
      const c = (globalThis as { crypto?: Crypto }).crypto;
      id = c && c.randomUUID ? c.randomUUID() : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
      this.storage.set('deviceId', id);
    }
    return id;
  }

  // A JSON call. Resolves to { status, json }, status 0 when the server could not be reached. A
  // 401 on a call with the token means this receiver is no longer paired.
  private async api(method: string, path: string, body?: unknown, useToken = true): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    const token = useToken ? this.storage.get('token') : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r: Response;
    try {
      r = await this.fetchFn(this.server + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: timeout(JSON_MS) });
    } catch (e) {
      return { status: 0, json: {} };
    }
    let json: Record<string, unknown> = {};
    try {
      const v = await r.json();
      if (v && typeof v === 'object' && !Array.isArray(v)) json = v;
    } catch (e) {
      // not JSON
    }
    if (r.status === 401 && token) throw new Unpaired();
    return { status: r.status, json };
  }

  private error(e: unknown): void {
    if (e instanceof Unpaired) return this.lost();
    if (this.o.onError) this.o.onError(e);
  }

  /** Starts: watches for packages when it is paired, or asks for a code when it is not. */
  async start(): Promise<void> {
    if (!this.paired) {
      await this.pair();
      return;
    }
    try {
      await this.refreshApps();
      this.watch();
    } catch (e) {
      this.error(e);
    }
  }

  /**
   * A code for an app to type, and the wait for it. With the token, the new app joins this
   * receiver (Pair another app). One start at a time: a second one would make the server cancel
   * the code of the first. Resolves to the code, or null when there is none.
   */
  pair(): Promise<string | null> {
    if (!this.asking) this.asking = this.askCode().finally(() => (this.asking = null));
    return this.asking;
  }

  private async askCode(): Promise<string | null> {
    this.stopPairing();
    let r;
    try {
      r = await this.api('POST', '/pair/start', { device_id: this.deviceId(), device_name: this.name, client: 'LA2L test receiver', platform: 'web', test: true });
    } catch (e) {
      if (e instanceof Unpaired) {
        this.lost();
        return null;
      }
      throw e;
    }
    if (r.status !== 200 || typeof r.json.code !== 'string') {
      throw new Error(r.status === 0 ? 'The server does not answer. Try again later.' : statusText(r.status, serverText(r.json)));
    }
    const seconds = Math.min(1800, Math.max(30, Number(r.json.expires_in) || 600));
    const p: Pairing = { pairId: String(r.json.pair_id), expiresAt: Date.now() + seconds * 1000, pollMs: Math.min(10000, Math.max(500, Number(r.json.poll_ms) || 2000)) };
    this.pairing = p;
    if (this.o.onCode) this.o.onCode(r.json.code, p.expiresAt);
    p.timer = setTimeout(() => this.pollPairing(p).catch((e) => this.error(e)), p.pollMs);
    return r.json.code;
  }

  private stopPairing(): void {
    if (!this.pairing) return;
    clearTimeout(this.pairing.timer);
    this.pairing = null;
  }

  private async pollPairing(p: Pairing): Promise<void> {
    if (this.pairing !== p || this.closed) return;
    const r = await this.api('GET', '/pair/' + encodeURIComponent(p.pairId), undefined, false);
    if (this.pairing !== p) return;
    const status = r.status === 404 ? 'expired' : String(r.json.status);
    if (r.status === 200 && status === 'paired' && typeof r.json.device_token === 'string') {
      this.stopPairing();
      this.storage.set('token', r.json.device_token);
      if (this.o.onPaired) this.o.onPaired(String(r.json.app_name || 'an app'));
      await this.refreshApps();
      this.watch();
      return;
    }
    if (status === 'expired' || status === 'cancelled' || Date.now() > p.expiresAt) {
      this.stopPairing();
      if (this.o.onCodeEnded) this.o.onCodeEnded(status === 'cancelled' ? 'cancelled' : 'expired');
      return;
    }
    p.timer = setTimeout(() => this.pollPairing(p).catch((e) => this.error(e)), p.pollMs);
  }

  private watch(): void {
    if (this.watching || this.closed) return;
    const inbox = setInterval(() => this.look(), this.o.pollMs || 3000);
    const appsMs = this.o.appsMs === undefined ? 15000 : this.o.appsMs;
    const apps = appsMs > 0 ? setInterval(() => this.refreshApps().catch((e) => this.error(e)), appsMs) : undefined;
    this.watching = { inbox, apps };
    this.look();
  }

  private unwatch(): void {
    if (!this.watching) return;
    clearInterval(this.watching.inbox);
    if (this.watching.apps) clearInterval(this.watching.apps);
    this.watching = null;
  }

  /** The names of the apps that can send to this receiver now. */
  async refreshApps(): Promise<string[] | null> {
    const r = await this.api('GET', '/apps');
    if (r.status !== 200 || !Array.isArray(r.json.apps)) return null;
    const names = [...new Set(r.json.apps.map((a: { name?: unknown }) => String((a && a.name) || 'App')))];
    if (this.o.onApps) this.o.onApps(names);
    return names;
  }

  private lost(): void {
    this.unwatch();
    this.storage.remove('token');
    if (this.o.onLost) this.o.onLost();
    if (!this.closed) this.pair().catch((e) => this.error(e));
  }

  /** Unpairs: the apps can no longer send to this receiver. */
  async stop(): Promise<void> {
    try {
      await this.api('POST', '/unpair', {});
    } catch (e) {
      if (!(e instanceof Unpaired)) throw e;
    }
    this.unwatch();
    this.storage.remove('token');
  }

  /** Stops every timer. The pairing stays, for the next start(). */
  close(): void {
    this.closed = true;
    this.stopPairing();
    this.unwatch();
  }

  /** Tries a package that failed again, as clicking Import again in Live does. */
  retry(packageId: string): Promise<void> {
    this.later.delete(packageId);
    return this.look();
  }

  /** One look at the inbox, as Import in Live. Resolves when every package found is done. */
  look(): Promise<void> {
    if (!this.busy) {
      this.busy = this.lookOnce()
        .catch((e) => this.error(e))
        .finally(() => (this.busy = null));
    }
    return this.busy;
  }

  private async lookOnce(): Promise<void> {
    if (!this.paired || this.closed) return;
    const r = await this.api('GET', '/inbox');
    if (r.status !== 200) return;
    const list = (Array.isArray(r.json.packages) ? r.json.packages : [])
      .filter((p: { package_id?: unknown }) => p && typeof p.package_id === 'string' && ID.test(p.package_id))
      .filter((p: { package_id: string }) => !((this.later.get(p.package_id) ?? 0) > Date.now()))
      .sort((a: { created_at?: unknown }, b: { created_at?: unknown }) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    for (const entry of list) await this.importPackage(entry);
  }

  private importedList(): string[] {
    try {
      const v = JSON.parse(this.storage.get('imported') || '[]');
      return Array.isArray(v) ? v.map(String) : [];
    } catch (e) {
      return [];
    }
  }

  private async ack(id: string, body: unknown): Promise<boolean> {
    const r = await this.api('POST', `/packages/${encodeURIComponent(id)}/ack`, body);
    return r.status === 200;
  }

  private async importPackage(entry: { package_id: string; title?: unknown; app?: unknown }): Promise<void> {
    const id = entry.package_id;
    const done = this.importedList();
    if (done.includes(id)) {
      // In "Live" before, but that ack got lost: confirm again, place nothing.
      await this.ack(id, { status: 'imported', items: [], note: 'imported before' });
      return;
    }
    // As the device: when the manifest does not come, this package is left without an ack, and
    // looked at again a little later.
    const m = await this.api('GET', `/packages/${encodeURIComponent(id)}/manifest`);
    if (m.status !== 200) {
      this.later.set(id, Date.now() + LATER_MS);
      return;
    }
    const check = checkManifest(m.json, { as: 'device' });
    const report: ReceiverReport = {
      id,
      title: typeof entry.title === 'string' && entry.title ? entry.title : 'Package',
      app: typeof entry.app === 'string' ? entry.app : '',
      at: new Date().toISOString(),
      status: 'failed',
      placed: 0,
      warnings: check.warnings,
      sounds: [],
    };
    if (!check.ok) {
      report.error = check.error;
      this.later.set(id, Infinity);
      await this.ack(id, { status: 'failed', error: check.error, items: [] });
      if (this.o.onReport) this.o.onReport(report);
      return;
    }
    const pkg = check.package;
    report.title = pkg.title;
    report.app = pkg.app;
    const results: { id: string; name: string; status: 'imported' | 'failed'; error?: string }[] = [];
    for (const item of pkg.items) {
      const sound: ReceivedSound = { name: item.name, kind: item.kind };
      report.sounds.push(sound);
      if (item.error) {
        sound.error = item.error;
        results.push({ id: item.id, name: item.name, status: 'failed', error: item.error });
        continue;
      }
      try {
        const blob = await this.download(id, item);
        const info = await checkWav(blob);
        sound.plan = planSound(item, pkg, info.duration);
        sound.info = { format: info.format, bits: info.bitsPerSample, channels: info.channels, rate: info.sampleRate, duration: info.duration, bytes: info.fileBytes };
        results.push({ id: item.id, name: item.name, status: 'imported' });
      } catch (e) {
        if (e instanceof Unpaired) throw e;
        // As the device: a sound that does not download or is no usable WAV is skipped.
        sound.error = e instanceof La2lError && e.code === 'bad_wav' ? `is not a usable WAV: ${e.message}` : `did not download: ${(e as Error).message}`;
        results.push({ id: item.id, name: item.name, status: 'failed', error: sound.error });
      }
    }
    const placed = results.filter((x) => x.status === 'imported').length;
    report.status = placed === pkg.items.length ? 'imported' : placed > 0 ? 'partial' : 'failed';
    report.placed = placed;
    if (placed > 0) this.storage.set('imported', JSON.stringify([id, ...done].slice(0, 200)));
    if (report.status === 'failed') this.later.set(id, Infinity);
    await this.ack(id, { status: report.status, items: results });
    if (this.o.onReport) this.o.onReport(report);
  }

  // One file, with the device's checks and its 3 retries after 1, 2 and 4 seconds for a broken
  // connection, a time limit, a damaged file or a 5xx.
  private async download(packageId: string, item: { file: string; bytes: number | null; sha256: string | null }): Promise<Blob> {
    const url = `${this.server}/packages/${encodeURIComponent(packageId)}/files/${encodeURIComponent(item.file)}`;
    let last: Error | null = null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      let r: Response;
      let blob: Blob | null = null;
      try {
        r = await this.fetchFn(url, { headers: { Authorization: 'Bearer ' + this.storage.get('token') }, cache: 'no-store', signal: timeout(FILE_MS) });
        if (r.status === 200) blob = await r.blob(); // the body can break off too
      } catch (e) {
        last = netError(e);
        continue;
      }
      if (r.status === 401) throw new Unpaired();
      if (r.status !== 200 || !blob) {
        let json: Record<string, unknown> = {};
        try {
          json = await r.json();
        } catch (e) {
          // not JSON
        }
        last = new Error(statusText(r.status, serverText(json)));
        if (r.status >= 500) continue;
        throw last;
      }
      const max = item.bytes || LIMITS.maxPackageBytes;
      if (blob.size > max) throw new Error('The file is larger than the package said.');
      if (item.bytes !== null && blob.size !== item.bytes) {
        last = new Error(`The file arrived damaged (${blob.size} instead of ${item.bytes} bytes).`);
        continue;
      }
      if (item.sha256 && (await sha256(blob)) !== item.sha256) {
        last = new Error('The file arrived damaged (checksum does not match).');
        continue;
      }
      return blob;
    }
    throw last as Error;
  }
}
