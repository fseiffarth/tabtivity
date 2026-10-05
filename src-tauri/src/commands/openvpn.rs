//! Tauri commands for OpenVPN tunnels backing VPN-gated remote projects.
//!
//! Tunnels are keyed by the local `.ovpn` config path so the same config is
//! shared between project setup (browsing the remote) and later activation. The
//! secrets are taken per call and never persisted unless the caller opts in (see
//! `services::openvpn` and `services::remote_credentials`).
//!
//! A config can demand up to **two** secrets from us — an `auth-user-pass`
//! account password and an encrypted key's passphrase — which OpenVPN prompts for
//! separately. `openvpn_auth_needs` tells the UI which fields to show; the local
//! root password is a third secret, but that one belongs to polkit/`pkexec`, not
//! to Tabtivity.

use crate::services::openvpn;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Which secrets `config` needs the user to supply, so the UI can show exactly
/// those fields. The two are independent — a config can need both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnAuthNeeds {
    /// A bare `auth-user-pass` directive: server-side account auth, so we must
    /// supply a username alongside the password (else OpenVPN prompts on stdin
    /// and, with stdin closed, hangs).
    pub username: bool,
    /// An encrypted private key: OpenVPN asks `Enter Private Key Password:` for
    /// it separately from the account password.
    pub key_passphrase: bool,
}

/// Bring up (or reuse) the OpenVPN tunnel for `config`. Blocks until the tunnel
/// is up or the attempt fails. While the handshake runs, each line OpenVPN emits
/// is forwarded to the frontend as an `openvpn-progress` event (`{ config, line }`)
/// so a VPN-gated activation / dialog can show the live handshake in a read-only
/// log instead of an opaque spinner.
///
/// Two secrets, resolved independently. For each: a typed value wins; a
/// `None`/empty one falls back to the saved credential for this config (the
/// silent auto-connect path) and errors if none exists, so the caller can show
/// the prompt.
///  - `password` — the `auth-user-pass` account password, or for a config with no
///    account, the key passphrase (the long-standing single-secret path).
///  - `key_passphrase` — only for a config that has an encrypted key *and* an
///    account; required in that case, since OpenVPN prompts for it separately.
///
/// `username` is the (non-secret) auth username for `auth-user-pass` configs.
///
/// `remember` is the "Save passphrase" checkbox, and **only** the checkbox:
/// `Some(true)` saves the working secrets in the OS keychain (keyed by config path,
/// written only *after* the tunnel is up), `Some(false)` — an explicit untick —
/// clears any previously-saved ones, and `None` leaves the keychain untouched. It
/// governs both secrets together: the UI offers one "save" toggle for the
/// connection, not one per field.
///
/// The `None` case is load-bearing. A silent connect (`password: None`, no
/// checkbox) authenticates *from* the saved passphrase — folding that into
/// "unticked" deleted the passphrase it had just used, so the tunnel came up once
/// and prompted ever after.
#[tauri::command]
pub async fn openvpn_connect(
    app: AppHandle,
    config: String,
    username: Option<String>,
    password: Option<String>,
    key_passphrase: Option<String>,
    remember: Option<bool>,
) -> Result<(), String> {
    use crate::services::remote_credentials as creds;
    let account = creds::openvpn_account(&config);
    let key_account = creds::openvpn_key_account(&config);
    let user_account = creds::openvpn_user_account(&config);
    let Some(pw) = password
        .filter(|p| !p.is_empty())
        .or_else(|| creds::get(&account))
    else {
        return Err("no VPN password provided and none saved".to_string());
    };
    // The key passphrase is a *second* prompt OpenVPN raises, so it is only needed
    // when the config both has an encrypted key and takes its password for an
    // account (otherwise `password` already is the key passphrase — see
    // `services::openvpn::write_credfiles`). Erroring here rather than letting the
    // handshake stall on an unanswered prompt is what makes the UI able to ask.
    let needs_key = openvpn::config_requires_key_passphrase(&config)
        && openvpn::config_requires_userpass(&config);
    let key_passphrase = key_passphrase
        .filter(|p| !p.is_empty())
        .or_else(|| creds::get(&key_account));
    if needs_key && key_passphrase.is_none() {
        return Err("no VPN private-key passphrase provided and none saved".to_string());
    }
    // The username is the one non-secret of the three, and the only one that used to
    // have no home when no project owned the tunnel — so a header-started connect
    // supplied none, and `pkexec` had already raised its polkit prompt by the time the
    // server rejected the login. Fall back to the saved one for exactly that case.
    let username = username
        .filter(|u| !u.is_empty())
        .or_else(|| creds::get(&user_account));
    // Offload to a blocking worker. `connect_streaming` is fully synchronous and
    // blocks for the whole handshake — up to `CONNECT_TIMEOUT` (45s), and longer
    // still while `pkexec` waits on the polkit prompt. Awaiting it directly on the
    // async runtime starves a worker and froze the headless VPN connect; mirror
    // `ssh_connect`, which spawn_blocks its ssh probe for exactly this reason.
    tokio::task::spawn_blocking(move || {
        openvpn::connect_streaming(
            &config,
            username.as_deref(),
            &pw,
            key_passphrase.as_deref(),
            |line| {
                let _ = app.emit(
                    "openvpn-progress",
                    serde_json::json!({ "config": config, "line": line }),
                );
            },
        )?;
        // Tunnel is up — honour the checkbox (save / clear / leave alone). The
        // username rides the same checkbox as the secrets: it is useless on its own,
        // and saving it while clearing them would leave a half-set that still prompts.
        creds::remember_secret(&account, remember, Some(pw.as_str()));
        creds::remember_secret(&key_account, remember, key_passphrase.as_deref());
        creds::remember_secret(&user_account, remember, username.as_deref());
        Ok(())
    })
    .await
    .map_err(|e| format!("openvpn connect task failed: {e}"))?
}

/// Which secrets `config` needs from the user (see [`VpnAuthNeeds`]). The UI calls
/// this when a config is chosen, to decide which fields to show and require.
#[tauri::command]
pub async fn openvpn_auth_needs(config: String) -> VpnAuthNeeds {
    VpnAuthNeeds {
        username: openvpn::config_requires_userpass(&config),
        key_passphrase: openvpn::config_requires_key_passphrase(&config),
    }
}

/// Whether this config can connect with **no prompt** — i.e. every secret it needs
/// is already in the keychain. Lets the UI pre-check the "Save password" box and
/// offer "Forget", without ever receiving a secret. A config needing two secrets
/// with only one saved reports `false`: a silent connect would fail on the other.
///
/// The keychain reads below are why this (and its two siblings) are `async` +
/// `spawn_blocking` rather than plain commands: a synchronous Tauri command runs
/// on the **main thread**, and a Secret Service lookup is an unbounded D-Bus
/// round-trip that blocks outright while the keyring is locked — waiting on an
/// unlock prompt the user cannot reach, because the window is frozen mid-frame
/// waiting for it. The auto-connect-on-launch path asks these questions before it
/// does anything else, so on the main thread they are a startup freeze.
#[tauri::command]
pub async fn vpn_has_saved_password(config: String) -> bool {
    tokio::task::spawn_blocking(move || has_saved_password_blocking(&config))
        .await
        // Unreadable keychain ⇒ "nothing saved" ⇒ the caller prompts. Never the
        // other way round: claiming a secret exists would license a silent
        // connect that then stalls on a prompt nobody sees.
        .unwrap_or(false)
}

/// The VPN twin of `commands::ssh::remote_saved_password_state` (G.24): both
/// halves of "is a password saved for this tunnel?" in one answer — whether one
/// reads back, and whether the store could be read at all.
///
/// It exists because [`vpn_has_saved_password`] is a bare `bool`, and against a
/// **locked** Secret Service that bool is a lie with a specific consequence. A
/// locked collection answers every lookup with "nothing saved", so the SSH side
/// used to untick "Save password" — and an unticked box is not neutral, it is an
/// instruction to *clear* the credential, which is how a host lost the password
/// it had just authenticated with. The SSH side now distinguishes "not saved"
/// from "keyring unreadable"; the VPN side still read a plain boolean, so a
/// locked keyring here went on masquerading as "nothing saved".
///
/// Same shape and same reason as its twin: **one** `spawn_blocking` hop, because
/// these are one question and asking them separately costs two unbounded keychain
/// trips on a path the launch-time auto-connect already takes once per config.
/// The lock state is read *first*, so it refreshes the cache that `has()`'s own
/// gate consults and the two facts describe the same moment rather than
/// straddling a probe.
#[tauri::command]
pub async fn vpn_saved_password_state(config: String) -> crate::commands::ssh::SavedPasswordState {
    tokio::task::spawn_blocking(move || {
        use crate::services::remote_credentials as creds;
        let keyring = creds::keyring_state();
        let saved = has_saved_password_blocking(&config);
        crate::commands::ssh::SavedPasswordState { saved, keyring }
    })
    .await
    .unwrap_or(crate::commands::ssh::SavedPasswordState {
        saved: false,
        // A panicked lookup told us nothing about the store, and "unavailable" is
        // the state with no action behind it — the honest answer to "we don't
        // know", and the one that routes the caller to a prompt.
        keyring: crate::services::remote_credentials::KeyringState::Unavailable,
    })
}

/// The blocking body of [`vpn_has_saved_password`], callable from the other
/// keychain helpers without going through the command layer (and without each
/// one spawning its own blocking task).
fn has_saved_password_blocking(config: &str) -> bool {
    use crate::services::remote_credentials as creds;
    if !creds::has(&creds::openvpn_account(config)) {
        return false;
    }
    let needs_key = openvpn::config_requires_key_passphrase(config)
        && openvpn::config_requires_userpass(config);
    !needs_key || creds::has(&creds::openvpn_key_account(config))
}

/// Whether `config` can be brought up with **no prompt of any kind** — the question
/// a silent/auto connect must ask *before* it runs, because running it is what
/// raises the polkit dialog: `pkexec` authenticates the user long before OpenVPN
/// gets far enough to reject a login. An attempt made without everything it needs
/// therefore doesn't fail cheaply — it costs the user a system password prompt, and
/// then the modal costs them a second one. This is what stops that.
///
/// True when every secret the config needs is saved, *and* — for an `auth-user-pass`
/// config — a username is available: either one the caller can supply (a project's
/// spec) or one saved alongside the password. `vpn_has_saved_password` deliberately
/// still answers the narrower keychain-state question the "Save password" checkbox
/// and "Forget" button are asking; this one answers "would connecting now be silent?".
#[tauri::command]
pub async fn vpn_can_connect_silently(config: String, username: Option<String>) -> bool {
    tokio::task::spawn_blocking(move || {
        use crate::services::remote_credentials as creds;
        if !has_saved_password_blocking(&config) {
            return false;
        }
        if !openvpn::config_requires_userpass(&config) {
            return true;
        }
        username.is_some_and(|u| !u.trim().is_empty())
            || creds::get(&creds::openvpn_user_account(&config)).is_some()
    })
    .await
    // "Can't tell" must mean "don't connect silently" — the whole point of this
    // question is to avoid an elevation prompt for a connect that cannot succeed.
    .unwrap_or(false)
}

/// Forget every saved credential for `config` (explicit "log out" action) — the
/// password, any separately-stored key passphrase, and the saved auth username, so a
/// partial forget can't leave a stale half behind. The SSH-side twin is
/// `remote_forget_password`.
#[tauri::command]
pub async fn vpn_forget_password(config: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || forget_password_blocking(&config))
        .await
        .map_err(|e| format!("forget credentials task failed: {e}"))?
}

/// The blocking body of [`vpn_forget_password`], so `openvpn_remove_config` can
/// forget a config's credentials inside its own blocking task rather than nesting
/// one command inside another.
fn forget_password_blocking(config: &str) -> Result<(), String> {
    use crate::services::remote_credentials as creds;
    let pw = creds::set(&creds::openvpn_account(config), None);
    let key = creds::set(&creds::openvpn_key_account(config), None);
    let user = creds::set(&creds::openvpn_user_account(config), None);
    pw.and(key).and(user)
}

/// Build the shell command that brings the tunnel up **interactively** (the
/// passphrase is typed into a visible terminal, no askpass file). Returned for
/// the frontend to type into a root-scope shell tab when headless connections are
/// off (see `services::openvpn::interactive_connect_command`).
#[tauri::command]
pub async fn openvpn_login_command(config: String) -> Result<String, String> {
    let command = openvpn::interactive_connect_command(&config)?;
    // Same reason as `remote_login_command`: record which tunnel this command line
    // brings up, so a saved VPN secret can only be typed into a PTY the backend has
    // seen run *this* connect (see `commands::credentials`).
    crate::commands::credentials::note_minted_login(
        &command,
        crate::commands::credentials::LoginTarget::Vpn { config },
    );
    Ok(command)
}

/// Tear down the OpenVPN tunnel for `config` if it is up. Idempotent.
#[tauri::command]
pub async fn openvpn_disconnect(config: String) -> Result<(), String> {
    openvpn::disconnect(&config)
}

/// Tear down **every** registered tunnel on the **app-close path**, reporting whether
/// they all went down. This is the checked twin of the exit-time `disconnect_all`: it
/// touches the same set of tunnels, so that once it succeeds nothing is left for
/// `RunEvent::Exit` to kill — which is what used to raise the polkit prompt *after* the
/// window had already vanished. A refused prompt is an error here and leaves the tunnel
/// registered *and* marks it declined, so the frontend can warn the user it is staying
/// up — but the quit itself proceeds either way, and `RunEvent::Exit` will not re-ask
/// for a declined config, so this is a one-shot: the user is asked once, not once per
/// close attempt.
///
/// It enumerates the backend registries directly rather than taking a config from the
/// frontend's `openvpn_active`: `active_configs` filters by a liveness probe, so a
/// tunnel whose probe reads false would be skipped here yet still killed (and prompted
/// for) by the exit-time `disconnect_all`. On Linux this raises the `pkexec` password
/// prompt while the window is still on screen (the whole point); elsewhere it is the
/// ordinary best-effort teardown.
#[tauri::command]
pub async fn openvpn_disconnect_all_on_quit() -> Result<(), String> {
    // Offload for the same reason `openvpn_connect` does: the teardown is fully
    // synchronous and blocks for as long as `pkexec` sits on the polkit prompt —
    // i.e. until the user types a password. Awaiting that directly on the async
    // runtime starves a worker while the window is still on screen and waiting.
    tokio::task::spawn_blocking(openvpn::disconnect_all_checked)
        .await
        .map_err(|e| format!("openvpn teardown task failed: {e}"))?
}

/// Whether the OpenVPN tunnel for `config` is currently up.
#[tauri::command]
pub async fn openvpn_status(config: String) -> Result<bool, String> {
    Ok(openvpn::is_connected(&config))
}

/// Every config whose tunnel is up right now, regardless of which project asked
/// for it. A tunnel reroutes the whole machine, so the frontend tracks it as a
/// machine-level object (`stores/remote/vpn/vpnStatus.ts`) rather than a per-project one; this
/// is how that store seats itself on launch and re-seats after a renderer reload,
/// where the tunnel outlives the window that started it.
#[tauri::command]
pub async fn openvpn_active() -> Result<Vec<String>, String> {
    Ok(openvpn::active_configs())
}

/// Copy a selected `.ovpn` config into Tabtivity's storage and return the stored
/// path, so the project no longer depends on the original file's location.
#[tauri::command]
pub async fn openvpn_store_config(config: String) -> Result<String, String> {
    openvpn::store_config(&config)
}

/// List the `.ovpn` configs Tabtivity has previously stored (newest first), so the
/// project dialog can offer a previously-used config for reuse instead of
/// browsing for the file again.
#[tauri::command]
pub async fn openvpn_list_configs() -> Result<Vec<openvpn::StoredConfig>, String> {
    Ok(openvpn::list_configs())
}

/// Remove a stored `.ovpn` config from Tabtivity's store, and with it every
/// credential saved for it — a keychain entry keyed by a config that no longer
/// exists is exactly the stale half `vpn_forget_password` exists to prevent.
/// Order matters: the removal is the guarded step (must be a stored path, tunnel
/// must be down), so it goes first — a refused removal leaves the credentials
/// alone. Deletes Tabtivity's copy only, never the user's original file.
#[tauri::command]
pub async fn openvpn_remove_config(config: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        openvpn::remove_config(&config)?;
        forget_password_blocking(&config)
    })
    .await
    .map_err(|e| format!("remove config task failed: {e}"))?
}
