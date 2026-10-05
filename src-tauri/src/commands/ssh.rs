//! SSH commands for remote projects.
//!
//! These shell out to the system `ssh` binary in `BatchMode` so the user's
//! existing key/agent/`~/.ssh/config` setup is the source of truth. We never
//! build a shell string from user input: `host`, `user`, `path` and `port` are
//! passed as separate argv items, and we reject values that could be mistaken
//! for `ssh`/`ls` options (a leading `-`) or that contain control characters.

use std::process::Command;

use serde::Serialize;

// The validation + base-argv helpers live in `services::ssh_common` so every
// remote path shares a single validated implementation.
use crate::services::sftp;
use crate::services::ssh_common::{ssh_base_args, ssh_password_base_args};

/// One entry in a remote directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Availability of the external binaries remote projects rely on, so the UI can
/// warn the moment the "Remote (SSH) project" checkbox is enabled instead of
/// only surfacing a failure after the user tries to connect. Remote projects are
/// SSH/SFTP-native (no FUSE mount), so only `sshpass`/`openvpn` are relevant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshTooling {
    /// Whether non-interactive password auth works without the user installing
    /// anything. Always true on Unix (OpenSSH's own `SSH_ASKPASS` carries it);
    /// on Windows it still depends on `sshpass` being present.
    pub password_auth: bool,
    /// `openvpn` + `pkexec` — required only for VPN-gated hosts.
    pub openvpn: bool,
    /// `rsync` on the LOCAL machine — enables the SSH-sync bulk fast-path (the
    /// SFTP-native floor is always used when it (or the host's rsync) is missing).
    pub rsync: bool,
}

/// Report which remote-project tools are present on `PATH`. Called when the
/// remote checkbox is toggled on so missing tools can be flagged up front.
#[tauri::command]
pub fn ssh_tooling_status() -> SshTooling {
    SshTooling {
        password_auth: crate::services::ssh_common::password_auth_available(),
        openvpn: crate::services::openvpn::openvpn_available(),
        rsync: crate::services::remote_sync::rsync_available_local(),
    }
}

/// What the fingerprint-confirmation dialog shows for a host Tabtivity has never
/// connected to. `scan` is the raw known_hosts text behind `keys` and is handed
/// straight back to [`ssh_trust_host_key`], so what gets stored is exactly what
/// was shown — a re-scan at accept time would leave a window for a different key.
#[derive(Debug, Clone, Serialize)]
pub struct HostKeyPreview {
    /// Resolved `host:port` (after `~/.ssh/config`), so the dialog names the
    /// machine the key actually belongs to rather than the alias typed.
    pub target: String,
    /// True when the key is already in known_hosts — the dialog then has nothing
    /// to ask and the caller can proceed straight to connecting.
    pub known: bool,
    pub keys: Vec<crate::services::ssh_common::HostKeyFingerprint>,
    /// Opaque known_hosts lines to pass back to `ssh_trust_host_key`.
    pub scan: String,
}

/// Fetch the SSH host keys a host currently offers, so the user can verify the
/// fingerprint before a password is sent to it (see
/// `ssh_common::guard_first_contact`). Async + `spawn_blocking`: `ssh-keyscan`
/// talks to the network and would otherwise freeze the window.
#[tauri::command]
pub async fn ssh_host_key_preview(
    host: String,
    port: Option<u16>,
) -> Result<HostKeyPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use crate::services::ssh_common as sc;
        let (resolved, resolved_port) = sc::resolve_host_port(&host, port);
        let known = sc::host_key_known(&resolved, resolved_port);
        let (scan, keys) = sc::scan_host_keys(&host, port)?;
        Ok(HostKeyPreview {
            target: format!("{resolved}:{resolved_port}"),
            known,
            keys,
            scan,
        })
    })
    .await
    .map_err(|e| format!("host key preview failed: {e}"))?
}

/// Record the user's acceptance of the keys `ssh_host_key_preview` showed, by
/// appending them to `~/.ssh/known_hosts`. This is the *only* thing that clears
/// the first-contact gate, and it exists solely to be reachable from a click — no
/// launch or background path may call it.
#[tauri::command]
pub fn ssh_trust_host_key(scan: String) -> Result<(), String> {
    crate::services::ssh_common::trust_host_key(&scan)
}

/// Most-recently-used SSH addresses to keep. Old entries past this fall off.
const SSH_ADDRESS_CAP: usize = 20;

/// File backing the recently-used SSH address list (a plain `Vec<String>`).
fn ssh_addresses_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("ssh_addresses.json")
}

/// Merge `addr` into `existing` as a most-recently-used list: drop any prior
/// case-insensitive duplicate, prepend the new value, and cap the length. Pure
/// so the dedupe/cap policy is unit-tested without touching disk.
fn merge_recent_address(existing: Vec<String>, addr: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(existing.len() + 1);
    out.push(addr.to_string());
    for e in existing {
        if !e.eq_ignore_ascii_case(addr) {
            out.push(e);
        }
    }
    out.truncate(SSH_ADDRESS_CAP);
    out
}

/// Previously-used SSH addresses (most-recent first) so the project dialog can
/// offer them for reuse instead of retyping. Best-effort: a missing or corrupt
/// store yields an empty list.
#[tauri::command]
pub fn ssh_list_addresses() -> Vec<String> {
    crate::storage::read_json(&ssh_addresses_path()).unwrap_or_default()
}

/// Remember `address` as the most-recently-used SSH address. Trims and validates
/// it (rejecting blanks, option-looking values, and control chars) so we never
/// persist something the connect path couldn't use, then moves it to the front
/// of the recents list.
#[tauri::command]
pub fn ssh_remember_address(address: String) -> Result<(), String> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err("empty SSH address".to_string());
    }
    crate::services::ssh_common::validate_arg("SSH address", trimmed)?;
    let existing: Vec<String> =
        crate::storage::read_json(&ssh_addresses_path()).unwrap_or_default();
    let merged = merge_recent_address(existing, trimmed);
    crate::storage::write_json(&ssh_addresses_path(), &merged).map_err(|e| e.to_string())
}

/// Most-recently-used remote paths to keep, per host. Old entries past this
/// fall off.
const REMOTE_PATH_CAP: usize = 20;

/// File backing the recently-used remote-path lists, keyed by host
/// (case-insensitive) so a path picked on one host isn't suggested for another.
fn remote_paths_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("remote_paths.json")
}

/// Merge `path` into `existing` as a most-recently-used list: drop any prior
/// exact-match duplicate (paths are case-sensitive, unlike hostnames), prepend
/// the new value, and cap the length. Pure so the dedupe/cap policy is
/// unit-tested without touching disk.
fn merge_recent_path(existing: Vec<String>, path: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(existing.len() + 1);
    out.push(path.to_string());
    for e in existing {
        if e != path {
            out.push(e);
        }
    }
    out.truncate(REMOTE_PATH_CAP);
    out
}

/// Previously-used remote paths for `host` (most-recent first), so the project
/// dialog can offer them for reuse instead of re-browsing. Best-effort: a
/// missing or corrupt store, or a host with no history, yields an empty list.
#[tauri::command]
pub fn remote_list_paths(host: String) -> Vec<String> {
    let store: std::collections::HashMap<String, Vec<String>> =
        crate::storage::read_json(&remote_paths_path()).unwrap_or_default();
    store.get(&host.to_lowercase()).cloned().unwrap_or_default()
}

/// Remember `path` as the most-recently-used remote path for `host`. Trims and
/// validates it (rejecting blanks, option-looking values, and control chars) so
/// we never persist something the browse/connect path couldn't use, then moves
/// it to the front of that host's recents list.
#[tauri::command]
pub fn remote_remember_path(host: String, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty remote path".to_string());
    }
    crate::services::ssh_common::validate_arg("remote path", trimmed)?;
    let key = host.to_lowercase();
    let mut store: std::collections::HashMap<String, Vec<String>> =
        crate::storage::read_json(&remote_paths_path()).unwrap_or_default();
    let existing = store.remove(&key).unwrap_or_default();
    store.insert(key, merge_recent_path(existing, trimmed));
    crate::storage::write_json(&remote_paths_path(), &store).map_err(|e| e.to_string())
}

/// File backing the per-host **standard** remote paths set from Settings'
/// "Remote Connections" panel — a `HashMap<host, path>`, keyed case-
/// insensitively like `remote_paths.json`. Distinct from that file: this one
/// holds one explicit, user-chosen default per host, not an auto-remembered
/// recents list.
fn remote_host_defaults_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("remote_host_defaults.json")
}

/// All per-host standard paths configured from Settings, for the "Remote
/// Connections" panel to list and edit.
#[tauri::command]
pub fn remote_list_default_paths() -> std::collections::HashMap<String, String> {
    crate::storage::read_json(&remote_host_defaults_path()).unwrap_or_default()
}

/// The configured standard remote path for `host`, if any. Consulted when a
/// connect/browse flow would otherwise fall back to `ssh_default_dir`'s SSH
/// home-directory guess, so a host with a preferred working directory starts
/// there instead every time.
#[tauri::command]
pub fn remote_get_default_path(host: String) -> Option<String> {
    let store: std::collections::HashMap<String, String> =
        crate::storage::read_json(&remote_host_defaults_path()).unwrap_or_default();
    store.get(&host.to_lowercase()).cloned()
}

/// Set (or, with a blank `path`, clear) the standard remote path for `host`.
/// Trims and validates a non-empty path the same way `remote_remember_path`
/// does, so it can't smuggle in an `ssh`/`sftp`-option-looking value or
/// control characters.
#[tauri::command]
pub fn remote_set_default_path(host: String, path: String) -> Result<(), String> {
    let key = host.trim().to_lowercase();
    if key.is_empty() {
        return Err("empty host".to_string());
    }
    let mut store: std::collections::HashMap<String, String> =
        crate::storage::read_json(&remote_host_defaults_path()).unwrap_or_default();
    let trimmed = path.trim();
    if trimmed.is_empty() {
        store.remove(&key);
    } else {
        crate::services::ssh_common::validate_arg("remote path", trimmed)?;
        store.insert(key, trimmed.to_string());
    }
    crate::storage::write_json(&remote_host_defaults_path(), &store).map_err(|e| e.to_string())
}

/// Open a web URL in the user's default browser. Refuses anything that is not an
/// `http(s)` URL so it cannot be turned into a launcher for arbitrary local files
/// or schemes.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("refusing to open a non-web URL".to_string());
    }
    opener::open(&url).map_err(|e| format!("failed to open {url}: {e}"))
}

/// Run a built command, returning stdout on success or the trimmed stderr (or a
/// generic message) on failure. `what` names the binary for error messages.
fn capture(cmd: Command, what: &str) -> Result<String, String> {
    capture_raw(cmd, what).map_err(|(explained, _)| explained)
}

/// [`capture`] keeping ssh's raw stderr alongside the explained message, for the
/// one caller that must tell a *local* failure (a wrong key passphrase) from a
/// server-side one before deciding whether to try another auth method — see
/// [`run_ssh_auth`]. The explained form is deliberately lossy, so the choice
/// cannot be made from it.
fn capture_raw(mut cmd: Command, what: &str) -> Result<String, (String, String)> {
    let output = cmd
        .output()
        .map_err(|e| (format!("failed to run {what}: {e}"), String::new()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err((format!("{what} command failed"), stderr));
        }
        // Headless has no terminal for the user to read, so translate what OpenSSH
        // said into what they got wrong. Unrecognized stderr passes through
        // verbatim rather than being flattened into a vague guess.
        let explained = crate::services::ssh_common::explain_ssh_error(&stderr)
            .unwrap_or_else(|| stderr.clone());
        return Err((explained, stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Replace a failed ssh result with the prompt the askpass shim refused to answer,
/// when there was one. Without this a refusal surfaces as OpenSSH's generic
/// `Permission denied` — which is exactly the dead end the shape check exists to
/// avoid: the user needs to be told the host asked for something else, and what.
///
/// Must be called while the [`Askpass`](crate::services::ssh_common::Askpass) guard
/// is still alive; dropping it deletes the record.
#[cfg(any(unix, windows))]
fn askpass_refusal_raw(
    kind: crate::services::ssh_common::SecretKind,
    askpass: &crate::services::ssh_common::Askpass,
    result: Result<String, (String, String)>,
) -> Result<String, (String, bool)> {
    let Err((explained, raw)) = result else {
        return result.map_err(|(e, _)| (e, false));
    };
    // Both reads must happen before the guard drops (it deletes its files).
    if crate::services::ssh_common::secret_rejected_locally(kind, Some(askpass), &raw) {
        return Err((crate::services::ssh_common::wrong_passphrase_error(), true));
    }
    match askpass.refused_prompt() {
        Some(prompt) => Err((
            crate::services::ssh_common::unexpected_prompt_error(&prompt),
            false,
        )),
        None => Err((explained, false)),
    }
}

/// Run an ssh command against `[user@]host[:port]`, choosing the auth method by
/// whether a non-empty `password` was supplied:
///   - password present → password-only auth via OpenSSH's own `SSH_ASKPASS` shim
///     (`services::ssh_common::make_askpass`) — on Windows only when OpenSSH ≥ 8.4
///     supports `SSH_ASKPASS_REQUIRE`, with `sshpass -e` as the legacy fallback.
///   - otherwise → key/agent auth in `BatchMode=yes` (the original v1 flow).
///
/// Returns ssh stdout on success or the trimmed stderr on failure.
///
/// `pub(crate)`: also called by
/// `commands::global_machines::global_machine_monitor_snapshot`, which needs
/// this exact password-vs-key branching for a project-free host (no pooled
/// ControlMaster to ride, unlike `remote_usage::check_usage`).
pub(crate) fn run_ssh_auth(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    remote: &[&str],
) -> Result<String, String> {
    use crate::services::ssh_common::SecretKind;

    let Some(pw) = password.filter(|p| !p.is_empty()) else {
        let base = ssh_base_args(user, host, port)?;
        let mut cmd = crate::paths::command_no_window("ssh");
        cmd.args(&base);
        cmd.args(remote);
        return capture(cmd, "ssh").map_err(|err| {
            // `BatchMode=yes` never asks for an encrypted key's passphrase, so a
            // locked key surfaces as a bare "Permission denied (publickey)" with
            // nothing pointing at the actual cause. Name it.
            match crate::services::ssh_common::locked_key_hint(user, host, port) {
                Some(hint) => format!("{err}\n\n{hint}"),
                None => err,
            }
        });
    };

    let kinds = crate::services::ssh_common::secret_attempt_order(user, host, port);
    let last = kinds.len() - 1;
    let mut error = String::new();
    for (i, kind) in kinds.iter().copied().enumerate() {
        if kind == SecretKind::Password {
            // Never hand a password to a host whose key has not been vetted — the
            // one thing `accept-new` does not cover (see `guard_first_contact`).
            // A passphrase needs no such gate: it never leaves this machine.
            crate::services::ssh_common::guard_first_contact(host, port)?;
        }
        let base = match kind {
            SecretKind::Password => ssh_password_base_args(user, host, port)?,
            SecretKind::KeyPassphrase => {
                crate::services::ssh_common::ssh_passphrase_base_args(user, host, port)?
            }
        };
        match run_one_secret_attempt(kind, pw, &base, remote) {
            Ok(out) => return Ok(out),
            Err((explained, rejected_locally)) => {
                error = explained;
                // Definitively a wrong passphrase: retrying it as a login password
                // would disclose a local secret to the host.
                if rejected_locally || i == last {
                    return Err(error);
                }
            }
        }
    }
    Err(error)
}

/// One authentication attempt for [`run_ssh_auth`]: build `ssh` (or `sshpass`)
/// with the askpass shim for `kind` attached, run it, and return stdout or
/// `(explained, raw stderr)`.
///
/// The askpass guard must outlive the ssh run — the shim is invoked *during*
/// authentication — so it stays in scope until `capture_raw` returns, and its
/// refusal record is read before it drops (dropping deletes it).
fn run_one_secret_attempt(
    kind: crate::services::ssh_common::SecretKind,
    secret: &str,
    base: &[String],
    remote: &[&str],
) -> Result<String, (String, bool)> {
    let build_err = |e: String| (e, false);

    #[cfg(unix)]
    {
        let mut cmd = crate::paths::command_no_window("ssh");
        cmd.args(base);
        cmd.args(remote);
        let askpass =
            crate::services::ssh_common::make_askpass_for(kind, secret, base).map_err(build_err)?;
        for (k, v) in askpass.env_vars() {
            cmd.env(k, v);
        }
        let out = capture_raw(cmd, "ssh");
        askpass_refusal_raw(kind, &askpass, out)
    }
    #[cfg(not(unix))]
    {
        use crate::services::ssh_common::SecretKind;

        // Windows: same SSH_ASKPASS path when OpenSSH is >= 8.4; older installs
        // (Win10-inbox 8.1) fall back to sshpass, which can only answer a
        // *password* prompt. All commands use `command_no_window`, so no console
        // flashes either way.
        if crate::services::ssh_common::ssh_supports_askpass() {
            let mut cmd = crate::paths::command_no_window("ssh");
            cmd.args(base);
            cmd.args(remote);
            let askpass = crate::services::ssh_common::make_askpass_for(kind, secret, base)
                .map_err(build_err)?;
            for (k, v) in askpass.env_vars() {
                cmd.env(k, v);
            }
            let out = capture_raw(cmd, "ssh");
            askpass_refusal_raw(kind, &askpass, out)
        } else if kind == SecretKind::KeyPassphrase {
            Err(build_err(
                "unlocking a passphrase-protected SSH key needs OpenSSH 8.4+ — update \
                 OpenSSH, or run `ssh-add` to load the key before connecting"
                    .to_string(),
            ))
        } else if crate::services::ssh_common::sshpass_available() {
            let mut cmd = crate::paths::command_no_window("sshpass");
            cmd.arg("-e"); // read the password from the SSHPASS env var
            cmd.env("SSHPASS", secret);
            cmd.arg("ssh");
            cmd.args(base);
            cmd.args(remote);
            capture_raw(cmd, "sshpass").map_err(|(e, _)| (e, false))
        } else {
            Err(build_err(
                "password auth needs OpenSSH 8.4+ or sshpass — update OpenSSH, \
                 install sshpass, or set up SSH keys"
                    .to_string(),
            ))
        }
    }
}

/// Build the shell command that opens an **interactive** ssh login to
/// `[user@]host[:port]`, sharing the multiplexing master the mount/check paths
/// reuse. Returned for the frontend to type into a root-scope shell tab when
/// headless connections are off, so the password is entered in the visible
/// terminal and never handled by Tabtivity (see `ssh_exec::interactive_login_command`).
#[tauri::command]
pub fn remote_login_command(
    user: Option<String>,
    host: String,
    port: Option<u16>,
) -> Result<String, String> {
    let command = crate::services::ssh_exec::interactive_login_command(&user, &host, port)?;
    // Remember which login this command line opens, so `credential_paste_to_pty`
    // can later verify that the PTY it is asked to type this host's saved password
    // into is actually running *this* login (see `commands::credentials`).
    crate::commands::credentials::note_minted_login(
        &command,
        crate::commands::credentials::LoginTarget::Ssh { user, host, port },
    );
    Ok(command)
}

/// Verify the remote host is reachable over SSH (non-interactive). With a
/// non-empty `password`, authenticates by feeding it to ssh (via `SSH_ASKPASS` on
/// Unix, `sshpass` on Windows); otherwise uses key/agent auth. Returns the trimmed
/// ssh stderr as the error on failure.
///
/// Async + `spawn_blocking`: the ssh probe spawns a subprocess that can block for
/// up to `ConnectTimeout=10s` (BatchMode key/agent auth against an unreachable or
/// not-yet-tunnelled host, or while a password login's master comes up). As a
/// *synchronous* Tauri command this ran on the main/UI thread and froze the whole
/// window — most visibly during reconnect, where `pollSshReady` polls it every
/// few seconds against a still-authenticating master. Running it on a blocking
/// worker keeps the UI responsive (e.g. the SSH-login button stays clickable while
/// the OpenVPN tunnel is coming up).
///
/// `remember` is the "Save password" checkbox, and **only** the checkbox:
/// `Some(true)` persists the working password in the OS keychain (keyed by the host
/// target, written only *after* auth succeeds) for no-prompt reconnects,
/// `Some(false)` — an explicit untick — clears any previously-saved one, and `None`
/// leaves the keychain untouched. That last case is not a nicety: a caller with no
/// checkbox behind it (a readiness poll riding the ControlMaster, a silent
/// reconnect) must not delete the credential it just authenticated with — which is
/// exactly what folding `None` into "unticked" used to do.
///
/// A `None`/empty `password` first falls back to any saved credential (silent
/// reconnect) before dropping to key/agent auth.
///
/// The outcome is [`SshConnectOutcome`], not `()`, because the keychain half can
/// fail on its own: a locked keyring refuses the write, and reporting only "the
/// connect worked" left the user with a ticked Save box, no saved password, and a
/// blank prompt at the next launch as the sole evidence.
#[tauri::command]
pub async fn ssh_connect(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    password: Option<String>,
    remember: Option<bool>,
    background: Option<bool>,
) -> Result<SshConnectOutcome, String> {
    tokio::task::spawn_blocking(move || {
        use crate::services::remote_credentials as creds;
        // Both shapes at once, because this command is both. A **typed password**
        // is a person at a login form, so it is unconditionally their connect to
        // make. Credential-less, it is ambiguous: the same call is the readiness
        // poll that waits for a terminal login's ControlMaster (a gesture, so the
        // add-a-machine and reconnect flows pass `background: false`) and the
        // silent reconnect behind auto-connect (which passes nothing). The guard
        // must outlive `run_ssh_auth`, which is where the argv is built.
        let typed = password.as_deref().is_some_and(|p| !p.is_empty());
        let _dial = typed
            .then(|| crate::services::ssh_common::user_dial(&user, &host, port))
            .or_else(|| crate::services::ssh_common::declared_dial(background, &user, &host, port));
        let account = creds::ssh_account(&user, &host, port);
        // A typed password wins; otherwise fall back to a saved one so an
        // activation-time reconnect authenticates without a prompt.
        let effective = password
            .filter(|p| !p.is_empty())
            .or_else(|| creds::get(&account));
        run_ssh_auth(&user, &host, port, effective.as_deref(), &["true"])?;
        let outcome = creds::remember_secret(&account, remember, effective.as_deref());
        Ok(SshConnectOutcome {
            saved: outcome.saved,
            save_error: outcome.error,
        })
    })
    .await
    .map_err(|e| format!("ssh probe task failed: {e}"))?
}

/// What [`ssh_connect`] did *besides* connecting: whether the "Save password"
/// checkbox was honoured, and — when it was not — the reason, verbatim from the
/// keychain layer ("the OS keyring is locked, so nothing was saved…").
///
/// A failed keychain write never fails the connect: authentication already
/// succeeded, and refusing the session over a storage problem helps nobody. But
/// it must not be silent either, which is what discarding it amounted to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshConnectOutcome {
    /// A password is now saved for this target as a result of this connect.
    pub saved: bool,
    /// Why it is not, when the user asked for it (or asked to remove one and the
    /// keyring could not be read). `None` on success and when nothing was asked.
    pub save_error: Option<String>,
}

/// Both halves of "is a password saved for this host?" in one answer: whether one
/// reads back, and whether the store could be read at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SavedPasswordState {
    pub saved: bool,
    pub keyring: crate::services::remote_credentials::KeyringState,
}

/// The saved-password state of a host target — [`remote_has_saved_password`] plus
/// the fact that makes its answer readable.
///
/// A locked collection answers every lookup with "nothing saved", so `saved:
/// false` alone is ambiguous in exactly the case the user cares about: they *did*
/// tick Save, the password *is* on the ring, and the UI reports it gone. Both
/// facts come from **one** `spawn_blocking` hop because they are one question —
/// asking them separately costs two unbounded keychain trips per host, on a path
/// auto-connect already takes once per host per launch.
#[tauri::command]
pub async fn remote_saved_password_state(
    user: Option<String>,
    host: String,
    port: Option<u16>,
) -> SavedPasswordState {
    tokio::task::spawn_blocking(move || {
        use crate::services::remote_credentials as creds;
        // Lock state first: it refreshes the cache `has()`'s gate then reads, so
        // the two facts describe the same moment rather than straddling a probe.
        let keyring = creds::keyring_state();
        let saved = creds::has(&creds::ssh_account(&user, &host, port));
        SavedPasswordState { saved, keyring }
    })
    .await
    .unwrap_or(SavedPasswordState {
        saved: false,
        // A panicked lookup told us nothing about the store, and "unavailable" is
        // the state with no action behind it — the honest answer to "we don't
        // know", and the one that routes the caller to a prompt.
        keyring: crate::services::remote_credentials::KeyringState::Unavailable,
    })
}

/// Whether a saved SSH password exists for this host target, so the UI can
/// pre-check the "Save password" box and show "saved" without ever receiving the
/// secret itself.
///
/// `async` + `spawn_blocking` is load-bearing, not stylistic. A **synchronous**
/// Tauri command runs on the **main thread**, and the keychain behind this is the
/// platform secret store — on Linux a D-Bus round-trip to the Secret Service,
/// which is unbounded: it is slow while the daemon starts, and it blocks
/// *indefinitely* while the keyring is locked, because the unlock prompt has to be
/// answered first. Answering it needs the compositor, and Tabtivity's window is
/// frozen mid-frame at that point. Auto-connect is what makes this a launch
/// problem rather than a rare one: it asks this question once per host, for the
/// primary and every opted-in worker, on every launch and every activation — so a
/// multi-host remote project serialised several unbounded main-thread D-Bus calls
/// into startup. Off the main thread it is just a slow promise.
///
/// Now a thin wrapper over [`remote_saved_password_state`], which answers the same
/// question *and* says whether the store was readable. Kept because callers still
/// ask it this way; a `false` here remains the safe direction (the caller prompts,
/// never a silent connect on a credential we cannot read).
#[tauri::command]
pub async fn remote_has_saved_password(
    user: Option<String>,
    host: String,
    port: Option<u16>,
) -> bool {
    remote_saved_password_state(user, host, port).await.saved
}

/// Outcome of a silent reachability probe (`ssh_probe`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshProbe {
    /// The host answered and authentication succeeded.
    pub ok: bool,
    /// The failure was the *network* not reaching the host — not a rejected
    /// credential. Only this warrants bringing an OpenVPN tunnel up and retrying.
    pub unreachable: bool,
    /// Trimmed ssh stderr (empty when `ok`).
    pub error: String,
}

/// Whether an ssh failure means "the host was not reachable from this network"
/// rather than "the host said no". Auto-connect escalates to the project's VPN
/// tunnel *only* on the former: a wrong or expired credential must never cause a
/// tunnel to be brought up, and no tunnel would fix it anyway.
fn ssh_unreachable(err: &str) -> bool {
    const MARKERS: [&str; 6] = [
        "Connection timed out",
        "Operation timed out",
        "No route to host",
        "Network is unreachable",
        "Connection refused",
        "Could not resolve hostname",
    ];
    let err = err.to_ascii_lowercase();
    MARKERS
        .iter()
        .any(|m| err.contains(&m.to_ascii_lowercase()))
}

/// Silently probe whether this host is reachable *and* authenticates right now,
/// classifying a failure as unreachable-vs-rejected. Backs the auto-connect path
/// (`autoConnectRemote`), which uses the verdict to decide whether the project's
/// OpenVPN tunnel is needed on the current network.
///
/// Deliberately **not** `ssh_connect`: that command rewrites the keychain entry on
/// every success (clearing it whenever `remember` is falsy), so probing through it
/// would delete the very saved password auto-connect depends on. This one is
/// read-only — it reuses the saved credential but never writes one.
///
/// Read-only of the *keychain*, that is: it is a full authenticated login at the
/// host, which is precisely how a tagged cluster kept being dialled unattended.
/// So it takes `background` (`ssh_common`'s second shape) — the armed
/// auto-connect and the machines-menu reachability sweep are its background
/// callers, a Connect dialog's pre-flight its gesture one — and only an explicit
/// `Some(false)` counts as a person waiting.
#[tauri::command]
pub async fn ssh_probe(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    background: Option<bool>,
) -> SshProbe {
    tokio::task::spawn_blocking(move || {
        use crate::services::remote_credentials as creds;
        let _dial = crate::services::ssh_common::declared_dial(background, &user, &host, port);
        let saved = creds::get(&creds::ssh_account(&user, &host, port));
        match run_ssh_auth(&user, &host, port, saved.as_deref(), &["true"]) {
            Ok(_) => SshProbe {
                ok: true,
                unreachable: false,
                error: String::new(),
            },
            Err(e) => SshProbe {
                ok: false,
                unreachable: ssh_unreachable(&e),
                error: e,
            },
        }
    })
    .await
    .unwrap_or_else(|e| SshProbe {
        ok: false,
        unreachable: false,
        error: format!("ssh probe task failed: {e}"),
    })
}

/// Forget any saved SSH password for this host target (explicit "clear" action).
/// Off the main thread for the same reason as `remote_has_saved_password`.
#[tauri::command]
pub async fn remote_forget_password(
    user: Option<String>,
    host: String,
    port: Option<u16>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let account = crate::services::remote_credentials::ssh_account(&user, &host, port);
        crate::services::remote_credentials::set(&account, None)
    })
    .await
    .map_err(|e| format!("forget password task failed: {e}"))?
}

/// Kill every tmux session on a remote host — the "end all my running jobs" half
/// of an **active** disconnect. Rides a live multiplexing master if one exists (a
/// project/HPC host with a pooled connection), otherwise authenticates ad-hoc
/// with the saved credential (a global machine, which pools nothing) — the same
/// `run_ssh_auth` branching `global_machine_monitor_snapshot` uses.
///
/// EXPLICIT-ACTION ONLY. Persistent tmux sessions are meant to outlive a tab
/// close, an app quit and a relaunch (the whole point of #85); this is the one
/// deliberate path that ends them, and it must never fire on deactivation or
/// restart. `tmux kill-server` reporting "no server running" is success (there
/// was nothing to kill), so the whole command is best-effort past reachability.
#[tauri::command]
pub async fn remote_kill_all_jobs(
    user: Option<String>,
    host: String,
    port: Option<u16>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        use crate::services::remote_credentials as creds;
        // Explicit-action-only, so it is user-initiated by definition — this is
        // the one path allowed to reach a tagged HPC host to end work on it.
        let _dial = crate::services::ssh_common::user_dial(&user, &host, port);
        let password = creds::get(&creds::ssh_account(&user, &host, port));
        run_ssh_auth(
            &user,
            &host,
            port,
            password.as_deref(),
            &[crate::services::ssh_exec::tmux_kill_server_script()],
        )
        .map(|_| ())
    })
    .await
    .map_err(|e| format!("kill-jobs task failed: {e}"))?
}

/// Close the shared multiplexing master for a host (`ssh -O exit`) so an active
/// disconnect really severs the SSH connection, not just the lamp. Best-effort:
/// a host with no live master — a pure global machine never opens one
/// (`ControlMaster=no`, see `ssh_common::control_reuse_opts`) — yields a harmless
/// no-op. A **project** host tears its pool down through `remote_disconnect`
/// instead (which also stops its lockstep/auto-sync); this is for the project-
/// free **global machines**, which pool nothing of their own.
#[tauri::command]
pub async fn ssh_close_master(
    user: Option<String>,
    host: String,
    port: Option<u16>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        close_control_master(&user, &host, port);
        Ok(())
    })
    .await
    .map_err(|e| format!("close-master task failed: {e}"))?
}

/// Ask a live ControlMaster for this host to exit, over the shared `cm-%C`
/// socket. Unix-only — Windows OpenSSH has no control socket (see `ssh_pty_args`).
#[cfg(not(target_os = "windows"))]
fn close_control_master(user: &Option<String>, host: &str, port: Option<u16>) {
    let Ok(target) = crate::services::ssh_common::ssh_target(user, host) else {
        return;
    };
    let control_path = crate::services::ssh_exec::control_dir().join("cm-%C");
    let mut cmd = crate::paths::command_no_window("ssh");
    cmd.arg("-o")
        .arg(format!("ControlPath={}", control_path.to_string_lossy()));
    if let Some(port) = port {
        cmd.arg("-p").arg(port.to_string());
    }
    cmd.arg("-O").arg("exit").arg(&target);
    let _ = cmd.output();
}

#[cfg(target_os = "windows")]
fn close_control_master(_user: &Option<String>, _host: &str, _port: Option<u16>) {}

/// Return the remote default (home) directory as the browser's start location.
/// Resolved over SFTP (REALPATH of `.`), so no remote shell runs.
///
/// Unconditionally user-initiated (`ssh_common`'s first shape): the remote folder
/// browser has no caller but a dialog somebody is typing into — the new/import
/// project flow, extend-to-remote, the add-worker form, the HPC pipeline wizard.
/// Leaving it background made a tagged machine impossible to *add*, which turns
/// the tag from a protection into a trap: the point is that Tabtivity never reaches
/// a cluster on its own, not that the user cannot.
#[tauri::command]
pub async fn ssh_default_dir(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    password: Option<String>,
) -> Result<String, String> {
    let _dial = crate::services::ssh_common::user_dial(&user, &host, port);
    sftp::default_dir(&user, &host, port, password.as_deref()).await
}

/// List one remote directory over SFTP. Empty `path` lists the remote home
/// directory. Because SFTP is a binary protocol, a directory name containing
/// `;`/`$()`/spaces is just a listing entry — it is never re-interpreted by a
/// remote shell (the injection surface the old `ssh ls` path had to guard).
/// User-initiated for the same reason as [`ssh_default_dir`] — one browser, one
/// rule.
#[tauri::command]
pub async fn ssh_list_dir(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    password: Option<String>,
    path: String,
) -> Result<Vec<RemoteEntry>, String> {
    let _dial = crate::services::ssh_common::user_dial(&user, &host, port);
    let entries = sftp::list_dir(&user, &host, port, password.as_deref(), &path).await?;
    Ok(entries
        .into_iter()
        .map(|e| RemoteEntry {
            name: e.name,
            is_dir: e.is_dir,
        })
        .collect())
}

/// Create a remote directory (mkdir -p) over SFTP. Like `ssh_list_dir`, `path`
/// is a binary SFTP field, never re-interpreted by a remote shell — so a folder
/// name with shell metacharacters is created verbatim, not executed. Used by the
/// new/import dialog's remote browser to add a target folder while browsing.
/// User-initiated for the same reason as [`ssh_default_dir`]; creating a folder
/// is a gesture by construction — nothing polls a mkdir.
#[tauri::command]
pub async fn ssh_mkdir(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    password: Option<String>,
    path: String,
) -> Result<(), String> {
    let _dial = crate::services::ssh_common::user_dial(&user, &host, port);
    sftp::mkdir(&user, &host, port, password.as_deref(), &path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keychain-touching commands must stay `async`. A **synchronous**
    /// `#[tauri::command]` runs on the **main thread**, and the platform secret
    /// store behind these is an unbounded D-Bus round-trip that blocks outright
    /// while the keyring is locked — freezing the window against an unlock prompt
    /// the user then cannot reach. Auto-connect asks `remote_has_saved_password`
    /// once per host on every launch and activation, so on the main thread a
    /// multi-host remote project serialises several of those into startup.
    ///
    /// This is a COMPILE-TIME guard: making one of them `fn` again stops it being
    /// a `Future` and fails the build here. The futures are constructed and
    /// dropped, never awaited, so no keychain is touched by running this test.
    #[test]
    fn credential_commands_are_async_so_they_never_block_the_main_thread() {
        fn assert_future<F: std::future::Future>(_f: F) {}
        assert_future(remote_has_saved_password(None, "host".into(), None));
        assert_future(remote_forget_password(None, "host".into(), None));
        assert_future(crate::commands::openvpn::vpn_has_saved_password(
            String::new(),
        ));
        assert_future(crate::commands::openvpn::vpn_can_connect_silently(
            String::new(),
            None,
        ));
        assert_future(crate::commands::openvpn::vpn_forget_password(String::new()));
        assert_future(crate::commands::openvpn::openvpn_remove_config(
            String::new(),
        ));
    }

    // NOTE: the old `ls`-text browse path (`parse_ls_output`) and its
    // `shell_quote` remote-path injection defense were removed when browsing
    // moved to native SFTP (TODO #80). The dirs-first/ci sort + dot-filter and
    // the injection-is-inert property now live in `services::sftp` tests
    // (`finalize_entries`, `finalize_injection_named_dir_is_one_inert_entry`),
    // since SFTP paths are protocol fields and never reach a remote shell.

    // ── ssh_base_args / validation ─────────────────────────────────────────

    #[test]
    fn base_args_renders_user_at_host_as_single_item() {
        let args = ssh_base_args(&Some("alice".to_string()), "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "alice@host.example");
        // BatchMode + ConnectTimeout present.
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        assert!(args.iter().any(|a| a == "ConnectTimeout=10"));
    }

    // ── ssh_unreachable (auto-connect's VPN-escalation gate) ───────────────

    #[test]
    fn unreachable_recognizes_network_failures() {
        for err in [
            "ssh: connect to host build.example port 22: Connection timed out",
            "ssh: connect to host build.example port 22: No route to host",
            "ssh: connect to host build.example port 22: Network is unreachable",
            "ssh: connect to host build.example port 22: Connection refused",
            "ssh: Could not resolve hostname build.example: Name or service not known",
        ] {
            assert!(ssh_unreachable(err), "should be unreachable: {err}");
        }
    }

    /// A rejected credential must never escalate to bringing the VPN up: no tunnel
    /// fixes a wrong password, and the tunnel is not wanted on this network.
    #[test]
    fn unreachable_does_not_claim_auth_failures() {
        for err in [
            "alice@build.example: Permission denied (publickey,password).",
            "Received disconnect from 10.0.0.2 port 22:2: Too many authentication failures",
            "Host key verification failed.",
        ] {
            assert!(!ssh_unreachable(err), "should not be unreachable: {err}");
        }
    }

    #[test]
    fn base_args_no_user_uses_bare_host() {
        let args = ssh_base_args(&None, "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "host.example");
    }

    #[test]
    fn base_args_includes_port_flag() {
        let args = ssh_base_args(&None, "host.example", Some(2222)).unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
    }

    #[test]
    fn base_args_rejects_leading_dash_host() {
        assert!(ssh_base_args(&None, "-oProxyCommand=evil", None).is_err());
    }

    #[test]
    fn base_args_rejects_leading_dash_user() {
        assert!(ssh_base_args(&Some("-evil".to_string()), "host", None).is_err());
    }

    #[test]
    fn base_args_rejects_control_chars() {
        assert!(ssh_base_args(&None, "host\nevil", None).is_err());
        assert!(ssh_base_args(&None, "host\0evil", None).is_err());
        assert!(ssh_base_args(&Some("us\ter".to_string()), "host", None).is_err());
    }

    #[test]
    fn base_args_rejects_empty_host() {
        assert!(ssh_base_args(&None, "   ", None).is_err());
    }

    #[test]
    fn base_args_rejects_empty_user_when_provided() {
        assert!(ssh_base_args(&Some("  ".to_string()), "host", None).is_err());
    }

    #[test]
    fn validate_arg_rejects_dash_and_control_allows_normal_path() {
        assert!(crate::services::ssh_common::validate_arg("path", "/home/user/projects").is_ok());
        assert!(crate::services::ssh_common::validate_arg("path", "-rf").is_err());
        assert!(crate::services::ssh_common::validate_arg("path", "a\nb").is_err());
    }

    // ── ssh_password_base_args ─────────────────────────────────────────────

    #[test]
    fn password_args_disable_batchmode_and_pin_password_auth() {
        let args = ssh_password_base_args(&Some("me".to_string()), "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "me@host.example");
        assert!(args.iter().any(|a| a == "BatchMode=no"));
        assert!(args
            .iter()
            .any(|a| a == "PreferredAuthentications=password"));
        assert!(args.iter().any(|a| a == "PubkeyAuthentication=no"));
        // Must never enable BatchMode=yes (that would block the password prompt).
        assert!(!args.iter().any(|a| a == "BatchMode=yes"));
    }

    #[test]
    fn password_args_include_port_and_reject_bad_target() {
        let args = ssh_password_base_args(&None, "host", Some(2222)).unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
        assert!(ssh_password_base_args(&None, "-evil", None).is_err());
        assert!(ssh_password_base_args(&Some("-evil".to_string()), "host", None).is_err());
    }

    // ── merge_recent_address (recently-used SSH addresses) ─────────────────

    #[test]
    fn merge_recent_prepends_new_address() {
        let out = merge_recent_address(vec!["a@h".to_string(), "b@h".to_string()], "c@h");
        assert_eq!(out, vec!["c@h", "a@h", "b@h"]);
    }

    #[test]
    fn merge_recent_moves_existing_to_front_without_duplicating() {
        let out = merge_recent_address(vec!["a@h".to_string(), "b@h".to_string()], "b@h");
        assert_eq!(out, vec!["b@h", "a@h"]);
    }

    #[test]
    fn merge_recent_dedup_is_case_insensitive() {
        let out = merge_recent_address(vec!["User@Host".to_string()], "user@host");
        assert_eq!(out, vec!["user@host"]);
    }

    #[test]
    fn merge_recent_caps_length_keeping_newest() {
        let existing: Vec<String> = (0..SSH_ADDRESS_CAP).map(|i| format!("h{i}")).collect();
        let out = merge_recent_address(existing, "newest");
        assert_eq!(out.len(), SSH_ADDRESS_CAP);
        assert_eq!(out[0], "newest");
        // The oldest entry ("h19") is dropped to make room.
        assert!(!out
            .iter()
            .any(|a| a == &format!("h{}", SSH_ADDRESS_CAP - 1)));
    }

    // ── merge_recent_path (recently-used remote paths, per host) ───────────

    #[test]
    fn merge_recent_path_prepends_new_path() {
        let out = merge_recent_path(vec!["/a".to_string(), "/b".to_string()], "/c");
        assert_eq!(out, vec!["/c", "/a", "/b"]);
    }

    #[test]
    fn merge_recent_path_moves_existing_to_front_without_duplicating() {
        let out = merge_recent_path(vec!["/a".to_string(), "/b".to_string()], "/b");
        assert_eq!(out, vec!["/b", "/a"]);
    }

    #[test]
    fn merge_recent_path_dedup_is_case_sensitive() {
        // Unlike hostnames, remote filesystem paths are case-sensitive — "/Foo"
        // and "/foo" are different directories on Linux, so both must survive.
        let out = merge_recent_path(vec!["/Foo".to_string()], "/foo");
        assert_eq!(out, vec!["/foo", "/Foo"]);
    }

    #[test]
    fn merge_recent_path_caps_length_keeping_newest() {
        let existing: Vec<String> = (0..REMOTE_PATH_CAP).map(|i| format!("/p{i}")).collect();
        let out = merge_recent_path(existing, "/newest");
        assert_eq!(out.len(), REMOTE_PATH_CAP);
        assert_eq!(out[0], "/newest");
        assert!(!out
            .iter()
            .any(|a| a == &format!("/p{}", REMOTE_PATH_CAP - 1)));
    }
}
