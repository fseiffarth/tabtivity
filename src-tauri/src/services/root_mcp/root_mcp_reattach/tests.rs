use super::*;
use crate::services::root_mcp::root_mcp_mark::Mark;
use crate::services::root_mcp::{mint_token, token_hash, PushBinding, ScheduleBinding};

const NOW: u64 = 1_800_000_000;
const PORT: u16 = 4100;
const PREV: &str = "11111111111111111111111111111111";
const THIS: &str = "22222222222222222222222222222222";
const OLDER: &str = "33333333333333333333333333333333";

fn record_file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = Role::Window.record(dir.path());
    (dir, file)
}

fn identity(tab: &str, caller: Caller) -> Identity {
    let project = (caller != Caller::Helper).then(|| "p1".to_string());
    let schedule_target = matches!(caller, Caller::Marker | Caller::Scheduler)
        .then(|| ScheduleBinding { target: "t1".into(), agent: "claude".into() });
    let push = (caller == Caller::Pusher).then(|| PushBinding {
        dir: std::env::temp_dir().join("repo-p1"),
        fence_scope: Some("p1".into()),
        unfenced_host: false,
        git_at_spawn: Some((7, 9)),
    });
    Identity { tab: tab.into(), caller, project, schedule_target, push, endpoint: None, model: None }
}

/// A token registered in `store` for `tab` and `caller`, and its hash.
fn grant(store: &TokenStore, tab: &str, caller: Caller) -> (String, String) {
    let token = mint_token().unwrap();
    store.register(token.clone(), identity(tab, caller), false);
    let hash = token_hash(&token);
    (token, hash)
}

fn row_of(lanes: Vec<LaneRow>, grant: &str, nonce: &str) -> Row {
    Row {
        port: PORT,
        nonce: nonce.into(),
        grant: grant.into(),
        project: Some("p1".into()),
        cmd_stem: "claude".into(),
        created: NOW - 100,
        lanes,
        ..Row::default()
    }
}

fn mark(nonce: &str, grant: &str) -> Mark {
    Mark { nonce: nonce.into(), grant: Some(grant.into()), port: PORT }
}

fn write(file: &Path, record: &Record) {
    crate::storage::patch_private_json(file, Record::default(), |r: &mut Record| {
        *r = record.clone();
        Ok(())
    })
    .unwrap();
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// A previous run's file holding one row for `session`, and the listener
/// this run opens over it.
fn previous_run(file: &Path, session: &str, row: Row, alive: u64) -> Listener {
    let mut record = Record { nonce: PREV.into(), port: PORT, last_alive: alive, ..Record::default() };
    record.sessions.insert(session.into(), row);
    write(file, &record);
    Listener::open(file.to_path_buf(), PORT, THIS.into(), true, None, NOW)
}

// ── the record file ────────────────────────────────────────────────────────

/// An older file (fields missing) reads with defaults, and fields this build
/// does not know survive a rewrite at every level.
#[test]
fn the_record_round_trips_older_and_unknown_fields() {
    let (_dir, file) = record_file();
    let text = serde_json::json!({
        "nonce": PREV, "port": PORT, "last_alive": NOW - 10, "future": {"x": 1},
        "sessions": {
            "s": {"port": PORT, "nonce": PREV, "grant": "g", "lanes": [
                {"caller": "helper", "hash": "h", "lane_future": true},
                {"caller": "pusher"}
            ], "row_future": "kept"},
            "old": {}
        }
    });
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, text.to_string()).unwrap();
    let record: Record = crate::storage::read_json(&file).unwrap();
    assert_eq!(record.sessions["old"], Row::default(), "an older row reads with defaults");
    assert_eq!(record.sessions["s"].lanes[1].hash, None);
    crate::storage::patch_private_json(&file, Record::default(), |r: &mut Record| {
        r.last_alive += 1;
        Ok(())
    })
    .unwrap();
    let back: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(back["future"], serde_json::json!({"x": 1}));
    assert_eq!(back["sessions"]["s"]["row_future"], "kept");
    assert_eq!(back["sessions"]["s"]["lanes"][0]["lane_future"], true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600, "private");
    }
}

#[test]
fn a_lane_row_keeps_the_identity_and_the_hash_of_revivable_lanes_only() {
    let pusher = LaneRow::of(&identity("x", Caller::Pusher), "h1");
    assert_eq!(pusher.hash.as_deref(), Some("h1"));
    assert_eq!(pusher.caller, "pusher");
    assert_eq!(pusher.git_at_spawn(), Some((7, 9)));
    assert_eq!(pusher.fence_scope.as_deref(), Some("p1"));
    for caller in [Caller::Agent, Caller::Reader, Caller::LocalModel, Caller::Scheduler, Caller::Web] {
        let lane = LaneRow::of(&identity("x", caller), "h");
        assert_eq!(lane.hash, None, "{caller:?} is never revived, so its hash is never written");
        assert!(!revivable(caller));
    }
    for caller in [Caller::Pusher, Caller::Cockpit, Caller::Helper, Caller::Marker, Caller::Printer, Caller::Tabs] {
        assert!(revivable(caller), "{caller:?}");
    }
}

// ── opening at start ───────────────────────────────────────────────────────

#[test]
fn a_port_fallback_purges_the_file_and_revives_nothing() {
    let (_dir, file) = record_file();
    let row = row_of(vec![], "g", PREV);
    let mut record = Record { nonce: PREV.into(), port: PORT, last_alive: NOW - 5, ..Record::default() };
    record.sessions.insert("s".into(), row.clone());
    write(&file, &record);
    let listener = Listener::open(file.clone(), PORT + 1, THIS.into(), false, Some(PORT), NOW);
    assert!(!file.exists(), "any fallback purges the whole file");
    assert_eq!(listener.judge(Some(&row), &mark(PREV, "g"), NOW), Err(Refusal::PortFallback));
    assert_eq!(listener.lost_port(), Some(PORT), "the lost port is never probed");
    assert!(!listener.within_cap(PREV, NOW));
}

#[test]
fn the_previous_runs_rows_are_kept_only_within_the_cap_on_the_same_port() {
    let (_dir, file) = record_file();
    let mut record = Record { nonce: PREV.into(), port: PORT, last_alive: NOW - 60, ..Record::default() };
    record.sessions.insert("prev".into(), row_of(vec![], "g", PREV));
    record.sessions.insert("older".into(), row_of(vec![], "g", OLDER));
    write(&file, &record);
    let listener = Listener::open(file.clone(), PORT, THIS.into(), true, None, NOW);
    let now: Record = crate::storage::read_json(&file).unwrap();
    assert_eq!(now.sessions.keys().collect::<Vec<_>>(), ["prev"], "a run older than the previous one goes");
    assert_eq!((now.nonce.as_str(), now.port, now.last_alive), (THIS, PORT, NOW), "rewritten as this run's");
    assert!(listener.within_cap(PREV, NOW));
    assert!(!listener.within_cap(OLDER, NOW));

    // Past the cap: everything goes.
    write(&file, &record_with_alive(&record, NOW - CAP.as_secs()));
    let _ = Listener::open(file.clone(), PORT, THIS.into(), true, None, NOW);
    assert!(crate::storage::read_json::<Record>(&file).unwrap().sessions.is_empty(), "purged past the cap");

    // Another port than the record's: everything goes.
    write(&file, &record_with_alive(&record, NOW - 5));
    let other = Listener::open(file.clone(), PORT + 7, THIS.into(), true, None, NOW);
    assert!(crate::storage::read_json::<Record>(&file).unwrap().sessions.is_empty());
    assert!(!other.within_cap(PREV, NOW));

    // An unreadable file is purged.
    std::fs::write(&file, "{not json").unwrap();
    let _ = Listener::open(file.clone(), PORT, THIS.into(), true, None, NOW);
    assert!(crate::storage::read_json::<Record>(&file).unwrap().sessions.is_empty());
}

fn record_with_alive(record: &Record, alive: u64) -> Record {
    Record { last_alive: alive, ..record.clone() }
}

// ── the guards ─────────────────────────────────────────────────────────────

/// Every guard, each failing closed.
#[test]
fn the_revival_guards() {
    let (_dir, file) = record_file();
    let row = row_of(vec![], "g", PREV);
    let listener = previous_run(&file, "s", row.clone(), NOW - 120);
    assert_eq!(listener.judge(Some(&row), &mark(PREV, "g"), NOW), Ok(Duration::from_secs(120)));
    assert_eq!(listener.judge(None, &mark(PREV, "g"), NOW), Err(Refusal::NoRecord));
    // Port: the stamp's, then the row's.
    let moved = Mark { port: PORT + 1, ..mark(PREV, "g") };
    assert_eq!(listener.judge(Some(&row), &moved, NOW), Err(Refusal::PortMismatch));
    assert_eq!(listener.judge(Some(&Row { port: PORT + 1, ..row.clone() }), &mark(PREV, "g"), NOW), Err(Refusal::PortMismatch));
    // Nonce: the stamp's must be the row's, and the row's the previous run's.
    assert_eq!(listener.judge(Some(&row), &mark(OLDER, "g"), NOW), Err(Refusal::NonceMismatch));
    let older = row_of(vec![], "g", OLDER);
    assert_eq!(listener.judge(Some(&older), &mark(OLDER, "g"), NOW), Err(Refusal::NonceMismatch));
    // Downtime: under the cap only.
    assert_eq!(listener.judge(Some(&row), &mark(PREV, "g"), NOW - 120 + CAP.as_secs()), Err(Refusal::Expired));
    assert!(listener.judge(Some(&row), &mark(PREV, "g"), NOW - 121 + CAP.as_secs()).is_ok());
    // Grant: the stamp names the row's.
    assert_eq!(listener.judge(Some(&row), &mark(PREV, "other"), NOW), Err(Refusal::GrantMismatch));
    // CLI: one that was not seen reconnecting.
    let local = Row { local_model: true, ..row.clone() };
    assert_eq!(listener.judge(Some(&local), &mark(PREV, "g"), NOW), Err(Refusal::CliUnverified));
    let copilot = Row { cmd_stem: "copilot".into(), ..row.clone() };
    assert_eq!(listener.judge(Some(&copilot), &mark(PREV, "g"), NOW), Err(Refusal::CliUnverified), "120 s is past Copilot's threshold");
    // This run's own row (a released PTY): no downtime at all.
    let own = row_of(vec![], "g", THIS);
    assert_eq!(listener.judge(Some(&own), &mark(THIS, "g"), NOW), Ok(Duration::ZERO));
    assert_eq!(listener.judge(Some(&Row { cmd_stem: "copilot".into(), ..own }), &mark(THIS, "g"), NOW), Ok(Duration::ZERO));
}

#[test]
fn which_clis_are_revived() {
    let short = Duration::from_secs(10);
    for cli in ["claude", "codex", "opencode"] {
        assert!(cli_revives(cli, false, CAP - Duration::from_secs(1)), "{cli}");
    }
    assert!(cli_revives("copilot", false, COPILOT_CAP - Duration::from_secs(1)));
    assert!(!cli_revives("copilot", false, COPILOT_CAP), "dropped for good past its threshold");
    assert!(!cli_revives("vibe", true, short), "a local model's client was never checked");
    assert!(!cli_revives("claude", true, short));
    assert!(!cli_revives("", false, short));
    assert!(cli_revives("aider", false, short), "the env pair only: one stateless call per run");
}

/// A refused row is dropped (it cannot pass later); a missing one changes nothing.
#[test]
fn a_refused_candidate_drops_its_row() {
    let (_dir, file) = record_file();
    let row = row_of(vec![], "g", PREV);
    let listener = previous_run(&file, "s", row, NOW - 30);
    assert!(listener.candidate("absent", &mark(PREV, "g"), NOW).is_none());
    assert!(listener.candidate("s", &mark(PREV, "g"), NOW).is_some());
    assert!(listener.candidate("s", &mark(PREV, "other"), NOW).is_none());
    assert!(listener.candidate("s", &mark(PREV, "g"), NOW).is_none(), "gone after the refusal");
}

// ── revive ─────────────────────────────────────────────────────────────────

/// The previous run's tokens and their row; this launch's fresh grant.
struct Revival {
    store: TokenStore,
    old: Vec<(Caller, String, String)>,
    fresh: Vec<String>,
    row: Row,
}

fn revival(callers: &[Caller], fresh_callers: &[Caller], tweak: impl Fn(&mut Identity)) -> Revival {
    let store = TokenStore::default();
    let old: Vec<(Caller, String, String)> = callers
        .iter()
        .map(|c| {
            let token = mint_token().unwrap();
            let hash = token_hash(&token);
            (*c, token, hash)
        })
        .collect();
    let lanes = old.iter().map(|(c, _, h)| LaneRow::of(&identity("old", *c), h)).collect();
    let grant = old.iter().find(|(c, _, _)| revivable(*c)).map(|(_, _, h)| h.clone()).unwrap_or_default();
    let row = row_of(lanes, &grant, PREV);
    let fresh = fresh_callers
        .iter()
        .map(|c| {
            let token = mint_token().unwrap();
            let mut id = identity("new", *c);
            tweak(&mut id);
            store.register(token.clone(), id, false);
            token_hash(&token)
        })
        .collect();
    Revival { store, old, fresh, row }
}

#[test]
fn matching_lanes_come_back_under_their_recorded_token() {
    let all = [Caller::Helper, Caller::Pusher, Caller::Marker, Caller::Printer, Caller::Cockpit, Caller::Tabs];
    let r = revival(&all, &all, |_| {});
    let out = revive(&r.store, "new", Some("p1"), &r.row, &r.fresh);
    assert!(!out.lost, "{out:?}");
    assert_eq!(out.revived.len(), all.len());
    for (caller, token, hash) in &r.old {
        let session = r.store.authenticate(Some(&bearer(token))).unwrap_or_else(|| panic!("{caller:?} revived"));
        assert_eq!((session.identity.tab.as_str(), session.id.as_str(), session.revived), ("new", hash.as_str(), true));
        // The hash itself is never a bearer: it is hashed again.
        assert!(r.store.authenticate(Some(&bearer(hash))).is_none(), "a hash is no credential");
    }
    for fresh in &r.fresh {
        assert!(!r.store.holds_session(fresh), "no fresh session survives a revival");
    }
    let git = r.store.authenticate(Some(&bearer(&r.old[1].1))).unwrap();
    assert_eq!(git.identity.push.unwrap().git_at_spawn, Some((7, 9)), "git_at_spawn comes from the record");
    assert_eq!(out.retarget.len(), all.len());
}

#[test]
fn schedule_and_root_are_never_revived_and_leave_the_tab_stale() {
    for never in [Caller::Scheduler, Caller::Agent, Caller::Web] {
        let r = revival(&[Caller::Helper, never], &[Caller::Helper, never], |_| {});
        let out = revive(&r.store, "new", Some("p1"), &r.row, &r.fresh);
        assert_eq!(out.revived.len(), 1, "{never:?}");
        assert!(out.lost, "{never:?}: its loss reads as stale");
        assert!(r.store.authenticate(Some(&bearer(&r.old[1].1))).is_none(), "{never:?} stays dead");
        assert!(!r.store.holds_session(&r.fresh[1]), "{never:?}: the fresh one is revoked too");
        assert_eq!(r.store.map().len(), 1, "only the help lane is held");
    }
}

#[test]
fn a_lane_switched_off_since_the_crash_is_not_revived() {
    let r = revival(&[Caller::Helper, Caller::Printer], &[Caller::Helper], |_| {});
    let out = revive(&r.store, "new", Some("p1"), &r.row, &r.fresh);
    assert_eq!(out.revived.len(), 1);
    assert!(out.lost, "the agent still names the print server, which no longer answers");
    assert!(r.store.authenticate(Some(&bearer(&r.old[1].1))).is_none());
}

/// Each recomputed identity field that moved since the crash keeps its lane dead.
#[test]
fn a_changed_identity_is_not_revived() {
    let cases: Vec<(&str, Caller, Box<dyn Fn(&mut Identity)>)> = vec![
        ("project", Caller::Printer, Box::new(|id| id.project = Some("p2".into()))),
        ("schedule target", Caller::Marker, Box::new(|id| id.schedule_target.as_mut().unwrap().target = "t2".into())),
        ("push dir", Caller::Pusher, Box::new(|id| id.push.as_mut().unwrap().dir = std::env::temp_dir().join("elsewhere"))),
        ("fence scope", Caller::Pusher, Box::new(|id| id.push.as_mut().unwrap().fence_scope = None)),
        ("unfenced host", Caller::Pusher, Box::new(|id| id.push.as_mut().unwrap().unfenced_host = true)),
    ];
    for (what, caller, tweak) in cases {
        let r = revival(&[caller], &[caller], tweak);
        let out = revive(&r.store, "new", Some("p1"), &r.row, &r.fresh);
        assert!(out.revived.is_empty() && out.lost, "{what}");
        assert!(r.store.authenticate(Some(&bearer(&r.old[0].1))).is_none(), "{what}");
        assert!(r.store.map().is_empty(), "{what}: the fresh one is revoked");
    }
}

#[test]
fn a_launch_into_another_project_or_a_held_hash_revives_nothing() {
    let r = revival(&[Caller::Helper], &[Caller::Helper], |_| {});
    let out = revive(&r.store, "new", Some("p2"), &r.row, &r.fresh);
    assert!(out.revived.is_empty() && out.lost);

    let r = revival(&[Caller::Helper], &[Caller::Helper], |_| {});
    r.store.register(r.old[0].1.clone(), identity("elsewhere", Caller::Helper), false);
    let out = revive(&r.store, "new", Some("p1"), &r.row, &r.fresh);
    assert!(out.revived.is_empty(), "a recorded hash held already: fail closed");
    assert_eq!(r.store.authenticate(Some(&bearer(&r.old[0].1))).unwrap().identity.tab, "elsewhere", "left alone");
}

/// The store keys sessions by hash, the record holds hashes: no token is
/// kept in the map or written anywhere.
#[test]
fn no_plaintext_token_in_the_store_or_the_record() {
    let (_dir, file) = record_file();
    let listener = Listener::open(file.clone(), PORT, THIS.into(), true, None, NOW);
    let store = TokenStore::default();
    let mut env = std::collections::HashMap::new();
    let mut tokens = Vec::new();
    for (var, caller) in [(super::super::HELP_TOKEN_ENV, Caller::Helper), (super::super::GIT_TOKEN_ENV, Caller::Pusher), (super::super::SCHEDULE_TOKEN_ENV, Caller::Scheduler)] {
        let (token, _) = grant(&store, "t", caller);
        env.insert(var.to_string(), token.clone());
        tokens.push(token);
    }
    let row = created_row(&store, &env, &listener, Some("p1".into()), "claude", false).unwrap();
    assert_eq!(row.grant, token_hash(&env[super::super::GIT_TOKEN_ENV]), "the stamp names a revivable lane first");
    listener.write_row("s", row);
    let written = std::fs::read_to_string(&file).unwrap();
    for token in &tokens {
        assert!(!store.map().contains_key(token), "keyed by hash");
        assert!(!written.contains(token.as_str()), "no token on disk");
        assert!(store.map().contains_key(&token_hash(token)));
    }
    assert!(!written.contains(&token_hash(&tokens[2])), "a schedule hash is not even written");
}

// ── lifecycle ──────────────────────────────────────────────────────────────

#[test]
fn the_record_follows_the_sessions_lifecycle() {
    let (_dir, file) = record_file();
    let listener = Listener::open(file.clone(), PORT, THIS.into(), true, None, NOW);
    let lanes = vec![LaneRow::of(&identity("t", Caller::Helper), "h1"), LaneRow::of(&identity("t", Caller::Printer), "h2")];
    listener.write_row("a", row_of(lanes.clone(), "h1", THIS));
    listener.write_row("b", row_of(lanes, "h1", THIS));
    let read = || crate::storage::read_json::<Record>(&file).unwrap();
    // A rename re-keys the row.
    listener.rename("a", "a2");
    assert!(read().sessions.contains_key("a2") && !read().sessions.contains_key("a"));
    // A revoke drops the hash but keeps the lane listed (still stale).
    listener.forget_hashes(&["h2".to_string()]);
    let after = read();
    assert_eq!(after.sessions["a2"].lanes[1].hash, None);
    assert_eq!(after.sessions["a2"].lanes[1].caller, "printer");
    assert_eq!(after.sessions["a2"].lanes[0].hash.as_deref(), Some("h1"));
    // A kill drops the row.
    listener.drop_session("a2");
    assert!(!read().sessions.contains_key("a2"));
    // The heartbeat refreshes the clock and drops sessions that are gone.
    listener.heartbeat(NOW + 300, Some(&HashSet::new()));
    assert_eq!(read().last_alive, NOW + 300);
    assert!(read().sessions.is_empty());
    listener.write_row("c", row_of(vec![], "g", THIS));
    listener.heartbeat(NOW + 600, None);
    assert!(read().sessions.contains_key("c"), "no listing: nothing is pruned");
    listener.clear();
    assert!(read().sessions.is_empty());
    // A clean quit deletes the file, and nothing writes it again.
    listener.delete();
    assert!(!file.exists());
    listener.write_row("d", row_of(vec![], "g", THIS));
    listener.heartbeat(NOW + 900, None);
    assert!(!file.exists(), "nothing outlives the clean quit");
}

/// A token of the previous run's session is pending (a `503`) until it is
/// revived or refused, and only within the cap.
#[test]
fn a_previous_runs_token_is_pending_until_settled() {
    let (_dir, file) = record_file();
    let lanes = vec![LaneRow::of(&identity("t", Caller::Helper), "h1")];
    let row = row_of(lanes, "h1", PREV);
    let listener = previous_run(&file, "s", row.clone(), NOW - 60);
    assert!(listener.pending("h1", NOW));
    assert!(!listener.pending("h1", NOW - 60 + CAP.as_secs()), "past the cap: refused, not pending");
    assert!(!listener.pending("other", NOW));
    listener.settled(&row);
    assert!(!listener.pending("h1", NOW));
}

#[test]
fn a_revived_row_keeps_lost_lanes_without_a_hash_and_takes_the_new_stamp() {
    let lanes = vec![LaneRow::of(&identity("t", Caller::Helper), "h1"), LaneRow::of(&identity("t", Caller::Printer), "h2")];
    let row = row_of(lanes.clone(), "h2", PREV);
    let outcome = Outcome { revived: vec![lanes[0].clone()], lost: true, retarget: vec![] };
    let kept = revived_row(row.clone(), &outcome, None);
    assert_eq!((kept.nonce.as_str(), kept.grant.as_str()), (PREV, "h2"), "not re-stamped: the old nonce stays");
    assert_eq!(kept.lanes[1].hash, None, "lost for good");
    let stamped = revived_row(row, &outcome, Some((THIS, "h1")));
    assert_eq!((stamped.nonce.as_str(), stamped.grant.as_str()), (THIS, "h1"));
}

/// `adopt` of a revived tab carries only revivable lanes: a session of a
/// lane that is never revived, found beside it, is revoked.
#[test]
fn adopt_never_carries_an_unrevivable_lane_of_a_revived_tab() {
    let r = revival(&[Caller::Helper], &[Caller::Helper], |_| {});
    let out = revive(&r.store, "new", Some("p1"), &r.row, &r.fresh);
    assert_eq!(out.revived.len(), 1);
    let (schedule, schedule_hash) = grant(&r.store, "new", Caller::Scheduler);
    assert!(r.store.adopt(&r.old[0].2, "newer"));
    assert_eq!(r.store.authenticate(Some(&bearer(&r.old[0].1))).unwrap().identity.tab, "newer");
    assert!(r.store.authenticate(Some(&bearer(&schedule))).is_none(), "never carried");
    assert!(!r.store.holds_session(&schedule_hash));
}

/// Through this process's listener (the only test that installs one): a PTY
/// teardown (`release_tab`) keeps the row's hashes for a later revival; a
/// revoke (`revoke_tab`, `revoke_session`) drops them; a kill drops the row.
#[test]
fn release_keeps_the_row_and_revoke_purges_it() {
    use crate::services::root_mcp::{release_tab, revoke_session, revoke_tab, tokens};
    let dir = tempfile::tempdir().unwrap().keep();
    let file = Role::Window.record(&dir);
    install(Listener::open(file.clone(), PORT, THIS.into(), true, None, NOW));
    let Some(global) = listener().filter(|l| l.file == file) else { panic!("another test installed a listener") };
    let tab = "reattach-global:t1";
    let (help, help_hash) = grant(tokens(), tab, Caller::Helper);
    let (print, print_hash) = grant(tokens(), tab, Caller::Printer);
    let lanes = vec![LaneRow::of(&identity(tab, Caller::Helper), &help_hash), LaneRow::of(&identity(tab, Caller::Printer), &print_hash)];
    global.write_row("reattach-global-session", row_of(lanes, &help_hash, THIS));
    let hashes = || {
        crate::storage::read_json::<Record>(&file).unwrap().sessions["reattach-global-session"]
            .lanes
            .iter()
            .filter_map(|l| l.hash.clone())
            .collect::<Vec<_>>()
    };
    assert!(release_tab(tab));
    assert_eq!(hashes(), [help_hash.clone(), print_hash.clone()], "a released tab keeps its row");
    tokens().register(help, identity(tab, Caller::Helper), false);
    tokens().register(print, identity(tab, Caller::Printer), false);
    revoke_session(&print_hash).unwrap();
    assert_eq!(hashes(), [help_hash.clone()], "a revoked session leaves the record");
    assert!(revoke_tab(tab));
    assert!(hashes().is_empty(), "a revoked tab leaves the record");
    on_session_renamed("reattach-global-session", "reattach-global-renamed");
    on_session_gone("reattach-global-renamed");
    assert!(crate::storage::read_json::<Record>(&file).unwrap().sessions.is_empty(), "a killed session's row goes");
}

#[test]
fn the_stamp_grant_prefers_a_revivable_lane() {
    let mut env = std::collections::HashMap::new();
    assert_eq!(stamp_grant(&env), None);
    env.insert(super::super::SCHEDULE_TOKEN_ENV.to_string(), "s".to_string());
    assert_eq!(stamp_grant(&env), Some(token_hash("s")), "any lane when no revivable one");
    env.insert(super::super::HELP_TOKEN_ENV.to_string(), "h".to_string());
    assert_eq!(stamp_grant(&env), Some(token_hash("h")));
}

/// R3 (finding 2): a revoke that lands between a launch building its row
/// (`prepare`) and writing it (`commit`) finds no row to clear; the write
/// that follows must not put the revoked hash back — a created row or a
/// revived one alike.
#[test]
fn a_row_written_after_a_revoke_never_carries_the_revoked_hash() {
    let (_dir, file) = record_file();
    let listener = Listener::open(file.clone(), PORT, THIS.into(), true, None, NOW);
    let lanes = vec![LaneRow::of(&identity("t", Caller::Helper), "h1"), LaneRow::of(&identity("t", Caller::Printer), "h2")];
    let built = row_of(lanes.clone(), "h1", THIS);
    listener.forget_hashes(&["h1".to_string()]);
    listener.write_row("created", built);
    let outcome = Outcome { revived: lanes.clone(), lost: false, retarget: vec![] };
    listener.write_row("revived", revived_row(row_of(lanes, "h1", PREV), &outcome, Some((THIS, "h1"))));
    let record: Record = crate::storage::read_json(&file).unwrap();
    for session in ["created", "revived"] {
        let hashes: Vec<_> = record.sessions[session].lanes.iter().map(|l| l.hash.as_deref()).collect();
        assert_eq!(hashes, [None, Some("h2")], "{session}: the revoked hash stays off the disk");
    }
}

/// R3 (finding 2): a revoke whose write fails removes the record rather
/// than leave the hash for a later run, and within this run a row that
/// still names a revoked hash revives nothing of it.
#[test]
fn a_revoke_that_cannot_write_still_revives_nothing() {
    let (_dir, file) = record_file();
    let lanes = vec![LaneRow::of(&identity("t", Caller::Helper), "h1"), LaneRow::of(&identity("t", Caller::Printer), "h2")];
    let row = row_of(lanes, "h1", PREV);
    let listener = previous_run(&file, "s", row.clone(), NOW - 60);
    // The revoke's write fails (here: the file cannot be parsed back).
    std::fs::write(&file, "{ not json").unwrap();
    listener.forget_hashes(&["h1".to_string()]);
    assert!(!file.exists(), "the record goes rather than keep the hash");
    // A row naming it anyway (a file the purge could not remove).
    let mut record = Record { nonce: THIS.into(), port: PORT, last_alive: NOW, ..Record::default() };
    record.sessions.insert("s".into(), row);
    write(&file, &record);
    let found = listener.candidate("s", &mark(PREV, "h1"), NOW).expect("the row still passes the guards");
    let hashes: Vec<_> = found.lanes.iter().map(|l| l.hash.as_deref()).collect();
    assert_eq!(hashes, [None, Some("h2")]);
}

/// R3 (finding 3): a wall clock stepped back behind the previous run's
/// `last_alive` refuses, instead of reading as no downtime at all (which
/// kept the cap open for as long as the step); and the listener's own clock
/// never runs behind the wall clock it opened at.
#[test]
fn a_clock_stepped_back_never_stretches_the_cap() {
    let (_dir, file) = record_file();
    let row = row_of(vec![LaneRow::of(&identity("t", Caller::Helper), "h1")], "h1", PREV);
    let listener = previous_run(&file, "s", row.clone(), NOW - 60);
    assert!(listener.within_cap(PREV, NOW));
    assert!(!listener.within_cap(PREV, NOW - 61), "before last_alive: refused");
    assert!(!listener.pending("h1", NOW - 61));
    assert_eq!(listener.judge(Some(&row), &mark(PREV, "h1"), NOW - 61), Err(Refusal::Expired));
    // NOW is ahead of this machine's wall clock, as after a step back: the
    // listener's clock still reads it, plus the time since it opened.
    assert!(now_secs() < NOW, "the test's premise");
    let clock = listener.clock();
    assert!((NOW..NOW + 60).contains(&clock), "{clock}");
}

/// R3 (finding 5): a session granted no revivable lane gets no row, so its
/// stamp's fallback grant (a schedule or root hash) is never written.
#[test]
fn a_session_with_no_revivable_lane_writes_no_row() {
    let (_dir, file) = record_file();
    let listener = Listener::open(file, PORT, THIS.into(), true, None, NOW);
    let store = TokenStore::default();
    let mut env = std::collections::HashMap::new();
    for (var, caller) in [(super::super::SCHEDULE_TOKEN_ENV, Caller::Scheduler), (super::super::TOKEN_ENV, Caller::Agent)] {
        let (token, _) = grant(&store, "t", caller);
        env.insert(var.to_string(), token);
    }
    assert!(stamp_grant(&env).is_some(), "the stamp still names a grant");
    assert_eq!(created_row(&store, &env, &listener, Some("p1".into()), "claude", false), None);
}

/// R3 (finding 6): a write already past the `stopped` check when the clean
/// quit deletes the file lands before the delete, never after it: the
/// delete waits for it, and no file outlives the quit.
#[test]
fn a_write_in_flight_never_lands_after_the_clean_quit() {
    let (_dir, file) = record_file();
    let listener = std::sync::Arc::new(Listener::open(file.clone(), PORT, THIS.into(), true, None, NOW));
    let (entered, in_patch) = std::sync::mpsc::channel();
    let writer = {
        let listener = listener.clone();
        std::thread::spawn(move || {
            listener.patch(|record| {
                entered.send(()).unwrap();
                // The quit runs now, while this write is inside its patch.
                std::thread::sleep(Duration::from_millis(300));
                record.sessions.insert("late".into(), row_of(vec![], "g", THIS));
            });
        })
    };
    in_patch.recv().unwrap();
    listener.delete();
    writer.join().unwrap();
    assert!(!file.exists(), "the in-flight write landed before the delete, not after it");
}
