import { useEffect, useMemo, useRef } from "react";

import type { CalendarTask, TaskColumn } from "../../types";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useTodoStore } from "../../stores/todo";
import { bindDragRelease, dragPlatform } from "../../lib/window/dragPlatform";
import { toStamp, todayStr } from "../../lib/calendar/calendarTime";
import {
  autoscrollDelta,
  bucketByColumn,
  columnOf,
  columnTitle,
  currentSlot,
  doneColumnId,
  dropAccepted,
  fallbackColumnId,
  insertionIndex,
  orderedColumn,
  provisionalRank,
} from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";
import { TodoColumn } from "./TodoColumn";
import { useDialogs } from "../common/PromptDialogs";

interface Props {
  columns: TaskColumn[];
  /** Already filtered and already carrying the optimistic overlay. */
  tasks: CalendarTask[];
  /** The matching cards before the optional "Hide done" display filter. */
  countTasks: CalendarTask[];
  defaultCalendarId: string;
  /** The project a new card inherits, or null. */
  inheritProjectId: string | null;
  onEditCard: (task: CalendarTask) => void;
  onOpenMail: (task: CalendarTask) => void;
}

/** How far the pointer must travel before a click becomes a drag. */
const DRAG_THRESHOLD = 5;

/** The bare card `addCard` asks the routing about before it composes one. */
const DRAFT_SHAPE: CalendarTask = {
  id: "",
  calendar_id: "",
  title: "",
  priority: 0,
  percent: 0,
};

/**
 * The board, and the owner of the card-drag gesture.
 *
 * **The commit is bound at pointerdown**, synchronously, before any state change
 * or re-render. That is not a style choice: under WebKitGTK, listeners added
 * *mid-gesture* receive `pointermove` but never the terminal `pointerup`
 * (`TabBar` documents the same trap at its own drag), so an effect keyed on "a
 * drag is in flight" can drive the preview and must never be the committer.
 *
 * Pointer capture goes on `documentElement`, never on the dragged card: the card
 * unmounts mid-gesture as the placeholder re-renders or it crosses a column, and
 * removing a capture *target* drops the capture — which on WebView2 fires a
 * spurious `pointercancel`, i.e. (since `cancelCommits` is true there) a commit
 * at the wrong moment.
 *
 * And because `pointercancel` **commits** on Linux — WebKitGTK fires it instead
 * of `pointerup` when its selection heuristic claims the stream — the commit has
 * to be safe under a target the user never really chose. With no column under the
 * pointer it does nothing and the card stays where it was; "no target" is never
 * mapped to a default column, and never to a delete.
 *
 * **One index space, from the hit-test to the backend.** Every index in this
 * gesture is counted with the dragged card taken *out* of its column
 * (`CardDrag.overIndex`) — that is what `insertionIndex` measures, what
 * `commitMove` bisects ranks in, and what `TaskPlacement.index` means on the
 * wire. The preview therefore has to be drawn in that space too, so `TodoColumn`
 * renders the dragged card out of its list rather than leaving it in place,
 * faded: with it left in, the placeholder landed one slot high for every drop
 * below the card's own position, which reads as the board offering the card's
 * *current* place as the new one. The card is not simply hidden late either —
 * the drag **opens** with the target set to the slot it was lifted from
 * (`fromIndex`), so the placeholder replaces it in the same frame and the column
 * never changes height at pickup.
 */
export function TodoBoard({
  columns,
  tasks,
  countTasks,
  defaultCalendarId,
  inheritProjectId,
  onEditCard,
  onOpenMail,
}: Props) {
  const t = useT();
  const { promptText, confirmAction, dialogs } = useDialogs();
  const storedColumns = useCalendarStore((s) => s.taskColumns);
  const cardDrag = useTodoStore((s) => s.cardDrag);
  const boardRef = useRef<HTMLDivElement>(null);
  /** Latest pointer position, read by the autoscroll loop without re-rendering. */
  const pointerRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  const today = todayStr();
  const buckets = useMemo(
    () => bucketByColumn(tasks, columns, today),
    [tasks, columns, today],
  );
  const countBuckets = useMemo(
    () => bucketByColumn(countTasks, columns, today),
    [countTasks, columns, today],
  );

  // ── Drag ────────────────────────────────────────────────────────────────

  /** Hit-test the pointer against the columns and update the drop target. */
  const retarget = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    const columnEl = el?.closest<HTMLElement>(".todo-column");
    const columnId = columnEl?.dataset.columnId ?? null;
    if (!columnId) {
      useTodoStore.getState().setCardTarget(null, null);
      return;
    }
    const drag = useTodoStore.getState().cardDrag;
    const rects = Array.from(
      columnEl!.querySelectorAll<HTMLElement>(".todo-card"),
    )
      // The measured slots are the OTHER cards' — that is what makes the result
      // an exclusive-of-the-dragged-card index. The source column no longer
      // renders it at all, so this filter only still matters for the first move
      // of a gesture, which is hit-tested against the DOM of the frame before
      // the drag started.
      .filter((node) => node.dataset.taskId !== drag?.taskId)
      .map((node) => {
        const r = node.getBoundingClientRect();
        return { top: r.top, height: r.height };
      });
    useTodoStore.getState().setCardTarget(columnId, insertionIndex(rects, y));
  };

  const startAutoscroll = () => {
    if (rafRef.current !== null) return;
    const tick = () => {
      const { x, y } = pointerRef.current;
      const board = boardRef.current;
      if (board) {
        const r = board.getBoundingClientRect();
        const dx = autoscrollDelta(r.left, r.right, x);
        if (dx) board.scrollLeft += dx;
        const columnEl = document
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>(".todo-column")
          ?.querySelector<HTMLElement>(".todo-column-body");
        let dy = 0;
        if (columnEl) {
          const cr = columnEl.getBoundingClientRect();
          dy = autoscrollDelta(cr.top, cr.bottom, y);
          if (dy) columnEl.scrollTop += dy;
        }
        // Re-hit-test after scrolling, or the placeholder lags behind the cards
        // the scroll just revealed.
        if (dx || dy) retarget(x, y);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const stopAutoscroll = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  useEffect(() => stopAutoscroll, []);

  const commitMove = async (task: CalendarTask, columnId: string, index: number) => {
    const todo = useTodoStore.getState();
    const siblings = orderedColumn(buckets.get(columnId) ?? [], today).filter(
      (t) => t.id !== task.id,
    );
    const before = index > 0 ? (siblings[index - 1]?.rank ?? null) : null;
    const after = siblings[index]?.rank ?? null;

    // Optimistic, in the same tick as the pointerup: the card is in its new slot
    // on the very next paint, so the write-through never shows as a snap-back.
    // The rank here is display-only — `todo_move_tasks` recomputes it from the
    // index, which is what keeps a replayed placement a no-op.
    todo.stageMove(task.id, columnId, provisionalRank(before, after));
    try {
      await useCalendarStore.getState().moveTasks([
        {
          id: task.id,
          column: columnId,
          index,
          // The frontend owns the clock: the backend has no local-time source,
          // so a move that completes a card is stamped from here.
          completed_stamp: toStamp(new Date()),
        },
      ]);
    } catch (err) {
      todo.setError(String(err));
    } finally {
      // Dropped only after the store has the backend's answer, so the card does
      // not move a pixel between the two.
      todo.settleMove(task.id);
    }
  };

  const onCardPointerDown = (
    e: React.PointerEvent,
    task: CalendarTask,
    el: HTMLElement,
  ) => {
    if (e.button !== 0) return;
    // Suppress WebKitGTK's native selection gesture, which otherwise hijacks the
    // pointer stream and ends it with a cancel mid-drag.
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const rect = el.getBoundingClientRect();
    const captureEl = document.documentElement;
    let dragging = false;

    // Where the card is being lifted *from*, in the one index space this
    // gesture counts in. Read from the same buckets the columns render, so the
    // opening placeholder lands exactly on the card it replaces.
    const fromColumn = columnOf(task, columns);
    const fromIndex = currentSlot(buckets.get(fromColumn) ?? [], task.id);

    const onMove = (ev: PointerEvent) => {
      pointerRef.current = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        if (dragPlatform.needsPointerCapture) {
          try {
            captureEl.setPointerCapture(pointerId);
          } catch {
            /* capture is an optimization; the gesture works without it */
          }
        }
        useTodoStore.getState().startCardDrag({
          taskId: task.id,
          fromColumn,
          fromIndex,
          title: task.title,
          width: rect.width,
          height: rect.height,
          grabDx: startX - rect.left,
          grabDy: startY - rect.top,
          pointerX: ev.clientX,
          pointerY: ev.clientY,
          // Opens on the card's own slot: the placeholder takes its place in the
          // frame it leaves the column, so nothing below it moves at pickup.
          overColumn: fromColumn,
          overIndex: fromIndex,
        });
        startAutoscroll();
      }
      useTodoStore.getState().moveCardDrag(ev.clientX, ev.clientY);
      retarget(ev.clientX, ev.clientY);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      stopAutoscroll();
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
      const drag = useTodoStore.getState().cardDrag;
      if (!drag) return; // never crossed the threshold, or already ended
      useTodoStore.getState().endCardDrag();
      // No target — including every `pointercancel` WebKitGTK turned into a
      // commit — leaves the card exactly where it was.
      if (!drag.overColumn || drag.overIndex === null) return;
      // Nor is putting a card back where it was picked up a move. The backend
      // recognizes the replay and holds the rank, but the write still rewrites
      // `calendar.json` and pushes a store update through every open surface,
      // and a drag abandoned by dropping the card on its own slot is the common
      // way this gesture ends. Skipped only for a card that HAS a placement:
      // an unranked one — everything the calendar's Tasks view and ICS import
      // create — is merely *displayed* in that slot, and the drop is what gives
      // it a real one.
      const settled =
        drag.overColumn === drag.fromColumn &&
        drag.overIndex === drag.fromIndex &&
        task.rank != null &&
        task.column === drag.fromColumn;
      if (settled) return;
      // A drop the deadline would immediately undo is not a move — the write
      // would land and the next render would put the card straight back, which
      // reads as a broken drag rather than as "that column is the date's to
      // decide". The ghost has been saying so for the whole gesture.
      if (!dropAccepted(task, drag.overColumn, columns, today)) return;
      void commitMove(task, drag.overColumn, drag.overIndex);
    };

    const onAbort = () => {
      cleanup();
      useTodoStore.getState().endCardDrag();
    };

    window.addEventListener("pointermove", onMove);
    // Synchronously, before any render: see the component doc.
    bindDragRelease({ onCommit, onAbort });
  };

  // ── Column edits ────────────────────────────────────────────────────────

  /**
   * Open the full card editor on a *draft* — an unsaved card carrying only what
   * the column already decides (its placement, the calendar, the filtered
   * project). Nothing is written here: the dialog creates the row on Save, which
   * is what makes Cancel free. The empty `id` is the marker for "not yet in the
   * store", and it is the same one `createTask` sends over the wire.
   */
  const addCard = (columnId: string) => {
    const column = buckets.get(columnId) ?? [];
    const top = orderedColumn(column, today)[0]?.rank ?? null;
    // Dated today (below) — so a draft composed under Overdue would be filed in
    // a column its own deadline contradicts. It is shown in Today either way;
    // this is only so the *record* says something true.
    const filed = dropAccepted({ ...DRAFT_SHAPE, due: today }, columnId, columns, today)
      ? columnId
      : fallbackColumnId(columns);
    onEditCard({
      id: "",
      calendar_id: defaultCalendarId,
      title: "",
      // Dated **today** by default. The board is a what-am-I-doing-now surface,
      // so today is the overwhelmingly common answer — and an undated card is
      // the one that appears in none of the surfaces built to surface work:
      // not the header badge, not its Overdue/Due-today sections, not the
      // alerts feed. It is a default, not a rule: this draft opens straight
      // into the dialog with the date field on it, so clearing it is one click
      // *before* anything is written. Deliberately not applied to the rails'
      // conversions — `taskFromMail` stays undated (a mail arriving is not a
      // thing due today) and `taskFromOccurrence` already carries the
      // appointment's own date.
      due: today,
      priority: 0,
      percent: 0,
      column: filed,
      rank: provisionalRank(null, top),
      created: toStamp(new Date()),
      // A card created under a project filter inherits it — otherwise it
      // vanishes the instant it is created, which reads as a broken button.
      ...(inheritProjectId ? { project_id: inheritProjectId } : {}),
    });
  };

  const setColumns = (next: TaskColumn[], fallback?: string | null) =>
    useCalendarStore
      .getState()
      .setColumns(next, fallback ?? null)
      .catch((err) => useTodoStore.getState().setError(String(err)));

  const renameColumn = (columnId: string, name: string) =>
    void setColumns(columns.map((c) => (c.id === columnId ? { ...c, name } : c)));

  // The column list as of the latest render, for the writes that follow a
  // question: the board can change under an open dialog (an agent's to-do tool,
  // another window), and writing the list captured before it would undo that.
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const deleteColumn = async (column: TaskColumn, count: number) => {
    if (columns.length <= 1) return;
    const ok = await confirmAction({
      title: t("todoBoard.deleteColumn"),
      body: t("todoBoard.deleteColumnConfirm", { name: column.name, count }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    const current = columnsRef.current;
    if (!ok || current.length <= 1) return;
    void setColumns(current.filter((c) => c.id !== column.id));
  };

  const moveColumn = (columnId: string, delta: -1 | 1) => {
    const index = columns.findIndex((c) => c.id === columnId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= columns.length) return;
    const next = [...columns];
    [next[index], next[target]] = [next[target], next[index]];
    void setColumns(next.map((c, i) => ({ ...c, position: i })));
  };

  const addColumn = async () => {
    const name = await promptText({
      title: t("todoBoard.addColumn"),
      label: t("todoBoard.columnNamePlaceholder"),
      confirmLabel: t("common.add"),
    });
    if (!name) return;
    const current = columnsRef.current;
    void setColumns([
      ...current,
      {
        id: "",
        name,
        position: current.length,
        done: false,
      },
      // The backend mints the id for an entry that carries none.
    ].map((c, i) => ({ ...c, position: i })));
  };

  // The done column keeps its place at the right; nothing enforces that, it is
  // simply where `position` puts it.
  const doneId = doneColumnId(columns);

  // What the ghost says about the drop, and the whole reason it says anything:
  // the pointer is over a *column*, but the card's landing slot is drawn inside
  // that column's body, which for a drop near the bottom of a long board is
  // scrolled somewhere off screen. The ghost is the one thing guaranteed to be
  // under the eye, so it carries the answer — the target column's name when the
  // card is crossing into another one, and the fact that releasing here does
  // nothing when the pointer has left the columns entirely.
  const overColumn = cardDrag?.overColumn
    ? (columns.find((c) => c.id === cardDrag.overColumn) ?? null)
    : null;
  const dragged = cardDrag ? tasks.find((t) => t.id === cardDrag.taskId) : null;
  // Refused for the same reason `onCommit` refuses it: the card's deadline, not
  // the pointer, decides between Overdue, Today and the backlog.
  const refused =
    !!cardDrag &&
    !!dragged &&
    !!cardDrag.overColumn &&
    !dropAccepted(dragged, cardDrag.overColumn, columns, today);
  const crossingTo =
    cardDrag && overColumn && overColumn.id !== cardDrag.fromColumn && !refused
      ? columnTitle(overColumn, t, storedColumns)
      : null;
  const noDrop =
    !!cardDrag && (!cardDrag.overColumn || cardDrag.overIndex === null || refused);

  return (
    <div
      className={"todo-board" + (cardDrag ? " dragging" : "")}
      ref={boardRef}
    >
      {columns.map((column, i) => (
        <TodoColumn
          key={column.id}
          column={column}
          columns={columns}
          title={columnTitle(column, t, storedColumns)}
          cards={buckets.get(column.id) ?? []}
          cardCount={countBuckets.get(column.id)?.length ?? 0}
          placeholderIndex={
            cardDrag?.overColumn === column.id && !refused ? cardDrag.overIndex : null
          }
          placeholderHeight={cardDrag?.height ?? 0}
          dropTarget={cardDrag?.overColumn === column.id && !refused}
          draggingId={cardDrag?.taskId ?? null}
          onCardPointerDown={onCardPointerDown}
          onEditCard={onEditCard}
          onOpenMail={onOpenMail}
          onAddCard={addCard}
          onRename={renameColumn}
          onDelete={(col, count) => void deleteColumn(col, count)}
          onMove={moveColumn}
          canMoveLeft={i > 0}
          canMoveRight={i < columns.length - 1 && column.id !== doneId}
        />
      ))}

      <div className="todo-column todo-column-add">
        <button type="button" className="todo-add-column" onClick={() => void addColumn()}>
          + {t("todoBoard.addColumn")}
        </button>
      </div>

      {cardDrag && (
        /* `position: fixed` + left/top, the shape `.tab-drag-ghost` already
           proved fast under WebKitGTK — and `pointer-events: none`, or the ghost
           becomes `elementFromPoint`'s answer and the drop targets itself. */
        <div
          className={"todo-drag-ghost" + (noDrop ? " todo-drag-ghost-nodrop" : "")}
          style={{
            left: cardDrag.pointerX - cardDrag.grabDx,
            top: cardDrag.pointerY - cardDrag.grabDy,
            width: cardDrag.width,
          }}
        >
          <span className="todo-drag-ghost-title">{cardDrag.title}</span>
          {crossingTo && (
            /* Glyph + the column's own name, never a translated sentence: the
               one word here is data the user typed. */
            <span className="todo-drag-ghost-to">→ {crossingTo}</span>
          )}
          {noDrop && (
            <span className="todo-drag-ghost-to">
              {t(refused ? "todoBoard.dropDateDecides" : "todoBoard.dropNowhere")}
            </span>
          )}
        </div>
      )}
      {dialogs}
    </div>
  );
}
