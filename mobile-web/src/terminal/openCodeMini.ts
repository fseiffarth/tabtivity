/**
 * What OpenCode draws in its **minimal interface** (`opencode --mini`), which
 * is the one shape of it the phone can read at all.
 *
 * Plain `opencode` is a full-screen (alternate-screen) TUI: it has no
 * scrollback, so its conversation comes from OpenCode's session store, and
 * only its composer — model, agent, the working hint — is read off the live
 * frame (`openCodeComposer`, `openCodeFullFooter`, below).
 * `--mini` writes the conversation into ordinary scrollback and keeps a live
 * area — an input box and one status row — pinned under it. That live area is
 * drawn with absolute cursor moves and no input marker of its own, so none of
 * the shapes the other families are found by is present: there is no `>` box
 * row for `statusLine` to anchor on, and the status row has no mode word on
 * it, only the agent's name in capitals.
 *
 * Everything here was read off a real `opencode --mini` 1.18.31 session
 * (captures at 60, 80 and 100 columns, replayed through the phone's own
 * emulator), not out of the bundle, and it is deliberately scoped to a tab
 * whose label names OpenCode — the same tie-break `agentModes` uses, and the
 * only way a bare ` BUILD` row can be told from a line of output.
 *
 * The shapes, in the order a session prints them:
 *
 *   `█▀▀█  OpenCode` / `█  █  ~/project`   the banner, once, at the top
 *   `› the prompt as it was submitted`      the echo — **hard-wrapped** by
 *                                           OpenCode itself, at the pane
 *                                           width, with no indent on the
 *                                           continuation rows
 *   `→ Read src/App.tsx`                    a tool call: `→` for read/edit/
 *   `✱ Grep "foo" in src`                   list/bash/skill, `✱` for glob and
 *   `◈ Parallel Web Search "…"`             grep, `◈` for a web search, `%`
 *   `% WebFetch https://…`                  for a fetch, `✗` for a refused
 *   `# General Task …`                      tool, `#` for a subagent task —
 *                                           each wrapped the same way
 *   `$ npm test` + its output               the bash tool's own block, which
 *                                           is kept: it is output, not a label
 *   `Thinking: …`                           reasoning, kept like Claude's
 *   the answer                              plain text, wrapped by OpenCode
 *   `▣ Build · Muse Spark 1.3 Free · 6.2s`  the turn footer: agent, model,
 *                                           duration
 *   ` BUILD   223.0K (21%) · ctrl+p cmd`    the live status row, always the
 *                                           last non-blank row on screen
 *
 * Because OpenCode wraps its own rows, a continuation carries no marker and no
 * indent — nothing on the row says it belongs to the row above. What *does*
 * hold is that OpenCode prints a blank row between blocks and none inside one,
 * so a block runs from its marker row to the next blank row. That is the rule
 * `chatTurns` uses to keep a wrapped prompt whole and to drop a wrapped tool
 * call whole, and it is the reason those two rules live here rather than in
 * the indent-based ones the other CLIs share.
 */

import type { ReadableLine, ReadableSpan } from "./readableScreen";
import type { SelectPrompt } from "./selectPrompt";

/** A tab whose label names OpenCode. Renamable by the user, like every other
 * family's — `agentModes` explains why the label is the tie-break. */
const OPENCODE_AGENT = /open\s*code/iu;

export function isOpenCodeTab(agentLabel?: string): boolean {
  return agentLabel !== undefined && OPENCODE_AGENT.test(agentLabel);
}

/** The two rows of the start-up banner that carry text beside their block
 * glyphs (`readableScreen` drops the stroke-only third row itself). */
const BANNER = /^[█▀▄▌▐]+\s/u;

export function isOpenCodeBanner(text: string): boolean {
  return BANNER.test(text);
}

/** The hint OpenCode draws inside its *empty* input box, in three shapes:
 * `Ask anything... "Fix a TODO in the codebase"`, `Ask anything… `, and
 * `Ask anything, / for commands, @ for context...`. The box is the frame, so
 * this is part of it and not a line of the conversation. The start screen's
 * centred box keeps its `┃` in front of it. */
const PLACEHOLDER = /^\s*(?:[│┃]\s+)?Ask anything[.,…]/u;

export function isOpenCodePlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

/** A tool call's first row. The glyph set is OpenCode's own (`→ ✱ ◈ % ✗`),
 * read off a live session and confirmed against the title functions in the
 * 1.18.31 bundle.
 *
 * `#` is only claimed as a subagent task (`# General Task explore the repo`):
 * on its own it is the markdown heading an answer opens a section with, and
 * claiming that would drop the section. `+`/`-`/`~`, which the edit tool uses
 * for `+ Created`/`- Deleted`/`~ Patched`, are not claimed at all — a `- ` row
 * is the bullet of every list an agent ever wrote. `%` is claimed only as
 * `% WebFetch`, since a bare `%` opens plenty of shell output. */
const TOOL_ROW = /^(?:[→✱◈✗]\s|%\s+WebFetch\b|#\s+\S.*\bTask\b)/u;

export function isOpenCodeToolRow(text: string): boolean {
  return TOOL_ROW.test(text);
}

export interface OpenCodeTurnFooter {
  /** The agent the turn ran as, as printed (`Build`, `Plan`, …). */
  agent: string;
  /** The model's display name (`Muse Spark 1.3 Free`), when the row named one. */
  model?: string;
  /** How long the turn took (`6.2s`), when the row named it. */
  duration?: string;
}

/** `▣ Build · Muse Spark 1.3 Free · 6.2s` — the row OpenCode closes a turn
 * with. It is the only place a mini session prints the model's display name,
 * which is why `statusLine` reads the chip out of it. */
const TURN_FOOTER = /^\s*▣\s+(\S.*)$/u;

export function openCodeTurnFooter(text: string): OpenCodeTurnFooter | null {
  const match = TURN_FOOTER.exec(text);
  if (!match) return null;
  const [agent, model, duration] = match[1].split(" · ").map((part) => part.trim());
  if (!agent) return null;
  return { agent, model: model || undefined, duration: duration || undefined };
}

export interface OpenCodeStatus {
  /** The agent the session is in, lower-cased (`build`, `plan`, …) — what
   * `agentModes` calls a mode for every other family. */
  mode: string;
  /** Context left, from the share the row prints used (`223.0K (21%)` → `79%`). */
  context?: string;
  /** The model id from the row's notice slot, right after a switch. */
  model?: string;
}

/** The live status row: one space of padding, the agent's name in capitals,
 * then — two or more columns over — a notice (`model union-alpha`, `no
 * variants available`), the progress dots and `esc interrupt` while the
 * session is working, and the token count and key hint when it is idle. At 60
 * columns there is room for the chip alone.
 *
 * The tail is not required to be a shape this knows: an unrecognized notice
 * must still leave the row readable as the frame, or the phone would paint
 * OpenCode's own status bar into the conversation. What the tail is *asked*
 * for is only the two facts below. */
const CHIP_ROW = /^ ([A-Z][A-Z0-9]*(?:[ ._-][A-Z0-9]+)*)(?:\s{2,}(\S.*?))?\s*$/u;
/** Longer than any agent name OpenCode draws; a longer run of capitals is a
 * line of output that happens to be shouting. */
const MAX_CHIP = 24;
/** `223.0K (21%)` — tokens used and the share of the window they are. The
 * chip says what is *left*, so the share is flipped (`21%` → `79%`), the same
 * way Gemini CLI's `25% used` is. */
const CONTEXT = /(?:\d+(?:\.\d+)?[KM]?)\s*\((\d{1,3})%\)/u;

/** The context left, from a row's `223.0K (21%)`. */
function contextLeft(text: string): string | undefined {
  const used = CONTEXT.exec(text)?.[1];
  return used === undefined ? undefined : `${Math.max(0, 100 - Number(used))}%`;
}
/** The notice OpenCode shows in the status row after a model switch, its own
 * column: `model union-alpha`. */
const MODEL_NOTICE = /(?:^|\s{2,})model\s+([A-Za-z0-9][\w.:/-]*)/u;

/** The status the row carries, or `null` when the row is not one. */
export function openCodeStatusRow(text: string): OpenCodeStatus | null {
  const match = CHIP_ROW.exec(text.replace(/\s+$/u, ""));
  if (!match) return null;
  const chip = match[1];
  if (chip.length > MAX_CHIP) return null;
  const status: OpenCodeStatus = { mode: chip.toLowerCase() };
  const tail = match[2];
  if (tail) {
    const context = contextLeft(tail);
    if (context) status.context = context;
    const model = MODEL_NOTICE.exec(tail);
    if (model) status.model = model[1];
  }
  return status;
}

/*
 * The *full* TUI — what a plain `opencode` tab runs — draws no ` BUILD` row.
 * Its composer box (`component/prompt/index.tsx`, unchanged from 1.18.31 to
 * 1.18.34) ends in two rows of its own, the facts this reads:
 *
 *   `┃  Build · Muse Spark 1.3 Free OpenCode Zen · high`   inside the box: the
 *                                                         agent (title case,
 *                                                         `auto` after it in
 *                                                         auto permission
 *                                                         mode), the model,
 *                                                         its provider, the
 *                                                         variant
 *   `╹▀▀▀▀▀▀▀▀`                                           the box's bottom
 *                                                         edge, which
 *                                                         `readableScreen`
 *                                                         drops
 *   ` ⬝⬝■■ esc interrupt     12.3K (5%) · $0.02  ctrl+p commands`
 *                                                         under the box: the
 *                                                         spinner and the
 *                                                         interrupt hint while
 *                                                         it works (the
 *                                                         folder when idle),
 *                                                         then context, cost
 *                                                         and the palette key
 *
 * Source-read, not captured: no OpenCode binary runs inside the fence these
 * were written in. Every shape is therefore held loosely — a row that does not
 * match leaves the frame unread, the phone's state before this existed.
 *
 * The start screen (`routes/home.tsx`, captured from 2.1.2 and 2.1.3 at
 * 120×40) draws the same box centred under the logo, so its `┃` stands too far
 * in for `readableScreen` to strip, and puts its own footer row
 * (`home.footer`, the version right-aligned) at the screen's bottom, below the
 * box's footer:
 *
 *   `┃  Ask anything… "Fix broken tests"`
 *   `┃  Build · Flint 40B Free OpenCode`
 *   `/…/proj  shift+tab agents  ctrl+p commands`
 *   `                                                  2.1.3`
 */

/** The row under the full TUI's box: its palette hint (`ctrl+p commands`, the
 * key as configured), or the shell-mode hint that stands in for it. Neither
 * is anchored to the row's end — a wide pane draws the session's sidebar to
 * the right of the composer. */
const FULL_FOOTER = /\b(?:ctrl|alt|super|meta|shift)\+\S+\s+commands\b|\besc\s+exit shell mode\b/iu;
/** The composer's agent row: the agent in title case, `auto` in auto
 * permission mode, then ` · ` and the model phrase, and ` · ` and the variant.
 * Shell mode prints `Shell` alone. Only its first column is read: anything two
 * spaces further over is not the box's. */
const COMPOSER_ROW = /^([A-Z][\w-]*(?: [A-Z][\w-]*){0,2})(?: (auto))?(?: · (\S.*?))?(?: · (\S+))?$/u;
/** The box's own left bar, where `readableScreen` left it on the row. */
const BOX_BAR = /^\s*(?:[│┃]\s+)?/u;
/** The start screen's bottom row: the version, right-aligned, maybe after
 * what plugins add to the slot. */
const HOME_FOOTER = /(?:^|\s)v?\d+\.\d+\.\d+(?:-[\w.]+)?$/u;

/** Whether `text` is the start screen's footer row, under the box's. */
export function isOpenCodeHomeFooter(text: string): boolean {
  return HOME_FOOTER.test(text.trim());
}
/** Longer than any model phrase the box prints; a longer one is prose. */
const MAX_COMPOSER = 120;

export interface OpenCodeComposer {
  /** The agent, lower-cased (`build`, `plan`); absent in shell mode. */
  mode?: string;
  /** The model's display name — the provider cut off where its colour says
   * the label ends, or the whole phrase where the row's colours are unknown. */
  model?: string;
  /** The model variant (`high`), OpenCode's reasoning-effort equivalent. */
  variant?: string;
}

export interface OpenCodeFooter {
  /** The session is working: the row carries the interrupt hint. */
  busy: boolean;
  /** Context left, from the share the row prints used (`12.3K (5%)` → `95%`). */
  context?: string;
}

/** The row under the full TUI's composer, or `null` when the row is not it. */
export function openCodeFullFooter(text: string): OpenCodeFooter | null {
  if (!FULL_FOOTER.test(text)) return null;
  const footer: OpenCodeFooter = { busy: /(?:^|\s)esc (?:again to )?interrupt\b/u.test(text) };
  const context = contextLeft(text);
  if (context) footer.context = context;
  return footer;
}

/** The model phrase's own name: the phrase up to the first character drawn
 * in another colour than its first. OpenCode prints the model in the text
 * colour and the provider after it muted, with a single space between —
 * nothing in the words says where one ends. */
function modelName(
  phrase: string,
  offset: number,
  row: { text: string; spans?: readonly { text: string; color?: string }[] },
): string {
  const spans = row.spans;
  if (!spans || spans.map((span) => span.text).join("") !== row.text) return phrase;
  const colors: (string | undefined)[] = [];
  for (const span of spans) colors.push(...Array<string | undefined>(span.text.length).fill(span.color));
  const first = colors[offset];
  for (let index = 1; index < phrase.length; index += 1) {
    if (phrase[index] === " " || colors[offset + index] === first) continue;
    const name = phrase.slice(0, index).trim();
    return name || phrase;
  }
  return phrase;
}

/** The composer's agent row, or `null` when the row is not it. */
export function openCodeComposer(
  row: { text: string; spans?: readonly { text: string; color?: string }[] },
): OpenCodeComposer | null {
  const lead = BOX_BAR.exec(row.text)?.[0].length ?? 0;
  const column = row.text.slice(lead).trimEnd().split(/\s{2,}/u)[0];
  if (!column || column.length > MAX_COMPOSER) return null;
  const match = COMPOSER_ROW.exec(column);
  if (!match) return null;
  const [, agent, , phrase, variant] = match;
  const composer: OpenCodeComposer = {};
  if (agent !== "Shell") composer.mode = agent.toLowerCase();
  if (phrase) composer.model = modelName(phrase, lead + column.indexOf(" · ") + 3, row);
  if (variant) composer.variant = variant;
  return composer;
}

/** Where the block opening at `start` ends, exclusive: the next blank row, or
 * the end of the lines. OpenCode wraps its own rows without an indent, so this
 * is the only thing that holds a wrapped prompt or a wrapped tool call
 * together — it prints a blank row between blocks and none inside one. */
export function openCodeBlockEnd(lines: readonly { text: string }[], start: number): number {
  let index = start + 1;
  while (index < lines.length && lines[index].text.trim() !== "") index += 1;
  return index;
}

/** A row that opens a block of OpenCode's own: a tool call, the turn footer,
 * the prompt echo, the banner. Never the continuation of the row above it. */
function opensBlock(text: string): boolean {
  return isOpenCodeToolRow(text)
    || isOpenCodeBanner(text)
    || openCodeTurnFooter(text) !== null
    || /^ ?›\s/u.test(text);
}

/** The columns a wrapped row is indented by without anything having been
 * written there: OpenCode hangs the continuation of a list item under its
 * text. Anything past that is a space the wrap swallowed. */
function hangingIndent(opener: string): number {
  const indent = opener.length - opener.trimStart().length;
  return indent + (/^\s*[-*+•]\s/u.test(opener) ? 2 : 0);
}

/** Characters a long token is broken *inside* rather than after: a path's
 * slash, a hyphenated name, a dotted host or version. A row that ends on one
 * is rejoined with nothing between. */
const TOKEN_TAIL = /[/\-_:=.]$/u;

/** Whether `next` is the rest of `previous`, wrapped — and with what between
 * them.
 *
 * OpenCode wraps greedily at the pane width, so a break is *explained*: either
 * the row ran into the last column, or the next row's first word would not
 * have fitted after it. A row that ends well short of the width with room for
 * that word to follow was broken by the session on purpose, and stays broken.
 *
 * What belongs in the seam is read the same way, from the three things the
 * wrap can have done with the space it broke at:
 *   - it kept it, and the row below opens indented past its hanging indent
 *     (`…(Capacitor,` + `   wraps Web UI`) — the space comes back;
 *   - it broke a long token at the token's own punctuation
 *     (`github.com/dzianisv/` + `opencode-mobile`, `~/.` + `local/share`) —
 *     nothing comes back, and a sentence is spared by its capital: a `.` is
 *     only read this way when what follows it is lower-case or a digit;
 *   - it cut at the last column, which leaves nothing to say — the row is
 *     rejoined as it stood.
 * Getting one of these wrong costs a space, which is why the rule is allowed
 * to be this simple: nothing is dropped either way.
 */
function wrapSeam(previous: string, next: string, columns: number, opener: string): string | null {
  if (!previous.trim() || !next.trim() || opensBlock(next)) return null;
  const rest = next.trimStart();
  const word = /^\S+/u.exec(rest)?.[0] ?? "";
  const cut = previous.length >= columns;
  // A word "fits" only with a column to spare: OpenCode wraps a word that
  // would end exactly on the last column, so a row broken there is a wrap and
  // not a newline the session wrote (`Thinking: … for` + `opencode using …`,
  // 51 + 1 + 8 at 60 columns, from a capture).
  if (!cut && previous.length + 1 + word.length < columns) return null;
  if (next.length - rest.length > hangingIndent(opener)) return " ";
  if (TOKEN_TAIL.test(previous) && /^[A-Za-z0-9]/u.test(rest)) {
    if (!previous.endsWith(".") || /^[a-z0-9]/u.test(rest)) return "";
  }
  return cut ? "" : " ";
}

/**
 * The lines with OpenCode's own wrapping undone, so the phone re-wraps them at
 * *its* width — what `readableScreen` does for every other CLI by rejoining
 * the rows xterm wrapped.
 *
 * OpenCode cannot be helped that way: it wraps its output itself and prints
 * each row as its own line, so the terminal never marks one as a continuation
 * and the reading view showed the pane's column count as hard breaks,
 * re-wrapped again at the phone's width into ragged half-lines. `columns` is
 * the pane's width, which is what OpenCode wrapped against.
 */
export function joinOpenCodeWraps(lines: readonly ReadableLine[], columns: number): ReadableLine[] {
  if (!(columns > 0)) return [...lines];
  const out: ReadableLine[] = [];
  /** The last *physical* row appended, which is what OpenCode wrapped against
   * — not the line it has been joined onto. */
  let physical = "";
  for (const line of lines) {
    const previous = out[out.length - 1];
    const seam = previous ? wrapSeam(physical, line.text, columns, previous.text) : null;
    physical = line.text;
    if (previous && seam !== null) {
      const indent = line.text.length - line.text.trimStart().length;
      out[out.length - 1] = {
        ...previous,
        text: previous.text + seam + line.text.slice(indent),
        spans: [...previous.spans, ...(seam ? [{ text: seam }] : []), ...dropLeading(line.spans, indent)],
      };
      continue;
    }
    out.push({ ...line });
  }
  return out;
}

/** A copy of `spans` with the first `count` characters removed — the indent
 * OpenCode puts on a wrapped list item, which the seam replaces. */
function dropLeading(spans: readonly ReadableSpan[], count: number): ReadableSpan[] {
  if (count <= 0) return [...spans];
  const out: ReadableSpan[] = [];
  let remaining = count;
  for (const span of spans) {
    if (remaining >= span.text.length) {
      remaining -= span.text.length;
      continue;
    }
    out.push(remaining > 0 ? { ...span, text: span.text.slice(remaining) } : span);
    remaining = 0;
  }
  return out;
}

/**
 * OpenCode's own picker, which it opens from its command palette (ctrl+p)
 * rather than from a slash command — mini has no `/model` at all, and sending
 * one there would post the words to the model as a prompt.
 *
 * Both interfaces draw the same overlay, and it is not the numbered dialog
 * `selectPrompt` reads: a title, a search field, then the rows, each a label
 * with an optional tag in a second column. So it is read here and answered by
 * *typing* — `openCodePickKeys` clears the search field, types the row's label
 * and submits, which is how a person uses it and what a capture of a live
 * session confirms. The picker filters on the label as printed, provider and
 * all (`Grok 4.5 GitHub Copilot` finds the one row), so nothing has to be
 * taken apart to answer with it.
 *
 * Where the two differ is the geometry, and the geometry is all this reads:
 *
 *   - **mini** draws the overlay full width, two columns in, and marks the
 *     highlighted row in colour alone.
 *   - the **full TUI** centres it — 82 columns in on a 215-column pane — and
 *     marks the highlight with a `●` two columns left of the labels. It also
 *     paints the dialog over its own composer box, so rows can carry that
 *     box's `┃` and fragments of its text to the *left* of the dialog.
 *
 * So the rows are read by column rather than by indent: the title's column is
 * the dialog's, everything left of it on a row is the screen behind it, and
 * everything from it is the row. That is also what holds the full TUI's rows
 * together across the blank line it leaves between provider groups — mini's
 * list is one block, the full TUI's is several, and a blank row in the middle
 * of the dialog's own column band is a separator, not the end of the list.
 *
 * A group heading (`OpenCode Zen`, `Recent`) is told from a model by the
 * blank row the dialog leaves above it, or — at a frame's top, where there is
 * none — by being bold on the dialog's own background. It is no row to pick
 * (`openCodePickerPrompt`): typed, it matched its group's first model, which
 * Enter then picked.
 *
 * The list is a scroll box about half the pane tall, so a frame is a slice of
 * it; `OpenCodePickerWalk` puts the slices together.
 */
const PICKER_TITLE = /^(\s+)(Select [a-z][\w ]{0,30}?)(?:\s+\d+(?:\/\d+)?)?(?:\s+esc)?$/u;
/** The same title row with the screen behind the overlay showing on either
 * side of it: the full TUI dims its session rather than clearing it, so over a
 * conversation the title row carries the transcript's words to its left and
 * the sidebar's to its right. Only with its `esc`, which is what tells the
 * dialog's title from those words — and where the dialog's right edge is. */
const PICKER_TITLE_OVER = /^(.*?\S\s{2,})(Select [a-z][\w ]{0,30}?)(?:\s+\d+(?:\/\d+)?)?\s+esc(?=\s{2,}|\s*[│┃]|\s*$)/u;
/** Rows read out of one picker. The full TUI lists every provider's models on
 * a tall pane; the cap only bounds a misread. */
const MAX_PICKER_ROWS = 40;
/** Blank rows the dialog may leave inside its own list — one between provider
 * groups, and `readableScreen` collapses any run to one. A second in a row is
 * the end of the overlay. */
const MAX_LIST_GAP = 1;
/** The dialog's own key hints, under the rows (`Connect provider ctrl+a
 * Favorite ctrl+f`). No model is named after a key. */
const PICKER_FOOTER = /(?:^|\s)ctrl\+\p{L}\b/u;
/** The full TUI's highlight, drawn left of the labels' column. Mini draws no
 * marker at all, so a picker without one simply reports no current row. */
const PICKER_MARK = /[●▸❯>]/u;
const MARK_REACH = 3;
/** Narrower than any picker OpenCode draws: a title row that ends before this
 * is not the overlay's right edge. */
const MIN_PICKER_WIDTH = 24;
/** Two or more spaces — the gap before a row's tag (`Free`). */
const COLUMN_SPLIT = /\s{2,}/u;
const MAX_LABEL = 80;

/** A row as the screen has it, column for column. `readableScreen` takes a
 * frame edge off the front of a row (`edge`), which is right for a box's own
 * rows but not for a dialog drawn over one: on a narrow pane the composer's
 * `┃` sits three columns in, and the dialog rows beside it came out five
 * columns short — `Muse Spark 1.3 Free` read as `Spark 1.3 Free`, `Recent` as
 * `t`. The edge is put back as blanks, so every row lines up with the title. */
function screenText(line: { text: string; edge?: number }): string {
  return line.edge ? " ".repeat(line.edge) + line.text : line.text;
}

/** A row of OpenCode's picker as the dialog drew it. */
export interface OpenCodePickerRow {
  /** The row's own words, as printed: a Recent or Favorites row carries its
   * provider after the model's name (`Muse Spark 1.3 Free OpenCode Zen`). */
  text: string;
  /** The second column (`Free`). */
  tag?: string;
  /** A group heading (`OpenCode Zen`, `Recent`) rather than a model: the rows
   * under it are its, and it is not something to pick. */
  heading: boolean;
  /** The full TUI's `●`: the model the session is on. */
  marked: boolean;
}

/** The part of the list one frame shows. The dialog is a scroll box about
 * half the pane tall (`floor(rows / 2) - 6` lines, 1.18.31), with no
 * scrollbar, so a frame is a slice of a list that can be several times
 * longer: what the chooser lists is the slices put together
 * (`OpenCodePickerWalk`). */
export interface OpenCodePickerPage {
  title: string;
  rows: OpenCodePickerRow[];
  /** Index, in the lines read, of the title row. */
  start: number;
}

type PickerLine = { text: string; edge?: number; spans?: readonly ReadableSpan[] };

/** The span drawn at screen `column` of `line`, if the line kept its styles. */
function spanAt(line: PickerLine, column: number): ReadableSpan | undefined {
  if (!line.spans) return undefined;
  let offset = column - (line.edge ?? 0);
  if (offset < 0) return undefined;
  for (const span of line.spans) {
    if (offset < span.text.length) return span;
    offset -= span.text.length;
  }
  return undefined;
}

export function readOpenCodePickerPage(lines: readonly PickerLine[]): OpenCodePickerPage | null {
  let title = -1;
  let heading: RegExpExecArray | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = screenText(lines[index]);
    heading = PICKER_TITLE.exec(text) ?? PICKER_TITLE_OVER.exec(text);
    if (heading) {
      title = index;
      break;
    }
  }
  if (title < 0 || !heading) return null;
  /** The column the dialog's own text starts at — the title's. */
  const column = heading[1].length;
  /** …and where it ends: the title row spans the overlay's whole width (its
   * `esc` sits at the far edge), so its own end is the dialog's. The full TUI
   * paints over the session's status bar as well as its composer box, and
   * without this the bar's tail rode into a row's second column (`GitHub
   * Copilot` · `ommands`). A title too short to bound anything — a dialog this
   * has misread, or one drawn without the hint — bounds nothing. A title row
   * over the screen behind it ends at its `esc` (`PICKER_TITLE_OVER`). */
  const right = heading[0].trimEnd().length;
  const end = right >= column + MIN_PICKER_WIDTH ? right : Number.POSITIVE_INFINITY;
  /** The dialog's own background, read off its title: a heading is drawn on
   * it, the highlighted row on a colour of its own. */
  const panel = spanAt(lines[title], column)?.background;
  /** The row as the dialog drew it: what stands between the dialog's own two
   * columns, with whatever the screen behind it left on either side dropped. */
  const cell = (text: string) => (text.length > column ? text.slice(column, end).trimEnd() : "");
  let index = title + 1;
  // Blank within the dialog's own band: over a conversation, the rows the
  // dialog leaves empty still carry the transcript beside it.
  const skipBlank = () => { while (index < lines.length && !cell(screenText(lines[index]))) index += 1; };
  skipBlank();
  // The search field, whether it holds the placeholder or a typed query.
  if (index >= lines.length) return null;
  index += 1;
  skipBlank();
  const rows: OpenCodePickerRow[] = [];
  let gap = 0;
  for (; index < lines.length && rows.length < MAX_PICKER_ROWS; index += 1) {
    const text = screenText(lines[index]);
    const row = cell(text);
    // Nothing in the dialog's band — a blank row, or the screen behind the
    // overlay showing past its left edge: between two groups of the same
    // list; past the list, the end of it.
    if (!row) {
      gap += 1;
      if (gap > MAX_LIST_GAP || rows.length === 0) break;
      continue;
    }
    if (PICKER_FOOTER.test(row)) break;
    const columns = row.split(COLUMN_SPLIT);
    const label = columns[0].trim();
    if (!label) break;
    // The dialog leaves a blank row above every group's heading but the
    // first, and nowhere else. A heading at the top of a frame has none
    // there: it is the one row drawn bold on the dialog's own background
    // (the highlighted row is bold too, on its own colour).
    const span = spanAt(lines[index], column);
    const bold = span?.className?.split(" ").includes("b") === true;
    const isHeading = gap > 0 || (bold && span?.background === panel);
    gap = 0;
    rows.push({
      text: label.slice(0, MAX_LABEL),
      tag: columns.slice(1).join(" · ").trim() || undefined,
      heading: isHeading,
      // Two columns left of the labels; further left is the screen behind.
      marked: PICKER_MARK.test(text.slice(Math.max(0, column - MARK_REACH), column)),
    });
  }
  if (rows.length === 0) return null;
  return { title: heading[2].trim(), rows, start: title };
}

/** The headings of the sections OpenCode lists above its providers: their
 * rows carry the provider in their own words. */
const SECTIONS = new Set(["Recent", "Favorites"]);
/** What a favourite row carries after its name in a provider's group. */
const FAVORITE_NOTE = /\s+\(Favorite\)$/u;
const ELLIPSIS = /\s*(?:…|\.\.\.)$/u;

/**
 * The rows as a list to pick from: one entry per model, under the provider it
 * belongs to. A heading is no row of its own — typed into the search field it
 * only matched its group's first model, which Enter then picked — but the
 * provider of every row under it, shown beside the model and typed after it:
 * the picker filters on a model's name and its provider together (`Grok 4.5
 * GitHub Copilot` finds the one row), and one name can stand in two groups. A
 * Recent or Favorites row prints its provider itself, which is split off for
 * the label wherever a provider's heading names it.
 */
export function openCodePickerPrompt(page: OpenCodePickerPage, rows: readonly OpenCodePickerRow[] = page.rows): SelectPrompt {
  const providers = rows
    .filter((row) => row.heading && !SECTIONS.has(row.text))
    .map((row) => row.text)
    .sort((a, b) => b.length - a.length);
  const options: SelectPrompt["options"] = [];
  let current = -1;
  let group: string | undefined;
  for (const row of rows) {
    if (row.heading) {
      group = row.text;
      continue;
    }
    const printed = row.text.replace(FAVORITE_NOTE, "");
    // Rows above every provider's heading are a section's, whether or not
    // its own heading was seen: once the highlight wraps to the list's first
    // model, the dialog centres on it and can leave `Recent` above the frame.
    const section = group === undefined || SECTIONS.has(group);
    let label = printed;
    let provider = section ? undefined : group;
    if (section) {
      const named = providers.find((name) => printed.endsWith(` ${name}`) && printed.length > name.length + 1);
      if (named) {
        label = printed.slice(0, printed.length - named.length - 1);
        provider = named;
      }
    }
    const query = section ? printed : `${printed.replace(ELLIPSIS, "")} ${group}`;
    if (row.marked) current = options.length;
    options.push({
      index: options.length,
      number: options.length + 1,
      label,
      description: [provider, row.tag].filter(Boolean).join(" · ") || undefined,
      keys: openCodePickKeys(query),
    });
  }
  // The picker's own heading is the line `start` points at, so it has no
  // question block above its rows: the model sheet reads the rows and the
  // heading, never the screen around them.
  return {
    options,
    current,
    start: page.start,
    question: page.start,
    context: page.start,
    title: page.title,
  };
}

export function readOpenCodePicker(lines: readonly PickerLine[]): SelectPrompt | null {
  const page = readOpenCodePickerPage(lines);
  return page ? openCodePickerPrompt(page) : null;
}

/** ctrl+p — the only way into OpenCode mini's commands. */
const PALETTE = "";
/** ctrl+u — clears the picker's search field, so a second tap never types onto
 * what the first one left there. */
const CLEAR_SEARCH = "";

/** The keys that open the model picker: the palette, the word that finds
 * "Switch model" in it, and Enter. */
export const OPENCODE_MODEL_KEYS = [PALETTE, "model", "\r"];

/** The keys that answer the picker with `label`: clear the search, type the
 * label, submit. A label the pane truncated (`Ling 3.0 Flash Fin…`) is typed
 * without its ellipsis — the picker filters on a prefix, so the shorter query
 * still finds the row, while the `…` itself would match nothing. */
export function openCodePickKeys(label: string): string[] {
  return [CLEAR_SEARCH, label.replace(/\s*(?:…|\.\.\.)$/u, "").trim(), "\r"];
}

/** ↓ — moves the picker's highlight, which scrolls its list along. */
const WALK_DOWN = "\u001b[B";
/** How long a step is given to show before it is taken to have moved
 * nothing: the list is at its end, or fits the dialog whole. A phone's frame
 * comes over the network, so this is not a desktop repaint. */
const WALK_STEP_WAIT_MS = 600;
/** Steps in a row that moved nothing before the walk ends. The dialog keeps
 * its highlight centred, so at either end of the list it moves the
 * highlight without scrolling for up to half a frame — two steps. */
const WALK_STILL_STEPS = 3;
const MAX_WALK_STEPS = 200;
const MAX_WALK_ROWS = 600;

/** The rows the walk has seen. `main` runs from the frame the dialog opened on
 * (centred on the session's model) down to where the walk is. The highlight
 * wraps from the last row to the first, so once the walk passes the end the
 * frames come from the list's top: `top`, until it reaches `main` again. */
export interface OpenCodeWalkRows {
  main: OpenCodePickerRow[];
  top: OpenCodePickerRow[] | null;
  done: boolean;
}

const sameRow = (a: OpenCodePickerRow, b: OpenCodePickerRow) => a.text === b.text && a.tag === b.tag;

/** Where `known` runs on into `page`: the index from which every row of
 * `known` is `page`'s next, the longest such overlap. -1 when `page` does not
 * pick up where `known` ends. */
function continuation(known: readonly OpenCodePickerRow[], page: readonly OpenCodePickerRow[]): number {
  for (let from = Math.max(0, known.length - page.length); from < known.length; from += 1) {
    let match = true;
    for (let offset = 0; from + offset < known.length; offset += 1) {
      if (!sameRow(known[from + offset], page[offset])) {
        match = false;
        break;
      }
    }
    if (match) return from;
  }
  return -1;
}

/** Whether `page` stands whole inside `known`, and where. */
function within(known: readonly OpenCodePickerRow[], page: readonly OpenCodePickerRow[]): number {
  for (let from = 0; from + page.length <= known.length; from += 1) {
    if (page.every((row, offset) => sameRow(known[from + offset], row))) return from;
  }
  return -1;
}

/** `known` up to `from`, then `page`. A row both have is a heading if either
 * frame could tell: one at a frame's top has no blank above it to say so. */
function joinAt(known: readonly OpenCodePickerRow[], from: number, page: readonly OpenCodePickerRow[]): OpenCodePickerRow[] {
  return [
    ...known.slice(0, from),
    ...page.map((row, offset) => {
      const seen = known[from + offset];
      return seen && seen.heading && !row.heading ? { ...row, heading: true } : row;
    }),
  ];
}

/** `page` before `known`, where `page` runs on into `known`'s start. */
function joinBefore(page: readonly OpenCodePickerRow[], from: number, known: readonly OpenCodePickerRow[]): OpenCodePickerRow[] {
  const overlap = page.length - from;
  return [...joinAt(page, from, known.slice(0, overlap)), ...known.slice(overlap)];
}

/** One more frame of the list, put in its place among those seen. */
export function mergeOpenCodePage(rows: OpenCodeWalkRows | null, page: readonly OpenCodePickerRow[]): OpenCodeWalkRows {
  if (!rows) return { main: [...page], top: null, done: false };
  if (rows.done) return rows;
  const { main, top } = rows;
  if (top === null) {
    const from = continuation(main, page);
    if (from >= 0) {
      const next = joinAt(main, from, page);
      return { main: next, top: null, done: next.length >= MAX_WALK_ROWS };
    }
    // Back on rows already seen: the walk passed the end, and the list's top
    // is the frame it opened on.
    if (within(main, page) >= 0) return { main, top: null, done: true };
    // The list's top, running on into the frame it opened on.
    const before = continuation(page, main);
    if (before >= 0) return { main: joinBefore(page, before, main), top: null, done: true };
    return { main, top: [...page], done: false };
  }
  const from = continuation(top, page);
  const grown = from >= 0 ? joinAt(top, from, page) : within(top, page) >= 0 ? top : [...top, ...page];
  const meets = continuation(grown, main);
  if (meets >= 0) return { main: joinBefore(grown, meets, main), top: null, done: true };
  if (within(grown, main) >= 0) return { main: grown, top: null, done: true };
  return { main, top: grown, done: grown.length + main.length >= MAX_WALK_ROWS };
}

/** The rows in the list's own order: its top, then from the frame it opened on. */
function walkedRows(rows: OpenCodeWalkRows): OpenCodePickerRow[] {
  return rows.top ? [...rows.top, ...rows.main] : rows.main;
}

/** A step of the walk: a third of a frame. The dialog centres its highlight,
 * so a step scrolls the list by the rows it crosses — a heading and the blank
 * above it count as rows but take no step — and a third keeps each frame
 * overlapping the one before, which is how the frames are put together. */
function walkKeys(page: OpenCodePickerPage): string[] {
  return Array.from({ length: Math.max(1, Math.floor(page.rows.length / 3)) }, () => WALK_DOWN);
}

/**
 * Lists the whole of OpenCode's picker, not the slice its frame shows: walks
 * the highlight down with ↓ — nothing is picked, and the search field never
 * sees a key — and puts the frames together until the list has come round to
 * where it started. Fed every frame the screen draws (`read`); a tap stops it
 * (`hold`) before its own keys go in, and keys sent before those are harmless:
 * typing into the search field moves the highlight to the first match.
 */
export class OpenCodePickerWalk {
  private page: OpenCodePickerPage | null = null;
  private rows: OpenCodeWalkRows | null = null;
  private seen = "";
  private still = 0;
  private steps = 0;
  private held = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `send` types keys into the session; `changed` says the list grew or the
   * walk ended without a new frame (a caller that reads only on frames). */
  constructor(
    private readonly send: (keys: string[]) => void,
    private readonly changed: () => void = () => {},
  ) {}

  /** The picker the screen shows now, or null when it shows none. */
  read(page: OpenCodePickerPage | null): void {
    if (!page) {
      this.reset();
      return;
    }
    // Another step of the dialog (its variant list): a list of its own.
    if (this.page && this.page.title !== page.title) this.reset();
    this.page = page;
    if (this.held) return;
    const seen = page.rows.map((row) => `${row.text}\u0000${row.tag ?? ""}`).join("\u0001");
    if (this.rows && seen === this.seen) return;
    this.seen = seen;
    this.rows = mergeOpenCodePage(this.rows, page.rows);
    this.still = 0;
    this.step();
  }

  /** The list as far as it is known, or the frame alone once a tap has
   * filtered it into something else. */
  prompt(): SelectPrompt | null {
    const page = this.page;
    if (!page) return null;
    if (!this.rows) return openCodePickerPrompt(page);
    const rows = walkedRows(this.rows);
    if (this.held && within(rows, page.rows) < 0) return openCodePickerPrompt(page);
    const prompt = openCodePickerPrompt(page, rows);
    return this.walking() ? { ...prompt, hidden: 1 } : prompt;
  }

  /** Still putting the list together. */
  walking(): boolean {
    return !!this.rows && !this.rows.done && !this.held;
  }

  /** No more keys: a row was tapped, or the picker is being closed. */
  hold(): void {
    this.held = true;
    this.clearTimer();
  }

  reset(): void {
    this.clearTimer();
    this.page = null;
    this.rows = null;
    this.seen = "";
    this.still = 0;
    this.steps = 0;
    this.held = false;
  }

  private step(): void {
    this.clearTimer();
    if (!this.page || !this.rows || this.rows.done || this.held) return;
    if (this.steps >= MAX_WALK_STEPS) {
      this.finish();
      return;
    }
    this.steps += 1;
    this.send(walkKeys(this.page));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.still += 1;
      if (this.still >= WALK_STILL_STEPS) this.finish();
      else this.step();
    }, WALK_STEP_WAIT_MS);
  }

  private finish(): void {
    if (this.rows) this.rows = { ...this.rows, done: true };
    this.changed();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** The top row of any dialog OpenCode draws over its session — `DialogSelect`
 * (the pickers, "Connect a provider"), its alerts, confirms and prompts: the
 * title, then the `esc` that closes it at the dialog's far edge, with whatever
 * the dimmed screen behind shows on either side. The working row's
 * `esc interrupt` and shell mode's `esc exit shell mode` are hints, not this. */
const DIALOG_HEADER = /\S\s{2,}esc(?=\s{2,}|\s*[│┃]|\s*$)/u;
const DIALOG_CLOSE = "\u001b";

/**
 * The keys that clear a dialog OpenCode has open over its composer before a
 * message goes in: one Escape, which closes the top dialog and hands focus
 * back to the prompt — or none, with no dialog on `rows`.
 *
 * Typed into a dialog, a message never reaches the agent: its search field
 * takes the words, Enter picks whatever row they matched, and the composer's
 * line reset (Ctrl+A) is the model picker's own "Connect provider" key — a
 * "yes" sent from the Chat view showed as sent, the agent never answered, and
 * the terminal had "Connect a provider" up (1.18.32). A picker the model chip
 * opened and could not read back was left up exactly so. With no dialog the
 * Escape is withheld: a working session reads it as half an interrupt.
 *
 * `rows` are the screen as it stands, the viewport only — a mini session's
 * scrollback can still hold an overlay it has since closed.
 */
export function openCodeDialogCloseKeys(rows: readonly (string | { text: string })[]): string[] {
  const open = rows.some((row) => DIALOG_HEADER.test((typeof row === "string" ? row : row.text).trimEnd()));
  return open ? [DIALOG_CLOSE] : [];
}
