//! The administrator's agent API keys, the daemon's half (hosted plan §5.2,
//! §5.4, P3b). The keys themselves live with the key keeper
//! (`src-gateway/src/keeper.rs`, `<slug>-auth`); this module is what a
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
//!   CLI never has to pick between an environment key and a login file.
//! * **Delivery** ([`inject_env`]): at each local agent spawn — an agent
//!   tab, the root console's Host session, a CLI typed into a shell tab
//!   through the `agent_bin` shim — the key is fetched from the keeper and
//!   put into the CLI's own variable (the registry's `api_key_env` column).
//!   It is never cached, written to a file, put on an argv or sent to a
//!   client; `tmux_local` carries it like the root console's tokens (its
//!   `SECRET_ENV`, through the client's environment). A withdrawn key fails
//!   the next spawn with a message naming the way back; agents already
//!   running keep the key they started with (§5.4: rotate it at the
//!   provider to take it from them).
//! * **Exposure, as §5.4 accepts it:** every agent of a user who opted in
//!   can read the key (its own environment), and direct mode has no
//!   per-user budget (the broker is P5).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::keys_wire::{Offer, Reply, Request};
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

/// One request to the keeper at `socket`: a JSON line each way.
#[cfg(unix)]
pub fn ask_at(socket: &Path, request: &Request) -> Result<Reply, String> {
    use std::io::{Read, Write};
    let mut stream = std::os::unix::net::UnixStream::connect(socket).map_err(|e| format!("the key keeper ({}): {e}", socket.display()))?;
    stream.set_read_timeout(Some(DEADLINE)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(DEADLINE)).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| format!("the key keeper: {e}"))?;
    let mut answer = Zeroizing::new(Vec::new());
    stream
        .take(super::keys_wire::MAX_LINE as u64 + 1)
        .read_to_end(&mut answer)
        .map_err(|e| format!("the key keeper: {e}"))?;
    let end = answer.iter().position(|&b| b == b'\n').unwrap_or(answer.len());
    serde_json::from_slice::<Reply>(&answer[..end]).map_err(|e| format!("the key keeper's answer: {e}"))
}

#[cfg(not(unix))]
pub fn ask_at(_socket: &Path, _request: &Request) -> Result<Reply, String> {
    Err("the key keeper runs on a Linux server only".into())
}

/// The CLIs the administrator offers a key for.
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
/// offer (withdrawn), `Err` when the keeper cannot be asked or refuses.
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

/// Put the administrator's key into `env` when `cmd` is a CLI this user
/// runs on it; a no-op for every other spawn and off a server. `Err` (the
/// spawn fails, naming the way back) when the key is withdrawn or cannot be
/// fetched — never a silent fall-back to a login the home no longer has.
pub fn inject_env(cmd: &str, env: &mut HashMap<String, String>) -> Result<(), String> {
    if !super::is_server() {
        return Ok(());
    }
    inject_env_in(&crate::storage::state_dir(), &keeper_socket(), cmd, env)
}

/// [`inject_env`] over an explicit state dir and keeper socket (tests).
pub fn inject_env_in(state_dir: &Path, socket: &Path, cmd: &str, env: &mut HashMap<String, String>) -> Result<(), String> {
    let bin = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let Some(cli) = crate::commands::agents::agent_id_for_bin(bin) else { return Ok(()) };
    if !chosen_in(state_dir).contains(cli) {
        return Ok(());
    }
    let Some(var) = crate::commands::agents::api_key_env(cli) else {
        return Err(format!("{}: this CLI takes no API key by environment; switch back to your own login in Settings → Manage CLIs", label(cli)));
    };
    match fetch_at(socket, cli) {
        Ok(Some(key)) => {
            env.insert(var.to_string(), key.as_str().to_string());
            Ok(())
        }
        Ok(None) => Err(format!(
            "{}: the administrator no longer offers an API key; switch back to your own login in Settings → Manage CLIs",
            label(cli)
        )),
        Err(error) => Err(format!("{}: the administrator's API key could not be fetched ({error})", label(cli))),
    }
}

/// Does `bytes`, a login file a tab wrote while `cli` ran on the
/// administrator's key, hold that key? `None` when that cannot be told (off a
/// server, keeper unreachable, no key on offer) — `agent_auth` then adopts
/// nothing, so the administrator's key never becomes the user's own login.
pub fn holds_admin_key(cli: &str, bytes: &[u8]) -> Option<bool> {
    if !super::is_server() {
        return None;
    }
    holds_key_at(&keeper_socket(), cli, bytes)
}

pub fn holds_key_at(socket: &Path, cli: &str, bytes: &[u8]) -> Option<bool> {
    let key = fetch_at(socket, cli).ok()??;
    let needle = key.as_bytes();
    Some(!needle.is_empty() && bytes.windows(needle.len()).any(|w| w == needle))
}

/// Run `cli`'s agents on the administrator's key (`on`) or on the user's own
/// login. A hosted server only; switching on needs a key on offer and a CLI
/// that takes one by environment. The homes follow at once (the user's own
/// login copies leave or come back); running tabs keep what they started
/// with.
pub fn choose(cli: &str, on: bool) -> Result<(), String> {
    if !super::is_server() {
        return Err("only a hosted server offers the administrator's API keys".into());
    }
    if crate::commands::agents::api_key_env(cli).is_none() {
        return Err(format!("{}: this CLI takes no API key by environment", label(cli)));
    }
    if on && !offered().contains(cli) {
        return Err(format!("{}: the administrator offers no API key for it", label(cli)));
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

    /// A keeper on a temp socket that answers every `get` for `offered` with
    /// `key` (or `no-key`), whoever asks — the uid rules are the keeper's
    /// own tests'.
    pub(crate) fn fake_keeper(socket: &Path, offered: &'static [&'static str], key: Option<&'static str>) {
        let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut line = String::new();
                let mut reader = BufReader::new(&stream);
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let reply = match serde_json::from_str::<Request>(line.trim()) {
                    Ok(Request::Offered) => Reply { offered: offered.iter().map(|c| Offer { cli: c.to_string(), updated: 1 }).collect(), ..Reply::ok() },
                    Ok(Request::Get { cli }) => match key {
                        Some(k) if offered.contains(&cli.as_str()) => Reply { key: Some(k.to_string()), ..Reply::ok() },
                        _ => Reply::error("no-key"),
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
        fake_keeper(&socket, &["claude"], Some(KEY));
        let (alice, bob) = (dir.path().join("alice"), dir.path().join("bob"));
        set_choice_in(&bob, "claude", true).unwrap();
        let mut alice_env = HashMap::new();
        inject_env_in(&alice, &socket, "/opt/agents/bin/claude", &mut alice_env).unwrap();
        assert!(alice_env.is_empty(), "Alice runs on her own login: {alice_env:?}");
        let mut bob_env = HashMap::new();
        inject_env_in(&bob, &socket, "/opt/agents/bin/claude", &mut bob_env).unwrap();
        assert_eq!(bob_env.get("ANTHROPIC_API_KEY").map(String::as_str), Some(KEY));
        // Another CLI of Bob's, and a non-agent command, are untouched.
        let mut other = HashMap::new();
        inject_env_in(&bob, &socket, "gemini", &mut other).unwrap();
        inject_env_in(&bob, &socket, "bash", &mut other).unwrap();
        assert!(other.is_empty());
    }

    #[test]
    fn a_withdrawn_or_unreachable_key_fails_the_spawn_with_the_way_back() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        fake_keeper(&socket, &["claude"], None);
        let state = dir.path().join("bob");
        set_choice_in(&state, "claude", true).unwrap();
        let mut env = HashMap::new();
        let error = inject_env_in(&state, &socket, "claude", &mut env).unwrap_err();
        assert!(error.contains("no longer offers") && error.contains("Manage CLIs"), "{error}");
        let error = inject_env_in(&state, &dir.path().join("missing.sock"), "claude", &mut env).unwrap_err();
        assert!(error.contains("could not be fetched"), "{error}");
        assert!(env.is_empty());
    }

    #[test]
    fn a_login_file_holding_the_key_is_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("auth.sock");
        fake_keeper(&socket, &["vibe"], Some(KEY));
        assert_eq!(holds_key_at(&socket, "vibe", format!("saved: {KEY}\n").as_bytes()), Some(true));
        assert_eq!(holds_key_at(&socket, "vibe", b"saved: the-users-own-0123456789\n"), Some(false));
        assert_eq!(holds_key_at(&socket, "claude", b"{}"), None, "no key on offer: unknown, adopt nothing");
        assert_eq!(holds_key_at(&dir.path().join("missing.sock"), "vibe", b"{}"), None);
    }

    #[test]
    fn off_a_server_nothing_is_offered_injected_or_chosen() {
        assert!(!crate::services::server::is_server());
        assert!(offered().is_empty());
        let mut env = HashMap::new();
        inject_env("claude", &mut env).unwrap();
        assert!(env.is_empty());
        assert!(choose("claude", true).unwrap_err().contains("hosted server"));
    }
}
