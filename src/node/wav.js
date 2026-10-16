'use strict';
// Reads the header of a WAV file, and writes simple 16-bit WAV files (for the built-in test loop).
// Only the header is read: Live reads the sound itself. The header tells us whether Live can
// use the file and how long it is, which the device needs to work out the loop length.

const fs = require('fs');

class WavError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WavError';
  }
}

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

function parseFmt(b) {
  if (b.length < 16) throw new WavError('The WAV header is damaged.');
  const fmt = {
    formatTag: b.readUInt16LE(0),
    channels: b.readUInt16LE(2),
    sampleRate: b.readUInt32LE(4),
    blockAlign: b.readUInt16LE(12),
    bitsPerSample: b.readUInt16LE(14),
  };
  // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of a GUID.
  if (fmt.formatTag === EXTENSIBLE && b.length >= 26) fmt.formatTag = b.readUInt16LE(24);
  return fmt;
}

function check(fmt) {
  const { formatTag, channels, sampleRate, bitsPerSample } = fmt;
  if (formatTag === PCM) {
    if (![8, 16, 24, 32].includes(bitsPerSample)) throw new WavError(`${bitsPerSample}-bit PCM is not supported. Use 16 or 24 bit.`);
  } else if (formatTag === FLOAT) {
    if (![32, 64].includes(bitsPerSample)) throw new WavError(`${bitsPerSample}-bit float is not supported. Use 32-bit float.`);
  } else {
    throw new WavError(`This WAV file is compressed (format ${formatTag}). Send plain PCM or float WAV.`);
  }
  if (channels < 1 || channels > 2) throw new WavError(`The WAV file has ${channels} channels. Live places mono and stereo files only.`);
  if (sampleRate < 8000 || sampleRate > 192000) throw new WavError(`The sample rate ${sampleRate} Hz is not supported.`);
}

// Returns { format, channels, sampleRate, bitsPerSample, blockAlign, dataOffset, dataBytes, frames, duration, fileBytes }.
function readInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(12);
    if (size < 12 || fs.readSync(fd, head, 0, 12, 0) < 12) throw new WavError('The file is too short to be a WAV file.');
    const riff = head.toString('latin1', 0, 4);
    if (riff === 'RF64' || riff === 'BW64') throw new WavError('RF64 files are not supported. Send a normal WAV file.');
    if (riff !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw new WavError('This is not a WAV file.');

    let pos = 12;
    let fmt = null;
    let data = null;
    const hdr = Buffer.alloc(8);
    // Walk the chunks. Large chunks we do not need (LIST, bext, JUNK) are skipped, not read.
    while (pos + 8 <= size && !(fmt && data)) {
      fs.readSync(fd, hdr, 0, 8, pos);
      const id = hdr.toString('latin1', 0, 4);
      let len = hdr.readUInt32LE(4);
      const body = pos + 8;
      if (id === 'fmt ') {
        const b = Buffer.alloc(Math.min(len, 64));
        fs.readSync(fd, b, 0, b.length, body);
        fmt = parseFmt(b);
      } else if (id === 'data') {
        // Some recorders leave the size at 0 or 0xFFFFFFFF while writing: use what is there.
        if (len === 0 || len === 0xffffffff || body + len > size) len = size - body;
        data = { offset: body, bytes: len };
      }
      pos = body + len + (len & 1);
    }
    if (!fmt) throw new WavError('The WAV file has no format block.');
    if (!data) throw new WavError('The WAV file has no sound data.');
    check(fmt);
    const blockAlign = fmt.blockAlign || (fmt.channels * fmt.bitsPerSample) / 8;
    const frames = Math.floor(data.bytes / blockAlign);
    if (frames < 1) throw new WavError('The WAV file is empty.');
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
  } finally {
    fs.closeSync(fd);
  }
}

// A 16-bit PCM WAV file in memory. samples: numbers from -1 to 1, interleaved when stereo.
function buildWav16(samples, channels, sampleRate) {
  const dataBytes = samples.length * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(PCM, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return b;
}

function writeWav16(file, samples, channels, sampleRate) {
  fs.writeFileSync(file, buildWav16(samples, channels, sampleRate));
}

module.exports = { readInfo, buildWav16, writeWav16, WavError };
