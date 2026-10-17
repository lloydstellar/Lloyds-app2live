'use strict';
// The big test of LA2L Sender (public/big.js): the file it makes in the browser has exactly the
// size and checksum the page sends in its manifest, and is a WAV file the device takes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const wav = require('../../src/node/wav');

// big.js as the browser runs it: a plain script that defines BIG_TEST.
function loadBigTest() {
  const context = vm.createContext({ Blob, DataView, ArrayBuffer, Uint8Array });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'big.js'), 'utf8') + '\nthis.BIG_TEST = BIG_TEST;', context);
  return context.BIG_TEST;
}

test('the big test file: 150 MB, the checksum on the page, a WAV of 14:52 the device takes', async () => {
  const big = loadBigTest();
  const blob = big.blob();
  assert.equal(blob.size, big.bytes);
  assert.equal(big.bytes, 150 * 1048576);
  const hash = crypto.createHash('sha256');
  for await (const chunk of blob.stream()) hash.update(chunk);
  assert.equal(hash.digest('hex'), big.sha256);
  // The device reads its header, from the start of the file to the start of the sound.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'la2l-big-')), 'big-test.wav');
  try {
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    const info = wav.readInfo(file);
    assert.deepEqual([info.format, info.channels, info.sampleRate, info.bitsPerSample, info.dataOffset], ['pcm', 2, 44100, 16, 44]);
    assert.equal(Math.floor(info.duration), 891);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
