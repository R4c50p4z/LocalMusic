// Almacenamiento local con IndexedDB.
// - songs:     metadatos de cada canción (ligeros, se cargan todos al arrancar)
// - audio:     el fichero de audio (Blob), se lee sólo al reproducir
// - covers:    carátulas (Blob), compartidas entre canciones del mismo álbum
// - playlists: listas creadas por el usuario
// - kv:        ajustes y estado (me gusta, cola, etc.)

const DB_NAME = 'localmusic';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
      if (!db.objectStoreNames.contains('covers')) db.createObjectStore('covers');
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(store) {
  const db = await open();
  return reqP(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await open();
  return reqP(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  return done(tx);
}

export async function del(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export async function hasKey(store, key) {
  const db = await open();
  const n = await reqP(db.transaction(store).objectStore(store).count(key));
  return n > 0;
}

/** Guarda una canción con su audio y (si no existe ya) su carátula, en una sola transacción. */
export async function addSong(song, audioBlob, coverBlob) {
  const db = await open();
  const tx = db.transaction(['songs', 'audio', 'covers'], 'readwrite');
  tx.objectStore('songs').put(song);
  tx.objectStore('audio').put(audioBlob, song.id);
  if (coverBlob && song.coverId) tx.objectStore('covers').put(coverBlob, song.coverId);
  return done(tx);
}

/** Borra canciones (y su audio) y las carátulas indicadas. */
export async function deleteSongsAndCovers(songIds, coverIds) {
  const db = await open();
  const tx = db.transaction(['songs', 'audio', 'covers'], 'readwrite');
  for (const id of songIds) {
    tx.objectStore('songs').delete(id);
    tx.objectStore('audio').delete(id);
  }
  for (const c of coverIds) tx.objectStore('covers').delete(c);
  return done(tx);
}

export async function clearAll() {
  const db = await open();
  const stores = ['songs', 'audio', 'covers', 'playlists', 'kv'];
  const tx = db.transaction(stores, 'readwrite');
  for (const s of stores) tx.objectStore(s).clear();
  return done(tx);
}

/** Devuelve [clave, valor] de todo un almacén. */
export async function entries(store) {
  const db = await open();
  const tx = db.transaction(store);
  const os = tx.objectStore(store);
  const [keys, values] = await Promise.all([reqP(os.getAllKeys()), reqP(os.getAll())]);
  return keys.map((k, i) => [k, values[i]]);
}
