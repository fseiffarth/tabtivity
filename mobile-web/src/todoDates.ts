import type { TodoBoard, TodoCard, TodoColumn } from "./api";
import type { TranslationKey } from "../../src/lib/i18n";

/**
 * The deadline's say in where a card can be filed — the phone's copy of the
 * desktop's `lib/todoBoard` routing, narrowed to the one question this screen
 * asks: *would the board keep the card if I put it there?*
 *
 * It is a copy because the two halves run in different processes. The desktop
 * bridge already refuses a move its own render would undo (`dropAccepted`), and
 * it is right to: it owns `calendar.json`. But a phone that cannot ask the
 * question first can only offer every column, send the one the board will not
 * take, and show the refusal as an error — which reads as a board that drops
 * writes. The rules are small, stated in one place here, and the desktop stays
 * the authority: if the two ever disagree, the refusal still stands.
 *
 * Day granularity, deliberately, exactly as `dateColumn` uses: an hour deadline
 * does not move a card into Overdue halfway through the afternoon it is due.
 */
export function localDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const flagged = (columns: TodoColumn[], flag: (column: TodoColumn) => boolean): string | null =>
  columns.find(flag)?.id ?? null;

/**
 * The column a card with no home belongs in — the desktop's `fallbackColumnId`,
 * over the wire.
 *
 * Not "the first open column" any more: the board leads with Overdue and Today,
 * whose contents are decided by a card's deadline rather than by anyone putting
 * something there, and the intake column sits behind Doing. The positional rule
 * is kept only as the fallback for an older desktop that sends no flag, where it
 * was the right answer.
 */
export function intakeColumn(columns: TodoColumn[]): string {
  const column = columns.find((entry) => entry.intake)
    ?? columns.find((entry) => !entry.done && !entry.archived && !entry.overdue && !entry.due_today)
    ?? columns.find((entry) => !entry.done && !entry.archived)
    ?? columns[0];
  return column?.id ?? "";
}

/** Late by a whole day: `isOverdue` read against a bare date, as `columnOf` reads it. */
function late(task: TodoCard, today: string): boolean {
  return !!task.due && !task.done && task.due.slice(0, 10) < today;
}

/**
 * Whether filing `task` in `columnId` would actually keep it there — the phone's
 * `dropAccepted`.
 *
 * Three refusals, all of them the board's own:
 *  - a card that is not complete cannot rest in Done (and a complete one is
 *    *shown* there whatever its column says, so nothing else accepts it);
 *  - a late card belongs in Overdue, a card due today in Today, and one that is
 *    neither cannot sit in Overdue;
 *  - an archive accepts anything: filing a card there is a decision that
 *    outranks both of the above.
 */
export function moveAccepted(
  task: TodoCard,
  columnId: string,
  columns: TodoColumn[],
  today: string = localDate(),
): boolean {
  const target = columns.find((column) => column.id === columnId);
  if (!target) return false;
  if (target.archived) return true;
  const done = flagged(columns, (column) => column.done);
  // Completion wins over placement: a finished card is Done's, an unfinished one
  // is not. Ticking and unticking is the ✓'s own action, never a move.
  if (task.done) return target.id === done;
  if (target.id === done) return false;
  const overdue = flagged(columns, (column) => column.overdue);
  const dueToday = flagged(columns, (column) => column.due_today);
  const intake = intakeColumn(columns);
  if (target.id !== overdue && target.id !== dueToday && target.id !== intake) return true;
  if (late(task, today)) return target.id === overdue;
  if (task.due && task.due.slice(0, 10) === today) return target.id === dueToday;
  // Neither late nor due today: Overdue would be a column that lies, but a
  // deliberate "I am doing this today" is a decision the date does not overrule.
  return target.id !== overdue;
}

/** The columns a card can actually be moved into, in board order. */
export function acceptedColumns(task: TodoCard, board: Pick<TodoBoard, "columns">, today: string = localDate()): TodoColumn[] {
  return board.columns.filter((column) => moveAccepted(task, column.id, board.columns, today));
}

/**
 * The desktop's refusal, said in words. `column_follows_date` is the wire code
 * and it is the last thing a reader on a phone should be shown — the sentence
 * also has to say what to do instead, because the deadline *is* the control for
 * those three columns. A key: the screen says it in the phone's language.
 */
export const COLUMN_FOLLOWS_DATE: TranslationKey = "mobile.todo.columnFollowsDate";
