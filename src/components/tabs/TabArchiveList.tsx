import { useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { AGENT_ITEMS, TAB_ACCENT } from "../../lib/tabs/newTabItems";
import { DialogShell, useDialogs } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import { CloseIcon, DotIcon } from "../common/icons/Icon";
import {
  deleteArchivedTabs,
  restoreArchivedTab,
  useTabArchive,
  type ArchivedTab,
} from "../../stores/tabArchive";
import type { TabKind } from "../../stores/tabs";

/** What a row says under its label: the agent's CLI for an agent tab. */
function agentOf(entry: ArchivedTab): string | null {
  const kind = entry.tab.kind;
  if (kind !== "agent" && kind !== "local_agent") return null;
  return AGENT_ITEMS.find((item) => item.cmd === entry.tab.cmd)?.label ?? entry.tab.cmd;
}

function archivedWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A scope's archived tabs (`stores/tabArchive`): a filter, then one row per
 * tab, newest first — its label opens it again (Restore), × deletes it for
 * good after asking. Shown by the side panel's Archive view and the + menu's
 * Archived tabs dialog; `onRestored` lets the dialog close after a restore.
 */
export function TabArchiveList({ scope, onRestored }: { scope: string; onRestored?: () => void }) {
  const t = useT();
  const { confirmAction } = useDialogs();
  const entries = useTabArchive(scope);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((e) =>
      [e.tab.label, e.tab.cmd, e.tab.embedPath ?? "", e.tab.cwd].some((s) => s.toLowerCase().includes(needle)),
    );
  }, [entries, filter]);

  const restore = async (entry: ArchivedTab) => {
    setBusy(entry.id);
    try {
      await restoreArchivedTab(scope, entry.id);
      onRestored?.();
    } catch (e) {
      console.warn("tab archive: restore failed", e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (entries: readonly ArchivedTab[]) => {
    if (entries.length === 0) return;
    const ok = await confirmAction({
      title: t("tabArchive.deleteTitle"),
      body:
        entries.length === 1
          ? t("tabArchive.deleteOneBody", { label: entries[0].tab.label })
          : t("tabArchive.deleteManyBody", { count: entries.length }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    await deleteArchivedTabs(scope, entries.map((e) => e.id)).catch((e) => console.warn("tab archive: delete failed", e));
  };

  return (
    <div className="tab-archive-list">
      <div className="tab-archive-head menu-form">
        <input
          type="search"
          value={filter}
          placeholder={t("tabArchive.filterPlaceholder")}
          aria-label={t("tabArchive.filterPlaceholder")}
          onChange={(e) => setFilter(e.target.value)}
        />
        <UntestedTag id="tabArchive.list" />
        {shown.length > 1 && (
          <button
            type="button"
            className="orange-file-act"
            title={t("tabArchive.deleteShownTitle")}
            onClick={() => void remove(shown)}
          >
            {t("tabArchive.deleteShown", { count: shown.length })}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="side-panel-orange-empty">
          {t(entries.length === 0 ? "tabArchive.empty" : "tabArchive.noMatch")}
        </div>
      ) : (
        shown.map((entry) => {
          const agent = agentOf(entry);
          const kind = (entry.tab.kind ?? "shell") as TabKind;
          return (
            <div key={entry.id} className="orange-file-row">
              <button
                type="button"
                className="orange-file-name"
                disabled={busy !== null}
                title={t("tabArchive.restoreTitle", { label: entry.tab.label })}
                onClick={() => void restore(entry)}
              >
                <span
                  className="orange-file-dot"
                  style={{ color: TAB_ACCENT[kind] ?? "var(--text-secondary)" }}
                  aria-hidden="true"
                >
                  <DotIcon />
                </span>
                <span className="tmux-session-label">{entry.tab.label}</span>
                <span className="tmux-session-meta">
                  {agent ? `${agent} · ` : ""}
                  {archivedWhen(entry.archivedAt)}
                </span>
              </button>
              <div className="orange-file-actions">
                <button
                  type="button"
                  className="orange-file-act"
                  title={t("tabArchive.deleteOneTitle")}
                  aria-label={t("tabArchive.deleteOneAria", { label: entry.tab.label })}
                  disabled={busy !== null}
                  onClick={() => void remove([entry])}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

/** The + menu's Archived tabs: the list in a dialog that closes on a restore. */
export function TabArchiveDialog({ scope, onClose }: { scope: string; onClose: () => void }) {
  const t = useT();
  return (
    <DialogShell frame="project-dialog" className="tab-archive-dialog" scroll title={t("tabArchive.title")} onDismiss={onClose}>
      <div className="project-dialog-path">{t("tabArchive.desc")}</div>
      <TabArchiveList scope={scope} onRestored={onClose} />
    </DialogShell>
  );
}
