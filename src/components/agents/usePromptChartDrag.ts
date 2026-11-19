import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { bindDragRelease, dragPlatform } from "../../lib/window/dragPlatform";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import type { UsageResetMark } from "../../lib/agents/agentUsageResets";
import {
  snapToReset,
  timelineHitZone,
  type TimelineRect,
  type TimelineRects,
  type TimelineWindow,
  type TimelineZone,
} from "../../lib/agents/prompt/timeline";

/** How far the pointer must travel before a press becomes a drag. */
export const PROMPT_DRAG_THRESHOLD = 5;

export type ChartDrag =
  | {
      kind: "card";
      card: PromptChartCard;
      /** Pointer position; the ghost is drawn at pointer minus grab offset. */
      x: number;
      y: number;
      grabDx: number;
      grabDy: number;
      width: number;
      height: number;
      zone: TimelineZone;
    }
  | {
      kind: "link";
      from: PromptChartCard;
      /** The port the line starts at. */
      x1: number;
      y1: number;
      x: number;
      y: number;
      overId: string | null;
    }
  | {
      /** Cards pulled up or down their lanes for a clearer view: a sent card
       *  always, any other lane card while Shift is held. */
      kind: "lift";
      /** The timeline items' keys — the pressed one first, then the rest of
       *  the selection riding along. */
      keys: string[];
      /** Pointer travel since the press, never above the body's top. */
      dy: number;
    }
  | {
      /** A rubber band drawn across the empty lanes to select cards. */
      kind: "marquee";
      x1: number;
      y1: number;
      x: number;
      y: number;
    };

export interface ChartMeasure {
  rects: TimelineRects;
  /** The body's content width — the axis's pixel span. */
  width: number;
  scrollLeft: number;
}

export interface ChartCardRect {
  id: string;
  rect: TimelineRect;
}

interface Options {
  win: TimelineWindow;
  now: Date;
  /** The drop zones, read fresh on every move so a scrolling body stays true. */
  measure: () => ChartMeasure;
  /** Every card's rect, read once when a link drag starts. */
  measureCards: () => ChartCardRect[];
  onDropCard: (card: PromptChartCard, zone: TimelineZone, drag: Extract<ChartDrag, { kind: "card" }>) => void;
  /** The reset marks in view, and the agent a card belongs to: a snapped
   *  instant near a mark of the carried card's agent lands after the reset. */
  resets?: readonly UsageResetMark[];
  agentOf?: (card: PromptChartCard) => string | undefined;
  /** The chart's newest cards. A carry is committed from the card as it is
   *  NOW, looked up by key — the one pressed may have been delivered, removed
   *  or re-stated by the scheduler while it was in the air. */
  cards?: readonly PromptChartCard[];
  /** The pressed card is gone, or is no longer the thing that was pressed:
   *  nothing is written. */
  onStale?: () => void;
  onDropLink: (from: PromptChartCard, toId: string) => void;
  /** A lift ended: each item now sits that many px off its lane. */
  onLift: (lifts: Record<string, number>) => void;
  /** Every lane item's rect by item key, read once when a marquee starts. */
  measureItems?: () => ChartCardRect[];
  /** A marquee ended over these item keys (none for a plain click on the
   *  empty lanes); `additive` when Ctrl/⌘ was held at the press. */
  onMarquee?: (keys: string[], additive: boolean) => void;
}

/** Presses on these are the control's, never a drag's. */
const NO_DRAG = "button, input, textarea, select, a, .dropdown, [data-no-drag]";

/** A lifted card travels with the pointer, so the release lands on it and the
 *  engine follows with a click that would toggle it open. That click belongs
 *  to the drag: swallow it, and only it — the listener is gone next task. */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/**
 * The chart's two gestures — carrying a card, pulling a link out of a port —
 * as one state machine, on the pattern `TodoBoard` settled for this engine:
 *
 * - **The release is bound at pointerdown**, synchronously, through
 *   `bindDragRelease`: WebKitGTK delivers `pointermove` but never the
 *   terminal event to a listener added mid-gesture, and it ends an ordinary
 *   drop with `pointercancel` rather than `pointerup`, which that binding
 *   turns into a commit where the engine means one.
 * - **Nothing moves until the threshold**, so a click is a click. The card
 *   that was pressed never moves at all: the ghost is drawn from this state,
 *   because the card can unmount mid-gesture when a write re-keys it.
 * - **Capture goes on `documentElement`** and only where the engine needs
 *   it — a capture target that unmounts drops the capture with a spurious
 *   cancel, and on Linux the implicit grab already delivers the release.
 * - **A commit with no zone does nothing**, which is what makes a cancel
 *   that commits safe: a card dropped over nothing stays where it was.
 *
 * Hit-testing reads rects the callers measured, never `elementFromPoint`, so
 * the same gesture runs under jsdom.
 */
export function usePromptChartDrag(options: Options) {
  const [drag, setDrag] = useState<ChartDrag | null>(null);
  const latest = useRef(options);
  latest.current = options;

  const start = (
    event: ReactPointerEvent<HTMLElement>,
    gesture: {
      begin: (pointer: PointerEvent) => ChartDrag;
      move: (current: ChartDrag, pointer: PointerEvent) => ChartDrag;
      commit: (current: ChartDrag) => void;
      /** The press never crossed the threshold. */
      click?: () => void;
    },
  ) => {
    if (event.button !== 0) return;
    // Suppress the engine's own selection gesture, which otherwise hijacks
    // the pointer stream and ends it with a cancel mid-drag.
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const captureEl = document.documentElement;
    let current: ChartDrag | null = null;

    const onMove = (pointer: PointerEvent) => {
      if (!current) {
        if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < PROMPT_DRAG_THRESHOLD) return;
        if (dragPlatform.needsPointerCapture) {
          try {
            captureEl.setPointerCapture(pointerId);
          } catch {
            /* capture is an optimization; the gesture works without it */
          }
        }
        current = gesture.begin(pointer);
      } else {
        current = gesture.move(current, pointer);
      }
      setDrag(current);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(pointerId);
        } catch {
          /* already released */
        }
      }
    };
    const onCommit = () => {
      cleanup();
      const finished = current;
      current = null;
      setDrag(null);
      // Never crossed the threshold: a click, and the card's own click handles it.
      if (finished) gesture.commit(finished);
      else gesture.click?.();
    };
    const onAbort = () => {
      cleanup();
      current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    bindDragRelease({ onCommit, onAbort });
  };

  /**
   * A sent card is history — its instant is not the reader's to change — but
   * where it sits in its column is: overlapping sessions stack lanes deep, and
   * the one being read is often under another. So it moves vertically only,
   * the card itself following the pointer (nothing is dropped anywhere, so no
   * ghost). The lane's own top and the item's drawn top are read off the item
   * wrappers `PromptTimeline` renders; the lift reported is measured from the
   * lane, so a card a repack pushed against the top edge has no dead zone.
   * `keys` past the first are the rest of a selection, which move by the same
   * distance and stop together when the highest of them meets the top.
   * Returns null when the pressed card sits on no lane (the strip, the queue).
   */
  const liftGesture = (event: ReactPointerEvent<HTMLElement>, keys: string[]) => {
    const pressed = event.currentTarget.closest<HTMLElement>("[data-lane-top]");
    if (!pressed) return null;
    const body = pressed.parentElement;
    const nodes = [pressed, ...[...(body?.querySelectorAll<HTMLElement>("[data-item-key]") ?? [])]
      .filter((node) => node !== pressed && keys.includes(node.dataset.itemKey ?? ""))];
    const bases = nodes.map((node) => ({
      key: node === pressed ? keys[0] : node.dataset.itemKey!,
      top: parseFloat(node.style.top) || 0,
      laneTop: Number(node.dataset.laneTop) || 0,
    }));
    const floor = Math.max(...bases.map((base) => -base.top));
    const startY = event.clientY;
    const dyAt = (pointer: PointerEvent) => Math.max(floor, pointer.clientY - startY);
    return {
      begin: (pointer: PointerEvent): ChartDrag => ({ kind: "lift", keys: bases.map((base) => base.key), dy: dyAt(pointer) }),
      move: (current: ChartDrag, pointer: PointerEvent): ChartDrag => (current.kind === "lift" ? { ...current, dy: dyAt(pointer) } : current),
      commit: (finished: ChartDrag) => {
        if (finished.kind !== "lift") return;
        swallowNextClick();
        latest.current.onLift(Object.fromEntries(bases.map((base) => [base.key, base.top - base.laneTop + finished.dy])));
      },
    };
  };

  /**
   * Carry a card to a drop zone — or, when it sits on a lane and Shift is held
   * as the drag starts (at the press or once the pointer is moving), lift it
   * up or down instead, which moves nothing in time and writes nothing.
   */
  const onCardPointerDown = (card: PromptChartCard, liftKeys?: string[]) => (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as Element).closest(NO_DRAG)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const lift = liftKeys ? liftGesture(event, liftKeys) : null;
    const pressShift = event.shiftKey;
    const zoneAt = (pointer: PointerEvent): TimelineZone => {
      const { win, now, measure, resets, agentOf } = latest.current;
      const measured = measure();
      const zone = timelineHitZone({ x: pointer.clientX, y: pointer.clientY }, measured.rects, win, measured.width, measured.scrollLeft, now);
      if (zone.kind !== "time" || !resets?.length) return zone;
      const snapped = snapToReset(zone.at, resets, agentOf?.(card), win, measured.width, now);
      return snapped ? { kind: "time", at: snapped.at, reset: snapped.reset } : zone;
    };
    start(event, {
      begin: (pointer) => (lift && (pressShift || pointer.shiftKey) ? lift.begin(pointer) : {
        kind: "card",
        card,
        x: pointer.clientX,
        y: pointer.clientY,
        grabDx: event.clientX - rect.left,
        grabDy: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        zone: zoneAt(pointer),
      }),
      move: (current, pointer) => (current.kind === "lift" && lift
        ? lift.move(current, pointer)
        : { ...current, x: pointer.clientX, y: pointer.clientY, zone: zoneAt(pointer) } as ChartDrag),
      commit: (finished) => {
        if (finished.kind === "lift") { lift?.commit(finished); return; }
        if (finished.kind !== "card" || finished.zone.kind === "none") return;
        swallowNextClick();
        // Never write from the snapshot taken at the press: a one-time rule the
        // scheduler retired mid-drag would be re-created and sent twice.
        const { cards, onStale, onDropCard } = latest.current;
        const fresh = cards ? cards.find((item) => item.key === finished.card.key) : finished.card;
        if (!fresh || fresh.state !== finished.card.state || fresh.schedule?.id !== finished.card.schedule?.id) {
          onStale?.();
          return;
        }
        onDropCard(fresh, finished.zone, { ...finished, card: fresh });
      },
    });
  };

  /** A lane card that only lifts: always (`shiftOnly` false, a sent card), or
   *  only with Shift held at the press (a recurring rule, which never carries). */
  const onLiftPointerDown = (keys: string[], shiftOnly = false) => (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as Element).closest(NO_DRAG)) return;
    if (shiftOnly && !event.shiftKey) return;
    const gesture = liftGesture(event, keys);
    if (gesture) start(event, gesture);
  };

  /** A rubber band over the empty lanes; a plain click there reports no keys. */
  const onMarqueePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const additive = event.ctrlKey || event.metaKey;
    const x1 = event.clientX;
    const y1 = event.clientY;
    let items: ChartCardRect[] = [];
    start(event, {
      begin: (pointer) => {
        items = latest.current.measureItems?.() ?? [];
        return { kind: "marquee", x1, y1, x: pointer.clientX, y: pointer.clientY };
      },
      move: (current, pointer) => (current.kind === "marquee" ? { ...current, x: pointer.clientX, y: pointer.clientY } : current),
      commit: (finished) => {
        if (finished.kind !== "marquee") return;
        const left = Math.min(finished.x1, finished.x);
        const right = Math.max(finished.x1, finished.x);
        const top = Math.min(finished.y1, finished.y);
        const bottom = Math.max(finished.y1, finished.y);
        const hit = items.filter(({ rect }) =>
          rect.left <= right && rect.left + rect.width >= left && rect.top <= bottom && rect.top + rect.height >= top);
        latest.current.onMarquee?.(hit.map((item) => item.id), additive);
      },
      click: () => latest.current.onMarquee?.([], additive),
    });
  };

  const onPortPointerDown = (card: PromptChartCard) => (event: ReactPointerEvent<HTMLElement>) => {
    // The port sits inside the card, whose own pointerdown would start a carry.
    event.stopPropagation();
    const port = event.currentTarget.getBoundingClientRect();
    let cards: ChartCardRect[] = [];
    const over = (pointer: PointerEvent): string | null =>
      cards.find(({ id, rect }) =>
        id !== card.id
        && pointer.clientX >= rect.left && pointer.clientX <= rect.left + rect.width
        && pointer.clientY >= rect.top && pointer.clientY <= rect.top + rect.height)?.id ?? null;
    start(event, {
      begin: (pointer) => {
        cards = latest.current.measureCards();
        return {
          kind: "link",
          from: card,
          x1: port.left + port.width / 2,
          y1: port.top + port.height / 2,
          x: pointer.clientX,
          y: pointer.clientY,
          overId: over(pointer),
        };
      },
      move: (current, pointer) => ({ ...current, x: pointer.clientX, y: pointer.clientY, overId: over(pointer) }),
      commit: (finished) => {
        if (finished.kind !== "link" || !finished.overId) return;
        latest.current.onDropLink(finished.from, finished.overId);
      },
    });
  };

  return { drag, onCardPointerDown, onLiftPointerDown, onMarqueePointerDown, onPortPointerDown };
}
