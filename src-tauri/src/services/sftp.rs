//! Native SFTP session for the remote folder browser (TODO #80).
//!
//! This replaces the `ssh … ls -1Ap` shell-out the browse commands used to do.
//! We open the **SFTP subsystem** over a child `ssh -s sftp` process and speak
//! the binary SFTP protocol to it, so:
//!   - directory listings carry real file-type metadata (no `ls -p` trailing-`/`
//!     guessing), and
//!   - remote path components are protocol fields, never concatenated into a
//!     remote `$SHELL -c` string — the command-injection class that
//!     `shell_quote`/`validate_arg` exist to defend against simply cannot occur
//!     here (a directory named `foo; rm -rf ~` is one inert listing entry).
//!
//! Only the *browse* path moves to SFTP. Remote **agent/terminal** tabs run over
//! `ssh -tt` (see #28b). Auth is shared with those paths: key/agent in
//! `BatchMode=yes`, or — when a password is supplied — fed to ssh via OpenSSH's
//! own `SSH_ASKPASS` (`services::ssh_common::make_askpass`; on Windows only with
//! OpenSSH ≥ 8.4, else the legacy `sshpass` fallback).

use std::process::Stdio;

use futures_util::StreamExt;
use openssh_sftp_client::{Sftp, SftpOptions};
use tokio::process::{Child, ChildStderr, Command};

use crate::services::ssh_common::{
    explain_ssh_error, ssh_base_args, ssh_master_base_args, ssh_passphrase_base_args,
    ssh_passphrase_master_base_args, ssh_password_base_args, ssh_password_master_base_args,
    validate_arg,
};

/// How much of ssh's stderr to keep. Auth failures are a line or two; the cap only
/// exists so a long-lived master that chatters for hours can't grow unbounded.
const STDERR_KEEP: usize = 4096;

/// How long the SFTP handshake may take before the attempt is abandoned.
///
/// `ConnectTimeout=10` bounds only the TCP connect: everything after it — the
/// key exchange, authentication, the host's `sftp-server` starting up — has no
/// bound of its own, so a host that accepts the connection and then stops
/// answering (a wedged login node, a middlebox holding the socket open) left
/// `Sftp::new` awaiting forever. The command that asked never returns, its ssh
/// child and askpass shim stay alive, and every retry adds another pair.
///
/// Generous on purpose: a busy cluster login node can spend tens of seconds on
/// PAM, a network home directory and the subsystem exec, and a timeout that
/// fires there would be a new failure rather than a fixed one. Past a minute,
/// nobody is still waiting for this connect.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Drain the child ssh's stderr to EOF on a background task, keeping the last
/// [`STDERR_KEEP`] bytes, and hand back a handle that yields them.
///
/// Draining is not optional once stderr is piped: the pooled master lives for the
/// whole session, and an unread pipe that fills would block ssh forever. So the
/// task runs to EOF (i.e. until ssh exits) either way — on the happy path it just
/// throws the bytes away.
///
/// This is what makes a headless failure legible at all. Both openers used to set
/// `Stdio::null()`, so when a wrong password made ssh exit, the SFTP handshake saw
/// only a closed pipe and the user got `pooled sftp connection failed: <EOF>` —
/// the actual reason ("Permission denied") had been thrown away.
fn drain_stderr(mut stderr: ChildStderr) -> tokio::task::JoinHandle<String> {
    use tokio::io::AsyncReadExt;
    tokio::spawn(async move {
        let mut kept: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break, // EOF, or the pipe broke — either way, done
                Ok(n) => {
                    kept.extend_from_slice(&chunk[..n]);
                    if kept.len() > STDERR_KEEP {
                        kept.drain(..kept.len() - STDERR_KEEP);
                    }
                }
            }
        }
        String::from_utf8_lossy(&kept).trim().to_string()
    })
}

/// Turn a failed SFTP handshake into the reason ssh actually gave. The handshake
/// error itself is just "the pipe closed"; the *why* is on ssh's stderr, so wait
/// briefly for the drain (ssh has already exited, so this returns at once) and
/// prefer its explanation. Falls back to the raw stderr, then to the handshake
/// error, so no information is ever lost — only re-ranked by usefulness.
/// Returns `(explained, raw stderr)`. The raw text is kept, not just folded into
/// the message, because the auth-method loop in [`open_any`] has to distinguish a
/// *local* failure (a wrong key passphrase) from a server-side one, and the
/// explained form is deliberately lossy.
async fn handshake_error(
    drain: Option<tokio::task::JoinHandle<String>>,
    err: String,
) -> (String, String) {
    let stderr = match drain {
        Some(handle) => tokio::time::timeout(std::time::Duration::from_secs(3), handle)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default(),
        None => String::new(),
    };
    if stderr.is_empty() {
        return (err, stderr);
    }
    let explained = explain_ssh_error(&stderr).unwrap_or_else(|| stderr.clone());
    (explained, stderr)
}

/// Prefer the prompt the askpass shim refused over whatever ssh said afterwards.
/// A refusal ends the handshake as a plain auth failure, so without this the user
/// is told "Permission denied" for a host that actually asked them for a
/// verification code — see `ssh_common::Askpass`. Must run before the guard drops.
#[cfg(any(unix, windows))]
fn refusal_override(askpass: &Option<crate::services::ssh_common::Askpass>, err: String) -> String {
    match askpass.as_ref().and_then(|a| a.refused_prompt()) {
        Some(prompt) => crate::services::ssh_common::unexpected_prompt_error(&prompt),
        None => err,
    }
}

/// One entry in a remote directory listing. Structurally identical to the
/// frontend-facing `commands::ssh::RemoteEntry`; kept separate so this service
/// stays free of the command layer (the command maps one to the other).
///
/// `size`/`modified_secs` come from the `readdir`-supplied attributes (no extra
/// round-trip), so the file browser can show the same metadata columns local
/// listings do. They are best-effort: a server that omits an attribute yields
/// `0`/`None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    /// File size in bytes from the listing attrs (`0` when absent or a dir).
    pub size: u64,
    /// Last-modified time as whole seconds since the Unix epoch, when reported.
    pub modified_secs: Option<u64>,
}

/// Build the argv for invoking the remote SFTP subsystem. `base` is the validated
/// option+target list (`ssh_base_args`/`ssh_password_base_args`), whose **last**
/// element is the `[user@]host` target. OpenSSH requires options before the
/// destination, so we splice `-s` in front of the target and append the
/// subsystem name `sftp` as the remote command: `ssh <opts> -s <target> sftp`.
fn sftp_subsystem_args(mut base: Vec<String>) -> Result<Vec<String>, String> {
    let target = base
        .pop()
        .ok_or_else(|| "internal: empty ssh base args".to_string())?;
    base.push("-s".to_string());
    base.push(target);
    base.push("sftp".to_string());
    Ok(base)
}

/// Spawn `ssh -s sftp` with piped stdin/stdout and hand the pipes to an `Sftp`
/// client. Returns the live client plus the child so the caller can await its exit
/// after dropping the client (dropping closes stdin, which makes ssh exit).
///
/// For password auth the secret is fed via OpenSSH's `SSH_ASKPASS` (on Windows
/// only when OpenSSH ≥ 8.4 honors `SSH_ASKPASS_REQUIRE`; older installs fall back
/// to `sshpass -e`). The askpass guard is kept in scope until the function
/// returns so the shim exists throughout the ssh handshake (auth happens during
/// `Sftp::new`, not merely at spawn).
async fn open_session(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
) -> Result<(Sftp, Child), String> {
    open_any(user, host, port, password, false).await
}

/// The auth-method loop both openers share: key/agent when no secret was typed,
/// otherwise each kind in [`secret_attempt_order`](crate::services::ssh_common::secret_attempt_order)
/// until one authenticates. `master` selects the master-owning argv builders.
///
/// Attempting more than once is what lets a single credential field serve a host
/// whose key is locked *and* a host that wants a login password, without the user
/// having to know which they are giving us — see `secret_attempt_order` for why
/// the order is a security property rather than a preference. The loop stops early
/// on a wrong *passphrase*, since retrying that secret as a password would send it
/// to the server.
async fn open_any(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    master: bool,
) -> Result<(Sftp, Child), String> {
    use crate::services::ssh_common::SecretKind;

    let what = if master {
        "pooled sftp connection failed"
    } else {
        "sftp connection failed"
    };

    let Some(pw) = password.filter(|p| !p.is_empty()) else {
        let base = if master {
            ssh_master_base_args(user, host, port)?
        } else {
            ssh_base_args(user, host, port)?
        };
        let args = sftp_subsystem_args(base)?;
        let mut cmd = ssh_command("ssh");
        cmd.args(&args);
        return match spawn_sftp(cmd, None, None, what).await {
            // A key-auth denial against a host whose key is encrypted on disk is
            // the one failure OpenSSH cannot explain itself: `BatchMode=yes` means
            // it never asked for the passphrase, so all the user sees is
            // "Permission denied (publickey)". Say what actually happened.
            Err((err, _)) => Err(
                match crate::services::ssh_common::locked_key_hint_async(user, host, port).await {
                    Some(hint) => format!("{err}\n\n{hint}"),
                    None => err,
                },
            ),
            Ok(session) => Ok(session),
        };
    };

    let kinds = crate::services::ssh_common::secret_attempt_order_async(user, host, port).await;
    let last = kinds.len() - 1;
    let mut error = String::new();
    for (i, kind) in kinds.iter().copied().enumerate() {
        if kind == SecretKind::Password {
            // Never release a password to a host key nobody has vetted. (A
            // passphrase needs no such gate — it never leaves this machine.)
            crate::services::ssh_common::guard_first_contact_async(host, port).await?;
        }
        let base = match (kind, master) {
            (SecretKind::Password, false) => ssh_password_base_args(user, host, port)?,
            (SecretKind::Password, true) => ssh_password_master_base_args(user, host, port)?,
            (SecretKind::KeyPassphrase, false) => ssh_passphrase_base_args(user, host, port)?,
            (SecretKind::KeyPassphrase, true) => ssh_passphrase_master_base_args(user, host, port)?,
        };
        let args = sftp_subsystem_args(base)?;
        let (cmd, askpass) = secret_cmd(kind, pw, &args)?;
        match spawn_sftp(cmd, askpass, Some(kind), what).await {
            Ok(session) => return Ok(session),
            Err((explained, rejected_locally)) => {
                error = explained;
                // The secret is definitively a wrong passphrase — trying it
                // against the server would disclose it for nothing.
                if rejected_locally || i == last {
                    return Err(error);
                }
            }
        }
    }
    Err(error)
}

/// Build the `ssh` command for one secret-auth attempt, with the askpass shim for
/// `kind` attached. Returns the guard alongside, which the caller must keep alive
/// until the handshake completes (see [`spawn_sftp`], which owns it).
fn secret_cmd(
    kind: crate::services::ssh_common::SecretKind,
    secret: &str,
    args: &[String],
) -> Result<(Command, Option<crate::services::ssh_common::Askpass>), String> {
    #[cfg(unix)]
    {
        let mut cmd = ssh_command("ssh");
        cmd.args(args);
        let ap = crate::services::ssh_common::make_askpass_for(kind, secret, args)?;
        for (k, v) in ap.env_vars() {
            cmd.env(k, v);
        }
        Ok((cmd, Some(ap)))
    }
    #[cfg(not(unix))]
    {
        // Windows: askpass when OpenSSH ≥ 8.4, else the sshpass fallback.
        if crate::services::ssh_common::ssh_supports_askpass() {
            let mut cmd = ssh_command("ssh");
            cmd.args(args);
            let ap = crate::services::ssh_common::make_askpass_for(kind, secret, args)?;
            for (k, v) in ap.env_vars() {
                cmd.env(k, v);
            }
            Ok((cmd, Some(ap)))
        } else if kind == crate::services::ssh_common::SecretKind::KeyPassphrase {
            // `sshpass` answers the *password* prompt only; it has no way to feed a
            // key passphrase. Say so rather than silently sending it to the server.
            Err(
                "unlocking a passphrase-protected SSH key needs OpenSSH 8.4+ — update \
                 OpenSSH, or run `ssh-add` to load the key before connecting"
                    .to_string(),
            )
        } else if crate::services::ssh_common::sshpass_available() {
            let mut cmd = ssh_command("sshpass");
            cmd.arg("-e"); // read the password from $SSHPASS, never argv
            cmd.env("SSHPASS", secret);
            cmd.arg("ssh");
            cmd.args(args);
            Ok((cmd, None))
        } else {
            Err(
                "password auth needs OpenSSH 8.4+ or sshpass — update OpenSSH, \
                 install sshpass, or set up SSH keys"
                    .to_string(),
            )
        }
    }
}

/// An async [`Command`] for `bin` built through [`crate::paths::command_no_window`],
/// like every other ssh spawn: a trusted helper (`ssh`) comes from the root-owned
/// system directories first (#861), PATH is the effective one, and Windows gets
/// no console window.
fn ssh_command(bin: &str) -> Command {
    Command::from(crate::paths::command_no_window(bin))
}

/// Spawn `cmd` (an `ssh -s sftp`) and complete the SFTP handshake over its pipes.
/// Takes ownership of the askpass guard so the shim outlives authentication —
/// which happens during `Sftp::new`, not at spawn.
///
/// On failure returns `(explained, raw stderr)`: the explained form is what the
/// user reads, while the raw text is what [`open_any`] inspects to decide whether
/// another auth method is worth trying.
async fn spawn_sftp(
    mut cmd: Command,
    askpass: Option<crate::services::ssh_common::Askpass>,
    kind: Option<crate::services::ssh_common::SecretKind>,
    what: &str,
) -> Result<(Sftp, Child), (String, bool)> {
    let launch = |e: std::io::Error| (format!("failed to launch ssh for sftp: {e}"), false);
    let missing = |s: &str| (s.to_string(), false);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Piped, not null: this is where ssh says *why* it failed (see drain_stderr).
        // This is the connect the headless Connect modal drives, so its error text
        // is what the user reads — it must carry the reason, not an EOF.
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(launch)?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| missing("ssh stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| missing("ssh stdout unavailable"))?;
    let drain = child.stderr.take().map(drain_stderr);

    let handshake = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        Sftp::new(stdin, stdout, SftpOptions::default()),
    )
    .await;
    let handshake = match handshake {
        Ok(result) => result,
        Err(_) => {
            // Nothing came back in time. Kill the child rather than leaving it
            // (and its askpass shim) holding a connection nobody is waiting on
            // any more — dropping the handshake future closes ssh's stdin, but
            // an ssh stuck before that reads no EOF.
            let _ = child.start_kill();
            return Err((
                format!(
                    "{what}: the host accepted the connection but did not complete the \
                     SFTP handshake within {}s",
                    HANDSHAKE_TIMEOUT.as_secs()
                ),
                false,
            ));
        }
    };
    match handshake {
        Ok(sftp) => Ok((sftp, child)),
        Err(e) => {
            let (err, raw) = handshake_error(drain, format!("{what}: {e}")).await;
            // Both reads must happen before the guard drops (it deletes its files).
            #[cfg(any(unix, windows))]
            let rejected = kind.is_some_and(|k| {
                crate::services::ssh_common::secret_rejected_locally(k, askpass.as_ref(), &raw)
            });
            #[cfg(not(any(unix, windows)))]
            let rejected = kind.is_some_and(|k| {
                k == crate::services::ssh_common::SecretKind::KeyPassphrase
                    && crate::services::ssh_common::is_wrong_passphrase(&raw)
            });
            #[cfg(any(unix, windows))]
            let err = refusal_override(&askpass, err);
            let err = if rejected {
                crate::services::ssh_common::wrong_passphrase_error()
            } else {
                err
            };
            Err((err, rejected))
        }
    }
}

/// Open a **master-owning, persistent** SFTP session for the pooled remote
/// connection (Phase 0; `services::remote`). Unlike [`open_session`] — a one-shot
/// per-call session for the project dialog — this rides `ControlMaster=auto`
/// (Unix), so it *creates and persists* the shared multiplexing master that
/// agent tabs, git-over-ssh, and later SFTP channels reuse without
/// re-authenticating. Returns the live client plus the `ssh` child, whose
/// lifetime keeps the master alive; the caller pools both and tears them down on
/// deactivation/exit.
pub async fn open_pooled_session(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
) -> Result<(Sftp, Child), String> {
    // Ensure the control-socket directory exists before ssh binds the master.
    #[cfg(not(target_os = "windows"))]
    let _ = std::fs::create_dir_all(crate::services::ssh_exec::control_dir());

    open_any(user, host, port, password, true).await
}

/// Wait for the ssh child to exit after the `Sftp` client has been dropped, so we
/// don't leave a zombie. Best-effort — a stuck child is not worth failing on.
async fn reap(mut child: Child) {
    let _ = child.wait().await;
}

/// Resolve the remote default directory (the SFTP server's notion of `.`, i.e.
/// the login/home directory) via REALPATH — no remote `pwd` shell-out.
pub async fn default_dir(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
) -> Result<String, String> {
    let (sftp, child) = open_session(user, host, port, password).await?;
    let mut fs = sftp.fs();
    let result = fs
        .canonicalize(".")
        .await
        .map_err(|e| format!("sftp realpath failed: {e}"))
        .map(|p| p.to_string_lossy().into_owned());
    drop(fs);
    let _ = sftp.close().await;
    reap(child).await;
    let path = result?;
    if path.trim().is_empty() {
        return Err("remote realpath returned no path".to_string());
    }
    Ok(path)
}

/// List one remote directory over SFTP. An empty `path` lists the remote default
/// (home) directory. Entries carry real SFTP file-type metadata.
pub async fn list_dir(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<Vec<Entry>, String> {
    let path = path.trim();
    // Leading-`-`/control-char guard is no longer load-bearing (SFTP paths are
    // protocol fields, not shell tokens) but kept as cheap defense in depth.
    if !path.is_empty() {
        validate_arg("path", path)?;
    }
    let target = if path.is_empty() { "." } else { path };

    let (sftp, child) = open_session(user, host, port, password).await?;
    let result = list_dir_on(&sftp, target).await;
    let _ = sftp.close().await;
    reap(child).await;

    result
}

/// List one remote directory on an **already-open** `Sftp` session — the shared
/// core used by both the one-shot [`list_dir`] (which owns its session) and the
/// pooled file-browse path (Phase 2: `commands::fs::list_dir` rides the
/// persistent session from `services::remote`). An empty `path` lists the SFTP
/// default (home) directory. Entries carry real SFTP file-type metadata plus the
/// `readdir`-supplied size/mtime.
pub async fn list_dir_on(sftp: &Sftp, path: &str) -> Result<Vec<Entry>, String> {
    let path = path.trim();
    // Leading-`-`/control-char guard is no longer load-bearing (SFTP paths are
    // protocol fields, not shell tokens) but kept as cheap defense in depth.
    if !path.is_empty() {
        validate_arg("path", path)?;
    }
    let target = if path.is_empty() { "." } else { path };

    let mut fs = sftp.fs();
    let listing = read_entries(&mut fs, target).await;
    drop(fs);
    Ok(finalize_entries(listing?))
}

/// Directory / symlink / other, as reported by a `readdir` entry's lstat-style
/// `file_type()`. Symlinks need a follow-up stat to learn what they point at.
enum RawKind {
    Dir,
    Symlink,
    Other,
}

/// Lstat-typed kind of a directory entry for the sync walker — the entry's OWN
/// type, never a symlink's target (G3: the recursive sync must NOT follow host
/// symlinks, or a `link -> /etc` would exfiltrate host files into the mirror).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncKind {
    Dir,
    File,
    Symlink,
    Other,
}

/// One raw (lstat-typed) directory entry for the sync walker.
#[derive(Debug, Clone)]
pub struct RawEntry {
    pub name: String,
    pub kind: SyncKind,
    /// Size in bytes from the listing attrs (`0` when absent).
    pub size: u64,
    /// Last-modified time as whole seconds since the Unix epoch, when reported.
    pub modified_secs: Option<u64>,
    /// Permission bits (`0o777` mask, no special bits) from the listing attrs, when reported —
    /// what a pull gives the mirror copy, so a host `0755` script stays
    /// executable locally.
    pub mode: Option<u32>,
}

/// Whether a `readdir` name is exactly ONE path component the local side may
/// join onto a destination directory (#863). A real SFTP server never returns a
/// name holding a separator, but a hostile remote *account* can answer with its
/// own `sftp` (a forced command) and hand back `../../.config/autostart/x.desktop`
/// — which every walker joins onto the mirror. So: not blank, not `.`/`..`, no
/// `/`, no `\` (a separator on a Windows client), no NUL. Pure, unit-tested.
pub fn is_single_component_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// List one remote directory on an open session WITHOUT following symlinks — the
/// listing the recursive sync walker uses. Unlike [`list_dir_on`] (which follows
/// symlinks so a symlink-to-dir is navigable in the picker), every entry reports
/// its own lstat-style type, so the walker can skip symlinks/special files (G3)
/// and recurse only into real directories. Anything that is not a single path
/// component ([`is_single_component_name`]: `.`/`..`/blank, or a name carrying a
/// separator or NUL) is dropped — the walker joins these onto the local mirror.
/// No sorting (the walker doesn't need it).
pub async fn list_dir_raw_on(sftp: &Sftp, path: &str) -> Result<Vec<RawEntry>, String> {
    let path = path.trim();
    if !path.is_empty() {
        validate_arg("path", path)?;
    }
    let target = if path.is_empty() { "." } else { path };

    let mut fs = sftp.fs();
    let dir = fs
        .open_dir(target)
        .await
        .map_err(|e| format!("sftp open_dir failed: {e}"))?;
    let mut rd = Box::pin(dir.read_dir());
    let mut out: Vec<RawEntry> = Vec::new();
    while let Some(item) = rd.next().await {
        let entry = item.map_err(|e| format!("sftp read_dir failed: {e}"))?;
        let name = entry.filename().to_string_lossy().into_owned();
        if !is_single_component_name(&name) {
            continue;
        }
        let meta = entry.metadata();
        let size = meta.len().unwrap_or(0);
        let modified_secs = meta.modified().map(|t| t.as_duration().as_secs());
        let mode = permission_bits(&meta);
        let kind = match entry.file_type() {
            Some(t) if t.is_dir() => SyncKind::Dir,
            Some(t) if t.is_symlink() => SyncKind::Symlink,
            Some(t) if t.is_file() => SyncKind::File,
            _ => SyncKind::Other,
        };
        out.push(RawEntry {
            name,
            kind,
            size,
            modified_secs,
            mode,
        });
    }
    Ok(out)
}

/// Build the path to a directory child for a follow-up stat. `target` is the
/// listed directory (`"."` for the SFTP home, otherwise an absolute path); the
/// child is resolved relative to it. Pure, so it is unit-tested.
fn resolve_child_path(target: &str, name: &str) -> String {
    if target == "." || target.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", target.trim_end_matches('/'), name)
    }
}

/// Open `target` and drain its `ReadDir` stream into raw `Entry`s (unsorted,
/// unfiltered). Split out so `list_dir`'s session teardown always runs.
///
/// Two passes: pass 1 drains the listing (the `readdir` `file_type()` is
/// lstat-style, so a symlink reports as a symlink, not its target); pass 2
/// follow-stats each **symlink** so a symlink-to-directory is flagged `is_dir`
/// and is navigable in the picker. Only symlinks cost an extra round-trip; a
/// broken/inaccessible link resolves to non-dir.
async fn read_entries(
    fs: &mut openssh_sftp_client::fs::Fs,
    target: &str,
) -> Result<Vec<Entry>, String> {
    let dir = fs
        .open_dir(target)
        .await
        .map_err(|e| format!("sftp open_dir failed: {e}"))?;
    // `ReadDir` is `!Unpin`; `Pin<Box<_>>` is `Unpin` so `StreamExt::next` applies.
    let mut rd = Box::pin(dir.read_dir());
    let mut raw: Vec<(String, RawKind, u64, Option<u64>)> = Vec::new();
    while let Some(item) = rd.next().await {
        let entry = item.map_err(|e| format!("sftp read_dir failed: {e}"))?;
        let name = entry.filename().to_string_lossy().into_owned();
        // `metadata()` here is the `readdir`-supplied attrs — no extra round-trip.
        let meta = entry.metadata();
        let size = meta.len().unwrap_or(0);
        let modified_secs = meta.modified().map(|t| t.as_duration().as_secs());
        let kind = match entry.file_type() {
            Some(t) if t.is_dir() => RawKind::Dir,
            Some(t) if t.is_symlink() => RawKind::Symlink,
            _ => RawKind::Other,
        };
        raw.push((name, kind, size, modified_secs));
    }
    drop(rd); // release the directory handle before the follow-up stats

    let mut out: Vec<Entry> = Vec::with_capacity(raw.len());
    for (name, kind, size, modified_secs) in raw {
        let is_dir = match kind {
            RawKind::Dir => true,
            RawKind::Other => false,
            // `metadata` follows the link (vs `symlink_metadata`), so this is the
            // *target's* type. Errors (broken/denied link) fall back to non-dir.
            RawKind::Symlink => {
                let child = resolve_child_path(target, &name);
                fs.metadata(&child)
                    .await
                    .ok()
                    .and_then(|m| m.file_type())
                    .map(|t| t.is_dir())
                    .unwrap_or(false)
            }
        };
        out.push(Entry {
            name,
            is_dir,
            // Mirror the local lister: directories report size 0.
            size: if is_dir { 0 } else { size },
            modified_secs,
        });
    }
    Ok(out)
}

/// Drop `.`/`..`/blank names, and names holding `/` or NUL (no POSIX server can
/// have one; a hostile fake `sftp` can — #863, callers join names onto local
/// paths), then sort dirs-first and case-insensitively by name — the exact
/// ordering the old `parse_ls_output` produced, so the browser UI is unchanged.
/// `\` is kept here: it is a legal Linux file name byte and this is the picker's
/// listing; callers that write locally check [`is_single_component_name`].
/// Pure, so it is unit-tested without a live host.
pub(crate) fn finalize_entries(entries: Vec<Entry>) -> Vec<Entry> {
    let mut entries: Vec<Entry> = entries
        .into_iter()
        .filter(|e| {
            !e.name.is_empty()
                && e.name != "."
                && e.name != ".."
                && !e.name.contains('/')
                && !e.name.contains('\0')
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

// ── Write/read half (mount-free remote, Phase 3) ────────────────────────────
//
// The counterpart to the read/list half above: file I/O (read / write / create /
// delete / mkdir / rename / metadata) over SFTP, used by `commands::fs` to route
// remote-project file operations. Mirrors the `list_dir` / `list_dir_on` shape —
// a `*_on(&Sftp, …)` core that runs on an already-open (pooled) session, plus a
// one-shot wrapper that opens its own session and tears it down (teardown runs
// even on error). SFTP paths are protocol fields, never shell tokens, so no
// quoting/validation against injection is needed here (see the module header).

/// The parent directory of a remote (POSIX) path, or `None` for a bare leaf
/// name. `"/a/b"` → `"/a"`, `"/a"` → `"/"`, `"a"` → `None`. Pure, unit-tested.
fn remote_parent(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(i) => Some(trimmed[..i].to_string()),
        None => None,
    }
}

/// Every directory prefix of `path`, shallowest-first up to `path` itself:
/// `"/a/b/c"` → `["/a", "/a/b", "/a/b/c"]`. Used to emulate `mkdir -p` (SFTP
/// MKDIR is single-level). Pure, unit-tested.
fn ancestor_dirs(path: &str) -> Vec<String> {
    let trimmed = path.trim_end_matches('/');
    let absolute = trimmed.starts_with('/');
    let mut out = Vec::new();
    let mut acc = String::new();
    for comp in trimmed.split('/').filter(|c| !c.is_empty()) {
        if acc.is_empty() && !absolute {
            acc.push_str(comp);
        } else {
            acc.push('/');
            acc.push_str(comp);
        }
        out.push(acc.clone());
    }
    out
}

/// Create `path` and any missing parents on an open session — the remote
/// analogue of `std::fs::create_dir_all`. A no-op when `path` already exists
/// (any kind). SFTP has no atomic `mkdir -p`, so each missing ancestor is created
/// in turn; a level that already exists (or a create race) is tolerated.
pub async fn mkdir_on(sftp: &Sftp, path: &str) -> Result<(), String> {
    let mut fs = sftp.fs();
    if fs.metadata(path).await.is_ok() {
        return Ok(()); // already present — nothing to create
    }
    for prefix in ancestor_dirs(path) {
        if fs.metadata(&prefix).await.is_ok() {
            continue;
        }
        if let Err(e) = fs.create_dir(&prefix).await {
            // A concurrent create / pre-existing dir is fine; only a still-missing
            // level after the attempt is a real failure.
            if fs.metadata(&prefix).await.is_err() {
                return Err(format!("sftp mkdir failed for '{prefix}': {e}"));
            }
        }
    }
    Ok(())
}

/// Ensure the parent directory of `path` exists (mirrors the `create_dir_all`
/// the local file writers do before a write).
async fn ensure_parent_dirs_on(sftp: &Sftp, path: &str) -> Result<(), String> {
    if let Some(parent) = remote_parent(path) {
        mkdir_on(sftp, &parent).await?;
    }
    Ok(())
}

/// Read a remote file's whole contents on an already-open session.
pub async fn read_file_on(sftp: &Sftp, path: &str) -> Result<Vec<u8>, String> {
    let mut fs = sftp.fs();
    let bytes = fs
        .read(path)
        .await
        .map_err(|e| format!("sftp read failed: {e}"))?;
    Ok(bytes.to_vec())
}

/// Write (create/truncate) a remote file with `bytes`, creating missing parent
/// directories first — mirrors the local writers' `create_dir_all` + `write`.
pub async fn write_file_on(sftp: &Sftp, path: &str, bytes: &[u8]) -> Result<(), String> {
    ensure_parent_dirs_on(sftp, path).await?;
    let mut fs = sftp.fs();
    fs.write(path, bytes)
        .await
        .map_err(|e| format!("sftp write failed: {e}"))
}

/// Create an empty remote file (truncating an existing one), creating missing
/// parents — the remote analogue of `fs::File::create`.
pub async fn create_file_on(sftp: &Sftp, path: &str) -> Result<(), String> {
    write_file_on(sftp, path, &[]).await
}

/// Chunk size for the streaming transfers below — bounded so an arbitrarily large
/// file never lives fully in memory (the whole-file `read_file_on`/`write_file_on`
/// buffer everything, which is why the git-lockstep bundle transport streams; #28n
/// Phase 3).
const STREAM_CHUNK: usize = 256 * 1024;

/// Upload a local file to the host in bounded chunks (never buffering the whole
/// file), creating missing parent directories first. The remote streaming analogue
/// of `write_file_on` for large payloads (git bundles at initial pairing).
pub async fn upload_file_streaming_on(
    sftp: &Sftp,
    local_path: &std::path::Path,
    remote_path: &str,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    ensure_parent_dirs_on(sftp, remote_path).await?;
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("open local bundle failed: {e}"))?;
    let mut remote = sftp
        .create(remote_path)
        .await
        .map_err(|e| format!("sftp create failed: {e}"))?;
    let mut buf = vec![0u8; STREAM_CHUNK];
    loop {
        let n = local
            .read(&mut buf)
            .await
            .map_err(|e| format!("read local bundle failed: {e}"))?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("sftp streaming write failed: {e}"))?;
    }
    Ok(())
}

/// Download a host file to a local path in bounded chunks (never buffering the
/// whole file), creating missing parent directories first. The remote streaming
/// analogue of `read_file_on` for large payloads (git bundles at initial pairing).
pub async fn download_file_streaming_on(
    sftp: &Sftp,
    remote_path: &str,
    local_path: &std::path::Path,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    if let Some(parent) = local_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let mut remote = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("sftp open failed: {e}"))?;
    let mut local = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| format!("create local bundle failed: {e}"))?;
    loop {
        let buf = bytes::BytesMut::with_capacity(STREAM_CHUNK);
        match remote
            .read(STREAM_CHUNK as u32, buf)
            .await
            .map_err(|e| format!("sftp streaming read failed: {e}"))?
        {
            Some(chunk) if !chunk.is_empty() => local
                .write_all(&chunk)
                .await
                .map_err(|e| format!("write local bundle failed: {e}"))?,
            _ => break,
        }
    }
    local
        .flush()
        .await
        .map_err(|e| format!("flush local bundle failed: {e}"))
}

/// Remove a remote file on an open session.
pub async fn remove_file_on(sftp: &Sftp, path: &str) -> Result<(), String> {
    let mut fs = sftp.fs();
    fs.remove_file(path)
        .await
        .map_err(|e| format!("sftp remove_file failed: {e}"))
}

/// Recursively remove a remote directory tree on an open session — the remote
/// analogue of `std::fs::remove_dir_all` (SFTP RMDIR only removes an *empty*
/// directory, so children are listed and removed depth-first first).
///
/// The listing is the **lstat-typed** one ([`list_dir_raw_on`]), never
/// [`list_dir_on`], and that is the whole safety property: `list_dir_on`
/// follow-stats a symlink so the picker can navigate a link-to-directory, so a
/// `data -> /scratch/<user>/data` link inside the tree read back as `is_dir` and
/// the recursion emptied the link's **target** — bytes outside the deleted tree,
/// on a machine where such links are the normal way to reach the parallel
/// filesystem. A link of either kind is unlinked (SFTP REMOVE does not follow),
/// exactly as `std::fs::remove_dir_all` does locally.
pub async fn remove_dir_on(sftp: &Sftp, path: &str) -> Result<(), String> {
    // List the directory (errors → empty/leaf, fall through to RMDIR).
    let entries = list_dir_raw_on(sftp, path).await.unwrap_or_default();
    for entry in &entries {
        let child = format!("{}/{}", path.trim_end_matches('/'), entry.name);
        if entry.kind == SyncKind::Dir {
            Box::pin(remove_dir_on(sftp, &child)).await?;
        } else {
            remove_file_on(sftp, &child).await?;
        }
    }
    let mut fs = sftp.fs();
    fs.remove_dir(path)
        .await
        .map_err(|e| format!("sftp remove_dir failed: {e}"))
}

/// Rename/move a remote path on an open session.
pub async fn rename_on(sftp: &Sftp, from: &str, to: &str) -> Result<(), String> {
    let mut fs = sftp.fs();
    fs.rename(from, to)
        .await
        .map_err(|e| format!("sftp rename failed: {e}"))
}

/// `(size, modified_secs)` for a remote path on an open session. `size` is `0`
/// and `modified_secs` is `None` when the server omits the attribute.
pub async fn metadata_on(sftp: &Sftp, path: &str) -> Result<(u64, Option<u64>), String> {
    metadata_with_mode_on(sftp, path)
        .await
        .map(|(size, modified, _)| (size, modified))
}

/// [`metadata_on`] plus the permission bits (`0o777` mask), `None` when the
/// server omits them — one stat for a pull that must carry the host's mode.
pub async fn metadata_with_mode_on(
    sftp: &Sftp,
    path: &str,
) -> Result<(u64, Option<u64>, Option<u32>), String> {
    let mut fs = sftp.fs();
    let meta = fs
        .metadata(path)
        .await
        .map_err(|e| format!("sftp metadata failed: {e}"))?;
    let size = meta.len().unwrap_or(0);
    let modified = meta.modified().map(|t| t.as_duration().as_secs());
    Ok((size, modified, permission_bits(&meta)))
}

/// The permission bits (`0o777`: rwx for the three classes) of SFTP attrs,
/// `None` when the server sent none. Never setuid/setgid/sticky: the host is
/// attacker-controlled, and a mirror copy must not carry them.
fn permission_bits(meta: &openssh_sftp_client::metadata::MetaData) -> Option<u32> {
    meta.permissions().map(|p| p.as_raw().bits() & 0o777)
}

/// Like [`metadata_on`], but the three outcomes stay distinct: `Ok(Some(..))`
/// when the path exists, `Ok(None)` ONLY when the server answered the stat with
/// the SFTP `NoSuchFile` status — the one response that positively means "gone"
/// — and `Err` for everything else (permission denied, dropped session, protocol
/// failure), which means "could not check", never "absent". The distinction is
/// load-bearing for the sync-manifest prune: a helper that collapses a transient
/// failure into "gone" is how one dropped session wipes the tracked state.
pub async fn metadata_opt_on(
    sftp: &Sftp,
    path: &str,
) -> Result<Option<(u64, Option<u64>)>, String> {
    use openssh_sftp_client::error::{Error as SftpClientError, SftpErrorKind};
    let mut fs = sftp.fs();
    match fs.metadata(path).await {
        Ok(meta) => {
            let size = meta.len().unwrap_or(0);
            let modified = meta.modified().map(|t| t.as_duration().as_secs());
            Ok(Some((size, modified)))
        }
        Err(SftpClientError::SftpError(SftpErrorKind::NoSuchFile, _)) => Ok(None),
        Err(e) => Err(format!("sftp metadata failed: {e}")),
    }
}

// ── One-shot wrappers (open a session, run one op, tear it down) ─────────────
//
// The cold-pool fallback for `commands::fs` (mirrors `list_dir` over
// `list_dir_on`). Key/agent auth when `password` is `None`; teardown always runs.

/// Open a one-shot session, run `op` against it, then close + reap (even on op
/// error). Cuts the per-wrapper boilerplate while keeping teardown guaranteed.
async fn with_oneshot<F, Fut, T>(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    op: F,
) -> Result<T, String>
where
    F: FnOnce(Sftp) -> Fut,
    Fut: std::future::Future<Output = (Sftp, Result<T, String>)>,
{
    let (sftp, child) = open_session(user, host, port, password).await?;
    let (sftp, result) = op(sftp).await;
    let _ = sftp.close().await;
    reap(child).await;
    result
}

/// One-shot remote file read.
pub async fn read_file(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<Vec<u8>, String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = read_file_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote file write (create/truncate, creating parents).
pub async fn write_file(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = write_file_on(&sftp, path, bytes).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote empty-file create.
pub async fn create_file(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = create_file_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote `mkdir -p`.
pub async fn mkdir(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = mkdir_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote file remove.
pub async fn remove_file(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = remove_file_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote recursive directory remove.
pub async fn remove_dir(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = remove_dir_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote rename/move.
pub async fn rename(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    from: &str,
    to: &str,
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = rename_on(&sftp, from, to).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote metadata (`(size, modified_secs)`).
pub async fn metadata(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<(u64, Option<u64>), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = metadata_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(name: &str, is_dir: bool) -> Entry {
        Entry {
            name: name.to_string(),
            is_dir,
            size: 0,
            modified_secs: None,
        }
    }

    #[test]
    fn subsystem_args_splice_dash_s_before_target() {
        // base = [..opts.., target]; result = [..opts.., -s, target, sftp].
        let base = vec![
            "-o".to_string(),
            "BatchMode=yes".to_string(),
            "alice@host.example".to_string(),
        ];
        let args = sftp_subsystem_args(base).unwrap();
        assert_eq!(
            args,
            vec!["-o", "BatchMode=yes", "-s", "alice@host.example", "sftp"]
        );
    }

    #[test]
    fn finalize_sorts_dirs_first_then_name_ci() {
        let raw = vec![
            e("zebra.txt", false),
            e("Apple", true),
            e("banana.txt", false),
            e("Cherry", true),
        ];
        let names: Vec<_> = finalize_entries(raw).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["Apple", "Cherry", "banana.txt", "zebra.txt"]);
    }

    #[test]
    fn finalize_filters_dot_and_dotdot_and_blanks() {
        let raw = vec![e(".", true), e("..", true), e("", false), e("real", true)];
        let names: Vec<_> = finalize_entries(raw).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["real"]);
    }

    #[test]
    fn finalize_drops_names_carrying_a_separator_or_nul() {
        // #863: a fake `sftp` can answer a readdir with a traversal "name".
        let raw = vec![
            e("../../.config/autostart/x.desktop", false),
            e("a/b", true),
            e("nul\0byte", false),
            e("back\\slash", false),
            e("real", false),
        ];
        let names: Vec<_> = finalize_entries(raw).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["back\\slash", "real"]);
    }

    #[test]
    fn single_component_names_refuse_traversal_and_separators() {
        for bad in [
            "",
            ".",
            "..",
            "../x",
            "../../.config/autostart/x.desktop",
            "/etc/passwd",
            "a/b",
            "..\\x",
            "a\\b",
            "nul\0byte",
        ] {
            assert!(!is_single_component_name(bad), "{bad:?} must be refused");
        }
        for good in ["a.txt", ".hidden", "..double-dot-prefix", "with space", "é"] {
            assert!(is_single_component_name(good), "{good:?} must pass");
        }
    }

    #[test]
    fn finalize_keeps_hidden_entries() {
        let raw = vec![e(".config", true), e(".bashrc", false), e("visible", false)];
        let out = finalize_entries(raw);
        assert!(out.iter().any(|x| x.name == ".config" && x.is_dir));
        assert!(out.iter().any(|x| x.name == ".bashrc" && !x.is_dir));
    }

    #[test]
    fn child_path_joins_against_target_or_home() {
        // "." / empty target → bare name (resolved against the SFTP home).
        assert_eq!(resolve_child_path(".", "link"), "link");
        assert_eq!(resolve_child_path("", "link"), "link");
        // Absolute target → joined, with no doubled slash.
        assert_eq!(resolve_child_path("/home/u", "link"), "/home/u/link");
        assert_eq!(resolve_child_path("/home/u/", "link"), "/home/u/link");
        // Root stays a single leading slash.
        assert_eq!(resolve_child_path("/", "link"), "/link");
    }

    #[test]
    fn remote_parent_of_paths() {
        assert_eq!(remote_parent("/a/b/c"), Some("/a/b".to_string()));
        assert_eq!(remote_parent("/a/b/c/"), Some("/a/b".to_string()));
        assert_eq!(remote_parent("/a"), Some("/".to_string()));
        // A bare leaf name (relative) has no parent.
        assert_eq!(remote_parent("leaf"), None);
        assert_eq!(remote_parent("/"), None);
    }

    #[test]
    fn ancestor_dirs_walks_absolute_prefixes() {
        assert_eq!(
            ancestor_dirs("/a/b/c"),
            vec!["/a".to_string(), "/a/b".to_string(), "/a/b/c".to_string()]
        );
        // Trailing slash trimmed; root-only path has no components.
        assert_eq!(ancestor_dirs("/"), Vec::<String>::new());
        // Relative path keeps the first component bare.
        assert_eq!(
            ancestor_dirs("a/b"),
            vec!["a".to_string(), "a/b".to_string()]
        );
    }

    #[test]
    fn finalize_injection_named_dir_is_one_inert_entry() {
        // The whole point: a hostile directory name is just data here.
        let raw = vec![e("foo; rm -rf ~", true), e("$(touch pwned)", false)];
        let out = finalize_entries(raw);
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|x| x.name == "foo; rm -rf ~" && x.is_dir));
    }
}
