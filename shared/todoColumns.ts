/**
 * Which column a card with no home belongs in — one rule for the desktop's
 * board (`lib/todoBoard`) and the phone's (`mobile-web/src/todoDates`), which
 * read the same column flags (`intake`, `done`, `archived`, `overdue`,
 * `due_today`) off the same board file.
 *
 * The column flagged `intake`, and failing that the leftmost that is neither
 * Done, nor an archive, nor date-governed (Overdue / Today). Mirrors the
 * backend's `col_fallback` exactly, including the order of its rules.
 *
 * The flag is what carries this. The old *leftmost open column* rule read the
 * intent off the layout, and the layout changed: with Overdue and Today leading
 * the board and Backlog behind Doing, "leftmost open" is **Doing**, and every
 * unplaced card would have been filed as work in progress. Neither date column
 * can be the fallback either — landing there is a statement about a deadline,
 * and a card with no home has made no such statement. The positional rule
 * survives only as the last resort for an older desktop that sends no flag.
 * An empty list answers `""`.
 */
export interface ColumnFlags {
  id: string;
  done?: boolean;
  archived?: boolean;
  intake?: boolean;
  overdue?: boolean;
  due_today?: boolean;
}

export function fallbackColumnId(columns: readonly ColumnFlags[]): string {
  const dateGoverned = (c: ColumnFlags) => !!c.overdue || !!c.due_today;
  return (
    columns.find((c) => c.intake) ??
    columns.find((c) => !c.done && !c.archived && !dateGoverned(c)) ??
    columns.find((c) => !c.done && !c.archived) ??
    columns[0]
  )?.id ?? "";
}
