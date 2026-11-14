//! "Stay signed in" for the Copilot language server (plan B11): with
//! `Settings::copilot_stay_signed_in` on, the GitHub token of a finished device
//! sign-in is kept in the OS keychain, one entry per app account (never per
//! project), and handed to every server that starts.
//!
//! The token travels only between the keychain and the server's stdin: never
//! to the webview, a log line or the diagnostics ring. Both request shapes
//! (`auth/getGitHubToken`, `signInWithGithubToken`) come from reading the
//! 1.565.6 server bundle, not from a live account
//! (`docs/context/copilot_completion.md`).
use super::session::Session;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Keyring account under `remote_credentials`' service, which carries the
/// locked-keyring handling (a locked collection is read from the kernel
/// cache and refuses writes rather than prompting).
const ACCOUNT: &str = "copilot-language-server";

/// What is remembered: the token and the login it belongs to (the server's
/// `signInWithGithubToken` wants both).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Remembered {
    pub user: String,
    pub token: String,
}

impl std::fmt::Debug for Remembered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Remembered").field("user", &self.user).field("token", &"[redacted]").finish()
    }
}

/// Where the remembered sign-in lives: the OS keychain in the app, memory in
/// tests. Calls may block (D-Bus); [`read`] and [`write`] run them off the
/// async workers.
pub trait TokenStore: Send + Sync {
    fn get(&self) -> Option<Remembered>;
    fn set(&self, value: Option<&Remembered>) -> Result<(), String>;
}

/// The OS keychain through `remote_credentials`.
pub struct Keychain;

impl TokenStore for Keychain {
    fn get(&self) -> Option<Remembered> {
        let secret = crate::services::remote_credentials::get(ACCOUNT)?;
        serde_json::from_str(&secret).ok()
    }
    fn set(&self, value: Option<&Remembered>) -> Result<(), String> {
        let secret = value.map(serde_json::to_string).transpose().map_err(|e| e.to_string())?;
        crate::services::remote_credentials::set(ACCOUNT, secret.as_deref())
    }
}

pub type Store = Arc<dyn TokenStore>;

/// The store the app uses.
pub fn keychain() -> Store {
    Arc::new(Keychain)
}

/// Whether the user turned "Stay signed in" on (`settings.json`, default off).
pub fn enabled() -> bool {
    crate::storage::load_settings().and_then(|s| s.copilot_stay_signed_in).unwrap_or(false)
}

pub async fn read(store: &Store) -> Option<Remembered> {
    let store = store.clone();
    app_core::rt::blocking("Copilot keychain", move || store.get()).await.ok().flatten()
}

async fn write(store: &Store, value: Option<Remembered>) -> Result<(), String> {
    let store = store.clone();
    app_core::rt::try_blocking("Copilot keychain", move || store.set(value.as_ref())).await
}

/// Whether a token for this app account is remembered (`copilot_account`'s
/// `remembered`). Never the token itself.
pub async fn remembered(store: &Store) -> bool {
    read(store).await.is_some()
}

/// After a finished device sign-in, with the setting on: ask the server for
/// its GitHub token and keep it with the account's login. A server that has
/// no token (signed out again) keeps nothing.
pub async fn remember(session: &Session, store: &Store) -> Result<(), String> {
    let Some(token) = session.github_token().await? else { return Ok(()) };
    let account = session.account().await?;
    let Some(user) = account.get("user").and_then(serde_json::Value::as_str).filter(|u| !u.is_empty()) else {
        return Ok(());
    };
    write(store, Some(Remembered { user: user.to_owned(), token })).await
}

/// After `finish_sign_in` succeeded: remember the token only with the setting
/// on (`stay`); with it off nothing is asked and nothing is stored.
pub async fn after_sign_in(session: &Session, stay: bool, store: &Store) -> Result<(), String> {
    if !stay {
        return Ok(());
    }
    remember(session, store).await
}

/// On every server start with the setting on (after
/// `workspace/didChangeConfiguration`): sign the server in with the
/// remembered token. A token the server refuses is deleted and the server
/// stays signed out; a server that could not be asked, or could not ask
/// GitHub (it answers with an error), keeps the entry.
/// Returns whether the server is signed in from the keychain.
pub async fn restore(session: &Session, store: &Store) -> Result<bool, String> {
    let Some(remembered) = read(store).await else { return Ok(false) };
    if session.sign_in_with_token(&remembered.token, &remembered.user).await? {
        return Ok(true);
    }
    write(store, None).await?;
    Ok(false)
}

/// Sign-out, or the setting switched off: the entry goes.
pub async fn forget(store: &Store) -> Result<(), String> {
    write(store, None).await
}

/// The setting changed in a settings write. Switched on while a server is
/// signed in: its token is kept now. Switched off: the entry goes.
pub async fn setting_changed(on: bool, running: &[Arc<Session>], store: &Store) -> Result<(), String> {
    if !on {
        return forget(store).await;
    }
    for session in running {
        let signed_in = session.account().await.ok().is_some_and(|account| {
            matches!(account.get("status").and_then(serde_json::Value::as_str), Some("OK" | "MaybeOK"))
        });
        if signed_in {
            return remember(session, store).await;
        }
    }
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A keychain in memory.
    #[derive(Default)]
    pub struct Memory(pub Mutex<Option<Remembered>>);

    impl TokenStore for Memory {
        fn get(&self) -> Option<Remembered> {
            self.0.lock().unwrap().clone()
        }
        fn set(&self, value: Option<&Remembered>) -> Result<(), String> {
            *self.0.lock().unwrap() = value.cloned();
            Ok(())
        }
    }

    #[test]
    fn a_remembered_sign_in_never_prints_its_token() {
        let remembered = Remembered { user: "octo".into(), token: "token-value-1".into() };
        let shown = format!("{remembered:?}");
        assert!(shown.contains("octo") && !shown.contains("token-value-1"), "{shown}");
    }
}
