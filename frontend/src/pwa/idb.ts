// A tiny IndexedDB wrapper for the phone app's offline store (0.6.0, MP-053). The service worker opens the same
// database (public sw template: keep DB_NAME, DB_VERSION and the store names in step).
export const DB_NAME = "mpro-offline";
export const DB_VERSION = 1;
export type StoreName = "meta" | "wo" | "queue";

let dbp: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("This browser can't save work for offline use.")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("wo")) db.createObjectStore("wo", { keyPath: "id" });
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error ?? new Error("Couldn't open the offline store.")); };
    req.onblocked = () => { dbp = null; reject(new Error("Close other MPro tabs and try again.")); };
  });
  return dbp;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function all<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

export async function put<T>(store: StoreName, value: T, key?: IDBValidKey): Promise<IDBValidKey> {
  const db = await openDb();
  return done(db.transaction(store, "readwrite").objectStore(store).put(value, key));
}

export async function del(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  await done(db.transaction(store, "readwrite").objectStore(store).delete(key));
}

export async function clear(store: StoreName): Promise<void> {
  const db = await openDb();
  await done(db.transaction(store, "readwrite").objectStore(store).clear());
}
