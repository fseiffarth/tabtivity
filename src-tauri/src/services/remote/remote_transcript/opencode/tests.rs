use super::*;
use rusqlite::Connection;
use std::io::{Read, Seek, SeekFrom};

/// A "host": a local folder answering the three file asks the way SFTP does.
struct Local(PathBuf);

impl Host for Local {
    async fn stat(&self, path: &str) -> Result<Option<(u64, Option<u64>)>, String> {
        match std::fs::metadata(self.0.join(path)) {
            Ok(meta) => {
                let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
                Ok(Some((meta.len(), mtime)))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    async fn read(&self, path: &str, offset: u64, max: usize) -> Result<Vec<u8>, String> {
        let mut file = std::fs::File::open(self.0.join(path)).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(max as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes)
    }

    async fn fetch(&self, path: &str, local: &Path, size: u64) -> Result<(), String> {
        let bytes = self.read(path, 0, usize::try_from(size).unwrap_or(usize::MAX)).await?;
        if bytes.len() as u64 != size {
            return Err("short".into());
        }
        std::fs::write(local, bytes).map_err(|e| e.to_string())
    }
}

const DB: &str = "store/opencode.db";
const WAL: &str = "store/opencode.db-wal";

/// A host folder with a WAL-mode database whose WAL is never checkpointed on
/// its own, as one OpenCode is writing.
fn host() -> (tempfile::TempDir, Local, Connection) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("store")).unwrap();
    let conn = Connection::open(dir.path().join("store").join("opencode.db")).unwrap();
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);").unwrap();
    let local = Local(dir.path().to_path_buf());
    (dir, local, conn)
}

fn put(conn: &Connection, n: usize) {
    for _ in 0..n {
        conn.execute("INSERT INTO t (v) VALUES (?1)", [&"x".repeat(3000)]).unwrap();
    }
}

fn rows(snapshot: &Snapshot) -> i64 {
    let db = db_file(&snapshot.dir);
    // A snapshot is read the way the reader reads it: without a left-over index.
    let _ = std::fs::remove_file(db.with_file_name("opencode.db-shm"));
    let conn = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap()
}

async fn seen(local: &Local) -> Observed {
    observe(local, DB, WAL).await.unwrap()
}

fn wal_bytes(dir: &tempfile::TempDir) -> Vec<u8> {
    std::fs::read(dir.path().join("store").join("opencode.db-wal")).unwrap()
}

#[test]
fn a_real_wal_is_valid_to_its_last_commit_and_a_flipped_byte_ends_it() {
    let (dir, _local, conn) = host();
    put(&conn, 5);
    let bytes = wal_bytes(&dir);
    let header = parse_wal_header(&bytes).expect("the WAL's header");
    assert_eq!(header.page, 4096);
    let scan = scan_frames(&header, &bytes[WAL_HEADER..], header.sum);
    assert!(scan.commit_end > 0);
    assert_eq!(WAL_HEADER + scan.frames_end, bytes.len(), "every frame SQLite wrote is valid");
    assert_eq!(scan.commit_end, scan.frames_end, "and the last one commits");

    let mut torn = bytes.clone();
    let last = torn.len() - 100;
    torn[last] ^= 0xff;
    let after = scan_frames(&header, &torn[WAL_HEADER..], header.sum);
    assert!(after.frames_end < scan.frames_end, "a frame whose data changed fails its checksum");
    assert!(after.commit_end < scan.commit_end, "the last commit is no longer reached");

    let mut head = bytes.clone();
    head[17] ^= 1;
    assert!(parse_wal_header(&head).is_none(), "a header must match its own checksum");
    assert!(parse_wal_header(&bytes[..20]).is_none());
}

#[test]
fn a_restarted_wal_keeps_its_old_length_but_not_its_old_frames() {
    let (dir, _local, conn) = host();
    put(&conn, 8);
    let before = wal_bytes(&dir);
    let old = parse_wal_header(&before).unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(RESTART)").unwrap();
    put(&conn, 1);
    let after = wal_bytes(&dir);
    let new = parse_wal_header(&after).unwrap();
    assert_eq!(after.len(), before.len(), "the file is rewritten in place, not shortened");
    assert_eq!(new.seq, old.seq + 1);
    assert_ne!(new.salt, old.salt);
    let scan = scan_frames(&new, &after[WAL_HEADER..], new.sum);
    assert!(WAL_HEADER + scan.frames_end < after.len(), "the stale tail is not valid under the new salts");
    assert!(scan.commit_end > 0);
    // The old generation's frames are not taken from the new header, nor the reverse.
    let stale = scan_frames(&old, &after[WAL_HEADER..], old.sum);
    assert!(stale.frames_end == 0);
}

#[tokio::test]
async fn a_base_is_the_database_and_wal_as_one_state_and_the_wal_is_followed() {
    let (dir, local, conn) = host();
    put(&conn, 3);
    let stage = dir.path().join("snap");
    let mut snapshot = fetch_base(&local, DB, WAL, &stage).await.unwrap();
    assert!(snapshot.wal.is_some(), "the writer holds uncheckpointed frames");
    assert_eq!(rows(&snapshot), 3, "rows only in the WAL are read");
    assert_eq!(plan(Some(&snapshot), &seen(&local).await), Plan::Extend);

    put(&conn, 2);
    extend(&local, WAL, &mut snapshot).await.unwrap();
    assert_eq!(rows(&snapshot), 5);
    let copy = snapshot.wal.as_ref().unwrap();
    assert_eq!(std::fs::metadata(wal_file(&snapshot.dir)).unwrap().len(), copy.committed);
    // Nothing new: nothing copied.
    let before = copy.committed;
    extend(&local, WAL, &mut snapshot).await.unwrap();
    assert_eq!(snapshot.wal.as_ref().unwrap().committed, before);

    // A checkpoint changes the database file, not the generation: the WAL
    // restarts only at the next write after it.
    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)").unwrap();
    assert_eq!(plan(Some(&snapshot), &seen(&local).await), Plan::Extend);
    extend(&local, WAL, &mut snapshot).await.unwrap();
    assert_eq!(rows(&snapshot), 5, "the old database and the whole WAL are still the host's state");
    put(&conn, 1);
    assert_eq!(plan(Some(&snapshot), &seen(&local).await), Plan::Bridge, "the write after a full checkpoint restarts the WAL");

    // Two restarts lose the generation between them: the old snapshot is no base for these frames.
    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)").unwrap();
    put(&conn, 2);
    assert_eq!(plan(Some(&snapshot), &seen(&local).await), Plan::Rebase);
    let again = fetch_base(&local, DB, WAL, &dir.path().join("snap2")).await.unwrap();
    assert_eq!(rows(&again), 8, "5, one, two");
    assert_eq!(plan(Some(&again), &seen(&local).await), Plan::Extend);
    assert_eq!(rows(&snapshot), 5, "the snapshot held meanwhile is still readable, and whole");
}

#[tokio::test]
async fn a_closed_host_store_is_a_database_alone() {
    let (dir, local, conn) = host();
    put(&conn, 4);
    drop(conn);
    assert!(!dir.path().join("store").join("opencode.db-wal").exists(), "the last connection checkpoints and removes the WAL");
    let snapshot = fetch_base(&local, DB, WAL, &dir.path().join("snap")).await.unwrap();
    assert!(snapshot.wal.is_none());
    assert_eq!(rows(&snapshot), 4);
    assert_eq!(plan(Some(&snapshot), &seen(&local).await), Plan::Hold);

    // The CLI starts again: a fresh WAL on the database as copied is followed...
    let conn = Connection::open(dir.path().join("store").join("opencode.db")).unwrap();
    conn.execute_batch("PRAGMA wal_autocheckpoint = 0").unwrap();
    put(&conn, 1);
    let now = seen(&local).await;
    assert_eq!(now.wal.as_ref().map(|h| h.seq), Some(0));
    assert_eq!(plan(Some(&snapshot), &now), Plan::Adopt);
    let mut snapshot = snapshot;
    adopt(&mut snapshot, now.wal.as_ref().unwrap()).await.unwrap();
    extend(&local, WAL, &mut snapshot).await.unwrap();
    assert_eq!(rows(&snapshot), 5);
    // ...but not once a checkpoint ran in between (the database file moved).
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    drop(conn);
    let moved = Snapshot { db: (snapshot.db.0, Some(0)), ..snapshot.clone() };
    assert_eq!(plan(Some(&Snapshot { wal: None, ..moved }), &seen(&local).await), Plan::Rebase);
}

#[tokio::test]
async fn a_missing_or_oversized_store_answers_with_its_reason() {
    let (dir, local, conn) = host();
    drop(conn);
    std::fs::remove_file(dir.path().join(DB)).unwrap();
    assert_eq!(observe(&local, DB, WAL).await.unwrap_err(), "no_transcript");
    std::fs::write(dir.path().join(DB), b"").unwrap();
    assert_eq!(observe(&local, DB, WAL).await.unwrap_err(), "no_transcript", "a database being created is not one yet");
}

/// `generation` is the header's two salt words: SQLite's restart counter, not cryptography.
fn header(seq: u32, generation: [u32; 2]) -> WalHeader {
    let mut raw = [0u8; WAL_HEADER];
    for (i, word) in [WAL_MAGIC, WAL_VERSION, 4096, seq, generation[0], generation[1]].into_iter().enumerate() {
        raw[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    let sum = wal_sum(false, &raw[..24], [0, 0]);
    raw[24..28].copy_from_slice(&sum[0].to_be_bytes());
    raw[28..32].copy_from_slice(&sum[1].to_be_bytes());
    parse_wal_header(&raw).unwrap()
}

fn header_after(old: &WalHeader) -> WalHeader {
    header(old.seq + 1, [old.salt[0] + 1, old.salt[1] ^ 0x5a5a])
}

fn snapshot(wal: Option<WalHeader>, db: (u64, Option<u64>)) -> Snapshot {
    let wal = wal.map(|header| WalCopy { sum: header.sum, header, committed: WAL_HEADER as u64 });
    Snapshot { dir: PathBuf::from("snap"), db, wal, based: Instant::now() }
}

#[test]
fn a_poll_follows_the_generation_it_copied_and_copies_a_base_when_it_moved() {
    let db = (1000, Some(5));
    let (a, b) = (header(1, [10, 20]), header(2, [30, 40]));
    let at = |wal: Option<&WalHeader>, db| Observed { wal: wal.cloned(), db };
    assert_eq!(plan(None, &at(Some(&a), db)), Plan::Rebase);
    assert_eq!(plan(Some(&snapshot(Some(a.clone()), db)), &at(Some(&a), (2000, Some(9)))), Plan::Extend, "a checkpoint moves the file, not the generation");
    assert_eq!(plan(Some(&snapshot(Some(a.clone()), db)), &at(Some(&b), db)), Plan::Rebase, "a restart that is not the next one");
    let next = header_after(&a);
    assert_eq!(plan(Some(&snapshot(Some(a.clone()), db)), &at(Some(&next), db)), Plan::Bridge, "the next restart: the tail may still be on the host's disk");
    let twice = header_after(&next);
    assert_eq!(plan(Some(&snapshot(Some(a.clone()), db)), &at(Some(&twice), db)), Plan::Rebase, "two restarts lost the generation in between");
    assert_eq!(plan(Some(&snapshot(Some(a.clone()), db)), &at(None, db)), Plan::Rebase, "the CLI closed: the database is whole");
    assert_eq!(plan(Some(&snapshot(None, db)), &at(None, db)), Plan::Hold);
    assert_eq!(plan(Some(&snapshot(None, db)), &at(None, (2000, Some(9)))), Plan::Rebase, "another process wrote the database");
    let fresh = header(0, [50, 60]);
    assert_eq!(plan(Some(&snapshot(None, db)), &at(Some(&fresh), db)), Plan::Adopt);
    assert_eq!(plan(Some(&snapshot(None, db)), &at(Some(&fresh), (2000, Some(9)))), Plan::Rebase);
    assert_eq!(plan(Some(&snapshot(None, db)), &at(Some(&b), db)), Plan::Rebase, "a WAL that already restarted had frames this missed");
}

#[test]
fn the_store_is_where_the_cli_says_then_where_the_agent_home_puts_it() {
    let env = |xdg: Option<&str>, home: Option<&str>, db: Option<&str>| ProcEnv {
        xdg_data_home: xdg.map(str::to_string),
        home: home.map(str::to_string),
        opencode_db: db.map(str::to_string),
    };
    assert_eq!(store_path(None, None), ".local/share/opencode/opencode.db");
    assert_eq!(store_path(None, Some("/scratch/me/home")), "/scratch/me/home/.local/share/opencode/opencode.db");
    assert_eq!(store_path(Some(&env(None, Some("/home/me/"), None)), None), "/home/me/.local/share/opencode/opencode.db");
    assert_eq!(store_path(Some(&env(Some("/data/me"), Some("/home/me"), None)), None), "/data/me/opencode/opencode.db");
    assert_eq!(store_path(Some(&env(None, Some("/h"), Some("/x/y.db"))), None), "/x/y.db");
    assert_eq!(store_path(Some(&env(None, Some("/h"), Some("opencode-next.db"))), None), "/h/.local/share/opencode/opencode-next.db");
    assert_eq!(store_path(Some(&env(Some("rel"), Some("relhome"), None)), Some("/a")), "/a/.local/share/opencode/opencode.db", "a relative variable is not trusted");
    assert_eq!(store_path(Some(&env(None, Some("/h"), Some(":memory:"))), None), "/h/.local/share/opencode/opencode.db");
}

#[test]
fn a_process_is_read_off_its_environment_and_stat() {
    let environ = b"HOME=/home/me\0XDG_DATA_HOME=\0OPENCODE_DB=x.db\0PATH=/bin\0";
    let env = parse_environ(environ);
    assert_eq!((env.home.as_deref(), env.xdg_data_home.as_deref(), env.opencode_db.as_deref()), (Some("/home/me"), None, Some("x.db")));
    // The command (field 2) may hold spaces and parentheses.
    let stat = "4242 (open code) (x) S 4241 4242 4242 0 -1 4194560 100 0 0 0 5 1 0 0 20 0 9 0 123456 1000 100 18446744073709551615";
    assert_eq!(stat_start_ticks(stat), Some(123456));
    assert_eq!(stat_start_ticks("garbage"), None);
    assert_eq!(btime_of("cpu 1 2 3\nintr 5\nbtime 1795000000\nprocesses 9\n"), Some(1_795_000_000));
    assert_eq!(btime_of("cpu 1"), None);
    assert!(is_host_absolute("/srv/p") && is_host_absolute("C:/p") && !is_host_absolute("p/q"));
}

#[test]
fn the_tabs_start_replaces_the_local_clock_and_a_restored_tab_has_none() {
    assert_eq!(host_since(None, Some(5_000_000)), None, "a restored tab reads the folder's newest");
    assert_eq!(host_since(Some(1_000_000), Some(5_000_000)), Some(5_000_000 - START_SLACK_MS));
    assert_eq!(host_since(Some(1_000_000), None), Some(1_000_000 - SKEW_SLACK_MS));
}

#[tokio::test]
async fn a_snapshot_is_read_as_a_local_tabs_store_is() {
    let (dir, local, conn) = host();
    conn.execute_batch(
        "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL,
           time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
         CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
           time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
           time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
         INSERT INTO session VALUES ('ses_a', NULL, '/srv/p', 5000, 5000, NULL);
         INSERT INTO message VALUES ('m1', 'ses_a', 5000, 5000, '{\"role\":\"user\"}');
         INSERT INTO part VALUES ('p1', 'm1', 'ses_a', 5000, 5000, '{\"type\":\"text\",\"text\":\"hello host\"}');",
    )
    .unwrap();
    let mut snapshot = fetch_base(&local, DB, WAL, &dir.path().join("snap")).await.unwrap();
    let texts = |s: &Snapshot, dir: &str, cwd: Option<&str>, since: Option<i64>| {
        read_snapshot(s, dir, cwd, since, None, None, 50).unwrap().entries.into_iter().map(|e| e.text).collect::<Vec<_>>()
    };
    assert_eq!(texts(&snapshot, "/srv/p", None, None), vec!["hello host"]);
    // A tab opened after that conversation does not show it.
    assert!(texts(&snapshot, "/srv/p", None, Some(9000)).is_empty());
    // The folder reached through a link on the host is stored under its real path.
    assert_eq!(texts(&snapshot, "/link/p", Some("/srv/p"), None), vec!["hello host"]);
    assert!(texts(&snapshot, "/link/p", None, None).is_empty());

    conn.execute_batch(
        "INSERT INTO message VALUES ('m2', 'ses_a', 6000, 6000, '{\"role\":\"assistant\",\"time\":{\"created\":6000,\"completed\":6100}}');
         INSERT INTO part VALUES ('p2', 'm2', 'ses_a', 6001, 6001, '{\"type\":\"text\",\"text\":\"answer from host\",\"time\":{\"start\":6001,\"end\":6050}}');",
    )
    .unwrap();
    extend(&local, WAL, &mut snapshot).await.unwrap();
    assert_eq!(texts(&snapshot, "/srv/p", None, None), vec!["hello host", "answer from host"]);
    assert_eq!(db_file(&snapshot.dir).file_name().and_then(|n| n.to_str()), Some("opencode.db"));
}

#[test]
fn a_tabs_snapshot_lives_in_the_projects_session_folder() {
    let id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
    let root = tab_root("p1", "gpu/2", id);
    assert!(root.starts_with(crate::storage::project_session_dir("p1")));
    assert_eq!(root.file_name().and_then(|n| n.to_str()), Some(format!("opencode-{id}").as_str()));
    assert_eq!(root.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()), Some("gpu_2"));
}

/// A host whose WAL has been through a long generation, so that the file holds
/// the stale frames of an earlier one beyond a later one's end.
fn restarted_host() -> (tempfile::TempDir, Local, Connection) {
    let (dir, local, conn) = host();
    put(&conn, 20);
    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)").unwrap();
    put(&conn, 1);
    (dir, local, conn)
}

#[test]
fn sqlites_restart_counts_the_sequence_and_the_first_salt_up_by_one() {
    let (dir, _local, conn) = host();
    put(&conn, 2);
    let old = parse_wal_header(&wal_bytes(&dir)).unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)").unwrap();
    put(&conn, 1);
    let new = parse_wal_header(&wal_bytes(&dir)).unwrap();
    assert!(restarted_once(&old, &new));
    assert!(!restarted_once(&new, &old) && !restarted_once(&old, &old));
}

#[tokio::test]
async fn a_restart_is_crossed_without_the_database_when_its_old_frames_are_still_on_the_host() {
    let (dir, local, conn) = restarted_host();
    let mut snapshot = fetch_base(&local, DB, WAL, &dir.path().join("snap")).await.unwrap();
    assert_eq!(rows(&snapshot), 21);
    let based = snapshot.based;
    let db_before = std::fs::read(db_file(&snapshot.dir)).unwrap();
    for round in 0..5 {
        // Some rounds the snapshot has followed everything before the host
        // checkpoints, some it lags behind by frames it never copied.
        put(&conn, 2);
        if round % 2 == 0 {
            extend(&local, WAL, &mut snapshot).await.unwrap();
        }
        conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)").unwrap();
        put(&conn, 1);
        let now = seen(&local).await;
        assert_eq!(plan(Some(&snapshot), &now), Plan::Bridge, "round {round}");
        let crossed = bridge(&local, WAL, &mut snapshot, now.wal.as_ref().unwrap(), now.db).await;
        assert_eq!(crossed, Crossed::Done, "round {round}: the tail is on the host's disk");
        extend(&local, WAL, &mut snapshot).await.unwrap();
        assert_eq!(rows(&snapshot), 21 + 3 * (round + 1), "round {round}");
        assert_eq!(plan(Some(&snapshot), &seen(&local).await), Plan::Extend);
    }
    assert_eq!(snapshot.based, based, "no database was copied again");
    assert_ne!(std::fs::read(db_file(&snapshot.dir)).unwrap(), db_before, "the checkpoint was made on the snapshot's own copy");
    // The same answer as a snapshot made from scratch.
    let fresh = fetch_base(&local, DB, WAL, &dir.path().join("snap2")).await.unwrap();
    assert_eq!(rows(&fresh), rows(&snapshot));
}

#[tokio::test]
async fn a_restart_is_not_crossed_when_the_new_generation_overwrote_what_was_not_copied() {
    let (dir, local, conn) = restarted_host();
    let mut snapshot = fetch_base(&local, DB, WAL, &dir.path().join("snap")).await.unwrap();
    // Frames written after the snapshot's last copy, then checkpointed, then
    // a new generation long enough to cover their place in the file.
    put(&conn, 2);
    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)").unwrap();
    put(&conn, 12);
    let now = seen(&local).await;
    assert_eq!(plan(Some(&snapshot), &now), Plan::Bridge);
    let crossed = bridge(&local, WAL, &mut snapshot, now.wal.as_ref().unwrap(), now.db).await;
    assert_eq!(crossed, Crossed::Rebase, "frames may be missing: copy a base");
    assert_eq!(rows(&snapshot), 21, "a refused bridge leaves the snapshot as it was");
}

#[test]
fn a_tail_is_judged_by_the_slot_that_ends_the_chain() {
    let old = header(1, [10, 20]);
    let new = header_after(&old);
    let mut frame = vec![0u8; FRAME_HEADER + old.page];
    frame[8..12].copy_from_slice(&1000u32.to_be_bytes());
    frame[12..16].copy_from_slice(&1u32.to_be_bytes());
    let end = |salt: [u32; 2]| {
        let mut f = frame.clone();
        f[8..12].copy_from_slice(&salt[0].to_be_bytes());
        f[12..16].copy_from_slice(&salt[1].to_be_bytes());
        scan_frames(&old, &f, old.sum).end
    };
    assert_eq!(end([77, 88]), End::Salt([77, 88]), "another generation's frame ends the chain");
    assert_eq!(end(old.salt), End::Sum, "a frame of this generation that fails its checksum");
    assert_eq!(end(new.salt), End::Salt(new.salt));
    assert_eq!(scan_frames(&old, &frame[..40], old.sum).end, End::Bytes);
}

/// Follow a running OpenCode's store the way the app would, polling every half
/// second, and check the snapshot only ever shows a state the host was in:
/// never more rows than the host has, never fewer than it showed before.
///
/// `scripts/verify-cli/opencode/remote_store.py` writes turns into such a home;
/// while it runs:
/// `VERIFY_OPENCODE_HOME=<its home> VERIFY_SECS=120 cargo test -p tabtivity --lib
/// verify_cli_follows_a_live_store -- --ignored --nocapture`
#[tokio::test]
#[ignore = "needs a running OpenCode: scripts/verify-cli/opencode/remote_store.py"]
async fn verify_cli_follows_a_live_store() {
    let home = PathBuf::from(std::env::var("VERIFY_OPENCODE_HOME").expect("VERIFY_OPENCODE_HOME"));
    let secs: u64 = std::env::var("VERIFY_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
    let (db, wal) = (HOME_STORE_REL, format!("{HOME_STORE_REL}-wal"));
    let local = Local(home.clone());
    let out = tempfile::tempdir().unwrap();
    let count = |path: &Path| -> i64 {
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        conn.query_row("SELECT count(*) FROM session_message", [], |r| r.get(0)).unwrap_or(0)
    };
    let live = || count(&home.join(".local").join("share").join("opencode").join("opencode.db"));
    let (mut snapshot, mut bases): (Option<Snapshot>, usize) = (None, 0);
    let mut tally: HashMap<&str, usize> = HashMap::new();
    let mut last = 0;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(secs) {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let Ok(now) = observe(&local, db, &wal).await else { continue };
        let mut next = plan(snapshot.as_ref(), &now);
        if next == Plan::Bridge {
            let crossed = bridge(&local, &wal, snapshot.as_mut().unwrap(), now.wal.as_ref().unwrap(), now.db).await;
            *tally.entry(match crossed { Crossed::Done => "bridged", Crossed::Rebase => "bridge refused", Crossed::Later => "bridge later" }).or_default() += 1;
            next = if crossed == Crossed::Done { Plan::Extend } else { Plan::Rebase };
        }
        match next {
            Plan::Hold | Plan::Bridge => {}
            Plan::Extend => {
                extend(&local, &wal, snapshot.as_mut().unwrap()).await.expect("extend");
                *tally.entry("extended").or_default() += 1;
            }
            Plan::Adopt => {
                adopt(snapshot.as_mut().unwrap(), now.wal.as_ref().unwrap()).await.unwrap();
                *tally.entry("adopted").or_default() += 1;
            }
            Plan::Rebase => {
                bases += 1;
                snapshot = Some(fetch_base(&local, db, &wal, &out.path().join(format!("base-{bases}"))).await.expect("base"));
                *tally.entry("based").or_default() += 1;
            }
        }
        let Some(snap) = snapshot.as_ref() else { continue };
        let db_file = db_file(&snap.dir);
        let _ = std::fs::remove_file(db_file.with_file_name("opencode.db-shm"));
        let shown = count(&db_file);
        let host = live();
        assert!(shown <= host, "the snapshot has {shown} rows, the host only {host}");
        assert!(shown >= last, "the snapshot went back from {last} to {shown}");
        last = shown;
    }
    // Quiet: one more poll catches up with the host.
    tokio::time::sleep(Duration::from_secs(3)).await;
    println!("polls: {tally:?}, last rows {last}");
    let now = observe(&local, db, &wal).await.unwrap();
    if plan(snapshot.as_ref(), &now) == Plan::Extend {
        extend(&local, &wal, snapshot.as_mut().unwrap()).await.unwrap();
    }
    let db_file = db_file(&snapshot.as_ref().unwrap().dir);
    let _ = std::fs::remove_file(db_file.with_file_name("opencode.db-shm"));
    println!("final: snapshot {} rows, host {}", count(&db_file), live());
    let conn = Connection::open_with_flags(&db_file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).unwrap();
    assert_eq!(check, "ok");
}
