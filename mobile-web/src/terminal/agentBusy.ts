/** Whether the agent is in the middle of a turn, read off its live screen.
 *
 * Nearly every agent TUI prints how to stop it while — and only while — it
 * works: Claude Code's spinner row `✻ Thinking… (9s · esc to interrupt)`, Codex's
 * `• Working (0s • esc to interrupt)`, Gemini CLI's and Qwen Code's
 * `(esc to cancel, 3s)`, and OpenCode's status row, which carries
 * `esc interrupt` in a column of its own. Claude Code 2.1.278 dropped the
 * hint from its spinner (`✶ Cascading… (36s · ↓ 2.1k tokens)`), so that row is
 * read by its own shape (`CLAUDE_SPINNER`). The desktop's hook-driven turn state
 * would say the same, but reading it means a status call that can spawn the
 * CLI; the screen is already streaming to the phone. */

/** Rows read from the bottom. The hint sits above the input box, with at most
 * Claude Code's to-do list, the box itself and the footer rows below it. */
const BUSY_WINDOW = 24;

/** The hint as the TUIs print it: inside the spinner's parentheses after a
 * separator (`(9s · esc to interrupt)`, `(0s • esc to interrupt)`), opening
 * them (`(esc to interrupt)`, Gemini's `(esc to cancel, 3s)`), or as a
 * status row's column (`⬝⬝■■  esc interrupt`) with no sentence stop after it —
 * the row's end in `opencode --mini`, the full TUI's context and key hint
 * further over (`⬝⬝■■ esc interrupt    12.3K (5%)  ctrl+p commands`), and
 * `esc again to interrupt` after one press. A bare "esc to cancel" is a
 * dialog's footer — a question, not work — so the cancel form needs its
 * elapsed time. */
const BUSY_HINT =
  /\((?:[^()]*[·•,]\s*)?esc to interrupt\b[^()]*\)|\(esc to cancel, \d+s\)|(?:^|\s)esc (?:again to |to )?interrupt(?:\s*$|\s{2,})/iu;

/** Claude Code's spinner row without the hint: a spinner glyph, the verb with
 * its ellipsis, then the elapsed time opening the parentheses. The finished
 * row (`✻ Worked for 7m 59s · done 18:36`) has neither, and prose that ends a
 * bullet in an ellipsis has no timer after it. */
const CLAUDE_SPINNER = /^\s*[·✢✳✶✻✽*]\s+\S[^()]*…\s*\(\d+(?:\.\d+)?[hms]\b/u;

/** What the busy row says about the turn besides the fact that it runs: how
 * long it has been going, and how many tokens it has spent. Both are read
 * off the screen — nothing here counts, so a stale screen says a stale time
 * rather than a made-up one, and a TUI that prints neither shows neither. */
export type WorkFacts = { elapsed?: string; tokens?: string; effort?: string };

/** The parenthesised part of the busy row, where every family that prints
 * numbers prints them: `(36s · ↓ 2.1k tokens)`, `(9s · esc to interrupt)`,
 * `(esc to cancel, 3s)`. The last group on the row, because a verb can carry
 * its own aside before it. OpenCode's status row has no parentheses — and its
 * `223.0K` is the context it holds, not what this turn spent, so it stays
 * unread. */
const BUSY_FACTS = /\(([^()]*)\)(?=[^()]*$)/u;

/** The elapsed time as the TUIs write it: `0s`, `36s`, `1m 4s`, `2h 3m`. */
const ELAPSED = /\b(\d+(?:\.\d+)?h(?:\s+\d+(?:\.\d+)?m)?|\d+(?:\.\d+)?m(?:\s+\d+(?:\.\d+)?s)?|\d+(?:\.\d+)?s)\b/u;

/** The token count with its `k`/`M` suffix, without the direction arrow —
 * `↓ 2.1k tokens`, `↑ 310 tokens`. The word is what makes it a count: a bare
 * number in that row is the timer. */
const TOKENS = /(\d+(?:\.\d+)?\s*[kKmM]?)\s*tokens\b/u;

/** The reasoning effort Claude Code names on its spinner while it thinks —
 * `thinking with high effort` — the one place it prints the level. */
const EFFORT = /\bwith\s+([a-z][a-z-]*)\s+effort\b/iu;

/** Whether one row is a busy row — the spinner or the interrupt hint. A
 * dialog opened mid-turn is drawn right under Claude Code's spinner, so the
 * select-prompt reader (`selectPrompt`) needs to know it is not the dialog's
 * heading. */
export function busyRow(text: string): boolean {
  return BUSY_HINT.test(text) || CLAUDE_SPINNER.test(text);
}

/** The busy row's facts, or `null` when no row says the agent is working. */
export function agentWork(lines: readonly { text: string }[]): WorkFacts | null {
  for (let index = lines.length - 1; index >= 0 && index >= lines.length - BUSY_WINDOW; index -= 1) {
    const text = lines[index].text;
    if (!busyRow(text)) continue;
    const inside = BUSY_FACTS.exec(text)?.[1] ?? "";
    const elapsed = ELAPSED.exec(inside)?.[1];
    const tokens = TOKENS.exec(inside)?.[1].replace(/\s+/u, "");
    const effort = EFFORT.exec(text)?.[1].toLowerCase();
    return effort ? { elapsed, tokens, effort } : { elapsed, tokens };
  }
  return null;
}

export function agentWorking(lines: readonly { text: string }[]): boolean {
  return agentWork(lines) !== null;
}
