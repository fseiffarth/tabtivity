/**
 * The frontend half of the brand migration (backend:
 * `src-tauri/src/services/brand_migration`): what the window and the phone
 * app keep under names that carry the app's name, moved to the current name.
 * Shared by the desktop and the phone PWA.
 *
 * Every function takes the two name sets as parameters (default: the brand
 * module's `NAMES` and `LEGACY_NAMES`) so the tests can run them with names
 * that differ. **While the two sets are equal nothing here reads or writes
 * anything.**
 */
import { LEGACY_NAMES, NAMES } from "./brand";

type NameSet = typeof NAMES;

/** The three shapes a localStorage key of the app has: `<slug>.x`, `<slug>-x`
 *  and `<slug>:x`. */
const STORAGE_PREFIXES = ["storagePrefix", "storageDashPrefix", "storageColonPrefix"] as const;

/**
 * Move every localStorage key an older build wrote to its current name:
 * copy, read back, then remove the old key. A key whose current name already
 * holds a value is not overwritten (the current one is what is read) and its
 * old twin is removed. Returns how many keys moved.
 *
 * Runs before anything else reads the storage (`brandMigrationBoot.ts`).
 */
export function migrateStorageKeys(
  storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">,
  current: NameSet = NAMES,
  legacy: NameSet = LEGACY_NAMES,
): number {
  const pairs = STORAGE_PREFIXES.map((name) => [legacy[name], current[name]] as const).filter(
    ([from, to]) => from !== to,
  );
  if (pairs.length === 0) return 0;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  let moved = 0;
  for (const key of keys) {
    const pair = pairs.find(([from]) => key.startsWith(from));
    if (!pair) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    const target = pair[1] + key.slice(pair[0].length);
    if (storage.getItem(target) === null) {
      storage.setItem(target, value);
      // Only a value that reads back is safe to drop the original of (a full
      // storage throws above; a broken one may silently not keep it).
      if (storage.getItem(target) !== value) continue;
      moved += 1;
    }
    storage.removeItem(key);
  }
  return moved;
}

/** The current command of a saved built-in tab (`__<slug>_mail__`) when
 *  `command` is the one an older build saved; otherwise `command` itself. */
export function currentTabCommand(
  command: string,
  current: NameSet = NAMES,
  legacy: NameSet = LEGACY_NAMES,
): string {
  if (legacy.tabCommandPrefix === current.tabCommandPrefix) return command;
  if (!command.startsWith(legacy.tabCommandPrefix) || !command.endsWith("__")) return command;
  const view = command.slice(legacy.tabCommandPrefix.length);
  return view.length > 2 ? current.tabCommandPrefix + view : command;
}

/** What follows the app's prefix in a tmux session name, when the session is
 *  one of the app's — minted under the current prefix or under the one an
 *  older build used (a remote session outlives an update). `null` for
 *  anybody else's session. */
export function tmuxSessionRest(
  session: string,
  current: NameSet = NAMES,
  legacy: NameSet = LEGACY_NAMES,
): string | null {
  if (session.startsWith(current.tmuxPrefix)) return session.slice(current.tmuxPrefix.length);
  if (legacy.tmuxPrefix !== current.tmuxPrefix && session.startsWith(legacy.tmuxPrefix)) {
    return session.slice(legacy.tmuxPrefix.length);
  }
  return null;
}

/** The file extensions a project export may carry: the current one, and the
 *  one an older build wrote (exports sit in backups for years). */
export function exportExtensions(current: NameSet = NAMES, legacy: NameSet = LEGACY_NAMES): string[] {
  return legacy.exportExtension === current.exportExtension
    ? [current.exportExtension]
    : [current.exportExtension, legacy.exportExtension];
}

// ── IndexedDB (the phone's device key and unsaved markup) ───────────────────

/** One open database, as far as the copy needs it. */
export interface DatabasePort {
  storeNames(): string[];
  /** Every record of a store, key and value. */
  entries(store: string): Promise<Array<[IDBValidKey, unknown]>>;
  /** Write a record unless its key is already there. */
  putIfAbsent(store: string, key: IDBValidKey, value: unknown): Promise<void>;
  close(): void;
}

/** The databases of one origin. */
export interface DatabaseHost {
  exists(name: string): Promise<boolean>;
  /** Open an existing database as it is. */
  open(name: string): Promise<DatabasePort>;
  remove(name: string): Promise<void>;
}

export type DatabaseAdoption = "nothing-to-do" | "copied" | "kept-old";

/**
 * Copy the database an older build of the phone app wrote to its current
 * name: every record of every store both databases have, read back and
 * compared, and only then is the old database deleted. The phone's device
 * key lives in one of these, so a failed or partial copy keeps the old
 * database (`"kept-old"`) and the next start tries again; a record the
 * current database already has is never overwritten.
 *
 * `openCurrent` opens (and, the first time, creates) the current database
 * with its stores, exactly as the app does.
 */
export async function adoptLegacyDatabase(
  host: DatabaseHost,
  legacyName: string,
  currentName: string,
  openCurrent: () => Promise<DatabasePort>,
): Promise<DatabaseAdoption> {
  if (legacyName === currentName) return "nothing-to-do";
  if (!(await host.exists(legacyName))) return "nothing-to-do";
  const old = await host.open(legacyName);
  let verified = false;
  try {
    const target = await openCurrent();
    try {
      const stores = old.storeNames().filter((store) => target.storeNames().includes(store));
      verified = stores.length === old.storeNames().length;
      for (const store of stores) {
        const records = await old.entries(store);
        for (const [key, value] of records) await target.putIfAbsent(store, key, value);
        const copied = new Set((await target.entries(store)).map(([key]) => JSON.stringify(key)));
        if (!records.every(([key]) => copied.has(JSON.stringify(key)))) verified = false;
      }
    } finally {
      target.close();
    }
  } finally {
    old.close();
  }
  if (!verified) return "kept-old";
  await host.remove(legacyName);
  return "copied";
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** A real IndexedDB database as a {@link DatabasePort}. */
export function databasePort(database: IDBDatabase): DatabasePort {
  return {
    storeNames: () => Array.from(database.objectStoreNames),
    async entries(store) {
      const source = database.transaction(store).objectStore(store);
      const [keys, values] = await Promise.all([request(source.getAllKeys()), request(source.getAll())]);
      return keys.map((key, index) => [key, values[index]] as [IDBValidKey, unknown]);
    },
    async putIfAbsent(store, key, value) {
      const target = database.transaction(store, "readwrite").objectStore(store);
      if ((await request(target.count(key))) === 0) await request(target.put(value, key));
    },
    close: () => database.close(),
  };
}

/** The browser's IndexedDB as a {@link DatabaseHost}. */
export function databaseHost(factory: IDBFactory): DatabaseHost {
  const open = (name: string) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      req.onblocked = () => reject(new Error("blocked"));
    });
  const remove = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const req = factory.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error("IndexedDB delete failed"));
      req.onblocked = () => resolve();
    });
  return {
    async exists(name) {
      if (typeof factory.databases === "function") {
        return (await factory.databases()).some((database) => database.name === name);
      }
      // No listing in this browser: opening is the only way to ask, and it
      // creates an empty database when there was none — which is removed
      // again, so nothing under the old name is left behind.
      const database = await open(name);
      const empty = database.objectStoreNames.length === 0;
      database.close();
      if (empty) await remove(name);
      return !empty;
    },
    open: async (name) => databasePort(await open(name)),
    remove,
  };
}
