// The SHA-256 in pieces: the standard test vectors (FIPS 180-4 examples and NIST's long message),
// and node:crypto on random data, cut at every awkward place, from a Blob and from bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256, Sha256 } from '../dist/index.js';

const hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const text = (s) => new TextEncoder().encode(s);

test('test vectors', async () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ];
  for (const [input, want] of vectors) {
    assert.equal(new Sha256().update(text(input)).hex(), want, input);
    assert.equal(await sha256(text(input), { portable: true }), want, input);
    assert.equal(await sha256(new Blob([input]), { portable: true }), want, input);
  }
  // One million times "a".
  assert.equal(await sha256(new Uint8Array(1000000).fill(97), { portable: true }), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('pieces of every size give the hash of the whole', () => {
  const data = crypto.randomBytes(1000);
  const want = hex(data);
  for (const step of [1, 3, 55, 56, 63, 64, 65, 127, 128, 129, 999]) {
    const h = new Sha256();
    for (let at = 0; at < data.length; at += step) h.update(data.subarray(at, at + step));
    assert.equal(h.hex(), want, `pieces of ${step}`);
  }
  // Lengths around the padding boundary.
  for (let n = 50; n < 140; n++) assert.equal(new Sha256().update(data.subarray(0, n)).hex(), hex(data.subarray(0, n)), `${n} bytes`);
});

test('a file of 9 MB from a Blob, portable and with node:crypto, with progress', async () => {
  const data = crypto.randomBytes(9 * 1048576 + 17);
  const want = hex(data);
  const seen = [];
  assert.equal(await sha256(new Blob([data]), { portable: true, onProgress: (x) => seen.push(x) }), want);
  assert.deepEqual(seen.map((x) => Math.round(x * 100)), [44, 89, 100]);
  assert.equal(await sha256(new Blob([data])), want);
  assert.equal(await sha256(data), want);
  assert.equal(await sha256(data.buffer.slice(data.byteOffset, data.byteOffset + data.length), { portable: true }), want);
  assert.equal(await sha256(new Blob([])), hex(Buffer.alloc(0)));
});
