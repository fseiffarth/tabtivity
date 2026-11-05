import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CompareView } from "./CompareView";
import { useProjectsStore } from "../../stores/projects";
import { useSyncStore } from "../../stores/remote/sync";
import { useTabsStore } from "../../stores/tabs";
import { resolveProjectDirectory, resolveLocalMirror } from "../../types";
import { relFromAbs } from "../../lib/viewers/fileUtils";
import { useT } from "../../lib/i18n";
import { useSyncSideTimes } from "./useSyncSideTimes";
import { SyncHandoffButton } from "./SyncHandoffButton";
import { UntestedTag } from "../common/UntestedTag";
import { buildHandoffFile } from "../../lib/viewers/syncHandoff";
import { joinRemote } from "../../lib/viewers/syncHandoffCollect";
import { sshOf, useRemoteStatusStore } from "../../stores/remote/remoteStatus";

/**
 * Three-way merge for a diverged (amber) file of a remote project — the PyCharm-
 * style resolve view opened from the orange list. The left column is the local
 * mirror copy, the right column is the current host copy, and the editable
 * middle is the merged result with per-block take-left/right. "Resolve" writes
 * the merged text to the mirror and force-pushes it to the host, so both sides
 * converge and the file clears amber → green.
 *
 * `path` is the mirror-side absolute path (`mirrorRoot/rel`), exactly as the
 * orange list builds it; the host path is derived from the project's
 * `remote_path` and the same rel.
 */
export function SyncMergeView({
  path,
  projectId,
  tabKey,
}: {
  path: string;
  projectId: string | null;
  tabKey?: string;
}) {
  const t = useT();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));

  // Resolve the mirror root the same way FileViewerPane does, so `rel` keys the
  // sync backend exactly like the orange list's own pull/push calls.
  const { rel, hostPath, mirrorRoot, projectDir } = useMemo(() => {
    const projectDir = resolveProjectDirectory(project);
    const mirrorRoot = resolveLocalMirror(project) ?? (projectDir ? `${projectDir}/mirror` : null);
    const r = mirrorRoot ? relFromAbs(mirrorRoot, path) : null;
    const remotePath = project?.remote?.remote_path;
    return {
      rel: r,
      hostPath: r && remotePath ? joinRemote(remotePath, r) : null,
      mirrorRoot,
      projectDir: projectDir || null,
    };
  }, [project, path]);

  const [localText, setLocalText] = useState<string | null>(null);
  const [hostText, setHostText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  // Set when the on-open byte-for-byte test proved the two sides identical and
  // self-resolved the divergence (re-recorded the base, cleared amber → green).
  // The merge UI has nothing to merge in that case — we say so instead.
  const [autoResolved, setAutoResolved] = useState(false);

  // On open, run a byte-for-byte test on the backend (where the bytes live): an
  // amber verdict is size+mtime-based, so a re-save with the same content or a
  // bare `touch` flags a file whose bytes never diverged. `sync_resolve_if_identical`
  // reads both sides, and if they match it re-records the base (no transfer) and
  // returns true — the file clears amber → green with no user action. Only when it
  // returns false (a genuine divergence) do we fall through to the three-way merge.
  useEffect(() => {
    if (!projectId || !rel) return;
    let cancelled = false;
    invoke<boolean>("sync_resolve_if_identical", { projectId, relPath: rel })
      .then((resolved) => {
        if (cancelled || !resolved) return;
        setAutoResolved(true);
        void useSyncStore.getState().refreshStatus(projectId);
      })
      .catch(() => {
        // Best-effort: a cold pool / read error just leaves the merge viewer to
        // handle the divergence the ordinary way.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, rel]);

  // Load both sides: the mirror over the local fs, the host over SFTP (both via
  // `read_file_text`, which routes by whether the path is under the mirror).
  useEffect(() => {
    if (!hostPath) {
      setError(t("syncMergeView.notMirrorFile"));
      return;
    }
    let cancelled = false;
    setError(null);
    setLocalText(null);
    setHostText(null);
    Promise.all([
      invoke<string>("read_file_text", { path, projectId }).catch(() => ""),
      invoke<string>("read_file_text", { path: hostPath, projectId }),
    ])
      .then(([local, host]) => {
        if (cancelled) return;
        setLocalText(local);
        setHostText(host);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, hostPath, projectId, t]);

  // Per-side modified times + per-change blame times (which side is newer).
  const sideTimes = useSyncSideTimes({ projectId, rel, mirrorRoot, projectDir, localText, hostText });

  const connected = useRemoteStatusStore((s) => (projectId ? sshOf(s, projectId) === "connected" : false));
  // A resolved file the agent wrote, handed to the Result column (never saved).
  const [loadResult, setLoadResult] = useState<{ text: string; nonce: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const loadResolved = () => {
    if (!projectId || !rel) return;
    setNote(null);
    invoke<{ id: string; text: string } | null>("sync_handoff_load_resolved", { projectId, relPath: rel })
      .then((r) => {
        if (!r) {
          setNote(t("syncHandoff.noneYet"));
          return;
        }
        setLoadResult({ text: r.text, nonce: Date.now() });
        setNote(t("syncHandoff.loadedNote"));
      })
      .catch((e) => setNote(String(e)));
  };

  const closeTab = () => {
    if (tabKey) useTabsStore.getState().removeTab(tabKey);
  };

  const apply = (merged: string) => {
    if (!projectId || !rel || applying) return;
    setApplying(true);
    setError(null);
    // Write the merged result to the mirror, then force-push it to the host so
    // both sides converge (the file clears amber). `push` refreshes sync status.
    (async () => {
      await invoke("write_file_text", { path, content: merged, projectId });
      const r = await useSyncStore.getState().push(projectId, rel, true);
      // A push that transferred nothing means the host still holds the old
      // bytes — closing the tab would present the merge as resolved when only
      // the mirror half landed. Refuse to close and surface why.
      if (r.pushed === 0) throw new Error(r.first_error ?? t("syncMerge.applyNothingPushed"));
    })()
      .then(() => closeTab())
      .catch((e) => {
        setError(String(e));
        setApplying(false);
      });
  };

  const loaded = localText != null && hostText != null;
  // Divergence is judged on size+mtime vs the recorded base, never content, so an
  // amber file can hold byte-identical sides (re-saved same content, touched, or a
  // stale base). The authoritative signal is `autoResolved` — the backend's
  // byte-for-byte test, which already cleared the amber marker. `identical` (a text
  // compare) is the fallback for display before that test returns or if the pool is
  // cold; either way, say so explicitly, else the empty diff reads as a broken viewer.
  const identical = autoResolved || (loaded && localText === hostText);

  if (error != null && !loaded) {
    return (
      <div style={{ position: "absolute", inset: 0 }}>
        <div className="file-viewer-error" style={{ padding: "1rem" }}>{error}</div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div style={{ position: "absolute", inset: 0 }}>
        <div className="file-viewer-loading" style={{ padding: "1rem" }}>{t("syncMergeView.loadingBothSides")}</div>
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      {error != null && (
        <div className="file-viewer-error" style={{ padding: "4px 8px", flex: "0 0 auto" }}>{error}</div>
      )}
      {note != null && (
        <div className="file-viewer-loading" style={{ flex: "0 0 auto", padding: "4px 10px", fontSize: "11px" }}>
          {note}
        </div>
      )}
      {identical && (
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
          {t("syncMergeView.identicalPre")}<strong>{t("syncMergeView.identicalStrong")}</strong>{t("syncMergeView.identicalPost")}{" "}
          {autoResolved
            ? t("syncMergeView.autoResolvedNote")
            : t("syncMergeView.manualResolveNote")}
        </div>
      )}
      <div style={{ flex: "1 1 auto", minHeight: 0, position: "relative" }}>
        <CompareView
          path={path}
          left={{ text: localText, title: t("syncMergeView.localMirror") }}
          rightText={hostText}
          rightTitle={t("syncMergeView.remoteHost")}
          applyLabel={applying ? t("syncMergeView.resolving") : t("syncMergeView.resolve")}
          onApply={apply}
          onClose={closeTab}
          sideTimes={sideTimes ?? undefined}
          loadResult={loadResult}
          barExtra={
            <>
              <button
                className="file-viewer-format-btn"
                onClick={loadResolved}
                title={t("syncHandoff.loadResolvedTitle")}
              >
                {t("syncHandoff.loadResolved")}
              </button>
              <SyncHandoffButton
                projectId={projectId}
                connected={connected}
                label={t("syncHandoff.button")}
                title={t("syncHandoff.buttonTitle")}
                collect={async () => ({
                  files: rel ? [buildHandoffFile({ relPath: rel, localText: localText ?? "", remoteText: hostText ?? "", times: sideTimes })] : [],
                  skipped: 0,
                })}
              />
              <UntestedTag id="syncHandoff.resolver" />
            </>
          }
        />
      </div>
    </div>
  );
}
