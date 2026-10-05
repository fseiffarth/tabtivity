import { describe, expect, it } from "vitest";
import { LEGACY_NAMES, NAMES } from "../../lib/brand";
import {
  adoptLegacyDatabase,
  currentTabCommand,
  exportExtensions,
  migrateStorageKeys,
  tmuxSessionRest,
  type DatabaseHost,
  type DatabasePort,
} from "../../lib/brandMigration";

/** The names of a build after a rename: an invented current brand. */
const RENAMED: typeof NAMES = {
  ...NAMES,
  storagePrefix: "newname.",
  storageDashPrefix: "newname-",
  storageColonPrefix: "newname:",
  tabCommandPrefix: "__newname_",
  tmuxPrefix: "newname-",
  exportExtension: "newnameproj",
  mobileAuthDb: "newname-mobile-auth",
};

function storageOf(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  const calls: string[] = [];
  const storage = {
    get length() {
      return map.size;
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (key: string) => {
      calls.push(`get ${key}`);
      return map.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      calls.push(`set ${key}`);
      map.set(key, value);
    },
    removeItem: (key: string) => {
      calls.push(`remove ${key}`);
      map.delete(key);
    },
  };
  return { storage, map, calls };
}

describe("brand migration: localStorage keys", () => {
  it("moves all three key shapes and leaves everybody else's keys", () => {
    const { storage, map } = storageOf({
      [`${LEGACY_NAMES.storagePrefix}todo.collapsed`]: "1",
      [`${LEGACY_NAMES.storageDashPrefix}theme`]: "dark",
      [`${LEGACY_NAMES.storageColonPrefix}new-tab-slots`]: "[1,2]",
      "someone-elses-key": "x",
    });
    expect(migrateStorageKeys(storage, RENAMED, LEGACY_NAMES)).toBe(3);
    expect(Object.fromEntries(map)).toEqual({
      "newname.todo.collapsed": "1",
      "newname-theme": "dark",
      "newname:new-tab-slots": "[1,2]",
      "someone-elses-key": "x",
    });
    // A second run finds nothing.
    expect(migrateStorageKeys(storage, RENAMED, LEGACY_NAMES)).toBe(0);
  });

  it("never overwrites a value the current key already holds", () => {
    const { storage, map } = storageOf({
      [`${LEGACY_NAMES.storageDashPrefix}theme`]: "dark",
      "newname-theme": "light",
    });
    expect(migrateStorageKeys(storage, RENAMED, LEGACY_NAMES)).toBe(0);
    expect(Object.fromEntries(map)).toEqual({ "newname-theme": "light" });
  });

  it("keeps the old key when the copy does not read back", () => {
    const { storage, map } = storageOf({ [`${LEGACY_NAMES.storagePrefix}a`]: "1" });
    const broken = { ...storage, setItem: () => undefined, get length() { return map.size; } };
    expect(migrateStorageKeys(broken, RENAMED, LEGACY_NAMES)).toBe(0);
    expect(map.get(`${LEGACY_NAMES.storagePrefix}a`)).toBe("1");
  });

  it("does not touch the storage when the two name sets are the same", () => {
    const { storage, map, calls } = storageOf({ [`${NAMES.storagePrefix}a`]: "1", [`${NAMES.storageDashPrefix}theme`]: "dark" });
    const before = Object.fromEntries(map);
    expect(migrateStorageKeys(storage, NAMES, NAMES)).toBe(0);
    expect(Object.fromEntries(map)).toEqual(before);
    expect(calls).toEqual([]);
  });

  it("moves an older build's keys to this build's names by default", () => {
    const { storage, map } = storageOf({
      [`${LEGACY_NAMES.storagePrefix}todo.collapsed`]: "1",
      [`${LEGACY_NAMES.storageDashPrefix}theme`]: "dark",
    });
    expect(migrateStorageKeys(storage)).toBe(2);
    expect(Object.fromEntries(map)).toEqual({
      [`${NAMES.storagePrefix}todo.collapsed`]: "1",
      [`${NAMES.storageDashPrefix}theme`]: "dark",
    });
  });
});

describe("brand migration: saved names", () => {
  it("maps an old built-in tab command and leaves the rest", () => {
    const old = `${LEGACY_NAMES.tabCommandPrefix}mail__`;
    expect(currentTabCommand(old, RENAMED, LEGACY_NAMES)).toBe("__newname_mail__");
    expect(currentTabCommand("__newname_mail__", RENAMED, LEGACY_NAMES)).toBe("__newname_mail__");
    expect(currentTabCommand("bash", RENAMED, LEGACY_NAMES)).toBe("bash");
    expect(currentTabCommand(`${LEGACY_NAMES.tabCommandPrefix}tool --flag`, RENAMED, LEGACY_NAMES)).toBe(
      `${LEGACY_NAMES.tabCommandPrefix}tool --flag`,
    );
    expect(currentTabCommand(`${NAMES.tabCommandPrefix}mail__`)).toBe(`${NAMES.tabCommandPrefix}mail__`);
  });

  it("recognises a tmux session under either prefix", () => {
    expect(tmuxSessionRest(`${LEGACY_NAMES.tmuxPrefix}p1--agent-1`, RENAMED, LEGACY_NAMES)).toBe("p1--agent-1");
    expect(tmuxSessionRest("newname-p1--shell-1", RENAMED, LEGACY_NAMES)).toBe("p1--shell-1");
    expect(tmuxSessionRest("train", RENAMED, LEGACY_NAMES)).toBeNull();
    expect(tmuxSessionRest(`${NAMES.tmuxPrefix}p1--x`)).toBe("p1--x");
  });

  it("offers both export extensions once they differ, one before", () => {
    expect(exportExtensions(RENAMED, LEGACY_NAMES)).toEqual(["newnameproj", LEGACY_NAMES.exportExtension]);
    expect(exportExtensions(NAMES, NAMES)).toEqual([NAMES.exportExtension]);
    expect(exportExtensions()).toEqual([NAMES.exportExtension, LEGACY_NAMES.exportExtension]);
  });
});

/** A database host in memory: `name → store → key → value`. */
function memoryHost(initial: Record<string, Record<string, Record<string, unknown>>>) {
  const databases = new Map(
    Object.entries(initial).map(([name, stores]) => [
      name,
      new Map(Object.entries(stores).map(([store, records]) => [store, new Map(Object.entries(records))])),
    ]),
  );
  const log: string[] = [];
  const port = (name: string, failWrites = false): DatabasePort => ({
    storeNames: () => Array.from(databases.get(name)?.keys() ?? []),
    entries: async (store) => Array.from(databases.get(name)?.get(store)?.entries() ?? []),
    putIfAbsent: async (store, key, value) => {
      const records = databases.get(name)?.get(store);
      if (failWrites || !records) return;
      if (!records.has(String(key))) records.set(String(key), value);
    },
    close: () => log.push(`close ${name}`),
  });
  const host: DatabaseHost = {
    exists: async (name) => databases.has(name),
    open: async (name) => port(name),
    remove: async (name) => {
      log.push(`remove ${name}`);
      databases.delete(name);
    },
  };
  /** What the app's own opener does: create the database with its stores. */
  const openCurrent = (name: string, stores: string[], failWrites = false) => async () => {
    if (!databases.has(name)) databases.set(name, new Map(stores.map((store) => [store, new Map()])));
    return port(name, failWrites);
  };
  return { host, databases, log, openCurrent };
}

describe("brand migration: the phone's IndexedDB", () => {
  const OLD = LEGACY_NAMES.mobileAuthDb;
  const NEW = RENAMED.mobileAuthDb;
  const device = { deviceId: "dev-1", privateKey: { type: "private" } };

  it("copies the device key, verifies it, and only then deletes the old database", async () => {
    const { host, databases, log, openCurrent } = memoryHost({ [OLD]: { keys: { device } } });
    await expect(adoptLegacyDatabase(host, OLD, NEW, openCurrent(NEW, ["keys"]))).resolves.toBe("copied");
    expect(databases.has(OLD)).toBe(false);
    expect(databases.get(NEW)?.get("keys")?.get("device")).toBe(device);
    expect(log.indexOf(`remove ${OLD}`)).toBeGreaterThan(log.indexOf(`close ${NEW}`));
    // The next start has nothing to do.
    await expect(adoptLegacyDatabase(host, OLD, NEW, openCurrent(NEW, ["keys"]))).resolves.toBe("nothing-to-do");
  });

  it("keeps the old database when the copy cannot be verified", async () => {
    const { host, databases, openCurrent } = memoryHost({ [OLD]: { keys: { device } } });
    await expect(adoptLegacyDatabase(host, OLD, NEW, openCurrent(NEW, ["keys"], true))).resolves.toBe("kept-old");
    expect(databases.get(OLD)?.get("keys")?.get("device")).toBe(device);
  });

  it("keeps the old database when it has a store the current one lacks", async () => {
    const { host, databases, openCurrent } = memoryHost({ [OLD]: { keys: { device }, extra: { a: 1 } } });
    await expect(adoptLegacyDatabase(host, OLD, NEW, openCurrent(NEW, ["keys"]))).resolves.toBe("kept-old");
    expect(databases.has(OLD)).toBe(true);
    // What could be copied was: the key is usable under the current name.
    expect(databases.get(NEW)?.get("keys")?.get("device")).toBe(device);
  });

  it("never overwrites a key the current database already has", async () => {
    const paired = { deviceId: "dev-2", privateKey: { type: "private" } };
    const { host, databases, openCurrent } = memoryHost({
      [OLD]: { keys: { device } },
      [NEW]: { keys: { device: paired } },
    });
    await expect(adoptLegacyDatabase(host, OLD, NEW, openCurrent(NEW, ["keys"]))).resolves.toBe("copied");
    expect(databases.get(NEW)?.get("keys")?.get("device")).toBe(paired);
  });

  it("opens nothing on a fresh install or while the name is unchanged", async () => {
    const fresh = memoryHost({});
    await expect(adoptLegacyDatabase(fresh.host, OLD, NEW, fresh.openCurrent(NEW, ["keys"]))).resolves.toBe(
      "nothing-to-do",
    );
    expect(fresh.databases.size).toBe(0);
    const same = memoryHost({ [NAMES.mobileAuthDb]: { keys: { device } } });
    const untouched: DatabaseHost = {
      exists: async () => {
        throw new Error("must not be asked");
      },
      open: same.host.open,
      remove: same.host.remove,
    };
    await expect(
      adoptLegacyDatabase(untouched, NAMES.mobileAuthDb, NAMES.mobileAuthDb, same.openCurrent(NAMES.mobileAuthDb, ["keys"])),
    ).resolves.toBe("nothing-to-do");
    expect(same.log).toEqual([]);
  });
});
