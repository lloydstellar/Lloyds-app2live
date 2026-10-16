'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadConfig, DEFAULTS } = require('../src/config');

const MB = 1048576;

test('defaults', () => {
  const c = loadConfig({});
  assert.equal(c.version, require('../package.json').version);
  assert.equal(c.port, 8787);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.dataDir, '/data');
  assert.equal(c.publicUrl, 'https://lloydstellar.nl/la2l');
  assert.equal(c.trustProxy, true);
  assert.equal(c.pairTtlSeconds, 600);
  assert.equal(c.pollMs, 2000);
  assert.equal(c.packageTtlMs, 24 * 3600000);
  assert.equal(c.uploadTtlMs, 60 * 60000);
  assert.equal(c.resultTtlMs, 7 * 86400000);
  assert.equal(c.maxDeviceStorageBytes, 1024 * MB);
  assert.equal(c.minFreeDiskBytes, 2048 * MB);
  assert.equal(c.rateLimits, true);
  assert.equal(c.wavCheckMs, 10000);
});

test('values are read and converted', () => {
  const c = loadConfig({
    PORT: '0',
    DATA_DIR: 'some/dir',
    PUBLIC_URL: 'https://example.org/la2l/',
    TRUST_PROXY: '0',
    PACKAGE_TTL_HOURS: '0.5',
    RESULT_TTL_DAYS: '1',
    MIN_FREE_DISK_MB: '0',
    RATE_LIMITS: 'OFF',
    POLL_MS: ' ',
  });
  assert.equal(c.port, 0);
  assert.equal(c.dataDir, path.resolve('some/dir'));
  assert.equal(c.publicUrl, 'https://example.org/la2l');
  assert.equal(c.trustProxy, false);
  assert.equal(c.packageTtlMs, 1800000);
  assert.equal(c.resultTtlMs, 86400000);
  assert.equal(c.minFreeDiskBytes, 0);
  assert.equal(c.rateLimits, false);
  assert.equal(c.pollMs, 2000, 'an empty value means the default');
});

test('a bad value stops the start with a message that names it', () => {
  const cases = [
    [{ PORT: 'abc' }, /^PORT must be a whole number from 0 to 65535, not "abc"\.$/],
    [{ PORT: '70000' }, /^PORT must be/],
    [{ HOST: 'a b' }, /^HOST must be/],
    [{ PUBLIC_URL: 'not a url' }, /^PUBLIC_URL must be a web address/],
    [{ PUBLIC_URL: 'ftp://example.org' }, /^PUBLIC_URL must be an http or https address/],
    [{ TRUST_PROXY: 'yes' }, /^TRUST_PROXY must be 0 or 1, not "yes"\.$/],
    [{ PAIR_TTL_SECONDS: '10' }, /^PAIR_TTL_SECONDS must be a whole number from 30 to 1800/],
    [{ POLL_MS: '100' }, /^POLL_MS must be/],
    [{ PACKAGE_TTL_HOURS: '48' }, /^PACKAGE_TTL_HOURS must be a number above 0 and at most 24, not "48"\.$/],
    [{ PACKAGE_TTL_HOURS: '0' }, /^PACKAGE_TTL_HOURS must be/],
    [{ UPLOAD_TTL_MINUTES: '-5' }, /^UPLOAD_TTL_MINUTES must be/],
    [{ MAX_DEVICE_STORAGE_MB: '0' }, /^MAX_DEVICE_STORAGE_MB must be/],
    [{ MIN_FREE_DISK_MB: '1.5' }, /^MIN_FREE_DISK_MB must be/],
    [{ RATE_LIMITS: 'maybe' }, /^RATE_LIMITS must be on or off/],
  ];
  for (const [env, re] of cases) assert.throws(() => loadConfig(env), { message: re }, JSON.stringify(env));
});

test('.env.example lists every setting with its default', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const listed = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) listed[m[1]] = m[2];
  }
  assert.deepEqual(listed, DEFAULTS);
});
