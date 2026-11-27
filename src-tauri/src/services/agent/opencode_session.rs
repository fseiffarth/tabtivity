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
//!   directory, as OpenCode 2 loads it (2.1.3 skips a configured plugin file;
//!   1.x is not supported). Each time the tab's
//!   OpenCode takes a prompt it writes that session's id to
//!   `live_sessions/<uid>`, beside the other CLIs' records — a `/new` or a
//!   session picked from `/sessions` moves it at the next prompt. A prompt
//!   that reached the server before the plugin was loaded (it re-boots its
//!   instance on a prompt after a while idle) is caught by the session's run
//!   events instead, while the tab has none recorded. Only the
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
//!   session while the store still has it; otherwise the folder's newest
//!   created since the last fresh launch that no other tab's record claims
//!   (a sibling's chat is never shown as a fresh tab's).
//!
//! A local-model tab records and resumes the same way, against its local-model
//! home's store. Remote tabs (their store is on the far host) and assistant
//! chats (`assistant::launch_line` decides theirs, one chat to a folder) are
//! left as they were. AppHandle-free.

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
/// `index`.
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

/// The `plugin` entry OpenCode loads the plugin by: its directory.
fn plugin_url() -> Option<String> {
    file_url(plugin_dir())
}

/// The entries of Tabtivity's that earlier builds listed and homes may still
/// carry: the entry file listed for OpenCode 1.x, and the single file before it.
fn stale_urls() -> Vec<String> {
    let hooks = storage::state_dir().join("hooks");
    [file_url(plugin_dir().join(PLUGIN_ENTRY)), file_url(hooks.join(LEGACY_PLUGIN_FILE))]
        .into_iter()
        .flatten()
        .collect()
}

fn plugin_body(live_dir: &str) -> String {
    let lit = |s: &str| serde_json::to_string(s).expect("a string serializes");
    format!(
        "// {DISPLAY}: records which OpenCode session this tab is in, so the tab is\n\
         // restored into it (`--session`) rather than the folder's newest one, and\n\
         // the session's turn (working / decision / done) for the tab's marks.\n\
         // Managed by {DISPLAY}; do not edit.\n\
         import {{ mkdirSync, renameSync, writeFileSync }} from \"node:fs\";\n\
         import {{ join }} from \"node:path\";\n\
         \n\
         const DIR = {dir};\n\
         const TAB = /^[0-9a-fA-F]{{8}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{4}}-[0-9a-fA-F]{{12}}$/;\n\
         const SESSION = /^ses_[A-Za-z0-9]{{1,64}}$/;\n\
         const CLAIM = {claim};\n\
         // The bus events that move the turn: a question waits on the user, an\n\
         // answer resumes, the end of a run is done.\n\
         const TURN = {{\n\
         \x20 \"permission.asked\": \"decision\", \"form.created\": \"decision\",\n\
         \x20 \"permission.replied\": \"working\", \"form.replied\": \"working\", \"form.cancelled\": \"working\",\n\
         \x20 \"session.execution.succeeded\": \"done\", \"session.execution.failed\": \"done\",\n\
         \x20 \"session.execution.interrupted\": \"done\",\n\
         }};\n\
         \n\
         const TabSession = async () => {{\n\
         \x20 const uid = process.env[{uid}] ?? \"\";\n\
         \x20 // The tab's own OpenCode only: one nested under it inherits the claim,\n\
         \x20 // one under another CLI's tab carries that CLI's name.\n\
         \x20 if (process.env[{agent}] !== \"opencode\" || !TAB.test(uid) || process.env[CLAIM]) return {{}};\n\
         \x20 process.env[CLAIM] = \"1\";\n\
         \x20 const children = new Set();\n\
         \x20 let recorded = \"\";\n\
         \x20 const put = (suffix, text) => {{\n\
         \x20   try {{\n\
         \x20     mkdirSync(DIR, {{ recursive: true }});\n\
         \x20     const tmp = join(DIR, `.${{uid}}.${{process.pid}}.tmp`);\n\
         \x20     writeFileSync(tmp, text);\n\
         \x20     renameSync(tmp, join(DIR, uid + suffix));\n\
         \x20     return true;\n\
         \x20   }} catch {{\n\
         \x20     return false;\n\
         \x20   }}\n\
         \x20 }};\n\
         \x20 // Only the session the tab is in moves its turn: a subagent's child\n\
         \x20 // session and every other one have ids of their own.\n\
         \x20 const turn = (id, word) => {{\n\
         \x20   if (recorded && id === recorded) put(\".turn\", `${{word}} ${{Math.floor(Date.now() / 1000)}}`);\n\
         \x20 }};\n\
         \x20 return {{\n\
         \x20   // An event as the subscription yields it: `{{type, data}}`.\n\
         \x20   event: async ({{ event }}) => {{\n\
         \x20     const type = String(event?.type);\n\
         \x20     const props = event?.data ?? {{}};\n\
         \x20     const info = props.info;\n\
         \x20     if (type.startsWith(\"session.\") && info?.parentID && typeof info.id === \"string\") children.add(info.id);\n\
         \x20     const word = TURN[type];\n\
         \x20     if (word) turn(props.sessionID ?? props.form?.sessionID, word);\n\
         \x20   }},\n\
         \x20   \"chat.message\": async (input) => {{\n\
         \x20     const id = input?.sessionID;\n\
         \x20     if (typeof id !== \"string\" || children.has(id) || !SESSION.test(id)) return;\n\
         \x20     if (id !== recorded && put(\"\", id)) recorded = id;\n\
         \x20     turn(id, \"working\");\n\
         \x20   }},\n\
         \x20   // A session running in this tab's own server while it has none\n\
         \x20   // recorded: the prompt that booted the instance reached it before\n\
         \x20   // this plugin was loaded, so the prompt hook never saw it.\n\
         \x20   unrecorded: () => !recorded,\n\
         \x20   adopt: (id) => {{\n\
         \x20     if (recorded || typeof id !== \"string\" || children.has(id) || !SESSION.test(id)) return;\n\
         \x20     if (put(\"\", id)) recorded = id;\n\
         \x20   }},\n\
         \x20 }};\n\
         }};\n\
         \n\
         // The events that say a session is running here — not one only viewed.\n\
         const runs = (type) => type.startsWith(\"session.step.\") || type.startsWith(\"session.execution.\") || type in TURN;\n\
         \n\
         // OpenCode 2 calls setup. No runtime dependency: Plugin.define is the\n\
         // identity function in @opencode/plugin.\n\
         export default {{\n\
         \x20 id: {plugin_id},\n\
         \x20 async setup(ctx) {{\n\
         \x20   const hooks = await TabSession();\n\
         \x20   if (!hooks[\"chat.message\"]) return;\n\
         \x20   // The shell tool gets a per-session copy of the environment, so the\n\
         \x20   // claim set above never reached it and a nested `opencode run` took the\n\
         \x20   // record over (2.3.0): each shell gets it here.\n\
         \x20   try {{\n\
         \x20     await ctx.shell.hook(\"create.before\", async (input) => {{\n\
         \x20       if (input?.env) input.env[CLAIM] = \"1\";\n\
         \x20     }});\n\
         \x20   }} catch {{}}\n\
         \x20   await ctx.session.hook(\"prompt\", async (input) => {{\n\
         \x20     // Query the session itself: restored children need not emit a\n\
         \x20     // session-created event after this plugin was loaded.\n\
         \x20     const session = await ctx.session.get({{ sessionID: input.sessionID }});\n\
         \x20     if (session.parentID) return;\n\
         \x20     await hooks[\"chat.message\"](input);\n\
         \x20   }});\n\
         \x20   // Unfiltered: a type a release does not know may fail a filtered one.\n\
         \x20   try {{\n\
         \x20     const events = await ctx.event.subscribe();\n\
         \x20     (async () => {{\n\
         \x20       for await (const event of events) {{\n\
         \x20         const id = event?.data?.sessionID ?? event?.data?.form?.sessionID;\n\
         \x20         if (hooks.unrecorded() && typeof id === \"string\" && runs(String(event?.type))) {{\n\
         \x20           try {{\n\
         \x20             const session = await ctx.session.get({{ sessionID: id }});\n\
         \x20             if (!session.parentID) hooks.adopt(id);\n\
         \x20           }} catch {{}}\n\
         \x20         }}\n\
         \x20         await hooks.event({{ event }});\n\
         \x20       }}\n\
         \x20     }})().catch(() => {{}});\n\
         \x20   }} catch {{}}\n\
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
    let Some(url) = plugin_url() else { return false };
    let stale = stale_urls();
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
/// launch from it use a private server (`standalone || disabled`).
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

/// OpenCode 2's private server keeps the tab's environment, MCP grants and
/// plugin claim in its own process tree. Its model flag belongs to
/// `mini`/`run`, not the full TUI: saved launch lines carrying one go through
/// the minimal interface, which accepts both the model and session.
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
    crate::services::agent_session::write_live_record(dir, uid, id)
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
    if remote || opts.assistant.is_some() {
        return opts;
    }
    let project_id = opts.project_id.clone();
    let (home, db) = home_and_store(project_id.as_deref(), opts.local_model);
    let registered = register_in_home(&home);
    resolve_in(
        opts,
        &live_sessions_dir(),
        registered,
        |uid| recorded_session(project_id.as_deref(), uid),
        |id| opencode_store::resumable_session(&db, id),
    )
}

/// Whether a respawn of the cloud tab `uid` resumes its own session: its
/// plugin recorded one and the store still has it — [`resolve`]'s `own`.
/// Without one the respawn starts fresh or continues the folder's newest
/// session (`agent_resume_pinned`).
pub fn resume_pinned(project_id: Option<&str>, uid: &str) -> bool {
    let (_, db) = home_and_store(project_id, false);
    recorded_session(project_id, uid).is_some_and(|id| opencode_store::resumable_session(&db, &id))
}

/// The agent home a tab's OpenCode runs in, and the store that home keeps: a
/// local-model tab's are apart from the scope's.
fn home_and_store(project_id: Option<&str>, local_model: bool) -> (PathBuf, PathBuf) {
    if local_model {
        (crate::services::agent_home::local_model_home(project_id), opencode_store::local_model_db_path_for(project_id))
    } else {
        (crate::services::agent_home::scope_home(project_id), opencode_store::db_path_for(project_id))
    }
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

/// What the Reader reads for an OpenCode tab: see [`reader_session`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReaderSession {
    /// The session the tab's plugin recorded (the store checks it is still there).
    pub own: Option<String>,
    /// The moment since which the folder's sessions are the tab's own — the
    /// caller's `since`, or the tab's last fresh launch when it has been
    /// relaunched since.
    pub since: Option<i64>,
    /// Without `own`: the sessions other tabs' plugins recorded as theirs,
    /// which the folder's newest is never taken from — or a tab that has not
    /// prompted yet would show a sibling's chat as its own.
    pub claimed: Vec<String>,
}

/// What the Reader reads for the OpenCode tab `launch_id`.
pub fn reader_session(project_id: Option<&str>, launch_id: Option<&str>, since: Option<i64>) -> ReaderSession {
    let Some(uid) = launch_id.filter(|uid| is_uuid_shaped(uid)) else {
        return ReaderSession { since, ..Default::default() };
    };
    let mut read = reader_session_in(&live_sessions_dir(), recorded_session(project_id, uid), uid, since);
    if read.own.is_none() {
        let slice = project_live_sessions_dir(project_id.unwrap_or(storage::ROOT_SCOPE));
        read.claimed = claimed_in(&[live_sessions_dir(), slice], uid, read.since);
    }
    read
}

fn reader_session_in(notes: &Path, own: Option<String>, uid: &str, since: Option<i64>) -> ReaderSession {
    let since = match read_launch_in(notes, uid) {
        Some(Launch::Fresh(at)) => Some(since.map_or(at, |s| s.max(at))),
        _ => since,
    };
    ReaderSession { own, since, claimed: Vec::new() }
}

/// Slack under `since` for a record's modification time: it is stamped by the
/// file system, the session's creation by OpenCode.
const CLAIM_SLACK_MS: i64 = 5_000;

/// The OpenCode sessions recorded in `dirs` by tabs other than `uid`. With
/// `since`, only records written since then are read: a session the Reader
/// could take was created since, and its record after it.
fn claimed_in(dirs: &[PathBuf], uid: &str, since: Option<i64>) -> Vec<String> {
    let floor = since
        .and_then(|ms| u64::try_from(ms.saturating_sub(CLAIM_SLACK_MS)).ok())
        .map(|ms| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms));
    let mut claimed: Vec<String> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name().to_str().is_some_and(|name| name != uid && is_uuid_shaped(name)))
        .filter(|entry| {
            entry.metadata().is_ok_and(|meta| {
                meta.is_file() && floor.is_none_or(|floor| meta.modified().is_ok_and(|at| at >= floor))
            })
        })
        .filter_map(|entry| crate::services::home_io::read_record(&entry.path()))
        .map(|id| id.trim().to_string())
        .filter(|id| is_session_id(id))
        .collect();
    claimed.sort();
    claimed.dedup();
    claimed
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
            mux_wrapped: false,
            mcp_mark: None,
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
    fn a_local_model_tab_comes_back_in_its_session_on_its_model() {
        // The restored line: the launch line, then the resume flag. `--model`
        // has to survive: it picks the provider, and OpenCode 2's `mini`.
        let notes = tmp("local");
        let mut local = opts(&["--model", "ollama/qwen3:8b", "--continue"]);
        local.local_model = true;
        let mut out = resolve_in(local, &notes, true, |_| Some("ses_mine".into()), |_| true);
        assert_eq!(out.args, ["--model", "ollama/qwen3:8b", "--session", "ses_mine"]);
        v2_launch_args(&mut out.args);
        assert_eq!(out.args, ["mini", "--model", "ollama/qwen3:8b", "--session", "ses_mine", "--standalone"]);
    }

    #[test]
    fn a_local_model_tab_is_resolved_against_its_own_home_and_store() {
        let (home, db) = home_and_store(Some("p1"), true);
        assert_eq!(home, crate::services::agent_home::local_model_home(Some("p1")));
        assert!(db.starts_with(&home));
        let (scope_home, scope_db) = home_and_store(Some("p1"), false);
        assert_eq!(scope_home, crate::services::agent_home::scope_home(Some("p1")));
        assert!(scope_db.starts_with(&scope_home) && scope_db != db);
    }

    #[test]
    fn an_assistant_chat_keeps_the_continue_its_launch_line_decided() {
        let mut chat = opts(&["--model", "ollama/qwen3:8b", "--continue"]);
        chat.local_model = true;
        chat.assistant = Some(serde_json::from_str(r#"{"cli":"opencode_local","model":"qwen3:8b"}"#).unwrap());
        assert_eq!(resolve(chat).args, ["--model", "ollama/qwen3:8b", "--continue"]);
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
        let read = |own: Option<&str>, since| {
            let read = reader_session_in(&notes, own.map(str::to_string), UID, since);
            (read.own, read.since)
        };
        assert_eq!(read(None, None), (None, None));
        write_launch_in(&notes, UID, Launch::Fresh(500)).unwrap();
        assert_eq!(read(None, None), (None, Some(500)));
        assert_eq!(read(None, Some(900)), (None, Some(900)));
        write_launch_in(&notes, UID, Launch::Continued).unwrap();
        assert_eq!(read(Some("ses_a"), None), (Some("ses_a".into()), None));
    }

    /// Three OpenCode tabs in one folder, two not prompted yet: those two must
    /// not take the third's session as the folder's newest. Their own records,
    /// Claude's records beside them, launch notes and records older than the
    /// launch are not claims.
    #[test]
    fn other_tabs_records_are_claims() {
        let root = tmp("claims-root");
        let slice = tmp("claims-slice");
        const OTHER: &str = "6a0d7654-9781-48d2-9d10-55353bba0963";
        const FENCED: &str = "a6e9a1c0-a56f-40e2-9768-ff30b1c80740";
        const CLAUDE: &str = "9e0f0ff9-c7b4-4945-b958-f2791377994a";
        const OLD: &str = "c078300f-a1f1-40ae-9604-fa1379fd9d6d";
        std::fs::write(root.join(UID), "ses_mine").unwrap();
        std::fs::write(root.join(OTHER), "ses_other\n").unwrap();
        std::fs::write(slice.join(FENCED), "ses_fenced").unwrap();
        std::fs::write(slice.join(format!("{FENCED}.turn")), "done 1").unwrap();
        std::fs::write(root.join(format!("{OTHER}{LAUNCH_SUFFIX}")), "fresh 1").unwrap();
        std::fs::write(root.join(CLAUDE), "0b9f6a52-3c1d-4e8a-9f00-1a2b3c4d5e6f").unwrap();
        std::fs::create_dir_all(root.join("p1")).unwrap();
        let old = root.join(OLD);
        std::fs::write(&old, "ses_old").unwrap();
        let an_hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(an_hour_ago).unwrap();
        let dirs = [root.clone(), slice.clone()];
        assert_eq!(claimed_in(&dirs, UID, None), ["ses_fenced", "ses_old", "ses_other"]);
        let launched = crate::clock::now_ms() as i64 - 60_000;
        assert_eq!(claimed_in(&dirs, UID, Some(launched)), ["ses_fenced", "ses_other"]);
        assert_eq!(claimed_in(&dirs, OTHER, Some(launched)), ["ses_fenced", "ses_mine"]);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&slice);
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
    fn an_entry_an_earlier_build_listed_is_replaced_by_the_directory() {
        // OpenCode 2.1.3 skips the file entries earlier builds listed.
        let stale = ["file:///h/x.js".to_string(), "file:///h/x/index.js".to_string()];
        for old in &stale {
            let mut root = json!({ "plugin": ["mine", old] });
            assert!(add_plugin(&mut root, "file:///h/x", &stale));
            assert_eq!(root["plugin"], json!(["mine", "file:///h/x"]));
            assert!(!add_plugin(&mut root, "file:///h/x", &stale));
        }
    }

    #[test]
    fn the_plugin_is_listed_by_its_directory() {
        let url = plugin_url().unwrap();
        assert!(url.ends_with(PLUGIN_DIR), "{url}");
        let stale = stale_urls();
        assert!(stale.contains(&format!("{url}/{PLUGIN_ENTRY}")) && !stale.contains(&url));
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
            // OpenCode 1.x's entry point is gone.
            assert.equal(plugin.server, undefined);
        "#).unwrap();
        run_node_check(dir.path(), &live);
    }

    /// Run `check.mjs` in `dir` with node: the records folder, the tab's
    /// variable names and its key as arguments. Skipped without node.
    fn run_node_check(dir: &Path, live: &Path) {
        let output = std::process::Command::new("node")
            .arg(dir.join("check.mjs")).arg(live)
            .args([crate::app_env!("TAB_UID"), TAB_AGENT_ENV, CLAIM_ENV, UID])
            .output();
        match output {
            Ok(output) => assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => eprintln!("OpenCode plugin runtime check skipped: node unavailable"),
            Err(error) => panic!("OpenCode plugin runtime check: {error}"),
        }
    }

    /// The turn record from the events OpenCode 2.2.7 / 2.3.0 fired in the
    /// probe (`scripts/verify-cli/opencode/hooks.py`): the prompt is working,
    /// a permission or question asked is a decision, its answer working, the
    /// end of a run done. Only the session the tab is in counts — a
    /// subagent's child and any other session say nothing — and a nested
    /// OpenCode (the claim in its environment, which the plugin puts in every
    /// shell itself) records nothing at all.
    #[test]
    fn the_plugin_writes_the_turn_of_the_tabs_own_session_only() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("records");
        std::fs::write(dir.path().join("plugin.mjs"), plugin_body(&live.to_string_lossy())).unwrap();
        std::fs::write(dir.path().join("check.mjs"), r#"
            import assert from 'node:assert/strict';
            import { existsSync, readFileSync, rmSync } from 'node:fs';
            import { join } from 'node:path';
            import plugin from './plugin.mjs';
            const [dir, uidKey, agentKey, claimKey, uid] = process.argv.slice(2);
            const turnFile = join(dir, uid + '.turn');
            const word = () => existsSync(turnFile) ? readFileSync(turnFile, 'utf8').split(' ')[0] : null;
            const reset = () => rmSync(turnFile, { force: true });
            process.env[uidKey] = uid;
            process.env[agentKey] = 'opencode';
            delete process.env[claimKey];

            // V2: a pushable event stream, the prompt hook, the shell hook.
            const queue = []; let wake;
            const stream = { async *[Symbol.asyncIterator]() { for (;;) { while (queue.length) yield queue.shift(); await new Promise((r) => { wake = r; }); } } };
            const settle = () => new Promise((r) => setTimeout(r, 20));
            const emit = async (type, data) => { queue.push({ type, data }); wake?.(); await settle(); };
            let prompt, shell;
            await plugin.setup({
                session: {
                    hook: async (name, cb) => { assert.equal(name, 'prompt'); prompt = cb; },
                    get: async ({ sessionID }) => ({ id: sessionID, parentID: sessionID === 'ses_child' ? 'ses_main' : undefined }),
                },
                shell: { hook: async (name, cb) => { assert.equal(name, 'create.before'); shell = cb; } },
                event: { subscribe: async () => stream },
            });
            const record = join(dir, uid);
            // A session only looked at, or a subagent's child running, is not the tab's.
            await emit('session.updated', { sessionID: 'ses_main' });
            await emit('session.step.started', { sessionID: 'ses_child' });
            assert.equal(existsSync(record), false);
            assert.equal(word(), null);
            // The prompt that booted the instance came before the plugin: the
            // session's run makes it the tab's all the same.
            await emit('permission.asked', { sessionID: 'ses_main' });
            assert.equal(readFileSync(record, 'utf8'), 'ses_main');
            assert.equal(word(), 'decision');
            // Once recorded, another session's run takes nothing over.
            await emit('session.step.started', { sessionID: 'ses_other' });
            assert.equal(readFileSync(record, 'utf8'), 'ses_main');
            await prompt({ sessionID: 'ses_main' });
            assert.equal(word(), 'working');
            assert.match(readFileSync(turnFile, 'utf8'), /^working \d+$/);
            for (const [type, want] of [
                ['permission.asked', 'decision'], ['permission.replied', 'working'],
                ['form.created', 'decision'], ['form.replied', 'working'],
                ['session.execution.succeeded', 'done'],
                ['form.created', 'decision'], ['form.cancelled', 'working'], ['session.execution.interrupted', 'done'],
                ['session.execution.failed', 'done'],
            ]) {
                await emit(type, type === 'form.created' ? { form: { sessionID: 'ses_main' } } : { sessionID: 'ses_main' });
                assert.equal(word(), want, type);
            }
            // A subagent's child session and another session move nothing; nor
            // does an event the turn does not know.
            reset();
            await prompt({ sessionID: 'ses_child' });
            await emit('permission.asked', { sessionID: 'ses_child' });
            await emit('session.execution.succeeded', { sessionID: 'ses_other' });
            await emit('session.step.started', { sessionID: 'ses_main' });
            assert.equal(word(), null);
            // Every shell the tool starts carries the claim.
            const spawn = { env: { PATH: '/bin' } };
            await shell(spawn);
            assert.equal(spawn.env[claimKey], '1');

            // A nested OpenCode inherits the claim: it hooks nothing.
            let hooked = false;
            await plugin.setup({ session: { hook: async () => { hooked = true; } }, shell: { hook: async () => { hooked = true; } }, event: { subscribe: async () => { hooked = true; } } });
            assert.equal(hooked, false);

            process.exit(0);
        "#).unwrap();
        run_node_check(dir.path(), &live);
    }
}
