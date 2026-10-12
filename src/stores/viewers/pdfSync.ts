import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SyncRect, CaretPhrase } from "../../lib/viewers/tex/tex";

/**
 * Cross-tab "reveal + highlight this PDF box" channel for SyncTeX forward
 * search. After a compile, `synctex view` maps the source caret to a page + box
 * in the PDF; the PDF tab is a separate component (often already open), so the
 * TeX side posts the request here keyed by the absolute PDF path and `PdfCanvas`
 * for that path consumes it — scrolling the page into view and flashing a
 * highlight. The `nonce` lets a repeat reveal of the same spot fire again.
 *
 * #42 cross-window: the PDF may be popped out into a detached OS window, which is
 * a SEPARATE webview with its own Zustand heap — a local store write would never
 * reach it. So `requestReveal` also broadcasts the request over a global Tauri
 * event; every window registers `listenPdfReveal` and applies an incoming reveal
 * to its own store, so whichever window hosts the PDF reveals it. The originating
 * window stamps `from` and skips its own echo (it already applied it locally).
 */
export interface RevealRequest {
  rect: SyncRect;
  nonce: number;
  /** When set, the clicked word + its surrounding phrase: the PDF view narrows
   *  `rect` (a SyncTeX line box) to the exact clicked word, using the phrase to
   *  disambiguate which occurrence of a common word to highlight. */
  phrase?: CaretPhrase;
  /** A compile just replaced the PDF bytes, so load them before revealing. */
  afterReload?: boolean;
}

/** Tauri event carrying a reveal across the main/detached window boundary. */
export const PDF_REVEAL_EVENT = "pdf-sync-reveal";

/** Envelope for a cross-window reveal (the request plus the originating window's
 *  label, so a window ignores the echo of its own broadcast). */
export interface PdfRevealEnvelope {
  pdf: string;
  rect: SyncRect;
  phrase?: CaretPhrase;
  afterReload?: boolean;
  from: string;
}

/** Tauri event carrying a plain re-read request across the window boundary. */
export const PDF_RELOAD_EVENT = "pdf-sync-reload";

/** Envelope for a cross-window reload: just the PDF and the origin label. */
export interface PdfReloadEnvelope {
  pdf: string;
  from: string;
}

/** Tauri event carrying a compile's start or end across the window boundary. */
export const PDF_COMPILE_EVENT = "pdf-sync-compile";

/** Envelope for a cross-window compile notice: the PDF the build will rewrite,
 *  whether it is starting or over, and the origin label. */
export interface PdfCompileEnvelope {
  pdf: string;
  compiling: boolean;
  from: string;
}

/** The current window's Tauri label, or "" outside a Tauri context (tests). */
function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "";
  }
}

interface PdfSyncStore {
  byPath: Record<string, RevealRequest>;
  /** Ask the PDF view for `pdf` to scroll to and highlight `rect`. When `phrase`
   *  is given, the view refines `rect` down to the clicked word on the target
   *  page. Applies locally AND broadcasts so a PDF hosted in another (detached)
   *  window reveals too (#42). */
  requestReveal: (
    pdf: string,
    rect: SyncRect,
    phrase?: CaretPhrase,
    afterReload?: boolean,
  ) => void;
  /** Record a reveal in THIS window's store (the local half of requestReveal, and
   *  what `listenPdfReveal` calls for a reveal broadcast from another window). */
  applyReveal: (
    pdf: string,
    rect: SyncRect,
    phrase?: CaretPhrase,
    afterReload?: boolean,
  ) => void;
  /** Clear the pending reveal for `pdf` once the view has applied it. */
  consume: (pdf: string) => void;
  /** Per-PDF counter bumped by `requestReload`; the view for that path re-reads
   *  its bytes whenever it advances. Never cleared — the counter IS the signal. */
  reloadByPath: Record<string, number>;
  /** Ask the PDF view for `pdf` to re-read the file from disk, with nothing to
   *  reveal. A compile that ends without a SyncTeX box (caret in the preamble, a
   *  comment line) still replaced — or, on a latexmk no-op, deliberately left —
   *  the bytes, and the tab's own mtime poll is no help in the second case: the
   *  file did not change, so nothing tells a tab whose last load caught the PDF
   *  mid-write that there is a complete one to read. Compile is therefore always
   *  "show me the file as it is on disk". Local + broadcast, like a reveal. */
  requestReload: (pdf: string) => void;
  /** The local half of `requestReload` (also what the cross-window listener
   *  calls for a reload broadcast from another window). */
  applyReload: (pdf: string) => void;
  /** How many builds are rewriting each PDF right now. While one is, the view
   *  for that path leaves its mtime poll alone: a multi-pass latexmk build
   *  rewrites the file several times and the poll used to read every
   *  intermediate PDF (and retry each one it caught mid-write) — the compile's
   *  own reload request at the end is the one read that matters. */
  compilingByPath: Record<string, number>;
  /** A build that will rewrite `pdf` has started. Local + broadcast. */
  beginCompile: (pdf: string) => void;
  /** That build is over (however it ended). Local + broadcast. */
  endCompile: (pdf: string) => void;
  /** The local half of `beginCompile`/`endCompile`. */
  applyCompile: (pdf: string, compiling: boolean) => void;
}

// Monotonic reveal counter. The nonce must STRICTLY increase across reveals:
// `PdfCanvas` copies each reveal into local `highlight` state that isn't cleared
// on consume, so a nonce derived from the (deleted-on-consume) store entry would
// reset to 1 and a repeat reveal would look unchanged — firing the scroll/flash
// only once. A module counter never resets, so every reveal re-triggers it.
let revealSeq = 0;

export const usePdfSyncStore = create<PdfSyncStore>((set, get) => ({
  byPath: {},
  reloadByPath: {},
  compilingByPath: {},
  applyCompile: (pdf, compiling) =>
    set((s) => {
      const n = Math.max(0, (s.compilingByPath[pdf] ?? 0) + (compiling ? 1 : -1));
      const next = { ...s.compilingByPath };
      if (n === 0) delete next[pdf];
      else next[pdf] = n;
      return { compilingByPath: next };
    }),
  beginCompile: (pdf) => {
    get().applyCompile(pdf, true);
    try {
      emit(PDF_COMPILE_EVENT, { pdf, compiling: true, from: currentLabel() } satisfies PdfCompileEnvelope).catch(
        () => {},
      );
    } catch {
      /* no Tauri event bus available (synchronous failure) */
    }
  },
  endCompile: (pdf) => {
    get().applyCompile(pdf, false);
    try {
      emit(PDF_COMPILE_EVENT, { pdf, compiling: false, from: currentLabel() } satisfies PdfCompileEnvelope).catch(
        () => {},
      );
    } catch {
      /* no Tauri event bus available (synchronous failure) */
    }
  },
  applyReload: (pdf) =>
    set((s) => ({
      reloadByPath: { ...s.reloadByPath, [pdf]: (s.reloadByPath[pdf] ?? 0) + 1 },
    })),
  requestReload: (pdf) => {
    get().applyReload(pdf);
    try {
      emit(PDF_RELOAD_EVENT, { pdf, from: currentLabel() } satisfies PdfReloadEnvelope).catch(
        () => {},
      );
    } catch {
      /* no Tauri event bus available (synchronous failure) */
    }
  },
  applyReveal: (pdf, rect, phrase, afterReload) =>
    set((s) => ({
      byPath: {
        ...s.byPath,
        [pdf]: { rect, nonce: ++revealSeq, phrase, afterReload },
      },
    })),
  requestReveal: (pdf, rect, phrase, afterReload) => {
    get().applyReveal(pdf, rect, phrase, afterReload);
    // Broadcast to the other window(s) in case the PDF is popped out there (#42).
    // Best-effort: a non-Tauri env (tests) simply skips the broadcast.
    try {
      emit(PDF_REVEAL_EVENT, {
        pdf,
        rect,
        phrase,
        afterReload,
        from: currentLabel(),
      } satisfies PdfRevealEnvelope).catch(() => {});
    } catch {
      /* no Tauri event bus available (synchronous failure) */
    }
  },
  consume: (pdf) =>
    set((s) => {
      if (!(pdf in s.byPath)) return {};
      const next = { ...s.byPath };
      delete next[pdf];
      return { byPath: next };
    }),
}));

/**
 * Register THIS window's listener for cross-window reveal broadcasts (#42). Every
 * window (main shell + each detached popout) calls this once at startup; an
 * incoming reveal that didn't originate here is applied to the local store, so
 * the `PdfCanvas` hosting that PDF reveals it regardless of which window the TeX
 * editor lives in. Returns an unlisten. No-ops outside a Tauri context.
 */
export async function listenPdfReveal(): Promise<() => void> {
  const self = currentLabel();
  try {
    const unReveal = await listen<PdfRevealEnvelope>(PDF_REVEAL_EVENT, (ev) => {
      const { pdf, rect, phrase, afterReload, from } = ev.payload;
      if (from === self) return; // we already applied our own reveal locally
      usePdfSyncStore.getState().applyReveal(pdf, rect, phrase, afterReload);
    });
    // The reload channel rides the same registration: one call per window.
    const unReload = await listen<PdfReloadEnvelope>(PDF_RELOAD_EVENT, (ev) => {
      const { pdf, from } = ev.payload;
      if (from === self) return;
      usePdfSyncStore.getState().applyReload(pdf);
    });
    // And the compile notices: a PDF popped out into its own window must hold
    // its poll for a build running in the main window's editor.
    const unCompile = await listen<PdfCompileEnvelope>(PDF_COMPILE_EVENT, (ev) => {
      const { pdf, compiling, from } = ev.payload;
      if (from === self) return;
      usePdfSyncStore.getState().applyCompile(pdf, compiling);
    });
    return () => {
      unReveal();
      unReload();
      unCompile();
    };
  } catch {
    return () => {};
  }
}
