/**
 * `loadPdf` — the one way a PDF is opened with pdf.js (`lib/viewers/pdfLoad.ts`).
 *
 * The property under test is the failure path: a `getDocument()` whose promise
 * rejects still owns a Worker, and nothing but `loadingTask.destroy()` ends it.
 * Every opener used to `await getDocument(…).promise` and let the rejection
 * propagate, and each truncated mid-compile read of a LaTeX build left one
 * Worker thread behind (303 of them in the main window on 2026-09-08).
 */
import { describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();
const { workers } = vi.hoisted(() => ({ workers: [] as { destroy: () => void }[] }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (...args: unknown[]) => getDocument(...args),
  PDFWorker: class {
    destroy = vi.fn();
    constructor() {
      workers.push(this);
    }
  },
}));

// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync, readdirSync } from "node:fs";
import { BundledPdfData, PdfWorkerSlot, loadPdf } from "../../lib/viewers/pdfLoad";

function task(promise: Promise<unknown>, destroy = vi.fn(() => Promise.resolve())) {
  return { promise, destroy };
}

describe("loadPdf", () => {
  it("returns the opened document and leaves its task to the caller", async () => {
    const doc = { numPages: 3 };
    const t = task(Promise.resolve(doc));
    getDocument.mockReturnValueOnce(t);
    await expect(loadPdf(new Uint8Array([1, 2, 3]))).resolves.toBe(doc);
    expect(t.destroy).not.toHaveBeenCalled();
    expect(getDocument).toHaveBeenCalledWith({
      data: new Uint8Array([1, 2, 3]),
      disableFontFace: true,
      BinaryDataFactory: BundledPdfData,
    });
  });

  it("never lets WebKit parse a PDF's embedded fonts", async () => {
    getDocument.mockReturnValueOnce(task(Promise.resolve({ numPages: 1 })));
    await loadPdf(new Uint8Array([1]));
    expect(getDocument.mock.lastCall?.[0]).toMatchObject({ disableFontFace: true });
  });

  it("destroys the task of a load that rejects, and rethrows the same error", async () => {
    const err = new Error("Unexpected end of file");
    const t = task(Promise.reject(err));
    getDocument.mockReturnValueOnce(t);
    await expect(loadPdf(new Uint8Array(200))).rejects.toBe(err);
    expect(t.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller's error when destroying the failed task fails too", async () => {
    const err = new Error("Invalid PDF structure");
    const t = task(
      Promise.reject(err),
      vi.fn(() => Promise.reject(new Error("worker already gone"))),
    );
    getDocument.mockReturnValueOnce(t);
    await expect(loadPdf(new Uint8Array(200))).rejects.toBe(err);
    expect(t.destroy).toHaveBeenCalledTimes(1);
  });
});

/** Where the bundled standard fonts sit on disk, and a `fetch` that serves the
 *  asset URLs Vite gave them from there (vitest has no asset server). */
const FONT_DIR = "node_modules/pdfjs-dist/standard_fonts/";
async function serveAssets(url: RequestInfo | URL): Promise<Response> {
  const path = String(url).split("?")[0];
  // Vite's dev URL: root-relative, or `/@fs/<absolute>` outside the root.
  const file: string = path.startsWith("/@fs/") ? path.slice(4) : path.slice(1);
  return new Response(new Uint8Array(readFileSync(file) as Uint8Array));
}

describe("BundledPdfData (the standard fonts pdf.js asks for)", () => {
  it("serves every standard-font file pdf.js ships, byte for byte", async () => {
    vi.stubGlobal("fetch", vi.fn(serveAssets));
    try {
      const names = (readdirSync(FONT_DIR) as string[]).filter((n) => /\.(pfb|ttf)$/.test(n));
      expect(names).toContain("LiberationSans-Regular.ttf");
      const data = new BundledPdfData();
      for (const filename of names) {
        const bytes = await data.fetch({ kind: "standardFontDataUrl", filename });
        expect(bytes).toEqual(new Uint8Array(readFileSync(FONT_DIR + filename) as Uint8Array));
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses what no URL was ever configured for: CMaps, wasm, unknown files", async () => {
    const data = new BundledPdfData();
    await expect(data.fetch({ kind: "cMapUrl", filename: "UniJIS-UCS2-H.bcmap" })).rejects.toThrow();
    await expect(data.fetch({ kind: "wasmUrl", filename: "openjpeg.wasm" })).rejects.toThrow();
    await expect(data.fetch({ kind: "standardFontDataUrl", filename: "../secret.ttf" })).rejects.toThrow();
  });
});

describe("loadPdf on a caller's worker", () => {
  it("hands the worker to pdf.js", async () => {
    const worker = { id: "w" };
    getDocument.mockReturnValueOnce(task(Promise.resolve({ numPages: 1 })));
    await loadPdf(new Uint8Array([1]), worker as never);
    expect(getDocument).toHaveBeenLastCalledWith({
      data: new Uint8Array([1]),
      worker,
      disableFontFace: true,
      BinaryDataFactory: BundledPdfData,
    });
  });
});

/**
 * `PdfWorkerSlot` — the PDF viewer's one worker, so a LaTeX build's reload (and
 * every retry of a mid-write read) stops spawning a Worker per load.
 */
describe("PdfWorkerSlot", () => {
  it("starts one worker on first use and hands the same one out after", () => {
    workers.length = 0;
    const slot = new PdfWorkerSlot();
    expect(workers).toHaveLength(0);
    const a = slot.get();
    const b = slot.get();
    expect(a).toBe(b);
    expect(workers).toHaveLength(1);
  });

  it("starts a fresh worker when its worker was destroyed elsewhere", () => {
    workers.length = 0;
    const slot = new PdfWorkerSlot();
    const a = slot.get() as unknown as { destroyed: boolean };
    a.destroyed = true;
    const b = slot.get();
    expect(b).not.toBe(a);
    expect(workers).toHaveLength(2);
  });

  it("never starts a worker just to dispose of it", () => {
    workers.length = 0;
    new PdfWorkerSlot().dispose();
    expect(workers).toHaveLength(0);
  });

  it("ends the worker only after its documents' teardown, and hands out nothing after", async () => {
    workers.length = 0;
    const slot = new PdfWorkerSlot();
    const worker = slot.get() as unknown as { destroy: ReturnType<typeof vi.fn> };
    let finish!: () => void;
    const teardown = new Promise<void>((r) => { finish = r; });
    slot.dispose([teardown, Promise.reject(new Error("already gone"))]);
    expect(slot.get()).toBeUndefined();
    await Promise.resolve();
    expect(worker.destroy).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(worker.destroy).toHaveBeenCalledTimes(1));
    expect(workers).toHaveLength(1);
  });

  it("ends the worker at the deadline when a teardown never settles", async () => {
    vi.useFakeTimers();
    try {
      workers.length = 0;
      const slot = new PdfWorkerSlot();
      const worker = slot.get() as unknown as { destroy: ReturnType<typeof vi.fn> };
      slot.dispose([new Promise(() => {})]);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(worker.destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(worker.destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
