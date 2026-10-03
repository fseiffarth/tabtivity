//! The daemon's shared-calendar code against the real service
//! (`app_gateway::calendars`) on temp sockets, one socket per account (every
//! connection is this process's uid; each service instance answers as one
//! account over the one store).
use super::*;
use app_gateway::calendars::Calendars;
use app_gateway::hub::HubPeers;
use crate::schema::calendar::{TaskFileLink, TaskMailLink};

struct As(&'static str);

impl HubPeers for As {
    fn user_of(&self, _: u32) -> Option<String> {
        Some(self.0.to_string())
    }
    fn uid_of(&self, name: &str) -> Option<u32> {
        ["alice", "bob", "carol"].contains(&name).then_some(1)
    }
}

struct Server {
    dir: tempfile::TempDir,
}

impl Server {
    fn new() -> Server {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("service")).unwrap();
        Server { dir }
    }

    fn socket_for(&self, user: &'static str) -> PathBuf {
        let socket = self.dir.path().join(format!("{user}.sock"));
        let service = Calendars::new(self.dir.path().join("service"), Box::new(As(user)));
        let (ready, wait) = std::sync::mpsc::channel();
        let path = socket.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::UnixListener::bind(&path).unwrap();
                ready.send(()).unwrap();
                let _ = app_gateway::calendars::serve(std::sync::Arc::new(service), listener).await;
            });
        });
        wait.recv().unwrap();
        socket
    }

    fn state(&self, user: &str) -> PathBuf {
        let dir = self.dir.path().join(format!("state-{user}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

fn alices_calendar(state: &Path) -> PathBuf {
    let path = state.join("calendar.json");
    let mut data = CalendarData::default();
    data.calendars.push(Calendar { id: "lab".into(), name: "Lab".into(), color: "#4aa3df".into(), visible: true, readonly: false, rev: 0, extra: Default::default() });
    data.events.push(CalendarEvent { id: "e1".into(), calendar_id: "lab".into(), start: "2026-10-05T10:00".into(), end: "2026-10-05T11:00".into(), title: "Group meeting".into(), ..Default::default() });
    data.tasks.push(CalendarTask {
        id: "t1".into(),
        calendar_id: "lab".into(),
        title: "Order reagents".into(),
        mail: Some(TaskMailLink { message_id: "<quote@example.invalid>".into(), subject: "Quote from the supplier".into(), ..Default::default() }),
        file: Some(TaskFileLink { path: "/home/alice/lab/notes.md".into(), ..Default::default() }),
        project_id: "p-secret".into(),
        ..Default::default()
    });
    data.events.push(CalendarEvent { id: "mine".into(), calendar_id: DEFAULT_CALENDAR_ID.into(), start: "2026-10-06".into(), end: "2026-10-07".into(), all_day: true, title: "Private".into(), ..Default::default() });
    crate::storage::write_json_atomic(&path, &data).unwrap();
    path
}

fn grant(socket: &Path, id: &str, user: &str, events: Option<Role>, tasks: Option<Role>) {
    let reply = ask_at(socket, &Request::Grant { id: id.into(), user: user.into(), events, tasks }).unwrap();
    assert!(reply.ok, "{reply:?}");
}

fn view(shared: &Shared) -> CalendarData {
    let mut data = CalendarData::default();
    shared.merge_into(&mut data);
    data
}

/// The plan's P4c exit through the daemons: A opens a calendar's events to B
/// as viewer and its to-do list to C as editor. B can't write, C's edit
/// reaches A within one change, a task's mail link never reaches C, and
/// revoking stops B's next read.
#[test]
fn the_p4c_exit_holds_through_the_daemons() {
    let server = Server::new();
    let (alice_sock, bob_sock, carol_sock) = (server.socket_for("alice"), server.socket_for("bob"), server.socket_for("carol"));
    let (alice_state, bob_state, carol_state) = (server.state("alice"), server.state("bob"), server.state("carol"));
    let path = alices_calendar(&alice_state);

    // Sharing is a move: out of Alice's calendar.json, into the service.
    let info = share_in(&path, &alice_state, &alice_sock, "lab").unwrap();
    let local = crate::commands::calendar::read_data(&path).unwrap();
    assert!(!local.calendars.iter().any(|c| c.id == "lab") && local.events.len() == 1 && local.tasks.is_empty(), "only the private event stays");
    grant(&alice_sock, &info.id, "bob", Some(Role::Viewer), None);
    grant(&alice_sock, &info.id, "carol", None, Some(Role::Editor));

    // B sees the events, read-only, and cannot write.
    let bob = Shared::new(bob_sock, bob_state);
    let b = view(&bob);
    let cal = b.calendars.iter().find(|c| is_shared_id(&c.id)).unwrap();
    assert!(cal.readonly, "a viewer's calendar is read-only in the UI");
    assert_eq!((b.events.len(), b.tasks.len()), (1, 0));
    let mut event = b.events[0].clone();
    event.title = "Hijacked".into();
    let error = bob.put_event(&event, false).unwrap().unwrap_err();
    assert!(error.contains("read"), "{error}");
    assert!(bob.delete_event(&event.id).unwrap().is_err());

    // C sees the to-do list without its mail link, file or project, edits it.
    let carol = Shared::new(carol_sock, carol_state);
    let c = view(&carol);
    assert_eq!((c.events.len(), c.tasks.len()), (0, 1));
    let task = c.tasks[0].clone();
    assert!(task.mail.is_none() && task.file.is_none() && task.project_id.is_empty(), "{task:?}");
    let before = view(&Shared::new(alice_sock.clone(), alice_state.clone())).calendars.iter().find(|c| is_shared_id(&c.id)).unwrap().rev;
    let mut edited = task.clone();
    edited.title = "Order reagents (2x)".into();
    let stored = carol.put_task(&edited, false).unwrap().unwrap();
    assert_eq!(stored.title, "Order reagents (2x)");

    // A sees it at the next read, one revision later — and her own card still
    // carries its mail link and file, which never left her daemon.
    let alice = Shared::new(alice_sock.clone(), alice_state.clone());
    let a = view(&alice);
    let cal = a.calendars.iter().find(|c| is_shared_id(&c.id)).unwrap();
    assert_eq!(cal.rev, before + 1);
    let card = a.tasks.iter().find(|t| t.id == "t1").unwrap();
    assert_eq!(card.title, "Order reagents (2x)");
    assert_eq!(card.mail.as_ref().map(|m| m.subject.as_str()), Some("Quote from the supplier"));
    assert_eq!(card.project_id, "p-secret");
    let on_disk = std::fs::read_dir(server.dir.path().join("service")).unwrap().flatten().map(|e| std::fs::read_to_string(e.path()).unwrap_or_default()).collect::<String>();
    assert!(!on_disk.contains("Quote from the supplier") && !on_disk.contains("p-secret") && !on_disk.contains("/home/alice"), "the service never held them");

    // Revoke: B's next read finds nothing, and his copy is dropped.
    assert!(ask_at(&alice_sock, &Request::Revoke { id: info.id.clone(), user: "bob".into() }).unwrap().ok);
    let b = view(&bob);
    assert!(!b.calendars.iter().any(|c| is_shared_id(&c.id)) && b.events.is_empty(), "{:?}", b.calendars);
    assert!(bob.revs().is_empty());

    // Unshare: everything comes home, links included.
    unshare_in(&path, &alice_state, &alice_sock, &info.id).unwrap();
    let local = crate::commands::calendar::read_data(&path).unwrap();
    assert!(local.calendars.iter().any(|c| c.id == "lab"));
    let back = local.tasks.iter().find(|t| t.id == "t1").unwrap();
    assert_eq!((back.title.as_str(), back.mail.is_some(), back.file.is_some()), ("Order reagents (2x)", true, true));
    assert!(view(&carol).tasks.is_empty(), "carol's copy goes with the share");
}

#[test]
fn a_record_never_moves_between_a_shared_and_a_private_calendar() {
    let server = Server::new();
    let alice_sock = server.socket_for("alice");
    let alice_state = server.state("alice");
    let path = alices_calendar(&alice_state);
    let info = share_in(&path, &alice_state, &alice_sock, "lab").unwrap();
    let alice = Shared::new(alice_sock, alice_state);
    let data = view(&alice);
    let mut shared_event = data.events.iter().find(|e| e.id == "e1").unwrap().clone();
    shared_event.calendar_id = DEFAULT_CALENDAR_ID.into();
    assert!(alice.put_event(&shared_event, false).unwrap().is_err(), "out of a shared calendar: refused");
    let private = CalendarEvent { id: "mine".into(), calendar_id: local_id(&info.id), title: "Private".into(), ..Default::default() };
    assert!(alice.put_event(&private, true).unwrap().is_err(), "into one: refused");
    let plain = CalendarEvent { id: "mine".into(), calendar_id: DEFAULT_CALENDAR_ID.into(), ..Default::default() };
    assert!(alice.put_event(&plain, true).is_none(), "a private edit is not the service's business");
    let new = CalendarEvent { calendar_id: local_id(&info.id), title: "New".into(), start: "2026-10-07".into(), end: "2026-10-08".into(), ..Default::default() };
    let created = alice.put_event(&new, false).unwrap().unwrap();
    assert!(!created.id.is_empty() && created.calendar_id == local_id(&info.id));
}

#[test]
fn some_calendars_are_never_shared_and_a_refusal_puts_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().to_path_buf();
    let path = alices_calendar(&state);
    assert!(share_in(&path, &state, &state.join("none.sock"), DEFAULT_CALENDAR_ID).unwrap_err().contains("default"));
    // No service: the move is undone, nothing is lost.
    assert!(share_in(&path, &state, &state.join("none.sock"), "lab").is_err());
    let local = crate::commands::calendar::read_data(&path).unwrap();
    assert!(local.calendars.iter().any(|c| c.id == "lab") && local.events.iter().any(|e| e.id == "e1") && local.tasks.iter().any(|t| t.id == "t1"));
    let caldav = Calendar { id: "dav".into(), name: "x".into(), color: "#000".into(), visible: true, readonly: false, rev: 0, extra: [("caldav_account_id".to_string(), serde_json::json!("acct"))].into_iter().collect() };
    assert!(share_refusal(&caldav).unwrap().contains("CalDAV"));
    assert!(share_refusal(&Calendar { readonly: true, extra: Default::default(), ..caldav }).unwrap().contains("read-only"));
    let mut doc = local.clone();
    doc.calendars.push(Calendar { id: "shared:x".into(), name: "s".into(), color: "#000".into(), visible: true, readonly: true, rev: 1, extra: Default::default() });
    doc.events.push(CalendarEvent { id: "s1".into(), calendar_id: "shared:x".into(), ..Default::default() });
    assert!(crate::commands::calendar::refuses_shared_rows(&doc), "an agent's proposal naming a shared calendar is refused");
    strip_shared(&mut doc);
    assert!(!crate::commands::calendar::refuses_shared_rows(&doc), "a whole-document save never writes one");
}

#[test]
fn a_wait_returns_when_another_member_changes_a_calendar() {
    let server = Server::new();
    let (alice_sock, carol_sock) = (server.socket_for("alice"), server.socket_for("carol"));
    let (alice_state, carol_state) = (server.state("alice"), server.state("carol"));
    let path = alices_calendar(&alice_state);
    let info = share_in(&path, &alice_state, &alice_sock, "lab").unwrap();
    grant(&alice_sock, &info.id, "carol", None, Some(Role::Editor));
    let alice = std::sync::Arc::new(Shared::new(alice_sock, alice_state));
    view(&alice);
    let carol = Shared::new(carol_sock, carol_state);
    let task = view(&carol).tasks[0].clone();
    let waiter = {
        let alice = alice.clone();
        std::thread::spawn(move || alice.wait())
    };
    std::thread::sleep(std::time::Duration::from_millis(100));
    let mut edited = task.clone();
    edited.percent = 50;
    carol.put_task(&edited, false).unwrap().unwrap();
    assert!(waiter.join().unwrap().unwrap(), "alice's page is woken by carol's edit");
    assert_eq!(alice.task("t1").unwrap().percent, 50, "and the daemon's copy caught up");
}
