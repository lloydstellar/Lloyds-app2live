// What the device does with a sound in Live, ported from src/node/manifest.js (planItem,
// snapBeats, trackName), so an app or the test receiver can show it before Live does.

import { WARP_MODE_NAMES, type CheckedPackage, type CheckedSound } from './manifest.js';

// Role -> warp mode. Complex Pro sounds best on mixed material but costs the most CPU, so only
// melodic parts and vocals get it.
const ROLE_MODES: Record<string, number> = { drums: 0, bass: 1, melodic: 6, vocal: 6, texture: 2, fx: 4 };
const DEFAULT_MODE = 4; // Complex, for fx and sounds without a role

/** How one sound goes into Live. */
export interface SoundPlan {
  /** A loop is warped; a one-shot plays exactly as the app made it. */
  warp: boolean;
  looping: boolean;
  /** Live's warp mode number (0 Beats, 1 Tones, 2 Texture, 3 Re-Pitch, 4 Complex, 6 Complex Pro), or null. */
  warpMode: number | null;
  /** "Beats", "Complex Pro", or null for a one-shot. */
  warpModeName: string | null;
  /** The tempo Live plays the loop at, or null: then Live guesses it. */
  bpm: number | null;
  /** The loop length in beats, or null when it cannot be worked out. */
  lengthBeats: number | null;
  /** "Kick (Web808)": the track and clip name. */
  trackName: string;
}

export interface PlanOptions {
  /** The device setting "app name in track names". Default true, as in the device. */
  appNameInTrackName?: boolean;
}

/** A loop within 0.1 beat of a whole number of beats was meant to be that long. */
export function snapBeats(raw: number): number {
  const whole = Math.round(raw);
  if (whole >= 1 && Math.abs(raw - whole) <= 0.1) return whole;
  return Math.round(raw * 1000) / 1000;
}

/**
 * The plan for one sound of a checked package, given its length in seconds (`duration` of
 * checkWav). One-shot: warp off, loop off. Loop: warp on, the warp mode from the role, the tempo
 * of the sound or of the package, looped over its length.
 */
export function planSound(sound: CheckedSound, pkg: CheckedPackage, duration: number, options: PlanOptions = {}): SoundPlan {
  const trackName = options.appNameInTrackName === false ? sound.name : `${sound.name} (${pkg.app})`;
  if (sound.kind !== 'loop') {
    return { warp: false, looping: false, warpMode: null, warpModeName: null, bpm: null, lengthBeats: null, trackName };
  }
  const warpMode = sound.warpMode !== null ? sound.warpMode : sound.role ? ROLE_MODES[sound.role] : DEFAULT_MODE;
  let bpm: number | null = sound.bpm || pkg.bpm || null;
  let lengthBeats: number | null = sound.lengthBeats || null;
  if (!bpm && lengthBeats && duration > 0) bpm = (60 * lengthBeats) / duration;
  if (bpm && (bpm < 5 || bpm > 999)) bpm = null;
  if (bpm && !lengthBeats && duration > 0) lengthBeats = snapBeats((duration * bpm) / 60);
  return { warp: true, looping: true, warpMode, warpModeName: WARP_MODE_NAMES[warpMode] ?? null, bpm, lengthBeats, trackName };
}
