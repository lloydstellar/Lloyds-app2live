// The service worker of LA2L Sender, the installed web app. It does one thing: when Android shares
// sounds with LA2L Sender, it keeps them in IndexedDB and opens LA2L Sender with them. It caches
// nothing and answers no other request, so every page stays as fresh as without it.
// Android hands a web app only the files, a title and a text (sdk/BUILD-PROMPT.md, section 11).

const DB = 'la2l-shared';
const STORE = 'shares';
const KEEP_MS = 24 * 3600 * 1000; // a share nobody opened within a day goes

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'POST' || new URL(request.url).pathname !== new URL('share', self.registration.scope).pathname) return;
  event.respondWith(receive(request));
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function receive(request) {
  const page = (query) => Response.redirect(new URL('./?' + query, self.registration.scope).href, 303);
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => typeof f === 'object' && f.size > 0);
    const share = { id: crypto.randomUUID(), at: Date.now(), title: String(form.get('title') || ''), text: String(form.get('text') || ''), files };
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const old = store.getAll();
        old.onsuccess = () => {
          for (const s of old.result) if (s.at < Date.now() - KEEP_MS) store.delete(s.id);
        };
        store.put(share);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
    return page('share=' + share.id);
  } catch (e) {
    // Most often a phone without room for the files.
    return page('share=failed');
  }
}
