// Reads the header of a WAV file as the device does (src/node/wav.js readInfo), with the same
// texts, from a Blob (a File too) or from bytes in memory. Only the header is read, never the
// sound, so a file of 200 MB costs a few small reads.

import { La2lError } from './errors.js';

/** What the header of a usable WAV file says. */
export interface WavInfo {
  format: 'pcm' | 'float';
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  /** Where the sound data starts, and how many bytes it has. */
  dataOffset: number;
  dataBytes: number;
  frames: number;
  /** In seconds. */
  duration: number;
  fileBytes: number;
}

/** A Blob or File, an ArrayBuffer, or bytes such as a Uint8Array or a Node.js Buffer. */
export type BinarySource = Blob | ArrayBuffer | ArrayBufferView;

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;
// Real files have a handful of chunks before the sound data. A file built of millions of empty
// chunks would keep the walk busy for a long time, so it stops here, as the device does.
export const MAX_CHUNKS = 1000;
const WINDOW = 65536;

const bad = (message: string) => new La2lError('bad_wav', message);

interface Reader {
  size: number;
  /** Exactly `length` bytes from `position`, with zeros past the end of the file. */
  read(position: number, length: number): Promise<Uint8Array>;
}

function readerOf(source: BinarySource): Reader {
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    // Small reads come from one cached window of 64 KB, so walking the chunks is cheap.
    let start = -1;
    let window = new Uint8Array(0);
    return {
      size: source.size,
      async read(position, length) {
        const out = new Uint8Array(length);
        if (length > WINDOW || position < start || position + length > start + window.length) {
          if (length > WINDOW) {
            out.set(new Uint8Array(await source.slice(position, position + length).arrayBuffer()));
            return out;
          }
          start = position;
          window = new Uint8Array(await source.slice(position, position + WINDOW).arrayBuffer());
        }
        out.set(window.subarray(position - start, Math.min(window.length, position - start + length)));
        return out;
      },
    };
  }
  let bytes: Uint8Array;
  if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
  else if (ArrayBuffer.isView(source)) bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  else throw new TypeError('checkWav needs a Blob, an ArrayBuffer or bytes.');
  return {
    size: bytes.length,
    async read(position, length) {
      const out = new Uint8Array(length);
      if (position < bytes.length) out.set(bytes.subarray(position, Math.min(bytes.length, position + length)));
      return out;
    },
  };
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

interface Fmt {
  formatTag: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

function parseFmt(b: Uint8Array): Fmt {
  if (b.length < 16) throw bad('The WAV header is damaged.');
  const fmt = { formatTag: u16(b, 0), channels: u16(b, 2), sampleRate: u32(b, 4), blockAlign: u16(b, 12), bitsPerSample: u16(b, 14) };
  // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of a GUID.
  if (fmt.formatTag === EXTENSIBLE && b.length >= 26) fmt.formatTag = u16(b, 24);
  return fmt;
}

function check(fmt: Fmt): void {
  const { formatTag, channels, sampleRate, bitsPerSample } = fmt;
  if (formatTag === PCM) {
    if (![8, 16, 24, 32].includes(bitsPerSample)) throw bad(`${bitsPerSample}-bit PCM is not supported. Use 16 or 24 bit.`);
  } else if (formatTag === FLOAT) {
    if (![32, 64].includes(bitsPerSample)) throw bad(`${bitsPerSample}-bit float is not supported. Use 32-bit float.`);
  } else {
    throw bad(`This WAV file is compressed (format ${formatTag}). Send plain PCM or float WAV.`);
  }
  if (channels < 1 || channels > 2) throw bad(`The WAV file has ${channels} channels. Live places mono and stereo files only.`);
  if (sampleRate < 8000 || sampleRate > 192000) throw bad(`The sample rate ${sampleRate} Hz is not supported.`);
}

/**
 * Checks that a file is a WAV file Live can use: PCM 8, 16, 24 or 32 bit, or float 32 or 64
 * bit, mono or stereo, 8 to 192 kHz. Resolves to what its header says; rejects with a
 * La2lError (code `bad_wav`) with the device's text, for example
 * "This WAV file is compressed (format 85). Send plain PCM or float WAV."
 */
export async function checkWav(source: BinarySource): Promise<WavInfo> {
  const file = readerOf(source);
  const size = file.size;
  if (size < 12) throw bad('The file is too short to be a WAV file.');
  const head = await file.read(0, 12);
  const riff = ascii(head, 0, 4);
  if (riff === 'RF64' || riff === 'BW64') throw bad('RF64 files are not supported. Send a normal WAV file.');
  if (riff !== 'RIFF' || ascii(head, 8, 12) !== 'WAVE') throw bad('This is not a WAV file.');

  let pos = 12;
  let fmt: Fmt | null = null;
  let data: { offset: number; bytes: number } | null = null;
  let chunks = 0;
  // Walk the chunks. Large chunks that are not needed (LIST, bext, JUNK) are skipped, not read.
  while (pos + 8 <= size && !(fmt && data)) {
    if (++chunks > MAX_CHUNKS) throw bad('The WAV header is damaged.');
    const hdr = await file.read(pos, 8);
    const id = ascii(hdr, 0, 4);
    let len = u32(hdr, 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = parseFmt(await file.read(body, Math.min(len, 64)));
    } else if (id === 'data') {
      // Some recorders leave the size at 0 or 0xFFFFFFFF while writing: use what is there.
      if (len === 0 || len === 0xffffffff || body + len > size) len = size - body;
      data = { offset: body, bytes: len };
    }
    pos = body + len + (len & 1);
  }
  if (!fmt) throw bad('The WAV file has no format block.');
  if (!data) throw bad('The WAV file has no sound data.');
  check(fmt);
  const blockAlign = fmt.blockAlign || (fmt.channels * fmt.bitsPerSample) / 8;
  const frames = Math.floor(data.bytes / blockAlign);
  if (frames < 1) throw bad('The WAV file is empty.');
  return {
    format: fmt.formatTag === FLOAT ? 'float' : 'pcm',
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    blockAlign,
    dataOffset: data.offset,
    dataBytes: data.bytes,
    frames,
    duration: frames / fmt.sampleRate,
    fileBytes: size,
  };
}
