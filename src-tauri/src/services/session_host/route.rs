//! Which desktop launches run in the session host, what it may run, and what
//! a launch does when the host does not serve it (plan §3, Desktop tab; §4,
//! Fallback vs fail closed; P0 outcome). Pure, so every rule is tested on
//! every OS; `session_mux::winhost` and `terminal::spawn_pty` apply them.
//!
//! **Which tabs** ([`routes_through_host`]): the experimental
//! `windows_session_host` flag and `persist_local_sessions` both on, a local
//! AI tab the window asked to persist (it carries a `tmux_session`, the
//! `shouldPersistLocalTab` rule), never the root scope or the Host session,
//! never a shell (Defaults 1). An assistant chat goes when the window wrapped
//! it, as on Unix.
//!
//! **Which programs** ([`host_argv`]): never a batch file — `cmd.exe /c`'s
//! re-parse of the arguments is the BatBadBut injection class, and `%`
//! cannot be escaped there at all. `terminal::launch_command` already turns
//! an npm `.cmd` shim into `node.exe <script.js>`; any other batch launch
//! stays an in-process ConPTY, as it is today.
//!
//! **When the host does not serve it** ([`decide`]): definitively absent
//! (no copy, the start failed or it never came up, no protocol level in
//! common) → the in-process ConPTY plus a one-time notice; present but silent
//! (the pipe opened and no `Welcome` within [`HANDSHAKE_DEADLINE`], busy,
//! someone else's pipe, a connection lost mid-request) → the spawn fails with
//! [`ERR_SILENT`], never a second `--resume` agent on the same conversation.

use std::time::Duration;

use super::client::ClientError;
use super::protocol::{ErrorCode, Request, SizePolicy};

/// How long a client waits for the host's `Welcome` once the pipe opened —
/// the probe behind "present but silent". Lazy start has its own 3 s
/// (`launch::START_WAIT`) before that.
pub const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(5);

/// The error code a failed tab spawn starts with when the host is present
/// but silent: the window offers Retry, never a second agent.
pub const ERR_SILENT: &str = "session_host_silent";
/// The error code a failed tab spawn starts with when the host answered and
/// refused the spawn or attach (its message follows).
pub const ERR_REFUSED: &str = "session_host_refused";
/// The event a launch emits the first time it falls back to an in-process
/// ConPTY because the host is absent (payload [`FallbackNotice`]); once per
/// app run.
pub const FALLBACK_EVENT: &str = "session-host-fallback";

/// [`FALLBACK_EVENT`]'s payload.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FallbackNotice {
    /// The tab that fell back.
    pub id: String,
    /// Why the host was absent, in the host's own words (never a secret).
    pub reason: String,
}

/// What [`routes_through_host`] decides on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RouteFacts {
    /// The experimental `windows_session_host` setting.
    pub flag_on: bool,
    /// `persist_local_sessions` (on unless set off).
    pub persist_local: bool,
    /// The window asked for a persistent session (`tmux_session` is set).
    pub has_session: bool,
    /// The launch resolved local: no ssh or container wrap rewrote it.
    pub local: bool,
    /// An AI launch (an agent or an assistant chat; a CLI sign-in is not).
    pub ai: bool,
    /// The root scope's tab.
    pub root_scope: bool,
    /// The root console's unfenced Host session.
    pub host_session: bool,
}

/// Whether a launch with `facts` runs in the session host.
pub fn routes_through_host(facts: &RouteFacts) -> bool {
    facts.flag_on
        && facts.persist_local
        && facts.has_session
        && facts.local
        && facts.ai
        && !facts.root_scope
        && !facts.host_session
}

/// Whether a launch that does **not** route through the host must first ask
/// a running host for its session: a persisted local agent tab the host
/// would have taken, were the flag and `persist_local_sessions` on. Turning
/// either off respawns the tab while its agent may still run in the host;
/// starting it in-process then would be a second `--resume` agent.
pub fn must_probe_live_session(facts: &RouteFacts) -> bool {
    !routes_through_host(facts)
        && facts.has_session
        && facts.local
        && facts.ai
        && !facts.root_scope
        && !facts.host_session
}

/// What such a launch does with the probe's answer (`SessionMux::has` on a
/// host it never starts): `Ok(true)` attaches to the live session through the
/// host, attach-only — the agent keeps running and stays reachable, where
/// failing would leave a Retry that can never succeed while the setting is
/// off; `Ok(false)` (no host, no session) runs in-process; an error (a host
/// that does not answer, or one this build cannot speak to) fails closed.
pub fn on_live_probe(probe: Result<bool, String>) -> Result<LaunchVia, HostFailure> {
    match probe {
        Ok(true) => Ok(LaunchVia::AttachOnly),
        Ok(false) => Ok(LaunchVia::InProcess),
        Err(why) => Err(HostFailure::Silent(why)),
    }
}

/// How a probed launch runs ([`on_live_probe`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchVia {
    InProcess,
    /// Through the host, `Attach` only: never a `Spawn`.
    AttachOnly,
}

/// Why the host did not serve a launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostFailure {
    /// Definitively absent: nothing runs the tab's command, the fallback is safe.
    Absent(String),
    /// Present but silent: a session may be running; fail closed.
    Silent(String),
    /// The host answered and refused the spawn or attach.
    Refused(String),
}

impl std::fmt::Display for HostFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Absent(why) | Self::Silent(why) | Self::Refused(why) => f.write_str(why),
        }
    }
}

/// What a launch does about a [`HostFailure`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnDecision {
    /// Run the tab in-process, as without the host, and tell the user once.
    FallBack,
    /// Fail the spawn with this error code first in the message.
    FailClosed(&'static str),
}

/// The fallback rule: only an absent host falls back.
pub fn decide(failure: &HostFailure) -> SpawnDecision {
    match failure {
        HostFailure::Absent(_) => SpawnDecision::FallBack,
        HostFailure::Silent(_) => SpawnDecision::FailClosed(ERR_SILENT),
        HostFailure::Refused(_) => SpawnDecision::FailClosed(ERR_REFUSED),
    }
}

/// The spawn's error text for a failure that fails closed: the code, then why.
pub fn spawn_error(code: &str, failure: &HostFailure) -> String {
    format!("{code}: {failure}")
}

/// A failed connect (plan §4). `opened`: the host's pipe was opened at some
/// point; `start_failed`: a lazy start of the host failed. Absent only when
/// the pipe never opened and the start failed or the host never came up;
/// anything else may be a live host with sessions — one that speaks no
/// protocol level in common included (an older host kept alive by its
/// sessions is not retired), so it fails closed.
pub fn classify_connect(opened: bool, start_failed: bool, err: &ClientError) -> HostFailure {
    let why = err.to_string();
    match err {
        _ if opened => HostFailure::Silent(why),
        ClientError::Io(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::TimedOut) => {
            HostFailure::Absent(why)
        }
        _ if start_failed => HostFailure::Absent(why),
        _ => HostFailure::Silent(why),
    }
}

/// A `Spawn` or `Attach` the greeted host did not grant. Busy is silence (a
/// session may be starting); a dropped connection may have left a session
/// running, so it is too.
pub fn classify_request(err: &ClientError) -> HostFailure {
    let why = err.to_string();
    match err {
        ClientError::Host { code: ErrorCode::Busy, .. } => HostFailure::Silent(why),
        ClientError::Host { .. } => HostFailure::Refused(why),
        _ => HostFailure::Silent(why),
    }
}

/// A launch as the host is to run it: what `Spawn` carries over the
/// authenticated pipe (the environment never rides an argv or a file).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostSpawn {
    pub name: String,
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<String>,
    pub remain_on_exit: bool,
    pub size_policy: SizePolicy,
}

impl HostSpawn {
    /// The create-or-attach `Spawn` at `cols`×`rows`.
    pub fn request(self, cols: u16, rows: u16) -> Request {
        Request::Spawn {
            name: self.name,
            argv: self.argv,
            env: self.env,
            cwd: self.cwd,
            cols,
            rows,
            remain_on_exit: self.remain_on_exit,
            size_policy: self.size_policy,
            create_only: false,
        }
    }
}

fn is_batch(arg: &str) -> bool {
    let lower = arg.trim_end_matches(['"', ' ']).to_ascii_lowercase();
    lower.ends_with(".bat") || lower.ends_with(".cmd")
}

fn stem_is(path: &str, stem: &str) -> bool {
    // Either separator: the rule is tested on every OS.
    let leaf = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let leaf = leaf.split('.').next().unwrap_or(leaf);
    leaf.eq_ignore_ascii_case(stem)
}

/// The argv the host may run for a launch, or why not: `argv[0]` absolute
/// (`resolve` finds a bare name), never a batch file nor `cmd.exe` running
/// one (see the module doc). `Err` keeps the tab in-process.
pub fn host_argv(mut argv: Vec<String>, resolve: impl Fn(&str) -> Option<String>) -> Result<Vec<String>, String> {
    let Some(first) = argv.first() else { return Err("empty command".into()) };
    if is_batch(first) {
        return Err(format!("a batch file ({first}) does not run through the session host"));
    }
    if stem_is(first, "cmd") && argv.iter().skip(1).any(|a| is_batch(a)) {
        return Err("a batch file run by cmd.exe does not run through the session host".into());
    }
    if !is_absolute_any(first) {
        let found = resolve(first).ok_or_else(|| format!("{first} is not on PATH"))?;
        if is_batch(&found) {
            return Err(format!("a batch file ({found}) does not run through the session host"));
        }
        argv[0] = found;
    }
    Ok(argv)
}

/// Absolute as Windows reads it (`C:\…`), or as this OS does.
fn is_absolute_any(path: &str) -> bool {
    let b = path.as_bytes();
    (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || std::path::Path::new(path).is_absolute()
}

/// The environment entries a `CreateProcessW` block can carry: the hidden
/// per-drive `=C:` entries and anything with `=` or NUL in its key dropped.
pub fn host_env<'a>(env: impl IntoIterator<Item = (&'a str, &'a str)>) -> Vec<(String, String)> {
    env.into_iter()
        .filter(|(k, v)| !k.is_empty() && !k.contains(['=', '\0']) && !v.contains('\0'))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// The variables a lazily started host process keeps of its starter's
/// environment: what Windows and the host itself need to run and find this
/// state dir. Everything else — an agent tab's API keys, lane tokens, the
/// app's control variables — stays out: the host's sessions get exactly the
/// environment their `Spawn` sends, so the host needs none of it.
const HOST_PROCESS_ENV: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "windir",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "ComSpec",
    "ProgramData",
];

/// The app's own variables that move its state dir and home (current and
/// old spelling), so the host serves the same state dir as its starter.
const HOST_APP_ENV: &[&str] = &["STATE_DIR", "HOME"];

/// The scrubbed environment a lazily started host runs with: only
/// [`HOST_PROCESS_ENV`] and the app's state-dir variables, matched without
/// regard to case (Windows environment names are case-insensitive). Those two
/// are control variables for a *tab* (`launch_prep::is_control_env`, which a
/// tab's env never carries in); here they are the starter's own, and the host
/// must resolve the same state dir — its pipe name is derived from it.
pub fn host_process_env(env: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    let pair = crate::brand::PAIR;
    let app: Vec<String> = HOST_APP_ENV
        .iter()
        .flat_map(|name| [Some(pair.cur.env_name(name)), pair.legacy_env_name(name)])
        .flatten()
        .collect();
    env.into_iter()
        .filter(|(k, _)| {
            HOST_PROCESS_ENV.iter().any(|keep| keep.eq_ignore_ascii_case(k))
                || app.iter().any(|keep| keep.eq_ignore_ascii_case(k))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> RouteFacts {
        RouteFacts {
            flag_on: true,
            persist_local: true,
            has_session: true,
            local: true,
            ai: true,
            root_scope: false,
            host_session: false,
        }
    }

    #[test]
    fn only_a_persisted_local_project_agent_goes_through_the_host() {
        assert!(routes_through_host(&agent()));
        let off = |f: fn(&mut RouteFacts)| {
            let mut facts = agent();
            f(&mut facts);
            routes_through_host(&facts)
        };
        assert!(!off(|f| f.flag_on = false), "the experimental flag");
        assert!(!off(|f| f.persist_local = false), "persist_local_sessions, as on Unix");
        assert!(!off(|f| f.has_session = false), "the window did not ask to persist it");
        assert!(!off(|f| f.local = false), "an ssh or container tab");
        assert!(!off(|f| f.ai = false), "a shell (phase 4)");
        assert!(!off(|f| f.root_scope = true), "never the root scope");
        assert!(!off(|f| f.host_session = true), "never the Host session");
    }

    #[test]
    fn a_tab_the_host_would_have_taken_probes_for_its_live_session() {
        let mut facts = agent();
        assert!(!must_probe_live_session(&facts), "routed: the host takes it anyway");
        facts.flag_on = false;
        assert!(must_probe_live_session(&facts), "the flag turned off");
        facts.flag_on = true;
        facts.persist_local = false;
        assert!(must_probe_live_session(&facts), "persist_local_sessions turned off");
        for unprobed in [
            RouteFacts { ai: false, ..facts },
            RouteFacts { root_scope: true, ..facts },
            RouteFacts { host_session: true, ..facts },
            RouteFacts { has_session: false, ..facts },
            RouteFacts { local: false, ..facts },
        ] {
            assert!(!must_probe_live_session(&unprobed), "{unprobed:?}");
        }
        assert_eq!(on_live_probe(Ok(true)), Ok(LaunchVia::AttachOnly), "never a duplicate agent");
        assert_eq!(on_live_probe(Ok(false)), Ok(LaunchVia::InProcess));
        assert!(matches!(on_live_probe(Err("mute".into())), Err(HostFailure::Silent(_))));
    }

    #[test]
    fn only_an_absent_host_falls_back() {
        assert_eq!(decide(&HostFailure::Absent("x".into())), SpawnDecision::FallBack);
        assert_eq!(decide(&HostFailure::Silent("x".into())), SpawnDecision::FailClosed(ERR_SILENT));
        assert_eq!(decide(&HostFailure::Refused("x".into())), SpawnDecision::FailClosed(ERR_REFUSED));
        assert_eq!(spawn_error(ERR_SILENT, &HostFailure::Silent("no answer".into())), "session_host_silent: no answer");
    }

    #[test]
    fn only_a_host_that_cannot_be_running_is_absent() {
        use std::io::{Error, ErrorKind};
        let io = |k: ErrorKind| ClientError::Io(Error::new(k, "x"));
        let absent = |f: HostFailure| matches!(f, HostFailure::Absent(_));
        assert!(absent(classify_connect(false, false, &io(ErrorKind::NotFound))));
        assert!(absent(classify_connect(false, false, &io(ErrorKind::TimedOut))));
        assert!(absent(classify_connect(false, true, &io(ErrorKind::Other))));
        // No common protocol level: a host is there (maybe an older one kept
        // by its sessions) — never a fallback.
        assert!(!absent(classify_connect(true, false, &ClientError::Version("old".into()))));
        assert!(!absent(classify_connect(true, true, &ClientError::Version("old".into()))));
        assert!(!absent(classify_connect(true, true, &io(ErrorKind::TimedOut))), "opened beats a failed start");
        // Present: the pipe opened, belongs to someone else, or stayed busy.
        let silent = |f: HostFailure| matches!(f, HostFailure::Silent(_));
        assert!(silent(classify_connect(true, false, &io(ErrorKind::TimedOut))));
        assert!(silent(classify_connect(true, false, &ClientError::Closed)));
        assert!(silent(classify_connect(false, false, &io(ErrorKind::PermissionDenied))));
        assert!(silent(classify_connect(false, false, &io(ErrorKind::Other))));
    }

    #[test]
    fn a_refused_request_is_refused_and_a_busy_or_lost_one_silent() {
        let host = |code| ClientError::Host { code, msg: "m".into() };
        assert!(matches!(classify_request(&host(ErrorCode::BadName)), HostFailure::Refused(_)));
        assert!(matches!(classify_request(&host(ErrorCode::Busy)), HostFailure::Silent(_)));
        assert!(matches!(classify_request(&ClientError::Closed), HostFailure::Silent(_)));
        assert!(matches!(classify_request(&ClientError::Version("v".into())), HostFailure::Silent(_)));
    }

    #[test]
    fn the_spawn_request_carries_the_launch_and_the_size() {
        let spawn = HostSpawn {
            name: "s".into(),
            argv: vec!["C:\\x\\agent.exe".into(), "--resume".into()],
            env: vec![("API_KEY".into(), "secret".into())],
            cwd: Some("C:\\work".into()),
            remain_on_exit: true,
            size_policy: SizePolicy::Latest,
        };
        match spawn.request(120, 40) {
            Request::Spawn { name, argv, env, cols, rows, remain_on_exit, create_only, .. } => {
                assert_eq!((name.as_str(), cols, rows, remain_on_exit, create_only), ("s", 120, 40, true, false));
                assert_eq!(argv.len(), 2);
                assert_eq!(env, vec![("API_KEY".to_string(), "secret".to_string())]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn batch_files_never_reach_the_host() {
        let none = |_: &str| None;
        let found = |name: &str| Some(format!("C:\\Windows\\System32\\{name}"));
        assert!(host_argv(vec!["C:\\npm\\claude.cmd".into()], none).is_err());
        assert!(host_argv(vec!["C:\\x\\RUN.BAT".into(), "a".into()], none).is_err());
        assert!(host_argv(vec!["cmd.exe".into(), "/D".into(), "/C".into(), "C:\\x\\tool.cmd".into()], found).is_err());
        assert!(host_argv(vec!["C:\\Windows\\System32\\cmd.exe".into(), "/c".into(), "C:\\x\\t.bat".into()], none).is_err());
        assert!(host_argv(vec!["tool".into()], |_| Some("C:\\x\\tool.cmd".into())).is_err());
        assert!(host_argv(vec![], none).is_err());
        assert!(host_argv(vec!["nowhere".into()], none).is_err());
    }

    #[test]
    fn programs_are_made_absolute_and_kept_otherwise() {
        let found = |name: &str| Some(format!("C:\\Windows\\System32\\{name}"));
        assert_eq!(
            host_argv(vec!["cmd.exe".into(), "/k".into()], found).unwrap(),
            vec!["C:\\Windows\\System32\\cmd.exe".to_string(), "/k".to_string()]
        );
        // An npm shim, already rewritten by the launch to node + its script.
        let node = vec!["C:\\npm\\node.exe".to_string(), "C:\\npm\\node_modules\\x\\cli.js".to_string(), "50%".to_string()];
        assert_eq!(host_argv(node.clone(), |_| None).unwrap(), node);
    }

    #[test]
    fn the_env_block_drops_entries_it_cannot_carry() {
        let env = host_env([("=C:", "C:\\"), ("PATH", "x"), ("", "y"), ("A=B", "z"), ("NUL", "a\0b")]);
        assert_eq!(env, vec![("PATH".to_string(), "x".to_string())]);
    }

    /// The host process starts with what it needs and none of a tab's
    /// secrets or the app's control variables.
    #[test]
    fn a_started_host_gets_a_scrubbed_environment() {
        let state = crate::brand::PAIR.cur.env_name("STATE_DIR");
        let control = crate::services::root_mcp::TOKEN_ENV.to_string();
        let env: Vec<(String, String)> = [
            ("Path", "C:\\Windows"),
            ("SYSTEMROOT", "C:\\Windows"),
            ("TEMP", "C:\\t"),
            ("LOCALAPPDATA", "C:\\l"),
            ("ANTHROPIC_API_KEY", "sk-secret"),
            ("OPENAI_API_KEY", "sk-other"),
            (state.as_str(), "C:\\state"),
            (control.as_str(), "lane-token"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let kept: Vec<String> = host_process_env(env).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, ["Path", "SYSTEMROOT", "TEMP", "LOCALAPPDATA", state.as_str()]);
        // The one control variable kept is the starter's own state dir (a
        // dev sandbox's): without it the host would serve another pipe.
        assert!(kept.iter().filter(|k| crate::services::launch_prep::is_control_env(k)).all(|k| *k == state));
    }
}
