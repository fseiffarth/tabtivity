use super::*;

const ID: &str = "01a1f904-3906-7891-a3b3-4949467e5318";
const OTHER: &str = "01a1f904-7b49-7641-8b2f-e2d54b7af0af";

#[test]
fn a_session_logs_link_names_the_session() {
    let log = format!("/home/me/.local/share/muse/sessions/2026/11/20/{ID}/session.jsonl");
    assert_eq!(session_log(&log), Some(Found { id: ID.to_string(), log: log.clone() }));
    // The data folder is wherever the host keeps it.
    let relocated = format!("/scratch/h/.local/share/muse/sessions/2026/11/20/{ID}/session.jsonl");
    assert_eq!(session_log(&relocated).map(|found| found.id), Some(ID.to_string()));
    // What else the process holds is not a session's log.
    for other in [
        format!("/home/me/.local/share/muse/sessions/2026/11/20/{ID}/.session.lock"),
        format!("/home/me/.local/share/muse/sessions/2026/11/20/{ID}/cron.db"),
        format!("/home/me/.local/share/muse/sessions/2026/11/20/{ID}/subagent/3/session.jsonl"),
        format!("/home/me/.local/share/muse/sessions/2026/11/20/{ID}/session.jsonl (deleted)"),
        format!("/home/me/.local/share/muse/sessions/2026/11/{ID}/session.jsonl"),
        format!("/home/me/.local/share/muse/other/2026/11/20/{ID}/session.jsonl"),
        "/home/me/.local/share/muse/sessions/2026/11/20/../../etc/session.jsonl".to_string(),
        "/home/me/.local/share/muse/sessions/2026/11/20/not-a-uuid/session.jsonl".to_string(),
        "/home/me/.local/share/muse/sessions/26/11/20/".to_string() + ID + "/session.jsonl",
        "session.jsonl".to_string(),
        String::new(),
    ] {
        assert_eq!(session_log(&other), None, "{other}");
    }
}

#[test]
fn a_process_keeps_its_session_while_it_holds_it() {
    let found = |id: &str| Found { id: id.to_string(), log: format!("/h/sessions/2026/11/20/{id}/session.jsonl") };
    let both = vec![found(ID), found(OTHER)];
    assert_eq!(choose(both.clone(), Some(&found(ID))), Some(found(ID)));
    assert_eq!(choose(both.clone(), Some(&found("gone"))), Some(found(OTHER)), "else the last descriptor's");
    assert_eq!(choose(both, None), Some(found(OTHER)));
    assert_eq!(choose(Vec::new(), Some(&found(ID))), None);
}

#[test]
fn a_session_id_dates_the_session() {
    assert_eq!(started_ms("01a1cc13-6d1b-74f0-990e-e25861a7ebef"), Some(0x01a1_cc13_6d1b));
    assert_eq!(started_ms("zz"), None);
    let start = started_ms(ID).unwrap();
    assert!(begun_since(ID, None));
    assert!(begun_since(ID, Some(start - 1)));
    assert!(begun_since(ID, Some(start + SKEW_MS)), "the host's clock may run behind");
    assert!(!begun_since(ID, Some(start + SKEW_MS + 1)));
    assert!(!begun_since("not-a-uuid", Some(1)));
}

/// The first records of a log as Muse 1.4.24 writes them (trimmed to the fields read).
fn head(id: &str, root: &str) -> String {
    let root = serde_json::to_string(root).unwrap();
    format!(
        "{{}}\n{{\"stream\":{{\"kind\":\"session\",\"id\":\"{id}\"}},\"recorded_at\":1794425189681551,\"payload\":{{\"kind\":\"metadata\",\"record\":{{\"model_id\":\"muse-spark\",\"workspace_root\":{root}}}}}}}\n\
         {{\"stream\":{{\"kind\":\"session\",\"id\":\"{id}\"}},\"payload\":{{\"kind\":\"route_facts\",\"record\":{{\"cwd\":{root},\"pid\":1}}}}}}\n"
    )
}

fn turn(id: &str, prompt: &str, answer: &str) -> String {
    let p = serde_json::to_string(prompt).unwrap();
    let a = serde_json::to_string(answer).unwrap();
    format!(
        "{{\"stream\":{{\"kind\":\"session\",\"id\":\"{id}\"}},\"recorded_at\":1794425194166373,\"payload\":{{\"event\":{{\"kind\":\"started\",\"prompt\":{p}}},\"kind\":\"run\"}}}}\n\
         {{\"stream\":{{\"kind\":\"session\",\"id\":\"{id}\"}},\"recorded_at\":1794425194666373,\"payload\":{{\"event\":{{\"kind\":\"assistant_message_committed\",\"text\":{a}}},\"kind\":\"run\"}}}}\n"
    )
}

#[test]
fn a_logs_head_names_its_folder() {
    let text = head(ID, "/srv/work");
    assert_eq!(workspace_in(text.as_bytes()).as_deref(), Some("/srv/work"));
    // The head cuts a record: the cut line is not parsed, the whole one before it still is.
    let cut = format!("{text}{{\"stream\":{{\"payload\":{{\"kind\":\"metadata\",\"workspace_root\":\"/never");
    assert_eq!(workspace_in(cut.as_bytes()).as_deref(), Some("/srv/work"));
    assert_eq!(workspace_in(b"{}\n{\"payload\":{\"kind\":\"route_facts\"}}\n"), None);
    assert_eq!(workspace_in(b""), None);
    // A Windows path is JSON-escaped on disk.
    assert_eq!(workspace_in(head(ID, r"C:\work").as_bytes()).as_deref(), Some(r"C:\work"));
}

#[test]
fn a_copy_grown_by_the_hosts_appends_reads_the_new_turns() {
    let mirror = tempfile::tempdir().unwrap();
    let dir = mirror.path().join(ID);
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("session.jsonl");
    let host = head(ID, "/srv/work") + &turn(ID, "remember pelican", "pelican noted");
    // The host is mid-record when the first copy is taken.
    let torn = &turn(ID, "and now?", "pelican")[..60];
    std::fs::write(&log, format!("{host}{torn}")).unwrap();
    let first = crate::services::muse_session::copy_transcript(&dir, ID, None, 50);
    assert!(first.available);
    let got: Vec<(&str, &str)> = first.entries.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect();
    assert_eq!(got, [("prompt", "remember pelican"), ("answer", "pelican noted")], "the torn record waits");
    assert_eq!(first.model.as_deref(), Some("muse-spark"));

    // The rest arrives: appended, as `grow` does.
    {
        use std::io::Write;
        let full = turn(ID, "and now?", "pelican");
        let mut live = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        live.write_all(&full.as_bytes()[60..]).unwrap();
    }
    let second = crate::services::muse_session::copy_transcript(&dir, ID, first.version.as_deref(), 50);
    assert!(!second.unchanged);
    let got: Vec<(&str, &str)> = second.entries.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect();
    assert_eq!(got, [("prompt", "remember pelican"), ("answer", "pelican noted"), ("prompt", "and now?"), ("answer", "pelican")]);
    assert!(crate::services::muse_session::copy_transcript(&dir, ID, second.version.as_deref(), 50).unchanged);
    // No copy yet is no transcript, never a panic.
    assert!(!crate::services::muse_session::copy_transcript(&mirror.path().join("none"), OTHER, None, 50).available);
}
