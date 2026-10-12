import { create } from "zustand";

/**
 * The one pending "open this file with the system's default app?" question
 * (threat recheck gap 21, decision C2). A store because the hand-off starts
 * wherever a file has no viewer — the file tree, the file browser, Downloads,
 * terminal path links, Reader change cards, the phone's inbox — and is
 * answered by the one `OpenExternalHost` mounted per window.
 *
 * `refused` is not a question: a launcher or executable the backend will not
 * hand to the OS, shown with an OK button only.
 */
export interface OpenExternalRequest {
  kind: "confirm" | "refused";
  /** The file's name, as the dialog names it. */
  name: string;
  /** The full path, shown under the question. */
  path: string;
}

interface OpenExternalStore {
  pending: { request: OpenExternalRequest; resolve: (approved: boolean) => void } | null;
  ask: (request: OpenExternalRequest) => Promise<boolean>;
  answer: (approved: boolean) => void;
}

export const useOpenExternalStore = create<OpenExternalStore>((set, get) => ({
  pending: null,
  ask: (request) =>
    new Promise<boolean>((resolve) => {
      // A second question supersedes the first; the first counts as declined.
      get().pending?.resolve(false);
      set({ pending: { request, resolve } });
    }),
  answer: (approved) => {
    const pending = get().pending;
    set({ pending: null });
    pending?.resolve(approved);
  },
}));
