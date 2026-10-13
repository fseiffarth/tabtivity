import { create } from "zustand";

/**
 * The pending "open this file with the system's default app?" questions
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

interface PendingAsk {
  /** Distinct per question, so the dialog is built anew for each (its
   *  default button takes the focus again). */
  id: number;
  request: OpenExternalRequest;
  resolve: (approved: boolean) => void;
  /** It waited behind another question: shown the moment that one was
   *  answered, so its host arms the confirm button only after a short delay
   *  (`useConfirmArmed`) — the second click of a fast double click must not
   *  answer it unseen. */
  queued: boolean;
}

let nextAskId = 0;

interface OpenExternalStore {
  /** The question on screen. */
  pending: PendingAsk | null;
  /** Questions waiting behind it, oldest first. */
  queue: PendingAsk[];
  ask: (request: OpenExternalRequest) => Promise<boolean>;
  answer: (approved: boolean) => void;
}

export const useOpenExternalStore = create<OpenExternalStore>((set, get) => ({
  pending: null,
  queue: [],
  ask: (request) =>
    new Promise<boolean>((resolve) => {
      // One question per file, in turn: several no-viewer files dropped or
      // dragged out at once each get theirs. (Superseding the earlier one
      // declined it unseen, so only the last file of a drop could open.)
      const { pending, queue } = get();
      const entry = { id: ++nextAskId, request, resolve, queued: pending !== null };
      if (pending) set({ queue: [...queue, entry] });
      else set({ pending: entry });
    }),
  answer: (approved) => {
    const { pending, queue } = get();
    const [next, ...rest] = queue;
    set({ pending: next ?? null, queue: rest });
    pending?.resolve(approved);
  },
}));
