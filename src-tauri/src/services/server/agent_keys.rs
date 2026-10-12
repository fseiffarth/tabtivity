//! The administrator's agent API keys, the daemon's half (hosted plan §5.2,
//! §5.4, P3b; one delivery path since #2389). The keys themselves live with
//! the key keeper (`src-gateway/src/keeper.rs`, `<slug>-auth`), which hands
//! one only to the users the administrator put on that key's list; this
//! module is what a user's own daemon does with them:
//!
//! * **The choice is the user's, per CLI** (§5.2): `<state>/agent-auth/
//!   admin-keys.json` lists the CLIs whose agents run on the administrator's
//!   key; every other CLI runs on the user's own login or own API key.
//!   Written only by [`choose`], which refuses outside a hosted server, so the
//!   desktop never has the file. Choosing the administrator's key switches the
//!   CLI's own API key off (one credential per CLI).
//! * **Never both.** While a CLI is on the administrator's key,
//!   `agent_auth` takes the user's own login copies *out* of every agent
//!   home (the store keeps them; switching back puts them in again).
//! * **Delivery: the API proxy, as for the user's own key** (#2389). A spawn
//!   of a chosen CLI ([`admin_for_spawn`]) is checked against the keeper's
//!   offer and gets a proxy token bound to the administrator's key
//!   (`api_proxy::Grant::admin`) plus the CLI's base-URL variable — nothing
//!   of the key. The daemon's proxy asks the keeper for the key per request
//!   ([`for_proxy`], cached briefly there) and forwards with it: to the
//!   provider (direct delivery), or with the user's **broker token** to the
//!   key broker (`P5`), which meters and budgets it. So no key or broker token
//!   ever enters an agent process, its home, a file or a container. Only
//!   CLIs the proxy serves (`agent_api_keys`' routes: Claude, Gemini) can be
//!   chosen; Mistral Vibe has no base-URL variable and is not offered.
//! * **Withdrawn, the user taken off the key's list, or switched back**: the
//!   next spawn fails with a message naming the way back, and a running agent
//!   is refused at its next request once the proxy's cached answer expires.
//! * **No agent tab, no key.** A CLI typed into a shell tab runs through the
//!   `--agent-shim` process, which runs no proxy: a chosen CLI fails there,
//!   naming the agent tab. A project container cannot reach the daemon's
//!   loopback proxy: a keyed container spawn fails (`agent_api_keys::
//!   refuse_in_container`). Remote agents and Codex get nothing (decided,
//!   #2359/#2361).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::keys_wire::{Fingerprint, MonthUsage, Offer, Reply, Request};
use crate::brand;

/// The user's choice, in the login store's root.
pub const CHOICE_FILE: &str = "admin-keys.json";
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

/// What the proxy forwards an administrator-keyed request with: the key
/// (direct delivery), or this user's broker token and the broker's loopback
/// URL to send it to (P5) — never both, never handed to an agent.
pub struct AdminKey {
    pub key: Zeroizing<String>,
    /// Through the broker: its base URL for the CLI (`keys_wire::broker_url`).
    pub broker: Option<String>,
}

/// The administrator's current key for `cli` as the keeper answers this
/// user: `Ok(None)` when none is on offer to them (withdrawn, or not on its
/// list), `Err` when the keeper cannot be asked, refuses, or names a broker
/// that is not a loopback URL.
pub fn fetch_at(socket: &Path, cli: &str) -> Result<Option<AdminKey>, String> {
    let reply = ask_at(socket, &Request::Get { cli: cli.to_string() })?;
    match (reply.ok, reply.key, reply.error.as_deref()) {
        (true, Some(key), _) => {
            let key = Zeroizing::new(key);
            match reply.base_url {
                Some(url) if !is_broker_url(&url, cli) => Err("the broker's address is not a loopback URL".into()),
                broker => Ok(Some(AdminKey { key, broker })),
            }
        }
        (false, _, Some("no-key")) => Ok(None),
        (_, _, error) => Err(format!("the key keeper refused: {}", error.unwrap_or("no key in the answer"))),
    }
}

fn label(cli: &str) -> String {
    crate::commands::agents::agent_label_for_id(cli).unwrap_or(cli).to_string()
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

/// The CLI a local spawn of `cmd` (an agent tab, the Host session, the shell
/// shim) runs on the administrator's key, ready for the API proxy to grant —
/// `Ok(None)` for every other spawn and off a server. `Err` (the spawn fails,
/// naming the way back) when the key is withdrawn, this user is no longer on
/// its list, the keeper cannot be asked, or no API proxy runs in this process
/// (the `--agent-shim` process) — never a silent fall-back to a login the home
/// no longer has.
pub fn admin_for_spawn(cmd: &str) -> Result<Option<&'static str>, String> {
    if !super::is_server() {
        return Ok(None);
    }
    admin_for_spawn_in(&crate::storage::state_dir(), &keeper_socket(), cmd, crate::services::api_proxy::running())
}

/// [`admin_for_spawn`] over an explicit state dir, keeper socket and proxy
/// state (tests).
pub fn admin_for_spawn_in(state_dir: &Path, socket: &Path, cmd: &str, proxy_running: bool) -> Result<Option<&'static str>, String> {
    let Some(cli) = chosen_cli(state_dir, cmd) else { return Ok(None) };
    if !crate::services::agent_api_keys::proxies(cli) {
        return Err(format!("{}: this CLI cannot run on an API key; switch back to your own login in Settings → Manage CLIs", label(cli)));
    }
    match offered_at(socket) {
        Ok(offers) if offers.iter().any(|o| o.cli == cli) => {}
        Ok(_) => return Err(withdrawn_message(cli)),
        Err(error) => return Err(unfetchable_message(cli, &error)),
    }
    if !proxy_running {
        return Err(format!(
            "{0}: the administrator's API key reaches {0} only in an agent tab; start it from the agent menu, or switch back to your own login in Settings → Manage CLIs",
            label(cli)
        ));
    }
    Ok(Some(cli))
}

/// The key the daemon's API proxy forwards a request of `cli`'s
/// administrator-keyed grant with: `Ok(None)` when this user no longer runs
/// `cli` on it (switched back) or it is no longer on offer to them.
pub fn for_proxy(cli: &str) -> Result<Option<AdminKey>, String> {
    if !super::is_server() {
        return Ok(None);
    }
    for_proxy_in(&crate::storage::state_dir(), &keeper_socket(), cli)
}

pub fn for_proxy_in(state_dir: &Path, socket: &Path, cli: &str) -> Result<Option<AdminKey>, String> {
    if !chosen_in(state_dir).contains(cli) {
        return Ok(None);
    }
    fetch_at(socket, cli)
}

/// Is `url` the broker's own address for `cli` — loopback, plain HTTP (the
/// broker never leaves the host), the CLI's path? The keeper's word is
/// trusted for everything else; this only keeps a wrong value from sending
/// a broker token anywhere off the machine.
fn is_broker_url(url: &str, cli: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://127.0.0.1:") else { return false };
    let Some((port, path)) = rest.split_once('/') else { return false };
    port.parse::<u16>().is_ok() && path == cli
}

/// This month's brokered use per CLI this user is offered through the broker
/// (and runs on it): for Manage CLIs. Empty off a server or when the keeper
/// cannot be asked.
pub fn broker_usage(chosen: &BTreeSet<String>) -> HashMap<String, MonthUsage> {
    if !super::is_server() || chosen.is_empty() {
        return HashMap::new();
    }
    broker_usage_at(&keeper_socket(), chosen)
}

pub fn broker_usage_at(socket: &Path, chosen: &BTreeSet<String>) -> HashMap<String, MonthUsage> {
    let Ok(offers) = offered_at(socket) else { return HashMap::new() };
    offers
        .into_iter()
        .filter(|o| o.base_url.is_some() && chosen.contains(&o.cli))
        .filter_map(|o| {
            let reply = ask_at(socket, &Request::Usage { cli: o.cli.clone() }).ok()?;
            reply.usage.filter(|_| reply.ok).map(|usage| (o.cli, usage))
        })
        .collect()
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
    // `no-key`: nothing this user may recognise — no key ever, or not on its
    // list (the keeper answers both alike) — so the file holds none of them.
    if reply.error.as_deref() == Some("no-key") {
        return Some(false);
    }
    if !reply.ok {
        return None;
    }
    let prints: Vec<Fingerprint> = reply.fingerprints;
    super::keys_wire::holds_any(bytes, &prints)
}

/// Run `cli`'s agents on the administrator's key (`on`) or on the user's own
/// login. A hosted server only; switching on needs a CLI the API proxy
/// serves and a key on offer to this user, and switches the CLI's own API
/// key off (`Settings::agent_api_key_clis`): one credential per CLI. The
/// homes follow at once (the user's own login copies leave or come back);
/// running tabs keep what they started with until the proxy's next answer.
pub fn choose(cli: &str, on: bool) -> Result<(), String> {
    if !super::is_server() {
        return Err("only a hosted server offers the administrator's API keys".into());
    }
    if !crate::services::agent_api_keys::proxies(cli) {
        return Err(format!("{}: this CLI cannot run on an API key", label(cli)));
    }
    if on && !offered().contains(cli) {
        return Err(format!("{}: the administrator offers you no API key for it", label(cli)));
    }
    if on {
        crate::services::agent_api_keys::switch_off(cli)?;
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
    /// offer when `key` is `None`; fingerprints of [`OLD_KEY`] and the key for
    /// an offered CLI, `no-key` for the rest (the keeper's unlisted answer).
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
                        offered: offered.iter().filter(|c| on_offer(c)).map(|c| Offer { cli: c.to_string(), updated: 1, base_url: None }).collect(),
                        ..Reply::ok()
                    },
                    Ok(Request::Get { cli }) => match key {
                        Some(k) if on_offer(&cli) => Reply { key: Some(k.to_string()), ..Reply::ok() },
                        _ => Reply::error("no-key"),
                    },
                    // Like the real keeper: off the list (here: not offered),
                    // the answer of a CLI that never had a key.
                    Ok(Request::Fingerprints { cli }) if offered.contains(&cli.as_str()) => Reply {
                        fingerprints: std::iter::once(OLD_KEY).chain(key).map(super::super::keys_wire::fingerprint).collect(),
                        ..Reply::ok()
                    },
                    Ok(Request::Fingerprints { .. }) => Reply::error("no-key"),
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
    /// administrator's key — and neither choice reaches the other. Nothing of
    /// the key is in any spawn: the gate only names the CLI the proxy grants.
    #[test]
    fn one_user_on_the_admin_key_and_one_on_their_own_login_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        fake_keeper(&socket, &["claude", "gemini"], Some(KEY));
        let (alice, bob) = (dir.path().join("alice"), dir.path().join("bob"));
        set_choice_in(&bob, "gemini", true).unwrap();
        set_choice_in(&bob, "claude", true).unwrap();
        assert_eq!(admin_for_spawn_in(&alice, &socket, "/opt/agents/bin/gemini", true).unwrap(), None);
        assert_eq!(admin_for_spawn_in(&alice, &socket, "claude", true).unwrap(), None);
        assert_eq!(admin_for_spawn_in(&bob, &socket, "/opt/agents/bin/gemini", true).unwrap(), Some("gemini"));
        assert_eq!(admin_for_spawn_in(&bob, &socket, "/opt/agents/bin/claude", true).unwrap(), Some("claude"));
        // A non-agent command is untouched.
        assert_eq!(admin_for_spawn_in(&bob, &socket, "bash", true).unwrap(), None);
        // The proxy's source: Bob's key, Alice nothing (her own login).
        assert_eq!(for_proxy_in(&bob, &socket, "claude").unwrap().map(|k| (k.key.to_string(), k.broker)), Some((KEY.to_string(), None)));
        assert!(for_proxy_in(&alice, &socket, "claude").unwrap().is_none());
    }

    #[test]
    fn a_withdrawn_or_unreachable_key_fails_the_spawn_with_the_way_back() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        fake_keeper(&socket, &["claude", "gemini"], None);
        let state = dir.path().join("bob");
        set_choice_in(&state, "claude", true).unwrap();
        set_choice_in(&state, "gemini", true).unwrap();
        for cli in ["claude", "gemini"] {
            let error = admin_for_spawn_in(&state, &socket, cli, true).unwrap_err();
            assert!(error.contains("no longer offers you") && error.contains("taken off its list") && error.contains("Manage CLIs"), "{error}");
            assert!(for_proxy_in(&state, &socket, cli).unwrap().is_none(), "the proxy forwards nothing either");
        }
        let error = admin_for_spawn_in(&state, &dir.path().join("missing.sock"), "claude", true).unwrap_err();
        assert!(error.contains("could not be fetched"), "{error}");
        assert!(for_proxy_in(&state, &dir.path().join("missing.sock"), "claude").is_err());
    }

    /// #2389: the key reaches an agent only through the API proxy, so a spawn
    /// without one in its process (a CLI typed into a shell tab, the
    /// `--agent-shim` process) fails naming the agent tab, and a CLI the proxy
    /// cannot serve (Mistral Vibe) cannot run on it at all.
    #[test]
    fn no_proxy_or_a_cli_it_cannot_serve_fails_the_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        fake_keeper(&socket, &["claude", "vibe"], Some(KEY));
        let state = dir.path().join("bob");
        set_choice_in(&state, "claude", true).unwrap();
        set_choice_in(&state, "vibe", true).unwrap();
        let error = admin_for_spawn_in(&state, &socket, "claude", false).unwrap_err();
        assert!(error.contains("agent tab") && error.contains("Manage CLIs"), "{error}");
        let error = admin_for_spawn_in(&state, &socket, "vibe", true).unwrap_err();
        assert!(error.contains("cannot run on an API key"), "{error}");
        // Switched back: the proxy stops forwarding at once.
        set_choice_in(&state, "claude", false).unwrap();
        assert!(for_proxy_in(&state, &socket, "claude").unwrap().is_none());
    }

    #[test]
    fn a_login_file_holding_a_current_or_earlier_key_is_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        fake_keeper(&socket, &["gemini"], Some(KEY));
        assert_eq!(holds_key_at(&socket, "gemini", format!("saved: {KEY}\n").as_bytes()), Some(true));
        // P3b review finding 7: a key the administrator has since rotated.
        assert_eq!(holds_key_at(&socket, "gemini", format!("saved: {OLD_KEY}\n").as_bytes()), Some(true));
        assert_eq!(holds_key_at(&socket, "gemini", b"saved: the-users-own-0123456789\n"), Some(false));
        assert_eq!(holds_key_at(&socket, "claude", b"{}"), Some(false), "no key ever offered: not one of them");
        assert_eq!(holds_key_at(&dir.path().join("missing.sock"), "gemini", b"{}"), None);
    }

    /// P5 broker, against the real keeper: a brokered Claude's proxy source
    /// is this user's token and the broker's URL (never the key), the spawn
    /// gate passes, and the user sees their month. Back to direct delivery,
    /// the source is the key and no broker.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_brokered_claude_is_forwarded_to_the_broker_with_the_users_token() {
        use app_gateway::keeper::{Keeper, Peer, Peers};
        struct As(Peer);
        impl Peers for As {
            fn classify(&self, _: u32) -> Peer {
                self.0.clone()
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let keys = dir.path().join("keys");
        std::fs::create_dir(&keys).unwrap();
        let admin = |request: Request| {
            let reply = Keeper::new(keys.clone(), Box::new(As(Peer::Gateway))).answer(0, &serde_json::to_vec(&request).unwrap());
            assert!(reply.ok, "{reply:?}");
        };
        admin(Request::Set { cli: "claude".into(), key: KEY.into(), by: "root1".into() });
        admin(Request::Users { cli: "claude".into(), users: vec!["alice".into()], by: "root1".into() });
        admin(Request::Delivery { cli: "claude".into(), broker: true, by: "root1".into() });
        let socket = dir.path().join("auth.sock");
        let (ready, wait) = std::sync::mpsc::channel();
        let (path, served) = (socket.clone(), keys.clone());
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::UnixListener::bind(&path).unwrap();
                ready.send(()).unwrap();
                let keeper = Keeper::new(served, Box::new(As(Peer::User("alice".into())))).with_broker_port(18739);
                let _ = app_gateway::keeper::serve(std::sync::Arc::new(keeper), listener).await;
            });
        });
        wait.recv().unwrap();
        let state = dir.path().join("alice");
        set_choice_in(&state, "claude", true).unwrap();
        assert_eq!(admin_for_spawn_in(&state, &socket, "claude", true).unwrap(), Some("claude"));
        let source = for_proxy_in(&state, &socket, "claude").unwrap().unwrap();
        assert_eq!(source.broker.as_deref(), Some("http://127.0.0.1:18739/claude"));
        assert!(source.key.starts_with("broker-") && source.key.as_str() != KEY, "the user's token, never the key");
        let usage = broker_usage_at(&socket, &BTreeSet::from(["claude".to_string()]));
        assert_eq!(usage.get("claude").map(|u| (u.billed, u.month.len())), Some((0, 7)));
        assert!(broker_usage_at(&socket, &BTreeSet::new()).is_empty(), "only CLIs the user runs on it");
        // Back to direct delivery: the key itself, no broker.
        admin(Request::Delivery { cli: "claude".into(), broker: false, by: "root1".into() });
        let source = for_proxy_in(&state, &socket, "claude").unwrap().unwrap();
        assert_eq!((source.key.as_str(), source.broker), (KEY, None));
        assert!(is_broker_url("http://127.0.0.1:8739/claude", "claude"));
        for bad in ["https://127.0.0.1:8739/claude", "http://evil.example:8739/claude", "http://127.0.0.1:8739/gemini", "http://127.0.0.1:x/claude"] {
            assert!(!is_broker_url(bad, "claude"), "{bad}");
        }
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
                let mut out = serde_json::to_vec(&Reply { offered: vec![Offer { cli: "claude".into(), updated: 1, base_url: None }], ..Reply::ok() }).unwrap();
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

    #[test]
    fn off_a_server_nothing_is_offered_injected_or_chosen() {
        assert!(!crate::services::server::is_server());
        assert!(offered().is_empty());
        assert_eq!(admin_for_spawn("claude").unwrap(), None);
        assert!(for_proxy("claude").unwrap().is_none());
        assert!(choose("claude", true).unwrap_err().contains("hosted server"));
    }
}
