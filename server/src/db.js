'use strict';
// The database: SQLite through node:sqlite, in DATA_DIR/la2l.db. The schema grows in numbered
// steps (MIGRATIONS); PRAGMA user_version says how many are done. node:sqlite is synchronous, so
// the statements of one request never interleave with another's; a transaction makes sure a
// crash never leaves half a change behind. Times are ISO 8601 strings in UTC, which sort right.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  // 1: the first schema (server/BUILD-PROMPT.md, section 6).
  `
  CREATE TABLE devices (
    id            INTEGER PRIMARY KEY,
    device_id     TEXT NOT NULL,              -- the random UUID the device made once; not secret
    name          TEXT NOT NULL,              -- the computer name, shown in apps
    client        TEXT NOT NULL DEFAULT '',   -- "LA2L 0.1.1"
    platform      TEXT NOT NULL DEFAULT '',   -- win32, darwin
    token_hash    TEXT NOT NULL UNIQUE,       -- sha256 hex of the device token
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT,
    revoked_at    TEXT
  );
  CREATE INDEX devices_device_id ON devices(device_id);

  CREATE TABLE apps (
    id            INTEGER PRIMARY KEY,
    device_ref    INTEGER NOT NULL REFERENCES devices(id),
    name          TEXT NOT NULL,              -- shown in the device: "Paired with ..."
    app_id        TEXT NOT NULL DEFAULT '',   -- the app's own id per installation; not secret
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT,
    revoked_at    TEXT
  );
  CREATE INDEX apps_device ON apps(device_ref);

  CREATE TABLE pairings (
    id            INTEGER PRIMARY KEY,
    pair_hash     TEXT NOT NULL UNIQUE,       -- sha256 of pair_id
    code          TEXT NOT NULL,              -- 6 characters; unique among waiting pairings
    status        TEXT NOT NULL,              -- waiting | paired | cancelled
    device_ref    INTEGER REFERENCES devices(id),  -- set at start for Add app, or at the claim
    new_device    INTEGER NOT NULL DEFAULT 0, -- 1 when the claim made the device row
    device_id     TEXT NOT NULL,
    device_name   TEXT NOT NULL,
    client        TEXT NOT NULL DEFAULT '',
    platform      TEXT NOT NULL DEFAULT '',
    app_ref       INTEGER REFERENCES apps(id),
    app_name      TEXT,
    token_plain   TEXT,                       -- the device token, only until the device has it
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    claimed_at    TEXT,
    delivered_at  TEXT,
    cancelled_at  TEXT
  );
  CREATE INDEX pairings_code ON pairings(code, status);

  CREATE TABLE packages (
    id            TEXT PRIMARY KEY,           -- package_id: a server UUID
    device_ref    INTEGER NOT NULL REFERENCES devices(id),
    app_ref       INTEGER NOT NULL REFERENCES apps(id),
    title         TEXT NOT NULL,
    app_name      TEXT NOT NULL,              -- source.app from the manifest
    item_count    INTEGER NOT NULL,
    total_bytes   INTEGER NOT NULL,
    manifest      TEXT NOT NULL,              -- JSON exactly as the device will get it
    status        TEXT NOT NULL,              -- uploading | waiting | imported | partial | failed | expired | deleted
    ack           TEXT,                       -- JSON of the last ack
    created_at    TEXT NOT NULL,
    committed_at  TEXT,
    acked_at      TEXT,
    expires_at    TEXT NOT NULL,              -- created_at + PACKAGE_TTL_HOURS
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX packages_inbox ON packages(device_ref, status);
  CREATE INDEX packages_app ON packages(app_ref);

  CREATE TABLE files (
    package_id    TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    file          TEXT NOT NULL,              -- exactly as in the manifest
    bytes         INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    received      INTEGER NOT NULL DEFAULT 0, -- 1 when size, checksum and WAV header were right
    PRIMARY KEY (package_id, file)
  );
  `,
];

// Opens (or makes) the database and brings the schema up to date.
function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'la2l.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const done = db.prepare('PRAGMA user_version').get().user_version;
  if (done > MIGRATIONS.length) {
    db.close();
    throw new Error(`The database is from a newer la2l-server (schema ${done}, this one knows ${MIGRATIONS.length}). Update the server.`);
  }
  for (let step = done; step < MIGRATIONS.length; step++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[step]);
      db.exec(`PRAGMA user_version = ${step + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw e;
    }
  }
  return db;
}

// The queries. Prepared statements are made once and kept.
class Store {
  constructor(db) {
    this.db = db;
    this.cache = new Map();
  }

  sql(text) {
    let s = this.cache.get(text);
    if (!s) {
      s = this.db.prepare(text);
      this.cache.set(text, s);
    }
    return s;
  }

  // Runs fn() in one transaction and returns what it returns. fn must not await.
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  ping() {
    return this.sql('SELECT 1 AS ok').get().ok === 1;
  }

  close() {
    this.db.close();
  }

  // ---- devices ----

  deviceByToken(hash) {
    return this.sql('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(hash);
  }

  deviceById(id) {
    return this.sql('SELECT * FROM devices WHERE id = ?').get(id);
  }

  activeDevicesFor(deviceId) {
    return this.sql('SELECT id FROM devices WHERE device_id = ? AND revoked_at IS NULL').all(deviceId);
  }

  createDevice(d, now) {
    return Number(
      this.sql('INSERT INTO devices (device_id, name, client, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        d.deviceId,
        d.name,
        d.client,
        d.platform,
        d.tokenHash,
        now
      ).lastInsertRowid
    );
  }

  updateDeviceInfo(id, d) {
    this.sql('UPDATE devices SET name = ?, client = ?, platform = ? WHERE id = ?').run(d.name, d.client, d.platform, id);
  }

  // Revokes the device and every app of it. Returns the number of apps revoked.
  revokeDevice(id, now) {
    this.sql('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
    return Number(this.sql('UPDATE apps SET revoked_at = ? WHERE device_ref = ? AND revoked_at IS NULL').run(now, id).changes);
  }

  // Revokes a device and its apps, and deletes its packages that still have files (in the
  // database; the caller deletes their folders after the transaction). Returns
  // { apps, packageIds }.
  revokeDeviceAndPackages(id, now) {
    const packageIds = this.openPackagesOf(id).map((p) => p.id);
    for (const packageId of packageIds) this.deletePackage(packageId);
    return { apps: this.revokeDevice(id, now), packageIds };
  }

  // last_seen_at, written at most once a minute per device.
  touchDevice(id, now, notSince) {
    this.sql('UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(now, id, notSince);
  }

  // ---- apps ----

  // An active app of an active device, with the name of that device.
  appByToken(hash) {
    return this.sql(
      `SELECT a.*, d.name AS device_name FROM apps a JOIN devices d ON d.id = a.device_ref
       WHERE a.token_hash = ? AND a.revoked_at IS NULL AND d.revoked_at IS NULL`
    ).get(hash);
  }

  // Whether an app and its computer are still paired.
  isActiveApp(id) {
    return !!this.sql(
      'SELECT 1 AS x FROM apps a JOIN devices d ON d.id = a.device_ref WHERE a.id = ? AND a.revoked_at IS NULL AND d.revoked_at IS NULL'
    ).get(id);
  }

  createApp(a, now) {
    return Number(
      this.sql('INSERT INTO apps (device_ref, name, app_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
        a.deviceRef,
        a.name,
        a.appId,
        a.tokenHash,
        now
      ).lastInsertRowid
    );
  }

  revokeApp(id, now) {
    this.sql('UPDATE apps SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
  }

  // Pairing again with the same app_id replaces the old token of that app.
  revokeAppsWithAppId(deviceRef, appId, now) {
    return Number(
      this.sql('UPDATE apps SET revoked_at = ? WHERE device_ref = ? AND app_id = ? AND revoked_at IS NULL').run(now, deviceRef, appId).changes
    );
  }

  touchApp(id, now, notSince) {
    this.sql('UPDATE apps SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(now, id, notSince);
  }

  // ---- pairings ----

  codeTaken(code, now) {
    return !!this.sql("SELECT 1 FROM pairings WHERE code = ? AND status = 'waiting' AND expires_at > ? LIMIT 1").get(code, now);
  }

  cancelWaitingFor(deviceId, now) {
    return Number(
      this.sql("UPDATE pairings SET status = 'cancelled', cancelled_at = ? WHERE device_id = ? AND status = 'waiting'").run(now, deviceId).changes
    );
  }

  createPairing(p, now) {
    this.sql(
      `INSERT INTO pairings (pair_hash, code, status, device_ref, device_id, device_name, client, platform, token_plain, created_at, expires_at)
       VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(p.pairHash, p.code, p.deviceRef, p.deviceId, p.deviceName, p.client, p.platform, p.tokenPlain, now, p.expiresAt);
  }

  pairingByHash(hash) {
    return this.sql('SELECT * FROM pairings WHERE pair_hash = ?').get(hash);
  }

  waitingPairing(code, now) {
    return this.sql("SELECT * FROM pairings WHERE code = ? AND status = 'waiting' AND expires_at > ? ORDER BY id DESC LIMIT 1").get(code, now);
  }

  markPaired(id, p, now) {
    this.sql(
      "UPDATE pairings SET status = 'paired', device_ref = ?, new_device = ?, app_ref = ?, app_name = ?, token_plain = ?, claimed_at = ? WHERE id = ?"
    ).run(p.deviceRef, p.newDevice ? 1 : 0, p.appRef, p.appName, p.tokenPlain, now, id);
  }

  markDelivered(id, now) {
    this.sql('UPDATE pairings SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(now, id);
  }

  cancelPairing(id, now) {
    this.sql("UPDATE pairings SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'waiting'").run(now, id);
  }

  deletePairing(id) {
    this.sql('DELETE FROM pairings WHERE id = ?').run(id);
  }

  // ---- packages ----

  // p: { id, deviceRef, appRef, title, appName, itemCount, totalBytes, manifest, expiresAt }.
  // files: [{ file, bytes, sha256 }].
  createPackage(p, files, now) {
    this.sql(
      `INSERT INTO packages (id, device_ref, app_ref, title, app_name, item_count, total_bytes, manifest, status, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`
    ).run(p.id, p.deviceRef, p.appRef, p.title, p.appName, p.itemCount, p.totalBytes, p.manifest, now, p.expiresAt, now);
    const add = this.sql('INSERT INTO files (package_id, file, bytes, sha256) VALUES (?, ?, ?, ?)');
    for (const f of files) add.run(p.id, f.file, f.bytes, f.sha256);
  }

  // A package of this app, or of this device. Someone else's package is not there for them.
  packageOfApp(id, appRef) {
    return this.sql('SELECT * FROM packages WHERE id = ? AND app_ref = ?').get(id, appRef);
  }

  packageOfDevice(id, deviceRef) {
    return this.sql('SELECT * FROM packages WHERE id = ? AND device_ref = ?').get(id, deviceRef);
  }

  fileOf(packageId, file) {
    return this.sql('SELECT * FROM files WHERE package_id = ? AND file = ?').get(packageId, file);
  }

  // The files of a package that have not arrived yet, in manifest order.
  missingFiles(packageId) {
    return this.sql('SELECT file FROM files WHERE package_id = ? AND received = 0 ORDER BY rowid').all(packageId).map((r) => r.file);
  }

  markReceived(packageId, file) {
    this.sql('UPDATE files SET received = 1 WHERE package_id = ? AND file = ?').run(packageId, file);
  }

  commitPackage(id, now) {
    this.sql("UPDATE packages SET status = 'waiting', committed_at = ?, updated_at = ? WHERE id = ? AND status = 'uploading'").run(now, now, id);
  }

  // A failed ack: the package keeps its files and stays in the inbox.
  markFailed(id, ack, now) {
    this.sql("UPDATE packages SET status = 'failed', ack = ?, acked_at = ?, updated_at = ? WHERE id = ?").run(ack, now, now, id);
  }

  // imported, partial, expired or deleted: the files go, and with them the manifest, which only
  // the device needed. The row stays for the status call. ack: the new ack JSON, or null to
  // keep the one there is.
  markDone(id, status, ack, now) {
    if (ack !== null) {
      this.sql("UPDATE packages SET status = ?, ack = ?, acked_at = ?, manifest = '', updated_at = ? WHERE id = ?").run(status, ack, now, now, id);
    } else {
      this.sql("UPDATE packages SET status = ?, manifest = '', updated_at = ? WHERE id = ?").run(status, now, id);
    }
    this.sql('DELETE FROM files WHERE package_id = ?').run(id);
  }

  // What the device's Import gets: waiting and failed packages that have not expired, oldest first.
  inbox(deviceRef, now) {
    return this.sql(
      `SELECT id, title, app_name, item_count, committed_at FROM packages
       WHERE device_ref = ? AND status IN ('waiting', 'failed') AND expires_at > ?
       ORDER BY committed_at, id`
    ).all(deviceRef, now);
  }

  // Packages of a device that still have files: uploading, waiting or failed.
  openPackagesOf(deviceRef) {
    return this.sql("SELECT id FROM packages WHERE device_ref = ? AND status IN ('uploading', 'waiting', 'failed')").all(deviceRef);
  }

  // The bytes kept for a device: its packages that have, or will soon have, files on disk.
  bytesFor(deviceRef) {
    return this.sql(
      "SELECT COALESCE(SUM(total_bytes), 0) AS n FROM packages WHERE device_ref = ? AND status IN ('uploading', 'waiting', 'failed')"
    ).get(deviceRef).n;
  }

  // The bytes still to come for uploads that have started: disk space that is spoken for.
  bytesComing() {
    return this.sql(
      `SELECT COALESCE(SUM(f.bytes), 0) AS n FROM files f JOIN packages p ON p.id = f.package_id
       WHERE p.status = 'uploading' AND f.received = 0`
    ).get().n;
  }

  deletePackage(id) {
    this.sql('DELETE FROM packages WHERE id = ?').run(id);
  }

  // ---- cleanup (BUILD-PROMPT.md section 9) ----

  // Pairings that are done with: waiting ones some time past their end, cancelled ones some time
  // after the cancel, paired ones some time after the device got its token.
  deleteOldPairings(expiredBefore, cancelledBefore, deliveredBefore) {
    return Number(
      this.sql(
        `DELETE FROM pairings WHERE (status = 'waiting' AND expires_at <= ?)
           OR (status = 'cancelled' AND cancelled_at <= ?)
           OR (status = 'paired' AND delivered_at IS NOT NULL AND delivered_at <= ?)`
      ).run(expiredBefore, cancelledBefore, deliveredBefore).changes
    );
  }

  // Claims whose device never came for its token.
  undeliveredClaims(claimedBefore) {
    return this.sql("SELECT id, device_ref, new_device FROM pairings WHERE status = 'paired' AND delivered_at IS NULL AND claimed_at <= ?").all(
      claimedBefore
    );
  }

  // A device row with everything that hangs on it: its packages, pairings and apps. Returns the
  // ids of the packages, whose folders the caller deletes after the transaction.
  deleteDevice(id) {
    const packageIds = this.sql('SELECT id FROM packages WHERE device_ref = ?').all(id).map((r) => r.id);
    this.sql('DELETE FROM packages WHERE device_ref = ?').run(id);
    this.sql('DELETE FROM pairings WHERE device_ref = ? OR app_ref IN (SELECT id FROM apps WHERE device_ref = ?)').run(id, id);
    this.sql('DELETE FROM apps WHERE device_ref = ?').run(id);
    this.sql('DELETE FROM devices WHERE id = ?').run(id);
    return packageIds;
  }

  // Uploads that were not committed in time.
  staleUploads(createdBefore) {
    return this.sql("SELECT id FROM packages WHERE status = 'uploading' AND created_at <= ?").all(createdBefore).map((r) => r.id);
  }

  // Waiting and failed packages past their end.
  expiredPackages(now) {
    return this.sql("SELECT id FROM packages WHERE status IN ('waiting', 'failed') AND expires_at <= ?").all(now).map((r) => r.id);
  }

  // Results the app has had long enough to read.
  deleteOldResults(updatedBefore) {
    return Number(
      this.sql("DELETE FROM packages WHERE status IN ('imported', 'partial', 'expired', 'deleted') AND updated_at <= ?").run(updatedBefore).changes
    );
  }

  // Revoked apps and devices some time after the revoke, once nothing refers to them any more.
  // Apps go first, so a device whose apps went in this run can go too.
  deleteOldRevoked(revokedBefore) {
    const apps = Number(
      this.sql(
        `DELETE FROM apps WHERE revoked_at IS NOT NULL AND revoked_at <= ?
           AND NOT EXISTS (SELECT 1 FROM packages WHERE app_ref = apps.id)
           AND NOT EXISTS (SELECT 1 FROM pairings WHERE app_ref = apps.id)`
      ).run(revokedBefore).changes
    );
    const devices = Number(
      this.sql(
        `DELETE FROM devices WHERE revoked_at IS NOT NULL AND revoked_at <= ?
           AND NOT EXISTS (SELECT 1 FROM packages WHERE device_ref = devices.id)
           AND NOT EXISTS (SELECT 1 FROM apps WHERE device_ref = devices.id)
           AND NOT EXISTS (SELECT 1 FROM pairings WHERE device_ref = devices.id)`
      ).run(revokedBefore).changes
    );
    return { apps, devices };
  }

  // What the server holds, for the log line at start.
  state() {
    const n = (text) => this.sql(text).get().n;
    return {
      devices: n('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL'),
      apps: n('SELECT COUNT(*) AS n FROM apps WHERE revoked_at IS NULL'),
      waiting: n("SELECT COUNT(*) AS n FROM packages WHERE status IN ('waiting', 'failed')"),
    };
  }

  // The packages that have a folder on disk.
  packagesWithFiles() {
    return this.sql("SELECT id FROM packages WHERE status IN ('uploading', 'waiting', 'failed')").all().map((r) => r.id);
  }
}

module.exports = { openDb, Store, MIGRATIONS };
