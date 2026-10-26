//! The `calendar` group of `services/`: every module here is re-exported from
//! `services/mod.rs`, so `crate::services::<module>` keeps resolving.

// CalDAV accounts (docs/caldav_plan.md): the WebDAV transport half. Hand-rolled
// on reqwest + roxmltree; iCalendar itself is still parsed by src/lib/calendar/ics.ts.
pub mod caldav;
// Calendar reminders' due set and their cross-process fired record (headless
// owner plan, H2): the window claims before showing, the sidecar pushes with
// no window open.
pub mod calendar_alarms;
// Recurrence expansion and to-do board routing, the backend twins of
// `src/lib/calendar/recurrence.ts` and `src/lib/todoBoard.ts`, so the Mobile
// sidecar answers a month and the board with no window (headless owner, H0).
pub mod calendar_recurrence;
pub mod todo_board;
