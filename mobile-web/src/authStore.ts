/**
 * The phone's key store: the IndexedDB that holds this device's
 * non-extractable pairing key (and, beside it, the secrets key's ECDH key —
 * `secretsCore.ts`). Apart from `auth.ts` so the browser client's Server
 * settings (same origin, same database) can sign with the pairing key
 * without pulling in the phone's request layer.
 */
import { LEGACY_NAMES, NAMES } from "../../src/lib/brand";
import { adoptLegacyDatabase, databaseHost, databasePort } from "../../src/lib/brandMigration";

const DB = NAMES.mobileAuthDb;
/** The database an older build of the phone app kept the device key in. */
const LEGACY_DB = LEGACY_NAMES.mobileAuthDb;
export const STORE = "keys";
const DEVICE = "device";

export interface AuthRecord { deviceId: string; privateKey: CryptoKey }

/** The device key an older build stored under the app's old name is copied
 * over once, before the database is first used — so the phone stays paired
 * across a rename. A failed copy keeps the old database for the next start. */
let adopted: Promise<unknown> | null = null;

export async function openAuthDatabase(): Promise<IDBDatabase> {
  if (LEGACY_DB !== DB) {
    adopted ??= adoptLegacyDatabase(databaseHost(indexedDB), LEGACY_DB, DB, async () =>
      databasePort(await openCurrentAuthDatabase()),
    ).catch(() => undefined);
    await adopted;
  }
  return openCurrentAuthDatabase();
}

function openCurrentAuthDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** This device's pairing record (id and non-extractable signing key). */
export async function loadDevice(): Promise<AuthRecord | null> {
  const database = await openAuthDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(DEVICE);
    request.onsuccess = () => resolve((request.result as AuthRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function saveDevice(record: AuthRecord): Promise<void> {
  const database = await openAuthDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).put(record, DEVICE);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}
