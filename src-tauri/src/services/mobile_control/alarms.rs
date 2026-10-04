//! Calendar reminders with no window open (headless owner plan, H2): the
//! sidecar finds what is due (`services::calendar_alarms`), claims it in the
//! shared fired record, and pushes it to every phone that chose reminders —
//! the same Web Push the window's `notify` admin call takes, without the
//! window. While a window holds the timer lease it shows the reminders
//! itself (OS toast, in-app popup, and that same push), so this loop stands
//! down; the fired record keeps the two from ever showing one twice.
//!
//! A muted calendar's reminders are claimed without being pushed, as the
//! window records them as fired without showing them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use super::auth::AuthStore;
use super::push::{self, Notice, NoticeKind};
use crate::services::{calendar_alarms, timer_lease};

/// The window's reminder cadence.
pub const TICK: Duration = Duration::from_secs(30);

/// `alarmNotice` without the window's translations: the event's title (or
/// nothing — the phone shows its own placeholder), and the time of day or
/// the day itself, with the place.
pub fn notice(alarm: &calendar_alarms::DueAlarm) -> Notice {
    let when = if alarm.all_day {
        alarm.start.split('T').next().unwrap_or(&alarm.start).to_string()
    } else {
        alarm.start.split('T').nth(1).unwrap_or("").to_string()
    };
    let body = [when.as_str(), alarm.location.as_str()]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" · ");
    Notice { kind: NoticeKind::Calendar, status: None, title: alarm.title.clone(), body, tag: alarm.key.clone(), target: None }
}

/// One pass at `now` (a local `YYYY-MM-DDTHH:MM` stamp): the reminders
/// claimed and, of those, the ones to push — none while a window holds the
/// timers. Pure but for the record file.
pub fn due_to_push(state_dir: &Path, now: &str, now_secs: u64) -> Vec<calendar_alarms::DueAlarm> {
    if timer_lease::holder_in(&timer_lease::lease_file(state_dir), now_secs).is_some() {
        return Vec::new();
    }
    let Ok(data) = crate::commands::calendar::read_data(&state_dir.join("calendar.json")) else {
        return Vec::new();
    };
    let record = calendar_alarms::fired_file(state_dir);
    let due = calendar_alarms::due_alarms(&data, &calendar_alarms::fired_in(&record), now);
    if due.is_empty() {
        return Vec::new();
    }
    let keys: Vec<String> = due.iter().map(|a| a.key.clone()).collect();
    let Ok(granted) = calendar_alarms::claim_in(&record, &keys) else {
        return Vec::new();
    };
    let muted = calendar_alarms::muted_calendars(&data);
    due.into_iter().filter(|a| granted.contains(&a.key) && !muted.contains(&a.calendar_id)).collect()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The sidecar's loop: every [`TICK`] until `shutdown` says so.
pub async fn run(state_dir: PathBuf, auth: Arc<Mutex<AuthStore>>, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                let now = chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string();
                let secs = now_secs();
                let dir = state_dir.clone();
                let due = tokio::task::spawn_blocking(move || due_to_push(&dir, &now, secs)).await.unwrap_or_default();
                for alarm in due {
                    let deliveries = auth.lock().unwrap_or_else(PoisonError::into_inner).push_deliveries(&notice(&alarm), None);
                    match deliveries {
                        Ok(deliveries) if !deliveries.is_empty() => {
                            eprintln!("{}: reminder '{}' pushed to {} phone(s) with no window", crate::brand::MOBILE_HOST_BIN, alarm.key, deliveries.len());
                            for endpoint in push::send(deliveries).await {
                                auth.lock().unwrap_or_else(PoisonError::into_inner).push_lapse_endpoint(&endpoint);
                            }
                        }
                        Ok(_) => eprintln!("{}: reminder '{}' due with no window and no phone to push to", crate::brand::MOBILE_HOST_BIN, alarm.key),
                        Err(error) => eprintln!("{}: reminder '{}': {error}", crate::brand::MOBILE_HOST_BIN, alarm.key),
                    }
                }
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let calendar = json!({
            "version": 1,
            "calendars": [
                { "id": "home", "name": "Home", "color": "#4aa3df" },
                { "id": "work", "name": "Work", "color": "#4aa3df", "alerts_off": true }
            ],
            "events": [
                { "id": "dentist", "calendar_id": "home", "start": "2026-07-08T09:00", "end": "2026-07-08T10:00",
                  "all_day": false, "title": "Dentist", "location": "Room 2", "alarms": [{ "minutes_before": 15 }] },
                { "id": "standup", "calendar_id": "work", "start": "2026-07-08T09:00", "end": "2026-07-08T10:00",
                  "all_day": false, "title": "Standup", "location": "", "alarms": [{ "minutes_before": 15 }] },
                { "id": "trip", "calendar_id": "home", "start": "2026-07-09", "end": "2026-07-10",
                  "all_day": true, "title": "Trip", "location": "", "alarms": [{ "minutes_before": 1450 }] }
            ]
        });
        crate::storage::write_json_atomic(&dir.path().join("calendar.json"), &calendar).unwrap();
        dir
    }

    /// With no window, the due reminders of unmuted calendars are pushed
    /// once — the muted one is claimed silently — and never again; a
    /// window holding the timers keeps the sidecar quiet, and what it then
    /// claims through the same record is not pushed later either.
    #[test]
    fn reminders_reach_the_phone_once_with_no_window() {
        let dir = state_dir();
        let first = due_to_push(dir.path(), "2026-07-08T08:50", 1_000);
        let mut keys: Vec<&str> = first.iter().map(|a| a.key.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["dentist@2026-07-08T09:00@15", "trip@2026-07-09@1450"]);
        let dentist = first.iter().find(|a| a.event_id == "dentist").unwrap();
        let built = notice(dentist);
        assert_eq!((built.kind, built.title.as_str(), built.body.as_str(), built.tag.as_str()), (NoticeKind::Calendar, "Dentist", "09:00 · Room 2", "dentist@2026-07-08T09:00@15"));
        assert_eq!(notice(first.iter().find(|a| a.event_id == "trip").unwrap()).body, "2026-07-09");
        assert!(due_to_push(dir.path(), "2026-07-08T08:51", 1_060).is_empty(), "claimed: never twice");
        let record = calendar_alarms::fired_in(&calendar_alarms::fired_file(dir.path()));
        assert!(record.contains("standup@2026-07-08T09:00@15"), "the muted one is on record, unshown");

        let dir = state_dir();
        timer_lease::acquire_in(&timer_lease::lease_file(dir.path()), "window-a", 1_000, 30).unwrap();
        assert!(due_to_push(dir.path(), "2026-07-08T08:50", 1_000).is_empty(), "a window shows them");
        // The window shows one and claims it; the sidecar later pushes only
        // what is still unclaimed.
        calendar_alarms::claim_in(&calendar_alarms::fired_file(dir.path()), &["dentist@2026-07-08T09:00@15".to_string()]).unwrap();
        let later = due_to_push(dir.path(), "2026-07-08T08:52", 1_031);
        assert_eq!(later.iter().map(|a| a.key.as_str()).collect::<Vec<_>>(), ["trip@2026-07-09@1450"]);
    }
}
