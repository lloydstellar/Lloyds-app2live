'use strict';
// The App2Live manifest (docs/manifest.md). Checks a package description from an app and works
// out how each sound goes into Live: warp on or off, warp mode, tempo and loop length.
// The app only says what a sound is (loop or one-shot, drums or vocal); the device picks the Live settings.

const { SCHEMA } = require('./version');
const { cleanName, megabytes } = require('./text');

const LIMITS = {
  maxItems: 32,
  maxPackageBytes: 200 * 1048576,
};

const ROLES = ['drums', 'bass', 'melodic', 'vocal', 'texture', 'fx'];

// Live's warp modes (Clip.warp_mode). 5 is REX, which only REX files use.
const WARP_MODES = { beats: 0, tones: 1, texture: 2, repitch: 3, complex: 4, complexpro: 6 };
const MODE_NAMES = { 0: 'Beats', 1: 'Tones', 2: 'Texture', 3: 'Re-Pitch', 4: 'Complex', 6: 'Complex Pro' };

// Role -> warp mode. Complex Pro sounds best on mixed material but costs the most CPU,
// so only melodic parts and vocals get it.
const ROLE_MODES = { drums: 0, bass: 1, melodic: 6, vocal: 6, texture: 2, fx: 4 };
const DEFAULT_MODE = 4; // Complex, for fx and sounds without a role

// Colours close to Live's palette. Live picks the nearest colour of its own palette anyway.
const PALETTE = ['#FF94A6', '#FFA529', '#F7F47C', '#BFFB00', '#1AFF2F', '#5CFFE8', '#8BC5FF', '#5480E4', '#D86CE4', '#E553A0'];

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseColor(v) {
  if (typeof v !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? parseInt(m[1], 16) : null;
}

function paletteColor(index) {
  return parseColor(PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]);
}

function parseWarpMode(v) {
  if (typeof v === 'number') return [0, 1, 2, 3, 4, 6].includes(v) ? v : null;
  if (typeof v !== 'string') return null;
  const key = v.toLowerCase().replace(/[\s_-]/g, '');
  return key in WARP_MODES ? WARP_MODES[key] : null;
}

function parseKind(v) {
  const k = typeof v === 'string' ? v.toLowerCase().replace(/[\s_-]/g, '') : '';
  if (k === 'loop') return 'loop';
  if (k === 'oneshot') return 'oneshot';
  return null;
}

// A file name as the server knows it. Used only to build the download address; the file on
// disk gets a name made from the sound's name.
function validFile(v) {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(v) && /\.wav$/i.test(v) && !v.includes('..');
}

// Checks a manifest and returns { pkg, warnings }. Problems with the whole package throw a
// ManifestError. A problem with one sound only marks that sound (item.error), the rest still goes in.
function validate(raw) {
  const warnings = [];
  if (!isObject(raw)) throw new ManifestError('The package description is not valid.');
  if (typeof raw.schema !== 'string') throw new ManifestError('This is not an App2Live package.');
  if (raw.schema !== SCHEMA) {
    if (/^app2live\/\d+$/.test(raw.schema)) throw new ManifestError(`This package uses ${raw.schema}. Update LA2L to import it.`);
    throw new ManifestError('This is not an App2Live package.');
  }
  if (typeof raw.package_id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(raw.package_id)) {
    throw new ManifestError('The package has no valid package_id.');
  }
  const source = isObject(raw.source) ? raw.source : {};
  const tempo = isObject(raw.tempo) ? raw.tempo : {};
  const pkg = {
    packageId: raw.package_id,
    title: cleanName(raw.title, 'Untitled', 60),
    app: cleanName(source.app, 'App', 40),
    appVersion: typeof source.app_version === 'string' ? source.app_version.slice(0, 40) : '',
    platform: typeof source.platform === 'string' ? source.platform.slice(0, 40) : '',
    createdAt: typeof raw.created_at === 'string' ? raw.created_at.slice(0, 40) : '',
    bpm: null,
    timeSignature: null,
    items: [],
    midiCount: Array.isArray(raw.midi) ? raw.midi.length : 0,
  };
  if (!raw.title) warnings.push('no title');
  if (!source.app) warnings.push('no source.app');
  if (tempo.bpm !== undefined) {
    const b = num(tempo.bpm);
    if (b !== null && b >= 20 && b <= 999) pkg.bpm = b;
    else warnings.push('tempo.bpm is not a number from 20 to 999');
  }
  const ts = tempo.time_signature;
  if (Array.isArray(ts) && ts.length === 2 && Number.isInteger(ts[0]) && Number.isInteger(ts[1])) pkg.timeSignature = ts;
  if (pkg.midiCount) warnings.push(`${pkg.midiCount} MIDI parts ignored (MIDI comes in a later version)`);

  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new ManifestError('The package has no sounds.');
  if (raw.items.length > LIMITS.maxItems) {
    throw new ManifestError(`The package has ${raw.items.length} sounds. LA2L takes ${LIMITS.maxItems} at most.`);
  }

  const files = new Set();
  let total = 0;
  raw.items.forEach((it, index) => {
    const item = {
      index,
      id: '',
      file: '',
      sha256: null,
      bytes: null,
      name: `Sound ${index + 1}`,
      kind: 'oneshot',
      role: null,
      lengthBeats: null,
      warpMode: null,
      bpm: null,
      color: null,
      gainDb: null,
      error: null,
    };
    pkg.items.push(item);
    if (!isObject(it)) {
      item.error = 'is not described correctly';
      return;
    }
    item.id = typeof it.id === 'string' && it.id ? it.id.slice(0, 100) : String(index + 1);
    item.name = cleanName(it.name, `Sound ${index + 1}`, 40);
    if (!validFile(it.file)) {
      item.error = 'has no valid file name';
      return;
    }
    if (files.has(it.file.toLowerCase())) {
      item.error = 'uses the same file as another sound';
      return;
    }
    files.add(it.file.toLowerCase());
    item.file = it.file;

    if (typeof it.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(it.sha256)) item.sha256 = it.sha256.toLowerCase();
    else if (it.sha256 !== undefined) warnings.push(`${item.name}: sha256 ignored`);
    if (Number.isInteger(it.bytes) && it.bytes > 0) {
      item.bytes = it.bytes;
      total += it.bytes;
    } else if (it.bytes !== undefined) warnings.push(`${item.name}: bytes ignored`);

    const kind = parseKind(it.kind);
    if (kind) item.kind = kind;
    else warnings.push(`${item.name}: kind "${it.kind}" unknown, placed as one-shot`);

    if (typeof it.role === 'string' && ROLES.includes(it.role.toLowerCase())) item.role = it.role.toLowerCase();
    else if (it.role !== undefined) warnings.push(`${item.name}: role "${it.role}" unknown`);

    if (it.length_beats !== undefined) {
      const l = num(it.length_beats);
      if (l !== null && l > 0 && l <= 4096) item.lengthBeats = l;
      else warnings.push(`${item.name}: length_beats ignored`);
    }
    if (it.warp_mode !== undefined) {
      item.warpMode = parseWarpMode(it.warp_mode);
      if (item.warpMode === null) warnings.push(`${item.name}: warp_mode "${it.warp_mode}" unknown`);
    }
    if (it.bpm !== undefined) {
      const b = num(it.bpm);
      if (b !== null && b >= 20 && b <= 999) item.bpm = b;
      else warnings.push(`${item.name}: bpm ignored`);
    }
    if (it.color !== undefined) {
      item.color = parseColor(it.color);
      if (item.color === null) warnings.push(`${item.name}: color ignored`);
    }
    if (it.gain_db !== undefined) {
      const g = num(it.gain_db);
      if (g !== null) item.gainDb = Math.max(-70, Math.min(24, g));
      else warnings.push(`${item.name}: gain_db ignored`);
    }
  });
  if (total > LIMITS.maxPackageBytes) {
    throw new ManifestError(`The package is ${megabytes(total)}. LA2L takes ${megabytes(LIMITS.maxPackageBytes)} at most.`);
  }
  return { pkg, warnings };
}

// A loop that is within 0.1 beat of a whole number of beats was meant to be that long.
function snapBeats(raw) {
  const whole = Math.round(raw);
  if (whole >= 1 && Math.abs(raw - whole) <= 0.1) return whole;
  return Math.round(raw * 1000) / 1000;
}

// How one sound goes into Live, given its length in seconds (from the WAV header).
//   one-shot: warp off, loop off. It plays exactly as the app made it.
//   loop: warp on, warp mode from the role, the tempo of the package, looped over its length.
function planItem(item, pkg, duration) {
  if (item.kind !== 'loop') {
    return { warp: false, looping: false, warpMode: null, bpm: null, lengthBeats: null };
  }
  const warpMode = item.warpMode !== null ? item.warpMode : item.role ? ROLE_MODES[item.role] : DEFAULT_MODE;
  let bpm = item.bpm || pkg.bpm || null;
  let lengthBeats = item.lengthBeats || null;
  if (!bpm && lengthBeats && duration > 0) bpm = (60 * lengthBeats) / duration;
  if (bpm && (bpm < 5 || bpm > 999)) bpm = null;
  if (bpm && !lengthBeats && duration > 0) lengthBeats = snapBeats((duration * bpm) / 60);
  return { warp: true, looping: true, warpMode, bpm, lengthBeats };
}

function trackName(item, pkg, settings) {
  return settings.appNameInTrackName ? `${item.name} (${pkg.app})` : item.name;
}

function sceneName(pkg) {
  return `${pkg.title} (${pkg.app})`;
}

// The package that Test import places: one sound from the test address in the settings.
function testManifest(settings) {
  return {
    schema: SCHEMA,
    package_id: 'la2l-test-' + Date.now(),
    created_at: new Date().toISOString(),
    title: 'Test import',
    source: { app: 'LA2L', platform: 'test' },
    tempo: { bpm: settings.testBpm },
    items: [{ id: 'test', file: 'test.wav', name: settings.testName, kind: settings.testKind, role: settings.testRole }],
  };
}

module.exports = {
  LIMITS,
  ROLES,
  ROLE_MODES,
  MODE_NAMES,
  PALETTE,
  ManifestError,
  validate,
  planItem,
  snapBeats,
  parseColor,
  paletteColor,
  parseWarpMode,
  trackName,
  sceneName,
  testManifest,
};
