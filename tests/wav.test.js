'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wav = require('../src/node/wav');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-wav-'));
let n = 0;

function chunk(id, body) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function fmt({ tag = 1, channels = 1, rate = 44100, bits = 16, extensibleTag = null }) {
  const size = extensibleTag ? 40 : 16;
  const b = Buffer.alloc(size);
  b.writeUInt16LE(extensibleTag ? 0xfffe : tag, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE((rate * channels * bits) / 8, 8);
  b.writeUInt16LE((channels * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  if (extensibleTag) {
    b.writeUInt16LE(22, 16);
    b.writeUInt16LE(bits, 18);
    b.writeUInt16LE(extensibleTag, 24);
  }
  return chunk('fmt ', b);
}

function file(parts, riff = 'RIFF') {
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...parts]);
  const head = Buffer.alloc(8);
  head.write(riff, 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  const f = path.join(dir, `f${n++}.wav`);
  fs.writeFileSync(f, Buffer.concat([head, body]));
  return f;
}

test('16-bit mono PCM', () => {
  const f = path.join(dir, 'mono.wav');
  wav.writeWav16(f, new Float32Array(44100), 1, 44100);
  const info = wav.readInfo(f);
  assert.equal(info.format, 'pcm');
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.frames, 44100);
  assert.equal(info.duration, 1);
});

test('24-bit stereo with a LIST chunk and an odd chunk before the data', () => {
  const f = file([fmt({ channels: 2, bits: 24, rate: 48000 }), chunk('LIST', Buffer.alloc(33)), chunk('data', Buffer.alloc(48000 * 6))]);
  const info = wav.readInfo(f);
  assert.equal(info.channels, 2);
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.duration, 1);
});

test('32-bit float and WAVE_FORMAT_EXTENSIBLE', () => {
  let info = wav.readInfo(file([fmt({ tag: 3, bits: 32 }), chunk('fact', Buffer.alloc(4)), chunk('data', Buffer.alloc(4 * 4410))]));
  assert.equal(info.format, 'float');
  assert.equal(info.duration, 0.1);
  info = wav.readInfo(file([fmt({ extensibleTag: 1, bits: 24, channels: 2 }), chunk('data', Buffer.alloc(6 * 441))]));
  assert.equal(info.format, 'pcm');
  assert.equal(info.frames, 441);
});

test('a data size of 0xFFFFFFFF (still recording) uses the real file size', () => {
  const data = chunk('data', Buffer.alloc(2 * 1000));
  data.writeUInt32LE(0xffffffff, 4);
  const info = wav.readInfo(file([fmt({}), data]));
  assert.equal(info.frames, 1000);
});

test('a header of endless empty chunks is refused at once, a real header with many chunks is not', () => {
  const empty = (n) => Buffer.alloc(8 * n); // an empty chunk: id "\0\0\0\0", size 0
  const data = chunk('data', Buffer.alloc(200));
  // fmt + empty chunks + data: exactly MAX_CHUNKS chunks still read, one more does not.
  assert.equal(wav.readInfo(file([fmt({}), empty(wav.MAX_CHUNKS - 2), data])).frames, 100);
  assert.throws(() => wav.readInfo(file([fmt({}), empty(wav.MAX_CHUNKS - 1), data])), /^WavError: The WAV header is damaged\.$/);
  const start = Date.now();
  assert.throws(() => wav.readInfo(file([empty(1048576)])), /The WAV header is damaged/, '8 MB of empty chunks');
  assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
});

test('files Live cannot use are refused with a clear reason', () => {
  const cases = [
    [file([fmt({ tag: 0x55 }), chunk('data', Buffer.alloc(100))]), /compressed/],
    [file([fmt({ channels: 6, bits: 16 }), chunk('data', Buffer.alloc(1200))]), /6 channels/],
    [file([fmt({ bits: 12 }), chunk('data', Buffer.alloc(100))]), /12-bit/],
    [file([fmt({}), chunk('data', Buffer.alloc(0))]), /empty/],
    [file([fmt({})]), /no sound data/],
    [file([chunk('data', Buffer.alloc(10))]), /no format/],
    [file([fmt({}), chunk('data', Buffer.alloc(10))], 'RF64'), /RF64/],
  ];
  for (const [f, re] of cases) assert.throws(() => wav.readInfo(f), re);
  const html = path.join(dir, 'page.wav');
  fs.writeFileSync(html, '<html>not a wav</html>');
  assert.throws(() => wav.readInfo(html), /not a WAV/);
  const tiny = path.join(dir, 'tiny.wav');
  fs.writeFileSync(tiny, 'RIFF');
  assert.throws(() => wav.readInfo(tiny), /too short/);
});
