//! Native calendar — a single global, local store of calendars, events and tasks.
//!
//! Everything lives in `~/.local/share/tabtivity/calendar.json` (like `boxes.json`),
//! read/written through the shared `storage` helpers. Reads go through
//! `schema::calendar::CalendarFile`, so a version-1 file (a bare array of
//! start-time-only events) still loads and is migrated on the way in; writes are
//! always the current shape.
//!
//! The CRUD logic is factored onto a `&Path` so the `#[tauri::command]` wrappers
//! stay thin (they just pass `calendar_path()`) and the tests can drive a tempdir.
//!
//! The backend deliberately stays dumb about calendar *semantics*: it does not
//! expand recurrences, evaluate alarms, or parse ICS. Those are pure functions in
//! the frontend (`src/lib/{recurrence,ics,calendarTime}.ts`) where they are cheap
//! to unit-test. This module is storage plus identity.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;

use crate::commands::projects::uuid_v4;
use crate::schema::caldav::CalDavParsed;
use crate::schema::calendar::{
    Calendar, CalendarData, CalendarEvent, CalendarFile, CalendarTask, TaskColumn,
    DEFAULT_CALENDAR_ID, RANK_EPSILON, RANK_GAP,
};
use crate::storage;

/// Calendar CRUD and CalDAV merges are read-modify-write transactions over the
/// same file. Atomic replacement protects readers; this lock protects edits
/// from overwriting one another between their read and rename — within this
/// process. A second process (a second Tabtivity window, the Mobile sidecar) is
/// what the revision check in [`transact`] is for (#171).
static CALENDAR_RMW_LOCK: Mutex<()> = Mutex::new(());

fn lock_calendar() -> std::sync::MutexGuard<'static, ()> {
    CALENDAR_RMW_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn calendar_path() -> PathBuf {
    storage::state_dir().join("calendar.json")
}

/// Read the store, migrating a legacy file in the process. A missing file is an
/// empty calendar, not an error.
pub(crate) fn read_data(path: &Path) -> Result<CalendarData, String> {
    if !path.exists() {
        return Ok(CalendarData::default());
    }
    let file: CalendarFile = storage::read_json(path).map_err(|e| e.to_string())?;
    Ok(file.into_data())
}

/// Write the store **atomically** (temp file + rename), not in place.
///
/// `write_json` truncates the target before writing, so a crash mid-write loses
/// the whole calendar rather than the one edit. That was a narrow window while
/// this file was only touched by a calendar dialog; the todo board writes it on
/// every drag, from a second window as well, which is exactly the situation
/// `write_json_atomic`'s own doc describes.
fn write_data(path: &Path, data: &CalendarData) -> Result<(), String> {
    storage::write_json_atomic(path, data).map_err(|e| e.to_string())
}

// ── Compare-and-swap (#171) ─────────────────────────────────────────────────
//
// Every edit is a read-modify-write of the whole file. `CALENDAR_RMW_LOCK`
// serialises those within one process, and nothing else: a second Tabtivity
// window on the same machine, or the Mobile sidecar, reads the same file from
// another process and the loser's edit silently vanished under the winner's
// rename. So the file carries a revision (`CalendarData::rev`), a transaction
// remembers the one it read, and commits only while the file still holds it;
// otherwise the edit is re-applied to the fresh state instead of clobbering.
// The check-and-rename itself sits under an advisory file lock, so two
// processes cannot both pass the check.

/// How many times an edit is re-run against fresh state before giving up.
const CAS_ATTEMPTS: usize = 8;

/// Whether a commit landed, or found the file already moved on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Commit {
    Committed,
    Stale,
}

/// Run one read-modify-write over the store, committing it only if the
/// file's revision is still the one the read saw. Returns what `edit`
/// returned and the state that reached disk (record revisions stamped).
///
/// `edit` runs again when another process wrote between the read and the
/// commit, so it must not consume anything it needs a second time (push a
/// clone into the store, not the original). An `Err` from `edit` ends the
/// transaction without writing.
pub(crate) fn transact<T>(
    path: &Path,
    mut edit: impl FnMut(&mut CalendarData) -> Result<T, String>,
) -> Result<(T, CalendarData), String> {
    let _guard = lock_calendar();
    for _ in 0..CAS_ATTEMPTS {
        let base = read_data(path)?;
        let mut data = base.clone();
        let out = edit(&mut data)?;
        match commit(path, &base, &mut data)? {
            Commit::Committed => return Ok((out, data)),
            Commit::Stale => continue,
        }
    }
    Err("calendar.json kept changing underneath this edit; try again".to_string())
}

/// Commit `data`, derived from `base`, if the file still holds `base.rev`.
/// An unchanged store is a no-op that never touches the file. On success
/// `data` carries the stamped record revisions and the new file revision.
pub(crate) fn commit(path: &Path, base: &CalendarData, data: &mut CalendarData) -> Result<Commit, String> {
    if *data == *base {
        return Ok(Commit::Committed);
    }
    stamp_revs(&base.calendars, &mut data.calendars);
    stamp_revs(&base.events, &mut data.events);
    stamp_revs(&base.tasks, &mut data.tasks);
    data.rev = base.rev + 1;
    write_data_cas(path, data, base.rev)
}

/// A record with an id and a revision — the three kinds `calendar.json` holds.
trait Revisioned: Clone + PartialEq {
    fn id(&self) -> &str;
    fn rev(&self) -> u64;
    fn set_rev(&mut self, rev: u64);
}

macro_rules! revisioned {
    ($($ty:ty),*) => {$(
        impl Revisioned for $ty {
            fn id(&self) -> &str {
                &self.id
            }
            fn rev(&self) -> u64 {
                self.rev
            }
            fn set_rev(&mut self, rev: u64) {
                self.rev = rev;
            }
        }
    )*};
}
revisioned!(Calendar, CalendarEvent, CalendarTask);

/// Give every record that differs from its `base` counterpart the next
/// revision, and every unchanged one its old revision back — whatever number
/// the caller's copy carried, the store decides. A record `base` never held
/// (new, or restored after a delete) moves past the revision it came with.
fn stamp_revs<R: Revisioned>(base: &[R], now: &mut [R]) {
    let was: std::collections::HashMap<&str, &R> = base.iter().map(|r| (r.id(), r)).collect();
    for record in now.iter_mut() {
        match was.get(record.id()) {
            None => record.set_rev(record.rev().saturating_add(1)),
            Some(was) => {
                let mut probe = record.clone();
                probe.set_rev(was.rev());
                if probe == **was {
                    record.set_rev(was.rev());
                } else {
                    record.set_rev(was.rev().saturating_add(1));
                }
            }
        }
    }
}

/// The revision the file holds right now: `0` for a missing or legacy
/// (version-1 array) file, which is also what a read of either reports.
fn on_disk_rev(path: &Path) -> u64 {
    #[derive(Deserialize)]
    struct RevProbe {
        #[serde(default)]
        rev: u64,
    }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<RevProbe>(&text).ok())
        .map(|probe| probe.rev)
        .unwrap_or(0)
}

/// Write `data` if the file still holds `expected_rev`, under an advisory
/// lock on a sibling `.lock` file so another process cannot pass the same
/// check in between. The lock file is never removed: deleting one out from
/// under a holder is how two processes end up holding "the" lock.
pub(crate) fn write_data_cas(path: &Path, data: &CalendarData, expected_rev: u64) -> Result<Commit, String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    if on_disk_rev(path) == expected_rev {
        write_data(path, data).map(|()| Commit::Committed)
    } else {
        Ok(Commit::Stale)
    }
}

/// Apply an entire reviewed proposal under the same lock as user edits and
/// CalDAV merges. Failed preconditions never write even part of a batch.
pub(crate) fn apply_change_at(
    path: &Path,
    rows: &[crate::services::root_mcp_review::Row],
    calendars: &[serde_json::Value],
) -> Result<Vec<crate::services::root_mcp::Change>, String> {
    let (changes, _) = transact(path, |data| {
        let mut value = serde_json::to_value(&*data).map_err(|e| e.to_string())?;
        let changes = crate::services::root_mcp_review::apply_rows(&mut value, rows, calendars)?;
        *data = serde_json::from_value(value).map_err(|e| e.to_string())?;
        Ok(changes)
    })?;
    Ok(changes)
}

/// Mint an id not already present among `existing` (guards against back-to-back
/// time-based `uuid_v4` collisions, mirroring `create_box`).
fn fresh_id(existing: &HashSet<&str>) -> String {
    let mut id = uuid_v4();
    while existing.contains(id.as_str()) {
        id = uuid_v4();
    }
    id
}

fn event_ids(data: &CalendarData) -> HashSet<&str> {
    data.events.iter().map(|e| e.id.as_str()).collect()
}

fn task_ids(data: &CalendarData) -> HashSet<&str> {
    data.tasks.iter().map(|t| t.id.as_str()).collect()
}

fn calendar_ids(data: &CalendarData) -> HashSet<&str> {
    data.calendars.iter().map(|c| c.id.as_str()).collect()
}

// ── Events ──────────────────────────────────────────────────────────────────

/// Insert `event`, minting an id and defaulting its calendar. The caller's `id`
/// is ignored — the store owns identity.
pub(crate) fn create_event_at(path: &Path, mut event: CalendarEvent) -> Result<CalendarEvent, String> {
    if event.calendar_id.is_empty() {
        event.calendar_id = DEFAULT_CALENDAR_ID.to_string();
    }
    let (id, data) = transact(path, |data| {
        let mut event = event.clone();
        event.id = fresh_id(&event_ids(data));
        let id = event.id.clone();
        data.events.push(event);
        data.normalize();
        Ok(id)
    })?;
    stored_event(&data, &id)
}

/// Replace the event with `event.id` wholesale.
pub(crate) fn update_event_at(path: &Path, event: CalendarEvent) -> Result<CalendarEvent, String> {
    let (_, data) = transact(path, |data| {
        let slot = data
            .events
            .iter_mut()
            .find(|e| e.id == event.id)
            .ok_or_else(|| format!("event '{}' not found", event.id))?;
        *slot = event.clone();
        data.normalize();
        Ok(())
    })?;
    stored_event(&data, &event.id)
}

/// The event as it reached disk: the writers return **this**, not the
/// caller's record, so the caller holds the stamped revision and whatever
/// `normalize` refiled.
fn stored_event(data: &CalendarData, id: &str) -> Result<CalendarEvent, String> {
    data.events
        .iter()
        .find(|e| e.id == id)
        .cloned()
        .ok_or_else(|| format!("event '{id}' vanished during normalize"))
}

pub(crate) fn delete_event_at(path: &Path, id: &str) -> Result<(), String> {
    transact(path, |data| {
        let before = data.events.len();
        data.events.retain(|e| e.id != id);
        if data.events.len() == before {
            return Err(format!("event '{id}' not found"));
        }
        Ok(())
    })
    .map(|_| ())
}

/// One event a move re-filed: the row as it was, and as it now is.
#[derive(Debug, Clone)]
pub(crate) struct MovedEvent {
    pub before: CalendarEvent,
    pub after: CalendarEvent,
}

/// Re-file `event` under `to`, in memory. `data` is the store it came from.
///
/// A row synced from a CalDAV server is a **resource in one collection**, and a
/// move cannot carry that address along: pushing the row to its new calendar
/// under its old `caldav_href` would `PUT` straight back into the collection it
/// just left. So the address is dropped here, which makes the next push a
/// create in the new collection, and the caller hands the `before` row to
/// whatever deletes the old copy (`MovedEvent`).
///
/// A resource holding more than this one row (a series plus the occurrences
/// the server stores as overrides) is refused: those rows move as one object
/// or not at all, and pushing them one by one would split the series.
pub(crate) fn relocate_event(
    data: &CalendarData,
    event: &mut CalendarEvent,
    to: &str,
) -> Result<(), String> {
    let href = extra_str(&event.extra, CALDAV_HREF_KEY);
    if !href.is_empty() {
        let siblings = data
            .events
            .iter()
            .filter(|e| {
                e.id != event.id
                    && e.calendar_id == event.calendar_id
                    && extra_str(&e.extra, CALDAV_HREF_KEY) == href
            })
            .count();
        if siblings > 0 {
            return Err(format!(
                "event '{}' is a recurring series with edited occurrences on its CalDAV server; move it there instead",
                event.title
            ));
        }
    }
    event.extra.remove(CALDAV_HREF_KEY);
    event.extra.remove(CALDAV_ETAG_KEY);
    event.calendar_id = to.to_string();
    Ok(())
}

/// [`relocate_event`] for a to-do card: the server address is dropped so the
/// next push creates the card in its new collection, and the caller deletes
/// the old copy. A VTODO is one row per resource, so there is no series to split.
pub(crate) fn relocate_task(task: &mut CalendarTask, to: &str) {
    task.extra.remove(CALDAV_HREF_KEY);
    task.extra.remove(CALDAV_ETAG_KEY);
    task.calendar_id = to.to_string();
}

/// Move the events `ids` into calendar `to`, in **one** atomic write: either
/// every event moves or none does, so a refusal halfway through a batch leaves
/// no half-moved calendar behind. An event already in `to` is left alone and
/// not reported.
pub(crate) fn move_events_at(path: &Path, ids: &[String], to: &str) -> Result<Vec<MovedEvent>, String> {
    let (moved, _) = transact(path, |data| {
        let target = data
            .calendars
            .iter()
            .find(|c| c.id == to)
            .ok_or_else(|| format!("calendar '{to}' not found"))?;
        if target.readonly {
            return Err(format!("calendar '{}' is read-only", target.name));
        }
        let readonly: HashSet<&str> = data
            .calendars
            .iter()
            .filter(|c| c.readonly)
            .map(|c| c.id.as_str())
            .collect();

        let mut moved = Vec::new();
        let mut seen = HashSet::new();
        for id in ids {
            if !seen.insert(id.as_str()) {
                continue;
            }
            let before = data
                .events
                .iter()
                .find(|e| &e.id == id)
                .cloned()
                .ok_or_else(|| format!("event '{id}' not found"))?;
            if before.calendar_id == to {
                continue;
            }
            // Moving out of a read-only calendar deletes from it, which is a
            // write the window could not push either.
            if readonly.contains(before.calendar_id.as_str()) {
                return Err(format!("event '{id}' is in a read-only calendar"));
            }
            let mut after = before.clone();
            relocate_event(data, &mut after, to)?;
            moved.push(MovedEvent { before, after });
        }
        for m in &moved {
            if let Some(slot) = data.events.iter_mut().find(|e| e.id == m.after.id) {
                *slot = m.after.clone();
            }
        }
        if !moved.is_empty() {
            data.normalize();
        }
        Ok(moved)
    })?;
    Ok(moved)
}

// ── Tasks ───────────────────────────────────────────────────────────────────

/// Pull a task back out of the normalized store.
///
/// Both writers below return **this**, not the caller's record: `normalize` files
/// a new card into a column, mints its rank, and reconciles a completed one into
/// the Done column, so the caller's pre-normalize copy is a different task from
/// the one now on disk. Returning it would leave the frontend holding a card with
/// no column (which does not render) or in the column it just left.
fn normalized_task(data: &CalendarData, id: &str) -> Result<CalendarTask, String> {
    data.tasks
        .iter()
        .find(|t| t.id == id)
        .cloned()
        .ok_or_else(|| format!("task '{id}' vanished during normalize"))
}

pub(crate) fn create_task_at(path: &Path, mut task: CalendarTask) -> Result<CalendarTask, String> {
    if task.calendar_id.is_empty() {
        task.calendar_id = DEFAULT_CALENDAR_ID.to_string();
    }
    let (id, data) = transact(path, |data| {
        let mut task = task.clone();
        task.id = fresh_id(&task_ids(data));
        let id = task.id.clone();
        data.tasks.push(task);
        data.normalize();
        Ok(id)
    })?;
    normalized_task(&data, &id)
}

pub(crate) fn update_task_at(path: &Path, task: CalendarTask) -> Result<CalendarTask, String> {
    let id = task.id.clone();
    let (_, data) = transact(path, |data| {
        let slot = data
            .tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("task '{id}' not found"))?;
        *slot = task.clone();
        data.normalize();
        Ok(())
    })?;
    normalized_task(&data, &id)
}

pub(crate) fn delete_task_at(path: &Path, id: &str) -> Result<(), String> {
    transact(path, |data| {
        let before = data.tasks.len();
        data.tasks.retain(|t| t.id != id);
        if data.tasks.len() == before {
            return Err(format!("task '{id}' not found"));
        }
        Ok(())
    })
    .map(|_| ())
}

// ── Todo board ──────────────────────────────────────────────────────────────
//
// The board is the calendar's tasks seen as cards; everything it needs to *read*
// it gets from `calendar_load`, and everything it needs to *edit one card* it
// gets from `create_task`/`update_task`/`delete_task`. Only two gestures need
// their own command, and for the same reason in both cases: they change several
// records at once, and doing that as N round trips over a file that is rewritten
// in full each time would let a concurrent edit land in the middle.

/// One card's target position after a drag.
#[derive(Debug, Clone, Deserialize)]
pub struct TaskPlacement {
    pub id: String,
    /// Target column id. An unknown one is refiled by `normalize` rather than
    /// refused — a drag that reports success and does nothing is worse than one
    /// that lands somewhere predictable.
    pub column: String,
    /// 0-based position within `column` **after** the move, counting only the
    /// cards that end up there. Anything past the end appends.
    pub index: u32,
    /// Local wall-clock stamp to use when this move *completes* the task, minted
    /// by the frontend exactly as the Tasks view's checkbox already mints one
    /// (this crate has no clock that speaks local time). Ignored when the target
    /// is not the done column, or when the task already carries a stamp.
    #[serde(default)]
    pub completed_stamp: Option<String>,
}

/// Order the cards of one column as the board shows them: by rank ascending,
/// with `id` as the tie-break so a hand-edited file with duplicate ranks is
/// stable rather than shuffling on every read.
fn column_order(data: &CalendarData, column: &str, exclude: &str) -> Vec<(String, f64)> {
    let mut rows: Vec<(String, f64)> = data
        .tasks
        .iter()
        .filter(|t| t.column == column && t.id != exclude)
        .map(|t| (t.id.clone(), t.rank.unwrap_or(f64::MAX)))
        .collect();
    rows.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    rows
}

/// Apply a drag: one file write, whatever it moved.
///
/// The frontend sends an **index**, never a rank. That keeps the rank algebra —
/// bisect, the too-close-to-split guard, the whole-column reindex — in one tested
/// place, and it makes the command idempotent: replaying the same placements is a
/// no-op, because a card already at the requested index keeps the rank it has.
///
/// Returns every task whose `column`, `rank`, `percent` or `completed` changed,
/// which is a superset of `moves` whenever a reindex fired or the done coupling
/// completed a card. The frontend merges those into its store rather than
/// reloading the whole calendar.
pub(crate) fn move_tasks_at(path: &Path, moves: Vec<TaskPlacement>) -> Result<Vec<CalendarTask>, String> {
    let (changed, data) = transact(path, |data| move_tasks_in(data, &moves))?;
    // Re-read the rows off the committed state, so they carry the stamped
    // revisions rather than the pre-commit copies.
    let ids: HashSet<&str> = changed.iter().map(|t| t.id.as_str()).collect();
    Ok(data
        .tasks
        .iter()
        .filter(|t| ids.contains(t.id.as_str()))
        .cloned()
        .collect())
}

/// The in-memory half of [`move_tasks_at`], over a store already read.
fn move_tasks_in(data: &mut CalendarData, moves: &[TaskPlacement]) -> Result<Vec<CalendarTask>, String> {
    // The first drag is what creates the board — a *read* deliberately never
    // does, so a calendar-only user's file never grows board state.
    data.ensure_board();
    data.normalize();
    let before: Vec<CalendarTask> = data.tasks.clone();

    let done_col: Option<String> = data
        .task_columns
        .iter()
        .find(|c| c.done)
        .map(|c| c.id.clone());
    let mut touched: Vec<String> = Vec::new();

    for placement in moves {
        let Some(current) = data.tasks.iter().find(|t| t.id == placement.id) else {
            return Err(format!("task '{}' not found", placement.id));
        };
        let from_column = current.column.clone();
        let target = placement.column.clone();

        let siblings = column_order(data, &target, &placement.id);
        let index = (placement.index as usize).min(siblings.len());

        // Where the card sits in the target column *today*, if it is already
        // there — the check that makes a replay a no-op.
        let settled = from_column == target && {
            let full = column_order(data, &target, "");
            full.iter().position(|(id, _)| id == &placement.id) == Some(index)
        };

        let new_rank = if settled {
            None
        } else {
            let before_rank = index
                .checked_sub(1)
                .and_then(|i| siblings.get(i))
                .map(|s| s.1);
            let after_rank = siblings.get(index).map(|s| s.1);
            Some(match (before_rank, after_rank) {
                (None, None) => RANK_GAP,
                (Some(b), None) => b + RANK_GAP,
                (None, Some(a)) => a - RANK_GAP,
                (Some(b), Some(a)) => (b + a) / 2.0,
            })
        };

        let Some(task) = data.tasks.iter_mut().find(|t| t.id == placement.id) else {
            unreachable!("presence checked above");
        };
        task.column = target.clone();
        if let Some(rank) = new_rank {
            task.rank = Some(rank);
        }

        // The done coupling, applied here so the record hits disk consistent —
        // `normalize` would otherwise see a card in Done with percent 0 and move
        // it straight back out.
        if let Some(done_id) = &done_col {
            if &target == done_id {
                task.percent = 100;
                if task.completed.is_none() {
                    task.completed = placement.completed_stamp.clone();
                }
            } else if &from_column == done_id && task.percent >= 100 {
                // Not `percent = 99`: the Tasks view derives done from
                // `percent >= 100`, so leaving the stamp would show the card as
                // done in the calendar and in progress on the board.
                task.percent = 0;
                task.completed = None;
            }
        }

        for col in [from_column, target] {
            if !touched.contains(&col) {
                touched.push(col);
            }
        }
    }

    // Reindex any column whose ranks got too close to split again. Normally free
    // (nothing is close), and cheap even when it fires: every write rewrites the
    // whole file, so N changed ranks cost what one costs.
    for col in touched {
        let order = column_order(data, &col, "");
        let collapsed = order
            .windows(2)
            .any(|w| (w[1].1 - w[0].1).abs() < RANK_EPSILON);
        if !collapsed {
            continue;
        }
        for (i, (id, _)) in order.iter().enumerate() {
            if let Some(task) = data.tasks.iter_mut().find(|t| &t.id == id) {
                task.rank = Some((i + 1) as f64 * RANK_GAP);
            }
        }
    }

    data.normalize();

    let changed: Vec<CalendarTask> = data
        .tasks
        .iter()
        .filter(|now| {
            before
                .iter()
                .find(|was| was.id == now.id)
                .is_none_or(|was| {
                    was.column != now.column
                        || was.rank != now.rank
                        || was.percent != now.percent
                        || was.completed != now.completed
                })
        })
        .cloned()
        .collect();
    Ok(changed)
}

/// Replace the board's column list: add, rename, recolor, reorder, delete.
///
/// Wholesale rather than a create/update/delete triple, because a *reorder* is the
/// common edit and would otherwise be N round trips over a file rewritten in full
/// each time — and because deleting a column has to refile its cards in the same
/// write, which a generic `delete_column(id)` cannot express.
///
/// `fallback_column` receives the cards of every column that disappeared. `None`
/// clears their placement instead and lets `normalize` file them, which is the
/// better default: a *completed* card then lands in Done rather than being dumped
/// into the leftmost column with its checkbox still ticked.
pub(crate) fn columns_set_at(
    path: &Path,
    columns: Vec<TaskColumn>,
    fallback_column: Option<String>,
) -> Result<CalendarData, String> {
    if columns.is_empty() {
        // The twin of "cannot delete the last calendar": with no columns there is
        // nowhere to put a card, and the next read would silently resurrect the
        // default set — which reads as "my board reset itself".
        return Err("cannot delete the last column".to_string());
    }
    let (_, data) = transact(path, |data| {
        data.ensure_board();

        let mut seen: HashSet<String> = HashSet::new();
        let mut columns = columns.clone();
        for col in columns.iter_mut() {
            if col.id.is_empty() || seen.contains(&col.id) {
                let taken: HashSet<&str> = seen.iter().map(|s| s.as_str()).collect();
                col.id = fresh_id(&taken);
            }
            seen.insert(col.id.clone());
        }

        let fallback = fallback_column.clone().filter(|id| seen.contains(id));
        for task in data.tasks.iter_mut() {
            if !task.column.is_empty() && !seen.contains(&task.column) {
                task.column = fallback.clone().unwrap_or_default();
                task.rank = None;
            }
        }
        data.task_columns = columns;

        data.normalize();
        Ok(())
    })?;
    Ok(data)
}

// ── Calendars ───────────────────────────────────────────────────────────────

pub(crate) fn create_calendar_at(path: &Path, calendar: Calendar) -> Result<Calendar, String> {
    let (id, data) = transact(path, |data| {
        let mut calendar = calendar.clone();
        calendar.id = fresh_id(&calendar_ids(data));
        let id = calendar.id.clone();
        data.calendars.push(calendar);
        Ok(id)
    })?;
    stored_calendar(&data, &id)
}

pub(crate) fn update_calendar_at(path: &Path, calendar: Calendar) -> Result<Calendar, String> {
    let (_, data) = transact(path, |data| {
        let slot = data
            .calendars
            .iter_mut()
            .find(|c| c.id == calendar.id)
            .ok_or_else(|| format!("calendar '{}' not found", calendar.id))?;
        *slot = calendar.clone();
        Ok(())
    })?;
    stored_calendar(&data, &calendar.id)
}

/// The calendar row as it reached disk (see [`stored_event`]).
fn stored_calendar(data: &CalendarData, id: &str) -> Result<Calendar, String> {
    data.calendars
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| format!("calendar '{id}' vanished during normalize"))
}

/// Delete a calendar **and everything filed under it** — the destructive choice,
/// matching what Thunderbird's "Remove calendar" does. Refusing to delete the last
/// calendar keeps `normalize()`'s "at least one calendar" invariant meaningful
/// (otherwise the next read would silently resurrect a default).
pub(crate) fn delete_calendar_at(path: &Path, id: &str) -> Result<(), String> {
    transact(path, |data| {
        if data.calendars.len() <= 1 {
            return Err("cannot delete the last calendar".to_string());
        }
        let before = data.calendars.len();
        data.calendars.retain(|c| c.id != id);
        if data.calendars.len() == before {
            return Err(format!("calendar '{id}' not found"));
        }
        data.events.retain(|e| e.calendar_id != id);
        data.tasks.retain(|t| t.calendar_id != id);
        Ok(())
    })
    .map(|_| ())
}

/// Put a just-deleted calendar back, with the events and tasks the caller kept
/// from before the delete — the sidebar's "Undo". The calendar keeps its id, so
/// its CalDAV link and anything else keyed on it still line up. An event or task
/// whose id was reused in the meantime gets a fresh one rather than clobbering
/// the newcomer; everything restored is re-filed under the restored calendar.
fn restore_calendar_at(
    path: &Path,
    calendar: Calendar,
    events: Vec<CalendarEvent>,
    tasks: Vec<CalendarTask>,
) -> Result<CalendarData, String> {
    let (_, data) = transact(path, |data| {
        if data.calendars.iter().any(|c| c.id == calendar.id) {
            return Err(format!("calendar '{}' already exists", calendar.id));
        }
        for mut event in events.iter().cloned() {
            if event_ids(data).contains(event.id.as_str()) {
                event.id = fresh_id(&event_ids(data));
            }
            event.calendar_id = calendar.id.clone();
            data.events.push(event);
        }
        for mut task in tasks.iter().cloned() {
            if task_ids(data).contains(task.id.as_str()) {
                task.id = fresh_id(&task_ids(data));
            }
            task.calendar_id = calendar.id.clone();
            data.tasks.push(task);
        }
        data.calendars.push(calendar.clone());
        Ok(())
    })?;
    Ok(data)
}

/// Replace every event/task filed under `calendar_id` with a fresh set —
/// what "Refresh from URL" needs so a re-fetched subscription (TimeTree or any
/// other read-only ICS feed) updates the calendar it was imported into rather
/// than piling up a second copy the way re-importing the same file would.
/// Ids are minted here, same as `create_event_at`/`create_task_at`, because a
/// re-fetched feed carries no id of its own the store can trust — an ICS
/// `UID` is round-tripped for the calendar's own export, but nothing pins an
/// import's fresh id to it, so there is no stable identity to preserve across
/// a refresh; a card dragged on the to-do board loses its column/rank the same
/// way a plain re-import would.
fn replace_calendar_events_at(
    path: &Path,
    calendar_id: &str,
    events: Vec<CalendarEvent>,
    tasks: Vec<CalendarTask>,
) -> Result<CalendarData, String> {
    let (_, data) = transact(path, |data| {
        if !data.calendars.iter().any(|c| c.id == calendar_id) {
            return Err(format!("calendar '{calendar_id}' not found"));
        }
        data.events.retain(|e| e.calendar_id != calendar_id);
        data.tasks.retain(|t| t.calendar_id != calendar_id);

        for mut event in events.iter().cloned() {
            event.id = fresh_id(&event_ids(data));
            event.calendar_id = calendar_id.to_string();
            data.events.push(event);
        }
        for mut task in tasks.iter().cloned() {
            task.id = fresh_id(&task_ids(data));
            task.calendar_id = calendar_id.to_string();
            data.tasks.push(task);
        }

        data.normalize();
        Ok(())
    })?;
    Ok(data)
}

// ── CalDAV reconciliation ───────────────────────────────────────────────────
//
// The one genuinely new piece of logic CalDAV needs beyond "speak the protocol
// and hand text to the existing ICS parser" (`docs/caldav_plan.md`).
//
// `replace_calendar_events_at` above cannot be reused, and the reason is the
// whole point: it deletes every row under a calendar and re-inserts a freshly
// parsed set with **freshly minted ids**. That is fine for a manual click on an
// anonymous feed. It is not fine for a sync that runs unattended on a timer,
// because `CalendarTask::column`/`rank`/`tags`/`subtasks`/`project_id`/`mail`
// are the to-do board's own state, have no CalDAV representation, and a
// wholesale replace would silently evict every CalDAV-sourced card from wherever
// the user dragged it — every time the timer fires.
//
// The fix is identity, not replacement. A CalDAV resource carries a URL the
// server hands back unchanged next time (which an ICS feed has no equivalent
// of), so rows are matched on it and merged field by field: server-owned fields
// are overwritten, board state is left alone.

/// The `extra` key holding a synced row's own resource URL — the stable key.
pub const CALDAV_HREF_KEY: &str = "caldav_href";
/// The `extra` key holding its last-seen ETag, for `If-Match` when push lands.
pub const CALDAV_ETAG_KEY: &str = "caldav_etag";

fn extra_str(extra: &std::collections::HashMap<String, serde_json::Value>, key: &str) -> String {
    extra
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Copy the local row's `extra` keys the server knows nothing about onto the
/// incoming one, without letting them shadow anything the server sent.
fn carry_extra(
    incoming: &mut std::collections::HashMap<String, serde_json::Value>,
    local: &std::collections::HashMap<String, serde_json::Value>,
) {
    for (k, v) in local {
        incoming.entry(k.clone()).or_insert_with(|| v.clone());
    }
}

/// Merge one CalDAV fetch into `calendar_id`, in **one** atomic write.
///
/// Three cases, per `docs/caldav_plan.md`:
///
/// - **Matched** (a local row's `caldav_href` is in the incoming set): keep its
///   id and — for a task — its board state; overwrite everything the server owns.
/// - **New**: create it. A task with no placement is what `normalize` already
///   handles for every newly-created task, so there is no special case here.
/// - **Gone**: an href in `removed` (an explicit `404` from the server) deletes
///   both events and tasks. Absence from a **full** listing deletes an *event*
///   only — a VTODO can vanish from a `calendar-query` because it was deleted
///   *or* because the server stopped returning completed-and-old ones by default
///   filter, and those two are indistinguishable from here. Guessing wrong
///   destroys a card. Absence from an **incremental** report means nothing at
///   all: unchanged resources are simply not in it.
///
/// One resource may carry several components — a recurring event's master plus
/// its `RECURRENCE-ID` overrides is exactly that shape — so rows are matched
/// **within** an href group, by position. Positional rather than by content
/// because the alternative is guessing which of two same-titled occurrences is
/// which; in the overwhelmingly common one-component-per-resource case the two
/// are the same thing.
pub(crate) fn merge_caldav_calendar_at(
    path: &Path,
    calendar_id: &str,
    parsed: Vec<CalDavParsed>,
    removed: &[String],
    full: bool,
) -> Result<CalendarData, String> {
    let (_, data) = transact(path, |data| merge_caldav_calendar_in(data, calendar_id, &parsed, removed, full))?;
    Ok(data)
}

/// The in-memory half of [`merge_caldav_calendar_at`], over a store already read.
fn merge_caldav_calendar_in(
    data: &mut CalendarData,
    calendar_id: &str,
    parsed: &[CalDavParsed],
    removed: &[String],
    full: bool,
) -> Result<(), String> {
    if !data.calendars.iter().any(|c| c.id == calendar_id) {
        return Err(format!("calendar '{calendar_id}' not found"));
    }

    // Everything the server just told us about, grouped by resource.
    let mut seen_hrefs: HashSet<String> = HashSet::new();
    let gone: HashSet<&str> = removed.iter().map(|h| h.as_str()).collect();
    // Local rows whose resource still exists but which the resource no longer
    // contains — an occurrence override deleted upstream shrinks a resource
    // from two components to one, and the orphan must go with it.
    let mut stale: HashSet<String> = HashSet::new();

    for group in parsed.iter().cloned() {
        if group.href.trim().is_empty() {
            continue;
        }
        seen_hrefs.insert(group.href.clone());

        // ── Events in this resource ──────────────────────────────────────
        let local_events: Vec<usize> = data
            .events
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                e.calendar_id == calendar_id && extra_str(&e.extra, CALDAV_HREF_KEY) == group.href
            })
            .map(|(i, _)| i)
            .collect();
        let mut fresh_events: Vec<CalendarEvent> = Vec::new();
        let incoming_events = group.events.len();
        for (i, mut event) in group.events.into_iter().enumerate() {
            event.calendar_id = calendar_id.to_string();
            event.extra.insert(
                CALDAV_HREF_KEY.to_string(),
                serde_json::Value::String(group.href.clone()),
            );
            event.extra.insert(
                CALDAV_ETAG_KEY.to_string(),
                serde_json::Value::String(group.etag.clone()),
            );
            match local_events.get(i) {
                Some(&slot) => {
                    let local = &data.events[slot];
                    // The store owns identity: a matched row keeps the id every
                    // other surface already references.
                    event.id = local.id.clone();
                    carry_extra(&mut event.extra, &local.extra);
                    data.events[slot] = event;
                }
                None => fresh_events.push(event),
            }
        }
        // The resource shrank: local rows past the incoming count have no
        // counterpart left and go with it.
        for &slot in local_events.iter().skip(incoming_events) {
            stale.insert(data.events[slot].id.clone());
        }
        for mut event in fresh_events {
            event.id = fresh_id(&event_ids(data));
            data.events.push(event);
        }

        // ── Tasks in this resource ───────────────────────────────────────
        let local_tasks: Vec<usize> = data
            .tasks
            .iter()
            .enumerate()
            .filter(|(_, t)| {
                t.calendar_id == calendar_id && extra_str(&t.extra, CALDAV_HREF_KEY) == group.href
            })
            .map(|(i, _)| i)
            .collect();
        let mut fresh_tasks: Vec<CalendarTask> = Vec::new();
        let incoming_tasks = group.tasks.len();
        for (i, mut task) in group.tasks.into_iter().enumerate() {
            task.calendar_id = calendar_id.to_string();
            task.extra.insert(
                CALDAV_HREF_KEY.to_string(),
                serde_json::Value::String(group.href.clone()),
            );
            task.extra.insert(
                CALDAV_ETAG_KEY.to_string(),
                serde_json::Value::String(group.etag.clone()),
            );
            match local_tasks.get(i) {
                Some(&slot) => {
                    let local = &data.tasks[slot];
                    task.id = local.id.clone();
                    // **The board state, kept.** These are Tabtivity's own fields;
                    // the server has never heard of them and a sync that
                    // overwrote them would move the user's cards on a timer.
                    task.column = local.column.clone();
                    task.rank = local.rank;
                    task.tags = local.tags.clone();
                    task.subtasks = local.subtasks.clone();
                    task.mail = local.mail.clone();
                    task.event = local.event.clone();
                    task.file = local.file.clone();
                    task.project_id = local.project_id.clone();
                    task.created = local.created.clone();
                    carry_extra(&mut task.extra, &local.extra);
                    data.tasks[slot] = task;
                }
                None => fresh_tasks.push(task),
            }
        }
        for &slot in local_tasks.iter().skip(incoming_tasks) {
            stale.insert(data.tasks[slot].id.clone());
        }
        for mut task in fresh_tasks {
            task.id = fresh_id(&task_ids(data));
            data.tasks.push(task);
        }
    }

    if !stale.is_empty() {
        data.events.retain(|e| !stale.contains(&e.id));
        data.tasks.retain(|t| !stale.contains(&t.id));
    }

    // Explicit deletions apply to both kinds — the server said `404` for that
    // exact resource, which is not ambiguous.
    if !gone.is_empty() {
        data.events.retain(|e| {
            !(e.calendar_id == calendar_id
                && gone.contains(extra_str(&e.extra, CALDAV_HREF_KEY).as_str()))
        });
        data.tasks.retain(|t| {
            !(t.calendar_id == calendar_id
                && gone.contains(extra_str(&t.extra, CALDAV_HREF_KEY).as_str()))
        });
    }

    // A full listing is authoritative about *events*. Rows with no href are
    // untouched whatever happens: they were not put there by a sync, and a sync
    // does not get to delete what it did not create.
    if full {
        data.events.retain(|e| {
            if e.calendar_id != calendar_id {
                return true;
            }
            let href = extra_str(&e.extra, CALDAV_HREF_KEY);
            href.is_empty() || seen_hrefs.contains(&href)
        });
    }

    data.normalize();
    Ok(())
}

/// Record what a **push** made true: the resource URL a local row now lives at
/// on the server, and the ETag the next conditional write must send.
///
/// This is the write half's counterpart to the merge, and it is deliberately the
/// *only* thing the push path writes into `calendar.json`. Nothing about the row
/// itself is touched: the bytes that went to the server were serialized from this
/// same row moments ago, so re-deriving them here would be a second opinion about
/// what was just sent, and the two could disagree.
///
/// An empty `etag` is stored as an empty string rather than skipped — that is the
/// state "the server accepted this but named no version", which the next write
/// has to be able to *see* in order to refuse itself (`put_resource` does), and
/// which the next sync clears. Leaving a stale ETag in place would be worse than
/// having none: it is a validator that no longer describes anything.
pub(crate) fn set_caldav_identity_at(
    path: &Path,
    kind: &str,
    row_id: &str,
    href: &str,
    etag: &str,
) -> Result<(), String> {
    transact(path, |data| {
        let extra = match kind {
            "event" => data
                .events
                .iter_mut()
                .find(|e| e.id == row_id)
                .map(|e| &mut e.extra),
            "task" => data
                .tasks
                .iter_mut()
                .find(|t| t.id == row_id)
                .map(|t| &mut t.extra),
            other => return Err(format!("unknown calendar row kind '{other}'")),
        }
        .ok_or_else(|| format!("no {kind} with id '{row_id}'"))?;

        extra.insert(
            CALDAV_HREF_KEY.to_string(),
            serde_json::Value::String(href.to_string()),
        );
        extra.insert(
            CALDAV_ETAG_KEY.to_string(),
            serde_json::Value::String(etag.to_string()),
        );
        Ok(())
    })
    .map(|_| ())
}

// ── ICS file I/O ────────────────────────────────────────────────────────────
//
// Import/export need to touch a path *outside* any project — wherever the user
// pointed the file dialog. The general-purpose `fs::read_file_text` /
// `write_file_text` commands deliberately refuse that: they confine every path to
// the current project's roots, precisely so a compromised renderer cannot read
// `~/.ssh/id_rsa` or overwrite arbitrary files (Security #1). That confinement is
// worth keeping, so instead of widening it these two commands open a much narrower
// door: an iCalendar file, and nothing else.
//
// The guards are the door's width — an extension allowlist (so the path cannot
// name a key, a config, or a document) and a size cap (so a "calendar" cannot be
// used to slurp a huge file into the renderer). Parsing itself stays in the
// frontend (`src/lib/calendar/ics.ts`), where it is unit-tested; these only move bytes.

/// Extensions an ICS path may carry. Anything else is refused outright.
const ICS_EXTENSIONS: [&str; 3] = ["ics", "ical", "ifb"];

/// Size cap for an imported/exported calendar (8 MiB — a decade of events is a
/// few hundred KiB, so this is generous while still bounding the read).
const MAX_ICS_BYTES: u64 = 8 * 1024 * 1024;

fn check_ics_path(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !ICS_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "not a calendar file: expected one of {}, got '{}'",
            ICS_EXTENSIONS.join(", "),
            if ext.is_empty() { "no extension" } else { &ext }
        ));
    }
    Ok(())
}

/// Offload a blocking calendar-store body to a worker thread. Every command
/// below is a whole-file read (or read-modify-write) of `calendar.json` —
/// written on every board drag — plus the user-picked `.ics` reads/writes; run
/// synchronously on the main thread that turns into jank as CalDAV calendars
/// grow (the freeze class `commands::git`'s `run_off_thread` doc describes).
/// The `*_at` bodies stay sync and directly unit-testable.
async fn run_off_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("calendar task failed: {e}"))?
}

/// Read an `.ics` file the user picked, for the frontend parser.
#[tauri::command]
pub async fn calendar_read_ics(path: String) -> Result<String, String> {
    run_off_thread(move || calendar_read_ics_blocking(path)).await
}

fn calendar_read_ics_blocking(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    check_ics_path(&p)?;

    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if meta.len() > MAX_ICS_BYTES {
        return Err(format!(
            "calendar file too large ({} bytes; limit {MAX_ICS_BYTES})",
            meta.len()
        ));
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// Write an `.ics` file to the path the user picked.
#[tauri::command]
pub async fn calendar_write_ics(path: String, content: String) -> Result<(), String> {
    run_off_thread(move || calendar_write_ics_blocking(path, content)).await
}

fn calendar_write_ics_blocking(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    check_ics_path(&p)?;
    if content.len() as u64 > MAX_ICS_BYTES {
        return Err("calendar export too large".to_string());
    }
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

/// Fetch an `.ics` subscription feed (e.g. TimeTree's calendar-export URL) for
/// the frontend parser. This is the one command in this file that reaches the
/// network, and it does so only on an explicit "Refresh from URL" click —
/// never on a timer — through the same SSRF-guarded fetch the in-app browser's
/// reader mode uses (`services::browser_engine::fetch_ics`).
#[tauri::command]
pub async fn calendar_fetch_ics(url: String) -> Result<String, String> {
    crate::services::browser_engine::fetch_ics(&url).await
}

/// Claim reminders as fired before showing them (headless owner plan, H2):
/// answers the keys nobody had claimed yet — another window, or the Mobile
/// sidecar with no window open, may have shown one already — and records
/// them all (`services::calendar_alarms`).
#[tauri::command]
pub fn calendar_alarms_claim(keys: Vec<String>) -> Result<Vec<String>, String> {
    crate::services::calendar_alarms::claim(&keys)
}

/// Replace `calendar_id`'s events/tasks with a freshly parsed set, in one
/// atomic write.
#[tauri::command]
pub async fn calendar_replace_events(
    calendar_id: String,
    events: Vec<CalendarEvent>,
    tasks: Vec<CalendarTask>,
) -> Result<CalendarData, String> {
    run_off_thread(move || replace_calendar_events_at(&calendar_path(), &calendar_id, events, tasks))
        .await
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn calendar_load() -> Result<CalendarData, String> {
    run_off_thread(move || read_data(&calendar_path())).await
}

/// Replace the whole store. Used by ICS import, which rewrites in bulk.
#[tauri::command]
pub async fn calendar_save(data: CalendarData) -> Result<(), String> {
    run_off_thread(move || save_document_at(&calendar_path(), data)).await
}

/// Replace the whole store with `data` — the one whole-document write, and
/// therefore the one that must carry the revision it was loaded at: a
/// document loaded before another writer's edit is refused rather than
/// written over it (#171). The caller reloads and re-applies its change.
pub(crate) fn save_document_at(path: &Path, data: CalendarData) -> Result<(), String> {
    transact(path, |current| {
        if data.rev != current.rev {
            return Err(
                "calendar changed on disk since it was loaded; reload and apply the edit again"
                    .to_string(),
            );
        }
        *current = data.clone();
        current.normalize();
        Ok(())
    })
    .map(|_| ())
}

#[tauri::command]
pub async fn create_event(event: CalendarEvent) -> Result<CalendarEvent, String> {
    run_off_thread(move || create_event_at(&calendar_path(), event)).await
}

#[tauri::command]
pub async fn update_event(event: CalendarEvent) -> Result<CalendarEvent, String> {
    run_off_thread(move || update_event_at(&calendar_path(), event)).await
}

#[tauri::command]
pub async fn delete_event(id: String) -> Result<(), String> {
    run_off_thread(move || delete_event_at(&calendar_path(), &id)).await
}

#[tauri::command]
pub async fn create_task(task: CalendarTask) -> Result<CalendarTask, String> {
    run_off_thread(move || create_task_at(&calendar_path(), task)).await
}

#[tauri::command]
pub async fn update_task(task: CalendarTask) -> Result<CalendarTask, String> {
    run_off_thread(move || update_task_at(&calendar_path(), task)).await
}

#[tauri::command]
pub async fn delete_task(id: String) -> Result<(), String> {
    run_off_thread(move || delete_task_at(&calendar_path(), &id)).await
}

/// Apply a board drag. See [`move_tasks_at`].
#[tauri::command]
pub async fn todo_move_tasks(moves: Vec<TaskPlacement>) -> Result<Vec<CalendarTask>, String> {
    run_off_thread(move || move_tasks_at(&calendar_path(), moves)).await
}

/// Replace the board's columns. See [`columns_set_at`].
#[tauri::command]
pub async fn todo_columns_set(
    columns: Vec<TaskColumn>,
    fallback_column: Option<String>,
) -> Result<CalendarData, String> {
    run_off_thread(move || columns_set_at(&calendar_path(), columns, fallback_column)).await
}

#[tauri::command]
pub async fn create_calendar(calendar: Calendar) -> Result<Calendar, String> {
    run_off_thread(move || create_calendar_at(&calendar_path(), calendar)).await
}

#[tauri::command]
pub async fn update_calendar(calendar: Calendar) -> Result<Calendar, String> {
    run_off_thread(move || update_calendar_at(&calendar_path(), calendar)).await
}

#[tauri::command]
pub async fn delete_calendar(id: String) -> Result<(), String> {
    run_off_thread(move || delete_calendar_at(&calendar_path(), &id)).await
}

/// Undo of [`delete_calendar`]. See [`restore_calendar_at`].
#[tauri::command]
pub async fn restore_calendar(
    calendar: Calendar,
    events: Vec<CalendarEvent>,
    tasks: Vec<CalendarTask>,
) -> Result<CalendarData, String> {
    run_off_thread(move || restore_calendar_at(&calendar_path(), calendar, events, tasks)).await
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::calendar::{Subtask, TaskFileLink};
    use std::collections::HashMap;

    fn tmp_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calendar.json");
        (dir, path)
    }

    fn event(title: &str, start: &str, end: &str) -> CalendarEvent {
        CalendarEvent {
            title: title.into(),
            start: start.into(),
            end: end.into(),
            ..Default::default()
        }
    }

    #[test]
    fn concurrent_calendar_edits_do_not_lose_rows() {
        let (_dir, path) = tmp_path();
        let path = std::sync::Arc::new(path);
        let mut threads = Vec::new();
        for i in 0..12 {
            let path = path.clone();
            threads.push(std::thread::spawn(move || {
                create_event_at(
                    path.as_ref(),
                    event(
                        &format!("event-{i}"),
                        "2026-08-28T10:00:00Z",
                        "2026-08-28T11:00:00Z",
                    ),
                )
                .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }

        let data = read_data(path.as_ref()).unwrap();
        assert_eq!(data.events.len(), 12);
    }

    // ── Compare-and-swap (#171) ─────────────────────────────────────────

    /// Two writers read the same file; the first commits, the second is
    /// rejected rather than clobbering, and its retry against fresh state
    /// lands with both edits intact.
    #[test]
    fn interleaved_read_modify_writes_reject_the_stale_one_and_keep_both_edits() {
        let (_dir, path) = tmp_path();
        let base = read_data(&path).unwrap();
        assert_eq!(base.rev, 0, "a missing file is revision 0");

        let mut a = base.clone();
        a.events.push(event("a", "2026-07-08T09:00", "2026-07-08T10:00"));
        assert_eq!(commit(&path, &base, &mut a).unwrap(), Commit::Committed);

        // B read the same base as A, so its write would erase A's event.
        let mut b = base.clone();
        b.events.push(event("b", "2026-07-08T11:00", "2026-07-08T12:00"));
        assert_eq!(commit(&path, &base, &mut b).unwrap(), Commit::Stale);
        let on_disk = read_data(&path).unwrap();
        assert_eq!(on_disk.events.len(), 1, "the rejected write touched nothing");
        assert_eq!(on_disk.events[0].title, "a");

        // B retries from what is on disk now.
        let fresh = read_data(&path).unwrap();
        let mut b = fresh.clone();
        b.events.push(event("b", "2026-07-08T11:00", "2026-07-08T12:00"));
        assert_eq!(commit(&path, &fresh, &mut b).unwrap(), Commit::Committed);

        let final_state = read_data(&path).unwrap();
        let mut titles: Vec<&str> = final_state.events.iter().map(|e| e.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, vec!["a", "b"]);
        assert_eq!(final_state.rev, 2, "one bump per committed write");
    }

    /// `transact` does the retry itself: an edit whose commit finds the file
    /// moved on (here: another process wrote between the read and the
    /// commit) is re-run against the fresh state, and nothing is lost.
    #[test]
    fn transact_reapplies_the_edit_when_another_process_wrote_in_between() {
        let (_dir, path) = tmp_path();
        create_event_at(&path, event("first", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();

        let runs = std::cell::Cell::new(0);
        let ((), data) = transact(&path, |data| {
            runs.set(runs.get() + 1);
            if runs.get() == 1 {
                // Another process: reads the file, adds a row, writes it back
                // with the next revision — without our in-process lock.
                let mut other = read_data(&path).unwrap();
                other.events.push(event("other", "2026-07-09T09:00", "2026-07-09T10:00"));
                other.rev += 1;
                write_data(&path, &other).unwrap();
            }
            data.events.push(event("mine", "2026-07-10T09:00", "2026-07-10T10:00"));
            data.normalize();
            Ok(())
        })
        .unwrap();

        assert_eq!(runs.get(), 2, "the first attempt was rejected and re-run");
        let mut titles: Vec<&str> = data.events.iter().map(|e| e.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, vec!["first", "mine", "other"]);
        assert_eq!(read_data(&path).unwrap(), data, "the returned state is what reached disk");
    }

    /// Every write moves the file's revision; a record's revision moves only
    /// when that record changed, whatever number the caller's copy carried.
    #[test]
    fn revisions_are_stamped_per_changed_record_and_per_write() {
        let (_dir, path) = tmp_path();
        let a = create_event_at(&path, event("a", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();
        let b = create_event_at(&path, event("b", "2026-07-08T11:00", "2026-07-08T12:00")).unwrap();
        assert_eq!((a.rev, b.rev), (1, 1));
        assert_eq!(read_data(&path).unwrap().rev, 2);

        let mut edited = a.clone();
        edited.title = "a2".into();
        edited.rev = 99; // the store decides, not the caller
        let stored = update_event_at(&path, edited).unwrap();
        assert_eq!(stored.rev, 2);
        let data = read_data(&path).unwrap();
        assert_eq!(data.rev, 3);
        assert_eq!(data.events.iter().find(|e| e.id == b.id).unwrap().rev, 1, "untouched row keeps its revision");

        // An edit that changes nothing writes nothing.
        let unchanged = update_event_at(&path, stored.clone()).unwrap();
        assert_eq!(unchanged.rev, 2);
        assert_eq!(read_data(&path).unwrap().rev, 3);
    }

    /// A whole-document save carries the revision it was loaded at: a stale
    /// one is refused instead of written over a newer file.
    #[test]
    fn whole_document_save_is_refused_when_the_file_moved_on() {
        let (_dir, path) = tmp_path();
        create_event_at(&path, event("a", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();
        let loaded = read_data(&path).unwrap();

        // Someone else edits in the meantime.
        create_event_at(&path, event("b", "2026-07-08T11:00", "2026-07-08T12:00")).unwrap();

        let mut stale = loaded.clone();
        stale.events[0].title = "renamed".into();
        let error = save_document_at(&path, stale).unwrap_err();
        assert!(error.contains("changed on disk"), "{error}");
        let data = read_data(&path).unwrap();
        assert_eq!(data.events.len(), 2, "b survived");
        assert_eq!(data.events[0].title, "a", "the stale rename never landed");

        // Reloaded and re-applied, it lands.
        let mut fresh = read_data(&path).unwrap();
        fresh.events[0].title = "renamed".into();
        save_document_at(&path, fresh).unwrap();
        assert_eq!(read_data(&path).unwrap().events[0].title, "renamed");
    }

    /// A file written before revisions existed reads as revision 0 and takes
    /// the first revision-aware write like any other; a legacy version-1
    /// array does the same.
    #[test]
    fn files_without_revisions_round_trip_into_the_first_revision() {
        let (_dir, path) = tmp_path();
        std::fs::write(
            &path,
            r##"{"version":3,"calendars":[{"id":"cal","name":"Cal","color":"#fff"}],"events":[{"id":"e1","calendar_id":"cal","start":"2026-07-08T09:00","end":"2026-07-08T10:00","title":"old"}],"tasks":[]}"##,
        )
        .unwrap();
        let loaded = read_data(&path).unwrap();
        assert_eq!((loaded.rev, loaded.events[0].rev, loaded.calendars[0].rev), (0, 0, 0));
        assert_eq!(on_disk_rev(&path), 0);

        create_event_at(&path, event("new", "2026-07-09T09:00", "2026-07-09T10:00")).unwrap();
        let data = read_data(&path).unwrap();
        assert_eq!(data.rev, 1);
        assert_eq!(data.events.iter().find(|e| e.id == "e1").unwrap().rev, 0, "an untouched legacy row is still unversioned");
        assert_eq!(data.events.iter().find(|e| e.title == "new").unwrap().rev, 1);

        let (_dir, legacy) = tmp_path();
        std::fs::write(&legacy, r#"[{"id":"v1","date":"2026-07-08","time":"09:00","title":"v1"}]"#).unwrap();
        assert_eq!(on_disk_rev(&legacy), 0);
        create_event_at(&legacy, event("new", "2026-07-09T09:00", "2026-07-09T10:00")).unwrap();
        let data = read_data(&legacy).unwrap();
        assert_eq!(data.rev, 1);
        assert_eq!(data.events.len(), 2);
    }

    #[test]
    fn read_missing_file_is_an_empty_default_calendar() {
        let (_dir, path) = tmp_path();
        let data = read_data(&path).unwrap();
        assert!(data.events.is_empty());
        assert!(data.tasks.is_empty());
        assert_eq!(data.calendars.len(), 1, "a default calendar always exists");
    }

    #[test]
    fn create_then_read_roundtrips() {
        let (_dir, path) = tmp_path();
        let ev = create_event_at(
            &path,
            event("standup", "2026-07-08T09:00", "2026-07-08T09:15"),
        )
        .unwrap();
        assert!(!ev.id.is_empty());

        let data = read_data(&path).unwrap();
        assert_eq!(data.events.len(), 1);
        assert_eq!(data.events[0].title, "standup");
        assert_eq!(data.events[0].start, "2026-07-08T09:00");
        assert_eq!(data.events[0].end, "2026-07-08T09:15");
        assert_eq!(data.events[0].calendar_id, DEFAULT_CALENDAR_ID);
    }

    #[test]
    fn create_mints_unique_ids_and_ignores_caller_id() {
        let (_dir, path) = tmp_path();
        let mut forged = event("a", "2026-07-08T09:00", "2026-07-08T10:00");
        forged.id = "forged".into();
        let a = create_event_at(&path, forged).unwrap();
        let b = create_event_at(&path, event("b", "2026-07-08T11:00", "2026-07-08T12:00")).unwrap();
        assert_ne!(a.id, "forged", "the store owns identity");
        assert_ne!(a.id, b.id);
        assert_eq!(read_data(&path).unwrap().events.len(), 2);
    }

    #[test]
    fn update_replaces_the_event() {
        let (_dir, path) = tmp_path();
        let ev =
            create_event_at(&path, event("old", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();

        let mut edited = ev.clone();
        edited.title = "new".into();
        edited.start = "2026-07-09T10:30".into();
        edited.end = "2026-07-09T11:30".into();
        edited.location = "room 2".into();
        let out = update_event_at(&path, edited).unwrap();

        assert_eq!(out.title, "new");
        let data = read_data(&path).unwrap();
        assert_eq!(data.events.len(), 1);
        assert_eq!(data.events[0].title, "new");
        assert_eq!(data.events[0].start, "2026-07-09T10:30");
        assert_eq!(data.events[0].location, "room 2");
    }

    #[test]
    fn update_missing_id_errors() {
        let (_dir, path) = tmp_path();
        let mut ghost = event("x", "2026-07-08T09:00", "2026-07-08T10:00");
        ghost.id = "nope".into();
        assert!(update_event_at(&path, ghost).is_err());
    }

    #[test]
    fn delete_removes_the_event() {
        let (_dir, path) = tmp_path();
        let ev =
            create_event_at(&path, event("x", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();
        delete_event_at(&path, &ev.id).unwrap();
        assert!(read_data(&path).unwrap().events.is_empty());
    }

    #[test]
    fn delete_missing_id_errors() {
        let (_dir, path) = tmp_path();
        assert!(delete_event_at(&path, "nope").is_err());
    }

    #[test]
    fn task_crud_roundtrips() {
        let (_dir, path) = tmp_path();
        let t = create_task_at(
            &path,
            CalendarTask {
                title: "write plan".into(),
                due: Some("2026-07-10".into()),
                priority: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!t.id.is_empty());

        let mut done = t.clone();
        done.percent = 100;
        done.completed = Some("2026-07-09T12:00".into());
        update_task_at(&path, done).unwrap();

        let data = read_data(&path).unwrap();
        assert_eq!(data.tasks.len(), 1);
        assert_eq!(data.tasks[0].percent, 100);
        assert_eq!(data.tasks[0].completed.as_deref(), Some("2026-07-09T12:00"));

        delete_task_at(&path, &t.id).unwrap();
        assert!(read_data(&path).unwrap().tasks.is_empty());
    }

    #[test]
    fn calendar_crud_roundtrips() {
        let (_dir, path) = tmp_path();
        let cal = create_calendar_at(
            &path,
            Calendar {
                rev: 0,
                id: String::new(),
                name: "Work".into(),
                color: "#ff0000".into(),
                visible: true,
                readonly: false,
                extra: Default::default(),
            },
        )
        .unwrap();

        let data = read_data(&path).unwrap();
        assert_eq!(data.calendars.len(), 2, "default + Work");

        let mut hidden = cal.clone();
        hidden.visible = false;
        update_calendar_at(&path, hidden).unwrap();
        let data = read_data(&path).unwrap();
        assert!(
            !data
                .calendars
                .iter()
                .find(|c| c.id == cal.id)
                .unwrap()
                .visible
        );
    }

    #[test]
    fn deleting_a_calendar_takes_its_events_and_tasks_with_it() {
        let (_dir, path) = tmp_path();
        let cal = create_calendar_at(
            &path,
            Calendar {
                rev: 0,
                id: String::new(),
                name: "Work".into(),
                color: "#ff0000".into(),
                visible: true,
                readonly: false,
                extra: Default::default(),
            },
        )
        .unwrap();

        let mut in_work = event("meeting", "2026-07-08T09:00", "2026-07-08T10:00");
        in_work.calendar_id = cal.id.clone();
        create_event_at(&path, in_work).unwrap();
        create_event_at(
            &path,
            event("personal", "2026-07-08T18:00", "2026-07-08T19:00"),
        )
        .unwrap();

        delete_calendar_at(&path, &cal.id).unwrap();

        let data = read_data(&path).unwrap();
        assert_eq!(data.calendars.len(), 1);
        assert_eq!(data.events.len(), 1, "only the Work event is gone");
        assert_eq!(data.events[0].title, "personal");
    }

    #[test]
    fn restoring_a_deleted_calendar_brings_its_events_back() {
        let (_dir, path) = tmp_path();
        let mut cal = read_data(&path).unwrap().calendars[0].clone();
        cal.name = "Work".to_string();
        let cal = create_calendar_at(&path, cal).unwrap();
        let mut in_work = event("meeting", "2026-07-08T09:00", "2026-07-08T10:00");
        in_work.calendar_id = cal.id.clone();
        let in_work = create_event_at(&path, in_work).unwrap();

        delete_calendar_at(&path, &cal.id).unwrap();
        // An id reused while the calendar was gone must not be clobbered.
        let mut data = read_data(&path).unwrap();
        let mut squatter = event("squatter", "2026-07-09T09:00", "2026-07-09T10:00");
        squatter.id = in_work.id.clone();
        squatter.calendar_id = data.calendars[0].id.clone();
        data.events.push(squatter);
        write_data(&path, &data).unwrap();

        let data = restore_calendar_at(&path, cal.clone(), vec![in_work.clone()], vec![]).unwrap();
        assert!(data.calendars.iter().any(|c| c.id == cal.id));
        let restored: Vec<_> = data.events.iter().filter(|e| e.calendar_id == cal.id).collect();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].title, "meeting");
        assert_ne!(restored[0].id, in_work.id, "the squatter keeps the id");
        assert_eq!(data.events.len(), 2);

        assert!(restore_calendar_at(&path, cal, vec![], vec![]).is_err(), "no double restore");
    }

    #[test]
    fn cannot_delete_the_last_calendar() {
        let (_dir, path) = tmp_path();
        let data = read_data(&path).unwrap();
        let only = data.calendars[0].id.clone();
        // Writing first, so the file exists with exactly one calendar.
        write_data(&path, &data).unwrap();
        assert!(delete_calendar_at(&path, &only).is_err());
    }

    #[test]
    fn legacy_file_migrates_on_read() {
        let (_dir, path) = tmp_path();
        std::fs::write(
            &path,
            r#"[
                {"id":"a","date":"2026-07-08","time":"09:00","title":"standup","notes":"daily"},
                {"id":"b","date":"2026-07-09","time":"","title":"holiday"}
            ]"#,
        )
        .unwrap();

        let data = read_data(&path).unwrap();
        assert_eq!(data.events.len(), 2);

        let standup = data.events.iter().find(|e| e.title == "standup").unwrap();
        assert_eq!(standup.start, "2026-07-08T09:00");
        assert_eq!(standup.end, "2026-07-08T10:00");
        assert!(!standup.all_day);
        assert_eq!(standup.notes, "daily");

        let holiday = data.events.iter().find(|e| e.title == "holiday").unwrap();
        assert!(holiday.all_day);
        assert_eq!(holiday.start, "2026-07-09");
        assert_eq!(holiday.end, "2026-07-10");
    }

    #[test]
    fn legacy_file_is_rewritten_in_the_current_shape() {
        let (_dir, path) = tmp_path();
        std::fs::write(
            &path,
            r#"[{"id":"a","date":"2026-07-08","time":"09:00","title":"standup"}]"#,
        )
        .unwrap();

        // Any write path (here: adding an event) upgrades the file on disk.
        create_event_at(&path, event("new", "2026-07-10T09:00", "2026-07-10T10:00")).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("\"version\""),
            "upgraded file carries a version: {raw}"
        );
        let data = read_data(&path).unwrap();
        assert_eq!(
            data.events.len(),
            2,
            "the migrated event survives the write"
        );
    }

    #[test]
    fn ics_path_guard_accepts_calendar_extensions() {
        for ok in ["a.ics", "a.ical", "a.ifb", "A.ICS"] {
            assert!(
                check_ics_path(Path::new(ok)).is_ok(),
                "{ok} should be accepted"
            );
        }
    }

    #[test]
    fn ics_path_guard_refuses_anything_else() {
        // The whole point of the guard: an ICS command must not become a
        // read-any-file primitive.
        for bad in [
            "id_rsa",
            "/home/u/.ssh/id_rsa",
            "notes.txt",
            "a.ics.txt",
            "config.toml",
        ] {
            assert!(
                check_ics_path(Path::new(bad)).is_err(),
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn read_ics_refuses_a_non_ics_path() {
        let (dir, _) = tmp_path();
        let secret = dir.path().join("id_rsa");
        std::fs::write(&secret, "PRIVATE KEY").unwrap();
        let err = calendar_read_ics_blocking(secret.to_string_lossy().into_owned());
        assert!(err.is_err(), "a non-.ics path must be refused");
    }

    #[test]
    fn read_ics_roundtrips_a_calendar_file() {
        let (dir, _) = tmp_path();
        let ics = dir.path().join("cal.ics");
        std::fs::write(&ics, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").unwrap();
        let text = calendar_read_ics_blocking(ics.to_string_lossy().into_owned()).unwrap();
        assert!(text.contains("VCALENDAR"));
    }

    #[test]
    fn write_ics_refuses_a_non_ics_path() {
        let (dir, _) = tmp_path();
        let target = dir.path().join("important.conf");
        assert!(calendar_write_ics_blocking(target.to_string_lossy().into_owned(), "x".into()).is_err());
        assert!(!target.exists(), "the refused write must not have happened");
    }

    #[test]
    fn empty_optional_fields_are_omitted_from_the_file() {
        let (_dir, path) = tmp_path();
        create_event_at(&path, event("x", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("\"notes\""),
            "empty notes must be skipped: {raw}"
        );
        assert!(
            !raw.contains("\"location\""),
            "empty location must be skipped: {raw}"
        );
        assert!(
            !raw.contains("\"rrule\""),
            "absent rrule must be skipped: {raw}"
        );
        assert!(
            !raw.contains("\"column\""),
            "board fields must be skipped: {raw}"
        );
        assert!(
            !raw.contains("\"task_columns\""),
            "unused board must be skipped: {raw}"
        );
    }

    // ── Todo board ──────────────────────────────────────────────────────────

    /// Give the store a board, as the first drag or column edit would. Creating a
    /// task deliberately does *not* — `create_task` is also the calendar Tasks
    /// view's write path, and a plain to-do must not conjure a board.
    fn seed_board(path: &Path) {
        let mut data = read_data(path).unwrap();
        data.ensure_board();
        data.normalize();
        write_data(path, &data).unwrap();
    }

    fn card(path: &Path, title: &str) -> CalendarTask {
        seed_board(path);
        create_task_at(
            path,
            CalendarTask {
                title: title.into(),
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn place(id: &str, column: &str, index: u32) -> TaskPlacement {
        TaskPlacement {
            id: id.into(),
            column: column.into(),
            index,
            completed_stamp: Some("2026-07-28T12:00".into()),
        }
    }

    /// The ids of one column, top to bottom, as the board would draw them.
    fn order_of(path: &Path, column: &str) -> Vec<String> {
        let data = read_data(path).unwrap();
        column_order(&data, column, "")
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    }

    #[test]
    fn create_task_returns_the_normalized_record() {
        let (_dir, path) = tmp_path();
        let t = card(&path, "fresh");
        assert_eq!(t.column, "backlog", "a new card must come back placed");
        assert!(t.rank.is_some(), "a new card must come back ranked");
    }

    #[test]
    fn update_task_returns_the_reconciled_record() {
        let (_dir, path) = tmp_path();
        let t = card(&path, "t");
        let out = update_task_at(&path, CalendarTask { percent: 100, ..t }).unwrap();
        assert_eq!(out.column, "done", "ticking must return the moved card");
    }

    #[test]
    fn move_places_at_the_requested_index() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        let b = card(&path, "b");
        let c = card(&path, "c");
        assert_eq!(
            order_of(&path, "backlog"),
            vec![a.id.clone(), b.id.clone(), c.id.clone()]
        );

        // c to the top.
        move_tasks_at(&path, vec![place(&c.id, "backlog", 0)]).unwrap();
        assert_eq!(
            order_of(&path, "backlog"),
            vec![c.id.clone(), a.id.clone(), b.id.clone()]
        );

        // a to the middle.
        move_tasks_at(&path, vec![place(&a.id, "backlog", 1)]).unwrap();
        assert_eq!(
            order_of(&path, "backlog"),
            vec![c.id.clone(), a.id.clone(), b.id.clone()]
        );

        // c past the end appends.
        move_tasks_at(&path, vec![place(&c.id, "backlog", 999)]).unwrap();
        assert_eq!(order_of(&path, "backlog"), vec![a.id, b.id, c.id]);
    }

    #[test]
    fn move_across_columns_is_one_write() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        let b = card(&path, "b");
        let changed = move_tasks_at(
            &path,
            vec![place(&a.id, "doing", 0), place(&b.id, "doing", 0)],
        )
        .unwrap();
        assert_eq!(changed.len(), 2);
        assert_eq!(order_of(&path, "doing"), vec![b.id, a.id]);
        assert!(order_of(&path, "backlog").is_empty());
    }

    #[test]
    fn move_is_idempotent() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        let b = card(&path, "b");
        move_tasks_at(&path, vec![place(&b.id, "doing", 0)]).unwrap();
        let after_first = read_data(&path).unwrap();

        let changed = move_tasks_at(&path, vec![place(&b.id, "doing", 0)]).unwrap();
        assert!(changed.is_empty(), "a replayed placement changes nothing");
        assert_eq!(read_data(&path).unwrap(), after_first);
        assert_eq!(order_of(&path, "backlog"), vec![a.id]);
    }

    #[test]
    fn move_reindexes_when_ranks_collide() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        let b = card(&path, "b");
        // Force two ranks too close to split.
        let mut data = read_data(&path).unwrap();
        for t in data.tasks.iter_mut() {
            t.rank = Some(if t.id == a.id { 1.0 } else { 1.0 + 1e-9 });
        }
        write_data(&path, &data).unwrap();

        let c = card(&path, "c");
        move_tasks_at(&path, vec![place(&c.id, "backlog", 1)]).unwrap();

        let data = read_data(&path).unwrap();
        for t in data.tasks.iter() {
            let rank = t.rank.unwrap();
            assert_eq!(
                rank % RANK_GAP,
                0.0,
                "a collapsed column is reindexed to clean multiples, got {rank}"
            );
        }
        assert_eq!(order_of(&path, "backlog"), vec![a.id, c.id, b.id]);
    }

    #[test]
    fn dropping_on_done_completes_and_dragging_out_uncompletes() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");

        move_tasks_at(&path, vec![place(&a.id, "done", 0)]).unwrap();
        let data = read_data(&path).unwrap();
        assert_eq!(data.tasks[0].percent, 100);
        assert_eq!(data.tasks[0].completed.as_deref(), Some("2026-07-28T12:00"));

        move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();
        let data = read_data(&path).unwrap();
        assert_eq!(data.tasks[0].percent, 0);
        assert_eq!(data.tasks[0].completed, None, "the stamp must go too");
        assert_eq!(data.tasks[0].column, "doing");
    }

    #[test]
    fn move_returns_every_changed_task_not_just_the_dragged_one() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        let b = card(&path, "b");
        let mut data = read_data(&path).unwrap();
        for t in data.tasks.iter_mut() {
            t.rank = Some(if t.id == a.id { 1.0 } else { 1.0 + 1e-9 });
        }
        write_data(&path, &data).unwrap();

        let c = card(&path, "c");
        let changed = move_tasks_at(&path, vec![place(&c.id, "backlog", 1)]).unwrap();
        let ids: HashSet<&str> = changed.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(a.id.as_str()) && ids.contains(b.id.as_str()));
    }

    #[test]
    fn move_refiles_an_unknown_target_column_rather_than_refusing() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        move_tasks_at(&path, vec![place(&a.id, "no-such-column", 0)]).unwrap();
        assert_eq!(read_data(&path).unwrap().tasks[0].column, "backlog");
    }

    #[test]
    fn columns_set_refiles_the_cards_of_a_deleted_column() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();

        let kept: Vec<TaskColumn> = read_data(&path)
            .unwrap()
            .task_columns
            .into_iter()
            .filter(|c| c.id != "doing")
            .collect();
        let data = columns_set_at(&path, kept, None).unwrap();
        assert_eq!(data.tasks[0].column, "backlog");
        assert!(!data.task_columns.iter().any(|c| c.id == "doing"));
    }

    #[test]
    fn columns_set_honours_an_explicit_fallback() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();
        let kept: Vec<TaskColumn> = read_data(&path)
            .unwrap()
            .task_columns
            .into_iter()
            .filter(|c| c.id != "doing")
            .collect();
        let data = columns_set_at(&path, kept, Some("today".into())).unwrap();
        assert_eq!(data.tasks[0].column, "today");
    }

    #[test]
    fn columns_set_refuses_an_empty_list() {
        let (_dir, path) = tmp_path();
        card(&path, "a");
        assert!(columns_set_at(&path, Vec::new(), None).is_err());
        assert_eq!(
            read_data(&path).unwrap().task_columns.len(),
            6,
            "the refused edit must leave the board alone"
        );
    }

    /// The other half of the lazy-seeding rule, at the command layer: a to-do
    /// created from the calendar's Tasks view must not grow board state.
    #[test]
    fn creating_a_task_does_not_create_a_board() {
        let (_dir, path) = tmp_path();
        create_task_at(
            &path,
            CalendarTask {
                title: "plain".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let data = read_data(&path).unwrap();
        assert!(data.task_columns.is_empty());
        assert!(data.tasks[0].column.is_empty());
    }

    #[test]
    fn columns_set_preserves_a_renamed_columns_cards() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();

        let renamed: Vec<TaskColumn> = read_data(&path)
            .unwrap()
            .task_columns
            .into_iter()
            .map(|mut c| {
                if c.id == "doing" {
                    c.name = "In flight".into();
                }
                c
            })
            .collect();
        let data = columns_set_at(&path, renamed, None).unwrap();
        assert_eq!(
            data.tasks[0].column, "doing",
            "a rename must not move a card"
        );
        assert!(data.task_columns.iter().any(|c| c.name == "In flight"));
    }

    #[test]
    fn columns_set_mints_ids_for_new_columns() {
        let (_dir, path) = tmp_path();
        let mut columns = read_data(&path).unwrap().task_columns;
        columns.push(TaskColumn {
            id: String::new(),
            name: "Blocked".into(),
            position: 9,
            ..Default::default()
        });
        let data = columns_set_at(&path, columns, None).unwrap();
        let added = data
            .task_columns
            .iter()
            .find(|c| c.name == "Blocked")
            .unwrap();
        assert!(!added.id.is_empty(), "a new column must be given an id");
    }

    // ── CalDAV reconciliation ────────────────────────────────────────────
    //
    // The property every one of these exists to protect: a sync that runs on a
    // timer must update what the server owns and touch nothing else. A single
    // regression here is invisible until a user finds their board reshuffled.

    fn caldav_calendar(path: &Path) -> String {
        create_calendar_at(
            path,
            Calendar {
                rev: 0,
                id: String::new(),
                name: "Work".into(),
                color: "#4aa3df".into(),
                visible: true,
                readonly: true,
                extra: HashMap::new(),
            },
        )
        .unwrap()
        .id
    }

    fn parsed_event(href: &str, etag: &str, title: &str, start: &str) -> CalDavParsed {
        CalDavParsed {
            href: href.into(),
            etag: etag.into(),
            events: vec![CalendarEvent {
                title: title.into(),
                start: start.into(),
                end: format!("{start}:00").replace("::00", ":00"),
                ..Default::default()
            }],
            tasks: Vec::new(),
        }
    }

    fn parsed_task(href: &str, etag: &str, title: &str, percent: u8) -> CalDavParsed {
        CalDavParsed {
            href: href.into(),
            etag: etag.into(),
            events: Vec::new(),
            tasks: vec![CalendarTask {
                title: title.into(),
                percent,
                ..Default::default()
            }],
        }
    }

    #[test]
    fn a_first_sync_creates_rows_and_stamps_their_resource_identity() {
        let (_dir, path) = tmp_path();
        let cal = caldav_calendar(&path);
        let data = merge_caldav_calendar_at(
            &path,
            &cal,
            vec![
                parsed_event("https://d/e/a.ics", "\"1\"", "standup", "2026-07-08T09:00"),
                parsed_task("https://d/e/t.ics", "\"2\"", "write it up", 0),
            ],
            &[],
            true,
        )
        .unwrap();

        assert_eq!(data.events.len(), 1);
        assert_eq!(data.tasks.len(), 1);
        let event = &data.events[0];
        assert!(!event.id.is_empty(), "the store owns identity");
        assert_eq!(event.calendar_id, cal);
        assert_eq!(
            extra_str(&event.extra, CALDAV_HREF_KEY),
            "https://d/e/a.ics"
        );
        assert_eq!(extra_str(&event.extra, CALDAV_ETAG_KEY), "\"1\"");
        assert_eq!(
            extra_str(&data.tasks[0].extra, CALDAV_HREF_KEY),
            "https://d/e/t.ics"
        );
    }

    #[test]
    fn a_push_stamps_the_resource_identity_onto_a_local_row() {
        let (_dir, path) = tmp_path();
        let cal = caldav_calendar(&path);
        let mut data = read_data(&path).unwrap();
        data.events.push(CalendarEvent {
            id: "e1".into(),
            calendar_id: cal.clone(),
            title: "written here".into(),
            start: "2026-08-01T09:00".into(),
            end: "2026-08-01T10:00".into(),
            ..Default::default()
        });
        write_data(&path, &data).unwrap();

        set_caldav_identity_at(&path, "event", "e1", "https://d/e/e1.ics", "\"7\"").unwrap();
        let after = read_data(&path).unwrap().events.remove(0);
        assert_eq!(
            extra_str(&after.extra, CALDAV_HREF_KEY),
            "https://d/e/e1.ics"
        );
        assert_eq!(extra_str(&after.extra, CALDAV_ETAG_KEY), "\"7\"");
        assert_eq!(
            after.title, "written here",
            "the row itself is not rewritten"
        );

        // A server that accepted the write but named no version must clear the
        // old validator, not keep one that no longer describes anything.
        set_caldav_identity_at(&path, "event", "e1", "https://d/e/e1.ics", "").unwrap();
        assert_eq!(
            extra_str(&read_data(&path).unwrap().events[0].extra, CALDAV_ETAG_KEY),
            ""
        );

        assert!(set_caldav_identity_at(&path, "event", "nope", "h", "e").is_err());
        assert!(set_caldav_identity_at(&path, "sheep", "e1", "h", "e").is_err());
    }

    #[test]
    fn a_second_sync_updates_the_server_fields_and_keeps_the_board_placement() {
        // THE test for this feature. `replace_calendar_events_at` would fail it,
        // which is the whole reason this function exists.
        let (_dir, path) = tmp_path();
        let cal = caldav_calendar(&path);
        merge_caldav_calendar_at(
            &path,
            &cal,
            vec![parsed_task("https://d/e/t.ics", "\"1\"", "draft", 0)],
            &[],
            true,
        )
        .unwrap();

        // The user drags the card, tags it, and adds a subtask.
        let mut task = read_data(&path).unwrap().tasks.remove(0);
        let id = task.id.clone();
        task.column = "doing".into();
        task.rank = Some(2048.0);
        task.tags = vec!["thesis".into()];
        task.subtasks = vec![Subtask {
            id: "s0".into(),
            title: "outline".into(),
            done: true,
            ..Default::default()
        }];
        task.project_id = "proj-1".into();
        task.file = Some(TaskFileLink {
            project_id: "proj-1".into(),
            path: "src/main.rs".into(),
            line: Some(42),
            text: "why?".into(),
        });
        task.created = "2026-07-01T08:00".into();
        update_task_at(&path, task).unwrap();

        // The server's copy is renamed and half-done.
        let data = merge_caldav_calendar_at(
            &path,
            &cal,
            vec![parsed_task("https://d/e/t.ics", "\"2\"", "draft (v2)", 50)],
            &[],
            true,
        )
        .unwrap();

        assert_eq!(
            data.tasks.len(),
            1,
            "a matched row is updated, not duplicated"
        );
        let after = &data.tasks[0];
        assert_eq!(
            after.id, id,
            "the id every other surface references survives"
        );
        assert_eq!(after.title, "draft (v2)", "the server owns the title");
        assert_eq!(after.percent, 50);
        assert_eq!(extra_str(&after.extra, CALDAV_ETAG_KEY), "\"2\"");
        assert_eq!(
            after.column, "doing",
            "the board column is the user's, not the server's"
        );
        assert_eq!(after.rank, Some(2048.0));
        assert_eq!(after.tags, vec!["thesis".to_string()]);
        assert_eq!(after.subtasks.len(), 1);
        assert_eq!(after.project_id, "proj-1");
        assert_eq!(after.file.as_ref().map(|f| f.path.as_str()), Some("src/main.rs"));
        assert_eq!(after.created, "2026-07-01T08:00");
    }

    #[test]
    fn a_new_task_is_placed_by_normalize_like_any_other() {
        let (_dir, path) = tmp_path();
        let cal = caldav_calendar(&path);
        // The board exists (its first write seeded the columns).
        let seed = card(&path, "local");
        move_tasks_at(&path, vec![place(&seed.id, "doing", 0)]).unwrap();

        let data = merge_caldav_calendar_at(
            &path,
            &cal,
            vec![parsed_task(
                "https://d/e/new.ics",
                "\"1\"",
                "from the server",
                0,
            )],
            &[],
            true,
        )
        .unwrap();
        let fresh = data
            .tasks
            .iter()
            .find(|t| t.title == "from the server")
            .unwrap();
        assert!(
            !fresh.column.is_empty(),
            "an unplaced card is filed by normalize"
        );
        assert!(fresh.rank.is_some());
    }

    #[test]
    fn an_explicit_deletion_removes_both_kinds() {
        let (_dir, path) = tmp_path();
        let cal = caldav_calendar(&path);
        merge_caldav_calendar_at(
            &path,
            &cal,
            vec![
                parsed_event(
                    "https://d/e/a.ics",
                    "\"1\"",
                    "gone soon",
                    "2026-07-08T09:00",
                ),
                parsed_task("https://d/e/t.ics", "\"1\"", "gone soon too", 0),
            ],
            &[],
            true,
        )
        .unwrap();

        let data = merge_caldav_calendar_at(
            &path,
            &cal,
            vec![],
            &[
                "https://d/e/a.ics".to_string(),
                "https://d/e/t.ics".to_string(),
            ],
            false,
        )
        .unwrap();
        assert!(data.events.is_empty());
        assert!(data.tasks.is_empty());
    }

    #[test]
    fn absence_from_a_full_listing_deletes_an_event_but_never_a_task() {
        // The ambiguity `docs/caldav_plan.md` refuses to guess at: a VTODO can
        // vanish from a `calendar-query` because it was deleted *or* because
        // the server stopped returning completed-and-old ones by default. An
        // event has no such filter, so its absence is trustworthy.
        let (_dir, path) = tmp_path();
        let cal = caldav_calendar(&path);
        merge_caldav_calendar_at(
            &path,
            &cal,
            vec![
                parsed_event("https://d/e/a.ics", "\"1\"", "meeting", "2026-07-08T09:00"),
                parsed_task("https://d/e/t.ics", "\"1\"", "todo", 100),
            ],
            &[],
            true,
        )
        .unwrap();

        let data = merge_caldav_calendar_at(&path, &cal, vec![], &[], true).unwrap();
        assert!(
            data.events.is_empty(),
            "an event absent from a full listing is gone"
        );
        assert_eq!(
            data.tasks.len(),
            1,
            "a task absent from a full listing is NOT deleted"
        );
    }

    #[test]
    fn absence_from_an_incremental_report_deletes_nothing() {
        let (_dir, path) = tmp_path();
        let cal = caldav_calendar(&path);
        merge_caldav_calendar_at(
            &path,
            &cal,
            vec![parsed_event(
                "https://d/e/a.ics",
                "\"1\"",
                "meeting",
                "2026-07-08T09:00",
            )],
            &[],
            true,
        )
        .unwrap();

        // `full: false` — unchanged resources are simply not in a sync-collection
        // reply, so treating absence as deletion would empty the calendar on the
        // first quiet interval.
        let data = merge_caldav_calendar_at(&path, &cal, vec![], &[], false).unwrap();
        assert_eq!(data.events.len(), 1);
    }

    #[test]
    fn a_sync_never_deletes_a_row_it_did_not_create() {
        let (_dir, path) = tmp_path();
        let cal = caldav_calendar(&path);
        let mut local = event("hand-made", "2026-07-08T09:00", "2026-07-08T10:00");
        local.calendar_id = cal.clone();
        create_event_at(&path, local).unwrap();

        let data = merge_caldav_calendar_at(&path, &cal, vec![], &[], true).unwrap();
        assert_eq!(
            data.events.len(),
            1,
            "a row with no caldav_href was not put there by a sync"
        );
    }

    #[test]
    fn a_resource_holding_a_series_and_its_override_matches_positionally() {
        // One CalDAV resource can hold a master VEVENT plus its RECURRENCE-ID
        // overrides — there is no separate occurrence object to fetch — so both
        // components arrive under one href.
        let (_dir, path) = tmp_path();
        let cal = caldav_calendar(&path);
        let series = CalDavParsed {
            href: "https://d/e/s.ics".into(),
            etag: "\"1\"".into(),
            events: vec![
                CalendarEvent {
                    title: "weekly".into(),
                    start: "2026-07-08T09:00".into(),
                    end: "2026-07-08T10:00".into(),
                    ..Default::default()
                },
                CalendarEvent {
                    title: "weekly (moved)".into(),
                    start: "2026-07-15T11:00".into(),
                    end: "2026-07-15T12:00".into(),
                    ..Default::default()
                },
            ],
            tasks: Vec::new(),
        };
        let data = merge_caldav_calendar_at(&path, &cal, vec![series.clone()], &[], true).unwrap();
        assert_eq!(data.events.len(), 2);
        let ids: Vec<String> = data.events.iter().map(|e| e.id.clone()).collect();

        // Second sync, same shape: both rows keep their ids.
        let data = merge_caldav_calendar_at(&path, &cal, vec![series], &[], true).unwrap();
        let after: Vec<String> = data.events.iter().map(|e| e.id.clone()).collect();
        assert_eq!(ids, after);

        // The override is removed upstream: the resource shrinks to one
        // component, and the orphaned local row goes with it.
        let shrunk = parsed_event("https://d/e/s.ics", "\"2\"", "weekly", "2026-07-08T09:00");
        let data = merge_caldav_calendar_at(&path, &cal, vec![shrunk], &[], true).unwrap();
        assert_eq!(data.events.len(), 1);
        assert_eq!(data.events[0].id, ids[0]);
    }

    #[test]
    fn merging_into_a_calendar_that_is_gone_is_an_error_not_a_silent_write() {
        let (_dir, path) = tmp_path();
        assert!(merge_caldav_calendar_at(&path, "no-such-calendar", vec![], &[], true).is_err());
    }

    /// The mail tripwire, mirrored: no board command may take a filesystem path.
    /// The two ICS commands are the documented exception — they exist precisely
    /// to open a narrow, extension-checked door to a user-picked file.
    #[test]
    fn no_todo_command_takes_a_path() {
        let src = include_str!("calendar.rs");
        for line in src.lines() {
            let line = line.trim();
            if !line.starts_with("pub fn todo_") {
                continue;
            }
            assert!(
                !line.contains("path"),
                "a todo command must not take a path: {line}"
            );
        }
    }
}
