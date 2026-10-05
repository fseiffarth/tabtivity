//! `~/.local/share/tabtivity/calendar.json` — the native calendar's on-disk model.
//!
//! The file is an object (`CalendarData`): a list of named calendars, the events
//! filed under them, and the tasks (VTODO-style to-dos). Version 1 of this file
//! was a bare JSON array of start-time-only events; `CalendarFile` still reads
//! that shape and `migrate_legacy` lifts it into the current model, so an
//! existing calendar survives the upgrade untouched. Tabtivity always *writes* the
//! current shape.
//!
//! Times are **local wall-clock**, never UTC: `"YYYY-MM-DDTHH:MM"` for a timed
//! event and `"YYYY-MM-DD"` for an all-day one. This keeps "09:00 standup"
//! at 09:00 regardless of the machine's timezone, which is what a personal
//! calendar wants; it is also why no timezone crate is pulled in.
//!
//! Every non-required field defaults and each record keeps an `extra` flatten,
//! so a newer or hand-edited file round-trips without losing keys.
//!
//! The tasks are also **the todo board's cards** (`task_columns` + `CalendarTask`'s
//! `column`/`rank`). That is one store, not two, on purpose: a todo and a VTODO are
//! the same thing, and a second file would mean the calendar's Tasks view and the
//! board could disagree about whether something is done. `normalize` is where they
//! are kept from drifting — see its doc.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Current `version` written into `calendar.json`.
///
/// **Nothing branches on it, and nothing may.** `CalendarFile` dispatches on the
/// file's *shape* (it is `#[serde(untagged)]`), and `normalize` stamps this value
/// unconditionally — so an older Tabtivity that reads a v3 file writes it back
/// stamped `2`, with the v3 fields intact in the `extra` flattens. The number can
/// therefore go *backwards* on the same file, and a migration gated on it would
/// run, or fail to run, non-deterministically. Every backfill below is instead
/// version-independent and idempotent.
pub const CALENDAR_VERSION: u32 = 3;

/// Name of the one-time board upgrade that added the date columns (Overdue /
/// Today) to a board created before them. Recorded in
/// [`CalendarData::board_upgrades`] so it runs exactly once per file.
pub const BOARD_UPGRADE_DATE_COLUMNS: &str = "date-columns";

/// Id of the calendar that legacy events (and events with no calendar) land in.
pub const DEFAULT_CALENDAR_ID: &str = "default";

/// Fallback duration for a timed event whose end is missing/invalid — also what a
/// migrated legacy event (which only had a start) gets.
pub const DEFAULT_EVENT_MINUTES: i64 = 60;

/// Gap between adjacent board ranks. Large enough that a card can be dropped
/// between the same two neighbours ~50 times before the bisection runs out of
/// mantissa; small enough that the raw JSON stays legible.
pub const RANK_GAP: f64 = 1024.0;

/// Two ranks closer than this are "too close to split": the column is reindexed
/// instead. Cheap here because every write rewrites the whole file anyway, so a
/// whole-column reindex costs exactly what a single-field update costs.
pub const RANK_EPSILON: f64 = 1e-6;

/// Most tags one task may carry. A cap rather than a validation error: tags are
/// typed into a chip field, and the failure mode being guarded against is a
/// hand-edited or generated file, not a user with opinions.
pub const MAX_TAGS: usize = 16;

// ── Calendars ───────────────────────────────────────────────────────────────

/// One named, colored calendar in the sidebar list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Calendar {
    pub id: String,
    pub name: String,
    /// CSS color the calendar's events render in (e.g. `"#4aa3df"`).
    pub color: String,
    /// Unchecked in the sidebar → its events drop out of every view.
    #[serde(default = "default_true")]
    pub visible: bool,
    /// Read-only calendars (e.g. an imported feed) reject edits in the UI.
    #[serde(default)]
    pub readonly: bool,
    /// Bumped by every write that changed this record (#171), so a client can
    /// tell a record it holds from the one on disk. `0` until a revision-aware
    /// Tabtivity first rewrites the record, and not serialized then, so an
    /// untouched file keeps its bytes.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rev: u64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

fn default_true() -> bool {
    true
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

impl Calendar {
    /// The calendar every migrated/unfiled event belongs to.
    pub fn default_calendar() -> Self {
        Self {
            id: DEFAULT_CALENDAR_ID.to_string(),
            name: "Personal".to_string(),
            color: "#4aa3df".to_string(),
            visible: true,
            readonly: false,
            rev: 0,
            extra: HashMap::new(),
        }
    }
}

// ── Recurrence ──────────────────────────────────────────────────────────────

/// How often a recurring event repeats. Mirrors the iCalendar `RRULE` subset
/// Tabtivity supports.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Freq {
    #[default]
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// A recurrence rule. `until` and `count` are mutually exclusive ends; with
/// neither set the event repeats forever (expansion is always window-bounded, so
/// "forever" is safe).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Rrule {
    pub freq: Freq,
    /// Repeat every N periods. `0` is treated as `1` by the expander.
    #[serde(default = "default_interval")]
    pub interval: u32,
    /// Weekly only: weekdays to fire on, `0`=Sunday … `6`=Saturday. Empty → the
    /// weekday of the event's own start.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub byweekday: Vec<u8>,
    /// Monthly only: day of month (1–31). `None` → the event's own day of month.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bymonthday: Option<u8>,
    /// Monthly and yearly: numbered weekdays (`{n: 2, day: 2}` = the 2nd
    /// Tuesday, `n: -1` = the last). Yearly counts within the event's own month.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bynthweekday: Vec<NthWeekday>,
    /// Inclusive last date (`"YYYY-MM-DD"`) the rule may fire on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    /// Total number of occurrences, counting the first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// The imported RRULE text, kept only when the fields above could not hold
    /// all of it, so an export or CalDAV push can write it back unreduced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ics_value: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One numbered weekday of a recurrence: the `n`th (negative: from the end)
/// `day`, `0`=Sunday … `6`=Saturday.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct NthWeekday {
    pub n: i8,
    pub day: u8,
}

fn default_interval() -> u32 {
    1
}

/// A single occurrence edited away from its master ("this event only"). Keyed by
/// the occurrence's *original* start, so it survives edits to its own start.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct EventOverride {
    /// The occurrence's start as the rule generated it — the key.
    pub occurrence_start: String,
    /// Fields that differ from the master; anything absent is inherited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

// ── Alarms ──────────────────────────────────────────────────────────────────

/// A reminder, fired `minutes_before` the occurrence starts. Negative values fire
/// *after* the start (iCalendar allows a positive trigger offset).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Alarm {
    pub minutes_before: i64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

// ── Events ──────────────────────────────────────────────────────────────────

/// A calendar event.
///
/// `start`/`end` are local wall-clock: `"YYYY-MM-DDTHH:MM"` when timed, or
/// `"YYYY-MM-DD"` when `all_day`. `end` is **exclusive** — following the iCal
/// convention, an all-day event on the 8th has `start: "2026-07-08"` and
/// `end: "2026-07-09"`. A multi-day event is simply one whose `end` lands on a
/// later day than its `start`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CalendarEvent {
    pub id: String,
    #[serde(default = "default_calendar_id")]
    pub calendar_id: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub all_day: bool,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub location: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
    /// The video call's join URL (`http(s)`; the frontend's `lib/calendar/conference.ts`
    /// is the one place that decides what is joinable). Its own field rather
    /// than a convention on `location`, so a **Join** button is never a guess
    /// about what a room name meant.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub conference: String,
    /// Category key; maps to a color in the frontend's category palette.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub category: String,
    /// `"confirmed"` (default) | `"tentative"` | `"cancelled"`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rrule: Option<Rrule>,
    /// Occurrence starts deleted from the series ("this event only" → delete).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exdates: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overrides: Vec<EventOverride>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alarms: Vec<Alarm>,
    /// Bumped by every write that changed this record (#171), so a client can
    /// tell a record it holds from the one on disk. `0` until a revision-aware
    /// Tabtivity first rewrites the record, and not serialized then, so an
    /// untouched file keeps its bytes.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rev: u64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

fn default_calendar_id() -> String {
    DEFAULT_CALENDAR_ID.to_string()
}

// ── Board columns ───────────────────────────────────────────────────────────

/// One column of the todo board.
///
/// User-defined, and stored here rather than in `settings.json`, because a column
/// id is *referenced by task records* — putting the two in different files would
/// mean a settings restore could leave every card pointing at a column that no
/// longer exists, with nothing in this file able to notice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TaskColumn {
    /// Stable id (a slug for the seeded set, a fresh uuid for a user-added one).
    /// `CalendarTask::column` names it, which is exactly why the label is a
    /// separate field: a rename must not move any cards.
    pub id: String,
    pub name: String,
    /// Left-to-right order. Ties break by `id`, so a hand-edited file with two
    /// equal positions still renders in a stable order rather than shuffling.
    #[serde(default)]
    pub position: i64,
    /// **The** completion column: dropping a card here completes it, and
    /// completing a task anywhere else moves it here. At most one column may
    /// carry the flag (`normalize` enforces it); *zero* is legal and simply turns
    /// the coupling off, which is what a user who deleted their Done column meant.
    #[serde(default)]
    pub done: bool,
    /// An **archive**: a resting place that outranks the done↔column coupling. A
    /// card filed here stays here whatever its `percent` — the whole point of
    /// archiving a *finished* card is to get it out of Done, so `normalize` must
    /// not pull it straight back (see `normalize_tasks` step 4). Unlike `done`
    /// there is no cap and no coupling: nothing auto-moves a card here, and an
    /// unplaced card is never filed here (it goes to the leftmost open column).
    #[serde(default)]
    pub archived: bool,
    /// **The** overdue column: a card whose deadline is behind it is *shown*
    /// here. Like `done` there is at most one (`normalize` enforces it) and zero
    /// is legal — a board without one simply leaves late cards where they are.
    ///
    /// Unlike `done` this is **display only, and no card record names it** until
    /// the user drags one in: the routing lives in the frontend's `columnOf`,
    /// because it depends on today's date and `normalize` runs on every read (see
    /// `normalize_tasks` step 5 for why a date-derived *write* is forbidden). All
    /// this flag does here is say which column the frontend routes into, and keep
    /// it out of `col_fallback`.
    #[serde(default)]
    pub overdue: bool,
    /// **The** today column, the twin of `overdue`: a card due today is shown
    /// here. Same rules — at most one, zero legal, display-only.
    #[serde(default)]
    pub due_today: bool,
    /// **The** intake column: where a card with no home lands (`col_fallback`),
    /// and where every conversion files one.
    ///
    /// Named rather than inferred, because the old rule — *the leftmost column
    /// that is neither Done nor an archive* — stopped identifying it the moment
    /// the board led with the date columns and put Backlog behind Doing. Under
    /// that layout the leftmost open column is *Doing*, and an unplaced card
    /// would have been filed as work in progress. At most one (`normalize`
    /// enforces it); with none, the old positional rule still applies, so a
    /// hand-written board without the flag behaves exactly as it used to.
    #[serde(default)]
    pub intake: bool,
    /// CSS color for the column header, like `Calendar::color`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub color: String,
    /// Optional soft "WIP limit"; `0` = none. **Advisory only** — no code path
    /// refuses a move because of it. A drag that reports success and silently
    /// snaps back is indistinguishable from a broken drag.
    #[serde(default)]
    pub limit: u32,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl TaskColumn {
    /// The board a user who has never touched one starts with.
    ///
    /// **Deadline first, then intent.** The three leftmost columns are the ones
    /// a date decides — what is late, what is due today — and only then the ones
    /// the user decides by dragging: what is being worked on, and what is merely
    /// on the list. Reading left to right therefore reads in order of urgency,
    /// which is the order a board is actually scanned in.
    pub fn default_set() -> Vec<TaskColumn> {
        // (id, name, color, done, archived, overdue, due_today, intake) — at most
        // one of each flag. Backlog carries `intake` rather than earning it by
        // being leftmost: it now sits *behind* Doing, and the unplaced-card
        // fallback has to keep pointing at it (see `TaskColumn::intake`).
        [
            ("overdue", "Overdue", "#d9534f", false, false, true, false, false),
            ("today", "Today", "#4aa3df", false, false, false, true, false),
            ("doing", "Doing", "#e8a33d", false, false, false, false, false),
            ("backlog", "Backlog", "#8a93a5", false, false, false, false, true),
            ("done", "Done", "#5cb85c", true, false, false, false, false),
            ("archived", "Archived", "#7d8590", false, true, false, false, false),
        ]
        .iter()
        .enumerate()
        .map(
            |(i, (id, name, color, done, archived, overdue, due_today, intake))| TaskColumn {
                id: (*id).to_string(),
                name: (*name).to_string(),
                position: i as i64,
                done: *done,
                archived: *archived,
                overdue: *overdue,
                due_today: *due_today,
                intake: *intake,
                color: (*color).to_string(),
                limit: 0,
                extra: HashMap::new(),
            },
        )
        .collect()
    }

    /// Whether this column's contents are decided by a card's deadline rather
    /// than by where the user put it — the two the frontend routes into.
    pub fn date_governed(&self) -> bool {
        self.overdue || self.due_today
    }
}

// ── Tasks ───────────────────────────────────────────────────────────────────

/// One checklist item inside a task.
///
/// Deliberately **not** a separate VTODO linked by `RELATED-TO`: N sub-VTODOs
/// would mean N ids, N board cards and N rows in the calendar's Tasks view for
/// what is one commitment with a checklist. Binary rather than a percentage,
/// because `CalendarTask::percent` already carries the gradual reading.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Subtask {
    /// Stable within its task. `normalize` backfills an empty one as
    /// `{task.id}-{index}`, so the frontend never needs an array index as a key.
    #[serde(default)]
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub done: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// The mail a task was converted from.
///
/// **Identifiers and a display snapshot, never a path.** The mail command surface
/// is path-free by rule (`commands::mail`'s own `no_command_takes_a_path`
/// tripwire), and a type that carries mail data *out* of that surface and into
/// `calendar.json` must not be where the rule quietly stops holding.
/// `message_id` is `MailHeader::id` — Tabtivity's `{folder_id}-{uid}` store key,
/// which is exactly what `mail_body`, `mail_flag` and `mail_priority_set` take.
///
/// `subject`/`from` are a **snapshot taken at conversion**, not a live lookup, for
/// two reasons: the card must still read sensibly after the message is deleted
/// from the server, and re-resolving them on every board render would make the
/// todo board depend on a feature that is off by default.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TaskMailLink {
    pub message_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub account_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub folder_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub subject: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub from: String,
    /// The mark the message carried when it was converted (`"urgent"` /
    /// `"important"`) — a record of *why* this card exists, never re-read as the
    /// message's current mark.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub priority_at_convert: String,
}

/// The appointment a task was converted from — `TaskMailLink`'s twin, and
/// deliberately built the same way: **identifiers plus a display snapshot**.
///
/// It names an **occurrence**, not a series. A weekly meeting produces one card
/// per week that needs preparing, and `occurrence_start` is what keeps the second
/// one from being read as a duplicate of the first — the board's "this
/// appointment already has a card" check is `event_id` + `occurrence_start`.
///
/// `title`/`location` are the snapshot half, for `TaskMailLink`'s reasons: the
/// card must still read sensibly after the event is deleted or the calendar it
/// came from is unsubscribed, and re-expanding a recurrence on every board render
/// to relabel a card is work the board should never do.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TaskEventLink {
    pub event_id: String,
    /// The occurrence's local start stamp (`"YYYY-MM-DDTHH:MM"`), as the
    /// frontend's expansion minted it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub occurrence_start: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub calendar_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub location: String,
}

/// A project file a card was converted from, with a frozen remark snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TaskFileLink {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
}

/// A to-do (VTODO). `due`/`start` use the same local encoding as events; a task
/// with no `due` simply never appears in the calendar views, only in the task list.
///
/// It is also a **board card**: `column` and `rank` place it, and the remaining
/// board fields (`tags`, `subtasks`, `mail`, `event`, `project_id`, `created`) are
/// Tabtivity's own and are not exported to ICS — see `CalendarData::normalize` for
/// how board state and VTODO completion are kept from contradicting each other.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CalendarTask {
    pub id: String,
    #[serde(default = "default_calendar_id")]
    pub calendar_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    /// iCalendar priority: `0` = unset, `1` = highest … `9` = lowest.
    #[serde(default)]
    pub priority: u8,
    /// Completion percentage, 0–100. `100` implies done.
    #[serde(default)]
    pub percent: u8,
    /// Local timestamp the task was completed at; `None` while open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub category: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alarms: Vec<Alarm>,

    // ── Board fields ────────────────────────────────────────────────────────
    // Real fields rather than `extra` keys, because `normalize` reads every one
    // of them: a key that only lives in `extra` cannot be read without `Value`
    // juggling, and a typo in its name round-trips silently instead of failing
    // to compile.
    /// Id of the [`TaskColumn`] this card sits in. Empty means "not placed yet",
    /// which `normalize` backfills — so a task created by the calendar's Tasks
    /// view, by an ICS import, or by an older Tabtivity still appears on the board.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub column: String,
    /// Manual position within `column`: a fractional rank, ascending (smallest is
    /// topmost). `None` is "unranked" and is backfilled by `normalize`.
    ///
    /// A rank on the *record* rather than an ordered id list on the column,
    /// because an id list is a second index over `tasks` and would drift: tasks
    /// are created by the Tasks view, by ICS import, and by builds that have
    /// never heard of columns, none of which can append to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank: Option<f64>,
    /// Free-form labels. `normalize` trims, drops empties and dedupes them
    /// case-insensitively (keeping the first spelling) — the board filters by
    /// equality, and `Work` and `work` showing as two chips is a state the user
    /// cannot repair from the UI.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Checklist items.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtasks: Vec<Subtask>,
    /// The mail this card was converted from, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail: Option<TaskMailLink>,
    /// The appointment this card was converted from, if any. A card carries at
    /// most one of the two — both conversions build the same card shape, they
    /// just record which object it came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<TaskEventLink>,
    /// The project file remark this card was converted from, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<TaskFileLink>,
    /// `ProjectEntry.id` this card belongs to, or empty.
    ///
    /// Deliberately **not** validated against `projects.json`: that would make
    /// `calendar.json` unloadable, untestable and unmigratable on its own, and a
    /// project can be legitimately absent for a while (removed and re-imported,
    /// or simply on another machine) — clearing the chip would destroy the
    /// association permanently. The frontend renders an unresolvable id as a
    /// dimmed "unknown project" chip that still filters.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_id: String,
    /// Local wall-clock stamp the card was created at (`"YYYY-MM-DDTHH:MM"`).
    ///
    /// Minted by the frontend, exactly as `completed` already is: this crate
    /// pulls in no time crate and `SystemTime` is UTC, so a backend stamp would
    /// be the one field in this file that is not local wall-clock. Empty on every
    /// pre-existing task, and left that way — an invented creation date is worse
    /// than an absent one.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub created: String,
    /// Bumped by every write that changed this record (#171), so a client can
    /// tell a record it holds from the one on disk. `0` until a revision-aware
    /// Tabtivity first rewrites the record, and not serialized then, so an
    /// untouched file keeps its bytes.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rev: u64,

    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

// ── The file ────────────────────────────────────────────────────────────────

/// The whole of `calendar.json` in its current shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalendarData {
    pub version: u32,
    #[serde(default)]
    pub calendars: Vec<Calendar>,
    #[serde(default)]
    pub events: Vec<CalendarEvent>,
    #[serde(default)]
    pub tasks: Vec<CalendarTask>,
    /// The todo board's columns. `skip_serializing_if` so a user who has never
    /// opened the board never grows the key in their file; `normalize` seeds the
    /// default set the moment anything needs one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_columns: Vec<TaskColumn>,
    /// One-time board upgrades already applied to this file, by name.
    ///
    /// A marker rather than a `version` check, because `version` explicitly may
    /// not be branched on (see [`CALENDAR_VERSION`]: an older Tabtivity stamps the
    /// number *backwards*, so a version-gated migration runs, or fails to run,
    /// non-deterministically). This list only ever grows, an unknown entry is
    /// harmless, and an older Tabtivity round-trips it in its `extra` flatten — so
    /// it is the one thing here that can honestly say "already done, do not do it
    /// again", which is what keeps an upgrade from resurrecting a column the user
    /// deleted afterwards.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub board_upgrades: Vec<String>,
    /// The file's revision, bumped by every write (#171). A writer commits its
    /// read-modify-write only while the revision on disk is still the one it
    /// read — the in-process lock cannot see a second Tabtivity process, and the
    /// board rewrites this file on every drag. `0` for a file no
    /// revision-aware Tabtivity has written yet.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rev: u64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl Default for CalendarData {
    fn default() -> Self {
        Self {
            rev: 0,
            version: CALENDAR_VERSION,
            calendars: vec![Calendar::default_calendar()],
            events: Vec::new(),
            tasks: Vec::new(),
            // Empty, not `default_set()`: `normalize` seeds it, and a `Default`
            // that seeded too would make a fresh `default()` and a fresh *read*
            // disagree about a file neither has written yet.
            task_columns: Vec::new(),
            board_upgrades: Vec::new(),
            extra: HashMap::new(),
        }
    }
}

impl CalendarData {
    /// Guarantee the invariants every reader relies on.
    ///
    /// The original two: at least one calendar exists, and every event/task
    /// points at a calendar that is actually in the list (a dangling
    /// `calendar_id` — from a hand-edit or a deleted calendar — is refiled into
    /// the default rather than rendering invisibly).
    ///
    /// Since the todo board it also **moves task records between columns**, which
    /// is worth stating plainly because it is no longer just "fix dangling
    /// references": `normalize_tasks` reconciles board placement with VTODO
    /// completion. That reconciliation lives here, rather than in the board's
    /// frontend, precisely because this function runs on every *read* as well as
    /// inside every create/update/save — so the calendar's Tasks view and the
    /// board pass through it equally and cannot drift.
    ///
    /// Every rule below is **idempotent** (each one's postcondition falsifies its
    /// own precondition) and **time-independent** — nothing consults a clock,
    /// because a function that runs on every read must not migrate the same file
    /// differently depending on the hour it was opened.
    pub fn normalize(&mut self) {
        self.version = CALENDAR_VERSION;
        if self.calendars.is_empty() {
            self.calendars.push(Calendar::default_calendar());
        }
        // A set, not the `Vec::contains` this used to be: the board is what makes
        // `tasks` actually grow, and the old form was O(tasks × calendars).
        let known: HashSet<&str> = self.calendars.iter().map(|c| c.id.as_str()).collect();
        let fallback = self.calendars[0].id.clone();
        let orphan = |id: &String| !known.contains(id.as_str());

        let refile: Vec<usize> = self
            .events
            .iter()
            .enumerate()
            .filter(|(_, e)| orphan(&e.calendar_id))
            .map(|(i, _)| i)
            .collect();
        for i in refile {
            self.events[i].calendar_id = fallback.clone();
        }
        let refile: Vec<usize> = self
            .tasks
            .iter()
            .enumerate()
            .filter(|(_, t)| orphan(&t.calendar_id))
            .map(|(i, _)| i)
            .collect();
        for i in refile {
            self.tasks[i].calendar_id = fallback.clone();
        }

        self.upgrade_board();
        self.normalize_tasks();
    }

    /// Bring an **existing** board up to the current default shape, once.
    ///
    /// The date columns (`overdue` / `due_today`) arrived after the board did, so
    /// a board created before them has neither and would never route anything.
    /// This is the one upgrade that runs on a *read* — legitimately, because it
    /// is gated on a board already existing, so the file of someone who only uses
    /// the calendar still never grows board state.
    ///
    /// It runs **once per file**, recorded in `board_upgrades`, and that is not a
    /// nicety: without the marker, deleting the Overdue column would resurrect it
    /// on the very next read, which is the same "a user who deleted it meant it"
    /// rule `normalize_tasks` keeps for the done column. And a *Today* column is
    /// only ever flagged, never invented, for exactly that reason — a board that
    /// no longer has one is left with no today routing rather than being handed
    /// back a column it dropped.
    fn upgrade_board(&mut self) {
        if self.task_columns.is_empty() {
            return;
        }
        if self
            .board_upgrades
            .iter()
            .any(|u| u == BOARD_UPGRADE_DATE_COLUMNS)
        {
            return;
        }
        self.board_upgrades
            .push(BOARD_UPGRADE_DATE_COLUMNS.to_string());

        let seeded = TaskColumn::default_set();
        // First, and before anything moves: pin the column that *is* the fallback
        // today, under the old leftmost-open rule. Once Overdue is inserted at the
        // left and Backlog moves behind Doing, that rule would name a different
        // column, and every unplaced card on the board would quietly change home.
        if !self.task_columns.iter().any(|c| c.intake) {
            let mut open: Vec<&TaskColumn> = self
                .task_columns
                .iter()
                .filter(|c| !c.done && !c.archived)
                .collect();
            open.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.id.cmp(&b.id)));
            if let Some(id) = open.first().map(|c| c.id.clone()) {
                if let Some(col) = self.task_columns.iter_mut().find(|c| c.id == id) {
                    col.intake = true;
                }
            }
        }
        if !self.task_columns.iter().any(|c| c.due_today) {
            if let Some(col) = self.task_columns.iter_mut().find(|c| c.id == "today") {
                col.due_today = true;
            }
        }
        if !self.task_columns.iter().any(|c| c.overdue) {
            let leftmost = self
                .task_columns
                .iter()
                .map(|c| c.position)
                .min()
                .unwrap_or(0);
            if let Some(col) = seeded.iter().find(|c| c.overdue) {
                self.task_columns.push(TaskColumn {
                    position: leftmost - 1,
                    ..col.clone()
                });
            }
        }

        // A board still holding exactly the stock columns gets the stock *order*
        // too — deadline-first, with Backlog behind Doing. A board carrying
        // anything else is one the user has arranged, and only gains the new
        // column at its left edge; rearranging someone's own columns is not an
        // upgrade, it is a board they did not ask for.
        let stock: HashSet<&str> = seeded.iter().map(|c| c.id.as_str()).collect();
        let ids: HashSet<&str> = self.task_columns.iter().map(|c| c.id.as_str()).collect();
        if ids == stock && ids.len() == self.task_columns.len() {
            for col in self.task_columns.iter_mut() {
                if let Some(at) = seeded.iter().find(|c| c.id == col.id) {
                    col.position = at.position;
                }
            }
        }
    }

    /// Seed the default columns if this store has none.
    ///
    /// Called by the board's *write* paths only, never by a read — that split is
    /// the whole reason a calendar-only user's file never grows board state. The
    /// first drag (or column edit) is what says "there is a board here now".
    pub fn ensure_board(&mut self) {
        if self.task_columns.is_empty() {
            self.task_columns = TaskColumn::default_set();
        }
    }

    /// The board half of [`normalize`](Self::normalize): columns, placement,
    /// ranks, tags and subtask ids.
    fn normalize_tasks(&mut self) {
        // Tags and subtask ids are board fields but not *board* state: they are
        // properties of a task however it is being looked at, so they are
        // normalized whether or not a board exists.
        for task in self.tasks.iter_mut() {
            if !task.tags.is_empty() {
                let mut seen: HashSet<String> = HashSet::new();
                let mut kept: Vec<String> = Vec::with_capacity(task.tags.len());
                for tag in task.tags.iter() {
                    let trimmed = tag.trim();
                    if trimmed.is_empty() || kept.len() >= MAX_TAGS {
                        continue;
                    }
                    if seen.insert(trimmed.to_lowercase()) {
                        kept.push(trimmed.to_string());
                    }
                }
                if kept != task.tags {
                    task.tags = kept;
                }
            }
            let task_id = task.id.clone();
            for (i, sub) in task.subtasks.iter_mut().enumerate() {
                if sub.id.is_empty() {
                    sub.id = format!("{task_id}-{i}");
                }
            }
        }

        // 1. No columns means no board — **and this function does not create
        //    one**. Seeding here would grow `task_columns` (and a `column` on
        //    every task) in the file of someone who only ever uses the calendar's
        //    Tasks view, because `normalize` runs on every read: a plain read
        //    would silently rewrite the store. The default set is seeded by the
        //    first *write* the board makes instead (`ensure_board`), and until
        //    then the frontend renders its own default columns and files
        //    unplaced cards into the first of them.
        if self.task_columns.is_empty() {
            return;
        }

        // 2. At most one done column — the first one wins. Never *invent* one: a
        //    user who deleted their Done column meant it, and inventing one
        //    resurrects a column they removed. With none, step 4 is skipped and
        //    the done↔column coupling is simply off.
        let mut seen_done = false;
        for col in self.task_columns.iter_mut() {
            if col.done && seen_done {
                col.done = false;
            } else if col.done {
                seen_done = true;
            }
        }

        // 2b. The same cap on each date flag, for the same reason: the frontend
        //     routes into *the* overdue column and *the* today column, and two
        //     candidates would make which one a card lands in depend on array
        //     order. Never invented either — see `upgrade_board`.
        let mut seen_overdue = false;
        let mut seen_today = false;
        let mut seen_intake = false;
        for col in self.task_columns.iter_mut() {
            if col.overdue && seen_overdue {
                col.overdue = false;
            } else if col.overdue {
                seen_overdue = true;
            }
            if col.due_today && seen_today {
                col.due_today = false;
            } else if col.due_today {
                seen_today = true;
            }
            // The intake column is *the* one a homeless card lands in; two would
            // make that depend on array order.
            if col.intake && seen_intake {
                col.intake = false;
            } else if col.intake {
                seen_intake = true;
            }
        }

        let done_col: Option<String> = self
            .task_columns
            .iter()
            .find(|c| c.done)
            .map(|c| c.id.clone());
        // The destination for a card with no home: the column flagged `intake`,
        // and failing that the old positional rule — the leftmost column that is
        // neither the done one, nor an archive, nor date-governed (falling back to
        // the first column at all, for a board whose only columns are those). An
        // unplaced card must never land in the archive — archiving is a deliberate
        // move — and never in Overdue/Today either, whose contents are a statement
        // about a deadline that this function has no clock to check.
        let col_fallback: String = {
            let flagged = self
                .task_columns
                .iter()
                .find(|c| c.intake)
                .map(|c| c.id.clone());
            let sorted = |mut open: Vec<&TaskColumn>| -> Option<String> {
                open.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.id.cmp(&b.id)));
                open.first().map(|c| c.id.clone())
            };
            let open = |date_ok: bool| {
                self.task_columns
                    .iter()
                    .filter(|c| !c.done && !c.archived && (date_ok || !c.date_governed()))
                    .collect::<Vec<&TaskColumn>>()
            };
            flagged
                .or_else(|| sorted(open(false)))
                .or_else(|| sorted(open(true)))
                .unwrap_or_else(|| self.task_columns[0].id.clone())
        };
        let known_cols: HashSet<&str> = self.task_columns.iter().map(|c| c.id.as_str()).collect();
        // Columns exempt from the done↔column coupling below: a finished card is
        // archived precisely to leave Done, so pulling it back would make the
        // move impossible.
        let archived_cols: HashSet<&str> = self
            .task_columns
            .iter()
            .filter(|c| c.archived)
            .map(|c| c.id.as_str())
            .collect();

        for task in self.tasks.iter_mut() {
            // 3. Refile a card naming a column that is gone — the `calendar_id`
            //    rule again, for the same reason: a dangling id renders nowhere.
            if !task.column.is_empty() && !known_cols.contains(task.column.as_str()) {
                task.column = col_fallback.clone();
            }

            // 4. Reconcile done-ness → column, one-directionally.
            //
            //    `percent`/`completed` are authoritative: they are the
            //    ICS-round-trippable, cross-tool truth that `TasksView` and
            //    `serializeIcs` both read, while `column` is Tabtivity's own and is
            //    the field that can be absent. So this writes **only `column`**,
            //    and never `percent`/`completed` — it also has no clock to mint a
            //    completion stamp with.
            //
            //    The second arm is the case that actually happens: ticking a task
            //    in the calendar's Tasks view changes `percent` and knows nothing
            //    about columns. Un-completing sends the card to the fallback
            //    rather than "wherever it was", because nothing records where it
            //    was and inventing a memory field for a cross-surface edge case
            //    is worse than one predictable, stated destination.
            //    A card resting in an archive is exempt: it stays put whatever
            //    its completion, so a finished card can actually leave Done.
            if let Some(done_id) = &done_col {
                if archived_cols.contains(task.column.as_str()) {
                    // leave it alone
                } else if task.percent >= 100 && &task.column != done_id {
                    task.column = done_id.clone();
                    task.rank = None; // re-ranked to the column's end below
                } else if task.percent < 100 && &task.column == done_id {
                    task.column = col_fallback.clone();
                    task.rank = None;
                }
            }

            // 5. Backfill an unplaced card — **from `percent` only, never from
            //    `due`**. Any date-derived rule is time-dependent, and this runs
            //    on every read: the same file would migrate differently depending
            //    on the hour, and a board would silently reshuffle at midnight.
            //
            //    This is exactly why the Overdue/Today columns are a *display*
            //    rule and not a placement one. The frontend's `columnOf` shows a
            //    card in them by reading its `due` against today's date, and
            //    nothing here or anywhere else writes that decision to the record:
            //    a card is stored in the column the user dragged it to (or the
            //    fallback), and its deadline decides where that is *shown* for as
            //    long as the deadline says so. Which column a card belongs in
            //    otherwise is a statement of intent the user makes by dragging.
            if task.column.is_empty() {
                task.column = match (&done_col, task.percent >= 100) {
                    (Some(done_id), true) => done_id.clone(),
                    _ => col_fallback.clone(),
                };
            }

            // 6. Drop a non-finite rank. Not cosmetic: `CalendarTask` derives
            //    `PartialEq`, and a `NaN` makes equality non-reflexive — which
            //    would silently break every round-trip assertion in the suite and
            //    any frontend memo keyed on deep equality.
            if task.rank.is_some_and(|r| !r.is_finite()) {
                task.rank = None;
            }
        }

        // 7. Backfill missing ranks, per column, in a deterministic and
        //    time-independent order: due date (undated last), then priority
        //    (unset last), then the record's position in the file. Appended after
        //    whatever is already ranked, so an existing board is never reshuffled
        //    by a task arriving from another surface.
        for col in self.task_columns.iter().map(|c| c.id.clone()) {
            let max_rank = self
                .tasks
                .iter()
                .filter(|t| t.column == col)
                .filter_map(|t| t.rank)
                .fold(f64::NEG_INFINITY, f64::max);
            let mut base = if max_rank.is_finite() { max_rank } else { 0.0 };

            let mut unranked: Vec<usize> = self
                .tasks
                .iter()
                .enumerate()
                .filter(|(_, t)| t.column == col && t.rank.is_none())
                .map(|(i, _)| i)
                .collect();
            unranked.sort_by(|&a, &b| {
                let ta = &self.tasks[a];
                let tb = &self.tasks[b];
                let da = ta.due.clone().unwrap_or_else(|| "9999-99-99".to_string());
                let db = tb.due.clone().unwrap_or_else(|| "9999-99-99".to_string());
                let pa = if ta.priority == 0 { 10 } else { ta.priority };
                let pb = if tb.priority == 0 { 10 } else { tb.priority };
                da.cmp(&db).then(pa.cmp(&pb)).then(a.cmp(&b))
            });
            for i in unranked {
                base += RANK_GAP;
                self.tasks[i].rank = Some(base);
            }
        }
    }
}

/// A version-1 event: a start moment, and nothing else.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct LegacyEvent {
    pub id: String,
    /// `"YYYY-MM-DD"`.
    pub date: String,
    /// `"HH:MM"`, or `""` for an all-day event.
    #[serde(default)]
    pub time: String,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// What `calendar.json` may deserialize as. Untagged, so serde tries the current
/// object shape first and falls back to the version-1 array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CalendarFile {
    Current(CalendarData),
    Legacy(Vec<LegacyEvent>),
}

impl CalendarFile {
    /// Collapse either on-disk shape into the current model.
    pub fn into_data(self) -> CalendarData {
        let mut data = match self {
            CalendarFile::Current(data) => data,
            CalendarFile::Legacy(events) => migrate_legacy(events),
        };
        data.normalize();
        data
    }
}

/// Lift version-1 events into the current model.
///
/// An all-day legacy event (`time == ""`) becomes a true all-day event spanning
/// its one day (exclusive end = the next day). A timed one gets a
/// `DEFAULT_EVENT_MINUTES` duration, since v1 stored no end. Unknown keys ride
/// along in `extra`.
pub fn migrate_legacy(events: Vec<LegacyEvent>) -> CalendarData {
    let events = events
        .into_iter()
        .map(|old| {
            let all_day = old.time.is_empty();
            let (start, end) = if all_day {
                (old.date.clone(), add_days(&old.date, 1))
            } else {
                let start = format!("{}T{}", old.date, old.time);
                let end = add_minutes(&start, DEFAULT_EVENT_MINUTES);
                (start, end)
            };
            CalendarEvent {
                id: old.id,
                calendar_id: DEFAULT_CALENDAR_ID.to_string(),
                start,
                end,
                all_day,
                title: old.title,
                notes: old.notes,
                extra: old.extra,
                ..Default::default()
            }
        })
        .collect();

    CalendarData {
        rev: 0,
        version: CALENDAR_VERSION,
        calendars: vec![Calendar::default_calendar()],
        events,
        tasks: Vec::new(),
        task_columns: Vec::new(),
        board_upgrades: Vec::new(),
        extra: HashMap::new(),
    }
}

// ── Date math ───────────────────────────────────────────────────────────────
//
// Just enough civil-date arithmetic to migrate and validate. The frontend owns
// the real calendar math (`src/lib/calendar/calendarTime.ts`); this exists so the backend
// never has to parse a date to serve a request.

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub(crate) fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => 30,
    }
}

/// Parse `"YYYY-MM-DD"` (ignoring any `T…` suffix) into `(y, m, d)`.
pub(crate) fn parse_date(s: &str) -> Option<(i32, u32, u32)> {
    let date = s.split('T').next()?;
    let mut parts = date.split('-');
    let y: i32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) {
        return None;
    }
    Some((y, m, d))
}

/// Add `n` days to a `"YYYY-MM-DD"` date, returning the same format. An
/// unparseable input is returned unchanged rather than panicking — a corrupt
/// record should render oddly, not take the app down.
pub fn add_days(date: &str, n: i64) -> String {
    let Some((mut y, mut m, mut d)) = parse_date(date) else {
        return date.to_string();
    };
    let mut left = n;
    while left > 0 {
        let dim = days_in_month(y, m);
        if d < dim {
            d += 1;
        } else {
            d = 1;
            if m == 12 {
                m = 1;
                y += 1;
            } else {
                m += 1;
            }
        }
        left -= 1;
    }
    while left < 0 {
        if d > 1 {
            d -= 1;
        } else {
            if m == 1 {
                m = 12;
                y -= 1;
            } else {
                m -= 1;
            }
            d = days_in_month(y, m);
        }
        left += 1;
    }
    format!("{y:04}-{m:02}-{d:02}")
}

/// Add `n` minutes to a `"YYYY-MM-DDTHH:MM"` timestamp, rolling the date over as
/// needed. An unparseable input is returned unchanged.
pub fn add_minutes(stamp: &str, n: i64) -> String {
    let Some((date, time)) = stamp.split_once('T') else {
        return stamp.to_string();
    };
    let Some((h, mi)) = time.split_once(':') else {
        return stamp.to_string();
    };
    let (Ok(h), Ok(mi)) = (h.parse::<i64>(), mi.parse::<i64>()) else {
        return stamp.to_string();
    };

    let total = h * 60 + mi + n;
    // Euclidean division, so a negative offset rolls back into the previous day.
    let day_shift = total.div_euclid(24 * 60);
    let within = total.rem_euclid(24 * 60);
    let new_date = add_days(date, day_shift);
    format!("{}T{:02}:{:02}", new_date, within / 60, within % 60)
}

/// Days from 1970-01-01 to a civil date, by Howard Hinnant's `days_from_civil`.
/// Constant-time where [`add_days`] would loop, which is what makes a span
/// between two arbitrary dates affordable.
pub(crate) fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = i64::from(if m <= 2 { y - 1 } else { y });
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = i64::from((m + 9) % 12); // March is 0
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Whole days from `a` to `b`, both `"YYYY-MM-DD"` (a `T…` suffix is ignored).
/// Negative when `b` is the earlier date; `None` when either is unparseable.
pub fn days_between(a: &str, b: &str) -> Option<i64> {
    let (ay, am, ad) = parse_date(a)?;
    let (by, bm, bd) = parse_date(b)?;
    Some(days_from_civil(by, bm, bd) - days_from_civil(ay, am, ad))
}

/// Whole minutes from `a` to `b`, both `"YYYY-MM-DDTHH:MM"`. `None` when either
/// is unparseable — the caller then has no duration to preserve and says so,
/// rather than silently editing an event to a made-up length.
pub fn minutes_between(a: &str, b: &str) -> Option<i64> {
    let minutes_of = |stamp: &str| -> Option<i64> {
        let (_, time) = stamp.split_once('T')?;
        let (h, mi) = time.split_once(':')?;
        let (h, mi): (i64, i64) = (h.parse().ok()?, mi.parse().ok()?);
        (h < 24 && mi < 60).then_some(h * 60 + mi)
    };
    Some(days_between(a, b)? * 24 * 60 + minutes_of(b)? - minutes_of(a)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_days_rolls_month_and_year() {
        assert_eq!(add_days("2026-07-08", 1), "2026-07-09");
        assert_eq!(add_days("2026-07-31", 1), "2026-08-01");
        assert_eq!(add_days("2026-12-31", 1), "2027-01-01");
        assert_eq!(add_days("2026-01-01", -1), "2025-12-31");
        assert_eq!(add_days("2026-03-01", -1), "2026-02-28");
    }

    #[test]
    fn add_days_handles_leap_february() {
        assert_eq!(add_days("2024-02-28", 1), "2024-02-29");
        assert_eq!(add_days("2024-03-01", -1), "2024-02-29");
        assert_eq!(add_days("2026-02-28", 1), "2026-03-01");
    }

    #[test]
    fn add_days_leaves_garbage_alone() {
        assert_eq!(add_days("not-a-date", 1), "not-a-date");
    }

    #[test]
    fn days_between_spans_months_years_and_leap_days() {
        assert_eq!(days_between("2026-09-17", "2026-09-17"), Some(0));
        assert_eq!(days_between("2026-09-17", "2026-09-20"), Some(3));
        assert_eq!(days_between("2026-09-20", "2026-09-17"), Some(-3));
        assert_eq!(days_between("2024-02-28", "2024-03-01"), Some(2));
        assert_eq!(days_between("2026-02-28", "2026-03-01"), Some(1));
        assert_eq!(days_between("2025-12-31", "2026-01-01"), Some(1));
        // The `T…` suffix of a timed stamp is ignored, as `parse_date` does.
        assert_eq!(days_between("2026-09-17T23:00", "2026-09-18T01:00"), Some(1));
        assert_eq!(days_between("nonsense", "2026-09-17"), None);
    }

    #[test]
    fn minutes_between_measures_a_span_across_midnight() {
        assert_eq!(minutes_between("2026-09-17T09:00", "2026-09-17T10:30"), Some(90));
        assert_eq!(minutes_between("2026-09-17T23:30", "2026-09-18T00:30"), Some(60));
        assert_eq!(minutes_between("2026-09-18T00:30", "2026-09-17T23:30"), Some(-60));
        // Its inverse: adding the span back lands on the far end.
        let (start, end) = ("2026-09-17T14:15", "2026-09-19T08:45");
        assert_eq!(add_minutes(start, minutes_between(start, end).unwrap()), end);
        assert_eq!(minutes_between("2026-09-17", "2026-09-18T09:00"), None);
    }

    #[test]
    fn add_minutes_rolls_across_midnight() {
        assert_eq!(add_minutes("2026-07-08T09:00", 60), "2026-07-08T10:00");
        assert_eq!(add_minutes("2026-07-08T23:30", 60), "2026-07-09T00:30");
        assert_eq!(add_minutes("2026-07-08T00:15", -30), "2026-07-07T23:45");
        assert_eq!(add_minutes("2026-12-31T23:00", 120), "2027-01-01T01:00");
    }

    #[test]
    fn migrate_timed_legacy_event() {
        let data = migrate_legacy(vec![LegacyEvent {
            id: "a".into(),
            date: "2026-07-08".into(),
            time: "09:00".into(),
            title: "standup".into(),
            notes: "daily".into(),
            extra: HashMap::new(),
        }]);
        assert_eq!(data.version, CALENDAR_VERSION);
        assert_eq!(data.calendars.len(), 1);
        let ev = &data.events[0];
        assert_eq!(ev.start, "2026-07-08T09:00");
        assert_eq!(ev.end, "2026-07-08T10:00");
        assert!(!ev.all_day);
        assert_eq!(ev.title, "standup");
        assert_eq!(ev.notes, "daily");
        assert_eq!(ev.calendar_id, DEFAULT_CALENDAR_ID);
    }

    #[test]
    fn migrate_all_day_legacy_event() {
        let data = migrate_legacy(vec![LegacyEvent {
            id: "a".into(),
            date: "2026-07-08".into(),
            time: String::new(),
            title: "holiday".into(),
            ..Default::default()
        }]);
        let ev = &data.events[0];
        assert!(ev.all_day);
        assert_eq!(ev.start, "2026-07-08");
        // Exclusive end: a one-day all-day event ends on the NEXT day.
        assert_eq!(ev.end, "2026-07-09");
    }

    #[test]
    fn legacy_array_deserializes_through_untagged() {
        let raw = r#"[{"id":"a","date":"2026-07-08","time":"09:00","title":"standup"}]"#;
        let file: CalendarFile = serde_json::from_str(raw).unwrap();
        let data = file.into_data();
        assert_eq!(data.events.len(), 1);
        assert_eq!(data.events[0].start, "2026-07-08T09:00");
    }

    #[test]
    fn current_object_deserializes_through_untagged() {
        let raw = r#"{"version":2,"calendars":[],"events":[],"tasks":[]}"#;
        let file: CalendarFile = serde_json::from_str(raw).unwrap();
        let data = file.into_data();
        // normalize() backfills the default calendar.
        assert_eq!(data.calendars.len(), 1);
        assert_eq!(data.calendars[0].id, DEFAULT_CALENDAR_ID);
    }

    #[test]
    fn normalize_refiles_orphaned_events() {
        let mut data = CalendarData {
            rev: 0,
            version: CALENDAR_VERSION,
            calendars: vec![Calendar::default_calendar()],
            events: vec![CalendarEvent {
                id: "a".into(),
                calendar_id: "deleted-cal".into(),
                ..Default::default()
            }],
            tasks: vec![CalendarTask {
                id: "t".into(),
                calendar_id: "deleted-cal".into(),
                ..Default::default()
            }],
            task_columns: Vec::new(),
            board_upgrades: Vec::new(),
            extra: HashMap::new(),
        };
        data.normalize();
        assert_eq!(data.events[0].calendar_id, DEFAULT_CALENDAR_ID);
        assert_eq!(data.tasks[0].calendar_id, DEFAULT_CALENDAR_ID);
    }

    #[test]
    fn unknown_keys_round_trip() {
        let raw = r#"{"version":2,"calendars":[],"events":[
            {"id":"a","calendar_id":"default","start":"2026-07-08T09:00",
             "end":"2026-07-08T10:00","title":"x","future_field":"keep me"}
        ],"tasks":[],"top_level_future":"also keep"}"#;
        let data: CalendarFile = serde_json::from_str(raw).unwrap();
        let data = data.into_data();
        let out = serde_json::to_string(&data).unwrap();
        assert!(out.contains("keep me"), "event extra must survive: {out}");
        assert!(out.contains("also keep"), "file extra must survive: {out}");
    }

    // ── Board: columns, placement, ranks ────────────────────────────────────

    /// A store whose board already exists — the shape every board test starts
    /// from, since the columns are seeded by the first board *write* rather than
    /// by `normalize` (see `no_board_means_normalize_leaves_tasks_alone`).
    fn board(tasks: Vec<CalendarTask>) -> CalendarData {
        CalendarData {
            rev: 0,
            version: CALENDAR_VERSION,
            calendars: vec![Calendar::default_calendar()],
            events: Vec::new(),
            tasks,
            task_columns: TaskColumn::default_set(),
            board_upgrades: Vec::new(),
            extra: HashMap::new(),
        }
    }

    fn task(id: &str) -> CalendarTask {
        CalendarTask {
            id: id.into(),
            calendar_id: DEFAULT_CALENDAR_ID.into(),
            title: id.into(),
            ..Default::default()
        }
    }

    fn done_column_id(data: &CalendarData) -> String {
        data.task_columns
            .iter()
            .find(|c| c.done)
            .map(|c| c.id.clone())
            .expect("seeded board has a done column")
    }

    #[test]
    fn ensure_board_seeds_the_default_columns() {
        let mut data = CalendarData::default();
        data.ensure_board();
        assert_eq!(data.task_columns.len(), 6);
        assert_eq!(data.task_columns.iter().filter(|c| c.done).count(), 1);
        assert_eq!(data.task_columns.iter().filter(|c| c.archived).count(), 1);
        assert_eq!(data.task_columns.iter().filter(|c| c.overdue).count(), 1);
        assert_eq!(data.task_columns.iter().filter(|c| c.due_today).count(), 1);
        assert_eq!(data.task_columns.iter().filter(|c| c.intake).count(), 1);
        assert_eq!(done_column_id(&data), "done");
        // Deadline first, then intent — and the intake column is *not* the
        // leftmost open one any more, which is why it is flagged.
        assert_eq!(
            data.task_columns.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["overdue", "today", "doing", "backlog", "done", "archived"],
        );
        assert_eq!(
            data.task_columns.iter().find(|c| c.intake).map(|c| c.id.as_str()),
            Some("backlog"),
        );

        // Idempotent: a second call must not duplicate or re-seed.
        let once = data.clone();
        data.ensure_board();
        assert_eq!(data, once);
    }

    /// The board that existed before the date columns did.
    fn legacy_board() -> Vec<TaskColumn> {
        [
            ("backlog", false, false),
            ("today", false, false),
            ("doing", false, false),
            ("done", true, false),
            ("archived", false, true),
        ]
        .iter()
        .enumerate()
        .map(|(i, (id, done, archived))| TaskColumn {
            id: (*id).to_string(),
            name: (*id).to_string(),
            position: i as i64,
            done: *done,
            archived: *archived,
            ..Default::default()
        })
        .collect()
    }

    #[test]
    fn an_old_board_gains_the_date_columns_once() {
        let mut data = board(vec![task("t")]);
        data.task_columns = legacy_board();
        data.normalize();

        assert_eq!(
            data.task_columns
                .iter()
                .map(|c| (c.id.as_str(), c.position))
                .collect::<Vec<_>>(),
            [
                ("backlog", 3),
                ("today", 1),
                ("doing", 2),
                ("done", 4),
                ("archived", 5),
                ("overdue", 0),
            ],
            "a stock board gets the stock order, wherever the new column was pushed"
        );
        assert!(data.task_columns.iter().find(|c| c.id == "today").unwrap().due_today);
        assert!(data.task_columns.iter().find(|c| c.id == "backlog").unwrap().intake);
        // The card's home must not have moved from under it.
        assert_eq!(data.tasks[0].column, "backlog");

        // Idempotent, and — the point of the marker — a column deleted *after*
        // the upgrade stays deleted.
        let once = data.clone();
        data.normalize();
        assert_eq!(data, once);
        data.task_columns.retain(|c| c.id != "overdue");
        data.normalize();
        assert!(
            !data.task_columns.iter().any(|c| c.overdue),
            "an upgrade must not resurrect a column the user removed"
        );
    }

    /// A board someone arranged themselves is not rearranged: it gains Overdue at
    /// its left edge and keeps everything else exactly where it was — including
    /// which column unplaced cards land in.
    #[test]
    fn upgrading_a_custom_board_only_adds_the_new_column() {
        let mut data = board(vec![task("t")]);
        data.task_columns = vec![
            TaskColumn {
                id: "inbox".into(),
                name: "Inbox".into(),
                position: 0,
                ..Default::default()
            },
            TaskColumn {
                id: "doing".into(),
                name: "Doing".into(),
                position: 1,
                ..Default::default()
            },
        ];
        data.normalize();

        assert_eq!(data.task_columns.len(), 3);
        let added = data.task_columns.iter().find(|c| c.overdue).unwrap();
        assert_eq!(added.id, "overdue");
        assert!(added.position < 0, "the new column sits at the left edge");
        assert!(
            !data.task_columns.iter().any(|c| c.due_today),
            "a Today column is flagged, never invented"
        );
        assert_eq!(
            data.task_columns.iter().find(|c| c.intake).map(|c| c.id.as_str()),
            Some("inbox"),
            "the board's existing fallback keeps taking unplaced cards"
        );
        assert_eq!(data.tasks[0].column, "inbox");
    }

    /// An unplaced card is filed into the intake column, never into a date one:
    /// `normalize` has no clock, and "due today" is not a thing it can know.
    #[test]
    fn an_unplaced_card_is_never_filed_into_a_date_column() {
        let mut data = board(vec![CalendarTask {
            due: Some("2026-01-01".into()),
            ..task("t")
        }]);
        data.task_columns = TaskColumn::default_set();
        data.normalize();
        assert_eq!(data.tasks[0].column, "backlog");
    }

    /// The rule that keeps a calendar-only user's file clean: reading (which is
    /// what `normalize` runs on) must never create a board, or every plain read
    /// would silently rewrite the store with board state its owner never asked
    /// for.
    #[test]
    fn no_board_means_normalize_leaves_tasks_unplaced() {
        let mut data = CalendarData {
            rev: 0,
            version: CALENDAR_VERSION,
            calendars: vec![Calendar::default_calendar()],
            events: Vec::new(),
            tasks: vec![task("t")],
            task_columns: Vec::new(),
            board_upgrades: Vec::new(),
            extra: HashMap::new(),
        };
        data.normalize();
        assert!(
            data.task_columns.is_empty(),
            "a read must not create a board"
        );
        assert!(data.tasks[0].column.is_empty());
        assert_eq!(data.tasks[0].rank, None);
    }

    /// …but the task-level tidying is not board state, so it still runs.
    #[test]
    fn tags_and_subtask_ids_normalize_without_a_board() {
        let mut data = CalendarData {
            rev: 0,
            version: CALENDAR_VERSION,
            calendars: vec![Calendar::default_calendar()],
            events: Vec::new(),
            tasks: vec![CalendarTask {
                tags: vec![" Work ".into(), "work".into()],
                subtasks: vec![Subtask {
                    title: "s".into(),
                    ..Default::default()
                }],
                ..task("t")
            }],
            task_columns: Vec::new(),
            board_upgrades: Vec::new(),
            extra: HashMap::new(),
        };
        data.normalize();
        assert_eq!(data.tasks[0].tags, vec!["Work"]);
        assert_eq!(data.tasks[0].subtasks[0].id, "t-0");
    }

    #[test]
    fn normalize_is_idempotent() {
        let mut data = board(vec![
            task("open"),
            CalendarTask {
                percent: 100,
                ..task("finished")
            },
            CalendarTask {
                column: "gone".into(),
                ..task("orphan")
            },
            CalendarTask {
                tags: vec![" Work ".into(), "work".into(), String::new()],
                subtasks: vec![Subtask {
                    title: "step".into(),
                    ..Default::default()
                }],
                ..task("messy")
            },
        ]);
        data.normalize();
        let once = data.clone();
        data.normalize();
        assert_eq!(data, once, "normalize must be a no-op the second time");
    }

    #[test]
    fn unplaced_tasks_are_filed_by_percent_not_by_due() {
        let mut data = board(vec![
            CalendarTask {
                due: Some("1999-01-01".into()),
                ..task("long-overdue")
            },
            CalendarTask {
                percent: 100,
                ..task("finished")
            },
        ]);
        data.normalize();
        // The overdue one lands in the leftmost open column — NOT in "today",
        // which is what a due-date-derived rule would have done.
        assert_eq!(data.tasks[0].column, "backlog");
        assert_eq!(data.tasks[1].column, done_column_id(&data));
    }

    #[test]
    fn backfill_does_not_depend_on_the_clock() {
        // The same task, once with a due date far in the past and once far in the
        // future, must be filed identically — the property that lets normalize
        // run on every read.
        let mut past = board(vec![CalendarTask {
            due: Some("1999-01-01".into()),
            ..task("t")
        }]);
        let mut future = board(vec![CalendarTask {
            due: Some("2999-01-01".into()),
            ..task("t")
        }]);
        past.normalize();
        future.normalize();
        assert_eq!(past.tasks[0].column, future.tasks[0].column);
    }

    #[test]
    fn normalize_refiles_orphan_columns() {
        let mut data = board(vec![CalendarTask {
            column: "deleted-col".into(),
            ..task("t")
        }]);
        data.normalize();
        assert_eq!(data.tasks[0].column, "backlog");
    }

    #[test]
    fn completing_a_task_moves_it_to_the_done_column() {
        let mut data = board(vec![CalendarTask {
            column: "doing".into(),
            rank: Some(RANK_GAP),
            percent: 100,
            ..task("t")
        }]);
        data.normalize();
        assert_eq!(data.tasks[0].column, done_column_id(&data));
    }

    #[test]
    fn uncompleting_a_task_moves_it_out_of_done() {
        let mut data = board(vec![CalendarTask {
            column: "done".into(),
            rank: Some(RANK_GAP),
            percent: 0,
            ..task("t")
        }]);
        data.normalize();
        assert_eq!(data.tasks[0].column, "backlog");
    }

    #[test]
    fn an_archived_card_stays_put_when_complete() {
        // The whole point of the archive: a finished card filed there is NOT
        // pulled back into Done by the completion coupling.
        let mut data = board(vec![CalendarTask {
            column: "archived".into(),
            rank: Some(RANK_GAP),
            percent: 100,
            ..task("t")
        }]);
        data.normalize();
        assert_eq!(data.tasks[0].column, "archived");
    }

    #[test]
    fn an_incomplete_card_may_rest_in_the_archive() {
        // And an abandoned (not-done) card may sit there too — the archive has
        // no completion coupling in either direction.
        let mut data = board(vec![CalendarTask {
            column: "archived".into(),
            rank: Some(RANK_GAP),
            percent: 0,
            ..task("t")
        }]);
        data.normalize();
        assert_eq!(data.tasks[0].column, "archived");
    }

    #[test]
    fn an_unplaced_card_is_never_filed_into_the_archive() {
        // The fallback for a homeless card is the leftmost *open* column, never
        // the archive — archiving is a deliberate move, not a resting default.
        let mut data = board(vec![task("t")]);
        data.normalize();
        assert_eq!(data.tasks[0].column, "backlog");
    }

    #[test]
    fn normalize_never_writes_percent_or_completed() {
        // A card sitting in Done with percent 0 gets *moved*; its completion
        // fields are left exactly as they were, because normalize has no clock
        // and percent/completed are the authoritative half.
        let mut data = board(vec![CalendarTask {
            column: "done".into(),
            percent: 0,
            completed: None,
            ..task("t")
        }]);
        data.normalize();
        assert_eq!(data.tasks[0].percent, 0);
        assert_eq!(data.tasks[0].completed, None);
    }

    #[test]
    fn no_done_column_disables_the_coupling() {
        let mut data = board(vec![CalendarTask {
            column: "doing".into(),
            percent: 100,
            ..task("t")
        }]);
        data.task_columns = TaskColumn::default_set()
            .into_iter()
            .filter(|c| !c.done)
            .collect();
        data.normalize();
        assert_eq!(data.tasks[0].column, "doing", "no Done column, no move");
    }

    #[test]
    fn at_most_one_done_column_survives() {
        let mut data = board(Vec::new());
        data.task_columns = vec![
            TaskColumn {
                id: "a".into(),
                name: "A".into(),
                done: true,
                ..Default::default()
            },
            TaskColumn {
                id: "b".into(),
                name: "B".into(),
                position: 1,
                done: true,
                ..Default::default()
            },
        ];
        data.normalize();
        assert_eq!(data.task_columns.iter().filter(|c| c.done).count(), 1);
        assert_eq!(done_column_id(&data), "a", "the first one wins");
    }

    #[test]
    fn ranks_backfill_in_a_deterministic_order() {
        // Due date first (undated last), then priority, then file order.
        let mut data = board(vec![
            task("undated"),
            CalendarTask {
                due: Some("2026-08-01".into()),
                ..task("later")
            },
            CalendarTask {
                due: Some("2026-07-01".into()),
                ..task("sooner")
            },
        ]);
        data.normalize();
        let mut ordered: Vec<&CalendarTask> = data.tasks.iter().collect();
        ordered.sort_by(|a, b| a.rank.unwrap().total_cmp(&b.rank.unwrap()));
        let ids: Vec<&str> = ordered.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["sooner", "later", "undated"]);
    }

    #[test]
    fn non_finite_ranks_are_dropped() {
        let mut data = board(vec![CalendarTask {
            column: "backlog".into(),
            rank: Some(f64::NAN),
            ..task("t")
        }]);
        data.normalize();
        assert!(data.tasks[0].rank.is_some_and(|r| r.is_finite()));
        // The reflexivity trap: a NaN anywhere makes `PartialEq` non-reflexive,
        // which would silently break every round-trip assertion in this suite.
        assert_eq!(data, data.clone());
    }

    #[test]
    fn tags_are_trimmed_deduped_and_capped() {
        let mut data = board(vec![CalendarTask {
            tags: vec![" Work ".into(), "work".into(), String::new(), "home".into()],
            ..task("t")
        }]);
        data.normalize();
        assert_eq!(data.tasks[0].tags, vec!["Work", "home"]);

        let mut many = board(vec![CalendarTask {
            tags: (0..40).map(|i| format!("tag{i}")).collect(),
            ..task("t")
        }]);
        many.normalize();
        assert_eq!(many.tasks[0].tags.len(), MAX_TAGS);
    }

    #[test]
    fn empty_subtask_ids_are_backfilled() {
        let mut data = board(vec![CalendarTask {
            subtasks: vec![
                Subtask {
                    title: "one".into(),
                    ..Default::default()
                },
                Subtask {
                    id: "kept".into(),
                    title: "two".into(),
                    ..Default::default()
                },
            ],
            ..task("t")
        }]);
        data.normalize();
        assert_eq!(data.tasks[0].subtasks[0].id, "t-0");
        assert_eq!(data.tasks[0].subtasks[1].id, "kept");
    }

    #[test]
    fn a_file_written_without_board_fields_still_loads() {
        let raw = r#"{"version":2,"calendars":[],"events":[],"tasks":[
            {"id":"t","calendar_id":"default","title":"old"}
        ]}"#;
        let data: CalendarFile = serde_json::from_str(raw).unwrap();
        let mut data = data.into_data();
        // Loading alone leaves it unplaced — reading creates no board.
        assert!(data.tasks[0].column.is_empty());
        // Once a board exists, the pre-existing task is filed and ranked without
        // anyone having had to migrate it.
        data.ensure_board();
        data.normalize();
        assert_eq!(data.tasks[0].column, "backlog");
        assert!(data.tasks[0].rank.is_some());
    }

    #[test]
    fn board_fields_are_omitted_when_empty() {
        // A calendar that never opened the board must not grow board keys.
        let out = serde_json::to_string(&CalendarData::default()).unwrap();
        for key in ["task_columns", "column", "rank", "tags", "subtasks", "mail"] {
            assert!(!out.contains(key), "{key} must not be written: {out}");
        }
    }

    /// The "an older Tabtivity does not lose data" claim, mechanically: a build that
    /// has never heard of the board fields keeps them in its `extra` flatten and
    /// writes them back out.
    #[test]
    fn an_older_build_round_trips_the_board_fields() {
        #[derive(Serialize, Deserialize)]
        struct OldTask {
            id: String,
            #[serde(default)]
            calendar_id: String,
            title: String,
            #[serde(default)]
            percent: u8,
            #[serde(flatten)]
            extra: HashMap<String, Value>,
        }

        let mine = CalendarTask {
            column: "doing".into(),
            rank: Some(2048.0),
            tags: vec!["v2".into()],
            mail: Some(TaskMailLink {
                message_id: "inbox-42".into(),
                subject: "hi".into(),
                ..Default::default()
            }),
            event: Some(TaskEventLink {
                event_id: "ev-7".into(),
                occurrence_start: "2026-07-30T09:00".into(),
                ..Default::default()
            }),
            file: Some(TaskFileLink {
                project_id: "proj".into(),
                path: "src/lib.rs".into(),
                line: Some(9),
                text: "snapshot".into(),
            }),
            project_id: "proj".into(),
            ..task("t")
        };
        let json = serde_json::to_string(&mine).unwrap();

        // Old build reads it, then writes it back untouched.
        let old: OldTask = serde_json::from_str(&json).unwrap();
        let rewritten = serde_json::to_string(&old).unwrap();

        // New build reads what the old build wrote.
        let back: CalendarTask = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(back.column, "doing");
        assert_eq!(back.rank, Some(2048.0));
        assert_eq!(back.tags, vec!["v2"]);
        assert_eq!(back.project_id, "proj");
        assert_eq!(back.file.as_ref().map(|f| f.path.as_str()), Some("src/lib.rs"));
        assert_eq!(back.mail.unwrap().message_id, "inbox-42");
        let event = back.event.unwrap();
        assert_eq!(event.event_id, "ev-7");
        assert_eq!(event.occurrence_start, "2026-07-30T09:00");
    }

    #[test]
    fn board_fields_survive_an_unknown_key_round_trip() {
        let raw = r#"{"version":3,"calendars":[],"events":[],
            "task_columns":[{"id":"a","name":"A","col_future":"keep col"}],
            "tasks":[{"id":"t","calendar_id":"default","title":"x","column":"a",
                      "tags":["k"],"subtasks":[{"title":"s","sub_future":"keep sub"}],
                      "task_future":"keep task"}]}"#;
        let data: CalendarFile = serde_json::from_str(raw).unwrap();
        let data = data.into_data();
        let out = serde_json::to_string(&data).unwrap();
        for expected in ["keep col", "keep sub", "keep task"] {
            assert!(out.contains(expected), "{expected} must survive: {out}");
        }
    }

    #[test]
    fn version_is_stamped_but_never_branched_on() {
        // Two files claiming wildly different versions normalize identically —
        // the property that makes an older build's write-back harmless.
        let mk = |v: u32| {
            let raw = format!(
                r#"{{"version":{v},"calendars":[],"events":[],"tasks":[
                    {{"id":"t","calendar_id":"default","title":"x"}}]}}"#
            );
            serde_json::from_str::<CalendarFile>(&raw)
                .unwrap()
                .into_data()
        };
        let old = mk(1);
        let future = mk(99);
        assert_eq!(old, future);
        assert_eq!(old.version, CALENDAR_VERSION);
    }

    #[test]
    fn rrule_numbered_weekdays_round_trip_and_old_rules_still_load() {
        let raw = r#"{"freq":"monthly","interval":1,"bynthweekday":[{"n":2,"day":2},{"n":-1,"day":5}],"ics_value":"FREQ=MONTHLY;BYDAY=2TU,-1FR;BYHOUR=9"}"#;
        let rule: Rrule = serde_json::from_str(raw).unwrap();
        assert_eq!(
            rule.bynthweekday,
            vec![NthWeekday { n: 2, day: 2 }, NthWeekday { n: -1, day: 5 }]
        );
        assert_eq!(rule.ics_value.as_deref(), Some("FREQ=MONTHLY;BYDAY=2TU,-1FR;BYHOUR=9"));
        assert!(rule.extra.is_empty());
        let back: Rrule = serde_json::from_str(&serde_json::to_string(&rule).unwrap()).unwrap();
        assert_eq!(back, rule);

        // A rule written before either field existed loads, and writes neither.
        let old: Rrule = serde_json::from_str(r#"{"freq":"weekly","interval":2,"byweekday":[1]}"#).unwrap();
        assert!(old.bynthweekday.is_empty() && old.ics_value.is_none());
        let out = serde_json::to_string(&old).unwrap();
        assert!(!out.contains("bynthweekday") && !out.contains("ics_value"), "{out}");
    }
}
