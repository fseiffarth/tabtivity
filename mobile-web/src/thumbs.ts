/**
 * The files library's covers (`FilesLibrary`'s `LibraryCover`), drawn on the
 * phone and only there: the desktop has no thumbnail route
 * (`docs/done/mobile_files_library_plan.md`, decision 3).
 *
 * A picture is fetched by its sealed token, as the viewer fetches it, and
 * scaled with `createImageBitmap`; a PDF's first page comes from the sealed
 * pdf.js frame (`pdf-frame.html`) — one hidden frame at a time, loaded afresh
 * for each document, and every message it sends checked by
 * `markup/frameProtocol.ts`, the frame being as hostile as the PDF. What comes
 * back is a bitmap, drawn onto a canvas; nothing from the frame is ever
 * inserted as HTML. SVGs keep their kind icon.
 *
 * Only tiles on screen ask (`useThumb`, an IntersectionObserver), and at most
 * two covers are made at once; a tile scrolled away before its turn leaves the
 * queue. Made covers — and failures, so an unchanged file that could not be
 * drawn is not tried again — wait in the phone's IndexedDB, keyed by project,
 * folder, name, size, time and kind, the least recently shown going first past
 * `THUMB_CAP`. Without IndexedDB there are simply no covers.
 */
import { useEffect, useState, type RefObject } from "react";
import { storageDashKey } from "../../src/lib/brand";
import { viewerFileUrl, type FilesSide, type ProjectFileEntry } from "./api";
import { acceptFrameMessage, MAX_FRAME_PAGES } from "./markup/frameProtocol";

/** A cover's width in pixels; the tile is ~104 CSS px wide on a 2–3× screen. */
export const THUMB_WIDTH = 240;
/** The tallest cover kept; a longer picture is cut at the bottom. */
const THUMB_MAX_HEIGHT = THUMB_WIDTH * 2;
/** Records kept at most; past it the least recently shown go. */
export const THUMB_CAP = 600;
/** Larger files keep their kind icon. */
export const MAX_THUMB_IMAGE = 8 * 1024 * 1024;
export const MAX_THUMB_PDF = 12 * 1024 * 1024;
/** How long the frame may take to open a PDF and draw its first page. */
const PDF_TIMEOUT_MS = 8_000;
/** Covers made at once. */
const PARALLEL = 2;
/** A cover's last use is written down at most this often. */
const TOUCH_MS = 60_000;
/** A stored cover larger than this is not one this module made. */
const MAX_STORED_THUMB = 512 * 1024;

/** What a cover is drawn from, or `null` for a kind icon. */
export function thumbSource(entry: Pick<ProjectFileEntry, "kind" | "size">): "image" | "pdf" | null {
  const kind = entry.kind.toLowerCase();
  if (kind === "application/pdf") return entry.size <= MAX_THUMB_PDF ? "pdf" : null;
  if (kind.startsWith("image/") && !kind.startsWith("image/svg")) return entry.size <= MAX_THUMB_IMAGE ? "image" : null;
  return null;
}

/** The cache key: the project, the folder's names (`placeOf`), the file's
 * name, size, time and kind — never its token, which every listing seals
 * afresh. A changed file is a new key. */
export function thumbKey(projectId: string, place: string, entry: Pick<ProjectFileEntry, "name" | "size" | "modified" | "kind">): string {
  return JSON.stringify([projectId, place, entry.name, entry.size, entry.modified, entry.kind]);
}

/** The record store under the cache — IndexedDB in the app, a map in tests. */
export interface ThumbBackend {
  get(key: string): Promise<unknown>;
  /** Store `record` under `key`, last used at `used`. */
  put(key: string, record: unknown, used: number): Promise<void>;
  touch(key: string, used: number): Promise<void>;
  delete(keys: string[]): Promise<void>;
  /** Every key with its last use. */
  usage(): Promise<[string, number][]>;
  /** Every record. Optional: without it, the keys `usage` lists are deleted. */
  clear?(): Promise<void>;
}

/** A read: the cover, a recorded failure, nothing yet, or no cache at all. */
export type ThumbRead = Blob | "failed" | null | "unavailable";

/** The covers made so far, least recently shown dropped past `cap`. Every
 * call resolves rather than throws. */
export class ThumbCache {
  private index: Promise<Map<string, number>> | null = null;

  constructor(private readonly backend: ThumbBackend, private readonly cap = THUMB_CAP, private readonly now = () => Date.now()) {}

  private usage(): Promise<Map<string, number>> {
    this.index ??= this.backend.usage().then(
      (list) => new Map(list.filter(([key, used]) => typeof key === "string" && typeof used === "number")),
      (error: unknown) => { this.index = null; throw error; },
    );
    return this.index;
  }

  async read(key: string): Promise<ThumbRead> {
    try {
      const value: unknown = await this.backend.get(key);
      if (!value || typeof value !== "object") return null;
      const record = value as { thumb?: unknown; failed?: unknown };
      let answer: Blob | "failed";
      if (record.failed === true) answer = "failed";
      else if (record.thumb instanceof Blob && record.thumb.size > 0 && record.thumb.size <= MAX_STORED_THUMB) answer = record.thumb;
      else return null;
      const index = await this.usage();
      const at = this.now();
      if (at - (index.get(key) ?? 0) >= TOUCH_MS) {
        index.set(key, at);
        await this.backend.touch(key, at).catch(() => {});
      }
      return answer;
    } catch {
      return "unavailable";
    }
  }

  /** Keep `thumb` under `key`, or with `null` that the file could not be
   * drawn; answers whether it was kept. */
  async store(key: string, thumb: Blob | null): Promise<boolean> {
    try {
      const at = this.now();
      await this.backend.put(key, thumb ? { thumb } : { failed: true }, at);
      const index = await this.usage();
      index.set(key, at);
      if (index.size > this.cap) {
        const oldest = [...index].sort((a, b) => a[1] - b[1]).slice(0, index.size - this.cap).map(([old]) => old);
        await this.backend.delete(oldest);
        for (const old of oldest) index.delete(old);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Drop every cover and failure of `projectId` (all of them without it);
   * answers whether the storage was reached. */
  async forget(projectId?: string): Promise<boolean> {
    try {
      const index = await this.usage();
      if (projectId === undefined && this.backend.clear) {
        await this.backend.clear();
        index.clear();
        return true;
      }
      const keys = [...index.keys()].filter((key) => projectId === undefined || projectOfKey(key) === projectId);
      if (keys.length) await this.backend.delete(keys);
      for (const key of keys) index.delete(key);
      return true;
    } catch {
      return false;
    }
  }
}

/** The project a cache key belongs to, or `null` for one not made by `thumbKey`. */
function projectOfKey(key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null;
  } catch {
    return null;
  }
}

/** At most `limit` tasks at once, the rest waiting in order; a waiting one
 * can leave the line, and then never runs, and a running one is told to stop
 * through its signal — a tile gone (the library left for a viewer) must not
 * keep pulling a PDF down the link the viewer is loading over. */
export class ThumbQueue {
  private active = 0;
  private readonly waiting: { start: () => void; drop: () => void }[] = [];

  constructor(private readonly limit = PARALLEL) {}

  /** `done` settles with the task's answer, or `null` when it left the line
   * before its turn (or threw). */
  run<T>(task: (signal: AbortSignal) => Promise<T>): { done: Promise<T | null>; cancel: () => void } {
    let cancel = () => {};
    const controller = new AbortController();
    const done = new Promise<T | null>((resolve) => {
      const slot = {
        start: () => {
          this.active += 1;
          void task(controller.signal).then((answer) => resolve(controller.signal.aborted ? null : answer), () => resolve(null)).finally(() => {
            this.active -= 1;
            this.next();
          });
        },
        drop: () => resolve(null),
      };
      cancel = () => {
        const at = this.waiting.indexOf(slot);
        if (at >= 0) {
          this.waiting.splice(at, 1);
          slot.drop();
        } else {
          controller.abort();
        }
      };
      this.waiting.push(slot);
      this.next();
    });
    return { done, cancel };
  }

  private next() {
    while (this.active < this.limit && this.waiting.length) this.waiting.shift()?.start();
  }
}

// --- The app's backend -----------------------------------------------------

const DB = storageDashKey("mobile-thumbs");
const THUMBS = "thumbs";
const USED = "used";

let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      for (const store of [THUMBS, USED]) {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  }).catch((error: unknown) => {
    database = null;
    throw error;
  });
  return database;
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("aborted"));
  });
}

/** Two stores: the records, and each one's last use apart from it, so the
 * LRU reads small numbers rather than every cover. */
export const indexedDbThumbs: ThumbBackend = {
  async get(key) {
    return promised((await openDatabase()).transaction(THUMBS).objectStore(THUMBS).get(key));
  },
  async put(key, record, used) {
    const transaction = (await openDatabase()).transaction([THUMBS, USED], "readwrite");
    transaction.objectStore(THUMBS).put(record, key);
    transaction.objectStore(USED).put(used, key);
    await finished(transaction);
  },
  async touch(key, used) {
    const transaction = (await openDatabase()).transaction(USED, "readwrite");
    transaction.objectStore(USED).put(used, key);
    await finished(transaction);
  },
  async delete(keys) {
    const transaction = (await openDatabase()).transaction([THUMBS, USED], "readwrite");
    for (const key of keys) {
      transaction.objectStore(THUMBS).delete(key);
      transaction.objectStore(USED).delete(key);
    }
    await finished(transaction);
  },
  async clear() {
    const transaction = (await openDatabase()).transaction([THUMBS, USED], "readwrite");
    transaction.objectStore(THUMBS).clear();
    transaction.objectStore(USED).clear();
    await finished(transaction);
  },
  async usage() {
    const store = (await openDatabase()).transaction(USED).objectStore(USED);
    const [keys, values] = await Promise.all([promised(store.getAllKeys()), promised(store.getAll())]);
    return keys.flatMap((key, at): [string, number][] =>
      typeof key === "string" && typeof values[at] === "number" ? [[key, values[at] as number]] : []);
  },
};

let shared: ThumbCache | null = null;
const cache = () => (shared ??= new ThumbCache(indexedDbThumbs));
const queue = new ThumbQueue();

/** Every cover and recorded failure, gone — this device was unpaired
 * (`forgetDeviceData`). */
export function forgetCovers(): Promise<boolean> {
  return cache().forget();
}

/** A project's covers, gone — the host no longer knows the project to this
 * phone, so nothing will ask for them again. */
export function forgetProjectCovers(projectId: string): Promise<boolean> {
  return cache().forget(projectId);
}
/** Keys whose bytes could not be fetched this visit (offline, a stale token):
 * not recorded as failures, since the next visit may fetch them, nor tried
 * again before it. */
const unfetched = new Set<string>();

// --- Making a cover ----------------------------------------------------------

/** `bitmap` drawn at most `THUMB_WIDTH` wide on white (a transparent picture
 * would turn black as a JPEG), cut at `THUMB_MAX_HEIGHT`. */
function encode(bitmap: ImageBitmap): Promise<Blob> {
  const width = Math.max(1, Math.min(THUMB_WIDTH, bitmap.width));
  const height = Math.max(1, Math.round(bitmap.height * (width / bitmap.width)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.min(height, THUMB_MAX_HEIGHT);
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("canvas"));
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), "image/jpeg", 0.8));
}

async function pictureCover(blob: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { resizeWidth: THUMB_WIDTH, resizeQuality: "medium" });
  } catch {
    // A browser without the resize options: decode whole, `encode` scales.
    bitmap = await createImageBitmap(blob);
  }
  try {
    return await encode(bitmap);
  } finally {
    bitmap.close();
  }
}

/** The PDFs waiting for the frame: one document at a time. */
let frameTurn: Promise<unknown> = Promise.resolve();

/** The first page of `bytes`, drawn by a freshly loaded hidden sealed frame;
 * `null` when the frame refused it or did not answer in time. */
function firstPage(bytes: ArrayBuffer, signal: AbortSignal): Promise<ImageBitmap | null> {
  const turn = frameTurn.then(() => new Promise<ImageBitmap | null>((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = "pdf";
    // The markup view's own hidden frame style: 1 px, transparent, untouchable.
    frame.className = "markup-frame";
    let pages = 0;
    let opened = false;
    const id = 1;
    const finish = (bitmap: ImageBitmap | null) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", stop);
      frame.remove();
      resolve(bitmap);
    };
    const stop = () => finish(null);
    const timer = window.setTimeout(stop, PDF_TIMEOUT_MS);
    signal.addEventListener("abort", stop);
    const onMessage = (event: MessageEvent) => {
      const message = acceptFrameMessage(event, frame.contentWindow, pages || MAX_FRAME_PAGES);
      if (!message) {
        // A picture the checks refused is still given back.
        const data = event.data as { bitmap?: unknown } | null;
        if (event.source === frame.contentWindow && data && typeof data === "object"
          && typeof ImageBitmap !== "undefined" && data.bitmap instanceof ImageBitmap) data.bitmap.close();
        return;
      }
      if (message.type === "ready" && !opened) {
        opened = true;
        frame.contentWindow?.postMessage({ type: "open", bytes }, "*", [bytes]);
      } else if (message.type === "meta") {
        pages = message.pages.length;
        frame.contentWindow?.postMessage({ type: "snapshot", id, n: 1, width: THUMB_WIDTH }, "*");
      } else if (message.type === "snapshot" && message.id === id) {
        finish(message.bitmap ?? null);
      } else if (message.type === "page") {
        message.bitmap.close();
      } else if (message.type === "failed") {
        finish(null);
      }
    };
    window.addEventListener("message", onMessage);
    frame.src = "/pdf-frame.html";
    document.body.appendChild(frame);
  }));
  frameTurn = turn.catch(() => null);
  return turn;
}

async function pdfCover(blob: Blob, signal: AbortSignal): Promise<Blob | null> {
  const bitmap = await firstPage(await blob.arrayBuffer(), signal);
  if (!bitmap) return null;
  try {
    return await encode(bitmap);
  } finally {
    bitmap.close();
  }
}

/** Fetch, draw and store one cover; `null` when there is none to show. A
 * cover stopped by `signal` is not recorded at all: the next visit tries it. */
async function makeCover(projectId: string, entry: ProjectFileEntry, source: "image" | "pdf", key: string, signal: AbortSignal, side?: FilesSide): Promise<Blob | null> {
  if (unfetched.has(key)) return null;
  let blob: Blob;
  try {
    const url = viewerFileUrl({ files: projectId, ...(side === "host" ? { on: "host" as const } : {}) }, { name: entry.name, kind: entry.kind, size: entry.size, modified: entry.modified, ref: entry.token });
    const response = await fetch(url, { credentials: "same-origin", signal });
    if (!response.ok) throw new Error("fetch");
    blob = await response.blob();
  } catch {
    if (!signal.aborted) unfetched.add(key);
    return null;
  }
  let thumb: Blob | null = null;
  if (blob.size <= (source === "pdf" ? MAX_THUMB_PDF : MAX_THUMB_IMAGE)) {
    try {
      thumb = source === "pdf" ? await pdfCover(blob, signal) : await pictureCover(blob);
    } catch {
      thumb = null;
    }
  }
  if (signal.aborted) return null;
  await cache().store(key, thumb);
  return thumb;
}

// --- Visibility --------------------------------------------------------------

const watched = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | null = null;

function watch(node: Element, onChange: (visible: boolean) => void): () => void {
  observer ??= new IntersectionObserver((records) => {
    for (const record of records) watched.get(record.target)?.(record.isIntersecting);
  }, { rootMargin: "120px" });
  watched.set(node, onChange);
  observer.observe(node);
  return () => {
    watched.delete(node);
    observer?.unobserve(node);
  };
}

/** Whether this browser can make covers at all. */
function capable(): boolean {
  return typeof IntersectionObserver !== "undefined" && typeof indexedDB !== "undefined"
    && typeof createImageBitmap === "function" && typeof URL.createObjectURL === "function";
}

/**
 * The cover for a tile whose cover element is `cover`: the picture's URL once
 * there is one — from the cache, or made while the tile is on screen. `null`
 * while there is none, for a kind without covers, with `enabled` off (the
 * view menu's Thumbnails), and where the browser cannot.
 */
export function useThumb(cover: RefObject<Element | null>, projectId: string, entry: ProjectFileEntry, place: string, enabled: boolean, side?: FilesSide): string | null {
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  const source = enabled ? thumbSource(entry) : null;
  // The remote side's covers are the same project's (forgotten with it), in
  // a place no folder of this computer's can be named.
  const key = thumbKey(projectId, side === "host" ? `\u0000host/${place}` : place, entry);

  useEffect(() => {
    const node = cover.current;
    if (!node || !source || !capable()) return;
    let gone = false;
    let started = false;
    /** Counts the times the tile came on screen: a load from an earlier time
     * it was there gives way. */
    let visit = 0;
    let job: { cancel: () => void } | null = null;
    let objectUrl: string | null = null;
    const show = (blob: Blob) => {
      if (gone || objectUrl) return;
      objectUrl = URL.createObjectURL(blob);
      setShown({ key, url: objectUrl });
      stop();
    };
    const load = async () => {
      const mine = ++visit;
      const cached = await cache().read(key);
      if (gone || !started || mine !== visit) return;
      if (cached instanceof Blob) { show(cached); return; }
      if (cached !== null) return;
      const run = queue.run((signal) => makeCover(projectId, entry, source, key, signal, side));
      job = run;
      const made = await run.done;
      if (made) show(made);
    };
    const stop = watch(node, (visible) => {
      if (visible && !started) {
        started = true;
        void load();
      } else if (!visible && started && !objectUrl) {
        // Scrolled away before its turn: out of the line, back in on return.
        started = false;
        job?.cancel();
        job = null;
      }
    });
    return () => {
      gone = true;
      stop();
      job?.cancel();
      if (objectUrl) {
        const revoked = objectUrl;
        URL.revokeObjectURL(revoked);
        setShown((was) => (was?.url === revoked ? null : was));
      }
    };
    // `entry`'s fields are in `key`; its token only fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cover, key, source, projectId]);

  return shown && shown.key === key ? shown.url : null;
}
