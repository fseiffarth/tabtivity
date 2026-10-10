import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { dialogLine } from "../../../mobile-web/src/markup/submitState";
import { terminalFor } from "../terminal/terminalRegistry";
import { readReaderLive } from "./readerLive";

/** The size a replay is drawn at when the tab has no terminal of its own yet. */
const FALLBACK_COLS = 120;
const FALLBACK_ROWS = 40;

/**
 * The question line of the dialog an agent tab waits on (a permission prompt,
 * the CLI's own question picker), for the desktop markup strip's pill
 * (`dialogLine`) — shown only; the answer is given in the tab.
 *
 * A hidden pane's xterm is not fed (visible-only streaming: the backend holds
 * its output until the pane shows), and the markup strip is up exactly while
 * the agent tab is hidden. So the screen is drawn again from the router's
 * retained tail (`pty_scrollback`) in an offscreen terminal of the pane's size
 * and read as the Reader reads a live one (`readReaderLive`). The tail starts
 * mid-stream; a dialog it cannot rebuild reads as none. Only a backend without
 * the command falls back to the pane's own buffer.
 */
export async function readTabDialogLine(ptyId: string, agentLabel: string): Promise<string | undefined> {
  const pane = terminalFor(ptyId);
  let data: string;
  try {
    const snapshot = await invoke<string | { data: string } | null>("pty_scrollback", { id: ptyId });
    data = typeof snapshot === "string" ? snapshot : snapshot?.data ?? "";
  } catch {
    return pane ? lineOf(pane, agentLabel) : undefined;
  }
  if (!data) return undefined;
  const term = new Terminal({ cols: pane?.cols ?? FALLBACK_COLS, rows: pane?.rows ?? FALLBACK_ROWS, scrollback: 0 });
  try {
    await new Promise<void>((resolve) => term.write(data, resolve));
    return lineOf(term, agentLabel);
  } finally {
    term.dispose();
  }
}

function lineOf(term: Terminal, agentLabel: string): string | undefined {
  const live = readReaderLive(term.buffer.active, agentLabel, term.cols);
  if (!live.question) return undefined;
  return dialogLine(live.ask) ?? live.question.title;
}
