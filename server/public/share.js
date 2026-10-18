// What another app shared with LA2L Sender, the installed web app: the service worker (sw.js)
// keeps the files, the title and the text in IndexedDB, and the page takes them from there. The
// text may hold a description of the sounds, app2live/1 (docs/manifest.md, "The share text").

const DB = 'la2l-shared';
const STORE = 'shares';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The share with this id, taken out of IndexedDB, or null when it is not there (any more). */
export async function takeShare(id) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let share = null;
      const get = store.get(id);
      get.onsuccess = () => {
        share = get.result || null;
        if (share) store.delete(id);
      };
      tx.oncomplete = () => resolve(share);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * The description in a shared text: from the first { to the last }, so an app may put a line of
 * its own around it. Resolves to { manifest }, { error } when there is one that does not work,
 * or null when the text has none.
 */
export function manifestFromText(text) {
  const first = typeof text === 'string' ? text.indexOf('{') : -1;
  const last = first < 0 ? -1 : text.lastIndexOf('}');
  if (first < 0 || last < first) return null;
  let json;
  try {
    json = JSON.parse(text.slice(first, last + 1));
  } catch (e) {
    return { error: 'The app shared a description of the sounds that is not valid JSON. Set them below.' };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { error: 'The app shared a description of the sounds that LA2L cannot read. Set them below.' };
  if (json.schema !== 'app2live/1') return { error: `The app shared a description in ${String(json.schema || 'an unknown form').slice(0, 30)}, which LA2L does not know. Set the sounds below.` };
  return { manifest: json };
}

/** The item of the description for a shared file: by its name, else by its name in any case. */
export function itemFor(manifest, fileName) {
  const items = Array.isArray(manifest.items) ? manifest.items.filter((it) => it && typeof it === 'object' && typeof it.file === 'string') : [];
  return items.find((it) => it.file === fileName) || items.find((it) => it.file.toLowerCase() === fileName.toLowerCase()) || null;
}

/** The files the description names that were not shared. */
export function missingFiles(manifest, fileNames) {
  const have = new Set(fileNames.map((n) => n.toLowerCase()));
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  return items.filter((it) => it && typeof it.file === 'string' && !have.has(it.file.toLowerCase())).map((it) => it.file);
}
