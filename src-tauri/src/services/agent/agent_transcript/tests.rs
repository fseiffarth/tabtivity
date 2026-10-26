use super::*;

fn kinds(transcript: &AgentTranscript) -> Vec<(&str, &str)> {
    transcript
        .entries
        .iter()
        .map(|e| (e.kind.as_str(), e.text.as_str()))
        .collect()
}

#[test]
fn a_codex_turn_ended_by_an_error_shows_it_as_an_answer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollout.jsonl");
    std::fs::write(
        &path,
        concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"run the suite\"}]}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"last_agent_message\":null,\"error\":{\"message\":\"You've hit your usage limit. Try again at 3:20 PM.\",\"codex_error_info\":\"usage_limit_exceeded\"}}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"last_agent_message\":\"done\",\"error\":null}}\n",
        ),
    )
    .unwrap();
    let read = read_transcript(&path, TranscriptKind::Codex, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(kinds(&read), vec![("prompt", "run the suite"), ("answer", "You've hit your usage limit. Try again at 3:20 PM.")]);
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
fn a_slash_command_recorded_as_a_local_command_is_a_prompt() {
    // Claude 2.1.30x writes a command typed at its prompt as a `system`
    // record, not a `user` one: `/login` never showed, and the Chat view's
    // "Sending…" bubble for it never cleared (2026-10-23).
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    let command = |name: &str, args: &str, at: &str| format!(
        "{{\"type\":\"system\",\"subtype\":\"local_command\",\"timestamp\":\"{at}\",\"content\":\"<command-name>/{name}</command-name>\\n  <command-message>{name}</command-message>\\n  <command-args>{args}</command-args>\"}}\n"
    );
    let stdout = "{\"type\":\"system\",\"subtype\":\"local_command\",\"content\":\"<local-command-stdout>Login successful</local-command-stdout>\"}\n";
    std::fs::write(
        &path,
        [
            command("rename", "my-project", "2026-10-23T09:05:00.000Z"),
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"fix it\"}}\n".to_string(),
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Login expired\"}]}}\n".to_string(),
            command("login", "", "2026-10-23T09:08:27.014Z"),
            stdout.to_string(),
            "{\"type\":\"system\",\"subtype\":\"turn_duration\",\"durationMs\":5}\n".to_string(),
            command("model", "opus", "2026-10-23T09:09:00.000Z").replace("\"type\"", "\"isSidechain\":true,\"type\""),
            command("model", "opus", "2026-10-23T09:10:00.000Z"),
        ]
        .concat(),
    )
    .unwrap();
    let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
    // The tab's own `/rename`, the command's output, other system records
    // and a sidechain's are not prompts.
    assert_eq!(
        kinds(&read),
        vec![("prompt", "fix it"), ("answer", "Login expired"), ("prompt", "/login"), ("prompt", "/model opus")]
    );
    assert_eq!(read.entries[2].at.as_deref(), Some("2026-10-23T09:08:27.014Z"));
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
            "{\"type\":\"assistant\",\"message\":{\"model\":\"<synthetic>\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"No response requested.\"}]}}\n",
            "{\"type\":\"assistant\",\"isApiErrorMessage\":true,\"message\":{\"model\":\"<synthetic>\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"API Error: overloaded\"}]}}\n",
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
            // Claude's own placeholder is not a bubble; an API error is.
            ("answer", "API Error: overloaded"),
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
    assert!(!stale.unchanged && stale.entries.len() == 5);

    // The limit keeps the newest turns and says that older ones exist.
    let last = read_transcript(&path, TranscriptKind::Claude, None, 2).unwrap();
    assert!(last.truncated);
    assert_eq!(kinds(&last).iter().map(|(k, _)| *k).collect::<Vec<_>>(), vec!["answer", "prompt"]);

    assert!(read_transcript(&dir.path().join("missing.jsonl"), TranscriptKind::Claude, None, 5).is_none());
}

#[test]
fn asking_for_earlier_turns_reads_further_back_than_the_first_tail() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    // One tool result longer than the first read's whole tail between
    // the two prompts: the first read holds only the newer one.
    let filler = "x".repeat(TAIL_BYTES as usize + 1024);
    let text = format!(
        concat!(
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"older prompt\"}}}}\n",
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"{}\"}}]}}}}\n",
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"newer prompt\"}}}}\n",
        ),
        filler,
    );
    std::fs::write(&path, text).unwrap();

    let first = read_transcript(&path, TranscriptKind::Claude, None, TAIL_STEP_ENTRIES).unwrap();
    assert!(first.truncated);
    assert_eq!(kinds(&first), vec![("prompt", "newer prompt")]);
    // "Show earlier turns" asks for more entries; it must get them.
    let earlier = read_transcript(&path, TranscriptKind::Claude, None, 2 * TAIL_STEP_ENTRIES).unwrap();
    assert!(!earlier.truncated);
    assert_eq!(kinds(&earlier), vec![("prompt", "older prompt"), ("prompt", "newer prompt")]);
}

#[test]
fn request_replay_records_neither_fill_the_tail_nor_reach_the_reader() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    // Claude 2.1.300 copies every API request into the transcript: twice
    // the first tail of them between two prompts, as a blob that also
    // holds a user message.
    let blob = format!(
        "{{\"type\":\"api-request-blob\",\"message\":{{\"role\":\"user\",\"content\":\"{}\"}}}}\n",
        "r".repeat(64 * 1024)
    );
    let replay = blob.repeat(2 * TAIL_BYTES as usize / blob.len());
    let text = format!(
        "{}{replay}{}",
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"older prompt\"}}\n",
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"newer prompt\"}}\n",
    );
    std::fs::write(&path, text).unwrap();

    let read = read_transcript(&path, TranscriptKind::Claude, None, TAIL_STEP_ENTRIES).unwrap();
    assert!(!read.truncated);
    assert_eq!(kinds(&read), vec![("prompt", "older prompt"), ("prompt", "newer prompt")]);
}

#[test]
fn the_tail_grows_with_the_limit_up_to_its_cap() {
    assert_eq!(tail_bytes(0), TAIL_BYTES);
    assert_eq!(tail_bytes(TAIL_STEP_ENTRIES), TAIL_BYTES);
    assert_eq!(tail_bytes(TAIL_STEP_ENTRIES + 1), 2 * TAIL_BYTES);
    assert_eq!(tail_bytes(MAX_LIMIT), MAX_TAIL_BYTES);
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

    let unknown = agent_session_transcript("unknown-agent", None, None, None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, None, 5);
    assert!(!unknown.available);
    assert_eq!(unknown.reason.as_deref(), Some("unsupported"));
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
fn a_claude_workflow_is_an_entry_that_opens_its_agents() {
    let dir = tempfile::tempdir().unwrap();
    let main = dir.path().join("s.jsonl");
    let launch = r#"{"type":"user","toolUseResult":{"status":"async_launched","taskId":"w1","taskType":"local_workflow","workflowName":"chart-improve","runId":"wf_abc-123","summary":"Improve the chart"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_W","content":"launched"}]}}"#;
    std::fs::write(
        &main,
        format!(
            "{}\n{}\n",
            r#"{"type":"assistant","timestamp":"2026-10-20T10:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_W","name":"Workflow","input":{"script":"export const meta = {\n  name: 'chart-improve',\n  description: 'Improve the chart: review then code',\n}"}}]}}"#,
            launch,
        ),
    )
    .unwrap();
    let folder = dir.path().join("s").join("subagents");
    let run = folder.join("workflows").join("wf_abc-123");
    std::fs::create_dir_all(&run).unwrap();

    // Launched: at work, titled by the result, its handle the run's.
    let read = read_transcript_in(&main, TranscriptKind::Claude, &Spawns::Claude(&folder), false, None, DEFAULT_LIMIT).unwrap();
    let entry = &read.entries[0];
    assert_eq!((entry.kind.as_str(), entry.text.as_str(), entry.role.as_deref()), ("agent", "Improve the chart", Some("chart-improve")));
    assert!(entry.workflow && entry.running && entry.background && !entry.finished);
    assert_eq!(entry.subagent, Some(subagent_token("wf_abc-123")));
    assert_eq!(read.running_agents, 1);

    // A task notification for the call ends it.
    let mut text = std::fs::read_to_string(&main).unwrap();
    text.push_str(r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>w1</task-id>\n<tool-use-id>toolu_W</tool-use-id>\n<status>completed</status>\n</task-notification>"}}"#);
    std::fs::write(&main, text + "\n").unwrap();
    let done = read_transcript_in(&main, TranscriptKind::Claude, &Spawns::Claude(&folder), false, None, DEFAULT_LIMIT).unwrap();
    assert!(done.entries[0].finished && !done.entries[0].running);

    // The run: an entry per started agent, the phase as its kind.
    std::fs::write(
        run.join("journal.jsonl"),
        concat!(
            "{\"type\":\"launched\"}\n",
            "{\"type\":\"started\",\"agentId\":\"a1\",\"label\":\"reviewer R1\",\"phase\":\"Review\"}\n",
            "{\"type\":\"started\",\"agentId\":\"a2\",\"label\":\"coder A\",\"phase\":\"Code\"}\n",
            "{\"type\":\"result\",\"agentId\":\"a1\",\"result\":{\"summary\":\"fine\"}}\n",
            "not json\n",
        ),
    )
    .unwrap();
    std::fs::write(run.join("agent-a1.jsonl"), "{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"role\":\"user\",\"content\":\"review it\"}}\n").unwrap();
    let token = subagent_token("wf_abc-123");
    let dir_of = claude_workflow_dir(&folder, &token).expect("run folder");
    let view = workflow_transcript(&dir_of, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(kinds(&view), vec![("agent", "reviewer R1"), ("agent", "coder A")]);
    assert_eq!(view.entries[0].role.as_deref(), Some("Review"));
    assert!(view.entries[0].finished && !view.entries[0].running);
    assert!(view.entries[1].running && view.running_agents == 1);
    // Only an agent whose file exists can be opened, and it opens by the run's folder.
    assert_eq!(view.entries[1].subagent, None);
    let agent = view.entries[0].subagent.clone().expect("handle");
    let file = claude_subagent_file(&folder, &agent).expect("agent file");
    assert_eq!(file, run.join("agent-a1.jsonl"));
    let sub = read_transcript_in(&file, TranscriptKind::Claude, &Spawns::Claude(&folder), true, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(kinds(&sub), vec![("prompt", "review it")]);
    // Unchanged while the journal stands still; watched and changed by the journal.
    assert!(workflow_transcript(&dir_of, view.version.as_deref(), DEFAULT_LIMIT).unwrap().unchanged);
    assert_eq!(claude_conversation_file(&folder, &token), Some(run.join("journal.jsonl")));
    assert!(claude_workflow_dir(&folder, &subagent_token("wf_elsewhere")).is_none());
}

#[test]
fn the_folders_follow_the_session_and_a_subagents_own_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let main = dir.path().join("s.jsonl");
    std::fs::write(
        &main,
        concat!(
            "{\"type\":\"user\",\"cwd\":\"/p\",\"timestamp\":\"2026-10-05T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"split it\"}}\n",
            "{\"type\":\"assistant\",\"cwd\":\"/p\",\"timestamp\":\"2026-10-05T10:00:01Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_A\",\"name\":\"Agent\",\"input\":{\"description\":\"Fix in isolation\",\"isolation\":\"worktree\"}}]}}\n",
            "{\"type\":\"assistant\",\"cwd\":\"/p/.claude/worktrees/fix\",\"timestamp\":\"2026-10-05T10:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_B\",\"name\":\"Agent\",\"input\":{\"description\":\"Scout here\"}}]}}\n",
            // A subagent's record inline in the session's file is its folder, not the session's.
            "{\"type\":\"assistant\",\"isSidechain\":true,\"cwd\":\"/elsewhere\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"inline\"}]}}\n",
        ),
    )
    .unwrap();
    let folder = dir.path().join("s").join("subagents");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("agent-a1b2.meta.json"),
        r#"{"agentType":"general-purpose","toolUseId":"toolu_A","worktreePath":"/p/.claude/worktrees/agent-a1b2","spawnedWithWorktree":true}"#,
    )
    .unwrap();
    let spawns = Spawns::Claude(&folder);
    let read = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, DEFAULT_LIMIT).unwrap();
    // The session moved into a worktree after the first spawn.
    assert_eq!(read.cwd.as_deref(), Some("/p/.claude/worktrees/fix"));
    // The isolated one is in the worktree Claude made for it; the other
    // where the session was when it spawned it.
    assert_eq!(read.entries[1].cwd.as_deref(), Some("/p/.claude/worktrees/agent-a1b2"));
    assert_eq!(read.entries[2].cwd.as_deref(), Some("/p/.claude/worktrees/fix"));
    assert_eq!(read.running_cwds, vec!["/p/.claude/worktrees/agent-a1b2".to_string(), "/p/.claude/worktrees/fix".to_string()]);
    // Read with a limit of one, the running ones' folders still come.
    let cut = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, 1).unwrap();
    assert_eq!(cut.running_cwds.len(), 2);

    let codex = dir.path().join("r.jsonl");
    std::fs::write(
        &codex,
        concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/p\"}}\n",
            "{\"type\":\"turn_context\",\"payload\":{\"cwd\":\"/p/wt\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}}\n",
        ),
    )
    .unwrap();
    assert_eq!(read_transcript(&codex, TranscriptKind::Codex, None, DEFAULT_LIMIT).unwrap().cwd.as_deref(), Some("/p/wt"));
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
    assert!(none.truncated && none.agents_earlier == 0);
    assert!(serde_json::to_value(&none).unwrap().get("agentsEarlier").is_none());

    // One the session's subagent spawned answers to a call in that
    // subagent's file: never listed here, so never counted (it read
    // "Subagents (0+)" in a session that spawned none itself).
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("agent-c3d4.meta.json"),
        r#"{"agentType":"general-purpose","toolUseId":"toolu_N","parentAgentId":"a1b2","spawnDepth":2}"#,
    )
    .unwrap();
    let nested = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, 2).unwrap();
    assert!(nested.truncated && nested.agents_earlier == 0);

    std::fs::write(folder.join("agent-a1b2.meta.json"), r#"{"agentType":"Explore","toolUseId":"toolu_A"}"#).unwrap();
    let cut = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, 2).unwrap();
    assert!(cut.truncated && cut.agents_earlier == 1);
    assert_eq!(serde_json::to_value(&cut).unwrap()["agentsEarlier"].as_u64(), Some(1));
    // The subagent is among the turns read: listed, not counted twice.
    let listed = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, 3).unwrap();
    assert!(listed.truncated && listed.agents_earlier == 0);
    let whole = read_transcript_in(&main, TranscriptKind::Claude, &spawns, false, None, DEFAULT_LIMIT).unwrap();
    assert!(!whole.truncated && whole.agents_earlier == 0);
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
fn the_newest_record_names_the_reasoning_effort() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    let answer = |effort: &str| format!("{{\"type\":\"assistant\",\"effort\":\"{effort}\",\"message\":{{\"model\":\"claude-opus-5-5\",\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"ok\"}}]}}}}\n");
    let said = |text: &str| format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"<local-command-stdout>{text}</local-command-stdout>\"}}}}\n");
    std::fs::write(&path, [answer("medium"), answer("High")].concat()).unwrap();
    let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(read.effort.as_deref(), Some("high"));
    assert_eq!(serde_json::to_value(&read).unwrap()["effort"], "high");

    // A `/effort` counts at once, before the next answer carries it.
    std::fs::write(&path, [answer("high"), said("Set effort level to xhigh (this session only): Deeper reasoning")].concat()).unwrap();
    let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(read.effort.as_deref(), Some("xhigh"));
    std::fs::write(&path, [answer("high"), said("Effort 'max' exceeds the cap for Sonnet 5 set by your settings or organization; set to 'high' instead: x")].concat()).unwrap();
    let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(read.effort.as_deref(), Some("high"));

    // None recorded: nothing shown, never a guess.
    let system = "{\"type\":\"system\",\"subtype\":\"local_command\",\"content\":\"<local-command-stdout>Set effort level to low (this session only): x</local-command-stdout>\"}\n";
    std::fs::write(&path, [answer("high"), system.to_string()].concat()).unwrap();
    let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(read.effort.as_deref(), Some("low"));

    std::fs::write(&path, said("Set model to Opus 5")).unwrap();
    let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(read.effort, None);
    assert!(serde_json::to_value(&read).unwrap().get("effort").is_none());

    // Codex: the turn context's.
    let rollout = dir.path().join("rollout.jsonl");
    std::fs::write(&rollout, "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5\",\"effort\":\"low\"}}\n").unwrap();
    let read = read_transcript(&rollout, TranscriptKind::Codex, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(read.effort.as_deref(), Some("low"));
}

#[test]
fn the_newest_context_card_is_read_off_its_local_command_stdout() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    let command = "{\"type\":\"system\",\"subtype\":\"local_command\",\"content\":\"<command-name>/context</command-name>\\n<command-args></command-args>\"}\n";
    let card = |used: &str| format!("{{\"type\":\"system\",\"subtype\":\"local_command\",\"content\":\"<local-command-stdout> \\u001b[1mContext Usage\\u001b[22m\\n\\u001b[37m⛀ ⛁\\u001b[39m  {used}/1m tokens (5%)\\n</local-command-stdout>\"}}\n");
    std::fs::write(&path, [command.to_string(), card("45.1k"), command.to_string(), card("51.6k")].concat()).unwrap();
    let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(read.context_card.as_deref(), Some(" Context Usage\n⛀ ⛁  51.6k/1m tokens (5%)"));
    assert!(serde_json::to_value(&read).unwrap()["contextCard"].is_string());

    // Older releases' user record counts too; a subagent's and other
    // command output do not.
    let user = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<local-command-stdout>Context Usage\\n1k/200k tokens (1%)</local-command-stdout>\"}}\n";
    std::fs::write(&path, user).unwrap();
    let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(read.context_card.as_deref(), Some("Context Usage\n1k/200k tokens (1%)"));
    let sidechain = "{\"type\":\"system\",\"subtype\":\"local_command\",\"isSidechain\":true,\"content\":\"<local-command-stdout>Context Usage</local-command-stdout>\"}\n";
    let other = "{\"type\":\"system\",\"subtype\":\"local_command\",\"content\":\"<local-command-stdout>Set model to Context Usage</local-command-stdout>\"}\n";
    std::fs::write(&path, [sidechain, other].concat()).unwrap();
    let read = read_transcript(&path, TranscriptKind::Claude, None, DEFAULT_LIMIT).unwrap();
    assert_eq!(read.context_card, None);
    assert!(serde_json::to_value(&read).unwrap().get("contextCard").is_none());
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

#[test]
fn a_reader_watches_its_transcript_the_folder_a_clear_writes_into_and_the_subagents() {
    use crate::services::transcript_watch::{Rule, Target};
    let dir = tempfile::tempdir().unwrap();
    let main = dir.path().join("s1.jsonl");
    std::fs::write(&main, "").unwrap();
    let created = Target { dir: dir.path().to_path_buf(), rule: Rule::Created };
    assert_eq!(conversation_targets("claude", &main, false), vec![Target::file(&main).unwrap(), created.clone()]);
    // Once a subagent spawned, its folder is part of the read's version.
    let subagents = dir.path().join("s1").join("subagents");
    std::fs::create_dir_all(&subagents).unwrap();
    let with_sub = conversation_targets("claude", &main, false);
    assert_eq!(with_sub.last(), Some(&Target { dir: subagents.clone(), rule: Rule::Any }));
    // Codex has no such folder.
    assert_eq!(conversation_targets("codex", &main, false), vec![Target::file(&main).unwrap(), created]);
    let sub = subagents.join("agent-a.jsonl");
    assert_eq!(conversation_targets("claude", &sub, true), vec![Target { dir: subagents, rule: Rule::Any }]);
    assert_eq!(conversation_targets("codex", &sub, true), vec![Target::file(&sub).unwrap()]);
    // Nothing to watch: no session, an agent not read, a bad handle.
    assert!(watch_targets("claude", None, "../x", None, false).is_empty());
    assert!(watch_targets("aider", None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", None, false).is_empty());
    assert!(watch_targets("claude", None, "0f5f9b7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", Some("nope"), false).is_empty());
}

#[cfg(target_os = "linux")]
#[test]
fn a_claude_background_shell_runs_while_its_output_is_held_open_and_no_notification_ended_it() {
    // Through a symlink: the output path Claude writes down keeps it, the
    // fd link of the shell holding it open shows the real path.
    let (_dir, dir) = crate::test_util::tempdir_via_symlink();
    let main = dir.join("s.jsonl");
    let output = dir.join("tasks").join("b1.output");
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

    // The shared process table is walked now, before the shell starts: the
    // read right after (a watch fires on the write that started it) finds
    // a table that does not list the shell yet, and must still see it.
    crate::services::proc_table::snapshot_within(std::time::Duration::ZERO);
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

/// Gap 29: the phone's transcript read and the subagent `.meta.json`
/// scan are agent-written files. A planted FIFO reads as nothing without
/// blocking, and a linked `.meta.json` is not followed.
#[cfg(unix)]
#[test]
fn a_fifo_transcript_or_subagent_meta_reads_as_nothing_without_blocking() {
    use crate::services::home_io::{mkfifo, within_deadline};
    let dir = tempfile::tempdir().unwrap();
    let main = dir.path().join("s.jsonl");
    mkfifo(&main);
    let at = main.clone();
    let read = within_deadline(move || read_transcript_in(&at, TranscriptKind::Claude, &Spawns::None, false, None, DEFAULT_LIMIT).is_none());
    assert!(read, "a FIFO is not a transcript");

    let folder = dir.path().join("subagents");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("agent-a.meta.json"), r#"{"toolUseId":"toolu_A"}"#).unwrap();
    let outside = dir.path().join("outside.json");
    std::fs::write(&outside, r#"{"toolUseId":"toolu_L"}"#).unwrap();
    std::os::unix::fs::symlink(&outside, folder.join("agent-l.meta.json")).unwrap();
    mkfifo(&folder.join("agent-f.meta.json"));
    let at = folder.clone();
    let spawned = within_deadline(move || claude_spawned(&at).into_keys().collect::<Vec<_>>());
    assert_eq!(spawned, vec!["toolu_A".to_string()]);
}
/// A Copilot 1.0.102/1.0.103 session as `events.jsonl` records it (a BYOK
/// stub model driving `apply_patch`, `bash`, `task` and `edit`; paths shortened).
fn copilot_log() -> Vec<String> {
    let at = |n: u32| format!("2026-10-24T06:37:25.{n:03}Z");
    let rec = |kind: &str, n: u32, data: serde_json::Value| serde_json::json!({ "type": kind, "data": data, "id": format!("e{n}"), "timestamp": at(n) }).to_string();
    let patch_one = "\ndiff --git a/work/a.txt b/work/a.txt\ncreate file mode 100644\nindex 0000000..0000000\n--- a/dev/null\n+++ b/work/a.txt\n@@ -1,0 +1,3 @@\n+alpha\n+beta\n+\n\n\n\ndiff --git a/work/b.txt b/work/b.txt\ncreate file mode 100644\nindex 0000000..0000000\n--- a/dev/null\n+++ b/work/b.txt\n@@ -1,0 +1,2 @@\n+bee\n+\n\n";
    let patch_two = "\ndiff --git a/work/a.txt b/work/a.txt\nindex 0000000..0000000 100644\n--- a/work/a.txt\n+++ b/work/a.txt\n@@ -1,3 +1,4 @@\n alpha\n-beta\n+gamma\n+delta\n \n\n\ndiff --git a/work/b.txt b/dev/null\nindex 0000000..0000000 100644\n--- a/work/b.txt\n+++ b/dev/null\n@@ -1,2 +0,0 @@\n-bee\n-\n\n";
    let edit = "\ndiff --git a/work/c.txt b/work/c.txt\nindex 0000000..0000000 100644\n--- a/work/c.txt\n+++ b/work/c.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+three\n \n\n";
    vec![
        rec("session.start", 1, serde_json::json!({ "sessionId": "c4196d1f-a396-42a7-8384-d0783bd09cc7", "copilotVersion": "1.0.103", "context": { "cwd": "/work" } })),
        rec("session.model_change", 2, serde_json::json!({ "newModel": "gpt-5.4", "reasoningEffort": "medium" })),
        rec("user.message", 3, serde_json::json!({ "content": "patch it", "interactionId": "i1", "turnId": "0" })),
        rec("assistant.message", 4, serde_json::json!({ "content": "", "model": "gpt-5.4", "toolRequests": [{ "toolCallId": "call_p1", "name": "apply_patch", "arguments": "*** Begin Patch\n*** End Patch\n", "type": "custom" }] })),
        rec("tool.execution_start", 5, serde_json::json!({ "toolCallId": "call_p1", "toolName": "apply_patch", "arguments": "*** Begin Patch\n*** End Patch\n" })),
        rec("tool.execution_complete", 6, serde_json::json!({ "toolCallId": "call_p1", "success": true, "fileEdits": [{ "path": "/work/a.txt", "kind": "create" }, { "path": "/work/b.txt", "kind": "create" }], "result": { "content": "Added 2 file(s)", "detailedContent": patch_one } })),
        rec("tool.execution_start", 7, serde_json::json!({ "toolCallId": "call_p2", "toolName": "apply_patch", "arguments": "" })),
        rec("tool.execution_complete", 8, serde_json::json!({ "toolCallId": "call_p2", "success": true, "fileEdits": [{ "path": "/work/a.txt", "kind": "edit" }, { "path": "/work/b.txt", "kind": "delete" }], "result": { "content": "Modified 1 file(s)", "detailedContent": patch_two } })),
        rec("tool.execution_complete", 9, serde_json::json!({ "toolCallId": "call_e1", "success": true, "fileEdits": [{ "path": "/work/c.txt", "kind": "edit" }], "result": { "content": "updated", "detailedContent": edit } })),
        rec("tool.execution_complete", 10, serde_json::json!({ "toolCallId": "call_e2", "success": false, "fileEdits": [{ "path": "/work/d.txt", "kind": "edit" }], "result": { "content": "no match" } })),
        rec("assistant.message", 11, serde_json::json!({ "content": "Done.", "model": "gpt-5.4", "toolRequests": [] })),
        rec("session.usage_info", 12, serde_json::json!({ "currentTokens": 18664, "tokenLimit": 272000 })),
    ]
}

#[test]
fn a_copilot_log_reads_as_prompts_answers_model_and_context() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.jsonl");
    let mut lines = copilot_log();
    // A shell still running and a subagent still at work, then one that finished.
    let rec = |kind: &str, data: serde_json::Value| serde_json::json!({ "type": kind, "data": data, "timestamp": "2026-10-24T06:38:00.000Z" }).to_string();
    lines.push(rec("tool.execution_start", serde_json::json!({ "toolCallId": "b1", "toolName": "bash", "arguments": { "command": "sleep 60", "description": "Wait" } })));
    lines.push(rec("tool.execution_start", serde_json::json!({ "toolCallId": "t1", "toolName": "task", "arguments": { "description": "Explore the repo", "agent_type": "explore" } })));
    lines.push(rec("assistant.message", serde_json::json!({ "content": "inside the subagent", "parentToolCallId": "t1" })));
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();

    let read = read_transcript(&path, TranscriptKind::Copilot, None, DEFAULT_LIMIT).unwrap();
    let shown: Vec<_> = read.entries.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect();
    assert_eq!(shown, vec![("prompt", "patch it"), ("answer", "Done."), ("agent", "Explore the repo")]);
    assert!(read.entries[2].running && read.entries[2].role.as_deref() == Some("explore"));
    assert_eq!(read.running_agents, 1);
    assert_eq!(read.model.as_deref(), Some("gpt-5.4"));
    assert_eq!(read.effort.as_deref(), Some("medium"));
    assert_eq!(read.tokens, Some(18664));
    assert_eq!(read.cwd.as_deref(), Some("/work"));
    assert_eq!(read.shells.iter().map(|s| s.command.as_str()).collect::<Vec<_>>(), vec!["sleep 60"]);
    assert_eq!(read.shells[0].description.as_deref(), Some("Wait"));
}

#[test]
fn a_copilot_prompt_is_found_by_the_chat_menu_and_the_prompt_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.jsonl");
    let mut lines = copilot_log();
    lines.push(serde_json::json!({ "type": "user.message", "data": { "content": "and now?" }, "timestamp": "2026-10-24T06:40:00.000Z" }).to_string());
    lines.push(serde_json::json!({ "type": "user.message", "data": { "content": "hidden", "source": "skill-pdf" }, "timestamp": "2026-10-24T06:41:00.000Z" }).to_string());
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    let (first, last) = agent_session::chat_prompts(&path, TranscriptKind::Copilot);
    assert_eq!(first.unwrap().text, "patch it");
    assert_eq!(last.as_deref(), Some("and now?"));
    let recent = agent_session::recent_prompts_in_transcript(&path, TranscriptKind::Copilot).unwrap();
    assert_eq!(recent.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), vec!["patch it", "and now?"]);
    assert_eq!(agent_session::last_model_in_transcript(&path, TranscriptKind::Copilot).as_deref(), Some("gpt-5.4"));
}
