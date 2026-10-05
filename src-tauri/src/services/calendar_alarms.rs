//! Calendar reminders, the backend twin of `src/lib/calendar/alarms.ts`
//! (headless owner plan, H2).
//!
//! The window's reminder engine expands the calendar over a window, finds
//! the alarms that have come due and not yet fired, and shows each once. Two
//! things move here so a reminder fires exactly once whoever is up:
//!
//! - `due_alarms` and its helpers, so the Mobile sidecar can find what is
//!   due with no window open (`mobile_control::alarms` pushes it to the
//!   phone);
//! - the **fired record**, a file in the state dir edited under its
//!   `FileLock`: whoever wants to show a reminder claims its key first
//!   (`claim_in`), and a key already there is somebody else's. The window
//!   keeps its `localStorage` set as a fast local guard and claims here
//!   before showing; the sidecar claims here alone.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::schema::calendar::{add_days, add_minutes, minutes_between, CalendarData};
use crate::services::calendar_recurrence::{expand_events, Occurrence};
use crate::storage;

const FILE_NAME: &str = "calendar-alarms-fired.json";
/// `MAX_FIRED`: the newest keys kept; the oldest can never come due again.
const MAX_FIRED: usize = 500;
/// `graceMinutes`: a reminder later than this is noise, not information.
pub const GRACE_MINUTES: i64 = 24 * 60;

/// A reminder that has come due (`DueAlarm`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueAlarm {
    /// `alarmKey`: the dedup key.
    pub key: String,
    pub event_id: String,
    pub calendar_id: String,
    pub occurrence_start: String,
    pub minutes_before: i64,
    pub title: String,
    pub location: String,
    /// The occurrence's real start, for the "at 09:00" line.
    pub start: String,
    pub all_day: bool,
}

pub fn alarm_key(event_id: &str, occurrence_start: &str, minutes_before: i64) -> String {
    format!("{event_id}@{occurrence_start}@{minutes_before}")
}

/// `alarmTime`: the occurrence's start less the offset; an all-day event's
/// reminders are measured from 09:00 on its day.
pub fn alarm_time(occurrence: &Occurrence, minutes_before: i64) -> String {
    let anchor = if occurrence.all_day {
        format!("{}T09:00", occurrence.start.split('T').next().unwrap_or(&occurrence.start))
    } else {
        occurrence.start.clone()
    };
    add_minutes(&anchor, -minutes_before)
}

/// `alarmWindow`: far enough back for a reminder that came due while nothing
/// ran, far enough forward for the longest lead any event asks for.
pub fn alarm_window(data: &CalendarData, today: &str) -> (String, String) {
    let max_lead = data.events.iter().flat_map(|e| e.alarms.iter()).map(|a| a.minutes_before).max().unwrap_or(0);
    let lead_days = (max_lead.max(0) + 24 * 60 - 1) / (24 * 60) + 1;
    (add_days(today, -1), add_days(today, lead_days + 1))
}

/// `dueAlarms`: every reminder whose time has arrived within the grace and
/// whose key is not in `fired`, over the whole calendar (hidden calendars
/// included — a mute is `alerts_off`, decided by the caller).
pub fn due_alarms(data: &CalendarData, fired: &HashSet<String>, now: &str) -> Vec<DueAlarm> {
    let today = now.split('T').next().unwrap_or(now);
    let (start, end) = alarm_window(data, today);
    let mut out = Vec::new();
    for occurrence in expand_events(&data.events, &start, &end, None) {
        for alarm in &occurrence.alarms {
            let key = alarm_key(&occurrence.event_id, &occurrence.occurrence_start, alarm.minutes_before);
            if fired.contains(&key) {
                continue;
            }
            let at = alarm_time(&occurrence, alarm.minutes_before);
            let Some(late_by) = minutes_between(&at, now) else { continue };
            if !(0..=GRACE_MINUTES).contains(&late_by) {
                continue;
            }
            out.push(DueAlarm {
                key,
                event_id: occurrence.event_id.clone(),
                calendar_id: occurrence.calendar_id.clone(),
                occurrence_start: occurrence.occurrence_start.clone(),
                minutes_before: alarm.minutes_before,
                title: occurrence.title.clone(),
                location: occurrence.location.clone(),
                start: occurrence.start.clone(),
                all_day: occurrence.all_day,
            });
        }
    }
    out
}

/// `mutedCalendarIds`: the calendars whose reminders are switched off
/// (`Calendar.alerts_off`, a frontend-owned flag in `extra`).
pub fn muted_calendars(data: &CalendarData) -> HashSet<String> {
    data.calendars
        .iter()
        .filter(|c| c.extra.get("alerts_off").and_then(serde_json::Value::as_bool) == Some(true))
        .map(|c| c.id.clone())
        .collect()
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct FiredFile {
    #[serde(default)]
    fired: Vec<String>,
}

/// `<state_dir>/calendar-alarms-fired.json`.
pub fn fired_file(state_dir: &Path) -> PathBuf {
    state_dir.join(FILE_NAME)
}

fn read_fired(path: &Path) -> FiredFile {
    storage::read_json(path).unwrap_or_default()
}

/// The keys on record at `path` (a read, no lock).
pub fn fired_in(path: &Path) -> HashSet<String> {
    read_fired(path).fired.into_iter().collect()
}

/// Claim `keys` as fired: the ones nobody had claimed are answered, and all
/// of them are on record afterwards. One transaction under the file's lock,
/// so two windows, or a window and the sidecar, asking for one key get it
/// once between them. Nothing is written when nothing is new.
pub fn claim_in(path: &Path, keys: &[String]) -> Result<Vec<String>, String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    let mut file = read_fired(path);
    let known: HashSet<&str> = file.fired.iter().map(String::as_str).collect();
    let mut granted: Vec<String> = Vec::new();
    for key in keys {
        if key.is_empty() || known.contains(key.as_str()) || granted.contains(key) {
            continue;
        }
        granted.push(key.clone());
    }
    if granted.is_empty() {
        return Ok(granted);
    }
    file.fired.extend(granted.iter().cloned());
    if file.fired.len() > MAX_FIRED {
        let drop = file.fired.len() - MAX_FIRED;
        file.fired.drain(..drop);
    }
    storage::write_json_atomic(path, &file).map_err(|e| e.to_string())?;
    Ok(granted)
}

/// [`claim_in`] on the state dir's record.
pub fn claim(keys: &[String]) -> Result<Vec<String>, String> {
    claim_in(&fired_file(&storage::state_dir()), keys)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::calendar::{Alarm, Calendar, CalendarEvent};
    use std::collections::HashMap;

    fn event(id: &str, calendar: &str, start: &str, end: &str, all_day: bool, minutes: &[i64]) -> CalendarEvent {
        let mut event: CalendarEvent = serde_json::from_value(serde_json::json!({
            "id": id, "calendar_id": calendar, "start": start, "end": end, "all_day": all_day,
            "title": id, "location": "Room 2",
        }))
        .unwrap();
        event.alarms = minutes.iter().map(|m| Alarm { minutes_before: *m, extra: HashMap::new() }).collect();
        event
    }

    fn calendar(id: &str, muted: bool) -> Calendar {
        let mut calendar: Calendar =
            serde_json::from_value(serde_json::json!({ "id": id, "name": id, "color": "#4aa3df" })).unwrap();
        if muted {
            calendar.extra.insert("alerts_off".into(), serde_json::json!(true));
        }
        calendar
    }

    /// The frontend's cases: a reminder is due from its time for a day,
    /// not before and not after; an all-day event's is measured from 09:00;
    /// a fired key is skipped; a mute is a separate answer.
    #[test]
    fn due_alarms_match_the_windows() {
        let data = CalendarData {
            calendars: vec![calendar("work", true), calendar("home", false)],
            events: vec![
                event("standup", "work", "2026-07-08T09:00", "2026-07-08T10:00", false, &[15]),
                event("dentist", "home", "2026-07-08T09:00", "2026-07-08T10:00", false, &[15, 60]),
                event("birthday", "home", "2026-07-09", "2026-07-10", true, &[24 * 60 + 10]),
                event("old", "home", "2026-07-06T09:00", "2026-07-06T10:00", false, &[15]),
            ],
            ..CalendarData::default()
        };
        let none = HashSet::new();
        let keys = |now: &str| due_alarms(&data, &none, now).into_iter().map(|a| a.key).collect::<Vec<_>>();
        assert_eq!(keys("2026-07-08T08:30"), ["dentist@2026-07-08T09:00@60"]);
        let at_0850 = keys("2026-07-08T08:50");
        assert!(at_0850.contains(&"standup@2026-07-08T09:00@15".to_string()));
        assert!(at_0850.contains(&"dentist@2026-07-08T09:00@15".to_string()));
        assert!(at_0850.contains(&"dentist@2026-07-08T09:00@60".to_string()));
        assert!(at_0850.contains(&"birthday@2026-07-09@1450".to_string()), "a day and ten minutes before 09:00 on the 9th is 08:50 on the 8th: {at_0850:?}");
        assert!(!at_0850.iter().any(|k| k.starts_with("old@")), "two days late is past the grace");
        let due = due_alarms(&data, &none, "2026-07-08T08:50");
        let dentist = due.iter().find(|a| a.key == "dentist@2026-07-08T09:00@15").unwrap();
        assert_eq!((dentist.title.as_str(), dentist.location.as_str(), dentist.start.as_str(), dentist.all_day), ("dentist", "Room 2", "2026-07-08T09:00", false));
        let fired: HashSet<String> = ["standup@2026-07-08T09:00@15".to_string()].into();
        assert!(!due_alarms(&data, &fired, "2026-07-08T08:50").iter().any(|a| a.key.starts_with("standup@")));
        assert_eq!(muted_calendars(&data), ["work".to_string()].into());
    }

    /// The record admits each key once across claimants, keeps what it was
    /// told, and stays bounded.
    #[test]
    fn a_key_is_claimed_once_across_claimants() {
        let dir = tempfile::tempdir().unwrap();
        let path = fired_file(dir.path());
        let keys = |list: &[&str]| list.iter().map(|k| k.to_string()).collect::<Vec<_>>();
        assert_eq!(claim_in(&path, &keys(&["a", "b", "b"])).unwrap(), keys(&["a", "b"]));
        assert_eq!(claim_in(&path, &keys(&["b", "c"])).unwrap(), keys(&["c"]));
        assert!(claim_in(&path, &keys(&["a", "c"])).unwrap().is_empty());
        assert_eq!(fired_in(&path), ["a", "b", "c"].iter().map(|k| k.to_string()).collect());

        let racers: Vec<_> = (0..6)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || claim_in(&path, &["shared".to_string()]).unwrap().len())
            })
            .collect();
        assert_eq!(racers.into_iter().map(|t| t.join().unwrap()).sum::<usize>(), 1);

        let many: Vec<String> = (0..600).map(|i| format!("k{i}")).collect();
        claim_in(&path, &many).unwrap();
        let kept = fired_in(&path);
        assert_eq!(kept.len(), MAX_FIRED);
        assert!(kept.contains("k599") && !kept.contains("a"), "the oldest fall off");
    }
}
