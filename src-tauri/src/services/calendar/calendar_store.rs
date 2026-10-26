//! The native calendar store — a single global, local store of calendars, events and tasks.
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
//!
//! Moved down from `commands::calendar` (S5), which keeps the Tauri commands
//! and the ICS file door and re-exports this module.

use std::collections::HashSet;
use app_core::sync::LockExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;

use crate::storage::uuid_v4;
use crate::schema::caldav::{CalDavKept, CalDavParsed};
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
        .lock_ok()
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
    // On a file system without advisory locks the `rev` check alone guards.
    let _lock = storage::FileLock::exclusive_or_unlocked(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
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
        // Agents see shared calendars read-only (hosted plan §6.7): a
        // proposal naming one never writes, here or anywhere.
        if refuses_shared_rows(data) {
            return Err("An agent cannot write a shared calendar".to_string());
        }
        Ok(changes)
    })?;
    Ok(changes)
}

/// Does `data` hold a calendar, event or task that names a shared calendar
/// (`shared:<id>`)? Such a record never belongs in `calendar.json`.
pub(crate) fn refuses_shared_rows(data: &CalendarData) -> bool {
    use crate::services::server::shared_calendar::is_shared_id;
    data.calendars.iter().any(|c| is_shared_id(&c.id)) || data.events.iter().any(|e| is_shared_id(&e.calendar_id)) || data.tasks.iter().any(|t| is_shared_id(&t.calendar_id))
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

/// Replace the event with `event.id` wholesale — but for its
/// [`FROM_MAIL_KEY`] stamp, which no edit takes away.
pub(crate) fn update_event_at(path: &Path, event: CalendarEvent) -> Result<CalendarEvent, String> {
    let (_, data) = transact(path, |data| {
        let into_caldav = is_caldav_calendar(data, &event.calendar_id);
        let slot = data
            .events
            .iter_mut()
            .find(|e| e.id == event.id)
            .ok_or_else(|| format!("event '{}' not found", event.id))?;
        let mut event = event.clone();
        keep_from_mail(&mut event.extra, &slot.extra);
        let same = slot.calendar_id == event.calendar_id;
        keep_caldav_dirty(&mut event.extra, &slot.extra, same, into_caldav);
        *slot = event;
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
    forget_server_identity(&mut event.extra);
    event.calendar_id = to.to_string();
    Ok(())
}

/// Everything that ties a row to its old collection: its address and ETag,
/// and the push bookkeeping about that address (gap 32) — a moved row must not
/// raise a "deleted on the server" question in its new calendar. The new
/// calendar's own push marks it again.
fn forget_server_identity(extra: &mut std::collections::HashMap<String, serde_json::Value>) {
    for key in [CALDAV_HREF_KEY, CALDAV_ETAG_KEY, CALDAV_SERVER_DELETED_KEY, CALDAV_DIRTY_KEY] {
        extra.remove(key);
    }
}

/// [`relocate_event`] for a to-do card: the server address is dropped so the
/// next push creates the card in its new collection, and the caller deletes
/// the old copy. A VTODO is one row per resource, so there is no series to split.
pub(crate) fn relocate_task(task: &mut CalendarTask, to: &str) {
    forget_server_identity(&mut task.extra);
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
        let into_caldav = is_caldav_calendar(data, &task.calendar_id);
        let slot = data
            .tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("task '{id}' not found"))?;
        let mut task = task.clone();
        let same = slot.calendar_id == task.calendar_id;
        keep_caldav_dirty(&mut task.extra, &slot.extra, same, into_caldav);
        *slot = task;
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
pub(crate) fn restore_calendar_at(
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
pub(crate) fn replace_calendar_events_at(
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
/// The `extra` key (`true`) on a row of a CalDAV calendar whose local edit has
/// not reached the server yet (gap 32). Set by the window's local write and by
/// `caldav_push` before it sends; cleared only by a push the server accepted
/// for that same revision ([`set_caldav_identity_at`]) or by the user's "Use
/// the server's" ([`merge_caldav_calendar_kept_at`]'s `discard`). A merge never
/// overwrites a dirty row, and the sync pushes dirty rows before it fetches.
/// In `extra`, so older builds carry it through untouched.
pub const CALDAV_DIRTY_KEY: &str = "caldav_dirty";
/// The `extra` key holding the resource URL a dirty row had when the server
/// deleted that resource: the row was kept as local-only, and the question
/// "put it back, or delete it here too?" stays open until the user answers.
pub const CALDAV_SERVER_DELETED_KEY: &str = "caldav_server_deleted";

/// Whether calendar `id` is one a CalDAV subscription feeds: the subscribe
/// step stamps the collection's address on the calendar record.
fn is_caldav_calendar(data: &CalendarData, id: &str) -> bool {
    data.calendars
        .iter()
        .find(|c| c.id == id)
        .is_some_and(|c| !extra_str(&c.extra, CALDAV_HREF_KEY).trim().is_empty())
}

/// Rewrite the stored CalDAV addresses of calendars `ids` through `twin` (the
/// `https://` twin of a same-host `http://` address, see
/// `services::caldav::https_twin`), in one write: the calendar record's own
/// collection address, and each row's resource address and its
/// "deleted on the server" address. Called when an account moves from
/// `http://` to `https://`, so its rows keep matching what the server lists
/// and their pushes are not refused as "not https". An address `twin` leaves
/// alone stays as it is.
pub(crate) fn upgrade_caldav_hrefs_at(
    path: &Path,
    ids: &[String],
    twin: impl Fn(&str) -> Option<String>,
) -> Result<(), String> {
    let mine = |cal: &str| ids.iter().any(|id| id == cal);
    let swap = |extra: &mut std::collections::HashMap<String, serde_json::Value>, key: &str| {
        if let Some(next) = twin(&extra_str(extra, key)) {
            extra.insert(key.to_string(), serde_json::Value::String(next));
        }
    };
    transact(path, |data| {
        for c in data.calendars.iter_mut().filter(|c| mine(&c.id)) {
            swap(&mut c.extra, CALDAV_HREF_KEY);
        }
        for e in data.events.iter_mut().filter(|e| mine(&e.calendar_id)) {
            swap(&mut e.extra, CALDAV_HREF_KEY);
            swap(&mut e.extra, CALDAV_SERVER_DELETED_KEY);
        }
        for t in data.tasks.iter_mut().filter(|t| mine(&t.calendar_id)) {
            swap(&mut t.extra, CALDAV_HREF_KEY);
            swap(&mut t.extra, CALDAV_SERVER_DELETED_KEY);
        }
        Ok(())
    })
    .map(|_| ())
}

fn is_dirty(extra: &std::collections::HashMap<String, serde_json::Value>) -> bool {
    extra.get(CALDAV_DIRTY_KEY).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Keep a stored dirty mark on the row replacing it within the same calendar:
/// a window copy that never saw the mark must not be able to clear it. A move
/// to another calendar drops the "deleted on the server" question (it was
/// about the old collection), and a move into a local calendar — one no CalDAV
/// subscription feeds — drops the mark too, whatever the incoming copy carried:
/// nothing there will ever push it, and a stale mark would send the row once
/// that calendar ever synced. A move into another CalDAV calendar keeps the
/// mark the window's write set for its new collection.
fn keep_caldav_dirty(
    incoming: &mut std::collections::HashMap<String, serde_json::Value>,
    stored: &std::collections::HashMap<String, serde_json::Value>,
    same_calendar: bool,
    into_caldav: bool,
) {
    if !same_calendar {
        incoming.remove(CALDAV_SERVER_DELETED_KEY);
        if !into_caldav {
            incoming.remove(CALDAV_DIRTY_KEY);
        }
    } else if is_dirty(stored) {
        incoming.insert(CALDAV_DIRTY_KEY.to_string(), serde_json::Value::Bool(true));
    }
}
/// The `extra` key an event made from a mail carries (`{message_id,
/// account_id}`, stamped by the mail pane's AI extract): its text is a
/// sender's, and the root agent's tools serve it as `external`
/// (`services::root_mcp::event_view`). Sticky: an edit in the window, a CalDAV
/// merge or a server that sends the key itself never takes it away
/// ([`keep_from_mail`]).
pub const FROM_MAIL_KEY: &str = "from_mail";

/// Keep the stored row's [`FROM_MAIL_KEY`] on the row replacing it, over
/// whatever the new one says (absent, `null`, or a server's own value).
fn keep_from_mail(
    incoming: &mut std::collections::HashMap<String, serde_json::Value>,
    stored: &std::collections::HashMap<String, serde_json::Value>,
) {
    if let Some(v) = stored.get(FROM_MAIL_KEY).filter(|v| !v.is_null()) {
        incoming.insert(FROM_MAIL_KEY.to_string(), v.clone());
    }
}

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
#[cfg(test)]
pub(crate) fn merge_caldav_calendar_at(
    path: &Path,
    calendar_id: &str,
    parsed: Vec<CalDavParsed>,
    removed: &[String],
    full: bool,
) -> Result<CalendarData, String> {
    merge_caldav_calendar_kept_at(path, calendar_id, parsed, removed, full, &[]).map(|(data, _)| data)
}

/// [`merge_caldav_calendar_at`], plus the **dirty rows** it kept (gap 32).
///
/// A row carrying [`CALDAV_DIRTY_KEY`] holds a local edit the server has not
/// seen, so the merge never overwrites it:
///
/// - **matched** — its whole resource group is left as it is (a series' rows
///   go back to the server as one object, so half an update would split it).
///   When the server's ETag differs from the row's, the server changed it too:
///   the row is reported (`reason: "changed"`) for the conflict dialog;
/// - **deleted on the server** (an explicit `404`, or an event absent from a
///   full listing) — the row stays, as a local-only row: its href and ETag are
///   cleared, the old href is kept under [`CALDAV_SERVER_DELETED_KEY`], and it
///   is reported (`reason: "deleted"`).
///
/// `discard` names rows whose local edit the user gave up on ("Use the
/// server's"), in the same write: the mark is dropped before the merge, and a
/// row the server had deleted is deleted here too.
pub(crate) fn merge_caldav_calendar_kept_at(
    path: &Path,
    calendar_id: &str,
    parsed: Vec<CalDavParsed>,
    removed: &[String],
    full: bool,
    discard: &[String],
) -> Result<(CalendarData, Vec<CalDavKept>), String> {
    let (kept, data) = transact(path, |data| {
        discard_local_edits(data, calendar_id, discard);
        merge_caldav_calendar_in(data, calendar_id, &parsed, removed, full)
    })?;
    Ok((data, kept))
}

/// "Use the server's", for the named rows of one calendar.
fn discard_local_edits(data: &mut CalendarData, calendar_id: &str, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let named = |id: &str, cal: &str| cal == calendar_id && ids.iter().any(|d| d == id);
    data.events.retain(|e| !(named(&e.id, &e.calendar_id) && e.extra.contains_key(CALDAV_SERVER_DELETED_KEY)));
    data.tasks.retain(|t| !(named(&t.id, &t.calendar_id) && t.extra.contains_key(CALDAV_SERVER_DELETED_KEY)));
    for e in data.events.iter_mut().filter(|e| named(&e.id, &e.calendar_id)) {
        e.extra.remove(CALDAV_DIRTY_KEY);
    }
    for t in data.tasks.iter_mut().filter(|t| named(&t.id, &t.calendar_id)) {
        t.extra.remove(CALDAV_DIRTY_KEY);
    }
}

/// A dirty row the server deleted: kept, local-only, and reported.
fn keep_server_deleted(
    extra: &mut std::collections::HashMap<String, serde_json::Value>,
    id: &str,
    kind: &str,
    title: &str,
    kept: &mut Vec<CalDavKept>,
) {
    let href = extra_str(extra, CALDAV_HREF_KEY);
    extra.remove(CALDAV_HREF_KEY);
    extra.remove(CALDAV_ETAG_KEY);
    extra.insert(
        CALDAV_SERVER_DELETED_KEY.to_string(),
        serde_json::Value::String(href.clone()),
    );
    kept.push(CalDavKept {
        row_id: id.to_string(),
        kind: kind.to_string(),
        href,
        title: title.to_string(),
        reason: "deleted".to_string(),
    });
}

/// The in-memory half of [`merge_caldav_calendar_kept_at`], over a store
/// already read. Returns the dirty rows it kept and why.
fn merge_caldav_calendar_in(
    data: &mut CalendarData,
    calendar_id: &str,
    parsed: &[CalDavParsed],
    removed: &[String],
    full: bool,
) -> Result<Vec<CalDavKept>, String> {
    if !data.calendars.iter().any(|c| c.id == calendar_id) {
        return Err(format!("calendar '{calendar_id}' not found"));
    }
    let mut kept: Vec<CalDavKept> = Vec::new();

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

        // ── A resource holding an unpushed local edit (gap 32) ───────────
        let in_group = |cal: &str, extra: &std::collections::HashMap<String, serde_json::Value>| {
            cal == calendar_id && extra_str(extra, CALDAV_HREF_KEY) == group.href
        };
        let mut dirty_group = false;
        let changed = |extra: &std::collections::HashMap<String, serde_json::Value>| {
            extra_str(extra, CALDAV_ETAG_KEY) != group.etag
        };
        for e in data.events.iter().filter(|e| in_group(&e.calendar_id, &e.extra) && is_dirty(&e.extra)) {
            dirty_group = true;
            if changed(&e.extra) {
                kept.push(CalDavKept {
                    row_id: e.id.clone(),
                    kind: "event".into(),
                    href: group.href.clone(),
                    title: e.title.clone(),
                    reason: "changed".into(),
                });
            }
        }
        for t in data.tasks.iter().filter(|t| in_group(&t.calendar_id, &t.extra) && is_dirty(&t.extra)) {
            dirty_group = true;
            if changed(&t.extra) {
                kept.push(CalDavKept {
                    row_id: t.id.clone(),
                    kind: "task".into(),
                    href: group.href.clone(),
                    title: t.title.clone(),
                    reason: "changed".into(),
                });
            }
        }
        if dirty_group {
            continue;
        }

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
                    keep_from_mail(&mut event.extra, &local.extra);
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

    // A dirty row the server deleted is kept as a local-only row and reported,
    // never deleted with it (gap 32): by an explicit `404`, or — events only —
    // by its absence from a full listing.
    let server_dropped = |cal: &str, extra: &std::collections::HashMap<String, serde_json::Value>, event: bool| {
        if cal != calendar_id || !is_dirty(extra) {
            return false;
        }
        let href = extra_str(extra, CALDAV_HREF_KEY);
        !href.is_empty() && (gone.contains(href.as_str()) || (event && full && !seen_hrefs.contains(&href)))
    };
    for e in data.events.iter_mut().filter(|e| server_dropped(&e.calendar_id, &e.extra, true)) {
        let (id, title) = (e.id.clone(), e.title.clone());
        keep_server_deleted(&mut e.extra, &id, "event", &title, &mut kept);
    }
    for t in data.tasks.iter_mut().filter(|t| server_dropped(&t.calendar_id, &t.extra, false)) {
        let (id, title) = (t.id.clone(), t.title.clone());
        keep_server_deleted(&mut t.extra, &id, "task", &title, &mut kept);
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
    Ok(kept)
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
///
/// It also settles the row's [`CALDAV_DIRTY_KEY`] (gap 32): the mark is cleared
/// only when `pushed_rev` names the revision the row still has — i.e. nothing
/// edited it while the write was in flight. `None` (the pushed bytes were
/// already older than the row) keeps it. Returns whether the row is still
/// dirty. A row the server now holds is no longer "deleted on the server", so
/// [`CALDAV_SERVER_DELETED_KEY`] goes either way.
///
/// The other rows of the same resource (a series' occurrence overrides, which
/// went to the server in the same body) get the new ETag too, or the next push
/// of one of them would be conditional on a version the server no longer has
/// and come back as a `412` against this machine's own write. Their marks stay:
/// only the pushed row's revision is known here, so a dirty sibling is pushed
/// once more, now conditional on the right ETag.
#[cfg(test)]
pub(crate) fn set_caldav_identity_at(
    path: &Path,
    kind: &str,
    row_id: &str,
    href: &str,
    etag: &str,
    pushed_rev: Option<u64>,
) -> Result<bool, String> {
    set_caldav_identity_sent_at(path, kind, row_id, href, etag, pushed_rev, "")
}

/// [`set_caldav_identity_at`], told which existing resource the body was sent
/// to as an update (`sent_to`; empty for a create). The resource's other rows
/// take the new ETag when the pushed row was stored under `href` **or** the
/// body went to `href` as an update — the second is a row that had no address
/// yet and joined a resource its siblings already hold ("Keep mine" on a
/// series row the server deleted after its master was put back, or on a
/// create whose reply was lost): that body carried the whole group. A create
/// touches no other row.
pub(crate) fn set_caldav_identity_sent_at(
    path: &Path,
    kind: &str,
    row_id: &str,
    href: &str,
    etag: &str,
    pushed_rev: Option<u64>,
    sent_to: &str,
) -> Result<bool, String> {
    transact(path, |data| {
        let sibling_of = row_extra(data, kind, row_id).map(|(extra, _)| extra_str(extra, CALDAV_HREF_KEY))?;
        if !href.is_empty() && (sibling_of == href || sent_to.trim() == href) {
            let calendar = match kind {
                "event" => data.events.iter().find(|e| e.id == row_id).map(|e| e.calendar_id.clone()),
                _ => data.tasks.iter().find(|t| t.id == row_id).map(|t| t.calendar_id.clone()),
            }
            .unwrap_or_default();
            let same_resource = |id: &str, cal: &str, extra: &std::collections::HashMap<String, serde_json::Value>| {
                id != row_id && cal == calendar && extra_str(extra, CALDAV_HREF_KEY) == href
            };
            let fresh = serde_json::Value::String(etag.to_string());
            for e in data.events.iter_mut().filter(|e| same_resource(&e.id, &e.calendar_id, &e.extra)) {
                e.extra.insert(CALDAV_ETAG_KEY.to_string(), fresh.clone());
            }
            for t in data.tasks.iter_mut().filter(|t| same_resource(&t.id, &t.calendar_id, &t.extra)) {
                t.extra.insert(CALDAV_ETAG_KEY.to_string(), fresh.clone());
            }
        }
        let (extra, rev) = row_extra(data, kind, row_id)?;
        extra.insert(
            CALDAV_HREF_KEY.to_string(),
            serde_json::Value::String(href.to_string()),
        );
        extra.insert(
            CALDAV_ETAG_KEY.to_string(),
            serde_json::Value::String(etag.to_string()),
        );
        extra.remove(CALDAV_SERVER_DELETED_KEY);
        if pushed_rev == Some(rev) {
            extra.remove(CALDAV_DIRTY_KEY);
        }
        Ok(is_dirty(extra))
    })
    .map(|(dirty, _)| dirty)
}

/// Mark one row dirty ([`CALDAV_DIRTY_KEY`]) before a push is attempted, so a
/// push that fails — offline, a refused password, a server error, a `412` —
/// leaves the edit marked whichever writer made it (the window, an approved
/// root-agent row). Returns the row's revision before and after the mark.
pub(crate) fn mark_caldav_dirty_at(path: &Path, kind: &str, row_id: &str) -> Result<(u64, u64), String> {
    let mut before = 0;
    let (_, data) = transact(path, |data| {
        let (extra, rev) = row_extra(data, kind, row_id)?;
        before = rev;
        extra.insert(CALDAV_DIRTY_KEY.to_string(), serde_json::Value::Bool(true));
        Ok(())
    })?;
    let after = match kind {
        "event" => data.events.iter().find(|e| e.id == row_id).map(|e| e.rev),
        _ => data.tasks.iter().find(|t| t.id == row_id).map(|t| t.rev),
    }
    .unwrap_or(before);
    Ok((before, after))
}

/// One row's `extra` and revision, by kind and id.
fn row_extra<'a>(
    data: &'a mut CalendarData,
    kind: &str,
    row_id: &str,
) -> Result<(&'a mut std::collections::HashMap<String, serde_json::Value>, u64), String> {
    match kind {
        "event" => data
            .events
            .iter_mut()
            .find(|e| e.id == row_id)
            .map(|e| (&mut e.extra, e.rev)),
        "task" => data
            .tasks
            .iter_mut()
            .find(|t| t.id == row_id)
            .map(|t| (&mut t.extra, t.rev)),
        other => return Err(format!("unknown calendar row kind '{other}'")),
    }
    .ok_or_else(|| format!("no {kind} with id '{row_id}'"))
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

#[cfg(test)]
mod tests;
