'use strict';
// The cleanup of BUILD-PROMPT.md section 9: one function that removes what has had its time. It
// runs at start and every minute, and logs one line with the counts when it removed something.
// Devices that are quiet are never deleted: a computer may not import for months. Test receivers
// are (sdk/BUILD-PROMPT.md section 7.4): a page or a terminal that was closed never unpairs.

const fs = require('fs');
const path = require('path');
const { DELIVERY_GRACE_MS } = require('./routes/device');

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A waiting pairing past its end answers "expired" for an hour, a cancelled one "cancelled".
const KEEP_ENDED_PAIRING_MS = HOUR;
// A claim the device never picked up: the device stopped asking, so its token is lost.
const UNDELIVERED_MS = 10 * MINUTE;
const KEEP_REVOKED_MS = 30 * DAY;
const QUIET_TEST_RECEIVER_MS = 7 * DAY;

function makeCleanup({ config, store, storage, clock, log }) {
  const iso = (ms) => new Date(ms).toISOString();

  // Removes what is due in the database, then the folders of the packages that went.
  // Returns { what: count } of what it removed.
  function run() {
    const now = clock();
    const counts = {};
    const count = (what, n = 1) => {
      if (n) counts[what] = (counts[what] || 0) + n;
    };
    const folders = [];
    store.tx(() => {
      // An Add app pairing that ended unclaimed no longer needs the device token it held.
      store.forgetEndedTokens(iso(now));
      count('pairing(s)', store.deleteOldPairings(iso(now - KEEP_ENDED_PAIRING_MS), iso(now - KEEP_ENDED_PAIRING_MS), iso(now - DELIVERY_GRACE_MS)));
      for (const p of store.undeliveredClaims(iso(now - UNDELIVERED_MS))) {
        store.deletePairing(p.id);
        count('pairing(s)');
        // When the claim made the computer, its app has a token for a computer that does not
        // know it: the app gets a 401 and pairs again.
        if (p.new_device) {
          folders.push(...store.deleteDevice(p.device_ref));
          count('computer(s) that never got their token');
        }
      }
      for (const id of store.staleUploads(iso(now - config.uploadTtlMs))) {
        store.deletePackage(id);
        folders.push(id);
        count('unfinished upload(s)');
      }
      for (const id of store.expiredPackages(iso(now))) {
        store.markDone(id, 'expired', null, iso(now));
        folders.push(id);
        count('expired package(s)');
      }
      for (const id of store.quietTestDevices(iso(now - QUIET_TEST_RECEIVER_MS))) {
        folders.push(...store.deleteDevice(id));
        count('test receiver(s) quiet for 7 days');
      }
      count('old result(s)', store.deleteOldResults(iso(now - config.resultTtlMs)));
      const revoked = store.deleteOldRevoked(iso(now - KEEP_REVOKED_MS));
      count('revoked app(s)', revoked.apps);
      count('revoked computer(s)', revoked.devices);
    });
    for (const id of folders) storage.removePackage(id);
    return counts;
  }

  // At start nothing is being written. So every .part file is left from an upload that broke
  // off, and a folder of a package without files is left from a stop between the database and
  // the disk. Returns how many it removed.
  function sweepDisk() {
    const keep = new Set(store.packagesWithFiles().map((p) => p.id));
    let removed = 0;
    for (const entry of fs.readdirSync(storage.root, { withFileTypes: true })) {
      const full = path.join(storage.root, entry.name);
      if (!keep.has(entry.name) || !entry.isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
        continue;
      }
      for (const file of fs.readdirSync(full)) {
        if (!file.endsWith('.part')) continue;
        fs.rmSync(path.join(full, file), { force: true });
        removed++;
      }
    }
    return removed;
  }

  // At start, also the other way round: files the database has that are not on disk, for example
  // after the database came back from a backup. A waiting or failed package without all its files
  // can never reach Live: it counts as expired, so its app sees that. In an upload that is still
  // going on, such a file only counts as not sent yet: the app can send it again before it
  // commits. Returns { expired, resend }: how many packages and how many upload files.
  function checkFiles() {
    const expired = [];
    const resend = [];
    for (const p of store.packagesWithFiles()) {
      const gone = store.receivedFiles(p.id).filter((f) => !onDisk(p.id, f));
      if (!gone.length) continue;
      if (p.status === 'uploading') resend.push(...gone.map((f) => [p.id, f.file]));
      else expired.push(p.id);
    }
    const now = iso(clock());
    store.tx(() => {
      for (const id of expired) store.markDone(id, 'expired', null, now);
      for (const [id, file] of resend) store.markNotReceived(id, file);
    });
    for (const id of expired) storage.removePackage(id);
    for (const [id, file] of resend) fs.rmSync(storage.filePath(id, file), { force: true });
    return { expired: expired.length, resend: resend.length };
  }

  // Whether a received file is on disk with its size. Only a file that is not there, or has another
  // size, counts as gone. Another error (no permission, a disk error) may pass, and an expired
  // package cannot come back: it is logged, and the file kept.
  function onDisk(id, f) {
    try {
      return fs.statSync(storage.filePath(id, f.file)).size === f.bytes;
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
      log(`ERROR cleanup: cannot check ${f.file} of package ${id}: ${e.code || e.message}`);
      return true;
    }
  }

  function report(counts) {
    const parts = Object.entries(counts).map(([what, n]) => `${n} ${what}`);
    if (parts.length) log(`cleanup: ${parts.join(', ')}`);
  }

  // A problem is logged, and the next run tries again: a cleanup must never stop the server.
  function safely(fn) {
    try {
      const counts = fn();
      report(counts);
      return counts;
    } catch (e) {
      log(`ERROR cleanup: ${e.stack || e}`);
      return null;
    }
  }

  return {
    // At start: the disk first, then the database.
    atStart: () =>
      safely(() => {
        const swept = sweepDisk();
        const lost = checkFiles();
        const counts = run();
        if (swept) counts['leftover file(s) and folder(s)'] = swept;
        if (lost.expired) counts['package(s) whose files were gone'] = lost.expired;
        if (lost.resend) counts['upload file(s) to send again'] = lost.resend;
        return counts;
      }),
    // Every minute.
    tick: () => safely(run),
  };
}

module.exports = { makeCleanup, UNDELIVERED_MS, KEEP_REVOKED_MS, QUIET_TEST_RECEIVER_MS };
