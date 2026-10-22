import { create } from "zustand";
import type { HeaderItemId } from "../lib/headerPins";

/**
 * Which top-bar slots currently hold something. A slot whose feature is off (no
 * mail account, an empty inbox, a machine with no battery) renders an empty
 * wrapper and takes no width; the cluster's chevron must not count it, or it
 * would offer to unfold nothing. `HeaderSlot` watches its own children and
 * reports here.
 */
interface HeaderSlotsState {
  present: Partial<Record<HeaderItemId, true>>;
  setPresent: (id: HeaderItemId, present: boolean) => void;
}

export const useHeaderSlotsStore = create<HeaderSlotsState>((set) => ({
  present: {},
  setPresent: (id, present) =>
    set((s) => {
      if (!!s.present[id] === present) return s;
      const next = { ...s.present };
      if (present) next[id] = true;
      else delete next[id];
      return { present: next };
    }),
}));
