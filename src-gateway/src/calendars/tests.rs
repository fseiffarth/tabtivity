use super::*;
use serde_json::json;

/// Names by fake uid.
struct Fake;

const ALICE: u32 = 1001;
const BOB: u32 = 1002;
const CAROL: u32 = 1003;
const DAVE: u32 = 1004;

impl HubPeers for Fake {
    fn user_of(&self, uid: u32) -> Option<String> {
        match uid {
            ALICE => Some("alice".into()),
            BOB => Some("bob".into()),
            CAROL => Some("carol".into()),
            DAVE => Some("dave".into()),
            _ => None,
        }
    }
    fn uid_of(&self, name: &str) -> Option<u32> {
        ["alice", "bob", "carol", "dave"].contains(&name).then_some(1)
    }
}

fn service() -> (tempfile::TempDir, Calendars) {
    let dir = tempfile::tempdir().unwrap();
    let service = Calendars::new(dir.path().to_path_buf(), Box::new(Fake));
    (dir, service)
}

fn share(s: &Calendars) -> String {
    let reply = s.answer(
        ALICE,
        Request::Share {
            name: "Lab".into(),
            color: "#4aa3df".into(),
            origin: "local-cal-1".into(),
            events: vec![json!({"id": "e1", "calendar_id": "local-cal-1", "title": "Group meeting", "start": "2026-10-05T10:00", "end": "2026-10-05T11:00", "alarms": [{"minutes": 10}]})],
            tasks: vec![json!({"id": "t1", "calendar_id": "local-cal-1", "title": "Order reagents", "column": "todo", "project_id": "p-secret",
                "mail": {"message_id": "<abc@example.invalid>", "subject": "Quote from the supplier"},
                "file": {"path": "/home/alice/lab/notes.md"}})],
            columns: vec![json!({"id": "todo", "name": "To do", "position": 0})],
        },
    );
    assert!(reply.ok, "{reply:?}");
    reply.info.unwrap().id
}

fn grant(s: &Calendars, id: &str, user: &str, events: Option<Role>, tasks: Option<Role>) -> Reply {
    s.answer(ALICE, Request::Grant { id: id.into(), user: user.into(), events, tasks })
}

fn get(s: &Calendars, uid: u32, id: &str) -> Reply {
    s.answer(uid, Request::Get { id: id.into() })
}

/// The plan's P4c exit, at the service: A opens a calendar's events to B as
/// viewer and its to-do list to C as editor; B can't write, C's edit reaches
/// A within one change, a task's mail link never reaches C, and revoking
/// stops B's next read.
#[test]
fn the_p4c_exit_holds_at_the_service() {
    let (_dir, s) = service();
    let id = share(&s);
    assert!(grant(&s, &id, "bob", Some(Role::Viewer), None).ok);
    assert!(grant(&s, &id, "carol", None, Some(Role::Editor)).ok);

    // B: events only, read-only.
    let b = get(&s, BOB, &id).content.unwrap();
    assert_eq!((b.info.events, b.info.tasks, b.events.len(), b.tasks.len()), (Some(Role::Viewer), None, 1, 0));
    assert!(b.info.members.is_empty(), "a member does not see who else is on it");
    let mut event = b.events[0].clone();
    event["title"] = json!("Hijacked");
    let rev = rec_rev(&event);
    assert_eq!(s.answer(BOB, Request::Apply { id: id.clone(), change: Change::PutEvent { record: event, base_rev: rev } }).error.as_deref(), Some("read-only"));
    assert_eq!(s.answer(BOB, Request::Apply { id: id.clone(), change: Change::DeleteEvent { record_id: "e1".into(), base_rev: rev } }).error.as_deref(), Some("read-only"));
    assert_eq!(s.answer(BOB, Request::Apply { id: id.clone(), change: Change::PutTask { record: json!({"title": "x"}), base_rev: 0 } }).error.as_deref(), Some("read-only"));

    // C: tasks only, with no mail link, file link or project.
    let c = get(&s, CAROL, &id).content.unwrap();
    assert_eq!((c.info.events, c.info.tasks, c.events.len(), c.tasks.len(), c.columns.len()), (None, Some(Role::Editor), 0, 1, 1));
    let task = c.tasks[0].clone();
    let text = task.to_string();
    for leaked in ["Quote from the supplier", "abc@example.invalid", "/home/alice", "p-secret"] {
        assert!(!text.contains(leaked), "{leaked} reached carol: {text}");
    }
    let on_disk = std::fs::read_to_string(s.path(&id)).unwrap();
    assert!(!on_disk.contains("Quote from the supplier") && !on_disk.contains("p-secret"), "stripped on the way in, not on the way out");
    let mut edited = task.clone();
    edited["title"] = json!("Order reagents (2x)");
    edited["mail"] = json!({"message_id": "<carol@example.invalid>"});
    let before = get(&s, ALICE, &id).content.unwrap().info.rev;
    let reply = s.answer(CAROL, Request::Apply { id: id.clone(), change: Change::PutTask { record: edited, base_rev: rec_rev(&task) } });
    assert!(reply.ok, "{reply:?}");
    assert!(reply.record.unwrap().get("mail").is_none(), "an editor cannot add a mail link either");
    let a = get(&s, ALICE, &id).content.unwrap();
    assert_eq!(a.info.rev, before + 1, "one change, one revision");
    assert_eq!(a.tasks[0]["title"], "Order reagents (2x)");
    assert_eq!(a.events.len(), 1, "the owner sees both parts");

    // Revoke: B's next read fails, and the list no longer names it.
    assert!(s.answer(ALICE, Request::Revoke { id: id.clone(), user: "bob".into() }).ok);
    assert_eq!(get(&s, BOB, &id).error.as_deref(), Some("unknown-calendar"));
    assert!(s.answer(BOB, Request::List).list.is_empty());
    // A stranger learns nothing.
    assert_eq!(get(&s, DAVE, &id).error.as_deref(), Some("unknown-calendar"));
    assert_eq!(s.answer(DAVE, Request::Revoke { id: id.clone(), user: "carol".into() }).error.as_deref(), Some("unknown-calendar"));
    assert_eq!(s.answer(CAROL, Request::Revoke { id: id.clone(), user: "carol".into() }).error.as_deref(), Some("not-owner"));
    assert_eq!(s.answer(9999, Request::List).error.as_deref(), Some("refused"));
    let audit = std::fs::read_to_string(s.dir().join(crate::audit::AUDIT_FILE)).unwrap();
    assert!(audit.contains(VERB_SHARE) && audit.contains(VERB_GRANT) && audit.contains(VERB_REVOKE), "{audit}");
    assert!(!audit.contains("Lab") && !audit.contains("Group meeting") && !audit.contains("reagents"), "no titles in the audit: {audit}");
}

#[test]
fn two_editors_converge_by_revision() {
    let (_dir, s) = service();
    let id = share(&s);
    assert!(grant(&s, &id, "carol", None, Some(Role::Editor)).ok);
    let task = get(&s, CAROL, &id).content.unwrap().tasks[0].clone();
    let rev = rec_rev(&task);
    let mut mine = task.clone();
    mine["title"] = json!("carol's");
    let mut theirs = task.clone();
    theirs["title"] = json!("alice's");
    assert!(s.answer(ALICE, Request::Apply { id: id.clone(), change: Change::PutTask { record: theirs, base_rev: rev } }).ok);
    assert_eq!(s.answer(CAROL, Request::Apply { id: id.clone(), change: Change::PutTask { record: mine.clone(), base_rev: rev } }).error.as_deref(), Some("stale"), "the second writer read an older revision");
    let fresh = get(&s, CAROL, &id).content.unwrap().tasks[0].clone();
    assert!(s.answer(CAROL, Request::Apply { id: id.clone(), change: Change::PutTask { record: mine, base_rev: rec_rev(&fresh) } }).ok, "re-applied on the fresh one");
    // A create with a taken id gets a fresh one; a create may not claim a revision.
    let reply = s.answer(CAROL, Request::Apply { id: id.clone(), change: Change::PutTask { record: json!({"title": "new"}), base_rev: 0 } });
    assert!(reply.ok && cal_wire::valid_record_id(rec_id(reply.record.as_ref().unwrap()).unwrap()));
    assert_eq!(s.answer(CAROL, Request::Apply { id: id.clone(), change: Change::PutTask { record: json!({"id": "nope", "title": "x"}), base_rev: 3 } }).error.as_deref(), Some("stale"));
}

#[test]
fn the_admins_switches_close_what_they_name_and_keep_the_data() {
    let (dir, s) = service();
    let policy = dir.path().join("policy.json");
    let id = share(&s);
    assert!(grant(&s, &id, "bob", Some(Role::Editor), Some(Role::Editor)).ok);
    let s = s.with_policy(policy.clone());
    std::fs::write(&policy, br#"{"features":{"calendar_sharing":false}}"#).unwrap();
    assert!(s.answer(BOB, Request::List).list.is_empty(), "incoming calendars are hidden");
    assert_eq!(get(&s, BOB, &id).error.as_deref(), Some("unknown-calendar"));
    assert_eq!(s.answer(ALICE, Request::List).list.len(), 1, "the owner keeps her own");
    assert_eq!(grant(&s, &id, "carol", Some(Role::Viewer), None).error.as_deref(), Some("sharing-off"));
    assert_eq!(s.answer(ALICE, Request::Share { name: "x".into(), color: "#000".into(), origin: "o".into(), events: vec![], tasks: vec![], columns: vec![] }).error.as_deref(), Some("sharing-off"));
    std::fs::write(&policy, br#"{"features":{"calendar":false}}"#).unwrap();
    let b = get(&s, BOB, &id).content.unwrap();
    assert_eq!((b.info.events, b.events.len(), b.tasks.len()), (None, 0, 1), "calendar off: the events part is closed, to-dos stay");
    let reply = s.answer(BOB, Request::Apply { id: id.clone(), change: Change::PutEvent { record: json!({"title": "x"}), base_rev: 0 } });
    assert_eq!(reply.error.as_deref(), Some("feature-off"));
    std::fs::write(&policy, b"{}").unwrap();
    assert_eq!(get(&s, BOB, &id).content.unwrap().events.len(), 1, "switched back on, everything is where it was");
}

#[test]
fn unsharing_hands_everything_back_and_forgets_the_calendar() {
    let (_dir, s) = service();
    let id = share(&s);
    assert!(grant(&s, &id, "bob", Some(Role::Viewer), None).ok);
    assert_eq!(s.answer(BOB, Request::Unshare { id: id.clone() }).error.as_deref(), Some("not-owner"));
    let back = s.answer(ALICE, Request::Unshare { id: id.clone() }).content.unwrap();
    assert_eq!((back.origin.as_deref(), back.events.len(), back.tasks.len(), back.columns.len()), (Some("local-cal-1"), 1, 1, 1));
    assert!(!s.path(&id).exists());
    assert_eq!(get(&s, BOB, &id).error.as_deref(), Some("unknown-calendar"));
}

#[tokio::test]
async fn a_wait_wakes_on_the_next_change_and_on_a_revoke() {
    let (_dir, s) = service();
    let id = share(&s);
    assert!(grant(&s, &id, "bob", Some(Role::Viewer), None).ok);
    let s = Arc::new(s);
    let revs = s.visible(BOB).unwrap();
    assert!(s.wait(BOB, BTreeMap::new(), 1000).await.changed, "a stale view answers at once");
    assert!(!s.wait(BOB, revs.clone(), 50).await.changed, "nothing happened: a timeout");
    let waiter = {
        let s = s.clone();
        let revs = revs.clone();
        tokio::spawn(async move { s.wait(BOB, revs, 5000).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    let event = s.answer(ALICE, Request::Get { id: id.clone() }).content.unwrap().events[0].clone();
    let mut moved = event.clone();
    moved["start"] = json!("2026-10-05T11:00");
    assert!(s.answer(ALICE, Request::Apply { id: id.clone(), change: Change::PutEvent { record: moved, base_rev: rec_rev(&event) } }).ok);
    assert!(waiter.await.unwrap().changed, "the owner's change wakes the viewer");
    let revs = s.visible(BOB).unwrap();
    let waiter = {
        let s = s.clone();
        tokio::spawn(async move { s.wait(BOB, revs, 5000).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(s.answer(ALICE, Request::Revoke { id: id.clone(), user: "bob".into() }).ok);
    assert!(waiter.await.unwrap().changed, "a revoke wakes the revoked member, whose daemon drops its copy");
}

#[tokio::test]
async fn the_socket_answers_and_long_polls() {
    let (dir, s) = service();
    let socket = dir.path().join("cal.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    // Every connection here is this process's uid: answer as alice.
    struct Me;
    impl HubPeers for Me {
        fn user_of(&self, _: u32) -> Option<String> {
            Some("alice".into())
        }
        fn uid_of(&self, _: &str) -> Option<u32> {
            Some(1)
        }
    }
    let s = Calendars { peers: Box::new(Me), ..s };
    tokio::spawn(serve(Arc::new(s), listener));
    let reply = ask(&socket, &Request::Share { name: "Sock".into(), color: "#fff".into(), origin: "o1".into(), events: vec![], tasks: vec![], columns: vec![] }).await.unwrap();
    assert!(reply.ok, "{reply:?}");
    let list = ask(&socket, &Request::List).await.unwrap().list;
    assert_eq!(list.len(), 1);
    let revs: BTreeMap<String, u64> = list.into_iter().map(|i| (i.id, i.rev)).collect();
    let started = std::time::Instant::now();
    let reply = ask(&socket, &Request::Wait { revs, timeout_ms: 100 }).await.unwrap();
    assert!(reply.ok && !reply.changed && started.elapsed() >= Duration::from_millis(90));
}
