import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invokeTrusted } from "../../lib/execTrust";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useDialogs } from "../common/PromptDialogs";
import { openLinkedFile } from "../embed/FileViewerPane";
import { WarningIcon } from "../common/icons/Icon";
import { gitWorktreeArgs, type GitWorktreeSelection } from "../../lib/gitWorktree";
import { ErrorNote } from "../common/ErrorNote";

/** Mirrors `commands::git_pull::PullPreview`. */
interface PullPreview {
  branch: string;
  upstream: string;
  is_current: boolean;
  incoming: string[];
  outgoing: string[];
  files: { path: string; status: string; both: boolean }[];
}

/** Mirrors `commands::git_pull::MergeState`. */
export interface MergeState {
  merging: boolean;
  conflicts: string[];
}

function joinPath(dir: string, rel: string): string {
  return `${dir.replace(/[/\\]+$/, "")}/${rel}`;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : p;
}

function baseOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Open one file of `repoDir` in the `gitmerge` viewer (the shared three-way
 *  compare): the incoming diff, or the conflict resolver mid-merge. */
function openInMergeView(repoDir: string, rel: string) {
  const abs = joinPath(repoDir, rel);
  openLinkedFile(undefined, dirOf(abs), { path: abs, viewer: "gitmerge", label: baseOf(abs) });
}

/**
 * Pull, as fetch → look → apply (`commands::git_pull`). Opening the panel
 * fetches, then shows what the upstream has that `branch` lacks: its commits,
 * the branch's own commits when the two diverged, and every file the upstream
 * touched — each one opens in the merge/diff view. Fast-forward is the default;
 * a diverged checked-out branch offers a merge, which may stop on conflicts
 * that `GitMergeBar` then walks through.
 *
 * `branch` null = the checked-out branch. `canOpenFiles` is false for a remote
 * project: the merge view resolves into this machine's working tree.
 */
export function GitPullPanel({
  projectDir,
  worktree,
  projectId,
  branch,
  canOpenFiles,
  onClose,
  onDone,
}: {
  projectDir: string;
  worktree?: GitWorktreeSelection | null;
  projectId: string | null;
  branch: string | null;
  canOpenFiles: boolean;
  onClose: () => void;
  /** After a pull or merge changed the repo (conflicts may be pending). */
  onDone: () => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<PullPreview | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    setFetchError(null);
    // A failed fetch (offline, auth) still leaves a useful preview against the
    // tracking refs as of the last fetch — say so rather than show nothing.
    try {
      await invoke("git_fetch", { projectDir, ...gitWorktreeArgs(worktree), projectId });
    } catch (e) {
      setFetchError(String(e));
    }
    try {
      setPreview(await invoke<PullPreview>("git_pull_preview", { projectDir, ...gitWorktreeArgs(worktree), branch }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [projectDir, projectId, branch, worktree]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (merge: boolean) => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await invokeTrusted("git_pull_apply", { projectDir, ...gitWorktreeArgs(worktree), branch: preview.branch, merge });
      onDone();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const diverged = !!preview && preview.outgoing.length > 0;
  const upToDate = !!preview && preview.incoming.length === 0;

  return (
    <div className="git-worktree-section git-pull-section">
      <div className="git-worktree-header">
        <span className="git-worktree-title">
          {preview
            ? t("gitPull.title", { branch: preview.branch, upstream: preview.upstream })
            : t("gitPull.titleLoading")}
        </span>
        <UntestedTag id="gitPull.1" />
        <span className="git-worktree-spacer" />
        <button className="toolbar-btn" onClick={() => void load()} disabled={busy} title={t("gitPull.refetchTitle")}>
          ⟳
        </button>
        <button className="toolbar-btn" onClick={onClose} title={t("common.close")}>
          ✕
        </button>
      </div>
      {fetchError && <div className="git-worktree-note git-pull-warn">{t("gitPull.fetchFailed", { error: fetchError })}</div>}
      {error && <ErrorNote className="git-worktree-note git-pull-error" error={error} />}
      {busy && !preview && <div className="git-worktree-note">{t("gitPull.fetching")}</div>}
      {preview && upToDate && <div className="git-worktree-note">{t("gitPull.upToDate")}</div>}
      {preview && !upToDate && (
        <>
          <div className="git-worktree-note">
            {t("gitPull.incomingHeading", { count: preview.incoming.length })}
          </div>
          <ul className="git-pull-list">
            {preview.incoming.map((c) => (
              <li key={c} title={c}>{c}</li>
            ))}
          </ul>
          {diverged && (
            <>
              <div className="git-worktree-note git-pull-warn">
                {t(preview.is_current ? "gitPull.divergedHeading" : "gitPull.divergedNotCurrent", {
                  count: preview.outgoing.length,
                })}
              </div>
              <ul className="git-pull-list">
                {preview.outgoing.map((c) => (
                  <li key={c} title={c}>{c}</li>
                ))}
              </ul>
            </>
          )}
          <div className="git-worktree-note">
            {t("gitPull.filesHeading", { count: preview.files.length })}
            {preview.is_current && canOpenFiles && ` ${t("gitPull.filesHint")}`}
          </div>
          <ul className="git-pull-list git-pull-files">
            {preview.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className="git-pull-file"
                  // The preview compares HEAD with the upstream, so it only
                  // describes the checked-out branch.
                  disabled={!canOpenFiles || !preview.is_current}
                  title={f.both ? t("gitPull.bothTitle", { path: f.path }) : f.path}
                  onClick={() => openInMergeView(worktree?.path || projectDir, f.path)}
                >
                  <span className={`git-pull-status git-pull-status--${f.status}`}>{f.status}</span>
                  <span className="git-pull-path">{f.path}</span>
                  {f.both && <span className="git-pull-both" aria-label={t("gitPull.bothLabel")}><WarningIcon /></span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="git-worktree-form">
            <button
              className="toolbar-btn"
              onClick={() => void apply(false)}
              disabled={busy || diverged}
              title={t(diverged ? "gitPull.ffDisabledTitle" : "gitPull.ffTitle", { upstream: preview.upstream })}
            >
              {t("gitPull.fastForward", { count: preview.incoming.length })}
            </button>
            {diverged && preview.is_current && (
              <button
                className="toolbar-btn"
                onClick={() => void apply(true)}
                disabled={busy}
                title={t("gitPull.mergeTitle", { upstream: preview.upstream })}
              >
                {t("gitPull.merge")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A merge in progress (usually one `GitPullPanel` started and git stopped on
 * conflicts): the unmerged files, each opening the three-way resolver, then
 * Commit once none are left or Abort to go back to before the merge.
 */
export function GitMergeBar({
  projectDir,
  worktree,
  state,
  canOpenFiles,
  onChanged,
}: {
  projectDir: string;
  worktree?: GitWorktreeSelection | null;
  state: MergeState;
  canOpenFiles: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const { confirmAction, dialogs } = useDialogs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (cmd: string, trusted: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await (trusted ? invokeTrusted(cmd, { projectDir, ...gitWorktreeArgs(worktree) }) : invoke(cmd, { projectDir, ...gitWorktreeArgs(worktree) }));
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    const ok = await confirmAction({
      title: t("gitMerge.abortTitle"),
      body: t("gitMerge.abortBody"),
      confirmLabel: t("gitMerge.abort"),
      danger: true,
    });
    if (ok) await run("git_merge_abort", false);
  };

  const open = state.conflicts.length;
  return (
    <div className="git-worktree-section git-pull-section">
      {dialogs}
      <div className="git-worktree-header">
        <span className="git-worktree-title">
          {open > 0 ? t("gitMerge.conflictsTitle", { count: open }) : t("gitMerge.readyTitle")}
        </span>
        <UntestedTag id="gitMerge.1" />
        <span className="git-worktree-spacer" />
        <button className="toolbar-btn" onClick={onChanged} disabled={busy} title={t("common.refresh")}>
          ⟳
        </button>
      </div>
      {open > 0 && (
        <>
          <div className="git-worktree-note">
            {t(canOpenFiles ? "gitMerge.conflictsHint" : "gitMerge.conflictsHintRemote")}
          </div>
          <ul className="git-pull-list git-pull-files">
            {state.conflicts.map((rel) => (
              <li key={rel}>
                <button
                  type="button"
                  className="git-pull-file"
                  disabled={!canOpenFiles}
                  title={rel}
                  onClick={() => openInMergeView(worktree?.path || projectDir, rel)}
                >
                  <span className="git-pull-status git-pull-status--U">U</span>
                  <span className="git-pull-path">{rel}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <ErrorNote className="git-worktree-note git-pull-error" error={error} />}
      <div className="git-worktree-form">
        <button
          className="toolbar-btn"
          onClick={() => void run("git_merge_commit", true)}
          disabled={busy || open > 0}
          title={t(open > 0 ? "gitMerge.commitDisabledTitle" : "gitMerge.commitTitle")}
        >
          {t("gitMerge.commit")}
        </button>
        <button className="toolbar-btn" onClick={() => void abort()} disabled={busy} title={t("gitMerge.abortTitle")}>
          {t("gitMerge.abort")}
        </button>
      </div>
    </div>
  );
}
