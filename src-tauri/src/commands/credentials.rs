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
use app_core::sync::LockExt;
use std::sync::{Mutex, OnceLock};

use crate::commands::terminal::RegistryState;
use crate::terminal::PtyOptions;
use crate::services::remote_credentials::{self as creds, KeyringState};
use crate::tauri_host::Ctx;

// ── Login PTYs (which terminals may receive a secret) ────────────────────────
//
// `credential_paste_to_pty` used to write a saved secret into whatever PTY id the
// caller named. That defeats the design it implements: the secret never reaches JS,
// but it reaches a process JS chose, so a caller able to spawn `sh -c 'cat >
// /tmp/loot'` could read every saved SSH/OpenVPN password out of the keychain.
//
// So the backend spawns the login itself. A `pty_spawn` with `login` set names a
// *target* ([`LoginTarget`]), never a command line: [`apply_login`] replaces the
// caller's `cmd`/`args` with the argv the backend builds for that target
// (`ssh_exec::interactive_login_args` / `openvpn::interactive_connect_argv`),
// clears the caller's `env`, and runs that argv as the PTY's own program — no
// shell before or after it, so nothing else ever runs in that PTY. Only after
// such a spawn succeeds is the PTY marked ([`note_login_pty`]), and the mark goes
// with the spawn: dropped when its child exits ([`forget_login_pty_spawn`], from
// the reader task), when the PTY is killed ([`forget_login_pty`]), and at the top
// of every `pty_spawn` of that id. A paste is then only allowed into a PTY that is
// running, right now, the login Tabtivity built for that very credential — which
// is where the secret was always going to go.
//
// Accepted residual: after a successful ssh login the PTY is the remote shell of
// the very account the credential authenticates; a paste there stays allowed
// (same trust domain).
//
// Ceiling: the gate is no same-user boundary. The genuine ssh/openvpn read the
// user's own `~/.ssh/config`, `known_hosts`, the `.ovpn` and `PATH`, which any
// process running as the user can rewrite (and such a process can usually read an
// unlocked keyring directly). It stops a caller of the commands, nothing more.
//
// A server client's ssh login may dial only a host the owner already configured
// — a remote project's primary or worker host, or a global machine — matched on
// user, host and port as the keychain account spells them
// ([`ssh_login_configured`]); anything else would let a browser client make the
// server dial any host and port. The desktop window keeps any host (adding a
// machine or project logs in before it is stored).

/// Which login a login PTY runs — i.e. which saved credentials may be typed into
/// it. Also `PtyOptions::login`'s payload, tagged by `kind`:
/// `{"kind":"ssh","user":…|null,"host":…,"port":…|null}` /
/// `{"kind":"vpn","config":…}`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
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

    /// The login's argv, program first. Building a VPN one also claims the tunnel
    /// (`openvpn::interactive_connect_argv`'s pidfile and management socket).
    fn argv(&self) -> Result<Vec<String>, String> {
        match self {
            Self::Ssh { user, host, port } => {
                #[allow(unused_mut)]
                let mut argv = crate::services::ssh_exec::interactive_login_args(user, host, *port)?;
                #[cfg(windows)]
                pin_program(&mut argv, |bin| {
                    crate::paths::helper_program(std::ffi::OsStr::new(bin))
                        .or_else(|| crate::paths::resolve_executable(&format!("{bin}.exe")))
                })?;
                Ok(argv)
            }
            Self::Vpn { config } => crate::services::openvpn::interactive_connect_argv(config),
        }
    }
}

/// Pin a login argv's program to the absolute path `resolve` finds for it.
///
/// Windows needs this for `ssh`: the PTY layer (portable-pty) looks a bare name up
/// on `PATH` only, and one it cannot find there goes to `CreateProcessW` as the
/// module name, which completes a partial name from the app's current directory —
/// so a file named `ssh` planted there would be the login a secret is pasted into.
/// The admin-installed copy is preferred, then `PATH` (as `openvpn.exe` is
/// resolved for a VPN login); none found refuses the login.
#[cfg(any(windows, test))]
fn pin_program(
    argv: &mut [String],
    resolve: impl FnOnce(&str) -> Option<std::path::PathBuf>,
) -> Result<(), String> {
    let program = argv.first_mut().ok_or_else(|| "empty login command".to_string())?;
    let path = resolve(program.as_str())
        .filter(|p| p.is_absolute())
        .ok_or_else(|| format!("{program} was not found; install the OpenSSH client"))?;
    *program = path.to_string_lossy().into_owned();
    Ok(())
}

/// PTY id → the login its current spawn runs, and that spawn's sequence number
/// (`PreparedLaunch::spawn_seq`).
fn login_ptys() -> &'static Mutex<HashMap<String, (LoginTarget, u64)>> {
    static MAP: OnceLock<Mutex<HashMap<String, (LoginTarget, u64)>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Why a `pty_spawn` asking for `target` from `caller` must not run, if it must
/// not. A login PTY is a plain local root PTY: nothing that would put it in a
/// project, a container, a fence, a tmux session or a schedule may ride along.
fn login_refusal(
    opts: &PtyOptions,
    target: &LoginTarget,
    caller: &app_core::Caller,
) -> Option<&'static str> {
    let flags: [(bool, &'static str); 9] = [
        (opts.project_id.is_some(), "a project tab"),
        (opts.agent, "an agent tab"),
        (opts.sandbox, "a container tab"),
        (opts.host_session, "the Host session"),
        (opts.local_model, "a local-model tab"),
        (opts.tmux_session.is_some(), "a tmux session"),
        (opts.tmux_attach.is_some(), "a tmux attach"),
        (opts.host_bound_uid.is_some(), "a host-bound tab"),
        (opts.schedule_target_id.is_some(), "a scheduled tab"),
    ];
    if let Some((_, what)) = flags.into_iter().find(|(set, _)| *set) {
        return Some(what);
    }
    // OpenVPN is machine-wide and owned by the desktop's VPN indicator; a server
    // client was never allowed to bring a tunnel up (`openvpn_login_command` was
    // an admin command), and `pty_spawn` is a core one.
    if matches!(target, LoginTarget::Vpn { .. }) && matches!(caller, app_core::Caller::Client(_)) {
        return Some("a browser client (a VPN login is the desktop's)");
    }
    None
}

/// Whether `target` is an ssh login to one of `configured` — the same user, host
/// and port, compared as the keychain account spells them
/// ([`creds::ssh_account`]: trimmed, host case-folded, no port = 22).
fn ssh_login_known(
    target: &LoginTarget,
    configured: impl IntoIterator<Item = crate::services::remote::SshAddress>,
) -> bool {
    let LoginTarget::Ssh { user, host, port } = target else {
        return false;
    };
    let wanted = creds::ssh_account(user, host, *port);
    configured
        .into_iter()
        .any(|(user, host, port)| creds::ssh_account(&user, &host, port) == wanted)
}

/// [`ssh_login_known`] against what the owner configured: every remote project's
/// primary and worker hosts (`projects.json`) and every global machine.
fn ssh_login_configured(target: &LoginTarget) -> bool {
    let machines = crate::commands::global_machines::load_all()
        .into_iter()
        .map(|m| (m.user, m.host, m.port));
    ssh_login_known(
        target,
        crate::services::remote::configured_project_ssh_addresses()
            .into_iter()
            .chain(machines),
    )
}

/// Turn a `pty_spawn` that asks for a login into the login itself, before
/// anything else reads its options. `None` when `opts.login` is unset (an
/// ordinary spawn, untouched).
///
/// With a login: refuse the combinations [`login_refusal`] names and a server
/// client's ssh login to a host nothing configures, then replace
/// the caller's `cmd`/`args` with the backend's argv for the target, clear its
/// `env` (a caller-chosen `LD_PRELOAD` or `PATH` would capture the very secret
/// this gate protects), run it in the root work dir and never ssh-wrap it.
pub(crate) fn apply_login(
    opts: &mut PtyOptions,
    caller: &app_core::Caller,
) -> Result<Option<LoginTarget>, String> {
    apply_login_with(opts, caller, ssh_login_configured)
}

/// [`apply_login`] with the configured-host check passed in (tests).
fn apply_login_with(
    opts: &mut PtyOptions,
    caller: &app_core::Caller,
    ssh_configured: impl FnOnce(&LoginTarget) -> bool,
) -> Result<Option<LoginTarget>, String> {
    let Some(target) = opts.login.clone() else {
        return Ok(None);
    };
    if let Some(what) = login_refusal(opts, &target, caller) {
        return Err(format!("a login terminal cannot be {what}"));
    }
    // A server client dials only hosts the owner configured (module comment).
    if matches!(target, LoginTarget::Ssh { .. })
        && matches!(caller, app_core::Caller::Client(_))
        && !ssh_configured(&target)
    {
        return Err(
            "a browser client may open an ssh login only to a host a remote project or machine names"
                .to_string(),
        );
    }
    let mut argv = target.argv()?.into_iter();
    let program = argv.next().ok_or_else(|| "empty login command".to_string())?;
    opts.cmd = program;
    opts.args = argv.collect();
    opts.env.clear();
    opts.cwd = String::new();
    opts.local_only = true;
    opts.remote_host_id = None;
    Ok(Some(target))
}

/// Mark `pty`'s spawn `seq` as running the login for `target`. Called by
/// `pty_spawn` once a login spawn succeeded — the only writer of the mark.
///
/// A login that ends at once (ssh refused, a bad config) can have its reader
/// close the spawn before this runs, and that reader's
/// [`forget_login_pty_spawn`] then found nothing to drop. So the mark goes in
/// first and the spawn is checked after: a reader that closes it later still
/// drops the mark, and one that already did is caught here.
pub(crate) fn note_login_pty(pty: &str, target: LoginTarget, seq: u64) {
    note_login_pty_if(pty, target, seq, || crate::terminal::route_spawn_live(pty, seq));
}

fn note_login_pty_if(pty: &str, target: LoginTarget, seq: u64, live: impl FnOnce() -> bool) {
    login_ptys().lock_ok().insert(pty.to_string(), (target, seq));
    if !live() {
        forget_login_pty_spawn(pty, seq);
    }
}

/// Forget a PTY's login mark, whatever spawn set it: the PTY is killed, or is
/// about to be respawned (a respawn of the id must not inherit the mark).
pub fn forget_login_pty(pty: &str) {
    login_ptys().lock_ok().remove(pty);
}

/// Forget `pty`'s login mark when spawn `seq` set it: that spawn's child exited,
/// so the login is over. A newer spawn's mark is left alone.
pub fn forget_login_pty_spawn(pty: &str, seq: u64) {
    let mut map = login_ptys().lock_ok();
    if map.get(pty).is_some_and(|(_, s)| *s == seq) {
        map.remove(pty);
    }
}

/// Whether `account` may be typed into `pty` — i.e. `pty` is running a login whose
/// own credentials include that account. (The paste itself also checks that the
/// PTY still runs the marked spawn — see [`marked_spawn`].)
#[cfg(test)]
fn paste_allowed(pty: &str, account: &str) -> bool {
    marked_spawn(pty, account).is_some()
}

/// The spawn of `pty` that runs a login whose own credentials include `account`.
/// The paste still checks that `pty` runs that very spawn: a respawn of the id
/// that began before the login's mark went in (its own `forget_login_pty` already
/// ran) replaces the PTY without dropping the mark, and the replaced reader's
/// exit is not the current spawn's, so it drops nothing either.
fn marked_spawn(pty: &str, account: &str) -> Option<u64> {
    login_ptys()
        .lock_ok()
        .get(pty)
        .filter(|(t, _)| t.accounts().iter().any(|a| a == account))
        .map(|(_, seq)| *seq)
}

/// A VPN login's tunnel claim (`openvpn::interactive_connect_argv` arms it while
/// [`apply_login`] builds the argv) until the login's PTY runs: dropped without
/// [`LoginClaim::keep`] — any `pty_spawn` error after the argv was built — it is
/// handed back (`openvpn::release_interactive_claim`), so no Pending claim and
/// management endpoint stay recorded with no process behind them.
pub(crate) struct LoginClaim(Option<String>);

impl LoginClaim {
    pub(crate) fn of(target: Option<&LoginTarget>) -> Self {
        Self(match target {
            Some(LoginTarget::Vpn { config }) => Some(config.clone()),
            _ => None,
        })
    }

    /// The login runs: its claim is the tunnel's now.
    pub(crate) fn keep(mut self) {
        self.0 = None;
    }
}

impl Drop for LoginClaim {
    fn drop(&mut self) {
        if let Some(config) = self.0.take() {
            crate::services::openvpn::release_interactive_claim(&config);
        }
    }
}

/// Whether the OS credential store is readable right now (see [`KeyringState`]).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn keyring_state() -> KeyringState {
    app_core::rt::spawn_blocking(creds::keyring_state)
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn keyring_unlock() -> Result<(), String> {
    app_core::rt::try_blocking("keyring unlock", creds::unlock_keyring).await
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn credential_paste_to_pty(
    ctx: Ctx,
    pty: String,
    target: PasteCredential,
    submit: Option<bool>,
) -> Result<bool, String> {
    let registry = ctx.get::<RegistryState>();
    // A server client's login runs in its own PTY onto the tab (TODO #2347):
    // that is where `pty_write` saw it typed, and where the secret goes.
    let pty = crate::commands::terminal::pty_id_for(&ctx, registry, pty);
    let account = target.account();
    // The destination must be a PTY the backend itself spawned running the login
    // this credential belongs to, still running (see "Login PTYs" above). Without
    // this the caller picks the process the secret is written into.
    let not_a_login = || {
        "that terminal is not a login for this credential — open the connection's login \
         terminal and try again"
            .to_string()
    };
    let seq = marked_spawn(&pty, &account).ok_or_else(not_a_login)?;
    if registry.lock_ok().input_sender_of_spawn(&pty, seq).is_none() {
        return Err(not_a_login());
    }
    let Some(secret) = app_core::rt::blocking("credential read", move || creds::get(&account))
        .await?
    else {
        return Ok(false);
    };
    let mut bytes = secret.into_bytes();
    if submit.unwrap_or(false) {
        bytes.push(b'\r');
    }
    let sender = registry
        .lock_ok()
        .input_sender_of_spawn(&pty, seq)
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
    use app_core::{Caller, ClientId};

    fn ssh(host: &str) -> LoginTarget {
        LoginTarget::Ssh {
            user: Some("alice".to_string()),
            host: host.to_string(),
            port: None,
        }
    }

    fn client() -> Caller {
        Caller::Client(ClientId::new("web-1"))
    }

    fn window() -> Caller {
        Caller::Local(ClientId::new("main"))
    }

    /// A spawn as the renderer sends it — here a hostile one, whose command line
    /// would capture whatever is typed into it.
    fn hostile(id: &str, login: serde_json::Value) -> PtyOptions {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "cmd": "sh",
            "args": ["-c", "cat > /tmp/loot"],
            "env": { "LD_PRELOAD": "/tmp/evil.so", "PATH": "/tmp/evil" },
            "cwd": "/tmp",
            "cols": 80,
            "rows": 24,
            "login": login,
        }))
        .expect("a pty_spawn payload")
    }

    /// The mark is the whole gate: a PTY that no login spawn marked takes no
    /// secret, and a marked one takes only its own login's.
    #[test]
    fn only_a_pty_spawned_as_that_login_accepts_its_secret() {
        let pid = std::process::id();
        let config = format!(concat!("/tmp/", crate::app_slug!(), "-test-{}.ovpn"), pid);
        let host = format!("host-{pid}");
        let vpn_account = creds::openvpn_account(&config);
        let ssh_account = creds::ssh_account(&Some("alice".to_string()), &host, None);

        // A PTY no login spawn marked — the "spawn `cat > /tmp/loot`" case.
        assert!(!paste_allowed("t-gate:evil", &vpn_account));
        assert!(!paste_allowed("t-gate:evil", &ssh_account));

        note_login_pty_if("t-gate:vpn", LoginTarget::Vpn { config: config.clone() }, 1, || true);
        assert!(paste_allowed("t-gate:vpn", &vpn_account));
        // …and the tunnel's other two secrets are legitimate there too.
        assert!(paste_allowed("t-gate:vpn", &creds::openvpn_key_account(&config)));
        assert!(paste_allowed("t-gate:vpn", &creds::openvpn_user_account(&config)));
        // But an SSH password is not: a VPN login is not that host's login.
        assert!(!paste_allowed("t-gate:vpn", &ssh_account));

        note_login_pty_if("t-gate:ssh", ssh(&host), 1, || true);
        assert!(paste_allowed("t-gate:ssh", &ssh_account));
        assert!(!paste_allowed("t-gate:ssh", &vpn_account));
        // Another host's password is not this login's either.
        let other = creds::ssh_account(&Some("alice".to_string()), "elsewhere", None);
        assert!(!paste_allowed("t-gate:ssh", &other));

        // Killing the terminal drops the mark, so a reused id starts unblessed.
        forget_login_pty("t-gate:vpn");
        assert!(!paste_allowed("t-gate:vpn", &vpn_account));
        forget_login_pty("t-gate:ssh");
    }

    /// A login whose child exited is over: its PTY is no paste target, however
    /// the exit and the mark interleave — and an older spawn's exit never drops a
    /// newer spawn's mark.
    #[test]
    fn a_login_whose_child_exited_is_refused() {
        let host = format!("exit-{}", std::process::id());
        let account = creds::ssh_account(&Some("alice".to_string()), &host, None);

        // The reader closes the spawn after the mark went in.
        note_login_pty_if("t-exit:a", ssh(&host), 7, || true);
        forget_login_pty_spawn("t-exit:a", 6); // an older spawn's exit: no effect
        assert!(paste_allowed("t-exit:a", &account));
        forget_login_pty_spawn("t-exit:a", 7);
        assert!(!paste_allowed("t-exit:a", &account));

        // The reader closed the spawn before the mark went in (ssh refused at once).
        note_login_pty_if("t-exit:b", ssh(&host), 3, || false);
        assert!(!paste_allowed("t-exit:b", &account));

        // The real liveness check: no open route for this spawn means it ended.
        note_login_pty("t-exit:c", ssh(&host), 9);
        assert!(!paste_allowed("t-exit:c", &account));
    }

    /// With `login` set the caller's command line, environment and cwd are gone:
    /// the PTY runs the backend's own ssh argv for the target, locally.
    #[test]
    fn a_login_spawn_ignores_the_callers_cmd_args_and_env() {
        let mut opts = hostile(
            "root:login-ssh",
            serde_json::json!({ "kind": "ssh", "user": "alice", "host": "host.example", "port": 2222 }),
        );
        opts.remote_host_id = Some("worker".to_string());
        let target = apply_login_with(&mut opts, &client(), |_| true).unwrap();
        assert_eq!(
            target,
            Some(LoginTarget::Ssh {
                user: Some("alice".to_string()),
                host: "host.example".to_string(),
                port: Some(2222),
            })
        );
        assert_eq!(opts.cmd, "ssh");
        assert_eq!(opts.args.last().map(String::as_str), Some("alice@host.example"));
        assert!(opts.args.windows(2).any(|w| w == ["-p", "2222"]));
        assert!(!opts.args.iter().any(|a| a.contains("loot")), "{:?}", opts.args);
        assert!(opts.env.is_empty(), "a caller's LD_PRELOAD/PATH must not reach a login");
        assert_eq!(opts.cwd, "");
        assert!(opts.local_only);
        assert_eq!(opts.remote_host_id, None);

        // A bad target is refused by the argv builder, not run.
        let mut bad = hostile("root:login-bad", serde_json::json!({ "kind": "ssh", "host": "-oProxyCommand=x" }));
        assert!(apply_login(&mut bad, &window()).is_err());
    }

    /// Without `login` a spawn is untouched, and nothing marks it.
    #[test]
    fn an_ordinary_spawn_is_not_a_login() {
        let mut opts = hostile("root:plain", serde_json::Value::Null);
        assert_eq!(apply_login(&mut opts, &window()).unwrap(), None);
        assert_eq!(opts.cmd, "sh");
        assert_eq!(opts.env.len(), 2);
        // The key may be left out entirely.
        let bare: PtyOptions = serde_json::from_value(serde_json::json!({
            "id": "root:bare", "cmd": "sh", "args": [], "cwd": "", "cols": 80, "rows": 24,
        }))
        .unwrap();
        assert_eq!(bare.login, None);
    }

    /// A login PTY is a plain local root PTY: every flag that would make it a
    /// project, agent, container, fenced, tmux or scheduled tab is refused.
    #[test]
    fn a_login_refuses_every_other_kind_of_tab() {
        let login = serde_json::json!({ "kind": "ssh", "user": null, "host": "h", "port": null });
        type Set = fn(&mut PtyOptions);
        let cases: [(&str, Set); 9] = [
            ("project", |o| o.project_id = Some("p".to_string())),
            ("agent", |o| o.agent = true),
            ("sandbox", |o| o.sandbox = true),
            ("host_session", |o| o.host_session = true),
            ("local_model", |o| o.local_model = true),
            ("tmux_session", |o| o.tmux_session = Some("s".to_string())),
            ("tmux_attach", |o| o.tmux_attach = Some("s".to_string())),
            ("host_bound_uid", |o| o.host_bound_uid = Some("u".to_string())),
            ("schedule_target_id", |o| o.schedule_target_id = Some("t".to_string())),
        ];
        for (name, set) in cases {
            let mut opts = hostile("root:combo", login.clone());
            set(&mut opts);
            assert!(apply_login(&mut opts, &window()).is_err(), "login + {name} must be refused");
            assert_eq!(opts.cmd, "sh", "a refused login changes nothing ({name})");
        }
    }

    /// OpenVPN is machine-wide and the desktop's: a browser client may not bring
    /// a tunnel up through a login PTY (`openvpn_login_command` was admin-only),
    /// even when every ssh host counted as configured.
    #[test]
    fn a_vpn_login_is_refused_for_a_client() {
        let vpn = serde_json::json!({ "kind": "vpn", "config": "/home/u/work.ovpn" });
        let mut opts = hostile("root:vpn", vpn);
        let err = apply_login_with(&mut opts, &client(), |_| true).unwrap_err();
        assert!(err.contains("client"), "{err}");
        assert_eq!(opts.cmd, "sh");
    }

    /// F-d: a browser client's ssh login runs only to a host the owner
    /// configured; anything else is refused before an argv exists. The desktop
    /// window is never asked (it logs in to a machine before storing it).
    #[test]
    fn a_clients_ssh_login_needs_a_configured_host() {
        let ssh = serde_json::json!({ "kind": "ssh", "user": "alice", "host": "h.example", "port": 2222 });
        let mut opts = hostile("root:ssh", ssh.clone());
        let err = apply_login_with(&mut opts, &client(), |_| false).unwrap_err();
        assert!(err.contains("browser client") && err.contains("machine"), "{err}");
        assert_eq!(opts.cmd, "sh", "a refused login changes nothing");

        let mut opts = hostile("root:ssh", ssh.clone());
        let mut asked = None;
        assert!(apply_login_with(&mut opts, &client(), |t| {
            asked = Some(t.clone());
            true
        })
        .unwrap()
        .is_some());
        assert_eq!(asked, Some(LoginTarget::Ssh {
            user: Some("alice".into()),
            host: "h.example".into(),
            port: Some(2222),
        }));
        assert_eq!(opts.cmd, "ssh");

        let mut opts = hostile("root:ssh", ssh);
        let target = apply_login_with(&mut opts, &window(), |_| panic!("the desktop is never asked")).unwrap();
        assert!(target.is_some());
    }

    /// What counts as configured: a remote project's primary or worker host, or
    /// a global machine — same user, host and port, spelled as the keychain
    /// account spells them. Another user, port or host, or a local project, is
    /// not.
    #[test]
    fn a_configured_ssh_host_is_a_projects_or_a_machines() {
        let list: crate::schema::projects::ProjectsList = serde_json::from_value(serde_json::json!([
            { "id": "p1", "name": "P1", "status": "active", "position": 0, "local_file": "",
              "remote": { "user": "alice", "host": "Build.Example", "remote_path": "/srv/p1" },
              "compute_hosts": [{ "id": "w1", "user": "bob", "host": "gpu.example", "port": 2200,
                                  "remote_path": "/srv/p1" }] },
            { "id": "p2", "name": "P2", "status": "active", "position": 1, "local_file": "",
              "directory": "/home/u/local" },
        ]))
        .unwrap();
        let mut known = crate::services::remote::ssh_addresses_of(&list);
        known.push((None, "machine.example".into(), Some(2022)));
        let login = |user: Option<&str>, host: &str, port: Option<u16>| LoginTarget::Ssh {
            user: user.map(str::to_string),
            host: host.to_string(),
            port,
        };
        let allowed = |t: LoginTarget| ssh_login_known(&t, known.clone());

        assert!(allowed(login(Some("alice"), "build.example", None)), "the primary, host case-folded");
        assert!(allowed(login(Some("alice"), " build.example ", Some(22))), "port 22 is no port");
        assert!(allowed(login(Some("bob"), "gpu.example", Some(2200))), "a worker host");
        assert!(allowed(login(None, "machine.example", Some(2022))), "a global machine");
        assert!(allowed(login(Some(""), "machine.example", Some(2022))), "a blank user is none");

        assert!(!allowed(login(Some("root"), "build.example", None)), "another user");
        assert!(!allowed(login(Some("alice"), "build.example", Some(2222))), "another port");
        assert!(!allowed(login(Some("bob"), "gpu.example", None)), "the worker's port is part of it");
        assert!(!allowed(login(None, "evil.example", None)), "an unknown host");
        assert!(!allowed(login(Some("alice"), "machine.example", Some(2022))), "the machine's user is none");
        assert!(!ssh_login_known(&LoginTarget::Vpn { config: "/a.ovpn".into() }, known.clone()));
        assert!(!ssh_login_known(&login(None, "machine.example", Some(2022)), Vec::new()), "nothing configured");
    }

    /// The desktop window's VPN login runs the elevated connect argv itself.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_vpn_login_runs_the_connect_argv() {
        let config = format!(concat!("/tmp/", crate::app_slug!(), "-login-{}.ovpn"), std::process::id());
        let mut opts = hostile("root:vpn-ok", serde_json::json!({ "kind": "vpn", "config": config }));
        let target = apply_login(&mut opts, &window()).unwrap();
        assert_eq!(target, Some(LoginTarget::Vpn { config: config.clone() }));
        assert_eq!(opts.cmd, "pkexec");
        assert_eq!(&opts.args[..3], ["openvpn", "--config", config.as_str()]);
        assert!(opts.env.is_empty());
    }

    /// The payload is tagged by `kind`; an unknown kind is not a login.
    #[test]
    fn login_payload_shape() {
        let vpn: LoginTarget =
            serde_json::from_value(serde_json::json!({ "kind": "vpn", "config": "/a.ovpn" })).unwrap();
        assert_eq!(vpn, LoginTarget::Vpn { config: "/a.ovpn".to_string() });
        let ssh: LoginTarget =
            serde_json::from_value(serde_json::json!({ "kind": "ssh", "user": null, "host": "h", "port": 22 }))
                .unwrap();
        assert_eq!(ssh, LoginTarget::Ssh { user: None, host: "h".to_string(), port: Some(22) });
        assert!(serde_json::from_value::<LoginTarget>(serde_json::json!({ "kind": "shell", "cmd": "sh" })).is_err());
    }

    /// End to end through `pty_spawn`: a refused login spawns nothing — and any
    /// spawn of an id, refused or not, first drops that id's old mark, so a
    /// respawn never inherits it.
    #[tokio::test]
    async fn pty_spawn_refuses_a_bad_login_and_drops_the_ids_mark() {
        use std::sync::Arc;
        let registry: RegistryState = Arc::default();
        let events = Arc::new(crate::services::mobile_control::web_client::WebEvents::default());
        let core = app_core::CoreCtx::system(
            Arc::new(app_core::CoreState::new().manage(registry.clone())),
            events,
        );
        let host = format!("spawn-{}", std::process::id());
        let account = creds::ssh_account(&Some("alice".to_string()), &host, None);

        note_login_pty_if("t-spawn:vpn", ssh(&host), 1, || true);
        let ctx = Ctx(core.with_caller(client()));
        let opts = hostile("t-spawn:vpn", serde_json::json!({ "kind": "vpn", "config": "/home/u/w.ovpn" }));
        let err = crate::commands::terminal::pty_spawn(ctx, opts, None).await.unwrap_err();
        assert!(err.contains("client"), "{err}");
        assert!(!paste_allowed("t-spawn:vpn", &account), "a respawn of the id drops its mark");

        note_login_pty_if("t-spawn:proj", ssh(&host), 1, || true);
        let ctx = Ctx(core.with_caller(window()));
        let mut opts = hostile("t-spawn:proj", serde_json::json!({ "kind": "ssh", "host": host }));
        opts.project_id = Some("p".to_string());
        assert!(crate::commands::terminal::pty_spawn(ctx, opts, None).await.is_err());
        assert!(!paste_allowed("t-spawn:proj", &account));
        assert!(registry.lock_ok().input_sender("t-spawn:proj").is_none(), "nothing spawned");
    }

    /// Verifier finding (S1): a respawn of the id that began before the login's
    /// mark went in (its `forget_login_pty` already ran) replaces the login PTY and
    /// leaves the mark, and the replaced reader's exit is not the current spawn's,
    /// so it drops nothing. The mark names its spawn; a PTY running another spawn
    /// takes no secret — refused before the keychain is read.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_paste_into_a_respawn_of_a_login_id_is_refused() {
        use std::sync::Arc;
        let registry: RegistryState = Arc::default();
        let events = Arc::new(crate::services::mobile_control::web_client::WebEvents::default());
        let core = app_core::CoreCtx::system(
            Arc::new(app_core::CoreState::new().manage(registry.clone())),
            events,
        );
        let host = format!("race-{}", std::process::id());
        let id = "t-race:login";
        // The login ran as spawn 41 and was marked; a racing spawn 42 of the same
        // id (say `sh -c 'cat > /tmp/loot'`) now holds the PTY.
        note_login_pty_if(id, ssh(&host), 41, || true);
        crate::terminal::insert_test_pty_at(&registry, id, crate::terminal::PtyMeta::default(), 42);
        assert!(paste_allowed(id, &creds::ssh_account(&Some("alice".to_string()), &host, None)));
        assert!(registry.lock_ok().input_sender_of_spawn(id, 41).is_none());
        assert!(registry.lock_ok().input_sender_of_spawn(id, 42).is_some());

        let target = PasteCredential::SshPassword {
            user: Some("alice".to_string()),
            host: host.clone(),
            port: None,
        };
        let ctx = Ctx(core.with_caller(window()));
        let err = credential_paste_to_pty(ctx, id.to_string(), target, None).await.unwrap_err();
        assert!(err.contains("not a login"), "{err}");

        crate::terminal::kill_test_ptys(&registry);
        forget_login_pty(id);
    }

    /// A VPN login's claim goes back when its PTY never ran, and stays with a
    /// login that did; an ssh login holds no claim.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_vpn_login_that_never_ran_hands_its_claim_back() {
        let config = format!(concat!("/tmp/", crate::app_slug!(), "-claim-{}.ovpn"), std::process::id());
        let target = LoginTarget::Vpn { config: config.clone() };
        let connected = || crate::services::openvpn::has_interactive_claim(&config);

        // Spawn failed after the argv was built: the claim is dropped.
        target.argv().unwrap();
        assert!(connected(), "building the argv claimed the tunnel");
        drop(LoginClaim::of(Some(&target)));
        assert!(!connected(), "a login that never ran leaves no claim");

        // The login runs: the claim stays (the tunnel's teardown needs it).
        target.argv().unwrap();
        LoginClaim::of(Some(&target)).keep();
        assert!(connected());
        crate::services::openvpn::release_interactive_claim(&config);
        assert!(!connected());

        // Nothing to hand back for an ssh login.
        drop(LoginClaim::of(Some(&ssh("claim-ssh"))));
        drop(LoginClaim::of(None));
    }

    /// F6: the login's program is pinned to the absolute path found for it; a
    /// bare or missing one refuses the login rather than leave the lookup to the
    /// PTY layer.
    #[test]
    fn a_login_program_is_pinned_to_an_absolute_path() {
        let abs = if cfg!(windows) {
            std::path::PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe")
        } else {
            std::path::PathBuf::from("/usr/bin/ssh")
        };
        let mut argv = vec!["ssh".to_string(), "alice@h".to_string()];
        pin_program(&mut argv, |bin| {
            assert_eq!(bin, "ssh");
            Some(abs.clone())
        })
        .unwrap();
        assert_eq!(argv, [abs.to_string_lossy().into_owned(), "alice@h".to_string()]);

        let mut argv = vec!["ssh".to_string()];
        assert!(pin_program(&mut argv, |_| None).is_err());
        assert!(pin_program(&mut argv, |_| Some(std::path::PathBuf::from("ssh.exe"))).is_err());
        assert_eq!(argv, ["ssh"], "a refused pin changes nothing");
        assert!(pin_program(&mut [], |_| Some(abs.clone())).is_err());
    }
}
