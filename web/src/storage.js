// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser persistence (IndexedDB): sketchbook, installed libraries, settings.

const DB_NAME = 'arduino-web';
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('sketches', { keyPath: 'name' });
      database.createObjectStore('libraries', { keyPath: 'name' });
      database.createObjectStore('kv');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, mode);
    const request = fn(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export const sketches = {
  list: () => tx('sketches', 'readonly', (s) => s.getAll()),
  get: (name) => tx('sketches', 'readonly', (s) => s.get(name)),
  put: (sketch) => tx('sketches', 'readwrite', (s) => s.put({ ...sketch, modified: Date.now() })),
  delete: (name) => tx('sketches', 'readwrite', (s) => s.delete(name)),
};

export const libraries = {
  list: () => tx('libraries', 'readonly', (s) => s.getAll()),
  put: (library) => tx('libraries', 'readwrite', (s) => s.put(library)),
  delete: (name) => tx('libraries', 'readwrite', (s) => s.delete(name)),
};

export const kv = {
  get: (key) => tx('kv', 'readonly', (s) => s.get(key)),
  set: (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key)),
};

// Sketch names follow the Arduino sketch specification.
export function validSketchName(name) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(name) && !name.endsWith('.');
}

export function defaultSketchName(existing) {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const now = new Date();
  const base = `sketch_${months[now.getMonth()]}${now.getDate()}`;
  for (const suffix of 'abcdefghijklmnopqrstuvwxyz') if (!existing.includes(base + suffix)) return base + suffix;
  return `${base}_${Date.now()}`;
}

export const NEW_SKETCH = 'void setup() {\n  // put your setup code here, to run once:\n\n}\n\nvoid loop() {\n  // put your main code here, to run repeatedly:\n\n}\n';
