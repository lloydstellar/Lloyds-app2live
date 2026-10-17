'use strict';
// The big test of LA2L Sender (https://lloydstellar.nl/la2l/?big): a WAV file of exactly
// 150 MB, made in the browser, so a phone needs no large file to test a long upload. It is a
// quiet tone, 16-bit stereo at 44.1 kHz, 14 minutes and 52 seconds long. Every byte comes from
// integer arithmetic, so the file is the same in every browser, and the page can carry its size
// and checksum instead of hashing 150 MB on a phone. server/test/big.test.js makes the file the
// same way and checks both numbers.

const BIG_TEST = {
  bytes: 157286400,
  sha256: '035d47c63ad7361c6783093925e215958b2c2dc1710e0e619b28e96a01aefbfc',
  name: 'Big test',
  file: 'big-test.wav',

  // The file as a Blob: the header, then one block of whole tone periods again and again.
  blob() {
    const dataBytes = this.bytes - 44;
    const head = new DataView(new ArrayBuffer(44));
    const text = (at, s) => [...s].forEach((c, i) => head.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    head.setUint32(4, this.bytes - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    head.setUint32(16, 16, true);
    head.setUint16(20, 1, true); // PCM
    head.setUint16(22, 2, true); // stereo
    head.setUint32(24, 44100, true);
    head.setUint32(28, 44100 * 4, true);
    head.setUint16(32, 4, true);
    head.setUint16(34, 16, true);
    text(36, 'data');
    head.setUint32(40, dataBytes, true);

    // A triangle wave of 200 frames (220.5 Hz), from -1000 to +1000: about -30 dB, quiet.
    const PERIOD = 200;
    const block = new DataView(new ArrayBuffer(1310 * PERIOD * 4)); // 1310 periods, 1048000 bytes
    for (let frame = 0; frame < 1310 * PERIOD; frame++) {
      const i = frame % PERIOD;
      const v = i < 100 ? -1000 + 20 * i : 1000 - 20 * (i - 100);
      block.setInt16(frame * 4, v, true);
      block.setInt16(frame * 4 + 2, v, true);
    }
    const bytes = new Uint8Array(block.buffer);
    const parts = [new Uint8Array(head.buffer)];
    let left = dataBytes;
    while (left >= bytes.length) {
      parts.push(bytes);
      left -= bytes.length;
    }
    parts.push(bytes.subarray(0, left));
    return new Blob(parts, { type: 'audio/wav' });
  },
};
