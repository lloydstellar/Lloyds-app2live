// The App2Live manifest (docs/manifest.md), checked as the device does it in src/node/manifest.js,
// with the same texts, and as la2l-server does it, which is stricter. sdk/fixtures proves both.

import { cleanName, megabytes } from './text.js';

/** The manifest format this SDK writes and the device reads. */
export const SCHEMA = 'app2live/1';

/** What one package may hold. */
export const LIMITS = {
  maxItems: 32,
  maxPackageBytes: 200 * 1048576,
  /** The largest manifest the server takes, in bytes of JSON. */
  maxManifestBytes: 1048576,
} as const;

export type Kind = 'loop' | 'oneshot';
export type Role = 'drums' | 'bass' | 'melodic' | 'vocal' | 'texture' | 'fx';

export const ROLES: readonly Role[] = ['drums', 'bass', 'melodic', 'vocal', 'texture', 'fx'];

/** Live's warp modes by number (Clip.warp_mode). 5 is REX, which only REX files use. */
export const WARP_MODE_NAMES: Readonly<Record<number, string>> = { 0: 'Beats', 1: 'Tones', 2: 'Texture', 3: 'Re-Pitch', 4: 'Complex', 6: 'Complex Pro' };

const WARP_MODES: Record<string, number> = { beats: 0, tones: 1, texture: 2, repitch: 3, complex: 4, complexpro: 6 };

/** One sound of a package, as the device reads it. */
export interface CheckedSound {
  /** Its position in `items`, from 0. */
  index: number;
  /** The app's id, or the position from 1. Sent back in the ack. */
  id: string;
  file: string;
  sha256: string | null;
  bytes: number | null;
  /** The cleaned name, at most 40 characters. */
  name: string;
  kind: Kind;
  role: Role | null;
  lengthBeats: number | null;
  /** A warp mode the manifest asked for, as Live's number. */
  warpMode: number | null;
  bpm: number | null;
  /** 0xRRGGBB. */
  color: number | null;
  gainDb: number | null;
  /** Why the device skips this sound, in its own words ("has no valid file name"), or null. */
  error: string | null;
}

/** A package as the device reads it. */
export interface CheckedPackage {
  packageId: string;
  title: string;
  /** source.app, added to every track name. */
  app: string;
  appVersion: string;
  platform: string;
  createdAt: string;
  bpm: number | null;
  timeSignature: [number, number] | null;
  items: CheckedSound[];
  midiCount: number;
}

export type ManifestCheck =
  | { ok: true; package: CheckedPackage; warnings: string[] }
  | {
      ok: false;
      /** The text the device or the server gives, for example "The package has no sounds." */
      error: string;
      warnings: string[];
      /** As the server: the status of its answer (400, 413 or 422). Not set as the device. */
      status?: number;
    };

export interface CheckManifestOptions {
  /**
   * `server` (the default): as `POST /packages` judges it, for an app that is about to send.
   * Every sound must be valid and have `bytes` and `sha256`; `package_id` is not needed, because
   * the server gives the package its own. `device`: as LA2L in Live judges a manifest it
   * downloaded. That is more lenient: a sound with a problem is skipped, the rest goes in.
   */
  as?: 'server' | 'device';
}

class ManifestError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// A value from the manifest, quoted in a warning. Short, because apps see the warnings too.
const shown = (v: unknown): string => String(v).slice(0, 40);

/** "#E5484D" or "E5484D" -> 0xE5484D, anything else -> null. */
export function parseColor(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? parseInt(m[1], 16) : null;
}

/** "Complex Pro", "complex_pro" or 6 -> 6; anything Live does not know -> null. */
export function parseWarpMode(v: unknown): number | null {
  if (typeof v === 'number') return [0, 1, 2, 3, 4, 6].includes(v) ? v : null;
  if (typeof v !== 'string') return null;
  const key = v.toLowerCase().replace(/[\s_-]/g, '');
  return key in WARP_MODES ? WARP_MODES[key] : null;
}

function parseKind(v: unknown): Kind | null {
  const k = typeof v === 'string' ? v.toLowerCase().replace(/[\s_-]/g, '') : '';
  if (k === 'loop') return 'loop';
  if (k === 'oneshot') return 'oneshot';
  return null;
}

/**
 * A file name the server and the device take: a letter or digit first, then letters, digits,
 * space, `.`, `_` or `-`, ending in `.wav`, at most 100 characters, and no `..`.
 */
export function isValidFileName(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(v) && /\.wav$/i.test(v) && !v.includes('..');
}

// src/node/manifest.js validate(), line by line. Throws a ManifestError for the package as a
// whole; marks a sound with a problem (item.error) and goes on.
function validate(raw: unknown): { pkg: CheckedPackage; warnings: string[] } {
  const warnings: string[] = [];
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
  const pkg: CheckedPackage = {
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
  if (Array.isArray(ts) && ts.length === 2 && Number.isInteger(ts[0]) && Number.isInteger(ts[1])) pkg.timeSignature = [ts[0], ts[1]];
  if (pkg.midiCount) warnings.push(`${pkg.midiCount} MIDI parts ignored (MIDI comes in a later version)`);

  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new ManifestError('The package has no sounds.');
  if (raw.items.length > LIMITS.maxItems) {
    throw new ManifestError(`The package has ${raw.items.length} sounds. LA2L takes ${LIMITS.maxItems} at most.`);
  }

  const files = new Set<string>();
  let total = 0;
  raw.items.forEach((it: unknown, index: number) => {
    const item: CheckedSound = {
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
    if (!isValidFileName(it.file)) {
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
    if (Number.isInteger(it.bytes) && (it.bytes as number) > 0) {
      item.bytes = it.bytes as number;
      total += it.bytes as number;
    } else if (it.bytes !== undefined) warnings.push(`${item.name}: bytes ignored`);

    const kind = parseKind(it.kind);
    if (kind) item.kind = kind;
    else if (it.kind === undefined || it.kind === null || it.kind === '') warnings.push(`${item.name}: no kind, placed as one-shot`);
    else warnings.push(`${item.name}: kind "${shown(it.kind)}" unknown, placed as one-shot`);

    if (typeof it.role === 'string' && (ROLES as readonly string[]).includes(it.role.toLowerCase())) item.role = it.role.toLowerCase() as Role;
    else if (it.role !== undefined) warnings.push(`${item.name}: role "${shown(it.role)}" unknown`);

    if (it.length_beats !== undefined) {
      const l = num(it.length_beats);
      if (l !== null && l > 0 && l <= 4096) item.lengthBeats = l;
      else warnings.push(`${item.name}: length_beats ignored`);
    }
    if (it.warp_mode !== undefined) {
      item.warpMode = parseWarpMode(it.warp_mode);
      if (item.warpMode === null) warnings.push(`${item.name}: warp_mode "${shown(it.warp_mode)}" unknown`);
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

// The server gives every package its own id before it checks it (server/src/routes/packages.js).
const SERVER_ID = '00000000-0000-0000-0000-000000000000';
const MAX_WARNINGS = 50;

/**
 * Checks a manifest as the server or the device would, with their texts. Never throws.
 *
 * ```js
 * const check = checkManifest(manifest);
 * if (!check.ok) showError(check.error); // "Kick needs bytes and sha256."
 * ```
 */
export function checkManifest(manifest: unknown, options: CheckManifestOptions = {}): ManifestCheck {
  if (options.as === 'device') {
    try {
      const { pkg, warnings } = validate(manifest);
      return { ok: true, package: pkg, warnings };
    } catch (e) {
      if (e instanceof ManifestError) return { ok: false, error: e.message, warnings: [] };
      return { ok: false, error: 'The package description is not valid.', warnings: [] };
    }
  }
  // As the server: at most 1 MB of JSON, an object, then the device's check with the server's id.
  const tooLarge = { ok: false as const, status: 413, error: 'The request is larger than 1 MB.', warnings: [] };
  let text: string | undefined;
  try {
    text = JSON.stringify(manifest);
  } catch (e) {
    text = undefined; // a cycle: it cannot be sent at all
  }
  if (text !== undefined && byteLength(text) > LIMITS.maxManifestBytes) return tooLarge;
  // The server sees the JSON, not this object: undefined, NaN or a Date become what JSON makes of
  // them, and an object with toJSON may become a list.
  const sent: unknown = text === undefined ? undefined : JSON.parse(text);
  if (!isObject(sent)) return { ok: false, status: 400, error: 'Send a JSON object.', warnings: [] };
  let checked: { pkg: CheckedPackage; warnings: string[] };
  try {
    checked = validate(Object.assign(sent, { package_id: SERVER_ID }));
  } catch (e) {
    return { ok: false, status: 422, error: e instanceof ManifestError ? e.message : 'The package description is not valid.', warnings: [] };
  }
  const { pkg, warnings } = checked;
  // Stricter than the device: every sound must be right, with its size and checksum.
  for (const item of pkg.items) {
    if (item.error) return { ok: false, status: 422, error: `${item.name} ${item.error}`, warnings };
    if (!item.bytes || !item.sha256) return { ok: false, status: 422, error: `${item.name} needs bytes and sha256.`, warnings };
  }
  // A tempo only changes a loop: Live plays a one-shot as it is.
  for (const item of pkg.items) {
    if (item.kind !== 'loop' && (item.bpm || item.lengthBeats)) warnings.push(`${item.name}: bpm and length_beats only apply to a loop`);
  }
  if (pkg.bpm && !pkg.items.some((item) => item.kind === 'loop')) warnings.push('tempo.bpm only applies to loops, and this package has none');
  // The server sends the manifest on with its own id, which may make it larger.
  if (byteLength(JSON.stringify(sent)) > LIMITS.maxManifestBytes) return tooLarge;
  pkg.packageId = '';
  return { ok: true, package: pkg, warnings: warnings.slice(0, MAX_WARNINGS) };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
