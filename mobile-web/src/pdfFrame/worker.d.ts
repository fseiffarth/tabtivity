// The legacy pdf.js builds ship no declarations of their own beyond the main
// module's re-export; the frame only hands the worker module to pdf.js.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
