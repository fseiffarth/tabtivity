import { create } from "zustand";
import type { HeaderGroup, HeaderItemId } from "../lib/headerPins";

/**
 * Which top-bar slots currently hold something. A slot whose feature is off (no
 * mail account, an empty inbox, a machine with no battery) renders an empty
 * wrapper and takes no width; the cluster's chevron must not count it, or it
 * would offer to unfold nothing. `HeaderSlot` watches its own children and
 * reports here.
 */
export type HeaderSlotsDrag = {
  id: HeaderItemId;
  beforeId: HeaderItemId | null;
  afterId: HeaderItemId | null;
  group: HeaderGroup;
  pin: boolean;
} | null;

interface HeaderSlotsState {
  present: Partial<Record<HeaderItemId, true>>;
  setPresent: (id: HeaderItemId, present: boolean) => void;
  /** The icon being dragged and where it would land: in `group`, in front of
   *  `beforeId` (`null` → the end of it), pinned or folded. `afterId` is the slot
   *  the drop bar is drawn behind when there is no `beforeId` to draw it before. */
  drag: HeaderSlotsDrag;
  setDrag: (drag: HeaderSlotsState["drag"]) => void;
  /** A drag reached the ‹ chevron: the folded icons show for the rest of that
   *  drag, so it can land among them. Ends with the drag; the saved
   *  `header_status_expanded` is untouched. */
  foldPeek: boolean;
  setFoldPeek: (foldPeek: boolean) => void;
}

export const useHeaderSlotsStore = create<HeaderSlotsState>((set) => ({
  present: {},
  drag: null,
  foldPeek: false,
  setFoldPeek: (foldPeek) => set((s) => (s.foldPeek === foldPeek ? s : { foldPeek })),
  setDrag: (drag) =>
    set((s) =>
      s.drag?.id === drag?.id &&
      s.drag?.beforeId === drag?.beforeId &&
      s.drag?.afterId === drag?.afterId &&
      s.drag?.group === drag?.group &&
      s.drag?.pin === drag?.pin
        ? s
        : { drag },
    ),
  setPresent: (id, present) =>
    set((s) => {
      if (!!s.present[id] === present) return s;
      const next = { ...s.present };
      if (present) next[id] = true;
      else delete next[id];
      return { present: next };
    }),
}));
