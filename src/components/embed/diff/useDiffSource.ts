import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReadonlyFile } from "../fileViewer/editableFile";
import { localMirrorRootFor } from "../fileViewer/ViewerHeader";
import { useProjectsStore } from "../../../stores/projects";
import { useRemoteStatusStore } from "../../../stores/remote/remoteStatus";
import { resolveProjectDirectory } from "../../../types";
import { relFromAbs } from "../../../lib/viewers/fileUtils";
import { isNotARepoError } from "../../../lib/viewers/diffBudget";
import { usePaneVisible } from "../../../lib/files/fileAccess";
import { basename, dirname } from "../../../lib/paths";

/** True when `path` is a literal diff/patch file (read its raw content) rather
 *  than a source path (compute the diff via the backend). */
export function isPatchFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".diff") || lower.endsWith(".patch");
}

export type DiffSourceStatus =
  /** Waiting for the file, or for the backend's answer. */
  | "loading"
  /** `text` is the diff (an empty string is "no changes"). */
  | "ready"
  /** The request failed; `error` says why. */
  | "error"
  /** The file is not under git. */
  | "notRepo"
  /** A remote project whose connection is down: nothing is asked of it. */
  | "blocked";

export interface DiffSource {
  patchMode: boolean;
  /** Whole-file view in effect (a git diff over the file as it is on disk). */
  whole: boolean;
  status: DiffSourceStatus;
  /** The unified diff text, when `status` is "ready". */
  text: string | null;
  /** The file text the diff was taken against (whole-file view only). */
  against: string | null;
  error: string | null;
  /** The label of the one file a git diff is about. */
  relPath: string;
  /** Ask again (a git/sync diff) or re-read (a patch file). */
  refresh: () => void;
  /** Refresh makes sense: the diff comes from git or the host, or a patch
   *  file could not be read. */
  canRefresh: boolean;
}

/**
 * Where the diff viewer's text comes from, and in what state it is.
 *
 * - A `.diff`/`.patch` file: its own content, re-read when it changes on disk.
 * - A git diff (`git_diff_file`): asked once per target, and again whenever
 *   the file is edited while open; the Whole file view asks against each
 *   re-read, keeping the text every answer was taken against.
 * - A sync diff (`sync_diff`): the local mirror against the host.
 *
 * Every answer is stored with the target it was asked for, so a late reply
 * for the file a tab was just retargeted away from is never shown under the
 * new one. A remote project's git/host requests wait for its connection, and
 * every request waits for the pane to be on screen at least once.
 */
export function useDiffSource({
  path,
  projectId,
  mode,
  wantWhole,
}: {
  path: string;
  projectId: string | null;
  mode: "git" | "sync";
  wantWhole: boolean;
}): DiffSource {
  const patchMode = isPatchFile(path);

  // The file itself: a patch's content, and what the Whole file view lays the
  // diff over. It also polls the disk (visible panes only) — its changes drive
  // the follow-edits refresh below.
  const fileState = useReadonlyFile(path);
  const reloadFile = fileState.reload;
  // A file that cannot be read (deleted, binary, too big) cannot be laid out
  // whole: show the changes alone instead of an error that hides them.
  const whole = mode === "git" && !patchMode && wantWhole && fileState.error == null;

  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const projectDir = resolveProjectDirectory(project);
  // A file outside the project (or no project — the root console) asks git
  // from its own folder.
  const inProject = relFromAbs(projectDir, path);
  const gitDir = inProject ? projectDir : dirname(path);
  // A sync diff is keyed by the path under the local mirror, not the project.
  const mirrorRoot = localMirrorRootFor(project);
  const syncRel = mirrorRoot ? relFromAbs(mirrorRoot, path) : null;
  const relPath = mode === "sync" ? (syncRel ?? basename(path)) : inProject || basename(path);

  // Connection gate: a git or host request against a dead session can freeze
  // the window, so a remote project asks nothing until it is connected.
  const ssh = useRemoteStatusStore((s) => (projectId ? s.byProject[projectId]?.ssh : undefined));
  const remoteInvolved = !!project?.remote && (mode === "sync" || !!inProject);
  const blocked = !patchMode && remoteInvolved && ssh !== "connected";

  // Hidden panes stay mounted: the first request waits until the pane has been
  // shown once. Later changes are caught up by the file poll, which stops while
  // hidden and checks at once when shown.
  const visible = usePaneVisible();
  const [woken, setWoken] = useState(visible);
  useEffect(() => {
    if (visible) setWoken(true);
  }, [visible]);

  const against = whole ? fileState.content : null;
  const target = JSON.stringify([mode, projectId, gitDir, relPath]);
  const [result, setResult] = useState<{ target: string; text: string; against: string | null } | null>(null);
  const [failure, setFailure] = useState<{ target: string; message: string } | null>(null);
  const [tick, setTick] = useState(0);

  // Follow edits in the Changes view too: a re-read that differs from the one
  // before asks again. (The Whole file view already re-asks on `against`.)
  const prevContent = useRef<string | null>(null);
  useEffect(() => {
    const c = fileState.content;
    const before = prevContent.current;
    prevContent.current = c;
    if (patchMode || whole || c == null || before == null || before === c) return;
    setTick((n) => n + 1);
  }, [fileState.content, patchMode, whole]);

  useEffect(() => {
    if (patchMode || blocked || !woken || (whole && against == null)) return;
    let cancelled = false;
    const req =
      mode === "sync"
        ? invoke<string>("sync_diff", { projectId, relPath })
        : invoke<string>("git_diff_file", { projectDir: gitDir, relPath });
    req
      .then((text) => {
        if (cancelled) return;
        setResult({ target, text, against });
        setFailure(null);
      })
      .catch((e) => {
        if (!cancelled) setFailure({ target, message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [patchMode, blocked, woken, whole, mode, projectId, gitDir, relPath, against, target, tick]);

  const refresh = useCallback(() => {
    reloadFile();
    if (patchMode) return;
    setResult(null);
    setFailure(null);
    setTick((n) => n + 1);
  }, [patchMode, reloadFile]);

  const canRefresh = !patchMode || fileState.error != null;
  const mine = result && result.target === target ? result : null;
  const failed = failure && failure.target === target ? failure : null;

  const base = { patchMode, whole, relPath, refresh, canRefresh };
  if (patchMode) {
    if (fileState.error != null) {
      return { ...base, status: "error", text: null, against: null, error: fileState.error };
    }
    if (fileState.content != null) {
      return { ...base, status: "ready", text: fileState.content, against: null, error: null };
    }
    return { ...base, status: "loading", text: null, against: null, error: null };
  }
  if (blocked) return { ...base, status: "blocked", text: null, against: null, error: null };
  // A shown answer stays through a failed re-ask (a git lock mid-edit): the
  // next successful one replaces it. The Whole file view needs the pair.
  if (mine && (!whole || mine.against != null)) {
    return { ...base, status: "ready", text: mine.text, against: mine.against, error: null };
  }
  if (failed) {
    return isNotARepoError(failed.message)
      ? { ...base, status: "notRepo", text: null, against: null, error: failed.message }
      : { ...base, status: "error", text: null, against: null, error: failed.message };
  }
  return { ...base, status: "loading", text: null, against: null, error: null };
}
