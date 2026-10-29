use crate::brand::SLUG;
use super::*;

/// The host accepts the names an older phone app or an older host used,
/// counts them, and prefers the current ones.
#[test]
fn old_protocol_names_are_accepted_and_counted() {
    use crate::brand::{Name, LEGACY, PAIR};
    use crate::services::brand_migration::{hits, testing::RENAMED};
    let _ = hits::taken();
    let old_protocol = LEGACY.name(Name::TERMINAL_PROTOCOL);
    assert_eq!(terminal_protocol_in(&RENAMED, &old_protocol), Some(old_protocol.clone()));
    assert_eq!(hits::taken(), ["terminal-protocol"]);
    assert_eq!(
        terminal_protocol_in(&RENAMED, &format!("{old_protocol}, newname-terminal.v1")).as_deref(),
        Some("newname-terminal.v1")
    );
    assert_eq!(terminal_protocol_in(&RENAMED, "something-else"), None);
    assert!(hits::taken().is_empty());

    let old_cookie = format!("theme=dark; {}=tok-old", LEGACY.name(Name::SESSION_COOKIE));
    assert_eq!(session_cookie_in(&RENAMED, &old_cookie), Some("tok-old"));
    assert_eq!(hits::taken(), ["session-cookie"]);
    let both = format!("{old_cookie}; __Host-newname_session=tok-new");
    assert_eq!(session_cookie_in(&RENAMED, &both), Some("tok-new"));
    assert_eq!(session_cookie_in(&RENAMED, "theme=dark"), None);
    assert!(hits::taken().is_empty());

    // The production pair: one name each, as before.
    let current = super::super::protocol::TERMINAL_PROTOCOL;
    assert_eq!(terminal_protocol_in(&PAIR, current).as_deref(), Some(current));
    assert_eq!(
        session_cookie_in(&PAIR, &format!("{}=tok", crate::brand::SESSION_COOKIE)),
        Some("tok")
    );
}

use axum::body::to_bytes;
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    pkcs8::EncodePublicKey,
};
use serde_json::Value;
use tower::ServiceExt;

use crate::services::mobile_control::config::MobileHostSettings;

const ORIGIN: &str = "https://desk.example.ts.net";
/// A raw project id and a filesystem path the phone must never be able to
/// read back out of any response.
const RAW_BOX: &str = "b-mobile";
const RAW_PROJECT: &str = "raw-project-id-7f3";

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    state: HostState,
    /// What the owner typed into or ended (H3); the host's `runner`.
    runner: Arc<RunnerRecorder>,
}

/// The host's tmux reach, recorded: no server runs in a test, so nothing
/// is probed unless a test says so, and what would have been typed or
/// ended is written down instead.
#[derive(Default)]
struct RunnerRecorder {
    probe: Mutex<Option<scheduler::SessionProbe>>,
    delivered: Mutex<Vec<(String, Vec<scheduler::Submission>)>>,
    killed: Mutex<Vec<String>>,
}

impl scheduler::Runner for RunnerRecorder {
    fn probe(&self, _tmux: &str) -> Option<scheduler::SessionProbe> {
        *self.probe.lock().unwrap()
    }
    fn deliver(&self, tmux: &str, submissions: &[scheduler::Submission]) -> Result<(), String> {
        self.delivered.lock().unwrap().push((tmux.to_string(), submissions.to_vec()));
        Ok(())
    }
    fn kill(&self, tmux: &str) -> Result<(), String> {
        self.killed.lock().unwrap().push(tmux.to_string());
        Ok(())
    }
}

impl Fixture {
    /// A host with no project catalog at all.
    fn bare() -> Self {
        let dir = tempfile::tempdir().expect("state dir");
        let state_dir = dir.path().to_path_buf();
        let control_dir = state_dir.join("mobile-control");
        let auth = AuthStore::open(&control_dir, ORIGIN.to_string()).expect("auth store");
        let root = state_dir.join("work");
        std::fs::create_dir_all(&root).expect("project root");
        let runner = Arc::new(RunnerRecorder::default());
        Self {
            _dir: dir,
            root,
            runner: runner.clone(),
            state: HostState {
                config: HostConfig {
                    state_dir,
                    control_dir: control_dir.clone(),
                    host: MobileHostSettings {
                        display_name: "Desk".into(),
                        ..MobileHostSettings::default()
                    },
                    origin: ORIGIN.into(),
                },
                auth: Arc::new(Mutex::new(auth)),
                catalog: Arc::new(Mutex::new(CatalogCache::default())),
                terminal_registry: TerminalRegistry::default(),
                spawner: HeadlessSpawner::default(),
                readings: Arc::new(Mutex::new(headless::ReadingCache::default())),
                runner,
                holds: Arc::default(),
                web: {
                    let events = Arc::new(web_client::WebEvents::default());
                    let ctx = app_core::CoreCtx::system(Arc::new(app_core::CoreState::new()), events.clone());
                    web_client::WebClientState::new(false, ctx, events, &control_dir, 8742, None)
                },
                git_overview: Arc::default(),
                worktree_spots: Arc::default(),
                host_files: Arc::default(),
                host_kick: Arc::default(),
            },
        }
    }

    /// A host with one opted-in project holding one resumable agent tab.
    fn with_project() -> Self {
        let fixture = Self::bare();
        let state_dir = &fixture.state.config.state_dir;
        std::fs::write(
            state_dir.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": RAW_PROJECT,
                "name": "Aurora",
                "status": "active",
                "directory": fixture.root.to_string_lossy(),
                concat!(crate::app_slug!(), "_mobile_access"): true,
            }]))
            .expect("projects fixture"),
        )
        .expect("write projects");
        let sessions = state_dir.join("sessions").join(RAW_PROJECT);
        std::fs::create_dir_all(&sessions).expect("session dir");
        std::fs::write(
            sessions.join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({
                "tabLayout": [{
                    "label": "Claude",
                    "cmd": "claude",
                    "cwd": fixture.root.to_string_lossy(),
                    "kind": "agent",
                    "sessionId": "9d0f-session",
                    "tmuxSession": format!("{SLUG}-{RAW_PROJECT}--agent-abcdef123"),
                }]
            }))
            .expect("session fixture"),
        )
        .expect("write session");
        fixture
    }

    /// A host with one opted-in project (Mobile OFF on the project itself)
    /// that is the member of one opted-in box holding one shell tab in the
    /// member's tree and one in the box folder, plus one box with Mobile off.
    fn with_box() -> Self {
        let fixture = Self::bare();
        let state_dir = &fixture.state.config.state_dir;
        // Shell tabs are off the phone unless switched on.
        std::fs::write(
            state_dir.join("settings.json"),
            serde_json::json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true } }).to_string(),
        )
        .expect("write settings");
        let folder = state_dir.join("boxes").join("paper");
        std::fs::create_dir_all(&folder).expect("box folder");
        std::fs::write(
            state_dir.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": RAW_PROJECT,
                "name": "Aurora",
                "status": "inactive",
                "directory": fixture.root.to_string_lossy(),
            }]))
            .expect("projects fixture"),
        )
        .expect("write projects");
        std::fs::write(
            state_dir.join("boxes.json"),
            serde_json::to_vec(&serde_json::json!([
                { "id": RAW_BOX, "name": "Paper", "member_ids": [RAW_PROJECT],
                  "folder": folder.to_string_lossy(), concat!(crate::app_slug!(), "_mobile_access"): true },
                { "id": "b-off", "name": "Private", "member_ids": [RAW_PROJECT],
                  "folder": folder.to_string_lossy() },
            ]))
            .expect("boxes fixture"),
        )
        .expect("write boxes");
        let sessions = state_dir.join("sessions").join(format!("box_{RAW_BOX}"));
        std::fs::create_dir_all(&sessions).expect("session dir");
        std::fs::write(
            sessions.join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({
                "tabLayout": [{
                    "label": "Box shell",
                    "cmd": "bash",
                    "cwd": folder.to_string_lossy(),
                    "kind": "shell",
                    "tmuxSession": format!("{SLUG}-box_{RAW_BOX}--shell-abcdef123"),
                }, {
                    "label": "Aurora shell",
                    "cmd": "bash",
                    "cwd": fixture.root.to_string_lossy(),
                    "kind": "shell",
                    "tmuxSession": format!("{SLUG}-box_{RAW_BOX}--shell-bcdef1234"),
                }]
            }))
            .expect("session fixture"),
        )
        .expect("write session");
        fixture
    }

    async fn send(&self, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
        let response = router(self.state.clone())
            .oneshot(request)
            .await
            .expect("router response");
        let status = response.status();
        let headers = response.headers().clone();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        (status, headers, String::from_utf8_lossy(&body).into_owned())
    }

    /// The real pair → challenge → sign → session flow, returning the
    /// session cookie and the paired device id.
    async fn pair_device(&self, signing: &SigningKey) -> (String, String) {
        let code = self
            .state
            .auth
            .lock()
            .unwrap()
            .create_pairing_code()
            .expect("pairing code")
            .0;
        let public_key = Base64UrlUnpadded::encode_string(
            signing
                .verifying_key()
                .to_public_key_der()
                .expect("public key der")
                .as_bytes(),
        );
        let (status, _, body) = self
            .send(post_json(
                "/api/v1/pair",
                ORIGIN,
                &serde_json::json!({
                    "code": code,
                    "device_name": "Phone",
                    "public_key": public_key,
                }),
            ))
            .await;
        assert_eq!(status, StatusCode::CREATED, "pair failed: {body}");
        let device_id = json(&body)["device_id"].as_str().expect("device id").into();

        let (status, _, body) = self
            .send(post_json(
                "/api/v1/auth/challenge",
                ORIGIN,
                &serde_json::json!({ "device_id": device_id }),
            ))
            .await;
        assert_eq!(status, StatusCode::OK, "challenge failed: {body}");
        let challenge = json(&body);
        let nonce = challenge["nonce"].as_str().expect("nonce").to_string();
        let payload = challenge["payload"].as_str().expect("payload").to_string();

        let (status, headers, body) = self
            .send(post_json(
                "/api/v1/auth/session",
                ORIGIN,
                &serde_json::json!({
                    "device_id": device_id,
                    "nonce": nonce,
                    "signature": sign(signing, &payload),
                }),
            ))
            .await;
        assert_eq!(status, StatusCode::OK, "login failed: {body}");
        (set_cookie(&headers), device_id)
    }
}

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_slice(&[seed; 32]).expect("test signing key")
}

fn sign(signing: &SigningKey, payload: &str) -> String {
    let signature: Signature = signing.sign(payload.as_bytes());
    Base64UrlUnpadded::encode_string(&signature.to_bytes())
}

fn json(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

fn set_cookie(headers: &HeaderMap) -> String {
    headers
        .get(header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .expect("Set-Cookie")
        .to_string()
}

fn cookie_pair(set_cookie: &str) -> String {
    set_cookie
        .split(';')
        .next()
        .expect("cookie pair")
        .trim()
        .to_string()
}

fn get_request(uri: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .body(Body::empty())
        .expect("request")
}

fn get_as(uri: &str, cookie: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .header(header::COOKIE, cookie_pair(cookie))
        .body(Body::empty())
        .expect("request")
}

fn post_json(uri: &str, origin: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::ORIGIN, origin)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(body).expect("body")))
        .expect("request")
}

/// Every route that serves project, tab, mail, calendar or task data.
const AUTHENTICATED_GETS: &[&str] = &[
    "/api/v1/status",
    "/api/v1/todo",
    "/api/v1/alerts",
    "/api/v1/calendar",
    "/api/v1/push",
    "/api/v1/mail",
    "/api/v1/mail/folders/anything",
    "/api/v1/mail/folders/anything/messages/anything",
    "/api/v1/activity",
    "/api/v1/projects",
    "/api/v1/projects/anything",
    "/api/v1/tabs/anything",
    "/api/v1/tabs/anything/schedules",
    "/api/v1/tabs/anything/transcript",
    "/api/v1/tabs/anything/uncommitted",
    "/api/v1/tabs/anything/changes",
    "/api/v1/projects/anything/prompts",
    "/api/v1/tabs/anything/desktop-images",
    "/api/v1/tabs/anything/markup/questions",
    "/api/v1/local-models",
];

/// The desktop bounds the tail before it sends one; this bounds it again at
/// the browser boundary, and keeps the newest end — a card that dropped the
/// last prompt to keep the first five would show a session's morning.
#[test]
fn a_tab_publishes_the_newest_prompts_of_its_tail_and_no_more() {
    use crate::services::mobile_control::protocol::{AgentTabPrompt, AgentTabPrompts};
    let rows = prompt_rows(vec![AgentTabPrompts {
        tmux_session: concat!(crate::app_slug!(), "-p_paper--agent-123456789").into(),
        prompts: (0..12)
            .map(|n| AgentTabPrompt {
                text: format!("prompt {n}"),
                at: Some(format!("2026-09-17T08:{n:02}:00Z")),
            })
            .collect(),
    }]);
    let prompts = &rows[concat!(crate::app_slug!(), "-p_paper--agent-123456789")];
    assert_eq!(prompts.len(), MAX_TAB_PROMPTS);
    // Oldest first, ending on the newest the desktop sent.
    assert_eq!(prompts[0].text, "prompt 7");
    assert_eq!(prompts[MAX_TAB_PROMPTS - 1].text, "prompt 11");
}

#[test]
fn a_long_prompt_is_cut_before_it_reaches_the_phone() {
    use crate::services::mobile_control::protocol::{AgentTabPrompt, AgentTabPrompts};
    let rows = prompt_rows(vec![AgentTabPrompts {
        tmux_session: concat!(crate::app_slug!(), "-p_paper--agent-123456789").into(),
        prompts: vec![AgentTabPrompt {
            // Multi-byte on purpose: the cut counts characters, so a byte
            // slice here would panic mid-character.
            text: "ä".repeat(MAX_TAB_PROMPT_CHARS + 40),
            at: None,
        }],
    }]);
    let prompts = &rows[concat!(crate::app_slug!(), "-p_paper--agent-123456789")];
    assert_eq!(prompts[0].text.chars().count(), MAX_TAB_PROMPT_CHARS);
    assert!(prompts[0].at.is_none());
}

#[test]
fn mobile_policy_allows_only_same_origin_microphone_capture() {
    assert!(MOBILE_PERMISSIONS_POLICY.contains("microphone=(self)"));
    assert!(MOBILE_PERMISSIONS_POLICY.contains("on-device-speech-recognition=(self)"));
    assert!(MOBILE_PERMISSIONS_POLICY.contains("camera=()"));
    assert!(!MOBILE_PERMISSIONS_POLICY.contains("microphone=()"));
    assert!(!MOBILE_PERMISSIONS_POLICY.contains("microphone=(*"));
}

fn push_request(method: &str, origin: &str, cookie: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri("/api/v1/push")
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, cookie_pair(cookie))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(body).expect("body")))
        .expect("request")
}

/// The socket systemd passes arrives without `FD_CLOEXEC`; adopted, it
/// has it, so no child of the daemon inherits the listener.
#[cfg(unix)]
#[tokio::test]
async fn an_adopted_activation_socket_is_close_on_exec() {
    use std::os::unix::io::IntoRawFd;
    let dir = tempfile::tempdir().unwrap();
    let fd = std::os::unix::net::UnixListener::bind(dir.path().join("a.sock")).unwrap().into_raw_fd();
    // SAFETY: F_SETFD/F_GETFD on a descriptor this test owns.
    unsafe { libc::fcntl(fd, libc::F_SETFD, 0) };
    assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC, 0, "as systemd passes it");
    let listener = adopt_activation_fd(fd).unwrap();
    // SAFETY: as above; the listener still owns `fd`.
    assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC, libc::FD_CLOEXEC);
    drop(listener);
}

/// A phone subscribes only from the exact origin, only to a push vendor's
/// endpoint, and loses the subscription the moment it is revoked.
#[tokio::test]
async fn push_subscriptions_are_origin_checked_vendor_only_and_die_with_the_device() {
    let host = Fixture::bare();
    let (cookie, device_id) = host.pair_device(&signing_key(44)).await;
    let (status, _, body) = host.send(get_as("/api/v1/push", &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let state = json(&body);
    assert_eq!(state["subscribed"], false);
    let vapid = Base64UrlUnpadded::decode_vec(state["vapid_public_key"].as_str().expect("key"))
        .expect("base64url key");
    assert_eq!(vapid.len(), 65);

    use p256::elliptic_curve::sec1::ToEncodedPoint;
    let phone = p256::SecretKey::from_slice(&[5u8; 32]).expect("phone key");
    let subscription = |endpoint: &str| {
        serde_json::json!({
            "endpoint": endpoint,
            "p256dh": Base64UrlUnpadded::encode_string(
                phone.public_key().to_encoded_point(false).as_bytes(),
            ),
            "auth": Base64UrlUnpadded::encode_string(&[3u8; 16]),
            "details": true,
            "calendar": true,
            "agents": "questions",
        })
    };
    let good = subscription("https://fcm.googleapis.com/fcm/send/phone");
    let (status, _, _) = host
        .send(push_request("PUT", "https://evil.example", &cookie, &good))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = host
        .send(push_request("PUT", ORIGIN, &cookie, &subscription("https://evil.example/push")))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _, body) = host.send(push_request("PUT", ORIGIN, &cookie, &good)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(json(&body)["subscribed"], true);
    assert_eq!(json(&body)["details"], true);
    assert_eq!(json(&body)["agents"], "questions");
    assert_eq!(json(&body)["lapsed"], false);

    // The push service says the endpoint is gone: the phone is told it
    // lapsed, with the choices it made and the endpoint that died — what
    // its silent refresh re-subscribes from.
    host.state
        .auth
        .lock()
        .unwrap()
        .push_lapse_endpoint("https://fcm.googleapis.com/fcm/send/phone");
    let (_, _, body) = host.send(get_as("/api/v1/push", &cookie)).await;
    let lapsed = json(&body);
    assert_eq!(lapsed["subscribed"], false);
    assert_eq!(lapsed["lapsed"], true);
    assert_eq!(lapsed["agents"], "questions");
    assert_eq!(lapsed["details"], true);
    assert_eq!(lapsed["endpoint"], "https://fcm.googleapis.com/fcm/send/phone");
    // Registering a fresh subscription brings it back…
    let fresh = subscription("https://fcm.googleapis.com/fcm/send/phone-2");
    let (status, _, body) = host.send(push_request("PUT", ORIGIN, &cookie, &fresh)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(json(&body)["subscribed"], true);
    assert_eq!(json(&body)["lapsed"], false);
    // …and an explicit unsubscribe removes even a lapsed record.
    host.state
        .auth
        .lock()
        .unwrap()
        .push_lapse_endpoint("https://fcm.googleapis.com/fcm/send/phone-2");
    let (status, _, body) = host
        .send(push_request("DELETE", ORIGIN, &cookie, &serde_json::json!({})))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(json(&body)["subscribed"], false);
    assert_eq!(json(&body)["lapsed"], false);
    let (status, _, _) = host.send(push_request("PUT", ORIGIN, &cookie, &good)).await;
    assert_eq!(status, StatusCode::OK);
    host.state
        .auth
        .lock()
        .unwrap()
        .push_lapse_endpoint("https://fcm.googleapis.com/fcm/send/phone");

    host.state.auth.lock().unwrap().revoke(&device_id).expect("revoke");
    assert!(host.state.auth.lock().unwrap().push().subscription(&device_id).is_none());
}

#[tokio::test]
async fn every_data_route_refuses_an_unauthenticated_request() {
    let host = Fixture::with_project();
    for uri in AUTHENTICATED_GETS {
        let (status, _, body) = host.send(get_request(uri)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} answered: {body}");
        assert_eq!(json(&body)["error"], "authentication_required", "{uri}");
    }
}

/// The Git sheet's route: a project's overview, from the cache inside its
/// TTL; a box is `not_a_project`; nothing raw crosses.
#[tokio::test]
async fn the_git_overview_answers_projects_only_and_from_its_cache() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(61)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();

    // Not a repo: the fixture's folder is a plain directory.
    let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/git"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["repo"], false);
    assert!(!body.contains(RAW_PROJECT) && !body.contains(&*host.root.to_string_lossy()), "{body}");
    let now = Instant::now();
    assert!(host.state.git_overview.lock().unwrap().get(RAW_PROJECT, now).is_some(), "cached");

    // A second call inside the TTL is the cache's answer, not a new probe.
    let seeded = git_overview::GitOverview { repo: true, branches_total: 42, ..Default::default() };
    host.state.git_overview.lock().unwrap().set(RAW_PROJECT, seeded, Instant::now());
    let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/git"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["branches_total"], 42);

    let (status, _, body) = host.send(get_as("/api/v1/projects/nope/git", &cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["error"], "project_not_found");
    let (status, _, _) = host
        .send(Request::builder().uri(format!("/api/v1/projects/{project_id}/git")).body(Body::empty()).expect("request"))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let host = Fixture::with_box();
    let cookie = host.pair_device(&signing_key(62)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let box_id = json(&projects_body)["projects"][0]["id"].as_str().expect("box id").to_string();
    let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{box_id}/git"), &cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    assert_eq!(json(&body)["error"], "not_a_project");
}

#[tokio::test]
async fn mutating_routes_refuse_an_unauthenticated_request() {
    let host = Fixture::with_project();
    let create = serde_json::json!({
        "project_id": "anything",
        "kind": "shell",
        "idempotency_key": "0123456789abcdef",
    });
    for uri in [
        "/api/v1/projects/anything/tabs",
        "/api/v1/projects/anything/activate",
        "/api/v1/todo",
        "/api/v1/alerts",
        "/api/v1/calendar",
        "/api/v1/tabs/anything/schedules",
        "/api/v1/tabs/anything/inbox",
        "/api/v1/projects/anything/inbox",
        "/api/v1/inbox",
        "/api/v1/tabs/anything/desktop-images",
        "/api/v1/tabs/anything/prompt",
        "/api/v1/tabs/anything/held",
        "/api/v1/tabs/anything/sign-in-callback",
        "/api/v1/tabs/anything/sign-in",
        "/api/v1/tabs/anything/teleport",
        "/api/v1/projects/anything/prompts",
        "/api/v1/projects/anything/prompts/anything/send",
        "/api/v1/mail/folders/anything/messages/anything/mark",
        "/api/v1/mail/folders/anything/messages/anything/reply",
        "/api/v1/local-models",
    ] {
        let (status, _, body) = host.send(post_json(uri, ORIGIN, &create)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} answered: {body}");
    }
    // The rename route is the one mutation that is a PUT on a GET path.
    let put = Request::builder()
        .method("PUT")
        .uri("/api/v1/tabs/anything")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({ "label": "x" })).expect("body"),
        ))
        .expect("request");
    let (status, _, body) = host.send(put).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
    let edit = Request::builder()
        .method("PUT")
        .uri("/api/v1/tabs/anything/held/anything")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({ "message": "x" })).expect("body"),
        ))
        .expect("request");
    let (status, _, body) = host.send(edit).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "held edit answered: {body}");
}

#[tokio::test]
async fn schedule_editor_requires_the_desktop_bridge_and_leaks_no_raw_target() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(12)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"]
        .as_str()
        .expect("opaque project id")
        .to_string();
    let (_, _, project_body) = host
        .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
        .await;
    let tab_id = json(&project_body)["tabs"][0]["id"]
        .as_str()
        .expect("opaque tab id")
        .to_string();

    // No window: the list is answered off the file — nothing filed for a
    // tab with no schedule binding yet — and flagged so the phone shows it
    // read-only. Nothing raw crosses either way.
    let (status, _, body) = host
        .send(get_as(&format!("/api/v1/tabs/{tab_id}/schedules"), &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let answer = json(&body);
    assert_eq!(answer["desktop_available"], false);
    assert_eq!(answer["schedules"], serde_json::json!([]));
    assert!(!body.contains(RAW_PROJECT));
    assert!(!body.contains(&host.root.to_string_lossy().to_string()));
    assert!(!body.contains("scheduleTargetId"));
    assert!(!body.contains(crate::brand::TMUX_PREFIX));

    // A tab the desktop never bound to a schedule target has nowhere to
    // file a rule: the owner answers "no such tab" rather than inventing
    // a binding (H3).
    let create = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/tabs/{tab_id}/schedules"))
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, cookie_pair(&cookie))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "enabled": true,
                "message": "Review",
                "rule": { "type": "daily", "time": "09:00" },
            }))
            .expect("body"),
        ))
        .expect("request");
    let (status, _, body) = host.send(create).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    assert_eq!(json(&body)["error"], "tab_not_found");
    assert!(!body.contains(crate::brand::TMUX_PREFIX));
}

/// A host whose spawn seam records what it is asked to start (and starts
/// nothing), with every agent CLI "installed".
fn headless_host(launch: headless::HeadlessLaunch) -> Fixture {
    let mut host = Fixture::with_project();
    // Shell tabs are off the phone unless switched on; the owner mints
    // shells too, so the fixture opts in.
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        serde_json::json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true } }).to_string(),
    )
    .expect("write settings");
    host.state.spawner = HeadlessSpawner { launch, installed: Arc::new(|_| true), ..HeadlessSpawner::default() };
    host
}

/// A same-origin, authenticated JSON request of any method.
fn request_as(method: &str, uri: &str, cookie: &str, body: Option<Value>) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, cookie_pair(cookie))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.map(|b| serde_json::to_vec(&b).expect("body")).unwrap_or_default()))
        .expect("request")
}

/// The opaque project id and the agent tab id of the `with_project` host.
async fn project_and_tab(host: &Fixture, cookie: &str) -> (String, String) {
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().unwrap_or_else(|| panic!("project id: {projects_body}")).to_string();
    let (_, _, project_body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), cookie)).await;
    let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("tab id").to_string();
    (project_id, tab_id)
}

/// A phone's new project: the route hands only the name and the asking
/// phone's device id to the create seam, answers with the new row as this
/// phone's catalog lists it (no raw id, no path), and maps each refusal
/// to its own code. Cross-origin and unknown fields are refused before
/// anything is created.
#[tokio::test]
async fn a_phone_creates_a_project_by_name_only() {
    let mut host = Fixture::bare();
    let asked: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = asked.clone();
    let state_dir = host.state.config.state_dir.clone();
    let folder = host.root.join("my-paper");
    host.state.spawner.new_project = Arc::new(move |name: &str, device: &str| {
        sink.lock().unwrap().push((name.to_string(), device.to_string()));
        match name {
            "taken" => return Err(PhoneProjectRefusal::Exists),
            "" => return Err(PhoneProjectRefusal::InvalidName),
            _ => {}
        }
        std::fs::create_dir_all(&folder).expect("project folder");
        std::fs::write(
            state_dir.join("projects.json"),
            serde_json::to_vec(&json!([{
                "id": "raw-new-project",
                "name": name,
                "status": "active",
                "directory": folder.to_string_lossy(),
                concat!(crate::app_slug!(), "_mobile_access"): true,
                concat!(crate::app_slug!(), "_mobile_devices"): [device],
            }]))
            .expect("projects"),
        )
        .expect("write projects");
        Ok("raw-new-project".to_string())
    });
    let (cookie, device) = host.pair_device(&signing_key(61)).await;

    let mut cross = request_as("POST", "/api/v1/projects", &cookie, Some(json!({ "name": "My Paper" })));
    cross.headers_mut().insert(header::ORIGIN, "https://elsewhere.example".parse().unwrap());
    let (status, _, _) = host.send(cross).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = host
        .send(request_as("POST", "/api/v1/projects", &cookie, Some(json!({ "name": "x", "directory": "/tmp" }))))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a folder is never the phone's to choose");
    assert!(asked.lock().unwrap().is_empty(), "nothing reached the create seam");

    let (status, _, body) = host
        .send(request_as("POST", "/api/v1/projects", &cookie, Some(json!({ "name": "My Paper" }))))
        .await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    assert_eq!(json(&body)["project"]["label"], "My Paper");
    assert!(json(&body)["project"]["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(!body.contains("raw-new-project"), "raw project id leaked: {body}");
    assert!(!body.contains(&host.root.to_string_lossy().to_string()), "path leaked: {body}");
    assert_eq!(asked.lock().unwrap()[0], ("My Paper".to_string(), device));

    let (status, _, body) = host
        .send(request_as("POST", "/api/v1/projects", &cookie, Some(json!({ "name": "taken" }))))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(json(&body)["error"], "project_exists");
    let (status, _, body) = host
        .send(request_as("POST", "/api/v1/projects", &cookie, Some(json!({ "name": "" }))))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["error"], "invalid_name");
}

/// H3 (headless owner plan §3): with no window open, the phone's tab
/// edits — rename, colour, close, reopen — are the owner's: they land in
/// the session file through the workspace service, answered as stored
/// and flagged; a close ends the tab's session and remembers an agent
/// tab; a reopen brings it back as a new tab started detached on its
/// resume args. Nothing raw crosses.
#[tokio::test]
async fn tab_edits_close_and_reopen_are_the_owners_with_no_window() {
    let recorded: Arc<Mutex<Vec<PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = recorded.clone();
    let host = headless_host(Arc::new(move |opts: PtyOptions| {
        sink.lock().unwrap().push(opts);
        Box::pin(async { Ok(()) })
    }));
    let cookie = host.pair_device(&signing_key(51)).await.0;
    let (project_id, tab_id) = project_and_tab(&host, &cookie).await;
    let session_file = host.state.config.state_dir.join("sessions").join(RAW_PROJECT).join("terminals.json");
    let leaks = |body: &str| {
        assert!(!body.contains(RAW_PROJECT), "raw project id leaked: {body}");
        assert!(!body.contains(crate::brand::TMUX_PREFIX), "tmux name leaked: {body}");
        assert!(!body.contains("9d0f-session"), "session id leaked: {body}");
        assert!(!body.contains(&host.root.to_string_lossy().to_string()), "path leaked: {body}");
    };

    let (status, _, body) = host
        .send(request_as("PUT", &format!("/api/v1/tabs/{tab_id}"), &cookie, Some(json!({ "label": "  Review  " }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false);
    assert_eq!(json(&body)["tab"]["label"], "Review", "the row as stored, trimmed");
    leaks(&body);
    let (status, _, body) = host
        .send(request_as("PUT", &format!("/api/v1/tabs/{tab_id}/color"), &cookie, Some(json!({ "color": "teal" }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["tab"]["color"], "teal");
    leaks(&body);
    let stored: crate::schema::session::TerminalSession = crate::storage::read_json(&session_file).expect("session");
    assert!(crate::services::workspace::is_owned(&stored));
    assert_eq!(stored.tab_layout[0].label, "Review"); // project-tree-read: ok — the state-dir session file.
    assert_eq!(stored.tab_layout[0].extra["color"], "teal"); // project-tree-read: ok — same.

    // Closing: the tab is gone from the file and the catalog, its session
    // was ended, and the project lists it under "Recently closed".
    let (status, _, body) = host.send(request_as("DELETE", &format!("/api/v1/tabs/{tab_id}"), &cookie, None)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["closed"], true);
    assert_eq!(host.runner.killed.lock().unwrap().as_slice(), [format!("{}{RAW_PROJECT}--agent-abcdef123", crate::brand::TMUX_PREFIX)]);
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    let detail = json(&body);
    assert_eq!(detail["tabs"].as_array().map(Vec::len), Some(0), "{body}");
    assert_eq!(detail["closed"].as_array().map(Vec::len), Some(1), "{body}");
    assert_eq!(detail["closed"][0]["label"], "Review");
    assert_eq!(detail["closed"][0]["agent"], "claude");
    let closed_id = detail["closed"][0]["id"].as_str().expect("closed id").to_string();
    leaks(&body);
    let (status, _, body) = host.send(request_as("DELETE", &format!("/api/v1/tabs/{tab_id}"), &cookie, None)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

    // Reopening by that id: a new tab on the resume args a restart would
    // give it, started through the spawn seam, listed, and gone from the
    // closed row; a second reopen has nothing left.
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/projects/{project_id}/tabs/reopen"), &cookie, Some(json!({ "closed_id": closed_id }))))
        .await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    let answer = json(&body);
    assert_eq!(answer["desktop_available"], false);
    assert_eq!(answer["tab"]["label"], "Review");
    assert_ne!(answer["tab"]["id"], tab_id, "a new tab");
    leaks(&body);
    let spawned = recorded.lock().unwrap().clone();
    assert_eq!(spawned.len(), 1);
    assert_eq!(spawned[0].cmd, "claude");
    assert_eq!(spawned[0].args, vec!["--resume".to_string(), "9d0f-session".to_string()]);
    assert!(spawned[0].tmux_session.as_deref().is_some_and(|n| n.starts_with(&format!("{}{RAW_PROJECT}--agent-", crate::brand::TMUX_PREFIX))));
    assert_ne!(spawned[0].tmux_session.as_deref(), Some(&*format!("{}{RAW_PROJECT}--agent-abcdef123", crate::brand::TMUX_PREFIX)), "a fresh session name");
    let stored: crate::schema::session::TerminalSession = crate::storage::read_json(&session_file).expect("session");
    assert_eq!(stored.tab_layout.len(), 1); // project-tree-read: ok — the state-dir session file.
    assert_eq!(stored.tab_layout[0].session_id.as_deref(), Some("9d0f-session")); // project-tree-read: ok — same.
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    assert_eq!(json(&body)["closed"], json!([]));
    assert_eq!(json(&body)["tabs"][0]["label"], "Review");
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/projects/{project_id}/tabs/reopen"), &cookie, None))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "answered: {body}");
    assert_eq!(json(&body)["error"], "nothing_to_reopen");
}

/// Bind the `with_project` host's agent tab to schedule target `tgt-1`.
fn bind_schedule_target(host: &Fixture) {
    std::fs::write(
        host.state.config.state_dir.join("sessions").join(RAW_PROJECT).join("terminals.json"),
        serde_json::to_vec(&json!({
            "tabLayout": [{
                "label": "Claude",
                "cmd": "claude",
                "cwd": host.root.to_string_lossy(),
                "kind": "agent",
                "sessionId": "9d0f-session",
                "scheduleTargetId": "tgt-1",
                "tmuxSession": format!("{}{RAW_PROJECT}--agent-abcdef123", crate::brand::TMUX_PREFIX),
            }]
        }))
        .expect("session fixture"),
    )
    .expect("write session");
}

/// With no window open the owner holds a prompt the phone sent mid-turn:
/// a send-now rule on the tab's binding, marked for its scheduler to type
/// at once, and editable until delivered — nothing raw crossing.
#[tokio::test]
async fn a_phone_prompt_is_held_and_edited_by_the_owner_with_no_window() {
    let host = Fixture::with_project();
    bind_schedule_target(&host);
    let state_dir = host.state.config.state_dir.clone();
    let cookie = host.pair_device(&signing_key(57)).await.0;
    let (_, tab_id) = project_and_tab(&host, &cookie).await;
    let held_uri = format!("/api/v1/tabs/{tab_id}/held");

    let (status, _, body) = host
        .send(request_as("POST", &held_uri, &cookie, Some(json!({ "message": "also update the docs" }))))
        .await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false);
    assert!(!body.contains("tgt-1") && !body.contains(RAW_PROJECT), "{body}");
    let held_id = json(&body)["id"].as_str().expect("held id").to_string();
    assert!(host.state.holds.due(&held_id), "marked for the scheduler");
    let rules = crate::services::agent_tasks::list_at(&state_dir, RAW_PROJECT, "tgt-1").expect("rules");
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].id, held_id);
    assert_eq!(rules[0].message, "also update the docs");

    let (status, _, body) = host
        .send(request_as("PUT", &format!("{held_uri}/{held_id}"), &cookie, Some(json!({ "message": "update the docs and the tests" }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["id"], held_id);
    let rules = crate::services::agent_tasks::list_at(&state_dir, RAW_PROJECT, "tgt-1").expect("rules");
    assert_eq!(rules[0].message, "update the docs and the tests");

    let (status, _, body) = host
        .send(request_as("PUT", &format!("{held_uri}/gone-1"), &cookie, Some(json!({ "message": "x" }))))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "answered: {body}");
    assert_eq!(json(&body)["error"], "held_gone");
    let (status, _, body) = host
        .send(request_as("POST", &held_uri, &cookie, Some(json!({ "message": "/clear" }))))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a command is typed by the phone: {body}");
    assert_eq!(json(&body)["error"], "invalid_prompt");
}

/// H3 (the plan's exit, the writes half): with no window open, the
/// phone edits a to-do card and a calendar event (CAS on
/// `calendar.json`), writes and removes a schedule and a collected
/// prompt, sends a prompt now (a one-time rule the sidecar's scheduler
/// fires, the prompt retired to the history), records a composer prompt,
/// asks for the tab's status and the ＋ sheet's options, and attaches a
/// desktop image — every answer flagged, nothing raw crossing.
#[tokio::test]
async fn writes_with_side_effects_are_the_owners_with_no_window() {
    let host = Fixture::with_project();
    bind_schedule_target(&host);
    let state_dir = host.state.config.state_dir.clone();
    let cookie = host.pair_device(&signing_key(54)).await.0;
    let (project_id, tab_id) = project_and_tab(&host, &cookie).await;
    let leaks = |body: &str| {
        assert!(!body.contains(RAW_PROJECT), "raw project id leaked: {body}");
        assert!(!body.contains("tgt-1"), "schedule target leaked: {body}");
        assert!(!body.contains(crate::brand::TMUX_PREFIX), "tmux name leaked: {body}");
        assert!(!body.contains("9d0f-session"), "session id leaked: {body}");
        assert!(!body.contains(&host.root.to_string_lossy().to_string()), "path leaked: {body}");
    };

    // The board: a card is created into the intake column, ticked, and
    // the answer is the board as stored.
    let (_, _, body) = host.send(get_as("/api/v1/todo", &cookie)).await;
    let board = json(&body)["board"].clone();
    let intake = board["columns"].as_array().unwrap().iter().find(|c| c["intake"] == true).unwrap()["id"].as_str().unwrap().to_string();
    let calendar_id = board["calendars"][0]["id"].as_str().expect("calendar id").to_string();
    let card = json!({ "title": "From the phone", "notes": "", "priority": 0, "percent": 0, "column": intake,
        "calendar_id": calendar_id, "project_id": project_id, "tags": [], "subtasks": [] });
    let (status, _, body) = host
        .send(request_as("POST", "/api/v1/todo", &cookie, Some(json!({ "type": "create", "task": card }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let answer = json(&body);
    assert_eq!(answer["desktop_available"], false);
    assert_eq!(answer["board"]["tasks"][0]["title"], "From the phone");
    assert_eq!(answer["board"]["tasks"][0]["project_id"], project_id);
    let task_id = answer["board"]["tasks"][0]["id"].as_str().expect("task id").to_string();
    leaks(&body);
    let (status, _, body) = host
        .send(request_as("POST", "/api/v1/todo", &cookie, Some(json!({ "type": "toggle", "task_id": task_id }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["board"]["tasks"][0]["done"], true);
    let (status, _, body) = host
        .send(request_as("POST", "/api/v1/todo", &cookie, Some(json!({ "type": "toggle", "task_id": "not-a-card" }))))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

    // The calendar: an event is created, then deleted, on the month.
    let event = json!({ "calendar_id": calendar_id, "start": "2026-07-15T10:00", "end": "2026-07-15T11:00", "all_day": false,
        "title": "Defense", "location": "", "notes": "", "conference": "", "category": "", "status": "" });
    let (status, _, body) = host
        .send(request_as("POST", "/api/v1/calendar?month=2026-07", &cookie, Some(json!({ "type": "create_event", "event": event }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let month = json(&body);
    assert_eq!(month["desktop_available"], false);
    assert_eq!(month["calendar"]["events"][0]["title"], "Defense");
    let event_id = month["calendar"]["events"][0]["id"].as_str().expect("event id").to_string();
    let data = crate::services::calendar_store::read_data(&state_dir.join("calendar.json")).expect("calendar");
    assert_eq!(data.events.len(), 1);
    assert!(!body.contains(&data.events[0].id), "raw event id leaked: {body}");
    let (status, _, body) = host
        .send(request_as("POST", "/api/v1/calendar?month=2026-07", &cookie, Some(json!({ "type": "delete_event", "event_id": event_id }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["calendar"]["events"], json!([]));

    // Schedules: a rule is created, edited (keeping prefix commands the
    // phone never sees), and removed.
    std::fs::write(
        state_dir.join("agent_tasks.json"),
        json!({ "version": 1, "projects": { RAW_PROJECT: { "tgt-1": { "schedules": [
            { "id": "sched-1", "enabled": true, "message": "Nightly review", "preface": ["/clear"], "rule": { "type": "daily", "time": "09:00" } }
        ] } } } })
        .to_string(),
    )
    .expect("tasks fixture");
    let (status, _, body) = host
        .send(request_as(
            "POST",
            &format!("/api/v1/tabs/{tab_id}/schedules"),
            &cookie,
            Some(json!({ "enabled": true, "message": "Morning plan", "rule": { "type": "daily", "time": "08:00" } })),
        ))
        .await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    let listed = json(&body);
    assert_eq!(listed["desktop_available"], false);
    assert_eq!(listed["schedules"].as_array().map(Vec::len), Some(2));
    let created = listed["schedules"].as_array().unwrap().iter().find(|s| s["message"] == "Morning plan").unwrap()["id"].as_str().unwrap().to_string();
    assert!(listed["next_runs"][&created].as_str().is_some_and(|k| k.ends_with("T08:00")));
    leaks(&body);
    let (status, _, body) = host
        .send(request_as(
            "PUT",
            &format!("/api/v1/tabs/{tab_id}/schedules/sched-1"),
            &cookie,
            Some(json!({ "enabled": false, "message": "Nightly review, later", "rule": { "type": "daily", "time": "21:00" } })),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let stored = crate::services::agent_tasks::list_at(&state_dir, RAW_PROJECT, "tgt-1").expect("rules");
    let nightly = stored.iter().find(|r| r.id == "sched-1").expect("kept");
    assert_eq!(nightly.message, "Nightly review, later");
    assert!(!nightly.enabled);
    assert_eq!(nightly.preface, ["/clear"], "the desktop's prefix commands survive a phone edit");
    let (status, _, body) = host
        .send(request_as("DELETE", &format!("/api/v1/tabs/{tab_id}/schedules/{created}"), &cookie, None))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["schedules"].as_array().map(Vec::len), Some(1));
    let (status, _, body) = host
        .send(request_as("PUT", &format!("/api/v1/tabs/{tab_id}/schedules/gone"), &cookie, Some(json!({ "enabled": true, "message": "x", "rule": { "type": "daily", "time": "08:00" } }))))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

    // Collected prompts: created, edited, sent now (a one-time rule at
    // this minute under the prompt's id; the prompt retired to the
    // history), and one deleted.
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/projects/{project_id}/prompts"), &cookie, Some(json!({ "message": "Write the intro" }))))
        .await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    let answer = json(&body);
    assert_eq!(answer["desktop_available"], false);
    let prompt_id = answer["prompts"][0]["id"].as_str().expect("prompt id").to_string();
    let (status, _, body) = host
        .send(request_as("PUT", &format!("/api/v1/projects/{project_id}/prompts/{prompt_id}"), &cookie, Some(json!({ "message": "Write the intro, briefly" }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["prompts"][0]["message"], "Write the intro, briefly");
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/projects/{project_id}/prompts/{prompt_id}/send"), &cookie, Some(json!({ "tab_id": tab_id }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["prompts"], json!([]), "retired to the history");
    let rules = crate::services::agent_tasks::list_at(&state_dir, RAW_PROJECT, "tgt-1").expect("rules");
    let queued = rules.iter().find(|r| r.id == prompt_id).expect("a one-time rule under the prompt's id");
    assert!(matches!(&queued.rule, crate::schema::agent_tasks::AgentScheduleRule::Once { at } if at.len() == 16));
    assert_eq!(queued.message, "Write the intro, briefly");
    let history = crate::services::agent_prompts::list_at(&state_dir, RAW_PROJECT).expect("prompts");
    assert!(history.is_empty());
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/projects/{project_id}/prompts"), &cookie, Some(json!({ "message": "Throwaway" }))))
        .await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    let other = json(&body)["prompts"][0]["id"].as_str().expect("prompt id").to_string();
    let (status, _, body) = host
        .send(request_as("DELETE", &format!("/api/v1/projects/{project_id}/prompts/{other}"), &cookie, None))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["prompts"], json!([]));

    // The composer's prompt is recorded on the history; a session
    // command is not.
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/tabs/{tab_id}/prompt"), &cookie, Some(json!({ "message": "  Summarize the diff  " }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["recorded"], true);
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/tabs/{tab_id}/prompt"), &cookie, Some(json!({ "message": "/clear" }))))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["recorded"], false);
    let file: serde_json::Value = serde_json::from_slice(&std::fs::read(state_dir.join("agent_prompts.json")).expect("prompts file")).expect("json");
    let rows = file["history"][RAW_PROJECT].as_array().expect("history rows");
    assert!(rows.iter().any(|row| row["message"] == "Summarize the diff" && row["tab_label"] == "Claude" && row["result"] == "delivered"), "{file}");
    assert!(rows.iter().any(|row| row["message"] == "Write the intro, briefly"), "the send-now was retired here: {file}");
    assert!(!rows.iter().any(|row| row["message"] == "/clear"));

    // Nothing to undo for a tab whose hook recorded no clear.
    let (status, _, body) = host.send(request_as("POST", &format!("/api/v1/tabs/{tab_id}/undo-clear"), &cookie, None)).await;
    assert_eq!(status, StatusCode::CONFLICT, "answered: {body}");
    assert_eq!(json(&body)["error"], "nothing_to_undo");

    // The tab's status: state and tally off the files, no usage panel.
    let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/status"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let report = json(&body)["report"].clone();
    assert_eq!(report["state"], "idle");
    assert_eq!(report["label"], "Claude");
    assert_eq!(report["project"], "Aurora");
    assert_eq!(report["usage"]["supported"], false);
    assert_eq!(report["usage"]["error"], "desktop_unavailable");
    leaks(&body);

    // The ＋ sheet's options: only what the owner can start.
    let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/launch-options"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let options = json(&body);
    assert_eq!(options["desktop_available"], false);
    assert_eq!(options["worktrees"], json!([]));
    assert_eq!(options["sign_in"], json!([]));

    // Desktop images: a file in Tabtivity's own screenshot folder is listed
    // (no clipboard) and attached into the project inbox.
    let shots = state_dir.join("screenshots-pending");
    std::fs::create_dir_all(&shots).expect("shots dir");
    std::fs::write(shots.join("shot.png"), b"\x89PNG\r\n\x1a\nnot really").expect("shot");
    let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/desktop-images"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let images = json(&body);
    assert_eq!(images["desktop_available"], false);
    let shot = images["images"].as_array().unwrap().iter().find(|i| i["name"] == "shot.png").expect("the screenshot is listed");
    assert!(!images["images"].as_array().unwrap().iter().any(|i| i["id"] == "clipboard"));
    let image_id = shot["id"].as_str().unwrap().to_string();
    assert!(!body.contains("screenshots-pending"), "folder path leaked: {body}");
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/tabs/{tab_id}/desktop-images"), &cookie, Some(json!({ "image_id": image_id }))))
        .await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    let attached = json(&body)["attachment"].clone();
    assert!(attached["reference"].as_str().is_some_and(|r| r.starts_with(concat!(".", crate::app_slug!(), "/inbox/"))), "{body}");
    assert!(host.root.join(attached["reference"].as_str().unwrap()).is_file());
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/tabs/{tab_id}/desktop-images"), &cookie, Some(json!({ "image_id": "clipboard" }))))
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
}

/// H3: the owner's undo of a Claude `/clear` types the resume into the
/// running session, and a relaunch plan ends the session and starts the
/// tab again on its resume args; a tab whose session is gone is not
/// ready.
#[tokio::test]
async fn an_undo_with_no_window_types_or_relaunches() {
    use crate::services::agent_session::UndoClearPlan;
    let recorded: Arc<Mutex<Vec<PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = recorded.clone();
    let host = headless_host(Arc::new(move |opts: PtyOptions| {
        sink.lock().unwrap().push(opts);
        Box::pin(async { Ok(()) })
    }));
    let snapshot = catalog_unfiltered(&host.state).expect("catalog");
    let project = snapshot.project(&snapshot.projects[0].public.id).expect("project");
    let tab = &project.tabs[0];
    let runner: Arc<dyn scheduler::Runner> = host.runner.clone();
    let state_dir = host.state.config.state_dir.clone();

    let outcome = headless::apply_undo_plan(&state_dir, project, tab, Some(UndoClearPlan::Type { command: "/resume abc".into() }), runner.clone(), &host.state.spawner.launch).await;
    assert_eq!(outcome, Ok(headless::UndoOutcome::TabNotReady), "no session to type into");
    *host.runner.probe.lock().unwrap() = Some(scheduler::SessionProbe { created: 1, activity: 1 });
    let outcome = headless::apply_undo_plan(&state_dir, project, tab, Some(UndoClearPlan::Type { command: "/resume abc".into() }), runner.clone(), &host.state.spawner.launch).await;
    assert_eq!(outcome, Ok(headless::UndoOutcome::Undone));
    let typed = host.runner.delivered.lock().unwrap().clone();
    assert_eq!(typed.len(), 1);
    assert_eq!(typed[0].0, tab.tmux_name);
    assert_eq!(typed[0].1, vec![scheduler::Submission { text: "/resume abc".into(), bracketed: false }]);

    let outcome = headless::apply_undo_plan(&state_dir, project, tab, Some(UndoClearPlan::Relaunch), runner.clone(), &host.state.spawner.launch).await;
    assert_eq!(outcome, Ok(headless::UndoOutcome::Undone));
    assert_eq!(host.runner.killed.lock().unwrap().as_slice(), std::slice::from_ref(&tab.tmux_name));
    let spawned = recorded.lock().unwrap().clone();
    assert_eq!(spawned.len(), 1);
    assert_eq!(spawned[0].tmux_session.as_deref(), Some(tab.tmux_name.as_str()));
    assert_eq!(spawned[0].args, vec!["--resume".to_string(), "9d0f-session".to_string()]);
    assert_eq!(headless::apply_undo_plan(&state_dir, project, tab, None, runner, &host.state.spawner.launch).await, Ok(headless::UndoOutcome::NothingToUndo));
}

/// H3: activating a stopped project with no window marks its registry
/// entry active under the file's lock, so the next window opens it; a
/// box has no such status and still needs the window.
#[tokio::test]
async fn activating_a_project_with_no_window_marks_the_registry() {
    let host = Fixture::with_project();
    let registry = host.state.config.state_dir.join("projects.json");
    let mut list: Vec<Value> = serde_json::from_slice(&std::fs::read(&registry).expect("registry")).expect("json");
    list[0]["status"] = json!("inactive");
    std::fs::write(&registry, serde_json::to_vec(&list).expect("registry")).expect("write registry");
    let cookie = host.pair_device(&signing_key(52)).await.0;
    // A stopped project is off the phone's default list; the search
    // view still finds it.
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    assert_eq!(json(&projects_body)["projects"], json!([]));
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects?view=search&q=aur", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().unwrap_or_else(|| panic!("project id: {projects_body}")).to_string();
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    assert_eq!(json(&body)["project"]["status"], "inactive");
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/projects/{project_id}/activate"), &cookie, None))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false);
    let list: Vec<Value> = serde_json::from_slice(&std::fs::read(&registry).expect("registry")).expect("json");
    assert_eq!(list[0]["status"], "active");
    assert_eq!(list[0]["name"], "Aurora", "the rest of the entry survived");
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    assert_eq!(json(&body)["project"]["status"], "active");
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    assert_eq!(json(&projects_body)["projects"][0]["id"], project_id, "listed again");

    let host = Fixture::with_box();
    let cookie = host.pair_device(&signing_key(53)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let box_id = json(&projects_body)["projects"][0]["id"].as_str().expect("box id").to_string();
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/projects/{box_id}/activate"), &cookie, None))
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
    assert!(!body.contains(RAW_BOX));
}

/// `?tab=` on an activation names the tab the phone is opening (the
/// assistant starts its chats lazily): it must be a tab of that scope, an
/// unknown one is refused before the window is asked, and nothing else is
/// accepted in the query.
#[tokio::test]
async fn an_activation_may_name_only_a_tab_of_its_own_scope() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(54)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
    let activate = |query: &str| request_as("POST", &format!("/api/v1/projects/{project_id}/activate{query}"), &cookie, None);
    let (status, _, body) = host.send(activate("?tab=no-such-tab")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    assert!(body.contains("tab_not_found"), "answered: {body}");
    let (status, _, _) = host.send(activate("?other=1")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, body) = host.send(activate("")).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
}

fn create_request(project_id: &str, cookie: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/api/v1/projects/{project_id}/tabs"))
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, cookie_pair(cookie))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&body).expect("body")))
        .expect("request")
}

/// H1b exit (headless owner plan §3, H1): with no window, a phone's create
/// is the owner's — the tab is minted into the session file (id, tmux
/// name, schedule binding, request hash, session uuid), started detached
/// through the spawn seam under that name, and listed by the catalog; a
/// repeat of the request opens nothing twice; what needs the window is
/// still refused; and nothing raw crosses.
#[tokio::test]
async fn a_create_with_no_window_is_minted_spawned_and_listed_by_the_owner() {
    let recorded: Arc<Mutex<Vec<PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = recorded.clone();
    let host = headless_host(Arc::new(move |opts: PtyOptions| {
        sink.lock().unwrap().push(opts);
        Box::pin(async { Ok(()) })
    }));
    let cookie = host.pair_device(&signing_key(41)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
    let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let detail = json(&body);
    assert_eq!(detail["desktop_available"], false);
    assert_eq!(detail["closed"], json!([]));
    // The host says whether its tabs attach through tmux at all (3.4):
    // `tmux` here, `unsupported` on a Windows build — never absent.
    assert_eq!(detail["terminals"], terminals_support());
    assert_eq!(detail["terminals"], if cfg!(target_os = "windows") { "unsupported" } else { "tmux" });
    let claude = detail["agents"]
        .as_array()
        .expect("agents")
        .iter()
        .find(|a| a["label"] == "Claude")
        .expect("Claude is offered with no window")["id"]
        .as_str()
        .expect("agent id")
        .to_string();
    let request = json!({
        "project_id": project_id,
        "kind": "agent",
        "agent_id": claude,
        "idempotency_key": "h1b-exit-0123456789abcdef",
    });
    let (status, _, body) = host.send(create_request(&project_id, &cookie, request.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let answer = json(&body);
    assert_eq!(answer["desktop_available"], false);
    assert_eq!(answer["tab"]["kind"], "agent");
    assert_eq!(answer["tab"]["label"], "Claude");
    assert_eq!(answer["tab"]["available"], false, "no tmux server runs here");
    let tab_id = answer["tab"]["id"].as_str().expect("tab id").to_string();

    // The owner minted the tab into the session file.
    let session_path = host.state.config.state_dir.join("sessions").join(RAW_PROJECT).join("terminals.json");
    let session: Value = serde_json::from_slice(&std::fs::read(&session_path).expect("session")).expect("json");
    let tabs = session["tabLayout"].as_array().expect("tabs");
    assert_eq!(tabs.len(), 2, "{session}");
    let minted = &tabs[1];
    assert!(minted["id"].as_str().is_some_and(|id| !id.is_empty()), "{minted}");
    let tmux = minted["tmuxSession"].as_str().expect("tmux name").to_string();
    assert!(tmux.starts_with(&format!("{}{RAW_PROJECT}--agent-", crate::brand::TMUX_PREFIX)), "{tmux}");
    let target = minted["scheduleTargetId"].as_str().expect("schedule binding").to_string();
    assert!(minted["mobileRequestHash"].as_str().is_some());
    let uid = minted["sessionId"].as_str().expect("session uuid").to_string();
    assert_eq!(minted["args"], json!(["--session-id", uid]));
    assert_eq!(minted["env"][crate::app_env!("TAB_UID")], uid);
    assert!(session["workspaceVersion"].as_u64().is_some_and(|v| v >= 2), "{session}");
    let leaks = |body: &str| {
        assert!(!body.contains(RAW_PROJECT), "raw project id leaked: {body}");
        assert!(!body.contains(crate::brand::TMUX_PREFIX), "tmux name leaked: {body}");
        assert!(!body.contains(&uid), "session id leaked: {body}");
        assert!(!body.contains(&target), "schedule target leaked: {body}");
        assert!(!body.contains(&host.root.to_string_lossy().to_string()), "path leaked: {body}");
    };
    leaks(&body);

    // The spawn seam was handed the tab's launch under that name.
    let spawned = recorded.lock().unwrap().clone();
    assert_eq!(spawned.len(), 1);
    let opts = &spawned[0];
    assert_eq!(opts.tmux_session.as_deref(), Some(tmux.as_str()));
    assert_eq!(opts.id, format!("headless:{tmux}"));
    assert_eq!(opts.cmd, "claude");
    assert_eq!(opts.args, vec!["--session-id".to_string(), uid.clone()]);
    assert!(opts.agent);
    assert_eq!(opts.project_id.as_deref(), Some(RAW_PROJECT));
    assert!(std::path::Path::new(&opts.cwd).ends_with("work"), "{}", opts.cwd);
    assert_eq!(opts.env.get(crate::app_env!("TAB_UID")), Some(&uid));
    assert_eq!(opts.schedule_target_id.as_deref(), Some(target.as_str()));

    // The same request again answers the same tab and starts nothing.
    let (status, _, body) = host.send(create_request(&project_id, &cookie, request)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(json(&body)["tab"]["id"], tab_id);
    assert_eq!(recorded.lock().unwrap().len(), 1);
    let session: Value = serde_json::from_slice(&std::fs::read(&session_path).expect("session")).expect("json");
    assert_eq!(session["tabLayout"].as_array().expect("tabs").len(), 2);

    // The catalog lists it, and the activity list knows the project.
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    assert!(json(&body)["tabs"].as_array().expect("tabs").iter().any(|t| t["id"] == tab_id), "{body}");
    leaks(&body);
    let (status, _, body) = host.send(get_as("/api/v1/activity", &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(json(&body)["desktop_available"], false);
    leaks(&body);

    // What needs the window is still refused, and a shell is the owner's too.
    let (status, _, body) = host
        .send(create_request(
            &project_id,
            &cookie,
            json!({ "project_id": project_id, "kind": "agent", "agent_id": claude, "cloud": "new", "task": "x", "idempotency_key": "h1b-cloud-0123456789abcdef" }),
        ))
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(json(&body)["error"], "desktop_unavailable");
    let (status, _, body) = host
        .send(create_request(
            &project_id,
            &cookie,
            json!({ "project_id": project_id, "kind": "shell", "idempotency_key": "h1b-shell-0123456789abcdef" }),
        ))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(json(&body)["tab"]["kind"], "shell");
    let shell = recorded.lock().unwrap().last().cloned().expect("shell spawn");
    assert_eq!(shell.cmd, "");
    assert!(!shell.agent);
    assert!(shell.tmux_session.as_deref().is_some_and(|n| n.starts_with(&format!("{}{RAW_PROJECT}--shell-", crate::brand::TMUX_PREFIX))));
}

/// A host holding the chat assistant's scope and nothing else: the flag on
/// (so the scope is listed), the files, upload and shell switches on too —
/// so a refusal can only be the scope's — a recorder for the spawn seam
/// that makes the chat folder the way `launch_prep` does, and a fixed
/// answer for the desktop's options command.
fn assistant_host(launch: headless::HeadlessLaunch) -> Fixture {
    let mut host = Fixture::bare();
    let state_dir = host.state.config.state_dir.clone();
    std::fs::write(state_dir.join("projects.json"), "[]").expect("projects");
    std::fs::write(
        state_dir.join("settings.json"),
        json!({
            "assistant": true,
            crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true, "project_files": true, "project_uploads": true },
        })
        .to_string(),
    )
    .expect("write settings");
    let launch: headless::HeadlessLaunch = Arc::new(move |opts: PtyOptions| {
        // `launch_prep` makes the chat's folder before the process starts.
        let _ = std::fs::create_dir_all(&opts.cwd);
        launch(opts)
    });
    host.state.spawner = HeadlessSpawner {
        launch,
        installed: Arc::new(|_| true),
        assistant_options: Arc::new(|| Box::pin(async { Ok(super::super::assistant::fixture_options()) })),
        ..HeadlessSpawner::default()
    };
    host
}

/// Start one Claude chat through the phone's routes. Returns the scope's
/// opaque id and the chat's opaque tab id.
async fn start_assistant_chat(host: &Fixture, cookie: &str, key: &str) -> (String, String) {
    let (_, _, body) = host.send(get_as("/api/v1/projects", cookie)).await;
    let project_id = json(&body)["projects"][0]["id"].as_str().unwrap_or_else(|| panic!("scope: {body}")).to_string();
    let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/launch-options"), cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let launches = json(&body)["assistant"]["launches"].clone();
    let claude = launches.as_array().expect("launches").iter().find(|l| l["label"] == "Claude" && l["local"] == false).expect("a cloud Claude launch")["id"]
        .as_str()
        .expect("launch id")
        .to_string();
    let request = json!({ "project_id": project_id, "kind": "agent", "assistant": claude, "idempotency_key": key });
    let (status, _, body) = host.send(create_request(&project_id, cookie, request)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    (project_id, json(&body)["tab"]["id"].as_str().expect("tab id").to_string())
}

/// S5a: the assistant is a phone scope that needs no window. It is listed
/// as its own kind behind its gate; its launch options and create speak
/// opaque ids only; the owner mints the chat with `new_chat_record` (no
/// `args`, `env` or schedule binding in the record) and starts it detached
/// through `launch_options`, which hands `launch_prep` the validated launch
/// and the chat's uid and nothing the record said; a repeat opens nothing
/// twice; and everything but a chat is refused.
#[tokio::test]
async fn an_assistant_chat_is_started_by_the_owner_from_an_opaque_launch() {
    let recorded: Arc<Mutex<Vec<PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = recorded.clone();
    let host = assistant_host(Arc::new(move |opts: PtyOptions| {
        sink.lock().unwrap().push(opts);
        Box::pin(async { Ok(()) })
    }));
    let cookie = host.pair_device(&signing_key(71)).await.0;
    let (_, _, body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let row = &json(&body)["projects"][0];
    assert_eq!(row["kind"], "assistant");
    assert_eq!(row["label"], crate::brand::ASSISTANT_NAME);
    assert_eq!(row["live_sessions"], 0);
    assert!(!body.contains("\"assistant\":\"assistant\""), "the raw scope id does not cross: {body}");
    let project_id = row["id"].as_str().expect("scope id").to_string();
    assert_ne!(project_id, "assistant");

    // launch-options: the assistant block replaces every other ＋ option.
    let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/launch-options"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let options = json(&body);
    assert_eq!(options["worktrees"], json!([]));
    assert_eq!(options["cloud"], json!([]));
    assert_eq!(options["sign_in"], json!([]));
    assert_eq!(options["local"], Value::Null);
    assert_eq!(options["assistant"]["ollama_reachable"], true);
    let launches = options["assistant"]["launches"].as_array().expect("launches");
    assert_eq!(launches.len(), 5, "the not-installed Codex is not offered: {body}");
    for needle in ["qwen3", "opencode_local", "claude_local", "/", crate::brand::TMUX_PREFIX] {
        // Model names are shown (they are Ollama's own labels); ids carry nothing.
        if needle != "qwen3" {
            assert!(!launches.iter().any(|l| l["id"].as_str().unwrap().contains(needle)), "{needle} in an id: {body}");
        }
    }
    let by = |label: &str, model: Option<&str>| {
        launches
            .iter()
            .find(|l| l["label"] == label && l.get("model").and_then(Value::as_str) == model)
            .unwrap_or_else(|| panic!("{label} {model:?}: {body}"))["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let claude = by("Claude", None);
    let opencode = by("OpenCode", Some("qwen3:8b"));

    // A create must name a launch, and only that.
    let key = "s5a-chat-0123456789abcdef";
    let post = |body: Value| create_request(&project_id, &cookie, body);
    for refused in [
        json!({ "project_id": project_id, "kind": "agent", "idempotency_key": key }),
        json!({ "project_id": project_id, "kind": "shell", "idempotency_key": key }),
        json!({ "project_id": project_id, "kind": "agent", "agent_id": "x", "idempotency_key": key }),
        json!({ "project_id": project_id, "kind": "agent", "assistant": claude, "agent_id": "x", "idempotency_key": key }),
        json!({ "project_id": project_id, "kind": "agent", "assistant": claude, "mode": "plan", "idempotency_key": key }),
        json!({ "project_id": project_id, "kind": "agent", "assistant": claude, "local": "l", "idempotency_key": key }),
        json!({ "project_id": project_id, "kind": "agent", "assistant": claude, "sign_in": "default", "idempotency_key": key }),
    ] {
        let (status, _, body) = host.send(post(refused.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}: {body}");
        assert_eq!(json(&body)["error"], "invalid_request", "{refused}");
    }
    for unknown in ["claude", "claude_local:qwen3:8b", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "../../etc"] {
        let (status, _, body) = host.send(post(json!({ "project_id": project_id, "kind": "agent", "assistant": unknown, "idempotency_key": key }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{unknown}: {body}");
        assert_eq!(json(&body)["error"], "unknown_agent", "{unknown}");
    }
    assert!(recorded.lock().unwrap().is_empty(), "nothing was started by a refusal");
    assert!(!host.state.config.state_dir.join("sessions").join("assistant").join("terminals.json").exists() || {
        let session: Value = serde_json::from_slice(&std::fs::read(host.state.config.state_dir.join("sessions/assistant/terminals.json")).unwrap()).unwrap();
        session["tabLayout"].as_array().is_none_or(Vec::is_empty)
    });

    // The real create.
    let request = json!({ "project_id": project_id, "kind": "agent", "assistant": claude, "idempotency_key": key });
    let (status, _, body) = host.send(post(request.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let answer = json(&body);
    assert_eq!(answer["desktop_available"], false);
    assert_eq!(answer["tab"]["kind"], "agent");
    assert_eq!(answer["tab"]["label"], "Claude");
    let tab_id = answer["tab"]["id"].as_str().expect("tab id").to_string();

    let session_path = host.state.config.state_dir.join("sessions").join("assistant").join("terminals.json");
    let session: Value = serde_json::from_slice(&std::fs::read(&session_path).expect("session")).expect("json");
    let tabs = session["tabLayout"].as_array().expect("tabs");
    assert_eq!(tabs.len(), 1, "{session}");
    let minted = &tabs[0];
    let uid = minted["sessionId"].as_str().expect("chat uuid").to_string();
    assert!(crate::services::agent_session::is_uuid_shaped(&uid));
    assert_eq!(minted["assistant"], json!({ "cli": "claude" }));
    assert_eq!(minted["cmd"], "claude");
    assert_eq!(minted["kind"], "agent");
    for absent in ["args", "env", "scheduleTargetId", "localLaunch", "sandbox"] {
        assert!(minted.get(absent).is_none(), "{absent} in {minted}");
    }
    let tmux = minted["tmuxSession"].as_str().expect("tmux").to_string();
    assert!(tmux.starts_with(&format!("{}assistant--agent-", crate::brand::TMUX_PREFIX)), "{tmux}");
    let chat_dir = crate::services::assistant::chat_dir(&host.state.config.state_dir, &uid).unwrap();
    assert_eq!(std::path::Path::new(minted["cwd"].as_str().unwrap()), chat_dir);
    let leaks = |body: &str| {
        assert!(!body.contains(&uid), "chat uid leaked: {body}");
        assert!(!body.contains(crate::brand::TMUX_PREFIX), "tmux name leaked: {body}");
        assert!(!body.contains(&host.state.config.state_dir.to_string_lossy().to_string()), "path leaked: {body}");
    };
    leaks(&body);

    // The spawn seam got the validated launch and the uid, not the record's say.
    let spawned = recorded.lock().unwrap().clone();
    assert_eq!(spawned.len(), 1);
    let opts = &spawned[0];
    assert_eq!(opts.assistant, Some(crate::services::assistant::AssistantLaunch { cli: crate::services::assistant::AssistantCli::Claude, model: None }));
    assert_eq!(opts.project_id.as_deref(), Some("assistant"));
    assert_eq!(opts.cmd, "claude");
    assert!(opts.args.is_empty());
    assert_eq!(opts.env, HashMap::from([(crate::app_env!("TAB_UID").to_string(), uid.clone())]));
    assert!(opts.agent && !opts.local_model && opts.schedule_target_id.is_none() && opts.login.is_none() && !opts.host_session);
    assert_eq!(opts.tmux_session.as_deref(), Some(tmux.as_str()));
    assert_eq!(opts.id, format!("headless:{tmux}"));

    // The same request again answers the same tab and starts nothing.
    let (status, _, body) = host.send(post(request)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(json(&body)["tab"]["id"], tab_id);
    assert_eq!(recorded.lock().unwrap().len(), 1);

    // A local launch carries its model; the record keeps it strict.
    let (status, _, body) = host
        .send(post(json!({ "project_id": project_id, "kind": "agent", "assistant": opencode, "idempotency_key": "s5a-local-0123456789abcdef" })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(json(&body)["tab"]["label"], "OpenCode · qwen3:8b");
    assert_eq!(json(&body)["tab"]["local_model"], true);
    let local = recorded.lock().unwrap().last().cloned().expect("second spawn");
    assert_eq!(local.assistant.as_ref().and_then(|l| l.model.as_deref()), Some("qwen3:8b"));
    assert_eq!(local.cmd, "opencode");

    // The scope lists both chats; its detail offers no plain agent.
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    let detail = json(&body);
    assert_eq!(detail["tabs"].as_array().unwrap().len(), 2, "{body}");
    assert_eq!(detail["agents"], json!([]));
    assert_eq!(detail["files"], false);
    leaks(&body);

    // The gate re-checked at the point of use: a catalog a few seconds old
    // still lists the scope, but the create is refused once the switch is off.
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        json!({ "assistant": true, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "assistant_access": false } }).to_string(),
    )
    .expect("switch off");
    let (status, _, body) = host
        .send(post(json!({ "project_id": project_id, "kind": "agent", "assistant": claude, "idempotency_key": "s5a-late-0123456789abcdef" })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(json(&body)["error"], "assistant_off");
    assert_eq!(recorded.lock().unwrap().len(), 2);
}

/// A chat's process ends with its CLI (no shell is left in the pane), so a
/// chat the phone opens may be gone; with no window the owner starts it
/// again, from the stored record, detached under the same tmux name.
#[tokio::test]
async fn opening_an_ended_chat_with_no_window_starts_it_again() {
    let recorded: Arc<Mutex<Vec<PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = recorded.clone();
    let host = assistant_host(Arc::new(move |opts: PtyOptions| {
        sink.lock().unwrap().push(opts);
        Box::pin(async { Ok(()) })
    }));
    let cookie = host.pair_device(&signing_key(61)).await.0;
    let (project_id, tab_id) = start_assistant_chat(&host, &cookie, "s5a-restart-0123456789abcdef").await;
    assert_eq!(recorded.lock().unwrap().len(), 1);
    let activate = |query: &str| request_as("POST", &format!("/api/v1/projects/{project_id}/activate{query}"), &cookie, None);

    // No chat named: nothing to start, and no window to ask.
    let (status, _, body) = host.send(activate("")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");

    // The named chat has no live session in this fixture: it is started
    // again with the first start's options (same tmux name, same uid).
    let (status, _, body) = host.send(activate(&format!("?tab={tab_id}"))).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false);
    let spawned = recorded.lock().unwrap().clone();
    assert_eq!(spawned.len(), 2, "started once more");
    assert_eq!(spawned[1].tmux_session, spawned[0].tmux_session);
    assert_eq!(spawned[1].env, spawned[0].env);
    assert_eq!(spawned[1].assistant, spawned[0].assistant);
    assert_eq!(spawned[1].project_id.as_deref(), Some("assistant"));
    assert!(!body.contains(crate::brand::TMUX_PREFIX), "tmux name leaked: {body}");

    // The gate closed meanwhile: refused, nothing started.
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        json!({ "assistant": true, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "assistant_access": false } }).to_string(),
    )
    .unwrap();
    let (status, _, body) = host.send(activate(&format!("?tab={tab_id}"))).await;
    assert_ne!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(recorded.lock().unwrap().len(), 2);
}

/// A launch id means nothing outside the assistant scope.
#[tokio::test]
async fn an_assistant_launch_is_refused_in_a_project() {
    let host = headless_host(Arc::new(|_| Box::pin(async { Ok(()) })));
    let cookie = host.pair_device(&signing_key(72)).await.0;
    let (project_id, _) = project_and_tab(&host, &cookie).await;
    let (status, _, body) = host
        .send(create_request(
            &project_id,
            &cookie,
            json!({ "project_id": project_id, "kind": "agent", "assistant": "x", "idempotency_key": "s5a-proj-0123456789abcdef" }),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(json(&body)["error"], "invalid_request");
}

/// S5a: every route that reads or writes a project's files, repository,
/// outbox, inbox, uploads, markup, worktrees or schedules answers a tab or
/// scope of the assistant with a refusal, whatever the host-wide switches
/// say (they are all on here), and the chat's own routes still work. This
/// lists the `is_git_project` gates and the folder-based routes that gate
/// on the scope alone (`has_folder`); a project with no folder is the twin
/// (`a_folder_less_project_is_no_project_to_any_folder_route`).
#[tokio::test]
async fn the_assistant_scope_is_no_project_to_any_folder_route() {
    let host = assistant_host(Arc::new(|_| Box::pin(async { Ok(()) })));
    let cookie = host.pair_device(&signing_key(73)).await.0;
    let (project_id, tab_id) = start_assistant_chat(&host, &cookie, "s5a-gates-0123456789abcdef").await;
    let (p, t) = (project_id.as_str(), tab_id.as_str());
    let any = json!({});
    let routes: Vec<(&str, String, Value, &[&str])> = vec![
        // Repository.
        ("GET", format!("/api/v1/projects/{p}/git"), Value::Null, &["not_a_project"]),
        ("GET", format!("/api/v1/tabs/{t}/uncommitted"), Value::Null, &["not_a_project"]),
        ("GET", format!("/api/v1/tabs/{t}/changes"), Value::Null, &["not_a_project", "files_off"]),
        // Files drawer and uploads.
        ("GET", format!("/api/v1/projects/{p}/files"), Value::Null, &["files_unavailable"]),
        ("GET", format!("/api/v1/projects/{p}/files/search?q=a"), Value::Null, &["files_unavailable"]),
        ("GET", format!("/api/v1/projects/{p}/files/raw?token=x"), Value::Null, &["files_unavailable"]),
        ("POST", format!("/api/v1/projects/{p}/files/upload?name=a.txt"), any.clone(), &["files_unavailable", "uploads_unavailable", "files_off"]),
        ("DELETE", format!("/api/v1/projects/{p}/files/upload"), Value::Null, &["files_unavailable", "uploads_unavailable", "files_off"]),
        // Outbox and inbox, by project and by tab.
        ("GET", format!("/api/v1/projects/{p}/outbox"), Value::Null, &["not_a_project"]),
        ("DELETE", format!("/api/v1/projects/{p}/outbox"), Value::Null, &["not_a_project"]),
        ("GET", format!("/api/v1/projects/{p}/outbox/a.txt"), Value::Null, &["not_a_project"]),
        ("DELETE", format!("/api/v1/projects/{p}/outbox/a.txt"), Value::Null, &["not_a_project"]),
        ("POST", format!("/api/v1/projects/{p}/inbox?name=a.txt"), any.clone(), &["not_a_project"]),
        ("GET", format!("/api/v1/tabs/{t}/outbox"), Value::Null, &["not_a_project"]),
        ("DELETE", format!("/api/v1/tabs/{t}/outbox"), Value::Null, &["not_a_project"]),
        ("GET", format!("/api/v1/tabs/{t}/outbox/a.txt"), Value::Null, &["not_a_project"]),
        ("DELETE", format!("/api/v1/tabs/{t}/outbox/a.txt"), Value::Null, &["not_a_project"]),
        // Markup.
        ("GET", format!("/api/v1/tabs/{t}/markup/questions"), Value::Null, &["not_a_project"]),
        ("POST", format!("/api/v1/tabs/{t}/markup/answer"), any.clone(), &["not_a_project", "invalid_request"]),
        ("POST", format!("/api/v1/tabs/{t}/markup/dismiss"), any.clone(), &["not_a_project", "invalid_request"]),
        // Worktrees, activation, sign-in, schedules, collected prompts.
        ("POST", format!("/api/v1/projects/{p}/activate"), Value::Null, &["desktop_unavailable"]),
        ("POST", format!("/api/v1/tabs/{t}/sign-in"), json!({ "idempotency_key": "s5a-signin-0123456789abcdef" }), &["unsupported_sign_in"]),
        ("GET", format!("/api/v1/tabs/{t}/schedules"), Value::Null, &["not_a_project"]),
        ("POST", format!("/api/v1/tabs/{t}/schedules"), json!({ "enabled": true, "message": "x", "rule": { "type": "daily", "time": "09:00" } }), &["not_a_project"]),
        ("GET", format!("/api/v1/projects/{p}/prompts"), Value::Null, &["not_a_project"]),
        ("POST", format!("/api/v1/projects/{p}/prompts"), json!({ "message": "x" }), &["not_a_project"]),
    ];
    for (method, uri, body, codes) in routes {
        let request = request_as(method, &uri, &cookie, (!body.is_null()).then_some(body));
        let (status, _, answer) = host.send(request).await;
        let code = json(&answer).get("error").and_then(Value::as_str).unwrap_or("").to_string();
        assert!(!status.is_success() && codes.contains(&code.as_str()), "{method} {uri} -> {status} {answer} (wanted one of {codes:?})");
    }
    // Not a gate to forget: the global drop box belongs to no project.
    // What a chat is still for: its own detail and transcript routes.
    let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{t}"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{t}/transcript"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// A Tabby chat's composer + works as a project chat's does: the phone's file
/// lands in the chat's own folder (`drop_box`), the one its CLI can read an
/// `@` reference from, and comes back for the chat's picture; the scope
/// itself still has no inbox, and a chat folder swapped for a link is none.
#[tokio::test]
async fn a_tabby_chat_takes_the_phones_files_into_its_own_folder() {
    let host = assistant_host(Arc::new(|_| Box::pin(async { Ok(()) })));
    let cookie = host.pair_device(&signing_key(74)).await.0;
    let (project_id, tab_id) = start_assistant_chat(&host, &cookie, "tabby-inbox-0123456789abcdef").await;
    let state_dir = host.state.config.state_dir.clone();
    let session: Value = serde_json::from_slice(&std::fs::read(state_dir.join("sessions").join("assistant").join("terminals.json")).expect("session")).expect("json");
    let uid = session["tabLayout"][0]["sessionId"].as_str().expect("chat uid").to_string();
    let chat = crate::services::assistant::chat_dir(&state_dir, &uid).unwrap();

    let (status, _, body) = host.send(inbox_request(&tab_id, "shot.jpg", &cookie, b"jpeg bytes".to_vec())).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let reference = json(&body)["attachment"]["reference"].as_str().expect("reference").to_string();
    assert!(reference.starts_with(&format!("{}/", inbox::INBOX_DIR)), "{reference}");
    assert!(!body.contains(&uid) && !body.contains(&*state_dir.to_string_lossy()), "{body}");
    assert_eq!(std::fs::read(chat.join(&reference)).unwrap(), b"jpeg bytes");

    let leaf = reference.rsplit('/').next().unwrap().to_string();
    let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/inbox/{leaf}"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/inbox?names={leaf}"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(json(&body)["files"].as_array().map(Vec::len), Some(1), "{body}");
    let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/desktop-images"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The scope's own drop box, by project, is still no folder.
    let (status, _, body) = host
        .send(request_as("POST", &format!("/api/v1/projects/{project_id}/inbox?name=a.txt"), &cookie, Some(json!({}))))
        .await;
    assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::NOT_FOUND, Some("not_a_project")), "{body}");

    #[cfg(unix)]
    {
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::remove_dir_all(&chat).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), &chat).unwrap();
        let (status, _, body) = host.send(inbox_request(&tab_id, "shot.jpg", &cookie, b"jpeg".to_vec())).await;
        assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::NOT_FOUND, Some("not_a_project")), "{body}");
        assert!(std::fs::read_dir(elsewhere.path()).unwrap().next().is_none());
    }
}

/// A host with one opted-in remote project (no mirror on disk) whose one
/// agent tab runs on the project's host, that host's master found by the
/// last liveness round (`reachable`), and no window. Unix only, like the
/// tests on it: a Windows build lists no host tab at all
/// (`discovery::host_tabs_here`; pinned on every OS by
/// `host_tabs_need_persisted_sessions_a_non_vm_project_and_tmux_terminals`),
/// so there the fixture's tab is simply not in the catalog.
#[cfg(unix)]
fn host_tab_fixture(reachable: bool) -> Fixture {
    let mut host = Fixture::bare();
    let state_dir = host.state.config.state_dir.clone();
    std::fs::write(
        state_dir.join("projects.json"),
        serde_json::to_vec(&json!([{
            "id": RAW_PROJECT,
            "name": "Aurora",
            "status": "active",
            "directory": state_dir.join("remote-projects").join(RAW_PROJECT).to_string_lossy(),
            concat!(crate::app_slug!(), "_mobile_access"): true,
            "remote": { "user": "alice", "host": "primary.example", "remote_path": "/srv/aurora" },
        }]))
        .expect("projects fixture"),
    )
    .expect("write projects");
    let sessions = state_dir.join("sessions").join(RAW_PROJECT);
    std::fs::create_dir_all(&sessions).expect("session dir");
    std::fs::write(
        sessions.join("terminals.json"),
        serde_json::to_vec(&json!({
            "tabLayout": [{
                "label": "Claude",
                "cmd": "claude",
                "cwd": state_dir.join("remote-projects").join(RAW_PROJECT).to_string_lossy(),
                "kind": "agent",
                "location": "remote",
                "sessionId": "9d0f-session",
                "scheduleTargetId": "target-1",
                "tmuxSession": format!("{SLUG}-{RAW_PROJECT}--agent-abcdef123"),
            }]
        }))
        .expect("session fixture"),
    )
    .expect("write session");
    let live: host_live::SharedHostLive = Arc::default();
    if reachable {
        let spec = serde_json::from_value(json!({ "user": "alice", "host": "primary.example", "remote_path": "/x" })).unwrap();
        live.lock().unwrap().insert(&spec, host_live::HostReach { control_path: state_dir.join("cm-primary"), sessions: None });
    }
    host.state.catalog = Arc::new(Mutex::new(CatalogCache::with_host_live(live)));
    host
}

/// Plan step 3: a host tab is listed with `on_host` and nothing raw, and
/// every route that would act on this machine for it answers `409
/// tab_on_host` — the inbox, desktop images, Mark up Submit, sign-in and
/// its callback, activate-with-tab, and with no window the owner's
/// schedule, held-prompt, send-now and undo-clear writes. Its transcript
/// is `unsupported`.
#[cfg(unix)]
#[tokio::test]
async fn a_host_tab_is_listed_on_host_and_refuses_what_would_act_here() {
    let host = host_tab_fixture(true);
    let cookie = host.pair_device(&signing_key(71)).await.0;
    let (p, t) = project_and_tab(&host, &cookie).await;
    let (_, _, detail) = host.send(get_as(&format!("/api/v1/projects/{p}"), &cookie)).await;
    let tab = &json(&detail)["tabs"][0];
    assert_eq!((tab["on_host"].as_bool(), tab["available"].as_bool()), (Some(true), Some(true)), "{detail}");
    for raw in ["primary.example", "/srv/aurora", "cm-primary", RAW_PROJECT, "9d0f-session", "alice"] {
        assert!(!detail.contains(raw), "{raw} crossed: {detail}");
    }
    let any = json!({});
    let markup = json!({
        "source": { "files": "AAAA" },
        "pages": [{
            "n": 1, "size": [800, 600], "layer": format!("{}/draft-p1-layer.png", inbox::INBOX_DIR),
            "marks": [{ "kind": "ink", "color": "red", "width": 2, "points": [[10, 10, 0.5], [40, 30, 0.7]] }],
        }],
    });
    let routes: Vec<(&str, String, Value)> = vec![
        ("POST", format!("/api/v1/tabs/{t}/inbox?name=a.txt"), any.clone()),
        ("GET", format!("/api/v1/tabs/{t}/desktop-images"), Value::Null),
        ("POST", format!("/api/v1/tabs/{t}/desktop-images"), json!({ "image_id": desktop_images::CLIPBOARD_ID })),
        ("POST", format!("/api/v1/tabs/{t}/markup"), markup),
        ("POST", format!("/api/v1/tabs/{t}/sign-in"), json!({ "idempotency_key": "host-signin-0123456789abcdef" })),
        ("POST", format!("/api/v1/tabs/{t}/sign-in-callback"), json!({ "url": "http://localhost:4567/callback?code=c&state=s" })),
        ("POST", format!("/api/v1/projects/{p}/activate?tab={t}"), Value::Null),
        ("POST", format!("/api/v1/tabs/{t}/schedules"), json!({ "enabled": true, "message": "x", "rule": { "type": "daily", "time": "09:00" } })),
        ("PUT", format!("/api/v1/tabs/{t}/schedules/rule-1"), json!({ "enabled": true, "message": "x", "rule": { "type": "daily", "time": "09:00" } })),
        ("DELETE", format!("/api/v1/tabs/{t}/schedules/rule-1"), Value::Null),
        ("POST", format!("/api/v1/tabs/{t}/held"), json!({ "message": "next" })),
        ("PUT", format!("/api/v1/tabs/{t}/held/held-1"), json!({ "message": "next" })),
        ("POST", format!("/api/v1/projects/{p}/prompts/prompt-1/send"), json!({ "tab_id": t })),
        ("POST", format!("/api/v1/tabs/{t}/undo-clear"), Value::Null),
    ];
    for (method, uri, body) in routes {
        let (status, _, answer) = host.send(request_as(method, &uri, &cookie, (!body.is_null()).then_some(body))).await;
        assert_eq!((status, json(&answer)["error"].as_str()), (StatusCode::CONFLICT, Some("tab_on_host")), "{method} {uri} -> {answer}");
    }
    let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{t}/transcript"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(json(&body)["transcript"]["available"], false, "{body}");
    assert_eq!(json(&body)["transcript"]["reason"], "unsupported", "{body}");
    assert!(host.runner.delivered.lock().unwrap().is_empty(), "nothing typed anywhere");
}

/// The ＋ sheet's machines: `launch-options` lists a remote project's
/// runnable hosts under opaque ids (nothing raw), each with whether the
/// desktop holds its master; a create naming one the desktop is not
/// connected to answers `409 host_offline` and an unknown id `400
/// host_not_found`, and neither reaches the window. With no window no
/// machine is listed: a host tab is the window's to spawn.
#[cfg(unix)]
#[tokio::test]
async fn a_host_create_names_a_listed_machine_the_desktop_is_connected_to() {
    let host = host_tab_fixture(true);
    let state_dir = host.state.config.state_dir.clone();
    std::fs::create_dir_all(crate::services::remote_sync::default_mirror_dir_in(&state_dir, RAW_PROJECT)).expect("mirror");
    let cookie = host.pair_device(&signing_key(73)).await.0;
    let (p, _) = project_and_tab(&host, &cookie).await;
    let create = |machine: &str, n: u32| {
        json!({ "project_id": p, "kind": "agent", "agent_id": "claude", "host": machine, "idempotency_key": format!("host-create-{n}-0123456789abcdef") })
    };
    let (_, _, options) = host.send(get_as(&format!("/api/v1/projects/{p}/launch-options"), &cookie)).await;
    assert!(json(&options).get("hosts").is_none(), "no window, no machines: {options}");

    let socket = host.state.config.control_dir.join("desktop-control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
    let creates: Arc<Mutex<usize>> = Arc::default();
    let seen = creates.clone();
    let desktop = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let Ok(request) = admin::read_frame::<DesktopRequest>(&mut stream).await else {
                continue;
            };
            let answer = match request {
                DesktopRequest::LaunchOptions { .. } => DesktopResponse::LaunchOptions {
                    worktrees: Vec::new(),
                    cloud: Vec::new(),
                    sign_in: Vec::new(),
                    local: None,
                    api_key: Vec::new(),
                },
                DesktopRequest::Create { .. } => {
                    *seen.lock().unwrap() += 1;
                    DesktopResponse::Error { code: "unknown_agent".into(), message: "not offered".into() }
                }
                _ => DesktopResponse::Seen,
            };
            admin::write_frame(&mut stream, &answer).await.expect("answer");
        }
    });
    let (status, _, options) = host.send(get_as(&format!("/api/v1/projects/{p}/launch-options"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{options}");
    let hosts = json(&options)["hosts"].as_array().cloned().expect("hosts listed");
    assert_eq!(hosts.len(), 1, "{options}");
    assert_eq!((hosts[0]["label"].as_str(), hosts[0]["primary"].as_bool()), (Some("primary.example"), Some(true)));
    assert_eq!(hosts[0]["connected"], false, "no master answers on the fixture's socket");
    let machine = hosts[0]["id"].as_str().expect("machine id").to_string();
    for raw in ["remote", "host:", RAW_PROJECT, "/srv/aurora", "cm-primary", "alice"] {
        assert!(!machine.contains(raw), "{raw} in the id {machine}");
    }
    let (status, _, body) = host.send(create_request(&p, &cookie, create(&machine, 1))).await;
    assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::CONFLICT, Some("host_offline")), "{body}");
    let (status, _, body) = host.send(create_request(&p, &cookie, create("not-a-machine", 2))).await;
    assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::BAD_REQUEST, Some("host_not_found")), "{body}");
    assert_eq!(*creates.lock().unwrap(), 0, "the window was never asked");
    desktop.abort();
}

/// The plan's pinned close: with no window, closing a host tab removes its
/// record through the owner's local runner — whose `tmux kill-session`
/// finds no such session here, which counts as already gone — and never
/// reaches the host: its session keeps running, as after a desktop close.
#[cfg(unix)]
#[tokio::test]
async fn closing_a_host_tab_with_no_window_drops_the_record_and_leaves_the_host_alone() {
    let host = host_tab_fixture(true);
    let cookie = host.pair_device(&signing_key(72)).await.0;
    let (p, t) = project_and_tab(&host, &cookie).await;
    let (status, _, body) = host.send(request_as("DELETE", &format!("/api/v1/tabs/{t}"), &cookie, None)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(host.runner.killed.lock().unwrap().as_slice(), [format!("{SLUG}-{RAW_PROJECT}--agent-abcdef123")], "the local runner, no ssh");
    assert!(crate::services::tmux_local::kill_failure_is_already_gone("can't find session: x"));
    let (_, _, detail) = host.send(get_as(&format!("/api/v1/projects/{p}"), &cookie)).await;
    assert_eq!(json(&detail)["tabs"].as_array().map(Vec::len), Some(0), "{detail}");
    // Kept for the window to reopen, but not offered here: a reopen with no
    // window could not start it.
    assert_eq!(json(&detail)["closed"], json!([]), "{detail}");
}

/// A host tab's terminal upgrade: no master found → `409 host_offline`;
/// one found but gone at the foreground re-check → the same; the session
/// missing on a live master → `410 session_gone`; otherwise a `Host`
/// attach on the master's socket. A local tab is unchanged.
#[cfg(unix)]
#[tokio::test]
async fn a_host_tabs_terminal_rides_a_live_master_or_says_host_offline() {
    let host = host_tab_fixture(true);
    let catalog = host.state.catalog.lock().unwrap().load(&host.state.config.state_dir, &host_key(&host.state)).unwrap();
    let tab = catalog.projects[0].tabs[0].clone();
    let alive = |answer: bool| move |_: std::path::PathBuf| answer;
    match terminal_target(&tab, alive(true)).await {
        Ok(pty_bridge::AttachTarget::Host { name, ssh }) => {
            assert_eq!(name, tab.tmux_name);
            assert_eq!(ssh.spec.host, "primary.example");
            assert_eq!(ssh.control_path, host.state.config.state_dir.join("cm-primary"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(terminal_target(&tab, alive(false)).await.unwrap_err(), (StatusCode::CONFLICT, "host_offline"));
    let mut gone = tab.clone();
    gone.public.available = false;
    assert_eq!(terminal_target(&gone, alive(true)).await.unwrap_err(), (StatusCode::GONE, "session_gone"));

    let unreachable = host_tab_fixture(false);
    let catalog = unreachable.state.catalog.lock().unwrap().load(&unreachable.state.config.state_dir, &host_key(&unreachable.state)).unwrap();
    let tab = catalog.projects[0].tabs[0].clone();
    assert!(!tab.public.available);
    assert_eq!(terminal_target(&tab, |_| panic!("no master to ask")).await.unwrap_err(), (StatusCode::CONFLICT, "host_offline"));

    let mut local = super::super::discovery::fixture_scope("t", "tmux-t", None).tabs.remove(0);
    assert!(matches!(terminal_target(&local, |_| panic!("not asked")).await, Ok(pty_bridge::AttachTarget::Local { .. })));
    local.public.available = false;
    assert_eq!(terminal_target(&local, |_| panic!("not asked")).await.unwrap_err(), (StatusCode::GONE, "session_gone"));
}

/// A host with one opted-in project of each type, no window and no session
/// files: a local one, a container one, a remote one with its mirror, a
/// remote one that was never opened on the desktop (no mirror) and a VM one
/// with none either. The spawn seam records what it is asked to start.
fn typed_host() -> (Fixture, Arc<Mutex<Vec<PtyOptions>>>) {
    let recorded: Arc<Mutex<Vec<PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = recorded.clone();
    let mut host = Fixture::bare();
    let state_dir = host.state.config.state_dir.clone();
    std::fs::write(
        state_dir.join("settings.json"),
        json!({
            crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true, "project_files": true, "project_uploads": true },
        })
        .to_string(),
    )
    .expect("write settings");
    let mirror = crate::services::remote_sync::default_mirror_dir_in(&state_dir, "t-remote");
    for dir in [host.root.join("t-local"), host.root.join("t-container"), mirror] {
        std::fs::create_dir_all(dir).expect("project folder");
    }
    let record = |id: &str, name: &str, extra: Value| {
        let mut record = json!({
            "id": id, "name": name, "status": "active",
            "directory": host.root.join(id).to_string_lossy(),
            crate::brand::MOBILE_ACCESS_KEY: true,
        });
        for (key, value) in extra.as_object().expect("object") {
            record[key] = value.clone();
        }
        record
    };
    let projects = vec![
        record("t-local", "Local", json!({})),
        record("t-container", "Container", json!({ "sandbox": { "enabled": true } })),
        record("t-remote", "Remote", json!({ "remote": { "host": "h" } })),
        record("t-remote-bare", "Remote bare", json!({ "remote": { "host": "h" } })),
        record("t-vm", "Vm", json!({ "remote": { "host": "h" }, "vm": { "enabled": true } })),
    ];
    std::fs::write(state_dir.join("projects.json"), serde_json::to_vec(&projects).expect("projects")).expect("write projects");
    host.state.spawner = HeadlessSpawner {
        launch: Arc::new(move |opts: PtyOptions| {
            sink.lock().unwrap().push(opts);
            Box::pin(async { Ok(()) })
        }),
        installed: Arc::new(|_| true),
        ..HeadlessSpawner::default()
    };
    (host, recorded)
}

/// The opaque scope id of the project listed under `label`.
async fn scope_id(host: &Fixture, cookie: &str, label: &str) -> String {
    let (_, _, body) = host.send(get_as("/api/v1/projects", cookie)).await;
    json(&body)["projects"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["label"] == label))
        .and_then(|row| row["id"].as_str())
        .unwrap_or_else(|| panic!("{label} is listed: {body}"))
        .to_string()
}

/// The row carries the project's host as a type word; the detail says
/// whether the scope has a folder and what the phone may create in it, and
/// offers the 📁 drawer only where a folder is. Nothing names a path, an id
/// or the host the project is on.
#[tokio::test]
async fn every_project_type_says_its_host_folder_and_create_verdict() {
    let (host, _) = typed_host();
    let cookie = host.pair_device(&signing_key(81)).await.0;
    let (_, _, listed) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let rows = json(&listed)["projects"].clone();
    let mut seen = Vec::new();
    for (label, kind, folder, create, files) in [
        ("Local", "local", true, "all", true),
        ("Container", "container", true, "none", true),
        ("Remote", "remote", true, "agents", true),
        ("Remote bare", "remote", false, "none", false),
        ("Vm", "vm", false, "none", false),
    ] {
        let row = rows.as_array().unwrap().iter().find(|row| row["label"] == label).unwrap_or_else(|| panic!("{label}: {listed}"));
        assert_eq!(row["host"], kind, "{label}");
        let id = row["id"].as_str().expect("id");
        let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{id}"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "{label}: {body}");
        let detail = json(&body);
        assert_eq!(detail["project"]["host"], kind, "{label}");
        assert_eq!(detail["folder"], folder, "{label}");
        assert_eq!(detail["create"], create, "{label}");
        assert_eq!(detail["files"], files, "{label}");
        assert_eq!(detail["tabs"], json!([]), "{label}");
        seen.push(body);
    }
    seen.push(listed);
    for body in seen {
        assert!(!body.contains("t-local") && !body.contains("t-remote") && !body.contains("t-vm") && !body.contains("t-container"), "raw id leaked: {body}");
        assert!(!body.contains(&host.root.to_string_lossy().to_string()), "path leaked: {body}");
        assert!(!body.contains("\"h\""), "remote host leaked: {body}");
    }
}

/// The twin of the assistant's route test for a project the phone has no
/// folder of (a remote project never opened on the desktop, a VM project
/// without a mirror): its `root` names nothing that exists, so every
/// folder-shaped route refuses it, whatever the host-wide switches say.
#[tokio::test]
async fn a_folder_less_project_is_no_project_to_any_folder_route() {
    let (host, _) = typed_host();
    let cookie = host.pair_device(&signing_key(82)).await.0;
    for label in ["Remote bare", "Vm"] {
        let p = scope_id(&host, &cookie, label).await;
        let p = p.as_str();
        let any = json!({});
        let routes: Vec<(&str, String, Value, &[&str])> = vec![
            ("GET", format!("/api/v1/projects/{p}/git"), Value::Null, &["not_a_project"]),
            ("GET", format!("/api/v1/projects/{p}/files"), Value::Null, &["files_unavailable"]),
            ("GET", format!("/api/v1/projects/{p}/files/search?q=a"), Value::Null, &["files_unavailable"]),
            ("GET", format!("/api/v1/projects/{p}/files/raw?token=x"), Value::Null, &["files_unavailable"]),
            ("POST", format!("/api/v1/projects/{p}/files/upload?name=a.txt"), any.clone(), &["files_unavailable", "uploads_unavailable"]),
            ("DELETE", format!("/api/v1/projects/{p}/files/upload"), Value::Null, &["files_unavailable", "uploads_unavailable"]),
            ("GET", format!("/api/v1/projects/{p}/outbox"), Value::Null, &["not_a_project"]),
            ("DELETE", format!("/api/v1/projects/{p}/outbox"), Value::Null, &["not_a_project"]),
            ("GET", format!("/api/v1/projects/{p}/outbox/a.txt"), Value::Null, &["not_a_project"]),
            ("DELETE", format!("/api/v1/projects/{p}/outbox/a.txt"), Value::Null, &["not_a_project"]),
            ("POST", format!("/api/v1/projects/{p}/inbox?name=a.txt"), any.clone(), &["not_a_project"]),
        ];
        for (method, uri, body, codes) in routes {
            let request = request_as(method, &uri, &cookie, (!body.is_null()).then_some(body));
            let (status, _, answer) = host.send(request).await;
            let code = json(&answer).get("error").and_then(Value::as_str).unwrap_or("").to_string();
            assert!(!status.is_success() && codes.contains(&code.as_str()), "{label}: {method} {uri} -> {status} {answer} (wanted one of {codes:?})");
        }
    }
    // The tab-shaped routes cannot be reached by id (a folder-less scope
    // lists no tab), so the one test they all make is pinned directly: a
    // project with no folder fails it, a box and the root console, which
    // have a folder and are no git project, pass the one and fail the other.
    let mut scope = super::super::discovery::fixture_scope("t", "tmux", None);
    assert!(has_folder(&scope).is_ok() && is_git_project(&scope));
    scope.folder = false;
    assert!(has_folder(&scope).is_err() && !is_git_project(&scope));
    for kind in [ScopeKind::Box, ScopeKind::Root] {
        scope.folder = true;
        scope.public.kind = kind;
        assert!(has_folder(&scope).is_ok() && !is_git_project(&scope), "{kind:?}");
    }
}

/// Every create, reopen and sign-in the phone sends is answered by the
/// scope's verdict before it is handed to the window or the owner.
const CREATES: [(&str, &str, bool); 10] = [
    // (project label, tab kind, accepted)
    ("Local", "agent", true),
    ("Local", "shell", true),
    ("Container", "agent", false),
    ("Container", "shell", false),
    ("Remote", "agent", true),
    ("Remote", "shell", false),
    ("Remote bare", "agent", false),
    ("Remote bare", "shell", false),
    ("Vm", "agent", false),
    ("Vm", "shell", false),
];

async fn send_create(host: &Fixture, cookie: &str, label: &str, kind: &str, n: usize) -> (StatusCode, String) {
    let id = scope_id(host, cookie, label).await;
    let mut body = json!({ "project_id": id, "kind": kind, "idempotency_key": format!("every-type-{n:02}-0123456789abcdef") });
    if kind == "agent" {
        body["agent_id"] = json!("claude");
    }
    let (status, _, answer) = host.send(create_request(&id, cookie, body)).await;
    (status, answer)
}

/// A project type with no tab the phone can attach to answers
/// `not_attachable` (409) and starts nothing, with the window open. (The
/// fake window listens on a unix socket, as the other desktop-control tests.)
#[cfg(unix)]
#[tokio::test]
async fn a_create_the_phone_cannot_attach_to_is_refused_on_the_window_path() {
    let (host, spawned) = typed_host();
    let cookie = host.pair_device(&signing_key(83)).await.0;
    let socket = host.state.config.control_dir.join("desktop-control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
    let seen: Arc<Mutex<Vec<DesktopRequest>>> = Arc::default();
    let log = seen.clone();
    let desktop = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.expect("accept");
            // A reachability probe connects and sends nothing.
            let Ok(request) = admin::read_frame::<DesktopRequest>(&mut stream).await else {
                continue;
            };
            let asked_to_create = matches!(request, DesktopRequest::Create { .. } | DesktopRequest::ReopenTab { .. });
            if asked_to_create {
                log.lock().unwrap().push(request);
                let refusal = DesktopResponse::Error { code: "unknown_agent".into(), message: "not offered".into() };
                admin::write_frame(&mut stream, &refusal).await.expect("answer");
            } else {
                admin::write_frame(&mut stream, &DesktopResponse::Seen).await.expect("answer");
            }
        }
    });
    let mut reached = 0;
    for (n, (label, kind, accepted)) in CREATES.into_iter().enumerate() {
        let (status, body) = send_create(&host, &cookie, label, kind, n).await;
        if accepted {
            // Handed to the window, which refuses this made-up agent.
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label} {kind}: {body}");
            assert_eq!(json(&body)["error"], "unknown_agent", "{label} {kind}");
            reached += 1;
        } else {
            assert_eq!(status, StatusCode::CONFLICT, "{label} {kind}: {body}");
            assert_eq!(json(&body)["error"], "not_attachable", "{label} {kind}");
        }
        assert_eq!(seen.lock().unwrap().len(), reached, "{label} {kind}: only an accepted create reaches the window");
    }
    // A reopen starts an agent: the container, the folder-less and the VM
    // project are refused before the window is asked.
    for (label, accepted) in [("Local", true), ("Remote", true), ("Container", false), ("Remote bare", false), ("Vm", false)] {
        let id = scope_id(&host, &cookie, label).await;
        let (status, _, body) = host.send(request_as("POST", &format!("/api/v1/projects/{id}/tabs/reopen"), &cookie, None)).await;
        if accepted {
            reached += 1;
            assert_eq!(json(&body)["error"], "unknown_agent", "{label}: {body}");
        } else {
            assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::CONFLICT, Some("not_attachable")), "{label}: {body}");
        }
        assert_eq!(seen.lock().unwrap().len(), reached, "{label}");
    }
    desktop.abort();
    assert!(spawned.lock().unwrap().is_empty());
}

/// The same answer with no window, where the owner would have minted a
/// session record and spawned the process: nothing is written or started.
#[tokio::test]
async fn a_create_the_phone_cannot_attach_to_is_refused_on_the_headless_path() {
    let (host, spawned) = typed_host();
    let cookie = host.pair_device(&signing_key(84)).await.0;
    for (n, (label, kind, accepted)) in CREATES.into_iter().enumerate() {
        if accepted {
            continue;
        }
        let (status, body) = send_create(&host, &cookie, label, kind, n).await;
        assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::CONFLICT, Some("not_attachable")), "{label} {kind}: {body}");
    }
    for label in ["Container", "Remote bare", "Vm"] {
        let id = scope_id(&host, &cookie, label).await;
        let (status, _, body) = host.send(request_as("POST", &format!("/api/v1/projects/{id}/tabs/reopen"), &cookie, None)).await;
        assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::CONFLICT, Some("not_attachable")), "{label}: {body}");
    }
    assert!(spawned.lock().unwrap().is_empty(), "nothing was started");
    assert!(!host.state.config.state_dir.join("sessions").exists(), "no session record was minted");
    // A remote shell is refused even though its project has a folder.
    let (status, body) = send_create(&host, &cookie, "Remote", "shell", 99).await;
    assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::CONFLICT, Some("not_attachable")), "{body}");
    assert!(spawned.lock().unwrap().is_empty());
}

/// What a raw HTTP POST of a `ping` to `127.0.0.1:port` answers: the status.
async fn mcp_status(port: u16, path: &str, token: &str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    tcp.write_all(request.as_bytes()).await.expect("write");
    let mut answer = Vec::new();
    tcp.read_to_end(&mut answer).await.expect("read");
    String::from_utf8_lossy(&answer).get(9..12).and_then(|code| code.parse().ok()).expect("status line")
}

/// #2339 (`docs/headless_mcp_plan.md`), end to end in this process:
/// a) the Mobile host's `start_headless` binds a listener and publishes it
///    as the process's `runtime()`, with no root lane;
/// b) a Claude tab the phone creates with no window goes through the spawn
///    seam into `root_mcp::grant_lanes` — the call `launch_prep::prepare`
///    makes — against the fixture's state dir, passes the real gates
///    (agent, `schedule_mcp` and the project's level, `git_push_mcp`,
///    `help_mcp`) and records `PtyOptions` naming the schedule, git and
///    help servers; the listener admits each token on its own route over
///    HTTP, and a fresh store (the window, or this host after a restart)
///    refuses them;
/// c) the same grant with this runtime withholds the root and reader
///    lanes, which a root-serving runtime would hand out;
/// d) closing the tab from the phone with no window revokes its tokens.
#[tokio::test]
async fn a_headless_claude_tab_is_handed_the_hosts_mcp_servers() {
    use crate::services::root_mcp::{self, TokenStore};
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let port = crate::commands::root_mcp::start_headless(Arc::new(|_| {}), None, stopped).await.expect("the host's listener binds");
    let runtime = root_mcp::runtime().expect("a) the host publishes its runtime");
    assert_eq!(runtime.port, port);
    assert!(!runtime.serves_root, "the host serves no root lane");
    assert!(runtime.serves_web, "the host serves the assistant's web lane: a phone chat runs with no window");

    let recorded: Arc<Mutex<Vec<PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = recorded.clone();
    let mut host = headless_host(Arc::new(|_: PtyOptions| Box::pin(async { Ok(()) })));
    let state_dir = host.state.config.state_dir.clone();
    let grant_dir = state_dir.clone();
    host.state.spawner = HeadlessSpawner {
        launch: Arc::new(move |mut opts: PtyOptions| {
            let agent = crate::services::agent_fence::is_agent(&opts);
            root_mcp::grant_lanes(&mut opts, agent, root_mcp::runtime(), root_mcp::tokens(), &grant_dir);
            sink.lock().unwrap().push(opts);
            Box::pin(async { Ok(()) })
        }),
        installed: Arc::new(|_| true),
        ..HeadlessSpawner::default()
    };
    // The switches the gates read: scheduled prompts on (off by default),
    // and what would give a root or reader spawn its tools.
    std::fs::write(
        state_dir.join("settings.json"),
        json!({
            crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true },
            "schedule_mcp": true,
            "root_mcp_agents": ["claude"],
            "root_mcp_mail": true,
        })
        .to_string(),
    )
    .expect("settings");
    let mut projects: Vec<Value> = serde_json::from_slice(&std::fs::read(state_dir.join("projects.json")).expect("projects")).expect("json");
    projects.push(json!({ "id": "vm-reader", "name": "Reader", "status": "active", "vm": { "enabled": true, "mail_reader": true } }));
    // The trusted list as the window writes it: every entry has these.
    for (position, entry) in projects.iter_mut().enumerate() {
        entry["position"] = json!(position);
        entry["local_file"] = json!(format!("/nonexistent/{position}/project.json"));
    }
    std::fs::write(state_dir.join("projects.json"), serde_json::to_vec(&projects).expect("json")).expect("projects");

    let cookie = host.pair_device(&signing_key(43)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    let claude = json(&body)["agents"].as_array().expect("agents").iter()
        .find(|a| a["label"] == "Claude").expect("Claude is offered")["id"].as_str().expect("agent id").to_string();
    let request = json!({ "project_id": project_id, "kind": "agent", "agent_id": claude, "idempotency_key": "mcp-2339-0123456789abcdef" });
    let (status, _, body) = host.send(create_request(&project_id, &cookie, request)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let tab_id = json(&body)["tab"]["id"].as_str().expect("tab id").to_string();

    // b) The recorded launch names the three servers; tokens only in env.
    let spawned = recorded.lock().unwrap().clone();
    assert_eq!(spawned.len(), 1);
    let opts = &spawned[0];
    assert_eq!(opts.cmd, "claude");
    let token = |key: &str| opts.env.get(key).unwrap_or_else(|| panic!("{key} missing: {:?}", opts.env.keys())).clone();
    let (schedule, git, help) = (token(root_mcp::SCHEDULE_TOKEN_ENV), token(root_mcp::GIT_TOKEN_ENV), token(root_mcp::HELP_TOKEN_ENV));
    assert_eq!(opts.env[root_mcp::SCHEDULE_URL_ENV], format!("http://127.0.0.1:{port}/mcp/schedule"));
    assert_eq!(opts.env[root_mcp::HELP_URL_ENV], format!("http://127.0.0.1:{port}/mcp/help"));
    assert!(!opts.env.contains_key(root_mcp::TOKEN_ENV), "never the root lane");
    assert!(!opts.env.contains_key(root_mcp::MARKUP_TOKEN_ENV), "never the markup lane: its asks live in the window");
    let argv = opts.args.join(" ");
    assert_eq!(opts.args.iter().filter(|a| *a == "--mcp-config").count(), 1, "{argv}");
    for server in [crate::services::schedule_mcp::SERVER_NAME, crate::services::git_push_mcp::SERVER_NAME, crate::services::help_mcp::SERVER_NAME] {
        assert!(argv.contains(&format!("\"{server}\":")), "{server} missing: {argv}");
    }
    for token in [&schedule, &git, &help] {
        assert!(!argv.contains(token.as_str()), "a token is never in argv");
    }
    let session = root_mcp::tokens().authenticate(Some(&format!("Bearer {schedule}"))).expect("the host knows its token");
    assert_eq!(session.identity.tab, opts.id);
    assert_eq!(session.identity.project.as_deref(), Some(RAW_PROJECT));
    assert_eq!(session.identity.schedule_target.as_ref().map(|b| b.target.as_str()), opts.schedule_target_id.as_deref());

    // The bound listener admits each token on its own route, over HTTP
    // (past admission: whatever the handler then answers, never 401) …
    for (path, token) in [("/mcp/schedule", &schedule), ("/mcp/git", &git), ("/mcp/help", &help)] {
        assert_ne!(mcp_status(port, path, token).await, 401, "{path}");
    }
    assert_eq!(mcp_status(port, "/mcp/help", &schedule).await, 401, "a token is good on its own route only");
    assert_eq!(mcp_status(port, "/mcp", &schedule).await, 404, "no root route on the host");
    assert_eq!(mcp_status(port, "/mcp/markup", &schedule).await, 404, "no markup route on the host");
    // … and no other process's listener does: the window's, or this host's
    // after a restart (a fresh store).
    let admission = crate::commands::root_mcp::admission;
    assert_eq!(admission(root_mcp::tokens(), "/mcp/schedule", &schedule).await, Ok(()));
    let other: &'static TokenStore = Box::leak(Box::default());
    for (path, token) in [("/mcp/schedule", &schedule), ("/mcp/git", &git), ("/mcp/help", &help)] {
        assert_eq!(admission(other, path, token).await, Err(StatusCode::UNAUTHORIZED), "{path}");
    }

    // c) Root and reader spawns get nothing from this runtime; a runtime
    //    that serves the root lane would hand both out under these settings.
    let spawn = |id: &str, project: Option<&str>| -> PtyOptions {
        serde_json::from_value(json!({
            "id": id, "cmd": "claude", "args": [], "env": {}, "cwd": "/w", "cols": 80, "rows": 24,
            "agent": true, "project_id": project,
        }))
        .expect("options")
    };
    let rooted = crate::services::root_mcp::Runtime { port: 9, serves_root: true, serves_markup: true, serves_web: true };
    for project in [None, Some("vm-reader")] {
        let mut here = spawn("headless:c", project);
        root_mcp::grant_lanes(&mut here, true, root_mcp::runtime(), other, &state_dir);
        assert!(!here.env.contains_key(root_mcp::TOKEN_ENV), "{project:?}: {:?}", here.env.keys());
        let mut window = spawn("window:c", project);
        root_mcp::grant_lanes(&mut window, true, Some(&rooted), other, &state_dir);
        assert!(window.env.contains_key(root_mcp::TOKEN_ENV), "{project:?}: the settings do grant it");
    }
    // The markup lane likewise: a project tab with a schedule target gets
    // it from the window's runtime (or a server daemon's), never from a
    // desktop's Mobile host.
    let mut here = spawn("headless:m", Some(RAW_PROJECT));
    here.schedule_target_id = Some("target-m".into());
    let mut window = here.clone();
    window.id = "window:m".into();
    root_mcp::grant_lanes(&mut here, true, root_mcp::runtime(), other, &state_dir);
    root_mcp::grant_lanes(&mut window, true, Some(&rooted), other, &state_dir);
    assert!(!here.env.contains_key(root_mcp::MARKUP_TOKEN_ENV), "{:?}", here.env.keys());
    assert!(window.env.contains_key(root_mcp::MARKUP_TOKEN_ENV), "{:?}", window.env.keys());

    // The assistant's web and help lanes: a phone-made chat with no window
    // gets them from this host's listener (the `assistant` flag on, a
    // profile that wants the web lane, `help_mcp` on), and each token is
    // good on its own route alone. A runtime that does not serve the lane
    // (a server daemon's) gets none; a profile that does not want the web
    // lane (Codex: native search) gets the help lane only.
    let mut settings: Value = serde_json::from_slice(&std::fs::read(state_dir.join("settings.json")).expect("settings")).expect("json");
    settings["assistant"] = json!(true);
    std::fs::write(state_dir.join("settings.json"), settings.to_string()).expect("settings");
    let assistant = |id: &str, cli: &str| -> PtyOptions {
        serde_json::from_value(json!({
            "id": id, "cmd": "claude", "args": [], "env": {}, "cwd": "/w", "cols": 80, "rows": 24,
            "agent": true, "project_id": "assistant", "assistant": { "cli": cli },
        }))
        .expect("options")
    };
    let mut chat = assistant("headless:web", "claude");
    root_mcp::grant_lanes(&mut chat, true, root_mcp::runtime(), root_mcp::tokens(), &state_dir);
    let web = chat.env.get(root_mcp::WEB_TOKEN_ENV).cloned().expect("the host hands a phone chat the web lane");
    assert_eq!(chat.env[root_mcp::WEB_URL_ENV], format!("http://127.0.0.1:{port}/mcp/web"));
    let mut tokens: Vec<_> = chat.env.keys().filter(|k| k.ends_with("_MCP_TOKEN")).collect();
    tokens.sort();
    let mut want = [root_mcp::HELP_TOKEN_ENV, root_mcp::WEB_TOKEN_ENV];
    want.sort();
    assert_eq!(tokens, want, "the web and help tokens are the only ones an assistant chat holds");
    assert_eq!(chat.env[root_mcp::HELP_URL_ENV], format!("http://127.0.0.1:{port}/mcp/help"));
    let chat_help = chat.env[root_mcp::HELP_TOKEN_ENV].clone();
    assert_ne!(mcp_status(port, "/mcp/help", &chat_help).await, 401, "the host's listener serves the chat /mcp/help");
    assert_eq!(mcp_status(port, "/mcp/web", &chat_help).await, 401, "the help token is refused on /mcp/web");
    assert_ne!(mcp_status(port, "/mcp/web", &web).await, 401, "the host's listener serves /mcp/web");
    assert_eq!(mcp_status(port, "/mcp/web", &schedule).await, 401, "another lane's token is refused on /mcp/web");
    for path in ["/mcp/schedule", "/mcp/git", "/mcp/help"] {
        assert_eq!(mcp_status(port, path, &web).await, 401, "the web token is refused on {path}");
    }
    assert_eq!(mcp_status(port, "/mcp", &web).await, 404);
    assert_eq!(admission(other, "/mcp/web", &web).await, Err(StatusCode::UNAUTHORIZED), "another process's listener refuses it");
    let daemon = crate::services::root_mcp::Runtime { port: 9, serves_root: true, serves_markup: true, serves_web: false };
    let mut none = assistant("headless:web-daemon", "claude");
    root_mcp::grant_lanes(&mut none, true, Some(&daemon), other, &state_dir);
    assert!(!none.env.contains_key(root_mcp::WEB_TOKEN_ENV), "a daemon does not serve the web lane");
    let mut codex = assistant("headless:web-codex", "codex");
    root_mcp::grant_lanes(&mut codex, true, root_mcp::runtime(), other, &state_dir);
    let codex_tokens: Vec<_> = codex.env.keys().filter(|k| k.ends_with("_MCP_TOKEN")).collect();
    assert_eq!(codex_tokens, [root_mcp::HELP_TOKEN_ENV], "Codex searches natively: no web lane, the help lane only");
    root_mcp::revoke_tab("headless:web");

    // d) The phone's close with no window takes the tokens with the tab.
    let (status, _, body) = host.send(request_as("DELETE", &format!("/api/v1/tabs/{tab_id}"), &cookie, None)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(host.runner.killed.lock().unwrap().len(), 1, "the session was ended");
    for token in [&schedule, &git, &help] {
        assert!(root_mcp::tokens().authenticate(Some(&format!("Bearer {token}"))).is_none(), "revoked on close");
    }
    assert_eq!(mcp_status(port, "/mcp/help", &help).await, 401);
    let _ = stop.send(true);
}

/// The sweep revokes a generation of a tab's tokens only once its session
/// has been missing several looks in a row, keeps what it cannot check,
/// and never counts a restarted tab's new tokens against the old misses.
#[test]
fn the_token_sweep_waits_for_repeated_misses_of_one_generation() {
    let generation = |tab: &str, ids: &[&str]| (tab.to_string(), ids.iter().map(|i| i.to_string()).collect::<Vec<_>>());
    let held = vec![generation("headless:a", &["a1"]), generation("headless:b", &["b1", "b2"]), generation("pty:window", &["w1"])];
    let alive = |tab: &str| headless_session_alive(tab, |tmux| tmux == "a");
    let mut missed = HashMap::new();
    for _ in 1..MCP_SWEEP_MISSES {
        assert!(mcp_sweep_step(&mut missed, &held, alive).is_empty());
    }
    assert_eq!(mcp_sweep_step(&mut missed, &held, alive), vec![generation("headless:b", &["b1", "b2"])], "only the old ids go");
    // A session back between looks resets its count.
    let mut missed = HashMap::new();
    mcp_sweep_step(&mut missed, &held, alive);
    mcp_sweep_step(&mut missed, &held, |_| true);
    for _ in 1..MCP_SWEEP_MISSES {
        assert!(mcp_sweep_step(&mut missed, &held, alive).is_empty());
    }
    // A restart between looks (new session ids under the same tab) starts
    // from zero: the last look before the old count ran out revokes nothing.
    let mut missed = HashMap::new();
    for _ in 1..MCP_SWEEP_MISSES {
        mcp_sweep_step(&mut missed, &held, alive);
    }
    let restarted = vec![generation("headless:b", &["b3", "b4"])];
    assert!(mcp_sweep_step(&mut missed, &restarted, alive).is_empty(), "the new tokens are not the old misses'");
    assert_eq!(missed.len(), 1, "the old generation is forgotten");
    // A generation no longer held is forgotten.
    assert!(mcp_sweep_step(&mut missed, &[], alive).is_empty());
    assert!(missed.is_empty());
}

/// A headless launch that fails leaves no tab behind: the record is taken
/// back out and the phone hears `launch_failed`.
#[tokio::test]
async fn a_headless_launch_that_fails_takes_the_minted_tab_back_out() {
    let host = headless_host(Arc::new(|_: PtyOptions| Box::pin(async { Err("tmux is not installed".to_string()) })));
    let cookie = host.pair_device(&signing_key(42)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
    let (status, _, body) = host
        .send(create_request(
            &project_id,
            &cookie,
            json!({ "project_id": project_id, "kind": "shell", "idempotency_key": "h1b-fail-0123456789abcdef" }),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert_eq!(json(&body)["error"], "launch_failed");
    assert!(!body.contains(crate::brand::TMUX_PREFIX), "{body}");
    let session_path = host.state.config.state_dir.join("sessions").join(RAW_PROJECT).join("terminals.json");
    let session: Value = serde_json::from_slice(&std::fs::read(&session_path).expect("session")).expect("json");
    assert_eq!(session["tabLayout"].as_array().expect("tabs").len(), 1, "{session}");
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    assert_eq!(json(&body)["tabs"].as_array().expect("tabs").len(), 1);
}

/// Headless owner plan, H0: with no window open, the persisted-state kinds
/// — board, month, schedules, prompts, transcript — are answered off the
/// state dir with the desktop's own opaque ids, flagged
/// `desktop_available: false`.
#[tokio::test]
async fn persisted_state_is_answered_off_the_files_with_no_window() {
    let host = Fixture::with_project();
    let state_dir = host.state.config.state_dir.clone();
    std::fs::write(
        state_dir.join("sessions").join(RAW_PROJECT).join("terminals.json"),
        serde_json::to_vec(&serde_json::json!({
            "tabLayout": [{
                "label": "Claude",
                "cmd": "claude",
                "cwd": host.root.to_string_lossy(),
                "kind": "agent",
                "sessionId": "9d0f-session",
                "scheduleTargetId": "tgt-1",
                "tmuxSession": format!("{SLUG}-{RAW_PROJECT}--agent-abcdef123"),
            }]
        }))
        .expect("session fixture"),
    )
    .expect("write session");
    std::fs::write(
        state_dir.join("agent_tasks.json"),
        serde_json::json!({
            "version": 1,
            "projects": { RAW_PROJECT: { "tgt-1": { "schedules": [
                { "id": "sched-1", "enabled": true, "message": "Nightly review", "preface": ["/clear"],
                  "rule": { "type": "daily", "time": "09:00" } }
            ] } } }
        })
        .to_string(),
    )
    .expect("tasks fixture");
    std::fs::write(
        state_dir.join("agent_prompts.json"),
        serde_json::json!({
            "version": 1,
            "projects": { RAW_PROJECT: [
                { "id": "prompt-1", "message": "Write the intro", "created_at": "2026-07-01T09:00:00Z",
                  "updated_at": "2026-07-01T09:00:00Z", "target": "tgt-1" }
            ] }
        })
        .to_string(),
    )
    .expect("prompts fixture");
    let calendar = state_dir.join("calendar.json");
    let task = crate::services::calendar_store::create_task_at(
        &calendar,
        crate::schema::calendar::CalendarTask {
            title: "Ship it".into(),
            project_id: RAW_PROJECT.into(),
            ..Default::default()
        },
    )
    .expect("task");
    let event = crate::services::calendar_store::create_event_at(
        &calendar,
        crate::schema::calendar::CalendarEvent {
            title: "Defense".into(),
            start: "2026-07-15T10:00".into(),
            end: "2026-07-15T11:00".into(),
            ..Default::default()
        },
    )
    .expect("event");
    let cookie = host.pair_device(&signing_key(31)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
    let (_, _, project_body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("tab id").to_string();
    let leaks = |body: &str| {
        assert!(!body.contains(RAW_PROJECT), "raw project id leaked: {body}");
        assert!(!body.contains(&task.id), "raw task id leaked: {body}");
        assert!(!body.contains(&event.id), "raw event id leaked: {body}");
        assert!(!body.contains("tgt-1"), "schedule target leaked: {body}");
        assert!(!body.contains(crate::brand::TMUX_PREFIX), "tmux name leaked: {body}");
        assert!(!body.contains(&host.root.to_string_lossy().to_string()), "path leaked: {body}");
    };

    let (status, _, body) = host.send(get_as("/api/v1/todo", &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let board = json(&body);
    assert_eq!(board["desktop_available"], false);
    assert_eq!(board["board"]["tasks"][0]["title"], "Ship it");
    assert_eq!(board["board"]["tasks"][0]["column"], "backlog");
    assert_eq!(board["board"]["tasks"][0]["project_id"], project_id, "the project chip carries the catalog's id");
    assert_eq!(board["board"]["projects"][0]["name"], "Aurora");
    leaks(&body);

    let (status, _, body) = host.send(get_as("/api/v1/calendar?month=2026-07", &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let month = json(&body);
    assert_eq!(month["desktop_available"], false);
    assert_eq!(month["calendar"]["month"], "2026-07");
    assert_eq!(month["calendar"]["events"][0]["title"], "Defense");
    assert_eq!(month["calendar"]["events"][0]["start"], "2026-07-15T10:00");
    leaks(&body);

    let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/schedules"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let schedules = json(&body);
    assert_eq!(schedules["desktop_available"], false);
    assert_eq!(schedules["schedules"][0]["id"], "sched-1");
    assert_eq!(schedules["schedules"][0]["message"], "Nightly review");
    assert!(schedules["schedules"][0].get("preface").is_none(), "prefix commands stay desktop-side");
    assert!(schedules["next_runs"]["sched-1"].as_str().is_some_and(|k| k.ends_with("T09:00")));
    assert!(schedules["time_zone"].as_str().is_some_and(|z| !z.is_empty()));
    leaks(&body);

    let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/prompts"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let prompts = json(&body);
    assert_eq!(prompts["desktop_available"], false);
    assert_eq!(prompts["prompts"][0]["message"], "Write the intro");
    assert!(prompts["prompts"][0].get("target").is_none(), "the target binding stays desktop-side");
    leaks(&body);

    let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/transcript"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let transcript = json(&body);
    assert_eq!(transcript["desktop_available"], false);
    assert_eq!(transcript["transcript"]["available"], false, "no such session on this machine");
    leaks(&body);

    // Writes are still the window's: the sidecar never touches the files.
    let create = Request::builder()
        .method("POST")
        .uri("/api/v1/todo")
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, cookie_pair(&cookie))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "type": "create",
                "task": { "title": "New", "priority": 0, "percent": 0, "column": "backlog",
                          "calendar_id": board["board"]["calendars"][0]["id"] }
            }))
            .expect("body"),
        ))
        .expect("request");
    // A write with no window is the owner's now (H3): one CAS commit on
    // the file, answered with the board as stored.
    let (status, _, body) = host.send(create).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false);
    assert_eq!(
        crate::services::calendar_store::read_data(&calendar).expect("calendar").tasks.len(),
        2,
        "the card was written"
    );
    leaks(&body);
}

#[test]
fn successful_schedule_response_exposes_only_phone_fields() {
    use crate::schema::{AgentScheduleLastRun, AgentScheduleResult, AgentScheduleRule};

    let (status, Json(body)) = schedule_desktop_error(Ok(DesktopResponse::Schedules {
        schedules: vec![crate::schema::ScheduledAgentPrompt {
            id: "schedule-1".into(),
            enabled: true,
            message: "Review".into(),
            rule: AgentScheduleRule::Daily { time: "09:00".into() },
            preface: vec!["/clear".into()],
            last: Some(AgentScheduleLastRun {
                occurrence: "2026-09-24T09:00".into(),
                result: AgentScheduleResult::Delivered,
                at: "2026-09-24T09:01:00Z".into(),
                // A newer build's unknown fields stay in the file.
                extra: [("future_receipt".to_string(), serde_json::json!("x"))].into(),
            }),
            origin: Some(crate::schema::agent_tasks::ScheduleOrigin {
                by: crate::schema::agent_tasks::ScheduleAuthor::Agent,
                session: "raw-session-id".into(),
                at: "2026-09-23T08:00:00Z".into(),
                from_delivery: None,
                extra: [("future_origin".to_string(), serde_json::json!(1))].into(),
            }),
            // The phone that made a rule never crosses the browser API.
            phone_device: Some("device-that-made-it".into()),
            extra: [("future_rule".to_string(), serde_json::json!(true))].into(),
        }],
        time_zone: "Europe/Berlin".into(),
        next_runs: Default::default(),
    }));
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["schedules"], serde_json::json!([{
        "id": "schedule-1",
        "enabled": true,
        "message": "Review",
        "rule": { "type": "daily", "time": "09:00" },
        "last": {
            "occurrence": "2026-09-24T09:00",
            "result": "delivered",
            "at": "2026-09-24T09:01:00Z",
        },
    }]));
}

#[test]
fn successful_prompt_response_omits_internal_target() {
    let (status, Json(body)) = prompt_desktop_error(Ok(DesktopResponse::Prompts {
        prompts: vec![crate::schema::agent_prompts::ProjectAgentPrompt {
            id: "prompt-1".into(),
            message: "Review".into(),
            created_at: "2026-09-23T08:00:00Z".into(),
            updated_at: "2026-09-24T08:00:00Z".into(),
            tags: vec!["review".into()],
            target: Some("raw-schedule-target-id".into()),
            // The phone that wrote it never crosses the browser API.
            phone_device: Some("device-that-wrote-it".into()),
        }],
    }));
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["prompts"], serde_json::json!([{
        "id": "prompt-1",
        "message": "Review",
        "created_at": "2026-09-23T08:00:00Z",
        "updated_at": "2026-09-24T08:00:00Z",
        "tags": ["review"],
    }]));
}

#[tokio::test]
async fn the_activity_list_answers_an_empty_list_when_no_desktop_classifies_tabs() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(21)).await.0;
    let (status, _, body) = host.send(get_as("/api/v1/activity", &cookie)).await;
    // A closed desktop is not an error here: the phone shows the list empty
    // and says why, the same way the project overview does.
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false);
    assert_eq!(json(&body)["tabs"].as_array().expect("tabs").len(), 0);
    assert!(!body.contains(RAW_PROJECT));
    assert!(!body.contains(crate::brand::TMUX_PREFIX));
}

#[test]
fn the_activity_list_puts_a_waiting_session_first_and_a_finished_one_last() {
    assert!(activity_rank("question") < activity_rank("working"));
    assert!(activity_rank("working") < activity_rank("done"));
}

#[test]
fn closed_tab_rows_cross_bounded_and_only_with_minted_ids() {
    use super::super::protocol::ClosedAgentTab;
    let row = |id: &str, label: &str| ClosedAgentTab {
        id: id.into(),
        label: label.into(),
        agent: "claude".into(),
        closed_at: 1,
    };
    let mut rows = vec![
        row("../../etc", "bad id"),
        row("5c1d2f0e-8a1b-4c2d-9e3f-0a1b2c3d4e5f", "claude\u{1b}[2J 1"),
    ];
    rows.extend((0..20).map(|i| row(&format!("id-{i}"), "x")));
    let out = closed_tab_rows(rows);
    assert_eq!(out.len(), MAX_CLOSED_TABS);
    assert_eq!(out[0]["id"], "5c1d2f0e-8a1b-4c2d-9e3f-0a1b2c3d4e5f");
    assert_eq!(out[0]["label"], "claude[2J 1");
    assert!(out.iter().all(|r| r["id"] != "../../etc"));
    assert!(!closed_tab_id_ok(&"a".repeat(65)));
    assert!(!closed_tab_id_ok(""));
}

#[test]
fn a_tab_label_is_refused_before_it_can_be_silently_truncated_or_smuggled() {
    assert_eq!(clean_tab_label("  Review  ").as_deref(), Some("Review"));
    assert_eq!(clean_tab_label("   "), None);
    assert!(clean_tab_label(&"x".repeat(MAX_TAB_LABEL)).is_some());
    assert_eq!(clean_tab_label(&"x".repeat(MAX_TAB_LABEL + 1)), None);
    // A control character would reach a terminal title verbatim.
    assert_eq!(clean_tab_label("Claude\u{1b}]0;pwned\u{7}"), None);
    assert_eq!(clean_tab_label("Claude\nrm -rf"), None);
    // The cap counts characters, not bytes: an emoji name is not 4x longer.
    assert!(clean_tab_label(&"\u{1f680}".repeat(MAX_TAB_LABEL)).is_some());
}

#[test]
fn a_tab_colour_is_a_palette_id_or_nothing() {
    // The palette's ids pass; whitespace is trimmed the way a label is.
    assert_eq!(clean_tab_color(Some("teal")), Ok(Some("teal".into())));
    assert_eq!(clean_tab_color(Some("  indigo  ")), Ok(Some("indigo".into())));
    // Two ways of saying "clear it", both accepted: an absent body field and
    // an empty one. This is the phone's None chip.
    assert_eq!(clean_tab_color(None), Ok(None));
    assert_eq!(clean_tab_color(Some("")), Ok(None));
    // Anything else is refused, NOT read as a clear — a colour this build
    // does not know is a version seam, not a request to remove one.
    assert!(clean_tab_color(Some("chartreuse")).is_err());
    // And nothing that is not an id can reach a style attribute.
    assert!(clean_tab_color(Some("#ff0000")).is_err());
    assert!(clean_tab_color(Some("red; background:url(x)")).is_err());
    assert!(clean_tab_color(Some("Red")).is_err());
}

#[tokio::test]
async fn a_sign_in_callback_reaches_only_a_local_listener_for_a_known_agent_tab() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(31)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
    let (_, _, project_body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("tab id").to_string();
    let press = |tab: &str, origin: &'static str, url: &str| {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/tabs/{tab}/sign-in-callback"))
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&json!({ "url": url })).expect("body")))
            .expect("request")
    };
    let good = "http://localhost:1455/auth/callback?code=c&state=s";

    let (status, _, _) = host.send(press(&tab_id, "https://evil.example", good)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, body) = host.send(press("not-a-tab", ORIGIN, good)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    let (status, _, body) = host
        .send(press(&tab_id, ORIGIN, "http://example.com:1455/cb?code=c&state=s"))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "callback_not_local");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut request = vec![0u8; 4096];
        let _ = socket.read(&mut request).await;
        let _ = socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret")
            .await;
    });
    let (status, _, body) = host
        .send(press(&tab_id, ORIGIN, &format!("http://127.0.0.1:{port}/cb?code=c&state=s")))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["delivered"], true);
    assert!(!body.contains("secret"), "the listener's page stays on the desktop: {body}");
}

#[tokio::test]
async fn a_sign_in_tab_is_asked_for_by_tab_id_and_never_names_a_session() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(32)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
    let (_, _, project_body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("tab id").to_string();
    let press = |uri: String, origin: &'static str, body: Value| {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).expect("body")))
            .expect("request")
    };
    let route = format!("/api/v1/tabs/{tab_id}/sign-in");
    let key = "0123456789abcdef";

    let (status, _, _) = host
        .send(press(route.clone(), "https://evil.example", json!({ "idempotency_key": key })))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, body) = host
        .send(press("/api/v1/tabs/not-a-tab/sign-in".into(), ORIGIN, json!({ "idempotency_key": key })))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    // The phone names the tab and the way in, nothing else.
    let (status, _, body) = host
        .send(press(route.clone(), ORIGIN, json!({ "idempotency_key": key, "cmd": "sh" })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    let (status, _, body) = host
        .send(press(route.clone(), ORIGIN, json!({ "idempotency_key": "short" })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");

    // Well formed, with no desktop window: unavailable, and nothing the
    // desktop is addressed by comes back.
    let (status, _, body) = host
        .send(press(route, ORIGIN, json!({ "idempotency_key": key, "alternate": true })))
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
    assert_eq!(json(&body)["error"], "desktop_unavailable");
    assert!(!body.contains(RAW_PROJECT));
    assert!(!body.contains(crate::brand::TMUX_PREFIX));

    // The create route will not take the session name from the phone.
    let (status, _, body) = host
        .send(press(
            format!("/api/v1/projects/{project_id}/tabs"),
            ORIGIN,
            json!({
                "project_id": project_id,
                "kind": "agent",
                "like_tab": concat!(crate::app_slug!(), "-anything"),
                "sign_in": "default",
                "idempotency_key": key,
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "invalid_request");
}

#[tokio::test]
async fn a_teleport_names_a_cloud_tab_and_a_clean_session_id() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(33)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
    let (_, _, project_body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("tab id").to_string();
    let press = |uri: String, origin: &'static str, body: Value| {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).expect("body")))
            .expect("request")
    };
    let route = format!("/api/v1/tabs/{tab_id}/teleport");
    let key = "0123456789abcdef";
    let session = "session_011SU65rAbc";

    let (status, _, _) = host
        .send(press(route.clone(), "https://evil.example", json!({ "session": session, "idempotency_key": key })))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, body) = host
        .send(press("/api/v1/tabs/not-a-tab/teleport".into(), ORIGIN, json!({ "session": session, "idempotency_key": key })))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    // The session id goes on a command line: a flag or a shell word is refused.
    for bad in ["--dangerously-skip-permissions", "s; rm -rf ~", ""] {
        let (status, _, body) = host
            .send(press(route.clone(), ORIGIN, json!({ "session": bad, "idempotency_key": key })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad} answered: {body}");
    }
    let (status, _, body) = host
        .send(press(route.clone(), ORIGIN, json!({ "session": session, "idempotency_key": key, "cwd": "/" })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    // The fixture's tab is a plain agent, not a cloud session's.
    let (status, _, body) = host
        .send(press(route, ORIGIN, json!({ "session": session, "idempotency_key": key })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "cloud_tab_required");

    // The create route will not take a teleport from the phone.
    let (status, _, body) = host
        .send(press(
            format!("/api/v1/projects/{project_id}/tabs"),
            ORIGIN,
            json!({
                "project_id": project_id,
                "kind": "agent",
                "like_tab": concat!(crate::app_slug!(), "-anything"),
                "teleport": session,
                "idempotency_key": key,
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "invalid_request");
}

#[tokio::test]
async fn finishing_an_alert_needs_a_same_origin_and_a_usable_row_handle() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(28)).await.0;
    let press = |origin: &'static str, body: Value| {
        Request::builder()
            .method("POST")
            .uri("/api/v1/alerts")
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).expect("body")))
            .expect("request")
    };

    // Origin is checked before the handle and before any desktop call.
    let (status, _, body) = host
        .send(press("https://evil.example", json!({ "alert_id": "row" })))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");

    // The sidecar validates the handle's shape and nothing else: an empty
    // one, and a body that tries to name the act instead of the row.
    let (status, _, body) = host.send(press(ORIGIN, json!({ "alert_id": "" }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "invalid_request");
    let (status, _, body) = host
        .send(press(ORIGIN, json!({ "alert_id": "row", "action": "delete" })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");

    // A well-formed press with no desktop window is unavailable, not a
    // refusal the phone should read as "that alert is gone".
    let (status, _, body) = host.send(press(ORIGIN, json!({ "alert_id": "row" }))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
    assert_eq!(json(&body)["error"], "desktop_unavailable");
}

#[tokio::test]
async fn renaming_a_tab_needs_the_desktop_bridge_a_same_origin_and_a_usable_label() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(16)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"]
        .as_str()
        .expect("opaque project id")
        .to_string();
    let (_, _, project_body) = host
        .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
        .await;
    let tab_id = json(&project_body)["tabs"][0]["id"]
        .as_str()
        .expect("opaque tab id")
        .to_string();

    let rename = |origin: &'static str, label: &str| {
        Request::builder()
            .method("PUT")
            .uri(format!("/api/v1/tabs/{tab_id}"))
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "label": label })).expect("body"),
            ))
            .expect("request")
    };

    // Origin is checked before the label and before any desktop call.
    let (status, _, body) = host.send(rename("https://evil.example", "Owned")).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");

    let (status, _, body) = host.send(rename(ORIGIN, "   ")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "invalid_label");

    // A well-formed rename with no desktop window is the owner's (H3): it
    // lands in the session file, is answered as stored and flagged, and
    // still leaks neither the raw project id nor the tmux name.
    let (status, _, body) = host.send(rename(ORIGIN, "Release review")).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false);
    assert_eq!(json(&body)["tab"]["label"], "Release review");
    assert!(!body.contains(RAW_PROJECT));
    assert!(!body.contains(crate::brand::TMUX_PREFIX));
}

#[tokio::test]
async fn closing_a_tab_serves_every_kind_and_needs_the_desktop_bridge() {
    // A box holding shell tabs: closing is the one tab route that is not
    // agent-only, so the fixture is deliberately a kind the schedule and
    // rename routes refuse.
    let host = Fixture::with_box();
    let cookie = host.pair_device(&signing_key(21)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"]
        .as_str()
        .expect("opaque box id")
        .to_string();
    let (_, _, project_body) = host
        .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
        .await;
    let tab = json(&project_body)["tabs"][0].clone();
    assert_eq!(tab["kind"], "shell");
    let tab_id = tab["id"].as_str().expect("opaque tab id").to_string();

    let close = |origin: &'static str, cookie: Option<&str>| {
        let mut request = Request::builder()
            .method("DELETE")
            .uri(format!("/api/v1/tabs/{tab_id}"))
            .header(header::ORIGIN, origin);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie_pair(cookie));
        }
        request.body(Body::empty()).expect("request")
    };

    // Authentication, then origin, before anything is resolved or called.
    let (status, _, body) = host.send(close(ORIGIN, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
    let (status, _, body) = host.send(close("https://evil.example", Some(&cookie))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");

    // A well-formed close with no desktop window is the owner's (H3): the
    // tab leaves the session file and its session is ended — and the
    // answer leaks neither the raw ids nor the tmux name.
    let (status, _, body) = host.send(close(ORIGIN, Some(&cookie))).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["closed"], true);
    assert_eq!(json(&body)["desktop_available"], false);
    assert!(!body.contains(RAW_BOX));
    assert!(!body.contains(RAW_PROJECT));
    assert!(!body.contains(crate::brand::TMUX_PREFIX));
    assert_eq!(
        host.runner.killed.lock().unwrap().as_slice(),
        [format!("{SLUG}-box_{RAW_BOX}--shell-abcdef123")],
        "the session behind the closed tab was ended"
    );
    let (_, _, project_body) = host
        .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
        .await;
    assert_eq!(json(&project_body)["tabs"].as_array().map(Vec::len), Some(1), "{project_body}");
    let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("remaining tab").to_string();

    // The agent-only routes are unchanged by that: the same shell tab is
    // still refused a schedule.
    let (status, _, body) = host
        .send(get_as(&format!("/api/v1/tabs/{tab_id}/schedules"), &cookie))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "agent_tab_required");

    // An unknown tab is a 404 rather than a desktop call.
    let (status, _, body) = host
        .send(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/tabs/not-a-tab")
                .header(header::ORIGIN, ORIGIN)
                .header(header::COOKIE, cookie_pair(&cookie))
                .body(Body::empty())
                .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
}

#[tokio::test]
async fn moving_a_tab_names_both_rows_by_id_and_needs_the_desktop_bridge() {
    // The box fixture, for its two tabs: a move is the one tab route that
    // takes a second row, and both must resolve to the same scope.
    let host = Fixture::with_box();
    let cookie = host.pair_device(&signing_key(31)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"]
        .as_str()
        .expect("opaque box id")
        .to_string();
    let (_, _, project_body) = host
        .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
        .await;
    let tabs = json(&project_body)["tabs"].clone();
    let tab_id = tabs[0]["id"].as_str().expect("opaque tab id").to_string();
    let anchor_id = tabs[1]["id"].as_str().expect("opaque tab id").to_string();

    let move_to = |origin: &'static str, cookie: Option<&str>, anchor: &str, place: &str| {
        let mut request = Request::builder()
            .method("PUT")
            .uri(format!("/api/v1/tabs/{tab_id}/order"))
            .header(header::ORIGIN, origin)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie_pair(cookie));
        }
        request
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "anchor": anchor, "place": place }))
                    .expect("body"),
            ))
            .expect("request")
    };

    // Authentication, then origin, before either row is resolved.
    let (status, _, body) = host.send(move_to(ORIGIN, None, &anchor_id, "after")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
    let (status, _, body) = host
        .send(move_to("https://evil.example", Some(&cookie), &anchor_id, "after"))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");

    // A side this build does not know, and a tab dropped on itself, are
    // both refused before any desktop call.
    let (status, _, body) = host
        .send(move_to(ORIGIN, Some(&cookie), &anchor_id, "above"))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "invalid_request");
    let (status, _, body) = host.send(move_to(ORIGIN, Some(&cookie), &tab_id, "after")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "invalid_anchor");

    // An anchor that is not a tab is a 404, not a move against a guess.
    let (status, _, body) = host
        .send(move_to(ORIGIN, Some(&cookie), "not-a-tab", "before"))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    assert_eq!(json(&body)["error"], "tab_not_found");

    // A well-formed move with no desktop window is the owner's (H3): the
    // session file's order is the phone's, and the answer says nothing
    // about the raw ids or the tmux names.
    let (status, _, body) = host
        .send(move_to(ORIGIN, Some(&cookie), &anchor_id, "after"))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false);
    assert_eq!(json(&body)["tabs"], serde_json::json!([anchor_id, tab_id]), "the moved tab now follows its anchor");
    assert!(!body.contains(RAW_BOX));
    assert!(!body.contains(RAW_PROJECT));
    assert!(!body.contains(crate::brand::TMUX_PREFIX));
}

#[tokio::test]
async fn mail_writes_check_origin_and_shape_before_the_desktop_bridge() {
    let host = Fixture::bare();
    let cookie = host.pair_device(&signing_key(17)).await.0;
    let post = |uri: &str, origin: &'static str, body: Value| {
        Request::builder()
            .method("POST")
            .uri(uri.to_string())
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).expect("body")))
            .expect("request")
    };
    let mark = "/api/v1/mail/folders/folder-1/messages/message-1/mark";
    let reply = "/api/v1/mail/folders/folder-1/messages/message-1/reply";

    // Origin first, before the body is even parsed.
    let (status, _, body) = host
        .send(post(mark, "https://evil.example", serde_json::json!({ "action": "seen" })))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
    assert_eq!(json(&body)["error"], "invalid_origin");

    // Only the four flag verbs exist: no delete, no move, no free-form flag.
    for action in ["deleted", "move", "\\Seen", ""] {
        let (status, _, body) = host
            .send(post(mark, ORIGIN, serde_json::json!({ "action": action })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{action} answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_request", "{action}");
    }
    // Ids are validated exactly as the read routes validate them.
    let (status, _, body) = host
        .send(post(
            "/api/v1/mail/folders/../messages/message-1/mark",
            ORIGIN,
            serde_json::json!({ "action": "seen" }),
        ))
        .await;
    assert!(
        status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
        "answered: {body}"
    );

    // A reply carries text and nothing else: no recipient, subject or
    // headers are accepted from the phone.
    let (status, _, body) = host
        .send(post(
            reply,
            ORIGIN,
            serde_json::json!({ "body": "Thanks", "to": "someone@example.test" }),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    let (status, _, body) = host
        .send(post(reply, ORIGIN, serde_json::json!({ "body": "   " })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "empty_reply");
    let (status, _, body) = host
        .send(post(
            reply,
            ORIGIN,
            serde_json::json!({ "body": "x".repeat(MAX_MAIL_REPLY_BYTES + 1) }),
        ))
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "answered: {body}");

    // Well-formed writes with no desktop window are unavailable, not
    // silently accepted: the sidecar never touches mail itself.
    for (uri, body) in [
        (mark, serde_json::json!({ "action": "flag", "offset": 25 })),
        (reply, serde_json::json!({ "body": "On my way." })),
    ] {
        let (status, _, answer) = host.send(post(uri, ORIGIN, body)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{uri} answered: {answer}");
        assert_eq!(json(&answer)["error"], "desktop_unavailable", "{uri}");
    }
}

#[tokio::test]
async fn prompt_collection_requires_the_desktop_bridge_and_checks_origin() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(14)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"]
        .as_str()
        .expect("opaque project id")
        .to_string();
    let (_, _, project_body) = host
        .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
        .await;
    let tab_id = json(&project_body)["tabs"][0]["id"]
        .as_str()
        .expect("opaque tab id")
        .to_string();

    // No window: the (empty) collection is answered off the file and
    // flagged read-only; nothing raw crosses.
    let (status, _, body) = host
        .send(get_as(&format!("/api/v1/projects/{project_id}/prompts"), &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false);
    assert_eq!(json(&body)["prompts"], serde_json::json!([]));
    assert!(!body.contains(RAW_PROJECT));

    let (status, _, body) = host
        .send(get_as("/api/v1/projects/nope/prompts", &cookie))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

    // A mutation from a foreign origin is refused before any desktop call.
    let create = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/projects/{project_id}/prompts"))
        .header(header::ORIGIN, "https://evil.example")
        .header(header::COOKIE, cookie_pair(&cookie))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({ "message": "Review" })).expect("body"),
        ))
        .expect("request");
    let (status, _, answer) = host.send(create).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");

    // Sending names a tab of this project; a shell tab is not a target.
    let send = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/projects/{project_id}/prompts/anything/send"))
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, cookie_pair(&cookie))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({ "tab_id": tab_id })).expect("body"),
        ))
        .expect("request");
    let (status, _, answer) = host.send(send).await;
    assert!(
        status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
        "answered {status}: {answer}"
    );
    assert!(!answer.contains(RAW_PROJECT));
    assert!(!answer.contains("tmux"));
}

#[tokio::test]
async fn a_session_cookie_must_carry_the_exact_host_prefixed_name() {
    let host = Fixture::bare();
    let cookie = host.pair_device(&signing_key(9)).await.0;
    let token = cookie_pair(&cookie)
        .split_once('=')
        .expect("token")
        .1
        .to_string();

    let (status, ..) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(status, StatusCode::OK);

    // The same token under an unprefixed name carries none of the
    // `__Host-` guarantees and must not authenticate.
    let request = Request::builder()
        .uri("/api/v1/status")
        .header(header::COOKIE, format!("{SLUG}_session={token}"))
        .body(Body::empty())
        .expect("request");
    let (status, _, body) = host.send(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
}

#[tokio::test]
async fn mutating_routes_require_the_exact_serve_origin() {
    let host = Fixture::bare();
    let cookie = host.pair_device(&signing_key(11)).await.0;
    let body = serde_json::json!({ "device_id": "anything" });
    // A prefix of the real origin, a suffix of it, and no header at all.
    for origin in [
        "https://desk.example.ts.net.evil.example",
        "https://evil.example",
        "http://desk.example.ts.net",
        "null",
    ] {
        let (status, _, answer) = host.send(post_json("/api/v1/auth/challenge", origin, &body)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin} answered: {answer}");
        assert_eq!(json(&answer)["error"], "invalid_origin", "{origin}");
    }
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/challenge")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&body).expect("body")))
        .expect("request");
    let (status, ..) = host.send(request).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a missing Origin is not exact");

    // An authenticated mutation is refused on origin too, not just on session.
    let create = Request::builder()
        .method("POST")
        .uri("/api/v1/projects/anything/tabs")
        .header(header::ORIGIN, "https://evil.example")
        .header(header::COOKIE, cookie_pair(&cookie))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "project_id": "anything",
                "kind": "shell",
                "idempotency_key": "0123456789abcdef",
            }))
            .expect("body"),
        ))
        .expect("request");
    let (status, _, answer) = host.send(create).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");

    let schedule = Request::builder()
        .method("POST")
        .uri("/api/v1/tabs/anything/schedules")
        .header(header::ORIGIN, "https://evil.example")
        .header(header::COOKIE, cookie_pair(&cookie))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "enabled": true,
                "message": "Review",
                "rule": { "type": "daily", "time": "09:00" },
            }))
            .expect("body"),
        ))
        .expect("request");
    let (status, _, answer) = host.send(schedule).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");
}

#[tokio::test]
async fn a_paired_login_issues_a_hardened_session_cookie() {
    let host = Fixture::bare();
    let (cookie, _) = host.pair_device(&signing_key(13)).await;
    for attribute in [
        concat!("__Host-", crate::app_slug!(), "_session="),
        "Path=/",
        "Secure",
        "HttpOnly",
        "SameSite=Strict",
    ] {
        assert!(cookie.contains(attribute), "{attribute} missing from {cookie}");
    }
    let (status, headers, _) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn a_signature_from_another_key_never_logs_in() {
    let host = Fixture::bare();
    let device = host.pair_device(&signing_key(17)).await.1;
    let (_, _, body) = host
        .send(post_json(
            "/api/v1/auth/challenge",
            ORIGIN,
            &serde_json::json!({ "device_id": device }),
        ))
        .await;
    let challenge = json(&body);
    let (status, _, answer) = host
        .send(post_json(
            "/api/v1/auth/session",
            ORIGIN,
            &serde_json::json!({
                "device_id": device,
                "nonce": challenge["nonce"],
                // Correct payload, wrong device key.
                "signature": sign(&signing_key(18), challenge["payload"].as_str().unwrap()),
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {answer}");
    assert_eq!(json(&answer)["error"], "invalid_signature");
}

#[tokio::test]
async fn a_captured_challenge_cannot_be_replayed() {
    let host = Fixture::bare();
    let signing = signing_key(19);
    let device = host.pair_device(&signing).await.1;
    let (_, _, body) = host
        .send(post_json(
            "/api/v1/auth/challenge",
            ORIGIN,
            &serde_json::json!({ "device_id": device }),
        ))
        .await;
    let challenge = json(&body);
    let login = serde_json::json!({
        "device_id": device,
        "nonce": challenge["nonce"],
        "signature": sign(&signing, challenge["payload"].as_str().unwrap()),
    });
    let (first, ..) = host.send(post_json("/api/v1/auth/session", ORIGIN, &login)).await;
    assert_eq!(first, StatusCode::OK);
    let (second, _, answer) = host.send(post_json("/api/v1/auth/session", ORIGIN, &login)).await;
    assert_eq!(second, StatusCode::UNAUTHORIZED, "replay answered: {answer}");
    assert_eq!(json(&answer)["error"], "invalid_challenge");
}

#[tokio::test]
async fn revoking_a_device_kills_its_live_session() {
    let host = Fixture::bare();
    let (cookie, device) = host.pair_device(&signing_key(23)).await;
    let (status, ..) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(status, StatusCode::OK);

    host.state.auth.lock().unwrap().revoke(&device).expect("revoke");

    let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a lost phone kept access: {body}");
}

#[tokio::test]
async fn logging_out_clears_the_cookie_and_the_session() {
    let host = Fixture::bare();
    let cookie = host.pair_device(&signing_key(29)).await.0;
    let request = Request::builder()
        .method("DELETE")
        .uri("/api/v1/auth/session")
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, cookie_pair(&cookie))
        .body(Body::empty())
        .expect("request");
    let (status, headers, _) = host.send(request).await;
    assert_eq!(status, StatusCode::OK);
    assert!(set_cookie(&headers).contains("Max-Age=0"));

    let (status, ..) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_pairing_flood_is_rate_limited_at_the_http_edge() {
    let host = Fixture::bare();
    host.state
        .auth
        .lock()
        .unwrap()
        .create_pairing_code()
        .expect("pairing code");
    let guess = serde_json::json!({
        "code": "00000000",
        "device_name": "Attacker",
        "public_key": "not-a-key",
    });
    let mut limited = false;
    // One more than the pairing budget in `auth::PAIR_ATTEMPT_BUDGET`.
    for _ in 0..11 {
        let (status, _, body) = host.send(post_json("/api/v1/pair", ORIGIN, &guess)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        limited |= json(&body)["error"] == "too_many_attempts";
    }
    assert!(limited, "the pair flood was never rate limited");
}

#[tokio::test]
async fn an_oversized_control_body_never_reaches_a_handler() {
    let host = Fixture::bare();
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/pair")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(vec![b'x'; MAX_CONTROL_MESSAGE + 1]))
        .expect("request");
    let (status, ..) = host.send(request).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn every_response_carries_the_hardened_security_headers() {
    let host = Fixture::bare();
    for uri in ["/healthz", "/api/v1/status", "/"] {
        let (_, headers, _) = host.send(get_request(uri)).await;
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff", "{uri}");
        assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY", "{uri}");
        assert!(
            headers[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'"),
            "{uri}"
        );
        assert_eq!(headers["permissions-policy"], MOBILE_PERMISSIONS_POLICY, "{uri}");
    }
    // Only the API and health probe are no-store; the shell is revalidated.
    let (_, api, _) = host.send(get_request("/api/v1/status")).await;
    assert_eq!(api[header::CACHE_CONTROL], "no-store");
    let (_, shell, _) = host.send(get_request("/")).await;
    assert_eq!(shell[header::CACHE_CONTROL], "no-cache");
}

#[tokio::test]
async fn an_unknown_api_path_is_not_answered_with_the_app_shell() {
    let host = Fixture::bare();
    let (status, headers, body) = host.send(get_request("/api/v1/does-not-exist")).await;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        !content_type.contains("text/html"),
        "an /api/ miss served the SPA shell ({status}): {content_type}"
    );
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
}

#[tokio::test]
async fn the_catalog_hands_the_phone_opaque_ids_and_no_paths() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(31)).await.0;

    let (status, _, body) = host
        .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert!(body.contains("Aurora"), "the display label is missing: {body}");
    assert!(!body.contains(RAW_PROJECT), "a raw project id leaked: {body}");
    assert!(
        !body.contains(&host.root.to_string_lossy().to_string()),
        "a filesystem path leaked: {body}"
    );

    let opaque = json(&body)["projects"][0]["id"]
        .as_str()
        .expect("opaque project id")
        .to_string();

    // The opaque id resolves; the raw one the desktop uses does not.
    let (status, ..) = host
        .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, body) = host
        .send(get_as(&format!("/api/v1/projects/{RAW_PROJECT}"), &cookie))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "a raw id resolved: {body}");
}

/// #31aa: a box with Mobile on is a row of the phone's list — kind `box`,
/// always active, opaque id, no path, no raw id — and its own tabs come
/// back under it, including the one running in a member's tree. The
/// member's own Mobile switch is off, so the member is *not* a row; the
/// box's switch reaches the box's tabs and nothing of the member's own.
#[tokio::test]
async fn a_mobile_enabled_box_is_listed_as_a_box_scope_with_its_own_tabs() {
    let host = Fixture::with_box();
    let cookie = host.pair_device(&signing_key(33)).await.0;

    let (status, _, body) = host.send(get_as("/api/v1/projects?view=active", &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let rows = json(&body)["projects"].as_array().cloned().unwrap_or_default();
    assert_eq!(rows.len(), 1, "one box, no member of its own: {body}");
    assert_eq!(rows[0]["label"], "Paper");
    assert_eq!(rows[0]["kind"], "box");
    assert_eq!(rows[0]["status"], "active");
    assert!(!body.contains(RAW_BOX), "a raw box id leaked: {body}");
    assert!(!body.contains(RAW_PROJECT), "a raw project id leaked: {body}");
    assert!(!body.contains("Private"), "a box with Mobile off is listed: {body}");
    assert!(
        !body.contains(&host.root.to_string_lossy().to_string()),
        "a filesystem path leaked: {body}"
    );

    let opaque = rows[0]["id"].as_str().expect("opaque box id").to_string();
    let (status, _, body) = host
        .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let detail = json(&body);
    assert_eq!(detail["project"]["kind"], "box");
    let labels: Vec<String> = detail["tabs"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|tab| tab["label"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(labels, vec!["Box shell", "Aurora shell"], "{body}");
    assert!(!body.contains("box_"), "a session-dir or tmux name leaked: {body}");
}

#[tokio::test]
async fn a_tab_without_a_live_session_is_reported_gone() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(37)).await.0;
    let (status, _, body) = host
        .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let opaque = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
    let (_, _, body) = host
        .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
        .await;
    let tab = &json(&body)["tabs"][0];
    assert_eq!(tab["kind"], "agent");
    assert_eq!(
        tab["available"], false,
        "a tab with no tmux session must not be attachable: {body}"
    );
    assert!(!body.contains(concat!(crate::app_slug!(), "-raw-project")), "a tmux name leaked: {body}");
}

#[tokio::test]
async fn a_create_request_for_another_project_is_refused_before_any_state_is_read() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(41)).await.0;
    let request = |body: Value| {
        Request::builder()
            .method("POST")
            .uri("/api/v1/projects/target/tabs")
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).expect("body")))
            .expect("request")
    };
    // The body's project id disagrees with the path's.
    let (status, _, answer) = host
        .send(request(serde_json::json!({
            "project_id": "somewhere-else",
            "kind": "shell",
            "idempotency_key": "0123456789abcdef",
        })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {answer}");
    assert_eq!(json(&answer)["error"], "invalid_request");

    // A shell, while shells are off the phone (the default), is refused
    // before the catalog is asked.
    let (status, _, answer) = host
        .send(request(serde_json::json!({
            "project_id": "target",
            "kind": "shell",
            "idempotency_key": "0123456789abcdef",
        })))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");
    assert_eq!(json(&answer)["error"], "shells_off");

    // An unknown project resolves to nothing rather than to a raw id.
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        serde_json::json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true } }).to_string(),
    )
    .expect("settings");
    let (status, _, answer) = host
        .send(request(serde_json::json!({
            "project_id": "target",
            "kind": "shell",
            "idempotency_key": "0123456789abcdef",
        })))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {answer}");
}

/// The opaque id of the fixture project's one tab, as the phone sees it.
async fn fixture_tab_id(host: &Fixture, cookie: &str) -> String {
    let (_, _, body) = host
        .send(get_as("/api/v1/projects?view=search&q=aurora", cookie))
        .await;
    let opaque = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
    let (_, _, body) = host
        .send(get_as(&format!("/api/v1/projects/{opaque}"), cookie))
        .await;
    json(&body)["tabs"][0]["id"].as_str().unwrap().to_string()
}

fn inbox_request(tab_id: &str, name: &str, cookie: &str, bytes: Vec<u8>) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/api/v1/tabs/{tab_id}/inbox?name={name}"))
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, cookie_pair(cookie))
        .header(header::CONTENT_TYPE, "image/jpeg")
        .body(Body::from(bytes))
        .expect("request")
}

#[tokio::test]
async fn desktop_images_need_the_bridge_a_known_tab_a_same_origin_and_a_listed_id() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(31)).await.0;
    let tab_id = fixture_tab_id(&host, &cookie).await;
    let attach = |tab: &str, origin: &str, body: Value| {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/tabs/{tab}/desktop-images"))
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).expect("body")))
            .expect("request")
    };

    // No desktop window: the folders are listed here, flagged (H3), and
    // neither the raw project id nor the project path leaks out.
    let (status, _, body) = host
        .send(get_as(&format!("/api/v1/tabs/{tab_id}/desktop-images"), &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false);
    assert!(!body.contains(RAW_PROJECT));
    assert!(!body.contains(host.root.to_str().unwrap()));

    let (status, _, body) = host
        .send(get_as("/api/v1/tabs/not-a-tab/desktop-images", &cookie))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

    // Origin, then the id's shape, before any desktop call — a path-shaped
    // id is refused as malformed, never resolved.
    let clipboard = serde_json::json!({ "image_id": "clipboard" });
    let (status, _, body) = host
        .send(attach(&tab_id, "https://evil.example", clipboard.clone()))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
    for bad in ["", "../../etc/passwd", "/home/x/shot.png", "0123", "not-hex-but-32-characters-long!!"] {
        let (status, _, body) = host
            .send(attach(&tab_id, ORIGIN, serde_json::json!({ "image_id": bad })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?} answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_request");
    }
    let (status, _, body) = host
        .send(attach(&tab_id, ORIGIN, serde_json::json!({ "nope": 1 })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");

    let (status, _, body) = host.send(attach(&tab_id, ORIGIN, clipboard.clone())).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
    assert_eq!(json(&body)["error"], "desktop_unavailable");
    let (status, _, body) = host.send(attach("not-a-tab", ORIGIN, clipboard)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    // Nothing reached the inbox without a desktop to copy from.
    assert!(!host.root.join(inbox::INBOX_DIR).exists());
}

#[tokio::test]
async fn the_outbox_lists_and_serves_the_agents_images_by_leaf_only() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(33)).await.0;
    let tab_id = fixture_tab_id(&host, &cookie).await;
    let list = format!("/api/v1/tabs/{tab_id}/outbox");

    // No outbox yet: an empty strip, not an error.
    let (status, _, body) = host.send(get_as(&list, &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["files"], serde_json::json!([]));

    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-body".to_vec();
    let dir = host.root.join(outbox::OUTBOX_DIR);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("plot.png"), &png).unwrap();
    std::fs::write(dir.join("notes.png"), b"not a picture at all").unwrap();

    let (status, _, body) = host.send(get_as(&list, &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let images = json(&body)["files"].clone();
    assert_eq!(images.as_array().map(Vec::len), Some(2), "{body}");
    let image = images.as_array().unwrap().iter().find(|file| file["name"] == "plot.png").unwrap();
    assert_eq!(image["kind"], "image/png");
    assert_eq!(image["size"], png.len());
    assert!(image["modified"].as_u64().unwrap() > 0);
    assert!(!body.contains(RAW_PROJECT));
    assert!(!body.contains(host.root.to_str().unwrap()));

    // The bytes come back typed by their header, on the session cookie
    // alone — this is what an `<img>` on the PWA's origin sends.
    let (status, headers, body) = host
        .send(get_as(&format!("{list}/plot.png"), &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "image/png");
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    // The fixture reads bodies as lossy UTF-8, which mangles the PNG's
    // 0x89; the declared length and the tail prove the bytes came through.
    assert_eq!(headers.get(header::CONTENT_LENGTH).unwrap(), png.len().to_string().as_str());
    assert!(body.ends_with("IHDR-body"), "{body:?}");
    // A leaf can be rewritten under its name: kept on the phone only when
    // the read names its version, never as a download.
    assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store", "an unversioned read is not kept");
    let (status, headers, _) = host.send(get_as(&format!("{list}/plot.png?v=1-2"), &cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), INBOX_FILE_CACHE, "a versioned read is cacheable");
    let (_, headers, _) = host.send(get_as(&format!("{list}/plot.png?v=1-2&download=1"), &cookie)).await;
    assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store", "a download is not kept");

    std::fs::write(dir.join("archive.zip"), b"PK\0\x01").unwrap();
    std::fs::write(dir.join("20260930-101530-20260930-101010-deck.zip"), b"PK\0\x01").unwrap();
    for (name, kind, disposition) in [
        ("notes.png", "text/plain; charset=utf-8", "inline"),
        ("plot.png?download=1", "image/png", "attachment; filename=\"plot.png\""),
        ("archive.zip", "application/octet-stream", "attachment; filename=\"archive.zip\""),
        ("20260930-101530-20260930-101010-deck.zip", "application/octet-stream", "attachment; filename=\"deck.zip\""),
    ] {
        let (status, headers, _) = host.send(get_as(&format!("{list}/{name}"), &cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), kind);
        assert_eq!(headers.get(header::CONTENT_DISPOSITION).unwrap(), disposition);
    }

    // Not an image by its bytes, a traversal, an unlisted name: all one
    // answer, so the phone cannot probe the tree by its error codes.
    for refused in ["..%2F..%2Fproject.json", "gone.png", ".hidden.png"] {
        let (status, _, body) = host
            .send(get_as(&format!("{list}/{refused}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{refused} answered: {body}");
        assert_eq!(json(&body)["error"], "file_not_found");
    }

    let (status, _, body) = host
        .send(get_as("/api/v1/tabs/not-a-tab/outbox", &cookie))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    let (status, _, _) = host
        .send(get_as("/api/v1/tabs/not-a-tab/outbox/plot.png", &cookie))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = host
        .send(get_as(&format!("{list}/plot.png"), "not-a-session"))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// A copy `tabtivity-send` made of a project file carries that file's
/// sealed row — only with the drawer on, and only for a file the drawer
/// would list — so the phone marks up the project file, not the copy.
#[tokio::test]
async fn an_outbox_copy_carries_its_project_files_row_while_the_drawer_is_on() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(37)).await.0;
    let tab_id = fixture_tab_id(&host, &cookie).await;
    let (_, _, body) = host.send(get_as("/api/v1/projects?view=search&q=aurora", &cookie)).await;
    let project_id = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
    let routes = [format!("/api/v1/tabs/{tab_id}/outbox"), format!("/api/v1/projects/{project_id}/outbox")];

    std::fs::create_dir_all(host.root.join("docs/paper")).unwrap();
    std::fs::write(host.root.join("docs/paper/draft.pdf"), b"%PDF-1.4\n%%EOF\n").unwrap();
    let dir = host.root.join(outbox::OUTBOX_DIR);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("20261004-120000-draft.pdf"), b"%PDF-1.4\n%%EOF\n").unwrap();
    std::fs::write(dir.join(".20261004-120000-draft.pdf.src"), "docs/paper/draft.pdf").unwrap();
    // Its project file gone: no row.
    std::fs::write(dir.join("20261004-120001-gone.pdf"), b"%PDF-1.4\n%%EOF\n").unwrap();
    std::fs::write(dir.join(".20261004-120001-gone.pdf.src"), "docs/gone.pdf").unwrap();
    let row_of = |body: &str, name: &str| {
        json(body)["files"].as_array().unwrap().iter().find(|file| file["name"] == name).unwrap().get("file_row").cloned()
    };

    // Drawer off: the listing as before, no row and no path.
    for route in &routes {
        let (status, _, body) = host.send(get_as(route, &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(row_of(&body, "20261004-120000-draft.pdf"), None, "{body}");
        assert!(!body.contains("docs/") && !body.contains("source"), "{body}");
    }

    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }).to_string(),
    )
    .unwrap();
    let key = host.state.auth.lock().unwrap().host_key().to_vec();
    for route in &routes {
        let (status, _, body) = host.send(get_as(route, &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let row = row_of(&body, "20261004-120000-draft.pdf").expect("a row");
        assert_eq!(row["name"], "draft.pdf", "{body}");
        assert_eq!(row["place"], "docs/paper");
        assert_eq!(row["kind"], "application/pdf");
        assert_eq!(files::unseal(&key, RAW_PROJECT, row["token"].as_str().unwrap()).as_deref(), Some("docs/paper/draft.pdf"));
        assert_eq!(files::unseal(&key, RAW_PROJECT, row["folder"].as_str().unwrap()).as_deref(), Some("docs/paper"));
        assert_eq!(row_of(&body, "20261004-120001-gone.pdf"), None, "{body}");
        assert!(!body.contains("\"source\"") && !body.contains(RAW_PROJECT) && !body.contains(host.root.to_str().unwrap()), "{body}");
    }
}

#[tokio::test]
async fn the_inbox_reads_back_what_the_phone_sent_by_leaf_only() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(34)).await.0;
    let tab_id = fixture_tab_id(&host, &cookie).await;
    let base = format!("/api/v1/tabs/{tab_id}/inbox");

    let (status, _, body) = host.send(get_as(&format!("{base}?names=a.png"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["files"], serde_json::json!([]));

    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-body".to_vec();
    let photo = inbox::store(&host.root, "photo.png", &png).unwrap();
    let note = inbox::store(&host.root, "note.txt", b"hello").unwrap();
    let (status, _, body) = host
        .send(get_as(&format!("{base}?names={},gone.png,..%2Fx,{}", photo.name, note.name), &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let files = json(&body)["files"].clone();
    let kinds: Vec<_> = files.as_array().unwrap().iter().map(|f| (f["name"].as_str().unwrap().to_string(), f["kind"].as_str().unwrap().to_string(), f["original"].as_str().unwrap().to_string())).collect();
    assert_eq!(kinds, vec![
        (photo.name.clone(), "image/png".to_string(), "photo.png".to_string()),
        (note.name.clone(), "text/plain; charset=utf-8".to_string(), "note.txt".to_string()),
    ]);
    assert!(!body.contains(host.root.to_str().unwrap()));

    let (status, headers, body) = host.send(get_as(&format!("{base}/{}", photo.name), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "image/png");
    assert_eq!(headers.get(header::CONTENT_DISPOSITION).unwrap(), "inline");
    assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), INBOX_FILE_CACHE, "a stamped leaf is cacheable on the phone");
    assert!(body.ends_with("IHDR-body"), "{body:?}");
    let (_, headers, _) = host.send(get_as(&format!("{base}/{}?download=1", photo.name), &cookie)).await;
    assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store", "a download is not kept");

    for refused in ["..%2F..%2Fproject.json", "gone.png", ".hidden.png"] {
        let (status, _, body) = host.send(get_as(&format!("{base}/{refused}"), &cookie)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{refused} answered: {body}");
        assert_eq!(json(&body)["error"], "file_not_found");
    }
    let (status, _, _) = host.send(get_as("/api/v1/tabs/not-a-tab/inbox?names=a.png", &cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = host.send(get_as(&format!("{base}/{}", photo.name), "not-a-session")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_outbox_answers_by_the_project_too_for_the_screen_that_has_no_tab() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(34)).await.0;
    let (_, _, body) = host
        .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
        .await;
    let project_id = json(&body)["projects"][0]["id"]
        .as_str()
        .expect("opaque project id")
        .to_string();
    let list = format!("/api/v1/projects/{project_id}/outbox");

    // No outbox yet: an empty shelf, not an error — as by the tab.
    let (status, _, body) = host.send(get_as(&list, &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["files"], serde_json::json!([]));

    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-body".to_vec();
    let dir = host.root.join(outbox::OUTBOX_DIR);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("plot.png"), &png).unwrap();

    let (status, _, body) = host.send(get_as(&list, &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["files"][0]["name"], "plot.png");
    assert_eq!(json(&body)["files"][0]["kind"], "image/png");
    assert!(!body.contains(RAW_PROJECT));
    assert!(!body.contains(host.root.to_str().unwrap()));

    let (status, headers, body) = host
        .send(get_as(&format!("{list}/plot.png"), &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "image/png");
    assert_eq!(
        headers.get(header::CONTENT_LENGTH).unwrap(),
        png.len().to_string().as_str()
    );
    let (_, headers, _) = host
        .send(get_as(&format!("{list}/plot.png?download=1"), &cookie))
        .await;
    assert_eq!(
        headers.get(header::CONTENT_DISPOSITION).unwrap(),
        "attachment; filename=\"plot.png\""
    );

    // Traversal and unlisted names read the same here as by the tab, and an
    // unknown project is not a way to learn which ids exist.
    for refused in ["..%2F..%2Fproject.json", "gone.png"] {
        let (status, _, body) = host
            .send(get_as(&format!("{list}/{refused}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{refused} answered: {body}");
        assert_eq!(json(&body)["error"], "file_not_found");
    }
    let (status, _, body) = host
        .send(get_as("/api/v1/projects/not-a-project/outbox", &cookie))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    assert_eq!(json(&body)["error"], "project_not_found");
    let (status, _, _) = host
        .send(get_as("/api/v1/projects/not-a-project/outbox/plot.png", &cookie))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = host.send(get_as(&list, "not-a-session")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Delete all: the exact-origin check first, then every file goes.
    std::fs::write(dir.join("notes.txt"), "hello").unwrap();
    let no_origin = Request::builder()
        .method("DELETE")
        .uri(&list)
        .header(header::COOKIE, cookie_pair(&cookie))
        .body(Body::empty())
        .expect("request");
    let (status, _, body) = host.send(no_origin).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
    assert!(dir.join("plot.png").exists());
    let (status, _, body) = host.send(request_as("DELETE", &list, &cookie, None)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["removed"], 2);
    assert_eq!(json(&body)["freed"], png.len() as u64 + 5);
    let (_, _, body) = host.send(get_as(&list, &cookie)).await;
    assert_eq!(json(&body)["files"], serde_json::json!([]));
}

#[tokio::test]
async fn the_file_browser_is_off_by_default_and_reads_by_sealed_token_only() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(35)).await.0;
    let (_, _, body) = host
        .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
        .await;
    let project_id = json(&body)["projects"][0]["id"]
        .as_str()
        .expect("opaque project id")
        .to_string();
    let base = format!("/api/v1/projects/{project_id}/files");
    std::fs::create_dir_all(host.root.join("src")).unwrap();
    std::fs::write(host.root.join("src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(host.root.join(".env"), "HIDDEN=1").unwrap();

    // The switch is off: the detail says so and both routes are closed.
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    assert_eq!(json(&body)["files"], false);
    let (status, _, body) = host.send(get_as(&base, &cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    assert_eq!(json(&body)["error"], "files_off");

    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }).to_string(),
    )
    .unwrap();
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
    assert_eq!(json(&body)["files"], true);

    let (status, _, body) = host.send(get_as(&base, &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let root = json(&body);
    assert_eq!(root["entries"][0]["name"], "src");
    assert_eq!(root["entries"][0]["kind"], "dir");
    assert_eq!(root["entries"][0]["items"], 1, "a folder row counts its items");
    assert!(!body.contains(".env"), "hidden names are not listed: {body}");
    assert!(!body.contains(RAW_PROJECT));
    assert!(!body.contains(host.root.to_str().unwrap()));
    let src = root["entries"][0]["token"].as_str().unwrap().to_string();

    let (status, _, body) = host.send(get_as(&format!("{base}?dir={src}"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert!(!body.contains("src/"), "no path in the answer: {body}");
    let file = json(&body)["entries"][0].clone();
    assert_eq!(file["name"], "main.rs");
    let token = file["token"].as_str().unwrap().to_string();

    let (status, headers, body) = host.send(get_as(&format!("{base}/raw?f={token}"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(body, "fn main() {}\n");
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "text/plain; charset=utf-8");
    assert_eq!(headers.get(header::CONTENT_DISPOSITION).unwrap(), "inline");
    let (_, headers, _) = host.send(get_as(&format!("{base}/raw?f={token}&download=1"), &cookie)).await;
    assert_eq!(
        headers.get(header::CONTENT_DISPOSITION).unwrap(),
        "attachment; filename=\"main.rs\"; filename*=UTF-8''main.rs"
    );

    // A folder's token is not a file, a forged token is not a path, and
    // there is nothing to write with.
    for refused in [format!("{base}/raw?f={src}"), format!("{base}/raw?f=AAAA"), format!("{base}/raw"), format!("{base}?dir=AAAA")] {
        let (status, _, body) = host.send(get_as(&refused, &cookie)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{refused} answered: {body}");
        assert_eq!(json(&body)["error"], "file_not_found");
    }
    let (status, _, _) = host.send(get_as(&base, "not-a-session")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = host.send(get_as("/api/v1/projects/not-a-project/files", &cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_file_search_answers_sealed_rows_and_trails_while_the_drawer_is_on() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(36)).await.0;
    let (_, _, body) = host
        .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
        .await;
    let project_id = json(&body)["projects"][0]["id"].as_str().expect("opaque project id").to_string();
    let base = format!("/api/v1/projects/{project_id}/files");
    std::fs::create_dir_all(host.root.join("src/deep")).unwrap();
    std::fs::write(host.root.join("src/deep/notes.txt"), "deep").unwrap();
    std::fs::write(host.root.join(".env.notes"), "HIDDEN=1").unwrap();

    let (status, _, body) = host.send(get_as(&format!("{base}/search?q=notes"), &cookie)).await;
    assert_eq!((status, json(&body)["error"].clone()), (StatusCode::NOT_FOUND, json!("files_off")), "{body}");

    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        serde_json::json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "project_files": true } }).to_string(),
    )
    .unwrap();
    let (status, _, body) = host.send(get_as(&format!("{base}/search?q=NOTES"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let found = json(&body);
    let hits = found["hits"].as_array().expect("hits");
    assert_eq!(hits.len(), 1, "the hidden .env file is not searched: {body}");
    assert_eq!(hits[0]["name"], "notes.txt");
    let trail: Vec<&str> = hits[0]["trail"].as_array().unwrap().iter().map(|crumb| crumb["name"].as_str().unwrap()).collect();
    assert_eq!(trail, ["src", "deep"]);
    assert!(!body.contains("src/") && !body.contains(RAW_PROJECT) && !body.contains(host.root.to_str().unwrap()), "{body}");

    // The hit's token opens the file, its last crumb lists its folder.
    let token = hits[0]["token"].as_str().unwrap();
    let (status, _, bytes) = host.send(get_as(&format!("{base}/raw?f={token}"), &cookie)).await;
    assert_eq!((status, bytes.as_str()), (StatusCode::OK, "deep"));
    let deep = hits[0]["trail"][1]["token"].as_str().unwrap();
    let (_, _, body) = host.send(get_as(&format!("{base}?dir={deep}"), &cookie)).await;
    assert_eq!(json(&body)["entries"][0]["name"], "notes.txt");

    let (status, _, body) = host.send(get_as(&format!("{base}/search?q={}", "x".repeat(files::MAX_QUERY + 1)), &cookie)).await;
    assert_eq!((status, json(&body)["error"].clone()), (StatusCode::BAD_REQUEST, json!("query_too_long")));
    let (_, _, body) = host.send(get_as(&format!("{base}/search"), &cookie)).await;
    assert_eq!(json(&body)["hits"], json!([]));
    let (status, _, _) = host.send(get_as(&format!("{base}/search?q=notes"), "not-a-session")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// The 📁's remote side: offered for a remote project (with no mirror on
/// disk too) and only behind the files switch, never naming the host;
/// with no master to ride every remote-side route says `host_offline`,
/// never dials; a local project has no remote side; a local token is no
/// remote-side token.
#[cfg(unix)]
#[tokio::test]
async fn the_remote_side_of_the_files_rides_the_desktops_master_or_says_host_offline() {
    let host = host_tab_fixture(true);
    let cookie = host.pair_device(&signing_key(72)).await.0;
    let (p, _) = project_and_tab(&host, &cookie).await;
    let base = format!("/api/v1/projects/{p}/files");
    let (_, _, detail) = host.send(get_as(&format!("/api/v1/projects/{p}"), &cookie)).await;
    assert_eq!((json(&detail)["files"].as_bool(), json(&detail)["host_files"].as_bool()), (Some(false), Some(false)), "switch off: {detail}");
    let (status, _, body) = host.send(get_as(&format!("{base}?on=host"), &cookie)).await;
    assert_eq!((status, json(&body)["error"].clone()), (StatusCode::NOT_FOUND, json!("files_off")), "{body}");

    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "project_files": true } }).to_string(),
    )
    .unwrap();
    let (_, _, detail) = host.send(get_as(&format!("/api/v1/projects/{p}"), &cookie)).await;
    assert_eq!((json(&detail)["files"].as_bool(), json(&detail)["host_files"].as_bool()), (Some(false), Some(true)), "{detail}");
    for raw in ["primary.example", "/srv/aurora", "alice"] {
        assert!(!detail.contains(raw), "{raw} crossed: {detail}");
    }
    // The refresher's socket is not there: offline, without `ssh -G` or a dial.
    let local_token = files::seal(host.state.auth.lock_ok().host_key(), RAW_PROJECT, "a.txt").unwrap();
    for uri in [format!("{base}?on=host"), format!("{base}/search?q=notes&on=host")] {
        let (status, _, body) = host.send(get_as(&uri, &cookie)).await;
        assert_eq!((status, json(&body)["error"].clone()), (StatusCode::CONFLICT, json!("host_offline")), "{uri}: {body}");
    }
    let (status, _, body) = host.send(get_as(&format!("{base}/raw?f={local_token}&on=host"), &cookie)).await;
    assert_eq!((status, json(&body)["error"].clone()), (StatusCode::NOT_FOUND, json!("file_not_found")), "a local token: {body}");
    let host_token = host_files::seal(host.state.auth.lock_ok().host_key(), RAW_PROJECT, "a.txt").unwrap();
    let (status, _, body) = host.send(get_as(&format!("{base}/raw?f={host_token}&on=host"), &cookie)).await;
    assert_eq!((status, json(&body)["error"].clone()), (StatusCode::CONFLICT, json!("host_offline")), "{body}");
    // No mirror: the local side still has nothing.
    let (status, _, body) = host.send(get_as(&base, &cookie)).await;
    assert_eq!((status, json(&body)["error"].clone()), (StatusCode::NOT_FOUND, json!("files_unavailable")), "{body}");
}

/// A local project has no remote side to ask for.
#[tokio::test]
async fn a_local_project_has_no_remote_side_of_the_files() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(73)).await.0;
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "project_files": true } }).to_string(),
    )
    .unwrap();
    let (p, _) = project_and_tab(&host, &cookie).await;
    let (_, _, detail) = host.send(get_as(&format!("/api/v1/projects/{p}"), &cookie)).await;
    assert_eq!((json(&detail)["files"].as_bool(), json(&detail)["host_files"].as_bool()), (Some(true), Some(false)), "{detail}");
    let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{p}/files?on=host"), &cookie)).await;
    assert_eq!((status, json(&body)["error"].clone()), (StatusCode::NOT_FOUND, json!("files_unavailable")), "{body}");
}

#[tokio::test]
async fn upload_here_adds_a_new_file_to_a_plain_folder_and_undoes_only_it() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(38)).await.0;
    let (_, _, body) = host.send(get_as("/api/v1/projects?view=search&q=aurora", &cookie)).await;
    let project_id = json(&body)["projects"][0]["id"].as_str().expect("opaque project id").to_string();
    let base = format!("/api/v1/projects/{project_id}/files");
    std::fs::create_dir_all(host.root.join("docs")).unwrap();
    std::fs::create_dir_all(host.root.join(".github")).unwrap();
    let switches = |files: bool, uploads: bool| {
        std::fs::write(
            host.state.config.state_dir.join("settings.json"),
            json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "project_files": files, "project_uploads": uploads } }).to_string(),
        )
        .unwrap();
    };
    let upload = |query: &str, origin: &str, bytes: &[u8]| {
        Request::builder()
            .method("POST")
            .uri(format!("{base}/upload?{query}"))
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .body(Body::from(bytes.to_vec()))
            .expect("request")
    };
    let undo = |token: &str| request_as("DELETE", &format!("{base}/upload?f={token}"), &cookie, None);
    let refused = |answer: (StatusCode, HeaderMap, String)| (answer.0, json(&answer.2)["error"].clone());

    // Both switches off, then only the browser on: closed either way.
    switches(false, true);
    assert_eq!(refused(host.send(upload("name=a.pdf", ORIGIN, b"pdf")).await), (StatusCode::NOT_FOUND, json!("files_off")));
    switches(true, false);
    assert_eq!(refused(host.send(upload("name=a.pdf", ORIGIN, b"pdf")).await), (StatusCode::NOT_FOUND, json!("uploads_off")));
    let (_, _, body) = host.send(get_as(&base, &cookie)).await;
    assert_eq!(json(&body)["uploads"], false, "{body}");
    let tokens: HashMap<String, String> = json(&body)["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| (entry["name"].as_str().unwrap().to_string(), entry["token"].as_str().unwrap().to_string()))
        .collect();
    let (docs, github) = (&tokens["docs"], &tokens[".github"]);

    switches(true, true);
    let (_, _, body) = host.send(get_as(&format!("{base}?dir={docs}"), &cookie)).await;
    assert_eq!(json(&body)["uploads"], true, "{body}");
    let (_, _, body) = host.send(get_as(&base, &cookie)).await;
    assert_eq!(json(&body)["uploads"], true, "the root takes uploads: {body}");

    // Wrong origin: refused before anything is written.
    let answer = host.send(upload(&format!("dir={docs}&name=notes.pdf"), "https://elsewhere.example", b"pdf")).await;
    assert_eq!(refused(answer), (StatusCode::FORBIDDEN, json!("invalid_origin")));
    assert!(!host.root.join("docs").join("notes.pdf").exists());

    // A dot folder is listed but takes nothing; a forged folder is not one.
    let (_, _, body) = host.send(get_as(&format!("{base}?dir={github}"), &cookie)).await;
    assert_eq!(json(&body)["uploads"], false, "{body}");
    let answer = host.send(upload(&format!("dir={github}&name=ci.yml"), ORIGIN, b"on: push")).await;
    assert_eq!(refused(answer), (StatusCode::FORBIDDEN, json!("upload_refused")));
    assert!(!host.root.join(".github").join("ci.yml").exists());
    let answer = host.send(upload("dir=AAAA&name=notes.pdf", ORIGIN, b"pdf")).await;
    assert_eq!(refused(answer), (StatusCode::NOT_FOUND, json!("file_not_found")));
    assert_eq!(refused(host.send(upload(&format!("dir={docs}&name=e.pdf"), ORIGIN, b"")).await), (StatusCode::BAD_REQUEST, json!("empty_file")));

    // Lands under the phone's own name, answered as its listing row.
    let (status, _, body) = host.send(upload(&format!("dir={docs}&name=notes.pdf"), ORIGIN, b"%PDF-1.7")).await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    let file = json(&body)["file"].clone();
    assert_eq!(file["name"], "notes.pdf");
    assert!(!body.contains(RAW_PROJECT) && !body.contains(host.root.to_str().unwrap()) && !body.contains("docs/"), "{body}");
    assert_eq!(std::fs::read(host.root.join("docs").join("notes.pdf")).unwrap(), b"%PDF-1.7");
    let log = std::fs::read_to_string(host.state.config.state_dir.join("mobile-control").join(uploads::LOG_FILE)).unwrap();
    let line = json(log.lines().next().expect("one log line"));
    assert_eq!((line["project"].clone(), line["rel"].clone(), line["phone"].clone()), (json!(RAW_PROJECT), json!("docs/notes.pdf"), json!("Phone")));

    // A clash is never overwritten; no folder means the root.
    let (_, _, body) = host.send(upload(&format!("dir={docs}&name=notes.pdf"), ORIGIN, b"again")).await;
    assert_eq!(json(&body)["file"]["name"], "notes-2.pdf", "{body}");
    assert_eq!(std::fs::read(host.root.join("docs").join("notes.pdf")).unwrap(), b"%PDF-1.7");
    let (status, _, _) = host.send(upload("name=top.txt", ORIGIN, b"top")).await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(host.root.join("top.txt").is_file());

    // Undo deletes the logged file once; an edited one is kept.
    let token = file["token"].as_str().unwrap();
    let (status, _, body) = host.send(undo(token)).await;
    assert_eq!((status, json(&body)["undone"].clone()), (StatusCode::OK, json!(true)), "{body}");
    assert!(!host.root.join("docs").join("notes.pdf").exists());
    assert_eq!(refused(host.send(undo(token)).await), (StatusCode::NOT_FOUND, json!("file_not_found")));
    let (_, _, body) = host.send(get_as(&format!("{base}?dir={docs}"), &cookie)).await;
    let second = json(&body)["entries"][0].clone();
    assert_eq!(second["name"], "notes-2.pdf");
    std::fs::write(host.root.join("docs").join("notes-2.pdf"), b"edited").unwrap();
    assert_eq!(refused(host.send(undo(second["token"].as_str().unwrap())).await), (StatusCode::NOT_FOUND, json!("file_not_found")));
    assert!(host.root.join("docs").join("notes-2.pdf").exists());
    let wrong_origin = Request::builder()
        .method("DELETE")
        .uri(format!("{base}/upload?f={token}"))
        .header(header::ORIGIN, "https://elsewhere.example")
        .header(header::COOKIE, cookie_pair(&cookie))
        .body(Body::empty())
        .expect("request");
    assert_eq!(refused(host.send(wrong_origin).await), (StatusCode::FORBIDDEN, json!("invalid_origin")));

    // The switch off closes the undo too.
    switches(true, false);
    assert_eq!(refused(host.send(undo(token)).await), (StatusCode::NOT_FOUND, json!("uploads_off")));
}

#[tokio::test]
async fn annotate_appends_remarks_to_a_project_pdf_behind_its_own_switch() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(41)).await.0;
    let (_, _, body) = host.send(get_as("/api/v1/projects?view=search&q=aurora", &cookie)).await;
    let project_id = json(&body)["projects"][0]["id"].as_str().expect("opaque project id").to_string();
    let base = format!("/api/v1/projects/{project_id}/files");
    let pdf = crate::services::mobile_control::markup_pdf::tests::classic_pdf(&[0], false);
    std::fs::write(host.root.join("draft.pdf"), &pdf).unwrap();
    let switches = |files: bool, remarks: bool| {
        std::fs::write(
            host.state.config.state_dir.join("settings.json"),
            json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "project_files": files, "project_remarks": remarks } }).to_string(),
        )
        .unwrap();
    };
    switches(true, false);
    let (_, _, body) = host.send(get_as(&base, &cookie)).await;
    assert_eq!(json(&body)["remarks"], false, "{body}");
    let row = json(&body)["entries"].as_array().unwrap().iter().find(|e| e["name"] == "draft.pdf").expect("the PDF").clone();
    let token = row["token"].as_str().unwrap().to_string();
    let save = |origin: &str, size: u64, modified: u64| {
        let body = json!({ "size": size, "modified": modified, "pages": [{ "n": 1, "size": [600, 800], "marks": [
            { "kind": "box", "color": "yellow", "rect": [50, 60, 200, 14], "comment": "check" },
            { "kind": "text", "color": "black", "at": [300, 400], "size": 12, "text": "a remark" }
        ] }] });
        Request::builder()
            .method("POST")
            .uri(format!("{base}/remarks?f={token}"))
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .body(Body::from(body.to_string()))
            .expect("request")
    };
    let refused = |answer: (StatusCode, HeaderMap, String)| (answer.0, json(&answer.2)["error"].clone());
    let (size, modified) = (row["size"].as_u64().unwrap(), row["modified"].as_u64().unwrap());

    assert_eq!(refused(host.send(save(ORIGIN, size, modified)).await), (StatusCode::NOT_FOUND, json!("remarks_off")));
    switches(false, true);
    assert_eq!(refused(host.send(save(ORIGIN, size, modified)).await), (StatusCode::NOT_FOUND, json!("files_off")));
    switches(true, true);
    let (_, _, body) = host.send(get_as(&base, &cookie)).await;
    assert_eq!(json(&body)["remarks"], true, "{body}");
    assert_eq!(refused(host.send(save("https://elsewhere.example", size, modified)).await), (StatusCode::FORBIDDEN, json!("invalid_origin")));
    assert_eq!(refused(host.send(save(ORIGIN, size + 1, modified)).await), (StatusCode::CONFLICT, json!("file_changed")));
    assert_eq!(std::fs::read(host.root.join("draft.pdf")).unwrap(), pdf, "nothing written before the save");

    let (status, _, body) = host.send(save(ORIGIN, size, modified)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let after = std::fs::read(host.root.join("draft.pdf")).unwrap();
    assert!(after.starts_with(&pdf) && after.len() > pdf.len());
    assert_eq!(json(&body)["file"]["size"].as_u64(), Some(after.len() as u64), "the fresh row: {body}");
    assert!(!body.contains(host.root.to_str().unwrap()), "{body}");
    // The read the phone did is stale now: a second save of it is refused.
    assert_eq!(refused(host.send(save(ORIGIN, size, modified)).await), (StatusCode::CONFLICT, json!("file_changed")));
}

/// The route's own body limit outranks the router's control-message one:
/// a file past `MAX_CONTROL_MESSAGE` lands, one past `MAX_INBOX_FILE` is
/// refused before the handler runs.
#[tokio::test]
async fn upload_here_takes_a_whole_file_up_to_the_inbox_limit() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(39)).await.0;
    let (_, _, body) = host.send(get_as("/api/v1/projects?view=search&q=aurora", &cookie)).await;
    let project_id = json(&body)["projects"][0]["id"].as_str().expect("opaque project id").to_string();
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "project_files": true, "project_uploads": true } }).to_string(),
    )
    .unwrap();
    let upload = |name: &str, bytes: Vec<u8>| {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/{project_id}/files/upload?name={name}"))
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(&cookie))
            .body(Body::from(bytes))
            .expect("request")
    };
    let (status, _, body) = host.send(upload("big.bin", vec![7; MAX_CONTROL_MESSAGE + 1])).await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    assert_eq!(std::fs::metadata(host.root.join("big.bin")).unwrap().len(), (MAX_CONTROL_MESSAGE + 1) as u64);
    let (status, ..) = host.send(upload("huge.bin", vec![7; inbox::MAX_INBOX_FILE + 1])).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!host.root.join("huge.bin").exists());
}

#[tokio::test]
async fn only_the_pdf_frame_may_be_framed_and_only_by_the_pwa() {
    let host = Fixture::bare();
    let request = Request::builder()
        .uri(PDF_FRAME_PATH)
        .header(header::HOST, "phone.example.ts.net")
        .body(Body::empty())
        .unwrap();
    let (status, headers, _) = host.send(request).await;
    if status == StatusCode::OK {
        assert_eq!(headers[header::X_FRAME_OPTIONS], "SAMEORIGIN");
        let policy = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_string();
        assert!(policy.contains("default-src 'none'"), "{policy}");
        assert!(policy.contains("connect-src 'none'"), "{policy}");
        assert!(policy.contains("frame-ancestors 'self' https://phone.example.ts.net"), "{policy}");
        assert!(!policy.contains("wasm-unsafe-eval") && !policy.contains("unsafe-eval"), "{policy}");
    } else {
        // A bundle built without the frame: a plain miss, never the shell
        // under a framable policy.
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY");
    }
    for uri in ["/", "/index.html", "/pdf-frame.html/x", "/assets/pdf-frame.js", "/api/v1/status"] {
        let (_, headers, _) = host.send(get_request(uri)).await;
        assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY", "{uri}");
        assert!(headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("frame-ancestors 'none'"), "{uri}");
    }
    // A host header that is not a host name is left out of the policy.
    let forged = HeaderValue::from_static("evil.example; script-src *");
    assert!(!pdf_frame_policy(Some(&forged)).contains("evil"));
    assert!(pdf_frame_policy(None).contains("script-src 'self';"));
}

#[tokio::test]
async fn a_markup_submit_bakes_a_copy_into_the_inbox_and_answers_a_prompt() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(63)).await.0;
    let tab_id = fixture_tab_id(&host, &cookie).await;
    let (_, _, body) = host.send(get_as("/api/v1/projects?view=search&q=aurora", &cookie)).await;
    let project_id = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
    std::fs::create_dir_all(host.root.join("docs")).unwrap();
    let pdf = super::super::markup_pdf::tests::classic_pdf(&[0, 90], false);
    std::fs::write(host.root.join("docs/draft.pdf"), &pdf).unwrap();
    let before = std::fs::metadata(host.root.join("docs/draft.pdf")).unwrap().modified().unwrap();
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-layer".to_vec();
    let (status, _, body) = host.send(inbox_request(&tab_id, "draft-p2-layer.png", &cookie, png)).await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    let layer = json(&body)["attachment"]["reference"].as_str().unwrap().to_string();
    let submit = |origin: &str, body: Vec<u8>| {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/tabs/{tab_id}/markup"))
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap()
    };
    let marks = serde_json::json!([{ "kind": "ink", "color": "red", "width": 2, "points": [[10, 10, 0.5], [40, 30, 0.7]] },
        { "kind": "text", "color": "blue", "at": [20, 50], "size": 14, "text": "smaller" }]);
    let request_for = |source: Value| serde_json::to_vec(&serde_json::json!({
        "source": source,
        "pages": [{ "n": 2, "size": [800, 600], "layer": layer, "marks": marks }],
    })).unwrap();

    // The file browser's switch gates a file source, as it gates reading.
    let (status, _, body) = host.send(submit(ORIGIN, request_for(serde_json::json!({ "files": "AAAA" })))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    assert_eq!(json(&body)["error"], "files_off");
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }).to_string(),
    )
    .unwrap();
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/files"), &cookie)).await;
    let docs = json(&body)["entries"].as_array().unwrap().iter()
        .find(|entry| entry["name"] == "docs").unwrap()["token"].as_str().unwrap().to_string();
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/files?dir={docs}"), &cookie)).await;
    let token = json(&body)["entries"][0]["token"].as_str().unwrap().to_string();

    let (status, _, body) = host.send(submit(ORIGIN, request_for(serde_json::json!({ "files": token })))).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let answer = json(&body);
    let prompt = answer["prompt"].as_str().unwrap();
    let marked = answer["marked"].as_str().unwrap();
    assert!(prompt.starts_with("I marked these changes by hand on `docs/draft.pdf`."), "{prompt}");
    assert!(prompt.contains(&format!("Page 2: @{layer}")), "{prompt}");
    assert!(prompt.contains("- p2: blue note \"smaller\""), "{prompt}");
    assert!(marked.starts_with(concat!(".", crate::app_slug!(), "/inbox/")) && marked.ends_with("-draft-marked.pdf"), "{marked}");
    assert!(!body.contains(&host.root.to_string_lossy().to_string()), "a filesystem path leaked: {body}");
    let copy = std::fs::read(host.root.join(marked)).unwrap();
    assert!(copy.starts_with(&pdf) && copy.len() > pdf.len());
    assert_eq!(std::fs::read(host.root.join("docs/draft.pdf")).unwrap(), pdf, "the source is never written");
    assert_eq!(std::fs::metadata(host.root.join("docs/draft.pdf")).unwrap().modified().unwrap(), before);

    // A forged token, an outbox leaf with a separator, a bad origin and an
    // oversized body are all refused before anything is written.
    let (status, _, body) = host.send(submit(ORIGIN, request_for(serde_json::json!({ "files": "AAAA" })))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    assert_eq!(json(&body)["error"], "file_not_found");
    for leaf in ["../draft.pdf", "a/b.pdf", ".hidden.pdf"] {
        let (status, _, body) = host.send(submit(ORIGIN, request_for(serde_json::json!({ "outbox": leaf })))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{leaf} answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_markup");
    }
    let (status, ..) = host.send(submit("https://elsewhere.example", request_for(serde_json::json!({ "files": token })))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, ..) = host.send(submit(ORIGIN, vec![b' '; markup::MAX_MARKUP_BODY + 1])).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    let (status, _, body) = host.send(submit(ORIGIN, b"{\"source\":1}".to_vec())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    let inbox: Vec<_> = std::fs::read_dir(host.root.join(inbox::INBOX_DIR)).unwrap().flatten().collect();
    assert_eq!(inbox.len(), 2, "the layer and one marked copy");
}

/// **Apply marks directly** over the wire: an `apply` Submit in a git
/// project answers an undo id; settle, preview and undo answer
/// project-relative names only; a forged id or tab is not found, a
/// foreign origin refused, and nothing raw crosses.
#[tokio::test]
async fn an_apply_submit_answers_an_undo_the_phone_can_settle_preview_and_run() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(64)).await.0;
    let tab_id = fixture_tab_id(&host, &cookie).await;
    let (_, _, body) = host.send(get_as("/api/v1/projects?view=search&q=aurora", &cookie)).await;
    let project_id = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
    std::fs::create_dir_all(host.root.join("docs")).unwrap();
    std::fs::write(host.root.join("docs/draft.pdf"), super::super::markup_pdf::tests::classic_pdf(&[0], false)).unwrap();
    std::fs::write(host.root.join("docs/draft.tex"), "teh cat\n").unwrap();
    for args in [&["init", "-q"][..], &["add", "-A"], &["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "i"]] {
        let mut git = std::process::Command::new("git");
        for name in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"] {
            git.env_remove(name);
        }
        assert!(git.args(args).current_dir(&host.root).output().unwrap().status.success(), "git {args:?}");
    }
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }).to_string(),
    )
    .unwrap();
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/files"), &cookie)).await;
    let docs = json(&body)["entries"].as_array().unwrap().iter()
        .find(|entry| entry["name"] == "docs").unwrap()["token"].as_str().unwrap().to_string();
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/files?dir={docs}"), &cookie)).await;
    let token = json(&body)["entries"].as_array().unwrap().iter()
        .find(|entry| entry["name"] == "draft.pdf").unwrap()["token"].as_str().unwrap().to_string();
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-layer".to_vec();
    let (_, _, body) = host.send(inbox_request(&tab_id, "draft-p1-layer.png", &cookie, png)).await;
    let layer = json(&body)["attachment"]["reference"].as_str().unwrap().to_string();
    let call = |method: &str, uri: String, origin: &str| {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(if method == "POST" { b"{}".to_vec() } else { Vec::new() }))
            .unwrap()
    };
    let submit = serde_json::json!({
        "source": { "files": token },
        "pages": [{ "n": 1, "size": [600, 800], "layer": layer, "marks": [{ "kind": "box", "color": "red", "rect": [1, 1, 5, 5] }] }],
        "mode": "apply",
    });
    let mut request = call("POST", format!("/api/v1/tabs/{tab_id}/markup"), ORIGIN);
    *request.body_mut() = Body::from(serde_json::to_vec(&submit).unwrap());
    let (status, _, body) = host.send(request).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let answer = json(&body);
    assert_eq!((answer["mode"].as_str(), answer["noUndo"].as_str()), (Some("apply"), None), "{body}");
    let undo = answer["undo"].as_str().unwrap().to_string();
    assert!(markup_rounds::valid_id(&undo));

    // The agent's turn.
    std::fs::write(host.root.join("docs/draft.tex"), "the cat\n").unwrap();
    let base = format!("/api/v1/tabs/{tab_id}/markup/undo/{undo}");
    let (status, _, body) = host.send(call("POST", format!("{base}/settle"), "https://elsewhere.example")).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
    let (status, _, body) = host.send(call("POST", format!("{base}/settle"), ORIGIN)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let (status, _, body) = host.send(get_as(&base, &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["files"], serde_json::json!([{ "path": "docs/draft.tex", "change": "modified" }]), "{body}");
    for leak in [host.root.to_string_lossy().to_string(), RAW_PROJECT.to_string()] {
        assert!(!body.contains(&leak), "{leak} leaked: {body}");
    }

    // Forged ids and tabs, and a foreign origin on the undo itself.
    for uri in [
        format!("/api/v1/tabs/{tab_id}/markup/undo/{}", "0".repeat(32)),
        format!("/api/v1/tabs/{tab_id}/markup/undo/..%2F..%2Fsecrets"),
        format!("/api/v1/tabs/nope/markup/undo/{undo}"),
    ] {
        let (status, _, body) = host.send(call("POST", uri.clone(), ORIGIN)).await;
        assert!(matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE), "{uri} answered {status}: {body}");
    }
    let (status, ..) = host.send(call("POST", base.clone(), "https://elsewhere.example")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(std::fs::read_to_string(host.root.join("docs/draft.tex")).unwrap(), "the cat\n", "nothing undone yet");

    let (status, _, body) = host.send(call("POST", base.clone(), ORIGIN)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(std::fs::read_to_string(host.root.join("docs/draft.tex")).unwrap(), "teh cat\n");
    let (status, _, body) = host.send(call("POST", base, ORIGIN)).await;
    assert_eq!(status, StatusCode::GONE, "undone once: {body}");
    assert_eq!(json(&body)["error"], "undo_gone");
}

/// The markup questions routes on a desktop's Mobile host: with no window, a quiet
/// `desktop_unavailable` (the phone shows no card); with one, the view's
/// source goes to the desktop as a project-relative path, the asks come
/// back with a bare leaf name and nothing else of the path, and an answer
/// crosses as indices and typed text only — shaped here before it goes.
#[cfg(unix)]
#[tokio::test]
async fn markup_questions_cross_as_leaf_names_and_answers_as_indices() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(64)).await.0;
    let (_, tab_id) = project_and_tab(&host, &cookie).await;
    let questions = format!("/api/v1/tabs/{tab_id}/markup/questions");
    let answer_uri = format!("/api/v1/tabs/{tab_id}/markup/answer");
    let dismiss_uri = format!("/api/v1/tabs/{tab_id}/markup/dismiss");
    let ask = "ask-0123456789abcdef";
    let good = json!({ "ask_id": ask, "answers": [{ "options": [1] }, { "options": [0, 2], "other": "both" }] });

    // No window: no asks to read, nothing to answer.
    let (status, _, body) = host.send(get_as(&questions, &cookie)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
    assert_eq!(json(&body)["error"], "desktop_unavailable");
    let (status, _, body) = host.send(request_as("POST", &answer_uri, &cookie, Some(good.clone()))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");

    // Refused before the desktop is asked.
    let outbox_leaf = "20261003-101500-draft.pdf";
    for (uri, code) in [
        (format!("{questions}?source=elsewhere:x"), "invalid_source"),
        (format!("{questions}?source=outbox:..%2Fdraft.pdf"), "invalid_source"),
        (format!("{questions}?source=files:"), "invalid_source"),
        (format!("{questions}?source=files:AAAA"), "files_off"),
    ] {
        let (status, _, body) = host.send(get_as(&uri, &cookie)).await;
        assert!(status.is_client_error(), "{uri} answered {status}: {body}");
        assert_eq!(json(&body)["error"], code, "{uri}");
    }
    for (bad, code) in [
        (json!({ "ask_id": "held-1", "answers": [{ "options": [0] }] }), "invalid_request"),
        (json!({ "ask_id": ask, "answers": [{ "options": [0] }], "prompt": "typed here" }), "invalid_request"),
        (json!({ "ask_id": ask, "answers": [] }), "invalid_answer"),
        (json!({ "ask_id": ask, "answers": [{ "options": [6] }] }), "invalid_answer"),
        (json!({ "ask_id": ask, "answers": [{ "options": [], "other": "a\nb" }] }), "invalid_answer"),
        (json!({ "ask_id": ask, "answers": [{ "other": "x".repeat(501) }] }), "invalid_answer"),
        (json!({ "ask_id": ask, "answers": vec![json!({ "options": [0] }); 5] }), "invalid_answer"),
    ] {
        let (status, _, body) = host.send(request_as("POST", &answer_uri, &cookie, Some(bad.clone()))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad} answered: {body}");
        assert_eq!(json(&body)["error"], code, "{bad}");
    }
    let mut foreign = request_as("POST", &answer_uri, &cookie, Some(good.clone()));
    foreign.headers_mut().insert(header::ORIGIN, HeaderValue::from_static("https://elsewhere.example"));
    let (status, ..) = host.send(foreign).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let socket = host.state.config.control_dir.join("desktop-control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
    let seen: Arc<Mutex<Vec<DesktopRequest>>> = Arc::default();
    let log = seen.clone();
    let desktop = tokio::spawn(async move {
        let mut answered = 0;
        while answered < 6 {
            let (mut stream, _) = listener.accept().await.expect("accept");
            // A reachability probe connects and sends nothing.
            let Ok(request) = admin::read_frame::<DesktopRequest>(&mut stream).await else {
                continue;
            };
            let response: DesktopResponse = match &request {
                DesktopRequest::MarkupQuestions { .. } => serde_json::from_value(json!({
                    "status": "markup_questions",
                    "asks": [
                        { "id": ask, "path": "docs/paper/draft.pdf", "file_name": "docs/paper/20261003-101500-draft.pdf",
                          "questions": [{ "question": "Figure or paragraph?", "options": [{ "label": "Figure" }, { "label": "Paragraph" }], "page": 2, "quote": "Figure 2" }] },
                        { "id": "not-an-ask-id", "questions": [] },
                    ],
                    "ticks": [
                        { "round": "k3x9a0b1", "page": 2, "mark": 1, "file": "docs/paper/draft.pdf" },
                        { "round": "k3x9a0b1", "page": 3, "mark": 2 },
                        { "round": "NOT-A-ROUND", "page": 1, "mark": 1 },
                        { "round": "k3x9a0b1", "page": 0, "mark": 1 },
                        { "round": "k3x9a0b1", "page": 1, "mark": 0 },
                    ],
                }))
                .expect("asks"),
                DesktopRequest::MarkupAnswer { .. } if answered == 3 => DesktopResponse::Error { code: "superseded".into(), message: "replaced".into() },
                DesktopRequest::MarkupAnswer { .. } | DesktopRequest::MarkupDismiss { .. } => DesktopResponse::Seen,
                other => panic!("unexpected request {other:?}"),
            };
            log.lock().unwrap().push(request);
            admin::write_frame(&mut stream, &response).await.expect("answer");
            answered += 1;
        }
    });

    let (status, _, body) = host.send(get_as(&format!("{questions}?source=outbox:{outbox_leaf}"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let asks = json(&body)["asks"].clone();
    assert_eq!(asks.as_array().unwrap().len(), 1, "the malformed id is dropped: {body}");
    assert_eq!(asks[0]["file_name"], "draft.pdf");
    assert_eq!(asks[0]["questions"][0]["page"], 2);
    assert_eq!(
        json(&body)["ticks"],
        json!([{ "round": "k3x9a0b1", "page": 2, "mark": 1 }, { "round": "k3x9a0b1", "page": 3, "mark": 2 }]),
        "malformed ticks are dropped, nothing but round, page and mark crosses"
    );
    assert!(!body.contains("docs/") && !body.contains("\"file\"") && !body.contains(RAW_PROJECT), "{body}");
    // The Focus banner, drawer off: no row, and still no path.
    let (status, _, body) = host.send(get_as(&questions, &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert!(json(&body)["asks"][0].get("file_row").is_none(), "{body}");
    assert!(!body.contains("docs/") && !body.contains("\"path\""), "{body}");

    let (status, _, body) = host.send(request_as("POST", &answer_uri, &cookie, Some(good.clone()))).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["answered"], true);
    let (status, _, body) = host.send(request_as("POST", &answer_uri, &cookie, Some(good))).await;
    assert_eq!(status, StatusCode::CONFLICT, "answered: {body}");
    assert_eq!(json(&body)["error"], "superseded");
    let (status, _, body) = host.send(request_as("POST", &dismiss_uri, &cookie, Some(json!({ "ask_id": ask })))).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["dismissed"], true);

    // Drawer on, the file there: the banner gets its sealed row — the
    // folder trail and tokens, never the path or the root.
    std::fs::create_dir_all(host.root.join("docs/paper")).unwrap();
    std::fs::write(host.root.join("docs/paper/draft.pdf"), b"%PDF-1.4\n%%EOF\n").unwrap();
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }).to_string(),
    )
    .unwrap();
    let (status, _, body) = host.send(get_as(&questions, &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let file = json(&body)["asks"][0]["file_row"].clone();
    assert_eq!(file["name"], "draft.pdf", "{body}");
    assert_eq!(file["place"], "docs/paper");
    assert_eq!(file["kind"], "application/pdf");
    let key = host.state.auth.lock().unwrap().host_key().to_vec();
    assert_eq!(files::unseal(&key, RAW_PROJECT, file["token"].as_str().unwrap()).as_deref(), Some("docs/paper/draft.pdf"));
    assert_eq!(files::unseal(&key, RAW_PROJECT, file["folder"].as_str().unwrap()).as_deref(), Some("docs/paper"));
    assert!(!body.contains("\"path\"") && !body.contains(RAW_PROJECT) && !body.contains(host.root.to_str().unwrap()), "{body}");
    desktop.await.expect("fake desktop");

    let seen = seen.lock().unwrap();
    let DesktopRequest::MarkupQuestions { project_id, path, .. } = &seen[0] else { panic!("{:?}", seen[0]) };
    assert_eq!(project_id, RAW_PROJECT);
    assert_eq!(path.as_deref(), Some(format!("{}/{outbox_leaf}", outbox::OUTBOX_DIR).as_str()));
    assert!(matches!(&seen[1], DesktopRequest::MarkupQuestions { path: None, .. }));
    let DesktopRequest::MarkupAnswer { ask_id, answers, .. } = &seen[2] else { panic!("{:?}", seen[2]) };
    assert_eq!(ask_id, ask);
    assert_eq!(answers[1].options, vec![0, 2]);
    assert_eq!(answers[1].other.as_deref(), Some("both"));
    assert!(matches!(&seen[4], DesktopRequest::MarkupDismiss { .. }));
}

/// A server daemon has no window: it serves the markup lane itself, so
/// the phone's markup requests read and answer this process's asks
/// (`markup_here`), never a desktop socket. The asks cross as the
/// window's bridge builds them (the path for the Focus banner only), an
/// answer is held for the tab as a phone prompt is, and a closed ask is
/// refused with its code.
#[cfg(unix)]
#[tokio::test]
async fn a_server_daemon_answers_markup_from_its_own_asks() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(66)).await.0;
    let (_, tab_id) = project_and_tab(&host, &cookie).await;
    let mut tab = catalog_unfiltered(&host.state).expect("catalog").tab(&tab_id).expect("the tab").1.clone();
    let target = "t-server-markup";
    tab.schedule_target_id = Some(target.into());
    let ask = crate::services::markup_mcp::test_open_ask(
        "server-markup",
        RAW_PROJECT,
        target,
        json!([{ "question": "Which word?", "header": "Word", "page": 2, "quote": "the lede",
                 "options": [{ "label": "lead" }, { "label": "lede", "description": "as written" }] }]),
    );
    let mut state = host.state.clone();
    state.web = state.web.behind_gateway(web_client::ServerLink {
        public_host: "server.example".into(),
        content_origin: None,
        auth: state.auth.clone(),
    });
    let rid = || "r".to_string();
    let list = DesktopRequest::MarkupQuestions { request_id: rid(), project_id: RAW_PROJECT.into(), tmux_session: tab.tmux_name.clone(), path: None };
    let Ok(DesktopResponse::MarkupQuestions { asks, ticks }) = markup_call(&state, list, &tab).await else { panic!("the daemon answers") };
    assert!(ticks.is_empty());
    assert_eq!(asks.len(), 1);
    assert_eq!(asks[0].id, ask);
    let question = &asks[0].questions[0];
    assert_eq!((question.header.as_deref(), question.page, question.quote.as_deref()), (Some("Word"), Some(2), Some("the lede")));
    assert_eq!(question.options[1].description.as_deref(), Some("as written"));
    // Without the server link the same request goes to a window, and
    // there is none: the desktop's quiet `desktop_unavailable`.
    let desktop = DesktopRequest::MarkupQuestions { request_id: rid(), project_id: RAW_PROJECT.into(), tmux_session: tab.tmux_name.clone(), path: None };
    let refused = markup_call(&host.state, desktop, &tab).await.expect_err("no window");
    assert_eq!(refused.0, StatusCode::SERVICE_UNAVAILABLE);

    let answer = DesktopRequest::MarkupAnswer {
        request_id: rid(),
        project_id: RAW_PROJECT.into(),
        tmux_session: tab.tmux_name.clone(),
        ask_id: ask.clone(),
        answers: vec![super::super::protocol::MobileMarkupAnswer { options: vec![1], other: None }],
        device_id: Some("phone-1".into()),
    };
    assert!(matches!(markup_call(&state, answer.clone(), &tab).await, Ok(DesktopResponse::Seen)));
    let held = crate::services::agent_tasks::list_at(&state.config.state_dir, RAW_PROJECT, target).expect("the tab's rules");
    assert_eq!(held.len(), 1, "the answer's prompt is held for the tab");
    assert!(held[0].message.contains("lede"), "{}", held[0].message);
    assert_eq!(held[0].phone_device.as_deref(), Some("phone-1"));
    assert!(state.holds.due(&held[0].id), "typed at once, as a phone hold");
    let again = markup_call(&state, answer, &tab).await.expect_err("answered once");
    assert_eq!((refused_code(&again), again.0), ("answered".to_string(), StatusCode::CONFLICT));
    let dismiss = DesktopRequest::MarkupDismiss { request_id: rid(), project_id: RAW_PROJECT.into(), tmux_session: tab.tmux_name.clone(), ask_id: ask };
    assert!(matches!(markup_call(&state, dismiss, &tab).await, Ok(DesktopResponse::Seen)), "dismissing a closed ask is idempotent");

    // The phone's Local models on a server: the administrator's phone
    // only (§3.3), by the gateway's role header.
    std::fs::write(state.config.state_dir.join("settings.json"), json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true } }).to_string()).unwrap();
    let role = |role: Option<&str>| {
        let mut headers = HeaderMap::new();
        if let Some(role) = role {
            headers.insert(crate::services::server::ROLE_HEADER, role.parse().unwrap());
        }
        headers
    };
    assert!(!local_models_closed(&host.state, &role(None)), "a desktop with the switch on");
    assert!(!local_models_closed(&host.state, &role(Some("user"))), "a desktop has no roles");
    assert!(local_models_closed(&state, &role(None)), "behind the gateway, no role is a user");
    assert!(local_models_closed(&state, &role(Some("user"))));
    assert!(!local_models_closed(&state, &role(Some("admin"))), "the administrator's phone");

    // A tab with no schedule target has no asks to read.
    tab.schedule_target_id = None;
    let list = DesktopRequest::MarkupQuestions { request_id: rid(), project_id: RAW_PROJECT.into(), tmux_session: tab.tmux_name.clone(), path: None };
    let none = markup_call(&state, list, &tab).await.expect_err("no target");
    assert_eq!(refused_code(&none), "tab_not_found");
}

#[cfg(unix)]
fn refused_code(refusal: &ApiRefusal) -> String {
    refusal.1["error"].as_str().unwrap_or_default().to_string()
}

/// Local models from the phone: the switch and every refusal the sidecar
/// owns answer before the desktop is asked (a pull never reaches it), no
/// window is `desktop_unavailable` with no headless answer, the window's
/// list is rebuilt before it crosses, and a refusal crosses as its code.
#[cfg(unix)]
#[tokio::test]
async fn local_models_go_through_the_window_and_a_pull_never_does() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(65)).await.0;
    let uri = "/api/v1/local-models";
    let settings = host.state.config.state_dir.join("settings.json");
    let switch = |local_models: Option<bool>| {
        let mut mobile = json!({ "enabled": true });
        if let Some(on) = local_models {
            mobile["local_models"] = json!(on);
        }
        std::fs::write(&settings, json!({ crate::brand::MOBILE_HOST_KEY: mobile }).to_string()).unwrap();
    };
    let post = |body: Value| request_as("POST", uri, &cookie, Some(body));
    let load = json!({ "action": "load", "model": "llama3" });

    // No settings at all: closed.
    let (status, _, body) = host.send(get_as(uri, &cookie)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
    assert_eq!(json(&body)["error"], "local_models_disabled");

    // Unset is on; no window → open the app, never a headless list.
    switch(None);
    let (status, _, body) = host.send(get_as(uri, &cookie)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
    assert_eq!(json(&body)["error"], "desktop_unavailable");
    let (status, _, body) = host.send(post(load.clone())).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
    assert_eq!(json(&body)["error"], "desktop_unavailable");

    let socket = host.state.config.control_dir.join("desktop-control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
    let seen: Arc<Mutex<Vec<DesktopRequest>>> = Arc::default();
    let log = seen.clone();
    let list = |server: &str| -> DesktopResponse {
        serde_json::from_value(json!({
            "status": "local_models",
            "server": server,
            "can_start": false,
            "start_failed": false,
            "path": "/home/someone/.ollama",
            "models": [
                { "name": "qwen3.5:9b", "size": 6594474711u64, "parameter_size": "9B", "quantization": "Q4_K_M",
                  "state": "loaded", "loaded_size": 7100000000u64, "vram": 3550000000u64, "pinned": true,
                  "expires_in": null, "for_tabs": true, "remote": false, "digest": "sha256:feed",
                  "path": "/home/someone/.ollama/models/blobs" },
                { "name": "../escape", "state": "idle" },
                { "name": "llama3:latest", "size": 1, "state": "warming", "loaded_size": 9 },
            ],
        }))
        .expect("list")
    };
    let desktop = tokio::spawn(async move {
        for _ in 0..7 {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let Ok(request) = admin::read_frame::<DesktopRequest>(&mut stream).await else {
                continue;
            };
            let refuse = |code: &str| DesktopResponse::Error {
                code: code.into(),
                message: "not_running at /home/someone/.ollama: secret prose".into(),
            };
            let response = match &request {
                DesktopRequest::LocalModelMutate { action: LocalModelAction::Unload { model }, .. } if model == "gone:1" => {
                    refuse("model_not_installed")
                }
                DesktopRequest::LocalModelMutate { action: LocalModelAction::Unload { model }, .. } if model == "busy:1" => {
                    refuse("model_loading")
                }
                DesktopRequest::LocalModelMutate { action: LocalModelAction::Load { model }, .. } if model == "odd:1" => {
                    refuse("Error: /home/someone/.ollama refused")
                }
                DesktopRequest::LocalModelMutate { action: LocalModelAction::Start, .. } => list("starting"),
                _ => list("running"),
            };
            log.lock().unwrap().push(request);
            admin::write_frame(&mut stream, &response).await.expect("answer");
        }
    });

    // Switched off: refused here, for both verbs, with the window open.
    switch(Some(false));
    let (status, _, body) = host.send(get_as(uri, &cookie)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
    assert_eq!(json(&body)["error"], "local_models_disabled");
    let (status, _, body) = host.send(post(load.clone())).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
    assert_eq!(json(&body)["error"], "local_models_disabled");

    // On again: what the sidecar refuses never reaches the window either.
    switch(Some(true));
    for (bad, code) in [
        (json!({ "action": "pull", "model": "llama3" }), "unsupported_action"),
        (json!({ "action": "delete", "model": "llama3" }), "unsupported_action"),
        (json!({ "action": "start", "model": "llama3" }), "invalid_request"),
        (json!({ "action": "load", "model": "a b" }), "invalid_request"),
        (json!({ "action": "load" }), "invalid_request"),
    ] {
        let (status, _, body) = host.send(post(bad.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad} answered: {body}");
        assert_eq!(json(&body)["error"], code, "{bad}");
    }
    let mut not_json = post(json!({}));
    *not_json.body_mut() = Body::from("{\"action\":");
    let (status, _, body) = host.send(not_json).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    let mut foreign = post(load.clone());
    foreign.headers_mut().insert(header::ORIGIN, HeaderValue::from_static("https://elsewhere.example"));
    let (status, _, body) = host.send(foreign).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
    assert_eq!(json(&body)["error"], "invalid_origin");
    let (status, _, body) = host.send(post_json(uri, ORIGIN, &load)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
    // No route below it: not the shell, not a write.
    let (status, ..) = host.send(get_as("/api/v1/local-models/pull", &cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, ..) = host.send(request_as("POST", "/api/v1/local-models/pull", &cookie, Some(load.clone()))).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(seen.lock().unwrap().is_empty(), "the window was asked: {:?}", seen.lock().unwrap());

    // The list, rebuilt: the bad name gone, the unknown state idle,
    // residency only on the loaded row, no field the phone was not given.
    let (status, _, body) = host.send(get_as(uri, &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let list = json(&body);
    assert_eq!(list["server"], "running");
    let models = list["models"].as_array().unwrap();
    assert_eq!(models.len(), 2, "{body}");
    assert_eq!(models[0]["name"], "qwen3.5:9b");
    assert_eq!(models[0]["vram"], 3_550_000_000u64);
    assert_eq!(models[0]["pinned"], true);
    assert_eq!(models[1]["state"], "idle");
    assert!(models[1].get("loaded_size").is_none(), "{body}");
    assert!(!body.contains("/home") && !body.contains("path") && !body.contains("digest") && !body.contains("escape"), "{body}");

    // A load and a start answer at once (202); an unload is done (200).
    let (status, _, body) = host.send(post(load.clone())).await;
    assert_eq!(status, StatusCode::ACCEPTED, "answered: {body}");
    assert_eq!(json(&body)["models"].as_array().unwrap().len(), 2);
    let (status, _, body) = host.send(post(json!({ "action": "unload", "model": "gone:1" }))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    assert_eq!(json(&body), json!({ "error": "model_not_installed" }));
    let (status, _, body) = host.send(post(json!({ "action": "unload", "model": "busy:1" }))).await;
    assert_eq!(status, StatusCode::CONFLICT, "answered: {body}");
    assert_eq!(json(&body)["error"], "model_loading");
    let (status, _, body) = host.send(post(json!({ "action": "start" }))).await;
    assert_eq!(status, StatusCode::ACCEPTED, "answered: {body}");
    assert_eq!(json(&body)["server"], "starting");
    let (status, _, body) = host.send(post(json!({ "action": "unload", "model": "qwen3.5:9b" }))).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    // A code this feature does not define becomes a fixed one.
    let (status, _, body) = host.send(post(json!({ "action": "load", "model": "odd:1" }))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "answered: {body}");
    assert_eq!(json(&body), json!({ "error": "desktop_error" }));
    desktop.await.expect("fake desktop");

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 7, "{seen:?}");
    assert!(matches!(&seen[0], DesktopRequest::LocalModels { .. }));
    assert!(matches!(
        &seen[1],
        DesktopRequest::LocalModelMutate { action: LocalModelAction::Load { model }, .. } if model == "llama3"
    ));
    assert!(matches!(&seen[4], DesktopRequest::LocalModelMutate { action: LocalModelAction::Start, .. }));
    assert!(matches!(
        &seen[5],
        DesktopRequest::LocalModelMutate { action: LocalModelAction::Unload { model }, .. } if model == "qwen3.5:9b"
    ));
}

/// The browser's own PDF viewer fetches without the strict session cookie;
/// a ticket minted over the session opens that one URL and nothing else.
#[tokio::test]
async fn an_open_ticket_reads_its_one_file_without_the_cookie() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(36)).await.0;
    let (_, _, body) = host
        .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
        .await;
    let project_id = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
    let base = format!("/api/v1/projects/{project_id}/files");
    std::fs::write(host.root.join("paper.pdf"), "%PDF-1.7\n%%EOF\n").unwrap();
    std::fs::write(host.root.join("other.pdf"), "%PDF-1.7\n%%EOF\n").unwrap();
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }).to_string(),
    )
    .unwrap();
    let (_, _, body) = host.send(get_as(&base, &cookie)).await;
    let token_of = |name: &str| {
        json(&body)["entries"].as_array().unwrap().iter()
            .find(|entry| entry["name"] == name).unwrap()["token"].as_str().unwrap().to_string()
    };
    let (paper, other) = (token_of("paper.pdf"), token_of("other.pdf"));
    let url = format!("{base}/raw?f={paper}");
    let mint = |origin: &str, cookie: &str, url: &str| Request::builder()
        .method("POST")
        .uri("/api/v1/open-ticket")
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, cookie_pair(cookie))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({ "url": url }).to_string()))
        .unwrap();

    let (status, _, body) = host.send(mint(ORIGIN, &cookie, &url)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let opened = json(&body)["url"].as_str().unwrap().to_string();
    assert!(opened.starts_with(&format!("{url}&ticket=")), "{opened}");
    let anonymous = |uri: &str| Request::builder().uri(uri).body(Body::empty()).unwrap();
    let (status, headers, body) = host.send(anonymous(&opened)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "application/pdf");
    let (status, _, _) = host.send(anonymous(&format!("{opened}&download=1"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the ticket names the exact URL");
    let ticket = opened.rsplit("ticket=").next().unwrap();
    let (status, _, _) = host.send(anonymous(&format!("{base}/raw?f={other}&ticket={ticket}"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "not another file");
    let (status, _, _) = host.send(anonymous(&format!("{base}?ticket={ticket}"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "not the listing");

    // Minting needs the session and the exact origin, and only for the API.
    let (status, _, _) = host.send(mint(ORIGIN, "not-a-session", &url)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = host.send(mint("https://evil.example", &cookie, &url)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for refused in ["https://evil.example/api/v1/x", "/index.html"] {
        let (status, _, _) = host.send(mint(ORIGIN, &cookie, refused)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    }
}

#[tokio::test]
async fn a_phone_file_lands_in_the_project_inbox_and_only_a_relative_reference_returns() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(43)).await.0;
    let tab_id = fixture_tab_id(&host, &cookie).await;

    // Larger than a control message: the inbox route has its own limit.
    let bytes = vec![0xAB; MAX_CONTROL_MESSAGE * 4];
    let (status, _, body) = host
        .send(inbox_request(&tab_id, "IMG_0042.jpg", &cookie, bytes.clone()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    let attachment = &json(&body)["attachment"];
    let reference = attachment["reference"].as_str().expect("reference");
    assert!(reference.starts_with(concat!(".", crate::app_slug!(), "/inbox/")), "{reference}");
    assert!(reference.ends_with("-IMG_0042.jpg"), "{reference}");
    assert_eq!(attachment["size"], bytes.len());
    assert!(
        !body.contains(&host.root.to_string_lossy().to_string()),
        "a filesystem path leaked: {body}"
    );
    assert_eq!(std::fs::read(host.root.join(reference)).unwrap(), bytes);
}

#[tokio::test]
async fn an_inbox_upload_is_bounded_and_scoped_to_a_known_tab() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(47)).await.0;
    let tab_id = fixture_tab_id(&host, &cookie).await;

    let (status, ..) = host
        .send(inbox_request(&tab_id, "huge.bin", &cookie, vec![0; inbox::MAX_INBOX_FILE + 1]))
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    let (status, _, body) = host
        .send(inbox_request(&tab_id, "empty.txt", &cookie, vec![]))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
    assert_eq!(json(&body)["error"], "empty_file");

    let (status, _, body) = host
        .send(inbox_request("not-a-tab", "a.txt", &cookie, b"x".to_vec()))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

    // Wrong origin: refused before anything is written.
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/tabs/{tab_id}/inbox?name=a.txt"))
        .header(header::ORIGIN, "https://elsewhere.example")
        .header(header::COOKIE, cookie_pair(&cookie))
        .body(Body::from(b"x".to_vec()))
        .expect("request");
    let (status, ..) = host.send(request).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!host.root.join(inbox::INBOX_DIR).exists(), "a refused upload wrote to disk");
}

#[tokio::test]
async fn a_file_sent_from_the_project_screen_lands_in_that_projects_inbox() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(61)).await.0;
    let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project_id = json(&projects_body)["projects"][0]["id"]
        .as_str()
        .expect("opaque project id")
        .to_string();
    let send = |project: &str, origin: &str, bytes: Vec<u8>| {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/{project}/inbox?name=notes.pdf"))
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .body(Body::from(bytes))
            .expect("request")
    };

    // Wrong origin: refused before anything is written.
    let (status, ..) = host
        .send(send(&project_id, "https://elsewhere.example", b"x".to_vec()))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!host.root.join(inbox::INBOX_DIR).exists(), "a refused upload wrote to disk");

    let (status, _, body) = host.send(send("not-a-project", ORIGIN, b"x".to_vec())).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

    // Larger than a control message: the route carries the inbox's limit.
    let bytes = vec![0xEF; MAX_CONTROL_MESSAGE * 4];
    let (status, _, body) = host.send(send(&project_id, ORIGIN, bytes.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    let reference = json(&body)["attachment"]["reference"]
        .as_str()
        .expect("reference")
        .to_string();
    assert!(reference.starts_with(concat!(".", crate::app_slug!(), "/inbox/")), "{reference}");
    assert!(reference.ends_with("-notes.pdf"), "{reference}");
    assert!(
        !body.contains(&host.root.to_string_lossy().to_string()),
        "a filesystem path leaked: {body}"
    );
    assert_eq!(std::fs::read(host.root.join(&reference)).unwrap(), bytes);

    let (status, ..) = host
        .send(send(&project_id, ORIGIN, vec![0; inbox::MAX_INBOX_FILE + 1]))
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn a_file_sent_to_the_desktop_lands_in_the_global_inbox_not_a_project() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(59)).await.0;
    let send = |name: &str, origin: &str, bytes: Vec<u8>| {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/inbox?name={name}"))
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(&cookie))
            .body(Body::from(bytes))
            .expect("request")
    };
    let state_dir = host.state.config.state_dir.clone();
    let inbox_dir = state_dir.join(inbox::GLOBAL_INBOX_DIR);

    // Wrong origin: refused before anything is written.
    let (status, ..) = host.send(send("a.txt", "https://elsewhere.example", b"x".to_vec())).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!inbox_dir.exists(), "a refused upload wrote to disk");

    let bytes = vec![0xCD; MAX_CONTROL_MESSAGE * 4];
    let (status, _, body) = host.send(send("ticket.pdf", ORIGIN, bytes.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "answered: {body}");
    let name = json(&body)["file"]["name"].as_str().expect("name").to_string();
    assert!(name.ends_with("-ticket.pdf"), "{name}");
    assert!(json(&body)["file"].get("reference").is_none());
    assert!(!body.contains(&state_dir.to_string_lossy().to_string()), "a path leaked: {body}");
    assert_eq!(std::fs::read(inbox_dir.join(&name)).unwrap(), bytes);
    assert!(!host.root.join(inbox::INBOX_DIR).exists(), "a global file reached a project");

    let (status, _, body) = host.send(send("empty.txt", ORIGIN, vec![])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["error"], "empty_file");
    let (status, ..) = host
        .send(send("huge.bin", ORIGIN, vec![0; inbox::MAX_INBOX_FILE + 1]))
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[cfg(unix)]
#[tokio::test]
async fn desktop_availability_is_what_answers_not_what_file_was_left_behind() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(53)).await.0;
    let socket = host.state.config.control_dir.join("desktop-control.sock");

    // The file a desktop leaves when it exits — or crashes. `exists()` read
    // it as a desktop for as long as the desktop stayed closed.
    std::fs::write(&socket, b"").expect("stale socket file");
    let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false, "{body}");
    let (_, _, body) = host
        .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
        .await;
    let opaque = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
    let (status, _, body) = host
        .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], false, "{body}");
    assert!(!body.contains(RAW_PROJECT));

    // Something listening there is a desktop.
    std::fs::remove_file(&socket).expect("remove stale file");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
    let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert_eq!(json(&body)["desktop_available"], true, "{body}");
    drop(listener);
}

/// A phone kept out of a section gets 403 on every route of it, reads and
/// writes alike, and learns which from its status; another phone is not.
#[tokio::test]
async fn a_phone_kept_out_of_a_section_is_refused_its_routes() {
    let host = Fixture::with_project();
    let (kept_out, device) = host.pair_device(&signing_key(93)).await;
    let (other, _) = host.pair_device(&signing_key(94)).await;
    host.state
        .auth
        .lock()
        .unwrap()
        .set_hidden_sections(&device, &["mail".into(), "todo".into()])
        .expect("hide");

    let (_, _, body) = host.send(get_as("/api/v1/status", &kept_out)).await;
    assert_eq!(json(&body)["hidden_sections"], serde_json::json!(["todo", "mail"]));
    let (_, _, body) = host.send(get_as("/api/v1/status", &other)).await;
    assert_eq!(json(&body)["hidden_sections"], serde_json::json!([]));

    for (method, uri) in [
        ("GET", "/api/v1/todo"),
        ("POST", "/api/v1/todo"),
        ("GET", "/api/v1/mail"),
        ("GET", "/api/v1/mail/folders/anything"),
        ("GET", "/api/v1/mail/folders/anything/messages/anything"),
        ("POST", "/api/v1/mail/folders/anything/messages/anything/mark"),
        ("POST", "/api/v1/mail/folders/anything/messages/anything/reply"),
    ] {
        let (status, _, body) = host.send(request_as(method, uri, &kept_out, Some(serde_json::json!({})))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
        assert_eq!(json(&body)["error"], "section_hidden", "{method} {uri}");
        let (status, _, _) = host.send(request_as(method, uri, &other, Some(serde_json::json!({})))).await;
        assert_ne!(status, StatusCode::FORBIDDEN, "{method} {uri} for the other phone");
    }
    // The calendar was left open to it.
    let (status, _, _) = host.send(get_as("/api/v1/calendar?month=2026-10", &kept_out)).await;
    assert_ne!(status, StatusCode::FORBIDDEN);

    // Opening the section again lets it straight back in.
    host.state.auth.lock().unwrap().set_hidden_sections(&device, &[]).expect("open");
    let (status, _, _) = host.send(get_as("/api/v1/mail", &kept_out)).await;
    assert_ne!(status, StatusCode::FORBIDDEN);
}

#[test]
fn alert_rows_of_a_hidden_section_are_dropped() {
    use crate::services::mobile_control::protocol::{MobileAlertItem, MobileAlertsSnapshot};
    let row = |kind: &str| MobileAlertItem {
        kind: kind.into(),
        severity: "soon".into(),
        title: kind.into(),
        detail: String::new(),
        at: None,
        all_day: false,
        minutes_away: None,
        days_away: None,
        task_id: None,
        alert_id: Some(kind.into()),
    };
    let snapshot = MobileAlertsSnapshot {
        enabled: true,
        items: vec![row("mail"), row("event"), row("task"), row("later_kind")],
    };
    let kept = open_alerts(&["calendar".into(), "todo".into()], snapshot);
    let kinds: Vec<&str> = kept.items.iter().map(|i| i.kind.as_str()).collect();
    assert_eq!(kinds, ["mail", "later_kind"]);
}

#[tokio::test]
async fn status_tracks_the_untested_tag_display_preference() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(91)).await.0;
    let settings = host.state.config.state_dir.join("settings.json");

    let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["show_untested_tags"], false);

    std::fs::write(&settings, br#"{"show_untested_tags":true}"#).expect("settings");
    let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["show_untested_tags"], true);
}

#[tokio::test]
async fn status_reports_the_desktop_theme_for_a_phone_that_follows_it() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(92)).await.0;
    let settings = host.state.config.state_dir.join("settings.json");

    // Unset is the desktop's own default.
    let (_, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(json(&body)["color_scheme"], "light_lavender");

    std::fs::write(&settings, br#"{"color_scheme":"light_lavender"}"#).expect("settings");
    let (_, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(json(&body)["color_scheme"], "light_lavender");

    // Anything that is not a plain theme name never crosses.
    std::fs::write(&settings, br#"{"color_scheme":"<b>/etc/passwd</b>"}"#).expect("settings");
    let (_, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
    assert_eq!(json(&body)["color_scheme"], "light_lavender");
}

/// The desktop pill's git dot reaches the list row and the project screen
/// under the opaque id; the desktop's raw id and any level the phone does
/// not know stay behind.
#[cfg(unix)]
#[tokio::test]
async fn a_projects_git_dot_crosses_by_opaque_id_and_known_levels_only() {
    use crate::services::mobile_control::protocol::ProjectGitState;
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(54)).await.0;
    let socket = host.state.config.control_dir.join("desktop-control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
    let desktop = tokio::spawn(async move {
        for _ in 0..3 {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let request: DesktopRequest = admin::read_frame(&mut stream).await.expect("request");
            let response = match request {
                // The list row's agent counts come from the activity readings.
                DesktopRequest::Activity { .. } => serde_json::from_value(json!({
                    "status": "activity",
                    "statuses": [{ "tmux_session": format!("{}-{RAW_PROJECT}--agent-abcdef123", crate::brand::SLUG), "status": "question" }],
                }))
                .expect("activity"),
                DesktopRequest::GitStates { .. } => DesktopResponse::GitStates {
                    states: vec![
                        ProjectGitState { project_id: RAW_PROJECT.into(), state: "unpushed".into() },
                        ProjectGitState { project_id: "not-listed".into(), state: "dirty".into() },
                    ],
                },
                DesktopRequest::Catalog { .. } => serde_json::from_value(json!({
                    "status": "catalog", "agents": [], "git": "a-level-from-the-future",
                }))
                .expect("catalog"),
                other => panic!("unexpected request {other:?}"),
            };
            admin::write_frame(&mut stream, &response).await.expect("answer");
        }
    });

    let (status, _, body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    let row = &json(&body)["projects"][0];
    assert_eq!(row["git"], "unpushed", "{body}");
    assert_eq!(row["agents"], json!({ "working": 0, "question": 1, "done": 0 }), "{body}");
    assert!(!body.contains(RAW_PROJECT) && !body.contains("not-listed"), "{body}");

    let opaque = row["id"].as_str().unwrap().to_string();
    let (status, _, body) = host
        .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "answered: {body}");
    assert!(json(&body)["project"].get("git").is_none(), "unknown level dropped: {body}");
    desktop.await.expect("fake desktop");
}

/// A write the desktop applied, whose refreshed list was too large to
/// relay, reaches the phone under its own code on every list-answering
/// write route. Not a 2xx: the body has no list, and a phone bundle that
/// does not know the code must land in its error path rather than read a
/// board out of nothing. Not a 503 either, which the phone reads as a
/// closed desktop. The phone tells it from a failed write by the code and
/// reloads through the read route (`reloadIfApplied` in `api.ts`).
#[cfg(unix)]
#[tokio::test]
async fn an_applied_write_with_an_unrelayable_answer_keeps_its_own_code() {
    let host = Fixture::with_project();
    let cookie = host.pair_device(&signing_key(55)).await.0;
    let (_, _, body) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let project = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
    let writes: Vec<(String, Value)> = vec![
        ("/api/v1/todo".into(), json!({ "type": "toggle", "task_id": "t1" })),
        ("/api/v1/alerts".into(), json!({ "alert_id": "row" })),
        (
            "/api/v1/calendar?month=2026-09".into(),
            json!({ "type": "delete_event", "event_id": "e1" }),
        ),
        (
            "/api/v1/mail/folders/f1/messages/m1/mark".into(),
            json!({ "action": "seen" }),
        ),
        (
            "/api/v1/mail/folders/f1/messages/m1/reply".into(),
            json!({ "body": "Thanks" }),
        ),
        (format!("/api/v1/projects/{project}/prompts"), json!({ "message": "Review" })),
        ("/api/v1/local-models".into(), json!({ "action": "load", "model": "llama3" })),
    ];
    // The local-models switch is unset (on) in a settings file that exists.
    std::fs::write(host.state.config.state_dir.join("settings.json"), "{}").expect("settings");

    let socket = host.state.config.control_dir.join("desktop-control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
    let expected = writes.len();
    let desktop = tokio::spawn(async move {
        let mut answered = 0;
        while answered < expected {
            let (mut stream, _) = listener.accept().await.expect("accept");
            // A reachability probe connects and sends nothing.
            let Ok(request) = admin::read_frame::<DesktopRequest>(&mut stream).await else {
                continue;
            };
            assert!(request.is_mutation(), "not a mutation: {request:?}");
            let response = DesktopResponse::Error {
                code: admin::APPLIED_RESPONSE_TOO_LARGE.into(),
                message: String::new(),
            };
            admin::write_frame(&mut stream, &response).await.expect("answer");
            answered += 1;
        }
    });

    for (uri, body) in &writes {
        let request = Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(body).expect("body")))
            .expect("request");
        let (status, _, answer) = host.send(request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri} answered: {answer}");
        assert_eq!(
            json(&answer)["error"],
            admin::APPLIED_RESPONSE_TOO_LARGE,
            "{uri} answered: {answer}"
        );
    }
    desktop.await.expect("fake desktop");
}

/// Write the per-phone list onto every scope of `file` (`projects.json` or
/// `boxes.json`) that has the Mobile switch on, and drop the cached
/// snapshot so the next request reads it.
fn limit_to(host: &Fixture, file: &str, devices: &[&str]) {
    let path = host.state.config.state_dir.join(file);
    let mut list: Value = serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
    for scope in list.as_array_mut().expect("list") {
        if scope[crate::brand::MOBILE_ACCESS_KEY] == true {
            scope[crate::brand::MOBILE_DEVICES_KEY] = json!(devices);
        }
    }
    std::fs::write(&path, serde_json::to_vec(&list).expect("bytes")).expect("write");
    catalog_stale(&host.state);
}

/// A project open to one phone only: the listed phone sees and opens it
/// as before, and to the other phone it is exactly an unknown id on every
/// route that takes one — the project screen, a tab, a create, the file
/// browser (by cookie and by open ticket), markup, a schedule, a prompt
/// send — and missing from `/projects` and `/activity`. (The terminal
/// upgrade checks through the same filtered catalog; its socket cannot be
/// upgraded under `oneshot`, so `pty_bridge`'s re-check test covers it.)
#[tokio::test]
async fn a_project_open_to_one_phone_is_an_unknown_id_to_the_other() {
    let host = Fixture::with_project();
    std::fs::create_dir_all(host.root.join("docs")).expect("docs");
    std::fs::write(host.root.join("paper.pdf"), "%PDF-1.7\n%%EOF\n").expect("pdf");
    std::fs::write(
        host.state.config.state_dir.join("settings.json"),
        json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "project_files": true, "shell_tabs": true } }).to_string(),
    )
    .expect("settings");
    let (listed, listed_id) = host.pair_device(&signing_key(81)).await;
    let (other, _) = host.pair_device(&signing_key(82)).await;
    let (project_id, tab_id) = project_and_tab(&host, &other).await;
    let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/files"), &listed)).await;
    let token = json(&body)["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|entry| entry["name"] == "paper.pdf")
        .expect("paper.pdf")["token"]
        .as_str()
        .expect("token")
        .to_string();

    limit_to(&host, "projects.json", &[&listed_id]);

    // The listed phone: as before.
    assert_eq!(project_and_tab(&host, &listed).await, (project_id.clone(), tab_id.clone()));
    let (status, _, _) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}"), &listed)).await;
    assert_eq!(status, StatusCode::OK);

    // The other phone: nothing listed.
    let (_, _, body) = host.send(get_as("/api/v1/projects", &other)).await;
    assert_eq!(json(&body)["projects"], json!([]), "{body}");
    let (_, _, body) = host.send(get_as("/api/v1/projects?view=search", &other)).await;
    assert_eq!(json(&body)["projects"], json!([]), "{body}");
    let (status, _, body) = host.send(get_as("/api/v1/activity", &other)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.contains(&project_id) && !body.contains(&tab_id), "{body}");

    // And every id-taking route answers it as an unknown id — the listed
    // phone asking about ids that never existed is the yardstick.
    let unknown = "A".repeat(27);
    let schedule = json!({ "enabled": true, "message": "x", "rule": { "type": "daily", "time": "08:00" } });
    let routes = |project: &str, tab: &str| -> Vec<(&'static str, String, Option<Value>)> {
        vec![
            ("GET", format!("/api/v1/projects/{project}"), None),
            ("GET", format!("/api/v1/tabs/{tab}"), None),
            ("POST", format!("/api/v1/projects/{project}/tabs"), Some(json!({
                "project_id": project, "kind": "shell", "idempotency_key": "scoped-0123456789abcdef",
            }))),
            ("GET", format!("/api/v1/projects/{project}/files"), None),
            ("GET", format!("/api/v1/projects/{project}/files/raw?f={token}"), None),
            ("GET", format!("/api/v1/projects/{project}/files/search?q=paper"), None),
            ("POST", format!("/api/v1/projects/{project}/files/upload?name=paper.pdf"), None),
            ("DELETE", format!("/api/v1/projects/{project}/files/upload?f={token}"), None),
            ("GET", format!("/api/v1/tabs/{tab}/markup/questions"), None),
            ("POST", format!("/api/v1/tabs/{tab}/schedules"), Some(schedule.clone())),
            ("POST", format!("/api/v1/projects/{project}/prompts/p-1/send"), Some(json!({ "tab_id": tab }))),
            ("GET", format!("/api/v1/tabs/{tab}/status"), None),
            ("GET", format!("/api/v1/tabs/{tab}/outbox"), None),
        ]
    };
    for ((method, real, body), (_, fake, fake_body)) in routes(&project_id, &tab_id).into_iter().zip(routes(&unknown, &unknown)) {
        let (status, _, answer) = host.send(request_as(method, &real, &other, body)).await;
        let (expected_status, _, expected) = host.send(request_as(method, &fake, &listed, fake_body)).await;
        assert_eq!(expected_status, StatusCode::NOT_FOUND, "{fake}: {expected}");
        assert!(
            matches!(json(&expected)["error"].as_str(), Some("project_not_found" | "tab_not_found")),
            "{fake}: {expected}"
        );
        assert_eq!((status, json(&answer)["error"].clone()), (expected_status, json(&expected)["error"].clone()), "{method} {real}");
    }

    // The file's bytes by open ticket, the way the browser's viewer asks.
    let anonymous = |uri: &str| Request::builder().uri(uri).body(Body::empty()).expect("request");
    let ticketed = |cookie: &str, project: &str| {
        let url = format!("/api/v1/projects/{project}/files/raw?f={token}");
        request_as("POST", "/api/v1/open-ticket", cookie, Some(json!({ "url": url })))
    };
    let (_, _, body) = host.send(ticketed(&listed, &project_id)).await;
    let (status, _, _) = host.send(anonymous(json(&body)["url"].as_str().expect("url"))).await;
    assert_eq!(status, StatusCode::OK, "the listed phone's ticket opens the file");
    let (_, _, body) = host.send(ticketed(&other, &project_id)).await;
    let (status, _, answer) = host.send(anonymous(json(&body)["url"].as_str().expect("url"))).await;
    assert_eq!((status, json(&answer)["error"].clone()), (StatusCode::NOT_FOUND, json!("project_not_found")));

    // An empty list reaches no phone at all; dropping it reaches both again.
    limit_to(&host, "projects.json", &[]);
    let (_, _, body) = host.send(get_as("/api/v1/projects", &listed)).await;
    assert_eq!(json(&body)["projects"], json!([]), "{body}");
    let path = host.state.config.state_dir.join("projects.json");
    let mut list: Value = serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
    list[0].as_object_mut().expect("entry").remove(crate::brand::MOBILE_DEVICES_KEY);
    std::fs::write(&path, serde_json::to_vec(&list).expect("bytes")).expect("write");
    catalog_stale(&host.state);
    assert_eq!(project_and_tab(&host, &other).await.0, project_id);
}

/// The desktop's activity answer covers every scope; each phone gets only
/// the rows of the scopes it may reach — a working tab in a project open
/// to one phone is on that phone's list and not on the other's.
#[cfg(unix)]
#[tokio::test]
async fn the_activity_list_carries_a_scoped_projects_tabs_only_to_its_phones() {
    let host = Fixture::with_project();
    let (listed, listed_id) = host.pair_device(&signing_key(85)).await;
    let (other, _) = host.pair_device(&signing_key(86)).await;
    limit_to(&host, "projects.json", &[&listed_id]);
    let socket = host.state.config.control_dir.join("desktop-control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
    let desktop = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let request: DesktopRequest = admin::read_frame(&mut stream).await.expect("request");
            assert!(matches!(request, DesktopRequest::Activity { .. }), "unexpected request {request:?}");
            let response: DesktopResponse = serde_json::from_value(json!({
                "status": "activity",
                "statuses": [{ "tmux_session": format!("{SLUG}-{RAW_PROJECT}--agent-abcdef123"), "status": "working" }],
            }))
            .expect("activity");
            admin::write_frame(&mut stream, &response).await.expect("answer");
        }
    });
    let (status, _, body) = host.send(get_as("/api/v1/activity", &listed)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(json(&body)["tabs"].as_array().expect("tabs").len(), 1, "{body}");
    let (status, _, body) = host.send(get_as("/api/v1/activity", &other)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(json(&body)["tabs"], json!([]), "{body}");
    desktop.await.expect("fake desktop");
}

/// A box's own list scopes the box scope the same way.
#[tokio::test]
async fn a_box_open_to_one_phone_is_unlisted_for_the_other() {
    let host = Fixture::with_box();
    let (listed, listed_id) = host.pair_device(&signing_key(83)).await;
    let (other, _) = host.pair_device(&signing_key(84)).await;
    limit_to(&host, "boxes.json", &[&listed_id]);
    let (_, _, body) = host.send(get_as("/api/v1/projects", &listed)).await;
    let boxes = json(&body)["projects"].as_array().expect("projects").len();
    assert_eq!(boxes, 1, "{body}");
    let box_id = json(&body)["projects"][0]["id"].as_str().expect("box id").to_string();
    let (_, _, body) = host.send(get_as("/api/v1/projects", &other)).await;
    assert_eq!(json(&body)["projects"], json!([]), "{body}");
    let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{box_id}"), &other)).await;
    assert_eq!((status, json(&body)["error"].clone()), (StatusCode::NOT_FOUND, json!("project_not_found")));
}

/// The agent-notice lookup is not a phone's request: it finds a tab in a
/// scope open to some phones and carries that list on to the push filter.
#[test]
fn an_agent_notice_lookup_carries_the_scopes_phone_list() {
    let host = Fixture::with_project();
    let tmux = format!("{SLUG}-{RAW_PROJECT}--agent-abcdef123");
    assert_eq!(agent_tab_ref(&host.state, &tmux).expect("tab").devices, None);
    limit_to(&host, "projects.json", &["d1"]);
    assert_eq!(agent_tab_ref(&host.state, &tmux).expect("tab").devices, Some(vec!["d1".to_string()]));
}

/// A remote-only project (E7, D15): the detail says `remote_only` with no
/// folder and agents to create; `launch-options` offers no "this computer"
/// (`here: false`) and drops every launch that starts here, with a window or
/// without; and a create that names no machine — or a reopen, which starts
/// here too — is refused before the window or the owner is asked.
#[cfg(unix)]
#[tokio::test]
async fn a_remote_only_project_starts_nothing_on_this_computer() {
    let host = host_tab_fixture(true);
    let state_dir = host.state.config.state_dir.clone();
    let path = state_dir.join("projects.json");
    let mut records: Vec<Value> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    records[0]["remote"]["remote_only"] = true.into();
    std::fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
    let cookie = host.pair_device(&signing_key(95)).await.0;
    let (_, _, listed) = host.send(get_as("/api/v1/projects", &cookie)).await;
    let p = json(&listed)["projects"][0]["id"].as_str().expect("project id").to_string();
    let (status, _, detail) = host.send(get_as(&format!("/api/v1/projects/{p}"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    let detail = json(&detail);
    assert_eq!(detail["project"]["remote_only"], true, "{detail}");
    assert_eq!(detail["project"]["host"], "remote");
    assert_eq!((detail["folder"].as_bool(), detail["create"].as_str()), (Some(false), Some("agents")), "{detail}");

    let (_, _, options) = host.send(get_as(&format!("/api/v1/projects/{p}/launch-options"), &cookie)).await;
    assert_eq!(json(&options)["here"], false, "no window: {options}");

    let socket = host.state.config.control_dir.join("desktop-control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
    let asked: Arc<Mutex<usize>> = Arc::default();
    let seen = asked.clone();
    let desktop = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let Ok(request) = admin::read_frame::<DesktopRequest>(&mut stream).await else {
                continue;
            };
            let answer = match request {
                DesktopRequest::LaunchOptions { .. } => DesktopResponse::LaunchOptions {
                    worktrees: Vec::new(),
                    cloud: Vec::new(),
                    sign_in: Vec::new(),
                    local: None,
                    api_key: Vec::new(),
                },
                _ => {
                    *seen.lock().unwrap() += 1;
                    DesktopResponse::Error { code: "unknown_agent".into(), message: "not offered".into() }
                }
            };
            admin::write_frame(&mut stream, &answer).await.expect("answer");
        }
    });
    let (status, _, options) = host.send(get_as(&format!("/api/v1/projects/{p}/launch-options"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{options}");
    let options = json(&options);
    assert_eq!(options["here"], false, "{options}");
    assert_eq!(options["hosts"].as_array().map(Vec::len), Some(1), "its primary: {options}");
    for key in ["worktrees", "cloud", "sign_in", "api_key"] {
        assert_eq!(options[key], json!([]), "{key}: {options}");
    }
    assert!(options["local"].is_null(), "{options}");

    let plain = json!({ "project_id": p, "kind": "agent", "agent_id": "claude", "idempotency_key": "remote-only-0123456789abcdef" });
    let (status, _, body) = host.send(create_request(&p, &cookie, plain)).await;
    assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::CONFLICT, Some("not_attachable")), "{body}");
    let reopen = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/projects/{p}/tabs/reopen"))
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, cookie_pair(&cookie))
        .body(Body::empty())
        .expect("request");
    let (status, _, body) = host.send(reopen).await;
    assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::CONFLICT, Some("not_attachable")), "{body}");
    assert_eq!(*asked.lock().unwrap(), 0, "the window was never asked to start a tab");
    desktop.abort();
}

/// The one thing a remote-only project takes from the phone (E7, D15): a
/// create naming one of its listed machines passes `creatable` and reaches
/// the window as `Create` with that machine's location word. A synced-copy
/// worker is not listed and cannot be named (nothing feeds it, D4); a worker
/// on the primary's folder is. A sign-in on its host tab is refused.
#[cfg(unix)]
#[tokio::test]
async fn a_remote_only_project_starts_an_agent_on_a_listed_machine() {
    let mut host = host_tab_fixture(true);
    let state_dir = host.state.config.state_dir.clone();
    let path = state_dir.join("projects.json");
    let mut records: Vec<Value> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    records[0]["remote"]["remote_only"] = true.into();
    records[0]["compute_hosts"] = json!([
        { "id": "w1", "user": "alice", "host": "w1.example", "remote_path": "/srv/w" },
        { "id": "w3", "user": "alice", "host": "w3.example", "remote_path": "/srv/aurora", "shared_fs": true },
    ]);
    std::fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
    // The desktop holds the primary's and w3's masters (the seam stands in
    // for `ssh -O check`); w1's would not matter, it is never listed.
    let live: host_live::SharedHostLive = Arc::default();
    for (name, machine) in [("cm-primary", "primary.example"), ("cm-w3", "w3.example"), ("cm-w1", "w1.example")] {
        let control = state_dir.join(name);
        std::fs::write(&control, b"").unwrap();
        crate::services::ssh_exec::TEST_LIVE_MASTERS.lock().unwrap().push(control.clone());
        let spec = serde_json::from_value(json!({ "user": "alice", "host": machine, "remote_path": "/x" })).unwrap();
        live.lock().unwrap().insert(&spec, host_live::HostReach { control_path: control, sessions: None });
    }
    host.state.catalog = Arc::new(Mutex::new(CatalogCache::with_host_live(live)));
    let cookie = host.pair_device(&signing_key(96)).await.0;
    let (p, t) = project_and_tab(&host, &cookie).await;

    let socket = host.state.config.control_dir.join("desktop-control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
    let asked: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let seen = asked.clone();
    let desktop = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let Ok(request) = admin::read_frame::<DesktopRequest>(&mut stream).await else {
                continue;
            };
            let answer = match request {
                DesktopRequest::LaunchOptions { .. } => DesktopResponse::LaunchOptions {
                    worktrees: Vec::new(),
                    cloud: Vec::new(),
                    sign_in: Vec::new(),
                    local: None,
                    api_key: Vec::new(),
                },
                DesktopRequest::Create { request, .. } => {
                    seen.lock().unwrap().push(request.host);
                    DesktopResponse::Error { code: "unknown_agent".into(), message: "not offered".into() }
                }
                _ => DesktopResponse::Seen,
            };
            admin::write_frame(&mut stream, &answer).await.expect("answer");
        }
    });
    let (status, _, options) = host.send(get_as(&format!("/api/v1/projects/{p}/launch-options"), &cookie)).await;
    assert_eq!(status, StatusCode::OK, "{options}");
    let options = json(&options);
    assert_eq!(options["here"], false, "{options}");
    let hosts = options["hosts"].as_array().cloned().expect("hosts listed");
    let rows: Vec<_> = hosts.iter().map(|row| (row["label"].as_str(), row["primary"].as_bool(), row["connected"].as_bool())).collect();
    assert_eq!(rows, [(Some("primary.example"), Some(true), Some(true)), (Some("w3.example"), Some(false), Some(true))], "{options}");

    for (n, row) in hosts.iter().enumerate() {
        let body = json!({
            "project_id": p, "kind": "agent", "agent_id": "claude", "host": row["id"],
            "idempotency_key": format!("remote-only-host-{n}-0123456789abcdef"),
        });
        let (status, _, answer) = host.send(create_request(&p, &cookie, body)).await;
        assert_ne!(json(&answer)["error"].as_str(), Some("not_attachable"), "{status} {answer}");
    }
    assert_eq!(asked.lock().unwrap().as_slice(), [Some("remote".to_string()), Some("host:w3".to_string())], "the window was asked, on each machine");

    let (status, _, body) = host.send(request_as("POST", &format!("/api/v1/tabs/{t}/sign-in"), &cookie, Some(json!({ "idempotency_key": "ro-signin-0123456789abcdef" })))).await;
    assert_eq!((status, json(&body)["error"].as_str()), (StatusCode::CONFLICT, Some("tab_on_host")), "{body}");
    assert_eq!(asked.lock().unwrap().len(), 2, "the sign-in never reached the window");
    desktop.abort();
}
