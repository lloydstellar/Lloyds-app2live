'use strict';
// The app side of packages (docs/server-api.md, "Packages"): an app describes its sounds, uploads
// the WAV files one by one, commits, and follows the status until Live has them.

const fs = require('fs');
const crypto = require('crypto');
const { HttpError, sendJson, readJson, MAX_JSON_BYTES } = require('../http-util');
const { PACKAGE_ID, isFileName } = require('../storage');
const { receiveFile, FULL } = require('../upload');
const { statusAt } = require('../packages');
const { checkWav } = require('../wav-check');
const { APP_401 } = require('../auth');
const { ipKey } = require('../ratelimit');
const manifest = require('../../../src/node/manifest');
const wav = require('../../../src/node/wav');

const UNKNOWN_PACKAGE = 'Unknown package.';
const PACKAGE_OPTS = { params: { id: PACKAGE_ID }, notFound: UNKNOWN_PACKAGE };
const FILE_OPTS = { params: { id: PACKAGE_ID, file: { test: isFileName } }, notFound: 'This file is not in the package.' };
const MAX_WARNINGS = 50;

function packageRoutes(router, { config, store, storage, auth, limits, clock, log, senderKey }) {
  const iso = (ms) => new Date(ms).toISOString();
  // Who sent a package, for the limit per address: the address as the rate limits count it (an
  // IPv6 address by its /64), as a hash with a key that only this running server knows.
  const senderOf = (ip) => crypto.createHmac('sha256', senderKey).update(ipKey(ip)).digest('hex').slice(0, 32);
  // Uploads in progress, "<package>/<file>": one at a time per file.
  const writing = new Set();

  // A package of this app that still takes files.
  function uploadingPackage(id, app) {
    const p = store.packageOfApp(id, app.id);
    if (!p || p.status === 'deleted') throw new HttpError(404, UNKNOWN_PACKAGE);
    if (p.status !== 'uploading') throw new HttpError(404, 'This package is sent already.');
    if (statusAt(p, clock(), config.uploadTtlMs) === 'expired') throw new HttpError(404, 'The upload took too long. Send the package again.');
    return p;
  }

  // A new package: the manifest. The server gives it its id; the files come next.
  router.add('POST', '/api/packages', async (ctx) => {
    const app = auth.app(ctx);
    limits.check('packages', `app ${app.id}`);
    const raw = await readJson(ctx.req);
    const id = crypto.randomUUID();
    raw.package_id = id;
    let checked;
    try {
      checked = manifest.validate(raw);
    } catch (e) {
      // A ManifestError says what is wrong. Anything else comes from a value no app would send,
      // such as an object where a name belongs.
      throw new HttpError(422, e instanceof manifest.ManifestError ? e.message : 'The package description is not valid.');
    }
    // Stricter than the device: every sound must be right, with its size and checksum.
    const { pkg, warnings } = checked;
    for (const item of pkg.items) {
      if (item.error) throw new HttpError(422, `${item.name} ${item.error}`);
      if (!item.bytes || !item.sha256) throw new HttpError(422, `${item.name} needs bytes and sha256.`);
    }
    // A tempo only changes a loop: Live plays a one-shot as it is. Say so, because an app that
    // sends a BPM expects it to do something.
    for (const item of pkg.items) {
      if (item.kind !== 'loop' && (item.bpm || item.lengthBeats)) warnings.push(`${item.name}: bpm and length_beats only apply to a loop`);
    }
    if (pkg.bpm && !pkg.items.some((item) => item.kind === 'loop')) warnings.push('tempo.bpm only applies to loops, and this package has none');
    const text = JSON.stringify(raw);
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new HttpError(413, 'The request is larger than 1 MB.');
    const totalBytes = pkg.items.reduce((n, item) => n + item.bytes, 0);
    const nowMs = clock();
    const expiresAt = iso(nowMs + config.packageTtlMs);

    const sender = senderOf(ctx.ip);

    store.tx(() => {
      // The body took a while: the app may have been unpaired or cleaned up since the token check.
      if (!store.isActiveApp(app.id)) throw new HttpError(401, APP_401);
      if (store.bytesFor(app.device_ref) + totalBytes > config.maxDeviceStorageBytes) {
        throw new HttpError(507, 'Too many sounds wait for this computer. Click Import in Live first.');
      }
      // One address could pair many computers with itself and fill each of them.
      if (store.bytesFromSender(sender) + totalBytes > config.maxAddressStorageBytes) {
        throw new HttpError(507, 'Too many sounds wait from this address. Try again later.');
      }
      // The whole server stops long before the disk is full; the free space is the last line.
      if (store.bytesStored() + totalBytes > config.maxTotalStorageBytes) throw new HttpError(507, FULL);
      if (storage.freeBytes() - store.bytesComing() - totalBytes < config.minFreeDiskBytes) throw new HttpError(507, FULL);
      store.createPackage(
        {
          id,
          deviceRef: app.device_ref,
          appRef: app.id,
          title: pkg.title,
          appName: pkg.app,
          itemCount: pkg.items.length,
          totalBytes,
          manifest: text,
          expiresAt,
          sender,
        },
        pkg.items.map((item) => ({ file: item.file, bytes: item.bytes, sha256: item.sha256 })),
        iso(nowMs)
      );
    });
    log(`package ${id} created by app ${app.id} for device ${app.device_ref}: ${pkg.items.length} sound(s), ${totalBytes} bytes`);
    const upload = {};
    for (const item of pkg.items) upload[item.file] = `/packages/${id}/files/${encodeURIComponent(item.file)}`;
    sendJson(ctx.res, 201, { package_id: id, upload, expires_at: expiresAt, warnings: warnings.slice(0, MAX_WARNINGS) });
  });

  // One WAV file. It is checked before it counts: size, checksum, and the WAV header.
  router.add(
    'PUT',
    '/api/packages/:id/files/:file',
    async (ctx) => {
      const app = auth.app(ctx);
      const p = uploadingPackage(ctx.params.id, app);
      const f = store.fileOf(p.id, ctx.params.file);
      if (!f) throw new HttpError(404, 'This file is not in the package.');
      const key = `${p.id}/${f.file}`;
      if (writing.has(key)) throw new HttpError(409, 'This file is being sent already.');
      writing.add(key);
      const part = storage.partPath(p.id, f.file);
      try {
        storage.makePackageDir(p.id);
        let got;
        try {
          got = await receiveFile(ctx.req, part, f.bytes);
        } catch (e) {
          // Deleted or expired while it came in: its folder may be gone with the file in it.
          if (e.code === 'ENOENT') throw new HttpError(404, UNKNOWN_PACKAGE);
          throw e;
        }
        try {
          if (got.bytes !== f.bytes || got.sha256 !== f.sha256) throw new HttpError(422, 'The file arrived damaged. Send it again.');
          let unusable = null;
          try {
            await checkWav(part, config.wavCheckMs);
          } catch (e) {
            if (!(e instanceof wav.WavError)) {
              uploadingPackage(p.id, app); // deleted meanwhile: a 404, not a 500
              throw e;
            }
            unusable = e.message;
          }
          // From here on nothing waits, so no other request can change the package in between.
          uploadingPackage(p.id, app);
          if (unusable) throw new HttpError(422, unusable);
          fs.renameSync(part, storage.filePath(p.id, f.file)); // replaces a file sent before
          store.markReceived(p.id, f.file);
        } catch (e) {
          fs.rmSync(part, { force: true });
          throw e;
        }
      } finally {
        writing.delete(key);
      }
      sendJson(ctx.res, 200, { ok: true, file: f.file, bytes: f.bytes });
    },
    FILE_OPTS
  );

  // Every file is there: from now on the device sees the package.
  router.add(
    'POST',
    '/api/packages/:id/commit',
    async (ctx) => {
      const app = auth.app(ctx);
      await readJson(ctx.req);
      const p = store.packageOfApp(ctx.params.id, app.id);
      if (!p || p.status === 'deleted') throw new HttpError(404, UNKNOWN_PACKAGE);
      // Committed before: the same answer again, with what happened since.
      if (p.status !== 'uploading') return sendJson(ctx.res, 200, { ok: true, status: statusAt(p, clock(), config.uploadTtlMs) });
      uploadingPackage(p.id, app);
      const missing = store.missingFiles(p.id);
      if (missing.length) throw new HttpError(409, `Not all files are there yet: ${missing.join(', ')}`);
      store.commitPackage(p.id, iso(clock()));
      log(`package ${p.id} committed: ${p.item_count} sound(s) wait for device ${p.device_ref}`);
      sendJson(ctx.res, 200, { ok: true, status: 'waiting' });
    },
    PACKAGE_OPTS
  );

  // For "Waiting for Import in Live" and "In Live": the status, and per sound what the device
  // said in its ack.
  router.add(
    'GET',
    '/api/packages/:id/status',
    (ctx) => {
      const app = auth.app(ctx);
      const p = store.packageOfApp(ctx.params.id, app.id);
      if (!p || p.status === 'deleted') throw new HttpError(404, UNKNOWN_PACKAGE);
      const ack = p.ack ? JSON.parse(p.ack) : null;
      const answer = { status: statusAt(p, clock(), config.uploadTtlMs), items: ack ? ack.items : [], updated_at: p.updated_at };
      if (ack && ack.error) answer.error = ack.error;
      sendJson(ctx.res, 200, answer);
    },
    PACKAGE_OPTS
  );

  // The app takes a package back, until it is in Live.
  router.add(
    'DELETE',
    '/api/packages/:id',
    (ctx) => {
      const app = auth.app(ctx);
      const removed = store.tx(() => {
        const p = store.packageOfApp(ctx.params.id, app.id);
        if (!p) throw new HttpError(404, UNKNOWN_PACKAGE);
        if (p.status === 'imported' || p.status === 'partial') throw new HttpError(409, 'This package is already in Live.');
        if (p.status === 'deleted') return false;
        store.markDone(p.id, 'deleted', null, iso(clock()));
        return true;
      });
      if (removed) {
        storage.removePackage(ctx.params.id);
        log(`package ${ctx.params.id} deleted by app ${app.id}`);
      }
      sendJson(ctx.res, 200, { ok: true });
    },
    PACKAGE_OPTS
  );
}

module.exports = { packageRoutes };
