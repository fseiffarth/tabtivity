import { create } from "zustand";
import type { TrustRequest } from "../lib/execTrust";

/**
 * The pending "run this project's hooks / latexmkrc / prettier?" questions
 * (`services::exec_trust`). A store rather than component state because the
 * question is raised from wherever the gated action started — the git panel, a
 * viewer's Build or Format button, the publish flow — and answered by the one
 * `ExecTrustHost` mounted per window.
 */
interface PendingAsk {
  /** Distinct per question, so the dialog is built anew for each (its
   *  default button takes the focus again). */
  id: number;
  request: TrustRequest;
  resolve: (approved: boolean) => void;
}

let nextAskId = 0;

interface ExecTrustStore {
  /** The question on screen. */
  pending: PendingAsk | null;
  /** Questions waiting behind it, oldest first. */
  queue: PendingAsk[];
  ask: (request: TrustRequest) => Promise<boolean>;
  answer: (approved: boolean) => void;
}

export const useExecTrustStore = create<ExecTrustStore>((set, get) => ({
  pending: null,
  queue: [],
  ask: (request) =>
    new Promise<boolean>((resolve) => {
      // One question per gated action, in turn (the open-external store's
      // rule). Superseding the earlier one declined it unseen, so of two
      // gated actions started together only the last could run.
      const entry = { id: ++nextAskId, request, resolve };
      const { pending, queue } = get();
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
