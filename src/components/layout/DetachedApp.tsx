import { useEffect, useMemo, useRef, useState } from "react";
import { useRendererWatchdog } from "../../lib/window/rendererWatchdog";
import { emit, listen } from "@tauri-apps/api/event";
import { detachedWindowVisible } from "../../lib/window/detachedVisibility";
import { answerRetireRequests } from "../../lib/window/unsavedWork";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useSettingsStore,
  applyTheme,
  applyAccent,
  applyCorners,
  applyCursor,
  applyThemeVars,
  applyZoom,
  clampZoom,
  listenSettingsChanged,
  stepZoom,
  THEME_CHANGED_EVENT,
  LANGUAGE_CHANGED_EVENT,
  APPEARANCE_CHANGED_EVENT,
  type AppearancePayload,
} from "../../stores/settings";
import { applyLanguage, useT } from "../../lib/i18n";
import {
  DETACHED_BOUNDS,
  DETACHED_CLOSE,
  DETACHED_DOCK,
  DETACHED_HIDE,
  DETACHED_EDIT,
  DETACHED_GAVE_UP,
  DETACHED_REOPEN,
  DETACHED_REQUEST_SEED,
  DETACHED_ZOOM,
  applyEditToSubtree,
  applyColorToTabs,
  applyMarkToTabs,
  applyTodoToTabs,
  applyStackToTabs,
  applyRenameToTabs,
  applyLocationToTabs,
  detachedSeedEvent,
  detachedStatusEvent,
  mintDetachedSplitIds,
  type DetachedEdit,
  type DetachedParam,
  type DetachedRemoteInfo,
  type DetachedSeed,
  type DetachedStatusPayload,
} from "../../stores/detached";
import {
  installDetachedWindowContext,
  setDetachedWindowContext,
  type DetachedWindowContext,
} from "../../stores/detachedContext";
import { applyDetachedStatus } from "../../stores/activity";
import {
  allGroups,
  allNodeIds as nodeIdsOf,
  orderedTabKeys,
  setDetachedViewerState,
  type LayoutNode,
  type TabEntry,
  type TabKind,
} from "../../stores/tabs";
import { withdrawnTabKinds } from "../../lib/experimental";
import { PLATFORM } from "../../lib/platform";
import { useTabLandStore } from "../../stores/drag/tabLand";
import { startFocusTracking, useQuiesce } from "../../stores/power";
import { clearStrayFullscreen } from "../../lib/window/strayFullscreen";
import { useFullscreenMode } from "../../lib/window/fullscreenMode";
import { applyFastModeAttribute, useFastMode } from "../../lib/agents/fastMode";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { installWindowsEvents } from "../../stores/windows";
import { listenPdfReveal } from "../../stores/viewers/pdfSync";
import { listenEditorJump } from "../../stores/viewers/editorJump";
import { listenTexCenter } from "../../stores/viewers/texCenter";
import { chordMatches, resolveChord, zoomFor, type ShortcutMap } from "../../lib/shortcuts/shortcuts";
import { DetachedCenterPanel } from "./DetachedCenterPanel";
import { BrowserDownloadHost } from "../browser/BrowserDownloadHost";
import { ExecTrustHost } from "../common/ExecTrustHost";
import { SyncConfirmDialog } from "../common/SyncConfirmDialog";
import { HpcGuardDialog } from "../common/HpcGuardDialog";
import { UnfencedPlatformDialog } from "../common/UnfencedPlatformDialog";
import { ScreenshotSaveOverlay } from "./ScreenshotSaveOverlay";
import { DetachedCloseChoice } from "./DetachedCloseChoice";

interface Props {
  param: DetachedParam;
}

/**
 * How long the detached window keeps asking the main window for its seed before
 * giving up and closing itself. The host populates `detachedGroupsByScope` and
 * answers seed requests essentially instantly (the store entry is written before
 * the OS window is even spawned), so any window that hasn't seeded within this
 * window has nothing to render — its group was closed/docked while the OS window
 * lingered, or the host is gone. Rather than strand it on "Loading subwindow…"
 * forever, auto-close it. Generous enough to outlast a slow main-window startup.
 */
const SEED_TIMEOUT_MS = 8000;

/**
 * #42: the detached window's React root. INERT to project switches by design —
 * it does NOT mount `listenProjectRuntimeSwitched`, the projects store, or
 * CenterPanel's scope-switch effect. It renders exactly one group, seeded over a
 * Tauri event from the main window, and streams edits back. The detached
 * window's *parking* is driven entirely by the backend moving its OS window
 * between desktops on project switch; its renderer stays still.
 */
export function DetachedApp({ param }: Props) {
  const t = useT();
  const loadSettings = useSettingsStore((s) => s.load);
  const label = getCurrentWindow().label;

  // The popout's content tree. Usually a single group; can become a SplitNode
  // once split-in-popout (multi-pane) lands in the renderer (Phase 2).
  const [group, setGroup] = useState<LayoutNode | null>(null);
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  // Group B #237: the WM × asks rather than discarding. `null` = not asking.
  const [closeChoice, setCloseChoice] = useState<null | { resolveDefault: boolean }>(null);
  // Group B #239: whether this window is on screen at all. A parked (project
  // switched away → `hide()`) or minimised popout kept reporting its panes
  // `visible`, so its PTYs went on streaming over IPC and its file views went on
  // polling mtimes — the cost the hidden-pane gating exists to remove, paid by a
  // window nobody can see. Panes below compose their own visibility with this.
  const [windowVisible, setWindowVisible] = useState(true);
  // The owning project's remoteness, streamed in the seed (this window is inert to
  // the projects store). Drives the tab strip's locality badge/menu + machine
  // names; undefined for a local project (no locality axis).
  const [remoteInfo, setRemoteInfo] = useState<DetachedRemoteInfo | undefined>(undefined);

  // This popout's OWN per-window zoom. Restored from the first seed (persisted on
  // the main window's detached entry), then owned locally — Ctrl +/- adjusts it
  // and streams the change back for persistence. Held in a ref so the keydown
  // listener binds once. `zoomSeeded` guards apply-on-seed to the FIRST seed, so a
  // later re-seed (an edit, a tab docked in) can't revert the live zoom.
  const zoomRef = useRef(1);
  const zoomSeeded = useRef(false);

  // Theme injection (same as the main shell), but nothing project-switch-aware.
  // `skipZoom` so we DON'T inherit the main window's `ui_zoom` — a popout owns its
  // own zoom (applied from its seed below), which is what makes zoom per-window.
  useEffect(() => {
    void loadSettings({ skipZoom: true });
  }, [loadSettings]);

  // Group B #226: follow settings written in ANY window. Without this the
  // popout's store kept the snapshot taken at the line above for the rest of its
  // life: its xterm palette stayed on the old scheme after a theme switch (the
  // chrome recoloured — that rides the theme broadcast — the terminal did not),
  // a rebound shortcut, a Fast-mode flip, the min-subwindow size and the
  // energy-saver preference never arrived, and — worse — its next write spread
  // that stale copy back over settings.json, silently undoing everything changed
  // in the main window meanwhile.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenSettingsChanged()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Track THIS window's focus (a popout is its own JS context, so the main
  // window's tracker cannot see it): blur pauses every animation wholesale via
  // `[data-blurred]` and collapses the agent-status glows via
  // `[data-energy-saver]`, so an unfocused popout's render thread can reach a
  // genuine idle instead of repainting glows nobody is looking at.
  useEffect(() => startFocusTracking(), []);
  // A popout has its own renderer, so it runs its own memory watchdog and
  // reloads ITSELF when that renderer runs away (a reload re-seeds the group
  // from the main window, like the crash reporter's reload does). The main
  // window's watchdog cannot do this for it: reloading the main window frees
  // nothing in this process — the 2026-09-01 reload loop. See lib/window/rendererWatchdog.
  useRendererWatchdog();
  // A popout hosts the docked file column → its Apps view needs the same
  // app-windows-changed subscription the main window installs.
  useEffect(() => {
    installWindowsEvents();
  }, []);
  const quiesce = useQuiesce();
  useEffect(() => {
    const root = document.documentElement;
    if (quiesce) root.dataset.energySaver = "on";
    else delete root.dataset.energySaver;
  }, [quiesce]);

  // Fast mode is a global preference, so a popout honours it too — and must
  // publish it onto its OWN document, which is a different one from the main
  // window's (see the focus tracker above for the same reason).
  const fastMode = useFastMode();
  useEffect(() => applyFastModeAttribute(fastMode), [fastMode]);

  // Clear a stray OS fullscreen, exactly as `restore_main_window` does for the
  // main window and for its reason: a `_NET_WM_STATE_FULLSCREEN` window loses
  // `_NET_WM_ACTION_MOVE`, so the WM refuses the `_NET_WM_MOVERESIZE` that
  // `startDragging` sends and this popout can no longer be moved by its titlebar
  // or by a tab bar's grip. The one fullscreen a popout is meant to hold is the
  // user's own fullscreen mode (F11 / the window-controls button), which is
  // recorded (`lib/window/fullscreenMode`) and left alone; this is the net under
  // everything else: a window already stuck in the state when this build loads,
  // or any other path into it, is released rather than left immovable with no
  // visible cause. macOS is excluded for the same reason it is there — its own
  // Space is the expected behaviour and `DeckPresenter` opts into it deliberately.
  //
  // It runs CONTINUOUSLY, not only at mount, and that is the load-bearing part.
  // A mount-only check cannot see the one path that still fullscreens a popout
  // deliberately: `DeckPresenter` fullscreens the window it presents in and undoes
  // it in its cleanup, so a presenter torn down without that cleanup — the webview
  // reloading, an HMR module swap in dev, a crash mid-talk — leaves the window
  // fullscreen with the guard long since finished. And a popout has no OS title
  // bar, so nothing on screen distinguishes that from a merely large window: it
  // has simply stopped being movable, with nothing on screen that says so.
  // Observed live under Muffin — `_NET_WM_ALLOWED_ACTIONS` on the stuck popout had
  // lost `_NET_WM_ACTION_MOVE`, `_NET_WM_ACTION_RESIZE` and both MAXIMIZE atoms.
  //
  // A resize is the signal because every fullscreen transition is one; focus
  // regain is the backstop for a WM that reports the state change without one.
  // Debounced, so an interactive resize drag costs a single check once it settles
  // rather than one IPC round trip per frame.
  //
  // It CLEARS rather than checks-then-clears, and that is the second load-bearing
  // part: `isFullscreen()` does not ask the window manager. tao caches whatever
  // its own `set_fullscreen` last wrote and hands that cache back, so a fullscreen
  // that came from anywhere else — the WM's shortcut, a page's `requestFullscreen`
  // (WebKitGTK fullscreens the toplevel for it), a presenter whose cleanup never
  // ran — reads back `false` for ever and the guard gated on that read did
  // nothing, which is exactly how a popout was found sitting fullscreen and
  // immovable with this effect mounted and running. `setFullscreen(false)` maps
  // onto `gtk_window_unfullscreen()` unconditionally and is a no-op otherwise,
  // which is why the backend clears the main window's the same read-free way.
  // What is deliberately NOT cleared — a talk in progress, the page's own DOM
  // fullscreen — is the pure `mayClearStrayFullscreen`; see `lib/window/strayFullscreen`.
  useEffect(() => {
    if (PLATFORM === "macos") return;
    const win = getCurrentWindow();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Every path in here is wrapped, and that is not defensive habit: this effect
    // runs in a window whose ONLY content is one React root, so a throw out of it
    // unmounts the tree and leaves a grey OS window with nothing on it and no
    // message — observed, from a broken intermediate module during an HMR update.
    // A guard whose failure mode is worse than the state it guards against is not
    // worth having, so it can only ever decline to run.
    const check = () => {
      try {
        if (disposed) return;
        void clearStrayFullscreen();
      } catch {
        /* never take the window down over a fullscreen check */
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, 250);
    };
    check();
    const unlisteners: Array<() => void> = [];
    const bind = (p: Promise<() => void>) => {
      p.then((fn) => (disposed ? fn() : unlisteners.push(fn))).catch(() => {});
    };
    bind(win.onResized(schedule));
    bind(win.onFocusChanged(({ payload }) => payload && schedule()));
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const fn of unlisteners) fn();
    };
  }, []);

  // Per-window zoom via Ctrl +/- / Ctrl+0, handled before any editable-target
  // guard (like F11) so it works from a focused terminal too — the browser-zoom
  // convention. Scales THIS window's webview only and streams the new value back
  // to the main window so it persists on this popout's detached entry.
  useEffect(() => {
    const applyAndPersist = (z: number) => {
      const next = clampZoom(z);
      zoomRef.current = next;
      applyZoom(next);
      void emit(DETACHED_ZOOM, { scope: param.scope, groupId: param.groupId, zoom: next });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Agent panes consume Ctrl +/- for their own font zoom and stopPropagation,
      // so those never reach here — this only fires for the rest of the window.
      const zoom = zoomFor(
        e,
        useSettingsStore.getState().settings?.keyboard_shortcuts as ShortcutMap | undefined,
      );
      if (!zoom) return;
      e.preventDefault();
      applyAndPersist(zoom === "reset" ? 1 : stepZoom(zoomRef.current, zoom === "in" ? 1 : -1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [param.scope, param.groupId]);

  // Ctrl+Shift+T — reopen the last closed agent tab into THIS popout. The
  // closed list lives in the main window, so this only asks (DETACHED_REOPEN).
  // Captured on `document` so it works from a focused terminal like the main
  // window's; unlike there, the key is taken even when nothing is left to
  // reopen, since this window cannot know that without asking.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const overrides = useSettingsStore.getState().settings
        ?.keyboard_shortcuts as ShortcutMap | undefined;
      if (!chordMatches(resolveChord("reopenClosedTab", overrides), e)) return;
      e.preventDefault();
      e.stopPropagation();
      void emit(DETACHED_REOPEN, { scope: param.scope, groupId: param.groupId });
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [param.scope, param.groupId]);

  // This window is its own JS runtime with its own `document` and its own copy
  // of the settings store — a theme change made in the main window's Settings
  // dialog only ever touches ITS document, so without this a popout keeps
  // whatever theme it had at open time. Re-apply live via the cross-window
  // broadcast (see THEME_CHANGED_EVENT in stores/settings).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>(THEME_CHANGED_EVENT, (e) => {
      applyTheme(e.payload);
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Same story for the appearance overrides (custom accent, corner style, the
  // cursor pack):
  // they are inline vars on each window's own root element, so a change in the
  // main window's Settings needs the broadcast to reach this document too. The
  // initial values arrive with the settings load above.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<AppearancePayload>(APPEARANCE_CHANGED_EVENT, (e) => {
      applyAccent(e.payload.accent);
      // After the accent, as everywhere else: an explicit token override wins
      // over the value applyAccent derives from the accent.
      applyThemeVars(e.payload.themeVars);
      applyCorners(e.payload.corners);
      // Last: the cursor art is drawn from the palette the three above set.
      applyCursor(e.payload.cursor);
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Same story for the UI language: this popout holds its own i18n store, so a
  // language switch in the main window's Settings only re-renders that window
  // without the cross-window broadcast. Re-apply live (see LANGUAGE_CHANGED_EVENT).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>(LANGUAGE_CHANGED_EVENT, (e) => {
      applyLanguage(e.payload);
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: when a PDF tab is popped out into THIS window, a SyncTeX forward search
  // from a TeX editor in the main (or another) window reaches us only over a
  // cross-window broadcast. Register the listener so the PDF here reveals/flashes
  // the target box. (The main shell registers the mirror image.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenPdfReveal()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: SyncTeX reverse search may resolve to a source editor hosted in THIS
  // detached window while the PDF the user clicked lives elsewhere (or the jump
  // is applied in the main window). Register the cross-window jump listener so
  // our editor scrolls. (The main shell registers the mirror image.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenEditorJump()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: a reverse-search center switch aimed at a TeX workspace popped out into
  // THIS window. The main window cannot switch our center itself — this heap's
  // workspace renders its ViewerState from a one-time seed, so a main-side
  // `setViewerState` write never reaches it; it broadcasts, and the registry
  // this listener consults holds the mounted workspace's own goTo.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenTexCenter()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // WebKitGTK doesn't reliably fire DOM 'resize' / ResizeObserver for OS-level
  // window size changes. Panes (terminals especially) refit off the DOM 'resize'
  // event, so bridge Tauri's reliable window events into a DOM resize here — the
  // same bridge the main shell installs (AppShell): onResized covers monitor-size
  // switches and drag-resize, onScaleChanged covers moving to a different-DPI
  // monitor (logical viewport changes while WebKitGTK stays silent). rAF-coalesce
  // the live stream so a manual drag-resize doesn't flood listeners, plus a
  // trailing re-fire so a monitor switch measures the settled geometry rather
  // than mid-transition.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let raf = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          window.dispatchEvent(new Event("resize"));
        });
      }
      if (trailing) clearTimeout(trailing);
      trailing = setTimeout(() => {
        trailing = undefined;
        window.dispatchEvent(new Event("resize"));
      }, 250);
    };
    const win = getCurrentWindow();
    win.onResized(fire).then((fn) => unlisteners.push(fn)).catch(() => {});
    win.onScaleChanged(fire).then((fn) => unlisteners.push(fn)).catch(() => {});
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (trailing) clearTimeout(trailing);
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // #42: stream this popout's OS geometry back to the main window (the single
  // persistence owner) so it reopens at the same place/size after a restart. We
  // read position/size straight from the move/resize event payloads (no extra
  // window-getter permissions) and debounce so a drag doesn't flood the channel.
  useEffect(() => {
    const win = getCurrentWindow();
    let pos: { x: number; y: number } | null = null;
    // Group B #236: seeded from the window's ACTUAL physical size, not from the
    // builder's LOGICAL default. `onMoved`/`onResized` payloads are physical, so
    // a popout that was moved but never resized used to flush the literal
    // 900×640 as a physical rect — and respawned at half size on a 2× display.
    // Until the read lands, a flush is refused rather than guessed at.
    let size: { w: number; h: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unMoved: (() => void) | undefined;
    let unResized: (() => void) | undefined;
    let cancelled = false;
    win
      .innerSize()
      .then((s) => {
        if (!cancelled && !size) size = { w: s.width, h: s.height };
      })
      .catch(() => {});
    const flush = () => {
      if (!pos || !size) return;
      // A fullscreen popout's rect is its monitor, not a place to reopen at.
      if (useFullscreenMode.getState().on) return;
      // #238: a park (`hide()`) / unpark (`show()`) can fire Moved/Resized with
      // whatever geometry the WM used while the window was off screen. Persisting
      // that would move the popout on the next launch, so a flush is only taken
      // while the window is actually visible.
      void detachedWindowVisible(win)
        .then((visible) => {
          if (!visible || cancelled || !pos || !size) return;
          void emit(DETACHED_BOUNDS, {
            scope: param.scope,
            groupId: param.groupId,
            bounds: { x: pos.x, y: pos.y, w: size.w, h: size.h },
          });
        })
        .catch(() => {});
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 300);
    };
    win
      .onMoved(({ payload }) => {
        pos = { x: payload.x, y: payload.y };
        schedule();
      })
      .then((fn) => { if (cancelled) fn(); else unMoved = fn; })
      .catch(() => {});
    win
      .onResized(({ payload }) => {
        size = { w: payload.width, h: payload.height };
        schedule();
      })
      .then((fn) => { if (cancelled) fn(); else unResized = fn; })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unMoved?.();
      unResized?.();
    };
  }, [param.scope, param.groupId]);

  // #239: track whether this window is on screen (parked by a project switch,
  // or minimised), so the panes below can stop streaming and polling for a
  // window nobody can see. Polled rather than event-driven: a Tauri-side
  // `hide()` raises no window event the renderer can hear, and the check is one
  // cheap IPC check on the same cadence a hidden pane would otherwise cost far
  // more than. Include Tabtivity's parking state: Wayland does not reliably expose
  // minimization, and a parked surface deliberately remains mapped there.
  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;
    const check = () => {
      detachedWindowVisible(win)
        .then((visible) => {
          if (!cancelled) setWindowVisible(visible);
        })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Native Wayland closes a popout whose scope was left, and the main window
  // rebuilds it on return. Before it goes, the backend asks: settle what
  // autosave would save, and say whether any unsaved work is left — which
  // keeps the window alive (minimized) instead. Attaching the listener also
  // announces this popout as able to answer (`detached_retire_ready`).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    answerRetireRequests(label)
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, [label]);

  // Seed + edit listeners. The main window owns the source of truth and ships
  // the group's tabs + subtree; subsequent main-side edits re-seed.
  //
  // The request MUST be emitted only after our seed listener is actually
  // registered (`listen` resolves async): emitting synchronously races the main
  // window's reply, which can land before we're listening and be lost forever
  // (window stuck on "Loading subwindow…"). We also retry the request until the
  // first seed arrives, so a momentarily-not-yet-ready host can't strand us.
  useEffect(() => {
    let unlistenSeed: (() => void) | undefined;
    let cancelled = false;
    let seeded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    listen<DetachedSeed>(detachedSeedEvent(label), (ev) => {
      seeded = true;
      if (timer) clearTimeout(timer);
      // Restore this popout's own zoom on the FIRST seed only (later re-seeds must
      // not clobber a live zoom the user has since changed). A popout that has its
      // OWN persisted zoom uses it; a brand-new popout with none inherits the main
      // window's current `ui_zoom` at birth (so a 4K user's popouts aren't tiny)
      // and then diverges the moment it's adjusted. Undefined on both ⇒ 100%.
      if (!zoomSeeded.current) {
        zoomSeeded.current = true;
        const mainZoom = useSettingsStore.getState().settings?.ui_zoom;
        zoomRef.current = clampZoom(ev.payload.zoom ?? mainZoom);
        applyZoom(zoomRef.current);
      }
      // Register each seeded tab's viewerState BEFORE rendering, so a viewer pane
      // mounting this frame recovers its per-tab scroll/zoom + #45 autocomplete/
      // spelling overrides (our tabs never enter `useTabsStore`, where the viewer
      // hooks normally read them). Must precede setGroup/setTabs.
      for (const t of ev.payload.tabs) setDetachedViewerState(t.key, t.viewerState);
      setGroup(ev.payload.subtree);
      setTabs(ev.payload.tabs);
      setRemoteInfo(ev.payload.remote);
      // Seed THIS window's otherwise-empty remoteStatus store with every host's
      // live state. The SFTP/SSH pools are process-wide, but the lamps and host
      // gates read this per-window Zustand heap; primary-only seeding made every
      // worker look disconnected in a popout forever.
      const remote = ev.payload.remote;
      if (remote?.project?.remote) {
        const projectId = remote.project.id;
        const status = useRemoteStatusStore.getState();
        status.clear(projectId);
        for (const [hostId, state] of Object.entries(remote.hostStates ?? {})) {
          status.setSsh(projectId, state.ssh, hostId);
          status.setVpn(projectId, state.vpn, hostId);
        }
        // Compatibility with a seed from a backend/frontend heap that predates
        // `hostStates` during a backend-stale development session.
        if (!remote.hostStates && remote.primarySsh) {
          status.setSsh(projectId, remote.primarySsh);
        }
      }
      // …and seed the PROJECTS store the same way (#232). A popout is inert to
      // project switching, but dozens of panes ask that store who this project
      // is — and getting `null` back is what left a local project's popout
      // showing a bare tree: no git bar, no history, no Apps/Sessions view, no
      // remarks, no type tags, no run-host picker, monitoring panes treating a
      // remote project as local, an empty box-member list. Seeding the entry (and
      // a box scope's members) answers all of them at once, rather than
      // threading a project prop through every pane that happens to need one.
      // `activeId` matches the popout's own scope, which is the only project it
      // will ever show. Nothing here drives a switch: `DetachedApp` mounts no
      // runtime-switch listener, so this store is a read-only fact in this window.
      const members = remote?.boxMembers;
      const entry = remote?.project;
      if (members?.length || entry) {
        useProjectsStore.setState({
          projects: members?.length ? members : entry ? [entry] : [],
          ...(entry ? { activeId: entry.id } : {}),
        });
      }
      // `boxMembersOfScope` resolves membership through the box record first;
      // projects alone cannot identify which streamed members belong to this
      // scope. Seed the minimal owning box alongside its projects.
      if (remote?.box) {
        useBoxesStore.setState({ boxes: [remote.box], loaded: true });
      }
      // A tab docked INTO this popout from another window arrives on a seed
      // tagged with its key — play the same drop-in landing as an in-popout
      // merge as it mounts in its destination bar (batched with the state sets
      // above, so the freshly-mounted tab renders with the landing class).
      if (ev.payload.landedKey) {
        useTabLandStore.getState().markLanded(ev.payload.landedKey);
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlistenSeed = fn;
        // Listener is live — now it's safe to ask, and to keep asking until the
        // first seed lands. If none ever does (the host has no record of this
        // group), nothing can render here, so close the window after a grace
        // period instead of stranding it on "Loading subwindow…" forever.
        const deadline = Date.now() + SEED_TIMEOUT_MS;
        const request = () => {
          if (cancelled || seeded) return;
          if (Date.now() >= deadline) {
            // Nothing can render here — but the group may still exist in the
            // main store, and simply destroying this window used to strand it:
            // its tabs were out of the layout, its record persisted
            // `detached: true`, and the failure repeated at every launch (#224).
            // The `WindowEvent::Destroyed` hook tells the main window, which
            // docks any surviving record back once this keeps happening; saying
            // first that this death is our own failure is what lets it.
            void emit(DETACHED_GAVE_UP, { label }).finally(() => {
              void getCurrentWindow().destroy();
            });
            return;
          }
          void emit(DETACHED_REQUEST_SEED, {
            label,
            scope: param.scope,
            groupId: param.groupId,
          });
          timer = setTimeout(request, 250);
        };
        request();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlistenSeed?.();
    };
  }, [label, param.scope, param.groupId]);

  // Apply an edit locally AND stream it to the main window so its
  // `detachedGroupsByScope` entry stays in sync. Held in a ref as well, so the
  // store seam installed below (which binds once) always reaches the current one.
  const pushEdit = (edit: DetachedEdit) => {
    setGroup((g) => (g ? applyEditToSubtree(g, edit) : g));
    if (edit.kind === "rename") {
      setTabs((ts) => applyRenameToTabs(ts, edit.key, edit.label));
    } else if (edit.kind === "setColor") {
      // Optimistic, like the two beside it: the picker stays open after a pick,
      // so the tab has to recolour under it rather than on the re-seed.
      setTabs((ts) => applyColorToTabs(ts, edit.key, edit.color));
    } else if (edit.kind === "setStack") {
      setTabs((ts) => applyStackToTabs(ts, edit.key, edit.stack));
    } else if (edit.kind === "setMark") {
      setTabs((ts) => applyMarkToTabs(ts, edit.key, edit.mark));
    } else if (edit.kind === "setTodo") {
      setTabs((ts) => applyTodoToTabs(ts, edit.key, edit.todoId));
    } else if (edit.kind === "setLocation") {
      // Optimistic: flip the badge now; the main window respawns the pane on the
      // new host and re-derives the same payload.
      setTabs((ts) => applyLocationToTabs(ts, edit.key, edit.location));
    }
    void emit(DETACHED_EDIT, { scope: param.scope, groupId: param.groupId, edit });
  };

  // #234: paint the same working / needs-decision / finished lamps the main
  // window's strip does. The classifier lives there (it is the window that sees
  // every PTY's output); this store has no history to classify from, so the
  // verdict is mirrored over and adopted verbatim.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<DetachedStatusPayload>(detachedStatusEvent(label), (ev) => {
      applyDetachedStatus(ev.payload.scope, ev.payload.status);
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, [label]);

  // Closing the LAST tab closes the whole popout window — an empty detached
  // window has nothing to render (it would strand on "Loading subwindow…").
  // Route it through the same teardown as a WM/title-bar close (DETACHED_CLOSE):
  // the main window kills the remaining tab's PTY, drops the group, and persists.
  // The main store removes the record first, then `attach_subwindow` destroys
  // the OS window. Keeping teardown host-owned is what distinguishes an asked-
  // for close from the Destroyed hook's crash recovery.
  const handleClose = (key: string) => {
    const isLastTab = !group || orderedTabKeys(group).length <= 1;
    if (isLastTab) {
      void emit(DETACHED_CLOSE, { scope: param.scope, groupId: param.groupId, user: true });
      return;
    }
    pushEdit({ kind: "close", key, user: true });
  };

  // Group B #237: put the WHOLE popout back into the main window's tiled layout
  // — the dock-back gesture that has not existed since the 2026-07-19 move-only
  // rework. There was no ⤓ button, grip and titlebar drags became native OS
  // moves, and `DETACHED_DOCK` was listened for but emitted nowhere, so the only
  // way tabs came back was dragging them out one at a time and the WM × threw
  // them away. Without *some* dock-back, every popout failure is tab loss. The
  // main-side ladder was already there; this is the caller it was missing.
  const handleDock = () => {
    void emit(DETACHED_DOCK, { scope: param.scope, groupId: param.groupId });
  };

  // The store seam (#231): while this heap is a popout, tabs-store writes made
  // by PANES — a Ctrl+clicked link in a README, a breakpoint in a .py, a
  // renamed tmux session, "reveal in Files", an agent install — are forwarded to
  // the main window instead of landing in this window's empty store, where they
  // used to silently vanish. Installed once, reading the live callbacks through
  // refs so it never needs re-binding; removed on unmount so a test (or a
  // future in-main mount) cannot inherit it.
  const focusedGroupRef = useRef<string | null>(null);
  const seamRef = useRef({ group, pushEdit, handleClose });
  seamRef.current = { group, pushEdit, handleClose };
  // Installed during RENDER, not in an effect: child effects run before the
  // parent's, so a pane that writes to the tabs store as it mounts (a viewer
  // restoring its state) would find no context and write into the void. The
  // effect below repeats the install after StrictMode cleanup and removes it on
  // a real unmount.
  const detachedContext = useMemo<DetachedWindowContext>(
    () => ({
      scope: param.scope,
      groupId: param.groupId,
      label,
      // Where a new tab lands: the pane the user is working in, resolved at call
      // time (both the focus and the tree move under this binding). Falls back
      // to the popout's first pane, then to its own record id — which
      // `addDetachedTab` reads as "the first group" anyway.
      targetGroupId: () => {
        const tree = seamRef.current.group;
        const groups = tree ? allGroups(tree) : [];
        const focused = focusedGroupRef.current;
        if (focused && groups.some((g) => g.id === focused)) return focused;
        return groups[0]?.id ?? param.groupId;
      },
      pushEdit: (edit) => seamRef.current.pushEdit(edit as DetachedEdit),
      closeTab: (key) => seamRef.current.handleClose(key),
    }),
    [label, param.scope, param.groupId],
  );
  // Render-time installation is deliberate: child effects run before parent
  // effects. The effect repeats it so StrictMode's synthetic cleanup is followed
  // by a real reinstall instead of leaving this heap classified as the main one.
  setDetachedWindowContext(detachedContext);
  useEffect(
    () => installDetachedWindowContext(detachedContext),
    [detachedContext],
  );

  // Withdraw the tabs of an experiment that was switched off — the popout's half
  // of `lib/experimentalSweep`. This window runs its own store and its own
  // settings copy, so the main window's sweep deliberately skips every tab that
  // lives in a popout (`closeTabsOfKinds`) and each popout closes its own,
  // streaming the ordinary `close` edit back so the main window drops the payload.
  // Closing the LAST one closes the window, for the reason handleClose gives —
  // done in one step here rather than by looping through handleClose, whose
  // is-this-the-last-tab check would read the same pre-close tree on every
  // iteration and so never fire.
  const settings = useSettingsStore((s) => s.settings);
  useEffect(() => {
    const withdrawn = new Set<TabKind>(withdrawnTabKinds(settings));
    if (withdrawn.size === 0 || !group) return;
    const inGroup = new Set(orderedTabKeys(group));
    const doomed = tabs.filter((t) => inGroup.has(t.key) && withdrawn.has(t.kind));
    if (doomed.length === 0) return;
    if (doomed.length === inGroup.size) {
      void emit(DETACHED_CLOSE, { scope: param.scope, groupId: param.groupId });
      return;
    }
    for (const tab of doomed) pushEdit({ kind: "close", key: tab.key });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, tabs, group, param.scope, param.groupId]);

  // Hide the WHOLE popout into the main window's side-panel "Hidden subwindows"
  // list. Like handleClose it closes THIS OS window, but the main window PARKS the
  // group (tabs stay mounted, PTYs alive) instead of discarding it — restorable
  // from the panel. Hides the whole window (every pane of a multi-pane popout) as
  // one hidden entry; destroy() bypasses our onCloseRequested so it won't also
  // emit DETACHED_CLOSE (which would drop the tabs).
  const handleHideWindow = () => {
    void emit(DETACHED_HIDE, { scope: param.scope, groupId: param.groupId });
  };

  // Closing this OS window via the WM/title-bar ASKS what to do with the tabs
  // (Group B #237). It used to discard them outright: the group's tabs were
  // closed for good, their PTYs killed, nothing restored — and since there was
  // no dock-back gesture at all, "I closed the popout and lost my terminals" was
  // one stray click away, with the OS close button being the affordance most
  // people reach for first. So the ✕ prevents the default and raises a choice
  // (dock the tabs back / close them), which is also the one place a popout can
  // explain that those are different things. Escape or the backdrop cancels, and
  // the window stays open — the safe default for a gesture that may have been a
  // misclick. Each answer emits its own event and then destroys this window
  // (`destroy()` bypasses this handler, so nothing is emitted twice).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const win = getCurrentWindow();
    win
      .onCloseRequested((event) => {
        event.preventDefault();
        setCloseChoice({ resolveDefault: true });
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!group || allGroups(group).length === 0) {
    return <div className="detached-loading">{t("detached.loadingSubwindow")}</div>;
  }

  return (
    <>
      {/* A popout is its own JS heap with its own browser store, and the backend
          emits browser events to every window — so it needs its own single
          download-consent host for the same reason AppShell does. */}
      <BrowserDownloadHost />
      {/* A popout's viewer can Build or Format, so its exec-trust question
          renders here, in this window's own store. */}
      <ExecTrustHost />
      {/* Same reason: a popout hosts the per-subwindow file viewer, so a pull or
          push can be started in this window and its confirmation has to render
          here — this store instance is this window's. */}
      <SyncConfirmDialog />
      {/* #233: the HPC guard. A ▶ run from a popped-out file tree on a tagged
          host parks a Promise that only this dialog resolves — with no host in
          this window the run hung forever, silently. (The store now also refuses
          rather than parking when no host is mounted, so the two together make
          the hang impossible in either direction.) */}
      <HpcGuardDialog />
      <UnfencedPlatformDialog />
      {/* #233: the screenshot save step. `useScreenshotPendingStore` is
          per-window, so a PDF screenshot taken in a popout raised its overlay
          nowhere: the shot reached the clipboard and the save-to-project half of
          the feature simply never appeared. */}
      <ScreenshotSaveOverlay />
      {closeChoice && (
        <DetachedCloseChoice
          onDock={() => {
            setCloseChoice(null);
            handleDock();
          }}
          onCloseTabs={() => {
            setCloseChoice(null);
            void emit(DETACHED_CLOSE, { scope: param.scope, groupId: param.groupId, user: true });
            // The main window closes this window via `attach_subwindow`; the
            // timer is the net for a main window that is gone or wedged, so the
            // popout can never be stuck un-closable.
            setTimeout(() => {
              void getCurrentWindow().destroy();
            }, 1500);
          }}
          onCancel={() => setCloseChoice(null)}
        />
      )}
      <DetachedCenterPanel
      scope={param.scope}
      popoutId={param.groupId}
      tree={group}
      tabs={tabs}
      remoteInfo={remoteInfo}
      windowVisible={windowVisible}
      onFocusedGroup={(id) => {
        focusedGroupRef.current = id;
      }}
      onActivate={(key) => pushEdit({ kind: "activate", key })}
      onClose={handleClose}
      onDockWindow={handleDock}
      onHideWindow={handleHideWindow}
      onSetLocation={(key, location) => pushEdit({ kind: "setLocation", key, location })}
      onReorder={(tabKeys) => pushEdit({ kind: "reorder", tabKeys })}
      onRename={(key, label) => pushEdit({ kind: "rename", key, label })}
      onSetColor={(key, color) => pushEdit({ kind: "setColor", key, color })}
      onSetStack={(key, stack) => pushEdit({ kind: "setStack", key, stack })}
      onSplit={(key, targetGroupId, edge) => {
        // Mint the new pane's ids HERE and ship them, so the main store names
        // the pane as this window does (see `mintDetachedSplitIds`). The ids
        // already in this popout's tree are passed so a counter reset by a
        // webview reload cannot re-mint one of them (#227).
        const ids = mintDetachedSplitIds(label, group ? nodeIdsOf(group) : []);
        pushEdit({
          kind: "split",
          key,
          targetGroupId,
          edge,
          newGroupId: ids.groupId,
          newSplitId: ids.splitId,
        });
      }}
      onResize={(splitId, dividerIndex, fraction) =>
        pushEdit({ kind: "resize", splitId, dividerIndex, fraction })
      }
      onMove={(key, targetGroupId, index) =>
        pushEdit({ kind: "move", key, targetGroupId, index })
      }
      onAddTab={(tab, targetGroupId, edge) =>
        pushEdit({ kind: "add", tab, targetGroupId, edge })
      }
      onFiles={(groupId, patch) => pushEdit({ kind: "files", groupId, ...patch })}
      />
    </>
  );
}
