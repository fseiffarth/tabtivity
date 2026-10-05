//! To-do board routing — the backend twin of `src/lib/todoBoard.ts`.
//!
//! `schema::calendar::normalize` keeps the *records* consistent (a done card
//! sits in Done, an unplaced one in the intake column) and is deliberately
//! time-independent. Where a card is **shown** also depends on today's date:
//! the Overdue and Today columns are a readout of `due`, and that routing lives
//! in the frontend's `columnOf`. The Mobile sidecar publishes the board with no
//! window open (headless owner plan, H0), so the same rules live here, branch
//! for branch, with the frontend's tests ported.

use crate::schema::calendar::{CalendarTask, TaskColumn};

/// `boardColumns`: the columns to render — the store's, or the defaults while
/// it has none — by position, ties broken by id.
pub fn board_columns(stored: &[TaskColumn]) -> Vec<TaskColumn> {
    let mut columns = if stored.is_empty() { TaskColumn::default_set() } else { stored.to_vec() };
    columns.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.id.cmp(&b.id)));
    columns
}

fn done_column_id(columns: &[TaskColumn]) -> Option<&str> {
    columns.iter().find(|c| c.done).map(|c| c.id.as_str())
}

fn overdue_column_id(columns: &[TaskColumn]) -> Option<&str> {
    columns.iter().find(|c| c.overdue).map(|c| c.id.as_str())
}

fn today_column_id(columns: &[TaskColumn]) -> Option<&str> {
    columns.iter().find(|c| c.due_today).map(|c| c.id.as_str())
}

/// `fallbackColumnId`: the column an unplaced card is shown in — the one
/// flagged `intake`, failing that the leftmost that is neither Done, an
/// archive nor date-governed, in the same order as `col_fallback`.
pub fn fallback_column_id(columns: &[TaskColumn]) -> String {
    columns
        .iter()
        .find(|c| c.intake)
        .or_else(|| columns.iter().find(|c| !c.done && !c.archived && !c.date_governed()))
        .or_else(|| columns.iter().find(|c| !c.done && !c.archived))
        .or_else(|| columns.first())
        .map(|c| c.id.clone())
        .unwrap_or_default()
}

/// `datePart` of a stamp.
fn date_part(stamp: &str) -> &str {
    stamp.split('T').next().unwrap_or(stamp)
}

fn time_part(stamp: &str) -> &str {
    stamp.split('T').nth(1).unwrap_or("")
}

/// `isOverdue`: a bare date compares days; on the deadline's own day only an
/// hour deadline read against a clock can be late, and strictly so.
pub fn is_overdue(task: &CalendarTask, now: &str) -> bool {
    let Some(due) = task.due.as_deref().filter(|d| !d.is_empty()) else {
        return false;
    };
    if task.percent >= 100 {
        return false;
    }
    let day = date_part(due);
    let today = date_part(now);
    if day != today {
        return day < today;
    }
    let deadline = time_part(due);
    let clock = time_part(now);
    !deadline.is_empty() && !clock.is_empty() && deadline < clock
}

/// `columnOf`: which column a card is shown in — an archive it names wins,
/// then completion, then an absent/unknown column falls to intake, then the
/// column it names, and finally the deadline for the three columns a deadline
/// governs. `today` is `"YYYY-MM-DD"` (or a full stamp for an hour deadline).
pub fn column_of(task: &CalendarTask, columns: &[TaskColumn], today: &str) -> String {
    let named = task.column.as_str();
    if !named.is_empty() && columns.iter().any(|c| c.id == named && c.archived) {
        return named.to_string();
    }
    let done = done_column_id(columns);
    if task.percent >= 100 {
        if let Some(done) = done {
            return done.to_string();
        }
    }
    let column = if named.is_empty() || !columns.iter().any(|c| c.id == named) {
        fallback_column_id(columns)
    } else if done == Some(named) && task.percent < 100 {
        // A card that is not complete cannot sit in Done, however it was filed.
        fallback_column_id(columns)
    } else {
        named.to_string()
    };
    date_column(task, column, columns, today)
}

/// `dateColumn`: the deadline's say — between intake, Today and Overdue, a
/// card's place is what its `due` says today. A finished card is Done's
/// business; anything outside those three columns is left alone.
fn date_column(task: &CalendarTask, column: String, columns: &[TaskColumn], today: &str) -> String {
    if task.percent >= 100 {
        return column;
    }
    let fallback = fallback_column_id(columns);
    let overdue_col = overdue_column_id(columns);
    let today_col = today_column_id(columns);
    let governed = column == fallback || Some(column.as_str()) == overdue_col || Some(column.as_str()) == today_col;
    if !governed {
        return column;
    }
    if is_overdue(task, today) {
        return overdue_col.map(str::to_string).unwrap_or(column);
    }
    if task.due.as_deref().is_some_and(|due| date_part(due) == date_part(today)) {
        return today_col.map(str::to_string).unwrap_or(column);
    }
    if Some(column.as_str()) == overdue_col {
        fallback
    } else {
        column
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns() -> Vec<TaskColumn> {
        board_columns(&[])
    }

    fn task(column: &str, due: Option<&str>, percent: u8) -> CalendarTask {
        CalendarTask {
            id: "t".into(),
            title: "card".into(),
            column: column.into(),
            due: due.map(str::to_string),
            percent,
            ..Default::default()
        }
    }

    #[test]
    fn default_board_is_the_seeded_set_in_position_order() {
        let cols = columns();
        let ids: Vec<&str> = cols.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["overdue", "today", "doing", "backlog", "done", "archived"]);
        assert_eq!(fallback_column_id(&columns()), "backlog", "intake is flagged, not leftmost");
        let mut shuffled = columns();
        shuffled.reverse();
        assert_eq!(board_columns(&shuffled)[0].id, "overdue");
    }

    #[test]
    fn fallback_without_an_intake_flag_is_the_leftmost_open_column() {
        let mut cols = columns();
        for c in cols.iter_mut() {
            c.intake = false;
        }
        assert_eq!(fallback_column_id(&cols), "doing", "date-governed columns never take it");
    }

    #[test]
    fn overdue_is_day_granular_unless_both_sides_carry_a_clock() {
        assert!(is_overdue(&task("", Some("2026-07-07"), 0), "2026-07-08"));
        assert!(!is_overdue(&task("", Some("2026-07-08"), 0), "2026-07-08"));
        assert!(!is_overdue(&task("", Some("2026-07-08T09:00"), 0), "2026-07-08"), "no clock, not late");
        assert!(is_overdue(&task("", Some("2026-07-08T09:00"), 0), "2026-07-08T09:01"));
        assert!(!is_overdue(&task("", Some("2026-07-08T09:00"), 0), "2026-07-08T09:00"), "the deadline's minute is due-now");
        assert!(!is_overdue(&task("", Some("2026-07-01"), 100), "2026-07-08"), "done cards are never late");
        assert!(!is_overdue(&task("", None, 0), "2026-07-08"));
    }

    #[test]
    fn routing_order() {
        let cols = columns();
        let today = "2026-07-08";
        assert_eq!(column_of(&task("archived", Some("2026-07-01"), 100), &cols, today), "archived", "an archive outranks everything");
        assert_eq!(column_of(&task("doing", None, 100), &cols, today), "done", "completion wins");
        assert_eq!(column_of(&task("", None, 0), &cols, today), "backlog", "unplaced → intake");
        assert_eq!(column_of(&task("nope", None, 0), &cols, today), "backlog", "unknown → intake");
        assert_eq!(column_of(&task("done", None, 0), &cols, today), "backlog", "not complete cannot sit in Done");
        assert_eq!(column_of(&task("doing", Some("2026-07-01"), 0), &cols, today), "doing", "Doing is not date-governed");
        assert_eq!(column_of(&task("backlog", Some("2026-07-01"), 0), &cols, today), "overdue");
        assert_eq!(column_of(&task("backlog", Some("2026-07-08"), 0), &cols, today), "today");
        assert_eq!(column_of(&task("today", None, 0), &cols, today), "today", "a deliberate Today stays");
        assert_eq!(column_of(&task("overdue", Some("2026-07-20"), 0), &cols, today), "backlog", "Overdue cannot keep a future card");
        assert_eq!(column_of(&task("today", Some("2026-07-01"), 0), &cols, today), "overdue");
    }

    #[test]
    fn a_board_without_date_columns_leaves_cards_where_they_are() {
        let cols: Vec<TaskColumn> = columns().into_iter().filter(|c| !c.date_governed()).collect();
        assert_eq!(column_of(&task("backlog", Some("2026-07-01"), 0), &cols, "2026-07-08"), "backlog");
    }
}
