//! The stored conversations of an agent tab's folder — the Reader's Resume menu
//! (the prompt strip, beside Diffs): every earlier chat its CLI keeps for the
//! folder the tab runs in, newest first, each named by its first prompt, to
//! read in the Reader and resume in the tab.
//!
//! Claude and Codex, the two CLIs whose conversations Tabtivity finds by id and
//! resumes by id. Claude files a folder's sessions as
//! `<scope home>/.claude/projects/<folder slug>/<uuid>.jsonl` — the folder is
//! the one the tab's current conversation lies in, else the slug of the tab's
//! folder. Codex keeps every rollout under `.codex/sessions/<y>/<m>/<d>/`, each
//! opening with a `session_meta` record naming its `cwd` and its `source`: only
//! the rollouts of this folder started from the CLI count, never a subagent's
//! thread or a guardian review (`source` an object) or a `codex exec` run.
//!
//! Only what the agent wrote is read, through `home_io`-style regular-file
//! checks; a listed id is what a resume or a read takes, and both look it up
//! again here ([`chat_file`]), so a renderer-supplied id never names a file
//! outside the folder's own chats.
//!
//! AppHandle-free.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::services::agent_session::{self, TranscriptKind};

/// Chats one page answers.
pub const PAGE: usize = 30;
const MAX_PAGE: usize = 60;
/// Files one page reads at most: a folder full of sessions no prompt went
/// into (or another folder's rollouts) must not make one page read them all.
const MAX_SCANNED: usize = 200;
/// How long a chat's name and last prompt may be: a menu row.
const MAX_ROW_CHARS: usize = 240;
/// How much of a rollout's first line is read for its `session_meta`.
const META_BYTES: u64 = 256 * 1024;

/// One earlier conversation of the folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredChat {
    /// The CLI's own session id: what a read and a resume of it take.
    pub id: String,
    /// Its first prompt, cut to a row.
    pub title: String,
    /// Its last prompt, when that is not its first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<String>,
    /// When it started (the first prompt's ISO stamp), when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<String>,
    /// When it was last written (epoch ms).
    pub updated: u64,
    /// The conversation the tab is in now.
    pub current: bool,
}

/// A page of the folder's chats.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatList {
    /// Whether this CLI's chats are listed at all.
    pub supported: bool,
    pub chats: Vec<StoredChat>,
    /// Where the next page starts, while older files are left.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<usize>,
}

/// A session file of the folder, before it is read.
struct Candidate {
    path: PathBuf,
    /// Claude's file name says the id; a rollout's is read from its record.
    id: Option<String>,
    updated: u64,
}

/// The chats of the folder `tab_dir` the tab launched as `cmd` with launch id
/// `launch_id` runs in: the page starting at the `offset`-th session file,
/// newest first, of at most `limit` chats any prompt went into.
pub fn list_chats(
    cmd: &str,
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    launch_id: &str,
    offset: usize,
    limit: usize,
) -> ChatList {
    let Some(kind) = kind_of(cmd) else {
        return ChatList::default();
    };
    let limit = limit.clamp(1, MAX_PAGE);
    let dir = tab_dir.map(normal_dir);
    let current = current_chat(cmd, project_id, launch_id);
    let candidates = candidates(cmd, project_id, dir.as_deref(), launch_id);
    let mut chats = Vec::new();
    let mut at = offset;
    while at < candidates.len() && chats.len() < limit && at - offset < MAX_SCANNED {
        let candidate = &candidates[at];
        at += 1;
        let id = match kind {
            TranscriptKind::Claude => candidate.id.clone(),
            TranscriptKind::Codex => dir.as_deref().and_then(|dir| rollout_chat(&candidate.path, dir)),
        };
        let Some(id) = id else { continue };
        let (first, last) = agent_session::chat_prompts(&candidate.path, kind);
        let Some(first) = first else { continue };
        let title = row_text(&first.text);
        chats.push(StoredChat {
            current: current.as_deref() == Some(id.as_str()),
            id,
            last: last.map(|text| row_text(&text)).filter(|text| *text != title),
            title,
            started: (!first.at.is_empty()).then_some(first.at),
            updated: candidate.updated,
        });
    }
    ChatList { supported: true, chats, next: (at < candidates.len()).then_some(at) }
}

/// The file of the folder's chat `chat`, when it is one [`list_chats`] would
/// list (by id and folder; a session no prompt went into included).
pub fn chat_file(
    cmd: &str,
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    launch_id: &str,
    chat: &str,
) -> Option<PathBuf> {
    if !agent_session::is_uuid_shaped(chat) {
        return None;
    }
    let dir = tab_dir.map(normal_dir);
    match kind_of(cmd)? {
        TranscriptKind::Claude => claude_folders(project_id, dir.as_deref(), launch_id)
            .iter()
            .find_map(|folder| agent_session::claude_chat_log(folder, chat)),
        TranscriptKind::Codex => {
            let path = agent_session::codex_session_log(&agent_session::codex_sessions_root(project_id), chat)?;
            let regular = std::fs::symlink_metadata(&path).ok()?.is_file();
            (regular && rollout_chat(&path, dir.as_deref()?).as_deref() == Some(chat)).then_some(path)
        }
    }
}

fn kind_of(cmd: &str) -> Option<TranscriptKind> {
    match cmd {
        "claude" => Some(TranscriptKind::Claude),
        "codex" => Some(TranscriptKind::Codex),
        _ => None,
    }
}

/// The conversation the tab is in now: the id its hook recorded, else (Claude,
/// before any) its launch id.
fn current_chat(cmd: &str, project_id: Option<&str>, launch_id: &str) -> Option<String> {
    agent_session::read_live_session_for(project_id, launch_id)
        .or_else(|| (cmd == "claude" && agent_session::is_uuid_shaped(launch_id)).then(|| launch_id.to_string()))
}

/// A folder path as the CLIs record it: no trailing separator.
fn normal_dir(dir: &str) -> String {
    let trimmed = dir.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() { dir.to_string() } else { trimmed.to_string() }
}

/// The folder's session files, newest first.
fn candidates(cmd: &str, project_id: Option<&str>, dir: Option<&str>, launch_id: &str) -> Vec<Candidate> {
    let mut found = match cmd {
        "claude" => claude_folders(project_id, dir, launch_id)
            .iter()
            .flat_map(|folder| claude_candidates(folder))
            .collect(),
        _ if dir.is_some() => {
            let mut out = Vec::new();
            rollouts_in(&agent_session::codex_sessions_root(project_id), 0, &mut out);
            out
        }
        _ => Vec::new(),
    };
    found.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| b.path.cmp(&a.path)));
    found
}

/// Where a scope's Claude files this folder's sessions: the folder the tab's
/// current conversation lies in, and the folder's slug under each root.
fn claude_folders(project_id: Option<&str>, dir: Option<&str>, launch_id: &str) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = Vec::new();
    let current = agent_session::read_agent_transcript_from(
        "claude",
        project_id,
        launch_id,
        true,
        |path, _| path.parent().map(Path::to_path_buf),
        |_, _| None,
    );
    folders.extend(current);
    if let Some(dir) = dir.filter(|dir| Path::new(dir).is_absolute()) {
        let slug = crate::services::agent_history::claude_folder_name(dir);
        for root in agent_session::claude_projects_roots(project_id) {
            let folder = root.join(&slug);
            if !folders.contains(&folder) && folder.is_dir() {
                folders.push(folder);
            }
        }
    }
    folders
}

fn claude_candidates(folder: &Path) -> Vec<Candidate> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let id = name.to_str()?.strip_suffix(".jsonl")?;
            if !agent_session::is_uuid_shaped(id) {
                return None;
            }
            // `DirEntry::metadata` does not follow a link: a link is no chat.
            let meta = entry.metadata().ok().filter(|meta| meta.is_file())?;
            Some(Candidate { path: entry.path(), id: Some(id.to_string()), updated: modified_ms(&meta) })
        })
        .collect()
}

/// Every `rollout-*.jsonl` under Codex's dated folders.
fn rollouts_in(dir: &Path, depth: u8, out: &mut Vec<Candidate>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() && depth < 3 {
            rollouts_in(&entry.path(), depth + 1, out);
        } else if meta.is_file() && depth == 3 {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                out.push(Candidate { path: entry.path(), id: None, updated: modified_ms(&meta) });
            }
        }
    }
}

/// The thread id of the rollout at `path` when it is a conversation the CLI
/// started in `dir` (see the module header for what counts).
fn rollout_chat(path: &Path, dir: &str) -> Option<String> {
    use std::io::{BufRead, Read};
    let file = crate::services::home_io::open_regular(path)?;
    let mut line = Vec::new();
    std::io::BufReader::new(file.take(META_BYTES)).read_until(b'\n', &mut line).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&line).ok()?;
    if value.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = value.get("payload")?;
    let source = payload.get("source")?.as_str()?;
    if source == "exec" || payload.get("cwd")?.as_str().map(normal_dir).as_deref() != Some(dir) {
        return None;
    }
    let id = payload.get("id")?.as_str()?;
    let named = path.file_name()?.to_str()?.ends_with(&format!("-{id}.jsonl"));
    (named && agent_session::is_uuid_shaped(id)).then(|| id.to_string())
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|at| at.as_millis() as u64)
        .unwrap_or(0)
}

/// A prompt as a menu row: one line, cut with an ellipsis.
fn row_text(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= MAX_ROW_CHARS {
        return line;
    }
    let mut cut: String = line.chars().take(MAX_ROW_CHARS).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn claude_prompt(text: &str, at: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({ "type": "user", "message": { "role": "user", "content": text }, "timestamp": at })
        )
    }

    #[test]
    fn a_claude_folder_lists_its_prompted_sessions_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("chats");
        let old = "11111111-1111-4111-8111-111111111111";
        let new = "22222222-2222-4222-8222-222222222222";
        let blank = "33333333-3333-4333-8333-333333333333";
        write(
            &folder.join(format!("{old}.jsonl")),
            &format!(
                "{}{}",
                claude_prompt("fix   the\nbuild", "2026-10-01T10:00:00Z"),
                claude_prompt("and the tests", "2026-10-01T10:05:00Z")
            ),
        );
        write(&folder.join(format!("{blank}.jsonl")), "{\"type\":\"mode\"}\n");
        write(&folder.join(format!("{new}.jsonl")), &claude_prompt("add a menu", "2026-10-02T09:00:00Z"));
        write(&folder.join("notes.jsonl"), &claude_prompt("not a session", "2026-10-02T09:00:00Z"));
        let stamp = |path: &Path, secs: u64| {
            let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
            std::fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
        };
        stamp(&folder.join(format!("{old}.jsonl")), 1_000);
        stamp(&folder.join(format!("{new}.jsonl")), 2_000);
        stamp(&folder.join(format!("{blank}.jsonl")), 3_000);

        let mut candidates = claude_candidates(&folder);
        candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.updated));
        let ids: Vec<_> = candidates.iter().map(|c| c.id.clone().unwrap()).collect();
        assert_eq!(ids, vec![blank, new, old]);

        let (first, last) = agent_session::chat_prompts(&folder.join(format!("{old}.jsonl")), TranscriptKind::Claude);
        let first = first.unwrap();
        assert_eq!(row_text(&first.text), "fix the build");
        assert_eq!(first.at, "2026-10-01T10:00:00Z");
        assert_eq!(last.as_deref(), Some("and the tests"));
        assert_eq!(agent_session::chat_prompts(&folder.join(format!("{blank}.jsonl")), TranscriptKind::Claude).0, None);
    }

    #[test]
    fn only_a_rollout_the_cli_started_in_the_folder_is_a_chat() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = if cfg!(windows) { r"C:\work\app" } else { "/work/app" };
        let id = "01a158d2-abb8-7990-874f-f4924f508082";
        let meta = |source: serde_json::Value, cwd: &str| {
            format!(
                "{}\n",
                serde_json::json!({ "type": "session_meta", "payload": { "id": id, "cwd": cwd, "source": source } })
            )
        };
        let path = tmp.path().join(format!("rollout-2026-10-20T12-19-23-{id}.jsonl"));
        write(&path, &meta(serde_json::json!("cli"), &format!("{dir}/")));
        assert_eq!(rollout_chat(&path, dir).as_deref(), Some(id));
        write(&path, &meta(serde_json::json!({ "subagent": { "other": "guardian" } }), dir));
        assert_eq!(rollout_chat(&path, dir), None);
        write(&path, &meta(serde_json::json!("exec"), dir));
        assert_eq!(rollout_chat(&path, dir), None);
        write(&path, &meta(serde_json::json!("cli"), &format!("{dir}-other")));
        assert_eq!(rollout_chat(&path, dir), None);
        let renamed = tmp.path().join("rollout-2026-10-20T12-19-23-x.jsonl");
        write(&renamed, &meta(serde_json::json!("cli"), dir));
        assert_eq!(rollout_chat(&renamed, dir), None);
    }

    #[test]
    fn rollouts_are_found_only_at_their_dated_depth() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("2026").join("10").join("20").join("rollout-a.jsonl"), "");
        write(&tmp.path().join("rollout-b.jsonl"), "");
        write(&tmp.path().join("2026").join("10").join("20").join("other.jsonl"), "");
        let mut out = Vec::new();
        rollouts_in(tmp.path(), 0, &mut out);
        let names: Vec<_> = out.iter().map(|c| c.path.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["rollout-a.jsonl"]);
    }

    #[test]
    fn a_long_prompt_is_cut_to_a_row() {
        let long = "word ".repeat(100);
        let row = row_text(&long);
        assert_eq!(row.chars().count(), MAX_ROW_CHARS + 1);
        assert!(row.ends_with('…'));
        assert_eq!(normal_dir("/a/b/"), "/a/b");
        assert_eq!(normal_dir("/"), "/");
    }
}
