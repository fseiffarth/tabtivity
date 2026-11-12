// Review an agent's print request (`services::print_mcp`) in the shared print
// preview: the PDF is the snapshot the backend took at the agent's call (never
// re-read from disk), shown as page images like the PDF viewer's print, laid
// out as a vector PDF and handed to the system print dialog on Approve.

import { basename } from "../paths";
import { translateNow } from "../i18n";
import { loadPdf } from "./pdfLoad";
import { initialPages } from "./pageModel";
import { layoutPrintPdf } from "./pdfPrintLayout";
import {
  PDF_PREVIEW_SCALE,
  PDF_PRINT_CSS,
  printHtmlBody,
  renderPdfPagesToImages,
  type NativePrint,
  type PrintOptions,
} from "./print";
import { NUP_CHOICES, type NUp } from "./printImposition";
import { printPdfNative } from "../window/printing";
import {
  decidePrintRequest,
  printRequestPdf,
  type PrintRequest,
  type PrintRequestOptions,
} from "../window/printMcp";

/** The agent's options as preview options: copies, a custom range, grayscale,
 *  and — when it named them — pages per sheet, booklet and two-sided. A
 *  booklet is two-sided on the short edge, as the preview's own switch sets it.
 *  Everything else stays the user's. */
export function presetFor(options: PrintRequestOptions): Partial<PrintOptions> {
  const preset: Partial<PrintOptions> = { copies: options.copies, grayscale: options.grayscale };
  if (options.booklet) {
    preset.booklet = true;
    preset.duplex = "short";
  } else {
    if (options.pagesPerSheet && (NUP_CHOICES as readonly number[]).includes(options.pagesPerSheet)) {
      preset.nup = options.pagesPerSheet as NUp;
    }
    if (options.duplex) preset.duplex = options.duplex;
  }
  if (options.pages) {
    preset.pages = "custom";
    preset.range = options.pages;
  } else {
    preset.pages = "all";
    preset.range = "";
  }
  return preset;
}

/**
 * Open the preview on `request`. Resolves when the preview closes. Rejects
 * when the snapshot cannot be had (`gone`: the request ended meanwhile) or the
 * PDF does not open.
 */
export async function reviewPrintRequest(request: PrintRequest, requester: string): Promise<void> {
  const bytes = await printRequestPdf(request.id);
  // pdf.js may take ownership of the buffer it is handed; the vector layout
  // below needs the bytes again, so it gets a copy.
  const doc = await loadPdf(bytes.slice());
  try {
    const sheets = initialPages(doc.numPages);
    const images = await renderPdfPagesToImages(sheets, () => doc, PDF_PREVIEW_SCALE);
    const body = images.map((src) => `<div class="print-page"><img src="${src}" alt=""></div>`).join("");
    const title = basename(request.file);
    const native: NativePrint = async (sequence, opts) => {
      const laidOut = await layoutPrintPdf(bytes, sequence, opts);
      return printPdfNative(laidOut, title, { paper: opts.paper, grayscale: opts.grayscale, duplex: opts.duplex });
    };
    await printHtmlBody(body, PDF_PRINT_CSS, title, native, {
      requester,
      note: request.note,
      preset: presetFor(request.options),
      claim: () => decidePrintRequest(request.id, "claim").then(() => true, () => false),
      release: () => decidePrintRequest(request.id, "release"),
      onPrinted: () => decidePrintRequest(request.id, "printed"),
      onReject: () => decidePrintRequest(request.id, "rejected"),
    });
  } finally {
    void doc.loadingTask.destroy().catch(() => {});
  }
}

/** The words a failed review is shown with. */
export function reviewFailure(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg === "gone" ? translateNow("printRequest.gone") : translateNow("printRequest.failed", { msg });
}
