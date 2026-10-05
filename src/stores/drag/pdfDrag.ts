/**
 * Dragging PDF pages out of one page strip and into another — in the same window, or
 * across two Tabtivity windows.
 *
 * Two problems have to be solved separately, because they have different shapes:
 *
 *  1. **The bytes.** A detached subwindow (#42) is a separate WebView with its own JS
 *     heap, so the dragged pages cannot travel as a JavaScript object. They are
 *     extracted into a small PDF, parked in the backend (`pdf_clip_set`), and the
 *     drag carries only the TOKEN naming them. Whichever strip the drop lands in
 *     fetches them (`pdf_clip_get`). Events stay tiny.
 *
 *  2. **The position.** DOM pointer events do NOT cross an OS window boundary on
 *     WebKitGTK, and their units diverge across engines under DPI scaling. So once a
 *     drag leaves its own window the position comes from polling the OS cursor in
 *     physical desktop px (`lib/window/coords`), exactly as the tab drag-dock does, and each
 *     window converts to its OWN client px at the leaf (`physToClient`).
 *
 * On release the origin window streams a single END carrying the LAST POLLED cursor
 * — never the DOM release coordinates, which on WebKitGTK are reported inside the
 * origin window even when the cursor is visibly over another one. Every window
 * receives it, and the one whose outer rect actually contains that point claims the
 * drop and acknowledges. A Shift-drag (a move, not a copy) only removes the pages
 * from the source once that acknowledgement arrives, so a drop that lands nowhere can
 * never destroy them.
 */
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  snapshotFrame,
  physToClient,
  pointInOuter,
  type ClientPoint,
  type PhysPoint,
  type WindowFrame,
} from "../../lib/window/coords";

/** The dragged pages, as parked in the backend page clipboard. */
export interface PageTransfer {
  /** `pdf_clip_set` token naming a small PDF holding exactly the dragged pages. */
  token: string;
  count: number;
}

/** A resolved drop: which strip, and where in it. */
export interface DropTarget {
  stripId: string;
  /** Insertion index among the strip's cards (`movePages`/`insertPages` convention). */
  index: number;
}

/** What a mounted strip publishes so a foreign drag can find and feed it. */
export interface StripHandle {
  el: HTMLElement;
  /** Insertion index for a point in this window's client px. */
  indexAt: (p: ClientPoint) => number;
  /** Splice the transferred pages in at `index`. */
  onImport: (transfer: PageTransfer, index: number) => void;
  /** Paint (or clear) the insertion caret. */
  setCaret: (index: number | null) => void;
}

// Every page strip mounted in THIS window that accepts page drops. Module-level
// rather than a React context because a drop is resolved from a raw desktop
// coordinate, outside any component's tree.
const strips = new Map<string, StripHandle>();

export function registerPageStrip(id: string, handle: StripHandle): () => void {
  strips.set(id, handle);
  return () => {
    strips.delete(id);
  };
}

/** The strip under `p` (this window's client px), and where in it a drop would land.
 *  `exclude` skips the strip the drag came from — that case is a plain reorder. */
export function resolveDropTarget(p: ClientPoint, exclude?: string): DropTarget | null {
  for (const [id, s] of strips) {
    if (id === exclude) continue;
    const r = s.el.getBoundingClientRect();
    if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) {
      return { stripId: id, index: s.indexAt(p) };
    }
  }
  return null;
}

/** Paint the caret on `target`'s strip and clear it everywhere else. */
export function paintCaret(target: DropTarget | null): void {
  for (const [id, s] of strips) {
    s.setCaret(target && target.stripId === id ? target.index : null);
  }
}

export function importInto(target: DropTarget, transfer: PageTransfer): boolean {
  const s = strips.get(target.stripId);
  if (!s) return false;
  s.onImport(transfer, target.index);
  return true;
}

// ── "A page drag is in flight" ───────────────────────────────────────────────
// The spring-loaded rail: a PDF viewer whose rail is CLOSED is not a drop target at
// all — no mounted strip means nothing in `strips` and, since the foreign listener is
// refcounted by mounted strips, nobody listening either. So every viewer subscribes
// to this signal (at the VIEWER level, which is always mounted for an open PDF) and
// opens its rail for the duration of a drag, making every open document a possible
// destination without the reader having to arm each one by hand.
//
// It is deliberately NOT derived from the `PDF_DRAG_*` events alone: a drop that
// lands in the window it started in never emits an END (`PageStrip` resolves it
// straight from the DOM), so the rails opened for it would never be told to close.
// The strip therefore reports the drag's lifetime directly, and the events only carry
// it to the OTHER windows.

type DragActiveListener = (active: boolean) => void;
const activeListeners = new Set<DragActiveListener>();

/** Tell every subscriber in THIS window whether a page drag is in flight. */
export function setPageDragActive(active: boolean): void {
  for (const fn of [...activeListeners]) fn(active);
}

// The window-level event listener, refcounted like the foreign-drag one so it exists
// exactly while at least one viewer is subscribed.
let activityRefs = 0;
let stopActivity: Promise<() => void> | null = null;

/** Carry another window's drag start/end into this window's `setPageDragActive`. */
async function listenPageDragActivity(): Promise<() => void> {
  const me = currentWindowLabel();
  try {
    const unStart = await listen<PdfDragStart>(PDF_DRAG_START, (ev) => {
      if (ev.payload.originLabel === me) return; // our own: reported directly
      setPageDragActive(true);
    });
    const unEnd = await listen<PdfDragEnd>(PDF_DRAG_END, (ev) => {
      if (ev.payload.originLabel === me) return;
      setPageDragActive(false);
    });
    return () => {
      unStart();
      unEnd();
    };
  } catch {
    return () => {}; // no Tauri event bus (tests)
  }
}

/**
 * Be told when a page drag starts and ends, anywhere. Installs the window-level
 * listener on the first subscriber and drops it with the last. Returns an unsubscribe.
 */
export function subscribePageDragActive(fn: DragActiveListener): () => void {
  activeListeners.add(fn);
  activityRefs += 1;
  if (activityRefs === 1) stopActivity = listenPageDragActivity();
  return () => {
    activeListeners.delete(fn);
    activityRefs -= 1;
    if (activityRefs === 0 && stopActivity) {
      const pending = stopActivity;
      stopActivity = null;
      void pending.then((f) => f());
    }
  };
}

// ── The cross-window protocol ────────────────────────────────────────────────
// Mirrors `stores/detached`'s DETACHED_DRAG_* stream: identity + physical coords out,
// a resolved drop in. Every payload carries the origin window's label so a window can
// ignore the events it emitted itself (Tauri broadcasts to all webviews, including the
// sender), leaving same-window drops to the direct DOM path above.

export const PDF_DRAG_START = "pdf-page-drag-start";
export const PDF_DRAG_MOVE = "pdf-page-drag-move";
export const PDF_DRAG_END = "pdf-page-drag-end";
export const PDF_DROP_ACK = "pdf-page-drop-ack";

export interface PdfDragStart {
  originLabel: string;
  count: number;
}
export interface PdfDragMove {
  originLabel: string;
  physX: number;
  physY: number;
}
export interface PdfDragEnd {
  originLabel: string;
  token: string;
  count: number;
  physX: number;
  physY: number;
  /** Shift was held: the origin will DELETE the pages, but only once acknowledged. */
  shift: boolean;
  cancelled: boolean;
}
export interface PdfDropAck {
  token: string;
  accepted: boolean;
}

/** Fire-and-forget: outside Tauri (tests) there is no event bus, and that is fine. */
function post(event: string, payload: unknown): void {
  try {
    void emit(event, payload).catch(() => {});
  } catch {
    /* no Tauri event bus */
  }
}

export function emitPdfDragStart(originLabel: string, count: number): void {
  post(PDF_DRAG_START, { originLabel, count } satisfies PdfDragStart);
}
export function emitPdfDragMove(originLabel: string, p: PhysPoint): void {
  post(PDF_DRAG_MOVE, { originLabel, physX: p.x, physY: p.y } satisfies PdfDragMove);
}
export function emitPdfDragEnd(e: PdfDragEnd): void {
  post(PDF_DRAG_END, e);
}

/** This window's label, or `""` outside Tauri. */
export function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "";
  }
}

/**
 * Listen, in THIS window, for page drags coming from ANOTHER one: track the cursor to
 * paint an insertion caret, and claim the drop if it lands here.
 *
 * Registered once per window (`PageStrip` refcounts it, so it exists exactly while at
 * least one droppable strip is mounted). Returns an unlisten.
 */
export async function listenForeignPageDrags(): Promise<() => void> {
  const me = currentWindowLabel();
  // Snapshotted when a foreign drag starts: a window does not move mid-gesture, and
  // this is what maps the streamed desktop cursor into our own client px.
  let frame: WindowFrame | null = null;
  let snapping = false;

  /** Take the frame snapshot if we do not have one yet. Idempotent and in-flight
   *  guarded, because it is driven by the cursor stream (many calls per second).
   *
   *  It is not enough to do this on START: a spring-loaded rail MOUNTS mid-drag, so
   *  this listener can come into existence after the start we needed to hear. Without
   *  a late snapshot such a window has no frame, maps no cursor, and silently refuses
   *  every drop — the pages would bounce off the very rail that opened for them. */
  const ensureFrame = (): void => {
    if (frame || snapping) return;
    snapping = true;
    void snapshotFrame()
      .then((f) => {
        frame = f;
      })
      .catch(() => {})
      .finally(() => {
        snapping = false;
      });
  };

  const clientOf = (physX: number, physY: number): ClientPoint | null => {
    const p = { x: physX, y: physY };
    if (!frame || !pointInOuter(frame, p)) return null;
    return physToClient(frame, p);
  };

  try {
    const unStart = await listen<PdfDragStart>(PDF_DRAG_START, (ev) => {
      if (ev.payload.originLabel === me) return; // our own drag: handled via the DOM
      ensureFrame();
    });

    const unMove = await listen<PdfDragMove>(PDF_DRAG_MOVE, (ev) => {
      if (ev.payload.originLabel === me) return;
      ensureFrame(); // we may have mounted after the start (a spring-loaded rail)
      const c = clientOf(ev.payload.physX, ev.payload.physY);
      paintCaret(c ? resolveDropTarget(c) : null);
    });

    const unEnd = await listen<PdfDragEnd>(PDF_DRAG_END, (ev) => {
      if (ev.payload.originLabel === me) return;
      paintCaret(null);
      const { cancelled, physX, physY, token, count } = ev.payload;
      if (cancelled) return;
      const c = clientOf(physX, physY);
      // Only the window the cursor is ACTUALLY over resolves a target, so exactly one
      // window claims the drop and exactly one acknowledgement comes back.
      const target = c ? resolveDropTarget(c) : null;
      if (!target) return;
      const accepted = importInto(target, { token, count });
      post(PDF_DROP_ACK, { token, accepted } satisfies PdfDropAck);
    });

    return () => {
      unStart();
      unMove();
      unEnd();
    };
  } catch {
    return () => {}; // no Tauri event bus (tests)
  }
}

/**
 * Wait for a drop of `token` to be acknowledged by whichever window claimed it.
 * Resolves `false` if nobody does within `timeoutMs` — a Shift-drag (a move) must NOT
 * delete the pages from the source in that case.
 */
export async function awaitDropAck(token: string, timeoutMs = 4000): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const timer = window.setTimeout(() => {
        if (done) return;
        done = true;
        void un.then((f) => f());
        resolve(false);
      }, timeoutMs);
      const un = listen<PdfDropAck>(PDF_DROP_ACK, (ev) => {
        if (done || ev.payload.token !== token) return;
        done = true;
        window.clearTimeout(timer);
        void un.then((f) => f());
        resolve(ev.payload.accepted);
      });
    });
  } catch {
    return false;
  }
}
