'use strict';
// Small HTTP helpers: JSON answers with exact headers, JSON request bodies with a size limit,
// errors as {"error": "..."}, the CORS headers of the API, the client address and the log line.

const MAX_JSON_BYTES = 1048576;

// An answer with this status and {"error": message}. Thrown by handlers, sent by main.js.
class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

// Browser apps call the API from other sites. The API uses bearer tokens, never cookies, so any
// origin may call it.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Length',
};

const PREFLIGHT = {
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
};

// A JSON answer with an exact Content-Length, never cached.
function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(
    status,
    Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' }, headers)
  );
  res.end(data);
}

// Error texts are shown to people (the device shows them after its own message): plain, short,
// at most 80 characters, cut at a space when that keeps most of the text.
function errorText(message) {
  const t = String(message || '').replace(/\s+/g, ' ').trim() || 'Something went wrong.';
  if (t.length <= 80) return t;
  const cut = t.slice(0, 80);
  const space = cut.lastIndexOf(' ');
  return (space >= 60 ? cut.slice(0, space) : cut).trim();
}

function sendError(res, status, message, headers = {}) {
  sendJson(res, status, { error: errorText(message) }, headers);
}

const isJson = (type) => /^application\/json\s*(;.*)?$/i.test(String(type || '').trim());

// The JSON body of a request: {} when it is empty. Larger than 1 MB: 413; another Content-Type:
// 415; not valid JSON: 400. A body that is too large is still read to its end (and thrown away)
// while the 413 goes out, so the client gets the answer instead of a broken connection.
function readJson(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, 'The request is larger than 1 MB.', { Connection: 'close' });
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      req.bytesIn = size;
      if (err) reject(err);
      else resolve(value);
    };
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      finish(tooLarge());
      return;
    }
    req.on('data', (chunk) => {
      size += chunk.length;
      if (done) return;
      if (size > limit) {
        chunks.length = 0;
        finish(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return finish(null, {});
      if (!isJson(req.headers['content-type'])) return finish(new HttpError(415, 'Send JSON with Content-Type: application/json.'));
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        finish(new HttpError(400, 'The request is not valid JSON.'));
      }
    });
    req.on('error', (e) => finish(e));
    req.on('close', () => finish(new Error('The client went away during the request.')));
  });
}

// The path of the request exactly as sent, without the query. Routes match this raw path, so
// "/api/../x" or "%2F" never turn into another route.
function rawPath(url) {
  const p = String(url || '/').split('?')[0];
  return p.startsWith('/') ? p : '/' + p;
}

// The client's address. Behind our own web server (TRUST_PROXY=1) that is the last entry of
// X-Forwarded-For: the web server adds it, so a client cannot fake it. Earlier entries can.
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const last = typeof xff === 'string' ? xff.split(',').pop().trim() : '';
    if (last && last.length <= 64 && /^[0-9A-Fa-f.:]+$/.test(last)) return last;
  }
  return String((req.socket && req.socket.remoteAddress) || '-').replace(/^::ffff:(?=\d+\.)/, '');
}

module.exports = { HttpError, CORS, PREFLIGHT, MAX_JSON_BYTES, sendJson, sendError, errorText, readJson, rawPath, clientIp };
