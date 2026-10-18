// WAV files from sound in memory: from the samples of Web Audio (an AudioBuffer) or from plain
// numbers, and from mp3, m4a and the other formats a browser can decode.

import { checkWav } from './wav.js';
import { La2lError } from './errors.js';
import { megabytes } from './text.js';

export interface WavOptions {
  /** 16 or 24 for integer PCM, 32 for 32-bit float. Default 16. */
  bits?: 16 | 24 | 32;
}

/** What wavFromAudioBuffer needs of an AudioBuffer. */
export interface AudioBufferLike {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * A WAV file from samples from -1 to 1: one array for mono, or one per channel for stereo.
 *
 * ```js
 * const wav = wavFromSamples([left, right], 48000, { bits: 24 });
 * ```
 */
export function wavFromSamples(channels: ArrayLike<number> | ArrayLike<number>[], sampleRate: number, options: WavOptions = {}): Blob {
  const list: ArrayLike<number>[] = isList(channels) ? (channels as ArrayLike<number>[]) : [channels as ArrayLike<number>];
  const bits = options.bits ?? 16;
  if (![16, 24, 32].includes(bits)) throw new TypeError('bits must be 16, 24 or 32 (32 is float).');
  if (list.length < 1 || list.length > 2) throw new TypeError('Give one channel (mono) or two (stereo): Live places mono and stereo files only.');
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new TypeError('The sample rate must be a whole number from 8000 to 192000.');
  const frames = list[0].length;
  if (!frames) throw new TypeError('There are no samples.');
  if (list.some((c) => c.length !== frames)) throw new TypeError('Every channel must have as many samples.');

  const float = bits === 32;
  const bytes = bits / 8;
  const block = list.length * bytes;
  const dataBytes = frames * block;
  const fmtBytes = float ? 18 : 16;
  const header = 12 + 8 + fmtBytes + (float ? 12 : 0) + 8;
  const out = new DataView(new ArrayBuffer(header + dataBytes));
  let at = 0;
  const text = (s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(at++, s.charCodeAt(i));
  };
  const u16 = (v: number) => (out.setUint16(at, v, true), (at += 2));
  const u32 = (v: number) => (out.setUint32(at, v, true), (at += 4));
  text('RIFF');
  u32(header + dataBytes - 8);
  text('WAVE');
  text('fmt ');
  u32(fmtBytes);
  u16(float ? 3 : 1);
  u16(list.length);
  u32(sampleRate);
  u32(sampleRate * block);
  u16(block);
  u16(bits);
  if (float) {
    u16(0); // cbSize
    text('fact');
    u32(4);
    u32(frames);
  }
  text('data');
  u32(dataBytes);
  for (let i = 0; i < frames; i++) {
    for (const c of list) {
      const v = Number(c[i]) || 0;
      if (float) {
        out.setFloat32(at, v, true);
      } else {
        const x = Math.max(-1, Math.min(1, v));
        if (bits === 16) out.setInt16(at, Math.round(x * 32767), true);
        else {
          const s = Math.round(x * 8388607);
          out.setUint8(at, s & 0xff);
          out.setUint8(at + 1, (s >> 8) & 0xff);
          out.setUint8(at + 2, (s >> 16) & 0xff);
        }
      }
      at += bytes;
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

function isList(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'length' in (v[0] as object);
}

/**
 * A WAV file from an AudioBuffer of Web Audio, for example what an OfflineAudioContext rendered.
 * More than two channels are mixed down to stereo.
 */
export function wavFromAudioBuffer(buffer: AudioBufferLike, options: WavOptions = {}): Blob {
  const n = buffer.numberOfChannels;
  const data = Array.from({ length: n }, (_, c) => buffer.getChannelData(c));
  if (n <= 2) return wavFromSamples(data, buffer.sampleRate, options);
  const mix = (side: number) => {
    const out = new Float32Array(buffer.length);
    const sources = data.filter((_, c) => c % 2 === side);
    for (const s of sources) for (let i = 0; i < out.length; i++) out[i] += s[i] / sources.length;
    return out;
  };
  return wavFromSamples([mix(0), mix(1)], buffer.sampleRate, options);
}

export interface ToWavOptions {
  /** 16 or 24. Default 16. */
  bits?: 16 | 24;
  /** The sample rate of the WAV file. Default 48000. A WAV file that LA2L takes is kept as it is. */
  sampleRate?: number;
  /** The largest WAV file to make, in bytes: a longer sound is refused before the WAV is made. */
  maxBytes?: number;
}

/**
 * A WAV file from mp3, m4a or any other format the browser can decode, through Web Audio. A WAV
 * file that LA2L takes comes back as it is. Browser only.
 */
export async function toWav(file: Blob, options: ToWavOptions = {}): Promise<Blob> {
  try {
    await checkWav(file);
    return file;
  } catch (e) {
    // not a WAV LA2L takes: decode it
  }
  const g = globalThis as { OfflineAudioContext?: new (channels: number, length: number, rate: number) => { decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> } };
  if (!g.OfflineAudioContext) throw new TypeError('toWav needs a browser with Web Audio.');
  const context = new g.OfflineAudioContext(2, 1, options.sampleRate || 48000);
  let buffer: AudioBufferLike;
  try {
    buffer = await context.decodeAudioData(await file.arrayBuffer());
  } catch (e) {
    throw new La2lError('bad_wav', 'This file cannot be read as sound. Send a WAV, MP3 or M4A file.');
  }
  const bits = options.bits || 16;
  const bytes = 44 + buffer.length * Math.min(2, buffer.numberOfChannels) * (bits / 8);
  if (options.maxBytes !== undefined && bytes > options.maxBytes) {
    throw new La2lError('bad_wav', `This sound is too long: as WAV it would be ${megabytes(bytes)}. LA2L takes ${megabytes(options.maxBytes)} at most.`);
  }
  return wavFromAudioBuffer(buffer, { bits });
}
