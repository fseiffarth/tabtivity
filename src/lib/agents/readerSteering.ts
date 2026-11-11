/**
 * Keyboard steering's reach into an agent tab's Reader pane.
 *
 * The Reader's view (Chat / Diffs / Files / Terminal) is local state of
 * `TerminalView`, and its Diffs and Files panels are components of their own;
 * steering lives outside both. This module is the meeting point, keyed by the
 * pane id (`${scope}:${tab.key}`, the `TerminalView` id), in four parts:
 *
 *  - the **view registry**: `TerminalView` registers what it can show and how
 *    to switch (`registerReaderViews`), steering's view-cycle key calls it;
 *  - the **facts**: the same pane publishes the view it shows and the views it
 *    offers, so the legend redraws after a switch (`useReaderViewFacts`);
 *  - the **inside registry**: the Diffs / Files panel registers what the
 *    scroll level's keys do to it (`registerReaderInside`); `useKeyboard` asks
 *    it first;
 *  - `useSteeringInside`: whether steering is Inside this pane right now, for
 *    the cursor a view draws.
 *
 * No Tauri here; React only for the hooks. Last registration wins, and an
 * unregister is a no-op once another registration replaced it (a tab attached
 * twice mounts two panes under one id).
 */
import { useSyncExternalStore } from "react";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { rootViewShown, useRootOverlayStore } from "../../stores/rootOverlay";
import { useTabsStore } from "../../stores/tabs";
import { steeringTabsActive } from "../shortcuts/steeringScope";
import type { SteeringAction } from "../shortcuts/steeringBindings";

export type ReaderViewId = "chat" | "changes" | "files" | "terminal";

/** The cycle's order. */
export const READER_VIEW_ORDER: readonly ReaderViewId[] = ["chat", "changes", "files", "terminal"];

/** What a pane with a view strip lets steering do to it. */
export interface ReaderViewTarget {
  /** The view shown now. */
  view(): ReaderViewId;
  /** The views the strip offers (not greyed). The shown one may be missing. */
  offered(): ReaderViewId[];
  /** Switch to `view`. */
  show(view: ReaderViewId): void;
}

/** What the scroll level's keys do inside a shown Diffs / Files view. */
export type ReaderInsideResult = "handled" | "leave" | "pass";

export interface ReaderInsideTarget {
  view: "changes" | "files";
  /**
   * One resolved key (`action` is never null). `handled`: done. `leave`:
   * steering steps out to the tabs. `pass`: the scroll level's own meaning
   * (scroll the content, Work here, the prompt). Targets answer `pass` for
   * `work` and `agentPrompt`, `handled` for actions the view does not use, and
   * ignore `e.repeat` on open / toggle / mode actions.
   */
  key(action: SteeringAction, e: KeyboardEvent): ReaderInsideResult;
}

/**
 * The next view in the cycle: `dir` 1 forward, -1 back, wrapping, skipping any
 * view not in `offered`. The current view stays selectable (it may have gone
 * grey while open), so with nothing else offered the cycle stays put.
 */
export function cycleReaderView(current: ReaderViewId, offered: readonly ReaderViewId[], dir: 1 | -1): ReaderViewId {
  const n = READER_VIEW_ORDER.length;
  const from = READER_VIEW_ORDER.indexOf(current);
  for (let step = 1; step <= n; step++) {
    const candidate = READER_VIEW_ORDER[(((from + dir * step) % n) + n) % n];
    if (candidate === current || offered.includes(candidate)) return candidate;
  }
  return current;
}

const viewTargets = new Map<string, ReaderViewTarget>();
const insideTargets = new Map<string, ReaderInsideTarget>();

function register<T>(map: Map<string, T>, id: string, target: T): () => void {
  map.set(id, target);
  return () => {
    if (map.get(id) === target) map.delete(id);
  };
}

/** Register pane `id`'s view switching; the returned function unregisters. */
export function registerReaderViews(id: string, target: ReaderViewTarget): () => void {
  return register(viewTargets, id, target);
}

export function readerViewFor(id: string): ReaderViewTarget | null {
  return viewTargets.get(id) ?? null;
}

/** Register pane `id`'s Inside target (Diffs or Files, while shown). */
export function registerReaderInside(id: string, target: ReaderInsideTarget): () => void {
  return register(insideTargets, id, target);
}

export function readerInsideFor(id: string): ReaderInsideTarget | null {
  return insideTargets.get(id) ?? null;
}

const questionFields = new Map<string, (index: number) => void>();

/** Register pane `id`'s Chat question: how to open the field under the free-text row `index`. */
export function registerQuestionField(id: string, open: (index: number) => void): () => void {
  return register(questionFields, id, open);
}

/** Opens the Chat field under pane `id`'s free-text row `index`; false when the pane shows no such question (the terminal then types the words). */
export function openQuestionField(id: string, index: number): boolean {
  const open = questionFields.get(id);
  if (!open) return false;
  open(index);
  return true;
}

/** What steering does to the Chat's queued prompts (Send now, Cancel and edit). */
export interface QueueMoves {
  /** Prompts are still queued and the CLI's queue can be acted on. */
  available(): boolean;
  send(): void;
  pull(): void;
}

const queueMoves = new Map<string, QueueMoves>();

export function registerQueueMoves(id: string, moves: QueueMoves): () => void {
  return register(queueMoves, id, moves);
}

/** Pane `id`'s queue moves when it has queued prompts to act on. */
export function queueMovesFor(id: string): QueueMoves | null {
  const moves = queueMoves.get(id);
  return moves?.available() ? moves : null;
}

/** What a pane shows and offers, for the legend. */
export interface ReaderViewFacts {
  view: ReaderViewId;
  offered: readonly ReaderViewId[];
}

const factsById = new Map<string, ReaderViewFacts>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publish (or, with null, withdraw) pane `id`'s facts. An unchanged value
 * notifies nobody. A withdrawal by a replaced registration is the caller's to
 * avoid: pass the `facts` object back as `only` to withdraw it only if it is
 * still the published one.
 */
export function publishReaderViewFacts(id: string, facts: ReaderViewFacts | null, only?: ReaderViewFacts): void {
  const cur = factsById.get(id);
  if (facts === null) {
    if (!cur || (only && cur !== only)) return;
    factsById.delete(id);
    notify();
    return;
  }
  if (cur && cur.view === facts.view && cur.offered.join() === facts.offered.join()) return;
  factsById.set(id, facts);
  notify();
}

export function readerViewFacts(id: string | null | undefined): ReaderViewFacts | null {
  return id ? (factsById.get(id) ?? null) : null;
}

/** The facts of pane `id`, live; null when it has no view strip. */
export function useReaderViewFacts(id: string | null | undefined): ReaderViewFacts | null {
  return useSyncExternalStore(
    subscribe,
    () => readerViewFacts(id),
    () => null,
  );
}

/**
 * Whether steering is Inside the pane `id` right now: the mode on, the scroll
 * level, and the walked tabs' active tab is that pane. A view draws its cursor
 * from this; there is no enter / leave callback.
 */
export function useSteeringInside(id: string | null | undefined): boolean {
  const onScroll = useKeyboardSteeringStore((s) => s.active && s.level === "scroll");
  const rootUp = useRootOverlayStore((s) => rootViewShown(s));
  const activeId = useTabsStore(() => {
    const a = steeringTabsActive();
    return a ? `${a.scope}:${a.tab.key}` : null;
  });
  void rootUp; // re-evaluates the selector above when the Root view comes or goes
  return !!id && onScroll && activeId === id;
}
