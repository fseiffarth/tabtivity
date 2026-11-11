//! The lane over real sockets: an in-fence listener, the Unix socket, the host
//! side and a stub Ollama on loopback (no namespace is needed to test any of
//! it). Plus the pure rules.

use super::policy::{self, Api, Filter};
use super::server::{Connect, Judge, LaneServer, Limits, Target};
use super::{http, relay, FenceLane};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

// ── A stub Ollama ───────────────────────────────────────────────────────────

/// What `/api/tags` of the stub says: a local model, a cloud name, and a cloud
/// model listed under a local-looking name (it names its remote).
const TAGS: &str = r#"{"models":[
  {"name":"llama3:latest","model":"llama3:latest","size":1},
  {"name":"qwen3-coder:30b","model":"qwen3-coder:30b","size":2},
  {"name":"gpt-oss:120b-cloud","model":"gpt-oss:120b-cloud","remote_host":"https://ollama.com:443","remote_model":"gpt-oss:120b"},
  {"name":"mycloud:latest","model":"mycloud:latest","remote_host":"https://ollama.com:443","remote_model":"big:1t"}
]}"#;

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Stub {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
    gate: mpsc::Sender<()>,
    hung_up: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

impl Stub {
    fn start() -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (gate, gate_rx) = mpsc::channel::<()>();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let hung_up = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let gate_rx = Arc::new(Mutex::new(gate_rx));
        let (s2, h2, st2) = (seen.clone(), hung_up.clone(), stop.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                if st2.load(Ordering::SeqCst) {
                    return;
                }
                let (seen, hung_up, gate_rx) = (s2.clone(), h2.clone(), gate_rx.clone());
                std::thread::spawn(move || stub_conn(conn, seen, hung_up, gate_rx));
            }
        });
        Stub { addr, seen, gate, hung_up, stop }
    }

    fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn judge() -> Judge {
        Arc::new(|model| crate::services::ollama_client::model_is_local_in(Ok(TAGS), model))
    }

    fn connect(&self) -> Connect {
        let addr = self.addr;
        Arc::new(move || TcpStream::connect(addr).map_err(|e| e.to_string()))
    }

    fn ollama_target(&self) -> Target {
        Target::Ollama { judge: Stub::judge(), connect: self.connect(), host: self.addr.to_string() }
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

fn read_request(conn: &mut TcpStream) -> Option<Seen> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(end) = http::head_end(&buf) {
            break end;
        }
        let n = conn.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let text = String::from_utf8_lossy(&buf[..end]).into_owned();
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_string(), first.next()?.to_string());
    let headers: Vec<(String, String)> =
        lines.take_while(|l| !l.is_empty()).filter_map(|l| l.split_once(':')).map(|(k, v)| (k.to_string(), v.trim().to_string())).collect();
    let len: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    let mut body = buf[end..].to_vec();
    while body.len() < len {
        let n = conn.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(Seen { method, target, headers, body })
}

fn stub_conn(mut conn: TcpStream, seen: Arc<Mutex<Vec<Seen>>>, hung_up: Arc<AtomicBool>, gate: Arc<Mutex<mpsc::Receiver<()>>>) {
    let Some(req) = read_request(&mut conn) else { return };
    seen.lock().unwrap().push(req.clone());
    let json = |body: &str| format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let body = String::from_utf8_lossy(&req.body).into_owned();
    let path = req.target.split('?').next().unwrap_or("").to_string();
    match path.as_str() {
        "/api/tags" => {
            let _ = conn.write_all(json(TAGS).as_bytes());
        }
        "/v1/models" => {
            let list = r#"{"object":"list","data":[{"id":"llama3:latest","object":"model"},{"id":"gpt-oss:120b-cloud","object":"model"},{"id":"mycloud:latest","object":"model"}]}"#;
            let _ = conn.write_all(json(list).as_bytes());
        }
        "/api/chat" if body.contains("\"gated\"") || body.contains("\"hang\"") => {
            let head = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
            let chunk = |s: &str| format!("{:x}\r\n{s}\r\n", s.len());
            let _ = conn.write_all(head.as_bytes());
            let _ = conn.write_all(chunk("{\"n\":1}\n").as_bytes());
            if body.contains("\"gated\"") {
                let _ = gate.lock().unwrap().recv_timeout(Duration::from_secs(10));
                let _ = conn.write_all(chunk("{\"n\":2}\n").as_bytes());
                let _ = conn.write_all(b"0\r\n\r\n");
            } else {
                // Keep writing until the reader is gone.
                for _ in 0..200 {
                    std::thread::sleep(Duration::from_millis(50));
                    if conn.write_all(chunk("{\"n\":9}\n").as_bytes()).is_err() {
                        hung_up.store(true, Ordering::SeqCst);
                        return;
                    }
                }
            }
        }
        "/mcp/cockpit" | "/mcp/help" | "/mcp/markup" | "/mcp/web" | "/mcp/git" | "/mcp/schedule" | "/mcp" => {
            let _ = conn.write_all(json(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#).as_bytes());
        }
        _ => {
            let _ = conn.write_all(json(r#"{"done":true}"#).as_bytes());
        }
    }
}

// ── The whole path ──────────────────────────────────────────────────────────

struct Rig {
    server: Option<LaneServer>,
    _dir: tempfile::TempDir,
    sock: PathBuf,
    /// The in-fence listener's address.
    addr: SocketAddr,
}

fn rig(target: Target, limits: Limits) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("lane").join("t.sock");
    let server = LaneServer::start(&sock, target, limits).unwrap();
    let relay = relay::Relay::bind(&[("127.0.0.1:0".parse().unwrap(), sock.clone())]).unwrap();
    let addr = relay.addrs()[0];
    relay.serve();
    Rig { server: Some(server), _dir: dir, sock, addr }
}

struct Answer {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Answer {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not json: {}", self.text()))
    }
}

fn split_answer(raw: &[u8]) -> Answer {
    let end = http::head_end(raw).unwrap_or_else(|| panic!("no head in {:?}", String::from_utf8_lossy(raw)));
    let head = String::from_utf8_lossy(&raw[..end]).into_owned();
    let status = head.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap();
    let mut body = raw[end..].to_vec();
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        body = http::dechunk(&body, usize::MAX).expect("chunked body");
    }
    Answer { status, head, body }
}

fn exchange(addr: SocketAddr, request: &[u8]) -> Answer {
    let mut conn = TcpStream::connect(addr).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    conn.write_all(request).unwrap();
    let mut raw = Vec::new();
    let _ = conn.read_to_end(&mut raw);
    split_answer(&raw)
}

fn post(addr: SocketAddr, path: &str, body: &str) -> Answer {
    exchange(addr, format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes())
}

fn get(addr: SocketAddr, path: &str) -> Answer {
    exchange(addr, format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
}

#[test]
fn a_chat_on_a_local_model_reaches_ollama_rebuilt_and_streams_back() {
    let stub = Stub::start();
    let rig = rig(stub.ollama_target(), Limits::default());
    let body = r#"{"model":"llama3","messages":[{"role":"user","content":"hi"}]}"#;
    let req = format!(
        "POST /api/chat?x=1 HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer secret\r\nCookie: a=b\r\nAccept: application/json\r\nConnection: keep-alive\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let answer = exchange(rig.addr, req.as_bytes());
    assert_eq!(answer.status, 200, "{}", answer.text());
    assert!(answer.head.contains("Connection: close"));
    let seen = stub.requests();
    assert_eq!(seen.len(), 1);
    // The canonical path, no query; the client's Host, Authorization, Cookie and
    // Connection are not sent on; the body is the client's.
    assert_eq!((seen[0].method.as_str(), seen[0].target.as_str()), ("POST", "/api/chat"));
    assert_eq!(seen[0].body, body.as_bytes());
    let names: Vec<String> = seen[0].headers.iter().map(|(k, _)| k.to_ascii_lowercase()).collect();
    for dropped in ["authorization", "cookie"] {
        assert!(!names.iter().any(|n| n == dropped), "{dropped} was sent on: {names:?}");
    }
    let host = &seen[0].headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("host")).unwrap().1;
    assert_eq!(host, &stub.addr.to_string());
    assert!(seen[0].headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("connection") && v == "close"));
}

#[test]
fn only_the_listed_routes_are_carried_and_nothing_else_reaches_ollama() {
    let stub = Stub::start();
    let rig = rig(stub.ollama_target(), Limits::default());
    for path in [
        "/api/pull", "/api/push", "/api/create", "/api/copy", "/api/delete", "/api/blobs/sha256:abc", "/api/blobs/sha256:abc", "/api/me",
        "/api/tags/", "/api/../api/pull", "//api/tags", "/api/%63hat", "/api/chat/", "/v1/messages/count_tokens", "/api/web_search", "/mcp/web",
    ] {
        let a = post(rig.addr, path, r#"{"model":"llama3"}"#);
        assert!(a.status == 403 || a.status == 400, "{path}: {}", a.status);
        assert!(!a.json()["error"].is_null(), "{path}: {}", a.text());
        let a = get(rig.addr, path);
        assert!(a.status == 403 || a.status == 400, "{path}: {}", a.status);
    }
    // An absolute-form target and a method the route does not take.
    assert_eq!(exchange(rig.addr, b"GET http://127.0.0.1/api/tags HTTP/1.1\r\nHost: x\r\n\r\n").status, 400);
    assert_eq!(get(rig.addr, "/api/chat").status, 405);
    assert_eq!(post(rig.addr, "/api/tags", "{}").status, 405);
    assert_eq!(exchange(rig.addr, b"DELETE /api/delete HTTP/1.1\r\nHost: x\r\n\r\n").status, 403);
    assert!(stub.requests().is_empty(), "something reached Ollama: {:?}", stub.requests());
}

#[test]
fn every_route_on_the_list_is_carried() {
    let stub = Stub::start();
    let rig = rig(stub.ollama_target(), Limits::default());
    for route in policy::OLLAMA_ROUTES {
        let a = if route.has_body() { post(rig.addr, route.path, r#"{"model":"llama3:latest"}"#) } else { get(rig.addr, route.path) };
        assert_eq!(a.status, 200, "{}: {}", route.path, a.text());
    }
    assert_eq!(stub.requests().len(), policy::OLLAMA_ROUTES.len());
    // The list is the plan's, plus `/` (the probe `ollama launch` makes) and `/v1/responses` (Codex).
    let mut paths: Vec<&str> = policy::OLLAMA_ROUTES.iter().map(|r| r.path).collect();
    paths.sort();
    assert_eq!(
        paths,
        [
            "/", "/api/chat", "/api/embed", "/api/embeddings", "/api/generate", "/api/ps", "/api/show", "/api/tags", "/api/version",
            "/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/messages", "/v1/models", "/v1/responses"
        ]
    );
}

#[test]
fn a_request_naming_a_model_that_is_not_local_goes_nowhere() {
    let stub = Stub::start();
    let rig = rig(stub.ollama_target(), Limits::default());
    for (path, model) in [
        ("/api/chat", "gpt-oss:120b-cloud"),
        ("/api/chat", "mycloud"),
        ("/api/generate", "mycloud:latest"),
        ("/api/embed", "qwen3-coder:cloud"),
        ("/v1/chat/completions", "gpt-oss:120b-cloud"),
        ("/v1/messages", "mycloud:latest"),
        ("/v1/embeddings", "gpt-oss:120b-cloud"),
        ("/api/show", "mycloud:latest"),
    ] {
        let a = post(rig.addr, path, &format!(r#"{{"model":"{model}"}}"#));
        assert_eq!(a.status, 403, "{path} {model}: {}", a.text());
        assert!(a.text().contains("cloud"), "{}", a.text());
    }
    // Not installed at all.
    assert_eq!(post(rig.addr, "/api/chat", r#"{"model":"nope"}"#).status, 404);
    assert!(stub.requests().is_empty(), "{:?}", stub.requests());
    // A local one on the same routes passes.
    for path in ["/api/chat", "/v1/messages", "/v1/chat/completions"] {
        assert_eq!(post(rig.addr, path, r#"{"model":"qwen3-coder:30b"}"#).status, 200, "{path}");
    }
}

#[test]
fn a_refusal_is_worded_for_the_api_of_the_request() {
    let stub = Stub::start();
    let rig = rig(stub.ollama_target(), Limits::default());
    let native = post(rig.addr, "/api/chat", r#"{"model":"gpt-oss:120b-cloud"}"#).json();
    assert!(native["error"].is_string());
    let openai = post(rig.addr, "/v1/chat/completions", r#"{"model":"gpt-oss:120b-cloud"}"#).json();
    assert!(openai["error"]["message"].is_string() && openai["error"]["type"].is_string());
    let anthropic = post(rig.addr, "/v1/messages", r#"{"model":"gpt-oss:120b-cloud"}"#).json();
    assert_eq!(anthropic["type"], "error");
    assert!(anthropic["error"]["message"].is_string());
    assert_eq!(policy::refusal_body(Api::Native, 403, "x"), r#"{"error":"x"}"#);
}

#[test]
fn a_body_that_names_its_model_twice_or_oddly_is_refused() {
    let stub = Stub::start();
    let rig = rig(stub.ollama_target(), Limits::default());
    for body in [
        // Go's decoder folds key case and takes the last match.
        r#"{"model":"llama3","MODEL":"gpt-oss:120b-cloud"}"#,
        r#"{"Model":"gpt-oss:120b-cloud"}"#,
        r#"{"model":"gpt-oss:120b-cloud","mOdEl":"llama3"}"#,
        r#"{"messages":[]}"#,
        r#"{"model":7}"#,
        r#"{"model":["llama3"]}"#,
        r#"{"model":" llama3"}"#,
        r#"{"model":"llama3\n"}"#,
        r#"{"model":""}"#,
        r#"["llama3"]"#,
        r#"{"model":"llama3"} trailing"#,
        "not json",
    ] {
        let a = post(rig.addr, "/api/chat", body);
        assert_eq!(a.status, 400, "{body}: {}", a.text());
    }
    // /api/show: `name` is the older spelling and is judged too.
    assert_eq!(post(rig.addr, "/api/show", r#"{"name":"mycloud:latest"}"#).status, 403);
    assert_eq!(post(rig.addr, "/api/show", r#"{"model":"llama3","name":"mycloud:latest"}"#).status, 403);
    assert_eq!(post(rig.addr, "/api/show", r#"{"name":"llama3"}"#).status, 200);
    // What `ollama launch` sends: the model set and an empty `name`; an empty one alone names nothing.
    assert_eq!(post(rig.addr, "/api/show", r#"{"model":"llama3","system":"","verbose":false,"options":null,"name":""}"#).status, 200);
    assert_eq!(post(rig.addr, "/api/show", r#"{"model":"","name":""}"#).status, 400);
    assert_eq!(post(rig.addr, "/api/show", r#"{"model":"","name":"mycloud:latest"}"#).status, 403);
    assert!(stub.requests().len() == 2, "{:?}", stub.requests());
}

#[test]
fn the_model_lists_are_narrowed_to_local_models() {
    let stub = Stub::start();
    let rig = rig(stub.ollama_target(), Limits::default());
    let tags = get(rig.addr, "/api/tags");
    assert_eq!(tags.status, 200);
    let names: Vec<String> = tags.json()["models"].as_array().unwrap().iter().map(|m| m["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, ["llama3:latest", "qwen3-coder:30b"], "{}", tags.text());
    let models = get(rig.addr, "/v1/models");
    assert_eq!(models.status, 200);
    let ids: Vec<String> = models.json()["data"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, ["llama3:latest"], "{}", models.text());
    assert_eq!(models.json()["object"], "list");
}

#[test]
fn the_list_filters_are_pure() {
    let narrowed = policy::filter_tags(TAGS.as_bytes()).unwrap();
    let v: serde_json::Value = serde_json::from_slice(&narrowed).unwrap();
    assert_eq!(v["models"].as_array().unwrap().len(), 2);
    assert!(policy::filter_tags(b"{}").is_err());
    assert!(policy::filter_tags(b"nope").is_err());
    assert!(policy::filter_tags(br#"{"models":[1,"a",{"name":"x:cloud"},{"name":"ok:1"}]}"#).is_ok_and(|b| String::from_utf8_lossy(&b).contains("ok:1") && !String::from_utf8_lossy(&b).contains("x:cloud")));
    assert!(policy::filter_v1_models(br#"{"data":[{"id":"a"},{"id":"b"},{"x":1}]}"#, &|id| id == "a").is_ok_and(|b| String::from_utf8_lossy(&b) == r#"{"data":[{"id":"a"}]}"#));
    assert!(policy::filter_v1_models(b"[]", &|_| true).is_err());
}

#[test]
fn an_oversized_or_unframed_body_is_refused_before_ollama_sees_it() {
    let stub = Stub::start();
    let limits = Limits { max_body: 1024, ..Limits::default() };
    let rig = rig(stub.ollama_target(), limits);
    let big = format!(r#"{{"model":"llama3","pad":"{}"}}"#, "x".repeat(2000));
    assert_eq!(post(rig.addr, "/api/chat", &big).status, 413);
    // No length, and a chunked body.
    assert_eq!(exchange(rig.addr, b"POST /api/chat HTTP/1.1\r\nHost: x\r\n\r\n").status, 411);
    assert_eq!(exchange(rig.addr, b"POST /api/chat HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n").status, 411);
    // A GET with a body, an upgrade, a compressed body, a second length, a bare LF.
    assert_eq!(exchange(rig.addr, b"GET /api/tags HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}").status, 400);
    assert_eq!(exchange(rig.addr, b"GET /api/tags HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n").status, 400);
    assert_eq!(exchange(rig.addr, b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\n{}").status, 400);
    assert_eq!(exchange(rig.addr, b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}x").status, 400);
    assert_eq!(exchange(rig.addr, b"GET /api/tags HTTP/1.1\nHost: x\r\n\r\n").status, 400);
    // More bytes than declared.
    assert_eq!(exchange(rig.addr, b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}{\"model\":\"llama3\"}").status, 400);
    assert!(stub.requests().is_empty(), "{:?}", stub.requests());
}

#[test]
fn a_slow_head_times_out_and_expect_continue_is_answered() {
    let stub = Stub::start();
    let limits = Limits { head_time: Duration::from_millis(1500), ..Limits::default() };
    let rig = rig(stub.ollama_target(), limits);
    // A head that never ends.
    let mut conn = TcpStream::connect(rig.addr).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    conn.write_all(b"POST /api/chat HTTP/1.1\r\nHost: x\r\n").unwrap();
    let mut raw = Vec::new();
    let _ = conn.read_to_end(&mut raw);
    assert_eq!(split_answer(&raw).status, 408);
    // Expect: 100-continue, then the body.
    let body = r#"{"model":"llama3"}"#;
    let mut conn = TcpStream::connect(rig.addr).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    conn.write_all(format!("POST /api/chat HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes()).unwrap();
    let mut first = [0u8; 25];
    conn.read_exact(&mut first).unwrap();
    assert!(String::from_utf8_lossy(&first).starts_with("HTTP/1.1 100 Continue"));
    conn.write_all(body.as_bytes()).unwrap();
    let mut raw = Vec::new();
    let _ = conn.read_to_end(&mut raw);
    assert_eq!(split_answer(&raw).status, 200);
}

#[test]
fn a_streamed_answer_arrives_as_it_is_produced() {
    let stub = Stub::start();
    let rig = rig(stub.ollama_target(), Limits::default());
    let body = r#"{"model":"llama3","gated":true}"#;
    let mut conn = TcpStream::connect(rig.addr).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    conn.write_all(format!("POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
    // The first chunk must be here while the stub is still holding the second.
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    let started = Instant::now();
    while !String::from_utf8_lossy(&raw).contains("{\"n\":1}") {
        let n = conn.read(&mut chunk).unwrap();
        assert!(n > 0 && started.elapsed() < Duration::from_secs(8), "no first chunk: {:?}", String::from_utf8_lossy(&raw));
        raw.extend_from_slice(&chunk[..n]);
    }
    assert!(!String::from_utf8_lossy(&raw).contains("{\"n\":2}"));
    stub.gate.send(()).unwrap();
    let _ = conn.read_to_end(&mut raw);
    let answer = split_answer(&raw);
    assert_eq!(answer.status, 200);
    assert_eq!(answer.text(), "{\"n\":1}\n{\"n\":2}\n");
}

#[test]
fn a_client_that_hangs_up_stops_the_upstream_generation() {
    let stub = Stub::start();
    let rig = rig(stub.ollama_target(), Limits::default());
    let body = r#"{"model":"llama3","hang":true}"#;
    let mut conn = TcpStream::connect(rig.addr).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    conn.write_all(format!("POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
    let mut chunk = [0u8; 4096];
    let n = conn.read(&mut chunk).unwrap();
    assert!(n > 0);
    drop(conn);
    let started = Instant::now();
    while !stub.hung_up.load(Ordering::SeqCst) {
        assert!(started.elapsed() < Duration::from_secs(8), "the upstream connection was kept after the client left");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn an_unreachable_or_refused_upstream_is_a_json_error() {
    let stub = Stub::start();
    let connect: Connect = Arc::new(|| Err("ollama_listener_refused: not Ollama".to_string()));
    let rig = rig(Target::Ollama { judge: Stub::judge(), connect, host: "127.0.0.1:1".into() }, Limits::default());
    let a = post(rig.addr, "/api/chat", r#"{"model":"llama3"}"#);
    assert_eq!(a.status, 503);
    assert!(a.json()["error"].as_str().unwrap().contains("could not be reached"));
    drop(stub);
}

#[test]
fn the_tools_lane_carries_the_cockpit_help_and_markup_and_nothing_else() {
    let mcp = Stub::start();
    let target = Target::Mcp { connect: mcp.connect(), host: mcp.addr.to_string() };
    let rig = rig(target, Limits::default());
    for path in ["/mcp/cockpit", "/mcp/help", "/mcp/markup"] {
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:9\r\nAuthorization: Bearer tok\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMcp-Session-Id: s1\r\nCookie: a=b\r\nContent-Length: 2\r\n\r\n{{}}"
        );
        assert_eq!(exchange(rig.addr, req.as_bytes()).status, 200, "{path}");
    }
    let seen = mcp.requests();
    assert_eq!(seen.len(), 3);
    let has = |name: &str| seen[0].headers.iter().any(|(k, v)| k.eq_ignore_ascii_case(name) && !v.is_empty());
    assert!(has("authorization") && has("mcp-session-id") && has("accept"));
    assert!(!has("cookie"));
    for path in ["/mcp/web", "/mcp/git", "/mcp/schedule", "/mcp", "/mcp/", "/mcp/other", "/mcp/cockpit/x", "/api/chat", "/mcp/%63ockpit"] {
        let a = post(rig.addr, path, "{}");
        assert!(a.status == 403 || a.status == 400, "{path}: {}", a.status);
    }
    assert_eq!(get(rig.addr, "/mcp/cockpit").status, 405);
    assert_eq!(mcp.requests().len(), 3, "a refused lane reached the server");
}

#[test]
fn the_socket_is_private_and_goes_with_the_lane() {
    let stub = Stub::start();
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("local-lane").join("a.sock");
    let server = LaneServer::start(&sock, stub.ollama_target(), Limits::default()).unwrap();
    assert_eq!(std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(sock.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    // A stale file is replaced.
    drop(server);
    assert!(!sock.exists(), "the socket outlived its lane");
    std::fs::write(&sock, "stale").unwrap();
    let server = LaneServer::start(&sock, stub.ollama_target(), Limits::default()).unwrap();
    assert!(std::os::unix::net::UnixStream::connect(server.path()).is_ok());
    server.stop();
    assert!(!sock.exists());
    assert!(std::os::unix::net::UnixStream::connect(&sock).is_err());
    // A folder in the way is not removed.
    std::fs::create_dir(&sock).unwrap();
    assert!(LaneServer::start(&sock, stub.ollama_target(), Limits::default()).is_err());
    assert!(sock.is_dir());
}

#[test]
fn the_registry_opens_and_closes_a_lane_per_tab_and_removes_its_files() {
    let state = tempfile::tempdir().unwrap();
    let stub = Stub::start();
    let _ = &stub;
    // Not a loopback address: no lane.
    assert!(super::open("p:t1", state.path(), "203.0.113.5:11434", None).is_err());
    let lane = super::open("p:t1", state.path(), "127.0.0.1:11434", Some(40123)).unwrap();
    assert!(super::is_open("p:t1"));
    assert!(lane.ollama_socket.starts_with(state.path().join(super::DIR_NAME)));
    assert!(lane.ollama_socket.exists() && lane.mcp_socket.as_ref().unwrap().exists());
    assert_eq!((lane.ollama_port, lane.mcp_port), (11434, Some(40123)));
    // The file name is a hash, never the id.
    // (The name only: the random temp dir above it may spell "t1".)
    assert!(!lane.ollama_socket.file_name().unwrap().to_string_lossy().contains("t1"));
    // A second spawn of the id replaces the first.
    let again = super::open("p:t1", state.path(), "127.0.0.1:11434", Some(40123)).unwrap();
    assert_eq!(again.ollama_socket, lane.ollama_socket);
    let other = super::open("p:t2", state.path(), "localhost:11434", Some(11434)).unwrap();
    assert_ne!(other.ollama_socket, lane.ollama_socket);
    // The same port for both is one relay port.
    assert_eq!(other.mcp_port, None);
    assert!(other.mcp_socket.is_none());
    super::close("p:t1");
    assert!(!super::is_open("p:t1") && !lane.ollama_socket.exists() && !lane.mcp_socket.as_ref().unwrap().exists());
    assert!(other.ollama_socket.exists());
    super::stop_for_exit();
    assert!(!super::is_open("p:t2") && !other.ollama_socket.exists());
}

// ── The fence side's argv ───────────────────────────────────────────────────

#[test]
fn the_fence_binds_and_command_prefix_have_one_fixed_shape() {
    let lane = FenceLane {
        ollama_socket: PathBuf::from("/state/local-lane/abc.sock"),
        mcp_socket: Some(PathBuf::from("/state/local-lane/abc.mcp.sock")),
        ollama_port: 11434,
        mcp_port: Some(40123),
    };
    let binds = lane.binds(std::path::Path::new("/opt/app/bin"));
    let slug = crate::brand::SLUG;
    assert_eq!(
        binds,
        [
            "--ro-bind", "/opt/app/bin", &format!("/run/{slug}-lane/relay"),
            "--bind", "/state/local-lane/abc.sock", &format!("/run/{slug}-lane/ollama.sock"),
            "--bind", "/state/local-lane/abc.mcp.sock", &format!("/run/{slug}-lane/mcp.sock"),
        ]
    );
    let prefix = lane.command_prefix();
    assert_eq!(
        prefix,
        [
            format!("/run/{slug}-lane/relay"),
            "--local-relay".to_string(),
            format!("11434=/run/{slug}-lane/ollama.sock"),
            format!("40123=/run/{slug}-lane/mcp.sock"),
            "--".to_string(),
        ]
    );
    // What the relay parses back.
    let args: Vec<std::ffi::OsString> = prefix[2..].iter().cloned().chain(["claude".to_string(), "--x".to_string()]).map(Into::into).collect();
    let (specs, command) = relay::parse(&args).unwrap();
    assert_eq!(specs.len(), 2);
    assert_eq!((specs[0].port, specs[1].port), (11434, 40123));
    assert_eq!(command, ["claude", "--x"]);
    let no_mcp = FenceLane { mcp_socket: None, mcp_port: None, ..lane };
    assert_eq!(no_mcp.binds(std::path::Path::new("/b")).len(), 6);
    assert_eq!(no_mcp.command_prefix().len(), 4);
}

#[test]
fn an_appimage_cannot_be_the_relay_and_says_so() {
    use std::path::Path;
    assert!(super::relay_exe_check(Path::new("/opt/app/bin/x"), None).is_ok());
    assert!(super::relay_exe_check(Path::new("/usr/bin/x"), Some("")).is_ok());
    assert!(super::relay_exe_check(Path::new("/home/u/build/target/debug/x"), None).is_ok());
    for (exe, appimage) in [("/tmp/.mount_abc123/usr/bin/x", None), ("/opt/x", Some("/home/u/App.AppImage")), ("/tmp/x", None)] {
        let err = super::relay_exe_check(Path::new(exe), appimage).unwrap_err();
        assert!(err.starts_with("Agent sandbox:") && err.contains("AppImage"), "{err}");
    }
}

#[test]
fn the_relay_refuses_what_it_cannot_parse() {
    let os = |v: &[&str]| v.iter().map(|s| std::ffi::OsString::from(*s)).collect::<Vec<_>>();
    assert!(relay::parse(&os(&["11434=/s", "claude"])).is_err(), "no --");
    assert!(relay::parse(&os(&["--", "claude"])).is_err(), "no port");
    assert!(relay::parse(&os(&["11434=/s", "--"])).is_err(), "no command");
    assert!(relay::parse(&os(&["0=/s", "--", "x"])).is_err());
    assert!(relay::parse(&os(&["notaport=/s", "--", "x"])).is_err());
    assert!(relay::parse(&os(&["11434=rel", "--", "x"])).is_err());
    assert!(relay::parse(&os(&["11434", "--", "x"])).is_err());
    assert!(relay::parse(&os(&["11434=/s", "--", "x", "--", "y"])).is_ok());
}

// `with_socket_path` reaches a long path through /proc/self/fd, which only Linux has;
// elsewhere a path past `sun_path` (104 bytes on macOS) cannot bind at all.
#[cfg(target_os = "linux")]
#[test]
fn a_socket_under_a_long_path_still_binds_and_connects() {
    // A state dir under a long home overflows `sun_path` (about 100 bytes).
    let base = tempfile::tempdir().unwrap();
    let deep = base.path().join("a".repeat(60)).join("b".repeat(60)).join("local-lane");
    let sock = deep.join("0123456789abcdef.sock");
    assert!(sock.as_os_str().len() > 110);
    let stub = Stub::start();
    let server = LaneServer::start(&sock, stub.ollama_target(), Limits::default()).unwrap();
    assert!(sock.exists());
    let relay = relay::Relay::bind(&[("127.0.0.1:0".parse().unwrap(), sock.clone())]).unwrap();
    let addr = relay.addrs()[0];
    relay.serve();
    assert_eq!(get(addr, "/api/version").status, 200);
    server.stop();
    assert!(!sock.exists());
}

#[test]
fn the_ports_follow_the_verified_endpoint() {
    assert_eq!(super::relay_ports("127.0.0.1:11434", Some(5)).unwrap(), (11434, Some(5)));
    assert_eq!(super::relay_ports("localhost:9", Some(9)).unwrap(), (9, None));
    assert_eq!(super::relay_ports("[::1]:11434", None).unwrap(), (11434, None));
    assert!(super::relay_ports("203.0.113.7:11434", None).is_err());
    assert!(super::relay_ports("ollama.example:11434", None).is_err());
}

// ── The pure rules ──────────────────────────────────────────────────────────

#[test]
fn route_decisions() {
    use policy::{ollama_route, target_path};
    assert_eq!(target_path("/api/chat?x=1"), Some("/api/chat"));
    assert_eq!(target_path("//evil"), None);
    assert_eq!(target_path("http://x/api"), None);
    assert_eq!(target_path("*"), None);
    assert_eq!(ollama_route("POST", "/v1/messages").unwrap().api, Api::Anthropic);
    assert_eq!(ollama_route("GET", "/api/tags").unwrap().filter, Filter::Tags);
    assert_eq!(ollama_route("GET", "/v1/models").unwrap().filter, Filter::V1Models);
    assert_eq!(ollama_route("GET", "/api/pull").unwrap_err().status, 403);
    assert_eq!(ollama_route("GET", "/api/chat").unwrap_err().status, 405);
    assert_eq!(ollama_route("HEAD", "/").unwrap().path, "/");
    assert_eq!(ollama_route("GET", "/?x=1").unwrap().path, "/");
    assert_eq!(ollama_route("POST", "/").unwrap_err().status, 405);
    assert_eq!(ollama_route("HEAD", "/api/tags").unwrap_err().status, 405);
    assert!(ollama_route("POST", "/v1/responses").unwrap().needs_model);
    assert_eq!(policy::mcp_route("POST", "/mcp/cockpit").unwrap(), "/mcp/cockpit");
    assert_eq!(policy::mcp_route("POST", "/mcp/web").unwrap_err().status, 403);
    assert_eq!(policy::mcp_route("GET", "/mcp/help").unwrap_err().status, 405);
    assert!(!policy::MCP_ALLOWED.iter().any(|p| ["/mcp", "/mcp/web", "/mcp/git", "/mcp/schedule"].contains(p)));
}

#[test]
fn head_parsing_is_strict() {
    let ok = http::parse_head(b"POST /api/chat HTTP/1.1\r\nHost: x\r\ncontent-length: 5\r\n\r\n", 100).unwrap();
    assert_eq!((ok.method.as_str(), ok.length), ("POST", Some(5)));
    for bad in [
        &b"POST /api/chat HTTP/2\r\n\r\n"[..],
        b"post /api/chat HTTP/1.1\r\n\r\n",
        b"POST  /api/chat HTTP/1.1\r\n\r\n",
        b"POST /api/chat HTTP/1.1\r\n folded: x\r\n\r\n",
        b"POST /api/chat HTTP/1.1\r\nbad name: x\r\n\r\n",
        b"POST /api/chat HTTP/1.1\r\nContent-Length: -1\r\n\r\n",
        b"POST /api/chat HTTP/1.1\r\nContent-Length: 1e3\r\n\r\n",
        b"POST /api/chat HTTP/1.1\r\nX: a\rb\r\n\r\n",
        b"POST /a b HTTP/1.1\r\n\r\n",
        b"POST /api/chat HTTP/1.1\r\nExpect: 200-ok\r\n\r\n",
    ] {
        assert!(http::parse_head(bad, 100).is_err(), "{}", String::from_utf8_lossy(bad));
    }
    assert_eq!(http::parse_head(b"POST /x HTTP/1.1\r\nContent-Length: 101\r\n\r\n", 100).unwrap_err().status, 413);
    assert_eq!(http::dechunk(b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n", 100).unwrap(), b"abcde");
    assert!(http::dechunk(b"3\r\nabc\r\n", 100).is_none());
    assert!(http::dechunk(b"ff\r\nabc\r\n0\r\n\r\n", 100).is_none());
    assert!(http::dechunk(b"3\r\nabc\r\n0\r\n\r\n", 2).is_none());
}

#[test]
fn judging_does_not_depend_on_the_client_dropping_a_request_thread() {
    // The judge is asked once per named model, and a listing thread finishes even
    // when many lanes share one judge.
    let asked = Arc::new(AtomicUsize::new(0));
    let counter = asked.clone();
    let judge: Judge = Arc::new(move |m| {
        counter.fetch_add(1, Ordering::SeqCst);
        crate::services::ollama_client::model_is_local_in(Ok(TAGS), m)
    });
    let stub = Stub::start();
    let rig = rig(Target::Ollama { judge, connect: stub.connect(), host: stub.addr.to_string() }, Limits::default());
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let addr = rig.addr;
            std::thread::spawn(move || post(addr, "/api/chat", r#"{"model":"llama3"}"#).status)
        })
        .collect();
    for h in handles {
        assert_eq!(h.join().unwrap(), 200);
    }
    assert_eq!(asked.load(Ordering::SeqCst), 8);
    assert!(rig.sock.exists() && rig.server.is_some());
}
