/**
 * Counting what you *asked* — prompts sent to agents, commands run in shells.
 *
 * There is no API for this: an agent CLI is a TUI on a PTY, and Tabtivity only sees
 * the bytes going into it. The one thing that reliably marks a submission is
 * Enter (`\r`) pressed after you typed something. So we track, per PTY, whether
 * any *content* has been typed since the last Enter, and count one submit each
 * time Enter arrives with content pending.
 *
 * This is a heuristic, and it is the deliberate alternative to reading Claude's
 * and Codex's private transcript directories: it works for all eleven agents and
 * every local model, and it never touches another application's data.
 *
 * What it is careful about:
 *
 * - **Escape sequences** (arrow keys, Home/End, mouse reports) arrive as `\x1b…`
 *   and are not content — otherwise navigating history would look like typing.
 * - **Control characters** (Ctrl-C, Tab-completion, backspace) are not content.
 * - **A paste** arrives as one `onData` chunk of printable text, so a
 *   paste-then-Enter is one prompt, which is right.
 * - **A bare Enter** on an empty line (scrolling an agent's menu, accepting a
 *   default) counts nothing.
 *
 * What it cannot know: an Enter inside a multi-line editor buffer looks like a
 * submit. It over-counts a little in that case. Stated in the recap rather than
 * hidden.
 */

/** Whether a chunk of terminal input contains any printable content. */
export function hasContent(data: string): boolean {
  // Strip escape sequences first: an arrow key is "\x1b[A", whose "[A" would
  // otherwise read as two printable characters.
  const withoutEscapes = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b./g, "");
  for (const ch of withoutEscapes) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 controls (incl. \r, \n, \t, backspace, Ctrl-*) and DEL are not content.
    if (code < 0x20 || code === 0x7f) continue;
    return true;
  }
  return false;
}

/** Whether a chunk contains a submit key (Enter / carriage return). */
export function hasSubmit(data: string): boolean {
  return data.includes("\r") || data.includes("\n");
}

/**
 * Per-PTY "has the user typed anything since the last Enter?" state.
 *
 * Kept outside React (like `activity.ts`'s per-PTY maps): it churns on every
 * keystroke and nothing renders off it.
 */
const pendingByPty: Record<string, boolean> = {};

/**
 * Feed one `onData` chunk for a PTY. Returns the number of submits to count
 * (0 or 1 — a chunk carrying several newlines is a multi-line paste, which is
 * still one thing asked).
 */
export function noteInput(ptyId: string, data: string): number {
  const content = hasContent(data);
  if (!hasSubmit(data)) {
    if (content) pendingByPty[ptyId] = true;
    return 0;
  }
  // Enter arrived. A chunk can carry both (a bracketed paste ending in newline,
  // or typing fast enough to batch) — content anywhere in it counts as pending.
  const submits = pendingByPty[ptyId] || content ? 1 : 0;
  pendingByPty[ptyId] = false;
  return submits;
}

/** Forget a PTY's pending state (tab closed). */
export function forgetPty(ptyId: string): void {
  delete pendingByPty[ptyId];
}

/** Test seam: drop all pending state. */
export function _resetPromptCountForTest(): void {
  for (const key of Object.keys(pendingByPty)) delete pendingByPty[key];
}
