/**
 * A message typed to a subagent the Reader has open, delivered the one way
 * Claude Code takes it: its own agent list under the input box. Probed on
 * 2.1.287 —
 *
 *   ↓ from the input box walks the footer: any pills first (`2 shells`),
 *     then the agent list, its cursor `❯` on a row;
 *   the list is `● main` and one row per agent (`◯ general-purpose  Alpha
 *     sleeper  6s · ↓ 24.1k tokens`), `●` marking the conversation viewed —
 *     but a row at work may print a summary of what it is doing instead of
 *     its description (`Writing numbers.py script`);
 *   Enter on a row views that agent: the box reads `Message @<type>…`, the
 *     rule above it is labelled with the description (`── Theta long ─`), and
 *     what is submitted goes to the agent — queued while it works, resuming
 *     it once it has finished;
 *   the footer keeps the keyboard after Enter, and there `x` stops the agent
 *     under the cursor — so Esc hands the keyboard back to the box before a
 *     single character is typed;
 *   Enter on `main` views the session again;
 *   a background subagent leaves the list once it has reported back, but
 *     `/tasks` still lists it for a while (`✔ Delta waiter   done · Haiku
 *     4.5`), and Enter there views it — back in the list — so it can be
 *     resumed too (on one still running, Enter opens its details instead).
 *     That dialog's `x` and `f` stop and foreground: never typed.
 *
 * Every step is read back off the screen before the next key goes in, and a
 * step that did not land stops the walk: the message is typed only once the
 * subagent is the one viewed, by the label over the box. Rows that may be it
 * — its description, or a summary on a row of its type — are viewed in turn
 * until the label names it. Esc is pressed only while the list's
 * cursor or the `/tasks` dialog is on screen — in the box it would stop a
 * turn.
 *
 * A foreground subagent leaves the list the moment it reports back and is in
 * no `/tasks` either: once done it cannot be written to.
 */

/** One row of Claude Code's agent list. */
export interface AgentListRow {
  /** The footer's cursor is on it. */
  cursor: boolean;
  /** Its conversation is the one viewed (`●`). */
  viewed: boolean;
  /** The session's own row. */
  main: boolean;
  /** Its `subagent_type`, as the row prints it. */
  kind: string;
  /** Its description, as the row prints it — cut with `…` when narrow. */
  task: string;
}

const ROW = /^(❯)?[\s│├└─]*([●◯])\s+(\S.*)$/u;

/** The text of the bottom `count` rows of an xterm buffer, as drawn. */
export function bufferRows(
  buffer: { length: number; getLine(row: number): { translateToString(trimRight?: boolean): string } | null | undefined },
  count = 40,
): string[] {
  const rows: string[] = [];
  for (let row = Math.max(0, buffer.length - count); row < buffer.length; row += 1) {
    rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  return rows;
}

/** The agent list at the bottom of the screen, `main` first; null when the
 * bottom of the screen is anything else (a dialog, a picker, no agents). */
export function readAgentList(rows: readonly string[]): AgentListRow[] | null {
  let end = rows.length;
  while (end > 0 && !rows[end - 1].trim()) end -= 1;
  const list: AgentListRow[] = [];
  for (let index = end - 1; index >= 0; index -= 1) {
    const match = ROW.exec(rows[index]);
    if (!match) return null;
    const rest = match[3].trimEnd();
    const row = { cursor: !!match[1], viewed: match[2] === "●" };
    if (rest === "main") {
      list.unshift({ ...row, main: true, kind: "", task: "" });
      return list;
    }
    const [kind = "", task = ""] = rest.split(/\s{2,}/u);
    list.unshift({ ...row, main: false, kind, task });
  }
  return null;
}

function words(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Whether a row's description `shown` — cut with `…` when narrow — is
 * `task`'s. */
function sameTask(shown: string, task: string): boolean {
  const row = words(shown);
  const whole = words(task);
  if (!row || !whole) return false;
  return row.endsWith("…") ? whole.startsWith(row.slice(0, -1).trimEnd()) : row === whole;
}

/** Whether `row` is the subagent sent to do `task` as a `role`. */
export function rowMatches(row: AgentListRow, target: { task: string; role?: string }): boolean {
  if (row.main || !sameTask(row.task, target.task)) return false;
  // A narrow row may cut the type too; a whole one has to agree.
  return !target.role || row.kind.endsWith("…") || row.kind === target.role;
}

/** One subagent row of the `/tasks` dialog: `❯ ● Epsilon writer   running ·
 * Haiku 4.5`, `✔ Delta waiter   done · Haiku 4.5`. It names no type. */
export interface TaskDialogRow {
  cursor: boolean;
  task: string;
}

const TASKS_HINT = /Enter to view\b.*\bEsc to close/u;
/** The last row `/tasks` draws, over its list or a task's details
 * (`Esc/Enter/Space to close`). */
const TASKS_CLOSE = /\bEsc\b\S*\s+to close\b/u;
const TASK_ROW = /^\s*(❯)?\s*[^\p{L}\p{N}\s]\s+(\S.*?)(?:\s{2,}\S.*)?$/u;
const RULE = /^\s*─{3,}/u;

/**
 * The `/tasks` dialog at the bottom of the screen, its subagent rows in order;
 * null when the bottom is anything else. It lists the background subagents —
 * the running ones and those that finished — which the agent list under the
 * box drops once they have reported back. Its section titles (`Background`,
 * `Completed (1)`) are not rows.
 */
export function readTasksDialog(rows: readonly string[]): TaskDialogRow[] | null {
  let end = rows.length;
  while (end > 0 && !rows[end - 1].trim()) end -= 1;
  if (end === 0 || !TASKS_HINT.test(rows[end - 1])) return null;
  const found: TaskDialogRow[] = [];
  for (let index = end - 2; index >= 0 && !RULE.test(rows[index]); index -= 1) {
    const match = TASK_ROW.exec(rows[index]);
    if (match) found.unshift({ cursor: !!match[1], task: match[2] });
  }
  return found;
}

/** Whether `/tasks` — its list or a task's details — is at the bottom of the
 * screen. */
function tasksShown(rows: readonly string[]): boolean {
  let end = rows.length;
  while (end > 0 && !rows[end - 1].trim()) end -= 1;
  return end > 0 && TASKS_CLOSE.test(rows[end - 1]);
}

/** The label on the rule over the input box — the description of the
 * subagent viewed — or null when the box is not there; empty while the
 * session itself is viewed. */
export function viewLabel(rows: readonly string[]): string | null {
  const from = Math.max(1, rows.length - 30);
  for (let index = rows.length - 2; index >= from; index -= 1) {
    if (!rows[index].startsWith("❯") || !RULE.test(rows[index - 1]) || !RULE.test(rows[index + 1])) continue;
    return /^\s*─+\s+(\S.*?)\s+─+\s*$/u.exec(rows[index - 1])?.[1] ?? "";
  }
  return null;
}

/** The input box idle at the bottom of the screen: its `❯` line between the
 * rules that frame it, a dialog or picker nowhere in place of it. */
export function inputBoxShown(rows: readonly string[]): boolean {
  return viewLabel(rows) !== null;
}

export type SubagentSendFailure =
  /** Neither Claude's agent list nor its `/tasks` has a row for it. */
  | "not_listed"
  /** More than one row reads the same. */
  | "ambiguous"
  /** The walk to the row, or viewing it, did not land; or the screen was
   * not the input box to begin with. */
  | "not_opened"
  /** The message did not go in. */
  | "send_failed";

export type SubagentSendResult =
  | { ok: true; /** The session is viewed again afterwards. */ backToMain: boolean }
  | { ok: false; reason: SubagentSendFailure };

/** What the walk drives: the pane's screen and keyboard. */
export interface SubagentDriver {
  /** The screen's rows as drawn now (`bufferRows`). */
  rows(): readonly string[];
  /** One key press; false when it did not go. */
  key(key: string): Promise<boolean>;
  /** A slash command typed into the box and submitted (`/tasks`). */
  command(text: string): Promise<boolean>;
  /** The message, typed as any prompt is — line reset, text, submit — once
   * its last write is out; false when it did not go in. */
  type(): Promise<boolean>;
}

export interface SubagentWalkTiming {
  /** How long a key is given to show on screen. */
  waitMs: number;
  /** How often the screen is read meanwhile. */
  pollMs: number;
}

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ENTER = "\r";
const ESCAPE = "\u001b";
/** Pills ↓ may cross before the list: shells, workflows, the bridge, …. */
const MAX_PILLS = 6;
const TIMING: SubagentWalkTiming = { waitMs: 1500, pollMs: 60 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends the driver's message to the subagent `target` names (its description
 * and type, as the transcript's agent entry holds them), then views the
 * session again. Nothing is typed unless that subagent's row is the one
 * viewed. One the agent list no longer holds is opened from `/tasks`.
 */
export async function sendToSubagent(
  driver: SubagentDriver,
  target: { task: string; role?: string },
  timing: SubagentWalkTiming = TIMING,
): Promise<SubagentSendResult> {
  const list = () => readAgentList(driver.rows());
  const cursorAt = (rows: { cursor: boolean }[] | null) => rows?.findIndex((row) => row.cursor) ?? -1;
  /** Reads the screen with `read` until `done` holds or the wait is over. */
  const until = async <T>(read: () => T, done: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + timing.waitMs;
    for (;;) {
      const value = read();
      if (done(value) || Date.now() >= deadline) return value;
      await sleep(timing.pollMs);
    }
  };
  /** The one index `matches` finds in `rows`, else -1. */
  const only = <T>(rows: T[], matches: (row: T) => boolean) => {
    const found = rows.flatMap((row, index) => (matches(row) ? [index] : []));
    return found.length === 1 ? found[0] : -1;
  };
  /** The cursor of the rows `read` finds onto the one `pick` names; null
   * when it did not get there. */
  const walk = async <T extends { cursor: boolean }>(read: () => T[] | null, pick: (rows: T[]) => number): Promise<T[] | null> => {
    let rows = read();
    for (let step = 0; rows; step += 1) {
      const at = cursorAt(rows);
      const wanted = pick(rows);
      if (at < 0 || wanted < 0 || step > rows.length * 2) return null;
      if (at === wanted) return rows;
      if (!(await driver.key(wanted > at ? DOWN : UP))) return null;
      rows = await until(read, (next) => cursorAt(next) !== at);
    }
    return null;
  };
  /** ↓ until the list's cursor shows; the pills crossed are walked back with
   * ↑ when it never does, or the list goes. */
  const enterList = async (): Promise<AgentListRow[] | null> => {
    let rows = list();
    for (let downs = 0; rows && cursorAt(rows) < 0; downs += 1) {
      const before = driver.rows().join("\n");
      if (downs === MAX_PILLS || !(await driver.key(DOWN))) {
        rows = null;
        for (let up = 0; up < downs; up += 1) await driver.key(UP);
        break;
      }
      rows = await until(list, (next) => cursorAt(next) >= 0 || driver.rows().join("\n") !== before);
    }
    return rows;
  };
  /** Whether the list shows the row `pick` names as the one viewed. */
  const viewing = (rows: AgentListRow[] | null, pick: (rows: AgentListRow[]) => number) => {
    const index = rows ? pick(rows) : -1;
    return index >= 0 && !!rows?.[index].viewed;
  };
  /** The list's row `pick` names viewed: walked to, then Enter. */
  const view = async (pick: (rows: AgentListRow[]) => number): Promise<boolean> => {
    if (!(await enterList())) return false;
    const rows = await walk(list, pick);
    if (!rows) return false;
    if (viewing(rows, pick)) return true;
    if (!(await driver.key(ENTER))) return false;
    return viewing(await until(list, (next) => viewing(next, pick)), pick);
  };
  /** Esc while the list holds the keyboard, which goes back to the box; true
   * once the box has it. In the box itself Esc would stop a turn. */
  const leaveList = async (): Promise<boolean> => {
    if (cursorAt(list()) < 0) return true;
    if (!(await driver.key(ESCAPE))) return false;
    return cursorAt(await until(list, (next) => cursorAt(next) < 0)) < 0;
  };
  /** Esc while `/tasks` — its list, or a task's details — is up, which
   * closes it. */
  const closeTasks = async () => {
    for (let tries = 0; tries < 2 && tasksShown(driver.rows()); tries += 1) {
      if (!(await driver.key(ESCAPE))) return;
      await until(driver.rows, (rows) => !tasksShown(rows));
    }
  };
  const tasks = () => readTasksDialog(driver.rows());
  const pickTask = (rows: TaskDialogRow[]) => only(rows, (row) => sameTask(row.task, target.task));
  /** The subagent opened from `/tasks`: its row walked to, then Enter, which
   * closes the dialog onto the subagent's view. */
  const openFromTasks = async (): Promise<SubagentSendFailure | null> => {
    if (!inputBoxShown(driver.rows()) || !(await driver.command("/tasks"))) return "not_opened";
    const dialog = await until(tasks, (rows) => rows !== null);
    if (!dialog) return "not_opened";
    const matching = dialog.filter((row) => sameTask(row.task, target.task)).length;
    if (matching !== 1) {
      await closeTasks();
      return matching ? "ambiguous" : "not_listed";
    }
    if (!(await walk(tasks, pickTask)) || !(await driver.key(ENTER))) {
      await closeTasks();
      return "not_opened";
    }
    const label = await until(() => viewLabel(driver.rows()), (next) => next !== null && sameTask(next, target.task));
    if (label !== null && sameTask(label, target.task)) return null;
    // One still at work opened its details, not its conversation.
    await closeTasks();
    return "not_opened";
  };

  /** Whether the view now is the target's, by the label over the box — by
   * its row when no label can be read. */
  const isTarget = (label: string | null, row: AgentListRow) => (label === null ? rowMatches(row, target) : sameTask(label, target.task));
  /** The target viewed from the agent list: the rows that may be it viewed
   * in turn — those that read as it first, then the summaries of its type —
   * until the label names it. "missing" when none did, the session viewed
   * again and the keyboard back in the box. */
  const fromList = async (): Promise<"viewed" | "missing" | "failed"> => {
    const first = list();
    if (!first) return "missing";
    const size = first.length;
    const exact = first.flatMap((row, index) => (rowMatches(row, target) ? [index] : []));
    const typed = first.flatMap((row, index) => (!row.main && !exact.includes(index)
      && (!target.role || row.kind === target.role || row.kind.endsWith("…")) ? [index] : []));
    if (exact.length + typed.length === 0) return "missing";
    if (!(await enterList())) return "failed";
    for (const index of [...exact, ...typed]) {
      // A row that came or went moves every index: start over another time.
      const pick = (rows: AgentListRow[]) => (rows.length === size ? index : -1);
      const rows = await walk(list, pick);
      if (!rows) return "failed";
      const before = viewLabel(driver.rows());
      if (!rows[index].viewed) {
        if (!(await driver.key(ENTER))) return "failed";
        if (!viewing(await until(list, (next) => viewing(next, pick)), pick)) return "failed";
      }
      const label = await until(() => viewLabel(driver.rows()), (next) => next !== before || isTarget(next, rows[index]));
      if (isTarget(label, rows[index])) return "viewed";
    }
    const main = await view((rows) => rows.findIndex((row) => row.main));
    return main && (await leaveList()) ? "missing" : "failed";
  };

  const first = list();
  if (first && first.filter((row) => rowMatches(row, target)).length > 1) return { ok: false, reason: "ambiguous" };
  const listed = await fromList();
  if (listed === "failed") {
    await leaveList();
    return { ok: false, reason: "not_opened" };
  }
  if (listed === "missing") {
    const failed = await openFromTasks();
    if (failed) return { ok: false, reason: failed };
  }
  if (!(await leaveList())) return { ok: false, reason: "not_opened" };
  if (!(await driver.type())) return { ok: false, reason: "send_failed" };

  // Back to the session, so what is typed next — here or in the terminal —
  // goes where it did before. A subagent that left the list took the view
  // back with it; with no list on screen ↓ and ↑ would walk the box's history.
  await sleep(timing.waitMs / 3);
  const after = list();
  if (!after) return { ok: true, backToMain: false };
  if (after[0].viewed) return { ok: true, backToMain: true };
  const main = await view((rows) => rows.findIndex((row) => row.main));
  const left = await leaveList();
  return { ok: true, backToMain: main && left };
}
