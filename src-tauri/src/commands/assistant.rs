//! The chat assistant's commands (`docs/assistant_plan.md`, A3): what the
//! overlay's new-chat menu and the search settings call. Payloads are
//! camelCase. Every command refuses while the experimental flag is off
//! (`Settings::assistant_enabled`) with the fixed wire code [`OFF`]; a refusal
//! of the assistant service itself (`services::assistant::Refusal`) is
//! answered as `"<code>: <text>"` so a caller can match the code and show the
//! text. The service bodies are `services::assistant`'s; nothing here builds
//! an argv or an env.

use std::path::Path;

use serde::Serialize;

use crate::commands::projects::WORKSPACE_PATCH_EVENT;
use crate::schema::settings::{AssistantSearchSettings, ASSISTANT_SEARCH_KINDS};
use crate::schema::Settings;
use crate::services::assistant::{self, AssistantCli, AssistantLaunch, Refusal};
use crate::services::remote_credentials::{self, KeyringState};
use crate::services::web_lane::{self, SearchConfig};
use crate::storage;
use crate::tauri_host::Ctx;

/// What every command answers while the experimental flag is off.
pub const OFF: &str = "assistant_off";

/// The longest search key accepted.
const MAX_KEY_LEN: usize = 1024;

fn gate(enabled: bool) -> Result<(), String> {
    if enabled {
        Ok(())
    } else {
        Err(OFF.to_string())
    }
}

/// The experimental flag, read from `settings.json` (a missing or unreadable
/// file is the defaults: off).
fn enabled_now() -> bool {
    storage::load_settings().unwrap_or_default().assistant_enabled()
}

fn refused(refusal: Refusal) -> String {
    format!("{}: {refusal}", refusal.code())
}

// ── assistant_options ───────────────────────────────────────────────────────

/// One CLI the new-chat menu may offer.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliOption {
    /// The `AssistantCli` id (`claude`, `codex`, `opencode_local`,
    /// `claude_local`): what `assistant_new_chat` takes.
    pub id: String,
    pub label: String,
    /// Runs on a local Ollama model (the chat then needs a `model`).
    pub local: bool,
    /// The CLI's binary is installed.
    pub installed: bool,
    /// A cloud CLI: its shared login (or an API key) is there. `None` for a
    /// local one, which has no login.
    pub signed_in: Option<bool>,
    /// A chat can start now: installed and signed in, or installed with
    /// Ollama reachable and a model pulled.
    pub ready: bool,
    /// Codex: the models its chat can be switched to
    /// (`assistant::codex_offered_models`). Empty for every other CLI (Claude's
    /// aliases are the renderer's list, a local CLI takes `local_models`).
    pub models: Vec<String>,
}

/// The search backend's state. Never the key.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchState {
    /// `"searxng"`, `"ollama"` or `None` (nothing chosen, or a value this
    /// build does not know).
    pub kind: Option<String>,
    pub searxng_url: Option<String>,
    /// An Ollama search key is stored. `None` when the keychain cannot be
    /// read right now (locked or absent): the answer is then unknown.
    pub ollama_key_stored: Option<bool>,
    /// `"unlocked"`, `"locked"` or `"unavailable"` (`remote_credentials`).
    pub keyring: &'static str,
    /// `web_search` has a backend it can use.
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantOptions {
    /// Every offered CLI, in menu order.
    pub clis: Vec<CliOption>,
    /// The installed Ollama models (empty when Ollama is down).
    pub local_models: Vec<String>,
    /// Ollama answered `/api/tags`.
    pub ollama_reachable: bool,
    /// The saved defaults, as written (validated when a chat starts).
    pub default_cli: Option<String>,
    pub default_model: Option<String>,
    pub search: SearchState,
}

fn keyring_word(state: KeyringState) -> &'static str {
    match state {
        KeyringState::Unlocked => "unlocked",
        KeyringState::Locked => "locked",
        KeyringState::Unavailable => "unavailable",
    }
}

/// The search backend as `settings` and the keychain describe it.
/// `key_stored` is the keychain read, taken only when the store is readable.
fn search_state(settings: &Settings, keyring: KeyringState, key_stored: Option<bool>) -> SearchState {
    let block = settings.assistant_settings.as_ref().and_then(|a| a.search.as_ref());
    let kind = block
        .and_then(|s| s.kind.as_deref())
        .filter(|k| ASSISTANT_SEARCH_KINDS.contains(k))
        .map(str::to_string);
    let searxng_url = block.and_then(|s| s.searxng_url.clone()).filter(|u| !u.trim().is_empty());
    let configured = match kind.as_deref() {
        // The lane's verdict on the saved URL, not "something is there".
        Some("searxng") => matches!(SearchConfig::from_settings(settings), SearchConfig::Searxng(_)),
        Some("ollama") => key_stored == Some(true),
        _ => false,
    };
    SearchState { kind, searxng_url, ollama_key_stored: key_stored, keyring: keyring_word(keyring), configured }
}

/// Read the keychain half of [`SearchState`]; blocking.
fn read_search_state(settings: &Settings) -> SearchState {
    let keyring = remote_credentials::keyring_state();
    let key_stored = (keyring == KeyringState::Unlocked).then(|| remote_credentials::has(&remote_credentials::web_search_account("ollama")));
    search_state(settings, keyring, key_stored)
}

fn cli_options(logins: &[crate::services::agent_auth::LoginStatus], ollama_ready: bool) -> Vec<CliOption> {
    AssistantCli::ALL
        .into_iter()
        .filter(|cli| assistant::is_offered(*cli))
        .map(|cli| {
            let installed = crate::commands::agents::binary_is_installed(cli.bin());
            let signed_in = (!cli.is_local()).then(|| {
                logins
                    .iter()
                    .find(|l| l.id == cli.bin())
                    .is_some_and(|l| l.signed_in || l.api_key || l.uses_admin_key)
            });
            let ready = installed && signed_in.unwrap_or(ollama_ready);
            let models = if cli == AssistantCli::Codex && installed {
                assistant::codex_offered_models(&crate::services::agent_home::scope_home(Some(storage::ASSISTANT_SCOPE)))
            } else {
                Vec::new()
            };
            CliOption {
                id: cli.id().to_string(),
                label: cli.label().to_string(),
                local: cli.is_local(),
                installed,
                signed_in,
                ready,
                models,
            }
        })
        .collect()
}

/// `assistant_options()` → the CLIs a chat may start with (with their login
/// state), the local models, the saved defaults and the search backend.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn assistant_options() -> Result<AssistantOptions, String> {
    gate(enabled_now())?;
    let logins = crate::commands::agents::agent_logins().await;
    app_core::rt::spawn_blocking(move || {
        let settings = storage::load_settings().unwrap_or_default();
        let (local_models, ollama_reachable) = match crate::commands::ollama::installed_model_names_within(
            std::time::Duration::from_secs(3),
        ) {
            Ok(models) => (models, true),
            Err(_) => (Vec::new(), false),
        };
        let ollama_ready = ollama_reachable && !local_models.is_empty();
        let defaults = settings.assistant_settings.as_ref();
        AssistantOptions {
            clis: cli_options(&logins, ollama_ready),
            local_models,
            ollama_reachable,
            default_cli: defaults.and_then(|a| a.default_cli.clone()),
            default_model: defaults.and_then(|a| a.default_model.clone()),
            search: read_search_state(&settings),
        }
    })
    .await
    .map_err(|_| "assistant_failed".to_string())
}

// ── assistant_new_chat ──────────────────────────────────────────────────────

/// The chat the command made.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewChat {
    /// The tab's id in the assistant scope's tab set.
    pub tab_id: String,
    /// The chat's uuid: the tab uid and the CLI session id.
    pub uid: String,
    /// The scope the tab lives in (`storage::ASSISTANT_SCOPE`).
    pub scope: &'static str,
    /// The version the scope's tab set moved to.
    pub version: u64,
}

/// Mint and store a chat in `session_path`: the record from
/// `assistant::new_chat_record`, appended through `workspace::create_tab_in`
/// (the path the phone's headless create takes). Nothing is written when the
/// service refuses.
fn new_chat_at(
    state_dir: &Path,
    session_path: &Path,
    cli: &str,
    model: Option<&str>,
) -> Result<NewChat, String> {
    let cli = AssistantCli::from_id(cli.trim())
        .filter(|cli| assistant::is_offered(*cli))
        .ok_or_else(|| refused(Refusal::NotOffered))?;
    let model = model.map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
    let launch = AssistantLaunch { cli, model };
    let uid = crate::commands::projects::uuid_v4();
    let record = assistant::new_chat_record(state_dir, &launch, &uid, None).map_err(refused)?;
    let created = crate::services::workspace::create_tab_in(session_path, storage::ASSISTANT_SCOPE, record, None)?;
    let tab_id = crate::services::workspace::tab_id(&created.tab)
        .ok_or_else(|| "the owner minted no tab id".to_string())?
        .to_string();
    let version = crate::services::workspace::snapshot_in(session_path)?.version;
    Ok(NewChat { tab_id, uid, scope: storage::ASSISTANT_SCOPE, version })
}

/// `assistant_new_chat({ cli, model? })` → `{ tabId, uid, scope, version }`.
/// `cli` is a `CliOption.id`; `model` is required for a local one. The tab is
/// stored in the assistant scope and announced with `workspace:patch`, so the
/// window mounts it as it does a phone-made tab.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn assistant_new_chat(ctx: Ctx, cli: String, model: Option<String>) -> Result<NewChat, String> {
    gate(enabled_now())?;
    crate::services::ai_switch::check()?;
    let chat = app_core::rt::spawn_blocking(move || {
        new_chat_at(
            &storage::state_dir(),
            &crate::services::terminal_service::state_session_path(storage::ASSISTANT_SCOPE),
            &cli,
            model.as_deref(),
        )
    })
    .await
    .map_err(|_| "assistant_failed".to_string())??;
    ctx.emit(
        WORKSPACE_PATCH_EVENT,
        serde_json::json!({
            "scope": chat.scope,
            "version": chat.version,
            "ops": [crate::services::workspace::Op::Created { id: chat.tab_id.clone() }],
        }),
    );
    Ok(chat)
}

// ── assistant_set_search ────────────────────────────────────────────────────

/// What `assistant_set_search` answers: the backend's new state, and the
/// settings as written so the caller can broadcast them as any other
/// settings write.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSaved {
    pub search: SearchState,
    pub settings: Settings,
}

/// A SearXNG base URL, normalised: the lane's own validator
/// ([`web_lane::validate_searxng_url`]), so what is saved is what `web_search`
/// will use.
fn validate_searxng_url(raw: &str) -> Result<String, String> {
    web_lane::validate_searxng_url(raw).map(|url| url.to_string()).ok_or_else(|| "invalid_url".to_string())
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.len() > MAX_KEY_LEN || key.chars().any(char::is_control) {
        return Err("invalid_key".to_string());
    }
    Ok(())
}

/// The part of [`assistant_set_search`] that is testable: validate, write the
/// key through `write_key`, then patch `settings_path`. `key_readable` and
/// `key_stored` describe the keychain for the "ollama needs a key" check.
fn set_search_at(
    settings_path: &Path,
    kind: &str,
    url: Option<&str>,
    key: Option<&str>,
    key_readable: bool,
    key_stored: impl FnOnce() -> bool,
    write_key: impl FnOnce(Option<&str>) -> Result<(), String>,
) -> Result<Settings, String> {
    let kind = kind.trim();
    if !matches!(kind, "searxng" | "ollama" | "none") {
        return Err("invalid_kind".to_string());
    }
    let url = match (kind, url.map(str::trim).filter(|u| !u.is_empty())) {
        ("searxng", Some(u)) => Some(validate_searxng_url(u)?),
        ("searxng", None) => return Err("url_required".to_string()),
        (_, Some(u)) => Some(validate_searxng_url(u)?),
        (_, None) => None,
    };
    let key = key.map(str::trim);
    if let Some(key) = key {
        validate_key(key)?;
    }
    let clearing = key == Some("");
    if kind == "ollama" && !clearing && key.is_none() && key_readable && !key_stored() {
        return Err("key_required".to_string());
    }
    if kind == "ollama" && clearing {
        return Err("key_required".to_string());
    }
    // Keychain first: a settings write that follows a failed key write would
    // name a backend with no key. A key written before a failed settings
    // write is harmless (unused until a kind names it).
    if let Some(key) = key {
        write_key(Some(key).filter(|k| !k.is_empty()))?;
    }
    storage::patch_json(settings_path, Settings::default(), |settings| {
        let block = settings.assistant_settings.get_or_insert_with(Default::default);
        let search = block.search.get_or_insert_with(AssistantSearchSettings::default);
        search.kind = (kind != "none").then(|| kind.to_string());
        if let Some(url) = url {
            search.searxng_url = Some(url);
        }
        settings.rev += 1;
        Ok(settings.clone())
    })
}

/// `assistant_set_search({ kind, url?, key? })` → `{ search, settings }`.
/// `kind` is `"searxng"` (needs `url`), `"ollama"` (needs a stored or given
/// `key`) or `"none"`. `url` is `http`/`https` without userinfo. `key` goes to
/// the keychain and is never returned or written to `settings.json`; an empty
/// `key` removes the stored one (then `kind` may not be `"ollama"`). Errors
/// are wire codes: `invalid_kind`, `invalid_url`, `url_required`,
/// `invalid_key`, `key_required`, or the keychain's own text.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn assistant_set_search(kind: String, url: Option<String>, key: Option<String>) -> Result<SearchSaved, String> {
    gate(enabled_now())?;
    app_core::rt::spawn_blocking(move || {
        let keyring = remote_credentials::keyring_state();
        let settings = set_search_at(
            &storage::settings_path(),
            &kind,
            url.as_deref(),
            key.as_deref(),
            keyring == KeyringState::Unlocked,
            || remote_credentials::has(&remote_credentials::web_search_account("ollama")),
            |secret| remote_credentials::set(&remote_credentials::web_search_account("ollama"), secret),
        )?;
        let search = read_search_state(&settings);
        Ok(SearchSaved { search, settings })
    })
    .await
    .map_err(|_| "assistant_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn settings_with(json: &str) -> Settings {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn the_flag_gates_every_command() {
        assert_eq!(gate(false), Err(OFF.to_string()));
        assert_eq!(gate(true), Ok(()));
        // An absent settings block is off.
        assert!(!Settings::default().assistant_enabled());
    }

    #[test]
    fn a_new_chat_refuses_what_the_service_refuses_and_stores_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("sessions").join("assistant").join("terminals.json");
        // Not a CLI id at all.
        let err = new_chat_at(dir.path(), &session, "gemini", None).unwrap_err();
        assert!(err.starts_with("not_offered: "), "{err}");
        // Nothing was stored for either refusal.
        assert!(!session.exists(), "a refused chat wrote {session:?}");
        // A local CLI without a model is the service's `model_required`.
        let err = new_chat_at(dir.path(), &session, "opencode_local", Some("  ")).unwrap_err();
        assert!(err.starts_with("model_required: "), "{err}");
        assert!(!session.exists());
    }

    /// The happy path (S1a is built): a cloud CLI needs no model, a tab lands
    /// in the assistant scope's file with the launch block, the uid as its
    /// session id and its own chat folder as cwd, and the answer names that tab.
    #[test]
    fn a_new_chat_stores_one_assistant_tab_and_answers_with_its_ids() {
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("sessions").join("assistant").join("terminals.json");
        let chat = new_chat_at(dir.path(), &session, " claude ", None).unwrap();
        assert_eq!(chat.scope, "assistant");
        assert!(crate::services::agent_session::is_uuid_shaped(&chat.uid), "{}", chat.uid);
        assert!(chat.version > 0);
        let snapshot = crate::services::workspace::snapshot_in(&session).unwrap();
        assert_eq!(snapshot.version, chat.version);
        // project-tree-read: ok — the assistant scope's own session, not a project tree
        let [tab] = snapshot.session.tab_layout.as_slice() else { panic!("one tab expected") };
        assert_eq!(crate::services::workspace::tab_id(tab), Some(chat.tab_id.as_str()));
        assert_eq!(tab.session_id.as_deref(), Some(chat.uid.as_str()));
        assert_eq!(tab.extra["kind"], "agent");
        assert_eq!(tab.cwd, assistant::chat_dir(dir.path(), &chat.uid).unwrap().to_string_lossy());
        assert_eq!(assistant::record_launch(tab), Some(AssistantLaunch { cli: AssistantCli::Claude, model: None }));
        // The command creates no folder: the spawn gate is the one creator.
        assert!(!assistant::chat_dir(dir.path(), &chat.uid).unwrap().exists());
        // A second chat is a second tab with its own uid.
        let other = new_chat_at(dir.path(), &session, "claude", None).unwrap();
        assert_ne!((&other.uid, &other.tab_id), (&chat.uid, &chat.tab_id));
        // project-tree-read: ok — the assistant scope's own session, not a project tree
        assert_eq!(crate::services::workspace::snapshot_in(&session).unwrap().session.tab_layout.len(), 2);
    }

    #[test]
    fn search_state_reads_an_absent_block_and_unknown_kinds_as_none() {
        let none = search_state(&Settings::default(), KeyringState::Unlocked, Some(false));
        assert_eq!(none.kind, None);
        assert!(!none.configured);
        let odd = settings_with(r#"{"assistant_settings":{"search":{"kind":"bing"}}}"#);
        assert_eq!(search_state(&odd, KeyringState::Unlocked, Some(true)).kind, None);
        let searx = settings_with(r#"{"assistant_settings":{"search":{"kind":"searxng","searxng_url":"http://localhost:8080/"}}}"#);
        assert!(search_state(&searx, KeyringState::Unlocked, Some(false)).configured);
        let ollama = settings_with(r#"{"assistant_settings":{"search":{"kind":"ollama"}}}"#);
        assert!(search_state(&ollama, KeyringState::Unlocked, Some(true)).configured);
        assert!(!search_state(&ollama, KeyringState::Unlocked, Some(false)).configured);
        // An unreadable keychain answers "unknown", never "no key".
        let locked = search_state(&ollama, KeyringState::Locked, None);
        assert_eq!((locked.ollama_key_stored, locked.keyring, locked.configured), (None, "locked", false));
    }

    #[test]
    fn a_searxng_url_is_http_or_https_with_no_userinfo() {
        assert_eq!(validate_searxng_url(" http://localhost:8080 ").unwrap(), "http://localhost:8080/");
        assert!(validate_searxng_url("https://search.example.org/path").is_ok());
        for bad in [
            "",
            "ftp://x.example",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://user@host.example",
            "http://user:pw@host.example",
            "https://host.example/#frag",
            "http://",
            "not a url",
            "http://host.example/\nx",
        ] {
            assert_eq!(validate_searxng_url(bad), Err("invalid_url".to_string()), "{bad:?}");
        }
    }

    /// The setter and `web_search` share one validator: whatever the setter
    /// stores, the lane reads back as a usable URL (never a silent `Unset`),
    /// and `assistant_options` reports the lane's verdict.
    #[test]
    fn what_the_setter_accepts_the_lane_reads_back() {
        let long_path = format!("https://s.example.org/{}", "a".repeat(600));
        let long_ok = format!("https://s.example.org/{}", "a".repeat(400));
        for rejected in ["https://s.example.org/?language=de", "http://localhost:8080/?x=1", long_path.as_str()] {
            assert_eq!(validate_searxng_url(rejected), Err("invalid_url".to_string()), "{rejected:.40}");
        }
        // A path that percent-encodes past the cap when normalised is refused too.
        let widening = format!("https://s.example.org/{}", "é".repeat(200));
        assert_eq!(validate_searxng_url(&widening), Err("invalid_url".to_string()));
        for accepted in ["http://localhost:8080", " https://s.example.org/searx ", "http://[::1]:8888/", "http://192.168.1.5/", long_ok.as_str()] { // privacy-check: ok — address literal in a URL-validator test
            let stored = validate_searxng_url(accepted).unwrap();
            assert!(web_lane::validate_searxng_url(&stored).is_some(), "{stored:.60}");
            let settings = settings_with(&format!(r#"{{"assistant_settings":{{"search":{{"kind":"searxng","searxng_url":"{stored}"}}}}}}"#));
            assert!(matches!(SearchConfig::from_settings(&settings), SearchConfig::Searxng(_)), "{stored:.60}");
            assert!(search_state(&settings, KeyringState::Unlocked, None).configured);
        }
        // A saved URL the lane would not use is not "configured".
        let stale = settings_with(r#"{"assistant_settings":{"search":{"kind":"searxng","searxng_url":"http://localhost:8080/?x=1"}}}"#);
        assert_eq!(SearchConfig::from_settings(&stale), SearchConfig::Unset);
        assert!(!search_state(&stale, KeyringState::Unlocked, None).configured);
    }

    fn set(
        path: &Path,
        kind: &str,
        url: Option<&str>,
        key: Option<&str>,
        stored: bool,
        written: &RefCell<Vec<Option<String>>>,
    ) -> Result<Settings, String> {
        set_search_at(path, kind, url, key, true, || stored, |k| {
            written.borrow_mut().push(k.map(str::to_string));
            Ok(())
        })
    }

    #[test]
    fn set_search_stores_the_url_in_settings_and_the_key_only_in_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let written = RefCell::new(Vec::new());
        // From no file at all: the block appears, nothing else.
        let saved = set(&path, "ollama", None, Some(" sk-secret "), false, &written).unwrap();
        assert_eq!(written.borrow().as_slice(), [Some("sk-secret".to_string())]);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("sk-secret"), "{raw}");
        assert_eq!(saved.assistant_settings.unwrap().search.unwrap().kind.as_deref(), Some("ollama"));
        assert_eq!(saved.rev, 1);
        // SearXNG with a URL; the earlier kind is replaced, the key untouched.
        let saved = set(&path, "searxng", Some("https://s.example.org"), None, true, &written).unwrap();
        let search = saved.assistant_settings.unwrap().search.unwrap();
        assert_eq!((search.kind.as_deref(), search.searxng_url.as_deref()), (Some("searxng"), Some("https://s.example.org/")));
        assert_eq!(written.borrow().len(), 1);
        // "none" clears the kind and keeps the URL.
        let saved = set(&path, "none", None, None, true, &written).unwrap();
        let search = saved.assistant_settings.unwrap().search.unwrap();
        assert_eq!((search.kind, search.searxng_url.as_deref()), (None, Some("https://s.example.org/")));
    }

    #[test]
    fn set_search_refuses_bad_input_before_it_writes_anything() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let written = RefCell::new(Vec::new());
        let code = |r: Result<Settings, String>| r.unwrap_err();
        assert_eq!(code(set(&path, "bing", None, None, true, &written)), "invalid_kind");
        assert_eq!(code(set(&path, "searxng", None, None, true, &written)), "url_required");
        assert_eq!(code(set(&path, "searxng", Some("http://u:p@h.example"), None, true, &written)), "invalid_url");
        assert_eq!(code(set(&path, "ollama", None, None, false, &written)), "key_required");
        assert_eq!(code(set(&path, "ollama", None, Some(""), true, &written)), "key_required");
        assert_eq!(code(set(&path, "none", None, Some("bad\nkey"), true, &written)), "invalid_key");
        assert_eq!(code(set(&path, "none", None, Some(&"k".repeat(MAX_KEY_LEN + 1)), true, &written)), "invalid_key");
        assert!(written.borrow().is_empty());
        assert!(!path.exists());
        // A failed keychain write leaves the settings alone.
        let failed = set_search_at(&path, "ollama", None, Some("k"), true, || false, |_| Err("locked".to_string()));
        assert_eq!(failed.unwrap_err(), "locked");
        assert!(!path.exists());
        // An empty key removes the stored one when no key is needed.
        set(&path, "none", None, Some(""), true, &written).unwrap();
        assert_eq!(written.borrow().as_slice(), [None]);
    }

    #[test]
    fn set_search_keeps_keys_a_newer_build_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"assistant":true,"assistant_settings":{"default_cli":"claude","future":1,"search":{"future":2}}}"#,
        )
        .unwrap();
        let written = RefCell::new(Vec::new());
        set(&path, "searxng", Some("http://localhost:8080"), None, true, &written).unwrap();
        let back: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back["assistant"], true);
        assert_eq!(back["assistant_settings"]["default_cli"], "claude");
        assert_eq!(back["assistant_settings"]["future"], 1);
        assert_eq!(back["assistant_settings"]["search"]["future"], 2);
        assert_eq!(back["assistant_settings"]["search"]["searxng_url"], "http://localhost:8080/");
    }

    #[test]
    fn the_options_list_only_offered_clis_and_never_a_login_without_one() {
        let login = |id: &str, signed_in: bool| crate::services::agent_auth::LoginStatus {
            id: id.to_string(),
            signed_in,
            account: None,
            importable: false,
            blocked: None,
            shared: true,
            admin_key_capable: false,
            admin_key_offered: false,
            uses_admin_key: false,
            api_key: false,
            api_budget_reached: false,
            api_key_saved: false,
        };
        let options = cli_options(&[login("claude", true), login("codex", false)], true);
        let ids: Vec<&str> = options.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, ["claude", "codex", "opencode_local", "claude_local"]);
        let claude = &options[0];
        assert_eq!(claude.signed_in, Some(true));
        assert_eq!(claude.ready, claude.installed);
        assert_eq!(options[1].signed_in, Some(false));
        assert!(!options[1].ready);
        assert!(options[2].local && options[2].signed_in.is_none());
        let no_ollama = cli_options(&[], false);
        assert!(no_ollama.iter().filter(|o| o.local).all(|o| !o.ready));
    }
}
