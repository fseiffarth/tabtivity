use super::*;

const TAB: &str = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const OTHER: &str = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const OLD: &str = "c5c81bfb-9059-4159-ba81-be7a64ae18d1";
const NEW: &str = "48de071f-b22b-43e7-a00c-853a062fabd6";

fn file(name: &str, size: u64) -> RawEntry {
    RawEntry { name: name.to_string(), kind: SyncKind::File, size, modified_secs: None, mode: None }
}

fn dir(name: &str, modified: Option<u64>) -> RawEntry {
    RawEntry { name: name.to_string(), kind: SyncKind::Dir, size: 0, modified_secs: modified, mode: None }
}

fn environ(vars: &[&str]) -> Vec<u8> {
    vars.iter().flat_map(|v| v.bytes().chain([0])).collect()
}

fn tab_var() -> String {
    format!("{}={TAB}", crate::app_env!("TAB_UID"))
}

#[test]
fn a_lock_file_names_the_pid_of_a_running_copilot() {
    // What 1.0.114 leaves in a session folder while the CLI runs.
    let listing = [
        file(".workspace-fork.lock", 0),
        file("events.jsonl", 30315),
        file("inuse.19162.hold", 0),
        file("inuse.19162.lock", 6),
        file("workspace.yaml", 482),
        dir("checkpoints", None),
        file("inuse.7.lock", 6),
    ];
    assert_eq!(lock_pids(&listing), vec![19162, 7]);
}

#[test]
fn only_a_plain_numbered_lock_file_is_a_pid() {
    let odd = [
        file("inuse..lock", 6),
        file("inuse.12a.lock", 6),
        file("inuse.-3.lock", 6),
        file("xinuse.12.lock", 6),
        file("inuse.12.lock.bak", 6),
        file("inuse.99999999999999999999.lock", 6),
        file("inuse.12.lock", 1 << 20),
        dir("inuse.12.lock", None),
    ];
    assert!(lock_pids(&odd).is_empty());
}

#[test]
fn a_cli_is_the_tabs_by_its_launch_id_and_not_a_nested_run() {
    let tab = tab_var();
    assert!(is_tab_cli(&environ(&["HOME=/home/me", &tab, "TERM=xterm"]), TAB));
    assert!(!is_tab_cli(&environ(&["HOME=/home/me"]), TAB));
    assert!(!is_tab_cli(&environ(&[&format!("{}={OTHER}", crate::app_env!("TAB_UID"))]), TAB), "another tab's");
    // A `copilot -p` from the session's shell tool inherits the id and the nested marker.
    let nested = environ(&[&tab, "COPILOT_AGENT_SESSION_ID=cccccccc-1111-4222-8333-dddddddddddd"]);
    assert!(!is_tab_cli(&nested, TAB));
    // A variable that merely ends in the marker's name is not it.
    assert!(is_tab_cli(&environ(&[&tab, "MY_COPILOT_AGENT_SESSION_ID=1"]), TAB));
}

#[test]
fn the_open_sessions_are_read_from_the_state_file() {
    // Copied from a 1.0.114 run after a `/new`.
    let live = format!(
        r#"{{"{OLD}": {{"schemaVersion": 1, "openedAt": "2026-11-20T12:47:00.522Z", "refreshedAt": "2026-11-20T12:47:09.643Z", "working": false}},
            "{NEW}": {{"schemaVersion": 1, "openedAt": "2026-11-20T12:47:14.952Z", "refreshedAt": "2026-11-20T12:47:17.613Z", "working": false}}}}"#
    );
    let open = open_sessions(live.as_bytes()).unwrap();
    assert_eq!(open.len(), 2);
    assert_eq!(latest(open).as_deref(), Some(NEW), "the `/new` session was refreshed last");
    // A clean exit empties the file: nothing is open, which is not "unknown".
    assert_eq!(open_sessions(b"{}"), Some(Vec::new()));
}

#[test]
fn a_state_file_that_is_not_one_is_unknown() {
    assert_eq!(open_sessions(b""), None);
    assert_eq!(open_sessions(b"[1,2]"), None);
    assert_eq!(open_sessions(b"not json"), None);
}

#[test]
fn only_uuid_ids_of_the_state_file_become_folder_names() {
    let text = format!(r#"{{"../../etc": {{"openedAt": "z"}}, "{OLD}": {{"openedAt": "2026-11-20T10:00:00Z"}}, "": {{}}}}"#);
    let open = open_sessions(text.as_bytes()).unwrap();
    assert_eq!(open, vec![OpenSession { id: OLD.to_string(), stamp: "2026-11-20T10:00:00Z".to_string() }]);
}

#[test]
fn the_session_refreshed_last_is_the_tabs() {
    let at = |id: &str, stamp: &str| OpenSession { id: id.to_string(), stamp: stamp.to_string() };
    assert_eq!(latest(vec![at(OLD, "2026-11-20T12:47:09Z"), at(NEW, "2026-11-20T12:47:17Z")]).as_deref(), Some(NEW));
    assert_eq!(latest(vec![at(NEW, "2026-11-20T12:47:17Z"), at(OLD, "2026-11-20T12:47:09Z")]).as_deref(), Some(NEW));
    assert_eq!(latest(vec![at(OLD, "x"), at(NEW, "x")]).as_deref(), Some(OLD), "equal stamps keep the first");
    assert_eq!(latest(Vec::new()), None);
}

#[test]
fn without_a_state_file_the_newest_session_folders_are_looked_into() {
    let mut listing = vec![
        dir(OLD, Some(100)),
        dir(NEW, Some(300)),
        dir(TAB, Some(200)),
        dir(".session-operation-locks", Some(999)),
        dir("not-a-session", Some(999)),
        file(OTHER, 5),
    ];
    let ids: Vec<_> = newest_sessions(&listing).into_iter().map(|s| s.id).collect();
    assert_eq!(ids, vec![NEW, TAB, OLD]);
    // Bounded: a host with hundreds of sessions is asked about the newest few.
    listing.clear();
    for n in 0..(MAX_CANDIDATES + 25) {
        listing.push(dir(&format!("{n:08x}-0000-4000-8000-000000000000"), Some(n as u64)));
    }
    let newest = newest_sessions(&listing);
    assert_eq!(newest.len(), MAX_CANDIDATES);
    assert_eq!(newest[0].id, format!("{:08x}-0000-4000-8000-000000000000", MAX_CANDIDATES + 24));
}

#[test]
fn the_log_is_looked_for_under_the_hosts_answer_then_the_recorded_id_then_the_launch_id() {
    assert_eq!(candidates(Some(NEW), Some(OLD), TAB), vec![NEW, OLD, TAB]);
    assert_eq!(candidates(None, None, TAB), vec![TAB]);
    assert_eq!(candidates(Some(TAB), Some(TAB), TAB), vec![TAB], "no id twice");
    assert_eq!(candidates(Some("../x"), Some("a/b"), TAB), vec![TAB], "an id that is not a uuid is never a path");
}

#[test]
fn the_log_lives_below_the_agent_home_or_the_login_home() {
    assert_eq!(events_path(None, NEW).as_deref(), Some(format!(".copilot/session-state/{NEW}/events.jsonl").as_str()));
    assert_eq!(
        events_path(Some("/data/me/agent"), NEW).as_deref(),
        Some(format!("/data/me/agent/.copilot/session-state/{NEW}/events.jsonl").as_str())
    );
    assert_eq!(events_path(None, "../../.ssh/id_rsa"), None);
    assert_eq!(events_path(None, ""), None);
}

#[test]
fn a_session_the_tab_left_starts_the_copy_over() {
    let mut mirror = Mirror { session: Some(OLD.to_string()), remote: Some("old".to_string()), copied: 900, ..Default::default() };
    switch_session(&mut mirror, OLD);
    assert_eq!((mirror.remote.as_deref(), mirror.copied), (Some("old"), 900), "the same session keeps its copy");
    switch_session(&mut mirror, NEW);
    assert_eq!((mirror.session.as_deref(), mirror.remote.as_deref(), mirror.copied), (Some(NEW), None, 0));
}

#[test]
fn the_copy_lives_in_the_projects_session_folder_beside_the_other_hosts_copies() {
    let copy = local_copy("proj", "primary", TAB);
    assert_eq!(copy, super::super::host_dir("proj", "primary").join(format!("copilot-{TAB}.jsonl")));
    assert_ne!(copy, super::super::mirror_file("proj", "primary", TAB), "not Claude's file for the same launch id");
}

#[test]
fn a_copied_log_reads_with_the_local_copilot_parser() {
    // The copy is named after the launch id, not the session: the parser
    // reads the records, never the name.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(format!("copilot-{TAB}.jsonl"));
    let rec = |kind: &str, data: serde_json::Value| serde_json::json!({ "type": kind, "data": data, "timestamp": "2026-11-20T12:47:00.000Z" }).to_string();
    let lines = [
        rec("session.start", serde_json::json!({ "sessionId": NEW, "context": { "cwd": "/srv/work" } })),
        rec("user.message", serde_json::json!({ "content": "Reply with the word ONE." })),
        rec("assistant.message", serde_json::json!({ "content": "ONE", "model": "stub", "toolRequests": [] })),
    ];
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    let read = crate::services::agent_transcript::read_transcript(&path, TranscriptKind::Copilot, None, 100).unwrap();
    let shown: Vec<_> = read.entries.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect();
    assert_eq!(shown, vec![("prompt", "Reply with the word ONE."), ("answer", "ONE")]);
    assert_eq!(read.model.as_deref(), Some("stub"));
}
