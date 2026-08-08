// Extension-origin blob storage. Queue records keep small metadata/reference
// objects in chrome.storage.local; image bytes live here in IndexedDB.

(() => {
  const DB_NAME = 'dogear-assets';
  const DB_VERSION = 1;
  const STORE_NAME = 'assets';

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('sha256', 'sha256', { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transaction(mode, run) {
    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, mode);
      const result = await run(tx.objectStore(STORE_NAME));
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return result;
    } finally {
      db.close();
    }
  }

  function publicRecord(record) {
    if (!record) return null;
    const { blob, ...metadata } = record;
    return metadata;
  }

  async function digest(blob) {
    const bytes = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function put(blob, metadata = {}) {
    if (!(blob instanceof Blob)) throw new TypeError('Dogear assets must be Blob values.');
    const sha256 = await digest(blob);
    return transaction('readwrite', async (store) => {
      const existing = await requestResult(store.index('sha256').get(sha256));
      if (existing) return publicRecord(existing);
      const record = {
        id: crypto.randomUUID(),
        sha256,
        mimeType: metadata.mimeType || blob.type || 'application/octet-stream',
        displayName: metadata.displayName || 'attachment',
        size: blob.size,
        width: metadata.width,
        height: metadata.height,
        origin: metadata.origin || { type: 'unknown' },
        createdAt: Date.now(),
        blob,
      };
      await requestResult(store.put(record));
      return publicRecord(record);
    });
  }

  async function get(id) {
    return transaction('readonly', (store) => requestResult(store.get(id)));
  }

  async function remove(id) {
    return transaction('readwrite', (store) => requestResult(store.delete(id)));
  }

  async function removeUnreferenced(referencedIds) {
    const keep = new Set(referencedIds);
    return transaction('readwrite', async (store) => {
      const records = await requestResult(store.getAll());
      const removed = [];
      for (const record of records) {
        if (!keep.has(record.id)) {
          await requestResult(store.delete(record.id));
          removed.push(record.id);
        }
      }
      return removed;
    });
  }

  globalThis.DOGEAR_ASSETS = { get, put, remove, removeUnreferenced };
})();
