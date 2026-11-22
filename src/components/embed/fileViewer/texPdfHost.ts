import type { PdfWordPhrase } from "../../../lib/viewers/tex/reverseWord";
import { createContext, useContext } from "react";

/**
 * A host that shows a TeX source and its compiled PDF in ONE pane — the agent
 * tab's Data view — instead of as two coupled tabs.
 *
 * Without a host (every viewer tab, the TeX workspace) the TeX ⇄ PDF round
 * trip opens tabs: a build or a forward search opens/refocuses the PDF tab
 * (`TexView`'s `openPdf`), a reverse click opens the source tab
 * (`sourceJump`'s `jumpToSource`). Under a host both land in the host's pane
 * instead, so the round trip never leaves it. The path-keyed channels stay as
 * they are: the PDF's reveal (`pdfSync`) and the editor's caret jump
 * (`editorJump`) wait in their stores until the newly shown viewer consumes
 * them on mount.
 *
 * Each call answers whether the host showed the file; false (no in-app viewer
 * for it there) falls back to the tab behaviour.
 */
export interface TexPdfHost {
  /** Show the compiled PDF `pdf` in the host's pane. */
  showPdf: (pdf: string) => boolean;
  /** Show the source `input` in the host's pane, caret at `line`/`column`
   *  (1-based; column 0 = the line's start). */
  showSource: (input: string, line: number, column: number, phrase?: PdfWordPhrase) => boolean;
}

export const TexPdfHostContext = createContext<TexPdfHost | null>(null);

/** The pane's TeX ⇄ PDF host, or null in a tab (the default routing). */
export function useTexPdfHost(): TexPdfHost | null {
  return useContext(TexPdfHostContext);
}
