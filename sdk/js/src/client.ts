// The client: pair once with the code LA2L shows in Live, then send sounds and follow them until
// they are in Live. docs/server-api.md, app side, is what it speaks.

import { La2lError } from './errors.js';
import { Http, serverAddress, serverText, aborted, headerValue, sleep, type Answer } from './http.js';
import { defaultStorage, type La2lStorage } from './storage.js';
import { checkManifest, LIMITS, SCHEMA, type Kind, type Role } from './manifest.js';
import { checkWav, type BinarySource } from './wav.js';
import { sha256 } from './sha256.js';
import { megabytes } from './text.js';
import { VERSION } from './version.js';

export interface La2lOptions {
  /** The name LA2L shows in Live: "Paired with Web808", and in every track name: "Kick (Web808)". */
  appName: string;
  /** This installation's own id. Default: a UUID made once and kept in `storage`. */
  appId?: string;
  /** The version of the app, for the manifest. */
  appVersion?: string;
  /** The LA2L server. Default https://lloydstellar.nl/la2l/api; the local test receiver prints its own. */
  server?: string;
  /** Where the token is kept. Default: localStorage in a browser, a file in Node.js. */
  storage?: La2lStorage;
  /** A fetch of your own, for example for tests. */
  fetch?: typeof fetch;
}

/** One sound to send. */
export interface SoundInput {
  /** A WAV file: a Blob or File, or its bytes. `toWav` and `wavFromAudioBuffer` make one. */
  audio: BinarySource;
  /** The track name in Live, at most 40 characters. Default: the file name, or "Sound 1". */
  name?: string;
  /** `loop`: warped to the tempo and looped. `oneshot`: plays as it is. Required. */
  kind: Kind;
  /** Picks the warp mode of a loop: drums Beats, bass Tones, melodic and vocal Complex Pro, texture Texture, fx Complex. */
  role?: Role;
  /** The tempo of this loop, when it differs from the package's. */
  bpm?: number;
  /** The loop length in beats. Default: worked out from the length and the tempo. */
  lengthBeats?: number;
  /** Overrides the warp mode the role gives: beats, tones, texture, repitch, complex, complex_pro. */
  warpMode?: string | number;
  /** "#RRGGBB". */
  color?: string;
  gainDb?: number;
  /** Your own id for this sound, sent back in the result. */
  id?: string;
  /** The file name on the server. Default: made from the File's name or the sound's name. */
  file?: string;
  /** The SHA-256 of the file in hex, when you know it already, so a large file is not hashed again. */
  sha256?: string;
}

export interface Progress {
  /** checking: the files are read and hashed. uploading: a file goes to the server. */
  stage: 'checking' | 'uploading';
  /** The position of the sound being uploaded, from 0. */
  sound: number;
  /** How much of that sound is uploaded, from 0 to 1. */
  soundShare: number;
}

export interface SendOptions {
  /** The scene name in Session View and the folder name on disk. */
  title?: string;
  /** The tempo of every loop that has no bpm of its own. */
  bpm?: number;
  timeSignature?: [number, number];
  sounds: SoundInput[];
  /** Called with the share of all bytes uploaded, from 0 to 1. */
  onProgress?: (share: number, progress: Progress) => void;
  signal?: AbortSignal;
}

/** What happened to one sound in Live. */
export interface SoundResult {
  id: string;
  name: string;
  status: 'imported' | 'failed';
  /** Why it is not in Live, in LA2L's words. */
  error?: string;
}

export interface DeliveryStatus {
  /** waiting: until Import in Live. imported: every sound is in Live. partial: some are. */
  status: 'uploading' | 'waiting' | 'imported' | 'partial' | 'failed' | 'expired';
  sounds: SoundResult[];
  /** Why the package as a whole failed, when LA2L said so. */
  error?: string;
  updatedAt: string | null;
}

const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const STATUSES = ['uploading', 'waiting', 'imported', 'partial', 'failed', 'expired'];
// A package does not need a package_id: the server gives it one. This placeholder lets the
// manifest check run before the real checksums are known.
const NO_CHECKSUM = '0'.repeat(64);

function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const sizeOf = (a: BinarySource) => (typeof Blob !== 'undefined' && a instanceof Blob ? a.size : (a as ArrayBuffer | ArrayBufferView).byteLength);
const asBlob = (a: BinarySource) => (typeof Blob !== 'undefined' && a instanceof Blob ? a : new Blob([a as BlobPart]));

// A file name the server takes: letters, digits, space, "." "_" "-", ending in .wav, unique.
function fileName(wanted: string, index: number, taken: Set<string>): string {
  let base = wanted
    .replace(/\.wav$/i, '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 90)
    .replace(/[ ._-]+$/, '');
  if (!base) base = `sound ${index + 1}`;
  let file = base + '.wav';
  for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${base}-${n}.wav`;
  taken.add(file.toLowerCase());
  return file;
}

/** The client for one app. */
export class LA2L {
  readonly appName: string;
  readonly appId: string;
  readonly server: string;
  private readonly appVersion: string;
  private readonly storage: La2lStorage;
  /** @internal */
  readonly http: Http;

  constructor(options: La2lOptions) {
    if (!options || typeof options.appName !== 'string' || !options.appName.trim()) {
      throw new TypeError('LA2L needs an appName: the name LA2L shows in Live, "Paired with <appName>".');
    }
    this.appName = options.appName.trim();
    this.appVersion = typeof options.appVersion === 'string' ? options.appVersion : '';
    this.server = serverAddress(options.server);
    this.storage = options.storage || defaultStorage(options.appId || this.appName);
    let appId = options.appId || this.storage.get('appId');
    if (!appId) {
      appId = newId();
      this.storage.set('appId', appId);
    }
    this.appId = appId;
    const ownFetch = typeof options.fetch === 'function';
    const fetchFn = ownFetch ? (options.fetch as typeof fetch) : (...args: Parameters<typeof fetch>) => fetch(...args);
    this.http = new Http(this.server, `la2l-js/${VERSION} (${headerValue(this.appName.slice(0, 60))})`, fetchFn, ownFetch);
  }

  /** Whether this app has a token. A token can still turn out to be revoked: then a call gives not_paired. */
  get paired(): boolean {
    return !!this.storage.get('token');
  }

  /** The name of the computer this app is paired with, as the server last said it. */
  get deviceName(): string | null {
    return this.paired ? this.storage.get('deviceName') : null;
  }

  /**
   * Forgets the pairing here only. The server keeps the token until LA2L in Live unpairs, but
   * nobody has it any more. unpair() also tells the server.
   */
  forget(): void {
    this.storage.remove('token');
    this.storage.remove('deviceName');
  }

  /** @internal The token, or a not_paired error. */
  token(): string {
    const token = this.storage.get('token');
    if (!token) throw new La2lError('not_paired', 'This app is not paired. Type the code LA2L shows in Live.');
    return token;
  }

  /** @internal Turns an error answer into a La2lError. */
  fail(answer: Answer, codeFor4xx: 'bad_package' | 'server' = 'server'): La2lError {
    const message = serverText(answer);
    const status = answer.status;
    if (status === 401) {
      this.forget();
      return new La2lError('not_paired', message, { status });
    }
    if (status === 429) return new La2lError('rate_limited', message, { status, retryAfter: answer.retryAfter });
    if (status === 507) return new La2lError('server_full', message, { status });
    if (status >= 500) return new La2lError('server', message, { status });
    return new La2lError(codeFor4xx, message, { status });
  }

  /**
   * Pairs this app with the computer that shows the code. In Live the user clicks Pair app in LA2L
   * (or Settings > Add app) and reads a code like "K7P 42Q"; case, spaces and dashes do not matter.
   */
  async pair(code: string): Promise<{ deviceName: string }> {
    const typed = typeof code === 'string' ? code.toUpperCase().replace(/[\s-]/g, '') : '';
    if (!CODE.test(typed)) throw new La2lError('bad_code', 'A code has 6 letters and digits, like K7P 42Q.');
    const answer = await this.http.call({ method: 'POST', path: '/pair/claim', body: { code: typed, app_name: this.appName, app_id: this.appId } });
    if (answer.status === 404) throw new La2lError('bad_code', serverText(answer), { status: 404 });
    if (answer.status !== 200 || typeof answer.json.app_token !== 'string') throw this.fail(answer);
    const deviceName = typeof answer.json.device_name === 'string' ? answer.json.device_name : 'your computer';
    this.storage.set('token', answer.json.app_token);
    this.storage.set('deviceName', deviceName);
    return { deviceName };
  }

  /** Which computer this app is paired with. Ask it now and then; not_paired means: pair again. */
  async me(): Promise<{ deviceName: string; appName: string; pairedAt: string }> {
    const answer = await this.http.call({ method: 'GET', path: '/app/me', token: this.token(), retry: true });
    if (answer.status !== 200) throw this.fail(answer);
    const deviceName = String(answer.json.device_name || '');
    this.storage.set('deviceName', deviceName);
    return { deviceName, appName: String(answer.json.app_name || ''), pairedAt: String(answer.json.paired_at || '') };
  }

  /**
   * Unpairs this app: the server revokes the token, and it is forgotten here. When the server
   * cannot be reached, this rejects with `network` and keeps the token, so the app can try again,
   * or call forget().
   */
  async unpair(): Promise<void> {
    const token = this.storage.get('token');
    if (!token) return;
    const answer = await this.http.call({ method: 'POST', path: '/app/unpair', body: {}, token, retry: true });
    if (answer.status !== 200 && answer.status !== 401) throw this.fail(answer);
    this.forget();
  }

  /**
   * Sends sounds to LA2L. Everything is checked before the first byte goes out, with the texts the
   * server and LA2L use. Then it announces the package, uploads the files one by one and commits.
   * Resolves to a Delivery, which follows the package until it is in Live.
   */
  async send(options: SendOptions): Promise<Delivery> {
    const token = this.token();
    const sounds = options && Array.isArray(options.sounds) ? options.sounds : [];
    if (!sounds.length) throw new La2lError('bad_package', 'The package has no sounds.');
    if (sounds.length > LIMITS.maxItems) throw new La2lError('bad_package', `The package has ${sounds.length} sounds. LA2L takes ${LIMITS.maxItems} at most. Send them in more packages.`);
    const progress = options.onProgress || (() => {});
    const signal = options.signal;

    // 1. The files: WAV files Live can use, of at most 200 MB together.
    const taken = new Set<string>();
    const items: Record<string, unknown>[] = [];
    let total = 0;
    for (const [i, s] of sounds.entries()) {
      if (!s || !s.audio) throw new La2lError('bad_package', `Sound ${i + 1} has no audio.`);
      const fromFile = typeof File !== 'undefined' && s.audio instanceof File ? s.audio.name : '';
      const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : fromFile.replace(/\.[^.]*$/, '') || `Sound ${i + 1}`;
      if (s.kind !== 'loop' && s.kind !== 'oneshot') throw new La2lError('bad_package', `${name}: kind must be "loop" or "oneshot".`);
      try {
        await checkWav(s.audio);
      } catch (e) {
        if (e instanceof La2lError) throw new La2lError('bad_wav', `${name} is not a usable WAV: ${e.message}`);
        throw e;
      }
      const file = s.file !== undefined ? s.file : fileName(fromFile || name, i, taken);
      if (s.file !== undefined) taken.add(String(s.file).toLowerCase());
      const bytes = sizeOf(s.audio);
      total += bytes;
      const item: Record<string, unknown> = { id: s.id || `sound-${i + 1}`, file, bytes, sha256: s.sha256 || NO_CHECKSUM, name, kind: s.kind };
      if (s.role !== undefined) item.role = s.role;
      if (s.bpm !== undefined) item.bpm = s.bpm;
      if (s.lengthBeats !== undefined) item.length_beats = s.lengthBeats;
      if (s.warpMode !== undefined) item.warp_mode = s.warpMode;
      if (s.color !== undefined) item.color = s.color;
      if (s.gainDb !== undefined) item.gain_db = s.gainDb;
      items.push(item);
    }
    if (total > LIMITS.maxPackageBytes) {
      throw new La2lError('bad_package', `The package is ${megabytes(total)}. LA2L takes ${megabytes(LIMITS.maxPackageBytes)} at most. Send the sounds in more packages.`);
    }

    // 2. The manifest, as strict as the server.
    const manifest: Record<string, unknown> = { schema: SCHEMA, created_at: new Date().toISOString(), source: { app: this.appName, app_version: this.appVersion, platform: platform() }, items };
    if (options.title !== undefined) manifest.title = options.title;
    const tempo: Record<string, unknown> = {};
    if (options.bpm !== undefined) tempo.bpm = options.bpm;
    if (options.timeSignature !== undefined) tempo.time_signature = options.timeSignature;
    if (Object.keys(tempo).length) manifest.tempo = tempo;
    const check = checkManifest(manifest);
    if (!check.ok) throw new La2lError('bad_package', check.error);

    // 3. The checksums, unless the app gave them.
    for (const [i, s] of sounds.entries()) {
      if (signal && signal.aborted) throw aborted();
      progress(0, { stage: 'checking', sound: i, soundShare: 0 });
      if (!s.sha256) items[i].sha256 = await sha256(s.audio);
    }

    // 4. Announce, upload, commit.
    // Not tried again when the connection breaks: the package may exist already.
    const created = await this.http.call({ method: 'POST', path: '/packages', body: manifest, token, signal, retry: '5xx' });
    if (created.status !== 201 || typeof created.json.package_id !== 'string') throw this.fail(created, 'bad_package');
    const packageId = created.json.package_id;
    const upload = (created.json.upload || {}) as Record<string, string>;
    let sent = 0;
    try {
      for (const [i, s] of sounds.entries()) {
        const bytes = sizeOf(s.audio);
        const share = (part: number) => {
          progress(total ? (sent + part * bytes) / total : 1, { stage: 'uploading', sound: i, soundShare: part });
        };
        await this.uploadFile(upload[items[i].file as string] || `/packages/${packageId}/files/${encodeURIComponent(items[i].file as string)}`, asBlob(s.audio), token, share, signal);
        sent += bytes;
      }
      const commit = await this.http.call({ method: 'POST', path: `/packages/${packageId}/commit`, body: {}, token, signal, retry: true });
      if (commit.status !== 200) throw this.fail(commit, 'bad_package');
    } catch (e) {
      // The rest would only wait for an hour on the server.
      if (!(e instanceof La2lError && e.code === 'not_paired')) this.http.call({ method: 'DELETE', path: `/packages/${packageId}`, token }).catch(() => {});
      throw e;
    }
    progress(1, { stage: 'uploading', sound: sounds.length - 1, soundShare: 1 });
    const warnings = Array.isArray(created.json.warnings) ? created.json.warnings.map(String) : [];
    return new Delivery(this, packageId, warnings, typeof created.json.expires_at === 'string' ? created.json.expires_at : null);
  }

  // One file, started again when the connection breaks or the server answers 5xx: the server
  // cannot resume an upload. After a connection broke without a word (a phone that switches from
  // Wi-Fi to 4G), the server still holds the first upload until it gives up on it, after about a
  // minute; until then it answers 409. Those are waited out too.
  private async uploadFile(path: string, data: Blob, token: string, share: (part: number) => void, signal?: AbortSignal): Promise<void> {
    const delays = [1000, 2000, 4000];
    const busyDelays = [5000, 10000, 20000, 40000];
    let tries = 0;
    let busyTries = 0;
    for (;;) {
      share(0);
      let answer: Answer | null = null;
      let failure: La2lError | null = null;
      try {
        answer = await this.http.upload({ path, token, data, signal, onProgress: share });
      } catch (e) {
        if (!(e instanceof La2lError) || e.code === 'aborted') throw e;
        failure = e;
      }
      if (answer && answer.status === 200) return;
      // "The file arrived damaged" is worth one more try too.
      const damaged = !!answer && answer.status === 422 && /arrived damaged/.test(String(answer.json.error));
      const busy = !!answer && answer.status === 409;
      if (busy && busyTries < busyDelays.length) {
        await sleep(busyDelays[busyTries++], signal);
        continue;
      }
      if ((failure || (answer && answer.status >= 500) || damaged) && tries < delays.length) {
        await sleep(delays[tries++], signal);
        continue;
      }
      if (failure) throw failure;
      const a = answer as Answer;
      if (busy || damaged) throw new La2lError('network', serverText(a), { status: a.status });
      if (a.status === 422) throw new La2lError('bad_wav', serverText(a), { status: 422 });
      if (a.status === 404) throw new La2lError('expired', serverText(a), { status: 404 });
      throw this.fail(a, 'bad_package');
    }
  }

  /** Follows a package that was sent earlier, for example after the page was reloaded. */
  delivery(packageId: string): Delivery {
    return new Delivery(this, packageId, [], null);
  }
}

function platform(): string {
  const g = globalThis as { document?: unknown; process?: { versions?: { node?: string } }; Deno?: unknown; Bun?: unknown };
  if (g.document) return 'web';
  if (g.Deno) return 'deno';
  if (g.Bun) return 'bun';
  if (g.process && g.process.versions && g.process.versions.node) return 'node';
  return 'js';
}

/** A package that was sent: its status, until it is in Live. */
export class Delivery {
  constructor(
    private readonly la2l: LA2L,
    /** The id the server gave the package. */
    readonly packageId: string,
    /** What LA2L takes but ignores, for example `Kick: role "drum" unknown`. */
    readonly warnings: string[],
    /** When the server deletes the package, imported or not. */
    readonly expiresAt: string | null
  ) {}

  /** Where the package is now. A package the server no longer knows counts as expired. */
  async status(): Promise<DeliveryStatus> {
    const answer = await this.la2l.http.call({ method: 'GET', path: `/packages/${encodeURIComponent(this.packageId)}/status`, token: this.la2l.token(), retry: true });
    if (answer.status === 404) return { status: 'expired', sounds: [], updatedAt: null };
    if (answer.status !== 200) throw this.la2l.fail(answer);
    const j = answer.json;
    const status = STATUSES.includes(String(j.status)) ? (j.status as DeliveryStatus['status']) : 'waiting';
    const sounds = (Array.isArray(j.items) ? j.items : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => {
        const r: SoundResult = { id: String(x.id ?? ''), name: String(x.name ?? ''), status: x.status === 'imported' ? 'imported' : 'failed' };
        if (typeof x.error === 'string') r.error = x.error;
        return r;
      });
    const result: DeliveryStatus = { status, sounds, updatedAt: typeof j.updated_at === 'string' ? j.updated_at : null };
    if (typeof j.error === 'string') result.error = j.error;
    return result;
  }

  /**
   * Waits until the user clicks Import in Live. Resolves when the sounds are in Live (`imported`,
   * or `partial` with the result per sound); rejects with import_failed or expired.
   */
  async imported(options: { intervalMs?: number; signal?: AbortSignal } = {}): Promise<DeliveryStatus> {
    const every = Math.max(1000, options.intervalMs || 3000);
    for (;;) {
      if (options.signal && options.signal.aborted) throw aborted();
      let st: DeliveryStatus | null = null;
      try {
        st = await this.status();
      } catch (e) {
        // A short trouble with the network (a laptop that wakes up): keep asking.
        if (!(e instanceof La2lError && e.code === 'network')) throw e;
      }
      if (st && (st.status === 'imported' || st.status === 'partial')) return st;
      if (st && st.status === 'expired') throw new La2lError('expired', 'The package expired before it was imported in Live.');
      if (st && st.status === 'failed') {
        const first = st.sounds.find((x) => x.status === 'failed');
        const why = st.error || (first ? `${first.name} ${first.error || 'was not imported'}` : 'LA2L could not import it.');
        throw new La2lError('import_failed', `Live could not import it. ${why}`.trim());
      }
      await sleep(every, options.signal);
    }
  }

  /** Takes the package back, until it is in Live. */
  async cancel(): Promise<void> {
    const answer = await this.la2l.http.call({ method: 'DELETE', path: `/packages/${encodeURIComponent(this.packageId)}`, token: this.la2l.token(), retry: true });
    if (answer.status === 200) return;
    if (answer.status === 409) throw new La2lError('server', serverText(answer), { status: 409 });
    if (answer.status === 404) throw new La2lError('expired', serverText(answer), { status: 404 });
    throw this.la2l.fail(answer);
  }
}
