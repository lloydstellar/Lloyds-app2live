// la2l 0.1.0: for the browser, as la2l-server serves it at /la2l/vendor/la2l.js.
// SPDX-License-Identifier: Apache-2.0. https://github.com/lloydstellar/Lloyds-app2live
// Built from sdk/js with "npm run build". Do not edit: CI compares it with a fresh build.
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/version.ts
var VERSION = "0.1.0";

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

// src/http.ts
var DEFAULT_SERVER = "https://lloydstellar.nl/la2l/api";
var JSON_MS = 3e4;
var MAX_WAIT_S = 60;
var RETRY_DELAYS_MS = [1e3, 2e3, 4e3];
var sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(aborted());
  const stop = () => {
    clearTimeout(timer);
    reject(aborted());
  };
  const timer = setTimeout(() => {
    if (signal) signal.removeEventListener("abort", stop);
    resolve();
  }, ms);
  if (signal) signal.addEventListener("abort", stop, { once: true });
});
var aborted = () => new La2lError("aborted", "Stopped.");
var unreachable = () => new La2lError("network", "The LA2L server could not be reached. Check the internet connection.");
var tooSlow = () => new La2lError("network", "The LA2L server did not answer in time.");
function serverText(answer) {
  const text = typeof answer.json.error === "string" ? answer.json.error : "";
  return text || `The LA2L server answered ${answer.status}.`;
}
function retryAfterOf(value) {
  const n = value === null ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}
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
function headerValue(text) {
  return Array.from(text).map((ch) => /^[\x20-\x7e]$/.test(ch) ? ch : encodeURIComponent(ch)).join("").slice(0, 200);
}
var Http = class {
  constructor(server, client, fetchFn, ownFetch) {
    __publicField(this, "server", server);
    __publicField(this, "client", client);
    __publicField(this, "fetchFn", fetchFn);
    __publicField(this, "ownFetch", ownFetch);
  }
  headers(token, json) {
    const h = { "X-LA2L-Client": this.client };
    if (token) h.Authorization = "Bearer " + token;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }
  // One exchange. A La2lError when no answer came.
  async once(o) {
    const limit2 = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(JSON_MS) : void 0;
    const signal = o.signal && limit2 && AbortSignal.any ? AbortSignal.any([o.signal, limit2]) : o.signal || limit2;
    let r;
    try {
      r = await this.fetchFn(this.server + o.path, {
        method: o.method,
        headers: this.headers(o.token, o.body !== void 0),
        body: o.body === void 0 ? void 0 : JSON.stringify(o.body),
        cache: "no-store",
        signal
      });
    } catch (e) {
      if (o.signal && o.signal.aborted) throw aborted();
      throw limit2 && limit2.aborted ? tooSlow() : unreachable();
    }
    let json = {};
    try {
      const v = await r.json();
      if (v && typeof v === "object" && !Array.isArray(v)) json = v;
    } catch (e) {
    }
    return { status: r.status, json, retryAfter: retryAfterOf(r.headers.get("Retry-After")) };
  }
  /** A JSON call. Resolves to the answer, whatever its status; rejects only when none came. */
  async call(o) {
    let waits = 0;
    for (let attempt = 0; ; attempt++) {
      let answer = null;
      let failure = null;
      try {
        answer = await this.once(o);
      } catch (e) {
        if (!(e instanceof La2lError) || e.code === "aborted") throw e;
        failure = e;
      }
      if (answer && answer.status === 429 && answer.retryAfter !== null && answer.retryAfter <= MAX_WAIT_S && waits < 2) {
        waits++;
        await sleep(answer.retryAfter * 1e3, o.signal);
        attempt--;
        continue;
      }
      const broken = !!failure && o.retry === true;
      const again = !!o.retry && attempt < RETRY_DELAYS_MS.length && (broken || !!answer && answer.status >= 500);
      if (!again) {
        if (failure) throw failure;
        return answer;
      }
      await sleep(RETRY_DELAYS_MS[attempt], o.signal);
    }
  }
  /**
   * One file to the server. In a browser through XMLHttpRequest, which can tell the progress of
   * an upload; elsewhere through fetch. Resolves to the answer; rejects when none came.
   */
  upload(o) {
    if (!this.ownFetch && typeof XMLHttpRequest === "function") return this.uploadXhr(o);
    return this.uploadFetch(o);
  }
  async uploadFetch(o) {
    let r;
    try {
      r = await this.fetchFn(this.server + o.path, {
        method: "PUT",
        headers: Object.assign(this.headers(o.token), { "Content-Type": "audio/wav" }),
        body: o.data,
        signal: o.signal
      });
    } catch (e) {
      throw o.signal && o.signal.aborted ? aborted() : new La2lError("network", "The upload broke off. Check the internet connection.");
    }
    let json = {};
    try {
      const v = await r.json();
      if (v && typeof v === "object" && !Array.isArray(v)) json = v;
    } catch (e) {
    }
    if (o.onProgress) o.onProgress(1);
    return { status: r.status, json, retryAfter: retryAfterOf(r.headers.get("Retry-After")) };
  }
  uploadXhr(o) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", this.server + o.path);
      for (const [name, value] of Object.entries(Object.assign(this.headers(o.token), { "Content-Type": "audio/wav" }))) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && o.onProgress) o.onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let json = {};
        try {
          const v = JSON.parse(xhr.responseText);
          if (v && typeof v === "object" && !Array.isArray(v)) json = v;
        } catch (e) {
        }
        resolve({ status: xhr.status, json, retryAfter: retryAfterOf(xhr.getResponseHeader("Retry-After")) });
      };
      xhr.onerror = () => reject(new La2lError("network", "The upload broke off. Check the internet connection."));
      xhr.onabort = () => reject(aborted());
      if (o.signal) {
        if (o.signal.aborted) return reject(aborted());
        o.signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
      xhr.send(o.data);
    });
  }
};

// src/storage.ts
function memoryStorage() {
  const values = /* @__PURE__ */ new Map();
  return {
    get: (key) => values.has(key) ? values.get(key) : null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key)
  };
}
function localStorageWith(prefix) {
  let ls;
  try {
    ls = globalThis.localStorage;
    if (!ls) return null;
  } catch (e) {
    return null;
  }
  const backup = memoryStorage();
  return {
    get(key) {
      const kept = backup.get(key);
      if (kept !== null) return kept;
      try {
        return ls.getItem(prefix + key);
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        ls.setItem(prefix + key, value);
        backup.remove(key);
      } catch (e) {
        backup.set(key, value);
      }
    },
    remove(key) {
      backup.remove(key);
      try {
        ls.removeItem(prefix + key);
      } catch (e) {
      }
    }
  };
}
function nodeModules() {
  const proc = globalThis.process;
  if (!proc || typeof proc.getBuiltinModule !== "function") return null;
  try {
    return { fs: proc.getBuiltinModule("node:fs"), path: proc.getBuiltinModule("node:path"), os: proc.getBuiltinModule("node:os") };
  } catch (e) {
    return null;
  }
}
function configFolder() {
  const node = nodeModules();
  if (!node) return null;
  const env = globalThis.process;
  const vars = env && env.env || {};
  const platform2 = env && env.platform || "";
  if (vars.LA2L_CONFIG_DIR) return vars.LA2L_CONFIG_DIR;
  if (platform2 === "win32") return node.path.join(vars.APPDATA || node.path.join(node.os.homedir(), "AppData", "Roaming"), "la2l");
  if (platform2 === "darwin") return node.path.join(node.os.homedir(), "Library", "Application Support", "la2l");
  return node.path.join(vars.XDG_CONFIG_HOME || node.path.join(node.os.homedir(), ".config"), "la2l");
}
function fileStorage(name) {
  const node = nodeModules();
  const dir = configFolder();
  if (!node || !dir) return null;
  const file = node.path.join(dir, `${name}.json`);
  let memory = null;
  const read = () => {
    try {
      const v = JSON.parse(node.fs.readFileSync(file, "utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch (e) {
      return {};
    }
  };
  const write = (values) => {
    try {
      node.fs.mkdirSync(dir, { recursive: true, mode: 448 });
      const part = `${file}.${Date.now()}.part`;
      node.fs.writeFileSync(part, JSON.stringify(values, null, 2) + "\n", { mode: 384 });
      node.fs.chmodSync(part, 384);
      node.fs.renameSync(part, file);
      return true;
    } catch (e) {
      const code = e.code || e.message;
      console.warn(`la2l: cannot write ${file} (${code}). The pairing is kept in memory only, until this program ends.`);
      memory = memoryStorage();
      for (const [k, v] of Object.entries(values)) memory.set(k, v);
      return false;
    }
  };
  return {
    get(key) {
      if (memory) return memory.get(key);
      const v = read()[key];
      return typeof v === "string" ? v : null;
    },
    set(key, value) {
      if (memory) return memory.set(key, value);
      const values = read();
      values[key] = value;
      write(values);
    },
    remove(key) {
      if (memory) return memory.remove(key);
      const values = read();
      if (!(key in values)) return;
      delete values[key];
      write(values);
    }
  };
}
function shortHash(text) {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function storageName(appKey) {
  const slug = appKey.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "app";
  return slug === appKey.toLowerCase() ? slug : `${slug}-${shortHash(appKey)}`;
}
function defaultStorage(appKey) {
  const name = storageName(appKey);
  const proc = globalThis.process;
  const inNode = !!(proc && proc.versions && proc.versions.node);
  return inNode && fileStorage(name) || localStorageWith(`la2l.${name}.`) || fileStorage(name) || memoryStorage();
}

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

// src/client.ts
var CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
var STATUSES = ["uploading", "waiting", "imported", "partial", "failed", "expired"];
var NO_CHECKSUM = "0".repeat(64);
function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
var sizeOf = (a) => typeof Blob !== "undefined" && a instanceof Blob ? a.size : a.byteLength;
var asBlob = (a) => typeof Blob !== "undefined" && a instanceof Blob ? a : new Blob([a]);
function fileName(wanted, index, taken) {
  let base = wanted.replace(/\.wav$/i, "").normalize("NFKD").replace(/[^A-Za-z0-9 ._-]/g, "").replace(/\.{2,}/g, ".").replace(/^[^A-Za-z0-9]+/, "").slice(0, 90).replace(/[ ._-]+$/, "");
  if (!base) base = `sound ${index + 1}`;
  let file = base + ".wav";
  for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${base}-${n}.wav`;
  taken.add(file.toLowerCase());
  return file;
}
var LA2L = class {
  constructor(options) {
    __publicField(this, "appName");
    __publicField(this, "appId");
    __publicField(this, "server");
    __publicField(this, "appVersion");
    __publicField(this, "storage");
    /** @internal */
    __publicField(this, "http");
    if (!options || typeof options.appName !== "string" || !options.appName.trim()) {
      throw new TypeError('LA2L needs an appName: the name LA2L shows in Live, "Paired with <appName>".');
    }
    this.appName = options.appName.trim();
    this.appVersion = typeof options.appVersion === "string" ? options.appVersion : "";
    this.server = serverAddress(options.server);
    this.storage = options.storage || defaultStorage(options.appId || this.appName);
    let appId = options.appId || this.storage.get("appId");
    if (!appId) {
      appId = newId();
      this.storage.set("appId", appId);
    }
    this.appId = appId;
    const ownFetch = typeof options.fetch === "function";
    const fetchFn = ownFetch ? options.fetch : (...args) => fetch(...args);
    this.http = new Http(this.server, `la2l-js/${VERSION} (${headerValue(this.appName.slice(0, 60))})`, fetchFn, ownFetch);
  }
  /** Whether this app has a token. A token can still turn out to be revoked: then a call gives not_paired. */
  get paired() {
    return !!this.storage.get("token");
  }
  /** The name of the computer this app is paired with, as the server last said it. */
  get deviceName() {
    return this.paired ? this.storage.get("deviceName") : null;
  }
  /**
   * Forgets the pairing here only. The server keeps the token until LA2L in Live unpairs, but
   * nobody has it any more. unpair() also tells the server.
   */
  forget() {
    this.storage.remove("token");
    this.storage.remove("deviceName");
  }
  /** @internal The token, or a not_paired error. */
  token() {
    const token = this.storage.get("token");
    if (!token) throw new La2lError("not_paired", "This app is not paired. Type the code LA2L shows in Live.");
    return token;
  }
  /** @internal Turns an error answer into a La2lError. */
  fail(answer, codeFor4xx = "server") {
    const message = serverText(answer);
    const status = answer.status;
    if (status === 401) {
      this.forget();
      return new La2lError("not_paired", message, { status });
    }
    if (status === 429) return new La2lError("rate_limited", message, { status, retryAfter: answer.retryAfter });
    if (status === 507) return new La2lError("server_full", message, { status });
    if (status >= 500) return new La2lError("server", message, { status });
    return new La2lError(codeFor4xx, message, { status });
  }
  /**
   * Pairs this app with the computer that shows the code. In Live the user clicks Pair app in LA2L
   * (or Settings > Add app) and reads a code like "K7P 42Q"; case, spaces and dashes do not matter.
   */
  async pair(code) {
    const typed = typeof code === "string" ? code.toUpperCase().replace(/[\s-]/g, "") : "";
    if (!CODE.test(typed)) throw new La2lError("bad_code", "A code has 6 letters and digits, like K7P 42Q.");
    const answer = await this.http.call({ method: "POST", path: "/pair/claim", body: { code: typed, app_name: this.appName, app_id: this.appId } });
    if (answer.status === 404) throw new La2lError("bad_code", serverText(answer), { status: 404 });
    if (answer.status !== 200 || typeof answer.json.app_token !== "string") throw this.fail(answer);
    const deviceName = typeof answer.json.device_name === "string" ? answer.json.device_name : "your computer";
    this.storage.set("token", answer.json.app_token);
    this.storage.set("deviceName", deviceName);
    return { deviceName };
  }
  /** Which computer this app is paired with. Ask it now and then; not_paired means: pair again. */
  async me() {
    const answer = await this.http.call({ method: "GET", path: "/app/me", token: this.token(), retry: true });
    if (answer.status !== 200) throw this.fail(answer);
    const deviceName = String(answer.json.device_name || "");
    this.storage.set("deviceName", deviceName);
    return { deviceName, appName: String(answer.json.app_name || ""), pairedAt: String(answer.json.paired_at || "") };
  }
  /**
   * Unpairs this app: the server revokes the token, and it is forgotten here. When the server
   * cannot be reached, this rejects with `network` and keeps the token, so the app can try again,
   * or call forget().
   */
  async unpair() {
    const token = this.storage.get("token");
    if (!token) return;
    const answer = await this.http.call({ method: "POST", path: "/app/unpair", body: {}, token, retry: true });
    if (answer.status !== 200 && answer.status !== 401) throw this.fail(answer);
    this.forget();
  }
  /**
   * Sends sounds to LA2L. Everything is checked before the first byte goes out, with the texts the
   * server and LA2L use. Then it announces the package, uploads the files one by one and commits.
   * Resolves to a Delivery, which follows the package until it is in Live.
   */
  async send(options) {
    const token = this.token();
    const sounds = options && Array.isArray(options.sounds) ? options.sounds : [];
    if (!sounds.length) throw new La2lError("bad_package", "The package has no sounds.");
    if (sounds.length > LIMITS.maxItems) throw new La2lError("bad_package", `The package has ${sounds.length} sounds. LA2L takes ${LIMITS.maxItems} at most. Send them in more packages.`);
    const progress = options.onProgress || (() => {
    });
    const signal = options.signal;
    const taken = /* @__PURE__ */ new Set();
    const items = [];
    let total = 0;
    for (const [i, s] of sounds.entries()) {
      if (!s || !s.audio) throw new La2lError("bad_package", `Sound ${i + 1} has no audio.`);
      const fromFile = typeof File !== "undefined" && s.audio instanceof File ? s.audio.name : "";
      const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : fromFile.replace(/\.[^.]*$/, "") || `Sound ${i + 1}`;
      if (s.kind !== "loop" && s.kind !== "oneshot") throw new La2lError("bad_package", `${name}: kind must be "loop" or "oneshot".`);
      try {
        await checkWav(s.audio);
      } catch (e) {
        if (e instanceof La2lError) throw new La2lError("bad_wav", `${name} is not a usable WAV: ${e.message}`);
        throw e;
      }
      const file = s.file !== void 0 ? s.file : fileName(fromFile || name, i, taken);
      if (s.file !== void 0) taken.add(String(s.file).toLowerCase());
      const bytes = sizeOf(s.audio);
      total += bytes;
      const item = { id: s.id || `sound-${i + 1}`, file, bytes, sha256: s.sha256 || NO_CHECKSUM, name, kind: s.kind };
      if (s.role !== void 0) item.role = s.role;
      if (s.bpm !== void 0) item.bpm = s.bpm;
      if (s.lengthBeats !== void 0) item.length_beats = s.lengthBeats;
      if (s.warpMode !== void 0) item.warp_mode = s.warpMode;
      if (s.color !== void 0) item.color = s.color;
      if (s.gainDb !== void 0) item.gain_db = s.gainDb;
      items.push(item);
    }
    if (total > LIMITS.maxPackageBytes) {
      throw new La2lError("bad_package", `The package is ${megabytes(total)}. LA2L takes ${megabytes(LIMITS.maxPackageBytes)} at most. Send the sounds in more packages.`);
    }
    const app = typeof options.appName === "string" && options.appName.trim() ? options.appName.trim() : this.appName;
    const manifest = { schema: SCHEMA, created_at: (/* @__PURE__ */ new Date()).toISOString(), source: { app, app_version: this.appVersion, platform: platform() }, items };
    if (options.title !== void 0) manifest.title = options.title;
    const tempo = {};
    if (options.bpm !== void 0) tempo.bpm = options.bpm;
    if (options.timeSignature !== void 0) tempo.time_signature = options.timeSignature;
    if (Object.keys(tempo).length) manifest.tempo = tempo;
    const check2 = checkManifest(manifest);
    if (!check2.ok) throw new La2lError("bad_package", check2.error);
    for (const [i, s] of sounds.entries()) {
      if (signal && signal.aborted) throw aborted();
      progress(0, { stage: "checking", sound: i, soundShare: 0 });
      if (!s.sha256) items[i].sha256 = await sha256(s.audio);
    }
    const created = await this.http.call({ method: "POST", path: "/packages", body: manifest, token, signal, retry: "5xx" });
    if (created.status !== 201 || typeof created.json.package_id !== "string") throw this.fail(created, "bad_package");
    const packageId = created.json.package_id;
    const upload = created.json.upload || {};
    let sent = 0;
    try {
      for (const [i, s] of sounds.entries()) {
        const bytes = sizeOf(s.audio);
        const share = (part) => {
          progress(total ? (sent + part * bytes) / total : 1, { stage: "uploading", sound: i, soundShare: part });
        };
        await this.uploadFile(upload[items[i].file] || `/packages/${packageId}/files/${encodeURIComponent(items[i].file)}`, asBlob(s.audio), token, share, signal);
        sent += bytes;
      }
      const commit = await this.http.call({ method: "POST", path: `/packages/${packageId}/commit`, body: {}, token, signal, retry: true });
      if (commit.status !== 200) throw this.fail(commit, "bad_package");
    } catch (e) {
      if (!(e instanceof La2lError && e.code === "not_paired")) this.http.call({ method: "DELETE", path: `/packages/${packageId}`, token }).catch(() => {
      });
      throw e;
    }
    progress(1, { stage: "uploading", sound: sounds.length - 1, soundShare: 1 });
    const warnings = Array.isArray(created.json.warnings) ? created.json.warnings.map(String) : [];
    return new Delivery(this, packageId, warnings, typeof created.json.expires_at === "string" ? created.json.expires_at : null);
  }
  // One file, started again when the connection breaks or the server answers 5xx: the server
  // cannot resume an upload. After a connection broke without a word (a phone that switches from
  // Wi-Fi to 4G), the server still holds the first upload until it gives up on it, after about a
  // minute; until then it answers 409. Those are waited out too.
  async uploadFile(path, data, token, share, signal) {
    const delays = [1e3, 2e3, 4e3];
    const busyDelays = [5e3, 1e4, 2e4, 4e4];
    let tries = 0;
    let busyTries = 0;
    for (; ; ) {
      share(0);
      let answer = null;
      let failure = null;
      try {
        answer = await this.http.upload({ path, token, data, signal, onProgress: share });
      } catch (e) {
        if (!(e instanceof La2lError) || e.code === "aborted") throw e;
        failure = e;
      }
      if (answer && answer.status === 200) return;
      const damaged = !!answer && answer.status === 422 && /arrived damaged/.test(String(answer.json.error));
      const busy = !!answer && answer.status === 409;
      if (busy && busyTries < busyDelays.length) {
        await sleep(busyDelays[busyTries++], signal);
        continue;
      }
      if ((failure || answer && answer.status >= 500 || damaged) && tries < delays.length) {
        await sleep(delays[tries++], signal);
        continue;
      }
      if (failure) throw failure;
      const a = answer;
      if (busy || damaged) throw new La2lError("network", serverText(a), { status: a.status });
      if (a.status === 422) throw new La2lError("bad_wav", serverText(a), { status: 422 });
      if (a.status === 404) throw new La2lError("expired", serverText(a), { status: 404 });
      throw this.fail(a, "bad_package");
    }
  }
  /** Follows a package that was sent earlier, for example after the page was reloaded. */
  delivery(packageId) {
    return new Delivery(this, packageId, [], null);
  }
};
function platform() {
  const g = globalThis;
  if (g.document) return "web";
  if (g.Deno) return "deno";
  if (g.Bun) return "bun";
  if (g.process && g.process.versions && g.process.versions.node) return "node";
  return "js";
}
var Delivery = class {
  constructor(la2l, packageId, warnings, expiresAt) {
    __publicField(this, "la2l", la2l);
    __publicField(this, "packageId", packageId);
    __publicField(this, "warnings", warnings);
    __publicField(this, "expiresAt", expiresAt);
  }
  /** Where the package is now. A package the server no longer knows counts as expired. */
  async status() {
    const answer = await this.la2l.http.call({ method: "GET", path: `/packages/${encodeURIComponent(this.packageId)}/status`, token: this.la2l.token(), retry: true });
    if (answer.status === 404) return { status: "expired", sounds: [], updatedAt: null };
    if (answer.status !== 200) throw this.la2l.fail(answer);
    const j = answer.json;
    const status = STATUSES.includes(String(j.status)) ? j.status : "waiting";
    const sounds = (Array.isArray(j.items) ? j.items : []).filter((x) => !!x && typeof x === "object").map((x) => {
      const r = { id: String(x.id ?? ""), name: String(x.name ?? ""), status: x.status === "imported" ? "imported" : "failed" };
      if (typeof x.error === "string") r.error = x.error;
      return r;
    });
    const result = { status, sounds, updatedAt: typeof j.updated_at === "string" ? j.updated_at : null };
    if (typeof j.error === "string") result.error = j.error;
    return result;
  }
  /**
   * Waits until the user clicks Import in Live. Resolves when the sounds are in Live (`imported`,
   * or `partial` with the result per sound); rejects with import_failed or expired.
   */
  async imported(options = {}) {
    const every = Math.max(1e3, options.intervalMs || 3e3);
    for (; ; ) {
      if (options.signal && options.signal.aborted) throw aborted();
      let st = null;
      try {
        st = await this.status();
      } catch (e) {
        if (!(e instanceof La2lError && e.code === "network")) throw e;
      }
      if (st && (st.status === "imported" || st.status === "partial")) return st;
      if (st && st.status === "expired") throw new La2lError("expired", "The package expired before it was imported in Live.");
      if (st && st.status === "failed") {
        const first = st.sounds.find((x) => x.status === "failed");
        const why = st.error || (first ? `${first.name} ${first.error || "was not imported"}` : "LA2L could not import it.");
        throw new La2lError("import_failed", `Live could not import it. ${why}`.trim());
      }
      await sleep(every, options.signal);
    }
  }
  /** Takes the package back, until it is in Live. */
  async cancel() {
    const answer = await this.la2l.http.call({ method: "DELETE", path: `/packages/${encodeURIComponent(this.packageId)}`, token: this.la2l.token(), retry: true });
    if (answer.status === 200) return;
    if (answer.status === 409) throw new La2lError("server", serverText(answer), { status: 409 });
    if (answer.status === 404) throw new La2lError("expired", serverText(answer), { status: 404 });
    throw this.la2l.fail(answer);
  }
};

// src/audio.ts
function wavFromSamples(channels, sampleRate, options = {}) {
  const list = isList(channels) ? channels : [channels];
  const bits = options.bits ?? 16;
  if (![16, 24, 32].includes(bits)) throw new TypeError("bits must be 16, 24 or 32 (32 is float).");
  if (list.length < 1 || list.length > 2) throw new TypeError("Give one channel (mono) or two (stereo): Live places mono and stereo files only.");
  if (!Number.isInteger(sampleRate) || sampleRate < 8e3 || sampleRate > 192e3) throw new TypeError("The sample rate must be a whole number from 8000 to 192000.");
  const frames = list[0].length;
  if (!frames) throw new TypeError("There are no samples.");
  if (list.some((c) => c.length !== frames)) throw new TypeError("Every channel must have as many samples.");
  const float = bits === 32;
  const bytes = bits / 8;
  const block = list.length * bytes;
  const dataBytes = frames * block;
  const fmtBytes = float ? 18 : 16;
  const header = 12 + 8 + fmtBytes + (float ? 12 : 0) + 8;
  const out = new DataView(new ArrayBuffer(header + dataBytes));
  let at = 0;
  const text = (s) => {
    for (let i = 0; i < s.length; i++) out.setUint8(at++, s.charCodeAt(i));
  };
  const u162 = (v) => (out.setUint16(at, v, true), at += 2);
  const u322 = (v) => (out.setUint32(at, v, true), at += 4);
  text("RIFF");
  u322(header + dataBytes - 8);
  text("WAVE");
  text("fmt ");
  u322(fmtBytes);
  u162(float ? 3 : 1);
  u162(list.length);
  u322(sampleRate);
  u322(sampleRate * block);
  u162(block);
  u162(bits);
  if (float) {
    u162(0);
    text("fact");
    u322(4);
    u322(frames);
  }
  text("data");
  u322(dataBytes);
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
          out.setUint8(at, s & 255);
          out.setUint8(at + 1, s >> 8 & 255);
          out.setUint8(at + 2, s >> 16 & 255);
        }
      }
      at += bytes;
    }
  }
  return new Blob([out.buffer], { type: "audio/wav" });
}
function isList(v) {
  return Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null && "length" in v[0];
}
function wavFromAudioBuffer(buffer, options = {}) {
  const n = buffer.numberOfChannels;
  const data = Array.from({ length: n }, (_, c) => buffer.getChannelData(c));
  if (n <= 2) return wavFromSamples(data, buffer.sampleRate, options);
  const mix = (side) => {
    const out = new Float32Array(buffer.length);
    const sources = data.filter((_, c) => c % 2 === side);
    for (const s of sources) for (let i = 0; i < out.length; i++) out[i] += s[i] / sources.length;
    return out;
  };
  return wavFromSamples([mix(0), mix(1)], buffer.sampleRate, options);
}
async function toWav(file, options = {}) {
  try {
    await checkWav(file);
    return file;
  } catch (e) {
  }
  const g = globalThis;
  if (!g.OfflineAudioContext) throw new TypeError("toWav needs a browser with Web Audio.");
  const context = new g.OfflineAudioContext(2, 1, options.sampleRate || 48e3);
  let buffer;
  try {
    buffer = await context.decodeAudioData(await file.arrayBuffer());
  } catch (e) {
    throw new La2lError("bad_wav", "This file cannot be read as sound. Send a WAV, MP3 or M4A file.");
  }
  const bits = options.bits || 16;
  const bytes = 44 + buffer.length * Math.min(2, buffer.numberOfChannels) * (bits / 8);
  if (options.maxBytes !== void 0 && bytes > options.maxBytes) {
    throw new La2lError("bad_wav", `This sound is too long: as WAV it would be ${megabytes(bytes)}. LA2L takes ${megabytes(options.maxBytes)} at most.`);
  }
  return wavFromAudioBuffer(buffer, { bits });
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
export {
  DEFAULT_SERVER,
  Delivery,
  LA2L,
  LIMITS,
  La2lError,
  MAX_CHUNKS,
  ROLES,
  SCHEMA,
  Sha256,
  VERSION,
  WARP_MODE_NAMES,
  checkManifest,
  checkWav,
  cleanName,
  isValidFileName,
  megabytes,
  memoryStorage,
  parseColor,
  parseWarpMode,
  planSound,
  sha256,
  snapBeats,
  toWav,
  wavFromAudioBuffer,
  wavFromSamples
};
