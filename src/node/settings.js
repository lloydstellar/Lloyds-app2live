'use strict';
// Settings, pairing state and the log, kept per computer in Documents/Lloyds App2Live.
// They live outside the Live Set (the token must never travel with a shared Set) and outside
// the device folder (a frozen device runs from a temporary folder that is gone after a restart).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { VERSION, FOLDER_NAME } = require('./version');

const DEFAULT_SETTINGS = {
  // The App2Live server. Only https, except localhost for testing.
  serverUrl: 'https://lloydstellar.nl/la2l/api',
  // Where new sounds go: 'arrangement' (at the playhead) or 'session' (a new scene).
  placement: 'arrangement',
  // Where new tracks go: 'afterDevice' (right after the track with this device) or 'end'.
  newTracks: 'afterDevice',
  // "Kick (Web808)" instead of "Kick".
  appNameInTrackName: true,
  // Test import: one file from a plain web address, no pairing and no server needed.
  testUrl: 'http://lloydstellar.nl/test/test-file-voor-max.wav',
  testName: 'Snare',
  testBpm: 135,
  testKind: 'loop',
  testRole: 'drums',
};

const CHOICES = {
  placement: ['arrangement', 'session'],
  newTracks: ['afterDevice', 'end'],
  testKind: ['loop', 'oneshot'],
};

const LOG_MAX_BYTES = 1e6;
const IMPORTED_KEEP = 200; // package ids remembered, so a package is never placed twice

function defaultHome() {
  if (process.env.LA2L_HOME) return process.env.LA2L_HOME;
  return path.join(os.homedir(), 'Documents', FOLDER_NAME);
}

function freshData() {
  return {
    version: VERSION,
    deviceId: '',
    settings: Object.assign({}, DEFAULT_SETTINGS),
    pairing: null, // { token, apps: ['Web808'], pairedAt }
    colorIndex: 0,
    imported: [], // [{ id, at }]
  };
}

// Keeps only known settings with valid values, so a hand-edited file cannot break the device.
function cleanSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return s;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    const def = DEFAULT_SETTINGS[key];
    if (CHOICES[key]) {
      if (CHOICES[key].includes(v)) s[key] = v;
    } else if (typeof def === 'boolean') {
      s[key] = v === true || v === 1 || v === 'true';
    } else if (typeof def === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) s[key] = n;
    } else if (typeof v === 'string' && v.trim()) {
      s[key] = v.trim();
    }
  }
  if (!(s.testBpm >= 20 && s.testBpm <= 999)) s.testBpm = DEFAULT_SETTINGS.testBpm;
  return s;
}

class Store {
  constructor(home) {
    this.home = home || defaultHome();
    this.data = freshData();
    this.load();
    if (!this.data.deviceId) {
      this.data.deviceId = crypto.randomUUID();
      this.save();
    }
  }

  file() {
    return path.join(this.home, 'settings.json');
  }

  get settings() {
    return this.data.settings;
  }

  get pairing() {
    return this.data.pairing;
  }

  // Reads the file again. Two copies of the device (or two Live Sets one after the other)
  // share this file, so every change starts from what is on disk now.
  load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
    } catch (e) {
      return false; // first start, or a broken file: keep what we have
    }
    const d = freshData();
    if (typeof raw.deviceId === 'string') d.deviceId = raw.deviceId;
    d.settings = cleanSettings(raw.settings);
    const p = raw.pairing;
    if (p && typeof p.token === 'string' && p.token) {
      d.pairing = {
        token: p.token,
        apps: Array.isArray(p.apps) ? p.apps.filter((a) => typeof a === 'string').slice(0, 50) : [],
        pairedAt: typeof p.pairedAt === 'string' ? p.pairedAt : '',
      };
    }
    if (Number.isInteger(raw.colorIndex) && raw.colorIndex >= 0) d.colorIndex = raw.colorIndex;
    if (Array.isArray(raw.imported)) {
      d.imported = raw.imported.filter((x) => x && typeof x.id === 'string').slice(-IMPORTED_KEEP);
    }
    this.data = d;
    return true;
  }

  save() {
    fs.mkdirSync(this.home, { recursive: true });
    const text = JSON.stringify(Object.assign({}, this.data, { version: VERSION }), null, 2);
    const tmp = this.file() + '.tmp';
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, this.file());
    } catch (e) {
      // A virus scanner can hold the file for a moment on Windows: write it directly then.
      fs.writeFileSync(this.file(), text);
      try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
    }
  }

  // Load, change, save. fn gets the data object and may change it.
  update(fn) {
    this.load();
    fn(this.data);
    this.save();
    return this.data;
  }

  wasImported(packageId) {
    return this.data.imported.some((x) => x.id === packageId);
  }

  markImported(packageId) {
    this.update((d) => {
      if (!d.imported.some((x) => x.id === packageId)) d.imported.push({ id: packageId, at: new Date().toISOString() });
      d.imported = d.imported.slice(-IMPORTED_KEEP);
    });
  }

  // A colour for the next package, so the tracks of one package share a colour.
  nextColorIndex() {
    let index = 0;
    this.update((d) => {
      index = d.colorIndex;
      d.colorIndex = d.colorIndex + 1;
    });
    return index;
  }
}

// The log: Documents/Lloyds App2Live/la2l.log, renamed to la2l.log.old at 1 MB.
class Log {
  constructor(home, echo) {
    this.home = home || defaultHome();
    this.echo = echo || null;
  }

  file() {
    return path.join(this.home, 'la2l.log');
  }

  write(line) {
    const text = String(line);
    try {
      fs.mkdirSync(this.home, { recursive: true });
      const file = this.file();
      try {
        if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.old');
      } catch (e) { /* no log yet */ }
      fs.appendFileSync(file, new Date().toISOString() + ' ' + text.replace(/\r?\n/g, '\r\n    ') + '\r\n');
    } catch (e) { /* logging must never break the device */ }
    if (this.echo) {
      try { this.echo(text); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { Store, Log, DEFAULT_SETTINGS, defaultHome, cleanSettings, LOG_MAX_BYTES };
