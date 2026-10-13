import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import type { GitPushMcpLevel as Level, GitPushProposal } from "../../types";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { SettingRow, ToggleRow } from "../layout/settingsUi";

/** The backend's change event (`services::git_push_mcp::CHANGED_EVENT`). */
export const GIT_PUSH_MCP_CHANGED = "git-push-mcp-changed";
const LEVELS = ["off", "propose", "apply"] as const;

/** Per-project level dropdown plus the protected-branch list, in Manage CLIs. */
export function GitPushMcpLevel({ projectId }: { projectId: string }) {
  const t = useT();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const policy = project?.git_push_mcp;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [protectedText, setProtectedText] = useState((policy?.protected ?? []).join(", "));
  useEffect(() => { setProtectedText((policy?.protected ?? []).join(", ")); }, [policy?.protected]);
  const save = (level?: Level, protectedList?: string[]) => {
    setBusy(true);
    void useProjectsStore.getState().setProjectGitPushMcp(projectId, level, protectedList)
      .then(() => setError("")).catch((e) => setError(String(e))).finally(() => setBusy(false));
  };
  return <div className="git-push-mcp-level">
    <Dropdown value={policy?.level ?? "propose"} disabled={busy} title={t("gitPushMcp.level")}
      options={LEVELS.map((value) => ({ value, label: t(`gitPushMcp.${value}`) }))}
      onChange={(value) => save(value as Level)} />
    <input className="git-push-mcp-protected" type="text" value={protectedText} disabled={busy}
      placeholder={t("gitPushMcp.protectedPlaceholder")} title={t("gitPushMcp.protectedTitle")} aria-label={t("gitPushMcp.protectedTitle")}
      onChange={(e) => setProtectedText(e.target.value)}
      onBlur={() => {
        const list = protectedText.split(",").map((s) => s.trim()).filter(Boolean);
        if (list.join(",") !== (policy?.protected ?? []).join(",")) save(undefined, list);
      }} />
    {error && <small role="alert">{error}</small>}
  </div>;
}

/** The off-by-default switch in Manage CLIs and the per-project levels. */
export function GitPushMcpSettings() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.git_push_mcp ?? true);
  const projects = useProjectsStore((s) => s.projects);
  return <>
    <ToggleRow label={<>{t("gitPushMcp.title")} <UntestedTag id="gitPushMcp" /></>} checked={enabled}
      onChange={(e) => void useSettingsStore.getState().updateSettings({ git_push_mcp: e.target.checked })} />
    <p className="settings-help">{t("gitPushMcp.help")}</p>
    {enabled && projects.filter((p) => !p.remote).map((p) => <SettingRow key={p.id} label={p.name} control={<GitPushMcpLevel projectId={p.id} />} />)}
  </>;
}

/** The project's push proposals, re-read on the backend's change event. */
export function useGitPushProposals(projectId: string | null | undefined): GitPushProposal[] {
  const [rows, setRows] = useState<GitPushProposal[]>([]);
  const refresh = useCallback(() => {
    if (!projectId) { setRows([]); return; }
    void invoke<GitPushProposal[]>("git_push_mcp_proposals", { projectId })
      .then((rows) => setRows(Array.isArray(rows) ? rows : [])).catch(() => setRows([]));
  }, [projectId]);
  useEffect(() => {
    refresh();
    let alive = true;
    const stop = listen(GIT_PUSH_MCP_CHANGED, () => { if (alive) refresh(); });
    return () => { alive = false; void stop.then((s) => s()).catch(() => undefined); };
  }, [refresh]);
  return rows;
}

function shortSha(sha: string | null | undefined): string { return sha ? sha.slice(0, 7) : "—"; }

/** The card's status pill. An "Allow CI" card is only ever waiting, allowed,
 *  dismissed or expired; `allowed` is never a push's or a release's. */
function statusLabel(proposal: GitPushProposal): TranslationKey {
  const { kind, status } = proposal;
  if (kind === "ci_repo") {
    return status === "allowed" || status === "dismissed" || status === "expired" ? `gitPushMcp.ciStatus.${status}` : "gitPushMcp.ciStatus.pending";
  }
  const shown = status === "allowed" ? "pushed" : status;
  return kind === "release" ? `gitPushMcp.releaseStatus.${shown}` : `gitPushMcp.status.${shown}`;
}

/** One proposal: what would be pushed, with Push / Dismiss while pending and
 *  the outcome afterwards. Shared by the git bar and the Agents view. */
export function GitPushProposalCard({ proposal, onDecided }: { proposal: GitPushProposal; onDecided?: (next: GitPushProposal) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showOutput, setShowOutput] = useState(false);
  const run = async (command: string, args: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      const next = await invoke<GitPushProposal>(command, { id: proposal.id, ...args });
      onDecided?.(next);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const decide = (approve: boolean) => run("git_push_mcp_decide", { approve });
  const pending = proposal.status === "pending";
  const finished = !pending && proposal.status !== "running";
  const release = proposal.kind === "release";
  const ciRepo = proposal.kind === "ci_repo";
  const output = proposal.output || proposal.preflight_output;
  return <div className="git-push-proposal" data-status={proposal.status} onClick={(event) => event.stopPropagation()}>
    <div className="git-push-proposal-head">
      <span className="agent-schedule-pill">{t(statusLabel(proposal))}</span>
      {ciRepo ? <UntestedTag id="gitPushMcp.ciAllow" /> : <UntestedTag id={release ? "gitRelease" : "gitPushMcp"} />}
      {ciRepo ? <strong>{t("gitPushMcp.ciAllowTitle", { repo: proposal.repo ?? "…" })}</strong> : release ? <>
        <strong>{proposal.tag ?? "…"}</strong>
        <small>{t("gitPushMcp.releaseOn", { branch: proposal.branch ?? "…" })}</small>
        <small className="git-push-proposal-sha">{shortSha(proposal.head)}</small>
      </> : <>
        <strong>{proposal.branch ?? "…"}</strong>
        {proposal.remote && <small>→ {proposal.remote}</small>}
        <small className="git-push-proposal-sha">{shortSha(proposal.remote_sha)} → {shortSha(proposal.head)}</small>
      </>}
    </div>
    {proposal.url && <small className="git-push-proposal-url" title={proposal.url}>{proposal.url}</small>}
    {proposal.needs_url_confirm && pending && <small className="git-push-proposal-confirm">{t("gitPushMcp.confirmUrl")}</small>}
    {ciRepo && pending && <small className="git-push-proposal-confirm">{t("gitPushMcp.ciAllowHelp")}</small>}
    {proposal.note && <p className="git-push-proposal-note">{t("gitPushMcp.note", { note: proposal.note })}</p>}
    {proposal.commits.length > 0 && <ul className="git-push-proposal-commits">
      {proposal.commits.map((line) => <li key={line}><code>{line}</code></li>)}
    </ul>}
    {proposal.diffstat && <small>{proposal.diffstat}</small>}
    {proposal.message && !pending && <p className="git-push-proposal-message">{proposal.message}</p>}
    {output && <>
      <button className="settings-btn sm" type="button" onClick={() => setShowOutput((v) => !v)}>{t(showOutput ? "gitPushMcp.hideOutput" : "gitPushMcp.showOutput")}</button>
      {showOutput && <pre className="git-push-proposal-output">{output}</pre>}
    </>}
    {pending && <div className="git-push-proposal-actions">
      <button className="settings-btn sm primary" disabled={busy} onClick={() => void decide(true)}>{t(ciRepo ? "gitPushMcp.ciAllow" : release ? "gitPushMcp.release" : proposal.needs_url_confirm ? "gitPushMcp.confirmAndPush" : "gitPushMcp.push")}</button>
      <button className="settings-btn sm" disabled={busy} onClick={() => void decide(false)}>{t("gitPushMcp.dismiss")}</button>
    </div>}
    {finished && <div className="git-push-proposal-actions">
      <button className="settings-btn sm" disabled={busy} onClick={() => void run("git_push_mcp_clear", {})}>{t("gitPushMcp.dismiss")}</button>
    </div>}
    {error && <small role="alert">{error}</small>}
  </div>;
}

/** Every proposal of a project that is still worth showing: pending and
 *  running ones, and the last decided ones until they age out or the user
 *  dismisses them. */
export function GitPushProposals({ projectId }: { projectId: string | null | undefined }) {
  const rows = useGitPushProposals(projectId);
  const [overrides, setOverrides] = useState<Record<string, GitPushProposal>>({});
  const shown = rows.map((row) => overrides[row.id] ?? row).filter((row) => !row.cleared && row.status !== "dismissed" && row.status !== "expired");
  if (shown.length === 0) return null;
  return <div className="git-push-proposals">
    {shown.map((row) => <GitPushProposalCard key={row.id} proposal={row} onDecided={(next) => setOverrides((prev) => ({ ...prev, [next.id]: next }))} />)}
  </div>;
}
