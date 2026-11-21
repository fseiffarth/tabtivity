use super::*;
use rusqlite::Connection;

const ID: &str = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const OTHER: &str = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";

fn wal_header(magic: u32, salt1: u32, salt2: u32) -> Vec<u8> {
    let mut head = vec![0u8; 32];
    head[..4].copy_from_slice(&magic.to_be_bytes());
    head[16..20].copy_from_slice(&salt1.to_be_bytes());
    head[20..24].copy_from_slice(&salt2.to_be_bytes());
    head
}

#[test]
fn a_wal_header_gives_its_salts() {
    assert_eq!(wal_salts(&wal_header(0x377f_0682, 7, 9)), Some((7, 9)));
    assert_eq!(wal_salts(&wal_header(0x377f_0683, 1, u32::MAX)), Some((1, u32::MAX)));
    assert_eq!(wal_salts(&wal_header(0x1234_5678, 7, 9)), None, "not a WAL");
    assert_eq!(wal_salts(&wal_header(0x377f_0682, 7, 9)[..31]), None, "a short header");
    assert_eq!(wal_salts(&[]), None);
}

#[test]
fn the_presence_lock_link_names_the_conversation() {
    let link = |id: &str| format!("/home/me/.gemini/antigravity-cli/presence/{id}.lock");
    assert_eq!(presence_id(&link(ID)).as_deref(), Some(ID));
    // Another home spelling (an agent home on a scratch disk) is the same shape.
    assert_eq!(presence_id(&format!("/scratch/h/.gemini/antigravity-cli/presence/{ID}.lock")).as_deref(), Some(ID));
    assert_eq!(presence_id(&link("../../etc/passwd")), None, "the id becomes a file name");
    assert_eq!(presence_id(&link("not-a-uuid")), None);
    assert_eq!(presence_id(&format!("/home/me/.gemini/antigravity-cli/conversations/{ID}.db")), None);
    assert_eq!(presence_id(&format!("/home/me/.gemini/elsewhere/presence/{ID}.lock")), None, "another program's folder");
    assert_eq!(presence_id(&format!("/home/me/.gemini/antigravity-cli/presence/{ID}.lock (deleted)")), None);
}

#[test]
fn a_process_keeps_its_conversation_while_it_holds_it() {
    let ids = vec![ID.to_string(), OTHER.to_string()];
    assert_eq!(choose(&ids, Some(ID)).as_deref(), Some(ID));
    assert_eq!(choose(&ids, Some("gone")).as_deref(), Some(OTHER), "else the newest descriptor's");
    assert_eq!(choose(&ids[..1], None).as_deref(), Some(ID));
    assert_eq!(choose(&[], Some(ID)), None);
}

#[test]
fn the_folders_last_conversation_comes_from_its_index() {
    let index = format!(r#"{{"/srv/work": "{ID}", "/srv/other": "../x", "/srv/bad": 3}}"#);
    assert_eq!(folder_conversation(index.as_bytes(), "/srv/work").as_deref(), Some(ID));
    assert_eq!(folder_conversation(index.as_bytes(), "/srv/work/").as_deref(), Some(ID));
    assert_eq!(folder_conversation(index.as_bytes(), "/srv/other"), None, "not an id");
    assert_eq!(folder_conversation(index.as_bytes(), "/srv/none"), None);
    assert_eq!(folder_conversation(b"not json", "/srv/work"), None);
}

fn held(db: DbStamp, salts: Option<(u32, u32)>, wal: u64) -> Held {
    Held { id: ID.to_string(), db, salts, wal }
}

#[test]
fn a_check_copies_only_what_moved() {
    let db = DbStamp { size: 4096, mtime: Some(10) };
    let salts = Some((1, 2));
    let copy = held(db, salts, 5000);
    // Nothing held, or another conversation held: all of it.
    assert_eq!(plan(None, ID, db, salts, 5000), Plan::Full);
    assert_eq!(plan(Some(&copy), OTHER, db, salts, 5000), Plan::Full);
    // Same WAL run: only the growth, and not a checkpoint's change of the database.
    assert_eq!(plan(Some(&copy), ID, db, salts, 5000), Plan::Keep);
    assert_eq!(plan(Some(&copy), ID, DbStamp { size: 8192, mtime: Some(11) }, salts, 5000), Plan::Keep);
    assert_eq!(plan(Some(&copy), ID, db, salts, 9000), Plan::Grow);
    // The WAL restarted (other salts), shrank, appeared or went away: afresh.
    assert_eq!(plan(Some(&copy), ID, db, Some((2, 3)), 5000), Plan::Full);
    assert_eq!(plan(Some(&copy), ID, db, salts, 100), Plan::Full);
    assert_eq!(plan(Some(&copy), ID, db, None, 0), Plan::Full);
    let bare = held(db, None, 0);
    assert_eq!(plan(Some(&bare), ID, db, Some((1, 2)), 4000), Plan::Full);
    // No WAL on either side: the database decides.
    assert_eq!(plan(Some(&bare), ID, db, None, 0), Plan::Keep);
    assert_eq!(plan(Some(&bare), ID, DbStamp { size: 4096, mtime: Some(12) }, None, 0), Plan::Full);
    assert_eq!(plan(Some(&bare), ID, DbStamp { size: 5000, mtime: Some(10) }, None, 0), Plan::Full);
}

#[test]
fn a_big_database_is_copied_afresh_less_often() {
    let every = Duration::from_millis(1500);
    assert_eq!(resync_every(1024, every), every);
    assert_eq!(resync_every(BIG_DB_BYTES + 1, every), SEARCH_EVERY);
    let careful = Duration::from_secs(12);
    assert_eq!(resync_every(BIG_DB_BYTES + 1, careful), SEARCH_EVERY);
    assert_eq!(resync_every(1, Duration::from_secs(90)), Duration::from_secs(90));
    assert_eq!(resync_every(BIG_DB_BYTES + 1, Duration::from_secs(90)), Duration::from_secs(90));
}

// Records as Antigravity writes them (the fields the local reader decodes).

fn uint(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    while value >= 128 {
        bytes.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    bytes.push(value as u8);
    bytes
}

fn field(number: u64, value: &[u8]) -> Vec<u8> {
    [uint(number << 3 | 2), uint(value.len() as u64), value.to_vec()].concat()
}

fn step(kind: u64, text: &str, seconds: u64) -> Vec<u8> {
    let metadata = field(1, &[uint(8), uint(seconds)].concat());
    let message = field(if kind == 14 { 2 } else { 1 }, text.as_bytes());
    [uint(8), uint(kind), field(5, &metadata), field(if kind == 14 { 19 } else { 20 }, &message)].concat()
}

fn insert(conn: &Connection, index: i64, kind: u64, text: &str) {
    conn.execute(
        "INSERT INTO steps VALUES (?1, ?2, 3, ?3)",
        rusqlite::params![index, kind as i64, step(kind, text, 1_791_979_200 + index as u64)],
    )
    .unwrap();
}

/// A host's store: the writer's connection stays open, as the CLI's does, so
/// the WAL is not folded back when the test copies the files.
fn host_db(dir: &Path) -> Connection {
    let conn = Connection::open(dir.join(format!("{ID}.db"))).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
         CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)",
    )
    .unwrap();
    conn
}

fn texts(read: &AgentTranscript) -> Vec<(&str, &str)> {
    read.entries.iter().map(|entry| (entry.kind.as_str(), entry.text.as_str())).collect()
}

fn read_copy(mirror: &Path) -> AgentTranscript {
    // As `host_transcript` does before each read.
    let _ = std::fs::remove_file(mirror.join(format!("{ID}.db-shm")));
    crate::services::google_chat::antigravity_copy(mirror, ID, None, 50)
}

#[test]
fn a_copy_of_the_database_and_its_wal_without_the_shm_reads_the_wal_too() {
    let host = tempfile::tempdir().unwrap();
    let mirror = tempfile::tempdir().unwrap();
    let conn = host_db(host.path());
    insert(&conn, 0, 14, "remember pelican");
    insert(&conn, 1, 15, "pelican");
    let (db, wal) = (host.path().join(format!("{ID}.db")), host.path().join(format!("{ID}.db-wal")));
    assert!(std::fs::metadata(&wal).unwrap().len() > 32, "the turns are in the WAL only");
    let salts = wal_salts(&std::fs::read(&wal).unwrap());
    assert!(salts.is_some(), "a real WAL header parses");

    std::fs::copy(&db, mirror.path().join(format!("{ID}.db"))).unwrap();
    std::fs::copy(&wal, mirror.path().join(format!("{ID}.db-wal"))).unwrap();
    let first = read_copy(mirror.path());
    assert!(first.available);
    assert_eq!(texts(&first), [("prompt", "remember pelican"), ("answer", "pelican")]);

    // The WAL grows: its new bytes appended to the copy, as `grow` does.
    insert(&conn, 2, 14, "and now?");
    insert(&conn, 3, 15, "pelican again");
    let (old, new) = (std::fs::metadata(mirror.path().join(format!("{ID}.db-wal"))).unwrap().len(), std::fs::metadata(&wal).unwrap().len());
    assert!(new > old);
    assert_eq!(wal_salts(&std::fs::read(&wal).unwrap()), salts, "same run, same salts: the copy only grows");
    let bytes = std::fs::read(&wal).unwrap();
    {
        use std::io::Write;
        let mut live = std::fs::OpenOptions::new().append(true).open(mirror.path().join(format!("{ID}.db-wal"))).unwrap();
        live.write_all(&bytes[old as usize..]).unwrap();
    }
    let grown = read_copy(mirror.path());
    assert_eq!(texts(&grown), [("prompt", "remember pelican"), ("answer", "pelican"), ("prompt", "and now?"), ("answer", "pelican again")]);
    assert!(!grown.unchanged);
}

#[test]
fn a_checkpoint_that_restarts_the_wal_changes_its_salts() {
    let host = tempfile::tempdir().unwrap();
    let conn = host_db(host.path());
    insert(&conn, 0, 14, "one");
    let wal = host.path().join(format!("{ID}.db-wal"));
    let before = wal_salts(&std::fs::read(&wal).unwrap()).unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(RESTART)").unwrap();
    insert(&conn, 1, 15, "two");
    let after = wal_salts(&std::fs::read(&wal).unwrap()).unwrap();
    assert_ne!(before, after, "what a mirror compares to notice a checkpoint");
    // The planner then asks for the whole database again.
    let stamp = DbStamp { size: 4096, mtime: Some(1) };
    let copy = held(stamp, Some(before), 4096);
    assert_eq!(plan(Some(&copy), ID, stamp, Some(after), std::fs::metadata(&wal).unwrap().len()), Plan::Full);
}

#[test]
fn a_database_copied_during_a_checkpoint_is_repaired_by_the_wal_copied_after_it() {
    // The ordering the module relies on: database first, WAL second. A
    // checkpoint that folded frames into the database meanwhile leaves them in
    // the WAL (no restart), so the pair reads the same as the host does.
    let host = tempfile::tempdir().unwrap();
    let mirror = tempfile::tempdir().unwrap();
    let conn = host_db(host.path());
    insert(&conn, 0, 14, "first");
    insert(&conn, 1, 15, "first answer");
    // A running CLI's database has had checkpoints already; the WAL is not restarted again below.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    let (db, wal) = (host.path().join(format!("{ID}.db")), host.path().join(format!("{ID}.db-wal")));
    std::fs::copy(&db, mirror.path().join(format!("{ID}.db"))).unwrap();
    insert(&conn, 2, 14, "second");
    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)").unwrap();
    insert(&conn, 3, 15, "second answer");
    std::fs::copy(&wal, mirror.path().join(format!("{ID}.db-wal"))).unwrap();
    let read = read_copy(mirror.path());
    assert_eq!(
        texts(&read),
        [("prompt", "first"), ("answer", "first answer"), ("prompt", "second"), ("answer", "second answer")]
    );
}

#[test]
fn a_database_alone_reads_as_it_stands() {
    let host = tempfile::tempdir().unwrap();
    let mirror = tempfile::tempdir().unwrap();
    {
        let conn = host_db(host.path());
        insert(&conn, 0, 14, "only turn");
        insert(&conn, 1, 15, "only answer");
        // Closing the last connection folds the WAL back and removes it.
    }
    assert!(!host.path().join(format!("{ID}.db-wal")).exists());
    std::fs::copy(host.path().join(format!("{ID}.db")), mirror.path().join(format!("{ID}.db"))).unwrap();
    assert_eq!(texts(&read_copy(mirror.path())), [("prompt", "only turn"), ("answer", "only answer")]);
    assert_eq!(crate::services::google_chat::antigravity_copy_started(mirror.path(), ID), Some(1_791_979_200_000));
    assert!(!read_copy(&mirror.path().join("absent")).available);
}
