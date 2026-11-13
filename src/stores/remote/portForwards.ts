import { create } from "zustand";
import { closePortForward, listPortForwards, type PortForwardRow } from "../../lib/remote/portForward";

/**
 * The active port forwards (`services::port_forward`), for the Ports list in the
 * remote hub. The backend registry is the truth; this is a copy read when a
 * surface opens and after every change made from the UI. A forward that ended on
 * its own (its tab closed, its host dropped) is noticed at the next `refresh`.
 */
interface PortForwardState {
  rows: PortForwardRow[];
  refresh: () => Promise<void>;
  stop: (id: string) => Promise<void>;
}

export const usePortForwardStore = create<PortForwardState>((set, get) => ({
  rows: [],
  refresh: async () => {
    try {
      const rows = await listPortForwards();
      set({ rows: Array.isArray(rows) ? rows : [] });
    } catch {
      // The browser client refuses these commands; there is no list there.
      set({ rows: [] });
    }
  },
  stop: async (id) => {
    try {
      await closePortForward(id);
    } finally {
      await get().refresh();
    }
  },
}));
