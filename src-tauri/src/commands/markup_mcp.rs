//! The window's half of the markup questions MCP (`services::markup_mcp`):
//! list a tab's open ask for the file a markup view shows, answer it (the
//! desktop builds the prompt; the caller queues it into the tab the way the
//! markup Submit does, and reopens the ask with the answer's receipt when
//! queueing fails) or dismiss it. Payloads are camelCase; errors are wire
//! codes (`superseded`, `answered`, `gone`, `invalid_answer`,
//! `invalid_target`, `markup_failed`). The service rings `markup-mcp-changed`
//! through the hook installed here, so it stays `AppHandle`-free.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::services::markup_mcp::{self, Answer, AskView, Shown};

/// Called once from the listener's start (`commands::root_mcp::start`).
pub fn install_change_hook(app: &AppHandle) {
    let app = app.clone();
    markup_mcp::set_change_hook(Box::new(move || {
        let _ = app.emit(markup_mcp::CHANGED_EVENT, ());
    }));
}

fn valid_target(project_id: &str, schedule_target_id: &str) -> Result<(), String> {
    crate::services::agent_tasks::validate_id("project", project_id)
        .and_then(|_| crate::services::agent_tasks::validate_id("schedule target", schedule_target_id))
        .map_err(|_| "invalid_target".to_string())
}

/// The project-relative form of the path a view shows: the desktop viewer's
/// absolute path, or the phone bridge's project-relative one. `None` when it
/// does not resolve under the project — the view then gets only the asks
/// bound to no file.
fn shown_rel(project_id: &str, path: &str) -> Option<String> {
    let root = markup_mcp::project_root(project_id)?;
    markup_mcp::resolve_file(&root, path, false).ok()
}

/// `markup_mcp_list({ projectId, scheduleTargetId, path? })` → the open asks
/// (`[{ id, file, fileName, createdAt, questions }]`; at most one per tab).
#[tauri::command]
pub async fn markup_mcp_list(project_id: String, schedule_target_id: String, path: Option<String>) -> Result<Vec<AskView>, String> {
    valid_target(&project_id, &schedule_target_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let shown = path.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(|p| shown_rel(&project_id, p));
        let shown = match &shown {
            None => Shown::All,
            Some(Some(rel)) => Shown::File(rel),
            Some(None) => Shown::Elsewhere,
        };
        markup_mcp::list(&project_id, &schedule_target_id, shown)
    })
    .await
    .map_err(|_| "markup_failed".to_string())
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct MarkupAnswered {
    pub prompt: String,
    /// Hands back to `markup_mcp_reopen` when `prompt` could not be queued.
    pub receipt: String,
}

/// `markup_mcp_answer({ projectId, scheduleTargetId, askId, answers:
/// [{ options: number[], other? }] })` → `{ prompt, receipt }`, one answer
/// per question in order. The ask is closed before the prompt is returned; a
/// caller that then fails to queue the prompt reopens it with `receipt`.
#[tauri::command]
pub fn markup_mcp_answer(project_id: String, schedule_target_id: String, ask_id: String, answers: Vec<Answer>) -> Result<MarkupAnswered, String> {
    valid_target(&project_id, &schedule_target_id)?;
    markup_mcp::answer(&project_id, &schedule_target_id, &ask_id, &answers)
        .map(|taken| MarkupAnswered { prompt: taken.prompt, receipt: taken.receipt })
        .map_err(|e| e.code().to_string())
}

/// `markup_mcp_reopen({ projectId, scheduleTargetId, askId, receipt })`: the
/// prompt of the answer `receipt` names never reached the tab — open the ask
/// again so its card stays usable. Refused (`answered`, `superseded`, `gone`)
/// when anything else closed or replaced it since.
#[tauri::command]
pub fn markup_mcp_reopen(project_id: String, schedule_target_id: String, ask_id: String, receipt: String) -> Result<(), String> {
    valid_target(&project_id, &schedule_target_id)?;
    markup_mcp::reopen(&project_id, &schedule_target_id, &ask_id, &receipt).map_err(|e| e.code().to_string())
}

/// `markup_mcp_dismiss({ projectId, scheduleTargetId, askId })`: **Answer in
/// chat instead**. Idempotent.
#[tauri::command]
pub fn markup_mcp_dismiss(project_id: String, schedule_target_id: String, ask_id: String) -> Result<(), String> {
    valid_target(&project_id, &schedule_target_id)?;
    markup_mcp::dismiss(&project_id, &schedule_target_id, &ask_id).map_err(|e| e.code().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_are_bounded_and_answers_are_camel_case_and_closed() {
        assert!(valid_target("p", "t").is_ok());
        assert_eq!(valid_target("", "t"), Err("invalid_target".into()));
        assert_eq!(valid_target("p", "a\nb"), Err("invalid_target".into()));
        let answers: Vec<Answer> = serde_json::from_str(r#"[{"options":[1]},{"options":[],"other":"x"},{}]"#).unwrap();
        assert_eq!(answers[0], Answer { options: vec![1], other: None });
        assert_eq!(answers[1].other.as_deref(), Some("x"));
        assert_eq!(answers[2], Answer::default());
        for bad in [r#"[{"options":[-1]}]"#, r#"[{"options":[0],"extra":1}]"#, r#"[{"option":[0]}]"#] {
            assert!(serde_json::from_str::<Vec<Answer>>(bad).is_err(), "{bad}");
        }
        assert_eq!(serde_json::to_value(MarkupAnswered { prompt: "p".into(), receipt: "r".into() }).unwrap(), serde_json::json!({"prompt": "p", "receipt": "r"}));
        assert_eq!(markup_mcp_answer("p".into(), "t".into(), "ask-none".into(), vec![]), Err("gone".into()));
        assert_eq!(markup_mcp_dismiss("p".into(), "t".into(), "ask-none".into()), Ok(()));
        assert_eq!(markup_mcp_reopen("p".into(), "t".into(), "ask-none".into(), "r".into()), Err("gone".into()));
        assert_eq!(markup_mcp_reopen("p".into(), "".into(), "ask-none".into(), "r".into()), Err("invalid_target".into()));
    }
}
