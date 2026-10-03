use super::*;
use crate::keeper::{Keeper, Peer, Peers};
use crate::keys_wire::Request;

struct As(Peer);

impl Peers for As {
    fn classify(&self, _: u32) -> Peer {
        self.0.clone()
    }
}

const KEY: &str = "fake-key-BROKERTEST0123456789";

fn ask(dir: &std::path::Path, peer: Peer, request: Request) -> keys_wire::Reply {
    Keeper::new(dir.to_path_buf(), Box::new(As(peer))).answer(1000, &serde_json::to_vec(&request).unwrap())
}

fn admin(dir: &std::path::Path, request: Request) {
    let reply = ask(dir, Peer::Gateway, request);
    assert!(reply.ok, "{reply:?}");
}

/// A brokered Claude key listed for alice and bob; their tokens.
fn brokered(dir: &std::path::Path) -> (String, String) {
    admin(dir, Request::Set { cli: "claude".into(), key: KEY.into(), by: "root1".into() });
    admin(dir, Request::Users { cli: "claude".into(), users: vec!["alice".into(), "bob".into()], by: "root1".into() });
    admin(dir, Request::Delivery { cli: "claude".into(), broker: true, by: "root1".into() });
    let token = |user: &str| ask(dir, Peer::User(user.into()), Request::Get { cli: "claude".into() }).key.unwrap();
    (token("alice"), token("bob"))
}

/// What the fake provider saw of the last request.
#[derive(Default, Clone)]
struct Seen {
    headers: Vec<(String, String)>,
    path: String,
}

/// A fake provider on loopback: `POST /v1/messages` answers a stream when
/// the body asks for one, else JSON; both with usage.
async fn fake_provider() -> (String, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let record = seen.clone();
    let app = Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
        let record = record.clone();
        async move {
            *record.lock().unwrap() = Seen {
                headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect(),
                path: format!("{method} {uri}"),
            };
            let stream = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v.get("stream").and_then(Value::as_bool)).unwrap_or(false);
            if stream {
                let events = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":100,\"cache_creation_input_tokens\":20,\"cache_read_input_tokens\":1000,\"output_tokens\":1}}}\n\n\
event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\n\
event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":50}}\n\n\
event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
                ([(header::CONTENT_TYPE, "text/event-stream"), (HeaderName::from_static("request-id"), "req_1")], events).into_response()
            } else {
                ([(header::CONTENT_TYPE, "application/json")], r#"{"id":"m","usage":{"input_tokens":7,"output_tokens":3}}"#).into_response()
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), seen)
}

async fn start(dir: &std::path::Path, upstream: String) -> String {
    let broker = Arc::new(Broker::new(dir.to_path_buf(), HashMap::from([("claude", upstream)])).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { serve(broker, listener).await.unwrap() });
    format!("http://{addr}/claude")
}

async fn post(base: &str, token: &str, body: &str) -> (u16, String) {
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", token)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .header("cookie", "session=1")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.text().await.unwrap())
}

async fn month(dir: &std::path::Path, user: &str) -> Usage {
    // The meter records when the answer's stream is dropped, just after the
    // client has read its end.
    for _ in 0..100 {
        let usage = keeper::usage_in(dir, "claude", user).months.remove(&keys_wire::month_of(crate::now())).unwrap_or_default();
        if usage.requests > 0 {
            return usage;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Usage::default()
}

#[tokio::test]
async fn a_token_is_swapped_for_the_key_and_the_stream_is_metered_for_its_user() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob) = brokered(dir.path());
    assert!(alice.starts_with("broker-") && alice != bob && alice != KEY);
    let (upstream, seen) = fake_provider().await;
    let base = start(dir.path(), upstream).await;
    let (status, body) = post(&base, &alice, r#"{"model":"m","stream":true}"#).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("message_stop"), "the stream passes through: {body}");
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.path, "POST /v1/messages");
    let header = |name: &str| seen.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    assert_eq!(header("x-api-key").as_deref(), Some(KEY), "the provider gets the administrator's key");
    assert_eq!(header("anthropic-version").as_deref(), Some("2023-06-01"));
    assert_eq!(header("cookie"), None, "nothing else of the client's");
    assert!(seen.headers.iter().all(|(_, v)| !v.contains(&alice)), "the token never reaches the provider");
    let usage = month(dir.path(), "alice").await;
    assert_eq!((usage.input, usage.output, usage.cache_write, usage.cache_read, usage.requests), (100, 50, 20, 1000, 1));
    assert_eq!(month(dir.path(), "bob").await, Usage::default(), "bob spent nothing");
    // A JSON answer is metered too; the user's own usage request sees it.
    let (status, _) = post(&base, &alice, r#"{"model":"m"}"#).await;
    assert_eq!(status, 200);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let own = ask(dir.path(), Peer::User("alice".into()), Request::Usage { cli: "claude".into() }).usage.unwrap();
    assert_eq!((own.usage.input, own.usage.output, own.usage.requests), (107, 53, 2));
    assert_eq!(own.billed, keys_wire::billed(&own.usage));
    let status = ask(dir.path(), Peer::Gateway, Request::Status).status.remove(0);
    assert!(status.broker);
    assert_eq!(status.usage.iter().map(|u| u.user.as_str()).collect::<Vec<_>>(), ["alice"]);
}

#[tokio::test]
async fn strangers_browsers_and_other_paths_are_refused_before_the_provider() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, _) = brokered(dir.path());
    let (upstream, seen) = fake_provider().await;
    let base = start(dir.path(), upstream).await;
    assert_eq!(post(&base, "broker-not-a-token-0123456789", "{}").await.0, 401);
    assert_eq!(post(&base, KEY, "{}").await.0, 401, "the key itself is no token");
    let client = reqwest::Client::new();
    let browser = client.post(format!("{base}/v1/messages")).header("x-api-key", &alice).header("origin", "https://evil.example").body("{}").send().await.unwrap();
    assert_eq!(browser.status().as_u16(), 403);
    let files = client.post(format!("{base}/v1/files")).header("x-api-key", &alice).body("{}").send().await.unwrap();
    assert_eq!(files.status().as_u16(), 404, "only the paths an agent needs");
    let other = client.get(format!("{}/gemini/v1/models", base.trim_end_matches("/claude"))).header("x-api-key", &alice).send().await.unwrap();
    assert_eq!(other.status().as_u16(), 404);
    assert_eq!(seen.lock().unwrap().path, "", "none of them reached the provider");
    let models = client.get(format!("{base}/v1/models?limit=5")).header("authorization", format!("Bearer {alice}")).send().await.unwrap();
    assert_eq!(models.status().as_u16(), 200, "a bearer token works too");
    assert_eq!(seen.lock().unwrap().path, "GET /v1/models?limit=5");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(month(dir.path(), "alice").await.requests, 0, "only messages are metered");
}

#[tokio::test]
async fn a_spent_budget_refuses_and_revocation_stops_the_next_request() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob) = brokered(dir.path());
    let (upstream, _) = fake_provider().await;
    let base = start(dir.path(), upstream).await;
    admin(dir.path(), Request::Budget { cli: "claude".into(), user: None, tokens: Some(50), by: "root1".into() });
    admin(dir.path(), Request::Budget { cli: "claude".into(), user: Some("bob".into()), tokens: Some(1_000_000), by: "root1".into() });
    assert_eq!(post(&base, &alice, r#"{"stream":true}"#).await.0, 200, "under budget until this one");
    month(dir.path(), "alice").await;
    let (status, body) = post(&base, &alice, r#"{"stream":true}"#).await;
    assert_eq!(status, 403);
    assert!(body.contains("budget") && body.contains("permission_error"), "{body}");
    assert_eq!(post(&base, &bob, r#"{"stream":true}"#).await.0, 200, "bob's own budget");
    // Renewed: the old token is dead, the next fetch mints another.
    admin(dir.path(), Request::RenewToken { cli: "claude".into(), user: "bob".into(), by: "root1".into() });
    assert_eq!(post(&base, &bob, "{}").await.0, 401);
    let renewed = ask(dir.path(), Peer::User("bob".into()), Request::Get { cli: "claude".into() }).key.unwrap();
    assert_ne!(renewed, bob);
    assert_eq!(post(&base, &renewed, "{}").await.0, 200);
    // Off the list: token gone at once.
    admin(dir.path(), Request::Users { cli: "claude".into(), users: vec!["alice".into()], by: "root1".into() });
    assert_eq!(post(&base, &renewed, "{}").await.0, 401);
    // Back to direct delivery: every token is gone, a fetch is the key again.
    admin(dir.path(), Request::Delivery { cli: "claude".into(), broker: false, by: "root1".into() });
    assert_eq!(post(&base, &alice, "{}").await.0, 401);
    assert_eq!(ask(dir.path(), Peer::User("alice".into()), Request::Get { cli: "claude".into() }).key.as_deref(), Some(KEY));
    let rows = crate::audit::AuditLog::in_dir(dir.path()).rows();
    assert!(rows.iter().any(|r| r.verb == VERB_OVER_BUDGET && r.user == "alice"));
    assert!(rows.iter().any(|r| r.verb == VERB_USED && r.user == "bob"));
    let log = std::fs::read_to_string(dir.path().join(crate::audit::AUDIT_FILE)).unwrap();
    assert!(!log.contains(KEY) && !log.contains(&alice) && !log.contains(&renewed), "no key or token in the audit");
}

#[test]
fn the_meter_reads_split_events_and_records_on_drop() {
    let dir = tempfile::tempdir().unwrap();
    let broker = Arc::new(Broker::new(dir.path().to_path_buf(), HashMap::new()).unwrap());
    let stream = b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":12}}";
    let mut meter = Meter::new(broker.clone(), "claude", "carol", true);
    for chunk in stream.chunks(7) {
        meter.feed(chunk);
    }
    assert_eq!((meter.usage().input, meter.usage().output), (9, 4), "the unfinished last line waits");
    drop(meter);
    let usage = keeper::usage_in(dir.path(), "claude", "carol").months.into_values().next().unwrap();
    assert_eq!((usage.input, usage.output, usage.requests), (9, 12, 1), "a client gone mid-stream still pays what was produced");
    let mut json = Meter::new(broker, "claude", "carol", false);
    json.feed(br#"{"usage":{"input_tokens":1,"#);
    json.feed(br#""output_tokens":2}}"#);
    drop(json);
    let usage = keeper::usage_in(dir.path(), "claude", "carol").months.into_values().next().unwrap();
    assert_eq!((usage.input, usage.output, usage.requests), (10, 14, 2));
}

/// P5 review: a stream left before its closing count still bills the text
/// it carried, and a JSON answer is metered before its first byte is handed
/// over — leaving early never makes a request free.
#[test]
fn a_stream_left_before_its_count_bills_the_text_it_carried() {
    let dir = tempfile::tempdir().unwrap();
    let broker = Arc::new(Broker::new(dir.path().to_path_buf(), HashMap::new()).unwrap());
    let mut meter = Meter::new(broker, "claude", "dave", true);
    meter.feed(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}}\n\n");
    meter.feed(b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello world!\"}}\n\n");
    meter.feed(b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"a\\\":1}\"}}\n\n");
    drop(meter);
    let usage = keeper::usage_in(dir.path(), "claude", "dave").months.into_values().next().unwrap();
    assert_eq!((usage.input, usage.output, usage.requests), (9, 7, 1), "12 + 7 bytes at three a token, not the one token message_start names");
}

#[tokio::test]
async fn a_json_answer_is_metered_before_it_is_handed_over() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, _) = brokered(dir.path());
    let (upstream, _) = fake_provider().await;
    let base = start(dir.path(), upstream).await;
    let response = reqwest::Client::new().post(format!("{base}/v1/messages")).header("x-api-key", &alice).body(r#"{"model":"m"}"#).send().await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    // Nothing of the body read yet, and the client goes: already counted.
    drop(response);
    let usage = keeper::usage_in(dir.path(), "claude", "alice").months.remove(&keys_wire::month_of(crate::now())).unwrap_or_default();
    assert_eq!((usage.input, usage.output, usage.requests), (7, 3, 1));
}

#[test]
fn only_the_paths_an_agent_needs_are_forwarded() {
    for (method, rest, ok) in [
        (Method::POST, "v1/messages", true),
        (Method::POST, "v1/messages/count_tokens", true),
        (Method::GET, "v1/models", true),
        (Method::GET, "v1/models/claude-x-1", true),
        (Method::GET, "v1/models/../files", false),
        (Method::GET, "v1/models/..", false),
        (Method::GET, "v1/models/.", false),
        (Method::GET, "v1/models/claude-3.5", true),
        (Method::GET, "v1/messages", false),
        (Method::POST, "v1/messages/batches", false),
        (Method::POST, "v1/files", false),
        (Method::GET, "v1/organizations/me", false),
    ] {
        assert_eq!(allowed("claude", &method, rest), ok, "{method} {rest}");
    }
    assert!(!allowed("gemini", &Method::POST, "v1/messages"));
}
