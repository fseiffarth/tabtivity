use super::*;
use crate::services::root_mcp::{revoke_tab, session_alive, test_session_tabs};
use std::cell::RefCell;

/// The store and the budgets are process-wide, and some tests move the clock
/// a day or an hour on, which prunes every other test's messages and budget
/// windows: these tests run one at a time.
fn serial() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    SERIAL.lock_ok()
}

/// A seat in `state`'s scope `scope` for saved tab `tab`.
fn seat(state: &Path, scope: &str, tab: &str, class: Class) -> Binding {
    Binding {
        seat: cockpit_mcp::Binding { state: state.into(), scope: scope.into(), id: tab.into(), spawn: "spawn".into() },
        class,
        handle: handle_of(state, scope, tab).expect("a handle key"),
        cli: "claude".into(),
    }
}

/// A granted tab: its seat, enrolled under a live session on PTY `pty`.
struct Tab {
    binding: Binding,
    session: Session,
    pty: String,
}

fn grant(state: &Path, scope: &str, tab: &str, class: Class) -> Tab {
    let binding = seat(state, scope, tab, class);
    // Unique per state dir: tests run in parallel against the one token store.
    let pty = format!("{scope}:{tab}-{}", binding.handle);
    let (_, session) = test_session_tabs(&pty, binding.clone());
    Tab { binding, session, pty }
}

struct World2 {
    enabled: bool,
    registry: Registry,
    now: Instant,
    marks: RefCell<Vec<String>>,
    unmarks: RefCell<Vec<String>>,
}

impl World2 {
    fn new() -> Self { World2 { enabled: true, registry: Registry::Open, now: Instant::now(), marks: RefCell::default(), unmarks: RefCell::default() } }

    fn reply(&self, tab: &Tab, message: &Value) -> Value {
        let registry = |_: &Path, _: &str| self.registry;
        let label = |b: &Binding| if b.class == Class::Cloud { "Cloud tab".to_string() } else { "Local tab".to_string() };
        let mark = |pty: &str| self.marks.borrow_mut().push(pty.to_string());
        let unmark = |pty: &str| self.unmarks.borrow_mut().push(pty.to_string());
        let ctx = Context {
            enabled: self.enabled, registry: &registry, label: &label, alive: &session_alive, mark: &mark, unmark: &unmark,
            now: self.now,
        };
        handle_with(&tab.session, message, &ctx).expect("a reply")
    }

    fn call(&self, tab: &Tab, tool: &str, args: Value) -> Value {
        let msg = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool,"arguments":args}});
        self.reply(tab, &msg)["result"]["structuredContent"].clone()
    }

    fn send(&self, from: &Tab, to: &Tab, text: &str) -> Value {
        self.call(from, TOOL_SEND, json!({"to": to.binding.handle, "text": text}))
    }

    /// The idle wake's claims for scope `p` of `state` now.
    fn wakes(&self, state: &Path) -> Vec<String> {
        wake_claims_in(state, "p", self.now, &session_alive)
    }

    /// Read the inbox and ack everything in it.
    fn read_all(&self, tab: &Tab) {
        let ids: Vec<Value> =
            self.call(tab, TOOL_INBOX, json!({}))["messages"].as_array().unwrap().iter().map(|m| m["id"].clone()).collect();
        self.call(tab, TOOL_INBOX, json!({"ack": ids}));
    }
}

#[test]
fn may_exchange_is_same_state_scope_and_class() {
    let _serial = serial();
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let base = seat(a.path(), "p", "t1", Class::Cloud);
    for (other, expected) in [
        (seat(a.path(), "p", "t2", Class::Cloud), true),
        (seat(a.path(), "p", "t2", Class::Local), false),
        (seat(a.path(), "p", "t2", Class::Locked("p".into())), false),
        (seat(a.path(), "q", "t2", Class::Cloud), false),
        (seat(b.path(), "p", "t2", Class::Cloud), false),
    ] {
        assert_eq!(may_exchange(&base, &other), expected, "{other:?}");
        assert_eq!(may_exchange(&other, &base), expected, "symmetric: {other:?}");
    }
    let locked = seat(a.path(), "p", "t1", Class::Locked("p".into()));
    assert!(may_exchange(&locked, &seat(a.path(), "p", "t3", Class::Locked("p".into()))));
    assert!(!may_exchange(&locked, &seat(a.path(), "p", "t3", Class::Locked("q".into()))));
}

#[test]
fn handles_are_stable_keyed_and_shaped() {
    let _serial = serial();
    let state = Path::new("state");
    let h = handle_of(state, "p", "tab").unwrap();
    assert!(valid_handle(&h), "{h}");
    assert_eq!(h, handle_of(state, "p", "tab").unwrap(), "stable for the process");
    assert_ne!(h, handle_of(state, "p", "tab2").unwrap());
    assert_ne!(h, handle_of(state, "q", "tab").unwrap());
    assert_ne!(h, handle_of(Path::new("other"), "p", "tab").unwrap());
    // The separators keep `p` + `0tab` apart from `p0` + `tab`.
    assert_ne!(handle_with_key(&[1; 32], state, "p", "xtab"), handle_with_key(&[1; 32], state, "px", "tab"));
    assert_ne!(handle_with_key(&[1; 32], state, "p", "tab"), handle_with_key(&[2; 32], state, "p", "tab"), "keyed");
}

#[test]
fn send_inbox_and_ack() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let (a, b) = (grant(state.path(), "p", "a", Class::Cloud), grant(state.path(), "p", "b", Class::Cloud));
    let w = World2::new();
    let listed = w.call(&a, TOOL_LIST, json!({}));
    assert_eq!(listed["status"], "ok");
    assert_eq!(listed["self"]["handle"], a.binding.handle.as_str());
    assert_eq!(listed["tabs"], json!([{"handle": b.binding.handle, "label": "Cloud tab", "cli": "claude"}]));

    let sent = w.send(&a, &b, "ping\nwith a second line\tand a tab");
    assert_eq!(sent["status"], "queued");
    let id = sent["id"].as_str().unwrap().to_string();
    assert!(valid_message_id(&id));
    assert_eq!(*w.marks.borrow(), vec![b.pty.clone()], "the recipient's hook marker, by its PTY");
    let reply = w.call(&b, TOOL_SEND, json!({"to": a.binding.handle, "text": "pong", "replyTo": id}));
    assert_eq!(reply["status"], "queued");

    // Reading does not consume: twice without ack, the same.
    let first = w.call(&b, TOOL_INBOX, json!({}));
    assert_eq!(first, w.call(&b, TOOL_INBOX, Value::Null));
    assert_eq!(first["unread"], 1);
    assert_eq!(first["notice"], FROM_PEERS);
    let row = &first["messages"][0];
    assert_eq!(row["id"], id.as_str());
    assert_eq!(row["from"], json!({"handle": a.binding.handle, "label": "Cloud tab"}));
    assert_eq!(row["text"], "ping\nwith a second line\tand a tab");
    assert!(row.get("replyTo").is_none());
    let back = w.call(&a, TOOL_INBOX, json!({}));
    assert_eq!(back["messages"][0]["replyTo"], id.as_str());

    // Ack drops it from the inbox; the window still lists it, read.
    let after = w.call(&b, TOOL_INBOX, json!({"ack": [id]}));
    assert_eq!(after["unread"], 0);
    assert_eq!(after["messages"], json!([]));
    let traffic = traffic_in(state.path(), "p", Some("b"));
    assert_eq!(traffic.len(), 2);
    assert!(traffic.iter().any(|m| m.id == id && m.read && m.from_tab == "a" && m.to_tab == "b"));
    // Someone else's id in ack is ignored: a's message to b stays b's to ack.
    let a_unread = w.call(&a, TOOL_INBOX, json!({}))["messages"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(w.call(&b, TOOL_INBOX, json!({"ack": [a_unread]}))["unread"], 0);
    assert_eq!(w.call(&a, TOOL_INBOX, json!({}))["unread"], 1);
    assert_eq!(unread_count_in(state.path(), "p", "a"), 1);
}

fn unread_count_in(state: &Path, scope: &str, tab: &str) -> usize {
    traffic_in(state, scope, Some(tab)).iter().filter(|m| m.to_tab == tab && !m.read).count()
}

#[test]
fn unknown_other_project_and_other_class_handles_answer_the_same_not_found() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let other_project = grant(state.path(), "q", "b", Class::Cloud);
    let other_class = grant(state.path(), "p", "c", Class::Local);
    let other_state_dir = tempfile::tempdir().unwrap();
    let other_state = grant(other_state_dir.path(), "p", "d", Class::Cloud);
    let w = World2::new();
    let unknown = w.call(&a, TOOL_SEND, json!({"to": "t_0123456789abcdef", "text": "hi"}));
    assert_eq!(unknown["category"], NOT_FOUND);
    for target in [&other_project, &other_class, &other_state] {
        assert_eq!(w.send(&a, target, "hi").to_string(), unknown.to_string(), "byte for byte");
    }
    assert_eq!(w.call(&a, TOOL_LIST, json!({}))["tabs"], json!([]));
    assert!(w.marks.borrow().is_empty());
    assert_eq!(w.call(&other_class, TOOL_INBOX, json!({}))["unread"], 0);
}

#[test]
fn self_and_malformed_sends_are_refused() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    assert_eq!(w.send(&a, &a, "me")["category"], SELF);
    for args in [
        json!({}),
        json!({"to": b.binding.handle}),
        json!({"text": "x"}),
        json!({"to": b.binding.handle, "text": "x", "scope": "p"}),
        json!({"to": b.binding.handle, "text": "x", "tabId": "b"}),
        json!({"to": "b", "text": "x"}),
        json!({"to": b.binding.handle.to_uppercase(), "text": "x"}),
        json!({"to": b.binding.handle, "text": "x", "replyTo": "nope"}),
        json!({"to": b.binding.handle, "text": 5}),
    ] {
        assert_eq!(w.call(&a, TOOL_SEND, args.clone())["category"], INVALID, "{args}");
    }
    assert_eq!(w.call(&a, TOOL_LIST, json!({"all": true}))["category"], INVALID);
    for args in [json!({"ack": "m_0123456789abcdef"}), json!({"ack": ["x"]}), json!({"other": 1}),
        json!({"ack": vec!["m_0123456789abcdef"; MAX_ACK + 1]})] {
        assert_eq!(w.call(&a, TOOL_INBOX, args.clone())["category"], INVALID, "{args}");
    }
    assert!(w.marks.borrow().is_empty());
}

#[test]
fn text_is_bounded_in_characters_and_refuses_invisible_characters() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    let wide = "日".repeat(MAX_TEXT_CHARS);
    assert!(wide.len() > MAX_TEXT_CHARS * 2);
    assert_eq!(w.send(&a, &b, &wide)["status"], "queued", "4000 characters, 12000 bytes");
    assert_eq!(w.send(&a, &b, &format!("{wide}日"))["category"], TOO_LARGE);
    assert_eq!(w.send(&a, &b, "Ünïcödé — ok")["status"], "queued");
    for bad in ["", "  \n\t ", "a\u{202e}b", "a\u{200b}b", "\u{1b}[31mred", "a\rb", "a\u{0}b", "a\u{2066}b", "a\u{feff}b"] {
        assert_eq!(w.send(&a, &b, bad)["category"], INVALID, "{bad:?}");
    }
}

#[test]
fn a_full_inbox_refuses() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    for i in 0..MAX_UNREAD_PER_TAB {
        assert_eq!(w.send(&a, &b, &format!("m{i}"))["status"], "queued");
    }
    assert_eq!(w.send(&a, &b, "one more")["category"], INBOX_FULL);
    let page = w.call(&b, TOOL_INBOX, json!({}));
    assert_eq!(page["unread"], MAX_UNREAD_PER_TAB);
    assert_eq!(page["messages"].as_array().unwrap().len(), INBOX_PAGE);
    assert_eq!(page["messages"][0]["text"], "m0", "oldest first");
    let ack: Vec<Value> = page["messages"].as_array().unwrap().iter().map(|m| m["id"].clone()).collect();
    assert_eq!(w.call(&b, TOOL_INBOX, json!({"ack": ack}))["messages"][0]["text"], "m10");
    assert_eq!(w.send(&a, &b, "room again")["status"], "queued");
}

#[test]
fn budgets_answer_retry_after_and_survive_a_regrant() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    for i in 0..SENDS_PER_HOUR {
        // Spread over the inbox cap: b acks as it goes.
        assert_eq!(w.send(&a, &b, &format!("m{i}"))["status"], "queued", "{i}");
        if i % 10 == 9 {
            let ids: Vec<Value> = w.call(&b, TOOL_INBOX, json!({}))["messages"].as_array().unwrap().iter().map(|m| m["id"].clone()).collect();
            w.call(&b, TOOL_INBOX, json!({"ack": ids}));
        }
    }
    let over = w.send(&a, &b, "over");
    assert_eq!(over["category"], BUDGET);
    assert!(over["retryAfterSecs"].as_u64().is_some_and(|s| s > 0 && s <= 3600), "{over}");
    // A malformed call is refused before the budget, and takes nothing.
    assert_eq!(w.call(&a, TOOL_SEND, json!({"to": 1}))["category"], INVALID);
    // A respawn of the same saved tab keeps the spent budget.
    let again = grant(state.path(), "p", "a", Class::Cloud);
    assert_eq!(again.binding.handle, a.binding.handle);
    assert_eq!(w.send(&again, &b, "still over")["category"], BUDGET);
    // An hour on, it is admitted again.
    let later = World2 { now: w.now + HOUR, ..World2::new() };
    assert_eq!(later.send(&again, &b, "later")["status"], "queued");
}

#[test]
fn reads_have_their_own_budget() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let w = World2::new();
    for i in 0..READS_PER_HOUR {
        let tool = if i % 2 == 0 { TOOL_LIST } else { TOOL_INBOX };
        assert_eq!(w.call(&a, tool, json!({}))["status"], "ok", "{i}");
    }
    assert_eq!(w.call(&a, TOOL_INBOX, json!({}))["category"], BUDGET);
    assert_eq!(w.call(&a, TOOL_LIST, json!({}))["category"], BUDGET);
}

#[test]
fn messages_expire_after_a_day() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    w.send(&a, &b, "soon gone");
    let almost = World2 { now: w.now + LIFE - Duration::from_secs(1), ..World2::new() };
    assert_eq!(almost.call(&b, TOOL_INBOX, json!({}))["unread"], 1);
    let later = World2 { now: w.now + LIFE, ..World2::new() };
    assert_eq!(later.call(&b, TOOL_INBOX, json!({}))["unread"], 0);
    assert!(traffic_in(state.path(), "p", None).is_empty());
}

#[test]
fn a_regrant_keeps_inbox_and_handle_and_a_closed_tab_is_not_listed() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    w.send(&a, &b, "kept");
    // b's PTY exits: its token is revoked, it is no longer listed or reachable.
    revoke_tab(&b.pty);
    assert!(sweep_with(&session_alive, w.now));
    assert_eq!(w.call(&a, TOOL_LIST, json!({}))["tabs"], json!([]));
    assert_eq!(w.send(&a, &b, "to nobody")["category"], NOT_FOUND);
    // b respawns (same saved tab, new token): same handle, its unread waits.
    let b2 = grant(state.path(), "p", "b", Class::Cloud);
    assert_eq!(b2.binding.handle, b.binding.handle);
    assert_eq!(w.call(&b2, TOOL_INBOX, json!({}))["messages"][0]["text"], "kept");
    assert_eq!(w.call(&a, TOOL_LIST, json!({}))["tabs"][0]["handle"], b.binding.handle.as_str());
    // The old session is refused outright.
    let old = w.reply(&b, &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":TOOL_INBOX,"arguments":{}}}));
    assert!(old.get("error").is_some(), "{old}");
}

#[test]
fn purge_scope_empties_the_mailbox() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p-purge", "a", Class::Cloud);
    let b = grant(state.path(), "p-purge", "b", Class::Cloud);
    let c = grant(state.path(), "p-kept", "c", Class::Cloud);
    let d = grant(state.path(), "p-kept", "d", Class::Cloud);
    let w = World2::new();
    w.send(&a, &b, "one");
    w.send(&b, &a, "two");
    w.send(&c, &d, "elsewhere");
    assert_eq!(purge_scope("p-purge"), 2);
    assert_eq!(w.call(&b, TOOL_INBOX, json!({}))["unread"], 0);
    assert!(traffic_in(state.path(), "p-purge", None).is_empty());
    assert_eq!(traffic_in(state.path(), "p-kept", None).len(), 1);
    assert_eq!(purge_scope("p-purge"), 0);
}

#[test]
fn a_message_whose_class_no_longer_matches_is_not_returned() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    w.send(&a, &b, "from a cloud tab");
    // b comes back as a local-model tab (same saved tab, other home).
    let b_local = grant(state.path(), "p", "b", Class::Local);
    assert_eq!(w.call(&b_local, TOOL_INBOX, json!({}))["unread"], 0);
    assert_eq!(w.call(&b_local, TOOL_LIST, json!({}))["tabs"], json!([]));
}

#[test]
fn local_models_only_is_rechecked_on_every_call() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let cloud = grant(state.path(), "p", "a", Class::Cloud);
    let local = grant(state.path(), "p", "b", Class::Local);
    let stamped = grant(state.path(), "p", "c", Class::Locked("p".into()));
    let stamped2 = grant(state.path(), "p", "d", Class::Locked("p".into()));
    let wrong_stamp = grant(state.path(), "p", "e", Class::Locked("q".into()));
    let locked = World2 { registry: Registry::Locked, ..World2::new() };
    for tab in [&cloud, &local, &wrong_stamp] {
        for tool in TOOLS {
            assert_eq!(locked.call(tab, tool, json!({}))["category"], UNAVAILABLE, "{tool}");
        }
    }
    assert_eq!(locked.send(&stamped, &stamped2, "local to local")["status"], "queued");
    assert_eq!(locked.call(&stamped2, TOOL_INBOX, json!({}))["unread"], 1);
    let unreadable = World2 { registry: Registry::Unreadable, ..World2::new() };
    for tab in [&cloud, &stamped] {
        assert_eq!(unreadable.call(tab, TOOL_LIST, json!({}))["category"], UNAVAILABLE);
    }
}

#[test]
fn the_registry_reads_a_malformed_setting_as_locked() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    assert_eq!(registry_at(state.path(), "p"), Registry::Unreadable, "no projects.json");
    let write = |v: Value| crate::storage::write_json(&state.path().join("projects.json"), &v).unwrap();
    write(json!([{"id": "p", "name": "P", "status": "active", "position": 0, "local_file": "", "agent_privacy": {"local_models_only": true}}]));
    assert_eq!(registry_at(state.path(), "p"), Registry::Locked);
    write(json!([{"id": "p", "name": "P", "status": "active", "position": 0, "local_file": "", "agent_privacy": "yes"}]));
    assert_eq!(registry_at(state.path(), "p"), Registry::Locked);
    write(json!([{"id": "p", "name": "P", "status": "active", "position": 0, "local_file": ""}]));
    assert_eq!(registry_at(state.path(), "p"), Registry::Open);
    std::fs::write(state.path().join("projects.json"), b"{not json").unwrap();
    assert_eq!(registry_at(state.path(), "p"), Registry::Unreadable);
}

#[test]
fn switched_off_the_handshake_still_answers_and_calls_say_off() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let off = World2 { enabled: false, ..World2::new() };
    let listed = off.reply(&a, &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}));
    let names: Vec<&str> = listed["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    assert_eq!(names, TOOLS);
    let init = off.reply(&a, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    assert_eq!(init["result"]["serverInfo"]["name"], SERVER_NAME);
    for tool in TOOLS {
        assert_eq!(off.call(&a, tool, json!({}))["category"], OFF, "{tool}");
    }
    let unknown = off.reply(&a, &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"print_request","arguments":{}}}));
    assert_eq!(unknown["result"]["isError"], true);
}

#[test]
fn other_callers_are_refused() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let w = World2::new();
    for caller in [Caller::Agent, Caller::Cockpit, Caller::Printer, Caller::Helper] {
        let (_, session) = crate::services::root_mcp::test_session(caller);
        let tab = Tab { binding: a.binding.clone(), session, pty: a.pty.clone() };
        let reply = w.reply(&tab, &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}));
        assert!(reply.get("error").is_some(), "{caller:?}");
    }
}

#[test]
fn no_reply_names_a_scope_tab_id_pty_or_path() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let scope = "project-secret-id";
    let a = grant(state.path(), scope, "tab-id-alpha", Class::Cloud);
    let b = grant(state.path(), scope, "tab-id-bravo", Class::Cloud);
    let w = World2::new();
    let mut replies = vec![
        w.call(&a, TOOL_LIST, json!({})),
        w.send(&a, &b, "hello"),
        w.send(&a, &a, "me"),
        w.call(&a, TOOL_SEND, json!({"to": "t_0123456789abcdef", "text": "x"})),
        w.call(&a, TOOL_SEND, json!({"to": 1})),
    ];
    let inbox = w.call(&b, TOOL_INBOX, json!({}));
    let id = inbox["messages"][0]["id"].clone();
    replies.push(inbox);
    replies.push(w.call(&b, TOOL_INBOX, json!({"ack": [id]})));
    replies.push(World2 { registry: Registry::Locked, ..World2::new() }.call(&a, TOOL_LIST, json!({})));
    replies.push(World2 { enabled: false, ..World2::new() }.call(&a, TOOL_LIST, json!({})));
    let state_text = state.path().to_string_lossy().to_string();
    for reply in replies {
        let text = reply.to_string();
        for secret in [scope, "tab-id-alpha", "tab-id-bravo", a.pty.as_str(), b.pty.as_str(), state_text.as_str(), a.session.id.as_str()] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
    }
}

#[test]
fn a_wake_is_claimed_once_per_unread_batch_and_budgeted() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    assert!(w.wakes(state.path()).is_empty(), "nothing unread");
    w.send(&a, &b, "one");
    w.send(&a, &b, "two");
    assert_eq!(w.wakes(state.path()), vec!["b".to_string()]);
    assert!(w.wakes(state.path()).is_empty(), "the batch is covered");
    let mut claims = 1;
    for i in 0..10 {
        w.read_all(&b);
        w.send(&a, &b, &format!("more {i}"));
        if w.wakes(state.path()) == vec!["b".to_string()] { claims += 1; }
    }
    assert_eq!(claims, WAKES_PER_HOUR);
}

#[test]
fn the_notice_fits_the_hooks_and_a_prompt() {
    let _serial = serial();
    assert!(!NOTICE.contains('\'') && !NOTICE.contains('\n'));
    assert!(!NOTICE.starts_with(['/', '!', '#', '$', '@']));
    assert!(NOTICE.contains(TOOL_INBOX) && NOTICE.contains(SERVER_NAME));
    assert!(!INSTRUCTIONS.contains('\n'));
}

#[test]
fn clean_label_drops_invisible_and_bounds_length() {
    let _serial = serial();
    assert_eq!(clean_label("  a\u{202e}b\nc\td  "), "ab c d");
    assert_eq!(clean_label(&"x".repeat(500)).chars().count(), LABEL_MAX_CHARS);
}

#[test]
fn cli_names_are_plain_stems() {
    let _serial = serial();
    assert_eq!(cli_name("claude"), "claude");
    assert_eq!(cli_name(&Path::new("bin").join("codex").to_string_lossy()), "codex");
    assert_eq!(cli_name("weird name!"), "agent");
    assert_eq!(cli_name(""), "agent");
}

#[test]
fn wake_claims_cover_listed_tabs_only() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let c = grant(state.path(), "p", "c", Class::Cloud);
    let w = World2::new();
    assert!(w.wakes(state.path()).is_empty(), "nothing unread");
    w.send(&a, &b, "for b");
    w.send(&a, &c, "for c");
    // c closes: it is no longer listed, so it is not woken.
    revoke_tab(&c.pty);
    sweep_with(&session_alive, w.now);
    assert_eq!(w.wakes(state.path()), vec!["b".to_string()]);
    assert!(w.wakes(state.path()).is_empty(), "the batch is covered");
    assert!(wake_claims_in(state.path(), "q", w.now, &session_alive).is_empty(), "another scope");
}

/// `retryAfterSecs` is rounded up: a call made exactly that long after the
/// refusal is admitted, not refused once more for the leftover fraction.
#[test]
fn retry_after_is_rounded_up_so_the_call_then_is_admitted() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let w = World2::new();
    for i in 0..READS_PER_HOUR {
        assert_eq!(w.call(&a, TOOL_LIST, json!({}))["status"], "ok", "{i}");
    }
    let at = w.now + Duration::from_millis(500);
    let over = World2 { now: at, ..World2::new() }.call(&a, TOOL_LIST, json!({}));
    assert_eq!(over["category"], BUDGET);
    let secs = over["retryAfterSecs"].as_u64().unwrap();
    let then = World2 { now: at + Duration::from_secs(secs), ..World2::new() };
    assert_eq!(then.call(&a, TOOL_LIST, json!({}))["status"], "ok", "retry after {secs}s");
}

/// Messages a tab can no longer read (sent under its old class, before it came
/// back under another) do not count toward its 20 unread: they would block
/// every new sibling's send with `inbox_full` for a day.
#[test]
fn messages_a_tab_can_no_longer_read_do_not_fill_its_inbox() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    for i in 0..MAX_UNREAD_PER_TAB {
        assert_eq!(w.send(&a, &b, &format!("m{i}"))["status"], "queued");
    }
    let b_local = grant(state.path(), "p", "b", Class::Local);
    let c = grant(state.path(), "p", "c", Class::Local);
    assert_eq!(w.send(&c, &b_local, "for the local tab")["status"], "queued");
    let inbox = w.call(&b_local, TOOL_INBOX, json!({}));
    assert_eq!(inbox["unread"], 1);
    assert_eq!(inbox["messages"][0]["text"], "for the local tab");
}

/// Messages that reach a busy tab while a wake's notice is still out for it
/// do not queue a second notice: one notice covers them until the tab reads
/// its inbox. (Two sends while busy → one claim.)
#[test]
fn a_notice_out_covers_later_messages_until_the_inbox_is_read() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    w.send(&a, &b, "first");
    assert_eq!(w.wakes(state.path()), vec!["b".to_string()]);
    w.send(&a, &b, "second, while b is busy");
    w.send(&a, &b, "third, still busy");
    assert!(w.wakes(state.path()).is_empty(), "the notice already out covers them");
    // b reads its inbox (without acking): those are seen, and its markers go.
    assert_eq!(w.call(&b, TOOL_INBOX, json!({}))["unread"], 3);
    assert_eq!(*w.unmarks.borrow(), vec![b.pty.clone()]);
    assert!(w.wakes(state.path()).is_empty(), "nothing new since the read");
    w.send(&a, &b, "fourth, after the read");
    assert_eq!(w.wakes(state.path()), vec!["b".to_string()]);
}

/// What a tab sends in a turn the idle wake started never wakes its
/// recipient, so two opted-in tabs cannot keep waking each other; once the
/// user types into it (or presses Deliver), its sends may wake again.
#[test]
fn a_woken_turn_does_not_wake_its_recipient() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    // The user's turn in a: its message wakes b (one hop).
    w.send(&a, &b, "ping");
    assert_eq!(w.wakes(state.path()), vec!["b".to_string()]);
    // b's woken turn reads and answers: the answer does not wake a.
    w.read_all(&b);
    w.send(&b, &a, "pong");
    assert!(w.wakes(state.path()).is_empty(), "a reply from a woken turn wakes no one");
    assert_eq!(w.call(&a, TOOL_INBOX, json!({}))["unread"], 1, "it is still delivered");
    // The user types into b: its next message wakes a again.
    human_input(&b.pty);
    w.send(&b, &a, "the user asked me to tell you");
    assert_eq!(w.wakes(state.path()), vec!["a".to_string()]);
    // a reads in its woken turn; then the user presses Deliver for a: the turn
    // Deliver starts is the user's, so a's reply wakes b.
    w.read_all(&a);
    w.send(&b, &a, "one more");
    assert!(deliver_claim_in(state.path(), "p", "a", &session_alive).is_ok());
    assert!(w.wakes(state.path()).is_empty(), "Deliver's notice is already out for a");
    w.read_all(&a);
    w.send(&a, &b, "answer from a Deliver turn");
    assert_eq!(w.wakes(state.path()), vec!["b".to_string()]);
}

/// Deliver leaves a notice out, so the wake does not queue a second one.
#[test]
fn deliver_is_not_doubled_by_a_wake() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    assert_eq!(deliver_claim_in(state.path(), "p", "b", &session_alive), Err("nothing_unread"));
    w.send(&a, &b, "hello");
    assert!(deliver_claim_in(state.path(), "p", "b", &session_alive).is_ok());
    assert!(w.wakes(state.path()).is_empty());
    assert_eq!(deliver_claim_in(state.path(), "p", "x", &session_alive), Err("not_found"));
}

/// Neither the wake nor Deliver counts messages the tab can no longer read
/// (sent under its old class), so neither wakes it to an empty inbox.
#[test]
fn wake_and_deliver_count_only_readable_messages() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    w.send(&a, &b, "for the cloud tab");
    // b comes back as a local-model tab: the cloud message is not for it.
    let b_local = grant(state.path(), "p", "b", Class::Local);
    assert!(w.wakes(state.path()).is_empty(), "nothing it can read");
    assert_eq!(deliver_claim_in(state.path(), "p", "b", &session_alive), Err("nothing_unread"));
    assert_eq!(w.call(&b_local, TOOL_INBOX, json!({}))["unread"], 0);
}

/// A tab whose session is gone but not yet swept (its spawn failed: token
/// revoked, no PTY exit) is neither woken nor delivered to.
#[test]
fn a_dead_session_is_not_woken_before_the_sweep() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let a = grant(state.path(), "p", "a", Class::Cloud);
    let b = grant(state.path(), "p", "b", Class::Cloud);
    let w = World2::new();
    w.send(&a, &b, "hello");
    revoke_tab(&b.pty);
    assert!(w.wakes(state.path()).is_empty());
    assert_eq!(deliver_claim_in(state.path(), "p", "b", &session_alive), Err("not_found"));
}

/// Only the scope's own registry entry decides: another project's malformed
/// entry leaves the lane working; the scope's own malformed entry fails closed.
#[test]
fn only_the_scopes_own_registry_entry_can_make_it_unreadable() {
    let _serial = serial();
    let state = tempfile::tempdir().unwrap();
    let write = |v: Value| crate::storage::write_json(&state.path().join("projects.json"), &v).unwrap();
    let ok = |id: &str, locked: bool| json!({"id": id, "name": id, "status": "active", "position": 0, "local_file": "", "agent_privacy": {"local_models_only": locked}});
    let broken = json!({"id": "q", "name": 7, "status": ["x"]});
    write(json!([broken.clone(), ok("p", false)]));
    assert_eq!(registry_at(state.path(), "p"), Registry::Open);
    write(json!([broken.clone(), ok("p", true)]));
    assert_eq!(registry_at(state.path(), "p"), Registry::Locked);
    assert_eq!(registry_at(state.path(), "q"), Registry::Unreadable, "its own entry is broken");
    assert_eq!(registry_at(state.path(), "r"), Registry::Open, "no entry");
    write(json!({"not": "a list"}));
    assert_eq!(registry_at(state.path(), "p"), Registry::Unreadable);
}
