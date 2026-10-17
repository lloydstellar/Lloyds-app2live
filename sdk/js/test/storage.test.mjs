// Where the token is kept in Node.js: a file only the user can read, in the user's config folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('a file of mode 0600 in a folder of mode 0700, one per app', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-config-'));
  try {
    const script = `
      import { LA2L } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
      const a = new LA2L({ appName: 'Web 808!' });
      const b = new LA2L({ appName: 'Other App' });
      console.log(JSON.stringify({ a: a.appId, b: b.appId, again: new LA2L({ appName: 'Web 808!' }).appId }));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: Object.assign({}, process.env, { LA2L_CONFIG_DIR: path.join(dir, 'la2l') }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const ids = JSON.parse(r.stdout);
    assert.equal(ids.a, ids.again, 'the app id is kept');
    assert.notEqual(ids.a, ids.b);
    const files = fs.readdirSync(path.join(dir, 'la2l')).sort();
    assert.equal(files.length, 2);
    assert.match(files[0], /^other-app-[0-9a-f]{8}\.json$/);
    assert.match(files[1], /^web-808-[0-9a-f]{8}\.json$/);
    assert.equal(fs.statSync(path.join(dir, 'la2l')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'la2l', files[1])).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'la2l', files[1]), 'utf8'))), ['appId']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a config folder that cannot be written: the pairing lives in memory, with one warning', { skip: process.platform === 'win32' || process.getuid() === 0 ? 'needs a user that file modes stop' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-readonly-'));
  try {
    fs.chmodSync(dir, 0o500);
    const script = `
      import { LA2L, memoryStorage } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
      const a = new LA2L({ appName: 'Web808' });
      console.log(JSON.stringify({ id: a.appId, paired: a.paired }));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: Object.assign({}, process.env, { LA2L_CONFIG_DIR: path.join(dir, 'la2l') }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).id, /^[0-9a-f-]{36}$/);
    assert.match(r.stderr, /^la2l: cannot write .*web808\.json \(EACCES\)\. The pairing is kept in memory only, until this program ends\.\n$/);
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
