'use strict';
// Serves the LA2L Sender page from public/, with strict security headers. Only the files listed
// here exist; every other path is a 404, so no path can reach outside public/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC = path.join(__dirname, '..', 'public');

// The Docker image copies the device's logo into public/; in the repository it stays in src/ui.
function logoFile() {
  const inImage = path.join(PUBLIC, 'logo.png');
  return fs.existsSync(inImage) ? inImage : path.join(__dirname, '..', '..', 'src', 'ui', 'la2l-logo-big.png');
}

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/sender.css': ['sender.css', 'text/css; charset=utf-8'],
  '/sender.js': ['sender.js', 'text/javascript; charset=utf-8'],
  '/logo.png': [logoFile(), 'image/png'],
};

const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// Reads the files once. They are small, and a missing one should stop the server at start.
function loadFiles() {
  const files = new Map();
  for (const [urlPath, [file, type]] of Object.entries(FILES)) {
    const body = fs.readFileSync(path.resolve(PUBLIC, file));
    const etag = `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
    files.set(urlPath, { body, type, etag });
  }
  return files;
}

class StaticFiles {
  constructor() {
    this.files = loadFiles();
  }

  // The route name for the log: the file path when it is one of ours.
  routeName(method, urlPath) {
    return `${method} ${this.files.has(urlPath) ? urlPath : '(unknown page)'}`;
  }

  serve(req, res, urlPath) {
    const f = this.files.get(urlPath);
    if (!f) return this.plain(res, 404, 'Not found.');
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.plain(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });
    // no-cache: the browser keeps the file but asks every time, so a new version shows at once.
    const headers = Object.assign({ 'Content-Type': f.type, 'Cache-Control': 'no-cache', ETag: f.etag }, HEADERS);
    if (req.headers['if-none-match'] === f.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, Object.assign({ 'Content-Length': f.body.length }, headers));
    res.end(f.body);
  }

  plain(res, status, text, extra = {}) {
    const body = Buffer.from(text + '\n');
    res.writeHead(
      status,
      Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' }, HEADERS, extra)
    );
    res.end(body);
  }
}

module.exports = { StaticFiles, HEADERS };
