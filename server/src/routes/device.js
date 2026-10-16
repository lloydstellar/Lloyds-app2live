'use strict';
// The device side of the API, as LA2L 0.1.1 uses it (docs/server-api.md, "Device side").
// That side is fixed: the device is installed and must keep working unchanged.

const fs = require('fs');
const { pipeline } = require('stream');
const { HttpError, sendJson, readJson, cleanText } = require('../http-util');
const { newPairId, newCode, sha256, bearer } = require('../tokens');
const { ipKey } = require('../ratelimit');
const { PACKAGE_ID, isFileName } = require('../storage');
const { isOpen, cleanAck } = require('../packages');

const PAIR_ID = /^[A-Za-z0-9_-]{20,100}$/;
const PAIR_OPTS = { params: { id: PAIR_ID }, notFound: 'Unknown pairing.' };
// Someone else's package gets the same 404 as one that does not exist.
const UNKNOWN_PACKAGE = 'Unknown package.';
const PACKAGE_OPTS = { params: { id: PACKAGE_ID }, notFound: UNKNOWN_PACKAGE };
const FILE_OPTS = { params: { id: PACKAGE_ID, file: { test: isFileName } }, notFound: 'Unknown file.' };
// After the device got its token, the paired answer is given again for this long, in case that
// answer was lost on the way. Then the pairing is gone and the status call answers 404.
const DELIVERY_GRACE_MS = 60000;

function deviceRoutes(router, { config, store, storage, auth, limits, clock, log }) {
  const iso = (ms) => new Date(ms).toISOString();

  // Self test in the device needs {"ok": true}; anything else reads as "no App2Live server".
  router.add('GET', '/api/health', ({ res }) => {
    let ok;
    try {
      ok = store.ping();
      fs.accessSync(config.dataDir, fs.constants.W_OK);
    } catch (e) {
      ok = false;
    }
    if (!ok) return sendJson(res, 503, { ok: false, error: 'The server cannot store sounds right now.' });
    sendJson(res, 200, { ok: true, name: 'la2l-server', version: config.version });
  });

  // Pair app, or Settings > Add app: a code to type in the app.
  router.add('POST', '/api/pair/start', async (ctx) => {
    limits.check('pairStart', ipKey(ctx.ip));
    const body = await readJson(ctx.req);
    const deviceId = typeof body.device_id === 'string' ? body.device_id : '';
    if (!/^[A-Za-z0-9-]{1,100}$/.test(deviceId)) throw new HttpError(400, 'device_id is missing.');
    // Add app sends the token: the new app joins this computer and its token. An unknown or
    // revoked token counts as no token; device 0.1.1 would stay stuck on a 401 here.
    const token = bearer(ctx.req.headers.authorization);
    const device = token ? store.deviceByToken(sha256(token)) : null;
    if (device) ctx.who = `device=${device.id}`;
    const now = clock();
    const expiresAt = iso(now + config.pairTtlSeconds * 1000);
    const pairId = newPairId();
    const code = store.tx(() => {
      store.cancelWaitingFor(deviceId, iso(now)); // one code per computer at a time
      let c = newCode();
      while (store.codeTaken(c, iso(now))) c = newCode();
      store.createPairing(
        {
          pairHash: sha256(pairId),
          code: c,
          deviceRef: device ? device.id : null,
          deviceId,
          deviceName: cleanText(body.device_name, 64) || 'Computer',
          client: cleanText(body.client, 40),
          platform: cleanText(body.platform, 20),
          tokenPlain: device ? token : null, // the paired answer must hand back this same token
          expiresAt,
        },
        iso(now)
      );
      return c;
    });
    log(device ? `pairing started: Add app for device ${device.id}` : 'pairing started: new computer');
    sendJson(ctx.res, 200, { pair_id: pairId, code, expires_in: config.pairTtlSeconds, expires_at: expiresAt, poll_ms: config.pollMs });
  });

  // The device asks this every poll_ms while the code shows. The pair id is the only secret.
  router.add(
    'GET',
    '/api/pair/:id',
    (ctx) => {
      limits.check('pairStatus', ipKey(ctx.ip));
      const p = store.pairingByHash(sha256(ctx.params.id));
      if (!p) throw new HttpError(404, 'Unknown pairing.');
      const now = clock();
      if (p.status === 'waiting') return sendJson(ctx.res, 200, { status: p.expires_at <= iso(now) ? 'expired' : 'waiting' });
      if (p.status !== 'paired') return sendJson(ctx.res, 200, { status: 'cancelled' });
      if (p.delivered_at && now - Date.parse(p.delivered_at) > DELIVERY_GRACE_MS) {
        store.deletePairing(p.id);
        throw new HttpError(404, 'Unknown pairing.');
      }
      ctx.who = `device=${p.device_ref}`;
      if (!p.delivered_at && ctx.req.method === 'GET') {
        store.markDelivered(p.id, iso(now));
        log(`pairing delivered to device ${p.device_ref}`);
      }
      sendJson(ctx.res, 200, { status: 'paired', device_token: p.token_plain, app_name: p.app_name });
    },
    PAIR_OPTS
  );

  // Cancel in the device. No body. The device does not look at the answer.
  router.add(
    'POST',
    '/api/pair/:id/cancel',
    (ctx) => {
      const p = store.pairingByHash(sha256(ctx.params.id));
      if (!p) throw new HttpError(404, 'Unknown pairing.');
      if (p.status === 'waiting') {
        store.cancelPairing(p.id, iso(clock()));
        log('pairing cancelled');
      }
      sendJson(ctx.res, 200, { ok: true });
    },
    PAIR_OPTS
  );

  // Import (and Self test): the packages waiting for this computer, oldest first.
  router.add('GET', '/api/inbox', (ctx) => {
    const device = auth.device(ctx);
    const packages = store.inbox(device.id, iso(clock())).map((p) => ({
      package_id: p.id,
      title: p.title,
      app: p.app_name,
      items: p.item_count,
      created_at: p.committed_at,
    }));
    sendJson(ctx.res, 200, { packages });
  });

  // A package the device may import: its own, waiting or failed, not expired.
  function openPackage(ctx, device) {
    const p = store.packageOfDevice(ctx.params.id, device.id);
    if (!p || !isOpen(p, clock())) throw new HttpError(404, UNKNOWN_PACKAGE);
    return p;
  }

  // The manifest as the app sent it, with the server's package_id, and bytes and sha256 on
  // every sound.
  router.add(
    'GET',
    '/api/packages/:id/manifest',
    (ctx) => {
      const p = openPackage(ctx, auth.device(ctx));
      sendJson(ctx.res, 200, JSON.parse(p.manifest));
    },
    PACKAGE_OPTS
  );

  // One WAV file, streamed from disk with its exact length. HEAD gives the headers only.
  router.add(
    'GET',
    '/api/packages/:id/files/:file',
    (ctx) => {
      const p = openPackage(ctx, auth.device(ctx));
      const f = store.fileOf(p.id, ctx.params.file);
      if (!f || !f.received) throw new HttpError(404, 'Unknown file.');
      const file = storage.filePath(p.id, f.file);
      let size = -1;
      try {
        size = fs.statSync(file).size;
      } catch (e) {
        // missing: handled below
      }
      if (size !== f.bytes) {
        log(`ERROR package ${p.id}: the file ${f.file} is ${size < 0 ? 'missing' : `${size} bytes instead of ${f.bytes}`} on disk`);
        throw new HttpError(404, 'The file is gone. Send it again.');
      }
      ctx.res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': size, 'Cache-Control': 'no-store' });
      if (ctx.req.method === 'HEAD') return ctx.res.end();
      pipeline(fs.createReadStream(file), ctx.res, (e) => {
        if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') log(`ERROR package ${p.id}: sending ${f.file} failed: ${e.message}`);
      });
    },
    FILE_OPTS
  );

  // What happened in Live. imported and partial: the files go now, the row stays for the app.
  // failed: the package stays in the inbox until it expires, so the user can try again.
  router.add(
    'POST',
    '/api/packages/:id/ack',
    async (ctx) => {
      const device = auth.device(ctx);
      const ack = cleanAck(await readJson(ctx.req));
      const now = iso(clock());
      const result = store.tx(() => {
        const p = store.packageOfDevice(ctx.params.id, device.id);
        if (!p || p.status === 'uploading' || p.status === 'deleted') return null;
        const hasFiles = p.status === 'waiting' || p.status === 'failed';
        const before = p.ack ? JSON.parse(p.ack) : null;
        if (ack.status === 'failed') {
          // Once the files are gone, a late "failed" cannot bring the package back.
          if (!hasFiles) return { status: p.status, ignored: true };
          store.markFailed(p.id, JSON.stringify(ack), now);
          return { status: 'failed' };
        }
        let status = ack.status;
        if (ack.note === 'imported before' && before && (before.status === 'imported' || before.status === 'partial')) {
          // Placed before, but that ack was lost: keep what the earlier ack said per sound.
          if (!ack.items.length) ack.items = before.items || [];
          if (before.status === 'partial') status = 'partial';
        }
        store.markDone(p.id, status, JSON.stringify(Object.assign(ack, { status })), now);
        return { status, removeFiles: hasFiles };
      });
      if (!result) throw new HttpError(404, UNKNOWN_PACKAGE);
      if (result.removeFiles) storage.removePackage(ctx.params.id);
      if (result.ignored) log(`package ${ctx.params.id}: a late failed ack from device ${device.id} was ignored, it stays ${result.status}`);
      else log(`package ${ctx.params.id} acked by device ${device.id}: ${result.status}${ack.note === 'imported before' ? ' (imported before)' : ''}`);
      sendJson(ctx.res, 200, { ok: true });
    },
    PACKAGE_OPTS
  );

  // Unpair in the device: this computer and all its apps lose their tokens, and what was still
  // waiting for it is deleted.
  router.add('POST', '/api/unpair', async (ctx) => {
    const device = auth.device(ctx);
    await readJson(ctx.req);
    const { apps, packageIds } = store.tx(() => store.revokeDeviceAndPackages(device.id, iso(clock())));
    for (const id of packageIds) storage.removePackage(id);
    log(`device ${device.id} unpaired: ${apps} app(s) revoked, ${packageIds.length} package(s) deleted`);
    sendJson(ctx.res, 200, { ok: true });
  });
}

module.exports = { deviceRoutes, DELIVERY_GRACE_MS };
