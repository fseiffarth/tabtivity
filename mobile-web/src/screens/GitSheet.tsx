import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { getGitOverview, type GitOverview, type GitWorktreeView } from "../api";
import { describeFailure } from "../connection";
import { GitMark } from "../components/GitMark";

/** `↑2 ↓1`, either half only when non-zero; "" when level. */
function track(ahead: number, behind: number): string {
  return [ahead > 0 ? `↑${ahead}` : "", behind > 0 ? `↓${behind}` : ""].filter(Boolean).join(" ");
}

/**
 * The project's git at a glance, read-only (the project screen's name menu,
 * ⎇ Git): the project folder's branch and upstream, the repo's worktrees with
 * the project folder's first, the local branches and the remote ones no local
 * branch stands for. The phone host reads it itself, window open or not, and
 * caches it a few seconds; ↻ and coming back to the app ask again. Nothing
 * here checks out, switches or creates anything.
 */
export function GitSheet({ projectId, label, onClose }: { projectId: string; label: string; onClose: () => void }) {
  const t = useT();
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [outdated, setOutdated] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setError("");
    try {
      const next = await getGitOverview(projectId, controller.signal);
      if (controller.signal.aborted) return;
      if ("outdated" in next) {
        setOutdated(true);
        setOverview(null);
      } else {
        setOutdated(false);
        setOverview(next);
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(describeFailure(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    return () => inFlight.current?.abort();
  }, [load]);

  // No polling: the sheet asks again only when the phone comes back to it.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const head = overview?.head;
  const current = overview?.worktrees.find((row) => row.current);
  const headTrack = head ? track(head.ahead, head.behind) : "";

  const caption = (row: GitWorktreeView) => [
    row.current ? t("mobile.gitSheet.projectFolder") : "",
    row.main ? t("mobile.gitSheet.main") : "",
    row.locked ? t("mobile.gitSheet.locked") : "",
    row.missing ? t("mobile.gitSheet.missing") : "",
  ].filter(Boolean).join(" · ");

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet git-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.gitSheet.title", { label })} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.gitSheet.close")}>✕</button>
        <h2>{t("mobile.gitSheet.title", { label })} {isUntested("mobile.project.gitOverview") && <small>{t("mobile.newTab.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>

      {error && <p className="sheet-note error" role="alert">{t("mobile.gitSheet.failed", { error })}</p>}
      {busy && !overview && !outdated && !error && <p className="sheet-note">{t("mobile.gitSheet.loading")}</p>}
      {outdated && <p className="sheet-note">{t("mobile.gitSheet.hostOld")}</p>}
      {overview && !overview.repo && <p className="sheet-note">{t("mobile.gitSheet.notRepo")}</p>}

      {overview?.repo && head && <div className="git-body">
        <p className="git-head">
          {head.branch
            ? <strong><span aria-hidden="true">⎇ </span>{head.branch}</strong>
            : <strong>{t("mobile.gitSheet.detached", { sha: head.short ?? "?" })}</strong>}
          {headTrack && <span>{headTrack}</span>}
          {head.branch && <span>{head.upstream ?? t("mobile.gitSheet.noUpstream")}</span>}
          {current?.git && <GitMark state={current.git} long />}
        </p>

        {overview.worktrees_total > 1 && <>
          <h3 className="git-section">{t("mobile.gitSheet.worktrees", { count: overview.worktrees_total })}</h3>
          <ul className="git-rows">
            {overview.worktrees.map((row, index) => {
              const above = caption(row);
              return <li key={row.id || `${row.label}-${index}`} className={row.current ? "current" : undefined}>
                {above && <small>{above}</small>}
                <span>
                  {row.current ? label : row.label}
                  {" — "}
                  {row.branch ? <>⎇ {row.branch}</> : t("mobile.gitSheet.detached", { sha: row.short ?? "?" })}
                  {row.git && <GitMark state={row.git} />}
                  {!row.checked && !row.missing && <em className="git-quiet"> · {t("mobile.gitSheet.notChecked")}</em>}
                  {row.tabs > 0 && <em className="git-quiet"> · {row.tabs === 1 ? t("mobile.gitSheet.tabsHereOne") : t("mobile.gitSheet.tabsHere", { count: row.tabs })}</em>}
                </span>
              </li>;
            })}
            {overview.worktrees_total > overview.worktrees.length && <li className="git-more">
              <span>{t("mobile.gitSheet.more", { count: overview.worktrees_total - overview.worktrees.length })}</span>
            </li>}
          </ul>
        </>}

        {overview.branches_total > 0 && <>
          <h3 className="git-section">{t("mobile.gitSheet.branches", { count: overview.branches_total })}</h3>
          <ul className="git-rows">
            {overview.branches.map((branch) => {
              const drift = track(branch.ahead, branch.behind);
              return <li key={branch.name} className={branch.current ? "current" : undefined}>
                {branch.upstream && <small>{branch.upstream}</small>}
                <span>
                  {branch.current && <span aria-hidden="true">● </span>}
                  {branch.name}
                  {branch.worktree && <em className="git-quiet"> · {t("mobile.gitSheet.inWorktree", { name: branch.worktree })}</em>}
                  {drift && <em className="git-quiet"> · {drift}</em>}
                </span>
              </li>;
            })}
            {overview.branches_total > overview.branches.length && <li className="git-more">
              <span>{t("mobile.gitSheet.more", { count: overview.branches_total - overview.branches.length })}</span>
            </li>}
          </ul>
        </>}

        {overview.remote_total > 0 && <details className="git-remote">
          <summary className="git-section">{t("mobile.gitSheet.remoteBranches", { count: overview.remote_total })}</summary>
          <ul className="git-rows">
            {overview.remote_branches.map((name) => <li key={name}><span>{name}</span></li>)}
            {overview.remote_total > overview.remote_branches.length && <li className="git-more">
              <span>{t("mobile.gitSheet.more", { count: overview.remote_total - overview.remote_branches.length })}</span>
            </li>}
          </ul>
        </details>}
      </div>}

      <div className="mobile-schedule-actions">
        <button disabled={busy} onClick={() => void load()}>↻ {t("mobile.gitSheet.refresh")}</button>
        <button className="primary" onClick={onClose}>{t("mobile.gitSheet.done")}</button>
      </div>
    </section>
  </div>;
}
