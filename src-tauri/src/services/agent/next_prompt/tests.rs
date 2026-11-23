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
    Ask { key, agent: "codex", phase, local_model: false }
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
    let final_message = prompt.final_message(Some(last));
    assert!(final_message.starts_with(&previous));
    assert!(final_message.ends_with(&format!("{}\n", last.text.trim())), "{final_message}");
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
    let warm_user = warm["messages"][1]["content"].as_str().unwrap();
    let final_user = fin["messages"][1]["content"].as_str().unwrap();
    assert!(final_user.starts_with(warm_user), "{warm_user:?} / {final_user:?}");
    assert!(final_user.contains("Want me to run the whole suite?"));
    assert!(!final_user.contains("old answer"), "only the newest turn: {final_user}");
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
    let answer = NextPrompt { text: None, turn_key: Some("k".into()), status: Status::NotRunning, reason: None };
    assert_eq!(serde_json::to_value(&answer).unwrap(), serde_json::json!({ "text": null, "turnKey": "k", "status": "not_running" }));
    let refused = NextPrompt::refused(Status::NoModel, "why".into());
    assert_eq!(serde_json::to_value(&refused).unwrap(), serde_json::json!({ "text": null, "turnKey": null, "status": "no_model", "reason": "why" }));
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
