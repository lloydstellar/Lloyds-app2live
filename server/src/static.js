'use strict';
// Serves the pages from public/ (LA2L Sender, the test receiver, the SDK for the browser and the
// developer pages) and the examples of the developer kit, with strict security headers. Only the files listed here exist; every other path is a 404, so no path
// can reach outside public/.

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
  '/big.js': ['big.js', 'text/javascript; charset=utf-8'],
  // The test receiver (sdk/BUILD-PROMPT.md, section 8).
  '/receiver': ['receiver.html', 'text/html; charset=utf-8'],
  '/receiver.js': ['receiver.js', 'text/javascript; charset=utf-8'],
  '/receiver.css': ['receiver.css', 'text/css; charset=utf-8'],
  // The SDK for the browser, built from sdk/js (npm run build there): the SDK, the Send to Live
  // button, and the test receiver of the page above.
  '/vendor/la2l.js': ['vendor/la2l.js', 'text/javascript; charset=utf-8'],
  '/vendor/la2l-button.js': ['vendor/la2l-button.js', 'text/javascript; charset=utf-8'],
  '/vendor/la2l-receiver.js': ['vendor/la2l-receiver.js', 'text/javascript; charset=utf-8'],
};

// Examples of the developer kit, from a folder of the repository (in the image: /app/examples).
// The list of their files is read once at start; a URL path never becomes a file path.
const EXAMPLES = {
  '/examples/drum-machine/': path.join(__dirname, '..', '..', 'examples', 'web-drum-machine'),
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// The developer pages, made from docs/developers by tools/devpages.js and committed, as vendor/
// is: /developers/ and /developers/<page>, each with its Markdown twin /developers/<page>.md, the
// OpenAPI file and the JSON Schema next to them, and /llms.txt and /llms-full.txt. Read once at
// start, as the examples are.
const DEVELOPERS = path.join(PUBLIC, 'developers');
const DEVELOPER_TYPES = Object.assign({}, TYPES, {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
});
// Search engines leave them out until the launch, when the device can be downloaded too
// (sdk/BUILD-PROMPT.md, section 15). Then set this to true.
const DEVELOPER_PAGES_INDEXED = false;

// A folder without its "/" goes to the folder, so the relative addresses in its page work.
const REDIRECTS = { '/examples/drum-machine': 'drum-machine/', '/developers': 'developers/' };

const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// Reads the files once. They are small, and a missing one should stop the server at start.
function loadFiles() {
  const files = new Map();
  const add = (urlPath, file, type, extra = {}) => {
    const body = fs.readFileSync(file);
    const etag = `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
    files.set(urlPath, { body, type, etag, extra });
  };
  for (const [urlPath, [file, type]] of Object.entries(FILES)) add(urlPath, path.resolve(PUBLIC, file), type);
  for (const [prefix, dir] of Object.entries(EXAMPLES)) {
    for (const name of fs.readdirSync(dir).sort()) {
      const type = TYPES[path.extname(name).toLowerCase()];
      if (!type || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
      add(prefix + (name === 'index.html' ? '' : name), path.join(dir, name), type);
    }
  }
  const robots = DEVELOPER_PAGES_INDEXED ? {} : { 'X-Robots-Tag': 'noindex' };
  for (const name of fs.readdirSync(DEVELOPERS).sort()) {
    const type = DEVELOPER_TYPES[path.extname(name).toLowerCase()];
    if (!type || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
    let urlPath = '/developers/' + name;
    if (name === 'index.html') urlPath = '/developers/';
    else if (name.endsWith('.html')) urlPath = '/developers/' + name.slice(0, -'.html'.length);
    else if (name === 'llms.txt' || name === 'llms-full.txt') urlPath = '/' + name;
    add(urlPath, path.join(DEVELOPERS, name), type, robots);
  }
  return files;
}

class StaticFiles {
  constructor() {
    this.files = loadFiles();
  }

  // The route name for the log: the file path when it is one of ours.
  routeName(method, urlPath) {
    const known = this.files.has(urlPath) || Object.prototype.hasOwnProperty.call(REDIRECTS, urlPath);
    return `${method} ${known ? urlPath : '(unknown page)'}`;
  }

  serve(req, res, urlPath) {
    if (Object.prototype.hasOwnProperty.call(REDIRECTS, urlPath)) {
      return this.plain(res, 301, 'Moved.', { Location: REDIRECTS[urlPath] });
    }
    const f = this.files.get(urlPath);
    if (!f) return this.plain(res, 404, 'Not found.');
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.plain(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });
    // no-cache: the browser keeps the file but asks every time, so a new version shows at once.
    const headers = Object.assign({ 'Content-Type': f.type, 'Cache-Control': 'no-cache', ETag: f.etag }, HEADERS, f.extra);
    if (req.headers['if-none-match'] === f.etag) return answer(res, 304, headers);
    answer(res, 200, Object.assign({ 'Content-Length': f.body.length }, headers), f.body);
  }

  plain(res, status, text, extra = {}) {
    const body = Buffer.from(text + '\n');
    answer(res, status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' }, HEADERS, extra), body);
  }
}

// The headers go through setHeader, not writeHead: Node only lets the request log read back
// headers that were set that way, and the log takes the bytes out from Content-Length.
function answer(res, status, headers, body) {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.writeHead(status);
  res.end(body);
}

module.exports = { StaticFiles, HEADERS };
