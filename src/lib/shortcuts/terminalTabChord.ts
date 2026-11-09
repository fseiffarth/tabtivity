/** Ctrl+Shift+←/→ (`prevTab` / `nextTab`) and Ctrl+Tab / Ctrl+Shift+Tab
 *  (`nextProjectTab` / `prevProjectTab`), or whatever they are rebound to, step
 *  the tabs from a focused terminal too. Every other nav chord
 *  stays the terminal's while it has focus (`useKeyboard.isEditableTarget`);
 *  these two are admitted because the hands are in a terminal when the next
 *  tab is wanted. The cost: a program in the terminal (vim, micro, Emacs)
 *  never sees them — which is also why the default isn't plain Shift+Arrow:
 *  an agent CLI in the terminal (Codex) uses that itself. Shift+Tab
 *  (`cycleTabs`) is deliberately not one of them — it is the agent CLIs' mode
 *  cycle.
 *
 *  Two halves: `TerminalView` leaves the chord unhandled (`terminalYieldsChord`)
 *  so xterm neither sends it to the PTY nor cancels the event, and the window's
 *  keyboard handler — main window and popout alike — resolves it from xterm's
 *  textarea (`terminalMayTakeChord`). */
import { actionChords, chordMatches, resolveChord, type ShortcutAction, type ShortcutMap } from "./shortcuts";
import { steeringInRoot } from "./steeringScope";

const TERMINAL_TAB_ACTIONS: readonly ShortcutAction[] = ["prevTab", "nextTab", "prevProjectTab", "nextProjectTab"];
const PROJECT_CYCLE_ACTIONS: readonly ShortcutAction[] = ["cycleProject", "cycleProjectBack"];

/** xterm's helper textarea in a workspace pane. The root window's terminals
 *  are excluded: the window sits over the workspace, so stepping the focused
 *  pane's tabs from there would switch tabs the user cannot see. Except on the
 *  Root view, where the same chords step **Root's** tabs (`useKeyboard`). */
export function isPaneTerminalTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.classList?.contains("xterm-helper-textarea")) return false;
  if (!el.closest(".root-overlay")) return true;
  return steeringInRoot() && !!el.closest(".root-console-backdrop");
}

/** Whether the window's handler may resolve `action` for a keydown typed into
 *  a pane terminal. */
export function terminalMayTakeChord(action: ShortcutAction, e: KeyboardEvent): boolean {
  if (!isPaneTerminalTarget(e.target)) return false;
  // The side-panel toggle only reaches the window from a terminal on an Alt
  // chord (Alt+1 by default); Ctrl+B stays tmux's and readline's.
  if (action === "toggleSidePanel") return e.altKey;
  // The project cycle only on its AltGr chord: a program in the terminal has no
  // use for AltGr+Tab, while the Alt+Shift+Arrow alias stays the terminal's.
  if (PROJECT_CYCLE_ACTIONS.includes(action)) return !!e.getModifierState?.("AltGraph");
  return TERMINAL_TAB_ACTIONS.includes(action);
}

/** Whether a pane terminal hands this keydown to the window instead of the PTY.
 *  The window's fullscreen chord (F11, as bound) is handed over by every
 *  terminal, the root console's too: xterm would otherwise send it to the PTY
 *  and cancel the event, so the window's handler never saw it. (The panel
 *  toggle's F9 is not: htop and mc answer F9 themselves.) */
export function terminalYieldsChord(e: KeyboardEvent, overrides: ShortcutMap | undefined | null): boolean {
  if (chordMatches(resolveChord("osFullscreen", overrides), e)) return true;
  if (
    isPaneTerminalTarget(e.target) &&
    actionChords("toggleSidePanel", overrides).some((c) => c.alt && chordMatches(c, e))
  ) {
    return true;
  }
  if (
    isPaneTerminalTarget(e.target) &&
    PROJECT_CYCLE_ACTIONS.some((action) => actionChords(action, overrides).some((c) => c.altGr && chordMatches(c, e)))
  ) {
    return true;
  }
  return (
    isPaneTerminalTarget(e.target) &&
    TERMINAL_TAB_ACTIONS.some((action) => chordMatches(resolveChord(action, overrides), e))
  );
}
