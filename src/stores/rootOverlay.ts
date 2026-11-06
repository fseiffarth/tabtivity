import { create } from "zustand";
import { uncoverConsole } from "./consoleCover";
import { invoke } from "@tauri-apps/api/core";
import { isDetachedWindow } from "./detachedContext";
import { ROOT_SCOPE, hydrateScopeFromDisk, useTabsStore, type TabEntry } from "./tabs";
import { boxScopeId, useBoxesStore } from "./boxes";
import { useProjectsStore } from "./projects";
import { BOX_SCOPE_PREFIX } from "../lib/terminal/ptyId";
import type { WindowView } from "../lib/cockpit/views";
import { viewEnabled } from "../lib/cockpit/viewGates";
import { useSettingsStore } from "./settings";
import { resolveLocalMirror, resolveProjectDirectory } from "../types";

/**
 * The **root console** — the root scope, reached as an overlay instead of as a
 * place to switch to.
 *
 * The root terminal used to be a scope like a project: picking it replaced the
 * project on screen, so the one terminal that belongs to *no* project was also
 * the one that cost you the project you were in. It is now a floating subwindow
 * (`layout/RootOverlay`, Ctrl+Shift+R) over whatever is open — the fast-reach,
 * cross-project management surface: its agents are the only ones handed
 * Tabtivity's own MCP tools (projects, calendar, to-do board; see the backend's
 * `services::root_mcp`). The phone reaches it only behind its own switch and
 * the review gate (`docs/context/root_console.md`, "On the phone").
 *
 * Nothing about the *scope* changed: its tabs still live in `tabsByScope.root`,
 * persist under `sessions/root/`, and their PTYs are still owned by
 * `CenterPanel`'s keep-alive pane layer. The overlay's panes are attach-only
 * views of those — the popout's arrangement — so closing it ends nothing.
 *
 * It is the ONE overlay onto the root terminal. One-click installs used to float
 * a second one (`InstallOverlay`, a lone attach-only terminal on the install's
 * root tab) beside it: two dialogs over one scope, the smaller of which could
 * show only the tab it was opened for. An install now opens its tab here, through
 * `openTabInRootConsole`, the same door a parked login takes.
 *
 * A store for the family's reason: the hotkey, the scope chip and the flows that
 * park a login or an install in a root tab all open it, while it is mounted once
 * at the shell. The console's **frame** (moved, resized, filled) is not here: the
 * window owns it through `common/useFloatingFrame`, per machine in localStorage
 * (`rootConsoleFrame`), never `settings.json` — it is where a window sits on one
 * desk, not a preference worth syncing.
 */
/** What the shared window shows: the root console itself, or one of the other
 *  ten views (`lib/cockpit/views`). */
export type RootOverlayView = WindowView;

interface RootOverlayState {
  open: boolean;
  /** The view the window shows (or opens on next). Session-only: a relaunch
   *  starts on Root, and the cockpit's doors name their view when they open. */
  view: RootOverlayView;
  /** Open the window on `view`. `"root"` is `show()`; any other view never
   *  restores the root scope (opening it must not bring root's agents up). A
   *  view whose feature gate is off (`lib/cockpit/viewGates`) does not open. */
  openView: (view: RootOverlayView) => void;
  /** Open the console on Root; with a `key`, bring that root tab to the front
   *  of its subwindow. Which tab each subwindow shows is the root LAYOUT's, so
   *  it is the same answer the scope persists. Always means Root. */
  show: (key?: string) => void;
  close: () => void;
  /** Root tabs a one-click install opened (`runInstallInTab`), keyed by tab
   *  key. The console's strip pulses them so the user can tell which of its
   *  tabs is the one running what they just clicked. Session-only on purpose:
   *  after a relaunch it is just a root shell. */
  installTabs: Record<string, true>;
  markInstallTab: (key: string) => void;
  /** The user clicked the tab (they found it) or closed it. */
  clearInstallTab: (key: string) => void;
}

export const useRootOverlayStore = create<RootOverlayState>((set) => ({
  open: false,
  view: "root",
  show: (key) => {
    void ensureRootScopeHydrated();
    if (key) useTabsStore.getState().revealTabInScope(ROOT_SCOPE, key);
    // Asked for again while an overlay opened from the window covers it (a
    // sign-in or install tab the overlay started): the window comes to the front.
    uncoverConsole();
    set({ open: true, view: "root" });
  },
  openView: (view) => {
    if (view === "root") useRootOverlayStore.getState().show();
    else if (viewEnabled(view, useSettingsStore.getState().settings)) {
      uncoverConsole();
      set({ open: true, view });
    }
  },
  // `view` stays: the next plain open of a cockpit view is the caller's choice.
  close: () => set({ open: false }),
  installTabs: {},
  markInstallTab: (key) => set((s) => ({ installTabs: { ...s.installTabs, [key]: true } })),
  clearInstallTab: (key) =>
    set((s) => {
      if (!s.installTabs[key]) return s;
      const installTabs = { ...s.installTabs };
      delete installTabs[key];
      return { installTabs };
    }),
}));

/** Is `view` on screen — the window is up AND on it? The one definition of
 *  "mail / calendar / to-do / models / machines is open" (the stores' old
 *  `overlayOpen` flags are gone), and of "root's layout is drawn" as opposed
 *  to "the window is up" (`open`). */
export function viewShown(s: Pick<RootOverlayState, "open" | "view">, view: RootOverlayView): boolean {
  return s.open && s.view === view;
}

/** `viewShown` for Root. */
export function rootViewShown(s: Pick<RootOverlayState, "open" | "view">): boolean {
  return viewShown(s, "root");
}

/** `viewShown` outside React. */
export function isViewShown(view: RootOverlayView): boolean {
  return viewShown(useRootOverlayStore.getState(), view);
}

/** `viewShown` as a subscription. */
export function useViewShown(view: RootOverlayView): boolean {
  return useRootOverlayStore((s) => viewShown(s, view));
}

/** Ctrl+Shift+R: closed -> Root; up on another view -> switch to Root; on
 *  Root -> close. */
export function toggleRootConsole(): void {
  const s = useRootOverlayStore.getState();
  if (rootViewShown(s)) s.close();
  else s.show();
}

/**
 * Run `run` once root is hydrated: at once when it already is (or in a popout,
 * whose heap owns no tabs — its adds are forwarded to the main window, which
 * owns root's hydration too), after the restore otherwise.
 *
 * Root is hydrated FIRST when this is its first use this session: a tab added
 * to an unhydrated root creates the scope key, which reads as "hydrated", so
 * the restore is skipped and the host's persist then writes the lone new tab
 * over the saved root layout.
 */
function whenRootHydrated(run: () => void): void {
  if (isDetachedWindow() || ROOT_SCOPE in useTabsStore.getState().tabsByScope) {
    run();
    return;
  }
  void ensureRootScopeHydrated().then(run);
}

/**
 * Open `spec` as a root tab WITHOUT showing the console — the door for a view
 * that shows the tab somewhere else (an app overlay's docked agent column).
 * The tab is an ordinary root tab: its PTY is owned by `CenterPanel`'s
 * keep-alive layer and it shows in the console's strip like any other.
 *
 * Root is restored first on its first use this session (`whenRootHydrated`).
 * `onOpened` runs synchronously when root is already hydrated, after the
 * restore otherwise. In a popout the add is forwarded to the main window, so
 * the tab `onOpened` gets is a placeholder whose key names no real tab.
 */
export function addTabToRoot(
  spec: Omit<TabEntry, "key">,
  onOpened?: (tab: TabEntry) => void,
): void {
  whenRootHydrated(() => {
    const tab = useTabsStore.getState().addTabToScope(ROOT_SCOPE, spec);
    onOpened?.(tab);
  });
}

/**
 * Open `spec` as a root tab and put it in front of the user in the console —
 * the one door for every flow that runs something in the root terminal on the
 * user's behalf (a one-click install, a login that needs a password).
 *
 * `addTabToRoot` plus `show`: root is restored before the add, and `onOpened`
 * runs (synchronously when root is already hydrated) before the console opens.
 */
export function openTabInRootConsole(
  spec: Omit<TabEntry, "key">,
  onOpened?: (tab: TabEntry) => void,
): void {
  addTabToRoot(spec, (tab) => {
    onOpened?.(tab);
    useRootOverlayStore.getState().show(tab.key);
  });
}

/**
 * The project shell (Ctrl+Shift+S): the root console with a shell whose cwd is
 * the active project's root — a box's folder while a box is the scope — on
 * THIS machine. A remote project has only its local mirror here; one without a
 * mirror, like the root scope itself, just opens the console. A root shell
 * already sitting at that folder is brought to the front instead of a second
 * one being spawned, so the chord is a way back to it too.
 */
export function openProjectShellInRootConsole(): void {
  const { activeId, projects } = useProjectsStore.getState();
  const { scope } = useTabsStore.getState();
  const box = scope.startsWith(BOX_SCOPE_PREFIX)
    ? useBoxesStore.getState().boxes.find((b) => boxScopeId(b.id) === scope)
    : undefined;
  const project = box ? undefined : projects.find((p) => p.id === activeId);
  const cwd = box
    ? box.folder ?? ""
    : project?.remote
      ? resolveLocalMirror(project) ?? ""
      : resolveProjectDirectory(project);
  const label = box?.name ?? project?.name ?? "";
  if (!cwd) {
    useRootOverlayStore.getState().show();
    return;
  }
  const reuse = () => {
    const existing = (useTabsStore.getState().tabsByScope[ROOT_SCOPE] ?? []).find(
      (tab) =>
        tab.kind === "shell" &&
        !tab.cmd &&
        !tab.initialInput &&
        !tab.login &&
        !tab.tmuxAttach &&
        tab.cwd === cwd,
    );
    if (!existing) return false;
    useRootOverlayStore.getState().show(existing.key);
    return true;
  };
  const spawn = () => {
    if (!reuse()) openTabInRootConsole({ label, cmd: "", args: [], env: {}, cwd, kind: "shell" });
  };
  whenRootHydrated(spawn);
}

/**
 * Restore the root scope's saved tabs on its first use this session. It used
 * to happen only when the root scope was *switched to*; the overlay never
 * switches, so it asks for itself. `createEmptyScope` marks a root with nothing
 * saved as hydrated, so the overlay's persist effect may write it — without it
 * an absent scope key reads as "never hydrated" and every save is skipped.
 */
export function ensureRootScopeHydrated(): Promise<boolean> {
  if (ROOT_SCOPE in useTabsStore.getState().tabsByScope) return Promise.resolve(true);
  return hydrateScopeFromDisk(
    ROOT_SCOPE,
    () => invoke<string>("root_work_dir").catch(() => ""),
    { createEmptyScope: true },
  ).catch(() => false);
}
