import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { subscribeTauri } from "../hooks/useTauriListener";
import { PRINT_MCP_CHANGED, printRequests, type PrintRequest } from "../lib/window/printMcp";

/**
 * The agent print requests waiting for the user (`services::print_mcp`), shared
 * by the Print Manager tab's list and the shell's popup. `start` subscribes
 * once (the shell host calls it) and refetches on every `print-mcp-changed`.
 */
interface PrintRequestsState {
  requests: PrintRequest[];
  /** Ids the user put off with Later: the popup stays down until a new one comes. */
  later: string[];
  /** The request whose preview is open, so the popup does not offer it twice. */
  reviewing: string | null;
  refresh: () => Promise<void>;
  start: () => () => void;
  putOff: (ids: string[]) => void;
  setReviewing: (id: string | null) => void;
}

let started = 0;
let stop: (() => void) | null = null;
/** Bumped per refresh, so a slow answer never overwrites a newer one. */
let generation = 0;

export const usePrintRequestsStore = create<PrintRequestsState>((set, get) => ({
  requests: [],
  later: [],
  reviewing: null,
  refresh: async () => {
    const run = ++generation;
    const requests = await printRequests();
    if (run !== generation) return;
    const live = new Set(requests.map((r) => r.id));
    set((s) => ({
      requests,
      later: s.later.filter((id) => live.has(id)),
      reviewing: s.reviewing && live.has(s.reviewing) ? s.reviewing : null,
    }));
  },
  start: () => {
    started += 1;
    if (started === 1) {
      stop = subscribeTauri(() => listen(PRINT_MCP_CHANGED, () => void get().refresh()));
      void get().refresh();
    }
    return () => {
      started -= 1;
      if (started === 0) {
        stop?.();
        stop = null;
      }
    };
  },
  putOff: (ids) => set((s) => ({ later: [...new Set([...s.later, ...ids])] })),
  setReviewing: (id) => set({ reviewing: id }),
}));
