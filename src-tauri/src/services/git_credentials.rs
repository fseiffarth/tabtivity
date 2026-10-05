//! Secure storage for git-hosting access tokens, backed by the OS credential
//! store (Windows Credential Manager / macOS Keychain / Linux Secret Service)
//! via the `keyring` crate.
//!
//! Why not `settings.json` / `project.json`? A project's `project.json` lives in
//! the project's git working tree and is NOT covered by the scaffolded
//! `.gitignore`, so a token written there would be committed and pushed. And the
//! security review (§4.2) flags the existing plaintext global `git_token`. Tokens
//! therefore never touch our JSON state — only the keyring holds them, keyed by a
//! caller-supplied scope (`"global"` or a project id).
//!
//! All operations degrade gracefully: a keyring that is unavailable (e.g. a
//! headless Linux box with no Secret Service) yields `None` on read and an
//! `Err(String)` on write, so callers can fall back to the global token or
//! surface a friendly message rather than panicking.

const SERVICE: &str = crate::brand::KEYRING_GIT_HOSTING;

/// The keyring "username" under which a scope's token is stored. Kept distinct
/// from any real account name so the entry is unambiguous in the OS store.
fn account(scope: &str) -> String {
    format!("token:{scope}")
}

fn entry(scope: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &account(scope)).map_err(|e| e.to_string())
}

/// The OS keyring by service name, for the read that also looks under the
/// service an older build used (`brand_migration::keyring`).
struct OsStore;

impl crate::services::brand_migration::keyring::Store for OsStore {
    fn get(&self, service: &str, account: &str) -> Option<String> {
        keyring::Entry::new(service, account)
            .ok()?
            .get_password()
            .ok()
            .filter(|secret| !secret.is_empty())
    }
    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(service, account)
            .and_then(|entry| entry.set_password(secret))
            .map_err(|e| e.to_string())
    }
    fn clear(&self, service: &str, account: &str) -> Result<(), String> {
        match keyring::Entry::new(service, account).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Read the token for `scope` (`"global"` or a project id). Returns `None` when
/// no token is stored or the keyring is unavailable — never an error, so a
/// missing per-project token cleanly falls through to the global one.
pub fn get_token(scope: &str) -> Option<String> {
    match entry(scope).and_then(|e| match e.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }) {
        Ok(token) => token.filter(|t| !t.is_empty()),
        Err(_) => None,
    }
    .or_else(|| legacy_token(scope))
}

/// The token an older build saved under the service named after the app's
/// old name, copied to the current service on the way. `None` at once while
/// the name is unchanged.
fn legacy_token(scope: &str) -> Option<String> {
    let pair = crate::brand::PAIR;
    pair.legacy(crate::brand::Name::KEYRING_GIT_HOSTING)?;
    crate::services::brand_migration::keyring::get(
        &pair,
        crate::brand::Name::KEYRING_GIT_HOSTING,
        &OsStore,
        &account(scope),
        "keyring-git-hosting",
        true,
    )
}

/// Store (non-empty) or clear (`None`/empty) the token for `scope`. Returns an
/// error string if the keyring write fails so the UI can report it.
pub fn set_token(scope: &str, token: Option<&str>) -> Result<(), String> {
    let e = entry(scope)?;
    match token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(secret) => e.set_password(secret).map_err(|err| err.to_string()),
        None => {
            // Cleared under the old service too, or the read would find it
            // there again. Nothing to do while the name is unchanged.
            crate::services::brand_migration::keyring::clear_legacy(
                &crate::brand::PAIR,
                crate::brand::Name::KEYRING_GIT_HOSTING,
                &OsStore,
                &account(scope),
            );
            match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err.to_string()),
            }
        }
    }
}

/// Whether a non-empty token is stored for `scope`. Used to tell the frontend
/// "token set" without ever handing the secret back to the renderer.
pub fn has_token(scope: &str) -> bool {
    get_token(scope).is_some()
}
