import { formatBytes } from "./formatBytes";
import type { TranslationKey } from "./i18n";
import { terminalFor } from "./terminal/terminalRegistry";
import { asleepPty } from "./terminal/sleepingPtys";
import { isDetachedWindow } from "../stores/detachedContext";
import { isDetachedPtyId, isPtyTabKind, splitSubPaneKey, type TabEntry } from "../stores/tabs";

/**
 * What an open tab holds in this window's renderer — an ESTIMATE, read on
 * demand (`docs/done/tab_cost_plan.md` step 1). `AppResourceUsage` is process-wide
 * and the renderer is one process, so `/proc` cannot say which tab holds the
 * memory; this module can, roughly, for the two kinds that hold the most:
 *
 *  - a terminal: its xterm buffer, `rows × (cols × 12 + 64)` bytes (a
 *    `BufferLine` is a `Uint32Array`, three words per cell);
 *  - a PDF: twice the file bytes its viewer parsed (the viewed file plus any
 *    merged-in document), with the page count.
 *
 * Nothing here runs in a hot path or on a timer: the terminal side reads the
 * live xterm through `terminalRegistry` when asked, and the PDF side is a
 * registry `PdfCanvas` writes only when its documents change. No Zustand store
 * — nobody subscribes to a cost, they read it when a card or the Settings list
 * renders — except the loaded-PDF COUNT, which `PdfLoadWarningHost` follows
 * through {@link subscribeLoadedPdfCount} (notified only when it moves).
 *
 * Per window, like `terminalRegistry`: a popout reads its own registries and
 * never reports a tab as shown elsewhere.
 *
 * Not counted: renderer canvases/GL, painted PDF page bitmaps, and the
 * backend's PTY replay buffers (Rust heap).
 */

// ── The loaded-PDF notice ────────────────────────────────────────────────────

/** Loaded PDF documents in the main window at which the soft notice shows —
 *  a sibling of `PDF_DOC_RELEASE_MS` / `PDF_PAGE_RELEASE_MS`. */
export const PDF_LOADED_WARN_AT = 8;
/** The notice re-arms once the count is back down to this. */
export const PDF_LOADED_REARM_AT = 5;
/** No notice this long after the window started: a restore with many PDF tabs
 *  is transient, the hidden ones release after `PDF_DOC_RELEASE_MS`. */
export const PDF_WARN_GRACE_MS = 2 * 60_000;

export interface PdfWarnState {
  armed: boolean;
}

export const PDF_WARN_INITIAL: PdfWarnState = { armed: true };

/**
 * One hysteresis step of the loaded-PDF notice, on a count change. Fires when
 * the count is at or over {@link PDF_LOADED_WARN_AT} while armed (then
 * disarms); re-arms at or under {@link PDF_LOADED_REARM_AT}. Inside the grace
 * period it never fires and stays armed, so the next change after it — or the
 * host's one look when the grace ends ({@link pdfWarnGraceLeft}) — fires if
 * the count is still high. `nowMs` is the window's age (`performance.now()`).
 */
export function pdfWarnStep(
  state: PdfWarnState,
  count: number,
  nowMs: number,
): { state: PdfWarnState; fire: boolean } {
  if (count <= PDF_LOADED_REARM_AT) {
    return { state: state.armed ? state : { armed: true }, fire: false };
  }
  if (state.armed && count >= PDF_LOADED_WARN_AT && nowMs >= PDF_WARN_GRACE_MS) {
    return { state: { armed: false }, fire: true };
  }
  return { state, fire: false };
}

/**
 * Milliseconds until the grace period ends, or null once it has. The notice
 * host checks the count once then: a restore that crossed
 * {@link PDF_LOADED_WARN_AT} inside the grace and stays there would otherwise
 * never see another count change, and never warn.
 */
export function pdfWarnGraceLeft(nowMs: number): number | null {
  const left = PDF_WARN_GRACE_MS - nowMs;
  return left > 0 ? left : null;
}

// ── PDF document registry ────────────────────────────────────────────────────

interface PdfEntry {
  /** The viewer's tab key (`<tab>#<path>` for a TeX workspace pane); absent
   *  for a viewer outside a tab (a side-panel preview). */
  tabKey?: string;
  path: string;
  /** Pages over every open source; 0 while no document is loaded. */
  pages: number;
  /** File bytes parsed: the viewed file's plus any merged source's. */
  bytes: number;
}

const pdfs = new Map<object, PdfEntry>();
const countWatchers = new Set<(count: number) => void>();
let lastCount = 0;

function loaded(e: PdfEntry): boolean {
  return e.pages > 0;
}

function notifyIfCountChanged(): void {
  const n = loadedPdfCount();
  if (n === lastCount) return;
  lastCount = n;
  for (const cb of [...countWatchers]) cb(n);
}

/** A `PdfCanvas` mounted (`token` is its own, kept for its whole life). It
 *  holds no document yet, so it counts nowhere until {@link updatePdfDoc}. */
export function registerPdfDoc(token: object, meta: { tabKey?: string; path: string }): void {
  pdfs.set(token, { tabKey: meta.tabKey, path: meta.path, pages: 0, bytes: 0 });
}

/** The canvas's documents changed: `pages` 0 means none is loaded (a file
 *  switch in flight, a failed load). Unknown tokens are ignored. */
export function updatePdfDoc(
  token: object,
  next: { pages: number; bytes: number; tabKey?: string; path?: string },
): void {
  const e = pdfs.get(token);
  if (!e) return;
  pdfs.set(token, {
    tabKey: "tabKey" in next ? next.tabKey : e.tabKey,
    path: next.path ?? e.path,
    pages: Math.max(0, next.pages),
    bytes: Math.max(0, next.bytes),
  });
  notifyIfCountChanged();
}

export function unregisterPdfDoc(token: object): void {
  if (!pdfs.delete(token)) return;
  notifyIfCountChanged();
}

/** PDF viewers in this window holding a loaded document. */
export function loadedPdfCount(): number {
  let n = 0;
  for (const e of pdfs.values()) if (loaded(e)) n++;
  return n;
}

/** Follow {@link loadedPdfCount}: `cb` runs only when it changes. Returns the
 *  unsubscribe. */
export function subscribeLoadedPdfCount(cb: (count: number) => void): () => void {
  countWatchers.add(cb);
  return () => {
    countWatchers.delete(cb);
  };
}

export interface PdfCost {
  /** Registry entries for the tab (loaded or not). */
  entries: number;
  /** Of those, the ones holding a document. */
  docs: number;
  pages: number;
  bytes: number;
  estBytes: number;
}

function sumPdf(match: (e: PdfEntry) => boolean): PdfCost | null {
  let entries = 0;
  let docs = 0;
  let pages = 0;
  let bytes = 0;
  for (const e of pdfs.values()) {
    if (!match(e)) continue;
    entries++;
    if (!loaded(e)) continue;
    docs++;
    pages += e.pages;
    bytes += e.bytes;
  }
  return entries === 0 ? null : { entries, docs, pages, bytes, estBytes: 2 * bytes };
}

/** What `tabKey`'s PDF viewers hold — its own and its TeX sub-panes'
 *  (`<tabKey>#…`); null when it has no registry entry at all. */
export function pdfCostFor(tabKey: string): PdfCost | null {
  return sumPdf((e) => e.tabKey === tabKey || (e.tabKey?.startsWith(`${tabKey}#`) ?? false));
}

/** Loaded PDF viewers belonging to none of `tabKeys` (side-panel previews,
 *  or a tab of a scope not listed); null when there are none. */
export function untabbedPdfCost(tabKeys: ReadonlySet<string>): PdfCost | null {
  const cost = sumPdf((e) => {
    if (!loaded(e)) return false;
    if (e.tabKey === undefined) return true;
    return !tabKeys.has(splitSubPaneKey(e.tabKey)?.tab ?? e.tabKey);
  });
  return cost && cost.docs > 0 ? cost : null;
}

// ── Terminals ────────────────────────────────────────────────────────────────

/** Bytes per xterm row: three `Uint32Array` words per cell plus the line's
 *  own object overhead. */
const BYTES_PER_CELL = 12;
const BYTES_PER_ROW = 64;

export interface TerminalCost {
  /** live: an xterm here; asleep: §5.3 sleeping pane, the program runs on;
   *  elsewhere: shown in a popout (main window); unbuilt: no xterm yet (§5.2). */
  state: "live" | "asleep" | "elsewhere" | "unbuilt";
  /** Scrollback rows in use (beyond the viewport). */
  rows?: number;
  cols?: number;
  /** The scrollback cap, in rows. */
  cap?: number;
  estBytes?: number;
}

export function terminalCost(ptyId: string): TerminalCost {
  if (asleepPty(ptyId)) return { state: "asleep" };
  const term = terminalFor(ptyId);
  if (term) {
    const length = term.buffer.normal.length;
    const cols = term.cols;
    const cap = term.options.scrollback ?? 1000;
    return {
      state: "live",
      rows: Math.min(cap, Math.max(0, length - term.rows)),
      cols,
      cap,
      estBytes: length * (cols * BYTES_PER_CELL + BYTES_PER_ROW),
    };
  }
  if (!isDetachedWindow() && isDetachedPtyId(ptyId)) return { state: "elsewhere" };
  return { state: "unbuilt" };
}

// ── Per tab ──────────────────────────────────────────────────────────────────

export type TabCost =
  | ({ kind: "terminal" } & TerminalCost)
  | ({ kind: "pdf" } & PdfCost)
  | { kind: "unloaded" }
  | { kind: "elsewhere" };

function isPdfViewerTab(tab: TabEntry): boolean {
  return tab.kind === "embed" && (tab.viewer === "pdf" || tab.viewer === "texworkspace");
}

/**
 * What `tab` (of `scope`) holds here, or null when there is nothing to say:
 * kinds this module does not estimate, and a PDF viewer still loading (or whose
 * load failed). A PDF tab with no viewer mounted is `unloaded` (released after
 * `PDF_DOC_RELEASE_MS`, or its pane sleeps), or `elsewhere` when a popout
 * shows it.
 */
export function tabCost(scope: string, tab: TabEntry): TabCost | null {
  if (isPtyTabKind(tab.kind)) return { kind: "terminal", ...terminalCost(`${scope}:${tab.key}`) };
  const pdf = pdfCostFor(tab.key);
  if (pdf) return pdf.docs > 0 ? { kind: "pdf", ...pdf } : null;
  if (!isPdfViewerTab(tab)) return null;
  if (!isDetachedWindow() && isDetachedPtyId(`${scope}:${tab.key}`)) return { kind: "elsewhere" };
  return { kind: "unloaded" };
}

/** The estimate of a cost, when it has one. Never 0 for "nothing known". */
export function costBytes(cost: TabCost | null): number | undefined {
  if (!cost) return undefined;
  if (cost.kind === "terminal" || cost.kind === "pdf") return cost.estBytes;
  return undefined;
}

export interface RankedTabCost<T> {
  /** Tabs with an estimate, largest first. */
  ranked: (T & { cost: TabCost; estBytes: number })[];
  /** Tabs with a cost line but no estimate (asleep, unbuilt, unloaded, elsewhere). */
  others: number;
}

/** Largest estimate first; tabs with nothing to say (null) are dropped,
 *  those with a line but no estimate are only counted. */
export function rankTabCosts<T extends { cost: TabCost | null }>(entries: readonly T[]): RankedTabCost<T> {
  const ranked: (T & { cost: TabCost; estBytes: number })[] = [];
  let others = 0;
  for (const e of entries) {
    if (!e.cost) continue;
    const est = costBytes(e.cost);
    if (est === undefined) others++;
    else ranked.push({ ...e, cost: e.cost, estBytes: est });
  }
  ranked.sort((a, b) => b.estBytes - a.estBytes);
  return { ranked, others };
}

/** The readout text for a cost, as the hover card and the Settings list show it. */
export function describeTabCost(
  cost: TabCost,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  switch (cost.kind) {
    case "terminal":
      if (cost.state === "asleep") return t("tabCost.terminalAsleep");
      if (cost.state === "elsewhere") return t("tabCost.elsewhere");
      if (cost.state === "unbuilt") return t("tabCost.terminalUnbuilt");
      return t("tabCost.terminal", {
        size: formatBytes(cost.estBytes ?? 0),
        rows: (cost.rows ?? 0).toLocaleString(),
        cap: (cost.cap ?? 0).toLocaleString(),
      });
    case "pdf":
      return t(cost.pages === 1 ? "tabCost.pdfOne" : "tabCost.pdf", {
        size: formatBytes(cost.estBytes),
        pages: cost.pages.toLocaleString(),
        file: formatBytes(cost.bytes),
      });
    case "unloaded":
      return t("tabCost.unloaded");
    case "elsewhere":
      return t("tabCost.elsewhere");
  }
}

/** Test seam. */
export function _clearTabCostForTest(): void {
  pdfs.clear();
  countWatchers.clear();
  lastCount = 0;
}
