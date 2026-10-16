'use strict';
// HTTP and HTTPS with only Node's built-in modules (no npm packages: Freeze would not pack them).
// Every exchange has a timeout and a size limit, and every error has a message in plain words
// that fits in the status line of the device.

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');
const { VERSION } = require('./version');

class NetError extends Error {
  // kind: offline | timeout | network | tls | http | unauthorized | toolarge | badjson | redirect | checksum | address
  constructor(message, info = {}) {
    super(message);
    this.name = 'NetError';
    this.kind = info.kind || 'network';
    this.status = info.status || 0;
    this.code = info.code || '';
    this.url = info.url || '';
  }
}

const USER_AGENT = `LA2L/${VERSION} (Max for Live; ${process.platform})`;

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// A Node network error code in words.
function codeError(e, url) {
  const code = (e && e.code) || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new NetError('No internet, or the server name is wrong.', { kind: 'offline', code, url });
  }
  if (code === 'ECONNREFUSED') return new NetError('The server refused the connection.', { kind: 'offline', code, url });
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return new NetError('The server did not answer in time.', { kind: 'timeout', code, url });
  if (code === 'ECONNRESET' || code === 'EPIPE') return new NetError('The connection was broken off.', { kind: 'network', code, url });
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return new NetError('No internet connection.', { kind: 'offline', code, url });
  if (TLS_CODES.has(code)) return new NetError('The security certificate of the server is not valid.', { kind: 'tls', code, url });
  return new NetError(`Network error: ${(e && e.message) || code || 'unknown'}.`, { kind: 'network', code, url });
}

// An HTTP status in words. serverText is the server's own message, when it sent one.
function statusError(status, serverText, url) {
  const extra = serverText ? ` ${serverText}` : '';
  // Only 401 means the token is gone (see docs/server-api.md). A 403 can also come from a proxy or
  // firewall, and must not make the device forget its pairing.
  if (status === 401) return new NetError('This computer is no longer paired.', { kind: 'unauthorized', status, url });
  if (status === 403) return new NetError(`The server refused this (403).${extra}`, { kind: 'http', status, url });
  if (status === 404) return new NetError(`The server does not know this address (404).${extra}`, { kind: 'http', status, url });
  if (status === 410) return new NetError(`This is no longer on the server (410).${extra}`, { kind: 'http', status, url });
  if (status === 413) return new NetError(`Too large for the server (413).${extra}`, { kind: 'toolarge', status, url });
  if (status === 429) return new NetError('The server is busy. Wait a minute and try again.', { kind: 'http', status, url });
  if (status >= 500) return new NetError(`The server has a problem (${status}). Try again later.`, { kind: 'http', status, url });
  return new NetError(`The server answered ${status}.${extra}`, { kind: 'http', status, url });
}

function parseUrl(text) {
  let u;
  try {
    u = new URL(String(text));
  } catch (e) {
    throw new NetError(`Not a valid web address: ${text}`, { kind: 'address', url: String(text) });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new NetError(`Only http and https addresses work: ${text}`, { kind: 'address', url: String(text) });
  }
  return u;
}

const sameOrigin = (from, to) => from.origin === to.origin;
const anyWebAddress = () => true;

// One exchange, following redirects when allowRedirect(fromUrl, toUrl) says yes.
// With opts.toFile the body is streamed to that file (and hashed) instead of kept in memory.
// Resolves to { status, headers, url, body } or { status, headers, url, bytes, sha256 }.
function exchange(urlText, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    json,
    timeoutMs = 15000, // whole exchange
    idleMs = 15000, // no data for this long: give up
    maxBytes = 2 * 1048576,
    redirects = 3,
    allowRedirect = sameOrigin,
    toFile = null,
  } = opts;
  const url = parseUrl(urlText);
  const lib = url.protocol === 'https:' ? https : http;
  const body = json !== undefined ? Buffer.from(JSON.stringify(json)) : null;
  const reqHeaders = Object.assign({ 'User-Agent': USER_AGENT, Accept: '*/*' }, headers);
  if (body) {
    reqHeaders['Content-Type'] = 'application/json';
    reqHeaders['Content-Length'] = String(body.length);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let out = null;
    let outClosed = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      if (!err) return resolve(value);
      req.destroy();
      // Wait until the file is closed, so the caller can delete it (Windows refuses open files).
      if (out && !outClosed) {
        out.once('close', () => reject(err));
        out.destroy();
      } else {
        reject(err);
      }
    };
    const total = setTimeout(() => {
      finish(new NetError('The server did not answer in time.', { kind: 'timeout', url: url.href }));
    }, timeoutMs);

    const req = lib.request(url, { method, headers: reqHeaders }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return finish(new NetError('Too many redirects.', { kind: 'redirect', status, url: url.href }));
        let next;
        try {
          next = new URL(res.headers.location, url);
        } catch (e) {
          return finish(new NetError('The server sent a broken redirect.', { kind: 'redirect', status, url: url.href }));
        }
        if (!allowRedirect(url, next)) {
          return finish(new NetError(`The server sent us to another address (${next.host}).`, { kind: 'redirect', status, url: url.href }));
        }
        const keepMethod = status === 307 || status === 308;
        const nextOpts = Object.assign({}, opts, {
          redirects: redirects - 1,
          method: keepMethod ? method : 'GET',
          json: keepMethod ? json : undefined,
        });
        clearTimeout(total);
        settled = true;
        return exchange(next.href, nextOpts).then(resolve, reject);
      }

      const declared = Number(res.headers['content-length']);
      if (declared > maxBytes) {
        res.resume();
        return finish(new NetError(`The file is too large (${Math.round(declared / 1048576)} MB).`, { kind: 'toolarge', status, url: url.href }));
      }
      const ok = status >= 200 && status < 300;
      let received = 0;
      const chunks = [];
      const hash = crypto.createHash('sha256');
      if (toFile && ok) {
        out = fs.createWriteStream(toFile);
        out.on('close', () => { outClosed = true; });
        out.on('error', (e) => finish(new NetError(`Cannot write the file: ${e.message}`, { kind: 'network', code: e.code, url: url.href })));
      }
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          return finish(new NetError('The file is larger than the package said.', { kind: 'toolarge', status, url: url.href }));
        }
        if (out) {
          hash.update(chunk);
          out.write(chunk);
        } else if (chunks.length < 1e5) {
          chunks.push(chunk);
        }
      });
      res.on('error', (e) => finish(codeError(e, url.href)));
      res.on('close', () => {
        if (!res.complete) finish(new NetError('The connection was broken off.', { kind: 'network', url: url.href }));
      });
      res.on('end', () => {
        if (settled) return;
        if (out) {
          out.end(() => finish(null, { status, headers: res.headers, url: url.href, bytes: received, sha256: hash.digest('hex') }));
        } else {
          finish(null, { status, headers: res.headers, url: url.href, body: Buffer.concat(chunks) });
        }
      });
    });
    req.setTimeout(idleMs, () => finish(new NetError('The server did not answer in time.', { kind: 'timeout', url: url.href })));
    req.on('error', (e) => finish(codeError(e, url.href)));
    if (body) req.write(body);
    req.end();
  });
}

// The server's own error text from a JSON body like {"error": "..."}, cleaned and short.
function serverText(body) {
  try {
    const j = JSON.parse(body.toString('utf8'));
    const t = typeof j.error === 'string' ? j.error : typeof j.message === 'string' ? j.message : '';
    return t.replace(/[^\w .:'()-]/g, '').slice(0, 80);
  } catch (e) {
    return '';
  }
}

// JSON request. Resolves to the parsed JSON of a 2xx answer, rejects with a NetError otherwise.
async function requestJson(url, opts = {}) {
  const r = await exchange(url, Object.assign({ maxBytes: 1048576 }, opts, { headers: Object.assign({ Accept: 'application/json' }, opts.headers) }));
  if (r.status < 200 || r.status >= 300) throw statusError(r.status, serverText(r.body), r.url);
  if (r.status === 204 || r.body.length === 0) return {};
  try {
    return JSON.parse(r.body.toString('utf8'));
  } catch (e) {
    throw new NetError('The server sent an answer the device cannot read.', { kind: 'badjson', status: r.status, url: r.url });
  }
}

const RETRY_KINDS = new Set(['offline', 'timeout', 'network', 'checksum']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Download to `file`. The data goes to file.part first and is renamed only when it is complete
// and matches the expected size and sha256 (when given). Retries with 1, 2 and 4 seconds of waiting.
// Resolves to { bytes, sha256, url }.
async function download(url, file, opts = {}) {
  const { expectBytes = null, expectSha256 = null, retries = 3, retryDelayMs = 1000, onRetry = null } = opts;
  const part = file + '.part';
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      if (onRetry) onRetry(attempt, lastError);
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
    try {
      const r = await exchange(url, Object.assign({ timeoutMs: 10 * 60000, idleMs: 20000 }, opts, { toFile: part }));
      if (r.status < 200 || r.status >= 300) {
        throw statusError(r.status, '', r.url);
      }
      if (expectBytes !== null && r.bytes !== expectBytes) {
        throw new NetError(`The file arrived damaged (${r.bytes} instead of ${expectBytes} bytes).`, { kind: 'checksum', url: r.url });
      }
      if (expectSha256 && r.sha256 !== expectSha256) {
        throw new NetError('The file arrived damaged (checksum does not match).', { kind: 'checksum', url: r.url });
      }
      fs.renameSync(part, file);
      return { bytes: r.bytes, sha256: r.sha256, url: r.url };
    } catch (e) {
      try { fs.unlinkSync(part); } catch (e2) { /* no part file */ }
      lastError = e instanceof NetError ? e : codeError(e, url);
      if (!RETRY_KINDS.has(lastError.kind) && !(lastError.kind === 'http' && lastError.status >= 500)) break;
    }
  }
  throw lastError;
}

module.exports = { NetError, exchange, requestJson, download, sameOrigin, anyWebAddress, parseUrl, statusError, codeError, USER_AGENT };
