// IndexedDB: sessioni, campioni (1/s), eventi, slice waterfall, marker, clip audio.
'use strict';

const DB_NAME = 'lfh';
const DB_VERSION = 1;
let db = null;

export function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      const mk = (name, keyPath) => {
        const s = d.createObjectStore(name, { keyPath });
        s.createIndex('bySession', 'sessionId', { unique: false });
        return s;
      };
      d.createObjectStore('sessions', { keyPath: 'id' });
      mk('samples', ['sessionId', 't']);
      mk('events', 'id');
      mk('slices', ['sessionId', 't']);
      mk('markers', 'id');
      mk('clips', 'id');
    };
    req.onsuccess = e => { db = e.target.result; res(db); };
    req.onerror = e => rej(e.target.error);
  });
}

export function dbPut(store, obj) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

export function dbBatch(store, objs) {
  return new Promise((res, rej) => {
    if (!objs.length) { res(); return; }
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    objs.forEach(o => os.put(o));
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

export function dbGet(store, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = e => rej(e.target.error);
  });
}

export function dbAll(store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = e => rej(e.target.error);
  });
}

export function dbBySession(store, sessionId) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store)
      .index('bySession').getAll(sessionId);
    req.onsuccess = () => res(req.result);
    req.onerror = e => rej(e.target.error);
  });
}

export function dbDel(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

export function dbDelBySession(store, sessionId) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).index('bySession').openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = e => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

export async function deleteSessionData(sessionId) {
  await dbDel('sessions', sessionId);
  for (const s of ['samples', 'events', 'slices', 'markers', 'clips']) {
    await dbDelBySession(s, sessionId);
  }
}

// Storage persistente: chiede al browser di non cancellare i dati (le prove)
// sotto pressione di spazio. Da chiamare al primo avvio di una sessione.
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* non supportato */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    }
  } catch { /* non supportato */ }
  return null;
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}
