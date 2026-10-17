'use strict';
// Writes a copy of the database to stdout, and one line about it to stderr. deploy/backup.sh runs
// this in a container of the server's image, with the server's volume at /data, so it works
// whether the server runs or not. VACUUM INTO makes a consistent copy while the server keeps
// running, and leaves out what was deleted but still sits in the database file.

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SOURCE = '/data/la2l.db';
const copy = `/tmp/la2l-backup-${process.pid}.db`;

try {
  if (!fs.existsSync(SOURCE)) throw new Error('there is no database yet');
  const db = new DatabaseSync(SOURCE, { readOnly: true, timeout: 5000 });
  db.exec(`VACUUM INTO '${copy}'`);
  db.close();
  const check = new DatabaseSync(copy, { readOnly: true });
  const result = check.prepare('PRAGMA integrity_check').get().integrity_check;
  if (result !== 'ok') throw new Error(`the copy is damaged: ${result}`);
  const n = (table) => check.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE revoked_at IS NULL`).get().n;
  const summary = `${n('devices')} computer(s) and ${n('apps')} app(s) paired, schema ${check.prepare('PRAGMA user_version').get().user_version}`;
  check.close();
  process.stdout.write(fs.readFileSync(copy));
  process.stderr.write(summary + '\n');
} catch (e) {
  process.stderr.write(`The database could not be copied: ${e.message}.\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(copy, { force: true });
}
