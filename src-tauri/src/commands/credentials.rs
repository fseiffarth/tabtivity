//! Commands about the **OS credential store itself**, rather than any one
//! credential in it.
//!
//! Every "is this password saved?" answer in Tabtivity — the SSH `remote_has_password`,
//! the VPN `vpn_has_saved_password`, both silent-connect probes — reduces to a
//! keychain read, and on Linux a read against a *locked* Secret Service collection
//! answers exactly like an empty one: nothing saved. That is how a user who ticked
//! "Save password" ends up staring at a blank prompt after a restart, with the
//! credential sitting in the keyring the whole time.
//!
//! So the lock state is its own question, asked once by the UI, with one action
//! behind it. Both commands are `async` + `spawn_blocking` for the reason every
//! keychain command here is: a synchronous Tauri command runs on the **main thread**,
//! and a Secret Service round trip against a locked collection blocks — which would
//! freeze the window in the very state it is trying to explain.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::commands::terminal::RegistryState;
use crate::services::remote_credentials::{self as creds, KeyringState};
use tauri::State;

// ── Login-PTY registry (which terminals may receive a secret) ────────────────
//
// `credential_paste_to_pty` used to write a saved secret into whatever PTY id the
// caller named. That defeats the design it implements: the secret never reaches JS,
// but it reaches a process JS chose, so a caller able to spawn `sh -c 'cat >
// /tmp/loot'` could read every saved SSH/OpenVPN password out of the keychain.
//
// The backend can bound this without trusting the caller, because the backend is
// what *mints* the login command line in the first place
// (`remote_login_command` / `openvpn_login_command`). Each minted command is
// remembered together with the credential target it logs into; when that exact
// command is later typed into a PTY (the frontend types it as the terminal's
// `initialInput`, in a single `pty_write`), that PTY is marked as a login terminal
// for that target. A paste is then only allowed into a PTY that is genuinely
// running the login Tabtivity built for that very credential — which is where the
// secret was always going to go.

/// Which login a marked PTY is running — i.e. which saved credentials may be typed
/// into it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginTarget {
    /// An interactive `ssh` login to this host target.
    Ssh {
        user: Option<String>,
        host: String,
        port: Option<u16>,
    },
    /// An interactive OpenVPN connect for this client config.
    Vpn { config: String },
}

impl LoginTarget {
    /// The keychain accounts legitimately pasteable into this login. An ssh login
    /// takes only its host password; a VPN login takes any of the three secrets a
    /// tunnel can ask for (auth password, key passphrase, auth username).
    fn accounts(&self) -> Vec<String> {
        match self {
            Self::Ssh { user, host, port } => vec![creds::ssh_account(user, host, *port)],
            Self::Vpn { config } => vec![
                creds::openvpn_account(config),
                creds::openvpn_key_account(config),
                creds::openvpn_user_account(config),
            ],
        }
    }
}

/// Login command lines the backend has minted this session → the login they open.
fn minted_logins() -> &'static Mutex<HashMap<String, LoginTarget>> {
    static MAP: OnceLock<Mutex<HashMap<String, LoginTarget>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// PTY id → the login it was observed to be running.
fn login_ptys() -> &'static Mutex<HashMap<String, LoginTarget>> {
    static MAP: OnceLock<Mutex<HashMap<String, LoginTarget>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record that `command` was minted as the interactive login for `target`. Called
/// by `remote_login_command` / `openvpn_login_command` — the only two places a
/// login command line is built.
pub fn note_minted_login(command: &str, target: LoginTarget) {
    let command = command.trim();
    if command.is_empty() {
        return;
    }
    minted_logins()
        .lock()
        .unwrap()
        .insert(command.to_string(), target);
}

/// Inspect bytes written into `pty` and mark it a login terminal when they carry a
/// minted login command. Called from `pty_write`.
///
/// A `contains` match rather than equality: the frontend prefixes the typed line
/// with `\x15` (kill-line) for shell tabs, and the trailing Enter is a separate
/// write. Cheap — the map holds at most a handful of entries and only writes long
/// enough to be a command line are scanned at all.
pub fn note_pty_input(pty: &str, data: &[u8]) {
    let map = minted_logins().lock().unwrap();
    if map.is_empty() || data.len() < 8 {
        return;
    }
    let text = String::from_utf8_lossy(data);
    for (command, target) in map.iter() {
        if text.contains(command.as_str()) {
            login_ptys()
                .lock()
                .unwrap()
                .insert(pty.to_string(), target.clone());
            return;
        }
    }
}

/// Forget a PTY's login marking (its terminal is gone). Called from `pty_kill`.
pub fn forget_login_pty(pty: &str) {
    login_ptys().lock().unwrap().remove(pty);
}

/// Whether `account` may be typed into `pty` — i.e. `pty` is running a login whose
/// own credentials include that account.
fn paste_allowed(pty: &str, account: &str) -> bool {
    login_ptys()
        .lock()
        .unwrap()
        .get(pty)
        .is_some_and(|t| t.accounts().iter().any(|a| a == account))
}

/// Whether the OS credential store is readable right now (see [`KeyringState`]).
#[tauri::command]
pub async fn keyring_state() -> KeyringState {
    tokio::task::spawn_blocking(creds::keyring_state)
        .await
        // A worker that died tells us nothing about the store; "locked" is the answer
        // with a remedy attached, and a wrong "unlocked" would send the caller back
        // into the silent path that is already failing.
        .unwrap_or(KeyringState::Locked)
}

/// Unlock the OS credential store, raising the system's own unlock dialog.
///
/// Only ever called from an explicit user action (the header's VPN menu, a Connect
/// dialog) — never from a launch path, which promises not to prompt.
#[tauri::command]
pub async fn keyring_unlock() -> Result<(), String> {
    tokio::task::spawn_blocking(creds::unlock_keyring)
        .await
        .map_err(|e| format!("keyring unlock task failed: {e}"))?
}

/// Which saved credential a paste targets. Tagged by `kind` so the frontend names
/// the *credential*, never the keychain account string — the account spelling
/// (`ssh:{user}@{host}:{port}`, `openvpn-key:{config}`, …) stays the backend's, as
/// it is everywhere else, so a UI that mints one by hand can't drift from the one
/// [`creds`] writes.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PasteCredential {
    /// The SSH login password for a host target.
    SshPassword {
        user: Option<String>,
        host: String,
        port: Option<u16>,
    },
    /// An OpenVPN tunnel's primary secret (the `auth-user-pass` password, or the
    /// key passphrase for a config with no account).
    VpnPassword { config: String },
    /// An OpenVPN tunnel's separately-stored private-key passphrase.
    VpnKeyPassphrase { config: String },
    /// An OpenVPN tunnel's saved auth **username** — the one non-secret of the set,
    /// stored in the keychain because a header-started tunnel has no project spec to
    /// carry it (see [`creds::openvpn_user_account`]).
    VpnUsername { config: String },
}

impl PasteCredential {
    fn account(&self) -> String {
        match self {
            Self::SshPassword { user, host, port } => creds::ssh_account(user, host, *port),
            Self::VpnPassword { config } => creds::openvpn_account(config),
            Self::VpnKeyPassphrase { config } => creds::openvpn_key_account(config),
            Self::VpnUsername { config } => creds::openvpn_user_account(config),
        }
    }
}

/// Type a saved credential into a **login terminal**, at its cursor, without it ever
/// reaching the frontend.
///
/// This is the non-headless login's missing half. In that mode Tabtivity deliberately
/// handles no passwords — the host asks its own questions in an embedded terminal and
/// the user answers them — but a user who *did* save a credential (from a headless
/// connect, or the header's VPN menu) then has it sitting in the keychain, unreachable,
/// while retyping it by hand into every login. The same is true one flip of "Sign in in
/// a terminal" away: the escape hatch for a host that asks a challenge code still asks
/// for the ordinary password first.
///
/// So the secret goes keychain → PTY **inside the backend**. It is never returned to
/// JS, never rendered into a field, never in a component's state — the same bargain
/// `ssh_connect`'s saved-password fallback makes, applied to a terminal the user is
/// looking at rather than a headless connect. `submit` appends a newline for a prompt
/// the user wants answered outright; by default nothing is sent but the credential, so
/// the line can still be corrected before it is committed.
///
/// Returns `false` when nothing is stored for the target (including a locked keyring,
/// which reads as empty — [`keyring_state`] is what distinguishes the two), so the
/// caller can say "nothing saved" instead of appearing to paste an empty secret.
#[tauri::command]
pub async fn credential_paste_to_pty(
    registry: State<'_, RegistryState>,
    pty: String,
    target: PasteCredential,
    submit: Option<bool>,
) -> Result<bool, String> {
    let account = target.account();
    // The destination must be a terminal the backend has *seen* run the login this
    // credential belongs to (see the login-PTY registry above). Without this the
    // caller picks the process the secret is written into.
    if !paste_allowed(&pty, &account) {
        return Err(
            "that terminal is not a login for this credential — open the connection's login \
             terminal and try again"
                .to_string(),
        );
    }
    let Some(secret) = tokio::task::spawn_blocking(move || creds::get(&account))
        .await
        .map_err(|e| format!("credential read task failed: {e}"))?
    else {
        return Ok(false);
    };
    let mut bytes = secret.into_bytes();
    if submit.unwrap_or(false) {
        bytes.push(b'\r');
    }
    let sender = registry
        .lock()
        .unwrap()
        .input_sender(&pty)
        .ok_or_else(|| "the login terminal is no longer running".to_string())?;
    sender
        .send(bytes)
        .await
        .map_err(|_| "the login terminal is no longer accepting input".to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole gate, end to end over the two module-global registries: mint a
    /// login → type it into a PTY → that PTY (and only it) accepts that credential.
    #[test]
    fn only_a_pty_running_the_matching_login_accepts_a_secret() {
        let config = format!(concat!("/tmp/", crate::app_slug!(), "-test-{}.ovpn"), std::process::id());
        let vpn_cmd = format!("pkexec openvpn --config {config} --auth-nocache");
        let ssh_cmd = format!(
            "ssh -o ControlMaster=auto alice@host-{}",
            std::process::id()
        );
        note_minted_login(
            &vpn_cmd,
            LoginTarget::Vpn {
                config: config.clone(),
            },
        );
        note_minted_login(
            &ssh_cmd,
            LoginTarget::Ssh {
                user: Some("alice".to_string()),
                host: format!("host-{}", std::process::id()),
                port: None,
            },
        );

        let vpn_account = creds::openvpn_account(&config);
        let ssh_account = creds::ssh_account(
            &Some("alice".to_string()),
            &format!("host-{}", std::process::id()),
            None,
        );

        // An unmarked PTY — the "spawn `cat > /tmp/loot`" case — is refused.
        assert!(!paste_allowed("pty-evil", &vpn_account));

        // Typing the minted command marks it (the frontend's `\x15` kill-line
        // prefix and the separate trailing Enter must not defeat the match).
        note_pty_input("pty-vpn", format!("\x15{vpn_cmd}").as_bytes());
        assert!(paste_allowed("pty-vpn", &vpn_account));
        // …and the tunnel's other two secrets are legitimate there too.
        assert!(paste_allowed(
            "pty-vpn",
            &creds::openvpn_key_account(&config)
        ));
        assert!(paste_allowed(
            "pty-vpn",
            &creds::openvpn_user_account(&config)
        ));
        // But an SSH password is not: a VPN login is not that host's login.
        assert!(!paste_allowed("pty-vpn", &ssh_account));

        note_pty_input("pty-ssh", ssh_cmd.as_bytes());
        assert!(paste_allowed("pty-ssh", &ssh_account));
        assert!(!paste_allowed("pty-ssh", &vpn_account));

        // Closing the terminal drops the marking, so a reused id starts unblessed.
        forget_login_pty("pty-vpn");
        assert!(!paste_allowed("pty-vpn", &vpn_account));

        // Ordinary keystrokes never mark anything.
        note_pty_input("pty-plain", b"ls -la\r");
        assert!(!paste_allowed("pty-plain", &vpn_account));

        // Cleanup so the globals don't leak into other tests.
        forget_login_pty("pty-ssh");
        minted_logins().lock().unwrap().remove(&vpn_cmd);
        minted_logins().lock().unwrap().remove(&ssh_cmd);
    }
}
