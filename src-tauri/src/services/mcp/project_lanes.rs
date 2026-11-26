//! Per-project switches for the MCP lanes handed to a project's agent tabs:
//! one per lane, stored as the list of switched-off lanes in the project's
//! `projects.json` entry (`extra["mcp_off"]`), never in the project folder.
//! Absent or empty means every lane is on (subject to its global switch).
//!
//! Both halves read it: `root_mcp::grant_lanes` hands a switched-off lane to no
//! new spawn of the project, and the listener refuses a running tab's calls on
//! a lane switched off since ([`refuses`]). The help lane's token carries no
//! project, so a running tab keeps help until it restarts. AppHandle-free.

use crate::schema::projects::ProjectEntry;
use crate::services::root_mcp::{Caller, Identity};
use std::path::Path;

/// The `projects.json` key holding the switched-off lanes.
pub const KEY: &str = "mcp_off";

/// Every lane a project can switch off, by the name the UI and the stored
/// list use. The root and mail-reader lanes belong to the root console and a
/// reader VM, not to a project, so they are not here.
pub const LANES: [&str; 7] = ["cockpit", "help", "schedule", "git", "markup", "print", "tabs"];

/// The lane a token class belongs to; `None` for one no project switch covers.
pub fn lane_of(caller: Caller) -> Option<&'static str> {
    Some(match caller {
        Caller::Cockpit => "cockpit",
        Caller::Helper => "help",
        Caller::Scheduler => "schedule",
        Caller::Pusher => "git",
        Caller::Marker => "markup",
        Caller::Printer => "print",
        Caller::Tabs => "tabs",
        Caller::Agent | Caller::LocalModel | Caller::Reader | Caller::Web => return None,
    })
}

/// The switched-off lanes recorded on `entry`, known names only, in
/// [`LANES`] order.
pub fn off_lanes(entry: &ProjectEntry) -> Vec<&'static str> {
    let Some(stored) = entry.extra.get(KEY).and_then(|v| v.as_array()) else { return Vec::new() };
    LANES.into_iter().filter(|lane| stored.iter().any(|v| v.as_str() == Some(lane))).collect()
}

/// Whether `entry` switches `lane` off.
pub fn is_off(entry: &ProjectEntry, lane: &str) -> bool {
    off_lanes(entry).contains(&lane)
}

/// Whether the trusted entry (if any) lets a spawn hold `lane`. No entry (a
/// box or the root scope) switches nothing off.
pub fn allows(entry: Option<&ProjectEntry>, lane: &str) -> bool {
    !entry.is_some_and(|e| is_off(e, lane))
}

/// Validate and normalise a list from the renderer: known lane names only,
/// each once, in [`LANES`] order.
pub fn normalise(off: &[String]) -> Result<Vec<&'static str>, String> {
    if let Some(bad) = off.iter().find(|name| !LANES.contains(&name.as_str())) {
        return Err(format!("unknown MCP lane '{bad}'"));
    }
    Ok(LANES.into_iter().filter(|lane| off.iter().any(|name| name == lane)).collect())
}

/// Write `off` onto `entry`: the key is removed when nothing is off.
pub fn store(entry: &mut ProjectEntry, off: &[&'static str]) {
    if off.is_empty() {
        entry.extra.remove(KEY);
    } else {
        entry.extra.insert(KEY.into(), serde_json::Value::from(off.to_vec()));
    }
}

/// Whether a session's call must be refused because its project switched its
/// lane off, read from `projects` now. A session with no project or no
/// switchable lane, or a project the list does not hold (a box, the root
/// scope), is never refused here. An unreadable list refuses: the same
/// fail-closed answer the schedule lane's per-request level check gives.
pub fn refuses_at(projects: &Path, identity: &Identity) -> bool {
    let Some(lane) = lane_of(identity.caller) else { return false };
    let Some(project) = identity.project.as_deref() else { return false };
    let Ok(list) = crate::storage::read_json::<crate::schema::projects::ProjectsList>(projects) else { return true };
    list.iter().find(|e| e.id == project).is_some_and(|e| is_off(e, lane))
}

/// [`refuses_at`] against this process's `projects.json`.
pub fn refuses(identity: &Identity) -> bool {
    refuses_at(&crate::storage::projects_path(), identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(off: serde_json::Value) -> ProjectEntry {
        let mut entry: ProjectEntry = serde_json::from_value(serde_json::json!({ "id": "p1", "name": "P", "status": "active", "position": 0, "local_file": "" })).unwrap();
        entry.extra.insert(KEY.into(), off);
        entry
    }

    fn identity(caller: Caller, project: Option<&str>) -> Identity {
        Identity { tab: "t".into(), caller, project: project.map(str::to_string), schedule_target: None, push: None, endpoint: None, model: None }
    }

    #[test]
    fn every_switchable_caller_maps_to_a_listed_lane() {
        for caller in [Caller::Cockpit, Caller::Helper, Caller::Scheduler, Caller::Pusher, Caller::Marker, Caller::Printer, Caller::Tabs] {
            assert!(LANES.contains(&lane_of(caller).unwrap()));
        }
        for caller in [Caller::Agent, Caller::LocalModel, Caller::Reader, Caller::Web] {
            assert_eq!(lane_of(caller), None);
        }
    }

    #[test]
    fn stored_list_reads_known_names_only() {
        let e = entry(serde_json::json!(["print", "bogus", 3, "cockpit"]));
        assert_eq!(off_lanes(&e), vec!["cockpit", "print"]);
        assert!(is_off(&e, "print"));
        assert!(!is_off(&e, "help"));
        assert!(off_lanes(&entry(serde_json::json!("print"))).is_empty(), "a non-list is nothing off");
        assert!(allows(None, "print"), "no entry switches nothing off");
        assert!(!allows(Some(&e), "print"));
    }

    #[test]
    fn normalise_orders_dedupes_and_rejects_unknown() {
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(normalise(&names(&["tabs", "help", "tabs"])).unwrap(), vec!["help", "tabs"]);
        assert!(normalise(&names(&["root"])).is_err());
    }

    #[test]
    fn store_removes_the_key_when_empty() {
        let mut e = entry(serde_json::json!(["print"]));
        store(&mut e, &["git", "tabs"]);
        assert_eq!(e.extra[KEY], serde_json::json!(["git", "tabs"]));
        store(&mut e, &[]);
        assert!(!e.extra.contains_key(KEY));
    }

    #[test]
    fn refuses_reads_the_list_now() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("projects.json");
        let list = serde_json::json!([
            { "id": "p1", "name": "P", "status": "active", "position": 0, "local_file": "", "mcp_off": ["print"] },
            { "id": "p2", "name": "Q", "status": "active", "position": 1, "local_file": "" },
        ]);
        std::fs::write(&projects, list.to_string()).unwrap();
        assert!(refuses_at(&projects, &identity(Caller::Printer, Some("p1"))));
        assert!(!refuses_at(&projects, &identity(Caller::Marker, Some("p1"))));
        assert!(!refuses_at(&projects, &identity(Caller::Printer, Some("p2"))));
        assert!(!refuses_at(&projects, &identity(Caller::Printer, Some("box:x"))), "a scope the list lacks");
        assert!(!refuses_at(&projects, &identity(Caller::Printer, None)));
        assert!(!refuses_at(&projects, &identity(Caller::Agent, Some("p1"))), "not a project lane");
        std::fs::write(&projects, "{not json").unwrap();
        assert!(refuses_at(&projects, &identity(Caller::Printer, Some("p1"))), "unreadable fails closed");
        assert!(!refuses_at(&projects, &identity(Caller::Agent, Some("p1"))));
    }
}
