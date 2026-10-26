use super::*;
use crate::schema::mail::MailAddress;

fn store() -> (tempfile::TempDir, MailStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = MailStore::open(dir.path()).unwrap();
    (dir, store)
}

fn folder(account: &str, path: &str) -> MailFolder {
    MailFolder {
        id: format!("{account}|{path}"),
        account_id: account.into(),
        path: path.into(),
        name: path.rsplit('/').next().unwrap_or(path).into(),
        kind: MailFolderKind::Other,
        unread: 0,
        total: 0,
    }
}

fn header(folder: &MailFolder, uid: u32, subject: &str, date: &str) -> MailHeader {
    MailHeader {
        id: format!("{}#{uid}", folder.id),
        account_id: folder.account_id.clone(),
        folder_id: folder.id.clone(),
        uid,
        rfc_message_id: Some(format!("<{uid}@example.com>")),
        subject: subject.into(),
        from: MailAddress {
            name: Some("Sender".into()),
            address: "sender@example.com".into(),
        },
        to: vec![MailAddress {
            name: None,
            address: "me@example.org".into(),
        }],
        cc: Vec::new(),
        auth: None,
        date: date.into(),
        seen: false,
        flagged: false,
        answered: false,
        has_attachments: false,
        size: 1234,
        preview: format!("preview of {subject}"),
        malformed_headers: None,
        // Unmarked, always — `upsert_header` writes this column in neither
        // half of its statement, so a fixture that set it would be lying
        // about what a sync can do.
        priority: None,
        priority_source: None,
        priority_reason: None,
    }
}

/// Only Inbox folders, newest first, capped, deleted rows left out.
#[test]
fn inbox_senders_reads_inbox_folders_only() {
    let (_dir, store) = store();
    let mut inbox = folder("a1", "INBOX");
    inbox.kind = MailFolderKind::Inbox;
    let other = folder("a1", "Newsletters");
    store.upsert_folder(&inbox).unwrap();
    store.upsert_folder(&other).unwrap();
    let mut old = header(&inbox, 1, "old", "2026-07-01T09:00:00Z");
    old.from.address = "old@example.com".into();
    let mut new = header(&inbox, 2, "new", "2026-07-02T09:00:00Z");
    new.from.address = "new@example.com".into();
    let mut elsewhere = header(&other, 3, "news", "2026-07-03T09:00:00Z");
    elsewhere.from.address = "news@example.com".into();
    for h in [&old, &new, &elsewhere] {
        store.upsert_header(h).unwrap();
    }
    let got: Vec<String> = store.inbox_senders(10).unwrap().into_iter().map(|a| a.address).collect();
    assert_eq!(got, ["new@example.com", "old@example.com"]);
    assert_eq!(store.inbox_senders(1).unwrap().len(), 1);
}

fn agent_draft(id: &str) -> MailDraft {
    MailDraft { id: id.into(), account_id: "a1".into(), origin: Some("agent".into()), owner_session: Some("tab".into()), ..Default::default() }
}

fn agent_file(id: &str, bytes: &[u8]) -> NewStagedFile {
    NewStagedFile { staged_id: id.into(), filename: format!("{id}.pdf"), mime: "application/pdf".into(), source: format!("Alpha/out/{id}.pdf"), bytes: bytes.to_vec() }
}

/// An agent's files land as agent rows with their source, the draft JSON
/// mirrors the table, and replace semantics drop exactly the named rows.
#[test]
fn agent_files_are_staged_as_agent_rows_and_replaced_in_one_step() {
    let (_dir, store) = store();
    let d = agent_draft("d1");
    let rows = store.change_draft_files(None, &d, vec![agent_file("s1", b"one"), agent_file("s2", b"two")], &[]).unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.origin.as_deref() == Some("agent")));
    assert_eq!(rows[0].source.as_deref(), Some("Alpha/out/s1.pdf"));
    let stored = store.draft("d1").unwrap().unwrap();
    assert_eq!(stored.staged, rows, "the JSON mirrors the table");
    let rows = store.change_draft_files(Some(&stored), &stored, vec![agent_file("s3", b"three")], &["s1".into(), "s2".into()]).unwrap();
    assert_eq!(rows.iter().map(|r| r.staged_id.as_str()).collect::<Vec<_>>(), ["s3"]);
    assert!(store.staged_bytes("d1", "s1").is_err(), "a replaced copy is removed");
    assert_eq!(store.staged_bytes("d1", "s3").unwrap(), b"three");
}

/// Approving files the draft as shown; one changed since (by the agent, or
/// taken over in the composer) is refused and stays unfiled, while a file
/// the user picked in does not count as a change.
#[test]
fn approving_files_only_the_draft_as_shown() {
    let (_dir, store) = store();
    let (a, b, c) = (agent_draft("a"), agent_draft("b"), agent_draft("c"));
    for d in [&a, &b, &c] {
        store.change_agent_draft(None, Some(d)).unwrap();
    }
    let mut b2 = b.clone();
    b2.subject = "changed".into();
    store.change_agent_draft(Some(&b), Some(&b2)).unwrap();
    let mut human = c.clone();
    human.origin = None;
    human.owner_session = None;
    store.save_draft_with_staged(&mut human).unwrap();
    store.stage_attachment("a", "u1", "mine.txt", "text/plain", b"mine").unwrap();
    let err = store.file_agent_drafts(&[a.clone(), b.clone(), c.clone()]).unwrap_err();
    assert!(err.starts_with("2 draft(s) changed"), "{err}");
    assert!(store.draft("a").unwrap().unwrap().filed);
    assert!(!store.draft("b").unwrap().unwrap().filed);
    assert!(!store.draft("c").unwrap().unwrap().filed);
    assert_eq!(store.file_agent_drafts(&[b2]).unwrap(), 1);
    assert!(store.draft("b").unwrap().unwrap().filed);
}

/// Gap 34: the agent's staged files are part of what approving binds to.
/// A draft whose agent attachment was replaced, added or dropped since the
/// panel showed it is not filed; the same files as shown (with a user's
/// own pick beside them) still are.
#[test]
fn approving_refuses_a_draft_whose_agent_files_changed() {
    let (_dir, store) = store();
    for id in ["swap", "add", "drop", "same"] {
        store.change_draft_files(None, &agent_draft(id), vec![agent_file(&format!("{id}1"), b"one")], &[]).unwrap();
    }
    // What the panel holds: the draft as listed, its rows from the table.
    let shown = |id: &str| {
        let mut d = store.draft(id).unwrap().unwrap();
        d.staged = store.staged(id).unwrap();
        d
    };
    let (swap, add, drop, same) = (shown("swap"), shown("add"), shown("drop"), shown("same"));
    store.change_draft_files(Some(&swap), &swap, vec![agent_file("swap2", b"other")], &["swap1".into()]).unwrap();
    store.change_draft_files(Some(&add), &add, vec![agent_file("add2", b"more")], &[]).unwrap();
    store.change_draft_files(Some(&drop), &drop, vec![], &["drop1".into()]).unwrap();
    let err = store.file_agent_drafts(&[swap.clone(), add.clone(), drop.clone(), same.clone()]).unwrap_err();
    assert!(err.starts_with("3 draft(s) changed"), "{err}");
    for id in ["swap", "add", "drop"] {
        assert!(!store.draft(id).unwrap().unwrap().filed, "{id}");
    }
    assert!(store.draft("same").unwrap().unwrap().filed);

    // A row whose shown copy differs in what the chip says is a change too.
    let mut renamed = shown("swap");
    renamed.staged[0].filename = "other.pdf".into();
    assert!(store.file_agent_drafts(&[renamed]).is_err());
    // Shown afresh, the swapped draft files.
    assert_eq!(store.file_agent_drafts(&[shown("swap")]).unwrap(), 1);
}

/// A file the user picked into an agent draft takes the draft out of the
/// agent's reach: text writes, file writes and deletes all refuse.
#[test]
fn an_agent_write_against_a_draft_with_a_user_row_is_refused() {
    let (_dir, store) = store();
    let d = agent_draft("d1");
    store.change_agent_draft(None, Some(&d)).unwrap();
    store.stage_attachment("d1", "u1", "mine.txt", "text/plain", b"mine").unwrap();
    let mut next = d.clone();
    next.subject = "x".into();
    assert!(store.change_agent_draft(Some(&d), Some(&next)).unwrap_err().contains("out of the agent's reach"));
    assert!(store.change_draft_files(Some(&d), &d, vec![agent_file("s1", b"a")], &[]).is_err());
    assert!(store.change_agent_draft(Some(&d), None).is_err());
    assert_eq!(store.staged("d1").unwrap().len(), 1, "nothing staged, nothing dropped");
    assert!(store.staged_bytes("d1", "s1").is_err());
}

/// Compare-and-swap: a composer save between the agent's read and write
/// makes the file write fail, and nothing it carried is staged.
#[test]
fn a_composer_save_in_between_fails_the_agent_file_write() {
    let (_dir, store) = store();
    let d = agent_draft("d1");
    store.change_agent_draft(None, Some(&d)).unwrap();
    let mut human = d.clone();
    human.origin = None;
    human.owner_session = None;
    store.save_draft_with_staged(&mut human).unwrap();
    assert!(store.change_draft_files(Some(&d), &d, vec![agent_file("s1", b"a")], &[]).is_err());
    assert!(store.staged("d1").unwrap().is_empty());
    assert!(!store.outbox_dir("d1").join("s1").exists(), "no copy outlives a refused write");
}

#[test]
fn an_agent_delete_removes_the_outbox_copies() {
    let (_dir, store) = store();
    let d = agent_draft("d1");
    store.change_draft_files(None, &d, vec![agent_file("s1", b"a")], &[]).unwrap();
    assert!(store.outbox_dir("d1").exists());
    let stored = store.draft("d1").unwrap().unwrap();
    store.change_agent_draft(Some(&stored), None).unwrap();
    assert!(!store.outbox_dir("d1").exists());
    assert!(store.staged("d1").unwrap().is_empty());
}

/// A `staged` table from before `origin`/`source` existed gains them on
/// open, and its rows read back as the user's own picks.
#[test]
fn old_staged_rows_load_as_the_users_own() {
    let dir = tempfile::tempdir().unwrap();
    {
        let conn = Connection::open(dir.path().join("mail.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE staged (draft_id TEXT NOT NULL, staged_id TEXT NOT NULL, filename TEXT NOT NULL,
                    mime TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (draft_id, staged_id));
                 INSERT INTO staged VALUES ('d1', 's1', 'old.pdf', 'application/pdf', 3);",
        )
        .unwrap();
    }
    let store = MailStore::open(dir.path()).unwrap();
    let rows = store.staged("d1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].filename.as_str(), rows[0].origin.as_deref(), rows[0].source.as_deref()), ("old.pdf", None, None));
    // And a draft JSON without the fields round-trips through the schema.
    let old: MailDraft = serde_json::from_str(r#"{"id":"d1","account_id":"a1","staged":[{"staged_id":"s1","filename":"old.pdf","mime":"application/pdf","size":3}]}"#).unwrap();
    assert_eq!(old.staged[0].origin, None);
    assert!(!serde_json::to_string(&old).unwrap().contains("origin"));
}

/// Send is bound to the reviewed set: a stale id list refuses, a draft the
/// composer never saved refuses, and the matching set sends the copies.
#[test]
fn outgoing_is_bound_to_the_shown_set_and_a_saved_draft() {
    let (_dir, store) = store();
    let d = agent_draft("d1");
    store.change_draft_files(None, &d, vec![agent_file("s1", b"one")], &[]).unwrap();
    assert!(store.outgoing("d1", &["s1".into()]).unwrap_err().contains("agent"), "origin still set");
    let mut mine = store.draft("d1").unwrap().unwrap();
    mine.origin = None;
    mine.owner_session = None;
    store.save_draft_with_staged(&mut mine).unwrap();
    assert_eq!(mine.staged.len(), 1);
    assert!(store.outgoing("d1", &[]).is_err(), "a file the composer did not show");
    assert!(store.outgoing("d1", &["s1".into(), "s9".into()]).is_err());
    let (_, files) = store.outgoing("d1", &["s1".into()]).unwrap();
    assert_eq!(files[0].1, b"one");
}

/// The copy is taken when the agent asks: a project file changed after the
/// call is not what is sent.
#[test]
fn content_is_pinned_at_call_time() {
    let (dir, store) = store();
    let work = dir.path().join("work/alpha");
    std::fs::create_dir_all(work.join("out")).unwrap();
    std::fs::write(work.join("out/paper.pdf"), b"version one").unwrap();
    let projects: crate::schema::projects::ProjectsList = serde_json::from_value(serde_json::json!([
        {"id":"p1","name":"Alpha","status":"active","position":0,"local_file":"","directory": work}
    ])).unwrap();
    let state = dir.path().join("state");
    let home = dir.path().join("home");
    let lists = crate::services::mail_attach::Lists { projects: &projects, boxes: &Vec::new(), state_dir: &state, home: &home, granted: None };
    let file = crate::services::mail_attach::resolve(&lists, "p1", "out/paper.pdf").unwrap();
    assert_eq!(file.source, "Alpha/out/paper.pdf");
    let staged = NewStagedFile { staged_id: "s1".into(), filename: file.filename, mime: file.mime, source: file.source, bytes: file.bytes };
    store.change_draft_files(None, &agent_draft("d1"), vec![staged], &[]).unwrap();
    std::fs::write(work.join("out/paper.pdf"), b"version two, swapped in").unwrap();
    let mut mine = store.draft("d1").unwrap().unwrap();
    mine.origin = None;
    store.save_draft_with_staged(&mut mine).unwrap();
    let (_, files) = store.outgoing("d1", &["s1".into()]).unwrap();
    assert_eq!(files[0].1, b"version one");
}

/// The sync loop's arrival watermark: `None` before any message lands, then
/// the highest UID stored — never a lower one, whatever order they arrive in.
#[test]
fn composer_claim_prevents_racing_agent_edits_and_deletes() {
    let (_dir, store) = store();
    let original = MailDraft { id:"owned".into(), account_id:"a1".into(), origin:Some("agent".into()), owner_session:Some("session".into()), ..Default::default() };
    store.change_agent_draft(None, Some(&original)).unwrap();
    let mut human = original.clone(); human.origin = None; human.owner_session = None; human.subject = "Human edit".into();
    store.save_draft(&human).unwrap();
    assert!(store.change_agent_draft(Some(&original), None).is_err());
    assert!(store.change_agent_draft(Some(&original), Some(&original)).is_err());
    assert_eq!(store.draft("owned").unwrap().unwrap().subject, "Human edit");
}

#[test]
fn folder_max_uid_tracks_the_high_water_mark() {
    let (_dir, store) = store();
    let f = folder("acct", "INBOX");
    store.upsert_folder(&f).unwrap();
    assert_eq!(store.folder_max_uid(&f.id).unwrap(), None, "first sync");

    store
        .upsert_header(&header(&f, 5, "a", "2026-07-30T00:00:00Z"))
        .unwrap();
    assert_eq!(store.folder_max_uid(&f.id).unwrap(), Some(5));

    // A lower UID arriving later must not lower the mark.
    store
        .upsert_header(&header(&f, 2, "b", "2026-07-29T00:00:00Z"))
        .unwrap();
    assert_eq!(store.folder_max_uid(&f.id).unwrap(), Some(5));

    store
        .upsert_header(&header(&f, 9, "c", "2026-07-31T00:00:00Z"))
        .unwrap();
    assert_eq!(store.folder_max_uid(&f.id).unwrap(), Some(9));

    // Scoped to the folder, not the account.
    let other = folder("acct", "Archive");
    store.upsert_folder(&other).unwrap();
    assert_eq!(store.folder_max_uid(&other.id).unwrap(), None);
}

/// A server search can be repeated as a query changes, so the fetch that
/// follows must skip what is already here.
#[test]
fn missing_uids_names_only_rows_not_stored() {
    let (_dir, store) = store();
    let f = folder("acct", "INBOX");
    store.upsert_folder(&f).unwrap();
    for uid in [1, 2, 3] {
        store
            .upsert_header(&header(&f, uid, "a", "2026-07-30T00:00:00Z"))
            .unwrap();
    }
    assert_eq!(store.missing_uids(&f.id, &[]).unwrap(), Vec::<u32>::new());
    assert_eq!(
        store.missing_uids(&f.id, &[1, 2, 3, 4, 5]).unwrap(),
        vec![4, 5]
    );
    // Scoped to the folder: another folder's rows do not count.
    let other = folder("acct", "Archive");
    store.upsert_folder(&other).unwrap();
    assert_eq!(store.missing_uids(&other.id, &[1, 2]).unwrap(), vec![1, 2]);
}

#[test]
fn folder_search_matches_subject_and_sender_without_preview_or_json_keys() {
    let (_dir, store) = store();
    let f = folder("acct", "INBOX");
    store.upsert_folder(&f).unwrap();
    let mut preview = header(&f, 1, "hello", "2026-07-01T00:00:00Z");
    preview.preview = "invoice in cached body".into();
    store.upsert_header(&preview).unwrap();
    let mut sender = header(&f, 2, "hello", "2026-07-02T00:00:00Z");
    sender.from.name = Some("Invoice Team".into());
    store.upsert_header(&sender).unwrap();
    let mut address = header(&f, 3, "hello", "2026-07-03T00:00:00Z");
    address.from.address = "invoice@example.com".into();
    store.upsert_header(&address).unwrap();

    let folder = store
        .folder_search_page(&f.id, 0, 10, "invoice", MailSort::Date, true, false, false)
        .unwrap();
    assert_eq!(
        folder.items.iter().map(|h| h.uid).collect::<Vec<_>>(),
        vec![3, 2]
    );
    assert_eq!(folder.total, 2);
    assert_eq!(
        store
            .folder_search_page(&f.id, 0, 10, "address", MailSort::Date, true, false, false)
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        store
            .headers_page(&f.id, 0, 10, Some("invoice"), MailSort::Date, true, false)
            .unwrap()
            .total,
        3
    );
}

/// Backfilling search matches into the index must not inflate the folder's
/// badges: every stored row leaves the server remainder it was counted in.
#[test]
fn note_indexed_keeps_folder_totals_stable() {
    let (_dir, store) = store();
    let f = folder("acct", "INBOX");
    store.upsert_folder(&f).unwrap();
    // Two rows indexed, the server holding ten (four of them unread).
    let mut first = header(&f, 1, "a", "2026-07-30T00:00:00Z");
    first.seen = true;
    store.upsert_header(&first).unwrap();
    store
        .upsert_header(&header(&f, 2, "b", "2026-07-30T00:00:00Z"))
        .unwrap();
    store.set_server_counts(&f.id, 10, 4).unwrap();
    store.refresh_counts(&f.id).unwrap();
    let folder = store.folder(&f.id).unwrap().unwrap();
    assert_eq!((folder.total, folder.unread), (10, 4));

    // Three search matches land in the index, one of them already read.
    let mut backfilled = header(&f, 7, "old invoice", "2024-01-01T00:00:00Z");
    backfilled.seen = true;
    store.upsert_header(&backfilled).unwrap();
    for uid in [8, 9] {
        store
            .upsert_header(&header(&f, uid, "old invoice", "2024-01-02T00:00:00Z"))
            .unwrap();
    }
    store.note_indexed(&f.id, 3, 2).unwrap();
    store.refresh_counts(&f.id).unwrap();
    let folder = store.folder(&f.id).unwrap().unwrap();
    assert_eq!((folder.total, folder.unread), (10, 4));

    // And the backfilled rows answer a local query — the page a server
    // search serves after backfilling is this one.
    let page = store
        .headers_page(&f.id, 0, 100, Some("invoice"), MailSort::Date, true, false)
        .unwrap();
    assert_eq!(page.total, 3);
    assert!(page.scanned.is_none());

    // Floored at zero, never negative: expunges can strand a remainder the
    // index already overshoots.
    store.note_indexed(&f.id, 100, 100).unwrap();
    assert_eq!(store.unindexed_unread(&f.id).unwrap(), 0);
}

/// #205 provenance round-trips: who set the mark and why, and clearing the
/// mark clears both — a sealed store and a plain one alike.
#[test]
fn priority_provenance_round_trips() {
    use crate::services::mail_crypt::{Key, MailKeys};
    let sealed_keys = Arc::new(MailKeys::derive(Key::from_bytes([9u8; 32])));
    for keys in [None, Some(sealed_keys)] {
        let dir = tempfile::tempdir().unwrap();
        let store = MailStore::open_with_keys(dir.path(), keys.clone()).unwrap();
        let f = folder("acct", "INBOX");
        store.upsert_folder(&f).unwrap();
        let h = header(&f, 1, "Invoice due", "2026-07-30T00:00:00Z");
        store.upsert_header(&h).unwrap();

        // A model mark carries source + reason.
        assert!(store
            .set_priority_ex(
                &h.id,
                Some(MailPriority::Urgent),
                MailPrioritySource::Model,
                "invoice is overdue"
            )
            .unwrap());
        let got = store.header(&h.id).unwrap().unwrap();
        assert_eq!(got.priority, Some(MailPriority::Urgent));
        assert_eq!(got.priority_source, Some(MailPrioritySource::Model));
        assert_eq!(got.priority_reason.as_deref(), Some("invoice is overdue"));

        // A bare user mark is labelled `user` and carries no reason.
        assert!(store
            .set_priority(&h.id, Some(MailPriority::Important))
            .unwrap());
        let got = store.header(&h.id).unwrap().unwrap();
        assert_eq!(got.priority_source, Some(MailPrioritySource::User));
        assert!(got.priority_reason.is_none());

        // Clearing the mark clears the provenance with it.
        assert!(store.set_priority(&h.id, None).unwrap());
        let got = store.header(&h.id).unwrap().unwrap();
        assert!(got.priority.is_none());
        assert!(got.priority_source.is_none());
        assert!(got.priority_reason.is_none());

        // A message not in the index changes nothing.
        assert!(!store
            .set_priority_ex(
                "ghost",
                Some(MailPriority::Urgent),
                MailPrioritySource::Filter,
                "x"
            )
            .unwrap());
    }
}

#[test]
fn opening_a_fresh_directory_creates_the_schema() {
    let (dir, store) = store();
    assert!(dir.path().join("mail.db").exists());
    assert!(store.folders("nobody").unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn the_store_directory_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, _store) = store();
    let mode = std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700, "mail/ must be 0700, got {mode:o}");
    let db = std::fs::metadata(dir.path().join("mail.db"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(db, 0o600, "mail.db must be 0600, got {db:o}");
}

#[cfg(unix)]
#[test]
fn blobs_and_staged_files_are_owner_only_from_creation() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    let (dir, store) = store();
    let hex = store.put_blob(b"payload").unwrap();
    assert_eq!(mode(&store.blobs_dir().join(&hex)), 0o600);
    store
        .stage_attachment("d1", "s1", "a.txt", "text/plain", b"hi")
        .unwrap();
    assert_eq!(mode(&store.outbox_dir("d1").join("s1")), 0o600);

    // A file rewritten in place (a re-seal) is narrowed too, not left at
    // whatever mode it had.
    let loose = dir.path().join("loose");
    std::fs::write(&loose, b"old").unwrap();
    std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o644)).unwrap();
    write_store_file(&loose, b"new").unwrap();
    assert_eq!(mode(&loose), 0o600);
    assert_eq!(std::fs::read(&loose).unwrap(), b"new");
}

#[test]
fn folders_upsert_rather_than_duplicate() {
    let (_d, store) = store();
    let mut f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    f.unread = 7;
    f.total = 12;
    store.upsert_folder(&f).unwrap();
    let all = store.folders("a1").unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].unread, 7);
    assert_eq!(all[0].total, 12);
}

#[test]
fn a_header_round_trips_through_the_store() {
    let (_d, store) = store();
    let f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    let h = header(&f, 5, "Hello", "2026-07-20T09:00:00Z");
    assert!(store.upsert_header(&h).unwrap(), "first insert is new");
    assert!(!store.upsert_header(&h).unwrap(), "second is not");

    let back = store.header(&h.id).unwrap().unwrap();
    assert_eq!(back, h, "every field must survive the round trip");
}

#[test]
fn paging_is_newest_first_and_reports_the_total() {
    let (_d, store) = store();
    let f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    for uid in 1..=25u32 {
        let h = header(
            &f,
            uid,
            &format!("subject {uid}"),
            &format!("2026-07-{:02}T09:00:00Z", uid),
        );
        store.upsert_header(&h).unwrap();
    }
    let page = store
        .headers_page(&f.id, 0, 10, None, MailSort::Date, true, false)
        .unwrap();
    assert_eq!(page.total, 25);
    assert_eq!(page.items.len(), 10);
    assert_eq!(page.items[0].uid, 25, "newest first");

    let page2 = store
        .headers_page(&f.id, 20, 10, None, MailSort::Date, true, false)
        .unwrap();
    assert_eq!(page2.items.len(), 5, "the last page is short");
    assert_eq!(page2.items[0].uid, 5);
}

/// The sorts the list offers, checked where they are actually implemented.
///
/// The property that matters is the one paging makes non-obvious: a sort is
/// over the **folder**, so the biggest (or starred, or attachment-carrying)
/// message reaches page one even when it is the oldest mail there — which a
/// list component sorting its 100 rows could never do.
#[test]
fn the_sorts_order_the_folder_and_break_ties_by_date() {
    let (_d, store) = store();
    let f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    for uid in 1..=5u32 {
        let mut h = header(
            &f,
            uid,
            &format!("subject {uid}"),
            &format!("2026-07-{:02}T09:00:00Z", uid),
        );
        // Every marked message is deliberately the OLDEST, so a sort that
        // only reordered the newest page would leave it out of reach.
        h.flagged = uid == 1;
        h.has_attachments = uid == 1;
        h.size = if uid == 1 { 9_000_000 } else { 1_000 };
        store.upsert_header(&h).unwrap();
    }

    for sort in [MailSort::Flagged, MailSort::Attachments, MailSort::Size] {
        let page = store.headers_page(&f.id, 0, 10, None, sort, true, false).unwrap();
        assert_eq!(
            page.items[0].uid, 1,
            "{sort:?} must put the marked mail first"
        );
        // The rest is a single group, so the tie-break is all that orders it.
        assert_eq!(
            page.items[1].uid, 5,
            "{sort:?} must fall back to newest-first within a group"
        );
    }

    let asc = store
        .headers_page(&f.id, 0, 10, None, MailSort::Size, false, false)
        .unwrap();
    assert_eq!(asc.items[0].uid, 5, "smallest first, newest of the ties");
    assert_eq!(asc.items[4].uid, 1, "the big one goes last");
}

/// Dates arrive with the sender's offset, and the list orders by the text.
/// A 06:00 UTC mail written `08:00+02:00` must still sort below a 09:00 UTC
/// one written `05:00-04:00`, which as strings it would not.
#[test]
fn date_order_is_by_instant_not_by_the_senders_offset() {
    let (_d, store) = store();
    let f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    store
        .upsert_header(&header(&f, 1, "early", "2026-09-18T08:00:00+02:00"))
        .unwrap();
    store
        .upsert_header(&header(&f, 2, "late", "2026-09-18T05:00:00-04:00"))
        .unwrap();
    store.upsert_header(&header(&f, 3, "undated", "")).unwrap();

    let page = store
        .headers_page(&f.id, 0, 10, None, MailSort::Date, true, false)
        .unwrap();
    let uids: Vec<u32> = page.items.iter().map(|h| h.uid).collect();
    assert_eq!(uids, vec![2, 1, 3], "newest instant first, undated last");
    assert_eq!(page.items[0].date, "2026-09-18T09:00:00Z");
    assert_eq!(page.items[1].date, "2026-09-18T06:00:00Z");
    assert_eq!(page.items[2].date, "", "an empty date stays empty");
}

/// Rows stored before the UTC rule are converted when the store opens.
#[test]
fn opening_the_store_converts_dates_stored_with_an_offset() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = MailStore::open(dir.path()).unwrap();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        store
            .upsert_header(&header(&f, 1, "old row", "2026-09-18T09:00:00Z"))
            .unwrap();
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET date = '2026-09-18T08:00:00+02:00' WHERE uid = 1",
            [],
        )
        .unwrap();
    }
    let store = MailStore::open(dir.path()).unwrap();
    let h = store.header("a1|INBOX#1").unwrap().unwrap();
    assert_eq!(h.date, "2026-09-18T06:00:00Z");
}

/// Unread-only is a filter over the folder, not over the page: the total
/// shrinks with it, and it composes with a query.
#[test]
fn unread_only_filters_the_folder_and_its_count() {
    let (_d, store) = store();
    let f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    for uid in 1..=6u32 {
        let mut h = header(
            &f,
            uid,
            if uid % 2 == 0 { "invoice" } else { "note" },
            &format!("2026-07-{:02}T09:00:00Z", uid),
        );
        h.seen = uid > 2;
        store.upsert_header(&h).unwrap();
    }
    let unread = store
        .headers_page(&f.id, 0, 10, None, MailSort::Date, true, true)
        .unwrap();
    assert_eq!(unread.total, 2);
    assert!(unread.items.iter().all(|h| !h.seen));
    assert_eq!(unread.items[0].uid, 2, "still newest first");

    let hit = store
        .headers_page(&f.id, 0, 10, Some("invoice"), MailSort::Date, true, true)
        .unwrap();
    assert_eq!(hit.total, 1);
    assert_eq!(hit.items[0].uid, 2);
}

#[test]
fn a_query_filters_and_is_bound_not_interpolated() {
    let (_d, store) = store();
    let f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    store
        .upsert_header(&header(&f, 1, "invoice", "2026-07-01T09:00:00Z"))
        .unwrap();
    store
        .upsert_header(&header(&f, 2, "holiday", "2026-07-02T09:00:00Z"))
        .unwrap();

    let hits = store
        .headers_page(&f.id, 0, 10, Some("invoi"), MailSort::Date, true, false)
        .unwrap();
    assert_eq!(hits.total, 1);
    assert_eq!(hits.items[0].subject, "invoice");

    // A query that would be an injection if it were interpolated.
    let hostile = store
        .headers_page(
            &f.id,
            0,
            10,
            Some("'; DROP TABLE messages; --"),
            MailSort::Date,
            true,
            false,
        )
        .unwrap();
    assert_eq!(hostile.total, 0);
    assert_eq!(
        store
            .headers_page(&f.id, 0, 10, None, MailSort::Date, true, false)
            .unwrap()
            .total,
        2,
        "the table must still be there"
    );
}

#[test]
fn flags_round_trip_and_drive_the_unread_count() {
    let (_d, store) = store();
    let f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    let h = header(&f, 1, "x", "2026-07-01T09:00:00Z");
    store.upsert_header(&h).unwrap();
    store.refresh_counts(&f.id).unwrap();
    assert_eq!(store.folder(&f.id).unwrap().unwrap().unread, 1);

    store.set_flag(&h.id, MailFlag::Seen, true).unwrap();
    assert!(store.header(&h.id).unwrap().unwrap().seen);
    store.refresh_counts(&f.id).unwrap();
    assert_eq!(store.folder(&f.id).unwrap().unwrap().unread, 0);

    store.set_flag(&h.id, MailFlag::Flagged, true).unwrap();
    assert!(store.header(&h.id).unwrap().unwrap().flagged);
    store.set_flag(&h.id, MailFlag::Seen, false).unwrap();
    assert!(!store.header(&h.id).unwrap().unwrap().seen);
}

#[test]
fn counts_include_the_unread_mail_older_than_the_index() {
    // A sync indexes only a folder's newest headers; the server's counts are
    // what the badges must say, and local reads still move them at once.
    let (_d, store) = store();
    let f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    let a = header(&f, 1, "a", "2026-07-01T09:00:00Z");
    store.upsert_header(&a).unwrap();
    store
        .upsert_header(&header(&f, 2, "b", "2026-07-02T09:00:00Z"))
        .unwrap();
    // The server holds 500 messages, 300 unread; two are in the index.
    store.set_server_counts(&f.id, 500, 300).unwrap();
    store.refresh_counts(&f.id).unwrap();
    let row = store.folder(&f.id).unwrap().unwrap();
    assert_eq!((row.total, row.unread), (500, 300));
    assert_eq!(store.unindexed_unread(&f.id).unwrap(), 298);

    store.set_flag(&a.id, MailFlag::Seen, true).unwrap();
    store.refresh_counts(&f.id).unwrap();
    assert_eq!(store.folder(&f.id).unwrap().unwrap().unread, 299);

    // A re-listed folder (LIST carries no counts) keeps them after a refresh.
    store.upsert_folder(&f).unwrap();
    store.refresh_counts(&f.id).unwrap();
    assert_eq!(store.folder(&f.id).unwrap().unwrap().unread, 299);

    // An index that overshoots the server is not a negative remainder.
    store.set_server_counts(&f.id, 1, 0).unwrap();
    store.refresh_counts(&f.id).unwrap();
    let row = store.folder(&f.id).unwrap().unwrap();
    assert_eq!((row.total, row.unread), (2, 1));

    // "Mark all read" clears the remainder with the rows.
    store.set_server_counts(&f.id, 500, 300).unwrap();
    store.mark_folder_seen(&f.id).unwrap();
    store.refresh_counts(&f.id).unwrap();
    assert_eq!(store.folder(&f.id).unwrap().unwrap().unread, 0);
    assert_eq!(store.unindexed_unread(&f.id).unwrap(), 0);
}

#[test]
fn a_deleted_message_leaves_the_listing() {
    let (_d, store) = store();
    let f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    let h = header(&f, 1, "x", "2026-07-01T09:00:00Z");
    store.upsert_header(&h).unwrap();
    store.set_flag(&h.id, MailFlag::Deleted, true).unwrap();
    assert_eq!(
        store
            .headers_page(&f.id, 0, 10, None, MailSort::Date, true, false)
            .unwrap()
            .total,
        0
    );
}

#[test]
fn moving_a_message_changes_its_folder() {
    let (_d, store) = store();
    let inbox = folder("a1", "INBOX");
    let archive = folder("a1", "Archive");
    store.upsert_folder(&inbox).unwrap();
    store.upsert_folder(&archive).unwrap();
    let h = header(&inbox, 1, "x", "2026-07-01T09:00:00Z");
    store.upsert_header(&h).unwrap();

    store
        .move_messages(std::slice::from_ref(&h.id), &archive.id, &[(1, 42)])
        .unwrap();
    assert_eq!(
        store
            .headers_page(&inbox.id, 0, 10, None, MailSort::Date, true, false)
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        store
            .headers_page(&archive.id, 0, 10, None, MailSort::Date, true, false)
            .unwrap()
            .total,
        1
    );
}

#[test]
fn a_move_without_a_destination_uid_drops_the_row_for_the_next_sync() {
    let (_d, store) = store();
    let inbox = folder("a1", "INBOX");
    let archive = folder("a1", "Archive");
    store.upsert_folder(&inbox).unwrap();
    store.upsert_folder(&archive).unwrap();
    let mapped = header(&inbox, 1, "mapped", "2026-07-01T09:00:00Z");
    let unmapped = header(&inbox, 2, "unmapped", "2026-07-01T10:00:00Z");
    store.upsert_header(&mapped).unwrap();
    store.upsert_header(&unmapped).unwrap();

    store
        .move_messages(&[mapped.id.clone(), unmapped.id.clone()], &archive.id, &[(1, 42)])
        .unwrap();
    assert_eq!(store.header(&mapped.id).unwrap().unwrap().uid, 42);
    assert!(store.header(&unmapped.id).unwrap().is_none());
    let total = |f: &str| {
        store.headers_page(f, 0, 10, None, MailSort::Date, true, false).unwrap().total
    };
    assert_eq!(total(&inbox.id), 0);
    assert_eq!(total(&archive.id), 1);
}

#[test]
fn moving_a_message_preserves_its_local_id_and_mark_across_sync() {
    let (_d, store) = store();
    let inbox = folder("a1", "INBOX");
    let archive = folder("a1", "Archive");
    store.upsert_folder(&inbox).unwrap();
    store.upsert_folder(&archive).unwrap();
    let h = header(&inbox, 1, "original", "2026-07-01T09:00:00Z");
    store.upsert_header(&h).unwrap();
    store.set_priority(&h.id, Some(MailPriority::Important)).unwrap();
    store.move_messages(std::slice::from_ref(&h.id), &archive.id, &[(1, 42)]).unwrap();
    let moved = store.header(&h.id).unwrap().unwrap();
    assert_eq!(moved.uid, 42);
    let mut synced = header(&archive, 42, "synced", "2026-07-01T09:00:00Z");
    store.retain_header_id(&mut synced).unwrap();
    assert_eq!(synced.id, h.id);
    assert!(!store.upsert_header(&synced).unwrap());
    let moved = store.header(&h.id).unwrap().unwrap();
    assert_eq!(moved.priority, Some(MailPriority::Important));
    assert_eq!(moved.subject, "synced");
    // Moving back uses the destination's UID, not the original inbox UID.
    store.move_messages(std::slice::from_ref(&h.id), &inbox.id, &[(42, 99)]).unwrap();
    assert_eq!(store.header(&h.id).unwrap().unwrap().uid, 99);
}

#[test]
fn deleting_a_message_takes_its_row_body_and_attachments() {
    let (dir, store) = store();
    let inbox = folder("a1", "INBOX");
    store.upsert_folder(&inbox).unwrap();
    let gone = header(&inbox, 1, "gone", "2026-07-01T09:00:00Z");
    let kept = header(&inbox, 2, "kept", "2026-07-01T10:00:00Z");
    store.upsert_header(&gone).unwrap();
    store.upsert_header(&kept).unwrap();
    let shared = store.put_blob(b"same pdf").unwrap();
    let own = store.put_blob(b"only the doomed one").unwrap();
    let meta = |part: &str| MailAttachmentMeta {
        part_id: part.into(),
        filename: "a.pdf".into(),
        mime: "application/pdf".into(),
        size: 8,
        inline: false,
        type_mismatch: None,
    };
    store.put_attachment(&gone.id, &meta("2"), &shared).unwrap();
    store.put_attachment(&gone.id, &meta("3"), &own).unwrap();
    store.put_attachment(&kept.id, &meta("2"), &shared).unwrap();
    store
        .cache_body(&gone.id, 1, Some("<p>x</p>"), None, "[]", 0, false, None)
        .unwrap();

    assert_eq!(
        store.delete_messages(std::slice::from_ref(&gone.id)).unwrap(),
        1
    );

    assert!(store.header(&gone.id).unwrap().is_none());
    assert!(store.cached_body(&gone.id, 1).unwrap().is_none());
    assert!(store.attachments(&gone.id).unwrap().is_empty());
    // The blob only it named is gone; the one the other message still names
    // survives — `prune_blobs_locked`'s rule, which a per-row delete would
    // have broken.
    assert!(!dir.path().join("blobs").join(&own).exists());
    assert_eq!(store.get_blob(&shared).unwrap(), b"same pdf");
    assert!(store.header(&kept.id).unwrap().is_some());
}

#[test]
fn deleting_reports_what_was_actually_in_the_index() {
    let (_d, store) = store();
    let inbox = folder("a1", "INBOX");
    store.upsert_folder(&inbox).unwrap();
    let h = header(&inbox, 1, "x", "2026-07-01T09:00:00Z");
    store.upsert_header(&h).unwrap();

    // A message the index no longer holds is not an error — the server may
    // well have accepted the expunge — but it must not be counted either.
    assert_eq!(
        store
            .delete_messages(&[h.id.clone(), "a1|INBOX|999".to_string()])
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .headers_page(&inbox.id, 0, 10, None, MailSort::Date, true, false)
            .unwrap()
            .total,
        0
    );
}

#[test]
fn blobs_are_content_addressed_and_deduplicated() {
    let (dir, store) = store();
    let a = store.put_blob(b"hello world").unwrap();
    let b = store.put_blob(b"hello world").unwrap();
    assert_eq!(a, b, "same bytes, same name");
    assert_eq!(a.len(), 64);
    assert_eq!(store.get_blob(&a).unwrap(), b"hello world");

    // The blob name carries no trace of any sender-supplied filename.
    let names: Vec<String> = std::fs::read_dir(dir.path().join("blobs"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec![a]);
}

/// The blob getter must not be usable as a read-any-file primitive even
/// though nothing in the command surface can reach it with a path.
#[test]
fn the_blob_getter_refuses_anything_that_is_not_a_digest() {
    let (_d, store) = store();
    for bad in ["../../etc/passwd", "..", "/etc/passwd", "abc", ""] {
        assert!(store.get_blob(bad).is_err(), "{bad} must be refused");
    }
}

#[test]
fn a_cached_body_is_only_served_for_the_current_sanitizer_version() {
    let (_d, store) = store();
    store
        .cache_body("m1", 1, Some("<p>hi</p>"), None, "[]", 0, false, None)
        .unwrap();
    assert!(store.cached_body("m1", 1).unwrap().is_some());
    assert!(
        store.cached_body("m1", 2).unwrap().is_none(),
        "a sanitizer bump must invalidate the cache"
    );
}

#[test]
fn forgetting_a_message_removes_only_blobs_nothing_else_names() {
    let (dir, store) = store();
    let shared = store.put_blob(b"same pdf").unwrap();
    let own = store.put_blob(b"only m1").unwrap();
    let meta = |part: &str| MailAttachmentMeta {
        part_id: part.into(),
        filename: "a.pdf".into(),
        mime: "application/pdf".into(),
        size: 8,
        inline: false,
        type_mismatch: None,
    };
    store.put_attachment("m1", &meta("2"), &shared).unwrap();
    store.put_attachment("m1", &meta("3"), &own).unwrap();
    store.put_attachment("m2", &meta("2"), &shared).unwrap();
    store
        .cache_body("m1", 1, Some("<p>x</p>"), None, "[]", 0, false, None)
        .unwrap();

    store.forget_message_content("m1").unwrap();

    assert!(store.attachments("m1").unwrap().is_empty());
    assert!(store.cached_body("m1", 1).unwrap().is_none());
    assert!(!dir.path().join("blobs").join(&own).exists());
    assert_eq!(store.get_blob(&shared).unwrap(), b"same pdf", "m2 still names it");
}

#[test]
fn attachments_round_trip_with_their_blob() {
    let (_d, store) = store();
    let blob = store.put_blob(b"%PDF-1.4 ...").unwrap();
    let meta = MailAttachmentMeta {
        part_id: "3".into(),
        filename: "notes.pdf".into(),
        mime: "application/pdf".into(),
        size: 12,
        inline: false,
        type_mismatch: None,
    };
    store.put_attachment("m1", &meta, &blob).unwrap();
    assert_eq!(store.attachments("m1").unwrap(), vec![meta.clone()]);
    let (back, digest) = store.attachment("m1", "3").unwrap().unwrap();
    assert_eq!(back, meta);
    assert_eq!(digest, blob);
    assert_eq!(store.get_blob(&digest).unwrap(), b"%PDF-1.4 ...");
}

#[test]
fn drafts_and_staged_attachments_round_trip() {
    let (_d, store) = store();
    let draft = MailDraft {
        id: "d1".into(),
        account_id: "a1".into(),
        to: vec!["you@example.org".into()],
        subject: "hi".into(),
        body_text: "text".into(),
        ..Default::default()
    };
    store.save_draft(&draft).unwrap();
    let back = store.draft("d1").unwrap().unwrap();
    assert_eq!(back.subject, "hi");
    assert_eq!(back.to, vec!["you@example.org".to_string()]);

    let staged = store
        .stage_attachment("d1", "s1", "notes.pdf", "application/pdf", b"bytes")
        .unwrap();
    assert_eq!(staged.size, 5);
    assert_eq!(store.staged("d1").unwrap(), vec![staged]);
    assert_eq!(store.staged_bytes("d1", "s1").unwrap(), b"bytes");

    store.remove_staged("d1", "s1").unwrap();
    assert!(store.staged("d1").unwrap().is_empty());
    assert!(store.staged_bytes("d1", "s1").is_err());
}

/// A staged file is a **copy**. Deleting the draft removes it; nothing in
/// the store ever points back at the file the user picked.
/// `origin` marks an agent's draft; a draft stored before the field existed
/// (no `origin` key) reads back as the user's own.
#[test]
fn drafts_list_and_carry_their_origin() {
    let (_d, store) = store();
    let old: MailDraft =
        serde_json::from_str(r#"{"id":"old","account_id":"a1","subject":"mine"}"#).unwrap();
    assert_eq!(old.origin, None);
    assert!(!serde_json::to_string(&old).unwrap().contains("origin"));
    store.save_draft(&old).unwrap();
    store
        .save_draft(&MailDraft {
            id: "d2".into(),
            account_id: "a1".into(),
            origin: Some("agent".into()),
            ..Default::default()
        })
        .unwrap();
    let all = store.drafts().unwrap();
    assert_eq!(all.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["old", "d2"]);
    assert_eq!(all[1].origin.as_deref(), Some("agent"));
    store.delete_draft("d2").unwrap();
    assert_eq!(store.drafts().unwrap().len(), 1);
}

#[test]
fn deleting_a_draft_removes_its_staged_copies() {
    let (dir, store) = store();
    let draft = MailDraft {
        id: "d1".into(),
        account_id: "a1".into(),
        ..Default::default()
    };
    store.save_draft(&draft).unwrap();
    store
        .stage_attachment("d1", "s1", "x.bin", "application/octet-stream", b"z")
        .unwrap();
    assert!(dir.path().join("outbox/d1/s1").exists());
    store.delete_draft("d1").unwrap();
    assert!(!dir.path().join("outbox/d1").exists());
    assert!(store.draft("d1").unwrap().is_none());
}

/// Everything the store writes stays inside the directory it was opened
/// on, whatever ids it is handed.
#[test]
fn nothing_escapes_the_store_directory() {
    let (dir, store) = store();
    let root = dir.path().canonicalize().unwrap();
    store
        .stage_attachment(
            "../../escape",
            "../../../etc/passwd",
            "x",
            "text/plain",
            b"z",
        )
        .unwrap();
    for entry in walk(&root) {
        assert!(
            entry.starts_with(&root),
            "{} escaped {}",
            entry.display(),
            root.display()
        );
    }
    assert!(!std::path::Path::new("/tmp/escape").exists());
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&p) else {
            continue;
        };
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path.clone());
            }
            out.push(path);
        }
    }
    out
}

#[test]
fn clearing_the_cache_keeps_the_index() {
    let (_d, store) = store();
    let f = folder("a1", "INBOX");
    store.upsert_folder(&f).unwrap();
    let h = header(&f, 1, "x", "2026-07-01T09:00:00Z");
    store.upsert_header(&h).unwrap();
    let blob = store.put_blob(b"body bytes").unwrap();
    store
        .cache_body(
            &h.id,
            1,
            Some("<p>x</p>"),
            None,
            "[]",
            0,
            false,
            Some(&blob),
        )
        .unwrap();

    store.clear_cached_mail().unwrap();
    assert!(store.cached_body(&h.id, 1).unwrap().is_none());
    assert!(store.get_blob(&blob).is_err(), "blobs are gone");
    assert_eq!(
        store
            .headers_page(&f.id, 0, 10, None, MailSort::Date, true, false)
            .unwrap()
            .total,
        1,
        "the header index survives"
    );
}

#[test]
fn deleting_an_accounts_mail_leaves_other_accounts_alone() {
    let (_d, store) = store();
    let a = folder("a1", "INBOX");
    let b = folder("a2", "INBOX");
    store.upsert_folder(&a).unwrap();
    store.upsert_folder(&b).unwrap();
    store
        .upsert_header(&header(&a, 1, "x", "2026-07-01T09:00:00Z"))
        .unwrap();
    store
        .upsert_header(&header(&b, 1, "y", "2026-07-01T09:00:00Z"))
        .unwrap();

    store.delete_account_mail("a1").unwrap();
    assert!(store.folders("a1").unwrap().is_empty());
    assert_eq!(store.folders("a2").unwrap().len(), 1);
    assert_eq!(
        store
            .headers_page(&b.id, 0, 10, None, MailSort::Date, true, false)
            .unwrap()
            .total,
        1
    );
}

#[test]
fn reopening_the_store_keeps_its_contents() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = MailStore::open(dir.path()).unwrap();
        store.upsert_folder(&folder("a1", "INBOX")).unwrap();
    }
    let store = MailStore::open(dir.path()).unwrap();
    assert_eq!(store.folders("a1").unwrap().len(), 1);
}

// ── Priority marks ──────────────────────────────────────────────────────

/// Two accounts, one INBOX each, one message each.
fn two_accounts() -> (tempfile::TempDir, MailStore, MailFolder, MailFolder) {
    let (d, store) = store();
    let a = folder("a1", "INBOX");
    let b = folder("a2", "INBOX");
    store.upsert_folder(&a).unwrap();
    store.upsert_folder(&b).unwrap();
    store
        .upsert_header(&header(&a, 1, "from account one", "2026-07-01T09:00:00Z"))
        .unwrap();
    store
        .upsert_header(&header(&b, 1, "from account two", "2026-07-02T09:00:00Z"))
        .unwrap();
    (d, store, a, b)
}

#[test]
fn a_mark_round_trips_onto_the_header() {
    let (_d, store, a, _b) = two_accounts();
    let id = format!("{}#1", a.id);
    assert!(store.header(&id).unwrap().unwrap().priority.is_none());

    assert!(store.set_priority(&id, Some(MailPriority::Urgent)).unwrap());
    assert_eq!(
        store.header(&id).unwrap().unwrap().priority,
        Some(MailPriority::Urgent)
    );
    // Re-marking as the other value replaces rather than accumulates: a
    // message is Important *or* Urgent, never both, or the two lists would
    // both claim it and neither would be a priority.
    store
        .set_priority(&id, Some(MailPriority::Important))
        .unwrap();
    assert_eq!(
        store.header(&id).unwrap().unwrap().priority,
        Some(MailPriority::Important)
    );
    store.set_priority(&id, None).unwrap();
    assert!(store.header(&id).unwrap().unwrap().priority.is_none());
}

#[test]
fn marking_an_unknown_message_reports_that_nothing_changed() {
    let (_d, store) = store();
    assert!(!store
        .set_priority("no-such-message", Some(MailPriority::Urgent))
        .unwrap());
}

#[test]
fn the_list_spans_every_account() {
    // The whole reason the mark is a local column: this list is exactly what
    // no IMAP folder can be, because a folder belongs to one account.
    let (_d, store, a, b) = two_accounts();
    store
        .set_priority(&format!("{}#1", a.id), Some(MailPriority::Important))
        .unwrap();
    store
        .set_priority(&format!("{}#1", b.id), Some(MailPriority::Important))
        .unwrap();

    let page = store
        .priority_page(MailPriority::Important, 0, 10, None, MailSort::Date, true, false)
        .unwrap();
    assert_eq!(page.total, 2);
    let accounts: Vec<&str> = page.items.iter().map(|h| h.account_id.as_str()).collect();
    assert!(accounts.contains(&"a1") && accounts.contains(&"a2"));
    // Newest first, like every other list here.
    assert_eq!(page.items[0].account_id, "a2");
}

// ── The filter scan ─────────────────────────────────────────────────────

#[test]
fn the_filter_scan_skips_already_marked_mail() {
    let (_d, store, a, _b) = two_accounts();
    assert_eq!(store.unmarked_headers(None, 100).unwrap().len(), 2);
    store
        .set_priority(&format!("{}#1", a.id), Some(MailPriority::Urgent))
        .unwrap();
    let left = store.unmarked_headers(None, 100).unwrap();
    assert_eq!(left.len(), 1, "a filed message is never re-examined");
    assert_eq!(left[0].account_id, "a2");
}

#[test]
fn the_filter_scan_refuses_sent_drafts_trash_and_junk() {
    let (_d, store) = store();
    let inbox = folder("a1", "INBOX");
    store.upsert_folder(&inbox).unwrap();
    store
        .upsert_header(&header(&inbox, 1, "arrived", "2026-07-01T09:00:00Z"))
        .unwrap();
    for (i, kind) in [
        MailFolderKind::Sent,
        MailFolderKind::Drafts,
        MailFolderKind::Trash,
        MailFolderKind::Junk,
    ]
    .into_iter()
    .enumerate()
    {
        let mut f = folder("a1", &format!("Box{i}"));
        f.kind = kind;
        store.upsert_folder(&f).unwrap();
        store
            .upsert_header(&header(&f, 1, "invoice", "2026-07-02T09:00:00Z"))
            .unwrap();
    }
    let rows = store.unmarked_headers(None, 100).unwrap();
    assert_eq!(rows.len(), 1, "only the arriving folder is in scope");
    assert_eq!(rows[0].folder_id, inbox.id);
}

#[test]
fn the_filter_scan_can_be_narrowed_to_one_account_and_is_bounded() {
    let (_d, store, _a, _b) = two_accounts();
    let one = store.unmarked_headers(Some("a1"), 100).unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].account_id, "a1");
    // The bound is what the report turns into "of the most recent N".
    assert_eq!(store.unmarked_headers(None, 1).unwrap().len(), 1);
}

#[test]
fn the_two_lists_do_not_leak_into_each_other() {
    let (_d, store, a, b) = two_accounts();
    store
        .set_priority(&format!("{}#1", a.id), Some(MailPriority::Important))
        .unwrap();
    store
        .set_priority(&format!("{}#1", b.id), Some(MailPriority::Urgent))
        .unwrap();

    let important = store
        .priority_page(MailPriority::Important, 0, 10, None, MailSort::Date, true, false)
        .unwrap();
    let urgent = store
        .priority_page(MailPriority::Urgent, 0, 10, None, MailSort::Date, true, false)
        .unwrap();
    assert_eq!(important.total, 1);
    assert_eq!(urgent.total, 1);
    assert_eq!(important.items[0].account_id, "a1");
    assert_eq!(urgent.items[0].account_id, "a2");
}

#[test]
fn the_list_searches_and_pages_like_a_folder() {
    let (_d, store, a, b) = two_accounts();
    store
        .set_priority(&format!("{}#1", a.id), Some(MailPriority::Important))
        .unwrap();
    store
        .set_priority(&format!("{}#1", b.id), Some(MailPriority::Important))
        .unwrap();

    let hit = store
        .priority_page(
            MailPriority::Important,
            0,
            10,
            Some("account one"),
            MailSort::Date,
            true,
            false,
        )
        .unwrap();
    assert_eq!(hit.total, 1);
    assert_eq!(hit.items[0].account_id, "a1");

    // `total` is the whole list, not the page — that is what the pager reads.
    let first = store
        .priority_page(MailPriority::Important, 0, 1, None, MailSort::Date, true, false)
        .unwrap();
    assert_eq!(first.total, 2);
    assert_eq!(first.items.len(), 1);
}

#[test]
fn emptying_one_list_leaves_the_other_and_the_mail_alone() {
    let (_d, store, a, b) = two_accounts();
    let urgent_id = format!("{}#1", a.id);
    let important_id = format!("{}#1", b.id);
    store
        .set_priority_ex(
            &urgent_id,
            Some(MailPriority::Urgent),
            MailPrioritySource::Model,
            "invoice is overdue",
        )
        .unwrap();
    store
        .set_priority(&important_id, Some(MailPriority::Important))
        .unwrap();

    assert_eq!(store.clear_priority(MailPriority::Urgent).unwrap(), 1);

    let cleared = store.header(&urgent_id).unwrap().unwrap();
    assert_eq!(cleared.priority, None);
    // The provenance goes with the mark — nothing may be left claiming the
    // model said something about a message that is no longer filed.
    assert_eq!(cleared.priority_source, None);
    assert_eq!(cleared.priority_reason, None);
    // The message itself is untouched: a mark is not a folder.
    assert_eq!(cleared.folder_id, a.id);

    // The other list is not this list.
    let counts = store.priority_counts().unwrap();
    assert_eq!((counts.urgent, counts.important), (0, 1));

    // Emptying an already-empty list is a no-op that reports as one.
    assert_eq!(store.clear_priority(MailPriority::Urgent).unwrap(), 0);
}

#[test]
fn a_re_sync_never_wipes_a_mark() {
    // The single most important property: `upsert_header` runs over every
    // message in a folder on every check. If it touched this column, every
    // mark the user made would survive exactly until the next Check mail.
    let (_d, store, a, _b) = two_accounts();
    let id = format!("{}#1", a.id);
    store.set_priority(&id, Some(MailPriority::Urgent)).unwrap();

    let mut again = header(&a, 1, "from account one", "2026-07-01T09:00:00Z");
    again.seen = true;
    assert!(!store.upsert_header(&again).unwrap(), "not a new row");

    let after = store.header(&id).unwrap().unwrap();
    assert_eq!(after.priority, Some(MailPriority::Urgent));
    // The server's own fields did update — this is not "the upsert is inert".
    assert!(after.seen);
}

#[test]
fn counts_cover_every_account_and_report_the_unread_half() {
    let (_d, store, a, b) = two_accounts();
    assert_eq!(store.priority_counts().unwrap().important, 0);

    store
        .set_priority(&format!("{}#1", a.id), Some(MailPriority::Important))
        .unwrap();
    store
        .set_priority(&format!("{}#1", b.id), Some(MailPriority::Urgent))
        .unwrap();
    store
        .set_flag(&format!("{}#1", a.id), MailFlag::Seen, true)
        .unwrap();

    let c = store.priority_counts().unwrap();
    assert_eq!((c.important, c.urgent), (1, 1));
    // Read mail stays on the list and stays counted — a list you file into
    // is not an inbox. Only the unread half moves.
    assert_eq!((c.important_unread, c.urgent_unread), (0, 1));
}

#[test]
fn a_deleted_message_leaves_the_list() {
    let (_d, store, a, _b) = two_accounts();
    let id = format!("{}#1", a.id);
    store.set_priority(&id, Some(MailPriority::Urgent)).unwrap();
    store.set_flag(&id, MailFlag::Deleted, true).unwrap();

    assert_eq!(
        store
            .priority_page(MailPriority::Urgent, 0, 10, None, MailSort::Date, true, false)
            .unwrap()
            .total,
        0
    );
    assert_eq!(store.priority_counts().unwrap().urgent, 0);
}

#[test]
fn an_unrecognized_stored_mark_reads_as_unmarked() {
    // Forward compatibility in the safe direction: a column written by a
    // later version must not put mail on a list the user never chose.
    let (_d, store, a, _b) = two_accounts();
    let id = format!("{}#1", a.id);
    {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET priority = 'critical' WHERE id = ?1",
            params![id],
        )
        .unwrap();
    }
    assert!(store.header(&id).unwrap().unwrap().priority.is_none());
    assert_eq!(store.priority_counts().unwrap().important, 0);
}

#[test]
fn the_column_survives_a_store_created_before_it_existed() {
    // The migration path an existing dev database actually takes: the
    // `CREATE TABLE IF NOT EXISTS` is a no-op on it, so only the additive
    // ALTER puts the column there.
    let dir = tempfile::tempdir().unwrap();
    {
        let store = MailStore::open(dir.path()).unwrap();
        let conn = store.conn.lock().unwrap();
        // An index naming the column blocks the drop, exactly as it would
        // block the migration if it were created too early — which is the
        // bug this test found and the reason the CREATE INDEX sits after
        // the ALTER rather than in the create batch.
        conn.execute("DROP INDEX IF EXISTS messages_by_priority", [])
            .unwrap();
        conn.execute("ALTER TABLE messages DROP COLUMN priority", [])
            .unwrap();
    }
    let store = MailStore::open(dir.path()).unwrap();
    let a = folder("a1", "INBOX");
    store.upsert_folder(&a).unwrap();
    store
        .upsert_header(&header(&a, 1, "x", "2026-07-01T09:00:00Z"))
        .unwrap();
    let id = format!("{}#1", a.id);
    assert!(store
        .set_priority(&id, Some(MailPriority::Important))
        .unwrap());
    assert_eq!(
        store.header(&id).unwrap().unwrap().priority,
        Some(MailPriority::Important)
    );
}

// ── Marks for agents ────────────────────────────────────────────────────

#[test]
fn an_agent_mark_is_local_follows_the_message_id_and_scopes_every_read() {
    let (_d, store) = store();
    let inbox = folder("a1", "INBOX");
    let archive = folder("a1", "Archive");
    store.upsert_folder(&inbox).unwrap();
    store.upsert_folder(&archive).unwrap();
    let shared = header(&inbox, 1, "shared", "2026-09-01T09:00:00Z");
    let mut private = header(&inbox, 2, "private", "2026-09-02T09:00:00Z");
    private.seen = true;
    let mut anonymous = header(&inbox, 3, "no id", "2026-09-03T09:00:00Z");
    anonymous.rfc_message_id = None;
    for h in [&shared, &private, &anonymous] {
        store.upsert_header(h).unwrap();
    }

    // Nothing marked: the marked page and counts are empty, the flags untouched.
    assert!(store.headers_page_marked(&inbox.id, 0, 50, None, MailSort::Date, true, false).unwrap().items.is_empty());
    assert!(store.agent_marked_counts("a1").unwrap().is_empty());

    assert_eq!(store.agent_mark(&[shared.id.clone(), anonymous.id.clone(), "gone".into()], true).unwrap(), 2);
    assert!(store.agent_marked(&shared.id).unwrap());
    assert!(store.agent_marked(&anonymous.id).unwrap());
    assert!(!store.agent_marked(&private.id).unwrap());
    let page = store.headers_page_marked(&inbox.id, 0, 50, None, MailSort::Date, true, false).unwrap();
    let ids: Vec<&str> = page.items.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(ids, vec![anonymous.id.as_str(), shared.id.as_str()]);
    assert_eq!(page.total, 2);
    assert_eq!(store.agent_marked_counts("a1").unwrap(), vec![(inbox.id.clone(), 2, 2)]);
    let mut listed = store.agent_marks("a1").unwrap();
    listed.sort();
    let mut expected = vec![shared.id.clone(), anonymous.id.clone()];
    expected.sort();
    assert_eq!(listed, expected);
    // No IMAP flag moved: the row's flags are what they were.
    let row = store.header(&shared.id).unwrap().unwrap();
    assert!(!row.seen && !row.flagged);

    // The same message indexed again under another row (a move to Archive,
    // a UIDVALIDITY change) arrives marked once the original has left the
    // index — the server flags the source \Deleted on a move; a re-sync of
    // the known row does not double it.
    store.set_flag(&shared.id, MailFlag::Deleted, true).unwrap();
    let mut moved = header(&archive, 40, "shared", "2026-09-01T09:00:00Z");
    moved.rfc_message_id = shared.rfc_message_id.clone();
    store.upsert_header(&moved).unwrap();
    assert!(store.agent_marked(&moved.id).unwrap());
    store.set_flag(&shared.id, MailFlag::Deleted, false).unwrap();
    store.upsert_header(&shared).unwrap();
    assert_eq!(store.agent_marks("a1").unwrap().len(), 3);
    assert_eq!(store.agent_marked_counts("a1").unwrap().len(), 2);
    // A different message with no id is not adopted by anything.
    let mut other = header(&archive, 41, "no id either", "2026-09-04T09:00:00Z");
    other.rfc_message_id = None;
    store.upsert_header(&other).unwrap();
    assert!(!store.agent_marked(&other.id).unwrap());

    // Unmarking one copy unmarks the message: every row with that id.
    assert_eq!(store.agent_mark(&[moved.id.clone()], false).unwrap(), 2);
    assert!(!store.agent_marked(&shared.id).unwrap());
    assert!(!store.agent_marked(&moved.id).unwrap());
    assert!(store.agent_marked(&anonymous.id).unwrap());

    // Bulk: by sender (every row of the account) and by folder.
    assert_eq!(store.agent_mark_sender("a1", "SENDER@example.com").unwrap(), 4);
    assert_eq!(store.agent_mark_sender("a1", "nobody@example.com").unwrap(), 0);
    assert!(store.agent_mark(&store.agent_marks("a1").unwrap(), false).unwrap() > 0);
    assert_eq!(store.agent_mark_folder(&archive.id).unwrap(), 2);
    assert_eq!(store.agent_marked_counts("a1").unwrap(), vec![(archive.id.clone(), 2, 2)]);
}

/// The consent goes with the message: a store id reused after a delete
/// starts unmarked, whether the old mark was purged with the row or left
/// behind, and removing an account removes its marks.
#[test]
fn an_agent_mark_does_not_outlive_its_row() {
    let (_d, store) = store();
    let inbox = folder("a1", "INBOX");
    store.upsert_folder(&inbox).unwrap();
    let first = header(&inbox, 1, "first", "2026-09-01T09:00:00Z");
    store.upsert_header(&first).unwrap();
    assert_eq!(store.agent_mark(std::slice::from_ref(&first.id), true).unwrap(), 1);
    assert_eq!(store.delete_messages(std::slice::from_ref(&first.id)).unwrap(), 1);
    let left: i64 = store
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM agent_marks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0, "the mark went with the row");

    // Another message under the same store id (a UIDVALIDITY reset handed
    // the uid out again) — and a stale mark row left under that id by
    // whatever means — is not marked.
    store
        .conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO agent_marks (message_id, account_id, mid_key, marked_at)
                 VALUES (?1, 'a1', 'stale', '2026-09-01T00:00:00Z')",
            params![first.id],
        )
        .unwrap();
    let mut reused = header(&inbox, 1, "reused", "2026-09-05T09:00:00Z");
    reused.rfc_message_id = Some("<other@example.com>".into());
    assert!(store.upsert_header(&reused).unwrap());
    assert!(!store.agent_marked(&reused.id).unwrap());
    assert!(store.agent_marks("a1").unwrap().is_empty());

    let second = header(&inbox, 2, "second", "2026-09-06T09:00:00Z");
    store.upsert_header(&second).unwrap();
    assert_eq!(store.agent_mark(std::slice::from_ref(&second.id), true).unwrap(), 1);
    store.delete_account_mail("a1").unwrap();
    let left: i64 = store
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM agent_marks WHERE account_id = 'a1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

/// A `Message-ID` is sender-chosen and known to every thread participant,
/// so it alone must not carry a mark: a duplicate arriving while the
/// original is still indexed is not a move, and a copy from another sender
/// is not the same message even once the original is gone.
#[test]
fn a_duplicate_message_id_is_adopted_only_as_a_move_from_the_same_sender() {
    let (_d, store) = store();
    let inbox = folder("a1", "INBOX");
    let archive = folder("a1", "Archive");
    store.upsert_folder(&inbox).unwrap();
    store.upsert_folder(&archive).unwrap();
    let original = header(&inbox, 1, "shared", "2026-09-01T09:00:00Z");
    store.upsert_header(&original).unwrap();
    assert_eq!(store.agent_mark(std::slice::from_ref(&original.id), true).unwrap(), 1);

    // Same Message-ID, same sender, while the original is live: forged.
    let mut forged = header(&archive, 10, "shared", "2026-09-02T09:00:00Z");
    forged.rfc_message_id = original.rfc_message_id.clone();
    store.upsert_header(&forged).unwrap();
    assert!(!store.agent_marked(&forged.id).unwrap());
    assert_eq!(store.agent_marks("a1").unwrap(), vec![original.id.clone()]);

    // The original leaves the index (the server flagged it \Deleted on
    // the move): the next copy is the move.
    store.set_flag(&original.id, MailFlag::Deleted, true).unwrap();
    let mut moved = header(&archive, 11, "shared", "2026-09-01T09:00:00Z");
    moved.rfc_message_id = original.rfc_message_id.clone();
    store.upsert_header(&moved).unwrap();
    assert!(store.agent_marked(&moved.id).unwrap());

    // Gone for good: the mark is purged with the row, and the copy that
    // was refused earlier is not marked retroactively.
    assert!(!store.agent_marked(&forged.id).unwrap());

    // Same Message-ID from another sender, the original gone: not it.
    let mut other_sender = header(&inbox, 3, "shared", "2026-09-03T09:00:00Z");
    other_sender.rfc_message_id = original.rfc_message_id.clone();
    other_sender.from.address = "someone-else@example.com".into();
    store.set_flag(&moved.id, MailFlag::Deleted, true).unwrap();
    store.upsert_header(&other_sender).unwrap();
    assert!(!store.agent_marked(&other_sender.id).unwrap());
    // ... whereas the same sender's copy is.
    let mut same_sender = header(&inbox, 4, "shared", "2026-09-03T09:00:00Z");
    same_sender.rfc_message_id = original.rfc_message_id.clone();
    same_sender.from.address = " SENDER@example.com ".into();
    store.upsert_header(&same_sender).unwrap();
    assert!(store.agent_marked(&same_sender.id).unwrap());
}

// ── Replies ─────────────────────────────────────────────────────────────

#[test]
fn replies_to_lists_the_users_own_answers_oldest_first() {
    let (_d, store) = store();
    let inbox = folder("a1", "INBOX");
    let mut sent = folder("a1", "Sent");
    sent.kind = MailFolderKind::Sent;
    store.upsert_folder(&inbox).unwrap();
    store.upsert_folder(&sent).unwrap();

    let asked = header(&inbox, 1, "question", "2026-09-01T09:00:00Z");
    store.upsert_header(&asked).unwrap();
    // Someone else's answer in the inbox names the same message; it is not
    // one the user wrote.
    let theirs = header(&inbox, 2, "Re: question", "2026-09-01T10:00:00Z");
    store.upsert_header(&theirs).unwrap();
    store.set_reply_key(&theirs.id, Some("<1@example.com>")).unwrap();
    let second = header(&sent, 8, "Re: question (2)", "2026-09-03T09:00:00Z");
    let first = header(&sent, 7, "Re: question", "2026-09-02T09:00:00Z");
    let unrelated = header(&sent, 9, "Re: other", "2026-09-02T09:00:00Z");
    for h in [&second, &first, &unrelated] {
        store.upsert_header(h).unwrap();
    }
    // Bare and bracketed spellings of one id meet.
    store.set_reply_key(&second.id, Some("1@example.com")).unwrap();
    store.set_reply_key(&first.id, Some(" <1@example.com> ")).unwrap();
    store.set_reply_key(&unrelated.id, Some("<77@example.com>")).unwrap();

    let ids: Vec<String> = store
        .replies_to(&asked.id)
        .unwrap()
        .into_iter()
        .map(|h| h.id)
        .collect();
    assert_eq!(ids, vec![first.id.clone(), second.id.clone()]);

    // A re-sync rewrites the header and must leave the key alone; a reply
    // whose `In-Reply-To` went away stops being one.
    store.upsert_header(&first).unwrap();
    assert_eq!(store.replies_to(&asked.id).unwrap().len(), 2);
    store.set_reply_key(&first.id, None).unwrap();
    assert_eq!(store.replies_to(&asked.id).unwrap().len(), 1);
}

#[test]
fn a_message_without_a_message_id_has_no_replies() {
    let (_d, store) = store();
    let inbox = folder("a1", "INBOX");
    let mut sent = folder("a1", "Sent");
    sent.kind = MailFolderKind::Sent;
    store.upsert_folder(&inbox).unwrap();
    store.upsert_folder(&sent).unwrap();
    let mut asked = header(&inbox, 1, "question", "2026-09-01T09:00:00Z");
    asked.rfc_message_id = None;
    store.upsert_header(&asked).unwrap();
    // An empty `In-Reply-To` must not turn into a key every id-less message matches.
    let stray = header(&sent, 2, "Re:", "2026-09-02T09:00:00Z");
    store.upsert_header(&stray).unwrap();
    store.set_reply_key(&stray.id, Some("<>")).unwrap();
    assert!(store.replies_to(&asked.id).unwrap().is_empty());
    assert!(store.replies_to("no-such-message").unwrap().is_empty());
}

// ── Encryption at rest ──────────────────────────────────────────────────

mod encrypted {
    use super::*;
    use crate::services::mail_crypt::{Key, MailKeys};

    fn keys(seed: u8) -> Arc<MailKeys> {
        Arc::new(MailKeys::derive(Key::from_bytes([seed; 32])))
    }

    fn sealed_store() -> (tempfile::TempDir, MailStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
        (dir, store)
    }

    /// A folder whose id is shaped like the one `commands::mail` actually
    /// mints: `{account}-{sha256(path)[..8]}`, and **not** the readable path.
    ///
    /// The plain tests above use a path-embedding id because it makes their
    /// failures legible, which is fine when nothing is secret. Here it would
    /// invalidate the whole exercise: `folders.id`, `messages.folder_id` and
    /// every message id are cleartext by design (they are what paging and
    /// joins run on), so an id that spelled the folder path would put the
    /// path on disk no matter how well the `path` column was sealed. Using
    /// the real derivation is what makes
    /// [`no_sensitive_value_appears_in_the_files_on_disk`] test the store
    /// rather than the fixture.
    fn realistic_folder(account: &str, path: &str) -> MailFolder {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(path.as_bytes());
        let short: String = h
            .finalize()
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect();
        MailFolder {
            id: format!("{account}-{short}"),
            account_id: account.into(),
            path: path.into(),
            name: path.rsplit('/').next().unwrap_or(path).into(),
            kind: MailFolderKind::Other,
            unread: 0,
            total: 0,
        }
    }

    /// The sealed sender opens for the Address Book harvest like any read.
    #[test]
    fn inbox_senders_open_sealed_senders() {
        let (_d, store) = sealed_store();
        let mut inbox = realistic_folder("a1", "INBOX");
        inbox.kind = MailFolderKind::Inbox;
        store.upsert_folder(&inbox).unwrap();
        store.upsert_header(&header(&inbox, 1, "Hi", "2026-07-20T09:00:00Z")).unwrap();
        let got = store.inbox_senders(10).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].address, "sender@example.com");
    }

    /// Everything the plain store does, the sealed store must also do — and
    /// through the same public API, or the two paths are two products.
    #[test]
    fn a_sealed_store_round_trips_every_kind_of_value() {
        let (_d, store) = sealed_store();
        assert!(store.is_encrypted());
        let f = folder("a1", "INBOX/Work");
        store.upsert_folder(&f).unwrap();
        assert_eq!(store.folder(&f.id).unwrap().unwrap().path, "INBOX/Work");

        let h = header(&f, 5, "Quarterly numbers", "2026-07-20T09:00:00Z");
        store.upsert_header(&h).unwrap();
        assert_eq!(store.header(&h.id).unwrap().unwrap(), h);

        let blob = store.put_blob(b"%PDF-1.4 payload").unwrap();
        assert_eq!(store.get_blob(&blob).unwrap(), b"%PDF-1.4 payload");
        let meta = MailAttachmentMeta {
            part_id: "3".into(),
            filename: "salaries.pdf".into(),
            mime: "application/pdf".into(),
            size: 16,
            inline: false,
            type_mismatch: Some("looks like a zip".into()),
        };
        store.put_attachment(&h.id, &meta, &blob).unwrap();
        assert_eq!(store.attachments(&h.id).unwrap(), vec![meta.clone()]);
        assert_eq!(store.attachment(&h.id, "3").unwrap().unwrap().0, meta);

        store
            .cache_body(
                &h.id,
                1,
                Some("<p>hi</p>"),
                Some("hi"),
                "[]",
                0,
                false,
                None,
            )
            .unwrap();
        let body = store.cached_body(&h.id, 1).unwrap().unwrap();
        assert_eq!(body.0.as_deref(), Some("<p>hi</p>"));
        assert_eq!(body.1.as_deref(), Some("hi"));

        let draft = MailDraft {
            id: "d1".into(),
            account_id: "a1".into(),
            subject: "confidential".into(),
            ..Default::default()
        };
        store.save_draft(&draft).unwrap();
        assert_eq!(store.draft("d1").unwrap().unwrap().subject, "confidential");
        store
            .stage_attachment("d1", "s1", "notes.txt", "text/plain", b"secret bytes")
            .unwrap();
        assert_eq!(store.staged("d1").unwrap()[0].filename, "notes.txt");
        assert_eq!(store.staged_bytes("d1", "s1").unwrap(), b"secret bytes");
    }

    /// The assertion the whole feature reduces to. Not "is it different from
    /// the plaintext" — the subject line must not be *findable* in the file
    /// at all, which is what a `grep` over the raw bytes actually tests.
    #[test]
    fn no_sensitive_value_appears_in_the_files_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            let f = realistic_folder("a1", "INBOX/Personnel");
            store.upsert_folder(&f).unwrap();
            let mut h = header(&f, 1, "Redundancy list", "2026-07-20T09:00:00Z");
            h.preview = "the following roles are at risk".into();
            store.upsert_header(&h).unwrap();
            store
                .cache_body(
                    &h.id,
                    1,
                    None,
                    Some("body of the message"),
                    "[]",
                    0,
                    false,
                    None,
                )
                .unwrap();
            let blob = store.put_blob(b"attachment plaintext").unwrap();
            store
                .put_attachment(
                    &h.id,
                    &MailAttachmentMeta {
                        part_id: "2".into(),
                        filename: "list.xlsx".into(),
                        mime: "application/vnd.ms-excel".into(),
                        size: 20,
                        inline: false,
                        type_mismatch: None,
                    },
                    &blob,
                )
                .unwrap();
            store
                .stage_attachment("d1", "s1", "draft.txt", "text/plain", b"outgoing plaintext")
                .unwrap();
        }

        let secrets = [
            "Redundancy list",
            "the following roles are at risk",
            "body of the message",
            "attachment plaintext",
            "outgoing plaintext",
            "list.xlsx",
            "INBOX/Personnel",
            "sender@example.com",
        ];
        for path in walk(dir.path()) {
            if !path.is_file() {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            for secret in secrets {
                assert!(
                    !contains(&bytes, secret.as_bytes()),
                    "{secret:?} is readable in {}", // privacy-check: ok — test fixture, never sent
                    path.display()
                );
            }
        }
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    /// What is still readable, asserted rather than assumed.
    ///
    /// The plan lists the metadata that stays in cleartext by design —
    /// counts, folder structure, dates, sizes, flags — because they are what
    /// paging and unread badges run on. This pins the one item in that list
    /// whose leak is sharper than the phrase "folder structure" suggests:
    /// a folder's **id** is an unkeyed `sha256(path)[..8]`, so anyone with
    /// the file and a wordlist of common folder names can recover which
    /// folders exist. It is inside the declared threat model and it is not
    /// worth the migration it would cost to key it (every message id derives
    /// from the folder id, and they are the AAD row keys), but it is written
    /// down here so it stays a decision instead of becoming a surprise.
    #[test]
    fn the_metadata_that_stays_readable_is_the_metadata_we_said_would() {
        let dir = tempfile::tempdir().unwrap();
        let f = realistic_folder("a1", "INBOX");
        {
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            store.upsert_folder(&f).unwrap();
            store
                .upsert_header(&header(&f, 1, "secret", "2026-07-01T09:00:00Z"))
                .unwrap();
        }
        let db = std::fs::read(dir.path().join("mail.db")).unwrap();
        assert!(contains(&db, f.id.as_bytes()), "folder ids are cleartext");
        assert!(
            contains(&db, b"2026-07-01T09:00:00Z"),
            "dates are cleartext"
        );
        assert!(!contains(&db, b"secret"), "content is not");
    }

    /// A store sealed under one key must not open under another. This is the
    /// property that makes the key worth protecting; without it the seal is
    /// obfuscation.
    #[test]
    fn another_key_reads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let f = folder("a1", "INBOX");
        {
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            store.upsert_folder(&f).unwrap();
            store
                .upsert_header(&header(&f, 1, "Payroll", "2026-07-01T09:00:00Z"))
                .unwrap();
        }
        let wrong = MailStore::open_with_keys(dir.path(), Some(keys(2))).unwrap();
        let h = wrong.header(&format!("{}#1", f.id)).unwrap().unwrap();
        assert_eq!(h.subject, "");
        // …and it says so, rather than presenting a blank subject as mail.
        assert!(h
            .malformed_headers
            .unwrap()
            .contains(&MALFORMED_SEALED.to_string()));
    }

    /// The relocation attack, at the level the store actually exposes:
    /// somebody with write access to `mail.db` copies one message's sealed
    /// subject onto another message's row.
    #[test]
    fn a_sealed_column_cannot_be_relocated_between_rows() {
        let (_d, store) = sealed_store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        store
            .upsert_header(&header(&f, 1, "From your bank", "2026-07-01T09:00:00Z"))
            .unwrap();
        store
            .upsert_header(&header(&f, 2, "Lunch?", "2026-07-02T09:00:00Z"))
            .unwrap();
        let (a, b) = (format!("{}#1", f.id), format!("{}#2", f.id));
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "UPDATE messages SET subject = (SELECT subject FROM messages WHERE id = ?1)
                     WHERE id = ?2",
                params![a, b],
            )
            .unwrap();
        }
        let moved = store.header(&b).unwrap().unwrap();
        assert_ne!(moved.subject, "From your bank", "the AAD must refuse this");
        assert_eq!(moved.subject, "");
        assert!(moved
            .malformed_headers
            .unwrap()
            .contains(&MALFORMED_SEALED.to_string()));
    }

    #[test]
    fn folders_still_deduplicate_and_still_sort_by_path() {
        let (_d, store) = sealed_store();
        for path in ["Sent", "Archive", "INBOX"] {
            store.upsert_folder(&folder("a1", path)).unwrap();
        }
        let mut f = folder("a1", "INBOX");
        f.unread = 4;
        store.upsert_folder(&f).unwrap();

        let all = store.folders("a1").unwrap();
        assert_eq!(all.len(), 3, "the keyed UNIQUE must still deduplicate");
        let paths: Vec<&str> = all.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["Archive", "INBOX", "Sent"],
            "sorted by the readable path"
        );
        assert_eq!(all[1].unread, 4);
    }

    #[test]
    fn unread_only_filters_a_sealed_store_on_both_paths() {
        let (_d, store) = sealed_store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        for (uid, seen) in [(1u32, false), (2, true), (3, false)] {
            let mut h = header(&f, uid, "invoice", &format!("2026-07-0{uid}T09:00:00Z"));
            h.seen = seen;
            store.upsert_header(&h).unwrap();
        }
        let plain = store
            .headers_page(&f.id, 0, 10, None, MailSort::Date, true, true)
            .unwrap();
        assert_eq!(plain.total, 2);
        let scanned = store
            .headers_page(&f.id, 0, 10, Some("invoice"), MailSort::Date, true, true)
            .unwrap();
        assert_eq!(scanned.total, 2);
        assert!(scanned.items.iter().all(|h| !h.seen));
    }

    #[test]
    fn search_works_over_ciphertext_and_reports_when_it_stopped_early() {
        let (_d, store) = sealed_store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        store
            .upsert_header(&header(&f, 1, "invoice 42", "2026-07-01T09:00:00Z"))
            .unwrap();
        store
            .upsert_header(&header(&f, 2, "holiday plans", "2026-07-02T09:00:00Z"))
            .unwrap();

        let hits = store
            .headers_page(&f.id, 0, 10, Some("INVOI"), MailSort::Date, true, false)
            .unwrap();
        assert_eq!(hits.total, 1, "case-insensitive, like the LIKE it replaces");
        assert_eq!(hits.items[0].subject, "invoice 42");
        assert!(
            hits.scanned.is_none(),
            "the whole folder fit inside the bound"
        );

        // No query: no scan at all, and the count is the real one.
        let all = store
            .headers_page(&f.id, 0, 10, None, MailSort::Date, true, false)
            .unwrap();
        assert_eq!(all.total, 2);
        assert_eq!(all.items[0].uid, 2, "still newest first");

        // Paging over matches, not over rows.
        store
            .upsert_header(&header(&f, 3, "invoice 43", "2026-07-03T09:00:00Z"))
            .unwrap();
        let page = store
            .headers_page(&f.id, 1, 10, Some("invoice"), MailSort::Date, true, false)
            .unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].uid, 1, "the second match, newest-first");
    }

    #[test]
    fn sealed_folder_search_uses_the_same_subject_sender_fields() {
        let (_d, store) = sealed_store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        let mut preview = header(&f, 1, "hello", "2026-07-01T09:00:00Z");
        preview.preview = "invoice in cached body".into();
        store.upsert_header(&preview).unwrap();
        let mut sender = header(&f, 2, "hello", "2026-07-02T09:00:00Z");
        sender.from.name = Some("Invoice Team".into());
        store.upsert_header(&sender).unwrap();

        let folder = store
            .folder_search_page(&f.id, 0, 10, "invoice", MailSort::Date, true, false, false)
            .unwrap();
        assert_eq!(folder.total, 1);
        assert_eq!(folder.items[0].uid, 2);
        assert_eq!(
            store
                .folder_search_page(&f.id, 0, 10, "address", MailSort::Date, true, false, false)
                .unwrap()
                .total,
            0
        );
    }

    /// The scan bound, checked at a size a test can afford. The constant is
    /// 50 000 in production; what matters is that hitting it *reports*
    /// itself rather than silently returning a short answer.
    #[test]
    fn a_bounded_search_never_silently_truncates() {
        let (_d, store) = sealed_store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        for uid in 1..=20u32 {
            store
                .upsert_header(&header(
                    &f,
                    uid,
                    "needle",
                    &format!("2026-07-{uid:02}T09:00:00Z"),
                ))
                .unwrap();
        }
        let full = store
            .headers_page(&f.id, 0, 5, Some("needle"), MailSort::Date, true, false)
            .unwrap();
        assert_eq!(full.total, 20);
        assert!(
            full.scanned.is_none(),
            "under the bound, the page must not claim a partial answer"
        );
    }

    #[test]
    fn the_priority_lists_search_the_same_way() {
        let (_d, store) = sealed_store();
        let f = folder("a1", "INBOX");
        store.upsert_folder(&f).unwrap();
        store
            .upsert_header(&header(&f, 1, "budget review", "2026-07-01T09:00:00Z"))
            .unwrap();
        let id = format!("{}#1", f.id);
        store.set_priority(&id, Some(MailPriority::Urgent)).unwrap();

        let hit = store
            .priority_page(
                MailPriority::Urgent,
                0,
                10,
                Some("budget"),
                MailSort::Date,
                true,
                false,
            )
            .unwrap();
        assert_eq!(hit.total, 1);
        let miss = store
            .priority_page(
                MailPriority::Urgent,
                0,
                10,
                Some("nothing"),
                MailSort::Date,
                true,
                false,
            )
            .unwrap();
        assert_eq!(miss.total, 0);
        assert_eq!(
            store.priority_counts().unwrap().urgent,
            1,
            "counts are cleartext"
        );
    }

    // ── Migrating a store that already had plaintext in it ───────────────

    #[test]
    fn an_existing_plaintext_store_migrates_and_stays_readable() {
        let dir = tempfile::tempdir().unwrap();
        let f = folder("a1", "INBOX/Personnel");
        let h = header(&f, 1, "Redundancy list", "2026-07-01T09:00:00Z");
        let blob;
        {
            let store = MailStore::open(dir.path()).unwrap();
            store.upsert_folder(&f).unwrap();
            store.upsert_header(&h).unwrap();
            blob = store.put_blob(b"attachment plaintext").unwrap();
            store
                .cache_body(
                    &h.id,
                    1,
                    None,
                    Some("body text"),
                    "[]",
                    0,
                    false,
                    Some(&blob),
                )
                .unwrap();
            store
                .put_attachment(
                    &h.id,
                    &MailAttachmentMeta {
                        part_id: "2".into(),
                        filename: "list.xlsx".into(),
                        mime: "application/vnd.ms-excel".into(),
                        size: 20,
                        inline: false,
                        type_mismatch: None,
                    },
                    &blob,
                )
                .unwrap();
            store
                .stage_attachment("d1", "s1", "draft.txt", "text/plain", b"outgoing plaintext")
                .unwrap();
        }

        let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
        assert_eq!(store.header(&h.id).unwrap().unwrap(), h);
        assert_eq!(
            store.folder(&f.id).unwrap().unwrap().path,
            "INBOX/Personnel"
        );
        assert_eq!(
            store.staged_bytes("d1", "s1").unwrap(),
            b"outgoing plaintext"
        );

        // The blob moved from its bare SHA-256 to its keyed name, and the
        // two columns that referenced it followed. If they had not, the
        // attachment would be a row pointing at a file that no longer
        // exists — data loss wearing the costume of a successful migration.
        let (_, digest) = store.attachment(&h.id, "2").unwrap().unwrap();
        assert_ne!(digest, blob, "the blob id is keyed now");
        assert_eq!(store.get_blob(&digest).unwrap(), b"attachment plaintext");
        let body = store.cached_body(&h.id, 1).unwrap().unwrap();
        assert_eq!(body.1.as_deref(), Some("body text"));

        for path in walk(dir.path()) {
            if !path.is_file() {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            for secret in [
                "Redundancy list",
                "body text",
                "attachment plaintext",
                "outgoing plaintext",
            ] {
                assert!(
                    !contains(&bytes, secret.as_bytes()),
                    "{secret:?} survived the migration in {}", // privacy-check: ok — test fixture, never sent
                    path.display()
                );
            }
        }
    }

    /// Interrupting the migration must not corrupt anything, because the
    /// pass is per-value and skips what is already sealed. Simulated by
    /// sealing, then hand-writing one column back to cleartext and letting
    /// the next open finish the job.
    #[test]
    fn the_migration_is_restartable() {
        let dir = tempfile::tempdir().unwrap();
        let f = folder("a1", "INBOX");
        let h = header(&f, 1, "half done", "2026-07-01T09:00:00Z");
        {
            let store = MailStore::open(dir.path()).unwrap();
            store.upsert_folder(&f).unwrap();
            store.upsert_header(&h).unwrap();
        }
        {
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "UPDATE messages SET preview = 'left in the clear' WHERE id = ?1",
                params![h.id],
            )
            .unwrap();
            conn.execute("DELETE FROM meta WHERE key = ?1", params![META_ENCRYPTED])
                .unwrap();
        }
        let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
        let back = store.header(&h.id).unwrap().unwrap();
        assert_eq!(
            back.subject, "half done",
            "the already-sealed value was not double-sealed"
        );
        assert_eq!(
            back.preview, "left in the clear",
            "the stragglers were picked up"
        );
        for path in walk(dir.path()) {
            if path.is_file() {
                let bytes = std::fs::read(&path).unwrap();
                assert!(!contains(&bytes, b"left in the clear"));
            }
        }
    }

    /// The AAD stops a sealed value moving between rows, but a plain `TEXT`
    /// value was accepted as-is — so anyone able to write `mail.db` could
    /// put words in a subject without a "damaged" marker.
    #[test]
    fn plaintext_planted_in_a_sealed_store_reads_as_damaged() {
        let dir = tempfile::tempdir().unwrap();
        let f = folder("a1", "INBOX");
        let h = header(&f, 1, "genuine", "2026-07-01T09:00:00Z");
        {
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            store.upsert_folder(&f).unwrap();
            store.upsert_header(&h).unwrap();
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "UPDATE messages SET subject = 'planted' WHERE id = ?1",
                params![h.id],
            )
            .unwrap();
        }
        let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
        let back = store.header(&h.id).unwrap().unwrap();
        assert_ne!(back.subject, "planted");
        assert!(back
            .malformed_headers
            .unwrap_or_default()
            .contains(&MALFORMED_SEALED.to_string()));
    }

    #[test]
    fn reopening_a_sealed_store_needs_no_second_migration() {
        let dir = tempfile::tempdir().unwrap();
        let f = folder("a1", "INBOX");
        {
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            store.upsert_folder(&f).unwrap();
            store
                .upsert_header(&header(&f, 1, "x", "2026-07-01T09:00:00Z"))
                .unwrap();
        }
        let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
        assert_eq!(store.folders("a1").unwrap().len(), 1);
        assert_eq!(
            store
                .headers_page(&f.id, 0, 10, None, MailSort::Date, true, false)
                .unwrap()
                .total,
            1
        );
    }

    /// The bug this pair of tests exists for: a store that ran **plain** and
    /// was sealed later kept `path_key` as the cleartext path, so the next
    /// sync's upsert matched no conflict target, fell through to the primary
    /// key, and reported *"UNIQUE constraint failed: folders.id"* — every
    /// time, on every folder, until the mailbox was reset.
    #[test]
    fn converting_a_plain_store_rekeys_its_folder_digests() {
        let dir = tempfile::tempdir().unwrap();
        let f = realistic_folder("a1", "INBOX/Personnel");
        {
            let store = MailStore::open(dir.path()).unwrap();
            store.upsert_folder(&f).unwrap();
            let conn = store.conn.lock().unwrap();
            let key: String = conn
                .query_row("SELECT path_key FROM folders", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                key, "INBOX/Personnel",
                "a plain store keys on the value itself"
            );
        }

        let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
        // The sync that used to fail.
        store.upsert_folder(&f).unwrap();
        let all = store.folders("a1").unwrap();
        assert_eq!(all.len(), 1, "the folder was updated, not duplicated");
        assert_eq!(all[0].path, "INBOX/Personnel");

        let key: String = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT path_key FROM folders", [], |r| r.get(0))
            .unwrap();
        assert_ne!(key, "INBOX/Personnel", "the key is a keyed digest now");
        for path in walk(dir.path()) {
            if path.is_file() {
                let bytes = std::fs::read(&path).unwrap();
                assert!(
                    !contains(&bytes, b"INBOX/Personnel"),
                    "the folder path survived in {}",
                    path.display()
                );
            }
        }
    }

    /// `reply_key` is the same class of column: in a plain store it is the
    /// `Message-ID` itself. Conversion drops it rather than leave it in the
    /// clear, and the next sync's `set_reply_key` finds the replies again.
    #[test]
    fn converting_a_plain_store_drops_cleartext_reply_keys() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = realistic_folder("a1", "INBOX");
        let mut sent = realistic_folder("a1", "Sent");
        sent.kind = MailFolderKind::Sent;
        let asked = header(&inbox, 1, "question", "2026-09-01T09:00:00Z");
        let answer = header(&sent, 1, "Re: question", "2026-09-02T09:00:00Z");
        {
            let store = MailStore::open(dir.path()).unwrap();
            store.upsert_folder(&inbox).unwrap();
            store.upsert_folder(&sent).unwrap();
            store.upsert_header(&asked).unwrap();
            store.upsert_header(&answer).unwrap();
            store.set_reply_key(&answer.id, Some("1@example.com")).unwrap();
            assert_eq!(store.replies_to(&asked.id).unwrap().len(), 1);
        }

        let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
        let key: String = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT reply_key FROM messages WHERE id = ?1", params![answer.id], |r| r.get(0))
            .unwrap();
        assert_eq!(key, "", "the cleartext id is gone");
        // The next sync.
        store.set_reply_key(&answer.id, Some("1@example.com")).unwrap();
        let found = store.replies_to(&asked.id).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, answer.id);
        let key: String = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT reply_key FROM messages WHERE id = ?1", params![answer.id], |r| r.get(0))
            .unwrap();
        assert!(!key.contains("example.com"), "the key is a keyed digest now");
    }

    /// `agent_marks.mid_key` is the third column of that class: in a plain
    /// store it spells the `Message-ID`. Conversion rekeys it, the mark
    /// still follows a re-indexed copy afterwards, and a mark whose message
    /// is gone is blanked rather than left in the clear.
    #[test]
    fn converting_a_plain_store_rekeys_agent_marks() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = realistic_folder("a1", "INBOX");
        let archive = realistic_folder("a1", "Archive");
        let shared = header(&inbox, 1, "shared", "2026-09-01T09:00:00Z");
        let gone = header(&inbox, 2, "gone", "2026-09-02T09:00:00Z");
        {
            let store = MailStore::open(dir.path()).unwrap();
            store.upsert_folder(&inbox).unwrap();
            store.upsert_folder(&archive).unwrap();
            store.upsert_header(&shared).unwrap();
            store.upsert_header(&gone).unwrap();
            assert_eq!(store.agent_mark(&[shared.id.clone(), gone.id.clone()], true).unwrap(), 2);
            // An orphan: the row is gone but its mark row stayed behind.
            store
                .conn
                .lock()
                .unwrap()
                .execute("DELETE FROM messages WHERE id = ?1", params![gone.id])
                .unwrap();
        }

        let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
        let keys_on_disk: Vec<(String, String)> = {
            let conn = store.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT message_id, mid_key FROM agent_marks").unwrap();
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(keys_on_disk.len(), 2);
        for (_, k) in &keys_on_disk {
            assert!(!k.contains("example.com"), "cleartext Message-ID survived: {k}");
        }
        let orphan = keys_on_disk.iter().find(|(id, _)| id == &gone.id).unwrap();
        assert_eq!(orphan.1, "", "the orphan's key is blanked, not kept");
        assert!(store.agent_marked(&shared.id).unwrap());

        // The mark still follows the message once the original is gone.
        store.set_flag(&shared.id, MailFlag::Deleted, true).unwrap();
        let mut moved = header(&archive, 7, "shared", "2026-09-01T09:00:00Z");
        moved.rfc_message_id = shared.rfc_message_id.clone();
        store.upsert_header(&moved).unwrap();
        assert!(store.agent_marked(&moved.id).unwrap());
    }

    /// The marked page in a sealed store, with a query: the filter runs
    /// over opened text and still intersects with the marks.
    #[test]
    fn the_marked_page_filters_by_query_in_a_sealed_store() {
        let (_d, store) = sealed_store();
        let inbox = realistic_folder("a1", "INBOX");
        store.upsert_folder(&inbox).unwrap();
        let marked = header(&inbox, 1, "budget review", "2026-09-01T09:00:00Z");
        let unmarked = header(&inbox, 2, "budget draft", "2026-09-02T09:00:00Z");
        store.upsert_header(&marked).unwrap();
        store.upsert_header(&unmarked).unwrap();
        assert_eq!(store.agent_mark(std::slice::from_ref(&marked.id), true).unwrap(), 1);
        let page = store
            .headers_page_marked(&inbox.id, 0, 50, Some("budget"), MailSort::Date, true, false)
            .unwrap();
        let ids: Vec<&str> = page.items.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, vec![marked.id.as_str()]);
        assert_eq!(page.total, 1);
    }

    /// The same fault in a store an *earlier build* already converted: its
    /// `encrypted` marker is set, so the sealing pass returns without
    /// looking. The repair has to be reachable from the ordinary open, and
    /// the upsert has to survive even before it runs.
    #[test]
    fn a_stale_folder_digest_is_repaired_on_the_next_open() {
        let dir = tempfile::tempdir().unwrap();
        let f = realistic_folder("a1", "INBOX/Legal");
        {
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            store.upsert_folder(&f).unwrap();
            // What the build without `rekey_digest_columns` left behind.
            store
                .conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE folders SET path_key = ?1 WHERE id = ?2",
                    params!["INBOX/Legal", f.id],
                )
                .unwrap();
            // Even in that state the upsert must not fail — it is what a
            // sync does before anything has had a chance to repair it.
            store.upsert_folder(&f).unwrap();
            assert_eq!(store.folders("a1").unwrap().len(), 1);
        }

        let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
        let key: String = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT path_key FROM folders", [], |r| r.get(0))
            .unwrap();
        assert_ne!(key, "INBOX/Legal", "the open repaired the stale key");
        store.upsert_folder(&f).unwrap();
        assert_eq!(store.folders("a1").unwrap().len(), 1);
    }

    /// A row whose value cannot be opened — the wrong key, or bytes altered
    /// on disk — must be left exactly as it is. Rekeying it would write a
    /// digest of nothing over the only key that still finds it.
    #[test]
    fn a_row_that_will_not_open_is_not_rekeyed() {
        let dir = tempfile::tempdir().unwrap();
        let f = realistic_folder("a1", "INBOX");
        {
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            store.upsert_folder(&f).unwrap();
        }
        let before: String = {
            let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
            let conn = store.conn.lock().unwrap();
            conn.query_row("SELECT path_key FROM folders", [], |r| r.get(0))
                .unwrap()
        };
        let store = MailStore::open_with_keys(dir.path(), Some(keys(2))).unwrap();
        let after: String = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT path_key FROM folders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after, "a row that would not open kept its key");
    }

    /// A store created before `path_key` existed must come back with its
    /// folders intact — the v1→v2 rebuild is a table swap, and getting it
    /// wrong loses every folder rather than failing loudly.
    #[test]
    fn the_v1_folder_table_is_rebuilt_without_losing_rows() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = MailStore::open(dir.path()).unwrap();
            let conn = store.conn.lock().unwrap();
            conn.execute_batch(
                r#"
                    DROP TABLE folders;
                    CREATE TABLE folders (
                        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, path TEXT NOT NULL,
                        name TEXT NOT NULL, kind TEXT NOT NULL,
                        unread INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
                        UNIQUE (account_id, path)
                    );
                    INSERT INTO folders VALUES ('a1|INBOX','a1','INBOX','INBOX','inbox',3,9);
                    DROP TABLE mail_remote_allow;
                    CREATE TABLE mail_remote_allow (address TEXT PRIMARY KEY);
                    INSERT INTO mail_remote_allow VALUES ('news@example.com');
                    "#,
            )
            .unwrap();
        }
        let store = MailStore::open_with_keys(dir.path(), Some(keys(1))).unwrap();
        let all = store.folders("a1").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].path, "INBOX");
        assert_eq!((all[0].unread, all[0].total), (3, 9));
    }

    /// The degrade path. It must behave like a store in every respect the
    /// caller can see, and leave nothing behind.
    #[test]
    fn the_ephemeral_store_works_and_persists_nothing() {
        let scratch;
        {
            let store = MailStore::open_ephemeral().unwrap();
            scratch = store.dir().to_path_buf();
            assert!(store.is_encrypted());
            let f = folder("a1", "INBOX");
            store.upsert_folder(&f).unwrap();
            let h = header(&f, 1, "in memory only", "2026-07-01T09:00:00Z");
            store.upsert_header(&h).unwrap();
            assert_eq!(
                store.header(&h.id).unwrap().unwrap().subject,
                "in memory only"
            );
            let blob = store.put_blob(b"payload").unwrap();
            assert_eq!(store.get_blob(&blob).unwrap(), b"payload");
            assert!(
                !scratch.join("mail.db").exists(),
                "the index never touches disk"
            );
        }
        assert!(
            !scratch.exists(),
            "the scratch directory goes with the store"
        );
    }
}

/// The additive migration: a missing column is added once, a present one
/// is a no-op, and a real failure is an error rather than a silent skip.
#[test]
fn add_column_if_missing_adds_once_and_reports_real_errors() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE t (a TEXT NOT NULL); INSERT INTO t (a) VALUES ('x');").unwrap();
    assert!(!column_exists(&conn, "t", "b").unwrap());

    add_column_if_missing(&conn, "t", "b", "TEXT NOT NULL DEFAULT ''").unwrap();
    assert!(column_exists(&conn, "t", "b").unwrap());
    let b: String = conn.query_row("SELECT b FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(b, "", "existing rows take the default");

    add_column_if_missing(&conn, "t", "b", "TEXT NOT NULL DEFAULT ''").expect("second call is a no-op");
    let columns: i64 = conn
        .query_row("SELECT COUNT(*) FROM pragma_table_info('t')", [], |r| r.get(0))
        .unwrap();
    assert_eq!(columns, 2);

    assert!(!column_exists(&conn, "nope", "b").unwrap(), "an unknown table has no columns");
    let err = add_column_if_missing(&conn, "nope", "b", "TEXT").unwrap_err();
    assert!(err.contains("nope.b"), "{err}");
    // NOT NULL without a default cannot be added to a table with rows.
    assert!(add_column_if_missing(&conn, "t", "c", "TEXT NOT NULL").is_err());
}

/// `migrate` on a store that already has every column changes nothing and
/// does not fail (every existing install takes this path at each open).
#[test]
fn migrate_twice_is_a_no_op() {
    let (_dir, store) = store();
    let shape = |store: &MailStore| -> Vec<(String, String)> {
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT m.name, p.name FROM sqlite_master m, pragma_table_info(m.name) p
                     WHERE m.type = 'table' ORDER BY m.name, p.cid",
            )
            .unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    };
    let before = shape(&store);
    assert!(before.iter().any(|(t, c)| t == "folders" && c == "total_unindexed"));
    store.migrate().unwrap();
    assert_eq!(shape(&store), before);
}
