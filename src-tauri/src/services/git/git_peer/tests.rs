use crate::brand::SLUG;
use super::*;
use crate::test_util::git_output;

/// Returns true when `git` is on PATH; probe tests skip gracefully otherwise.
fn git_available() -> bool {
    crate::paths::command_no_window("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[test]
fn a_failed_repo_check_reads_empty_only_on_an_explicit_no() {
    let remote = |exit| failed_repo_check_is_probe_error(true, true, exit, || false);
    let local = |exit| failed_repo_check_is_probe_error(false, true, exit, || false);
    // Explicit answers: git's not-a-repo over a folder with no `.git`, or (remote)
    // the `cd` that failed.
    assert!(!remote(Some(Some(128))));
    assert!(!remote(Some(Some(1))), "bash: cd failed");
    assert!(!remote(Some(Some(2))), "dash: cd failed");
    assert!(!local(Some(Some(128))));
    // ssh's own failure is never an empty host (#10).
    assert!(remote(Some(Some(255))));
    assert!(local(Some(Some(255))));
    // Nor is anything else: no git (127), a signal, a spawn failure.
    for exit in [Some(Some(127)), Some(Some(3)), Some(None), None] {
        assert!(remote(exit), "{exit:?}");
        assert!(local(exit), "{exit:?}");
    }
    // Locally there is no `cd`: 1/2 are not an answer.
    assert!(local(Some(Some(1))));
    // A missing local dir has no repo to destroy, whatever happened.
    assert!(!failed_repo_check_is_probe_error(false, false, None, || true));
    assert!(!failed_repo_check_is_probe_error(false, false, Some(Some(255)), || true));
    // A 128 over a `.git` is a repo git refused (another owner's, a damaged one) —
    // never empty, on either side.
    assert!(failed_repo_check_is_probe_error(true, true, Some(Some(128)), || true));
    assert!(failed_repo_check_is_probe_error(false, true, Some(Some(128)), || true));
    // The `.git` check runs only for a 128 (the other answers need no round trip).
    failed_repo_check_is_probe_error(true, true, Some(Some(255)), || panic!("asked"));
    failed_repo_check_is_probe_error(true, true, Some(Some(1)), || panic!("asked"));
}

/// git exits 128 for a repo it refuses — `safe.directory`'s "dubious ownership",
/// or a damaged `.git` — exactly as for "no repo here". Read as empty, pairing would
/// `git init` + `reset --hard` over a real repo. Driven through the real
/// [`PROBE_SCRIPT`] (git's own `GIT_TEST_ASSUME_DIFFERENT_OWNER` stands in for a
/// foreign owner) and the per-command probe.
#[cfg(unix)]
#[test]
fn a_repo_git_refuses_is_a_probe_error_not_an_empty_side() {
    if !git_available() {
        eprintln!("git not on PATH — skipping a_repo_git_refuses_is_a_probe_error_not_an_empty_side");
        return;
    }
    // The ownership check still passes a repo any protected config lists in
    // `safe.directory` (CI runners carry `*`), so the probe reads no ambient config.
    let refused = |dir: &Path| -> String {
        run_sh(
            dir,
            &format!(
                "GIT_TEST_ASSUME_DIFFERENT_OWNER=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null; \
                     export GIT_TEST_ASSUME_DIFFERENT_OWNER GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL; \
                     unset GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT; {PROBE_SCRIPT}"
            ),
        )
    };
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&repo).status().unwrap().success());
    // The same refusal over a folder with no `.git` is an honest "no repo here".
    let plain = tmp.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let snap = parse_probe_block(&refused(&plain)).expect("parses");
    assert!(!snap.is_repo && !snap.probe_error, "a plain folder is empty");

    let out = refused(&repo);
    let snap = parse_probe_block(&out).expect("parses");
    assert!(snap.probe_error, "a refused repo must not read as empty: {out:?}");
    assert!(matches!(classify_batched_probe(Some(0), &out), BatchedProbe::Answer(s) if s.probe_error));

    // A damaged `.git` (git cannot read it, exit 128): the batched and the
    // per-command probe both refuse to call it empty.
    let damaged = tmp.path().join("damaged");
    std::fs::create_dir_all(damaged.join(".git")).unwrap();
    assert!(parse_probe_block(&run_sh(&damaged, PROBE_SCRIPT)).expect("parses").probe_error);
    let snap = probe(&Peer::Local(damaged.clone()));
    assert!(snap.probe_error && !snap.is_repo, "{snap:?}");
    // A dangling `.git` link counts as an entry too; a plain folder stays empty.
    let linked = tmp.path().join("linked");
    std::fs::create_dir_all(&linked).unwrap();
    std::os::unix::fs::symlink(tmp.path().join("gone"), linked.join(".git")).unwrap();
    assert!(git_entry_present(&Peer::Local(linked.clone())));
    assert!(!git_entry_present(&Peer::Local(plain.clone())));
    assert!(!probe(&Peer::Local(plain.clone())).probe_error);

    // The remote `.git` check, run by a real shell: exit 0 only with no entry.
    let no_entry = |dir: &Path| {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(no_git_entry_command(dir.to_str().unwrap()))
            .status()
            .unwrap()
            .success()
    };
    assert!(no_entry(&plain));
    assert!(!no_entry(&repo));
    assert!(!no_entry(&damaged));
    assert!(!no_entry(&linked));
    assert!(!no_entry(&tmp.path().join("missing")), "a failed cd is never \"no entry\"");

    // F-e(3): a folder *inside* a repo git refuses gets the same 128 from git's
    // upward search, with no `.git` of its own — still never empty. The walk is
    // over the physical path, so a link into such a repo is caught too.
    let sub = repo.join("sub").join("deeper");
    std::fs::create_dir_all(&sub).unwrap();
    let out = refused(&sub);
    let snap = parse_probe_block(&out).expect("parses");
    assert!(snap.probe_error && !snap.is_repo, "inside a refused repo: {out:?}");
    assert!(git_entry_present(&Peer::Local(sub.clone())));
    assert!(!no_entry(&sub));
    let alias = tmp.path().join("alias");
    std::os::unix::fs::symlink(&sub, &alias).unwrap();
    assert!(parse_probe_block(&refused(&alias)).expect("parses").probe_error);
    assert!(git_entry_present(&Peer::Local(alias.clone())));
    assert!(!no_entry(&alias));
    // Inside a damaged `.git`'s folder: git walks past the unreadable dir and
    // answers 128 — both probes refuse to call it empty.
    let damaged_sub = damaged.join("sub");
    std::fs::create_dir_all(&damaged_sub).unwrap();
    assert!(parse_probe_block(&run_sh(&damaged_sub, PROBE_SCRIPT)).expect("parses").probe_error);
    let snap = probe(&Peer::Local(damaged_sub.clone()));
    assert!(snap.probe_error && !snap.is_repo, "{snap:?}");
    assert!(!no_entry(&damaged_sub));
    // A folder below a plain one stays an honest empty side, in every probe.
    let plain_sub = plain.join("sub");
    std::fs::create_dir_all(&plain_sub).unwrap();
    let snap = parse_probe_block(&refused(&plain_sub)).expect("parses");
    assert!(!snap.is_repo && !snap.probe_error, "below a plain folder is empty");
    assert!(!git_entry_present(&Peer::Local(plain_sub.clone())));
    assert!(!probe(&Peer::Local(plain_sub.clone())).probe_error);
    assert!(no_entry(&plain_sub));
}

/// #10: a transfer never runs against a side whose probe failed — its empty branch
/// list would turn every source ref into an unchecked `update-ref` over the dest.
#[test]
fn a_transfer_against_an_unread_side_is_refused() {
    let seen = PeerSnapshot {
        is_repo: true,
        ..Default::default()
    };
    let unread = probe_error_snapshot();
    assert!(unread_transfer_side(true, &seen, &seen).is_ok());
    assert!(unread_transfer_side(true, &seen, &PeerSnapshot::default()).is_ok(), "an empty dest is a pairing dest");
    let dest = unread_transfer_side(true, &seen, &unread).unwrap_err();
    assert!(dest.contains("remote host"), "{dest}");
    let source = unread_transfer_side(false, &unread, &seen).unwrap_err();
    assert!(source.contains("remote host"), "{source}");
    assert!(unread_transfer_side(false, &seen, &unread).unwrap_err().contains("local mirror"));
}

/// The guard sits in front of every git and ssh call: an unread side fails the
/// transfer before anything is bundled, fetched or `update-ref`ed.
#[tokio::test]
async fn transfer_and_apply_refuses_an_unread_side_before_any_git() {
    let spec: RemoteSpec =
        serde_json::from_value(serde_json::json!({"host": "unread.invalid", "remote_path": "/srv/p"})).unwrap();
    let pool = crate::services::remote::new_pool();
    let manifest = SyncManifestState::default();
    let seen = PeerSnapshot {
        is_repo: true,
        branches: parse_refs("aaaa main\n"),
        ..Default::default()
    };
    let unread = probe_error_snapshot();
    for (source, dest) in [(&seen, &unread), (&unread, &seen)] {
        let got = transfer_and_apply(&pool, &manifest, "unread-transfer-test", &spec, true, source, dest, true).await;
        assert!(got.is_err_and(|e| e.contains("could not be read")));
    }
}

#[test]
fn the_batched_probe_trusts_only_a_clean_exit() {
    let block = "repo\u{1e}main\n\u{1e}abc\n\u{1e}abc main\n\u{1e}\u{1e}\u{1e}";
    assert!(matches!(classify_batched_probe(Some(0), block), BatchedProbe::Answer(s) if s.is_repo));
    assert!(matches!(classify_batched_probe(Some(0), "norepo"), BatchedProbe::Answer(s) if !s.is_repo && !s.probe_error));
    assert!(matches!(classify_batched_probe(Some(0), "garbage"), BatchedProbe::Fallback));
    // ssh exit 255: an error outright — even with parseable (maybe truncated)
    // output, and never re-dialled into an "empty" reading.
    for out in ["", "garbage", "norepo", block] {
        assert!(matches!(classify_batched_probe(Some(255), out), BatchedProbe::Error), "{out:?}");
        assert!(matches!(classify_batched_probe(None, out), BatchedProbe::Error), "{out:?}");
    }
    // A failed `cd` (or a shell that could not run the script): ask per command.
    assert!(matches!(classify_batched_probe(Some(1), ""), BatchedProbe::Fallback));
    assert!(matches!(classify_batched_probe(Some(2), ""), BatchedProbe::Fallback));
}

#[test]
fn probe_missing_local_dir_is_clean_empty_not_error() {
    // A local dir that does not exist is a legitimately-empty side (nothing to
    // destroy) — it must NOT flag `probe_error`, so pairing can still create it.
    let missing = std::path::PathBuf::from(concat!("/definitely/not/a/real/", crate::app_slug!(), "/dir/xyz"));
    let snap = probe(&Peer::Local(missing));
    assert!(!snap.is_repo);
    assert!(!snap.probe_error, "missing dir must read as clean-empty");
}

#[test]
fn probe_existing_non_repo_dir_is_clean_empty() {
    if !git_available() {
        eprintln!("git not on PATH — skipping probe_existing_non_repo_dir_is_clean_empty");
        return;
    }
    // An existing directory that is not a git repo: git runs and cleanly says
    // "no" → is_repo=false, but probe_error=false (safe to initialize).
    let tmp = tempfile::tempdir().expect("tempdir");
    let snap = probe(&Peer::Local(tmp.path().to_path_buf()));
    assert!(!snap.is_repo);
    assert!(
        !snap.probe_error,
        "an existing non-repo dir must be a clean-empty, not a probe error"
    );
}

#[test]
fn parse_refs_reads_sha_and_short_name() {
    let out = "abc123 main\ndef456 feature/x\n\n  \n";
    let refs = parse_refs(out);
    assert_eq!(refs.len(), 2);
    assert_eq!(
        refs[0],
        RefEntry {
            name: "main".into(),
            sha: "abc123".into()
        }
    );
    assert_eq!(refs[1].name, "feature/x");
}

#[test]
fn parse_head_branch_detached_unborn() {
    assert_eq!(
        parse_head("main\n", "abc\n"),
        HeadRef::Branch {
            name: "main".into(),
            sha: "abc".into()
        }
    );
    assert_eq!(
        parse_head("", "abc\n"),
        HeadRef::Detached { sha: "abc".into() }
    );
    assert_eq!(parse_head("", ""), HeadRef::Unborn);
}

#[test]
fn is_dirty_tracked_ignores_untracked() {
    assert!(!is_dirty_tracked("?? newfile.txt\n?? other\n"));
    assert!(is_dirty_tracked(" M tracked.rs\n"));
    assert!(is_dirty_tracked("M  staged.rs\n"));
    assert!(is_dirty_tracked("?? a\n M b\n")); // any tracked line
    assert!(!is_dirty_tracked(""));
}

#[test]
fn decide_truth_table() {
    assert_eq!(decide(None, "a", false, false), RefAction::CreateOnDest);
    assert_eq!(decide(Some("a"), "a", false, false), RefAction::InSync);
    assert_eq!(
        decide(Some("old"), "new", true, false),
        RefAction::FastForwardDest
    );
    assert_eq!(
        decide(Some("new"), "old", false, true),
        RefAction::DestAhead
    );
    assert_eq!(decide(Some("x"), "y", false, false), RefAction::Diverged);
}

#[test]
fn bundle_create_args_shape_never_all() {
    let excl = vec!["r1".to_string(), "r2".to_string()];
    let args = bundle_create_args("/tmp/b.bundle", &["--branches", "--tags"], &excl);
    assert_eq!(&args[..3], &["bundle", "create", "/tmp/b.bundle"]);
    assert!(args.iter().any(|a| a == "--branches"));
    assert!(args.iter().any(|a| a == "--tags"));
    assert!(args.iter().any(|a| a == "--not"));
    assert!(
        args.iter().position(|a| a == "--not").unwrap()
            < args.iter().position(|a| a == "r1").unwrap()
    );
    // Guardrail: never `--all` (could pull odd refs), and no config/hook words.
    assert!(!args.iter().any(|a| a == "--all"));
    assert!(!args
        .iter()
        .any(|a| a.contains("config") || a.contains("hooks") || a.contains("remotes")));
}

#[test]
fn bundle_create_args_full_when_no_excludes() {
    let args = bundle_create_args("/tmp/b", &["--branches", "--tags"], &[]);
    assert!(!args.iter().any(|a| a == "--not"));
}

// ── #28p D11: distinguish an empty-bundle no-op from a real failure ──────

#[test]
fn empty_bundle_error_is_recognized_precisely() {
    // Git's own literal refusal text (verified against a real `git bundle create`).
    assert!(is_empty_bundle_error(
        "fatal: Refusing to create empty bundle.\n"
    ));
    // A genuine I/O failure must NOT be mistaken for the no-op case — that is
    // exactly the false-green D11 exists to close.
    assert!(!is_empty_bundle_error(
        "fatal: could not write bundle: No space left on device\n"
    ));
    assert!(!is_empty_bundle_error("fatal: bad revision 'HEAD'\n"));
    assert!(!is_empty_bundle_error(""));
}

#[test]
fn bundle_create_fails_empty_with_gits_exact_message() {
    // Pins the literal string `is_empty_bundle_error` matches against a real git,
    // so a future git release changing this wording fails loudly here rather than
    // silently making every genuine failure look like the safe no-op case.
    if !git_available() {
        eprintln!(
            "git not on PATH — skipping bundle_create_fails_empty_with_gits_exact_message"
        );
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let peer = Peer::Local(dir.to_path_buf());
    peer.run(&["init", "-q", "."]).expect("git init");
    peer.run(&["config", "user.email", "t@e"])
        .expect("git config");
    peer.run(&["config", "user.name", "t"]).expect("git config");
    std::fs::write(dir.join("a.txt"), b"x").unwrap();
    peer.run(&["add", "a.txt"]).expect("git add");
    peer.run(&["commit", "-qm", "init"]).expect("git commit");
    let head =
        String::from_utf8_lossy(&peer.run(&["rev-parse", "HEAD"]).expect("rev-parse").stdout)
            .trim()
            .to_string();

    let bundle_path = dir.join("out.bundle").to_string_lossy().to_string();
    let args = bundle_create_args(&bundle_path, &["--branches"], &[head]);
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = peer.run(&argv).expect("bundle create");
    assert!(!out.status.success());
    assert!(
        is_empty_bundle_error(&String::from_utf8_lossy(&out.stderr)),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn incoming_refspecs_are_namespaced() {
    let specs = incoming_fetch_refspecs();
    assert!(specs[0].ends_with(concat!(":refs/", crate::app_slug!(), "/incoming/heads/*")));
    assert!(specs[1].ends_with(concat!(":refs/", crate::app_slug!(), "/incoming/tags/*")));
    // Never target real refs/heads or refs/remotes on the receiver.
    assert!(specs.iter().all(|s| {
        let dst = s.split(':').nth(1).unwrap();
        dst.starts_with(concat!("refs/", crate::app_slug!(), "/incoming/")) && !dst.contains("refs/remotes")
    }));
    assert!(specs.iter().all(|s| s.starts_with('+')), "{specs:?}");
}

#[test]
fn changed_tracked_paths_handles_deletions_and_renames() {
    let ns = "M\tsrc/a.rs\nD\tsrc/gone.rs\nR100\told/name.rs\tnew/name.rs\nA\tadded.rs\n";
    let ch = changed_tracked_paths(ns);
    assert_eq!(ch.len(), 4);
    assert_eq!(
        ch[0],
        TrackedChange {
            path: "src/a.rs".into(),
            deleted: false
        }
    );
    assert_eq!(
        ch[1],
        TrackedChange {
            path: "src/gone.rs".into(),
            deleted: true
        }
    );
    assert_eq!(
        ch[2],
        TrackedChange {
            path: "new/name.rs".into(),
            deleted: false
        }
    );
    assert!(!ch[3].deleted);
}

#[test]
fn backup_ref_name_format() {
    assert_eq!(
        backup_ref_name("feature/x", 1735689600),
        concat!("refs/", crate::app_slug!(), "/backup/1735689600/feature/x")
    );
    // Tag conflicts back up under a `tags/` prefix so a branch and a same-named tag
    // never collide in the safety-ref namespace.
    assert_eq!(
        backup_ref_name("tags/v1", 1735689600),
        concat!("refs/", crate::app_slug!(), "/backup/1735689600/tags/v1")
    );
}

#[test]
fn only_a_ref_write_is_blocked_by_a_linked_worktree() {
    // A plain reconcile never writes a dest-ahead or diverged branch, so a linked
    // worktree holding one is not "left alone" — there was nothing to do. It used
    // to report a block (red pill) for every worktree that was merely ahead.
    assert!(!would_move_ref(RefAction::InSync, false));
    assert!(!would_move_ref(RefAction::DestAhead, false));
    assert!(!would_move_ref(RefAction::Diverged, false));
    // The writes: a create, a fast-forward, and anything a forced resolve resets.
    assert!(would_move_ref(RefAction::CreateOnDest, false));
    assert!(would_move_ref(RefAction::FastForwardDest, false));
    assert!(would_move_ref(RefAction::DestAhead, true));
    assert!(would_move_ref(RefAction::Diverged, true));
    assert!(!would_move_ref(RefAction::InSync, true));
}

#[test]
fn a_commit_is_not_a_checkout() {
    let on = |name: &str, sha: &str| {
        Some(HeadRef::Branch {
            name: name.into(),
            sha: sha.into(),
        })
    };
    let detached = |sha: &str| Some(HeadRef::Detached { sha: sha.into() });
    // Same branch, newer sha: a commit. `detect_and_sync` must hand this to the
    // fast-forward path, not replay `git checkout main` on the peer — which used
    // to switch the host's branch whenever it sat on a different one.
    assert!(!head_target_moved(&on("main", "a"), &on("main", "b")));
    assert!(!head_target_moved(&on("main", "a"), &on("main", "a")));
    // What IS a checkout: another branch, a detach, a re-attach, and — while
    // detached — another commit (the sha is the target there).
    assert!(head_target_moved(&on("main", "a"), &on("feat", "a")));
    assert!(head_target_moved(&on("main", "a"), &detached("a")));
    assert!(head_target_moved(&detached("a"), &on("main", "a")));
    assert!(head_target_moved(&detached("a"), &detached("b")));
    assert!(head_target_moved(&on("main", "a"), &Some(HeadRef::Unborn)));
    // No prior observation → nothing to compare → never a move.
    assert!(!head_target_moved(&None, &on("main", "a")));
}

#[test]
fn a_watcher_burst_that_moved_nothing_is_our_own() {
    let quiet = on_branch("main", "a");
    let sig = refs_signature(&quiet);
    assert!(watcher_burst_is_own(&sig, &refs_signature(&quiet)));
    // A commit, a checkout, a `git add` (dirty bit) and a new branch all change
    // the signature and must wake the loop.
    assert!(!watcher_burst_is_own(&sig, &refs_signature(&on_branch("main", "b"))));
    assert!(!watcher_burst_is_own(&sig, &refs_signature(&on_branch("feat", "a"))));
    let mut dirty = on_branch("main", "a");
    dirty.dirty_tracked = true;
    assert!(!watcher_burst_is_own(&sig, &refs_signature(&dirty)));
    let mut branched = on_branch("main", "a");
    branched.branches.push(RefEntry {
        name: "feat".into(),
        sha: "c".into(),
    });
    assert!(!watcher_burst_is_own(&sig, &refs_signature(&branched)));
}

#[test]
fn winner_is_local_defaults_to_local() {
    assert!(winner_is_local("local"));
    assert!(!winner_is_local("remote"));
    // Anything unexpected keeps the safer "my working copy wins" default.
    assert!(winner_is_local(""));
    assert!(winner_is_local("garbage"));
}

#[test]
fn decide_under_force_targets_diverged_and_dest_ahead() {
    // The resolution force path acts exactly on the two actions that a normal
    // reconcile leaves for the user: a real divergence, and the loser being ahead.
    // (`force_reset_branch` is IO; this pins which classifications route into it.)
    assert_eq!(decide(Some("x"), "y", false, false), RefAction::Diverged);
    assert_eq!(
        decide(Some("new"), "old", false, true),
        RefAction::DestAhead
    );
    // Fast-forwardable / create / in-sync never need forcing (no data loss).
    assert_eq!(
        decide(Some("old"), "new", true, false),
        RefAction::FastForwardDest
    );
    assert_eq!(decide(None, "a", false, false), RefAction::CreateOnDest);
    assert_eq!(decide(Some("a"), "a", false, false), RefAction::InSync);
}

// ── #28p D1/D2: the blocked-fast-forward stderr ──────────────────────────

#[test]
fn parse_untracked_overwrite_paths_reads_gits_list() {
    // Verbatim shape of a real `git merge --ff-only` refusal (captured from git).
    let stderr =
        "error: The following untracked working tree files would be overwritten by merge:\n\
                      \tnew.txt\n\
                      \tsp ace.txt\n\
                      \tsrc/deep/file.rs\n\
                      Please move or remove them before you merge.\n\
                      Aborting\n";
    assert_eq!(
        parse_untracked_overwrite_paths(stderr),
        vec!["new.txt", "sp ace.txt", "src/deep/file.rs"]
    );
}

#[test]
fn parse_untracked_overwrite_paths_unquotes_and_ignores_other_errors() {
    // core.quotePath wraps non-ASCII paths in C-escapes; \303\251 is "é".
    let stderr =
        "error: The following untracked working tree files would be overwritten by merge:\n\
                      \t\"caf\\303\\251.txt\"\n\
                      Please move or remove them before you merge.\n";
    assert_eq!(parse_untracked_overwrite_paths(stderr), vec!["café.txt"]);
    // A genuinely-dirty tree is a different message and yields no paths, so the
    // identical-content retry never fires for it.
    assert!(parse_untracked_overwrite_paths(
        "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.rs\n"
    )
    .is_empty());
    assert!(parse_untracked_overwrite_paths("").is_empty());
}

#[test]
fn blocked_detail_names_the_untracked_files_not_uncommitted_changes() {
    let stderr =
        "error: The following untracked working tree files would be overwritten by merge:\n\
                      \ta.txt\n\tb.txt\n\tc.txt\n\td.txt\n\
                      Please move or remove them before you merge.\n";
    let d = blocked_detail("main", stderr);
    assert!(d.contains("untracked"), "{d}");
    assert!(d.contains("a.txt") && d.contains("c.txt"), "{d}");
    assert!(d.contains("+1 more"), "{d}");
    // The old message claimed uncommitted changes for every blocked ff — the lie D2
    // exists to kill.
    assert!(!d.contains("uncommitted"), "{d}");

    // A blocked ff with no untracked list still says what git said.
    let dirty = blocked_detail("main", "error: Your local changes would be overwritten\n");
    assert!(dirty.contains("local changes"), "{dirty}");
}

#[test]
fn unquote_git_path_passes_plain_paths_through() {
    assert_eq!(unquote_git_path("a/b c.txt"), "a/b c.txt");
    assert_eq!(unquote_git_path("\"a\\tb\""), "a\tb");
    assert_eq!(unquote_git_path("\"q\\\"uote\""), "q\"uote");
}

// ── #28p D1: lockstep owns the tracked tree ──────────────────────────────

#[test]
fn tracked_paths_lists_the_mirrors_tracked_files_only() {
    if !git_available() {
        eprintln!(
            "git not on PATH — skipping tracked_paths_lists_the_mirrors_tracked_files_only"
        );
        return;
    }
    // `tracked_paths` reads the mirror of a project id, so drive it through a repo
    // built at that exact path via the real `mirror_dir` mapping.
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let git = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git")
    };
    git(&["init", "-q", "."]);
    git(&["config", "user.email", "t@e"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(dir.join("tracked.txt"), b"x").unwrap();
    std::fs::write(dir.join("untracked.txt"), b"y").unwrap();
    git(&["add", "tracked.txt"]);
    git(&["commit", "-qm", "x"]);

    let peer = Peer::Local(dir.to_path_buf());
    let out = peer.run(&["ls-files", "-z"]).expect("ls-files");
    let set: HashSet<String> = out
        .stdout
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).replace('\\', "/"))
        .collect();
    assert!(set.contains("tracked.txt"));
    assert!(
        !set.contains("untracked.txt"),
        "byte-sync keeps the untracked files"
    );
    assert!(!set.iter().any(|p| p.starts_with(".git/")));
}

/// Build a repo where `main` is one commit behind `feat`, `feat` adds `new.txt` +
/// `keep.txt`, and `main` is checked out. Returns the repo dir and `feat`'s sha —
/// the exact shape a byte-sync-outran-the-commit collision arrives in.
fn repo_behind_by_one(dir: &Path) -> String {
    let git = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git")
    };
    git(&["init", "-q", "-b", "main", "."]);
    git(&["config", "user.email", "t@e"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(dir.join("base.txt"), b"base\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-qm", "base"]);
    git(&["checkout", "-q", "-b", "feat"]);
    std::fs::write(dir.join("new.txt"), b"incoming content\n").unwrap();
    std::fs::write(dir.join("keep.txt"), b"also incoming\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-qm", "feat"]);
    let sha = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout)
        .trim()
        .to_string();
    git(&["checkout", "-q", "main"]);
    sha
}

/// A worktree file as git *checked it out*, with the line endings its filters
/// applied normalized back out. Git for Windows defaults to `core.autocrlf=true`,
/// so a blob committed with LF lands on disk with CRLF — the assertions below are
/// about *which content* a fast-forward wrote, never about its line endings. The
/// lockstep code itself never compares raw worktree bytes for this reason: it asks
/// git (`hash-object`, which runs the same filters) whether the file already is the
/// blob — see `blob_matches_worktree`.
fn checked_out(path: &Path) -> Vec<u8> {
    let bytes = std::fs::read(path).unwrap();
    let mut out = Vec::with_capacity(bytes.len());
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            continue;
        }
        out.push(b);
    }
    out
}

#[test]
fn deleted_between_names_only_what_a_move_removes() {
    // #28q: the audit's whole job is to name the files a HEAD move deletes from the
    // working tree. `feat` ADDS new.txt/keep.txt on top of `main`, so moving forward
    // deletes nothing — and moving BACK (a checkout of the older commit, a
    // `reset --hard` onto it, a restored backup) deletes both. A warning that fired
    // on the forward move would be crying wolf on every ordinary fast-forward.
    if !git_available() {
        eprintln!("git not on PATH — skipping deleted_between_names_only_what_a_move_removes");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let feat = repo_behind_by_one(dir);
    let peer = Peer::Local(dir.to_path_buf());
    let main =
        String::from_utf8_lossy(&peer.run(&["rev-parse", "HEAD"]).expect("rev-parse").stdout)
            .trim()
            .to_string();

    assert!(
        deleted_between(&peer, &main, &feat).is_empty(),
        "a fast-forward that only adds files must warn about nothing"
    );

    let mut back = deleted_between(&peer, &feat, &main);
    back.sort();
    assert_eq!(back, vec!["keep.txt".to_string(), "new.txt".to_string()]);

    // An unmoved HEAD (the op failed, or was a ref-only update on a branch that is
    // not checked out) is not a deletion of anything.
    assert!(deleted_between(&peer, &feat, &feat).is_empty());
}

/// The blocked `merge --ff-only` and its stderr, against a real git.
fn try_ff(peer: &Peer, sha: &str) -> (bool, String) {
    let o = peer.run(&["merge", "--ff-only", sha]).expect("merge");
    (
        o.status.success(),
        String::from_utf8_lossy(&o.stderr).to_string(),
    )
}

#[test]
fn ff_retry_clears_byte_identical_untracked_files_and_succeeds() {
    if !git_available() {
        eprintln!("git not on PATH — skipping ff_retry_clears_byte_identical_untracked_files");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let sha = repo_behind_by_one(dir);
    let peer = Peer::Local(dir.to_path_buf());

    // The D1 collision: byte-sync already delivered the files the incoming commit
    // carries, so they sit here untracked and byte-identical.
    std::fs::write(dir.join("new.txt"), b"incoming content\n").unwrap();
    std::fs::write(dir.join("keep.txt"), b"also incoming\n").unwrap();

    // Git refuses even though the bytes match — the behaviour the whole fix exists
    // for. (If this ever stops being true, the retry is dead code and should go.)
    let (ok, stderr) = try_ff(&peer, &sha);
    assert!(
        !ok,
        "git is expected to refuse over identical untracked files"
    );
    assert!(!parse_untracked_overwrite_paths(&stderr).is_empty());

    // #28q: the retry reports WHICH files it deleted to get here, so the caller can
    // warn about them — a `git diff` never could, they were never tracked.
    let retry = retry_ff_clearing_identical(&peer, &sha, &stderr, &HashSet::new());
    let FfRetry::Cleared(cleared) = &retry else {
        panic!("identical untracked files must be cleared and the ff retried");
    };
    // Both collisions are named — the warning the caller files must not under-report
    // what it deleted just because the ff put identical bytes straight back.
    let mut named = cleared.clone();
    named.sort();
    assert_eq!(named, vec!["keep.txt".to_string(), "new.txt".to_string()]);
    // The fast-forward landed, and the files are now TRACKED at the incoming content.
    let head = probe(&peer);
    assert_eq!(
        head.head,
        Some(HeadRef::Branch {
            name: "main".into(),
            sha: sha.clone()
        })
    );
    assert_eq!(checked_out(&dir.join("new.txt")), b"incoming content\n");
    assert!(!head.dirty_tracked);
}

#[test]
fn ff_retry_refuses_when_any_colliding_file_differs() {
    if !git_available() {
        eprintln!(
            "git not on PATH — skipping ff_retry_refuses_when_any_colliding_file_differs"
        );
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let sha = repo_behind_by_one(dir);
    let peer = Peer::Local(dir.to_path_buf());

    // One collision is identical; the other holds REAL unsynced work.
    std::fs::write(dir.join("new.txt"), b"incoming content\n").unwrap();
    std::fs::write(dir.join("keep.txt"), b"MY UNSAVED WORK\n").unwrap();

    let (ok, stderr) = try_ff(&peer, &sha);
    assert!(!ok);
    assert!(
        matches!(
            retry_ff_clearing_identical(&peer, &sha, &stderr, &HashSet::new()),
            FfRetry::Refused
        ),
        "one differing file must abort the whole retry"
    );
    // All-or-nothing: nothing was deleted — not even the identical one — and the
    // branch did not move. The user's work is still there to be seen and merged.
    assert_eq!(
        std::fs::read(dir.join("keep.txt")).unwrap(),
        b"MY UNSAVED WORK\n"
    );
    assert_eq!(
        std::fs::read(dir.join("new.txt")).unwrap(),
        b"incoming content\n"
    );
    assert!(matches!(
        probe(&peer).head,
        Some(HeadRef::Branch { ref name, .. }) if name == "main"
    ));
    // And the message the user gets names the real culprit rather than inventing
    // uncommitted changes (D2).
    let detail = blocked_detail("main", &stderr);
    assert!(detail.contains("keep.txt"), "{detail}");
}

#[test]
fn ff_retry_clears_a_differing_file_when_named_as_stale_residue() {
    // Case #12: `keep.txt` differs from the incoming commit, but the caller has
    // already proven (via the sync manifest) that it is byte-sync's own old copy —
    // this is what makes the retry succeed where the plain identical-only check
    // above refuses.
    if !git_available() {
        eprintln!("git not on PATH — skipping ff_retry_clears_a_differing_file_when_named_as_stale_residue");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let sha = repo_behind_by_one(dir);
    let peer = Peer::Local(dir.to_path_buf());

    std::fs::write(dir.join("new.txt"), b"incoming content\n").unwrap();
    std::fs::write(dir.join("keep.txt"), b"stale pre-commit copy\n").unwrap();

    let (ok, stderr) = try_ff(&peer, &sha);
    assert!(!ok);
    let residue: HashSet<String> = ["keep.txt".to_string()].into_iter().collect();
    // Cleared *and named*: `keep.txt`'s old copy is the one thing this retry destroys
    // that the ff does not put back byte-for-byte, which is what the caller warns
    // about (#28q).
    assert!(
        matches!(
            retry_ff_clearing_identical(&peer, &sha, &stderr, &residue),
            FfRetry::Cleared(ref cleared) if cleared.contains(&"keep.txt".to_string())
        ),
        "a file named as proven stale residue must be cleared even though it differs"
    );
    assert_eq!(checked_out(&dir.join("keep.txt")), b"also incoming\n");
    assert!(matches!(
        probe(&peer).head,
        Some(HeadRef::Branch { sha: ref s, .. }) if s == &sha
    ));
}

#[tokio::test]
async fn stale_residue_recognizes_content_already_known_to_git() {
    // #28p D10: `f.txt` sits on the dest, untracked, holding content that WAS once
    // committed there (a prior commit, later untracked — the shape a byte-synced
    // leftover takes once lockstep starts owning the path). `g.txt` holds content
    // that has never been part of any commit — real, never-synced work — and must
    // never be treated as safe even though the manifest also has an entry for it.
    // `h.txt` holds git-known content too, but carries NO manifest entry, so the
    // scope gate must exclude it regardless of what its content proves.
    if !git_available() {
        eprintln!(
            "git not on PATH — skipping stale_residue_recognizes_content_already_known_to_git"
        );
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let git = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git")
    };
    git(&["init", "-q", "."]);
    git(&["config", "user.email", "t@e"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(dir.join("f.txt"), b"old committed content\n").unwrap();
    std::fs::write(dir.join("h.txt"), b"old committed content\n").unwrap();
    git(&["add", "f.txt", "h.txt"]);
    git(&["commit", "-qm", "add"]);
    // Untrack both, then leave f.txt/h.txt holding that SAME (git-known) content,
    // and g.txt holding content nothing has ever recorded.
    git(&["rm", "-q", "--cached", "f.txt", "h.txt"]);
    git(&["commit", "-qm", "untrack"]);
    std::fs::write(dir.join("g.txt"), b"totally new, never committed\n").unwrap();

    let project_id = format!("d10-test-{}-{}", std::process::id(), line!());
    let manifest = remote_sync::new_manifest_state();
    {
        let mut g = manifest.lock().await;
        let m = remote_sync::ensure_loaded(&mut g, &project_id);
        m.insert("f.txt".to_string(), remote_sync::SyncEntry::default());
        m.insert("g.txt".to_string(), remote_sync::SyncEntry::default());
        // h.txt deliberately has no manifest entry.
    }

    let peer = Peer::Local(dir.to_path_buf());
    let paths = vec![
        "f.txt".to_string(),
        "g.txt".to_string(),
        "h.txt".to_string(),
    ];
    let residue = stale_byte_sync_residue(&manifest, &project_id, &peer, &paths).await;
    assert!(
        residue.contains("f.txt"),
        "content matching a git-known blob must be recognized as safe residue"
    );
    assert!(
        !residue.contains("g.txt"),
        "content nothing has ever recorded must never be treated as safe to delete, \
             manifest entry or not"
    );
    assert!(
        !residue.contains("h.txt"),
        "a path outside the manifest's scope must be excluded regardless of content"
    );

    forget_synced_paths(&manifest, &project_id, &paths).await;
    {
        let mut g = manifest.lock().await;
        let m = remote_sync::ensure_loaded(&mut g, &project_id);
        assert!(
            m.is_empty(),
            "the bases must be dropped once lockstep owns the paths"
        );
    }

    if let Some(parent) = remote_sync::manifest_path(&project_id).parent() {
        let _ = std::fs::remove_dir_all(parent);
    }
}

// ── #28p D3: pairing collisions + symmetric probe-error refusal ──────────

fn fp(size: u64, hash: Option<&str>) -> Fingerprint {
    Fingerprint {
        size,
        hash: hash.map(str::to_string),
    }
}

#[test]
fn pairing_collisions_only_flags_files_that_actually_differ() {
    let source: HashMap<String, Fingerprint> = [
        ("same.txt".to_string(), fp(3, Some("aaa"))),
        ("differs.txt".to_string(), fp(3, Some("bbb"))),
        ("bigger.txt".to_string(), fp(9, Some("ccc"))),
        ("source-only.txt".to_string(), fp(1, Some("ddd"))),
    ]
    .into_iter()
    .collect();
    let dest: HashMap<String, Fingerprint> = [
        // Byte-identical: the EXPECTED case when file-sync already mirrored the
        // tree — pairing must adopt these, not refuse over them.
        ("same.txt".to_string(), fp(3, Some("aaa"))),
        // Same size, different content → a real difference.
        ("differs.txt".to_string(), fp(3, Some("zzz"))),
        // Different size → differs without needing a hash at all.
        ("bigger.txt".to_string(), fp(4, None)),
        // Only on the dest → pairing doesn't touch it.
        ("dest-only.txt".to_string(), fp(2, Some("eee"))),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        pairing_collisions(&source, &dest),
        vec!["bigger.txt", "differs.txt"]
    );
    // Nothing in common → nothing at risk.
    assert!(pairing_collisions(&source, &HashMap::new()).is_empty());
}

#[test]
fn pairing_collisions_treat_an_unprovable_match_as_a_difference() {
    // Same size but the dest's hash couldn't be computed: `reset --hard` is
    // destructive, so "probably fine" is not good enough.
    let source: HashMap<String, Fingerprint> = [("f".to_string(), fp(3, Some("aaa")))]
        .into_iter()
        .collect();
    let dest: HashMap<String, Fingerprint> =
        [("f".to_string(), fp(3, None))].into_iter().collect();
    assert_eq!(pairing_collisions(&source, &dest), vec!["f"]);
}

#[test]
fn parse_ls_tree_long_reads_blobs_with_sizes() {
    let out = b"100644 blob aaa111    6\tsrc/a.rs\x00100755 blob bbb222   12\tb in.sh\x00160000 commit ccc333       -\tsub\x00";
    let m = parse_ls_tree_long(out);
    assert_eq!(
        m.len(),
        2,
        "submodules/commits carry no bytes and are skipped"
    );
    assert_eq!(m["src/a.rs"], fp(6, Some("aaa111")));
    assert_eq!(m["b in.sh"], fp(12, Some("bbb222")));
}

#[test]
fn pairing_dest_probe_error_is_symmetric() {
    let clean = PeerSnapshot::default();
    let errored = PeerSnapshot {
        probe_error: true,
        ..Default::default()
    };
    // Source local ⇒ the host is the side we'd init+reset: its probe error blocks.
    assert!(pairing_dest_probe_error(true, &clean, &errored));
    assert!(!pairing_dest_probe_error(true, &errored, &clean));
    // Source remote ⇒ the mirror is the dest (the case that was already guarded).
    assert!(pairing_dest_probe_error(false, &errored, &clean));
    assert!(!pairing_dest_probe_error(false, &clean, &errored));
    assert!(!pairing_dest_probe_error(true, &clean, &clean));
}

// ── #28p D4: disconnected ────────────────────────────────────────────────

#[tokio::test]
async fn cold_pool_reads_as_disconnected_not_connected() {
    // The gate every writing path checks: an empty pool is not a connection, so no
    // probe ever runs and no host state is believed (a dropped SSH exits non-zero,
    // which `probe` would otherwise read as "the host is a clean, empty side").
    let pool = crate::services::remote::new_pool();
    assert!(!connected(&pool, "no-such-project").await);
}

/// A lockstep operation leaves the runtime's thread for the blocking pool, its
/// awaits (the pool lock, a timer) still complete there, and a panic inside it
/// still reaches the caller.
#[tokio::test]
async fn a_lockstep_operation_runs_off_the_async_workers_and_still_awaits() {
    let worker = std::thread::current().id();
    let pool = crate::services::remote::new_pool();
    let (ran_on, answer) = off_worker(None, async move {
        let here = std::thread::current().id();
        tokio::time::sleep(Duration::from_millis(5)).await;
        (here, connected(&pool, "no-such-project").await)
    })
    .await
    .expect("ran");
    assert_ne!(ran_on, worker, "the operation must not run on the async worker");
    assert!(!answer);

    let joined = tokio::spawn(off_worker(None, async {
        if true {
            panic!("lockstep boom");
        }
    }))
    .await;
    assert!(joined.is_err_and(|e| e.is_panic()), "a panic must reach the caller");
}

/// A lockstep operation keeps running when its caller is dropped (it is on a
/// blocking thread), so it must keep the project's mutation lock until it
/// ends: released with the dropped caller, the next pass — or the other
/// process — would take the project while this one is still writing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_caller_leaves_the_mutation_lock_with_the_running_operation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let held = crate::services::sync_op::acquire_in(dir.path(), "off-worker-lock-test").await.expect("lock");
    let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let caller = tokio::spawn(off_worker(Some(held), async move {
        started_tx.send(()).unwrap();
        // A blocking git step, still running after the caller went away.
        release_rx.recv().unwrap();
        let _ = done_tx.send(());
    }));
    tokio::task::spawn_blocking(move || started_rx.recv().unwrap()).await.unwrap();
    caller.abort();
    let _ = caller.await;

    let second = tokio::time::timeout(
        Duration::from_millis(300),
        crate::services::sync_op::acquire_in(dir.path(), "off-worker-lock-test"),
    )
    .await;
    assert!(second.is_err(), "the lock must stay with the operation its dropped caller started");

    release_tx.send(()).unwrap();
    done_rx.await.expect("the operation ran to its end");
    tokio::time::timeout(
        Duration::from_secs(5),
        crate::services::sync_op::acquire_in(dir.path(), "off-worker-lock-test"),
    )
    .await
    .expect("released once the operation ended")
    .expect("lock");
}

#[test]
fn disconnected_state_keeps_heads_and_drops_the_early_out() {
    let prior = GitPeerState {
        enabled: true,
        status: SyncStatus::Synchronized,
        local_head: Some(HeadRef::Branch {
            name: "main".into(),
            sha: "a".into(),
        }),
        remote_head: Some(HeadRef::Branch {
            name: "main".into(),
            sha: "a".into(),
        }),
        local_sig: Some("sig".into()),
        remote_sig: Some("sig".into()),
        ..Default::default()
    };
    let s = disconnected_state(&prior);
    assert_eq!(s.status, SyncStatus::Disconnected);
    assert!(s.enabled, "the opt-in survives a dropped link");
    assert_eq!(
        s.local_head, prior.local_head,
        "last-known heads are still shown"
    );
    // Signatures must not persist across a disconnect, else the first pass after
    // reconnecting could early-out on a stale green.
    assert!(s.local_sig.is_none() && s.remote_sig.is_none());
}

// ── #28p D5: batched probe + ancestry + early-out ────────────────────────

#[test]
fn parse_probe_block_round_trips_a_synthesized_block() {
    let block = format!(
        "repo{RS}main\n{RS}abc123\n{RS}abc123 main\ndef456 feat\n{RS}t1t1 v1.0\n{RS} M src/a.rs\n?? new\n{RS}Fix the thing\n"
    );
    let s = parse_probe_block(&block).expect("parses");
    assert!(s.is_repo && !s.probe_error);
    assert_eq!(
        s.head,
        Some(HeadRef::Branch {
            name: "main".into(),
            sha: "abc123".into()
        })
    );
    assert_eq!(s.branches.len(), 2);
    assert_eq!(s.branches[1].name, "feat");
    assert_eq!(
        s.tags,
        vec![RefEntry {
            name: "v1.0".into(),
            sha: "t1t1".into()
        }]
    );
    assert!(
        s.dirty_tracked,
        "a tracked modification, despite the ?? line"
    );
    assert_eq!(s.head_subject.as_deref(), Some("Fix the thing"));
}

#[test]
fn parse_probe_block_tolerates_empty_sections_and_a_non_repo() {
    // Unborn HEAD, no branches, no tags, clean tree, no subject.
    let s = parse_probe_block(&format!("repo{RS}{RS}{RS}{RS}{RS}{RS}")).expect("parses");
    assert!(s.is_repo);
    assert_eq!(s.head, Some(HeadRef::Unborn));
    assert!(s.branches.is_empty() && s.tags.is_empty() && !s.dirty_tracked);
    assert!(s.head_subject.is_none());

    let none = parse_probe_block("norepo").expect("parses");
    assert!(!none.is_repo && !none.probe_error);

    // Garbage (no POSIX sh, or a link that died mid-script) → the caller must fall
    // back to the per-command probe rather than believe a half-read snapshot.
    assert!(parse_probe_block("").is_none());
    assert!(parse_probe_block("sh: 1: git: not found\n").is_none());
}

#[test]
fn ancestry_script_and_block_round_trip() {
    let pairs = vec![
        ("aaa".to_string(), "bbb".to_string()),
        ("ccc".to_string(), "ddd".to_string()),
    ];
    let script = ancestry_script(&pairs);
    assert!(script.contains("merge-base --is-ancestor aaa bbb"));
    assert!(script.contains("merge-base --is-ancestor bbb aaa"));

    assert_eq!(
        parse_ancestry_block("10\n01\n", 2),
        Some(vec![(true, false), (false, true)])
    );
    assert_eq!(
        parse_ancestry_block("00\n11\n", 2),
        Some(vec![(false, false), (true, true)])
    );
    // A misaligned answer is never used: a wrong bit here would misclassify a
    // divergence, so the caller falls back to per-branch checks instead.
    assert_eq!(parse_ancestry_block("10\n", 2), None);
    assert_eq!(parse_ancestry_block("", 1), None);
}

/// Run a script through a real POSIX `sh` in `dir`, exactly as
/// `ssh_exec::run_remote_script` has the remote shell run it. A syntax error here
/// would make every remote probe fall back to the six-round-trip path *silently* —
/// D5 would look implemented and do nothing.
#[cfg(unix)]
fn run_sh(dir: &Path, script: &str) -> String {
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("cd {} && {{ {script}\n}}", dir.display()))
        .output()
        .expect("sh");
    assert!(
        out.status.success(),
        "script failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

#[cfg(unix)]
#[test]
fn probe_script_runs_in_a_real_shell_and_parses() {
    if !git_available() {
        eprintln!("git not on PATH — skipping probe_script_runs_in_a_real_shell_and_parses");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let sha = repo_behind_by_one(dir); // leaves `main` checked out, `feat` ahead
    std::fs::write(dir.join("base.txt"), b"edited\n").unwrap(); // tracked, dirty

    let snap = parse_probe_block(&run_sh(dir, PROBE_SCRIPT))
        .expect("the batched probe must parse its own script's output");
    assert!(snap.is_repo && !snap.probe_error);
    assert!(matches!(&snap.head, Some(HeadRef::Branch { name, .. }) if name == "main"));
    assert_eq!(snap.branches.len(), 2, "main + feat");
    assert!(snap
        .branches
        .iter()
        .any(|b| b.name == "feat" && b.sha == sha));
    assert!(snap.dirty_tracked);
    assert_eq!(snap.head_subject.as_deref(), Some("base"));

    // The one-round-trip answer must match the six-round-trip one it replaces.
    let per_cmd = probe_per_command(&Peer::Local(dir.to_path_buf()));
    assert_eq!(snap.head, per_cmd.head);
    assert_eq!(snap.dirty_tracked, per_cmd.dirty_tracked);
    assert_eq!(snap.branches.len(), per_cmd.branches.len());
}

/// #23 D1 — the single most valuable test in the worktree audit, and the one
/// whose absence let the corruption ship.
///
/// `git symbolic-ref HEAD` at the peer root answers for the MAIN worktree only,
/// so a branch checked out in a linked worktree read as an ordinary unattached
/// ref and every lockstep ref move for it went down the `update-ref` arm. That
/// arm does not refuse (verified: exit 0, silent) — unlike `git branch -f`,
/// which answers `fatal: cannot force update the branch 'feat' used by worktree
/// at '…'`. The worktree's HEAD moved under it and its index was left staging a
/// revert of the incoming change, which the commit UI's `git add -A` would then
/// commit.
///
/// The whole fix is upstream of the decision: the probe has to *see* the linked
/// checkout. So that is what this asserts, on both probe paths.
#[cfg(unix)]
#[test]
fn the_probe_sees_a_branch_checked_out_in_a_linked_worktree() {
    if !git_available() {
        eprintln!("git not on PATH — skipping");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    repo_behind_by_one(dir); // `main` checked out, `feat` ahead and unattached
    let wt = tmp.path().join("wt-feat");
    let out = std::process::Command::new("git")
        .args(["worktree", "add", &wt.to_string_lossy(), "feat"])
        .current_dir(dir)
        .output()
        .expect("git worktree add");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let snap = parse_probe_block(&run_sh(dir, PROBE_SCRIPT)).expect("parses");
    // HEAD alone still says only "main" — which is exactly the blind spot.
    assert!(matches!(&snap.head, Some(HeadRef::Branch { name, .. }) if name == "main"));
    assert!(
        snap.checked_out.iter().any(|b| b == "feat"),
        "the batched probe must report the linked worktree's branch: {:?}",
        snap.checked_out
    );
    assert!(snap.checked_out.iter().any(|b| b == "main"));

    // The per-command fallback must agree, or a peer that fell back would
    // silently lose the protection.
    let per_cmd = probe_per_command(&Peer::Local(dir.to_path_buf()));
    let mut a = snap.checked_out.clone();
    let mut b = per_cmd.checked_out.clone();
    a.sort();
    b.sort();
    assert_eq!(a, b);

    // And the guard derived from it names `feat` and only `feat`.
    let linked = linked_checkout_branches(&snap);
    assert!(linked.contains("feat"));
    assert!(
        !linked.contains("main"),
        "the MAIN worktree's branch is handled by the reset/merge arm, not blocked"
    );
}

#[test]
fn linked_checkout_branches_excludes_the_main_worktrees_head() {
    let snap = PeerSnapshot {
        is_repo: true,
        head: Some(HeadRef::Branch {
            name: "main".into(),
            sha: "abc".into(),
        }),
        checked_out: vec!["main".into(), "feat".into(), "wip".into()],
        ..Default::default()
    };
    let linked = linked_checkout_branches(&snap);
    assert_eq!(linked.len(), 2);
    assert!(linked.contains("feat") && linked.contains("wip"));

    // A detached peer has no HEAD branch to exclude, so every checkout is linked.
    let detached = PeerSnapshot {
        is_repo: true,
        head: Some(HeadRef::Detached { sha: "abc".into() }),
        checked_out: vec!["feat".into()],
        ..Default::default()
    };
    assert!(linked_checkout_branches(&detached).contains("feat"));

    // A peer whose git never answered reads as "nothing linked" — the pre-#23
    // behaviour, never a false block on every branch.
    assert!(linked_checkout_branches(&PeerSnapshot::default()).is_empty());
}

#[test]
fn checked_out_branches_skips_detached_and_bare_worktrees() {
    let text = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\n\
                    worktree /r/wt\nHEAD def\ndetached\n\n\
                    worktree /r/bare.git\nbare\n\n\
                    worktree /r/wt2\nHEAD ghi\nbranch refs/heads/feat\n";
    let mut got = checked_out_branches(text);
    got.sort();
    assert_eq!(got, vec!["feat".to_string(), "main".to_string()]);
}

#[cfg(unix)]
#[test]
fn probe_script_reports_a_non_repo_dir() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let snap = parse_probe_block(&run_sh(tmp.path(), PROBE_SCRIPT)).expect("parses");
    assert!(!snap.is_repo);
    // A clean "not a repo" is a legitimately-empty side we may pair into — it must
    // never be confused with a probe that could not run (which would license a wipe).
    assert!(!snap.probe_error);
}

#[cfg(unix)]
#[test]
fn ancestry_script_runs_in_a_real_shell_and_agrees_with_merge_base() {
    if !git_available() {
        eprintln!("git not on PATH — skipping ancestry_script_runs_in_a_real_shell");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let feat = repo_behind_by_one(dir);
    let peer = Peer::Local(dir.to_path_buf());
    let main = String::from_utf8_lossy(&peer.run(&["rev-parse", "main"]).unwrap().stdout)
        .trim()
        .to_string();

    // main is strictly behind feat → (dest=main is ancestor of source=feat) = true,
    // and the reverse false. Plus a self-pair, which is an ancestor of itself.
    let pairs = vec![(main.clone(), feat.clone()), (feat.clone(), feat.clone())];
    let out = run_sh(dir, &ancestry_script(&pairs));
    let got = parse_ancestry_block(&out, 2).expect("batched ancestry must parse");
    assert_eq!(got, vec![(true, false), (true, true)]);

    // And it agrees with the per-pair `merge-base` calls it replaces.
    let fallback: Vec<(bool, bool)> = pairs
        .iter()
        .map(|(d, s)| (is_ancestor(&peer, d, s), is_ancestor(&peer, s, d)))
        .collect();
    assert_eq!(got, fallback);
}

#[test]
fn is_hex_sha_gates_what_reaches_the_shell() {
    assert!(is_hex_sha("abc123"));
    assert!(!is_hex_sha(""));
    assert!(!is_hex_sha("abc; rm -rf /"));
    assert!(!is_hex_sha("$(whoami)"));
}

#[test]
fn early_out_only_when_green_and_nothing_moved() {
    let snap = PeerSnapshot {
        is_repo: true,
        head: Some(HeadRef::Branch {
            name: "main".into(),
            sha: "a".into(),
        }),
        branches: vec![RefEntry {
            name: "main".into(),
            sha: "a".into(),
        }],
        ..Default::default()
    };
    let sig = refs_signature(&snap);
    let green = GitPeerState {
        status: SyncStatus::Synchronized,
        local_sig: Some(sig.clone()),
        remote_sig: Some(sig.clone()),
        ..Default::default()
    };
    assert!(can_early_out(&green, &sig, &sig, true, false));
    // A moved ref on either side.
    assert!(!can_early_out(&green, "other", &sig, true, false));
    assert!(!can_early_out(&green, &sig, "other", true, false));
    // A manual Retry always looks (the user may have cleared a blocker that moved
    // no ref at all — deleting an untracked collision, say).
    assert!(!can_early_out(&green, &sig, &sig, true, true));
    // Never skip a pass that has real work: a red state, or an unpaired side.
    let red = GitPeerState {
        status: SyncStatus::Desynchronized,
        ..green.clone()
    };
    assert!(!can_early_out(&red, &sig, &sig, true, false));
    assert!(!can_early_out(&green, &sig, &sig, false, false));
    // A first-ever pass has no signatures to compare against.
    assert!(!can_early_out(
        &GitPeerState::default(),
        &sig,
        &sig,
        true,
        false
    ));
}

#[test]
fn refs_signature_moves_when_dirty_flips() {
    // A dirty→clean transition can unblock a fast-forward, so it must not be
    // invisible to the early-out.
    let clean = PeerSnapshot {
        is_repo: true,
        ..Default::default()
    };
    let dirty = PeerSnapshot {
        is_repo: true,
        dirty_tracked: true,
        ..Default::default()
    };
    assert_ne!(refs_signature(&clean), refs_signature(&dirty));
}

// ── Out-of-step HEADs (live-QA case 17/19) ───────────────────────────────

fn on_branch(name: &str, sha: &str) -> PeerSnapshot {
    PeerSnapshot {
        is_repo: true,
        head: Some(HeadRef::Branch {
            name: name.into(),
            sha: sha.into(),
        }),
        ..Default::default()
    }
}

#[test]
fn peers_on_the_same_head_are_in_step() {
    assert_eq!(
        head_mismatch(&on_branch("main", "aaa"), &on_branch("main", "aaa")),
        None
    );
    // Nothing observed on a side → nothing to claim.
    assert_eq!(
        head_mismatch(&on_branch("main", "aaa"), &PeerSnapshot::default()),
        None
    );
}

#[test]
fn peers_on_different_branches_are_not_green() {
    // The live failure: every ref matched on both sides, so `reconcile_with` — which
    // compares only refs — called it Synchronized while the mirror sat on `master`
    // and the host on `feat-x`. A half-landed checkout is not "in step".
    let msg = head_mismatch(&on_branch("master", "aaa"), &on_branch("feat-x", "bbb"))
        .expect("different branches must not be green");
    assert!(msg.contains("master") && msg.contains("feat-x"), "{msg}");
}

#[test]
fn detached_peer_is_reported_against_a_branch() {
    let detached = PeerSnapshot {
        is_repo: true,
        head: Some(HeadRef::Detached {
            sha: "cafebabe1234".into(),
        }),
        ..Default::default()
    };
    let msg = head_mismatch(&on_branch("main", "aaa"), &detached).expect("out of step");
    assert!(msg.contains("detached at cafebabe"), "{msg}");
}

// ── #28p D6: backup refs ─────────────────────────────────────────────────

#[test]
fn backup_ref_name_round_trips_through_the_parser() {
    for branch in ["main", "feature/x", "tags/v1"] {
        let name = backup_ref_name(branch, 1735689600);
        assert_eq!(
            parse_backup_ref_name(&name),
            Some((1735689600, branch.to_string()))
        );
    }
    assert_eq!(parse_backup_ref_name("refs/heads/main"), None);
    assert_eq!(
        parse_backup_ref_name(concat!("refs/", crate::app_slug!(), "/backup/notanumber/x")),
        None
    );
}

#[test]
fn parse_backup_refs_reads_for_each_ref_output() {
    let out = concat!("aaa\trefs/", crate::app_slug!(), "/backup/100/main\tOld tip\n\
                   bbb\trefs/", crate::app_slug!(), "/backup/200/feature/x\tNewer tip\n\
                   ccc\trefs/heads/main\tnot a backup\n");
    let refs = parse_backup_refs("local", out);
    assert_eq!(refs.len(), 2);
    assert_eq!(refs[0].ts, 200, "newest first");
    assert_eq!(refs[0].branch, "feature/x");
    assert_eq!(refs[0].peer, "local");
    assert_eq!(refs[1].subject, "Old tip");
}

#[test]
fn select_prunable_keeps_the_newest_n_and_anything_recent() {
    let now = 1_800_000_000u64; // a plausible epoch; must exceed the ages below
    let day = 24 * 60 * 60;
    let mk = |ts: u64| BackupRef {
        peer: "local".into(),
        refname: format!("refs/{SLUG}/backup/{ts}/main"),
        ts,
        branch: "main".into(),
        sha: "a".into(),
        subject: String::new(),
    };
    // Three ancient, two recent.
    let refs = vec![
        mk(now - 100 * day),
        mk(now - 90 * day),
        mk(now - 80 * day),
        mk(now - 2 * day),
        mk(now - day),
    ];
    // keep_n=2 → the two newest survive on count; the recent ones survive on age
    // anyway; the three ancient ones beyond the count go.
    let pruned = select_prunable(&refs, now, 2, 30 * day);
    assert_eq!(pruned.len(), 3);
    assert!(pruned
        .iter()
        .all(|r| r.contains(&format!("{}", now - 100 * day))
            || r.contains(&format!("{}", now - 90 * day))
            || r.contains(&format!("{}", now - 80 * day))));

    // Age alone protects a ref even past the count.
    assert!(select_prunable(&refs, now, 0, 30 * day).len() == 3);
    // The newest is NEVER pruned, however aggressive the policy.
    let all_ancient = vec![mk(now - 100 * day), mk(now - 99 * day)];
    let pruned = select_prunable(&all_ancient, now, 0, 0);
    assert_eq!(pruned.len(), 1);
    assert!(pruned[0].contains(&format!("{}", now - 100 * day)));
    assert!(select_prunable(&[], now, 0, 0).is_empty());
}

// ── #28p D7: origin propagation ──────────────────────────────────────────

#[test]
fn origin_propagates_only_into_a_dest_that_has_none() {
    assert_eq!(
        should_propagate_origin(Some("git@github.com:me/p.git"), None),
        Some("git@github.com:me/p.git".to_string())
    );
    // The dest already has its own origin → never overwritten.
    assert_eq!(
        should_propagate_origin(Some("git@github.com:me/p.git"), Some("git@other:x.git")),
        None
    );
    // Nothing to propagate.
    assert_eq!(should_propagate_origin(None, None), None);
    assert_eq!(should_propagate_origin(Some("  "), None), None);
}

// ── #28p D8: peer refs for a hand-resolved divergence ────────────────────

#[test]
fn only_diverged_branches_park_a_peer_ref() {
    assert_eq!(peer_ref_op(RefAction::Diverged, false), PeerRefOp::Set);
    // Everything in step (or already resolved) clears the ref, so it never outlives
    // the divergence it documents.
    assert_eq!(peer_ref_op(RefAction::InSync, false), PeerRefOp::Delete);
    assert_eq!(
        peer_ref_op(RefAction::FastForwardDest, false),
        PeerRefOp::Delete
    );
    assert_eq!(
        peer_ref_op(RefAction::CreateOnDest, false),
        PeerRefOp::Delete
    );
    assert_eq!(peer_ref_op(RefAction::DestAhead, false), PeerRefOp::Delete);
    // A forced pass RESOLVES the divergence, so it clears rather than parks.
    assert_eq!(peer_ref_op(RefAction::Diverged, true), PeerRefOp::Delete);
    assert_eq!(peer_ref_name("feature/x"), concat!("refs/", crate::app_slug!(), "/peer/feature/x"));
}

// ── #28p D9: force-reset collisions ──────────────────────────────────────

/// A fresh repo at `dir` with one commit tracking `path` = `content`. Returns the
/// commit sha.
fn init_repo_with_file(dir: &Path, path: &str, content: &[u8]) -> String {
    let git = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git")
    };
    git(&["init", "-q", "."]);
    git(&["config", "user.email", "t@e"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(dir.join(path), content).unwrap();
    git(&["add", path]);
    git(&["commit", "-qm", "add"]);
    String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout)
        .trim()
        .to_string()
}

fn rev(dir: &Path, r: &str) -> String {
    String::from_utf8_lossy(&git_output(dir, &["rev-parse", r]).stdout)
        .trim()
        .to_string()
}

#[test]
fn force_reset_branch_moves_head_and_keeps_a_backup() {
    if !git_available() {
        eprintln!("git not on PATH — skipping force_reset_branch_moves_head_and_keeps_a_backup");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let first = init_repo_with_file(dir, "a.txt", b"one\n");
    std::fs::write(dir.join("a.txt"), b"two\n").unwrap();
    git_output(dir, &["commit", "-qam", "two"]);
    let second = rev(dir, "HEAD");
    let branch = String::from_utf8_lossy(&git_output(dir, &["branch", "--show-current"]).stdout)
        .trim()
        .to_string();
    let peer = Peer::Local(dir.to_path_buf());

    force_reset_branch(&peer, &branch, &first, &second, true, 1_700_000_000).expect("reset");
    assert_eq!(rev(dir, "HEAD"), first);
    assert_eq!(rev(dir, &backup_ref_name(&branch, 1_700_000_000)), second);
}

#[test]
fn force_reset_branch_reports_a_reset_that_did_not_happen() {
    if !git_available() {
        eprintln!("git not on PATH — skipping force_reset_branch_reports_a_reset_that_did_not_happen");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let head = init_repo_with_file(dir, "a.txt", b"one\n");
    let branch = String::from_utf8_lossy(&git_output(dir, &["branch", "--show-current"]).stdout)
        .trim()
        .to_string();
    let peer = Peer::Local(dir.to_path_buf());
    // The winner's commit never reached this side — the shape of a failed bundle
    // fetch. This used to be ignored and counted as applied.
    let missing = "0123456789abcdef0123456789abcdef01234567";

    let err = force_reset_branch(&peer, &branch, missing, &head, true, 1_700_000_001)
        .expect_err("a reset onto an unknown commit must fail");
    assert!(err.contains("resetting"), "{err}");
    assert_eq!(rev(dir, "HEAD"), head, "HEAD must not have moved");

    let err = force_reset_branch(&peer, &branch, missing, &head, false, 1_700_000_002)
        .expect_err("a ref move onto an unknown commit must fail");
    assert!(err.contains("moving"), "{err}");
    assert_eq!(rev(dir, &format!("refs/heads/{branch}")), head);
}

/// Make `backup_ref_name(<anything>, ts)` unwritable in `dir`: a plain ref at the
/// batch's own name leaves no room for refs below it.
fn block_backup_batch(dir: &Path, ts: u64, sha: &str) {
    let batch = format!("{}/{ts}", crate::brand::GIT_REF_BACKUP);
    assert!(git_output(dir, &["update-ref", &batch, sha]).status.success());
}

#[test]
fn force_reset_branch_does_not_move_without_its_backup() {
    if !git_available() {
        eprintln!("git not on PATH — skipping force_reset_branch_does_not_move_without_its_backup");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let first = init_repo_with_file(dir, "a.txt", b"one\n");
    std::fs::write(dir.join("a.txt"), b"two\n").unwrap();
    git_output(dir, &["commit", "-qam", "two"]);
    let second = rev(dir, "HEAD");
    let branch = String::from_utf8_lossy(&git_output(dir, &["branch", "--show-current"]).stdout)
        .trim()
        .to_string();
    let peer = Peer::Local(dir.to_path_buf());
    block_backup_batch(dir, 1_700_000_003, &first);

    let err = force_reset_branch(&peer, &branch, &first, &second, true, 1_700_000_003)
        .expect_err("a failed backup must stop the reset");
    assert!(err.contains("backing up"), "{err}");
    assert_eq!(rev(dir, "HEAD"), second, "HEAD must not have moved");
}

#[test]
fn force_move_tag_does_not_move_without_its_backup() {
    if !git_available() {
        eprintln!("git not on PATH — skipping force_move_tag_does_not_move_without_its_backup");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let first = init_repo_with_file(dir, "a.txt", b"one\n");
    git_output(dir, &["tag", "v1"]);
    std::fs::write(dir.join("a.txt"), b"two\n").unwrap();
    git_output(dir, &["commit", "-qam", "two"]);
    let second = rev(dir, "HEAD");
    let peer = Peer::Local(dir.to_path_buf());
    block_backup_batch(dir, 1_700_000_004, &first);

    let err = force_move_tag(&peer, "v1", &second, &first, 1_700_000_004)
        .expect_err("a failed backup must stop the tag move");
    assert!(err.contains("backing up"), "{err}");
    assert_eq!(rev(dir, "refs/tags/v1"), first, "the tag must not have moved");

    force_move_tag(&peer, "v1", &second, &first, 1_700_000_005).expect("move");
    assert_eq!(rev(dir, "refs/tags/v1"), second);
    assert_eq!(rev(dir, &backup_ref_name("tags/v1", 1_700_000_005)), first);
}

#[test]
fn back_up_branches_reports_a_backup_that_did_not_land() {
    if !git_available() {
        eprintln!("git not on PATH — skipping back_up_branches_reports_a_backup_that_did_not_land");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let head = init_repo_with_file(dir, "a.txt", b"one\n");
    let peer = Peer::Local(dir.to_path_buf());
    let branches = vec![RefEntry { name: "main".into(), sha: head.clone() }];

    back_up_branches(&peer, &branches, 1_700_000_006).expect("backup");
    assert_eq!(rev(dir, &backup_ref_name("main", 1_700_000_006)), head);

    block_backup_batch(dir, 1_700_000_007, &head);
    let err = back_up_branches(&peer, &branches, 1_700_000_007)
        .expect_err("a backup that did not land must stop the pairing");
    assert!(err.contains("backing up"), "{err}");
}

#[test]
fn create_tag_never_moves_a_tag_that_appeared_since_the_probe() {
    if !git_available() {
        eprintln!("git not on PATH — skipping create_tag_never_moves_a_tag_that_appeared_since_the_probe");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let first = init_repo_with_file(dir, "a.txt", b"one\n");
    git_output(dir, &["tag", "v1"]);
    std::fs::write(dir.join("a.txt"), b"two\n").unwrap();
    git_output(dir, &["commit", "-qam", "two"]);
    let second = rev(dir, "HEAD");
    let peer = Peer::Local(dir.to_path_buf());

    let err = create_tag(&peer, "v1", &second).expect_err("an existing tag is not a create");
    assert!(err.contains("creating tag"), "{err}");
    assert_eq!(rev(dir, "refs/tags/v1"), first, "the tag must not have moved");
    create_tag(&peer, "v2", &second).expect("create");
    assert_eq!(rev(dir, "refs/tags/v2"), second);
}

/// A branch create the dest refuses is an error the pass reports as blocked —
/// it used to be ignored and counted as applied — and a branch made on the
/// dest since the probe is never overwritten.
#[test]
fn create_branch_never_moves_a_branch_that_appeared_since_the_probe() {
    if !git_available() {
        eprintln!("git not on PATH — skipping create_branch_never_moves_a_branch_that_appeared_since_the_probe");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let first = init_repo_with_file(dir, "a.txt", b"one\n");
    git_output(dir, &["branch", "side"]);
    std::fs::write(dir.join("a.txt"), b"two\n").unwrap();
    git_output(dir, &["commit", "-qam", "two"]);
    let second = rev(dir, "HEAD");
    let peer = Peer::Local(dir.to_path_buf());

    let err = create_branch(&peer, "side", &second).expect_err("an existing branch is not a create");
    assert!(err.contains("creating 'side'"), "{err}");
    assert_eq!(rev(dir, "refs/heads/side"), first, "the branch must not have moved");
    create_branch(&peer, "fresh", &second).expect("create");
    assert_eq!(rev(dir, "refs/heads/fresh"), second);
}

/// A ref the initial pairing's transfer could not create is the pairing's
/// report, not dropped: `init_pairing` used to discard the transfer's
/// `blocked`, so a pairing that left a branch behind read as green. (The
/// pairing itself needs an SSH peer; this pins the translation it reports.)
#[test]
fn a_ref_the_pairing_could_not_create_is_reported() {
    let refused = TransferResult {
        blocked: Some("creating 'Feature' failed: cannot lock ref".to_string()),
        ..Default::default()
    };
    let said = pairing_left_behind(refused).expect("a refused create is reported");
    assert!(said.contains("creating 'Feature'"), "{said}");
    assert_eq!(pairing_left_behind(TransferResult { applied: 3, ..Default::default() }), None);
}

/// A fast-forward of a branch that is not checked out is guarded by the tip the
/// probe saw: one that moved since is left where it is and reported, never
/// counted as applied.
#[test]
fn fast_forward_branch_ref_reports_a_branch_that_moved_since_the_probe() {
    if !git_available() {
        eprintln!("git not on PATH — skipping fast_forward_branch_ref_reports_a_branch_that_moved_since_the_probe");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let first = init_repo_with_file(dir, "a.txt", b"one\n");
    git_output(dir, &["branch", "side"]);
    std::fs::write(dir.join("a.txt"), b"two\n").unwrap();
    git_output(dir, &["commit", "-qam", "two"]);
    let second = rev(dir, "HEAD");
    std::fs::write(dir.join("a.txt"), b"three\n").unwrap();
    git_output(dir, &["commit", "-qam", "three"]);
    let third = rev(dir, "HEAD");
    // The probe saw `side` at `first`; something moved it on since.
    git_output(dir, &["branch", "-f", "side", &second]);
    let peer = Peer::Local(dir.to_path_buf());

    let err = fast_forward_branch_ref(&peer, "side", &third, &first).expect_err("a stale old value");
    assert!(err.contains("fast-forwarding 'side'"), "{err}");
    assert_eq!(rev(dir, "refs/heads/side"), second, "the moved branch stays where it is");
    fast_forward_branch_ref(&peer, "side", &third, &second).expect("fast-forward");
    assert_eq!(rev(dir, "refs/heads/side"), third);
}

/// A lockstep state file that does not parse is never replaced by the
/// default-derived state a later save carries; a readable one is.
#[test]
fn save_state_never_replaces_an_unreadable_state_file() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("git_peer.json");
    let newer = r#"{"enabled":true,"localAuthoritative":true,"status":"fromANewerBuild","detail":null}"#;
    std::fs::write(&path, newer).unwrap();
    assert!(save_state_at(&path, &GitPeerState::default()).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);

    std::fs::remove_file(&path).unwrap();
    let on = GitPeerState { enabled: true, local_authoritative: true, ..GitPeerState::default() };
    save_state_at(&path, &on).unwrap();
    let back: GitPeerState = crate::storage::read_json(&path).unwrap();
    assert!(back.enabled && back.local_authoritative);
    save_state_at(&path, &GitPeerState::default()).unwrap();
    let back: GitPeerState = crate::storage::read_json(&path).unwrap();
    assert!(!back.enabled);
}

#[test]
fn dirty_tracked_reads_a_short_non_ascii_status_line_without_panicking() {
    assert!(is_dirty_tracked("?é"));
    assert!(!is_dirty_tracked("?? new.txt\n"));
    assert!(is_dirty_tracked(" M a.txt\n"));
}

#[test]
fn dirty_tracked_paths_names_tracked_edits_only() {
    if !git_available() {
        eprintln!("git not on PATH — skipping dirty_tracked_paths_names_tracked_edits_only");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo_with_file(dir, "a.txt", b"one\n");
    std::fs::write(dir.join("a.txt"), b"edited\n").unwrap();
    std::fs::write(dir.join("new.txt"), b"untracked\n").unwrap();
    assert_eq!(dirty_tracked_paths(&Peer::Local(dir.to_path_buf())), vec!["a.txt"]);
}

#[test]
fn name_list_caps_and_counts_the_rest() {
    assert_eq!(name_list(&[], 3, ": "), "");
    let paths: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
    assert_eq!(name_list(&paths, 2, ": "), ": a, b (+2 more)");
    assert_eq!(name_list(&paths[..1], 2, ": "), ": a");
}

#[test]
fn local_authoritative_defaults_off_for_older_state_files() {
    let old = r#"{"enabled":true,"status":"synchronized","detail":null,"localHead":null,"remoteHead":null,"lastSyncTs":null}"#;
    let s: GitPeerState = serde_json::from_str(old).expect("older state parses");
    assert!(s.enabled);
    assert!(!s.local_authoritative);
}

#[test]
fn reset_collisions_flags_only_the_differing_source_tracked_path() {
    if !git_available() {
        eprintln!("git not on PATH — skipping reset_collisions_flags_only_the_differing_source_tracked_path");
        return;
    }
    let src_tmp = tempfile::tempdir().expect("tempdir");
    let sha = init_repo_with_file(src_tmp.path(), "keep.txt", b"committed content\n");
    let source = Peer::Local(src_tmp.path().to_path_buf());

    let dst_tmp = tempfile::tempdir().expect("tempdir");
    let dst = dst_tmp.path();
    crate::paths::command_no_window("git")
        .args(["init", "-q", "."])
        .current_dir(dst)
        .output()
        .expect("git init");
    // Differs from what the target sha tracks → at risk.
    std::fs::write(dst.join("keep.txt"), b"MY UNSAVED WORK\n").unwrap();
    // Untracked but not something the source's tree even mentions → never at risk.
    std::fs::write(dst.join("other.txt"), b"unrelated\n").unwrap();
    let dest = Peer::Local(dst.to_path_buf());

    assert_eq!(reset_collisions(&source, &dest, &sha), vec!["keep.txt"]);
}

#[test]
fn reset_collisions_allows_byte_identical_untracked_files() {
    if !git_available() {
        eprintln!(
            "git not on PATH — skipping reset_collisions_allows_byte_identical_untracked_files"
        );
        return;
    }
    let src_tmp = tempfile::tempdir().expect("tempdir");
    let sha = init_repo_with_file(src_tmp.path(), "keep.txt", b"committed content\n");
    let source = Peer::Local(src_tmp.path().to_path_buf());

    let dst_tmp = tempfile::tempdir().expect("tempdir");
    let dst = dst_tmp.path();
    crate::paths::command_no_window("git")
        .args(["init", "-q", "."])
        .current_dir(dst)
        .output()
        .expect("git init");
    std::fs::write(dst.join("keep.txt"), b"committed content\n").unwrap();
    let dest = Peer::Local(dst.to_path_buf());

    assert!(
        reset_collisions(&source, &dest, &sha).is_empty(),
        "byte-identical untracked content is a no-op for reset --hard, not a collision"
    );
}

#[test]
fn reset_collisions_within_a_single_peer_detects_the_restore_backup_case() {
    // `restore_backup` calls this with source_peer == dest_peer: the backup ref
    // and the untracked collision live on the same repo.
    if !git_available() {
        eprintln!("git not on PATH — skipping reset_collisions_within_a_single_peer_detects_the_restore_backup_case");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    let backup_sha = init_repo_with_file(dir, "secret.env", b"old committed secret\n");
    let git = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git")
    };
    // A later commit untracks the path (the shape restoring an OLDER backup onto
    // a repo that has since moved on produces), then the now-untracked file is
    // edited — real, never-committed work sitting where the backup would land it.
    git(&["rm", "-q", "--cached", "secret.env"]);
    git(&["commit", "-qm", "untrack secret"]);
    std::fs::write(dir.join("secret.env"), b"NEW LOCAL WORK\n").unwrap();

    let peer = Peer::Local(dir.to_path_buf());
    assert_eq!(
        reset_collisions(&peer, &peer, &backup_sha),
        vec!["secret.env"]
    );
}

#[test]
fn state_default_is_disabled_and_synchronized() {
    let s = GitPeerState::default();
    assert!(!s.enabled);
    assert_eq!(s.status, SyncStatus::Synchronized);
}

#[test]
fn state_roundtrips_camelcase() {
    let s = GitPeerState {
        enabled: true,
        local_authoritative: false,
        status: SyncStatus::Desynchronized,
        detail: Some("Diverged: main".into()),
        local_head: Some(HeadRef::Branch {
            name: "main".into(),
            sha: "a".into(),
        }),
        remote_head: Some(HeadRef::Detached { sha: "b".into() }),
        last_sync_ts: Some(42),
        local_subject: Some("Fix it".into()),
        remote_subject: None,
        pairing_conflict: Some(PairingConflict {
            source_is_local: true,
            paths: vec!["README.md".into()],
        }),
        local_sig: None,
        remote_sig: None,
    };
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("\"lastSyncTs\":42"));
    assert!(json.contains("\"localHead\""));
    assert!(json.contains("\"kind\":\"branch\""));
    assert!(json.contains("\"desynchronized\""));
    assert!(json.contains("\"pairingConflict\""));
    assert!(json.contains("\"sourceIsLocal\":true"));
    let back: GitPeerState = serde_json::from_str(&json).unwrap();
    assert_eq!(back.status, SyncStatus::Desynchronized);
    assert_eq!(
        back.remote_head,
        Some(HeadRef::Detached { sha: "b".into() })
    );
    assert_eq!(back.pairing_conflict.unwrap().paths, vec!["README.md"]);
}

#[test]
fn state_from_before_28p_still_loads() {
    // Every field #28p added is `#[serde(default)]`, so a `git_peer.json` written by
    // the shipped #28n build keeps working instead of resetting the opt-in.
    let old = r#"{"enabled":true,"status":"synchronized","detail":null,
                      "localHead":{"kind":"unborn"},"remoteHead":null,"lastSyncTs":7}"#;
    let s: GitPeerState = serde_json::from_str(old).unwrap();
    assert!(s.enabled);
    assert_eq!(s.status, SyncStatus::Synchronized);
    assert!(s.pairing_conflict.is_none() && s.local_sig.is_none());
}

// ── The half-seeded host: `git init` ran, the checkout never did ─────────
//
// Live failure (DemoProj, extend-local-to-remote): the host ended up holding a
// `.git` and an empty working tree, permanently, and the pill blamed a branch that
// existed on neither side ("the mirror is on 'transfer-learning', the host is on
// 'master'"). Three bugs in series; one test each, plus the gate that repairs it.

/// Bug 1. `git rev-parse HEAD` on an unborn repo prints the literal `HEAD` to
/// **stdout** and reports the failure only in its exit status. `PROBE_SCRIPT`
/// discarded that status, so `parse_head` was handed `("master", "HEAD")` and built
/// `Branch { name: "master", sha: "HEAD" }` — a branch nobody has, at a sha that is
/// not a sha. `parse_head` now demands a real object name, so no probe, however
/// broken, can fabricate a checked-out branch again.
#[test]
fn parse_head_never_invents_a_branch_from_a_non_sha() {
    assert_eq!(parse_head("master", "HEAD"), HeadRef::Unborn);
    assert_eq!(parse_head("", "HEAD"), HeadRef::Unborn);
    assert_eq!(parse_head("main", ""), HeadRef::Unborn);
    assert_eq!(parse_head("main", "not-a-sha"), HeadRef::Unborn);
    // …while a real head still parses exactly as before.
    assert_eq!(
        parse_head("main", "abc123"),
        HeadRef::Branch {
            name: "main".into(),
            sha: "abc123".into()
        }
    );
    assert_eq!(
        parse_head("", "abc123"),
        HeadRef::Detached {
            sha: "abc123".into()
        }
    );
}

/// Bug 1, at the level that actually shipped. `parse_probe_block_tolerates_empty_
/// sections_and_a_non_repo` already asserted "unborn → `HeadRef::Unborn`", and passed
/// throughout — because it *synthesized* the block by hand with an empty sha section,
/// encoding the very assumption that was false. So: drive the real `PROBE_SCRIPT`
/// through a real `sh` against a real `git init`ed repo, and read what git actually
/// prints. This is the test that would have caught it.
#[cfg(unix)]
#[test]
fn probe_script_reports_a_real_unborn_repo_as_unborn() {
    if !git_available() {
        eprintln!("git not on PATH — skipping probe_script_reports_a_real_unborn_repo");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    crate::paths::command_no_window("git")
        .args(["init", "-q", "-b", "master", "."])
        .current_dir(dir)
        .output()
        .expect("git init");

    let snap = parse_probe_block(&run_sh(dir, PROBE_SCRIPT)).expect("parses");
    assert!(snap.is_repo, "a bare `git init` IS a repo…");
    assert_eq!(
        snap.head,
        Some(HeadRef::Unborn),
        "…but its HEAD is unborn — NOT `Branch {{ name: \"master\", sha: \"HEAD\" }}`"
    );
    assert!(snap.branches.is_empty() && snap.head_subject.is_none());
    // The batched remote probe and the per-command local one must agree about what
    // unborn looks like, or the bug simply moves to whichever path a peer takes.
    assert_eq!(
        snap.head,
        probe_per_command(&Peer::Local(dir.to_path_buf())).head
    );
    // And the whole point: this side is not seeded, so it is still pairable.
    assert!(!is_seeded(&snap));
}

/// Bug 2. The pairing gate keyed on `is_repo`, but `git init` is pairing's own first
/// step — so a seed that died after it flipped the gate shut behind itself. The dest
/// was a repo forever after, "exactly one side is a repo" never fired again, and the
/// steady-state path only ever moves refs (`update-ref`); it never positions HEAD or
/// checks out. Hence: objects and refs on the host, empty tree, forever.
#[test]
fn a_bare_git_init_is_not_seeded_and_stays_pairable() {
    let unborn = PeerSnapshot {
        is_repo: true,
        head: Some(HeadRef::Unborn),
        ..Default::default()
    };
    let seeded = PeerSnapshot {
        is_repo: true,
        head: Some(HeadRef::Branch {
            name: "transfer-learning".into(),
            sha: "a5b535d".into(),
        }),
        branches: vec![RefEntry {
            name: "transfer-learning".into(),
            sha: "a5b535d".into(),
        }],
        ..Default::default()
    };
    let absent = PeerSnapshot::default();

    assert!(!is_seeded(&absent), "not a repo");
    assert!(!is_seeded(&unborn), "a repo, but nothing is checked out");
    assert!(is_seeded(&seeded));
    assert!(is_seeded(&PeerSnapshot {
        is_repo: true,
        head: Some(HeadRef::Detached {
            sha: "abc123".into()
        }),
        ..Default::default()
    }));

    // The live case: mirror seeded, host `git init`ed and never checked out.
    assert_eq!(
        pair_plan(&seeded, &unborn),
        PairPlan::Pair {
            source_is_local: true
        },
        "the half-seeded host must be re-paired, not treated as a peer"
    );
    // Under the old `is_repo` gate this was `Sync` — which moved refs and never a
    // single file, which is exactly how it wedged.
    assert!(
        seeded.is_repo && unborn.is_repo,
        "…and both ARE repos, which is the trap"
    );

    assert_eq!(
        pair_plan(&seeded, &absent),
        PairPlan::Pair {
            source_is_local: true
        }
    );
    assert_eq!(
        pair_plan(&absent, &seeded),
        PairPlan::Pair {
            source_is_local: false
        }
    );
    assert_eq!(pair_plan(&seeded, &seeded), PairPlan::Sync);
    assert_eq!(pair_plan(&absent, &absent), PairPlan::Nothing);
    assert_eq!(
        pair_plan(&unborn, &unborn),
        PairPlan::Nothing,
        "nothing to move either way"
    );
}

/// The nastiest shape of bug 2: the refs DID land (the steady-state pass creates them
/// with `update-ref`), so the host looks populated by every measure except the only
/// one that matters — whether anything is checked out. A gate that looked at branches
/// rather than HEAD would call this seeded and wedge exactly as before.
#[test]
fn a_host_with_refs_but_no_checkout_is_still_unseeded() {
    let mirror = PeerSnapshot {
        is_repo: true,
        head: Some(HeadRef::Branch {
            name: "transfer-learning".into(),
            sha: "a5b535d".into(),
        }),
        branches: vec![RefEntry {
            name: "transfer-learning".into(),
            sha: "a5b535d".into(),
        }],
        ..Default::default()
    };
    // Every ref arrived; HEAD is still unborn. Empty working tree.
    let host = PeerSnapshot {
        is_repo: true,
        head: Some(HeadRef::Unborn),
        branches: vec![
            RefEntry {
                name: "transfer-learning".into(),
                sha: "a5b535d".into(),
            },
            RefEntry {
                name: "main".into(),
                sha: "64bd1c3".into(),
            },
        ],
        ..Default::default()
    };
    assert!(!is_seeded(&host), "refs are not a checkout");
    assert_eq!(
        pair_plan(&mirror, &host),
        PairPlan::Pair {
            source_is_local: true
        }
    );
}

/// Bug 3's other half: a half-seeded side must never be able to *early-out* of the
/// very pass that would repair it. `can_early_out` now gates on both sides being
/// seeded, not on both being repos.
#[test]
fn early_out_never_skips_a_half_seeded_side() {
    let prior = GitPeerState {
        status: SyncStatus::Synchronized,
        local_sig: Some("sig".into()),
        remote_sig: Some("sig".into()),
        ..Default::default()
    };
    assert!(
        can_early_out(&prior, "sig", "sig", true, false),
        "both seeded + green + unmoved → skip, as before"
    );
    assert!(
        !can_early_out(&prior, "sig", "sig", false, false),
        "a side that was never checked out must always be re-examined"
    );
}

/// The constraint on the repair: it must never cost the user a local file. When the
/// mirror is the unseeded side, pairing writes *it* — so the D3 collision guard is
/// what stands between `reset --hard` and the user's untracked work, and it must fail
/// CLOSED. A dest file that cannot be proven byte-identical to what the source would
/// write over it (`hash: None` — the hash could not be computed) is a conflict, which
/// blocks the pairing and raises the prompt instead of clobbering.
#[test]
fn pairing_into_the_mirror_refuses_to_clobber_unproven_local_files() {
    let source: HashMap<String, Fingerprint> = [
        (
            "README.md".to_string(),
            Fingerprint {
                size: 10,
                hash: Some("aaa".into()),
            },
        ),
        (
            "src/a.rs".to_string(),
            Fingerprint {
                size: 20,
                hash: Some("bbb".into()),
            },
        ),
    ]
    .into_iter()
    .collect();

    // Same path, same size, but the hash could not be established → NOT provably
    // identical → refused rather than overwritten.
    let unproven: HashMap<String, Fingerprint> = [(
        "README.md".to_string(),
        Fingerprint {
            size: 10,
            hash: None,
        },
    )]
    .into_iter()
    .collect();
    assert_eq!(
        pairing_collisions(&source, &unproven),
        vec!["README.md".to_string()]
    );

    // Differing content → refused.
    let differs: HashMap<String, Fingerprint> = [(
        "src/a.rs".to_string(),
        Fingerprint {
            size: 20,
            hash: Some("zzz".into()),
        },
    )]
    .into_iter()
    .collect();
    assert_eq!(
        pairing_collisions(&source, &differs),
        vec!["src/a.rs".to_string()]
    );

    // Byte-identical → adopting it is a no-op, so pairing proceeds (the intended
    // "the mirror already holds these files" path).
    let identical: HashMap<String, Fingerprint> = [(
        "README.md".to_string(),
        Fingerprint {
            size: 10,
            hash: Some("aaa".into()),
        },
    )]
    .into_iter()
    .collect();
    assert!(pairing_collisions(&source, &identical).is_empty());

    // A local file the source does not track is not a collision at all — and
    // `reset --hard` never removes untracked paths, so it survives the pairing.
    let untracked: HashMap<String, Fingerprint> = [(
        "data/big.npz".to_string(),
        Fingerprint {
            size: 999,
            hash: None,
        },
    )]
    .into_iter()
    .collect();
    assert!(pairing_collisions(&source, &untracked).is_empty());
}
