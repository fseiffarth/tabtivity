import { useMemo, useState, type ReactElement } from "react";
import { useT } from "../../lib/i18n";
import { AGENT_ITEMS, TAB_ACCENT } from "../../lib/tabs/newTabItems";
import { DialogShell, useDialogs } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import {
  CalendarIcon,
  FolderIcon,
  GlobeIcon,
  HourglassIcon,
  PageIcon,
  SparkleIcon,
  TerminalIcon,
  TrashIcon,
  WindowIcon,
  type IconProps,
} from "../common/icons/Icon";
import {
  deleteArchivedTabs,
  restoreArchivedTab,
  useTabArchive,
  type ArchivedTab,
} from "../../stores/tabArchive";
import type { TabKind } from "../../stores/tabs";
import { tabKindLabelKey } from "./TabHoverCard";

/** The agent's CLI for an agent tab: the word an agent row says it is. */
function agentOf(entry: ArchivedTab): string | null {
  const kind = entry.tab.kind;
  if (kind !== "agent" && kind !== "local_agent") return null;
  return AGENT_ITEMS.find((item) => item.cmd === entry.tab.cmd)?.label ?? entry.tab.cmd;
}

/** One glyph per kind of tab, in that kind's tab-bar colour. */
const KIND_ICON: Partial<Record<TabKind, (p: IconProps) => ReactElement>> = {
  agent: SparkleIcon,
  local_agent: SparkleIcon,
  shell: TerminalIcon,
  files: FolderIcon,
  projectfiles: FolderIcon,
  embed: PageIcon,
  browser: GlobeIcon,
  calendar: CalendarIcon,
  promptchart: HourglassIcon,
};

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
 * A scope's archived tabs (`stores/tabArchive`): a toolbar with the filter and
 * the bulk delete, then one two-line row per tab, newest first — the row opens
 * it again (Restore), the trash button deletes it for good after asking.
 * Shown by the side panel's Archive view and the + menu's Archived tabs
 * dialog; `onRestored` lets the dialog close after a restore.
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
      <div className="sp-toolbar tab-archive-head menu-form">
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
            className="btn-quiet is-danger"
            title={t("tabArchive.deleteShownTitle")}
            onClick={() => void remove(shown)}
          >
            {t("tabArchive.deleteShown", { count: shown.length })}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="sp-note">{t(entries.length === 0 ? "tabArchive.empty" : "tabArchive.noMatch")}</p>
      ) : (
        <div role="list">
          {shown.map((entry) => {
            const kind: TabKind = entry.tab.kind ?? "shell";
            const Icon = KIND_ICON[kind] ?? WindowIcon;
            const word = agentOf(entry) ?? t(tabKindLabelKey(entry.tab));
            return (
              <div key={entry.id} role="listitem" className="sp-row sp-row--plain sp-row--two tab-archive-row" data-testid="tab-archive-row">
                <button
                  type="button"
                  className="sp-row-main tab-archive-restore"
                  disabled={busy !== null}
                  title={t("tabArchive.restoreTitle", { label: entry.tab.label })}
                  onClick={() => void restore(entry)}
                >
                  <span className="tab-archive-icon" style={{ color: TAB_ACCENT[kind] ?? "var(--text-secondary)" }}>
                    <Icon />
                  </span>
                  <span className="sp-row-text">
                    <span className="sp-row-name">{entry.tab.label}</span>
                    <span className="sp-row-sub" data-testid="tab-archive-kind">{word}</span>
                  </span>
                </button>
                <span className="sp-row-meta">
                  {archivedWhen(entry.archivedAt)}
                  <button
                    type="button"
                    className="btn-quiet is-danger tab-archive-delete"
                    title={t("tabArchive.deleteOneTitle")}
                    aria-label={t("tabArchive.deleteOneAria", { label: entry.tab.label })}
                    disabled={busy !== null}
                    onClick={() => void remove([entry])}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
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
