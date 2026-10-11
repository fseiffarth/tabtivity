/**
 * Reads the status area an agent TUI draws *below its input box* — the line
 * Claude Code and Codex use for the working directory, git branch, model, mode
 * and remaining context — so the phone composer can show the same facts as
 * chips (the shape of the official Claude Code mobile composer: ＋ · model ·
 * mode).
 *
 * This is deliberately narrower than the semantic parser `readableScreen`
 * replaced: it never classifies session *output*. It only looks at the last
 * few lines, only below a line that is recognizably the TUI's own input
 * prompt, and only reports a field that positively matched a known shape —
 * an unmatched field stays absent and the chip falls back to a generic label.
 * Nothing here injects keystrokes; the chips' actions are the caller's.
 *
 * One family is read from a different place entirely: OpenCode's minimal
 * interface draws no input box marker at all, only a status row with the
 * agent's name on it, so it is found by that row and by the tab's label rather
 * than by the box above it (`openCodeMini.ts`, and `openCodeFrame` below).
 */

import {
  antigravityFooter,
  isAntigravityTab,
  readAntigravityPicker,
} from "./antigravity";
import {
  isOpenCodeTab,
  isOpenCodePlaceholder,
  openCodeComposer,
  openCodeFullFooter,
  openCodeStatusRow,
  openCodeTurnFooter,
} from "./openCodeMini";
import { isActionRow, isUnnumberedRow } from "./selectPrompt";

export interface SessionStatus {
  /** Working directory, as printed (`~/…` or absolute). */
  path?: string;
  /** Git branch, from `(branch)` beside the path or a ⎇/🌿-marked token. */
  branch?: string;
  /** Model name (claude/opus/sonnet/haiku/fable, gpt-*, codex, gemini, …). */
  model?: string;
  /** Reasoning effort, where the session prints one beside its model
   * (Antigravity: `Gemini 3.8 Flash · high`). */
  effort?: string;
  /** Permission/approval mode (plan, accept edits, bypass permissions, …). */
  mode?: string;
  /** Remaining context, e.g. `85%` — a CLI that prints "used" is flipped. */
  context?: string;
  /** A `/goal` is running: the session keeps taking turns until its condition
   * is met. Present only while the footer says so. */
  goal?: boolean;
}

export interface StatusLineLike {
  text: string;
  frameText?: string;
  /** The row's styled runs, where the caller has them: OpenCode's full TUI
   * says only by colour where its model's name ends and its provider's begins. */
  spans?: readonly { text: string; color?: string }[];
}

/** The input prompt after `readableScreen` stripped the box frame: `>`, `›` or
 * `❯`, alone or followed by the draft being typed. `*` is the YOLO prompt
 * prefix of Qwen Code and Gemini CLI — without it a session in YOLO mode has
 * no readable status at all, and a walk that lands there could not be
 * confirmed. Always ask through `isInputLine`, which scopes the `*`. */
const INPUT_LINE = /^\s*[>›❯*](\s|$)/u;

/** A `*` followed by text is also every markdown bullet an agent prints, and a
 * list at the bottom of a screen whose input box this does not recognize would
 * be taken for the frame — cutting the answer's last lines out of the chat. */
const STAR_DRAFT = /^\s*\*\s+\S/u;
/** Both YOLO prompts come with the word: Qwen Code prints `YOLO mode` under its
 * box, Gemini CLI `YOLO Ctrl+Y` over it. */
const YOLO_WORD = /\byolo\b/iu;
/** Non-blank rows looked through, each way, for that word — enough for a
 * three-line draft between the `*` and Qwen's footer. */
const YOLO_REACH = 4;

/** Whether row `index` is an agent's input line. A bare `*` is; a `*` with a
 * draft after it only where YOLO is written beside the box. */
function isInputLine(lines: readonly StatusLineLike[], index: number): boolean {
  const text = lines[index].text;
  if (!INPUT_LINE.test(text)) return false;
  if (!STAR_DRAFT.test(text)) return true;
  for (const step of [-1, 1]) {
    let seen = 0;
    for (let row = index + step; row >= 0 && row < lines.length && seen < YOLO_REACH; row += step) {
      const other = lines[row].text;
      if (!other.trim()) continue;
      seen += 1;
      if (YOLO_WORD.test(other)) return true;
    }
  }
  return false;
}

/** How far up from the bottom the input line may sit. The box is always the
 * bottom of a live TUI frame; anything higher is quoted output. */
const SEARCH_WINDOW = 8;
/** Status lines read below the input line. Claude Code draws at most a mode
 * line plus a statusline/shortcut line. */
const MAX_STATUS_LINES = 3;

/** Field separators the CLIs actually print between status facts. */
const SEGMENT_SPLIT = /\s{2,}|\s[·•|]\s/u;

/** Mode phrases, most specific first. The Qwen Code shapes ("YOLO mode",
 * "⏸ Ask permissions", "Auto mode", each with a "(shift + tab to cycle)"
 * suffix in the same segment) come from its `AutoAcceptIndicator`, read out of
 * the installed CLI — English locale only, which is also the CLI's default.
 * Bare "auto" — Codex's middle approval mode — is matched last and only as a
 * segment of its own: unanchored it would claim Claude Code's "auto-compact"
 * context notice and any path with an `auto` component. */
const MODES: [RegExp, string][] = [
  [/\bplan mode\b/iu, "plan"],
  [/\baccept edits\b/iu, "accept edits"],
  [/\bauto-accept\b/iu, "auto-accept"],
  [/\bbypass(?:ing)? permissions\b/iu, "bypass permissions"],
  [/\bdefault mode\b/iu, "default"],
  [/\bread only\b/iu, "read only"],
  [/\bfull access\b/iu, "full access"],
  [/\byolo mode\b/iu, "yolo"],
  [/\bask permissions\b/iu, "ask permissions"],
  [/\bauto mode\b/iu, "auto"],
  [/^[⏵⏩▶›>\s]*auto(?:\s+on)?$/iu, "auto"],
];

/** Codex 0.155 leaves its ordinary permission mode out of the footer. A
 * Shift+Tab change is confirmed once in history instead, immediately above
 * the redrawn input box (`• Permissions updated to Ask for approval`). The
 * phone's mode walk must read that confirmation: treating the footer's silence
 * as "still Working" makes it press Shift+Tab again and undo the requested
 * Auto switch. Both workspace reviewers are the phone's `auto` choice; they
 * differ in who reviews a risky action, not in the workspace access it grants. */
const CODEX_AGENT = /codex/iu;
const CODEX_PERMISSION_UPDATE = /\bPermissions updated to (Read Only|Ask for approval|Approve for me|Default|Auto|Workspace|Full Access)\s*$/iu;
const CODEX_UPDATE_REACH = 6;

function codexUpdatedMode(
  lines: readonly StatusLineLike[],
  inputIndex: number,
  agentLabel?: string,
): string | undefined {
  if (!agentLabel || !CODEX_AGENT.test(agentLabel)) return undefined;
  let seen = 0;
  for (let index = inputIndex - 1; index >= 0 && seen < CODEX_UPDATE_REACH; index -= 1) {
    const text = lines[index].text.trim();
    if (!text) continue;
    seen += 1;
    const match = CODEX_PERMISSION_UPDATE.exec(text);
    if (!match) continue;
    const mode = match[1].toLowerCase();
    return mode === "ask for approval"
      || mode === "approve for me"
      || mode === "default"
      || mode === "workspace"
      ? "auto"
      : mode;
  }
  return undefined;
}

/** Model families the chip recognizes. A token, never a sentence. */
const MODEL =
  /\b(claude[\w.-]*|(?:opus|sonnet|haiku|fable|mythos)(?:[ -][\w.]+)?|gpt-[\w.-]+|codex(?:-[\w.-]+)?|o[134](?:-mini)?|gemini[\w.-]*|qwen[\w.:-]*|llama[\w.:-]*|deepseek[\w.:-]*|mistral[\w.:-]*)\b/iu;

/** A working directory as the CLIs print one: `~`, `~/…`, `/…` or `C:\…`. */
const PATH = /(?:^|\s)(~(?:\/[^\s]*)?|\/[^\s]+|[A-Za-z]:\\[^\s]+)(?=\s|$)/u;

/** `(branch)` — no spaces inside, at least one letter, so "(shift+tab to
 * cycle)" and "(3)" stay unmatched. */
const PAREN_BRANCH = /\(([^()\s]*[A-Za-z][^()\s]*)\)/u;
/** A branch named by a git glyph or prefix: `⎇ main`, `🌿 main`, `git:main`. */
const MARKED_BRANCH = /(?:[⎇]|🌿|\bgit:)\s*([\w./-]+)/u;

/** A "used" figure as the remaining one, `25` → `75%`, keeping one decimal
 * where the CLI printed one. */
function remainingPercent(used: string): string {
  const left = Math.min(100, Math.max(0, 100 - Number.parseFloat(used)));
  return `${Math.round(left * 10) / 10}%`;
}

/** A running goal, as the footers print it: Claude Code's `◎ /goal active
 * (3m)` (2.1.283, beside the mode), Codex's `Pursuing goal (…)` (0.153). A
 * paused or met goal says something else and is not one. Tested before the
 * path, which would otherwise read `/goal` as a directory. */
const GOAL_ACTIVE = /(?:^|\s)\/goal active\b|^pursuing goal\b/iu;

function classify(segment: string, status: SessionStatus) {
  if (GOAL_ACTIVE.test(segment)) {
    status.goal = true;
    return;
  }
  // "ctx" is the short label Grok Build and many custom statuslines print.
  // A figure followed by "used" is flipped, so the chip always reads remaining.
  if (!status.context && /context|\bctx\b/iu.test(segment)) {
    const percent = /(\d{1,3}(?:\.\d+)?)\s?%(\s+(?:context\s+)?used\b)?/iu.exec(segment);
    if (percent) {
      status.context = percent[2] ? remainingPercent(percent[1]) : `${percent[1]}%`;
      return;
    }
  }
  // Gemini's footer says "NN% used" without the word "context". Only a
  // segment that is nothing but that figure counts — a percentage inside a
  // sentence is not a context readout.
  if (!status.context) {
    const used = /^(\d{1,3}(?:\.\d+)?)\s?%\s+(?:context\s+)?used$/iu.exec(segment);
    if (used) {
      status.context = remainingPercent(used[1]);
      return;
    }
  }
  if (!status.mode) {
    for (const [pattern, name] of MODES) {
      if (pattern.test(segment)) {
        status.mode = name;
        return;
      }
    }
  }
  if (!status.path) {
    const path = PATH.exec(segment);
    if (path) {
      status.path = path[1];
      if (!status.branch) {
        const branch = PAREN_BRANCH.exec(segment.slice(path.index + path[0].length));
        if (branch) status.branch = branch[1];
      }
      return;
    }
  }
  if (!status.branch) {
    const branch = MARKED_BRANCH.exec(segment);
    if (branch) {
      status.branch = branch[1];
      return;
    }
  }
  if (!status.model) {
    const model = MODEL.exec(segment);
    if (model) status.model = model[1];
  }
}

/** Gemini CLI's approval mode, drawn on the row *above* its input box — the
 * status row's `ApprovalModeIndicator`, read out of the 0.56.0 bundle and
 * unchanged in 0.60.0: the mode word, then the key that leaves it. In its
 * default mode the row is the hint alone and names no mode, which the Gemini
 * family reads as its silent default. Whole segments only, so a sentence of
 * output that happens to start with "plan" is never a mode. */
const GEMINI_MODE = /^(?:(auto-accept edits|plan) \S+ to (?:plan|manual)|(YOLO) \S+)$/u;
const GEMINI_DEFAULT_HINT = /^\S+ to accept edits$/u;
/** Non-blank rows above the input line the indicator may sit in: the next one
 * up, or a couple further when a narrow window stacks the status row. */
const ABOVE_REACH = 3;

/** Gemini's indicator above the input line at `inputIndex`: the row it is on,
 * and the mode it names (`undefined` for the default hint). */
function geminiIndicatorAbove(
  lines: readonly StatusLineLike[],
  inputIndex: number,
): { row: number; mode?: string } | null {
  let seen = 0;
  for (let row = inputIndex - 1; row >= 0 && seen < ABOVE_REACH; row -= 1) {
    const text = lines[row].text.trim();
    if (!text) continue;
    seen += 1;
    for (const raw of text.split(SEGMENT_SPLIT)) {
      const segment = raw.trim();
      const match = GEMINI_MODE.exec(segment);
      if (match) return { row, mode: match[1] === "auto-accept edits" ? "accept edits" : (match[1] ?? match[2]).toLowerCase() };
      if (GEMINI_DEFAULT_HINT.test(segment)) return { row };
    }
  }
  return null;
}

/**
 * OpenCode's live area (`opencode --mini`), for a tab whose label names it:
 * where the frame starts and what its status row says — or, when the last row
 * is not mini's, the full TUI's composer (`openCodeFullFrame`).
 *
 * The anchor is the status row — the agent's name in capitals — which OpenCode
 * keeps as the last non-blank row of every frame it draws. Above it sits the
 * input box: blank rows, or the box's own placeholder, or a draft typed on the
 * desktop. Only the first two are taken into the frame; a draft is left in the
 * reading view, the harmless direction, because the rows it occupies are
 * otherwise indistinguishable from the answer above them.
 *
 * The model is not on that row (except for the moment after a switch, when
 * OpenCode prints it as a notice), so it comes from the last turn footer
 * above the frame — `▣ Build · Muse Spark 1.3 Free · 6.2s`, the only place a
 * mini session prints the model's display name at all.
 */
function openCodeFrame(
  lines: readonly StatusLineLike[],
  agentLabel?: string,
): { start: number; status: SessionStatus } | null {
  if (!isOpenCodeTab(agentLabel)) return null;
  let index = lines.length - 1;
  while (index >= 0 && !lines[index].text.trim()) index -= 1;
  if (index < 0 || index < lines.length - SEARCH_WINDOW) return null;
  const row = openCodeStatusRow(lines[index].text);
  if (!row) return openCodeFullFrame(lines, index);
  let start = index;
  while (start > 0) {
    const above = lines[start - 1].text;
    if (!above.trim() || isOpenCodePlaceholder(above)) start -= 1;
    else break;
  }
  const status: SessionStatus = { mode: row.mode };
  if (row.context) status.context = row.context;
  if (row.model) status.model = row.model;
  if (!status.model) {
    for (let above = start - 1; above >= 0; above -= 1) {
      const footer = openCodeTurnFooter(lines[above].text);
      if (!footer) continue;
      if (footer.model) status.model = footer.model;
      break;
    }
  }
  return { start, status };
}

/**
 * The full TUI's composer, whose last row is `footer`: the agent row in the
 * box right above it (only its bottom edge between them, which
 * `readableScreen` drops), and above that the box's blank rows and its
 * placeholder. A draft is left in the reading view, as `--mini`'s is.
 *
 * The agent row is the agent, model and variant (`Build · Muse Spark 1.3
 * Free · high`), the footer the context the session holds. The working hint
 * on the footer is `agentBusy`'s to read.
 */
function openCodeFullFrame(
  lines: readonly StatusLineLike[],
  footer: number,
): { start: number; status: SessionStatus } | null {
  const facts = openCodeFullFooter(lines[footer].text);
  if (!facts) return null;
  let index = footer - 1;
  while (index >= 0 && index >= footer - 2 && !lines[index].text.trim()) index -= 1;
  if (index < 0 || index < footer - 2) return null;
  const composer = openCodeComposer(lines[index]);
  if (!composer) return null;
  let start = index;
  while (start > 0) {
    const above = lines[start - 1].text;
    if (!above.trim() || isOpenCodePlaceholder(above)) start -= 1;
    else break;
  }
  const status: SessionStatus = {};
  if (composer.mode) status.mode = composer.mode;
  if (composer.model) status.model = composer.model;
  if (composer.variant) status.effort = composer.variant;
  if (facts.context) status.context = facts.context;
  return { start, status };
}

/**
 * Google Antigravity's frame, for a tab whose label names it: the footer it
 * keeps under its input box — `? for shortcuts` on the left, the model and its
 * reasoning effort right-aligned — and, while `/model` has a dialog open,
 * where that dialog begins.
 *
 * Both are here because Antigravity is read like no other family. Its footer
 * prints the model as a *phrase* (`Gemini 3.8 Flash · high`), which `classify`
 * read as the token "Gemini" with the rest dropped. And it draws the `/model`
 * dialog *under* the box, with its highlight marked by the same `>` the box
 * uses, so the input line the ordinary scan finds while one is open is a model
 * row — with the dialog's own rows read as the status beneath it. The frame
 * therefore starts at the box above the dialog, and everything below it is the
 * dialog the model sheet is already showing.
 */
function antigravityFrame(
  lines: readonly StatusLineLike[],
  agentLabel?: string,
): { start?: number; footer: number; status: SessionStatus } | null {
  if (!isAntigravityTab(agentLabel)) return null;
  let index = lines.length - 1;
  while (index >= 0 && !lines[index].text.trim()) index -= 1;
  if (index < 0) return null;
  const footer = antigravityFooter(lines[index].text);
  if (!footer) return null;
  const status: SessionStatus = { model: footer.model };
  if (footer.effort) status.effort = footer.effort;
  const picker = readAntigravityPicker(lines);
  return { ...(picker ? { start: picker.frameStart } : {}), footer: index, status };
}

/**
 * The status the session is showing right now, or `null` when the bottom of
 * the screen is not a TUI input frame (mid-scroll output, a full-screen
 * dialog, a shell).
 */
export function sessionStatus(
  lines: readonly StatusLineLike[],
  agentLabel?: string,
): SessionStatus | null {
  const mini = openCodeFrame(lines, agentLabel);
  if (mini) return mini.status;
  const antigravity = antigravityFrame(lines, agentLabel);
  if (antigravity) return antigravity.status;
  let inputIndex = -1;
  for (let index = lines.length - 1; index >= 0 && index >= lines.length - SEARCH_WINDOW; index -= 1) {
    if (isInputLine(lines, index)) {
      inputIndex = index;
      break;
    }
  }
  if (inputIndex < 0) return null;
  const status: SessionStatus = {};
  let read = 0;
  for (let index = inputIndex + 1; index < lines.length && read < MAX_STATUS_LINES; index += 1) {
    const text = lines[index].text.trim();
    if (!text) continue;
    read += 1;
    for (const segment of text.split(SEGMENT_SPLIT)) classify(segment.trim(), status);
  }
  // Claude Code prints its goal at the right end of its last footer row, under
  // a custom statusline that can wrap to several rows on a narrow pane — past
  // the rows read above. The phrase is only ever the footer's, so every row of
  // the frame is looked through for it.
  for (let index = inputIndex + 1; !status.goal && index < lines.length; index += 1) {
    if (lines[index].text.split(SEGMENT_SPLIT).some((segment) => GOAL_ACTIVE.test(segment.trim()))) status.goal = true;
  }
  if (!status.mode) {
    const mode = geminiIndicatorAbove(lines, inputIndex)?.mode;
    if (mode) status.mode = mode;
  }
  if (!status.mode) status.mode = codexUpdatedMode(lines, inputIndex, agentLabel);
  return status;
}

/** A path shortened for a chip-width readout: the last two components, with
 * the home prefix kept as `~`. The full path belongs in the title attribute. */
export function shortenPath(path: string): string {
  const parts = path.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

/** A numbered dialog row (`❯ 1. Yes`), which opens with the same marker as the
 * input line. It is a question waiting for an answer, never the composer —
 * and so is a multi-select question's unnumbered `❯ Submit` (`isActionRow`)
 * and the highlighted row of an unnumbered dialog (`isUnnumberedRow`). */
const OPTION_ROW = /^\s*[>›❯*]\s*\d{1,2}[.)]\s/u;

/** The rule an agent draws across the top of its input box, with the project
 * or model name sitting in it (`──────── my-project ─`). `readableScreen`
 * drops the strokes but preserves the original in `frameText`, so the input
 * frame can still be distinguished from an ordinary output line. */
function labelledRule(text: string) {
  if (!/[─―—]{8,}/u.test(text)) return false;
  const rest = text.replace(/[\s─―—-]+/gu, "");
  return rest.length > 0 && rest.length <= 32;
}

/**
 * Where the frame an agent TUI pins to the bottom of every screen begins — its
 * input box and the status/shortcut lines under it — or `lines.length` when the
 * bottom of the screen is not one.
 *
 * The reading view cuts there. Nothing is lost: the composer below *is* that
 * input box, `sessionStatus` reads the same lines into the chips beside it, and
 * the shortcut hints name keys a phone has no way to press. Painted as well,
 * they only pushed the output the reader came for off the top of the screen.
 *
 * The scoping is `sessionStatus`'s, plus one guard: a select dialog's rows open
 * with the same marker as the input line, and hiding a question the session is
 * waiting on would be the one unrecoverable mistake here.
 */
export function inputFrameStart(
  lines: readonly StatusLineLike[],
  agentLabel?: string,
): number {
  const mini = openCodeFrame(lines, agentLabel);
  if (mini) return mini.start;
  // Antigravity's picker is drawn under the box: the frame is both, and the
  // sheet is already showing its rows. Without one the ordinary scan below
  // finds the box on its own.
  const antigravity = antigravityFrame(lines, agentLabel);
  let start = antigravity?.start ?? -1;
  for (let index = lines.length - 1; start < 0 && index >= 0 && index >= lines.length - SEARCH_WINDOW; index -= 1) {
    const text = lines[index].text;
    if (!isInputLine(lines, index)) continue;
    if (OPTION_ROW.test(text) || isActionRow(lines, index) || isUnnumberedRow(lines, index)) return lines.length;
    start = index;
  }
  if (start < 0) return lines.length;
  // Gemini CLI draws its mode on a row over the box; it is the frame's too.
  const indicator = geminiIndicatorAbove(lines, start);
  if (indicator) start = indicator.row;
  // The box's own top edge and the blank rows the TUI keeps above it belong to
  // the frame; left behind they would trail the output with a rule and a gap.
  while (start > 0) {
    const above = lines[start - 1].frameText ?? lines[start - 1].text;
    if (!above.trim() || labelledRule(above)) start -= 1;
    else break;
  }
  return start;
}

/** Hints the CLIs print under the box: keys and glyphs no draft is made of.
 * Only asked whether a row ends a draft — never used to drop one. */
const FOOTER_HINT = /\?\s*for shortcuts|shift\s*\+\s*tab|\besc to\b|\bctrl\s*\+|[⏎⌃⏵⏸]/iu;
/** A row of frame strokes and nothing else. `readableScreen` has already
 * dropped these; a caller handing in raw rows still gets the edge skipped. */
const STROKES_ONLY = /^[\s─-╿▀-▟―—]+$/u;

/**
 * How many of the fields `sessionStatus` reports one row carries.
 *
 * Fields, not columns: one segment can yield *two* of them, because `classify`
 * reads a branch out of the same segment as the path it follows
 * (`~/projects/app (main)`). Counting fields to recognize a columned row
 * therefore scored an ordinary sentence naming a path two, which is why
 * [`statusColumns`] exists and this is left to the callers that want a plain
 * "does this row carry any status at all".
 */
export function statusFieldCount(text: string): number {
  const found: SessionStatus = {};
  for (const segment of text.trim().split(SEGMENT_SPLIT)) classify(segment.trim(), found);
  return Object.keys(found).length;
}

/** How many of a row's columns carry a field `sessionStatus` reports.
 *
 * This is the question "is this row *columned*" — the path, model and context
 * a TUI prints under its box — asked so that a sentence of output cannot
 * answer it. A prompt or an answer is one segment however many fields can be
 * read out of it (`~/tabtivity/projects/app (main)`, `Running /usr/bin/foo
 * (again) now`); Gemini's under-box row is four (`~/proj  main
 * gemini-2.5-pro  25% used`). Two or more columns is a status row. */
export function statusColumns(text: string): number {
  let columns = 0;
  const found: SessionStatus = {};
  for (const segment of text.trim().split(SEGMENT_SPLIT)) {
    const before = Object.keys(found).length;
    classify(segment.trim(), found);
    if (Object.keys(found).length > before) columns += 1;
  }
  return columns;
}

/** How many columns a row is printed in at all, status or not — what tells a
 * TUI's columned key-hint footer (`⏎ send   ⇧⏎ newline   ⌃C quit`) from a
 * sentence that opens with the same key. */
export function columnCount(text: string): number {
  return text.trim().split(SEGMENT_SPLIT).filter((s) => s.trim() !== "").length;
}

/** Whether a row reads as a footer rather than as a draft's next line. */
function readsAsStatus(text: string) {
  return FOOTER_HINT.test(text) || statusFieldCount(text) > 0;
}

/**
 * The status rows an agent TUI draws under its input box, as painted text —
 * what the Focus view's status strip shows when the reader swipes for it.
 *
 * `inputFrameStart` hides the whole bottom frame, and `sessionStatus` only
 * reports the fields it recognizes, so a custom statusline (a cost, a clock, an
 * emoji per segment) had no way onto the phone at all. This hands the rows over
 * verbatim instead: nothing is classified, only *located*, with the scoping
 * `inputFrameStart` uses — the bottom window, the input line, and the option-row
 * guard, since rows under a select dialog are its answers, not a status.
 *
 * What sits between the input line and the status is skipped. The box's edges
 * are gone already (`readableScreen` drops a stroke-only row outright and keeps
 * a labelled one only as `frameText`), so the one thing that still looks like
 * text is a draft typed on the desktop that runs over several lines. Nothing
 * marks where it stops but its indent — a continuation sits under the draft's
 * first character — and that alone is not enough, because Claude Code indents
 * its footer by the same two columns. So a row ends the draft as soon as it
 * reads as a footer (a key hint, or a field `sessionStatus` would report), and
 * a blank row ends it too (Codex pads its composer). The failure left is a
 * draft line that happens to name a model or a path, which is shown in the
 * strip — the harmless direction, where hiding a status row would not be.
 *
 * Blank rows are dropped entirely: a strip has no use for gaps. No frame, `[]`.
 */
export function statusFrameLines(
  lines: readonly StatusLineLike[],
  agentLabel?: string,
): string[] {
  const mini = openCodeFrame(lines, agentLabel);
  if (mini) {
    // The frame is the box and the one status row under it; the box's blanks
    // and its placeholder are not a status.
    return lines.slice(mini.start)
      .map((line) => line.text.replace(/\s+$/u, ""))
      .filter((text) => text.trim() !== "" && !isOpenCodePlaceholder(text));
  }
  const antigravity = antigravityFrame(lines, agentLabel);
  if (antigravity?.start !== undefined) {
    // The rows under the box are the `/model` dialog's, not a status: the strip
    // shows the one row the session keeps under it either way.
    return [lines[antigravity.footer].text.replace(/\s+$/u, "")];
  }
  let inputIndex = -1;
  for (let index = lines.length - 1; index >= 0 && index >= lines.length - SEARCH_WINDOW; index -= 1) {
    const text = lines[index].text;
    if (!isInputLine(lines, index)) continue;
    if (OPTION_ROW.test(text) || isActionRow(lines, index) || isUnnumberedRow(lines, index)) return [];
    inputIndex = index;
    break;
  }
  if (inputIndex < 0) return [];

  const input = lines[inputIndex].text;
  const column = /^\s*[>›❯*]\s*/u.exec(input)?.[0].length ?? 0;
  let index = inputIndex + 1;
  if (input.slice(column).trim()) {
    // Only a draft with text on its first line can have a second one.
    for (; index < lines.length; index += 1) {
      const { text, frameText } = lines[index];
      if (!text.trim() || frameText !== undefined) break;
      if (text.length - text.trimStart().length < column || readsAsStatus(text)) break;
    }
  }

  const rows: string[] = [];
  for (; index < lines.length; index += 1) {
    const { text, frameText } = lines[index];
    const row = text.replace(/\s+$/u, "");
    if (!row.trim() || STROKES_ONLY.test(row)) continue;
    // A labelled rule directly under the box is its bottom edge; one further
    // down is the TUI's own divider, and its label is part of the status.
    if (rows.length === 0 && frameText !== undefined && labelledRule(frameText)) continue;
    rows.push(row);
  }
  return rows;
}
