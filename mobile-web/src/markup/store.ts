/**
 * Where a markup layer waits between strokes: the phone's own IndexedDB,
 * never the desktop (`docs/mobile_pdf_markup_plan.md` §2.7). Handwriting is
 * many points, and Safari allows `localStorage` only a few MB for the whole
 * app. One record per source; saved as each stroke ends, so a closed app or
 * a reload loses at most the stroke in progress. A Submit keeps the record:
 * its marks move to the layer's `sent` side (`docs/pdf_markup_rounds_plan.md`
 * §2.1), and the record goes only once neither side has a mark.
 *
 * Every access may fail — a private window, evicted or blocked storage — and
 * then the layer still works, unsaved, and the view says so: every function
 * here resolves rather than throws.
 */

import { isLayer, LIMITS, markCount, SENT_LIMITS, type Layer, type PageLayer } from "./layer";
import { LEGACY_NAMES, NAMES } from "../../../src/lib/brand";
import { adoptLegacyDatabase, databaseHost, databasePort } from "../../../src/lib/brandMigration";

/** What a layer was drawn against: the file's size and modified time. A
 * different file under the same name is told apart by them. */
export type Fingerprint = { size: number; modified: number };
export type StoredLayer = { layer: Layer; fingerprint: Fingerprint; saved: number };

/** The record store behind the functions below — IndexedDB in the app, a
 * map or a broken one in tests. */
export interface LayerBackend {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const DB = NAMES.mobileMarkupDb;
/** The database an older build of the phone app kept unsaved markup in. */
const LEGACY_DB = LEGACY_NAMES.mobileMarkupDb;
const STORE = "layers";

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let database: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  // Unsaved markup an older build stored under the app's old name is copied
  // over once, before the database is first used.
  database ??= (
    LEGACY_DB === DB
      ? openCurrent()
      : adoptLegacyDatabase(databaseHost(indexedDB), LEGACY_DB, DB, async () => databasePort(await openCurrent()))
          .catch(() => undefined)
          .then(openCurrent)
  ).catch((error: unknown) => {
    database = null;
    throw error;
  });
  return database;
}

function openCurrent(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
}

/** The app's backend: one object store in its own database. */
export const indexedDbBackend: LayerBackend = {
  async get(key) {
    return promised((await open()).transaction(STORE).objectStore(STORE).get(key));
  },
  async put(key, value) {
    await promised((await open()).transaction(STORE, "readwrite").objectStore(STORE).put(value, key));
  },
  async delete(key) {
    await promised((await open()).transaction(STORE, "readwrite").objectStore(STORE).delete(key));
  },
};

/** The record key: the project and the file, as the phone names them. A file
 * browser token is sealed afresh with every listing, so a project file is
 * keyed by its folder trail and name instead — a key that never leaves the
 * phone. */
export function layerKey(projectId: string, source: { files: string } | { outbox: string }): string {
  return "files" in source ? `${projectId}:files:${source.files}` : `${projectId}:outbox:${source.outbox}`;
}

export { SENT_LIMITS };

/** Whether a layer is one the desktop would accept — never store one it
 * would refuse at Submit. The sent marks never go out again and are never
 * trimmed (only the reader erases them), so they get a looser bound of their
 * own (`SENT_LIMITS`) that only keeps the record finite. */
export function withinLimits(layer: Layer): boolean {
  const bounded = (pages: Record<number, PageLayer>, limits: { marks: number; points: number }) => {
    const { marks, points } = markCount({ pages });
    return marks <= limits.marks && points <= limits.points;
  };
  return bounded(layer.pages, LIMITS) && bounded(layer.sent?.pages ?? {}, SENT_LIMITS);
}

/** A stored value as a layer: whole, or — when only its `sent` side is
 * unreadable — its unsent marks alone, which matter more. */
function readLayer(value: unknown): Layer | null {
  if (isLayer(value)) return value;
  const pages = value && typeof value === "object" ? (value as { pages?: unknown }).pages : undefined;
  const unsent = { pages };
  return isLayer(unsent) ? unsent : null;
}

/** The saved layer, `null` when there is none, or `"unavailable"` when the
 * storage could not be read at all. */
export async function loadLayer(key: string, backend: LayerBackend = indexedDbBackend): Promise<StoredLayer | null | "unavailable"> {
  let value: unknown;
  try {
    value = await backend.get(key);
  } catch {
    return "unavailable";
  }
  if (!value || typeof value !== "object") return null;
  const { fingerprint, saved } = value as Partial<StoredLayer>;
  const layer = readLayer((value as { layer?: unknown }).layer);
  if (!layer || !fingerprint || typeof fingerprint.size !== "number" || typeof fingerprint.modified !== "number") return null;
  return { layer, fingerprint: { size: fingerprint.size, modified: fingerprint.modified }, saved: typeof saved === "number" ? saved : 0 };
}

/** Saves the layer; `false` when it could not be. A layer with no mark on
 * either side is a removal, so a cleared file leaves nothing behind — but one
 * holding only sent marks (just after a Submit) is kept. */
export async function saveLayer(key: string, layer: Layer, fingerprint: Fingerprint, backend: LayerBackend = indexedDbBackend): Promise<boolean> {
  if (!withinLimits(layer)) return false;
  try {
    const empty = (pages: Record<number, PageLayer>) => Object.values(pages).every((page) => page.marks.length === 0);
    if (empty(layer.pages) && empty(layer.sent?.pages ?? {})) await backend.delete(key);
    else await backend.put(key, { layer, fingerprint, saved: Date.now() } satisfies StoredLayer);
    return true;
  } catch {
    return false;
  }
}

export async function clearLayer(key: string, backend: LayerBackend = indexedDbBackend): Promise<boolean> {
  try {
    await backend.delete(key);
    return true;
  } catch {
    return false;
  }
}

/** Moves the record from `from` to `to`, stamped with `to`'s file — a Reload
 * that switched to a newer copy of the file (an outbox leaf). `false` when
 * the storage failed; nothing stored under `from` is a success. */
export async function moveLayer(from: string, to: string, fingerprint: Fingerprint, backend: LayerBackend = indexedDbBackend): Promise<boolean> {
  if (from === to) return true;
  const stored = await loadLayer(from, backend);
  if (stored === "unavailable") return false;
  if (!stored) return true;
  if (!(await saveLayer(to, stored.layer, fingerprint, backend))) return false;
  return clearLayer(from, backend);
}

/** Whether the file changed since its layer was drawn. */
export function stale(stored: StoredLayer, current: Fingerprint): boolean {
  return stored.fingerprint.size !== current.size || stored.fingerprint.modified !== current.modified;
}
