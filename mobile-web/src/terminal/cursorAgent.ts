/**
 * Cursor agent's screens (`cursor-agent` 2026.11.22), for a tab whose label
 * names it. Read from the real binary outside the app, never in a tab
 * (`scripts/verify-cli/cursor/tui_screens.py`; frames at 120, 60 and 42 columns).
 *
 * The live frame, after `readableScreen` has dropped the box edges. The input
 * row is `→`, its draft continues on rows indented four; the footer is rows
 * indented two, each only while it has something to say:
 *
 *    ⠘⠤ Running  73 tokens                 busy row, only while a turn runs
 *       Tip: Hit shift+tab to …            a rotating tip, wrapped when narrow
 *
 *     → Add a follow-up        ctrl+c to stop   `Plan, search, build anything`
 *                                               in a fresh chat; the hint is
 *                                               there only while a turn runs
 *     1 task                                background work, while there is some
 *     Plan (shift+tab to cycle)             the mode, when it is not the agent's
 *     Auto · 5.5% · 1 file edited           model · context used · file count
 *     ~/work · main                         folder · branch (wraps when narrow)
 *
 * The model row's right end names the approval setting (`Run Everything`,
 * `Auto-review`): read as nothing, because it is no mode the Shift+Tab cycle
 * walks. A parameterised model draws its context window and level after its
 * name (`Claude Sonnet 5.5 300K High`). The context figure is what the window
 * holds (`percentFull` in the bundle: it grows from 5.5% to 5.6% over a turn),
 * so it is flipped to what is left, as everywhere.
 *
 * What the keys do (probed): Ctrl+C stops a running turn (the busy row prints
 * `ctrl+c to stop`) and, on an idle box, only asks `Press Ctrl+C again to
 * exit`; Esc stops nothing. Shift+Tab cycles agent, Plan, Debug, Ask, agent.
 */

import type { SelectOption, SelectPrompt } from "./selectPrompt";
import type { SessionStatus } from "./statusLine";

interface CursorLineLike { text: string }

/** The registry's label for `cursor-agent` is "Cursor". */
const AGENT = /cursor/iu;

export function isCursorTab(agentLabel?: string): boolean {
  return agentLabel !== undefined && AGENT.test(agentLabel);
}

/**
 * The `/model` dialog (first captured on 2026.09.26, unchanged on 2026.11.22),
 * at 60 columns:
 *
 *    → Plan, search, build anything        ← the input box, above the dialog
 *
 *   Available models                             Max mode: OFF
 *
 *   Filter:
 *
 *      Auto
 *   →  Grok 4.7                 256K High Fast (Tab to modify)
 *      Grok 4.6                 High Fast
 *      Composer 2.5             Fast
 *      …
 *
 *   1-10 of 39
 *
 *   Type to filter • Enter to select • Tab to edit
 *
 * The rows carry no numbers, so `selectPrompt` recognized nothing and the
 * model sheet waited out its timeout on an empty list. The dialog is found by
 * its heading and filter field instead, and its rows are numbered here by
 * their place in the whole list, which the window note gives (`4-13 of 39` →
 * these rows are 4 to 13). That lets the caller walk the highlight by a
 * difference of printed numbers, as it does for a windowed Claude Code picker:
 * the dialog moves one row per ↑/↓, wraps at either end, and applies the
 * highlighted model on a single Enter.
 *
 * At phone width Ink lays the rows out loosely: the indent drifts by a column
 * from row to row, a row's note wraps onto rows of its own far to the right,
 * the highlighted row's `(Tab to modify)` hint is interleaved with its note,
 * and a blank row can sit inside the list. Rows are told from their wrapped
 * notes by indent alone, and a note that does not read cleanly is dropped
 * rather than shown garbled.
 *
 * Everything here is read off the screen. What is pressed is the caller's.
 */

/** How far up from the bottom the heading may sit: ten rows, each wrapped
 * onto up to three at phone width, and the footer under them. */
const SEARCH_WINDOW = 50;
/** The heading, with the `Max mode` readout the dialog right-aligns beside it. */
const HEADING = /^\s{0,4}(Available models)(?:\s{2,}(\S.*))?$/u;
/** The filter field, empty or holding a query: between the heading and the
 * rows, and what tells this dialog from a heading somebody printed. */
const FILTER_FIELD = /^\s{0,4}Filter:/u;
/** A row: the dialog's one-column margin, then the highlight arrow or the
 * blanks every other row is indented by. How deep is left to the indent check
 * below — at phone width it drifts from row to row. */
const ROW = /^\s*(→\s+)?(\S.*)$/u;
/** A wrapped note sits in the note column, far right of any row's label. */
const MIN_NOTE_INDENT = 8;
/** The window a list too long for the pane is drawn in: `4-13 of 39`. */
const WINDOW_RANGE = /^(\d{1,3})\s*[-–]\s*(\d{1,3})\s+of\s+(\d{1,3})$/u;
/** The keyboard line under the list; the list has ended by then. */
const FOOTER = /^Type to filter\b/u;
const COLUMN_SPLIT = /\s{2,}/u;
/** The hint the dialog prints after the highlighted row's note. */
const MODIFY_HINT = /\s*\(Tab to modify\)\s*$/u;
/** Rows read out of one dialog; the cap only bounds a misread. */
const MAX_ROWS = 24;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 120;

function skipBlank(lines: readonly CursorLineLike[], from: number): number {
  let index = from;
  while (index < lines.length && !lines[index].text.trim()) index += 1;
  return index;
}

/** The lowest `Available models` heading on screen, or -1. The lowest, because
 * a dialog the session has scrolled past is not the one it is showing. */
function headingIndex(lines: readonly CursorLineLike[]): number {
  const first = Math.max(0, lines.length - SEARCH_WINDOW);
  for (let index = lines.length - 1; index >= first; index -= 1) {
    if (HEADING.test(lines[index].text.replace(/\s+$/u, ""))) return index;
  }
  return -1;
}

/**
 * The `Available models` dialog the session is showing right now, as the rows
 * the phone lists, or `null` when the screen holds none in the recognized
 * shape — which includes a frame caught mid-repaint, whose row count does not
 * match its own window note.
 */
export function readCursorPicker(lines: readonly CursorLineLike[]): SelectPrompt | null {
  const heading = headingIndex(lines);
  if (heading < 0) return null;
  let index = skipBlank(lines, heading + 1);
  if (index >= lines.length || !FILTER_FIELD.test(lines[index].text)) return null;
  index = skipBlank(lines, index + 1);

  const start = index;
  const rows: { label: string; notes: string[]; marked: boolean }[] = [];
  let range: RegExpExecArray | null = null;
  for (; index < lines.length && rows.length <= MAX_ROWS; index += 1) {
    const text = lines[index].text.replace(/\s+$/u, "");
    if (!text) continue;
    const trimmed = text.trim();
    range = WINDOW_RANGE.exec(trimmed);
    if (range || FOOTER.test(trimmed)) break;
    const indent = text.length - text.trimStart().length;
    const row = indent < MIN_NOTE_INDENT ? ROW.exec(text) : null;
    if (row) {
      const [label, ...notes] = row[2].split(COLUMN_SPLIT);
      rows.push({ label: label.trim().slice(0, MAX_LABEL), notes, marked: row[1] !== undefined });
      continue;
    }
    const last = rows[rows.length - 1];
    if (!last || indent < MIN_NOTE_INDENT) return null;
    last.notes.push(trimmed);
  }
  // One highlight, always: walking from a highlight this cannot see is a guess.
  if (rows.length < 2 || rows.length > MAX_ROWS || rows.filter((row) => row.marked).length !== 1) return null;

  let first = 1;
  let total = rows.length;
  if (range) {
    const [from, to, count] = range.slice(1).map(Number);
    // The note counts these very rows, or the frame is not a whole one.
    if (to - from + 1 !== rows.length || count < to) return null;
    first = from;
    total = count;
  }

  return {
    options: rows.map((row, at) => {
      let description = row.notes.join(" ").replace(/\s+/gu, " ").trim();
      if (row.marked) description = description.replace(MODIFY_HINT, "");
      // The highlighted row's hint, interleaved with its note at phone width.
      if (/[()]/u.test(description)) description = "";
      return {
        index: at,
        number: first + at,
        label: row.label,
        ...(description ? { description: description.slice(0, MAX_DESCRIPTION) } : {}),
      };
    }),
    current: rows.findIndex((row) => row.marked),
    title: HEADING.exec(lines[heading].text.replace(/\s+$/u, ""))![1],
    start,
    // The heading is the dialog's question; what sits above it — the input
    // box, the banner — is the session's own screen.
    question: heading,
    context: heading,
    ...(total > rows.length ? { hidden: total - rows.length } : {}),
  };
}

// ── The live frame ───────────────────────────────────────────────────────────

interface CursorFrameLine { text: string; frameText?: string }

/** The input row: `→` and the draft, or the placeholder. */
const INPUT_ROW = /^\s*→(?:\s|$)/u;
/** The input row while a turn runs: the key that stops it at the right end,
 * after the placeholder or the draft. It is there for that turn only, which
 * is what makes it the busy sign: the busy row above it (`⠘⠤ Running`) is
 * left on screen, a ghost, after the turn ended (probed, 2026.11.22). */
const STOP_HINT = /^\s*→\s.*\sctrl\+c to stop\s*$/u;
/** The busy row: two braille spinner cells, the verb and, once it has any,
 * the tokens the turn spent (`⠘⠤ Running  73 tokens`). */
const SPINNER = /^\s*[\u2800-\u28ff]{1,3}\s+\p{L}[\p{L} ]*?(?:\s{2,}(\d+(?:\.\d+)?\s*[kKmM]?)\s+tokens)?\s*$/u;
/** The mode row, only while the mode is not the agent's own. */
const MODE_ROW = /^(Plan|Ask|Debug)(?: \(shift\+tab to (?:cycle|exit)\))?$/u;
/** `1 task`, `2 tasks`: background work under the box. */
const TASKS_ROW = /^\d+ tasks?$/u;
const CONTEXT_USED = /^(\d{1,3}(?:\.\d+)?)\s?%$/u;
/** What follows a model's name on the model row: its context window and its
 * level or switches (`Claude Sonnet 5.5 300K High`, `Grok 4.7 256K High Fast`,
 * `Composer 2.5 Fast`). */
const MODEL_SIZE = /^\d+(?:\.\d+)?[kKmM]$/u;
const MODEL_LEVEL = /^(none|minimal|low|medium|high|xhigh|max)$/iu;
const MODEL_SWITCH = /^(fast|thinking)$/iu;
/** A folder may have single spaces in its name; the double-spaced columns of
 * a menu's rows are not one. */
const PATH_ROW = /^(~(?:\/(?:\S| (?=\S))*)?|\/(?:\S| (?=\S))+|[A-Za-z]:[\\/](?:\S| (?=\S))+)$/u;
/** Rows of the frame looked through from the bottom for the input row: the
 * footer is at most five (tasks, mode, model, and a path wrapped onto three at
 * 42 columns), the draft a few lines. */
const FRAME_REACH = 14;
/** Rows over the box that are the TUI's own: the busy row, the tip under it
 * and the follow-ups box, where a prompt sent mid-turn waits. */
const TIP_ROW = /^\s+Tip: /u;
const QUEUE_ROW = /^\s*(?:[○●›] \S|enter steer\b|editing · enter done\b)/u;
const OVER_BOX_REACH = 6;

export interface CursorFrame {
  /** The first row of the frame: what is the TUI's and not the output's. */
  start: number;
  /** The row of the input box. */
  input: number;
  status: SessionStatus;
}

/** The model row's model and level: `Claude Sonnet 5.5 300K High` is
 * `Claude Sonnet 5.5`, level `high`. */
export function cursorModel(words: string): { model: string; effort?: string } {
  const tokens = words.trim().split(/\s+/u);
  let effort: string | undefined;
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (MODEL_LEVEL.test(last)) effort = last.toLowerCase();
    else if (!MODEL_SIZE.test(last) && !MODEL_SWITCH.test(last)) break;
    tokens.pop();
  }
  return { model: tokens.join(" "), ...(effort ? { effort } : {}) };
}

/** The context left from the figure used, one decimal kept. */
function contextLeft(used: string): string {
  return `${Math.round((100 - Math.min(100, Math.max(0, Number.parseFloat(used)))) * 10) / 10}%`;
}

/** The rows under the box (`rows`, blanks gone) as the facts they print, or
 * null when they are not a footer: a model row, then the folder. */
function readFooter(rows: readonly string[]): SessionStatus | null {
  const status: SessionStatus = {};
  let model = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index].trim();
    const mode = MODE_ROW.exec(row);
    if (mode && model < 0) {
      status.mode = mode[1].toLowerCase();
      continue;
    }
    if (model < 0 && TASKS_ROW.test(row)) continue;
    model = index;
    break;
  }
  if (model < 0 || model === rows.length - 1) return null;
  // The right end is the approval setting, a column of its own.
  const [left] = rows[model].trim().split(/\s{2,}/u);
  const [name, ...rest] = left.split(" · ").map((segment) => segment.trim());
  if (!name) return null;
  const read = cursorModel(name);
  status.model = read.model;
  if (read.effort) status.effort = read.effort;
  for (const segment of rest) {
    const used = CONTEXT_USED.exec(segment);
    if (used) status.context = contextLeft(used[1]);
  }
  // The folder wraps onto rows of its own at phone width, mid-word.
  const where = rows.slice(model + 1).map((row) => row.trim()).join("");
  const [path, branch] = where.split(/\s*·\s*/u);
  if (!PATH_ROW.test(path)) return null;
  status.path = path;
  if (branch && /^[\w./-]+$/u.test(branch)) status.branch = branch;
  return status;
}

/**
 * Cursor's live frame, for a tab whose label names it: the input row `→`, its
 * draft, and the footer under it — or `null` when the bottom of the screen is
 * none of it (a dialog, a menu, the resume list, `Press Ctrl+C again to exit`
 * in the footer's place).
 */
export function readCursorFrame(lines: readonly CursorFrameLine[], agentLabel?: string): CursorFrame | null {
  if (!isCursorTab(agentLabel)) return null;
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].text.trim()) end -= 1;
  let input = -1;
  let seen = 0;
  for (let index = end; index >= 0 && seen < FRAME_REACH; index -= 1) {
    if (!lines[index].text.trim()) continue;
    seen += 1;
    if (INPUT_ROW.test(lines[index].text)) {
      input = index;
      break;
    }
  }
  if (input < 0) return null;
  // The draft goes on at four columns in; the footer is two in.
  let below = input + 1;
  while (below <= end && (!lines[below].text.trim() || /^ {4}\S/u.test(lines[below].text))) below += 1;
  const status = readFooter(lines.slice(below, end + 1).map((line) => line.text).filter((text) => text.trim()));
  if (!status) return null;
  return { start: frameStart(lines, input), input, status };
}

/** The busy row over the box at `input`, or -1: only when what lies between
 * them is its tip. The row is left behind as a ghost when a turn ends, with
 * the answer under it. */
function busySpinner(lines: readonly CursorFrameLine[], input: number): number {
  let spinner = -1;
  let seen = 0;
  for (let index = input - 1; index >= 0 && seen < OVER_BOX_REACH; index -= 1) {
    if (!lines[index].text.trim()) continue;
    seen += 1;
    if (SPINNER.test(lines[index].text)) {
      spinner = index;
      break;
    }
  }
  if (spinner < 0) return -1;
  let tip = false;
  for (let index = spinner + 1; index < input; index += 1) {
    const text = lines[index].text;
    if (!text.trim()) continue;
    if (TIP_ROW.test(text)) tip = true;
    else if (!tip || !/^ {2}\S/u.test(text)) return -1;
  }
  return spinner;
}

/** Where the frame starts over the box at `input`: the busy row, its tip and
 * the follow-ups box over it. */
function frameStart(lines: readonly CursorFrameLine[], input: number): number {
  const spinner = busySpinner(lines, input);
  let start = input;
  if (spinner >= 0) {
    start = spinner;
    for (let index = spinner - 1; index >= 0; index -= 1) {
      const row = lines[index];
      if (!row.text.trim()) continue;
      if (QUEUE_ROW.test(row.text) || /┌─ follow-ups/u.test(row.frameText ?? "")) start = index;
      else break;
    }
  }
  while (start > 0 && !lines[start - 1].text.trim()) start -= 1;
  return start;
}

/**
 * Whether a turn is running, read off the screen: the box carries the stop
 * hint, or the busy row stands over it with its tip. The hint goes while a
 * draft is typed into the box, the busy row does not. With the tokens the busy
 * row counts so far (`73`, `1.2k`), once it counts any. Null on any screen
 * that is not Cursor's frame with a turn running.
 */
export function cursorWork(lines: readonly CursorFrameLine[]): { tokens?: string } | null {
  let seen = 0;
  for (let index = lines.length - 1; index >= 0 && seen < FRAME_REACH; index -= 1) {
    if (!lines[index].text.trim()) continue;
    seen += 1;
    if (!INPUT_ROW.test(lines[index].text)) continue;
    // Any pane has an arrow row somewhere: this one is Cursor's box only with
    // its footer under it.
    if (!footerOrNothing(lines, index)) return null;
    const spinner = busySpinner(lines, index);
    if (spinner < 0 && !STOP_HINT.test(lines[index].text)) return null;
    const tokens = spinner >= 0 ? SPINNER.exec(lines[spinner].text)?.[1]?.replace(/\s+/gu, "") : undefined;
    return tokens ? { tokens } : {};
  }
  return null;
}

/** Whether what lies under the box at `input` is Cursor's footer, or nothing
 * at all (the field that asks what to do instead has no footer). */
function footerOrNothing(lines: readonly CursorFrameLine[], input: number): boolean {
  let below = input + 1;
  while (below < lines.length && (!lines[below].text.trim() || /^ {4}\S/u.test(lines[below].text))) below += 1;
  const rest = lines.slice(below).map((line) => line.text).filter((text) => text.trim());
  return rest.length === 0 || readFooter(rest) !== null;
}

/** Whether a row is the box with the stop hint: a turn runs (or a field
 * under it waits for words). */
export function cursorStopHint(text: string): boolean {
  return STOP_HINT.test(text);
}

// ── Approval and trust dialogs ───────────────────────────────────────────────

/**
 * What the dialogs draw in place of the box (`Run this command?`, `Write to
 * this file?`, the workspace trust page), read off the screen:
 *
 *    $  sleep 20; echo hi in .
 *
 *    Run this command?
 *    Not in allowlist: echo, sleep
 *     → Run (once) (y)
 *       Add Shell(sleep), Shell(echo) to allowlist? (tab)
 *       Run Everything (shift+tab)
 *       Skip & tell the agent what to do instead (esc or n)
 *
 *    ▶ [a] Trust this workspace
 *      [q] Quit
 *
 * The rows carry no numbers but each names its own key, in parentheses at the
 * row's end (`(y)`, `(tab)`, `(shift+tab)`, `(esc or n)`) or in brackets at its
 * start (`[a]`), and that key answers the row whatever the highlight is on, so
 * a row is answered with it, never by walking. A row wraps at phone width, so
 * rows are put together until one ends in its key. `esc or n` (and `esc or n
 * or p`) answer with the letter: Esc alone waits out the terminal's escape
 * time. Esc, Ctrl+C and `n` on a shell command open a field to tell the agent
 * what to do instead (`Tell the agent what to do instead`); that field is
 * the box with its own hint, not a dialog.
 */
const KEY_NAME = String.raw`(?:enter|esc|tab|shift\+tab|[a-z])`;
const KEY_SPEC = new RegExp(String.raw`^${KEY_NAME}(?: or ${KEY_NAME})*$`, "u");
const KEY_TAIL = /^(.*\S)\s*\(([^()]+)\)\s*$/u;
const KEY_HEAD = /^\[([a-z])\]\s+(\S.*)$/u;
const ROW_MARK = /^(→|▶)\s+(\S.*)$/u;
const KEY_CODES: Record<string, string> = { tab: "\t", "shift+tab": "\u001b[Z", esc: "\u001b", enter: "\r" };
/** Rows read for a dialog from the bottom: its options, wrapped, and the hint
 * the trust page ends in. */
const DIALOG_REACH = 24;

/** The keys a hint names, as one write: a letter wins over Esc. */
function hintKeys(spec: string): string[] | null {
  if (!KEY_SPEC.test(spec)) return null;
  const names = spec.split(" or ");
  const letter = names.find((name) => /^[a-z]$/u.test(name));
  if (letter) return [letter];
  const key = KEY_CODES[names[0]];
  return key ? [key] : null;
}

/** A row's words with its key: `Run (once) (y)` → label and `y`. The parens
 * must balance, so a row cut at the pane's edge is not complete yet. */
function keyedRow(text: string): { label: string; keys: string[] } | null {
  const head = KEY_HEAD.exec(text);
  if (head) {
    const keys = hintKeys(head[1]);
    return keys ? { label: head[2].trim(), keys } : null;
  }
  const tail = KEY_TAIL.exec(text);
  if (!tail) return null;
  const opens = (text.match(/\(/gu) ?? []).length;
  const closes = (text.match(/\)/gu) ?? []).length;
  const keys = opens === closes ? hintKeys(tail[2]) : null;
  return keys ? { label: tail[1].trim(), keys } : null;
}

export interface CursorDialogHelpers {
  title: (lines: readonly CursorLineLike[], start: number) => string | undefined;
  context: (lines: readonly CursorLineLike[], start: number) => { question: number; context: number };
}

interface DialogRow { text: string; index: number }

/** The trust page's closing hint, under its options. */
const TRUST_HINT = /^\s*Use arrow keys to navigate\b/u;
/** Where an unmarked option starts: the label column, two past the arrow's. */
const OPTION_INDENT = 4;

/** `parts` (an option's rows) as one row with its key. Words wrapped at a
 * space join with one; a long word is cut at the edge and joins with none. */
function keyedParts(parts: readonly string[]): { label: string; keys: string[] } | null {
  return keyedRow(parts.join(" ")) ?? keyedRow(parts.join(""));
}

/** The dialog at the bottom of the screen: rows each naming the key that
 * answers them, exactly one highlighted. */
export function readCursorDialog(lines: readonly CursorLineLike[], helpers: CursorDialogHelpers): SelectPrompt | null {
  let bottom = lines.length - 1;
  while (bottom >= 0 && !lines[bottom].text.trim()) bottom -= 1;
  if (bottom < 0) return null;
  // The trust page ends in a hint of its own, wrapped over up to three rows.
  for (let index = bottom, seen = 0; index >= 0 && seen < 4; index -= 1) {
    if (!lines[index].text.trim()) continue;
    seen += 1;
    if (TRUST_HINT.test(lines[index].text)) {
      bottom = index - 1;
      while (bottom >= 0 && !lines[bottom].text.trim()) bottom -= 1;
      break;
    }
  }
  if (bottom < 0) return null;
  const run: DialogRow[] = [];
  for (let index = bottom; index >= 0 && bottom - index < DIALOG_REACH && lines[index].text.trim(); index -= 1) {
    run.unshift({ text: lines[index].text, index });
  }
  // Options start at the arrow, at the label column or at a leading `[key]`;
  // what lies over the first of them is the dialog's own text.
  const starts = (row: DialogRow): boolean => {
    const text = row.text.trimStart();
    return ROW_MARK.test(text) || KEY_HEAD.test(text) || row.text.length - text.length >= OPTION_INDENT;
  };
  const first = run.findIndex(starts);
  if (first < 0) return null;
  const options: SelectOption[] = [];
  const pending: string[][] = [];
  let current = -1;
  for (const row of run.slice(first)) {
    const mark = ROW_MARK.exec(row.text.trimStart());
    const text = (mark ? mark[2] : row.text).trim();
    if (starts(row)) {
      if (mark) {
        if (current >= 0) return null;
        current = pending.length;
      }
      pending.push([text]);
    } else {
      pending[pending.length - 1].push(text);
    }
  }
  for (const parts of pending) {
    const row = keyedParts(parts);
    if (!row) return null;
    options.push({ index: options.length, number: options.length + 1, label: row.label.slice(0, 160), keys: row.keys });
  }
  if (current < 0 || options.length < 2 || options.length > 8) return null;
  const start = run[first].index;
  const trust = KEY_HEAD.test(run[first].text.trimStart().replace(/^▶\s+/u, ""));
  const asked = trust ? trustQuestion(lines, start) : null;
  const { question, context } = asked ?? helpers.context(lines, start);
  return { options, current, title: questionTitle(lines, question, start) ?? helpers.title(lines, start), start, question, context };
}

/** The question the rows answer: the first row of the block over them that
 * ends in a question mark (`Run this command?`, `Write to this file?`), which
 * a description under it (`Not in allowlist: echo, sleep`) or a wrapped line
 * of the folder does not make the heading. */
function questionTitle(lines: readonly CursorLineLike[], from: number, to: number): string | undefined {
  for (let index = from; index < to; index += 1) {
    const text = lines[index].text.trim();
    if (!text) continue;
    if (!text.endsWith("?")) continue;
    let head = index;
    while (head > from && lines[head - 1].text.trim()) head -= 1;
    return lines.slice(head, index + 1).map((line) => line.text.trim()).join(" ").slice(0, 80);
  }
  return undefined;
}

/** The trust page's question — `Do you trust the contents of this directory?`
 * — and, over it, what the page says about the risk. The box draws them
 * with no blank row between, so the question is found by its mark and its
 * wrapped start by the sentence before it ending. The folder under the
 * question stays with it. */
function trustQuestion(lines: readonly CursorLineLike[], start: number): { question: number; context: number } | null {
  let end = start - 1;
  while (end >= 0 && !lines[end].text.trim()) end -= 1;
  let mark = -1;
  for (let index = end; index >= 0 && end - index < 6 && lines[index].text.trim(); index -= 1) {
    if (lines[index].text.trim().endsWith("?")) {
      mark = index;
      break;
    }
  }
  if (mark < 0) return null;
  let question = mark;
  while (question > 0 && lines[question - 1].text.trim() && !/[.?!]$/u.test(lines[question - 1].text.trim())) question -= 1;
  let context = question;
  for (let index = question - 1; index >= 0 && question - index <= 6 && lines[index].text.trim(); index -= 1) context = index;
  return { question, context };
}
