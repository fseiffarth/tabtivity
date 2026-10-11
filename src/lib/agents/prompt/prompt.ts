/**
 * Heuristic detection of an agent "waiting for a decision" prompt from its
 * terminal output. An agent tab that has gone quiet is either done with its turn
 * or blocked on a permission/choice prompt, and only the text on screen tells
 * the two apart — so we sniff the tail of its output for the interactive
 * selection menu that Claude/Codex (and similar) render while awaiting input.
 *
 * This is deliberately conservative and agent-shaped: it degrades to "not a
 * decision" (→ treated as finished) for agents whose prompts we don't recognize,
 * which is the safe default (a green "finished" lamp rather than a wrong orange).
 */

// A pointer glyph marking a numbered choice, e.g. "❯ 1. Yes" / "▶ 2) No" — the
// shape Claude Code and Codex use for approval/selection prompts. The space
// after the number is optional because Codex's TUI (ratatui) repaints by
// diffing cells and jumping the cursor over the unchanged ones, so the padding
// between words never reaches the wire at all.
//
// Codex's "›" is deliberately NOT a pointer here: it is also the marker Codex
// puts before every prompt the user sent, so a sent "continue" or "1. fix x"
// sat in its history looking exactly like a highlighted option and lit the tab
// as blocked on a question that did not exist. Codex's approval menus are
// numbered yes/no menus, which `hasYesNoMenu` catches without the glyph.
const POINTER_CHOICE = /[❯▶►➤»]\s*\d+[.)]\s*[^\s\d]/u;

// A pointer glyph directly beside a bare yes/no-style word, e.g. "❯ Yes" /
// "❯ Allow" — the shape a simple binary confirmation takes when it isn't
// numbered (only multi-choice menus number their options).
const POINTER_WORD =
  /[❯▶►➤»]\s*(yes|no|proceed|allow|approve|continue|cancel|reject|deny|don'?t)\b/i;

// One row of a numbered menu: the option's number and the FIRST WORD of its
// label. Matched independently of the pointer glyph, which a partial redraw can
// leave out (Codex's composer already draws a "›" in the cell the selection
// pointer lands in, and an unchanged cell is not re-sent).
//
// The leading `(\D|^)` stops the number from being the tail of a longer one
// while still matching a row glued to the one before it: that same diffing
// renderer sends a real Codex menu as "› 1. Yes, continue2.No,quit", spaces and
// all removed.
const MENU_OPTION = /(\D|^)(\d{1,2})[.)][ \t]*([A-Za-z]+(?:'[A-Za-z]+)?)/g;

// The two ways a menu row can answer a permission question. Classifying the
// LABEL rather than the option's NUMBER is what makes this work across agents:
// Claude puts its "No" second, Codex third — it offers two flavours of yes first
// ("Yes, just this once", then "Yes, and don't ask again for this command in
// this session"), which is exactly the menu the old number-locked pair missed.
const AFFIRM_WORD = /^(?:yes|allow|approve|accept|proceed|continue|run|apply|ok)$/i;
const DENY_WORD =
  /^(?:no|don'?t|deny|reject|decline|cancel|keep|skip|stop|abort|quit)$/i;

// Codex's startup hook-trust menu (0.160.1, 0.161.0): "Hooks need review" over
// "1. Review hooks / 2. Trust all and continue / 3. Continue without trusting".
// None of its labels is a deny word, so `hasYesNoMenu` misses it, yet Codex
// waits on it before the session starts. Anchored on the heading as well as a
// numbered "Trust" row, so a list item that merely starts with "Trust" in an
// agent's answer stays a list item. `\s*` for the diffing renderer's dropped
// spaces.
const CODEX_HOOK_TRUST_HEADING = /Hooks\s*need\s*review/;
const TRUST_OPTION = /(\D|^)\d{1,2}[.)][ \t]*Trust/;

/**
 * True when the text holds a numbered menu offering both an affirmative and a
 * negative answer — under any two numbers, in any order.
 */
function hasYesNoMenu(plain: string): boolean {
  MENU_OPTION.lastIndex = 0;
  let affirm = -1;
  let deny = -1;
  let m: RegExpExecArray | null;
  while ((m = MENU_OPTION.exec(plain)) !== null) {
    const option = Number(m[2]);
    const label = m[3];
    if (affirm < 0 && AFFIRM_WORD.test(label)) affirm = option;
    if (deny < 0 && DENY_WORD.test(label)) deny = option;
    if (affirm >= 0 && deny >= 0 && affirm !== deny) return true;
  }
  return false;
}

// Terminal escape sequences, peeled off in this order: OSC (`ESC ] … BEL|ST`),
// which can carry an arbitrary payload such as a window title; then CSI
// (`ESC [ … final byte`), the colour/cursor traffic that makes up most of a TUI
// redraw; then charset designators (`ESC ( B` and friends, which agents emit
// constantly); then any remaining two-character escape.
// ONE pass, not four. These alternatives were four separate global regexes run
// as four chained `.replace()` calls, which meant four full scans of the text
// and four fresh strings per call — and this runs on EVERY PTY output batch
// (~60/s per streaming agent tab, see `notePtyOutput`). Alternation is tried
// left-to-right at each position, so keeping the original order (OSC, CSI,
// charset, then any remaining two-char escape) preserves the exact semantics
// while allocating once.
const ANSI =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()*+][@-~]|\x1b[@-Z\\-_]/g;

/**
 * Strip ANSI escape sequences from terminal text. The prompt regexes above are
 * written against plain rows, but the text we classify comes straight off the
 * PTY stream — the only source available for a tab whose xterm was never opened
 * — where a menu line is shot through with colour codes.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * True when ALREADY ANSI-stripped text looks like an agent decision/permission
 * prompt awaiting the user's input.
 *
 * Split out because the hot caller (`stores/activity`'s `attentionFor`) tests a
 * tail it built from stripped chunks — so routing it through `stripAnsi` again
 * re-scanned and re-allocated the whole 8 KB tail several times a second, per
 * agent tab, to delete escapes that were never there.
 */
export function looksLikeDecisionPromptStripped(plain: string): boolean {
  if (POINTER_CHOICE.test(plain)) return true;
  if (POINTER_WORD.test(plain)) return true;
  if (CODEX_HOOK_TRUST_HEADING.test(plain) && TRUST_OPTION.test(plain)) return true;
  return hasYesNoMenu(plain);
}

/**
 * True when the given RAW terminal text (typically the tail of an agent's
 * output) looks like an agent decision/permission prompt awaiting the user's
 * input.
 */
export function looksLikeDecisionPrompt(text: string): boolean {
  return looksLikeDecisionPromptStripped(stripAnsi(text));
}
