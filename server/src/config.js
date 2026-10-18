'use strict';
// The settings of the server. They come from environment variables (see .env.example), are read
// once at start, and a bad value stops the server with a message that names the variable.
// Inside the server every time is in milliseconds and every size in bytes.

const path = require('path');
const { version } = require('../package.json');

const DEFAULTS = {
  PORT: '8787',
  HOST: '0.0.0.0',
  DATA_DIR: '/data',
  MAVEN_DIR: '/maven',
  PUBLIC_URL: 'https://lloydstellar.nl/la2l',
  TRUST_PROXY: '1',
  PAIR_TTL_SECONDS: '600',
  POLL_MS: '2000',
  PACKAGE_TTL_HOURS: '24',
  UPLOAD_TTL_MINUTES: '60',
  RESULT_TTL_DAYS: '7',
  MAX_DEVICE_STORAGE_MB: '1024',
  MAX_ADDRESS_STORAGE_MB: '2048',
  MAX_TOTAL_STORAGE_MB: '10240',
  STORAGE_WARN_PERCENT: '80',
  MIN_FREE_DISK_MB: '2048',
  RATE_LIMITS: 'on',
};

const MB = 1048576;

function loadConfig(env = process.env) {
  const get = (name) => {
    const v = env[name];
    return v === undefined || String(v).trim() === '' ? DEFAULTS[name] : String(v).trim();
  };
  const bad = (name, what) => new Error(`${name} must be ${what}, not "${get(name)}".`);

  // A whole number from min to max.
  const int = (name, min, max) => {
    const v = get(name);
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw bad(name, `a whole number from ${min} to ${max}`);
    return Number(v);
  };
  // A number above 0 and at most max; decimals are fine (PACKAGE_TTL_HOURS=0.5 is half an hour).
  const positive = (name, max) => {
    const v = get(name);
    if (!/^\d+(\.\d+)?$/.test(v) || !(Number(v) > 0) || Number(v) > max) throw bad(name, `a number above 0 and at most ${max}`);
    return Number(v);
  };
  const choice = (name, values) => {
    const v = get(name).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(values, v)) throw bad(name, Object.keys(values).join(' or '));
    return values[v];
  };

  const host = get('HOST');
  if (/\s/.test(host)) throw bad('HOST', 'an address without spaces');
  let publicUrl;
  try {
    publicUrl = new URL(get('PUBLIC_URL'));
  } catch (e) {
    throw bad('PUBLIC_URL', 'a web address');
  }
  if (publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') throw bad('PUBLIC_URL', 'an http or https address');

  return {
    version,
    port: int('PORT', 0, 65535),
    host,
    dataDir: path.resolve(get('DATA_DIR')),
    mavenDir: path.resolve(get('MAVEN_DIR')),
    publicUrl: publicUrl.href.replace(/\/+$/, ''),
    trustProxy: choice('TRUST_PROXY', { 0: false, 1: true }),
    // The device counts down from expires_in and keeps it between 30 and 1800 seconds, and polls
    // every 500 to 10000 ms: the same ranges here.
    pairTtlSeconds: int('PAIR_TTL_SECONDS', 30, 1800),
    pollMs: int('POLL_MS', 500, 10000),
    // docs/server-api.md promises 24 hours at most.
    packageTtlMs: positive('PACKAGE_TTL_HOURS', 24) * 3600000,
    uploadTtlMs: positive('UPLOAD_TTL_MINUTES', 1440) * 60000,
    resultTtlMs: positive('RESULT_TTL_DAYS', 365) * 86400000,
    maxDeviceStorageBytes: int('MAX_DEVICE_STORAGE_MB', 1, 1000000) * MB,
    maxAddressStorageBytes: int('MAX_ADDRESS_STORAGE_MB', 1, 1000000) * MB,
    maxTotalStorageBytes: int('MAX_TOTAL_STORAGE_MB', 1, 10000000) * MB,
    storageWarnPercent: int('STORAGE_WARN_PERCENT', 1, 100),
    minFreeDiskBytes: int('MIN_FREE_DISK_MB', 0, 1000000) * MB,
    rateLimits: choice('RATE_LIMITS', { on: true, off: false }),
    // Not a setting: how long the WAV check of an upload may take (tests make it short).
    wavCheckMs: 10000,
  };
}

module.exports = { loadConfig, DEFAULTS };
