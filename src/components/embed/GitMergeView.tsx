import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CompareView } from "./CompareView";
import { findTabByKey, useTabsStore } from "../../stores/tabs";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/** Mirrors `commands::git_pull::MergeSides`. */
interface MergeSides {
  mode: "conflict" | "incoming";
  repo: string;
  rel: string;
  left: string;
  right: string;
  left_ref: string;
  right_ref: string;
}

/**
 * The Git pull's merge/diff view — the sync resolver's three-way `CompareView`
 * (see `SyncMergeView`), fed from git instead of mirror ⇄ host. The backend picks
 * conflict sides from the repo, so a restored conflict tab needs only `path`:
 *
 * - **conflict** (the repo is mid-merge and this file is unmerged): ours ⇄ merged
 *   ⇄ theirs. Apply writes the result to the file and stages it — the file is then
 *   resolved, and the Git panel's merge bar can commit once none are left.
 * - **incoming**: the two reviewed commits, read-only. A legacy incoming tab
 *   without reviewed tips reads HEAD ⇄ upstream.
 */
export function GitMergeView({
  path,
  projectId,
  tabKey,
}: {
  path: string;
  projectId: string | null;
  tabKey?: string;
}) {
  const t = useT();
  const tips = useTabsStore((state) => tabKey ? findTabByKey(state, tabKey)?.gitPullTips : undefined);
  const [sides, setSides] = useState<MergeSides | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const load = useCallback(() => {
    setError(null);
    setSides(null);
    let cancelled = false;
    invoke<MergeSides>("git_merge_sides", { path, ...(tips ? { tips } : {}) })
      .then((s) => {
        if (!cancelled) setSides(s);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, tips]);

  useEffect(() => load(), [load]);

  const closeTab = () => {
    if (tabKey) useTabsStore.getState().removeTab(tabKey);
  };

  const apply = (merged: string) => {
    if (!sides || applying) return;
    setApplying(true);
    setError(null);
    (async () => {
      await invoke("write_file_text", { path, content: merged, projectId });
      await invoke("git_add_path", { projectDir: sides.repo, relPath: sides.rel });
    })()
      .then(() => closeTab())
      .catch((e) => {
        setError(String(e));
        setApplying(false);
      });
  };

  if (!sides) {
    return (
      <div style={{ position: "absolute", inset: 0 }}>
        <div className={error ? "file-viewer-error" : "file-viewer-loading"} style={{ padding: "1rem" }}>
          {error ?? t("gitMergeView.loading")}
        </div>
      </div>
    );
  }

  const conflict = sides.mode === "conflict";
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <div
        className="file-viewer-loading"
        style={{
          flex: "0 0 auto",
          padding: "6px 10px",
          fontSize: "11px",
          borderBottom: "1px solid var(--border-color)",
          background: "var(--bg-elevated, rgba(255,255,255,0.04))",
        }}
      >
        {t(conflict ? "gitMergeView.conflictNote" : "gitMergeView.incomingNote", {
          rel: sides.rel,
          upstream: sides.right_ref,
        })}{" "}
        <UntestedTag id="gitMergeView.1" />
      </div>
      {error != null && (
        <div className="file-viewer-error" style={{ padding: "4px 8px", flex: "0 0 auto" }}>{error}</div>
      )}
      <div style={{ flex: "1 1 auto", minHeight: 0, position: "relative" }}>
        <CompareView
          path={path}
          left={{
            text: sides.left,
            title: t(conflict ? "gitMergeView.ours" : "gitMergeView.local", { ref: sides.left_ref }),
          }}
          rightText={sides.right}
          rightTitle={t(conflict ? "gitMergeView.theirs" : "gitMergeView.incoming", { ref: sides.right_ref })}
          applyLabel={applying ? t("gitMergeView.resolving") : t("gitMergeView.resolve")}
          onApply={conflict ? apply : undefined}
          onClose={closeTab}
        />
      </div>
    </div>
  );
}
