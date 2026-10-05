//! GitHub Copilot CLI sign-in for **fenced** tabs (Linux).
//!
//! Copilot keeps its GitHub token in the OS keyring, which it reaches over the
//! D-Bus session bus. The fence hides that bus, and the keyring with it
//! (`docs/context/agent_authority.md`), so a fenced Copilot reported "System
//! vault not available" and offered to write the token into
//! `~/.copilot/config.json` as plain text — inside the fence's throwaway home,
//! which is gone at the next respawn. Every fenced tab asked for a new login.
//!
//! Tabtivity runs outside the fence, so it keeps the token instead, in its **own**
//! keyring entry, and hands it to every fenced Copilot as [`TOKEN_ENV`], which
//! Copilot reads before any stored login:
//!
//! 1. Each scope's Copilot home is `~/.copilot` of its Tabtivity-owned agent home
//!    (`services::agent_home`), never the user's own: a fenced Copilot must not plant trusted folders, hooks or MCP
//!    servers that the host's uncontained Copilot would honour, nor reach
//!    another project's copy. Its `settings.json` turns on Copilot's own
//!    `storeTokenPlaintext`, so the vault question does not come up at all.
//! 2. The user signs in once with `/login` in any fenced tab. Copilot writes the
//!    token into that scope's `config.json`; the keeper ([`start`]) moves it into
//!    the keyring and deletes it from the file within seconds.
//! 3. Every later fenced Copilot spawn gets the keyring token in its
//!    environment ([`inject_env`]). Nothing holds it on disk.
//!
//! **Adoption rule.** A fenced Copilot is steerable by the project it works on
//! and can write any token into its own config. A harvested token therefore
//! replaces a stored one only once the stored one no longer authenticates at
//! GitHub; otherwise one poisoned project could sign every other project's
//! Copilot into an attacker's account. Switching accounts on purpose is
//! Settings → Sign out, then `/login` again.
//!
//! **Layout** checked against Copilot CLI 0.0.393 (JS bundle: `copilot_tokens`
//! keyed `"<host>:<login>"`, `store_token_plaintext`, `last_logged_in_user`) and
//! 1.0.88 (native runtime: the camelCase `copilotTokens`, `storeTokenPlaintext`,
//! `lastLoggedInUser`; later 1.0.88 runtimes renamed the token map
//! `authTokens`). Every spelling is read. If a release moves the token, nothing
//! breaks: the tab asks for a login again, as it did before this.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::services::home_io::HomeFile;

/// The variable Copilot reads before `GH_TOKEN`, `GITHUB_TOKEN` and its own
/// stored logins.
pub const TOKEN_ENV: &str = "COPILOT_GITHUB_TOKEN";
/// Variables that already choose a Copilot account; any of them set by the user
/// wins over the injected token.
const USER_TOKEN_ENVS: &[&str] = &[TOKEN_ENV, "GH_TOKEN", "GITHUB_TOKEN"];
/// Keyring account under `remote_credentials`' service, which already carries
/// the locked-keyring handling every read here needs.
const ACCOUNT: &str = "agent-token:copilot";
const POLL: Duration = Duration::from_secs(3);
const TOKEN_KEYS: &[&str] = &["authTokens", "copilotTokens", "copilot_tokens"];
const LAST_USER_KEYS: &[&str] = &["lastLoggedInUser", "last_logged_in_user"];
const PLAINTEXT_SETTING: &str = "storeTokenPlaintext";

/// The scope's Copilot home: `~/.copilot` of its Tabtivity-owned agent home
/// (`services::agent_home`), which the fence mounts as the tab's `$HOME`.
fn home_in(state_dir: &Path, scope_id: &str) -> PathBuf {
    crate::services::agent_home::scope_home_in(state_dir, scope_id).join(".copilot")
}

/// Create (or reuse) the scope's private Copilot home and return it, ready to
/// be mounted at `~/.copilot`.
pub(crate) fn prepare_home(scope_id: &str) -> PathBuf {
    prepare_home_in(&crate::storage::state_dir(), scope_id)
}

fn prepare_home_in(state_dir: &Path, scope_id: &str) -> PathBuf {
    let dir = home_in(state_dir, scope_id);
    // Through a directory handle (`home_io`): the home is the agent's and
    // this runs unfenced.
    let settings = dir
        .parent()
        .and_then(|home| HomeFile::open(home, ".copilot/settings.json"));
    if let Some(settings) = settings {
        let _ = settings.dir().set_private();
        ensure_plaintext_setting(&settings);
    }
    dir
}

/// Copilot's config files may open with `//` comment lines ("This file is
/// managed automatically"). Returns the comment header and the parsed body.
fn parse_jsonc(text: &str) -> Option<(String, Value)> {
    let mut header = String::new();
    let mut body = String::new();
    let mut in_header = true;
    for line in text.lines() {
        if line.trim_start().starts_with("//") {
            if in_header {
                header.push_str(line);
                header.push('\n');
            }
            continue;
        }
        if !line.trim().is_empty() {
            in_header = false;
        }
        body.push_str(line);
        body.push('\n');
    }
    let value = if body.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(&body).ok()?
    };
    Some((header, value))
}

/// Write by temp file + rename in the same directory, relative to its handle:
/// Copilot may read the file at any moment and must never see half of it.
fn write_private(file: &HomeFile, header: &str, value: &Value) -> std::io::Result<()> {
    let body = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    file.write(format!("{header}{body}\n").as_bytes())
}

/// Turn on Copilot's own plain-text token storage in the scope's settings, so
/// a `/login` inside the fence stores the token where [`start`] can collect it
/// instead of stopping at the vault question. A file that does not parse is left
/// alone: the user then sees the question once, and "Yes" works just as well.
fn ensure_plaintext_setting(file: &HomeFile) {
    let (header, mut value) = match file.read().and_then(|bytes| String::from_utf8(bytes).ok()) {
        Some(text) => match parse_jsonc(&text) {
            Some(parsed) => parsed,
            None => return,
        },
        None if !file.exists() => (String::new(), Value::Object(Map::new())),
        None => return,
    };
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    if obj.get(PLAINTEXT_SETTING) == Some(&Value::Bool(true)) {
        return;
    }
    obj.insert(PLAINTEXT_SETTING.into(), Value::Bool(true));
    if let Err(e) = write_private(file, &header, &value) {
        eprintln!("copilot_auth: settings {}: {e}", file.path().display());
    }
}

/// A GitHub token of a kind Copilot accepts: OAuth (`gho_`), app user
/// (`ghu_`) or fine-grained PAT (`github_pat_`). Classic PATs are refused by
/// Copilot itself. The shape check also keeps anything odd out of an env value.
fn token_shape_ok(token: &str) -> bool {
    let rest = ["gho_", "ghu_", "github_pat_"]
        .iter()
        .find_map(|p| token.strip_prefix(p));
    rest.is_some_and(|r| {
        (16..=400).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    })
}

/// The token the config's last signed-in user logged in with, else the first
/// well-formed one.
fn preferred_token(config: &Value) -> Option<String> {
    let tokens: Vec<(&str, &str)> = TOKEN_KEYS
        .iter()
        .filter_map(|k| config.get(k)?.as_object())
        .flat_map(|m| m.iter().filter_map(|(k, v)| Some((k.as_str(), v.as_str()?.trim()))))
        .filter(|(_, t)| token_shape_ok(t))
        .collect();
    let last = LAST_USER_KEYS.iter().find_map(|k| {
        let user = config.get(k)?;
        Some(format!("{}:{}", user.get("host")?.as_str()?, user.get("login")?.as_str()?))
    });
    last.and_then(|key| tokens.iter().find(|(k, _)| *k == key))
        .or_else(|| tokens.first())
        .map(|(_, t)| t.to_string())
}

/// Remove every stored token from the config, keeping the rest of it (the
/// logged-in user list included) as Copilot wrote it.
fn strip_tokens(file: &HomeFile, header: &str, mut config: Value) -> std::io::Result<()> {
    if let Some(obj) = config.as_object_mut() {
        for key in TOKEN_KEYS {
            obj.remove(*key);
        }
    }
    write_private(file, header, &config)
}

/// The adoption rule of the module docs. `stored_still_valid` is asked only
/// when a different token is already stored; `None` (GitHub unreachable) keeps
/// the stored one.
fn should_adopt(
    stored: Option<&str>,
    found: &str,
    signed_out: &HashSet<String>,
    stored_still_valid: impl FnOnce(&str) -> Option<bool>,
) -> bool {
    if signed_out.contains(found) {
        return false;
    }
    match stored {
        None => true,
        Some(s) if s == found => false,
        Some(s) => stored_still_valid(s) == Some(false),
    }
}

/// Tokens the user signed out of this run. A tab still running on one may
/// rewrite its config with it; that must not sign the user straight back in.
fn signed_out() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

fn stored_token() -> Option<String> {
    crate::services::remote_credentials::get(ACCOUNT).filter(|t| token_shape_ok(t))
}

/// Give a fenced Copilot spawn the stored token. A token the user set up
/// themselves (in Tabtivity's environment or the tab's) is left to win.
pub(crate) fn inject_env(env: &mut HashMap<String, String>) {
    let user_set = USER_TOKEN_ENVS
        .iter()
        .any(|k| env.contains_key(*k) || std::env::var_os(k).is_some_and(|v| !v.is_empty()));
    if user_set {
        return;
    }
    if let Some(token) = stored_token() {
        env.insert(TOKEN_ENV.into(), token);
    }
}

fn client() -> Result<reqwest::Client, String> {
    // `reqwest` is built with `rustls-no-provider`; see `app_update::client`.
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        .user_agent(crate::brand::user_agent())
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// The GitHub login `token` belongs to: `Ok(None)` when GitHub rejects it,
/// `Err` when GitHub could not be asked.
async fn github_login(token: &str) -> Result<Option<String>, String> {
    let response = client()?
        .get("https://api.github.com/user")
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    match response.status().as_u16() {
        200 => {
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            let body: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            Ok(body.get("login").and_then(Value::as_str).map(str::to_string))
        }
        401 => Ok(None),
        code => Err(format!("GitHub answered {code}")),
    }
}

/// One config file: adopt its token if the rule allows, then delete every
/// token from it. A keyring write that fails (a locked keyring) keeps the file
/// as it is, so the next pass can try again rather than lose the login. A file
/// whose tokens are none of the shapes Copilot accepts is left alone too: the
/// token may be one a newer Copilot mints, and stripping it would sign that
/// scope out with nothing kept in its place.
/// Returns whether the file was settled (and needs no retry).
fn process_config(file: &HomeFile) -> bool {
    let Some(text) = file.read().and_then(|bytes| String::from_utf8(bytes).ok()) else {
        return true;
    };
    let Some((header, config)) = parse_jsonc(&text) else {
        return true;
    };
    let Some(found) = preferred_token(&config) else {
        return true;
    };
    let stored = stored_token();
    let refused = signed_out().lock().unwrap_or_else(|e| e.into_inner()).clone();
    let adopt = should_adopt(stored.as_deref(), &found, &refused, |s| {
        tauri::async_runtime::block_on(github_login(s)).ok().map(|login| login.is_some())
    });
    if adopt {
        if let Err(e) = crate::services::remote_credentials::set(ACCOUNT, Some(&found)) {
            eprintln!("copilot_auth: keep sign-in: {e}");
            return false;
        }
    } else if stored.as_deref() != Some(found.as_str()) {
        eprintln!(
            "copilot_auth: {} holds a different Copilot sign-in; kept the stored one",
            file.path().display()
        );
    }
    if let Err(e) = strip_tokens(file, &header, config) {
        eprintln!("copilot_auth: clear {}: {e}", file.path().display());
        return false;
    }
    true
}

/// The regular file's modification time, read off the opened inode.
fn modified(file: &HomeFile) -> Option<SystemTime> {
    file.open_read()?.metadata().ok()?.modified().ok()
}

/// One pass over every scope's `config.json`, skipping files unchanged since
/// they were last settled.
fn sweep(state_dir: &Path, seen: &mut HashMap<PathBuf, SystemTime>) {
    for home in crate::services::agent_home::existing_homes_in(state_dir) {
        let Some(config) = HomeFile::open_existing(&home, ".copilot/config.json") else {
            continue;
        };
        let Some(mtime) = modified(&config) else {
            continue;
        };
        let key = config.path();
        if seen.get(&key) == Some(&mtime) {
            continue;
        }
        if process_config(&config) {
            // Our own rewrite moved the mtime; record that one, not the old.
            let settled = modified(&config).unwrap_or(mtime);
            seen.insert(key, settled);
        }
    }
}

/// Start the keeper: one detached thread polling the scopes' configs. It
/// holds no lock between passes and dies with the process.
pub fn start() {
    if let Err(e) = std::thread::Builder::new().name("copilot-auth".into()).spawn(|| {
        let state_dir = crate::storage::state_dir();
        let mut seen = HashMap::new();
        loop {
            sweep(&state_dir, &mut seen);
            std::thread::sleep(POLL);
        }
    }) {
        eprintln!("copilot_auth: spawn keeper: {e}");
    }
}

/// What the Settings row shows. The token itself never leaves the backend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotFenceAuth {
    /// Only the Linux fence hides the keyring; elsewhere there is nothing to do.
    pub supported: bool,
    pub signed_in: bool,
    /// The GitHub login, when GitHub could be asked.
    pub login: Option<String>,
    /// `Some(false)`: GitHub rejects the stored token (sign out and log in
    /// again). `None`: not signed in, or GitHub unreachable.
    pub valid: Option<bool>,
}

pub async fn status() -> CopilotFenceAuth {
    let supported = cfg!(target_os = "linux");
    let token = if supported {
        tauri::async_runtime::spawn_blocking(stored_token).await.ok().flatten()
    } else {
        None
    };
    let Some(token) = token else {
        return CopilotFenceAuth { supported, signed_in: false, login: None, valid: None };
    };
    let (login, valid) = match github_login(&token).await {
        Ok(Some(login)) => (Some(login), Some(true)),
        Ok(None) => (None, Some(false)),
        Err(_) => (None, None),
    };
    CopilotFenceAuth { supported, signed_in: true, login, valid }
}

/// Forget the stored token. Running tabs keep the session they have; new
/// fenced tabs start signed out until the next `/login`.
pub fn sign_out() -> Result<(), String> {
    let old = crate::services::remote_credentials::get(ACCOUNT);
    crate::services::remote_credentials::set(ACCOUNT, None)?;
    if let Some(old) = old {
        signed_out().lock().unwrap_or_else(|e| e.into_inner()).insert(old);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_A: &str = "gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // privacy-check: ok — fake test token
    const TOKEN_B: &str = "gho_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // privacy-check: ok — fake test token

    #[test]
    fn token_shapes_copilot_accepts_pass_and_others_do_not() {
        assert!(token_shape_ok(TOKEN_A));
        assert!(token_shape_ok("github_pat_11ABCDEFG0123456789_abcdefghijklmnop")); // privacy-check: ok — fake test token
        assert!(token_shape_ok("ghu_0123456789abcdef0123")); // privacy-check: ok — fake test token
        assert!(!token_shape_ok("ghp_0123456789abcdef0123456789")); // privacy-check: ok — fake test token
        assert!(!token_shape_ok("gho_short"));
        assert!(!token_shape_ok("gho_aaaaaaaaaaaaaaaaaaaa;rm -rf")); // privacy-check: ok — fake test token
        assert!(!token_shape_ok(""));
    }

    #[test]
    fn comment_header_survives_and_the_body_parses() {
        let text = "// User settings belong in settings.json.\n// This file is managed automatically.\n{\n  \"a\": 1\n}\n";
        let (header, value) = parse_jsonc(text).unwrap();
        assert_eq!(header, "// User settings belong in settings.json.\n// This file is managed automatically.\n");
        assert_eq!(value["a"], 1);
        assert_eq!(parse_jsonc("").unwrap().1, serde_json::json!({}));
        assert!(parse_jsonc("{ not json").is_none());
    }

    #[test]
    fn the_last_users_token_wins_in_either_spelling() {
        let camel = serde_json::json!({
            "copilotTokens": {"https://github.com:alice": TOKEN_A, "https://github.com:bob": TOKEN_B},
            "lastLoggedInUser": {"host": "https://github.com", "login": "bob"}
        });
        assert_eq!(preferred_token(&camel).as_deref(), Some(TOKEN_B));
        let snake = serde_json::json!({
            "copilot_tokens": {"https://github.com:alice": TOKEN_A}
        });
        assert_eq!(preferred_token(&snake).as_deref(), Some(TOKEN_A));
        let junk = serde_json::json!({"copilotTokens": {"x": "ghp_classicclassicclassic"}}); // privacy-check: ok — fake test token
        assert_eq!(preferred_token(&junk), None);
        // Later 1.0.88 runtimes: `authTokens`.
        let renamed = serde_json::json!({
            "authTokens": {"https://github.com:alice": TOKEN_A},
            "lastLoggedInUser": {"host": "https://github.com", "login": "alice"}
        });
        assert_eq!(preferred_token(&renamed).as_deref(), Some(TOKEN_A));
    }

    #[test]
    fn a_stored_sign_in_is_replaced_only_once_github_rejects_it() {
        let none = HashSet::new();
        // Nothing stored: the first sign-in is kept, GitHub never asked.
        assert!(should_adopt(None, TOKEN_A, &none, |_| panic!("not asked")));
        // Same token: nothing to do.
        assert!(!should_adopt(Some(TOKEN_A), TOKEN_A, &none, |_| panic!("not asked")));
        // A different token while the stored one still works: kept.
        assert!(!should_adopt(Some(TOKEN_A), TOKEN_B, &none, |_| Some(true)));
        // GitHub unreachable: kept.
        assert!(!should_adopt(Some(TOKEN_A), TOKEN_B, &none, |_| None));
        // The stored one was revoked or expired: the new sign-in replaces it.
        assert!(should_adopt(Some(TOKEN_A), TOKEN_B, &none, |_| Some(false)));
        // A token signed out of this run never comes back.
        let out: HashSet<String> = [TOKEN_A.to_string()].into();
        assert!(!should_adopt(None, TOKEN_A, &out, |_| panic!("not asked")));
    }

    #[test]
    #[cfg(unix)]
    fn a_planted_temporary_link_cannot_redirect_a_copilot_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let victim = dir.path().join("victim");
        std::fs::write(&victim, "keep").unwrap();
        let planted = path.with_extension(format!(concat!(crate::app_slug!(), "-{}.tmp"), std::process::id()));
        std::os::unix::fs::symlink(&victim, planted).unwrap();
        let file = HomeFile::open(dir.path(), "config.json").unwrap();
        write_private(&file, "", &serde_json::json!({"model": "x"})).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert!(std::fs::symlink_metadata(&path).unwrap().is_file());
    }

    #[test]
    #[cfg(unix)]
    fn preparing_a_copilot_home_refuses_a_directory_link() {
        let state = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let dir = home_in(state.path(), "scope");
        std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(outside.path(), &dir).unwrap();
        prepare_home_in(state.path(), "scope");
        assert!(!outside.path().join("settings.json").exists());
    }

    #[test]
    fn stripping_removes_only_the_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let config = serde_json::json!({
            "authTokens": {"https://github.com:alice": TOKEN_A},
            "copilotTokens": {"https://github.com:alice": TOKEN_A},
            "copilot_tokens": {"https://github.com:alice": TOKEN_A},
            "loggedInUsers": [{"host": "https://github.com", "login": "alice"}],
        });
        strip_tokens(&HomeFile::open(dir.path(), "config.json").unwrap(), "// managed\n", config).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("// managed\n"));
        assert!(!text.contains(TOKEN_A));
        let (_, value) = parse_jsonc(&text).unwrap();
        assert_eq!(value["loggedInUsers"][0]["login"], "alice");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn a_token_of_an_unknown_shape_is_left_where_copilot_put_it() {
        let dir = tempfile::tempdir().unwrap();
        let text = "{\n  \"authTokens\": {\"https://github.com:alice\": \"xyz_notashapewetake\"}\n}\n";
        std::fs::write(dir.path().join("config.json"), text).unwrap();
        assert!(process_config(&HomeFile::open(dir.path(), "config.json").unwrap()));
        assert_eq!(std::fs::read_to_string(dir.path().join("config.json")).unwrap(), text);
    }

    #[test]
    fn a_scope_home_turns_on_plaintext_storage_and_keeps_user_settings() {
        let state = tempfile::tempdir().unwrap();
        let home = prepare_home_in(state.path(), "proj/1");
        assert!(home.starts_with(state.path().join(crate::services::agent_home::HOMES_DIR)));
        assert!(home.ends_with(".copilot"));
        let (_, settings) = parse_jsonc(&std::fs::read_to_string(home.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings[PLAINTEXT_SETTING], true);

        std::fs::write(home.join("settings.json"), "{\"model\": \"x\", \"storeTokenPlaintext\": false}").unwrap();
        prepare_home_in(state.path(), "proj/1");
        let (_, settings) = parse_jsonc(&std::fs::read_to_string(home.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings[PLAINTEXT_SETTING], true);
        assert_eq!(settings["model"], "x");

        // Unparseable: left exactly as it is.
        std::fs::write(home.join("settings.json"), "{ broken").unwrap();
        prepare_home_in(state.path(), "proj/1");
        assert_eq!(std::fs::read_to_string(home.join("settings.json")).unwrap(), "{ broken");

        // Scopes never share a home.
        assert_ne!(prepare_home_in(state.path(), "other"), home);
    }
}
