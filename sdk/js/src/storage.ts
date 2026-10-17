// Where the SDK keeps the app token, the name of the computer and the app id. In a browser that
// is localStorage, in Node.js a file in the user's config folder that only the user can read.
// An app can pass its own { get, set, remove } instead.

/** A place for a few strings. The keys are "token", "deviceName" and "appId". */
export interface La2lStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Keeps everything in memory, for as long as the program runs. */
export function memoryStorage(): La2lStorage {
  const values = new Map<string, string>();
  return {
    get: (key) => (values.has(key) ? (values.get(key) as string) : null),
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

// Where localStorage is blocked (a private window in some browsers, a sandboxed frame) or full,
// the values live in memory instead. What is in memory comes first, so a value that could not be
// written is still read back.
function localStorageWith(prefix: string): La2lStorage | null {
  let ls: Storage;
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
        // only in memory, and gone there
      }
    },
  };
}

type NodeModules = {
  fs: {
    readFileSync(file: string, encoding: 'utf8'): string;
    writeFileSync(file: string, data: string, options: { mode: number }): void;
    mkdirSync(dir: string, options: { recursive: true; mode: number }): void;
    chmodSync(file: string, mode: number): void;
    renameSync(from: string, to: string): void;
  };
  path: { join(...parts: string[]): string };
  os: { homedir(): string };
};

// node:fs and friends, without a static import, so the same code runs in a browser.
function nodeModules(): NodeModules | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (name: string) => unknown; versions?: { node?: string } } }).process;
  if (!proc || typeof proc.getBuiltinModule !== 'function') return null;
  try {
    return { fs: proc.getBuiltinModule('node:fs') as NodeModules['fs'], path: proc.getBuiltinModule('node:path') as NodeModules['path'], os: proc.getBuiltinModule('node:os') as NodeModules['os'] };
  } catch (e) {
    return null;
  }
}

/** The folder for the files of la2l: the user's config folder, as each system has it. */
export function configFolder(): string | null {
  const node = nodeModules();
  if (!node) return null;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined>; platform?: string } }).process;
  const vars = (env && env.env) || {};
  const platform = (env && env.platform) || '';
  if (vars.LA2L_CONFIG_DIR) return vars.LA2L_CONFIG_DIR;
  if (platform === 'win32') return node.path.join(vars.APPDATA || node.path.join(node.os.homedir(), 'AppData', 'Roaming'), 'la2l');
  if (platform === 'darwin') return node.path.join(node.os.homedir(), 'Library', 'Application Support', 'la2l');
  return node.path.join(vars.XDG_CONFIG_HOME || node.path.join(node.os.homedir(), '.config'), 'la2l');
}

/**
 * A JSON file in the user's config folder, readable by the user only (mode 0600, in a folder of
 * mode 0700). Null where there is no Node.js file system. When the file cannot be written (a
 * read-only home in a container, for example), the values live in memory, with one warning.
 */
export function fileStorage(name: string): La2lStorage | null {
  const node = nodeModules();
  const dir = configFolder();
  if (!node || !dir) return null;
  const file = node.path.join(dir, `${name}.json`);
  let memory: La2lStorage | null = null;
  const read = (): Record<string, string> => {
    try {
      const v = JSON.parse(node.fs.readFileSync(file, 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) {
      return {};
    }
  };
  const write = (values: Record<string, string>): boolean => {
    try {
      node.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const part = `${file}.${Date.now()}.part`;
      node.fs.writeFileSync(part, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
      node.fs.chmodSync(part, 0o600);
      node.fs.renameSync(part, file);
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code || (e as Error).message;
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
      return typeof v === 'string' ? v : null;
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
    },
  };
}

// FNV-1a: a short, steady hash of a name, without crypto.
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0) as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A name for an app's keys and file: "Web808" -> "web808". When that loses anything but the case
 * ("Web 808", "Erik’s Beats", "Битмейкер"), a short hash of the name follows, so every app name
 * keeps keys of its own: "web-808-1c2f9a0b".
 */
export function storageName(appKey: string): string {
  const slug =
    appKey
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'app';
  return slug === appKey.toLowerCase() ? slug : `${slug}-${shortHash(appKey)}`;
}

/**
 * A file in Node.js, localStorage in a browser, else memory. Node.js comes first, because newer
 * versions have a localStorage of their own that may only last as long as the program.
 */
export function defaultStorage(appKey: string): La2lStorage {
  const name = storageName(appKey);
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  const inNode = !!(proc && proc.versions && proc.versions.node);
  return (inNode && fileStorage(name)) || localStorageWith(`la2l.${name}.`) || fileStorage(name) || memoryStorage();
}
