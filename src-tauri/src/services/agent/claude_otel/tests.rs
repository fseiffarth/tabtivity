use super::*;
use crate::schema::usage_stats::metric;
use serde_json::json;
use std::io::Write as _;

// Spans captured from Claude 2.1.331 by `scripts/verify-cli/claude/otel.py`,
// the stub answering input 100, cache write 5, cache read 7, output 10.
// Only the account hash and the kernel version are scrubbed.
const TURN: &str = include_str!("../claude_otel_fixtures/turn.json");
const SUBAGENT: &str = include_str!("../claude_otel_fixtures/subagent.json");
const TOOLS: &str = include_str!("../claude_otel_fixtures/tools_1.json");
// The same turn with every `OTEL_LOG_*` content opt-in on: its interaction span
// carries the prompt text.
const CONTENT: &str = include_str!("../claude_otel_fixtures/content.json");

fn key(prefix: &str, model: &str) -> String {
    token_key(prefix, CLI, model)
}

/// `key` summed over every day of `scope` (every scope when empty).
fn total(stats: &UsageStats, scope: &str, key: &str) -> u64 {
    stats.daily_for(scope).values().filter_map(|c| c.get(key)).sum()
}

fn request(id: &str, n: [u64; 4], sub: bool) -> LlmRequest {
    LlmRequest { key: format!("t:{id}"), session: "s1".into(), model: "claude-opus-4-7".into(), n, sub, end_ms: None }
}

/// One hand-made span.
fn span(name: &str, attrs: &[(&str, serde_json::Value)]) -> serde_json::Value {
    json!({
        "traceId": "aa11", "spanId": "bb22", "name": name, "endTimeUnixNano": "1790000000000000000",
        "attributes": attrs.iter().map(|(k, v)| json!({"key": k, "value": v})).collect::<Vec<_>>(),
    })
}

fn doc(spans: Vec<serde_json::Value>) -> Vec<u8> {
    serde_json::to_vec(&json!({"resourceSpans": [{"scopeSpans": [{"spans": spans}]}]})).unwrap()
}

fn s(v: &str) -> serde_json::Value {
    json!({"stringValue": v})
}

fn i(v: u64) -> serde_json::Value {
    json!({"intValue": v.to_string()})
}

// ── Parsing ────────────────────────────────────────────────────────────────

#[test]
fn a_captured_turn_yields_its_one_request_with_the_cache_taken_out_of_input() {
    let requests = parse_traces(TURN.as_bytes()).unwrap();
    assert_eq!(requests.len(), 1, "the interaction span is not a request");
    let r = &requests[0];
    // gen_ai.usage.input_tokens was 112 = 100 fresh + 5 written + 7 read.
    assert_eq!(r.n, [100, 5, 7, 10]);
    assert_eq!(r.model, "claude-stub");
    assert!(!r.sub);
    assert!(r.session.len() >= 32, "a session uuid: {}", r.session);
    assert!(r.end_ms.is_some_and(|ms| ms > 1_700_000_000_000));
    assert!(r.key.contains(':'));
}

#[test]
fn a_subagents_request_is_marked_and_keeps_its_parent_session() {
    let requests = parse_traces(SUBAGENT.as_bytes()).unwrap();
    assert_eq!(requests.len(), 3, "main, subagent, main again");
    assert_eq!(requests.iter().filter(|r| r.sub).count(), 1);
    let session = &requests[0].session;
    assert!(requests.iter().all(|r| &r.session == session), "the subagent's span names the main session");
    let keys: HashSet<&String> = requests.iter().map(|r| &r.key).collect();
    assert_eq!(keys.len(), 3);
}

#[test]
fn tool_and_interaction_spans_are_not_read() {
    let requests = parse_traces(TOOLS.as_bytes()).unwrap();
    assert!(!requests.is_empty());
    assert!(requests.len() <= 2);
}

#[test]
fn prompt_text_a_user_opted_into_never_reaches_a_request() {
    // The fixture really does carry the prompt on its interaction span…
    assert!(CONTENT.contains("say hi"));
    let requests = parse_traces(CONTENT.as_bytes()).unwrap();
    assert_eq!(requests.len(), 1);
    // …and nothing of it is in what the parser keeps, nor in the ledger.
    assert!(!format!("{requests:?}").contains("say hi"));
    let mut ledger = Ledger::default();
    ledger.ingest("p1", &requests, 1_790_000_000_000);
    let saved = serde_json::to_string(&ledger.stored).unwrap();
    assert!(!saved.contains("say hi"));
}

#[test]
fn spans_from_before_the_gen_ai_names_count_their_plain_input_as_fresh() {
    let body = doc(vec![span(
        LLM_REQUEST,
        &[
            ("session.id", s("sess-1")),
            ("model", s("claude-sonnet-4-5")),
            ("input_tokens", i(40)),
            ("cache_read_tokens", i(300)),
            ("cache_creation_tokens", i(20)),
            ("output_tokens", i(9)),
        ],
    )]);
    let requests = parse_traces(&body).unwrap();
    assert_eq!(requests[0].n, [40, 20, 300, 9]);
    assert_eq!(requests[0].model, "claude-sonnet-4-5");
}

#[test]
fn the_response_model_wins_over_the_request_model() {
    let body = doc(vec![span(
        LLM_REQUEST,
        &[
            ("session.id", s("sess-1")),
            ("gen_ai.request.model", s("opus")),
            ("gen_ai.response.model", s("claude-opus-4-7")),
            ("gen_ai.usage.input_tokens", i(5)),
        ],
    )]);
    assert_eq!(parse_traces(&body).unwrap()[0].model, "claude-opus-4-7");
}

#[test]
fn an_input_total_below_its_cache_parts_does_not_underflow() {
    let body = doc(vec![span(
        LLM_REQUEST,
        &[
            ("session.id", s("sess-1")),
            ("gen_ai.usage.input_tokens", i(10)),
            ("gen_ai.usage.cache_read.input_tokens", i(30)),
            ("gen_ai.usage.output_tokens", i(1)),
        ],
    )]);
    assert_eq!(parse_traces(&body).unwrap()[0].n, [0, 0, 30, 1]);
}

#[test]
fn forged_malformed_and_unusable_spans_are_skipped() {
    let ok = span(LLM_REQUEST, &[("session.id", s("sess-1")), ("gen_ai.usage.input_tokens", i(5))]);
    let mut huge = ok.clone();
    huge["attributes"] = json!([
        {"key": "session.id", "value": s("sess-1")},
        {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "99999999999999"}},
    ]);
    let mut negative = ok.clone();
    negative["attributes"] = json!([
        {"key": "session.id", "value": s("sess-1")},
        {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "-4"}},
    ]);
    let no_session = span(LLM_REQUEST, &[("gen_ai.usage.input_tokens", i(5))]);
    let odd_session = span(LLM_REQUEST, &[("session.id", s("../etc")), ("gen_ai.usage.input_tokens", i(5))]);
    let no_counts = span(LLM_REQUEST, &[("session.id", s("sess-1"))]);
    let zero = span(LLM_REQUEST, &[("session.id", s("sess-1")), ("gen_ai.usage.input_tokens", i(0))]);
    let mut no_ids = ok.clone();
    no_ids.as_object_mut().unwrap().remove("spanId");
    let other = span("claude_code.tool", &[("session.id", s("sess-1")), ("gen_ai.usage.input_tokens", i(5))]);
    let body = doc(vec![huge, negative, no_session, odd_session, no_counts, zero, no_ids, other, ok]);
    let requests = parse_traces(&body).unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].n, [5, 0, 0, 0]);
}

#[test]
fn an_integer_may_arrive_as_a_number_and_a_session_falls_back_to_the_conversation() {
    let body = doc(vec![span(
        LLM_REQUEST,
        &[("gen_ai.conversation.id", s("conv-9")), ("gen_ai.usage.output_tokens", json!({"intValue": 12}))],
    )]);
    let requests = parse_traces(&body).unwrap();
    assert_eq!(requests[0].session, "conv-9");
    assert_eq!(requests[0].n, [0, 0, 0, 12]);
}

#[test]
fn a_body_that_is_not_traces_is_refused() {
    assert_eq!(parse_traces(b"not json"), Err(ParseError::NotTraces));
    assert_eq!(parse_traces(b"{}"), Err(ParseError::NotTraces));
    assert_eq!(parse_traces(br#"{"resourceSpans": []}"#), Ok(vec![]));
}

// ── The ledger ─────────────────────────────────────────────────────────────

const NOW: i64 = 1_790_000_000_000;

#[test]
fn a_request_is_filed_under_its_scope_split_and_model() {
    let mut ledger = Ledger::default();
    let done = ledger.ingest("p1", &[request("a", [100, 5, 7, 10], false)], NOW);
    assert_eq!(done, Ingest { counted: 1, duplicates: 0 });
    let model = "claude-opus-4-7";
    let stats = ledger.stats();
    assert_eq!(total(stats, "p1", &key(metric::TOKENS_IN, model)), 100);
    assert_eq!(total(stats, "p1", &key(metric::TOKENS_CACHE_W, model)), 5);
    assert_eq!(total(stats, "p1", &key(metric::TOKENS_CACHE_R, model)), 7);
    assert_eq!(total(stats, "p1", &key(metric::TOKENS_OUT, model)), 10);
    assert_eq!(total(stats, "other", &key(metric::TOKENS_IN, model)), 0);
    // Not a subagent: no subagent detail.
    assert_eq!(total(stats, "", &key(metric::TOKENS_SUB_IN, model)), 0);
    let session = ledger.session("s1").unwrap();
    assert_eq!((session.scope.as_str(), session.requests, session.n), ("p1", 1, [100, 5, 7, 10]));
}

#[test]
fn a_subagents_request_adds_its_detail_beside_the_split() {
    let mut ledger = Ledger::default();
    ledger.ingest("p1", &[request("a", [1, 2, 3, 4], false), request("b", [10, 20, 30, 40], true)], NOW);
    let model = "claude-opus-4-7";
    assert_eq!(total(ledger.stats(), "", &key(metric::TOKENS_IN, model)), 11);
    assert_eq!(total(ledger.stats(), "", &key(metric::TOKENS_SUB_IN, model)), 10);
    assert_eq!(total(ledger.stats(), "", &key(metric::TOKENS_SUB_OUT, model)), 40);
}

#[test]
fn a_redelivered_span_counts_once() {
    let mut ledger = Ledger::default();
    let a = request("a", [100, 0, 0, 10], false);
    assert_eq!(ledger.ingest("p1", std::slice::from_ref(&a), NOW).counted, 1);
    // The exporter retries a batch whose answer it never saw, alone or with a new span.
    let again = ledger.ingest("p1", &[a.clone(), request("b", [1, 0, 0, 1], false)], NOW);
    assert_eq!(again, Ingest { counted: 1, duplicates: 1 });
    let model = "claude-opus-4-7";
    assert_eq!(total(ledger.stats(), "", &key(metric::TOKENS_IN, model)), 101);
    assert_eq!(ledger.session("s1").unwrap().requests, 2);
}

#[test]
fn the_redelivery_memory_is_bounded_and_forgets_the_oldest() {
    let mut ledger = Ledger::default();
    for n in 0..SEEN_SPANS + 10 {
        ledger.ingest("p1", &[request(&n.to_string(), [1, 0, 0, 0], false)], NOW);
    }
    assert!(ledger.seen.len() <= SEEN_SPANS);
    assert_eq!(ledger.seen.len(), ledger.seen_set.len());
    // The newest is still recognised; the very first no longer is.
    assert_eq!(ledger.ingest("p1", &[request(&(SEEN_SPANS + 9).to_string(), [1, 0, 0, 0], false)], NOW).duplicates, 1);
    assert_eq!(ledger.ingest("p1", &[request("0", [1, 0, 0, 0], false)], NOW).counted, 1);
}

#[test]
fn a_span_stamped_far_from_the_clock_is_filed_at_the_clock() {
    let mut ledger = Ledger::default();
    let mut far = request("a", [7, 0, 0, 0], false);
    far.end_ms = Some(NOW + 30 * 86_400_000);
    let mut recent = request("b", [3, 0, 0, 0], false);
    recent.end_ms = Some(NOW - 3_600_000);
    ledger.ingest("p1", &[far, recent], NOW);
    let hours = ledger.stats().hourly_for("p1");
    let model = "claude-opus-4-7";
    let at = |ms: i64| hour_of(ms).unwrap();
    assert_eq!(hours[&at(NOW)][&key(metric::TOKENS_IN, model)], 7);
    assert_eq!(hours[&at(NOW - 3_600_000)][&key(metric::TOKENS_IN, model)], 3);
    assert_eq!(hours.len(), 2, "no bucket a month ahead");
}

#[test]
fn sessions_are_bounded_and_the_least_recent_goes() {
    let mut ledger = Ledger::default();
    for n in 0..MAX_SESSIONS + 3 {
        let mut r = request(&format!("r{n}"), [1, 0, 0, 0], false);
        r.session = format!("s{n}");
        r.end_ms = Some(NOW + n as i64);
        ledger.ingest("p1", &[r], NOW);
    }
    assert_eq!(ledger.stored.sessions.len(), MAX_SESSIONS);
    assert!(ledger.session("s0").is_none());
    assert!(ledger.session(&format!("s{}", MAX_SESSIONS + 2)).is_some());
}

#[test]
fn the_ledger_round_trips_and_a_changed_one_only_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(LEDGER_FILE);
    let mut ledger = Ledger::load(&path);
    assert!(ledger.save(&path).is_ok());
    assert!(!path.exists(), "nothing counted, nothing written");
    ledger.ingest("p1", &[request("a", [100, 5, 7, 10], false)], NOW);
    ledger.save(&path).unwrap();
    let back = Ledger::load(&path);
    let model = "claude-opus-4-7";
    assert_eq!(total(back.stats(), "p1", &key(metric::TOKENS_OUT, model)), 10);
    assert_eq!(back.session("s1").unwrap().requests, 1);
    // A ledger of another version is not read.
    std::fs::write(&path, r#"{"version": 99, "stats": {"version": 1}}"#).unwrap();
    assert!(Ledger::load(&path).stats().days.is_empty());
}

// ── Against the transcripts ────────────────────────────────────────────────

#[test]
fn the_span_source_never_adds_into_the_transcript_rows() {
    // What the transcript scan filed for the same session (`claude`)…
    let mut transcripts = UsageStats::default();
    let claude = |prefix: &str| token_key(prefix, crate::services::token_stats::CLAUDE, "claude-opus-4-7");
    transcripts.add("p1", "2026-11-24T10", &claude(metric::TOKENS_IN), 100);
    transcripts.add("p1", "2026-11-24T10", &claude(metric::TOKENS_OUT), 10);
    // …and what the spans say of the same requests, plus a side request the
    // transcript never holds.
    let mut ledger = Ledger::default();
    ledger.ingest("p1", &[request("a", [100, 0, 0, 10], false), request("title", [30, 0, 0, 5], false)], NOW);
    let before = transcripts.clone();
    fold_into(&mut transcripts, ledger.stats());
    // The transcript rows are exactly what they were.
    for (prefix, want) in [(metric::TOKENS_IN, 100), (metric::TOKENS_OUT, 10)] {
        assert_eq!(total(&transcripts, "p1", &claude(prefix)), want);
        assert_eq!(total(&before, "p1", &claude(prefix)), want);
    }
    // The span rows sit beside them under their own leaf.
    assert_eq!(total(&transcripts, "p1", &key(metric::TOKENS_IN, "claude-opus-4-7")), 130);
    assert_eq!(total(&transcripts, "p1", &key(metric::TOKENS_OUT, "claude-opus-4-7")), 15);
    // Every added key is the span leaf's.
    let added: Vec<String> = transcripts
        .days
        .values()
        .flat_map(|by_scope| by_scope.values())
        .flat_map(|c| c.keys().cloned())
        .filter(|k| !before.days.values().flat_map(|b| b.values()).any(|c| c.contains_key(k)))
        .collect();
    assert!(!added.is_empty());
    assert!(added.iter().all(|k| crate::services::token_stats::parse_token_key(k).is_some_and(|(_, cli, _)| cli == CLI)), "{added:?}");
}

// ── What a launch carries ──────────────────────────────────────────────────

fn spawn<'a>(cmd: &'a str, args: &'a [String]) -> Candidate<'a> {
    Candidate { cmd, args, local_model: false, sandbox: false }
}

fn grant() -> Option<(String, String)> {
    Some(("http://127.0.0.1:4318/v1/traces".into(), "tok123".into()))
}

#[test]
fn a_local_claude_session_gets_the_exporter_under_its_carrier() {
    let mut env = HashMap::new();
    assert!(inject_env_with(spawn("claude", &[]), &mut env, true, false, grant));
    assert_eq!(env["CLAUDE_CODE_ENABLE_TELEMETRY"], "1");
    assert_eq!(env["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"], "1");
    assert_eq!(env["OTEL_TRACES_EXPORTER"], "otlp");
    assert_eq!(env["OTEL_METRICS_EXPORTER"], "none");
    assert_eq!(env["OTEL_LOGS_EXPORTER"], "none");
    assert_eq!(env["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"], "http/json");
    assert_eq!(env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"], "http://127.0.0.1:4318/v1/traces");
    // The bearer is the carrier's, never the exporter's own name, so it can ride
    // the tmux client's environment and not an argv.
    assert_eq!(env[CARRIER], "Authorization=Bearer%20tok123");
    assert!(!env.contains_key(HEADERS_VAR));
    // Where there is no carrier step (Windows) it is the variable itself.
    let mut plain = HashMap::new();
    assert!(inject_env_with(spawn("claude", &[]), &mut plain, false, false, grant));
    assert_eq!(plain[HEADERS_VAR], "Authorization=Bearer%20tok123");
    assert!(!plain.contains_key(CARRIER));
}

#[test]
fn only_a_plain_local_claude_session_is_a_candidate() {
    let run = |spawn: Candidate<'_>, env: &mut HashMap<String, String>, ambient: bool| inject_env_with(spawn, env, true, ambient, grant);
    assert!(!run(spawn("codex", &[]), &mut HashMap::new(), false), "another CLI");
    assert!(!run(Candidate { local_model: true, ..spawn("claude", &[]) }, &mut HashMap::new(), false));
    assert!(!run(Candidate { sandbox: true, ..spawn("claude", &[]) }, &mut HashMap::new(), false), "a container");
    let sub = ["auth".to_string(), "login".to_string()];
    assert!(!run(spawn("claude", &sub), &mut HashMap::new(), false), "a subcommand");
    assert!(!run(spawn("claude", &[]), &mut HashMap::new(), true), "the app's own environment has telemetry settings");
    for name in ["OTEL_EXPORTER_OTLP_ENDPOINT", "otel_logs_exporter", "CLAUDE_CODE_ENABLE_TELEMETRY", "ENABLE_BETA_TRACING_DETAILED"] {
        let mut env = HashMap::from([(name.to_string(), "x".to_string())]);
        assert!(!run(spawn("claude", &[]), &mut env, false), "{name}: the user's own setup is left alone");
        assert_eq!(env.len(), 1, "nothing added beside {name}");
    }
    // Nothing is added, and no token minted, when there is no receiver.
    let mut env = HashMap::new();
    assert!(!inject_env_with(spawn("claude", &[]), &mut env, true, false, || None));
    assert!(env.is_empty());
}

#[test]
fn a_dropped_carrier_takes_the_rest_of_the_exporter_with_it() {
    let mut env = HashMap::from([("HOME".to_string(), "/h".to_string())]);
    inject_env_with(spawn("claude", &[]), &mut env, true, false, grant);
    assert!(drop_with_carrier(&mut env));
    assert_eq!(env, HashMap::from([("HOME".to_string(), "/h".to_string())]));
    assert!(!drop_with_carrier(&mut env));
}

#[test]
fn the_carrier_is_a_secret_the_agent_exec_step_maps_and_tmux_keeps_off_argv() {
    assert!(CARRIER.ends_with(HEADERS_VAR));
    assert!(CARRIER.starts_with(crate::services::agent_exec::CARRIER_PREFIX));
    assert!(crate::services::agent_exec::targets().contains(&HEADERS_VAR));
    assert!(crate::services::tmux_local::SECRET_ENV.contains(&CARRIER));
    let env = [(std::ffi::OsString::from(CARRIER), std::ffi::OsString::from("Authorization=Bearer%20t"))];
    let mapped = crate::services::agent_exec::mapping(env.iter().map(|(k, v)| (k.as_os_str(), v.as_os_str())));
    assert_eq!(mapped.remove.len(), 1);
    assert_eq!(mapped.set, vec![(std::ffi::OsString::from(HEADERS_VAR), std::ffi::OsString::from("Authorization=Bearer%20t"))]);
}

// ── The receiver ───────────────────────────────────────────────────────────

struct Reply {
    status: u16,
}

/// One HTTP/1.1 request on a fresh connection to the receiver.
async fn post(port: u16, method: &str, path: &str, headers: &[(&str, String)], body: &[u8]) -> Reply {
    send(port, method, path, headers, body.len(), body).await
}

/// [`post`] declaring a `Content-Length` of `length` and sending `body`.
async fn send(port: u16, method: &str, path: &str, headers: &[(&str, String)], length: usize, body: &[u8]) -> Reply {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {length}\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        head.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    // A refusal may close the socket before the whole body is sent.
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let mut out = Vec::new();
    let _ = stream.read_to_end(&mut out).await;
    let text = String::from_utf8_lossy(&out);
    let status = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    Reply { status }
}

fn json_headers(token: &str) -> Vec<(&'static str, String)> {
    vec![("Content-Type", "application/json".into()), ("Authorization", format!("Bearer {token}"))]
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

#[test]
fn the_receiver_counts_for_the_token_s_scope_and_refuses_everything_else() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start_in(dir.path()).unwrap();
    let port = server.port();
    assert!(server.endpoint().starts_with(&format!("http://127.0.0.1:{port}/")));
    let token = server.issue("p1", "tab-1").unwrap();
    let other = server.issue("p2", "tab-2").unwrap();
    let model = "claude-stub";
    let want_in = key(metric::TOKENS_IN, model);

    app_core::rt::block_on(async {
        // A good span batch.
        let ok = post(port, "POST", TRACES_PATH, &json_headers(&token), TURN.as_bytes()).await;
        assert_eq!(ok.status, 200);
        assert_eq!(total(&server.snapshot(), "p1", &want_in), 100);
        // The same batch again (an exporter retry) counts nothing more; gzip too.
        let mut gz = json_headers(&token);
        gz.push(("Content-Encoding", "gzip".into()));
        assert_eq!(post(port, "POST", TRACES_PATH, &gz, &gzip(TURN.as_bytes())).await.status, 200);
        assert_eq!(total(&server.snapshot(), "p1", &want_in), 100);
        // Another tab's token files under its own scope only.
        assert_eq!(post(port, "POST", TRACES_PATH, &json_headers(&other), SUBAGENT.as_bytes()).await.status, 200);
        assert_eq!(total(&server.snapshot(), "p2", &want_in), 300);
        assert_eq!(total(&server.snapshot(), "p1", &want_in), 100);
        assert_eq!(server.session(&parse_traces(SUBAGENT.as_bytes()).unwrap()[0].session).unwrap().scope, "p2");

        // No token, a wrong one, a browser, another Host, the wrong type, path or method.
        let no_token = vec![("Content-Type", "application/json".to_string())];
        assert_eq!(post(port, "POST", TRACES_PATH, &no_token, TURN.as_bytes()).await.status, 401);
        assert_eq!(post(port, "POST", TRACES_PATH, &json_headers("nope"), TURN.as_bytes()).await.status, 401);
        let mut browser = json_headers(&token);
        browser.push(("Origin", "https://example.test".into()));
        assert_eq!(post(port, "POST", TRACES_PATH, &browser, TURN.as_bytes()).await.status, 403);
        let mut rebound = json_headers(&token);
        rebound.push(("Host", "evil.test".into()));
        assert_eq!(post(port, "POST", TRACES_PATH, &rebound, TURN.as_bytes()).await.status, 403);
        let proto = vec![("Content-Type", "application/x-protobuf".to_string()), ("Authorization", format!("Bearer {token}"))];
        assert_eq!(post(port, "POST", TRACES_PATH, &proto, b"\x0a\x00").await.status, 415);
        assert_eq!(post(port, "POST", "/v1/metrics", &json_headers(&token), b"{}").await.status, 404);
        assert_eq!(post(port, "GET", TRACES_PATH, &json_headers(&token), b"").await.status, 405);
        assert_eq!(post(port, "POST", TRACES_PATH, &json_headers(&token), b"[1,2").await.status, 400);
        // Refused on the declared length, before any body is read. No body is
        // sent: one left unread in the socket makes Windows answer the close
        // with a reset that discards the reply already received.
        assert_eq!(send(port, "POST", TRACES_PATH, &json_headers(&token), MAX_BODY + 1, b"").await.status, 413);
        // A gzip bomb is bounded.
        let mut bomb = json_headers(&token);
        bomb.push(("Content-Encoding", "gzip".into()));
        assert_eq!(post(port, "POST", TRACES_PATH, &bomb, &gzip(&vec![b' '; MAX_BODY + 10])).await.status, 400);
        // None of the refusals counted anything.
        assert_eq!(total(&server.snapshot(), "p1", &want_in), 100);

        // A tab's end ends its tokens.
        server.revoke_tab("tab-1");
        assert_eq!(post(port, "POST", TRACES_PATH, &json_headers(&token), TURN.as_bytes()).await.status, 401);
        assert_eq!(post(port, "POST", TRACES_PATH, &json_headers(&other), TURN.as_bytes()).await.status, 200);
    });

    // Stopping closes the port and writes the ledger.
    server.stop();
    // A child another test thread forked holds a copy of the listener until
    // it execs, so the port may answer for a moment longer.
    assert!(
        crate::test_util::wait_until(crate::test_util::PATIENCE, || std::net::TcpStream::connect(("127.0.0.1", port)).is_err()),
        "the port is closed after stop"
    );
    let saved = Ledger::load(&dir.path().join(LEDGER_FILE));
    // (tab-2's repeat of the turn tab-1 delivered was a redelivery: nothing more.)
    assert_eq!(total(saved.stats(), "p2", &want_in), 300);
    assert_eq!(total(saved.stats(), "p1", &want_in), 100);
    server.stop();
}

#[test]
fn the_receiver_is_on_loopback_only() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start_in(dir.path()).unwrap();
    let bound = std::net::TcpStream::connect(("127.0.0.1", server.port())).unwrap();
    // Bound to 127.0.0.1 itself, not the wildcard: the listener's own address
    // is the loopback one.
    assert_eq!(bound.peer_addr().unwrap().ip(), std::net::Ipv4Addr::LOCALHOST);
    assert_eq!(bound.local_addr().unwrap().ip(), std::net::Ipv4Addr::LOCALHOST);
    server.stop();
}

#[test]
fn nothing_starts_in_a_process_that_may_not_run_the_receiver() {
    // The test process never calls `allow_receiver`: the sidecar's situation.
    assert!(ensure_started().is_none());
    assert!(CURRENT.lock_ok().is_none());
}

#[test]
fn the_setting_is_off_unless_ticked() {
    let off = crate::schema::Settings::default();
    assert!(!off.claude_otel_tokens());
    let on: crate::schema::Settings = serde_json::from_str(r#"{"claude_otel_tokens": true}"#).unwrap();
    assert!(on.claude_otel_tokens());
    let explicit_off: crate::schema::Settings = serde_json::from_str(r#"{"claude_otel_tokens": false, "debug": true}"#).unwrap();
    assert!(!explicit_off.claude_otel_tokens());
}
