//! Which phone is in which scope right now, for the desktop's phone marks
//! (admin `Presence`). Two sources: the phone's project screen reads its
//! detail every 5 s while the page is on screen (`Sightings`, each kept for
//! [`SIGHTING_TTL`]), and a phone holding a tab's terminal
//! (`pty_bridge::TerminalRegistry::viewers`). Only the desktop's own ids are
//! kept, and they leave only over the admin plane.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use app_core::sync::LockExt;

/// How long one project read counts as the phone still being there: two
/// missed polls of the project screen's 5 s cadence and a slow link. A phone
/// that left the screen, or whose page went hidden, stops reading at once.
pub const SIGHTING_TTL: Duration = Duration::from_secs(12);

/// The project screens phones have read lately, keyed by device and the
/// scope's raw id.
#[derive(Clone, Default)]
pub struct Sightings {
    seen: Arc<Mutex<HashMap<(String, String), Instant>>>,
}

impl Sightings {
    pub fn saw(&self, device_id: &str, project_id: &str) {
        self.saw_at(device_id, project_id, Instant::now());
    }

    fn saw_at(&self, device_id: &str, project_id: &str, at: Instant) {
        self.seen
            .lock_ok()
            .insert((device_id.to_string(), project_id.to_string()), at);
    }

    /// `(device_id, project_id)` for every read still within [`SIGHTING_TTL`];
    /// older ones are dropped.
    pub fn current(&self) -> Vec<(String, String)> {
        self.current_at(Instant::now())
    }

    fn current_at(&self, now: Instant) -> Vec<(String, String)> {
        let mut seen = self.seen.lock_ok();
        seen.retain(|_, at| now.saturating_duration_since(*at) < SIGHTING_TTL);
        let mut rows: Vec<_> = seen.keys().cloned().collect();
        rows.sort();
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sighting_lasts_its_ttl_and_is_then_forgotten() {
        let sightings = Sightings::default();
        let start = Instant::now();
        sightings.saw_at("phone-a", "p1", start);
        sightings.saw_at("phone-b", "box:b", start);
        assert_eq!(
            sightings.current_at(start + Duration::from_secs(5)),
            vec![("phone-a".into(), "p1".into()), ("phone-b".into(), "box:b".into())],
        );
        // A later read keeps one phone there; the other has gone.
        sightings.saw_at("phone-a", "p1", start + Duration::from_secs(10));
        assert_eq!(sightings.current_at(start + SIGHTING_TTL), vec![("phone-a".into(), "p1".into())]);
        assert!(sightings.current_at(start + Duration::from_secs(10) + SIGHTING_TTL).is_empty());
    }
}
