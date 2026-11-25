use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const TAGS: &str = r#"{"models":[
    {"name":"llama3:latest","size":1},
    {"name":"gpt-oss:120b-cloud","remote_model":"gpt-oss:120b","remote_host":"https://ollama.com:443"}
]}"#;

fn on() -> Settings {
    let mut roles = HashMap::new();
    roles.insert("mail".to_string(), "llama3".to_string());
    Settings { ollama_roles: Some(roles), mail_ai_allow: Some(true), ..Default::default() }
}

fn account() -> Account {
    Account { name: "Ada Lovelace".into(), signature: Some("Ada\nAnalytical Engines Ltd".into()), autocomplete: true }
}

fn original() -> Original {
    Original::new("m1", "Slides for Friday", "Bob <bob@example.org>", Some("Hi Ada,\nplease send the slides.\n\n> older quote\n-- \nBob's signature"))
}

fn answer_json(text: &str) -> String {
    serde_json::json!({ "message": { "content": text } }).to_string()
}

fn caps_ok(_: &str, _: &str) -> Vec<String> {
    vec!["completion".into()]
}

fn not_pinned(_: &str, _: &str) -> bool {
    false
}

fn ask<'a>(slot: &'a str, draft: Option<&'a str>) -> Ask<'a> {
    Ask { slot, message_id: Some("m1"), subject: "", to: &[], draft }
}

/// A gate run with open probes, recording the order they were asked in.
fn gate_with(slots: &Slots, settings: &Settings, ask: &Ask<'_>, log: &Mutex<Vec<&'static str>>, locked: bool, acct: Result<Account, ()>) -> Gated {
    let store = || {
        log.lock().unwrap().push("store");
        Ok(locked)
    };
    let account = || {
        log.lock().unwrap().push("account");
        acct.clone()
    };
    let caps = |_: &str, _: &str| {
        log.lock().unwrap().push("caps");
        vec!["completion".to_string()]
    };
    let chat = |_: &str, _: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> { panic!("no request in a gate") };
    let backend = Ollama { caps: &caps, pinned: &not_pinned, chat: &chat };
    ollama::test_tags::set(Some(TAGS));
    slots.gate(settings, ask, &Probes { store_locked: &store, account: &account }, &backend, Instant::now())
}

fn done(gated: Gated) -> MailComplete {
    match gated {
        Gated::Done(answer) => answer,
        Gated::Ready(_) => panic!("expected an answer, got a ready request"),
    }
}

fn ready(gated: Gated) -> Ready {
    match gated {
        Gated::Ready(ready) => *ready,
        Gated::Done(answer) => panic!("expected a ready request, got {answer:?}"),
    }
}

// ── The prompt ──────────────────────────────────────────────────────────────

/// The context is its own message and byte-identical across drafts: that is
/// what lets Ollama's checkpoint keep it across keystrokes.
#[test]
fn the_context_message_is_identical_across_two_drafts_and_the_draft_goes_last() {
    let acct = account();
    let original = original();
    let context = context_block(&acct, Some(&original), "", "");
    let a = shape_draft("Thanks for the slides and I'll").unwrap();
    let b = shape_draft("Thanks for the slides and I'll send them over soon, so").unwrap();
    let one = complete_messages(&context, &a.text, &a.tail);
    let two = complete_messages(&context, &b.text, &b.tail);
    let roles: Vec<&str> = one.iter().map(|(role, _)| *role).collect();
    assert_eq!(roles, ["system", "user", "assistant", "user"]);
    assert_eq!(one[0].1, COMPLETE_SYSTEM);
    assert_eq!(one[1].1, two[1].1, "the context must not depend on the draft");
    assert_eq!(one[2].1, "OK");
    assert_ne!(one[3].1, two[3].1);
    assert!(one[3].1.contains("Thanks for the slides and I'll"));
    assert!(one[3].1.ends_with("begins with exactly this text:\nThanks for the slides and I'll\n"), "{}", one[3].1);
    // The warm-up is the prefix a completion extends.
    let warm = warm_messages(&context);
    assert_eq!(warm.len(), 2);
    assert_eq!(warm[..], one[..2]);
    let text = &one[1].1;
    assert!(text.contains("Ada Lovelace"), "{text}");
    assert!(text.contains("Analytical Engines Ltd"), "{text}");
    assert!(text.contains("Subject: Slides for Friday"), "{text}");
    assert!(text.contains("From: Bob <bob@example.org>"), "{text}");
    assert!(text.contains("please send the slides."), "{text}");
}

#[test]
fn the_original_is_cleaned_the_quote_and_the_signature_are_cut() {
    let body = "Hi\u{202e} Ada,\u{1b}[31m\n\n\n\nsecond   paragraph\n> quoted line\n  > indented quote\nstill here\n-- \nBob\nsecret signature";
    let original = Original::new("m", "Sub\u{200b}ject\nline two", "Eve\u{0}<e@x>", Some(body));
    assert_eq!(original.subject, "Sub ject line two");
    assert!(!original.from.contains('\u{0}'));
    let kept = original.body.as_deref().unwrap();
    assert_eq!(kept, "Hi Ada, [31m\n\nsecond paragraph\nstill here");
    assert!(!kept.contains("quoted") && !kept.contains("secret"), "{kept:?}");
    assert!(!kept.chars().any(|c| c.is_control() && c != '\n'), "{kept:?}");
    // Bounded.
    let long = "word ".repeat(2_000);
    assert!(Original::new("m", "s", "f", Some(&long)).body.unwrap().chars().count() <= BODY_CHARS);
}

/// D6: an original that arrived encrypted gives the model its headers and a
/// note, never a body.
#[test]
fn an_encrypted_original_shows_the_model_no_body() {
    let secret = Original::new("m1", "Contract", "Bob <bob@example.org>", None);
    assert_eq!(secret.body, None);
    let block = context_block(&account(), Some(&secret), "", "");
    assert!(block.contains("Subject: Contract"), "{block}");
    assert!(block.contains(ENCRYPTED_NOTE), "{block}");
    let plain = context_block(&account(), Some(&original()), "", "");
    assert!(!plain.contains(ENCRYPTED_NOTE));
}

#[test]
fn a_new_mail_shows_subject_and_recipients_only() {
    let block = context_block(&account(), None, "Lunch?", "a@example.org, b@example.org");
    assert!(block.contains("A new mail."), "{block}");
    assert!(block.contains("Subject: Lunch?\nTo: a@example.org, b@example.org\n"), "{block}");
    assert!(!block.contains("The mail being answered"));
}

#[test]
fn the_signature_and_name_are_bounded_and_optional() {
    let acct = Account { name: "N".repeat(500), signature: Some("s".repeat(2_000)), autocomplete: true };
    let block = context_block(&acct, None, "x", "y");
    assert!(block.chars().count() < 800, "{}", block.chars().count());
    let bare = Account { name: " ".into(), signature: Some("  ".into()), autocomplete: true };
    let block = context_block(&bare, None, "x", "y");
    assert!(!block.contains("written by") && !block.contains("signature"), "{block}");
}

// ── The draft ───────────────────────────────────────────────────────────────

#[test]
fn the_draft_is_cut_at_the_first_quote_line() {
    assert_eq!(above_quote("Thanks for the slides\n\n> Bob wrote:\n> hi"), "Thanks for the slides\n\n");
    assert_eq!(above_quote("> only a quote"), "");
    assert_eq!(above_quote("a > b is true"), "a > b is true");
    assert_eq!(above_quote("line one\n  > line two"), "line one\n");
    // A quote-only draft has nothing to complete.
    assert_eq!(shape_draft("> Bob wrote:\n> secret"), None);
    // The quote is cut before anything is shaped: a quoted body never reaches
    // the model, and what is left ends on a blank line, so nothing is completed.
    assert_eq!(above_quote("Thanks for the slides and\n> the secret original body"), "Thanks for the slides and\n");
    assert_eq!(shape_draft("Thanks for the slides and\n> the secret original body"), None);
    // A quote line past 2000 characters of text is still cut first.
    let draft = shape_draft(&format!("{}Thanks for the\n> secret", "x ".repeat(1_500).replace("x ", "x\n"))).map(|d| d.text);
    assert_eq!(draft, None);
}

#[test]
fn a_long_draft_is_windowed_at_a_line_start_else_a_word() {
    let lines: String = (0..400).map(|n| format!("line number {n} goes here\n")).collect();
    let draft = format!("{lines}and then we");
    let shaped = shape_draft(&draft).unwrap();
    assert!(shaped.text.chars().count() <= MAX_DRAFT_CHARS);
    assert!(shaped.text.starts_with("line number "), "{:?}", &shaped.text[..20]);
    assert!(shaped.text.ends_with("and then we"));
    // No newline: a word's start.
    let one_line = format!("{} end of it", "word ".repeat(1_000));
    let shaped = shape_draft(&one_line).unwrap();
    assert!(shaped.text.chars().count() <= MAX_DRAFT_CHARS);
    assert!(shaped.text.starts_with("word "), "a word's start, not its middle: {:?}", &shaped.text[..8]);
    // Not completable: no finished word, a blank last line, a command.
    for draft in ["Thanks", "Thanks for the slides\n", "/help me now", "", "   "] {
        assert_eq!(shape_draft(draft), None, "{draft:?}");
    }
    assert!(shape_draft("Thanks for").is_some());
}

#[test]
fn a_slot_name_is_a_short_token() {
    assert!(valid_slot("mail-0123456789ab"));
    assert!(valid_slot("phone"));
    assert!(valid_slot(&"a".repeat(64)));
    for bad in ["", "a b", "a/b", "../x", "é", &"a".repeat(65)] {
        assert!(!valid_slot(bad), "{bad:?}");
    }
}

// ── The output ──────────────────────────────────────────────────────────────

#[test]
fn the_sentence_ends_at_the_first_terminator_followed_by_space_or_the_end() {
    assert_eq!(cut_sentence(" send it today. Then we meet"), " send it today.");
    assert_eq!(cut_sentence(" are you free? Or not"), " are you free?");
    assert_eq!(cut_sentence(" great news! Thanks"), " great news!");
    assert_eq!(cut_sentence(" no end here"), " no end here");
    assert_eq!(cut_sentence(" done."), " done.");
    // A number's point, an abbreviation, a dotted word do not end it.
    assert_eq!(cut_sentence(" version 3.5 is out. Next"), " version 3.5 is out.");
    assert_eq!(cut_sentence(" on a day, e.g. Monday. Next"), " on a day, e.g. Monday.");
    assert_eq!(cut_sentence(" see Dr. Smith today. Next"), " see Dr. Smith today.");
    assert_eq!(cut_sentence(" at 5 p.m. tomorrow. Bye"), " at 5 p.m. tomorrow.");
    assert_eq!(cut_sentence(" mail me at bob@example.org or call. Bye"), " mail me at bob@example.org or call.");
    assert_eq!(cut_sentence(" wait... then go. Bye"), " wait...");
}

#[test]
fn the_cap_is_a_word_boundary() {
    let words = "alpha ".repeat(40);
    let capped = cap_at_word(&format!(" {words}"), 100);
    assert!(capped.chars().count() <= 100, "{capped:?}");
    assert!(capped.ends_with("alpha"), "{capped:?}");
    assert_eq!(cap_at_word(" short line", 100), " short line");
    // Exactly on a boundary keeps the whole last word.
    let exact = format!("{} {}", "a".repeat(49), "b".repeat(50));
    assert_eq!(cap_at_word(&format!("{exact} tail"), 100), exact);
    // One huge word is nothing to show.
    assert_eq!(cap_at_word(&"x".repeat(300), 100), "");
}

#[test]
fn a_link_in_the_continuation_drops_the_whole_suggestion() {
    let tail = "Please use";
    let draft = "Thanks. Please use";
    assert_eq!(completion_text("Please use the form", tail, draft).as_deref(), Some(" the form"));
    for line in ["Please use https://evil.example/x", "Please use HTTP://evil.example", "Please use www.evil.example now", "Please use ftp://x"] {
        assert_eq!(completion_text(line, tail, draft), None, "{line}");
    }
    // A line that does not go on from the draft is nothing either.
    assert_eq!(completion_text("Something else entirely", tail, draft), None);
}

#[test]
fn the_continuation_is_one_inert_capped_line_cut_at_the_sentence() {
    let tail = "I'll send";
    let draft = "Thanks for the slides, I'll send";
    let hostile = "I'll send them\u{202e} over\u{1b}[2K now. After that\nsecond line";
    assert_eq!(completion_text(hostile, tail, draft).as_deref(), Some(" them over now."));
    let long = format!("I'll send {}", "word ".repeat(60));
    let text = completion_text(&long, tail, draft).unwrap();
    assert!(text.chars().count() <= MAX_COMPLETION_CHARS, "{text:?}");
    assert!(text.starts_with(' '));
    // After a trailing space the continuation carries no leading one.
    assert_eq!(completion_text("I'll send them", tail, "Thanks for the slides, I'll send ").as_deref(), Some("them"));
}

// ── The gate ────────────────────────────────────────────────────────────────

#[test]
fn a_bad_slot_or_draft_is_skipped_before_anything_is_asked() {
    let slots = Slots::default();
    let log = Mutex::new(Vec::new());
    for (slot, draft) in [("bad slot", Some("Thanks for the slides")), ("ok", Some("Thanks")), ("ok", Some("Thanks for\n"))] {
        let answer = done(gate_with(&slots, &on(), &ask(slot, draft), &log, false, Ok(account())));
        assert_eq!(answer, MailComplete::status(Status::Skipped), "{slot} {draft:?}");
    }
    assert!(log.lock().unwrap().is_empty(), "nothing is probed for a skipped ask: {:?}", log.lock().unwrap());
}

#[test]
fn a_mail_model_the_user_unloaded_is_skipped_before_anything_is_asked() {
    let slots = Slots::default();
    let log = Mutex::new(Vec::new());
    // A name no other test uses: the hold is process-wide.
    let mut settings = on();
    settings.ollama_roles.as_mut().unwrap().insert("mail".to_string(), "mail-held-by-unload".to_string());
    ollama::hold_unloaded("mail-held-by-unload");
    let answer = done(gate_with(&slots, &settings, &ask("a", Some("Thanks for the slides")), &log, false, Ok(account())));
    ollama::release_hold("mail-held-by-unload");
    assert_eq!(answer, MailComplete::status(Status::Skipped));
    assert!(log.lock().unwrap().is_empty(), "nothing is probed for a held model: {:?}", log.lock().unwrap());
}

#[test]
fn each_refusal_stops_the_chain_before_the_next_probe() {
    let slots = Slots::default();
    let draft = Some("Thanks for the slides");

    // The AI switch.
    let log = Mutex::new(Vec::new());
    let off = Settings { ai_off: Some(true), ..on() };
    assert_eq!(done(gate_with(&slots, &off, &ask("a", draft), &log, false, Ok(account()))).status, Status::Off);
    // Mail AI not allowed.
    let denied = Settings { mail_ai_allow: None, ..on() };
    assert_eq!(done(gate_with(&slots, &denied, &ask("a", draft), &log, false, Ok(account()))).status, Status::Off);
    let no_client = Settings { mail_client: Some(false), ..on() };
    assert_eq!(done(gate_with(&slots, &no_client, &ask("a", draft), &log, false, Ok(account()))).status, Status::Off);
    // No Mail model.
    let no_model = Settings { mail_ai_allow: Some(true), ..Default::default() };
    let answer = done(gate_with(&slots, &no_model, &ask("a", draft), &log, false, Ok(account())));
    assert_eq!(answer.status, Status::NoModel);
    assert_eq!(answer.reason.as_deref(), Some(mail_ai::NO_MODEL));
    assert!(log.lock().unwrap().is_empty(), "no probe before the model is known: {:?}", log.lock().unwrap());

    // A locked store never reads the account.
    let answer = done(gate_with(&slots, &on(), &ask("a", draft), &log, true, Ok(account())));
    assert_eq!(answer, MailComplete::status(Status::Locked));
    assert_eq!(*log.lock().unwrap(), ["store"]);

    // An unreadable account is unavailable, one with the switch off is off,
    // and neither reaches the endpoint.
    log.lock().unwrap().clear();
    assert_eq!(done(gate_with(&slots, &on(), &ask("a", draft), &log, false, Err(()))).status, Status::Unavailable);
    let muted = Account { autocomplete: false, ..account() };
    assert_eq!(done(gate_with(&slots, &on(), &ask("a", draft), &log, false, Ok(muted))).status, Status::Off);
    assert_eq!(*log.lock().unwrap(), ["store", "account", "store", "account"]);
}

#[test]
fn the_endpoint_gate_maps_every_refusal_to_a_status_and_probes_nothing_after_it() {
    let slots = Slots::default();
    let draft = Some("Thanks for the slides");
    let log = Mutex::new(Vec::new());

    // Remote host, even with the setting that allows it elsewhere.
    let mut remote = on();
    remote.ollama_host = Some("gpu-box.example:11434".into());
    remote.ollama_allow_remote_host = Some(true);
    let answer = done(gate_with(&slots, &remote, &ask("a", draft), &log, false, Ok(account())));
    assert_eq!(answer.status, Status::Refused);
    assert_eq!(answer.reason.as_deref(), Some(mail_ai::REMOTE_REFUSED));
    assert!(!log.lock().unwrap().contains(&"caps"), "{:?}", log.lock().unwrap());

    // A cloud model, an unlisted one.
    let mut cloud = on();
    cloud.ollama_roles = Some(HashMap::from([("mail".to_string(), "gpt-oss:120b-cloud".to_string())]));
    let answer = done(gate_with(&slots, &cloud, &ask("a", draft), &log, false, Ok(account())));
    assert_eq!(answer.status, Status::Refused);
    assert!(answer.reason.as_deref().unwrap().contains("cloud model"), "{answer:?}");
    let mut unlisted = on();
    unlisted.ollama_roles = Some(HashMap::from([("mail".to_string(), "mistral".to_string())]));
    assert_eq!(done(gate_with(&slots, &unlisted, &ask("a", draft), &log, false, Ok(account()))).status, Status::Refused);
    // A https host is an endpoint refusal.
    let mut https = on();
    https.ollama_host = Some("https://127.0.0.1:11434".into());
    assert_eq!(done(gate_with(&slots, &https, &ask("a", draft), &log, false, Ok(account()))).status, Status::Refused);
    assert!(!log.lock().unwrap().contains(&"caps"));

    // Nothing answering the model list.
    let store = || Ok(false);
    let acct = || Ok(account());
    let caps = |_: &str, _: &str| -> Vec<String> { panic!("no probe past a refusal") };
    let chat = |_: &str, _: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> { panic!("no request") };
    let backend = Ollama { caps: &caps, pinned: &not_pinned, chat: &chat };
    ollama::test_tags::set(None);
    let gated = slots.gate(&on(), &ask("a", draft), &Probes { store_locked: &store, account: &acct }, &backend, Instant::now());
    assert_eq!(done(gated), MailComplete::status(Status::NotRunning));

    // An embedding-only model is refused after the capability probe.
    let embedding = |_: &str, _: &str| vec!["embedding".to_string()];
    let backend = Ollama { caps: &embedding, pinned: &not_pinned, chat: &chat };
    ollama::test_tags::set(Some(TAGS));
    let gated = slots.gate(&on(), &ask("a", draft), &Probes { store_locked: &store, account: &acct }, &backend, Instant::now());
    let answer = done(gated);
    assert_eq!(answer.status, Status::Refused);
    assert!(answer.reason.as_deref().unwrap().contains("embedding-only"));
    ollama::test_tags::set(None);
}

#[test]
fn a_ready_request_needs_the_original_only_until_the_slot_holds_it() {
    let slots = Slots::default();
    let log = Mutex::new(Vec::new());
    let first = ready(gate_with(&slots, &on(), &ask("a", Some("Thanks for the slides")), &log, false, Ok(account())));
    assert!(first.needs_original());
    assert!(!first.is_warm());
    let first = slots.fill(first, original());
    assert!(!first.needs_original());
    // The next request in the slot finds it; another message does not.
    let again = ready(gate_with(&slots, &on(), &ask("a", Some("Thanks for the slides now")), &log, false, Ok(account())));
    assert!(!again.needs_original());
    let other = Ask { message_id: Some("m2"), ..ask("a", Some("Thanks for the slides now")) };
    assert!(ready(gate_with(&slots, &on(), &other, &log, false, Ok(account()))).needs_original());
    // A new mail needs no original.
    let new = Ask { message_id: None, subject: "Lunch?", to: &["a@example.org".to_string()], ..ask("a", Some("Shall we have lunch")) };
    let new = ready(gate_with(&slots, &on(), &new, &log, false, Ok(account())));
    assert!(!new.needs_original());
    assert_eq!(new.subject, "Lunch?");
    assert_eq!(new.to, "a@example.org");
    ollama::test_tags::set(None);
}

// ── The run ─────────────────────────────────────────────────────────────────

#[test]
fn a_completion_sends_the_four_messages_and_answers_the_cleaned_continuation() {
    let slots = Slots::default();
    let bodies = Mutex::new(Vec::new());
    let chat = |addr: &str, body: &str, timeout: Duration, _: &ollama::Abort| -> Result<String, String> {
        bodies.lock().unwrap().push((addr.to_string(), body.to_string(), timeout));
        Ok(answer_json("Thanks for the slides and I'll send them over. And more text"))
    };
    let caps = |_: &str, _: &str| vec!["completion".to_string(), "thinking".to_string()];
    let backend = Ollama { caps: &caps, pinned: &not_pinned, chat: &chat };
    let store = || Ok(false);
    let acct = || Ok(account());
    let probes = Probes { store_locked: &store, account: &acct };
    ollama::test_tags::set(Some(TAGS));
    let gated = slots.gate(&on(), &ask("a", Some("Thanks for the slides and I'll")), &probes, &backend, Instant::now());
    let ready = slots.fill(ready(gated), original());
    let answer = slots.run(ready, &backend);
    assert_eq!(answer.status, Status::Ok, "{answer:?}");
    assert_eq!(answer.text.as_deref(), Some(" send them over."));
    assert_eq!(answer.model.as_deref(), Some("llama3"));
    assert_eq!(answer.reason, None);

    let bodies = bodies.into_inner().unwrap();
    let [(addr, body, timeout)] = bodies.as_slice() else { panic!("one request: {bodies:?}") };
    assert_eq!(addr, "127.0.0.1:11434");
    assert_eq!(*timeout, COMPLETE_TIMEOUT);
    let v: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(v["model"], "llama3");
    assert_eq!(v["stream"], false);
    assert_eq!(v["think"], false);
    assert_eq!(v["keep_alive"], "30m");
    assert_eq!(v["options"]["num_predict"], 64);
    assert_eq!(v["options"]["temperature"], 0.2);
    assert!(v["options"].get("num_ctx").is_none());
    let roles: Vec<&str> = v["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["system", "user", "assistant", "user"]);
    ollama::test_tags::set(None);
}

#[test]
fn a_warm_up_sends_system_and_context_with_one_token_and_answers_warmed() {
    let slots = Slots::default();
    let bodies = Mutex::new(Vec::new());
    let chat = |_: &str, body: &str, timeout: Duration, _: &ollama::Abort| -> Result<String, String> {
        bodies.lock().unwrap().push((body.to_string(), timeout));
        Ok(answer_json(""))
    };
    let backend = Ollama { caps: &caps_ok, pinned: &|_, _| true, chat: &chat };
    let store = || Ok(false);
    let acct = || Ok(account());
    let probes = Probes { store_locked: &store, account: &acct };
    ollama::test_tags::set(Some(TAGS));
    let gated = slots.gate(&on(), &ask("w", None), &probes, &backend, Instant::now());
    let warm = ready(gated);
    assert!(warm.is_warm() && warm.needs_original());
    let answer = slots.run(slots.fill(warm, original()), &backend);
    assert_eq!(answer, MailComplete::status(Status::Warmed));
    let bodies = bodies.into_inner().unwrap();
    let v: serde_json::Value = serde_json::from_str(&bodies[0].0).unwrap();
    assert_eq!(v["options"]["num_predict"], 1);
    assert_eq!(v["keep_alive"], -1, "a pinned model keeps its pin");
    assert!(v.get("think").is_none(), "no thinking capability, no field");
    assert_eq!(bodies[0].1, WARM_TIMEOUT);
    let roles: Vec<&str> = v["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["system", "user"], "a warm-up ends on the user message");
    ollama::test_tags::set(None);
}

#[test]
fn ollama_failures_map_to_statuses_and_a_url_gives_ok_without_text() {
    let slots = Slots::default();
    let store = || Ok(false);
    let acct = || Ok(account());
    let probes = Probes { store_locked: &store, account: &acct };
    let run_with = |reply: Result<String, String>| {
        let chat = move |_: &str, _: &str, _: Duration, _: &ollama::Abort| reply.clone();
        let backend = Ollama { caps: &caps_ok, pinned: &not_pinned, chat: &chat };
        ollama::test_tags::set(Some(TAGS));
        let gated = slots.gate(&on(), &ask("e", Some("Please use the")), &probes, &backend, Instant::now());
        let r = slots.fill(ready(gated), original());
        slots.run(r, &backend)
    };
    assert_eq!(run_with(Err("timed out".into())).status, Status::Unavailable);
    assert_eq!(run_with(Err(ollama::MODEL_NOT_RUNNING.into())).status, Status::NotRunning);
    assert_eq!(run_with(Err(ollama::ABORTED.into())).status, Status::Skipped);
    assert_eq!(run_with(Ok("not json".into())).status, Status::Unavailable);
    assert_eq!(run_with(Ok("{}".into())).status, Status::Unavailable);
    let linked = run_with(Ok(answer_json("Please use the https://evil.example/pay link")));
    assert_eq!(linked, MailComplete::status(Status::Ok));
    let wandering = run_with(Ok(answer_json("Totally different")));
    assert_eq!(wandering, MailComplete::status(Status::Ok));
    ollama::test_tags::set(None);
}

#[test]
fn a_newer_request_supersedes_an_older_one_before_it_sends() {
    let slots = Slots::default();
    let sent = AtomicUsize::new(0);
    let chat = |_: &str, _: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> {
        sent.fetch_add(1, Ordering::SeqCst);
        Ok(answer_json("Thanks for the slides and I'll look"))
    };
    let backend = Ollama { caps: &caps_ok, pinned: &not_pinned, chat: &chat };
    let store = || Ok(false);
    let acct = || Ok(account());
    let probes = Probes { store_locked: &store, account: &acct };
    ollama::test_tags::set(Some(TAGS));
    let older = slots.fill(ready(slots.gate(&on(), &ask("s", Some("Thanks for the slides")), &probes, &backend, Instant::now())), original());
    let newer = ready(slots.gate(&on(), &ask("s", Some("Thanks for the slides and")), &probes, &backend, Instant::now()));
    assert!(newer.generation > older.generation);
    assert_eq!(slots.run(older, &backend), MailComplete::status(Status::Skipped));
    assert_eq!(sent.load(Ordering::SeqCst), 0, "the stale request never reaches Ollama");
    // The newer one proceeds (the slot still holds the original the older filled).
    assert!(!newer.needs_original());
    assert_eq!(slots.run(newer, &backend).status, Status::Ok);
    assert_eq!(sent.load(Ordering::SeqCst), 1);
    // A request in another slot is not affected.
    ollama::test_tags::set(None);
}

#[test]
fn a_newer_completion_ends_the_run_in_flight() {
    let slots = Slots::default();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let chat = |_: &str, _: &str, _: Duration, abort: &ollama::Abort| -> Result<String, String> {
        entered_tx.send(()).unwrap();
        while !abort.is_aborted() {
            std::thread::sleep(Duration::from_millis(5));
        }
        Err(ollama::ABORTED.to_string())
    };
    let backend = Ollama { caps: &caps_ok, pinned: &not_pinned, chat: &chat };
    let store = || Ok(false);
    let acct = || Ok(account());
    ollama::test_tags::set(Some(TAGS));
    let probes = Probes { store_locked: &store, account: &acct };
    let first = slots.fill(ready(slots.gate(&on(), &ask("f", Some("Thanks for the slides")), &probes, &backend, Instant::now())), original());
    std::thread::scope(|scope| {
        let run = scope.spawn(|| slots.run(first, &backend));
        entered_rx.recv().unwrap();
        // A warm-up now is busy: a run is in flight.
        ollama::test_tags::set(Some(TAGS));
        let warm = done(slots.gate(&on(), &ask("f", None), &probes, &backend, Instant::now() + Duration::from_secs(30)));
        assert_eq!(warm, MailComplete::status(Status::Busy));
        // The newer completion's gate ends the older run.
        let _newer = slots.gate(&on(), &ask("f", Some("Thanks for the slides and")), &probes, &backend, Instant::now());
        assert_eq!(run.join().unwrap(), MailComplete::status(Status::Skipped));
    });
    ollama::test_tags::set(None);
}

#[test]
fn a_warm_up_is_busy_within_two_seconds_of_the_last() {
    let slots = Slots::default();
    let now = Instant::now();
    let warm = |at: Instant| {
        let store = || Ok(false);
        let acct = || Ok(account());
        let chat = |_: &str, _: &str, _: Duration, _: &ollama::Abort| -> Result<String, String> { panic!() };
        let backend = Ollama { caps: &caps_ok, pinned: &not_pinned, chat: &chat };
        ollama::test_tags::set(Some(TAGS));
        slots.gate(&on(), &ask("b", None), &Probes { store_locked: &store, account: &acct }, &backend, at)
    };
    assert!(matches!(warm(now), Gated::Ready(_)));
    assert_eq!(done(warm(now + Duration::from_millis(500))), MailComplete::status(Status::Busy));
    assert!(matches!(warm(now + Duration::from_secs(3)), Gated::Ready(_)));
    ollama::test_tags::set(None);
}

// ── The slot table ──────────────────────────────────────────────────────────

fn held(table: &Table, key: &str) -> bool {
    table.slots.contains_key(key)
}

#[test]
fn the_table_keeps_four_slots_and_drops_the_least_recently_used() {
    let mut table = Table::default();
    let t0 = Instant::now();
    for (n, key) in ["a", "b", "c", "d"].into_iter().enumerate() {
        table.touch(key, t0 + Duration::from_secs(n as u64));
    }
    // `a` is touched again: `b` is now the oldest.
    table.touch("a", t0 + Duration::from_secs(10));
    table.touch("e", t0 + Duration::from_secs(11));
    assert_eq!(table.slots.len(), MAX_SLOTS);
    assert!(held(&table, "a") && held(&table, "c") && held(&table, "d") && held(&table, "e"));
    assert!(!held(&table, "b"));
}

#[test]
fn an_idle_slot_expires_and_takes_its_original_with_it() {
    let mut table = Table::default();
    let t0 = Instant::now();
    table.touch("a", t0);
    table.store("a", Arc::new(original()));
    assert!(table.begin("a", false, Some("m1"), t0 + Duration::from_secs(60)).unwrap().1.is_some());
    // Idle past the TTL: checked on the next access.
    let late = t0 + Duration::from_secs(60) + IDLE_TTL;
    table.touch("zzz", late);
    assert!(!held(&table, "a"));
    let (_, original) = table.begin("a", false, Some("m1"), late).unwrap();
    assert!(original.is_none(), "an expired slot's original is gone");
}

#[test]
fn eviction_release_and_expiry_end_the_run_in_flight() {
    let mut table = Table::default();
    let t0 = Instant::now();
    let running = |table: &mut Table, key: &str, at: Instant| {
        let (generation, _) = table.begin(key, false, None, at).unwrap();
        let abort = Arc::new(ollama::Abort::default());
        assert!(table.register(key, generation, &abort));
        abort
    };
    let a = running(&mut table, "a", t0);
    let b = running(&mut table, "b", t0 + Duration::from_secs(1));
    let _c = running(&mut table, "c", t0 + Duration::from_secs(2));
    let _d = running(&mut table, "d", t0 + Duration::from_secs(3));
    assert!(!a.is_aborted());
    // A fifth slot evicts the oldest (`a`) and ends its run.
    table.touch("e", t0 + Duration::from_secs(4));
    assert!(a.is_aborted() && !b.is_aborted());
    // Release ends one on purpose; an unknown slot is nothing.
    table.release("b");
    assert!(b.is_aborted() && !held(&table, "b"));
    table.release("nope");
    // Expiry ends the rest.
    let c = table.slots.get("c").unwrap().running.clone().unwrap();
    table.touch("f", t0 + Duration::from_secs(3) + IDLE_TTL);
    assert!(c.is_aborted());
}

#[test]
fn a_completion_bumps_the_generation_and_a_stale_run_may_not_register() {
    let mut table = Table::default();
    let t0 = Instant::now();
    let (first, _) = table.begin("a", false, None, t0).unwrap();
    let (second, _) = table.begin("a", false, None, t0).unwrap();
    assert_eq!(second, first + 1);
    let stale = Arc::new(ollama::Abort::default());
    assert!(!table.register("a", first, &stale), "the older generation must not send");
    let live = Arc::new(ollama::Abort::default());
    assert!(table.register("a", second, &live));
    // A third request ends the live run.
    table.begin("a", false, None, t0).unwrap();
    assert!(live.is_aborted());
    // Finishing a run that is no longer the slot's leaves the slot alone.
    let newest = Arc::new(ollama::Abort::default());
    let (g, _) = table.begin("a", false, None, t0).unwrap();
    assert!(table.register("a", g, &newest));
    table.finish("a", &live);
    assert!(table.slots.get("a").unwrap().running.is_some());
    table.finish("a", &newest);
    assert!(table.slots.get("a").unwrap().running.is_none());
    // A warm-up does not bump it.
    let (warm, _) = table.begin("a", true, None, t0 + Duration::from_secs(5)).unwrap();
    assert_eq!(warm, g);
    // An unknown slot never registers.
    assert!(!table.register("gone", 1, &Arc::new(ollama::Abort::default())));
}

// ── Wire words and the account ──────────────────────────────────────────────

#[test]
fn the_status_words_and_the_answer_json_are_the_contract() {
    let words = [
        (Status::Ok, "ok"),
        (Status::Warmed, "warmed"),
        (Status::Skipped, "skipped"),
        (Status::Busy, "busy"),
        (Status::Off, "off"),
        (Status::Locked, "locked"),
        (Status::NoModel, "no_model"),
        (Status::Refused, "refused"),
        (Status::NotRunning, "not_running"),
        (Status::Unavailable, "unavailable"),
    ];
    for (status, word) in words {
        assert_eq!(serde_json::to_value(status).unwrap(), word);
        assert_eq!(serde_json::from_value::<Status>(serde_json::json!(word)).unwrap(), status);
    }
    assert!(serde_json::from_value::<Status>(serde_json::json!("launched")).is_err());
    let ok = MailComplete::answered(Some(" the rest".into()), "llama3");
    assert_eq!(serde_json::to_value(&ok).unwrap(), serde_json::json!({ "status": "ok", "text": " the rest", "model": "llama3" }));
    let none = MailComplete::answered(None, "llama3");
    assert_eq!(serde_json::to_value(&none).unwrap(), serde_json::json!({ "status": "ok", "text": null }));
    let refused = MailComplete::refused(Status::Refused, "why".into());
    assert_eq!(serde_json::to_value(&refused).unwrap(), serde_json::json!({ "status": "refused", "text": null, "reason": "why" }));
}

#[test]
fn autocomplete_is_on_unless_the_account_says_false() {
    let mut mail = MailAccount::default();
    assert!(Account::of(&mail).autocomplete);
    mail.ai = Some(crate::schema::mail::MailAiPrefs { autocomplete: Some(true), ..Default::default() });
    assert!(Account::of(&mail).autocomplete);
    mail.ai = Some(crate::schema::mail::MailAiPrefs { autocomplete: Some(false), ..Default::default() });
    assert!(!Account::of(&mail).autocomplete);
    mail.label = "Ada".into();
    mail.signature = Some("sig".into());
    let account = Account::of(&mail);
    assert_eq!((account.name.as_str(), account.signature.as_deref()), ("Ada", Some("sig")));
}
