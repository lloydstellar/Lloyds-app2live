// la2l: send sounds from an app to Ableton Live with LA2L. This first part has the checks of the
// device, so an app (and the test receiver) judges a package exactly as LA2L in Live does.

export { VERSION } from './version.js';
export { La2lError, type La2lErrorCode } from './errors.js';
export {
  SCHEMA,
  LIMITS,
  ROLES,
  WARP_MODE_NAMES,
  checkManifest,
  isValidFileName,
  parseColor,
  parseWarpMode,
  type Kind,
  type Role,
  type CheckedSound,
  type CheckedPackage,
  type ManifestCheck,
  type CheckManifestOptions,
} from './manifest.js';
export { planSound, snapBeats, type SoundPlan, type PlanOptions } from './plan.js';
export { checkWav, MAX_CHUNKS, type WavInfo, type BinarySource } from './wav.js';
export { sha256, Sha256, type Sha256Options } from './sha256.js';
export { cleanName, megabytes } from './text.js';
