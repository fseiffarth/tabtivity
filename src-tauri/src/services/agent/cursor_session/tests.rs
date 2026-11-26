//! Cursor's chat store, read from stores built the way 2026.11.22 wrote them
//! (a content-addressed `blobs` table, a hex-JSON `meta` row, a protobuf root
//! listing the message blobs and one blob per turn), trimmed to the fields read.

use super::*;
use crate::services::agent_transcript::AgentTranscript;

const UID: &str = "0b9c6a52-5d55-4c3e-9f57-3f2b1a0c9d11";
const UID2: &str = "1c2d3e4f-0000-4000-8000-000000000002";
const A: &str = "afb75573-5a88-4851-928a-5be05bdbef4b";
const B: &str = "b2d700b6-b740-4a49-adda-0729c12f05a1";
const EMPTY: &str = "cd842be9-986d-4a60-8ca4-d49a546995d4";
const SUB: &str = "1e5c8783-2a5c-4249-a64d-15776f222fb1";
const RETRY: &str = "Your previous response was interrupted. Continue from where you left off.";

// ── building a store ────────────────────────────────────────────────────────

fn pb_bytes(field: u32, data: &[u8]) -> Vec<u8> {
    let mut out = pb_varint_raw(u64::from(field) << 3 | 2);
    out.extend(pb_varint_raw(data.len() as u64));
    out.extend_from_slice(data);
    out
}

fn pb_varint_raw(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}

fn pb_varint(field: u32, value: u64) -> Vec<u8> {
    let mut out = pb_varint_raw(u64::from(field) << 3);
    out.extend(pb_varint_raw(value));
    out
}

/// A blob's id: the sha256 of its bytes, hex.
fn id_of(data: &[u8]) -> String {
    crate::digest::sha256_hex(data)
}

/// What one turn of a fixture chat holds.
struct Turn<'a> {
    prompt: &'a str,
    /// Each assistant message: its text and the tool call it ends in.
    steps: Vec<Step<'a>>,
    /// The prompt's time (epoch ms), in the turn's user step.
    at: u64,
}

enum Tool<'a> {
    None,
    /// A `Write` that landed: `diffString` and the path.
    Write { path: &'a str, diff: &'a str },
    /// A `StrReplace` whose result carries no `success`.
    Failed { path: &'a str },
    /// A delete through the dynamic tool.
    Delete { path: &'a str, was: &'a str },
}

struct Step<'a> {
    text: &'a str,
    tool: Tool<'a>,
}

fn assistant(text: &str, call: Option<&str>) -> Value {
    let mut parts = vec![serde_json::json!({"type": "reasoning", "text": "", "signature": "sig", "providerOptions": {"cursor": {"modelName": "cursor-grok-4.5-high"}}})];
    if !text.is_empty() {
        parts.push(serde_json::json!({"type": "text", "text": text}));
    }
    if let Some(id) = call {
        parts.push(serde_json::json!({"type": "tool-call", "toolCallId": id, "toolName": "Write", "args": {}}));
    }
    serde_json::json!({"role": "assistant", "content": parts, "id": "msg_1"})
}

fn tool_result(id: &str, name: &str, output: Value) -> Value {
    serde_json::json!({
        "role": "tool",
        "content": [{"type": "tool-result", "toolCallId": id, "toolName": name, "result": "ok"}],
        "id": id,
        "providerOptions": {"cursor": {"highLevelToolCallResult": {"output": output, "isError": false}}}
    })
}

/// A chat folder of `directory` in `home`: `meta.json`, and — with `turns` —
/// a `store.db` of those turns. A turn's retry (the synthetic prompt and the
/// answer again) is added the way this build writes it.
fn chat(home: &Path, directory: &str, id: &str, created: i64, updated: i64, turns: &[Turn<'_>]) {
    let dir = home.join(".cursor").join("chats").join(crate::services::agent_history::md5_hex(directory)).join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let meta = serde_json::json!({"schemaVersion": 1, "createdAtMs": created, "hasConversation": !turns.is_empty(), "updatedAtMs": updated, "cwd": directory});
    std::fs::write(dir.join("meta.json"), meta.to_string()).unwrap();
    if !turns.is_empty() {
        store(&dir.join("store.db"), id, turns);
    }
}

fn store(path: &Path, agent: &str, turns: &[Turn<'_>]) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);").unwrap();
    let put = |data: &[u8]| {
        let id = id_of(data);
        conn.execute("INSERT OR IGNORE INTO blobs VALUES (?1, ?2)", rusqlite::params![id, data]).unwrap();
        from_hex(&id).unwrap()
    };
    // Cursor writes `role` first; the tool-result filter reads it there.
    let json = |value: &Value| {
        let mut rest = value.as_object().unwrap().clone();
        let role = rest.remove("role").unwrap();
        let body = serde_json::to_string(&rest).unwrap();
        let tail = if body == "{}" { "}".to_string() } else { format!(",{}", &body[1..]) };
        put(format!("{{\"role\":{role}{tail}").as_bytes())
    };
    let mut root = Vec::new();
    root.extend(pb_bytes(1, &json(&serde_json::json!({"role": "system", "content": "You are an AI coding assistant"}))));
    root.extend(pb_bytes(1, &json(&serde_json::json!({"role": "user", "content": "<user_info>\nOS Version: linux\n</user_info>"}))));
    let mut turn_ids = Vec::new();
    for (n, turn) in turns.iter().enumerate() {
        let query = format!("<timestamp>Wednesday, Nov 25, 2026, 12:15 PM (UTC+1)</timestamp>\n<user_query>\n{}\n</user_query>", turn.prompt);
        root.extend(pb_bytes(1, &json(&serde_json::json!({"role": "user", "content": [{"type": "text", "text": query}], "providerOptions": {"cursor": {"requestId": format!("r{n}")}}}))));
        for (s, step) in turn.steps.iter().enumerate() {
            let call = format!("call-{n}-{s}\nfc_x");
            let has_call = !matches!(step.tool, Tool::None);
            root.extend(pb_bytes(1, &json(&assistant(step.text, has_call.then_some(call.as_str())))));
            let result = match &step.tool {
                Tool::None => None,
                Tool::Write { path, diff } => Some(tool_result(&call, "Write", serde_json::json!({"success": {"path": path, "linesAdded": 1, "linesRemoved": 0, "diffString": diff, "afterFullFileContent": "x"}}))),
                Tool::Failed { path } => Some(tool_result(&call, "StrReplace", serde_json::json!({"error": {"path": path, "message": "no match"}}))),
                Tool::Delete { path, was } => Some(tool_result(&call, "CallDynamicTool", serde_json::json!({"success": {"path": path, "deletedFile": path, "fileSize": "5", "prevContent": was}}))),
            };
            if let Some(result) = result {
                root.extend(pb_bytes(1, &json(&result)));
            }
        }
        // The retry: a synthetic prompt, and the last answer once more.
        root.extend(pb_bytes(1, &json(&serde_json::json!({"role": "user", "content": RETRY}))));
        if let Some(last) = turn.steps.last().filter(|s| !s.text.is_empty()) {
            root.extend(pb_bytes(1, &json(&assistant(last.text, None))));
        }
        let mut step = pb_bytes(1, turn.prompt.as_bytes());
        step.extend(pb_bytes(2, b"9f784000-52e9-4419-9a97-b64f73649d2e"));
        step.extend(pb_varint(25, turn.at));
        let step_id = put(&step);
        let turn_blob = pb_bytes(1, &pb_bytes(1, &step_id));
        turn_ids.push(put(&turn_blob));
    }
    for turn in &turn_ids {
        root.extend(pb_bytes(8, turn));
    }
    let root_id = to_hex(&put(&root));
    let meta = serde_json::json!({"agentId": agent, "latestRootBlobId": root_id, "name": "New Agent", "mode": "default", "createdAt": 1, "blobEncryptionKey": "x"});
    conn.execute("INSERT INTO meta VALUES ('0', ?1)", [to_hex(meta.to_string().as_bytes())]).unwrap();
}

const NEW_FILE: &str = "--- /dev/null\n+++ b//w/hello.txt\n@@ -1,0 +1 @@\n+alpha";
const EDIT: &str = "--- a//w/hello.txt\n+++ b//w/hello.txt\n@@ -1 +1 @@\n-alpha\n+beta";

fn say(text: &str) -> Step<'_> {
    Step { text, tool: Tool::None }
}

struct Work {
    home: tempfile::TempDir,
    dir: String,
}

fn work() -> Work {
    // Under the canonical temp dir: SQLite's `NOFOLLOW` refuses a link
    // anywhere in the store's path, and macOS's temp dir is reached through
    // `/var` → `/private/var`. An agent home under the state dir has none.
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let dir = home.path().join("work");
    std::fs::create_dir_all(&dir).unwrap();
    let dir = dir.to_string_lossy().into_owned();
    Work { home, dir }
}

fn pairs(read: &AgentTranscript) -> Vec<(&str, &str)> {
    read.entries.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect()
}

fn recorded_noted(id: &str, at: i64) -> Recorded {
    Recorded { id: id.to_string(), at, noted: true }
}

// ── the chat ────────────────────────────────────────────────────────────────

#[test]
fn reads_prompts_and_answers_and_steps_over_the_retry() {
    let w = work();
    chat(
        w.home.path(),
        &w.dir,
        A,
        1_000,
        2_000,
        &[
            Turn { prompt: "Run the shell command ls", steps: vec![say("I'll run it."), say("Only hello.txt is listed.")], at: 1_795_605_583_161 },
            Turn { prompt: "Reply with the single word SECOND.", steps: vec![say("SECOND")], at: 1_795_605_608_590 },
        ],
    );
    let read = chat_of(&w, A, None);
    assert!(read.available, "{read:?}");
    assert_eq!(
        pairs(&read),
        [
            ("prompt", "Run the shell command ls"),
            ("answer", "I'll run it."),
            ("answer", "Only hello.txt is listed."),
            ("prompt", "Reply with the single word SECOND."),
            ("answer", "SECOND"),
        ]
    );
    assert_eq!(read.model.as_deref(), Some("cursor-grok-4.5-high"));
    // The typed prompts' times, when there is one per turn.
    assert_eq!(read.entries[0].at.as_deref(), Some(iso(1_795_605_583_161).as_str()));
    assert_eq!(read.entries[3].at.as_deref(), Some(iso(1_795_605_608_590).as_str()));
    assert_eq!(read.entries[1].at, None);
}

fn chat_of(w: &Work, id: &str, version: Option<&str>) -> AgentTranscript {
    super::chat(w.home.path(), &w.dir, id, version, 100)
}

#[test]
fn a_read_with_the_version_it_returned_is_unchanged_until_the_store_moves() {
    let w = work();
    chat(w.home.path(), &w.dir, A, 1, 2, &[Turn { prompt: "one", steps: vec![say("a")], at: 1 }]);
    let first = chat_of(&w, A, None);
    let again = chat_of(&w, A, first.version.as_deref());
    assert!(again.unchanged && again.entries.is_empty());
    // The conversation grows: a new root blob, a new version.
    std::fs::remove_file(w.home.path().join(".cursor").join("chats").join(crate::services::agent_history::md5_hex(&w.dir)).join(A).join("store.db")).unwrap();
    chat(w.home.path(), &w.dir, A, 1, 3, &[Turn { prompt: "one", steps: vec![say("a")], at: 1 }, Turn { prompt: "two", steps: vec![say("b")], at: 2 }]);
    let grown = chat_of(&w, A, first.version.as_deref());
    assert!(!grown.unchanged);
    assert_eq!(grown.entries.len(), 4);
}

#[test]
fn the_entry_limit_keeps_the_newest_and_pins_the_prompt_they_answer() {
    let w = work();
    chat(w.home.path(), &w.dir, A, 1, 2, &[Turn { prompt: "p1", steps: vec![say("a1"), say("a2"), say("a3")], at: 1 }]);
    let read = super::chat(w.home.path(), &w.dir, A, None, 2);
    assert_eq!(pairs(&read), [("answer", "a2"), ("answer", "a3")]);
    assert!(read.truncated);
    assert_eq!(read.cut_prompt.as_deref().map(|p| p.text.as_str()), Some("p1"));
}

#[test]
fn a_chat_before_its_first_prompt_is_an_empty_conversation_not_an_error() {
    let w = work();
    chat(w.home.path(), &w.dir, EMPTY, 1, 1, &[]);
    let read = chat_of(&w, EMPTY, None);
    assert!(read.available && read.entries.is_empty());
    assert!(super::folder_chat(w.home.path(), &w.dir, EMPTY));
    let diffs = super::chat_changes(w.home.path(), &w.dir, EMPTY, None, 50);
    assert!(diffs.available && diffs.changes.is_empty());
}

#[test]
fn only_chats_that_began_in_the_folder_with_a_meta_file_count() {
    let w = work();
    chat(w.home.path(), &w.dir, A, 1, 2, &[Turn { prompt: "mine", steps: vec![say("a")], at: 1 }]);
    // Another folder keyed alike by hand: its meta names another cwd.
    let other = w.home.path().join("other").to_string_lossy().into_owned();
    chat(w.home.path(), &other, B, 1, 2, &[Turn { prompt: "theirs", steps: vec![say("b")], at: 1 }]);
    let stolen = w.home.path().join(".cursor").join("chats").join(crate::services::agent_history::md5_hex(&other)).join(B);
    let ours = w.home.path().join(".cursor").join("chats").join(crate::services::agent_history::md5_hex(&w.dir)).join(B);
    std::fs::rename(stolen, ours).unwrap();
    // A subagent's chat: a store and no meta.json.
    let sub = w.home.path().join(".cursor").join("chats").join(crate::services::agent_history::md5_hex(&w.dir)).join(SUB);
    std::fs::create_dir_all(&sub).unwrap();
    store(&sub.join("store.db"), SUB, &[Turn { prompt: "sub", steps: vec![say("s")], at: 1 }]);
    let ids: Vec<_> = folder_chats_all(w.home.path(), &w.dir).into_iter().map(|c| c.id).collect();
    assert_eq!(ids, [A]);
    assert!(!super::folder_chat(w.home.path(), &w.dir, SUB));
    assert!(!super::folder_chat(w.home.path(), &w.dir, B));
    assert!(!super::folder_chat(w.home.path(), &w.dir, "../x"));
    assert_eq!(super::chat(w.home.path(), &w.dir, SUB, None, 10).reason.as_deref(), Some("no_transcript"));
}

#[test]
fn the_resume_menu_lists_chats_with_a_conversation_newest_used_first() {
    let w = work();
    chat(w.home.path(), &w.dir, A, 10, 50, &[Turn { prompt: "first", steps: vec![say("a")], at: 1_795_605_583_161 }, Turn { prompt: "second", steps: vec![say("b")], at: 2 }]);
    chat(w.home.path(), &w.dir, B, 20, 90, &[Turn { prompt: "only one", steps: vec![say("c")], at: 3 }]);
    chat(w.home.path(), &w.dir, EMPTY, 30, 30, &[]);
    let (chats, next) = folder_chats(w.home.path(), &w.dir, 0, 10, 100).unwrap();
    assert_eq!(next, None);
    let rows: Vec<_> = chats.iter().map(|c| (c.id.as_str(), c.title.as_str(), c.last.as_deref(), c.updated)).collect();
    assert_eq!(rows, [(B, "only one", None, 90), (A, "first", Some("second"), 50)]);
    assert_eq!(chats[1].started.as_deref(), Some(iso(1_795_605_583_161).as_str()));
    // A page of one reports where the next starts.
    let (page, next) = folder_chats(w.home.path(), &w.dir, 0, 1, 100).unwrap();
    assert_eq!((page.len(), next), (1, Some(1)));
}

// ── the diffs ───────────────────────────────────────────────────────────────

#[test]
fn the_diffs_come_from_the_tool_results_and_a_failed_call_lists_nothing() {
    let w = work();
    chat(
        w.home.path(),
        &w.dir,
        A,
        1,
        2,
        &[Turn {
            prompt: "edit",
            steps: vec![
                Step { text: "Creating.", tool: Tool::Write { path: "/w/hello.txt", diff: NEW_FILE } },
                Step { text: "", tool: Tool::Write { path: "/w/hello.txt", diff: EDIT } },
                Step { text: "", tool: Tool::Failed { path: "/w/hello.txt" } },
                Step { text: "", tool: Tool::Delete { path: "/w/old.txt", was: "one\ntwo\n" } },
                say("done"),
            ],
            at: 1,
        }],
    );
    let read = super::chat_changes(w.home.path(), &w.dir, A, None, 50);
    assert!(read.available, "{read:?}");
    let rows: Vec<_> = read.changes.iter().map(|c| (c.path.as_str(), c.kind.as_str(), c.added, c.removed)).collect();
    assert_eq!(rows, [("/w/hello.txt", "add", 1, 0), ("/w/hello.txt", "edit", 1, 1), ("/w/old.txt", "delete", 0, 2)]);
    assert_eq!(read.changes[0].diff, "@@ -0,0 +1 @@\n+alpha");
    assert_eq!(read.changes[1].diff, "@@ -1 +1 @@\n-alpha\n+beta");
    assert_eq!(read.changes[2].diff, "@@ -1,2 +0,0 @@\n-one\n-two\n");
    // The same version answers unchanged; the limit keeps the newest.
    let again = super::chat_changes(w.home.path(), &w.dir, A, read.version.as_deref(), 50);
    assert!(again.unchanged && again.changes.is_empty());
    let last = super::chat_changes(w.home.path(), &w.dir, A, None, 1);
    assert_eq!(last.changes.len(), 1);
    assert!(last.truncated);
    assert_eq!(last.changes[0].kind, "delete");
}

// ── which chat is the tab's ─────────────────────────────────────────────────

fn tab(w: &Work, since: Option<i64>, own: Option<&Recorded>) -> Vec<(String, String)> {
    let read = super::transcript(w.home.path(), &w.dir, since, own, None, 100);
    read.entries.iter().map(|e| (e.kind.clone(), e.text.clone())).collect()
}

#[test]
fn two_tabs_in_one_folder_each_read_their_own_chat_by_record() {
    let w = work();
    chat(w.home.path(), &w.dir, A, 100, 400, &[Turn { prompt: "tab one asked", steps: vec![say("answer one")], at: 1 }]);
    chat(w.home.path(), &w.dir, B, 200, 300, &[Turn { prompt: "tab two asked", steps: vec![say("answer two")], at: 2 }]);
    let one = tab(&w, Some(150), Some(&recorded_noted(A, 1_000)));
    let two = tab(&w, Some(50), Some(&recorded_noted(B, 1_000)));
    assert_eq!(one[0].1, "tab one asked");
    assert_eq!(two[0].1, "tab two asked");
    // Not noted (before the hook): the record still names the chat the tab began no other since.
    let unnoted = Recorded { id: A.to_string(), at: 450, noted: false };
    assert_eq!(tab(&w, None, Some(&unnoted))[0].1, "tab one asked");
}

#[test]
fn without_a_record_the_newest_chat_begun_since_the_launch_with_a_conversation_is_read() {
    let w = work();
    chat(w.home.path(), &w.dir, A, 100, 400, &[Turn { prompt: "old", steps: vec![say("o")], at: 1 }]);
    chat(w.home.path(), &w.dir, B, 200, 300, &[Turn { prompt: "newer", steps: vec![say("n")], at: 2 }]);
    // The tab's own launch-time chat before its first prompt: no conversation, never picked.
    chat(w.home.path(), &w.dir, EMPTY, 500, 500, &[]);
    assert_eq!(tab(&w, Some(150), None)[0].1, "newer");
    // Nothing begun since this launch: a tab before its first prompt.
    assert!(tab(&w, Some(600), None).is_empty());
    // A restored tab: the most recently used.
    assert_eq!(tab(&w, None, None)[0].1, "old");
}

#[test]
fn a_noted_tab_reads_its_recorded_chat_whatever_began_since() {
    let w = work();
    chat(w.home.path(), &w.dir, A, 100, 150, &[Turn { prompt: "mine", steps: vec![say("m")], at: 1 }]);
    chat(w.home.path(), &w.dir, B, 900, 950, &[Turn { prompt: "the other tab's", steps: vec![say("t")], at: 2 }]);
    assert_eq!(tab(&w, Some(50), Some(&recorded_noted(A, 160)))[0].1, "mine");
    // The record names a chat the folder no longer has: back to the fallback.
    assert_eq!(tab(&w, Some(50), Some(&recorded_noted("0d9f2a31-0000-4000-8000-000000000009", 160)))[0].1, "the other tab's");
}

#[test]
fn the_reader_watches_the_folder_for_a_next_chat_and_the_database_of_the_one_it_reads() {
    let w = work();
    chat(w.home.path(), &w.dir, A, 100, 150, &[Turn { prompt: "mine", steps: vec![say("m")], at: 1 }]);
    let targets = watch_targets(w.home.path(), &w.dir, None, None);
    let rules: Vec<_> = targets.iter().map(|t| (t.dir.file_name().unwrap().to_string_lossy().into_owned(), format!("{:?}", t.rule))).collect();
    assert_eq!(rules.len(), 2, "{rules:?}");
    assert!(rules[0].1.contains("Created"), "{rules:?}");
    assert!(rules[1].0 == A && rules[1].1.contains("store.db"), "{rules:?}");
    assert_eq!(chat_watch_targets(w.home.path(), &w.dir, A).len(), 1);
    assert!(chat_watch_targets(w.home.path(), &w.dir, SUB).is_empty());
}

/// A project folder reached through a link: Cursor ran in the real folder and
/// keyed its chats by that path, so the chats sit under the canonical key.
#[cfg(unix)]
#[test]
fn a_folder_reached_through_a_link_is_watched_under_the_key_its_chats_sit_in() {
    let w = work();
    let real = std::fs::canonicalize(&w.dir).unwrap();
    let link = w.home.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let (real, link) = (real.to_string_lossy().into_owned(), link.to_string_lossy().into_owned());
    chat(w.home.path(), &real, A, 100, 150, &[Turn { prompt: "mine", steps: vec![say("m")], at: 1 }]);
    let targets = watch_targets(w.home.path(), &link, None, None);
    let rules: Vec<_> = targets.iter().map(|t| (t.dir.file_name().unwrap().to_string_lossy().into_owned(), format!("{:?}", t.rule))).collect();
    assert_eq!(rules.len(), 2, "{rules:?}");
    assert_eq!(rules[0].0, crate::services::agent_history::md5_hex(&real), "{rules:?}");
    assert!(rules[0].1.contains("Created") && rules[1].0 == A && rules[1].1.contains("store.db"), "{rules:?}");
    assert_eq!(chat_watch_targets(w.home.path(), &link, A).len(), 1);
}

// ── the launch ──────────────────────────────────────────────────────────────

fn opts(w: &Work, args: &[&str]) -> PtyOptions {
    let mut o = PtyOptions {
        login: None,
        assistant: None,
        id: "t".to_string(),
        cmd: "cursor-agent".to_string(),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: Default::default(),
        cwd: w.dir.clone(),
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

fn launch(w: &Work, args: &[&str], noted: bool, record: Option<(&str, i64)>, proven: bool) -> Vec<String> {
    let notes = tempfile::tempdir().unwrap();
    if noted {
        note_launch_in(notes.path(), UID).unwrap();
    }
    let record = record.map(|(id, at)| (id.to_string(), at));
    let out = resolve_in(opts(w, args), w.home.path(), notes.path(), true, move |uid| (uid == UID).then(|| record.clone()).flatten(), move || proven);
    assert_eq!(out.env.get(TAB_AGENT_ENV).map(String::as_str), Some("cursor-agent"));
    // This spawn is noted for the next one.
    assert!(noted_in(notes.path(), UID));
    out.args
}

#[test]
fn a_restored_tab_resumes_its_recorded_chat_by_id() {
    let w = work();
    chat(w.home.path(), &w.dir, A, 100, 150, &[Turn { prompt: "mine", steps: vec![say("m")], at: 1 }]);
    chat(w.home.path(), &w.dir, B, 200, 900, &[Turn { prompt: "newer", steps: vec![say("n")], at: 2 }]);
    // The folder's newest (`--continue`) is B; this tab's record says A.
    assert_eq!(launch(&w, &["--continue"], true, Some((A, 160)), true), ["--resume", A]);
    // A tab from before the hook that the Resume menu pointed at A, after B began.
    assert_eq!(launch(&w, &["--continue"], false, Some((A, 950)), false), ["--resume", A]);
    // Another tab's chat began since the record: not the tab's to claim.
    assert_eq!(launch(&w, &["--continue"], false, Some((A, 160)), false), ["--continue"]);
    // A record that names a chat the folder lost: the folder's newest, as before.
    assert_eq!(launch(&w, &["--continue"], true, Some(("0d9f2a31-0000-4000-8000-000000000009", 1)), false), ["--continue"]);
    // The flag moves with the rest of the arguments.
    assert_eq!(launch(&w, &["--model", "auto", "--continue"], true, Some((A, 160)), true), ["--model", "auto", "--resume", A]);
}

#[test]
fn a_tab_that_never_took_a_prompt_starts_fresh_and_a_folder_without_chats_drops_the_flag() {
    let w = work();
    chat(w.home.path(), &w.dir, B, 200, 900, &[Turn { prompt: "the other tab's", steps: vec![say("n")], at: 2 }]);
    // Noted, the hook proven, nothing recorded: not another tab's chat.
    assert!(launch(&w, &["--continue"], true, None, true).is_empty());
    // Not noted (a tab from before the hook): the folder's newest, as ever.
    assert_eq!(launch(&w, &["--continue"], false, None, true), ["--continue"]);
    // Noted but the hook has never recorded in the scope: it may not work here.
    assert_eq!(launch(&w, &["--continue"], true, None, false), ["--continue"]);
    // A fresh tab has no flag to aim.
    assert!(launch(&w, &[], true, Some((B, 1)), true).is_empty());
    // `--continue` in a folder with no chat that has a conversation exits: dropped.
    let empty = work();
    chat(empty.home.path(), &empty.dir, EMPTY, 1, 1, &[]);
    assert!(launch(&empty, &["--continue"], false, None, false).is_empty());
}

#[test]
fn a_local_model_or_relative_launch_is_left_as_it_is() {
    let w = work();
    let mut relative = opts(&w, &["--continue"]);
    relative.cwd = "relative/dir".to_string();
    assert_eq!(resolve(relative.clone()).args, relative.args);
    assert!(!resolve(relative).env.contains_key(TAB_AGENT_ENV));
    let mut local = opts(&w, &["--continue"]);
    local.local_model = true;
    assert_eq!(resolve(local).args, ["--continue"]);
}

#[test]
fn the_pin_is_the_record_the_hook_wrote_for_a_chat_of_the_folder() {
    let w = work();
    chat(w.home.path(), &w.dir, A, 100, 150, &[Turn { prompt: "mine", steps: vec![say("m")], at: 1 }]);
    let notes = tempfile::tempdir().unwrap();
    note_launch_in(notes.path(), UID2).unwrap();
    assert!(noted_in(notes.path(), UID2));
    assert!(!noted_in(notes.path(), UID));
    assert!(!noted_in(notes.path(), "../x"));
    let own = Recorded { id: A.to_string(), at: 1, noted: true };
    assert_eq!(recorded_among(&folder_chats_all(w.home.path(), &w.dir), &own).as_deref(), Some(A));
    let gone = Recorded { id: B.to_string(), at: 1, noted: true };
    assert_eq!(recorded_among(&folder_chats_all(w.home.path(), &w.dir), &gone), None);
}

// ── a hostile store ─────────────────────────────────────────────────────────

#[test]
fn the_protobuf_reader_never_trusts_a_length_or_a_field() {
    assert!(fields(&[]).is_empty());
    // A length past the end, a wire type it does not know, a varint with no end.
    assert!(fields(&[0x0a, 0x7f, 0x01]).is_empty());
    assert!(fields(&[0x0b, 0x01]).is_empty());
    assert!(fields(&[0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).is_empty());
    let ok = [pb_varint(25, 7), pb_bytes(1, b"x")].concat();
    let got = fields(&ok);
    assert_eq!(got.len(), 2);
    assert!(matches!(got[0], (25, Wire::Varint(7))));
    assert!(matches!(&got[1], (1, Wire::Bytes(b"x"))));
    assert_eq!(from_hex("zz"), None);
    assert_eq!(from_hex("abc"), None);
    assert_eq!(from_hex("00ff"), Some(vec![0, 255]));
}

#[test]
fn a_root_naming_blobs_that_are_not_there_or_not_json_reads_as_an_empty_chat() {
    let w = work();
    let dir = w.home.path().join(".cursor").join("chats").join(crate::services::agent_history::md5_hex(&w.dir)).join(A);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("meta.json"), serde_json::json!({"createdAtMs": 1, "updatedAtMs": 2, "hasConversation": true, "cwd": w.dir}).to_string()).unwrap();
    let conn = Connection::open(dir.join("store.db")).unwrap();
    conn.execute_batch("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);").unwrap();
    let junk = vec![0u8, 1, 2, 3];
    let junk_id = id_of(&junk);
    conn.execute("INSERT INTO blobs VALUES (?1, ?2)", rusqlite::params![junk_id, junk]).unwrap();
    // A message blob that is not JSON, and one that is not there.
    let root = [pb_bytes(1, &from_hex(&junk_id).unwrap()), pb_bytes(1, &[7u8; 32]), pb_bytes(8, &[9u8; 32])].concat();
    let root_id = id_of(&root);
    conn.execute("INSERT INTO blobs VALUES (?1, ?2)", rusqlite::params![root_id, root]).unwrap();
    let meta = serde_json::json!({"latestRootBlobId": root_id});
    conn.execute("INSERT INTO meta VALUES ('0', ?1)", [to_hex(meta.to_string().as_bytes())]).unwrap();
    drop(conn);
    let read = chat_of(&w, A, None);
    assert!(read.available && read.entries.is_empty(), "{read:?}");
    assert!(super::chat_changes(w.home.path(), &w.dir, A, None, 10).changes.is_empty());
    let (chats, _) = folder_chats(w.home.path(), &w.dir, 0, 10, 10).unwrap();
    assert!(chats.is_empty(), "no first prompt, no row");
}

#[test]
fn a_view_standing_in_for_the_blob_table_is_refused() {
    let w = work();
    let dir = w.home.path().join(".cursor").join("chats").join(crate::services::agent_history::md5_hex(&w.dir)).join(A);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("meta.json"), serde_json::json!({"createdAtMs": 1, "updatedAtMs": 2, "hasConversation": true, "cwd": w.dir}).to_string()).unwrap();
    Connection::open(dir.join("store.db"))
        .unwrap()
        .execute_batch("CREATE VIEW blobs AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i AS id, x'00' AS data FROM n; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);")
        .unwrap();
    assert_eq!(chat_of(&w, A, None).reason.as_deref(), Some("no_transcript"));
}

#[test]
fn a_prompt_is_the_text_inside_the_query_tags_and_nothing_else_is() {
    assert_eq!(user_query("<timestamp>x</timestamp>\n<user_query>\nhello\n</user_query>"), Some("hello"));
    assert_eq!(user_query("<user_query>a</user_query> and <user_query>b</user_query>"), Some("a</user_query> and <user_query>b"));
    assert_eq!(user_query("<user_info>\nOS\n</user_info>"), None);
    assert_eq!(user_query("</user_query><user_query>"), None);
}

/// Write the hook script and register it in `<CURSOR_PROBE_HOME>/.cursor/hooks.json`
/// for `scripts/verify-cli/cursor/hooks.py`, which plays two tabs against the real
/// Cursor. The folder given is the probe's scratch project, never the app's.
#[cfg(unix)]
#[test]
#[ignore = "writes the hook for scripts/verify-cli/cursor/hooks.py"]
fn writes_the_cursor_hook_for_a_probe() {
    use std::os::unix::fs::PermissionsExt;
    let script = std::path::PathBuf::from(std::env::var("CURSOR_PROBE_SCRIPT").expect("CURSOR_PROBE_SCRIPT"));
    let live = std::env::var("CURSOR_PROBE_LIVE").expect("CURSOR_PROBE_LIVE");
    let home = std::env::var("CURSOR_PROBE_HOME").expect("CURSOR_PROBE_HOME");
    std::fs::write(&script, hook::script_body(&live)).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(hook::register_command_in(Path::new(&home), &format!("\"{}\"", script.to_string_lossy())));
}

/// A real store, read the way the Reader reads it: `CURSOR_PROBE_HOME` is the
/// home holding `.cursor/chats`, `CURSOR_PROBE_DIR` the folder its chats ran
/// in. Prints the Resume menu's rows, then each chat's entries and changes.
#[test]
#[ignore = "reads a store a real Cursor wrote: set CURSOR_PROBE_HOME and CURSOR_PROBE_DIR"]
fn reads_a_real_cursor_store() {
    let home = std::env::var("CURSOR_PROBE_HOME").expect("CURSOR_PROBE_HOME");
    let dir = std::env::var("CURSOR_PROBE_DIR").expect("CURSOR_PROBE_DIR");
    let (chats, next) = folder_chats(Path::new(&home), &dir, 0, 50, 100).expect("a listing");
    println!("{} chats with a conversation (next {next:?})", chats.len());
    for row in &chats {
        println!("== {} {:?} last {:?} started {:?}", row.id, row.title, row.last, row.started);
        let read = super::chat(Path::new(&home), &dir, &row.id, None, 200);
        assert!(read.available, "{read:?}");
        for entry in &read.entries {
            println!("  {} {:?}", entry.kind, entry.text.chars().take(80).collect::<String>());
        }
        let changes = super::chat_changes(Path::new(&home), &dir, &row.id, None, 200);
        for change in &changes.changes {
            println!("  change {} {} +{} -{}", change.kind, change.path, change.added, change.removed);
        }
    }
    assert!(!chats.is_empty(), "no chat with a conversation in {dir}");
}
