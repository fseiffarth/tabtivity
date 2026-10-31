import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  resolveProjectDirectory,
  resolveLocalMirror,
  formatRemoteTarget,
  type ProjectEntry,
} from "../../types";
import { useTimerStore } from "../../stores/timer";
import { useTabsStore } from "../../stores/tabs";
import { useGitDirtyStore, type GitDirtyState } from "../../stores/gitDirty";
import { UntestedTag } from "../common/UntestedTag";
import { projectTypeTags } from "./projectTypeTags";
import { OrbitSpinner } from "../common/OrbitSpinner";
import { useT, type TranslationKey } from "../../lib/i18n";
import { formatWorkedTime } from "../../lib/formatWorkedTime";

const POPUP_GAP = 6;
const POPUP_MARGIN = 8;

type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string;

export function statusLabel(t: Translator, status: string): string {
  if (status === "current") return t("projectHoverCard.statusCurrent");
  if (status === "active") return t("projectHoverCard.statusActive");
  return t("projectHoverCard.statusInactive");
}

export function formatCpu(t: Translator, pct: number): string {
  return pct < 0.1 ? t("projectHoverCard.cpuIdle") : `${pct.toFixed(1)}%`;
}

/** Hover-card line per pending git state. "clean" has none: the card names a
 *  state only when there is something left to add, commit, or push. */
export const GIT_STATE_LABEL_KEY: Record<Exclude<GitDirtyState, "clean">, TranslationKey> = {
  dirty: "pill.gitDirty",
  staged: "pill.gitStaged",
  unpushed: "pill.gitUnpushed",
  broken: "pill.gitBroken",
  unknown: "pill.gitUnknown",
};

export function projectDescription(project: ProjectEntry): string {
  return typeof project.description === "string" ? project.description.trim() : "";
}

/** Turn a raw `origin` URL into a compact, host-first address for display.
 *  Handles HTTPS (`https://github.com/owner/repo.git`), scp-style SSH
 *  (`git@github.com:owner/repo.git`) and `ssh://` forms → `github.com/owner/repo`.
 *  Returns null when there's no URL to show. */
export function formatGitRemote(url?: string): string | null {
  if (!url) return null;
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/\.git$/i, ""); // drop trailing .git
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // drop scheme (https://, ssh://)
  s = s.replace(/^[^@/]+@/, ""); // drop user@ (scp + ssh forms)
  s = s.replace(/:(?=[^/])/, "/"); // scp `host:owner` → `host/owner`
  return s.replace(/\/+$/, "");
}

/** Live per-hover state for a project: the popup anchor position, today's tracked
 *  time, CPU%, and the scaffold-missing flag. Shared by the pill and the right
 *  file-viewer so both surface the identical hover card. `open`/`close` drive it
 *  from the hovering element's bounding rect. */
export function useProjectHoverCard(project: ProjectEntry | undefined) {
  const projectId = project?.id;
  const [popupPos, setPopupPos] = useState<{
    x: number;
    y: number;
    alignment: "center" | "start";
  } | null>(null);
  const [timeToday, setTimeToday] = useState<number | null>(null);
  const [cpu, setCpu] = useState<number | null>(null);
  // Resolved once per hover (cheap local-FS stat, no SFTP).
  const [scaffoldMissing, setScaffoldMissing] = useState(false);
  const timerPaused = useTimerStore((s) => s.paused);
  const timerActiveId = useTimerStore((s) => s.activeProjectId);
  const getProjectSecs = useTimerStore((s) => s.getProjectSecs);
  const isLiveProject = !!projectId && timerActiveId === projectId;

  // Live per-project CPU%: polled only while the hover popup is open. Keyed on
  // the project's PTY ids (the backend resolves them to child PIDs + descendants).
  const fetchCpu = useCallback(async () => {
    if (!projectId) {
      setCpu(null);
      return;
    }
    const tabs = useTabsStore.getState().tabsByScope[projectId] ?? [];
    const ptyIds = tabs.map((t) => t.key);
    if (ptyIds.length === 0) {
      setCpu(null);
      return;
    }
    try {
      setCpu(await invoke<number>("project_cpu_percent", { ptyIds }));
    } catch {
      setCpu(null);
    }
  }, [projectId]);

  useEffect(() => {
    if (!popupPos) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled) void fetchCpu();
    };
    run();
    const id = window.setInterval(run, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [popupPos, fetchCpu]);

  // Resolve the scaffold-missing flag when the hover opens (once — scaffold
  // presence doesn't change under the cursor). Failures fall back to "present".
  useEffect(() => {
    if (!popupPos || !projectId) return;
    let cancelled = false;
    invoke<boolean>("project_scaffold_missing", { projectId })
      .then((v) => {
        if (!cancelled) setScaffoldMissing(v);
      })
      .catch(() => {
        if (!cancelled) setScaffoldMissing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [popupPos, projectId]);

  const open = useCallback(
    async (rect: DOMRect, alignment: "center" | "start" = "center") => {
      if (!projectId) return;
      setPopupPos({
        x: alignment === "start" ? rect.left : rect.left + rect.width / 2,
        y: rect.bottom,
        alignment,
      });
      try {
        if (isLiveProject) {
          setTimeToday(getProjectSecs());
        } else {
          setTimeToday(await invoke<number>("get_time_today", { projectId }));
        }
      } catch {
        setTimeToday(null);
      }
    },
    [isLiveProject, getProjectSecs, projectId],
  );

  const close = useCallback(() => {
    setPopupPos(null);
    setTimeToday(null);
    setCpu(null);
  }, []);

  return { popupPos, timeToday, cpu, scaffoldMissing, isLiveProject, timerPaused, open, close };
}

export type ProjectHoverState = ReturnType<typeof useProjectHoverCard>;

/** The hover popup shown for a project — description, type tags (optional),
 *  paths, git address, pending git state, status, today's time and CPU. Rendered into a portal at
 *  `state.popupPos`; returns null while closed. `showTags` is off in the right
 *  file-viewer, where the type tags already sit beside the project name. */
export function ProjectHoverCard({
  project,
  state,
  showTags = true,
}: {
  project: ProjectEntry;
  state: ProjectHoverState;
  showTags?: boolean;
}) {
  const t = useT();
  const { popupPos, timeToday, cpu, scaffoldMissing, isLiveProject, timerPaused } = state;
  const gitState = useGitDirtyStore((s) => s.byId[project.id]);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Place the card under its anchor (centred or start-aligned), then clamp it
  // horizontally into the window: a pill at the strip's edge must not push the
  // card's left part off-screen (same as TabHoverCard).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!popupPos || !el) {
      setPos(null);
      return;
    }
    const { width } = el.getBoundingClientRect();
    const left = popupPos.alignment === "start" ? popupPos.x : popupPos.x - width / 2;
    const next = {
      left: Math.max(POPUP_MARGIN, Math.min(left, window.innerWidth - POPUP_MARGIN - width)),
      top: popupPos.y + POPUP_GAP,
    };
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, [popupPos, project, timeToday, cpu, scaffoldMissing, gitState, showTags]);
  if (!popupPos) return null;

  const description = projectDescription(project);
  const dir = resolveProjectDirectory(project);
  const localMirror = resolveLocalMirror(project);
  const gitRemote = formatGitRemote(project.git_origin_url);
  const typeTags = showTags ? projectTypeTags(project, scaffoldMissing, t) : [];

  return createPortal(
    <div
      ref={ref}
      className="project-pill-popup"
      style={{
        left: pos?.left ?? popupPos.x,
        top: pos?.top ?? popupPos.y,
        // JS owns the position (clamped), so drop the class's centring transform.
        transform: "none",
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {description && <span className="pill-popup-description">{description}</span>}
      {typeTags.length > 0 && (
        <span className="pill-popup-tags">
          {typeTags.map((t) => (
            <span
              key={t.key}
              className="pill-popup-tag"
              title={t.title}
              style={{ color: t.color, borderColor: t.color, background: `${t.color}22` }}
            >
              {t.label}
            </span>
          ))}
          {typeTags.some((tag) => tag.key === "remoteOnly") && <UntestedTag id="projectType.tagRemoteOnly" />}
        </span>
      )}
      {project.remote ? (
        <>
          <span className="pill-popup-path-row">
            <span className="pill-popup-path-label">{t("projectHoverCard.remoteLabel")}</span>
            <span className="pill-popup-path">{formatRemoteTarget(project.remote)}</span>
          </span>
          {localMirror && (
            <span className="pill-popup-path-row">
              <span className="pill-popup-path-label">{t("projectHoverCard.localLabel")}</span>
              <span className="pill-popup-path">{localMirror}</span>
            </span>
          )}
        </>
      ) : (
        dir && <span className="pill-popup-path">{dir}</span>
      )}
      {gitRemote && (
        <span className="pill-popup-path-row">
          <span className="pill-popup-path-label">{t("projectHoverCard.originLabel")}</span>
          <span className="pill-popup-path">{gitRemote}</span>
        </span>
      )}
      {gitState && gitState !== "clean" && (
        <span className={`pill-popup-git git-${gitState}`}>{t(GIT_STATE_LABEL_KEY[gitState])}</span>
      )}
      {gitState === "unknown" && <UntestedTag id="pill.gitUnknown" />}
      <span className={`pill-popup-status ${project.status === "inactive" ? "inactive" : "active"}`}>
        {statusLabel(t, project.status)}
      </span>
      {timeToday !== null && (
        <span className="pill-popup-time">
          {t("projectHoverCard.todayPrefix")} {formatWorkedTime(t, timeToday)}
          {isLiveProject && timerPaused && ` ${t("projectHoverCard.pausedSuffix")}`}
          {isLiveProject && !timerPaused && <OrbitSpinner />}
        </span>
      )}
      {cpu !== null && <span className="pill-popup-cpu">{t("projectHoverCard.cpuPrefix")} {formatCpu(t, cpu)}</span>}
    </div>,
    document.body,
  );
}
