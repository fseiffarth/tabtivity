//! Thin commands over `services::copilot`. The project's directory and
//! remoteness always come from `services::remote`, never from the payload, and
//! the consent policy is re-applied on every call that can reach the server.
use crate::schema::settings::CompletionProjectPolicy;
use crate::schema::Settings;
use crate::services::copilot::documents::Position;
use crate::services::copilot::credentials;
use crate::services::copilot::policy::{self, error_code as policy_code};
use crate::services::copilot::remote as remote_copilot;
use crate::services::copilot::session::{sessions, CompletionRequest, DeviceCode, Session};
use crate::services::copilot::process;
use crate::services::copilot::requests;
use crate::services::remote;
use crate::storage;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use app_core::CoreCtx;
use crate::tauri_host::Ctx;

fn settings_path() -> PathBuf {
    storage::settings_path()
}

fn load_settings() -> Result<Settings, String> {
    let path = settings_path();
    if path.exists() {
        storage::read_json(&path).map_err(|_| "copilot_disabled".into())
    } else {
        Ok(Settings::default())
    }
}

/// A local-models-only project's text never reaches GitHub's Copilot, whatever
/// consent is on file (`services::agent_privacy`): the same refusal as a
/// project's own `local_only`, so the editor falls back to the local model.
fn locked_project(project_id: &str) -> bool {
    remote::project_entry(project_id).map_or(true, |entry| crate::services::agent_privacy::is_locked(&entry))
}

fn authorize_in(settings: &Settings, project_id: &str) -> Result<PathBuf, String> {
    if locked_project(project_id) {
        return Err("copilot_local_only".into());
    }
    let directory = remote::project_directory(project_id).ok_or("copilot_no_consent")?;
    if let Some(target) = remote::remote_target_for(project_id) {
        return remote_copilot::authorize(settings, &target).map_err(policy_code);
    }
    policy::authorize_project(settings, project_id, Path::new(&directory), false).map_err(policy_code)
}

fn authorize(project_id: &str) -> Result<PathBuf, String> {
    authorize_in(&load_settings()?, project_id)
}

/// A refusal is also a revocation: whatever was running for the project stops.
/// The one place a server starts: with AI switched off none does, whichever
/// command asked (a completion, or a click on Sign in).
async fn session(project_id: &str) -> Result<(Arc<Session>, PathBuf), String> {
    crate::services::ai_switch::check()?;
    match authorize(project_id) {
        Ok(root) => {
            if remote::remote_target_for(project_id).is_some() {
                // App-owned empty workspace, mounted read-only; buffers stay in RAM.
                std::fs::create_dir_all(&root).map_err(|_| "copilot_invalid_path")?;
            }
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
fn editor_key(ctx: &CoreCtx, editor: &str) -> Result<String, String> {
    if editor.is_empty() || editor.len() > 64 {
        return Err("copilot_document_limit".into());
    }
    // The calling client (on the desktop: the window's label), never payload.
    let client = ctx.caller.client().ok_or("copilot_no_client")?;
    Ok(format!("{client}:{editor}"))
}

fn request_owner(project_id: &str, editor: &str) -> String {
    json!([project_id, editor]).to_string()
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn copilot_prepare(ctx: Ctx, project_id: String, editor: String) -> Result<String, String> {
    authorize(&project_id)?;
    requests::reserve(request_owner(&project_id, &editor_key(&ctx, &editor)?))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn copilot_setup() -> Value {
    let installed = process::server_path(&process::install_directory()).is_ok();
    json!({
        "supported": process::supported(),
        "installed": installed,
        "installCommand": process::install_command().ok(),
    })
}

/// Consent binds the project id to the directory the backend resolves now.
/// Text-file consent only stands on top of code consent; dropping that drops
/// it too. Returns the settings that won, like `patch_settings`, for the
/// sender to broadcast.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_set_project_policy(ctx: Ctx, project_id: String, copilot: bool, local_only: bool, text: Option<bool>)
    -> Result<Settings, String> {
    let directory = remote::project_directory(&project_id).ok_or("copilot_invalid_path")?;
    if copilot && locked_project(&project_id) {
        return Err("copilot_local_only".into());
    }
    let target = remote::remote_target_for(&project_id);
    let binding = target.as_ref().map(remote_copilot::binding);
    // Revocation must work while disconnected. Only granting consent needs SSH.
    let directory = if let Some(target) = &target {
        if copilot && !local_only {
            remote_copilot::canonical_root(ctx.get::<remote::RemotePoolState>(), target).await?
        } else {
            target.spec.remote_path.clone()
        }
    } else {
        Path::new(&directory).canonicalize().map_err(|_| "copilot_invalid_path")?.to_string_lossy().into_owned()
    };
    if remote::remote_target_for(&project_id).as_ref().map(remote_copilot::binding) != binding {
        return Err("copilot_no_consent".into());
    }
    let saved = storage::patch_json(&settings_path(), Settings::default(), |settings| {
        let policies = settings.completion_project_policies.get_or_insert_with(Default::default);
        let extra = policies.remove(&project_id).map(|old| old.extra).unwrap_or_default();
        policies.insert(project_id.clone(), CompletionProjectPolicy {
            directory, remote: binding, copilot, local_only,
            copilot_text: copilot && !local_only && text.unwrap_or(false), extra,
        });
        Ok(settings.clone())
    })?;
    // A changed consent/root must also discard the old server and candidates.
    sessions().stop(&project_id).await;
    Ok(saved)
}

#[allow(clippy::too_many_arguments)]
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_complete(
    ctx: Ctx,
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
    crate::services::ai_switch::check()?;
    let editor = editor_key(&ctx, &editor)?;
    let mut lease = requests::start(&request_owner(&project_id, &editor), &request_id)?;
    // The document is judged before any server starts: a file Copilot may not
    // see never starts a network-capable process for its project.
    let settings = load_settings()?;
    let root = match authorize_in(&settings, &project_id) {
        Ok(root) => root,
        Err(error) => {
            sessions().stop(&project_id).await;
            return Err(error);
        }
    };
    let file = authorize_file(&ctx, &settings, &project_id, &root, &path).await?;
    // Detached: a keystroke cancels this request, never the server launch
    // behind it. Dropping the launch would kill the starting server, and three
    // of those spend the project's restart budget.
    let launch = tokio::spawn({
        let project_id = project_id.clone();
        async move { session(&project_id).await }
    });
    let (session, launched_root) = tokio::select! {
        biased;
        _ = requests::cancelled(&mut lease.signal) => return Err("copilot_cancelled".into()),
        result = launch => result.map_err(|_| "copilot_server_closed")??,
    };
    // Consent may have changed while initialization was waiting on the server.
    let settings = load_settings()?;
    if launched_root != root || authorize_in(&settings, &project_id).as_ref() != Ok(&root) {
        sessions().stop(&project_id).await;
        return Err("copilot_no_consent".into());
    }
    // Keeps the server from its idle shutdown (`Sessions::reap_idle`).
    sessions().note_use(&project_id);
    let file = match authorize_file(&ctx, &settings, &project_id, &root, &path).await {
        Ok(again) if again == file => file,
        Ok(_) => return Err("copilot_invalid_path".into()),
        Err(error) => return Err(error),
    };
    let current = load_settings()?;
    if authorize_in(&current, &project_id).as_ref() != Ok(&root)
        || policy::text_consented(&current, &project_id) != policy::text_consented(&settings, &project_id) {
        sessions().stop(&project_id).await;
        return Err("copilot_no_consent".into());
    }
    let uri = url::Url::from_file_path(&file).map_err(|_| "copilot_invalid_path")?;
    session.complete_cancellable(CompletionRequest {
        uri: uri.as_str(), editor: &editor, client_version: version, text: &text, language: &language,
        allow_text: policy::text_consented(&settings, &project_id), position, automatic, tab_size: tab_size.clamp(1, 16), insert_spaces,
    }, lease.signal.clone()).await
}

/// The file a completion may send, judged on the path `authorize_document`
/// resolved: inside the consented project, not credential-shaped, not inside
/// a local-models-only project (whatever this project's consent is,
/// `services::agent_privacy`), and prose only with the text consent.
async fn authorize_file(ctx: &CoreCtx, settings: &Settings, project_id: &str, root: &Path, path: &str) -> Result<PathBuf, String> {
    if let Some(target) = remote::remote_target_for(project_id) {
        return remote_copilot::document(ctx.get::<remote::RemotePoolState>(), settings, &target, root, path).await;
    }
    let file = policy::authorize_document(root, Path::new(path)).map_err(policy_code)?;
    if crate::services::agent_privacy::inside_locked(&file) {
        return Err("copilot_local_only".into());
    }
    if policy::text_file(&file) && !policy::text_consented(settings, project_id) {
        return Err("copilot_code_only".into());
    }
    Ok(file)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_cancel(ctx: Ctx, project_id: String, editor: String, request_id: String) -> Result<(), String> {
    let editor = editor_key(&ctx, &editor)?;
    requests::cancel(&request_owner(&project_id, &editor), &request_id);
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_close_editor(ctx: Ctx, project_id: String, editor: String) -> Result<(), String> {
    let editor = editor_key(&ctx, &editor)?;
    requests::cancel_owner(&request_owner(&project_id, &editor));
    if let Some(session) = sessions().existing(&project_id).await {
        session.close_editor(&editor).await;
    }
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_shown(ctx: Ctx, project_id: String, editor: String, candidate: String) -> Result<(), String> {
    let editor = editor_key(&ctx, &editor)?;
    match sessions().existing(&project_id).await {
        Some(session) => session.shown(&editor, &candidate).await,
        None => Ok(()),
    }
}

/// `accepted_length` omitted is the full acceptance.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_accepted(
    ctx: Ctx,
    project_id: String,
    editor: String,
    candidate: String,
    accepted_length: Option<u32>,
) -> Result<(), String> {
    let editor = editor_key(&ctx, &editor)?;
    match sessions().existing(&project_id).await {
        Some(session) => session.accepted(&editor, &candidate, accepted_length).await,
        None => Ok(()),
    }
}

/// Never starts a server: a status read must not be what sends a project's
/// workspace to a subprocess.
/// `remembered`: "Stay signed in" is on and a sign-in for this app account is
/// in the keychain; never the token. With the setting off the keychain is not
/// read.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_account(project_id: String) -> Result<Value, String> {
    let remembered = credentials::restorable(credentials::stay_signed_in().await, &credentials::keychain()).await;
    let Some(session) = sessions().existing(&project_id).await.filter(|session| session.alive()) else {
        return Ok(json!({"running": false, "remembered": remembered}));
    };
    let account = session.account().await.ok();
    Ok(json!({"running": true, "status": session.status(), "account": account, "messages": session.account_messages(),
        "remembered": remembered}))
}

/// The newest log lines of the project's server (its log messages and stderr),
/// redacted, from memory only. Never starts a server.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn copilot_diagnostics(project_id: String) -> Value {
    json!({"lines": sessions().diagnostics(&project_id)})
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_message_action(project_id: String, message_id: u64, action: Option<usize>) -> Result<(), String> {
    match sessions().existing(&project_id).await {
        Some(session) => session.answer_message(message_id, action).await,
        None => Ok(()),
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_sign_in(project_id: String) -> Result<Option<DeviceCode>, String> {
    session(&project_id).await?.0.sign_in().await
}

/// With "Stay signed in" on, the finished sign-in's token goes to the
/// keychain; a keychain that refuses (locked) leaves the sign-in working for
/// this server and is reported.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_finish_sign_in(project_id: String) -> Result<(), String> {
    let session = session(&project_id).await?.0;
    session.finish_sign_in().await?;
    credentials::after_sign_in(&session, credentials::stay_signed_in().await, &credentials::keychain()).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copilot_sign_out(project_id: String) -> Result<(), String> {
    let result = match sessions().existing(&project_id).await {
        Some(session) => session.sign_out().await,
        None => Ok(()),
    };
    // Even an offline sign-out releases credentials, cached offers and work,
    // and the remembered sign-in: the next server asks again.
    sessions().stop(&project_id).await;
    let store = credentials::keychain();
    // Asked first so a sign-out with nothing remembered never writes to (or
    // reports) a locked keychain.
    let forgotten = if credentials::remembered(&store).await { credentials::forget(&store).await } else { Ok(()) };
    result.and(forgotten)
}

/// `RunEvent::Exit`: no language server outlives Tabtivity.
pub async fn stop_all_for_exit() {
    sessions().stop_all().await;
}

#[cfg(test)]
mod tests {
    /// Source scan: `session` is the only caller of `get_or_start`, and it
    /// asks the AI switch first, so no command can start a server while AI is
    /// off (Sign in used to).
    #[test]
    fn no_server_starts_while_ai_is_switched_off() {
        let source = include_str!("copilot.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert_eq!(code.matches("get_or_start(").count(), 1, "a second place starts a server");
        let body = code.split("async fn session(").nth(1).expect("the session helper");
        let check = body.find("ai_switch::check()?").expect("session asks the AI switch");
        assert!(check < body.find("get_or_start(").unwrap(), "the switch is asked before a server starts");
    }
}
