import type { Terminal } from "@xterm/xterm";
import { terminalFor } from "./terminalRegistry";

/**
 * Scrolling a terminal pane from the keyboard — steering's scroll level — the
 * way its mouse wheel would.
 *
 * Every local tab runs inside tmux with `mouse on`, so the pane's own xterm
 * holds no scrollback: tmux draws it an alternate screen and reads the wheel as
 * mouse reports, entering its copy mode (`copy-mode -e`, five lines a notch) or
 * handing them to a CLI that tracks the mouse itself (Claude Code's fullscreen
 * view). So while the program tracks the mouse, a keyboard scroll IS wheel
 * notches, sent through xterm's own wheel path (a synthetic `wheel` over the
 * screen), which encodes them as the program asked. A terminal that tracks
 * nothing scrolls its own scrollback; an alternate screen that tracks nothing
 * (xterm would turn the wheel into ↑/↓ — prompt history, in an agent) is left
 * alone.
 *
 * Scrolled up, tmux stays in copy mode, where typed keys drive the copy mode
 * instead of reaching the program. `releaseTerminalScroll` takes every notch
 * back when steering leaves the scroll level, so the pane is live again before
 * anyone types into it.
 *
 * An agent pane showing its Reader (chat mode, `TerminalReaderView`, drawn
 * over the terminal in the same host) scrolls the Reader's conversation
 * instead: the terminal is hidden beneath it, and wheel notches sent there
 * would only move tmux into a copy mode nobody sees.
 */

/** Lines one wheel notch moves tmux's copy mode (its default `-N 5`). */
const LINES_PER_NOTCH = 5;

/** Net wheel-up notches sent per PTY and not yet taken back. */
const owed = new Map<string, number>();
/** PTYs whose own scrollback was moved. */
const moved = new Set<string>();

function sendWheel(term: Terminal, notches: number): void {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || notches === 0) return;
  // Over the middle of the screen: xterm reports the wheel at the cell under
  // the pointer, and one outside the screen reports nothing.
  const r = screen.getBoundingClientRect();
  const init: WheelEventInit = {
    deltaY: Math.sign(notches),
    deltaMode: WheelEvent.DOM_DELTA_LINE,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    bubbles: true,
    cancelable: true,
  };
  // One report per event, as a real wheel sends one per notch.
  for (let i = 0; i < Math.abs(notches); i++) screen.dispatchEvent(new WheelEvent("wheel", init));
}

/** The conversation of a Reader shown over this terminal, if one is. */
function readerList(term: Terminal): HTMLElement | null {
  return term.element?.parentElement?.querySelector<HTMLElement>(":scope > .terminal-reader .terminal-reader-list") ?? null;
}

/**
 * Scroll the pane `pages` screens (negative = back, into the history). False
 * when there is no terminal, or nothing a keyboard scroll can move.
 */
export function scrollTerminal(ptyId: string, pages: number): boolean {
  const term = terminalFor(ptyId);
  if (!term || pages === 0) return false;
  const reader = readerList(term);
  if (reader) {
    // A little under a whole screen, so a line read last stays in sight.
    reader.scrollTop += Math.sign(pages) * Math.max(1, Math.round(reader.clientHeight * Math.abs(pages) * 0.9));
    return true;
  }
  const lines = Math.sign(pages) * Math.max(1, Math.round(term.rows * Math.abs(pages)));
  if (term.modes.mouseTrackingMode !== "none") {
    const notches = Math.sign(lines) * Math.max(1, Math.round(Math.abs(lines) / LINES_PER_NOTCH));
    sendWheel(term, notches);
    owed.set(ptyId, Math.max(0, (owed.get(ptyId) ?? 0) - notches));
    return true;
  }
  if (term.buffer.active.type === "normal") {
    term.scrollLines(lines);
    moved.add(ptyId);
    return true;
  }
  return false;
}

/** Back to the live end of the pane: every wheel-up notch taken back (tmux's
 *  `-e` copy mode leaves itself at the bottom), or the scrollback's bottom. */
export function scrollTerminalToLive(ptyId: string): void {
  const term = terminalFor(ptyId);
  const up = owed.get(ptyId) ?? 0;
  owed.delete(ptyId);
  moved.delete(ptyId);
  if (!term) return;
  const reader = readerList(term);
  if (reader) reader.scrollTop = reader.scrollHeight;
  if (up > 0 && term.modes.mouseTrackingMode !== "none") sendWheel(term, up);
  term.scrollToBottom();
}

/** Every pane a keyboard scroll moved, back to live. */
export function releaseTerminalScroll(): void {
  if (owed.size === 0 && moved.size === 0) return;
  for (const ptyId of new Set([...owed.keys(), ...moved])) scrollTerminalToLive(ptyId);
}
