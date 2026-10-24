//! Which OpenCode session is a tab's own.
//!
//! OpenCode mints its own session ids (`ses_…`) and has no session hook, so a
//! restored OpenCode tab used to be launched with `--continue`, "the most
//! recent session of this directory": every OpenCode tab of one folder came
//! back in the same conversation, and the Reader showed them all the same.
//! Now each tab records the session it is in, as the other CLIs' hooks do,
//! and is restored into that one with `--session <id>`:
//!
//! - **The plugin.** One directory of Tabtivity's in `<state_dir>/hooks/`
//!   (read-only in the fence, at its own path), listed by file URL in every
//!   agent home's `.config/opencode/opencode.json` `plugin` list — the
//!   directory for OpenCode 2 (2.1.3 skips a configured plugin file), its
//!   `index.js` for 1.x. Each time the tab's
//!   OpenCode takes a prompt it writes that session's id to
//!   `live_sessions/<uid>`, beside the other CLIs' records — a `/new` or a
//!   session picked from `/sessions` moves it at the next prompt. Only the
//!   tab's own OpenCode records: `TAB_AGENT` names OpenCode (set at the spawn,
//!   so one nested under another CLI's tab stays out), a claim it sets in its
//!   environment keeps one nested under the tab out, and a subagent's child
//!   session (its `task` tool) is never recorded.
//! - **The launch note.** At each spawn a host-only `<uid>.opencode` in the
//!   shared live-sessions root says whether that launch continued the folder's
//!   newest session or started fresh, and when. A tab launched since the
//!   plugin existed that never took a prompt has no session of its own, so it
//!   is restored fresh — not into a sibling's. A tab from before the plugin
//!   (no note) keeps its `--continue` until its first prompt records one.
//! - **The Reader** (`agent_transcript`, `agent_changes`) reads the recorded
//!   session while the store still has it; otherwise the folder's newest, as
//!   before, created since the last fresh launch.
//!
//! Remote tabs (their store is on the far host) and local-model tabs (their
//! own home) are left as they were. AppHandle-free.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::brand::DISPLAY;
use crate::services::agent_session::{is_uuid_shaped, live_sessions_dir, project_live_sessions_dir, TAB_AGENT_ENV};
use crate::services::home_io::HomeFile;
use crate::services::opencode_store;
use crate::storage;
use crate::terminal::PtyOptions;

/// The plugin's directory in `<state_dir>/hooks/`, and its entry file.
/// OpenCode 2 loads a configured local plugin only as a directory (2.1.3 skips
/// a file with "configured plugin path must be a directory") and resolves its
/// `index`; 1.x imports the file itself.
const PLUGIN_DIR: &str = concat!(crate::app_slug!(), "_opencode_session");
const PLUGIN_ENTRY: &str = "index.js";
/// The single file earlier builds wrote and listed: taken back out of homes.
const LEGACY_PLUGIN_FILE: &str = concat!(crate::app_slug!(), "_opencode_session.js");
/// Set by the plugin in its own environment once it records for the tab: an
/// OpenCode the tab's agent starts inherits it and records nothing.
const CLAIM_ENV: &str = crate::app_env!("OPENCODE_SESSION");
/// Suffix of the host-only launch note beside the tab's record.
const LAUNCH_SUFFIX: &str = ".opencode";

/// OpenCode's session id shape (`ses_` and base62). The record is written from
/// inside the fence, and the id becomes an argument, so nothing else is taken.
pub fn is_session_id(s: &str) -> bool {
    s.strip_prefix("ses_")
        .is_some_and(|rest| (1..=64).contains(&rest.len()) && rest.chars().all(|c| c.is_ascii_alphanumeric()))
}

fn plugin_dir() -> PathBuf {
    storage::state_dir().join("hooks").join(PLUGIN_DIR)
}

fn file_url(path: PathBuf) -> Option<String> {
    url::Url::from_file_path(path).ok().map(String::from)
}

/// The `plugin` entry OpenCode loads the plugin by: the directory for V2, the
/// entry file for V1.
fn plugin_url(v2: bool) -> Option<String> {
    let dir = plugin_dir();
    file_url(if v2 { dir } else { dir.join(PLUGIN_ENTRY) })
}

/// Every entry of Tabtivity's that is not `url`: the other release's, and the
/// single file earlier builds listed.
fn stale_urls(url: &str) -> Vec<String> {
    let hooks = storage::state_dir().join("hooks");
    [plugin_url(true), plugin_url(false), file_url(hooks.join(LEGACY_PLUGIN_FILE))]
        .into_iter()
        .flatten()
        .filter(|u| u != url)
        .collect()
}

/// Whether the OpenCode Tabtivity last probed is 2.x (`agent_versions`; a
/// spawn probes it before resolving, `launch_prep::prepare`).
fn installed_v2() -> bool {
    let store = crate::services::agent_versions::load();
    crate::services::agent_versions::opencode_is_v2(store.get("opencode"))
}

fn plugin_body(live_dir: &str) -> String {
    let lit = |s: &str| serde_json::to_string(s).expect("a string serializes");
    format!(
        "// {DISPLAY}: records which OpenCode session this tab is in, so the tab is\n\
         // restored into it (`--session`) rather than the folder's newest one.\n\
         // Managed by {DISPLAY}; do not edit.\n\
         import {{ mkdirSync, renameSync, writeFileSync }} from \"node:fs\";\n\
         import {{ join }} from \"node:path\";\n\
         \n\
         const DIR = {dir};\n\
         const TAB = /^[0-9a-fA-F]{{8}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{12}}$/;\n\
         const SESSION = /^ses_[A-Za-z0-9]{{1,64}}$/;\n\
         \n\
         const TabSession = async () => {{\n\
         \x20 const uid = process.env[{uid}] ?? \"\";\n\
         \x20 // The tab's own OpenCode only: one nested under it inherits the claim,\n\
         \x20 // one under another CLI's tab carries that CLI's name.\n\
         \x20 if (process.env[{agent}] !== \"opencode\" || !TAB.test(uid) || process.env[{claim}]) return {{}};\n\
         \x20 process.env[{claim}] = \"1\";\n\
         \x20 const children = new Set();\n\
         \x20 let recorded = \"\";\n\
         \x20 return {{\n\
         \x20   event: async ({{ event }}) => {{\n\
         \x20     const info = event?.properties?.info;\n\
         \x20     if (String(event?.type).startsWith(\"session.\") && info?.parentID && typeof info.id === \"string\") children.add(info.id);\n\
         \x20   }},\n\
         \x20   \"chat.message\": async (input) => {{\n\
         \x20     const id = input?.sessionID;\n\
         \x20     if (typeof id !== \"string\" || id === recorded || children.has(id) || !SESSION.test(id)) return;\n\
         \x20     try {{\n\
         \x20       mkdirSync(DIR, {{ recursive: true }});\n\
         \x20       const tmp = join(DIR, `.${{uid}}.${{process.pid}}.tmp`);\n\
         \x20       writeFileSync(tmp, id);\n\
         \x20       renameSync(tmp, join(DIR, uid));\n\
         \x20       recorded = id;\n\
         \x20     }} catch {{}}\n\
         \x20   }},\n\
         \x20 }};\n\
         }};\n\
         \n\
         // V1 (1.18.29+) calls server; V2 calls setup. No runtime dependency:\n\
         // Plugin.define is the identity function in @opencode/plugin.\n\
         export default {{\n\
         \x20 id: {plugin_id},\n\
         \x20 server: TabSession,\n\
         \x20 async setup(ctx) {{\n\
         \x20   const hooks = await TabSession();\n\
         \x20   if (!hooks[\"chat.message\"]) return;\n\
         \x20   await ctx.session.hook(\"prompt\", async (input) => {{\n\
         \x20     // Query the session itself: restored children need not emit a\n\
         \x20     // session-created event after this plugin was loaded.\n\
         \x20     const session = await ctx.session.get({{ sessionID: input.sessionID }});\n\
         \x20     if (session.parentID) return;\n\
         \x20     await hooks[\"chat.message\"](input);\n\
         \x20   }});\n\
         \x20 }},\n\
         }};\n",
        plugin_id = lit(concat!(crate::app_slug!(), ".session")),
        dir = lit(live_dir),
        uid = lit(crate::app_env!("TAB_UID")),
        agent = lit(TAB_AGENT_ENV),
        claim = lit(CLAIM_ENV),
    )
}

/// Write the plugin beside the session hook. Idempotent; part of
/// `agent_session::install_session_start_hook`. Every spawn re-lists the
/// plugin in its home, so the earlier single file is removed.
pub fn write_plugin() -> std::io::Result<()> {
    let dir = plugin_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(PLUGIN_ENTRY);
    let body = plugin_body(&live_sessions_dir().to_string_lossy());
    if std::fs::read(&path).ok().as_deref() != Some(body.as_bytes()) {
        std::fs::write(&path, body)?;
    }
    if let Some(hooks) = dir.parent() {
        let _ = std::fs::remove_file(hooks.join(LEGACY_PLUGIN_FILE));
    }
    Ok(())
}

/// List the plugin in one agent home's OpenCode config. True when it is
/// listed afterwards — a config that isn't plain JSON is left alone, and then
/// the tab records nothing.
pub fn register_in_home(home: &Path) -> bool {
    let Some(url) = plugin_url(installed_v2()) else { return false };
    let stale = stale_urls(&url);
    let Some(file) = HomeFile::open(home, crate::services::agent_hint::OPENCODE_CONFIG) else {
        return false;
    };
    if let Err(e) = crate::services::agent_hint::merge_json(&file, |root| add_plugin(root, &url, &stale)) {
        eprintln!("opencode_session: register the plugin in {}: {e}", home.display());
    }
    file.read()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|root| lists(&root, &url))
}

/// OpenCode 2's managed background service listens on one fixed loopback
/// port shared by every home, and a typed `opencode` does not get
/// `--standalone`. `disabled: true` in the home's service config makes every
/// launch from it use a private server (`standalone || disabled`). A 1.x
/// home ignores the file.
const SERVICE_CONFIG: &str = ".config/opencode/service.json";

pub fn disable_service_in_home(home: &Path) {
    let Some(file) = HomeFile::open(home, SERVICE_CONFIG) else {
        eprintln!("opencode_session: {SERVICE_CONFIG} in {} is not a plain path; skipped", home.display());
        return;
    };
    let result = crate::services::agent_hint::merge_json(&file, |root| {
        let changed = root.get("disabled") != Some(&json!(true));
        root["disabled"] = json!(true);
        changed
    });
    if let Err(e) = result {
        eprintln!("opencode_session: disable the service in {}: {e}", home.display());
    }
}

fn lists(root: &Value, url: &str) -> bool {
    root.get(plugin_key(root))
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|p| p.as_str() == Some(url)))
}

fn plugin_key(root: &Value) -> &'static str {
    if root.get("plugins").is_some() { "plugins" } else { "plugin" }
}

/// Add `url` to OpenCode's `plugin` list, taking the `stale` entries out.
/// False when nothing changes.
fn add_plugin(root: &mut Value, url: &str, stale: &[String]) -> bool {
    let is_stale = |p: &Value| p.as_str().is_some_and(|p| stale.iter().any(|s| s == p));
    let key = plugin_key(root);
    let has_stale = root.get(key).and_then(Value::as_array).is_some_and(|list| list.iter().any(is_stale));
    if lists(root, url) && !has_stale {
        return false;
    }
    let list = crate::services::agent_hint::slot(root, key, json!([]));
    let list = list.as_array_mut().expect("an array");
    list.retain(|p| !is_stale(p));
    if !list.iter().any(|p| p.as_str() == Some(url)) {
        list.push(json!(url));
    }
    true
}

/// V2's private server keeps the tab's environment, MCP grants and plugin
/// claim in its own process tree. Its model flag belongs to `mini`/`run`,
/// whereas V1 also accepted it on the full TUI. Preserve those saved launches
/// through the minimal interface, which accepts both the model and session.
pub fn v2_launch_args(args: &mut Vec<String>) {
    let first = args.first().map(String::as_str);
    if first.is_some_and(|a| matches!(a, "debug" | "upgrade" | "update" | "uninstall" | "service" | "plugin" | "mcp" | "serve" | "pair" | "reload" | "models" | "stats" | "session" | "api")) {
        return;
    }
    if args.iter().any(|a| a == "--mini") {
        args.retain(|a| a != "--mini");
        args.insert(0, "mini".into());
    } else if first.is_none_or(|a| a.starts_with('-'))
        && args.iter().any(|a| a == "--model" || a == "-m" || a.starts_with("--model=") || a == "--agent" || a.starts_with("--agent="))
    {
        args.insert(0, "mini".into());
    }
    // Explicit server connections are user-selected and keep their endpoint.
    if !args.iter().any(|a| a == "--standalone" || a == "--server" || a.starts_with("--server=")) {
        args.push("--standalone".into());
    }
}

/// The session `uid`'s plugin last recorded: of the shared root and the
/// scope's own slice (where a fenced or containerized OpenCode writes), the
/// record written last — the rule `agent_session::read_live_session_for`
/// applies to the other CLIs.
pub fn recorded_session(project_id: Option<&str>, uid: &str) -> Option<String> {
    if !is_uuid_shaped(uid) {
        return None;
    }
    let slice = project_live_sessions_dir(project_id.unwrap_or(storage::ROOT_SCOPE));
    [live_sessions_dir(), slice]
        .iter()
        .filter_map(|dir| {
            let path = dir.join(uid);
            let id = crate::services::home_io::read_record(&path)?.trim().to_string();
            let stamp = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
            is_session_id(&id).then_some((stamp, id))
        })
        .max_by_key(|(stamp, _)| *stamp)
        .map(|(_, id)| id)
}

/// Point the record of `uid` in `dir` at the session `id`, as its plugin
/// would at the session's next prompt: the Reader's Resume menu
/// (`agent_session::resume_chat_plan`), before the tab is relaunched onto it.
pub fn record_session_in(dir: &Path, uid: &str, id: &str) -> std::io::Result<()> {
    if !is_uuid_shaped(uid) || !is_session_id(id) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a tab key and an OpenCode session"));
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{uid}.tmp"));
    std::fs::write(&tmp, id)?;
    std::fs::rename(&tmp, dir.join(uid))
}

/// How a tab's last launch began, from its launch note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Launch {
    /// Into the folder's newest session (`--continue`, a tab from before the
    /// plugin).
    Continued,
    /// Into no session yet, at this moment (epoch ms).
    Fresh(i64),
}

fn launch_note(dir: &Path, uid: &str) -> PathBuf {
    dir.join(format!("{uid}{LAUNCH_SUFFIX}"))
}

fn read_launch_in(dir: &Path, uid: &str) -> Option<Launch> {
    let raw = crate::services::home_io::read_record(&launch_note(dir, uid))?;
    match raw.trim().split_once(' ')? {
        ("continue", _) => Some(Launch::Continued),
        ("fresh", at) => at.parse().ok().map(Launch::Fresh),
        _ => None,
    }
}

fn write_launch_in(dir: &Path, uid: &str, launch: Launch) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let text = match launch {
        Launch::Continued => format!("continue {}", crate::clock::now_ms()),
        Launch::Fresh(at) => format!("fresh {at}"),
    };
    std::fs::write(launch_note(dir, uid), text)
}

/// Resolve an OpenCode tab's session at spawn: the session its plugin
/// recorded, while the store still has it; else a fresh start for a tab that
/// launched since the plugin existed; else (a tab from before) its args as
/// they are.
pub fn resolve(opts: PtyOptions) -> PtyOptions {
    let remote = !opts.local_only
        && opts.project_id.as_deref().is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
    if remote || opts.local_model {
        return opts;
    }
    let project_id = opts.project_id.clone();
    let home = crate::services::agent_home::scope_home(project_id.as_deref());
    let db = opencode_store::db_path_for(project_id.as_deref());
    let registered = register_in_home(&home);
    resolve_in(
        opts,
        &live_sessions_dir(),
        registered,
        |uid| recorded_session(project_id.as_deref(), uid),
        |id| opencode_store::resumable_session(&db, id),
    )
}

/// Testable core of [`resolve`]; `notes` holds the launch notes.
fn resolve_in(
    mut opts: PtyOptions,
    notes: &Path,
    registered: bool,
    recorded: impl Fn(&str) -> Option<String>,
    resumable: impl Fn(&str) -> bool,
) -> PtyOptions {
    opts.env.insert(TAB_AGENT_ENV.to_string(), "opencode".to_string());
    let Some(uid) = opts.env.get(crate::app_env!("TAB_UID")).filter(|uid| is_uuid_shaped(uid)).cloned() else {
        return opts;
    };
    let own = recorded(&uid).filter(|id| resumable(id));
    let noted = read_launch_in(notes, &uid).is_some();
    let (args, launch) = session_args(&opts.args, own.as_deref(), noted);
    opts.args = args;
    // Without the plugin listed the tab can record nothing, so it is not told
    // apart from a tab from before the plugin.
    if registered {
        if let Err(e) = write_launch_in(notes, &uid, launch) {
            eprintln!("opencode_session: launch note: {e}");
        }
    }
    opts
}

/// The tab's args with its session flags (`--continue`/`-c`, `--session`/`-s
/// <id>`) replaced: `--session <own>` when it has one; nothing when it was
/// launched since the plugin (`noted`) — a session it never prompted is not
/// its own; untouched otherwise. And how the launch begins.
fn session_args(args: &[String], own: Option<&str>, noted: bool) -> (Vec<String>, Launch) {
    let continues = args.iter().any(|a| a == "--continue" || a == "-c");
    if own.is_none() && !noted {
        let launch = if continues { Launch::Continued } else { Launch::Fresh(now_ms()) };
        return (args.to_vec(), launch);
    }
    let mut out = Vec::with_capacity(args.len() + 2);
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--continue" | "-c" => {}
            "--session" | "-s" => {
                rest.next();
            }
            a if a.starts_with("--session=") => {}
            _ => out.push(arg.clone()),
        }
    }
    if let Some(id) = own {
        out.push("--session".to_string());
        out.push(id.to_string());
    }
    (out, Launch::Fresh(now_ms()))
}

fn now_ms() -> i64 {
    crate::clock::now_ms() as i64
}

/// What the Reader reads for the OpenCode tab `launch_id`: the session its
/// plugin recorded (the store checks it is still there), and the moment since
/// which the folder's sessions are the tab's own — the caller's `since`, or
/// the tab's last fresh launch when it has been relaunched since.
pub fn reader_session(project_id: Option<&str>, launch_id: Option<&str>, since: Option<i64>) -> (Option<String>, Option<i64>) {
    let Some(uid) = launch_id.filter(|uid| is_uuid_shaped(uid)) else {
        return (None, since);
    };
    reader_session_in(&live_sessions_dir(), recorded_session(project_id, uid), uid, since)
}

fn reader_session_in(notes: &Path, own: Option<String>, uid: &str, since: Option<i64>) -> (Option<String>, Option<i64>) {
    let since = match read_launch_in(notes, uid) {
        Some(Launch::Fresh(at)) => Some(since.map_or(at, |s| s.max(at))),
        _ => since,
    };
    (own, since)
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: &str = "0b9f6a52-3c1d-4e8a-9f00-1a2b3c4d5e6f";

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{}-oc-session-{name}-{}", crate::app_slug!(), std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_resume_menu_records_the_session_a_relaunch_resumes() {
        let dir = tmp("record");
        record_session_in(&dir, UID, "ses_Picked1").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(UID)).unwrap(), "ses_Picked1");
        let (args, _) = session_args(&["--continue".to_string()], Some("ses_Picked1"), true);
        assert_eq!(args, ["--session", "ses_Picked1"]);
        assert!(record_session_in(&dir, UID, "ses_bad/../x").is_err());
        assert!(record_session_in(&dir, "../escape", "ses_Picked1").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn opts(args: &[&str]) -> PtyOptions {
        let mut o = PtyOptions {
            login: None,
            assistant: None,
            id: "t".to_string(),
            cmd: "opencode".to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: Default::default(),
            cwd: "/".to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: true,
            project_id: None,
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
            local_model: false,
            schedule_target_id: None,
            host_session: false,
            api_key: None,
        };
        o.env.insert(crate::app_env!("TAB_UID").to_string(), UID.to_string());
        o
    }

    #[test]
    fn session_ids_are_opencode_shaped_only() {
        assert!(is_session_id("ses_f26212f69ffeassQ0ftSQS3aBd"));
        for bad in ["", "ses_", "ses_../x", "--continue", "0b9f6a52-3c1d", "ses_a b", "msg_abc"] {
            assert!(!is_session_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_tab_with_a_recorded_session_is_restored_into_it_not_the_folders_newest() {
        let notes = tmp("own");
        let out = resolve_in(opts(&["--model", "m", "--continue"]), &notes, true, |_| Some("ses_mine".into()), |_| true);
        assert_eq!(out.args, ["--model", "m", "--session", "ses_mine"]);
        assert_eq!(out.env.get(TAB_AGENT_ENV).map(String::as_str), Some("opencode"));
        assert!(matches!(read_launch_in(&notes, UID), Some(Launch::Fresh(_))));
    }

    #[test]
    fn a_recorded_session_the_store_lost_is_not_resumed() {
        let notes = tmp("lost");
        write_launch_in(&notes, UID, Launch::Fresh(1)).unwrap();
        let out = resolve_in(opts(&["--continue"]), &notes, true, |_| Some("ses_gone".into()), |_| false);
        assert!(out.args.is_empty());
    }

    #[test]
    fn a_tab_that_never_prompted_since_the_plugin_starts_fresh_instead_of_joining_a_sibling() {
        let notes = tmp("fresh");
        // Its first launch: opened fresh, noted.
        let first = resolve_in(opts(&[]), &notes, true, |_| None, |_| true);
        assert!(first.args.is_empty());
        // Restored with the continue flag, still without a prompt of its own.
        let again = resolve_in(opts(&["--continue"]), &notes, true, |_| None, |_| true);
        assert!(again.args.is_empty());
    }

    #[test]
    fn a_tab_from_before_the_plugin_keeps_its_continue_until_it_records() {
        let notes = tmp("legacy");
        let out = resolve_in(opts(&["--continue"]), &notes, true, |_| None, |_| true);
        assert_eq!(out.args, ["--continue"]);
        assert_eq!(read_launch_in(&notes, UID), Some(Launch::Continued));
        // Without the plugin listed nothing is noted, so it stays a legacy tab.
        let unlisted = tmp("unlisted");
        let out = resolve_in(opts(&["--continue"]), &unlisted, false, |_| None, |_| true);
        assert_eq!(out.args, ["--continue"]);
        assert_eq!(read_launch_in(&unlisted, UID), None);
    }

    #[test]
    fn a_tab_without_a_uid_is_left_alone() {
        let notes = tmp("nouid");
        let mut o = opts(&["--continue"]);
        o.env.clear();
        let out = resolve_in(o, &notes, true, |_| Some("ses_x".into()), |_| true);
        assert_eq!(out.args, ["--continue"]);
    }

    #[test]
    fn a_home_keeps_its_opencode_service_off_beside_the_users_own_settings() {
        let home = tmp("service");
        let file = home.join(".config").join("opencode").join("service.json");
        disable_service_in_home(&home);
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&file).unwrap()).unwrap(), json!({"disabled": true}));
        std::fs::write(&file, r#"{"disabled": false, "port": 5}"#).unwrap();
        disable_service_in_home(&home);
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&file).unwrap()).unwrap(), json!({"disabled": true, "port": 5}));
    }

    #[test]
    fn stale_session_flags_are_replaced_not_doubled() {
        let (args, _) = session_args(&["-s".into(), "ses_old".into(), "--session=ses_x".into(), "-c".into()], Some("ses_new"), true);
        assert_eq!(args, ["--session", "ses_new"]);
    }

    #[test]
    fn the_reader_reads_only_sessions_since_a_fresh_relaunch() {
        let notes = tmp("reader");
        assert_eq!(reader_session_in(&notes, None, UID, None), (None, None));
        write_launch_in(&notes, UID, Launch::Fresh(500)).unwrap();
        assert_eq!(reader_session_in(&notes, None, UID, None), (None, Some(500)));
        assert_eq!(reader_session_in(&notes, None, UID, Some(900)), (None, Some(900)));
        write_launch_in(&notes, UID, Launch::Continued).unwrap();
        assert_eq!(reader_session_in(&notes, Some("ses_a".into()), UID, None), (Some("ses_a".into()), None));
    }

    #[test]
    fn the_plugin_is_listed_once_beside_the_users_own() {
        let mut root = json!({ "plugin": ["mine"], "model": "m" });
        assert!(add_plugin(&mut root, "file:///x.js", &[]));
        assert!(!add_plugin(&mut root, "file:///x.js", &[]));
        assert_eq!(root["plugin"], json!(["mine", "file:///x.js"]));
        assert_eq!(root["model"], "m");
    }

    #[test]
    fn a_release_switch_replaces_the_other_entry_of_ours() {
        // OpenCode 2.1.3 skips the file entry an earlier build listed; the
        // directory takes its place, and back for 1.x.
        let stale = ["file:///h/x.js".to_string(), "file:///h/x/index.js".to_string()];
        let mut root = json!({ "plugin": ["mine", "file:///h/x.js"] });
        assert!(add_plugin(&mut root, "file:///h/x", &stale));
        assert_eq!(root["plugin"], json!(["mine", "file:///h/x"]));
        assert!(!add_plugin(&mut root, "file:///h/x", &stale));
        let back = ["file:///h/x".to_string()];
        assert!(add_plugin(&mut root, "file:///h/x/index.js", &back));
        assert_eq!(root["plugin"], json!(["mine", "file:///h/x/index.js"]));
    }

    #[test]
    fn v2_lists_the_plugin_directory_and_v1_its_entry_file() {
        let v2 = plugin_url(true).unwrap();
        let v1 = plugin_url(false).unwrap();
        assert!(v2.ends_with(PLUGIN_DIR), "{v2}");
        assert_eq!(v1, format!("{v2}/{PLUGIN_ENTRY}"));
        let stale = stale_urls(&v2);
        assert!(stale.contains(&v1) && !stale.contains(&v2));
        assert!(stale.iter().any(|u| u.ends_with(LEGACY_PLUGIN_FILE)));
    }

    #[test]
    fn native_v2_plugins_take_precedence_without_losing_the_users_entries() {
        let mut root = json!({ "plugins": ["mine"], "plugin": ["legacy"] });
        assert!(add_plugin(&mut root, "file:///x.js", &[]));
        assert!(!add_plugin(&mut root, "file:///x.js", &[]));
        assert_eq!(root["plugins"], json!(["mine", "file:///x.js"]));
        assert_eq!(root["plugin"], json!(["legacy"]));
    }

    #[test]
    fn v2_launches_keep_tab_environment_private_and_saved_model_launches_work() {
        let convert = |args: &[&str]| {
            let mut args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            v2_launch_args(&mut args);
            args
        };
        assert_eq!(convert(&[]), ["--standalone"]);
        assert_eq!(convert(&["--model", "ollama/m", "--continue"]), ["mini", "--model", "ollama/m", "--continue", "--standalone"]);
        assert_eq!(convert(&["--mini", "--session", "ses_a"]), ["mini", "--session", "ses_a", "--standalone"]);
        assert_eq!(convert(&["run", "hello"]), ["run", "hello", "--standalone"]);
        assert_eq!(convert(&["auth", "login"]), ["auth", "login", "--standalone"]);
        for args in [&["debug", "paths"][..], &["--server=http://localhost:1"][..], &["mini", "--standalone"][..]] {
            assert_eq!(convert(args), args);
        }
    }

    #[test]
    fn the_plugin_names_the_apps_env_and_the_live_dir() {
        let body = plugin_body("/state/live_sessions");
        assert!(body.contains(&format!("process.env[\"{}\"]", crate::app_env!("TAB_UID"))));
        assert!(body.contains(&format!("process.env[\"{TAB_AGENT_ENV}\"] !== \"opencode\"")));
        assert!(body.contains("const DIR = \"/state/live_sessions\";"));
        assert!(body.contains("/^ses_[A-Za-z0-9]{1,64}$/"));
    }

    #[test]
    fn plugin_entrypoints_record_only_the_tabs_top_level_prompts() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("records");
        std::fs::write(dir.path().join("plugin.mjs"), plugin_body(&live.to_string_lossy())).unwrap();
        std::fs::write(dir.path().join("check.mjs"), r#"
            import assert from 'node:assert/strict';
            import { existsSync, readFileSync } from 'node:fs';
            import { join } from 'node:path';
            import plugin from './plugin.mjs';
            const [dir, uidKey, agentKey, claimKey, uid] = process.argv.slice(2);
            const record = join(dir, uid);
            process.env[uidKey] = uid;
            process.env[agentKey] = 'opencode';
            delete process.env[claimKey];
            let prompt;
            const ctx = { session: {
                hook: async (name, callback) => { assert.equal(name, 'prompt'); prompt = callback; },
                get: async ({sessionID}) => ({id: sessionID, parentID: sessionID === 'ses_child' ? 'ses_parent' : undefined}),
            }};
            await plugin.setup(ctx);
            await prompt({sessionID: 'ses_child'});
            assert.equal(existsSync(record), false);
            await prompt({sessionID: '../invalid'});
            assert.equal(existsSync(record), false);
            await prompt({sessionID: 'ses_first'});
            assert.equal(readFileSync(record, 'utf8'), 'ses_first');
            await prompt({sessionID: 'ses_new'});
            assert.equal(readFileSync(record, 'utf8'), 'ses_new');
            let nested = false;
            await plugin.setup({session: {hook: async () => { nested = true; }}});
            assert.equal(nested, false);
            delete process.env[claimKey];
            process.env[agentKey] = 'codex';
            await plugin.setup({session: {hook: async () => { nested = true; }}});
            assert.equal(nested, false);
            delete process.env[claimKey];
            process.env[agentKey] = 'opencode';
            const legacy = await plugin.server();
            await legacy.event({event: {type: 'session.created', properties: {info: {id: 'ses_child', parentID: 'ses_parent'}}}});
            await legacy['chat.message']({sessionID: 'ses_child'});
            assert.equal(readFileSync(record, 'utf8'), 'ses_new');
            await legacy['chat.message']({sessionID: 'ses_legacy'});
            assert.equal(readFileSync(record, 'utf8'), 'ses_legacy');
        "#).unwrap();
        let output = std::process::Command::new("node")
            .arg(dir.path().join("check.mjs")).arg(&live)
            .args([crate::app_env!("TAB_UID"), TAB_AGENT_ENV, CLAIM_ENV, UID])
            .output();
        match output {
            Ok(output) => assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => eprintln!("OpenCode plugin runtime check skipped: node unavailable"),
            Err(error) => panic!("OpenCode plugin runtime check: {error}"),
        }
    }
}
