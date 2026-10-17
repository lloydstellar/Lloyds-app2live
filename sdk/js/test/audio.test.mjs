// The WAV files the SDK makes: what checkWav (the device's check) reads in them, and the samples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wavFromSamples, wavFromAudioBuffer, toWav, checkWav } from '../dist/index.js';

const bytes = async (blob) => new DataView(await blob.arrayBuffer());

test('16, 24 and 32-bit float, mono and stereo: files LA2L takes, with the right header', async () => {
  for (const bits of [16, 24, 32]) {
    for (const channels of [1, 2]) {
      const data = Array.from({ length: channels }, () => Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10) * 0.5));
      const blob = wavFromSamples(channels === 1 ? data[0] : data, 48000, { bits });
      const info = await checkWav(blob);
      assert.deepEqual([info.format, info.bitsPerSample, info.channels, info.sampleRate, info.frames], [bits === 32 ? 'float' : 'pcm', bits, channels, 48000, 4800], `${bits} bit, ${channels} ch`);
      assert.equal(blob.type, 'audio/wav');
    }
  }
});

test('the samples: rounded, kept between -1 and 1 for PCM, exact for float', async () => {
  const s16 = await bytes(wavFromSamples([0.5, -0.5, 1.5, -2], 8000));
  // Math.round, as the device's own writer (src/node/wav.js buildWav16): -16383.5 becomes -16383.
  assert.deepEqual([s16.getInt16(44, true), s16.getInt16(46, true), s16.getInt16(48, true), s16.getInt16(50, true)], [16384, -16383, 32767, -32767]);
  const s24 = await bytes(wavFromSamples([0.5, -1], 8000, { bits: 24 }));
  const int24 = (at) => (s24.getUint8(at) | (s24.getUint8(at + 1) << 8) | (s24.getInt8(at + 2) << 16));
  assert.deepEqual([int24(44), int24(47)], [4194304, -8388607]);
  const f32 = wavFromSamples([0.25, -3], 8000, { bits: 32 });
  const info = await checkWav(f32);
  const f = await bytes(f32);
  assert.deepEqual([f.getFloat32(info.dataOffset, true), f.getFloat32(info.dataOffset + 4, true)], [0.25, -3]);
});

test('an AudioBuffer of Web Audio, and more than two channels mixed down to stereo', async () => {
  const buffer = (channels) => ({
    numberOfChannels: channels,
    sampleRate: 44100,
    length: 100,
    getChannelData: (c) => new Float32Array(100).fill((c + 1) / 10),
  });
  assert.equal((await checkWav(wavFromAudioBuffer(buffer(1)))).channels, 1);
  const four = wavFromAudioBuffer(buffer(4));
  assert.equal((await checkWav(four)).channels, 2);
  const v = await bytes(four);
  // Left: channels 1 and 3 (0.1 and 0.3), right: 2 and 4 (0.2 and 0.4).
  assert.deepEqual([v.getInt16(44, true), v.getInt16(46, true)], [Math.round(0.2 * 32767), Math.round(0.3 * 32767)]);
});

test('what cannot be a WAV for Live is refused with a clear text', () => {
  const one = new Float32Array(10);
  assert.throws(() => wavFromSamples([one, one, one], 44100), /mono and stereo files only/);
  assert.throws(() => wavFromSamples(one, 4000), /from 8000 to 192000/);
  assert.throws(() => wavFromSamples(new Float32Array(0), 44100), /no samples/);
  assert.throws(() => wavFromSamples([one, new Float32Array(9)], 44100), /as many samples/);
  assert.throws(() => wavFromSamples(one, 44100, { bits: 8 }), /16, 24 or 32/);
});

test('toWav gives a WAV that LA2L takes back as it is; decoding needs a browser', async () => {
  const wav = wavFromSamples(new Float32Array(100), 44100);
  assert.equal(await toWav(wav), wav);
  await assert.rejects(toWav(new Blob(['ID3 not a wav'])), /needs a browser with Web Audio/);
});
