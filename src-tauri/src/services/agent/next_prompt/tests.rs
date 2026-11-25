use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const TAGS: &str = r#"{"models":[
    {"name":"llama3:latest","size":1},
    {"name":"gpt-oss:120b-cloud","remote_model":"gpt-oss:120b","remote_host":"https://ollama.com:443"}
]}"#;

fn entry(kind: &str, text: &str) -> TranscriptEntry {
    TranscriptEntry { kind: kind.into(), text: text.into(), ..Default::default() }
}

fn transcript(entries: Vec<TranscriptEntry>) -> AgentTranscript {
    AgentTranscript { available: true, entries, ..Default::default() }
}

fn ended_turn() -> AgentTranscript {
    transcript(vec![
        entry("prompt", "old prompt"),
        entry("answer", "old answer"),
        entry("prompt", "fix the failing test"),
        entry("agent", "Explore the test suite\nand more"),
        entry("answer", "Fixed it: the fixture was stale. Want me to run the whole suite?"),
    ])
}

fn suggest_on(model: &str) -> Settings {
    let mut roles = std::collections::HashMap::new();
    roles.insert(ROLE.to_string(), model.to_string());
    Settings { ollama_roles: Some(roles), ..Default::default() }
}

fn ask(key: &str, phase: Phase) -> Ask<'_> {
    Ask { key, agent: "codex", phase, local_model: false, draft: None }
}

fn complete<'a>(key: &'a str, draft: &'a str) -> Ask<'a> {
    Ask { draft: Some(draft), ..ask(key, Phase::Complete) }
}

fn no_caps(_: &str, _: &str) -> Vec<String> {
    vec!["completion".into()]
}

fn not_pinned(_: &str, _: &str) -> bool {
    false
}

fn answer_json(text: &str) -> String {
    serde_json::json!({ "message": { "content": text } }).to_string()
}

// ── clean ───────────────────────────────────────────────────────────────────

#[test]
fn clean_keeps_one_trimmed_line_and_reads_none_as_nothing() {
    assert_eq!(clean("  \"Run the whole suite\"  \nbecause…"), Some("Run the whole suite".into()));
    assert_eq!(clean("\n\nNext message: commit it\n"), Some("commit it".into()));
    assert_eq!(clean("NONE"), None);
    assert_eq!(clean(" none. "), None);
    assert_eq!(clean("`NONE`"), None);
    assert_eq!(clean("   \n  "), None);
    assert_eq!(clean("<think>hmm</think>\nPush the branch"), Some("Push the branch".into()));
    assert_eq!(clean("<think>still thinking"), None);
    let long = "a".repeat(500);
    assert_eq!(clean(&long).unwrap().chars().count(), MAX_SUGGESTION_CHARS);
    let wide = "ä".repeat(500);
    assert_eq!(clean(&wide).unwrap().chars().count(), MAX_SUGGESTION_CHARS);
}

/// What a poisoned transcript could make the model write stays one inert
/// line: no newline, no escape sequence, no control, bidi or zero-width
/// character survives to the composer.
#[test]
fn injection_shaped_output_stays_one_inert_line() {
    let hostile = "\u{1b}[2K\u{1b}]0;title\u{7}rm -rf ~\u{202e}gpj.exe\u{200b}\tnow\r\nsecond line\u{1b}[31m";
    let line = clean(hostile).expect("a line");
    assert_eq!(line, "rm -rf ~ gpj.exe now");
    assert!(!line.chars().any(|c| c.is_control() || ('\u{2000}'..='\u{206f}').contains(&c)), "{line:?}");
    assert_eq!(clean("\u{9b}31mred\u{1b}]8;;http://x\u{1b}\\link"), Some("redlink".into()));
}

// ── The append-only prompt ──────────────────────────────────────────────────

/// Every later prompt starts with every earlier one, past the budget too, and
/// the final message starts with the warm one.
#[test]
fn every_later_prompt_has_the_earlier_one_as_an_exact_prefix() {
    let budget = MIN_BUDGET_TOKENS;
    let mut entries = vec![entry("prompt", "build the feature")];
    let mut slot = None;
    let mut previous = String::new();
    for n in 0..41 {
        let kind = if n % 3 == 0 { "agent" } else { "answer" };
        entries.push(entry(kind, &format!("step {n}: {}", "words ".repeat(60))));
        let t = transcript(entries.clone());
        let turn = current_turn(&t).unwrap();
        let message = prompt_for(&mut slot, "codex", turn, budget).message().to_string();
        assert!(message.starts_with(&previous), "entry {n} broke the prefix");
        previous = message;
    }
    // Far past the budget: the late answers went one line each.
    assert!(previous.len() > budget * CHARS_PER_TOKEN, "{}", previous.len());
    assert!(previous.contains("Agent (shortened): step 38"), "{previous}");
    assert!(previous.contains("\nAgent:\nstep 1:"), "{previous}");
    // The final run adds the shortened last answer in full, after the prefix.
    let t = transcript(entries.clone());
    let turn = current_turn(&t).unwrap();
    let prompt = prompt_for(&mut slot, "codex", turn, budget);
    let last = turn.final_answer().unwrap();
    let final_messages = prompt.final_messages(Some(last));
    let [final_message] = final_messages.as_slice() else { panic!("no warm-up, one message: {final_messages:?}") };
    assert!(final_message.starts_with(&previous));
    assert!(final_message.ends_with(&format!("{}\n{TURN_SO_FAR}", last.text.trim())), "{final_message}");
}

/// Each warm-up closes the text it sent: every later request sends that text
/// as the same user messages and the rest after them, so a hybrid model's
/// checkpoint (taken just before the end of each prompt) lies inside the
/// part the next request shares.
#[test]
fn a_warm_up_closes_its_text_and_later_requests_keep_it_whole() {
    let mut entries = vec![entry("prompt", "build the feature")];
    let mut slot = None;
    let mut sent: Vec<Vec<String>> = Vec::new();
    for n in 0..4 {
        entries.push(entry("answer", &format!("step {n}")));
        let t = transcript(entries.clone());
        let messages = prompt_for(&mut slot, "codex", current_turn(&t).unwrap(), BUDGET_TOKENS).warm_messages();
        if let Some(before) = sent.last() {
            assert_eq!(&messages[..before.len()], before.as_slice(), "warm-up {n} rewrote a sent message");
            assert_eq!(messages.len(), before.len() + 1);
        }
        assert!(messages.last().unwrap().contains(&format!("step {n}")));
        sent.push(messages);
    }
    // Nothing new: the same messages again, no empty one.
    let t = transcript(entries.clone());
    let prompt = slot.as_mut().unwrap();
    assert_eq!(&prompt.warm_messages(), sent.last().unwrap());
    // Glued together they are the turn's text, unchanged.
    assert_eq!(sent.last().unwrap().concat(), prompt.message());
    // The final keeps them all and closes the turn in a message of its own.
    let finals = prompt_for(&mut slot, "codex", current_turn(&t).unwrap(), BUDGET_TOKENS).final_messages(None);
    assert_eq!(&finals[..4], sent.last().unwrap().as_slice());
    assert_eq!(finals[4], TURN_SO_FAR);
    // An entry after the last warm-up goes before that line, in the same message.
    entries.push(entry("answer", "step 4"));
    let t = transcript(entries);
    let finals = prompt_for(&mut slot, "codex", current_turn(&t).unwrap(), BUDGET_TOKENS).final_messages(None);
    assert_eq!(finals.len(), 5);
    assert!(finals[4].contains("step 4") && finals[4].ends_with(TURN_SO_FAR), "{:?}", finals[4]);
}

#[test]
fn a_rendered_entry_is_never_rendered_again() {
    let mut slot = None;
    let first = transcript(vec![entry("prompt", "p"), entry("answer", "a1")]);
    let one = prompt_for(&mut slot, "claude", current_turn(&first).unwrap(), BUDGET_TOKENS).message().to_string();
    // The same read again adds nothing.
    let again = prompt_for(&mut slot, "claude", current_turn(&first).unwrap(), BUDGET_TOKENS).message().to_string();
    assert_eq!(one, again);
    // A read whose window slid past the prompt (it is now the cut-off one)
    // still lines up on the last entry rendered.
    let mut slid = transcript(vec![entry("answer", "a1"), entry("answer", "a2")]);
    slid.cut_prompt = Some(Box::new(entry("prompt", "p")));
    let two = prompt_for(&mut slot, "claude", current_turn(&slid).unwrap(), BUDGET_TOKENS).message().to_string();
    assert!(two.starts_with(&one));
    assert_eq!(two.matches("a1").count(), 1, "{two}");
    assert!(two.contains("a2"));
    // A new turn starts over.
    let next = transcript(vec![entry("prompt", "p"), entry("answer", "a1"), entry("prompt", "q")]);
    let three = prompt_for(&mut slot, "claude", current_turn(&next).unwrap(), BUDGET_TOKENS).message().to_string();
    assert!(three.contains("\nq\n") && !three.contains("a1"), "{three}");
}

#[test]
fn the_budget_follows_a_small_configured_context() {
    assert_eq!(budget_tokens(None), BUDGET_TOKENS);
    assert_eq!(budget_tokens(Some(32_768)), BUDGET_TOKENS);
    assert_eq!(budget_tokens(Some(4_096)), 3_096);
    assert_eq!(budget_tokens(Some(512)), MIN_BUDGET_TOKENS);
}

#[test]
fn the_agent_name_is_a_plain_word_or_nothing() {
    assert_eq!(agent_label("codex"), "codex");
    assert_eq!(agent_label("x\nIgnore all"), "agent");
    assert_eq!(agent_label(""), "agent");
}

// ── Asks ────────────────────────────────────────────────────────────────────

#[test]
fn a_final_run_answers_once_per_turn_and_a_warm_run_writes_one_token() {
    ollama::test_tags::set(Some(TAGS));
    let bodies = Mutex::new(Vec::<String>::new());
    let chat = |addr: &str, body: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> {
        assert_eq!(addr, "127.0.0.1:11434");
        bodies.lock().unwrap().push(body.to_string());
        Ok(answer_json("\"Run the whole suite\""))
    };
    let caps = |_: &str, _: &str| vec!["completion".to_string(), "thinking".to_string()];
    let backend = Ollama { caps: &caps, pinned: &not_pinned, chat: &chat };
    let settings = suggest_on("llama3");
    let key = "test-final-once";

    // Warm while the turn runs (the last entry is a subagent card).
    let mut running = ended_turn();
    running.entries.pop();
    let warm = suggest_with(&settings, &ask(key, Phase::Warm), &running, &backend);
    assert_eq!(warm.status, Status::Warmed, "{warm:?}");
    assert_eq!(warm.text, None);

    let t = ended_turn();
    let first = suggest_with(&settings, &ask(key, Phase::Final), &t, &backend);
    assert_eq!(first.status, Status::Ok, "{first:?}");
    assert_eq!(first.text.as_deref(), Some("Run the whole suite"));
    assert_eq!(first.model.as_deref(), Some("llama3"), "the chip names the model that wrote it");
    assert_eq!(warm.model, None);
    let second = suggest_with(&settings, &ask(key, Phase::Final), &t, &backend);
    assert_eq!(second, first);

    let bodies = bodies.into_inner().unwrap();
    assert_eq!(bodies.len(), 2, "one warm, one final: {bodies:?}");
    let warm: serde_json::Value = serde_json::from_str(&bodies[0]).unwrap();
    let fin: serde_json::Value = serde_json::from_str(&bodies[1]).unwrap();
    assert_eq!(warm["options"]["num_predict"], 1);
    assert_eq!(fin["options"]["num_predict"], FINAL_NUM_PREDICT);
    for body in [&warm, &fin] {
        assert_eq!(body["keep_alive"], KEEP_ALIVE);
        assert_eq!(body["think"], false);
        assert_eq!(body["messages"][0]["content"], SYSTEM);
    }
    // The warm-up's message, closed, then the fixed reply and the rest.
    assert_eq!(warm["messages"].as_array().unwrap().len(), 2);
    assert_eq!(fin["messages"][1], warm["messages"][1]);
    assert_eq!(fin["messages"][2], serde_json::json!({ "role": "assistant", "content": TURN_GOES_ON }));
    assert_eq!(fin["messages"].as_array().unwrap().len(), 4);
    let final_user = fin["messages"][3]["content"].as_str().unwrap();
    assert!(final_user.contains("Want me to run the whole suite?") && final_user.ends_with(TURN_SO_FAR), "{final_user}");
    let whole = format!("{}{final_user}", warm["messages"][1]["content"].as_str().unwrap());
    assert!(!whole.contains("old answer"), "only the newest turn: {whole}");
    ollama::test_tags::set(None);
}

/// A second final for the same turn, sent while the first is still running,
/// waits for it and reads its answer; a warm-up meanwhile is `busy`.
#[test]
fn concurrent_asks_share_one_run() {
    let calls = AtomicUsize::new(0);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let entered_tx = Mutex::new(entered_tx);
    let release_rx = Mutex::new(release_rx);
    let chat = |_: &str, _: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> {
        calls.fetch_add(1, Ordering::SeqCst);
        entered_tx.lock().unwrap().send(()).unwrap();
        release_rx.lock().unwrap().recv().unwrap();
        Ok(answer_json("Commit it"))
    };
    let backend = Ollama { caps: &no_caps, pinned: &not_pinned, chat: &chat };
    let settings = suggest_on("llama3");
    let t = ended_turn();
    let key = "test-single-flight";
    std::thread::scope(|scope| {
        let run = || {
            ollama::test_tags::set(Some(TAGS));
            suggest_with(&settings, &ask(key, Phase::Final), &t, &backend)
        };
        let first = scope.spawn(run);
        entered_rx.recv().unwrap();
        let second = scope.spawn(run);
        // The slot is taken: a warm-up does not queue behind it.
        ollama::test_tags::set(Some(TAGS));
        let warm = suggest_with(&settings, &ask(key, Phase::Warm), &t, &backend);
        assert_eq!(warm.status, Status::Busy);
        release_tx.send(()).unwrap();
        let (first, second) = (first.join().unwrap(), second.join().unwrap());
        assert_eq!(first.text.as_deref(), Some("Commit it"));
        assert_eq!(second, first);
    });
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    ollama::test_tags::set(None);
}

/// Nothing of the turn is sent to a cloud model or a remote host: the refusal
/// comes before the chat request, with a reason, as a status.
#[test]
fn a_cloud_model_and_a_remote_host_are_refused_before_any_request() {
    let chat = |_: &str, _: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> { panic!("no request may be sent") };
    let caps = |_: &str, _: &str| -> Vec<String> { panic!("no probe may be sent") };
    let backend = Ollama { caps: &caps, pinned: &not_pinned, chat: &chat };
    let t = ended_turn();
    ollama::test_tags::set(Some(TAGS));
    for model in ["gpt-oss:120b-cloud", "qwen3-coder:cloud"] {
        let answer = suggest_with(&suggest_on(model), &ask("test-cloud", Phase::Final), &t, &backend);
        assert_eq!(answer.status, Status::Refused, "{model}");
        assert!(answer.reason.as_deref().unwrap().contains("cloud model"), "{answer:?}");
        assert_eq!(answer.text, None);
    }
    let mut remote = suggest_on("llama3");
    remote.ollama_host = Some("gpu-box.example:11434".into());
    remote.ollama_allow_remote_host = Some(true);
    let answer = suggest_with(&remote, &ask("test-remote", Phase::Warm), &t, &backend);
    assert_eq!(answer.status, Status::Refused);
    assert_eq!(answer.reason.as_deref(), Some(REMOTE_REFUSED));
    // An unlisted model fails closed; nothing answering is `not_running`.
    let answer = suggest_with(&suggest_on("mistral"), &ask("test-unlisted", Phase::Final), &t, &backend);
    assert_eq!(answer.status, Status::Refused);
    ollama::test_tags::set(None);
    let answer = suggest_with(&suggest_on("llama3"), &ask("test-down", Phase::Final), &t, &backend);
    assert_eq!(answer.status, Status::NotRunning);
    assert_eq!(answer.reason, None);
}

#[test]
fn asks_with_nothing_to_do_are_skipped_without_a_request() {
    let chat = |_: &str, _: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> { panic!("no request may be sent") };
    let caps = |_: &str, _: &str| -> Vec<String> { panic!("no probe may be sent") };
    let backend = Ollama { caps: &caps, pinned: &not_pinned, chat: &chat };
    let settings = suggest_on("llama3");
    // A local-model tab's agent owns the GPU: never warmed.
    let local = Ask { local_model: true, ..ask("test-skip", Phase::Warm) };
    assert_eq!(suggest_with(&settings, &local, &ended_turn(), &backend).status, Status::Skipped);
    // No turn yet.
    let empty = transcript(vec![]);
    assert_eq!(suggest_with(&settings, &ask("test-skip", Phase::Warm), &empty, &backend).status, Status::Skipped);
    // A turn that has not ended on an answer.
    let open = transcript(vec![entry("prompt", "go"), entry("agent", "Explore")]);
    assert_eq!(suggest_with(&settings, &ask("test-skip", Phase::Final), &open, &backend).status, Status::Skipped);
    let mut waiting = ended_turn();
    waiting.entries.last_mut().unwrap().blocking = true;
    assert_eq!(suggest_with(&settings, &ask("test-skip", Phase::Final), &waiting, &backend).status, Status::Skipped);
    // No transcript: unavailable for a final, skipped for a warm-up.
    let gone = AgentTranscript::unavailable("no_transcript");
    assert_eq!(suggest_with(&settings, &ask("test-skip", Phase::Final), &gone, &backend).status, Status::Unavailable);
    assert_eq!(suggest_with(&settings, &ask("test-skip", Phase::Warm), &gone, &backend).status, Status::Skipped);
    // No model at all.
    let none = suggest_with(&Settings::default(), &ask("test-skip", Phase::Final), &ended_turn(), &backend);
    assert_eq!(none.status, Status::NoModel);
    assert_eq!(none.reason.as_deref(), Some(NO_MODEL));
    // The AI switch is off.
    let off = Settings { ai_off: Some(true), ..suggest_on("llama3") };
    assert_eq!(suggest_with(&off, &ask("test-skip", Phase::Final), &ended_turn(), &backend).status, Status::Unavailable);
}

#[test]
fn a_model_the_user_unloaded_is_not_loaded_back() {
    let chat = |_: &str, _: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> { panic!("no request may be sent") };
    let caps = |_: &str, _: &str| -> Vec<String> { panic!("no probe may be sent") };
    let backend = Ollama { caps: &caps, pinned: &not_pinned, chat: &chat };
    // A name no other test uses: the hold is process-wide.
    let settings = suggest_on("held-by-unload");
    ollama::hold_unloaded("held-by-unload:latest");
    let mut running = ended_turn();
    running.entries.pop();
    for (phase, turn) in [(Phase::Warm, &running), (Phase::Final, &ended_turn())] {
        let answer = suggest_with(&settings, &ask("test-held", phase), turn, &backend);
        assert_eq!(answer.status, Status::Skipped, "{phase:?}");
    }
    let draft = complete("test-held", "run the whole ");
    assert_eq!(suggest_with(&settings, &draft, &ended_turn(), &backend).status, Status::Skipped);
    ollama::release_hold("held-by-unload");
    assert!(!ollama::is_held("held-by-unload"));
}

#[test]
fn the_role_wins_over_the_default_model() {
    let mut settings = suggest_on(" qwen3:4b ");
    settings.ollama_model = Some("llama3".into());
    assert_eq!(suggest_model_from(&settings).as_deref(), Some("qwen3:4b"));
    settings.ollama_roles = Some([(ROLE.to_string(), " ".to_string())].into_iter().collect());
    assert_eq!(suggest_model_from(&settings).as_deref(), Some("llama3"));
    assert_eq!(suggest_model_from(&Settings::default()), None);
}

#[test]
fn the_answer_serializes_to_the_contract() {
    let answer = NextPrompt { text: None, turn_key: Some("k".into()), status: Status::NotRunning, reason: None, model: None };
    assert_eq!(serde_json::to_value(&answer).unwrap(), serde_json::json!({ "text": null, "turnKey": "k", "status": "not_running" }));
    let refused = NextPrompt::refused(Status::NoModel, "why".into());
    assert_eq!(serde_json::to_value(&refused).unwrap(), serde_json::json!({ "text": null, "turnKey": null, "status": "no_model", "reason": "why" }));
    let ok = NextPrompt::answered(Some("Run it".into()), "qwen3:4b", "k");
    assert_eq!(
        serde_json::to_value(&ok).unwrap(),
        serde_json::json!({ "text": "Run it", "turnKey": "k", "status": "ok", "model": "qwen3:4b" })
    );
    // The model said NONE: nothing to credit.
    assert_eq!(NextPrompt::answered(None, "qwen3:4b", "k").model, None);
}

/// A tab Tabtivity mints no launch id for (a local-model tab, OpenCode,
/// Antigravity, Muse) reads its session by its folder, as the Chat view does:
/// it must get a session of its own, not `unavailable` on every ask.
#[test]
fn a_tab_without_a_launch_id_is_named_by_its_folder() {
    let local = desktop_key("pi", Some("p1"), "", Some("/work/a"), Some(10), None);
    assert!(local.is_some(), "a local-model tab without a session id still asks");
    let other_folder = desktop_key("pi", Some("p1"), "", Some("/work/b"), Some(10), None);
    let other_launch = desktop_key("pi", Some("p1"), "", Some("/work/a"), Some(11), None);
    assert_ne!(local, other_folder);
    assert_ne!(local, other_launch);
    assert!(desktop_key("codex", Some("p1"), "uid-1", None, None, None).is_some());
    assert_eq!(desktop_key("codex", Some("p1"), "", None, None, None), None, "named by nothing");
    assert_eq!(desktop_key("codex", None, &"x".repeat(MAX_KEY_CHARS), None, None, None), None);
}

/// A request's `keep_alive` replaces the model's expiry: it must never cut
/// short a longer `ollama_keep_alive`, an infinite one, or a model the user
/// pinned with Load.
#[test]
fn the_keep_alive_never_shortens_the_users_choice() {
    use serde_json::json;
    assert_eq!(keep_alive_for(None, false), json!(KEEP_ALIVE));
    assert_eq!(keep_alive_for(Some("30m"), false), json!(KEEP_ALIVE));
    assert_eq!(keep_alive_for(Some("1h"), false), json!("1h"));
    assert_eq!(keep_alive_for(Some(" -1 "), false), json!(-1));
    assert_eq!(keep_alive_for(Some("30m"), true), json!(-1));

    let now = chrono::DateTime::parse_from_rfc3339("2026-11-22T12:00:00Z").unwrap().with_timezone(&chrono::Utc);
    let ps = r#"{"models":[
        {"name":"llama3:latest","expires_at":"2318-03-01T10:00:00+01:00"},
        {"name":"qwen3:4b","expires_at":"2026-11-22T12:20:00Z"}
    ]}"#;
    assert!(pinned_in_ps(ps, "llama3", now));
    assert!(pinned_in_ps(ps, "llama3:latest", now));
    assert!(!pinned_in_ps(ps, "qwen3:4b", now), "a countdown is not a pin");
    assert!(!pinned_in_ps(ps, "mistral", now));
    assert!(!pinned_in_ps("not json", "llama3", now));

    // Through an ask: an infinite setting reaches the request.
    ollama::test_tags::set(Some(TAGS));
    let body = Mutex::new(String::new());
    let chat = |_: &str, sent: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> {
        *body.lock().unwrap() = sent.to_string();
        Ok(answer_json("Commit it"))
    };
    let pinned = |_: &str, _: &str| true;
    let settings = Settings { ollama_keep_alive: Some("-1".into()), ..suggest_on("llama3") };
    let backend = Ollama { caps: &no_caps, pinned: &not_pinned, chat: &chat };
    assert_eq!(suggest_with(&settings, &ask("test-keep-alive", Phase::Final), &ended_turn(), &backend).status, Status::Ok);
    let sent: serde_json::Value = serde_json::from_str(&body.lock().unwrap()).unwrap();
    assert_eq!(sent["keep_alive"], -1);
    let backend = Ollama { caps: &no_caps, pinned: &pinned, chat: &chat };
    assert_eq!(suggest_with(&suggest_on("llama3"), &ask("test-keep-alive-pin", Phase::Warm), &ended_turn(), &backend).status, Status::Warmed);
    let sent: serde_json::Value = serde_json::from_str(&body.lock().unwrap()).unwrap();
    assert_eq!(sent["keep_alive"], -1, "a pinned model stays pinned");
    ollama::test_tags::set(None);
}

#[test]
fn a_final_ends_a_warm_up_in_flight_instead_of_waiting_behind_it() {
    use std::sync::atomic::AtomicBool;
    let calls = AtomicUsize::new(0);
    let warm_started = AtomicBool::new(false);
    // The first request is the warm-up: it hangs until it is aborted (or five
    // seconds pass, which fails the test). The second is the final.
    let chat = |_: &str, _: &str, _: Duration, abort: &ollama::Abort| -> Result<String, String> {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            warm_started.store(true, Ordering::SeqCst);
            let until = Instant::now() + Duration::from_secs(5);
            while !abort.is_aborted() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
            return if abort.is_aborted() { Err(ollama::ABORTED.to_string()) } else { Ok(answer_json("\"\"")) };
        }
        Ok(answer_json("\"Run the whole suite\""))
    };
    let backend = Ollama { caps: &no_caps, pinned: &not_pinned, chat: &chat };
    let settings = suggest_on("llama3");
    let key = "test-final-ends-warm";
    let mut running = ended_turn();
    running.entries.pop();
    let ended = ended_turn();

    let (warm, final_answer, waited) = std::thread::scope(|s| {
        let warm = s.spawn(|| {
            ollama::test_tags::set(Some(TAGS));
            suggest_with(&settings, &ask(key, Phase::Warm), &running, &backend)
        });
        while !warm_started.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        ollama::test_tags::set(Some(TAGS));
        let started = Instant::now();
        let final_answer = suggest_with(&settings, &ask(key, Phase::Final), &ended, &backend);
        (warm.join().unwrap(), final_answer, started.elapsed())
    });
    assert_eq!(warm.status, Status::Skipped, "{warm:?}");
    assert_eq!(final_answer.status, Status::Ok, "{final_answer:?}");
    assert_eq!(final_answer.text.as_deref(), Some("Run the whole suite"));
    assert!(waited < Duration::from_secs(2), "the final waited {waited:?} behind the warm-up");
}

#[test]
fn a_model_name_crosses_as_one_inert_capped_line() {
    assert_eq!(clean_model(" qwen3:4b ").as_deref(), Some("qwen3:4b"));
    assert_eq!(clean_model("a\nb\u{202e}c\u{1b}[31m").as_deref(), Some("a b c"));
    assert_eq!(clean_model(&"m".repeat(300)).map(|m| m.chars().count()), Some(MAX_MODEL_CHARS));
    assert_eq!(clean_model(" \u{200b} "), None);
}

// ── Completing a draft ──────────────────────────────────────────────────────

#[test]
fn a_draft_is_completed_from_its_last_words_once_it_has_a_finished_word() {
    assert_eq!(draft_tail("run the tests and"), Some("run the tests and".into()));
    assert_eq!(draft_tail("  jetzt   noch  "), Some("jetzt noch".into()), "spaces folded, the ends trimmed");
    assert_eq!(draft_tail("two things:\n1. cap it\n2. add a "), Some("2. add a".into()), "the last line only");
    // Not completed: one unfinished word, a command, a blank last line, nothing.
    assert_eq!(draft_tail("run"), None);
    assert_eq!(draft_tail("/model opus now"), None);
    assert_eq!(draft_tail("  /clear it"), None);
    assert_eq!(draft_tail("first line\n"), None);
    assert_eq!(draft_tail("first line\n   "), None);
    assert_eq!(draft_tail(""), None);
    // A lone word on a later line is still completed: the draft has others.
    assert_eq!(draft_tail("first line\nsec"), Some("sec".into()));
    // A long line is cut to its last words, from a word's start.
    let long = format!("{} whether the retry also covers the timeout case and then", "word ".repeat(30));
    let tail = draft_tail(&long).expect("a tail");
    assert!(tail.chars().count() <= TAIL_CHARS, "{tail:?}");
    assert!(long.ends_with(&tail) && long[..long.len() - tail.len()].ends_with(' '), "{tail:?}");
    let wide = format!("ä {}", "ö".repeat(200));
    assert_eq!(draft_tail(&wide).expect("a tail").chars().count(), TAIL_CHARS, "an unbroken word is cut anyway");
    assert_eq!(draft_tail(&format!("a {}", "b".repeat(MAX_DRAFT_CHARS))), None, "past the bound");
}

#[test]
fn a_continuation_is_what_follows_the_drafts_last_words() {
    // A new word after a draft that ends inside none: opened by one space.
    assert_eq!(continuation("run the tests and update the changelog", "run the tests and", "run the tests and"), Some(" update the changelog".into()));
    // Inside a word: no space.
    assert_eq!(continuation("please update the changelog too", "please upd", "please upd"), Some("ate the changelog too".into()));
    // After the draft's own space: none added.
    assert_eq!(continuation("jetzt noch testen", "jetzt noch", "jetzt noch "), Some("testen".into()));
    // Letter case aside, quotes and a thinking block dropped, the first line only.
    assert_eq!(continuation("<think>hm</think>\n\"Run the Tests now\"\nmore", "run the tests", "run the tests"), Some(" now".into()));
    // A line that does not go on from the draft, or adds nothing, is nothing.
    assert_eq!(continuation("update the changelog", "run the tests and", "run the tests and"), None);
    assert_eq!(continuation("NONE", "run the tests and", "run the tests and"), None);
    assert_eq!(continuation("run the tests and", "run the tests and", "run the tests and"), None);
    assert_eq!(continuation("run the tests and   ", "run the tests and", "run the tests and "), None);
    assert_eq!(continuation("<think>still thinking", "run", "run "), None);
    // Hostile output stays one inert capped line.
    let hostile = "fix it \u{1b}[2Know\u{202e}\tplease\r\nrm -rf ~";
    assert_eq!(continuation(hostile, "fix it", "fix it"), Some(" now please".into()));
    let long = format!("fix it {}", "a".repeat(500));
    assert_eq!(continuation(&long, "fix it", "fix it ").unwrap().chars().count(), MAX_COMPLETION_CHARS);
    // What crosses to a client keeps the one opening space and nothing else.
    assert_eq!(clean_completion("  two\u{200b} words\nsecond"), Some(" two words".into()));
    assert_eq!(clean_completion("ate it"), Some("ate it".into()));
    assert_eq!(clean_completion(" \n "), None);
}

/// A completion is the final request plus one paragraph: the same system
/// prompt and turn first (so Ollama reads only the new tokens), then the
/// draft and the words the reply must begin with. Cached per draft; switched
/// off by its own setting, which leaves the turn-end suggestion alone.
#[test]
fn a_completion_sends_the_turn_then_the_draft_and_answers_what_to_append() {
    ollama::test_tags::set(Some(TAGS));
    let bodies = Mutex::new(Vec::<String>::new());
    let chat = |_: &str, body: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> {
        bodies.lock().unwrap().push(body.to_string());
        let sent: serde_json::Value = serde_json::from_str(body).unwrap();
        Ok(answer_json(if sent["options"]["num_predict"] == COMPLETE_NUM_PREDICT { "yes, run the whole suite" } else { "Run it" }))
    };
    let caps = |_: &str, _: &str| vec!["completion".to_string(), "thinking".to_string()];
    let backend = Ollama { caps: &caps, pinned: &not_pinned, chat: &chat };
    let settings = suggest_on("llama3");
    let key = "test-complete";
    let t = ended_turn();

    let fin = suggest_with(&settings, &ask(key, Phase::Final), &t, &backend);
    assert_eq!(fin.text.as_deref(), Some("Run it"));
    let first = suggest_with(&settings, &complete(key, "yes, run the"), &t, &backend);
    assert_eq!(first.status, Status::Ok, "{first:?}");
    assert_eq!(first.text.as_deref(), Some(" whole suite"));
    assert_eq!(first.model.as_deref(), Some("llama3"));
    // The same draft again runs no model; another draft does.
    assert_eq!(suggest_with(&settings, &complete(key, "yes, run the"), &t, &backend), first);
    let other = suggest_with(&settings, &complete(key, "no, wait "), &t, &backend);
    assert_eq!((other.status, other.text), (Status::Ok, None), "the reply did not go on from that draft");
    // Asking for the turn's suggestion still answers from its own cache.
    assert_eq!(suggest_with(&settings, &ask(key, Phase::Final), &t, &backend), fin);

    let bodies = bodies.into_inner().unwrap();
    assert_eq!(bodies.len(), 3, "one final, two completions: {bodies:?}");
    let fin: serde_json::Value = serde_json::from_str(&bodies[0]).unwrap();
    let done: serde_json::Value = serde_json::from_str(&bodies[1]).unwrap();
    assert_eq!(done["options"]["num_predict"], COMPLETE_NUM_PREDICT);
    assert_eq!(done["think"], false);
    assert_eq!(done["messages"][0]["content"], SYSTEM);
    // The final's messages byte for byte, closed, then its suggestion as the
    // model's reply and the draft as a second user message: a hybrid model
    // restores only a checkpoint taken inside the final's assistant opener.
    assert_eq!(fin["messages"].as_array().unwrap().len(), 2);
    assert_eq!(done["messages"][1], fin["messages"][1]);
    assert_eq!(done["messages"][2], serde_json::json!({ "role": "assistant", "content": "Run it" }));
    assert_eq!(done["messages"][3]["role"], "user");
    let complete_user = done["messages"][3]["content"].as_str().unwrap();
    assert_eq!(complete_user, "The user has begun typing that next message. What they typed so far:\nyes, run the\n\nReply with only how the message goes on, as one line that begins with exactly this text:\nyes, run the\n");
    assert_eq!(done["messages"].as_array().unwrap().len(), 4);

    // Nothing to complete, or switched off: no request.
    let sent = AtomicUsize::new(0);
    let never = |_: &str, _: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> {
        sent.fetch_add(1, Ordering::SeqCst);
        Ok(answer_json("x"))
    };
    let backend = Ollama { caps: &no_caps, pinned: &not_pinned, chat: &never };
    for draft in ["yes", "/model opus now", "line\n"] {
        assert_eq!(suggest_with(&settings, &complete("test-complete-none", draft), &t, &backend).status, Status::Skipped, "{draft:?}");
    }
    assert_eq!(suggest_with(&settings, &ask("test-complete-none", Phase::Complete), &t, &backend).status, Status::Skipped, "no draft at all");
    let off = Settings { prompt_autocomplete: Some(false), ..suggest_on("llama3") };
    assert_eq!(suggest_with(&off, &complete("test-complete-none", "yes, run the"), &t, &backend).status, Status::Unavailable);
    assert_eq!(complete_kept_with(&off, &complete("test-complete-none", "yes, run the"), &backend).map(|a| a.status), Some(Status::Unavailable));
    assert_eq!(sent.load(Ordering::SeqCst), 0);
    // The turn-end suggestion does not read that switch.
    assert_eq!(suggest_with(&off, &ask("test-complete-none", Phase::Final), &t, &backend).status, Status::Ok);
    assert_eq!(sent.load(Ordering::SeqCst), 1);
    ollama::test_tags::set(None);
}

/// A completion's turn need not have ended (a prompt typed to queue while
/// the agent works), and the ended turn an ask read is kept: the next
/// completions go on from it without the transcript.
#[test]
fn a_completion_goes_on_from_the_kept_turn_without_the_transcript() {
    ollama::test_tags::set(Some(TAGS));
    let bodies = Mutex::new(Vec::<String>::new());
    let chat = |_: &str, body: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> {
        bodies.lock().unwrap().push(body.to_string());
        Ok(answer_json("and then commit it"))
    };
    let backend = Ollama { caps: &no_caps, pinned: &not_pinned, chat: &chat };
    let settings = suggest_on("llama3");
    let key = "test-complete-kept";

    // Nothing read yet: the caller has to read the transcript.
    assert_eq!(complete_kept_with(&settings, &complete(key, "and then"), &backend), None);
    // A draft that is not completed is answered at once all the same.
    assert_eq!(complete_kept_with(&settings, &complete(key, "and"), &backend).map(|a| a.status), Some(Status::Skipped));
    assert_eq!(complete_kept_with(&settings, &ask(key, Phase::Final), &backend), None, "only a completion is answered from the kept turn");

    // A running turn is completed, and not kept: its next read differs.
    let mut running = ended_turn();
    running.entries.pop();
    let mid = suggest_with(&settings, &complete(key, "and then"), &running, &backend);
    assert_eq!((mid.status, mid.text.as_deref()), (Status::Ok, Some(" commit it")), "{mid:?}");
    assert_eq!(complete_kept_with(&settings, &complete(key, "and then "), &backend), None);

    // An ended turn is kept by the ask that read it.
    let t = ended_turn();
    let read = suggest_with(&settings, &complete(key, "and then"), &t, &backend);
    assert_eq!(read.text.as_deref(), Some(" commit it"));
    let kept = complete_kept_with(&settings, &complete(key, "and then "), &backend).expect("the kept turn answers");
    assert_eq!((kept.status, kept.text.as_deref()), (Status::Ok, Some("commit it")), "{kept:?}");
    assert_eq!(kept.turn_key, read.turn_key);

    let bodies = bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 3, "{bodies:?}");
    let message = |at: usize, of: usize| serde_json::from_str::<serde_json::Value>(&bodies[at]).unwrap()["messages"][of]["content"].as_str().unwrap().to_string();
    assert!(!message(0, 1).contains("Want me to run the whole suite?"), "the running turn has no last answer yet");
    let (read_turn, kept_turn) = (message(1, 1), message(2, 1));
    assert!(read_turn.contains("Want me to run the whole suite?"));
    assert_eq!(kept_turn, read_turn, "the kept turn is the message read");
    assert_eq!(message(2, 2), "NONE", "no suggestion was written for the turn");
    assert!(message(2, 3).contains("typed so far:\nand then\n"), "{}", message(2, 3));

    // Past its time the kept turn is read again.
    {
        let slot = session(key);
        let mut state = slot.state.lock().unwrap();
        let kept = state.ended.as_mut().expect("kept");
        kept.0 = Instant::now().checked_sub(KEPT_FOR + Duration::from_secs(1)).expect("an earlier instant");
    }
    assert_eq!(complete_kept_with(&settings, &complete(key, "and then now "), &backend), None);
    ollama::test_tags::set(None);
}

/// The newest draft wins: a completion ends an older one in flight instead of
/// waiting behind it.
#[test]
fn a_newer_completion_ends_an_older_one_in_flight() {
    use std::sync::atomic::AtomicBool;
    let calls = AtomicUsize::new(0);
    let first_started = AtomicBool::new(false);
    let chat = |_: &str, _: &str, _: Duration, abort: &ollama::Abort| -> Result<String, String> {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            first_started.store(true, Ordering::SeqCst);
            let until = Instant::now() + Duration::from_secs(5);
            while !abort.is_aborted() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
            return if abort.is_aborted() { Err(ollama::ABORTED.to_string()) } else { Ok(answer_json("run the old thing")) };
        }
        Ok(answer_json("run the whole suite"))
    };
    let backend = Ollama { caps: &no_caps, pinned: &not_pinned, chat: &chat };
    let settings = suggest_on("llama3");
    let key = "test-complete-newest";
    let t = ended_turn();

    let (older, newer, waited) = std::thread::scope(|s| {
        let older = s.spawn(|| {
            ollama::test_tags::set(Some(TAGS));
            suggest_with(&settings, &complete(key, "run the"), &t, &backend)
        });
        while !first_started.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        ollama::test_tags::set(Some(TAGS));
        let started = Instant::now();
        let newer = suggest_with(&settings, &complete(key, "run the whole"), &t, &backend);
        (older.join().unwrap(), newer, started.elapsed())
    });
    assert_eq!(older.status, Status::Skipped, "{older:?}");
    assert_eq!((newer.status, newer.text.as_deref()), (Status::Ok, Some(" suite")), "{newer:?}");
    assert!(waited < Duration::from_secs(2), "the newer draft waited {waited:?} behind the older one");
}
