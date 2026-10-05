//! The phone's to-do board and calendar writes with no window open
//! (headless owner plan, H3): the Rust twin of `MobileBridgeHost.tsx`'s
//! `todoMutate` and `calendarMutate`, over the CAS cores of
//! `commands::calendar` (`transact`, H0) and the board rules of
//! `services::todo_board`. Every write is one compare-and-swap transaction on
//! `calendar.json`, so a window that opens meanwhile merges rather than
//! loses it.
//!
//! What stays behind the window, on purpose: an event or calendar backed by
//! CalDAV. The desktop pushes a calendar write to its server from the write
//! itself (`docs/context/caldav.md`, "Push"), not by diffing the file, so an
//! edit made here would sit in `calendar.json` unpushed and be overwritten by
//! the next sync. Those calendars answer `calendar_unavailable`.

use std::collections::HashSet;
use std::path::Path;

use chrono::Local;

use super::discovery::key_id;
use super::protocol::{CalendarAction, MobileCalendarEventInput, TodoAction, TodoTaskInput};
use crate::commands::calendar as cal;
use crate::schema::calendar::{Calendar, CalendarData, CalendarEvent, CalendarTask, Subtask, TaskColumn};
use crate::services::todo_board::{board_columns, column_of, fallback_column_id};

/// `RANK_STEP` (`lib/todoBoard.ts`): the gap a card placed above the top one
/// takes.
const RANK_STEP: f64 = 1024.0;

/// A refused write, as the desktop bridge's error codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub &'static str);

fn calendar_path(state_dir: &Path) -> std::path::PathBuf {
    state_dir.join("calendar.json")
}

/// `toStamp(new Date())`: the local wall clock as `YYYY-MM-DDTHH:MM`.
fn now_stamp() -> String {
    Local::now().format("%Y-%m-%dT%H:%M").to_string()
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Resolve one opaque id the phone echoed back against the records that
/// issued it: the record whose derived id matches, or none.
fn resolve<'a, T>(host_key: &[u8], domain: &str, opaque: &str, rows: &'a [T], id_of: impl Fn(&T) -> &str) -> Option<&'a T> {
    rows.iter().find(|row| key_id(host_key, domain, &[id_of(row)]) == opaque)
}

fn task_by_opaque<'a>(host_key: &[u8], data: &'a CalendarData, opaque: &str) -> Option<&'a CalendarTask> {
    resolve(host_key, "task", opaque, &data.tasks, |t| t.id.as_str())
}

/// `mintSubtaskId`: `<task id>-s<n>`, the first `n` from the count up that is
/// free.
fn mint_subtask_id(task_id: &str, taken: &HashSet<String>, start: usize) -> String {
    let mut n = start;
    loop {
        let id = format!("{task_id}-s{n}");
        if !taken.contains(&id) {
            return id;
        }
        n += 1;
    }
}

/// `subtasksFromInput`: the phone's checklist rows onto the card's — a row
/// whose opaque id names an existing step keeps that step's identity, a new
/// one is minted like `addSubtask` does.
fn subtasks_from_input(host_key: &[u8], input: &TodoTaskInput, task: &CalendarTask) -> Vec<Subtask> {
    let mut out: Vec<Subtask> = Vec::with_capacity(input.subtasks.len());
    let mut taken: HashSet<String> = task.subtasks.iter().map(|s| s.id.clone()).collect();
    for step in &input.subtasks {
        let existing = task.subtasks.iter().find(|s| key_id(host_key, "subtask", &[&s.id]) == step.id);
        match existing {
            Some(existing) => out.push(Subtask { title: step.title.trim().to_string(), done: step.done, ..existing.clone() }),
            None => {
                let id = mint_subtask_id(&task.id, &taken, out.len());
                taken.insert(id.clone());
                out.push(Subtask { id, title: step.title.trim().to_string(), done: step.done, extra: Default::default() });
            }
        }
    }
    out
}

/// `taskFromInput`: the editable half of a card applied onto `task`; `None`
/// when the calendar, column or project the phone named is not one it was
/// shown.
fn task_from_input(
    host_key: &[u8],
    data: &CalendarData,
    columns: &[TaskColumn],
    projects: &[(String, String)],
    input: &TodoTaskInput,
    task: &CalendarTask,
) -> Option<CalendarTask> {
    let calendar = resolve(host_key, "calendar", &input.calendar_id, &data.calendars, |c| c.id.as_str())?;
    let column = columns.iter().find(|c| c.id == input.column)?;
    let project_id = match input.project_id.as_deref().filter(|id| !id.is_empty()) {
        Some(opaque) => resolve(host_key, "project", opaque, projects, |(raw, _)| raw.as_str())?.0.clone(),
        None => String::new(),
    };
    Some(CalendarTask {
        title: input.title.trim().to_string(),
        notes: input.notes.clone(),
        due: input.due.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(str::to_string),
        priority: input.priority,
        percent: input.percent,
        column: column.id.clone(),
        // A column pick in the full editor discards the old rank: the card
        // lands by the board's own ordering rather than carrying neighbours
        // from another column with it.
        rank: if task.column == column.id { task.rank } else { None },
        calendar_id: calendar.id.clone(),
        project_id,
        tags: input.tags.iter().map(|tag| tag.trim().to_string()).collect(),
        subtasks: subtasks_from_input(host_key, input, task),
        ..task.clone()
    })
}

/// `toggleTaskDone`: completion and placement in one edit — a card resting in
/// an archive stays there, a ticked one goes to Done, an unticked one back to
/// intake; the rank is cleared so the backend files it at the end.
fn toggle_task_done(task: &CalendarTask, columns: &[TaskColumn], today: &str) -> CalendarTask {
    let done = task.percent >= 100;
    let current = column_of(task, columns, today);
    let in_archive = columns.iter().any(|c| c.id == current && c.archived);
    let target = if in_archive {
        Some(current)
    } else if done {
        Some(fallback_column_id(columns))
    } else {
        columns.iter().find(|c| c.done).map(|c| c.id.clone())
    };
    CalendarTask {
        percent: if done { 0 } else { 100 },
        completed: if done { None } else { Some(now_stamp()) },
        column: target.unwrap_or_else(|| task.column.clone()),
        rank: None,
        ..task.clone()
    }
}

/// `dropAccepted`: whether a card dropped into `column` would stay there —
/// false for the deadline-driven cases the next render would undo.
fn drop_accepted(task: &CalendarTask, column: &str, columns: &[TaskColumn], today: &str) -> bool {
    let placed = CalendarTask { column: column.to_string(), ..task.clone() };
    column_of(&placed, columns, today) == column
}

/// `TodoMutate` with no window. `projects` is the registry's `(id, name)`
/// list the board's project chips resolve against.
pub fn todo_mutate(state_dir: &Path, host_key: &[u8], projects: &[(String, String)], action: TodoAction) -> Result<(), Refused> {
    let path = calendar_path(state_dir);
    let data = cal::read_data(&path).map_err(|_| Refused("desktop_unavailable"))?;
    let columns = board_columns(&data.task_columns);
    let today = today();
    let write = |why: &'static str| move |_e: String| Refused(why);
    match action {
        TodoAction::Create { task } => {
            let blank = CalendarTask { id: String::new(), ..Default::default() };
            let mut next = task_from_input(host_key, &data, &columns, projects, &task, &blank).ok_or(Refused("invalid_task"))?;
            let top = data
                .tasks
                .iter()
                .filter(|t| column_of(t, &columns, &today) == next.column)
                .filter_map(|t| t.rank)
                .fold(None::<f64>, |top, rank| Some(top.map_or(rank, |t| t.min(rank))));
            next.rank = Some(top.map_or(RANK_STEP, |top| top - RANK_STEP));
            next.created = now_stamp();
            cal::create_task_at(&path, next).map(|_| ()).map_err(write("desktop_unavailable"))
        }
        TodoAction::ColumnCreate { name } => {
            let mut next = columns.clone();
            next.push(TaskColumn { id: String::new(), name: name.trim().to_string(), position: columns.len() as i64, ..Default::default() });
            cal::columns_set_at(&path, next, None).map(|_| ()).map_err(write("invalid_column"))
        }
        TodoAction::ColumnRename { column_id, name } => {
            if !columns.iter().any(|c| c.id == column_id) {
                return Err(Refused("invalid_column"));
            }
            let next = columns
                .iter()
                .map(|c| if c.id == column_id { TaskColumn { name: name.trim().to_string(), ..c.clone() } } else { c.clone() })
                .collect();
            cal::columns_set_at(&path, next, None).map(|_| ()).map_err(write("invalid_column"))
        }
        TodoAction::ColumnMove { column_id, delta } => {
            let index = columns.iter().position(|c| c.id == column_id).ok_or(Refused("invalid_column"))?;
            let target = index as i64 + i64::from(delta);
            if target < 0 || target >= columns.len() as i64 {
                return Err(Refused("invalid_column"));
            }
            let mut next = columns.clone();
            next.swap(index, target as usize);
            for (position, column) in next.iter_mut().enumerate() {
                column.position = position as i64;
            }
            cal::columns_set_at(&path, next, None).map(|_| ()).map_err(write("invalid_column"))
        }
        TodoAction::ColumnDelete { column_id } => {
            if columns.len() <= 1 || !columns.iter().any(|c| c.id == column_id) {
                return Err(Refused("invalid_column"));
            }
            let next = columns.iter().filter(|c| c.id != column_id).cloned().collect();
            cal::columns_set_at(&path, next, None).map(|_| ()).map_err(write("invalid_column"))
        }
        TodoAction::Move { task_id, column, index } => {
            let task = task_by_opaque(host_key, &data, &task_id).ok_or(Refused("task_not_found"))?;
            let target = columns.iter().find(|c| c.id == column).ok_or(Refused("invalid_column"))?;
            // Overdue, Today and the intake column are the card's deadline
            // speaking, not a placement anyone owns: a move the next snapshot
            // would undo is refused, and says why.
            if !drop_accepted(task, &target.id, &columns, &today) {
                return Err(Refused("column_follows_date"));
            }
            let count = data.tasks.iter().filter(|t| t.id != task.id && column_of(t, &columns, &today) == target.id).count();
            let at = index.unwrap_or(count).min(count);
            cal::move_tasks_at(
                &path,
                vec![cal::TaskPlacement {
                    id: task.id.clone(),
                    column: target.id.clone(),
                    index: at as u32,
                    completed_stamp: target.done.then(now_stamp),
                }],
            )
            .map(|_| ())
            .map_err(write("desktop_unavailable"))
        }
        TodoAction::Toggle { task_id } => {
            let task = task_by_opaque(host_key, &data, &task_id).ok_or(Refused("task_not_found"))?;
            cal::update_task_at(&path, toggle_task_done(task, &columns, &today)).map(|_| ()).map_err(write("desktop_unavailable"))
        }
        TodoAction::Delete { task_id } => {
            let task = task_by_opaque(host_key, &data, &task_id).ok_or(Refused("task_not_found"))?;
            cal::delete_task_at(&path, &task.id).map_err(write("desktop_unavailable"))
        }
        TodoAction::Update { task_id, task: input } => {
            let task = task_by_opaque(host_key, &data, &task_id).ok_or(Refused("task_not_found"))?;
            let next = task_from_input(host_key, &data, &columns, projects, &input, task).ok_or(Refused("invalid_task"))?;
            cal::update_task_at(&path, next).map(|_| ()).map_err(write("desktop_unavailable"))
        }
    }
}

/// A calendar the sidecar may write: not read-only, and not CalDAV-backed
/// (see the module header).
fn writable(calendar: &Calendar) -> bool {
    !calendar.readonly && !calendar.extra.get("caldav_account_id").and_then(serde_json::Value::as_str).is_some_and(|v| !v.is_empty())
}

/// `toEvent`: the phone's editable fields onto `current` (or a blank event).
fn event_from_input(host_key: &[u8], data: &CalendarData, input: &MobileCalendarEventInput, current: Option<&CalendarEvent>) -> Option<CalendarEvent> {
    let calendar = resolve(host_key, "calendar", &input.calendar_id, &data.calendars, |c| c.id.as_str())?;
    if !writable(calendar) || input.title.trim().is_empty() || input.start.is_empty() || input.end.is_empty() || input.end <= input.start {
        return None;
    }
    let status = match input.status.as_str() {
        "" | "confirmed" | "tentative" | "cancelled" => input.status.clone(),
        _ => String::new(),
    };
    Some(CalendarEvent {
        calendar_id: calendar.id.clone(),
        title: input.title.trim().to_string(),
        start: input.start.clone(),
        end: input.end.clone(),
        all_day: input.all_day,
        location: input.location.trim().to_string(),
        notes: input.notes.trim().to_string(),
        conference: input.conference.trim().to_string(),
        category: input.category.trim().to_string(),
        status,
        ..current.cloned().unwrap_or_default()
    })
}

/// `CalendarMutate` with no window.
pub fn calendar_mutate(state_dir: &Path, host_key: &[u8], action: CalendarAction) -> Result<(), Refused> {
    let path = calendar_path(state_dir);
    let data = cal::read_data(&path).map_err(|_| Refused("desktop_unavailable"))?;
    let write = |why: &'static str| move |_e: String| Refused(why);
    let find_calendar = |opaque: &str| resolve(host_key, "calendar", opaque, &data.calendars, |c| c.id.as_str());
    match action {
        CalendarAction::CreateCalendar { name, color } => cal::create_calendar_at(
            &path,
            Calendar { id: String::new(), name: name.trim().to_string(), color, visible: true, readonly: false, rev: 0, extra: Default::default() },
        )
        .map(|_| ())
        .map_err(write("desktop_unavailable")),
        CalendarAction::UpdateCalendar { calendar_id, name, color, visible } => {
            let calendar = find_calendar(&calendar_id).filter(|c| writable(c)).ok_or(Refused("calendar_unavailable"))?;
            cal::update_calendar_at(&path, Calendar { name: name.trim().to_string(), color, visible, ..calendar.clone() })
                .map(|_| ())
                .map_err(write("desktop_unavailable"))
        }
        CalendarAction::DeleteCalendar { calendar_id } => {
            let calendar = find_calendar(&calendar_id).filter(|c| writable(c)).ok_or(Refused("calendar_unavailable"))?;
            cal::delete_calendar_at(&path, &calendar.id).map_err(write("calendar_unavailable"))
        }
        CalendarAction::CreateEvent { event } => {
            let next = event_from_input(host_key, &data, &event, None).ok_or(Refused("invalid_event"))?;
            cal::create_event_at(&path, next).map(|_| ()).map_err(write("desktop_unavailable"))
        }
        CalendarAction::UpdateEvent { event_id, event } => {
            let current = resolve(host_key, "event", &event_id, &data.events, |e| e.id.as_str()).ok_or(Refused("event_not_found"))?;
            if !data.calendars.iter().find(|c| c.id == current.calendar_id).is_some_and(writable) {
                return Err(Refused("calendar_unavailable"));
            }
            let next = event_from_input(host_key, &data, &event, Some(current)).ok_or(Refused("invalid_event"))?;
            cal::update_event_at(&path, next).map(|_| ()).map_err(write("desktop_unavailable"))
        }
        CalendarAction::DeleteEvent { event_id } => {
            let current = resolve(host_key, "event", &event_id, &data.events, |e| e.id.as_str()).ok_or(Refused("event_not_found"))?;
            if !data.calendars.iter().find(|c| c.id == current.calendar_id).is_some_and(writable) {
                return Err(Refused("calendar_unavailable"));
            }
            cal::delete_event_at(&path, &current.id).map_err(write("desktop_unavailable"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::protocol::TodoSubtask;

    const KEY: &[u8] = b"host-key";

    fn opaque(domain: &str, id: &str) -> String {
        key_id(KEY, domain, &[id])
    }

    fn state_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let data = CalendarData {
            calendars: vec![
                Calendar { id: "c1".into(), name: "Home".into(), color: "#123".into(), visible: true, readonly: false, rev: 0, extra: Default::default() },
                Calendar {
                    id: "dav".into(),
                    name: "Work".into(),
                    color: "#456".into(),
                    visible: true,
                    readonly: false,
                    rev: 0,
                    extra: [("caldav_account_id".to_string(), serde_json::json!("acct"))].into_iter().collect(),
                },
            ],
            ..CalendarData::default()
        };
        crate::storage::write_json_atomic(&dir.path().join("calendar.json"), &data).unwrap();
        dir
    }

    fn read(dir: &tempfile::TempDir) -> CalendarData {
        cal::read_data(&dir.path().join("calendar.json")).unwrap()
    }

    fn input(title: &str, column: &str) -> TodoTaskInput {
        TodoTaskInput {
            title: title.into(),
            notes: String::new(),
            due: None,
            priority: 0,
            percent: 0,
            column: column.into(),
            calendar_id: opaque("calendar", "c1"),
            project_id: None,
            tags: vec!["phone".into()],
            subtasks: vec![TodoSubtask { id: "new".into(), title: "step".into(), done: false }],
        }
    }

    /// The phone's board writes land in `calendar.json` through the CAS
    /// cores under the desktop's own rules: a created card leads its
    /// column, a tick moves it to Done and back, a move into a
    /// date-governed column is refused, a delete is a delete, and every
    /// opaque id resolves only against what the phone was shown.
    #[test]
    fn board_writes_follow_the_desktops_rules() {
        let dir = state_dir();
        let columns = board_columns(&[]);
        let intake = fallback_column_id(&columns);
        let done = columns.iter().find(|c| c.done).unwrap().id.clone();
        let overdue = columns.iter().find(|c| c.overdue).unwrap().id.clone();
        todo_mutate(dir.path(), KEY, &[], TodoAction::Create { task: input("First", &intake) }).unwrap();
        todo_mutate(dir.path(), KEY, &[], TodoAction::Create { task: input("Second", &intake) }).unwrap();
        let data = read(&dir);
        assert_eq!(data.tasks.len(), 2);
        let second = data.tasks.iter().find(|t| t.title == "Second").unwrap();
        let first = data.tasks.iter().find(|t| t.title == "First").unwrap();
        assert!(second.rank < first.rank, "a new card leads its column");
        assert_eq!(second.subtasks.len(), 1);
        assert!(!second.subtasks[0].id.is_empty());
        assert_eq!(second.tags, ["phone"]);
        assert!(!second.created.is_empty());
        let second_id = second.id.clone();
        let step_id = second.subtasks[0].id.clone();

        // An id the phone was never shown resolves to nothing.
        assert_eq!(todo_mutate(dir.path(), KEY, &[], TodoAction::Toggle { task_id: second_id.clone() }), Err(Refused("task_not_found")));
        let toggle = TodoAction::Toggle { task_id: opaque("task", &second_id) };
        todo_mutate(dir.path(), KEY, &[], toggle.clone()).unwrap();
        let task = read(&dir).tasks.into_iter().find(|t| t.id == second_id).unwrap();
        assert_eq!(task.percent, 100);
        assert_eq!(task.column, done);
        assert!(task.completed.is_some());
        todo_mutate(dir.path(), KEY, &[], toggle).unwrap();
        let task = read(&dir).tasks.into_iter().find(|t| t.id == second_id).unwrap();
        assert_eq!(task.percent, 0);
        assert_eq!(task.column, intake);

        // A move into Overdue for a card that is not late is refused.
        let moved = todo_mutate(dir.path(), KEY, &[], TodoAction::Move { task_id: opaque("task", &second_id), column: overdue, index: None });
        assert_eq!(moved, Err(Refused("column_follows_date")));
        let doing = columns.iter().find(|c| !c.done && !c.archived && !c.overdue && !c.due_today && c.id != intake).unwrap().id.clone();
        todo_mutate(dir.path(), KEY, &[], TodoAction::Move { task_id: opaque("task", &second_id), column: doing.clone(), index: Some(0) }).unwrap();
        assert_eq!(read(&dir).tasks.into_iter().find(|t| t.id == second_id).unwrap().column, doing);

        // An update keeps a known step's identity and mints a new one.
        let mut edit = input("Second, edited", &doing);
        edit.subtasks = vec![
            TodoSubtask { id: opaque("subtask", &step_id), title: "step, done".into(), done: true },
            TodoSubtask { id: "fresh".into(), title: "another".into(), done: false },
        ];
        todo_mutate(dir.path(), KEY, &[], TodoAction::Update { task_id: opaque("task", &second_id), task: edit }).unwrap();
        let task = read(&dir).tasks.into_iter().find(|t| t.id == second_id).unwrap();
        assert_eq!(task.title, "Second, edited");
        assert_eq!(task.subtasks.len(), 2);
        assert_eq!(task.subtasks[0].id, step_id);
        assert!(task.subtasks[0].done);
        assert_ne!(task.subtasks[1].id, step_id);

        // Columns: create, rename, move, delete — the last one never.
        todo_mutate(dir.path(), KEY, &[], TodoAction::ColumnCreate { name: " Later ".into() }).unwrap();
        let cols = board_columns(&read(&dir).task_columns);
        let later = cols.iter().find(|c| c.name == "Later").unwrap().clone();
        todo_mutate(dir.path(), KEY, &[], TodoAction::ColumnRename { column_id: later.id.clone(), name: "Someday".into() }).unwrap();
        todo_mutate(dir.path(), KEY, &[], TodoAction::ColumnMove { column_id: later.id.clone(), delta: -1 }).unwrap();
        let cols = board_columns(&read(&dir).task_columns);
        let at = cols.iter().position(|c| c.id == later.id).unwrap();
        assert_eq!(cols[at].name, "Someday");
        assert_eq!(at, cols.len() - 2);
        todo_mutate(dir.path(), KEY, &[], TodoAction::ColumnDelete { column_id: later.id }).unwrap();
        assert!(!read(&dir).task_columns.iter().any(|c| c.name == "Someday"));
        assert_eq!(todo_mutate(dir.path(), KEY, &[], TodoAction::ColumnDelete { column_id: "nope".into() }), Err(Refused("invalid_column")));

        todo_mutate(dir.path(), KEY, &[], TodoAction::Delete { task_id: opaque("task", &second_id) }).unwrap();
        assert_eq!(read(&dir).tasks.len(), 1);
        assert!(read(&dir).rev >= 8, "every write was one CAS commit");
    }

    fn event(calendar: &str, title: &str) -> MobileCalendarEventInput {
        MobileCalendarEventInput {
            calendar_id: opaque("calendar", calendar),
            start: "2026-10-01T09:00".into(),
            end: "2026-10-01T10:00".into(),
            all_day: false,
            title: title.into(),
            location: " Lab ".into(),
            notes: String::new(),
            conference: String::new(),
            category: "work".into(),
            status: "tentative".into(),
        }
    }

    /// Calendar writes: an event is created, edited and deleted on a local
    /// calendar; a CalDAV-backed calendar and its events are refused (the
    /// desktop pushes from the write, so an edit here would be lost); a
    /// calendar is created, renamed and deleted; the opaque ids resolve
    /// against the file alone.
    #[test]
    fn calendar_writes_land_locally_and_caldav_stays_behind_the_window() {
        let dir = state_dir();
        calendar_mutate(dir.path(), KEY, CalendarAction::CreateEvent { event: event("c1", " Standup ") }).unwrap();
        let data = read(&dir);
        assert_eq!(data.events.len(), 1);
        assert_eq!(data.events[0].title, "Standup");
        assert_eq!(data.events[0].location, "Lab");
        assert_eq!(data.events[0].status, "tentative");
        let id = data.events[0].id.clone();
        let mut edit = event("c1", "Standup, moved");
        edit.end = "2026-10-01T09:30".into();
        edit.status = "weird".into();
        calendar_mutate(dir.path(), KEY, CalendarAction::UpdateEvent { event_id: opaque("event", &id), event: edit }).unwrap();
        let data = read(&dir);
        assert_eq!(data.events[0].title, "Standup, moved");
        assert_eq!(data.events[0].end, "2026-10-01T09:30");
        assert_eq!(data.events[0].status, "");
        assert_eq!(
            calendar_mutate(dir.path(), KEY, CalendarAction::UpdateEvent { event_id: id.clone(), event: event("c1", "x") }),
            Err(Refused("event_not_found")),
            "a raw id resolves to nothing"
        );
        let mut bad = event("c1", "Backwards");
        bad.end = "2026-10-01T08:00".into();
        assert_eq!(calendar_mutate(dir.path(), KEY, CalendarAction::CreateEvent { event: bad }), Err(Refused("invalid_event")));

        assert_eq!(calendar_mutate(dir.path(), KEY, CalendarAction::CreateEvent { event: event("dav", "Synced") }), Err(Refused("invalid_event")));
        assert_eq!(
            calendar_mutate(dir.path(), KEY, CalendarAction::UpdateCalendar { calendar_id: opaque("calendar", "dav"), name: "W".into(), color: "#1".into(), visible: false }),
            Err(Refused("calendar_unavailable"))
        );
        assert_eq!(calendar_mutate(dir.path(), KEY, CalendarAction::DeleteCalendar { calendar_id: opaque("calendar", "dav") }), Err(Refused("calendar_unavailable")));

        calendar_mutate(dir.path(), KEY, CalendarAction::CreateCalendar { name: " Phone ".into(), color: "#789".into() }).unwrap();
        let created = read(&dir).calendars.into_iter().find(|c| c.name == "Phone").unwrap();
        calendar_mutate(dir.path(), KEY, CalendarAction::UpdateCalendar { calendar_id: opaque("calendar", &created.id), name: "Phone, renamed".into(), color: "#abc".into(), visible: false }).unwrap();
        let renamed = read(&dir).calendars.into_iter().find(|c| c.id == created.id).unwrap();
        assert_eq!((renamed.name.as_str(), renamed.color.as_str(), renamed.visible), ("Phone, renamed", "#abc", false));
        calendar_mutate(dir.path(), KEY, CalendarAction::DeleteCalendar { calendar_id: opaque("calendar", &created.id) }).unwrap();
        assert_eq!(read(&dir).calendars.len(), 2);

        calendar_mutate(dir.path(), KEY, CalendarAction::DeleteEvent { event_id: opaque("event", &id) }).unwrap();
        assert!(read(&dir).events.is_empty());
    }
}
