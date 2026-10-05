/**
 * The todo board's **session** state — and nothing that is written to disk.
 *
 * `useCalendarStore` stays the only owner of task persistence: the cards *are*
 * `calendar.json`'s tasks, so a second store that also wrote them would be two
 * writers for one file. What lives here is what a board needs and a calendar does
 * not — whether the overlay is up, the filters, the in-flight card drag, the
 * optimistic placement overlay, and the urgent-mail rail's cache.
 *
 * Three deliberate choices worth keeping:
 *
 * **The filters are not persisted.** A filter that survives a relaunch is how a
 * user loses cards: the board opens showing three of forty and nothing on screen
 * says why.
 *
 * **The drag lives here, not in `stores/drag/drag`.** That store's `drag !== null` is
 * read by `CenterPanel`, `DetachedCenterPanel`, `FileTree` and
 * `dragPreviewLayout` as "a tab or file drag is in flight" — populating it for a
 * card drag would put the whole center panel into drag mode (panes
 * `pointer-events: none`) behind a modal, and make a popout broadcast reorder
 * targets for a gesture that has nothing to do with tabs.
 *
 * **The mail rail reads mail without touching the mail store.**
 * `useMailStore.openPriority` sets `selectedPriority` and replaces `headers` —
 * i.e. it retargets the mail overlay's list — so a rail that used it would move
 * the user's mailbox under them every 60 seconds. It calls `mailPriorityPage`
 * directly instead and keeps its own copy.
 */

import { create } from "zustand";

import type { MailHeader, MailPriority } from "../types/mail";
import { mailPriorityPage } from "../lib/mail";
import { useMailStore } from "./mail";
import { storageKey } from "../lib/brand";

/**
 * A card drag in flight. Positions are viewport coordinates.
 *
 * `overIndex` — and `fromIndex` with it — is an **exclusive-of-the-dragged-card**
 * index: the slot in the target column counted with this card already taken out
 * of it. That is the space `insertionIndex` measures in (it is fed the *other*
 * cards' rects), the space `commitMove` bisects ranks in, and the space the
 * backend's `TaskPlacement.index` is defined in. The board renders the
 * placeholder into a list the dragged card has been removed from for exactly
 * this reason: the one index space that reaches the backend is also the one the
 * preview is drawn in, so what is shown and what is written cannot disagree.
 */
export interface CardDrag {
  taskId: string;
  fromColumn: string;
  /**
   * The slot the card occupied at pickup. The drag *opens* on it, so the
   * placeholder takes the card's own place in the same frame it is lifted out of
   * it — nothing jumps — and a drop back onto it is recognizable as the no-op it
   * is, instead of a write that reindexes the column around an unchanged card.
   */
  fromIndex: number;
  title: string;
  /** Measured at pickup — sizes both the ghost and the drop placeholder. */
  width: number;
  height: number;
  /** Where inside the card the pointer grabbed it. */
  grabDx: number;
  grabDy: number;
  pointerX: number;
  pointerY: number;
  overColumn: string | null;
  overIndex: number | null;
}

/** How many marked messages the rail asks for. A rail, not a second mailbox. */
const RAIL_PAGE = 25;

const COLLAPSED_COLUMNS_KEY = storageKey("todo.collapsedColumns");

function readCollapsedColumns(): Record<string, true> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_COLUMNS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return {};
    const out: Record<string, true> = {};
    for (const id of parsed) if (typeof id === "string") out[id] = true;
    return out;
  } catch {
    return {};
  }
}

function writeCollapsedColumns(columns: Record<string, true>) {
  try {
    localStorage.setItem(COLLAPSED_COLUMNS_KEY, JSON.stringify(Object.keys(columns)));
  } catch {
    // localStorage unavailable — the fold still holds for this session.
  }
}

interface TodoStore {
  overlayOpen: boolean;
  openOverlay: () => void;
  closeOverlay: () => void;

  /**
   * A card the board should open its editor on as soon as it is mounted — the
   * header's urgent list clicking through to the card it named.
   *
   * A one-shot *request*, not a selection: `TodoPane` consumes it and clears it,
   * so re-opening the board later does not re-raise a dialog the user closed. It
   * lives here rather than being a parameter of `openOverlay` because the pane
   * mounts a frame after the flag flips — there is nobody to hand it to yet.
   */
  focusTaskId: string | null;
  openCard: (taskId: string) => void;
  clearFocusTask: () => void;

  search: string;
  projectFilter: string | null | "none";
  tagFilter: string | null;
  hideDone: boolean;
  setSearch: (value: string) => void;
  setProjectFilter: (value: string | null | "none") => void;
  setTagFilter: (value: string | null) => void;
  setHideDone: (value: boolean) => void;
  clearFilters: () => void;

  cardDrag: CardDrag | null;
  startCardDrag: (drag: CardDrag) => void;
  moveCardDrag: (x: number, y: number) => void;
  setCardTarget: (column: string | null, index: number | null) => void;
  endCardDrag: () => void;

  /**
   * Cards whose checklist the user has **folded away**, by id.
   *
   * The default is now the other way round — a card with steps shows them — so
   * what has to be remembered is the exception, not the rule. An id in here is a
   * decision the user made; a card absent from it is simply a card, which is why
   * this is a set of collapses rather than a per-card open flag (that spelling
   * would have to be seeded for every existing card, and a card gaining its first
   * step would default to hidden).
   *
   * It lives in the store rather than in `TodoCard`'s own state because the card
   * unmounts every time the overlay closes, and a fold that undid itself the next
   * time the board opened is not a control, it is a flicker. It is still session
   * state and deliberately reaches no disk: the board is read at a glance, and a
   * checklist silently hidden by a decision made weeks ago is the same trap the
   * filters are not persisted for.
   */
  collapsedSteps: Record<string, true>;
  toggleSteps: (taskId: string, collapsed: boolean) => void;

  /**
   * Columns folded down to a narrow strip, by column id.
   *
   * Unlike a card's checklist this one **is** persisted (per machine, in
   * localStorage): a folded column still shows its name and count, so nothing is
   * hidden without saying so, and a Done column that unfolded itself every
   * launch would be a chore rather than a layout.
   */
  collapsedColumns: Record<string, true>;
  toggleColumn: (columnId: string, collapsed: boolean) => void;

  /** Optimistic placements, keyed by task id — the anti-snap-back overlay. */
  pendingOrder: Record<string, { column: string; rank: number }>;
  stageMove: (taskId: string, column: string, rank: number) => void;
  settleMove: (taskId: string) => void;

  urgentMail: MailHeader[];
  importantMail: MailHeader[];
  urgentLoading: boolean;
  urgentError: string | null;
  /** Read both priority pages. A **local index read** — never a socket. */
  loadUrgentMail: () => Promise<void>;
  clearUrgentMail: () => void;

  error: string | null;
  setError: (message: string | null) => void;
}

export const useTodoStore = create<TodoStore>((set, get) => ({
  overlayOpen: false,
  openOverlay: () => set({ overlayOpen: true }),
  closeOverlay: () =>
    // Drop any in-flight drag with the surface it was happening on: the
    // pointerdown-bound release handler survives the unmount and would otherwise
    // commit a move onto a board nobody is looking at.
    set({ overlayOpen: false, cardDrag: null, focusTaskId: null }),

  focusTaskId: null,
  openCard: (focusTaskId) => set({ overlayOpen: true, focusTaskId }),
  clearFocusTask: () => set({ focusTaskId: null }),

  search: "",
  projectFilter: null,
  tagFilter: null,
  hideDone: false,
  setSearch: (search) => set({ search }),
  setProjectFilter: (projectFilter) => set({ projectFilter }),
  setTagFilter: (tagFilter) => set({ tagFilter }),
  setHideDone: (hideDone) => set({ hideDone }),
  clearFilters: () =>
    set({ search: "", projectFilter: null, tagFilter: null, hideDone: false }),

  collapsedSteps: {},
  toggleSteps: (taskId, collapsed) =>
    set((s) => {
      const next = { ...s.collapsedSteps };
      if (collapsed) next[taskId] = true;
      else delete next[taskId];
      return { collapsedSteps: next };
    }),

  collapsedColumns: readCollapsedColumns(),
  toggleColumn: (columnId, collapsed) =>
    set((s) => {
      const next = { ...s.collapsedColumns };
      if (collapsed) next[columnId] = true;
      else delete next[columnId];
      writeCollapsedColumns(next);
      return { collapsedColumns: next };
    }),

  cardDrag: null,
  startCardDrag: (cardDrag) => set({ cardDrag }),
  moveCardDrag: (x, y) =>
    set((s) => (s.cardDrag ? { cardDrag: { ...s.cardDrag, pointerX: x, pointerY: y } } : s)),
  setCardTarget: (column, index) =>
    set((s) =>
      s.cardDrag ? { cardDrag: { ...s.cardDrag, overColumn: column, overIndex: index } } : s,
    ),
  endCardDrag: () => set({ cardDrag: null }),

  pendingOrder: {},
  stageMove: (taskId, column, rank) =>
    set((s) => ({ pendingOrder: { ...s.pendingOrder, [taskId]: { column, rank } } })),
  settleMove: (taskId) =>
    set((s) => {
      if (!(taskId in s.pendingOrder)) return s;
      const next = { ...s.pendingOrder };
      delete next[taskId];
      return { pendingOrder: next };
    }),

  urgentMail: [],
  importantMail: [],
  urgentLoading: false,
  urgentError: null,

  loadUrgentMail: async () => {
    if (get().urgentLoading) return;
    set({ urgentLoading: true });
    const page = async (priority: MailPriority) => {
      const result = await mailPriorityPage(priority, 0, RAIL_PAGE, null).catch(
        (err) => {
          // A rail states a failure quietly; it is not the mail client's error
          // strip, and a red banner in a todo board for a mailbox nobody asked
          // about here would be noise.
          set({ urgentError: String(err) });
          return null;
        },
      );
      return result?.items ?? [];
    };
    set({ urgentError: null });
    const [urgent, important] = await Promise.all([page("urgent"), page("important")]);
    set({ urgentMail: urgent, importantMail: important, urgentLoading: false });
  },

  clearUrgentMail: () =>
    set({ urgentMail: [], importantMail: [], urgentError: null }),

  error: null,
  setError: (error) => set({ error }),
}));

// ── The shared urgent-mail poll ──────────────────────────────────────────────
//
// The 60 s re-read behind `urgentMail`/`importantMail`, refcounted at module
// level — `stores/remote/hostSessions`' retain/release pattern. It exists because the
// consumers are mounted many times at once (`useAlertsFeed` rides the file
// viewer, which renders in the side panel plus every Files tab, and
// `TodoMailRail` is a third copy): each used to arm its own interval keyed on
// `newCount`, so one mail delivery re-armed N timers and a side panel plus a
// few Files tabs cost N identical local queries per minute, forever. One poll
// serves them all; the shared `useTodoStore` rows they already read from are
// the shared answer.
//
// Callers own the gate: `loadUrgentMail` reaches `mail_priority_page`, and
// opening the mail store's backend creates `~/.local/share/tabtivity/mail/` as a
// side effect — so retain ONLY behind the `mail_client` check (plus whatever
// surface gate applies), exactly where the per-instance intervals sat.

/** The rails'/alerts' shared cadence. Defensible only because
 *  `mail_priority_page` is a read of the **local** SQLite index and opens no
 *  socket; if that ever stops being true, this timer is the thing to go. */
const URGENT_MAIL_TICK_MS = 60_000;

let urgentMailRefs = 0;
let urgentMailInterval: ReturnType<typeof setInterval> | null = null;
let urgentMailUnsub: (() => void) | null = null;

/** Join (or start) the shared poll. Pair with {@link releaseUrgentMailPoll}. */
export function retainUrgentMailPoll(): void {
  urgentMailRefs += 1;
  if (urgentMailRefs > 1) return; // another surface already drives the poll
  void useTodoStore.getState().loadUrgentMail();
  urgentMailInterval = setInterval(
    () => void useTodoStore.getState().loadUrgentMail(),
    URGENT_MAIL_TICK_MS,
  );
  // `newCount` is the arrival signal (the `mail:new` listener itself belongs to
  // `MailIndicator`, mounted once per window). Re-reading on it lives HERE, once,
  // rather than in each consumer's effect deps, where a delivery re-fired the
  // query once per mounted surface.
  let lastNewCount = useMailStore.getState().newCount;
  urgentMailUnsub = useMailStore.subscribe((s) => {
    if (s.newCount === lastNewCount) return;
    lastNewCount = s.newCount;
    void useTodoStore.getState().loadUrgentMail();
  });
}

/** Drop one subscriber; the poll stops when the last one leaves. The last
 *  reading is deliberately kept (`hostSessions`' rule): an emptied rail would
 *  read as "nothing urgent", which is a different and possibly wrong claim. */
export function releaseUrgentMailPoll(): void {
  urgentMailRefs = Math.max(0, urgentMailRefs - 1);
  if (urgentMailRefs > 0) return;
  if (urgentMailInterval !== null) {
    clearInterval(urgentMailInterval);
    urgentMailInterval = null;
  }
  urgentMailUnsub?.();
  urgentMailUnsub = null;
}
