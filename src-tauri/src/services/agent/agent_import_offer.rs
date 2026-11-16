//! The first-start question: may Tabtivity copy this computer's agent logins
//! and agent config?
//!
//! A first start used to copy both without asking (`agent_auth::import_once`,
//! `agent_global::import_once`). That was written for the upgrade to
//! per-scope homes, where it only kept what the user already had in Tabtivity.
//! On a fresh install it is a copy of the user's credentials, and of hooks and
//! MCP servers that run code, that nobody asked for. So a fresh install is
//! asked once, on a page of the first-run wizard: [`startup_in`] leaves a
//! pending marker in place of the import, [`offer_in`] says what was found
//! and [`answer_in`] imports what the user ticked. Either answer closes the
//! question for good; the Settings import buttons stay the way back.
//!
//! An install that ran before keeps the silent import: it has nothing to be
//! asked about, its agents were signed in already. The pending marker, once
//! written, outranks every sign of an earlier run, so a fresh install that
//! opened a tab before answering is never taken for an upgrade.
//! AppHandle-free.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::services::{agent_auth, agent_global, agent_home};
use crate::storage;

/// Present while the question is open. Nothing is imported while it is.
const PENDING_MARKER: &str = ".agent_import_offer";

/// State folders only an older build made.
const LEGACY_STORES: &[&str] = &["agent-creds", "codex-state", "copilot-home"];

fn pending_in(state_dir: &Path) -> bool {
    state_dir.join(PENDING_MARKER).exists()
}

/// Whether `state_dir` shows a run before this one: either import marker, an
/// agent home, a login in the store, an older build's stores, a registered
/// project, or the first-run wizard already seen. The probe home does not
/// count: a version probe the window asked for can make it during this very
/// start, before setup gets here.
fn earlier_run_in(state_dir: &Path, user_home: &Path) -> bool {
    let json = |name: &str| -> Option<serde_json::Value> {
        serde_json::from_slice(&std::fs::read(state_dir.join(name)).ok()?).ok()
    };
    agent_auth::import_marked_in(state_dir)
        || agent_global::import_marked_in(state_dir)
        || agent_home::existing_homes_in(state_dir)
            .iter()
            .any(|home| home.file_name().is_some_and(|name| name != agent_home::PROBE_SCOPE_KEY))
        || LEGACY_STORES.iter().any(|dir| state_dir.join(dir).is_dir())
        || agent_auth::status_in(state_dir, user_home).iter().any(|login| login.signed_in)
        || json("projects.json").is_some_and(|v| v.as_array().is_some_and(|projects| !projects.is_empty()))
        || json("settings.json").is_some_and(|v| v.get("onboarding_seen").and_then(|s| s.as_bool()) == Some(true))
}

/// What this computer holds that an import would take.
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    /// The question is open. False once answered, and on an install that was
    /// never asked.
    pub pending: bool,
    /// Registry ids of the CLIs whose login this computer holds and the
    /// store does not.
    pub logins: Vec<String>,
    /// Home-relative config folders holding something to import; empty when
    /// the layer already holds files.
    pub config: Vec<String>,
}

fn found_in(state_dir: &Path, user_home: &Path) -> (Vec<String>, Vec<String>) {
    let config = if agent_global::layer_is_empty_in(state_dir) {
        agent_global::import_sources_in(user_home)
    } else {
        Vec::new()
    };
    (agent_auth::import_candidates_in(state_dir, user_home), config)
}

/// Startup, before the login keeper and before any tab can spawn: the silent
/// import for an install that ran before, the open question for a fresh one.
/// A fresh install on a computer with nothing to import is closed at once.
pub fn startup_in(state_dir: &Path, user_home: &Path) {
    if pending_in(state_dir) {
        return;
    }
    if agent_auth::import_marked_in(state_dir) && agent_global::import_marked_in(state_dir) {
        return;
    }
    if earlier_run_in(state_dir, user_home) {
        agent_auth::import_once_in(state_dir, user_home);
        agent_global::import_once_in(state_dir, user_home);
        return;
    }
    let (logins, config) = found_in(state_dir, user_home);
    if logins.is_empty() && config.is_empty() {
        close_in(state_dir);
        return;
    }
    // The marker is what keeps a later start from reading this install as an
    // upgrade. If it cannot be written, close the question unanswered rather
    // than leave a start that would import without it.
    let written = agent_home::create_private_dir(state_dir).is_ok()
        && std::fs::write(state_dir.join(PENDING_MARKER), b"").is_ok();
    if !written {
        eprintln!("agent_import_offer: could not hold the question open; nothing is imported");
        close_in(state_dir);
    }
}

pub fn startup() {
    startup_in(&storage::state_dir(), &crate::paths::home_dir());
    STARTED.store(true, Ordering::Release);
}

/// Set once [`startup`] has decided between importing and asking.
static STARTED: AtomicBool = AtomicBool::new(false);

/// The window is created before setup reaches [`startup`], so the wizard can
/// ask first. Reading then would find no pending marker and drop the page
/// from the very run it is for; wait for the decision instead (bounded: a
/// process that never runs `startup` answers "not pending").
fn wait_for_startup() {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !STARTED.load(Ordering::Acquire) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Both imports count as done, and the question is closed.
fn close_in(state_dir: &Path) {
    let _ = agent_home::create_private_dir(state_dir);
    agent_auth::mark_imported_in(state_dir);
    agent_global::mark_imported_in(state_dir);
    let _ = std::fs::remove_file(state_dir.join(PENDING_MARKER));
}

/// The question as the wizard shows it. Not pending: nothing is listed.
pub fn offer_in(state_dir: &Path, user_home: &Path) -> Offer {
    if !pending_in(state_dir) {
        return Offer::default();
    }
    let (logins, config) = found_in(state_dir, user_home);
    Offer { pending: true, logins, config }
}

pub fn offer() -> Offer {
    wait_for_startup();
    offer_in(&storage::state_dir(), &crate::paths::home_dir())
}

/// One login the user ticked, and why it was not taken if it was not.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    pub id: String,
    pub error: Option<String>,
}

/// What an answer did.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub logins: Vec<LoginOutcome>,
    /// The config import's counts, when config was ticked and taken.
    pub config: Option<agent_global::ImportReport>,
    pub config_error: Option<String>,
}

/// The user's answer: import the ticked logins (`logins`, registry ids) and,
/// with `config`, the config layer; neither is "no". Closes the question
/// whatever it took. Only what [`offer_in`] lists is imported, so an answer
/// can neither replace a login the store holds nor fill a layer the user
/// filled. Refused when no question is open.
pub fn answer_in(state_dir: &Path, user_home: &Path, logins: &[String], config: bool) -> Result<Outcome, String> {
    if !pending_in(state_dir) {
        return Err("the import question is not open".into());
    }
    let (offered, sources) = found_in(state_dir, user_home);
    let mut outcome = Outcome::default();
    for id in offered.iter().filter(|id| logins.contains(id)) {
        let error = agent_auth::import_from_user_home_in(state_dir, user_home, id).err();
        outcome.logins.push(LoginOutcome { id: id.clone(), error });
    }
    if config && !sources.is_empty() {
        match agent_global::import_from_user_home_in(state_dir, user_home) {
            Ok(report) => outcome.config = Some(report),
            Err(e) => outcome.config_error = Some(e.to_string()),
        }
    }
    close_in(state_dir);
    Ok(outcome)
}

pub fn answer(logins: &[String], config: bool) -> Result<Outcome, String> {
    wait_for_startup();
    answer_in(&storage::state_dir(), &crate::paths::home_dir(), logins, config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// A user home holding a Claude login and Claude instructions.
    fn user_home(root: &Path) -> std::path::PathBuf {
        let user = root.join("user");
        write(&user.join(".claude").join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"t"}}"#);
        write(&user.join(".claude").join("CLAUDE.md"), "mine");
        user
    }

    fn store_login(state: &Path) -> std::path::PathBuf {
        agent_auth::store_path_in(state, "claude", &agent_auth::file(".claude/.credentials.json"))
    }

    fn layer_file(state: &Path) -> std::path::PathBuf {
        agent_global::global_dir_in(state).join(".claude").join("CLAUDE.md")
    }

    #[test]
    fn a_fresh_install_is_asked_and_nothing_is_imported_before_the_answer() {
        let tmp = tempfile::tempdir().unwrap();
        let user = user_home(tmp.path());
        let state = tmp.path().join("state");
        startup_in(&state, &user);
        assert!(!store_login(&state).exists());
        assert!(!layer_file(&state).exists());
        let offer = offer_in(&state, &user);
        assert!(offer.pending);
        assert_eq!(offer.logins, ["claude"]);
        assert_eq!(offer.config, [".claude"]);

        // A version probe's home alone is not a sign of an earlier run.
        let probed = tmp.path().join("probed");
        std::fs::create_dir_all(probed.join("agent-homes").join(agent_home::PROBE_SCOPE_KEY)).unwrap();
        startup_in(&probed, &user);
        assert!(!store_login(&probed).exists());
        assert!(offer_in(&probed, &user).pending);

        // A tab opened before the answer makes a home; the next start still waits.
        std::fs::create_dir_all(state.join("agent-homes").join("host")).unwrap();
        startup_in(&state, &user);
        assert!(!store_login(&state).exists());
        assert!(offer_in(&state, &user).pending);
    }

    #[test]
    fn a_yes_imports_what_was_ticked_and_closes_the_question() {
        let tmp = tempfile::tempdir().unwrap();
        let user = user_home(tmp.path());
        let state = tmp.path().join("state");
        startup_in(&state, &user);
        let outcome = answer_in(&state, &user, &["claude".to_string()], true).unwrap();
        assert_eq!(outcome.logins, [LoginOutcome { id: "claude".into(), error: None }]);
        assert!(outcome.config.is_some());
        assert!(store_login(&state).is_file());
        assert!(layer_file(&state).is_file());
        assert_eq!(offer_in(&state, &user), Offer::default());
        assert!(answer_in(&state, &user, &[], false).is_err());
    }

    #[test]
    fn a_no_imports_nothing_and_is_never_asked_or_imported_again() {
        let tmp = tempfile::tempdir().unwrap();
        let user = user_home(tmp.path());
        let state = tmp.path().join("state");
        startup_in(&state, &user);
        let outcome = answer_in(&state, &user, &[], false).unwrap();
        assert_eq!(outcome, Outcome::default());
        std::fs::create_dir_all(state.join("agent-homes").join("host")).unwrap();
        startup_in(&state, &user);
        assert!(!store_login(&state).exists());
        assert!(!layer_file(&state).exists());
        assert!(!offer_in(&state, &user).pending);
    }

    #[test]
    fn an_answer_takes_only_what_the_offer_lists() {
        let tmp = tempfile::tempdir().unwrap();
        let user = user_home(tmp.path());
        let state = tmp.path().join("state");
        startup_in(&state, &user);
        // The user filled the layer in the meantime: config is off the offer.
        write(&agent_global::global_dir_in(&state).join(".codex").join("AGENTS.md"), "layer");
        assert!(offer_in(&state, &user).config.is_empty());
        let outcome = answer_in(&state, &user, &["codex".to_string(), "nope".to_string()], true).unwrap();
        assert!(outcome.logins.is_empty());
        assert!(outcome.config.is_none());
        assert!(!layer_file(&state).exists());
    }

    #[test]
    fn an_install_that_ran_before_keeps_the_silent_import() {
        let tmp = tempfile::tempdir().unwrap();
        let user = user_home(tmp.path());
        for sign in ["home", "project", "wizard"] {
            let state = tmp.path().join(sign);
            match sign {
                "home" => std::fs::create_dir_all(state.join("agent-homes").join("host")).unwrap(),
                "project" => write(&state.join("projects.json"), r#"[{"id":"p1"}]"#),
                _ => write(&state.join("settings.json"), r#"{"onboarding_seen":true}"#),
            }
            startup_in(&state, &user);
            assert!(store_login(&state).is_file(), "{sign}");
            assert!(layer_file(&state).is_file(), "{sign}");
            assert!(!offer_in(&state, &user).pending, "{sign}");
        }
    }

    #[test]
    fn a_fresh_install_with_nothing_to_import_is_closed_at_once() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("user");
        std::fs::create_dir_all(&user).unwrap();
        let state = tmp.path().join("state");
        startup_in(&state, &user);
        assert!(!offer_in(&state, &user).pending);
        // A login that appears later is not imported behind the user's back.
        write(&user.join(".claude").join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"t"}}"#);
        std::fs::create_dir_all(state.join("agent-homes").join("host")).unwrap();
        startup_in(&state, &user);
        assert!(!store_login(&state).exists());
    }
}
