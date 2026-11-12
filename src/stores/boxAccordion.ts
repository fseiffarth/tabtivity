import { create } from "zustand";
import { storageKey } from "../lib/brand";
import { cappedMap, readJson, writeJson } from "../lib/persist";

/**
 * The box side panel's accordion, remembered **per box**, across scope
 * switches and relaunches: which member section is expanded, whether the box
 * folder's own section is folded, and which view (Files / Git) each member
 * shows.
 *
 * Per-viewer convenience, not data: it lives in localStorage like
 * `texViewPref` / `fileSourcePref` (never a JSON file, nothing to round-trip),
 * every read and write is wrapped (`lib/persist`), and the panel renders right
 * without it. Keyed by box id; a dissolved box leaves a small stale row that
 * the cap eventually drops.
 *
 * `open` has three states on purpose: `undefined` = the user never chose (the
 * panel follows the active tab's member, else the first), `null` = every member
 * section folded by a click, an id = that member is expanded.
 */
export type BoxMemberView = "files" | "git";

export interface BoxAccordionRow {
  /** The expanded member: see above for `undefined` / `null`. */
  open?: string | null;
  /** The box folder's own section is folded. */
  boxFolded?: boolean;
  /** Per member: the view it shows when expanded (absent = Files). */
  views?: Record<string, BoxMemberView>;
}

const STORAGE_KEY = storageKey("boxAccordion");

/** Bound on the persisted map: a box the user never opens again must not keep
 *  a row forever. Oldest insertions are dropped first. */
const MAX_PERSISTED = 100;

function parseRow(v: unknown): BoxAccordionRow | null {
  if (!v || typeof v !== "object") return null;
  const { open, boxFolded, views } = v as Record<string, unknown>;
  const row: BoxAccordionRow = {};
  if (typeof open === "string" || open === null) row.open = open;
  if (typeof boxFolded === "boolean") row.boxFolded = boxFolded;
  if (views && typeof views === "object") {
    const out: Record<string, BoxMemberView> = {};
    for (const [id, view] of Object.entries(views as Record<string, unknown>)) {
      if (view === "files" || view === "git") out[id] = view;
    }
    if (Object.keys(out).length) row.views = out;
  }
  return Object.keys(row).length ? row : null;
}

function readPersisted(): Record<string, BoxAccordionRow> {
  return readJson(
    STORAGE_KEY,
    (parsed) => {
      const out: Record<string, BoxAccordionRow> = {};
      if (!parsed || typeof parsed !== "object") return out;
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const row = parseRow(v);
        if (row) out[k] = row;
      }
      return out;
    },
    {},
  );
}

/** Merge one box's row into the persisted map. Re-reads first, so two windows
 *  (main + a popout share one origin, hence one localStorage) cannot clobber
 *  each other's rows with a stale snapshot. Without localStorage the choice
 *  still holds for this session. */
function persistRow(boxId: string, row: BoxAccordionRow) {
  const stored = readPersisted();
  delete stored[boxId]; // re-insert last, so the cap drops the oldest
  stored[boxId] = row;
  writeJson(STORAGE_KEY, cappedMap(stored, MAX_PERSISTED));
}

interface BoxAccordionStore {
  byBox: Record<string, BoxAccordionRow>;
  /** Expand a member (an id), or fold them all (`null`). */
  setOpen: (boxId: string, open: string | null) => void;
  setBoxFolded: (boxId: string, folded: boolean) => void;
  setView: (boxId: string, memberId: string, view: BoxMemberView) => void;
}

export const useBoxAccordionStore = create<BoxAccordionStore>((set) => {
  const patch = (boxId: string, change: (row: BoxAccordionRow) => BoxAccordionRow) =>
    set((s) => {
      const row = change(s.byBox[boxId] ?? {});
      persistRow(boxId, row);
      return { byBox: { ...s.byBox, [boxId]: row } };
    });
  return {
    byBox: readPersisted(),
    setOpen: (boxId, open) => patch(boxId, (r) => (r.open === open ? r : { ...r, open })),
    setBoxFolded: (boxId, boxFolded) =>
      patch(boxId, (r) => (!!r.boxFolded === boxFolded ? r : { ...r, boxFolded })),
    setView: (boxId, memberId, view) =>
      patch(boxId, (r) =>
        (r.views?.[memberId] ?? "files") === view
          ? r
          : { ...r, views: { ...r.views, [memberId]: view } },
      ),
  };
});

/** Test hook: forget every row in memory (and the stored copy). */
export function resetBoxAccordion() {
  writeJson(STORAGE_KEY, undefined);
  useBoxAccordionStore.setState({ byBox: {} });
}
