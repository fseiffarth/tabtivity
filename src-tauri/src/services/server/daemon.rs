//! The per-user daemon, `tabtivity-serverd` (hosted plan §3.1): the Mobile
//! sidecar's host serving one account on a unix socket the gateway alone may
//! connect to. Everything the sidecar does with no window — the phone API,
//! the browser transport, the headless owner's timers — it does here, as the
//! user's uid, inside the user's slice; nothing of another user is reachable
//! because nothing of another user is this uid's.
//!
//! Started by the unit `tabtivity-serverd@<user>.service` (`src-gateway`'s
//! `units`), which sets the environment [`super::ServerConfig`] reads. Not a
//! daemon in the double-fork sense: systemd is the supervisor.

use std::path::PathBuf;

use super::ServerConfig;
use crate::brand::{self, SLUG};
use crate::services::mobile_control::config::{HostConfig, MobileHostSettings};
use crate::services::mobile_control::host::{self, Listen};

/// The fence's helper verb (`agent_fence::seccomp_launcher` puts it after the
/// running binary's path).
#[cfg(target_os = "linux")]
const FENCE_SCOPE_ARG: &str = "--fence-scope";

/// `tabtivity-serverd`: the process's whole life. Exits non-zero on a
/// configuration or bind error so `Restart=on-failure` keeps retrying what
/// can heal and the journal says what cannot.
pub fn main() -> ! {
    // `<slug>-serverd --key-helper <socket>`: Claude's `apiKeyHelper` on a
    // server (`agent_keys::sync_helper_settings` names this binary) — prints
    // the key this user's daemon answers on its helper socket. First and
    // touching nothing else: it runs inside the agent fence, every few
    // minutes of a Claude session.
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(super::agent_keys::HELPER_ARG)) {
        let socket = std::env::args_os().nth(2).unwrap_or_default();
        std::process::exit(super::agent_keys::run_helper(&socket));
    }
    // `<slug>-serverd --fence-scope <bwrap> [args…]`: the agent fence's step
    // before bwrap (`services::fence_scope`). The fence names the running
    // binary as its helper (`fence_scope::helper_for`, where Landlock has the
    // abstract-socket scope), so on a server every fenced agent execs this
    // binary first — as the desktop binary's `main` does, before anything
    // else, with the argv as given (paths need not be UTF-8) and no change
    // to the environment the agent inherits.
    #[cfg(target_os = "linux")]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(FENCE_SCOPE_ARG)) {
        let args: Vec<std::ffi::OsString> = std::env::args_os().skip(2).collect();
        std::process::exit(crate::services::fence_scope::run(&args));
    }
    // Before anything reads a path, and while this is the only thread.
    separate_from_the_desktop();
    crate::services::brand_migration::hits::install();
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--serverd") {
        args.remove(0);
    }
    // `<slug>-serverd --agent-shim <cli> [args…]`: a CLI typed into a shell
    // tab of this server (the `agent_bin` shims the daemon writes name this
    // binary). The tab's environment is tmux's, not the unit's, so server mode
    // is marked here — for the administrator's key (plan §5.4) and every
    // other server rule the fence follows.
    if args.first().map(String::as_str) == Some("--agent-shim") {
        super::mark_server_process();
        let Some(cli) = args.get(1).cloned() else {
            eprintln!("agent shim: usage: {SLUG}-serverd --agent-shim <cli> [args…]");
            std::process::exit(2);
        };
        std::process::exit(crate::services::agent_shim::run(&cli, &args[2..]));
    }
    if let Some(verb) = args.first().cloned() {
        let result = match verb.as_str() {
            "--write-invite" => read_secret_line().and_then(|code| write_invite(&crate::storage::state_dir(), &code, args.get(1).map(String::as_str))),
            "--revoke-device" => read_secret_line().and_then(|id| revoke_device(&crate::storage::state_dir(), &id)),
            "--install-cli" => install_cli(args.get(1).map(String::as_str).unwrap_or_default()),
            // The admin helper's OIDC link (P5), as this account's own uid:
            // JSON on stdin, empty to remove.
            "--write-oidc-binding" => read_stdin_text(8 * 1024).and_then(|text| super::oidc::write_binding(&crate::storage::state_dir(), &text)),
            other => Err(format!("unknown argument {other:?}")),
        };
        match result {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("{SLUG}-serverd {verb}: {error}");
                std::process::exit(1);
            }
        }
    }
    let state_dir = crate::storage::state_dir();
    let config = match ServerConfig::from_env(state_dir) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{SLUG}-serverd: {error}");
            std::process::exit(2);
        }
    };
    harden_process();
    install_vault(&config.state_dir);
    // The shell tabs' agent shims (`agent_bin`): a CLI typed into one runs
    // fenced in the tab's scope, as on the desktop, and gets the
    // administrator's key the same way an agent tab does. In `main`, not
    // [`run`]: a test serving a daemon must not write into the state dir.
    if let Err(error) = crate::services::agent_bin::install() {
        eprintln!("{SLUG}-serverd: agent shims: {error}");
    }
    // Claude's `apiKeyHelper` asks here for the administrator's key (plan
    // §5.4); a no-op until this user chooses it, answered per call.
    super::agent_keys::serve_helpers();
    start_agent_work();
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{SLUG}-serverd: runtime: {error}");
            std::process::exit(1);
        }
    };
    match runtime.block_on(run(config)) {
        Ok(()) => {
            eprintln!("{SLUG}-serverd: exiting: shut down on admin request");
            std::process::exit(0);
        }
        Err(error) => {
            eprintln!("{SLUG}-serverd: {error}");
            std::process::exit(1);
        }
    }
}

/// The window's agent start-up work, which a server has no window to run
/// (TODO #2362): in `main`, not [`run`], for the same reason as the shims.
///
/// * The hook script every registered agent hook names
///   (`agent_session::install_session_start_hook`, with the agent hint
///   script): spawns register the hooks in every agent home, so without it
///   each SessionStart/Stop/prompt hook ran a missing file and no turn
///   record or live session id was ever written.
/// * The login keeper (`agent_auth::start`): homes hold copies, so a token a
///   CLI refreshed in one scope reaches the other scopes' running tabs only
///   through it — and it is what strips a login beside the administrator's
///   key ("never both", plan §5.2) while tabs run.
/// * The sweeps of ssh ControlMaster sockets and askpass shims a previous
///   daemon left in the private `/tmp` it shares with the tmux unit (which
///   outlives it): a stale master turns every later channel into its own
///   login (a 2FA prompt each on an HPC host), and a shim's tally says a
///   password path was used. Both keep what a live process still holds.
/// * The turn relay and the usage samplers start with the listener
///   (`host::enable_background_relays`).
///
/// Not run here, on purpose: the stage wipe and the container/VM orphan
/// sweeps. The window runs them because its tabs end with it; a server's
/// tabs live in the tmux unit across daemon restarts, so what a previous
/// daemon started is not an orphan.
fn start_agent_work() {
    if let Err(error) = crate::services::agent_session::install_session_start_hook() {
        eprintln!("{SLUG}-serverd: agent session hooks: {error}");
    }
    crate::services::agent_auth::start();
    std::thread::spawn(crate::services::ssh_exec::sweep_stale_control_sockets);
    std::thread::spawn(crate::services::ssh_common::sweep_stale_askpass);
    host::enable_background_relays();
}

/// Serve `config` until the admin socket asks for a shutdown.
pub async fn run(config: ServerConfig) -> Result<(), String> {
    harden_process();
    let host = host_config(&config)?;
    let listen = Listen::Unix {
        path: config.socket_path.clone(),
        peer_uid: config.gateway_uid,
        content_origin: config.content_origin.clone(),
    };
    eprintln!(
        "{SLUG}-serverd: serving {} on {} for the gateway{}",
        config.origin,
        config.socket_path.display(),
        config.gateway_uid.map(|uid| format!(" (uid {uid})")).unwrap_or_default()
    );
    host::run_with(host, listen).await
}

/// The daemon's own state dir and app home, apart from the desktop app's
/// (`~/.local/share/<slug>-server`, `~/<slug>-server`): the server may run
/// on a machine that is also someone's desktop, and the same account may run
/// the desktop app beside its daemon (plan §12 Q12, "separate apps"). Two
/// processes over one `state_dir` would share `projects.json`, session
/// state, the mobile control dir (its admin socket and device keys), agent
/// homes and the mail store. An explicit `<PREFIX>STATE_DIR` / `<PREFIX>HOME`
/// wins (tests, a custom layout).
pub fn server_dirs(home: &std::path::Path) -> (PathBuf, PathBuf) {
    (home.join(".local").join("share").join(format!("{SLUG}-server")), home.join(format!("{SLUG}-server")))
}

fn separate_from_the_desktop() {
    let (state, app_home) = server_dirs(&crate::paths::home_dir());
    for (name, dir) in [("STATE_DIR", state), ("HOME", app_home)] {
        let key = brand::CURRENT.env_name(name);
        if std::env::var_os(&key).is_none() {
            // Single-threaded here (the first thing `main` does); every
            // child the daemon starts inherits the same layout.
            std::env::set_var(&key, dir);
        }
    }
}

/// The account's secrets vault (hosted plan §6.8), installed before anything
/// reads a credential or opens the mail store: from here on opt-in passwords
/// and new mail stores are sealed under the device-released key. In `main`,
/// not [`run`], so a test serving a daemon does not install a process-wide
/// vault under every other test of its binary.
pub fn install_vault(state_dir: &std::path::Path) {
    use super::vault::{self, Vault};
    #[cfg(target_os = "linux")]
    let hold: std::sync::Arc<dyn vault::KeyHold> = std::sync::Arc::new(vault::KernelKeyring);
    #[cfg(not(target_os = "linux"))]
    let hold: std::sync::Arc<dyn vault::KeyHold> = std::sync::Arc::new(vault::MemoryHold::default());
    let vault = vault::install(Vault::new(state_dir.to_path_buf(), hold));
    // K survived a restart in the keyring: a rotation a revoke left pending
    // (locked at the time, or `--revoke-device` with the daemon stopped)
    // runs now.
    match crate::services::mobile_control::auth::read_secrets_device_keys(&state_dir.join("mobile-control")) {
        Ok(devices) => vault.resume(&devices),
        // Never "no devices": that would drop every device's wrap.
        Err(error) => eprintln!("{SLUG}-serverd: a pending secrets-key rotation waits for the next release ({error})"),
    }
    let status = vault.status();
    eprintln!(
        "{SLUG}-serverd: secrets key {}",
        match (status.set_up, status.unlocked) {
            (false, _) => "not set up yet (Settings → Mobile → Server)",
            (true, true) => "unlocked (held in the persistent keyring)",
            (true, false) => "locked until a paired device connects",
        }
    );
}

/// The sidecar's configuration for a daemon: Mobile on, the gateway's origin
/// as what devices sign, the browser client on, the port a formality (nothing
/// listens on it; `Listen::Unix` decides). `settings.json` is not consulted
/// for any of it — the account's own settings cannot switch its daemon off.
pub fn host_config(config: &ServerConfig) -> Result<HostConfig, String> {
    let control_dir = config.state_dir.join("mobile-control");
    Ok(HostConfig {
        state_dir: config.state_dir.clone(),
        control_dir,
        host: MobileHostSettings {
            enabled: true,
            display_name: String::new(),
            port: 0,
            serve_origin: Some(config.origin.clone()),
            stay_after_quit: Some(true),
            browser_client: Some(true),
        },
        origin: config.origin.clone(),
    })
}

/// `PR_SET_DUMPABLE = 0` (plan §6.8): other processes of this uid — the
/// user's own shells and agents — cannot `ptrace` or read `/proc/<pid>/mem`
/// of the daemon, which holds the unlocked secrets key. Best effort: a kernel
/// that refuses leaves the deployment check (`prereq`) to say so.
fn harden_process() {
    #[cfg(target_os = "linux")]
    // SAFETY: prctl with PR_SET_DUMPABLE and an integer argument reads no
    // memory; the remaining arguments are unused for this option.
    unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong);
    }
}

/// Where a user's daemon socket lives: `/run/<slug>/users/<user>.sock`, the
/// path `<slug>-serverd@<user>.socket` listens on.
pub fn socket_path_for(user: &str) -> PathBuf {
    super::wire::socket_path(&PathBuf::from("/run").join(SLUG).join("users"), user)
}

/// One line from stdin (the admin helper passes secrets there, never in
/// `argv`, which `/proc` shows): at most 256 bytes, trimmed.
fn read_secret_line() -> Result<String, String> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::io::stdin().take(256).read_to_end(&mut buf).map_err(|e| format!("stdin: {e}"))?;
    let line = String::from_utf8(buf).map_err(|_| "stdin is not text".to_string())?;
    Ok(line.trim().to_string())
}

/// Up to `max` bytes of stdin, as text.
fn read_stdin_text(max: u64) -> Result<String, String> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::io::stdin().take(max).read_to_end(&mut buf).map_err(|e| format!("stdin: {e}"))?;
    String::from_utf8(buf).map_err(|_| "stdin is not text".to_string())
}

/// `--write-invite <expires_at>` (code on stdin): the admin helper's invite,
/// written by this account's own uid into its control dir (§4.1).
pub fn write_invite(state_dir: &std::path::Path, code: &str, expires_at: Option<&str>) -> Result<(), String> {
    if code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err("the code must be eight digits".into());
    }
    let expires_at: u64 = expires_at.and_then(|v| v.parse().ok()).ok_or("an expiry (epoch seconds) is needed")?;
    crate::services::mobile_control::auth::write_invite(&state_dir.join("mobile-control"), code, expires_at)
}

/// `--revoke-device` (id on stdin): the running daemon forgets the device
/// through its admin socket; with none running, the device file is edited.
pub fn revoke_device(state_dir: &std::path::Path, device_id: &str) -> Result<(), String> {
    use crate::services::mobile_control::{admin, auth::AuthStore, protocol::{AdminRequest, AdminResponse}};
    if !super::wire::valid_device_id(device_id) {
        return Err("not a device id".into());
    }
    let control_dir = state_dir.join("mobile-control");
    let socket = control_dir.join("admin.sock");
    let request = AdminRequest::Revoke { device_id: device_id.into() };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    match runtime.block_on(admin::admin_call(&socket, &request)) {
        Ok(AdminResponse::Error { message }) => Err(message),
        Ok(_) => Ok(()),
        Err(_) => {
            // No daemon, so no vault in this process: drop the device's wrap
            // here and leave the rotation of the key to the next release
            // (or the daemon's next start while the key is still held).
            AuthStore::open(&control_dir, String::new())?.revoke(device_id)?;
            super::vault::revoke_offline(state_dir, device_id)
        }
    }
}

/// Progress lines of an install, on stderr (the helper's terminal).
struct StderrEvents;

impl app_core::EventSink for StderrEvents {
    fn emit_json(&self, event: &str, payload: String) {
        if event == "agent-install-progress" {
            let line = serde_json::from_str::<serde_json::Value>(&payload).ok().and_then(|v| v["line"].as_str().map(str::to_string)).unwrap_or(payload);
            eprintln!("{line}");
        }
    }
    fn emit_json_to(&self, _: &app_core::ClientId, event: &str, payload: String) {
        self.emit_json(event, payload);
    }
}

/// `--install-cli <id>`, run by the admin helper as the CLI account with
/// `<PREFIX>SERVER_CLI_ROOT` set: the desktop's installer, into the
/// server-wide root (`agent_install::install_root_in` follows the variable);
/// an installed CLI is updated instead.
pub fn install_cli(id: &str) -> Result<(), String> {
    use crate::commands::agents;
    let Some(root) = super::cli_root() else {
        return Err(format!("{} is not set: run this through the admin helper's cli-install", brand::CURRENT.env_name(super::CLI_ROOT_ENV)));
    };
    // A private temp dir under the install root (P3 review finding 15): the
    // vendors' installers stage downloads in `$TMPDIR`, and the shared `/tmp`
    // is every user's. Set before any thread exists.
    let tmp = root.join(".tmp");
    crate::services::mobile_control::store::ensure_private_dir(&tmp)?;
    std::env::set_var("TMPDIR", &tmp);
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
    app_core::rt::install(runtime.handle().clone());
    crate::services::mail_engine::install_crypto_provider();
    let ctx = crate::tauri_host::Ctx(app_core::CoreCtx::system(std::sync::Arc::new(crate::standalone_core_state()), std::sync::Arc::new(StderrEvents)));
    let id = id.to_string();
    let message = runtime.block_on(async move {
        if agents::agent_is_installed(id.clone()).await {
            agents::update_agent(ctx, id).await
        } else {
            agents::install_agent(ctx, id).await
        }
    })?;
    eprintln!("{message}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use base64ct::{Base64UrlUnpadded, Encoding};
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};
    use p256::pkcs8::EncodePublicKey;
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    use crate::services::mobile_control::auth;

    const ORIGIN: &str = "https://desk.example.ts.net";

    /// The fence execs `<this binary> --fence-scope <bwrap> …` where Landlock
    /// scopes abstract sockets; `main` must answer that verb, or every fenced
    /// agent of a server fails with "unknown argument" (P3b review).
    #[cfg(target_os = "linux")]
    #[test]
    fn main_answers_the_fence_scope_verb_the_fence_execs() {
        let (_, args) = crate::services::agent_fence::seccomp_launcher("/usr/bin/bwrap", Some("/usr/lib/x/serverd"), std::path::Path::new("/f"), vec!["--".into()]);
        let helper = args.iter().position(|a| a == "/usr/lib/x/serverd").unwrap();
        assert_eq!(args[helper + 2], super::FENCE_SCOPE_ARG, "{args:?}");
    }

    /// One HTTP/1.1 request over the daemon's socket, `Connection: close`.
    async fn raw(socket: &std::path::Path, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>) -> (u16, Vec<(String, String)>, String) {
        let mut stream = UnixStream::connect(socket).await.expect("connect");
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: desk.example.ts.net\r\nConnection: close\r\n");
        for (k, v) in headers {
            request.push_str(&format!("{k}: {v}\r\n"));
        }
        if let Some(body) = body {
            request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
        }
        request.push_str("\r\n");
        if let Some(body) = body {
            request.push_str(body);
        }
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let mut lines = head.lines();
        let status: u16 = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).unwrap_or(0);
        let headers = lines.filter_map(|l| l.split_once(": ").map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))).collect();
        (status, headers, body.to_string())
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// The daemon end to end on a unix socket: the invite the helper wrote
    /// enrols a device, the device signs the daemon's nonce, and the browser
    /// transport serves that session with the role the gateway names — the
    /// token link is not needed, and the `Host`/`Origin` are the gateway's.
    #[tokio::test]
    async fn the_daemon_serves_a_device_enrolled_by_invite_with_the_gateway_role() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as WsMessage};
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        let socket = dir.path().join("d.sock");
        let config = ServerConfig {
            state_dir: state_dir.clone(),
            socket_path: socket.clone(),
            gateway_uid: None,
            origin: ORIGIN.into(),
            content_origin: Some(format!("{ORIGIN}:8443")),
        };
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        auth::write_invite(&state_dir.join("mobile-control"), "12345678", now + 600).unwrap();
        tokio::spawn(async move {
            if let Err(error) = run(config).await {
                eprintln!("daemon: {error}");
            }
        });
        for _ in 0..200 {
            if socket.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let (status, _, body) = raw(&socket, "GET", "/healthz", &[], None).await;
        assert_eq!(status, 200, "{body}");
        // The browser shell asks for a sign-in; through another host nothing exists.
        let (status, _, _) = raw(&socket, "GET", "/desktop/", &[], None).await;
        assert_eq!(status, 401);
        // The single-user token link (an admin session) does not exist behind
        // the gateway: the token file is the account's own to read, so a
        // link signed with it must not raise a user to admin.
        let token = std::fs::read_to_string(state_dir.join("mobile-control").join(crate::services::mobile_control::web_client::TOKEN_FILE)).expect("the token file");
        let link = crate::services::mobile_control::web_client::login_url(0, token.trim());
        let path = &link[link.find("/desktop/login").unwrap()..];
        let (status, headers, _) = raw(&socket, "GET", path, &[], None).await;
        assert_eq!(status, 404, "no token login behind the gateway");
        assert!(header(&headers, "set-cookie").is_none());
        let mut other = UnixStream::connect(&socket).await.unwrap();
        other.write_all(b"GET /desktop/ HTTP/1.1\r\nHost: other.example\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut bytes = Vec::new();
        other.read_to_end(&mut bytes).await.unwrap();
        assert!(String::from_utf8_lossy(&bytes).starts_with("HTTP/1.1 404"));

        // Enrol with the invite (a wrong code first: a miss, not a lockout).
        let signing = SigningKey::random(&mut rand::rngs::OsRng);
        let public_key = Base64UrlUnpadded::encode_string(signing.verifying_key().to_public_key_der().unwrap().as_bytes());
        let pair = |code: &str| json!({ "code": code, "device_name": "Laptop", "public_key": public_key }).to_string();
        let (status, _, body) = raw(&socket, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&pair("00000000"))).await;
        assert_eq!(status, 400, "{body}");
        let (status, _, body) = raw(&socket, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&pair("12345678"))).await;
        assert_eq!(status, 201, "{body}");
        let device_id = serde_json::from_str::<Value>(&body).unwrap()["device_id"].as_str().unwrap().to_string();
        assert!(!state_dir.join("mobile-control").join(auth::INVITE_FILE).exists(), "the invite is spent");
        let (status, _, body) = raw(&socket, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&pair("12345678"))).await;
        assert_eq!(status, 400, "a spent invite enrols nothing: {body}");
        // An identity provider's token pairs nothing without this account's
        // binding (P5 OIDC), whatever the token says.
        let forged = json!({ "oidc_token": "e30.e30.c2ln", "device_name": "Laptop", "public_key": public_key }).to_string();
        let (status, _, body) = raw(&socket, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&forged)).await;
        assert_eq!((status, body.contains("invalid_oidc")), (400, true), "{body}");

        // Sign the daemon's nonce.
        let (status, _, body) = raw(&socket, "POST", "/api/v1/auth/challenge", &[("Origin", ORIGIN)], Some(&json!({ "device_id": device_id }).to_string())).await;
        assert_eq!(status, 200, "{body}");
        let challenge: Value = serde_json::from_str(&body).unwrap();
        let signature: Signature = signing.sign(challenge["payload"].as_str().unwrap().as_bytes());
        let session = json!({ "device_id": device_id, "nonce": challenge["nonce"], "signature": Base64UrlUnpadded::encode_string(&signature.to_bytes()) }).to_string();
        let (status, headers, body) = raw(&socket, "POST", "/api/v1/auth/session", &[("Origin", ORIGIN)], Some(&session)).await;
        assert_eq!(status, 200, "{body}");
        let cookie = header(&headers, "set-cookie").unwrap().split(';').next().unwrap().to_string();
        assert!(cookie.starts_with("__Host-"), "{cookie}");

        // The device session signs the browser shell in.
        let (status, headers, body) = raw(&socket, "GET", "/desktop/", &[("Cookie", &cookie)], None).await;
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("web:bundle"), "no bundle in a test → the not-built page");
        assert!(header(&headers, "content-security-policy").unwrap().contains("wss://desk.example.ts.net"), "{headers:?}");

        // The socket: the role is the gateway's header, a user by default.
        let open = |role: Option<&str>| {
            let mut request = "ws://desk.example.ts.net/api/v1/desktop/ws".into_client_request().unwrap();
            request.headers_mut().insert("cookie", cookie.parse().unwrap());
            request.headers_mut().insert("origin", ORIGIN.parse().unwrap());
            request.headers_mut().insert("sec-websocket-protocol", crate::brand::DESKTOP_PROTOCOL.parse().unwrap());
            if let Some(role) = role {
                request.headers_mut().insert(super::super::ROLE_HEADER, role.parse().unwrap());
            }
            request
        };
        let stream = UnixStream::connect(&socket).await.unwrap();
        let (mut ws, _) = tokio_tungstenite::client_async(open(None), stream).await.expect("upgrade");
        let hello: Value = match ws.next().await.unwrap().unwrap() {
            WsMessage::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("{other:?}"),
        };
        assert_eq!(hello["capabilities"]["role"], "user");
        // A ticket names the user-content origin; an admin command is refused.
        ws.send(WsMessage::Text(json!({ "t": "call", "id": 1, "cmd": "install_ollama" }).to_string().into())).await.unwrap();
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(v["err"]["code"], "admin", "{v}");
        }
        ws.close(None).await.unwrap();
        let stream = UnixStream::connect(&socket).await.unwrap();
        let (mut ws, _) = tokio_tungstenite::client_async(open(Some("admin")), stream).await.expect("upgrade");
        let hello: Value = match ws.next().await.unwrap().unwrap() {
            WsMessage::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("{other:?}"),
        };
        assert_eq!(hello["capabilities"]["role"], "admin");
        ws.send(WsMessage::Text(json!({ "t": "call", "id": 2, "cmd": crate::services::mobile_control::web_client::FILE_TICKET_CMD, "args": { "path": "/tmp/x.pdf" } }).to_string().into())).await.unwrap();
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert!(v["ok"]["url"].as_str().unwrap().starts_with("https://desk.example.ts.net:8443/content/"), "{v}");
        }
        ws.close(None).await.unwrap();
        // The socket's Origin must be the gateway's, not a loopback one.
        let mut request = open(None);
        request.headers_mut().insert("origin", "http://127.0.0.1:8742".parse().unwrap());
        let stream = UnixStream::connect(&socket).await.unwrap();
        assert!(tokio_tungstenite::client_async(request, stream).await.is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o660);
        }
    }

    /// A connection from another uid is dropped before a byte is read.
    #[tokio::test]
    async fn another_uid_is_refused_at_accept() {
        use crate::services::mobile_control::limits::PeerGatedUnixListener;
        // SAFETY: getuid has no preconditions.
        let own = unsafe { libc::getuid() };
        assert!(PeerGatedUnixListener::allows(None, own));
        assert!(PeerGatedUnixListener::allows(Some(own), own));
        assert!(!PeerGatedUnixListener::allows(Some(own.wrapping_add(1)), own));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gated.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let gated = PeerGatedUnixListener::new(listener, Some(own.wrapping_add(1)));
        let refused = gated.refused_counter();
        let app = axum::Router::new().route("/healthz", axum::routing::get(|| async { "ok" }));
        tokio::spawn(async move { axum::serve(gated, app).await.unwrap() });
        let mut stream = UnixStream::connect(&path).await.unwrap();
        stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut bytes = Vec::new();
        // Closed or reset, either way nothing was answered.
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes)).await.expect("the server closes");
        assert!(bytes.is_empty(), "nothing is answered: {:?}", String::from_utf8_lossy(&bytes));
        assert_eq!(refused.load(std::sync::atomic::Ordering::Relaxed), 1);
    }

    /// Side by side with the desktop app (plan §12 Q12): the daemon's state
    /// dir and app home are never the desktop's.
    #[test]
    fn the_daemon_keeps_its_state_apart_from_the_desktop_app() {
        let home = std::path::Path::new("/home/alice");
        let (state, app_home) = server_dirs(home);
        assert_eq!(state, home.join(".local/share").join(format!("{SLUG}-server")));
        assert_eq!(app_home, home.join(format!("{SLUG}-server")));
        let desktop_state = home.join(".local/share").join(SLUG);
        assert_ne!(state, desktop_state);
        assert!(!state.starts_with(&desktop_state) && !desktop_state.starts_with(&state));
        assert_ne!(app_home, home.join(SLUG));
    }

    #[test]
    fn the_helpers_invite_and_revoke_run_as_the_user_on_its_own_state() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_invite(dir.path(), "1234567", Some("99")).is_err(), "eight digits");
        assert!(write_invite(dir.path(), "12345678", None).is_err(), "an expiry");
        write_invite(dir.path(), "12345678", Some("4000000000")).unwrap();
        let invite = dir.path().join("mobile-control").join(auth::INVITE_FILE);
        let text = std::fs::read_to_string(&invite).unwrap();
        assert!(!text.contains("12345678"), "only the hash is stored");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&invite).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(revoke_device(dir.path(), "../x").is_err());
        // No daemon is running and no device is known: the file path answers.
        assert!(revoke_device(dir.path(), "dev_unknown_01").unwrap_err().contains("unknown device"));
        assert!(install_cli("claude").is_err() || super::super::cli_root().is_some(), "outside the helper there is no root to install into");
    }

    #[test]
    fn the_host_config_is_the_gateway_origin_with_mobile_and_the_browser_on() {
        let config = ServerConfig {
            state_dir: PathBuf::from("/home/alice/.local/share/x"),
            socket_path: PathBuf::from("/run/x/users/1001.sock"),
            gateway_uid: Some(998),
            origin: "https://desk.example.ts.net".into(),
            content_origin: None,
        };
        let host = host_config(&config).unwrap();
        assert!(host.host.enabled);
        assert_eq!(host.host.browser_client, Some(true));
        assert_eq!(host.origin, "https://desk.example.ts.net");
        assert_eq!(host.control_dir, PathBuf::from("/home/alice/.local/share/x/mobile-control"));
        assert_eq!(socket_path_for("alice"), PathBuf::from("/run").join(SLUG).join("users/alice.sock"));
    }
}
