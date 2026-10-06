import { hasActiveModal } from "./useModalFocus";
import { useEffect } from "react";
import { PLATFORM } from "../lib/window/dragPlatform";
import { IS_MAC } from "../lib/platform";
import { toggleWindowFullscreen } from "../lib/window/fullscreenMode";
import { probeSuperKeyOwnership } from "../lib/shortcuts/superKey";
import { allGroups, findGroup, useTabsStore } from "../stores/tabs";
import { closeTabWithConfirm } from "../lib/remote/closeRemoteTab";
import { reopenClosedAgentTab } from "../stores/agents/closedAgentTabs";
import { useProjectsStore } from "../stores/projects";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../stores/boxes";
import { useSettingsStore, stepZoom } from "../stores/settings";
import { useSubwindowNavStore } from "../stores/subwindowNav";
import {
  projectStations,
  useKeyboardSteeringStore,
  type SteeringHandoff,
  type SteeringRegion,
} from "../stores/keyboardSteering";
import { useActivityStore } from "../stores/activity";
import { jumpToTab } from "../lib/shortcuts/tabJump";
import { focusNextPopout } from "../lib/window/focusPopout";
import { nextStatusTab, statusTabs, type TabStatusKind } from "../lib/shortcuts/statusJump";
import {
  steeringActionFor,
  steeringKeyIs,
  steeringSlot,
  type SteeringAction,
  type SteeringKeyContext,
  type SteeringKeyMap,
} from "../lib/shortcuts/steeringBindings";
import { appOverlayStore, frontAppOverlay } from "../lib/shortcuts/appOverlays";
import { openProjectDialog } from "../lib/projects/projectDialogEvent";
import { requestProjectJump } from "../lib/projects/projectJumpEvent";
import { sidePanelViewKey, sidePanelViewPatch } from "../lib/projects/sidePanelView";
import {
  SIDE_PANEL_VIEWS,
  activateRegionCursor,
  activeProjectElement,
  activeTabCard,
  activeTabElement,
  clearRegionCursor,
  closeRegionDropdown,
  dismissLayer,
  focusRegionSearch,
  isSteeringSynthetic,
  markLayer,
  moveRegionCursor,
  moveRegionCursorByLine,
  openContextMenu,
  openCursorPopup,
  placeRegionCursor,
  pointRegionCursor,
  regionCursor,
  regionForLayer,
  regionHasControls,
  regionRoot,
  resumeRegionCursor,
  scrollRegion,
  settingsDialog,
  steeringAppEnabled,
  stepSettingsPage,
  topLayer,
  type SteeringApp,
} from "../lib/shortcuts/steeringRegion";
import {
  openProjectShellInRootConsole,
  toggleRootConsole,
  useRootOverlayStore,
} from "../stores/rootOverlay";
import { newTabRequestFor, requestNewTab, requestOverlayAgent } from "../lib/shortcuts/newTabChord";
import {
  clearAgentTab,
  requestSteeringPrompt,
  steeringActiveTab,
} from "../lib/shortcuts/steeringAgent";
import { terminalFor } from "../lib/terminal/terminalRegistry";
import { releaseTerminalScroll, scrollTerminal, scrollTerminalToLive } from "../lib/terminal/terminalScroll";
import { isPaneTerminalTarget, terminalMayTakeChord } from "../lib/shortcuts/terminalTabChord";
import {
  actionMatches,
  chordMatches,
  isLoneModifier,
  isLoneSuper,
  normalizeKey,
  resolveChord,
  zoomFor,
  type ChordDescriptor,
  type ShortcutAction,
  type ShortcutMap,
} from "../lib/shortcuts/shortcuts";

interface KeyboardOptions {
  onTogglePanels: () => void;
  /** Open (showing the panels if they were hidden) or close the side panel —
   *  steering's B key, and Escape back out of it. */
  onSidePanel?: (open: boolean) => void;
}

/** Steering's new tabs land right of the tab it was on, not at the pane's end. */
const BESIDE_ACTIVE = { besideActive: true } as const;

/** The close actions a chord may still trigger while a text field or terminal
 *  has focus — on macOS, with ⌘, and nothing else (see
 *  {@link editorMayTakeChord}). */
const EDITOR_CLOSE_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  "closeTab",
  "closeSubwindow",
  "closeAllTabs",
]);

/** Whether `action` may be resolved for a keydown whose target is an editable
 *  field (an input, the code editor, xterm's helper textarea).
 *
 *  Normally never: those keys are the field's. The one exception is ⌘W and its
 *  close-family siblings on macOS, where ⌘ is never text editing — and where a
 *  ⌘W the frontend let pass used to reach the default menu's Close Window and
 *  quit the whole app from a focused terminal. The gate is strict on purpose:
 *  `IS_MAC && metaKey && !ctrlKey`. ⌃W is readline's delete-word on a Mac too,
 *  and on Linux and Windows Ctrl+W (and Super+W, which is `metaKey` there) must
 *  keep reaching the terminal. Shared with the popout's handler. */
export function editorMayTakeChord(action: ShortcutAction, e: KeyboardEvent): boolean {
  return isMacCommandChord(e) && EDITOR_CLOSE_ACTIONS.has(action);
}

/** ⌘ without ⌃ on macOS — the only keydown from an editable target that is
 *  worth resolving at all (see {@link editorMayTakeChord}). */
export function isMacCommandChord(e: KeyboardEvent): boolean {
  return IS_MAC && e.metaKey && !e.ctrlKey;
}

/** True when keystrokes belong to a text field (input/textarea/contenteditable)
 *  — we must not steal those for navigation chords. Exported so the detached
 *  popout's keyboard hook applies the exact same "don't shadow a focused text
 *  field / xterm textarea" rule as the main window. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}

/**
 * #62: fast keyboard navigation across projects / subwindows / tabs, plus an
 * app-internal fullscreen toggle and keyboard close. Chords are deliberately
 * unambiguous (Shift+Ctrl, Shift+Arrow) so terminal (xterm) input is never
 * shadowed; we only `preventDefault` when we actually act, and never while a
 * text field (e.g. an inline tab rename) is focused.
 *
 * Every chord is user-rebindable (see `src/lib/shortcuts/shortcuts.ts` and the
 * "Keyboard Shortcuts" settings panel); the defaults below are applied when
 * `settings.keyboard_shortcuts` has no override for an action.
 *
 * Default bindings:
 *   - F11                  → the window's own fullscreen
 *   - Super / F9           → toggle the panels (a lone Super tap on a Linux
 *                            desktop that leaves the key to the window, F9
 *                            elsewhere — the Win key belongs to the OS)
 *   - Ctrl + / - / 0       → UI zoom
 *   - Ctrl+Enter           → toggle fullscreen for the focused subwindow
 *   - Escape               → exit fullscreen (when active)
 *   - Shift+Ctrl+Tab       → cycle to the next active project
 *   - Ctrl+Shift+Left/Right → previous / next tab within the focused subwindow,
 *                            from a focused pane terminal too (terminalTabChord)
 *                            — plain Shift+Arrow is left alone because an agent
 *                            CLI inside the terminal (e.g. Codex) uses it itself
 *   - Ctrl+Shift+Up/Down    → cycle the focused subwindow (numbered preview shown
 *                            while Shift is held; focus commits on Shift release)
 *   - Shift+Tab            → cycle tabs within the focused subwindow
 *   - Shift+Ctrl+W         → close the focused subwindow
 *   - Ctrl+W               → close the active tab
 *   - Ctrl+Shift+T         → reopen the last closed agent tab
 *   - Alt+Shift+←          → cycle to the previous active project
 *   - F1                   → open the shortcut cheat sheet (window event)
 *   - Shift+Space          → toggle keyboard steering mode (see below)
 *   - Ctrl+Shift+R         → open / close the root console
 *   - Ctrl+Shift+S         → root console shell at the active project's root
 *   - Ctrl+Shift+N / M     → new shell / System Monitor tab in the focused pane
 *   - Ctrl+1 … Ctrl+9      → new agent tab there: 1 = the default agent, 2–9
 *                            the + menu's other agents in order; while a mail /
 *                            calendar / to-do overlay is in front, that slot's
 *                            root agent docks in the overlay instead
 *                            (`frontAppOverlay`, `requestOverlayAgent`)
 *
 * Steering mode (`steeringMode` chord): a modal layer for the rebindable keys
 * in `steeringBindings.ts` (explained by `STEERING_KEYS`), captured on `document` in the CAPTURE phase so xterm never
 * sees them and the mode works FROM a focused terminal — the point is that the
 * hands never leave the keyboard. While active every key is swallowed. The
 * mode is a hierarchy (`SteeringLevel`): projects → subwindows → tabs, ↓ in and
 * ↑ out (E S D F double the arrows by default), opening on the tabs; Space,
 * Escape or Enter leave it. Plus a region cursor (`lib/shortcuts/steeringRegion`) for the
 * side panel, the header apps, a pane's + menu and the settings dialog.
 */
/** `KeyboardEvent.key` of the Super/Windows/Command key, as the engines name it. */
function isSuperKey(key: string): boolean {
  return key === "Meta" || key === "Super" || key === "OS";
}

/**
 * How long a released lone Super waits before toggling the panels. A desktop
 * that answers the key itself takes focus on that same release; its blur
 * reaches us well inside this window and cancels the toggle. Long enough for
 * that, short enough that the toggle still reads as immediate where the key is
 * ours.
 */
export const SUPER_RELEASE_SETTLE_MS = 150;

export function useKeyboard({ onTogglePanels, onSidePanel }: KeyboardOptions) {
  useEffect(() => {
    // Lone-Super press tracking (Linux only; see the binding in `onKeyDown`).
    let superHeld = false;
    let superChorded = false;
    let superToggleTimer: number | null = null;
    const cancelSuperToggle = () => {
      if (superToggleTimer !== null) {
        window.clearTimeout(superToggleTimer);
        superToggleTimer = null;
      }
    };

    // ── Keyboard steering mode ────────────────────────────────────────────
    // A capture-phase listener on `document`, which threads two needles at
    // once: it runs BEFORE xterm's textarea handlers (target phase), so a
    // steered key is stopped before the PTY can see it — and BEFORE this
    // hook's own editable-target guard by construction, so the toggle chord
    // works from a focused terminal (the whole point). But it runs AFTER the
    // settings panel's chord-capture listener (window, capture phase), so
    // rebinding the steering chord itself still captures instead of toggling.
    // Steering's own bookkeeping, outside the store because nothing renders it:
    // whether the side panel is open because steering opened it (Escape out of
    // it closes it again), and the pending retry that lands the region cursor
    // once a surface has mounted.
    let panelOpenedBySteering = false;
    // When the last text character was typed outside the mode (event time).
    let lastTypedAt = -Infinity;
    let placeTimer: number | null = null;
    const cancelPlace = () => {
      if (placeTimer !== null) {
        window.clearTimeout(placeTimer);
        placeTimer = null;
      }
    };
    // A surface steering just opened is not on screen yet (the panel mounts its
    // tree on open, mail and the board are lazy chunks): try for about a second.
    // `resume`: back on a surface steering left for one over it — the cursor
    // goes where it was.
    const placeCursorSoon = (region: SteeringRegion, tries = 20, resume = false) => {
      cancelPlace();
      const root = regionRoot(region);
      if (root && (resume ? resumeRegionCursor(root) : placeRegionCursor(root))) return;
      if (tries <= 0) return;
      placeTimer = window.setTimeout(() => {
        placeTimer = null;
        const s = useKeyboardSteeringStore.getState();
        if (s.active && s.region === region) placeCursorSoon(region, tries - 1, resume);
      }, 50);
    };
    // The layer the overlay region is walking, to notice another taking its
    // place (a confirm raised over a dialog, or closed back to it).
    let overlayLayer: HTMLElement | null = null;
    const dropOverlay = () => {
      overlayLayer = null;
      markLayer(null);
    };
    const exitSteering = () => {
      cancelPlace();
      clearRegionCursor();
      dropOverlay();
      panelOpenedBySteering = false;
      useKeyboardSteeringStore.getState().exit();
    };
    // Out of the current region: back to the surface under it that is still
    // on screen (settings under a dialog, the top bar under its menu), the
    // cursor where it was there — else to the base level.
    const returnFromRegion = () => {
      cancelPlace();
      clearRegionCursor();
      const back = useKeyboardSteeringStore.getState().leaveRegion((r) => !!regionRoot(r));
      if (back) placeCursorSoon(back, 20, true);
    };
    // What floats on top decides where the keys go. A dialog or menu that came
    // up — from a press, W's confirm, the pointer, the app itself — takes the
    // region cursor; one that went away hands it back to the surface under it.
    // Runs before every steering key and just after it (`syncSoon`). True when
    // it moved steering.
    const syncLayer = (): boolean => {
      const s = useKeyboardSteeringStore.getState();
      if (!s.active) return false;
      const layer = topLayer();
      const current = s.level === "region" ? s.region : null;
      if (current === "overlay") {
        if (layer && regionForLayer(layer) === "overlay") {
          if (layer === overlayLayer) return false;
          overlayLayer = layer;
          markLayer(layer);
          clearRegionCursor();
          placeCursorSoon("overlay", 20, true);
          return true;
        }
        // Closed — or a surface with a region of its own is on top again.
        dropOverlay();
        returnFromRegion();
        syncLayer();
        return true;
      }
      if (!layer) return false;
      const root = current ? regionRoot(current) : null;
      if (root && layer.contains(root)) return false;
      const next = regionForLayer(layer);
      if (next === current) return false;
      if (next === "overlay") {
        overlayLayer = layer;
        markLayer(layer);
      }
      enterRegion(next);
      return true;
    };
    // After a key: once what it opened or closed has rendered, and again a
    // moment later for a surface that mounts late (a lazy chunk). `then` runs
    // after the first pass.
    const syncTimers = new Set<number>();
    const syncSoon = (then?: () => void) => {
      for (const [delay, run] of [
        [0, () => {
          syncLayer();
          then?.();
        }],
        [150, syncLayer],
      ] as const) {
        const id = window.setTimeout(() => {
          syncTimers.delete(id);
          run();
        }, delay);
        syncTimers.add(id);
      }
    };
    // A held key repeats faster than a heavy surface can take a step — the
    // mail overlay reads the style and box of thousands of elements for each.
    // Repeats the window had no time for queue up, and the cursor walked on by
    // itself long after the key was let go (user, 2026-10-01). So a repeat is
    // dropped when it was fired while the last step was still running, or
    // before that step reached the screen.
    let stepDoneAt = -Infinity;
    let stepUnpainted = false;
    const staleRepeat = (e: KeyboardEvent): boolean => {
      if (!e.repeat) return false;
      if (stepUnpainted) return true;
      // `timeStamp` is on `performance.now()`'s clock in the engine; an older
      // one counts from the epoch (jsdom) and cannot be compared.
      const now = performance.now();
      return Math.abs(now - e.timeStamp) < 60_000 && e.timeStamp < stepDoneAt;
    };
    const stepTaken = () => {
      stepDoneAt = performance.now();
      stepUnpainted = true;
      const painted = () => {
        stepUnpainted = false;
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(painted);
      else window.setTimeout(painted, 16);
    };
    // A box takes the keyboard and steering waits for it (`handOff`): the mode
    // is off, what steering opened stays open for it to come back to.
    const handOffSteering = (box: SteeringHandoff) => {
      cancelPlace();
      clearRegionCursor();
      useKeyboardSteeringStore.getState().handOff(box);
    };
    // Escape out of a region: close what steering opened for it, back to the
    // level it was entered from.
    const leaveRegion = (region: SteeringRegion) => {
      cancelPlace();
      clearRegionCursor();
      if (region === "side") {
        if (panelOpenedBySteering) onSidePanel?.(false);
        panelOpenedBySteering = false;
      } else if (region === "addTab") {
        // The menu request toggles; only send it while the menu is still up.
        if (regionRoot("addTab")) requestNewTab({ kind: "menu" });
      } else if (region === "settings") {
        if (settingsDialog()) window.dispatchEvent(new Event("app:close-settings"));
      } else if (region === "overlay") {
        dropOverlay();
      } else if (region !== "header" && region !== "card") {
        closeApp(region);
      }
      returnFromRegion();
    };
    const enterRegion = (region: SteeringRegion) => {
      clearRegionCursor();
      useKeyboardSteeringStore.getState().enterRegion(region);
      placeCursorSoon(region);
    };
    const openSidePanel = () => {
      if (!regionRoot("side")) {
        onSidePanel?.(true);
        panelOpenedBySteering = true;
      }
      enterRegion("side");
    };
    const openApp = (app: SteeringApp) => {
      if (!steeringAppEnabled(app, useSettingsStore.getState().settings)) return;
      const store = appOverlayStore(app);
      if (!store.overlayOpen) store.openOverlay();
      enterRegion(app);
    };

    // The project level: ←/→ walk the station ring, ↓ goes into its windows.
    function steerProjects(e: KeyboardEvent, action: SteeringAction | null) {
      const steering = useKeyboardSteeringStore.getState();
      // The numbers — jump to the Nth station of the SAME ring cycleProject
      // walks: 1 = the root scope, 2 = the first project pill (display order)
      // — the numbers the pill badges show. Stays on this level: ↓ goes in.
      const slot = steeringSlot(action);
      if (slot !== null) {
        const target = projectStations()[slot - 1];
        if (target !== undefined) {
          const ps = useProjectsStore.getState();
          if (target !== ps.activeId) void ps.setActive(target);
        }
        return;
      }
      switch (action) {
        case "work":
          exitSteering();
          return;
        case "left":
        case "right":
          cycleProject(action === "right" ? 1 : -1);
          return;
        case "down": {
          const tabs = useTabsStore.getState();
          const first = allGroups(tabs.layout)[0]?.id;
          if (!tabs.focusedGroupId && first) tabs.focusGroup(first);
          steering.setLevel("panes");
          return;
        }
        // Above the projects: the top bar — its apps, menus and switches.
        case "up":
          enterRegion("header");
          return;
        // The + menu's New project dialog, walked like any dialog.
        case "newProject":
          openProjectDialog("new");
          return;
        case "menu": {
          const pill = activeProjectElement();
          if (pill) openContextMenu(pill);
          return;
        }
      }
      steerCommon(e, action);
    }

    // The active tab's terminal, when it has a live one to scroll.
    const steeringActivePty = (): string | null => {
      const active = steeringActiveTab();
      const ptyId = active ? `${active.scope}:${active.tab.key}` : null;
      return ptyId && terminalFor(ptyId) ? ptyId : null;
    };

    // The panes and tabs levels. With one subwindow there is nothing for ←/→
    // to walk between, so they step its tabs at once.
    function steerPanes(e: KeyboardEvent, action: SteeringAction | null, level: "panes" | "tabs" | "scroll") {
      const steering = useKeyboardSteeringStore.getState();
      const tabs = useTabsStore.getState();
      const ids = allGroups(tabs.layout).map((g) => g.id);
      const walksPanes = level === "panes" && ids.length >= 2;
      const focused = tabs.focusedGroupId;
      const group = focused ? findGroup(tabs.layout, focused) : null;

      // Inside the active tab's terminal (its ↓): ←/→ scroll it half a screen
      // back / forward (Shift: a whole one), ↓ back to its live end, ↑ out to
      // the tabs — which takes it back to live too (the subscription at the
      // bottom). Of the tab keys, only Work here and the prompt box act.
      if (level === "scroll") {
        const pty = steeringActivePty();
        switch (action) {
          case "left":
          case "right":
            if (pty) scrollTerminal(pty, (action === "right" ? 1 : -1) * (e.shiftKey ? 1 : 0.5));
            return;
          case "down":
            if (pty) scrollTerminalToLive(pty);
            return;
          case "up":
            steering.setLevel("tabs");
            return;
          case "work":
          case "agentPrompt":
            break;
          default:
            return;
        }
      }

      // New tabs in the focused pane, the Ctrl+Shift+N / M / Ctrl+1–9 set
      // without the modifiers. Steering keeps the keyboard (walk on, I to
      // prompt the new agent, or Space to type). An agent number with nothing
      // behind it does nothing.
      const slot = steeringSlot(action);
      if (slot !== null) {
        requestNewTab({ kind: "agent", slot: slot - 1 }, BESIDE_ACTIVE);
        return;
      }
      switch (action) {
        case "up":
          // One subwindow: the panes level would step the same tabs again.
          steering.setLevel(level === "tabs" && ids.length >= 2 ? "panes" : "projects");
          return;
        // Work here — steering steps aside, focus stays where it was put.
        // (The mode opens on this level, so Escape climbing out through three
        // levels would be three presses to leave.)
        case "work":
          exitSteering();
          return;
        case "down":
          if (walksPanes) steering.setLevel("tabs");
          else if (steeringActivePty()) steering.setLevel("scroll");
          return;
        case "left":
        case "right": {
          const fwd = action === "right";
          if (walksPanes) {
            // Document order, wrapping, committed at once via focusGroup (no
            // Shift-preview: the badges re-anchor each step).
            const from = focused ? ids.indexOf(focused) : -1;
            const base = from >= 0 ? from : 0;
            tabs.focusGroup(ids[(base + (fwd ? 1 : -1) + ids.length) % ids.length]);
          } else if (group && group.tabKeys.length > 1) {
            const len = group.tabKeys.length;
            const cur = group.activeKey ? group.tabKeys.indexOf(group.activeKey) : 0;
            tabs.setGroupActive(group.id, group.tabKeys[(cur + (fwd ? 1 : -1) + len) % len]);
          }
          return;
        }
        case "newTabMenu":
          // The whole + menu, walked with the region cursor.
          if (requestNewTab({ kind: "menu" }, BESIDE_ACTIVE)) enterRegion("addTab");
          return;
        case "newShell":
          requestNewTab({ kind: "shell" }, BESIDE_ACTIVE);
          return;
        case "newMonitor":
          requestNewTab({ kind: "monitor" }, BESIDE_ACTIVE);
          return;
        case "files": // toggle the focused subwindow's docked file viewer
          if (focused && group) tabs.setGroupFiles(focused, !group.filesOpen);
          return;
        case "closeTab":
          if (tabs.activeKey) closeTabWithConfirm(tabs.activeKey);
          return;
        // The card over the active tab's terminal (Undo clear after K, a
        // sign-in link): its buttons under the region cursor.
        case "tabCard":
          if (activeTabCard()) enterRegion("card");
          return;
        case "menu": {
          // The active tab's right-click menu (rename, colour, split, …).
          const tab = activeTabElement();
          if (tab) openContextMenu(tab);
          return;
        }
        // The phone composer's Clear / Plan / Goal, on the active agent tab
        // (`steeringAgent`). Steering stays on: Clear just goes in (Undo clear
        // shows on the tab), Plan / Goal open the prompt box below led with
        // their command. A tab that takes none of them leaves the key swallowed.
        case "agentClear": {
          const active = steeringActiveTab();
          if (active) void clearAgentTab(active.scope, active.tab);
          return;
        }
        // A text box over the window for the active agent tab; Enter sends it
        // and steering comes back on this level (the box re-enters it).
        case "agentPlan":
        case "agentGoal":
        case "agentPrompt": {
          const active = steeringActiveTab();
          const lead = action === "agentPlan" ? "/plan" : action === "agentGoal" ? "/goal" : undefined;
          if (active && requestSteeringPrompt(active.scope, active.tab, level, lead)) handOffSteering("prompt");
          return;
        }
      }
      steerCommon(e, action);
    }

    // The keys every tab-bar level shares.
    function steerCommon(e: KeyboardEvent, action: SteeringAction | null) {
      const status = action ? STATUS_ACTIONS[action] : undefined;
      if (status) {
        // Next (Shift: previous) tab needing an answer / working / finished,
        // in any project; steering follows it down to the tab level.
        const activity = useActivityStore.getState();
        const tabs = useTabsStore.getState();
        const target = nextStatusTab(
          statusTabs(status, activity.busyByTab, activity.attentionByTab, tabs.tabsByScope),
          tabs.activeKey ? { scope: tabs.scope, key: tabs.activeKey } : null,
          e.shiftKey ? -1 : 1,
        );
        if (target) {
          jumpToTab(target.scope, target.key);
          useKeyboardSteeringStore.getState().setLevel("tabs");
        }
        return;
      }
      switch (action) {
        case "mail":
        case "calendar":
        case "todo":
          openApp(action);
          return;
        case "sidePanel":
          openSidePanel();
          return;
        // The project's popped-out subwindow (the next one, with several): its
        // window takes the keyboard, and the blur here ends steering.
        case "popout":
          void focusNextPopout();
          return;
        case "panels": // toggle the side panels
          onTogglePanels();
          return;
        // Open settings — same door the header ⚙ menu fires — and walk it:
        // ←/→ its pages, ↑/↓ the page's controls, Escape closes it.
        case "settings":
          window.dispatchEvent(new CustomEvent("app:open-settings", { detail: "main" }));
          enterRegion("settings");
          return;
        // Type a project's name in the header search, open or inactive; the
        // pick (or Escape) brings steering back on this level.
        case "jumpProject": {
          const level = useKeyboardSteeringStore.getState().level;
          if (level !== "region" && requestProjectJump(level)) handOffSteering("jump");
          return;
        }
        // Anything else: swallowed, mode stays on.
      }
    }

    // The region cursor: ↑/↓ walk the surface's controls, Enter presses one
    // (Space leaves the mode, as on every level).
    function steerRegion(action: SteeringAction | null, region: SteeringRegion) {
      const root = regionRoot(region);
      if (action === "back") {
        // An open dropdown list closes first; the next Back leaves.
        if (root && closeRegionDropdown(root)) return;
        // A dialog or menu closes the way its own Escape closes it (it may
        // ask first); steering follows once it is gone (`syncLayer`).
        if (region === "overlay" && root) dismissLayer(root, () => syncSoon());
        else leaveRegion(region);
        return;
      }
      if (!root) {
        // Closed under the cursor (the pointer, the surface's own ×).
        if (region === "overlay") syncLayer();
        else leaveRegion(region);
        return;
      }
      switch (action) {
        case "up":
        case "down": {
          cancelPlace();
          const delta = action === "down" ? 1 : -1;
          if (region === "header") {
            // One row of buttons: ←/→ walk it, ↓ drops the menu of the one
            // under the cursor — or, on a plain button, goes back down.
            if (action === "down" && !openCursorPopup()) leaveRegion(region);
            return;
          }
          if (region === "overlay") {
            // Nothing to press but text to read (the cheat sheet): scroll it.
            if (!regionHasControls(root) && scrollRegion(root, delta)) return;
            // Rows of fields with their buttons beside them, a menu's items:
            // ↑/↓ row to row, ←/→ along the row.
            moveRegionCursorByLine(root, delta);
            return;
          }
          // Mail's rows carry their own buttons and sit under toolbars: ↑/↓
          // go row to row there, ←/→ through what is on the row.
          (region === "mail" ? moveRegionCursorByLine : moveRegionCursor)(root, delta);
          return;
        }
        // The right-click menu of the control under the cursor (a file, a
        // message, an event); it opens as the overlay on top.
        case "menu": {
          const el = regionCursor();
          if (el) openContextMenu(el);
          return;
        }
        case "left":
        case "right": {
          cancelPlace();
          const delta = action === "right" ? 1 : -1;
          if (region === "side") {
            stepSidePanelView(delta);
            clearRegionCursor();
            placeCursorSoon("side");
          } else if (region === "settings") {
            if (stepSettingsPage(delta)) {
              clearRegionCursor();
              // The click re-renders the page after this key; land on the new one.
              placeTimer = window.setTimeout(() => {
                placeTimer = null;
                placeCursorSoon("settings");
              }, 0);
            }
          } else {
            moveRegionCursor(root, delta);
          }
          return;
        }
        // Type into the surface's search field (the + menu's filter). It never
        // takes the keyboard by itself: E S D F keep steering until asked.
        case "search":
          // Settings: the dialog's own search box, above the left-hand list.
          // Esc in it comes back here (`onSteeringKeyDown`); the legend says so.
          if (focusRegionSearch(region === "settings" ? (settingsDialog() ?? root) : root)) {
            handOffSteering("search");
            const field = document.activeElement;
            // Gone some other way (a click, a pick that moved focus on):
            // nothing waits to come back.
            field?.addEventListener(
              "blur",
              () => {
                if (useKeyboardSteeringStore.getState().handedTo === "search") {
                  useKeyboardSteeringStore.getState().dropHandoff();
                }
              },
              { once: true },
            );
          }
          return;
        case "press": {
          const done = activateRegionCursor();
          if (done === "type") {
            exitSteering();
          } else if (done === "press") {
            // What the press opened (a dialog, a menu) takes the cursor. A pick
            // that closed the surface: a + menu row has opened its tab, which
            // now has the keyboard; anything else goes back a level.
            syncSoon(() => {
              const s = useKeyboardSteeringStore.getState();
              if (!s.active || s.region !== region || regionRoot(region)) return;
              if (region === "addTab") exitSteering();
              else returnFromRegion();
            });
          }
          return;
        }
      }
    }

    function onSteeringKeyDown(e: KeyboardEvent) {
      // Steering's own Escape to a dialog, ↓ to a menu button: theirs.
      if (isSteeringSynthetic(e)) return;
      const steering = useKeyboardSteeringStore.getState();
      // Esc in a surface's search field steering handed the keyboard to:
      // back to steering on that surface, the cursor on its first control.
      // Ahead of the modal check — the + menu and settings are dialogs too.
      if (!steering.active && steering.handedTo === "search" && e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        steering.resume();
        (document.activeElement as HTMLElement | null)?.blur();
        const { region } = useKeyboardSteeringStore.getState();
        if (region) placeCursorSoon(region);
        return;
      }
      // A dialog's keys are its own: the app's chords wait until it closes.
      // Steering is the exception — it walks the dialog (`syncLayer`).
      const modalUp = hasActiveModal();
      const overrides = useSettingsStore.getState().settings
        ?.keyboard_shortcuts as ShortcutMap | undefined;

      // The chord toggles: enter when inactive, exit when active.
      // A chord that types text (the Shift+Space default) is left alone in the
      // middle of a typing burst: "I am" with the Shift still down from the I
      // is a space, not a request to steer.
      const steerChord = resolveChord("steeringMode", overrides);
      if (
        chordMatches(steerChord, e) &&
        (steering.active || !typesText(steerChord) || e.timeStamp - lastTypedAt > TYPING_BURST_MS)
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        else {
          // The mode opens on the tabs, so a subwindow has to hold the focus —
          // or on the dialog or menu on top, when one is up (back from typing
          // in one of its fields, say); Escape then closes it.
          const tabs = useTabsStore.getState();
          const first = allGroups(tabs.layout)[0]?.id;
          if (!tabs.focusedGroupId && first) tabs.focusGroup(first);
          steering.enter();
          syncLayer();
        }
        return;
      }
      // The root console toggles from anywhere, a focused terminal included —
      // and from inside steering mode, which it leaves (two modes owning the
      // keyboard at once is one too many). Not from behind a dialog, nor are
      // the chords below.
      if (!modalUp && chordMatches(resolveChord("rootConsole", overrides), e)) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        toggleRootConsole();
        return;
      }
      if (!modalUp && chordMatches(resolveChord("projectShell", overrides), e)) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        openProjectShellInRootConsole();
        return;
      }
      // A new tab in the focused pane, keyboard focus and all — from a focused
      // terminal too, which is where the hands are when the next one is
      // wanted. It lands in the workspace, so the root console steps aside.
      // An agent number with no agent behind it passes the key on.
      // While a mail / calendar / to-do overlay is in front, an agent number
      // goes to it instead: it docks that root agent beside the app, where a
      // workspace tab would open hidden under the overlay. Unanswered, the key
      // passes on too — never into that hidden tab. The root console steps
      // aside either way, so the docked column shows.
      const newTab = modalUp ? null : newTabRequestFor(e, overrides);
      const overlayApp = newTab?.kind === "agent" ? frontAppOverlay() : null;
      if (
        newTab &&
        (overlayApp && newTab.kind === "agent"
          ? requestOverlayAgent(overlayApp, newTab.slot)
          : requestNewTab(newTab))
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        const overlay = useRootOverlayStore.getState();
        if (overlay.open) overlay.close();
        return;
      }
      // Reopen the last agent tab closed in this scope — from a focused
      // terminal too, since the tab it lands in after a close is usually one.
      // With nothing to reopen the key goes on to wherever it was typed.
      if (!modalUp && chordMatches(resolveChord("reopenClosedTab", overrides), e)) {
        if (reopenClosedAgentTab(useTabsStore.getState().scope)) {
          e.preventDefault();
          e.stopPropagation();
          if (steering.active) exitSteering();
          return;
        }
      }
      if (!steering.active) {
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) lastTypedAt = e.timeStamp;
        return;
      }

      // Lone modifiers pass through unswallowed so a Shift+key still composes.
      if (isLoneModifier(e.key)) return;

      // The mode owns the keyboard: every non-modifier key below — mapped or
      // not — is swallowed here, so nothing ever leaks to the app underneath.
      e.preventDefault();
      e.stopPropagation();

      // A dialog or menu that came up since the last key (or went away) moves
      // steering before the key is read; after it, whatever the key opened.
      // An arrow that met a dialog nobody announced only lands the cursor on
      // it: the legend still showed the level behind when the key was pressed.
      if (staleRepeat(e)) return;
      const landed = syncLayer();
      steerKey(e, landed);
      syncSoon();
      stepTaken();
    }

    // A press of the real pointer while steering is on: navigation starts over
    // from where it landed. Inside the surface the cursor walks, the cursor
    // goes to what was pressed; anywhere else — a project pill, a tab, a
    // terminal — the region and everything stacked under it is dropped, and
    // steering is back on the tabs (of the project the press switches to). A
    // dialog or menu still up afterwards takes it again (`syncSoon`).
    function onSteeringPointerDown(e: PointerEvent) {
      if (isSteeringSynthetic(e)) return;
      const steering = useKeyboardSteeringStore.getState();
      if (!steering.active) return;
      const target = e.target instanceof Element ? e.target : null;
      // The legend's own fold button is steering's, not a place to go.
      if (!target || target.closest(".steering-legend, .steering-legend-fab")) return;
      cancelPlace();
      const region = steering.level === "region" ? steering.region : null;
      const root = region ? regionRoot(region) : null;
      // A project pill is never under the top bar's cursor: a press on one
      // starts over on that project's tabs.
      if (root?.contains(target) && !target.closest(".project-pill, .box-chip")) {
        pointRegionCursor(root, target);
        return;
      }
      clearRegionCursor();
      dropOverlay();
      panelOpenedBySteering = false;
      steering.setLevel("tabs");
      const side = regionRoot("side");
      if (side?.contains(target)) {
        enterRegion("side");
        pointRegionCursor(side, target);
      }
      syncSoon(() => {
        const s = useKeyboardSteeringStore.getState();
        const back = s.active && s.level === "region" && s.region ? regionRoot(s.region) : null;
        if (back?.contains(target)) pointRegionCursor(back, target);
      });
    }

    function steerKey(e: KeyboardEvent, landed: boolean) {
      const steering = useKeyboardSteeringStore.getState();
      // The key's meaning on this level, from the user's steering bindings.
      const context: SteeringKeyContext =
        steering.level === "region" ? "region" : steering.level === "projects" ? "projects" : "panes";
      const bindings = useSettingsStore.getState().settings?.steering_keys as SteeringKeyMap | undefined;
      const action = steeringActionFor(e, context, bindings);

      // The shortcut cheat sheet, from every level (its host listens for the
      // event): ↑/↓ scroll it, Escape closes it.
      if (action === "help") {
        window.dispatchEvent(new Event("app:open-shortcut-help"));
        return;
      }
      // Space (by default) leaves the mode from anywhere.
      if (action === "exit") {
        exitSteering();
        return;
      }
      // H (by default) folds the key list into the corner badge and back; the
      // mode itself stays on.
      if (action === "legend") {
        steering.toggleLegend();
        return;
      }
      switch (steering.level) {
        case "projects":
          steerProjects(e, action);
          return;
        case "panes":
        case "tabs":
        case "scroll":
          steerPanes(e, action, steering.level);
          return;
        case "region": {
          const region = steering.region;
          if (!region) {
            steering.setLevel(steering.regionReturn);
            return;
          }
          if (landed && (action === "up" || action === "down" || action === "left" || action === "right")) return;
          // The key that opened the side panel leaves it again, as Back does.
          const sideBack = !action && region === "side" && steeringKeyIs(e, "sidePanel", bindings);
          steerRegion(sideBack ? "back" : action, region);
          return;
        }
      }
    }

    async function onKeyDown(e: KeyboardEvent) {
      if (hasActiveModal() || isSteeringSynthetic(e)) return;
      const overrides = useSettingsStore.getState().settings
        ?.keyboard_shortcuts as ShortcutMap | undefined;
      // Super key — toggle the side panels, where that key is actually ours.
      //
      // On macOS Cmd reports as "Meta" and is the platform-primary shortcut
      // modifier (see shortcuts.chordMatches), so a lone-key toggle would fire
      // on every Cmd+key chord. On Windows the lone Win key belongs to the OS —
      // the Start menu opens on key *release* at the shell level and
      // preventDefault() cannot stop it, and every global Win+X shortcut
      // pressed while Tabtivity is focused fires a lone "Meta" keydown first,
      // spuriously toggling the panels. Both therefore use F9 (below).
      //
      // `PLATFORM === "linux"` used to be the whole test, which quietly said
      // "on Linux this key is free". True of Cinnamon, where the binding was
      // written; false of GNOME, which opens the Activities overview on Super
      // and forwards a lone "Meta" keydown ahead of every Super+<key> shell
      // shortcut — reintroducing the exact Windows symptom on the branch
      // assumed safe (user, 2026-09-07, after a move to GNOME/Wayland: panels
      // gone, and with them the reveal handle, with nothing on screen saying
      // why). Ownership of the bare key is a property of the DESKTOP, not the
      // OS, so ask the backend which one is running.
      //
      // And the toggle fires on RELEASE, not here, and only for a LONE press —
      // see `onKeyUp`. The keydown just arms it. That is what keeps the panels
      // in place on a desktop the probe could not classify: a backend that
      // predates the probe answers nothing, the key then counts as ours, and
      // the shell's Super+Tab / Super+1 / Super+arrow and a bare Super for the
      // overview all used to fire the toggle off this keydown. Now a chord
      // disarms it and a lost focus cancels it (user, 2026-09-07: the memory
      // watchdog had just reloaded the window, one Super press later the side
      // panel was gone).
      //
      // The binding is the panel toggle's chord being a lone Super tap
      // (`LONE_SUPER`): its default where the desktop leaves the key to the
      // window (`livePanelToggleKey`), or the user's explicit choice.
      if (PLATFORM === "linux" && superTogglesPanels(overrides) && isSuperKey(e.key)) {
        e.preventDefault();
        if (!e.repeat) {
          superHeld = true;
          superChorded = false;
        }
        return;
      }
      // Any other key while Super is down makes the press a chord, not a toggle.
      if (superHeld) superChorded = true;

      // F11 (as bound) — the window's fullscreen mode, on every platform (the
      // same toggle as the fullscreen button in `WindowControls`; see
      // `lib/window/fullscreenMode` for why it is recorded).
      if (chordMatches(resolveChord("osFullscreen", overrides), e)) {
        e.preventDefault();
        void toggleWindowFullscreen();
        return;
      }

      // The panel toggle as a key chord — F9 by default, on every desktop
      // (`actionChords`: beside a lone-Super default too).
      if (actionMatches("togglePanels", overrides, e)) {
        e.preventDefault();
        onTogglePanels();
        return;
      }

      // Ctrl +/- / Ctrl+0 (as bound) — per-window UI zoom (this is the MAIN window; a popout
      // handles its own — see DetachedApp). Handled before the editable-target
      // guard so it works from a focused terminal too (the browser-zoom
      // convention). Agent panes consume these for font zoom and stopPropagation,
      // so those never reach here. Persisted to `ui_zoom` (the main window's own
      // value), which `updateSettings` also re-applies to this webview.
      const zoom = zoomFor(e, overrides);
      if (zoom) {
        const cur = useSettingsStore.getState().settings?.ui_zoom;
        const z = zoom === "reset" ? 1 : stepZoom(cur, zoom === "in" ? 1 : -1);
        e.preventDefault();
        void useSettingsStore
          .getState()
          .updateSettings({ ui_zoom: z === 1 ? undefined : z });
        return;
      }

      const tabs = useTabsStore.getState();

      // Escape (as bound) exits app-internal fullscreen (when active). Only
      // act if we're fullscreen, otherwise let overlays / terminals see it.
      if (tabs.fullscreenGroupId && chordMatches(resolveChord("exitFullscreen", overrides), e)) {
        e.preventDefault();
        tabs.toggleFullscreen(null);
        return;
      }

      // Don't steal keys from a focused text field (e.g. inline tab rename) —
      // except the macOS ⌘W family, which `editorMayTakeChord` admits, and the
      // tab steps a pane terminal hands over (`terminalMayTakeChord`).
      const editable = isEditableTarget(e.target);
      if (editable && !isMacCommandChord(e) && !isPaneTerminalTarget(e.target)) return;

      // Resolve the configured chord for an action (user override or default).
      // From an editable target only those exceptions may match.
      const is = (action: ShortcutAction) =>
        (!editable || editorMayTakeChord(action, e) || terminalMayTakeChord(action, e)) &&
        chordMatches(resolveChord(action, overrides), e);

      // Toggle app-internal fullscreen of the focused subwindow.
      if (is("toggleFullscreen")) {
        const focused = tabs.focusedGroupId;
        if (focused) {
          e.preventDefault();
          tabs.toggleFullscreen(focused);
        }
        return;
      }

      // Cycle to the next / previous active project.
      if (is("cycleProject")) {
        e.preventDefault();
        cycleProject(1);
        return;
      }
      if (is("cycleProjectBack")) {
        e.preventDefault();
        cycleProject(-1);
        return;
      }

      // Cycle to the next / previous box (the box pills' row order).
      if (is("cycleBox")) {
        e.preventDefault();
        cycleBox(1);
        return;
      }
      if (is("cycleBoxBack")) {
        e.preventDefault();
        cycleBox(-1);
        return;
      }

      // Open the shortcut cheat sheet. This hook only fires the door event
      // (the header-menu pattern); the overlay host owns the dialog.
      if (is("shortcutHelp")) {
        e.preventDefault();
        window.dispatchEvent(new Event("app:open-shortcut-help"));
        return;
      }

      // Close the focused subwindow. Mirror the mouse close button, which only
      // appears when groupCount > 1 (Subwindow.showClose): never close the last
      // remaining subwindow from the keyboard either, so the scope can't be left
      // empty by a stray chord.
      if (is("closeSubwindow")) {
        const focused = tabs.focusedGroupId;
        if (focused && allGroups(tabs.layout).length > 1) {
          e.preventDefault();
          tabs.closeGroup(focused);
        }
        return;
      }

      // Hide the focused subwindow (park it in the side-panel Hidden list,
      // keeping its tabs/PTYs alive). Unlike closeSubwindow this is allowed even
      // for the last remaining subwindow — hiding it just shows the +-placeholder.
      if (is("hideSubwindow")) {
        const focused = tabs.focusedGroupId;
        if (focused) {
          e.preventDefault();
          tabs.hideGroup(focused);
        }
        return;
      }

      // Toggle the focused subwindow's docked file viewer (same flag the ◫
      // button and the sidebar's resize-edge double-click write).
      if (is("toggleSubwindowFiles")) {
        const focused = tabs.focusedGroupId;
        const group = focused ? findGroup(tabs.layout, focused) : null;
        if (focused && group) {
          e.preventDefault();
          tabs.setGroupFiles(focused, !group.filesOpen);
        }
        return;
      }

      // Close the active tab.
      if (is("closeTab")) {
        if (tabs.activeKey) {
          e.preventDefault();
          closeTabWithConfirm(tabs.activeKey);
        }
        return;
      }

      // Close every tab in the current project (scope). The active project's
      // debounced saveLayout effect then persists the now-empty layout.
      if (is("closeAllTabs")) {
        if ((tabs.tabsByScope[tabs.scope] ?? []).length > 0) {
          e.preventDefault();
          tabs.closeAllTabs();
        }
        return;
      }

      // Previous / next tab within the focused subwindow, and the equivalent
      // Shift+Tab cycle. All three step the focused group's active tab.
      const prev = is("prevTab");
      if (prev || is("nextTab") || is("cycleTabs")) {
        const focused = tabs.focusedGroupId;
        const group = focused ? findGroup(tabs.layout, focused) : null;
        if (group && group.tabKeys.length > 1) {
          e.preventDefault();
          const len = group.tabKeys.length;
          const cur = group.activeKey
            ? group.tabKeys.indexOf(group.activeKey)
            : 0;
          const delta = prev ? -1 : 1;
          const next = group.tabKeys[(cur + delta + len) % len];
          tabs.setGroupActive(group.id, next);
        }
        return;
      }

      // Cycle the focused subwindow. Enters a Shift-held preview (default chord
      // Ctrl+Shift+↑/↓): the frame moves to the previewed group and numbered
      // badges show over every subwindow; focus only commits on Shift release
      // (keyup below), Ctrl included or not. Numbering is anchored to the
      // committed focus (id 0), so stepping wraps in document order.
      const down = is("subwindowDown");
      if (down || is("subwindowUp")) {
        const ids = allGroups(tabs.layout).map((g) => g.id);
        const n = ids.length;
        if (n >= 2) {
          e.preventDefault();
          const nav = useSubwindowNavStore.getState();
          const base =
            nav.active && nav.previewGroupId
              ? nav.previewGroupId
              : tabs.focusedGroupId;
          const baseIdx = base ? ids.indexOf(base) : -1;
          const from = baseIdx >= 0 ? baseIdx : 0;
          const nextIdx = (from + (down ? 1 : -1) + n) % n;
          nav.preview(ids[nextIdx]);
        }
        return;
      }
    }

    // Commit the previewed subwindow focus when Shift is released; cancel (no
    // focus move) if the window loses focus mid-preview.
    function onKeyUp(e: KeyboardEvent) {
      if (hasActiveModal()) {
        superHeld = false;
        superChorded = false;
        cancelSuperToggle();
        return;
      }
      // The lone-Super toggle (armed in `onKeyDown`) lands here, after a short
      // settle: the shell that owns this key takes focus on the same release
      // (GNOME's overview, KDE's launcher), and the blur that follows cancels
      // the pending toggle instead of racing it.
      if (superHeld && isSuperKey(e.key)) {
        const lone = !superChorded;
        superHeld = false;
        superChorded = false;
        const overrides = useSettingsStore.getState().settings
          ?.keyboard_shortcuts as ShortcutMap | undefined;
        if (lone && PLATFORM === "linux" && superTogglesPanels(overrides)) {
          e.preventDefault();
          cancelSuperToggle();
          superToggleTimer = window.setTimeout(() => {
            superToggleTimer = null;
            if (!hasActiveModal()) onTogglePanels();
          }, SUPER_RELEASE_SETTLE_MS);
        }
      }
      const nav = useSubwindowNavStore.getState();
      if (nav.active && (e.key === "Shift" || !e.shiftKey)) {
        if (nav.previewGroupId) useTabsStore.getState().focusGroup(nav.previewGroupId);
        nav.end();
      }
    }
    function onBlur() {
      // Focus left with Super down or just released: the desktop answered the
      // key (overview, launcher, a window switch) — not a panel toggle.
      superHeld = false;
      superChorded = false;
      cancelSuperToggle();
      const nav = useSubwindowNavStore.getState();
      if (nav.active) nav.end();
      // Steering must not survive a window blur either — coming back to a
      // window silently swallowing every key would read as a hung app.
      if (useKeyboardSteeringStore.getState().active) exitSteering();
    }

    // Which desktop is running decides whether the bare Super key is ours (see
    // the binding above). One cached probe per session; fire-and-forget,
    // because until it answers the handler keeps the pre-existing behavior.
    if (PLATFORM === "linux") void probeSuperKeyOwnership();

    // A terminal steering scrolled goes back to its live end the moment
    // steering is no longer inside it (↑, Space, a status jump, a blur…) —
    // scrolled up, tmux's copy mode would take the next keys typed into it.
    const unsubscribeScroll = useKeyboardSteeringStore.subscribe((s) => {
      if (!s.active || s.level !== "scroll") releaseTerminalScroll();
    });
    // While steering is on, a dialog or menu coming or going — raised by the
    // app itself (a host-key prompt), closed by its own timer or the pointer —
    // moves steering (and so the legend) at once, not at the next key. Only
    // mounts and unmounts count; nothing is watched while steering is off.
    const layerWatch =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (useKeyboardSteeringStore.getState().active) syncLayer();
          });
    let watching = false;
    const watchLayers = (on: boolean) => {
      if (!layerWatch || on === watching) return;
      watching = on;
      if (on) layerWatch.observe(document.body, { childList: true, subtree: true });
      else layerWatch.disconnect();
    };
    watchLayers(useKeyboardSteeringStore.getState().active);
    const unsubscribeLayers = useKeyboardSteeringStore.subscribe((s) => watchLayers(s.active));

    document.addEventListener("keydown", onSteeringKeyDown, true);
    document.addEventListener("pointerdown", onSteeringPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelSuperToggle();
      cancelPlace();
      for (const id of syncTimers) window.clearTimeout(id);
      unsubscribeScroll();
      unsubscribeLayers();
      watchLayers(false);
      document.removeEventListener("keydown", onSteeringKeyDown, true);
      document.removeEventListener("pointerdown", onSteeringPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [onTogglePanels, onSidePanel]);
}

/** Steering's status jumps and the tab state each walks. */
const STATUS_ACTIONS: Partial<Record<SteeringAction, TabStatusKind>> = {
  nextDecision: "decision",
  nextWorking: "working",
  nextDone: "done",
};

/** Whether a lone Super tap toggles the panels (the panel toggle's chord). */
function superTogglesPanels(overrides: ShortcutMap | undefined): boolean {
  return isLoneSuper(resolveChord("togglePanels", overrides));
}

/** A steering chord typed within this long of the last text key is text. */
const TYPING_BURST_MS = 400;

/** Whether a chord would type a character (no Ctrl / Alt / Meta held). */
function typesText(chord: ChordDescriptor): boolean {
  return !chord.ctrl && !chord.alt && !chord.meta && normalizeKey(chord.key).length === 1;
}

function closeApp(app: SteeringApp) {
  const store = appOverlayStore(app);
  if (store.overlayOpen) store.closeOverlay();
}

/** Put the side panel on the next / previous of its views — the settings patch
 *  its switcher and edge rail write. */
function stepSidePanelView(delta: 1 | -1) {
  const settings = useSettingsStore.getState().settings;
  const key = sidePanelViewKey(
    useProjectsStore.getState().activeId,
    useTabsStore.getState().scope,
  );
  const current = settings?.side_panel_view_by_project?.[key] ?? settings?.side_panel_view ?? "files";
  const at = SIDE_PANEL_VIEWS.indexOf(current);
  const n = SIDE_PANEL_VIEWS.length;
  const next = SIDE_PANEL_VIEWS[at < 0 ? 0 : (at + delta + n) % n];
  void useSettingsStore.getState().updateSettings(sidePanelViewPatch(next, key, settings));
}

/**
 * Cycle the active scope to the next one (by display order).
 *
 * The **root terminal is a station in the cycle**, not a hole in it: it is the
 * pill strip's first pill, so a shortcut that walks the strip has to stop there
 * too. It was skipped, and worse than skipped — cycling *out* of the root scope
 * worked (no pill matches a `null` activeId, so `-1 + 1` landed on the first
 * project) while cycling *back into* it was impossible, making the shortcut a
 * one-way door out of the root terminal.
 *
 * `null` leads the ring for the same reason the pill is pinned to the left edge.
 *
 * The ring itself lives in `stores/keyboardSteering.projectStations` — the
 * steering digits and pill badges number the same list, so the three surfaces
 * can never disagree about which project is station N.
 */
function cycleProject(delta: 1 | -1) {
  const ps = useProjectsStore.getState();
  const stations = projectStations();
  if (stations.length < 2) return;
  const idx = stations.indexOf(ps.activeId);
  const next = stations[(idx + delta + stations.length) % stations.length];
  if (next !== ps.activeId) void ps.setActive(next);
}

/**
 * Walk the boxes in row order — the order their pills stand in beside the
 * scope chip — and open the next / previous one (`openBox`, which moves the
 * tab scope into the box; the switcher follows the scope into the slice).
 * From outside any box the first step lands on the first box (walking back:
 * the last), so the chord is also the way INTO the boxes from a project.
 */
export function cycleBox(delta: 1 | -1) {
  const store = useBoxesStore.getState();
  const boxes = [...store.boxes].sort((a, b) => a.position - b.position);
  if (boxes.length === 0) return;
  const scope = useTabsStore.getState().scope;
  const current = scope.startsWith(BOX_SCOPE_PREFIX)
    ? scope.slice(BOX_SCOPE_PREFIX.length)
    : null;
  const idx = current ? boxes.findIndex((b) => b.id === current) : -1;
  const next =
    idx < 0
      ? boxes[delta > 0 ? 0 : boxes.length - 1]
      : boxes[(idx + delta + boxes.length) % boxes.length];
  if (next.id !== current) void store.openBox(next.id);
}
