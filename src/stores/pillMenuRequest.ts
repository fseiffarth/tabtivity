import { create } from "zustand";

/**
 * A request to open a project pill's right-click menu from somewhere else
 * (the side panel's project name). The menu and every dialog it opens belong
 * to the pill, so the asker parks the request here and that project's pill
 * opens its own menu at the given point. `take` hands it to one pill only and
 * clears it, so it fires once; with no pill of that project mounted, nothing
 * opens.
 */
export interface PillMenuRequest {
  projectId: string;
  x: number;
  y: number;
}

interface PillMenuRequestStore {
  request: PillMenuRequest | null;
  open: (request: PillMenuRequest) => void;
  /** The pending request for `projectId`, cleared; null when there is none. */
  take: (projectId: string) => PillMenuRequest | null;
}

export const usePillMenuRequestStore = create<PillMenuRequestStore>((set, get) => ({
  request: null,
  open: (request) => set({ request }),
  take: (projectId) => {
    const request = get().request;
    if (request?.projectId !== projectId) return null;
    set({ request: null });
    return request;
  },
}));
