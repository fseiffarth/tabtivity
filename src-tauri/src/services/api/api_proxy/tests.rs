use super::*;
use std::sync::atomic::AtomicUsize;

// Fake test keys and tokens, never a real-looking provider shape.
const FAKE_KEY: &str = "sk-test-proxy-fake";

fn grant(provider: Provider, tab: &str, tmux: Option<&str>) -> Grant {
    Grant { provider, scope: "p1".into(), tab: tab.into(), tmux: tmux.map(str::to_string), admin: None }
}

#[test]
fn routes_split_on_the_provider_prefix() {
    assert_eq!(split_route("/anthropic/v1/messages"), Some((Provider::Anthropic, "/v1/messages")));
    assert_eq!(split_route("/gemini/v1beta/models"), Some((Provider::Gemini, "/v1beta/models")));
    assert_eq!(split_route("/anthropic"), Some((Provider::Anthropic, "")));
    assert_eq!(split_route("/openai/v1/responses"), Some((Provider::OpenAi, "/v1/responses")));
    assert_eq!(split_route("/"), None);
}

#[test]
fn only_the_paths_a_cli_needs_are_forwarded() {
    use Provider::*;
    let (get, post) = (Method::GET, Method::POST);
    assert!(path_allowed(Anthropic, &post, "/v1/messages"));
    assert!(path_allowed(Anthropic, &post, "/v1/messages/count_tokens"));
    assert!(path_allowed(Anthropic, &get, "/v1/models"));
    assert!(path_allowed(Anthropic, &get, "/v1/models/claude-opus-5-5"));
    for (m, p) in [
        (&get, "/v1/messages"),
        (&post, "/v1/models"),
        (&post, "/v1/messages/batches"),
        (&post, "/v1/files"),
        (&post, "/api/hello"),
        (&Method::HEAD, "/api/hello"),
        (&post, "/v1/../v1/messages"),
        (&post, "/v1//messages"),
        (&post, "/v1/messages/"),
        (&post, "/v1/%6dessages"),
        (&post, "v1/messages"),
        (&post, ""),
    ] {
        assert!(!path_allowed(Anthropic, m, p), "{m} {p}");
    }
    assert!(path_allowed(Gemini, &post, "/v1beta/models/gemini-3-pro:streamGenerateContent"));
    assert!(path_allowed(Gemini, &post, "/v1/models/gemini-3-pro:countTokens"));
    assert!(path_allowed(Gemini, &get, "/v1beta/models"));
    assert!(path_allowed(Gemini, &get, "/v1beta/models/gemini-3-pro"));
    for (m, p) in [
        (&get, "/v1beta/models/gemini-3-pro:generateContent"),
        (&post, "/v1beta/models/gemini-3-pro:predict"),
        (&post, "/v1beta/models/:generateContent"),
        (&post, "/v1beta/tunedModels/x:generateContent"),
        (&post, "/v1beta/files"),
        (&post, "/v2/models/x:generateContent"),
        (&post, "/v1/messages"),
    ] {
        assert!(!path_allowed(Gemini, m, p), "{m} {p}");
    }
}

#[test]
fn the_token_may_ride_any_credential_slot_but_only_one_value() {
    let h = |pairs: &[(&str, &str)]| {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        m
    };
    assert_eq!(presented_token(&h(&[("authorization", "Bearer abc")]), None).as_deref(), Some("abc"));
    assert_eq!(presented_token(&h(&[("x-api-key", "abc")]), None).as_deref(), Some("abc"));
    assert_eq!(presented_token(&h(&[("x-goog-api-key", "abc")]), None).as_deref(), Some("abc"));
    assert_eq!(presented_token(&h(&[]), Some("alt=sse&key=abc")).as_deref(), Some("abc"));
    assert_eq!(
        presented_token(&h(&[("authorization", "Bearer abc"), ("x-api-key", "abc")]), None).as_deref(),
        Some("abc")
    );
    assert_eq!(presented_token(&h(&[("authorization", "Bearer abc"), ("x-api-key", "xyz")]), None), None);
    assert_eq!(presented_token(&h(&[("x-api-key", "abc"), ("x-api-key", "abc")]), None), None);
    assert_eq!(presented_token(&h(&[("authorization", "Basic abc")]), None), None);
    assert_eq!(presented_token(&h(&[("x-api-key", "")]), None), None);
    assert_eq!(presented_token(&h(&[]), Some("beta=true")), None);
}

#[test]
fn only_the_query_parameters_a_cli_sends_travel_on() {
    use Provider::*;
    assert_eq!(forwarded_query(Gemini, Some("alt=sse&key=abc")), "?alt=sse");
    assert_eq!(forwarded_query(Gemini, Some("key=abc")), "");
    assert_eq!(forwarded_query(Anthropic, Some("beta=true")), "?beta=true");
    assert_eq!(forwarded_query(Anthropic, None), "");
    assert_eq!(forwarded_query(Anthropic, Some("limit=100&after_id=m")), "?limit=100&after_id=m");
    assert_eq!(forwarded_query(Gemini, Some("pageSize=5&pageToken=x")), "?pageSize=5&pageToken=x");
    // The token in any spelling the provider would decode as `key`, a
    // method override, another credential, a JSONP callback: dropped.
    for q in ["%6Bey=abc", "Key=abc", "key", "$httpMethod=DELETE", "access_token=x", "$callback=f", "monkey=1"] {
        assert_eq!(forwarded_query(Gemini, Some(q)), "", "{q}");
        assert_eq!(forwarded_query(Anthropic, Some(q)), "", "{q}");
    }
    // One provider's parameters are not the other's.
    assert_eq!(forwarded_query(Anthropic, Some("alt=sse")), "");
    assert_eq!(forwarded_query(Gemini, Some("beta=true")), "");
}

#[test]
fn credentials_and_hop_by_hop_headers_are_not_forwarded() {
    let mut m = HeaderMap::new();
    for (k, v) in [
        ("authorization", "Bearer t"),
        ("x-api-key", "t"),
        ("x-goog-api-key", "t"),
        ("host", "127.0.0.1:1"),
        ("accept-encoding", "gzip"),
        ("connection", "keep-alive"),
        ("cookie", "a=b"),
        ("anthropic-version", "2023-06-01"),
        ("anthropic-beta", "a,b"),
        ("x-claude-code-session-id", "s"),
        ("content-type", "application/json"),
        ("proxy-authorization", "Basic t"),
        ("x-http-method-override", "DELETE"),
        ("x-http-method", "DELETE"),
        ("x-method-override", "DELETE"),
        ("x-goog-fieldmask", "candidates.content,usageMetadata.promptTokenCount"),
        ("origin", "https://example.org"),
        ("te", "trailers"),
        ("transfer-encoding", "chunked"),
        ("content-length", "1"),
    ] {
        m.append(axum::http::HeaderName::from_static(k), HeaderValue::from_static(v));
    }
    let out = copy_headers(&m, DROP_REQUEST);
    let names: Vec<&str> = out.keys().map(|k| k.as_str()).collect();
    assert_eq!(
        names,
        vec!["anthropic-version", "anthropic-beta", "x-claude-code-session-id", "content-type"]
    );
}

#[test]
fn a_respawn_gets_its_token_back_and_a_closed_tab_loses_it() {
    let g = grant(Provider::Anthropic, "p1:respawn", None);
    let first = issue_grant(g.clone()).unwrap();
    assert_eq!(first.len(), 64);
    assert_eq!(issue_grant(g.clone()).unwrap(), first, "same tab, same token");
    let other = issue_grant(grant(Provider::Gemini, "p1:respawn", None)).unwrap();
    assert_ne!(other, first, "one token per provider");
    assert_eq!(lookup(&first), Some(g));
    on_tab_gone("p1:respawn");
    assert!(!token_live(&first) && !token_live(&other));
    assert_ne!(issue_grant(grant(Provider::Anthropic, "p1:respawn", None)).unwrap(), first);
    on_tab_gone("p1:respawn");
}

#[test]
fn a_tmux_bound_grant_lives_as_long_as_its_session() {
    let start = Instant::now();
    let held = |g: Grant| Held { grant: g, since: start };
    let mut map = HashMap::from([
        ("t1".to_string(), held(grant(Provider::Anthropic, "p1:tmux", Some("app-p1--a")))),
        ("t2".to_string(), held(grant(Provider::Anthropic, "p1:plain", None))),
    ]);
    let later = start + SWEEP_GRACE;
    retain_live(&mut map, &HashSet::from(["app-p1--a".to_string()]), later);
    assert_eq!(map.len(), 2);
    // A fresh grant outlives a sweep that runs before its session exists.
    retain_live(&mut map, &HashSet::new(), start + Duration::from_secs(1));
    assert_eq!(map.len(), 2, "within the grace");
    retain_live(&mut map, &HashSet::new(), later);
    assert!(map.contains_key("t2") && !map.contains_key("t1"));
}

#[test]
fn a_killed_session_takes_its_grants_and_a_renamed_one_keeps_them() {
    let killed = issue_grant(grant(Provider::Anthropic, "p1:killed", Some("c2-sess-killed"))).unwrap();
    let renamed = issue_grant(grant(Provider::Anthropic, "p1:renamed", Some("c2-sess-old"))).unwrap();
    let other = issue_grant(grant(Provider::Anthropic, "p1:other", Some("c2-sess-other"))).unwrap();
    on_tmux_session_gone("c2-sess-killed");
    assert!(!token_live(&killed));
    on_tmux_renamed("c2-sess-old", "c2-sess-new");
    assert_eq!(lookup(&renamed).unwrap().tmux.as_deref(), Some("c2-sess-new"));
    assert_eq!(lookup(&other).unwrap().tmux.as_deref(), Some("c2-sess-other"));
    // A respawn of the renamed tab binds the new name and gets its token.
    assert_eq!(issue_grant(grant(Provider::Anthropic, "p1:renamed", Some("c2-sess-new"))).unwrap(), renamed);
    grants().lock_ok().retain(|t, _| *t != renamed && *t != other);
}

#[test]
fn no_session_name_no_tmux_binding() {
    assert_eq!(tmux_binding(None), None);
    let bound = tmux_binding(Some("c2-sess"));
    assert_eq!(bound.is_some(), crate::services::tmux_local::tmux_available());
}

#[test]
fn a_closed_tmux_tab_keeps_its_grant_for_the_sweep() {
    let token = issue_grant(grant(Provider::Gemini, "p1:kept", Some("not-a-real-session-c2"))).unwrap();
    // The PTY went, the session may not have: the grant stays until a
    // sweep finds the session gone — not within the grace a fresh grant
    // has, so the sweep this spawns leaves it.
    on_tab_gone("p1:kept");
    assert!(token_live(&token));
    grants().lock_ok().remove(&token);
}

#[tokio::test]
async fn refusals_speak_the_providers_error_shapes() {
    let body = |r: Response| async move {
        let status = r.status();
        let retry = r.headers().get("x-should-retry").cloned();
        let bytes = axum::body::to_bytes(r.into_body(), 1 << 16).await.unwrap();
        (status, retry, serde_json::from_slice::<serde_json::Value>(&bytes).unwrap())
    };
    let (status, retry, json) = body(refuse(Some(Provider::Anthropic), Refusal::Unauthorized)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(retry.unwrap(), "false");
    assert_eq!(json["type"], "error");
    assert_eq!(json["error"]["type"], "authentication_error");
    let (status, _, json) = body(refuse(Some(Provider::Gemini), Refusal::NoKey)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json["error"]["status"], "UNAUTHENTICATED");
    assert_eq!(json["error"]["code"], 401);
    let (_, retry, _) = body(refuse(Some(Provider::Gemini), Refusal::Upstream)).await;
    assert_eq!(retry.unwrap(), "true");
}

#[test]
fn production_dials_only_the_providers_https_host() {
    assert_eq!(Upstream::Provider.base(Provider::Anthropic), "https://api.anthropic.com");
    assert_eq!(Upstream::Provider.base(Provider::Gemini), "https://generativelanguage.googleapis.com");
    assert_eq!(base_url_on(4321, Provider::Gemini), "http://127.0.0.1:4321/gemini");
    assert!(is_proxy_base(&base_url_on(4321, Provider::Gemini), Provider::Gemini));
    assert!(!is_proxy_base(&base_url_on(4321, Provider::Gemini), Provider::Anthropic));
    assert!(!is_proxy_base("https://gateway.example/gemini", Provider::Gemini));
    assert!(!is_proxy_base("http://127.0.0.1:/gemini", Provider::Gemini));
}

#[test]
fn a_forgotten_key_is_not_put_back_by_an_older_read() {
    // A read that started before `forget_key` must not repopulate.
    let generation = KEY_GENERATION.load(Ordering::Acquire);
    forget_key(Provider::Gemini);
    assert_ne!(KEY_GENERATION.load(Ordering::Acquire), generation);
    assert!(keys().lock_ok().get(&Provider::Gemini).is_none());
}

// ---- end to end, against an in-process stub upstream -----------------

/// One request as the stub upstream saw it: method, URI, headers, body.
type SeenRequest = (String, String, HeaderMap, Vec<u8>);

/// What the stub upstream saw of each request.
#[derive(Default)]
struct Seen {
    requests: Mutex<Vec<SeenRequest>>,
    hits: AtomicUsize,
}

const SSE_FIRST: &str = concat!(
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_stub\",",
    "\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-stub\",\"content\":[],",
    "\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\n",
);
const SSE_REST: &str = concat!(
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,",
    "\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,",
    "\"delta\":{\"type\":\"text_delta\",\"text\":\"STUB-REPLY-OK\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",",
    "\"stop_sequence\":null},\"usage\":{\"output_tokens\":3}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
);

/// A stub provider: records the request, then streams [`SSE_FIRST`], waits
/// for a `release` permit, then [`SSE_REST`].
async fn stub_upstream(seen: Arc<Seen>, release: Arc<tokio::sync::Semaphore>) -> String {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().fallback(move |req: Request| {
        let seen = seen.clone();
        let release = release.clone();
        async move {
            let (parts, body) = req.into_parts();
            let body = axum::body::to_bytes(body, usize::MAX).await.unwrap().to_vec();
            seen.hits.fetch_add(1, Ordering::SeqCst);
            seen.requests.lock_ok().push((
                parts.method.to_string(),
                parts.uri.to_string(),
                parts.headers.clone(),
                body,
            ));
            let stream = futures_util::stream::unfold(0u8, move |step| {
                let release = release.clone();
                async move {
                    match step {
                        0 => Some((Ok::<Bytes, std::io::Error>(Bytes::from_static(SSE_FIRST.as_bytes())), 1)),
                        // A closed `release` breaks the stream off mid-body.
                        1 => match release.acquire().await {
                            Ok(permit) => {
                                permit.forget();
                                Some((Ok(Bytes::from_static(SSE_REST.as_bytes())), 2))
                            }
                            Err(_) => Some((Err(std::io::Error::other("stub broke off")), 2)),
                        },
                        _ => None,
                    }
                }
            });
            let mut r = Response::new(Body::from_stream(stream));
            r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
            r.headers_mut().insert("request-id", HeaderValue::from_static("req_stub"));
            r
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

async fn proxy(upstream: String, key: Option<&'static str>, max_body: usize) -> u16 {
    proxy_with(upstream, key, |s| s.max_body = max_body).await.0
}

/// A proxy on a free port, its state adjusted by `tune`; the port and the
/// body budget's counter.
async fn proxy_with(
    upstream: String,
    key: Option<&'static str>,
    tune: impl FnOnce(&mut ProxyState),
) -> (u16, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut state =
        ProxyState::new(port, Upstream::Test(upstream), KeySource::Fixed(key), test_budget(ROOMY), client(false).unwrap(), client(false).unwrap());
    tune(&mut state);
    let buffered = state.buffered.clone();
    tokio::spawn(serve(listener, state, std::future::pending()));
    (port, buffered)
}

/// What [`usage_tap`] / [`usage_end`] saw, per tab: `None` a chunk,
/// `Some(end)` an end.
type TapLog = Mutex<Vec<(String, Option<StreamEnd>)>>;

fn taps() -> &'static TapLog {
    static TAPS: OnceLock<TapLog> = OnceLock::new();
    TAPS.get_or_init(Default::default)
}

pub(super) fn record_tap(grant: &Grant, end: Option<StreamEnd>) {
    taps().lock_ok().push((grant.tab.clone(), end));
}

fn taps_of(tab: &str) -> Vec<Option<StreamEnd>> {
    taps().lock_ok().iter().filter(|(t, _)| t == tab).map(|(_, e)| *e).collect()
}

/// Waits up to 5 s for `tab`'s answer to end; its tap record.
async fn ended(tab: &str) -> Vec<Option<StreamEnd>> {
    for _ in 0..100 {
        let seen = taps_of(tab);
        if seen.iter().any(Option::is_some) {
            return seen;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    taps_of(tab)
}

fn plain_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn a_granted_request_reaches_the_provider_with_the_real_key_and_streams_back() {
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let upstream = stub_upstream(seen.clone(), release.clone()).await;
    let port = proxy(upstream, Some(FAKE_KEY), MAX_BODY).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:stream", None)).unwrap();
    let mut response = plain_client()
        .post(format!("{}/v1/messages?beta=true", base_url_on(port, Provider::Anthropic)))
        .header("authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "claude-code-20250219")
        .header("accept-encoding", "gzip")
        .header("content-type", "application/json")
        .body(r#"{"model":"claude-test","stream":true}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert_eq!(response.headers()["request-id"], "req_stub");
    // The first event arrives while the provider still holds the rest:
    // nothing is collected before it is passed on.
    let first = tokio::time::timeout(Duration::from_secs(10), response.chunk()).await.unwrap().unwrap().unwrap();
    assert_eq!(&first[..], SSE_FIRST.as_bytes());
    release.add_permits(1);
    let mut rest = Vec::new();
    while let Some(chunk) = response.chunk().await.unwrap() {
        rest.extend_from_slice(&chunk);
    }
    assert_eq!(rest, SSE_REST.as_bytes());

    {
        let requests = seen.requests.lock_ok();
        let (method, uri, headers, body) = &requests[0];
        assert_eq!(method, "POST");
        assert_eq!(uri, "/v1/messages?beta=true");
        assert_eq!(headers["x-api-key"], FAKE_KEY);
        assert!(headers.get("authorization").is_none());
        assert_eq!(headers["accept-encoding"], "identity", "the client's gzip is not forwarded");
        assert_eq!(headers["anthropic-version"], "2023-06-01");
        assert_eq!(headers["anthropic-beta"], "claude-code-20250219");
        assert_eq!(body, br#"{"model":"claude-test","stream":true}"#);
        for (_, value) in headers.iter() {
            assert!(!value.to_str().unwrap_or("").contains(&token), "the token never travels on");
        }
    }
    // C3's seam saw every chunk and exactly one clean end.
    let tapped = ended("e2e:stream").await;
    assert_eq!(tapped.last(), Some(&Some(StreamEnd::Complete)));
    assert_eq!(tapped.iter().filter(|e| e.is_some()).count(), 1, "{tapped:?}");
    assert!(tapped.len() >= 3, "{tapped:?}");
    on_tab_gone("e2e:stream");
}

#[tokio::test]
async fn the_proxy_refuses_before_the_provider_sees_anything() {
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let upstream = stub_upstream(seen.clone(), release).await;
    let port = proxy(upstream.clone(), Some(FAKE_KEY), 1024).await;
    let anthropic = base_url_on(port, Provider::Anthropic);
    let gemini = base_url_on(port, Provider::Gemini);
    let token = issue_grant(grant(Provider::Anthropic, "e2e:refuse", None)).unwrap();
    let c = plain_client();
    let post = |url: String| c.post(url).header("x-api-key", token.clone()).body("{}");

    // Unknown token, no token, another provider's route.
    let r = c.post(format!("{anthropic}/v1/messages")).header("x-api-key", "not-a-token").send().await.unwrap();
    assert_eq!(r.status(), 401);
    let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
    assert_eq!(json["error"]["type"], "authentication_error");
    assert_eq!(c.post(format!("{anthropic}/v1/messages")).send().await.unwrap().status(), 401);
    let r = post(format!("{gemini}/v1beta/models/x:generateContent")).send().await.unwrap();
    assert_eq!(r.status(), 401);
    let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
    assert_eq!(json["error"]["status"], "UNAUTHENTICATED");
    // A path no CLI needs, a browser request, a rebinding Host.
    assert_eq!(post(format!("{anthropic}/v1/files")).send().await.unwrap().status(), 404);
    assert_eq!(c.head(format!("{anthropic}/api/hello")).send().await.unwrap().status(), 401);
    assert_eq!(
        post(format!("{anthropic}/v1/messages")).header("origin", "https://example.org").send().await.unwrap().status(),
        403
    );
    assert_eq!(
        post(format!("{anthropic}/v1/messages")).header("host", "evil.example:80").send().await.unwrap().status(),
        403
    );
    // A body past the bound.
    let r = c
        .post(format!("{anthropic}/v1/messages"))
        .header("x-api-key", token.clone())
        .body(vec![b'x'; 4096])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 413);
    // Revoked with its tab.
    on_tab_gone("e2e:refuse");
    assert_eq!(post(format!("{anthropic}/v1/messages")).send().await.unwrap().status(), 401);
    assert_eq!(seen.hits.load(Ordering::SeqCst), 0, "the provider saw nothing");

    // A good token with no key saved: refused, with the reason.
    let port = proxy(upstream, None, 1024).await;
    let token = issue_grant(grant(Provider::Gemini, "e2e:nokey", None)).unwrap();
    let r = c
        .post(format!("{}/v1beta/models/x:generateContent?key={token}", base_url_on(port, Provider::Gemini)))
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
    assert!(json["error"]["message"].as_str().unwrap().contains("Manage CLIs"));
    assert_eq!(seen.hits.load(Ordering::SeqCst), 0);
    on_tab_gone("e2e:nokey");
}

#[tokio::test]
async fn gemini_requests_carry_the_key_in_its_header_and_drop_the_query_token() {
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    release.add_permits(1);
    let upstream = stub_upstream(seen.clone(), release).await;
    let port = proxy(upstream, Some(FAKE_KEY), MAX_BODY).await;
    let token = issue_grant(grant(Provider::Gemini, "e2e:gemini", None)).unwrap();
    let r = plain_client()
        .post(format!(
            "{}/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key={token}",
            base_url_on(port, Provider::Gemini)
        ))
        .header("x-goog-api-key", token.clone())
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let _ = r.bytes().await.unwrap();
    let requests = seen.requests.lock_ok();
    let (_, uri, headers, _) = &requests[0];
    assert_eq!(uri, "/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
    assert_eq!(headers["x-goog-api-key"], FAKE_KEY);
    drop(requests);
    on_tab_gone("e2e:gemini");
}

async fn stream_request(port: u16, tab: &str) -> (reqwest::Response, String) {
    let token = issue_grant(grant(Provider::Anthropic, tab, None)).unwrap();
    let response = plain_client()
        .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
        .header("authorization", format!("Bearer {token}"))
        .body("{}")
        .send()
        .await
        .unwrap();
    (response, token)
}

#[tokio::test]
async fn an_answer_the_client_drops_or_the_provider_breaks_off_still_ends_once() {
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let upstream = stub_upstream(seen.clone(), release.clone()).await;
    let port = proxy(upstream, Some(FAKE_KEY), MAX_BODY).await;

    // The client reads the first event and goes away.
    let (mut response, _) = stream_request(port, "e2e:aborted").await;
    assert!(response.chunk().await.unwrap().is_some());
    drop(response);
    assert_eq!(ended("e2e:aborted").await, vec![None, Some(StreamEnd::Aborted)]);

    // The provider breaks the stream off after the first event.
    let (mut response, _) = stream_request(port, "e2e:failed").await;
    assert!(response.chunk().await.unwrap().is_some());
    release.close();
    while let Ok(Some(_)) = response.chunk().await {}
    assert_eq!(ended("e2e:failed").await, vec![None, Some(StreamEnd::Failed)]);
    on_tab_gone("e2e:aborted");
    on_tab_gone("e2e:failed");
}

#[tokio::test]
async fn request_bodies_held_at_once_are_bounded() {
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(1024));
    let upstream = stub_upstream(seen.clone(), release).await;
    let (port, buffered) = proxy_with(upstream, Some(FAKE_KEY), |s| {
        s.max_body = 4096;
        s.max_buffered = 1000;
    })
    .await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:budget", None)).unwrap();
    let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
    let c = plain_client();
    let r = c.post(&url).header("x-api-key", token.clone()).body(vec![b'x'; 2000]).send().await.unwrap();
    assert_eq!(r.status(), 503);
    assert_eq!(r.headers()["x-should-retry"], "true");
    assert_eq!(seen.hits.load(Ordering::SeqCst), 0);
    assert_eq!(buffered.load(Ordering::SeqCst), 0, "a refused body leaves the budget");
    let r = c.post(&url).header("x-api-key", token).body(vec![b'x'; 500]).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let _ = r.bytes().await.unwrap();
    assert_eq!(seen.hits.load(Ordering::SeqCst), 1);
    assert_eq!(buffered.load(Ordering::SeqCst), 0, "a forwarded body leaves the budget");
    on_tab_gone("e2e:budget");
}

/// Reads from `tcp` until EOF or an error; whether that came within `wait`.
async fn closes_within(tcp: &mut tokio::net::TcpStream, wait: Duration) -> bool {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 4096];
    tokio::time::timeout(wait, async {
        loop {
            match tcp.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn idle_sockets_are_dropped_but_a_stream_in_flight_is_not() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let upstream = stub_upstream(seen.clone(), release.clone()).await;
    // The bound runs from the accept, so even the honest request at the end
    // must send its head within it: 300 ms was too short for a loaded CI
    // runner, which reset that request.
    let idle = Duration::from_secs(1);
    let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.idle_wait = idle).await;

    // A socket that never sends a request.
    let mut silent = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    assert!(closes_within(&mut silent, Duration::from_secs(5)).await);

    // A head trickled byte by byte does not reset the bound: the whole
    // trickle would take 3.6 bounds, and the socket closes well before.
    let mut trickle = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let started = Instant::now();
    for b in b"GET /anthropic/v1/models HTTP/1.1\r\n" {
        if trickle.write_all(&[*b]).await.is_err() {
            break;
        }
        tokio::time::sleep(idle / 10).await;
    }
    assert!(closes_within(&mut trickle, Duration::from_secs(5)).await);
    assert!(started.elapsed() < idle * 3, "took {:?}", started.elapsed());

    // A kept-alive socket after its answer.
    let mut kept = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    kept.write_all(format!("GET /anthropic/v1/models HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut head = vec![0u8; 4096];
    let n = kept.read(&mut head).await.unwrap();
    assert!(String::from_utf8_lossy(&head[..n]).starts_with("HTTP/1.1 401"));
    assert!(closes_within(&mut kept, Duration::from_secs(5)).await);

    // A stream quiet for longer than the bound runs to its end.
    let (mut response, _) = stream_request(port, "e2e:idle").await;
    assert!(response.chunk().await.unwrap().is_some());
    tokio::time::sleep(idle * 3).await;
    release.add_permits(1);
    let mut rest = Vec::new();
    while let Some(chunk) = response.chunk().await.unwrap() {
        rest.extend_from_slice(&chunk);
    }
    assert_eq!(rest, SSE_REST.as_bytes());
    on_tab_gone("e2e:idle");
}

#[test]
fn the_remembered_port_is_bound_again_when_free() {
    let free = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = free.local_addr().unwrap().port();
    drop(free);
    let again = bind_listener(Some(port)).unwrap();
    assert_eq!(again.local_addr().unwrap().port(), port);
    // Taken meanwhile: any free port instead.
    let other = bind_listener(Some(port)).unwrap();
    assert_ne!(other.local_addr().unwrap().port(), port);
    assert_ne!(bind_listener(None).unwrap().local_addr().unwrap().port(), 0);
}

const OPENAI_SSE: &str = concat!(
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stub\",\"object\":\"response\",\"status\":\"in_progress\",\"output\":[],\"usage\":null}}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_stub\",\"output_index\":0,\"content_index\":0,\"delta\":\"STUB-REPLY-OK\"}\n\n",
    "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"msg_stub\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"STUB-REPLY-OK\",\"annotations\":[]}]}}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stub\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-6.1-sol\",\"output\":[],\"usage\":{\"total_tokens\":1300,\"input_tokens\":1000,\"input_tokens_details\":{\"cached_tokens\":800},\"output_tokens\":300,\"output_tokens_details\":{\"reasoning_tokens\":200}}}}\n\n",
);

async fn openai_stub(seen: Arc<Seen>) -> String {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().fallback(move |req: Request| {
        let seen = seen.clone();
        async move {
            let (parts, body) = req.into_parts();
            let body = axum::body::to_bytes(body, MAX_BODY).await.unwrap();
            seen.hits.fetch_add(1, Ordering::SeqCst);
            seen.requests.lock_ok().push((parts.method.to_string(), parts.uri.to_string(), parts.headers, body.to_vec()));
            let mut response = Response::new(Body::from(OPENAI_SSE));
            response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
            response
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn openai_swaps_bearer_auth_meters_responses_and_enforces_the_budget() {
    let seen = Arc::new(Seen::default());
    let upstream = openai_stub(seen.clone()).await;
    let budget = test_budget(ROOMY);
    let book = budget.book.clone();
    let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = budget).await;
    let token = issue_grant(grant(Provider::OpenAi, "e2e:openai", None)).unwrap();
    let url = format!("{}/v1/responses", base_url_on(port, Provider::OpenAi));
    let client = plain_client();
    let response = client.post(&url).bearer_auth(&token).body(r#"{"model":"gpt-6.1-sol","stream":true}"#).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), OPENAI_SSE);
    let models = charged(&book, Provider::OpenAi).await;
    assert_eq!(models["gpt-6.1-sol"].billed, 580);
    {
        let requests = seen.requests.lock_ok();
        let (method, path, headers, _) = &requests[0];
        assert_eq!((method.as_str(), path.as_str()), ("POST", "/v1/responses"));
        assert_eq!(headers["authorization"], format!("Bearer {FAKE_KEY}"));
        assert!(!headers.values().any(|v| v.as_bytes().windows(token.len()).any(|w| w == token.as_bytes())));
    }
    book.record(Provider::OpenAi, &spent_charge(20_000_000), chrono::Utc::now());
    let response = client.post(&url).bearer_auth(&token).body("{}").send().await.unwrap();
    assert_eq!(response.status(), 429);
    let json: serde_json::Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(json["error"]["code"], "insufficient_quota");
    assert!(json["error"]["message"].as_str().unwrap().contains("OpenAI"));
    assert_eq!(seen.hits.load(Ordering::SeqCst), 1);
    for path in ["/v1/files", "/v1/chat/completions", "/v1/responses/resp_other", "/v1/batches"] {
        assert!(!path_allowed(Provider::OpenAi, &Method::POST, path), "{path}");
    }
    assert!(path_allowed(Provider::OpenAi, &Method::POST, "/v1/responses/compact"));
    on_tab_gone("e2e:openai");
    assert_eq!(client.post(&url).bearer_auth(&token).body("{}").send().await.unwrap().status(), 401);
}

#[tokio::test]
async fn openai_requests_the_meter_cannot_see_are_refused_in_openais_error_shape_and_never_sent() {
    let seen = Arc::new(Seen::default());
    let upstream = openai_stub(seen.clone()).await;
    let budget = test_budget(ROOMY);
    let book = budget.book.clone();
    let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = budget).await;
    let token = issue_grant(grant(Provider::OpenAi, "e2e:openai-unmetered", None)).unwrap();
    let url = format!("{}/v1/responses", base_url_on(port, Provider::OpenAi));
    let client = plain_client();
    let refused = [
        (r#"{"model":"gpt-6.1-sol","background":true}"#, "background responses are refused"),
        (r#"{"model":"gpt-6.1-sol","service_tier":"priority"}"#, "service_tier"),
        (r#"{"model":"gpt-6.1-sol","service_tier":"ultrafast"}"#, "service_tier"),
        ("this is not json", "not one JSON object"),
        (r#"{"background":true,"background":false}"#, "not one JSON object"),
        ("[]", "not one JSON object"),
    ];
    for (body, says) in refused {
        let response = client.post(&url).bearer_auth(&token).body(body).send().await.unwrap();
        assert_eq!(response.status(), 400, "{body}");
        assert_eq!(response.headers()["x-should-retry"], "false");
        let json: serde_json::Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        assert_eq!(json["error"]["type"], "invalid_request_error", "{body}");
        let message = json["error"]["message"].as_str().unwrap();
        assert!(message.contains(says), "{body}: {message}");
    }
    assert_eq!(seen.hits.load(Ordering::SeqCst), 0, "nothing reached OpenAI");
    assert_eq!(book.reserved(Provider::OpenAi), 0, "a refusal holds nothing");
    // Compaction is metered the same way.
    let compact = format!("{}/v1/responses/compact", base_url_on(port, Provider::OpenAi));
    let response = client.post(&compact).bearer_auth(&token).body(r#"{"background":true}"#).send().await.unwrap();
    assert_eq!(response.status(), 400);
    // Requests the meter can read go through, with the organization and
    // project headers dropped.
    for body in [
        r#"{"model":"gpt-6.1-sol","stream":true,"background":false}"#,
        r#"{"model":"gpt-6.1-sol","stream":true,"service_tier":"flex"}"#,
        r#"{"model":"gpt-6.1-sol","stream":true,"service_tier":"auto"}"#,
    ] {
        let response = client
            .post(&url)
            .bearer_auth(&token)
            .header("OpenAI-Organization", "org_elsewhere")
            .header("openai-project", "proj_elsewhere")
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "{body}");
        let _ = response.bytes().await.unwrap();
    }
    let requests = seen.requests.lock_ok();
    assert_eq!(requests.len(), 3);
    for (_, _, headers, _) in requests.iter() {
        assert!(headers.get("openai-organization").is_none() && headers.get("openai-project").is_none());
        assert_eq!(headers["authorization"], format!("Bearer {FAKE_KEY}"));
    }
    drop(requests);
    on_tab_gone("e2e:openai-unmetered");
}

/// Isolated real-CLI check, with a scratch home and a loopback fake
/// provider only. C2_PROBE_CODEX names the installed executable.
#[tokio::test]
#[ignore]
async fn codex_cli_talks_to_the_proxy() {
    let codex = std::env::var_os("C2_PROBE_CODEX").expect("C2_PROBE_CODEX executable");
    let seen = Arc::new(Seen::default());
    let upstream = openai_stub(seen.clone()).await;
    let port = proxy(upstream, Some(FAKE_KEY), MAX_BODY).await;
    let token = issue_grant(grant(Provider::OpenAi, "e2e:codex-cli", None)).unwrap();
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join(".codex")).unwrap();
    let mut command = tokio::process::Command::new(codex);
    command.env_clear().env("HOME", home.path()).env("CODEX_HOME", home.path().join(".codex"))
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("OPENAI_API_KEY", &token)
        .args(crate::services::agent_api_keys::codex_proxy_args(&base_url_on(port, Provider::OpenAi)))
        .args(["exec", "--skip-git-repo-check", "-m", "gpt-6.1-sol", "Reply hi without tools."])
        .current_dir(home.path()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(45), command.output()).await.unwrap().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("STUB-REPLY-OK"));
    let requests = seen.requests.lock_ok();
    assert!(requests.iter().any(|(m, path, _, _)| m == "POST" && path == "/v1/responses"));
    for (_, _, headers, _) in requests.iter() {
        assert_eq!(headers["authorization"], format!("Bearer {FAKE_KEY}"));
    }
    assert!(!home.path().join(".codex").join("auth.json").exists(), "no login file was written");
    on_tab_gone("e2e:codex-cli");
}

/// A0-style check of the real Claude CLI against this proxy and a stub
/// provider: no network, a fake key, a scratch `HOME`. Run by hand:
/// `C2_PROBE_CLAUDE=<path to the claude binary> cargo test -- --ignored
/// claude_cli_talks_to_the_proxy`. Off the tab record: the child gets a
/// cleared environment.
#[tokio::test]
#[ignore]
async fn claude_cli_talks_to_the_proxy() {
    let Some(claude) = std::env::var_os("C2_PROBE_CLAUDE") else { return };
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    // Every response streams through at once.
    release.add_permits(1024);
    let upstream = stub_upstream(seen.clone(), release.clone()).await;
    let port = proxy(upstream, Some(FAKE_KEY), MAX_BODY).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:claude", None)).unwrap();
    let home = tempfile::tempdir().unwrap();
    let out = tokio::process::Command::new(claude)
        .env_clear()
        .env("HOME", home.path())
        .env("PATH", "/usr/bin:/bin")
        .env("ANTHROPIC_BASE_URL", base_url_on(port, Provider::Anthropic))
        .env("ANTHROPIC_AUTH_TOKEN", &token)
        .env("DISABLE_AUTOUPDATER", "1")
        .args(["-p", "say hi"])
        .current_dir(home.path())
        .output();
    let out = tokio::time::timeout(Duration::from_secs(120), out).await.unwrap().unwrap();
    eprintln!("exit: {:?}\nstdout: {}", out.status, String::from_utf8_lossy(&out.stdout));
    let requests = seen.requests.lock_ok();
    for (method, uri, headers, body) in requests.iter() {
        eprintln!(
            "upstream saw {method} {uri}; real key in its header: {}; bearer header present: {}; body {} bytes",
            headers.get("x-api-key").map(|v| v == FAKE_KEY).unwrap_or(false),
            headers.contains_key("authorization"),
            body.len()
        );
        assert_eq!(headers["x-api-key"], FAKE_KEY);
        assert!(!headers.contains_key("authorization"));
    }
    assert!(requests.iter().any(|(m, u, _, _)| m == "POST" && u.starts_with("/v1/messages")));
    drop(requests);
    on_tab_gone("e2e:claude");
}

// ---- a hosted server administrator's key (#2389) -----------------------

fn admin_grant(tab: &str) -> Grant {
    Grant { admin: Some("claude"), ..grant(Provider::Anthropic, tab, None) }
}

/// Direct delivery: the request goes to the provider with the
/// administrator's key, the user's own key is not needed, and nothing is
/// charged to (or refused by) the user's own limit.
#[tokio::test]
async fn an_admin_grant_forwards_with_the_administrators_key_outside_the_own_limit() {
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(16));
    let upstream = stub_upstream(seen.clone(), release).await;
    let budget = test_budget(None);
    let book = budget.book.clone();
    let (port, _) = proxy_with(upstream, None, |s| {
        s.keys = KeySource::FixedAdmin { own: None, admin: Some(("fake-admin-key", None)) };
        s.budget = budget;
    })
    .await;
    let token = issue_grant(admin_grant("e2e:admin-direct")).unwrap();
    let r = plain_client()
        .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
        .header("authorization", format!("Bearer {token}"))
        .body(r#"{"model":"claude-test","max_tokens":10}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "no own key and no own limit, still forwarded");
    let _ = r.bytes().await.unwrap();
    {
        let requests = seen.requests.lock_ok();
        let (_, uri, headers, _) = &requests[0];
        assert_eq!(uri, "/v1/messages");
        assert_eq!(headers["x-api-key"], "fake-admin-key");
    }
    ended("e2e:admin-direct").await;
    assert_eq!(book.billed(Provider::Anthropic, chrono::Utc::now()), 0, "never on the user's own ledger");
    assert!(book.snapshot(chrono::Utc::now()).providers.is_empty());
    on_tab_gone("e2e:admin-direct");
}

/// Brokered delivery: the request goes to the broker's URL (plain HTTP on
/// loopback) with the user's broker token, never to the provider.
#[tokio::test]
async fn a_brokered_admin_grant_goes_to_the_broker_with_the_users_token() {
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(16));
    let broker = stub_upstream(seen.clone(), release).await;
    let provider_seen = Arc::new(Seen::default());
    let provider = stub_upstream(provider_seen.clone(), Arc::new(tokio::sync::Semaphore::new(16))).await;
    let (port, _) = proxy_with(provider, None, |s| {
        s.keys = KeySource::FixedAdmin { own: None, admin: Some(("broker-fake-token", Some(format!("{broker}/claude")))) };
    })
    .await;
    let token = issue_grant(admin_grant("e2e:admin-broker")).unwrap();
    let r = plain_client()
        .post(format!("{}/v1/messages?beta=true", base_url_on(port, Provider::Anthropic)))
        .header("authorization", format!("Bearer {token}"))
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let _ = r.bytes().await.unwrap();
    {
        let requests = seen.requests.lock_ok();
        let (_, uri, headers, _) = &requests[0];
        assert_eq!(uri, "/claude/v1/messages?beta=true");
        assert_eq!(headers["x-api-key"], "broker-fake-token");
        for (_, value) in headers.iter() {
            assert!(!value.to_str().unwrap_or("").contains(&token), "the proxy token never travels on");
        }
    }
    assert_eq!(provider_seen.hits.load(Ordering::SeqCst), 0, "the provider is never called directly");
    on_tab_gone("e2e:admin-broker");
}

/// Withdrawn (or the user switched back): refused in the provider's
/// shape, naming the way back, and nothing reaches the provider. An own
/// grant on the same proxy is not affected.
#[tokio::test]
async fn a_withdrawn_admin_key_is_refused_and_an_own_grant_still_works() {
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(16));
    let upstream = stub_upstream(seen.clone(), release).await;
    let (port, _) = proxy_with(upstream, None, |s| {
        s.keys = KeySource::FixedAdmin { own: Some(FAKE_KEY), admin: None };
    })
    .await;
    let token = issue_grant(admin_grant("e2e:admin-gone")).unwrap();
    let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
    let r = plain_client().post(&url).header("x-api-key", token).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 401);
    assert_eq!(r.headers()["x-should-retry"], "false");
    let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
    assert_eq!(json["error"]["type"], "authentication_error");
    assert!(json["error"]["message"].as_str().unwrap().contains("no longer offers you"));
    assert_eq!(seen.hits.load(Ordering::SeqCst), 0);
    on_tab_gone("e2e:admin-gone");
    let own = issue_grant(grant(Provider::Anthropic, "e2e:own-beside", None)).unwrap();
    let r = plain_client().post(format!("{url}/count_tokens")).header("x-api-key", own).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 200);
    let _ = r.bytes().await.unwrap();
    on_tab_gone("e2e:own-beside");
}

// ---- the spending limit (C3) ------------------------------------------

/// A memory-only ledger with a fixed monthly limit in billed tokens.
fn test_budget(limit: Option<u64>) -> Budget {
    Budget { book: Arc::new(super::super::api_usage::Book::new(None)), limits: Limits::Fixed(limit) }
}

/// Plenty of room: no test request comes near it.
const ROOMY: Option<u64> = Some(20_000_000);

/// A charge of `billed` billed tokens.
fn spent_charge(billed: u64) -> super::super::api_prices::Charge {
    super::super::api_prices::Charge {
        model: "claude-opus-5-5".into(),
        known: true,
        output: billed,
        ..Default::default()
    }
}

#[tokio::test]
async fn a_streamed_answer_is_charged_to_the_ledger_once_it_ends() {
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(16));
    let upstream = stub_upstream(seen.clone(), release).await;
    let budget = test_budget(ROOMY);
    let book = budget.book.clone();
    let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = budget).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:metered", None)).unwrap();
    let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
    let r = plain_client().post(&url).header("x-api-key", token.clone()).body("{}").send().await.unwrap();
    let _ = r.bytes().await.unwrap();
    ended("e2e:metered").await;
    let ledger = book.snapshot(chrono::Utc::now());
    let models = &ledger.providers["anthropic"].models;
    // The stub's model is not in the table: highest Anthropic rate, flagged.
    let m = &models["claude-stub"];
    assert!(m.unknown);
    assert_eq!((m.input, m.output, m.requests), (5, 3, 1));
    // Billed tokens are what the limit counts; the dollars an estimate.
    assert_eq!(m.billed, crate::services::server::keys_wire::billed_tokens(m.input, m.cache_write, m.output, m.cache_read));
    assert_eq!(ledger.billed(Provider::Anthropic), m.billed);
    assert!((ledger.spent_usd(Provider::Anthropic) - (5.0 * 10.0 + 3.0 * 50.0) / 1e6).abs() < 1e-12);
    // Token counting costs nothing and is not metered.
    let r = plain_client()
        .post(format!("{url}/count_tokens"))
        .header("x-api-key", token)
        .body("{}")
        .send()
        .await
        .unwrap();
    let _ = r.bytes().await.unwrap();
    ended("e2e:metered").await;
    assert_eq!(book.snapshot(chrono::Utc::now()).providers["anthropic"].models["claude-stub"].requests, 1);
    on_tab_gone("e2e:metered");
}

#[tokio::test]
async fn a_refused_own_key_is_answered_in_the_proxys_words_and_costs_nothing() {
    // Anthropic's answer to a bad key. Passed on, its "x-api-key" made
    // Claude show "Not logged in · Please run /login".
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().fallback(|| async {
        let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        let mut r = Response::new(Body::from(body));
        *r.status_mut() = StatusCode::UNAUTHORIZED;
        r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        r
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let budget = test_budget(ROOMY);
    let book = budget.book.clone();
    let (port, _) = proxy_with(format!("http://{addr}"), Some(FAKE_KEY), |s| s.budget = budget).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:key-rejected", None)).unwrap();
    let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
    let r = plain_client().post(&url).header("x-api-key", token).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 401);
    assert_eq!(r.headers()["x-should-retry"], "false");
    let text = r.text().await.unwrap();
    assert!(!text.to_lowercase().contains("x-api-key"), "{text}");
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(json["error"]["type"], "authentication_error");
    assert!(json["error"]["message"].as_str().unwrap().contains("Anthropic rejected the API key"));
    assert_eq!(book.snapshot(chrono::Utc::now()).billed(Provider::Anthropic), 0);
    on_tab_gone("e2e:key-rejected");
}

/// A provider that answers every request with `status` and `body`, and
/// records the credential header it was sent.
async fn answering(status: StatusCode, body: &'static str, seen: Arc<Seen>) -> String {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().fallback(move |req: Request| {
        let seen = seen.clone();
        async move {
            seen.requests.lock_ok().push((req.method().to_string(), req.uri().to_string(), req.headers().clone(), Vec::new()));
            let mut r = Response::new(Body::from(body));
            *r.status_mut() = status;
            r
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn a_key_is_checked_with_the_provider_before_it_is_saved() {
    let seen = Arc::new(Seen::default());
    let refusing = answering(StatusCode::UNAUTHORIZED, r#"{"type":"error"}"#, seen.clone()).await;
    let err = check_key_at(&refusing, Provider::Anthropic, FAKE_KEY, None, false).await.unwrap_err();
    assert!(err.contains("Anthropic rejected"), "{err}");
    {
        let requests = seen.requests.lock_ok();
        let (method, uri, headers, _) = &requests[0];
        assert_eq!((method.as_str(), uri.as_str()), ("GET", "/v1/models"));
        assert_eq!(headers["x-api-key"], FAKE_KEY);
    }
    let err = check_key_at(&refusing, Provider::OpenAi, FAKE_KEY, None, false).await.unwrap_err();
    assert!(err.contains("OpenAI rejected"), "{err}");
    assert_eq!(seen.requests.lock_ok()[1].2["authorization"], format!("Bearer {FAKE_KEY}"));

    let gemini_bad = answering(StatusCode::BAD_REQUEST, r#"{"error":{"details":[{"reason":"API_KEY_INVALID"}]}}"#, seen.clone()).await;
    assert!(check_key_at(&gemini_bad, Provider::Gemini, FAKE_KEY, None, false).await.is_err());
    // Another 400 is not a verdict on the key.
    let gemini_other = answering(StatusCode::BAD_REQUEST, r#"{"error":{}}"#, seen.clone()).await;
    assert!(check_key_at(&gemini_other, Provider::Gemini, FAKE_KEY, None, false).await.is_ok());

    let accepting = answering(StatusCode::OK, r#"{"data":[]}"#, seen.clone()).await;
    assert!(check_key_at(&accepting, Provider::Anthropic, FAKE_KEY, None, false).await.is_ok());
    // Offline: saved untested.
    let gone = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap();
    assert!(check_key_at(&format!("http://{gone}"), Provider::Anthropic, FAKE_KEY, None, false).await.is_ok());
}

#[tokio::test]
async fn a_keys_model_listing_is_read_in_the_providers_own_shape() {
    let seen = Arc::new(Seen::default());
    let stored = StoredKey { key: FAKE_KEY.to_string(), workspace: Some(WS_A.to_string()) };
    let gemini = answering(StatusCode::OK, r#"{"models":[{"name":"models/gemini-3.5-flash"}]}"#, seen.clone()).await;
    assert_eq!(key_models_at(&gemini, Provider::Gemini, &stored, false).await.unwrap(), ["gemini-3.5-flash"]);
    assert_eq!(seen.requests.lock_ok()[0].1, "/v1beta/models?pageSize=1000");
    assert_eq!(seen.requests.lock_ok()[0].2["x-goog-api-key"], FAKE_KEY);
    let anthropic = answering(StatusCode::OK, r#"{"data":[{"id":"claude-opus-5-5"}]}"#, seen.clone()).await;
    assert_eq!(key_models_at(&anthropic, Provider::Anthropic, &stored, false).await.unwrap(), ["claude-opus-5-5"]);
    assert_eq!(seen.requests.lock_ok()[1].2[WORKSPACE_HEADER], WS_A);
    let refused = answering(StatusCode::UNAUTHORIZED, r#"{"data":[{"id":"x"}]}"#, seen.clone()).await;
    assert!(key_models_at(&refused, Provider::OpenAi, &stored, false).await.is_none());
    let gone = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap();
    assert!(key_models_at(&format!("http://{gone}"), Provider::OpenAi, &stored, false).await.is_none());
}

/// Anthropic for a key that is not scoped to a workspace: a listing
/// without `anthropic-workspace-id` is a 400 naming the header, with one
/// it answers for a workspace in `members` and is a 404 for another; the
/// key lists `listed` (a JSON `data` array).
async fn unscoped_anthropic(members: &'static [&'static str], listed: &'static str, seen: Arc<Seen>) -> String {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().fallback(move |req: Request| {
        let seen = seen.clone();
        async move {
            seen.requests.lock_ok().push((req.method().to_string(), req.uri().to_string(), req.headers().clone(), Vec::new()));
            let (status, body) = if req.uri().path() == "/v1/organizations/workspaces" {
                (StatusCode::OK, format!(r#"{{"data":{listed},"has_more":false}}"#))
            } else {
                match req.headers().get(WORKSPACE_HEADER).and_then(|v| v.to_str().ok()) {
                    None => (StatusCode::BAD_REQUEST, r#"{"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"}}"#.to_string()),
                    Some(id) if members.contains(&id) => (StatusCode::OK, r#"{"data":[]}"#.to_string()),
                    Some(_) => (StatusCode::NOT_FOUND, r#"{"type":"error","error":{"type":"not_found_error"}}"#.to_string()),
                }
            };
            let mut r = Response::new(Body::from(body));
            *r.status_mut() = status;
            r
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

const WS_A: &str = "wrkspc_01AAAAAAAAAAAAAAAAAAAAAAAA";
const WS_B: &str = "wrkspc_01BBBBBBBBBBBBBBBBBBBBBBBB";

#[tokio::test]
async fn an_unscoped_anthropic_key_gets_its_only_workspace() {
    let seen = Arc::new(Seen::default());
    let listed = r#"[{"id":"wrkspc_01AAAAAAAAAAAAAAAAAAAAAAAA","name":"Default","archived_at":null},
            {"id":"wrkspc_01BBBBBBBBBBBBBBBBBBBBBBBB","name":"Old","archived_at":"2026-01-01T00:00:00Z"}]"#;
    let base = unscoped_anthropic(&[WS_A], listed, seen.clone()).await;
    let found = check_key_at(&base, Provider::Anthropic, FAKE_KEY, None, false).await.unwrap();
    assert_eq!(found, KeyCheck::Save { workspace: Some(WS_A.to_string()) });
    let requests = seen.requests.lock_ok();
    assert_eq!(requests[1].1, "/v1/organizations/workspaces?include_default=true&limit=100");
    assert_eq!(requests[1].2["x-api-key"], FAKE_KEY);
    assert_eq!(requests[2].2[WORKSPACE_HEADER], WS_A);
}

#[tokio::test]
async fn an_unscoped_anthropic_key_with_several_workspaces_asks_which() {
    let seen = Arc::new(Seen::default());
    let listed = r#"[{"id":"wrkspc_01AAAAAAAAAAAAAAAAAAAAAAAA","name":"Default"},{"id":"wrkspc_01BBBBBBBBBBBBBBBBBBBBBBBB","name":"Claude Code"}]"#;
    let base = unscoped_anthropic(&[WS_A], listed, seen.clone()).await;
    let found = check_key_at(&base, Provider::Anthropic, FAKE_KEY, None, false).await.unwrap();
    assert_eq!(
        found,
        KeyCheck::PickWorkspace(vec![
            Workspace { id: WS_A.into(), name: "Default".into() },
            Workspace { id: WS_B.into(), name: "Claude Code".into() },
        ])
    );
    // The picked one is checked; one the key cannot use is refused.
    let picked = check_key_at(&base, Provider::Anthropic, FAKE_KEY, Some(WS_A), false).await.unwrap();
    assert_eq!(picked, KeyCheck::Save { workspace: Some(WS_A.to_string()) });
    let err = check_key_at(&base, Provider::Anthropic, FAKE_KEY, Some(WS_B), false).await.unwrap_err();
    assert!(err.contains(WS_B), "{err}");
    let err = check_key_at(&base, Provider::Anthropic, FAKE_KEY, Some("wrkspc_x\r\ny: z"), false).await.unwrap_err();
    assert!(err.contains("not a workspace id"), "{err}");
}

#[tokio::test]
async fn an_unscoped_key_that_cannot_list_workspaces_asks_for_an_id() {
    let seen = Arc::new(Seen::default());
    let base = unscoped_anthropic(&[WS_A], "null", seen).await;
    let found = check_key_at(&base, Provider::Anthropic, FAKE_KEY, None, false).await.unwrap();
    assert_eq!(found, KeyCheck::PickWorkspace(Vec::new()));
}

#[tokio::test]
async fn a_stored_workspace_is_named_on_every_request() {
    let seen = Arc::new(Seen::default());
    let base = unscoped_anthropic(&[WS_A], "[]", seen.clone()).await;
    let (port, _) = proxy_with(base, None, |s| s.keys = KeySource::FixedInWorkspace(FAKE_KEY, WS_A)).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:workspace", None)).unwrap();
    let url = format!("{}/v1/models", base_url_on(port, Provider::Anthropic));
    let r = plain_client()
        .get(&url)
        .header("x-api-key", token)
        .header(WORKSPACE_HEADER, WS_B)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let headers = &seen.requests.lock_ok()[0].2;
    assert_eq!(headers["x-api-key"], FAKE_KEY);
    assert_eq!(headers.get_all(WORKSPACE_HEADER).iter().collect::<Vec<_>>(), vec![WS_A]);
    on_tab_gone("e2e:workspace");
}

#[tokio::test]
async fn a_key_without_its_workspace_is_answered_in_the_proxys_words() {
    let seen = Arc::new(Seen::default());
    let base = unscoped_anthropic(&[WS_A], "[]", seen).await;
    let budget = test_budget(ROOMY);
    let book = budget.book.clone();
    let (port, _) = proxy_with(base, Some(FAKE_KEY), |s| s.budget = budget).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:no-workspace", None)).unwrap();
    let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
    let r = plain_client().post(&url).header("x-api-key", token).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 400);
    assert_eq!(r.headers()["x-should-retry"], "false");
    let json: serde_json::Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
    assert_eq!(json["error"]["type"], "invalid_request_error");
    assert!(json["error"]["message"].as_str().unwrap().contains("save it again to pick one"));
    assert_eq!(book.snapshot(chrono::Utc::now()).billed(Provider::Anthropic), 0);
    on_tab_gone("e2e:no-workspace");
}

#[tokio::test]
async fn a_claude_subscription_token_is_refused_without_asking_anthropic() {
    let seen = Arc::new(Seen::default());
    let accepting = answering(StatusCode::OK, "{}", seen.clone()).await;
    let err = check_key_at(&accepting, Provider::Anthropic, "sk-ant-oat01-xyz", None, false).await.unwrap_err();
    assert!(err.contains("subscription token"), "{err}");
    assert!(seen.requests.lock_ok().is_empty());
}

#[tokio::test]
async fn at_the_limit_billed_requests_are_refused_in_the_provider_shape() {
    let seen = Arc::new(Seen::default());
    let release = Arc::new(tokio::sync::Semaphore::new(16));
    let upstream = stub_upstream(seen.clone(), release).await;
    let budget = test_budget(Some(20_000));
    budget.book.record(Provider::Anthropic, &spent_charge(20_000), chrono::Utc::now());
    budget.book.record(Provider::Gemini, &spent_charge(25_000), chrono::Utc::now());
    let (port, _) = proxy_with(upstream.clone(), Some(FAKE_KEY), |s| s.budget = budget).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:limit", None)).unwrap();
    let anthropic = base_url_on(port, Provider::Anthropic);
    let c = plain_client();
    let r = c.post(format!("{anthropic}/v1/messages")).header("x-api-key", token.clone()).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 429);
    assert_eq!(r.headers()["x-should-retry"], "false");
    let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
    assert_eq!(json["type"], "error");
    assert_eq!(json["error"]["type"], "rate_limit_error");
    let message = json["error"]["message"].as_str().unwrap();
    assert!(message.starts_with(crate::app_name!()), "{message}");
    assert!(message.contains("budget for Anthropic reached") && message.contains("Manage CLIs"), "{message}");
    assert_eq!(seen.hits.load(Ordering::SeqCst), 0, "the provider saw nothing");
    // What costs nothing still passes.
    let r = c.post(format!("{anthropic}/v1/messages/count_tokens")).header("x-api-key", token).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 200);
    let _ = r.bytes().await.unwrap();
    assert_eq!(seen.hits.load(Ordering::SeqCst), 1);
    on_tab_gone("e2e:limit");

    // Gemini's shape.
    let token = issue_grant(grant(Provider::Gemini, "e2e:limit-gemini", None)).unwrap();
    let r = c
        .post(format!("{}/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse", base_url_on(port, Provider::Gemini)))
        .header("x-goog-api-key", token)
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 429);
    let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
    assert_eq!(json["error"]["status"], "RESOURCE_EXHAUSTED");
    assert_eq!(json["error"]["code"], 429);
    assert!(json["error"]["message"].as_str().unwrap().contains("Google Gemini"));
    on_tab_gone("e2e:limit-gemini");

    // A key without a limit (saved by an earlier build): refused until set.
    let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = test_budget(None)).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:nolimit", None)).unwrap();
    let r = c
        .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
        .header("x-api-key", token)
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 429);
    let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
    assert!(json["error"]["message"].as_str().unwrap().contains("no monthly API budget"));
    assert_eq!(seen.hits.load(Ordering::SeqCst), 1);
    on_tab_gone("e2e:nolimit");
}

/// The ledger's models of `provider` once a charge landed.
async fn charged(book: &super::super::api_usage::Book, provider: Provider) -> std::collections::BTreeMap<String, super::super::api_usage::ModelUsage> {
    for _ in 0..100 {
        let ledger = book.snapshot(chrono::Utc::now());
        if let Some(u) = ledger.providers.get(provider.id()).filter(|u| !u.models.is_empty()) {
            return u.models.clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Default::default()
}

#[tokio::test]
async fn a_client_that_hangs_up_before_the_final_count_is_charged_an_estimate() {
    let seen = Arc::new(Seen::default());
    // The stub sends `message_start` and holds the rest back.
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let upstream = stub_upstream(seen.clone(), release).await;
    let budget = test_budget(ROOMY);
    let book = budget.book.clone();
    let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = budget).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:hangup", None)).unwrap();
    let mut response = plain_client()
        .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
        .header("x-api-key", token)
        .body(r#"{"model":"claude-opus-5-5","max_tokens":64000,"stream":true}"#)
        .send()
        .await
        .unwrap();
    assert!(response.chunk().await.unwrap().is_some());
    tokio::time::sleep(Duration::from_millis(1100)).await;
    drop(response);
    let models = charged(&book, Provider::Anthropic).await;
    let m = &models["claude-stub"];
    assert_eq!(m.input, 5, "message_start's input as reported");
    assert!(m.output >= super::super::api_meter::ANTHROPIC_TOKENS_PER_SEC, "output by time, not message_start's 1: {}", m.output);
    on_tab_gone("e2e:hangup");
}

#[tokio::test]
async fn a_client_that_leaves_before_the_answer_begins_is_charged_an_estimate() {
    // An upstream that takes the request and never answers (a long
    // non-streaming turn).
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().fallback(|req: Request| async move {
        let _ = axum::body::to_bytes(req.into_body(), usize::MAX).await;
        std::future::pending::<Response>().await
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let budget = test_budget(ROOMY);
    let book = budget.book.clone();
    let (port, _) = proxy_with(format!("http://{addr}"), Some(FAKE_KEY), |s| s.budget = budget).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:left", None)).unwrap();
    let body = format!(r#"{{"model":"claude-opus-5-5","max_tokens":100,"messages":[{{"role":"user","content":"{}"}}]}}"#, "x".repeat(3000));
    let sent = plain_client()
        .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
        .header("x-api-key", token)
        .body(body.clone())
        .timeout(Duration::from_millis(1500))
        .send()
        .await;
    assert!(sent.is_err(), "no answer ever came");
    let models = charged(&book, Provider::Anthropic).await;
    let m = &models["claude-opus-5-5"];
    assert_eq!(m.input, (body.len() as u64).div_ceil(3));
    assert_eq!(m.output, 100, "time-bounded, capped at the request's max_tokens");
    assert!(!m.unknown);
    on_tab_gone("e2e:left");
}

/// Waits up to 5 s for `provider`'s reservations to come to `tokens`.
async fn reserved_comes_to(book: &super::super::api_usage::Book, provider: Provider, tokens: u64) -> u64 {
    for _ in 0..100 {
        if book.reserved(provider) == tokens {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    book.reserved(provider)
}

#[tokio::test]
async fn requests_in_flight_hold_the_limit_until_they_end_however_they_end() {
    let seen = Arc::new(Seen::default());
    // The stub sends `message_start` and holds the rest until released.
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let upstream = stub_upstream(seen.clone(), release.clone()).await;
    let body = r#"{"model":"claude-opus-5-5","max_tokens":40000,"stream":true}"#;
    let worst = {
        let mut m = super::super::api_meter::Meter::new(Provider::Anthropic, super::super::api_meter::Billing::Usage { model: None });
        m.request(body.as_bytes());
        m.worst_case_billed(&super::super::api_usage::month_of(chrono::Utc::now()))
    };
    // Room for two worst cases, not three.
    let held_one = worst;
    let budget = test_budget(Some(worst * 5 / 2));
    let book = budget.book.clone();
    let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = budget).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:inflight", None)).unwrap();
    let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
    let c = plain_client();
    let send = || c.post(&url).header("x-api-key", token.clone()).body(body).send();
    let mut a = send().await.unwrap();
    let mut b = send().await.unwrap();
    assert!(a.chunk().await.unwrap().is_some() && b.chunk().await.unwrap().is_some());
    assert_eq!(book.reserved(Provider::Anthropic), 2 * held_one);
    // A third is refused before the provider sees it, though nothing is
    // spent yet.
    let r = send().await.unwrap();
    assert_eq!(r.status(), 429);
    assert_eq!(r.headers()["x-should-retry"], "false");
    let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
    assert_eq!(json["error"]["type"], "rate_limit_error");
    let message = json["error"]["message"].as_str().unwrap();
    assert!(message.starts_with(crate::app_name!()) && message.contains("in flight"), "{message}");
    assert_eq!(seen.hits.load(Ordering::SeqCst), 2);
    assert_eq!(book.billed(Provider::Anthropic, chrono::Utc::now()), 0);

    // One ends cleanly: its hold is released and its real cost charged.
    release.add_permits(1);
    assert_eq!(reserved_comes_to(&book, Provider::Anthropic, held_one).await, held_one);
    let models = charged(&book, Provider::Anthropic).await;
    assert_eq!(models["claude-stub"].requests, 1);
    assert_eq!((models["claude-stub"].input, models["claude-stub"].output), (5, 3));

    // Now one more fits; its client hangs up: released too.
    let mut d = send().await.unwrap();
    assert_eq!(d.status(), 200);
    assert!(d.chunk().await.unwrap().is_some());
    assert_eq!(book.reserved(Provider::Anthropic), 2 * held_one);
    drop(d);
    assert_eq!(reserved_comes_to(&book, Provider::Anthropic, held_one).await, held_one);

    // The provider breaks the last one off: released.
    release.close();
    assert_eq!(reserved_comes_to(&book, Provider::Anthropic, 0).await, 0);
    // Both read to their end (one completed, one broke off).
    let _ = a.bytes().await;
    let _ = b.bytes().await;
    assert_eq!(book.snapshot(chrono::Utc::now()).providers["anthropic"].models["claude-stub"].requests, 3);
    on_tab_gone("e2e:inflight");

    // A provider that cannot be reached: nothing charged, nothing held.
    let dead = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let dead_addr = dead.local_addr().unwrap();
    drop(dead);
    let budget = test_budget(ROOMY);
    let book = budget.book.clone();
    let (port, _) = proxy_with(format!("http://{dead_addr}"), Some(FAKE_KEY), |s| s.budget = budget).await;
    let token = issue_grant(grant(Provider::Anthropic, "e2e:inflight-dead", None)).unwrap();
    let r = plain_client()
        .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
        .header("x-api-key", token)
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 502);
    assert_eq!(book.reserved(Provider::Anthropic), 0);
    assert_eq!(book.billed(Provider::Anthropic, chrono::Utc::now()), 0);
    on_tab_gone("e2e:inflight-dead");
}
