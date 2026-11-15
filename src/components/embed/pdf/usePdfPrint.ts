/** The PDF viewer's print: the shared preview from page images, the real PDF to the
 *  system print UI. */
import { useCallback, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { isServerClient } from "../../../lib/transport/linkState";
import {
  renderPdfPagesToImages,
  printHtmlBody,
  PDF_PREVIEW_SCALE,
  PDF_PRINT_CSS,
  PDF_PRINT_SCALE,
  type NativePrint,
} from "../../../lib/viewers/print";
import type { PageList } from "../../../lib/viewers/pageModel";
import { buildPdf, type PdfSources } from "./pdfDoc";
import { nativePresets, printPdfNative } from "../../../lib/window/printing";
import { layoutPrintPdf } from "../../../lib/viewers/pdfPrintLayout";
import { basename } from "../../../lib/paths";
import { useT } from "../../../lib/i18n";

/**
 * Prints the ARRANGEMENT (what is on screen, blackouts burned in, pending metadata
 * deletion applied), not the file, so an edited PDF prints without being saved.
 */
export function usePdfPrint({
  path,
  doc,
  pages,
  sources,
  redactDpi,
  stripMeta,
  setEditError,
}: {
  path: string;
  doc: PDFDocumentProxy | null;
  pages: PageList;
  sources: PdfSources;
  /** Resolution the blacked-out sheets are flattened at. */
  redactDpi: number;
  stripMeta: boolean;
  setEditError: (msg: string | null) => void;
}) {
  const t = useT();
  // Print: the shared preview arranges the job (paper, margins, sheet order, turns,
  // selection) from page images — the webview can't show a PDF — but what goes to
  // the printer is the real PDF: `native` rebuilds the preview's sheets as vector
  // pages (`layoutPrintPdf`) and hands them to the system print UI
  // (`printPdfNative`; GTK / WebView2 / PDFKit). Only where there is no native
  // path does the preview print its images. `printing` disables the button while
  // the (async) render runs.
  const [printing, setPrinting] = useState(false);
  // `fromSheet` (1-based, an arrangement position like the preview's range):
  // right-click → Print from here opens the preview on that sheet to the end.
  const handlePrint = useCallback(async (fromSheet?: number) => {
    if (!doc || printing || pages.length === 0) return;
    setPrinting(true);
    setEditError(null);
    try {
      // The ARRANGEMENT, not the file: printing an edited PDF prints what is on
      // screen, without having to save it first. Preview sheet n is `sheets[n-1]`.
      const sheets = pages;
      const title = basename(path);
      // The window's native print sends the vector PDF, so its preview images
      // need only screen sharpness; the browser client keeps paper's.
      const scale = isServerClient() ? PDF_PRINT_SCALE : PDF_PREVIEW_SCALE;
      const images = await renderPdfPagesToImages(sheets, (id) => sources.get(id)?.doc, scale);
      const body = images
        .map((src) => `<div class="print-page"><img src="${src}" alt=""></div>`)
        .join("");
      const native: NativePrint = async (sequence, opts) => {
        // The bytes Save and a page drag-out write — blackouts burned in, pending
        // metadata deletion applied — one page per viewer sheet, in its order.
        const bytes = await buildPdf(sheets, sources, {
          emptyMsg: t("pdfViewer.pdfBuildEmpty"),
          sourceClosedMsg: t("pdfViewer.pdfSourceClosed"),
          redactDpi,
          stripMetadata: stripMeta,
        });
        const laidOut = await layoutPrintPdf(bytes, sequence, opts, { bakeGrayscale: !nativePresets().grayscale });
        return printPdfNative(laidOut, title, {
          paper: opts.paper,
          grayscale: opts.grayscale,
          duplex: opts.duplex,
        });
      };
      await printHtmlBody(
        body,
        PDF_PRINT_CSS,
        title,
        native,
        undefined,
        fromSheet && fromSheet > 1 ? { pages: "custom", range: `${fromSheet}-` } : undefined,
      );
    } catch (e) {
      setEditError(
        t("pdfViewer.printFailed", { msg: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      setPrinting(false);
    }
  }, [doc, printing, pages, sources, redactDpi, stripMeta, path, t, setEditError]);

  return { printing, handlePrint };
}
