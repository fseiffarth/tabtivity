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
//
// Claude's "❯" has the same double life: it marks every sent prompt in its
// history too. So a pointer row counts only beside another option row of a
// different number (`hasPointerChoice`): a sent "1. fix x" is one row alone.
const POINTER_CHOICE = /[❯▶►➤»]\s*(\d+)[.)]\s*[^\s\d]/gu;

// A pointer glyph beside a bare yes/no-style word, e.g. "❯ Yes" / "❯ Allow" —
// the shape a simple binary confirmation takes when it isn't numbered (only
// multi-choice menus number their options). The word must be the whole row
// (a line end, the text's end, or a column gap a repaint left after it), and a
// row of the other answer must sit next to it (`hasPointerWordMenu`): Claude's
// sent "yes, watch for it to finish" and a sent bare "yes" both start with
// "❯ yes" and lit a finished tab as a question.
const POINTER_WORD =
  /[❯▶►➤»][ \t]*(yes|no|proceed|allow|approve|continue|cancel|reject|deny|don'?t)[ \t]*(?=\r?\n|$|[ \t]{2})/giu;

// Any bare one-word row, the pointer's counterpart; the same row end.
const BARE_WORD_ROW = /(?:^|[\r\n]|[ \t]{2})[ \t]*([A-Za-z]+(?:'[A-Za-z]+)?)[ \t]*(?=\r?\n|$|[ \t]{2})/g;

// Another menu row near a pointer row: a number and a word, as `MENU_OPTION`.
const NUMBERED_ROW = /(?:\D|^)(\d{1,2})[.)][ \t]*[A-Za-z]/g;

// How far either side of a pointer row its sibling options may sit: a menu's
// rows are adjacent, apart from an option's one-line description.
const MENU_REACH = 600;

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

// Codex's startup hook-trust menu (0.160.1–0.164.0): "Hooks need review" over
// "1. Review hooks / 2. Trust all and continue / 3. Continue without trusting".
// None of its labels is a deny word, so `hasYesNoMenu` misses it, yet Codex
// waits on it before the session starts. Anchored on the heading as well as a
// numbered "Trust" row, so a list item that merely starts with "Trust" in an
// agent's answer stays a list item. `\s*` for the diffing renderer's dropped
// spaces.
const CODEX_HOOK_TRUST_HEADING = /Hooks\s*need\s*review/;
const TRUST_OPTION = /(\D|^)\d{1,2}[.)][ \t]*Trust/;

// OpenCode questions have no pointer or yes/no pair. Their footer identifies
// the choice/toggle page and the final review. Cursor moves can omit spaces.
const OPENCODE_QUESTION_KEYS = /(?:↑\s*↓\s*select|⇆\s*tab)\s*enter\s*(?:submit|confirm|toggle)\s*esc\s*dismiss/u;

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

/** The text within `MENU_REACH` of a match, the match itself blanked out. */
function aroundMatch(plain: string, m: RegExpExecArray): string {
  const end = m.index + m[0].length;
  return plain.slice(Math.max(0, m.index - MENU_REACH), m.index) + "\n" + plain.slice(end, end + MENU_REACH);
}

/** A pointer on a numbered row with another numbered row beside it. */
function hasPointerChoice(plain: string): boolean {
  POINTER_CHOICE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = POINTER_CHOICE.exec(plain)) !== null) {
    const near = aroundMatch(plain, m);
    NUMBERED_ROW.lastIndex = 0;
    let row: RegExpExecArray | null;
    while ((row = NUMBERED_ROW.exec(near)) !== null) {
      if (Number(row[1]) !== Number(m[1])) return true;
    }
  }
  return false;
}

/** A pointer on a bare yes/no word with a bare row of the other answer beside it. */
function hasPointerWordMenu(plain: string): boolean {
  POINTER_WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = POINTER_WORD.exec(plain)) !== null) {
    const other = AFFIRM_WORD.test(m[1]) ? DENY_WORD : AFFIRM_WORD;
    const near = aroundMatch(plain, m);
    BARE_WORD_ROW.lastIndex = 0;
    let row: RegExpExecArray | null;
    while ((row = BARE_WORD_ROW.exec(near)) !== null) {
      if (other.test(row[1])) return true;
    }
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
  if (OPENCODE_QUESTION_KEYS.test(plain)) return true;
  if (hasPointerChoice(plain)) return true;
  if (hasPointerWordMenu(plain)) return true;
  if (CODEX_HOOK_TRUST_HEADING.test(plain) && TRUST_OPTION.test(plain)) return true;
  return hasYesNoMenu(plain);
}

/**
 * Claude Code's cold-resume dialog (2.1.304): `--resume` of a long-idle
 * conversation on Pro/Max asks "Resume this conversation?" before it spends a
 * share of the 5-hour limit. Title and cost line are the CLI's own wording,
 * matched space-tolerantly because a PTY tail that lost its cursor moves has
 * lost its spaces too. Distinctive enough to be read off a repainted
 * conversation, which no other menu is (see `stores/activity`'s
 * `awaitingHookByPty`).
 */
const COLD_RESUME_DIALOG = /Resume\s*this\s*conversation\?[\s\S]{0,800}?5-hour\s*usage\s*limit/;

/** `COLD_RESUME_DIALOG` on already ANSI-stripped text. */
export function looksLikeColdResumeDialogStripped(plain: string): boolean {
  return plain.includes("conversation?") && COLD_RESUME_DIALOG.test(plain);
}
