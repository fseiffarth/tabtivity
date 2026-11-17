/**
 * Claude Code's reasoning-effort hint — `◐ medium · /effort`, a level word
 * after a gauge glyph (`○ ◐ ● …`), then the command that changes it.
 *
 * It is drawn in one of two places, depending on whether the user has a custom
 * statusline: right-aligned on the row *above* the input box (the box's top
 * rule, with the session's name in it, sits between them), or, with the stock
 * footer, at the right end of the footer's own row
 * (`⏵⏵ auto mode on (shift+tab to cycle) · ← for agents      ◐ medium · /effort`).
 * Read as ordinary status segments the second turned `/effort` into the
 * session's working directory, and the first was never read at all — and, left
 * outside the input frame, trailed the chat as a stray line.
 */

import type { StatusLineLike } from "./statusLine";

/** A glyph, the level, `·`, `/effort` — anchored to the row's end, so a
 * sentence that mentions the command is not the hint. */
const EFFORT_HINT = /(?:^|\s)[^\p{L}\p{N}\s/]\s*(low|medium|high|xhigh|max)\s+·\s+\/effort\s*$/u;

/** The level a row's hint names, or `undefined` for a row without one. */
export function claudeEffortHint(text: string): string | undefined {
  return EFFORT_HINT.exec(text)?.[1];
}

/** The row without its hint, for the segments that are the footer's own. */
export function withoutEffortHint(text: string): string {
  return text.replace(EFFORT_HINT, "");
}

/** The level the hint above the input box at `inputIndex` names, and its row.
 * Only the row right over the box counts (blank rows and the box's top rule
 * aside): output higher up is the conversation's. */
export function effortHintAbove(
  lines: readonly StatusLineLike[],
  inputIndex: number,
): { row: number; effort: string } | null {
  for (let row = inputIndex - 1; row >= 0; row -= 1) {
    const text = lines[row].text;
    if (!text.trim()) continue;
    // The rule's label (`──── session-name ─`) is left as a row of its own.
    if (/[─―—]{8,}/u.test(lines[row].frameText ?? "")) continue;
    const effort = claudeEffortHint(text);
    return effort ? { row, effort } : null;
  }
  return null;
}

/** The notice Claude Code adds under its footer inside tmux
 * (`tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and
 * reattach…`). It names a path of tmux's, not the session's, and is no status
 * row. */
const TMUX_NOTICE = /^\s*tmux\s+(?:focus-events|detected)\b/u;

export function isClaudeTmuxNotice(text: string): boolean {
  return TMUX_NOTICE.test(text);
}
