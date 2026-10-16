'use strict';
// la2l-server. "node src/main.js" reads the settings, opens the database and serves HTTP until
// it gets SIGTERM. The tests call start() with settings of their own, port 0 and their own clock.

const http = require('http');
const fs = require('fs');
const { loadConfig } = require('./config');
const { Router } = require('./router');
const { HttpError, CORS, PREFLIGHT, sendError, rawPath, clientIp } = require('./http-util');
const { StaticFiles } = require('./static');
const { openDb, Store } = require('./db');
const { Storage } = require('./storage');
const { RateLimits } = require('./ratelimit');
const { makeAuth } = require('./auth');
const { deviceRoutes } = require('./routes/device');
const { appRoutes } = require('./routes/app');

const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';

// Starts the server. Resolves to { server, port, store, close() } once it listens.
// opts.log(line) gets every log line (the default is stdout, which Docker keeps).
// opts.clock() gives the time in ms (the default is Date.now); tests move it forward.
async function start(config, opts = {}) {
  const write = opts.log || ((line) => process.stdout.write(line + '\n'));
  const clock = opts.clock || Date.now;
  const log = (text) => write(`${new Date(clock()).toISOString()} ${text}`);

  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(openDb(config.dataDir));
  const storage = new Storage(config.dataDir);
  const limits = new RateLimits(config.rateLimits, clock);
  const auth = makeAuth({ store, limits, clock });
  const deps = { config, store, storage, limits, auth, clock, log };

  const router = new Router();
  deviceRoutes(router, deps);
  appRoutes(router, deps);
  const pages = new StaticFiles();
  const sweeper = setInterval(() => limits.sweep(), 5 * 60000);
  sweeper.unref();

  // One line per request. The route pattern stands in for the path, so a pair id or a file name
  // never reaches the log. The health check of Docker itself (loopback, no proxy) is left out.
  function logRequest(ctx, started) {
    const { req, res } = ctx;
    const status = res.writableFinished ? String(res.statusCode) : `${res.statusCode} aborted`;
    if (ctx.route === 'GET /api/health' && status === '200' && isLoopback(ctx.ip) && !req.headers['x-forwarded-for']) return;
    const ms = (Number(process.hrtime.bigint() - started) / 1e6).toFixed(1);
    const bytesIn = req.bytesIn !== undefined ? req.bytesIn : Number(req.headers['content-length']) || 0;
    const bytesOut = req.method === 'HEAD' ? 0 : Number(res.getHeader('content-length')) || 0;
    log(`${ctx.route} ${status} ${ms}ms in=${bytesIn} out=${bytesOut} ${ctx.who} ${ctx.ip}`);
  }

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const urlPath = rawPath(req.url);
    const ctx = { req, res, params: {}, ip: clientIp(req, config.trustProxy), route: '', who: '-' };
    res.on('close', () => logRequest(ctx, started));
    try {
      if (urlPath !== '/api' && !urlPath.startsWith('/api/')) {
        ctx.route = pages.routeName(req.method, urlPath);
        pages.serve(req, res, urlPath);
        return;
      }
      for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
      if (req.method === 'OPTIONS') {
        ctx.route = 'OPTIONS /api/*';
        res.writeHead(204, PREFLIGHT);
        res.end();
        return;
      }
      ctx.route = `${req.method} (unknown)`;
      const { route, params } = router.find(req.method, urlPath);
      ctx.route = `${req.method} ${route.pattern}`;
      ctx.params = params;
      await route.handler(ctx);
    } catch (e) {
      if (res.headersSent) {
        log(`ERROR ${ctx.route} after the answer started: ${e.stack || e}`);
        res.destroy();
      } else if (e instanceof HttpError) {
        sendError(res, e.status, e.message, e.headers);
      } else {
        log(`ERROR ${ctx.route}: ${e.stack || e}`);
        sendError(res, 500, 'The server has a problem. Try again later.');
      }
    }
  }

  // headersTimeout: a client gets 20 seconds for its headers. requestTimeout: 15 minutes for a
  // whole request, because a 200 MB upload from a phone takes long. timeout: a socket without
  // any data for a minute is closed.
  const server = http.createServer({ headersTimeout: 20000, requestTimeout: 15 * 60000 }, (req, res) => {
    handle(req, res).catch((e) => log(`ERROR ${e.stack || e}`));
  });
  server.timeout = 60000;

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (e) {
    clearInterval(sweeper);
    store.close();
    throw e;
  }
  const port = server.address().port;
  log(`la2l-server ${config.version} listening on ${config.host}:${port}. Data: ${config.dataDir}. Public address: ${config.publicUrl}`);

  return {
    server,
    port,
    store,
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweeper);
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 5000).unref();
      }),
  };
}

if (require.main === module) {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    console.error(`la2l-server: ${e.message}`);
    process.exit(1);
  }
  start(config).then(
    (s) => {
      let stopping = false;
      const stop = (signal) => {
        if (stopping) return;
        stopping = true;
        console.log(`${new Date().toISOString()} ${signal}: stopping`);
        s.close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 8000).unref();
      };
      process.on('SIGTERM', () => stop('SIGTERM'));
      process.on('SIGINT', () => stop('SIGINT'));
    },
    (e) => {
      console.error(`la2l-server could not start: ${e.message}`);
      process.exit(1);
    }
  );
}

module.exports = { start };
