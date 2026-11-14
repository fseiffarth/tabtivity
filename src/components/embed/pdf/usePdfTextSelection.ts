/** The PDF viewer's text selection (#pdf-textselect): the selection read across every
 *  page, and the words copied once it settles. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { readViewerSelection, type ViewerSelection } from "./selection";
import type { ViewerPos } from "../fileViewer/viewerState";

/**
 * The selection over the whole page stack (re-read on `selectionchange` and on zoom),
 * copy-on-select (per tab, `ViewerState.pdfCopyOnSelect`) and the bar's "Copied" flash.
 */
export function usePdfTextSelection({
  doc,
  contentRef,
  scale,
  scaleRef,
  viewPos,
}: {
  doc: PDFDocumentProxy | null;
  /** The page stack the selection is measured in. */
  contentRef: React.RefObject<HTMLDivElement>;
  scale: number;
  /** The committed scale, read by the listeners bound once. */
  scaleRef: React.MutableRefObject<number>;
  viewPos: ViewerPos;
}) {
  // ── Selecting text on the page (#pdf-textselect) ─────────────────────────
  // The selection itself is the browser's — the text layer puts a transparent span
  // over every run of glyphs and an ordinary drag does the rest. What is owned here is
  // everything that happens *because* of one: the words on the clipboard, and the bar
  // that turns a selection into a highlight.
  //
  // It is read in ONE place rather than per page, and that is what makes a drag across
  // a page break work: to the engine that is one selection, to a PDF it is one
  // annotation per sheet, and only something holding all the page boxes at once can
  // divide it up (`selection.ts`).
  const [sel, setSel] = useState<ViewerSelection | null>(null);
  /** Bumped when the current selection was copied — the bar's "Copied" flash, and
   *  nothing else: the copy itself has already happened by then. */
  const [copiedNonce, setCopiedNonce] = useState(0);
  /** The text most recently put on the clipboard by this viewer — the once-per-
   *  selection guard the copy effect below explains. */
  const lastCopied = useRef<string | null>(null);
  const [copyOnSelect, setCopyOnSelect] = useState(
    () => viewPos.initial?.pdfCopyOnSelect !== false,
  );
  const setCopyOnSelectPersisted = useCallback(
    (on: boolean) => {
      setCopyOnSelect(on);
      // Turning it back on has to be able to copy the selection that is up right now:
      // the once-per-selection guard below would otherwise treat it as already done.
      if (on) lastCopied.current = null;
      viewPos.persist({ pdfCopyOnSelect: on });
    },
    [viewPos],
  );
  const copyOnSelectRef = useRef(copyOnSelect);
  copyOnSelectRef.current = copyOnSelect;

  /** Re-read the selection. Cheap enough to run on every `selectionchange` (it is
   *  rectangles off a live range), and it has to be: the bar has to follow a drag
   *  rather than appear where it started. */
  const readSelection = useCallback(() => {
    const host = contentRef.current;
    setSel(host ? readViewerSelection(host, scaleRef.current) : null);
  }, [contentRef, scaleRef]);

  useEffect(() => {
    if (!doc) return;
    // `selectionchange` is the only event that fires for every way a selection can
    // come about — a drag, a double-click on a word, Shift+arrow, Ctrl+A — which is
    // exactly why the bar is driven off it rather than off pointerup.
    document.addEventListener("selectionchange", readSelection);
    return () => document.removeEventListener("selectionchange", readSelection);
  }, [doc, readSelection]);
  // A zoom does not change the selection, but it changes where it is on screen, so
  // the boxes the bar is placed from have to be measured again.
  useEffect(() => { readSelection(); }, [scale, readSelection]);

  /**
   * Put the selected words on the clipboard, once the gesture has settled.
   *
   * On `mouseup`/`keyup` rather than on `selectionchange`, and that is the whole
   * subtlety: a drag fires the latter on every pixel, so copying there would write the
   * clipboard a hundred times for one sentence and leave whichever partial selection
   * happened to be last if the reader let go outside the window.
   *
   * Each selection is written **once**, and that guard is not an optimization. Both
   * events fire for things that have nothing to do with this viewer — a key pressed in
   * a terminal in the next pane, a button clicked anywhere in the window — while a
   * selection made minutes ago is still up on the page. Without it, everything the
   * reader copied in between would be silently overwritten by the same old sentence,
   * over and over, which is the worst thing a feature like this can do.
   *
   * A failed write is swallowed. The clipboard can be refused (no permission, no
   * clipboard in the environment) and this is a convenience nobody asked for in the
   * moment — reporting it would be an error banner over a document for something the
   * reader did not ask to happen.
   */
  useEffect(() => {
    if (!doc) return;
    const settle = () => {
      if (!copyOnSelectRef.current) return;
      const host = contentRef.current;
      const now = host ? readViewerSelection(host, scaleRef.current) : null;
      if (!now || now.text === lastCopied.current) return;
      lastCopied.current = now.text;
      navigator.clipboard?.writeText(now.text).catch(() => {});
      setCopiedNonce((n) => n + 1);
    };
    window.addEventListener("mouseup", settle);
    window.addEventListener("keyup", settle);
    return () => {
      window.removeEventListener("mouseup", settle);
      window.removeEventListener("keyup", settle);
    };
  }, [doc, contentRef, scaleRef]);

  /** The flash belongs to the selection that was copied, so a new one starts unflashed
   *  rather than inheriting the last one's "Copied". */
  const copiedFor = useRef<{ nonce: number; text: string } | null>(null);
  if (copiedFor.current?.nonce !== copiedNonce) {
    copiedFor.current = { nonce: copiedNonce, text: sel?.text ?? "" };
  }
  const copiedNow = !!sel && copiedFor.current?.text === sel.text;

  return { sel, setSel, copiedNow, copyOnSelect, setCopyOnSelectPersisted };
}
