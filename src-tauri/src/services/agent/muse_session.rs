//! Meta Muse Code's stored sessions: the Reader's Chat view, the Resume menu
//! and a restored tab's resume. Read from 1.4.15's store, outside the app,
//! with the offline `--provider echo` (docs/third_party_update_checklist.md).
//!
//! Muse chooses its session ids (UUIDv7, so they sort by start time) and
//! files each as `~/.local/share/muse/sessions/<y>/<m>/<d>/<id>/session.jsonl`
//! in the tab's agent home, an append-only log of records. A resume appends to
//! the same file. What is read: the `metadata` record's `workspace_root`
//! (the folder the session began in: Muse's `resume --last` looks for that
//! exact folder, not the git root), a top-level `run` whose event `started`
//! with a `prompt` (the user's turn) and `assistant_message_committed` text
//! (an answer). Tool calls, reasoning and the memory-reminder children in
//! `<id>/subagent/` never become chat.
//!
//! Like Antigravity, Muse has no session hook. A tab reads the folder's newest
//! session begun since it launched (any, once restored); the Resume menu
//! records the one it takes a tab onto in the tab's live-session record, and
//! [`resolve`] relaunches onto it with `resume <id>` until the tab begins
//! another. `resume --last` in a folder with no session exits ("no retained
//! sessions found for this workspace"), so [`resolve`] starts such a tab fresh.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde_json::Value;

use crate::services::agent_chats::FolderChat;
use crate::services::agent_session::is_uuid_shaped;
use crate::services::agent_transcript::{AgentTranscript, prompt_cut_off, transcript_entry};
use crate::services::home_io::{HomeDir, HomeFile};
use crate::terminal::PtyOptions;

/// Where the store sits in an agent home (no `XDG_DATA_HOME` in a tab).
const STORE: &str = ".local/share/muse/sessions";
/// Sessions looked at, newest first: a folder's own are found among these.
const MAX_SESSIONS: usize = 512;
/// The largest log read whole; a bigger one is not read at all.
const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// How much of a log's head is read for its folder.
const HEAD_BYTES: u64 = 256 * 1024;

/// One session of the store, before its log is read.
struct Session {
    id: String,
    dir: HomeDir,
}

impl Session {
    fn log(&self) -> Option<HomeFile> {
        self.dir.file("session.jsonl")
    }
}

/// How the walk of the store is bounded: the agent writes the store, so it
/// can fill it with any number of entries and empty folders.
#[derive(Clone, Copy)]
struct Walk {
    /// Sessions returned at most.
    sessions: usize,
    /// Entries read from one folder at most (directory order, then sorted).
    entries: usize,
    /// Folders listed in the whole walk at most.
    listings: usize,
}

/// A store of years of daily use stays far inside every bound: a day holds
/// a few sessions, and a year's walk lists about 400 folders.
const WALK: Walk = Walk { sessions: MAX_SESSIONS, entries: 4096, listings: 4096 };

/// The store's sessions, newest first.
fn sessions(home: &Path) -> Vec<Session> {
    sessions_within(home, WALK)
}

/// [`sessions`] within `walk`. A folder with more than `walk.entries` names
/// is read only that far, so a flooded one may hide some of its sessions;
/// a normal store is read whole and newest first.
fn sessions_within(home: &Path, walk: Walk) -> Vec<Session> {
    let Some(root) = HomeDir::open_existing(home, STORE) else { return Vec::new() };
    let mut out = Vec::new();
    let mut listings = walk.listings;
    let mut list = |dir: &HomeDir| -> Option<Vec<String>> {
        listings = listings.checked_sub(1)?;
        Some(dir.names_capped(walk.entries))
    };
    let numeric = |name: &String, len: usize| name.len() == len && name.chars().all(|c| c.is_ascii_digit());
    let Some(years) = list(&root) else { return out };
    'walk: for year in years.into_iter().rev().filter(|n| numeric(n, 4)) {
        let Some(year_dir) = root.open_subdir(&year) else { continue };
        let Some(months) = list(&year_dir) else { break };
        for month in months.into_iter().rev().filter(|n| numeric(n, 2)) {
            let Some(month_dir) = year_dir.open_subdir(&month) else { continue };
            let Some(days) = list(&month_dir) else { break 'walk };
            for day in days.into_iter().rev().filter(|n| numeric(n, 2)) {
                let Some(day_dir) = month_dir.open_subdir(&day) else { continue };
                let Some(ids) = list(&day_dir) else { break 'walk };
                for id in ids.into_iter().rev().filter(|n| is_uuid_shaped(n)) {
                    let Some(dir) = day_dir.open_subdir(&id) else { continue };
                    out.push(Session { id, dir });
                    if out.len() == walk.sessions { break 'walk; }
                }
            }
        }
    }
    out
}

/// When the session began (epoch ms): a UUIDv7's leading 48 bits.
fn started_ms(id: &str) -> Option<i64> {
    let hex: String = id.chars().filter(|c| *c != '-').take(12).collect();
    i64::from_str_radix(&hex, 16).ok()
}

fn bounded(file: &HomeFile, cap: u64) -> Option<String> {
    let file = file.open_read()?;
    if file.metadata().ok()?.len() > cap { return None; }
    let mut text = String::new();
    file.take(cap + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= cap).then_some(text)
}

/// The folder a session began in: its `metadata` record's `workspace_root`.
fn workspace_of(session: &Session) -> Option<String> {
    let file = session.log()?.open_read()?;
    let mut reader = BufReader::new(file.take(HEAD_BYTES));
    let mut line = String::new();
    while reader.read_line(&mut line).ok()? > 0 {
        if line.contains("\"workspace_root\"") {
            let value: Value = serde_json::from_str(&line).ok()?;
            let payload = value.get("payload")?;
            if payload.get("kind").and_then(Value::as_str) == Some("metadata") {
                return payload.get("record")?.get("workspace_root")?.as_str().map(str::to_string);
            }
        }
        line.clear();
    }
    None
}

/// The folder's sessions (the store's newest [`MAX_SESSIONS`]), newest first.
fn folder_sessions(home: &Path, directory: &str) -> Vec<Session> {
    let canonical = std::fs::canonicalize(directory).ok();
    sessions(home).into_iter().filter(|session| in_folder(session, directory, canonical.as_deref())).collect()
}

/// Whether `session` began in `directory` (reads the head of its log).
fn in_folder(session: &Session, directory: &str, canonical: Option<&Path>) -> bool {
    workspace_of(session)
        .is_some_and(|root| Path::new(&root) == Path::new(directory) || canonical == Some(Path::new(&root)))
}

/// The folder's session `id`: matched by id first, so only its own log is
/// opened rather than every session's.
fn folder_session(home: &Path, directory: &str, id: &str) -> Option<Session> {
    let canonical = std::fs::canonicalize(directory).ok();
    sessions(home).into_iter().filter(|s| s.id == id).find(|s| in_folder(s, directory, canonical.as_deref()))
}

/// One turn of the log: a prompt or an answer, with its record time.
struct Turn {
    role: &'static str,
    text: String,
    at: Option<i64>,
}

/// The session's prompts and answers, and the model it last ran on.
fn turns(raw: &str, id: &str) -> (Vec<Turn>, Option<String>) {
    let mut turns = Vec::new();
    let mut model = None;
    for line in raw.lines() {
        // Most records are runtime chatter; parse only the few that matter.
        let wanted = line.contains("\"prompt\"") || line.contains("assistant_message_committed") || line.contains("\"model_id\"");
        if !wanted { continue; }
        // A partial last append, or a damaged line, is skipped.
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        if record.get("stream").and_then(|s| s.get("id")).and_then(Value::as_str) != Some(id) { continue; }
        let Some(payload) = record.get("payload") else { continue };
        let at = record.get("recorded_at").and_then(Value::as_i64).map(|us| us / 1000);
        if let Some(found) = payload.get("record").and_then(|r| r.get("model_id")).and_then(Value::as_str) {
            model = Some(found.to_string());
        }
        if payload.get("kind").and_then(Value::as_str) != Some("run") { continue; }
        let Some(event) = payload.get("event") else { continue };
        match event.get("kind").and_then(Value::as_str) {
            Some("started") => {
                if let Some(text) = event.get("prompt").and_then(Value::as_str) {
                    turns.push(Turn { role: "prompt", text: text.to_string(), at });
                }
            }
            Some("assistant_message_committed") => {
                if let Some(text) = event.get("text").and_then(Value::as_str) {
                    turns.push(Turn { role: "answer", text: text.to_string(), at });
                }
            }
            _ => {}
        }
    }
    (turns, model)
}

fn stamp(file: &HomeFile) -> Option<String> {
    let meta = file.open_read()?.metadata().ok()?;
    let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{}:{modified}", meta.len()))
}

fn empty(version: String, previous: Option<&str>) -> AgentTranscript {
    AgentTranscript { available: true, unchanged: previous == Some(version.as_str()), version: Some(version), ..Default::default() }
}

/// The session's chat; `went_by` is what else the read went by, part of its
/// version.
fn read(session: &Session, went_by: &str, version: Option<&str>, limit: usize) -> Option<AgentTranscript> {
    let file = session.log()?;
    let current = format!("muse:{}:{}:{}:{limit}", session.id, stamp(&file)?, crate::digest::sha256_hex(went_by.as_bytes()));
    let mut out = empty(current, version);
    if out.unchanged { return Some(out); }
    let raw = bounded(&file, MAX_BYTES)?;
    let (turns, model) = turns(&raw, &session.id);
    out.model = model;
    for turn in turns {
        out.entries.extend(transcript_entry(turn.role, &turn.text, turn.at.map(crate::services::prompt_blame::epoch_ms_to_iso)));
    }
    if out.entries.len() > limit {
        let drop = out.entries.len() - limit;
        out.truncated = true;
        out.cut_prompt = prompt_cut_off(&out.entries, drop);
        out.entries.drain(..drop);
    }
    Some(out)
}

/// Which of the folder's sessions (`found`, newest first) the tab reads: the
/// newest begun since `since` — and since the moment of its `own` record, the
/// session the Resume menu last took it onto — else that one. `None`: a tab
/// before its first session.
fn tab_session<'a>(found: &'a [Session], since: Option<i64>, own: Option<(&str, i64)>) -> Option<&'a Session> {
    let own = own.filter(|(id, _)| found.iter().any(|s| s.id == *id));
    let since = match own {
        Some((_, at)) => Some(since.map_or(at, |since| since.max(at))),
        None => since,
    };
    found
        .iter()
        .find(|s| since.is_none_or(|since| started_ms(&s.id).is_some_and(|start| start >= since)))
        .or_else(|| own.and_then(|(id, _)| found.iter().find(|s| s.id == id)))
}

/// The tab's chat in `directory`: see [`tab_session`].
pub fn transcript(home: &Path, directory: &str, since: Option<i64>, own: Option<(&str, i64)>, version: Option<&str>, limit: usize) -> AgentTranscript {
    let found = folder_sessions(home, directory);
    let read = match tab_session(&found, since, own) {
        Some(session) => read(session, &format!("{since:?}:{own:?}"), version, limit),
        None => Some(empty(format!("muse:new:{}:{since:?}:{limit}", crate::digest::sha256_hex(directory.as_bytes())), version)),
    };
    read.unwrap_or_else(|| AgentTranscript::unavailable("no_transcript"))
}

/// The folder's earlier session `id`, picked in the Resume menu.
pub fn chat(home: &Path, directory: &str, id: &str, version: Option<&str>, limit: usize) -> AgentTranscript {
    folder_session(home, directory, id)
        .and_then(|session| read(&session, "chat", version, limit))
        .unwrap_or_else(|| AgentTranscript::unavailable("no_transcript"))
}

/// Whether `id` is one of the sessions Muse began in `directory`.
pub fn folder_chat(home: &Path, directory: &str, id: &str) -> bool {
    is_uuid_shaped(id) && folder_session(home, directory, id).is_some()
}

/// The folder's chats for the Resume menu, as `google_chat::antigravity_chats`
/// lists Antigravity's: from the `offset`-th session on, at most `limit` that a
/// prompt went into, of at most `scanned` read.
pub fn folder_chats(home: &Path, directory: &str, offset: usize, limit: usize, scanned: usize) -> Option<(Vec<FolderChat>, Option<usize>)> {
    let found = folder_sessions(home, directory);
    let mut chats = Vec::new();
    let mut at = offset;
    while at < found.len() && chats.len() < limit && at - offset < scanned {
        let session = &found[at];
        at += 1;
        let Some(file) = session.log() else { continue };
        let Some(raw) = bounded(&file, MAX_BYTES) else { continue };
        let (turns, _) = turns(&raw, &session.id);
        let mut prompts = turns.iter().filter(|t| t.role == "prompt" && !t.text.trim().is_empty());
        let Some(first) = prompts.next() else { continue };
        let last = prompts.next_back().map(|t| t.text.clone()).filter(|text| *text != first.text);
        let updated = file.open_read()
            .and_then(|f| f.metadata().ok()?.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |t| t.as_millis() as u64);
        chats.push(FolderChat {
            id: session.id.clone(),
            title: first.text.clone(),
            last,
            started: first.at.or_else(|| started_ms(&session.id)).map(crate::services::prompt_blame::epoch_ms_to_iso),
            updated,
        });
    }
    Some((chats, (at < found.len()).then_some(at)))
}

/// The session the tab `uid` in `directory` is in by its record — the one the
/// Resume menu took it onto, while it began none since.
pub fn recorded_tab_session(home: &Path, directory: &str, project_id: Option<&str>, uid: &str) -> Option<String> {
    let record = crate::services::google_chat::recorded_conversation(project_id, uid)?;
    recorded_among(&folder_sessions(home, directory), record)
}

/// [`recorded_tab_session`] over the folder's sessions already listed
/// (`found`), for the tab's record `(own, at)`.
fn recorded_among(found: &[Session], (own, at): (String, i64)) -> Option<String> {
    tab_session(found, None, Some((&own, at))).map(|s| s.id.clone()).filter(|id| *id == own)
}

/// Resolve a Muse tab's launch. A tab restored on `resume --last` goes back
/// with `resume <id>` to the session the Resume menu took it onto (while it
/// began none since), and starts fresh in a folder Muse has no session for —
/// where `resume --last` would exit and take the tab with it. Remote and
/// local-model tabs are left as they are.
pub fn resolve(mut opts: PtyOptions) -> PtyOptions {
    let remote = !opts.local_only
        && opts.project_id.as_deref().is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
    let Some(at) = resume_last_at(&opts.args) else { return opts };
    if remote || opts.local_model || !Path::new(&opts.cwd).is_absolute() {
        return opts;
    }
    let home = crate::services::agent_home::scope_home(opts.project_id.as_deref());
    let uid = opts.env.get(crate::app_env!("TAB_UID")).cloned();
    let record = uid.and_then(|uid| crate::services::google_chat::recorded_conversation(opts.project_id.as_deref(), &uid));
    // One listing of the folder serves both the record and the fallback.
    let found = folder_sessions(&home, &opts.cwd);
    let own = record.and_then(|record| recorded_among(&found, record));
    opts.args = resumed_onto(&opts.args, at, own.as_deref(), || !found.is_empty());
    opts
}

/// Where `resume --last` starts in `args`.
fn resume_last_at(args: &[String]) -> Option<usize> {
    args.windows(2).position(|pair| pair[0] == "resume" && pair[1] == "--last")
}

/// `args` with the `resume --last` at `at` aimed at `own`, kept when the
/// folder has a session, else dropped.
fn resumed_onto(args: &[String], at: usize, own: Option<&str>, folder_has_one: impl FnOnce() -> bool) -> Vec<String> {
    let mut out = args.to_vec();
    match own {
        Some(id) => out[at + 1] = id.to_string(),
        None if folder_has_one() => {}
        None => { out.drain(at..at + 2); }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "01a1cc13-6d1b-74f0-990e-e25861a7ebef";
    const OTHER: &str = "01a1cc20-0000-7000-8000-000000000001";

    /// Records as Muse 1.4.15 writes them (trimmed to the fields read).
    fn log(id: &str, root: &str, turns: &[(&str, &str)]) -> String {
        // JSON-escaped, as Muse writes it: a Windows path's backslashes.
        let root = serde_json::to_string(root).unwrap();
        let mut lines = vec![
            "{}".to_string(),
            format!(r#"{{"schema_version":1,"stream":{{"kind":"session","id":"{id}"}},"sequence":3,"recorded_at":1794425189681551,"record_type":"event","payload_type":"runtime.session.metadata","payload":{{"kind":"metadata","record":{{"build":{{"semver":"1.4.15"}},"model_id":"muse-spark","provider_id":"meta","workspace_root":{root}}}}}}}"#),
            format!(r#"{{"schema_version":1,"stream":{{"kind":"session","id":"{id}"}},"sequence":4,"recorded_at":1794425189681654,"record_type":"event","payload_type":"runtime.session.route_facts","payload":{{"kind":"route_facts","record":{{"cwd":{root},"pid":1}}}}}}"#),
        ];
        for (n, (prompt, answer)) in turns.iter().enumerate() {
            let us = 1794425194166373_i64 + n as i64 * 1_000_000;
            lines.push(format!(r#"{{"schema_version":1,"stream":{{"kind":"session","id":"{id}"}},"recorded_at":{us},"payload_type":"runtime.user_intent.accepted","payload":{{"model_messages":[{{"content":[{{"kind":"text","text":{p}}}]}}]}}}}"#, p = serde_json::to_string(prompt).unwrap()));
            lines.push(format!(r#"{{"schema_version":1,"stream":{{"kind":"session","id":"{id}"}},"recorded_at":{us},"payload_type":"runtime.session","payload":{{"event":{{"kind":"started","prompt":{p}}},"kind":"run","run_id":"r"}}}}"#, p = serde_json::to_string(prompt).unwrap()));
            lines.push(format!(r#"{{"schema_version":1,"stream":{{"kind":"session","id":"{id}"}},"recorded_at":{us},"payload_type":"runtime.session","payload":{{"event":{{"kind":"started","task_id":"t"}},"kind":"task","run_id":"r"}}}}"#));
            lines.push(format!(r#"{{"schema_version":1,"stream":{{"kind":"session","id":"{id}"}},"recorded_at":{},"payload_type":"runtime.session","payload":{{"event":{{"kind":"assistant_message_committed","message_id":"m","text":{a}}},"kind":"run","run_id":"r"}}}}"#, us + 500, a = serde_json::to_string(answer).unwrap()));
        }
        lines.join("\n") + "\n"
    }

    fn store(home: &Path) -> std::path::PathBuf {
        STORE.split('/').fold(home.to_path_buf(), |path, part| path.join(part))
    }

    fn put(home: &Path, id: &str, text: &str) {
        let dir = store(home).join("2026").join("11").join("11").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("session.jsonl"), text).unwrap();
    }

    #[test]
    fn reads_prompts_and_answers_of_the_folders_session() {
        let home = tempfile::tempdir().unwrap();
        let work = home.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let work = work.to_string_lossy().into_owned();
        put(home.path(), ID, &(log(ID, &work, &[("remember the word pelican", "echo: remember the word pelican"), ("and now?", "pelican")]) + r#"{"partial"#));
        let read = transcript(home.path(), &work, None, None, None, 50);
        assert!(read.available);
        let got: Vec<(&str, &str)> = read.entries.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect();
        assert_eq!(got, [("prompt", "remember the word pelican"), ("answer", "echo: remember the word pelican"), ("prompt", "and now?"), ("answer", "pelican")]);
        assert_eq!(read.model.as_deref(), Some("muse-spark"));
        assert!(read.entries[0].at.as_deref().is_some_and(|at| at.starts_with("2026-11-11T")));
        // Unchanged while the log is.
        let again = transcript(home.path(), &work, None, None, read.version.as_deref(), 50);
        assert!(again.unchanged && again.entries.is_empty());
        // Another folder's session is not this folder's.
        assert!(transcript(home.path(), "/elsewhere", None, None, None, 50).entries.is_empty());
    }

    #[test]
    fn a_fresh_tab_reads_only_a_session_begun_since_its_launch() {
        let home = tempfile::tempdir().unwrap();
        let work = "/w";
        put(home.path(), ID, &log(ID, work, &[("old", "a")]));
        let launched = started_ms(ID).unwrap() + 1;
        assert!(transcript(home.path(), work, Some(launched), None, None, 50).entries.is_empty());
        put(home.path(), OTHER, &log(OTHER, work, &[("new", "b")]));
        let read = transcript(home.path(), work, Some(launched), None, None, 50);
        assert_eq!(read.entries[0].text, "new");
        // The Resume menu's pick is read until the tab begins another.
        let picked = transcript(home.path(), work, Some(launched), Some((ID, started_ms(OTHER).unwrap() + 1)), None, 50);
        assert_eq!(picked.entries[0].text, "old");
    }

    #[test]
    fn the_resume_menu_lists_the_folders_prompted_sessions_newest_first() {
        let home = tempfile::tempdir().unwrap();
        put(home.path(), ID, &log(ID, "/w", &[("first", "a"), ("second", "b")]));
        put(home.path(), OTHER, &log(OTHER, "/w", &[]));
        put(home.path(), "01a1cc30-0000-7000-8000-000000000002", &log("01a1cc30-0000-7000-8000-000000000002", "/other", &[("x", "y")]));
        let (chats, next) = folder_chats(home.path(), "/w", 0, 10, 100).unwrap();
        assert_eq!(chats.len(), 1, "the unprompted session and the other folder's are left out");
        assert_eq!((chats[0].id.as_str(), chats[0].title.as_str(), chats[0].last.as_deref()), (ID, "first", Some("second")));
        assert!(next.is_none());
        assert!(folder_chat(home.path(), "/w", ID));
        assert!(!folder_chat(home.path(), "/other", ID));
        assert_eq!(chat(home.path(), "/w", ID, None, 50).entries.len(), 4);
        assert!(!chat(home.path(), "/other", ID, None, 50).available);
    }

    #[test]
    fn resume_last_is_aimed_at_the_pick_or_dropped_where_nothing_is_left() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let launch = args(&["--model", "m", "resume", "--last"]);
        let at = resume_last_at(&launch).unwrap();
        assert_eq!(resumed_onto(&launch, at, Some(ID), || false), args(&["--model", "m", "resume", ID]));
        assert_eq!(resumed_onto(&launch, at, None, || true), launch);
        assert_eq!(resumed_onto(&launch, at, None, || false), args(&["--model", "m"]));
        // A prompt that merely says "resume" is not the subcommand.
        assert_eq!(resume_last_at(&args(&["resume"])), None);
    }

    /// A store a real Muse wrote: `MUSE_PROBE_HOME=<home> MUSE_PROBE_DIR=<the
    /// folder it ran in>` (scripts/verify-cli/README.md, Muse). Prints what the
    /// Reader and the Resume menu would show; fails on an empty read.
    #[test]
    #[ignore = "needs a store a real Muse wrote"]
    fn reads_a_real_muse_store() {
        let home = std::env::var("MUSE_PROBE_HOME").expect("MUSE_PROBE_HOME");
        let dir = std::env::var("MUSE_PROBE_DIR").expect("MUSE_PROBE_DIR");
        let read = transcript(Path::new(&home), &dir, None, None, None, 200);
        for entry in &read.entries {
            println!("{:>6}  {}", entry.kind, entry.text);
        }
        assert!(read.entries.iter().any(|e| e.kind == "prompt") && read.entries.iter().any(|e| e.kind == "answer"), "{read:?}");
        let (chats, _) = folder_chats(Path::new(&home), &dir, 0, 30, 200).unwrap();
        println!("chats: {:?}", chats.iter().map(|c| (&c.id, &c.title)).collect::<Vec<_>>());
        assert!(!chats.is_empty());
    }

    #[test]
    fn a_uuid_v7_gives_its_start() {
        // 01a1cc13-6d1b… was minted 2026-11-11T19:26:27.611Z.
        assert_eq!(started_ms(ID), Some(1_794_425_187_611));
    }

    #[test]
    fn subagent_folders_and_odd_names_are_not_sessions() {
        let home = tempfile::tempdir().unwrap();
        put(home.path(), ID, &log(ID, "/w", &[("p", "a")]));
        let child = store(home.path()).join("2026").join("11").join("11").join(ID).join("subagent").join(OTHER);
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(child.join("session.jsonl"), log(OTHER, "/w", &[("child", "c")])).unwrap();
        std::fs::create_dir_all(store(home.path()).join("notes")).unwrap();
        let ids: Vec<String> = sessions(home.path()).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, [ID]);
    }

    /// H4: the walk itself is bounded — sessions returned, entries read per
    /// folder and folders listed — and a normal store still comes back whole,
    /// newest first.
    #[test]
    fn the_store_walk_is_bounded_and_newest_first() {
        let home = tempfile::tempdir().unwrap();
        let id = |n: u32| format!("01a1cc{n:02x}-0000-7000-8000-000000000000");
        let at = |day: &str, n: u32| {
            let dir = store(home.path()).join("2026").join("11").join(day).join(id(n));
            std::fs::create_dir_all(&dir).unwrap();
        };
        at("10", 1);
        at("10", 2);
        at("11", 3);
        at("11", 4);
        let ids = |walk: Walk| sessions_within(home.path(), walk).into_iter().map(|s| s.id).collect::<Vec<_>>();
        let roomy = Walk { sessions: 100, entries: 100, listings: 100 };
        assert_eq!(ids(roomy), [id(4), id(3), id(2), id(1)]);
        assert_eq!(sessions(home.path()).len(), 4);
        assert_eq!(ids(Walk { sessions: 3, ..roomy }), [id(4), id(3), id(2)]);
        // Root, year, month and one day listed: the older day is never read.
        assert_eq!(ids(Walk { listings: 4, ..roomy }), [id(4), id(3)]);
        assert!(ids(Walk { listings: 0, ..roomy }).is_empty());
        // A flooded day is read only `entries` names deep, not whole.
        for n in 0..40 {
            std::fs::create_dir_all(store(home.path()).join("2026").join("11").join("12").join(format!("junk-{n}"))).unwrap();
        }
        let capped = ids(Walk { entries: 8, ..roomy });
        assert!(capped.len() <= 4 + 8, "{capped:?}");
        assert!(capped.ends_with(&[id(2), id(1)]), "{capped:?}");
        // Empty folders cost listings, not an unbounded walk.
        for y in 2000..2020 {
            std::fs::create_dir_all(store(home.path()).join(y.to_string()).join("01").join("01")).unwrap();
        }
        // Root, 2026, its month and three days: the twenty empty years after
        // them are never walked.
        assert_eq!(ids(Walk { listings: 6, ..roomy }), [id(4), id(3), id(2), id(1)]);
        assert_eq!(ids(roomy), [id(4), id(3), id(2), id(1)]);
    }
}
