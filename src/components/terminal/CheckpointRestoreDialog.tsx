import { useEffect, useMemo, useState } from "react";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { chatTime } from "../../../mobile-web/src/terminal/chatTimes";
import { insertIntoReader } from "../../lib/terminal/terminalDrop";
import {
  checkpointDiff,
  checkpointRestore,
  previousPost,
  type CheckpointChange,
  type CheckpointRestored,
  type CheckpointRow,
  type CheckpointSince,
} from "../../lib/agents/checkpoints";
import { useCheckpointsStore } from "../../stores/agents/checkpoints";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";

const STATUS_KEY: Record<CheckpointChange["status"], TranslationKey> = {
  A: "checkpoints.status.A",
  D: "checkpoints.status.D",
  M: "checkpoints.status.M",
  T: "checkpoints.status.T",
};

/**
 * Put an agent tab's folder back to a checkpoint (`services::checkpoints`).
 * Lists every file that differs now, all ticked: a file added since is
 * removed, any other put back. Files only — the CLI's conversation stays as it
 * is; a pre-ticked box puts a short note into the Reader's composer for the
 * user to send or delete. A restore takes its own `pre-restore` checkpoint
 * first, so the result step offers **Undo restore**.
 *
 * `uid` is the tab's launch uid and `row` the checkpoint: the backend finds
 * the folder, the window never names one.
 */
export function CheckpointRestoreDialog({ uid, ptyId, row, rows, onClose }: {
  uid: string;
  /** The tab's PTY, for the composer note; absent: no note offered. */
  ptyId: string | undefined;
  row: CheckpointRow;
  /** The tab's checkpoints, to offer the previous turn's end for a raced one. */
  rows: readonly CheckpointRow[];
  onClose: () => void;
}) {
  const t = useT();
  const use24h = useUse24h();
  const [target, setTarget] = useState(row);
  const [since, setSince] = useState<CheckpointSince | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState(true);
  const [others, setOthers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ restored: CheckpointRestored; undone: boolean } | null>(null);
  const when = chatTime(new Date(target.at), use24h);

  useEffect(() => {
    let cancelled = false;
    setSince(null);
    setError(null);
    checkpointDiff(uid, target.id).then(
      (next) => {
        if (cancelled) return;
        setSince(next);
        setTicked(new Set(next.files.map((file) => file.path)));
      },
      (reason) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [uid, target.id]);

  const previous = target.raced ? previousPost(rows, target) : undefined;
  const flagged = useMemo(() => new Set(since?.others ?? []), [since]);
  const chosen = since?.files.filter((file) => ticked.has(file.path)) ?? [];
  const blocked = !!since?.othersWorking && !others;

  const run = async (id: string, only: string[] | null) => {
    setBusy(true);
    setError(null);
    try {
      const done = await checkpointRestore(uid, id, only, others);
      void useCheckpointsStore.getState().refresh(uid);
      return done;
    } catch (reason) {
      setError(String(reason));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const done = await run(target.id, chosen.map((file) => file.path));
    if (!done) return;
    if (note && ptyId) insertIntoReader(ptyId, t("checkpoints.restore.noteText", { time: when }));
    setResult({ restored: done, undone: false });
  };

  const undo = async () => {
    if (!result) return;
    const done = await run(result.restored.undoId, null);
    if (done) setResult({ restored: done, undone: true });
  };

  const toggle = (path: string) =>
    setTicked((previousSet) => {
      const next = new Set(previousSet);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <DialogShell
      frame="project-dialog"
      className="checkpoint-restore"
      scroll
      title={<>{t("checkpoints.restore.title")} <UntestedTag id="checkpoints.restore" /></>}
      onDismiss={onClose}
      closeDisabled={busy}
    >
      {result ? (
        <div className="checkpoint-restore-body">
          <div className="project-dialog-path" role="status">
            {t(result.undone ? "checkpoints.restore.undone" : "checkpoints.restore.done", {
              restored: result.restored.restored,
              removed: result.restored.removed,
            })}
          </div>
          {result.restored.failed.length > 0 && (
            <div className="checkpoint-restore-notes" role="alert">
              <div>{t("checkpoints.restore.failed", { n: result.restored.failed.length })}</div>
              <ul className="checkpoint-restore-files">
                {result.restored.failed.map((failure) => (
                  <li key={failure.path} title={failure.error}>
                    <span className="checkpoint-restore-path">{failure.path}</span>
                    <small>{failure.error}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && <div className="checkpoint-restore-notes" role="alert">{error}</div>}
          <div className="project-dialog-actions">
            {!result.undone && (
              <button type="button" className="settings-btn" disabled={busy} onClick={() => void undo()}>
                {t("checkpoints.restore.undo")}
              </button>
            )}
            <button type="button" className="btn-primary" onClick={onClose}>{t("common.close")}</button>
          </div>
        </div>
      ) : (
        <div className="checkpoint-restore-body">
          <div className="project-dialog-path">{t("checkpoints.restore.intro", { time: when })}</div>
          {target.raced && (
            <div className="checkpoint-restore-notes">
              <div>{t("checkpoints.restore.raced")}</div>
              {previous && (
                <button type="button" className="btn-quiet" onClick={() => setTarget(previous)}>
                  {t("checkpoints.restore.usePrevious", { time: chatTime(new Date(previous.at), use24h) })}
                </button>
              )}
            </div>
          )}
          {target.partial && <div className="checkpoint-restore-notes">{t("checkpoints.restore.partial")}</div>}
          {error && <div className="checkpoint-restore-notes" role="alert">{error}</div>}
          {!since && !error && <div className="checkpoint-restore-notes">{t("checkpoints.restore.loading")}</div>}
          {since && since.files.length === 0 && <div className="checkpoint-restore-notes">{t("checkpoints.restore.nothing")}</div>}
          {since && since.files.length > 0 && (
            <ul className="checkpoint-restore-files" aria-label={t("checkpoints.restore.files")}>
              {since.files.map((file) => (
                <li key={file.path}>
                  <label>
                    <input type="checkbox" checked={ticked.has(file.path)} onChange={() => toggle(file.path)} />
                    <span className={`checkpoint-restore-status status-${file.status}`} title={t(STATUS_KEY[file.status])}>{file.status}</span>
                    <span className="checkpoint-restore-path" title={file.path}>{file.path}</span>
                  </label>
                  {flagged.has(file.path) && <small className="checkpoint-restore-flag">{t("checkpoints.restore.byOther")}</small>}
                </li>
              ))}
            </ul>
          )}
          {since && since.nested.length > 0 && (
            <div className="checkpoint-restore-notes">{t("checkpoints.restore.nested", { list: since.nested.join(", ") })}</div>
          )}
          {since && since.leftOut > 0 && (
            <div className="checkpoint-restore-notes">{t("checkpoints.restore.leftOut", { n: since.leftOut })}</div>
          )}
          {since?.othersWorking && (
            <label className="checkpoint-restore-confirm">
              <input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} />
              {t("checkpoints.restore.othersWorking")}
            </label>
          )}
          {ptyId && (
            <label className="checkpoint-restore-confirm">
              <input type="checkbox" checked={note} onChange={(e) => setNote(e.target.checked)} />
              {t("checkpoints.restore.note")}
            </label>
          )}
          <div className="project-dialog-actions">
            <button type="button" className="settings-btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
            <button type="button" className="btn-primary" disabled={busy || blocked || chosen.length === 0} onClick={() => void restore()}>
              {busy ? t("checkpoints.restore.restoring") : t("checkpoints.restore.action", { n: chosen.length })}
            </button>
          </div>
        </div>
      )}
    </DialogShell>
  );
}
