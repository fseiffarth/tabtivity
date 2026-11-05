import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, effectiveTabLocation, type TabEntry } from "../../stores/tabs";
import { queuePromptForTab } from "../../stores/agents/agentPrompts";
import { isPromptTargetTab } from "../agents/promptTarget";
import { agentItemFor, newAgentTabForDraft, promptChartNewTabAgent } from "../../lib/agents/prompt/newTab";
import { EMPTY_CUSTOM_AGENTS } from "../../lib/tabs/newTabItems";
import { isHostPinned } from "../../lib/projectTabHost";
import { resolveProjectDirectory } from "../../types";
import type { HandoffFile } from "../../lib/viewers/syncHandoff";
import { DialogShell } from "../common/PromptDialogs";

/** What the backend answers (`services::sync_handoff::HandoffExport`). */
interface HandoffExport {
  id: string;
  agentDir: string;
  fileCount: number;
}

const EMPTY_TABS: TabEntry[] = [];

/**
 * "Hand to an agent": export the conflicting files into the project's agent
 * folder (`sync_handoff_export`), then offer one click to open an agent tab with
 * a ready prompt, queue it at an open agent tab, or copy it. `collect` gathers
 * the files (the resolver already holds both texts; the side panel reads them);
 * `connected` gates it, since the remote side has to be read. Used by the
 * resolver's header and the orange list's bulk bar.
 */
export function SyncHandoffButton({
  projectId,
  connected,
  disabled,
  collect,
  label,
  title,
  className,
}: {
  projectId: string | null;
  connected: boolean;
  /** Nothing to export right now (the button stays visible, greyed). */
  disabled?: boolean;
  /** Read what to export; `skipped` counts files that could not be read. */
  collect: (progress: (done: number, total: number) => void) => Promise<{ files: HandoffFile[]; skipped: number }>;
  label: string;
  title: string;
  className?: string;
}) {
  const t = useT();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const tabs = useTabsStore((s) => (projectId ? s.tabsByScope[projectId] : undefined)) ?? EMPTY_TABS;
  const addTabToScope = useTabsStore((s) => s.addTabToScope);
  const newTabAgent = useSettingsStore((s) => promptChartNewTabAgent(s.settings));
  const customAgents = useSettingsStore((s) => s.settings?.custom_agents ?? EMPTY_CUSTOM_AGENTS);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ out: HandoffExport; skipped: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Only a tab that runs on THIS machine can read the folder (it sits in the
  // project's local agent home); a tab on the host cannot.
  const localTabs = useMemo(
    () =>
      tabs.filter(
        (tab) => isPromptTargetTab(tab) && effectiveTabLocation(tab, { hostPinned: isHostPinned(project) }) === "local",
      ),
    [tabs, project],
  );

  const prompt = result ? t("syncHandoff.prompt", { dir: result.out.agentDir }) : "";

  const start = () => {
    if (!projectId || busy || !connected) return;
    setError(null);
    setNote(null);
    setBusy(t("syncHandoff.working"));
    void (async () => {
      try {
        const { files, skipped } = await collect((done, total) =>
          setBusy(t("syncHandoff.reading", { done, total })),
        );
        if (files.length === 0) throw new Error(t("syncHandoff.skipped", { count: skipped }));
        setBusy(t("syncHandoff.working"));
        const out = await invoke<HandoffExport>("sync_handoff_export", { projectId, files });
        setResult({ out, skipped });
      } catch (e) {
        setError(t("syncHandoff.failed", { reason: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(null);
      }
    })();
  };

  const openNew = () => {
    if (!projectId) return;
    const spec = newAgentTabForDraft({
      agent: newTabAgent,
      customAgents,
      cwd: project ? resolveProjectDirectory(project) : "",
      projectName: project?.name ?? "",
      t,
    });
    addTabToScope(projectId, spec.tab);
    void queuePromptForTab(projectId, spec.tab.scheduleTargetId, prompt, { preface: spec.preface })
      .then(() => setNote(t("syncHandoff.opened", { agent: agentItemFor(newTabAgent, customAgents).label })))
      .catch((e) => setError(t("syncHandoff.failed", { reason: String(e) })));
  };

  const sendTo = (tab: TabEntry) => {
    if (!projectId || !tab.scheduleTargetId) return;
    queuePromptForTab(projectId, tab.scheduleTargetId, prompt)
      .then(() => setNote(t("syncHandoff.sent", { tab: tab.label })))
      .catch((e) => setError(t("syncHandoff.failed", { reason: String(e) })));
  };

  const copy = () => {
    navigator.clipboard?.writeText(prompt).then(
      () => setNote(t("syncHandoff.copied")),
      () => {},
    );
  };

  return (
    <>
      <button
        type="button"
        className={className ?? "file-viewer-format-btn"}
        onClick={start}
        disabled={!projectId || !connected || !!disabled || busy != null}
        title={connected ? title : t("syncHandoff.offline")}
      >
        {busy ?? label}
      </button>
      {error && !result && (
        <DialogShell onDismiss={() => setError(null)}>
          <h2>{t("syncHandoff.title")}</h2>
          <p className="file-delete-body">{error}</p>
          <div className="file-delete-actions">
            <button type="button" autoFocus onClick={() => setError(null)}>
              {t("common.close")}
            </button>
          </div>
        </DialogShell>
      )}
      {result && (
        <DialogShell onDismiss={() => setResult(null)}>
          <h2>{t("syncHandoff.title")}</h2>
          <p className="file-delete-body">
            {t("syncHandoff.done", { count: result.out.fileCount, dir: result.out.agentDir })}
          </p>
          {result.skipped > 0 && (
            <p className="file-delete-body">{t("syncHandoff.skipped", { count: result.skipped })}</p>
          )}
          <p className="file-delete-body">{t("syncHandoff.where")}</p>
          <textarea
            className="sync-handoff-prompt"
            readOnly
            value={prompt}
            rows={6}
            onFocus={(e) => e.currentTarget.select()}
          />
          {note && <p className="file-delete-body">{note}</p>}
          {error && <p className="file-delete-body">{error}</p>}
          <div className="sync-handoff-actions">
            <button type="button" autoFocus onClick={openNew}>
              {t("syncHandoff.newTab")}
            </button>
            {localTabs.map((tab) => (
              <button type="button" key={tab.key} onClick={() => sendTo(tab)}>
                {t("syncHandoff.sendTo")}: {tab.label}
              </button>
            ))}
            {localTabs.length === 0 && <span className="sync-handoff-none">{t("syncHandoff.noTabs")}</span>}
            <button type="button" onClick={copy}>
              {t("syncHandoff.copyPrompt")}
            </button>
            <button type="button" onClick={() => setResult(null)}>
              {t("common.close")}
            </button>
          </div>
        </DialogShell>
      )}
    </>
  );
}
