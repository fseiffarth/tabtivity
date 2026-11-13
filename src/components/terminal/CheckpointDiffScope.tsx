import { useEffect, useMemo, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { useExperimental } from "../../lib/experimental";
import { chatTime } from "../../../mobile-web/src/terminal/chatTimes";
import { checkpointDiff, snapshotRows, type CheckpointChange, type CheckpointRow, type CheckpointSince } from "../../lib/agents/checkpoints";
import { useTabCheckpoints } from "../../stores/agents/checkpoints";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { CheckpointRestoreDialog } from "./CheckpointRestoreDialog";
import type { ChangeCard, FileChange } from "./TerminalReaderChanges";

const KIND_KEY: Record<CheckpointRow["kind"], TranslationKey> = {
  pre: "checkpoints.kind.pre",
  post: "checkpoints.kind.post",
  manual: "checkpoints.kind.manual",
  "pre-restore": "checkpoints.kind.preRestore",
  restore: "checkpoints.kind.preRestore",
};

/** The label a checkpoint carries in pickers: what it was and when. */
export function checkpointLabel(t: ReturnType<typeof useT>, row: CheckpointRow, use24h: boolean): string {
  return t(KIND_KEY[row.kind], { time: chatTime(new Date(row.at), use24h) });
}

function asFileChange(change: CheckpointChange): FileChange {
  return {
    path: change.path,
    kind: change.status === "A" ? "add" : change.status === "D" ? "delete" : "edit",
    diff: change.diff ?? "",
    added: change.added ?? 0,
    removed: change.removed ?? 0,
    cut: change.cut,
  };
}

const NO_UNFOLD = () => {};

/**
 * The Diffs tab's second scope (`TerminalReaderChanges`): **Since checkpoint**,
 * the diff of one of this tab's checkpoints against the folder now — every
 * file, whoever changed it — with the restore button. `switchEl` goes beside
 * the layout toggle; `bodyEl` replaces the tab's body while the scope is on
 * (`null` otherwise, and when the feature is off or the tab has no
 * checkpoints at all).
 */
export function useCheckpointScope({ uid, ptyId, visible, base, split, card: Card }: {
  uid: string | undefined;
  ptyId: string | undefined;
  visible: boolean;
  base: string | undefined;
  split: boolean;
  /** `TerminalReaderChanges`'s card, handed in (importing it would be a cycle). */
  card: ComponentType<ComponentProps<typeof ChangeCard>>;
}): { switchEl: ReactNode; bodyEl: ReactNode } {
  const t = useT();
  const use24h = useUse24h();
  const flag = useExperimental("turn_checkpoints");
  const listing = useTabCheckpoints(uid, visible && flag);
  const [scope, setScope] = useState<"agent" | "since">("agent");
  const [picked, setPicked] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const [since, setSince] = useState<{ id: string; tick: number; value: CheckpointSince | null; error?: string } | null>(null);

  const mine = useMemo(
    () => snapshotRows(listing.rows).filter((row) => row.tabUid === uid).reverse(),
    [listing.rows, uid],
  );
  const current = mine.find((row) => row.id === picked) ?? mine[0];
  const currentId = current?.id;
  const available = flag && listing.enabled && listing.bound && !!uid;
  const active = available && scope === "since";

  useEffect(() => {
    if (!active || !uid || !currentId) return;
    let cancelled = false;
    checkpointDiff(uid, currentId).then(
      (value) => {
        if (!cancelled) setSince({ id: currentId, tick, value });
      },
      (reason) => {
        if (!cancelled) setSince({ id: currentId, tick, value: null, error: String(reason) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, uid, currentId, tick]);

  if (!available) return { switchEl: null, bodyEl: null };

  const switchEl = (
    <>
      <Dropdown
        className="terminal-changes-view"
        value={scope}
        options={[
          { value: "agent", label: t("checkpoints.scope.agent") },
          { value: "since", label: t("checkpoints.scope.since") },
        ]}
        onChange={(value) => setScope(value === "since" ? "since" : "agent")}
      />
      {scope === "since" && mine.length > 0 && (
        <Dropdown
          className="terminal-changes-view checkpoint-pick"
          value={current?.id ?? ""}
          options={mine.map((row) => ({ value: row.id, label: checkpointLabel(t, row, use24h) }))}
          onChange={(value) => setPicked(value)}
        />
      )}
      <UntestedTag id="checkpoints.scope" />
    </>
  );
  if (!active) return { switchEl, bodyEl: null };

  const fresh = since && since.id === current?.id && since.tick === tick ? since : null;
  const files = fresh?.value?.files ?? [];
  const bodyEl = (
    <div className="terminal-changes-list checkpoint-scope">
      {!current ? (
        <div className="terminal-reader-empty">{t("checkpoints.scope.none")}</div>
      ) : (
        <>
          <div className="checkpoint-scope-head">
            <span>{fresh?.value ? t("checkpoints.scope.summary", { n: files.length, label: checkpointLabel(t, current, use24h) }) : t("checkpoints.restore.loading")}</span>
            <button type="button" className="btn-quiet" onClick={() => setTick((n) => n + 1)}>{t("checkpoints.scope.refresh")}</button>
            <button type="button" className="settings-btn" disabled={!uid || !fresh?.value || files.length === 0} onClick={() => setRestoring(true)}>
              {t("checkpoints.scope.restore")}
            </button>
          </div>
          {fresh?.error && <div className="terminal-reader-empty" role="alert">{fresh.error}</div>}
          {fresh?.value && files.length === 0 && <div className="terminal-reader-empty">{t("checkpoints.scope.unchanged")}</div>}
          {files.map((change, index) => (
            <Card
              key={change.path}
              change={asFileChange(change)}
              cardKey={change.path}
              fresh={false}
              cursor={false}
              base={base}
              use24h={use24h}
              split={split}
              initialOpen={index === 0}
              onUnfold={NO_UNFOLD}
            />
          ))}
          {fresh?.value && fresh.value.files.some((change) => change.diff == null && !change.binary) && (
            <small className="terminal-changes-note">{t("checkpoints.scope.manyFiles")}</small>
          )}
        </>
      )}
      {restoring && uid && current && (
        <CheckpointRestoreDialog
          uid={uid}
          ptyId={ptyId}
          row={current}
          rows={listing.rows}
          onClose={() => {
            setRestoring(false);
            setTick((n) => n + 1);
          }}
        />
      )}
    </div>
  );
  return { switchEl, bodyEl };
}
