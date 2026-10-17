// SHA-256 of a file in pieces. WebCrypto can only hash a whole buffer at once, and a file of
// 200 MB does not fit in the memory of every phone, so in a browser this reads slices of the
// Blob and hashes them with the code below. Where node:crypto exists, that is used instead.

import type { BinarySource } from './wav.js';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 that takes its input in pieces, in plain JavaScript (FIPS 180-4). */
export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private w = new Uint32Array(64);
  private block = new Uint8Array(64);
  private filled = 0;
  private length = 0; // bytes so far
  private done = false;

  update(data: Uint8Array): this {
    if (this.done) throw new Error('This hash is finished.');
    let at = 0;
    this.length += data.length;
    if (this.filled) {
      const take = Math.min(64 - this.filled, data.length);
      this.block.set(data.subarray(0, take), this.filled);
      this.filled += take;
      at = take;
      if (this.filled < 64) return this;
      this.compress(this.block, 0);
      this.filled = 0;
    }
    for (; at + 64 <= data.length; at += 64) this.compress(data, at);
    if (at < data.length) {
      this.block.set(data.subarray(at));
      this.filled = data.length - at;
    }
    return this;
  }

  /** The hash in lower-case hex. */
  hex(): string {
    if (!this.done) {
      const bits = this.length * 8;
      const tail = new Uint8Array(this.filled < 56 ? 64 : 128);
      tail.set(this.block.subarray(0, this.filled));
      tail[this.filled] = 0x80;
      const view = new DataView(tail.buffer);
      view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
      view.setUint32(tail.length - 4, bits >>> 0);
      for (let at = 0; at < tail.length; at += 64) this.compress(tail, at);
      this.done = true;
    }
    return Array.from(this.h, (x) => x.toString(16).padStart(8, '0')).join('');
  }

  private compress(b: Uint8Array, at: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = at + i * 4;
      w[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h = this.h;
    let a = h[0], b2 = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b2) ^ (a & c) ^ (b2 & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b2;
      b2 = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b2;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
}

const SLICE = 4 * 1048576;

export interface Sha256Options {
  /** Called with the share done, from 0 to 1, after every piece. */
  onProgress?: (share: number) => void;
  /** Use the plain JavaScript hash even where node:crypto exists (for tests). */
  portable?: boolean;
}

type NodeHash = { update(data: Uint8Array): unknown; digest(encoding: 'hex'): string };

async function nodeHash(): Promise<NodeHash | null> {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (!proc || !proc.versions || !proc.versions.node) return null;
  try {
    const crypto = (await import('node:crypto')) as { createHash(name: string): NodeHash };
    return crypto.createHash('sha256');
  } catch (e) {
    return null;
  }
}

/** The SHA-256 of a file or of bytes, in lower-case hex, as the manifest's `sha256` wants it. */
export async function sha256(source: BinarySource, options: Sha256Options = {}): Promise<string> {
  const hash: NodeHash | Sha256 = (!options.portable && (await nodeHash())) || new Sha256();
  const update = (bytes: Uint8Array) => hash.update(bytes);
  const result = () => (hash instanceof Sha256 ? hash.hex() : hash.digest('hex'));
  const progress = options.onProgress || (() => {});
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    for (let at = 0; at < source.size; at += SLICE) {
      update(new Uint8Array(await source.slice(at, at + SLICE).arrayBuffer()));
      progress(Math.min(1, (at + SLICE) / source.size));
    }
    if (!source.size) progress(1);
    return result();
  }
  let bytes: Uint8Array;
  if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
  else if (ArrayBuffer.isView(source)) bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  else throw new TypeError('sha256 needs a Blob, an ArrayBuffer or bytes.');
  for (let at = 0; at < bytes.length; at += SLICE) {
    update(bytes.subarray(at, at + SLICE));
    progress(Math.min(1, (at + SLICE) / bytes.length));
  }
  if (!bytes.length) progress(1);
  return result();
}
