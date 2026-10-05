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

import { PdfWorkerSlot, loadPdf } from "../../lib/viewers/pdfLoad";

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
    expect(getDocument).toHaveBeenCalledWith({ data: new Uint8Array([1, 2, 3]) });
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

describe("loadPdf on a caller's worker", () => {
  it("hands the worker to pdf.js", async () => {
    const worker = { id: "w" };
    getDocument.mockReturnValueOnce(task(Promise.resolve({ numPages: 1 })));
    await loadPdf(new Uint8Array([1]), worker as never);
    expect(getDocument).toHaveBeenLastCalledWith({ data: new Uint8Array([1]), worker });
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
