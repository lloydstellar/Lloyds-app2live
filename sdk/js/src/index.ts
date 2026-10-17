// la2l: send sounds from an app to Ableton Live with LA2L.
//
//   import { LA2L, wavFromAudioBuffer } from 'la2l';
//   const la2l = new LA2L({ appName: 'Web808' });
//   if (!la2l.paired) await la2l.pair(codeFromUser); // the code LA2L shows in Live
//   const delivery = await la2l.send({ title: 'Treinbeat', bpm: 92, sounds: [
//     { name: 'Kick', audio: wavFromAudioBuffer(kickBuffer), kind: 'loop', role: 'drums' },
//   ] });
//   await delivery.imported(); // when the user clicks Import in Live

export { VERSION } from './version.js';
export { La2lError, type La2lErrorCode } from './errors.js';
export { LA2L, Delivery, type La2lOptions, type SoundInput, type SendOptions, type Progress, type SoundResult, type DeliveryStatus } from './client.js';
export { DEFAULT_SERVER } from './http.js';
export { memoryStorage, type La2lStorage } from './storage.js';
export { wavFromSamples, wavFromAudioBuffer, toWav, type WavOptions, type ToWavOptions, type AudioBufferLike } from './audio.js';
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
