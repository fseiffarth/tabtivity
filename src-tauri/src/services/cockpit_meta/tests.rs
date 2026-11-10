use super::*;
use serde_json::json;

use crate::services::workspace::{self, tab_id};

fn session_file() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sessions").join("p").join("terminals.json");
    (dir, path)
}

/// A scope with one agent tab (carrying a field this build does not model) and
/// a second tab; returns the first one's stable id.
fn seeded(path: &Path) -> String {
    let tab = |key: &str| -> TabEntry {
        serde_json::from_value(json!({"key":key,"label":key,"cmd":"claude","cwd":"work","kind":"agent",
            "unknownFutureField":{"keep":true}})).unwrap()
    };
    let mine = workspace::create_tab_in(path, "p", tab("mine"), None).unwrap().tab;
    workspace::create_tab_in(path, "p", tab("other"), None).unwrap();
    tab_id(&mine).unwrap().to_string()
}

fn ok() -> Result<(), String> { Ok(()) }

fn activity(text: &str, spawn: &str) -> Change {
    Change::Activity { text: Some(text.into()), spawn: spawn.into() }
}

fn handoff(summary: &str) -> Change {
    Change::Handoff(Some(HandoffText { summary: summary.into(), checks: "tests ran".into(), remaining: String::new() }))
}

fn snapshot(path: &Path) -> workspace::Snapshot { workspace::snapshot_in(path).unwrap() }

fn mine(path: &Path, id: &str) -> TabEntry {
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    snapshot(path).session.tab_layout.into_iter().find(|t| tab_id(t) == Some(id)).unwrap()
}

#[test]
fn text_is_bounded_plain_and_free_of_invisible_formatting() {
    assert_eq!(clean_activity("  Prüfe 日本語 Layout  ").as_deref(), Some("Prüfe 日本語 Layout"));
    assert!(clean_activity(&"日".repeat(ACTIVITY_MAX_CHARS)).is_some(), "the bound counts characters, not bytes");
    assert!(clean_activity(&"a".repeat(ACTIVITY_MAX_CHARS + 1)).is_none());
    for bad in ["", "   ", "two\nlines", "tab\there", "esc\u{1b}[31m", "bidi\u{202e}x", "zero\u{200b}width", "bom\u{feff}"] {
        assert!(clean_activity(bad).is_none(), "{bad:?}");
    }
    // A handoff is a multi-line note; CRLF is folded, other controls refused.
    let note = clean_handoff("line one\r\nline two", "", "later").unwrap();
    assert_eq!(note.summary, "line one\nline two");
    assert!(note.checks.is_empty(), "checks and remaining may be empty");
    assert!(clean_handoff("", "x", "y").is_none(), "the summary is required");
    assert!(clean_handoff("a\rb", "", "").is_none());
    assert!(clean_handoff("a\u{200b}b", "", "").is_none());
    assert!(clean_handoff(&"x".repeat(HANDOFF_FIELD_MAX_CHARS), "", "").is_some());
    assert!(clean_handoff(&"x".repeat(HANDOFF_FIELD_MAX_CHARS + 1), "", "").is_none());
    let third = "y".repeat(HANDOFF_FIELD_MAX_CHARS);
    assert!(clean_handoff(&third, &third, &third).is_some(), "3 x 1000 is the total bound");
    assert!(clean_handoff(&third, &third, &format!("{third}z")).is_none());
}

#[test]
fn freshness_is_the_hosts_clock_with_a_bound_on_both_sides() {
    assert!(is_fresh(1_000, 1_000));
    assert!(is_fresh(1_000, 1_000 + ACTIVITY_TTL_MS - 1));
    assert!(!is_fresh(1_000, 1_000 + ACTIVITY_TTL_MS));
    assert!(!is_fresh(1_000_000 + 2 * 60_000, 1_000_000), "a stamp from the future is not fresh");
}

#[test]
fn a_change_bumps_the_revision_and_moves_the_workspace_and_tab_versions() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    let before = snapshot(&path);
    let before_tab = mine(&path, &id);
    assert!(!before_tab.extra.contains_key(KEY), "absent until an agent writes");
    let out = update_in(&path, "p", &id, 0, 5_000, &activity("Checking layout", "s1"), ok).unwrap();
    assert!(out.changed);
    assert_eq!(out.meta.revision, 1);
    let after = snapshot(&path);
    assert_eq!(after.version, before.version + 1);
    let tab = mine(&path, &id);
    assert_eq!(tab.extra["updatedVersion"], json!(after.version), "stamped, so a stale client merges");
    assert_eq!(tab.extra[KEY]["v"], 1);
    assert_eq!(tab.extra[KEY]["activity"], json!({"text":"Checking layout","setAt":5_000,"spawn":"s1"}));
    assert_eq!(tab.extra["unknownFutureField"], json!({"keep":true}), "unrelated fields survive");
    assert_eq!(tab.label, "mine");
}

#[test]
fn a_stale_expected_revision_is_a_conflict_and_writes_nothing() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1, &handoff("first"), ok).unwrap();
    let version = snapshot(&path).version;
    let err = update_in(&path, "p", &id, 0, 2, &handoff("second"), ok).unwrap_err();
    assert_eq!(err, CONFLICT);
    let err = update_in(&path, "p", &id, 7, 2, &activity("x", "s"), ok).unwrap_err();
    assert_eq!(err, CONFLICT);
    assert_eq!(snapshot(&path).version, version);
    assert_eq!(mine(&path, &id).extra[KEY]["handoff"]["summary"], "first");
}

#[test]
fn identical_replacements_and_clears_of_nothing_do_not_write_or_bump() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1_000, &activity("Working", "s1"), ok).unwrap();
    update_in(&path, "p", &id, 1, 1_000, &handoff("done so far"), ok).unwrap();
    let version = snapshot(&path).version;
    // The same fresh line from the same spawn does not renew its expiry.
    let same = update_in(&path, "p", &id, 2, 1_000 + 60_000, &activity("Working", "s1"), ok).unwrap();
    assert!(!same.changed);
    assert_eq!(same.meta.revision, 2);
    assert_eq!(same.meta.activity.as_ref().unwrap().set_at, 1_000);
    assert!(!update_in(&path, "p", &id, 2, 5, &handoff("done so far"), ok).unwrap().changed);
    assert_eq!(snapshot(&path).version, version, "nothing was written");
    // Clearing what is absent is a no-op as well.
    update_in(&path, "p", &id, 2, 5, &Change::Handoff(None), ok).unwrap();
    let cleared = update_in(&path, "p", &id, 3, 5, &Change::Handoff(None), ok).unwrap();
    assert!(!cleared.changed);
    // Once the line has expired the same text is published again, with a new stamp.
    let renewed = update_in(&path, "p", &id, 3, 1_000 + ACTIVITY_TTL_MS + 1, &activity("Working", "s1"), ok).unwrap();
    assert!(renewed.changed);
    assert_eq!(renewed.meta.activity.unwrap().set_at, 1_000 + ACTIVITY_TTL_MS + 1);
}

#[test]
fn a_clear_leaves_the_key_so_a_revision_never_repeats() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1, &activity("a", "s"), ok).unwrap();
    update_in(&path, "p", &id, 1, 2, &Change::Activity { text: None, spawn: "s".into() }, ok).unwrap();
    let meta = read(&mine(&path, &id)).unwrap();
    assert_eq!(meta.revision, 2);
    assert!(meta.activity.is_none() && meta.handoff.is_none());
    assert_eq!(update_in(&path, "p", &id, 1, 3, &activity("b", "s"), ok).unwrap_err(), CONFLICT);
}

#[test]
fn legacy_and_unknown_fields_round_trip() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    // A record a later build wrote: extra keys inside the metadata, plus a handoff.
    workspace::edit_in(&path, "p", |session| {
        // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
        let tab = session.tab_layout.iter_mut().find(|t| tab_id(t) == Some(id.as_str())).unwrap();
        tab.extra.insert(KEY.into(), json!({"v":1,"revision":4,"attentionX":[{"id":"s1","label":"Shot","state":"done"}],
            "handoff":{"summary":"kept","checks":"c","remaining":"r","setAt":9}}));
        Ok(())
    }).unwrap();
    let out = update_in(&path, "p", &id, 4, 100, &activity("Now", "s1"), ok).unwrap();
    assert_eq!(out.meta.revision, 5);
    let stored = mine(&path, &id).extra[KEY].clone();
    assert_eq!(stored["attentionX"], json!([{"id":"s1","label":"Shot","state":"done"}]), "a later key rides through");
    assert_eq!(stored["handoff"]["summary"], "kept");
    assert_eq!(stored["activity"]["text"], "Now");
}

#[test]
fn unreadable_state_fails_without_a_replacement_write() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    // Unreadable metadata (another schema version, a wrong shape).
    for bad in [json!({"v":2,"revision":0}), json!("text"), json!({"v":1,"revision":"x"}), json!({"v":1,"activity":{"text":1}})] {
        workspace::edit_in(&path, "p", |session| {
            // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
            let tab = session.tab_layout.iter_mut().find(|t| tab_id(t) == Some(id.as_str())).unwrap();
            tab.extra.insert(KEY.into(), bad.clone());
            Ok(())
        }).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(update_in(&path, "p", &id, 0, 1, &activity("x", "s"), ok).unwrap_err(), CORRUPT);
        assert_eq!(read_in(&path, &id, ok).unwrap_err(), CORRUPT);
        assert_eq!(clear_other_spawns_in(&path, "p", &id, "s").unwrap_err(), CORRUPT);
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "{bad}");
    }
    // A corrupt session file.
    std::fs::write(&path, "corrupt existing state").unwrap();
    assert!(update_in(&path, "p", &id, 0, 1, &activity("x", "s"), ok).is_err());
    assert!(read_in(&path, &id, ok).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "corrupt existing state");
}

#[test]
fn an_oversized_object_is_refused_before_any_mutation() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    workspace::edit_in(&path, "p", |session| {
        // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
        let tab = session.tab_layout.iter_mut().find(|t| tab_id(t) == Some(id.as_str())).unwrap();
        tab.extra.insert(KEY.into(), json!({"v":1,"revision":0,"later":"x".repeat(META_MAX_BYTES)}));
        Ok(())
    }).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(update_in(&path, "p", &id, 0, 1, &activity("x", "s"), ok).unwrap_err(), TOO_LARGE);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn a_closed_tab_is_not_recreated_by_a_late_write_and_a_reopen_is_a_new_tab() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1, &activity("Working", "s1"), ok).unwrap();
    update_in(&path, "p", &id, 1, 2, &handoff("note"), ok).unwrap();
    let tmux = workspace::tmux_of(&mine(&path, &id)).unwrap().to_string();
    workspace::close_tab_in(&path, "p", &tmux, 3).unwrap();
    let version = snapshot(&path).version;
    for change in [activity("late", "s1"), handoff("late"), Change::Activity { text: None, spawn: "s1".into() }] {
        assert_eq!(update_in(&path, "p", &id, 2, 4, &change, ok).unwrap_err(), workspace::TAB_NOT_FOUND);
    }
    assert_eq!(read_in(&path, &id, ok).unwrap_err(), workspace::TAB_NOT_FOUND);
    assert_eq!(clear_other_spawns_in(&path, "p", &id, "s2").unwrap_err(), workspace::TAB_NOT_FOUND);
    let after = snapshot(&path);
    assert_eq!(after.version, version);
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    assert_eq!(after.session.tab_layout.len(), 1, "nothing was recreated");
    // The reopen is another identity: no live activity, the historical handoff stays.
    let reopened = workspace::reopen_tab_in(&path, "p", None).unwrap().unwrap();
    assert_ne!(tab_id(&reopened), Some(id.as_str()));
    let meta = read(&reopened).unwrap();
    assert!(meta.activity.is_none());
    assert_eq!(meta.handoff.unwrap().summary, "note");
}

#[test]
fn revocation_is_rechecked_inside_the_lock() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    let version = snapshot(&path).version;
    let revoked = || Err("unavailable".to_string());
    assert_eq!(update_in(&path, "p", &id, 0, 1, &activity("x", "s"), revoked).unwrap_err(), "unavailable");
    assert_eq!(read_in(&path, &id, revoked).unwrap_err(), "unavailable");
    assert_eq!(snapshot(&path).version, version);
}

#[test]
fn activity_from_an_older_spawn_is_cleared_at_the_next_grant() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1, &handoff("kept"), ok).unwrap();
    update_in(&path, "p", &id, 1, 2, &activity("Old spawn", "old"), ok).unwrap();
    let version = snapshot(&path).version;
    // The same spawn finding its own line: nothing to clear, nothing written.
    assert!(!clear_other_spawns_in(&path, "p", &id, "old").unwrap());
    assert_eq!(snapshot(&path).version, version);
    // A different spawn: one write, the handoff stays.
    assert!(clear_other_spawns_in(&path, "p", &id, "new").unwrap());
    let meta = read(&mine(&path, &id)).unwrap();
    assert!(meta.activity.is_none());
    assert_eq!(meta.handoff.unwrap().summary, "kept");
    assert_eq!(meta.revision, 3);
    assert_eq!(snapshot(&path).version, version + 1);
    // And with no activity at all, no write.
    assert!(!clear_other_spawns_in(&path, "p", &id, "newer").unwrap());
    assert_eq!(snapshot(&path).version, version + 1);
}

fn results(items: &[(&str, &str)]) -> Change {
    Change::Results(items.iter().map(|(label, path)| ResultItem { label: (*label).into(), relative_path: (*path).into() }).collect())
}

#[test]
fn results_replace_unchange_clear_and_conflict_like_the_other_notes() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    let out = update_in(&path, "p", &id, 0, 7_000, &results(&[("Plot", "out/plot.png"), ("Log", "run.log")]), ok).unwrap();
    assert!(out.changed);
    assert_eq!(out.meta.revision, 1);
    let stored = mine(&path, &id).extra[KEY].clone();
    assert_eq!(stored["results"], json!({"items":[{"label":"Plot","relativePath":"out/plot.png"},{"label":"Log","relativePath":"run.log"}],"setAt":7_000}));
    assert_eq!(mine(&path, &id).extra["unknownFutureField"], json!({"keep":true}));
    let version = snapshot(&path).version;
    // The same list again: nothing is written and the stamp stays.
    let same = update_in(&path, "p", &id, 1, 9_000, &results(&[("Plot", "out/plot.png"), ("Log", "run.log")]), ok).unwrap();
    assert!(!same.changed);
    assert_eq!(same.meta.results.unwrap().set_at, 7_000);
    assert_eq!(snapshot(&path).version, version);
    // A different order, label or path is a change; a stale revision conflicts.
    assert_eq!(update_in(&path, "p", &id, 0, 9_000, &results(&[("Plot", "x.png")]), ok).unwrap_err(), CONFLICT);
    let reordered = update_in(&path, "p", &id, 1, 9_000, &results(&[("Log", "run.log"), ("Plot", "out/plot.png")]), ok).unwrap();
    assert!(reordered.changed);
    assert_eq!((reordered.meta.revision, reordered.meta.results.unwrap().set_at), (2, 9_000));
    // Clearing: an empty list; clearing nothing is a no-op and the key stays.
    let cleared = update_in(&path, "p", &id, 2, 9_500, &results(&[]), ok).unwrap();
    assert!(cleared.changed && cleared.meta.results.is_none());
    assert!(!update_in(&path, "p", &id, 3, 9_600, &results(&[]), ok).unwrap().changed);
    assert_eq!(mine(&path, &id).extra[KEY], json!({"v":1,"revision":3}));
    // Results do not disturb the other notes, and the other notes do not disturb them.
    update_in(&path, "p", &id, 3, 1, &handoff("note"), ok).unwrap();
    update_in(&path, "p", &id, 4, 2, &results(&[("A", "a.md")]), ok).unwrap();
    update_in(&path, "p", &id, 5, 3, &activity("Working", "s"), ok).unwrap();
    let meta = read(&mine(&path, &id)).unwrap();
    assert_eq!((meta.handoff.unwrap().summary, meta.results.unwrap().items.len(), meta.activity.unwrap().text), ("note".into(), 1, "Working".into()));
}

#[test]
fn results_survive_a_grant_a_reopen_and_unreadable_results_fail_without_a_write() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1, &results(&[("Plot", "plot.png")]), ok).unwrap();
    update_in(&path, "p", &id, 1, 2, &activity("Old", "old"), ok).unwrap();
    assert!(clear_other_spawns_in(&path, "p", &id, "new").unwrap());
    assert_eq!(read(&mine(&path, &id)).unwrap().results.unwrap().items[0].relative_path, "plot.png", "historical, like the handoff");
    let tmux = workspace::tmux_of(&mine(&path, &id)).unwrap().to_string();
    workspace::close_tab_in(&path, "p", &tmux, 3).unwrap();
    let reopened = workspace::reopen_tab_in(&path, "p", None).unwrap().unwrap();
    assert_eq!(read(&reopened).unwrap().results.unwrap().items.len(), 1);
    // A results value of another shape is unreadable metadata, never a replacement write.
    let id2 = tab_id(&reopened).unwrap().to_string();
    workspace::edit_in(&path, "p", |session| {
        // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
        let tab = session.tab_layout.iter_mut().find(|t| tab_id(t) == Some(id2.as_str())).unwrap();
        tab.extra.insert(KEY.into(), json!({"v":1,"revision":2,"results":[{"label":"x"}]}));
        Ok(())
    })
    .unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(update_in(&path, "p", &id2, 2, 1, &results(&[("A", "a")]), ok).unwrap_err(), CORRUPT);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn results_are_host_owned_through_a_stale_client_sync() {
    use crate::services::workspace::ClientSync;
    let (_dir, path) = session_file();
    let id = seeded(&path);
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    let before = workspace::sync_in(&path, "p", ClientSync { base_version: 0, tabs: snapshot(&path).session.tab_layout, ..Default::default() }).unwrap();
    // The window's copy: what it held before the agent listed anything.
    update_in(&path, "p", &id, 0, 5, &results(&[("Plot", "out/plot.png")]), ok).unwrap();
    let written = snapshot(&path).version;
    let expected = json!({"items":[{"label":"Plot","relativePath":"out/plot.png"}],"setAt":5});
    let held = |out: &workspace::SyncOutcome| out.tabs.iter().find(|t| tab_id(t) == Some(id.as_str())).unwrap().extra[KEY]["results"].clone();
    // Stale base, no metadata in its copy: the list stays and nothing is written.
    let stale = workspace::sync_in(&path, "p", ClientSync { base_version: before.version, tabs: before.tabs.clone(), ..Default::default() }).unwrap();
    assert_eq!(held(&stale), expected);
    assert_eq!(stale.version, written);
    // A stale client that edits another tab, and one forging the list: still the agent's list.
    let mut tabs = before.tabs.clone();
    tabs[1].label = "other renamed".into();
    tabs[0].extra.insert(KEY.into(), json!({"v":1,"revision":99,"results":{"items":[{"label":"Forged","relativePath":"x"}],"setAt":1}}));
    let edited = workspace::sync_in(&path, "p", ClientSync { base_version: before.version, tabs, ..Default::default() }).unwrap();
    assert_eq!(held(&edited), expected);
    assert_eq!(edited.tabs[1].label, "other renamed");
    // The saved record carries it after every one of those.
    assert_eq!(read(&mine(&path, &id)).unwrap().results.unwrap().items[0].label, "Plot");
}

// ── Step 4: progress, blocker, verification ─────────────────────────────────

fn step(id: &str, label: &str, state: &str) -> Value { json!({"id":id,"label":label,"state":state}) }

fn steps(list: &[(&str, &str)]) -> Vec<ProgressStep> {
    clean_progress(&list.iter().map(|(id, state)| step(id, &format!("Step {id}"), state)).collect::<Vec<_>>()).unwrap()
}

fn progress(list: &[(&str, &str)], spawn: &str) -> Change { Change::Progress { steps: steps(list), spawn: spawn.into() } }

fn blocker(text: &str, spawn: &str) -> Change { Change::Blocker { text: Some(text.into()), spawn: spawn.into() } }

fn verification(list: &[(&str, CheckOutcome, Option<&str>)]) -> Change {
    Change::Verification(list.iter().map(|(label, outcome, note)| VerificationEntry {
        label: (*label).into(), outcome: *outcome, note: note.map(str::to_string),
    }).collect())
}

#[test]
fn progress_steps_are_bounded_unique_and_have_at_most_one_active() {
    let ok = |list: Vec<Value>| clean_progress(&list);
    assert_eq!(ok(vec![]).unwrap().len(), 0, "an empty list is valid (it clears)");
    let eight: Vec<Value> = (0..8).map(|i| step(&format!("s{i}"), "L", if i == 3 { "active" } else { "done" })).collect();
    assert_eq!(ok(eight.clone()).unwrap().len(), 8);
    let mut nine = eight.clone();
    nine.push(step("s8", "L", "pending"));
    assert!(ok(nine).is_none(), "at most 8 steps");
    // The id: 1-40 characters of [a-z0-9_-], unique.
    assert!(ok(vec![step(&"a".repeat(40), "L", "done")]).is_some());
    for bad in ["", &"a".repeat(41), "A", "has space", "dot.dot", "ünï", "a/b", "a\nb", "-ok\u{200b}"] {
        assert!(ok(vec![step(bad, "L", "done")]).is_none(), "{bad:?}");
    }
    assert!(ok(vec![step("a_b-9", "L", "done")]).is_some());
    assert!(ok(vec![step("x", "L", "done"), step("x", "M", "pending")]).is_none(), "ids are unique");
    // The label: one plain line of up to 120 characters, counted as characters.
    assert!(ok(vec![step("a", &"日".repeat(120), "done")]).is_some());
    for bad in ["", "  ", &"a".repeat(121), "two\nlines", "bidi\u{202e}x", "zero\u{200b}w", "tab\there"] {
        assert!(ok(vec![step("a", bad, "done")]).is_none(), "{bad:?}");
    }
    assert_eq!(ok(vec![step("a", "  Trimmed  ", "done")]).unwrap()[0].label, "Trimmed");
    // The state: a known word, at most one active.
    for bad in ["Done", "running", "", "active "] {
        assert!(ok(vec![step("a", "L", bad)]).is_none(), "{bad:?}");
    }
    assert!(ok(vec![step("a", "L", "active"), step("b", "L", "active")]).is_none(), "at most one active");
    assert!(ok(vec![step("a", "L", "active"), step("b", "L", "pending"), step("c", "L", "done")]).is_some());
    // The shape: exactly {id, label, state}.
    for bad in [json!({"id":"a","label":"L"}), json!({"id":"a","state":"done"}), json!({"label":"L","state":"done"}),
        json!({"id":"a","label":"L","state":"done","extra":1}), json!({"id":1,"label":"L","state":"done"}),
        json!({"id":"a","label":null,"state":"done"}), json!("a"), json!(null), json!([])] {
        assert!(ok(vec![bad.clone()]).is_none(), "{bad}");
    }
}

#[test]
fn the_blocker_is_one_plain_line_of_300_characters() {
    assert_eq!(clean_blocker("  Needs the API key  ").as_deref(), Some("Needs the API key"));
    assert!(clean_blocker(&"日".repeat(BLOCKER_MAX_CHARS)).is_some(), "characters, not bytes");
    assert!(clean_blocker(&"a".repeat(BLOCKER_MAX_CHARS + 1)).is_none());
    for bad in ["", "  ", "two\nlines", "crlf\r\nx", "tab\there", "esc\u{1b}[0m", "bidi\u{202e}x", "zero\u{200b}w", "bom\u{feff}"] {
        assert!(clean_blocker(bad).is_none(), "{bad:?}");
    }
}

#[test]
fn verification_entries_are_bounded_and_the_note_may_span_lines() {
    let entry = |label: &str, outcome: &str| json!({"label":label,"outcome":outcome});
    let ok = |list: Vec<Value>| clean_verification(&list);
    assert_eq!(ok(vec![]).unwrap().len(), 0);
    let eight: Vec<Value> = (0..8).map(|i| entry(&format!("L{i}"), "passed")).collect();
    assert_eq!(ok(eight.clone()).unwrap().len(), 8);
    let mut nine = eight;
    nine.push(entry("L9", "passed"));
    assert!(ok(nine).is_none(), "at most 8 entries");
    // The outcome is one of four words.
    for good in ["passed", "failed", "pending", "not_run"] {
        assert_eq!(ok(vec![entry("L", good)]).unwrap()[0].outcome.as_str(), good);
    }
    for bad in ["Passed", "verified", "ok", "not run", "", "pass"] {
        assert!(ok(vec![entry("L", bad)]).is_none(), "{bad:?}");
    }
    // The label is a plain line of up to 120 characters.
    assert!(ok(vec![entry(&"日".repeat(120), "passed")]).is_some());
    for bad in ["", &"a".repeat(121), "two\nlines", "bidi\u{202e}"] {
        assert!(ok(vec![entry(bad, "passed")]).is_none(), "{bad:?}");
    }
    // The note: optional, up to 300 characters, newlines allowed (CRLF folded), no other controls.
    let with = |note: Value| ok(vec![json!({"label":"L","outcome":"failed","note":note})]);
    assert_eq!(with(json!("line one\r\nline two")).unwrap()[0].note.as_deref(), Some("line one\nline two"));
    assert_eq!(with(json!("")).unwrap()[0].note, None, "an empty note is no note");
    assert!(with(json!("日".repeat(300))).is_some());
    for bad in [json!("x".repeat(301)), json!("a\rb"), json!("a\u{1b}b"), json!("a\u{200b}b"), json!("a\u{202e}b"), json!(null), json!(7)] {
        assert!(with(bad.clone()).is_none(), "{bad}");
    }
    // The shape: label and outcome required, nothing else but the note.
    for bad in [json!({"label":"L"}), json!({"outcome":"passed"}), json!({"label":"L","outcome":"passed","extra":1}),
        json!({"label":"L","outcome":"passed","note":"n","at":1}), json!("L"), json!(null)] {
        assert!(ok(vec![bad.clone()]).is_none(), "{bad}");
    }
}

#[test]
fn the_new_notes_replace_unchange_clear_conflict_and_leave_the_others_alone() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    // Progress: updated, no-op for the same steps from the same fresh spawn, a conflict when stale.
    let first = update_in(&path, "p", &id, 0, 1_000, &progress(&[("a", "done"), ("b", "active")], "s1"), ok).unwrap();
    assert!(first.changed);
    assert_eq!(first.meta.revision, 1);
    let version = snapshot(&path).version;
    let same = update_in(&path, "p", &id, 1, 1_000 + 60_000, &progress(&[("a", "done"), ("b", "active")], "s1"), ok).unwrap();
    assert!(!same.changed);
    assert_eq!(same.meta.progress.unwrap().set_at, 1_000, "repeating does not renew");
    assert_eq!(snapshot(&path).version, version, "nothing was written");
    assert_eq!(update_in(&path, "p", &id, 0, 2, &progress(&[("a", "done")], "s1"), ok).unwrap_err(), CONFLICT);
    // A state change is a change and renews the stamp; so is a reorder.
    let moved = update_in(&path, "p", &id, 1, 5_000, &progress(&[("a", "done"), ("b", "done")], "s1"), ok).unwrap();
    assert!(moved.changed);
    assert_eq!((moved.meta.revision, moved.meta.progress.unwrap().set_at), (2, 5_000));
    // Once stale, the same steps are published again with a new stamp.
    let later = 5_000 + ACTIVITY_TTL_MS + 1;
    let renewed = update_in(&path, "p", &id, 2, later, &progress(&[("a", "done"), ("b", "done")], "s1"), ok).unwrap();
    assert!(renewed.changed);
    assert_eq!(renewed.meta.progress.unwrap().set_at, later);
    // Blocker.
    update_in(&path, "p", &id, 3, 100, &blocker("Needs a key", "s1"), ok).unwrap();
    let again = update_in(&path, "p", &id, 4, 100 + 60_000, &blocker("Needs a key", "s1"), ok).unwrap();
    assert!(!again.changed);
    assert_eq!(again.meta.blocker.as_ref().unwrap().set_at, 100, "a repeated blocker does not renew its expiry");
    let cleared = update_in(&path, "p", &id, 4, 200, &Change::Blocker { text: None, spawn: "s1".into() }, ok).unwrap();
    assert!(cleared.changed && cleared.meta.blocker.is_none());
    assert!(!update_in(&path, "p", &id, 5, 300, &Change::Blocker { text: None, spawn: "s1".into() }, ok).unwrap().changed);
    // Verification.
    let list = [("Unit tests", CheckOutcome::Passed, Some("12 passed")), ("Live check", CheckOutcome::NotRun, None)];
    let v = update_in(&path, "p", &id, 5, 400, &verification(&list), ok).unwrap();
    assert!(v.changed);
    assert_eq!(v.meta.verification.as_ref().unwrap().set_at, 400);
    let same = update_in(&path, "p", &id, 6, 900, &verification(&list), ok).unwrap();
    assert!(!same.changed);
    assert_eq!(same.meta.verification.unwrap().set_at, 400, "the report time stays");
    assert_eq!(update_in(&path, "p", &id, 5, 900, &verification(&[]), ok).unwrap_err(), CONFLICT);
    // Clears: an empty list; clearing nothing is a no-op and the key stays.
    for (revision, clear) in [(6, progress(&[], "s1")), (7, verification(&[]))] {
        assert!(update_in(&path, "p", &id, revision, 1_000, &clear, ok).unwrap().changed);
    }
    assert!(!update_in(&path, "p", &id, 8, 1_000, &progress(&[], "s1"), ok).unwrap().changed);
    assert!(!update_in(&path, "p", &id, 8, 1_000, &verification(&[]), ok).unwrap().changed);
    assert_eq!(mine(&path, &id).extra[KEY], json!({"v":1,"revision":8}));
    // They sit beside the older notes without disturbing them.
    update_in(&path, "p", &id, 8, 1, &handoff("note"), ok).unwrap();
    update_in(&path, "p", &id, 9, 2, &activity("Working", "s1"), ok).unwrap();
    update_in(&path, "p", &id, 10, 3, &results(&[("A", "a.md")]), ok).unwrap();
    update_in(&path, "p", &id, 11, 4, &progress(&[("x", "active")], "s1"), ok).unwrap();
    update_in(&path, "p", &id, 12, 5, &blocker("Stuck", "s1"), ok).unwrap();
    update_in(&path, "p", &id, 13, 6, &verification(&[("T", CheckOutcome::Failed, Some("a\nb"))]), ok).unwrap();
    let meta = read(&mine(&path, &id)).unwrap();
    assert_eq!(meta.revision, 14);
    assert_eq!(meta.handoff.unwrap().summary, "note");
    assert_eq!(meta.activity.unwrap().text, "Working");
    assert_eq!(meta.results.unwrap().items.len(), 1);
    assert_eq!(meta.progress.unwrap().steps[0].id, "x");
    assert_eq!(meta.blocker.unwrap().text, "Stuck");
    assert_eq!(meta.verification.unwrap().entries[0].note.as_deref(), Some("a\nb"));
    assert_eq!(mine(&path, &id).extra["unknownFutureField"], json!({"keep":true}));
    // The stored shape.
    let stored = mine(&path, &id).extra[KEY].clone();
    assert_eq!(stored["progress"], json!({"steps":[{"id":"x","label":"Step x","state":"active"}],"setAt":4,"spawn":"s1"}));
    assert_eq!(stored["blocker"], json!({"text":"Stuck","setAt":5,"spawn":"s1"}));
    assert_eq!(stored["verification"], json!({"entries":[{"label":"T","outcome":"failed","note":"a\nb"}],"setAt":6}));
}

#[test]
fn a_grant_clears_another_spawns_blocker_and_ends_its_progress() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1, &verification(&[("T", CheckOutcome::Passed, None)]), ok).unwrap();
    update_in(&path, "p", &id, 1, 2, &progress(&[("a", "active")], "old"), ok).unwrap();
    update_in(&path, "p", &id, 2, 3, &blocker("Old blocker", "old"), ok).unwrap();
    let version = snapshot(&path).version;
    // The spawn that issued them finding them: nothing to clear, nothing written.
    assert!(!clear_other_spawns_in(&path, "p", &id, "old").unwrap());
    assert_eq!(snapshot(&path).version, version);
    // Another spawn: one write; the blocker goes, the progress stays as an ended report.
    assert!(clear_other_spawns_in(&path, "p", &id, "new").unwrap());
    let meta = read(&mine(&path, &id)).unwrap();
    assert!(meta.blocker.is_none());
    let past = meta.progress.unwrap();
    assert!(past.ended, "a past report");
    assert_eq!((past.steps[0].id.as_str(), past.spawn.as_str(), past.set_at), ("a", "old", 2), "its steps and stamp are kept");
    assert_eq!(meta.verification.unwrap().entries.len(), 1, "verification persists");
    assert_eq!(meta.revision, 4);
    assert_eq!(snapshot(&path).version, version + 1);
    // Idempotent: the ended progress and the missing blocker leave nothing to do.
    assert!(!clear_other_spawns_in(&path, "p", &id, "newer").unwrap());
    assert_eq!(snapshot(&path).version, version + 1);
    // The new spawn publishing the same steps again is a change: it is running again.
    let again = update_in(&path, "p", &id, 4, 10, &progress(&[("a", "active")], "new"), ok).unwrap();
    assert!(again.changed);
    let running = again.meta.progress.unwrap();
    assert!(!running.ended && running.spawn == "new");
    // Progress alone, from an older spawn, is also one write.
    assert!(clear_other_spawns_in(&path, "p", &id, "third").unwrap());
    assert!(read(&mine(&path, &id)).unwrap().progress.unwrap().ended);
}

#[test]
fn a_reopened_tab_keeps_the_reports_but_not_a_live_blocker_or_running_progress() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1, &progress(&[("a", "active")], "s1"), ok).unwrap();
    update_in(&path, "p", &id, 1, 2, &blocker("Stuck", "s1"), ok).unwrap();
    update_in(&path, "p", &id, 2, 3, &verification(&[("T", CheckOutcome::Pending, None)]), ok).unwrap();
    let tmux = workspace::tmux_of(&mine(&path, &id)).unwrap().to_string();
    workspace::close_tab_in(&path, "p", &tmux, 4).unwrap();
    let reopened = workspace::reopen_tab_in(&path, "p", None).unwrap().unwrap();
    let meta = read(&reopened).unwrap();
    assert!(meta.blocker.is_none());
    assert!(meta.progress.unwrap().ended);
    assert_eq!(meta.verification.unwrap().entries.len(), 1);
}

#[test]
fn unreadable_new_notes_fail_without_a_replacement_write() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    for bad in [
        json!({"v":1,"revision":0,"progress":[{"id":"s1"}]}),
        json!({"v":1,"revision":0,"progress":{"steps":[{"id":"a","label":"L","state":"running"}],"setAt":1,"spawn":"s"}}),
        json!({"v":1,"revision":0,"blocker":"text"}),
        json!({"v":1,"revision":0,"verification":{"entries":[{"label":"L","outcome":"verified"}],"setAt":1}}),
    ] {
        workspace::edit_in(&path, "p", |session| {
            // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
            let tab = session.tab_layout.iter_mut().find(|t| tab_id(t) == Some(id.as_str())).unwrap();
            tab.extra.insert(KEY.into(), bad.clone());
            Ok(())
        }).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(update_in(&path, "p", &id, 0, 1, &blocker("x", "s"), ok).unwrap_err(), CORRUPT, "{bad}");
        assert_eq!(read_in(&path, &id, ok).unwrap_err(), CORRUPT);
        assert_eq!(clear_other_spawns_in(&path, "p", &id, "s").unwrap_err(), CORRUPT);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

/// Every field at its bound, built from `unit` (one character per slot).
fn full_changes(unit: &str) -> Vec<Change> {
    let rep = |n: usize| unit.repeat(n);
    vec![
        Change::Results((0..RESULTS_MAX_ITEMS).map(|i| ResultItem { label: rep(RESULT_LABEL_MAX_CHARS), relative_path: format!("{}{i}", rep(RESULT_PATH_MAX_CHARS - 1)) }).collect()),
        Change::Handoff(Some(HandoffText { summary: rep(1_000), checks: rep(1_000), remaining: rep(1_000) })),
        Change::Activity { text: Some(rep(ACTIVITY_MAX_CHARS)), spawn: "s".into() },
        Change::Blocker { text: Some(rep(BLOCKER_MAX_CHARS)), spawn: "s".into() },
        Change::Progress { steps: (0..PROGRESS_MAX_STEPS).map(|i| ProgressStep { id: format!("{}{i}", "a".repeat(39)), label: rep(PROGRESS_LABEL_MAX_CHARS), state: StepState::Done }).collect(), spawn: "s".into() },
        Change::Verification((0..VERIFICATION_MAX_ENTRIES).map(|i| VerificationEntry { label: format!("{}{i}", rep(VERIFICATION_LABEL_MAX_CHARS - 1)), outcome: CheckOutcome::Passed, note: Some(rep(VERIFICATION_NOTE_MAX_CHARS)) }).collect()),
        Change::Attention { question: Some(rep(ATTENTION_MAX_CHARS)), id: "a".repeat(32), spawn: "s".into() },
    ]
    .into_iter()
    .chain((0..MILESTONES_MAX).map(|i| Change::Milestone { request_id: format!("{}{i:02}", "m".repeat(MILESTONE_ID_MAX_CHARS - 2)), text: rep(MILESTONE_MAX_CHARS) }))
    .collect()
}

#[test]
fn every_field_at_its_bound_fits_in_32_kib_of_plain_text_and_overflow_is_refused_unwritten() {
    // Plain ASCII: all six notes full at once fit.
    let (_dir, path) = session_file();
    let id = seeded(&path);
    for (revision, change) in full_changes("x").iter().enumerate() {
        update_in(&path, "p", &id, revision as u64, 1, change, ok).unwrap();
    }
    let size = serde_json::to_vec(&mine(&path, &id).extra[KEY]).unwrap().len();
    assert!(size <= META_MAX_BYTES, "{size}");
    // Three-byte characters: the same fields in full pass the bound, so the write
    // that would cross it is refused before any mutation, whichever field it is.
    let (_dir, path) = session_file();
    let id = seeded(&path);
    let mut refused = 0;
    let mut revision = 0;
    for change in full_changes("日") {
        let bytes = std::fs::read(&path).unwrap();
        match update_in(&path, "p", &id, revision, 1, &change, ok) {
            Ok(_) => revision += 1,
            Err(e) => {
                assert_eq!(e, TOO_LARGE);
                assert_eq!(std::fs::read(&path).unwrap(), bytes, "refused before any mutation");
                refused += 1;
            }
        }
    }
    assert!(refused >= 1, "the notes cannot all be full in multi-byte text");
    let size = serde_json::to_vec(&mine(&path, &id).extra[KEY]).unwrap().len();
    assert!(size <= META_MAX_BYTES, "{size}");
}

#[test]
fn the_new_notes_are_host_owned_through_a_stale_client_sync() {
    use crate::services::workspace::ClientSync;
    let (_dir, path) = session_file();
    let id = seeded(&path);
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    let before = workspace::sync_in(&path, "p", ClientSync { base_version: 0, tabs: snapshot(&path).session.tab_layout, ..Default::default() }).unwrap();
    update_in(&path, "p", &id, 0, 5, &progress(&[("a", "active")], "s1"), ok).unwrap();
    update_in(&path, "p", &id, 1, 6, &blocker("Stuck", "s1"), ok).unwrap();
    update_in(&path, "p", &id, 2, 7, &verification(&[("T", CheckOutcome::Passed, Some("ok"))]), ok).unwrap();
    let written = snapshot(&path).version;
    let held = |out: &workspace::SyncOutcome, field: &str| out.tabs.iter().find(|t| tab_id(t) == Some(id.as_str())).unwrap().extra[KEY][field].clone();
    let expect = |out: &workspace::SyncOutcome| {
        assert_eq!(held(out, "progress")["steps"][0]["id"], "a");
        assert_eq!(held(out, "blocker")["text"], "Stuck");
        assert_eq!(held(out, "verification")["entries"][0]["label"], "T");
    };
    // A stale client with no metadata in its copy: all three stay, nothing is written.
    let stale = workspace::sync_in(&path, "p", ClientSync { base_version: before.version, tabs: before.tabs.clone(), ..Default::default() }).unwrap();
    expect(&stale);
    assert_eq!(stale.version, written);
    // One that edits another tab and forges all three: still the agent's own.
    let mut tabs = before.tabs.clone();
    tabs[1].label = "other renamed".into();
    tabs[0].extra.insert(KEY.into(), json!({"v":1,"revision":99,"progress":{"steps":[{"id":"forged","label":"F","state":"done"}],"setAt":1,"spawn":"x"},
        "blocker":{"text":"Forged","setAt":1,"spawn":"x"},"verification":{"entries":[{"label":"Forged","outcome":"passed"}],"setAt":1}}));
    let edited = workspace::sync_in(&path, "p", ClientSync { base_version: before.version, tabs, ..Default::default() }).unwrap();
    expect(&edited);
    assert_eq!(edited.tabs[1].label, "other renamed");
}

#[test]
fn a_progress_report_from_an_older_spawn_reads_as_history() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 10_000, &progress(&[("a", "active")], "old"), ok).unwrap();
    let meta = read(&mine(&path, &id)).unwrap();
    let p = meta.progress.as_ref().unwrap();
    // Before the new spawn is granted: another spawn's, so not the current one's.
    assert!(p.spawn != "new");
    clear_other_spawns_in(&path, "p", &id, "new").unwrap();
    let ended = read(&mine(&path, &id)).unwrap().progress.unwrap();
    assert!(ended.ended, "history, whatever its age");
    assert!(is_fresh(ended.set_at, ended.set_at + 1), "young, and still not running");
    // An old report of the current spawn is history by age alone.
    update_in(&path, "p", &id, 2, 20_000, &progress(&[("b", "active")], "new"), ok).unwrap();
    let p = read(&mine(&path, &id)).unwrap().progress.unwrap();
    assert!(!p.ended && is_fresh(p.set_at, 20_000 + ACTIVITY_TTL_MS - 1) && !is_fresh(p.set_at, 20_000 + ACTIVITY_TTL_MS));
}

// ── Step 5: attention and milestones ────────────────────────────────────────

fn ask(question: &str, id: &str, spawn: &str) -> Change {
    Change::Attention { question: Some(question.into()), id: id.into(), spawn: spawn.into() }
}

fn clear_ask(spawn: &str) -> Change { Change::Attention { question: None, id: String::new(), spawn: spawn.into() } }

fn milestone(request_id: &str, text: &str) -> Change { Change::Milestone { request_id: request_id.into(), text: text.into() } }

fn attention_of(path: &Path, id: &str) -> Option<Attention> { read(&mine(path, id)).unwrap().attention }

#[test]
fn the_attention_question_is_bounded_may_span_lines_and_is_free_of_invisible_formatting() {
    assert_eq!(clean_attention("  Which branch?\r\nmain or develop  ").as_deref(), Some("Which branch?\nmain or develop"));
    assert!(clean_attention(&"日".repeat(ATTENTION_MAX_CHARS)).is_some(), "characters, not bytes");
    assert!(clean_attention(&"a".repeat(ATTENTION_MAX_CHARS + 1)).is_none());
    for bad in ["", "   ", "tab\there", "esc\u{1b}[31m", "bidi\u{202e}x", "zero\u{200b}width", "bom\u{feff}", "cr\rhere"] {
        assert!(clean_attention(bad).is_none(), "{bad:?}");
    }
}

#[test]
fn a_milestone_is_one_plain_line_and_its_request_id_a_short_token() {
    assert_eq!(clean_milestone("  Tests green  ").as_deref(), Some("Tests green"));
    assert!(clean_milestone(&"日".repeat(MILESTONE_MAX_CHARS)).is_some());
    assert!(clean_milestone(&"a".repeat(MILESTONE_MAX_CHARS + 1)).is_none());
    for bad in ["", " ", "two\nlines", "bidi\u{202e}", "zero\u{200b}w", "esc\u{1b}"] {
        assert!(clean_milestone(bad).is_none(), "{bad:?}");
    }
    for good in ["a", "A-z_9", &"x".repeat(MILESTONE_ID_MAX_CHARS)] {
        assert!(valid_request_id(good), "{good}");
    }
    for bad in ["", "has space", "dot.id", "slash/id", "日本", "nl\n", &"x".repeat(MILESTONE_ID_MAX_CHARS + 1)] {
        assert!(!valid_request_id(bad), "{bad:?}");
    }
}

#[test]
fn attention_gets_a_fresh_id_per_changed_question_and_an_identical_open_one_is_a_no_op() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    let first = update_in(&path, "p", &id, 0, 1_000, &ask("Which branch?", "id-1", "s1"), ok).unwrap();
    assert!(first.changed);
    let a = first.meta.attention.unwrap();
    assert_eq!((a.id.as_str(), a.question.as_str(), a.set_at, a.spawn.as_str(), a.dismissed), ("id-1", "Which branch?", 1_000, "s1", false));
    let version = snapshot(&path).version;
    // The identical question while it is open: nothing written, the id and stamp stay.
    let same = update_in(&path, "p", &id, 1, 1_000 + 60_000, &ask("Which branch?", "id-other", "s1"), ok).unwrap();
    assert!(!same.changed);
    assert_eq!(same.meta.attention.unwrap().id, "id-1");
    assert_eq!(snapshot(&path).version, version);
    assert_eq!(same.meta.revision, 1);
    // A changed question is a new item with the id the host minted for it.
    let second = update_in(&path, "p", &id, 1, 2_000, &ask("Which branch, really?", "id-2", "s1"), ok).unwrap();
    assert!(second.changed);
    assert_eq!(second.meta.attention.as_ref().unwrap().id, "id-2");
    assert_eq!(second.meta.revision, 2);
    // Clearing what is absent is a no-op; clearing the question removes it.
    let cleared = update_in(&path, "p", &id, 2, 3_000, &clear_ask("s1"), ok).unwrap();
    assert!(cleared.changed && cleared.meta.attention.is_none());
    assert!(!update_in(&path, "p", &id, 3, 3_001, &clear_ask("s1"), ok).unwrap().changed);
    // The key stays after a clear, so a revision is never reused.
    assert_eq!(read(&mine(&path, &id)).unwrap().revision, 3);
    // The mint is random hex, new every time.
    let (x, y) = (mint_attention_id().unwrap(), mint_attention_id().unwrap());
    assert_ne!(x, y);
    assert!(x.len() >= 32 && x.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn a_stale_expected_revision_refuses_an_attention_write_and_writes_nothing() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1, &handoff("note"), ok).unwrap();
    let version = snapshot(&path).version;
    assert_eq!(update_in(&path, "p", &id, 0, 2, &ask("Q?", "i", "s"), ok).unwrap_err(), CONFLICT);
    assert_eq!(snapshot(&path).version, version);
    assert!(attention_of(&path, &id).is_none());
}

#[test]
fn an_identical_retry_after_a_dismissal_does_not_resurface_the_question() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1_000, &ask("Deploy now?", "id-1", "s1"), ok).unwrap();
    assert_eq!(dismiss_in(&path, "p", &id, "id-1").unwrap(), Dismissal::Dismissed);
    let dismissed = attention_of(&path, &id).unwrap();
    assert!(dismissed.dismissed);
    let version = snapshot(&path).version;
    // A retry, soon or after the 24 h window: still dismissed, nothing written, same id.
    for at in [2_000, 1_000 + ATTENTION_TTL_MS + 5] {
        let retry = update_in(&path, "p", &id, 2, at, &ask("Deploy now?", "id-new", "s1"), ok).unwrap();
        assert!(!retry.changed, "{at}");
        let kept = retry.meta.attention.unwrap();
        assert_eq!((kept.id.as_str(), kept.dismissed), ("id-1", true));
    }
    assert_eq!(snapshot(&path).version, version);
    // A different question after a dismissal is a new, open item.
    let next = update_in(&path, "p", &id, 2, 3_000, &ask("Deploy to staging?", "id-2", "s1"), ok).unwrap();
    assert!(next.changed);
    let a = next.meta.attention.unwrap();
    assert_eq!((a.id.as_str(), a.dismissed), ("id-2", false));
}

#[test]
fn dismissal_is_a_compare_and_swap_on_the_attention_id() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1_000, &ask("First?", "id-1", "s1"), ok).unwrap();
    update_in(&path, "p", &id, 1, 2_000, &ask("Second?", "id-2", "s1"), ok).unwrap();
    let version = snapshot(&path).version;
    let before = std::fs::read(&path).unwrap();
    // The window drew the first question; the second replaced it: refused, nothing written.
    assert_eq!(dismiss_in(&path, "p", &id, "id-1").unwrap(), Dismissal::Stale);
    for bad in ["", "unknown", &"x".repeat(ATTENTION_ID_MAX_CHARS + 1)] {
        assert_eq!(dismiss_in(&path, "p", &id, bad).unwrap(), Dismissal::Stale, "{bad:?}");
    }
    assert_eq!(snapshot(&path).version, version);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!attention_of(&path, &id).unwrap().dismissed);
    // The current one: dismissed with one write that moves the revision and the versions.
    assert_eq!(dismiss_in(&path, "p", &id, "id-2").unwrap(), Dismissal::Dismissed);
    assert_eq!(snapshot(&path).version, version + 1);
    let meta = read(&mine(&path, &id)).unwrap();
    assert_eq!(meta.revision, 3);
    assert!(meta.attention.unwrap().dismissed);
    assert_eq!(mine(&path, &id).extra["updatedVersion"], json!(version + 1));
    assert_eq!(mine(&path, &id).extra["unknownFutureField"], json!({"keep":true}), "nothing else changed");
    // Again: nothing to do, nothing written.
    assert_eq!(dismiss_in(&path, "p", &id, "id-2").unwrap(), Dismissal::Unchanged);
    assert_eq!(snapshot(&path).version, version + 1);
    // A tab without any question, and a cleared one.
    let other = {
        // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
        let tabs = snapshot(&path).session.tab_layout;
        tab_id(&tabs[1]).unwrap().to_string()
    };
    assert_eq!(dismiss_in(&path, "p", &other, "id-2").unwrap(), Dismissal::Stale);
    assert_eq!(snapshot(&path).version, version + 1);
}

#[test]
fn dismissal_never_recreates_a_closed_tab_and_unreadable_state_is_not_written() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1, &ask("Q?", "id-1", "s1"), ok).unwrap();
    let tmux = workspace::tmux_of(&mine(&path, &id)).unwrap().to_string();
    workspace::close_tab_in(&path, "p", &tmux, 2).unwrap();
    let version = snapshot(&path).version;
    assert_eq!(dismiss_in(&path, "p", &id, "id-1").unwrap_err(), workspace::TAB_NOT_FOUND);
    assert_eq!(snapshot(&path).version, version);
    let (_dir, path) = session_file();
    let id = seeded(&path);
    workspace::edit_in(&path, "p", |session| {
        // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
        let tab = session.tab_layout.iter_mut().find(|t| tab_id(t) == Some(id.as_str())).unwrap();
        tab.extra.insert(KEY.into(), json!({"v":1,"revision":0,"attention":{"id":7}}));
        Ok(())
    }).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(dismiss_in(&path, "p", &id, "7").unwrap_err(), CORRUPT);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn attention_lapses_after_24_hours_and_a_lapsed_question_can_be_asked_again() {
    assert!(attention_is_live(1_000, 1_000));
    assert!(attention_is_live(1_000, 1_000 + ATTENTION_TTL_MS - 1));
    assert!(!attention_is_live(1_000, 1_000 + ATTENTION_TTL_MS));
    assert!(!attention_is_live(10_000_000 + 2 * 60_000, 10_000_000), "a stamp from the future is not live");
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1_000, &ask("Still there?", "id-1", "s1"), ok).unwrap();
    // Repeating the open question never renews its expiry.
    let same = update_in(&path, "p", &id, 1, 1_000 + ATTENTION_TTL_MS - 1, &ask("Still there?", "id-x", "s1"), ok).unwrap();
    assert!(!same.changed);
    assert_eq!(same.meta.attention.unwrap().set_at, 1_000);
    // Once it lapsed unanswered (not dismissed) the same text is asked again: new id, new stamp.
    let renewed = update_in(&path, "p", &id, 1, 1_000 + ATTENTION_TTL_MS, &ask("Still there?", "id-2", "s1"), ok).unwrap();
    assert!(renewed.changed);
    let a = renewed.meta.attention.unwrap();
    assert_eq!((a.id.as_str(), a.set_at), ("id-2", 1_000 + ATTENTION_TTL_MS));
}

#[test]
fn attention_is_cleared_at_a_new_spawns_grant_and_on_a_reopen_but_not_by_the_same_spawn() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    update_in(&path, "p", &id, 0, 1, &handoff("kept"), ok).unwrap();
    update_in(&path, "p", &id, 1, 2, &ask("Old spawn asks", "id-1", "old"), ok).unwrap();
    let version = snapshot(&path).version;
    // The spawn that asked: nothing to clear.
    assert!(!clear_other_spawns_in(&path, "p", &id, "old").unwrap());
    assert_eq!(snapshot(&path).version, version);
    // Another spawn: the question goes with one write; the handoff stays.
    assert!(clear_other_spawns_in(&path, "p", &id, "new").unwrap());
    let meta = read(&mine(&path, &id)).unwrap();
    assert!(meta.attention.is_none());
    assert_eq!(meta.handoff.unwrap().summary, "kept");
    assert_eq!(meta.revision, 3);
    assert_eq!(snapshot(&path).version, version + 1);
    assert!(!clear_other_spawns_in(&path, "p", &id, "newer").unwrap());
    // A dismissed question of an older spawn goes the same way (no stale history of asks).
    update_in(&path, "p", &id, 3, 5, &ask("Again", "id-2", "new"), ok).unwrap();
    dismiss_in(&path, "p", &id, "id-2").unwrap();
    assert!(clear_other_spawns_in(&path, "p", &id, "third").unwrap());
    assert!(attention_of(&path, &id).is_none());
    // A reopened tab is another identity and starts without the question.
    update_in(&path, "p", &id, 6, 6, &ask("Before close", "id-3", "third"), ok).unwrap();
    update_in(&path, "p", &id, 7, 7, &milestone("m1", "kept too"), ok).unwrap();
    let tmux = workspace::tmux_of(&mine(&path, &id)).unwrap().to_string();
    workspace::close_tab_in(&path, "p", &tmux, 8).unwrap();
    let reopened = workspace::reopen_tab_in(&path, "p", None).unwrap().unwrap();
    let meta = read(&reopened).unwrap();
    assert!(meta.attention.is_none());
    assert_eq!(meta.milestones.len(), 1, "milestones are history and stay");
}

#[test]
fn milestones_dedup_by_request_id_keep_the_last_20_and_carry_host_timestamps() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    let first = update_in(&path, "p", &id, 0, 5_000, &milestone("req-1", "Tests green"), ok).unwrap();
    assert!(first.changed);
    assert_eq!(first.meta.revision, 1);
    assert_eq!(first.meta.milestones, vec![Milestone { request_id: "req-1".into(), text: "Tests green".into(), at: 5_000 }]);
    let version = snapshot(&path).version;
    // The same request id again - even with other text or a wrong revision - changes nothing.
    for text in ["Tests green", "A different text"] {
        let retry = update_in(&path, "p", &id, 0, 9_000, &milestone("req-1", text), ok).unwrap();
        assert!(!retry.changed);
        assert_eq!(retry.meta.milestones[0].text, "Tests green");
        assert_eq!(retry.meta.milestones[0].at, 5_000);
    }
    assert_eq!(snapshot(&path).version, version);
    // Append-only: it takes no revision (any `expected` passes), and moves the revision.
    let second = update_in(&path, "p", &id, 77, 6_000, &milestone("req-2", "Second"), ok).unwrap();
    assert_eq!(second.meta.revision, 2);
    assert_eq!(second.meta.milestones.iter().map(|m| m.request_id.as_str()).collect::<Vec<_>>(), ["req-1", "req-2"]);
    // The cap: the 21st drops the oldest, newest last.
    for i in 3..=22u64 {
        update_in(&path, "p", &id, 0, 6_000 + i, &milestone(&format!("req-{i}"), &format!("M{i}")), ok).unwrap();
    }
    let kept = read(&mine(&path, &id)).unwrap().milestones;
    assert_eq!(kept.len(), MILESTONES_MAX);
    assert_eq!(kept.first().unwrap().request_id, "req-3");
    assert_eq!(kept.last().unwrap().request_id, "req-22");
    assert_eq!(kept.last().unwrap().at, 6_022);
    // An id that fell off the end is new again.
    assert!(update_in(&path, "p", &id, 0, 7_000, &milestone("req-1", "Back"), ok).unwrap().changed);
    // The other setters still compare their revision.
    let revision = read(&mine(&path, &id)).unwrap().revision;
    assert_eq!(update_in(&path, "p", &id, revision - 1, 8_000, &handoff("x"), ok).unwrap_err(), CONFLICT);
}

#[test]
fn attention_and_milestones_survive_unknown_fields_and_unreadable_ones_fail_without_a_write() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    workspace::edit_in(&path, "p", |session| {
        // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
        let tab = session.tab_layout.iter_mut().find(|t| tab_id(t) == Some(id.as_str())).unwrap();
        tab.extra.insert(KEY.into(), json!({"v":1,"revision":4,"laterKey":{"keep":1},
            "attention":{"id":"a","question":"Q","setAt":1,"spawn":"s","laterAttentionKey":true},
            "milestones":[{"requestId":"m","text":"T","at":2}]}));
        Ok(())
    }).unwrap();
    update_in(&path, "p", &id, 4, 3, &handoff("note"), ok).unwrap();
    let stored = mine(&path, &id).extra[KEY].clone();
    assert_eq!(stored["laterKey"], json!({"keep":1}));
    assert_eq!(stored["milestones"][0]["requestId"], "m");
    assert_eq!(stored["attention"]["id"], "a");
    for bad in [
        json!({"v":1,"revision":0,"attention":"Q"}),
        json!({"v":1,"revision":0,"attention":{"id":"a","question":"Q","setAt":"now","spawn":"s"}}),
        json!({"v":1,"revision":0,"milestones":{"requestId":"m"}}),
        json!({"v":1,"revision":0,"milestones":[{"requestId":"m","text":"T"}]}),
    ] {
        workspace::edit_in(&path, "p", |session| {
            // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
            let tab = session.tab_layout.iter_mut().find(|t| tab_id(t) == Some(id.as_str())).unwrap();
            tab.extra.insert(KEY.into(), bad.clone());
            Ok(())
        }).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(update_in(&path, "p", &id, 0, 1, &milestone("x", "y"), ok).unwrap_err(), CORRUPT, "{bad}");
        assert_eq!(update_in(&path, "p", &id, 0, 1, &ask("Q", "i", "s"), ok).unwrap_err(), CORRUPT, "{bad}");
        assert_eq!(read_in(&path, &id, ok).unwrap_err(), CORRUPT);
        assert_eq!(clear_other_spawns_in(&path, "p", &id, "s").unwrap_err(), CORRUPT);
        assert_eq!(dismiss_in(&path, "p", &id, "a").unwrap_err(), CORRUPT);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn attention_and_milestones_are_host_owned_through_a_stale_client_sync_even_a_forged_dismissal() {
    use crate::services::workspace::ClientSync;
    let (_dir, path) = session_file();
    let id = seeded(&path);
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    let before = workspace::sync_in(&path, "p", ClientSync { base_version: 0, tabs: snapshot(&path).session.tab_layout, ..Default::default() }).unwrap();
    update_in(&path, "p", &id, 0, 5, &ask("Real question?", "id-real", "s1"), ok).unwrap();
    update_in(&path, "p", &id, 1, 6, &milestone("m1", "Real milestone"), ok).unwrap();
    let written = snapshot(&path).version;
    let held = |out: &workspace::SyncOutcome, field: &str| out.tabs.iter().find(|t| tab_id(t) == Some(id.as_str())).unwrap().extra[KEY][field].clone();
    // A stale client with no metadata in its copy: both stay, nothing is written.
    let stale = workspace::sync_in(&path, "p", ClientSync { base_version: before.version, tabs: before.tabs.clone(), ..Default::default() }).unwrap();
    assert_eq!(held(&stale, "attention")["question"], "Real question?");
    assert_eq!(held(&stale, "milestones")[0]["requestId"], "m1");
    assert_eq!(stale.version, written);
    // A client that edits another tab and forges a dismissal, a new question and milestones: still the host's.
    let mut tabs = before.tabs.clone();
    tabs[1].label = "other renamed".into();
    tabs[0].extra.insert(KEY.into(), json!({"v":1,"revision":99,
        "attention":{"id":"id-real","question":"Real question?","setAt":5,"spawn":"s1","dismissed":true},
        "milestones":[{"requestId":"forged","text":"Forged","at":1}]}));
    let forged = workspace::sync_in(&path, "p", ClientSync { base_version: before.version, tabs, ..Default::default() }).unwrap();
    assert_eq!(held(&forged, "attention")["dismissed"], serde_json::Value::Null, "{:?}", held(&forged, "attention"));
    assert_eq!(held(&forged, "attention")["id"], "id-real");
    assert_eq!(held(&forged, "milestones")[0]["requestId"], "m1");
    assert_eq!(forged.tabs[1].label, "other renamed");
    assert!(!attention_of(&path, &id).unwrap().dismissed, "a client cannot author a dismissal");
    // The host's own dismissal is what a sync then carries.
    dismiss_in(&path, "p", &id, "id-real").unwrap();
    let after = workspace::sync_in(&path, "p", ClientSync { base_version: before.version, tabs: before.tabs, ..Default::default() }).unwrap();
    assert_eq!(held(&after, "attention")["dismissed"], true);
}

// ── Host bookkeeping above the agent's size bound ───────────────────────────

/// The metadata an agent left with an open question, a running progress report
/// and padding that makes its JSON exactly [`META_MAX_BYTES`] (a key a later
/// build might add: it rides through every rewrite).
fn filled_to_the_bound(spawn: &str, question: bool) -> Meta {
    let mut meta = Meta {
        revision: 4,
        attention: question.then(|| Attention { id: "id-1".into(), question: "Deploy?".into(), set_at: 1_000, spawn: spawn.into(), dismissed: false }),
        progress: Some(Progress {
            steps: vec![ProgressStep { id: "a".into(), label: "A".into(), state: StepState::Active }],
            set_at: 1_000, spawn: spawn.into(), ended: false,
        }),
        ..Meta::default()
    };
    meta.rest.insert("pad".into(), json!(""));
    let bare = serde_json::to_vec(&meta).unwrap().len();
    meta.rest.insert("pad".into(), json!("x".repeat(META_MAX_BYTES - bare)));
    assert_eq!(serde_json::to_vec(&meta).unwrap().len(), META_MAX_BYTES);
    meta
}

fn put(path: &Path, id: &str, meta: &Meta) {
    workspace::edit_in(path, "p", |session| {
        // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
        let tab = session.tab_layout.iter_mut().find(|t| tab_id(t) == Some(id)).unwrap();
        store(tab, meta).map_err(str::to_string)
    }).unwrap();
}

fn stored_size(path: &Path, id: &str) -> usize { serde_json::to_vec(&mine(path, id).extra[KEY]).unwrap().len() }

#[test]
fn the_bound_is_the_agents_exactly_and_the_hosts_markers_fit_above_it() {
    let (_dir, path) = session_file();
    let id = seeded(&path);
    put(&path, &id, &filled_to_the_bound("s1", true));
    assert_eq!(stored_size(&path, &id), META_MAX_BYTES, "an agent may fill it to the byte");

    // An agent setter that adds anything is refused, unwritten, at exactly the bound.
    let version = snapshot(&path).version;
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(update_in(&path, "p", &id, 4, 2_000, &activity("x", "s1"), ok).unwrap_err(), TOO_LARGE);
    assert_eq!(update_in(&path, "p", &id, 4, 2_000, &ask("Another?", "id-2", "s1"), ok).unwrap_err(), TOO_LARGE);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    // One byte over is refused by the agent's `store`; the allowance is the host's.
    let mut tab = mine(&path, &id);
    let mut one_over = filled_to_the_bound("s1", true);
    let pad = one_over.rest["pad"].as_str().unwrap().to_string();
    one_over.rest.insert("pad".into(), json!(format!("{pad}x")));
    assert_eq!(store(&mut tab, &one_over).unwrap_err(), TOO_LARGE, "one byte past the bound");
    assert!(store_host(&mut tab, &one_over).is_ok(), "the same record is within the host's allowance");
    let mut far_over = filled_to_the_bound("s1", true);
    far_over.rest.insert("pad".into(), json!("x".repeat(META_MAX_BYTES + HOST_ALLOWANCE_BYTES)));
    assert_eq!(store_host(&mut tab, &far_over).unwrap_err(), TOO_LARGE, "the host's allowance is fixed, not open");
    assert_eq!(snapshot(&path).version, version);

    // The user's dismissal still lands: written, not a silent no-op, not too_large.
    assert_eq!(dismiss_in(&path, "p", &id, "id-1").unwrap(), Dismissal::Dismissed);
    let meta = read(&mine(&path, &id)).unwrap();
    assert!(meta.attention.unwrap().dismissed);
    assert_eq!(meta.revision, 5);
    assert_eq!(snapshot(&path).version, version + 1);
    let size = stored_size(&path, &id);
    assert!(size > META_MAX_BYTES && size <= META_MAX_BYTES + HOST_ALLOWANCE_BYTES, "{size}");
    // The agent is still held to its bound afterwards.
    assert_eq!(update_in(&path, "p", &id, 5, 3_000, &activity("x", "s1"), ok).unwrap_err(), TOO_LARGE);
}

#[test]
fn grant_time_ended_marking_and_a_reopen_work_for_metadata_at_the_bound() {
    // A new spawn's grant: the old spawn's progress is marked ended, its question goes.
    let (_dir, path) = session_file();
    let id = seeded(&path);
    put(&path, &id, &filled_to_the_bound("old", true));
    let version = snapshot(&path).version;
    assert!(clear_other_spawns_in(&path, "p", &id, "new").unwrap(), "written, not a silent no-write");
    let meta = read(&mine(&path, &id)).unwrap();
    assert!(meta.progress.unwrap().ended);
    assert!(meta.attention.is_none());
    assert_eq!(meta.revision, 5);
    assert_eq!(snapshot(&path).version, version + 1);

    // Progress alone (the question already answered): the marker is all that is added.
    let (_dir, path) = session_file();
    let id = seeded(&path);
    let only_progress = filled_to_the_bound("old", false);
    put(&path, &id, &only_progress);
    assert_eq!(stored_size(&path, &id), META_MAX_BYTES);
    assert!(clear_other_spawns_in(&path, "p", &id, "new").unwrap());
    assert!(read(&mine(&path, &id)).unwrap().progress.unwrap().ended);
    assert!(stored_size(&path, &id) > META_MAX_BYTES);

    // A reopened record: the same, through `drop_transient`.
    let mut tab = mine(&path, &id);
    let mut reopened = only_progress.clone();
    reopened.progress.as_mut().unwrap().ended = false;
    store_host(&mut tab, &reopened).unwrap();
    drop_transient(&mut tab);
    let meta = read(&tab).unwrap();
    assert!(meta.progress.unwrap().ended, "the marker was written");
    assert_eq!(meta.revision, 5);
}

// ── A failed random generator ───────────────────────────────────────────────

#[test]
fn a_failed_generator_mints_nothing_and_a_working_one_mints_hex() {
    assert_eq!(mint_with(|_| false), None, "no all-zero nonce or id");
    let mut zeros = false;
    assert_eq!(mint_with(|bytes| { zeros = bytes.iter().all(|b| *b == 0); false }), None);
    assert!(zeros, "the buffer a failed fill leaves is all zero: it must never be used");
    assert_eq!(mint_with(|bytes| { bytes.fill(0xab); true }).as_deref(), Some("abababababababababababababababab"));
    for minted in [mint_spawn().unwrap(), mint_attention_id().unwrap()] {
        assert!(minted.len() >= 32 && minted.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(minted.chars().any(|c| c != '0'));
    }
}
