import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invokeTrusted } from "../../lib/execTrust";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useDialogs } from "../common/PromptDialogs";
import { openLinkedFile } from "../embed/fileViewer/openLinked";
import { CloseIcon, RefreshIcon, WarningIcon } from "../common/icons/Icon";
import { gitWorktreeArgs, type GitWorktreeSelection } from "../../lib/gitWorktree";
import { ErrorNote } from "../common/ErrorNote";
import { basename, dirname, resolvePath } from "../../lib/paths";

interface PullCheckout {
  site: "local" | "mirror" | "host";
  path: string;
  git_dir: string;
  host: [string, string, string | null, number] | null;
}

/** A successful fetch in a specific checkout, from the selected upstream. */
export interface FetchReceipt {
  checkout: PullCheckout;
  upstream_ref: string | null;
  remote: string | null;
  fetched_at: number;
}

interface PullReview {
  checkout: PullCheckout;
  branch: string;
  checked_out: string | null;
  upstream_ref: string;
  remote: string;
  local_oid: string;
  incoming_oid: string;
}

function matchesFetch(receipt: FetchReceipt | null, review: PullReview): receipt is FetchReceipt {
  return !!receipt?.checkout
    && receipt.checkout.site === review.checkout.site
    && receipt.checkout.path === review.checkout.path
    && receipt.checkout.git_dir === review.checkout.git_dir
    && JSON.stringify(receipt.checkout.host) === JSON.stringify(review.checkout.host)
    && receipt.upstream_ref === review.upstream_ref
    && receipt.remote === review.remote;
}

/** Mirrors `commands::git_pull::PullPreview`. */
interface PullPreview {
  branch: string;
  upstream: string;
  is_current: boolean;
  review?: PullReview;
  incoming: string[];
  outgoing: string[];
  files: { path: string; status: string; both: boolean }[];
}

/** Mirrors `commands::git_pull::MergeState`. */
export interface MergeState {
  merging: boolean;
  conflicts: string[];
  mirror?: boolean;
  path?: string | null;
}

/** Open one file of `repoDir` in the `gitmerge` viewer (the shared three-way
 *  compare): the incoming diff, or the conflict resolver mid-merge. */
function openInMergeView(repoDir: string, rel: string, review?: PullReview) {
  const abs = resolvePath(repoDir, rel);
  openLinkedFile(undefined, dirname(abs), {
    path: abs,
    viewer: "gitmerge",
    label: basename(abs),
    ...(review ? { gitPullTips: { local_oid: review.local_oid, incoming_oid: review.incoming_oid } } : {}),
  });
}

/**
 * Pull, as fetch → look → apply (`commands::git_pull`). Opening the panel
 * fetches, then shows what the upstream has that `branch` lacks: its commits,
 * the branch's own commits when the two diverged, and every file the upstream
 * touched — each one opens in the merge/diff view. Fast-forward is the default;
 * a diverged checked-out branch offers a merge, which may stop on conflicts
 * that `GitMergeBar` then walks through.
 *
 * `branch` null = the checked-out branch. The merge viewer opens files on the
 * local and mirror checkouts.
 */
export function GitPullPanel({
  projectDir,
  worktree,
  projectId,
  branch,
  lastFetches,
  onFetched,
  onClose,
  onDone,
}: {
  projectDir: string;
  worktree?: GitWorktreeSelection | null;
  projectId: string | null;
  branch: string | null;
  lastFetches: () => Iterable<FetchReceipt>;
  onFetched: (receipt: FetchReceipt) => void;
  onClose: () => void;
  /** After a pull or merge changed the repo (conflicts may be pending). */
  onDone: () => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<PullPreview | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<"gitPull.checkoutChanged" | "gitPull.stale" | "gitPull.backendRequired" | null>(null);

  const load = useCallback(async (forceFetch = false) => {
    setBusy(true);
    setPreview(null);
    setError(null);
    setNotice(null);
    setFetchError(null);
    setFetchedAt(null);
    const args = { projectDir, ...gitWorktreeArgs(worktree), branch };
    const readPreview = () => invoke<PullPreview>("git_pull_preview", args);
    try {
      const receipts = Array.from(lastFetches());
      if (!forceFetch && receipts.length > 0) {
        const cached = await readPreview().catch(() => null);
        if (cached?.review) {
          const review = cached.review;
          const prior = receipts.find((receipt) => matchesFetch(receipt, review));
          if (prior) {
            setFetchedAt(prior.fetched_at);
            setPreview(cached);
            return;
          }
        }
      }
      // A fetch can fail while the existing tracking refs still offer a preview.
      let receipt: FetchReceipt | null = null;
      try {
        receipt = await invokeTrusted<FetchReceipt>("git_fetch", { ...args, projectId });
        if (receipt?.checkout) onFetched(receipt);
      } catch (e) {
        setFetchError(String(e));
      }
      const next = await readPreview();
      if (!next.review) {
        setNotice("gitPull.backendRequired");
        return;
      }
      const review = next.review;
      if (matchesFetch(receipt, review)) {
        setFetchedAt(receipt.fetched_at);
      } else if (receipt) {
        setNotice("gitPull.checkoutChanged");
        return;
      } else {
        setFetchedAt(receipts.find((prior) => matchesFetch(prior, review))?.fetched_at ?? null);
      }
      setPreview(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [projectDir, projectId, branch, worktree, lastFetches, onFetched]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (merge: boolean) => {
    if (!preview?.review) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invokeTrusted<{ stale: boolean }>("git_pull_apply", {
        projectDir, ...gitWorktreeArgs(worktree), branch: preview.branch, merge, review: preview.review,
      });
      if (result.stale) {
        setPreview(null);
        setNotice("gitPull.stale");
        return;
      }
      onDone();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkout = preview?.review?.checkout;
  const canOpenFiles = !!checkout && checkout.site !== "host";
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
        <UntestedTag id="gitPull.checkoutReview" />
        <span className="git-worktree-spacer" />
        <button className="toolbar-btn" onClick={() => void load(true)} disabled={busy} title={t("gitPull.refetchTitle")} aria-label={t("gitPull.refetchTitle")}>
          <RefreshIcon />
        </button>
        <button className="toolbar-btn" onClick={onClose} title={t("common.close")}>
          <CloseIcon />
        </button>
      </div>
      {checkout && (
        <div className="git-worktree-note">
          {t(checkout.site === "mirror" ? "gitPull.mirrorCheckout" : checkout.site === "host" ? "gitPull.hostCheckout" : "gitPull.localCheckout", { path: checkout.path })}
        </div>
      )}
      {fetchedAt !== null && <div className="git-worktree-note">{t("gitPull.lastFetch", { time: new Date(fetchedAt * 1000).toLocaleString() })}</div>}
      {notice && <div className="git-worktree-note git-pull-warn">{t(notice)}</div>}
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
            {canOpenFiles && ` ${t("gitPull.filesHint")}`}
          </div>
          <ul className="git-pull-list git-pull-files">
            {preview.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className="git-pull-file"
                  disabled={!canOpenFiles}
                  title={f.both ? t("gitPull.bothTitle", { path: f.path }) : f.path}
                  onClick={() => checkout && openInMergeView(checkout.path, f.path, preview.review)}
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
          <RefreshIcon />
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
                  onClick={() => openInMergeView(state.path || worktree?.path || projectDir, rel)}
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
