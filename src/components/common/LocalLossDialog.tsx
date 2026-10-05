import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useProjectsStore } from "../../stores/projects";
import {
  LOCAL_LOSS_EVENTS,
  localLossEventConcerns,
  useLocalLossStore,
  type LocalLoss,
} from "../../stores/localLoss";
import { useT, type TranslationKey } from "../../lib/i18n";

/**
 * Warns that something on the LOCAL side was destroyed by git lockstep or by sync
 * (#28q). Mounted once at the shell, like the alarm popup: a mirror file can be deleted
 * by a background reconcile pass while the user is in a terminal three tabs away, and
 * they must hear about it wherever they are — the panel it happened in may not even be
 * open.
 *
 * Reads `stores/localLoss`, which reads the backend's on-disk log rather than an event,
 * so a deletion during a background pass (or while the app was closed) still surfaces.
 * Refreshed whenever a lockstep or sync pass reports in — those are exactly the passes
 * that can have recorded something.
 *
 * It reports, it does not confirm: by the time this renders the write has happened. The
 * gates that *prevent* a destructive write live upstream (`pairing_conflict`, the
 * blocked-fast-forward refusal, `push_decision`), and this exists precisely for what
 * they deliberately let through.
 */

const KIND_LABEL_KEY: Record<LocalLoss["kind"], TranslationKey> = {
  deleted: "localLoss.kindDeleted",
  overwritten: "localLoss.kindOverwritten",
};

const SOURCE_LABEL_KEY: Record<LocalLoss["source"], TranslationKey> = {
  git: "localLoss.sourceGit",
  sync: "localLoss.sourceSync",
};

function timeLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function LossEntry({ loss }: { loss: LocalLoss }) {
  const t = useT();
  const hidden = loss.total - loss.paths.length;
  return (
    <div className="local-loss-entry">
      <div className="local-loss-entry-head">
        <span className={`local-loss-badge local-loss-badge-${loss.kind}`}>
          {t(loss.total === 1 ? "localLoss.entryCountOne" : "localLoss.entryCountMany", {
            count: loss.total,
            kind: t(KIND_LABEL_KEY[loss.kind]),
          })}
        </span>
        <span className="local-loss-when">
          {t(SOURCE_LABEL_KEY[loss.source])} · {timeLabel(loss.ts)}
        </span>
      </div>
      <div className="local-loss-op">{loss.op}</div>
      <ul className="local-loss-paths">
        {loss.paths.map((p) => (
          <li key={p}>{p}</li>
        ))}
        {hidden > 0 && <li className="local-loss-more">{t("localLoss.moreCount", { count: hidden })}</li>}
      </ul>
      <div className={`local-loss-recovery${loss.recovery ? "" : " local-loss-gone"}`}>
        {loss.recovery ?? t("localLoss.unrecoverable")}
      </div>
    </div>
  );
}

export function LocalLossDialog() {
  const t = useT();
  const activeId = useProjectsStore((s) => s.activeId);
  const entries = useLocalLossStore((s) => s.entries);
  const loadedFor = useLocalLossStore((s) => s.projectId);
  const refresh = useLocalLossStore((s) => s.refresh);
  const ack = useLocalLossStore((s) => s.ack);

  // Re-read the log on project switch and after every lockstep/sync pass — the only
  // moments at which the backend can have appended to it.
  useEffect(() => {
    if (!activeId) return;
    void refresh(activeId);
    const uns: Array<() => void> = [];
    let cancelled = false;
    const on = (event: string) => {
      void listen(event, (e) => {
        if (localLossEventConcerns(event, e.payload, activeId)) void refresh(activeId);
      }).then((u) => (cancelled ? u() : uns.push(u)));
    };
    LOCAL_LOSS_EVENTS.forEach(on);
    return () => {
      cancelled = true;
      uns.forEach((u) => u());
    };
  }, [activeId, refresh]);

  // Only ever speak for the project on screen: a log fetched for a project the user has
  // since switched away from is not this project's news.
  const mine = loadedFor === activeId ? entries : [];
  const unseen = mine.filter((e) => !e.acked);
  if (!activeId || unseen.length === 0) return null;

  const files = unseen.reduce((n, e) => n + e.total, 0);

  return (
    // No click-outside dismiss and no Esc, unlike every other modal here: this one is
    // only ever shown because something was already destroyed, and acknowledging it is
    // permanent. A stray click on the backdrop must not be able to make it go away.
    <div className="modal-backdrop">
      <div className="project-dialog local-loss-dialog">
        <h2 className="local-loss-title">{t("localLoss.title")}</h2>
        <p className="local-loss-lede">
          {t("localLoss.ledePre")}{" "}
          <strong>
            {t(files === 1 ? "localLoss.filesCountOne" : "localLoss.filesCountMany", { count: files })}
          </strong>{" "}
          {t("localLoss.ledeMid")}{" "}
          {t(unseen.length === 1 ? "localLoss.opsCountOne" : "localLoss.opsCountMany", { count: unseen.length })}
          {t("localLoss.ledePost")}
        </p>
        <div className="local-loss-list">
          {/* Two ops in the same second share a `ts` (a fast-forward and the clean that
              cleared its way, say), so the index is part of the key. */}
          {unseen.map((e, i) => (
            <LossEntry key={`${e.ts}-${i}`} loss={e} />
          ))}
        </div>
        <div className="project-dialog-actions">
          <button type="button" onClick={() => void ack(activeId)}>
            {t("howToStart.gotIt")}
          </button>
        </div>
      </div>
    </div>
  );
}
