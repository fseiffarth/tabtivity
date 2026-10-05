//! Shared SSH argv + validation helpers for remote (SSH) projects.
//!
//! These are the single source of truth for building validated `ssh` argv and
//! the `[user@]host` target used by every remote path: the SFTP sessions
//! (`services::sftp`), the pooled connection (`services::remote`), remote agent
//! tabs and git-over-ssh (`services::ssh_exec`, `commands::git`), the reachability
//! probe (`commands::ssh`), and `commands::git_publish`.
//!
//! Every argument is passed to the child process as a separate argv item (never a
//! shell string), and values that could be mistaken for an option (a leading `-`)
//! or that contain control characters are rejected. The one unavoidable remote
//! shell string (the trailing command ssh hands to the remote `$SHELL -c`) is
//! single-quoted by its caller; see `ssh_exec::shell_quote`.
//!
//! This module was extracted from the former `services::ssh_mount` when the
//! sshfs/FUSE mount was removed (mount-free remote model, see
//! `docs/mountfree_remote_plan.md`): remote projects are SSH/SFTP-native and no
//! longer mount a local FUSE filesystem, but the SSH validation/argv helpers the
//! mount once shared are still needed by every remote path.

/// Reject values that contain control characters (incl. NUL/newline), that carry
/// Unicode *format* characters (bidi overrides, zero-width joiners), or that
/// begin with `-` (which `ssh`/`ls` would treat as an option). Empty values are
/// allowed here; callers decide whether emptiness is acceptable.
///
/// The format-character half is separate from the control half because
/// `char::is_control` does **not** cover it: it tests the Unicode `Cc` category
/// only, so `U+202E RIGHT-TO-LEFT OVERRIDE`, `U+200B ZERO WIDTH SPACE` and the
/// isolate/embedding controls (`Cf`) all passed a check whose name reads as
/// though it caught them. That matters here because every value reaching this
/// function is one a human is shown and asked to trust — a host, a login, a
/// remote path, an `.ovpn` config — and a machine imported from a shared file
/// (`commands::global_machines`) is chosen from a *list*, where a host rendering
/// as `gpu-01.trusted.example` while dialling somewhere else is the entire
/// attack. `web_safety::strip_format_controls` is the display-side answer for
/// text that must still render; a connection target is not display text, so it
/// is refused outright rather than silently rewritten into a different host.
pub fn validate_arg(label: &str, value: &str) -> Result<(), String> {
    if value.starts_with('-') {
        return Err(format!("{label} must not start with '-'"));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(format!("{label} contains invalid control characters"));
    }
    if value
        .chars()
        .any(crate::services::web_safety::is_format_char)
    {
        return Err(format!("{label} contains invalid formatting characters"));
    }
    Ok(())
}

// ── Dial policy: who asked for this connection ──────────────────────────────
//
// `settings.hpc_hosts` promises that Tabtivity never reaches a tagged machine *by
// itself* (`docs/context/hpc_careful_mode.md`). That promise used to be kept
// only in TypeScript, so every backend path that opens an `ssh` child — a
// reachability probe, a tab respawned at relaunch, a readiness poll, an
// auto-connect — went on dialling a cluster login node unattended, and each one
// succeeded, because the host has a saved password.
//
// The rule is therefore enforced where an ssh command is **built**, not at the
// call sites: every remote path in this tree funnels through one of the argv
// builders below, so a caller cannot reach a tagged host by forgetting a check
// it never knew existed. `ssh_pty_args` (`services::ssh_exec`) is the seventh
// builder and carries the same call.
//
// The intent cannot ride the builders' signatures — they are reached from a
// dozen layers with no idea *why* they are running — so it is ambient and keyed
// by target: a user-initiated command holds a [`UserDial`] for the machine it is
// about, and a pooled connection the user opened holds one for as long as it is
// connected (which is what keeps a tagged project usable once connected: work on
// a connection a person made is not Tabtivity connecting by itself). Everything
// else is [`DialIntent::Background`], the safe default — a wrong "background"
// costs one confirmation dialog, a wrong "user-initiated" costs the promise.

/// Why an ssh connection is about to be opened, as far as the *policy* cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialIntent {
    /// A person asked for this, at this machine, now.
    UserInitiated,
    /// Anything else: a loop, a probe, a relaunch, an armed auto-connect.
    Background,
}

// How a command declares its intent, and why there are exactly two shapes:
//
//   1. **Always a gesture** — the command has no caller but a dialog, so it takes
//      an unconditional [`user_dial`] and needs no parameter. The remote folder
//      browser (`ssh_default_dir`/`ssh_list_dir`/`ssh_mkdir`), every `slurm_*`
//      and `hpc_ws_*` (through `run_slurm_script`), `remote_kill_all_jobs`,
//      `remote_tmux_kill`, `worker_sync_now`, `worker_pull_outputs`, a
//      *confirmed* `disk_usage_scan`, and an `ssh_connect` carrying a typed
//      password. Adding a background caller to one of these is what would make it
//      wrong, so the rule is stated at the call site rather than in a parameter
//      the new caller could quietly inherit.
//
//   2. **Both** — the same command backs a click *and* a poller/sweep, so it
//      takes `background: Option<bool>` and only `Some(false)` counts as a
//      gesture ([`declared_dial`]). `ssh_probe`, `remote_connect`,
//      `remote_usage_check`, `global_machine_usage_check`,
//      `global_machine_monitor_snapshot`, `global_machine_tmux_list`, and a
//      **credential-less** `ssh_connect` (the readiness poll that waits for a
//      terminal login's master is a gesture; the silent reconnect behind
//      auto-connect is not — the two are indistinguishable from in there).
//
// The default is Background in **both** shapes, and deliberately so: a caller
// that says nothing is a caller nobody has thought about, and the two mistakes
// do not cost the same. A wrong "background" costs one confirmation dialog at a
// machine the user tagged for exactly that purpose; a wrong "user-initiated"
// costs the promise the tag is, silently, forever. Hence the polarity too —
// `background: true` and `background: absent` mean the same thing, so forgetting
// the parameter can only ever fail closed.

/// Targets with at least one live authorization, [`target_key`] → refcount.
///
/// Refcounted rather than a flag because one machine legitimately carries
/// several: a login node is at once a project's primary, another project's
/// worker and a global machine, and one of them closing must not silently
/// revoke the others.
///
/// **Known limit: this is process-global, not task-local.** A guard held across
/// an `.await` — a folder browse, a `disk_usage_scan` running for minutes, a
/// `remote_connect` inside a 10 s handshake — authorizes *any other task* dialing
/// the same target for that window. The exposure is small and deliberate: the two
/// background loops (`sync_auto`, `git_peer`) check the tag themselves per tick,
/// so what remains is a `pty_spawn` restore or a readiness poll landing inside a
/// user's own connect to the same machine — which is close to the case the
/// standing pool authorization grants on purpose anyway. It is recorded here
/// rather than glossed, because the guarantee this module reads as offering
/// ("only a gesture authorizes a dial") is narrower than that in the general
/// case. A task-local (tokio task-local / explicit-parameter) intent would close
/// it, at the cost of threading the intent through every argv builder's call
/// chain — the thing the ambient design exists to avoid.
static AUTHORIZED_DIALS: std::sync::Mutex<Option<std::collections::HashMap<String, usize>>> =
    std::sync::Mutex::new(None);

/// Add (`true`) or drop (`false`) one authorization for `key`.
fn shift_authorization(key: &str, add: bool) {
    let Ok(mut guard) = AUTHORIZED_DIALS.lock() else {
        return;
    };
    let map = guard.get_or_insert_with(std::collections::HashMap::new);
    if add {
        *map.entry(key.to_string()).or_insert(0) += 1;
        return;
    }
    if let Some(n) = map.get_mut(key) {
        *n = n.saturating_sub(1);
        if *n == 0 {
            map.remove(key);
        }
    }
}

/// Whether anything currently authorizes reaching `key`.
fn dial_authorized(key: &str) -> bool {
    AUTHORIZED_DIALS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|m| m.contains_key(key)))
        .unwrap_or(false)
}

/// The intent a builder must attribute to the dial it is about to make: what the
/// ambient registry says about *this* target, defaulting to background.
pub fn ambient_intent(user: &Option<String>, host: &str, port: Option<u16>) -> DialIntent {
    match dial_authorized(&target_key(user.as_deref(), host, port)) {
        true => DialIntent::UserInitiated,
        false => DialIntent::Background,
    }
}

/// One live "the user asked for this machine" authorization, dropped with the
/// command that took it out. Held across `.await`s by design — the whole point is
/// to cover an ssh argv built several layers below the click.
pub struct UserDial {
    key: String,
}

impl Drop for UserDial {
    fn drop(&mut self) {
        shift_authorization(&self.key, false);
    }
}

/// Mark `[user@]host[:port]` user-initiated for as long as the returned guard
/// lives. Take one at the top of any command a person triggers directly against a
/// named machine (connect, a SLURM submit, a workspace allocation, an explicit
/// kill), so the argv it eventually builds is not read as a background dial.
#[must_use = "the authorization lasts only as long as the guard"]
pub fn user_dial(user: &Option<String>, host: &str, port: Option<u16>) -> UserDial {
    user_dial_key(&target_key(user.as_deref(), host, port))
}

/// [`user_dial`] for a caller that already holds the [`target_key`].
#[must_use = "the authorization lasts only as long as the guard"]
pub fn user_dial_key(key: &str) -> UserDial {
    shift_authorization(key, true);
    UserDial {
        key: key.to_string(),
    }
}

/// [`user_dial`] for a command that serves *both* a click and a poller, taking
/// its `background: Option<bool>` parameter — the second shape described above.
///
/// Only an explicit `Some(false)` is a gesture. `None` reads as background on
/// purpose: it is what an un-updated caller, a new caller, and a caller that
/// simply forgot all send, and none of those is evidence that a person is
/// waiting. So the parameter can only be got wrong in the direction that raises
/// a dialog, never in the direction that dials a cluster unasked.
#[must_use = "the authorization lasts only as long as the guard"]
pub fn declared_dial(
    background: Option<bool>,
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Option<UserDial> {
    (background == Some(false)).then(|| user_dial(user, host, port))
}

/// Record that the user opened a lasting connection to this target. Unlike
/// [`user_dial`] this is not scoped to one call: it lives until
/// [`forget_user_connect`], because everything riding a pooled ControlMaster the
/// user authenticated — a shell tab, a `git status`, a Sessions listing — is work
/// on *their* connection, not Tabtivity reaching out on its own. Paired one-for-one
/// with the pool in `services::remote`.
pub fn remember_user_connect(user: &Option<String>, host: &str, port: Option<u16>) {
    shift_authorization(&target_key(user.as_deref(), host, port), true);
}

/// Drop the standing authorization [`remember_user_connect`] took out, when the
/// pooled connection it stood for is torn down.
pub fn forget_user_connect(user: &Option<String>, host: &str, port: Option<u16>) {
    shift_authorization(&target_key(user.as_deref(), host, port), false);
}

/// The dial policy itself: refuse a **background** connection to a machine the
/// user tagged HPC, and permit everything else.
///
/// The refusal carries `services::hpc_mode`'s existing `HPC_GUARD` sentinel, so
/// `src/lib/remote/hpc/hpcGuard.ts` already knows how to read it — the frontend can name the
/// machine and offer to connect anyway, and confirmation stays per act. The slug
/// is `connect`, since what was refused is the connection itself.
pub fn authorize_dial(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    intent: DialIntent,
) -> Result<(), String> {
    let key = target_key(user.as_deref(), host, port);
    match dial_refusal(crate::services::hpc_mode::is_tagged_hpc(&key), intent, &key) {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// The decision behind [`authorize_dial`], split out so it is testable without a
/// `settings.json` on disk: only the tagged-**and**-background pair refuses.
fn dial_refusal(tagged: bool, intent: DialIntent, key: &str) -> Option<String> {
    (tagged && intent == DialIntent::Background)
        .then(|| crate::services::hpc_mode::guard_error_for("connect", key))
}

/// Build the base `ssh` argv (everything up to but not including the remote
/// command), validating `host`/`user` and rendering the `[user@]host` target as
/// a single argv item.
pub fn ssh_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    validate_arg("host", host)?;
    // The dial policy, at the choke point rather than the call site — see the
    // section above `DialIntent`. Repeated verbatim in every builder because
    // "every builder" is the invariant.
    authorize_dial(user, host, port, ambient_intent(user, host, port))?;

    let mut args: Vec<String> = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        // TOFU: auto-accept a first-contact host key (so a fresh connection does
        // not fail with no way to answer the yes/no prompt — BatchMode can't, and
        // the password path answers via SSH_ASKPASS which would feed the password),
        // but still REFUSE a key that has *changed* (the MITM case).
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
    ];

    // A live project VM's forwarded port gets its per-VM identity + known_hosts
    // (`services::vm::vm_ssh_opts`; empty for every other target): a recreated
    // VM has a new host key, and the user's real known_hosts must never collect
    // `[127.0.0.1]:<port>` entries.
    args.extend(crate::services::vm::vm_ssh_opts(host, port));

    // Reuse (never create) the multiplexing master the pooled connection / an
    // interactive login may have opened (see `ssh_exec::interactive_login_command`
    // and `services::remote`). With `ControlMaster=no` + the shared `cm-%C`
    // socket, an otherwise-`BatchMode=yes` probe/exec rides that authenticated
    // master with no second prompt; if no master exists it simply falls through to
    // normal (key/agent) auth. Unix-only — Windows OpenSSH lacks the control
    // socket (see `ssh_pty_args`).
    #[cfg(not(target_os = "windows"))]
    for opt in control_reuse_opts() {
        args.push(opt);
    }

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }

    args.push(ssh_target(user, host)?);

    Ok(args)
}

/// `ssh` `-o` options that **reuse** (but never create) the shared multiplexing
/// master socket `ssh_exec` / the pooled connection / the interactive-login
/// command establish. `ControlMaster=no` means "use a master if one is live,
/// otherwise connect directly" — pure opportunistic reuse that never spawns a
/// master of its own.
#[cfg(not(target_os = "windows"))]
fn control_reuse_opts() -> Vec<String> {
    let control_path = crate::services::ssh_exec::control_dir().join("cm-%C");
    vec![
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.to_string_lossy()),
    ]
}

/// The canonical `user@host:port` form of an SSH target, for use as a **map key
/// for machine identity** — never as an argv item (that is [`ssh_target`], which
/// validates; this one only normalizes).
///
/// Normalization matches what "the same machine and login" means in practice: the
/// host is case-insensitive, a target with no explicit port and one pinned to 22
/// are the same machine, and a blank user is the same as an absent one. The user
/// itself is matched *strictly* — a different login on the same host is a
/// different connection, and may well have different rights on it.
///
/// **This must stay byte-identical to the frontend's `targetKey`**
/// (`src/lib/remote/machineSync.ts`). Both sides index `Settings::careful_hosts` by the
/// string this produces, so a divergence would not fail loudly — it would quietly
/// look up a host that is not there and answer "not careful", i.e. fail *open*,
/// in exactly the case the flag exists to protect. `target_key_matches_frontend`
/// below pins the shape against the cases that normalization turns on.
pub fn target_key(user: Option<&str>, host: &str, port: Option<u16>) -> String {
    let user = user.map(str::trim).filter(|u| !u.is_empty()).unwrap_or("");
    format!(
        "{user}@{}:{}",
        host.trim().to_lowercase(),
        port.unwrap_or(22)
    )
}

/// Render the `[user@]host` SSH target as a single, validated argv item.
pub fn ssh_target(user: &Option<String>, host: &str) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    validate_arg("host", host)?;
    // A bare `host` must be only a hostname: `ssh` splits the target on the LAST
    // `@`, so an `@` smuggled into `host` (e.g. "real.host@evil.com") would
    // silently redirect the connection to a different server. Whitespace would
    // likewise split into extra argv-ish tokens. Reject both here, the single
    // choke point every base-args builder funnels the target through.
    if host.contains('@') || host.chars().any(|c| c.is_whitespace()) {
        return Err("host must not contain '@' or whitespace".to_string());
    }
    match user {
        Some(user) => {
            let user = user.trim();
            if user.is_empty() {
                return Err("user must not be empty when provided".to_string());
            }
            validate_arg("user", user)?;
            Ok(format!("{user}@{host}"))
        }
        None => Ok(host.to_string()),
    }
}

/// Build the password-auth ssh argv: BatchMode off and only the password method
/// enabled, so ssh never falls back to (or hangs on) keys/keyboard-interactive.
/// The target `[user@]host` is validated and rendered as a single argv item.
/// Shared by the browse commands (`commands::ssh`) and the SFTP session
/// (`services::sftp`) so both authenticate identically.
pub fn ssh_password_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    authorize_dial(user, host, port, ambient_intent(user, host, port))?;
    let mut args: Vec<String> = vec![
        "-o".to_string(),
        "BatchMode=no".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        // TOFU first contact, refuse changed keys — see `ssh_base_args`.
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "PreferredAuthentications=password".to_string(),
        "-o".to_string(),
        "PubkeyAuthentication=no".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
    ];

    // Ride an existing master if one is live (key-auth `ssh_base_args` does the
    // same). Without this, a one-shot SFTP/browse for a password-auth host whose
    // pooled session has dropped could not reuse the master and would need the
    // password again — which we never store, so it would simply fail. With
    // `ControlMaster=no` + the shared `cm-%C` socket it transparently rides the
    // still-live master; if none exists it falls through to the password prompt.
    #[cfg(not(target_os = "windows"))]
    for opt in control_reuse_opts() {
        args.push(opt);
    }

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(ssh_target(user, host)?);
    Ok(args)
}

/// `ssh` `-o` options that **create and persist** the shared multiplexing master
/// (vs [`control_reuse_opts`], which only rides an existing one). Used by the
/// pooled connection (`services::remote`) opened on activation: it owns the master
/// so every later sftp channel / agent tab / git-over-ssh rides it with no
/// re-auth. `%C` is expanded by `ssh`, not the shell, so it is embedded literally.
/// Unix-only — Windows OpenSSH lacks the control socket (see
/// `ssh_exec::ssh_pty_args`).
#[cfg(not(target_os = "windows"))]
fn control_master_opts() -> Vec<String> {
    let control_path = crate::services::ssh_exec::control_dir().join("cm-%C");
    vec![
        "-o".to_string(),
        "ControlMaster=auto".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.to_string_lossy()),
        "-o".to_string(),
        "ControlPersist=600".to_string(),
    ]
}

/// Base `ssh` argv for a master-**owning** connection authenticated by key/agent
/// (`BatchMode=yes`). Like [`ssh_base_args`] but creates + persists the shared
/// ControlMaster (and adds keepalive for the long-lived pooled session) instead
/// of only reusing an existing master. The validated `[user@]host` target is the
/// final argv item. Drives the pooled SFTP session in `services::remote`.
pub fn ssh_master_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    validate_arg("host", host)?;
    authorize_dial(user, host, port, ambient_intent(user, host, port))?;

    let mut args: Vec<String> = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        // TOFU first contact, refuse changed keys — see `ssh_base_args`.
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
    ];

    // Per-VM identity + known_hosts for a live project VM's forwarded port
    // (empty for every other target) — see `ssh_base_args`.
    args.extend(crate::services::vm::vm_ssh_opts(host, port));

    #[cfg(not(target_os = "windows"))]
    for opt in control_master_opts() {
        args.push(opt);
    }

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(ssh_target(user, host)?);
    Ok(args)
}

/// Password-auth variant of [`ssh_master_base_args`] (BatchMode off, password the
/// only enabled method) for hosts reached with a supplied password (fed to ssh via
/// [`make_askpass`], or `sshpass` on pre-8.4 Windows). Still master-owning so the
/// one-time password authenticates the master once and every later channel rides
/// it with no further prompt.
pub fn ssh_password_master_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    authorize_dial(user, host, port, ambient_intent(user, host, port))?;
    let mut args: Vec<String> = vec![
        "-o".to_string(),
        "BatchMode=no".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        // TOFU first contact, refuse changed keys — see `ssh_base_args`.
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "PreferredAuthentications=password".to_string(),
        "-o".to_string(),
        "PubkeyAuthentication=no".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
    ];

    #[cfg(not(target_os = "windows"))]
    for opt in control_master_opts() {
        args.push(opt);
    }

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(ssh_target(user, host)?);
    Ok(args)
}

/// Build the key-passphrase ssh argv: pubkey auth only, BatchMode off so OpenSSH
/// *will* ask for the passphrase of an encrypted key, and every server-facing
/// prompt disabled ([`PASSPHRASE_SINGLE_PROMPT_OPTS`]) so the passphrase can never
/// be offered to the host as a login secret.
///
/// This is the path for the case the password path cannot serve at all: a key that
/// is encrypted on disk with no agent holding it. `BatchMode=yes` (the key-auth
/// builders) makes OpenSSH fail rather than ask, which surfaces as a bare
/// `Permission denied (publickey)`; `PubkeyAuthentication=no` (the password
/// builders) means the key is never even offered. Neither can unlock a key.
///
/// Note there is no [`guard_first_contact`] obligation here, unlike the password
/// builders: a passphrase never leaves this machine, so first-contact TOFU is the
/// ordinary key-auth bargain rather than a secret released to an unvetted host.
pub fn ssh_passphrase_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    authorize_dial(user, host, port, ambient_intent(user, host, port))?;
    let mut args = passphrase_common_opts();

    #[cfg(not(target_os = "windows"))]
    for opt in control_reuse_opts() {
        args.push(opt);
    }

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(ssh_target(user, host)?);
    Ok(args)
}

/// Master-**owning** variant of [`ssh_passphrase_base_args`], the passphrase
/// counterpart of [`ssh_password_master_base_args`]. Owning the master is what
/// makes this practical: the passphrase unlocks the key once, and every later
/// sftp channel / agent tab / git-over-ssh rides the authenticated master without
/// the key being touched again.
pub fn ssh_passphrase_master_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    authorize_dial(user, host, port, ambient_intent(user, host, port))?;
    let mut args = passphrase_common_opts();
    args.push("-o".to_string());
    args.push("ServerAliveInterval=15".to_string());
    args.push("-o".to_string());
    args.push("ServerAliveCountMax=3".to_string());

    #[cfg(not(target_os = "windows"))]
    for opt in control_master_opts() {
        args.push(opt);
    }

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(ssh_target(user, host)?);
    Ok(args)
}

/// The `-o` options shared by both passphrase builders: everything in
/// [`PASSPHRASE_SINGLE_PROMPT_OPTS`] plus `BatchMode=no` (without which OpenSSH
/// never raises the passphrase prompt at all) and the usual connect timeout.
fn passphrase_common_opts() -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        "BatchMode=no".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
    ];
    for opt in PASSPHRASE_SINGLE_PROMPT_OPTS {
        args.push("-o".to_string());
        args.push(opt.to_string());
    }
    args
}

/// True if `sshpass` is available on `PATH`. On Unix it is no longer needed (see
/// [`make_askpass`]) and is only reported for diagnostics; on Windows it is the
/// fallback when the installed OpenSSH predates `SSH_ASKPASS_REQUIRE` (< 8.4,
/// e.g. the Win10-inbox 8.1) — see [`ssh_supports_askpass`].
pub fn sshpass_available() -> bool {
    crate::paths::binary_on_path("sshpass")
}

/// Parse an OpenSSH version banner (`ssh -V` output, printed to STDERR) into
/// `(major, minor)`. Handles both the stock `OpenSSH_9.6p1 …` and the Windows
/// `OpenSSH_for_Windows_8.6p1 …` spellings by keying on the first digit run
/// after "OpenSSH".
pub fn parse_openssh_version(text: &str) -> Option<(u32, u32)> {
    let rest = &text[text.find("OpenSSH")?..];
    let rest = &rest[rest.find(|c: char| c.is_ascii_digit())?..];
    let mut parts = rest.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// Whether OpenSSH `major.minor` honors `SSH_ASKPASS_REQUIRE=force` (added in
/// OpenSSH 8.4). Without it, ssh only consults `SSH_ASKPASS` when there is no
/// controlling TTY *and* `DISPLAY` is set — neither reliable from a GUI app on
/// Windows — so the askpass path needs ≥ 8.4 and older installs fall back to
/// `sshpass`.
pub fn version_supports_askpass_require(major: u32, minor: u32) -> bool {
    major > 8 || (major == 8 && minor >= 4)
}

/// Whether the `ssh` on PATH is new enough for the askpass path
/// (`SSH_ASKPASS_REQUIRE`, OpenSSH ≥ 8.4). Cached for the process lifetime —
/// the binary does not change under a running Tabtivity. Win10's inbox OpenSSH is
/// 8.1 (→ false, sshpass fallback); Win11's is 8.6+ (→ true).
#[cfg(windows)]
pub fn ssh_supports_askpass() -> bool {
    static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        crate::paths::command_no_window("ssh")
            .arg("-V")
            .output()
            .ok()
            .and_then(|out| {
                // OpenSSH prints the version banner to STDERR.
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                parse_openssh_version(&text)
            })
            .map(|(major, minor)| version_supports_askpass_require(major, minor))
            .unwrap_or(false)
    })
}

/// Whether non-interactive password auth works on this platform **without the user
/// installing anything**. On Unix it always does — we feed the password through
/// OpenSSH's own `SSH_ASKPASS` mechanism ([`make_askpass`]), no external binary.
/// On Windows the same askpass path works when OpenSSH is ≥ 8.4
/// ([`ssh_supports_askpass`]); older installs still need `sshpass`.
pub fn password_auth_available() -> bool {
    #[cfg(unix)]
    {
        true
    }
    #[cfg(windows)]
    {
        ssh_supports_askpass() || sshpass_available()
    }
    #[cfg(not(any(unix, windows)))]
    {
        sshpass_available()
    }
}

/// Turn OpenSSH's stderr into a message that says what the user actually got
/// wrong, so a headless connect (where there is no terminal to read) fails with
/// "wrong username or password" rather than `Permission denied (publickey,
/// password).` or — worse, when stderr was discarded — an opaque SFTP EOF.
///
/// Returns `None` when nothing is recognized, so callers fall back to the raw
/// text rather than replacing a specific error with a vague guess. Matching is
/// case-insensitive and substring-based: these strings are stable OpenSSH
/// user-facing output, but a locale/version could reword them, and a missed match
/// costs only the raw message.
///
/// Order matters — the checks run most-specific first, since a changed host key
/// also prints "Permission denied" on some versions.
pub fn explain_ssh_error(stderr: &str) -> Option<String> {
    let s = stderr.to_ascii_lowercase();

    // Host identity problems — never conflate these with a bad password: one is a
    // typo, the other is a possible MITM and must be surfaced as such.
    if s.contains("remote host identification has changed")
        || s.contains("host key verification failed")
    {
        return Some(
            "The host's SSH key has changed since you last connected. This can mean the \
             server was rebuilt — or that the connection is being intercepted. Verify the \
             new key with the host's admin, then remove the old entry from ~/.ssh/known_hosts."
                .to_string(),
        );
    }

    // Reachability — these look like auth failures to a user but no credential
    // would fix them. Call out the VPN, since that is the usual cause here.
    if s.contains("could not resolve hostname") || s.contains("name or service not known") {
        return Some(
            "Unknown host — the name could not be resolved. If this host is only visible \
             inside the VPN, bring the tunnel up first."
                .to_string(),
        );
    }
    if s.contains("connection timed out") || s.contains("operation timed out") {
        return Some(
            "Timed out reaching the host. If it is VPN-gated, bring the tunnel up first; \
             otherwise check the address and port."
                .to_string(),
        );
    }
    if s.contains("connection refused") {
        return Some(
            "Connection refused — the host is reachable but nothing is listening on that \
             SSH port. Check the port, and that sshd is running."
                .to_string(),
        );
    }
    if s.contains("no route to host") || s.contains("network is unreachable") {
        return Some(
            "No route to the host. If it is VPN-gated, bring the tunnel up first.".to_string(),
        );
    }

    // A *local* failure that looks like an auth failure: the key on disk could not
    // be decrypted. Must be checked before the `permission denied` branch, which
    // ssh also prints once the unusable key leaves it with no method left.
    if is_wrong_passphrase(stderr) {
        return Some(
            "That passphrase did not unlock the SSH key. Check it and try again — this is \
             the key's own passphrase, not your login password for the host."
                .to_string(),
        );
    }

    // Authentication. `Permission denied` is what a wrong password looks like; the
    // parenthesised list is the methods the *server* offers, so it tells us what
    // the user should have been able to use.
    if s.contains("too many authentication failures") {
        return Some(
            "Too many authentication failures — the server cut the connection. This often \
             means an ssh-agent offered several wrong keys before the password was tried."
                .to_string(),
        );
    }
    if s.contains("permission denied") {
        // Distinguish "the password was wrong" from "this server won't take a
        // password at all", which no amount of retyping fixes.
        let offers_password = s.contains("password") || s.contains("keyboard-interactive");
        return Some(if offers_password {
            "Authentication failed — check the username and password.".to_string()
        } else {
            "Authentication failed — this server does not accept password logins. It wants \
             a key (the methods it offers are listed in the ssh error). Set up an SSH key, \
             or ask the host's admin to enable password auth."
                .to_string()
        });
    }

    None
}

/// The one prompt Tabtivity is willing to answer automatically. OpenSSH builds its
/// password request as `"%.30s@%.128s's password: "` (`sshconnect2.c`) — a string
/// that has been stable for two decades and that **no other** prompt it can raise
/// shares. Matching on it is what turns the askpass shim from "answer whatever is
/// asked" into "answer the password request, and only that".
///
/// The shims below implement this same test in `sh` and PowerShell; this is the
/// Rust statement of the contract, unit-tested against every prompt OpenSSH can
/// actually produce so the two shell spellings have something to be checked
/// against.
///
/// Why a shape test at all, when [`ssh_password_base_args`] already forbids every
/// other prompt (`PubkeyAuthentication=no` kills the passphrase request,
/// `PreferredAuthentications=password` kills keyboard-interactive — where the
/// *server* writes the prompt text — and `StrictHostKeyChecking=accept-new` kills
/// the yes/no confirmation): because that safety lives in an argv the shim knows
/// nothing about. A future caller that attaches the askpass to args missing one of
/// those options would silently hand the password to a prompt nobody vetted. This
/// is the same invariant enforced where it cannot be forgotten.
pub fn prompt_is_password_request(prompt: &str) -> bool {
    prompt.contains("'s password:")
}

/// Which secret the user typed into the one credential field, and therefore which
/// prompt the askpass shim is allowed to answer. The two are **not**
/// interchangeable and must never be confused: a login password is released to the
/// *server*, while a key passphrase is a purely local secret that only unlocks a
/// file on this machine (the server sees a signature, never the passphrase).
/// Sending one where the other was meant is either a failed connect or — in the
/// passphrase-as-password direction — handing a local secret to a remote host.
/// [`secret_attempt_order`] is ordered by exactly that asymmetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    /// OpenSSH's own `"user@host's password: "` request.
    Password,
    /// OpenSSH's `"Enter passphrase for key '…': "` request, raised when the
    /// private key on disk is encrypted and no agent holds it.
    KeyPassphrase,
}

/// The key-passphrase counterpart of [`prompt_is_password_request`]. OpenSSH
/// builds this one as `"Enter passphrase for key '%.100s': "` (`sshconnect2.c`),
/// with adjacent spellings dropping the word `key` — matching the stable
/// `"Enter passphrase for "` prefix covers both and cannot collide with the
/// password request or with a server-authored keyboard-interactive challenge
/// (which [`PASSPHRASE_SINGLE_PROMPT_OPTS`] disables outright).
pub fn prompt_is_key_passphrase_request(prompt: &str) -> bool {
    prompt.contains("Enter passphrase for ")
}

/// Whether `prompt` is the one prompt `kind` is permitted to answer.
pub fn prompt_matches_kind(kind: SecretKind, prompt: &str) -> bool {
    match kind {
        SecretKind::Password => prompt_is_password_request(prompt),
        SecretKind::KeyPassphrase => prompt_is_key_passphrase_request(prompt),
    }
}

/// The `ssh -o` options that reduce OpenSSH to a single answerable prompt, and
/// therefore the precondition for attaching a password to a connection at all.
/// Each removes one prompt: the key passphrase, the server-authored
/// keyboard-interactive challenge, the host-key `yes/no`, and the retry loop.
const SINGLE_PROMPT_OPTS: [&str; 4] = [
    "PubkeyAuthentication=no",
    "PreferredAuthentications=password",
    "StrictHostKeyChecking=accept-new",
    "NumberOfPasswordPrompts=1",
];

/// [`SINGLE_PROMPT_OPTS`] for the passphrase path — the mirror image. Pubkey auth
/// is the *only* method left enabled, so the sole prompt OpenSSH can raise is the
/// local key's passphrase: `PasswordAuthentication=no` and
/// `KbdInteractiveAuthentication=no` remove the two server-facing prompts (a
/// passphrase must never be offered to either), and `accept-new` removes the
/// host-key `yes/no` exactly as it does on the password path.
const PASSPHRASE_SINGLE_PROMPT_OPTS: [&str; 4] = [
    "PreferredAuthentications=publickey",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "StrictHostKeyChecking=accept-new",
];

/// Whether `args` is an ssh argv a password may safely be attached to — i.e. one
/// carrying every option in [`SINGLE_PROMPT_OPTS`]. Returns the first missing
/// option so the failure names what is wrong rather than just refusing.
///
/// This is the invariant of the whole password path made checkable: the shim can
/// only test the prompt it is *handed*, and which prompts exist at all is decided
/// here. [`make_askpass`] refuses on a violation, so a future caller cannot attach
/// the askpass to args that were never vetted — the failure mode this guards is
/// silent, and would look exactly like a working connect.
pub fn missing_single_prompt_opt(args: &[String]) -> Option<&'static str> {
    missing_single_prompt_opt_for(SecretKind::Password, args)
}

/// [`missing_single_prompt_opt`] for either secret kind — the checkable form of
/// "this argv leaves ssh exactly one prompt, and it is the one `kind` answers".
pub fn missing_single_prompt_opt_for(kind: SecretKind, args: &[String]) -> Option<&'static str> {
    let required: &[&'static str] = match kind {
        SecretKind::Password => &SINGLE_PROMPT_OPTS,
        SecretKind::KeyPassphrase => &PASSPHRASE_SINGLE_PROMPT_OPTS,
    };
    required
        .iter()
        .copied()
        .find(|opt| !args.iter().any(|a| a == opt))
}

/// A temporary, owner-only askpass shim that feeds a password to OpenSSH via its
/// built-in `SSH_ASKPASS` mechanism — the in-tree replacement for the external
/// `sshpass` binary. The shim script holds **no secret**: it prints whatever is
/// in the `TABTIVITY_ASKPASS` environment variable, which we set only on the
/// specific `ssh` child (same `/proc/<pid>/environ` exposure `sshpass -e`'s
/// `SSHPASS` had — no worse). Pairing it with `SSH_ASKPASS_REQUIRE=force` makes
/// OpenSSH (>= 8.4) call the shim with no controlling TTY and no `DISPLAY`, which
/// is exactly our situation (a GUI app spawning `ssh` with piped stdio). On
/// Windows, gate on [`ssh_supports_askpass`] before taking this path.
///
/// The shim is **prompt-aware**: it releases the secret only for OpenSSH's own
/// password request ([`prompt_is_password_request`]) and answers anything else
/// with nothing at all, recording the text it refused to a side file so the caller
/// can show the user *what* was asked ([`Askpass::refused_prompt`]). A refusal
/// fails the connect visibly instead of leaking the password into a prompt that
/// was never vetted.
///
/// The shim files are deleted when this guard is dropped, so a caller MUST keep the
/// guard alive until the `ssh` child has finished authenticating (i.e. until the
/// SFTP handshake / command completes, not merely until spawn returns) — and must
/// read [`Askpass::refused_prompt`] *before* dropping it.
#[cfg(any(unix, windows))]
pub struct Askpass {
    path: std::path::PathBuf,
    /// Windows only: the PowerShell half of the shim (`%~dpn0.ps1`), which does the
    /// prompt test cmd.exe cannot do safely. `None` on Unix.
    helper: Option<std::path::PathBuf>,
    /// Where the shim records a prompt it refused to answer.
    reject: std::path::PathBuf,
    /// Where the shim appends one byte per prompt it *answered*. See
    /// [`Askpass::answer_count`].
    tally: std::path::PathBuf,
    password: String,
}

#[cfg(any(unix, windows))]
impl Askpass {
    /// Environment variables to set on the `ssh` (or `ssh -s`) child so OpenSSH
    /// obtains the password from this shim instead of a controlling TTY.
    pub fn env_vars(&self) -> Vec<(&'static str, std::ffi::OsString)> {
        vec![
            ("SSH_ASKPASS", self.path.clone().into_os_string()),
            ("SSH_ASKPASS_REQUIRE", std::ffi::OsString::from("force")),
            (crate::app_env!("ASKPASS"), std::ffi::OsString::from(&self.password)),
            (
                crate::app_env!("ASKPASS_REJECT"),
                self.reject.clone().into_os_string(),
            ),
            (crate::app_env!("ASKPASS_TALLY"), self.tally.clone().into_os_string()),
        ]
    }

    /// How many times the shim released the secret — one byte appended per answer.
    ///
    /// This is the reliable "the secret was wrong" signal on the passphrase path,
    /// and the reason it exists: OpenSSH re-asks for a key passphrase (three times)
    /// **only** when the previous answer failed to decrypt the key, and — as of
    /// current releases — says nothing about it on stderr, printing just
    /// `Permission denied (publickey)`. So a count above one is proof the secret is
    /// a wrong passphrase, where the stderr text is merely a hint that may not
    /// appear at all. See [`secret_rejected_locally`], which is what callers use.
    ///
    /// Must be read before the guard drops (dropping deletes the file).
    pub fn answer_count(&self) -> u32 {
        std::fs::metadata(&self.tally)
            .map(|m| m.len().min(u32::MAX as u64) as u32)
            .unwrap_or(0)
    }

    /// The prompt OpenSSH raised that the shim declined to answer, if any — the
    /// evidence behind an otherwise inexplicable "Permission denied". Returned
    /// sanitized ([`sanitize_prompt`]) because it is **untrusted text**: on the
    /// keyboard-interactive path it is written by the server.
    ///
    /// `None` is the normal case (the password prompt was answered, or ssh failed
    /// before asking anything).
    pub fn refused_prompt(&self) -> Option<String> {
        let raw = std::fs::read_to_string(&self.reject).ok()?;
        let clean = sanitize_prompt(&raw);
        (!clean.is_empty()).then_some(clean)
    }
}

#[cfg(any(unix, windows))]
impl Drop for Askpass {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        if let Some(helper) = &self.helper {
            let _ = std::fs::remove_file(helper);
        }
        let _ = std::fs::remove_file(&self.reject);
        let _ = std::fs::remove_file(&self.tally);
    }
}

/// The pid stamped into an askpass shim's name (`ap-<pid>-<seq>.{sh,cmd}`, plus
/// its `.reject`/`.tally` siblings), or `None` for anything else in the
/// directory.
///
/// Deliberately strict about the whole shape rather than just taking the digits
/// after `ap-`: this is the sole input to a delete, and a name that does not
/// parse must fall through to "leave it alone" instead of being attributed to a
/// pid that happens to be dead.
#[cfg(any(unix, test))]
fn askpass_owner_pid(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("ap-")?;
    let (pid, seq) = rest.split_once('-')?;
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let seq = seq.split('.').next()?;
    if seq.is_empty() || !seq.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    pid.parse().ok()
}

/// Remove askpass shims whose owning process is gone.
///
/// [`Askpass`]'s `Drop` deletes its own files, so **every** shim still on disk is
/// the residue of a process that never got to run it: a crash, an OOM kill, a
/// `kill -9`, a dev-launcher Ctrl+C before the signal routing landed. Nothing
/// swept them, so they accumulated for the life of the installation — 2137 files
/// across 144 dead pids on the machine this was written for.
///
/// The bytes are irrelevant (8 MB). What matters is that the directory is
/// secret-*adjacent*: a shim holds no password (the value arrives through
/// `TABTIVITY_ASKPASS` at run time, which is the whole design) but its presence and
/// its `.tally` say that a password path was used and how often it answered, and
/// a growing pile of 0700 scripts is exactly the kind of thing that is
/// individually harmless and collectively worth not leaving behind.
///
/// **Only the pid licenses the delete.** A shim whose name does not parse, or
/// whose pid is still alive, is left where it is: a live ssh may be moments away
/// from execing it, and deleting one out from under OpenSSH turns a working
/// connection into an unexplained "Permission denied". Our own pid is skipped
/// explicitly — this runs at startup, before any shim of ours exists, but the
/// guarantee should not depend on when it is called.
#[cfg(unix)]
pub fn sweep_stale_askpass() {
    sweep_stale_askpass_in(&crate::storage::state_dir().join("ssh-askpass"));
}

/// The sweep above, against a named directory.
///
/// Split out for the test, which must not reach the behaviour through
/// `TABTIVITY_STATE_DIR`: that variable is process-wide, the suite runs its tests
/// concurrently in one process, and the shim tests two screens up create and
/// then *exec* a shim under whatever the state dir says at that instant — so
/// redirecting it here deleted their shim's directory out from under them and
/// failed them with `ENOENT`, intermittently and nowhere near the cause.
#[cfg(unix)]
fn sweep_stale_askpass_in(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let self_pid = std::process::id();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(pid) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(askpass_owner_pid)
        else {
            continue;
        };
        if pid == self_pid {
            continue;
        }
        // SAFETY: `kill` takes no pointers; signal 0 performs the permission and
        // existence check without delivering anything.
        //
        // **Only `ESRCH` licenses the delete**, not "the call failed". A living
        // process we may not signal answers `EPERM`, and a `!= 0` test would
        // read that as gone — which is the difference between a sweep and a
        // sweep that deletes shims out from under running processes. `EINVAL`
        // (a pid too large for `pid_t`) is likewise not evidence of an exit.
        let gone = unsafe { libc::kill(pid as libc::pid_t, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        if gone {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Windows has no cheap "is this pid alive" that is worth a startup walk, and
/// its shims are `.cmd` files written on the same rare password path — left to
/// the `Drop` guard, as before.
#[cfg(not(unix))]
pub fn sweep_stale_askpass() {}

/// Flatten an untrusted prompt into something safe to put in an error message: no
/// control characters (a server-supplied prompt could carry ANSI escapes, and this
/// text lands in a terminal-adjacent UI), collapsed whitespace, length-capped.
pub fn sanitize_prompt(raw: &str) -> String {
    let mut out = String::new();
    let mut pending_space = false;
    for ch in raw.chars() {
        if ch.is_control() || ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
        if out.chars().count() >= 200 {
            out.push('…');
            break;
        }
    }
    out
}

/// The error a connect fails with when the shim refused an unexpected prompt.
/// Names the prompt (quoted, as untrusted data) and says plainly that nothing was
/// sent — the whole point of the refusal is lost if the user is left with a bare
/// "Permission denied" and no idea the host asked for something else.
pub fn unexpected_prompt_error(prompt: &str) -> String {
    format!(
        "The host asked for something other than a password, so {app} sent nothing.\n\n\
         It asked: \"{prompt}\"\n\n\
         Only OpenSSH's own password request is answered automatically. If this host \
         wants a verification code, a key passphrase, or a confirmation, connect from a \
         login terminal where you can answer it yourself.", app = crate::brand::DISPLAY
    )
}

/// Monotonic suffix so concurrent connects never collide on the shim filename
/// (paired with the pid, which separates instances).
#[cfg(any(unix, windows))]
static ASKPASS_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Body of the Unix askpass shim (`ap-*.sh`). Holds no secret: the password comes
/// from `$TABTIVITY_ASKPASS`, and the prompt to answer arrives as `$1`.
///
/// The `case` is [`prompt_is_password_request`] in `sh`. Anything else — a key
/// passphrase, a host-key `yes/no`, a keyboard-interactive challenge whose text
/// the *server* chose — is written to `$TABTIVITY_ASKPASS_REJECT` and answered with
/// nothing, so ssh fails auth instead of the secret going somewhere unvetted.
/// Exposed cfg-free so the refusal is unit-tested on any platform.
pub fn unix_askpass_shim_body() -> &'static str {
    concat!(r#"#!/bin/sh
# $1 is the prompt OpenSSH wants answered. Release the secret only for OpenSSH's
# own password request; record and refuse everything else.
case "$1" in
  *"'s password:"*)
    # One byte per answer, so the caller can tell a re-ask (i.e. the previous
    # answer was rejected) from a first ask. See `Askpass::answer_count`.
    printf 'x' >> "$"#, crate::app_upper!(), r#"_ASKPASS_TALLY" 2>/dev/null
    printf '%s\n' "$"#, crate::app_upper!(), r#"_ASKPASS"
    ;;
  *)
    printf '%s' "$1" > "$"#, crate::app_upper!(), r#"_ASKPASS_REJECT" 2>/dev/null
    exit 1
    ;;
esac
"#)
}

/// [`unix_askpass_shim_body`] for the key-passphrase path: the same shim with the
/// one permitted prompt swapped for [`prompt_is_key_passphrase_request`]. Written
/// as a second literal script rather than a pattern injected through the
/// environment so each shim still *states* its own contract — an env-supplied glob
/// would land unquoted in `case`, which is precisely the kind of indirection this
/// shim exists to avoid.
pub fn unix_passphrase_askpass_shim_body() -> &'static str {
    concat!(r#"#!/bin/sh
# $1 is the prompt OpenSSH wants answered. Release the secret only for OpenSSH's
# local key-passphrase request; record and refuse everything else — in particular
# any prompt whose answer would travel to the server.
case "$1" in
  "Enter passphrase for "*)
    # One byte per answer. OpenSSH re-asks only when the key failed to decrypt,
    # so a tally above one IS the wrong-passphrase signal — see
    # `Askpass::answer_count`.
    printf 'x' >> "$"#, crate::app_upper!(), r#"_ASKPASS_TALLY" 2>/dev/null
    printf '%s\n' "$"#, crate::app_upper!(), r#"_ASKPASS"
    ;;
  *)
    printf '%s' "$1" > "$"#, crate::app_upper!(), r#"_ASKPASS_REJECT" 2>/dev/null
    exit 1
    ;;
esac
"#)
}

/// The shim body for `kind` — [`unix_askpass_shim_body`] or
/// [`unix_passphrase_askpass_shim_body`].
pub fn unix_shim_body_for(kind: SecretKind) -> &'static str {
    match kind {
        SecretKind::Password => unix_askpass_shim_body(),
        SecretKind::KeyPassphrase => unix_passphrase_askpass_shim_body(),
    }
}

/// Write an owner-only (0700) askpass shim for `password` and return a guard that
/// deletes it on drop. The shim reads the password from the `TABTIVITY_ASKPASS` env
/// var (set via [`Askpass::env_vars`]), so the secret never lands in the file.
///
/// `args` is the ssh argv the shim will be attached to, and is **checked, not
/// merely recorded**: a command that does not reduce ssh to one answerable prompt
/// ([`missing_single_prompt_opt`]) is refused outright. Pass the args from
/// [`ssh_password_base_args`] / [`ssh_password_master_base_args`].
#[cfg(unix)]
pub fn make_askpass(password: &str, args: &[String]) -> Result<Askpass, String> {
    make_askpass_for(SecretKind::Password, password, args)
}

/// [`make_askpass`] for either secret kind: same argv check (against the option
/// set `kind` requires) and same delete-on-drop guard, with the shim body that
/// releases the secret only to `kind`'s prompt.
#[cfg(unix)]
pub fn make_askpass_for(
    kind: SecretKind,
    password: &str,
    args: &[String],
) -> Result<Askpass, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::sync::atomic::Ordering;

    if let Some(missing) = missing_single_prompt_opt_for(kind, args) {
        return Err(format!(
            "refusing to attach a secret to an ssh command that does not set \
             {missing} — it could be asked for something other than the secret we hold"
        ));
    }
    let dir = crate::storage::state_dir().join("ssh-askpass");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create askpass dir: {e}"))?;
    let seq = ASKPASS_SEQ.fetch_add(1, Ordering::Relaxed);
    let stem = format!("ap-{}-{seq}", std::process::id());
    let path = dir.join(format!("{stem}.sh"));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o700)
        .open(&path)
        .map_err(|e| format!("create askpass shim: {e}"))?;
    // The password comes from the environment; the script itself is generic.
    f.write_all(unix_shim_body_for(kind).as_bytes())
        .map_err(|e| format!("write askpass shim: {e}"))?;
    Ok(Askpass {
        path,
        helper: None,
        reject: dir.join(format!("{stem}.reject")),
        tally: dir.join(format!("{stem}.tally")),
        password: password.to_string(),
    })
}

/// Body of the Windows askpass shim (`ap-*.cmd`). It must echo the secret via
/// PowerShell, NOT `@echo %TABTIVITY_ASKPASS%`: cmd re-parses the expanded value,
/// so `& | < > ^` in a password would be executed/mangled. PowerShell receives
/// the variable through the environment block and writes it verbatim. Secret-
/// free, like the Unix shim. Exposed cfg-free so the no-interpolation property
/// is unit-tested on Linux.
///
/// **Deliberately prompt-blind**, unlike [`unix_askpass_shim_body`]. Testing the
/// prompt here would mean forwarding it into the batch file (`%1`/`%*`), and cmd
/// re-parses batch-argument expansions exactly as it re-parses `%VAR%` — so a
/// prompt carrying `&` would be *executed*. That trades a narrow disclosure for a
/// command injection, on the one platform whose shell semantics cannot be checked
/// locally. Windows therefore rests on the argv restrictions alone
/// ([`ssh_password_base_args`], which are identical on every platform) plus the
/// cross-platform [`guard_first_contact`]. Revisit if the shim is ever replaced by
/// a real executable, where argv needs no shell at all.
/// The answer tally ([`Askpass::answer_count`]) is written from inside the *same*
/// PowerShell command, not by a `cmd` redirect: `@echo x>>"%TABTIVITY_ASKPASS_TALLY%"`
/// would put the path through exactly the `%VAR%` re-parse this shim exists to
/// avoid, and a state-dir path carries the Windows account name. PowerShell reads
/// it from the environment block instead, so no shell ever re-parses it.
pub fn windows_askpass_shim_body() -> &'static str {
    concat!("@powershell.exe -NoProfile -NonInteractive -Command \
     \"Add-Content -LiteralPath $env:", crate::app_upper!(), "_ASKPASS_TALLY -Value 'x' -NoNewline \
     -ErrorAction SilentlyContinue; [Console]::Out.WriteLine($env:", crate::app_upper!(), "_ASKPASS)\"\r\n")
}

/// Windows counterpart of the Unix [`make_askpass`]: writes an `ap-{pid}-{seq}.cmd`
/// shim (see [`windows_askpass_shim_body`]) and returns the delete-on-drop guard.
/// Only valid when [`ssh_supports_askpass`] is true — callers gate on that and
/// fall back to `sshpass` otherwise. No `mode(0o700)` here: the state dir is
/// under the user profile, and the file holds no secret anyway.
#[cfg(windows)]
pub fn make_askpass(password: &str, args: &[String]) -> Result<Askpass, String> {
    make_askpass_for(SecretKind::Password, password, args)
}

/// [`make_askpass`] for either secret kind. The shim body is the same on Windows
/// either way — it is prompt-blind (see [`windows_askpass_shim_body`]) — so `kind`
/// only selects which option set the argv is checked against.
#[cfg(windows)]
pub fn make_askpass_for(
    kind: SecretKind,
    password: &str,
    args: &[String],
) -> Result<Askpass, String> {
    use std::sync::atomic::Ordering;

    // The Windows shim is prompt-blind (see `windows_askpass_shim_body`), so this
    // argv check is the ONLY thing standing between the secret and a prompt
    // nobody vetted. It is not defence in depth here — it is the defence.
    if let Some(missing) = missing_single_prompt_opt_for(kind, args) {
        return Err(format!(
            "refusing to attach a secret to an ssh command that does not set \
             {missing} — it could be asked for something other than the secret we hold"
        ));
    }
    let dir = crate::storage::state_dir().join("ssh-askpass");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create askpass dir: {e}"))?;
    let seq = ASKPASS_SEQ.fetch_add(1, Ordering::Relaxed);
    let stem = format!("ap-{}-{seq}", std::process::id());
    let path = dir.join(format!("{stem}.cmd"));
    std::fs::write(&path, windows_askpass_shim_body())
        .map_err(|e| format!("write askpass shim: {e}"))?;
    Ok(Askpass {
        path,
        // No PowerShell half on Windows: the shim is prompt-blind there, so the
        // reject file simply never gets written and `refused_prompt` is always
        // `None`. See `windows_askpass_shim_body`.
        helper: None,
        reject: dir.join(format!("{stem}.reject")),
        tally: dir.join(format!("{stem}.tally")),
        password: password.to_string(),
    })
}

// ── Locked keys: which secret the one credential field actually holds ───────
//
// A passphrase-protected private key with no agent to hold it is the one auth
// shape neither existing path could serve. Key auth runs `BatchMode=yes`, so
// OpenSSH fails instead of asking and the user sees a bare
// `Permission denied (publickey)`; the password path sets
// `PubkeyAuthentication=no`, so the key is never offered and the typed secret
// goes to the server as a login password — which for a passphrase means leaking a
// local secret to the host. The helpers below decide, before either is tried,
// whether the host resolves to an encrypted key on disk.

/// Whether a private key file's contents are encrypted: `Some(true)`/`Some(false)`
/// when the format is recognised, `None` when it is not a private key we can read
/// (callers treat `None` as "don't know", never as "unencrypted").
///
/// Three formats, because a user's `~/.ssh` accumulates all of them:
///   - PKCS#8 (`BEGIN ENCRYPTED PRIVATE KEY`) — encrypted by its very header.
///   - Legacy PEM (`BEGIN RSA PRIVATE KEY` + `Proc-Type: 4,ENCRYPTED`).
///   - `openssh-key-v1`, the modern default, which says nothing in its header:
///     the cipher name is the first field of the base64 body, and `none` is the
///     literal OpenSSH writes for an unencrypted key.
///
/// Pure and unit-tested — the decision it feeds (which secret goes where) is one
/// where being wrong is a disclosure, not just a failed connect.
pub fn private_key_is_encrypted(text: &str) -> Option<bool> {
    use base64::Engine;

    if text.contains("ENCRYPTED PRIVATE KEY") || text.contains("Proc-Type: 4,ENCRYPTED") {
        return Some(true);
    }

    const HEADER: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
    if let Some(start) = text.find(HEADER) {
        // The cipher name sits within the first few dozen bytes, so decoding a
        // prefix of the body is enough — no need to read a whole 4k RSA key.
        let body: String = text[start + HEADER.len()..]
            .lines()
            .skip_while(|l| l.trim().is_empty())
            .take_while(|l| !l.starts_with("-----"))
            .flat_map(|l| l.chars())
            .filter(|c| !c.is_whitespace())
            .take(64)
            .collect();
        // Trim to a whole number of base64 quanta so the truncated prefix decodes.
        let body = &body[..body.len() - body.len() % 4];
        let raw = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(body)
            .ok()?;
        const MAGIC: &[u8] = b"openssh-key-v1\0";
        let rest = raw.strip_prefix(MAGIC)?;
        let len = u32::from_be_bytes(rest.get(..4)?.try_into().ok()?) as usize;
        let cipher = rest.get(4..4 + len)?;
        return Some(cipher != b"none");
    }

    text.contains("PRIVATE KEY").then_some(false)
}

/// The identity files OpenSSH would actually offer for `[user@]host[:port]`, in
/// its own order, after `~/.ssh/config` is applied — asked of `ssh -G` for the
/// same reason [`resolve_host_port`] is: a `Host` alias can pin an `IdentityFile`
/// that nothing in Tabtivity's own state knows about. Paths are `~`-expanded (ssh
/// prints them unexpanded) and returned whether or not they exist.
pub fn resolve_identity_files(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Vec<std::path::PathBuf> {
    let Ok(target) = ssh_target(user, host) else {
        return Vec::new();
    };
    let mut cmd = crate::paths::command_no_window("ssh");
    cmd.arg("-G");
    if let Some(p) = port {
        cmd.arg("-p").arg(p.to_string());
    }
    cmd.arg(target);
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut tok = line.split_whitespace();
            match (tok.next(), tok.next()) {
                (Some("identityfile"), Some(path)) => Some(expand_home(path)),
                _ => None,
            }
        })
        .collect()
}

/// Expand a leading `~/` against the user's home. `ssh -G` prints identity paths
/// exactly as configured, so this is the one substitution needed to open them.
fn expand_home(path: &str) -> std::path::PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => crate::paths::home_dir().join(rest),
        None => std::path::PathBuf::from(path),
    }
}

/// Whether an ssh-agent is reachable *and* holds at least one key. When it does,
/// an encrypted key on disk is not a problem — the agent already has the unlocked
/// form and OpenSSH never raises a passphrase prompt.
///
/// **Fails closed** (returns `false`) when `ssh-add` cannot be run at all: the
/// consequence is only that a passphrase attempt is tried first, which costs a
/// round trip and discloses nothing.
pub fn agent_has_keys() -> bool {
    if std::env::var_os("SSH_AUTH_SOCK").is_none() {
        return false;
    }
    crate::paths::command_no_window("ssh-add")
        .arg("-l")
        .output()
        // `-l` exits 0 with the key list, 1 with "no identities", 2 with no agent.
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// The first identity OpenSSH would offer this host that exists on disk and is
/// encrypted, or `None` — i.e. "this host resolves to a locked key". Returns
/// `None` when an agent already holds keys, since then nothing is locked from
/// OpenSSH's point of view.
pub fn locked_identity(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Option<std::path::PathBuf> {
    if agent_has_keys() {
        return None;
    }
    resolve_identity_files(user, host, port)
        .into_iter()
        .find(|p| {
            std::fs::read_to_string(p)
                .ok()
                .and_then(|text| private_key_is_encrypted(&text))
                .unwrap_or(false)
        })
}

/// The order to try the user's one typed secret in, for a host that may want
/// either. Ordering is a **security** decision, not a heuristic preference: a
/// passphrase tried as a password is released to the server, whereas a password
/// tried as a passphrase only fails to decrypt a local file. So whenever the host
/// resolves to a locked key ([`locked_identity`]), the passphrase is tried first
/// and the password path is the fallback; otherwise there is nothing to unlock and
/// the password is the only candidate.
pub fn secret_attempt_order(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Vec<SecretKind> {
    match locked_identity(user, host, port) {
        Some(_) => vec![SecretKind::KeyPassphrase, SecretKind::Password],
        None => vec![SecretKind::Password],
    }
}

/// [`secret_attempt_order`] for an **async** caller, off the runtime's thread for
/// the same reason [`guard_first_contact_async`] is: it spawns `ssh -G`/`ssh-add`
/// and reads key files.
pub async fn secret_attempt_order_async(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Vec<SecretKind> {
    let (user, host) = (user.clone(), host.to_string());
    tokio::task::spawn_blocking(move || secret_attempt_order(&user, &host, port))
        .await
        .unwrap_or_else(|_| vec![SecretKind::Password])
}

/// [`locked_key_hint`] for an **async** caller.
pub async fn locked_key_hint_async(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Option<String> {
    let (user, host) = (user.clone(), host.to_string());
    tokio::task::spawn_blocking(move || locked_key_hint(&user, &host, port))
        .await
        .ok()
        .flatten()
}

/// Whether ssh's stderr says the secret failed to *decrypt the local key* — as
/// opposed to any failure involving the server. This is what makes the
/// passphrase→password fallback in [`secret_attempt_order`] safe to stop early:
/// once OpenSSH has told us the secret is a wrong passphrase, retrying it as a
/// login password would send a local secret to the host for nothing.
pub fn is_wrong_passphrase(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("incorrect passphrase") || s.contains("error in libcrypto")
}

/// Whether a failed attempt proves the secret was rejected **locally** — i.e. it
/// is a wrong key passphrase — and so must NOT be retried as a login password.
///
/// This is the gate on the passphrase→password fallback, and it is deliberately
/// belt-and-braces because getting it wrong means sending a local secret to a
/// remote host:
///   - the askpass tally ([`Askpass::answer_count`]) — OpenSSH re-asks only after
///     a failed decrypt, so >1 answer is *proof*. This is the load-bearing one:
///     current OpenSSH prints nothing about the decrypt failure and exits with a
///     plain `Permission denied (publickey)`.
///   - [`is_wrong_passphrase`] on stderr — a hint that some versions do print,
///     and the only signal available when no shim ran (the Windows `sshpass`
///     path, which cannot serve a passphrase anyway).
///
/// Always false for [`SecretKind::Password`]: there is nothing after it to fall
/// back to.
#[cfg(any(unix, windows))]
pub fn secret_rejected_locally(kind: SecretKind, askpass: Option<&Askpass>, stderr: &str) -> bool {
    kind == SecretKind::KeyPassphrase
        && (askpass.is_some_and(|a| a.answer_count() > 1) || is_wrong_passphrase(stderr))
}

/// The message for an attempt [`secret_rejected_locally`] identified — stated as
/// what it is, since OpenSSH's own `Permission denied (publickey)` blames the
/// server for a file that never decrypted.
pub fn wrong_passphrase_error() -> String {
    "That passphrase did not unlock the SSH key. Check it and try again — this is the \
     key's own passphrase, not your login password for the host."
        .to_string()
}

/// The advice to append when a **no-secret** key-auth connect was denied and the
/// host resolves to a locked key — the case whose bare
/// `Permission denied (publickey)` sends users looking for a server-side problem
/// that isn't there. Returns `None` when nothing is locked, so the original error
/// stands unembellished.
pub fn locked_key_hint(user: &Option<String>, host: &str, port: Option<u16>) -> Option<String> {
    let key = locked_identity(user, host, port)?;
    Some(format!(
        "The SSH key for this host ({}) is protected by a passphrase, and no ssh-agent \
         is holding it — so the connection had no way to unlock it. Enter the key's \
         passphrase in the password field and connect again, or run `ssh-add {}` in a \
         terminal first to unlock it for the whole session.",
        key.display(),
        key.display()
    ))
}

// ── First contact: verify the host key before releasing a password ──────────
//
// `StrictHostKeyChecking=accept-new` is what keeps every headless path from
// hanging on an unanswerable yes/no, and it refuses a *changed* key outright —
// but it accepts a *first* key silently. For key auth that is the ordinary TOFU
// bargain. For **password** auth it is not: the secret goes to whoever answered
// the connection, and nobody was ever shown the fingerprint they were implicitly
// trusting. This is the one place where "show me, then decide" is load-bearing,
// so a password is never released to a host whose key is not already known.
//
// No new persisted state backs this: `accept-new` writes the key to known_hosts
// on the first successful connect, so the gate clears itself. Confirming in the
// UI does the same thing eagerly via [`trust_host_key`].

/// Marker prefix on the error a password connect fails with when the host's key
/// has never been seen. The frontend keys on this exact string to raise the
/// fingerprint-confirmation dialog instead of showing a dead end; keep them in
/// step (`src/lib/remote/hostKey.ts`).
pub const UNKNOWN_HOST_KEY: &str = crate::app_env!("UNKNOWN_HOST_KEY");

/// How OpenSSH itself resolves `[user@]host[:port]` after `~/.ssh/config` is
/// applied — `ssh -G` prints the effective settings without connecting. Needed
/// because a `Host` alias can map to an entirely different `hostname`/`port`, and
/// known_hosts is keyed by the *resolved* pair: checking the alias would call a
/// long-trusted host unknown, and scanning it would fetch nothing.
///
/// Falls back to the arguments as given when `ssh -G` is unavailable or silent.
pub fn resolve_host_port(host: &str, port: Option<u16>) -> (String, u16) {
    let fallback = (host.to_string(), port.unwrap_or(22));
    let mut cmd = crate::paths::command_no_window("ssh");
    cmd.arg("-G");
    if let Some(p) = port {
        cmd.arg("-p").arg(p.to_string());
    }
    cmd.arg(host);
    let Ok(out) = cmd.output() else {
        return fallback;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut resolved_host = None;
    let mut resolved_port = None;
    for line in text.lines() {
        let mut tok = line.split_whitespace();
        match (tok.next(), tok.next()) {
            (Some("hostname"), Some(v)) => resolved_host = Some(v.to_string()),
            (Some("port"), Some(v)) => resolved_port = v.parse().ok(),
            _ => {}
        }
    }
    (
        resolved_host.unwrap_or(fallback.0),
        resolved_port.unwrap_or(fallback.1),
    )
}

/// The known_hosts lookup key for a resolved host/port: a bare hostname on the
/// default port, `[host]:port` otherwise — the bracketed form OpenSSH writes and
/// `ssh-keygen -F` expects.
pub fn known_hosts_key(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Whether this host already has an accepted key in a known_hosts file.
///
/// Delegates to `ssh-keygen -F` rather than parsing known_hosts: the file is
/// commonly hashed (`HashKnownHosts yes`), which makes a hand-rolled lookup
/// useless, and `-F` searches the global file too.
///
/// **Fails open** when `ssh-keygen` cannot be run at all — it ships with the ssh
/// client on every platform Tabtivity supports, so its absence means something is
/// broken about the install, and blocking every password connect on that would be
/// a worse failure than the TOFU window this closes.
pub fn host_key_known(host: &str, port: u16) -> bool {
    let mut cmd = crate::paths::command_no_window("ssh-keygen");
    cmd.arg("-F").arg(known_hosts_key(host, port));
    match cmd.output() {
        // `-F` exits 0 and prints the entry when found, 1 when not.
        Ok(out) => out.status.success() && !out.stdout.is_empty(),
        Err(_) => true,
    }
}

/// Refuse to release a password to a host whose key has never been accepted.
/// Called by every password-auth path *before* the askpass is attached; returns
/// the [`UNKNOWN_HOST_KEY`]-marked error the frontend turns into the fingerprint
/// dialog.
pub fn guard_first_contact(host: &str, port: Option<u16>) -> Result<(), String> {
    let (resolved, resolved_port) = resolve_host_port(host, port);
    if host_key_known(&resolved, resolved_port) {
        return Ok(());
    }
    Err(format!(
        "{UNKNOWN_HOST_KEY} {resolved}:{resolved_port} — this host's SSH key has never \
         been accepted on this machine. Verify its fingerprint before sending a password."
    ))
}

/// [`guard_first_contact`] for an **async** caller. The gate spawns two short
/// local subprocesses (`ssh -G`, `ssh-keygen -F` — no network), which is tens of
/// milliseconds of a tokio worker thread blocked; the SFTP openers run on the
/// runtime that also serves the UI's commands, so they take this form rather than
/// paying that on an executor thread.
pub async fn guard_first_contact_async(host: &str, port: Option<u16>) -> Result<(), String> {
    let host = host.to_string();
    tokio::task::spawn_blocking(move || guard_first_contact(&host, port))
        .await
        .map_err(|e| format!("host key check failed: {e}"))?
}

/// One host key offered by a host, as the confirmation dialog shows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HostKeyFingerprint {
    /// Key algorithm as OpenSSH names it (`ssh-ed25519`, `rsa-sha2-512`, …).
    pub key_type: String,
    /// `SHA256:…` — the form OpenSSH prints in its own confirmation prompt, so the
    /// user can compare it against what an admin or another client shows them.
    pub fingerprint: String,
    /// Key size in bits, as reported by `ssh-keygen -l`.
    pub bits: u32,
}

/// Parse `ssh-keyscan` output into `(known_hosts line, fingerprint)` pairs by
/// piping it through `ssh-keygen -lf -`. The two are zipped by position: keyscan
/// emits one key per line and `-l` one fingerprint per line, in order.
fn fingerprint_scan(scan: &str) -> Vec<HostKeyFingerprint> {
    use std::io::Write;
    use std::process::Stdio;

    let lines: Vec<&str> = scan
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let mut child = match crate::paths::command_no_window("ssh-keygen")
        .arg("-l")
        .arg("-f")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(scan.as_bytes());
    }
    let Ok(out) = child.wait_with_output() else {
        return Vec::new();
    };
    parse_keygen_fingerprints(&String::from_utf8_lossy(&out.stdout))
}

/// Parse `ssh-keygen -l` output: `<bits> SHA256:<b64> <comment> (<TYPE>)`.
/// Pure, so the format assumption is unit-tested rather than discovered at
/// runtime. Lines that do not match are skipped.
pub fn parse_keygen_fingerprints(text: &str) -> Vec<HostKeyFingerprint> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let mut tok = line.split_whitespace();
            let bits: u32 = tok.next()?.parse().ok()?;
            let fingerprint = tok.next()?.to_string();
            if !fingerprint.starts_with("SHA256:") && !fingerprint.starts_with("MD5:") {
                return None;
            }
            // The algorithm is the parenthesised last token.
            let key_type = line
                .rsplit_once('(')
                .and_then(|(_, rest)| rest.strip_suffix(')'))
                .unwrap_or("unknown")
                .to_string();
            Some(HostKeyFingerprint {
                key_type,
                fingerprint,
                bits,
            })
        })
        .collect()
}

/// Fetch the keys a host currently offers, for the confirmation dialog. One
/// `ssh-keyscan`, bounded by its own `-T` timeout so an unreachable host fails
/// fast instead of hanging the modal.
///
/// Returns the raw keyscan text alongside the fingerprints: accepting the host
/// means appending exactly those lines to known_hosts, and re-scanning at that
/// point would leave a window where the key shown is not the key stored.
pub fn scan_host_keys(
    host: &str,
    port: Option<u16>,
) -> Result<(String, Vec<HostKeyFingerprint>), String> {
    validate_arg("host", host)?;
    let (resolved, resolved_port) = resolve_host_port(host, port);
    validate_arg("host", &resolved)?;
    let mut cmd = crate::paths::command_no_window("ssh-keyscan");
    cmd.arg("-T").arg("8");
    if resolved_port != 22 {
        cmd.arg("-p").arg(resolved_port.to_string());
    }
    cmd.arg(&resolved);
    let out = cmd
        .output()
        .map_err(|e| format!("ssh-keyscan could not be run: {e}"))?;
    let scan = String::from_utf8_lossy(&out.stdout).to_string();
    let keys = fingerprint_scan(&scan);
    if keys.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("no SSH key could be read from {resolved}:{resolved_port}")
        } else {
            explain_ssh_error(&stderr).unwrap_or(stderr)
        });
    }
    Ok((scan, keys))
}

/// Record the user's acceptance of a host's key by appending the scanned
/// known_hosts lines — the same thing `accept-new` would have done, done
/// deliberately after the fingerprint was shown. Idempotent-ish: a duplicate line
/// is harmless to OpenSSH, and the [`host_key_known`] gate stops calling this once
/// the entry exists.
///
/// `scan` must be the text [`scan_host_keys`] returned, so the key stored is the
/// key the user was shown.
pub fn trust_host_key(scan: &str) -> Result<(), String> {
    use std::io::Write;

    let lines: Vec<&str> = scan
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    if lines.is_empty() {
        return Err("nothing to trust — the host key scan was empty".to_string());
    }
    let dir = crate::paths::home_dir().join(".ssh");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create ~/.ssh: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let path = dir.join("known_hosts");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open known_hosts: {e}"))?;
    for line in lines {
        writeln!(f, "{line}").map_err(|e| format!("write known_hosts: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn askpass_owner_pid_reads_every_shape_the_shim_writer_produces() {
        // The three files one `Askpass` guard creates, plus the Windows shim.
        assert_eq!(askpass_owner_pid("ap-990069-5.sh"), Some(990069));
        assert_eq!(askpass_owner_pid("ap-990069-5.tally"), Some(990069));
        assert_eq!(askpass_owner_pid("ap-990069-5.reject"), Some(990069));
        assert_eq!(askpass_owner_pid("ap-1234-0.cmd"), Some(1234));
    }

    #[test]
    fn askpass_owner_pid_refuses_anything_it_cannot_fully_account_for() {
        // The sweep deletes what this attributes, so "not sure" must be `None`
        // rather than a pid guessed out of a partial match.
        for name in [
            "notes.txt",
            "ap-.sh",
            "ap-12.sh",       // no sequence
            "ap-abc-1.sh",    // non-numeric pid
            "ap-12-x.sh",     // non-numeric sequence
            "ap--1.sh",       // empty pid
            "helper-12-1.sh", // not ours
        ] {
            assert_eq!(askpass_owner_pid(name), None, "{name} must not parse");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_sweep_takes_dead_pids_and_leaves_live_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let askpass = dir.path().join("ssh-askpass");
        std::fs::create_dir_all(&askpass).expect("mkdir");
        // Pid 1 always exists; a live shim must survive even though this process
        // does not own it (`kill` answers EPERM, which is not "gone").
        let live = askpass.join("ap-1-0.sh");
        // Our own pid, which the sweep skips by name rather than by liveness.
        let mine = askpass.join(format!("ap-{}-0.sh", std::process::id()));
        // A pid the kernel positively reports as gone — `ESRCH`, not merely a
        // failed `kill` (an out-of-range pid answers `EINVAL`, which the sweep
        // deliberately does not treat as an exit).
        let dead_pid = (1..=100_000)
            .rev()
            .find(|p| {
                (unsafe { libc::kill(*p as libc::pid_t, 0) }) != 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            })
            .expect("a free pid");
        let dead = askpass.join(format!("ap-{dead_pid}-0.sh"));
        let stranger = askpass.join("README");
        for p in [&live, &mine, &dead, &stranger] {
            std::fs::write(p, b"x").expect("write");
        }

        // Against the directory directly, never through `TABTIVITY_STATE_DIR`: that
        // is process-wide, and a concurrent test in this same binary execs a
        // shim resolved from it.
        sweep_stale_askpass_in(&askpass);

        assert!(!dead.exists(), "a shim whose owner is gone must be removed");
        assert!(live.exists(), "a live process's shim must survive");
        assert!(mine.exists(), "our own shim must survive");
        assert!(stranger.exists(), "an unrecognized name must be left alone");
    }

    #[test]
    fn target_key_matches_frontend() {
        // The four normalizations `lib/remote/machineSync.ts`'s `targetKey` applies. A
        // divergence here fails OPEN (a careful host looked up under a key nobody
        // wrote reads as "not careful"), so each is pinned rather than trusted.
        let k = |u: Option<&str>, h: &str, p: Option<u16>| target_key(u, h, p);
        // Host case-insensitive.
        assert_eq!(
            k(Some("alice"), "Login.Example.Org", Some(22)),
            k(Some("alice"), "login.example.org", Some(22))
        );
        // No port ≡ port 22.
        assert_eq!(k(Some("alice"), "h", None), k(Some("alice"), "h", Some(22)));
        // Blank user ≡ absent user.
        assert_eq!(k(Some("   "), "h", None), k(None, "h", None));
        // Surrounding whitespace is not part of the identity.
        assert_eq!(k(Some(" alice "), " h ", None), k(Some("alice"), "h", None));
        // The exact wire shape both sides format.
        assert_eq!(
            k(Some("alice"), "login.example.org", Some(2222)),
            "alice@login.example.org:2222"
        );
        assert_eq!(k(None, "h", None), "@h:22");
        // A different login on the same host is a DIFFERENT machine identity —
        // it may hold different rights on it, so this must not collapse.
        assert_ne!(k(Some("a"), "h", None), k(Some("b"), "h", None));
        // A different port likewise (a tunnel/jump endpoint is not the host).
        assert_ne!(k(Some("a"), "h", Some(22)), k(Some("a"), "h", Some(2222)));
    }

    // ── Dial policy ────────────────────────────────────────────────────────

    /// The whole policy as a table. Split out of [`authorize_dial`] precisely so
    /// it can be stated without a `settings.json` on disk: exactly one of the
    /// four combinations refuses, and the refusal is the sentinel
    /// `src/lib/remote/hpc/hpcGuard.ts` already parses (three whitespace-separated fields).
    #[test]
    fn only_a_background_dial_at_a_tagged_host_is_refused() {
        let key = "alice@login.example:22";
        assert!(dial_refusal(false, DialIntent::Background, key).is_none());
        assert!(dial_refusal(false, DialIntent::UserInitiated, key).is_none());
        assert!(dial_refusal(true, DialIntent::UserInitiated, key).is_none());
        let err = dial_refusal(true, DialIntent::Background, key).unwrap();
        assert_eq!(err, concat!(crate::app_upper!(), "_HPC_GUARD connect alice@login.example:22"));
        assert_eq!(err.split_whitespace().count(), 3);
    }

    /// Background is the default, and it comes back on its own. The guard is what
    /// scopes an authorization to one command — leaking one would silently license
    /// every later background dial at that machine for the rest of the session.
    #[test]
    fn a_dial_is_background_until_something_authorizes_that_target() {
        let (user, host) = (Some("alice".to_string()), "scope.example");
        assert_eq!(ambient_intent(&user, host, None), DialIntent::Background);
        {
            let _guard = user_dial(&user, host, None);
            assert_eq!(ambient_intent(&user, host, None), DialIntent::UserInitiated);
            // Keyed by target: authorizing one machine authorizes only that one.
            assert_eq!(
                ambient_intent(&user, "elsewhere.example", None),
                DialIntent::Background
            );
        }
        assert_eq!(ambient_intent(&user, host, None), DialIntent::Background);
    }

    /// One machine legitimately carries several authorizations at once — a login
    /// node is at once a project's primary, another project's worker and a global
    /// machine — so releasing one must not revoke the others.
    #[test]
    fn authorizations_are_refcounted_rather_than_a_flag() {
        let (user, host) = (Some("bob".to_string()), "refcount.example");
        remember_user_connect(&user, host, None);
        {
            let _guard = user_dial(&user, host, None);
            assert_eq!(ambient_intent(&user, host, None), DialIntent::UserInitiated);
        }
        // The scoped guard dropped; the standing pooled-connection one did not.
        assert_eq!(ambient_intent(&user, host, None), DialIntent::UserInitiated);
        forget_user_connect(&user, host, None);
        assert_eq!(ambient_intent(&user, host, None), DialIntent::Background);
    }

    /// The `background` parameter's polarity, which is the whole safety property
    /// of the second shape: `None` — an un-updated caller, a new caller, a caller
    /// that forgot — must read the same as `Some(true)`. Only an explicit "a
    /// person is waiting" is one.
    #[test]
    fn only_an_explicit_not_background_is_a_gesture() {
        let (user, host) = (Some("alice".to_string()), "declared.example");
        assert!(declared_dial(None, &user, host, None).is_none());
        assert!(declared_dial(Some(true), &user, host, None).is_none());
        let guard = declared_dial(Some(false), &user, host, None);
        assert!(guard.is_some());
        assert_eq!(ambient_intent(&user, host, None), DialIntent::UserInitiated);
        drop(guard);
        assert_eq!(ambient_intent(&user, host, None), DialIntent::Background);
    }

    /// The registry is indexed by [`target_key`], so an authorization taken with
    /// the host spelled one way covers the same machine spelled another — the same
    /// normalization the HPC tag itself is looked up under.
    #[test]
    fn an_authorization_follows_target_key_normalization() {
        let _guard = user_dial(&Some("alice".into()), "Case.Example", None);
        assert_eq!(
            ambient_intent(&Some(" alice ".into()), "case.example", Some(22)),
            DialIntent::UserInitiated
        );
    }

    /// An ssh argv a password may legitimately be attached to — i.e. one that
    /// leaves ssh exactly one answerable prompt.
    /// Run an askpass shim the way OpenSSH does — argv[1] is the prompt, the
    /// secret is in the environment — retrying while the exec reports ETXTBSY.
    ///
    /// The retry is about the *test suite's* concurrency, not about the shim:
    /// Rust's `Command` forks before it execs, so a child forked by any other
    /// test running at that instant can hold an inherited write fd to a shim
    /// written moments earlier, and exec'ing a file some process still has open
    /// for writing fails with ETXTBSY. Nothing serializes that, since the forking
    /// test need not touch shims at all.
    #[cfg(unix)]
    fn exec_shim(ap: &Askpass, prompt: &str) -> std::process::Output {
        let shim = ap
            .env_vars()
            .iter()
            .find(|(k, _)| *k == "SSH_ASKPASS")
            .map(|(_, v)| std::path::PathBuf::from(v))
            .expect("shim path");
        for _ in 0..100 {
            let mut c = std::process::Command::new(&shim);
            c.arg(prompt);
            for (k, v) in ap.env_vars() {
                c.env(k, v);
            }
            match c.output() {
                Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                other => return other.expect("run shim"),
            }
        }
        panic!("shim stayed ETXTBSY");
    }

    /// The env var `name` the shim was handed, as a path.
    #[cfg(unix)]
    fn shim_file(ap: &Askpass, name: &str) -> std::path::PathBuf {
        ap.env_vars()
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| std::path::PathBuf::from(v))
            .expect("shim env var")
    }

    fn vetted_args() -> Vec<String> {
        ssh_password_base_args(&Some("me".to_string()), "host.example", None).unwrap()
    }

    // ── explain_ssh_error ──────────────────────────────────────────────────
    // Headless has no terminal to read, so these strings ARE the error UI.

    #[test]
    fn explain_ssh_error_reports_a_wrong_password_as_such() {
        // The verbatim stderr a project host returns for a bad password.
        let msg = explain_ssh_error("alice@build.example: Permission denied (publickey,password).")
            .unwrap();
        assert!(msg.contains("check the username and password"), "{msg}");
    }

    #[test]
    fn explain_ssh_error_distinguishes_a_server_that_refuses_passwords() {
        // No amount of retyping fixes a key-only server — say so instead of
        // sending the user round the "is my password wrong?" loop forever.
        let msg = explain_ssh_error("git@github.com: Permission denied (publickey).").unwrap();
        assert!(msg.contains("does not accept password logins"), "{msg}");
        assert!(!msg.contains("check the username and password"), "{msg}");
    }

    #[test]
    fn explain_ssh_error_never_calls_a_changed_host_key_a_bad_password() {
        // A changed host key is a possible MITM. Some OpenSSH versions also print
        // "Permission denied" for it, so this must be checked FIRST — misreporting
        // it as a typo would train the user to shrug off an interception.
        let msg = explain_ssh_error(
            "@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@\n\
             Host key verification failed.\nPermission denied (publickey,password).",
        )
        .unwrap();
        assert!(msg.contains("host's SSH key has changed"), "{msg}");
        assert!(!msg.to_lowercase().contains("check the username"), "{msg}");
    }

    #[test]
    fn explain_ssh_error_points_at_the_vpn_for_unreachable_hosts() {
        // These look like auth failures to a user, but no credential would fix
        // them — and on this project's hosts the usual cause is a down tunnel.
        for stderr in [
            "ssh: Could not resolve hostname build.example: Name or service not known",
            "ssh: connect to host build.example port 22: Connection timed out",
            "ssh: connect to host build.example port 22: No route to host",
        ] {
            let msg = explain_ssh_error(stderr).unwrap();
            assert!(msg.contains("VPN"), "{stderr} -> {msg}");
        }
        // Refused is different: something answered, so it is a port/sshd problem.
        let refused =
            explain_ssh_error("ssh: connect to host h port 22: Connection refused").unwrap();
        assert!(refused.contains("nothing is listening"), "{refused}");
    }

    #[test]
    fn explain_ssh_error_passes_unknown_stderr_through() {
        // Unrecognized stderr must fall back to the raw text — a vague guess is
        // worse than the real message.
        assert_eq!(
            explain_ssh_error("Kex error: no common kex algorithm"),
            None
        );
        assert_eq!(explain_ssh_error(""), None);
    }

    #[test]
    fn validate_arg_rejects_dash_and_control() {
        assert!(validate_arg("path", "/home/user").is_ok());
        assert!(validate_arg("path", "-rf").is_err());
        assert!(validate_arg("path", "a\nb").is_err());
        assert!(validate_arg("path", "a\0b").is_err());
    }

    /// A bidi/zero-width disguise is refused, not merely stripped.
    ///
    /// This is a regression test with a specific past behaviour behind it:
    /// `char::is_control` is `Cc`-only, so every one of these passed the control
    /// check above while rendering as a different host than the one dialled. An
    /// imported machines file (`commands::global_machines`) is picked from a
    /// rendered list, which is exactly where that gap is worth something.
    #[test]
    fn validate_arg_rejects_bidi_and_zero_width_disguises() {
        // The overrides that reorder a rendered host.
        assert!(validate_arg("host", "gpu-01\u{202E}moc.live").is_err());
        assert!(validate_arg("host", "gpu-01\u{202D}x").is_err());
        // The isolates, which do the same job with newer characters.
        assert!(validate_arg("host", "gpu\u{2066}-01\u{2069}").is_err());
        // Zero-width: invisible entirely, so two distinct hosts render alike.
        assert!(validate_arg("host", "trusted\u{200B}.example").is_err());
        assert!(validate_arg("user", "root\u{FEFF}").is_err());
        // A soft hyphen renders as nothing mid-word in most UIs.
        assert!(validate_arg("host", "a\u{00AD}b.example").is_err());
        // Ordinary values — including non-ASCII ones — still pass: the rule is
        // about disguises, not about being un-English. An IDN host reaches here
        // in its Unicode form and must not be refused for having one.
        assert!(validate_arg("host", "münchen.example").is_ok());
        assert!(validate_arg("host", "gpu-01.cluster.example").is_ok());
        assert!(validate_arg("path", "/home/user/projekte/über").is_ok());
    }

    #[test]
    fn base_args_renders_user_at_host_single_item_with_batchmode() {
        let args = ssh_base_args(&Some("alice".to_string()), "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "alice@host.example");
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        assert!(args.iter().any(|a| a == "ConnectTimeout=10"));
    }

    #[test]
    fn base_args_includes_port() {
        let args = ssh_base_args(&None, "host", Some(2200)).unwrap();
        let pos = args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(args[pos + 1], "2200");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ssh_base_args_reuse_master_and_keep_target_last() {
        let args = ssh_base_args(&Some("alice".to_string()), "host.example", None).unwrap();
        assert!(args.iter().any(|a| a == "ControlMaster=no"));
        assert!(args.iter().any(|a| a.starts_with("ControlPath=")));
        // The validated target must remain the final argv item despite the inserted
        // -o options, so ssh still parses it as the destination.
        assert_eq!(args.last().unwrap(), "alice@host.example");
        // BatchMode is still set: with no live master, auth falls back to key/agent.
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
    }

    // ── ssh_master_base_args (pooled-connection, master-owning) ────────────

    #[test]
    fn master_base_args_owns_master_and_keeps_target_last() {
        let args = ssh_master_base_args(&Some("alice".to_string()), "host.example", None).unwrap();
        // Target is still the final argv item despite the inserted -o options.
        assert_eq!(args.last().unwrap(), "alice@host.example");
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        // Long-lived session keepalive.
        assert!(args.iter().any(|a| a == "ServerAliveInterval=15"));
        // Multiplexing is Unix-only: this variant CREATES (auto) the master, vs
        // ssh_base_args which only reuses (ControlMaster=no).
        #[cfg(not(target_os = "windows"))]
        {
            assert!(args.iter().any(|a| a == "ControlMaster=auto"));
            assert!(args.iter().any(|a| a.starts_with("ControlPath=")));
            assert!(args.iter().any(|a| a.starts_with("ControlPersist=")));
            assert!(args.iter().any(|a| a.contains("cm-%C")));
        }
        #[cfg(target_os = "windows")]
        assert!(!args.iter().any(|a| a == "ControlMaster=auto"));
    }

    #[test]
    fn master_base_args_includes_port_and_rejects_bad_target() {
        let args = ssh_master_base_args(&None, "host", Some(2222)).unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
        assert!(ssh_master_base_args(&None, "-evil", None).is_err());
        assert!(ssh_master_base_args(&Some("-evil".to_string()), "host", None).is_err());
    }

    #[test]
    fn password_base_args_disable_batchmode_and_pin_password_auth() {
        let args = ssh_password_base_args(&Some("me".to_string()), "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "me@host.example");
        assert!(args.iter().any(|a| a == "BatchMode=no"));
        assert!(args
            .iter()
            .any(|a| a == "PreferredAuthentications=password"));
        assert!(!args.iter().any(|a| a == "BatchMode=yes"));
    }

    #[test]
    fn password_master_base_args_pin_password_auth_and_own_master() {
        let args =
            ssh_password_master_base_args(&Some("me".to_string()), "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "me@host.example");
        assert!(args.iter().any(|a| a == "BatchMode=no"));
        assert!(args
            .iter()
            .any(|a| a == "PreferredAuthentications=password"));
        assert!(args.iter().any(|a| a == "PubkeyAuthentication=no"));
        // Must never force BatchMode=yes (that would block the password prompt).
        assert!(!args.iter().any(|a| a == "BatchMode=yes"));
        #[cfg(not(target_os = "windows"))]
        assert!(args.iter().any(|a| a == "ControlMaster=auto"));
    }

    #[test]
    fn target_rejects_bad_host_and_user() {
        assert!(ssh_target(&None, "-evil").is_err());
        assert!(ssh_target(&Some("-evil".to_string()), "host").is_err());
        assert!(ssh_target(&Some("  ".to_string()), "host").is_err());
        assert!(ssh_target(&None, "   ").is_err());
        assert_eq!(ssh_target(&None, "host.example").unwrap(), "host.example");
    }

    #[test]
    fn target_rejects_host_with_at_or_whitespace() {
        // `@` would make ssh split the target and redirect to a different host.
        assert!(ssh_target(&None, "real.host@evil.com").is_err());
        assert!(ssh_target(&Some("alice".to_string()), "real.host@evil.com").is_err());
        // Internal whitespace would split into extra tokens.
        assert!(ssh_target(&None, "host name").is_err());
    }

    #[test]
    fn all_base_args_use_tofu_host_key_policy() {
        // accept-new: auto-trust a first-contact key but refuse a changed one.
        // Must be on every builder so key- and password-auth first connects behave
        // identically and never hang on an unanswerable yes/no prompt.
        for args in [
            ssh_base_args(&Some("a".into()), "h", None).unwrap(),
            ssh_password_base_args(&Some("a".into()), "h", None).unwrap(),
            ssh_master_base_args(&Some("a".into()), "h", None).unwrap(),
            ssh_password_master_base_args(&Some("a".into()), "h", None).unwrap(),
        ] {
            assert!(
                args.iter().any(|a| a == "StrictHostKeyChecking=accept-new"),
                "missing accept-new in {args:?}"
            );
            // Never the insecure variants that would accept a *changed* key.
            assert!(!args.iter().any(|a| a == "StrictHostKeyChecking=no"));
            assert!(!args.iter().any(|a| a == "StrictHostKeyChecking=off"));
        }
    }

    #[test]
    fn parses_openssh_version_banners() {
        // Stock Linux and Windows-flavored banners, both to-stderr formats.
        assert_eq!(
            parse_openssh_version("OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13"),
            Some((9, 6))
        );
        assert_eq!(
            parse_openssh_version("OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3"),
            Some((8, 6))
        );
        assert_eq!(
            parse_openssh_version("OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2"),
            Some((9, 5))
        );
        assert_eq!(parse_openssh_version("not an ssh banner"), None);
        assert_eq!(parse_openssh_version("OpenSSH_"), None);
    }

    #[test]
    fn askpass_require_needs_openssh_8_4() {
        // SSH_ASKPASS_REQUIRE landed in 8.4: Win10-inbox 8.1 must fall back to
        // sshpass, Win11-inbox 8.6+ takes the askpass path.
        assert!(!version_supports_askpass_require(8, 1));
        assert!(!version_supports_askpass_require(8, 3));
        assert!(version_supports_askpass_require(8, 4));
        assert!(version_supports_askpass_require(8, 6));
        assert!(version_supports_askpass_require(9, 0));
        assert!(!version_supports_askpass_require(7, 9));
    }

    #[test]
    fn windows_askpass_shim_echoes_env_without_cmd_interpolation() {
        let body = windows_askpass_shim_body();
        // The secret must travel via the environment…
        assert!(body.contains(crate::app_env!("ASKPASS")));
        // …and never through cmd's %VAR% expansion, which re-parses the value
        // (`& | < > ^` in a password would execute/mangle). PowerShell writes
        // the variable verbatim instead.
        assert!(!body.contains('%'), "cmd %VAR% expansion is forbidden");
        assert!(body.contains("powershell"));
        // @-prefixed so the command itself is not echoed into ssh's dialog.
        assert!(body.starts_with('@'));
        // cmd wants CRLF endings.
        assert!(body.ends_with("\r\n"));
    }

    #[cfg(unix)]
    #[test]
    fn askpass_shim_is_secret_free_executable_and_self_deleting() {
        use std::os::unix::fs::PermissionsExt;
        let ap = make_askpass("hunter2", &vetted_args()).unwrap();
        // Locate the shim path via its SSH_ASKPASS env var.
        let env = ap.env_vars();
        let shim = env
            .iter()
            .find(|(k, _)| *k == "SSH_ASKPASS")
            .map(|(_, v)| std::path::PathBuf::from(v))
            .unwrap();
        // The password is passed only via TABTIVITY_ASKPASS, never written to disk.
        let body = std::fs::read_to_string(&shim).unwrap();
        assert!(!body.contains("hunter2"), "shim must not embed the secret");
        assert!(body.contains(crate::app_env!("ASKPASS")));
        assert!(env
            .iter()
            .any(|(k, v)| *k == crate::app_env!("ASKPASS") && v == "hunter2"));
        assert!(env
            .iter()
            .any(|(k, v)| *k == "SSH_ASKPASS_REQUIRE" && v == "force"));
        // Owner-only, executable.
        let mode = std::fs::metadata(&shim).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        // Dropping the guard removes the shim.
        drop(ap);
        assert!(!shim.exists(), "shim must be deleted on drop");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn password_base_args_reuse_existing_master() {
        // A password-auth one-shot must be able to ride a live master (so a
        // dropped pooled session can recover without the unstored password).
        let args = ssh_password_base_args(&Some("me".to_string()), "host.example", None).unwrap();
        assert!(args.iter().any(|a| a == "ControlMaster=no"));
        assert!(args.iter().any(|a| a.starts_with("ControlPath=")));
        assert_eq!(args.last().unwrap(), "me@host.example");
    }

    // ── Which prompt the askpass shim will answer ──────────────────────────

    #[test]
    fn only_openssh_own_password_request_is_answerable() {
        // The prompt OpenSSH builds for password auth — the one and only thing
        // Tabtivity answers on the user's behalf.
        assert!(prompt_is_password_request(
            "alice@build.example's password: "
        ));
        assert!(prompt_is_password_request(
            "alice@build.example's password:"
        ));

        // A key passphrase: a *local* secret, and not the one we hold.
        assert!(!prompt_is_password_request(
            "Enter passphrase for key '/home/alice/.ssh/id_ed25519': "
        ));
        // The host-key confirmation. Answering this with a password sends a
        // non-"yes" to ssh, which aborts — but it is also the prompt that means
        // "you have never seen this machine before", so it must never be automated.
        assert!(!prompt_is_password_request(
            "The authenticity of host 'build.example (10.0.0.1)' can't be established.\n\
             ED25519 key fingerprint is SHA256:abc.\n\
             Are you sure you want to continue connecting (yes/no/[fingerprint])? "
        ));
        // Keyboard-interactive: the *server* writes this text. This is the case the
        // check exists for — a host asking for anything it likes and being answered
        // with the account password.
        assert!(!prompt_is_password_request("Verification code: "));
        assert!(!prompt_is_password_request(
            "(alice@build.example) Password: "
        ));
        assert!(!prompt_is_password_request(
            "Enter your GitHub personal access token: "
        ));
        assert!(!prompt_is_password_request(
            "Duo two-factor login for alice"
        ));
    }

    #[test]
    fn password_args_close_every_prompt_but_the_password_one() {
        // The shim's shape check is defence in depth; THIS is the primary defence,
        // and it is invisible from the shim. If any of these disappear, ssh gains a
        // prompt nobody vetted — including keyboard-interactive, whose text the
        // server chooses. Asserted on both password builders.
        for args in [
            ssh_password_base_args(&Some("a".into()), "h", None).unwrap(),
            ssh_password_master_base_args(&Some("a".into()), "h", None).unwrap(),
        ] {
            let has = |opt: &str| args.iter().any(|a| a == opt);
            // No key passphrase prompt.
            assert!(has("PubkeyAuthentication=no"), "{args:?}");
            // No keyboard-interactive: excludes every server-authored prompt.
            assert!(has("PreferredAuthentications=password"), "{args:?}");
            // No interactive host-key confirmation (and a changed key is refused).
            assert!(has("StrictHostKeyChecking=accept-new"), "{args:?}");
            // One shot: a server cannot re-ask until it gets an answer it likes.
            assert!(has("NumberOfPasswordPrompts=1"), "{args:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn shim_answers_a_password_prompt_and_refuses_anything_else() {
        // Run the real shim the way OpenSSH runs it: argv[1] is the prompt, the
        // secret is in the environment. This is the behaviour, not a restatement
        // of the pattern.
        let ap = make_askpass("hunter2", &vetted_args()).unwrap();
        let run = |prompt: &str| exec_shim(&ap, prompt);

        let ok = run("alice@build.example's password: ");
        assert!(ok.status.success());
        assert_eq!(String::from_utf8_lossy(&ok.stdout).trim_end(), "hunter2");
        assert_eq!(ap.refused_prompt(), None, "nothing was refused");

        // A server-authored challenge gets nothing, and is recorded verbatim.
        let bad = run("Enter your GitHub personal access token: ");
        assert!(!bad.status.success(), "a refusal must fail the connect");
        assert!(
            !String::from_utf8_lossy(&bad.stdout).contains("hunter2"),
            "the secret must not be emitted for an unexpected prompt"
        );
        assert_eq!(
            ap.refused_prompt().as_deref(),
            Some("Enter your GitHub personal access token:"),
            "the caller must be able to tell the user what was actually asked"
        );

        // The record is part of the shim's temp files and goes with them.
        let reject = shim_file(&ap, crate::app_env!("ASKPASS_REJECT"));
        drop(ap);
        assert!(
            !reject.exists(),
            "the refusal record must be deleted on drop"
        );
    }

    // ── Key passphrases: the secret that must never reach the server ───────

    /// Real `ssh-keygen -t ed25519` output. Only the first base64 line matters
    /// (the cipher name lives there), so the bodies are truncated — which is also
    /// what `private_key_is_encrypted` reads in production.
    const UNENCRYPTED_ED25519: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
        b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAA\n\
        -----END OPENSSH PRIVATE KEY-----\n";
    const ENCRYPTED_ED25519: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
        b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAA\n\
        -----END OPENSSH PRIVATE KEY-----\n";

    #[test]
    fn private_key_encryption_is_read_from_the_openssh_v1_cipher_field() {
        // The modern default format announces nothing in its header — `none` vs a
        // real cipher name in the base64 body is the ONLY difference, so a reader
        // that keys on the header would call every key unencrypted.
        assert_eq!(private_key_is_encrypted(UNENCRYPTED_ED25519), Some(false));
        assert_eq!(private_key_is_encrypted(ENCRYPTED_ED25519), Some(true));
    }

    #[test]
    fn private_key_encryption_covers_the_older_formats_too() {
        // A real `~/.ssh` accumulates all three spellings.
        assert_eq!(
            private_key_is_encrypted(
                "-----BEGIN RSA PRIVATE KEY-----\n\
                 Proc-Type: 4,ENCRYPTED\n\
                 DEK-Info: AES-128-CBC,0123\n\nAAAA\n\
                 -----END RSA PRIVATE KEY-----\n"
            ),
            Some(true)
        );
        assert_eq!(
            private_key_is_encrypted(
                "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n\
                 -----END ENCRYPTED PRIVATE KEY-----\n"
            ),
            Some(true)
        );
        assert_eq!(
            private_key_is_encrypted(
                "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n"
            ),
            Some(false)
        );
        // Not a key at all → "don't know", never "unencrypted": the caller must be
        // able to tell an unreadable file from a confirmed plaintext key.
        assert_eq!(
            private_key_is_encrypted("ssh-ed25519 AAAAC3Nz me@box"),
            None
        );
        assert_eq!(private_key_is_encrypted(""), None);
    }

    #[test]
    fn the_two_prompt_tests_cannot_both_match() {
        // The whole safety of a second askpass mode rests on this: if a passphrase
        // shim could answer a password request (or vice versa), the argv guards
        // would be the only thing left between a local secret and the server.
        let password = "alice@build.example's password: ";
        let passphrase = "Enter passphrase for key '/home/alice/.ssh/id_ed25519': ";
        assert!(prompt_is_password_request(password));
        assert!(!prompt_is_key_passphrase_request(password));
        assert!(prompt_is_key_passphrase_request(passphrase));
        assert!(!prompt_is_password_request(passphrase));
    }

    #[test]
    fn passphrase_args_disable_every_server_facing_prompt() {
        for args in [
            ssh_passphrase_base_args(&Some("me".into()), "host.example", None).unwrap(),
            ssh_passphrase_master_base_args(&Some("me".into()), "host.example", None).unwrap(),
        ] {
            let has = |opt: &str| args.iter().any(|a| a == opt);
            // Pubkey only: a passphrase can never be offered as a login secret.
            assert!(has("PreferredAuthentications=publickey"), "{args:?}");
            assert!(has("PasswordAuthentication=no"), "{args:?}");
            assert!(has("KbdInteractiveAuthentication=no"), "{args:?}");
            assert!(has("StrictHostKeyChecking=accept-new"), "{args:?}");
            // Without this OpenSSH never raises the passphrase prompt at all —
            // which is precisely the bug this path exists to fix.
            assert!(has("BatchMode=no"), "{args:?}");
            assert_eq!(
                missing_single_prompt_opt_for(SecretKind::KeyPassphrase, &args),
                None
            );
        }
    }

    #[test]
    fn a_secret_is_refused_when_the_argv_does_not_match_its_kind() {
        // Cross-wiring the two argv builders must fail loudly, not silently send
        // the secret to whichever prompt the other argv happens to allow.
        let password_args = vetted_args();
        let passphrase_args =
            ssh_passphrase_base_args(&Some("me".into()), "host.example", None).unwrap();
        assert!(
            missing_single_prompt_opt_for(SecretKind::KeyPassphrase, &password_args).is_some(),
            "password argv must not be usable for a passphrase"
        );
        assert!(
            missing_single_prompt_opt_for(SecretKind::Password, &passphrase_args).is_some(),
            "passphrase argv must not be usable for a password"
        );
    }

    #[cfg(unix)]
    #[test]
    fn passphrase_shim_answers_only_the_passphrase_prompt() {
        // Same contract as the password shim, checked by running the real script.
        let args = ssh_passphrase_base_args(&Some("me".into()), "host.example", None).unwrap();
        let ap = make_askpass_for(SecretKind::KeyPassphrase, "hunter2", &args).unwrap();
        let run = |prompt: &str| exec_shim(&ap, prompt);

        let ok = run("Enter passphrase for key '/home/me/.ssh/id_ed25519': ");
        assert!(ok.status.success());
        assert_eq!(String::from_utf8_lossy(&ok.stdout).trim_end(), "hunter2");

        // The one that matters: a *password* request must get nothing, because
        // answering it would send the key's passphrase to the remote host.
        let bad = run("me@host.example's password: ");
        assert!(!bad.status.success());
        assert!(
            !String::from_utf8_lossy(&bad.stdout).contains("hunter2"),
            "a passphrase must never be released to a server-facing prompt"
        );
        assert!(ap.refused_prompt().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn the_answer_tally_counts_re_asks_and_is_what_catches_a_wrong_passphrase() {
        // Verified against a real host: OpenSSH re-asks a rejected passphrase three
        // times and then exits with a bare `Permission denied (publickey,...)` —
        // saying NOTHING about the decrypt failure. So the tally, not the stderr
        // text, is what stops a wrong passphrase from being retried as a login
        // password (which would send a local secret to the server).
        let args = ssh_passphrase_base_args(&Some("me".into()), "host.example", None).unwrap();
        let ap = make_askpass_for(SecretKind::KeyPassphrase, "hunter2", &args).unwrap();
        let ask = |prompt: &str| {
            exec_shim(&ap, prompt);
        };

        assert_eq!(ap.answer_count(), 0, "nothing asked yet");
        let prompt = "Enter passphrase for key '/home/me/.ssh/id_ed25519': ";
        ask(prompt);
        assert_eq!(ap.answer_count(), 1);
        // One answer is just "ssh asked once" — not yet evidence of anything.
        assert!(!secret_rejected_locally(
            SecretKind::KeyPassphrase,
            Some(&ap),
            "me@host.example: Permission denied (publickey)."
        ));

        // A re-ask can only mean the previous answer failed to decrypt the key.
        ask(prompt);
        assert_eq!(ap.answer_count(), 2);
        assert!(secret_rejected_locally(
            SecretKind::KeyPassphrase,
            Some(&ap),
            "me@host.example: Permission denied (publickey)."
        ));
        // A password has nothing to fall back to, so it is never "rejected locally"
        // however many times it was asked.
        assert!(!secret_rejected_locally(
            SecretKind::Password,
            Some(&ap),
            "me@host.example: Permission denied (publickey)."
        ));

        let tally = shim_file(&ap, crate::app_env!("ASKPASS_TALLY"));
        drop(ap);
        assert!(!tally.exists(), "the tally must be deleted on drop");
    }

    #[test]
    fn a_wrong_passphrase_is_named_as_such_not_as_a_login_failure() {
        // Verbatim OpenSSH stderr. Without this it falls through to the
        // permission-denied branch and the user is told to check a password they
        // never gave.
        let msg = explain_ssh_error(
            "Load key \"/home/me/.ssh/id_ed25519\": incorrect passphrase supplied to \
             decrypt private key\nme@host.example: Permission denied (publickey).",
        )
        .unwrap();
        assert!(msg.contains("passphrase"), "{msg}");
        assert!(
            !msg.contains("does not accept password logins"),
            "a local decrypt failure must not be blamed on the server: {msg}"
        );
        assert!(is_wrong_passphrase("incorrect passphrase supplied"));
        assert!(!is_wrong_passphrase(
            "me@host.example: Permission denied (publickey)."
        ));
    }

    #[test]
    fn a_refused_prompt_is_flattened_before_it_is_shown() {
        // The refused text can be server-authored, and it lands in a UI next to a
        // terminal. Escapes and newlines must not survive into it.
        let dirty = "\x1b[2JPassword\nfor\tthe\r\n\x07bank: ";
        let clean = sanitize_prompt(dirty);
        assert!(!clean.chars().any(char::is_control), "{clean:?}");
        assert_eq!(clean, "[2JPassword for the bank:");

        // And it cannot be used to flood the dialog.
        let long = sanitize_prompt(&"x".repeat(5000));
        assert!(long.chars().count() <= 201, "{}", long.chars().count());

        // The message names what was asked, and says nothing was sent.
        let msg = unexpected_prompt_error(&clean);
        assert!(msg.contains("bank"), "{msg}");
        assert!(msg.contains("sent nothing"), "{msg}");
    }

    // ── First contact ─────────────────────────────────────────────────────

    #[test]
    fn known_hosts_key_brackets_a_non_default_port() {
        // The form OpenSSH writes and `ssh-keygen -F` expects; getting this wrong
        // would call every non-22 host unknown, forever.
        assert_eq!(known_hosts_key("build.example", 22), "build.example");
        assert_eq!(
            known_hosts_key("build.example", 2222),
            "[build.example]:2222"
        );
    }

    #[test]
    fn keygen_fingerprints_parse_into_what_the_dialog_shows() {
        let out = "256 SHA256:6dq1x/N4iC build.example (ED25519)\n\
                   3072 SHA256:Zk9tQ1LmPo build.example (RSA)\n";
        let keys = parse_keygen_fingerprints(out);
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].bits, 256);
        assert_eq!(keys[0].key_type, "ED25519");
        assert_eq!(keys[0].fingerprint, "SHA256:6dq1x/N4iC");
        assert_eq!(keys[1].key_type, "RSA");
        // Junk lines are skipped rather than shown as a key with no fingerprint.
        assert!(parse_keygen_fingerprints("# comment\nnot a key\n").is_empty());
    }

    #[test]
    fn the_unknown_host_marker_is_what_the_frontend_matches() {
        // The frontend keys on this exact prefix to raise the fingerprint dialog
        // (`src/lib/remote/hostKey.ts`); a rename here silently turns that dialog into a
        // dead-end error message.
        assert_eq!(UNKNOWN_HOST_KEY, crate::app_env!("UNKNOWN_HOST_KEY"));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn a_password_cannot_be_attached_to_an_unvetted_ssh_command() {
        // The shim can only judge the prompt it is handed; WHICH prompts exist is
        // decided by the argv. So building the askpass against a command that has
        // not closed the other prompts must fail outright rather than produce a
        // working-looking connect that can be asked for anything.
        for missing in [
            "PubkeyAuthentication=no",
            "PreferredAuthentications=password",
            "StrictHostKeyChecking=accept-new",
            "NumberOfPasswordPrompts=1",
        ] {
            let args: Vec<String> = vetted_args().into_iter().filter(|a| a != missing).collect();
            assert_eq!(missing_single_prompt_opt(&args), Some(missing));
            // Deliberately not `unwrap_err`: that needs `Debug` on `Askpass`, which
            // holds the password — a derive here would print the secret into any
            // panic message. Match instead.
            match make_askpass("hunter2", &args) {
                Ok(_) => panic!("a password was attached to args missing {missing}"),
                Err(e) => assert!(e.contains(missing), "{e}"),
            }
        }
        // Key-auth args are never a password carrier: they close none of them.
        let key_args = ssh_base_args(&Some("me".to_string()), "host.example", None).unwrap();
        assert!(make_askpass("hunter2", &key_args).is_err());
        // And the real thing is accepted.
        assert_eq!(missing_single_prompt_opt(&vetted_args()), None);
        assert!(make_askpass("hunter2", &vetted_args()).is_ok());
    }
}
