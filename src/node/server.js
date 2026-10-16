'use strict';
// The App2Live server, as the device sees it. The full contract is in docs/server-api.md.
// The device only ever talks to the one server in its settings, over https.

const { URL } = require('url');
const { requestJson, download, NetError } = require('./http');

// The server address from the settings. Only https, except localhost (for tests and self-hosting on one computer).
function checkServerUrl(text) {
  let u;
  try {
    u = new URL(String(text || '').trim());
  } catch (e) {
    throw new NetError('The server address in the settings is not valid.', { kind: 'address' });
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new NetError('The server address must start with https://', { kind: 'address' });
  }
  return u.href.replace(/\/+$/, '');
}

class Server {
  // getToken() returns the device token, or null when this computer is not paired.
  constructor(baseUrl, getToken, opts = {}) {
    this.base = checkServerUrl(baseUrl);
    this.getToken = getToken || (() => null);
    this.timeoutMs = opts.timeoutMs || 15000;
  }

  url(p) {
    return this.base + p;
  }

  auth() {
    const token = this.getToken();
    if (!token) throw new NetError('This computer is not paired yet.', { kind: 'unauthorized' });
    return { Authorization: 'Bearer ' + token };
  }

  call(method, p, opts = {}) {
    const headers = opts.auth === false ? {} : opts.auth === 'optional' ? this.optionalAuth() : this.auth();
    return requestJson(this.url(p), { method, headers, json: opts.json, timeoutMs: opts.timeoutMs || this.timeoutMs });
  }

  optionalAuth() {
    const token = this.getToken();
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  health() {
    return this.call('GET', '/health', { auth: false, timeoutMs: 8000 });
  }

  // Asks for a pairing code. When this computer is already paired, the token goes along,
  // so the new app is added to the same computer.
  pairStart(info) {
    return this.call('POST', '/pair/start', { auth: 'optional', json: info });
  }

  pairStatus(pairId) {
    return this.call('GET', '/pair/' + encodeURIComponent(pairId), { auth: false, timeoutMs: 10000 });
  }

  pairCancel(pairId) {
    return this.call('POST', '/pair/' + encodeURIComponent(pairId) + '/cancel', { auth: false, timeoutMs: 5000 });
  }

  inbox() {
    return this.call('GET', '/inbox');
  }

  manifest(packageId) {
    return this.call('GET', '/packages/' + encodeURIComponent(packageId) + '/manifest');
  }

  // Downloads one file of a package. Redirects are only followed within the same server.
  downloadFile(packageId, file, target, opts = {}) {
    const url = this.url('/packages/' + encodeURIComponent(packageId) + '/files/' + encodeURIComponent(file));
    return download(url, target, Object.assign({ headers: this.auth() }, opts));
  }

  ack(packageId, body) {
    return this.call('POST', '/packages/' + encodeURIComponent(packageId) + '/ack', { json: body });
  }

  unpair() {
    return this.call('POST', '/unpair', { json: {}, timeoutMs: 8000 });
  }
}

// The list of waiting packages from GET /inbox, checked and sorted oldest first.
function readInbox(answer) {
  const list = answer && Array.isArray(answer.packages) ? answer.packages : [];
  return list
    .filter((p) => p && typeof p.package_id === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(p.package_id))
    .map((p) => ({
      id: p.package_id,
      title: typeof p.title === 'string' ? p.title : '',
      app: typeof p.app === 'string' ? p.app : '',
      items: Number.isInteger(p.items) ? p.items : null,
      createdAt: typeof p.created_at === 'string' ? p.created_at : '',
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

module.exports = { Server, checkServerUrl, readInbox };
