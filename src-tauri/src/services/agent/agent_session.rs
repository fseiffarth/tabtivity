//! Per-tab Claude session tracking so Tabtivity can resume the *current* session
//! after a `/clear` — and resume it in the permission mode it was left in.
//!
//! Claude is launched with a deterministic launch id (`--session-id <uuid>`),
//! but `/clear` rolls Claude onto a fresh session id with no recorded link back
//! to the launch id — so resuming the launch id brings back the pre-`/clear`
//! conversation. To follow the live id we install a global Claude `SessionStart`
//! hook (fires on startup / resume / clear / compact) that records the live
//! `session_id` — and, beside it, that `source` — keyed by `$TABTIVITY_TAB_UID`,
//! an env var Tabtivity sets on the spawned agent to the stable launch id (see
//! `terminal::resolve_claude_session`). The prompt history reads the same
//! record at write time (`services::agent_prompts`), so a prompt sent after a
//! `/clear` is filed under the session it actually reached.
//! The hook no-ops for any Claude not launched by Tabtivity (no `TABTIVITY_TAB_UID`),
//! so it is safe to install once, globally.

use crate::brand::{DISPLAY, UPPER};
use std::path::PathBuf;

use crate::paths;
use crate::services::home_io::HomeFile;
use crate::storage;
use crate::terminal::PtyOptions;

// The hook body is platform-specific: a POSIX `#!/bin/sh` script that the agents'
// shell (`/bin/sh`) runs directly on unix, and a PowerShell script on Windows
// (there is no `/bin/sh`; the agents run the hook `command` through `cmd.exe`).
#[cfg(not(windows))]
const HOOK_SCRIPT_NAME: &str = crate::brand::SESSION_HOOK_SH;
#[cfg(windows)]
const HOOK_SCRIPT_NAME: &str = crate::brand::SESSION_HOOK_PS1;

// ── Agent session resolution ────────────────────────────────────────────────
//
// At spawn time a tracked agent tab (Claude/Codex) must (re)attach to the right
// conversation. These resolvers live here, next to the SessionStart hook
// installer that records each tab's live session id, so all session logic is in
// one module. `terminal::spawn_pty` and the remote-aware spawn path call
// `resolve_agent_session` *before* any ssh wrapping, so remote tabs still pick
// up `--resume`/`resume` on the original `claude`/`codex` command.

/// Resolve a tracked agent tab's session args at spawn so it resumes the right
/// conversation. Dispatches per agent; non-tracked commands pass through.
pub fn resolve_agent_session(opts: PtyOptions) -> PtyOptions {
    match opts.cmd.as_str() {
        "claude" => resolve_claude_session(opts),
        "codex" => resolve_codex_session(opts),
        "vibe" => resolve_vibe_session(opts),
        "opencode" => crate::services::opencode_session::resolve(opts),
        "copilot" => crate::services::copilot_session::resolve(opts),
        "agy" => crate::services::google_chat::resolve(opts),
        _ => opts,
    }
}

/// [`resolve_agent_session`] for a spawn on the async path: the OpenCode and
/// Codex resolvers read stores the agent wrote, so they run under a short
/// wait, and one that does not answer means no session (a fresh start).
pub fn resolve_agent_session_bounded(opts: PtyOptions) -> PtyOptions {
    if !matches!(opts.cmd.as_str(), "opencode" | "codex") {
        return resolve_agent_session(opts);
    }
    let mut fresh = opts.clone();
    fresh.env.insert(TAB_AGENT_ENV.to_string(), opts.cmd.clone());
    crate::services::agent_sqlite::bounded(std::time::Duration::from_secs(3), move || resolve_agent_session(opts)).unwrap_or(fresh)
}

/// Vibe chooses its own session ID. Its post-agent hook records that ID under
/// Tabtivity's stable tab key, including after an in-app `/resume` or `/branch`.
/// Old tabs without a hook record retain their project-scoped `--continue`.
fn resolve_vibe_session(opts: PtyOptions) -> PtyOptions {
    let remote = !opts.local_only && opts.project_id.as_deref()
        .is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
    if remote {
        return opts;
    }
    let home = vibe_home_for(&opts);
    if let Err(e) = register_vibe_hook_in(&home) {
        eprintln!("agent_session: register vibe hook: {e}");
    }
    let project_id = opts.project_id.clone();
    resolve_vibe_session_impl(opts, &home, |uid| {
        read_live_session_for(project_id.as_deref(), uid)
    })
}

fn vibe_home_for(opts: &PtyOptions) -> PathBuf {
    let default = crate::services::agent_home::scope_home(opts.project_id.as_deref()).join(".vibe");
    let Some(candidate) = opts.env.get("VIBE_HOME").map(PathBuf::from) else {
        return default;
    };
    // The renderer supplies env. Only Tabtivity's dedicated local-model homes may
    // select another session store; never read an arbitrary renderer path.
    if is_local_vibe_home(&candidate) {
        candidate
    } else {
        default
    }
}

fn resolve_vibe_session_impl<F>(mut opts: PtyOptions, home: &std::path::Path, live_lookup: F) -> PtyOptions
where
    F: Fn(&str) -> Option<String>,
{
    opts.env.insert(TAB_AGENT_ENV.to_string(), "vibe".to_string());
    let Some(uid) = opts.env.get(crate::app_env!("TAB_UID")) else {
        return opts;
    };
    if !is_uuid_shaped(uid) {
        return opts;
    }
    if let Some(id) = live_lookup(uid).filter(|id| vibe_session_exists(home, id)) {
        opts.args = vec!["--resume".to_string(), id];
    }
    opts
}

/// The most of a legacy Vibe session's `meta.json` read to match its id.
const VIBE_META_CAP: u64 = 16 * 1024 * 1024;

fn vibe_session_exists(home: &std::path::Path, id: &str) -> bool {
    if !is_uuid_shaped(id) {
        return false;
    }
    let sessions = home.join("logs/session");
    // Vibe 2.25 uses the unified store; older installations use timestamped
    // session folders. The metadata is read only to validate an exact ID match.
    if sessions.join("unified").join(id).join("CURRENT").is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(sessions) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        if !path.is_dir() || !entry.file_name().to_string_lossy().starts_with("session_") {
            return false;
        }
        // Agent-written: a FIFO or a link here must not hang or steer a spawn.
        // Not a small record: Vibe dumps its config, every tool schema and the
        // whole system prompt (the user's AGENTS.md included) into it.
        let Some(raw) = crate::services::home_io::read_record_capped(&path.join("meta.json"), VIBE_META_CAP) else {
            return false;
        };
        serde_json::from_str::<serde_json::Value>(&raw).ok()
            .and_then(|meta| meta.get("session_id").and_then(serde_json::Value::as_str).map(str::to_string))
            .is_some_and(|saved| saved == id)
    })
}

/// Resolve a Codex tab's session args. Unlike Claude, Codex mints its own session
/// id (no launch-time `--session-id`), so the only stable per-tab key is the
/// `TABTIVITY_TAB_UID` env var Tabtivity sets from the tab's id. The global Codex
/// `SessionStart` hook records the live session id under that key (see
/// `install_session_start_hook`); here we read it and, when Codex still has that
/// conversation, launch `codex resume <live-id>`. With no record yet (first
/// launch, or the hook not trusted), we leave the args untouched → a fresh Codex
/// session.
fn resolve_codex_session(opts: PtyOptions) -> PtyOptions {
    let project_id = opts.project_id.clone();
    // The scope's agent home, where the tab's Codex writes — not the user's.
    let sessions = codex_sessions_root(project_id.as_deref());
    let stores = crate::services::codex_store::state_dbs(Some(
        project_id.as_deref().unwrap_or("root"),
    ));
    resolve_codex_session_impl(opts, &sessions, &stores, |uid| {
        read_live_session_for(project_id.as_deref(), uid)
    })
}

/// Testable core of [`resolve_codex_session`].
fn resolve_codex_session_impl<F>(
    mut opts: PtyOptions,
    sessions_root: &std::path::Path,
    stores: &[PathBuf],
    live_lookup: F,
) -> PtyOptions
where
    F: Fn(&str) -> Option<String>,
{
    if opts.cmd != "codex" {
        return opts;
    }
    opts.env
        .insert(TAB_AGENT_ENV.to_string(), "codex".to_string());
    let Some(uid) = opts.env.get(crate::app_env!("TAB_UID")).cloned() else {
        return opts;
    };
    if let Some(id) = live_lookup(&uid).filter(|id| {
        codex_session_exists_in(sessions_root, stores.iter().map(PathBuf::as_path), id)
    })
    {
        opts.args = vec!["resume".to_string(), id];
    }
    opts
}

/// Whether Codex still has the conversation `uuid`, and can therefore resume it.
///
/// Two stores, because Codex moved house mid-flight and both shapes are in the
/// field:
///
/// - the **rollout log** at
///   `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`, which is
///   what older releases wrote and Codex 0.160.1 writes again;
/// - the **thread store** `~/.codex/state_<n>.sqlite`, where 0.153.4 could keep
///   a thread without writing its named rollout. An archived row overrides a
///   retained rollout: that conversation must not be resumed automatically.
///
/// Asking only the first one is how Codex resume died silently: the hook kept
/// recording live thread ids, the walk kept finding no file for them, and every
/// Codex tab relaunched as a brand-new session in an untrusted folder — which
/// is the folder-trust prompt the user saw on each restart.
///
/// `store` is the thread store, resolved by
/// [`crate::services::codex_store::state_db`] — passed in rather than looked up
/// here because locating it costs a `read_dir` and the binder asks this once per
/// tab per tick.
pub(crate) fn codex_session_exists(
    root: &std::path::Path,
    store: Option<&std::path::Path>,
    uuid: &str,
) -> bool {
    codex_session_exists_in(root, store, uuid)
}

fn codex_session_exists_in<'a>(
    root: &std::path::Path,
    stores: impl IntoIterator<Item = &'a std::path::Path>,
    uuid: &str,
) -> bool {
    let mut live_in_store = false;
    for db in stores {
        match crate::services::codex_store::thread_archived(db, uuid) {
            Some(true) => return false,
            Some(false) => live_in_store = true,
            None => {}
        }
    }
    live_in_store || codex_session_log(root, uuid).is_some()
}

/// The rollout log behind [`codex_session_exists`], when there is one.
pub(crate) fn codex_session_log(root: &std::path::Path, uuid: &str) -> Option<PathBuf> {
    fn walk(dir: &std::path::Path, uuid: &str, depth: u8) -> Option<PathBuf> {
        if depth > 5 {
            return None;
        }
        for entry in std::fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = walk(&path, uuid, depth + 1) {
                    return Some(found);
                }
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.ends_with(".jsonl") && name.contains(uuid) {
                    return Some(path);
                }
            }
        }
        None
    }
    walk(root, uuid, 0)
}

/// Resolve a Claude tab's session args at spawn so it (re)attaches to the right
/// conversation, including after a `/clear`.
///
/// The tab is launched with a deterministic *launch id* (`--session-id <uuid>`),
/// which doubles as the tab's stable key. We:
///
/// 1. Expose that launch id to the global `SessionStart` hook via the
///    `TABTIVITY_TAB_UID` env var, so the hook can record this tab's *live* session
///    id. The live id diverges from the launch id after `/clear` (Claude rolls
///    onto a fresh session with no recorded back-link), so this is the only
///    reliable way to follow it.
/// 2. Pick the resume target: the hook-recorded live id when it has a persisted
///    log, else the launch id when *it* has one.
/// 3. Emit `--resume <target>` only when a session log actually exists; Claude
///    writes the log lazily (first message), so a never-used tab has none — in
///    that case keep `--session-id <launch>` and start fresh under the reserved
///    id (nothing is lost, and `--resume` would exit with "No conversation
///    found"). This also safely downgrades a restore that asked for `--resume`.
fn resolve_claude_session(opts: PtyOptions) -> PtyOptions {
    let project_id = opts.project_id.clone();
    // Every local tab's Claude lives in the scope's agent home
    // (`services::agent_home`), so that is where its logs are. Reusing a
    // `--session-id` Claude already has a log for is a hard error ("already
    // in use"), so a missed log is a dead tab, not a fresh one.
    let roots = claude_projects_roots(project_id.as_deref());
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    resolve_claude_session_in(
        opts,
        &root_refs,
        |uid| read_live_session_for(project_id.as_deref(), uid),
        |uid| read_live_mode_for(project_id.as_deref(), uid),
    )
}

/// Testable core of [`resolve_claude_session`] against a single Claude session
/// root — see [`resolve_claude_session_in`] for the several-roots form.
#[cfg(test)]
fn resolve_claude_session_impl<F, M>(
    opts: PtyOptions,
    projects: &std::path::Path,
    live_lookup: F,
    mode_lookup: M,
) -> PtyOptions
where
    F: Fn(&str) -> Option<String>,
    M: Fn(&str) -> Option<String>,
{
    resolve_claude_session_in(opts, &[projects], live_lookup, mode_lookup)
}

/// Env var naming the agent a tab runs, set beside `TABTIVITY_TAB_UID` so the hook
/// script knows which continuity rule applies to a record — see
/// [`hook_script_body`]. Every process under the tab inherits both.
pub const TAB_AGENT_ENV: &str = crate::app_env!("TAB_AGENT");

/// [`resolve_claude_session_impl`] over several session roots: a log found under
/// any of them counts. `live_lookup` maps a launch id → recorded live id (if
/// any), and `mode_lookup` maps a launch id → the last hook-recorded permission
/// mode.
fn resolve_claude_session_in<F, M>(
    mut opts: PtyOptions,
    roots: &[&std::path::Path],
    live_lookup: F,
    mode_lookup: M,
) -> PtyOptions
where
    F: Fn(&str) -> Option<String>,
    M: Fn(&str) -> Option<String>,
{
    if opts.cmd != "claude" {
        return opts;
    }
    // Set unconditionally: a persisted layout's `env` is not where this comes
    // from, and a wrong marker would relax the hook's guard for this tab.
    opts.env
        .insert(TAB_AGENT_ENV.to_string(), "claude".to_string());
    let session_exists = |id: &str| roots.iter().any(|root| claude_session_exists(root, id));
    let Some(i) = opts
        .args
        .iter()
        .position(|a| a == "--session-id" || a == "--resume")
    else {
        return opts;
    };
    if i + 1 >= opts.args.len() {
        return opts;
    }
    let launch_id = opts.args[i + 1].clone();

    // The stable per-tab key is the launch id; expose it to the SessionStart hook.
    opts.env
        .entry(crate::app_env!("TAB_UID").to_string())
        .or_insert_with(|| launch_id.clone());

    // Prefer the hook-recorded live id (survives /clear); fall back to launch id.
    let resume_target = live_lookup(&launch_id)
        .filter(|id| session_exists(id))
        .or_else(|| session_exists(&launch_id).then(|| launch_id.clone()));

    match resume_target {
        Some(id) => {
            opts.args[i] = "--resume".to_string();
            opts.args[i + 1] = id;
            // Claude restores the mode a session was *launched* with, but NOT a
            // mode the user cycled to with shift+tab mid-session (the cycle fires
            // no hook event; verified empirically against 2.1.251) — so a
            // respawned tab used to come back in the wrong mode. Re-apply the
            // last mode the Stop hook recorded. This is now the ONLY thing that
            // carries a permission mode across a respawn — Tabtivity launches the
            // plain command and has no mode toggle of its own — so what it
            // preserves is exactly what the user set inside the CLI. An explicit
            // mode flag already on the args (a custom agent's own flag) outranks
            // the record, and anything outside the known mode set is discarded —
            // the record is hook-parsed JSON becoming a CLI argument.
            let has_mode_flag = opts
                .args
                .iter()
                .any(|a| a == "--permission-mode" || a == "--dangerously-skip-permissions");
            if !has_mode_flag {
                if let Some(mode) = mode_lookup(&launch_id).filter(|m| is_permission_mode(m)) {
                    opts.args.push("--permission-mode".to_string());
                    opts.args.push(mode);
                }
            }
        }
        None => {
            // No resumable log yet → (re)create under the launch id.
            opts.args[i] = "--session-id".to_string();
            opts.args[i + 1] = launch_id;
        }
    }
    opts
}

/// Where a scope's Claude keeps its transcripts: `<scope home>/.claude/projects`.
pub(crate) fn claude_projects_roots(project_id: Option<&str>) -> Vec<PathBuf> {
    let mut roots = vec![crate::services::agent_home::scope_home(project_id)
        .join(".claude")
        .join("projects")];
    // The chat assistant's local-Claude chats run in the scope's local-model
    // home (`assistant.local`), not its cloud one; a chat's uuid is in one of
    // the two (the phone's Focus view reads the transcript from here).
    if project_id.is_some_and(|id| crate::storage::project_key(id.trim()).eq_ignore_ascii_case(crate::storage::ASSISTANT_SCOPE)) {
        roots.push(crate::services::agent_home::local_model_home(project_id).join(".claude").join("projects"));
    }
    roots
}

/// Where a scope's Codex keeps its rollouts: `<scope home>/.codex/sessions`.
pub(crate) fn codex_sessions_root(project_id: Option<&str>) -> PathBuf {
    crate::services::agent_home::scope_home(project_id)
        .join(".codex")
        .join("sessions")
}

/// Whether Claude has a persisted session log for `uuid` under `projects`
/// (`~/.claude/projects`). Claude stores sessions at
/// `<projects>/<encoded-cwd>/<uuid>.jsonl`; since uuids are globally unique we
/// scan the project dirs for `<uuid>.jsonl` rather than re-deriving the cwd
/// encoding.
pub(crate) fn claude_session_exists(projects: &std::path::Path, uuid: &str) -> bool {
    claude_session_log(projects, uuid).is_some()
}

/// The session log behind [`claude_session_exists`], when there is one.
fn claude_session_log(projects: &std::path::Path, uuid: &str) -> Option<PathBuf> {
    let file = format!("{uuid}.jsonl");
    // By handle from the home: a slug folder the agent linked elsewhere is
    // another scope's conversations, not this one's.
    let dir = crate::services::home_io::HomeDir::open_below(projects, 2)?;
    dir.names().into_iter().find_map(|name| {
        dir.open_subdir(&name)?.file(&file)?.is_file().then(|| projects.join(&name).join(&file))
    })
}

// ── Which model a tab is answering with ──────────────────────────────────────
//
// Neither CLI tells its hooks which model it runs (the hook payload carries a
// session id and a permission mode, nothing more), and asking the agent would
// spend a turn. What both keep is a transcript in which every answer names the
// model that produced it, so the tag Tabtivity shows beside a tab is *the model
// this session last answered with* — read from the tail of that file, never
// inferred from a flag Tabtivity did not pass. A tab whose agent keeps no readable
// transcript (Gemini, a custom command) gets no tag rather than a guessed one.
//
// Codex 0.153.4 stopped writing that transcript as a file and keeps its threads
// in SQLite instead, so its answer now comes from
// [`crate::services::codex_store`] — the store's own `model` column, the same
// fact by the only route left. Older releases still get the tail read.

/// How much of a transcript's tail is read for the model. A Claude turn with a
/// large tool result can run past 100 KB on one line, so this is generous; the
/// read is a seek and one buffer, so it is still free.
const MODEL_TAIL_BYTES: u64 = 512 * 1024;

/// Longest model name accepted from a transcript. The value becomes UI text on
/// the desktop and on the phone, and the file is written by the agent.
const MAX_MODEL_NAME: usize = 64;

/// Which transcript dialect [`last_model_in_transcript`] reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscriptKind {
    /// `~/.claude/projects/<cwd>/<sid>.jsonl`: an `assistant` record's
    /// `message.model`.
    Claude,
    /// `~/.codex/sessions/…/rollout-…-<sid>.jsonl`: a `turn_context` record's
    /// `payload.model`. Codex 0.153.4 stopped writing these files —
    /// [`crate::services::codex_store`] reads the model from its database
    /// instead, and this stays for the releases that still do.
    Codex,
    /// `<home>/.copilot/session-state/<sid>/events.jsonl`: `assistant.message`
    /// and `session.model_change` records name the model
    /// (`services::copilot_session`).
    Copilot,
}

/// The model the tab launched as `cmd` with launch id `launch_id` last answered
/// with, or `None` when there is no transcript, no answer in it yet, or the
/// agent is one whose transcript Tabtivity does not read.
pub fn agent_session_model(cmd: &str, project_id: Option<&str>, launch_id: &str) -> Option<String> {
    read_agent_transcript(
        cmd,
        project_id,
        launch_id,
        last_model_in_transcript,
        crate::services::codex_store::thread_model,
    )
}

/// The last prompt the tab launched as `cmd` with launch id `launch_id` was
/// given — however it got there: typed into the terminal, pasted, sent from
/// the Agents view's composer, or delivered by a schedule. Read from the same
/// transcript as the model tag, because the terminal is the one place Tabtivity
/// cannot see a prompt go by (keystrokes reach the PTY, the TUI's input box
/// edits them, and only the agent knows what was finally submitted), while
/// the agent writes every submitted prompt to its transcript before it starts
/// answering. Cleaned to one line of bounded printable text
/// ([`clean_prompt_text`]).
///
/// `None` when there is no transcript, no prompt in it, or the agent keeps
/// none Tabtivity reads. Codex 0.153.4's thread store records no messages at all
/// (only the thread's first one), so a Codex tab on that release has no answer
/// here — nothing is guessed from the tab's output instead.
///
/// Never read off the launch id's file once a live id is recorded: right after
/// a `/clear` that file is the cleared conversation, and its prompts are not
/// what this session was asked.
pub fn agent_session_last_prompt(
    cmd: &str,
    project_id: Option<&str>,
    launch_id: &str,
) -> Option<String> {
    read_agent_transcript_from(cmd, project_id, launch_id, false, last_prompt_in_transcript, |_, _| None)
}

/// Whether the tab launched as `cmd` with launch id `launch_id` is pursuing a
/// `/goal`, from the session's own record rather than its screen — the one
/// source that reads the same whatever the footer looks like: Claude's latest
/// `goal_status` in its transcript, Codex's thread row in its goal store.
/// `None` when the CLI keeps no such record or it cannot be read; the caller
/// then goes by the footer.
pub fn agent_session_goal(cmd: &str, project_id: Option<&str>, launch_id: &str) -> Option<bool> {
    match cmd {
        "claude" => read_agent_transcript_from(cmd, project_id, launch_id, false, |path, _| claude_goal_in_transcript(path), |_, _| None),
        "codex" => {
            if !is_uuid_shaped(launch_id) {
                return None;
            }
            let thread = read_live_session_for(project_id, launch_id)?;
            let db = crate::services::codex_store::goals_db_for(Some(project_id.unwrap_or("root")))?;
            crate::services::codex_store::thread_goal_active(&db, &thread)
        }
        _ => None,
    }
}

/// Claude's goal state in the transcript at `path`: its last word on a goal.
/// `/goal` writes a `goal_status` attachment when it is set (`met: false`,
/// the `sentinel`), another at every check that finds it unmet, and one with
/// `met: true` — or `failed` when Claude gives up — when it ends; `/goal clear`
/// is the user's own end. `None` when the tail holds none of them.
fn claude_goal_in_transcript(path: &std::path::Path) -> Option<bool> {
    with_prompt_tail(path, |lines| lines.iter().rev().find_map(|line| claude_goal_in_record(line)))
}

fn claude_goal_in_record(line: &str) -> Option<bool> {
    if !line.contains("\"goal_status\"") && !line.contains("/goal</command-name>") {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("isSidechain").and_then(|s| s.as_bool()) == Some(true) {
        return None;
    }
    if let Some(attachment) = value.get("attachment").filter(|a| a.get("type").and_then(|t| t.as_str()) == Some("goal_status")) {
        let met = attachment.get("met").and_then(|m| m.as_bool()).unwrap_or(false);
        let failed = attachment.get("failed").and_then(|f| f.as_bool()).unwrap_or(false);
        return Some(!met && !failed);
    }
    let content = claude_command_content(&value)?;
    let args = between(content, "<command-args>", "</command-args>")?.trim();
    (content.contains("<command-name>/goal</command-name>") && args == "clear").then_some(false)
}

/// Resolve the transcript behind a tab and read one fact out of it. The
/// resolution is the same whichever fact is wanted, so it lives once:
///
/// - Claude: `~/.claude/projects/…/<id>.jsonl` (plus the containerized stage),
///   the live id (after a `/clear`) first and the launch id as the fallback —
///   the same preference the resume path has. `read_file` is tried on each in
///   turn, so a live transcript that holds no answer yet still falls back.
///   That suits a fact that outlives a `/clear` (the model); what the session
///   was *asked* does not, and reads with [`read_agent_transcript_from`]
///   without the fallback.
/// - Codex: the rollout transcript when this release still writes one, else
///   its SQLite thread store through `read_store` — the same fact by the only
///   route left since 0.153.4, for the facts that store holds.
pub(crate) fn read_agent_transcript<T>(
    cmd: &str,
    project_id: Option<&str>,
    launch_id: &str,
    read_file: impl Fn(&std::path::Path, TranscriptKind) -> Option<T>,
    read_store: impl Fn(&std::path::Path, &str) -> Option<T>,
) -> Option<T> {
    read_agent_transcript_from(cmd, project_id, launch_id, true, read_file, read_store)
}

/// [`read_agent_transcript`], choosing whether a Claude tab whose live id has
/// no file yet falls back to the launch id's. The model wants that fallback;
/// the conversation and the prompts it was given must not take it — right after a `/clear` the hook has recorded the new id but
/// Claude writes its file only with the first turn, and the launch id's file
/// is the conversation that was just cleared.
pub(crate) fn read_agent_transcript_from<T>(
    cmd: &str,
    project_id: Option<&str>,
    launch_id: &str,
    fall_back_to_launch: bool,
    read_file: impl Fn(&std::path::Path, TranscriptKind) -> Option<T>,
    read_store: impl Fn(&std::path::Path, &str) -> Option<T>,
) -> Option<T> {
    if !is_uuid_shaped(launch_id) {
        return None;
    }
    let live = read_live_session_for(project_id, launch_id);
    match cmd {
        "claude" => {
            let roots = claude_projects_roots(project_id);
            claude_transcript_ids(live, launch_id, fall_back_to_launch).iter().find_map(|id| {
                roots
                    .iter()
                    .find_map(|root| claude_session_log(root, id))
                    .and_then(|path| read_file(&path, TranscriptKind::Claude))
            })
        }
        "codex" => {
            let live = live?;
            let root = codex_sessions_root(project_id);
            codex_session_log(&root, &live)
                .and_then(|path| read_file(&path, TranscriptKind::Codex))
                .or_else(|| {
                    crate::services::codex_store::state_dbs(Some(project_id.unwrap_or("root")))
                        .iter()
                        .find_map(|db| read_store(db, &live))
                })
        }
        "copilot" => crate::services::copilot_session::tab_events(project_id, launch_id)
            .and_then(|path| read_file(&path, TranscriptKind::Copilot)),
        _ => None,
    }
}

/// The Claude session ids whose transcripts are tried, in order: the live one
/// the hook recorded, then the launch id — which is left out when a live id is
/// recorded and `fall_back_to_launch` is off (after a `/clear`, the launch id's
/// file is the cleared conversation, or an older one still after two).
fn claude_transcript_ids(live: Option<String>, launch_id: &str, fall_back_to_launch: bool) -> Vec<String> {
    let launch = (fall_back_to_launch || live.is_none()).then(|| launch_id.to_string());
    live.into_iter().chain(launch).collect()
}

/// The model named by the last answer in the transcript at `path`, reading only
/// its tail. A line cut by the tail boundary is skipped rather than parsed, and
/// a record that names no real model (Claude writes `<synthetic>` for its own
/// system turns) is skipped too, so the answer is the last *real* one.
pub fn last_model_in_transcript(path: &std::path::Path, kind: TranscriptKind) -> Option<String> {
    last_in_transcript_tail(path, |line| model_in_record(line, kind))
}

/// The last prompt the user submitted in the transcript at `path`, reading
/// only its tail — see [`agent_session_last_prompt`] for what counts as one.
pub fn last_prompt_in_transcript(path: &std::path::Path, kind: TranscriptKind) -> Option<String> {
    with_prompt_tail(path, |lines| lines.iter().rev().find_map(|line| prompt_in_record(line, kind)))
}

/// How far into a transcript the first prompt is looked for: a session's
/// opening records are small, but Claude's request replays and Codex's
/// instructions come before a slow first prompt.
const CHAT_HEAD_BYTES: u64 = 4 * 1024 * 1024;

/// The first prompt of the transcript at `path`, with its moment when the
/// record has one, and the last prompt in its tail (the model's window: a
/// menu row, not the chart, so no wider read) — a stored chat's row in the
/// Reader's Resume menu (`services::agent_chats`). The first prompt is `None`
/// for a session no prompt went into.
pub(crate) fn chat_prompts(
    path: &std::path::Path,
    kind: TranscriptKind,
) -> (Option<TranscriptPrompt>, Option<String>) {
    use std::io::{BufRead, Read};
    let Some(file) = crate::services::home_io::open_regular(path) else {
        return (None, None);
    };
    let mut reader = std::io::BufReader::new(file.take(CHAT_HEAD_BYTES));
    let mut line = Vec::new();
    let mut first = None;
    while first.is_none() {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        // A line the head cut short parses as nothing, which is what it holds.
        if is_replay_record(&line) || !line.ends_with(b"\n") {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&line) else { continue };
        first = timed_prompt_in_record(text, kind).or_else(|| {
            prompt_in_record(text, kind).map(|text| TranscriptPrompt { text, at: String::new() })
        });
    }
    if first.is_none() {
        return (None, None);
    }
    (first, last_in_transcript_tail(path, |line| prompt_in_record(line, kind)))
}

/// The Claude session log `<uuid>.jsonl` in the one folder `folder`, when it
/// is a regular file (the agent writes it: never a link).
pub(crate) fn claude_chat_log(folder: &std::path::Path, uuid: &str) -> Option<PathBuf> {
    if !is_uuid_shaped(uuid) {
        return None;
    }
    let name = format!("{uuid}.jsonl");
    let dir = crate::services::home_io::HomeDir::open_below(folder, 3)?;
    dir.file(&name)?.is_file().then(|| folder.join(name))
}

/// Read the last `MODEL_TAIL_BYTES` of `path` and return `pick`'s answer for
/// the *last* line it accepts.
fn last_in_transcript_tail<T>(
    path: &std::path::Path,
    pick: impl Fn(&str) -> Option<T>,
) -> Option<T> {
    with_transcript_tail(path, MODEL_TAIL_BYTES, |lines| lines.iter().rev().find_map(|line| pick(line)))
}

/// The widest tail a prompt read reaches back through. A prompt is followed by
/// its whole turn, and Codex (0.155) writes every tool result twice — the
/// output record and an `item_completed` event carrying it again — so one turn
/// of large reads pushed the prompt that started it a megabyte back, out of
/// the model's window: the phone's tab list said "nothing read" for a Codex
/// session in the middle of its work.
const PROMPT_TAIL_MAX: u64 = 16 * 1024 * 1024;

/// [`with_transcript_tail`] for the prompt reads: the model's window first,
/// then a window four times wider, while `read` finds nothing and the file
/// reaches further back — up to [`PROMPT_TAIL_MAX`]. Prompt records are
/// recognized before they are parsed (`may_be_prompt`), so a wide read costs
/// a scan, not a JSON parse per tool result.
fn with_prompt_tail<T>(path: &std::path::Path, read: impl Fn(&[&str]) -> Option<T>) -> Option<T> {
    let len = std::fs::metadata(path).ok()?.len();
    let mut tail = MODEL_TAIL_BYTES;
    loop {
        let found = with_transcript_tail(path, tail, &read);
        if found.is_some() || tail >= len || tail >= PROMPT_TAIL_MAX {
            return found;
        }
        tail = (tail * 4).min(PROMPT_TAIL_MAX);
    }
}

/// Hand `read` the whole lines of the last `tail` bytes of `path`, in file
/// order. A line cut by the tail boundary is dropped rather than parsed — it
/// would parse as garbage, or worse, as a record.
fn with_transcript_tail<T>(
    path: &std::path::Path,
    tail: u64,
    read: impl FnOnce(&[&str]) -> Option<T>,
) -> Option<T> {
    // The agent writes its transcript: never a link, a FIFO or another
    // special file.
    let mut file = crate::services::home_io::open_regular(path)?;
    let len = file.metadata().ok()?.len();
    let (text, _) = read_conversation_tail(&mut file, len, tail)?;
    let lines: Vec<&str> = text.lines().collect();
    read(&lines)
}

/// The start of every request-replay record Claude Code writes into its
/// transcripts since 2.1.300 (`api-request`, `api-request-blob`,
/// `api-request-shape`): the system prompt, tools and messages of each API
/// request, copied again. They are most of a busy session's bytes (two thirds
/// and more) and no reader here wants one.
const REPLAY_RECORD: &[u8] = br#"{"type":"api-request"#;

/// Whether a transcript line is a request-replay record ([`REPLAY_RECORD`]).
fn is_replay_record(line: &[u8]) -> bool {
    line.starts_with(REPLAY_RECORD)
}

/// How far back past `budget` a tail read scans for conversation: the replay
/// records it skips may make up all but a quarter of the file.
const REPLAY_SCAN_FACTOR: u64 = 4;
const SCAN_CHUNK: u64 = 1024 * 1024;

/// The tail of a transcript that holds `budget` bytes of conversation, with
/// the request-replay records skipped both in the count and in the text: a
/// byte window alone would hold a third of the turns it held before 2.1.300.
/// Whole lines, in file order; a line the window starts inside is dropped. The
/// flag says the window starts after the file's first byte. The scan reaches
/// back at most [`REPLAY_SCAN_FACTOR`] times `budget`.
pub(crate) fn read_conversation_tail(file: &mut std::fs::File, len: u64, budget: u64) -> Option<(String, bool)> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let start = conversation_tail_start(file, len, budget)?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut text = String::new();
    if start > 0 {
        // Whatever came before the seek point is missing from the first line.
        reader.read_until(b'\n', &mut line).ok()?;
    }
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).ok()? == 0 {
            break;
        }
        if !is_replay_record(&line) {
            text.push_str(&String::from_utf8_lossy(&line));
        }
    }
    Some((text, start > 0))
}

/// Where [`read_conversation_tail`]'s window starts: walking back line by line
/// from the end, `budget` bytes of lines that are not replay records. Without
/// replay records it is `len - budget`, the plain byte window.
fn conversation_tail_start(file: &mut std::fs::File, len: u64, budget: u64) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};
    let floor = len.saturating_sub(budget.saturating_mul(REPLAY_SCAN_FACTOR));
    let mut counted = 0u64;
    // End of the line being walked back over; its newline is found next.
    let mut line_end = len;
    let mut pos = len;
    // The first bytes after `pos`: how a line starting in this chunk goes on.
    let mut head: Vec<u8> = Vec::new();
    let mut chunk = Vec::new();
    while pos > floor {
        let lo = pos.saturating_sub(SCAN_CHUNK).max(floor);
        chunk.resize((pos - lo) as usize, 0);
        file.seek(SeekFrom::Start(lo)).ok()?;
        file.read_exact(&mut chunk).ok()?;
        for index in (0..chunk.len()).rev() {
            if chunk[index] != b'\n' {
                continue;
            }
            let newline = lo + index as u64;
            let mut opening = chunk[index + 1..].iter().take(REPLAY_RECORD.len()).copied().collect::<Vec<u8>>();
            opening.extend(head.iter().take(REPLAY_RECORD.len() - opening.len()));
            if !is_replay_record(&opening) {
                // The line with its newline in front.
                let size = line_end - newline;
                if counted + size >= budget {
                    return Some(line_end - (budget - counted));
                }
                counted += size;
            }
            line_end = newline;
        }
        let mut next = chunk.iter().take(REPLAY_RECORD.len()).copied().collect::<Vec<u8>>();
        next.extend(head.iter().take(REPLAY_RECORD.len() - next.len()));
        head = next;
        pos = lo;
    }
    // The file's first line has no newline in front to be found by: the
    // window starts inside it, or takes the whole file.
    if floor == 0 && !is_replay_record(&head) && counted + line_end > budget {
        return Some(line_end - (budget - counted));
    }
    Some(floor)
}

// ── The prompts a tab was given, with their times ────────────────────────────
//
// The last prompt alone cannot say what the prompt chart needs: a message the
// user sends while the agent is still working never starts a turn of its own,
// and Claude records it as a `queued_command` attachment rather than a `user`
// record, so it is never "the last prompt" at a turn's start. The chart adopts
// from this list instead — every prompt in the tail, each with the moment the
// transcript says it went.

/// Most prompts one read returns: the tail's newest.
const MAX_RECENT_PROMPTS: usize = 20;
/// The same words recorded twice this close together are one prompt (Codex
/// writes the typed event and the model-facing message for every turn).
const SAME_PROMPT_SECS: u64 = 120;

/// One prompt out of a transcript, and when it went (the record's own ISO
/// timestamp).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TranscriptPrompt {
    pub text: String,
    pub at: String,
}

/// The newest prompts (oldest first) the tab launched as `cmd` with launch id
/// `launch_id` was given, however they were submitted. Empty when there is no
/// transcript Tabtivity reads (Codex's thread store keeps no messages), and right
/// after a `/clear` — the same no-fallback rule as [`agent_session_last_prompt`].
pub fn agent_session_recent_prompts(
    cmd: &str,
    project_id: Option<&str>,
    launch_id: &str,
) -> Vec<TranscriptPrompt> {
    read_agent_transcript_from(cmd, project_id, launch_id, false, recent_prompts_in_transcript, |_, _| None)
        .unwrap_or_default()
}

/// The prompts in the tail of the transcript at `path`, oldest first, at most
/// [`MAX_RECENT_PROMPTS`]. `None` when it holds none.
pub fn recent_prompts_in_transcript(
    path: &std::path::Path,
    kind: TranscriptKind,
) -> Option<Vec<TranscriptPrompt>> {
    with_prompt_tail(path, |lines| {
        let mut prompts: Vec<TranscriptPrompt> = Vec::new();
        for line in lines {
            let Some(prompt) = timed_prompt_in_record(line, kind) else { continue };
            let repeat = prompts.last().is_some_and(|last| {
                last.text == prompt.text
                    && match (
                        crate::services::prompt_blame::iso_to_epoch(&last.at),
                        crate::services::prompt_blame::iso_to_epoch(&prompt.at),
                    ) {
                        (Some(a), Some(b)) => b.abs_diff(a) <= SAME_PROMPT_SECS,
                        _ => false,
                    }
            });
            if !repeat {
                prompts.push(prompt);
            }
        }
        let skip = prompts.len().saturating_sub(MAX_RECENT_PROMPTS);
        prompts.drain(..skip);
        (!prompts.is_empty()).then_some(prompts)
    })
}

/// A prompt record with a readable timestamp. A record without one is skipped:
/// the chart places a prompt by its time, and a guessed one would misplace it.
fn timed_prompt_in_record(line: &str, kind: TranscriptKind) -> Option<TranscriptPrompt> {
    let line = line.trim();
    if !may_be_prompt(line) {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let raw = match kind {
        TranscriptKind::Claude => {
            claude_prompt_in_record(&value).or_else(|| claude_queued_prompt(&value))?
        }
        TranscriptKind::Codex => codex_prompt_in_record(&value)?,
        TranscriptKind::Copilot => crate::services::copilot_session::prompt_in_record(&value)?,
    };
    let at = value.get("timestamp")?.as_str()?;
    crate::services::prompt_blame::iso_to_epoch(at)?;
    Some(TranscriptPrompt {
        text: clean_prompt_text(&raw)?,
        at: at.to_string(),
    })
}

/// Whether a transcript line can hold a prompt at all, checked before it is
/// parsed: every prompt record names the user as a JSON value — Claude's
/// `"type":"user"`, Codex's `"role":"user"` and `"user_message"` — or is
/// Claude's `queued_command` or Codex's `thread_goal_updated`. Most of a busy
/// transcript is tool output, and the prompt reads now reach back through
/// megabytes of it.
fn may_be_prompt(line: &str) -> bool {
    line.contains("\"user") || line.contains("queued_command") || line.contains("thread_goal_updated")
}

/// A message the user sent while Claude was working: a `queued_command`
/// attachment (`attachment.prompt`), absorbed into the running turn. Only a
/// human's plain prompt counts — a queued `!` line or a notification the CLI
/// queued for itself is not one, nor a peer session's message. The prompt is
/// a string, or blocks when an image rode along. Claude never also writes a
/// `user` record for it, so the phone's stored session reads it too.
pub(crate) fn claude_queued_prompt(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(|t| t.as_str()) != Some("attachment") {
        return None;
    }
    let attachment = value.get("attachment")?;
    if attachment.get("type").and_then(|t| t.as_str()) != Some("queued_command") {
        return None;
    }
    let mode = attachment.get("commandMode").and_then(|m| m.as_str());
    if mode.is_some_and(|mode| mode != "prompt") {
        return None;
    }
    let origin = attachment.get("origin").and_then(|o| o.get("kind")).and_then(|k| k.as_str());
    if origin.is_some_and(|origin| origin != "human") {
        return None;
    }
    let text = match attachment.get("prompt")? {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    claude_prompt_text(&text)
}

pub(crate) fn model_in_record(line: &str, kind: TranscriptKind) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let model = match kind {
        TranscriptKind::Claude => {
            if matches!(value.get("type").and_then(|t| t.as_str()), Some("user" | "system")) {
                return claude_model_switch(&value);
            }
            if value.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                return None;
            }
            value.get("message")?.get("model")?.as_str()?
        }
        TranscriptKind::Codex => {
            if value.get("type").and_then(|t| t.as_str()) != Some("turn_context") {
                return None;
            }
            value.get("payload")?.get("model")?.as_str()?
        }
        TranscriptKind::Copilot => crate::services::copilot_session::model_in_record(&value)?,
    };
    clean_model_name(model)
}

/// The model a `/model` in the session switched to, from the confirmation
/// Claude writes as a user record the moment the picker is answered
/// (`<local-command-stdout>Set model to `Fable 5.1` and saved as …`). Without
/// it the tag kept naming the old model until the next answer — a switch made
/// from the phone's Focus sheet sat stale on every list that shows the tag.
/// The line names the model by its display name, so it is folded into the
/// shape an id takes after `shortModelName` (`Opus 4.1` → `opus-4-1`, the pill
/// `claude-opus-4-1-…` gets); a name that folds to nothing useful (`Default`)
/// yields `None` and the scan falls back to the last answer.
fn claude_model_switch(value: &serde_json::Value) -> Option<String> {
    let content = claude_command_content(value)?;
    let body = content.trim_start().strip_prefix("<local-command-stdout>")?;
    let rest = body
        .strip_prefix("Set model to ")
        .or_else(|| body.strip_prefix("Kept model as "))?;
    let name = rest.split(" and saved").next()?.split("</").next()?;
    let name = crate::services::agent_usage::strip_ansi(name).replace('`', "");
    // Drop annotations: `Opus 5 (1M context) (default)` is the Opus 5 model.
    let mut plain = String::new();
    let mut depth = 0usize;
    for c in name.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => plain.push(c),
            _ => {}
        }
    }
    let slug = plain
        .split(|c: char| c.is_whitespace() || c == '.')
        .filter(|part| !part.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() || slug == "default" {
        return None;
    }
    clean_model_name(&slug)
}

/// A model name fit to show: trimmed, one line of printable text, bounded, and
/// not one of the placeholders a transcript uses for turns no model produced.
/// One definition, whether the name came from a transcript or from Codex's own
/// store ([`crate::services::codex_store`]).
pub(crate) fn clean_model_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty()
        || name.starts_with('<')
        || name.chars().count() > MAX_MODEL_NAME
        || name.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    Some(name.to_string())
}

// ── The last prompt a tab was given ──────────────────────────────────────────
//
// Both transcripts record every submitted prompt as a record of its own, so
// the last one is a tail read away — the same read the model tag makes. What
// makes this more than "the last `user` record" is that both CLIs write
// *other* things as user turns: Claude's tool results, its slash commands and
// their captured output, the system reminders it attaches to a prompt and the
// meta notes it leaves for itself; Codex's environment context and the
// `AGENTS.md` it injects. Those are what `prompt_in_record` steps over, so the
// answer is what the user said, not what the CLI told itself.

/// Longest prompt shown. The value is one line of UI text beside a tab (the
/// full prompt is always one click away in the tab itself), and the file is
/// written by the agent.
const MAX_PROMPT_CHARS: usize = 300;

/// Claude user records whose string content opens with one of these are the
/// CLI talking to itself, not a prompt. `<command-name>` and `<bash-input>`
/// are handled before this list: they *are* the user's doing.
///
/// This is checked *before* [`is_cli_written_block`], and it matches on how
/// the content *opens*, so a record that merely begins with one of these is
/// refused whole — a leading block followed by the user's words included. The
/// order stays that way deliberately: these are whole records in practice (the
/// local census of 750 transcripts holds none that opens with a block and then
/// carries a prompt), and the entries the block test cannot read at all — an
/// unterminated `<stdin>`, the bracketed `[Request interrupted` notice — have
/// no closing tag to strip back to, so reordering would turn every one of
/// them into a prompt. The wording, not the ordering, was the thing that was
/// wrong.
const CLAUDE_NOT_A_PROMPT: &[&str] = &[
    "<local-command-caveat>",
    "<local-command-stdout>",
    "<task-notification>",
    "<bash-stdout>",
    "<system-reminder>",
    "<persisted-output>",
    "<stdin>",
    "[Request interrupted",
];

/// The tags the CLIs wrap their own blocks in: Claude Code's, as the local
/// transcript census actually saw them, then the context Codex injects.
///
/// This list is the *bound* on the shape test below, and it is the whole point
/// of it. A shape alone cannot tell a CLI's private block from a user pasting
/// markup, and it guessed wrong in the direction that costs the user their
/// words: `<div>hello</div>` and `<p>a paragraph</p>` are prompts, and asking
/// an agent about markup is ordinary work. Tag *and* shape, or it is the
/// user's.
///
/// `command-name`, `command-args` and `bash-input` are deliberately absent —
/// those *are* the user's doing, and are read before any of this is asked.
const CLI_BLOCK_TAGS: &[&str] = &[
    // Claude Code.
    "system-reminder",
    "task-notification",
    "local-command-stdout",
    "local-command-stderr",
    "local-command-caveat",
    "persisted-output",
    "tool_use_error",
    "total_tokens",
    "bash-stdout",
    "bash-stderr",
    "user-prompt-submit-hook",
    "command-message",
    "stdin",
    // Codex rollouts.
    "environment_context",
    "user_instructions",
    "collaboration_mode",
    "skills_instructions",
    "permissions",
    "multi_agent_mode",
    "multi_agent_role",
    "plugins_instructions",
    "model_switch",
];

/// Whether `text` is one block a CLI wrote to itself rather than something the
/// user said: it opens with a tag on [`CLI_BLOCK_TAGS`] and closes with that
/// same tag, with nothing of the user's outside it.
fn is_cli_written_block(text: &str) -> bool {
    let text = text.trim();
    let Some(rest) = text.strip_prefix('<') else {
        return false;
    };
    let Some(end) = rest.find('>') else {
        return false;
    };
    let name = &rest[..end];
    if !CLI_BLOCK_TAGS.contains(&name) {
        return false;
    }
    text.ends_with(&format!("</{name}>"))
}

/// The user's words with the blocks the CLI appended behind them removed —
/// only ever a tag on [`CLI_BLOCK_TAGS`], so a prompt ending in markup
/// (`fix this:\n<div>…</div>`, `compare <a>one</a> and <a>two</a>`) keeps
/// every character of it. A reminder attached to a submitted prompt rides at
/// its *end*
/// (`fix the tests<system-reminder>…</system-reminder>`); checked only at the
/// start, the whole block was shown as part of what the user typed. A block
/// that starts at position 0 is left alone — there is nothing of the user's in
/// front of it, and whether that record is a prompt at all is the caller's
/// question.
fn strip_trailing_blocks(text: &str) -> &str {
    let mut text = text.trim();
    loop {
        let Some(head) = text.strip_suffix('>') else {
            return text;
        };
        let Some(close) = head.rfind("</") else {
            return text;
        };
        let name = &head[close + 2..];
        if !CLI_BLOCK_TAGS.contains(&name) {
            return text;
        }
        let Some(start) = text.rfind(&format!("<{name}>")) else {
            return text;
        };
        if start == 0 {
            return text;
        }
        text = text[..start].trim();
    }
}

/// The prompt a transcript record holds, if it is a prompt at all.
fn prompt_in_record(line: &str, kind: TranscriptKind) -> Option<String> {
    let line = line.trim();
    if !may_be_prompt(line) {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let raw = match kind {
        TranscriptKind::Claude => claude_prompt_in_record(&value)?,
        TranscriptKind::Codex => codex_prompt_in_record(&value)?,
        TranscriptKind::Copilot => crate::services::copilot_session::prompt_in_record(&value)?,
    };
    clean_prompt_text(&raw)
}

/// The string content of a Claude record the CLI writes for a slash command
/// typed at its prompt — the `<command-name>…` line and the
/// `<local-command-stdout>…` it answered with. Older releases write both as
/// `{"type":"user","message":{"content":"…"}}`; current ones (2.1.30x) as
/// `{"type":"system","subtype":"local_command","content":"…"}`. A sidechain's
/// is never the session's.
pub(crate) fn claude_command_content(value: &serde_json::Value) -> Option<&str> {
    if value.get("isSidechain").and_then(|s| s.as_bool()) == Some(true) {
        return None;
    }
    match value.get("type").and_then(|t| t.as_str())? {
        "user" => value.get("message")?.get("content")?.as_str(),
        "system" if value.get("subtype").and_then(|t| t.as_str()) == Some("local_command") => value.get("content")?.as_str(),
        _ => None,
    }
}

/// The slash command a current Claude release recorded as a `local_command`
/// system record (`/login`, `/model`, `/goal clear`), as
/// [`claude_prompt_text`] shows it. Its stdout record is not one. `/rename`
/// is left out: every Claude tab opens by typing one (the session's name).
pub(crate) fn claude_local_command(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(|t| t.as_str()) != Some("system") {
        return None;
    }
    let text = claude_command_content(value)?;
    if !text.trim_start().starts_with("<command-name>") {
        return None;
    }
    claude_prompt_text(text).filter(|command| command.split_whitespace().next() != Some("/rename"))
}

/// A Claude record: `{"type":"user","message":{"content":…}}` whose content is
/// the prompt string, or a block list carrying the prompt as `text` blocks
/// (an image paste puts the words beside the image). Records flagged `isMeta`
/// or `isSidechain` are the CLI's own, tool results are the tools', and the
/// system reminders attached to a prompt ride along as blocks of their own —
/// all stepped over.
pub(crate) fn claude_prompt_in_record(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }
    let flagged = |key: &str| value.get(key).and_then(|v| v.as_bool()) == Some(true);
    // `isCompactSummary` and `isVisibleInTranscriptOnly` appear in none of the
    // local transcripts, but the installed Claude Code binary still carries
    // `"isCompactSummary":true`, so it can still write one — and a compact
    // summary arriving as a `user` record would become one enormous bubble
    // attributed to the reader. One line makes that permanent rather than
    // true-for-now.
    if flagged("isMeta")
        || flagged("isSidechain")
        || flagged("isCompactSummary")
        || flagged("isVisibleInTranscriptOnly")
    {
        return None;
    }
    let content = value.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(blocks) => {
            // A `fn`, not a closure: rustc 1.98 no longer infers the returned
            // `&str` as borrowing from the argument in a closure.
            fn block_type(b: &serde_json::Value) -> Option<&str> {
                b.get("type").and_then(|t| t.as_str())
            }
            if blocks.iter().any(|b| block_type(b) == Some("tool_result")) {
                return None;
            }
            blocks
                .iter()
                .filter(|b| block_type(b) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .filter(|t| {
                    !CLAUDE_NOT_A_PROMPT.iter().any(|tag| t.trim_start().starts_with(*tag))
                        && !is_cli_written_block(t)
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => return None,
    };
    claude_prompt_text(&text)
}

/// The user's words in a Claude user record's text. A slash command is
/// recorded as `<command-name>/model</command-name>…<command-args>opus
/// </command-args>` and shown as `/model opus`; a `!` shell line as
/// `<bash-input>…</bash-input>`, shown with its `!`. Everything else the CLI
/// wraps in a tag of its own is not a prompt.
fn claude_prompt_text(text: &str) -> Option<String> {
    let text = text.trim();
    if let Some(name) = between(text, "<command-name>", "</command-name>") {
        let args = between(text, "<command-args>", "</command-args>").unwrap_or("");
        return Some(format!("{} {}", name.trim(), args.trim()).trim().to_string());
    }
    if let Some(cmd) = between(text, "<bash-input>", "</bash-input>") {
        return Some(format!("! {}", cmd.trim()));
    }
    if CLAUDE_NOT_A_PROMPT.iter().any(|tag| text.starts_with(*tag)) || is_cli_written_block(text) {
        return None;
    }
    let text = collapse_pasted_blocks(strip_trailing_blocks(text));
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Text pasted into Claude Code is recorded as `<pasted_content id="…">…
/// </pasted_content id="…">` beside what the user typed, and the tag led every
/// card and bubble for such a prompt (2026-09-25). Each block is shown as the
/// CLI's own composer shows it — `[Pasted text #1 +N lines]` — so the words
/// the user typed around it stay readable. Only a block that closes with its
/// own id is collapsed; anything else is left as written.
fn collapse_pasted_blocks(text: &str) -> String {
    const OPEN: &str = "<pasted_content";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut count = 0;
    while let Some(start) = rest.find(OPEN) {
        let after = &rest[start + OPEN.len()..];
        let Some(head_end) = after.find('>') else { break };
        let attrs = &after[..head_end];
        if !(attrs.is_empty() || attrs.starts_with(' ')) {
            out.push_str(&rest[..start + OPEN.len()]);
            rest = after;
            continue;
        }
        let body = &after[head_end + 1..];
        let close = format!("</pasted_content{attrs}>");
        let Some(body_end) = body.find(&close) else { break };
        count += 1;
        let lines = body[..body_end].trim_matches('\n').lines().count();
        out.push_str(&rest[..start]);
        out.push_str(&format!("[Pasted text #{count} +{lines} lines]"));
        rest = &body[body_end + close.len()..];
    }
    out.push_str(rest);
    out
}

/// A Codex rollout record: the `user_message` event is the prompt as typed;
/// the `response_item` user message is the same words as the model saw them,
/// which is also where Codex injects `<environment_context>`, `<user_instructions>`
/// and the `AGENTS.md` text — those open with a tag or a heading, and are
/// skipped. Both shapes are read, so either dialect of rollout answers.
/// A `/goal` is neither: see [`codex_goal_prompt`].
pub(crate) fn codex_prompt_in_record(value: &serde_json::Value) -> Option<String> {
    let payload = value.get("payload")?;
    let payload_type = payload.get("type").and_then(|t| t.as_str());
    match value.get("type").and_then(|t| t.as_str())? {
        "event_msg" if payload_type == Some("user_message") => {
            payload.get("message")?.as_str().map(str::to_string)
        }
        "event_msg" if payload_type == Some("thread_goal_updated") => codex_goal_prompt(payload),
        "response_item"
            if payload_type == Some("message")
                && payload.get("role").and_then(|r| r.as_str()) == Some("user") =>
        {
            let text = payload
                .get("content")?
                .as_array()?
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("input_text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                // The instructions Codex injects ride as blocks of their own
                // beside the words the user typed, exactly as Claude's
                // reminders do.
                .filter(|t| !is_cli_written_block(t))
                .collect::<Vec<_>>()
                .join("\n");
            let text = strip_trailing_blocks(text.trim());
            if text.is_empty() || text.starts_with('<') || text.starts_with('#') {
                return None;
            }
            Some(text.to_string())
        }
        _ => None,
    }
}

/// A `/goal` the user set, as they typed it. Codex (0.153+) records no user
/// message for it: the objective rides only on a `thread_goal_updated` event,
/// and every turn the goal drives — its first included — opens with a
/// `<codex_internal_context source="goal">` user message, which is Codex's
/// own and skipped. The event is also written when a goal resumes, paused or
/// across a relaunch, with the time and tokens it has used; only a goal
/// updated at the second it was created is a new one, so a resumed goal
/// does not read as the prompt again.
fn codex_goal_prompt(payload: &serde_json::Value) -> Option<String> {
    let goal = payload.get("goal")?;
    if goal.get("status").and_then(|s| s.as_str()) != Some("active") {
        return None;
    }
    let created = goal.get("createdAt").and_then(|t| t.as_i64())?;
    if goal.get("updatedAt").and_then(|t| t.as_i64()) != Some(created) {
        return None;
    }
    let objective = goal.get("objective")?.as_str()?.trim();
    (!objective.is_empty()).then(|| format!("/goal {objective}"))
}

/// The text between the first `open` and the `close` after it, if both exist.
fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

/// A prompt fit to show beside a tab: whitespace runs (line breaks included)
/// folded to one space, control characters dropped, and bounded — an ellipsis
/// marks the cut. Empty after that is no prompt.
pub(crate) fn clean_prompt_text(raw: &str) -> Option<String> {
    let folded = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    if folded.is_empty() {
        return None;
    }
    if folded.chars().count() <= MAX_PROMPT_CHARS {
        return Some(folded);
    }
    let mut cut: String = folded.chars().take(MAX_PROMPT_CHARS).collect();
    cut.push('…');
    Some(cut)
}

/// `~/.local/share/tabtivity/live_sessions/` — one file per tab (named by the
/// tab's stable launch uuid) holding that tab's current live Claude session id.
///
/// This is where **host-run** (uncontained) agents record, via the hook script's
/// baked-in path. A *containerized* agent records into the project's own
/// subdirectory ([`project_live_sessions_dir`]), which `services::sandbox` mounts
/// **at** this path inside the container — see [`read_live_session_for`].
pub fn live_sessions_dir() -> PathBuf {
    storage::state_dir().join("live_sessions")
}

/// A project's own slice of the live-session records:
/// `<state_dir>/live_sessions/<sanitized project id>/`.
///
/// The container mounts *this* directory at [`live_sessions_dir`]'s path, so the
/// read-only hook script keeps writing its one baked-in path while each project's
/// records stay physically separate on the host. With the shared root mounted into
/// every container, a contained agent could enumerate other tabs' uids and
/// overwrite one — choosing which conversation an **uncontained** agent in a
/// *different* project resumes, i.e. prompt injection with that agent's full host
/// authority.
pub fn project_live_sessions_dir(project_id: &str) -> PathBuf {
    live_sessions_dir().join(storage::project_key(project_id))
}

fn hook_script_path() -> PathBuf {
    storage::state_dir().join("hooks").join(HOOK_SCRIPT_NAME)
}

/// The `command` string Tabtivity registers in the agents' SessionStart hook config
/// (Claude `settings.json` / Codex `config.toml`). The agents run this through the
/// OS shell, so it must be runnable there: on unix the bare `#!/bin/sh` script path
/// suffices, but on Windows `cmd.exe` cannot execute that script, so we invoke the
/// PowerShell hook explicitly. `-File` makes PowerShell read the script while still
/// forwarding the hook's stdin JSON payload to it.
pub(crate) fn hook_command() -> String {
    let path = hook_script_path();
    #[cfg(windows)]
    {
        format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            path.to_string_lossy()
        )
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

/// uuid-ish guard: hex digits + dashes only, non-empty. Applied to the recorded
/// session *value*, which is whatever the agent minted.
pub fn is_uuidish(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Strict canonical-UUID shape (`8-4-4-4-12` hex). Used for the tab **key**, which
/// becomes a path component: `TABTIVITY_TAB_UID` arrives in the renderer-supplied
/// `PtyOptions.env`, so the looser [`is_uuidish`] (which happens to exclude `.`
/// and `/`, and so blocked traversal by accident rather than by design) is not the
/// check to rely on. Every real key is a `crypto.randomUUID()` / agent session id,
/// so requiring the shape costs nothing.
pub fn is_uuid_shaped(s: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = s.split('-');
    for want in groups {
        match parts.next() {
            Some(p) if p.len() == want && p.chars().all(|c| c.is_ascii_hexdigit()) => {}
            _ => return false,
        }
    }
    parts.next().is_none()
}

/// Read the live session id recorded for `uid` (the tab's stable launch id) by the
/// SessionStart hook, if any — looking in the right place for the tab's project.
///
/// Two writers record under two roots and either can be the current one, because
/// the container toggle can be flipped between spawns:
/// - a **containerized** agent writes into `<state_dir>/live_sessions/<project>/`
///   (that dir is what the container sees mounted at the canonical path);
/// - a **host-run** agent writes into `<state_dir>/live_sessions/` itself.
///
/// So both are read and the **more recently written** record wins; preferring one
/// root unconditionally would resume a stale conversation after a toggle flip.
pub fn read_live_session_for(project_id: Option<&str>, uid: &str) -> Option<String> {
    read_live_session_and_source_for(project_id, uid).map(|(id, _)| id)
}

/// Suffix of the record beside the session record that says how the current
/// session came about — `SessionStart`'s `source`: `startup`, `resume`,
/// `clear` or `compact`. Written by the hook on every start, before the id.
pub const LIVE_SOURCE_SUFFIX: &str = ".src";

/// The `source` words Claude's `SessionStart` payload can carry. Anything else
/// in the record is discarded: the file is written by a hook parsing
/// attacker-visible JSON.
fn is_session_source(s: &str) -> bool {
    matches!(s, "startup" | "resume" | "clear" | "compact")
}

/// The live session id recorded for `uid` and, beside it, how that session
/// started — same two-root, newest-wins rule as [`read_live_session_for`],
/// with the source read from the root the winning id came from. The source is
/// `None` for a record written by a hook predating it.
pub fn read_live_session_and_source_for(
    project_id: Option<&str>,
    uid: &str,
) -> Option<(String, Option<String>)> {
    let dir = live_record_dir(project_id, uid)?;
    let id = read_live_session_in(&dir, uid)?;
    Some((id, read_live_source_in(&dir, uid)))
}

/// The root holding `uid`'s current session record: of the shared root and the
/// project's own slice, the one whose record was written last (see
/// [`read_live_session_for`]).
pub(crate) fn live_record_dir(project_id: Option<&str>, uid: &str) -> Option<PathBuf> {
    let root = live_sessions_dir();
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut consider = |dir: &std::path::Path| {
        if read_live_session_in(dir, uid).is_some() {
            let stamp = std::fs::metadata(dir.join(uid))
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(t, _)| stamp >= *t) {
                best = Some((stamp, dir.to_path_buf()));
            }
        }
    };
    consider(&root);
    if let Some(pid) = project_id {
        consider(&project_live_sessions_dir(pid));
    }
    best.map(|(_, dir)| dir)
}

/// Suffix of the record the hook writes beside a tab's session record when a
/// `/clear` rolls it: the id of the conversation that clear ended. Written
/// before the source and the new id, so a reader that sees `clear` sees it.
pub const LIVE_CLEARED_SUFFIX: &str = ".prev";

/// The Claude conversation the tab's last `/clear` ended, while taking it back
/// is still an undo: the current session is the one that clear started (the
/// source beside the winning record says `clear` — the undo's own `/resume`, or
/// any later start, moves it on), and the cleared conversation's transcript is
/// on disk to resume.
pub fn cleared_session_for(project_id: Option<&str>, uid: &str) -> Option<String> {
    let dir = live_record_dir(project_id, uid)?;
    let roots = claude_projects_roots(project_id);
    cleared_session_in(&dir, uid, |id| roots.iter().any(|root| claude_session_exists(root, id)))
}

/// How the window takes back a tab's last `/clear`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UndoClearPlan {
    /// Type this into the running session (Claude's `/resume <id>`).
    Type { command: String },
    /// Relaunch the tab the way a restart of Tabtivity does: its resume resolves
    /// through the record, which now names the cleared conversation.
    Relaunch,
}

/// The undo for `agent`'s tab keyed `uid`, or `None` when there is nothing to
/// take back. Claude resumes in-session by id. Codex's in-session `/resume` is a
/// picker, so its record is pointed back at the conversation the clear ended
/// (when the clear moved it at all — a Codex that reports no id for the new
/// chat before its first prompt leaves the record where it was) and the tab is
/// relaunched onto it, as `resolve_codex_session` does at every spawn. Every
/// other resumable agent is relaunched by the window on its own resume flag,
/// with nothing to prepare here.
pub fn undo_clear_plan(agent: &str, project_id: Option<&str>, uid: &str) -> Option<UndoClearPlan> {
    match agent {
        "claude" => cleared_session_for(project_id, uid)
            .map(|id| UndoClearPlan::Type { command: format!("/resume {id}") }),
        "codex" => {
            let roots = [
                paths::home_dir().join(".codex").join("sessions"),
                codex_sessions_root(project_id),
            ];
            let stores = crate::services::codex_store::state_dbs(Some(project_id.unwrap_or("root")));
            let exists = |id: &str| {
                roots.iter().any(|root| {
                    codex_session_exists_in(root, stores.iter().map(PathBuf::as_path), id)
                })
            };
            if let Some(dir) = live_record_dir(project_id, uid) {
                if let Some(cleared) = cleared_session_in(&dir, uid, exists) {
                    restore_cleared_in(&dir, uid, &cleared).ok()?;
                }
            }
            Some(UndoClearPlan::Relaunch)
        }
        _ => None,
    }
}

/// Point `uid`'s record back at `cleared` and call its start a resume, so the
/// relaunch resumes that conversation and no second undo is offered for it.
fn restore_cleared_in(dir: &std::path::Path, uid: &str, cleared: &str) -> std::io::Result<()> {
    write_live_record(dir, &format!("{uid}{LIVE_SOURCE_SUFFIX}"), "resume")?;
    write_live_session_in(dir, uid, cleared)
}

/// How the window takes the tab keyed `uid` onto `chat`, an earlier
/// conversation of its folder picked in the Reader's Resume menu
/// (`services::agent_chats`, which has checked that `chat` is one): the undo's
/// two ways. Claude types `/resume <chat>` into the running session; Codex has
/// its record pointed at `chat` — in the root that holds it, else the scope's
/// own — and is relaunched onto it. OpenCode and Antigravity have their
/// record pointed at `chat` the same way and are relaunched: OpenCode's spawn
/// turns it into `--session <chat>` (`opencode_session::resolve`),
/// Antigravity's into `--conversation <chat>` (`google_chat::resolve`).
/// Copilot's record is pointed at `chat` and the tab relaunched too; its spawn
/// pins `--session-id <chat>` (`copilot_session::resolve`).
/// `None` for any other agent, or a `chat` that is no id of its CLI's.
pub fn resume_chat_plan(agent: &str, project_id: Option<&str>, uid: &str, chat: &str) -> Option<UndoClearPlan> {
    if !is_uuid_shaped(uid) {
        return None;
    }
    let record_dir = || {
        live_record_dir(project_id, uid).unwrap_or_else(|| match project_id {
            Some(pid) => project_live_sessions_dir(pid),
            None => live_sessions_dir(),
        })
    };
    match agent {
        "opencode" if crate::services::opencode_session::is_session_id(chat) => {
            crate::services::opencode_session::record_session_in(&record_dir(), uid, chat).ok()?;
            Some(UndoClearPlan::Relaunch)
        }
        _ if !is_uuid_shaped(chat) => None,
        "claude" => Some(UndoClearPlan::Type { command: format!("/resume {chat}") }),
        "codex" => {
            restore_cleared_in(&record_dir(), uid, chat).ok()?;
            Some(UndoClearPlan::Relaunch)
        }
        "agy" | "copilot" => {
            write_live_session_in(&record_dir(), uid, chat).ok()?;
            Some(UndoClearPlan::Relaunch)
        }
        _ => None,
    }
}

/// Testable core of [`cleared_session_for`] against the record's directory.
fn cleared_session_in(
    dir: &std::path::Path,
    uid: &str,
    session_exists: impl Fn(&str) -> bool,
) -> Option<String> {
    let live = read_live_session_in(dir, uid)?;
    if read_live_source_in(dir, uid).as_deref() != Some("clear") {
        return None;
    }
    // Same guard as the id record: the hook wrote it from agent-visible JSON.
    let raw = crate::services::home_io::read_record(&dir.join(format!("{uid}{LIVE_CLEARED_SUFFIX}")))?;
    let cleared = raw.trim().to_string();
    (is_uuidish(&cleared) && cleared != live && session_exists(&cleared)).then_some(cleared)
}

/// The `SessionStart` source recorded beside `uid`'s session record in `dir`.
pub fn read_live_source_in(dir: &std::path::Path, uid: &str) -> Option<String> {
    if !is_uuid_shaped(uid) {
        return None;
    }
    let raw = crate::services::home_io::read_record(&dir.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")))?;
    let word = raw.trim().to_string();
    is_session_source(&word).then_some(word)
}

/// Suffix of the record a resume's `SessionStart` leaves beside the session
/// record: what that start's first request will cost, as Claude Code 2.1.30x
/// reports it in the payload — `<seconds idle> <context tokens> <cache-write
/// USD> <cache expired>`. Written before the source, cleared by any other start.
pub const LIVE_RESUME_SUFFIX: &str = ".resume";

/// What resuming a conversation costs the next request (see
/// [`LIVE_RESUME_SUFFIX`]). Figures are Claude's own estimates; Tabtivity prices
/// nothing here.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCost {
    /// Seconds between the conversation's last response and this resume.
    pub seconds_idle: u64,
    /// Tokens the first request carries.
    pub context_tokens: u64,
    /// Claude's estimate of writing those tokens to the prompt cache again, USD.
    pub cache_write_usd: f64,
    /// The idle time outlasted the cache's lifetime: the first request re-caches.
    pub cache_expired: bool,
}

/// One `.resume` record. The hook wrote it from agent-visible JSON, so every
/// field is bounded and anything else is dropped rather than shown.
fn parse_resume_record(raw: &str) -> Option<ResumeCost> {
    let mut fields = raw.split_whitespace();
    let seconds_idle = fields.next()?.parse::<u64>().ok()?;
    let context_tokens = fields.next()?.parse::<u64>().ok()?;
    let cache_write_usd = fields.next()?.parse::<f64>().ok()?;
    let cache_expired = match fields.next()? {
        "true" => true,
        "false" => false,
        _ => return None,
    };
    if fields.next().is_some()
        || context_tokens > 100_000_000
        || !(0.0..=100_000.0).contains(&cache_write_usd)
    {
        return None;
    }
    Some(ResumeCost { seconds_idle, context_tokens, cache_write_usd, cache_expired })
}

/// The resume cost recorded beside `uid`'s session record in `dir`.
pub fn read_live_resume_in(dir: &std::path::Path, uid: &str) -> Option<ResumeCost> {
    if !is_uuid_shaped(uid) {
        return None;
    }
    let raw = crate::services::home_io::read_record(&dir.join(format!("{uid}{LIVE_RESUME_SUFFIX}")))?;
    parse_resume_record(&raw)
}

/// Read the live session id recorded for `uid` from the shared (host-agent) root
/// only. Prefer [`read_live_session_for`] on any path that knows its project.
pub fn read_live_session(uid: &str) -> Option<String> {
    read_live_session_in(&live_sessions_dir(), uid)
}

/// Testable core of [`read_live_session`] against an explicit directory.
pub fn read_live_session_in(dir: &std::path::Path, uid: &str) -> Option<String> {
    if !is_uuid_shaped(uid) {
        return None;
    }
    let raw = crate::services::home_io::read_record(&dir.join(uid))?;
    let id = raw.trim().to_string();
    if is_uuidish(&id) {
        Some(id)
    } else {
        None
    }
}

/// The permission modes Claude's hook payloads report and its `--permission-mode`
/// flag accepts ("manual" is a CLI-only alias that hooks report as "default").
/// A recorded value outside this set is discarded: the record is written by a
/// hook parsing attacker-visible JSON, and the value becomes a CLI argument.
fn is_permission_mode(s: &str) -> bool {
    matches!(
        s,
        "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions"
    )
}

/// Read the last permission mode recorded for `uid` — the Stop hook writes
/// `<uid>.mode` beside the live-session record. Same two-root, newest-wins logic
/// as [`read_live_session_for`], for the same container-toggle reason.
pub fn read_live_mode_for(project_id: Option<&str>, uid: &str) -> Option<String> {
    let root = live_sessions_dir();
    let mut best: Option<(std::time::SystemTime, String)> = None;
    let mut consider = |dir: &std::path::Path| {
        if let Some(mode) = read_live_mode_in(dir, uid) {
            let stamp = std::fs::metadata(dir.join(format!("{uid}.mode")))
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(t, _)| stamp >= *t) {
                best = Some((stamp, mode));
            }
        }
    };
    consider(&root);
    if let Some(pid) = project_id {
        consider(&project_live_sessions_dir(pid));
    }
    best.map(|(_, m)| m)
}

/// Testable core of [`read_live_mode_for`] against an explicit directory.
fn read_live_mode_in(dir: &std::path::Path, uid: &str) -> Option<String> {
    if !is_uuid_shaped(uid) {
        return None;
    }
    let raw = crate::services::home_io::read_record(&dir.join(format!("{uid}.mode")))?;
    let mode = raw.trim().to_string();
    if is_permission_mode(&mode) {
        Some(mode)
    } else {
        None
    }
}

/// Record `id` as the live session for `uid` — the same file, in the same
/// format, that the SessionStart hook writes. This is what lets
/// [`crate::services::codex_bind`] act as a drop-in stand-in for an untrusted
/// Codex hook without touching the resolve path.
pub fn write_live_session(uid: &str, id: &str) -> std::io::Result<()> {
    write_live_session_in(&live_sessions_dir(), uid, id)
}

/// Testable core of [`write_live_session`]. The uuid-ish guard on both keys is
/// path-traversal defense (`uid` becomes a filename). Writes via a temp file +
/// rename so a hook writing the same key concurrently can never observe a torn
/// value.
pub fn write_live_session_in(dir: &std::path::Path, uid: &str, id: &str) -> std::io::Result<()> {
    if !is_uuid_shaped(uid) || !is_uuidish(id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "live-session keys must be uuid-ish",
        ));
    }
    write_live_record(dir, uid, id)
}

/// Write `<dir>/<name>` in a live-session folder. A project's slice is mounted
/// read-write into its fence and container, so the agent can plant a link at
/// the name or at a predictable temporary beside it: the write goes through a
/// handle on `dir` (`home_io`), an exclusive temporary renamed into place,
/// which replaces such a link instead of writing through it.
pub(crate) fn write_live_record(dir: &std::path::Path, name: &str, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    crate::services::home_io::HomeFile::open_below(&dir.join(name), 1)
        .ok_or_else(|| std::io::Error::other("the live-session folder is not a plain folder"))?
        .write(text.as_bytes())
}

// ── Codex hook trust state ──────────────────────────────────────────────────

/// What Tabtivity's Codex `SessionStart` hook is actually doing right now.
///
/// Codex gates *user-level* hooks behind a one-time trust approval (`/hooks`
/// inside Codex), recording the verdict in a `[hooks.state."…"]` table. An
/// untrusted or disabled hook simply never runs — silently — which is why Codex
/// tabs used to restore into a blank conversation: no live id was ever recorded,
/// so [`resolve_codex_session`] had nothing to resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexHookState {
    /// No `~/.codex` — Codex isn't in use, so there is nothing to report.
    NoCodex,
    /// Codex is in use but our hook isn't in its config (registration failed).
    NotRegistered,
    /// Registered, but Codex has no trust verdict for it yet → it never runs.
    Untrusted,
    /// Registered and known to Codex, but explicitly `enabled = false`.
    Disabled,
    /// Registered and trusted → the precise resume path is live.
    Enabled,
}

/// Classify Tabtivity's hook across the Tabtivity-owned agent homes: the least
/// trusted state any home that has run Codex is in (a `sessions/` dir), since
/// Codex asks for the trust approval per config file. `NoCodex` when no home
/// has run it yet.
pub fn codex_hook_state() -> CodexHookState {
    let mut worst: Option<CodexHookState> = None;
    for home in crate::services::agent_home::existing_homes_in(&storage::state_dir()) {
        if !home.join(".codex").join("sessions").is_dir() {
            continue;
        }
        let state = codex_hook_state_of_home(&home);
        let rank = |s: CodexHookState| match s {
            CodexHookState::Enabled => 0,
            CodexHookState::NoCodex => 1,
            CodexHookState::Disabled => 2,
            CodexHookState::NotRegistered => 3,
            CodexHookState::Untrusted => 4,
        };
        if worst.is_none_or(|w| rank(state) > rank(w)) {
            worst = Some(state);
        }
    }
    worst.unwrap_or(CodexHookState::NoCodex)
}

/// Tabtivity's hook as the Codex of one agent home sees it.
fn codex_hook_state_of_home(home: &std::path::Path) -> CodexHookState {
    let config = home.join(".codex").join("config.toml");
    // The agent can rewrite its own config: never a FIFO or a link.
    let src = crate::services::home_io::open_regular(&config)
        .and_then(|f| std::io::read_to_string(f).ok())
        .unwrap_or_default();
    codex_hook_state_in(&src, &config.to_string_lossy(), &hook_command())
}

/// Testable core of [`codex_hook_state`].
///
/// A line scanner, not a TOML parse — deliberately, for the same reason
/// [`register_codex_hook_in`] text-appends: taking a `toml` dependency just to
/// read two keys isn't worth it, and the shapes involved are fixed.
///
/// Codex keys its trust verdicts by *position*: `<config path>:session_start:
/// <group>:<hook>`, where the indices count `[[hooks.SessionStart]]` tables and
/// the `[[hooks.SessionStart.hooks]]` tables within each. So we find our hook by
/// its `command`, note where it sits, and look the verdict up under that key.
pub fn codex_hook_state_in(src: &str, config_path: &str, cmd: &str) -> CodexHookState {
    let mut group: i64 = -1;
    let mut hook: i64 = -1;
    let mut in_hook_table = false;
    let mut ours: Option<(i64, i64)> = None;
    let mut state_key: Option<String> = None;
    let mut verdicts: std::collections::HashMap<String, bool> = std::collections::HashMap::new();

    for raw in src.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_hook_table = false;
            state_key = None;
            if line.starts_with("[[hooks.SessionStart]]") {
                group += 1;
                hook = -1;
            } else if line.starts_with("[[hooks.SessionStart.hooks]]") {
                hook += 1;
                in_hook_table = true;
            } else if let Some(key) = toml_state_table_key(line) {
                state_key = Some(key);
            }
            continue;
        }
        if in_hook_table {
            if toml_value(line, "command").as_deref() == Some(cmd) {
                ours = Some((group.max(0), hook.max(0)));
            }
        } else if let Some(key) = state_key.as_ref() {
            if let Some(v) = toml_value(line, "enabled") {
                verdicts.insert(key.clone(), v == "true");
            } else if toml_value(line, "trusted_hash").is_some() {
                // Codex (0.15x) records a trusted, enabled hook as its hash
                // alone — `enabled` is written only to switch it off.
                verdicts.entry(key.clone()).or_insert(true);
            }
        }
    }

    let Some((g, h)) = ours else {
        return CodexHookState::NotRegistered;
    };
    let suffix = format!(":session_start:{g}:{h}");
    let verdict = verdicts
        .get(&format!("{config_path}{suffix}"))
        // Fall back to any entry at our position: Codex builds the key from the
        // config path *it* resolved, which can differ from ours in spelling (a
        // symlinked `$CODEX_HOME`, a `/private` prefix on macOS).
        .or_else(|| {
            verdicts
                .iter()
                .find(|(k, _)| k.ends_with(&suffix))
                .map(|(_, v)| v)
        });
    match verdict {
        Some(true) => CodexHookState::Enabled,
        Some(false) => CodexHookState::Disabled,
        None => CodexHookState::Untrusted,
    }
}

/// `[hooks.state."<key>"]` → `<key>`. Any other table header → `None`.
fn toml_state_table_key(header: &str) -> Option<String> {
    let inner = header
        .strip_prefix("[hooks.state.")?
        .strip_suffix(']')?
        .trim();
    let unquoted = inner
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(inner);
    Some(unquoted.to_string())
}

/// `key = <value>` → the value, unquoted. `None` when the line isn't `key`'s.
fn toml_value(line: &str, key: &str) -> Option<String> {
    let (lhs, rhs) = line.split_once('=')?;
    if lhs.trim() != key {
        return None;
    }
    let v = rhs.trim();
    let unquoted = v
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .or_else(|| v.strip_prefix('"').and_then(|s| s.strip_suffix('"')))
        .unwrap_or(v);
    Some(unquoted.to_string())
}

/// Whether the hook-free rollout binder ([`crate::services::codex_bind`]) should
/// run for a Codex tab. It is the *fallback*: when the hook is trusted it is
/// strictly more precise (it fires on `/clear` immediately and can't confuse two
/// tabs sharing a cwd), so we stay out of its way. Decided by the tab's own
/// scope home, where Codex keeps the trust verdict: a guessing binder beside a
/// live hook hands one tab's fresh `/clear` rollout to a sibling in the same
/// folder, since the hook records it only at the first prompt after the clear.
pub fn codex_binder_enabled(scope_id: Option<&str>) -> bool {
    codex_hook_state_of_home(&crate::services::agent_home::scope_home(scope_id)) != CodexHookState::Enabled
}

/// Trust Tabtivity's own Codex hooks in every agent home that holds a Codex
/// config, the way Codex's `/hooks` "trust" would: a `trusted_hash` under each
/// hook's `[hooks.state."…"]` table, and a hook switched off is switched back
/// on. Codex asks for that approval per config file and every scope has its
/// own, so trusting once in one tab left every other home "not trusted".
/// Only hooks whose `command` is [`hook_command`] are touched. Returns the
/// state afterwards, as [`codex_hook_state`] reads it.
pub fn trust_codex_hooks() -> CodexHookState {
    let cmd = hook_command();
    for home in crate::services::agent_home::existing_homes_in(&storage::state_dir()) {
        // The agent can rewrite its own config: never a link, never a FIFO.
        let Some(config) = HomeFile::open_existing(&home, ".codex/config.toml") else {
            continue;
        };
        if !config.is_file() {
            continue;
        }
        let Some(bytes) = config.read() else { continue };
        let src = String::from_utf8_lossy(&bytes);
        if let Some(out) = trust_codex_hooks_in(&src, &codex_config_key_paths(&home), &cmd) {
            if let Err(e) = config.write(out.as_bytes()) {
                eprintln!("agent_session: trust codex hooks in {}: {e}", home.display());
            }
        }
    }
    codex_hook_state()
}

/// The spellings Codex may give one home's `config.toml` in its trust keys:
/// the path itself (the unfenced host session, macOS), and on Linux the user's
/// own home, where bubblewrap binds a scope home for a fenced tab.
fn codex_config_key_paths(home: &std::path::Path) -> Vec<String> {
    let mut paths = vec![home.join(".codex").join("config.toml").to_string_lossy().into_owned()];
    if cfg!(target_os = "linux") {
        let fenced = paths::home_dir().join(".codex").join("config.toml").to_string_lossy().into_owned();
        if !paths.contains(&fenced) {
            paths.push(fenced);
        }
    }
    paths
}

/// Codex's key label for one of [`CODEX_HOOK_EVENTS`], and whether the event
/// keeps a group's `matcher` (Codex drops it for the rest, hash included).
fn codex_event_label(event: &str) -> Option<(&'static str, bool)> {
    Some(match event {
        "SessionStart" => ("session_start", true),
        "PostToolUse" => ("post_tool_use", true),
        "SessionEnd" => ("session_end", true),
        "UserPromptSubmit" => ("user_prompt_submit", false),
        "Stop" => ("stop", false),
        _ => return None,
    })
}

/// The `trusted_hash` Codex records for one command hook: SHA-256 of the
/// hook's normalized identity as JSON with sorted keys (codex-rs
/// `hooks::engine::discovery::hook_hash` → `config::version_for_toml`). The
/// timeout is normalized first — `SessionEnd` defaults to 1 s and is clamped
/// to 1–3, every other event defaults to 600 — so a `SessionEnd` lowered from
/// 10 to 3 keeps its hash. Reproduced against hashes Codex 0.164.0 wrote.
fn codex_hook_hash(label: &str, matcher: Option<&str>, command: &str, timeout: Option<u64>) -> String {
    let timeout = if label == "session_end" {
        timeout.unwrap_or(1).clamp(1, u64::from(CODEX_SESSION_END_TIMEOUT))
    } else {
        timeout.unwrap_or(600).max(1)
    };
    let quote = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let mut identity = format!(
        "{{\"event_name\":{},\"hooks\":[{{\"async\":false,\"command\":{},\"timeout\":{timeout},\"type\":\"command\"}}]",
        quote(label),
        quote(command),
    );
    if let Some(m) = matcher {
        identity.push_str(&format!(",\"matcher\":{}", quote(m)));
    }
    identity.push('}');
    format!("sha256:{}", crate::digest::sha256_hex(identity.as_bytes()))
}

/// A TOML string value [`toml_value`] can hand over verbatim: a literal
/// string, or a basic one without escapes. `None` for anything else, so a
/// hook whose bytes we cannot be sure of is left for `/hooks` to judge.
fn plain_toml_string(line: &str, key: &str) -> Option<String> {
    let raw = line.split_once('=')?.1.trim();
    if raw.starts_with("'''") || raw.starts_with("\"\"\"") || (raw.starts_with('"') && raw.contains('\\')) {
        return None;
    }
    if !(raw.starts_with('\'') || raw.starts_with('"')) {
        return None;
    }
    toml_value(line, key)
}

/// Testable core of [`trust_codex_hooks`]: `src` with every hook of ours
/// trusted under each of `key_paths`, or `None` when nothing changes.
///
/// A line scanner and text edit, like [`register_codex_hook_as`]: it finds
/// each `[[hooks.<Event>.hooks]]` table whose `command` is `cmd`, counts its
/// group and position the way Codex keys them, hashes it with
/// [`codex_hook_hash`], and sets `trusted_hash` in the matching
/// `[hooks.state."<path>:<event>:<group>:<hook>"]` table — in place when the
/// table exists (an `enabled = false` there is dropped), appended otherwise.
/// A table of ours holding anything beyond `type`, `command` and `timeout` is
/// skipped: its hash would cover fields this does not model.
pub fn trust_codex_hooks_in(src: &str, key_paths: &[String], cmd: &str) -> Option<String> {
    struct Hook {
        label: &'static str,
        group: usize,
        index: usize,
        matcher: Option<String>,
        command: Option<String>,
        timeout: Option<u64>,
        plain: bool,
    }
    let mut groups: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut handlers: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut hooks: Vec<Hook> = Vec::new();
    let mut matcher: Option<String> = None;
    // False once the group's matcher is a string we cannot read verbatim.
    let mut matcher_known = true;
    // Which table the scanner is in: a group (its event), or a handler (an
    // index into `hooks`, `None` for an event that is not ours).
    enum At {
        Other,
        Group,
        Handler(Option<usize>),
    }
    let mut at = At::Other;
    for raw in src.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            at = At::Other;
            if let Some(ev) = line.strip_prefix("[[hooks.").and_then(|s| s.strip_suffix(".hooks]]")) {
                let group = groups.get(ev).map_or(0, |g| g.saturating_sub(1));
                let index = handlers.entry(ev.to_string()).or_insert(0);
                let slot = codex_event_label(ev).map(|(label, keeps)| {
                    hooks.push(Hook {
                        label,
                        group,
                        index: *index,
                        matcher: if keeps { matcher.clone() } else { None },
                        command: None,
                        timeout: None,
                        plain: matcher_known || !keeps,
                    });
                    hooks.len() - 1
                });
                *index += 1;
                at = At::Handler(slot);
            } else if let Some(ev) = line.strip_prefix("[[hooks.").and_then(|s| s.strip_suffix("]]")) {
                *groups.entry(ev.to_string()).or_insert(0) += 1;
                handlers.insert(ev.to_string(), 0);
                matcher = None;
                matcher_known = true;
                at = At::Group;
            }
            continue;
        }
        match at {
            At::Group => {
                if toml_value(line, "matcher").is_some() {
                    matcher = plain_toml_string(line, "matcher");
                    matcher_known = matcher.is_some();
                }
            }
            At::Handler(Some(i)) => {
                let hook = &mut hooks[i];
                let key = line.split_once('=').map(|(k, _)| k.trim()).unwrap_or("");
                match key {
                    "type" => hook.plain &= toml_value(line, "type").as_deref() == Some("command"),
                    "command" => hook.command = plain_toml_string(line, "command"),
                    "timeout" => {
                        hook.timeout = toml_value(line, "timeout").and_then(|v| v.parse().ok());
                        hook.plain &= hook.timeout.is_some();
                    }
                    _ => hook.plain = false,
                }
            }
            At::Handler(None) | At::Other => {}
        }
    }

    // (state key, hash) for every hook of ours whose hash is known.
    let mut wanted: Vec<(String, String)> = Vec::new();
    for hook in &hooks {
        if !hook.plain || hook.command.as_deref() != Some(cmd) {
            continue;
        }
        let hash = codex_hook_hash(hook.label, hook.matcher.as_deref(), cmd, hook.timeout);
        for path in key_paths {
            wanted.push((format!("{path}:{}:{}:{}", hook.label, hook.group, hook.index), hash.clone()));
        }
    }
    if wanted.is_empty() {
        return None;
    }

    // Rewrite the state tables that exist, then append the missing ones.
    let lines: Vec<&str> = src.split_inclusive('\n').collect();
    let eol_of = |l: &str| if l.ends_with("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(src.len() + wanted.len() * 160);
    let mut done: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut changed = false;
    let mut i = 0;
    while i < lines.len() {
        let header = lines[i];
        let want = toml_state_table_key(header.trim())
            .and_then(|key| wanted.iter().find(|(k, _)| *k == key).cloned());
        let Some((key, hash)) = want else {
            out.push_str(header);
            i += 1;
            continue;
        };
        let end = (i + 1..lines.len())
            .find(|&j| lines[j].trim_start().starts_with('['))
            .unwrap_or(lines.len());
        let eol = eol_of(header);
        let new_line = format!("trusted_hash = \"{hash}\"{eol}");
        let mut body = String::new();
        let mut wrote = false;
        for l in &lines[i + 1..end] {
            let t = l.trim();
            if toml_value(t, "trusted_hash").is_some() {
                // One hash per table; a stale or duplicate one goes.
                changed |= wrote || t != new_line.trim();
                if !wrote {
                    body.push_str(&new_line);
                    wrote = true;
                }
            } else if toml_value(t, "enabled").as_deref() == Some("false") {
                changed = true;
            } else {
                body.push_str(l);
            }
        }
        out.push_str(header);
        if !header.ends_with('\n') {
            out.push_str(eol);
        }
        if !wrote {
            // Straight under the header, so the table's blank tail stays last.
            out.push_str(&new_line);
            changed = true;
        }
        out.push_str(&body);
        done.insert(key);
        i = end;
    }
    for (key, hash) in &wanted {
        if done.contains(key) {
            continue;
        }
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("\n[hooks.state.\"{key}\"]\ntrusted_hash = \"{hash}\"\n"));
        done.insert(key.clone());
        changed = true;
    }
    changed.then_some(out)
}

/// Install (idempotently) the session hooks and their script for every agent
/// Tabtivity can track (Claude + Codex), so it learns each tab's live session id,
/// its live permission mode (Claude's `Stop`), and its turn state (see
/// [`HOOK_EVENTS`] and `services::agent_turn`). Safe to call on every startup.
/// The shared script keys by `$TABTIVITY_TAB_UID` and reads `session_id` from the
/// hook's stdin JSON — both CLIs use that schema.
pub fn install_session_start_hook() -> std::io::Result<()> {
    write_hook_script()?;
    crate::services::opencode_session::write_plugin()?;
    crate::services::agent_hint::write_script()
}

/// Register the hooks in one Tabtivity-owned agent home (`services::agent_home`):
/// Claude's `settings.json`, Codex's `config.toml`, Vibe's `hooks.toml`. Each
/// is idempotent and keeps whatever else the file holds. Never a file in the
/// user's own home, and never through a symlink: a fenced agent owns the home,
/// so a link it plants there (or one the old fence left) is replaced by a
/// plain file, and a linked `.claude`/`.codex`/`.vibe` dir is skipped. The
/// file's directory is opened by handle (`services::home_io`) and every read
/// and write is relative to it, so a directory the agent swaps meanwhile
/// cannot redirect the registration. Best effort, logged.
pub fn register_hooks_in_home(home: &std::path::Path) {
    let plain = |rel: &str| {
        let file = HomeFile::open(home, rel);
        if file.is_none() {
            eprintln!("agent_session: {} in {} is not a plain path; hook skipped", rel, home.display());
        }
        file
    };
    if let Some(settings) = plain(".claude/settings.json") {
        if let Err(e) = register_hook_in_settings(&settings) {
            eprintln!("agent_session: register claude hook in {}: {e}", home.display());
        }
    }
    if let Some(config) = plain(".codex/config.toml") {
        if let Err(e) = register_codex_hook_in(&config) {
            eprintln!("agent_session: register codex hook in {}: {e}", home.display());
        }
    }
    if let Some(hooks) = plain(".vibe/hooks.toml") {
        if let Err(e) = write_vibe_hooks(&hooks, false) {
            eprintln!("agent_session: register vibe hook in {}: {e}", home.display());
        }
    }
    // OpenCode's session plugin (`services::opencode_session`).
    crate::services::opencode_session::register_in_home(home);
    crate::services::opencode_session::disable_service_in_home(home);
    // The other CLIs' `tabtivity-send` hint (Claude and Codex get it from the
    // session hook above).
    crate::services::agent_hint::register_in_home(home);
}

/// Vibe's user hook runs after each completed turn and reports the live ID.
/// Local-model homes have their own hooks.toml, so preparation calls this too.
///
/// A local-model home (`<state>/vibe_local/<alias>`) is Tabtivity's own, so its
/// file is rewritten to hold Tabtivity's hook alone: a hook a fenced agent planted
/// there before the fence made the file read-only must not survive into the
/// next local-model tab (threat model gap 7).
pub fn register_vibe_hook_in(home: &std::path::Path) -> std::io::Result<()> {
    let file = HomeFile::open(home, "hooks.toml")
        .ok_or_else(|| std::io::Error::other(format!("{} is not a directory", home.display())))?;
    write_vibe_hooks(&file, is_local_vibe_home(home))
}

fn write_vibe_hooks(file: &HomeFile, app_owned: bool) -> std::io::Result<()> {
    if app_owned {
        let fresh = vibe_hook_block()?;
        if file.read().as_deref() != Some(fresh.as_bytes()) {
            // In place: the file is bind-mounted read-only into the model's
            // running tabs and pinned by inode for one that is starting
            // (`agent_fence::verify_control_pins`). A rename over it would
            // detach those mounts and refuse a second tab of the model that
            // started at the same time.
            file.write_in_place(fresh.as_bytes())?;
        }
        return Ok(());
    }
    let mut content = file
        .read()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    if content.lines().any(|line| line.trim() == format!("name = \"{}\"", crate::brand::VIBE_SESSION_HOOK)) {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push('\n');
    content.push_str(&vibe_hook_block()?);
    file.write(content.as_bytes())
}

fn vibe_hook_block() -> std::io::Result<String> {
    let cmd = serde_json::to_string(&hook_command()).map_err(std::io::Error::other)?;
    Ok(format!(
        "# {DISPLAY}: remember the live Vibe session for this tab.\n\
         [[hooks]]\nname = \"{name}\"\ntype = \"post_agent\"\ncommand = {cmd}\ntimeout = 10.0\n",
        name = crate::brand::VIBE_SESSION_HOOK
    ))
}

/// Whether `home` is one of Tabtivity's local-model `VIBE_HOME`s — the same root
/// and one-component rule [`vibe_home_for`] applies.
fn is_local_vibe_home(home: &std::path::Path) -> bool {
    is_local_vibe_home_in(home, &storage::home_share_dir().join("vibe_local"))
}

fn is_local_vibe_home_in(home: &std::path::Path, local_root: &std::path::Path) -> bool {
    home.strip_prefix(local_root).is_ok_and(|child| {
        child.components().count() == 1
            && child.components().all(|c| matches!(c, std::path::Component::Normal(_)))
    })
}

fn write_hook_script() -> std::io::Result<()> {
    let live_dir = live_sessions_dir();
    std::fs::create_dir_all(&live_dir)?;
    let script_path = hook_script_path();
    if let Some(parent) = script_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&script_path, hook_script_body(&live_dir.to_string_lossy()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(&script_path)?.permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&script_path, perm)?;
    }
    // Windows: the project container is Linux, so beside the registered
    // PowerShell hook write the POSIX twin the staged in-container configs
    // point at, with the live-sessions dir spelled the way the container sees
    // the bind mount. Since the agent homes (#2335) the registration files
    // carry the host's PowerShell command only, so a container on a Windows
    // host records no live session — a known residual (`todo/group-s-agents.md`).
    #[cfg(windows)]
    {
        let container_live = crate::services::sandbox::container_path(&live_dir.to_string_lossy());
        std::fs::write(
            container_hook_script_path(),
            posix_hook_script_body(&container_live),
        )?;
    }
    Ok(())
}

/// The POSIX hook script's path when it is the *container* twin of a
/// PowerShell host hook (Windows only; on Unix the POSIX script IS the hook).
#[cfg(windows)]
fn container_hook_script_path() -> PathBuf {
    storage::state_dir()
        .join("hooks")
        .join(crate::brand::SESSION_HOOK_SH)
}

/// POSIX-sh hook body. Reads the hook JSON on stdin and records, per tab key:
/// `session_id` → `<live_dir>/<TABTIVITY_TAB_UID>` (on `SessionStart`/`Stop`), —
/// when the event carries it (`SessionStart` does not; `Stop` does) —
/// `permission_mode` → `<live_dir>/<TABTIVITY_TAB_UID>.mode`, and the turn state
/// the event implies → `<live_dir>/<TABTIVITY_TAB_UID>.turn` (`working` /
/// `decision` / `done` / `idle` plus the epoch second, read by
/// `services::agent_turn`). No jq dependency: one `sed` per field pulls the
/// value out of the one-line JSON.
///
/// **Only the tab's own session may move the record.** Every process under the
/// tab inherits `TABTIVITY_TAB_UID`, so a nested CLI — the tab's agent running
/// `claude -p …` through its own shell tool, verified live — fires this hook too,
/// and used to overwrite both records with its one-shot session and its default
/// mode: the next relaunch resumed a dead headless session and lost the
/// conversation. A Claude tab's session id is its launch key and stays that id
/// until `/clear` or `/resume` rolls it (the `source` field says which), and
/// `Stop` never introduces an id, so a session id that is neither the key nor
/// the current record is accepted only from a `clear`/`resume` start — or from a
/// plain `startup` while the tab's own session has no transcript yet: Claude
/// (2.1.282) relaunches itself to switch its renderer (the fullscreen upsell,
/// `/tui`) or to update, and a session with no transcript comes back under a
/// fresh id with `--session-id` dropped, so the record stayed on a launch id
/// that never wrote a file and the phone read an empty conversation; a CLI
/// nested under the tab is started by a session that has been prompted, whose
/// transcript exists — in *some* project folder: looking only beside the new
/// transcript let a `claude -p` run from another cwd (the agent's Bash tool
/// after a `cd`) take the record over, since its transcript lands in that
/// cwd's folder, not the tab's (2.1.284, 2026-09-29) — and only
/// with Claude's own transcript for it (`…/<session_id>.jsonl`): a Codex run
/// from the tab's shell fires the same `clear` start after its own `/clear`,
/// with a null `transcript_path` or a `rollout-…` one, and took the Claude
/// tab's record over, so the phone read that Codex's rollout (2026-09-24). A Codex
/// tab (`TABTIVITY_TAB_AGENT=codex`) mints its own ids, so its record is free-form
/// — except that a Claude fired inside it (`CLAUDECODE` is set by Claude for its
/// children, never by Codex) is refused outright. A `clear`/`resume` start is
/// taken only from a Claude with no other Claude above it among the tab's
/// processes (POSIX, via `/proc`; where that is unreadable — macOS — via `ps`,
/// whose `-E` shows a same-user process's environment): a `claude -p --resume <id>` run from the
/// agent's Bash tool sent `source: resume` under its own id and moved the
/// record, so the Reader showed that run's conversation until the tab's next
/// `Stop` (2.1.287, 2026-10-02). Claude's env can't tell them apart — every
/// hook, the tab's own too, gets `CLAUDECODE` and `CLAUDE_CODE_CHILD_SESSION`
/// — and its self-relaunch execs in place (it spawns a child only when that
/// exec fails), so it adds no Claude above itself. "The tab's processes" are
/// those carrying its id under any `*_TAB_UID` name: a probe that unset only
/// the current name still reached the hook through the legacy one, and a walk
/// matching the current name alone counted nothing and let it through (2.1.288).
/// The PowerShell twin has no such check yet.
#[cfg(not(windows))]
fn hook_script_body(live_dir: &str) -> String {
    posix_hook_script_body(live_dir)
}

/// The app's variables the hook reads. A session an older build started has
/// them under the old prefix only; the script takes those when the current
/// names are unset (nothing is added while the prefix is unchanged).
const HOOK_ENV: &[&str] = &["TAB_UID", "TAB_AGENT", "PROJECT_DIR"];

/// The POSIX body itself — the hook on Unix, and on Windows the container twin
/// (see `write_hook_script`), so it is compiled everywhere.
fn posix_hook_script_body(live_dir: &str) -> String {
    posix_hook_script_body_with(live_dir, "/proc")
}

/// `posix_hook_script_body` with the procfs root it walks baked in as a
/// literal. Production passes `/proc`; a test passes an empty directory to
/// drive the `ps` fallback (macOS). A literal, not an environment variable:
/// the hook runs under the agent's environment, which a project can shape.
fn posix_hook_script_body_with(live_dir: &str, proc_root: &str) -> String {
    let hint = crate::services::agent_hint::HINT;
    format!(
        "#!/bin/sh\n\
         # {DISPLAY} agent hook (SessionStart, Stop, UserPromptSubmit, PostToolUse,\n\
         # Notification, SessionEnd) — records, per tab, the agent's live session id\n\
         # and permission mode (so {DISPLAY} resumes the current session in the mode it\n\
         # was left in, incl. after /clear), how the session started (so a prompt\n\
         # sent after a /clear is filed under the new session, linked to the old\n\
         # one), and its turn state (working / decision / done / idle), which\n\
         # lights the tab's working and finished marks. No-op\n\
         # unless launched by {DISPLAY} ({UPPER}_TAB_UID set). Managed by {DISPLAY}; do not edit.\n\
         {legacy_env}[ -n \"${UPPER}_TAB_UID\" ] || exit 0\n\
         case \"${UPPER}_TAB_UID\" in *[!a-zA-Z0-9-]*|\"\") exit 0 ;; esac\n\
         input=$(cat | tr '\\n' ' ')\n\
         sid=$(printf '%s' \"$input\" | sed -n 's/.*\"session_id\"[[:space:]]*:[[:space:]]*\"\\([0-9a-fA-F-]*\\)\".*/\\1/p')\n\
         mode=$(printf '%s' \"$input\" | sed -n 's/.*\"permission_mode\"[[:space:]]*:[[:space:]]*\"\\([a-zA-Z]*\\)\".*/\\1/p')\n\
         src=$(printf '%s' \"$input\" | sed -n 's/.*\"source\"[[:space:]]*:[[:space:]]*\"\\([a-zA-Z]*\\)\".*/\\1/p')\n\
         event=$(printf '%s' \"$input\" | sed -n 's/.*\"hook_event_name\"[[:space:]]*:[[:space:]]*\"\\([a-zA-Z_]*\\)\".*/\\1/p')\n\
         ntype=$(printf '%s' \"$input\" | sed -n 's/.*\"notification_type\"[[:space:]]*:[[:space:]]*\"\\([a-zA-Z_]*\\)\".*/\\1/p')\n\
         reason=$(printf '%s' \"$input\" | sed -n 's/.*\"reason\"[[:space:]]*:[[:space:]]*\"\\([a-zA-Z_]*\\)\".*/\\1/p')\n\
         tpath=$(printf '%s' \"$input\" | sed -n 's/.*\"transcript_path\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p')\n\
         tnull=$(printf '%s' \"$input\" | sed -n 's/.*\"transcript_path\"[[:space:]]*:[[:space:]]*null.*/null/p')\n\
         secs=$(printf '%s' \"$input\" | sed -n 's/.*\"seconds_since_last_response\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')\n\
         ctxt=$(printf '%s' \"$input\" | sed -n 's/.*\"context_tokens\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')\n\
         usd=$(printf '%s' \"$input\" | sed -n 's/.*\"estimated_cache_write_usd\"[[:space:]]*:[[:space:]]*\\([0-9][0-9.]*\\).*/\\1/p')\n\
         cold=$(printf '%s' \"$input\" | sed -n 's/.*\"prompt_cache_likely_expired\"[[:space:]]*:[[:space:]]*\\([a-z]*\\).*/\\1/p')\n\
         [ -n \"$sid\" ] || exit 0\n\
         dir=\"{live_dir}\"\n\
         mkdir -p \"$dir\" 2>/dev/null || exit 0\n\
         cur=$(cat \"$dir/${UPPER}_TAB_UID\" 2>/dev/null)\n\
         # Only the tab's own session may move the records: a nested CLI under the\n\
         # tab inherits {UPPER}_TAB_UID and fires this hook too.\n\
         case \"${UPPER}_TAB_AGENT\" in\n\
         \x20 vibe) [ \"$event\" = post_agent ] || exit 0\n\
         \x20   parent=$(printf '%s' \"$input\" | sed -n 's/.*\"parent_session_id\"[[:space:]]*:[[:space:]]*\\([^,}}]*\\).*/\\1/p')\n\
         \x20   [ \"$parent\" = null ] || exit 0\n\
         \x20   printf '%s' \"$sid\" > \"$dir/${UPPER}_TAB_UID\"\n\
         \x20   exit 0 ;;\n\
         \x20 codex) [ -z \"$CLAUDECODE\" ] || exit 0\n\
         \x20   # Codex mints its own ids, so a start is free-form; every later event\n\
         \x20   # must come from the session the tab already recorded.\n\
         \x20   if [ \"$event\" != SessionStart ] && [ -n \"$cur\" ] && [ \"$sid\" != \"$cur\" ]; then exit 0; fi ;;\n\
         \x20 *) if [ \"$sid\" != \"${UPPER}_TAB_UID\" ] && [ \"$sid\" != \"$cur\" ]; then\n\
         \x20      # Claude names the new transcript after its session; a Codex run under\n\
         \x20      # the tab sends null (a /clear, no rollout yet) or a rollout-… file.\n\
         \x20      [ \"$tnull\" = null ] && exit 0\n\
         \x20      case \"$tpath\" in \"\"|*/\"$sid\".jsonl) ;; *) exit 0 ;; esac\n\
         \x20      case \"$src\" in\n\
         \x20        # A /clear or /resume typed in the tab comes from the tab's own CLI;\n\
         \x20        # a `claude --resume` nested under it (the agent's Bash tool) sends\n\
         \x20        # the same start. Among the tab's processes — those carrying its\n\
         \x20        # id under either tab-id name, so unsetting one (the other fills it\n\
         \x20        # in above) can't hide a nested run — the tab's CLI has no claude\n\
         \x20        # above it, a nested one has. Without /proc (macOS) `ps` walks the\n\
         \x20        # same chain: `-E` appends the environment of a process of this\n\
         \x20        # user, `-ww` keeps BSD `ps` from cutting it at 79 columns (no tty);\n\
         \x20        # a `claude` is one whose executable or argv[0] is named so.\n\
         \x20        # Where neither answers nothing is counted and the start is taken.\n\
         \x20        clear|resume) n=0; p=$PPID\n\
         \x20          if [ -r \"{proc_root}/$p/environ\" ]; then\n\
         \x20          while [ -r \"{proc_root}/$p/environ\" ] && tr '\\0' '\\n' < \"{proc_root}/$p/environ\" | grep -qx \"[A-Z]*_TAB_UID=${UPPER}_TAB_UID\"; do\n\
         \x20            [ \"$(cat \"{proc_root}/$p/comm\" 2>/dev/null)\" = claude ] && n=$((n + 1))\n\
         \x20            p=$(sed 's/.*) [^ ]* \\([0-9]*\\).*/\\1/' \"{proc_root}/$p/stat\" 2>/dev/null)\n\
         \x20          done\n\
         \x20          else\n\
         \x20          while [ \"$p\" -gt 1 ] 2>/dev/null && e=$(ps -E -ww -o command= -p \"$p\" 2>/dev/null) &&\n\
         \x20            printf '%s\\n' \"$e\" | tr ' ' '\\n' | grep -qx \"[A-Z]*_TAB_UID=${UPPER}_TAB_UID\"; do\n\
         \x20            c=$(ps -ww -o comm= -p \"$p\" 2>/dev/null); a=${{e%% *}}\n\
         \x20            if [ \"${{c##*/}}\" = claude ] || [ \"${{a##*/}}\" = claude ]; then n=$((n + 1)); fi\n\
         \x20            p=$(ps -o ppid= -p \"$p\" 2>/dev/null | tr -d ' ')\n\
         \x20          done\n\
         \x20          fi\n\
         \x20          [ \"$n\" -lt 2 ] || exit 0 ;;\n\
         \x20        # Claude relaunches itself (switching its renderer, updating) and,\n\
         \x20        # while its session has no transcript yet, comes back under a fresh\n\
         \x20        # id with a plain start. The tab's own session is then the one with\n\
         \x20        # no transcript in any project folder; a CLI nested under the tab\n\
         \x20        # was started by a session that has been prompted, whose file is\n\
         \x20        # there — in the tab's cwd folder, not the nested run's own.\n\
         \x20        startup) [ \"${UPPER}_TAB_AGENT\" = claude ] && [ -n \"$tpath\" ] || exit 0\n\
         \x20          for t in \"${{tpath%/*/*}}\"/*/\"${{cur:-${UPPER}_TAB_UID}}.jsonl\"; do [ -f \"$t\" ] && exit 0; done ;;\n\
         \x20        *) exit 0 ;;\n\
         \x20      esac\n\
         \x20    fi ;;\n\
         esac\n\
         case \"$event:${UPPER}_TAB_AGENT\" in SessionStart:claude|SessionStart:codex) [ -z \"${UPPER}_PROJECT_DIR\" ] ||\n\
         \x20 printf '%s\\n' '{hint}' ;;\n\
         esac\n\
         # The turn state, from the events the agent fires as it works: a prompt\n\
         # submitted or a tool finished means working (a finished tool is also what\n\
         # ends an approval wait), Stop means done, a permission or elicitation\n\
         # notice means blocked on the user, the end of the session means idle —\n\
         # unless a /clear ended it: the CLI is still at its prompt, and the\n\
         # verdict it had (done) is what keeps the tab off its stale screen.\n\
         turn=\n\
         case \"$event\" in\n\
         \x20 UserPromptSubmit|PostToolUse) turn=working ;;\n\
         \x20 Stop) turn=done ;;\n\
         \x20 Notification) case \"$ntype\" in permission_prompt|elicitation_dialog) turn=decision ;; idle_prompt) turn=done ;; esac ;;\n\
         \x20 SessionEnd) [ \"$reason\" = clear ] || turn=idle ;;\n\
         esac\n\
         # A Bash call put in the background (`run_in_background`, or moved there\n\
         # while it ran) comes back with its task id, and its shell writes to\n\
         # `<id>.output`: that is how the job scan tells it from the call the\n\
         # agent waits on, which looks the same. The last few ids are kept; written\n\
         # before the turn record, whose write is what makes the scan look.\n\
         if [ \"$event\" = PostToolUse ]; then\n\
         \x20 bg=$(printf '%s' \"$input\" | sed -n 's/.*\"backgroundTaskId\"[[:space:]]*:[[:space:]]*\"\\([a-zA-Z0-9]*\\)\".*/\\1/p')\n\
         \x20 [ -n \"$bg\" ] && {{ tail -n 15 \"$dir/${UPPER}_TAB_UID.bg\" 2>/dev/null; printf '%s\\n' \"$bg\"; }} > \"$dir/${UPPER}_TAB_UID.bg.$$\" &&\n\
         \x20   mv -f \"$dir/${UPPER}_TAB_UID.bg.$$\" \"$dir/${UPPER}_TAB_UID.bg\"\n\
         fi\n\
         [ -n \"$turn\" ] && printf '%s %s' \"$turn\" \"$(date +%s)\" > \"$dir/${UPPER}_TAB_UID.turn\"\n\
         # A prompt in the conversation a /clear started ends that clear's undo:\n\
         # resuming the one it ended would leave the prompt behind. Not a session\n\
         # command, which a CLI may report as a prompt too.\n\
         if [ \"$event\" = UserPromptSubmit ] && ! printf '%s' \"$input\" | grep -Eq '\"prompt\"[[:space:]]*:[[:space:]]*\"[[:space:]]*/(clear|new|resume)'; then\n\
         \x20 rm -f \"$dir/${UPPER}_TAB_UID.prev\"\n\
         fi\n\
         # A /clear keeps the id of the conversation it ended, so the clear can be\n\
         # undone by resuming it; written before the source that says clear.\n\
         if [ \"$event\" = SessionStart ] && [ \"$src\" = clear ] && [ \"$sid\" != \"${{cur:-${UPPER}_TAB_UID}}\" ]; then\n\
         \x20 printf '%s' \"${{cur:-${UPPER}_TAB_UID}}\" > \"$dir/${UPPER}_TAB_UID.prev\"\n\
         fi\n\
         # A start also records how the session came about (startup / resume /\n\
         # clear / compact), written BEFORE the id so a reader that sees the new\n\
         # id sees the source that produced it.\n\
         case \"$event\" in\n\
         \x20 SessionStart|Stop)\n\
         \x20   # What a resume's first request will cost (Claude 2.1.30x puts it in the\n\
         \x20   # start's payload), written before the source whose write the app reads\n\
         \x20   # it on; any other start clears the last one.\n\
         \x20   if [ \"$event\" = SessionStart ]; then\n\
         \x20     if [ \"$src\" = resume ] && [ -n \"$secs\" ]; then printf '%s %s %s %s' \"$secs\" \"${{ctxt:-0}}\" \"${{usd:-0}}\" \"${{cold:-false}}\" > \"$dir/${UPPER}_TAB_UID.resume\"\n\
         \x20     else rm -f \"$dir/${UPPER}_TAB_UID.resume\"; fi\n\
         \x20   fi\n\
         \x20   [ \"$event\" = SessionStart ] && [ -n \"$src\" ] && printf '%s' \"$src\" > \"$dir/${UPPER}_TAB_UID.src\"\n\
         \x20   printf '%s' \"$sid\" > \"$dir/${UPPER}_TAB_UID\"\n\
         \x20   [ -n \"$mode\" ] && printf '%s' \"$mode\" > \"$dir/${UPPER}_TAB_UID.mode\" ;;\n\
         esac\n\
         exit 0\n",
        live_dir = live_dir,
        proc_root = proc_root,
        legacy_env = crate::services::brand_migration::compat::script_preamble_sh(HOOK_ENV),
    )
}

/// PowerShell hook body (Windows). Mirrors the POSIX script — the same fields,
/// the same continuity rule — with regexes in place of `sed` and no jq/
/// `Get-Content` JSON dependency. Keyed and guarded the same way, so
/// `read_live_session` reads both back identically. `[IO.File]::WriteAllText`
/// writes UTF-8 *without* a BOM, so the stored id round-trips cleanly through
/// `read_live_session`'s `trim()`/`is_uuidish` checks.
#[cfg(windows)]
fn hook_script_body(live_dir: &str) -> String {
    // `live_dir` is a Windows path (backslashes); embed it in a single-quoted
    // PowerShell literal so backslashes are not treated as escapes.
    let live_dir = crate::quote::powershell(live_dir);
    let hint = crate::services::agent_hint::HINT;
    format!(
        "# {DISPLAY} agent hook (SessionStart, Stop, UserPromptSubmit, PostToolUse,\r\n\
         # Notification, SessionEnd) - records, per tab, the agent's live session id\r\n\
         # and permission mode (so {DISPLAY} resumes the current session in the mode it\r\n\
         # was left in, incl. after /clear) and its turn state (working / decision /\r\n\
         # done / idle), which lights the tab's working and finished marks. No-op\r\n\
         # unless launched by {DISPLAY} ({UPPER}_TAB_UID set). Managed by {DISPLAY}; do not edit.\r\n\
         {legacy_env}$ErrorActionPreference = 'SilentlyContinue'\r\n\
         $uid = $env:{UPPER}_TAB_UID\r\n\
         if ([string]::IsNullOrEmpty($uid)) {{ exit 0 }}\r\n\
         if ($uid -notmatch '^[A-Za-z0-9-]+$') {{ exit 0 }}\r\n\
         $payload = [Console]::In.ReadToEnd()\r\n\
         $m = [regex]::Match($payload, '\"session_id\"\\s*:\\s*\"([0-9A-Fa-f-]+)\"')\r\n\
         $mm = [regex]::Match($payload, '\"permission_mode\"\\s*:\\s*\"([A-Za-z]+)\"')\r\n\
         $ms = [regex]::Match($payload, '\"source\"\\s*:\\s*\"([A-Za-z]+)\"')\r\n\
         $me = [regex]::Match($payload, '\"hook_event_name\"\\s*:\\s*\"([A-Za-z_]+)\"')\r\n\
         $mn = [regex]::Match($payload, '\"notification_type\"\\s*:\\s*\"([A-Za-z_]+)\"')\r\n\
         $mr = [regex]::Match($payload, '\"reason\"\\s*:\\s*\"([A-Za-z_]+)\"')\r\n\
         $mq = [regex]::Match($payload, '\"seconds_since_last_response\"\\s*:\\s*([0-9]+)')\r\n\
         $mc = [regex]::Match($payload, '\"context_tokens\"\\s*:\\s*([0-9]+)')\r\n\
         $mu = [regex]::Match($payload, '\"estimated_cache_write_usd\"\\s*:\\s*([0-9.]+)')\r\n\
         $mx = [regex]::Match($payload, '\"prompt_cache_likely_expired\"\\s*:\\s*([a-z]+)')\r\n\
         if (-not $m.Success) {{ exit 0 }}\r\n\
         $sid = $m.Groups[1].Value\r\n\
         $event = ''\r\n\
         if ($me.Success) {{ $event = $me.Groups[1].Value }}\r\n\
         $ntype = ''\r\n\
         if ($mn.Success) {{ $ntype = $mn.Groups[1].Value }}\r\n\
         $dir = {live_dir}\r\n\
         [void](New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue)\r\n\
         $rec = Join-Path $dir $uid\r\n\
         $cur = ''\r\n\
         if (Test-Path $rec) {{ $cur = [IO.File]::ReadAllText($rec).Trim() }}\r\n\
         if ($env:{UPPER}_TAB_AGENT -eq 'vibe') {{\r\n\
         \x20 if (($event -ne 'post_agent') -or ($payload -notmatch '\"parent_session_id\"\\s*:\\s*null')) {{ exit 0 }}\r\n\
         \x20 [IO.File]::WriteAllText($rec, $sid)\r\n\
         \x20 exit 0\r\n\
         }}\r\n\
         # Only the tab's own session may move the records: a nested CLI under the\r\n\
         # tab inherits {UPPER}_TAB_UID and fires this hook too.\r\n\
         if ($env:{UPPER}_TAB_AGENT -eq 'codex') {{\r\n\
         \x20 if (-not [string]::IsNullOrEmpty($env:CLAUDECODE)) {{ exit 0 }}\r\n\
         \x20 # Codex mints its own ids, so a start is free-form; every later event\r\n\
         \x20 # must come from the session the tab already recorded.\r\n\
         \x20 if (($event -ne 'SessionStart') -and ($cur -ne '') -and ($sid -ne $cur)) {{ exit 0 }}\r\n\
         }} elseif (($sid -ne $uid) -and ($sid -ne $cur)) {{\r\n\
         \x20 $src = ''\r\n\
         \x20 if ($ms.Success) {{ $src = $ms.Groups[1].Value }}\r\n\
         \x20 # Claude names the new transcript after its session; a Codex run under\r\n\
         \x20 # the tab sends null (a /clear, no rollout yet) or a rollout-... file.\r\n\
         \x20 if ($payload -match '\"transcript_path\"\\s*:\\s*null') {{ exit 0 }}\r\n\
         \x20 $mt = [regex]::Match($payload, '\"transcript_path\"\\s*:\\s*\"([^\"]*)\"')\r\n\
         \x20 if ($mt.Success -and ($mt.Groups[1].Value -notmatch ('[\\\\/]' + [regex]::Escape($sid) + '\\.jsonl$'))) {{ exit 0 }}\r\n\
         \x20 if ($src -eq 'startup') {{\r\n\
         \x20   # Claude relaunches itself (switching its renderer, updating) and, while\r\n\
         \x20   # its session has no transcript yet, comes back under a fresh id with a\r\n\
         \x20   # plain start: the tab's own session is the one with no transcript in\r\n\
         \x20   # any project folder (see the POSIX twin).\r\n\
         \x20   if (($env:{UPPER}_TAB_AGENT -ne 'claude') -or (-not $mt.Success)) {{ exit 0 }}\r\n\
         \x20   $ref = $cur\r\n\
         \x20   if ($ref -eq '') {{ $ref = $uid }}\r\n\
         \x20   $tdir = Split-Path ($mt.Groups[1].Value -replace '\\\\\\\\', '\\') -Parent\r\n\
         \x20   if (Test-Path -Path (Join-Path (Split-Path $tdir -Parent) ('*\\' + $ref + '.jsonl'))) {{ exit 0 }}\r\n\
         \x20 }} elseif (($src -ne 'clear') -and ($src -ne 'resume')) {{ exit 0 }}\r\n\
         }}\r\n\
         if (($env:{UPPER}_TAB_AGENT -eq 'claude' -or $env:{UPPER}_TAB_AGENT -eq 'codex') -and $env:{UPPER}_PROJECT_DIR -and $event -eq 'SessionStart') {{ Write-Output '{hint}' }}\r\n\
         # The turn state, from the events the agent fires as it works (see the\r\n\
         # POSIX twin for the mapping).\r\n\
         $turn = ''\r\n\
         switch ($event) {{\r\n\
         \x20 'UserPromptSubmit' {{ $turn = 'working' }}\r\n\
         \x20 'PostToolUse' {{ $turn = 'working' }}\r\n\
         \x20 'Stop' {{ $turn = 'done' }}\r\n\
         \x20 'Notification' {{ if (($ntype -eq 'permission_prompt') -or ($ntype -eq 'elicitation_dialog')) {{ $turn = 'decision' }} elseif ($ntype -eq 'idle_prompt') {{ $turn = 'done' }} }}\r\n\
         \x20 'SessionEnd' {{ if (-not ($mr.Success -and ($mr.Groups[1].Value -eq 'clear'))) {{ $turn = 'idle' }} }}\r\n\
         }}\r\n\
         if ($turn -ne '') {{ [IO.File]::WriteAllText(($rec + '.turn'), ($turn + ' ' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())) }}\r\n\
         # A prompt in the conversation a /clear started ends that clear's undo\r\n\
         # (see the POSIX twin).\r\n\
         if (($event -eq 'UserPromptSubmit') -and ($payload -notmatch '\"prompt\"\\s*:\\s*\"\\s*/(clear|new|resume)')) {{ Remove-Item -LiteralPath ($rec + '.prev') -Force -ErrorAction SilentlyContinue }}\r\n\
         # A /clear keeps the id of the conversation it ended (see the POSIX twin).\r\n\
         if (($event -eq 'SessionStart') -and $ms.Success -and ($ms.Groups[1].Value -eq 'clear')) {{\r\n\
         \x20 $was = $cur\r\n\
         \x20 if ($was -eq '') {{ $was = $uid }}\r\n\
         \x20 if ($sid -ne $was) {{ [IO.File]::WriteAllText(($rec + '.prev'), $was) }}\r\n\
         }}\r\n\
         if (($event -eq 'SessionStart') -or ($event -eq 'Stop')) {{\r\n\
         \x20 # What a resume's first request will cost, written before the source the\r\n\
         \x20 # app reads it on; any other start clears the last one (see the POSIX twin).\r\n\
         \x20 if ($event -eq 'SessionStart') {{\r\n\
         \x20   if ($ms.Success -and ($ms.Groups[1].Value -eq 'resume') -and $mq.Success) {{\r\n\
         \x20     $cx = '0'; if ($mc.Success) {{ $cx = $mc.Groups[1].Value }}\r\n\
         \x20     $us = '0'; if ($mu.Success) {{ $us = $mu.Groups[1].Value }}\r\n\
         \x20     $cd = 'false'; if ($mx.Success) {{ $cd = $mx.Groups[1].Value }}\r\n\
         \x20     [IO.File]::WriteAllText(($rec + '.resume'), ($mq.Groups[1].Value + ' ' + $cx + ' ' + $us + ' ' + $cd))\r\n\
         \x20   }} else {{ Remove-Item -LiteralPath ($rec + '.resume') -Force -ErrorAction SilentlyContinue }}\r\n\
         \x20 }}\r\n\
         \x20 if (($event -eq 'SessionStart') -and $ms.Success) {{ [IO.File]::WriteAllText(($rec + '.src'), $ms.Groups[1].Value) }}\r\n\
         \x20 [IO.File]::WriteAllText($rec, $sid)\r\n\
         \x20 if ($mm.Success) {{ [IO.File]::WriteAllText(($rec + '.mode'), $mm.Groups[1].Value) }}\r\n\
         }}\r\n\
         exit 0\r\n",
        live_dir = live_dir,
        legacy_env = crate::services::brand_migration::compat::script_preamble_ps1(HOOK_ENV),
    )
}

/// The hook events one script serves, for both CLIs. `SessionStart` tracks the
/// live session id across startup/resume/clear/compact; `Stop` re-records it
/// *with* `permission_mode` after every response — SessionStart payloads don't
/// carry the mode and a shift+tab mode cycle fires no event of its own, so the
/// latest Stop record is what resume re-applies. The other four carry the tab's
/// **turn state** (`services::agent_turn`): a submitted prompt or a finished
/// tool means working, Stop means done, a permission/elicitation notice means
/// blocked on the user, the session's end means idle. Codex has no
/// `Notification` hook; its approval wait is still read off its screen.
pub const HOOK_EVENTS: [&str; 6] = [
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
    "PostToolUse",
    "Notification",
    "SessionEnd",
];

/// Merge our handlers into a Claude `settings.json`, preserving all other content
/// and other hooks — one group per event in [`HOOK_EVENTS`]. Idempotent per
/// event: a handler already pointing at our script is left untouched, and an
/// install that predates an event gains just that event. Matchers are omitted
/// so each hook fires for every `source` / tool / notification type.
fn register_hook_in_settings(settings: &HomeFile) -> std::io::Result<()> {
    register_hook_in_settings_as(settings, &hook_command())
}

/// [`register_hook_in_settings`] for a given hook command.
pub(crate) fn register_hook_in_settings_as(settings: &HomeFile, cmd: &str) -> std::io::Result<()> {
    let mut root: serde_json::Value = settings
        .read()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }

    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let mut changed = false;
    for event in HOOK_EVENTS {
        let entry = hooks
            .as_object_mut()
            .unwrap()
            .entry(event)
            .or_insert_with(|| serde_json::json!([]));
        if !entry.is_array() {
            *entry = serde_json::json!([]);
        }
        let arr = entry.as_array_mut().unwrap();
        let already = arr.iter().any(|group| {
            group
                .get("hooks")
                .and_then(|h| h.as_array())
                .is_some_and(|hs| {
                    hs.iter()
                        .any(|h| h.get("command").and_then(|c| c.as_str()) == Some(cmd))
                })
        });
        if !already {
            arr.push(serde_json::json!({
                "hooks": [ { "type": "command", "command": cmd } ]
            }));
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }

    let serialized = serde_json::to_string_pretty(&root).map_err(std::io::Error::other)?;
    settings.write(serialized.as_bytes())?;
    Ok(())
}

/// Register our `SessionStart` hook in a Codex `config.toml`. Codex config is
/// TOML with no parser dependency here, so we **text-append** an array-of-tables
/// block rather than reparse/reserialize the file (which would drop comments
/// and reorder its many `[projects.*]` tables). `[[hooks.SessionStart]]` is a
/// top-level array-of-tables, so appending at EOF is always valid regardless
/// of preceding content. Idempotent: skipped once our script path is present.
///
/// NOTE: user-level Codex hooks require a one-time trust approval (`/hooks` in
/// Codex) before they run, so resume tracking through *this* path is inert until
/// the user trusts it — see [`codex_hook_state`], which detects that, and
/// [`crate::services::codex_bind`], the hook-free fallback that keeps Codex tabs
/// resumable meanwhile.
/// The events registered with Codex: [`HOOK_EVENTS`] minus `Notification`,
/// which Codex 0.154 does not offer (its approval wait is read off its screen).
pub const CODEX_HOOK_EVENTS: [&str; 5] = [
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
    "PostToolUse",
    "SessionEnd",
];

/// Which events already carry our hook in a Codex config: every
/// `[[hooks.<Event>.hooks]]` table whose `command` is `cmd`. A line scanner for
/// the reason [`codex_hook_state_in`] is one — the shapes are fixed and a TOML
/// dependency for this is not worth its weight. Per event rather than "is the
/// command in the file", so an install that registered `SessionStart` alone
/// gains the turn-state events on the next start instead of being read as done.
pub fn codex_registered_events(src: &str, cmd: &str) -> std::collections::HashSet<String> {
    let mut current: Option<String> = None;
    let mut out = std::collections::HashSet::new();
    for raw in src.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            current = line
                .strip_prefix("[[hooks.")
                .and_then(|s| s.strip_suffix(".hooks]]"))
                .map(str::to_string);
            continue;
        }
        if let Some(ev) = current.as_ref() {
            if toml_value(line, "command").as_deref() == Some(cmd) {
                out.insert(ev.clone());
            }
        }
    }
    out
}

/// The most a Codex `SessionEnd` hook may take, in seconds: Codex (0.160.1,
/// 0.161.0) clamps a longer one to this and warns on every start.
const CODEX_SESSION_END_TIMEOUT: u32 = 3;

/// `src` with the `timeout` of our own `[[hooks.SessionEnd.hooks]]` table
/// (the one whose `command` is `cmd`) lowered to
/// [`CODEX_SESSION_END_TIMEOUT`], or `None` when nothing needs lowering.
/// Earlier builds wrote `timeout = 10` there. Codex's trust hash covers the
/// timeout only after clamping it to 3 ([`codex_hook_hash`]; live on 0.161.0
/// the lowered hook stayed trusted, no review menu), so the rewrite costs no
/// re-approval. Other tables and
/// lines are left byte for byte.
fn cap_codex_session_end_timeout(src: &str, cmd: &str) -> Option<String> {
    let lines: Vec<&str> = src.split_inclusive('\n').collect();
    let mut out = String::with_capacity(src.len());
    let mut changed = false;
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() != "[[hooks.SessionEnd.hooks]]" {
            out.push_str(lines[i]);
            i += 1;
            continue;
        }
        let end = (i + 1..lines.len())
            .find(|&j| lines[j].trim_start().starts_with('['))
            .unwrap_or(lines.len());
        let table = &lines[i..end];
        let ours = table.iter().any(|l| toml_value(l.trim(), "command").as_deref() == Some(cmd));
        for l in table {
            let too_long = toml_value(l.trim(), "timeout")
                .and_then(|v| v.parse::<f64>().ok())
                .is_some_and(|t| t > f64::from(CODEX_SESSION_END_TIMEOUT));
            if ours && too_long {
                let eol = if l.ends_with("\r\n") { "\r\n" } else if l.ends_with('\n') { "\n" } else { "" };
                let indent = &l[..l.len() - l.trim_start().len()];
                out.push_str(&format!("{indent}timeout = {CODEX_SESSION_END_TIMEOUT}{eol}"));
                changed = true;
            } else {
                out.push_str(l);
            }
        }
        i = end;
    }
    changed.then_some(out)
}

/// Testable core of [`register_codex_hook`] against an explicit config path.
/// Appends one block per event of [`CODEX_HOOK_EVENTS`] the file does not
/// already hold.
fn register_codex_hook_in(config: &HomeFile) -> std::io::Result<()> {
    register_codex_hook_as(config, &hook_command())
}

/// [`register_codex_hook_in`] for a given hook command.
pub(crate) fn register_codex_hook_as(config: &HomeFile, cmd: &str) -> std::io::Result<()> {
    let mut content = config
        .read()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    let capped = cap_codex_session_end_timeout(&content, cmd);
    let changed = capped.is_some();
    if let Some(c) = capped {
        content = c;
    }
    let have = codex_registered_events(&content, cmd);
    let missing: Vec<&str> = CODEX_HOOK_EVENTS
        .iter()
        .copied()
        .filter(|ev| !have.contains(*ev))
        .collect();
    if missing.is_empty() {
        if changed {
            config.write(content.as_bytes())?;
        }
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(
        concat!("\n# ", crate::app_name!(), ": record the live Codex session id and turn state per tab so ", crate::app_name!(), "\n\
         # can resume the current session (incl. after /clear) and mark the tab\n\
         # working / finished. Keyed by $", crate::app_upper!(), "_TAB_UID; a no-op for any Codex not\n\
         # launched by ", crate::app_name!(), ". Managed by ", crate::app_name!(), ".\n"),
    );
    for ev in missing {
        // Only SessionStart has a source to match on; the others fire for every
        // prompt, tool and end.
        let matcher = if ev == "SessionStart" {
            "matcher = \"startup|resume|clear|compact\"\n"
        } else {
            ""
        };
        let timeout = if ev == "SessionEnd" { CODEX_SESSION_END_TIMEOUT } else { 10 };
        content.push_str(&format!(
            "[[hooks.{ev}]]\n\
             {matcher}\n\
             [[hooks.{ev}.hooks]]\n\
             type = \"command\"\n\
             command = '{cmd}'\n\
             timeout = {timeout}\n\n",
        ));
    }
    config.write(content.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests;
