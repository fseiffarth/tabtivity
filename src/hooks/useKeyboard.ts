import { hasActiveModal } from "./useModalFocus";
import { useEffect } from "react";
import { PLATFORM } from "../lib/window/dragPlatform";
import { IS_MAC } from "../lib/platform";
import { toggleWindowFullscreen } from "../lib/window/fullscreenMode";
import { probeSuperKeyOwnership } from "../lib/shortcuts/superKey";
import { ROOT_SCOPE, allGroups, findGroup, stepOrderedTab, useTabsStore } from "../stores/tabs";
import { steeringInRoot, steeringTabs, steeringTabsActive } from "../lib/shortcuts/steeringScope";
import { closeTabInScope, closeTabWithConfirm } from "../lib/remote/closeRemoteTab";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../stores/boxes";
import { useBoxSliceStore } from "../stores/boxSlice";
import { useSettingsStore, stepZoom } from "../stores/settings";
import { useSubwindowNavStore } from "../stores/subwindowNav";
import { isSteeringSynthetic } from "../lib/shortcuts/steeringRegion";
import { useRootOverlayStore } from "../stores/rootOverlay";
import { isPaneTerminalTarget, terminalMayTakeChord } from "../lib/shortcuts/terminalTabChord";
import {
  actionMatches,
  chordMatches,
  isLoneSuper,
  resolveChord,
  zoomFor,
  type ShortcutAction,
  type ShortcutMap,
} from "../lib/shortcuts/shortcuts";
import { cycleProject, useSteering } from "./useSteering";

export { STEERING_BLUR_GRACE_MS } from "./useSteering";

interface KeyboardOptions {
  onTogglePanels: () => void;
  /** Open (showing the panels if they were hidden) or close the side panel —
   *  steering's B key, and Escape back out of it. */
  onSidePanel?: (open: boolean) => void;
  /** Ctrl+B / ⌘B (and Alt+1): show or hide the side panel. */
  onToggleSidePanel?: () => void;
}

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
  if (!isMacCommandChord(e)) return false;
  // ⌘B toggles the side panel from a field too, unless the field already took
  // it (the Markdown prompt's ⌘B bold calls preventDefault first).
  if (action === "toggleSidePanel") return !e.defaultPrevented;
  return EDITOR_CLOSE_ACTIONS.has(action);
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
 *   - Ctrl+Tab / Ctrl+Shift+Tab → next / previous tab of the project, across
 *                            all its subwindows (document order, wrapping),
 *                            from a focused pane terminal too (terminalTabChord)
 *   - AltGr+Tab / AltGr+Shift+Tab → next / previous active project, from a
 *                            focused pane terminal too (Alt+Shift+→ / ← as well;
 *                            the arrows are the macOS default — no AltGr)
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
 *   - F1                   → open the shortcut cheat sheet (window event)
 *   - Shift+Space          → toggle keyboard steering mode (see below)
 *   - Ctrl+Shift+R         → open / close the root console
 *   - Ctrl+Shift+S         → root console shell at the active project's root
 *   - Ctrl+Shift+N / M     → new shell / System Monitor tab in the focused pane
 *   - Ctrl+1 … Ctrl+9      → new agent tab there: 1 = the default agent, 2–9
 *                            the + menu's other agents in order; while a mail /
 *                            calendar / to-do view is shown, that slot's root
 *                            agent docks beside the app instead
 *                            (`shownApp`, `requestOverlayAgent`)
 *
 * Steering mode (`steeringMode` chord): a modal layer for the rebindable keys
 * in `steeringBindings.ts` (explained by `STEERING_KEYS`), captured on `document` in the CAPTURE phase so xterm never
 * sees them and the mode works FROM a focused terminal — the point is that the
 * hands never leave the keyboard. While active every key is swallowed. The
 * mode is a hierarchy (`SteeringLevel`): projects → subwindows → tabs, ↓ in and
 * ↑ out (E S D F double the arrows by default), opening on the tabs; Escape
 * or Enter leave it (Space opens the prompt box on an agent tab). Plus a region cursor (`lib/shortcuts/steeringRegion`) for the
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

export function useKeyboard({ onTogglePanels, onSidePanel, onToggleSidePanel }: KeyboardOptions) {
  // Steering first: its document capture listeners are added before this
  // hook's window ones, the order they had when both lived in one effect.
  useSteering({ surface: "main", onTogglePanels, onSidePanel });
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

      // Match the configured chords of an action (user override or default,
      // with a default's aliases — `actionChords`). From an editable target only
      // those exceptions may match.
      const is = (action: ShortcutAction) =>
        (!editable || editorMayTakeChord(action, e) || terminalMayTakeChord(action, e)) &&
        actionMatches(action, overrides, e);

      // The tab and subwindow chords below act on what the user is looking at.
      // While the root window's Root view is in front that is **Root's** tabs
      // and subwindows (close, step and cycle within the shown Root subwindow);
      // on any other view of the window there is nothing of the workspace in
      // sight, so they do nothing to the tabs behind it. Popped-out subwindows
      // are not in Root's shown layout (`steeringTabs`) and stay untouched.
      const windowUp = useRootOverlayStore.getState().open;
      const inRootView = steeringInRoot();

      // Toggle app-internal fullscreen of the focused subwindow.
      if (is("toggleFullscreen")) {
        const focused = tabs.focusedGroupId;
        if (focused && !windowUp) {
          e.preventDefault();
          tabs.toggleFullscreen(focused);
        }
        return;
      }

      // Cycle to the next / previous active project.
      if (is("cycleProject")) {
        e.preventDefault();
        void cycleProject(1);
        return;
      }
      if (is("cycleProjectBack")) {
        e.preventDefault();
        void cycleProject(-1);
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

      // Show / hide the side panel (Ctrl+B, ⌘B; Alt+1 off macOS). `is` cannot
      // carry the alias, so it is matched over `actionChords` with the same gate.
      if (
        onToggleSidePanel &&
        (!editable ||
          editorMayTakeChord("toggleSidePanel", e) ||
          terminalMayTakeChord("toggleSidePanel", e)) &&
        actionMatches("toggleSidePanel", overrides, e)
      ) {
        e.preventDefault();
        onToggleSidePanel();
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
        if (focused && !windowUp && allGroups(tabs.layout).length > 1) {
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
        if (focused && !windowUp) {
          e.preventDefault();
          tabs.hideGroup(focused);
        }
        return;
      }

      // Toggle the focused subwindow's docked file viewer (same flag the ◫
      // button and the sidebar's resize-edge double-click write).
      if (is("toggleSubwindowFiles")) {
        if (windowUp) {
          const walked = steeringTabs();
          const rootGroup = inRootView && walked.focusedGroupId ? findGroup(walked.layout, walked.focusedGroupId) : null;
          if (rootGroup) {
            e.preventDefault();
            tabs.setGroupFilesInScope(ROOT_SCOPE, rootGroup.id, !rootGroup.filesOpen);
          }
          return;
        }
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
        if (windowUp) {
          const active = inRootView ? steeringTabsActive() : null;
          if (active) {
            e.preventDefault();
            closeTabInScope(active.scope, active.tab.key);
          }
          return;
        }
        if (tabs.activeKey) {
          e.preventDefault();
          closeTabWithConfirm(tabs.activeKey);
        }
        return;
      }

      // Close every tab in the current project (scope). The active project's
      // debounced saveLayout effect then persists the now-empty layout.
      if (is("closeAllTabs")) {
        if (!windowUp && (tabs.tabsByScope[tabs.scope] ?? []).length > 0) {
          e.preventDefault();
          tabs.closeAllTabs();
        }
        return;
      }

      // Previous / next tab within the focused subwindow, and the equivalent
      // Shift+Tab cycle. All three step the focused group's active tab.
      const prev = is("prevTab");
      if (prev || is("nextTab") || is("cycleTabs")) {
        // Root view: Root's focused subwindow; another view: nothing to step.
        const walked = windowUp ? (inRootView ? steeringTabs() : null) : { scope: tabs.scope, layout: tabs.layout, focusedGroupId: tabs.focusedGroupId };
        const focused = walked?.focusedGroupId ?? null;
        const group = focused && walked ? findGroup(walked.layout, focused) : null;
        if (walked && group && group.tabKeys.length > 1) {
          e.preventDefault();
          const len = group.tabKeys.length;
          const cur = group.activeKey
            ? group.tabKeys.indexOf(group.activeKey)
            : 0;
          const delta = prev ? -1 : 1;
          const next = group.tabKeys[(cur + delta + len) % len];
          tabs.setGroupActiveInScope(walked.scope, group.id, next);
        }
        return;
      }

      // Next / previous tab of the whole project: every subwindow's tabs in
      // document order, so past the focused subwindow's last tab comes the next
      // subwindow's first (focus moves along). A fullscreen subwindow moves with
      // it, or the step would land in one nobody can see.
      const prevAll = is("prevProjectTab");
      if (prevAll || is("nextProjectTab")) {
        const walked = windowUp ? (inRootView ? steeringTabs() : null) : { scope: tabs.scope, layout: tabs.layout, focusedGroupId: tabs.focusedGroupId };
        const step = walked ? stepOrderedTab(walked.layout, walked.focusedGroupId, prevAll ? -1 : 1) : null;
        if (walked && step) {
          e.preventDefault();
          tabs.setGroupActiveInScope(walked.scope, step.groupId, step.key);
          if (!windowUp && tabs.fullscreenGroupId && tabs.fullscreenGroupId !== step.groupId) {
            tabs.toggleFullscreen(step.groupId);
          }
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
        // Root view: step Root's subwindows at once (no Shift preview, whose
        // numbered badges belong to the workspace's frames); other views: none.
        if (windowUp) {
          const walked = inRootView ? steeringTabs() : null;
          const rootIds = walked ? allGroups(walked.layout).map((g) => g.id) : [];
          if (walked && rootIds.length >= 2) {
            e.preventDefault();
            const from = Math.max(0, walked.focusedGroupId ? rootIds.indexOf(walked.focusedGroupId) : 0);
            tabs.focusGroupInScope(ROOT_SCOPE, rootIds[(from + (down ? 1 : -1) + rootIds.length) % rootIds.length]);
          }
          return;
        }
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
    }

    // Which desktop is running decides whether the bare Super key is ours (see
    // the binding above). One cached probe per session; fire-and-forget,
    // because until it answers the handler keeps the pre-existing behavior.
    if (PLATFORM === "linux") void probeSuperKeyOwnership();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelSuperToggle();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [onTogglePanels, onToggleSidePanel]);
}

/** Whether a lone Super tap toggles the panels (the panel toggle's chord). */
function superTogglesPanels(overrides: ShortcutMap | undefined): boolean {
  return isLoneSuper(resolveChord("togglePanels", overrides));
}

/**
 * Walk the box ring and step to the next / previous stop. The ring is
 * `[the project you came from, box1 … boxN]` (boxes in row order — the order
 * their pills stand in beside the scope chip): the step past the last box
 * returns to that project and unslices (`leaveBox`, which hands the scope back
 * to where the unsliced strip last stood), so one chord is a full round trip;
 * walking back mirrors it. From outside any box the first step lands on the
 * first box (back: the last), so the chord is also the way INTO the boxes.
 * Boxes open through `openBox`, which moves the tab scope into the box (the
 * switcher follows the scope into the slice).
 *
 * "Inside box X" is the scope `box:X`, or — visiting one of its members with
 * the slice still selected — the slice's box, so the chord keeps its place in
 * the ring while you hop between a box's projects.
 */
export function cycleBox(delta: 1 | -1) {
  const store = useBoxesStore.getState();
  const boxes = [...store.boxes].sort((a, b) => a.position - b.position);
  if (boxes.length === 0) return;
  const scope = useTabsStore.getState().scope;
  const current = scope.startsWith(BOX_SCOPE_PREFIX)
    ? scope.slice(BOX_SCOPE_PREFIX.length)
    : useBoxSliceStore.getState().sliceBoxId;
  // Stop 0 is the project you came from; box i is stop i + 1.
  const at = current ? boxes.findIndex((b) => b.id === current) + 1 : 0;
  const stops = boxes.length + 1;
  const nextStop = (at + delta + stops) % stops;
  if (nextStop === 0) void useBoxSliceStore.getState().leaveBox();
  else void store.openBox(boxes[nextStop - 1].id);
}
