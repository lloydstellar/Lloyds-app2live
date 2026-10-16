'use strict';
// The cleanup of BUILD-PROMPT.md section 9: one function that removes what has had its time. It
// runs at start and every minute, and logs one line with the counts when it removed something.
// Devices that are quiet are never deleted: a computer may not import for months.

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
    const keep = new Set(store.packagesWithFiles());
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
        const counts = run();
        if (swept) counts['leftover file(s) and folder(s)'] = swept;
        return counts;
      }),
    // Every minute.
    tick: () => safely(run),
  };
}

module.exports = { makeCleanup, UNDELIVERED_MS, KEEP_REVOKED_MS };
