/**
 * Google Antigravity's own screens (`agy` 1.2.7, drawn the same through
 * 1.4.5), for a tab whose label names it: the model and reasoning effort its
 * footer prints, and the `Switch Model` dialog `/model` opens.
 *
 * Neither is the shape the other readers know. This is what the CLI draws,
 * captured from a live session:
 *
 *   >                                      ← the input box, above the dialog
 *   Switch Model
 *
 *     Search:
 *
 *     Gemini 3.8 Flash
 *   > Gemini 3.6 Flash             (current)
 *     Claude Sonnet 4.6 (Thinking)
 *
 *     Effort  ◂        ●━━━━━━━━━━━━━━◉──────────────○        ▸
 *                     low          medium          high
 *               Balanced speed and reasoning quality for most tasks
 *     [1-6 of 7 items]
 *
 *   Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back
 *   ? for shortcuts                           Gemini 3.6 Flash · medium
 *
 * Three things follow from it, and all three are why the model chip read
 * "Gemini" and `/model` opened an empty sheet:
 *
 *   - The rows carry no numbers, and the dialog marks its highlight with the
 *     same `>` the input box draws — so `selectPrompt` recognized nothing, and
 *     what it *would* have recognized as an input line is a model row. The
 *     dialog is found by its heading instead, and its rows are numbered here,
 *     by their place in the dialog's own list (`[1-6 of 7 items]`).
 *   - Model and effort are one dialog, not two steps: the slider belongs to the
 *     row the highlight is on and Enter applies both at once. It is drawn only
 *     for the highlighted model, and models differ in what they offer (Gemini
 *     3.1 Pro has low and high, a Claude model has no slider at all), so the
 *     stops can only be read once the highlight has arrived. That is what makes
 *     the phone's two-step sheet the honest shape: tap the model, let the
 *     dialog redraw, tap the effort it then offers.
 *   - The footer prints model and effort as one right-aligned column, where
 *     `statusLine`'s model *tokens* matched "Gemini" and dropped the rest.
 *
 * Everything here is read off the screen. What is pressed is the caller's.
 */

import type { SelectPrompt } from "./selectPrompt";

interface AntigravityLineLike { text: string }

/** The registry's label for the CLI is "Google Antigravity"; a tab renamed by
 * the reader still carries it (`agent_label`). */
const AGENT = /antigravity/iu;

export function isAntigravityTab(agentLabel?: string): boolean {
  return agentLabel !== undefined && AGENT.test(agentLabel);
}

/** How far up from the bottom the dialog's heading may sit: seven rows of
 * models, the slider block, and the footer under them. */
const SEARCH_WINDOW = 40;
const HEADING = /^\s{0,4}Switch Model$/u;
/** The dialog's search field, empty or holding a query. It sits between the
 * heading and the rows and is what tells this dialog from a heading somebody
 * printed. */
const SEARCH_FIELD = /^\s{0,4}Search:/u;
/** A row of the list: the highlight marker and a space, or the two spaces
 * every other row is indented by. */
const ROW = /^(> | {2})(\S.*)$/u;
/** The note the dialog prints beside the model the session is on. Its column
 * is fixed, so a long label leaves a single space before it — which is why
 * this is stripped by name rather than split off as a second column. */
const CURRENT = /\s+\(current\)$/u;
/** The window a list too long for the pane is drawn in: `[1-6 of 7 items]`. */
const WINDOW_RANGE = /^\[(\d{1,3})\s*[-–]\s*(\d{1,3})\s+of\s+(\d{1,3})\s+items?\]$/u;
/** Rows read out of one dialog; the cap only bounds a misread. */
const MAX_ROWS = 24;
const MAX_LABEL = 80;
/** The input line the dialog is drawn under. */
const INPUT = /^\s*>(\s|$)/u;
/** Non-blank rows looked through for it above the heading. */
const INPUT_REACH = 2;
/** Non-blank rows looked through under the list for its window note. */
const BELOW_REACH = 8;

export interface AntigravityPicker extends SelectPrompt {
  /** Index of the input line the dialog is drawn under. Antigravity puts the
   * picker *below* its input box, so the frame the reading view cuts starts
   * there and not at the heading. */
  frameStart: number;
}

function skipBlank(lines: readonly AntigravityLineLike[], from: number): number {
  let index = from;
  while (index < lines.length && !lines[index].text.trim()) index += 1;
  return index;
}

/** The lowest `Switch Model` heading on screen, or -1. The lowest, because a
 * dialog the session has scrolled past is not the one it is showing. */
function headingIndex(lines: readonly AntigravityLineLike[]): number {
  const first = Math.max(0, lines.length - SEARCH_WINDOW);
  for (let index = lines.length - 1; index >= first; index -= 1) {
    if (HEADING.test(lines[index].text.trim())) return index;
  }
  return -1;
}

/**
 * The `Switch Model` dialog the session is showing right now, as the rows the
 * phone lists, or `null` when the screen holds none in the recognized shape.
 *
 * The rows are numbered by their place in the dialog's whole list, which the
 * window note gives (`[1-6 of 7 items]` → these rows are 1 to 6, and one more
 * exists). That is what lets the caller walk the highlight by a difference of
 * printed numbers, exactly as it does for a windowed Claude Code picker.
 */
export function readAntigravityPicker(lines: readonly AntigravityLineLike[]): AntigravityPicker | null {
  const heading = headingIndex(lines);
  if (heading < 0) return null;
  let index = skipBlank(lines, heading + 1);
  if (index >= lines.length || !SEARCH_FIELD.test(lines[index].text)) return null;
  index = skipBlank(lines, index + 1);

  const start = index;
  const rows: { label: string; current: boolean; marked: boolean }[] = [];
  for (; index < lines.length && rows.length < MAX_ROWS; index += 1) {
    const match = ROW.exec(lines[index].text.replace(/\s+$/u, ""));
    if (!match) break;
    const [, marker, rest] = match;
    const label = rest.replace(CURRENT, "").trim();
    if (!label) break;
    rows.push({ label: label.slice(0, MAX_LABEL), current: CURRENT.test(rest), marked: marker === "> " });
  }
  // One highlight, always: a list drawn without one is a frame caught
  // mid-repaint, and walking from a highlight this cannot see is a guess.
  if (rows.length < 2 || rows.filter((row) => row.marked).length !== 1) return null;

  let first = 1;
  let total = rows.length;
  for (let below = index, seen = 0; below < lines.length && seen < BELOW_REACH; below += 1) {
    const text = lines[below].text.trim();
    if (!text) continue;
    seen += 1;
    const range = WINDOW_RANGE.exec(text);
    if (!range) continue;
    const [from, to, count] = range.slice(1).map(Number);
    // The note belongs to this list only if it counts these very rows.
    if (to - from + 1 === rows.length && count >= rows.length) {
      first = from;
      total = count;
    }
    break;
  }

  let frameStart = heading;
  for (let above = heading - 1, seen = 0; above >= 0 && seen < INPUT_REACH; above -= 1) {
    const text = lines[above].text;
    if (!text.trim()) continue;
    seen += 1;
    if (INPUT.test(text)) {
      frameStart = above;
      break;
    }
    break;
  }

  return {
    options: rows.map((row, at) => ({
      index: at,
      number: first + at,
      label: row.label,
      ...(row.current ? { description: "(current)" } : {}),
    })),
    current: rows.findIndex((row) => row.marked),
    title: lines[heading].text.trim(),
    start,
    // The heading *is* the dialog's question, and what sits above it is the
    // session's own screen: the sheet shows the rows and the heading, never
    // the lines around them.
    question: heading,
    context: heading,
    ...(total > rows.length ? { hidden: total - rows.length } : {}),
    frameStart,
  };
}

export interface AntigravityEffortStop {
  label: string;
  /** The dialog prints one line about the stop it is on, and none about the
   * others. */
  description?: string;
}

export interface AntigravityEffort {
  /** The slider's stops, in the order it draws them (low → high). */
  stops: AntigravityEffortStop[];
  /** Index of the stop the slider sits on. */
  current: number;
}

/** The slider row: `Effort  ◂  ●━━━◉───○  ▸`. */
const EFFORT_ROW = /^\s{0,4}Effort\b/u;
/** Its stops — `●` behind the handle, `◉` the handle, `○` ahead of it. */
const EFFORT_STOPS = /[●◉○]/gu;
const HANDLE = "◉";

function nextNonBlank(lines: readonly AntigravityLineLike[], from: number): number {
  const index = skipBlank(lines, from + 1);
  return index < lines.length ? index : -1;
}

/**
 * The effort slider under the dialog's rows — the stops it offers for the
 * model the highlight is on, and the one it sits on — or `null` when the
 * dialog draws none, which is how a model with a single effort says so.
 *
 * The stops are counted from the slider's own glyphs and named from the row of
 * labels under it; a slider whose labels do not line up with its stops is not
 * read at all, rather than answered with a guess about which is which.
 */
export function readAntigravityEffort(lines: readonly AntigravityLineLike[]): AntigravityEffort | null {
  const first = Math.max(0, lines.length - SEARCH_WINDOW);
  for (let index = lines.length - 1; index >= first; index -= 1) {
    const text = lines[index].text;
    if (!EFFORT_ROW.test(text)) continue;
    const marks = text.match(EFFORT_STOPS);
    if (!marks || marks.length < 2) return null;
    const current = marks.indexOf(HANDLE);
    if (current < 0 || marks.lastIndexOf(HANDLE) !== current) return null;
    const labelled = nextNonBlank(lines, index);
    if (labelled < 0) return null;
    const stops = lines[labelled].text.trim().split(/\s{2,}/u).map((label) => label.trim()).filter(Boolean);
    if (stops.length !== marks.length) return null;
    const noted = nextNonBlank(lines, labelled);
    const note = noted < 0 ? "" : lines[noted].text.trim();
    const about = note && !WINDOW_RANGE.test(note) && /\p{L}/u.test(note) ? note : undefined;
    return {
      stops: stops.map((label, at) => ({ label, ...(at === current && about ? { description: about } : {}) })),
      current,
    };
  }
  return null;
}

/** The keys that move the slider from `current` to `target`. Nothing is
 * accepted: the dialog applies the model and the effort together, on Enter. */
export function antigravityEffortKeys(current: number, target: number): string[] {
  const key = target > current ? "\u001b[C" : "\u001b[D";
  return Array.from({ length: Math.abs(target - current) }, () => key);
}

/** The right-hand column of the row Antigravity keeps under its input box:
 * `? for shortcuts` on the left, the session's model on the right, with its
 * effort after a `·` where the model has one. A footer is right-aligned, so
 * the column is found by the run of spaces before it — the CLI's own key hints
 * are columned two spaces apart and are not one. */
const FOOTER = /^(?:.*\S)? {4,}(\S.*)$/u;
/** The effort levels `agy --effort` takes. `max` has its own gauge colour
 * since at least 1.2.14 and 1.3 added `xhigh`; a footer naming either is
 * still the session's model, and a gauge label row ending in one is still not
 * a model called "max". */
const EFFORT_WORD = /^(?:low|medium|high|xhigh|max)$/iu;
/** A model as this CLI names one: `Gemini 3.8 Flash`, `Claude Sonnet 4.6
 * (Thinking)`, `GPT-OSS 120B (Medium)`. Deliberately narrow — the same row
 * shape carries the account line of the banner above. */
const MODEL_NAME = /^\p{L}[\p{L}\p{N}.+\- ]*(?:\([\p{L}\p{N} .-]+\))?$/u;
const MAX_MODEL = 48;

/** The model and effort that row names, or `null` for any other row. */
export function antigravityFooter(text: string): { model: string; effort?: string } | null {
  const match = FOOTER.exec(text.replace(/\s+$/u, ""));
  if (!match) return null;
  const columns = match[1].split(/\s+·\s+/u);
  if (columns.length > 2) return null;
  const model = columns[0].trim();
  if (!model || model.length > MAX_MODEL || !MODEL_NAME.test(model)) return null;
  // The slider's own row of labels ends in one of these words with nothing
  // else beside it; an effort without a model is not a footer.
  if (columns.length === 1 && EFFORT_WORD.test(model)) return null;
  const effort = columns.length === 2 ? columns[1].trim() : "";
  if (effort && !EFFORT_WORD.test(effort)) return null;
  return effort ? { model, effort: effort.toLowerCase() } : { model };
}
