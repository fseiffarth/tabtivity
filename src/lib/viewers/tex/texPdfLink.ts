import { useShallow } from "zustand/react/shallow";
import { useTabsStore, type TabEntry } from "../../../stores/tabs";

/**
 * The TeX ⇄ PDF tab coupling, DERIVED rather than stored.
 *
 * A compiled PDF lives in its own tab beside the LaTeX source (see
 * `FileViewerPane`'s workspace host: compiling builds `<stem>.pdf` next to the
 * source and opens it via `openLinkedFile`), so the two halves of one document
 * end up as two unrelated-looking tabs in the strip. This module answers "which
 * open tab is this one's other half?" so the tab bars can mark the pair.
 *
 * It is a pure function over the tab list on purpose — no new `TabEntry` field,
 * no store, nothing persisted:
 *   - The coupling is already implied by the paths (`<dir>/<stem>.tex` ↔
 *     `<dir>/<stem>.pdf`), so recording it again would be a second source of
 *     truth that a rename, a restart or a hand-opened PDF could contradict.
 *   - Deriving it means it also holds for pairs Tabtivity never opened together —
 *     a PDF opened straight from the file tree next to an already-open source
 *     is marked exactly like a freshly compiled one.
 *   - Nothing has to be cleaned up when either tab closes: the partner simply
 *     stops being found, and the mark disappears on the next render.
 */

/** The `.tex` viewers a PDF can be coupled to: the single-tab LaTeX WORKSPACE
 *  and the standalone `.tex` editor. Both compile to `<stem>.pdf` beside the
 *  source, so both are valid halves of a pair. */
const TEX_VIEWERS = new Set(["texworkspace", "tex"]);

/** The other half: the in-app PDF viewer. */
const PDF_VIEWERS = new Set(["pdf"]);

/** `path` with its final extension removed, lowercased for the comparison — file
 *  systems Tabtivity runs on are case-insensitive (Windows, macOS) often enough
 *  that a `Paper.tex` / `paper.pdf` pair should still read as one document. */
function stemKey(path: string, ext: string): string | null {
  const lower = path.toLowerCase();
  if (!lower.endsWith(ext)) return null;
  return lower.slice(0, -ext.length);
}

/** True for an in-app viewer tab rendering `path` with one of `viewers`. */
function isViewerTab(tab: TabEntry, viewers: ReadonlySet<string>): boolean {
  return (
    tab.kind === "embed" &&
    tab.viewer != null &&
    viewers.has(tab.viewer) &&
    typeof tab.embedPath === "string" &&
    tab.embedPath.length > 0
  );
}

/**
 * The tab coupled to `tab` within `tabs`, or null when there is none.
 *
 * Symmetric: given a PDF tab it returns the open `.tex` source that produces it,
 * and given a TeX source (workspace or standalone) it returns the open PDF built
 * from it. `tab` itself is never returned, and the FIRST match wins — a document
 * has one compiled PDF, and `openLinkedFile` already dedupes viewer tabs by
 * path, so a second candidate would have to be a hand-made duplicate.
 */
export function texPdfPartner(tabs: readonly TabEntry[], tab: TabEntry): TabEntry | null {
  const pdfStem = isViewerTab(tab, PDF_VIEWERS) ? stemKey(tab.embedPath!, ".pdf") : null;
  const texStem = isViewerTab(tab, TEX_VIEWERS) ? stemKey(tab.embedPath!, ".tex") : null;
  if (pdfStem == null && texStem == null) return null;
  const wantViewers = pdfStem != null ? TEX_VIEWERS : PDF_VIEWERS;
  const wantExt = pdfStem != null ? ".tex" : ".pdf";
  const wantStem = pdfStem ?? texStem!;
  return (
    tabs.find(
      (other) =>
        other.key !== tab.key &&
        isViewerTab(other, wantViewers) &&
        stemKey(other.embedPath!, wantExt) === wantStem,
    ) ?? null
  );
}

/**
 * The scope's TeX/PDF viewer tabs — the only candidates a coupling search has to
 * look at — as a hook a tab bar can call once per render and then pass to
 * {@link texPdfPartner} for each of its tabs.
 *
 * A bar deliberately does NOT subscribe to the whole tab array (that widening is
 * exactly what `useGroupTabs`' fine-grained subscription bought back): the
 * shallow guard here means a bar re-renders only when a `.tex`/`.pdf` viewer tab
 * is opened, closed or changed — not when a terminal in another subwindow
 * churns. Partners are searched across the WHOLE scope on purpose, since the two
 * halves of a document very often live in different subwindows.
 */
export function useTexPdfCandidates(): TabEntry[] {
  return useTabsStore(
    useShallow((s) =>
      s.tabs.some(isTexPdfTab) ? s.tabs.filter(isTexPdfTab) : NO_TEX_PDF_TABS,
    ),
  );
}

/** True for a viewer tab that can be one half of a pair (either half). */
function isTexPdfTab(tab: TabEntry): boolean {
  return isViewerTab(tab, TEX_VIEWERS) || isViewerTab(tab, PDF_VIEWERS);
}

// Stable empty sentinel, mirroring `useGroupTabs`' EMPTY_TABS: an inline `[]`
// would be a fresh reference on every store change and defeat the shallow guard
// for the common case of a project with no LaTeX open at all.
const NO_TEX_PDF_TABS: TabEntry[] = [];
