/**
 * Reads the option list an agent TUI draws for a select dialog — the one
 * `/model` opens in Claude Code and Codex — so the phone can answer it by
 * tapping a row instead of walking the highlight there with the arrow keys.
 *
 * The scoping is the same as `statusLine`'s, and for the reason `readableScreen`
 * dropped the semantic parser it replaced: this never runs over ordinary
 * output. The caller reads it only while Tabtivity itself has just sent the
 * command that opens the dialog, and only a shape it positively recognizes — a
 * contiguous run of numbered rows, numbered from 1, carrying exactly one
 * highlight marker — becomes a list. Anything else returns `null`, the dialog
 * stays on screen as the session drew it, and the arrow keys still answer it.
 *
 * A dialog can also be several steps — Codex answers `/model` with a list of
 * models and then, for the model picked, a list of reasoning levels — so what
 * is recognized is one *step*: its rows, its highlight and its heading.
 * `selectSignature` is how a caller tells one step from the next.
 *
 * Nothing here sends keystrokes: what a tapped row does is the caller's.
 */

import { busyRow } from "./agentBusy";

export interface SelectOption {
  /** Position in the run, 0-based. The caller moves the highlight by the
   * difference between this and `current`, which is why it is not the printed
   * number: a dialog may renumber, but the rows are always in screen order. */
  index: number;
  /** The number the dialog printed beside the row — `UNNUMBERED` for the one
   * row a multi-select question prints none for (`ACTION_ROW`). */
  number: number;
  label: string;
  /** The note the dialog printed in the row's second column, if any. */
  description?: string;
}

export interface SelectPrompt {
  options: SelectOption[];
  /** Index of the row the dialog is highlighting — where the cursor starts. */
  current: number;
  /** The heading the dialog drew above its rows, when it drew one in a shape
   * this recognizes. A dialog can be several steps — Codex answers `/model`
   * with a model list and then a reasoning-level list for the model picked —
   * and the heading is what says which step is on screen. */
  title?: string;
  /** Rows the dialog has but is not drawing. Claude Code shows only as many
   * rows as its pane has room for — three at 24 lines — scrolls that window
   * with the highlight and says `… +2 models` under it, so the rows on screen
   * are a slice: `options` then need not start at 1. */
  hidden?: number;
  /** Index, in the lines read, of the dialog's first row. What sits above it
   * is what the rows answer — the question and whatever the agent printed to
   * ask it — which a caller that replaces the rows with a list of its own
   * still has to show. */
  start: number;
  /** Index of the dialog's own question: the block of text directly above its
   * rows, of which `title` is the first line. It belongs to the list — a
   * caller showing the rows in its own idiom shows this as their heading —
   * while `[context, question)` is the screen the dialog was drawn onto.
   * Equals `start` when the dialog drew no text above its rows. */
  question: number;
  /** Index of the first line worth showing above the question (`readContext`).
   * A dialog answers what is right above it, not the whole session. */
  context: number;
  /** A review page read as a dialog (`readReviewStep`): its one row is not the
   * CLI's own text, so a reader names it in its own words. */
  review?: true;
}

/** One step of a dialog as far as it is known: every row seen of it, in the
 * dialog's own order. A windowed dialog (`hidden`) only ever draws a slice, so
 * the step is what the slices add up to (`mergeSelectRows`). */
export interface SelectStep {
  title?: string;
  options: SelectOption[];
}

interface SelectLineLike { text: string; afterRule?: boolean }

/** How far up from the bottom a dialog may sit. Below it the TUI still draws
 * its footer ("Esc to cancel") and, in Codex, the input box — and at phone
 * width each row's note wraps over several lines. */
const SEARCH_WINDOW = 80;
/** A single numbered row is a sentence about a list, not a list. */
const MIN_OPTIONS = 2;
/** Longer than any picker either CLI draws; a longer run is not one. */
const MAX_OPTIONS = 12;

/** `❯ 1. Label   Description` once `readableScreen` stripped the box frame.
 * The marker is optional per row: exactly one row carries it. `↑`/`↓` sit in
 * the same slot on the first and last row of a windowed dialog, saying more
 * rows lie that way (`EDGE`) — they are not the highlight. */
const OPTION = /^\s*([❯▸▶›>→↑↓])?\s*(\d{1,2})[.)]\s+(\S.*)$/u;
/** Gemini CLI's selection list — and Qwen Code's, forked from it — marks the
 * highlighted row with a radio dot instead (`● 1.  Allow once`, read out of
 * the 0.56 bundle's `BaseSelectionList`). The same `●` opens every Claude Code
 * answer on Linux and every Kimi Code one, so an answer that starts with a
 * numbered list would read as a dialog: the dot is a marker only on a tab
 * whose agent draws it (`radioMarkerAgent`). */
const RADIO_OPTION = /^\s*([❯▸▶›>→●↑↓])?\s*(\d{1,2})[.)]\s+(\S.*)$/u;
const EDGE = /^[↑↓]$/u;
/** Claude Code's note under a windowed dialog: `… +2 models`. The line right
 * under the run, and nothing but the count and one word. */
const HIDDEN_ROWS = /^\s*(?:…|\.\.\.)\s*\+(\d{1,2})\s+\p{L}+$/u;
const RADIO_AGENT = /gemini|qwen/iu;
/** Claude Code's multi-select question (AskUserQuestion with `multiSelect`,
 * 2.1.286) ends its checkbox rows with one it prints no number for — `Next`,
 * or `Submit` on the last question — at the labels' column, with `❯` in the
 * marker slot while it is highlighted:
 *
 *     4. [ ] Type something
 *        Submit
 *     5. Chat about this
 *
 * Enter on a checkbox row only ticks it, so a phone that read this row as the
 * last row's note could tick boxes and never send them: the question stayed up
 * as answered. Read only right under a checkbox row, and only these words. */
const ACTION_ROW = /^\s*([❯▸▶›>→])?\s*(Submit|Next)$/u;
const CHECKBOX_LABEL = /^\[[^\]]\]\s/u;
const CHECKBOX_ROW = /^\s*[❯▸▶›>→]?\s*\d{1,2}[.)]\s+\[[^\]]\]\s/u;
/** `SelectOption.number` of a row the dialog printed no number beside. */
export const UNNUMBERED = 0;

/** Whether `lines[index]` is a multi-select question's `Submit`/`Next` row
 * (`ACTION_ROW`). Highlighted, it opens with the input line's `❯`, and taken
 * for the input box it cut the question off the screen it was waiting on. */
export function isActionRow(lines: readonly { text: string }[], index: number): boolean {
  return index > 0 && ACTION_ROW.test(lines[index].text) && CHECKBOX_ROW.test(lines[index - 1].text);
}

/** Whether the tab's agent marks a dialog's highlighted row with `●` — and so
 * never opens a message with one. */
export function radioMarkerAgent(agentLabel?: string): boolean {
  return agentLabel !== undefined && RADIO_AGENT.test(agentLabel);
}
/** Two or more spaces — what both CLIs put between a row's label and its
 * note. A single space is inside the label. */
const COLUMN_SPLIT = /\s{2,}/u;
/** A second column that opens with a frame edge is not the row's note: it is
 * a panel drawn beside the list — Claude Code puts a question's previews
 * there, one panel for the highlighted row, so its rows are the panel's and
 * belong to no option:
 *
 *   ❯ 1. Restore it too               ┌──────────────────────────────┐
 *     2. Just the question            │ swipe → on the reading view  │
 *
 * A note is text, so a column that starts with a frame is dropped whole
 * rather than read as one. */
const PANEL_COLUMN = /^[│┃┆┇┊┋┌┏╭╔└┗╰╚├┣┤┫─━═]/u;
/** Room for Claude Code's longest permission row once its wrap is rejoined
 * (`Yes, and switch to accept edits (auto-approve file edits and common file
 * commands) for this session (shift+tab)`). */
const MAX_LABEL = 160;
const MAX_DESCRIPTION = 200;
/** Non-blank rows a heading may occupy above the list: the heading itself and
 * the blurb both CLIs print under it. A longer block above the rows is
 * ordinary output, and the dialog then goes untitled rather than titled with
 * somebody's sentence. */
const HEADING_BLOCK = 3;
const MAX_TITLE = 60;

interface ReadRow {
  marked: boolean;
  /** The row carries a windowed dialog's `↑`/`↓`. */
  edge: boolean;
  option: Omit<SelectOption, "index">;
  /** Screen column the label starts at. */
  labelColumn: number;
  /** Screen column the row's note starts at: beside the label when the row
   * carries it in a second column, else the label's own column, under which
   * the note is printed on rows of its own. */
  descriptionColumn: number;
}

/** At phone width both CLIs wrap a row's note onto the lines below it, each
 * indented to the note's own column:
 *
 *     1. gpt-5.6-sol (default)  Latest frontier
 *                               agentic coding model.
 *
 * A label too long for its column wraps the same way, indented to the label's
 * column, beside the note's own wrapped lines (Codex's question dialog):
 *
 *   › 1. Job: running/completed/failed/  Keep async job statuses
 *        expired (Recommended)           for progress tracking.
 *
 * And some dialogs never put the note beside the label at all: Claude Code's
 * question dialog (AskUserQuestion, its `compact-vertical` layout), Gemini
 * CLI's and a Codex list too narrow for two columns print it on the rows under
 * it, at or past the label's column —
 *
 *     ❯ 1. Red
 *          Warm and loud
 *       2. Green
 *
 * — so for a row without a second column the note's column is the label's.
 * A line that is not a row and starts at or past the label's column continues
 * the row above: what sits left of the note's column is more label, the rest
 * more note. Anything shallower is ordinary text and ends the run.
 *
 * Except where the label itself ran out of room: Claude Code's permission
 * dialog wraps a long row at the pane's edge onto the label's column too —
 *
 *       2. Yes, and switch to accept edits (auto-approve file
 *          edits and common file commands) for this session
 *
 * — the same shape as a note under its label. What tells them apart is the
 * width: a note starts a line of its own, a wrap is a word that did not fit
 * on the line above (`wrapsLabel`). */
function readContinuation(
  text: string,
  labelColumn: number,
  descriptionColumn: number,
  labelWrap = false,
): { label: string; description: string } | null {
  const indent = text.length - text.trimStart().length;
  if (indent < labelColumn) return null;
  if (labelWrap) return { label: text.trim(), description: "" };
  if (descriptionColumn <= labelColumn || indent >= descriptionColumn) return { label: "", description: text.trim() };
  return { label: text.slice(0, descriptionColumn).trim(), description: text.slice(descriptionColumn).trim() };
}

/** Whether `next` continues the label on `above` rather than starting the
 * row's note under it: its first word would not have fit on `above` in a pane
 * `columns` wide. Unknown width reads every such line as a note, as before. */
function wrapsLabel(above: string, next: string, columns?: number): boolean {
  if (!columns) return false;
  const word = next.trim().split(/\s/u)[0];
  return above.trimEnd().length + 1 + word.length > columns;
}

/** Where the dialog's own text ends going up. A `/model` opened mid-turn is
 * drawn right under Claude Code's spinner (`✻ Wiggling… (12s · ↓ 2k tokens)`)
 * with no blank between them: read as text, the spinner became the heading —
 * a new one every tick, so every repaint looked like a new step. */
function dialogText(line: SelectLineLike): boolean {
  return !!line.text.trim() && !busyRow(line.text);
}

/** The dialog's heading, read upwards from its first row: past the blank the
 * TUI leaves under the heading, then the contiguous block above it, of which
 * the first line is the heading and the rest its blurb. A dropped rule ends
 * the block like a blank: Claude Code 2.1.286 fences a permission prompt's
 * command in dashed rules (`╌╌╌`) with no blank before its question, and
 * without the stop the command and its description ran into the heading and
 * left the dialog untitled. */
function readTitle(lines: readonly SelectLineLike[], start: number): string | undefined {
  let index = start - 1;
  while (index >= 0 && !lines[index].text.trim()) index -= 1;
  const block: string[] = [];
  while (index >= 0 && dialogText(lines[index])) {
    block.unshift(lines[index].text.trim());
    if (block.length > HEADING_BLOCK) return undefined;
    if (lines[index].afterRule) break;
    index -= 1;
  }
  const title = block[0];
  if (!title || title.length > MAX_TITLE) return undefined;
  // A numbered row above the run belongs to some other list, not to a heading.
  if (RADIO_OPTION.test(title)) return undefined;
  return /\p{L}/u.test(title) ? title : undefined;
}

/** Blank-separated blocks above the rows that are the dialog's, rather than the
 * session's: the question itself, and the one block before it — in Claude
 * Code's permission dialog what is being approved (the file, the diff), in
 * Codex's the line that says why it is asking. */
const CONTEXT_BLOCKS = 2;
/** …and no more lines than a phone shows without pushing the rows off screen.
 * Unbounded, a session that has not been prompted yet put its whole startup
 * banner — version, model, directory, tips, warnings — above its first
 * question, and a mid-turn one repeated the answer the reader already has. */
const CONTEXT_LINES = 10;
/** …except the permission dialog's own block, which is what the rows approve.
 * Claude Code 2.1.287 draws it as one block — the tool (`Bash command`), the
 * description, the command fenced in dashed rules, why it asks, the auto-deny
 * countdown — and a long command ran it past `CONTEXT_LINES`: the phone showed
 * the command's last lines under no heading, its start cut off. */
const DIALOG_LINES = 40;

/** Where the dialog's own text starts, read upwards from its first row: the
 * question is the contiguous block directly above the rows, the context that
 * block and `CONTEXT_BLOCKS - 1` more, bounded by `CONTEXT_LINES` — or, for a
 * block ruled inside (`DIALOG_LINES`), by that. Both are `start` when nothing
 * but blanks sits above the rows. */
function readContext(lines: readonly SelectLineLike[], start: number): { question: number; context: number } {
  let index = start - 1;
  let context = start;
  let question = start;
  let taken = 0;
  for (let block = 0; block < CONTEXT_BLOCKS && taken < CONTEXT_LINES; block += 1) {
    while (index >= 0 && !lines[index].text.trim()) index -= 1;
    // The spinner is the session's, not the dialog's: nothing above it is.
    if (index >= 0 && busyRow(lines[index].text)) break;
    const top = index;
    if (block === 0) {
      while (index >= 0 && dialogText(lines[index]) && taken < CONTEXT_LINES) {
        context = index;
        taken += 1;
        index -= 1;
        // The question ends at a dropped rule, as its heading does
        // (`readTitle`): Claude Code 2.1.286 rules the diff of a file it asks
        // to write off from its question with no blank between, and read
        // through the rule, the diff's last lines became the question —
        // rejoined into prose.
        if (lines[index + 1].afterRule) break;
      }
      question = context;
      continue;
    }
    if (top < 0) break;
    let first = index;
    while (first > 0 && dialogText(lines[first - 1]) && top - first + 1 < DIALOG_LINES) first -= 1;
    // A rule inside the block is the dialog's own fence; one only over its top
    // line is just where the block began.
    let ruled = false;
    for (let line = first + 1; line <= top; line += 1) if (lines[line].afterRule) ruled = true;
    const room = ruled ? DIALOG_LINES : CONTEXT_LINES - taken;
    const from = Math.max(first, top - room + 1);
    if (from <= top) {
      context = from;
      taken += top - from + 1;
    }
    index = from - 1;
    // Claude Code's tab row over an agent's question is the question's label,
    // not a block of context: what it labels is the agent's message above.
    if (from === top && readQuestionTabs(lines[top].text)) block -= 1;
  }
  return { question, context };
}

function readRow(text: string, option: RegExp): ReadRow | null {
  const match = option.exec(text);
  if (!match) return null;
  const [, marker, digits, rest] = match;
  const columns = rest.split(COLUMN_SPLIT);
  const label = columns[0].trim();
  if (!label) return null;
  const beside = columns.slice(1).join(" · ").trim();
  const description = PANEL_COLUMN.test(beside) ? "" : beside;
  const split = description ? COLUMN_SPLIT.exec(rest) : null;
  return {
    marked: marker !== undefined && !EDGE.test(marker),
    edge: marker !== undefined && EDGE.test(marker),
    option: {
      number: Number(digits),
      label: label.slice(0, MAX_LABEL),
      description: description ? description.slice(0, MAX_DESCRIPTION) : undefined,
    },
    labelColumn: text.length - rest.length,
    descriptionColumn: text.length - rest.length + (split ? split.index + split[0].length : 0),
  };
}

/**
 * The select dialog the session is showing right now, or `null` when the bottom
 * of the screen does not hold one in the recognized shape. `agentLabel` is the
 * tab's agent, which says whether `●` marks a row (`radioMarkerAgent`);
 * `columns` the pane's width, which tells a row's wrapped label from its note.
 */
export function readSelectPrompt(
  lines: readonly SelectLineLike[],
  agentLabel?: string,
  columns?: number,
): SelectPrompt | null {
  const option = radioMarkerAgent(agentLabel) ? RADIO_OPTION : OPTION;
  const first = Math.max(0, lines.length - SEARCH_WINDOW);
  type Run = {
    start: number;
    options: SelectOption[];
    marked: number[];
    labelColumn: number;
    column: number;
    edge: boolean;
    /** The `… +N` note right under the run, if any. */
    hidden?: number;
  };
  const runs: Run[] = [];
  let run: Run | undefined;

  for (let index = first; index < lines.length; index += 1) {
    const text = lines[index].text;
    // A run is contiguous. A blank row or any other text ends it, so a numbered
    // list elsewhere on screen can never be glued onto the dialog's own rows.
    if (!text.trim()) {
      run = undefined;
      continue;
    }
    const tail = run?.options[run.options.length - 1];
    const action = tail && CHECKBOX_LABEL.test(tail.label) ? ACTION_ROW.exec(text) : null;
    if (run && action) {
      if (action[1]) run.marked.push(run.options.length);
      run.options.push({ index: run.options.length, number: UNNUMBERED, label: action[2] });
      continue;
    }
    const row = readRow(text, option);
    const hidden = row ? null : HIDDEN_ROWS.exec(text);
    if (run && hidden) {
      run.hidden = Number(hidden[1]);
      run = undefined;
      continue;
    }
    if (!row) {
      const last = run?.options[run.options.length - 1];
      const labelWrap = last !== undefined && !last.description && wrapsLabel(lines[index - 1].text, text, columns);
      const more = run ? readContinuation(text, run.labelColumn, run.column, labelWrap) : null;
      if (more && last) {
        if (more.label && !PANEL_COLUMN.test(more.label)) last.label = `${last.label} ${more.label}`.slice(0, MAX_LABEL);
        if (more.description && !PANEL_COLUMN.test(more.description)) {
          last.description = (last.description ? `${last.description} ${more.description}` : more.description)
            .slice(0, MAX_DESCRIPTION);
        }
        continue;
      }
      run = undefined;
      continue;
    }
    // Counted on from the last row that printed a number: `Submit` prints none.
    const numbered = run ? [...run.options].reverse().find((entry) => entry.number !== UNNUMBERED) : undefined;
    const continues = run !== undefined
      && numbered !== undefined
      && run.options.length < MAX_OPTIONS
      && row.option.number === numbered.number + 1;
    if (!continues || !run) {
      // A run starts at 1 — or wherever a windowed dialog's slice starts,
      // which the final check holds to the window's own marks.
      run = { start: index, options: [], marked: [], labelColumn: row.labelColumn, column: row.descriptionColumn, edge: false };
      runs.push(run);
    }
    if (row.marked) run.marked.push(run.options.length);
    if (row.edge) run.edge = true;
    run.options.push({ index: run.options.length, ...row.option });
    run.labelColumn = row.labelColumn;
    run.column = row.descriptionColumn;
  }

  // The live dialog is the lowest one on screen; an earlier, scrolled-past
  // picker in the same session must not win.
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const candidate = runs[index];
    const windowed = candidate.hidden !== undefined || candidate.edge;
    const title = readTitle(lines, candidate.start);
    // Codex may clip the top of its model picker without a hidden-row note or
    // edge marker. Its heading and the caller's agent identify that slice.
    const codexModelSlice = /codex/iu.test(agentLabel ?? "") && title?.startsWith("Select Model") === true;
    if (candidate.options[0].number !== 1 && !windowed && !codexModelSlice) continue;
    if (candidate.options.length >= MIN_OPTIONS && candidate.marked.length === 1) {
      return {
        options: candidate.options,
        current: candidate.marked[0],
        title,
        start: candidate.start,
        ...readContext(lines, candidate.start),
        ...(candidate.hidden ? { hidden: candidate.hidden } : {}),
      };
    }
  }
  return null;
}

/** What the list on screen *is*, as opposed to where its highlight sits: the
 * heading and the rows. A caller that answered a dialog compares this to tell
 * the list it answered — still painted while the TUI catches up — from the
 * next step of a multi-step one, drawn in the same place. */
export function selectSignature(prompt: SelectPrompt): string {
  return [prompt.title ?? "", ...prompt.options.map((option) => `${option.number}. ${option.label}`)].join("\n");
}

/** Whether the list on screen is a slice of `step` — the same heading, and
 * every row they both hold carries the same label — rather than the next step
 * of a multi-step dialog drawn in the same place. */
export function sameSelectStep(step: SelectStep, prompt: SelectPrompt): boolean {
  if ((step.title ?? "") !== (prompt.title ?? "")) return false;
  const known = new Map(step.options.map((option) => [option.number, option.label]));
  let shared = 0;
  for (const option of prompt.options) {
    const label = known.get(option.number);
    if (label === undefined) continue;
    if (label !== option.label) return false;
    shared += 1;
  }
  return shared > 0;
}

/** `step` with the rows `prompt` adds — or, when the list on screen is not a
 * slice of it (`sameSelectStep`), the step `prompt` starts. Returns `step`
 * itself when the screen shows nothing it did not hold, so a caller keeping it
 * in state does not re-render on every repaint. */
export function mergeSelectRows(step: SelectStep | null, prompt: SelectPrompt): SelectStep {
  if (!step || !sameSelectStep(step, prompt)) {
    return { title: prompt.title, options: prompt.options.map((option, index) => ({ ...option, index })) };
  }
  const rows = new Map(step.options.map((option) => [option.number, option]));
  let added = false;
  for (const option of prompt.options) {
    if (rows.has(option.number)) continue;
    rows.set(option.number, option);
    added = true;
  }
  if (!added) return step;
  const options = [...rows.values()]
    .sort((a, b) => a.number - b.number)
    .map((option, index) => ({ ...option, index }));
  return { title: step.title, options };
}

/** The first row a windowed dialog has that `step` has not seen, by its
 * printed number — where to walk the highlight next to make the dialog draw
 * it — or `undefined` once every row is known. */
export function missingSelectRow(step: SelectStep, prompt: SelectPrompt): number | undefined {
  const seen = new Set(step.options.map((option) => option.number));
  // A clipped first row already tells us its printed number, even when the
  // picker gives no count of hidden rows. Walk up to collect it for the sheet.
  for (let number = 1; number < prompt.options[0].number; number += 1) {
    if (!seen.has(number)) return number;
  }
  if (!prompt.hidden) return undefined;
  const total = prompt.options.length + prompt.hidden;
  for (let number = 1; number <= total; number += 1) if (!seen.has(number)) return number;
  return undefined;
}

/** Where to walk the highlight to reveal what `step` has not seen, half a
 * window at a time rather than one row per round trip — Cursor draws
 * thirty-nine models in a ten-row window, and a row-by-row reveal held the
 * sheet for most of a minute.
 *
 * Half, not whole: the frame the walk lands on must still show a row the step
 * already holds, whether the window scrolls just far enough to keep the
 * highlight in view or centres it. A frame sharing no row with the step is
 * read as the next step of a multi-step dialog (`sameSelectStep`), and what
 * was revealed so far would be thrown away. */
export function revealSelectRow(step: SelectStep, prompt: SelectPrompt): number | undefined {
  const missing = missingSelectRow(step, prompt);
  if (missing === undefined) return undefined;
  const size = prompt.options.length;
  const first = prompt.options[0].number;
  if (missing < first) return Math.max(missing, first + 1 - Math.ceil(size / 2));
  const total = size + (prompt.hidden ?? 0);
  return Math.min(total, Math.max(missing, missing - 1 + Math.floor(size / 2)));
}

/** The keystrokes that move a dialog's highlight from `current` to `target` and
 * accept it — the same keys the on-screen arrow row sends, so a tapped row is
 * answered exactly as a walked one. */
export function selectKeys(current: number, target: number): string[] {
  return [...selectMoveKeys(current, target), "\r"];
}

/** Claude Code's free-text row under an agent's question (AskUserQuestion,
 * 2.1.287): `4. Type something.`, or `4. [ ] Type something` on a multi-select
 * one. It is a text field, not a choice — Enter on it while empty answers
 * nothing — so a phone tapping it has to be asked for the words. Once typed,
 * the row prints them in place of this placeholder. */
const FREE_TEXT = /^(?:\[[^\]]\]\s+)?Type something\.?$/u;

/** Whether `option` is the question's free-text row (`FREE_TEXT`). */
export function freeTextRow(option: SelectOption): boolean {
  return FREE_TEXT.test(option.label);
}

/** The writes that answer a question's free-text row with `text`: walk the
 * highlight onto it — which focuses its field — type the words as one line,
 * and accept. Not on a multi-select question: typing there ticks the row's box
 * by itself and Enter would untick it, so its Submit row still sends it. */
export function freeTextWrites(current: number, option: SelectOption, text: string): string[] {
  const line = text.replace(/\s+/gu, " ").trim();
  if (!line) return [];
  const writes = [...selectMoveKeys(current, option.index), line];
  return CHECKBOX_LABEL.test(option.label) ? writes : [...writes, "\r"];
}

/** The arrow keys alone: the highlight moves, nothing is accepted. */
export function selectMoveKeys(current: number, target: number): string[] {
  const distance = Math.abs(target - current);
  const key = target > current ? "\u001b[B" : "\u001b[A";
  return Array.from({ length: distance }, () => key);
}

/** One question of Claude Code's question dialog, as its tab row names it. */
export interface QuestionTab {
  label: string;
  answered: boolean;
}

const TAB_ROW = /^\s*(?:←\s+)?((?:[☐☒☑✔✓]\s+\S.*?)(?:\s{2,}[☐☒☑✔✓]\s+\S.*?)*)(?:\s+→)?\s*$/u;
const TAB = /^([☐☒☑✔✓])\s+(\S.*)$/u;

/** The tab row Claude Code draws over the question an agent asks
 * (`AskUserQuestion`): each question's short header behind a box —
 * `☐ Push scope`, or `← ☒ Scope  ☐ Tag  ✔ Submit →` when it asks several —
 * which lands at the bottom of the screen above the question as a bare row of
 * checkboxes. It is the question's label, so a caller shows it as one; the
 * `Submit` step is navigation, not a question, and is left out.
 *
 * At least one `☐`/`☒` has to be there: a lone `✔ Done` line is somebody's
 * sentence, not this row. */
export function readQuestionTabs(text: string): QuestionTab[] | null {
  const row = TAB_ROW.exec(text);
  if (!row || !/[☐☒]/u.test(row[1])) return readGeminiTabs(text);
  const tabs: QuestionTab[] = [];
  for (const part of row[1].split(/\s{2,}/u)) {
    const tab = TAB.exec(part);
    if (!tab) return null;
    if (tab[2] === "Submit" && (tab[1] === "✔" || tab[1] === "✓")) continue;
    tabs.push({ label: tab[2], answered: tab[1] !== "☐" });
  }
  return tabs.length > 0 ? tabs : null;
}

const GEMINI_TAB_ROW = /^\s*(?:←\s+)?([□✓≡]\s+\S.*?(?:\s+│\s+[□✓≡]\s+\S.*?)+)(?:\s+→)?\s*$/u;
const GEMINI_TAB = /^([□✓≡])\s+(\S.*)$/u;

/** Gemini CLI's tab row over an `ask_user` dialog that asks several — and
 * Qwen Code's, forked from it (`TabHeader`, gemini-cli main):
 * `← □ Scope │ ✓ Tag │ ≡ Review →`, each header behind its status, the
 * current one underlined. It asks one question with no row at all, so the
 * `≡ Review` step is always there and is what tells the row from a sentence;
 * like Claude Code's Submit it is navigation and is left out. */
function readGeminiTabs(text: string): QuestionTab[] | null {
  const row = GEMINI_TAB_ROW.exec(text);
  if (!row) return null;
  const tabs: QuestionTab[] = [];
  let review = false;
  for (const part of row[1].split(/\s+│\s+/u)) {
    const tab = GEMINI_TAB.exec(part);
    if (!tab) return null;
    if (tab[1] === "≡") {
      review = true;
      continue;
    }
    tabs.push({ label: tab[2], answered: tab[1] === "✓" });
  }
  return review && tabs.length > 0 ? tabs : null;
}

/** Whether the tab row ends in a step that sends the answers — Claude Code's
 * `✔ Submit`, Gemini CLI's `≡ Review` — the page a several-question dialog
 * is submitted from. */
export function questionTabsSubmit(text: string): boolean {
  return /(?:^|\s)[✔✓]\s+Submit(?:\s|$)/u.test(text) || (GEMINI_TAB_ROW.test(text) && /(?:^|\s)≡\s+\S/u.test(text));
}

/** How the dialog whose tab row is `text` is walked: Gemini CLI's with Tab
 * and Shift+Tab — its ←/→ do it only while the options have the focus, not
 * on its Review page — Claude Code's with ←/→. */
export function questionTabRowKeys(text: string): QuestionStepKeys {
  return GEMINI_TAB_ROW.test(text) ? "tabs" : "arrows";
}

const TAB_GLYPH = /^(?:[☐☒☑✔✓□≡]\s+)?(?:answered\s+)?/u;

/**
 * Which step of the tab row the dialog is on, read off `spans` (the row as
 * drawn): Claude Code paints the current step's chip — on a background, or in
 * its own colour where every other chip keeps the plain one — and Gemini CLI
 * underlines it. An index into `tabs`, or `tabs.length` for the Submit/Review
 * step; null when no single chip is marked so — then only ←/→ can move.
 */
export function questionTabFocus(spans: readonly ReadableSpanLike[], tabs: readonly QuestionTab[]): number | null {
  const paintedBy = (painted: (span: ReadableSpanLike) => boolean): number[] => {
    const runs: string[] = [];
    let run: string | null = null;
    for (const span of spans) {
      if (painted(span)) {
        run = (run ?? "") + span.text;
      } else if (run !== null) {
        runs.push(run);
        run = null;
      }
    }
    if (run !== null) runs.push(run);
    // A run that names no step (the dimmed ← or → at an end) says nothing.
    return runs
      .map((text) => text.trim().replace(TAB_GLYPH, ""))
      .map((text) => {
        const step = tabs.findIndex((tab) => tab.label === text);
        return step < 0 && (text === "Submit" || text === "Review") ? tabs.length : step;
      })
      .filter((step) => step >= 0);
  };
  const byBackground = paintedBy((span) => !!span.background);
  if (byBackground.length > 0) return byBackground.length === 1 ? byBackground[0] : null;
  const byUnderline = paintedBy((span) => /(?:^|\s)u(?:\s|$)/u.test(span.className ?? ""));
  if (byUnderline.length > 0) return byUnderline.length === 1 ? byUnderline[0] : null;
  const byColor = paintedBy((span) => !!span.color);
  return byColor.length === 1 ? byColor[0] : null;
}

/** A span of a read row (`ReadableSpan`), as far as the tab row needs it. */
interface ReadableSpanLike { text: string; className?: string; color?: string; background?: string }

/** How a several-question dialog is walked: Claude Code's tab row with ←/→
 * (`tabs:next`/`tabs:previous`); Codex's `request_user_input` with
 * PageDown/PageUp, which — unlike its ←/→ — also work while a question's
 * notes field has the focus; Gemini CLI's with Tab/Shift+Tab, the keys it
 * switches questions with on every page, its Review page too. */
export type QuestionStepKeys = "arrows" | "pages" | "tabs";

/** The keys that walk a several-question dialog from step `from` to step
 * `to`. Either CLI keeps the answers already given; the step walked onto
 * shows its own highlighted. */
export function questionTabKeys(from: number, to: number, keys: QuestionStepKeys = "arrows"): string[] {
  const key = keys === "pages" ? (to > from ? "\u001b[6~" : "\u001b[5~")
    : keys === "tabs" ? (to > from ? "\t" : "\u001b[Z")
    : (to > from ? "\u001b[C" : "\u001b[D");
  return Array.from({ length: Math.abs(to - from) }, () => key);
}

const CODEX_PROGRESS = /^Question (\d+)\/(\d+)(?:\s|$)/u;

/** Codex's `request_user_input` heading — `Question 2/3 (1 unanswered)` —
 * as the step on screen (0-based) and how many questions it asks. It draws
 * no tab row: this is all it says about the others. */
export function codexQuestionProgress(title: string | undefined): { focus: number; count: number } | null {
  const match = title ? CODEX_PROGRESS.exec(title.trim()) : null;
  if (!match) return null;
  const focus = Number(match[1]) - 1;
  const count = Number(match[2]);
  return focus >= 0 && focus < count ? { focus, count } : null;
}

const GEMINI_REVIEW = /^\s*Review your answers:\s*$/u;

/**
 * Gemini CLI's Review page (`ReviewView`): the last step of an `ask_user`
 * dialog that asks several, under its tab row — `Review your answers:`, a
 * warning when some are open, one `Header → answer` row per question — and no
 * rows to pick, Enter sends them all. `readSelectPrompt` finds nothing to
 * answer there, so a reader's card would vanish just when an answer may still
 * want changing. This reads it as a dialog of one row, `Submit` (Enter), with
 * the tab row above it, so the card stays and can walk back. Gemini and Qwen
 * tabs only, like the radio dot.
 */
export function readReviewStep(lines: readonly SelectLineLike[], agentLabel?: string): SelectPrompt | null {
  if (!RADIO_AGENT.test(agentLabel ?? "")) return null;
  let heading = -1;
  for (let index = lines.length - 1; index >= 0 && lines.length - index <= DIALOG_LINES; index -= 1) {
    if (GEMINI_REVIEW.test(lines[index].text)) {
      heading = index;
      break;
    }
  }
  if (heading < 0) return null;
  let row = heading - 1;
  while (row >= 0 && lines[row].text.trim() === "") row -= 1;
  if (row < 0 || !readGeminiTabs(lines[row].text)) return null;
  let end = heading + 1;
  while (end < lines.length && !/^\s*Enter to submit\b/u.test(lines[end].text)) end += 1;
  return {
    options: [{ index: 0, number: 1, label: "Submit" }],
    current: 0,
    title: lines[heading].text.trim(),
    start: end,
    question: row,
    context: row,
    review: true,
  };
}
