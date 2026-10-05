import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFWorker } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// pdf.js parses and renders on a Web Worker; point it at the bundled worker
// asset (Vite emits a hashed URL that resolves in dev and in the packaged
// build). Set here, once, because every opener below goes through this module —
// the viewer, the deck, the present window (which loads the viewer's module for
// nothing else, and a worker-less pdf.js parses on the UI thread: a black
// projector for seconds on a 300-page document) and the TeX hover preview.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Open PDF bytes with pdf.js — the one call every opener goes through, so that a
 * load which FAILS gives back the Worker it was given.
 *
 * `getDocument()` spawns a Worker per document, and the only thing that ends it
 * is `loadingTask.destroy()`. When the load succeeds the caller owns the task
 * (`doc.loadingTask`) and destroys it when the document goes. When the promise
 * REJECTS nobody owned anything: every caller wrote
 * `await getDocument(…).promise` and let the rejection propagate, and the Worker
 * behind it stayed — a thread, a JavaScript VM of its own with the worker script
 * parsed into it, about 18 MB, unreferenced and uncollectable. Measured in an
 * offscreen WebKitGTK 2.52.6: twelve rejected loads left twelve `WebCore: Worker`
 * threads, heap pressure on the page reclaimed none, and destroying each task
 * freed each one.
 *
 * That was the LaTeX leak (2026-09-08). A build rewrites the PDF over several
 * seconds while the viewer polls its mtime every 1.5 s and retries a truncated
 * read thirteen times, 250 ms apart — each attempt a rejected load, each a Worker
 * kept — so one compile cost dozens and a working session hundreds: the main
 * window was found holding 303 worker threads at 4.7 GB, and the renderer that
 * had crashed that morning (WebKit's own trap) held 575 at 8.7 GB. The memory
 * watchdog could not name it — a mapping is "[anon]" whether it is a canvas or a
 * dead worker's heap — which is why the renderer report now carries the thread
 * count as well.
 *
 * Destroying a failed task is safe: pdf.js resolves its setup capability in a
 * `finally`, so `destroy()` always reaches the worker teardown, and it never
 * changes the error the caller sees.
 */
export async function loadPdf(
  data: Uint8Array,
  /** A worker the caller owns (see {@link PdfWorkerSlot}). Without one the load
   *  spawns a Worker of its own, which the document's task then owns. */
  worker?: PDFWorker,
): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument(worker ? { data, worker } : { data });
  try {
    return await task.promise;
  } catch (e) {
    // The rejection is the caller's; the worker is nobody's. Fire and forget —
    // waiting on it would only delay the error, and its own failure says
    // nothing the caller can act on.
    void task.destroy().catch(() => {});
    throw e;
  }
}

/** How long a {@link PdfWorkerSlot} waits for its documents' teardown before it
 *  ends the worker under them anyway. */
const WORKER_RELEASE_DEADLINE_MS = 10_000;

/**
 * One pdf.js Worker for an owner that opens document after document — the PDF
 * viewer, which reloads its file on every LaTeX build (and up to thirteen times per
 * build while the compiler is still writing it).
 *
 * Without it every one of those loads spawned a Worker of its own: a thread, a
 * JavaScript VM with the 1.2 MB worker script parsed into it again (~18 MB), torn
 * down a moment later when the next build replaced the document. pdf.js keeps any
 * number of documents apart on one worker, and a document opened on a worker it
 * was handed leaves that worker alone when its task is destroyed — so the owner
 * holds one for its whole life and ends it once, in {@link dispose}.
 *
 * Started on first use. After {@link dispose} it hands out nothing, so a load that
 * races the owner's unmount gets a Worker of its own, which its task ends.
 */
export class PdfWorkerSlot {
  private worker: PDFWorker | null = null;
  private disposed = false;

  /** The slot's worker, started now if it is not running; `undefined` once disposed. */
  get(): PDFWorker | undefined {
    if (this.disposed) return undefined;
    // A worker something else destroyed would fail every later load on it.
    if (this.worker?.destroyed) this.worker = null;
    this.worker ??= new pdfjs.PDFWorker();
    return this.worker;
  }

  /**
   * End the worker — after `pending`, the teardown of the documents still open on
   * it, has settled (a document's `destroy()` is a round trip to the worker, and
   * terminating first would leave it waiting forever), but no later than
   * {@link WORKER_RELEASE_DEADLINE_MS}.
   */
  dispose(pending: readonly Promise<unknown>[] = []): void {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, WORKER_RELEASE_DEADLINE_MS);
    });
    void Promise.race([Promise.allSettled(pending), deadline]).then(() => {
      clearTimeout(timer);
      worker.destroy();
    });
  }
}
