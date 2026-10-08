import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePaneSleepHold } from "../sleepWhenHidden";

/**
 * Unsaved work held in THIS window's heap — what would be lost if the window
 * were destroyed. Native Wayland closes an inactive scope's popout (it cannot
 * be parked reliably there) and rebuilds it from the main window's record on
 * return; the record carries tabs and layout, not an editor's buffer. So before
 * the backend closes a popout it asks (`detached-retire-request-<label>`), the
 * popout settles what autosave would save anyway, and answers whether anything
 * is still unsaved — in which case the window is minimized instead of closed.
 *
 * Per heap by construction (a module-level set), so a popout reports only its
 * own panes.
 */
export interface UnsavedWork {
  /** Anything this source holds that is not on disk. */
  dirty(): boolean;
  /** Save what the user's autosave setting would save anyway. Never writes
   *  what autosave would not (with it off, only the user saves). */
  flush?(): Promise<void>;
}

const sources = new Set<UnsavedWork>();

export function registerUnsavedWork(source: UnsavedWork): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** Let React commit what a blur set off (state → draft → the saver's update). */
const settleRender = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Flush every source (bounded by `timeoutMs`), then report whether the window
 * is clean. A flush that fails or runs out of time leaves its source dirty, and
 * so answers "not clean" — the safe side.
 *
 * The focused element is blurred first: the inline editors (YAML grid/tree
 * cells, Bib cards) keep a half-typed value in their own state and commit it
 * into the file's draft only on blur (or Enter). Without the blur that value
 * is invisible to every source here and would go with the window.
 */
export async function settleUnsavedWork(timeoutMs = 1800): Promise<boolean> {
  const focused = typeof document !== "undefined" ? document.activeElement : null;
  if (focused instanceof HTMLElement && focused !== document.body) {
    focused.blur();
    await settleRender();
    await settleRender();
  }
  const flushes = [...sources].map((s) => s.flush?.().catch(() => {}));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(flushes),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return [...sources].every((s) => !s.dirty());
}

/**
 * Register a component's unsaved state. `flush` saves it when that is what the
 * component would do anyway (an autosaving view); `isDirty` reads the live flag
 * when the rendered `dirty` lags a flush (state updates land a render later).
 * Unsaved state also keeps a sleepable pane awake (performance plan §5.3): a
 * sleeping pane is unmounted, which would drop it.
 */
export function useUnsavedWork(
  dirty: boolean,
  flush?: () => Promise<void>,
  isDirty?: () => boolean,
): void {
  usePaneSleepHold(dirty);
  const ref = useRef({ dirty, flush, isDirty });
  ref.current = { dirty, flush, isDirty };
  useEffect(
    () =>
      registerUnsavedWork({
        dirty: () => ref.current.isDirty?.() ?? ref.current.dirty,
        flush: () => ref.current.flush?.() ?? Promise.resolve(),
      }),
    [],
  );
}

/** The backend's "your scope was left" request to one popout (see
 *  `subwindow::RETIRE_REQUEST_EVENT_PREFIX`). */
export const retireRequestEvent = (label: string) => `detached-retire-request-${label}`;

/** The backend's "that retire is off, the window stays" (see
 *  `subwindow::RETIRE_WITHDRAWN_EVENT_PREFIX`). */
export const retireWithdrawnEvent = (label: string) => `detached-retire-withdrawn-${label}`;

/** Backstop for a clean answer's input block: the window is normally destroyed
 *  within milliseconds, or told it stays (withdrawn event, or an answer nobody
 *  was waiting for). Only a lost event leaves it this long. */
export const RETIRE_INERT_MS = 10_000;

/**
 * Popout side of the retire handshake: on each request, settle and answer;
 * then tell the backend this popout can answer (`detached_retire_ready`) —
 * until it does, a scope-out closes it without asking. Returns the unlisten.
 *
 * A "clean" answer makes the page inert until the window goes: without that, a
 * keystroke landing between the answer and the destroy would be new unsaved
 * work in a window already promised to be empty of it. (Re-sampling right
 * before the answer would still leave that gap; inert closes it.) The block is
 * lifted as soon as the window is known to stay: the backend's withdrawn event,
 * or an answer it was no longer waiting for (`detached_retire_ack` → false).
 */
export async function answerRetireRequests(label: string): Promise<() => void> {
  const unRequest = await listen(retireRequestEvent(label), () => {
    void settleUnsavedWork()
      .then(async (clean) => {
        const hold = clean ? holdInert(RETIRE_INERT_MS) : null;
        const accepted = await invoke<boolean>("detached_retire_ack", { clean }).catch(
          () => false,
        );
        if (hold != null && accepted === false) releaseInert(hold);
      })
      .catch(() => {});
  });
  const unWithdrawn = await listen(retireWithdrawnEvent(label), () => releaseAllInert());
  // A backend from before this protocol has no such command; harmless.
  void invoke("detached_retire_ready").catch(() => {});
  return () => {
    unRequest();
    unWithdrawn();
  };
}

/** Live input blocks, by token: the page is inert while any is held, so an
 *  older hold's backstop can never lift a newer one. */
const inertHolds = new Set<number>();
let nextHold = 0;

function syncInert(): void {
  if (inertHolds.size > 0) document.body.setAttribute("inert", "");
  else document.body.removeAttribute("inert");
}

function holdInert(ms: number): number {
  const token = ++nextHold;
  inertHolds.add(token);
  syncInert();
  setTimeout(() => releaseInert(token), ms);
  return token;
}

function releaseInert(token: number): void {
  inertHolds.delete(token);
  syncInert();
}

function releaseAllInert(): void {
  inertHolds.clear();
  syncInert();
}
