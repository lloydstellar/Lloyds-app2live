// la2l 0.1.0: the test receiver of the page /la2l/receiver.
// SPDX-License-Identifier: Apache-2.0. https://github.com/lloydstellar/Lloyds-app2live
// Built from sdk/js with "npm run build". Do not edit: CI compares it with a fresh build.
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/errors.ts
var La2lError = class extends Error {
  constructor(code, message, options = {}) {
    super(message);
    __publicField(this, "code");
    /** The HTTP status of the server's answer, or null when there was none. */
    __publicField(this, "status");
    /** Seconds to wait before trying again, from Retry-After, or null. */
    __publicField(this, "retryAfter");
    this.name = "La2lError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfter = options.retryAfter ?? null;
  }
};

// src/text.ts
function limit(s, maxLength) {
  return s.length > maxLength ? s.slice(0, maxLength).trim() : s;
}
function cleanName(name, fallback, maxLength = 60) {
  const s = String(name == null ? "" : name).normalize("NFC").replace(/[^\p{L}\p{N} _\-().'&+#!]/gu, " ").replace(/\s+/g, " ").trim();
  return limit(s, maxLength) || fallback;
}
function megabytes(bytes) {
  return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + " MB";
}

// src/manifest.ts
var SCHEMA = "app2live/1";
var LIMITS = {
  maxItems: 32,
  maxPackageBytes: 200 * 1048576,
  /** The largest manifest the server takes, in bytes of JSON. */
  maxManifestBytes: 1048576
};
var ROLES = ["drums", "bass", "melodic", "vocal", "texture", "fx"];
var WARP_MODE_NAMES = { 0: "Beats", 1: "Tones", 2: "Texture", 3: "Re-Pitch", 4: "Complex", 6: "Complex Pro" };
var WARP_MODES = { beats: 0, tones: 1, texture: 2, repitch: 3, complex: 4, complexpro: 6 };
var ManifestError = class extends Error {
};
var isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
var shown = (v) => String(v).slice(0, 40);
function parseColor(v) {
  if (typeof v !== "string") return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? parseInt(m[1], 16) : null;
}
function parseWarpMode(v) {
  if (typeof v === "number") return [0, 1, 2, 3, 4, 6].includes(v) ? v : null;
  if (typeof v !== "string") return null;
  const key = v.toLowerCase().replace(/[\s_-]/g, "");
  return key in WARP_MODES ? WARP_MODES[key] : null;
}
function parseKind(v) {
  const k = typeof v === "string" ? v.toLowerCase().replace(/[\s_-]/g, "") : "";
  if (k === "loop") return "loop";
  if (k === "oneshot") return "oneshot";
  return null;
}
function isValidFileName(v) {
  return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(v) && /\.wav$/i.test(v) && !v.includes("..");
}
function validate(raw) {
  const warnings = [];
  if (!isObject(raw)) throw new ManifestError("The package description is not valid.");
  if (typeof raw.schema !== "string") throw new ManifestError("This is not an App2Live package.");
  if (raw.schema !== SCHEMA) {
    if (/^app2live\/\d+$/.test(raw.schema)) throw new ManifestError(`This package uses ${raw.schema}. Update LA2L to import it.`);
    throw new ManifestError("This is not an App2Live package.");
  }
  if (typeof raw.package_id !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(raw.package_id)) {
    throw new ManifestError("The package has no valid package_id.");
  }
  const source = isObject(raw.source) ? raw.source : {};
  const tempo = isObject(raw.tempo) ? raw.tempo : {};
  const pkg = {
    packageId: raw.package_id,
    title: cleanName(raw.title, "Untitled", 60),
    app: cleanName(source.app, "App", 40),
    appVersion: typeof source.app_version === "string" ? source.app_version.slice(0, 40) : "",
    platform: typeof source.platform === "string" ? source.platform.slice(0, 40) : "",
    createdAt: typeof raw.created_at === "string" ? raw.created_at.slice(0, 40) : "",
    bpm: null,
    timeSignature: null,
    items: [],
    midiCount: Array.isArray(raw.midi) ? raw.midi.length : 0
  };
  if (!raw.title) warnings.push("no title");
  if (!source.app) warnings.push("no source.app");
  if (tempo.bpm !== void 0) {
    const b = num(tempo.bpm);
    if (b !== null && b >= 20 && b <= 999) pkg.bpm = b;
    else warnings.push("tempo.bpm is not a number from 20 to 999");
  }
  const ts = tempo.time_signature;
  if (Array.isArray(ts) && ts.length === 2 && Number.isInteger(ts[0]) && Number.isInteger(ts[1])) pkg.timeSignature = [ts[0], ts[1]];
  if (pkg.midiCount) warnings.push(`${pkg.midiCount} MIDI parts ignored (MIDI comes in a later version)`);
  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new ManifestError("The package has no sounds.");
  if (raw.items.length > LIMITS.maxItems) {
    throw new ManifestError(`The package has ${raw.items.length} sounds. LA2L takes ${LIMITS.maxItems} at most.`);
  }
  const files = /* @__PURE__ */ new Set();
  let total = 0;
  raw.items.forEach((it, index) => {
    const item = {
      index,
      id: "",
      file: "",
      sha256: null,
      bytes: null,
      name: `Sound ${index + 1}`,
      kind: "oneshot",
      role: null,
      lengthBeats: null,
      warpMode: null,
      bpm: null,
      color: null,
      gainDb: null,
      error: null
    };
    pkg.items.push(item);
    if (!isObject(it)) {
      item.error = "is not described correctly";
      return;
    }
    item.id = typeof it.id === "string" && it.id ? it.id.slice(0, 100) : String(index + 1);
    item.name = cleanName(it.name, `Sound ${index + 1}`, 40);
    if (!isValidFileName(it.file)) {
      item.error = "has no valid file name";
      return;
    }
    if (files.has(it.file.toLowerCase())) {
      item.error = "uses the same file as another sound";
      return;
    }
    files.add(it.file.toLowerCase());
    item.file = it.file;
    if (typeof it.sha256 === "string" && /^[a-f0-9]{64}$/i.test(it.sha256)) item.sha256 = it.sha256.toLowerCase();
    else if (it.sha256 !== void 0) warnings.push(`${item.name}: sha256 ignored`);
    if (Number.isInteger(it.bytes) && it.bytes > 0) {
      item.bytes = it.bytes;
      total += it.bytes;
    } else if (it.bytes !== void 0) warnings.push(`${item.name}: bytes ignored`);
    const kind = parseKind(it.kind);
    if (kind) item.kind = kind;
    else if (it.kind === void 0 || it.kind === null || it.kind === "") warnings.push(`${item.name}: no kind, placed as one-shot`);
    else warnings.push(`${item.name}: kind "${shown(it.kind)}" unknown, placed as one-shot`);
    if (typeof it.role === "string" && ROLES.includes(it.role.toLowerCase())) item.role = it.role.toLowerCase();
    else if (it.role !== void 0) warnings.push(`${item.name}: role "${shown(it.role)}" unknown`);
    if (it.length_beats !== void 0) {
      const l = num(it.length_beats);
      if (l !== null && l > 0 && l <= 4096) item.lengthBeats = l;
      else warnings.push(`${item.name}: length_beats ignored`);
    }
    if (it.warp_mode !== void 0) {
      item.warpMode = parseWarpMode(it.warp_mode);
      if (item.warpMode === null) warnings.push(`${item.name}: warp_mode "${shown(it.warp_mode)}" unknown`);
    }
    if (it.bpm !== void 0) {
      const b = num(it.bpm);
      if (b !== null && b >= 20 && b <= 999) item.bpm = b;
      else warnings.push(`${item.name}: bpm ignored`);
    }
    if (it.color !== void 0) {
      item.color = parseColor(it.color);
      if (item.color === null) warnings.push(`${item.name}: color ignored`);
    }
    if (it.gain_db !== void 0) {
      const g = num(it.gain_db);
      if (g !== null) item.gainDb = Math.max(-70, Math.min(24, g));
      else warnings.push(`${item.name}: gain_db ignored`);
    }
  });
  if (total > LIMITS.maxPackageBytes) {
    throw new ManifestError(`The package is ${megabytes(total)}. LA2L takes ${megabytes(LIMITS.maxPackageBytes)} at most.`);
  }
  return { pkg, warnings };
}
var SERVER_ID = "00000000-0000-0000-0000-000000000000";
var MAX_WARNINGS = 50;
function checkManifest(manifest, options = {}) {
  if (options.as === "device") {
    try {
      const { pkg: pkg2, warnings: warnings2 } = validate(manifest);
      return { ok: true, package: pkg2, warnings: warnings2 };
    } catch (e) {
      if (e instanceof ManifestError) return { ok: false, error: e.message, warnings: [] };
      return { ok: false, error: "The package description is not valid.", warnings: [] };
    }
  }
  const tooLarge = { ok: false, status: 413, error: "The request is larger than 1 MB.", warnings: [] };
  let text;
  try {
    text = JSON.stringify(manifest);
  } catch (e) {
    text = void 0;
  }
  if (text !== void 0 && byteLength(text) > LIMITS.maxManifestBytes) return tooLarge;
  const sent = text === void 0 ? void 0 : JSON.parse(text);
  if (!isObject(sent)) return { ok: false, status: 400, error: "Send a JSON object.", warnings: [] };
  let checked;
  try {
    checked = validate(Object.assign(sent, { package_id: SERVER_ID }));
  } catch (e) {
    return { ok: false, status: 422, error: e instanceof ManifestError ? e.message : "The package description is not valid.", warnings: [] };
  }
  const { pkg, warnings } = checked;
  for (const item of pkg.items) {
    if (item.error) return { ok: false, status: 422, error: `${item.name} ${item.error}`, warnings };
    if (!item.bytes || !item.sha256) return { ok: false, status: 422, error: `${item.name} needs bytes and sha256.`, warnings };
  }
  for (const item of pkg.items) {
    if (item.kind !== "loop" && (item.bpm || item.lengthBeats)) warnings.push(`${item.name}: bpm and length_beats only apply to a loop`);
  }
  if (pkg.bpm && !pkg.items.some((item) => item.kind === "loop")) warnings.push("tempo.bpm only applies to loops, and this package has none");
  if (byteLength(JSON.stringify(sent)) > LIMITS.maxManifestBytes) return tooLarge;
  pkg.packageId = "";
  return { ok: true, package: pkg, warnings: warnings.slice(0, MAX_WARNINGS) };
}
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

// src/wav.ts
var PCM = 1;
var FLOAT = 3;
var EXTENSIBLE = 65534;
var MAX_CHUNKS = 1e3;
var WINDOW = 65536;
var bad = (message) => new La2lError("bad_wav", message);
function readerOf(source) {
  if (typeof Blob !== "undefined" && source instanceof Blob) {
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
      }
    };
  }
  let bytes;
  if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
  else if (ArrayBuffer.isView(source)) bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  else throw new TypeError("checkWav needs a Blob, an ArrayBuffer or bytes.");
  return {
    size: bytes.length,
    async read(position, length) {
      const out = new Uint8Array(length);
      if (position < bytes.length) out.set(bytes.subarray(position, Math.min(bytes.length, position + length)));
      return out;
    }
  };
}
var u16 = (b, at) => b[at] | b[at + 1] << 8;
var u32 = (b, at) => (b[at] | b[at + 1] << 8 | b[at + 2] << 16 | b[at + 3] << 24) >>> 0;
var ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
function parseFmt(b) {
  if (b.length < 16) throw bad("The WAV header is damaged.");
  const fmt = { formatTag: u16(b, 0), channels: u16(b, 2), sampleRate: u32(b, 4), blockAlign: u16(b, 12), bitsPerSample: u16(b, 14) };
  if (fmt.formatTag === EXTENSIBLE && b.length >= 26) fmt.formatTag = u16(b, 24);
  return fmt;
}
function check(fmt) {
  const { formatTag, channels, sampleRate, bitsPerSample } = fmt;
  if (formatTag === PCM) {
    if (![8, 16, 24, 32].includes(bitsPerSample)) throw bad(`${bitsPerSample}-bit PCM is not supported. Use 16 or 24 bit.`);
  } else if (formatTag === FLOAT) {
    if (![32, 64].includes(bitsPerSample)) throw bad(`${bitsPerSample}-bit float is not supported. Use 32-bit float.`);
  } else {
    throw bad(`This WAV file is compressed (format ${formatTag}). Send plain PCM or float WAV.`);
  }
  if (channels < 1 || channels > 2) throw bad(`The WAV file has ${channels} channels. Live places mono and stereo files only.`);
  if (sampleRate < 8e3 || sampleRate > 192e3) throw bad(`The sample rate ${sampleRate} Hz is not supported.`);
}
async function checkWav(source) {
  const file = readerOf(source);
  const size = file.size;
  if (size < 12) throw bad("The file is too short to be a WAV file.");
  const head = await file.read(0, 12);
  const riff = ascii(head, 0, 4);
  if (riff === "RF64" || riff === "BW64") throw bad("RF64 files are not supported. Send a normal WAV file.");
  if (riff !== "RIFF" || ascii(head, 8, 12) !== "WAVE") throw bad("This is not a WAV file.");
  let pos = 12;
  let fmt = null;
  let data = null;
  let chunks = 0;
  while (pos + 8 <= size && !(fmt && data)) {
    if (++chunks > MAX_CHUNKS) throw bad("The WAV header is damaged.");
    const hdr = await file.read(pos, 8);
    const id = ascii(hdr, 0, 4);
    let len = u32(hdr, 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = parseFmt(await file.read(body, Math.min(len, 64)));
    } else if (id === "data") {
      if (len === 0 || len === 4294967295 || body + len > size) len = size - body;
      data = { offset: body, bytes: len };
    }
    pos = body + len + (len & 1);
  }
  if (!fmt) throw bad("The WAV file has no format block.");
  if (!data) throw bad("The WAV file has no sound data.");
  check(fmt);
  const blockAlign = fmt.blockAlign || fmt.channels * fmt.bitsPerSample / 8;
  const frames = Math.floor(data.bytes / blockAlign);
  if (frames < 1) throw bad("The WAV file is empty.");
  return {
    format: fmt.formatTag === FLOAT ? "float" : "pcm",
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    blockAlign,
    dataOffset: data.offset,
    dataBytes: data.bytes,
    frames,
    duration: frames / fmt.sampleRate,
    fileBytes: size
  };
}

// src/plan.ts
var ROLE_MODES = { drums: 0, bass: 1, melodic: 6, vocal: 6, texture: 2, fx: 4 };
var DEFAULT_MODE = 4;
function snapBeats(raw) {
  const whole = Math.round(raw);
  if (whole >= 1 && Math.abs(raw - whole) <= 0.1) return whole;
  return Math.round(raw * 1e3) / 1e3;
}
function planSound(sound, pkg, duration, options = {}) {
  const trackName = options.appNameInTrackName === false ? sound.name : `${sound.name} (${pkg.app})`;
  if (sound.kind !== "loop") {
    return { warp: false, looping: false, warpMode: null, warpModeName: null, bpm: null, lengthBeats: null, trackName };
  }
  const warpMode = sound.warpMode !== null ? sound.warpMode : sound.role ? ROLE_MODES[sound.role] : DEFAULT_MODE;
  let bpm = sound.bpm || pkg.bpm || null;
  let lengthBeats = sound.lengthBeats || null;
  if (!bpm && lengthBeats && duration > 0) bpm = 60 * lengthBeats / duration;
  if (bpm && (bpm < 5 || bpm > 999)) bpm = null;
  if (bpm && !lengthBeats && duration > 0) lengthBeats = snapBeats(duration * bpm / 60);
  return { warp: true, looping: true, warpMode, warpModeName: WARP_MODE_NAMES[warpMode] ?? null, bpm, lengthBeats, trackName };
}

// src/sha256.ts
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var Sha256 = class {
  constructor() {
    __publicField(this, "h", new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]));
    __publicField(this, "w", new Uint32Array(64));
    __publicField(this, "block", new Uint8Array(64));
    __publicField(this, "filled", 0);
    __publicField(this, "length", 0);
    // bytes so far
    __publicField(this, "done", false);
  }
  update(data) {
    if (this.done) throw new Error("This hash is finished.");
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
  hex() {
    if (!this.done) {
      const bits = this.length * 8;
      const tail = new Uint8Array(this.filled < 56 ? 64 : 128);
      tail.set(this.block.subarray(0, this.filled));
      tail[this.filled] = 128;
      const view = new DataView(tail.buffer);
      view.setUint32(tail.length - 8, Math.floor(bits / 4294967296));
      view.setUint32(tail.length - 4, bits >>> 0);
      for (let at = 0; at < tail.length; at += 64) this.compress(tail, at);
      this.done = true;
    }
    return Array.from(this.h, (x) => x.toString(16).padStart(8, "0")).join("");
  }
  compress(b, at) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = at + i * 4;
      w[i] = b[j] << 24 | b[j + 1] << 16 | b[j + 2] << 8 | b[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3;
      const s1 = (y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
    }
    const h = this.h;
    let a = h[0], b2 = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
      const ch = e & f ^ ~e & g;
      const t1 = hh + S1 + ch + K[i] + w[i] | 0;
      const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
      const maj = a & b2 ^ a & c ^ b2 & c;
      const t2 = S0 + maj | 0;
      hh = g;
      g = f;
      f = e;
      e = d + t1 | 0;
      d = c;
      c = b2;
      b2 = a;
      a = t1 + t2 | 0;
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
};
var SLICE = 4 * 1048576;
async function nodeHash() {
  const proc = globalThis.process;
  if (!proc || !proc.versions || !proc.versions.node) return null;
  try {
    const crypto = await import("node:crypto");
    return crypto.createHash("sha256");
  } catch (e) {
    return null;
  }
}
async function sha256(source, options = {}) {
  const hash = !options.portable && await nodeHash() || new Sha256();
  const update = (bytes2) => hash.update(bytes2);
  const result = () => hash instanceof Sha256 ? hash.hex() : hash.digest("hex");
  const progress = options.onProgress || (() => {
  });
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    for (let at = 0; at < source.size; at += SLICE) {
      update(new Uint8Array(await source.slice(at, at + SLICE).arrayBuffer()));
      progress(Math.min(1, (at + SLICE) / source.size));
    }
    if (!source.size) progress(1);
    return result();
  }
  let bytes;
  if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
  else if (ArrayBuffer.isView(source)) bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  else throw new TypeError("sha256 needs a Blob, an ArrayBuffer or bytes.");
  for (let at = 0; at < bytes.length; at += SLICE) {
    update(bytes.subarray(at, at + SLICE));
    progress(Math.min(1, (at + SLICE) / bytes.length));
  }
  if (!bytes.length) progress(1);
  return result();
}

// src/storage.ts
function memoryStorage() {
  const values = /* @__PURE__ */ new Map();
  return {
    get: (key) => values.has(key) ? values.get(key) : null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key)
  };
}

// src/http.ts
var DEFAULT_SERVER = "https://lloydstellar.nl/la2l/api";
var LOCAL_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
function serverAddress(server) {
  const text = (server || DEFAULT_SERVER).trim();
  let url;
  try {
    const base = globalThis.document?.baseURI;
    url = base ? new URL(text, base) : new URL(text);
  } catch (e) {
    throw new TypeError(`Not a server address: ${text}`);
  }
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) throw new TypeError(`Use https for ${text}: plain http works for localhost only.`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`Not a server address: ${text}`);
  return url.href.replace(/\/+$/, "");
}

// src/receiver.ts
var Unpaired = class extends Error {
};
var ID = /^[A-Za-z0-9._-]{1,100}$/;
var JSON_MS = 15e3;
var FILE_MS = 6e5;
var LATER_MS = 3e4;
var timeout = (ms) => typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : void 0;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var serverText = (json) => String(json.error || json.message || "").replace(/[^\w .:'()-]/g, "").slice(0, 80);
function statusText(status, text) {
  const extra = text ? ` ${text}` : "";
  if (status === 401) return "This computer is no longer paired.";
  if (status === 403) return `The server refused this (403).${extra}`;
  if (status === 404) return `The server does not know this address (404).${extra}`;
  if (status === 410) return `This is no longer on the server (410).${extra}`;
  if (status === 413) return `Too large for the server (413).${extra}`;
  if (status === 429) return "The server is busy. Wait a minute and try again.";
  if (status >= 500) return `The server has a problem (${status}). Try again later.`;
  return `The server answered ${status}.${extra}`;
}
var netError = (e) => new Error(e && typeof e === "object" && (e.name === "TimeoutError" || e.name === "AbortError") ? "The server did not answer in time." : "The connection was broken off.");
var TestReceiver = class {
  constructor(options = {}) {
    __publicField(this, "server");
    __publicField(this, "name");
    __publicField(this, "storage");
    __publicField(this, "fetchFn");
    __publicField(this, "o");
    __publicField(this, "pairing", null);
    __publicField(this, "asking", null);
    __publicField(this, "watching", null);
    __publicField(this, "busy", null);
    // Packages not to import now: package id -> until when. A package that failed stays in the inbox
    // until it expires; Live tries it again only when the user clicks Import, and the receiver only
    // after retry().
    __publicField(this, "later", /* @__PURE__ */ new Map());
    __publicField(this, "closed", false);
    this.o = options;
    this.server = serverAddress(options.server);
    this.name = options.name || "Test receiver";
    this.storage = options.storage || memoryStorage();
    this.fetchFn = typeof options.fetch === "function" ? options.fetch : (...args) => fetch(...args);
  }
  /** Whether the receiver has a token. */
  get paired() {
    return !!this.storage.get("token");
  }
  deviceId() {
    let id = this.storage.get("deviceId");
    if (!id) {
      const c = globalThis.crypto;
      id = c && c.randomUUID ? c.randomUUID() : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
      this.storage.set("deviceId", id);
    }
    return id;
  }
  // A JSON call. Resolves to { status, json }, status 0 when the server could not be reached. A
  // 401 on a call with the token means this receiver is no longer paired.
  async api(method, path, body, useToken = true) {
    const headers = {};
    const token = useToken ? this.storage.get("token") : null;
    if (token) headers.Authorization = "Bearer " + token;
    if (body !== void 0) headers["Content-Type"] = "application/json";
    let r;
    try {
      r = await this.fetchFn(this.server + path, { method, headers, body: body === void 0 ? void 0 : JSON.stringify(body), cache: "no-store", signal: timeout(JSON_MS) });
    } catch (e) {
      return { status: 0, json: {} };
    }
    let json = {};
    try {
      const v = await r.json();
      if (v && typeof v === "object" && !Array.isArray(v)) json = v;
    } catch (e) {
    }
    if (r.status === 401 && token) throw new Unpaired();
    return { status: r.status, json };
  }
  error(e) {
    if (e instanceof Unpaired) return this.lost();
    if (this.o.onError) this.o.onError(e);
  }
  /** Starts: watches for packages when it is paired, or asks for a code when it is not. */
  async start() {
    if (!this.paired) {
      await this.pair();
      return;
    }
    try {
      await this.refreshApps();
      this.watch();
    } catch (e) {
      this.error(e);
    }
  }
  /**
   * A code for an app to type, and the wait for it. With the token, the new app joins this
   * receiver (Pair another app). One start at a time: a second one would make the server cancel
   * the code of the first. Resolves to the code, or null when there is none.
   */
  pair() {
    if (!this.asking) this.asking = this.askCode().finally(() => this.asking = null);
    return this.asking;
  }
  async askCode() {
    this.stopPairing();
    let r;
    try {
      r = await this.api("POST", "/pair/start", { device_id: this.deviceId(), device_name: this.name, client: "LA2L test receiver", platform: "web", test: true });
    } catch (e) {
      if (e instanceof Unpaired) {
        this.lost();
        return null;
      }
      throw e;
    }
    if (r.status !== 200 || typeof r.json.code !== "string") {
      throw new Error(r.status === 0 ? "The server does not answer. Try again later." : statusText(r.status, serverText(r.json)));
    }
    const seconds = Math.min(1800, Math.max(30, Number(r.json.expires_in) || 600));
    const p = { pairId: String(r.json.pair_id), expiresAt: Date.now() + seconds * 1e3, pollMs: Math.min(1e4, Math.max(500, Number(r.json.poll_ms) || 2e3)) };
    this.pairing = p;
    if (this.o.onCode) this.o.onCode(r.json.code, p.expiresAt);
    p.timer = setTimeout(() => this.pollPairing(p).catch((e) => this.error(e)), p.pollMs);
    return r.json.code;
  }
  stopPairing() {
    if (!this.pairing) return;
    clearTimeout(this.pairing.timer);
    this.pairing = null;
  }
  async pollPairing(p) {
    if (this.pairing !== p || this.closed) return;
    const r = await this.api("GET", "/pair/" + encodeURIComponent(p.pairId), void 0, false);
    if (this.pairing !== p) return;
    const status = r.status === 404 ? "expired" : String(r.json.status);
    if (r.status === 200 && status === "paired" && typeof r.json.device_token === "string") {
      this.stopPairing();
      this.storage.set("token", r.json.device_token);
      if (this.o.onPaired) this.o.onPaired(String(r.json.app_name || "an app"));
      await this.refreshApps();
      this.watch();
      return;
    }
    if (status === "expired" || status === "cancelled" || Date.now() > p.expiresAt) {
      this.stopPairing();
      if (this.o.onCodeEnded) this.o.onCodeEnded(status === "cancelled" ? "cancelled" : "expired");
      return;
    }
    p.timer = setTimeout(() => this.pollPairing(p).catch((e) => this.error(e)), p.pollMs);
  }
  watch() {
    if (this.watching || this.closed) return;
    const inbox = setInterval(() => this.look(), this.o.pollMs || 3e3);
    const appsMs = this.o.appsMs === void 0 ? 15e3 : this.o.appsMs;
    const apps = appsMs > 0 ? setInterval(() => this.refreshApps().catch((e) => this.error(e)), appsMs) : void 0;
    this.watching = { inbox, apps };
    this.look();
  }
  unwatch() {
    if (!this.watching) return;
    clearInterval(this.watching.inbox);
    if (this.watching.apps) clearInterval(this.watching.apps);
    this.watching = null;
  }
  /** The names of the apps that can send to this receiver now. */
  async refreshApps() {
    const r = await this.api("GET", "/apps");
    if (r.status !== 200 || !Array.isArray(r.json.apps)) return null;
    const names = [...new Set(r.json.apps.map((a) => String(a && a.name || "App")))];
    if (this.o.onApps) this.o.onApps(names);
    return names;
  }
  lost() {
    this.unwatch();
    this.storage.remove("token");
    if (this.o.onLost) this.o.onLost();
    if (!this.closed) this.pair().catch((e) => this.error(e));
  }
  /** Unpairs: the apps can no longer send to this receiver. */
  async stop() {
    try {
      await this.api("POST", "/unpair", {});
    } catch (e) {
      if (!(e instanceof Unpaired)) throw e;
    }
    this.unwatch();
    this.storage.remove("token");
  }
  /** Stops every timer. The pairing stays, for the next start(). */
  close() {
    this.closed = true;
    this.stopPairing();
    this.unwatch();
  }
  /** Tries a package that failed again, as clicking Import again in Live does. */
  retry(packageId) {
    this.later.delete(packageId);
    return this.look();
  }
  /** One look at the inbox, as Import in Live. Resolves when every package found is done. */
  look() {
    if (!this.busy) {
      this.busy = this.lookOnce().catch((e) => this.error(e)).finally(() => this.busy = null);
    }
    return this.busy;
  }
  async lookOnce() {
    if (!this.paired || this.closed) return;
    const r = await this.api("GET", "/inbox");
    if (r.status !== 200) return;
    const list = (Array.isArray(r.json.packages) ? r.json.packages : []).filter((p) => p && typeof p.package_id === "string" && ID.test(p.package_id)).filter((p) => !((this.later.get(p.package_id) ?? 0) > Date.now())).sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    for (const entry of list) await this.importPackage(entry);
  }
  importedList() {
    try {
      const v = JSON.parse(this.storage.get("imported") || "[]");
      return Array.isArray(v) ? v.map(String) : [];
    } catch (e) {
      return [];
    }
  }
  async ack(id, body) {
    const r = await this.api("POST", `/packages/${encodeURIComponent(id)}/ack`, body);
    return r.status === 200;
  }
  async importPackage(entry) {
    const id = entry.package_id;
    const done = this.importedList();
    if (done.includes(id)) {
      await this.ack(id, { status: "imported", items: [], note: "imported before" });
      return;
    }
    const m = await this.api("GET", `/packages/${encodeURIComponent(id)}/manifest`);
    if (m.status !== 200) {
      this.later.set(id, Date.now() + LATER_MS);
      return;
    }
    const check2 = checkManifest(m.json, { as: "device" });
    const report = {
      id,
      title: typeof entry.title === "string" && entry.title ? entry.title : "Package",
      app: typeof entry.app === "string" ? entry.app : "",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      status: "failed",
      placed: 0,
      warnings: check2.warnings,
      sounds: []
    };
    if (!check2.ok) {
      report.error = check2.error;
      this.later.set(id, Infinity);
      await this.ack(id, { status: "failed", error: check2.error, items: [] });
      if (this.o.onReport) this.o.onReport(report);
      return;
    }
    const pkg = check2.package;
    report.title = pkg.title;
    report.app = pkg.app;
    const results = [];
    for (const item of pkg.items) {
      const sound = { name: item.name, kind: item.kind };
      report.sounds.push(sound);
      if (item.error) {
        sound.error = item.error;
        results.push({ id: item.id, name: item.name, status: "failed", error: item.error });
        continue;
      }
      try {
        const blob = await this.download(id, item);
        const info = await checkWav(blob);
        sound.plan = planSound(item, pkg, info.duration);
        sound.info = { format: info.format, bits: info.bitsPerSample, channels: info.channels, rate: info.sampleRate, duration: info.duration, bytes: info.fileBytes };
        results.push({ id: item.id, name: item.name, status: "imported" });
      } catch (e) {
        if (e instanceof Unpaired) throw e;
        sound.error = e instanceof La2lError && e.code === "bad_wav" ? `is not a usable WAV: ${e.message}` : `did not download: ${e.message}`;
        results.push({ id: item.id, name: item.name, status: "failed", error: sound.error });
      }
    }
    const placed = results.filter((x) => x.status === "imported").length;
    report.status = placed === pkg.items.length ? "imported" : placed > 0 ? "partial" : "failed";
    report.placed = placed;
    if (placed > 0) this.storage.set("imported", JSON.stringify([id, ...done].slice(0, 200)));
    if (report.status === "failed") this.later.set(id, Infinity);
    await this.ack(id, { status: report.status, items: results });
    if (this.o.onReport) this.o.onReport(report);
  }
  // One file, with the device's checks and its 3 retries after 1, 2 and 4 seconds for a broken
  // connection, a time limit, a damaged file or a 5xx.
  async download(packageId, item) {
    const url = `${this.server}/packages/${encodeURIComponent(packageId)}/files/${encodeURIComponent(item.file)}`;
    let last = null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (attempt > 0) await sleep(1e3 * 2 ** (attempt - 1));
      let r;
      let blob = null;
      try {
        r = await this.fetchFn(url, { headers: { Authorization: "Bearer " + this.storage.get("token") }, cache: "no-store", signal: timeout(FILE_MS) });
        if (r.status === 200) blob = await r.blob();
      } catch (e) {
        last = netError(e);
        continue;
      }
      if (r.status === 401) throw new Unpaired();
      if (r.status !== 200 || !blob) {
        let json = {};
        try {
          json = await r.json();
        } catch (e) {
        }
        last = new Error(statusText(r.status, serverText(json)));
        if (r.status >= 500) continue;
        throw last;
      }
      const max = item.bytes || LIMITS.maxPackageBytes;
      if (blob.size > max) throw new Error("The file is larger than the package said.");
      if (item.bytes !== null && blob.size !== item.bytes) {
        last = new Error(`The file arrived damaged (${blob.size} instead of ${item.bytes} bytes).`);
        continue;
      }
      if (item.sha256 && await sha256(blob) !== item.sha256) {
        last = new Error("The file arrived damaged (checksum does not match).");
        continue;
      }
      return blob;
    }
    throw last;
  }
};
export {
  TestReceiver,
  Unpaired,
  statusText
};
