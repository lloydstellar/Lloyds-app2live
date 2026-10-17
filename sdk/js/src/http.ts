// The calls to the LA2L server: JSON with a time limit and the X-LA2L-Client header, retries for a
// broken connection and a 5xx, a short wait after a 429, and uploads with progress.

import { La2lError } from './errors.js';

/** The LA2L server on lloydstellar.nl. */
export const DEFAULT_SERVER = 'https://lloydstellar.nl/la2l/api';

const JSON_MS = 30000;
// A 429 that asks for a short wait is waited out; a longer one becomes a rate_limited error.
const MAX_WAIT_S = 60;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** An answer of the server: the status, the JSON body ({} when there is none) and Retry-After. */
export interface Answer {
  status: number;
  json: Record<string, unknown>;
  retryAfter: number | null;
}

export interface CallOptions {
  method: string;
  /** After the server address, for example "/pair/claim". */
  path: string;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  /**
   * Try again after 1, 2 and 4 seconds when the connection breaks or the server answers 5xx.
   * '5xx': only after a 5xx, for a call that must not run twice when its answer got lost.
   */
  retry?: boolean | '5xx';
}

export interface UploadOptions {
  path: string;
  token: string;
  data: Blob;
  signal?: AbortSignal;
  onProgress?: (share: number) => void;
}

/** Waits `ms`, or rejects with `aborted` as soon as the signal says so. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal && signal.aborted) return reject(aborted());
    const stop = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', stop, { once: true });
  });

export const aborted = () => new La2lError('aborted', 'Stopped.');
const unreachable = () => new La2lError('network', 'The LA2L server could not be reached. Check the internet connection.');
const tooSlow = () => new La2lError('network', 'The LA2L server did not answer in time.');

/** The server's text from an error answer, or a line that says what happened. */
export function serverText(answer: Answer): string {
  const text = typeof answer.json.error === 'string' ? answer.json.error : '';
  return text || `The LA2L server answered ${answer.status}.`;
}

function retryAfterOf(value: string | null): number | null {
  const n = value === null ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * "https://x.nl/la2l/api/" or, in a browser, "../api" -> an absolute address without the last "/".
 * Plain http only for this computer, as the device allows it: the token must not travel in clear
 * text over a network.
 */
export function serverAddress(server: string | undefined): string {
  const text = (server || DEFAULT_SERVER).trim();
  let url: URL;
  try {
    const base = (globalThis as { document?: { baseURI?: string } }).document?.baseURI;
    url = base ? new URL(text, base) : new URL(text);
  } catch (e) {
    throw new TypeError(`Not a server address: ${text}`);
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) throw new TypeError(`Use https for ${text}: plain http works for localhost only.`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError(`Not a server address: ${text}`);
  return url.href.replace(/\/+$/, '');
}

/**
 * A value an HTTP header can carry: printable ASCII as it is, every other character
 * percent-encoded, so "Erik’s Beats" or "Битмейкер" never make a call fail.
 */
export function headerValue(text: string): string {
  return Array.from(text)
    .map((ch) => (/^[\x20-\x7e]$/.test(ch) ? ch : encodeURIComponent(ch)))
    .join('')
    .slice(0, 200);
}

export class Http {
  constructor(
    readonly server: string,
    private readonly client: string,
    private readonly fetchFn: typeof fetch,
    private readonly ownFetch: boolean
  ) {}

  private headers(token?: string | null, json?: boolean): Record<string, string> {
    const h: Record<string, string> = { 'X-LA2L-Client': this.client };
    if (token) h.Authorization = 'Bearer ' + token;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  // One exchange. A La2lError when no answer came.
  private async once(o: CallOptions): Promise<Answer> {
    const limit = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(JSON_MS) : undefined;
    const signal = o.signal && limit && AbortSignal.any ? AbortSignal.any([o.signal, limit]) : o.signal || limit;
    let r: Response;
    try {
      r = await this.fetchFn(this.server + o.path, {
        method: o.method,
        headers: this.headers(o.token, o.body !== undefined),
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        cache: 'no-store',
        signal,
      });
    } catch (e) {
      if (o.signal && o.signal.aborted) throw aborted();
      throw limit && limit.aborted ? tooSlow() : unreachable();
    }
    let json: Record<string, unknown> = {};
    try {
      const v = await r.json();
      if (v && typeof v === 'object' && !Array.isArray(v)) json = v;
    } catch (e) {
      // no JSON body
    }
    return { status: r.status, json, retryAfter: retryAfterOf(r.headers.get('Retry-After')) };
  }

  /** A JSON call. Resolves to the answer, whatever its status; rejects only when none came. */
  async call(o: CallOptions): Promise<Answer> {
    let waits = 0;
    for (let attempt = 0; ; attempt++) {
      let answer: Answer | null = null;
      let failure: La2lError | null = null;
      try {
        answer = await this.once(o);
      } catch (e) {
        if (!(e instanceof La2lError) || e.code === 'aborted') throw e;
        failure = e;
      }
      if (answer && answer.status === 429 && answer.retryAfter !== null && answer.retryAfter <= MAX_WAIT_S && waits < 2) {
        waits++;
        await sleep(answer.retryAfter * 1000, o.signal);
        attempt--;
        continue;
      }
      const broken = !!failure && o.retry === true;
      const again = !!o.retry && attempt < RETRY_DELAYS_MS.length && (broken || (!!answer && answer.status >= 500));
      if (!again) {
        if (failure) throw failure;
        return answer as Answer;
      }
      await sleep(RETRY_DELAYS_MS[attempt], o.signal);
    }
  }

  /**
   * One file to the server. In a browser through XMLHttpRequest, which can tell the progress of
   * an upload; elsewhere through fetch. Resolves to the answer; rejects when none came.
   */
  upload(o: UploadOptions): Promise<Answer> {
    if (!this.ownFetch && typeof XMLHttpRequest === 'function') return this.uploadXhr(o);
    return this.uploadFetch(o);
  }

  private async uploadFetch(o: UploadOptions): Promise<Answer> {
    let r: Response;
    try {
      r = await this.fetchFn(this.server + o.path, {
        method: 'PUT',
        headers: Object.assign(this.headers(o.token), { 'Content-Type': 'audio/wav' }),
        body: o.data,
        signal: o.signal,
      });
    } catch (e) {
      throw o.signal && o.signal.aborted ? aborted() : new La2lError('network', 'The upload broke off. Check the internet connection.');
    }
    let json: Record<string, unknown> = {};
    try {
      const v = await r.json();
      if (v && typeof v === 'object' && !Array.isArray(v)) json = v;
    } catch (e) {
      // no JSON body
    }
    if (o.onProgress) o.onProgress(1);
    return { status: r.status, json, retryAfter: retryAfterOf(r.headers.get('Retry-After')) };
  }

  private uploadXhr(o: UploadOptions): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', this.server + o.path);
      for (const [name, value] of Object.entries(Object.assign(this.headers(o.token), { 'Content-Type': 'audio/wav' }))) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && o.onProgress) o.onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let json: Record<string, unknown> = {};
        try {
          const v = JSON.parse(xhr.responseText);
          if (v && typeof v === 'object' && !Array.isArray(v)) json = v;
        } catch (e) {
          // no JSON body
        }
        resolve({ status: xhr.status, json, retryAfter: retryAfterOf(xhr.getResponseHeader('Retry-After')) });
      };
      xhr.onerror = () => reject(new La2lError('network', 'The upload broke off. Check the internet connection.'));
      xhr.onabort = () => reject(aborted());
      if (o.signal) {
        if (o.signal.aborted) return reject(aborted());
        o.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(o.data);
    });
  }
}
