/**
 * GitHub Copilot CLI's status area (1.0.106 to 1.0.112), for a tab whose label
 * names it. Unlike Claude and Codex it splits its facts across *both sides* of
 * the input box, and `statusLine`'s generic reader (which only looks below the
 * `❯` and knows model *tokens*) read none of them. This is what the CLI draws,
 * after `readableScreen` has dropped the box's rules:
 *
 *    ~/work [⎇ develop] [#12] +0 -0        Run on: This computer ctrl+e change …
 *   ❯
 *    ← open sidebar · Interactive · Manual Approval · / commands · ? help      stub · (18%)
 *
 *   - Above the box, one space in: the directory, the branch (`[⎇ develop*%]`,
 *     git-prompt marks and all), and the items `/statusline` turns on — a pull
 *     request `[#12]`, `+0 -0` line counts, `user:` before the directory — with
 *     a right column (`Run on: …` on a fresh session, quota, sandbox, YOLO,
 *     schedules). A narrow pane wraps it item by item onto up to three rows.
 *     The rows are one space in, where an answer's rows are three (` ● `,
 *     `   `) and an echoed prompt's start ` ❯ `; that indent, and the box's
 *     own `❯` in column 0, are what keep an output row from reading as status.
 *   - Below it, the footer: hints joined by ` · ` and the model right-aligned.
 *     The hints open with the *execution* mode (`Interactive`, `Plan`,
 *     `Autopilot`: the Shift+Tab cycle, verified 1.0.112) and the *approval*
 *     setting that follows it (`Manual Approval`, `Assisted Permissions`,
 *     `Allow All`: `/permissions`, not on that cycle). While a turn runs the
 *     hints are replaced by `○ Working · 49 B ctrl+c interrupt` and name no mode.
 *   - The model's column is `[agent · ]model[ · effort][ · (N%)]`: the effort
 *     and the context *used* are `/statusline` items (`effort`, `context-used`),
 *     off by default. `(N%)` is flipped to the context left, as everywhere.
 *
 * `mode` is the Shift+Tab one, because that is what the phone's chip walks;
 * the approval setting is read too (`approval`) for whoever shows it.
 */

export interface CopilotLine {
  text: string;
}

/** The registry's label for the CLI is "Copilot". */
const AGENT = /copilot/iu;

export function isCopilotTab(agentLabel?: string): boolean {
  return agentLabel !== undefined && AGENT.test(agentLabel);
}

export interface CopilotFooter {
  /** `interactive`, `plan` or `autopilot`, lower-cased; absent while a turn runs. */
  mode?: string;
  /** The approval setting as printed (`Manual Approval`). */
  approval?: string;
  model?: string;
  /** Lower-cased (`medium`). */
  effort?: string;
  /** Context left, `82%`. */
  context?: string;
  /** The row is the working footer (`ctrl+c interrupt`). */
  working?: boolean;
}

const MODE = /^(interactive|plan|autopilot)$/iu;
/** The segment after the mode. Open-ended on purpose — the wording is the
 * CLI's (`Manual Approval`, `Assisted Permissions`, `Allow All`) — but it must
 * look like one, so a hint (`/ commands`) is never taken for it. */
const APPROVAL = /\b(?:approval|permissions|allow[- ]all|yolo|auto)\b/iu;
/** Hints a footer is made of, the working hint included. A row with none of
 * these is a dialog's or a notice's, not the footer. */
const HINT = /^(?:←\s*open sidebar|\/\s*comm\S*|\?\s*help|tab next tab|@\s*files\/sessions|#\s*issues|esc esc edit prompt)$/iu;
const WORKING = /\bctrl\+c interrupt\b|\besc esc edit prompt\b/iu;
const EFFORT = /^(none|minimal|low|medium|high|x-?high|extra[ -]high|max)$/iu;
/** `(42%)`, the context used. */
const CONTEXT_USED = /^\(\s*(\d{1,3}(?:\.\d+)?)\s?%\s*\)$/u;
/** A premium-request multiplier some model labels carry, `(1x)`. */
const MULTIPLIER = /^\(\s*[\d.]+x\s*\)$/iu;

/** Where the model's column starts in the footer, or -1. It is right-aligned,
 * so a gap of two spaces or more; a narrow pane leaves one, after a hint cut
 * to its ellipsis (`/ comma… claude-sonnet-4.5`) or a whole one. */
function modelColumn(text: string): { left: string; right: string } | null {
  const gap = /^(.*\S)\s{2,}(\S.*)$/u.exec(text);
  if (gap) return { left: gap[1], right: gap[2] };
  const cut = /^(.*…)\s+(\S.*)$/u.exec(text);
  if (cut) return { left: cut[1], right: cut[2] };
  const hint = /^(.*(?:\/ commands|\? help|tab next tab|# issues|ctrl\+c interrupt|esc esc edit prompt))\s+(\S.*)$/u.exec(text);
  return hint ? { left: hint[1], right: hint[2] } : null;
}

/** The context left from the figure used, one decimal kept. */
function left(used: string): string {
  return `${Math.round((100 - Math.min(100, Math.max(0, Number.parseFloat(used)))) * 10) / 10}%`;
}

/** The facts of Copilot's footer row, or `null` when `text` is not one. */
export function copilotFooter(text: string): CopilotFooter | null {
  const row = text.trim();
  if (!row) return null;
  const column = modelColumn(row);
  const leftSide = column?.left ?? row;
  const segments = leftSide.split(/\s·\s/u).map((segment) => segment.trim()).filter(Boolean);
  const facts: CopilotFooter = {};
  let known = false;
  segments.forEach((segment, index) => {
    if (MODE.test(segment)) {
      facts.mode = segment.toLowerCase();
      known = true;
      const next = segments[index + 1];
      if (next && APPROVAL.test(next)) facts.approval = next;
    } else if (WORKING.test(segment)) {
      facts.working = true;
      known = true;
    } else if (HINT.test(segment)) {
      known = true;
    }
  });
  // A hint cut by a narrow pane keeps its stem (`/ comma…`).
  if (!known && /…$/u.test(leftSide)) known = segments.some((segment) => /^[/?@#]|^tab\b|^←/u.test(segment));
  if (!known) return null;
  if (!column) return facts;
  const parts = column.right.split(/\s·\s/u).map((part) => part.trim()).filter(Boolean);
  const used = parts.length > 0 ? CONTEXT_USED.exec(parts[parts.length - 1]) : null;
  if (used) {
    facts.context = left(used[1]);
    parts.pop();
  }
  while (parts.length > 0 && MULTIPLIER.test(parts[parts.length - 1])) parts.pop();
  if (parts.length > 1 && EFFORT.test(parts[parts.length - 1])) facts.effort = parts.pop()!.toLowerCase();
  // What is left is `[agent · ]model`; the model is the last.
  const model = parts[parts.length - 1];
  if (model && !/^[(←/?@#]/u.test(model)) facts.model = model;
  return facts;
}

/** A path as the info rows print one, after the `user:` a username item adds. */
const PATH_ITEM = String.raw`(?:[\w.-]+:)?((?:~|…)(?:/\S*)?|/\S+|[A-Za-z]:\\\S+)`;
const BRANCH_ITEM = String.raw`\[⎇ ([^\]\s]+)\]`;
const PR_ITEM = String.raw`\[#\d+\]`;
const CHANGES_ITEM = String.raw`\+\d+ -\d+`;
const ITEM = `(?:${PATH_ITEM}|${BRANCH_ITEM}|${PR_ITEM}|${CHANGES_ITEM})`;
/** One info row: one space in, items separated by single spaces, then an
 * optional right column after a wider gap. */
const INFO_ROW = new RegExp(String.raw`^ (?=\S)(${ITEM}(?: ${ITEM})*)(?:\s{2,}(\S.*))?$`, "u");
/** The branch and the path inside a row's items, wherever they stand. */
const BRANCH_ONLY = new RegExp(BRANCH_ITEM, "u");
const PATH_ONLY = new RegExp(String.raw`(?:^| )${PATH_ITEM}(?= |$)`, "u");
/** A row that is only the right column, where a narrow pane wrapped it. */
const RIGHT_ONLY = /^ (?:Run on: |[\w ]+: \d+(?:\.\d+)?% used|sandbox\b|YOLO\b|\d+ scheduled\b)/u;

/** A branch without the marks git's prompt helpers append (`develop*%`): only
 * where a `*` or `%` is among them, since `+` and `$` can end a real name. */
function plainBranch(branch: string): string {
  const marks = /[*+%$#<>=]+$/u.exec(branch);
  return marks && /[*%]/u.test(marks[0]) ? branch.slice(0, marks.index) : branch;
}

export interface CopilotFrame {
  /** The first row of the frame: the info rows over the box, else the box. */
  start: number;
  status: {
    path?: string;
    branch?: string;
    model?: string;
    effort?: string;
    mode?: string;
    context?: string;
  };
  approval?: string;
  working?: boolean;
}

/** Non-blank rows looked back through from the footer for the box's `❯`: a
 * draft of a few lines sits between them. */
const BOX_REACH = 8;
/** Info rows over the box: path, branch, counts and the right column, each on
 * a row at the narrowest. */
const INFO_ROWS = 4;

/**
 * Copilot's live frame, for a tab whose label names it: the footer on the last
 * non-blank row, the box's `❯` above it, the info rows above that — or `null`
 * when the bottom of the screen is none of it (a dialog, a shell, another
 * tab's screen).
 */
export function readCopilotFrame(lines: readonly CopilotLine[], agentLabel?: string): CopilotFrame | null {
  if (!isCopilotTab(agentLabel)) return null;
  let footer = lines.length - 1;
  while (footer >= 0 && !lines[footer].text.trim()) footer -= 1;
  if (footer < 0) return null;
  const facts = copilotFooter(lines[footer].text);
  if (!facts) return null;
  let box = -1;
  let seen = 0;
  for (let index = footer - 1; index >= 0 && seen < BOX_REACH; index -= 1) {
    if (!lines[index].text.trim()) continue;
    seen += 1;
    if (/^❯(?:\s|$)/u.test(lines[index].text)) {
      box = index;
      break;
    }
  }
  if (box < 0) return null;
  const status: CopilotFrame["status"] = {};
  if (facts.mode) status.mode = facts.mode;
  if (facts.model) status.model = facts.model;
  if (facts.effort) status.effort = facts.effort;
  if (facts.context) status.context = facts.context;
  let start = box;
  for (let index = box - 1; index >= 0 && box - index <= INFO_ROWS; index -= 1) {
    const text = lines[index].text;
    const row = INFO_ROW.exec(text);
    if (!row && !RIGHT_ONLY.test(text)) break;
    if (row) {
      const branch = BRANCH_ONLY.exec(row[1]);
      if (branch) status.branch = plainBranch(branch[1]);
      const path = PATH_ONLY.exec(row[1]);
      if (path) status.path = path[1];
    }
    start = index;
  }
  // The blank rows the TUI keeps over its frame belong to it.
  while (start > 0 && !lines[start - 1].text.trim()) start -= 1;
  return {
    start,
    status,
    ...(facts.approval ? { approval: facts.approval } : {}),
    ...(facts.working ? { working: true } : {}),
  };
}
