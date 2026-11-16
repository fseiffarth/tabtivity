/** The PDF viewer's metadata panel (#pdf-meta): what the document says about itself,
 *  read on open, and the pending `delete all` a Save writes. */
import { useCallback, useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { readPdfMetadata, type PdfMetadata } from "./pdfDoc";
import { useT, type TranslationKey } from "../../../lib/i18n";

/** The eight standard `/Info` field names, bound to their wording (#pdf-meta). A
 *  map rather than a derived key, because these are the only names in the dict that
 *  belong to the format: everything else is the producer's own invention, and the
 *  lookup missing is how the panel knows to print the raw name instead. */
const META_FIELD_KEYS: Record<string, TranslationKey> = {
  Title: "pdfMeta.field.Title",
  Author: "pdfMeta.field.Author",
  Subject: "pdfMeta.field.Subject",
  Keywords: "pdfMeta.field.Keywords",
  Creator: "pdfMeta.field.Creator",
  Producer: "pdfMeta.field.Producer",
  CreationDate: "pdfMeta.field.CreationDate",
  ModDate: "pdfMeta.field.ModDate",
};

/**
 * The panel's state. `stripMeta` is a pending edit with no page to sit on: Save reads
 * it, and a load disarms it (`setStripMeta(false)`, `setMeta(null)`).
 */
export function usePdfMetadata({ doc }: { doc: PDFDocumentProxy | null }) {
  const t = useT();
  // ── Deleting the metadata (#pdf-meta) ────────────────────────────────────
  // Unlike a blackout, this is not an edit to the arrangement — there is no page it
  // belongs to — so it rides beside it as one flag on the save. It is deliberately
  // *pending* rather than immediate: nothing is written until Save, so it is as
  // cancellable as every other edit in this viewer, and one Save writes the lot.
  /** The metadata panel is open. */
  const [metaOpen, setMetaOpen] = useState(false);
  /** A save would write the file with no metadata at all. */
  const [stripMeta, setStripMeta] = useState(false);
  /** What the loaded document says about itself, read once per load. `null` while
   *  the read is still out — "nothing found" and "not asked yet" are different
   *  answers, and only the first may be reported as an empty list. */
  const [meta, setMeta] = useState<PdfMetadata | null>(null);

  /** A metadata field's name. Only the eight standard `/Info` keys are translated —
   *  everything else is a name the producer invented, and printing an i18n key back
   *  at the reader is worse than printing the producer's own word. */
  const metaFieldLabel = useCallback(
    (key: string) => {
      const label = META_FIELD_KEYS[key];
      return label ? t(label) : key;
    },
    [t],
  );

  // Read what the document says about itself, on demand rather than at load: the
  // panel is the only thing that shows it, and pdf.js has to be asked, so a reader
  // who never opens it pays nothing — including on the reload of every recompile.
  useEffect(() => {
    if (!metaOpen || !doc || meta) return;
    let cancelled = false;
    void readPdfMetadata(doc).then((m) => {
      if (!cancelled) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, [metaOpen, doc, meta]);

  return { metaOpen, setMetaOpen, stripMeta, setStripMeta, meta, setMeta, metaFieldLabel };
}
