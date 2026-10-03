//! The administrator's agent API keys, the daemon's half (hosted plan §5.2,
//! §5.4, P3b). The keys themselves live with the key keeper
//! (`src-gateway/src/keeper.rs`, `<slug>-auth`), which hands one only to the
//! users the administrator put on that key's list; this module is what a
//! user's own daemon does with them:
//!
//! * **The choice is the user's, per CLI** (§5.2): `<state>/agent-auth/
//!   admin-keys.json` lists the CLIs whose agents run on the administrator's
//!   key; every other CLI runs on the user's own login, the default. Written
//!   only by [`choose`], which refuses outside a hosted server, so the
//!   desktop never has the file.
//! * **Never both.** While a CLI is on the administrator's key,
//!   `agent_auth` takes the user's own login copies *out* of every agent
//!   home (the store keeps them; switching back puts them in again), so the
//!   CLI never has to pick between the administrator's key and a login file.
//! * **Delivery, Claude** ([`HELPER_CLIS`]): through its `apiKeyHelper`, never
//!   its environment — so Claude asks no "use this API key?" question and
//!   writes nothing of the key into `.claude.json`. The scope home's
//!   `.claude/settings.json` names `<this binary> --key-helper <socket>`
//!   ([`sync_helper_settings`], only while the user chose the key); the
//!   socket is this daemon's ([`serve_helpers`], `<state>/key-helper/
//!   claude.sock`, `0600` in a `0700` dir), which asks the keeper at every
//!   call. The fence hides `/run` and the state dir, so a spawn of a chosen
//!   helper CLI gets that one directory bound read-only into its fence
//!   ([`prepare_spawn`]'s answer) — no other fence has it. One socket per CLI,
//!   not per spawn: tmux tabs outlive a daemon restart, and Claude runs the
//!   helper again every few minutes; a directory bind sees the restarted
//!   daemon's new socket, a per-spawn listener would have died with the old.
//! * **Delivery, the others** (Gemini, Vibe): at each local agent spawn — an
//!   agent tab, the root console's Host session, a CLI typed into a shell tab
//!   through the `agent_bin` shim — the key is fetched from the keeper and
//!   put into the CLI's own variable (the registry's `api_key_env` column).
//!   It is never cached, written to a file, put on an argv or sent to a
//!   client; `tmux_local` carries it like the root console's tokens (its
//!   `SECRET_ENV`, through the client's environment).
//! * **Containers** ([`container_env`]): a project container's agent tab gets
//!   the key in its `docker exec` environment, named on the argv only (the
//!   docker client's own environment holds the value); Claude's helper there
//!   prints [`CONTAINER_KEY_ENV`] instead of asking this daemon. Remote agents
//!   and Codex get nothing (decided, #2359/#2361).
//! * **Withdrawn, or the user taken off the key's list**: the next spawn fails
//!   with a message naming the way back. Gemini and Vibe agents already
//!   running keep the key they started with (§5.4: rotate it at the provider
//!   to take it from them); a running Claude loses it at its next helper call.
//! * **Exposure, as §5.4 accepts it:** every agent of a user who opted in
//!   can read the key (its environment, or its helper), and direct mode has
//!   no per-user budget (the broker is P5).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::keys_wire::{Fingerprint, Offer, Reply, Request};
use crate::brand;

/// The user's choice, in the login store's root.
pub const CHOICE_FILE: &str = "admin-keys.json";
/// The CLIs that take the administrator's key through a helper command this
/// binary answers (Claude's `apiKeyHelper` setting) instead of a variable.
pub const HELPER_CLIS: &[&str] = &["claude"];
/// The daemon's helper sockets: `<state>/<HELPER_DIR>/<cli>.sock`.
pub const HELPER_DIR: &str = "key-helper";
/// This binary's verb that prints the key a helper socket answers.
pub const HELPER_ARG: &str = "--key-helper";
/// The variable Claude's helper prints inside a project container, where no
/// daemon socket is reachable (`SECRET` in the name: no legacy twin is ever
/// exported, `brand::Pair::export_both`).
pub const CONTAINER_KEY_ENV: &str = crate::app_env!("ADMIN_KEY_SECRET");
/// One request's whole exchange with the keeper.
#[cfg(unix)]
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(3);

#[derive(Debug, Default, Serialize, Deserialize)]
struct Choice {
    #[serde(default)]
    clis: BTreeSet<String>,
}

pub fn choice_path_in(state_dir: &Path) -> PathBuf {
    crate::services::agent_auth::store_root_in(state_dir).join(CHOICE_FILE)
}

/// The CLIs this user runs on the administrator's key. Pure over
/// `state_dir`; an unreadable file is "none" (the user's own logins stay).
pub fn chosen_in(state_dir: &Path) -> BTreeSet<String> {
    std::fs::read(choice_path_in(state_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Choice>(&bytes).ok())
        .map(|c| c.clis)
        .unwrap_or_default()
}

pub fn set_choice_in(state_dir: &Path, cli: &str, on: bool) -> Result<(), String> {
    let mut clis = chosen_in(state_dir);
    if on {
        clis.insert(cli.to_string());
    } else {
        clis.remove(cli);
    }
    let root = crate::services::agent_auth::store_root_in(state_dir);
    crate::services::agent_home::create_private_dir(&root).map_err(|e| format!("{}: {e}", root.display()))?;
    crate::services::mobile_control::store::write_json_atomic(&choice_path_in(state_dir), &Choice { clis }, 0o600)
}

/// `<PREFIX>SERVER_KEEPER_SOCKET`, else `/run/<slug>/auth.sock`.
pub fn keeper_socket() -> PathBuf {
    brand::env(super::wire::env::KEEPER_SOCKET)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new("/run").join(brand::SLUG).join(super::keys_wire::SOCKET_NAME))
}

/// Tries of one request when the keeper closes the connection unanswered.
#[cfg(unix)]
const ATTEMPTS: u32 = 4;
#[cfg(unix)]
const RETRY_PAUSE: std::time::Duration = std::time::Duration::from_millis(150);

/// Why one exchange with the keeper failed.
#[cfg(unix)]
enum Failure {
    /// Closed before answering: the keeper's per-uid or overall cap was
    /// full at that moment (`keeper::MAX_PER_UID`). Worth a retry — a burst
    /// of this user's own spawns and Claude helper calls can fill it.
    Unanswered(String),
    Other(String),
}

/// One request to the keeper at `socket`: a JSON line each way. Every
/// request the daemon sends only reads, so one the keeper turned away at a
/// full cap is sent again a few times before it fails.
#[cfg(unix)]
pub fn ask_at(socket: &Path, request: &Request) -> Result<Reply, String> {
    let mut attempt = 0;
    loop {
        match ask_once(socket, request) {
            Ok(reply) => return Ok(reply),
            Err(Failure::Unanswered(_)) if attempt + 1 < ATTEMPTS => {
                attempt += 1;
                std::thread::sleep(RETRY_PAUSE * attempt);
            }
            Err(Failure::Unanswered(error) | Failure::Other(error)) => return Err(format!("the key keeper: {error}")),
        }
    }
}

#[cfg(unix)]
fn ask_once(socket: &Path, request: &Request) -> Result<Reply, Failure> {
    use std::io::{ErrorKind, Write};
    let unanswered = |e: &std::io::Error| matches!(e.kind(), ErrorKind::BrokenPipe | ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted);
    let mut stream = std::os::unix::net::UnixStream::connect(socket).map_err(|e| Failure::Other(format!("{}: {e}", socket.display())))?;
    stream.set_read_timeout(Some(DEADLINE)).map_err(|e| Failure::Other(e.to_string()))?;
    stream.set_write_timeout(Some(DEADLINE)).map_err(|e| Failure::Other(e.to_string()))?;
    let mut line = serde_json::to_vec(request).map_err(|e| Failure::Other(e.to_string()))?;
    line.push(b'\n');
    if let Err(e) = stream.write_all(&line) {
        return Err(if unanswered(&e) { Failure::Unanswered(e.to_string()) } else { Failure::Other(e.to_string()) });
    }
    match read_answer(stream) {
        Ok(answer) if answer.is_empty() => Err(Failure::Unanswered("closed without an answer".into())),
        Ok(answer) => parse_reply(&answer).map_err(Failure::Other),
        Err(e) if unanswered(&e) => Err(Failure::Unanswered(e.to_string())),
        Err(e) => Err(Failure::Other(e.to_string())),
    }
}

/// Everything `stream` sends (one line, bounded), into a buffer that is wiped.
#[cfg(unix)]
fn read_answer(stream: std::os::unix::net::UnixStream) -> std::io::Result<Zeroizing<Vec<u8>>> {
    use std::io::Read;
    let mut answer = Zeroizing::new(Vec::new());
    stream.take(super::keys_wire::MAX_LINE as u64 + 1).read_to_end(&mut answer)?;
    Ok(answer)
}

#[cfg(unix)]
fn parse_reply(answer: &[u8]) -> Result<Reply, String> {
    let end = answer.iter().position(|&b| b == b'\n').unwrap_or(answer.len());
    serde_json::from_slice::<Reply>(&answer[..end]).map_err(|e| format!("answer: {e}"))
}

/// One JSON reply line from `stream`, read into a buffer that is wiped.
#[cfg(unix)]
fn read_reply(stream: std::os::unix::net::UnixStream) -> Result<Reply, String> {
    let answer = read_answer(stream).map_err(|e| e.to_string())?;
    parse_reply(&answer)
}

#[cfg(not(unix))]
pub fn ask_at(_socket: &Path, _request: &Request) -> Result<Reply, String> {
    Err("the key keeper runs on a Linux server only".into())
}

/// The CLIs the administrator offers this user a key for.
pub fn offered_at(socket: &Path) -> Result<Vec<Offer>, String> {
    let reply = ask_at(socket, &Request::Offered)?;
    if reply.ok {
        Ok(reply.offered)
    } else {
        Err(format!("the key keeper refused: {}", reply.error.unwrap_or_default()))
    }
}

/// [`offered_at`] for this daemon, by CLI id; empty off a server or when the
/// keeper cannot be asked (the panel then offers nothing to switch to).
pub fn offered() -> BTreeSet<String> {
    if !super::is_server() {
        return BTreeSet::new();
    }
    match offered_at(&keeper_socket()) {
        Ok(offers) => offers.into_iter().map(|o| o.cli).collect(),
        Err(error) => {
            eprintln!("agent_keys: {error}");
            BTreeSet::new()
        }
    }
}

/// The administrator's current key for `cli`: `Ok(None)` when none is on
/// offer to this user (withdrawn, or not on its list), `Err` when the keeper
/// cannot be asked or refuses.
pub fn fetch_at(socket: &Path, cli: &str) -> Result<Option<Zeroizing<String>>, String> {
    let reply = ask_at(socket, &Request::Get { cli: cli.to_string() })?;
    match (reply.ok, reply.key, reply.error.as_deref()) {
        (true, Some(key), _) => Ok(Some(Zeroizing::new(key))),
        (false, _, Some("no-key")) => Ok(None),
        (_, _, error) => Err(format!("the key keeper refused: {}", error.unwrap_or("no key in the answer"))),
    }
}

fn label(cli: &str) -> String {
    crate::commands::agents::agent_label_for_id(cli).unwrap_or(cli).to_string()
}

fn takes_helper(cli: &str) -> bool {
    HELPER_CLIS.contains(&cli)
}

/// The spawn error of a key that is no longer this user's to use.
fn withdrawn_message(cli: &str) -> String {
    format!(
        "{}: the administrator no longer offers you an API key (withdrawn, or you were taken off its list); switch back to your own login in Settings → Manage CLIs",
        label(cli)
    )
}

fn unfetchable_message(cli: &str, error: &str) -> String {
    format!("{}: the administrator's API key could not be fetched ({error})", label(cli))
}

/// The registry CLI `cmd` runs, when this user runs it on the
/// administrator's key.
fn chosen_cli(state_dir: &Path, cmd: &str) -> Option<&'static str> {
    let bin = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let cli = crate::commands::agents::agent_id_for_bin(bin)?;
    chosen_in(state_dir).contains(cli).then_some(cli)
}

/// The key itself, or the spawn's error naming the way back.
fn fetch_for_spawn(socket: &Path, cli: &str) -> Result<Zeroizing<String>, String> {
    match fetch_at(socket, cli) {
        Ok(Some(key)) => Ok(key),
        Ok(None) => Err(withdrawn_message(cli)),
        Err(error) => Err(unfetchable_message(cli, &error)),
    }
}

/// Ready a local spawn of `cmd` (an agent tab, the Host session, the shell
/// shim) for the administrator's key when this user runs that CLI on it; a
/// no-op for every other spawn and off a server. A variable CLI gets its key
/// into `env`; a helper CLI gets nothing in `env` and `Ok(Some(dir))`: the
/// helper directory a fence must bind read-only at the same path. `Err` (the
/// spawn fails, naming the way back) when the key is withdrawn, this user is
/// no longer on its list, or the keeper cannot be asked — never a silent
/// fall-back to a login the home no longer has.
pub fn prepare_spawn(cmd: &str, env: &mut HashMap<String, String>) -> Result<Option<PathBuf>, String> {
    if !super::is_server() {
        return Ok(None);
    }
    prepare_spawn_in(&crate::storage::state_dir(), &keeper_socket(), cmd, env)
}

/// [`prepare_spawn`] over an explicit state dir and keeper socket (tests).
pub fn prepare_spawn_in(state_dir: &Path, socket: &Path, cmd: &str, env: &mut HashMap<String, String>) -> Result<Option<PathBuf>, String> {
    let Some(cli) = chosen_cli(state_dir, cmd) else { return Ok(None) };
    if takes_helper(cli) {
        // The helper asks the keeper itself; the spawn only checks the key is
        // still this user's, so a withdrawn key fails here, at the start.
        return match offered_at(socket) {
            Ok(offers) if offers.iter().any(|o| o.cli == cli) => {
                let dir = state_dir.join(HELPER_DIR);
                crate::services::agent_home::create_private_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
                Ok(Some(dir))
            }
            Ok(_) => Err(withdrawn_message(cli)),
            Err(error) => Err(unfetchable_message(cli, &error)),
        };
    }
    let Some(var) = crate::commands::agents::api_key_env(cli) else {
        return Err(format!("{}: this CLI takes no API key by environment; switch back to your own login in Settings → Manage CLIs", label(cli)));
    };
    let key = fetch_for_spawn(socket, cli)?;
    env.insert(var.to_string(), key.as_str().to_string());
    Ok(None)
}

/// A project container's agent tab (`services::sandbox`): the key into its
/// `docker exec` environment — the CLI's own variable, or for a helper CLI
/// [`CONTAINER_KEY_ENV`], which that CLI's helper prints there. The caller
/// keeps every such variable's value off the argv. Off a server a no-op.
pub fn container_env(cmd: &str, env: &mut HashMap<String, String>) -> Result<(), String> {
    if !super::is_server() {
        return Ok(());
    }
    container_env_in(&crate::storage::state_dir(), &keeper_socket(), cmd, env)
}

pub fn container_env_in(state_dir: &Path, socket: &Path, cmd: &str, env: &mut HashMap<String, String>) -> Result<(), String> {
    let Some(cli) = chosen_cli(state_dir, cmd) else { return Ok(()) };
    let var = if takes_helper(cli) {
        CONTAINER_KEY_ENV
    } else {
        crate::commands::agents::api_key_env(cli).ok_or_else(|| format!("{}: this CLI takes no API key by environment", label(cli)))?
    };
    let key = fetch_for_spawn(socket, cli)?;
    env.insert(var.to_string(), key.as_str().to_string());
    Ok(())
}

/// Every variable that may carry an administrator's key into a spawn: the
/// registry's `api_key_env`s and [`CONTAINER_KEY_ENV`].
pub fn key_envs() -> Vec<&'static str> {
    let mut vars = crate::commands::agents::api_key_envs();
    vars.push(CONTAINER_KEY_ENV);
    vars
}

// ── Claude's apiKeyHelper ─────────────────────────────────────────────────

/// The `apiKeyHelper` command for `cli`: in a project container (where the
/// spawn put the key into [`CONTAINER_KEY_ENV`]) print that; anywhere else
/// ask this daemon's helper socket through this binary. POSIX `sh`, which is
/// what Claude runs it with.
pub fn helper_command(exe: &Path, socket: &Path) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    format!(
        "if [ -n \"${{{var}:-}}\" ]; then printf '%s' \"${var}\"; else exec {exe} {HELPER_ARG} {socket}; fi",
        var = CONTAINER_KEY_ENV,
        exe = quote(&exe.to_string_lossy()),
        socket = quote(&socket.to_string_lossy()),
    )
}

/// Is `value` an `apiKeyHelper` this module wrote?
fn is_ours(value: &serde_json::Value) -> bool {
    value.as_str().is_some_and(|v| v.contains(HELPER_ARG) && v.contains(CONTAINER_KEY_ENV))
}

/// Bring `home`'s helper settings in line with the choice: Claude's
/// `apiKeyHelper` names this binary's helper while the user runs Claude on
/// the administrator's key, and is gone (only when it is ours) otherwise.
/// Tabtivity's own agent homes only (`agent_auth`'s place step calls it for
/// every home, at each spawn and when the choice changes).
pub fn sync_helper_settings(state_dir: &Path, home: &Path, chosen: &BTreeSet<String>) {
    let exe = std::env::current_exe().ok().and_then(|exe| helper_exe(&exe));
    sync_helper_settings_with(state_dir, home, chosen, exe.as_deref());
}

/// The path the helper setting names for this binary. Once an update has
/// replaced the running binary, Linux reports it as `<path> (deleted)` —
/// a setting naming that would fail every helper call until the daemon
/// restarts — so the path the update put there (the new binary, which
/// answers the same verb) is named instead. `None` when neither exists.
fn helper_exe(exe: &Path) -> Option<PathBuf> {
    if exe.is_file() {
        return Some(exe.to_path_buf());
    }
    let replaced = PathBuf::from(exe.to_str()?.strip_suffix(" (deleted)")?);
    replaced.is_file().then_some(replaced)
}

pub fn sync_helper_settings_with(state_dir: &Path, home: &Path, chosen: &BTreeSet<String>, exe: Option<&Path>) {
    use crate::services::home_io::HomeFile;
    let on = chosen.contains("claude");
    // On, but this binary's path is unknown: leave the setting as it is
    // rather than write a helper that cannot run or drop the one there.
    if on && exe.is_none() {
        return;
    }
    let file = if on { HomeFile::open(home, ".claude/settings.json") } else { HomeFile::open_existing(home, ".claude/settings.json") };
    let Some(file) = file else { return };
    let bytes = file.read();
    // Off (every desktop home, every poll): nothing to do unless ours is there.
    if !on && !bytes.as_deref().is_some_and(|b| b.windows(HELPER_ARG.len()).any(|w| w == HELPER_ARG.as_bytes())) {
        return;
    }
    // A file that is there but does not parse (hand-edited, or caught half
    // written) is left alone, as `agent_global` leaves it: rewriting it from
    // `{}` would throw away every other setting in it.
    let mut root: serde_json::Value = match bytes.as_deref() {
        Some(b) if !b.iter().all(u8::is_ascii_whitespace) => match serde_json::from_slice(b) {
            Ok(value) => value,
            Err(e) => {
                eprintln!("agent_keys: helper setting in {}: unreadable, left alone: {e}", home.display());
                return;
            }
        },
        _ => serde_json::json!({}),
    };
    let Some(obj) = root.as_object_mut() else { return };
    let want = match (on, exe) {
        (true, Some(exe)) => Some(serde_json::Value::String(helper_command(exe, &state_dir.join(HELPER_DIR).join("claude.sock")))),
        _ => None,
    };
    let changed = match want {
        Some(value) if obj.get("apiKeyHelper") != Some(&value) => {
            obj.insert("apiKeyHelper".into(), value);
            true
        }
        None if obj.get("apiKeyHelper").is_some_and(is_ours) => {
            obj.remove("apiKeyHelper");
            true
        }
        _ => false,
    };
    if changed {
        if let Err(e) = serde_json::to_string_pretty(&root).map_err(std::io::Error::other).and_then(|text| file.write(text.as_bytes())) {
            eprintln!("agent_keys: helper setting in {}: {e}", home.display());
        }
    }
}

/// Start this daemon's helper sockets, one per [`HELPER_CLIS`] entry. A
/// server only; called once from the daemon's `main`.
pub fn serve_helpers() {
    if !super::is_server() {
        return;
    }
    #[cfg(target_os = "linux")]
    for cli in HELPER_CLIS {
        if let Err(error) = serve_helper_in(crate::storage::state_dir(), keeper_socket(), cli) {
            eprintln!("agent_keys: helper socket for {cli}: {error}");
        }
    }
}

/// Listen on `<state_dir>/key-helper/<cli>.sock` (replacing an earlier
/// daemon's) and answer every connection on a thread of its own: the key
/// when the caller is this uid and still runs `cli` on the administrator's
/// key, which the keeper is asked anew each time.
#[cfg(target_os = "linux")]
pub fn serve_helper_in(state_dir: PathBuf, keeper: PathBuf, cli: &'static str) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = state_dir.join(HELPER_DIR);
    crate::services::agent_home::create_private_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(format!("{cli}.sock"));
    match std::fs::symlink_metadata(&path) {
        Ok(m) if std::os::unix::fs::FileTypeExt::is_socket(&m.file_type()) => std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?,
        Ok(_) => return Err(format!("{} is not a socket", path.display())),
        Err(_) => {}
    }
    let listener = std::os::unix::net::UnixListener::bind(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("{}: {e}", path.display()))?;
    let in_flight = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    std::thread::Builder::new()
        .name(format!("key-helper-{cli}"))
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                // Anything in a chosen Claude's fence can connect: a flood
                // gets closed connections, never a thread each.
                let Some(slot) = HelperSlot::take(&in_flight) else { continue };
                let (state_dir, keeper) = (state_dir.clone(), keeper.clone());
                let _ = std::thread::Builder::new().name("key-helper".into()).spawn(move || {
                    let _slot = slot;
                    answer_helper(&state_dir, &keeper, cli, stream);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(path)
}

/// Helper calls answered at once per socket; more are closed unanswered (the
/// helper then reports the key could not be fetched, and Claude asks again).
#[cfg(target_os = "linux")]
const MAX_HELPER_CALLS: usize = 8;

/// One helper call in flight; gives its count back when dropped.
#[cfg(target_os = "linux")]
struct HelperSlot(std::sync::Arc<std::sync::atomic::AtomicUsize>);

#[cfg(target_os = "linux")]
impl HelperSlot {
    fn take(count: &std::sync::Arc<std::sync::atomic::AtomicUsize>) -> Option<Self> {
        use std::sync::atomic::Ordering;
        count.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < MAX_HELPER_CALLS).then_some(n + 1)).ok()?;
        Some(HelperSlot(count.clone()))
    }
}

#[cfg(target_os = "linux")]
impl Drop for HelperSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

#[cfg(target_os = "linux")]
fn peer_uid(stream: &std::os::unix::net::UnixStream) -> Option<u32> {
    use std::os::unix::io::AsRawFd;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: getsockopt writes at most `len` bytes into `cred`.
    let rc = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len) };
    (rc == 0).then_some(cred.uid)
}

#[cfg(target_os = "linux")]
fn answer_helper(state_dir: &Path, keeper: &Path, cli: &str, mut stream: std::os::unix::net::UnixStream) {
    use std::io::Write;
    // SAFETY: geteuid has no preconditions.
    let own = unsafe { libc::geteuid() };
    let _ = stream.set_write_timeout(Some(DEADLINE));
    let reply = if peer_uid(&stream) != Some(own) {
        Reply::error("refused")
    } else if !chosen_in(state_dir).contains(cli) {
        Reply::error("not-chosen")
    } else {
        match fetch_at(keeper, cli) {
            Ok(Some(key)) => Reply { key: Some(key.as_str().to_string()), ..Reply::ok() },
            Ok(None) => Reply::error("no-key"),
            Err(error) => {
                eprintln!("agent_keys: helper for {cli}: {error}");
                Reply::error("failed")
            }
        }
    };
    let mut line = Zeroizing::new(serde_json::to_vec(&reply).unwrap_or_default());
    line.push(b'\n');
    if let Some(mut key) = reply.key {
        zeroize::Zeroize::zeroize(&mut key);
    }
    let _ = stream.write_all(&line);
}

/// `<this binary> --key-helper <socket>`: print the key the daemon's helper
/// socket answers, for a CLI's helper setting. Nothing but the key on
/// stdout; every failure a line on stderr naming the way back, and status 1.
#[cfg(unix)]
pub fn run_helper(socket: &std::ffi::OsStr) -> i32 {
    use std::io::Write;
    let reply = std::os::unix::net::UnixStream::connect(socket)
        .map_err(|e| format!("no answer from the server ({e})"))
        .and_then(|stream| {
            stream.set_read_timeout(Some(DEADLINE * 2)).map_err(|e| e.to_string())?;
            read_reply(stream)
        });
    match reply {
        Ok(Reply { ok: true, key: Some(key), .. }) => {
            let key = Zeroizing::new(key);
            let mut out = std::io::stdout().lock();
            if out.write_all(key.as_bytes()).and_then(|()| out.flush()).is_err() {
                return 1;
            }
            0
        }
        Ok(reply) => {
            let why = match reply.error.as_deref() {
                Some("no-key") => "the administrator no longer offers you this API key (withdrawn, or you were taken off its list); switch back to your own login in Settings → Manage CLIs",
                Some("not-chosen") => "this CLI runs on your own login now; open a new tab",
                _ => "the administrator's API key could not be fetched",
            };
            eprintln!("{why}");
            1
        }
        Err(error) => {
            eprintln!("the administrator's API key could not be fetched: {error}");
            1
        }
    }
}

#[cfg(not(unix))]
pub fn run_helper(_socket: &std::ffi::OsStr) -> i32 {
    eprintln!("the administrator's API keys are a Linux server's");
    1
}

/// Does `bytes`, a login file a tab wrote while `cli` ran on the
/// administrator's key, hold one of the administrator's keys for it — the
/// current one or any earlier (rotated, withdrawn) one? Asked of the keeper
/// as fingerprints, so no key travels and no fetch is audited. `None` when
/// that cannot be told (off a server, keeper unreachable, a huge file) —
/// `agent_auth` then adopts nothing, so an administrator's key never becomes
/// the user's own login.
pub fn holds_admin_key(cli: &str, bytes: &[u8]) -> Option<bool> {
    if !super::is_server() {
        return None;
    }
    holds_key_at(&keeper_socket(), cli, bytes)
}

pub fn holds_key_at(socket: &Path, cli: &str, bytes: &[u8]) -> Option<bool> {
    let reply = ask_at(socket, &Request::Fingerprints { cli: cli.to_string() }).ok()?;
    if !reply.ok {
        return None;
    }
    let prints: Vec<Fingerprint> = reply.fingerprints;
    super::keys_wire::holds_any(bytes, &prints)
}

/// Run `cli`'s agents on the administrator's key (`on`) or on the user's own
/// login. A hosted server only; switching on needs a key on offer to this
/// user and a CLI that can take one. The homes follow at once (the user's own
/// login copies leave or come back, Claude's helper setting with them);
/// running tabs keep what they started with.
pub fn choose(cli: &str, on: bool) -> Result<(), String> {
    if !super::is_server() {
        return Err("only a hosted server offers the administrator's API keys".into());
    }
    if crate::commands::agents::api_key_env(cli).is_none() {
        return Err(format!("{}: this CLI takes no API key by environment", label(cli)));
    }
    if on && !offered().contains(cli) {
        return Err(format!("{}: the administrator offers you no API key for it", label(cli)));
    }
    set_choice_in(&crate::storage::state_dir(), cli, on)?;
    crate::services::agent_auth::reconcile_now();
    Ok(())
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};

    pub(crate) const KEY: &str = "fake-key-DAEMONTEST0123456789";
    /// A key the administrator offered before rotating to [`KEY`].
    pub(crate) const OLD_KEY: &str = "fake-key-ROTATEDAWAY012345678";

    /// A keeper on a temp socket: `offered` (to whoever asks — the uid and
    /// list rules are the keeper's own tests') with `key`, or nothing on
    /// offer when `key` is `None`; fingerprints of [`OLD_KEY`] and the key.
    pub(crate) fn fake_keeper(socket: &Path, offered: &'static [&'static str], key: Option<&'static str>) {
        let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut line = String::new();
                let mut reader = BufReader::new(&stream);
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let on_offer = |cli: &str| key.is_some() && offered.contains(&cli);
                let reply = match serde_json::from_str::<Request>(line.trim()) {
                    Ok(Request::Offered) => Reply {
                        offered: offered.iter().filter(|c| on_offer(c)).map(|c| Offer { cli: c.to_string(), updated: 1 }).collect(),
                        ..Reply::ok()
                    },
                    Ok(Request::Get { cli }) => match key {
                        Some(k) if on_offer(&cli) => Reply { key: Some(k.to_string()), ..Reply::ok() },
                        _ => Reply::error("no-key"),
                    },
                    Ok(Request::Fingerprints { cli }) => Reply {
                        fingerprints: if offered.contains(&cli.as_str()) {
                            std::iter::once(OLD_KEY).chain(key).map(super::super::keys_wire::fingerprint).collect()
                        } else {
                            Vec::new()
                        },
                        ..Reply::ok()
                    },
                    _ => Reply::error("refused"),
                };
                let mut out = serde_json::to_vec(&reply).unwrap();
                out.push(b'\n');
                let _ = (&stream).write_all(&out);
            }
        });
    }

    #[test]
    fn the_choice_is_per_cli_and_its_file_is_private() {
        let state = tempfile::tempdir().unwrap();
        assert!(chosen_in(state.path()).is_empty());
        set_choice_in(state.path(), "claude", true).unwrap();
        set_choice_in(state.path(), "gemini", true).unwrap();
        set_choice_in(state.path(), "gemini", false).unwrap();
        assert_eq!(chosen_in(state.path()).into_iter().collect::<Vec<_>>(), ["claude"]);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(choice_path_in(state.path())).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::write(choice_path_in(state.path()), b"{oops").unwrap();
        assert!(chosen_in(state.path()).is_empty(), "unreadable: everyone on their own login");
    }

    /// The phase's exit, in one process: two users' daemons (two state dirs)
    /// for the same CLI at once — Alice on her own login, Bob on the
    /// administrator's key — and neither choice reaches the other.
    #[test]
    fn one_user_on_the_admin_key_and_one_on_their_own_login_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        fake_keeper(&socket, &["claude", "gemini"], Some(KEY));
        let (alice, bob) = (dir.path().join("alice"), dir.path().join("bob"));
        set_choice_in(&bob, "gemini", true).unwrap();
        set_choice_in(&bob, "claude", true).unwrap();
        let mut alice_env = HashMap::new();
        assert_eq!(prepare_spawn_in(&alice, &socket, "/opt/agents/bin/gemini", &mut alice_env).unwrap(), None);
        assert_eq!(prepare_spawn_in(&alice, &socket, "claude", &mut alice_env).unwrap(), None);
        assert!(alice_env.is_empty(), "Alice runs on her own login: {alice_env:?}");
        let mut bob_env = HashMap::new();
        assert_eq!(prepare_spawn_in(&bob, &socket, "/opt/agents/bin/gemini", &mut bob_env).unwrap(), None);
        assert_eq!(bob_env.get("GEMINI_API_KEY").map(String::as_str), Some(KEY));
        // Claude: never in the environment — the helper directory to bind.
        let mut claude_env = HashMap::new();
        let dir_to_bind = prepare_spawn_in(&bob, &socket, "/opt/agents/bin/claude", &mut claude_env).unwrap();
        assert_eq!(dir_to_bind, Some(bob.join(HELPER_DIR)));
        assert!(bob.join(HELPER_DIR).is_dir());
        assert!(claude_env.is_empty(), "{claude_env:?}");
        // A non-agent command is untouched.
        let mut other = HashMap::new();
        assert_eq!(prepare_spawn_in(&bob, &socket, "bash", &mut other).unwrap(), None);
        assert!(other.is_empty());
    }

    #[test]
    fn a_withdrawn_or_unreachable_key_fails_the_spawn_with_the_way_back() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        fake_keeper(&socket, &["claude", "vibe"], None);
        let state = dir.path().join("bob");
        set_choice_in(&state, "claude", true).unwrap();
        set_choice_in(&state, "vibe", true).unwrap();
        let mut env = HashMap::new();
        for cli in ["claude", "vibe"] {
            let error = prepare_spawn_in(&state, &socket, cli, &mut env).unwrap_err();
            assert!(error.contains("no longer offers you") && error.contains("taken off its list") && error.contains("Manage CLIs"), "{error}");
            let error = container_env_in(&state, &socket, cli, &mut env).unwrap_err();
            assert!(error.contains("no longer offers you"), "{error}");
        }
        let error = prepare_spawn_in(&state, &dir.path().join("missing.sock"), "claude", &mut env).unwrap_err();
        assert!(error.contains("could not be fetched"), "{error}");
        assert!(env.is_empty());
    }

    #[test]
    fn a_container_agent_gets_the_key_in_its_exec_environment() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        fake_keeper(&socket, &["claude", "vibe"], Some(KEY));
        let state = dir.path().join("bob");
        set_choice_in(&state, "claude", true).unwrap();
        set_choice_in(&state, "vibe", true).unwrap();
        let mut env = HashMap::new();
        container_env_in(&state, &socket, "claude", &mut env).unwrap();
        container_env_in(&state, &socket, "vibe", &mut env).unwrap();
        assert_eq!(env.get(CONTAINER_KEY_ENV).map(String::as_str), Some(KEY), "Claude's helper prints it there");
        assert_eq!(env.get("MISTRAL_API_KEY").map(String::as_str), Some(KEY));
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
        let mut gemini = HashMap::new();
        container_env_in(&state, &socket, "gemini", &mut gemini).unwrap();
        assert!(gemini.is_empty(), "not chosen: nothing");
        assert!(key_envs().contains(&CONTAINER_KEY_ENV) && key_envs().contains(&"MISTRAL_API_KEY"));
    }

    #[test]
    fn a_login_file_holding_a_current_or_earlier_key_is_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        fake_keeper(&socket, &["vibe"], Some(KEY));
        assert_eq!(holds_key_at(&socket, "vibe", format!("saved: {KEY}\n").as_bytes()), Some(true));
        // P3b review finding 7: a key the administrator has since rotated.
        assert_eq!(holds_key_at(&socket, "vibe", format!("saved: {OLD_KEY}\n").as_bytes()), Some(true));
        assert_eq!(holds_key_at(&socket, "vibe", b"saved: the-users-own-0123456789\n"), Some(false));
        assert_eq!(holds_key_at(&socket, "claude", b"{}"), Some(false), "no key ever offered: not one of them");
        assert_eq!(holds_key_at(&dir.path().join("missing.sock"), "vibe", b"{}"), None);
    }

    /// Claude's `apiKeyHelper`: written while the user runs Claude on the
    /// administrator's key, removed (only ours) when they switch back.
    #[test]
    fn claudes_helper_setting_follows_the_choice() {
        let dir = tempfile::tempdir().unwrap();
        let (state, home) = (dir.path().join("state"), dir.path().join("home"));
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let settings = home.join(".claude/settings.json");
        std::fs::write(&settings, r#"{"model":"opus","hooks":{}}"#).unwrap();
        let exe = Path::new("/opt/it's/serverd");
        let chosen: BTreeSet<String> = ["claude".to_string()].into();
        sync_helper_settings_with(&state, &home, &chosen, Some(exe));
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        let helper = v["apiKeyHelper"].as_str().unwrap();
        assert_eq!(v["model"], "opus", "the rest of the file stays");
        assert!(helper.contains(r"'/opt/it'\''s/serverd' --key-helper '") && helper.contains("key-helper/claude.sock'"), "{helper}");
        assert!(helper.contains(CONTAINER_KEY_ENV));
        // The command really runs under sh: the container branch prints the
        // variable; elsewhere it execs the binary (here a missing one).
        let out = std::process::Command::new("sh").arg("-c").arg(helper).env(CONTAINER_KEY_ENV, KEY).output().unwrap();
        assert_eq!((out.status.success(), out.stdout.as_slice()), (true, KEY.as_bytes()));
        let out = std::process::Command::new("sh").arg("-c").arg(helper).env_remove(CONTAINER_KEY_ENV).output().unwrap();
        assert!(!out.status.success() && out.stdout.is_empty());
        // Switching back removes ours; a user's own helper is never touched.
        sync_helper_settings_with(&state, &home, &BTreeSet::new(), Some(exe));
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        assert!(v.get("apiKeyHelper").is_none() && v["model"] == "opus", "{v}");
        std::fs::write(&settings, r#"{"apiKeyHelper":"my-own-helper"}"#).unwrap();
        sync_helper_settings_with(&state, &home, &BTreeSet::new(), Some(exe));
        assert!(std::fs::read_to_string(&settings).unwrap().contains("my-own-helper"));
        // A home without the file gets none just for being reconciled.
        let bare = dir.path().join("bare");
        std::fs::create_dir(&bare).unwrap();
        sync_helper_settings_with(&state, &bare, &BTreeSet::new(), Some(exe));
        assert!(!bare.join(".claude").exists());
    }

    /// P3b decisions review: a settings file that does not parse is never
    /// rewritten from scratch, and an unknown binary path never writes or
    /// drops the helper.
    #[test]
    fn an_unreadable_settings_file_or_an_unknown_binary_leaves_the_setting_alone() {
        let dir = tempfile::tempdir().unwrap();
        let (state, home) = (dir.path().join("state"), dir.path().join("home"));
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let settings = home.join(".claude/settings.json");
        let chosen: BTreeSet<String> = ["claude".to_string()].into();
        let exe = Path::new("/opt/serverd");
        let torn = r#"{"model":"opus","permissions":{"allow":["Bash(ls)"#;
        std::fs::write(&settings, torn).unwrap();
        sync_helper_settings_with(&state, &home, &chosen, Some(exe));
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), torn, "every other setting survives");
        // An empty file is a fresh one.
        std::fs::write(&settings, "\n").unwrap();
        sync_helper_settings_with(&state, &home, &chosen, Some(exe));
        let written = std::fs::read_to_string(&settings).unwrap();
        assert!(written.contains(HELPER_ARG), "{written}");
        // On, but the binary's path unknown: ours stays, nothing new is written.
        sync_helper_settings_with(&state, &home, &chosen, None);
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), written);
        let bare = dir.path().join("bare");
        std::fs::create_dir(&bare).unwrap();
        sync_helper_settings_with(&state, &bare, &chosen, None);
        assert!(!bare.join(".claude").exists());
    }

    /// An update that replaced the running binary: the helper names the path
    /// the new one sits at, never `… (deleted)`.
    #[test]
    fn a_replaced_binary_is_named_by_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("serverd");
        std::fs::write(&bin, b"").unwrap();
        assert_eq!(helper_exe(&bin), Some(bin.clone()));
        let deleted = PathBuf::from(format!("{} (deleted)", bin.display()));
        assert_eq!(helper_exe(&deleted), Some(bin.clone()));
        std::fs::remove_file(&bin).unwrap();
        assert_eq!(helper_exe(&deleted), None, "nothing at the path: no helper to name");
    }

    /// The helper socket answers this uid with the key while the user runs
    /// Claude on it, and stops the moment they switch back or the key goes.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_helper_socket_asks_the_keeper_at_every_call() {
        let dir = tempfile::tempdir().unwrap();
        let (live, gone) = (dir.path().join("live.sock"), dir.path().join("gone.sock"));
        fake_keeper(&live, &["claude"], Some(KEY));
        fake_keeper(&gone, &["claude"], None);
        let ask = |socket: &Path| {
            let stream = std::os::unix::net::UnixStream::connect(socket).unwrap();
            read_reply(stream).unwrap()
        };
        let state = dir.path().join("bob");
        let helper = serve_helper_in(state.clone(), live.clone(), "claude").unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&helper).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(state.join(HELPER_DIR)).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(ask(&helper).error.as_deref(), Some("not-chosen"));
        set_choice_in(&state, "claude", true).unwrap();
        assert_eq!(ask(&helper).key.as_deref(), Some(KEY));
        set_choice_in(&state, "claude", false).unwrap();
        assert_eq!(ask(&helper).key, None, "switched back: no key");
        // A restarted daemon replaces the old socket in the same directory.
        let other = dir.path().join("carol");
        set_choice_in(&other, "claude", true).unwrap();
        let first = serve_helper_in(other.clone(), gone.clone(), "claude").unwrap();
        assert_eq!(ask(&first).error.as_deref(), Some("no-key"), "withdrawn or off the list");
        let again = serve_helper_in(other.clone(), live.clone(), "claude").unwrap();
        assert_eq!(again, first);
        assert_eq!(ask(&again).key.as_deref(), Some(KEY));
        // Something else at the socket's name is never removed.
        let odd = dir.path().join("dave");
        std::fs::create_dir_all(odd.join(HELPER_DIR)).unwrap();
        std::fs::write(odd.join(HELPER_DIR).join("claude.sock"), b"x").unwrap();
        assert!(serve_helper_in(odd, live, "claude").is_err());
    }

    /// P3b decisions review: the keeper closes a connection over its per-uid
    /// cap unanswered; a burst of this user's own spawns and helper calls
    /// must not fail on that, so the read-only request is sent again.
    #[test]
    fn a_request_the_keeper_turned_away_at_its_cap_is_sent_again() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let served = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = served.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                // The first two: closed unanswered, as over the cap.
                if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2 {
                    drop(stream);
                    continue;
                }
                let mut line = String::new();
                let _ = BufReader::new(&stream).read_line(&mut line);
                let mut out = serde_json::to_vec(&Reply { offered: vec![Offer { cli: "claude".into(), updated: 1 }], ..Reply::ok() }).unwrap();
                out.push(b'\n');
                let _ = (&stream).write_all(&out);
            }
        });
        let offers = offered_at(&socket).unwrap();
        assert_eq!(offers.iter().map(|o| o.cli.as_str()).collect::<Vec<_>>(), ["claude"]);
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 3);
        // A keeper that never answers anyone: a bounded number of tries.
        let mute = dir.path().join("mute.sock");
        let listener = std::os::unix::net::UnixListener::bind(&mute).unwrap();
        let tries = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = tries.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                drop(stream);
            }
        });
        assert!(offered_at(&mute).is_err());
        assert_eq!(tries.load(std::sync::atomic::Ordering::SeqCst), ATTEMPTS as usize);
        // No keeper at all: no retries, an error at once.
        let error = offered_at(&dir.path().join("missing.sock")).unwrap_err();
        assert!(error.contains("the key keeper"), "{error}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn helper_calls_in_flight_are_capped_and_given_back() {
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let held: Vec<HelperSlot> = (0..MAX_HELPER_CALLS).map(|_| HelperSlot::take(&count).unwrap()).collect();
        assert!(HelperSlot::take(&count).is_none());
        drop(held);
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(HelperSlot::take(&count).is_some());
    }

    #[test]
    fn off_a_server_nothing_is_offered_injected_or_chosen() {
        assert!(!crate::services::server::is_server());
        assert!(offered().is_empty());
        let mut env = HashMap::new();
        assert_eq!(prepare_spawn("claude", &mut env).unwrap(), None);
        container_env("claude", &mut env).unwrap();
        assert!(env.is_empty());
        assert!(choose("claude", true).unwrap_err().contains("hosted server"));
    }
}
