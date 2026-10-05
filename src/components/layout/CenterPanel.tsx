import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DETACHED_DRAG_END,
  DETACHED_DRAG_MOVE,
  DETACHED_DRAG_START,
  decideDetachedGroupDrop,
  decideDetachedPaneDrop,
  decideDetachedTabDrop,
  type DetachedDragEnd,
  type DetachedDragMove,
  type DetachedDragStart,
} from "../../stores/detached";
import { TabPane } from "../tabs/TabPane";
import { Subwindow } from "../tabs/Subwindow";
import { pickEdge, previewInset } from "../tabs/dragGeometry";
import { dragPreviewLayout } from "../tabs/dragPreview";
import {
  BLOB_TAB_CMD,
  ROOT_SCOPE,
  DEFAULT_MIN_SUBWINDOW_PX,
  EMPTY_GROUP_ID,
  allGroups,
  dividerFraction,
  effectiveTabLocation,
  findGroup,
  hydrateScopeFromDisk,
  isRelaunchableLocalTab,
  isResumableAgentTab,
  isSavedWhileLive,
  isPtyTabKind,
  localTabCwd,
  remoteHostIdOf,
  useTabsStore,
  type DetachedDockTarget,
  type LayoutNode,
} from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useDragStore } from "../../stores/drag/drag";
import { useSubwindowNavStore } from "../../stores/subwindowNav";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useWindowFocused } from "../../hooks/useWindowFocused";
import { useScrollSyncStore } from "../../stores/viewers/scrollSync";
import { useWindowMoveStore } from "../../stores/drag/windowMove";
import { useDetachAnimStore } from "../../stores/drag/detachAnim";
import { useTabLandStore } from "../../stores/drag/tabLand";
import { TAB_ACCENT } from "../tabs/newTabItems";
import { commitDrop } from "../tabs/commitDrop";
import {
  startDetachedDropSession,
  reseedDetached,
} from "../tabs/detachedDropTargets";
import { createDetachedDragNet } from "../tabs/detachedDragNet";
import {
  DETACHED_DROP_CLAIM,
  DETACHED_DROP_PROBE,
  awaitPointerClaim,
  installPointerTracker,
  type DetachedDropClaim,
  type DetachedDropProbe,
} from "../../lib/window/dropClaim";
import {
  snapshotFrame,
  physToClient,
  type PhysPoint,
  type WindowFrame,
} from "../../lib/window/coords";
import { bindDragRelease, dragPlatform } from "../../lib/window/dragPlatform";
import { shouldPersistTab, shouldPersistLocalTab } from "../../lib/terminal/tmuxSession";
import { IS_WINDOWS } from "../../lib/platform";
import { restoreProjectScope, useProjectsStore } from "../../stores/projects";
import { BOX_SCOPE_PREFIX, boxFolderOfScope, restoreBoxScope, useBoxesStore } from "../../stores/boxes";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { resolveLocalMirror, resolveProjectDirectory } from "../../types";
import { useT } from "../../lib/i18n";
import { MOBILE_ACCESS_KEY } from "../../lib/brand";

/** Pixel coordinates of a group's pane region, relative to the center panel. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function CenterPanelImpl() {
  const t = useT();
  // A live local agent that was already running when Mobile access was enabled
  // must not be respawned merely to put tmux underneath it. Record eligibility
  // the first time this CenterPanel sees a tab: new/restored tabs first seen
  // while opted in are wrapped; tabs first seen before opt-in wait for their
  // next ordinary reopen (which mints a fresh tab key).
  const mobileAgentTmuxReady = useRef(new Map<string, boolean>());
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const scope = useTabsStore((s) => s.scope);
  const focusedGroupId = useTabsStore((s) => s.focusedGroupId);
  const windowFocused = useWindowFocused();
  const rootConsoleOpen = useRootOverlayStore((st) => st.open);
  // Root tab keys an app overlay's docked agent column is drawing right now
  // (`OverlayAgentColumn`); their copy here stands down, like the root console.
  const overlayAgentShown = useOverlayAgentStore((st) => st.shownKeys);
  const layout = useTabsStore((s) => s.layout);
  const layoutByScope = useTabsStore((s) => s.layoutByScope);
  const setScope = useTabsStore((s) => s.setScope);
  const loadFromLayout = useTabsStore((s) => s.loadFromLayout);
  const resizeSplit = useTabsStore((s) => s.resizeSplit);
  const mergeGroups = useTabsStore((s) => s.mergeGroups);
  const tabs = useTabsStore((s) => s.tabs);
  // #42: the current scope's detached popouts. Subscribed here so the debounced
  // save below re-fires when a popout is moved/resized (setDetachedBounds swaps
  // this array's identity) — otherwise bounds drags wouldn't reach project.json
  // until the next tab/layout change or app quit.
  const detachedGroups = useTabsStore((s) => s.detachedGroupsByScope[s.scope]);
  // `persistScope`, not `saveLayout`: the latter persists the tab store's CURRENT
  // scope into whatever `localFile` it is handed, and those are two independently
  // tracked values. `activeId` and `localFile` both come from `activeProject` here,
  // so passing the scope explicitly makes it impossible to write one project's tabs
  // (or, worse, an empty layout standing in for them) into another project's file.
  const persistScope = useTabsStore((s) => s.persistScope);
  const updateTabEnv = useTabsStore((s) => s.updateTabEnv);
  // #42: popouts to re-open for the current scope (restored docked, then detached).
  const pendingRespawn = useTabsStore((s) => s.pendingRespawnByScope[s.scope]);
  const consumePendingRespawn = useTabsStore((s) => s.consumePendingRespawn);
  const detachGroup = useTabsStore((s) => s.detachGroup);
  // #62: app-internal fullscreen. When set, only this group's pane is shown,
  // sized to the whole panel — panes stay MOUNTED (we reposition, never unmount,
  // so PTYs survive). The frame layer (tab bars/splits) keeps rendering beneath.
  const fullscreenGroupId = useTabsStore((s) => s.fullscreenGroupId);
  // True while the whole window is being moved by a native title-bar drag
  // (Windows). Drives `.center-panel.moving`, which hides the heavy pane layer so
  // WebView2 can keep the frame aligned with the cursor during the OS move loop.
  const windowMoving = useWindowMoveStore((s) => s.moving);

  // Two field selectors, not the whole store: a bare `useProjectsStore()`
  // re-rendered this panel on every projects-store write, switch/connection
  // toasts included, none of which it reads. Deliberately NOT one object
  // selector (`(s) => ({ projects, activeId })`): that returns a fresh object
  // per call, which zustand 5 without `useShallow` rejects ("getSnapshot should
  // be cached") or loops on. `projects` is replaced by reference on change and
  // `activeId` is a string|null, so plain selectors compare correctly.
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  // Bumped on every pill click, even one re-selecting the already-active
  // project. It is what lets the restore effect below leave a box scope when
  // the user clicks the project they were in before opening the box —
  // `activeId` doesn't change then, so without this dep the effect never
  // re-runs its `setScope` and the box scope is stuck.
  const switchGeneration = useProjectsStore((s) => s.switchGeneration);

  // Whether a pointer-drag is active. We subscribe to a boolean (not the drag
  // object, which is replaced on every pointermove) so the panel doesn't
  // re-render — and tear down/re-add its window listeners — each frame. Live
  // drag state is read via useDragStore.getState() inside the handlers.
  const dragging = useDragStore((s) => s.drag != null);
  // The dragged tab's identity (stable for the whole gesture — start() sets it
  // once; the per-frame move/setTarget only swap coords/target). Subscribed as
  // scalars so they don't re-render the panel on every pointermove, only on
  // drag start/end. They drive the live source-subwindow collapse below.
  const dragKind = useDragStore((s) => s.drag?.kind ?? null);
  const dragKey = useDragStore((s) => s.drag?.key ?? null);
  const dragFromGroup = useDragStore((s) => s.drag?.fromGroup ?? null);

  // Measured pane regions per group id (current scope only). The flat pane
  // layer positions each active pane over its group's body so PTYs never
  // unmount on scope switch / re-tile.
  const [groupRects, setGroupRects] = useState<Record<string, Rect>>({});
  // Whole-subwindow rects (tab bar + body), used by the focus frame so it wraps
  // the current subwindow's tab header too — not just its pane region.
  const [groupFrameRects, setGroupFrameRects] = useState<Record<string, Rect>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const groupBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const activeProject = projects.find((p) => p.id === activeId);
  const localFile = activeProject?.local_file as string | undefined;
  const projectCwd = resolveProjectDirectory(activeProject);
  // The active BOX scope's folder (empty string outside a box scope). New tabs
  // opened while a box is active default here, not to the previously active
  // project's directory — the box folder is the scope's own root.
  const activeBoxFolder = useBoxesStore((s) => boxFolderOfScope(scope, s.boxes));
  const boxes = useBoxesStore((s) => s.boxes);
  const newTabCwd = activeBoxFolder || projectCwd;

  // Mount-free remote: a remote project starts DISCONNECTED but its LOCAL tabs
  // (local agents / local_agent / local-toggled shells — all running in the
  // mirror via a local PTY) and the file browser (which falls back to the mirror
  // while disconnected) work offline, so the saved tabs are ALWAYS restored. Only
  // genuinely-remote panes (`ssh -tt` shells, remote-toggled agents, the SFTP
  // file tree) would block on the dead pool, so those are held per-pane below
  // until that pane's project reaches "connected" (see the pane render). Keyed
  // by the PANE's own scope — panes stay mounted across scope switches, so
  // holding must not track only the active project's state.
  const remoteSshByProject = useRemoteStatusStore((s) => s.byProject);
  // Worker-host lamps (multi-host remote): a pane on a worker holds iff THAT
  // worker is down, independent of the primary (plan §4.5).
  const remoteSshByHost = useRemoteStatusStore((s) => s.byHost);
  // Persistent LOCAL (tmux) sessions (TODO #85): default ON on Unix (no tmux on
  // Windows). Folded here so the per-pane decision below is a cheap boolean AND.
  const localPersistEnabled = useSettingsStore(
    (s) => !IS_WINDOWS && s.settings?.persist_local_sessions !== false,
  );
  // Stable per-scope connect handler. TabPane is memoized, so the pane layer only
  // stays cheap to re-render (e.g. every frame of a divider drag) if its props are
  // referentially stable — a fresh `() => openRemoteMachines(scopeKey)` arrow every
  // render would break the memo for every pane. Cached by scope; reads the store
  // action lazily so the cache never needs invalidating. Opens the unified "Remote
  // machines" hub (scopeKey is the project id), matching the pill and file view.
  const connectHandlers = useRef<Map<string, () => void>>(new Map());
  const getConnect = useCallback((scopeKey: string) => {
    let h = connectHandlers.current.get(scopeKey);
    if (!h) {
      h = () => useRemoteMachinesStore.getState().open(scopeKey);
      connectHandlers.current.set(scopeKey, h);
    }
    return h;
  }, []);

  // The layout to RENDER: normally the store layout, but while dragging a
  // subwindow's lone tab it's that layout with the (about-to-empty) source
  // subwindow pruned — so it collapses live and the siblings reflow to fill,
  // rather than lingering until the drop. Render-only; the store is untouched
  // (an aborted drag restores instantly), and the dragged tab's pane stays
  // mounted in the flat pane layer below (its PTY survives). All measurement and
  // drop-target resolution keys off THIS tree so the previewed layout is what
  // the pointer hit-tests against.
  const renderLayout = useMemo(
    () => dragPreviewLayout(layout, dragKind, dragKey, dragFromGroup, fullscreenGroupId != null),
    [layout, dragKind, dragKey, dragFromGroup, fullscreenGroupId],
  );

  useEffect(() => {
    const nextScope = activeId ?? "root";
    setScope(nextScope);

    if (!activeId) {
      // Root context. Its tabs now persist under the `"root"` id (state dir), so
      // restore them on the first visit this session exactly as a project's are;
      // later visits trust the in-memory state. When nothing restorable was saved
      // (a fresh install, or a root left at its default), seed the 3D project-blob
      // — the root's default tab — but only when projects exist (an empty cloud
      // has nothing to show). `hydrateScopeFromDisk` owns the guards and the
      // restorable filter (shared with the project/box restores, so a saved
      // custom-agent tab no longer vanishes at root); the root work dir is
      // resolved lazily — it is only the fallback cwd for tabs that saved an
      // empty one (e.g. a files tab).
      if ("root" in useTabsStore.getState().tabsByScope) return;
      const seedBlob = () => {
        if (
          useProjectsStore.getState().projects.length > 0 &&
          !("root" in useTabsStore.getState().tabsByScope)
        ) {
          useTabsStore.getState().addTab(
            { label: "Projects", cmd: BLOB_TAB_CMD, cwd: "", kind: "projects3d" },
            // Tabtivity opened this, not the user — it must not show up in the usage
            // recap as a tab they opened.
            { seeded: true },
          );
        }
      };
      hydrateScopeFromDisk("root", () => invoke<string>("root_work_dir").catch(() => ""))
        .then((hydrated) => {
          if (!hydrated) seedBlob();
        })
        .catch(() => seedBlob());
      return;
    }

    // Project context: restore the saved tab layout from disk (first visit this
    // session). `restoreProjectScope` owns every guard — no local_file, a scope
    // already initialized this session (in-memory state wins, so intentionally
    // closed tabs are not resurrected), and a layout with nothing restorable in it
    // (which must NOT create the scope key). It is the same call the startup pass
    // makes for the active projects nobody switches to, so the current project and
    // the background ones restore under one policy.
    //
    // A freshly-visited project with no restorable tabs stays empty (the empty
    // Subwindow with a "+"); we no longer seed a default README.md tab.
    //
    // `localFile` is in the deps because a project whose entry hasn't loaded yet
    // isn't restorable: the effect re-runs the moment the list arrives. The entry
    // itself is read from the store rather than closed over, so an unrelated field
    // changing on it (the git-provider sniff, a status flip) can't re-fire this.
    if (!localFile) return;
    const project = useProjectsStore.getState().projects.find((p) => p.id === nextScope);
    if (project) void restoreProjectScope(project);
    // `switchGeneration` re-runs the `setScope` above on a pill click that
    // re-selects the already-active project — the one gesture that must leave
    // an open box scope (activeId is unchanged, so nothing else here moves).
  }, [activeId, localFile, setScope, loadFromLayout, switchGeneration]);

  // Box-scope restore: the first entry of a `box:<id>` scope this session
  // loads its saved tabs from `<state_dir>/sessions/box_<id>/` (lazy, like a
  // project's); nothing restorable seeds one shell at the box folder. The
  // seed lives in `restoreBoxScope`, not in `openBox`, so restore and seed
  // cannot race. See stores/boxes.
  useEffect(() => {
    if (!scope.startsWith(BOX_SCOPE_PREFIX)) return;
    if (scope in useTabsStore.getState().tabsByScope) return;
    void restoreBoxScope(scope);
  }, [scope]);

  // Re-hydrate vibe local_agent tabs that were saved without VIBE_HOME/
  // VIBE_ACTIVE_MODEL. Only vibe needs this: `ollama launch`/fallback driver tabs
  // (cmd "ollama"/"codex"/…) carry everything in cmd+args and have no env to
  // restore, so they must be skipped — `prepare_local_agent` only knows vibe.
  useEffect(() => {
    if (!activeId) return;
    const { tabs: currentTabs } = useTabsStore.getState();
    const needsEnv = currentTabs.filter(
      (t) =>
        t.kind === "local_agent" &&
        t.cmd === "vibe" &&
        Object.keys(t.env ?? {}).length === 0,
    );
    for (const tab of needsEnv) {
      invoke<{ vibe_home: string; alias: string }>("prepare_local_agent", { model: tab.label })
        .then(({ vibe_home, alias }) => {
          updateTabEnv(tab.key, { VIBE_HOME: vibe_home, VIBE_ACTIVE_MODEL: alias });
        })
        .catch(() => {});
    }
  }, [activeId, updateTabEnv]);

  useEffect(() => {
    // Persist the ACTIVE scope. Root persists under the `"root"` id with no
    // export copy (it has no project.json, so `localFile` is empty and the
    // backend skips it); a `box:<id>` scope persists under its own id the same
    // way — `storage::project_key` maps it to `sessions/box_<id>/` and an empty
    // localFile skips the project-tree export copy. A project without a
    // `local_file` isn't ready to persist yet.
    const isBoxScope = scope.startsWith(BOX_SCOPE_PREFIX);
    if (!isBoxScope && activeId && !localFile) return;
    const scopeToPersist = isBoxScope ? scope : (activeId ?? "root");
    const file = isBoxScope ? "" : (localFile ?? "");
    const timer = window.setTimeout(() => {
      persistScope(scopeToPersist, file).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [scope, activeId, localFile, tabs, layout, detachedGroups, persistScope]);

  // #42: re-open popouts that were detached when this scope was last saved. The
  // groups were restored DOCKED (above) so their panes mount and spawn their
  // PTYs first; this effect — which runs after those child panes have mounted —
  // then re-detaches each, reopening the floating window (which attaches to the
  // now-live PTY). consumePendingRespawn clears the queue so it fires once.
  useEffect(() => {
    if (!pendingRespawn || pendingRespawn.length === 0) return;
    const targets = consumePendingRespawn(scope);
    for (const t of targets) {
      // allowLastGroup: a restored popout may be the scope's only group (its
      // in-window siblings held only non-restorable tabs and were dropped); it
      // must still re-detach into its own window rather than stay docked.
      detachGroup(t.id, { bounds: t.bounds, zoom: t.zoom, allowLastGroup: true });
    }
  }, [scope, pendingRespawn, consumePendingRespawn, detachGroup]);

  // ── Pane-region measurement ───────────────────────────────────────────────
  // Recompute every group body's rect (relative to the panel) so the flat pane
  // layer can position each active pane over its subwindow. Runs after layout
  // changes and on resize.
  const measure = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const base = panel.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    const frames: Record<string, Rect> = {};
    for (const [id, el] of groupBodyRefs.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[id] = {
        left: r.left - base.left,
        top: r.top - base.top,
        width: r.width,
        height: r.height,
      };
      // The enclosing subwindow box spans the tab header bar + body, so the
      // focus frame drawn from it wraps the current tab strip too. Clamp the
      // right edge to the pane region's right (`r`) so a docked files sidebar —
      // which lives in the same body, to the right of the pane — is excluded.
      const sub = el.closest(".subwindow");
      if (sub) {
        const sr = sub.getBoundingClientRect();
        frames[id] = {
          left: sr.left - base.left,
          top: sr.top - base.top,
          width: r.right - sr.left,
          height: sr.height,
        };
      }
    }
    // Skip state writes when a map is unchanged (a write re-renders every pane).
    const sameRects = (
      a: Record<string, Rect>,
      b: Record<string, Rect>,
    ): boolean => {
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const k of keys) {
        const x = a[k];
        const y = b[k];
        if (!y || x.left !== y.left || x.top !== y.top || x.width !== y.width || x.height !== y.height) {
          return false;
        }
      }
      return true;
    };
    setGroupRects((prev) => (sameRects(next, prev) ? prev : next));
    setGroupFrameRects((prev) => (sameRects(frames, prev) ? prev : frames));
  }, []);

  // Re-measure when the rendered layout tree changes — including the live drag
  // collapse/restore, so siblings' reflowed rects are picked up immediately.
  useLayoutEffect(() => {
    measure();
  }, [measure, renderLayout, scope]);

  // Re-measure on panel resize (split drags resize children without remount).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(panel);
    for (const el of groupBodyRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure, renderLayout, scope]);

  // Re-measure on OS-window resize. The ResizeObserver above misses OS-level
  // resizes on older WebKitGTK builds (it fires for split drags but not for the
  // window growing/shrinking), so panes — positioned at a JS-measured pixel
  // width/height — would keep their stale size and the file viewers
  // (markdown/text/PDF, sized off the pane box) never reflow to the new window
  // width. AppShell bridges Tauri's reliable onResized/onScaleChanged into a DOM
  // 'resize' event; listening for it here re-runs the measurement. (The detached
  // window sidesteps this entirely by sizing its single pane with CSS insets.)
  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  const registerGroupBody = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) groupBodyRefs.current.set(id, el);
      else groupBodyRefs.current.delete(id);
    },
    [],
  );

  // Resolve the drop target under a panel point (client coords) and write it to
  // the drag store (driving the live preview). Shared by the in-window pointer
  // drag and the cross-window detached-popout drag (#42), which feeds it pointer
  // coords streamed from the popout. A tab bar → within-bar reorder slot; a
  // subwindow body → edge split of that group.
  const resolveTarget = useCallback(
    (x: number, y: number) => {
      const setTarget = useDragStore.getState().setTarget;
      // The slot is the `data-tab-index` of the first tab right of the pointer's
      // midpoint — NOT its DOM position: a tab-group chip stands for several
      // tabs, so DOM order and tab order part ways once a bar has one.
      const computeReorderIndex = (tabBar: HTMLElement, px: number): number => {
        const tabEls = tabBar.querySelectorAll<HTMLElement>(".tab[data-tab-index]");
        const count = Number(tabBar.dataset.tabCount);
        const end = Number.isFinite(count) ? count : tabEls.length;
        for (const el of tabEls) {
          const r = el.getBoundingClientRect();
          if (px < r.left + r.width / 2) return Number(el.dataset.tabIndex);
        }
        return end;
      };
      const el = document.elementFromPoint(x, y);
      const tabBar = el?.closest(".tab-bar");
      if (tabBar instanceof HTMLElement && tabBar.dataset.groupId) {
        setTarget({
          overGroup: null,
          edge: null,
          reorderGroup: tabBar.dataset.groupId,
          reorderIndex: computeReorderIndex(tabBar, x),
        });
        return;
      }
      const panel = panelRef.current;
      if (panel) {
        const base = panel.getBoundingClientRect();
        const px = x - base.left;
        const py = y - base.top;
        for (const [gid, r] of Object.entries(groupRects)) {
          if (px >= r.left && px <= r.left + r.width && py >= r.top && py <= r.top + r.height) {
            setTarget({
              overGroup: gid,
              edge:
                gid === EMPTY_GROUP_ID
                  ? "center"
                  : pickEdge({ left: r.left, top: r.top, width: r.width, height: r.height }, px, py),
              reorderGroup: null,
              reorderIndex: null,
            });
            return;
          }
        }
      }
      setTarget({ overGroup: null, edge: null, reorderGroup: null, reorderIndex: null });
    },
    [groupRects],
  );

  // ── Pointer-drag hit-test + drop authority (panel-wide) ───────────────────
  // While a tab drag is active, window listeners resolve the target under the
  // pointer each move (a tab bar → within-bar reorder slot, or a subwindow body
  // → edge split) and commit on release. CenterPanel is the SINGLE drop
  // authority; TabBar's own pointerup only handles the click case. We avoid
  // setPointerCapture and rely on `.center-panel.dragging` making panes
  // pointer-events:none so elementFromPoint can reach the tab bars / bodies.
  useEffect(() => {
    if (!dragging) return;
    const move = useDragStore.getState().move;

    const onMove = (e: PointerEvent) => {
      const d = useDragStore.getState().drag;
      // Shift during a file drag = "force a new window on release" (see
      // FileTree's commitRelease). Suppress the in-window split/dock preview so
      // the animation stops and it's clear nothing will dock here. Clear once
      // (only when a target is actually set) to avoid per-move store churn;
      // releasing Shift falls back to resolveTarget and the preview returns.
      if (e.shiftKey && d?.kind === "file") {
        if (
          d.overGroup != null ||
          d.edge != null ||
          d.reorderGroup != null ||
          d.reorderIndex != null
        ) {
          useDragStore.getState().setTarget({
            overGroup: null,
            edge: null,
            reorderGroup: null,
            reorderIndex: null,
          });
        }
        move(e.clientX, e.clientY);
        return;
      }
      resolveTarget(e.clientX, e.clientY);
      move(e.clientX, e.clientY);
    };
    // True only when the user explicitly aborts (Escape); a plain pointercancel
    // is NOT an abort on WebKitGTK — see onCancel.
    let aborted = false;
    const finish = () => {
      // File drags are committed AND torn down by FileTree's own pointerup
      // handler (the only listener that reliably sees the release on WebKitGTK).
      // Bail out here without commit or end() so we never race FileTree and tear
      // the drag down before it commits the drop.
      const d = useDragStore.getState().drag;
      // File drags commit via FileTree; detached-popout drags commit via the
      // cross-window END handler (#42). Neither commits here.
      if (d?.kind === "file" || d?.kind === "detached") {
        return;
      }
      // Commit the LAST resolved target (the one the live preview showed) rather
      // than re-resolving at the release coordinate (elementFromPoint there is
      // unreliable on WebKitGTK). The store already holds what every pointermove
      // resolved, so honour it verbatim. NOTE: on WebKitGTK these mid-gesture
      // window listeners receive pointermove but NOT the terminal pointerup, so
      // the actual commit normally comes from TabBar's pointerup handler (bound
      // before pointer capture). These handlers are a redundant path for other
      // platforms; the drag-store end() guard makes a double-commit a no-op.
      commitDrop(useDragStore.getState().drag);
      useDragStore.getState().end();
    };
    const onUp = () => finish();
    const onMouseUp = () => finish();
    // WebKitGTK frequently fires `pointercancel` INSTEAD of `pointerup` to end a
    // mouse drag (its native gesture/selection heuristic claims the stream after
    // pointermove), so on Linux a cancel commits the drop (else every drop is
    // swallowed). On Chromium/WKWebView (Win/mac) a real `pointerup` fires and a
    // `pointercancel` is a genuine capture loss → abort, not commit. The
    // `dragPlatform.cancelCommits` flag encodes exactly this split. An explicit
    // Escape (aborted) always ends without committing.
    const onCancel = () => {
      if (aborted || !dragPlatform.cancelCommits) { useDragStore.getState().end(); return; }
      finish();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        aborted = true;
        useDragStore.getState().end();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dragging, resolveTarget]);

  // ── Cross-window drag-to-dock (#42) ───────────────────────────────────────
  // A popped-out window dragged back streams its OS cursor (PHYSICAL desktop px —
  // the canonical cross-window space, see lib/window/coords) to this main window. We map
  // it into OUR client px via our own frame (innerPhys/scale — the only DPI-correct
  // conversion), drive the SAME drop preview as an in-window tab drag (via
  // `resolveTarget` + the drag store), and dock the group on release.
  // `resolveTarget` is read through a ref so this listener — mounted once — always
  // hit-tests against current group rects. Setting the detached drag in the store
  // flips `.center-panel.dragging` on, which makes panes pointer-events:none so
  // elementFromPoint can reach the tab bars/bodies. The popout owns the pointer, so
  // the main window never sees real pointer events during the gesture and the
  // in-window drag effect above stays inert (its handlers also guard `kind ===
  // "detached"`).
  const resolveTargetRef = useRef(resolveTarget);
  resolveTargetRef.current = resolveTarget;
  useEffect(() => {
    installPointerTracker();
    const win = getCurrentWindow();
    // Our own window frame (physical px). Streamed physical cursor → our client px
    // via `physToClient` (innerPhys/scale). Snapshotted at each drag start (the
    // main window doesn't move mid-gesture).
    let frame: WindowFrame | null = null;
    const refreshFrame = async () => {
      try {
        frame = await snapshotFrame(win);
      } catch {
        frame = null;
      }
    };
    const toClient = (cursorPhysX: number, cursorPhysY: number) =>
      frame
        ? physToClient(frame, { x: cursorPhysX, y: cursorPhysY })
        : { x: cursorPhysX, y: cursorPhysY };

    // #42: the SAME popout hit-test `TabBar` uses for main→popout drags, now also
    // driving popout-ORIGINATED drags — so a tab dragged out of popout A lights up
    // and docks into popout B exactly like a main→popout drag (the unification).
    // Created per gesture on START, disposed on END. `dragSrcGroupId` is the source
    // popout's record id, excluded from sibling hit-tests (a release over the source
    // is handled inside it and arrives here as `cancelled:true`).
    let session: ReturnType<typeof startDetachedDropSession> | null = null;
    let dragSrcGroupId: string | null = null;
    let dragLabel: string | undefined;
    // #238: the net under a lost END. START makes every pane pointer-events:none
    // (so the drop preview can hit-test the bars underneath) and only END or an
    // Escape pressed IN THIS WINDOW takes it back out — the main window's own
    // release handlers deliberately never end a detached drag. So a popout
    // destroyed mid-gesture, or an engine that swallows the terminal event, left
    // the main window ignoring every click with nothing on screen saying why.
    // Two observable facts end it: MOVEs stopping (the popout polls the cursor
    // at frame rate while the gesture is live) and a press landing here.
    const expire = () => {
      if (useDragStore.getState().drag?.kind !== "detached") return;
      endSession();
      useDragStore.getState().end();
    };
    const net = createDetachedDragNet(expire);
    // The coordinate-free claim in flight (see the PROBE host below).
    let claimToken: string | null = null;
    let cancelClaim: (() => void) | null = null;
    const endClaim = () => {
      claimToken = null;
      cancelClaim?.();
      cancelClaim = null;
    };
    const endSession = () => {
      endClaim();
      net.stop();
      session?.dispose();
      session = null;
      dragSrcGroupId = null;
      dragLabel = undefined;
    };
    // A real press in the main window means the popout no longer owns the
    // pointer — whatever happened to its END, the gesture is over.
    const onMainPointerDown = () => {
      if (net.armed()) expire();
    };
    window.addEventListener("pointerdown", onMainPointerDown, true);
    // The sibling popout under the physical cursor, or null (none, or it's the
    // source popout — a self-drop is handled locally in the popout).
    const siblingAt = (phys: PhysPoint | null) => {
      if (!phys || !session) return null;
      const pop = session.at(phys);
      return pop && pop.groupId !== dragSrcGroupId ? pop : null;
    };

    const unsubs: Array<() => void> = [];
    let cancelled = false;
    const reg = (p: Promise<() => void>) =>
      p
        .then((fn) => {
          if (cancelled) fn();
          else unsubs.push(fn);
        })
        .catch(() => {});

    reg(
      listen<DetachedDragStart>(DETACHED_DRAG_START, (ev) => {
        const { scope: dScope, groupId, label, cursorPhysX, cursorPhysY, tabKey, paneId } =
          ev.payload;
        // Open a popout drop session for THIS gesture so sibling popouts of the
        // scope become live drop targets (highlight on MOVE, dock on END) — the
        // same machinery `TabBar` uses for main→popout drags.
        endSession();
        // The drag's OWN scope decides which popouts are targets (#238): a root
        // or box popout is never parked, so a tab can be dragged out of one
        // while a project is active — and it must light up and land in a sibling
        // of its own scope, never in the active project's popouts (where the
        // move then silently no-ops because the two records live under different
        // scope keys).
        session = startDetachedDropSession({ scope: dScope });
        dragSrcGroupId = groupId;
        dragLabel = label;
        net.start();
        void session.resolve();
        // Start the drag synchronously so the high-frequency MOVE poll that
        // follows isn't dropped by its `kind !== "detached"` guard while we await
        // the frame. Seed with the current (stale/identity) frame; refreshFrame()
        // then corrects it and we re-resolve. The main window doesn't move mid-gesture.
        const seed = toClient(cursorPhysX, cursorPhysY);
        useDragStore.getState().startDetachedDrag({
          label,
          pointerX: seed.x,
          pointerY: seed.y,
          detachedScope: dScope,
          detachedGroupId: groupId,
          detachedTabKey: tabKey,
          detachedPaneId: paneId,
        });
        resolveTargetRef.current(seed.x, seed.y);
        void refreshFrame().then(() => {
          if (useDragStore.getState().drag?.kind !== "detached") return;
          const { x, y } = toClient(cursorPhysX, cursorPhysY);
          useDragStore.getState().move(x, y);
          resolveTargetRef.current(x, y);
        });
      }),
    );

    reg(
      listen<DetachedDragMove>(DETACHED_DRAG_MOVE, (ev) => {
        if (useDragStore.getState().drag?.kind !== "detached") return;
        net.touch();
        const phys: PhysPoint = {
          x: ev.payload.cursorPhysX,
          y: ev.payload.cursorPhysY,
        };
        const { x, y } = toClient(phys.x, phys.y);
        useDragStore.getState().move(x, y);
        resolveTargetRef.current(x, y);
        // Light up a SIBLING popout under the cursor (never the source), so a
        // popout→popout drag previews its drop just like a main→popout drag.
        if (session) session.hover(siblingAt(phys), phys, dragLabel);
      }),
    );

    // The ONE commit for a cross-window drop that ends in this window's care,
    // shared by the geometric END (below) and the coordinate-free claim path
    // (`DETACHED_DROP_PROBE`/`CLAIM`, further down). The caller has already
    // written the release point into the drag store and resolved the main-side
    // target for it; this decides and mutates. `phys` is the final physical
    // cursor where the platform has one (it places a new window), else null.
    const settle = (input: {
      cancelled: boolean;
      shift: boolean;
      inMain: boolean;
      overPopoutId: string | null;
      /** The pane inside `overPopoutId` the drop resolved to, when known. */
      popoutTarget: DetachedDockTarget | undefined;
      phys: PhysPoint | null;
    }) => {
      const f = useDragStore.getState().drag;
      const { inMain, overPopoutId, phys } = input;
      const store = useTabsStore.getState();
      const done = () => {
        endSession();
        useDragStore.getState().end();
      };

      // ── Single dragged tab: unified {newWindow | dockDetached | dockMain} ────
      if (f?.kind === "detached" && f.detachedScope && f.detachedGroupId && f.detachedTabKey) {
        const scope = f.detachedScope;
        const srcGroup = f.detachedGroupId;
        const tabKey = f.detachedTabKey;
        const decision = decideDetachedTabDrop({
          cancelled: input.cancelled,
          shift: input.shift,
          inMain,
          overPopoutId,
          srcGroupId: srcGroup,
        });
        switch (decision.kind) {
          case "dockDetached": {
            // Move the tab from its source popout INTO the sibling popout under
            // the cursor, at the pane the cursor resolves to. Re-seed BOTH windows
            // (the destination plays the drop-in landing on the moved tab).
            const target = input.popoutTarget;
            store.moveTabBetweenDetached(scope, srcGroup, decision.toGroupId, tabKey, target);
            reseedDetached(scope, decision.toGroupId, tabKey);
            reseedDetached(scope, srcGroup);
            break;
          }
          case "dockMain": {
            // Dock just the dragged tab into its OWN scope's in-window layout at
            // the resolved target (bar → merge; body edge → split; else default).
            // Targets only apply when the popout's scope IS the active one.
            const sameScope = store.scope === scope;
            const target =
              sameScope && f.reorderGroup
                ? { targetGroupId: f.reorderGroup, edge: "center" as const }
                : sameScope && f.overGroup && f.edge
                  ? { targetGroupId: f.overGroup, edge: f.edge }
                  : undefined;
            store.attachDetachedTab(scope, srcGroup, tabKey, target);
            if (sameScope) useTabLandStore.getState().markLanded(tabKey);
            reseedDetached(scope, srcGroup);
            break;
          }
          case "newWindow": {
            // Shift, or a free-space release: pop the tab into its OWN new popout
            // at the PHYSICAL cursor (Rust `.position()` is physical). A lone-tab
            // source is refused downstream (null) → clean no-op, never a hang.
            if (phys) {
              const bounds = {
                x: Math.round(phys.x - 80),
                y: Math.round(phys.y - 8),
                w: 900,
                h: 640,
              };
              const newLabel = store.detachTabToNewWindow(scope, srcGroup, tabKey, bounds);
              if (newLabel) reseedDetached(scope, srcGroup);
            }
            break;
          }
          case "local":
          case "none":
            // The source popout already committed a within-popout drop (or the
            // gesture was cancelled) — nothing for the host to do.
            break;
        }
        done();
        return;
      }

      // ── One pane of a multi-pane popout: dock JUST that pane, or pop it into
      // its own window — NEVER the whole popout (a pane drop must not haul its
      // sibling panes into the main window). ────────────────────────────────
      if (f?.kind === "detached" && f.detachedScope && f.detachedGroupId && f.detachedPaneId) {
        const scope = f.detachedScope;
        const srcGroup = f.detachedGroupId;
        const paneId = f.detachedPaneId;
        const decision = decideDetachedPaneDrop({
          cancelled: input.cancelled,
          shift: input.shift,
          inMain,
          overPopoutId,
          srcGroupId: srcGroup,
        });
        switch (decision.kind) {
          case "dockMain": {
            // Dock only the dragged pane at the resolved target (bar → merge;
            // body edge → split; else its own pane). Targets only apply when
            // the popout's scope IS the active one.
            const sameScope = store.scope === scope;
            const target =
              sameScope && f.reorderGroup
                ? { targetGroupId: f.reorderGroup, edge: "center" as const }
                : sameScope && f.overGroup && f.edge
                  ? { targetGroupId: f.overGroup, edge: f.edge }
                  : undefined;
            store.attachDetachedPane(scope, srcGroup, paneId, target);
            reseedDetached(scope, srcGroup);
            break;
          }
          case "newWindow": {
            // Shift, or a free-space release: the pane becomes its own popout
            // at the physical cursor. A lone-pane source is refused downstream
            // (null) → clean no-op.
            if (phys) {
              const bounds = {
                x: Math.round(phys.x - 80),
                y: Math.round(phys.y - 8),
                w: 900,
                h: 640,
              };
              const newLabel = store.detachPaneToNewWindow(scope, srcGroup, paneId, bounds);
              if (newLabel) reseedDetached(scope, srcGroup);
            }
            break;
          }
          case "none":
            // Cancelled / released over the source or a sibling popout — stay put.
            break;
        }
        done();
        return;
      }

      // ── Whole group: dock into main, or stay floating ───────────────────────
      if (f?.kind === "detached" && f.detachedGroupId && f.detachedScope) {
        const decision = decideDetachedGroupDrop({
          cancelled: input.cancelled,
          shift: input.shift,
          inMain,
          overPopoutId,
          srcGroupId: f.detachedGroupId,
        });
        if (decision.kind === "dockMain") {
          // Mirror listenDetachedHost: attachGroup re-injects only into the ACTIVE
          // scope's live layout; a non-active scope re-injects into its STORED
          // layout via dropDetachedGroup (else attachGroup silently no-ops).
          if (store.scope === f.detachedScope) {
            if (f.reorderGroup) {
              store.attachGroup(f.detachedGroupId, {
                targetGroupId: f.reorderGroup,
                edge: "center",
              });
            } else if (f.overGroup && f.edge) {
              store.attachGroup(f.detachedGroupId, {
                targetGroupId: f.overGroup,
                edge: f.edge,
              });
            } else {
              store.attachGroup(f.detachedGroupId);
            }
          } else {
            store.dropDetachedGroup(f.detachedScope, f.detachedGroupId);
          }
        }
        // `float` (Shift / free space / over a sibling popout) → leave it be.
      }
      done();
    };

    reg(
      listen<DetachedDragEnd>(DETACHED_DRAG_END, (ev) => {
        const d = useDragStore.getState().drag;
        if (d?.kind !== "detached") {
          endSession();
          return;
        }
        // END carries the LAST OS-cursor position in PHYSICAL desktop px (the DOM
        // release fires inside the popout on WebKitGTK, so `d.pointerX/Y` is stale).
        // Re-map it + re-resolve so `inMain`, the sibling hit-test, and the main-
        // side target all reflect where the cursor actually ended.
        const phys: PhysPoint | null =
          ev.payload.cursorPhysX != null && ev.payload.cursorPhysY != null
            ? { x: ev.payload.cursorPhysX, y: ev.payload.cursorPhysY }
            : null;
        let px = d.pointerX;
        let py = d.pointerY;
        if (phys) {
          const c = toClient(phys.x, phys.y);
          px = c.x;
          py = c.y;
          useDragStore.getState().move(px, py);
          resolveTargetRef.current(px, py);
        }
        const inMain =
          px >= 0 && py >= 0 && px <= window.innerWidth && py <= window.innerHeight;
        // The sibling popout under the final cursor (null if none / it's the source).
        const sibling = siblingAt(phys);
        settle({
          cancelled: ev.payload.cancelled,
          shift: ev.payload.shift ?? false,
          inMain,
          overPopoutId: sibling?.groupId ?? null,
          popoutTarget: phys && sibling ? session!.targetAt(sibling, phys) : undefined,
          phys,
        });
      }),
    );

    // ── Coordinate-free drops (#42 on native Wayland) ─────────────────────────
    // A popout that has no desktop geometry cannot stream a cursor; it releases
    // and broadcasts a PROBE instead (`lib/window/dropClaim`). This window then
    // waits for the pointer to show up SOMEWHERE: in its own DOM (→ dock into
    // main at the pane under it) or in a sibling popout, which answers with a
    // CLAIM naming the pane it resolved. The drag store is put into the same
    // `detached` state the geometric START uses, so the pane layer stops eating
    // the crossing event and the ladder in `settle` runs unchanged. No claim
    // within the timeout leaves the tab in its source popout.
    reg(
      listen<DetachedDropProbe>(DETACHED_DROP_PROBE, (ev) => {
        const probe = ev.payload;
        // A main-window drag probes for popouts itself (`TabBar` consumes the
        // claim); only a popout-sourced probe (it names its record) is hosted here.
        if (probe.sourceLabel === win.label || !probe.groupId) return;
        endSession();
        useDragStore.getState().startDetachedDrag({
          label: probe.label,
          pointerX: -1e4,
          pointerY: -1e4,
          detachedScope: probe.scope,
          detachedGroupId: probe.groupId,
          detachedTabKey: probe.tabKey,
        });
        claimToken = probe.token;
        cancelClaim = awaitPointerClaim(
          (x, y) => {
            if (claimToken !== probe.token) return;
            claimToken = null;
            // Next task, not now: the `detached` drag was just written and the
            // `.center-panel.dragging` class that lets `elementFromPoint` reach
            // the tab bars under the pane layer lands with React's commit.
            setTimeout(() => {
              if (useDragStore.getState().drag?.detachedTabKey !== probe.tabKey) return;
              useDragStore.getState().move(x, y);
              resolveTargetRef.current(x, y);
              settle({
                cancelled: false,
                shift: false,
                inMain: true,
                overPopoutId: null,
                popoutTarget: undefined,
                phys: null,
              });
            }, 0);
          },
          () => {
            if (claimToken !== probe.token) return;
            claimToken = null;
            settle({
              cancelled: true,
              shift: false,
              inMain: false,
              overPopoutId: null,
              popoutTarget: undefined,
              phys: null,
            });
          },
          { since: probe.releasedAt },
        );
      }),
    );
    reg(
      listen<DetachedDropClaim>(DETACHED_DROP_CLAIM, (ev) => {
        const claim = ev.payload;
        if (!claimToken || claim.token !== claimToken || !claim.groupId) return;
        endClaim();
        settle({
          cancelled: false,
          shift: false,
          inMain: false,
          overPopoutId: claim.groupId,
          popoutTarget: claim.target ?? undefined,
          phys: null,
        });
      }),
    );

    return () => {
      cancelled = true;
      endSession();
      window.removeEventListener("pointerdown", onMainPointerDown, true);
      for (const fn of unsubs) fn();
    };
  }, []);

  // ── Render the flat pane layer (all loaded, non-inactive scopes) ───────────
  // Memoized so unrelated re-renders (drag flags, group-rect churn) don't rebuild
  // these whole-store maps every frame (Eff #7). The pane layer genuinely needs
  // EVERY scope's tabs (panes stay mounted across switches), so the subscription
  // stays broad — but the rebuild is now keyed to the inputs that change it.
  const inactiveScopes = useMemo(
    () => new Set(projects.filter((p) => p.status === "inactive").map((p) => p.id)),
    [projects],
  );
  const allTabs = useMemo(
    () =>
      Object.entries(tabsByScope).flatMap(([s, scopeTabs]) =>
        !inactiveScopes.has(s)
          ? scopeTabs.map((tab) => ({ tab, scopeKey: s }))
          : [],
      ),
    [tabsByScope, inactiveScopes],
  );
  // For each current-scope group: its active (visible) tab key, and the group id
  // holding each visible tab key. Rebuilt only when the current scope's layout
  // tree changes — not on every render.
  const { activeKeyOfGroup, groupOfKey } = useMemo(() => {
    const activeKeyOfGroup = new Map<string, string>();
    const groupOfKey = new Map<string, string>();
    for (const g of allGroups(layoutByScope[scope] ?? null)) {
      if (g.activeKey) activeKeyOfGroup.set(g.id, g.activeKey);
      for (const k of g.tabKeys) groupOfKey.set(k, g.id);
    }
    return { activeKeyOfGroup, groupOfKey };
  }, [layoutByScope, scope]);
  // Groups whose active tab is a scroll-syncable viewer (text/code, markdown, or
  // PDF). Only these can host the divider scroll-link button, and only these are
  // considered valid link endpoints. Rebuilt when the layout or tabs change.
  const syncableGroups = useMemo(() => {
    const byKey = new Map(tabs.map((t) => [t.key, t]));
    const set = new Set<string>();
    for (const g of allGroups(layoutByScope[scope] ?? null)) {
      const t = g.activeKey ? byKey.get(g.activeKey) : undefined;
      if (
        t?.kind === "embed" &&
        (t.viewer === "text" || t.viewer === "markdown" || t.viewer === "pdf")
      ) {
        set.add(g.id);
      }
    }
    return set;
  }, [layoutByScope, scope, tabs]);
  // Drop any scroll-link whose endpoints are no longer both syncable viewers
  // (a subwindow's active tab changed to a shell/image, or the group vanished).
  useEffect(() => {
    useScrollSyncStore.getState().prune(syncableGroups);
  }, [syncableGroups]);
  // #62: fullscreen is active only when the stored group actually exists in the
  // current scope (a stale id from another scope is ignored). When active, the
  // fullscreened group's pane is sized to the whole panel and all others hidden.
  const fsActive = fullscreenGroupId != null && groupRects[fullscreenGroupId] != null;
  const panelRect = panelRef.current?.getBoundingClientRect();
  const fullRect: Rect | undefined = panelRect
    ? { left: 0, top: 0, width: panelRect.width, height: panelRect.height }
    : undefined;

  return (
    <div
      ref={panelRef}
      className={`center-panel${dragging ? " dragging" : ""}${fsActive ? " fullscreen" : ""}${windowMoving ? " moving" : ""}`}
    >
      {/* Subwindow frame layer: the recursive layout tree for the current scope.
          Each group body is an empty measured slot; panes are positioned over
          it by the flat layer below. */}
      {renderLayout ? (
        <LayoutTree
          node={renderLayout}
          projectCwd={newTabCwd}
          resizeSplit={resizeSplit}
          mergeGroups={mergeGroups}
          panelRef={panelRef}
          registerGroupBody={registerGroupBody}
          onResized={measure}
          syncableGroups={syncableGroups}
        />
      ) : (
        // No tabs yet: render an empty subwindow so its tab bar's "+" is always
        // available to create the first tab. EMPTY_GROUP_ID isn't a real group
        // (the store has no layout) — the add menu's addTab() creates the root
        // group, which then replaces this placeholder with a real LayoutTree.
        <Subwindow groupId={EMPTY_GROUP_ID} projectCwd={newTabCwd}>
          {/* Measured like a real group body so a file dragged from the right
              panel can drop anywhere over the (full-panel) empty placeholder and
              become the first tab — see commitFileDrop's empty-state branch. */}
          <div
            ref={registerGroupBody(EMPTY_GROUP_ID)}
            className="center-placeholder"
            style={{ height: "100%" }}
          >
            <div className="center-placeholder-card">
              <div className="center-placeholder-title">{t("centerPanel.noTabsOpen")}</div>
              <div className="center-placeholder-hint">
                {t("centerPanel.noTabsHintPre")} <span className="center-placeholder-key">+</span>{" "}
                {t("centerPanel.noTabsHintPost")}
              </div>
            </div>
          </div>
        </Subwindow>
      )}

      {/* Pane layer: every tab across every scope, kept mounted. A pane is shown
          only when its tab is the active tab of its current-scope group, sized
          to that group's measured body rect. */}
      <div className="pane-layer">
        {allTabs.map(({ tab, scopeKey }) => {
          const isCurrentScope = scopeKey === scope;
          const groupId = isCurrentScope ? groupOfKey.get(tab.key) : undefined;
          // While a group is fullscreen, only that group's active pane shows.
          const visible =
            isCurrentScope &&
            // The root console shows the root scope's tabs itself (attach-only
            // views of these panes), and an app overlay's docked agent column
            // shows one root tab the same way. With no project open the root
            // scope is also what THIS panel shows, and two visible views of one
            // PTY would take turns resizing it — so the panel's copy stands
            // down: the whole root scope while the console is up, the docked
            // key while a column draws it. The slot is left empty meanwhile.
            !(rootConsoleOpen && scopeKey === ROOT_SCOPE) &&
            !(scopeKey === ROOT_SCOPE && overlayAgentShown.has(tab.key)) &&
            groupId != null &&
            activeKeyOfGroup.get(groupId) === tab.key &&
            (!fsActive || groupId === fullscreenGroupId);
          // The fullscreened group's pane is stretched over the whole panel; all
          // others keep their measured rect (but are hidden by `visible` above).
          const rect =
            fsActive && groupId === fullscreenGroupId
              ? (fullRect ?? (groupId ? groupRects[groupId] : undefined))
              : groupId
                ? groupRects[groupId]
                : undefined;
          const style: React.CSSProperties = visible && rect
            ? {
                display: "flex",
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                // Lift the fullscreened pane above the frame layer (tab bars).
                ...(fsActive && groupId === fullscreenGroupId ? { zIndex: 5 } : {}),
              }
            : { display: "none" };
          // Mount-free remote, per-pane gating. A remote project's LOCAL panes
          // run on the mirror and work offline; only remote-I/O panes must wait
          // for the pool. Keyed by THIS pane's scope (not the active project) so
          // a disconnected remote project switched away from never un-holds.
          const paneProject = projects.find((p) => p.id === scopeKey);
          // A box scope's Mobile switch (#31aa) plays the project's part below:
          // an agent tab of the box gets tmux underneath it — the one thing
          // that makes it attachable from the phone — by the box's own switch.
          const paneBox = scopeKey.startsWith(BOX_SCOPE_PREFIX)
            ? boxes.find((b) => `${BOX_SCOPE_PREFIX}${b.id}` === scopeKey)
            : undefined;
          const paneRemoteProj = !!paneProject?.remote;
          const paneDisconnected =
            paneRemoteProj && remoteSshByProject[scopeKey]?.ssh !== "connected";
          // A terminal pane runs on a remote host when its effective locality
          // resolves to one (primary or a worker). Held while THAT host's pool is
          // down: spawning `ssh -tt` now would block on the dead pool. Multi-host:
          // a pane on gpu-2 holds iff gpu-2 is down, independent of the primary
          // (plan §4.5).
          const rawHostId = remoteHostIdOf(
            effectiveTabLocation(tab, { vmProject: !!paneProject?.vm?.enabled }),
          );
          // A tab naming a worker that no longer exists (machine removed) falls
          // back to the primary — matching the backend's wrap_pty_options (plan §8).
          const paneHostId =
            rawHostId && rawHostId !== "primary" &&
            !paneProject?.compute_hosts?.some((h) => h.id === rawHostId)
              ? "primary"
              : rawHostId;
          const paneHostSsh =
            paneHostId === "primary"
              ? remoteSshByProject[scopeKey]?.ssh
              : paneHostId
                ? remoteSshByHost[scopeKey]?.[paneHostId]?.ssh
                : undefined;
          const holdRemoteTerminal =
            paneRemoteProj &&
            isPtyTabKind(tab.kind) &&
            paneHostId !== null &&
            paneHostSsh !== "connected";
          // The label of the host this pane runs on (primary host, or the worker's
          // label), for the hold placeholder + hover card.
          const paneHostLabel =
            paneHostId === "primary" || paneHostId === null
              ? (paneProject?.remote?.host ?? "")
              : (() => {
                  const w = paneProject?.compute_hosts?.find((h) => h.id === paneHostId);
                  return w?.label || w?.host || paneHostId;
                })();
          // The Files-tab browse dir: while a remote project is disconnected the
          // SFTP tree can't be listed (it would freeze the main thread), so browse
          // the local mirror instead — the same synced working copy the local tabs
          // use. FileBrowser re-lists on `projectDir` change, so it swaps back to
          // the remote tree once the pool connects. (Resolved here, not inside
          // TabPane, because the popout has no projects store to resolve it.)
          const filesProjectDir = paneDisconnected
            ? localTabCwd(
                { kind: "files" },
                {
                  isRemoteProject: true,
                  projectDirectory: resolveProjectDirectory(paneProject),
                  mirror: resolveLocalMirror(paneProject),
                  fallback: tab.cwd,
                },
              )
            : tab.cwd;
          // SSH-sync Phase 0: a local-on-remote tab runs in the project's local
          // mirror (state dir), not the remote tree it can't reach.
          const terminalCwd = localTabCwd(tab, {
            isRemoteProject: !!paneProject?.remote,
            projectDirectory: resolveProjectDirectory(paneProject),
            mirror: resolveLocalMirror(paneProject),
            fallback: tab.cwd,
          });
          // Run this tab inside the project's session container when the toggle is
          // on: every PTY tab except `local_agent` (host-bound) execs into the one
          // shared container. Local projects only. Derived here so restored tabs
          // are covered too. NOTE: this flag is in TerminalView's spawn deps —
          // flipping the toggle respawns every live tab (ProjectPill confirms when
          // that would destroy a non-resumable agent conversation).
          //
          // `scope: "agents"` narrows it to agent tabs, leaving shells (and the
          // viewer's Run/Debug, which IS a shell tab) on the host. This mirrors
          // `services::sandbox::resolve_spawn_authority`, which re-derives the same
          // answer from the trusted project record and remains the authority — the
          // copy is here for the two things only the renderer can do: keep a live
          // shell from staying inside the container after the scope changes (the
          // flag is a spawn dep, so the change respawns exactly the affected tabs),
          // and avoid claiming a container the backend is about to take away.
          const containerScope = paneProject?.sandbox?.scope ?? "all";
          const sandbox =
            (tab.kind === "agent" || tab.kind === "shell") &&
            (containerScope === "all" || tab.kind === "agent") &&
            scopeKey !== "root" &&
            !!paneProject?.sandbox?.enabled &&
            !paneProject?.remote;
          // Persistent sessions (TODO #85): the stable, persisted session name to
          // wrap a shell/script tab in a tmux session, so a long run survives — for a
          // REMOTE tab an SSH drop / relaunch (default ON per project, opt out via
          // the pill toggle), for a LOCAL tab a Tabtivity crash (default ON on Unix via
          // `persist_local_sessions`). Remote shell/script AND remote agent tabs
          // (`shouldPersistTab`; the agent's process reattaches, composing with its
          // own `--resume`); local persistence stays shell-only
          // (`shouldPersistLocalTab`); never the root scope. In TerminalView's spawn
          // deps, so toggling respawns the tab. Undefined ⇒ no tmux wrap.
          const localRunning =
            !paneProject?.remote ||
            effectiveTabLocation(tab, { vmProject: !!paneProject?.vm?.enabled }) === "local";
          const mobileReadyKey = `${scopeKey}/${tab.key}`;
          if (!mobileAgentTmuxReady.current.has(mobileReadyKey)) {
            mobileAgentTmuxReady.current.set(
              mobileReadyKey,
              !!paneProject?.[MOBILE_ACCESS_KEY] || !!paneBox?.[MOBILE_ACCESS_KEY],
            );
          }
          const tmuxSession =
            shouldPersistTab(tab.kind, paneHostId, paneProject?.remote, tab.ephemeral) ||
            shouldPersistLocalTab(
              tab.kind,
              scopeKey,
              localRunning,
              localPersistEnabled,
              mobileAgentTmuxReady.current.get(mobileReadyKey) === true,
              isResumableAgentTab(tab) || isRelaunchableLocalTab(tab) || isSavedWhileLive(tab),
            )
              ? tab.tmuxSession
              : undefined;
          return (
            <div
              key={`${scopeKey}/${tab.key}`}
              className="center-pane"
              // Lets a tab drag locate this pane's live DOM to clone a content
              // thumbnail into the drag ghost (see DragGhost / startTabDrag).
              data-scope-key={scopeKey}
              data-tab-key={tab.key}
              // Clicking anywhere in a pane focuses its subwindow. The panes sit
              // in this layer ABOVE the .subwindow frame, so Subwindow's own
              // mousedown-capture only sees clicks on its tab bar — the body
              // clicks land here. Capture-phase + no preventDefault so the
              // terminal/viewer still receives the click for focus/selection.
              onMouseDownCapture={() => {
                if (!groupId) return;
                const t = useTabsStore.getState();
                if (t.focusedGroupId !== groupId) t.focusGroup(groupId);
              }}
              style={style}
            >
              {/* The shared per-tab render switch (`components/tabs/TabPane`), the
                  SAME one every detached popout renders. The main window owns the
                  projects store, so it resolves the mirror/sandbox/hold props the
                  popout can't. New pane kinds/props go in TabPane so they reach
                  both windows at once. */}
              <TabPane
                tab={tab}
                scope={scopeKey}
                visible={visible}
                // The root console owns the keyboard while it is up; flipping
                // this back on close is what returns focus to the pane under it.
                focused={visible && windowFocused && !rootConsoleOpen && groupId === focusedGroupId}
                groupId={groupId}
                onConnect={getConnect(scopeKey)}
                holdRemoteTerminal={holdRemoteTerminal}
                remoteHost={paneHostLabel}
                filesProjectDir={filesProjectDir}
                terminalCwd={terminalCwd}
                sandbox={sandbox}
                tmuxSession={tmuxSession}
                vmProject={!!paneProject?.vm?.enabled}
              />
            </div>
          );
        })}
      </div>

      {/* Split preview: darkens the half (or whole, for center) a drop would
          carve out. Rendered here — above the pane layer — because an opaque
          terminal pane (z-index:2) would otherwise paint over it if it lived in
          a subwindow body. Coordinates come from the same measured group rects. */}
      <SplitPreviewOverlay groupRects={groupRects} />

      {/* Focus frame (always) + Ctrl+Shift+↑/↓ subwindow numbering (transient), drawn
          above the pane layer for the same reason as the split preview — the
          opaque panes (z-index:2) would otherwise cover an in-body frame. */}
      <FocusFrameOverlay
        groupRects={groupRects}
        frameRects={groupFrameRects}
        orderedIds={allGroups(layoutByScope[scope] ?? null).map((g) => g.id)}
      />

      {/* Floating ghost following the pointer during a drag. */}
      <DragGhost />

      {/* One-shot send-off when a tab/subwindow is dropped out to its own window. */}
      <DetachFlourish />
    </div>
  );
}

/**
 * The one-shot "fly-out" played when a tab or subwindow is dropped OUT of the
 * main window into its own OS window (see stores/drag/detachAnim). A card appears at
 * the gesture's last in-window position and — via a CSS animation — lifts,
 * scales, and fades while sliding toward the edge the content exited through, so
 * the detach reads as the content being ejected into its own window. Clears
 * itself on `animationend` (matched by nonce, so a fresh fly-out isn't cut off).
 * Portalled to document.body so it isn't clipped by the panel. Honors
 * prefers-reduced-motion via the CSS (the animation collapses to a quick fade).
 */
export function DetachFlourish() {
  const flourish = useDetachAnimStore((s) => s.flourish);
  const clear = useDetachAnimStore((s) => s.clear);
  if (!flourish) return null;
  const { x, y, w, h, label, dx, dy, nonce } = flourish;
  return createPortal(
    <div
      key={nonce}
      className="tab-detach-flourish"
      style={
        {
          left: x,
          top: y,
          width: w,
          height: h,
          "--fly-dx": `${dx}px`,
          "--fly-dy": `${dy}px`,
        } as React.CSSProperties
      }
      onAnimationEnd={() => clear(nonce)}
    >
      <div className="tab-detach-flourish-label">{label}</div>
    </div>,
    document.body,
  );
}

/**
 * The translucent half/whole highlight previewing where a drop lands, drawn in
 * panel coordinates above the pane layer. Subscribes to the drag store with two
 * PRIMITIVE selectors (overGroup + edge) rather than the whole drag object, so
 * move()'s per-frame coord churn — which leaves these two equal — never
 * re-renders it; only setTarget (a changed target) does. Preserves the no-churn
 * design while letting the preview sit in CenterPanel's stacking context.
 */
export function SplitPreviewOverlay({ groupRects }: { groupRects: Record<string, Rect> }) {
  const overGroup = useDragStore((s) => s.drag?.overGroup ?? null);
  const edge = useDragStore((s) => s.drag?.edge ?? null);
  if (!overGroup || !edge) return null;
  const r = groupRects[overGroup];
  if (!r) return null;
  const ins = previewInset(edge);
  const left = r.left + ins.left * r.width;
  const top = r.top + ins.top * r.height;
  const width = r.width * (1 - ins.left - ins.right);
  const height = r.height * (1 - ins.top - ins.bottom);
  return <div className="split-preview" style={{ left, top, width, height }} />;
}

/**
 * The focused-subwindow marker, drawn above the pane layer (see the render site
 * for why). Two roles:
 *  - Always: a light accent frame around the focused subwindow's pane rect.
 *  - While Ctrl+Shift+↑/↓ subwindow-nav is active: the frame follows the previewed
 *    group and every subwindow shows a numbered badge — the committed focus is
 *    0, others numbered in document order (wrapping) so ↑/↓ read as relative
 *    steps. Focus commits (moving the frame's committed home) on Shift release.
 *  - While keyboard steering mode is active: the SAME badges, anchored to the
 *    committed focus (steering arrows commit immediately, so there is no
 *    preview id — the badges re-anchor after every step). Deliberately the
 *    relative ↓/↑ labels, not absolute digits: in steering the digits 1–9
 *    belong to the project stations, and a second set of digits here would
 *    collide with them.
 * `pointer-events: none`, panel-relative coords from the same measured rects.
 */
/** `.subwindow-number`'s height (subwindows.css). */
const SUBWINDOW_NUMBER_SIZE = 18;

export function FocusFrameOverlay({
  groupRects,
  frameRects,
  orderedIds,
}: {
  groupRects: Record<string, Rect>;
  frameRects: Record<string, Rect>;
  orderedIds: string[];
}) {
  const focusedGroupId = useTabsStore((s) => s.focusedGroupId);
  const navActive = useSubwindowNavStore((s) => s.active);
  const previewGroupId = useSubwindowNavStore((s) => s.previewGroupId);
  const steeringActive = useKeyboardSteeringStore((s) => s.active);
  // Only the OS-focused window draws its focus frame, so a blurred main window
  // doesn't show an active subwindow alongside a focused popout (#42).
  const windowFocused = useWindowFocused();

  const frameId = navActive && previewGroupId ? previewGroupId : focusedGroupId;
  // Prefer the whole-subwindow rect (tab bar + body); fall back to the pane
  // region if a subwindow box wasn't measured (e.g. the empty-scope slot).
  const frameRect = frameId
    ? (frameRects[frameId] ?? groupRects[frameId])
    : undefined;
  const n = orderedIds.length;
  const f = frameId ? orderedIds.indexOf(frameId) : -1;

  // Colour the focus frame with the focused subwindow's active-tab group colour
  // (the same TAB_ACCENT that paints that tab's stripe), so the frame and the
  // current tab read as one continuous accent. Falls back to the CSS default
  // (var(--accent)) when the kind can't be resolved.
  const layout = useTabsStore((s) => s.layoutByScope[s.scope] ?? null);
  const tabEntries = useTabsStore((s) => s.tabsByScope[s.scope]);
  const activeTabKey = frameId ? findGroup(layout, frameId)?.activeKey : null;
  const activeKind = activeTabKey
    ? tabEntries?.find((t) => t.key === activeTabKey)?.kind
    : undefined;
  const frameColor = activeKind ? TAB_ACCENT[activeKind] : undefined;

  return (
    <>
      {windowFocused && frameRect && (
        <div
          className="focus-frame"
          style={{
            left: frameRect.left,
            top: frameRect.top,
            width: frameRect.width,
            height: frameRect.height,
            outlineColor: frameColor,
          }}
        />
      )}
      {(navActive || steeringActive) &&
        f >= 0 &&
        orderedIds.map((id, p) => {
          const r = groupRects[id];
          if (!r) return null;
          const down = (p - f + n) % n;
          const up = (n - down) % n;
          const label =
            down === 0 ? "0" : down <= up ? `${down}↓` : `${up}↑`;
          // On the tab bar's drag grip (the strip between the subwindow's top
          // and its pane), not the pane's corner: there it covered the agent
          // prompt strip / the terminal's first line. No bar measured (the
          // empty-scope slot) → the pane corner.
          const fr = frameRects[id];
          const bar = fr ? r.top - fr.top : 0;
          const pos =
            fr && bar >= SUBWINDOW_NUMBER_SIZE
              ? {
                  left: fr.left + 3,
                  top: fr.top + (bar - SUBWINDOW_NUMBER_SIZE) / 2 + 2,
                }
              : { left: r.left + 6, top: r.top + 6 };
          return (
            <div key={id} className="subwindow-number" style={pos}>
              {label}
            </div>
          );
        })}
    </>
  );
}

/**
 * The dragged tab floating at the pointer: its label plus, for tab drags, a
 * scaled thumbnail of the tab's live CONTENT (a clone captured at drag start)
 * so it's clear WHAT is moving, not just where it lands. Subscribes to the drag
 * store itself (rather than via CenterPanel props) so the panel doesn't re-render
 * on every pointermove. Rendered into document.body so it isn't clipped.
 */
const GHOST_THUMB_W = 280; // px; the thumbnail's on-screen width.

export function DragGhost() {
  const t = useT();
  // Eff #14: subscribe to COARSE PRIMITIVE selectors (mirroring
  // SplitPreviewOverlay / stores/drag/drag.ts), not the whole `drag` object. The
  // ghost still re-renders each frame to follow the pointer (pointerX/Y change),
  // but the heavy `previewNode` / its dimensions are read as stable primitives,
  // so the clone-mount effect's deps don't churn and React diffs only the moved
  // position. `active` gates the whole render off when no drag is in flight.
  const active = useDragStore((s) => s.drag != null);
  const pointerX = useDragStore((s) => s.drag?.pointerX ?? 0);
  const pointerY = useDragStore((s) => s.drag?.pointerY ?? 0);
  const label = useDragStore((s) => s.drag?.label ?? "");
  // During a file drag (pointer-based drag-to-tab) the ghost lists the available
  // drop options so the user can see what each release will do.
  const isFileDrag = useDragStore((s) => s.drag?.kind === "file");
  const node = useDragStore((s) => s.drag?.previewNode ?? null);
  const srcW = useDragStore((s) => s.drag?.previewW ?? 0);
  const srcH = useDragStore((s) => s.drag?.previewH ?? 0);
  const thumbRef = useRef<HTMLDivElement>(null);

  // Track Shift/Ctrl live so the options legend can highlight "force new
  // window" / "copy out to another app" while the file drag is in flight (a
  // modifier can toggle without a pointer move, which wouldn't otherwise
  // re-render the ghost). Ctrl only marks the option here — FileTree's own
  // drag gesture decides when to actually hand off to the native OS drag.
  const [shiftHeld, setShiftHeld] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  useEffect(() => {
    if (!isFileDrag) return;
    const sync = (e: KeyboardEvent) => {
      setShiftHeld(e.shiftKey);
      setCtrlHeld(e.ctrlKey);
    };
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      setShiftHeld(false);
      setCtrlHeld(false);
    };
  }, [isFileDrag]);

  // Mount the cloned pane once per drag and scale it to fit GHOST_THUMB_W. Done
  // in an effect (not inline) so the heavy clone isn't re-appended on every
  // pointermove re-render — only the ghost's left/top change then.
  useEffect(() => {
    const holder = thumbRef.current;
    if (!holder || !node || srcW <= 0) return;
    const scale = GHOST_THUMB_W / srcW;
    node.style.transformOrigin = "top left";
    node.style.transform = `scale(${scale})`;
    holder.appendChild(node);
    return () => {
      if (node.parentNode === holder) holder.removeChild(node);
    };
  }, [node, srcW]);

  if (!active) return null;
  const thumbH = node && srcW > 0 ? (srcH * GHOST_THUMB_W) / srcW : 0;
  return createPortal(
    <div className="tab-drag-ghost" style={{ left: pointerX, top: pointerY }}>
      <div className="tab-drag-ghost-label">{label}</div>
      {isFileDrag ? (
        <div className="tab-drag-ghost-opts">
          {/* Exactly ONE option is marked at a time — it is what THIS release
              would do. Ctrl (copy out) wins over Shift (force a new window),
              matching the drag itself: once the cursor leaves the window with
              Ctrl held, the OS drag owns the drop and the in-app targets are
              out of the picture. */}
          <div className="tab-drag-ghost-opt">{t("tabDrag.dropFolder")}</div>
          <div className={`tab-drag-ghost-opt${!shiftHeld && !ctrlHeld ? " active" : ""}`}>
            {t("tabDrag.dropOpen")}
          </div>
          <div className={`tab-drag-ghost-opt${shiftHeld && !ctrlHeld ? " active" : ""}`}>
            {t("tabDrag.shiftNewWindow")}
          </div>
          <div className={`tab-drag-ghost-opt${ctrlHeld ? " active" : ""}`}>
            {t("tabDrag.ctrlCopyOut")}
          </div>
        </div>
      ) : null}
      {node ? (
        <div
          className="tab-drag-ghost-thumb"
          ref={thumbRef}
          style={{ width: GHOST_THUMB_W, height: thumbH }}
        />
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * The scroll-link toggle that sits on the divider between two side-by-side
 * viewer subwindows. When enabled, scrolling one subwindow proportionally
 * scrolls the other (see stores/viewers/scrollSync). Subscribes narrowly to its own
 * linked state so unrelated link changes don't re-render it. Stops pointer/click
 * propagation so toggling never starts a divider resize drag.
 */
function ScrollLinkButton({ a, b }: { a: string; b: string }) {
  const t = useT();
  const linked = useScrollSyncStore((s) => s.links[a] === b);
  const toggleLink = useScrollSyncStore((s) => s.toggleLink);
  return (
    <button
      type="button"
      className={`split-scroll-link-btn${linked ? " linked" : ""}`}
      title={linked ? t("scrollLink.unlink") : t("scrollLink.link")}
      aria-pressed={linked}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        toggleLink(a, b);
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
        <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
      </svg>
    </button>
  );
}

// ── Recursive layout renderer ────────────────────────────────────────────────

interface TreeProps {
  node: LayoutNode;
  projectCwd: string;
  resizeSplit: (splitId: string, dividerIndex: number, fraction: number) => void;
  /** Merge the two groups adjacent to a divider (double-click). Wired only when
   *  both sides are leaf groups — see the divider's `onDoubleClick`. */
  mergeGroups: (targetGroupId: string, sourceGroupId: string) => void;
  panelRef: React.RefObject<HTMLDivElement>;
  registerGroupBody: (id: string) => (el: HTMLDivElement | null) => void;
  onResized: () => void;
  /** Group ids whose active tab is a scroll-syncable viewer — the divider
   *  scroll-link button only appears between two such groups. */
  syncableGroups: Set<string>;
}

function LayoutTree(props: TreeProps) {
  const { node } = props;
  if (node.type === "group") {
    return (
      <Subwindow groupId={node.id} projectCwd={props.projectCwd}>
        {/* Empty measured body — panes are overlaid by CenterPanel. */}
        <div className="subwindow-pane-slot" ref={props.registerGroupBody(node.id)} />
      </Subwindow>
    );
  }
  return <SplitView {...props} node={node} />;
}

function SplitView(props: TreeProps & { node: Extract<LayoutNode, { type: "split" }> }) {
  const { node } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  // Live DOM handles to each `.split-child`, so a divider drag can resize its two
  // neighbours by writing `flex` directly — no store write per frame.
  const childRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // While a divider is dragging, the in-progress per-child flex sizes. Held in a
  // ref (not state) so the drag never re-renders this subtree; applied to the DOM
  // imperatively. Re-applied after every render (the layout effect below) so a
  // re-render triggered by pane re-measurement (setGroupRects) can't clobber the
  // drag back to the committed store sizes. `null` when no drag is in flight.
  const dragSizesRef = useRef<number[] | null>(null);
  const applyDragSizes = () => {
    const sizes = dragSizesRef.current;
    if (!sizes) return;
    for (const [i, el] of childRefs.current) {
      if (sizes[i] != null) el.style.flex = `${sizes[i]} 1 0`;
    }
  };
  // Runs after every render: if a drag is live, re-assert its sizes over whatever
  // flex React just wrote from the (still-stale) store `node.sizes`.
  useLayoutEffect(applyDragSizes);
  // Minimum subwindow size (px) a divider drag may shrink a pane to, per axis,
  // from global settings (falling back to the built-in default).
  const minWidth = useSettingsStore((s) => s.settings?.min_subwindow_width) ?? DEFAULT_MIN_SUBWINDOW_PX;
  const minHeight = useSettingsStore((s) => s.settings?.min_subwindow_height) ?? DEFAULT_MIN_SUBWINDOW_PX;

  // A mid-flight divider drag's teardown, so unmounting this subtree (scope
  // switch, group close) unbinds the window listeners instead of leaking them.
  const activeDragTeardown = useRef<(() => void) | null>(null);
  useEffect(() => () => activeDragTeardown.current?.(), []);

  const startDrag = (dividerIndex: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    // The container is not itself resized by a divider drag, so its rect is
    // constant for the gesture — measure it once instead of forcing a reflow to
    // re-read it on every pointermove (the flex writes below invalidate layout,
    // so a per-event read would flush a synchronous reflow each time).
    const rect = container.getBoundingClientRect();
    // Coalesce the pane re-measure (props.onResized → getBoundingClientRect per
    // open pane, a forced reflow) into at most one call per animation frame:
    // pointermove fires faster than paint, and only the last position per frame
    // is visible anyway.
    let rafId: number | null = null;
    const scheduleResize = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        props.onResized();
      });
    };

    const onMove = (ev: PointerEvent) => {
      // The new fraction is the pointer position within the SPAN of the two
      // children adjacent to this divider, measured from the container origin
      // (pure math shared with the popout: dividerFraction in stores/tabs).
      const isRow = node.dir === "row";
      const total = isRow ? rect.width : rect.height;
      if (total <= 0) return;
      const pos = isRow ? ev.clientX - rect.left : ev.clientY - rect.top;
      const clamped = dividerFraction(
        node,
        dividerIndex,
        pos,
        total,
        isRow ? minWidth : minHeight,
      );
      const pair = node.sizes[dividerIndex] + node.sizes[dividerIndex + 1];
      // Resize the two neighbours on the DOM (mirrors applyResize: only these two
      // change, the pair sum is preserved) instead of writing the store every
      // frame — the store write rebuilt the whole layout tree and re-rendered the
      // entire pane layer on each move. The store is committed once on release.
      const sizes = [...node.sizes];
      sizes[dividerIndex] = clamped;
      sizes[dividerIndex + 1] = pair - clamped;
      dragSizesRef.current = sizes;
      applyDragSizes();
      // Panes live in CenterPanel's flat overlay, sized to measured rects — they
      // don't reflow with the flex box, so re-measure to reposition them (once
      // per frame, not once per pointermove).
      scheduleResize();
    };
    const teardown = () => {
      activeDragTeardown.current = null;
      unbindRelease();
      window.removeEventListener("pointermove", onMove);
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
    const commit = () => {
      teardown();
      // Commit the final position to the store ONCE. The next render writes these
      // same sizes via `node.sizes`, matching the DOM, so there's no visual jump;
      // clear the override first so the layout effect stops re-asserting it.
      const sizes = dragSizesRef.current;
      dragSizesRef.current = null;
      if (sizes) props.resizeSplit(node.id, dividerIndex, sizes[dividerIndex]);
      props.onResized();
    };
    const abort = () => {
      teardown();
      // No store change happened, so no re-render will overwrite the drag's DOM
      // flex writes — re-assert the committed store sizes ourselves.
      dragSizesRef.current = null;
      for (const [i, el] of childRefs.current) {
        if (node.sizes[i] != null) el.style.flex = `${node.sizes[i]} 1 0`;
      }
      props.onResized();
    };
    // Engine-correct release semantics (the same policy every other drag path
    // routes through): pointerup commits; on WebKitGTK — which frequently fires
    // `pointercancel` INSTEAD of `pointerup` (see the in-window tab-drag effect
    // above) — a cancel commits too, while on engines with a real pointerup a
    // cancel is a genuine capture loss and aborts; Escape always aborts. The
    // bare-`pointerup` pair this replaces left the gesture STUCK mid-drag on
    // Linux whenever the release arrived as a cancel.
    const unbindRelease = bindDragRelease({ onCommit: commit, onAbort: abort });
    window.addEventListener("pointermove", onMove);
    activeDragTeardown.current = teardown;
  };

  return (
    <div
      ref={containerRef}
      className={`split split-${node.dir}`}
      style={{ flexDirection: node.dir === "row" ? "row" : "column" }}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <div
            className="split-child"
            // Registered so a divider drag can resize this child's flex directly
            // on the DOM (see startDrag); the map self-heals on unmount.
            ref={(el) => {
              if (el) childRefs.current.set(i, el);
              else childRefs.current.delete(i);
            }}
            // flex-basis carries the size fraction; grow/shrink let dividers
            // claim their fixed pixels without distorting the ratio noticeably.
            style={{ flex: `${node.sizes[i] ?? 1} 1 0` }}
          >
            <LayoutTree {...props} node={child} />
          </div>
          {i < node.children.length - 1 && (
            <div
              className={`split-divider split-divider-${node.dir}`}
              onPointerDown={startDrag(i)}
              // Double-click merges the two adjacent subwindows into one — but
              // only when both sides are leaf groups (mirroring the ScrollLink
              // guard below); next to a nested split it's a no-op. Survivor is
              // the left/top child; the divider drag uses onPointerDown, so the
              // two gestures don't collide.
              onDoubleClick={() => {
                const a = node.children[i];
                const b = node.children[i + 1];
                if (a.type === "group" && b.type === "group") {
                  props.mergeGroups(a.id, b.id);
                }
              }}
            >
              {/* Scroll-link toggle: only between two adjacent leaf subwindows
                  whose active tabs are both syncable viewers (text/markdown/PDF). */}
              {node.children[i].type === "group" &&
                node.children[i + 1].type === "group" &&
                props.syncableGroups.has(node.children[i].id) &&
                props.syncableGroups.has(node.children[i + 1].id) && (
                  <ScrollLinkButton
                    a={node.children[i].id}
                    b={node.children[i + 1].id}
                  />
                )}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

/** Memoised: it takes no props, so the only thing a re-render of the shell can
 *  hand it is a re-render of the whole workspace — which the shell did on every
 *  hover-open and hover-close of the side panel. Its own state, stores and
 *  contexts still reach it. */
export const CenterPanel = memo(CenterPanelImpl);
