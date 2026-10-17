'use strict';
// Checks a backup that comes in on stdin, before deploy/restore.sh changes anything: it must be a
// database of la2l-server, not damaged, and not from a newer server than the code in this image.
// Prints one line about it. When it cannot be restored, exits with 1 and says why on stderr.

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const TABLES = ['devices', 'apps', 'pairings', 'packages', 'files'];
const file = `/tmp/la2l-check-${process.pid}.db`;

function check() {
  // The schema steps of the server in this image: a newer backup would stop it at start.
  const { MIGRATIONS } = require('/app/server/src/db');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
  } catch (e) {
    throw new Error(`This is not a database (${e.message}).`);
  }
  const result = db.prepare('PRAGMA integrity_check').get().integrity_check;
  if (result !== 'ok') throw new Error(`The backup is damaged: ${result}`);
  const schema = db.prepare('PRAGMA user_version').get().user_version;
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  if (schema < 1 || !TABLES.every((t) => tables.has(t))) throw new Error('This is not a database of la2l-server.');
  if (schema > MIGRATIONS.length) {
    throw new Error(`This backup is from a newer la2l-server (schema ${schema}, this one knows ${MIGRATIONS.length}). Update the server first.`);
  }
  const n = (sql) => db.prepare(sql).get().n;
  const devices = n('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL');
  const apps = n('SELECT COUNT(*) AS n FROM apps WHERE revoked_at IS NULL');
  const waiting = n("SELECT COUNT(*) AS n FROM packages WHERE status IN ('waiting', 'failed')");
  db.close();
  return `${devices} computer(s) and ${apps} app(s) paired, ${waiting} package(s) waiting, schema ${schema}`;
}

try {
  fs.writeFileSync(file, fs.readFileSync(0));
  process.stdout.write(check() + '\n');
} catch (e) {
  process.stderr.write(e.message + '\n');
  process.exitCode = 1;
} finally {
  fs.rmSync(file, { force: true });
}
