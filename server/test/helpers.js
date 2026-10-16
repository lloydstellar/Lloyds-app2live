'use strict';
// Starts a real server for a test: port 0, a fresh data folder, rate limits off unless a test
// turns them on, and every log line kept in `lines`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { loadConfig } = require('../src/config');
const { start } = require('../src/main');

// One HTTP exchange with full control: the path goes out exactly as given (no normalising).
// Resolves to { status, headers, body, json }.
function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch (e) {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', reject);
    if (body === undefined) req.end();
    else req.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
}

// env: settings as environment variables; overrides: fields of the config object itself
// (times in ms), for the short times some tests need.
async function startServer(env = {}, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-server-'));
  const config = Object.assign(
    loadConfig(Object.assign({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, RATE_LIMITS: 'off', TRUST_PROXY: '0' }, env)),
    overrides
  );
  const lines = [];
  const s = await start(config, { log: (line) => lines.push(line) });
  const origin = `http://127.0.0.1:${s.port}`;
  return {
    port: s.port,
    origin,
    base: origin + '/api',
    config,
    dataDir,
    lines,
    request: (method, urlPath, opts) => request(s.port, method, urlPath, opts),
    async stop() {
      await s.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

module.exports = { startServer, request };
