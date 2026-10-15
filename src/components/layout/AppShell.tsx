import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PLATFORM } from "../../lib/window/dragPlatform";
import { nextWindowState } from "../../lib/window/windowState";
import { noteAgentSessionStart, noteAgentTurn, notePtyOutput, startActivityTicks } from "../../stores/activity";
import { onAnyTerminalOutput } from "../../lib/terminal/terminalBus";
import { noteActivityDigests, type ActivityDigest } from "../../lib/terminal/activityDigests";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import type { AgentTurnState } from "../../stores/activity";
import {
  usePowerStore,
  useQuiesce,
  saverInterval,
  startFocusTracking,
} from "../../stores/power";
import { applyFastModeAttribute, useFastMode } from "../../lib/agents/fastMode";
import { useOllamaAutoloadOnLaunch } from "../../stores/agents/ollamaAutoload";
import { useRendererWatchdog } from "../../lib/window/rendererWatchdog";
import { livePanelToggleLabel } from "../../lib/shortcuts/shortcutHint";
import { CenterPanel } from "./CenterPanel";
import { HeaderBar } from "./HeaderBar";
import { SidePanel } from "./SidePanel";
import { LogoIcon } from "./LogoIcon";
import { MobileBridgeHost } from "../mobile/MobileBridgeHost";
import { ScreenshotSaveOverlay } from "./ScreenshotSaveOverlay";
import { VpnPasswordPrompt } from "./VpnPasswordPrompt";
import { AlarmPopup } from "../calendar/AlarmPopup";
import { SteeringLegend } from "./SteeringLegend";
import { SteeringPromptOverlay } from "./SteeringPromptOverlay";
import { SteeringConfirmOverlay } from "./SteeringConfirmOverlay";
import { ShortcutHelpOverlay } from "./ShortcutHelpOverlay";
import { RemoteConnectDialog } from "../projects/RemoteConnectDialog";
import { GlobalMachineMonitorDialogHost } from "../monitoring/GlobalMachineMonitorDialog";
import { BigFolderDialogHost } from "../projects/BigFolderExcludeDialog";
import { BoxEditorHost } from "../projects/BoxEditorDialog";
import { BrowserDownloadHost } from "../browser/BrowserDownloadHost";
import { ExecTrustHost } from "../common/ExecTrustHost";
import { OpenExternalHost } from "../common/OpenExternalHost";
import { CalendarOverlayHost } from "../calendar/CalendarOverlay";
import { CalDavSyncHost } from "../calendar/CalDavSyncHost";
import { PrinterNetworkDefaultsHost } from "../printing/PrinterNetworkDefaultsHost";
import { AgentContinueHost } from "./AgentContinueHost";
import { AgentCronHost } from "./AgentCronHost";
import { AgentScheduleHost } from "./AgentScheduleHost";
import { TimerLeaseHost } from "./TimerLeaseHost";
import { WorkspacePatchHost } from "./WorkspacePatchHost";
import { CalDavConflictDialog } from "../calendar/CalDavConflictDialog";
import { RootOverlayHost } from "./RootOverlay";
import { LocalLossDialog } from "../common/LocalLossDialog";
import {
  RailAgentsIcon,
  RailAppsIcon,
  RailChevronIcon,
  RailFilesIcon,
  RailGitIcon,
  RailSwitchSideIcon,
} from "../common/EdgeRailIcons";
import { HostKeyConfirmDialog } from "../common/HostKeyConfirmDialog";
import { HpcGuardDialog } from "../common/HpcGuardDialog";
import { UnfencedPlatformDialog } from "../common/UnfencedPlatformDialog";
import { StopProjectDialog } from "../common/StopProjectDialog";
import { SyncConfirmDialog } from "../common/SyncConfirmDialog";
import { RemoteUsageWarningDialog } from "../common/RemoteUsageWarningDialog";
import { QuickOpen } from "../files/QuickOpen";
import { HintHost } from "./HintHost";
import { TourHost } from "./TourHost";
import { StatsRecapHost } from "../stats/StatsRecapHost";
import { useHintsStore } from "../../stores/hints";
import {
  useProjectsStore,
  listenProjectRuntimeSwitched,
  silentReconnectDeadHost,
} from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { disconnectAllTunnelsOnQuit } from "../../stores/remote/vpn/vpnStatus";
import {
  closeOrphanedPopouts,
  listenDetachedHost,
  shutdownDetachedWindows,
} from "../../stores/detached";
import { listenPdfReveal } from "../../stores/viewers/pdfSync";
import { listenSyncProgress } from "../../stores/remote/sync";
import { autoConnectVpnOnLaunch } from "../../lib/remote/vpn/vpnAutoConnect";
import { initRemoteAutoReconnect } from "../../lib/remote/remoteAutoReconnect";
import { initExperimentalSweep } from "../../lib/experimentalSweep";
import { migrateExperimentalOnce } from "../../lib/experimental";
import { initMachineSync } from "../../lib/remote/machineSync";
import { installWindowsEvents } from "../../stores/windows";
import { listenEditorJump } from "../../stores/viewers/editorJump";
import { listenTexCenter } from "../../stores/viewers/texCenter";
import { listenSourceJump } from "../embed/FileViewerPane";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../../stores/boxes";
import { listenSettingsChanged, useSettingsStore } from "../../stores/settings";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { useTimerStore } from "../../stores/timer";
import { useMailStore } from "../../stores/mail";
import { useTodoStore } from "../../stores/todo";
import { useMachinesOverlayStore } from "../../stores/machinesOverlay";
import { useHpcPipelineStore } from "../../stores/remote/hpc/hpcPipeline";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { useModelsOverlayStore } from "../../stores/modelsOverlay";
import { flushUsage } from "../../stores/usage";
import { useKeyboard } from "../../hooks/useKeyboard";
import { subscribeTauri } from "../../hooks/useTauriListener";
import { useT, useI18nStore, translate, type TranslationKey } from "../../lib/i18n";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { sidePanelViewKey, sidePanelViewPatch } from "../../lib/projects/sidePanelView";
import type { FilesPanelView } from "../../types";
import { noteTerminalOutputChars } from "../../dev/terminalOutputRate";
import { BRAND } from "../../lib/brand";
import { PdfLoadWarningHost } from "./PdfLoadWarningHost";

// Dev-only perf panel (src/dev/). The ternary is statically resolved at build
// time (`import.meta.env.DEV` → false), so in a shipped bundle the lazy() —
// and with it the whole src/dev/ chunk — is dead code and never emitted.
const DevPerfHost = import.meta.env.DEV
  ? lazy(() => import("../../dev/DevPerfHost").then((m) => ({ default: m.DevPerfHost })))
  : null;

// Code-split (startup size): mail and the todo board are reached from nowhere
// but these two overlay hosts, and each host renders null until its store's
// `overlayOpen` is true. Mounting the lazy host only once that flag is set keeps
// both panes' module graphs out of every window's startup chunk; the fetch is
// in-process (the frontend is embedded), and the fallback is `null`, the same
// nothing a closed host renders. The host still applies its own gate
// (`mail_client` / `todo_board`), so the flag alone never shows anything, and
// its first-open work (the Escape listener, `openCard`'s `focusTaskId`) runs on
// mount exactly as it did on the closed-to-open transition: the pane was never
// mounted while closed. The stores are eager anyway (the header indicators read
// them). The calendar overlay's chrome stays static (its hooks run while
// closed too); its pane is the same lazy chunk a calendar tab loads (`TabPane`).
const MailOverlayHost = lazy(() =>
  import("../mail/MailOverlay").then((m) => ({ default: m.MailOverlayHost })),
);
const TodoOverlayHost = lazy(() =>
  import("../todo/TodoOverlay").then((m) => ({ default: m.TodoOverlayHost })),
);

// Mail also stays mounted while a composer tab is open, window closed or not:
// an unfinished mail's text lives in its mounted composer, and unmounting the
// host here would throw it away behind the host's own keep-alive.
function LazyMailOverlayHost() {
  const open = useMailStore((s) => s.overlayOpen);
  const composing = useMailStore((s) => s.mailTabs.some((tab) => tab.kind === "compose"));
  if (!open && !composing) return null;
  return (
    <Suspense fallback={null}>
      <MailOverlayHost />
    </Suspense>
  );
}

function LazyTodoOverlayHost() {
  const open = useTodoStore((s) => s.overlayOpen);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <TodoOverlayHost />
    </Suspense>
  );
}

// Code-split (perf plan §6), the same bargain as mail and to-do above: each of
// these hosts renders null until its store says open, so this shell reads that
// one flag and mounts the lazy host only then; the host keeps its own full
// gate. Their stores live in their own modules, so reading the flag here pulls
// in none of the host's graph. Same DOM position as before (the stacking order
// among `.modal-backdrop`s is DOM order), and the fallback is null, the same
// nothing a closed host renders.
const MachinesOverlayHost = lazy(() =>
  import("../header/MachinesIndicator").then((m) => ({ default: m.MachinesOverlayHost })),
);
const RemoteMachinesDialogHost = lazy(() =>
  import("../projects/RemoteMachinesWindow").then((m) => ({ default: m.RemoteMachinesDialogHost })),
);
const HpcPipelineWizardHost = lazy(() =>
  import("../projects/HpcPipelineWizard").then((m) => ({ default: m.HpcPipelineWizardHost })),
);
const ModelsOverlayHost = lazy(() =>
  import("../models/ModelsOverlay").then((m) => ({ default: m.ModelsOverlayHost })),
);
// First-run and on-demand pages, mounted only while this shell's own state
// shows them.
const HowToStart = lazy(() => import("./HowToStart").then((m) => ({ default: m.HowToStart })));
const RemoteFeaturesPrompt = lazy(() =>
  import("./RemoteFeaturesPrompt").then((m) => ({ default: m.RemoteFeaturesPrompt })),
);
const LessonsMenu = lazy(() => import("./LessonsMenu").then((m) => ({ default: m.LessonsMenu })));

function LazyWhen({ when, children }: { when: boolean; children: ReactNode }) {
  if (!when) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
}

function LazyMachinesOverlayHost() {
  const open = useMachinesOverlayStore((s) => s.open);
  return (
    <LazyWhen when={open}>
      <MachinesOverlayHost />
    </LazyWhen>
  );
}

function LazyRemoteMachinesDialogHost() {
  const open = useRemoteMachinesStore((s) => !!s.projectId);
  return (
    <LazyWhen when={open}>
      <RemoteMachinesDialogHost />
    </LazyWhen>
  );
}

function LazyHpcPipelineWizardHost() {
  const open = useHpcPipelineStore((s) => s.open);
  return (
    <LazyWhen when={open}>
      <HpcPipelineWizardHost />
    </LazyWhen>
  );
}

function LazyModelsOverlayHost() {
  const open = useModelsOverlayStore((s) => s.open);
  return (
    <LazyWhen when={open}>
      <ModelsOverlayHost />
    </LazyWhen>
  );
}

// How long the pointer must rest on the edge rail before the panel reveals
// itself. The hover-open used to be instant, fired by a mousemove anywhere in
// an 8px band at the window edge — and once the rail became a full-height bar
// sitting on that band, every approach to a tab crossed it: the panel opened
// on some OTHER view, the rail unmounted, and the button vanished from under a
// click that had not landed yet. That is what made the tabs feel unreliable.
// A dwell makes hover-open deliberate, and a dwell that settles on a tab opens
// the panel on THAT tab's view — the very thing the click would have done — so
// whichever of press and dwell comes first, the user gets what they pointed at.
// Crossing a tab on the way to another restarts the dwell for the new one.
const RAIL_DWELL_MS = 400;
// How long a hover-opened panel waits for the pointer before it gives up on it
// (see `hoverGuard`). Longer than the panel's slide (--transition-slow, 240ms)
// so a pointer resting where the panel is about to arrive is found under it.
const HOVER_GUARD_MS = 450;

// The views the closed panel's edge rail can open it straight onto — the same
// four the panel's own switcher leads with (`ProjectFilesView`), named from the
// same keys so the rail and the switcher can never read differently. Every rail
// button is an icon (`EdgeRailIcons`), not a vertical label; the chevron above
// the tabs opens the panel on whichever view it was last left on, and the
// switch pinned to the top of the bar moves the panel to the other edge.
const EDGE_VIEWS: ReadonlyArray<{
  view: FilesPanelView;
  labelKey: TranslationKey;
  Icon: (props: { className?: string }) => JSX.Element;
}> = [
  { view: "files", labelKey: "projectFilesView.tabFiles", Icon: RailFilesIcon },
  { view: "git", labelKey: "projectFilesView.tabGit", Icon: RailGitIcon },
  { view: "windows", labelKey: "projectFilesView.tabApps", Icon: RailAppsIcon },
  { view: "agents", labelKey: "projectFilesView.tabAgents", Icon: RailAgentsIcon },
];

// Side-panel width bounds. The default matches the historical fixed 280px so
// existing installs (no stored width) look unchanged; the max is capped against
// the live window so the panel can never swallow the whole workspace.
const SIDE_PANEL_MIN = 220;
const SIDE_PANEL_DEFAULT = 280;
// Dragging the sash narrower than this closes the panel (VS Code's snap); the
// last good width is kept for the next open.
const SIDE_PANEL_SNAP = SIDE_PANEL_MIN - 60;
/** The always-present edge rail's width in px (`--side-rail-w`). */
function railWidthPx(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--side-rail-w"));
  return Number.isFinite(v) ? v : 26;
}
function clampPanelWidth(px: number): number {
  const max = Math.max(SIDE_PANEL_MIN, Math.min(900, window.innerWidth - 240 - railWidthPx()));
  return Math.round(Math.max(SIDE_PANEL_MIN, Math.min(max, px)));
}

/**
 * A small launch curtain gives the otherwise-empty WebView a clear "Tabtivity is
 * starting" state while the settings and project records arrive over IPC. It
 * has a minimum display time so a warm launch does not flash a single frame.
 */
function StartupSplash({ ready }: { ready: boolean }) {
  const t = useT();
  const [closing, setClosing] = useState(false);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    if (!ready) return;
    const closeAfter = Math.max(0, 700 - performance.now());
    const closeTimer = window.setTimeout(() => setClosing(true), closeAfter);
    const removeTimer = window.setTimeout(() => setShown(false), closeAfter + 360);
    return () => {
      window.clearTimeout(closeTimer);
      window.clearTimeout(removeTimer);
    };
  }, [ready]);

  if (!shown) return null;
  const message = t(ready ? "startup.ready" : "startup.opening");

  return (
    <div
      className={`startup-splash${closing ? " leaving" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={message}
    >
      <div className="startup-splash-mark" aria-hidden="true">
        <span className="startup-splash-orbit startup-splash-orbit-one" />
        <span className="startup-splash-orbit startup-splash-orbit-two" />
        <LogoIcon />
      </div>
      <div className="startup-splash-name">{BRAND.display.toUpperCase()}</div>
      <div className="startup-splash-message">{message}</div>
      <div className="startup-splash-progress" aria-hidden="true"><span /></div>
    </div>
  );
}

/**
 * Snapshot the main window's geometry and persist it if it actually changed, so
 * the backend can reopen the window on the same monitor next launch
 * (`restore_main_window` in lib.rs). What to store — and the subtlety of what to
 * store while MAXIMIZED — lives in `nextWindowState`.
 *
 * Shared by the debounced move/resize listener and the close path: a quit during
 * the debounce window would otherwise lose the user's last move, which is exactly
 * the move they care about.
 */
async function saveWindowGeometry(): Promise<void> {
  const win = getCurrentWindow();
  // A fullscreen window's rect is just the monitor, not a restore geometry —
  // macOS's startup fullscreen, or the user's F11 / fullscreen-button mode
  // (`lib/window/fullscreenMode`), whose own write this read reflects.
  if (await win.isFullscreen()) return;
  const [pos, size, maximized] = await Promise.all([
    win.outerPosition(),
    win.outerSize(),
    win.isMaximized(),
  ]);
  // outerPosition/outerSize are already PHYSICAL px, which is what the backend
  // consumes — nothing is converted anywhere along this path (src/lib/window/coords.ts).
  const store = useSettingsStore.getState();
  const next = nextWindowState(
    store.settings?.window_state,
    { x: pos.x, y: pos.y, w: size.width, h: size.height },
    maximized,
  );
  if (next) await store.saveWindowState(next);
}

export function AppShell() {
  const t = useT();
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  // Each read falls back to the pre-rename `right_panel_*` spelling so an install
  // that last wrote settings.json under the old name keeps its pin state, width
  // and edge. Only the `side_panel_*` keys are ever written back.
  // `side_panel_open` unset (an install from before the IDE-style toggle) reads
  // the legacy pin: a user who had pinned the panel finds it open and docked, a
  // hover user finds it closed with the rail one click away.
  const openSetting = useSettingsStore(
    (s) =>
      s.settings?.side_panel_open ??
      s.settings?.side_panel_pinned ??
      s.settings?.right_panel_pinned ??
      false,
  );
  // Opt-in hover overlay (the old default): opens after a dwell on the rail,
  // closes on mouse-leave, never reflows the workspace.
  const autoHide = useSettingsStore((s) => s.settings?.side_panel_auto_hide ?? false);
  const viewByScope = useSettingsStore((s) => s.settings?.side_panel_view_by_project);
  const lastPanelView = useSettingsStore((s) => s.settings?.side_panel_view ?? "files");
  const widthSetting = useSettingsStore(
    (s) => s.settings?.side_panel_width ?? s.settings?.right_panel_width ?? SIDE_PANEL_DEFAULT,
  );
  const panelSide = useSettingsStore(
    (s) => s.settings?.side_panel_edge ?? s.settings?.right_panel_side ?? "right",
  );
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const loadProjects = useProjectsStore((s) => s.load);
  const projectsLoaded = useProjectsStore((s) => s.loaded);
  const projectCount = useProjectsStore((s) => s.projects.length);
  const onboardingSeen = useSettingsStore((s) => s.settings?.onboarding_seen ?? false);
  const remoteFeaturesPrompted = useSettingsStore(
    (s) => s.settings?.remote_features_prompted ?? false,
  );
  const loadBoxes = useBoxesStore((s) => s.load);
  const activeId = useProjectsStore((s) => s.activeId);
  const rootDir = useProjectsStore((s) => s.rootDir);
  const scope = useTabsStore((s) => s.scope);
  // The side panel also opens for an active box scope (multi-root file view),
  // even when no project is the current activeId — and for the ROOT scope, whose
  // `~/tabtivity/root` is the app's unfiled/scratch area: the place data lands while
  // it is only being looked at, or before it belongs to any one project. That
  // folder had a terminal but no file view, so the only way to see what was in it
  // was to `ls`. Gated on `rootDir` because it arrives with the projects load —
  // an empty root would give the panel no tree to mount.
  const panelTarget =
    activeId !== null || scope.startsWith(BOX_SCOPE_PREFIX) || (scope === ROOT_SCOPE && !!rootDir);
  const switchToast = useProjectsStore((s) => s.switchToast);
  const clearSwitchToast = useProjectsStore((s) => s.clearSwitchToast);
  const connToast = useProjectsStore((s) => s.connToast);
  const clearConnToast = useProjectsStore((s) => s.clearConnToast);
  const initTimer = useTimerStore((s) => s.init);
  const flushTimer = useTimerStore((s) => s.flush);
  const quiesce = useQuiesce();
  const fastMode = useFastMode();
  // Load the armed local (Ollama) models into memory at launch — main window
  // only, and skipped (loudly) while Energy Saver is on. See stores/agents/ollamaAutoload.
  useOllamaAutoloadOnLaunch();
  // Reload the renderer if its JS heap runs away, before it OOM-crashes the
  // webview (a 44 GB leak was observed 2026-07-31). See lib/window/rendererWatchdog.
  useRendererWatchdog();
  const [panelsHidden, setPanelsHidden] = useState(false);
  // Auto-hide's transient open state. Docked mode reads `side_panel_open`.
  const [panelOpen, setPanelOpen] = useState(false);
  const [railMenu, setRailMenu] = useState<{ x: number; y: number } | null>(null);
  // Latest `setSidePanelOpen`, for the mount-only event listeners below.
  const setSidePanelOpenRef = useRef<(open: boolean) => void>(() => {});
  const [panelWidth, setPanelWidth] = useState(SIDE_PANEL_DEFAULT);
  const [resizingPanel, setResizingPanel] = useState(false);
  const latestPanelWidth = useRef(SIDE_PANEL_DEFAULT);
  const [showHowToStart, setShowHowToStart] = useState(false);
  // The fresh-install open, where the Welcome greeting types itself out; a
  // re-open from Settings shows it complete.
  const [howToStartFirstRun, setHowToStartFirstRun] = useState(false);
  const [showRemoteFeaturesPrompt, setShowRemoteFeaturesPrompt] = useState(false);
  // Set only on the fresh-install path, where HowToStart takes the screen
  // first — this defers the remote-features ask until HowToStart closes
  // instead of stacking two modals on the very first launch.
  const [pendingRemoteFeaturesPrompt, setPendingRemoteFeaturesPrompt] = useState(false);
  const [showLessons, setShowLessons] = useState(false);
  const panelCloseTimer = useRef<number | null>(null);

  useEffect(() => {
    // Load settings, then move this profile's experimental flags onto the
    // explicit rule, once (`lib/experimental`). Main window only — popouts never
    // mount AppShell — and only after a load that succeeded: a rejected load
    // never reaches it (and stays an unhandled rejection, as before).
    void Promise.resolve(loadSettings()).then(() => migrateExperimentalOnce());
    loadProjects();
    // Startup window geometry — which monitor, what size, maximized or not — is
    // owned ENTIRELY by the backend now (`restore_main_window` in lib.rs), which
    // reapplies the rect saved by the effect below before the window is ever shown.
    // Nothing may be re-asserted from here: a `maximize()` fired after load would
    // land on top of a restore onto the secondary monitor and undo it.
    //
    // macOS is the exception and stays here: real fullscreen (its own Space) is the
    // platform-expected behavior, and the system traffic-light controls keep the
    // window manageable. Linux must never follow suit — a window the WM has put into
    // fullscreen keeps `_NET_WM_STATE_FULLSCREEN`, which under KWin wins over
    // MAXIMIZED and makes the window UNMOVABLE (KWin refuses the
    // `_NET_WM_MOVERESIZE` that `startDragging` sends, so the header title-bar drag
    // silently no-ops). See the matching note in `restore_main_window`.
    if (PLATFORM === "macos") {
      getCurrentWindow().setFullscreen(true).catch(() => {});
    }
  }, [loadSettings, loadProjects]);

  // WebKitGTK doesn't reliably fire DOM 'resize' / ResizeObserver for OS-level
  // window size changes — notably the startup fullscreen transition, which on a
  // larger screen jumps the window from its 1400x900 config size to the full
  // monitor, and switching the window to a differently-sized monitor. Terminals
  // (and other panes) refit off the DOM 'resize' event, so without this they
  // open at the pre-fullscreen size and never refit. Bridge Tauri's reliable
  // window events into a DOM resize event:
  //  - onResized: monitor-size switches while fullscreen, manual drag-resize.
  //  - onScaleChanged: moving to a monitor with a different DPI — the logical
  //    (CSS px) viewport changes but WebKitGTK stays silent.
  // rAF-coalesce the live stream so a manual drag-resize doesn't flood
  // listeners, and add a trailing re-fire: a monitor switch settles the final
  // window geometry a few frames after the event, so a single immediate fire can
  // measure mid-transition.
  useEffect(() => {
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
    const unlisteners = [
      subscribeTauri(() => win.onResized(fire)),
      subscribeTauri(() => win.onScaleChanged(fire)),
    ];
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (trailing) clearTimeout(trailing);
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Remember where the user puts the window, so it reopens there. Mirrors the
  // popout's bounds streaming (DetachedApp.tsx): a drag fires a storm of events,
  // so debounce and write once it settles. Gated on `settingsLoaded` because the
  // save diffs against the currently-saved rect to skip no-op writes, and before
  // load there is nothing to diff against.
  useEffect(() => {
    if (!settingsLoaded) return;
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void saveWindowGeometry().catch(() => {});
      }, 300);
    };
    const unlisteners = [
      subscribeTauri(() => win.onMoved(schedule)),
      subscribeTauri(() => win.onResized(schedule)),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      unlisteners.forEach((fn) => fn());
    };
  }, [settingsLoaded]);

  // Restore the stored panel width once settings load (clamped to the current
  // window so a width saved on a wider monitor can't strand the panel off-screen).
  useEffect(() => {
    if (settingsLoaded) {
      const w = clampPanelWidth(widthSetting);
      latestPanelWidth.current = w;
      setPanelWidth(w);
    }
  }, [settingsLoaded, widthSetting]);

  // First-run "How to start": show once on a genuinely empty install (the
  // `projects.length === 0` guard keeps upgrading users — who already have
  // projects but no flag — from seeing it). Mark seen immediately (optimistic)
  // so a hot-reload or transient re-render can't reopen it.
  //
  // The "Using VPN or remote machines?" ask rides the same effect so the two
  // never stack: on a fresh install it waits behind HowToStart (queued via
  // `pendingRemoteFeaturesPrompt`, shown from HowToStart's onClose below);
  // otherwise — including an upgrading install that already has projects and
  // so skips HowToStart — it shows immediately. Both settings are written in
  // one `updateSettings` call on the fresh-install branch so a fast second
  // effect run can't read a stale `current` and drop one of the two flags.
  useEffect(() => {
    if (!settingsLoaded || !projectsLoaded) return;
    if (!onboardingSeen && projectCount === 0) {
      setShowHowToStart(true);
      setHowToStartFirstRun(true);
      if (!remoteFeaturesPrompted) {
        setPendingRemoteFeaturesPrompt(true);
        void updateSettings({ onboarding_seen: true, remote_features_prompted: true });
      } else {
        void updateSettings({ onboarding_seen: true });
      }
      return;
    }
    if (!remoteFeaturesPrompted) {
      setShowRemoteFeaturesPrompt(true);
      void updateSettings({ remote_features_prompted: true });
    }
  }, [
    settingsLoaded,
    projectsLoaded,
    onboardingSeen,
    projectCount,
    remoteFeaturesPrompted,
    updateSettings,
  ]);

  // Let the Settings dialog / gear menu re-open the welcome on demand.
  useEffect(() => {
    const open = () => {
      setHowToStartFirstRun(false);
      setShowHowToStart(true);
    };
    window.addEventListener("app:open-how-to-start", open);
    return () => window.removeEventListener("app:open-how-to-start", open);
  }, []);

  // Open the lessons picker on demand, and let a tour/lesson step force the
  // (otherwise hover-revealed) file panel open so it has something to spotlight.
  useEffect(() => {
    const openLessons = () => setShowLessons(true);
    const revealPanel = () => {
      setSidePanelOpenRef.current(true);
    };
    window.addEventListener("app:open-lessons", openLessons);
    window.addEventListener("app:reveal-side-panel", revealPanel);
    return () => {
      window.removeEventListener("app:open-lessons", openLessons);
      window.removeEventListener("app:reveal-side-panel", revealPanel);
    };
  }, []);

  // Load boxes once projects are in memory so the stale-`box_id` strip (see
  // boxes store `load`) runs over the loaded project list.
  useEffect(() => {
    if (projectsLoaded) void loadBoxes();
  }, [projectsLoaded, loadBoxes]);

  // Bring up the tunnel armed as "connect on launch" in the header's VPN menu, if any.
  // Waits for both stores: the setting says *which* config, and a project's spec may
  // hold the auth username for it. Self-guarded against a second run, and silent —
  // it never prompts, so a stale opt-in just leaves the tunnel down.
  useEffect(() => {
    if (settingsLoaded && projectsLoaded) void autoConnectVpnOnLaunch();
  }, [settingsLoaded, projectsLoaded]);

  // Install the tunnel-up → reconnect subscription (and the launch-time global-
  // machine sweep) once, on first mount — before the VPN launch effect above can
  // bring a tunnel up, so its `→ connected` transition is already being watched.
  useEffect(() => {
    initRemoteAutoReconnect();
    initMachineSync();
    // App-registry changes (a launched app exiting) → scoped Apps-view refresh.
    installWindowsEvents();
  }, []);

  // Withdraw the tabs (and live browser windows) of any experiment that is
  // switched off — now and on every settings change. Installed here rather than
  // in the Settings panel because a flag can go off without that panel being
  // open (another window's write reaches this one's store), and settings arrive
  // asynchronously at launch. See lib/experimentalSweep.
  useEffect(() => initExperimentalSweep(), []);

  // Flip the panel to the opposite edge. Persisted only — the layout (docked
  // inset, slide direction, resize math, reveal edge) reads `panelSide`, so no
  // local mirror state is needed.
  const toggleSide = () => {
    void updateSettings({ side_panel_edge: panelSide === "left" ? "right" : "left" });
  };

  // Drag the panel's left border to resize. The panel is absolutely positioned
  // at right:0, so its width is just `innerWidth - cursorX`. We update local
  // state live (driving both the panel width and the docked body inset) and
  // persist only on release. Pointer capture keeps the gesture alive when the
  // cursor leaves the thin handle.
  const snapClose = useRef(false);
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    snapClose.current = false;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    setResizingPanel(true);
  };

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingPanel) return;
    // The grip straddles the panel's inner edge — on the right that's the left
    // border (width = innerWidth - cursorX); flipped to the left it's the right
    // border (width = cursorX).
    const raw =
      (panelSide === "left" ? e.clientX : window.innerWidth - e.clientX) - railWidthPx();
    // Past the snap point the width stops following the cursor (the last good
    // one is kept) and releasing closes the panel.
    snapClose.current = raw < SIDE_PANEL_SNAP;
    if (snapClose.current) return;
    const w = clampPanelWidth(raw);
    latestPanelWidth.current = w;
    setPanelWidth(w);
  };

  const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingPanel) return;
    setResizingPanel(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (snapClose.current) {
      snapClose.current = false;
      setSidePanelOpenRef.current(false);
      return;
    }
    void updateSettings({ side_panel_width: latestPanelWidth.current });
    // Terminals and other panes refit off the DOM resize event; the docked body
    // inset just changed, so nudge them to remeasure at the new width.
    window.dispatchEvent(new Event("resize"));
  };

  // Double-click the sash: back to the default width.
  const onResizeReset = () => {
    const w = clampPanelWidth(SIDE_PANEL_DEFAULT);
    latestPanelWidth.current = w;
    setPanelWidth(w);
    void updateSettings({ side_panel_width: w });
    window.dispatchEvent(new Event("resize"));
  };

  // Apply tab layout / side-panel restores emitted by the backend's
  // project-runtime switch (which runs off the UI thread).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenProjectRuntimeSwitched()
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // SSH-sync Phase 1: subscribe to the backend's mirror-sync progress stream so
  // the remote file view reflects transfers + refreshes status on completion.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenSyncProgress()
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // #42: register the MAIN window's host side of the detached-subwindow
  // protocol exactly once. This responds to a popped-out window's seed request
  // (shipping its group's tabs+subtree), applies edits streamed back, and docks
  // a group back on request. The detached window renders `DetachedApp` (a
  // different App branch) and never reaches AppShell, so this only ever runs on
  // the main window. Without this wiring a detached window hangs on
  // "Loading subwindow…" forever.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenDetachedHost()
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    // Group B #225: a reload of THIS window leaves its popouts on screen as
    // zombies — they re-request a seed forever while the restored layout opens
    // fresh ones beside them under new labels. Take them down before the restore
    // respawns; run once, here, where the store is still empty and every live
    // popout is therefore known to be a leftover.
    void closeOrphanedPopouts();
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Group B #226: adopt settings written in another window. The main window is
  // usually the writer, but a popout writes too (an alert mute, a careful-mode
  // toggle, a custom agent, a Python run-args edit) — and without this its write
  // would be invisible here until the next launch, while this window's own next
  // write would silently spread its stale copy back over the popout's change.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenSettingsChanged()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: SyncTeX forward search may reveal a PDF that's popped out into a detached
  // window (a separate webview/store). Listen for cross-window reveal broadcasts
  // so this window's PdfCanvas reveals the box even when the TeX editor that asked
  // lives in another window. (The detached window registers its own listener.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenPdfReveal()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: the mirror image — SyncTeX reverse search (Ctrl+click in a popped-out
  // PDF) lands the source-line jump here, the window that owns the editor layout.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenSourceJump()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: a reverse-search jump applied in another window (e.g. a detached PDF
  // that owns its source editor) broadcasts here so an editor for that path in
  // THIS window scrolls too. Mirror image of the detached window's listener.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenEditorJump()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: a reverse-search center switch aimed at a TeX workspace mounted in THIS
  // window (e.g. a popped-out PDF's click resolved in its own window, which does
  // not render the workspace). The registry-side twin of the two listeners above.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenTexCenter()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win.onCloseRequested(async (event) => {
      event.preventDefault();
      // Tear down any live OpenVPN tunnel *before* anything else and before the window
      // goes away. The backend also does this in RunEvent::Exit, but that runs only
      // after destroy(), so its elevated pkexec kill raised the polkit password prompt
      // against an already-gone window. Awaiting it here keeps Tabtivity on screen until
      // the prompt is answered — asked exactly once: if the user dismisses it, the
      // backend marks that tunnel declined so RunEvent::Exit won't re-prompt for it
      // with the window already gone (that used to raise a parentless pkexec dialog
      // that could stall shutdown). So a "no" here just warns and the quit proceeds —
      // it does not block the app from closing.
      const tunnelsDown = await disconnectAllTunnelsOnQuit().catch(() => true);
      if (!tunnelsDown) {
        const lang = useI18nStore.getState().lang;
        await message(translate(lang, "appShell.vpnStillActiveMessage"), {
          title: translate(lang, "appShell.vpnStillActiveTitle"),
          kind: "warning",
        }).catch(() => {});
      }
      await flushTimer().catch(() => {});
      // Counters accrued since the last interval flush would otherwise be lost on
      // quit — including everything done in the final minutes of a session.
      await flushUsage().catch(() => {});
      // Capture the window's final geometry before it goes away — a quit inside
      // the 300ms save debounce would otherwise drop the user's last move.
      await saveWindowGeometry().catch(() => {});
      // Flush the active scope's tab layout for the same reason: CenterPanel
      // debounces its persistScope by 300ms, so a quit right after navigating a
      // Files (Project) tab into a subfolder (or any tab/split change) would drop
      // it and the tab would reopen at the project root. The side-panel folder
      // is saved eagerly and needs no flush; only the tab layout is debounced.
      // The scope is named explicitly — the active project's id, whose own
      // `local_file` goes with it — never the tab store's live `scope` paired
      // with a file resolved elsewhere (`saveLayout`'s hazard: the two drift).
      const { activeId, projects } = useProjectsStore.getState();
      const localFile = activeId
        ? projects.find((p) => p.id === activeId)?.local_file
        : undefined;
      if (activeId && localFile) {
        await useTabsStore.getState().persistScope(activeId, localFile).catch(() => {});
      }
      // A clean Tabtivity quit ends only the local tmux sessions named and owned by
      // Tabtivity. It runs after the layout flush so an abnormal close still has a
      // durable tab/session pairing to restore, but before `destroy()` causes the
      // backend's general PTY teardown. A crash never reaches this path: its tmux
      // sessions remain alive and the saved tabs reattach on the next launch.
      await invoke<void>("local_tmux_kill_app_sessions").catch(() => {});
      // Close any popped-out subwindows so they don't strand on screen; they
      // persist + re-open at their saved bounds next launch (see the helper).
      await shutdownDetachedWindows().catch(() => {});
      await win.destroy();
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [flushTimer]);

  // Periodically commit elapsed time so a crash doesn't lose the whole session.
  // If the tick fires much later than expected the system was likely sleeping;
  // reset the timer start so sleep duration isn't counted as usage.
  useEffect(() => {
    const INTERVAL = 60_000;
    let lastTickAt = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      if (now - lastTickAt > 2 * INTERVAL) {
        useTimerStore.setState((s) => ({
          appStartedAt: s.paused ? null : now,
          projectStartedAt: s.paused ? null : now,
        }));
      }
      lastTickAt = now;
      void flushTimer();
    }, INTERVAL);
    return () => clearInterval(id);
  }, [flushTimer]);

  // Periodically commit the usage counters accrued in memory (see stores/usage).
  // Batched on its own, faster cadence than the timer: the counters are cheap to
  // accumulate but each flush is a whole-file rewrite, so this is the knob that
  // keeps a burst of typing from becoming a burst of disk writes.
  useEffect(() => {
    const id = setInterval(() => void flushUsage(), 30_000);
    return () => clearInterval(id);
  }, []);

  // Reconcile the SSH lamp/Connect-dialog status against the backend's actual
  // pool, which is the only side that ever notices a pooled connection dying on
  // its own (network drop, keepalive eviction, a VPN tunnel getting replaced
  // out from under it, or an HPC job's long queue wait past `ControlPersist`) —
  // and only lazily, the next time some command happens to touch that
  // project's pool entry. `useRemoteStatusStore` otherwise only ever moves on
  // an explicit connect/disconnect result, so without this a project whose
  // pooled session died keeps showing "connected" (green lamp, the Connect
  // dialog claiming it's already up) indefinitely, while anything that
  // actually asks the pool — e.g. the network-traffic pane's own poll —
  // correctly reports disconnected. A project the store still marks
  // "connected" that the backend no longer lists is handed to
  // `silentReconnectDeadHost`, which re-authenticates it with no prompt when
  // that's possible (headless + key/agent auth or a saved password) and only
  // falls back to a red "error" lamp when it isn't — so a background HPC watch
  // tab's host reconnects on its own instead of sitting disconnected until the
  // user notices and clicks reconnect by hand.
  useEffect(() => {
    const id = setInterval(() => {
      const { byProject, byHost } = useRemoteStatusStore.getState();
      // Every (project, host) the store believes is connected — the primary
      // (byProject) plus every worker host (byHost, multi-host remote).
      const stillConnected: Array<[string, string]> = [];
      for (const [projectId, s] of Object.entries(byProject)) {
        if (s.ssh === "connected") stillConnected.push([projectId, "primary"]);
      }
      for (const [projectId, hosts] of Object.entries(byHost)) {
        for (const [hostId, s] of Object.entries(hosts)) {
          if (s.ssh === "connected") stillConnected.push([projectId, hostId]);
        }
      }
      if (stillConnected.length === 0) return;
      // Per-host truth from the pool (`remote_connected_targets`); anything the
      // store marks connected that the backend no longer lists gets a silent
      // reconnect attempt rather than an immediate red lamp.
      void invoke<Array<[string, string]>>("remote_connected_targets")
        .then((targets) => {
          const live = new Set(targets.map(([p, h]) => `${p}${h}`));
          for (const [projectId, hostId] of stillConnected) {
            if (!live.has(`${projectId}${hostId}`)) {
              void silentReconnectDeadHost(projectId, hostId);
            }
          }
        })
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  // Point the file-churn watcher at the active scope, so the recap's
  // created/modified/deleted counts follow whatever the user is working on. The
  // backend resolves which directory that is (a remote project is watched through
  // its local mirror; one with no mirror is not watchable at all, since inotify
  // cannot see an SFTP tree, and records no file stats).
  //
  // The ROOT scope is a scope like any other here — `~/tabtivity/root` is a real
  // local tree, its terminals already file every other counter under `"root"`
  // (`stores/usage`), and it is where a file that has not found a project yet
  // gets worked on. This used to send `""`, the backend's "watch nothing", so
  // that half of the recap silently reported zero for it. `?? ROOT_SCOPE`, not
  // `?? ""`: the empty string still means stop watching, and nothing here wants
  // that.
  useEffect(() => {
    void invoke("usage_watch_project", { projectId: activeId ?? ROOT_SCOPE }).catch(() => {});
  }, [activeId]);

  // Track per-project terminal activity for the running-task pill indicator.
  // One global listener covers background projects too (their PTYs keep
  // emitting even while their tab views are unmounted).
  useEffect(() => {
    let unlistenDigest: (() => void) | undefined;
    // Off the terminal bus's one `terminal-output` listener rather than a
    // second `listen()` of our own: Tauri evaluates a script per listener with
    // the payload inlined, so a second one parsed every chunk twice.
    const unlisten = onAnyTerminalOutput((id, data) => {
      // The chunk itself rides along: the store classifies a quiet agent tab —
      // finished vs blocked on a prompt — off its tail.
      notePtyOutput(id, data);
      // Development-only transport-rate readout in the side-panel footer.
      // Count here because this is already the one app-wide tap: adding a
      // second one just for profiling would add dispatch work to the hot
      // path being measured. Vite folds this branch away in production.
      if (import.meta.env.DEV) {
        noteTerminalOutputChars(id, data.length);
      }
    });
    // A HIDDEN pane's PTY emits no terminal-output at all (visible-only
    // streaming): the backend condenses its output into throttled digests,
    // every hidden PTY's in one event per tick (`noteActivityDigests`).
    // (`terminal-replay`, the show-again catch-up, is deliberately NOT fed in
    // here: its bytes were already digested live, and re-noting them would
    // flash a quiet tab "working" on every show.)
    listen<ActivityDigest[]>("terminal-activity-batch", (ev) => {
      noteActivityDigests(ev.payload);
    })
      .then((fn) => { unlistenDigest = fn; })
      .catch(() => {});
    // What the agent's OWN hooks say its turn is doing (working / decision /
    // done), relayed by `services::agent_turn` off the per-tab record the hook
    // script writes. The authority for the tab's marks wherever it speaks; the
    // byte classifier above stays for agents that fire no hooks.
    let unlistenTurn: (() => void) | undefined;
    listen<{ id: string; state: AgentTurnState; job?: boolean; replay?: boolean }>("agent-turn", (ev) => {
      noteAgentTurn(ev.payload.id, ev.payload.state, !!ev.payload.job, !!ev.payload.replay);
      // A prompt went into the new conversation: the clear is no longer undone
      // by resuming — that would leave the prompt behind.
      if (ev.payload.state === "working") useAgentClearUndoStore.getState().dismiss(ev.payload.id);
    })
      .then((fn) => { unlistenTurn = fn; })
      .catch(() => {});
    // How a tab's session just (re)started, off the same hook's source record:
    // a `/clear` offers "Undo clear" on that terminal until the next prompt.
    let unlistenRoll: (() => void) | undefined;
    listen<{ id: string; source: string }>("agent-session-roll", (ev) => {
      useAgentClearUndoStore.getState().noteRoll(ev.payload.id, ev.payload.source);
      noteAgentSessionStart(ev.payload.id, ev.payload.source);
    })
      .then((fn) => { unlistenRoll = fn; })
      .catch(() => {});
    return () => { unlisten(); unlistenDigest?.(); unlistenTurn?.(); unlistenRoll?.(); };
  }, []);

  // The running-task indicators recompute on demand — a chunk, a keystroke, a
  // hook verdict, a tab-list change, a window expiring (`stores/activity`) —
  // not on a clock. On battery — or unfocused — the trailing delay stretches,
  // so the pill lags a little more while a streaming tab is classified a
  // third as often.
  useEffect(() => startActivityTicks(saverInterval(300, quiesce)), [quiesce]);

  // Poll AC/battery state so Energy Saver ("on battery") can react to plug/unplug.
  useEffect(() => usePowerStore.getState().start(), []);

  // Track window focus: blur engages the same throttles as Energy Saver, plus
  // the wholesale animation pause (`[data-blurred]` in themes.css) — a blurred
  // window that keeps animating never lets its render thread reach idle.
  useEffect(() => startFocusTracking(), []);

  // Publish the effective quiesce state (Energy Saver OR blurred) on the
  // document root so the CSS in themes.css can collapse continuous idle
  // animations (`[data-energy-saver]`).
  useEffect(() => {
    const root = document.documentElement;
    if (quiesce) root.dataset.energySaver = "on";
    else delete root.dataset.energySaver;
  }, [quiesce]);

  // The same publication for fast mode (`[data-fast-mode]`), which collapses
  // animations *and* transitions — a standing preference rather than a
  // battery reading, so it is its own attribute rather than a third writer of
  // `data-energy-saver`.
  useEffect(() => applyFastModeAttribute(fastMode), [fastMode]);

  useEffect(() => {
    if (projectsLoaded) {
      void initTimer(activeId);
    }
    // Only fire once when projects finish loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoaded]);

  useEffect(() => {
    if (!switchToast) return;
    const t = setTimeout(clearSwitchToast, 2200);
    return () => clearTimeout(t);
  }, [switchToast, clearSwitchToast]);

  useEffect(() => {
    if (!connToast) return;
    const t = setTimeout(clearConnToast, 3200);
    return () => clearTimeout(t);
  }, [connToast, clearConnToast]);

  // A failed tab-layout autosave (the tab store raises this once per session)
  // shows through the same toast as the other background notices.
  const layoutPersistNotice = useTabsStore((s) => s.layoutPersistNotice);
  useEffect(() => {
    if (!layoutPersistNotice) return;
    useProjectsStore.setState({ connToast: layoutPersistNotice });
    useTabsStore.getState().clearLayoutPersistNotice();
  }, [layoutPersistNotice]);

  const reveal = (
    timer: MutableRefObject<number | null>,
    setter: (open: boolean) => void,
  ) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setter(true);
  };

  const scheduleClose = (
    timer: MutableRefObject<number | null>,
    setter: (open: boolean) => void,
    delay = 250,
  ) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setter(false);
      timer.current = null;
    }, delay);
  };

  // Hiding the panels takes the reveal handle with them, so the key press that
  // did it is the only thing that could ever explain the empty edge — say so,
  // and name the key that brings them back (it is Super or F9 depending on the
  // desktop unless rebound, see `livePanelToggleLabel`). Nothing is shown on the way back in.
  const [panelsHiddenToast, setPanelsHiddenToast] = useState<string | null>(null);
  useEffect(() => {
    if (panelsHiddenToast === null) return;
    const id = window.setTimeout(() => setPanelsHiddenToast(null), 3000);
    return () => window.clearTimeout(id);
  }, [panelsHiddenToast]);

  const panelsHiddenRef = useRef(panelsHidden);
  panelsHiddenRef.current = panelsHidden;

  useKeyboard({
    onTogglePanels: () => {
      useHintsStore.getState().markSeen("toggle-panels");
      const hidden = !panelsHiddenRef.current;
      setPanelsHidden(hidden);
      setPanelsHiddenToast(
        hidden ? t("appShell.panelsHiddenToast", { key: livePanelToggleLabel() }) : null,
      );
    },
    // Steering's E: the panel on its remembered view, panels shown if they
    // were hidden. Steering only closes a panel it opened itself.
    onSidePanel: (open) => {
      if (open) {
        setPanelsHidden(false);
        openPanel();
      } else {
        setSidePanelOpen(false);
      }
    },
    onToggleSidePanel: () => {
      setPanelsHidden(false);
      setSidePanelOpen(!(panelTarget && (autoHide ? panelOpen : openSetting)));
    },
  });

  const revealPanel =
    panelTarget && !panelsHidden && (autoHide ? panelOpen : openSetting);
  // Docked: the open panel pushes the workspace aside. Auto-hide's overlay never does.
  const docked = revealPanel && !autoHide;
  const panelView = viewByScope?.[sidePanelViewKey(activeId, scope)] ?? lastPanelView;

  // The edge rail (the activity bar) is permanent: it has a gutter of its own,
  // reserved whenever the panels are shown, open or closed. A docked panel adds
  // its width to the gutter instead of replacing it.
  const railDocked = panelTarget && !panelsHidden;

  // Hover-open, now owned entirely by the rail. There is no separate edge band
  // any more: the bar covers the window edge for its full height whenever an
  // unpinned panel exists, so a band underneath it could only ever fire from on
  // top of the bar — and firing there is exactly what stole the tabs' clicks.
  const railDwellTimer = useRef<number | null>(null);
  // What the pending dwell will open on: a view for a tab, "open" for the
  // chevron and the bar's empty run (the remembered view). The key is what lets
  // a move from one tab to the next restart the dwell instead of letting the
  // first tab's dwell fire while the pointer is already on the second.
  const railDwellKey = useRef<string | null>(null);
  const cancelRailDwell = () => {
    if (railDwellTimer.current !== null) {
      window.clearTimeout(railDwellTimer.current);
      railDwellTimer.current = null;
    }
    railDwellKey.current = null;
  };
  const handleRailMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!autoHide) return;
    // Back on the rail from the panel: the close its mouse-leave scheduled is moot.
    if (panelCloseTimer.current !== null) {
      window.clearTimeout(panelCloseTimer.current);
      panelCloseTimer.current = null;
    }
    const handle = (event.target as HTMLElement).closest<HTMLElement>(".side-panel-reveal-handle");
    // The side switch moves the panel; resting on it must never do that, and it
    // opens nothing either.
    if (handle?.dataset.railAction === "switch") {
      cancelRailDwell();
      return;
    }
    const view = handle?.dataset.railView as FilesPanelView | undefined;
    const key = view ?? "open";
    // Already showing what this would open: there is nothing to dwell for.
    if (revealPanel && (!view || view === panelView)) {
      cancelRailDwell();
      return;
    }
    if (railDwellTimer.current !== null && railDwellKey.current === key) return;
    cancelRailDwell();
    railDwellKey.current = key;
    railDwellTimer.current = window.setTimeout(() => {
      railDwellTimer.current = null;
      railDwellKey.current = null;
      hoverGuard.current = { x: NaN, y: NaN, timer: null, off: false };
      if (view) openPanelOnView(view);
      else openPanel();
    }, RAIL_DWELL_MS);
  };
  // A hover-open has to be able to close again. The panel closes on its own
  // mouseleave, which only ever fires after a mouseenter — and a hover-open
  // gives it none: the pointer is resting on the rail, the rail unmounts, and
  // the panel takes a slide to arrive under a pointer that is not moving. A
  // pointer that wandered off in the meantime (the dwell felt like nothing was
  // happening) never enters, so never leaves, and the panel it opened stood
  // open until it was hovered and left on purpose. Until the pointer's first
  // move OVER the panel — from then on enter/leave carry it, portals included —
  // the guard watches the document: a move elsewhere starts a check, and a
  // check that finds the pointer off the panel closes it. Only a hover arms
  // it: a click or the lessons event opened the panel to be looked at.
  const hoverGuard = useRef<{
    x: number;
    y: number;
    timer: number | null;
    /** A click on the shown view's icon committed the hover-open: stay open. */
    off: boolean;
  } | null>(null);
  useEffect(() => {
    // A close (by whatever path) retires the guard: the next open may be a click.
    if (!revealPanel) {
      hoverGuard.current = null;
      return;
    }
    const guard = hoverGuard.current;
    if (!autoHide || !guard) return;
    const disarm = () => {
      if (guard.timer !== null) window.clearTimeout(guard.timer);
      guard.timer = null;
      hoverGuard.current = null;
      document.removeEventListener("mousemove", onMove);
    };
    const onMove = (event: MouseEvent) => {
      if (guard.off) return;
      const target = event.target as Element | null;
      // The rail sits against the panel: reaching for another icon is not leaving.
      if (target?.closest?.(".side-panel-reveal-rail")) {
        if (guard.timer !== null) window.clearTimeout(guard.timer);
        guard.timer = null;
        return;
      }
      if (target?.closest?.(".side-panel")) {
        disarm();
        return;
      }
      guard.x = event.clientX;
      guard.y = event.clientY;
      if (guard.timer !== null) return;
      guard.timer = window.setTimeout(() => {
        guard.timer = null;
        const under = document.elementFromPoint?.(guard.x, guard.y) ?? null;
        // Resting where the panel has since arrived: it is being looked at, and
        // its next move over the panel hands it to enter/leave.
        if (under?.closest(".side-panel")) return;
        disarm();
        setPanelOpen(false);
      }, HOVER_GUARD_MS);
    };
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("mousemove", onMove);
      if (guard.timer !== null) window.clearTimeout(guard.timer);
      guard.timer = null;
    };
  }, [revealPanel, autoHide]);
  // A dwell still pending when the panel opens (or the rail goes away with the
  // panels) has nothing left to reveal.
  useEffect(() => {
    if (revealPanel || panelsHidden) cancelRailDwell();
  }, [revealPanel, panelsHidden]);
  useEffect(() => cancelRailDwell, []);

  // The side switch is the one rail button that still commits on pointer press:
  // it re-mounts the rail on the other edge under the pointer, so a click may
  // never land. `onClick` stays for keyboard and assistive activation, which
  // arrives as a bare click with no pointer press; the timestamp keeps a pointer
  // press from doing the work twice, and cannot go stale into a later real click.
  const railPressedAt = useRef(0);

  // Open or close the panel. Docked (the default) that is the persisted
  // `side_panel_open`, and it reflows the workspace; in auto-hide it is the
  // overlay's transient state and nothing is stored.
  const setSidePanelOpen = (open: boolean) => {
    if (panelCloseTimer.current !== null) {
      window.clearTimeout(panelCloseTimer.current);
      panelCloseTimer.current = null;
    }
    if (autoHide) {
      setPanelOpen(open);
      return;
    }
    void updateSettings({ side_panel_open: open });
    // Terminals and other panes refit off the DOM resize event; the workspace's
    // inset changes with no transition in docked mode, so remeasure next frame.
    window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };
  setSidePanelOpenRef.current = setSidePanelOpen;

  // Open the panel on its remembered view, storing nothing (steering, the
  // dwell on the chevron, the lessons event).
  const openPanel = () => {
    cancelRailDwell();
    useHintsStore.getState().markSeen("file-tree");
    setSidePanelOpen(true);
  };
  const openPanelOnView = (view: FilesPanelView) => {
    cancelRailDwell();
    useHintsStore.getState().markSeen("file-tree");
    void updateSettings(
      sidePanelViewPatch(
        view,
        sidePanelViewKey(activeId, scope),
        useSettingsStore.getState().settings,
      ),
    );
    setSidePanelOpen(true);
  };
  // A click on a rail icon, VS Code style: the icon of the view already shown
  // closes the panel, another view's icon switches to it. `view` undefined is the
  // chevron: toggle on the remembered view.
  const onRailActivate = (view?: FilesPanelView) => {
    const shown = revealPanel && (view === undefined || view === panelView);
    if (!shown) {
      if (view) openPanelOnView(view);
      else openPanel();
      return;
    }
    cancelRailDwell();
    // Auto-hide: a click on the icon of a panel the HOVER opened keeps it —
    // the click that was already on its way must not shut what the dwell just
    // opened. A second click closes it.
    const guard = hoverGuard.current;
    if (autoHide && guard && !guard.off) {
      guard.off = true;
      if (guard.timer !== null) window.clearTimeout(guard.timer);
      guard.timer = null;
      return;
    }
    setSidePanelOpen(false);
  };

  return (
    <div className="app-shell">
      <StartupSplash ready={settingsLoaded && projectsLoaded} />
      <MobileBridgeHost />
      <HeaderBar />
      {switchToast != null && (
        <div
          key={switchToast}
          className={`project-switch-toast${switchToast.includes("\n") ? " multiline" : ""}`}
        >{switchToast}</div>
      )}
      {connToast != null && (
        <div key={connToast} className="project-switch-toast conn-toast">{connToast}</div>
      )}
      {panelsHiddenToast != null && (
        <div key={panelsHiddenToast} className="project-switch-toast">{panelsHiddenToast}</div>
      )}
      <PdfLoadWarningHost />
      <div
        className={`app-body${
          docked
            ? panelSide === "left"
              ? " left-docked"
              : " right-docked"
            : railDocked
              ? panelSide === "left"
                ? " rail-docked-left"
                : " rail-docked"
              : ""
        }${resizingPanel ? " resizing" : ""}`}
        style={
          docked
            ? panelSide === "left"
              ? { paddingLeft: `calc(${panelWidth}px + var(--side-rail-w))` }
              : { paddingRight: `calc(${panelWidth}px + var(--side-rail-w))` }
            : undefined
        }
      >
        <CenterPanel />
        {panelTarget && !panelsHidden && (
          <SidePanel
            open={revealPanel}
            overlay={autoHide}
            side={panelSide}
            width={panelWidth}
            resizing={resizingPanel}
            onResizeStart={onResizeStart}
            onResizeMove={onResizeMove}
            onResizeEnd={onResizeEnd}
            onHide={() => setSidePanelOpen(false)}
            onResizeReset={onResizeReset}
            onToggleSide={toggleSide}
            onMouseEnter={() => autoHide && reveal(panelCloseTimer, setPanelOpen)}
            onMouseLeave={() => autoHide && scheduleClose(panelCloseTimer, setPanelOpen)}
          />
        )}
        {/* Invisible marker at the reveal band so the guided tour has a stable
            element to spotlight for the "find your files" step. Follows the panel
            to whichever edge it docks against. */}
        {panelTarget && !panelsHidden && (
          <div
            className={`tour-edge-marker${panelSide === "left" ? " left" : ""}`}
            data-hint-anchor="file-tree-edge"
            aria-hidden
          />
        )}
        {/* The activity bar: a permanent bar on the panel's edge with a gutter of
            its own (`.app-body` reserves --side-rail-w there, open or closed), so
            what opens the panel can also close it — it never unmounts.

            Icon buttons only: a side switch pinned to the top of the bar that
            moves the panel (and this rail with it) to the other edge without
            opening anything, then — centred — a chevron that toggles the panel on
            its remembered view and one tab per view the panel's own switcher
            offers. The tab for the view on show is `aria-pressed`; clicking it
            hides the panel, clicking another switches (see `onRailActivate`).

            Auto-hide (right-click the bar) keeps the old overlay: the bar owns the
            hover-open (handleRailMouseMove) — resting on a tab opens the panel on
            that tab's view after a dwell, and a click on the same tab can only
            ever agree with it. In docked mode nothing opens by hovering. */}
        {panelTarget && !panelsHidden && (
          <div
            className={`side-panel-reveal-rail${panelSide === "left" ? " left" : ""}`}
            onMouseMove={handleRailMouseMove}
            onMouseLeave={() => {
              cancelRailDwell();
              if (autoHide && revealPanel) scheduleClose(panelCloseTimer, setPanelOpen);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setRailMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <button
              type="button"
              className="side-panel-reveal-handle srh-switch"
              data-rail-action="switch"
              aria-label={t(panelSide === "left" ? "sidePanel.moveRight" : "sidePanel.moveLeft")}
              title={t(panelSide === "left" ? "sidePanel.moveRight" : "sidePanel.moveLeft")}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                railPressedAt.current = Date.now();
                cancelRailDwell();
                toggleSide();
              }}
              onClick={() => {
                if (Date.now() - railPressedAt.current < 700) return;
                toggleSide();
              }}
            >
              <RailSwitchSideIcon side={panelSide} />
            </button>
            <div className="srr-group">
              <button
                type="button"
                className="side-panel-reveal-handle srh-chevron"
                data-rail-action="open"
                aria-label={t(revealPanel ? "sidePanel.hideTitle" : "appShell.showPanel")}
                title={t(revealPanel ? "sidePanel.hideTitle" : "appShell.showPanel")}
                onClick={() => onRailActivate()}
              >
                <RailChevronIcon
                  dir={(panelSide === "left") === revealPanel ? "left" : "right"}
                />
              </button>
              {EDGE_VIEWS.map(({ view, labelKey, Icon }) => {
                const label = t(labelKey);
                const active = revealPanel && panelView === view;
                return (
                  <button
                    key={view}
                    type="button"
                    className={`side-panel-reveal-handle${active ? " active" : ""}`}
                    data-rail-view={view}
                    aria-pressed={active}
                    aria-label={t("appShell.showPanelView", { view: label })}
                    title={t("appShell.showPanelView", { view: label })}
                    onClick={() => onRailActivate(view)}
                  >
                    <Icon />
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {railMenu && (
          <ContextMenuPortal
            x={railMenu.x}
            y={railMenu.y}
            onClose={() => setRailMenu(null)}
            className="tab-new-menu"
          >
            <button
              className="tab-new-menu-item"
              onClick={() => {
                setRailMenu(null);
                toggleSide();
              }}
            >
              {t(panelSide === "left" ? "sidePanel.moveRight" : "sidePanel.moveLeft")}
            </button>
            <button
              className="tab-new-menu-item"
              onClick={() => {
                setRailMenu(null);
                setPanelOpen(false);
                void updateSettings({ side_panel_auto_hide: !autoHide });
              }}
            >
              {autoHide ? "✓ " : ""}
              {t("appShell.railAutoHide")}
              <UntestedTag id="sidePanel.ideToggle" />
            </button>
            {revealPanel && (
              <button
                className="tab-new-menu-item"
                onClick={() => {
                  setRailMenu(null);
                  setSidePanelOpen(false);
                }}
              >
                {t("sidePanel.hideTitle")}
              </button>
            )}
          </ContextMenuPortal>
        )}
      </div>
      <VpnPasswordPrompt />
      {/* "Where should this screenshot go?" — the consent step between a capture
          and any project write. At the shell because the capture can come from the
          header's global-app menu or from any visible PDF viewer, and because the
          backend reports OS-tool captures as an app-wide event with no component of
          its own to land in. */}
      <ScreenshotSaveOverlay />
      {/* The Machines overlay — a click on the header's Machines button: the
          global machines as a grid of tiles. Mounted here, BEFORE the host-key
          prompt, the HPC guard, the connect dialogs and the machine monitor
          below (all `.modal-backdrop` at one z-index, DOM order the tie-break),
          because each of them is raised by a gesture made inside it and must
          land on top — and the root console (a terminal sign-in) is later
          still. */}
      <LazyMachinesOverlayHost />
      {/* "Is this the right machine?" — shown before a password is sent to a host
          whose SSH key has never been accepted here. At the shell because it can be
          raised by any connect surface (the Connect modal, a create/extend dialog,
          the Machines menu), and each of them must not carry its own copy. */}
      <HostKeyConfirmDialog />
      {/* The HPC tag's per-act confirmation (disk scan, login-node run). Mounted
          here for the same reason the host-key prompt is: the caller is a lib
          function with no component of its own to render into. */}
      <HpcGuardDialog />
      {/* Windows: the once-per-machine "agents run with your full rights"
          acceptance a refused agent spawn asks for; same host rule as above. */}
      <UnfencedPlatformDialog />
      <StopProjectDialog />
      {/* "This will overwrite that side" — the confirmation every byte-sync
          transfer asks for. Here for the same reason as the two above: a pull or
          push can be started from the file tree, the file view's toolbar or the
          diverged-files list, and none of them may carry its own copy of the
          question. */}
      <SyncConfirmDialog />
      <RemoteConnectDialog />
      {/* Multi-host remote: the "Remote machines" manager, opened from a pill's
          Runtime menu or a right-click on its remote lamp. */}
      <LazyRemoteMachinesDialogHost />
      {/* The header Machines menu's "System monitor…" button, per global machine. */}
      <GlobalMachineMonitorDialogHost />
      {/* The guided HPC/SLURM pipeline wizard (login → create → load → run → watch),
          launched from the project-switcher + menu (docs/quirky-knitting-umbrella). */}
      <LazyHpcPipelineWizardHost />
      {/* "These folders are giant — sync them?", asked once when a project is first
          paired with a host. Lives at the shell for the same reason the manager
          above does: the project that asked may not be the active one by the time
          its census (local walk + one host `du`) comes back. */}
      <BigFolderDialogHost />
      {/* Box editor (#41): rename / member list / explicit dissolve. */}
      <BoxEditorHost />
      {/* Same reason as the alarm below: lockstep/sync can delete a file from the local
          mirror during a background pass, and the user must hear about it wherever they
          are — including when the file panel it happened in is closed (#28q). */}
      <LocalLossDialog />
      {/* The in-app browser's download consent (#61). Mounted once per window,
          not per pane: the dialog is portaled to <body> and CenterPanel keeps
          every tab mounted, so a pane-rendered one would appear once per browser
          tab. It also owns the browser event listeners, so a download raised by a
          live-page window is answerable even when no browser tab is open. */}
      <BrowserDownloadHost />
      {/* The ask-once "run this project's hooks / latexmkrc / prettier?" prompt
          (services::exec_trust), raised by a gated commit/push/build/format. */}
      <ExecTrustHost />
      <OpenExternalHost />
      {/* Mail as a global app: the header's ✉ button opens the ordinary MailPane
          as an overlay over whatever is on screen. At the shell rather than in
          the header because it covers the window, not the header — and because
          it must survive a project switch, which mail (unlike a tab) ignores. */}
      <LazyMailOverlayHost />
      {/* The calendar's twin of the above: the header's 🗓 button opens the
          ordinary CalendarPane as an overlay, at the shell for the same reason —
          it covers the window and must survive a project switch. */}
      <CalendarOverlayHost />
      {/* CalDAV's scheduled sync (docs/caldav_plan.md Phase 2). Renders nothing,
          and starts no timer at all until an account exists — at the shell for
          the alarm ticker's reason: the surfaces that read a synced calendar
          (the header badge, the board's agenda rail, the reminders) are not the
          calendar pane, so refreshing only while that pane is open would leave
          the calendar stale exactly where it is looked at. */}
      <CalDavSyncHost />
      {/* The per-network default printer, applied on arriving at a network —
          at the shell because the Print Manager that saves it is closed by then.
          Starts no timer until a default is saved. */}
      <PrinterNetworkDefaultsHost />
      {/* The agent warm-up cron (Manage CLIs → Scheduled warm-up). Renders
          nothing and starts no timer until an agent is scheduled — at the shell
          for `CalDavSyncHost`'s reason turned around: the panel that configures
          it is precisely the surface nobody has open at 06:00, so a timer living
          there would only ever fire while its own settings page was being read.
          Main window only, so two windows cannot both send the morning's
          message. */}
          <TimerLeaseHost />
          <WorkspacePatchHost />
          <AgentContinueHost />
          <AgentCronHost />
          <AgentScheduleHost />
      {/* The push half's one question (Phase 3): a `412` means the resource
          changed elsewhere, which is the user's decision and not the app's. Here
          rather than in the calendar pane because the conflicting edit can come
          from the board, the overlay or the header's day list — and because the
          pane is exactly what has been closed by the time an answer is needed. */}
      <CalDavConflictDialog />
      {/* The todo board, third of the same family — and mounted LAST of the
          three deliberately: all three are `.modal-backdrop` at one z-index and
          nothing makes them mutually exclusive, so DOM order is the tie-break
          and the surface opened most recently should be the one on top. */}
      <LazyTodoOverlayHost />
      {/* The Models & agents overlay — a click on the header's processor-chip
          button (its hover dropdown stays), and the home of the machine-level
          Skills Library. At the shell for the family's reason (it covers the
          window and must survive a project switch), after the three above
          because it is opened from a header button that sits over them, and
          before the root console so a one-click install started from one of
          its tabs opens the console on top of it. */}
      <LazyModelsOverlayHost />
      {/* The root console (Ctrl+Shift+R): the root scope as a floating subwindow
          instead of a scope to switch to, and the one overlay onto the root
          terminal — a one-click install (`runInstallInTab`) and a parked login
          both open their tab in it. After the overlay family and the settings
          surfaces in DOM order, so it lands on top of the dialog that started
          the install or the login. Its host also persists the root scope and merges the rows a
          root agent wrote through Tabtivity's MCP tools — both while closed. */}
      <RootOverlayHost />
      {/* The shortcut cheat sheet (F1, `?` in steering mode, or the ⚙ menu) —
          after the overlay family above so the sheet, openable from the
          keyboard while any of them is up, lands on top (same z-index, DOM
          order is the tie-break). */}
      <ShortcutHelpOverlay />
      {/* Fires once per connect (manual or silent auto-connect): warns that the
          host's load/memory/logged-in sessions suggest it's already in use. */}
      <RemoteUsageWarningDialog />
      {/* Calendar reminders live at the shell, not in the calendar pane: an alarm
          must reach the user whatever tab they are on — and even if they have
          never opened a calendar tab this session. */}
      <AlarmPopup />
      {/* Keyboard steering mode's bottom legend — display-only echo of the
          swallowed keys, mounted at the shell like the other overlays. */}
      <SteeringLegend />
      {/* Steering's prompt box (I): a prompt for the active agent tab. */}
      <SteeringPromptOverlay />
      {/* Steering's "are you sure" before W closes a tab or K clears one. */}
      <SteeringConfirmOverlay />
      <QuickOpen />
      <HintHost />
      <TourHost />
      <StatsRecapHost />
      {/* Dev-only floating perf monitor (Ctrl+Alt+P). Main window only, like
          the renderer watchdog; null in production builds by construction. */}
      {DevPerfHost && (
        <Suspense fallback={null}>
          <DevPerfHost />
        </Suspense>
      )}
      <LazyWhen when={showHowToStart}>
        <HowToStart
          firstRun={howToStartFirstRun}
          onClose={() => {
            setShowHowToStart(false);
            setHowToStartFirstRun(false);
            if (pendingRemoteFeaturesPrompt) {
              setPendingRemoteFeaturesPrompt(false);
              setShowRemoteFeaturesPrompt(true);
            }
          }}
        />
      </LazyWhen>
      <LazyWhen when={showRemoteFeaturesPrompt}>
        <RemoteFeaturesPrompt onClose={() => setShowRemoteFeaturesPrompt(false)} />
      </LazyWhen>
      <LazyWhen when={showLessons}>
        <LessonsMenu onClose={() => setShowLessons(false)} />
      </LazyWhen>
    </div>
  );
}
