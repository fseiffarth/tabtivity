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
        _ => opts,
    }
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
        let Ok(raw) = std::fs::read_to_string(path.join("meta.json")) else {
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
fn codex_session_log(root: &std::path::Path, uuid: &str) -> Option<PathBuf> {
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
    vec![crate::services::agent_home::scope_home(project_id)
        .join(".claude")
        .join("projects")]
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
fn claude_session_exists(projects: &std::path::Path, uuid: &str) -> bool {
    claude_session_log(projects, uuid).is_some()
}

/// The session log behind [`claude_session_exists`], when there is one.
fn claude_session_log(projects: &std::path::Path, uuid: &str) -> Option<PathBuf> {
    let file = format!("{uuid}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(&file))
        .find(|path| path.is_file())
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
    let content = value.get("message")?.get("content")?.as_str()?;
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
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(tail);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 {
        // Whatever came before the seek point is missing from the first line.
        lines.remove(0);
    }
    read(&lines)
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
            if value.get("type").and_then(|t| t.as_str()) == Some("user") {
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
    let content = value.get("message")?.get("content")?.as_str()?;
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
    };
    clean_prompt_text(&raw)
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
    live_sessions_dir().join(sanitize_project_key(project_id))
}

/// Reduce a project id to a single path-safe component — the shared
/// [`storage::project_key`], which is also what names the per-project session
/// directory and the sandbox's container. One reduction, one answer.
fn sanitize_project_key(id: &str) -> String {
    storage::project_key(id)
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
fn live_record_dir(project_id: Option<&str>, uid: &str) -> Option<PathBuf> {
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
    std::fs::write(dir.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "resume")?;
    write_live_session_in(dir, uid, cleared)
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
    let raw = std::fs::read_to_string(dir.join(format!("{uid}{LIVE_CLEARED_SUFFIX}"))).ok()?;
    let cleared = raw.trim().to_string();
    (is_uuidish(&cleared) && cleared != live && session_exists(&cleared)).then_some(cleared)
}

/// The `SessionStart` source recorded beside `uid`'s session record in `dir`.
pub fn read_live_source_in(dir: &std::path::Path, uid: &str) -> Option<String> {
    if !is_uuid_shaped(uid) {
        return None;
    }
    let raw = std::fs::read_to_string(dir.join(format!("{uid}{LIVE_SOURCE_SUFFIX}"))).ok()?;
    let word = raw.trim().to_string();
    is_session_source(&word).then_some(word)
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
    let raw = std::fs::read_to_string(dir.join(uid)).ok()?;
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
    let raw = std::fs::read_to_string(dir.join(format!("{uid}.mode"))).ok()?;
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
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{uid}.tmp"));
    std::fs::write(&tmp, id)?;
    std::fs::rename(&tmp, dir.join(uid))?;
    Ok(())
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
    let src = std::fs::read_to_string(&config).unwrap_or_default();
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

/// Install (idempotently) the session hooks and their script for every agent
/// Tabtivity can track (Claude + Codex), so it learns each tab's live session id,
/// its live permission mode (Claude's `Stop`), and its turn state (see
/// [`HOOK_EVENTS`] and `services::agent_turn`). Safe to call on every startup.
/// The shared script keys by `$TABTIVITY_TAB_UID` and reads `session_id` from the
/// hook's stdin JSON — both CLIs use that schema.
pub fn install_session_start_hook() -> std::io::Result<()> {
    write_hook_script()?;
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
            file.write(fresh.as_bytes())?;
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
/// processes (POSIX, via `/proc`): a `claude -p --resume <id>` run from the
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
         \x20        # above it, a nested one has. Without /proc nothing is counted and\n\
         \x20        # the start is taken.\n\
         \x20        clear|resume) n=0; p=$PPID\n\
         \x20          while [ -r \"/proc/$p/environ\" ] && tr '\\0' '\\n' < \"/proc/$p/environ\" | grep -qx \"[A-Z]*_TAB_UID=${UPPER}_TAB_UID\"; do\n\
         \x20            [ \"$(cat \"/proc/$p/comm\" 2>/dev/null)\" = claude ] && n=$((n + 1))\n\
         \x20            p=$(sed 's/.*) [^ ]* \\([0-9]*\\).*/\\1/' \"/proc/$p/stat\" 2>/dev/null)\n\
         \x20          done\n\
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
         \x20   [ \"$event\" = SessionStart ] && [ -n \"$src\" ] && printf '%s' \"$src\" > \"$dir/${UPPER}_TAB_UID.src\"\n\
         \x20   printf '%s' \"$sid\" > \"$dir/${UPPER}_TAB_UID\"\n\
         \x20   [ -n \"$mode\" ] && printf '%s' \"$mode\" > \"$dir/${UPPER}_TAB_UID.mode\" ;;\n\
         esac\n\
         exit 0\n",
        live_dir = live_dir,
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
    let live_dir = live_dir.replace('\'', "''");
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
         if (-not $m.Success) {{ exit 0 }}\r\n\
         $sid = $m.Groups[1].Value\r\n\
         $event = ''\r\n\
         if ($me.Success) {{ $event = $me.Groups[1].Value }}\r\n\
         $ntype = ''\r\n\
         if ($mn.Success) {{ $ntype = $mn.Groups[1].Value }}\r\n\
         $dir = '{live_dir}'\r\n\
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
/// Earlier builds wrote `timeout = 10` there. Codex's trust hash does not
/// cover the timeout (checked live on 0.161.0: the lowered hook stays trusted,
/// no review menu), so the rewrite costs no re-approval. Other tables and
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
mod tests {
    use crate::brand::SLUG;
    use super::*;

    /// A link at a hook file — planted by a fenced agent, or the old fence's
    /// stage link — is replaced by a plain file; its target is never read or
    /// written.
    #[cfg(unix)]
    #[test]
    fn hook_registration_replaces_a_link_instead_of_following_it() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside.toml");
        std::fs::write(&outside, "model = \"o3\"\n").unwrap();
        let home = tmp.path().join("home");
        let codex = home.join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        let config = codex.join("config.toml");
        std::os::unix::fs::symlink(&outside, &config).unwrap();
        register_codex_hook_in(&HomeFile::open(&home, ".codex/config.toml").unwrap()).unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "model = \"o3\"\n");
        assert!(std::fs::symlink_metadata(&config).unwrap().is_file());
        let out = std::fs::read_to_string(&config).unwrap();
        assert!(out.contains("[[hooks.SessionStart]]"));
        assert!(!out.contains("model"));

        let outside_json = tmp.path().join("outside.json");
        std::fs::write(&outside_json, "{}").unwrap();
        let settings = home.join(".claude/settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&outside_json, &settings).unwrap();
        register_hook_in_settings(&HomeFile::open(&home, ".claude/settings.json").unwrap()).unwrap();
        assert_eq!(std::fs::read_to_string(&outside_json).unwrap(), "{}");
        assert!(std::fs::symlink_metadata(&settings).unwrap().is_file());

        let outside_hooks = tmp.path().join("outside-hooks.toml");
        std::fs::write(&outside_hooks, "").unwrap();
        let vibe = home.join(".vibe");
        std::fs::create_dir_all(&vibe).unwrap();
        std::os::unix::fs::symlink(&outside_hooks, vibe.join("hooks.toml")).unwrap();
        write_vibe_hooks(&HomeFile::open(&home, ".vibe/hooks.toml").unwrap(), false).unwrap();
        assert_eq!(std::fs::read_to_string(&outside_hooks).unwrap(), "");
        assert!(std::fs::symlink_metadata(vibe.join("hooks.toml")).unwrap().is_file());

        // The directory swapped after the file's handle was opened: the
        // registration lands in the moved directory, never at the link.
        let settings = HomeFile::open(&home, ".claude/settings.json").unwrap();
        std::fs::rename(home.join(".claude"), home.join(".claude.moved")).unwrap();
        std::os::unix::fs::symlink(tmp.path(), home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude.moved/settings.json"), "{\"model\": \"x\"}").unwrap();
        register_hook_in_settings(&settings).unwrap();
        assert!(!tmp.path().join("settings.json").exists());
        let moved = std::fs::read_to_string(home.join(".claude.moved/settings.json")).unwrap();
        assert!(moved.contains("\"model\": \"x\"") && moved.contains(&hook_command()));

        // A linked config dir is skipped altogether.
        let home = tmp.path().join("linked");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("home/.codex"), home.join(".codex")).unwrap();
        register_hooks_in_home(&home);
        assert!(std::fs::symlink_metadata(home.join(".codex")).unwrap().file_type().is_symlink());
    }

    // ── agent session resolution ────────────────────────────────────────────

    /// Process-and-test-unique temp path. Tests run in parallel threads sharing
    /// one pid, so a counter keeps each test's dir distinct.
    fn unique_tmp(prefix: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()))
    }

    fn opts_with_args(args: &[&str]) -> PtyOptions {
        PtyOptions {
            id: "t".to_string(),
            cmd: "claude".to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
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
        }
    }

    #[test]
    fn vibe_resumes_its_own_recorded_session_and_preserves_legacy_fallback() {
        let home = unique_tmp(concat!(crate::app_slug!(), "-vibe-resume"));
        let sessions = home.join("logs/session");
        let uid = "11111111-2222-4333-8444-555555555555";
        let own = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let other = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
        std::fs::create_dir_all(sessions.join("unified").join(own)).unwrap();
        std::fs::write(sessions.join("unified").join(own).join("CURRENT"), "1").unwrap();
        let legacy = sessions.join("session_20260923_120000_ffffffff");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("meta.json"), format!("{{\"session_id\":\"{other}\"}}")).unwrap();

        let mut opts = opts_with_args(&["--continue"]);
        opts.cmd = "vibe".into();
        opts.env.insert(crate::app_env!("TAB_UID").into(), uid.into());
        let exact = resolve_vibe_session_impl(opts.clone(), &home, |_| Some(own.into()));
        assert_eq!(exact.args, ["--resume", own]);
        assert_eq!(exact.env.get(TAB_AGENT_ENV).map(String::as_str), Some("vibe"));
        let legacy_exact = resolve_vibe_session_impl(opts.clone(), &home, |_| Some(other.into()));
        assert_eq!(legacy_exact.args, ["--resume", other]);
        let missing = resolve_vibe_session_impl(opts, &home, |_| Some("cccccccc-dddd-4eee-8fff-000000000000".into()));
        assert_eq!(missing.args, ["--continue"]);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn vibe_hook_registration_preserves_existing_hooks_and_is_idempotent() {
        let home = unique_tmp(concat!(crate::app_slug!(), "-vibe-hooks"));
        std::fs::create_dir_all(&home).unwrap();
        let hooks = home.join("hooks.toml");
        std::fs::write(&hooks, "[[hooks]]\nname = \"mine\"\ntype = \"post_agent\"\ncommand = \"true\"\n").unwrap();
        register_vibe_hook_in(&home).unwrap();
        let once = std::fs::read_to_string(&hooks).unwrap();
        register_vibe_hook_in(&home).unwrap();
        assert_eq!(std::fs::read_to_string(&hooks).unwrap(), once);
        assert!(once.contains("name = \"mine\""));
        assert_eq!(once.matches(concat!("name = \"", crate::app_slug!(), "-session\"")).count(), 1);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_local_model_home_keeps_only_apps_hook() {
        let home = unique_tmp(concat!(crate::app_slug!(), "-vibe-local-hooks"));
        std::fs::create_dir_all(&home).unwrap();
        let hooks = home.join("hooks.toml");
        std::fs::write(&hooks, "[[hooks]]\nname = \"planted\"\ntype = \"post_agent\"\ncommand = \"true\"\n").unwrap();
        let file = HomeFile::open(&home, "hooks.toml").unwrap();
        write_vibe_hooks(&file, true).unwrap();
        let once = std::fs::read_to_string(&hooks).unwrap();
        assert!(!once.contains("planted"));
        assert_eq!(once.matches(concat!("name = \"", crate::app_slug!(), "-session\"")).count(), 1);
        write_vibe_hooks(&file, true).unwrap();
        assert_eq!(std::fs::read_to_string(&hooks).unwrap(), once);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn only_a_direct_child_of_vibe_local_is_a_local_model_home() {
        let root = std::path::Path::new(concat!("/s/", crate::app_slug!(), "/vibe_local"));
        assert!(is_local_vibe_home_in(&root.join("gemma4-e4b"), root));
        assert!(!is_local_vibe_home_in(root, root));
        assert!(!is_local_vibe_home_in(&root.join("a/b"), root));
        assert!(!is_local_vibe_home_in(&root.join("../x"), root));
        assert!(!is_local_vibe_home_in(std::path::Path::new("/home/u/.vibe"), root));
    }

    #[cfg(unix)]
    #[test]
    fn vibe_hook_records_only_top_level_post_agent() {
        let home = unique_tmp(concat!(crate::app_slug!(), "-vibe-hook-run"));
        let live = home.join("live");
        std::fs::create_dir_all(&live).unwrap();
        let script = home.join("hook.sh");
        std::fs::write(&script, posix_hook_script_body(&live.to_string_lossy())).unwrap();
        let uid = "11111111-2222-4333-8444-555555555555";
        let own = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let nested = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
        let payload = |id: &str, parent: &str, event: &str| format!(
            "{{\"hook_event_name\":\"{event}\",\"session_id\":\"{id}\",\"parent_session_id\":{parent}}}"
        );
        assert_eq!(run_hook(&script, &live, uid, Some("vibe"), false,
            &payload(nested, "null", "post_tool")).0, None);
        assert_eq!(run_hook(&script, &live, uid, Some("vibe"), false,
            &payload(nested, &format!("\"{own}\""), "post_agent")).0, None);
        assert_eq!(run_hook(&script, &live, uid, Some("vibe"), false,
            &payload(own, "null", "post_agent")).0.as_deref(), Some(own));
        std::fs::remove_dir_all(home).unwrap();
    }

    /// Temp Claude `projects` root containing a persisted log for each given uuid.
    fn projects_with_sessions(uuids: &[&str]) -> std::path::PathBuf {
        let tmp = unique_tmp(concat!(crate::app_slug!(), "-resolve"));
        let proj = tmp.join("-encoded-cwd");
        std::fs::create_dir_all(&proj).unwrap();
        for u in uuids {
            std::fs::write(proj.join(format!("{u}.jsonl")), b"{}").unwrap();
        }
        tmp
    }

    #[test]
    fn resolve_dispatches_by_command() {
        // Non-tracked commands pass straight through.
        let mut opts = opts_with_args(&["--session-id", "abc-123"]);
        opts.cmd = "bash".to_string();
        let out = resolve_agent_session(opts);
        assert_eq!(out.cmd, "bash");
        assert_eq!(
            out.args,
            vec!["--session-id".to_string(), "abc-123".to_string()]
        );
    }

    #[test]
    fn resolve_is_a_noop_once_command_is_wrapped_to_ssh() {
        // Regression for the ssh-resume ordering bug: `wrap_pty_options` rewrites
        // `opts.cmd` to "ssh". If resolution ran AFTER wrapping, the dispatcher
        // would see "ssh" (not "claude"/"codex") and never inject resume args.
        // This asserts that an already-wrapped command is untouched, which is why
        // `pty_spawn` must resolve BEFORE wrapping.
        let mut opts = opts_with_args(&["-tt", "host", "exec claude --session-id abc"]);
        opts.cmd = "ssh".to_string();
        let out = resolve_agent_session(opts);
        assert_eq!(out.cmd, "ssh");
        assert_eq!(
            out.args,
            vec![
                "-tt".to_string(),
                "host".to_string(),
                "exec claude --session-id abc".to_string()
            ]
        );
        // And resume args are only ever injected while the command is still the
        // bare agent CLI (the pre-wrap state) — proven by the claude/codex tests.
    }

    #[test]
    fn resolve_keeps_session_id_when_no_log_exists() {
        // A never-used tab must not turn into `--resume` (Claude would exit with
        // "No conversation found with session ID ...").
        let uuid = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[]);
        let out =
            resolve_claude_session_impl(
                opts_with_args(&["--session-id", uuid]),
                &projects,
                |_| None,
                |_| None,
            );
        assert_eq!(out.args, vec!["--session-id".to_string(), uuid.to_string()]);
        // The launch id is always exposed to the SessionStart hook.
        assert_eq!(
            out.env.get(crate::app_env!("TAB_UID")).map(String::as_str),
            Some(uuid)
        );
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_resumes_launch_id_when_its_log_exists() {
        let uuid = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[uuid]);
        let out =
            resolve_claude_session_impl(
                opts_with_args(&["--session-id", uuid]),
                &projects,
                |_| None,
                |_| None,
            );
        assert_eq!(out.args, vec!["--resume".to_string(), uuid.to_string()]);
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_follows_live_id_after_clear() {
        // After /clear the hook records a fresh live id under the launch key; we
        // resume that, not the (pre-clear) launch id.
        let launch = "00000000-0000-0000-0000-000000000000";
        let live = "99999999-8888-7777-6666-555555555555";
        let projects = projects_with_sessions(&[launch, live]);
        let out = resolve_claude_session_impl(
            // restore path passes `--resume <launch>`; we rewrite the id to live.
            opts_with_args(&["--resume", launch]),
            &projects,
            |uid| (uid == launch).then(|| live.to_string()),
            |_| None,
        );
        assert_eq!(out.args, vec!["--resume".to_string(), live.to_string()]);
        assert_eq!(
            out.env.get(crate::app_env!("TAB_UID")).map(String::as_str),
            Some(launch)
        );
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn transcript_ids_skip_the_cleared_launch_only_when_asked() {
        let launch = "00000000-0000-0000-0000-000000000000";
        let live = "99999999-8888-7777-6666-555555555555";
        // Before any `/clear` no live id is recorded: the launch id either way.
        assert_eq!(claude_transcript_ids(None, launch, false), vec![launch.to_string()]);
        assert_eq!(claude_transcript_ids(None, launch, true), vec![launch.to_string()]);
        // After one, the prompt reads see only the new session — whose file
        // Claude writes with its first turn, so until then they see nothing.
        assert_eq!(claude_transcript_ids(Some(live.to_string()), launch, false), vec![live.to_string()]);
        assert_eq!(
            claude_transcript_ids(Some(live.to_string()), launch, true),
            vec![live.to_string(), launch.to_string()]
        );
    }

    #[test]
    fn resolve_downgrades_resume_without_log_to_session_id() {
        // Restore asked for `--resume <launch>` but no log exists (never-used tab)
        // → downgrade to `--session-id` so Claude starts fresh instead of erroring.
        let launch = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[]);
        let out =
            resolve_claude_session_impl(opts_with_args(&["--resume", launch]), &projects, |_| None, |_| None);
        assert_eq!(
            out.args,
            vec!["--session-id".to_string(), launch.to_string()]
        );
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_ignores_non_claude_commands() {
        let mut opts = opts_with_args(&["--session-id", "abc-123"]);
        opts.cmd = "bash".to_string();
        let projects = projects_with_sessions(&[]);
        let out = resolve_claude_session_impl(opts, &projects, |_| Some("x".to_string()), |_| None);
        assert_eq!(
            out.args,
            vec!["--session-id".to_string(), "abc-123".to_string()]
        );
        assert!(!out.env.contains_key(crate::app_env!("TAB_UID")));
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn claude_session_exists_detects_persisted_log() {
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-sess-test-{}"), std::process::id()));
        let proj = tmp.join("-some-encoded-cwd");
        std::fs::create_dir_all(&proj).unwrap();
        let uuid = "11111111-2222-3333-4444-555555555555";
        std::fs::write(proj.join(format!("{uuid}.jsonl")), b"{}").unwrap();

        assert!(claude_session_exists(&tmp, uuid));
        assert!(!claude_session_exists(&tmp, "no-such-uuid"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_leaves_args_without_session_flag_untouched() {
        let projects = projects_with_sessions(&[]);
        let out =
            resolve_claude_session_impl(opts_with_args(&["--foo", "bar"]), &projects, |_| None, |_| None);
        assert_eq!(out.args, vec!["--foo".to_string(), "bar".to_string()]);
        let _ = std::fs::remove_dir_all(&projects);
    }

    /// Temp Codex sessions root with a `YYYY/MM/DD/rollout-…-<uuid>.jsonl` log.
    fn codex_sessions_with(uuid: &str) -> std::path::PathBuf {
        let tmp = unique_tmp(concat!(crate::app_slug!(), "-codex-sess"));
        let day = tmp.join("2026").join("06").join("08");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            day.join(format!("rollout-2026-06-08T17-10-09-{uuid}.jsonl")),
            b"{}",
        )
        .unwrap();
        tmp
    }

    fn codex_opts() -> PtyOptions {
        let mut o = opts_with_args(&[]);
        o.cmd = "codex".to_string();
        o
    }

    #[test]
    fn codex_resumes_live_id_when_rollout_exists() {
        let live = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";
        let root = codex_sessions_with(live);
        let mut opts = codex_opts();
        opts.env
            .insert(crate::app_env!("TAB_UID").to_string(), "tab-key-123".to_string());
        let out = resolve_codex_session_impl(opts, &root, &[], |uid| {
            (uid == "tab-key-123").then(|| live.to_string())
        });
        assert_eq!(out.args, vec!["resume".to_string(), live.to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_starts_fresh_without_record_or_without_uid() {
        let root = codex_sessions_with("00000000-0000-0000-0000-000000000000");
        // No live record → fresh launch (args stay empty).
        let mut opts = codex_opts();
        opts.env
            .insert(crate::app_env!("TAB_UID").to_string(), "tab-key".to_string());
        let out = resolve_codex_session_impl(opts, &root, &[], |_| None);
        assert!(out.args.is_empty());
        // No TABTIVITY_TAB_UID at all → cannot track → fresh launch.
        let out2 =
            resolve_codex_session_impl(codex_opts(), &root, &[], |_| Some("x".to_string()));
        assert!(out2.args.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_ignores_when_recorded_session_missing_on_disk() {
        let root = codex_sessions_with("aaaaaaaa-0000-0000-0000-000000000000");
        let mut opts = codex_opts();
        opts.env
            .insert(crate::app_env!("TAB_UID").to_string(), "tab-key".to_string());
        // Recorded id has no rollout log → don't pass a bad `resume` arg.
        let out = resolve_codex_session_impl(opts, &root, &[], |_| {
            Some("ffffffff-1111-2222-3333-444444444444".to_string())
        });
        assert!(out.args.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The 0.153.4 regression: Codex records the thread in `state_<n>.sqlite`
    /// and writes no rollout file at all, so a sessions-only check finds
    /// nothing and the tab relaunches fresh.
    #[test]
    fn codex_resumes_a_thread_that_exists_only_in_the_sqlite_store() {
        let live = "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a";
        // A `sessions/` dir that is not merely empty but absent, as it is on a
        // machine where Codex never wrote one.
        let root = std::env::temp_dir().join(format!(
            "{SLUG}-codex-nosessions-{}-{live}",
            std::process::id()
        ));
        let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-codex-db-{}"), std::process::id()));
        // A store left behind by an earlier run would fail the CREATE below.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("state_5.sqlite");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO threads (id) VALUES (?1)", [live])
            .unwrap();
        drop(conn);

        let mut opts = codex_opts();
        opts.env
            .insert(crate::app_env!("TAB_UID").to_string(), "tab-key".to_string());
        let out = resolve_codex_session_impl(opts, &root, std::slice::from_ref(&db), |_| {
            Some(live.to_string())
        });
        assert_eq!(out.args, vec!["resume".to_string(), live.to_string()]);

        // An id neither store has heard of still starts fresh.
        let mut other = codex_opts();
        other
            .env
            .insert(crate::app_env!("TAB_UID").to_string(), "tab-key".to_string());
        let out = resolve_codex_session_impl(other, &root, std::slice::from_ref(&db), |_| {
            Some("ffffffff-1111-2222-3333-444444444444".to_string())
        });
        assert!(out.args.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_does_not_resume_an_archived_thread_with_a_rollout() {
        let archived = "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a";
        let root = codex_sessions_with(archived);
        let db = root.join("state_5.sqlite");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO threads (id, archived) VALUES (?1, 1)", [archived])
            .unwrap();
        drop(conn);

        assert!(!codex_session_exists(&root, Some(&db), archived));
        let mut opts = codex_opts();
        opts.env
            .insert(crate::app_env!("TAB_UID").to_string(), "tab-key".to_string());
        let out = resolve_codex_session_impl(opts, &root, std::slice::from_ref(&db), |_| {
            Some(archived.to_string())
        });
        assert!(out.args.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── hook installer ──────────────────────────────────────────────────────

    #[test]
    fn read_live_session_round_trips_and_rejects_junk() {
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-live-{}"), std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let uid = "11111111-2222-3333-4444-555555555555";
        let live = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        std::fs::write(tmp.join(uid), format!("{live}\n")).unwrap();

        assert_eq!(read_live_session_in(&tmp, uid).as_deref(), Some(live));
        assert_eq!(read_live_session_in(&tmp, "no-such-uid"), None);
        // path-traversal / non-uuid keys are refused before any read.
        assert_eq!(read_live_session_in(&tmp, "../etc/passwd"), None);

        // malformed stored value is rejected.
        std::fs::write(tmp.join(uid), "not a uuid!").unwrap();
        assert_eq!(read_live_session_in(&tmp, uid), None);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn tab_keys_must_be_uuid_shaped_before_becoming_a_path_component() {
        // `TABTIVITY_TAB_UID` arrives in the renderer-supplied `PtyOptions.env`, so the
        // key is validated by SHAPE rather than by "happens to contain no slash".
        assert!(is_uuid_shaped("11111111-2222-3333-4444-555555555555"));
        assert!(is_uuid_shaped("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"));
        assert!(!is_uuid_shaped(""));
        assert!(!is_uuid_shaped("----"));
        assert!(!is_uuid_shaped("deadbeef"));
        assert!(!is_uuid_shaped("../etc/passwd"));
        assert!(!is_uuid_shaped(
            "11111111-2222-3333-4444-555555555555-extra"
        ));
        assert!(!is_uuid_shaped("11111111-2222-3333-4444-55555555555"));
        assert!(!is_uuid_shaped("g1111111-2222-3333-4444-555555555555"));
        // A key that only passed the looser value guard is now refused as a key.
        assert!(is_uuidish("deadbeef"));
        assert!(!is_uuid_shaped("deadbeef"));
    }

    #[test]
    fn per_project_live_session_records_are_separate_and_the_newer_one_wins() {
        // The S-4 primitive: with one shared directory a contained agent could
        // overwrite another project's tab record and so pick which conversation an
        // UNCONTAINED agent resumes. Records now live in per-project subdirs.
        let root = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-live-pp-{}"), std::process::id()));
        let own = root.join("p1");
        std::fs::create_dir_all(&own).unwrap();
        let uid = "11111111-2222-3333-4444-555555555555";
        let host_id = "aaaaaaaa-1111-1111-1111-111111111111";
        let contained_id = "bbbbbbbb-2222-2222-2222-222222222222";

        // Host-run agent's record (shared root) only.
        std::fs::write(root.join(uid), host_id).unwrap();
        assert_eq!(read_live_session_in(&root, uid).as_deref(), Some(host_id));
        assert_eq!(read_live_session_in(&own, uid), None);

        // The containerized agent's own record, written later, wins.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(own.join(uid), contained_id).unwrap();
        assert_eq!(
            read_live_session_in(&own, uid).as_deref(),
            Some(contained_id)
        );

        // A DIFFERENT project's subdir is not consulted for this project.
        let other = root.join("p2");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join(uid), "cccccccc-3333-3333-3333-333333333333").unwrap();
        assert_eq!(
            read_live_session_in(&own, uid).as_deref(),
            Some(contained_id)
        );

        // The source record sits beside the id in whichever root holds it, and
        // only a word the hook can have written counts.
        assert_eq!(read_live_source_in(&own, uid), None);
        std::fs::write(own.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "clear\n").unwrap();
        assert_eq!(read_live_source_in(&own, uid).as_deref(), Some("clear"));
        std::fs::write(own.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "--resume x").unwrap();
        assert_eq!(read_live_source_in(&own, uid), None);
        assert_eq!(read_live_source_in(&own, "not-a-uid"), None);

        // "Undo clear" names the cleared conversation only while the session is
        // the one that clear started, the record is an id, and its transcript
        // is there to resume.
        let cleared = "dddddddd-4444-4444-4444-444444444444";
        let prev_path = own.join(format!("{uid}{LIVE_CLEARED_SUFFIX}"));
        assert_eq!(cleared_session_in(&own, uid, |_| true), None);
        std::fs::write(&prev_path, format!("{cleared}\n")).unwrap();
        assert_eq!(cleared_session_in(&own, uid, |_| true), None, "source is not clear");
        std::fs::write(own.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "clear").unwrap();
        assert_eq!(cleared_session_in(&own, uid, |_| true).as_deref(), Some(cleared));
        assert_eq!(cleared_session_in(&own, uid, |id| id != cleared), None, "no transcript");
        std::fs::write(&prev_path, contained_id).unwrap();
        assert_eq!(cleared_session_in(&own, uid, |_| true), None, "that is the live session");
        std::fs::write(&prev_path, "../../etc/passwd").unwrap();
        assert_eq!(cleared_session_in(&own, uid, |_| true), None);
        std::fs::write(own.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "resume").unwrap();

        // Codex's undo points the record back at the cleared conversation and
        // calls it a resume: the relaunch resumes it, and no second undo is left.
        std::fs::write(own.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "clear").unwrap();
        std::fs::write(&prev_path, cleared).unwrap();
        restore_cleared_in(&own, uid, cleared).unwrap();
        assert_eq!(read_live_session_in(&own, uid).as_deref(), Some(cleared));
        assert_eq!(read_live_source_in(&own, uid).as_deref(), Some("resume"));
        assert_eq!(cleared_session_in(&own, uid, |_| true), None);
        // An agent without an id to resume by gets no plan from here; the window
        // relaunches it on its own resume flag.
        assert_eq!(undo_clear_plan("gemini", None, uid), None);

        // The project id is reduced to exactly one path-safe component.
        assert_eq!(sanitize_project_key("my proj/../x"), "my_proj____x");
        assert_eq!(sanitize_project_key(""), "x");
        assert!(project_live_sessions_dir("p1").ends_with("live_sessions/p1"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(windows))]
    #[test]
    fn hook_body_is_no_op_without_env_and_bakes_dir() {
        let body = hook_script_body(concat!("/home/x/.local/share/", crate::app_slug!(), "/live_sessions"));
        assert!(body.starts_with("#!/bin/sh"));
        assert!(body.contains(concat!("[ -n \"$", crate::app_upper!(), "_TAB_UID\" ] || exit 0")));
        assert!(body.contains(concat!("/home/x/.local/share/", crate::app_slug!(), "/live_sessions")));
        assert!(body.contains("\"session_id\""));
        assert!(body.contains("\"permission_mode\""));
        assert!(body.contains(".mode"));
    }

    #[cfg(windows)]
    #[test]
    fn hook_body_is_no_op_without_env_and_bakes_dir() {
        let body = hook_script_body(concat!(r"C:\Users\x\AppData\Roaming\", crate::app_slug!(), r"\live_sessions"));
        assert!(body.contains(concat!("$uid = $env:", crate::app_upper!(), "_TAB_UID")));
        assert!(body.contains("if ([string]::IsNullOrEmpty($uid)) { exit 0 }"));
        assert!(body.contains(concat!(r"C:\Users\x\AppData\Roaming\", crate::app_slug!(), r"\live_sessions")));
        assert!(body.contains("\"session_id\""));
        assert!(body.contains("\"permission_mode\""));
        assert!(body.contains(".mode"));
        // The container twin bakes the container-side path, POSIX-style.
        let twin = posix_hook_script_body(concat!("/c/Users/x/AppData/Roaming/", crate::app_slug!(), "/live_sessions"));
        assert!(twin.starts_with("#!/bin/sh"));
        assert!(twin.contains(concat!("/c/Users/x/AppData/Roaming/", crate::app_slug!(), "/live_sessions")));
    }

    /// Run the POSIX hook body as the agents would: `sh <script>` with the tab
    /// env and the hook JSON on stdin. Returns the record and mode files' text.
    #[cfg(unix)]
    fn run_hook(
        script: &std::path::Path,
        live_dir: &std::path::Path,
        uid: &str,
        agent: Option<&str>,
        claudecode: bool,
        payload: &str,
    ) -> (Option<String>, Option<String>) {
        use std::io::Write as _;
        let mut cmd = std::process::Command::new("sh");
        cmd.arg(script)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env(crate::app_env!("TAB_UID"), uid)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if let Some(a) = agent {
            cmd.env(TAB_AGENT_ENV, a);
        }
        if claudecode {
            cmd.env("CLAUDECODE", "1");
        }
        let mut child = cmd.spawn().expect("sh");
        child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        let read = |name: String| std::fs::read_to_string(live_dir.join(name)).ok();
        (read(uid.to_string()), read(format!("{uid}.mode")))
    }

    #[cfg(unix)]
    #[test]
    fn phone_hint_only_reaches_a_scoped_claude_or_codex_session_start() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("hook.sh");
        std::fs::write(&script, posix_hook_script_body(&dir.path().join("live").to_string_lossy())).unwrap();
        for (agent, scoped, sid, event, expected) in [
            ("claude", true, "aaaa", "SessionStart", true),
            ("claude", false, "aaaa", "SessionStart", false),
            ("claude", true, "bbbb", "SessionStart", false),
            ("claude", true, "aaaa", "Stop", false),
            ("codex", true, "cccc", "SessionStart", true),
            ("codex", false, "cccc", "SessionStart", false),
            ("codex", true, "cccc", "Stop", false),
        ] {
            let mut cmd = std::process::Command::new("sh");
            cmd.arg(&script).env_clear().env("PATH", std::env::var_os("PATH").unwrap_or_default())
                .env(crate::app_env!("TAB_UID"), "aaaa").env(crate::app_env!("TAB_AGENT"), agent)
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
            if scoped { cmd.env(crate::app_env!("PROJECT_DIR"), dir.path()); }
            let mut child = cmd.spawn().unwrap();
            write!(child.stdin.take().unwrap(), "{{\"session_id\":\"{sid}\",\"hook_event_name\":\"{event}\",\"source\":\"startup\"}}").unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success());
            assert_eq!(String::from_utf8_lossy(&out.stdout).contains(concat!(crate::app_slug!(), "-send <file>")), expected, "{agent} {scoped} {sid} {event}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn hook_script_lets_only_the_tabs_own_session_move_the_record() {
        let tmp = unique_tmp(concat!(crate::app_slug!(), "-hook-run"));
        let live = tmp.join("live");
        std::fs::create_dir_all(&tmp).unwrap();
        let script = tmp.join("hook.sh");
        std::fs::write(&script, hook_script_body(&live.to_string_lossy())).unwrap();
        let uid = "11111111-1111-4111-8111-111111111111";
        let nested = "22222222-2222-4222-8222-222222222222";
        let cleared = "33333333-3333-4333-8333-333333333333";
        let start = |sid: &str, src: &str| {
            format!(r#"{{"session_id":"{sid}","hook_event_name":"SessionStart","source":"{src}"}}"#)
        };
        let stop = |sid: &str, mode: &str| {
            format!(r#"{{"session_id":"{sid}","hook_event_name":"Stop","permission_mode":"{mode}"}}"#)
        };
        let claude = Some("claude");

        // The tab's own start records its launch id and how it started; Stop
        // records the mode and leaves the source alone.
        let source = || read_live_source_in(&live, uid);
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(uid, "startup"));
        assert_eq!(rec.as_deref(), Some(uid));
        assert_eq!(source().as_deref(), Some("startup"));
        let (rec, mode) = run_hook(&script, &live, uid, claude, true, &stop(uid, "acceptEdits"));
        assert_eq!(rec.as_deref(), Some(uid));
        assert_eq!(mode.as_deref(), Some("acceptEdits"));
        assert_eq!(source().as_deref(), Some("startup"));

        // A nested `claude -p` under the tab (same env, CLAUDECODE set) is refused
        // on both events: neither record moves.
        let (rec, mode) = run_hook(&script, &live, uid, claude, true, &start(nested, "startup"));
        assert_eq!(rec.as_deref(), Some(uid));
        assert_eq!(mode.as_deref(), Some("acceptEdits"));
        let (rec, mode) = run_hook(&script, &live, uid, claude, true, &stop(nested, "default"));
        assert_eq!(rec.as_deref(), Some(uid));
        assert_eq!(mode.as_deref(), Some("acceptEdits"));
        assert_eq!(source().as_deref(), Some("startup"));

        // `/clear` rolls the id — and says so — and the following Stop is
        // accepted for the new one.
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(cleared, "clear"));
        assert_eq!(rec.as_deref(), Some(cleared));
        assert_eq!(source().as_deref(), Some("clear"));
        // The conversation the clear ended is kept beside it, for "Undo clear".
        let prev = || std::fs::read_to_string(live.join(format!("{uid}{LIVE_CLEARED_SUFFIX}"))).ok();
        assert_eq!(prev().as_deref(), Some(uid));
        assert_eq!(cleared_session_in(&live, uid, |_| true).as_deref(), Some(uid));
        let (rec, mode) = run_hook(&script, &live, uid, claude, true, &stop(cleared, "plan"));
        assert_eq!(rec.as_deref(), Some(cleared));
        assert_eq!(mode.as_deref(), Some("plan"));
        // A session command reported as a prompt leaves the undo standing; a
        // prompt in the new chat ends it — resuming the cleared conversation
        // would leave that prompt behind (a second `/clear` queued behind its
        // turn was undone onto the first clear's conversation).
        let prompt = |text: &str| {
            format!(r#"{{"session_id":"{cleared}","hook_event_name":"UserPromptSubmit","prompt":"{text}"}}"#)
        };
        run_hook(&script, &live, uid, claude, true, &prompt("/clear"));
        assert_eq!(cleared_session_in(&live, uid, |_| true).as_deref(), Some(uid));
        run_hook(&script, &live, uid, claude, true, &prompt("fix the build"));
        assert_eq!(prev(), None);
        assert_eq!(cleared_session_in(&live, uid, |_| true), None);
        // …and the launch id itself is always the tab's (a relaunch on `--resume
        // <launch>` after a lost record) — that resume is also the undo, after
        // which there is no clear left to take back.
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(uid, "resume"));
        assert_eq!(rec.as_deref(), Some(uid));
        assert_eq!(cleared_session_in(&live, uid, |_| true), None);
        // A `resume` start to another conversation is the user's choice.
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(nested, "resume"));
        assert_eq!(rec.as_deref(), Some(nested));
        assert_eq!(source().as_deref(), Some("resume"));

        // A Codex started from the tab's shell fires the same `clear` start
        // after its own `/clear` — with no rollout yet (null) or a rollout file,
        // never Claude's `<session_id>.jsonl`. It must not take the record.
        let codex_nested = "01a0d043-b4df-7e63-9813-002da0a652e9";
        let codex_start = |path: &str| {
            format!(r#"{{"session_id":"{codex_nested}","transcript_path":{path},"cwd":"/p","hook_event_name":"SessionStart","model":"m","permission_mode":"default","source":"clear"}}"#)
        };
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &codex_start("null"));
        assert_eq!(rec.as_deref(), Some(nested));
        let rollout = format!(r#""/h/.codex/sessions/2026/09/23/rollout-2026-09-23T23-54-53-{codex_nested}.jsonl""#);
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &codex_start(&rollout));
        assert_eq!(rec.as_deref(), Some(nested));
        assert_eq!(source().as_deref(), Some("resume"));
        // Claude's own `/clear` names its transcript after the new session.
        let claude_clear = format!(
            r#"{{"session_id":"{cleared}","transcript_path":"/h/.claude/projects/-p/{cleared}.jsonl","hook_event_name":"SessionStart","source":"clear"}}"#
        );
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &claude_clear);
        assert_eq!(rec.as_deref(), Some(cleared));
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(nested, "resume"));
        assert_eq!(rec.as_deref(), Some(nested));

        // No agent marker (an older launch): the strict rule applies.
        let (rec, _) = run_hook(&script, &live, uid, None, true, &start(cleared, "startup"));
        assert_eq!(rec.as_deref(), Some(nested));

        // A Codex tab mints its own ids, so its record is free-form — but a
        // Claude fired under it (CLAUDECODE set) is refused.
        let codex_uid = "44444444-4444-4444-8444-444444444444";
        let codex_id = "55555555-5555-4555-8555-555555555555";
        let (rec, _) = run_hook(&script, &live, codex_uid, Some("codex"), false, &start(codex_id, "startup"));
        assert_eq!(rec.as_deref(), Some(codex_id));
        let (rec, _) = run_hook(&script, &live, codex_uid, Some("codex"), true, &start(nested, "startup"));
        assert_eq!(rec.as_deref(), Some(codex_id));

        // No session id → nothing written, not even a mode.
        let other = "66666666-6666-4666-8666-666666666666";
        let (rec, mode) = run_hook(&script, &live, other, claude, true, r#"{"permission_mode":"plan"}"#);
        assert!(rec.is_none() && mode.is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A `claude --resume` (or a `/clear`) nested under the tab's own Claude —
    /// the agent's Bash tool running the CLI — sends the same start a `/resume`
    /// typed in the tab does. Only the process chain tells them apart: a
    /// `claude` (here: `sh` under that name) under another one, both carrying
    /// the tab's id, is refused; one alone, or under a `claude` that is not the
    /// tab's, is followed.
    #[cfg(target_os = "linux")]
    #[test]
    fn hook_script_refuses_a_clear_or_resume_from_a_claude_nested_under_the_tabs() {
        let tmp = unique_tmp(concat!(crate::app_slug!(), "-hook-nested"));
        let live = tmp.join("live");
        let bin = tmp.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let script = tmp.join("hook.sh");
        std::fs::write(&script, hook_script_body(&live.to_string_lossy())).unwrap();
        let claude_bin = bin.join("claude");
        std::os::unix::fs::symlink("/bin/sh", &claude_bin).unwrap();
        let uid = "11111111-1111-4111-8111-111111111111";
        let other = "22222222-2222-4222-8222-222222222222";
        let payload = tmp.join("payload.json");
        // `; true` keeps each shell alive under its command (no exec tail call).
        let hook = r#"sh "$SCRIPT" < "$PAYLOAD"; true"#;
        // An install upgraded across the rename: the hook takes the tab id from
        // the legacy name when the current one is unset, and the tab carries both.
        let legacy_script = tmp.join("hook-legacy.sh");
        let legacy_preamble =
            crate::services::brand_migration::compat::legacy_env_preamble_sh(&crate::brand::PAIR, HOOK_ENV);
        assert!(!legacy_preamble.is_empty());
        std::fs::write(&legacy_script, legacy_preamble + &hook_script_body(&live.to_string_lossy())).unwrap();
        let legacy_tab_uid = crate::brand::PAIR.legacy_env_name("TAB_UID").unwrap();
        let run_with = |script: &std::path::Path, legacy: bool, src: &str, chain: &str| {
            std::fs::create_dir_all(&live).unwrap();
            std::fs::write(live.join(uid), uid).unwrap();
            std::fs::write(&payload, format!(r#"{{"session_id":"{other}","hook_event_name":"SessionStart","source":"{src}"}}"#)).unwrap();
            let mut cmd = std::process::Command::new(&claude_bin);
            cmd.arg("-c")
                .arg(chain)
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap_or_default())
                .env(crate::app_env!("TAB_UID"), uid)
                .env(TAB_AGENT_ENV, "claude")
                .env("SCRIPT", script)
                .env("PAYLOAD", &payload)
                .env("CLAUDE_BIN", &claude_bin)
                .env("HOOK", hook);
            if legacy {
                cmd.env(&legacy_tab_uid, uid);
            }
            assert!(cmd.status().unwrap().success());
            std::fs::read_to_string(live.join(uid)).unwrap()
        };
        let run = |src: &str, chain: &str| run_with(&script, false, src, chain);
        let alone = format!("{hook}; true");
        let nested = r#""$CLAUDE_BIN" -c "$HOOK"; true"#.to_string();
        // A `claude` above the tab's own (the app launched from a Claude session).
        let tab_uid = crate::app_env!("TAB_UID");
        let outside = format!(r#"env -u {tab_uid} "$CLAUDE_BIN" -c '{tab_uid}="$0" "$CLAUDE_BIN" -c "$HOOK"; true' "${tab_uid}"; true"#);
        for src in ["resume", "clear"] {
            assert_eq!(run(src, &alone), other, "{src} from the tab's own claude");
            assert_eq!(run(src, &nested), uid, "{src} from a claude nested under it");
            assert_eq!(run(src, &outside), other, "{src} under a claude outside the tab");
            // A probe that unsets only the current name still reaches the hook
            // through the legacy one — and must still be seen as nested.
            let half_unset = format!(r#"env -u {tab_uid} "$CLAUDE_BIN" -c "$HOOK"; true"#);
            assert_eq!(run_with(&legacy_script, true, src, &half_unset), uid, "{src} nested, current name unset");
            assert_eq!(run_with(&legacy_script, true, src, &alone), other, "{src} from the tab's own claude, legacy install");
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Claude relaunching itself before the first prompt (renderer switch,
    /// update) comes back under a fresh id with a plain `startup`: the record
    /// follows it while the tab's own session has no transcript, and only then.
    #[cfg(unix)]
    #[test]
    fn hook_script_follows_a_relaunch_that_minted_a_fresh_id() {
        let tmp = unique_tmp(concat!(crate::app_slug!(), "-hook-relaunch"));
        let live = tmp.join("live");
        let transcripts = tmp.join("projects").join("-p");
        std::fs::create_dir_all(&transcripts).unwrap();
        let script = tmp.join("hook.sh");
        std::fs::write(&script, hook_script_body(&live.to_string_lossy())).unwrap();
        let uid = "11111111-1111-4111-8111-111111111111";
        let fresh = "22222222-2222-4222-8222-222222222222";
        let again = "33333333-3333-4333-8333-333333333333";
        let path = |sid: &str| transcripts.join(format!("{sid}.jsonl"));
        let start = |sid: &str, tpath: &str| {
            format!(r#"{{"session_id":"{sid}","transcript_path":{tpath},"hook_event_name":"SessionStart","source":"startup"}}"#)
        };
        let own = |sid: &str| format!("\"{}\"", path(sid).display());
        let claude = Some("claude");
        let source = || read_live_source_in(&live, uid);

        // The launch id starts the tab; nothing has been written for it yet.
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(uid, &own(uid)));
        assert_eq!(rec.as_deref(), Some(uid));
        // A Codex under the tab (null path, then a rollout) is still refused.
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(fresh, "null"));
        assert_eq!(rec.as_deref(), Some(uid));
        let rollout = format!(r#""/h/.codex/sessions/rollout-2026-09-25T20-46-46-{fresh}.jsonl""#);
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(fresh, &rollout));
        assert_eq!(rec.as_deref(), Some(uid));
        // The relaunched Claude, transcript named after its fresh id: followed.
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(fresh, &own(fresh)));
        assert_eq!(rec.as_deref(), Some(fresh));
        assert_eq!(source().as_deref(), Some("startup"));
        let stop = format!(r#"{{"session_id":"{fresh}","hook_event_name":"Stop","permission_mode":"acceptEdits"}}"#);
        let (rec, mode) = run_hook(&script, &live, uid, claude, true, &stop);
        assert_eq!(rec.as_deref(), Some(fresh));
        assert_eq!(mode.as_deref(), Some("acceptEdits"));

        // Once the session has been prompted (its transcript exists), a plain
        // start under another id is a CLI nested under the tab: refused.
        std::fs::write(path(fresh), "{}").unwrap();
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(again, &own(again)));
        assert_eq!(rec.as_deref(), Some(fresh));
        // …also when it runs from another cwd: its transcript lands in that
        // cwd's project folder, where the tab's own is not.
        let elsewhere = tmp.join("projects").join("-tmp");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let away = format!("\"{}\"", elsewhere.join(format!("{again}.jsonl")).display());
        let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(again, &away));
        assert_eq!(rec.as_deref(), Some(fresh));
        // …as it is without the agent marker, whatever the transcripts say.
        std::fs::remove_file(path(fresh)).unwrap();
        let (rec, _) = run_hook(&script, &live, uid, None, true, &start(again, &own(again)));
        assert_eq!(rec.as_deref(), Some(fresh));

        // A tab whose first start was already the relaunch has no record at
        // all: the launch id's missing transcript is what lets it in.
        let other = "44444444-4444-4444-8444-444444444444";
        let (rec, _) = run_hook(&script, &live, other, claude, true, &start(again, &own(again)));
        assert_eq!(rec.as_deref(), Some(again));
        // …and a launch id that did write one keeps the record where it is.
        std::fs::write(path(again), "{}").unwrap();
        let (rec, _) = run_hook(&script, &live, other, claude, true, &start(fresh, &own(fresh)));
        assert_eq!(rec.as_deref(), Some(again));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn hook_script_records_the_turn_state_for_the_tabs_own_session_only() {
        let tmp = unique_tmp(concat!(crate::app_slug!(), "-hook-turn"));
        let live = tmp.join("live");
        std::fs::create_dir_all(&tmp).unwrap();
        let script = tmp.join("hook.sh");
        std::fs::write(&script, hook_script_body(&live.to_string_lossy())).unwrap();
        let uid = "11111111-1111-4111-8111-111111111111";
        let nested = "22222222-2222-4222-8222-222222222222";
        let claude = Some("claude");
        let turn = || {
            std::fs::read_to_string(live.join(format!("{uid}.turn")))
                .ok()
                .map(|t| t.split_whitespace().next().unwrap_or("").to_string())
        };
        let ev = |sid: &str, event: &str, extra: &str| {
            format!(r#"{{"session_id":"{sid}","hook_event_name":"{event}"{extra}}}"#)
        };

        // Nothing until a turn event: a start writes the session record only.
        run_hook(&script, &live, uid, claude, true, &ev(uid, "SessionStart", r#","source":"startup""#));
        assert_eq!(turn(), None);
        run_hook(&script, &live, uid, claude, true, &ev(uid, "UserPromptSubmit", ""));
        assert_eq!(turn().as_deref(), Some("working"));
        run_hook(&script, &live, uid, claude, true, &ev(uid, "Notification", r#","notification_type":"permission_prompt""#));
        assert_eq!(turn().as_deref(), Some("decision"));
        run_hook(&script, &live, uid, claude, true, &ev(uid, "PostToolUse", r#","tool_name":"Bash""#));
        assert_eq!(turn().as_deref(), Some("working"));
        // A notification that is not a wait leaves the state alone.
        run_hook(&script, &live, uid, claude, true, &ev(uid, "Notification", r#","notification_type":"auth_success""#));
        assert_eq!(turn().as_deref(), Some("working"));
        let (rec, mode) = run_hook(&script, &live, uid, claude, true, &ev(uid, "Stop", r#","permission_mode":"plan""#));
        assert_eq!(turn().as_deref(), Some("done"));
        // Stop still keeps the session record and the mode current.
        assert_eq!(rec.as_deref(), Some(uid));
        assert_eq!(mode.as_deref(), Some("plan"));
        run_hook(&script, &live, uid, claude, true, &ev(uid, "Notification", r#","notification_type":"idle_prompt""#));
        assert_eq!(turn().as_deref(), Some("done"));

        // A nested `claude -p` under the tab fires the same events for its own
        // session: none of them may move this tab's state.
        run_hook(&script, &live, uid, claude, true, &ev(nested, "UserPromptSubmit", ""));
        assert_eq!(turn().as_deref(), Some("done"));
        run_hook(&script, &live, uid, claude, true, &ev(nested, "Stop", ""));
        assert_eq!(turn().as_deref(), Some("done"));

        // A /clear ends the session but not the CLI: the tab is still at its
        // prompt, so its `done` stands instead of handing the tab back to its
        // screen (where the last reply could read as a question).
        run_hook(&script, &live, uid, claude, true, &ev(uid, "SessionEnd", r#","reason":"clear""#));
        assert_eq!(turn().as_deref(), Some("done"));
        run_hook(&script, &live, uid, claude, true, &ev(uid, "SessionEnd", r#","reason":"prompt_input_exit""#));
        assert_eq!(turn().as_deref(), Some("idle"));

        // Codex: its start is free-form, and from then on only that session's
        // turn events count — a nested `codex exec` is somebody else.
        let codex_uid = "44444444-4444-4444-8444-444444444444";
        let codex_id = "55555555-5555-4555-8555-555555555555";
        let cturn = || {
            std::fs::read_to_string(live.join(format!("{codex_uid}.turn")))
                .ok()
                .map(|t| t.split_whitespace().next().unwrap_or("").to_string())
        };
        run_hook(&script, &live, codex_uid, Some("codex"), false, &ev(codex_id, "SessionStart", r#","source":"startup""#));
        run_hook(&script, &live, codex_uid, Some("codex"), false, &ev(codex_id, "UserPromptSubmit", ""));
        assert_eq!(cturn().as_deref(), Some("working"));
        run_hook(&script, &live, codex_uid, Some("codex"), false, &ev(nested, "Stop", ""));
        assert_eq!(cturn().as_deref(), Some("working"));
        let (rec, _) = run_hook(&script, &live, codex_uid, Some("codex"), false, &ev(codex_id, "Stop", ""));
        assert_eq!(cturn().as_deref(), Some("done"));
        // …and the nested Stop did not steal the session record either.
        assert_eq!(rec.as_deref(), Some(codex_id));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_finds_a_log_under_any_of_several_roots() {
        // The fenced/contained stage holds a transcript until the tab goes away;
        // a respawn meanwhile must still see it — reusing the `--session-id`
        // would be refused by Claude.
        let uuid = "9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d";
        let empty = projects_with_sessions(&[]);
        let stage = projects_with_sessions(&[uuid]);
        let out = resolve_claude_session_in(
            opts_with_args(&["--session-id", uuid]),
            &[empty.as_path(), stage.as_path()],
            |_| None,
            |_| None,
        );
        assert_eq!(out.args, vec!["--resume".to_string(), uuid.to_string()]);
        assert_eq!(out.env.get(TAB_AGENT_ENV).map(String::as_str), Some("claude"));
    }

    #[test]
    fn resolvers_stamp_the_tab_agent_over_whatever_the_layout_carried() {
        let projects = projects_with_sessions(&[]);
        let mut opts = opts_with_args(&["--session-id", "abc-123"]);
        opts.env.insert(TAB_AGENT_ENV.to_string(), "codex".to_string());
        let out = resolve_claude_session_impl(opts, &projects, |_| None, |_| None);
        assert_eq!(out.env.get(TAB_AGENT_ENV).map(String::as_str), Some("claude"));

        let mut opts = opts_with_args(&[]);
        opts.cmd = "codex".to_string();
        opts.env
            .insert(crate::app_env!("TAB_UID").to_string(), "11111111-1111-4111-8111-111111111111".to_string());
        let out = resolve_codex_session_impl(opts, &projects, &[], |_| None);
        assert_eq!(out.env.get(TAB_AGENT_ENV).map(String::as_str), Some("codex"));
    }

    #[test]
    fn register_hook_is_idempotent_and_preserves_other_keys() {
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-settings-{}"), std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let settings = tmp.join("settings.json");
        std::fs::write(
            &settings,
            r#"{"model":"opus","hooks":{"Stop":[{"hooks":[]}]}}"#,
        )
        .unwrap();

        register_hook_in_settings(&HomeFile::open(&tmp, "settings.json").unwrap()).unwrap();
        register_hook_in_settings(&HomeFile::open(&tmp, "settings.json").unwrap()).unwrap(); // second call must not duplicate

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        // unrelated keys survive
        assert_eq!(v["model"], "opus");
        assert!(v["hooks"]["Stop"].is_array());
        // exactly one SessionStart handler was added
        let ss = v["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(ss.len(), 1);
        let cmd = ss[0]["hooks"][0]["command"].as_str().unwrap();
        // unix registers the bare script path (ends with the name); Windows wraps it
        // in a `powershell ... -File "<path>"` invocation, so assert containment.
        assert!(cmd.contains(HOOK_SCRIPT_NAME));
        // The Stop handler (permission-mode capture) is registered too — appended
        // AFTER the user's own Stop group, which survives untouched.
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        let ours = |g: &serde_json::Value| {
            g["hooks"].as_array().is_some_and(|hs| {
                hs.iter()
                    .any(|h| h["command"].as_str().is_some_and(|c| c.contains(HOOK_SCRIPT_NAME)))
            })
        };
        assert!(!ours(&stop[0]) && ours(&stop[1]));
        // The turn-state events are registered too, one group each.
        for ev in ["UserPromptSubmit", "PostToolUse", "Notification", "SessionEnd"] {
            let groups = v["hooks"][ev].as_array().unwrap();
            assert_eq!(groups.len(), 1, "{ev}");
            assert!(ours(&groups[0]), "{ev}");
        }
        // An install that predates the turn events gains exactly those.
        std::fs::write(
            &settings,
            format!(
                r#"{{"hooks":{{"SessionStart":[{{"hooks":[{{"type":"command","command":{cmd}}}]}}],"Stop":[{{"hooks":[{{"type":"command","command":{cmd}}}]}}]}}}}"#,
                cmd = serde_json::to_string(&hook_command()).unwrap()
            ),
        )
        .unwrap();
        register_hook_in_settings(&HomeFile::open(&tmp, "settings.json").unwrap()).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        for ev in HOOK_EVENTS {
            assert_eq!(v["hooks"][ev].as_array().unwrap().len(), 1, "{ev}");
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn register_codex_hook_appends_once_and_preserves_toml() {
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-codex-{}"), std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let config = tmp.join("config.toml");
        // A realistic pre-existing config with project tables.
        std::fs::write(
            &config,
            "model = \"o3\"\n\n[projects.\"/home/x\"]\ntrust_level = \"trusted\"\n",
        )
        .unwrap();

        register_codex_hook_in(&HomeFile::open(&tmp, "config.toml").unwrap()).unwrap();
        register_codex_hook_in(&HomeFile::open(&tmp, "config.toml").unwrap()).unwrap(); // idempotent

        let out = std::fs::read_to_string(&config).unwrap();
        // original content preserved verbatim at the top
        assert!(out.starts_with("model = \"o3\""));
        assert!(out.contains("[projects.\"/home/x\"]"));
        // hook appended exactly once per event
        assert_eq!(out.matches("[[hooks.SessionStart]]").count(), 1);
        assert!(out.contains("matcher = \"startup|resume|clear|compact\""));
        assert!(out.contains(HOOK_SCRIPT_NAME));
        for ev in CODEX_HOOK_EVENTS {
            assert_eq!(out.matches(&format!("[[hooks.{ev}]]")).count(), 1, "{ev}");
            assert_eq!(out.matches(&format!("[[hooks.{ev}.hooks]]")).count(), 1, "{ev}");
        }
        // Only SessionStart carries a matcher.
        assert_eq!(out.matches("matcher =").count(), 1);
        let have = codex_registered_events(&out, &hook_command());
        assert!(CODEX_HOOK_EVENTS.iter().all(|ev| have.contains(*ev)));

        // An install that registered SessionStart alone gains the turn events
        // and keeps its one SessionStart block.
        std::fs::write(
            &config,
            format!(
                "model = \"o3\"\n\n[[hooks.SessionStart]]\nmatcher = \"startup\"\n\n\
                 [[hooks.SessionStart.hooks]]\ntype = \"command\"\ncommand = '{}'\ntimeout = 10\n",
                hook_command()
            ),
        )
        .unwrap();
        register_codex_hook_in(&HomeFile::open(&tmp, "config.toml").unwrap()).unwrap();
        let out = std::fs::read_to_string(&config).unwrap();
        assert_eq!(out.matches("[[hooks.SessionStart]]").count(), 1);
        assert_eq!(out.matches("[[hooks.Stop]]").count(), 1);
        assert_eq!(out.matches("[[hooks.UserPromptSubmit]]").count(), 1);
        // Somebody else's hook on an event we register does not count as ours.
        assert_eq!(
            codex_registered_events(
                "[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = '/theirs.sh'\n",
                &hook_command()
            )
            .len(),
            0
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn codex_session_end_hook_stays_under_codexs_clamp() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config.toml");
        let cmd = hook_command();
        let timeout_of = |src: &str, ev: &str| -> Vec<String> {
            let mut cur = String::new();
            src.lines()
                .filter_map(|l| {
                    if l.starts_with('[') {
                        cur = l.to_string();
                    }
                    toml_value(l, "timeout").filter(|_| cur == format!("[[hooks.{ev}.hooks]]"))
                })
                .collect()
        };

        // A fresh registration writes 3 on SessionEnd, 10 elsewhere.
        register_codex_hook_in(&HomeFile::open(tmp.path(), "config.toml").unwrap()).unwrap();
        let out = std::fs::read_to_string(&config).unwrap();
        assert_eq!(timeout_of(&out, "SessionEnd"), ["3"]);
        assert_eq!(timeout_of(&out, "Stop"), ["10"]);

        // An older build's `timeout = 10` on our SessionEnd is lowered in
        // place; the user's own SessionEnd hook, the trust state and CRLF line
        // ends survive untouched.
        let old = format!(
            "[[hooks.SessionEnd]]\r\n\r\n[[hooks.SessionEnd.hooks]]\r\ntype = \"command\"\r\ncommand = '/theirs.sh'\r\ntimeout = 30\r\n\r\n\
             [[hooks.SessionEnd]]\r\n\r\n[[hooks.SessionEnd.hooks]]\r\ntype = \"command\"\r\ncommand = '{cmd}'\r\ntimeout = 10\r\n\r\n\
             [hooks.state.\"{CFG}:session_end:1:0\"]\r\ntrusted_hash = \"sha256:d709\"\r\n"
        );
        let capped = cap_codex_session_end_timeout(&old, &cmd).unwrap();
        assert_eq!(capped, old.replace("'\r\ntimeout = 10\r\n", "'\r\ntimeout = 3\r\n"));
        assert!(capped.contains("timeout = 30\r\n"));
        // Already low enough: nothing to do.
        assert_eq!(cap_codex_session_end_timeout(&capped, &cmd), None);

        // Registration applies it even when every event is already there.
        std::fs::write(&config, out.replace("timeout = 3\n", "timeout = 10\n")).unwrap();
        register_codex_hook_in(&HomeFile::open(tmp.path(), "config.toml").unwrap()).unwrap();
        let again = std::fs::read_to_string(&config).unwrap();
        assert_eq!(again, out);
    }

    // ── Codex hook trust state ──────────────────────────────────────────────

    const CFG: &str = "/home/x/.codex/config.toml";
    const CMD: &str = concat!("/home/x/.local/share/", crate::app_slug!(), "/hooks/", crate::app_slug!(), "_session_start.sh");

    /// Our hook block as `register_codex_hook_in` writes it.
    fn our_hook() -> String {
        format!(
            "[[hooks.SessionStart]]\n\
             matcher = \"startup|resume|clear|compact\"\n\n\
             [[hooks.SessionStart.hooks]]\n\
             type = \"command\"\n\
             command = '{CMD}'\n\
             timeout = 10\n"
        )
    }

    #[test]
    fn codex_hook_state_reports_disabled_when_the_trust_gate_is_off() {
        // Regression test for the bug this whole path exists to fix: Codex had
        // hashed our hook and recorded `enabled = false`, so it never ran and
        // Codex tabs silently restored blank.
        let src = format!(
            "model = \"o3\"\n\n{}\n[hooks.state]\n\n[hooks.state.\"{CFG}:session_start:0:0\"]\n\
             trusted_hash = \"sha256:93f0\"\nenabled = false\n",
            our_hook()
        );
        assert_eq!(
            codex_hook_state_in(&src, CFG, CMD),
            CodexHookState::Disabled
        );
    }

    #[test]
    fn codex_hook_state_reports_untrusted_without_a_verdict() {
        let src = our_hook();
        assert_eq!(
            codex_hook_state_in(&src, CFG, CMD),
            CodexHookState::Untrusted
        );
    }

    #[test]
    fn codex_hook_state_reports_enabled_when_trusted() {
        let src = format!(
            "{}\n[hooks.state.\"{CFG}:session_start:0:0\"]\nenabled = true\n",
            our_hook()
        );
        assert_eq!(codex_hook_state_in(&src, CFG, CMD), CodexHookState::Enabled);
    }

    #[test]
    fn codex_hook_state_reads_a_bare_trusted_hash_as_enabled() {
        // Codex 0.159 writes a trusted hook as its hash alone. Read as
        // untrusted, the cwd binder kept guessing beside the live hook and gave
        // one tab's fresh `/clear` rollout to its sibling: two phone tabs, one
        // conversation.
        let src = format!(
            "{}\n[hooks.state]\n\n[hooks.state.\"{CFG}:post_tool_use:0:0\"]\ntrusted_hash = \"sha256:c6bc\"\n\n\
             [hooks.state.\"{CFG}:session_start:0:0\"]\ntrusted_hash = \"sha256:93f0\"\n\n\
             [projects.\"/home/x\"]\ntrust_level = \"trusted\"\n",
            our_hook()
        );
        assert_eq!(codex_hook_state_in(&src, CFG, CMD), CodexHookState::Enabled);
        // `enabled = false` after the hash still switches it off.
        let off = src.replace("sha256:93f0\"\n", "sha256:93f0\"\nenabled = false\n");
        assert_eq!(codex_hook_state_in(&off, CFG, CMD), CodexHookState::Disabled);
    }

    #[test]
    fn codex_hook_state_indexes_our_hook_past_the_users_own() {
        // A user hook group precedes ours, so our verdict key is `:0:0` → no,
        // `:1:0`. Their `enabled = true` at `:0:0` must not be read as ours.
        let src = format!(
            "[[hooks.SessionStart]]\n\n[[hooks.SessionStart.hooks]]\n\
             type = \"command\"\ncommand = '/usr/bin/their-hook.sh'\n\n\
             {}\n[hooks.state.\"{CFG}:session_start:0:0\"]\nenabled = true\n",
            our_hook()
        );
        assert_eq!(
            codex_hook_state_in(&src, CFG, CMD),
            CodexHookState::Untrusted
        );

        // And with the verdict at *our* index, we read it.
        let trusted = format!("{src}\n[hooks.state.\"{CFG}:session_start:1:0\"]\nenabled = true\n");
        assert_eq!(
            codex_hook_state_in(&trusted, CFG, CMD),
            CodexHookState::Enabled
        );
    }

    #[test]
    fn codex_hook_state_is_not_registered_without_our_command() {
        let src = "model = \"o3\"\n\n[projects.\"/home/x\"]\ntrust_level = \"trusted\"\n";
        assert_eq!(
            codex_hook_state_in(src, CFG, CMD),
            CodexHookState::NotRegistered
        );
    }

    #[test]
    fn codex_hook_state_tolerates_a_config_path_spelled_differently() {
        // Codex builds the key from the path *it* resolved (symlinked CODEX_HOME,
        // macOS `/private` prefix …), so we fall back to matching our position.
        let src = format!(
            "{}\n[hooks.state.\"/private{CFG}:session_start:0:0\"]\nenabled = false\n",
            our_hook()
        );
        assert_eq!(
            codex_hook_state_in(&src, CFG, CMD),
            CodexHookState::Disabled
        );
    }

    #[test]
    fn write_live_session_round_trips_and_refuses_junk_keys() {
        let tmp = unique_tmp(concat!(crate::app_slug!(), "-live-write"));
        let uid = "11111111-2222-3333-4444-555555555555";
        let id = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";

        write_live_session_in(&tmp, uid, id).unwrap();
        assert_eq!(read_live_session_in(&tmp, uid).as_deref(), Some(id));

        // The uid becomes a filename, so a traversal key must never be written.
        assert!(write_live_session_in(&tmp, "../../etc/passwd", id).is_err());
        assert!(write_live_session_in(&tmp, uid, "not a uuid!").is_err());
        // …and the good value survives the refused writes.
        assert_eq!(read_live_session_in(&tmp, uid).as_deref(), Some(id));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_codex_session_reads_a_binder_written_record() {
        // The seam the hook-free fallback relies on: whatever `codex_bind` writes
        // with `write_live_session_in` must come back out of the *unchanged*
        // resolve path as `codex resume <id>`.
        let live = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";
        let uid = "11111111-2222-3333-4444-555555555555";
        let root = codex_sessions_with(live);
        let live_dir = unique_tmp(concat!(crate::app_slug!(), "-live-seam"));

        write_live_session_in(&live_dir, uid, live).unwrap();

        let mut opts = codex_opts();
        opts.env
            .insert(crate::app_env!("TAB_UID").to_string(), uid.to_string());
        let out =
            resolve_codex_session_impl(opts, &root, &[], |u| read_live_session_in(&live_dir, u));
        assert_eq!(out.args, vec!["resume".to_string(), live.to_string()]);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&live_dir);
    }

    // ── permission-mode resume ──────────────────────────────────────────────

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn resolve_reapplies_recorded_permission_mode_on_resume() {
        let uuid = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[uuid]);
        let out = resolve_claude_session_impl(
            opts_with_args(&["--session-id", uuid]),
            &projects,
            |_| None,
            |_| Some("acceptEdits".to_string()),
        );
        assert_eq!(
            out.args,
            strs(&["--resume", uuid, "--permission-mode", "acceptEdits"])
        );
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_never_applies_a_mode_record_to_a_fresh_session() {
        // No session log → fresh `--session-id` launch; a leftover mode record
        // must not steer a conversation that does not exist yet.
        let uuid = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[]);
        let out = resolve_claude_session_impl(
            opts_with_args(&["--session-id", uuid]),
            &projects,
            |_| None,
            |_| Some("plan".to_string()),
        );
        assert_eq!(out.args, strs(&["--session-id", uuid]));
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_lets_an_explicit_mode_flag_outrank_the_record() {
        // A custom agent whose argv already names `--permission-mode` keeps it;
        // the hook record must neither override it nor stack a second pair behind
        // it.
        let uuid = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[uuid]);
        let out = resolve_claude_session_impl(
            opts_with_args(&["--session-id", uuid, "--permission-mode", "plan"]),
            &projects,
            |_| None,
            |_| Some("acceptEdits".to_string()),
        );
        assert_eq!(out.args, strs(&["--resume", uuid, "--permission-mode", "plan"]));
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_discards_junk_mode_records() {
        // The record is hook-parsed JSON becoming a CLI argument: only the known
        // mode set may pass.
        let uuid = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[uuid]);
        let out = resolve_claude_session_impl(
            opts_with_args(&["--session-id", uuid]),
            &projects,
            |_| None,
            |_| Some("acceptEdits; rm -rf /".to_string()),
        );
        assert_eq!(out.args, strs(&["--resume", uuid]));
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn mode_records_round_trip_and_reject_junk() {
        let tmp = unique_tmp(concat!(crate::app_slug!(), "-mode"));
        std::fs::create_dir_all(&tmp).unwrap();
        let uid = "11111111-2222-3333-4444-555555555555";
        std::fs::write(tmp.join(format!("{uid}.mode")), "acceptEdits\n").unwrap();
        assert_eq!(read_live_mode_in(&tmp, uid).as_deref(), Some("acceptEdits"));
        // unknown values and traversal keys are refused
        std::fs::write(tmp.join(format!("{uid}.mode")), "yolo").unwrap();
        assert_eq!(read_live_mode_in(&tmp, uid), None);
        assert_eq!(read_live_mode_in(&tmp, "../etc/passwd"), None);
        assert!(is_permission_mode("plan") && is_permission_mode("bypassPermissions"));
        // "manual" is a CLI-only alias — hooks report it as "default".
        assert!(!is_permission_mode("manual") && !is_permission_mode(""));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_model_tag_is_the_last_real_answer_in_the_transcript_tail() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join("s.jsonl");
        std::fs::write(
            &claude,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-1-20250805\",\"role\":\"assistant\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-5-20250929\",\"role\":\"assistant\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"model\":\"<synthetic>\",\"role\":\"assistant\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"more\"}}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            last_model_in_transcript(&claude, TranscriptKind::Claude).as_deref(),
            Some("claude-sonnet-4-5-20250929")
        );
        // A Codex rollout names the model in its turn context, not its answers.
        let codex = dir.path().join("rollout.jsonl");
        std::fs::write(
            &codex,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"x\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\"}}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            last_model_in_transcript(&codex, TranscriptKind::Codex).as_deref(),
            Some("gpt-5-codex")
        );
        // No answer yet, or a dialect mismatch, is no tag — never a guess.
        assert_eq!(last_model_in_transcript(&codex, TranscriptKind::Claude), None);
        std::fs::write(&claude, "{\"type\":\"user\"}\n").unwrap();
        assert_eq!(last_model_in_transcript(&claude, TranscriptKind::Claude), None);
        assert_eq!(last_model_in_transcript(&dir.path().join("missing.jsonl"), TranscriptKind::Claude), None);
    }

    #[test]
    fn a_model_switch_in_the_session_retags_before_the_next_answer() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join("s.jsonl");
        let switch = |text: &str| {
            serde_json::json!({"type": "user", "message": {"role": "user", "content": text}}).to_string()
        };
        let answer = "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5\",\"role\":\"assistant\"}}";
        let write = |lines: &[String]| std::fs::write(&claude, lines.join("\n") + "\n").unwrap();
        let read = || last_model_in_transcript(&claude, TranscriptKind::Claude);

        write(&[answer.into(), switch("<local-command-stdout>Set model to `Fable 5.1` and saved as your default for new sessions</local-command-stdout>")]);
        assert_eq!(read().as_deref(), Some("fable-5-1"));
        // Older releases bold the name with ANSI instead of backticks.
        write(&[answer.into(), switch("<local-command-stdout>Set model to \u{1b}[1mSonnet 4.5\u{1b}[22m and saved as your default for new sessions</local-command-stdout>")]);
        assert_eq!(read().as_deref(), Some("sonnet-4-5"));
        // Annotations are not part of the model.
        write(&[answer.into(), switch("<local-command-stdout>Set model to `Opus 5 (1M context) (default)` and saved as your default</local-command-stdout>")]);
        assert_eq!(read().as_deref(), Some("opus-5"));
        write(&[answer.into(), switch("<local-command-stdout>Kept model as `Fable 5`</local-command-stdout>")]);
        assert_eq!(read().as_deref(), Some("fable-5"));
        // A later answer wins again; a quoted mention in a prompt is not a switch.
        write(&[switch("<local-command-stdout>Set model to `Fable 5` and saved</local-command-stdout>"), answer.into()]);
        assert_eq!(read().as_deref(), Some("claude-opus-5"));
        write(&[answer.into(), switch("why does it say Set model to `Fable 5`?")]);
        assert_eq!(read().as_deref(), Some("claude-opus-5"));
        // A name that folds to nothing useful leaves the last answer standing.
        write(&[answer.into(), switch("<local-command-stdout>Set model to Default</local-command-stdout>")]);
        assert_eq!(read().as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn recent_prompts_carry_their_times_and_take_in_mid_turn_messages() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join("s.jsonl");
        std::fs::write(
            &claude,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-09-15T08:20:44.127Z\",\"message\":{\"role\":\"user\",\"content\":\"add an edge option\"}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-09-15T08:20:50.000Z\",\"message\":{\"model\":\"claude-opus-5\"}}\n",
                // Sent while the agent worked: an attachment, never a user record.
                "{\"type\":\"attachment\",\"timestamp\":\"2026-09-15T08:21:48.991Z\",\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"zoom to 5 min\",\"commandMode\":\"prompt\",\"origin\":{\"kind\":\"human\"}}}\n",
                // Queued by something that is not the user, or not a prompt.
                "{\"type\":\"attachment\",\"timestamp\":\"2026-09-15T08:22:00.000Z\",\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"task done\",\"commandMode\":\"prompt\",\"origin\":{\"kind\":\"task\"}}}\n",
                "{\"type\":\"attachment\",\"timestamp\":\"2026-09-15T08:22:01.000Z\",\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"git status\",\"commandMode\":\"bash\"}}\n",
                // No timestamp: it cannot be placed, so it is not offered.
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"when was this\"}}\n",
                "{\"type\":\"user\",\"timestamp\":\"2026-09-15T08:24:22.470Z\",\"message\":{\"role\":\"user\",\"content\":\"not live\"}}\n",
                "{\"type\":\"user\",\"timestamp\":\"2026-09-15T08:24:30.000Z\",\"message\":{\"role\":\"user\",\"content\":\"not live\"}}\n",
            ),
        )
        .unwrap();
        let prompts = recent_prompts_in_transcript(&claude, TranscriptKind::Claude).unwrap();
        let texts: Vec<&str> = prompts.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(texts, ["add an edge option", "zoom to 5 min", "not live"]);
        assert_eq!(prompts[1].at, "2026-09-15T08:21:48.991Z");
        std::fs::write(&claude, "{\"type\":\"assistant\"}\n").unwrap();
        assert_eq!(recent_prompts_in_transcript(&claude, TranscriptKind::Claude), None);
    }

    #[test]
    fn the_last_prompt_is_what_the_user_said_not_what_the_cli_told_itself() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join("s.jsonl");
        // A prompt, then everything Claude writes as a "user" turn that is not
        // one: a tool result, a meta caveat, a reminder, a captured stdout.
        std::fs::write(
            &claude,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"fix the\\n  failing tests\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-1\",\"role\":\"assistant\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"t1\",\"type\":\"tool_result\",\"content\":\"ok\"}]}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"pretend this is a prompt\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<system-reminder>\\nnot a prompt\\n</system-reminder>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<local-command-stdout>Set model</local-command-stdout>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"[Request interrupted by user for tool use]\"}]}}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            last_prompt_in_transcript(&claude, TranscriptKind::Claude).as_deref(),
            Some("fix the failing tests")
        );
        // A slash command and a `!` line are the user's doing, and read as such.
        std::fs::write(
            &claude,
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/model</command-name>\\n  <command-message>model</command-message>\\n  <command-args>opus</command-args>\"}}\n",
        )
        .unwrap();
        assert_eq!(
            last_prompt_in_transcript(&claude, TranscriptKind::Claude).as_deref(),
            Some("/model opus")
        );
        std::fs::write(
            &claude,
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<bash-input> git status</bash-input>\"}}\n",
        )
        .unwrap();
        assert_eq!(
            last_prompt_in_transcript(&claude, TranscriptKind::Claude).as_deref(),
            Some("! git status")
        );
        // An image paste carries its words as text blocks beside the image,
        // and the reminder Claude attaches rides along as a block to skip.
        std::fs::write(
            &claude,
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"source\":{}},{\"type\":\"text\",\"text\":\"what is this?\"},{\"type\":\"text\",\"text\":\"<system-reminder>x</system-reminder>\"}]}}\n",
        )
        .unwrap();
        assert_eq!(
            last_prompt_in_transcript(&claude, TranscriptKind::Claude).as_deref(),
            Some("what is this?")
        );
        // Codex: the typed message event, and the model-facing copy without
        // the context Codex injects around it.
        let codex = dir.path().join("rollout.jsonl");
        std::fs::write(
            &codex,
            concat!(
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>cwd</environment_context>\"}]}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"add a test\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            last_prompt_in_transcript(&codex, TranscriptKind::Codex).as_deref(),
            Some("add a test")
        );
        std::fs::write(
            &codex,
            concat!(
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"rename it\"}]}}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            last_prompt_in_transcript(&codex, TranscriptKind::Codex).as_deref(),
            Some("rename it")
        );
        // A dialect mismatch, or no prompt at all, is no answer — never a guess.
        assert_eq!(last_prompt_in_transcript(&codex, TranscriptKind::Claude), None);
        assert_eq!(last_prompt_in_transcript(&dir.path().join("missing.jsonl"), TranscriptKind::Codex), None);
        // The shown text is one bounded printable line.
        assert_eq!(clean_prompt_text("  a\n\n b\tc \u{1b}[0m "), Some("a b c [0m".to_string()));
        assert_eq!(clean_prompt_text(" \n "), None);
        let long = clean_prompt_text(&"p".repeat(MAX_PROMPT_CHARS + 50)).unwrap();
        assert_eq!(long.chars().count(), MAX_PROMPT_CHARS + 1);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn a_claude_goal_runs_from_its_sentinel_until_met_failed_or_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let set = r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"fix it"}}"#;
        let typed = r#"{"type":"user","message":{"role":"user","content":"<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>fix it</command-args>"}}"#;
        let answer = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"On it."}]}}"#;
        let unmet = r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"reason":"not yet"}}"#;
        let met = r#"{"type":"attachment","attachment":{"type":"goal_status","met":true,"condition":"fix it"}}"#;
        let failed = r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"failed":true,"iterations":4}}"#;
        let cleared = r#"{"type":"user","message":{"role":"user","content":"<command-name>/goal</command-name>\n<command-args>clear</command-args>"}}"#;
        let sidechain = r#"{"type":"attachment","isSidechain":true,"attachment":{"type":"goal_status","met":false,"sentinel":true}}"#;
        let read = |lines: &[&str]| {
            std::fs::write(&path, lines.join("\n") + "\n").unwrap();
            claude_goal_in_transcript(&path)
        };
        assert_eq!(read(&[answer]), None);
        assert_eq!(read(&[set, typed, answer]), Some(true));
        assert_eq!(read(&[set, typed, answer, unmet, answer]), Some(true));
        assert_eq!(read(&[set, typed, answer, met, answer]), Some(false));
        assert_eq!(read(&[set, typed, answer, failed]), Some(false));
        assert_eq!(read(&[set, typed, answer, cleared]), Some(false));
        assert_eq!(read(&[met, sidechain]), Some(false));
    }

    #[test]
    fn markup_the_user_pasted_stays_their_prompt() {
        // Bounded by shape alone, the block test ate all of these — silently,
        // with no marker, from the bubble and the last-prompt line both.
        let html = "fix this:\n<div>\n  <span>x</span>\n</div>";
        assert_eq!(claude_prompt_text(html).as_deref(), Some(html));
        let xml = "review this xml:\n<config>\n  <name>x</name>\n</config>";
        assert_eq!(claude_prompt_text(xml).as_deref(), Some(xml));
        assert_eq!(
            claude_prompt_text("compare <a>one</a> and <a>two</a>").as_deref(),
            Some("compare <a>one</a> and <a>two</a>")
        );
        // Wholly one element, and still the user's.
        assert_eq!(claude_prompt_text("<div>hello</div>").as_deref(), Some("<div>hello</div>"));
        assert_eq!(claude_prompt_text("<p>a paragraph</p>").as_deref(), Some("<p>a paragraph</p>"));
        // An attribute never was the thing that saved it.
        assert_eq!(
            claude_prompt_text("<div class=\"x\">hello</div>").as_deref(),
            Some("<div class=\"x\">hello</div>")
        );
        // The CLI's own tags are still refused, and still stripped off a tail.
        assert_eq!(claude_prompt_text("<system-reminder>x</system-reminder>"), None);
        assert_eq!(
            claude_prompt_text("ship it\n<system-reminder>x</system-reminder>").as_deref(),
            Some("ship it")
        );
    }

    #[test]
    fn a_compact_summary_is_never_a_prompt() {
        let summary: serde_json::Value = serde_json::from_str(concat!(
            "{\"type\":\"user\",\"isCompactSummary\":true,\"message\":{\"role\":\"user\",",
            "\"content\":\"This session is being continued from a previous conversation.\"}}",
        ))
        .unwrap();
        assert_eq!(claude_prompt_in_record(&summary), None);
        let transcript_only: serde_json::Value = serde_json::from_str(concat!(
            "{\"type\":\"user\",\"isVisibleInTranscriptOnly\":true,\"message\":{\"role\":\"user\",",
            "\"content\":\"a note the CLI left itself\"}}",
        ))
        .unwrap();
        assert_eq!(claude_prompt_in_record(&transcript_only), None);
    }

    #[test]
    fn a_block_the_cli_wrote_to_itself_is_never_a_prompt() {
        // Read by shape, not off a list: none of these tags was ever on the
        // prefix list, and each one reached the phone inside a bubble.
        assert_eq!(claude_prompt_text("<tool_use_error>File has not been read yet</tool_use_error>"), None);
        assert_eq!(claude_prompt_text("<total_tokens>128000</total_tokens>"), None);
        assert_eq!(claude_prompt_text("<user-prompt-submit-hook>blocked</user-prompt-submit-hook>"), None);
        assert_eq!(claude_prompt_text("<bash-stderr>fatal: not a repo</bash-stderr>"), None);
        assert_eq!(claude_prompt_text("  <local-command-stderr>oops</local-command-stderr>  "), None);
        // A reminder appended behind the words the user typed is cut off them.
        assert_eq!(
            claude_prompt_text("fix the tests\n<system-reminder>be careful</system-reminder>").as_deref(),
            Some("fix the tests")
        );
        // Angle brackets somebody typed stay theirs.
        assert_eq!(claude_prompt_text("<Vec<T>> or a slice?").as_deref(), Some("<Vec<T>> or a slice?"));
        assert_eq!(claude_prompt_text("what does <T> mean here?").as_deref(), Some("what does <T> mean here?"));
        // The two tags that are the user's doing are still read first.
        assert_eq!(claude_prompt_text("<command-name>/clear</command-name>").as_deref(), Some("/clear"));
        // A paste rides in its own block; the card shows it as the CLI does.
        assert_eq!(
            claude_prompt_text("\n\n<pasted_content id=\"d95e\">\nline one\nline two\n</pasted_content id=\"d95e\">\n\n implement it")
                .as_deref(),
            Some("[Pasted text #1 +2 lines]\n\n implement it")
        );
        assert_eq!(
            claude_prompt_text("a <pasted_content id=\"1\">x</pasted_content id=\"1\"> b <pasted_content id=\"2\">y\nz</pasted_content id=\"2\">")
                .as_deref(),
            Some("a [Pasted text #1 +1 lines] b [Pasted text #2 +2 lines]")
        );
        // Unclosed, or closed under another id: the user's text, untouched.
        assert_eq!(
            claude_prompt_text("see <pasted_content id=\"1\">x").as_deref(),
            Some("see <pasted_content id=\"1\">x")
        );
        assert_eq!(claude_prompt_text("<bash-input>git status</bash-input>").as_deref(), Some("! git status"));

        // Codex injects its instructions as blocks beside the typed words.
        let injected: serde_json::Value = serde_json::from_str(concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[",
            "{\"type\":\"input_text\",\"text\":\"<user_instructions>be brief</user_instructions>\"},",
            "{\"type\":\"input_text\",\"text\":\"rename it\"}]}}",
        ))
        .unwrap();
        assert_eq!(codex_prompt_in_record(&injected).as_deref(), Some("rename it"));
    }

    #[test]
    fn a_prompt_behind_a_megabyte_of_tool_output_is_still_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        // Codex 0.155's shape: the prompt, then a turn of tool results each
        // written twice, far past the model's window.
        let prompt = r#"{"timestamp":"2026-09-19T17:25:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant_x","content":[]}}
{"timestamp":"2026-09-19T17:25:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Implement these"}]}}
"#;
        let output = "o".repeat(40 * 1024);
        let mut body = prompt.to_string();
        for _ in 0..40 {
            body.push_str(&format!(
                "{{\"type\":\"response_item\",\"payload\":{{\"type\":\"custom_tool_call_output\",\"output\":\"{output}\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"item_completed\",\"output\":\"{output}\"}}}}\n"
            ));
        }
        std::fs::write(&path, body).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 3 * MODEL_TAIL_BYTES);
        assert_eq!(last_prompt_in_transcript(&path, TranscriptKind::Codex).as_deref(), Some("Implement these"));
        let recent = recent_prompts_in_transcript(&path, TranscriptKind::Codex).unwrap();
        assert_eq!(recent.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), ["Implement these"]);
    }

    #[test]
    fn the_model_tag_skips_the_line_the_tail_cut_and_refuses_unprintable_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        // One answer far past the tail window, then a line the window cuts in
        // half, then an ordinary user turn: the cut line would parse as garbage
        // and must not be mistaken for a record.
        let filler = "x".repeat(MODEL_TAIL_BYTES as usize + 100);
        let body = format!(
            "{{\"type\":\"assistant\",\"message\":{{\"model\":\"claude-opus-4-1-20250805\"}}}}\n{{\"type\":\"user\",\"message\":{{\"content\":\"{filler}\"}}}}\n{{\"type\":\"user\"}}\n"
        );
        std::fs::write(&path, body).unwrap();
        assert_eq!(last_model_in_transcript(&path, TranscriptKind::Claude), None);
        assert_eq!(clean_model_name("  claude-opus-4-1  ").as_deref(), Some("claude-opus-4-1"));
        assert_eq!(clean_model_name("<synthetic>"), None);
        assert_eq!(clean_model_name("evil\u{1b}]0;x\u{7}"), None);
        assert_eq!(clean_model_name("two words"), None);
        assert_eq!(clean_model_name(&"m".repeat(MAX_MODEL_NAME + 1)), None);
    }
}
