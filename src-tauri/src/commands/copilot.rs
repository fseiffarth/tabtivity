//! Thin commands over `services::copilot`. The project's directory and
//! remoteness always come from `services::remote`, never from the payload, and
//! the consent policy is re-applied on every call that can reach the server.
use crate::schema::settings::CompletionProjectPolicy;
use crate::schema::Settings;
use crate::services::copilot::documents::Position;
use crate::services::copilot::policy::{self, PolicyError};
use crate::services::copilot::session::{sessions, CompletionRequest, DeviceCode, Session};
use crate::services::copilot::process;
use crate::services::copilot::requests;
use crate::services::remote;
use crate::storage;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn settings_path() -> PathBuf {
    storage::state_dir().join("settings.json")
}

fn policy_code(error: PolicyError) -> String {
    match error {
        PolicyError::Disabled => "copilot_disabled",
        PolicyError::Remote => "copilot_remote_project",
        PolicyError::NoConsent => "copilot_no_consent",
        PolicyError::LocalOnly => "copilot_local_only",
        PolicyError::InvalidPath => "copilot_invalid_path",
        PolicyError::OutsideProject => "copilot_outside_project",
        PolicyError::SecretFile => "copilot_secret_file",
    }
    .into()
}

fn load_settings() -> Result<Settings, String> {
    let path = settings_path();
    if path.exists() {
        storage::read_json(&path).map_err(|_| "copilot_disabled".into())
    } else {
        Ok(Settings::default())
    }
}

fn authorize_in(settings: &Settings, project_id: &str) -> Result<PathBuf, String> {
    let directory = remote::project_directory(project_id).ok_or("copilot_no_consent")?;
    let is_remote = remote::remote_target_for(project_id).is_some();
    policy::authorize_project(settings, project_id, Path::new(&directory), is_remote).map_err(policy_code)
}

fn authorize(project_id: &str) -> Result<PathBuf, String> {
    authorize_in(&load_settings()?, project_id)
}

/// A refusal is also a revocation: whatever was running for the project stops.
async fn session(project_id: &str) -> Result<(Arc<Session>, PathBuf), String> {
    match authorize(project_id) {
        Ok(root) => {
            let session = sessions().get_or_start(project_id, &root).await?;
            if authorize(project_id).as_ref() != Ok(&root) {
                sessions().stop(project_id).await;
                return Err("copilot_no_consent".into());
            }
            Ok((session, root))
        },
        Err(error) => {
            sessions().stop(project_id).await;
            Err(error)
        }
    }
}

/// Editors are per window: one window can never cancel, close or report
/// feedback for another's documents.
fn editor_key(window: &tauri::Window, editor: &str) -> Result<String, String> {
    if editor.is_empty() || editor.len() > 64 {
        return Err("copilot_document_limit".into());
    }
    Ok(format!("{}:{editor}", window.label()))
}

fn request_owner(project_id: &str, editor: &str) -> String {
    json!([project_id, editor]).to_string()
}

#[tauri::command]
pub fn copilot_prepare(window: tauri::Window, project_id: String, editor: String) -> Result<String, String> {
    authorize(&project_id)?;
    requests::reserve(request_owner(&project_id, &editor_key(&window, &editor)?))
}

#[tauri::command]
pub fn copilot_setup() -> Value {
    let installed = process::server_path(&process::install_directory()).is_ok();
    json!({
        "supported": process::supported(),
        "installed": installed,
        "installCommand": process::install_command().ok(),
    })
}

#[tauri::command]
pub fn copilot_project_policy(project_id: String) -> Value {
    let settings: Settings = storage::read_json(&settings_path()).unwrap_or_default();
    let policy = settings.completion_project_policies.as_ref().and_then(|p| p.get(&project_id));
    json!({
        "copilot": policy.is_some_and(|p| p.copilot),
        "localOnly": policy.is_some_and(|p| p.local_only),
        "text": policy.is_some_and(|p| p.copilot_text),
        "remote": remote::remote_target_for(&project_id).is_some(),
        "authorized": authorize(&project_id).is_ok(),
    })
}

/// Consent binds the project id to the directory the backend resolves now.
/// Text-file consent only stands on top of code consent; dropping that drops
/// it too. Returns the settings that won, like `patch_settings`, for the
/// sender to broadcast.
#[tauri::command]
pub async fn copilot_set_project_policy(project_id: String, copilot: bool, local_only: bool, text: Option<bool>)
    -> Result<Settings, String> {
    let directory = remote::project_directory(&project_id).ok_or("copilot_invalid_path")?;
    if copilot && remote::remote_target_for(&project_id).is_some() {
        return Err("copilot_remote_project".into());
    }
    let directory = Path::new(&directory).canonicalize().map_err(|_| "copilot_invalid_path")?;
    let saved = storage::patch_json(&settings_path(), Settings::default(), |settings| {
        let policies = settings.completion_project_policies.get_or_insert_with(Default::default);
        let extra = policies.remove(&project_id).map(|old| old.extra).unwrap_or_default();
        policies.insert(project_id.clone(), CompletionProjectPolicy {
            directory: directory.to_string_lossy().into_owned(), copilot, local_only,
            copilot_text: copilot && !local_only && text.unwrap_or(false), extra,
        });
        Ok(settings.clone())
    })?;
    if !copilot || local_only {
        sessions().stop(&project_id).await;
    }
    Ok(saved)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn copilot_complete(
    window: tauri::Window,
    project_id: String,
    path: String,
    editor: String,
    request_id: String,
    version: u64,
    text: String,
    language: String,
    position: Position,
    automatic: bool,
    tab_size: u32,
    insert_spaces: bool,
) -> Result<Vec<Value>, String> {
    let editor = editor_key(&window, &editor)?;
    let mut lease = requests::start(&request_owner(&project_id, &editor), &request_id)?;
    // Detached: a keystroke cancels this request, never the server launch
    // behind it. Dropping the launch would kill the starting server, and three
    // of those spend the project's restart budget.
    let launch = tokio::spawn({
        let project_id = project_id.clone();
        async move { session(&project_id).await }
    });
    let (session, root) = tokio::select! {
        biased;
        _ = requests::cancelled(&mut lease.signal) => return Err("copilot_cancelled".into()),
        result = launch => result.map_err(|_| "copilot_server_closed")??,
    };
    // Consent may have changed while initialization was waiting on the server.
    let settings = load_settings()?;
    if authorize_in(&settings, &project_id).as_ref() != Ok(&root) {
        sessions().stop(&project_id).await;
        return Err("copilot_no_consent".into());
    }
    let file = policy::authorize_document(&root, Path::new(&path)).map_err(policy_code)?;
    let uri = url::Url::from_file_path(&file).map_err(|_| "copilot_invalid_path")?;
    session.complete_cancellable(CompletionRequest {
        uri: uri.as_str(), editor: &editor, client_version: version, text: &text, language: &language,
        allow_text: policy::text_consented(&settings, &project_id), position, automatic, tab_size: tab_size.clamp(1, 16), insert_spaces,
    }, lease.signal.clone()).await
}

#[tauri::command]
pub async fn copilot_cancel(window: tauri::Window, project_id: String, editor: String, request_id: String) -> Result<(), String> {
    let editor = editor_key(&window, &editor)?;
    requests::cancel(&request_owner(&project_id, &editor), &request_id);
    Ok(())
}

#[tauri::command]
pub async fn copilot_close_editor(window: tauri::Window, project_id: String, editor: String) -> Result<(), String> {
    let editor = editor_key(&window, &editor)?;
    requests::cancel_owner(&request_owner(&project_id, &editor));
    if let Some(session) = sessions().existing(&project_id).await {
        session.close_editor(&editor).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn copilot_shown(window: tauri::Window, project_id: String, editor: String, candidate: String) -> Result<(), String> {
    let editor = editor_key(&window, &editor)?;
    match sessions().existing(&project_id).await {
        Some(session) => session.shown(&editor, &candidate).await,
        None => Ok(()),
    }
}

/// `accepted_length` omitted is the full acceptance.
#[tauri::command]
pub async fn copilot_accepted(
    window: tauri::Window,
    project_id: String,
    editor: String,
    candidate: String,
    accepted_length: Option<u32>,
) -> Result<(), String> {
    let editor = editor_key(&window, &editor)?;
    match sessions().existing(&project_id).await {
        Some(session) => session.accepted(&editor, &candidate, accepted_length).await,
        None => Ok(()),
    }
}

/// Never starts a server: a status read must not be what sends a project's
/// workspace to a subprocess.
#[tauri::command]
pub async fn copilot_account(project_id: String) -> Result<Value, String> {
    let Some(session) = sessions().existing(&project_id).await.filter(|session| session.alive()) else {
        return Ok(json!({"running": false}));
    };
    let account = session.account().await.ok();
    Ok(json!({"running": true, "status": session.status(), "account": account, "messages": session.account_messages()}))
}

#[tauri::command]
pub async fn copilot_message_action(project_id: String, message_id: u64, action: Option<usize>) -> Result<(), String> {
    match sessions().existing(&project_id).await {
        Some(session) => session.answer_message(message_id, action).await,
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn copilot_sign_in(project_id: String) -> Result<Option<DeviceCode>, String> {
    session(&project_id).await?.0.sign_in().await
}

#[tauri::command]
pub async fn copilot_finish_sign_in(project_id: String) -> Result<(), String> {
    session(&project_id).await?.0.finish_sign_in().await
}

#[tauri::command]
pub async fn copilot_sign_out(project_id: String) -> Result<(), String> {
    let result = match sessions().existing(&project_id).await {
        Some(session) => session.sign_out().await,
        None => Ok(()),
    };
    // Even an offline sign-out releases credentials, cached offers and work.
    sessions().stop(&project_id).await;
    result
}

#[tauri::command]
pub async fn copilot_stop(project_id: String) {
    sessions().stop(&project_id).await;
}

/// `RunEvent::Exit`: no language server outlives Tabtivity.
pub async fn stop_all_for_exit() {
    sessions().stop_all().await;
}
