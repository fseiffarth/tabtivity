import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { useExperimental } from "../../lib/experimental";
import { checkpointNow, preForPrompt, type CheckpointRow } from "../../lib/agents/checkpoints";
import { useCheckpointsStore, useTabCheckpoints } from "../../stores/agents/checkpoints";
import { UntestedTag } from "../common/UntestedTag";
import { CheckpointRestoreDialog } from "./CheckpointRestoreDialog";

/**
 * The Chat's half of per-turn checkpoints (`services::checkpoints`): a prompt
 * bubble's **↶ Restore files to before this** and the composer's **Checkpoint
 * now**. Both appear only with the experimental flag on, the backend switch
 * on and the tab bound to a folder (a local project's agent tab).
 *
 * A bubble is matched to its turn's `pre` checkpoint by tab and prompt time
 * (`preForPrompt`, ±5 s); with no match the action is absent, never guessed.
 */
export function useReaderCheckpoints({ uid, ptyId, visible }: {
  /** The tab's launch uid (`TabEntry.sessionId`). */
  uid: string | undefined;
  ptyId: string;
  visible: boolean;
}): {
  /** The action for the prompt bubble stamped `stamp`, if it has a checkpoint. */
  restoreFor: (stamp: string | undefined) => ReactNode;
  /** The open restore dialog, to render once. */
  dialog: ReactNode;
} {
  const t = useT();
  const flag = useExperimental("turn_checkpoints");
  const listing = useTabCheckpoints(uid, visible && flag);
  const [row, setRow] = useState<CheckpointRow | null>(null);
  const on = flag && listing.enabled && listing.bound && !!uid;
  const restoreFor = useCallback((stamp: string | undefined): ReactNode => {
    if (!on || !uid) return null;
    const pre = preForPrompt(listing.rows, uid, stamp);
    if (!pre) return null;
    return (
      <button type="button" className="btn-quiet terminal-reader-restore" onClick={() => setRow(pre)} title={t("checkpoints.bubble.hint")}>
        ↶ {t("checkpoints.bubble")} <UntestedTag id="checkpoints.bubble" />
      </button>
    );
  }, [on, uid, listing.rows, t]);
  const dialog = row && uid ? (
    <CheckpointRestoreDialog uid={uid} ptyId={ptyId} row={row} rows={listing.rows} onClose={() => setRow(null)} />
  ) : null;
  return { restoreFor, dialog };
}

/**
 * The composer's **Checkpoint now**: `run` takes a manual checkpoint of the
 * tab's folder (`undefined` where checkpoints are off or the tab has none),
 * and `done` is true for a moment after one landed. `error`: why the last
 * one failed (this click's, or the folder's last automatic one), until one
 * succeeds — an automatic snapshot fails out of sight otherwise.
 */
export function useCheckpointNow(uid: string | undefined, visible: boolean): { run: (() => void) | undefined; done: boolean; failed: boolean; error: string | null } {
  const flag = useExperimental("turn_checkpoints");
  const listing = useTabCheckpoints(uid, visible && flag);
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const [manualError, setManualError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const available = flag && listing.enabled && listing.bound && !!uid;
  const run = useCallback(() => {
    if (!uid) return;
    checkpointNow(uid).then(
      () => {
        setState("done");
        setManualError(null);
        void useCheckpointsStore.getState().refresh(uid);
      },
      (reason) => {
        setState("failed");
        setManualError(String(reason));
      },
    ).finally(() => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 2500);
    });
  }, [uid]);
  const error = available ? manualError ?? listing.failure : null;
  return { run: available ? run : undefined, done: state === "done", failed: state === "failed", error };
}
