/**
 * The files library's thumbnail cache and queue (`thumbs.ts`): what gets a
 * cover, the key a cover is kept under, failures kept so an unchanged file is
 * not tried again, the least recently shown dropped past the cap, a cache
 * that never throws, and at most two covers made at once.
 */
import { describe, expect, it } from "vitest";

import { MAX_THUMB_IMAGE, MAX_THUMB_PDF, ThumbCache, ThumbQueue, thumbKey, thumbSource, type ThumbBackend } from "../../../mobile-web/src/thumbs";

/** The cache's store as a map, as the markup store's tests keep theirs. */
function memory(): ThumbBackend & { records: Map<string, unknown>; used: Map<string, number> } {
  const records = new Map<string, unknown>();
  const used = new Map<string, number>();
  return {
    records,
    used,
    get: async (key) => records.get(key),
    put: async (key, record, at) => { records.set(key, record); used.set(key, at); },
    touch: async (key, at) => { used.set(key, at); },
    delete: async (keys) => { for (const key of keys) { records.delete(key); used.delete(key); } },
    usage: async () => [...used],
  };
}

const broken: ThumbBackend = {
  get: () => Promise.reject(new Error("SecurityError")),
  put: () => Promise.reject(new Error("QuotaExceededError")),
  touch: () => Promise.reject(new Error("SecurityError")),
  delete: () => Promise.reject(new Error("SecurityError")),
  usage: () => Promise.reject(new Error("SecurityError")),
};

const png = { name: "plot.png", kind: "image/png", size: 48_000, modified: 1_770_000_000 };
const jpeg = (bytes = 10) => new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });

describe("thumbnails — what gets one", () => {
  it("draws pictures and PDFs under their caps, never an SVG, a folder or a text", () => {
    expect(thumbSource(png)).toBe("image");
    expect(thumbSource({ kind: "image/png", size: MAX_THUMB_IMAGE + 1 })).toBeNull();
    expect(thumbSource({ kind: "image/svg+xml", size: 10 })).toBeNull();
    expect(thumbSource({ kind: "application/pdf", size: MAX_THUMB_PDF })).toBe("pdf");
    expect(thumbSource({ kind: "application/pdf", size: MAX_THUMB_PDF + 1 })).toBeNull();
    expect(thumbSource({ kind: "dir", size: 0 })).toBeNull();
    expect(thumbSource({ kind: "text/plain; charset=utf-8", size: 10 })).toBeNull();
  });

  it("keys a cover by project, folder, name, size, time and kind — a changed file is a new key", () => {
    const key = thumbKey("p1", "src", png);
    expect(thumbKey("p1", "src", { ...png })).toBe(key);
    for (const other of [
      thumbKey("p2", "src", png),
      thumbKey("p1", "", png),
      thumbKey("p1", "src", { ...png, name: "plot2.png" }),
      thumbKey("p1", "src", { ...png, size: png.size + 1 }),
      thumbKey("p1", "src", { ...png, modified: png.modified + 1 }),
      thumbKey("p1", "src", { ...png, kind: "image/jpeg" }),
    ]) expect(other).not.toBe(key);
    // No separator a name could forge: "a/b" + "c" is not "a" + "b/c".
    expect(thumbKey("p1", "a/b", { ...png, name: "c" })).not.toBe(thumbKey("p1", "a", { ...png, name: "b/c" }));
  });
});

describe("thumbnails — the cache", () => {
  it("keeps a cover and a failure, and tells nothing yet apart from either", async () => {
    const cache = new ThumbCache(memory());
    expect(await cache.read("a")).toBeNull();
    const cover = jpeg();
    expect(await cache.store("a", cover)).toBe(true);
    expect(await cache.read("a")).toBe(cover);
    // A file that could not be drawn is not tried again while unchanged.
    expect(await cache.store("b", null)).toBe(true);
    expect(await cache.read("b")).toBe("failed");
  });

  it("drops the least recently shown past the cap", async () => {
    let now = 1_000_000;
    const backend = memory();
    const cache = new ThumbCache(backend, 3, () => now);
    for (const key of ["a", "b", "c"]) {
      await cache.store(key, jpeg());
      now += 100_000;
    }
    // Showing "a" again makes "b" the least recent.
    expect(await cache.read("a")).toBeInstanceOf(Blob);
    now += 100_000;
    await cache.store("d", null);
    expect([...backend.records.keys()].sort()).toEqual(["a", "c", "d"]);
    expect(await cache.read("b")).toBeNull();
    expect(backend.used.has("b")).toBe(false);
  });

  it("reads the last uses back from the store, as after a reload", async () => {
    let now = 5_000_000;
    const backend = memory();
    const first = new ThumbCache(backend, 2, () => now);
    await first.store("old", jpeg());
    now += 100_000;
    await first.store("new", jpeg());
    now += 100_000;
    const reloaded = new ThumbCache(backend, 2, () => now);
    await reloaded.store("newest", jpeg());
    expect([...backend.records.keys()].sort()).toEqual(["new", "newest"]);
  });

  it("ignores a record it did not write", async () => {
    const backend = memory();
    const cache = new ThumbCache(backend);
    backend.records.set("a", { thumb: "not a blob" });
    backend.records.set("b", "nope");
    backend.records.set("c", { thumb: jpeg(0) });
    backend.records.set("d", { thumb: jpeg(600 * 1024) });
    for (const key of ["a", "b", "c", "d"]) expect(await cache.read(key)).toBeNull();
  });

  it("never throws when IndexedDB is unavailable", async () => {
    const cache = new ThumbCache(broken);
    expect(await cache.read("a")).toBe("unavailable");
    expect(await cache.store("a", jpeg())).toBe(false);
    expect(await cache.store("a", null)).toBe(false);
  });
});

describe("thumbnails — the queue", () => {
  it("makes at most two at once, in order, and a waiting one can leave the line", async () => {
    const queue = new ThumbQueue(2);
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const task = (name: string) => () => new Promise<string>((resolve) => {
      started.push(name);
      gates.set(name, () => resolve(name));
    });
    const a = queue.run(task("a"));
    const b = queue.run(task("b"));
    const c = queue.run(task("c"));
    const d = queue.run(task("d"));
    expect(started).toEqual(["a", "b"]);
    c.cancel();
    expect(await c.done).toBeNull();
    gates.get("a")?.();
    expect(await a.done).toBe("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["a", "b", "d"]);
    // Leaving the line once running changes nothing.
    b.cancel();
    gates.get("b")?.();
    gates.get("d")?.();
    expect(await b.done).toBe("b");
    expect(await d.done).toBe("d");
    expect(started).not.toContain("c");
  });

  it("answers null for a task that throws, and moves on", async () => {
    const queue = new ThumbQueue(1);
    const failing = queue.run(() => Promise.reject(new Error("decode")));
    const next = queue.run(async () => "next");
    expect(await failing.done).toBeNull();
    expect(await next.done).toBe("next");
  });
});
