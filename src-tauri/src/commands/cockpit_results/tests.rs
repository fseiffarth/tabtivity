use std::sync::Arc;

use app_core::{Caller, CoreCtx, CoreState, RecordingEvents};
use serde_json::json;

use super::*;
use crate::schema::project::TabEntry;
use crate::services::cockpit_meta::{Change, update_in};
use crate::services::workspace::{self, tab_id};

fn seeded(path: &std::path::Path) -> String {
    let tab: TabEntry = serde_json::from_value(json!({"key":"mine","label":"mine","cmd":"claude","cwd":"work","kind":"agent"})).unwrap();
    tab_id(&workspace::create_tab_in(path, "p", tab, None).unwrap().tab).unwrap().to_string()
}

fn ask(path: &std::path::Path, id: &str, question: &str, attention_id: &str) {
    let change = Change::Attention { question: Some(question.into()), id: attention_id.into(), spawn: "s1".into() };
    update_in(path, "p", id, 0, 1_000, &change, || Ok(())).unwrap();
}

fn ctx() -> (CoreCtx, Arc<RecordingEvents>) {
    let events = RecordingEvents::new();
    (CoreCtx::new(Arc::new(CoreState::new()), events.clone(), Caller::System), events)
}

/// The command's post-commit step: what a committed dismissal sends is the
/// empty-ops `workspace:patch` the cockpit lane sends, carrying the version the
/// dismissal committed; a dismissal that wrote nothing sends nothing.
#[test]
fn a_committed_dismissal_sends_the_workspace_patch_hint_and_a_no_write_sends_none() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sessions").join("p").join("terminals.json");
    let id = seeded(&path);
    ask(&path, &id, "Deploy now?", "id-1");
    let (ctx, events) = ctx();

    let (verdict, version) = cockpit_meta::dismiss_versioned_in(&path, "p", &id, "id-1").unwrap();
    assert_eq!(verdict, Dismissal::Dismissed);
    let committed = workspace::snapshot_in(&path).unwrap().version;
    assert_eq!(version, Some(committed), "the outcome carries the version it committed");
    announce_dismissal(&ctx, "p", version);
    assert_eq!(events.payloads(WORKSPACE_PATCH_EVENT), vec![json!({"scope":"p","version":committed,"ops":[]})]);

    // Already dismissed, a stale id: nothing written, so nothing announced.
    for attention_id in ["id-1", "id-other"] {
        let (verdict, version) = cockpit_meta::dismiss_versioned_in(&path, "p", &id, attention_id).unwrap();
        assert_ne!(verdict, Dismissal::Dismissed);
        assert_eq!(version, None);
        announce_dismissal(&ctx, "p", version);
    }
    assert_eq!(events.payloads(WORKSPACE_PATCH_EVENT).len(), 1, "still the one hint");
    assert_eq!(workspace::snapshot_in(&path).unwrap().version, committed);
}

/// The command itself must send the hint after the blocking body (a source
/// check: the async command needs a window to call). A removed call fails here.
#[test]
fn the_dismiss_command_announces_after_its_blocking_body() {
    let text = include_str!("../cockpit_results.rs");
    let command = text.split("pub async fn cockpit_attention_dismiss(").nth(1).unwrap().split("\n}\n").next().unwrap();
    let body = command.find("cockpit_attention_dismiss_blocking").expect("the blocking body");
    let announce = command.find("announce_dismissal(&ctx").expect("the command announces");
    assert!(announce > body, "the hint follows the commit");
}
