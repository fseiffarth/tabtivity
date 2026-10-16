/**
 * The REAL pdf.js, for tests that pin what our code relies on in the library
 * itself rather than in a hand-written fake of it. Use it as
 *
 *     vi.mock("pdfjs-dist", () => import("../helpers/realPdfjs"));
 *
 * so every `import … from "pdfjs-dist"` in the code under test (`pdfLoad.ts`,
 * `pageText.ts`, `pageInk.ts`, …) gets it.
 *
 * Why the `legacy` build of the same package version: the modern build the app
 * bundles calls built-ins Node 22 does not have yet (`Promise.try`,
 * `Map.prototype.getOrInsertComputed`, `Math.sumPrecise`) and fails on its
 * first message. The legacy build is the same source with those polyfilled —
 * the build the phone's PDF frame ships — so the API shapes, the parser and the
 * annotation/outline/text extraction under test are the bumped version's own.
 *
 * Node has no Worker: pdf.js runs its worker code on the main thread through
 * `globalThis.pdfjsWorker`, exactly as `mobile-web/src/pdfFrame/main.ts` does.
 * The specifier goes through a variable because the worker module ships no
 * declarations.
 */
import { VerbosityLevel, getDocument as realGetDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export * from "pdfjs-dist/legacy/build/pdf.mjs";

/** pdf.js's own `getDocument`, quiet about warnings: Node has no standard-font
 *  data, and every test would otherwise print that it fell back. Errors still
 *  print. (An explicit export wins over the star export above.) */
export const getDocument: typeof realGetDocument = (src) =>
  realGetDocument(
    src && typeof src === "object" && !ArrayBuffer.isView(src) && !(src instanceof ArrayBuffer) && !(src instanceof URL)
      ? { verbosity: VerbosityLevel.ERRORS, ...src }
      : src,
  );

const workerModule: string = "pdfjs-dist/legacy/build/pdf.worker.mjs";
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import(/* @vite-ignore */ workerModule);
