use super::*;
use crate::test_util::init_repo;
use std::fs;

/// Tests skip gracefully when `git` isn't on PATH.
fn git_available() -> bool {
    super::git_available_blocking()
}

/// The import dialog's origin read answers for the folder's own repository
/// only — a plain folder inside a hosted checkout must not borrow its origin.
#[test]
fn a_folder_origin_is_read_only_from_the_folders_own_repo() {
    if !git_available() {
        eprintln!("git not on PATH — skipping a_folder_origin_is_read_only_from_the_folders_own_repo");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let repo = tmp.path().join("repo");
    let inner = repo.join("inner");
    fs::create_dir_all(&inner).unwrap();
    init_repo(&repo);
    assert_eq!(git_folder_origin_blocking(&repo), None, "a repo without origin");

    let url = "git@github.com:owner/repo.git";
    let ok = crate::paths::command_no_window("git")
        .args(["remote", "add", "origin", url])
        .current_dir(&repo)
        .status()
        .expect("git runs")
        .success();
    assert!(ok);
    assert_eq!(git_folder_origin_blocking(&repo).as_deref(), Some(url));
    assert_eq!(git_folder_origin_blocking(&inner), None, "an enclosing repo's origin");
    assert_eq!(git_folder_origin_blocking(&tmp.path().join("missing")), None);
}

/// #2347: the remote exclude script appends the rule once to a plain
/// `info/exclude`, and leaves a linked `exclude` or `info/` — and what
/// they point at — alone.
#[cfg(unix)]
#[test]
fn the_remote_exclude_script_appends_once_and_never_through_a_link() {
    if !git_available() {
        eprintln!("git not on PATH — skipping the_remote_exclude_script_appends_once_and_never_through_a_link");
        return;
    }
    const RULE: &str = crate::brand::PROJECT_DIR_EXCLUDE_RULE;
    let run_script = |dir: &Path| {
        let out = std::process::Command::new("sh")
            .args(["-c", &remote_exclude_script()])
            .current_dir(dir)
            .output()
            .expect("sh runs");
        out.status.success()
    };
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("plain");
    fs::create_dir_all(&dir).expect("mkdir");
    init_repo(&dir);
    let exclude = dir.join(".git").join("info").join("exclude");
    fs::write(&exclude, "*.log").expect("write");
    assert!(run_script(&dir));
    assert!(run_script(&dir));
    let text = fs::read_to_string(&exclude).expect("exclude");
    assert_eq!(text.lines().filter(|l| *l == RULE).count(), 1, "{text}");
    assert!(text.starts_with("*.log"), "{text}");

    let victim = tmp.path().join("profile");
    fs::write(&victim, "export PATH\n").expect("write");
    fs::remove_file(&exclude).expect("rm");
    std::os::unix::fs::symlink(&victim, &exclude).expect("symlink");
    assert!(!run_script(&dir));
    assert_eq!(fs::read_to_string(&victim).expect("victim"), "export PATH\n");

    let elsewhere = tmp.path().join("elsewhere");
    fs::create_dir_all(&elsewhere).expect("mkdir");
    fs::remove_dir_all(dir.join(".git").join("info")).expect("rm info");
    std::os::unix::fs::symlink(&elsewhere, dir.join(".git").join("info")).expect("symlink");
    assert!(!run_script(&dir));
    assert_eq!(fs::read_dir(&elsewhere).expect("ls").count(), 0);
}

#[test]
fn status_reports_a_tag_on_head_so_release_hides() {
    if !git_available() {
        eprintln!("git not on PATH — skipping status_reports_a_tag_on_head_so_release_hides");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);
    let run = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git")
    };
    let probe = || git_status_probe(dir.to_string_lossy().into_owned(), true).expect("status");
    fs::write(dir.join("f.txt"), "a\n").expect("write");
    run(&["add", "f.txt"]);
    run(&["commit", "-m", "one"]);
    run(&["tag", "-a", "v0.1.0", "-m", "v0.1.0"]);
    // No remote, no Release button: not probed.
    assert!(!probe().head_tagged);
    run(&["remote", "add", "origin", "https://git.example.org/owner/repo.git"]);
    assert!(probe().head_tagged);
    // A new commit past the tag is releasable again.
    fs::write(dir.join("f.txt"), "b\n").expect("write");
    run(&["commit", "-am", "two"]);
    assert!(!probe().head_tagged);
}

// ── Anonymous visibility probe ───────────────────────────────────────────

#[test]
fn https_probe_url_normalizes_every_clone_form() {
    // scp-like and ssh:// both name the https address of the same repo.
    assert_eq!(
        https_probe_url("git@github.com:owner/repo.git").as_deref(),
        Some("https://github.com/owner/repo.git")
    );
    assert_eq!(
        https_probe_url("ssh://git@gitlab.example.org:2222/group/sub/repo.git").as_deref(),
        Some("https://gitlab.example.org/group/sub/repo.git")
    );
    // Userinfo is dropped: the probe has to be anonymous to mean anything.
    // A reserved example host, so the privacy scan does not read the
    // `<name>@<host>` in a clone URL as somebody's address.
    assert_eq!(
        https_probe_url("https://user@git.example.org/owner/repo").as_deref(),
        Some("https://git.example.org/owner/repo")
    );
    assert_eq!(
        https_probe_url("https://github.com/owner/repo.git").as_deref(),
        Some("https://github.com/owner/repo.git")
    );
    // Nothing repo-shaped to probe.
    assert_eq!(https_probe_url(""), None);
    assert_eq!(https_probe_url("https://github.com/"), None);
    assert_eq!(https_probe_url("git@github.com:"), None);
}

// ── Repo config hardening (Group O #151) ─────────────────────────────────

#[test]
fn hardened_git_args_pins_config_ahead_of_the_subcommand() {
    let args = hardened_git_args(&["status", "--porcelain"]);
    // `-c k=v` pairs must precede the subcommand, or git parses them as its
    // arguments instead of its own options.
    assert_eq!(
        &args[..6],
        &[
            "-c",
            "core.fsmonitor=false",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "safe.bareRepository=explicit"
        ]
    );
    // Then the output-shape pins, each as its own `-c` pair.
    let output = 6 + OUTPUT_CONFIG.len() * 2;
    let pairs: Vec<String> = OUTPUT_CONFIG.iter().flat_map(|kv| ["-c".to_string(), kv.to_string()]).collect();
    assert_eq!(&args[6..output], &pairs[..]);
    // Hooks off by default (#862): a read can fire `post-index-change`.
    assert_eq!(&args[output..output + 2], &["-c", "core.hooksPath="]);
    assert_eq!(&args[output + 2..], &["status", "--porcelain"]);
    // A subcommand that takes no diff-driver flags gets none.
    assert!(!args.iter().any(|a| a == "--no-ext-diff"));
}

#[test]
fn hardened_git_args_adds_diff_driver_flags_after_the_subcommand_only() {
    for sub in DIFF_DRIVER_CMDS {
        let args = hardened_git_args(&[sub, "--", "a file.txt"]);
        let at = args
            .iter()
            .position(|a| a == sub)
            .expect("subcommand present");
        assert_eq!(args[at + 1], "--no-ext-diff");
        assert_eq!(args[at + 2], "--no-textconv");
        // Everything the caller passed keeps its order behind them — the
        // pathspec separator must not end up before the flags.
        assert_eq!(&args[at + 3..], &["--", "a file.txt"]);
    }
    // Owned args (the `Vec<String>` call sites) go through the same builder.
    let owned = vec!["log".to_string(), "--numstat".to_string()];
    let pinned = (HARDENED_CONFIG.len() + OUTPUT_CONFIG.len() + NO_HOOKS_CONFIG.len()) * 2;
    assert_eq!(
        hardened_git_args(&owned)[pinned..],
        ["log", "--no-ext-diff", "--no-textconv", "--numstat"]
    );
    // No subcommand at all is just the pinned config (no panic, no stray flag).
    let empty: [&str; 0] = [];
    assert_eq!(hardened_git_args(&empty).len(), pinned);
}

/// The escape this hardening exists for: a project container mounts the
/// project dir — `.git` included — writable, so a contained agent can write
/// `.git/config`, and git runs what it names **on the host**. Asserted in both
/// directions, so the test fails if the hardening is removed *and* if git ever
/// stops honouring the config the test plants (which would make it vacuous).
#[cfg(unix)]
#[test]
fn a_repos_own_config_cannot_run_a_program_on_the_host() {
    if !git_available() {
        eprintln!(
            "git not on PATH — skipping a_repos_own_config_cannot_run_a_program_on_the_host"
        );
        return;
    }
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);
    let run = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git")
    };
    fs::write(dir.join("f.txt"), "a\n").expect("write");
    run(&["add", "f.txt"]);
    run(&["commit", "-m", "init"]);
    fs::write(dir.join("f.txt"), "b\n").expect("modify");

    // The payload a hostile `.git/config` would name, and the mark it leaves.
    let marker = dir.join("executed");
    let payload = dir.join("payload.sh");
    fs::write(
        &payload,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .expect("write");
    fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("chmod");
    let p = payload.to_str().expect("utf-8 path");
    run(&["config", "core.fsmonitor", p]);
    run(&["config", "diff.external", p]);

    let project_dir = dir.to_str().expect("utf-8 path");
    // `core.fsmonitor` on a plain status — the polled read the file tree makes.
    run(&["status", "--porcelain"]);
    assert!(
        marker.exists(),
        "setup is stale: git no longer runs core.fsmonitor on status"
    );
    fs::remove_file(&marker).expect("clear marker");
    run_git(None, project_dir, &["status", "--porcelain"]).expect("hardened status");
    assert!(!marker.exists(), "core.fsmonitor executed through run_git");

    // `diff.external` on a diff — the viewer's and the file-status poll's path.
    run(&["diff"]);
    assert!(
        marker.exists(),
        "setup is stale: git no longer runs diff.external"
    );
    fs::remove_file(&marker).expect("clear marker");
    let out = run_git(None, project_dir, &["diff"]).expect("hardened diff");
    assert!(!marker.exists(), "diff.external executed through run_git");
    // …and the hardening must leave a working diff behind, not a dead one.
    assert!(
        out.status.success(),
        "hardened diff failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("+b"));
}

#[test]
fn config_denylist_matches_the_named_shapes_and_nothing_else() {
    // The residual this closes: an attacker-chosen driver name.
    assert!(is_denylisted_config_key("filter.lfs.clean"));
    assert!(is_denylisted_config_key("filter.anything-at-all.clean"));
    assert!(is_denylisted_config_key("filter.x.smudge"));
    assert!(is_denylisted_config_key("filter.x.process"));
    assert!(is_denylisted_config_key("diff.mydriver.textconv"));
    assert!(is_denylisted_config_key("diff.mydriver.command"));
    // Case: git lowercases section/key itself; the checker must too.
    assert!(is_denylisted_config_key("Filter.Weird.Clean"));
    // The bypass this sanitizer would otherwise have: laundering a
    // denylisted key through a file it never reads.
    assert!(is_denylisted_config_key("include.path"));
    assert!(is_denylisted_config_key("includeif.gitdir:/x/.path"));

    // Adjacent, harmless keys must survive — this is a denylist, not a
    // section-wide ban.
    assert!(!is_denylisted_config_key("filter.lfs.required"));
    assert!(!is_denylisted_config_key("user.email"));
    assert!(!is_denylisted_config_key("user.name"));
    assert!(!is_denylisted_config_key("core.fsmonitor"));
    assert!(!is_denylisted_config_key("core.hookspath"));
    assert!(!is_denylisted_config_key("remote.origin.url"));
    assert!(!is_denylisted_config_key("branch.main.remote"));
    // Deliberately not on the list at all (see the doc comment).
    assert!(!is_denylisted_config_key("alias.status"));
    assert!(!is_denylisted_config_key("credential.helper"));
}

/// The headline residual named in Group O #151: a repo-local
/// `filter.<driver>.clean` bound by an in-tree `.gitattributes`, run on
/// `git add`. The driver name (`evil`, here) is exactly what a fixed `-c`
/// override cannot cover; [`sanitize_repo_git_config`] must, because it
/// matches by key *shape* instead of by exact name.
#[cfg(unix)]
#[test]
fn sanitize_stops_a_repo_local_filter_clean_driver() {
    if !git_available() {
        eprintln!("git not on PATH — skipping sanitize_stops_a_repo_local_filter_clean_driver");
        return;
    }
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);
    let run = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git")
    };

    let marker = dir.join("executed");
    let payload = dir.join("payload.sh");
    fs::write(
        &payload,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .expect("write");
    fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("chmod");
    let p = payload.to_str().expect("utf-8 path");

    run(&["config", "filter.evil.clean", p]);
    fs::write(dir.join(".gitattributes"), "secret.txt filter=evil\n").expect("attrs");
    fs::write(dir.join("secret.txt"), "a\n").expect("write");

    run(&["add", "secret.txt"]);
    assert!(
        marker.exists(),
        "setup is stale: git no longer runs a repo-local filter.clean"
    );
    run(&["rm", "--cached", "-f", "secret.txt"]);
    fs::remove_file(&marker).expect("clear marker");

    let project_dir = dir.to_str().expect("utf-8 path");
    run_git(None, project_dir, &["add", "secret.txt"]).expect("hardened add");
    assert!(
        !marker.exists(),
        "filter.evil.clean executed through run_git"
    );
}

/// The bypass a filter/diff-only denylist would otherwise have: an
/// attacker doesn't need the payload in `.git/config` itself, only an
/// `include.path` pointing at a second, ordinary file this sanitizer
/// would never look at — laundering the same `filter.<driver>.clean`
/// through a file `git config --file X --list` (no `--includes` by
/// default) never sees. Closed by denying `include.path` itself, so the
/// real, include-following git invocation that follows never gets there.
#[cfg(unix)]
#[test]
fn sanitize_closes_the_include_laundering_bypass() {
    if !git_available() {
        eprintln!("git not on PATH — skipping sanitize_closes_the_include_laundering_bypass");
        return;
    }
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);
    let run = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git")
    };

    let marker = dir.join("executed");
    let payload = dir.join("payload.sh");
    fs::write(
        &payload,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .expect("write");
    fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("chmod");
    let p = payload.to_str().expect("utf-8 path");

    // The laundering file: never touched directly by the sanitizer.
    fs::write(
        dir.join("laundered.gitconfig"),
        format!("[filter \"evil\"]\n\tclean = {p}\n"),
    )
    .expect("write laundering file");
    run(&["config", "--add", "include.path", "../laundered.gitconfig"]);
    fs::write(dir.join(".gitattributes"), "secret.txt filter=evil\n").expect("attrs");
    fs::write(dir.join("secret.txt"), "a\n").expect("write");

    // Setup check: the include genuinely reaches the filter today.
    run(&["add", "secret.txt"]);
    assert!(
        marker.exists(),
        "setup is stale: the include-laundered filter never ran"
    );
    // `rm --cached -f` re-runs the clean filter too (to compare working-tree
    // content against the index) — clear the marker *after* this, not before,
    // or the next check would pass on a marker this line left behind.
    run(&["rm", "--cached", "-f", "secret.txt"]);
    fs::remove_file(&marker).expect("clear marker");

    let project_dir = dir.to_str().expect("utf-8 path");
    run_git(None, project_dir, &["add", "secret.txt"]).expect("hardened add");
    assert!(
        !marker.exists(),
        "include-laundered filter.evil.clean executed through run_git"
    );

    // The strip must not be so blunt it takes the whole file with it.
    let email = crate::paths::command_no_window("git")
        .args([
            "config",
            "--file",
            &dir.join(".git/config").to_string_lossy(),
            "user.email",
        ])
        .output()
        .expect("read back user.email");
    assert_eq!(
        String::from_utf8_lossy(&email.stdout).trim(),
        "test@example.com"
    );
}

#[test]
fn git_diff_file_shows_modified_hunk() {
    if !git_available() {
        eprintln!("git not on PATH — skipping git_diff_file_shows_modified_hunk");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);

    let file = dir.join("note.txt");
    fs::write(&file, "first line\nsecond line\n").expect("write");
    let add_ok = crate::paths::command_no_window("git")
        .args(["add", "note.txt"])
        .current_dir(dir)
        .output()
        .expect("add runs")
        .status
        .success();
    assert!(add_ok, "git add failed");
    let real_commit = crate::paths::command_no_window("git")
        .args(["commit", "-m", "init"])
        .current_dir(dir)
        .output()
        .expect("commit runs")
        .status
        .success();
    assert!(real_commit, "git commit failed");

    // Modify the file so a tracked diff exists.
    fs::write(&file, "first line\nCHANGED line\n").expect("rewrite");

    let diff =
        git_diff_file_blocking(dir.to_string_lossy().to_string(), "note.txt".to_string())
            .expect("git_diff_file should succeed");
    assert!(diff.contains("@@"), "expected a hunk marker, got: {diff}");
    assert!(
        diff.contains("CHANGED line"),
        "expected changed line, got: {diff}"
    );
}

#[test]
fn git_diff_file_unchanged_tracked_file_is_empty() {
    if !git_available() {
        eprintln!("git not on PATH — skipping git_diff_file_unchanged_tracked_file_is_empty");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);

    // Committed and untouched: no diff, not the whole file as added.
    fs::write(dir.join("kept.txt"), "kept\n").expect("write");
    for args in [&["add", "kept.txt"][..], &["commit", "-m", "init"][..]] {
        let ok = crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs")
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    }

    let diff =
        git_diff_file_blocking(dir.to_string_lossy().to_string(), "kept.txt".to_string())
            .expect("git_diff_file should succeed");
    assert!(diff.is_empty(), "expected no diff, got: {diff}");
}

#[test]
fn git_diff_file_untracked_uses_no_index_fallback() {
    if !git_available() {
        eprintln!("git not on PATH — skipping git_diff_file_untracked_uses_no_index_fallback");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);

    // Brand-new untracked file: the tracked `git diff` is empty, so the
    // command must fall back to `--no-index` and show it as added.
    let file = dir.join("fresh.txt");
    fs::write(&file, "brand new content\nanother line\n").expect("write");

    let diff =
        git_diff_file_blocking(dir.to_string_lossy().to_string(), "fresh.txt".to_string())
            .expect("git_diff_file should succeed via fallback");
    assert!(!diff.is_empty(), "fallback diff should be non-empty");
    assert!(
        diff.contains("brand new content"),
        "expected file content in fallback diff, got: {diff}"
    );
}

#[test]
fn parse_blame_porcelain_maps_lines_and_caches_metadata() {
    // Two commits: `aaa…` owns lines 1 & 3 (its metadata appears once, on
    // line 1, and is reused for line 3), `bbb…` owns line 2, and line 4 is
    // uncommitted (all-zeros sha, "Not Committed Yet").
    let sample = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1000000000
author-tz +0000
summary first commit
filename note.txt
\tline one
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2 1
author Bob
author-mail <bob@example.com>
author-time 1600000000
author-tz +0000
summary second commit
filename note.txt
\tline two
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 3 1
filename note.txt
\tline three
0000000000000000000000000000000000000000 4 4 1
author Not Committed Yet
author-mail <not.committed.yet>
author-time 1700000000
author-tz +0000
summary Version of note.txt from note.txt
filename note.txt
\tline four
";
    let blame = parse_blame_porcelain(sample);
    assert_eq!(blame.len(), 4, "one entry per source line");

    assert_eq!(blame[0].line_no, 1);
    assert_eq!(blame[0].short, "aaaaaaaa");
    assert_eq!(blame[0].author, "Alice");
    assert_eq!(blame[0].author_time, 1_000_000_000);
    assert_eq!(blame[0].summary, "first commit");

    assert_eq!(blame[1].line_no, 2);
    assert_eq!(blame[1].author, "Bob");
    assert_eq!(blame[1].author_time, 1_600_000_000);

    // Line 3 reuses `aaa…`'s cached metadata even though it wasn't repeated.
    assert_eq!(blame[2].line_no, 3);
    assert_eq!(blame[2].hash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert_eq!(blame[2].author, "Alice");
    assert_eq!(blame[2].summary, "first commit");

    // Line 4 is uncommitted.
    assert_eq!(blame[3].line_no, 4);
    assert_eq!(blame[3].hash, "0000000000000000000000000000000000000000");
    assert_eq!(blame[3].author, "Not Committed Yet");
}

#[test]
fn git_blame_blocking_attributes_lines() {
    if !git_available() {
        eprintln!("git not on PATH — skipping git_blame_blocking_attributes_lines");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);

    let file = dir.join("note.txt");
    fs::write(&file, "first line\nsecond line\n").expect("write");
    for args in [&["add", "note.txt"][..], &["commit", "-m", "init"][..]] {
        let ok = crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs")
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    }

    let blame = git_blame_blocking(dir.to_string_lossy().to_string(), "note.txt".to_string())
        .expect("git_blame should succeed");
    assert_eq!(blame.len(), 2, "two committed lines");
    assert_eq!(blame[0].line_no, 1);
    assert_eq!(blame[0].author, "Test User");
    assert_ne!(blame[0].hash, "0000000000000000000000000000000000000000");
}

#[test]
fn git_blame_blocking_empty_for_non_repo() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    // No `git init` → local_non_repo short-circuits to an empty vec.
    let blame = git_blame_blocking(
        dir.to_string_lossy().to_string(),
        "whatever.txt".to_string(),
    )
    .expect("non-repo blame is empty, not an error");
    assert!(blame.is_empty());
}

#[test]
fn ignored_child_does_not_mark_whole_folder_ignored() {
    if !git_available() {
        eprintln!(
            "git not on PATH — skipping ignored_child_does_not_mark_whole_folder_ignored"
        );
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);

    // `partial/` has one ignored file and one tracked file → the folder
    // itself is NOT ignored. `whole/` is ignored in its entirety.
    fs::write(dir.join(".gitignore"), "partial/ignored.log\nwhole/\n")
        .expect("write .gitignore");
    fs::create_dir(dir.join("partial")).expect("mkdir partial");
    fs::write(dir.join("partial/ignored.log"), "log\n").expect("write log");
    fs::write(dir.join("partial/keep.txt"), "keep\n").expect("write keep");
    fs::create_dir(dir.join("whole")).expect("mkdir whole");
    fs::write(dir.join("whole/a.txt"), "a\n").expect("write a");

    let statuses = git_file_statuses_blocking(dir.to_string_lossy().to_string(), String::new())
        .expect("git_file_statuses should succeed");

    // A folder with only some ignored content stays out of the ignored bucket.
    assert_ne!(
        statuses.get("partial").map(String::as_str),
        Some("ignored"),
        "partial/ must not be marked ignored (got {:?})",
        statuses.get("partial")
    );
    // A wholly-ignored folder is still reported as ignored.
    assert_eq!(
        statuses.get("whole").map(String::as_str),
        Some("ignored"),
        "whole/ should be ignored (got {:?})",
        statuses.get("whole")
    );

    // Navigating INTO the wholly-ignored folder must still report its own
    // children as ignored, not silently come back empty (the bug this
    // test guards: plain `--ignored` collapses `whole/` to one line and
    // never descends into it).
    let inner =
        git_file_statuses_blocking(dir.to_string_lossy().to_string(), "whole".to_string())
            .expect("git_file_statuses on whole/ should succeed");
    assert_eq!(
        inner.get("a.txt").map(String::as_str),
        Some("ignored"),
        "whole/a.txt should be reported as ignored when listing whole/ (got {:?})",
        inner.get("a.txt")
    );
}

#[test]
fn ignored_entries_are_reported_when_git_config_hides_untracked_files() {
    if !git_available() {
        eprintln!("git not on PATH — skipping ignored_entries_are_reported_when_git_config_hides_untracked_files");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);

    fs::write(dir.join(".gitignore"), "cache/\n").expect("write .gitignore");
    fs::create_dir(dir.join("cache")).expect("mkdir cache");
    fs::write(dir.join("cache/data.bin"), "ignored\n").expect("write ignored file");
    let configured = crate::paths::command_no_window("git")
        .args(["config", "status.showUntrackedFiles", "no"])
        .current_dir(dir)
        .output()
        .expect("git config should run")
        .status
        .success();
    assert!(configured, "git config failed");

    let statuses = git_file_statuses_blocking(dir.to_string_lossy().to_string(), String::new())
        .expect("git_file_statuses should override the user's untracked-files setting");

    assert_eq!(statuses.get("cache").map(String::as_str), Some("ignored"));
}

/// An ignored folder with no file in it (`emails/` before its first
/// attachment) gets no porcelain line, yet must still land in the
/// gitignored section; an empty folder git doesn't ignore stays unmarked.
#[test]
fn empty_ignored_folders_are_reported_as_ignored() {
    if !git_available() {
        eprintln!("git not on PATH — skipping empty_ignored_folders_are_reported_as_ignored");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);

    fs::write(dir.join(".gitignore"), "emails/\nruns/\n").expect("write .gitignore");
    fs::create_dir(dir.join("emails")).expect("mkdir emails");
    fs::create_dir_all(dir.join("runs").join("a").join("b")).expect("mkdir runs");
    fs::create_dir(dir.join("blank")).expect("mkdir blank");
    fs::create_dir_all(dir.join("src").join("emails")).expect("mkdir src/emails");

    let root = dir.to_string_lossy().to_string();
    let statuses = git_file_statuses_blocking(root.clone(), String::new()).expect("statuses");
    assert_eq!(statuses.get("emails").map(String::as_str), Some("ignored"));
    assert_eq!(statuses.get("runs").map(String::as_str), Some("ignored"));
    assert_eq!(statuses.get("blank"), None);
    assert_eq!(statuses.get("src"), None);

    let inner = git_file_statuses_blocking(root, "src".to_string()).expect("statuses in src");
    assert_eq!(inner.get("emails").map(String::as_str), Some("ignored"));
}

#[test]
fn remote_namesake_prefers_origin_and_needs_the_whole_branch_name() {
    let refs = "refs/remotes/fork/develop\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/develop\nrefs/remotes/origin/main\n";
    assert_eq!(pick_remote_namesake(refs, "develop").as_deref(), Some("refs/remotes/origin/develop"));
    assert_eq!(
        pick_remote_namesake("refs/remotes/fork/develop\n", "develop").as_deref(),
        Some("refs/remotes/fork/develop")
    );
    // `feature/develop` is not `develop`, and a bare `refs/remotes/develop`
    // names no remote at all.
    assert_eq!(pick_remote_namesake("refs/remotes/origin/feature-develop\n", "develop"), None);
    assert_eq!(pick_remote_namesake("refs/remotes/develop\n", "develop"), None);
    assert_eq!(
        pick_remote_namesake("refs/remotes/origin/feature/x\n", "feature/x").as_deref(),
        Some("refs/remotes/origin/feature/x")
    );
}

#[test]
fn unpushed_commits_count_without_a_configured_upstream() {
    if !git_available() {
        eprintln!("git not on PATH — skipping unpushed_commits_count_without_a_configured_upstream");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let remote = tmp.path().join("remote.git");
    let dir = tmp.path().join("work");
    fs::create_dir(&dir).expect("mkdir work");
    let git = |cwd: &Path, args: &[&str]| {
        let ok = crate::paths::command_no_window("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git should run")
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    };
    git(tmp.path(), &["init", "--bare", "remote.git"]);
    init_repo(&dir);
    git(&dir, &["checkout", "-b", "develop"]);
    fs::write(dir.join("pushed.txt"), "a\n").expect("write");
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-m", "pushed"]);
    git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
    // An explicit refspec and no `-u`: the branch is on the remote, but
    // `@{u}` stays unset.
    git(&dir, &["push", "origin", "develop:develop"]);
    fs::create_dir(dir.join("src")).expect("mkdir src");
    fs::write(dir.join("src/new.txt"), "b\n").expect("write");
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-m", "local only"]);

    let d = dir.to_string_lossy().to_string();
    let statuses = git_file_statuses_blocking(d.clone(), String::new()).expect("statuses");
    assert_eq!(statuses.get("src").map(String::as_str), Some("unpushed"));
    assert_eq!(statuses.get("pushed.txt"), None);
    assert_eq!(git_unpushed_commits_blocking(d).expect("unpushed").len(), 1);
}

#[test]
fn a_status_header_names_a_live_upstream() {
    assert!(header_has_live_upstream("main...origin/main"));
    assert!(header_has_live_upstream("main...origin/main [ahead 2]"));
    assert!(header_has_live_upstream("feature/x...origin/feature/x [ahead 1, behind 3]"));
    assert!(!header_has_live_upstream("main"));
    assert!(!header_has_live_upstream("HEAD (no branch)"));
    assert!(!header_has_live_upstream("No commits yet on main"));
    assert!(!header_has_live_upstream("main...origin/main [gone]"));
}

/// Perf plan §3.4: the dot probe reads a tracked branch's unpushed count
/// off the status header (no `rev-parse @{u}` + `log` spawns) and agrees
/// with the full lookup; an untracked branch still gets the namesake one.
#[test]
fn the_dot_probe_reads_unpushed_off_the_status_header() {
    if !git_available() {
        eprintln!("git not on PATH — skipping the_dot_probe_reads_unpushed_off_the_status_header");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("work");
    fs::create_dir(&dir).expect("mkdir work");
    let git = |cwd: &Path, args: &[&str]| {
        let ok = crate::paths::command_no_window("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git should run")
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    };
    git(tmp.path(), &["init", "--bare", "remote.git"]);
    init_repo(&dir);
    git(&dir, &["checkout", "-b", "develop"]);
    fs::write(dir.join("a.txt"), "a\n").expect("write");
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-m", "first"]);
    let remote = tmp.path().join("remote.git");
    git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
    let d = dir.to_string_lossy().to_string();

    // Pushed without `-u`: no upstream, the namesake lookup answers.
    git(&dir, &["push", "origin", "develop:develop"]);
    git(&dir, &["commit", "--allow-empty", "-m", "local one"]);
    let status = git_status_probe(d.clone(), false).expect("status");
    assert_eq!(status.upstream_ahead, None);
    assert_eq!(unpushed_count(&status, d.clone()), 1);

    // Tracking: the header carries it, and it matches `log @{u}..`.
    git(&dir, &["branch", "--set-upstream-to", "origin/develop"]);
    git(&dir, &["commit", "--allow-empty", "-m", "local two"]);
    let status = git_status_probe(d.clone(), false).expect("status");
    assert_eq!(status.upstream_ahead, Some(2));
    assert_eq!(unpushed_count(&status, d.clone()), 2);
    assert_eq!(git_unpushed_commits_blocking(d.clone()).expect("unpushed").len(), 2);

    git(&dir, &["push", "origin", "develop"]);
    let status = git_status_probe(d.clone(), false).expect("status");
    assert_eq!(status.upstream_ahead, Some(0));
    assert_eq!(unpushed_count(&status, d), 0);
}

#[test]
fn push_sets_the_upstream_of_a_branch_that_has_none() {
    if !git_available() {
        eprintln!("git not on PATH — skipping push_sets_the_upstream_of_a_branch_that_has_none");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let remote = tmp.path().join("remote.git");
    let dir = tmp.path().join("work");
    fs::create_dir(&dir).expect("mkdir work");
    let git = |cwd: &Path, args: &[&str]| {
        crate::paths::command_no_window("git").args(args).current_dir(cwd).output().expect("git should run")
    };
    assert!(git(tmp.path(), &["init", "--bare", "remote.git"]).status.success());
    init_repo(&dir);
    assert!(git(&dir, &["checkout", "-b", "develop"]).status.success());
    fs::write(dir.join("a.txt"), "a\n").expect("write");
    assert!(git(&dir, &["add", "."]).status.success());
    assert!(git(&dir, &["commit", "-m", "first"]).status.success());
    assert!(git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]).status.success());

    let d = dir.to_string_lossy().to_string();
    git_push_blocking(d, None).expect("push without an upstream");
    let upstream = git(&dir, &["rev-parse", "--abbrev-ref", "@{u}"]);
    assert_eq!(String::from_utf8_lossy(&upstream.stdout).trim(), "origin/develop");
    let pushed = git(&remote, &["rev-parse", "develop"]);
    let head = git(&dir, &["rev-parse", "HEAD"]);
    assert_eq!(pushed.stdout, head.stdout);
}

#[test]
fn a_push_a_pre_push_hook_re_pushed_itself_is_not_an_error() {
    if !git_available() {
        eprintln!("git not on PATH — skipping a_push_a_pre_push_hook_re_pushed_itself_is_not_an_error");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let remote = tmp.path().join("remote.git");
    let dir = tmp.path().join("work");
    fs::create_dir(&dir).expect("mkdir work");
    let git = |cwd: &Path, args: &[&str]| {
        crate::paths::command_no_window("git").args(args).current_dir(cwd).output().expect("git should run")
    };
    assert!(git(tmp.path(), &["init", "--bare", "remote.git"]).status.success());
    init_repo(&dir);
    assert!(git(&dir, &["checkout", "-b", "develop"]).status.success());
    fs::write(dir.join("a.txt"), "a\n").expect("write");
    assert!(git(&dir, &["add", "."]).status.success());
    assert!(git(&dir, &["commit", "-m", "first"]).status.success());
    assert!(git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]).status.success());
    // Pushed once without `-u`: every push so far went through the hook's
    // re-push, so git never recorded an upstream.
    assert!(git(&dir, &["push", "origin", "develop"]).status.success());
    assert!(!git(&dir, &["rev-parse", "--verify", "-q", "@{u}"]).status.success());
    fs::write(dir.join("a.txt"), "b\n").expect("write");
    assert!(git(&dir, &["commit", "-am", "second"]).status.success());

    // What the version-bump hook leaves behind: HEAD re-pushed by the
    // hook, the original push aborted with a failure and hook chatter.
    let before = pushed_tip(&dir);
    let aborted = git(&dir, &["rev-parse", "--verify", "-q", "no-such-ref"]);
    assert!(!aborted.status.success());
    assert!(push_outcome(&aborted, Some(&dir), before.clone()).is_err(), "nothing landed: a real failure");
    assert!(git(&dir, &["push", "origin", "HEAD"]).status.success());
    assert!(push_outcome(&aborted, Some(&dir), before).is_ok(), "HEAD landed on the remote");
    let upstream = git(&dir, &["rev-parse", "--abbrev-ref", "@{u}"]);
    assert_eq!(String::from_utf8_lossy(&upstream.stdout).trim(), "origin/develop", "the landed push records the upstream");
    // A failure with the tracking ref already at HEAD is not salvaged.
    let now = pushed_tip(&dir);
    assert!(push_outcome(&aborted, Some(&dir), now).is_err());
}

#[test]
fn filter_commits_matches_hash_subject_author_and_refs() {
    let mk = |hash: &str, subject: &str, author: &str, refs: &str| GitCommit {
        hash: hash.into(),
        short: hash[..4].into(),
        subject: subject.into(),
        author: author.into(),
        date: String::new(),
        refs: refs.into(),
        is_head: false,
        parents: vec![],
    };
    let commits = vec![
        mk("abcd1234", "Fix the Parser", "Ann", "HEAD -> develop"),
        mk("ffff0000", "Add tests", "Bob", "tag: v1.0"),
        mk("12345678", "Docs", "Parsley", ""),
    ];
    let subjects = |needle: &str, limit| {
        filter_commits(commits.clone(), needle, limit)
            .into_iter()
            .map(|c| c.subject)
            .collect::<Vec<_>>()
    };
    assert_eq!(subjects("parser", 10), vec!["Fix the Parser"]);
    assert_eq!(subjects("pars", 10), vec!["Fix the Parser", "Docs"]);
    assert_eq!(subjects("pars", 1), vec!["Fix the Parser"]);
    assert_eq!(subjects("abcd12", 10), vec!["Fix the Parser"]);
    assert_eq!(subjects("v1.0", 10), vec!["Add tests"]);
    assert_eq!(subjects("bob", 10), vec!["Add tests"]);
    assert!(subjects("nothing", 10).is_empty());
}

#[test]
fn git_log_pages_the_history_with_skip() {
    if !git_available() {
        eprintln!("git not on PATH — skipping git_log_pages_the_history_with_skip");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);
    let run = |args: &[&str]| {
        let ok = crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git command should run")
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    };
    for i in 0..5 {
        fs::write(dir.join("f.txt"), format!("{i}\n")).expect("write");
        run(&["add", "f.txt"]);
        run(&["commit", "-m", &format!("c{i}")]);
    }
    let project_dir = dir.to_string_lossy().to_string();
    let page = |limit, skip| {
        git_log_blocking(project_dir.clone(), Some(limit), Some(skip))
            .expect("git_log should read this repo")
            .into_iter()
            .map(|c| c.subject)
            .collect::<Vec<_>>()
    };

    // Newest first, and `skip` steps back from HEAD rather than re-serving
    // the first page — the whole point of paging the list in.
    assert_eq!(page(2, 0), vec!["c4", "c3"]);
    assert_eq!(page(2, 2), vec!["c2", "c1"]);
    assert_eq!(page(2, 4), vec!["c0"]);
    // Past the root commit the log is simply empty — not an error, which is
    // what tells the panel there is nothing more to page in.
    assert!(page(2, 6).is_empty());
    // No `skip` is the old call, unchanged.
    assert_eq!(
        git_log_blocking(project_dir, Some(2), None)
            .expect("git_log should read this repo")
            .len(),
        2
    );
}

#[test]
fn parses_main_and_linked_with_branches() {
    let text = "worktree /home/u/proj\nHEAD abc123def456\nbranch refs/heads/main\n\nworktree /home/u/proj-feature\nHEAD 999888777666\nbranch refs/heads/feature\n";
    let wts = parse_worktree_porcelain(text);
    assert_eq!(wts.len(), 2);
    assert_eq!(wts[0].path, "/home/u/proj");
    assert_eq!(wts[0].branch, "main");
    assert_eq!(wts[0].head, "abc123def456");
    assert!(wts[0].is_main);
    assert!(!wts[0].is_bare);
    assert!(!wts[0].is_locked);
    assert_eq!(wts[1].path, "/home/u/proj-feature");
    assert_eq!(wts[1].branch, "feature");
    assert!(!wts[1].is_main);
}

#[test]
fn parses_detached_head() {
    let text = "worktree /home/u/proj\nHEAD abc123\nbranch refs/heads/main\n\nworktree /home/u/detached\nHEAD deadbeef\ndetached\n";
    let wts = parse_worktree_porcelain(text);
    assert_eq!(wts.len(), 2);
    assert_eq!(wts[1].branch, "");
    assert_eq!(wts[1].head, "deadbeef");
    assert!(!wts[1].is_main);
}

#[test]
fn parses_bare_main() {
    let text = "worktree /home/u/bare.git\nbare\n\nworktree /home/u/linked\nHEAD abc123\nbranch refs/heads/work\n";
    let wts = parse_worktree_porcelain(text);
    assert_eq!(wts.len(), 2);
    assert!(wts[0].is_bare);
    assert!(wts[0].is_main);
    assert_eq!(wts[0].branch, "");
    assert_eq!(wts[0].head, "");
    assert_eq!(wts[1].branch, "work");
}

#[test]
fn parses_locked_with_reason() {
    let text = "worktree /home/u/proj\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/locked\nHEAD def\nbranch refs/heads/wip\nlocked on a removable drive\n";
    let wts = parse_worktree_porcelain(text);
    assert_eq!(wts.len(), 2);
    assert!(wts[1].is_locked);
    // The reason IS the content of a lock — discarding it left the UI with
    // nothing to say about a worktree it could not remove.
    assert_eq!(wts[1].lock_reason, "on a removable drive");
    assert_eq!(wts[1].branch, "wip");
    assert!(wts[0].lock_reason.is_empty());
}

#[test]
fn parses_a_bare_locked_line_with_no_reason() {
    let text = "worktree /home/u/proj\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/l\nHEAD def\nbranch refs/heads/wip\nlocked\n";
    let wts = parse_worktree_porcelain(text);
    assert!(wts[1].is_locked);
    assert!(wts[1].lock_reason.is_empty());
}

#[test]
fn parses_prunable_with_reason() {
    // The one signal git gives that a listed worktree is dead. It used to be
    // discarded, so a deleted checkout listed as healthy.
    let text = "worktree /home/u/proj\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/gone\nHEAD def\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n";
    let wts = parse_worktree_porcelain(text);
    assert_eq!(wts.len(), 2);
    assert!(!wts[0].is_prunable);
    assert!(wts[1].is_prunable);
    assert_eq!(
        wts[1].prunable_reason,
        "gitdir file points to non-existent location"
    );
}

#[test]
fn is_main_is_the_first_record_not_the_first_path_alphabetically() {
    // Every other fixture puts main both first AND alphabetically first, so a
    // regression to "sort by path" would pass them all. git lists the main
    // worktree first whatever its path sorts like (verified against 2.53.0).
    let text = "worktree /home/u/zzz-main\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/aaa-linked\nHEAD def\nbranch refs/heads/feature\n";
    let wts = parse_worktree_porcelain(text);
    assert!(wts[0].is_main, "the first record is main");
    assert_eq!(wts[0].path, "/home/u/zzz-main");
    assert!(!wts[1].is_main);
}

/// A local-project context rooted at `dir`, i.e. what `worktree_ctx` builds
/// for any project `projects.json` does not know as remote.
fn local_ctx(dir: &str) -> WorktreeCtx {
    worktree_ctx(dir, None, None)
}

#[test]
fn a_bare_name_resolves_inside_the_sanctioned_root() {
    let ctx = local_ctx("/home/u/proj");
    let p = resolve_worktree_path(&ctx, "feature-x").unwrap();
    assert_eq!(
        path_components(&p),
        path_components(concat!("/home/u/proj/.", crate::app_slug!(), "/worktrees/feature-x"))
    );
}

#[test]
fn an_absolute_path_inside_the_root_round_trips() {
    let ctx = local_ctx("/home/u/proj");
    let shown = ctx.join(&ctx.worktrees_root(), "feature-x");
    let p = resolve_worktree_path(&ctx, &shown).unwrap();
    assert_eq!(path_components(&p), path_components(&shown));
}

#[test]
fn paths_outside_the_sanctioned_root_are_refused() {
    let ctx = local_ctx("/home/u/proj");
    // The whole point of I3: `git worktree add <path>` populates `<path>`, so an
    // unconstrained argument writes repo content anywhere writable.
    for bad in [
        "/etc/cron.d/x",
        "/home/u/proj/wt", // inside the project, outside the root
        concat!("/home/u/proj/.", crate::app_slug!(), "/sessions/x"), // Tabtivity reads this dir as intent
        "../../elsewhere",
        concat!("/home/u/proj/.", crate::app_slug!(), "/worktrees/../../x"),
        concat!("/home/u/proj/.", crate::app_slug!(), "/worktrees-evil/x"), // prefix-match near miss
    ] {
        assert!(
            resolve_worktree_path(&ctx, bad).is_err(),
            "should refuse {bad}"
        );
    }
}

#[test]
fn the_root_itself_is_not_a_worktree_path() {
    let ctx = local_ctx("/home/u/proj");
    let root = ctx.worktrees_root();
    assert!(resolve_worktree_path(&ctx, &root).is_err());
}

#[test]
fn option_lookalike_and_empty_worktree_paths_are_refused() {
    let ctx = local_ctx("/home/u/proj");
    assert!(resolve_worktree_path(&ctx, "").is_err());
    assert!(resolve_worktree_path(&ctx, "   ").is_err());
    assert!(resolve_worktree_path(&ctx, "--upload-pack=x").is_err());
    assert!(resolve_worktree_path(&ctx, "a\u{7}b").is_err());
}

#[test]
fn a_worktree_verb_pins_hooks_off_and_keeps_its_subcommand() {
    // I4: `worktree add` checks out, and a checkout runs `post-checkout` — which
    // for a container-toggled project lives in the container's writable mount.
    // `-c core.hooksPath=` suppresses it (verified against git 2.53.0), and
    // since #862 every non-gated verb carries it without asking.
    let args = hardened_git_args(&["worktree", "add", "/p/wt", "feat"]);
    let mut want: Vec<String> = HARDENED_CONFIG
        .iter()
        .chain(OUTPUT_CONFIG)
        .flat_map(|kv| ["-c".to_string(), kv.to_string()])
        .collect();
    want.extend(["-c", "core.hooksPath=", "worktree", "add", "/p/wt", "feat"].map(String::from));
    assert_eq!(args, want);
    // The caller's own `-c` pair must not be mistaken for the subcommand: a
    // scoped config on a diff-driver command would otherwise silently drop
    // `--no-ext-diff`/`--no-textconv`.
    let diff = hardened_git_args(&["-c", "user.name=T", "diff", "HEAD"]);
    assert!(diff.contains(&"--no-ext-diff".to_string()));
    assert_eq!(
        diff[diff.len() - 4..],
        ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]
    );
}

#[test]
fn the_remote_worktree_command_is_quoted_argument_by_argument() {
    // Nothing asserts the `cd '<path>' && git 'worktree' …` shape anywhere, so an
    // argv-order regression on the remote path was caught only by the LOCAL
    // roundtrip — which cannot run it.
    use crate::services::ssh_exec::remote_git_command;
    let args = hardened_git_args(&["worktree", "add", concat!("/s/p/.", crate::app_slug!(), "/worktrees/a b"), "feat"]);
    let cmd = remote_git_command("/scratch/proj", &args);
    let output: String = OUTPUT_CONFIG.iter().map(|kv| format!(" '-c' '{kv}'")).collect();
    assert_eq!(
        cmd,
        format!(
            "cd '/scratch/proj' && git '-c' 'core.fsmonitor=false' '-c' 'protocol.ext.allow=never' \
                 '-c' 'safe.bareRepository=explicit'{output} '-c' 'core.hooksPath=' 'worktree' 'add' \
                 '/s/p/.{}/worktrees/a b' 'feat'",
            crate::app_slug!()
        )
    );
}

#[test]
fn a_host_side_root_is_posix_whatever_this_machine_is() {
    // A ctx built for a host must never join with a backslash: the path is
    // interpolated into a POSIX shell on the other end.
    let ctx = WorktreeCtx {
        target: None,
        cwd: "/scratch/proj".into(),
        root: "/scratch/proj".into(),
        posix: true,
    };
    assert_eq!(ctx.worktrees_root(), concat!("/scratch/proj/.", crate::app_slug!(), "/worktrees"));
    assert_eq!(
        resolve_worktree_path(&ctx, "feat").unwrap(),
        concat!("/scratch/proj/.", crate::app_slug!(), "/worktrees/feat")
    );
    assert!(resolve_worktree_path(&ctx, "/scratch/other/feat").is_err());
}

#[test]
fn skips_empty_path_records() {
    // Leading/trailing blank lines must not produce phantom worktrees.
    let text = "\n\nworktree /home/u/proj\nHEAD abc\nbranch refs/heads/main\n\n\n";
    let wts = parse_worktree_porcelain(text);
    assert_eq!(wts.len(), 1);
    assert_eq!(wts[0].path, "/home/u/proj");
    assert!(wts[0].is_main);
}

#[test]
fn add_list_remove_roundtrip() {
    if !git_available() {
        eprintln!("skipping: git binary not available");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir(&root).unwrap();
    let root_str = root.to_string_lossy().to_string();

    let run = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(&root)
            .output()
            .expect("git run")
    };
    assert!(run(&["init"]).status.success());
    run(&["config", "user.email", "test@example.com"]);
    run(&["config", "user.name", "Test"]);
    // Ensure a known starting branch name regardless of git defaults.
    run(&["checkout", "-b", "main"]);
    std::fs::write(root.join("file.txt"), "hello").unwrap();
    run(&["add", "-A"]);
    assert!(run(&["commit", "-m", "init"]).status.success());

    // Initially a single (main) worktree, which is also the one we ran in.
    let listed = git_worktree_list_blocking(root_str.clone(), None, None).unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].is_main);
    assert!(listed[0].is_current);

    // Add a new worktree on a new branch. The path is a bare NAME now — the
    // backend decides where a worktree lives (I3).
    let wt_path = git_worktree_add_blocking(
        root_str.clone(),
        "feature".to_string(),
        "feature".to_string(),
        true,
        None,
        None,
        None,
    )
    .unwrap();
    assert!(wt_path.ends_with("feature"));
    assert!(Path::new(&wt_path).join(".git").exists());

    let listed = git_worktree_list_blocking(root_str.clone(), None, None).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed.iter().filter(|w| w.is_main).count(), 1);
    assert_eq!(listed.iter().filter(|w| w.is_current).count(), 1);
    assert!(listed.iter().any(|w| w.branch == "feature"));

    let selection = GitWorktreeSelection { path: wt_path.clone(), site: "host".into() };
    let branches = git_branches_blocking_selected(root_str.clone(), Some(selection.clone())).unwrap();
    assert!(branches.iter().any(|b| b.name == "feature" && b.is_current));
    assert!(git_branches_blocking(root_str.clone()).unwrap().iter().any(|b| b.name == "main" && b.is_current));
    std::fs::write(Path::new(&wt_path).join("selected.txt"), "selected\n").unwrap();
    git_add_all_blocking_selected(root_str.clone(), Some(selection.clone())).unwrap();
    assert_eq!(git_status_blocking_selected(root_str.clone(), Some(selection.clone())).unwrap().staged, 1);
    assert_eq!(git_status_blocking(root_str.clone()).unwrap().staged, 0);
    let invalid = GitWorktreeSelection { path: tmp.path().to_string_lossy().into_owned(), site: "host".into() };
    assert!(selected_git_context(root_str.clone(), Some(&invalid)).is_err());
    run_git(None, &wt_path, &["reset"]).unwrap();
    std::fs::remove_file(Path::new(&wt_path).join("selected.txt")).unwrap();

    // `.tabtivity/` is excluded repo-locally, so the new checkout is not staged as
    // a bogus gitlink by the commit UI's `git add -A` (verified: without this,
    // `git ls-files --stage` shows mode 160000 for it).
    run(&["add", "-A"]);
    let staged = run(&["ls-files", "--stage"]);
    let staged = String::from_utf8_lossy(&staged.stdout).to_string();
    assert!(
        !staged.contains("160000"),
        "embedded gitlink staged: {staged}"
    );
    run(&["reset"]);

    // Removing the worktree we are standing in is refused (D4) — git itself
    // does not refuse it, and it would delete the tree Tabtivity works in.
    let err = git_worktree_remove_blocking(root_str.clone(), root_str.clone(), 2, None, None)
        .unwrap_err();
    assert!(err.contains("own checkout"), "unexpected: {err}");

    // Remove it and confirm we are back to one.
    git_worktree_remove_blocking(root_str.clone(), wt_path, 1, None, None).unwrap();
    let listed = git_worktree_list_blocking(root_str, None, None).unwrap();
    assert_eq!(listed.len(), 1);
}

#[test]
fn a_locked_worktree_needs_two_forces_and_can_be_unlocked() {
    // git: "use 'remove -f -f' to override or unlock first" — exit 128 for a
    // single --force. Neither escape existed in Tabtivity before (B4).
    if !git_available() {
        eprintln!("skipping: git binary not available");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir(&root).unwrap();
    let root_str = root.to_string_lossy().to_string();
    let run = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(&root)
            .output()
            .expect("git run")
    };
    assert!(run(&["init"]).status.success());
    run(&["config", "user.email", "t@e.c"]);
    run(&["config", "user.name", "T"]);
    run(&["checkout", "-b", "main"]);
    std::fs::write(root.join("f.txt"), "hi").unwrap();
    run(&["add", "-A"]);
    assert!(run(&["commit", "-m", "init"]).status.success());

    let wt = git_worktree_add_blocking(
        root_str.clone(),
        "wip".into(),
        "wip".into(),
        true,
        Some("main".into()),
        None,
        None,
    )
    .unwrap();

    let ctx = worktree_ctx(&root_str, None, None);
    run_worktree_git(
        &ctx,
        &["worktree", "lock", "--reason", "on a removable drive", &wt],
    )
    .unwrap();

    let listed = git_worktree_list_blocking(root_str.clone(), None, None).unwrap();
    let locked = listed.iter().find(|w| !w.is_main).unwrap();
    assert!(locked.is_locked);
    assert_eq!(locked.lock_reason, "on a removable drive");

    // One --force is not enough.
    assert!(git_worktree_remove_blocking(root_str.clone(), wt.clone(), 1, None, None).is_err());
    // Two is.
    git_worktree_remove_blocking(root_str.clone(), wt, 2, None, None).unwrap();
    assert_eq!(
        git_worktree_list_blocking(root_str, None, None)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn a_new_branch_is_created_at_its_start_point() {
    // B1: the toggle could never succeed, because the branch name came from a
    // list of EXISTING branches — `git worktree add -b <existing>` always
    // answers "a branch named 'X' already exists".
    if !git_available() {
        eprintln!("skipping: git binary not available");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir(&root).unwrap();
    let root_str = root.to_string_lossy().to_string();
    let run = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(&root)
            .output()
            .expect("git run")
    };
    assert!(run(&["init"]).status.success());
    run(&["config", "user.email", "t@e.c"]);
    run(&["config", "user.name", "T"]);
    run(&["checkout", "-b", "main"]);
    std::fs::write(root.join("f.txt"), "one").unwrap();
    run(&["add", "-A"]);
    run(&["commit", "-m", "one"]);
    let first = String::from_utf8_lossy(&run(&["rev-parse", "HEAD"]).stdout)
        .trim()
        .to_string();
    std::fs::write(root.join("f.txt"), "two").unwrap();
    run(&["add", "-A"]);
    run(&["commit", "-m", "two"]);

    let wt = git_worktree_add_blocking(
        root_str.clone(),
        "from-first".into(),
        "from-first".into(),
        true,
        Some(first.clone()),
        None,
        None,
    )
    .unwrap();
    let head = crate::paths::command_no_window("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&wt)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), first);

    // A start point without `newBranch` is a contradiction, not a silent no-op.
    assert!(git_worktree_add_blocking(
        root_str,
        "x".into(),
        "main".into(),
        false,
        Some(first),
        None,
        None,
    )
    .is_err());
}

#[test]
fn listing_from_inside_a_linked_worktree_still_finds_main_and_current() {
    // Every existing fixture operates from the MAIN worktree, so `is_main`
    // and `is_current` were both unguarded for the one case where they differ.
    if !git_available() {
        eprintln!("skipping: git binary not available");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir(&root).unwrap();
    let root_str = root.to_string_lossy().to_string();
    let run = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(&root)
            .output()
            .expect("git run")
    };
    assert!(run(&["init"]).status.success());
    run(&["config", "user.email", "t@e.c"]);
    run(&["config", "user.name", "T"]);
    run(&["checkout", "-b", "main"]);
    std::fs::write(root.join("f.txt"), "hi").unwrap();
    run(&["add", "-A"]);
    run(&["commit", "-m", "init"]);
    let wt = git_worktree_add_blocking(
        root_str.clone(),
        "feat".into(),
        "feat".into(),
        true,
        None,
        None,
        None,
    )
    .unwrap();

    // A linked worktree's `.git` is a FILE — `local_non_repo` must test
    // existence, never `is_dir` (I6), or this returns an empty list.
    let listed = git_worktree_list_blocking(wt.clone(), None, None).unwrap();
    assert_eq!(listed.len(), 2, "listing from a linked worktree");
    assert!(listed[0].is_main, "main is still first");
    assert!(!listed[0].is_current);
    let cur = listed.iter().find(|w| w.is_current).expect("a current row");
    assert_eq!(cur.branch, "feat");

    // …and removing the one we are standing in is refused from here too.
    assert!(git_worktree_remove_blocking(wt.clone(), wt, 2, None, None).is_err());
}

#[test]
fn provider_from_origin_url_recognizes_hosts() {
    // SSH form.
    assert_eq!(
        provider_from_origin_url("git@github.com:owner/repo.git"),
        Some("github")
    );
    assert_eq!(
        provider_from_origin_url("git@gitlab.com:owner/repo.git"),
        Some("gitlab")
    );
    // HTTPS form.
    assert_eq!(
        provider_from_origin_url("https://github.com/owner/repo.git"),
        Some("github")
    );
    assert_eq!(
        provider_from_origin_url("https://gitlab.example.com/owner/repo.git"),
        Some("gitlab")
    );
    // Enterprise/vanity host containing the provider name still matches.
    assert_eq!(
        provider_from_origin_url("git@github.corp.internal:owner/repo.git"),
        Some("github")
    );
    // Unrecognized / self-hosted vanity host → no badge.
    assert_eq!(
        provider_from_origin_url("git@git.mycorp.com:owner/repo.git"),
        None
    );
}

// ── validate_clone_url ─────────────────────────────────────────────────

#[test]
fn validate_clone_url_accepts_supported_forms() {
    for url in &[
        "https://github.com/owner/repo.git",
        "https://gitlab.com/group/sub/repo",
        "http://git.internal/owner/repo.git",
        "ssh://git@github.com:22/owner/repo.git",
        "git://git.internal/repo.git",
        "git@github.com:owner/repo.git",
        "gitlab.com:group/repo.git",
    ] {
        assert!(validate_clone_url(url).is_ok(), "should accept: {url}");
    }
    // Surrounding whitespace (a pasted URL) is tolerated.
    assert!(validate_clone_url("  https://github.com/o/r.git  ").is_ok());
}

#[test]
fn validate_clone_url_rejects_unsupported_forms() {
    for url in &[
        "",
        "   ",
        // `ext::` runs a command — never behind a URL field.
        "ext::sh -c 'touch /tmp/pwned'",
        "file:///etc",
        "/etc/passwd",
        "../repo",
        "just-a-name",
        // Option injection, with and without the scp-like colon.
        "--upload-pack=touch /tmp/pwned",
        "--upload-pack=x:y",
    ] {
        assert!(validate_clone_url(url).is_err(), "should reject: {url}");
    }
}

#[test]
fn clone_error_explains_missing_token_for_https() {
    let msg = clone_error(
        "fatal: could not read Username for 'https://github.com'",
        false,
        true,
    );
    assert!(msg.contains("Settings → Git Hosting"), "{msg}");

    // A token IS stored but was rejected → point at the token, not at adding one.
    let msg = clone_error("remote: Repository not found.", true, true);
    assert!(msg.contains("was rejected"), "{msg}");

    // SSH auth failure gets the key/agent hint instead.
    let msg = clone_error(
        "git@github.com: Permission denied (publickey).\nfatal: Authentication failed",
        false,
        false,
    );
    assert!(msg.contains("ssh-agent"), "{msg}");

    // A non-auth failure is passed through unchanged (no misleading hint).
    let msg = clone_error("fatal: destination path exists", false, true);
    assert_eq!(msg, "fatal: destination path exists");
}

// ── Revision / positional-path validation (S-9) ───────────────────────────

#[test]
fn valid_rev_rejects_option_lookalike_refnames() {
    // The primitive: a format-legal refname that git would parse as an option.
    assert!(!valid_rev("--output=/home/u/.bashrc"));
    assert!(!valid_rev("-evil"));
    assert!(!valid_rev(""));
    // Whitespace and control characters cannot occur in a legal refname, and a
    // shell-quoted-looking rev is never one either.
    assert!(!valid_rev("main; rm -rf /"));
    assert!(!valid_rev("ma\nin"));
    assert!(!valid_rev("refs/heads/a b"));
}

#[test]
fn valid_rev_accepts_every_ordinary_revision_spelling() {
    for rev in [
        "HEAD",
        "HEAD~3",
        "HEAD^{tree}",
        "main",
        "origin/main",
        "refs/heads/feature/x",
        "@{u}..",
        "0123456789abcdef0123456789abcdef01234567",
        "v1.2.3",
    ] {
        assert!(valid_rev(rev), "{rev} must be accepted");
        assert!(check_rev(rev).is_ok());
    }
    assert!(check_rev("-evil").is_err());
}

#[test]
fn positional_paths_reject_only_the_option_lookalike() {
    assert!(valid_positional_path("/home/u/wt/feature"));
    assert!(valid_positional_path("../sibling-worktree"));
    assert!(!valid_positional_path("--force"));
    assert!(!valid_positional_path("-x"));
    assert!(!valid_positional_path("   "));
}

/// The background/automatic git path (lockstep, the scaffold commit) runs in
/// trees a fenced agent can write: neither a planted `core.fsmonitor` nor a
/// planted hook may run through it. Both directions, as above.
#[cfg(unix)]
#[test]
fn hookless_git_runs_neither_fsmonitor_nor_hooks() {
    if !git_available() {
        eprintln!("git not on PATH — skipping hookless_git_runs_neither_fsmonitor_nor_hooks");
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();
    init_repo(dir);
    let marker = dir.join("executed");
    let payload = dir.join("payload.sh");
    fs::write(&payload, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).expect("write");
    fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("chmod");
    let hook = dir.join(".git/hooks/pre-commit");
    fs::copy(&payload, &hook).expect("hook");
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("chmod");
    let plain = |args: &[&str]| {
        crate::paths::command_no_window("git").args(args).current_dir(dir).output().expect("git")
    };
    plain(&["config", "core.fsmonitor", payload.to_str().unwrap()]);
    fs::write(dir.join("f.txt"), "a\n").expect("write");

    plain(&["status", "--porcelain"]);
    assert!(marker.exists(), "setup is stale: git no longer runs core.fsmonitor");
    fs::remove_file(&marker).expect("clear");
    let out = hookless_git_command_in(dir, &["status", "--porcelain"]).output().expect("git");
    assert!(out.status.success());
    assert!(!marker.exists(), "core.fsmonitor ran through hookless_git_command_in");

    hookless_git_command_in(dir, &["add", "f.txt"]).output().expect("add");
    let out = hookless_git_command_in(
        dir,
        &["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", "x"],
    )
    .output()
    .expect("commit");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(!marker.exists(), "pre-commit hook ran through hookless_git_command_in");
}

/// #862: the fence binds `.git/config` and `.git/hooks` read-only, but an
/// agent can still *create* `.git/commondir` naming a git dir of its own,
/// whose `hooks/post-index-change` git runs on anything that rewrites the
/// index. Neither the redirect nor any hook may reach the Git panel's reads
/// — file diff, commit-message generation, stage, the merge-state probe a
/// planted `MERGE_HEAD` leads to — and a hook-trusted verb runs the repo's
/// *real* hooks, never the planted ones.
#[cfg(unix)]
#[test]
fn a_commondir_redirected_hook_never_runs_through_app_git() {
    if !git_available() {
        eprintln!(concat!("git not on PATH — skipping a_commondir_redirected_hook_never_runs_through_", crate::app_slug!(), "_git"));
        return;
    }
    use std::os::unix::fs::{symlink, PermissionsExt};
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("proj");
    fs::create_dir(&dir).expect("mkdir");
    init_repo(&dir);
    fs::write(dir.join("f.txt"), "a\n").expect("write");
    plain_git(&dir, &["add", "f.txt"]);
    plain_git(&dir, &["commit", "-qm", "init"]);
    let hook = |hooks: &Path, marker: &Path| {
        fs::create_dir_all(hooks).expect("hooks dir");
        let h = hooks.join("post-index-change");
        fs::write(&h, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).expect("hook");
        fs::set_permissions(&h, fs::Permissions::from_mode(0o755)).expect("chmod");
    };

    // The plant: a common dir sharing the real objects, refs and config, with
    // hooks of its own — nothing in `.git/config` or `.git/hooks` touched.
    let git = dir.join(".git");
    let evil = git.join("x");
    fs::create_dir(&evil).expect("mkdir");
    for shared in ["objects", "refs", "config"] {
        symlink(git.join(shared), evil.join(shared)).expect("symlink");
    }
    let planted = tmp.path().join("planted-ran");
    hook(&evil.join("hooks"), &planted);
    fs::write(git.join("commondir"), "x\n").expect("commondir");
    fs::write(dir.join("f.txt"), "b\n").expect("edit");
    plain_git(&dir, &["add", "f.txt"]);
    assert!(planted.exists(), "setup is stale: plain git no longer follows a planted commondir");
    fs::remove_file(&planted).expect("clear");

    let d = dir.to_string_lossy().into_owned();
    fs::write(dir.join("f.txt"), "c\n").expect("edit");
    let diff = git_diff_file_blocking(d.clone(), "f.txt".into()).expect("file diff");
    assert!(diff.contains("+c"), "file diff lost its content: {diff}");
    assert!(!planted.exists(), "planted hook ran on the file diff");
    git_generate_commit_message_blocking(d.clone()).expect("commit message");
    assert!(!planted.exists(), "planted hook ran on commit-message generation");
    git_add_path_blocking(d.clone(), "f.txt".into()).expect("stage");
    assert!(!planted.exists(), "planted hook ran on stage");
    let staged = plain_git(&dir, &["diff", "--cached", "--name-only"]);
    assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), "f.txt", "stage did not stage");

    // Opening Git history with a planted `MERGE_HEAD` reaches the probe.
    let head = plain_git(&dir, &["rev-parse", "HEAD"]);
    fs::write(git.join("MERGE_HEAD"), &head.stdout).expect("MERGE_HEAD");
    fs::write(dir.join("f.txt"), "d\n").expect("edit");
    let state = app_core::rt::block_on(crate::commands::git_pull::git_merge_state(d.clone(), None))
        .expect("merge state");
    assert!(state.merging, "setup is stale: MERGE_HEAD not seen");
    assert!(!planted.exists(), "planted hook ran on the merge-state probe");
    fs::remove_file(git.join("MERGE_HEAD")).expect("clear MERGE_HEAD");

    // A hook-trusted verb runs hooks — the repo's own, never the planted ones.
    let real = tmp.path().join("real-ran");
    hook(&git.join("hooks"), &real);
    fs::write(dir.join("f.txt"), "e\n").expect("edit");
    let out = run_git_hooked(None, &d, &["add", "f.txt"]).expect("hooked add");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(real.exists(), "the repo's own hook did not run through run_git_hooked");
    assert!(!planted.exists(), "planted hook ran through run_git_hooked");
    // …and the default path runs neither.
    fs::remove_file(&real).expect("clear");
    fs::write(dir.join("f.txt"), "f\n").expect("edit");
    run_git(None, &d, &["add", "f.txt"]).expect("add");
    assert!(!real.exists() && !planted.exists(), "a hook ran through run_git");
}

/// `GIT_COMMON_DIR` is pinned for a main `.git` only: a linked worktree's
/// `commondir` is git's own, and pinning it would point the worktree at its
/// private git dir as if it were the shared one.
#[cfg(unix)]
#[test]
fn the_common_dir_pin_spares_linked_worktrees() {
    if !git_available() {
        eprintln!("git not on PATH — skipping the_common_dir_pin_spares_linked_worktrees");
        return;
    }
    let pinned = |cmd: &std::process::Command| {
        cmd.get_envs()
            .find(|(k, _)| *k == "GIT_COMMON_DIR")
            .and_then(|(_, v)| v.map(PathBuf::from))
    };
    let tmp = tempfile::tempdir().expect("tempdir");
    let main = tmp.path().join("main");
    fs::create_dir(&main).expect("mkdir");
    init_repo(&main);
    fs::write(main.join("f.txt"), "a\n").expect("write");
    plain_git(&main, &["add", "f.txt"]);
    plain_git(&main, &["commit", "-qm", "init"]);
    let sub = main.join("sub");
    fs::create_dir(&sub).expect("mkdir");
    assert_eq!(pinned(&hardened_git_command_in(&sub, &["status"])), Some(main.join(".git")));

    let wt = tmp.path().join("wt");
    let out = plain_git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(pinned(&hardened_git_command_in(&wt, &["status"])), None);
    let out = run_git(None, wt.to_str().unwrap(), &["rev-parse", "--git-common-dir"]).expect("git");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let common = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    assert_eq!(
        common.canonicalize().unwrap(),
        main.join(".git").canonicalize().unwrap(),
        "a linked worktree lost its shared common dir"
    );
}

#[test]
fn token_helper_is_registered_only_for_the_given_origins() {
    let args = scoped_token_config(&["https://github.com".to_string()], "x-access-token");
    assert_eq!(&args[..2], ["-c", "credential.helper="]);
    let helpers: Vec<&String> = args.iter().filter(|a| a.contains(".helper=!")).collect();
    assert_eq!(helpers.len(), 1);
    assert!(helpers[0].starts_with("credential.https://github.com.helper=!"));
    assert!(!args.iter().any(|a| a.starts_with("credential.helper=!")), "unscoped helper");
}

/// #158 fixture: a clean-filter payload bound to `*.txt` by an in-tree
/// `.gitattributes`, plus the marker it leaves. The driver itself is planted
/// by each test wherever the layout under test makes git read it from.
#[cfg(unix)]
fn filter_payload(root: &Path) -> (PathBuf, String) {
    use std::os::unix::fs::PermissionsExt;
    let marker = root.join("executed");
    let payload = root.join("payload.sh");
    fs::write(&payload, format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()))
        .expect("write");
    fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("chmod");
    (marker, payload.to_string_lossy().into_owned())
}

#[cfg(unix)]
fn plain_git(dir: &Path, args: &[&str]) -> std::process::Output {
    crate::paths::command_no_window("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git")
}

/// Commit a tracked `f.txt` under the filter binding, then make a same-size
/// edit so the next status/diff has to re-read (and so re-filter) it.
#[cfg(unix)]
fn tracked_txt_with_pending_edit(worktree: &Path) {
    fs::write(worktree.join(".gitattributes"), "*.txt filter=x\n").expect("attrs");
    fs::write(worktree.join("f.txt"), "a\n").expect("write");
    plain_git(worktree, &["add", ".gitattributes", "f.txt"]);
    plain_git(
        worktree,
        &["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "init"],
    );
    fs::write(worktree.join("f.txt"), "b\n").expect("edit");
}

/// Both directions for one layout: plain git in `run_dir` runs the planted
/// filter (else the setup is stale and the test vacuous), `run_git` does not.
#[cfg(unix)]
fn assert_filter_contained(run_dir: &Path, worktree: &Path, marker: &Path, layout: &str) {
    plain_git(run_dir, &["diff"]);
    assert!(marker.exists(), "{layout}: setup is stale — plain git did not run the filter");
    fs::remove_file(marker).expect("clear marker");
    fs::write(worktree.join("f.txt"), "c\n").expect("edit again");

    let dir = run_dir.to_str().expect("utf-8 path");
    run_git(None, dir, &["status", "--porcelain"]).expect("hardened status");
    assert!(!marker.exists(), "{layout}: clean filter ran through run_git status");
    run_git(None, dir, &["diff"]).expect("hardened diff");
    assert!(!marker.exists(), "{layout}: clean filter ran through run_git diff");
}

/// #158: `.git` as a pointer file (`gitdir: .notgit`) — the sanitizer used
/// to open `<project>/.git/config`, find no file, and strip nothing.
#[cfg(unix)]
#[test]
fn a_gitdir_pointer_file_does_not_skip_the_config_strip() {
    if !git_available() {
        eprintln!("git not on PATH — skipping a_gitdir_pointer_file_does_not_skip_the_config_strip");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("proj");
    fs::create_dir(&dir).expect("mkdir");
    init_repo(&dir);
    fs::rename(dir.join(".git"), dir.join(".notgit")).expect("move git dir");
    fs::write(dir.join(".git"), "gitdir: .notgit\n").expect("pointer");
    tracked_txt_with_pending_edit(&dir);
    let (marker, payload) = filter_payload(tmp.path());
    plain_git(&dir, &["config", "filter.x.clean", &payload]);
    assert!(
        fs::read_to_string(dir.join(".notgit/config")).unwrap().contains("payload.sh"),
        "the driver must live in the redirected config"
    );
    assert_filter_contained(&dir, &dir, &marker, "gitdir pointer");
}

/// #158: a linked worktree — Tabtivity's own agent worktrees. Its `.git`
/// points at `<common>/worktrees/<name>`, whose `commondir` names the shared
/// config; with `extensions.worktreeConfig` it also reads `config.worktree`.
#[cfg(unix)]
#[test]
fn a_linked_worktrees_common_and_worktree_config_are_stripped() {
    if !git_available() {
        eprintln!("git not on PATH — skipping a_linked_worktrees_common_and_worktree_config_are_stripped");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let main = tmp.path().join("main");
    fs::create_dir(&main).expect("mkdir");
    init_repo(&main);
    tracked_txt_with_pending_edit(&main);
    plain_git(&main, &["checkout", "-q", "--", "f.txt"]);
    let wt = tmp.path().join("wt");
    let out = plain_git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(wt.join(".git").is_file());
    fs::write(wt.join("f.txt"), "b\n").expect("edit");

    let (marker, payload) = filter_payload(tmp.path());
    plain_git(&main, &["config", "extensions.worktreeConfig", "true"]);
    plain_git(&wt, &["config", "--worktree", "filter.x.clean", &payload]);
    assert_filter_contained(&wt, &wt, &marker, "linked worktree, config.worktree");

    // The shared (common-dir) config, reached through `commondir`.
    plain_git(&main, &["config", "filter.x.clean", &payload]);
    fs::write(wt.join("f.txt"), "d\n").expect("edit");
    assert_filter_contained(&wt, &wt, &marker, "linked worktree, common config");
}

/// #158: a project folder inside a larger repo — git discovers the repo by
/// walking up, so the sanitizer has to find the same `.git` git will.
#[cfg(unix)]
#[test]
fn a_project_below_the_repo_root_is_stripped_too() {
    if !git_available() {
        eprintln!("git not on PATH — skipping a_project_below_the_repo_root_is_stripped_too");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let repo = tmp.path().join("repo");
    let sub = repo.join("sub");
    fs::create_dir_all(&sub).expect("mkdir");
    init_repo(&repo);
    tracked_txt_with_pending_edit(&repo);
    let (marker, payload) = filter_payload(tmp.path());
    plain_git(&repo, &["config", "filter.x.clean", &payload]);
    assert_filter_contained(&sub, &repo, &marker, "project below the repo root");
}

/// A folder laid out as a bare repository (`HEAD`, `objects/`, `refs/`,
/// `config`) is itself a git dir to implicit discovery, and its `config` can
/// name a `core.worktree`. `safe.bareRepository=explicit` refuses that.
#[cfg(unix)]
#[test]
fn an_implicit_bare_repo_layout_is_refused() {
    if !git_available() {
        eprintln!("git not on PATH — skipping an_implicit_bare_repo_layout_is_refused");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let work = tmp.path().join("work");
    fs::create_dir(&work).expect("mkdir");
    init_repo(&work);
    tracked_txt_with_pending_edit(&work);
    let (marker, payload) = filter_payload(tmp.path());
    // The folder the user adds: the git dir itself, pointing its worktree
    // back at the files.
    let project = tmp.path().join("project");
    fs::rename(work.join(".git"), &project).expect("move git dir");
    plain_git(&project, &["config", "core.bare", "false"]);
    plain_git(&project, &["config", "core.worktree", work.to_str().unwrap()]);
    plain_git(&project, &["config", "filter.x.clean", &payload]);

    plain_git(&project, &["diff"]);
    assert!(marker.exists(), "setup is stale — plain git did not treat the folder as a repo");
    fs::remove_file(&marker).expect("clear marker");
    fs::write(work.join("f.txt"), "c\n").expect("edit again");
    let dir = project.to_str().unwrap();
    let _ = run_git(None, dir, &["status", "--porcelain"]);
    let _ = run_git(None, dir, &["diff"]);
    assert!(!marker.exists(), "implicit bare repo: clean filter ran through run_git");
}

/// #2349: a FIFO `info/exclude` (pre-checked) and a FIFO nested
/// `.gitignore` (timed out) make the background status probes answer an
/// error quickly — never a hang, never a fake clean status — and leave no
/// git behind; a normal repo still reads.
#[cfg(target_os = "linux")]
#[test]
fn a_fifo_ignore_file_makes_the_status_polls_fail_fast_not_hang() {
    use crate::services::git_bounded::{LAST_PID, NOT_A_HANG, TEST_TIMEOUT};
    use std::time::{Duration, Instant};
    if !git_available() {
        return;
    }
    let mkfifo = |p: &Path| {
        let _ = fs::remove_file(p);
        let c = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0, "mkfifo {}", p.display());
    };
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("repo");
    fs::create_dir_all(dir.join("sub")).unwrap();
    init_repo(&dir);
    fs::write(dir.join("a.txt"), "a").unwrap();
    fs::write(dir.join("sub/b.txt"), "b").unwrap();
    assert!(plain_git(&dir, &["add", "."]).status.success());
    assert!(plain_git(&dir, &["commit", "-qm", "i"]).status.success());
    let d = dir.to_string_lossy().into_owned();

    let status = git_status_probe(d.clone(), false).expect("a normal repo reads");
    assert!(status.is_repo && status.untracked == 0 && status.unstaged == 0);

    let exclude = dir.join(".git/info/exclude");
    mkfifo(&exclude);
    let started = Instant::now();
    let err = git_status_probe(d.clone(), false).err().expect("a FIFO exclude must not read as clean");
    assert!(err.contains("named pipe"), "{err}");
    assert!(git_file_statuses_blocking(d.clone(), String::new()).is_err());
    assert!(started.elapsed() < NOT_A_HANG, "took {:?}", started.elapsed());
    fs::remove_file(&exclude).unwrap();

    mkfifo(&dir.join("sub/.gitignore"));
    TEST_TIMEOUT.with(|t| t.set(Some(Duration::from_millis(700))));
    let started = Instant::now();
    let err = git_status_probe(d.clone(), false);
    let pid = LAST_PID.with(|p| p.get()).expect("git spawned");
    let listing = git_file_statuses_blocking(d.clone(), "sub".into());
    TEST_TIMEOUT.with(|t| t.set(None));
    let err = err.err().expect("a FIFO nested .gitignore must not read as clean");
    assert!(err.contains("timed out"), "{err}");
    assert!(listing.expect_err("the tree's status").contains("timed out"));
    assert!(started.elapsed() < NOT_A_HANG, "took {:?}", started.elapsed());
    assert!(!Path::new(&format!("/proc/{pid}")).exists(), "git {pid} left behind");
}

/// Spawns of `git` that bypass [`hardened_git_command_in`] on purpose, as
/// `(file under src/, enclosing fn, why)`. None of them runs git in a
/// project's repo; each site carries the same reason as a comment.
const BARE_GIT_ALLOWED: &[(&str, &str, &str)] = &[
    ("commands/git.rs", "git_command", "the hardened builder itself"),
    ("commands/git.rs", "surviving_denylisted_key", "`config --file` on one file, no repo"),
    ("commands/git.rs", "sanitize_git_config_file", "`config --file` on one file, no repo"),
    ("services/git_bounded.rs", "list_path_values", "`config --file` on one file, no repo"),
    ("commands/git.rs", "git_available_blocking", "`--version`, no repo"),
    ("commands/git.rs", "git_clone_blocking", "network clone into a new empty dir"),
    ("commands/git.rs", "git_remote_visibility_blocking", "anonymous `ls-remote` of a URL"),
    ("services/dev_build.rs", "commits_behind", "the app's own checkout"),
    ("services/dev_build.rs", "head_sha", "the app's own checkout"),
    ("services/skills.rs", "refresh_source", "the skills cache clone in the state dir"),
];

/// A `#[cfg(test)]`-style attribute line (`cfg(test)`, `cfg(all(test, …))`).
fn is_test_cfg(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("#[cfg(test)]") || t.starts_with("#[cfg(all(test")
}

/// The `mod` an attribute at `lines[at]` applies to: `Some((name, inline))`
/// when the next non-attribute, non-comment line declares one.
fn module_after(lines: &[&str], at: usize) -> Option<(String, bool)> {
    let next = lines[at + 1..]
        .iter()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with("#[") && !l.starts_with("//"))?;
    let rest = next.strip_prefix("pub(crate) ").or_else(|| next.strip_prefix("pub ")).unwrap_or(next);
    let rest = rest.strip_prefix("mod ")?;
    let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    Some((name, rest.trim_end().ends_with('{')))
}

/// The name of the `fn` whose body holds `lines[at]`: the nearest
/// `fn` item header at or above it.
fn enclosing_fn(lines: &[&str], at: usize) -> String {
    const QUALIFIERS: &[&str] = &["pub", "pub(crate)", "pub(super)", "async", "const", "unsafe"];
    for line in lines[..=at].iter().rev() {
        let t = line.trim();
        if t.starts_with("//") {
            continue;
        }
        let Some(idx) = t.find("fn ") else { continue };
        if !t[..idx].split_whitespace().all(|w| QUALIFIERS.contains(&w)) {
            continue;
        }
        return t[idx + 3..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    }
    String::new()
}

/// Which lines belong to an inline `#[cfg(test)] mod … { … }`: from the
/// attribute to the module's closing `}` — the first later line that is
/// exactly the `mod` line's indentation plus `}` (rustfmt layout). Code
/// after a test module (this file has some) is still scanned.
fn inline_test_lines(lines: &[&str]) -> Vec<bool> {
    let mut in_test = vec![false; lines.len()];
    let mut i = 0;
    while i < lines.len() {
        if !is_test_cfg(lines[i]) || !matches!(module_after(lines, i), Some((_, true))) {
            i += 1;
            continue;
        }
        let Some(mod_at) = (i + 1..lines.len()).find(|&j| {
            let t = lines[j].trim_start();
            t.starts_with("mod ") || t.starts_with("pub mod ") || t.starts_with("pub(crate) mod ")
        }) else {
            break;
        };
        let indent = &lines[mod_at][..lines[mod_at].len() - lines[mod_at].trim_start().len()];
        let close = format!("{indent}}}");
        let end = (mod_at + 1..lines.len()).find(|&j| lines[j].trim_end() == close).unwrap_or(lines.len() - 1);
        for flag in &mut in_test[i..=end] {
            *flag = true;
        }
        i = end + 1;
    }
    in_test
}

#[test]
fn the_git_spawn_scan_skips_test_modules_but_not_code_after_them() {
    let src = "fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() {\n    }\n}\n\nfn b() {}\n    #[cfg(test)]\n    mod inner {\n    }\nfn c() {}\n";
    let lines: Vec<&str> = src.lines().collect();
    let flagged: Vec<usize> = inline_test_lines(&lines).iter().enumerate().filter(|(_, f)| **f).map(|(i, _)| i).collect();
    assert_eq!(flagged, vec![1, 2, 3, 4, 5, 8, 9, 10]);
    assert_eq!(enclosing_fn(&lines, 4), "t");
    assert_eq!(enclosing_fn(&lines, 10), "b");
    assert_eq!(enclosing_fn(&lines, 11), "c"); // a one-line fn names itself
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// One production `.rs` file under `src/`: its path relative to `src/`
/// (`/`-separated), its text, and which lines sit in an inline
/// `#[cfg(test)] mod … { … }` ([`inline_test_lines`]).
struct ProdSource {
    rel: String,
    text: String,
    in_test: Vec<bool>,
}

impl ProdSource {
    fn lines(&self) -> Vec<&str> {
        self.text.lines().collect()
    }
}

/// Every production source file under `src/`: files that are themselves
/// `#[cfg(test)] mod …;` modules are left out, inline test modules are
/// flagged per line. The base of the source-scan guards.
fn production_sources() -> Vec<ProdSource> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let texts: Vec<(PathBuf, String)> = files
        .into_iter()
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            (p, text)
        })
        .collect();

    // Out-of-line test modules: `#[cfg(test)] mod name;` in `a/b.rs` is
    // `a/b/name.rs` or `a/b/name/…`; in `a/mod.rs` / `lib.rs` it is `a/name…`.
    let mut test_only: Vec<PathBuf> = Vec::new();
    for (path, text) in &texts {
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !is_test_cfg(line) {
                continue;
            }
            let Some((name, false)) = module_after(&lines, i) else { continue };
            let parent = path.parent().unwrap();
            let stem = path.file_stem().unwrap().to_string_lossy();
            let dir = if matches!(stem.as_ref(), "mod" | "lib" | "main") {
                parent.to_path_buf()
            } else {
                parent.join(stem.as_ref())
            };
            test_only.push(dir.join(format!("{name}.rs")));
            test_only.push(dir.join(&name));
        }
    }

    texts
        .into_iter()
        .filter(|(path, _)| !test_only.iter().any(|t| path.starts_with(t)))
        .map(|(path, text)| {
            let rel = path
                .strip_prefix(&src)
                .unwrap()
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let in_test = inline_test_lines(&text.lines().collect::<Vec<_>>());
            ProdSource { rel, text, in_test }
        })
        .collect()
}

/// #6 (whole-project screen 2026-10-15): every LOCAL git spawn goes through
/// [`hardened_git_command_in`] (config sanitized, hooks off, common dir
/// pinned). A source scan over every production file under `src/`: a bare
/// `command_no_window("git")` / `Command::new("git")` outside
/// [`BARE_GIT_ALLOWED`] fails. Test code is skipped: inline
/// `#[cfg(test)] mod … { … }` bodies ([`inline_test_lines`]) and files that
/// are themselves `#[cfg(test)] mod …;` modules. Remote git (`ssh … git`)
/// does not match.
#[test]
fn every_local_git_spawn_goes_through_the_hardened_builder() {
    let mut used = std::collections::HashSet::new();
    let mut offenders = Vec::new();
    for source in production_sources() {
        let file = source.rel.as_str();
        let lines = source.lines();
        let in_test = &source.in_test;
        for (i, line) in lines.iter().enumerate() {
            let t = line.trim();
            if in_test[i] || t.starts_with("//") {
                continue;
            }
            if !t.contains(concat!("command_no_window(", "\"git\")")) && !t.contains(concat!("Command::new(", "\"git\")")) {
                continue;
            }
            let func = enclosing_fn(&lines, i);
            match BARE_GIT_ALLOWED.iter().find(|(f, n, _)| *f == file && *n == func) {
                Some(allowed) => {
                    used.insert(*allowed);
                }
                None => offenders.push(format!("{file}:{} (fn {func}): {t}", i + 1)),
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "bare local git spawns — use commands::git::hardened_git_command_in (hookless_ in the background), \
             or allow one in BARE_GIT_ALLOWED with its reason:\n{}",
        offenders.join("\n")
    );
    let stale: Vec<_> = BARE_GIT_ALLOWED.iter().filter(|a| !used.contains(*a)).collect();
    assert!(stale.is_empty(), "BARE_GIT_ALLOWED entries that match no spawn any more: {stale:?}");
}

// ── Source scans for the file-handling classes the 2026-10-25 code screen
// found by hand (section G). Like the git-spawn scan: over every production
// file, test code skipped, a reasoned allowlist that must not go stale.

/// Raw file IO a line does, as the scans see it.
const RAW_FILE_IO: &[&str] =
    &["fs::write(", "fs::read_to_string(", "fs::read(", "File::open(", "File::create(", "OpenOptions::new("];

/// Whether `line` names a file an attacker may have replaced with a link or
/// a FIFO: a project's `.gitignore` or `project.json`, or the git dir's
/// `info/exclude`.
fn names_guarded_project_file(line: &str) -> bool {
    line.contains("\".gitignore\"")
        || line.contains("\"project.json\"")
        || line.contains("info/exclude")
        || (line.contains("\"info\"") && line.contains("\"exclude\""))
}

/// Functions of one file that name a guarded project file *and* do raw
/// file IO: `(fn name, line of the first raw IO)`. A project folder is
/// attacker-controlled (AGENTS.md), so these files are read and written
/// through `read_project_gitignore` / `write_no_follow` /
/// `git_guard::{read,edit}_info_exclude` (no-follow, bounded), whose own
/// bodies take the path as a parameter and so never name the file.
fn raw_io_on_guarded_project_files(lines: &[&str], in_test: &[bool]) -> Vec<(String, usize)> {
    let mut named: Vec<String> = Vec::new();
    let mut io: Vec<(String, usize)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if in_test[i] || line.trim_start().starts_with("//") {
            continue;
        }
        let func = enclosing_fn(lines, i);
        if names_guarded_project_file(line) {
            named.push(func.clone());
        }
        if RAW_FILE_IO.iter().any(|call| line.contains(call)) {
            io.push((func, i));
        }
    }
    let mut out: Vec<(String, usize)> = Vec::new();
    for (func, at) in io {
        if named.contains(&func) && !out.iter().any(|(f, _)| *f == func) {
            out.push((func, at));
        }
    }
    out
}

/// Functions allowed to do raw IO next to a guarded project file name:
/// `(file under src/, fn, why)`. Empty today.
const GUARDED_FILE_IO_ALLOWED: &[(&str, &str, &str)] = &[];

#[test]
fn guarded_project_files_are_only_opened_through_the_guarded_helpers() {
    let mut offenders = Vec::new();
    let mut used = std::collections::HashSet::new();
    for source in production_sources() {
        let lines = source.lines();
        for (func, at) in raw_io_on_guarded_project_files(&lines, &source.in_test) {
            match GUARDED_FILE_IO_ALLOWED.iter().find(|(f, n, _)| *f == source.rel && *n == func) {
                Some(allowed) => {
                    used.insert(*allowed);
                }
                None => offenders.push(format!("{}:{} (fn {func}): {}", source.rel, at + 1, lines[at].trim())),
            }
        }
    }
    assert!(
        offenders.is_empty(),
        ".gitignore / project.json / info/exclude opened with raw fs IO — a link or FIFO there hangs or \
             redirects it; use read_project_gitignore, write_no_follow or git_guard::{{read,edit}}_info_exclude, \
             or allow the fn in GUARDED_FILE_IO_ALLOWED with its reason:\n{}",
        offenders.join("\n")
    );
    let stale: Vec<_> = GUARDED_FILE_IO_ALLOWED.iter().filter(|a| !used.contains(*a)).collect();
    assert!(stale.is_empty(), "GUARDED_FILE_IO_ALLOWED entries that match nothing any more: {stale:?}");
}

/// The argument text of the call whose `(` is at `open`: up to its matching
/// `)`, or `None` when it never closes.
fn call_args(text: &str, open: usize) -> Option<&str> {
    let mut depth = 0usize;
    for (i, c) in text[open..].char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[open + 1..open + i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// The first top-level argument of `args`, without whitespace or a leading `&`.
fn first_arg(args: &str) -> String {
    let mut depth = 0i32;
    let mut end = args.len();
    for (i, c) in args.char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    args[..end].split_whitespace().collect::<String>().trim_start_matches('&').to_string()
}

/// Calls `name(` in `text`, as `(open paren index)`.
fn call_sites(text: &str, name: &str) -> Vec<usize> {
    let needle = format!("{name}(");
    text.match_indices(&needle)
        .filter(|(i, _)| !text[..*i].ends_with(|c: char| c.is_alphanumeric() || c == '_'))
        .map(|(i, _)| i + name.len())
        .collect()
}

/// Functions that read a JSON file with `read_json(path).unwrap_or_default()`
/// (or `unwrap_or(…)` / `unwrap_or_else(…)`) and write the same path again
/// in the same body: `(fn name, line of the read)`. A read that failed — a
/// partial write, a bad edit, an unreadable file — then reads as "empty" and
/// the write replaces the file with that. The read must tell a missing file
/// from a broken one (`read_tree_json`, an `Err` the caller returns) or the
/// write must be a `storage::patch_json` closure. `lines` is production code:
/// test lines blanked.
fn read_default_then_write_same_file(lines: &[&str]) -> Vec<(String, usize)> {
    const WRITES: &[&str] =
        &["write_json", "write_json_atomic", "write_private_atomic", "write_private_atomic_mode", "fs::write"];
    let text = lines.join("\n");
    let mut found: Vec<(String, usize)> = Vec::new();
    for open in call_sites(&text, "read_json") {
        let Some(args) = call_args(&text, open) else { continue };
        let after = text[open + args.len() + 2..].trim_start();
        if !(after.starts_with(".unwrap_or_default()")
            || after.starts_with(".unwrap_or(")
            || after.starts_with(".unwrap_or_else("))
        {
            continue;
        }
        let read_line = text[..open].matches('\n').count();
        // The fn body: from its header to the closing brace at the same indent.
        let Some(start) = (0..=read_line).rev().find(|&j| {
            let t = lines[j].trim_start();
            let head = t.split("fn ").next().unwrap_or("");
            t.contains("fn ") && head.split_whitespace().all(|w| ["pub", "pub(crate)", "pub(super)", "async", "const", "unsafe"].contains(&w))
        }) else {
            continue;
        };
        let indent = lines[start].len() - lines[start].trim_start().len();
        let end = (start + 1..lines.len())
            .find(|&k| lines[k].len() - lines[k].trim_start().len() == indent && lines[k].trim_start().starts_with('}'))
            .unwrap_or(lines.len() - 1);
        let body = lines[start..=end].join("\n");
        let path = first_arg(args);
        let writes_it = WRITES.iter().any(|w| {
            call_sites(&body, w).into_iter().any(|o| call_args(&body, o).is_some_and(|a| first_arg(a) == path))
        });
        if writes_it {
            found.push((enclosing_fn(lines, read_line), read_line));
        }
    }
    found
}

/// Functions allowed to read-default-then-write one file: `(file under
/// src/, fn, why)`. A3 of the screen fixed the stores; none is left.
const READ_DEFAULT_THEN_WRITE_ALLOWED: &[(&str, &str, &str)] = &[];

#[test]
fn no_store_reads_a_default_over_a_broken_file_and_writes_it_back() {
    let mut offenders = Vec::new();
    let mut used = std::collections::HashSet::new();
    for source in production_sources() {
        let lines = source.lines();
        let production: Vec<&str> =
            lines.iter().enumerate().map(|(i, l)| if source.in_test[i] { "" } else { *l }).collect();
        for (func, at) in read_default_then_write_same_file(&production) {
            match READ_DEFAULT_THEN_WRITE_ALLOWED.iter().find(|(f, n, _)| *f == source.rel && *n == func) {
                Some(allowed) => {
                    used.insert(*allowed);
                }
                None => offenders.push(format!("{}:{} (fn {func}): {}", source.rel, at + 1, lines[at].trim())),
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "read_json(..).unwrap_or_default() then a write of the same file — a broken file reads as empty and \
             is overwritten. Return the read error, or write through storage::patch_json; or allow the fn in \
             READ_DEFAULT_THEN_WRITE_ALLOWED with its reason:\n{}",
        offenders.join("\n")
    );
    let stale: Vec<_> = READ_DEFAULT_THEN_WRITE_ALLOWED.iter().filter(|a| !used.contains(*a)).collect();
    assert!(stale.is_empty(), "READ_DEFAULT_THEN_WRITE_ALLOWED entries that match nothing any more: {stale:?}");
}

#[test]
fn the_file_scans_catch_the_shapes_they_guard_and_only_those() {
    let guarded = "fn bad(dir: &Path) {\n    let t = fs::read_to_string(dir.join(\".gitignore\"));\n}\nfn ok(p: &Path) {\n    let t = fs::read_to_string(p);\n}\nfn other(dir: &Path) {\n    let n = dir.join(\".gitignore\");\n}\n";
    let lines: Vec<&str> = guarded.lines().collect();
    let none = vec![false; lines.len()];
    assert_eq!(raw_io_on_guarded_project_files(&lines, &none), vec![("bad".to_string(), 1)]);
    let in_test = vec![true; lines.len()];
    assert!(raw_io_on_guarded_project_files(&lines, &in_test).is_empty());
    let exclude = "fn x(git: &Path) {\n    let p = git.join(\"info\").join(\"exclude\");\n    fs::write(&p, \"\").ok();\n}\n";
    let lines: Vec<&str> = exclude.lines().collect();
    assert_eq!(raw_io_on_guarded_project_files(&lines, &vec![false; lines.len()]), vec![("x".to_string(), 2)]);

    let bad = "fn save(path: &Path) {\n    let mut v: Vec<u8> = storage::read_json(path).unwrap_or_default();\n    v.push(1);\n    storage::write_json(path, &v).ok();\n}\n";
    let lines: Vec<&str> = bad.lines().collect();
    assert_eq!(read_default_then_write_same_file(&lines), vec![("save".to_string(), 1)]);
    // Another file, no default, or a patch closure: not the class.
    let other = "fn a(p: &Path, q: &Path) {\n    let v: Vec<u8> = storage::read_json(p).unwrap_or_default();\n    storage::write_json(q, &v).ok();\n}\nfn b(p: &Path) -> Result<(), String> {\n    let v: Vec<u8> = storage::read_json(p).map_err(|e| e.to_string())?;\n    storage::write_json(p, &v).ok();\n    Ok(())\n}\nfn c(p: &Path) {\n    let v: Vec<u8> = storage::read_json(p).unwrap_or_default();\n    storage::patch_json(p, |x: &mut Vec<u8>| x.extend(v)).ok();\n}\n";
    let lines: Vec<&str> = other.lines().collect();
    assert!(read_default_then_write_same_file(&lines).is_empty());
    // Multi-line read.
    let split = "fn save(dir: &Path) {\n    let path = dir.join(\"a.json\");\n    let v: Vec<u8> = storage::read_json(&path)\n        .unwrap_or_default();\n    std::fs::write(&path, b\"\").ok();\n}\n";
    let lines: Vec<&str> = split.lines().collect();
    assert_eq!(read_default_then_write_same_file(&lines).len(), 1);
}
