import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectFilesView } from "../files/ProjectFilesView";
import { useFileSource } from "../files/ProjectFilesPane";
import { openProjectFilesTab } from "../files/ProjectFilesTab";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import {
  ROOT_SCOPE,
  useTabsStore,
  orderedTabKeys,
  isPtyTabKind,
  type TabEntry,
} from "../../stores/tabs";
import { useShallow } from "zustand/react/shallow";
import { useActivityStore, type AttentionKind, type BusyKind } from "../../stores/activity";
import { resolveProjectDirectory, type FilesPanelView } from "../../types";
import { useT } from "../../lib/i18n";
import { RailSwitchSideIcon } from "../common/EdgeRailIcons";
import { sidePanelViewKey, sidePanelViewPatch } from "../../lib/projects/sidePanelView";
import { terminalCharsPerSecond } from "../../dev/terminalOutputRate";
import {
  RENDERER_CEILING_MB,
  ensureOwnRendererPid,
  formatRssKib,
  readRendererRss,
  rendererName,
  type RendererRss,
} from "../../lib/window/rendererWatchdog";
// Single source of truth for the displayed version: package.json is kept in
// lockstep with the Tauri manifests on each version bump.
import { version as APP_VERSION } from "../../../package.json";
import { PinIcon, UndoIcon } from "../common/icons/Icon";

interface Props {
  open: boolean;
  pinned?: boolean;
  /** Which edge the panel docks against; drives the mirrored slide/border/resize
   *  layout via the `.left` class. Defaults to "right". */
  side?: "left" | "right";
  /** Current panel width in px (driven by the left-border resize drag). */
  width?: number;
  /** True while a resize drag is in progress — suppresses width/transform
   *  transitions so the panel tracks the cursor instead of lagging behind. */
  resizing?: boolean;
  onResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResizeMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResizeEnd?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTogglePin?: () => void;
  onToggleSide?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

/** The hidden-pane statuses: the tab ring's four words. */
type HiddenStatus = "working" | "needs-decision" | "finished" | "interrupted";

/** A hidden subwindow's tab is invisible to the tab bar, so it can't paint its
 *  own glow — this is the same working/needs-decision/finished/interrupted precedence
 *  `TabBar` uses for the live tab glow, applied here to a hidden group's tab
 *  chips (and rolled up for the group's row) so a hidden pane doesn't go dark
 *  just because it's parked. */
function hiddenTabStatus(
  kind: TabEntry["kind"] | undefined,
  ptyId: string,
  busyByTab: Record<string, boolean>,
  attentionByTab: Record<string, AttentionKind>,
): HiddenStatus | null {
  if (!kind) return null;
  if (isPtyTabKind(kind) && busyByTab[ptyId]) return "working";
  if (kind === "agent" || kind === "local_agent") {
    const attn = attentionByTab[ptyId];
    if (attn === "decision") return "needs-decision";
    if (attn === "done") return "finished";
    if (attn === "interrupted") return "interrupted";
  }
  return null;
}

/** Roll several tab statuses up into one, most urgent first — a decision still
 *  waiting on the user outranks a tab merely working, which outranks one that's
 *  just finished unseen, which outranks one the user cut off. Mirrors `attentionByScope`'s decision-over-done
 *  precedence, extended with `working` for the row-level dot. */
function rollUpStatus(
  statuses: Array<HiddenStatus | null>,
): HiddenStatus | null {
  if (statuses.includes("needs-decision")) return "needs-decision";
  if (statuses.includes("working")) return "working";
  if (statuses.includes("finished")) return "finished";
  if (statuses.includes("interrupted")) return "interrupted";
  return null;
}

/** Debug-only, scope-local raw terminal transport rate. A fixed repaint tick
 * keeps terminal chunks off React's render path; the hot listener only bumps
 * counters in `dev/terminalOutputRate`. */
function TerminalOutputRate({ ptyIds }: { ptyIds: readonly string[] }) {
  const t = useT();
  const [rate, setRate] = useState(() => terminalCharsPerSecond(ptyIds));

  useEffect(() => {
    const update = () => setRate(terminalCharsPerSecond(ptyIds));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [ptyIds]);

  return (
    <span
      className="terminal-output-rate"
      title={t("sidePanel.ttyRateTitle")}
    >
      TTY {rate.toLocaleString()} chars/s
    </span>
  );
}

/** Debug-only: every Tabtivity window's webview renderer and its resident size —
 * the number the memory watchdog reloads a window on, shown where the TTY meter
 * already is. Per window because that is the unit that leaks and the unit that
 * reloads: a 4.7 GB popout is invisible from the main window otherwise, and it
 * was (2026-09-01). Turns amber past half the ceiling. */
function RendererRssDisplay() {
  const t = useT();
  const [rows, setRows] = useState<RendererRss[]>([]);

  useEffect(() => {
    let live = true;
    const update = async () => {
      const next = await readRendererRss();
      if (live) setRows(next);
    };
    // Make sure this window has claimed its own renderer, so the row reads
    // "main", not "pid 3715771" (each popout claims its own via its watchdog).
    void ensureOwnRendererPid().then(update);
    void update();
    const timer = window.setInterval(() => void update(), 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  if (rows.length === 0) return null;
  const hot = rows.some((r) => r.rss_kib / 1024 >= RENDERER_CEILING_MB / 2);
  return (
    <span
      className={hot ? "renderer-rss hot" : "renderer-rss"}
      title={t("sidePanel.rendererRssTitle")}
    >
      RSS {rows.map((r) => `${rendererName(r)} ${formatRssKib(r.rss_kib)}`).join(" · ")}
    </span>
  );
}

/**
 * The file-tree overlay panel. Its file *viewer* — the view switcher, git bar +
 * history, search, apps, orange list, type tags, source switch and settings — is
 * the shared `ProjectFilesView`, the same component the Files (Project) tab
 * renders, so the two can never drift. This host owns only what is panel-specific:
 * the active-project identity it forwards, the browsed-folder in the projects
 * store, and the three window-chrome fragments (pin, resize border, the "Hidden
 * subwindows" list) it injects as slots — none of which a tab has.
 */
export function SidePanel({
  open,
  pinned,
  side = "right",
  width,
  resizing,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onTogglePin,
  onToggleSide,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  const t = useT();
  // The commit the running binary was compiled from — not the frontend's,
  // which hot-reloads past it. Fixed for the process, so read once.
  const [buildCommit, setBuildCommit] = useState<string | null>(null);
  useEffect(() => {
    Promise.resolve(invoke<string | null>("app_build_commit"))
      .then((commit) => setBuildCommit(commit ?? null))
      .catch(() => {});
  }, []);
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  const sidePanelFolderByProject = useProjectsStore((s) => s.sidePanelFolderByProject);
  const setSidePanelFolder = useProjectsStore((s) => s.setSidePanelFolder);
  const rootDir = useProjectsStore((s) => s.rootDir);

  // When a box scope is open, the shared view shows a multi-root file view. It
  // derives that from the current tab scope, which the panel forwards.
  const scope = useTabsStore((s) => s.scope);

  const activeProject = projects.find((p) => p.id === activeId) ?? null;
  // The root scope gets the same panel, rooted at `~/tabtivity/root` — the app's
  // unfiled/scratch area, for data that is only being looked at or has no project
  // to belong to yet. Deliberately keyed off the SCOPE and not merely "no active
  // project": a box scope also has none, and its multi-root view must keep its
  // own empty `projectDir`.
  const isRootScope = !activeProject && scope === ROOT_SCOPE;
  const projectDir = isRootScope ? rootDir ?? "" : resolveProjectDirectory(activeProject);
  // SSH-sync Phase 1: which side of a remote project the files view shows — the
  // host (remote, SFTP-listed, with the sync overlay) or the local mirror.
  const [fileSource, setFileSource] = useFileSource(activeId, !!activeProject?.remote);
  // The browsed folder is kept per scope, the root's under the scope's own name
  // (project ids are UUIDs, so it can't collide with one). Unlike a project's, it
  // is session-only: `setSidePanelFolder` persists through the owning project's
  // `project.json`, and the root folder has none.
  const folderKey = activeId ?? (isRootScope ? ROOT_SCOPE : null);
  const sidePanelFolder = folderKey ? sidePanelFolderByProject[folderKey] ?? "" : "";
  // Subwindows the user has hidden in the current scope, surfaced as an
  // auto-pinned section above the toolbar. Their tabs still live in
  // `tabsByScope[scope]` (PTYs mounted, hidden), so the chips resolve labels
  // from there. `unhideGroup`/`closeHiddenGroup` restore or discard them.
  const hiddenGroups = useTabsStore((s) => s.hiddenGroupsByScope[s.scope]);
  const scopeTabs = useTabsStore((s) => s.tabsByScope[s.scope]);
  const scopePtyIds = useMemo(
    () =>
      (scopeTabs ?? [])
        .filter((tab) => isPtyTabKind(tab.kind))
        .map((tab) => `${scope}:${tab.key}`),
    [scope, scopeTabs],
  );
  // Same working/decision/finished glow the tab bar draws for a live tab — a
  // hidden subwindow's tabs are still running underneath the pane, so they keep
  // reporting status even while parked.
  //
  // Subscribed to the HIDDEN tabs' entries only, flattened to primitives so a
  // shallow compare can hold: the whole `busyByTab` / `attentionByTab` maps
  // move on every agent's every turn edge, in every project, and each move
  // re-rendered this panel — and the entire file view under it — for the sake
  // of a section that is usually not even there.
  const hiddenPtyIds = useMemo(
    () =>
      (hiddenGroups ?? []).flatMap((h) => orderedTabKeys(h.subtree).map((k) => `${scope}:${k}`)),
    [hiddenGroups, scope],
  );
  const hiddenActivity = useActivityStore(
    useShallow((s) =>
      hiddenPtyIds.flatMap((id) => [
        s.busyByTab[id] ?? false,
        s.busyKindByTab[id] ?? "",
        s.attentionByTab[id] ?? "",
      ]),
    ),
  );
  const { busyByTab, busyKindByTab, attentionByTab } = useMemo(() => {
    const busy: Record<string, boolean> = {};
    const kind: Record<string, BusyKind> = {};
    const attention: Record<string, AttentionKind> = {};
    hiddenPtyIds.forEach((id, i) => {
      const [b, k, a] = hiddenActivity.slice(i * 3, i * 3 + 3);
      if (b) busy[id] = true;
      if (k) kind[id] = k as BusyKind;
      if (a) attention[id] = a as AttentionKind;
    });
    return { busyByTab: busy, busyKindByTab: kind, attentionByTab: attention };
  }, [hiddenPtyIds, hiddenActivity]);
  // One status per hidden group's tab, rolled up per group and overall, so the
  // Hidden section still says "something's running in there" without needing
  // the group unhidden and its tab bar drawn.
  const hiddenStatus = useMemo(() => {
    const rows = (hiddenGroups ?? []).map((h) => {
      const tabStatuses = orderedTabKeys(h.subtree).map((k) =>
        hiddenTabStatus(
          scopeTabs?.find((t) => t.key === k)?.kind,
          `${scope}:${k}`,
          busyByTab,
          attentionByTab,
        ),
      );
      return { id: h.id, status: rollUpStatus(tabStatuses), tabStatuses };
    });
    return { rows, overall: rollUpStatus(rows.map((r) => r.status)) };
  }, [hiddenGroups, scopeTabs, scope, busyByTab, attentionByTab]);
  const unhideGroup = useTabsStore((s) => s.unhideGroup);
  const closeHiddenGroup = useTabsStore((s) => s.closeHiddenGroup);
  const [hiddenCollapsed, setHiddenCollapsed] = useState(false);

  // Which view of the shared viewer the panel is on. Kept in settings rather
  // than in the viewer's own state because both things that reset it are
  // remounts this component cannot see through: a project switch (the `key`
  // below) and a relaunch. Stored per scope — the same key the panel remounts on
  // — because Git on one project and Files on another is the normal case, and one
  // global view made every switch re-pick. A scope with no entry yet falls back to
  // the last view chosen anywhere, then to Files (a fresh install, or a
  // settings.json from before either key existed).
  const viewByScope = useSettingsStore((s) => s.settings?.side_panel_view_by_project);
  const lastPanelView = useSettingsStore((s) => s.settings?.side_panel_view ?? "files");
  const viewKey = sidePanelViewKey(activeId ?? null, scope);
  const panelView = viewByScope?.[viewKey] ?? lastPanelView;
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // A side switch is a jump, not a slide. The closed panel rests one panel-width
  // past its edge and eases its transform on open and close; flipping `side`
  // changes that resting point from +100% to -100%, and the same easing carried
  // the panel — contents and all — across the whole window on its way to the
  // other edge. `settled` lags `side` by one frame, and while the two differ the
  // panel wears `switching`, which turns the transition off for exactly the
  // render that moves it. Render-derived (no ref written during render): the
  // class is on the first frame at the new edge, and off again the frame after.
  const [settledSide, setSettledSide] = useState(side);
  const switching = settledSide !== side;
  useEffect(() => {
    if (settledSide === side) return;
    const id = window.requestAnimationFrame(() => setSettledSide(side));
    return () => window.cancelAnimationFrame(id);
  }, [side, settledSide]);

  // Drag the left border to resize the panel; width persists in settings.
  // Pointer capture (set in onResizeStart) keeps the drag alive once the cursor
  // leaves this thin strip.
  const resizeHandle = onResizeStart ? (
    <div
      className="side-panel-resize"
      onPointerDown={onResizeStart}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
      title={t("sidePanel.resizeTitle")}
      aria-hidden
    />
  ) : null;

  // The panel header's left-edge chrome: a side-flip toggle and the pin. Both ride
  // the single `pin` slot ProjectFilesView exposes (a tab passes neither), so no
  // extra slot is threaded through the shared viewer.
  const chrome =
    onTogglePin || onToggleSide ? (
      <>
        {onToggleSide && (
          <button
            className="side-panel-pin side-panel-flip"
            onClick={onToggleSide}
            title={t(side === "left" ? "sidePanel.moveRight" : "sidePanel.moveLeft")}
            aria-label={t(side === "left" ? "sidePanel.moveRight" : "sidePanel.moveLeft")}
          >
            {/* The same picture the closed panel's rail shows for this: the panel
                on the edge it is on, an arrow at the edge it goes to. */}
            <RailSwitchSideIcon side={side} />
          </button>
        )}
        {onTogglePin && (
          <button
            className={`side-panel-pin${pinned ? " pinned" : ""}`}
            aria-pressed={pinned}
            onClick={onTogglePin}
            title={t(pinned ? "sidePanel.unpinTitle" : "sidePanel.pinTitle")}
          >
            <PinIcon />
          </button>
        )}
      </>
    ) : null;

  const hidden =
    hiddenGroups && hiddenGroups.length > 0 ? (
      <div className="hidden-subwindows">
        <button
          type="button"
          className="hidden-sw-header"
          onClick={() => setHiddenCollapsed((c) => !c)}
          title={t(hiddenCollapsed ? "sidePanel.showHidden" : "sidePanel.collapse")}
        >
          <span className="hidden-sw-caret">{hiddenCollapsed ? "▸" : "▾"}</span>
          {t("sidePanel.hiddenCount", { count: hiddenGroups.length })}
          {hiddenStatus.overall && (
            <span
              className={`hidden-sw-status-dot ${hiddenStatus.overall}`}
              title={t(
                hiddenStatus.overall === "needs-decision"
                  ? "sidePanel.hiddenWaiting"
                  : hiddenStatus.overall === "working"
                    ? "sidePanel.hiddenWorking"
                    : hiddenStatus.overall === "interrupted"
                      ? "sidePanel.hiddenInterrupted"
                      : "sidePanel.hiddenFinished",
              )}
            />
          )}
        </button>
        {!hiddenCollapsed && (
          <div className="hidden-sw-list">
            {hiddenGroups.map((h, hi) => {
              const keys = orderedTabKeys(h.subtree);
              const { status: rowStatus, tabStatuses } = hiddenStatus.rows[hi];
              return (
                <div key={h.id} className="hidden-sw-row">
                  <span className={`hidden-sw-icon${rowStatus ? ` ${rowStatus}` : ""}`}>⊞</span>
                  <div className="hidden-sw-chips">
                    {keys.map((k, ki) => {
                      const label = scopeTabs?.find((t) => t.key === k)?.label ?? k;
                      const status = tabStatuses[ki];
                      // A chip has one border, so it says the same thing the
                      // pill's bars do: the shell colour when a COMMAND is all
                      // the tab is running (`BusyKind` "shell"), the agent's
                      // otherwise — a tab doing both is drawn as the agent.
                      const shell =
                        status === "working" && busyKindByTab[`${scope}:${k}`] === "shell";
                      return (
                        <button
                          key={k}
                          type="button"
                          className={`hidden-sw-chip${status ? ` ${status}` : ""}${shell ? " shell" : ""}`}
                          title={t("sidePanel.restoreFocusedOn", { label })}
                          onClick={() => unhideGroup(h.id, { activeKey: k })}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="hidden-sw-btn"
                    title={t("sidePanel.restoreSubwindow")}
                    onClick={() => unhideGroup(h.id)}
                  >
                    <UndoIcon />
                  </button>
                  <button
                    type="button"
                    className="hidden-sw-btn hidden-sw-close"
                    title={t("sidePanel.closeSubwindow")}
                    onClick={() => closeHiddenGroup(h.id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    ) : null;

  const versionFooter = (
    <div className="side-panel-frame-footer">
      {import.meta.env.DEV && (
        <>
          <TerminalOutputRate ptyIds={scopePtyIds} />
          <RendererRssDisplay />
          <span className="debug-badge">DEBUG</span>
        </>
      )}
      <span className="app-version-label">
        v{APP_VERSION}
        {buildCommit && <span className="app-version-commit"> · {buildCommit}</span>}
      </span>
    </div>
  );

  return (
    <ProjectFilesView
      // The panel is one long-lived instance across every project switch, so
      // without this key the viewer's project-specific state (git status and a
      // half-typed commit message, the detected nested repo root, the session
      // rows, the tree's entries) carried into the next project — a path from
      // one project resolved against another's root. Identity is the project,
      // so a switch is a remount. With no project it is the scope — root and a
      // box are two different roots (`~/tabtivity/root` and a multi-root view), and
      // one shared key would have carried the tree between them.
      key={activeId ?? scope}
      scope={scope}
      projectId={activeId ?? null}
      project={activeProject}
      projectDir={projectDir}
      folder={sidePanelFolder}
      onFolderChange={(folder) => {
        if (folderKey) setSidePanelFolder(folderKey, folder);
      }}
      source={fileSource}
      setSource={setFileSource}
      // A closed panel runs no probes and keeps no tree mounted (and so no
      // fs-watch).
      active={open}
      mountTree={open}
      // Right-click → "Open in a new tab": the same file view, on that folder,
      // as a Files (Project) tab in this project's scope.
      onOpenFolderTab={(rel) => openProjectFilesTab(t, projectDir, rel)}
      containerClassName={`side-panel${side === "left" ? " left" : ""} ${open ? "open" : ""}${resizing ? " resizing" : ""}${switching ? " switching" : ""}`}
      containerStyle={width ? { width } : undefined}
      containerProps={{ onMouseEnter, onMouseLeave }}
      resizeHandle={resizeHandle}
      pin={chrome}
      hidden={hidden}
      footer={versionFooter}
      view={panelView}
      onViewChange={(view: FilesPanelView) => {
        // Both keys: this scope's own view, and the seed the next scope with no
        // entry of its own opens on. Same patch the closed panel's edge rail
        // writes when it opens the panel straight onto a view.
        void updateSettings(
          sidePanelViewPatch(view, viewKey, { side_panel_view_by_project: viewByScope }),
        );
      }}
    />
  );
}
