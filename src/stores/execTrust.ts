import { create } from "zustand";
import { QUEUED_CONFIRM_DELAY_MS } from "../lib/queuedConfirm";
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
  /** It waited behind another question, or was asked within
   *  `QUEUED_CONFIRM_DELAY_MS` of an answer (the next gate of the same
   *  action): shown the moment that one was answered, so its host arms the
   *  confirm button only after a short delay (`useConfirmArmed`) — the second
   *  click of a fast double click must not answer it unseen. */
  queued: boolean;
}

let nextAskId = 0;

interface ExecTrustStore {
  /** The question on screen. */
  pending: PendingAsk | null;
  /** Questions waiting behind it, oldest first. */
  queue: PendingAsk[];
  /** When the last question was answered (`Date.now()`; 0 before any). */
  answeredAt: number;
  ask: (request: TrustRequest) => Promise<boolean>;
  answer: (approved: boolean) => void;
}

export const useExecTrustStore = create<ExecTrustStore>((set, get) => ({
  pending: null,
  queue: [],
  answeredAt: 0,
  ask: (request) =>
    new Promise<boolean>((resolve) => {
      // One question per gated action, in turn (the open-external store's
      // rule). Superseding the earlier one declined it unseen, so of two
      // gated actions started together only the last could run.
      const { pending, queue, answeredAt } = get();
      const since = Date.now() - answeredAt;
      const queued = pending !== null || (since >= 0 && since < QUEUED_CONFIRM_DELAY_MS);
      const entry = { id: ++nextAskId, request, resolve, queued };
      if (pending) set({ queue: [...queue, entry] });
      else set({ pending: entry });
    }),
  answer: (approved) => {
    const { pending, queue } = get();
    const [next, ...rest] = queue;
    set({ pending: next ?? null, queue: rest, answeredAt: Date.now() });
    pending?.resolve(approved);
  },
}));
