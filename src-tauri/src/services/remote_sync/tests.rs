use super::*;

/// G7 across processes: a manifest the other process (window or desktop
/// sidecar) rewrote since this one cached it is never overwritten from the
/// stale copy, and the cache reads the new version next.
#[test]
fn a_manifest_changed_by_another_process_is_not_clobbered() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p").join("sync.json");
    let mut cache = HashMap::new();
    ensure_loaded_at(&mut cache, "p", &path).insert("a".into(), SyncEntry::default());
    save_manifest_at(&path, &cache["p"]).expect("ours to write");
    ensure_loaded_at(&mut cache, "p", &path).insert("b".into(), SyncEntry::default());
    save_manifest_at(&path, &cache["p"]).expect("still ours: we wrote the last version");
    // The other process writes its own version.
    let theirs: Manifest = [("theirs-is-longer".to_string(), SyncEntry::default())].into_iter().collect();
    std::fs::write(&path, serde_json::to_string_pretty(&theirs).unwrap()).unwrap();
    cache.get_mut("p").unwrap().insert("c".into(), SyncEntry::default());
    assert_eq!(save_manifest_at(&path, &cache["p"]).unwrap_err(), CHANGED_ELSEWHERE);
    let on_disk: Manifest = crate::storage::read_json(&path).unwrap();
    assert!(on_disk.contains_key("theirs-is-longer") && !on_disk.contains_key("c"));
    let fresh = ensure_loaded_at(&mut cache, "p", &path);
    assert!(fresh.contains_key("theirs-is-longer") && !fresh.contains_key("a"), "re-read, not the stale copy");
    fresh.insert("d".into(), SyncEntry::default());
    save_manifest_at(&path, &cache["p"]).expect("current again");
}

/// An unparseable `sync.json` is never read as "nothing selected" and then
/// replaced: the cache stands in an empty manifest, every save refuses, the
/// bytes are kept beside it, and a repaired (here: removed) file syncs again.
#[test]
fn an_unreadable_manifest_is_kept_and_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p").join("sync.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let damaged = b"{\"notes.md\": {\"selected\": tr";
    std::fs::write(&path, damaged).unwrap();

    let err = check_manifest_readable_at(&path).unwrap_err();
    assert!(err.contains("could not be read"), "{err}");
    let mut cache = HashMap::new();
    let m = ensure_loaded_at(&mut cache, "p", &path);
    assert!(m.is_empty(), "stands in as empty for the callers holding a &mut");
    m.insert("other".into(), SyncEntry::default());
    assert!(save_manifest_at(&path, &cache["p"]).is_err(), "never replaces the damaged file");
    assert!(save_or_mark_stale_at(&path, cache.get_mut("p").unwrap(), &["other".to_string()]).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), damaged);
    let kept: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("sync.json.unreadable-"))
        .collect();
    assert_eq!(kept.len(), 1, "one copy per damaged version");
    assert_eq!(std::fs::read(&kept[0]).unwrap(), damaged);
    assert!(check_manifest_readable_at(&path).is_err(), "still refused");

    std::fs::remove_file(&path).unwrap();
    check_manifest_readable_at(&path).expect("a positively missing file starts empty");
    let m = ensure_loaded_at(&mut cache, "p", &path);
    m.insert("fresh".into(), SyncEntry::default());
    save_manifest_at(&path, &cache["p"]).expect("writable again once removed");
}

/// Fixed decision #7: a pull or push whose record fails to save must never
/// leave a base that reads clean or lets a push through unasked. Here the
/// other process wrote `sync.json` meanwhile (the CAS refusal): the save
/// fails, the record is forgotten in the cache AND on disk, and the re-read
/// entry is amber against the post-transfer stats with a push that asks.
#[test]
fn a_failed_manifest_save_after_a_transfer_never_reads_clean() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p").join("sync.json");
    let old_base = SyncEntry {
        selected: true,
        host_size: 10,
        host_mtime: Some(100),
        local_size: 10,
        local_mtime: Some(100),
        last_pull_ts: Some(1),
        ..Default::default()
    };
    let mut cache = HashMap::new();
    ensure_loaded_at(&mut cache, "p", &path).insert("f".into(), old_base.clone());
    save_manifest_at(&path, &cache["p"]).unwrap();
    // The other process writes its own version (same old base for `f`).
    let theirs: Manifest = [("f".to_string(), old_base.clone()), ("theirs".to_string(), SyncEntry::default())]
        .into_iter()
        .collect();
    std::fs::write(&path, serde_json::to_string_pretty(&theirs).unwrap()).unwrap();
    // A pull landed new bytes: host (20, 200), mirror (20, 201).
    let host_now = Some((20, Some(200)));
    let local_now = Some((20, Some(201)));
    let m = cache.get_mut("p").unwrap();
    record_pull(m, "f", 20, Some(200), 20, Some(201));
    let err = save_or_mark_stale_at(&path, m, &["f".to_string()]).unwrap_err();
    assert_eq!(err, CHANGED_ELSEWHERE);
    // The caller's copy no longer vouches for the record.
    assert_eq!(compute_state(&m["f"], host_now, local_now, false), SyncState::Amber);
    assert_eq!(push_decision(&m["f"], host_now), PushDecision::Stale);
    // Nor does the file, re-read through the cache; the other process's
    // entries survive.
    let fresh = ensure_loaded_at(&mut cache, "p", &path);
    assert!(fresh.contains_key("theirs"), "their version was kept, not clobbered");
    let f = &fresh["f"];
    assert!(f.selected && f.last_pull_ts.is_some(), "the user's choices and history stay");
    assert_eq!(compute_state(f, host_now, local_now, false), SyncState::Amber);
    assert_eq!(push_decision(f, host_now), PushDecision::Stale);
    // Even the pre-transfer stats do not match a forgotten base (the old
    // base would have read green against them).
    assert_eq!(compute_state(f, Some((10, Some(100))), Some((10, Some(100))), false), SyncState::Amber);
    // A later successful save goes through as usual.
    record_pull(fresh, "f", 20, Some(200), 20, Some(201));
    save_or_mark_stale_at(&path, fresh, &["f".to_string()]).expect("current again");
    assert_eq!(compute_state(&cache["p"]["f"], host_now, local_now, false), SyncState::Green);
}

/// The same when the file cannot be written at all: the in-memory record is
/// forgotten and the cache re-derives from disk instead of trusting it.
#[test]
fn an_unwritable_manifest_forgets_the_unsaved_record() {
    let dir = tempfile::tempdir().unwrap();
    // The state dir is a FILE, so neither the save nor the marking can write.
    let blocker = dir.path().join("p");
    std::fs::write(&blocker, b"not a dir").unwrap();
    let path = blocker.join("sync.json");
    let mut cache = HashMap::new();
    let m = ensure_loaded_at(&mut cache, "p", &path);
    record_push(m, "f", 20, Some(200), 20, Some(201));
    assert!(save_or_mark_stale_at(&path, m, &["f".to_string()]).is_err());
    let host_now = Some((20, Some(200)));
    assert_eq!(compute_state(&m["f"], host_now, Some((20, Some(201))), false), SyncState::Amber);
    assert_eq!(push_decision(&m["f"], host_now), PushDecision::Stale);
    assert!(!stamps().contains_key(&path), "the cache re-reads the file next time");
}

/// The SFTP pull used to leave every mirror file at the staging temp file's
/// 0600: a host `0755` script lost its executable bit (rsync's path kept it).
#[cfg(unix)]
#[tokio::test]
async fn an_sftp_pull_keeps_the_host_files_mode() {
    use std::os::unix::fs::PermissionsExt;
    let mirror = tempfile::tempdir().unwrap();
    let mode_of = |rel: &str| std::fs::metadata(mirror.path().join(rel)).unwrap().permissions().mode() & 0o7777;
    let umask = process_umask();
    let pull = |rel: &'static str, mode: Option<u32>| {
        pull_file_with(rel, 3, mode, mirror.path(), rel, || async { Ok(b"#!x".to_vec()) })
    };
    pull("run.sh", Some(0o755)).await.unwrap();
    assert_eq!(mode_of("run.sh"), 0o755 & !umask);
    assert_eq!(mode_of("run.sh") & 0o100, 0o100, "the owner can still execute it");
    pull("data.txt", Some(0o644)).await.unwrap();
    assert_eq!(mode_of("data.txt"), 0o644 & !umask);
    // A re-pull with the host's new mode applies it to the existing copy.
    pull("data.txt", Some(0o755)).await.unwrap();
    assert_eq!(mode_of("data.txt"), 0o755 & !umask);
    // No host mode: the existing mirror file's own mode is kept exactly …
    std::fs::set_permissions(mirror.path().join("data.txt"), std::fs::Permissions::from_mode(0o750)).unwrap();
    pull("data.txt", None).await.unwrap();
    assert_eq!(mode_of("data.txt"), 0o750);
    // … and a new file gets the umask default, not 0600.
    pull("new.txt", None).await.unwrap();
    assert_eq!(mode_of("new.txt"), 0o666 & !umask);
    assert_eq!(std::fs::read(mirror.path().join("run.sh")).unwrap(), b"#!x");
}

/// M4b review: the host is attacker-controlled, so its setuid/setgid/sticky
/// bits never reach the mirror (rsync without `-p` drops them too). `open(2)`
/// honours them in the create mode; only a later write by an unprivileged
/// process clears setuid/setgid — an empty file (no write) or a privileged
/// process kept a planted `06755`. Nor does a local special bit survive a
/// replacement whose bytes are the host's.
#[cfg(unix)]
#[tokio::test]
async fn an_sftp_pull_never_applies_the_hosts_special_mode_bits() {
    use std::os::unix::fs::PermissionsExt;
    let mirror = tempfile::tempdir().unwrap();
    let mode_of = |rel: &str| std::fs::metadata(mirror.path().join(rel)).unwrap().permissions().mode() & 0o7777;
    let umask = process_umask();
    let empty = |rel: &'static str, mode: Option<u32>| {
        pull_file_with(rel, 0, mode, mirror.path(), rel, || async { Ok(Vec::new()) })
    };
    empty("planted", Some(0o6755)).await.unwrap();
    assert_eq!(mode_of("planted") & 0o7000, 0, "no setuid/setgid/sticky from the host");
    assert_eq!(mode_of("planted"), 0o755 & !umask);
    pull_file_with("sticky", 3, Some(0o1777), mirror.path(), "sticky", || async { Ok(b"abc".to_vec()) })
        .await
        .unwrap();
    assert_eq!(mode_of("sticky") & 0o7000, 0);
    // A kept local mode carries its permission bits, not a special bit.
    std::fs::set_permissions(mirror.path().join("planted"), std::fs::Permissions::from_mode(0o4750)).unwrap();
    empty("planted", None).await.unwrap();
    assert_eq!(mode_of("planted"), 0o750);
}

/// This process's umask, read without changing it (Linux `/proc`; the usual
/// `022` elsewhere).
#[cfg(unix)]
fn process_umask() -> u32 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("Umask:"))
                .and_then(|v| u32::from_str_radix(v.trim(), 8).ok())
        })
        .unwrap_or(0o022)
}

/// #23 D2. Both walkers skipped the entry *named* `.git`, which correctly skips a
/// linked worktree's `.git` FILE — but the checkout around it is not named `.git`
/// and was walked like ordinary content. A worktree inside the project was
/// therefore mirrored as a full second copy of the source tree: every pass
/// doubled, the copy counted in the big-folder census, and it landed on the peer
/// as a plain directory with no `.git` at all, which then drifted.
#[test]
fn the_mirror_walk_stops_at_a_nested_repo_or_worktree() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join("src.rs"), b"x").unwrap();

    // A linked worktree: `.git` is a FILE holding `gitdir: …`.
    let wt = root.join("wt-feature");
    std::fs::create_dir_all(wt.join("deep")).unwrap();
    std::fs::write(
        wt.join(".git"),
        b"gitdir: /elsewhere/.git/worktrees/feature",
    )
    .unwrap();
    std::fs::write(wt.join("deep/copy.rs"), b"x").unwrap();

    // A nested clone: `.git` is a DIRECTORY.
    let nested = root.join("vendor/lib");
    std::fs::create_dir_all(nested.join(".git")).unwrap();
    std::fs::write(nested.join("lib.rs"), b"x").unwrap();

    let mut out = Vec::new();
    walk_mirror_inner(root, root, &mut out).unwrap();
    out.sort();
    assert_eq!(
        out,
        vec!["src.rs".to_string()],
        "only the project's own files; the walk stops at any .git boundary"
    );
}

#[test]
fn the_mirror_walk_does_not_stop_at_the_project_root_itself() {
    // The root of course holds a `.git` — the boundary is a check on
    // SUBdirectories, or every project would sync nothing at all.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join("a.txt"), b"x").unwrap();
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::write(root.join("sub/b.txt"), b"x").unwrap();

    let mut out = Vec::new();
    walk_mirror_inner(root, root, &mut out).unwrap();
    out.sort();
    assert_eq!(out, vec!["a.txt".to_string(), "sub/b.txt".to_string()]);
}

fn excluded_dir() -> SyncEntry {
    SyncEntry {
        is_dir: true,
        excluded: true,
        auto_off: true,
        ..Default::default()
    }
}

#[test]
fn exclusion_covers_the_subtree_of_a_whole_project_transfer() {
    let mut m = Manifest::new();
    m.insert(
        "".into(),
        SyncEntry {
            is_dir: true,
            auto_sync: true,
            ..Default::default()
        },
    );
    m.insert("data".into(), excluded_dir());
    assert!(is_excluded(&m, "data/raw/big.bin", ""));
    assert!(!is_excluded(&m, "src/main.rs", ""));
    // …and the background engine agrees, so the two transports can't disagree.
    assert!(!is_auto(&m, "data/raw/big.bin"));
    assert!(is_auto(&m, "src/main.rs"));
}

#[test]
fn explicitly_transferring_the_excluded_folder_overrides_its_own_marker() {
    let mut m = Manifest::new();
    m.insert("data".into(), excluded_dir());
    // Whole-project pull: skipped. Right-clicking `data` itself: honoured.
    assert!(is_excluded(&m, "data/big.bin", ""));
    assert!(!is_excluded(&m, "data/big.bin", "data"));
    // A nested exclusion inside it is still honoured — only the requested
    // path's own marker is waived.
    m.insert("data/raw".into(), excluded_dir());
    assert!(is_excluded(&m, "data/raw/big.bin", "data"));
}

#[test]
fn explicitly_transferring_a_folder_inside_an_excluded_tree_overrides_its_ancestors() {
    let mut m = Manifest::new();
    m.insert("data".into(), excluded_dir());
    m.insert("data/raw/cache".into(), excluded_dir());
    // Downloading `data/raw` for an agent: the inherited exclusion is waived…
    assert!(!is_excluded(&m, "data/raw/big.bin", "data/raw"));
    assert!(!is_excluded(&m, "data/raw/big.bin", "data/raw/big.bin"));
    // …one nested below it is not, and a sibling outside it stays excluded.
    assert!(is_excluded(&m, "data/raw/cache/x.bin", "data/raw"));
    assert!(is_excluded(&m, "data/other/x.bin", "data/raw"));
    // A prefix that is not a path segment is not "inside".
    assert!(is_excluded(&m, "data/rawer/x.bin", "data/raw"));
}

#[test]
fn a_nearer_auto_marker_re_includes_a_folder_inside_an_excluded_tree() {
    let mut m = Manifest::new();
    m.insert("data".into(), excluded_dir());
    m.insert(
        "data/small".into(),
        SyncEntry {
            is_dir: true,
            auto_sync: true,
            selected: true,
            ..Default::default()
        },
    );
    assert!(!is_excluded(&m, "data/small/notes.md", ""));
    assert!(is_excluded(&m, "data/raw/big.bin", ""));
}

#[test]
fn push_decision_safe_when_host_matches_base() {
    let e = SyncEntry {
        selected: true,
        host_size: 10,
        host_mtime: Some(100),
        last_pull_ts: Some(1),
        ..Default::default()
    };
    assert_eq!(push_decision(&e, Some((10, Some(100)))), PushDecision::Safe);
}

#[test]
fn push_decision_stale_when_host_moved() {
    let e = SyncEntry {
        selected: true,
        host_size: 10,
        host_mtime: Some(100),
        last_pull_ts: Some(1),
        ..Default::default()
    };
    assert_eq!(
        push_decision(&e, Some((11, Some(100)))),
        PushDecision::Stale
    );
    assert_eq!(
        push_decision(&e, Some((10, Some(200)))),
        PushDecision::Stale
    );
}

#[test]
fn push_decision_create_safe_when_never_synced_and_host_absent() {
    let e = SyncEntry {
        selected: true,
        ..Default::default()
    };
    assert_eq!(push_decision(&e, None), PushDecision::Safe);
}

#[test]
fn push_decision_stale_when_never_synced_but_host_exists() {
    // A local file the user wants to push, but the host already has an
    // unsynced file there — don't clobber blindly.
    let e = SyncEntry {
        selected: true,
        ..Default::default()
    };
    assert_eq!(push_decision(&e, Some((5, Some(3)))), PushDecision::Stale);
}

#[test]
fn push_decision_stale_when_host_deleted_after_sync() {
    let e = SyncEntry {
        selected: true,
        host_size: 10,
        host_mtime: Some(100),
        last_pull_ts: Some(1),
        ..Default::default()
    };
    assert_eq!(push_decision(&e, None), PushDecision::Stale);
}

fn v(major: u32, minor: u32) -> Option<RsyncVersion> {
    Some(RsyncVersion { major, minor })
}

/// A fast-path proof, as the probes give one for two 3.x rsyncs.
fn fast() -> RsyncFastPath {
    rsync_fast_path(v(3, 2), v(3, 4)).unwrap()
}

#[test]
fn rsync_version_parses_samba_rsync() {
    assert_eq!(parse_rsync_version("rsync  version 3.2.7  protocol version 31\nCopyright (C) 1996-2022\n"), v(3, 2));
    assert_eq!(parse_rsync_version("rsync  version v3.4.1  protocol version 32\n"), v(3, 4));
    assert_eq!(parse_rsync_version("rsync  version 3.0.0pre1  protocol version 30\n"), v(3, 0));
    assert_eq!(parse_rsync_version("rsync  version 2.6.9  protocol version 29\n"), v(2, 6));
    // A login banner the host's shell prints first is skipped.
    assert_eq!(parse_rsync_version("Welcome to the cluster\nrsync  version 3.1.3  protocol version 31\n"), v(3, 1));
}

#[test]
fn rsync_version_refuses_openrsync_and_garbage() {
    assert_eq!(parse_rsync_version("openrsync: protocol version 29\n"), None);
    // macOS 15's /usr/bin/rsync: openrsync, whatever it claims to match.
    assert_eq!(parse_rsync_version("openrsync: protocol version 29\nrsync version 2.6.9 compatible\n"), None);
    assert_eq!(parse_rsync_version("openrsync: protocol version 29\nrsync  version 3.0.0  protocol version 30\n"), None);
    for garbage in [
        "",
        "\n",
        "sh: rsync: command not found\n",
        "rsync version 2.6.9 compatible\n",
        "rsync  version   protocol version 31\n",
        "rsync  version x.y  protocol version 31\n",
        "rsync  version 3  protocol version 31\n",
        "my rsync  version 3.2.7  protocol version 31\n",
    ] {
        assert_eq!(parse_rsync_version(garbage), None, "{garbage:?}");
    }
}

/// The fast path needs `--protect-args` on BOTH ends; either side older
/// than 3.0, openrsync, missing or unprobed keeps the pull on SFTP.
#[cfg(unix)]
fn sh_probe(script: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("sh");
    cmd.args(["-c", script]);
    cmd
}

/// The host probe is bounded: a host that writes forever is cut at the cap
/// and a hung one stopped at the deadline, neither cached; ssh's own 255 is
/// no answer, a host without rsync (127) is one.
#[cfg(unix)]
#[test]
fn rsync_host_probe_is_bounded_and_keeps_only_answers() {
    use std::time::Duration;
    let answer = sh_probe("echo 'rsync  version 3.2.7  protocol version 31'");
    assert_eq!(probe_rsync_version(answer, Duration::from_secs(10)), Ok(v(3, 2)));
    assert_eq!(probe_rsync_version(sh_probe("echo nope >&2; exit 127"), Duration::from_secs(10)), Ok(None));
    assert_eq!(probe_rsync_version(sh_probe("exit 255"), Duration::from_secs(10)), Err(()));

    let started = std::time::Instant::now();
    assert_eq!(probe_rsync_version(sh_probe("while :; do echo rsync; done"), Duration::from_secs(30)), Ok(None));
    assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());

    let started = std::time::Instant::now();
    assert_eq!(probe_rsync_version(sh_probe("sleep 30"), Duration::from_millis(300)), Err(()));
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
}

/// The host probe runs one fixed command, with no redirect a csh login
/// shell would reject.
#[test]
fn rsync_host_probe_is_a_fixed_command() {
    assert_eq!(RSYNC_HOST_PROBE, "rsync --version");
}

/// CRLF output (a Windows-side or odd host shell) and a `v` prefix parse.
#[test]
fn rsync_version_parses_crlf_output() {
    assert_eq!(parse_rsync_version("rsync  version v3.2.7  protocol version 31\r\nCopyright\r\n"), v(3, 2));
}

#[test]
fn rsync_fast_path_needs_protect_args_on_both_ends() {
    assert!(rsync_fast_path(v(3, 0), v(3, 0)).is_some());
    assert!(rsync_fast_path(v(3, 4), v(4, 0)).is_some());
    let openrsync = parse_rsync_version("openrsync: protocol version 29\n");
    let old = parse_rsync_version("rsync  version 2.6.9  protocol version 29\n");
    for (local, host) in [(old, v(3, 2)), (v(3, 2), old), (openrsync, v(3, 2)), (v(3, 2), openrsync), (None, v(3, 2)), (v(3, 2), None), (None, None)] {
        assert_eq!(rsync_fast_path(local, host), None, "{local:?} / {host:?}");
    }
}

#[test]
fn rsync_transport_rides_controlmaster() {
    let e = rsync_ssh_transport(None);
    assert!(e.starts_with("ssh "));
    assert!(e.contains("ControlMaster=no"));
    assert!(e.contains("ControlPath="));
    assert!(e.contains("cm-%C"));
    // Port absent → no -p.
    assert!(!e.contains(" -p "));
}

#[test]
fn rsync_transport_includes_port() {
    let e = rsync_ssh_transport(Some(2222));
    assert!(e.contains(" -p 2222"));
}

#[test]
fn rsync_pull_args_build_target_and_flags() {
    let files_from = Path::new(concat!("/tmp/", crate::app_slug!(), "-rsync-files"));
    let args = rsync_pull_args(
        fast(),
        &Some("alice".to_string()),
        "host.example",
        None,
        "/srv/p/",
        "/local/mirror/",
        files_from,
    );
    assert_eq!(args[0], "-t");
    assert_eq!(args[1], "-c");
    // Gap 35: nothing beyond what the SFTP floor lands — no archive mode
    // (links, perms, owner, group, devices, specials), no recursion past
    // the list, and the floor's size cap.
    for banned in ["-a", "--archive", "-r", "--recursive", "-l", "--links", "-D", "-p", "-o", "-g"] {
        assert!(!args.iter().any(|arg| arg == banned), "{banned} in {args:?}");
    }
    assert!(!args.iter().any(|arg| arg.starts_with('-') && !arg.starts_with("--") && arg.len() > 2),
        "no bundled short flags may smuggle in archive or recursion: {args:?}");
    assert!(args.iter().any(|arg| arg == "--no-links"));
    assert!(args.iter().any(|arg| arg == "--no-devices"));
    assert!(args.iter().any(|arg| arg == "--no-specials"));
    assert!(args.iter().any(|arg| *arg == format!("--max-size={MAX_SYNC_FILE_BYTES}")));
    assert!(args.iter().any(|arg| arg == "--exclude=/.git"));
    assert!(args.iter().any(|arg| arg == "--exclude=.git"));
    assert!(args.iter().any(|arg| arg == concat!("--exclude=.", crate::app_slug!())));
    assert!(args.iter().any(|arg| arg == "--from0"));
    assert!(args
        .iter()
        .any(|arg| arg == concat!("--files-from=/tmp/", crate::app_slug!(), "-rsync-files")));
    let transport = args.iter().position(|arg| arg == "-e").unwrap();
    assert!(args[transport + 1].contains("ControlPath="));
    assert_eq!(args[transport + 2], "alice@host.example:/srv/p/");
    assert_eq!(args[transport + 3], "/local/mirror/");
}

/// The PATH's `rsync` is the samba one at 3.0 or later (`--protect-args`):
/// macOS's 2.6.9 and openrsync lack it, so the fast path never runs there.
#[cfg(unix)]
fn samba_rsync_3() -> bool {
    let Ok(out) = std::process::Command::new("rsync").arg("--version").output() else { return false };
    parse_rsync_version(&String::from_utf8_lossy(&out.stdout)).is_some_and(|v| v >= RSYNC_PROTECT_ARGS_SINCE)
}

/// rsync splits `-e` on spaces outside quotes and doubles a `'` inside
/// them: a ControlPath under a dir with a space or apostrophes reaches ssh
/// as one word, unchanged. Checked through the real rsync, with a stand-in
/// `ssh` that records its argv.
#[cfg(unix)]
#[test]
fn rsync_transport_hands_ssh_the_control_path_whole() {
    if !samba_rsync_3() {
        eprintln!("no rsync >= 3 on PATH; skipping the -e parsing check");
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let ssh = root.path().join("fake-ssh");
    let seen = root.path().join("argv");
    std::fs::write(&ssh, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexit 1\n", seen.display())).unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    for dir in ["/run/user/1000/my dir", "/home/o'neil/ssh", "/home/a'b'c/ssh"] {
        let _ = std::fs::remove_file(&seen);
        let e = rsync_ssh_transport_in(Path::new(dir), Some(2222));
        let fake = e.replacen("ssh", &ssh.display().to_string(), 1);
        let dest = root.path().join("dest");
        let _ = std::process::Command::new("rsync").arg("-e").arg(&fake).arg("h:/x/").arg(&dest).output().unwrap();
        let argv = std::fs::read_to_string(&seen).unwrap_or_else(|_| panic!("rsync never ran ssh for {dir}: {e}"));
        let words: Vec<&str> = argv.lines().collect();
        assert!(words.contains(&format!("ControlPath={}", Path::new(dir).join("cm-%C").display()).as_str()), "{dir}: {words:?}");
        assert!(words.windows(2).any(|w| w[0] == "-p" && w[1] == "2222"), "{words:?}");
    }
}

/// The host path is sent without the remote shell parsing it, so a
/// space or `$` in a project dir is one path, not two words or an expansion.
#[test]
fn rsync_pull_args_protect_the_host_path() {
    let args = rsync_pull_args(fast(), &None, "host.example", None, "/srv/my $proj/", "/m/", Path::new("/tmp/list"));
    assert!(args.iter().any(|arg| arg == "--protect-args"), "{args:?}");
    assert!(args.iter().any(|arg| arg == "host.example:/srv/my $proj/"));
}

/// The remote rsync globs its source argument: a host dir whose name holds
/// a wildcard must pull that dir, not a sibling the pattern also matches.
/// Run against the real rsync, through a stand-in `ssh` that runs the
/// remote command locally the way a login shell would.
#[cfg(unix)]
#[test]
fn rsync_pull_reads_a_wildcard_host_dir_literally() {
    if !samba_rsync_3() {
        eprintln!("no rsync >= 3 on PATH; skipping the local transfer check");
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    // A wildcard segment below a plain one holding `]` or `\`: only the
    // wildcard segment is escaped.
    for (dir, body) in [
        ("a[1]", "right"),
        ("a1", "wrong"),
        ("q?", "right"),
        ("qz", "wrong"),
        ("b\\x[2]", "right"),
        ("bx2", "wrong"),
        ("x]y/c[1]", "right"),
        ("x]y/c1", "wrong"),
        ("p\\q/d[1]", "right"),
        ("p\\q/d1", "wrong"),
    ] {
        std::fs::create_dir_all(r.join(dir)).unwrap();
        std::fs::write(r.join(dir).join("f.txt"), body).unwrap();
    }
    let ssh = r.join("fake-ssh");
    std::fs::write(&ssh, "#!/bin/sh\nshift\neval \"$*\"\n").unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let list = rsync_files_from(&["f.txt".into()]).unwrap();
    for dir in ["a[1]", "q?", "b\\x[2]", "x]y/c[1]", "p\\q/d[1]"] {
        let dest = tempfile::tempdir().unwrap();
        let src = format!("{}/", r.join(dir).display());
        let mut args = rsync_pull_args(fast(), &None, "h", None, &src, &format!("{}/", dest.path().display()), list.path());
        let e = args.iter().position(|a| a == "-e").unwrap();
        args[e + 1] = ssh.display().to_string();
        let out = std::process::Command::new("rsync").args(&args).output().unwrap();
        assert!(out.status.success(), "{dir}: {}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(std::fs::read_to_string(dest.path().join("f.txt")).unwrap(), "right", "{dir}");
    }
    // No wildcard: the path goes as it is.
    assert_eq!(rsync_literal_host_path("/srv/my $proj\\x/"), "/srv/my $proj\\x/");
}

#[test]
fn rsync_pull_args_omit_user_when_absent() {
    let args = rsync_pull_args(
        fast(),
        &None,
        "host.example",
        None,
        "/srv/p/",
        "/m/",
        Path::new("/tmp/list"),
    );
    assert!(args.iter().any(|arg| arg == "host.example:/srv/p/"));
    assert!(!args.iter().any(|arg| arg == "-a" || arg == "-r" || arg == "--recursive"));
}

#[test]
fn rsync_size_gate_matches_the_floor() {
    assert!(rsync_may_transfer(0));
    assert!(rsync_may_transfer(MAX_SYNC_FILE_BYTES));
    assert!(!rsync_may_transfer(MAX_SYNC_FILE_BYTES + 1));
}

#[test]
fn rsync_pulled_base_records_only_regular_files_within_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    let regular = dir.path().join("a.txt");
    std::fs::write(&regular, b"hello").unwrap();
    assert_eq!(rsync_pulled_base(&regular, 5).map(|(size, _)| size), Some(5));
    // Listed over the cap by the host walk: never recorded, whatever is on disk.
    assert_eq!(rsync_pulled_base(&regular, MAX_SYNC_FILE_BYTES + 1), None);
    // Missing, a directory, an oversized local file.
    assert_eq!(rsync_pulled_base(&dir.path().join("gone"), 1), None);
    let sub = dir.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    assert_eq!(rsync_pulled_base(&sub, 1), None);
    let big = dir.path().join("big.bin");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(MAX_SYNC_FILE_BYTES + 1)
        .unwrap();
    assert_eq!(rsync_pulled_base(&big, 1), None);
    #[cfg(unix)]
    {
        // A symlink to a regular file is not followed; a FIFO is not a file.
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&regular, &link).unwrap();
        assert_eq!(rsync_pulled_base(&link, 5), None);
        let fifo = dir.path().join("pipe");
        let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert_eq!(rsync_pulled_base(&fifo, 0), None);
    }
}

/// Run the real pull flags local→local when rsync is installed (the
/// transport is the only part left out): a listed path that is a FIFO, a
/// symlink, a directory full of unlisted files, or a file over the cap
/// never lands; the listed regular file does, with its mtime.
#[cfg(unix)]
#[test]
fn rsync_pull_flags_land_only_listed_regular_files_within_the_cap() {
    if !samba_rsync_3() {
        eprintln!("no rsync >= 3 on PATH; skipping the local transfer check");
        return;
    }
    let src = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let s = src.path();
    std::fs::create_dir_all(s.join("d")).unwrap();
    std::fs::write(s.join("d/ok.txt"), b"ok").unwrap();
    let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
    std::fs::File::options()
        .write(true)
        .open(s.join("d/ok.txt"))
        .unwrap()
        .set_modified(old)
        .unwrap();
    // The walker listed `swapped/inner.txt` and `was_file`; the host then
    // turned `swapped` into a FIFO and `was_file` into a directory.
    let fifo = s.join("swapped");
    let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    let fifo_leaf = s.join("pipe");
    let c = std::ffi::CString::new(fifo_leaf.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    std::fs::create_dir_all(s.join("was_file/deep")).unwrap();
    std::fs::write(s.join("was_file/unlisted.txt"), b"x").unwrap();
    std::fs::write(s.join("was_file/deep/unlisted.txt"), b"x").unwrap();
    std::os::unix::fs::symlink("/etc/hostname", s.join("link.txt")).unwrap();
    std::fs::File::create(s.join("big.bin"))
        .unwrap()
        .set_len(MAX_SYNC_FILE_BYTES + 1)
        .unwrap();
    let list = rsync_files_from(&[
        "d/ok.txt".into(),
        "swapped/inner.txt".into(),
        "pipe".into(),
        "was_file".into(),
        "link.txt".into(),
        "big.bin".into(),
    ])
    .unwrap();
    let mut args = rsync_pull_flags(list.path());
    args.push(format!("{}/", s.display()));
    args.push(format!("{}/", dest.path().display()));
    let out = std::process::Command::new("rsync").args(&args).output().unwrap();
    // rsync exits 23 for the listed path it could not find; the transfer of
    // everything else still happens.
    assert!(
        matches!(out.status.code(), Some(0 | 23)),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let d = dest.path();
    assert_eq!(std::fs::read(d.join("d/ok.txt")).unwrap(), b"ok");
    assert_eq!(
        std::fs::metadata(d.join("d/ok.txt")).unwrap().modified().unwrap(),
        old
    );
    assert!(std::fs::symlink_metadata(d.join("swapped")).is_err());
    assert!(std::fs::symlink_metadata(d.join("pipe")).is_err());
    assert!(std::fs::symlink_metadata(d.join("link.txt")).is_err());
    assert!(std::fs::symlink_metadata(d.join("big.bin")).is_err());
    assert!(!d.join("was_file/unlisted.txt").exists());
    assert!(!d.join("was_file/deep").exists());
}

/// The host tree both pull-path tests walk: two small files and one over
/// the cap, in walk order.
fn host_tree_with_a_big_file(host: &Path) -> Vec<HostFile> {
    std::fs::create_dir_all(host.join("d")).unwrap();
    std::fs::write(host.join("a.txt"), b"a").unwrap();
    std::fs::write(host.join("d/b.txt"), b"bb").unwrap();
    std::fs::File::create(host.join("d/big.bin"))
        .unwrap()
        .set_len(MAX_SYNC_FILE_BYTES + 1)
        .unwrap();
    vec![
        HostFile { rel: "a.txt".into(), size: 1, mtime: None, mode: None },
        HostFile { rel: "d/big.bin".into(), size: MAX_SYNC_FILE_BYTES + 1, mtime: None, mode: None },
        HostFile { rel: "d/b.txt".into(), size: 2, mtime: None, mode: None },
    ]
}

fn big_file_skipped() -> Vec<SkippedFile> {
    vec![SkippedFile { rel: "d/big.bin".into(), size: MAX_SYNC_FILE_BYTES + 1 }]
}

/// Gap 35 follow-up: the rsync fast path pulls the files within the cap
/// and the outcome names the one it left on the host.
#[cfg(unix)]
#[test]
fn a_pull_reports_files_over_the_cap_on_the_rsync_path() {
    if !samba_rsync_3() {
        eprintln!("no rsync >= 3 on PATH; skipping the local transfer check");
        return;
    }
    let host = tempfile::tempdir().unwrap();
    let mirror = tempfile::tempdir().unwrap();
    let files = host_tree_with_a_big_file(host.path());
    let list = rsync_transfer_list(&files);
    assert_eq!(list.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), ["a.txt", "d/b.txt"]);
    let from = rsync_files_from(&rsync_subtree_files(&list, "").unwrap()).unwrap();
    let mut args = rsync_pull_flags(from.path());
    args.push(format!("{}/", host.path().display()));
    args.push(format!("{}/", mirror.path().display()));
    let out = std::process::Command::new("rsync").args(&args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

    let mut outcome = PullOutcome::default();
    for file in &files {
        let landed = rsync_pulled_base(&mirror.path().join(&file.rel), file.size).is_some();
        outcome.tally(file, landed);
    }
    assert_eq!(outcome.pulled, 2);
    assert_eq!(outcome.skipped_too_large, big_file_skipped());
    assert_eq!(std::fs::read(mirror.path().join("a.txt")).unwrap(), b"a");
    assert_eq!(std::fs::read(mirror.path().join("d/b.txt")).unwrap(), b"bb");
    assert!(!mirror.path().join("d/big.bin").exists());
}

/// Gap 35 follow-up: the SFTP floor's per-file rule (`pull_file` minus
/// the wire) never reads a file over the cap, pulls the rest, and the
/// outcome names the skipped one.
#[tokio::test]
async fn a_pull_reports_files_over_the_cap_on_the_sftp_path() {
    let host = tempfile::tempdir().unwrap();
    let mirror = tempfile::tempdir().unwrap();
    let files = host_tree_with_a_big_file(host.path());
    let reads = std::cell::RefCell::new(Vec::new());
    let mut outcome = PullOutcome::default();
    for file in &files {
        let host_abs = host.path().join(&file.rel);
        let landed = pull_file_with(&host_abs.to_string_lossy(), file.size, file.mode, mirror.path(), &file.rel, || {
            reads.borrow_mut().push(file.rel.clone());
            let path = host_abs.clone();
            async move { std::fs::read(path).map_err(|e| e.to_string()) }
        })
        .await
        .is_ok();
        outcome.tally(file, landed);
    }
    assert_eq!(*reads.borrow(), ["a.txt", "d/b.txt"], "a file over the cap is never read");
    assert_eq!(outcome.pulled, 2);
    assert_eq!(outcome.skipped_too_large, big_file_skipped());
    assert_eq!(std::fs::read(mirror.path().join("a.txt")).unwrap(), b"a");
    assert_eq!(std::fs::read(mirror.path().join("d/b.txt")).unwrap(), b"bb");
    assert!(!mirror.path().join("d/big.bin").exists());
}

/// The pull result crosses to the frontend in camelCase, and a payload
/// without the new field still reads (empty list).
#[test]
fn a_pull_outcome_is_camel_case_and_defaults_to_nothing_skipped() {
    let outcome = PullOutcome { pulled: 2, skipped_too_large: big_file_skipped() };
    let json = serde_json::to_value(&outcome).unwrap();
    assert_eq!(json["pulled"], 2);
    assert_eq!(json["skippedTooLarge"][0]["rel"], "d/big.bin");
    assert_eq!(json["skippedTooLarge"][0]["size"], MAX_SYNC_FILE_BYTES + 1);
    let old: PullOutcome = serde_json::from_str(r#"{"pulled":3}"#).unwrap();
    assert_eq!(old, PullOutcome { pulled: 3, skipped_too_large: Vec::new() });
    // A file that failed for another reason is not reported as too large.
    let mut outcome = PullOutcome::default();
    outcome.tally(&HostFile { rel: "gone.txt".into(), size: 5, mtime: None, mode: None }, false);
    assert_eq!(outcome, PullOutcome::default());
}

#[test]
fn rsync_subtree_files_are_exactly_walker_paths_below_scope() {
    let files = vec![
        HostFile {
            rel: "data/one.txt".into(),
            size: 1,
            mtime: None,
            mode: None,
        },
        HostFile {
            rel: "data/nested/two.txt".into(),
            size: 2,
            mtime: None,
            mode: None,
        },
    ];
    assert_eq!(
        rsync_subtree_files(&files, "data"),
        Some(vec!["one.txt".into(), "nested/two.txt".into()])
    );
    assert_eq!(
        rsync_subtree_files(&files, ""),
        Some(vec!["data/one.txt".into(), "data/nested/two.txt".into()])
    );
    assert_eq!(rsync_subtree_files(&files, "other"), None);
}

#[test]
fn rsync_file_list_is_nul_delimited() {
    let list = rsync_files_from(&["plain.txt".into(), "line\nbreak.txt".into()]).unwrap();
    assert_eq!(
        std::fs::read(list.path()).unwrap(),
        b"plain.txt\0line\nbreak.txt\0"
    );
}

#[test]
fn local_pull_replacement_is_complete_and_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("nested/file.txt");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, b"old complete bytes").unwrap();
    replace_local_atomic(&target, b"new complete bytes", None).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"new complete bytes");
}

#[test]
fn mirror_writes_refuse_traversal_names() {
    // #863: a hostile host answers its walk with `../` "names".
    let dir = tempfile::tempdir().unwrap();
    let mirror = dir.path().join("mirror");
    std::fs::create_dir_all(&mirror).unwrap();
    for bad in [
        "../escape.txt",
        "../../.config/autostart/x.desktop",
        "a/../../escape.txt",
        "a/..",
        "",
        "/",
        "nul\0byte",
    ] {
        assert!(confined_mirror_path(&mirror, bad).is_err(), "{bad:?} must be refused");
        assert!(write_mirror_file(&mirror, bad, b"x").is_err(), "{bad:?} must not be written");
    }
    assert!(!dir.path().join("escape.txt").exists());
    // Ordinary project-relative paths (a leading `/` read as relative, `./`
    // tolerated) land inside the mirror.
    assert_eq!(confined_mirror_path(&mirror, "a/b.txt").unwrap(), mirror.join("a/b.txt"));
    assert_eq!(confined_mirror_path(&mirror, "/a/./b.txt").unwrap(), mirror.join("a/b.txt"));
    let written = write_mirror_file(&mirror, "new/dir/f.txt", b"ok").unwrap();
    assert_eq!(written, mirror.join("new/dir/f.txt"));
    assert_eq!(std::fs::read(&written).unwrap(), b"ok");
    // The rsync destination may be the mirror root itself; traversal is refused.
    assert_eq!(confined_mirror_dir(&mirror, "").unwrap(), mirror);
    assert!(confined_mirror_dir(&mirror, "../x").is_err());
}

#[test]
fn mirror_local_path_never_steps_outside_the_mirror() {
    let p = mirror_local_path("pid", "../../../.config/autostart/x.desktop");
    let mirror = mirror_dir("pid");
    assert!(p.starts_with(&mirror), "{} escaped {}", p.display(), mirror.display());
    assert!(!p.components().any(|c| c == Component::ParentDir));
    assert_eq!(mirror_local_path("pid", "a/b.txt"), mirror.join("a/b.txt"));
}

#[cfg(unix)]
#[test]
fn mirror_writes_refuse_a_symlinked_parent_directory() {
    // #863: a fenced agent plants `mirror/d -> <outside>`; a pull of `d/x`
    // must not follow it out of the mirror.
    let dir = tempfile::tempdir().unwrap();
    let mirror = dir.path().join("mirror");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(mirror.join("real")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, mirror.join("d")).unwrap();
    std::os::unix::fs::symlink(&outside, mirror.join("real/deep")).unwrap();
    for bad in ["d/x.desktop", "d/new/x.desktop", "real/deep/x.desktop"] {
        assert!(confined_mirror_path(&mirror, bad).is_err(), "{bad:?} must be refused");
        assert!(write_mirror_file(&mirror, bad, b"x").is_err(), "{bad:?} must not be written");
    }
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0, "nothing landed outside");
    // rsync writes through its destination: a symlinked one is refused too.
    assert!(confined_mirror_dir(&mirror, "d").is_err());
    assert!(confined_mirror_dir(&mirror, "real/deep/sub").is_err());
    assert!(confined_mirror_dir(&mirror, "real").is_ok());
    // A symlink AS the file is replaced by the atomic rename, never written through.
    let victim = outside.join("victim.txt");
    std::fs::write(&victim, b"precious").unwrap();
    std::os::unix::fs::symlink(&victim, mirror.join("real/link.txt")).unwrap();
    write_mirror_file(&mirror, "real/link.txt", b"host bytes").unwrap();
    assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
    assert!(!std::fs::symlink_metadata(mirror.join("real/link.txt"))
        .unwrap()
        .file_type()
        .is_symlink());
    // A symlinked mirror ROOT is the user's choice and stays usable.
    let linked_root = dir.path().join("linked-mirror");
    std::os::unix::fs::symlink(mirror.join("real"), &linked_root).unwrap();
    assert!(write_mirror_file(&linked_root, "ok.txt", b"x").is_ok());
}

#[test]
fn join_remote_handles_root_and_rel() {
    assert_eq!(join_remote("/srv/p", ""), "/srv/p");
    assert_eq!(join_remote("/srv/p/", "a/b"), "/srv/p/a/b");
    assert_eq!(join_remote("/srv/p", "/a"), "/srv/p/a");
    assert_eq!(join_remote("", "a"), "/a");
    assert_eq!(join_remote("", ""), "/");
}

#[test]
fn join_rel_appends_segments() {
    assert_eq!(join_rel("", "a"), "a");
    assert_eq!(join_rel("a", "b"), "a/b");
    assert_eq!(join_rel("a/b/", "c"), "a/b/c");
}

#[test]
fn local_new_candidates_filters_manifest_tracked_and_excluded() {
    let mut m = Manifest::new();
    m.insert(
        "synced.txt".into(),
        SyncEntry {
            selected: true,
            ..Default::default()
        },
    );
    m.insert("data".into(), excluded_dir());
    let all = vec![
        "synced.txt".to_string(),          // manifest'd → has a row already
        "src/lib.rs".to_string(),          // tracked → lockstep's when enabled
        "data/cache.bin".to_string(),      // under an excluded folder marker
        "configs/new_v10.yml".to_string(), // genuinely new
        "".to_string(),                    // defensive: never a file
    ];
    let tracked: HashSet<String> = ["src/lib.rs".to_string()].into_iter().collect();

    // Lockstep on: the tracked file belongs to lockstep (#28p D1), not here.
    let with_lockstep = local_new_candidates(&m, all.clone(), &tracked, true, 100);
    assert_eq!(with_lockstep, vec!["configs/new_v10.yml".to_string()]);

    // Lockstep off: byte-sync owns the tracked tree too, so a tracked file
    // the manifest never saw IS new and reportable.
    let without = local_new_candidates(&m, all, &tracked, false, 100);
    assert_eq!(
        without,
        vec!["configs/new_v10.yml".to_string(), "src/lib.rs".to_string()],
    );
}

#[test]
fn local_new_candidates_sorts_and_caps() {
    let m = Manifest::new();
    let all = vec!["b".to_string(), "c".to_string(), "a".to_string()];
    let none = HashSet::new();
    // Sorted for a stable UI order, then capped — the row list is advisory,
    // not an inventory, so the cap keeps a raw-walk fallback's tens of
    // thousands of candidates from flooding the IPC payload.
    assert_eq!(
        local_new_candidates(&m, all, &none, true, 2),
        vec!["a".to_string(), "b".to_string()],
    );
}

#[test]
fn compute_state_green_when_base_matches() {
    let e = SyncEntry {
        selected: true,
        host_size: 10,
        host_mtime: Some(100),
        local_size: 10,
        local_mtime: Some(50),
        ..Default::default()
    };
    // Both host and local match their recorded bases → green.
    assert_eq!(
        compute_state(&e, Some((10, Some(100))), Some((10, Some(50))), false),
        SyncState::Green,
    );
}

#[test]
fn compute_state_amber_when_host_moved() {
    let e = SyncEntry {
        selected: true,
        host_size: 10,
        host_mtime: Some(100),
        local_size: 10,
        local_mtime: Some(50),
        ..Default::default()
    };
    // Host size changed (local unchanged).
    assert_eq!(
        compute_state(&e, Some((12, Some(100))), Some((10, Some(50))), false),
        SyncState::Amber,
    );
    // Host mtime changed (local unchanged).
    assert_eq!(
        compute_state(&e, Some((10, Some(200))), Some((10, Some(50))), false),
        SyncState::Amber,
    );
    // Same divergence, but the path is excluded from sync → None, not Amber.
    assert_eq!(
        compute_state(&e, Some((12, Some(100))), Some((10, Some(50))), true),
        SyncState::None,
    );
}

#[test]
fn compute_state_amber_when_local_moved() {
    let e = SyncEntry {
        selected: true,
        host_size: 10,
        host_mtime: Some(100),
        local_size: 10,
        local_mtime: Some(50),
        last_pull_ts: Some(1),
        ..Default::default()
    };
    // Host still matches its base, but the local mirror mtime moved → amber.
    assert_eq!(
        compute_state(&e, Some((10, Some(100))), Some((10, Some(80))), false),
        SyncState::Amber,
    );
    // Also amber offline (host not stat'd) when the local size moved.
    assert_eq!(
        compute_state(&e, None, Some((12, Some(50))), false),
        SyncState::Amber
    );
    // Mirror deleted after a prior sync → diverged.
    assert_eq!(
        compute_state(&e, Some((10, Some(100))), None, false),
        SyncState::Amber
    );
}

#[test]
fn compute_state_none_when_unselected() {
    let e = SyncEntry {
        selected: false,
        ..Default::default()
    };
    assert_eq!(
        compute_state(&e, Some((0, None)), None, false),
        SyncState::None
    );
}

#[test]
fn record_pull_marks_selected_and_stamps_bases() {
    let mut m = Manifest::new();
    record_pull(&mut m, "src/main.rs", 42, Some(7), 42, Some(9));
    let e = m.get("src/main.rs").unwrap();
    assert!(e.selected);
    assert_eq!(e.host_size, 42);
    assert_eq!(e.host_mtime, Some(7));
    assert_eq!(e.local_size, 42);
    assert_eq!(e.local_mtime, Some(9));
    assert!(e.last_pull_ts.is_some());
}

#[test]
fn mirror_path_joins_under_mirror() {
    let p = mirror_local_path("pid", "a/b.txt");
    assert!(p.ends_with("remote-projects/pid/mirror/a/b.txt"));
}

#[test]
fn divergence_splits_the_two_sides() {
    let e = SyncEntry {
        selected: true,
        host_size: 10,
        host_mtime: Some(100),
        local_size: 10,
        local_mtime: Some(50),
        last_pull_ts: Some(1),
        ..Default::default()
    };
    // Neither side moved → (false, false).
    assert_eq!(
        divergence(&e, Some((10, Some(100))), Some((10, Some(50)))),
        (false, false)
    );
    // Host moved only → (true, false): the auto engine pulls.
    assert_eq!(
        divergence(&e, Some((12, Some(100))), Some((10, Some(50)))),
        (true, false)
    );
    // Local moved only → (false, true): the auto engine pushes.
    assert_eq!(
        divergence(&e, Some((10, Some(100))), Some((10, Some(80)))),
        (false, true)
    );
    // Both moved → (true, true): amber, skipped by the auto engine.
    assert_eq!(
        divergence(&e, Some((12, Some(100))), Some((10, Some(80)))),
        (true, true)
    );
    // Host not stat'd (cold) → host side never flagged.
    assert_eq!(divergence(&e, None, Some((10, Some(50)))), (false, false));
}

#[test]
fn both_gone_after_sync_is_pruned() {
    let synced = SyncEntry {
        selected: true,
        host_size: 10,
        host_mtime: Some(100),
        local_size: 10,
        local_mtime: Some(50),
        last_pull_ts: Some(1),
        ..Default::default()
    };
    let gone: Result<Option<(u64, Option<u64>)>, String> = Ok(None);
    let present: Result<Option<(u64, Option<u64>)>, String> = Ok(Some((10, Some(100))));
    let err: Result<Option<(u64, Option<u64>)>, String> = Err("session dropped".into());
    // Positively gone on BOTH sides after a sync → nothing left to compare
    // → prune.
    assert!(should_prune(&synced, &gone, &gone));
    // Host still present → a real one-side deletion, never pruned.
    assert!(!should_prune(&synced, &present, &gone));
    // Local still present → same, the conflict machinery owns it.
    assert!(!should_prune(&synced, &gone, &present));
    // Never synced → a bare marker, nothing to forget.
    let never = SyncEntry {
        selected: true,
        ..Default::default()
    };
    assert!(!should_prune(&never, &gone, &gone));
    // A stat ERROR is "could not check", NEVER "gone": a dropped session
    // mid-refresh must not read as every file deleted (mass-prune hazard).
    assert!(!should_prune(&synced, &err, &gone));
    assert!(!should_prune(&synced, &gone, &err));
    assert!(!should_prune(&synced, &err, &err));
}

#[test]
fn content_verify_gate() {
    let cutoff = 1024;
    // Same size, both present, within cutoff → worth reading to disprove amber.
    assert!(content_verify_worth_it(
        (10, Some(100)),
        (10, Some(50)),
        cutoff
    ));
    // Different sizes can't be byte-identical → never read.
    assert!(!content_verify_worth_it(
        (10, Some(100)),
        (12, Some(50)),
        cutoff
    ));
    // A missing side (no mtime) is a real divergence → don't downgrade, don't read.
    assert!(!content_verify_worth_it((10, None), (10, Some(50)), cutoff));
    assert!(!content_verify_worth_it(
        (10, Some(100)),
        (10, None),
        cutoff
    ));
    // Above the cutoff → large files keep the pure metadata heuristic.
    assert!(!content_verify_worth_it(
        (2048, Some(100)),
        (2048, Some(50)),
        cutoff
    ));
    // Exactly at the cutoff is still verified (boundary is inclusive).
    assert!(content_verify_worth_it(
        (1024, Some(100)),
        (1024, Some(50)),
        cutoff
    ));
    // Two empty files (size 0, both present) → trivially worth it (and equal).
    assert!(content_verify_worth_it(
        (0, Some(100)),
        (0, Some(50)),
        cutoff
    ));
}

#[test]
fn is_auto_follows_own_entry_and_ancestor_folder_markers() {
    let mut m = Manifest::new();
    // A file with its own auto flag.
    m.insert(
        "solo.txt".to_string(),
        SyncEntry {
            selected: true,
            auto_sync: true,
            ..Default::default()
        },
    );
    // An auto folder marker; its descendants inherit auto even with no entry.
    m.insert(
        "src".to_string(),
        SyncEntry {
            selected: true,
            is_dir: true,
            auto_sync: true,
            ..Default::default()
        },
    );
    // A NON-auto folder marker; its descendants are not auto.
    m.insert(
        "vendor".to_string(),
        SyncEntry {
            selected: true,
            is_dir: true,
            ..Default::default()
        },
    );

    assert!(is_auto(&m, "solo.txt"));
    assert!(is_auto(&m, "src/main.rs")); // inherits from src/
    assert!(is_auto(&m, "src/a/b/deep.rs")); // any depth under an auto folder
    assert!(!is_auto(&m, "vendor/lib.rs")); // ancestor folder not auto
    assert!(!is_auto(&m, "other.txt")); // no entry, no auto ancestor

    // A plain FILE entry named like a dir must not act as a folder marker.
    m.insert(
        "notadir".to_string(),
        SyncEntry {
            selected: true,
            auto_sync: true,
            is_dir: false,
            ..Default::default()
        },
    );
    assert!(!is_auto(&m, "notadir/child.rs"));
}

#[test]
fn is_auto_project_wide_root_marker_and_exclusions() {
    let mut m = Manifest::new();
    // Project-wide "auto-sync all": the root "" directory marker.
    m.insert(
        "".to_string(),
        SyncEntry {
            selected: true,
            is_dir: true,
            auto_sync: true,
            ..Default::default()
        },
    );
    // Everything is auto under the project-wide marker, at any depth and for
    // top-level files (which `rfind('/')` never resolves to the root).
    assert!(is_auto(&m, "README.md"));
    assert!(is_auto(&m, "src/main.rs"));
    assert!(is_auto(&m, "a/b/c/deep.rs"));

    // A local OFF override carves a subtree out of the project-wide auto.
    m.insert(
        "vendor".to_string(),
        SyncEntry {
            selected: true,
            is_dir: true,
            auto_off: true,
            ..Default::default()
        },
    );
    assert!(!is_auto(&m, "vendor/lib.rs"));
    assert!(!is_auto(&m, "vendor")); // the folder itself
    assert!(is_auto(&m, "src/main.rs")); // siblings unaffected

    // A single excluded file under an otherwise-auto tree.
    m.insert(
        "src/secret.rs".to_string(),
        SyncEntry {
            selected: true,
            auto_off: true,
            ..Default::default()
        },
    );
    assert!(!is_auto(&m, "src/secret.rs"));
    assert!(is_auto(&m, "src/other.rs"));

    // A local ON override wins over an ancestor exclusion (nearest marker).
    m.insert(
        "vendor/keep".to_string(),
        SyncEntry {
            selected: true,
            is_dir: true,
            auto_sync: true,
            ..Default::default()
        },
    );
    assert!(is_auto(&m, "vendor/keep/x.rs"));
    assert!(!is_auto(&m, "vendor/other/y.rs")); // still excluded

    // Project-wide OFF (root auto_off): nothing auto except explicit ON paths.
    m.insert(
        "".to_string(),
        SyncEntry {
            selected: true,
            is_dir: true,
            auto_off: true,
            ..Default::default()
        },
    );
    assert!(!is_auto(&m, "README.md"));
    assert!(is_auto(&m, "vendor/keep/x.rs")); // explicit ON still wins
}

/// Why `commands::projects::clear_host_bound_state` must exist.
///
/// A manifest entry is a claim about **one specific host**. Point the project at a
/// different one — detach, then extend to a corrected path, which is the normal way to
/// fix a wrong `remote_path` — and every base in it becomes a lie. The state dir is
/// keyed by project *id*, which detach preserves, so without an explicit purge the new
/// pairing inherits the old host's manifest wholesale.
///
/// The two pure functions below then disagree about the same file in the worst
/// possible way, and this test pins both halves so the purge can never be quietly
/// dropped:
///   * `push_decision` sees `ever_synced` + a missing host file and calls it `Stale` —
///     a deletion to be resolved, not a file to send. So it **refuses to push**.
///   * `divergence` maps the same failed host stat to "couldn't check → don't flag",
///     so with the mirror untouched the file reads `(false, false)` — **green**.
///
/// A file the tree reports as fully in sync, on a host that has never had it, which
/// byte-sync will never send. It would look like the sync simply worked.
#[test]
fn a_stale_manifest_against_a_fresh_host_is_a_false_green() {
    // Synced against the OLD host, and untouched locally since.
    let stale = SyncEntry {
        selected: true,
        auto_sync: true,
        host_size: 10,
        host_mtime: Some(100),
        local_size: 10,
        local_mtime: Some(100),
        last_pull_ts: Some(1),
        ..Default::default()
    };
    let local_unchanged = Some((10u64, Some(100u64)));

    // The new host has never heard of this file.
    assert_eq!(
        push_decision(&stale, None),
        PushDecision::Stale,
        "refuses to push: it reads the absence as a host-side DELETION, not a new host"
    );
    assert_eq!(
        divergence(&stale, None, local_unchanged),
        (false, false),
        "…and paints it green while doing so"
    );

    // Cleared (as a fresh pairing must be), the very same file behaves correctly: it
    // is simply a local file the host lacks, so it gets created there.
    let fresh = SyncEntry {
        selected: true,
        auto_sync: true,
        ..Default::default()
    };
    assert_eq!(push_decision(&fresh, None), PushDecision::Safe);
    assert_eq!(
        divergence(&fresh, None, local_unchanged),
        (false, true),
        "local-only change → push, which is exactly the seed a new host needs"
    );
}
#[cfg(unix)]
mod mirror_reads {
    use super::*;
    use crate::services::home_io::{mkfifo, within_deadline};

    fn mirror() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("d")).unwrap();
        std::fs::write(dir.path().join("d").join("f.txt"), b"hello").unwrap();
        dir
    }

    fn read(root: &Path, rel: &str) -> MirrorRead {
        let (root, rel) = (root.to_path_buf(), rel.to_string());
        within_deadline(move || read_mirror_file(&root, &rel)).expect("a read, not an error")
    }

    fn skip_kind(r: MirrorRead) -> MirrorSkipKind {
        match r {
            MirrorRead::Skip(kind, _) => kind,
            other => panic!("expected a skip, got {other:?}"),
        }
    }

    #[test]
    fn a_regular_file_is_read_with_the_handles_bases() {
        let dir = mirror();
        match read(dir.path(), "d/f.txt") {
            MirrorRead::File { bytes, meta } => {
                assert_eq!(bytes, b"hello");
                assert_eq!(meta.0, 5);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(read(dir.path(), "d/none.txt"), MirrorRead::Missing));
        assert!(matches!(read(dir.path(), "nodir/none.txt"), MirrorRead::Missing));
    }

    #[test]
    fn a_link_at_the_file_is_never_read() {
        let dir = mirror();
        let secret = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(secret.path(), b"ssh key").unwrap();
        std::os::unix::fs::symlink(secret.path(), dir.path().join("d").join("l.txt")).unwrap();
        assert_eq!(skip_kind(read(dir.path(), "d/l.txt")), MirrorSkipKind::Link);
        assert!(matches!(mirror_lstat(dir.path(), "d/l.txt"), Ok(MirrorStat::Skip(MirrorSkipKind::Link))));
    }

    #[test]
    fn a_linked_folder_on_the_way_is_never_read_through() {
        let dir = mirror();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("f.txt"), b"outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("lnk")).unwrap();
        assert_eq!(skip_kind(read(dir.path(), "lnk/f.txt")), MirrorSkipKind::Link);
        assert!(matches!(mirror_lstat(dir.path(), "lnk/f.txt"), Ok(MirrorStat::Skip(MirrorSkipKind::Link))));
        // A dangling link is still a link, never "gone".
        std::os::unix::fs::symlink(dir.path().join("nowhere"), dir.path().join("dangling")).unwrap();
        assert_eq!(skip_kind(read(dir.path(), "dangling")), MirrorSkipKind::Link);
        assert!(matches!(mirror_lstat(dir.path(), "dangling"), Ok(MirrorStat::Skip(MirrorSkipKind::Link))));
    }

    #[test]
    fn a_fifo_is_skipped_without_blocking() {
        let dir = mirror();
        mkfifo(&dir.path().join("d").join("pipe"));
        assert_eq!(skip_kind(read(dir.path(), "d/pipe")), MirrorSkipKind::Special);
        assert!(matches!(mirror_lstat(dir.path(), "d/pipe"), Ok(MirrorStat::Skip(MirrorSkipKind::Special))));
    }

    #[test]
    fn a_file_over_the_cap_is_skipped_from_the_handle() {
        let dir = mirror();
        let big = std::fs::File::create(dir.path().join("big.bin")).unwrap();
        big.set_len(MAX_SYNC_FILE_BYTES + 1).unwrap();
        match read(dir.path(), "big.bin") {
            MirrorRead::Skip(MirrorSkipKind::TooLarge, Some(size)) => assert_eq!(size, MAX_SYNC_FILE_BYTES + 1),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_swap_between_the_walk_and_the_read_reads_nothing() {
        let root = mirror();
        let secret = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(secret.path(), b"host login").unwrap();
        // The walk's view: a regular file in a regular folder.
        let mut listed = Vec::new();
        walk_mirror_inner(root.path(), root.path(), &mut listed).unwrap();
        assert_eq!(listed, vec!["d/f.txt".to_string()]);
        // The leaf is swapped for a link to a file the agent cannot see.
        std::fs::remove_file(root.path().join("d").join("f.txt")).unwrap();
        std::os::unix::fs::symlink(secret.path(), root.path().join("d").join("f.txt")).unwrap();
        assert_eq!(skip_kind(read(root.path(), &listed[0])), MirrorSkipKind::Link);
        // Then the folder is swapped for a link to a folder holding the same name.
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("f.txt"), b"host login").unwrap();
        std::fs::remove_file(root.path().join("d").join("f.txt")).unwrap();
        std::fs::remove_dir(root.path().join("d")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("d")).unwrap();
        assert_eq!(skip_kind(read(root.path(), &listed[0])), MirrorSkipKind::Link);
        // And the leaf becomes a FIFO.
        std::fs::remove_file(root.path().join("d")).unwrap();
        std::fs::create_dir(root.path().join("d")).unwrap();
        mkfifo(&root.path().join("d").join("f.txt"));
        assert_eq!(skip_kind(read(root.path(), &listed[0])), MirrorSkipKind::Special);
    }

    #[test]
    fn skips_are_kept_per_project_and_cleared_when_the_file_is_ordinary_again() {
        let id = format!("skip-notice-{}", std::process::id());
        let skip = |rel: &str| MirrorSkip { rel: rel.into(), kind: MirrorSkipKind::Link, size: None };
        assert!(note_mirror_skip(&id, skip("a")));
        assert!(!note_mirror_skip(&id, skip("a")), "the same notice is not a change");
        assert!(note_mirror_skip(&id, skip("b")));
        assert_eq!(mirror_skips(&id).total, 2);
        assert!(clear_mirror_skip(&id, "a"));
        assert!(!clear_mirror_skip(&id, "a"));
        assert_eq!(mirror_skips(&id).items, vec![skip("b")]);
        assert!(clear_mirror_skip(&id, "b"));
        assert_eq!(mirror_skips(&id), MirrorSkips::default());
    }
}
