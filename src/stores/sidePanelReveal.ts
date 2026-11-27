import { create } from "zustand";

import type { FilesPanelView } from "../types";

/**
 * A file or folder to show in the **side panel's** file tree — an agent tab's
 * Ctrl (⌘) + click on a path link (`lib/terminal/pathLinks`
 * `revealInSidePanel`). The asker opens the panel on its Files view through
 * the shell's `app:reveal-side-panel` event; the side panel's tree of that
 * project (`FileTree` `takeReveals`) takes the request once it is mounted —
 * a closed panel mounts no tree, so this is a store, not an event.
 *
 * A request no tree takes within `REVEAL_TTL_MS` is dropped, so a tree that
 * mounts much later (the user opening the panel by hand) never jumps.
 */
export interface SidePanelReveal {
  projectId: string;
  /** Project-relative, `/`-separated. */
  rel: string;
  isDir: boolean;
  at: number;
}

export const REVEAL_TTL_MS = 5000;

interface SidePanelRevealState {
  pending: SidePanelReveal | null;
  request: (projectId: string, rel: string, isDir: boolean) => void;
  /** The pending request for this project's tree, taken (cleared) — or null. */
  take: (projectId: string) => SidePanelReveal | null;
}

export const useSidePanelRevealStore = create<SidePanelRevealState>((set, get) => ({
  pending: null,
  request: (projectId, rel, isDir) => set({ pending: { projectId, rel, isDir, at: Date.now() } }),
  take: (projectId) => {
    const pending = get().pending;
    if (!pending || pending.projectId !== projectId) return null;
    set({ pending: null });
    return Date.now() - pending.at <= REVEAL_TTL_MS ? pending : null;
  },
}));

const FILES_VIEW: FilesPanelView = "files";

/** Ask for `rel` in the side panel's tree of `projectId` and open the panel on
 *  its Files view. */
export function requestSidePanelReveal(projectId: string, rel: string, isDir: boolean) {
  useSidePanelRevealStore.getState().request(projectId, rel, isDir);
  window.dispatchEvent(new CustomEvent("app:reveal-side-panel", { detail: { view: FILES_VIEW } }));
}
