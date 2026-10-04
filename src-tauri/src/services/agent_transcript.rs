//! The stored conversation behind an agent tab, read for the phone's Focus
//! view.
//!
//! Focus reads a session off the terminal screen: the rows tmux keeps, at
//! the desktop window's width, bounded by the pane's scrollback and cut short
//! by every full-screen redraw. The agent keeps a better record of the same
//! conversation — Claude's `~/.claude/projects/<cwd>/<id>.jsonl`, Codex's
//! rollout — in which every prompt and every answer is one record with a
//! timestamp, from the first turn on. This module turns that file into the
//! entries the phone lays out as a chat, resolved the same way the model tag
//! and the last-prompt line are ([`agent_session::read_agent_transcript`]):
//! the tab's own session, the live id (after a `/clear`) first — and, unlike
//! those, never the launch id's file once a live id is recorded, since after
//! a `/clear` that is the conversation the reader just cleared.
//!
//! What is read is deliberately narrow: the prompts the user submitted and
//! the text the agent answered with — and, the one tool call kept, a question
//! the agent put to the user with the answer it got. Other tool calls and their results, thinking
//! blocks, attachments, the reminders the CLI attaches to a prompt and the
//! notes it leaves for itself are not the conversation and are stepped over —
//! on a phone the answer is what is wanted, not the edit-by-edit status the
//! terminal shows beside it. Everything is bounded: a tail of the file, a cap
//! on the number of entries, a cap on the text of each. The file is written
//! by the agent and read onto a phone.
//!
//! A subagent the agent spawned is one `agent` entry in its place — what it
//! was sent to do and what kind of agent it is — carrying an opaque handle
//! ([`subagent_token`]) that reads *that* subagent's own conversation the same
//! way. Each CLI keeps them apart and says whose they are: Claude writes
//! `<session>/subagents/agent-<id>.jsonl` beside a `.meta.json` naming the tool
//! call that spawned it, Codex records a spawn edge per child thread in its
//! state store, OpenCode a `parent_id` per child session. A handle is only
//! ever resolved among the subagents of the tab's own session.
//!
//! A read answers with a `version` fingerprint of the file; a caller that
//! passes the one it last saw gets `unchanged` back without a parse, which is
//! what lets the phone poll while the agent is answering.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::services::agent_session::{self, TranscriptKind};

/// How much of a transcript's tail is read. A Claude session with a day of
/// tool results behind it runs to tens of megabytes, most of it tool output
/// this never shows; the tail holds the conversation a phone reader is
/// actually catching up on, and what fell before it is announced as
/// `truncated` rather than silently missing.
const TAIL_BYTES: u64 = 6 * 1024 * 1024;
/// Entries answered when the caller names no limit.
pub const DEFAULT_LIMIT: usize = 120;
/// The most entries one answer carries, whatever the caller asks for.
pub const MAX_LIMIT: usize = 1000;
/// Longest text of one prompt. The full prompt is the user's own words, so
/// the bound is generous; a pasted log is cut and marked.
const MAX_PROMPT_CHARS: usize = 6_000;
/// Longest text of one answer record (its text blocks joined).
const MAX_ANSWER_CHARS: usize = 12_000;
/// Longest task line on a subagent's entry: what it was sent to do, as a
/// title — the whole task is the first prompt of its own conversation.
const MAX_AGENT_CHARS: usize = 200;
/// Longest subagent kind (`Explore`, a Codex role, an OpenCode agent).
const MAX_ROLE_CHARS: usize = 48;
/// Longest command line of a running shell; a heredoc script is cut.
const MAX_SHELL_CHARS: usize = 8_000;
/// Longest description of a running shell.
const MAX_SHELL_DESCRIPTION_CHARS: usize = 200;
/// Longest question, option label or note of a question the agent asked.
const MAX_QUESTION_CHARS: usize = 2_000;
/// How deep a subagent's own subagents are followed.
pub(crate) const MAX_SUBAGENT_DEPTH: usize = 8;

/// One turn of the conversation as the phone shows it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptEntry {
    /// `prompt` (the user's), `answer` (the agent's text) or `agent` (a
    /// subagent it spawned; `text` is what it was sent to do).
    pub kind: String,
    pub text: String,
    /// The record's own timestamp, as written (RFC 3339), when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// The text was cut at its bound; the entry shows what fit.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
    /// On an `agent` entry: the handle that reads this subagent's own
    /// conversation ([`subagent_token`]). Absent while its CLI has not yet
    /// recorded where that conversation lives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    /// On an `agent` entry: the kind of subagent, as its CLI names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// On an `answer` entry: the plan the agent put up for approval (Claude's
    /// `ExitPlanMode`), which the phone sets apart from its ordinary answers.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
    /// On an `agent` entry: the subagent has not reported back yet — the call
    /// that spawned it has no result in the transcript, or (one sent to the
    /// background) no task notification has ended it (Claude's).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub running: bool,
    /// On an `agent` entry: the subagent has reported back — its spawn call
    /// has a result, or its task notification came (Claude's). Neither this
    /// nor `running` on a CLI whose record does not say, so a missing mark is
    /// "unknown", never "done".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub finished: bool,
    /// On an `agent` entry: it runs in the background (Claude's async
    /// `Agent` launch), so it can be at work while the session's turn is over.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
    /// On an `answer` entry: the questions the agent asked the user (Claude's
    /// `AskUserQuestion`), each with the answer it got. The entry is written
    /// once the call has its result, so a question still waiting is the live
    /// screen's and never in the chat twice; `text` is the same exchange as
    /// plain text.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<AskedQuestion>,
}

/// One question the agent asked, as answered.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AskedQuestion {
    /// The short label the dialog's tab row shows for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub question: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<AskedOption>,
    /// What the user answered — a row's label, several joined by `, ` on a
    /// multi-select, or their own words. Absent when the question was turned
    /// down rather than answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
}

/// One row a question offered, and whether the answer took it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AskedOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub chosen: bool,
}

/// What a tab's stored session answers with. Always a value, never an error:
/// an agent that keeps no transcript Tabtivity reads comes back `available:
/// false` with the reason, and the phone shows the screen instead.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTranscript {
    pub available: bool,
    /// Why not, when `available` is false: `unsupported` (an agent whose
    /// transcript is not read), `no_session` (the tab has no session id yet),
    /// `no_transcript` (nothing on disk for it), `no_subagent` (the handle
    /// names no subagent of this session), `read_failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Fingerprint of the file the entries came from — pass it back to be
    /// answered `unchanged` while the file has not moved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The file is as the caller last saw it; `entries` is empty and stale
    /// content should be kept.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unchanged: bool,
    #[serde(default)]
    pub entries: Vec<TranscriptEntry>,
    /// Earlier turns exist that this answer does not carry — beyond the tail
    /// read, or beyond the entry limit. A larger `limit` reaches the latter.
    #[serde(default)]
    pub truncated: bool,
    /// The turns `truncated` leaves out hold a subagent this answer does not
    /// list — what the Subagents index's "+" promises. A long session that
    /// never spawned one is `truncated` without it.
    #[serde(default, rename = "agentsEarlier", skip_serializing_if = "std::ops::Not::not")]
    pub agents_earlier: bool,
    /// How many of the session's subagents are at work right now (`running`
    /// entries, the cut-off ones included) — the count the phone's tab cards
    /// show. Zero on a CLI whose record does not say.
    #[serde(default, rename = "runningAgents", skip_serializing_if = "is_zero")]
    pub running_agents: u32,
    /// The session's own usage figures, where its transcript records them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TranscriptUsage>,
    /// The model the newest record that names one ran on, as its API id
    /// (`claude-opus-4-1-20250805`, `gpt-5-codex`) — a subagent's own, read
    /// off its own conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The tokens the newest request that records its usage carried — the
    /// context it sent plus what came back, the figure Claude Code's own row
    /// for a subagent counts (Codex's `last_token_usage`). The phone's
    /// working row in a subagent's conversation shows it; a session's own
    /// row reads its spinner instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    /// The shell commands the agent is running right now — Claude's `Bash`
    /// calls since the last prompt that have no result in the transcript
    /// yet. Desktop Reader only: the phone's API strips it, since a command
    /// line is not something that crosses to the browser.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shells: Vec<RunningShell>,
}

/// A shell command the agent started and is waiting on.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunningShell {
    /// The command line as the agent wrote it, cut at its bound.
    pub command: String,
    /// The agent's own few words on what it does, when it gave them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// When the call was written (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// The command was cut at its bound.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
    /// Sent to the background (`run_in_background`, or moved there at its
    /// timeout): the agent no longer waits on it, and it can outlive the turn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
}

/// The shells a transcript says are running: calls still waiting on their
/// result, and background ones that no notification has ended yet — each
/// with the output file its CLI named, by which [`running_outputs`] tells
/// whether it still runs.
#[derive(Debug, Default)]
struct ShellCalls {
    waiting: Vec<RunningShell>,
    background: Vec<(RunningShell, String)>,
}

/// What Claude's status line shows beside the model — context left, the
/// 5-hour and the weekly window — for a CLI that draws none of it on screen
/// but writes it down: Codex puts its rate limits and the context it used
/// into every `token_count` event of its rollout. Only figures the record
/// carried are set.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUsage {
    /// Percent of the context window left, counted as Codex's own footer does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_left: Option<u8>,
    /// The rolling session window (Codex's 5-hour one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<UsageWindow>,
    /// The weekly window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<UsageWindow>,
}

/// One rate-limit window: how much of it is used, and when it rolls over.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Percent used, 0–100.
    pub used: u8,
    /// Unix seconds of the reset, when the record gives one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
}

impl AgentTranscript {
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            reason: Some(reason.to_string()),
            ..Default::default()
        }
    }
}

/// The stored conversation of the tab launched as `cmd` with launch id
/// `launch_id` in `tab_dir`: the last `limit` turns of its transcript, or
/// `unchanged` when `version` still names the file as it is. `subagent`, a
/// handle from one of its `agent` entries, reads that subagent's conversation
/// instead. `since` is the launch moment (epoch ms) of a tab opened fresh
/// rather than restored with its continue flag — only OpenCode, found by
/// folder, needs it. See [`AgentTranscript::reason`] for the ways this answers
/// without turns.
#[allow(clippy::too_many_arguments)]
pub fn agent_session_transcript(
    cmd: &str,
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    since: Option<i64>,
    launch_id: &str,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    let limit = limit.clamp(1, MAX_LIMIT);
    if subagent.is_some_and(|token| !is_subagent_token(token)) {
        return AgentTranscript::unavailable("no_subagent");
    }
    if cmd == "opencode" {
        let db = crate::services::opencode_store::db_path_for(project_id);
        return opencode_transcript(&db, project_id, tab_dir, since, subagent, version, limit);
    }
    let read = match cmd {
        "claude" => claude_transcript(project_id, launch_id, subagent, version, limit),
        "codex" => codex_transcript(project_id, launch_id, subagent, version, limit),
        _ => None,
    };
    if subagent.is_some() {
        return read.unwrap_or_else(|| AgentTranscript::unavailable("no_subagent"));
    }
    read.or_else(|| (cmd == "claude").then(|| fresh_claude_session(project_id, launch_id)).flatten())
        .or_else(|| (cmd == "codex").then(|| fresh_codex_session(project_id, launch_id)).flatten())
        .unwrap_or_else(|| {
            AgentTranscript::unavailable(if matches!(cmd, "claude" | "codex") {
                "no_transcript"
            } else {
                "unsupported"
            })
        })
}

/// How many subagents the Claude tab launched with `launch_id` has at work
/// right now ([`AgentTranscript::running_agents`]), for the phone's tab cards
/// when no window answers for them. Only Claude's record says whether a
/// subagent is still at work, so any other CLI is zero without a read. A
/// transcript unchanged since the tab's last count is answered from it.
pub fn running_subagents(cmd: &str, project_id: Option<&str>, launch_id: &str) -> u32 {
    if cmd != "claude" {
        return 0;
    }
    let counted = || RUNNING_COUNTED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let known = counted().get(launch_id).cloned();
    let read = agent_session_transcript(cmd, project_id, None, None, launch_id, None, known.as_ref().map(|(version, _)| version.as_str()), 1);
    if read.unchanged {
        return known.map_or(0, |(_, count)| count);
    }
    let mut counted = counted();
    if counted.len() >= BACKGROUND_SEEN_MAX {
        counted.clear();
    }
    match read.version {
        Some(version) if read.available => {
            counted.insert(launch_id.to_string(), (version, read.running_agents));
        }
        _ => {
            counted.remove(launch_id);
        }
    }
    read.running_agents
}

/// Each tab's last [`running_subagents`] answer: the transcript version it
/// was counted at, and the count.
static RUNNING_COUNTED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, (String, u32)>>> =
    std::sync::LazyLock::new(Default::default);

/// The handle a subagent's entry carries: a digest of the id its CLI gave it,
/// so no id of the CLI's — a resume handle — crosses to the phone, and a
/// handle read back can only be matched against the subagents of the session
/// asked about, never followed as a name.
///
/// The hash's context string is pinned (`PINNED_…`), like `gateway_id_of`'s:
/// a handle the phone already holds must still match after a rename, and the
/// string is never shown or written anywhere.
pub fn subagent_token(id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{}{id}", crate::brand::PINNED_SUBAGENT_TOKEN_CONTEXT).as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// A well-formed [`subagent_token`]: sixteen lowercase hex digits.
pub fn is_subagent_token(token: &str) -> bool {
    token.len() == 16 && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The transcript file behind a Claude or Codex tab, resolved the way every
/// other read of it is ([`agent_session::read_agent_transcript_from`]), never
/// the launch id's once a live id is recorded.
fn session_file(cmd: &str, project_id: Option<&str>, launch_id: &str) -> Option<PathBuf> {
    agent_session::read_agent_transcript_from(
        cmd,
        project_id,
        launch_id,
        // Never the launch id's file once a live id is recorded: after a
        // `/clear` that file is the cleared conversation.
        false,
        |path, _| Some(path.to_path_buf()),
        // Codex's thread store keeps no messages (only a thread's first one),
        // so a release that writes no rollout has no conversation to read.
        |_, _| None,
    )
}

/// A Claude tab's conversation, or one of its subagents'. Claude keeps every
/// subagent of a session — a subagent's own included — in one folder beside
/// the session's file, `<id>/subagents/agent-<agent id>.jsonl`.
fn claude_transcript(
    project_id: Option<&str>,
    launch_id: &str,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    let main = session_file("claude", project_id, launch_id)?;
    let folder = main.with_extension("").join("subagents");
    let spawns = Spawns::Claude(&folder);
    match subagent {
        None => read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, version, limit),
        Some(token) => {
            let file = claude_subagent_file(&folder, token)?;
            read_transcript_in(&file, TranscriptKind::Claude, &spawns, true, version, limit)
        }
    }
}

/// The file a Claude or Codex tab's conversation is stored in — or, with
/// `subagent`, that subagent's own — resolved as [`claude_transcript`] and
/// [`codex_transcript`] resolve it (`services::agent_changes` reads it too).
pub(crate) fn conversation_file(
    cmd: &str,
    project_id: Option<&str>,
    launch_id: &str,
    subagent: Option<&str>,
) -> Option<PathBuf> {
    let main = session_file(cmd, project_id, launch_id)?;
    let Some(token) = subagent else {
        return Some(main);
    };
    match cmd {
        "claude" => claude_subagent_file(&main.with_extension("").join("subagents"), token),
        "codex" => {
            let thread = agent_session::read_live_session_for(project_id, launch_id)?;
            let stores = crate::services::codex_store::state_dbs(Some(project_id.unwrap_or("root")));
            let child = stores.iter().find_map(|db| {
                crate::services::codex_store::descendant_threads(db, &thread, MAX_SUBAGENT_DEPTH)
                    .into_iter()
                    .find(|child| subagent_token(&child.id) == token)
            })?;
            codex_rollout(project_id, &child)
        }
        _ => None,
    }
}

/// The subagent file in `folder` whose handle is `token`.
fn claude_subagent_file(folder: &Path, token: &str) -> Option<PathBuf> {
    std::fs::read_dir(folder).ok()?.flatten().map(|entry| entry.path()).find(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("agent-")?.strip_suffix(".jsonl"))
            .is_some_and(|id| subagent_token(id) == token)
    })
}

/// A Codex tab's conversation, or one of its subagents'. A subagent is a
/// thread of its own with a rollout of its own; which threads a thread
/// spawned is the state store's spawn-edge table
/// ([`crate::services::codex_store::spawned_threads`]).
fn codex_transcript(
    project_id: Option<&str>,
    launch_id: &str,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    let main = session_file("codex", project_id, launch_id)?;
    let thread = agent_session::read_live_session_for(project_id, launch_id)?;
    let stores = crate::services::codex_store::state_dbs(Some(project_id.unwrap_or("root")));
    let Some(token) = subagent else {
        let spawns = Spawns::Codex { stores: &stores, thread: &thread };
        return read_transcript_in(&main, TranscriptKind::Codex, &spawns, false, version, limit);
    };
    let child = stores.iter().find_map(|db| {
        crate::services::codex_store::descendant_threads(db, &thread, MAX_SUBAGENT_DEPTH)
            .into_iter()
            .find(|child| subagent_token(&child.id) == token)
    })?;
    let rollout = codex_rollout(project_id, &child)?;
    let spawns = Spawns::Codex { stores: &stores, thread: &child.id };
    read_transcript_in(&rollout, TranscriptKind::Codex, &spawns, false, version, limit)
}

/// A spawned thread's rollout: the path its row names, taken only when it is
/// a file under the scope's `.codex/sessions` whose name ends in the thread's id.
fn codex_rollout(project_id: Option<&str>, thread: &crate::services::codex_store::SpawnedThread) -> Option<PathBuf> {
    codex_rollout_in(&agent_session::codex_sessions_root(project_id), thread)
}

/// Testable core of [`codex_rollout`] against an explicit sessions root.
/// Codex records the path as its own tab sees it — inside the fence the agent
/// home is mounted as `$HOME`, so the row says `/home/<user>/.codex/sessions/…`
/// while Tabtivity reads the same file under `<state_dir>/agent-homes/<key>` — so
/// the part after `.codex/sessions/` is re-rooted onto `root` first, and the
/// recorded path is tried as is only after that.
fn codex_rollout_in(root: &Path, thread: &crate::services::codex_store::SpawnedThread) -> Option<PathBuf> {
    let root = std::fs::canonicalize(root).ok()?;
    let recorded = Path::new(thread.rollout_path.as_deref()?);
    let parts: Vec<_> = recorded.components().map(|part| part.as_os_str()).collect();
    let rerooted = parts
        .windows(2)
        .position(|pair| pair[0] == ".codex" && pair[1] == "sessions")
        .map(|at| root.join(parts[at + 2..].iter().collect::<PathBuf>()));
    let named = |path: &Path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(&format!("{}.jsonl", thread.id)))
    };
    rerooted
        .into_iter()
        .chain(std::iter::once(recorded.to_path_buf()))
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .find(|path| named(path) && path.starts_with(&root) && path.is_file())
}

/// A Claude session the hook has recorded but Claude has not written yet —
/// right after a `/clear`, or a launch before its first turn: available and
/// empty, so the phone shows a fresh chat rather than the screen or the
/// conversation before it.
fn fresh_claude_session(project_id: Option<&str>, launch_id: &str) -> Option<AgentTranscript> {
    if !agent_session::is_uuid_shaped(launch_id) {
        return None;
    }
    let live = agent_session::read_live_session_for(project_id, launch_id)?;
    Some(AgentTranscript {
        available: true,
        version: Some(format!("new:{live}")),
        ..Default::default()
    })
}

/// A Codex tab whose session has not started yet: Codex mints its session id
/// itself and reports it to the hook only once the session starts, with its
/// first turn — so a new or restored tab has no id recorded until then.
/// Available and empty, as a fresh Claude session is, rather than "not found"
/// on every Codex tab until it is prompted. Local tabs only: a remote tab's
/// hook records on the remote host, never here, so it would wait forever.
fn fresh_codex_session(project_id: Option<&str>, launch_id: &str) -> Option<AgentTranscript> {
    if !agent_session::is_uuid_shaped(launch_id)
        || agent_session::read_live_session_for(project_id, launch_id).is_some()
        || project_id.is_some_and(|id| crate::services::remote::remote_target_for(id).is_some())
    {
        return None;
    }
    Some(AgentTranscript {
        available: true,
        version: Some(format!("new:{launch_id}")),
        ..Default::default()
    })
}

/// An OpenCode tab's conversation, from OpenCode's session store
/// (`services::opencode_store`): the newest session of the tab's folder —
/// created since `since` for a tab opened fresh, so it never shows the
/// folder's previous conversation — or, with `subagent`, one of the child
/// sessions it spawned. A remote tab's OpenCode writes a store on
/// the remote host, so it has none here to read.
/// A local-model OpenCode tab's conversation (`ollama launch opencode`): what
/// [`agent_session_transcript`] answers for `opencode`, read from the scope's
/// local-model home, where such a tab's OpenCode keeps its sessions.
pub fn local_opencode_transcript(
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    since: Option<i64>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    if subagent.is_some_and(|token| !is_subagent_token(token)) {
        return AgentTranscript::unavailable("no_subagent");
    }
    let db = crate::services::opencode_store::local_model_db_path_for(project_id);
    opencode_transcript(&db, project_id, tab_dir, since, subagent, version, limit.clamp(1, MAX_LIMIT))
}

fn opencode_transcript(
    db: &Path,
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    since: Option<i64>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentTranscript {
    let Some(dir) = tab_dir.filter(|dir| Path::new(dir).is_absolute()) else {
        return AgentTranscript::unavailable("no_session");
    };
    if project_id.is_some_and(|id| crate::services::remote::remote_target_for(id).is_some()) {
        return AgentTranscript::unavailable("unsupported");
    }
    if !db.is_file() {
        return AgentTranscript::unavailable("no_transcript");
    }
    crate::services::opencode_store::session_transcript(db, dir, since, subagent, version, limit)
        .unwrap_or_else(|| AgentTranscript::unavailable("read_failed"))
}

/// The file's fingerprint: its length and modification time. Both move on
/// every append, and neither costs a read.
pub(crate) fn fingerprint(meta: &std::fs::Metadata) -> String {
    let stamp = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}:{stamp}", meta.len())
}

/// Where the subagents a transcript's agent spawned are found.
enum Spawns<'a> {
    /// None looked for.
    None,
    /// Claude: each `Agent` tool call in the transcript, matched to its
    /// subagent by the `.meta.json` Claude writes beside that subagent's file
    /// in this folder, naming the call.
    Claude(&'a Path),
    /// Codex: the threads `thread` spawned, per its state stores.
    Codex { stores: &'a [PathBuf], thread: &'a str },
}

/// Read the transcript at `path` — its tail, then the last `limit` entries.
/// `None` only when the file cannot be read; a session with no turn yet is an
/// empty, available transcript.
pub fn read_transcript(
    path: &Path,
    kind: TranscriptKind,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    read_transcript_in(path, kind, &Spawns::None, false, version, limit)
}

/// [`read_transcript`], with the subagents it spawned as `agent` entries.
/// `sidechain` reads a Claude subagent's own file, every record of which is
/// flagged as one — the flag that keeps them out of the session's
/// conversation is what they all share there.
fn read_transcript_in(
    path: &Path,
    kind: TranscriptKind,
    spawns: &Spawns,
    sidechain: bool,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let mut current = fingerprint(&meta);
    // A subagent's `.meta.json` can land after the call that spawned it was
    // written, while the session's file sits still until the subagent is done.
    if let Spawns::Claude(folder) = spawns {
        if let Ok(folder) = std::fs::metadata(folder) {
            current = format!("{current}:{}", fingerprint(&folder));
        }
    }
    if version == Some(current.as_str()) && background_unchanged(path, &current) {
        return Some(AgentTranscript {
            available: true,
            version: Some(current),
            unchanged: true,
            ..Default::default()
        });
    }
    let len = meta.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    let mut truncated = false;
    if start > 0 {
        // Whatever came before the seek point is missing from the first line.
        lines.remove(0);
        truncated = true;
    }
    let usage = match kind {
        TranscriptKind::Codex => codex_usage(&lines),
        TranscriptKind::Claude => None,
    };
    let model = newest_model(&lines, kind);
    let tokens = newest_tokens(&lines, kind);
    let (mut entries, calls, shell_calls) = parse_entries(lines.into_iter(), kind, sidechain);
    let shells = running_shells(path, &current, shell_calls);
    // Every subagent the session spawned, as tokens, for `agents_earlier`.
    let mut spawned_tokens: Vec<String> = Vec::new();
    match spawns {
        Spawns::None => {}
        Spawns::Claude(folder) => {
            // The session's own read only: a subagent's file shares the folder
            // but spawned none of what it lists.
            if !calls.is_empty() || (truncated && !sidechain) {
                let spawned = claude_spawned(folder);
                for (index, call) in calls {
                    entries[index].subagent = spawned.get(&call).map(|id| subagent_token(id));
                }
                if !sidechain {
                    spawned_tokens = spawned.values().map(|id| subagent_token(id)).collect();
                }
            }
        }
        Spawns::Codex { stores, thread } => {
            let children = stores
                .iter()
                .map(|db| crate::services::codex_store::spawned_threads(db, thread))
                .find(|children| !children.is_empty())
                .unwrap_or_default();
            let placed: Vec<TranscriptEntry> = children.iter().filter_map(codex_agent_entry).collect();
            spawned_tokens = placed.iter().filter_map(|entry| entry.subagent.clone()).collect();
            insert_by_time(&mut entries, placed, truncated);
        }
    }
    let running_agents = running_agents(&entries);
    if entries.len() > limit {
        let drop = entries.len() - limit;
        entries.drain(..drop);
        truncated = true;
    }
    let agents_earlier = truncated && agents_unlisted(&entries, &spawned_tokens);
    Some(AgentTranscript {
        available: true,
        reason: None,
        version: Some(current),
        unchanged: false,
        entries,
        truncated,
        agents_earlier,
        running_agents,
        usage,
        model,
        tokens,
        shells,
    })
}

/// How many of `entries`' subagents are still at work — counted over every
/// entry read, before the limit cuts the front off: a background one spawned
/// many turns ago can still be running.
pub(crate) fn running_agents(entries: &[TranscriptEntry]) -> u32 {
    entries.iter().filter(|entry| entry.kind == "agent" && entry.running).count() as u32
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

/// Each transcript's background shells as last answered: the version, their
/// output files, and which of those still ran. A shell that died with its CLI
/// writes nothing to the transcript, so an unchanged file is answered
/// `unchanged` only while the same ones still run.
type BackgroundSeen = std::collections::HashMap<PathBuf, (String, Vec<String>, std::collections::HashSet<String>)>;
static BACKGROUND_SEEN: std::sync::LazyLock<std::sync::Mutex<BackgroundSeen>> = std::sync::LazyLock::new(Default::default);
/// Transcripts remembered at most; past it the memory starts over, which
/// costs one full read each.
const BACKGROUND_SEEN_MAX: usize = 64;

/// Whether `path`'s background shells, at `version`, run as they did when
/// last answered.
fn background_unchanged(path: &Path, version: &str) -> bool {
    let seen = BACKGROUND_SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some((at, outputs, running)) = seen.get(path) else {
        return true;
    };
    if at != version {
        return true;
    }
    let outputs: Vec<&str> = outputs.iter().map(String::as_str).collect();
    running_outputs(&outputs) == *running
}

/// The shells to show: every call still waiting on its result, then the
/// background ones whose output file is still held open — remembered for
/// [`background_unchanged`].
fn running_shells(path: &Path, version: &str, calls: ShellCalls) -> Vec<RunningShell> {
    let outputs: Vec<&str> = calls.background.iter().map(|(_, output)| output.as_str()).collect();
    let running = running_outputs(&outputs);
    let mut seen = BACKGROUND_SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if outputs.is_empty() {
        seen.remove(path);
    } else {
        if seen.len() >= BACKGROUND_SEEN_MAX && !seen.contains_key(path) {
            seen.clear();
        }
        seen.insert(path.to_path_buf(), (version.to_string(), outputs.iter().map(|o| o.to_string()).collect(), running.clone()));
    }
    drop(seen);
    let mut shells = calls.waiting;
    shells.extend(calls.background.into_iter().filter(|(_, output)| running.contains(output)).map(|(shell, _)| shell));
    shells
}

/// The model the newest record in `lines` names, as the tab's model tag
/// reads it ([`agent_session::model_in_record`]).
fn newest_model(lines: &[&str], kind: TranscriptKind) -> Option<String> {
    lines.iter().rev().find_map(|line| agent_session::model_in_record(line, kind))
}

/// The tokens the newest record in `lines` that carries usage counts
/// ([`AgentTranscript::tokens`]): a Claude assistant message's input, cache
/// and output tokens together, or a Codex `token_count`'s last request.
fn newest_tokens(lines: &[&str], kind: TranscriptKind) -> Option<u64> {
    let needle = match kind {
        TranscriptKind::Claude => "\"usage\"",
        TranscriptKind::Codex => "\"token_count\"",
    };
    lines.iter().rev().filter(|line| line.contains(needle)).find_map(|line| {
        let value = serde_json::from_str::<Value>(line).ok()?;
        match kind {
            TranscriptKind::Claude => {
                let message = value.get("message").filter(|_| value.get("type").and_then(Value::as_str) == Some("assistant"))?;
                let usage = message.get("usage")?;
                let count = |name: &str| usage.get(name).and_then(Value::as_u64).unwrap_or(0);
                let total = count("input_tokens")
                    + count("cache_creation_input_tokens")
                    + count("cache_read_input_tokens")
                    + count("output_tokens");
                (total > 0).then_some(total)
            }
            TranscriptKind::Codex => value
                .get("payload")
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("token_count"))?
                .pointer("/info/last_token_usage/total_tokens")?
                .as_u64(),
        }
    })
}

/// The subagents in a Claude session's `folder`, by the tool call that
/// spawned each: `toolu_…` → the agent id its file is named by.
fn claude_spawned(folder: &Path) -> std::collections::HashMap<String, String> {
    let mut spawned = std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir(folder) else {
        return spawned;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let Some(id) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("agent-")?.strip_suffix(".meta.json"))
        else {
            continue;
        };
        // A few hundred bytes; anything much larger is not Claude's.
        if std::fs::metadata(&path).map_or(true, |meta| meta.len() > 64 * 1024) {
            continue;
        }
        let call = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|meta| meta.get("toolUseId").and_then(Value::as_str).map(str::to_string));
        if let Some(call) = call {
            spawned.insert(call, id.to_string());
        }
    }
    spawned
}

/// Whether any of the session's `spawned` subagents (tokens) is missing from
/// `entries` — one only the turns a truncated answer leaves out list.
pub(crate) fn agents_unlisted(entries: &[TranscriptEntry], spawned: &[String]) -> bool {
    let listed: std::collections::HashSet<&str> = entries.iter().filter_map(|entry| entry.subagent.as_deref()).collect();
    spawned.iter().any(|token| !listed.contains(token.as_str()))
}

/// A spawned Codex thread as its parent's `agent` entry, at the moment it was
/// created: its task, and its role and nickname as the kind.
fn codex_agent_entry(child: &crate::services::codex_store::SpawnedThread) -> Option<TranscriptEntry> {
    let kind = [child.role.as_deref(), child.nickname.as_deref()]
        .into_iter()
        .flatten()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let mut entry = agent_entry(&child.task, Some(&kind), child.created_ms.map(crate::services::prompt_blame::epoch_ms_to_iso))?;
    entry.subagent = Some(subagent_token(&child.id));
    Some(entry)
}

/// Place `placed` among `entries` by time: each after the last entry that is
/// not later than it. One that predates what a tail read (`truncated`) kept is
/// dropped rather than shown at the top of turns it came long before.
pub(crate) fn insert_by_time(entries: &mut Vec<TranscriptEntry>, placed: Vec<TranscriptEntry>, truncated: bool) {
    fn epoch_ms(entry: &TranscriptEntry) -> Option<i64> {
        chrono::DateTime::parse_from_rfc3339(entry.at.as_deref()?).ok().map(|at| at.timestamp_millis())
    }
    let first = entries.iter().find_map(epoch_ms);
    for entry in placed {
        let Some(at) = epoch_ms(&entry) else {
            continue;
        };
        if truncated && first.is_none_or(|first| at < first) {
            continue;
        }
        let index = entries
            .iter()
            .rposition(|shown| epoch_ms(shown).is_some_and(|shown| shown <= at))
            .map_or(0, |index| index + 1);
        entries.insert(index, entry);
    }
}

/// Tokens Codex counts as the fixed cost of any conversation (instructions,
/// tools) and leaves out of its "context left" — the footer's own baseline.
const CODEX_BASELINE_TOKENS: i64 = 12_000;
/// A window this long or shorter is the session one; longer is the week.
const SESSION_WINDOW_MAX_MINUTES: i64 = 24 * 60;

/// The newest context and rate-limit figures in a Codex rollout's `lines`.
/// Each comes from the newest `token_count` event that carries it: an event
/// can hold the limits without the token counts, or the other way round.
fn codex_usage(lines: &[&str]) -> Option<TranscriptUsage> {
    let mut usage = TranscriptUsage::default();
    let mut limits_read = false;
    for line in lines.iter().rev() {
        if usage.context_left.is_some() && limits_read {
            break;
        }
        if !line.contains("\"token_count\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(payload) = value
            .get("payload")
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("token_count"))
        else {
            continue;
        };
        if usage.context_left.is_none() {
            usage.context_left = payload.get("info").and_then(codex_context_left);
        }
        if !limits_read {
            if let Some(limits) = payload.get("rate_limits").filter(|l| l.is_object()) {
                limits_read = true;
                for (key, fallback_session) in [("primary", true), ("secondary", false)] {
                    let Some(window) = limits.get(key).filter(|w| w.is_object()) else {
                        continue;
                    };
                    let Some(used) = window.get("used_percent").and_then(Value::as_f64) else {
                        continue;
                    };
                    let reading = UsageWindow {
                        used: used.clamp(0.0, 100.0).round() as u8,
                        resets_at: window.get("resets_at").and_then(Value::as_u64),
                    };
                    let session = window
                        .get("window_minutes")
                        .and_then(Value::as_i64)
                        .map_or(fallback_session, |minutes| minutes <= SESSION_WINDOW_MAX_MINUTES);
                    let slot = if session { &mut usage.session } else { &mut usage.week };
                    slot.get_or_insert(reading);
                }
            }
        }
    }
    (usage != TranscriptUsage::default()).then_some(usage)
}

/// Codex's "context left": the last request's tokens against the model's
/// window, both less the baseline every conversation carries.
fn codex_context_left(info: &Value) -> Option<u8> {
    let window = info.get("model_context_window")?.as_i64()?;
    let used = info.get("last_token_usage")?.get("total_tokens")?.as_i64()?;
    if window <= CODEX_BASELINE_TOKENS {
        return None;
    }
    let effective = window - CODEX_BASELINE_TOKENS;
    let used = (used - CODEX_BASELINE_TOKENS).max(0);
    let left = (effective - used).max(0) as f64 / effective as f64 * 100.0;
    Some(left.clamp(0.0, 100.0).round() as u8)
}

/// The turns in `lines`, in order. Each answer record is an entry of its own:
/// Claude writes each message of a turn as a record, with the tool calls it
/// made in between, and the phone shows them as separate bubbles — joined
/// into one they ran together ("Let me check…" glued to the final answer).
/// Beside them, each Claude `Agent` call's entry index and call id, for the
/// caller to match to its subagent, and the shells it has started.
fn parse_entries<'a>(
    lines: impl Iterator<Item = &'a str>,
    kind: TranscriptKind,
    sidechain: bool,
) -> (Vec<TranscriptEntry>, Vec<(usize, String)>, ShellCalls) {
    let mut entries: Vec<TranscriptEntry> = Vec::new();
    let mut calls: Vec<(usize, String)> = Vec::new();
    // Shell calls since the last prompt, by call id: one an earlier turn
    // never got a result for (the CLI was killed mid-call) is not running.
    let mut shells: Vec<(String, RunningShell)> = Vec::new();
    // Every shell call read, for a background one's command; the calls sent
    // to the background, with their output files; and those a notification
    // has since ended.
    let mut commands: std::collections::HashMap<String, RunningShell> = std::collections::HashMap::new();
    let mut backgrounded: Vec<(String, String)> = Vec::new();
    let mut ended = std::collections::HashSet::new();
    // The tool calls that have their result: a spawn call without one is a
    // subagent still at work. A background spawn's result comes at once
    // (`async_launched`); what it does after is replayed in `agents`.
    let mut returned = std::collections::HashSet::new();
    let mut agents = BackgroundAgents::default();
    // Where the newest typed prompt's turn starts: a foreground spawn before
    // it that never got its result (the CLI was killed mid-call) is not at
    // work, as a shell from an earlier turn is not.
    let mut turn_start = 0;
    // Questions asked, by call id, until their result comes: the exchange is
    // one entry, placed where the result lands — the agent waits on it, so
    // nothing of its own comes in between.
    let mut asked: std::collections::HashMap<String, (Vec<AskedQuestion>, Option<String>)> = std::collections::HashMap::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(mut value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if sidechain {
            if let Some(record) = value.as_object_mut() {
                record.remove("isSidechain");
            }
        }
        if kind == TranscriptKind::Claude {
            for call in claude_tool_results(&value) {
                if let Some((questions, at)) = asked.remove(&call) {
                    entries.extend(question_entry(questions, value.get("toolUseResult"), at));
                }
                returned.insert(call);
            }
            backgrounded.extend(claude_backgrounded(&value));
            ended.extend(claude_tasks_ended(line));
            agents.read(&value, line);
        }
        let records = match kind {
            TranscriptKind::Claude => claude_records(&value),
            TranscriptKind::Codex => codex_entry(&value).map(|(role, raw)| Record::Turn(role, raw)).into_iter().collect(),
        };
        let at = value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        let typed = value.get("type").and_then(Value::as_str) == Some("user");
        for record in records {
            match record {
                Record::Turn(role, raw) => {
                    if typed && role == "prompt" {
                        shells.clear();
                        turn_start = entries.len();
                    }
                    entries.extend(transcript_entry(role, &raw, at.clone()));
                }
                Record::Shell { call, mut shell } => {
                    shell.at = at.clone();
                    commands.insert(call.clone(), shell.clone());
                    shells.push((call, shell));
                }
                Record::Plan(raw) => entries.extend(transcript_entry("answer", &raw, at.clone()).map(|entry| TranscriptEntry { plan: true, ..entry })),
                Record::Question { call, questions } => {
                    asked.insert(call, (questions, at.clone()));
                }
                Record::Spawn { call, task, kind } => {
                    if let Some(entry) = agent_entry(&task, kind.as_deref(), at.clone()) {
                        calls.push((entries.len(), call));
                        entries.push(entry);
                    }
                }
            }
        }
    }
    for (index, call) in &calls {
        let background = agents.at_work.get(call).copied();
        let finished = background.map_or_else(|| returned.contains(call), |at_work| !at_work);
        entries[*index].running = !finished && (background.is_some() || *index >= turn_start);
        entries[*index].finished = finished;
        entries[*index].background = background.is_some();
    }
    let waiting = shells.into_iter().filter(|(call, _)| !returned.contains(call)).map(|(_, shell)| shell).collect();
    let background = backgrounded
        .into_iter()
        .filter(|(call, _)| !ended.contains(call))
        .filter_map(|(call, output)| Some((RunningShell { background: true, ..commands.remove(&call)? }, output)))
        .collect();
    (entries, calls, ShellCalls { waiting, background })
}

/// Claude's background subagents (`Agent` calls whose result is only the
/// launch, `async_launched`), replayed in record order: launched, each is at
/// work until a task notification says it stopped. Notifications name the
/// call (`<tool-use-id>`) or only the agent (`<task-id>`, on a later stop —
/// or with the id of the `SendMessage` that resumed it); one that "may be
/// interim" stopped with background work of its own still running, and works
/// on until its hand-back message brings the final report. A `SendMessage` to
/// a stopped one resumes it, until its next notification. A notification is recorded more than once (queued,
/// delivered, absorbed): each counts once, where it is first read, so a copy
/// delivered after a resume does not end it again.
#[derive(Default)]
struct BackgroundAgents {
    /// By spawn call: whether it is at work.
    at_work: std::collections::HashMap<String, bool>,
    /// The spawn call of each agent id.
    calls: std::collections::HashMap<String, String>,
    seen: std::collections::HashSet<String>,
}

impl BackgroundAgents {
    fn read(&mut self, value: &Value, line: &str) {
        if let Some((call, agent)) = claude_async_launched(value) {
            self.at_work.insert(call.clone(), true);
            if let Some(agent) = agent {
                self.calls.insert(agent, call);
            }
        }
        for agent in claude_messaged(value) {
            if let Some(at_work) = self.calls.get(&agent).and_then(|call| self.at_work.get_mut(call)) {
                *at_work = true;
            }
        }
        for note in claude_task_notes(line) {
            if !self.seen.insert(note.text.to_string()) || !note.ends || note.interim {
                continue;
            }
            // A resumed agent's notifications name the `SendMessage` call
            // that resumed it, not its spawn: those end it by its task id.
            let call = note
                .call
                .filter(|call| self.at_work.contains_key(call))
                .or_else(|| self.calls.get(note.task.as_deref()?).cloned());
            if let Some(at_work) = call.and_then(|call| self.at_work.get_mut(&call)) {
                *at_work = false;
            }
        }
        // Its final report, handed back as a message, ends an agent that only
        // stopped "interim" — no later notification comes for it.
        for (agent, text) in claude_handbacks(line) {
            if !self.seen.insert(text.to_string()) {
                continue;
            }
            if let Some(at_work) = self.calls.get(&agent).and_then(|call| self.at_work.get_mut(call)) {
                *at_work = false;
            }
        }
    }
}

/// The subagent hand-backs in a raw Claude record — `<agent-message
/// from="<agent id>">` carrying `[Subagent hand-back]`, a subagent's final
/// report — queued or delivered: the agent id, and the whole message.
fn claude_handbacks(line: &str) -> Vec<(String, &str)> {
    line.split("<agent-message from=")
        .skip(1)
        .filter_map(|message| {
            let text = message.split("</agent-message>").next()?;
            if !text.contains("[Subagent hand-back]") {
                return None;
            }
            let id = text.trim_start_matches(['\\', '"']);
            let id = &id[..id.find(['\\', '"'])?];
            Some((id.to_string(), text))
        })
        .collect()
}

/// The spawn call a Claude `user` record says went to the background
/// (`toolUseResult.status` `async_launched`): its result is only the launch.
/// With the agent id its notifications and messages name it by.
fn claude_async_launched(value: &Value) -> Option<(String, Option<String>)> {
    let result = value.get("toolUseResult")?;
    if result.get("status").and_then(Value::as_str) != Some("async_launched") && result.get("isAsync").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let agent = result.get("agentId").and_then(Value::as_str).map(str::to_string);
    let Some(Value::Array(blocks)) = value.get("message").and_then(|m| m.get("content")) else {
        return None;
    };
    let result = blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))?;
    Some((result.get("tool_use_id")?.as_str()?.to_string(), agent))
}

/// Whom a Claude `assistant` record's `SendMessage` calls write to (`to`).
fn claude_messaged(value: &Value) -> Vec<String> {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    let Some(Value::Array(blocks)) = value.get("message").and_then(|m| m.get("content")) else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use") && b.get("name").and_then(Value::as_str) == Some("SendMessage"))
        .filter_map(|b| b.get("input")?.get("to")?.as_str().map(str::to_string))
        .collect()
}

/// A Claude `user` record's shell results that went to the background
/// (`toolUseResult.backgroundTaskId`): the call, and the output file the
/// result names — `<…>/<task id>.output`, written to while it runs.
fn claude_backgrounded(value: &Value) -> Option<(String, String)> {
    let task = value.get("toolUseResult")?.get("backgroundTaskId")?.as_str()?;
    let Some(Value::Array(blocks)) = value.get("message").and_then(|m| m.get("content")) else {
        return None;
    };
    let result = blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))?;
    let call = result.get("tool_use_id")?.as_str()?;
    let text = match result.get("content")? {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => return None,
    };
    let name = format!("/{task}.output");
    let output = text
        .split_whitespace()
        .map(|word| word.trim_end_matches('.'))
        .find(|word| word.starts_with('/') && word.ends_with(&name))?;
    Some((call.to_string(), output.to_string()))
}

/// One `<task-notification>` in a raw Claude record: the call it names
/// (`<tool-use-id>`, absent on an agent's later stops), the task
/// (`<task-id>`), whether its status ends the task — every one but
/// `starting` (`completed`, `failed`, `killed`, `stopped`) — and whether its
/// note says the result "may be interim". `text` is the whole notification.
struct TaskNote<'a> {
    call: Option<String>,
    task: Option<String>,
    ends: bool,
    interim: bool,
    text: &'a str,
}

/// The `<task-notification>`s in a raw Claude record — queued, delivered as
/// a prompt, or absorbed mid-turn.
fn claude_task_notes(line: &str) -> Vec<TaskNote<'_>> {
    let tag = |text: &str, name: &str| -> Option<String> {
        let open = format!("<{name}>");
        let start = text.find(&open)? + open.len();
        let end = text[start..].find(&format!("</{name}>"))?;
        Some(text[start..start + end].to_string())
    };
    line.split("<task-notification>")
        .skip(1)
        .filter_map(|note| {
            let text = note.split("</task-notification>").next()?;
            let status = tag(text, "status")?;
            Some(TaskNote {
                call: tag(text, "tool-use-id").filter(|call| call.starts_with("toolu_")),
                task: tag(text, "task-id"),
                ends: status != "starting",
                interim: text.contains("may be interim"),
                text,
            })
        })
        .collect()
}

/// The background calls a raw Claude record says have ended: each
/// notification that names its call and ends it (`claude_task_notes`).
fn claude_tasks_ended(line: &str) -> Vec<String> {
    claude_task_notes(line).into_iter().filter(|note| note.ends).filter_map(|note| note.call).collect()
}

/// Which of `outputs` some process still holds open — a background shell
/// writes its output file until it exits, and a CLI that quit took its
/// shells with it without a notification. Read off `/proc/<pid>/fd`, whose
/// links name the file as the process sees it — the path its CLI wrote down,
/// inside a fence or a container too. Elsewhere nothing is known to run.
fn running_outputs(outputs: &[&str]) -> std::collections::HashSet<String> {
    let mut open = std::collections::HashSet::new();
    if outputs.is_empty() || !cfg!(target_os = "linux") {
        return open;
    }
    let Ok(procs) = std::fs::read_dir("/proc") else {
        return open;
    };
    for proc in procs.flatten() {
        if !proc.file_name().to_str().is_some_and(|name| name.bytes().all(|b| b.is_ascii_digit())) {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(proc.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            if let Ok(target) = std::fs::read_link(fd.path()) {
                if let Some(output) = outputs.iter().find(|output| target.as_os_str() == **output) {
                    open.insert(output.to_string());
                }
            }
        }
        if open.len() == outputs.len() {
            break;
        }
    }
    open
}

/// The tool calls a Claude `user` record carries the results of.
fn claude_tool_results(value: &Value) -> Vec<String> {
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return Vec::new();
    }
    let Some(Value::Array(blocks)) = value.get("message").and_then(|m| m.get("content")) else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter_map(|b| b.get("tool_use_id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// What one record contributes.
enum Record {
    /// A prompt or an answer.
    Turn(&'static str, String),
    /// A plan put up for approval: an answer, marked as the plan.
    Plan(String),
    /// A subagent spawned by tool call `call`, sent to do `task`.
    Spawn { call: String, task: String, kind: Option<String> },
    /// A shell command started by tool call `call`.
    Shell { call: String, shell: RunningShell },
    /// Questions put to the user by tool call `call`, not yet answered.
    Question { call: String, questions: Vec<AskedQuestion> },
}

/// A subagent's entry: its task as one bounded line, its kind beside it.
/// `None` when neither says anything.
pub(crate) fn agent_entry(task: &str, kind: Option<&str>, at: Option<String>) -> Option<TranscriptEntry> {
    let line = |raw: &str, bound: usize| -> Option<(String, bool)> {
        let text = clean_text(raw)?.split_whitespace().collect::<Vec<_>>().join(" ");
        let cut = text.chars().count() > bound;
        Some((if cut { text.chars().take(bound).collect() } else { text }, cut))
    };
    let (text, cut) = line(task, MAX_AGENT_CHARS).unwrap_or_default();
    let role = kind.and_then(|kind| line(kind, MAX_ROLE_CHARS)).map(|(role, _)| role);
    if text.is_empty() && role.is_none() {
        return None;
    }
    Some(TranscriptEntry { kind: "agent".to_string(), text, at, cut, role, ..Default::default() })
}

/// One turn as the phone shows it: `raw` cleaned (`clean_text`) and cut at
/// its kind's bound. `None` when nothing is left to show. Shared by every
/// reader, whatever the agent keeps its conversation in.
pub(crate) fn transcript_entry(role: &str, raw: &str, at: Option<String>) -> Option<TranscriptEntry> {
    let bound = if role == "answer" { MAX_ANSWER_CHARS } else { MAX_PROMPT_CHARS };
    let mut entry = TranscriptEntry {
        kind: role.to_string(),
        text: clean_text(raw)?,
        at,
        ..Default::default()
    };
    bound_entry(&mut entry, bound);
    Some(entry)
}

/// Cut `entry.text` at `bound` characters, marking the cut.
fn bound_entry(entry: &mut TranscriptEntry, bound: usize) {
    if entry.text.chars().count() > bound {
        entry.text = entry.text.chars().take(bound).collect();
        entry.cut = true;
    }
}

/// The text fit to show: line endings normalized, control characters other
/// than the line break and the tab dropped, trimmed. Empty is no entry.
fn clean_text(raw: &str) -> Option<String> {
    let text: String = raw
        .replace("\r\n", "\n")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// A Claude record as turns: a `user` record that is a prompt (the same
/// reading the last-prompt line makes — tool results, meta notes and
/// reminders are not), a prompt the user queued mid-turn (the prompt chart's
/// reading), or an `assistant` record's text blocks, the plan its
/// `ExitPlanMode` call put up, the subagents its `Agent` calls spawned and
/// the questions its `AskUserQuestion` calls asked. Thinking and other tool-use blocks are stepped over, as is a sidechain (a
/// subagent's) record.
fn claude_records(value: &Value) -> Vec<Record> {
    let sidechain = value.get("isSidechain").and_then(Value::as_bool) == Some(true);
    match value.get("type").and_then(Value::as_str) {
        Some("user") => agent_session::claude_prompt_in_record(value)
            .map(|text| Record::Turn("prompt", text))
            .into_iter()
            .collect(),
        // A prompt typed while Claude was working lives only here.
        Some("attachment") if !sidechain => agent_session::claude_queued_prompt(value)
            .map(|text| Record::Turn("prompt", text))
            .into_iter()
            .collect(),
        Some("assistant") if !sidechain => {
            let Some(content) = value.get("message").and_then(|m| m.get("content")) else {
                return Vec::new();
            };
            let (text, spawns) = match content {
                Value::String(text) => (text.clone(), Vec::new()),
                Value::Array(blocks) => (
                    blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n\n"),
                    blocks
                        .iter()
                        .filter_map(|b| claude_plan(b).or_else(|| claude_spawn(b)).or_else(|| claude_shell(b)).or_else(|| claude_question(b)))
                        .collect(),
                ),
                _ => return Vec::new(),
            };
            let text = text.trim();
            (!text.is_empty())
                .then(|| Record::Turn("answer", text.to_string()))
                .into_iter()
                .chain(spawns)
                .collect()
        }
        _ => Vec::new(),
    }
}

/// An `ExitPlanMode` `tool_use` block: the plan Claude put up for approval.
fn claude_plan(block: &Value) -> Option<Record> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use")
        || block.get("name").and_then(Value::as_str) != Some("ExitPlanMode")
    {
        return None;
    }
    let plan = block.get("input")?.get("plan")?.as_str()?.trim();
    (!plan.is_empty()).then(|| Record::Plan(plan.to_string()))
}

/// An `AskUserQuestion` `tool_use` block: the questions, with their rows.
fn claude_question(block: &Value) -> Option<Record> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use")
        || block.get("name").and_then(Value::as_str) != Some("AskUserQuestion")
    {
        return None;
    }
    let call = block.get("id")?.as_str()?.to_string();
    let field = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).and_then(bounded_line);
    let questions: Vec<AskedQuestion> = block
        .get("input")?
        .get("questions")?
        .as_array()?
        .iter()
        .filter_map(|q| {
            Some(AskedQuestion {
                header: field(q, "header"),
                question: field(q, "question")?,
                options: q
                    .get("options")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|o| Some(AskedOption { label: field(o, "label")?, description: field(o, "description"), chosen: false }))
                    .collect(),
                answer: None,
            })
        })
        .collect();
    (!questions.is_empty()).then_some(Record::Question { call, questions })
}

/// A question's text cleaned and cut at its bound; `None` when empty.
fn bounded_line(raw: &str) -> Option<String> {
    Some(clean_text(raw)?.chars().take(MAX_QUESTION_CHARS).collect())
}

/// The entry for questions whose call has its result: each answer read off
/// the result's `answers` (keyed by the question's text as asked) and the
/// rows it took marked. A call turned down has no answers, and its questions
/// none.
fn question_entry(mut questions: Vec<AskedQuestion>, result: Option<&Value>, at: Option<String>) -> Option<TranscriptEntry> {
    let answers = result.and_then(|r| r.get("answers")).and_then(Value::as_object);
    for question in &mut questions {
        question.answer = answers
            .and_then(|a| a.iter().find(|(asked, _)| bounded_line(asked).as_deref() == Some(question.question.as_str())))
            .and_then(|(_, answer)| answer.as_str())
            .and_then(bounded_line);
        if let Some(answer) = &question.answer {
            for option in &mut question.options {
                option.chosen = *answer == option.label || answer.split(", ").any(|part| part == option.label);
            }
        }
    }
    let text = questions
        .iter()
        .map(|q| format!("{}\n→ {}", q.question, q.answer.as_deref().unwrap_or("—")))
        .collect::<Vec<_>>()
        .join("\n\n");
    transcript_entry("answer", &text, at).map(|entry| TranscriptEntry { questions, ..entry })
}

/// A `Bash` `tool_use` block: the command, and the description Claude gave it.
fn claude_shell(block: &Value) -> Option<Record> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use")
        || block.get("name").and_then(Value::as_str) != Some("Bash")
    {
        return None;
    }
    let call = block.get("id")?.as_str()?.to_string();
    let input = block.get("input")?;
    let raw = clean_text(input.get("command")?.as_str()?)?;
    let cut = raw.chars().count() > MAX_SHELL_CHARS;
    let command = if cut { raw.chars().take(MAX_SHELL_CHARS).collect() } else { raw };
    let description = input
        .get("description")
        .and_then(Value::as_str)
        .and_then(clean_text)
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_SHELL_DESCRIPTION_CHARS).collect());
    Some(Record::Shell { call, shell: RunningShell { command, description, cut, ..Default::default() } })
}

/// A `tool_use` block that spawns a subagent — `Agent`, `Task` before it was
/// renamed — with the short description Claude gave it, or the start of the
/// task itself when it gave none.
fn claude_spawn(block: &Value) -> Option<Record> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use")
        || !matches!(block.get("name").and_then(Value::as_str), Some("Agent" | "Task"))
    {
        return None;
    }
    let input = block.get("input");
    let field = |key: &str| input.and_then(|i| i.get(key)).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    Some(Record::Spawn {
        call: block.get("id").and_then(Value::as_str)?.to_string(),
        task: field("description").or_else(|| field("prompt")).unwrap_or_default().to_string(),
        kind: Some(field("subagent_type").unwrap_or("general-purpose").to_string()),
    })
}

/// A Codex rollout record as a turn: the `response_item` messages — the
/// user's `input_text` (minus the context Codex injects, as the last-prompt
/// reader skips it) and the assistant's `output_text`. The `event_msg` copies
/// of the same messages are not read, so nothing shows twice; function calls,
/// their outputs and reasoning items are stepped over. A `/goal` has no
/// message of its own and is read off the event that sets it.
fn codex_entry(value: &Value) -> Option<(&'static str, String)> {
    let payload = value.get("payload")?;
    match value.get("type").and_then(Value::as_str)? {
        "response_item" => {}
        "event_msg" if payload.get("type").and_then(Value::as_str) == Some("thread_goal_updated") => {
            return agent_session::codex_prompt_in_record(value).map(|text| ("prompt", text));
        }
        _ => return None,
    }
    if payload.get("type").and_then(Value::as_str)? != "message" {
        return None;
    }
    match payload.get("role").and_then(Value::as_str)? {
        "user" => agent_session::codex_prompt_in_record(value).map(|text| ("prompt", text)),
        "assistant" => {
            let text = payload
                .get("content")?
                .as_array()?
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("output_text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n\n");
            let text = text.trim();
            (!text.is_empty()).then(|| ("answer", text.to_string()))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(transcript: &AgentTranscript) -> Vec<(&str, &str)> {
        transcript
            .entries
            .iter()
            .map(|e| (e.kind.as_str(), e.text.as_str()))
            .collect()
    }

    #[test]
    fn a_claude_plan_put_up_for_approval_is_an_answer_marked_as_the_plan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"plan the merge\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Here is the plan.\"},{\"type\":\"tool_use\",\"id\":\"toolu_P\",\"name\":\"ExitPlanMode\",\"input\":{\"plan\":\"# Merge\\n\\n1. Move the search\\n\"}}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_Q\",\"name\":\"ExitPlanMode\",\"input\":{\"plan\":\"  \"}}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Done.\"}]}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(
            kinds(&read),
            vec![("prompt", "plan the merge"), ("answer", "Here is the plan."), ("answer", "# Merge\n\n1. Move the search"), ("answer", "Done.")]
        );
        // Only the plan is marked, and an empty one is no entry.
        assert_eq!(read.entries.iter().map(|e| e.plan).collect::<Vec<_>>(), vec![false, false, true, false]);
        let wire = serde_json::to_value(&read.entries[2]).unwrap();
        assert_eq!(wire["plan"], true);
        assert!(serde_json::to_value(&read.entries[1]).unwrap().get("plan").is_none());
    }

    #[test]
    fn a_claude_question_stays_in_the_chat_with_its_answer_once_answered() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let ask = |id: &str, question: &str| {
            format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"2026-10-02T10:00:00Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"{id}\",\"name\":\"AskUserQuestion\",\"input\":{{\"questions\":[{{\"question\":\"{question}\",\"header\":\"Pick\",\"options\":[{{\"label\":\"Red\",\"description\":\"Warm\"}},{{\"label\":\"Blue\"}}],\"multiSelect\":true}}]}}}}]}}}}\n"
            )
        };
        let mut text = String::from("{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"ask me\"}}\n");
        text += &ask("toolu_A", "Which colours?");
        text += "{\"type\":\"user\",\"timestamp\":\"2026-10-02T10:01:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_A\",\"content\":\"Your questions have been answered\"}]},\"toolUseResult\":{\"answers\":{\"Which colours?\":\"Red, Blue\"}}}\n";
        text += &ask("toolu_B", "Which one?");
        text += "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_B\",\"content\":\"The user doesn't want to proceed\",\"is_error\":true}]},\"toolUseResult\":\"User rejected tool use\"}\n";
        text += "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Noted.\"}]}}\n";
        // Still waiting: the live screen shows it, the chat does not yet.
        text += &ask("toolu_C", "Still open?");
        std::fs::write(&path, text).unwrap();
        let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(
            kinds(&read),
            vec![("prompt", "ask me"), ("answer", "Which colours?\n→ Red, Blue"), ("answer", "Which one?\n→ —"), ("answer", "Noted.")]
        );
        let answered = &read.entries[1];
        // Placed at the question's own time, not the answer's.
        assert_eq!(answered.at.as_deref(), Some("2026-10-02T10:00:00Z"));
        assert_eq!(answered.questions.len(), 1);
        let question = &answered.questions[0];
        assert_eq!(question.header.as_deref(), Some("Pick"));
        assert_eq!(question.answer.as_deref(), Some("Red, Blue"));
        assert_eq!(question.options.iter().map(|o| (o.label.as_str(), o.chosen)).collect::<Vec<_>>(), vec![("Red", true), ("Blue", true)]);
        assert_eq!(question.options[0].description.as_deref(), Some("Warm"));
        // Turned down: the question stays, with no answer and no row taken.
        let declined = &read.entries[2].questions[0];
        assert_eq!(declined.answer, None);
        assert!(declined.options.iter().all(|o| !o.chosen));
        assert!(serde_json::to_value(&read.entries[3]).unwrap().get("questions").is_none());
    }

    #[test]
    fn a_claude_transcript_reads_as_prompts_and_one_bubble_per_message() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-09-15T05:49:39.013Z\",\"message\":{\"role\":\"user\",\"content\":\"add a clear\\nbutton\"}}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"note to self\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hmm\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Looking at the composer.\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"name\":\"Edit\",\"input\":{\"file_path\":\"a.tsx\"}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"Updated a.tsx with 3 additions\"}]}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"subagent chatter\"}]}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Done: the button\\u001b[0m clears the draft.\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<system-reminder>x</system-reminder>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/model</command-name><command-args>opus</command-args>\"}}\n",
                "{\"type\":\"attachment\",\"attachment\":{\"type\":\"date\"}}\n",
                "not json\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
        assert!(read.available && !read.unchanged && !read.truncated);
        assert_eq!(
            kinds(&read),
            vec![
                ("prompt", "add a clear\nbutton"),
                // The two messages of one turn, each its own bubble, the
                // tool call and its result between them left out, the escape
                // byte dropped.
                ("answer", "Looking at the composer."),
                ("answer", "Done: the button[0m clears the draft."),
                ("prompt", "/model opus"),
            ]
        );
        assert_eq!(read.entries[0].at.as_deref(), Some("2026-09-15T05:49:39.013Z"));

        // The fingerprint the caller hands back is answered without a parse.
        let version = read.version.clone().expect("version");
        let again = read_transcript(&path, TranscriptKind::Claude, Some(&version), DEFAULT_LIMIT).unwrap();
        assert!(again.unchanged && again.entries.is_empty());
        assert_eq!(again.version, Some(version.clone()));
        let stale = read_transcript(&path, TranscriptKind::Claude, Some("0:0"), DEFAULT_LIMIT).unwrap();
        assert!(!stale.unchanged && stale.entries.len() == 4);

        // The limit keeps the newest turns and says that older ones exist.
        let last = read_transcript(&path, TranscriptKind::Claude, None, 2).unwrap();
        assert!(last.truncated);
        assert_eq!(kinds(&last).iter().map(|(k, _)| *k).collect::<Vec<_>>(), vec!["answer", "prompt"]);

        assert!(read_transcript(&dir.path().join("missing.jsonl"), TranscriptKind::Claude, None, 5).is_none());
    }

    #[test]
    fn a_prompt_typed_while_claude_worked_is_a_bubble_in_its_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"fix the build\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Checking.\"}]}}\n",
                // The shapes a census of real sessions found, as written.
                "{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"content\":\"also the tests\"}\n",
                "{\"type\":\"attachment\",\"isSidechain\":false,\"timestamp\":\"2026-09-18T18:51:27.432Z\",\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"also the tests\",\"commandMode\":\"prompt\",\"origin\":{\"kind\":\"human\"}}}\n",
                "{\"type\":\"attachment\",\"isSidechain\":false,\"attachment\":{\"type\":\"queued_command\",\"prompt\":[{\"type\":\"image\",\"source\":{}},{\"type\":\"text\",\"text\":\"and this screenshot\"}],\"commandMode\":\"prompt\",\"origin\":{\"kind\":\"human\"}}}\n",
                "{\"type\":\"attachment\",\"isSidechain\":false,\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"<cross-session-message from=\\\"x\\\">hi</cross-session-message>\",\"commandMode\":\"prompt\",\"origin\":{\"kind\":\"peer\"},\"isMeta\":true}}\n",
                "{\"type\":\"attachment\",\"isSidechain\":false,\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"<task-notification>done</task-notification>\",\"commandMode\":\"task-notification\"}}\n",
                "{\"type\":\"attachment\",\"isSidechain\":true,\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"a note\",\"origin\":{\"kind\":\"coordinator\"}}}\n",
                "{\"type\":\"attachment\",\"attachment\":{\"type\":\"date\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Both fixed.\"}]}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(
            kinds(&read),
            vec![
                ("prompt", "fix the build"),
                ("answer", "Checking."),
                ("prompt", "also the tests"),
                ("prompt", "and this screenshot"),
                ("answer", "Both fixed."),
            ]
        );
        assert_eq!(read.entries[2].at.as_deref(), Some("2026-09-18T18:51:27.432Z"));
    }

    #[test]
    fn a_codex_rollout_reads_its_messages_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"x\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>cwd</environment_context>\"}]}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"add a test\"}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-09-15T06:00:00Z\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"add a test\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{}\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"output\":\"ok\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"done\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Codex, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(kinds(&read), vec![("prompt", "add a test"), ("answer", "done")]);
        assert_eq!(read.entries[0].at.as_deref(), Some("2026-09-15T06:00:00Z"));
        assert_eq!(read.usage, None);
    }

    #[test]
    fn a_codex_goal_reads_as_the_prompt_that_set_it() {
        // Codex 0.153+: `/goal …` writes no user message — the objective is on
        // the event, and each turn it drives opens with Codex's own context.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        let goal = |at: &str, updated: i64, tokens: i64| {
            format!(
                "{{\"timestamp\":\"{at}\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"thread_goal_updated\",\"threadId\":\"t\",\"goal\":{{\"threadId\":\"t\",\"objective\":\" fix the phone chat \",\"status\":\"active\",\"tokensUsed\":{tokens},\"timeUsedSeconds\":0,\"createdAt\":1790789474,\"updatedAt\":{updated}}}}}}}\n"
            )
        };
        let context = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<codex_internal_context source=\\\"goal\\\">\\nContinue working toward the active thread goal.\\n</codex_internal_context>\"}]}}\n";
        let answer = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"On it.\"}]}}\n";
        std::fs::write(
            &path,
            [
                goal("2026-09-30T17:31:14.270Z", 1790789474, 0),
                context.to_string(),
                answer.to_string(),
                context.to_string(),
                // Resumed later, with the tokens it has spent: not a new prompt.
                goal("2026-09-30T19:00:00.000Z", 1790795000, 228822),
                context.to_string(),
            ]
            .concat(),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Codex, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(kinds(&read), vec![("prompt", "/goal fix the phone chat"), ("answer", "On it.")]);
        assert_eq!(read.entries[0].at.as_deref(), Some("2026-09-30T17:31:14.270Z"));
        assert_eq!(
            agent_session::last_prompt_in_transcript(&path, TranscriptKind::Codex).as_deref(),
            Some("/goal fix the phone chat")
        );
    }

    #[test]
    fn a_codex_rollout_carries_its_context_and_limits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":null,\"rate_limits\":{\"primary\":{\"used_percent\":10.0,\"window_minutes\":300,\"resets_at\":1}}}}\n",
                // Codex 0.155's shape, the limits and the counts in one event.
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"total_tokens\":90259},\"model_context_window\":258400},\"rate_limits\":{\"primary\":{\"used_percent\":15.0,\"window_minutes\":300,\"resets_at\":1789856635},\"secondary\":{\"used_percent\":89.4,\"window_minutes\":10080,\"resets_at\":1790243849}}}}\n",
                // A later event without figures does not blank them.
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":null,\"rate_limits\":null}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Codex, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(
            read.usage,
            Some(TranscriptUsage {
                context_left: Some(68),
                session: Some(UsageWindow { used: 15, resets_at: Some(1789856635) }),
                week: Some(UsageWindow { used: 89, resets_at: Some(1790243849) }),
            })
        );
        let wire = serde_json::to_value(&read).unwrap();
        assert_eq!(wire["usage"]["contextLeft"], 68);
        assert_eq!(wire["usage"]["week"]["resetsAt"], 1790243849u64);
    }

    #[test]
    fn a_bubble_holds_what_the_user_typed_and_nothing_the_cli_appended() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<tool_use_error>File has not been read yet</tool_use_error>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"what changed?\"},{\"type\":\"text\",\"text\":\"<total_tokens>128000</total_tokens>\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"ship it\\n<system-reminder>be careful</system-reminder>\"}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(kinds(&read), vec![("prompt", "what changed?"), ("prompt", "ship it")]);
    }

    #[test]
    fn long_text_is_cut_and_marked_and_an_unknown_agent_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let long = "x".repeat(MAX_ANSWER_CHARS + 10);
        std::fs::write(
            &path,
            format!("{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{long}\"}}]}}}}\n{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"more\"}}]}}}}\n"),
        )
        .unwrap();
        let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(read.entries.len(), 2);
        assert!(read.entries[0].cut && !read.entries[1].cut);
        assert_eq!(read.entries[0].text.chars().count(), MAX_ANSWER_CHARS);

        let gemini = agent_session_transcript("gemini", None, None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, None, 5);
        assert!(!gemini.available);
        assert_eq!(gemini.reason.as_deref(), Some("unsupported"));
        // Not even a uuid: refused before any file is looked for.
        assert_eq!(agent_session_transcript("claude", None, None, None, "../x", None, None, 5).reason.as_deref(), Some("no_transcript"));
        assert_eq!(agent_session_transcript("codex", None, None, None, "../x", None, None, 5).reason.as_deref(), Some("no_transcript"));
        // OpenCode is found by the tab's folder; without one there is nothing to look up.
        assert_eq!(agent_session_transcript("opencode", None, None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, None, 5).reason.as_deref(), Some("no_session"));
        assert_eq!(agent_session_transcript("opencode", None, Some("relative/dir"), None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, None, 5).reason.as_deref(), Some("no_session"));
    }

    #[test]
    fn a_claude_subagent_is_an_entry_that_opens_its_own_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s.jsonl");
        std::fs::write(
            &main,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-09-24T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"look around\"}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-09-24T10:00:01Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Sending two scouts.\"},{\"type\":\"tool_use\",\"id\":\"toolu_A\",\"name\":\"Agent\",\"input\":{\"description\":\"Map the\\nbackend\",\"prompt\":\"long task\",\"subagent_type\":\"Explore\"}}]}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-09-24T10:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_B\",\"name\":\"Task\",\"input\":{\"prompt\":\"find the tests\"}}]}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"inline chatter\"}]}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-09-24T10:05:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Both reported.\"}]}}\n",
            ),
        )
        .unwrap();
        let folder = dir.path().join("s").join("subagents");
        let spawns = Spawns::Claude(&folder);

        // Before Claude has written where the subagent lives: an entry, no handle.
        let early = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(
            kinds(&early),
            vec![
                ("prompt", "look around"),
                ("answer", "Sending two scouts."),
                ("agent", "Map the backend"),
                ("agent", "find the tests"),
                ("answer", "Both reported."),
            ]
        );
        assert_eq!(early.entries[2].role.as_deref(), Some("Explore"));
        assert_eq!(early.entries[3].role.as_deref(), Some("general-purpose"));
        assert!(early.entries.iter().all(|e| e.subagent.is_none()));

        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("agent-a1b2.meta.json"), r#"{"agentType":"Explore","description":"Map the backend","toolUseId":"toolu_A"}"#).unwrap();
        std::fs::write(
            folder.join("agent-a1b2.jsonl"),
            concat!(
                "{\"type\":\"user\",\"isSidechain\":true,\"agentId\":\"a1b2\",\"timestamp\":\"2026-09-24T10:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"long task\"}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_C\",\"name\":\"Agent\",\"input\":{\"description\":\"Dig deeper\"}}]}}\n",
                "{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_C\",\"content\":\"x\"}]}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"The backend is in src-tauri.\"}]}}\n",
            ),
        )
        .unwrap();
        let late = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, early.version.as_deref(), DEFAULT_LIMIT).unwrap();
        // The session's file did not move, the folder did: not `unchanged`.
        assert!(!late.unchanged);
        let token = late.entries[2].subagent.clone().expect("handle");
        assert!(is_subagent_token(&token));
        assert_ne!(token, "a1b2");
        assert_eq!(late.entries[3].subagent, None);

        let file = claude_subagent_file(&folder, &token).expect("file");
        let sub = read_transcript_in(&file, TranscriptKind::Claude, &spawns, true, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(
            kinds(&sub),
            vec![("prompt", "long task"), ("agent", "Dig deeper"), ("answer", "The backend is in src-tauri.")]
        );
        assert!(claude_subagent_file(&folder, &subagent_token("elsewhere")).is_none());
    }

    #[test]
    fn only_turns_left_out_that_spawned_a_subagent_promise_earlier_ones() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s.jsonl");
        std::fs::write(
            &main,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-09-24T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"look around\"}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-09-24T10:00:01Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_A\",\"name\":\"Agent\",\"input\":{\"description\":\"Map the backend\"}}]}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-09-24T10:05:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"It reported.\"}]}}\n",
                "{\"type\":\"user\",\"timestamp\":\"2026-09-24T10:06:00Z\",\"message\":{\"role\":\"user\",\"content\":\"thanks\"}}\n",
            ),
        )
        .unwrap();
        let folder = dir.path().join("s").join("subagents");
        let spawns = Spawns::Claude(&folder);

        // Truncated, but no subagent was ever spawned: nothing earlier to find.
        let none = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, 2).unwrap();
        assert!(none.truncated && !none.agents_earlier);

        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("agent-a1b2.meta.json"), r#"{"agentType":"Explore","toolUseId":"toolu_A"}"#).unwrap();
        let cut = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, 2).unwrap();
        assert!(cut.truncated && cut.agents_earlier);
        assert!(serde_json::to_value(&cut).unwrap()["agentsEarlier"].as_bool().unwrap());
        // The subagent is among the turns read: listed, not promised.
        let listed = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, 3).unwrap();
        assert!(listed.truncated && !listed.agents_earlier);
        let whole = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, DEFAULT_LIMIT).unwrap();
        assert!(!whole.truncated && !whole.agents_earlier);
    }

    #[test]
    fn a_background_claude_subagent_runs_until_its_task_notification() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s.jsonl");
        let spawn = |id: &str| format!("{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"{id}\",\"name\":\"Agent\",\"input\":{{\"description\":\"scout {id}\",\"run_in_background\":true}}}}]}}}}\n");
        let launched = |id: &str| format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"{id}\",\"content\":[{{\"type\":\"text\",\"text\":\"Async agent launched successfully.\"}}]}}]}},\"toolUseResult\":{{\"isAsync\":true,\"status\":\"async_launched\",\"agentId\":\"a1\"}}}}\n");
        let note = |id: &str, status: &str| format!("{{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"content\":\"<task-notification>\\n<task-id>a1</task-id>\\n<tool-use-id>{id}</tool-use-id>\\n<status>{status}</status>\\n</task-notification>\"}}\n");
        std::fs::write(&main, [spawn("toolu_A"), launched("toolu_A"), spawn("toolu_B"), launched("toolu_B"), note("toolu_A", "completed")].concat()).unwrap();
        let read = read_transcript_in(&main, TranscriptKind::Claude, &Spawns::None, false, None, DEFAULT_LIMIT).unwrap();
        // The launch result is not the report: B is still at work, A is done.
        assert_eq!(read.entries.iter().map(|e| (e.running, e.finished, e.background)).collect::<Vec<_>>(), vec![(false, true, true), (true, false, true)]);
        let wire = serde_json::to_value(&read).unwrap();
        assert_eq!(wire["entries"][1]["background"], true);

        std::fs::write(&main, [spawn("toolu_A"), launched("toolu_A"), note("toolu_A", "starting")].concat()).unwrap();
        let read = read_transcript_in(&main, TranscriptKind::Claude, &Spawns::None, false, None, DEFAULT_LIMIT).unwrap();
        assert!(read.entries[0].running && !read.entries[0].finished);
    }

    #[test]
    fn a_background_claude_subagent_works_on_past_an_interim_stop_and_after_a_message() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s.jsonl");
        let spawn = "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_A\",\"name\":\"Agent\",\"input\":{\"description\":\"scout\"}}]}}\n";
        let launched = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_A\",\"content\":\"launched\"}]},\"toolUseResult\":{\"isAsync\":true,\"status\":\"async_launched\",\"agentId\":\"a1\"}}\n";
        // Queued, then delivered: the same notification twice.
        let note = |body: &str| {
            let content = format!("<task-notification>\\n<task-id>a1</task-id>\\n{body}<status>completed</status>\\n</task-notification>");
            format!("{{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"content\":\"{content}\"}}\n{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{content}\"}}}}\n")
        };
        let interim = note("<tool-use-id>toolu_A</tool-use-id>\\n<note>the result below may be interim.</note>\\n");
        let done = note("<usage>1</usage>\\n");
        let message = "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_M\",\"name\":\"SendMessage\",\"input\":{\"to\":\"a1\",\"message\":\"more\"}}]}}\n";
        let state = |parts: &[&str]| {
            std::fs::write(&main, parts.concat()).unwrap();
            let read = read_transcript_in(&main, TranscriptKind::Claude, &Spawns::None, false, None, DEFAULT_LIMIT).unwrap();
            (read.entries[0].running, read.entries[0].finished)
        };
        // An interim stop leaves it at work; the later stop, naming only the
        // agent, ends it.
        assert_eq!(state(&[spawn, launched, &interim]), (true, false));
        assert_eq!(state(&[spawn, launched, &interim, &done]), (false, true));
        // A message resumes it until it stops again — a stop that names the
        // message's call, not the spawn.
        assert_eq!(state(&[spawn, launched, &done, message]), (true, false));
        let again = note("<tool-use-id>toolu_M</tool-use-id>\\n<usage>2</usage>\\n");
        assert_eq!(state(&[spawn, launched, &done, message, &again]), (false, true));
        // Its hand-back, queued then delivered, ends an interim stop; a copy
        // delivered after a resume does not end it again.
        let handback = "{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"content\":\"<agent-message from=\\\"a1\\\">\\n[Subagent hand-back] The text below is the final report.\\n</agent-message>\"}\n";
        let delivered = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Another Claude session sent a message:\\n<agent-message from=\\\"a1\\\">\\n[Subagent hand-back] The text below is the final report.\\n</agent-message>\"}}\n";
        assert_eq!(state(&[spawn, launched, &interim, handback]), (false, true));
        assert_eq!(state(&[spawn, launched, &interim, handback, message, delivered]), (true, false));
        // A message from it that is not its report leaves it at work.
        let chat = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<agent-message from=\\\"a1\\\">\\nstill going\\n</agent-message>\"}}\n";
        assert_eq!(state(&[spawn, launched, &interim, chat]), (true, false));
    }

    #[test]
    fn subagents_at_work_are_counted_past_the_limit_and_a_dead_turns_spawn_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s.jsonl");
        let prompt = |text: &str| format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{text}\"}}}}\n");
        let spawn = |id: &str, background: bool| format!("{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"{id}\",\"name\":\"Agent\",\"input\":{{\"description\":\"scout {id}\",\"run_in_background\":{background}}}}}]}}}}\n");
        let launched = |id: &str| format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"{id}\",\"content\":\"launched\"}}]}},\"toolUseResult\":{{\"isAsync\":true,\"status\":\"async_launched\",\"agentId\":\"a1\"}}}}\n");
        let answer = "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}\n".to_string();
        let read = |parts: &[String], limit: usize| {
            std::fs::write(&main, parts.concat()).unwrap();
            read_transcript_in(&main, TranscriptKind::Claude, &Spawns::None, false, None, limit).unwrap()
        };
        // Two foreground spawns of this turn and a background one: three at work.
        let busy = read(&[prompt("go"), spawn("toolu_B", true), launched("toolu_B"), spawn("toolu_F", false), spawn("toolu_G", false)], DEFAULT_LIMIT);
        assert_eq!(busy.running_agents, 3);
        assert_eq!(serde_json::to_value(&busy).unwrap()["runningAgents"], 3);
        // The background one still counts once the limit cuts it off.
        let cut = read(&[prompt("go"), spawn("toolu_B", true), launched("toolu_B"), prompt("next"), answer.clone()], 1);
        assert!(cut.entries.iter().all(|e| e.kind != "agent"));
        assert_eq!(cut.running_agents, 1);
        // A foreground spawn whose CLI died before its result is not at work
        // once a new prompt has started a turn — nor said to have finished.
        let dead = read(&[prompt("go"), spawn("toolu_F", false), prompt("again"), answer.clone()], DEFAULT_LIMIT);
        assert_eq!(dead.running_agents, 0);
        assert!(!dead.entries[1].running && !dead.entries[1].finished);
        assert!(serde_json::to_value(&dead).unwrap().get("runningAgents").is_none());
    }

    #[test]
    fn a_claude_subagent_runs_until_its_call_has_a_result_and_names_its_model() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s.jsonl");
        let spawn = |id: &str| format!("{{\"type\":\"assistant\",\"message\":{{\"model\":\"claude-opus-4-1-20250805\",\"role\":\"assistant\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"{id}\",\"name\":\"Agent\",\"input\":{{\"description\":\"scout {id}\"}}}}]}}}}\n");
        let result = |id: &str| format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"{id}\",\"content\":\"done\"}}]}}}}\n");
        std::fs::write(&main, [spawn("toolu_A"), spawn("toolu_B"), result("toolu_A")].concat()).unwrap();
        let read = read_transcript_in(&main, TranscriptKind::Claude, &Spawns::None, false, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(read.entries.iter().map(|e| e.running).collect::<Vec<_>>(), vec![false, true]);
        assert_eq!(read.model.as_deref(), Some("claude-opus-4-1-20250805"));
        let wire = serde_json::to_value(&read).unwrap();
        assert_eq!(wire["entries"][1]["running"], true);
        assert!(wire["entries"][0].get("running").is_none());
        assert_eq!(wire["entries"][0]["finished"], true);
        assert!(wire["entries"][1].get("finished").is_none());

        // A subagent's own file names the model it ran on; Claude's own
        // `<synthetic>` notes are not one.
        let sub = dir.path().join("agent-x.jsonl");
        std::fs::write(
            &sub,
            concat!(
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"looking\"}]}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"model\":\"<synthetic>\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"note\"}]}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript_in(&sub, TranscriptKind::Claude, &Spawns::None, true, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(read.model.as_deref(), Some("claude-haiku-4-5-20251001"));
        assert_eq!(read.tokens, None);
    }

    #[test]
    fn a_transcript_counts_the_tokens_of_its_newest_request() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("agent-x.jsonl");
        std::fs::write(
            &sub,
            concat!(
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":100,\"cache_read_input_tokens\":0,\"output_tokens\":5},\"content\":[{\"type\":\"text\",\"text\":\"looking\"}]}}\n",
                "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":300,\"cache_read_input_tokens\":12000,\"output_tokens\":40},\"content\":[{\"type\":\"text\",\"text\":\"found\"}]}}\n",
                // A tool result carries no usage of its own.
                "{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t\",\"content\":\"usage\"}]}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript_in(&sub, TranscriptKind::Claude, &Spawns::None, true, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(read.tokens, Some(12_342));
        assert_eq!(serde_json::to_value(&read).unwrap()["tokens"], 12_342);

        let rollout = dir.path().join("rollout.jsonl");
        std::fs::write(
            &rollout,
            concat!(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"total_tokens\":800}}}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"total_tokens\":90259}}}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":null}}\n",
            ),
        )
        .unwrap();
        let read = read_transcript_in(&rollout, TranscriptKind::Codex, &Spawns::None, false, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(read.tokens, Some(90_259));
    }

    #[test]
    fn a_claude_shell_runs_until_its_call_has_a_result_since_the_last_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s.jsonl");
        let prompt = |text: &str| format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{text}\"}}}}\n");
        let bash = |id: &str, command: &str| format!("{{\"type\":\"assistant\",\"timestamp\":\"2026-10-01T10:00:00Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"{id}\",\"name\":\"Bash\",\"input\":{{\"command\":\"{command}\",\"description\":\"Run  the\\ntests\"}}}}]}}}}\n");
        let result = |id: &str| format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"{id}\",\"content\":\"ok\"}}]}}}}\n");
        std::fs::write(
            &main,
            [
                prompt("first"),
                // Killed mid-call: never answered, and a new prompt came since.
                bash("toolu_dead", "sleep 999"),
                prompt("second"),
                bash("toolu_done", "ls"),
                result("toolu_done"),
                bash("toolu_live", "npm test -- --reporter=dot"),
            ]
            .concat(),
        )
        .unwrap();
        let read = read_transcript_in(&main, TranscriptKind::Claude, &Spawns::None, false, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(read.shells.len(), 1);
        let shell = &read.shells[0];
        assert_eq!(shell.command, "npm test -- --reporter=dot");
        assert_eq!(shell.description.as_deref(), Some("Run the tests"));
        assert_eq!(shell.at.as_deref(), Some("2026-10-01T10:00:00Z"));
        assert!(!shell.cut);
        // A shell call is no bubble of the conversation.
        assert_eq!(kinds(&read), vec![("prompt", "first"), ("prompt", "second")]);
        let wire = serde_json::to_value(&read).unwrap();
        assert_eq!(wire["shells"][0]["command"], "npm test -- --reporter=dot");

        assert!(wire["shells"][0].get("background").is_none());

        std::fs::write(&main, [prompt("first"), bash("toolu_live", "ls"), result("toolu_live")].concat()).unwrap();
        let read = read_transcript_in(&main, TranscriptKind::Claude, &Spawns::None, false, None, DEFAULT_LIMIT).unwrap();
        assert!(read.shells.is_empty());
        assert!(serde_json::to_value(&read).unwrap().get("shells").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_claude_background_shell_runs_while_its_output_is_held_open_and_no_notification_ended_it() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s.jsonl");
        let output = dir.path().join("tasks").join("b1.output");
        std::fs::create_dir_all(output.parent().unwrap()).unwrap();
        let output_text = output.to_str().unwrap().to_string();
        let lines = |extra: &str| {
            [
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"run the server\"}}\n".to_string(),
                "{\"type\":\"assistant\",\"timestamp\":\"2026-10-01T10:00:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_bg\",\"name\":\"Bash\",\"input\":{\"command\":\"npm run dev\",\"run_in_background\":true}}]}}\n".to_string(),
                format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_bg\",\"content\":\"Command running in background with ID: b1. Output is being written to: {output_text}. You will be notified when it completes.\"}}]}},\"toolUseResult\":{{\"backgroundTaskId\":\"b1\"}}}}\n"),
                // A later prompt does not end a background shell.
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"and now?\"}}\n".to_string(),
                extra.to_string(),
            ]
            .concat()
        };
        let read = |version: Option<&str>| read_transcript_in(&main, TranscriptKind::Claude, &Spawns::None, false, version, DEFAULT_LIMIT).unwrap();
        std::fs::write(&main, lines("")).unwrap();

        // Nobody holds the output open: its CLI quit and took the shell along.
        assert!(read(None).shells.is_empty());

        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .stdout(std::fs::File::create(&output).unwrap())
            .spawn()
            .unwrap();
        let running = read(None);
        assert_eq!(running.shells.len(), 1);
        assert_eq!(running.shells[0].command, "npm run dev");
        assert!(running.shells[0].background);
        assert!(read(running.version.as_deref()).unchanged);

        // A notification ends it, held open or not.
        let note = "{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"content\":\"<task-notification>\\n<task-id>b1</task-id>\\n<tool-use-id>toolu_bg</tool-use-id>\\n<status>killed</status>\\n</task-notification>\"}\n";
        std::fs::write(&main, lines(note)).unwrap();
        assert!(read(None).shells.is_empty());

        // The shell exits without one: an unchanged file is read again.
        std::fs::write(&main, lines("")).unwrap();
        let running = read(None);
        assert_eq!(running.shells.len(), 1);
        child.kill().unwrap();
        child.wait().unwrap();
        let gone = read(running.version.as_deref());
        assert!(!gone.unchanged);
        assert!(gone.shells.is_empty());
    }

    #[test]
    fn a_codex_subagent_is_placed_when_its_thread_was_created() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state_5.sqlite");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
               title TEXT NOT NULL, first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT,
               agent_role TEXT, created_at_ms INTEGER);
             CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
             INSERT INTO threads VALUES ('child', '/r/child.jsonl', 1789000030, 't', 'Check the\nlockfile', 'Kepler', 'explorer', 1789680030000);
             INSERT INTO threads VALUES ('grandchild', '/r/g.jsonl', 1789000040, 'Deeper', '', NULL, NULL, NULL);
             INSERT INTO threads VALUES ('stranger', '/r/s.jsonl', 1789000050, 'x', 'not ours', NULL, NULL, 1789000050000);
             INSERT INTO thread_spawn_edges VALUES ('root', 'child', 'running');
             INSERT INTO thread_spawn_edges VALUES ('child', 'grandchild', 'completed');
             INSERT INTO thread_spawn_edges VALUES ('other', 'stranger', 'running');",
        )
        .unwrap();
        drop(conn);
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"response_item\",\"timestamp\":\"2026-09-15T00:00:00Z\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"audit deps\"}]}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-09-17T21:20:40Z\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Asked Kepler.\"}]}}\n",
            ),
        )
        .unwrap();
        let stores = [db.clone()];
        let read = read_transcript_in(&path, TranscriptKind::Codex, &Spawns::Codex { stores: &stores, thread: "root" }, false, None, DEFAULT_LIMIT).unwrap();
        // 1789680030000 ms is 2026-09-17T21:20:30Z: after the prompt, before the answer.
        assert_eq!(kinds(&read), vec![("prompt", "audit deps"), ("agent", "Check the lockfile"), ("answer", "Asked Kepler.")]);
        assert_eq!(read.entries[1].role.as_deref(), Some("explorer · Kepler"));
        assert_eq!(read.entries[1].subagent, Some(subagent_token("child")));

        let tree: Vec<String> = crate::services::codex_store::descendant_threads(&db, "root", MAX_SUBAGENT_DEPTH)
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(tree.len(), 2);
        assert!(tree.contains(&"child".to_string()) && tree.contains(&"grandchild".to_string()));
        assert_eq!(crate::services::codex_store::descendant_threads(&db, "root", 1).len(), 1);
        // A store without the edge table is one with no subagents.
        let bare = dir.path().join("bare.sqlite");
        rusqlite::Connection::open(&bare).unwrap().execute_batch("CREATE TABLE threads (id TEXT)").unwrap();
        assert!(crate::services::codex_store::spawned_threads(&bare, "root").is_empty());
    }

    #[test]
    fn a_codex_subagent_rollout_named_as_the_fence_sees_it_is_found() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("agent-homes/p1/.codex/sessions");
        let day = root.join("2026/10/01");
        std::fs::create_dir_all(&day).unwrap();
        let id = "01a0f8c9-becb-7461-8d94-0f88165a3b65";
        let file = day.join(format!("rollout-2026-10-01T20-46-06-{id}.jsonl"));
        std::fs::write(&file, "").unwrap();
        let thread = |rollout: &str, id: &str| crate::services::codex_store::SpawnedThread {
            id: id.into(),
            task: String::new(),
            role: None,
            nickname: Some("Lorentz".into()),
            created_ms: None,
            rollout_path: Some(rollout.into()),
        };
        let fenced = format!("/home/u/.codex/sessions/2026/10/01/rollout-2026-10-01T20-46-06-{id}.jsonl");
        let found = codex_rollout_in(&root, &thread(&fenced, id));
        assert_eq!(found, Some(std::fs::canonicalize(&file).unwrap()));
        // The path as Tabtivity itself sees it still works.
        assert!(codex_rollout_in(&root, &thread(file.to_str().unwrap(), id)).is_some());
        // Never a file of another thread, nor one outside the root.
        assert!(codex_rollout_in(&root, &thread(&fenced, "01a0f8c9-0000-7461-8d94-0f88165a3b65")).is_none());
        let outside = dir.path().join(format!("rollout-x-{id}.jsonl"));
        std::fs::write(&outside, "").unwrap();
        assert!(codex_rollout_in(&root, &thread(outside.to_str().unwrap(), id)).is_none());
        let escape = format!("/home/u/.codex/sessions/../../../rollout-x-{id}.jsonl");
        assert!(codex_rollout_in(&root, &thread(&escape, id)).is_none());
    }

    #[test]
    fn a_placed_entry_older_than_the_tail_is_left_out() {
        let at = |s: &str| TranscriptEntry { kind: "answer".into(), text: s.into(), at: Some(s.into()), ..Default::default() };
        let agent = |s: &str| TranscriptEntry { kind: "agent".into(), text: s.into(), at: Some(s.into()), ..Default::default() };
        let mut entries = vec![at("2026-09-24T10:00:00Z"), at("2026-09-24T12:00:00Z")];
        let placed = vec![agent("2026-09-24T09:00:00Z"), agent("2026-09-24T11:00:00Z"), agent("2026-09-24T13:00:00Z")];
        insert_by_time(&mut entries, placed.clone(), true);
        assert_eq!(
            entries.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect::<Vec<_>>(),
            vec![
                ("answer", "2026-09-24T10:00:00Z"),
                ("agent", "2026-09-24T11:00:00Z"),
                ("answer", "2026-09-24T12:00:00Z"),
                ("agent", "2026-09-24T13:00:00Z"),
            ]
        );
        let mut whole = vec![at("2026-09-24T10:00:00Z")];
        insert_by_time(&mut whole, placed, false);
        assert_eq!(whole[0].text, "2026-09-24T09:00:00Z");
    }

    #[test]
    fn a_handle_that_is_not_one_is_refused_before_anything_is_read() {
        assert!(is_subagent_token(&subagent_token("a1b2")));
        // Built, not literal: a random-looking hex string trips secret scanners.
        let upper = "abcd".repeat(4).to_ascii_uppercase(); // right length, wrong case
        let long = "a".repeat(17); // right alphabet, one digit too many
        assert!(is_subagent_token(&"abcd".repeat(4)) && is_subagent_token(&long[1..]));
        for bad in ["", "../../etc/passwd", upper.as_str(), long.as_str(), "a1b2"] {
            assert!(!is_subagent_token(bad), "{bad}");
            let read = agent_session_transcript("claude", None, None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", Some(bad), None, 5);
            assert_eq!(read.reason.as_deref(), Some("no_subagent"));
        }
        // A well-formed handle on a tab with no session is no subagent — never
        // the fresh, empty chat the session itself would be.
        let read = agent_session_transcript("claude", None, None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", Some(&subagent_token("x")), None, 5);
        assert_eq!(read.reason.as_deref(), Some("no_subagent"));
    }
}
