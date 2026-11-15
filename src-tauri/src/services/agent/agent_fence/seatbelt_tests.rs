//! The macOS Seatbelt profile (2442n, 2442w): pure rendering checks that run
//! on every OS, then `cfg(target_os = "macos")` checks that run the real
//! `sandbox-exec` on CI's macOS runner — a profile that does not parse would
//! start no agent on any Mac, and nobody can run one locally.

use super::*;

fn line_pos(profile: &str, needle: &str) -> usize {
    profile
        .lines()
        .position(|l| l == needle)
        .unwrap_or_else(|| panic!("missing: {needle}\n{profile}"))
}

fn scope_fixture() -> SeatbeltInputs {
    SeatbeltInputs {
        home: "/Users/a".into(),
        roots: vec!["/Users/a/p".into()],
        writable: vec!["/Users/a/.claude".into(), "/private/tmp".into(), "/tmp".into()],
        readable: vec!["/Users/a/.gitconfig".into()],
        protected: vec!["/Users/a/.claude/settings.json".into()],
        hidden: vec!["/Users/a/state/mail".into(), "/var/folders/xy/T".into()],
        own_home: Some("/Users/a/state/agent-homes/p".into()),
        private_tmp: Some("/var/folders/xy/T/app-tmp/k".into()),
        ..SeatbeltInputs::default()
    }
}

#[test]
fn the_profile_denies_launches_outside_the_sandbox_before_anything_else() {
    let profile = sandbox_exec_profile(&scope_fixture());
    let lines: Vec<&str> = profile.lines().collect();
    assert_eq!(&lines[..4], ["(version 1)", "(allow default)", "(deny lsopen)", "(deny appleevent-send)"]);
    // Nothing allows either again further down.
    assert!(!profile.contains("(allow lsopen") && !profile.contains("(allow appleevent-send"), "{profile}");
}

#[test]
fn no_socket_in_the_shared_temps_home_or_docker_is_reachable_but_the_scopes_own_are() {
    let profile = sandbox_exec_profile(&scope_fixture());
    let pos = |needle: &str| line_pos(&profile, needle);
    let deny_out = |path: &str| format!("(deny network-outbound (remote unix-socket (subpath \"{path}\")))");
    let allow_out = |path: &str| format!("(allow network-outbound (remote unix-socket (subpath \"{path}\")))");
    for temp in ["/private/tmp", "/tmp", "/private/var/folders", "/var/folders"] {
        let deny = pos(&deny_out(temp));
        pos(&format!("(deny network-bind (local unix-socket (subpath \"{temp}\")))"));
        // The shared temps stay writable for files, never for sockets.
        assert!(!profile.contains(&allow_out(temp)), "{temp}\n{profile}");
        assert!(deny < pos(&allow_out("/var/folders/xy/T/app-tmp/k")));
    }
    let home = pos(&deny_out("/Users/a"));
    pos(&deny_out("/var/run/docker.sock"));
    pos(&deny_out("/private/var/run/docker.sock"));
    // Inside `(remote|local unix-socket …)` only the `subpath` filter is used:
    // it is the form the shipped profiles of other sandboxes use there, and a
    // rule that does not parse on a Mac starts no agent at all.
    for line in profile.lines().filter(|l| l.contains("unix-socket")) {
        assert!(line.contains("unix-socket (subpath \""), "{line}");
    }
    // What the fence shows anyway comes back after the home deny, the hidden
    // paths are denied again after that, then the scope's own dirs.
    let root = pos(&allow_out("/Users/a/p"));
    assert!(home < root && home < pos(&allow_out("/Users/a/.claude")) && home < pos(&allow_out("/Users/a/.gitconfig")));
    let hidden = pos(&deny_out("/Users/a/state/mail"));
    assert!(root < hidden);
    assert!(pos(&deny_out("/var/folders/xy/T")) < pos(&allow_out("/var/folders/xy/T/app-tmp/k")));
    assert!(hidden < pos(&allow_out("/Users/a/state/agent-homes/p")));
    let bind = pos("(allow network-bind (local unix-socket (subpath \"/var/folders/xy/T/app-tmp/k\")))");
    assert!(bind > pos("(deny network-bind (local unix-socket (subpath \"/var/folders\")))"));
    // Parentheses balance on every line (a stray one is a parse error on a Mac).
    for line in profile.lines() {
        assert_eq!(line.matches('(').count(), line.matches(')').count(), "{line}");
    }
}

#[test]
fn the_users_tmpdir_is_hidden_and_the_private_one_restored_after_it() {
    let profile = sandbox_exec_profile(&scope_fixture());
    let pos = |needle: &str| line_pos(&profile, needle);
    let hidden = pos("(deny file-read* file-write* (subpath \"/var/folders/xy/T\"))");
    let private = pos("(allow file-read* file-write* (subpath \"/var/folders/xy/T/app-tmp/k\"))");
    assert!(hidden < private);
    // The own home is still the last rule.
    assert_eq!(profile.lines().last(), Some("(allow file-read* file-write* (subpath \"/Users/a/state/agent-homes/p\"))"));
    assert_eq!(seatbelt_temp_dirs(Some("/var/folders/xy/abc/T/".into())), ["/private/tmp", "/tmp", "/var/folders/xy/abc/C"]);
    assert_eq!(seatbelt_temp_dirs(None), ["/private/tmp", "/tmp"]);
    assert_eq!(darwin_user_cache_dir("/tmp/T"), None, "only a per-user dir under …/folders/ has a cache sibling");
    assert_eq!(seatbelt_user_tmp_hidden(Some("/var/folders/xy/abc/T/")), ["/var/folders/xy/abc/T"]);
    assert!(seatbelt_user_tmp_hidden(Some("/")).is_empty());
    assert!(seatbelt_user_tmp_hidden(Some("relative/T")).is_empty());
    assert!(seatbelt_user_tmp_hidden(None).is_empty());
}

#[test]
fn the_private_tmp_is_per_scope_short_and_inside_the_users_tmpdir() {
    let t = "/var/folders/ab/cdefghijklmnopqrstuvwxyz0123/T/";
    let stage = Path::new("/Users/a/state/sandbox-stage/p");
    let long_scope = "7f3c2e9a-1b4d-4c8e-9f6a-2d5b8c1e0a37";
    let dir = seatbelt_private_tmp(Some(t), stage, long_scope);
    assert!(dir.starts_with("/var/folders/ab/cdefghijklmnopqrstuvwxyz0123/T"), "{dir:?}");
    // Room left for a socket name under macOS's 104-byte `sun_path`.
    assert!(dir.to_string_lossy().len() <= 80, "{dir:?}");
    assert_eq!(dir, seatbelt_private_tmp(Some(t), stage, long_scope));
    assert_ne!(dir, seatbelt_private_tmp(Some(t), stage, "other"));
    assert_eq!(seatbelt_private_tmp(None, stage, long_scope), stage.join("tmp"));
    assert_eq!(seatbelt_private_tmp(Some("relative"), stage, long_scope), stage.join("tmp"));
}

#[test]
fn every_rule_is_rendered_under_the_resolved_spelling_too() {
    let mut inputs = scope_fixture();
    inputs.roots.push("/Users/a/work/p2".into());
    // `~/work` is the user's own link to another volume: it sits above every
    // root, where no agent can write, so it is followed.
    let links = |at: &str| (at == "/Users/a/work").then(|| "/Volumes/x".to_string());
    add_canonical_spellings(&mut inputs, &links);
    // A root behind a symlink, and macOS's /var → /private/var for a path the
    // resolver saw no link on.
    assert_eq!(inputs.canonical.get("/Users/a/work/p2").map(String::as_str), Some("/Volumes/x/p2"));
    assert_eq!(
        inputs.canonical.get("/var/folders/xy/T/app-tmp/k").map(String::as_str),
        Some("/private/var/folders/xy/T/app-tmp/k")
    );
    assert!(!inputs.canonical.contains_key("/Users/a/p"), "no second spelling where there is none");
    assert!(!inputs.canonical.contains_key("/private/tmp"));
    assert!(inputs.planted.is_empty(), "{:?}", inputs.planted);
    let profile = sandbox_exec_profile(&inputs);
    let pos = |needle: &str| line_pos(&profile, needle);
    assert_eq!(pos("(allow file-write* (subpath \"/Volumes/x/p2\"))"), pos("(allow file-write* (subpath \"/Users/a/work/p2\"))") + 1);
    pos("(allow network-outbound (remote unix-socket (subpath \"/Volumes/x/p2\")))");
    pos("(deny file-read* file-write* (subpath \"/private/var/folders/xy/T\"))");
    let private = pos("(allow file-read* file-write* (subpath \"/private/var/folders/xy/T/app-tmp/k\"))");
    assert!(private > pos("(deny file-read* file-write* (subpath \"/private/var/folders/xy/T\"))"));
    // A trailing slash is dropped before matching and rendering.
    assert_eq!(resolved_spelling("/tmp/", &|_| None, &[]).as_deref(), Some("/private/tmp"));
    assert_eq!(resolved_spelling("/variable/x", &|_| None, &[]).as_deref(), Some("/variable/x"));
    // The links as a Mac has them: relative targets, `..` taken after the link.
    let mac = |at: &str| match at {
        "/var" => Some("private/var".to_string()),
        "/x/l" => Some("../y".to_string()),
        "/loop" => Some("/loop".to_string()),
        _ => None,
    };
    assert_eq!(resolve_spelling("/var/folders/xy/T", &mac, &[]).as_deref(), Some("/private/var/folders/xy/T"));
    assert_eq!(resolve_spelling("/x/l/z", &mac, &[]).as_deref(), Some("/y/z"));
    assert_eq!(resolve_spelling("/loop/z", &mac, &[]), None);
    assert_eq!(resolve_spelling("relative/x", &mac, &[]), None);
}

/// 2442w review: a fenced agent can rename a folder it may write away and
/// leave a link in its place. No allow rule may follow such a link, or the
/// next profile would hand the agent the link's target.
#[test]
fn an_allow_rule_never_follows_a_link_the_agent_could_have_planted() {
    let mut inputs = scope_fixture();
    inputs.readable.push("/Users/a/p/vendor/tool".into());
    inputs.hidden.push("/Users/a/p/secret".into());
    inputs.roots.push("/Users/a/work/p2".into());
    let links = |at: &str| match at {
        // The root and the scope home, swapped for links by an agent.
        "/Users/a/p" => Some("/Users/a".to_string()),
        "/Users/a/state/agent-homes/p" => Some("/Users/a/state".to_string()),
        // The user's own link, above every root.
        "/Users/a/work" => Some("/Volumes/x".to_string()),
        _ => None,
    };
    add_canonical_spellings(&mut inputs, &links);
    let planted: Vec<&str> = inputs.planted.iter().map(String::as_str).collect();
    assert_eq!(planted, ["/Users/a/p", "/Users/a/p/vendor/tool", "/Users/a/state/agent-homes/p"]);
    let profile = sandbox_exec_profile(&inputs);
    for line in profile.lines().filter(|l| l.starts_with("(allow")) {
        for target in ["(subpath \"/Users/a\")", "(subpath \"/Users/a/state\")", "\"/Users/a/vendor/tool\""] {
            assert!(!line.contains(target), "an allow followed a planted link: {line}");
        }
    }
    // The paths as spelled keep their rules (they match nothing while the
    // link stands), the user's own link is followed, and a denial follows
    // every link.
    line_pos(&profile, "(allow file-write* (subpath \"/Users/a/p\"))");
    line_pos(&profile, "(allow file-write* (subpath \"/Volumes/x/p2\"))");
    line_pos(&profile, "(deny file-read* file-write* (subpath \"/Users/a/secret\"))");
    assert_eq!(profile.lines().last(), Some("(allow file-read* file-write* (subpath \"/Users/a/state/agent-homes/p\"))"));

    // A link of the user's that leads into a root, then one left there.
    let chain = |at: &str| match at {
        "/Users/a/short" => Some("/Users/a/p/sub".to_string()),
        "/Users/a/p/sub" => Some("/Users/a/.ssh".to_string()),
        _ => None,
    };
    assert_eq!(resolve_spelling("/Users/a/short/x", &chain, &[]).as_deref(), Some("/Users/a/.ssh/x"));
    assert_eq!(resolve_spelling("/Users/a/short/x", &chain, &["/Users/a/p".to_string()]), None);
    // `/tmp` is writable in the fence, but the link at `/tmp` is the system's
    // (nobody writes `/`): a temp dir below it still gets its real spelling,
    // which is the only one Seatbelt matches.
    let tmp = |at: &str| (at == "/tmp").then(|| "private/tmp".to_string());
    let writable = ["/tmp".to_string(), "/private/tmp".to_string()];
    assert_eq!(resolve_spelling("/tmp/app-tmp/k", &tmp, &writable).as_deref(), Some("/private/tmp/app-tmp/k"));
    let mut under_tmp = SeatbeltInputs {
        writable: writable.to_vec(),
        hidden: vec!["/tmp".into()],
        private_tmp: Some("/tmp/app-tmp/k".into()),
        ..SeatbeltInputs::default()
    };
    add_canonical_spellings(&mut under_tmp, &tmp);
    assert!(under_tmp.planted.is_empty(), "{:?}", under_tmp.planted);
    line_pos(&sandbox_exec_profile(&under_tmp), "(allow file-read* file-write* (subpath \"/private/tmp/app-tmp/k\"))");
    // By the place's resolved location too, whatever the case of the spelling.
    assert_eq!(resolve_spelling("/users/A/short/x", &|at| chain(&at.replace("/users/A", "/Users/a")), &["/Users/a/P".to_string()]), None);
}

/// 2442n review: `realpath`, git and Node `lstat` every folder on the way to
/// a path and fail on the first they may not. The folders between a hidden
/// region and something shown inside it answer `lstat`, and nothing else.
#[test]
fn the_folders_above_what_is_shown_answer_lstat_and_nothing_else() {
    let mut inputs = scope_fixture();
    inputs.roots.push("/Users/a/code/deep/p2".into());
    add_canonical_spellings(&mut inputs, &|_| None);
    let profile = sandbox_exec_profile(&inputs);
    let lines: Vec<&str> = profile.lines().collect();
    let stat = |dir: &str| format!("(allow file-read-metadata (literal \"{dir}\"))");
    let last_hidden = lines.iter().rposition(|l| l.starts_with("(deny file-read* file-write*")).unwrap();
    for dir in [
        // A project two folders below the home.
        "/Users/a/code",
        "/Users/a/code/deep",
        // The scope home inside the hidden homes tree.
        "/Users/a/state",
        "/Users/a/state/agent-homes",
        // The private temp dir inside the user's hidden `$TMPDIR`, both spellings.
        "/var/folders/xy/T",
        "/var/folders/xy/T/app-tmp",
        "/private/var/folders/xy/T",
        "/private/var/folders/xy/T/app-tmp",
    ] {
        assert!(line_pos(&profile, &stat(dir)) > last_hidden, "{dir} must come after the hidden denials");
    }
    // Not a folder outside every hidden region, not what is shown anyway, not
    // a hidden folder nothing shown sits in.
    for dir in ["/Users", "/var/folders/xy", "/private/var/folders/xy", "/private", "/Users/a/p", "/Users/a/code/deep/p2", "/Users/a/state/mail"] {
        assert!(!profile.contains(&stat(dir)), "{dir}\n{profile}");
    }
    // Only the entry itself, never what is below it, and the scope's own
    // dirs still close the profile.
    assert!(!profile.contains("(allow file-read-metadata (subpath"), "{profile}");
    assert_eq!(lines.last(), Some(&"(allow file-read* file-write* (subpath \"/Users/a/state/agent-homes/p\"))"));
}

#[cfg(unix)]
#[test]
fn canonical_spellings_follow_a_real_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().join("real");
    std::fs::create_dir_all(real.join("child")).unwrap();
    let link = tmp.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    // A root below a link: the link is not the agent's to change.
    let root = link.join("child").to_string_lossy().into_owned();
    let mut inputs = SeatbeltInputs { roots: vec![root.clone()], ..SeatbeltInputs::default() };
    add_canonical_spellings(&mut inputs, &seatbelt_read_link);
    let want = real.canonicalize().unwrap();
    assert_eq!(inputs.canonical.get(&root), Some(&want.join("child").to_string_lossy().into_owned()));
    assert!(inputs.planted.is_empty(), "{:?}", inputs.planted);
    // The root itself a link: an agent can leave one there, so its target is
    // never allowed.
    let link = link.to_string_lossy().into_owned();
    let mut swapped = SeatbeltInputs { roots: vec![link.clone()], ..SeatbeltInputs::default() };
    add_canonical_spellings(&mut swapped, &seatbelt_read_link);
    assert!(swapped.planted.contains(&link), "{:?}", swapped.planted);
    let allowed = format!("(allow file-write* (subpath {}))", sbpl_string(&want.to_string_lossy()));
    assert!(!sandbox_exec_profile(&swapped).contains(&allowed));
}

/// The env step runs here as it does inside the profile: no ssh-agent, the
/// private `TMPDIR`, and a command path with `=` and a space kept one word.
#[cfg(unix)]
#[test]
fn the_launch_step_drops_the_ssh_agent_and_sets_the_private_tmpdir() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("a=b c");
    std::fs::create_dir(&dir).unwrap();
    let script = dir.join("cli");
    std::fs::write(&script, "#!/bin/sh\nprintf '%s|' \"$@\"; printf 'sock=%s|tmp=%s|pid=%s' \"${SSH_AUTH_SOCK-unset}\" \"$TMPDIR\" \"${SSH_AGENT_PID-unset}\"\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let argv = seatbelt_argv("/p/fence.sb", "/priv/tmp", &script.to_string_lossy(), &["--x".into(), "two words".into()]);
    assert_eq!(&argv[..2], ["-f", "/p/fence.sb"]);
    let out = std::process::Command::new(&argv[2])
        .args(&argv[3..])
        .env("SSH_AUTH_SOCK", "/private/tmp/com.apple.launchd.x/Listeners")
        .env("SSH_AGENT_PID", "42")
        .env("TMPDIR", "/var/folders/xy/T/")
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    assert_eq!(String::from_utf8_lossy(&out.stdout), "--x|two words|sock=unset|tmp=/priv/tmp|pid=unset");
}

// ── the real sandbox-exec (CI's macOS runner) ───────────────────────────

#[cfg(target_os = "macos")]
mod real {
    use super::*;
    use std::process::{Command, Output};
    use std::time::{Duration, Instant};

    struct Fence {
        _base: tempfile::TempDir,
        root: PathBuf,
        outside: PathBuf,
        private_tmp: String,
        profile: PathBuf,
        /// The shim dir, first on PATH as `agent_bin::bin_dir` is in a tab.
        bin: PathBuf,
    }

    /// A scope profile built the way a tab's is: a fake home with a root in
    /// it, a folder outside every root, the user's real `$TMPDIR` hidden and
    /// the scope's private temp dir, canonical spellings added. Under the
    /// crate dir, not `$TMPDIR` — that is what the profile hides.
    fn fence() -> Fence {
        fence_in(&["r"])
    }

    /// [`fence`] with the root at `root` below the fake home.
    fn fence_in(root: &[&str]) -> Fence {
        let base = tempfile::Builder::new().prefix(".sbt").tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let home = base.path().join("h");
        let root = root.iter().fold(home.clone(), |dir, name| dir.join(name));
        let outside = home.join("o");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let user_tmp = std::env::var("TMPDIR").ok();
        let scope = format!("seatbelt-test-{}-{}", std::process::id(), base.path().display());
        let private_tmp = seatbelt_private_tmp(user_tmp.as_deref(), &base.path().join("stage"), &scope);
        ensure_private_tmp(&private_tmp).unwrap();
        let mut inputs = SeatbeltInputs {
            home: home.to_string_lossy().into_owned(),
            roots: vec![root.to_string_lossy().into_owned()],
            writable: seatbelt_temp_dirs(user_tmp.clone()),
            hidden: seatbelt_user_tmp_hidden(user_tmp.as_deref()),
            private_tmp: Some(private_tmp.to_string_lossy().into_owned()),
            ..SeatbeltInputs::default()
        };
        let bin = base.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let shim = bin.join("mktemp");
        std::fs::write(&shim, crate::services::agent_bin::mktemp_shim_script()).unwrap();
        let exec = <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755);
        std::fs::set_permissions(&shim, exec).unwrap();
        inputs.readable.push(bin.to_string_lossy().into_owned());
        add_canonical_spellings(&mut inputs, &seatbelt_read_link);
        let profile = base.path().join("fence.sb");
        std::fs::write(&profile, sandbox_exec_profile(&inputs)).unwrap();
        Fence { _base: base, root, outside, private_tmp: private_tmp.to_string_lossy().into_owned(), profile, bin }
    }

    fn wait(mut child: std::process::Child, limit: Duration) -> Option<Output> {
        let start = Instant::now();
        loop {
            if child.try_wait().unwrap().is_some() {
                return Some(child.wait_with_output().unwrap());
            }
            if start.elapsed() > limit {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    impl Fence {
        fn command(&self, cmd: &str, args: &[&str]) -> Command {
            let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            let mut command = Command::new("/usr/bin/sandbox-exec");
            command
                .args(seatbelt_argv(&self.profile.to_string_lossy(), &self.private_tmp, cmd, &args))
                .env(crate::app_env!("AGENT_FENCE"), "1")
                .env("PATH", format!("{}:{}", self.bin.display(), std::env::var("PATH").unwrap_or_default()))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            command
        }

        /// `None` when it was still running after `limit` (killed).
        fn run(&self, cmd: &str, args: &[&str], limit: Duration) -> Option<Output> {
            wait(self.command(cmd, args).spawn().unwrap(), limit)
        }

        fn sh(&self, script: &str) -> Output {
            self.run("/bin/sh", &["-c", script], Duration::from_secs(60)).expect("sh timed out")
        }
    }

    #[test]
    fn the_real_profile_parses_and_runs_true() {
        assert!(bwrap_available(), "the probe profile, escape denials included, must parse");
        let f = fence();
        let out = f.run("/usr/bin/true", &[], Duration::from_secs(60)).unwrap();
        assert!(out.status.success(), "{}\n{}", String::from_utf8_lossy(&out.stderr), std::fs::read_to_string(&f.profile).unwrap());
    }

    #[test]
    fn a_write_in_the_root_succeeds_and_one_outside_or_in_the_users_tmpdir_fails() {
        let f = fence();
        let inside = f.root.join("ok.txt");
        let out = f.sh(&format!("echo ok > '{}'", inside.display()));
        assert!(out.status.success(), "{out:?}");
        assert_eq!(std::fs::read_to_string(&inside).unwrap(), "ok\n");
        let outside = f.outside.join("no.txt");
        let out = f.sh(&format!("echo no > '{}'", outside.display()));
        assert!(!out.status.success() && !outside.exists(), "{out:?}");
        // The user's own $TMPDIR is hidden; the agent's TMPDIR is its own.
        if let Ok(user_tmp) = std::env::var("TMPDIR") {
            let probe = Path::new(&user_tmp).join(format!("fence-probe-{}", std::process::id()));
            let out = f.sh(&format!("echo no > '{}'", probe.display()));
            assert!(!out.status.success() && !probe.exists(), "{out:?}");
        }
        // Through the shim: macOS's own mktemp asks the system for the
        // (hidden) user temp dir and never reads $TMPDIR.
        let out = f.sh("f=$(mktemp) && echo hi > \"$f\" && echo \"$f\"");
        assert!(out.status.success(), "{out:?}");
        let made = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let private = Path::new(&f.private_tmp).canonicalize().unwrap();
        assert!(Path::new(&made).canonicalize().unwrap().starts_with(&private), "{made} not in {}", private.display());
    }

    /// A project that is not directly in the home, and the private temp dir
    /// inside the hidden `$TMPDIR`: the folders above them answer `stat`
    /// (git resolves its work tree one folder at a time) but are not listed
    /// and nothing else in them is read.
    #[test]
    fn the_folders_above_a_root_and_the_private_tmp_answer_stat_only() {
        let f = fence_in(&["x", "r"]);
        let between = f.root.parent().unwrap();
        let secret = between.join("secret.txt");
        std::fs::write(&secret, "s").unwrap();
        let out = f.sh(&format!("/usr/bin/stat -f %N '{}' \"$TMPDIR/..\" \"$TMPDIR/../..\"", between.display()));
        assert!(out.status.success(), "{out:?}");
        let out = f.sh(&format!("/bin/ls '{}' || /bin/cat '{}'", between.display(), secret.display()));
        assert!(!out.status.success(), "a folder above the root was listed or read: {out:?}");
        let git = format!("cd '{}' && /usr/bin/git init -q . && /usr/bin/git rev-parse --show-toplevel", f.root.display());
        let out = f.run("/bin/sh", &["-c", &git], Duration::from_secs(120)).expect("git timed out");
        assert!(out.status.success(), "{out:?}");
    }

    #[test]
    fn the_ssh_agent_is_not_in_the_environment_inside() {
        let f = fence();
        let mut command = f.command("/bin/sh", &["-c", "test -z \"${SSH_AUTH_SOCK-}\" && test \"$TMPDIR\" = \"$0\"", &f.private_tmp]);
        command.env("SSH_AUTH_SOCK", "/private/tmp/com.apple.launchd.test/Listeners");
        // `sh -c` takes the private dir as $0 here; the step set TMPDIR to it.
        let out = wait(command.spawn().unwrap(), Duration::from_secs(60)).unwrap();
        assert!(out.status.success(), "{out:?}");
    }

    /// Whether a sandboxed `nc -U` reaches a listener at `path`.
    fn reaches(f: &Fence, path: &Path, sandboxed: bool) -> bool {
        let listener = std::os::unix::net::UnixListener::bind(path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let path_s = path.to_string_lossy().into_owned();
        let child = if sandboxed {
            f.command("/usr/bin/nc", &["-U", &path_s]).spawn().unwrap()
        } else {
            Command::new("/usr/bin/nc").args(["-U", &path_s]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap()
        };
        let start = Instant::now();
        let mut reached = false;
        while start.elapsed() < Duration::from_secs(5) {
            if listener.accept().is_ok() {
                reached = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(listener);
        let _ = wait(child, Duration::from_secs(5));
        let _ = std::fs::remove_file(path);
        reached
    }

    #[test]
    fn a_socket_in_the_shared_tmp_is_out_of_reach_and_one_in_the_root_is_not() {
        let f = fence();
        let shared = PathBuf::from(format!("/private/tmp/sbt-{}.sock", std::process::id()));
        assert!(reaches(&f, &shared, false), "control: nc reaches the socket unsandboxed");
        assert!(!reaches(&f, &shared, true), "a fenced agent reached a socket in the shared /tmp");
        let in_root = f.root.join("s.sock");
        assert!(reaches(&f, &in_root, true), "a socket inside the root must stay reachable");
    }

    #[test]
    fn open_and_apple_events_start_nothing_outside_the_sandbox() {
        let f = fence();
        let out = f.run("/usr/bin/open", &["-g", "-j", "-a", "Calculator"], Duration::from_secs(30));
        let launched = out.as_ref().is_some_and(|o| o.status.success());
        if launched {
            let _ = Command::new("/usr/bin/pkill").args(["-x", "Calculator"]).status();
        }
        assert!(!launched, "LaunchServices launched an app from inside the fence: {out:?}");
        let out = f
            .run("/usr/bin/osascript", &["-e", "tell application \"Finder\" to get name of startup disk"], Duration::from_secs(30))
            .expect("a denied Apple Event fails at once; a hang means it reached the consent prompt");
        assert!(!out.status.success(), "an Apple Event left the fence: {out:?}");
    }

    /// The fence must stay usable: git (the Xcode shim) and DNS + TLS through
    /// curl, which needs `mDNSResponder`'s socket outside the shared temps.
    #[test]
    fn git_and_a_network_fetch_still_work_inside() {
        let f = fence();
        let out = f.run("/usr/bin/git", &["--version"], Duration::from_secs(120)).unwrap();
        assert!(out.status.success(), "{out:?}");
        let out = f
            .run("/usr/bin/curl", &["-sS", "-m", "30", "-o", "/dev/null", "https://github.com"], Duration::from_secs(60))
            .unwrap();
        assert!(out.status.success(), "{out:?}");
    }
}
