use super::*;
use crate::schema::boxes::ProjectBox;
use serde_json::{json, Value};

// ── spawn generations (gap 18) ──────────────────────────────────────────

#[test]
fn a_stale_teardown_leaves_the_respawns_registration_and_proxy_tokens() {
    let tab = "gen-p:stale";
    let old = begin_spawn(tab);
    assert!(register_tab(tab, Some("gen-p"), old));
    // The unmount's kill took the old PTY; the remount's spawn begins and
    // is handed its proxy token before the kill's teardown lands.
    let new = begin_spawn(tab);
    let token = crate::services::api_proxy::issue_for_test("gen-p", tab).unwrap();
    assert!(!on_tab_gone(tab, old), "a teardown of the older spawn is stale");
    assert!(crate::services::api_proxy::token_live(&token));
    assert!(register_tab(tab, Some("gen-p"), new), "the respawn commits");
    assert!(!on_tab_gone(tab, old), "still stale after the commit");
    assert_eq!(fenced_scope_of_tab(tab).as_deref(), Some("gen-p"));
    assert!(crate::services::api_proxy::token_live(&token));
    // The respawn's own teardown takes it all.
    assert!(on_tab_gone(tab, new));
    assert_eq!(fenced_scope_of_tab(tab), None);
    assert!(!crate::services::api_proxy::token_live(&token));
    // Nothing registered any more: a repeat teardown counts as current.
    assert!(on_tab_gone(tab, new));
}

#[test]
fn a_kill_of_an_uncommitted_spawn_beats_its_commit() {
    let tab = "gen-p:uncommitted";
    let seq = begin_spawn(tab);
    assert!(on_tab_gone(tab, seq));
    assert!(!register_tab(tab, Some("gen-p"), seq), "the process is gone already");
    assert_eq!(fenced_scope_of_tab(tab), None);
}

#[test]
fn an_abandoned_spawn_falls_back_to_the_live_one() {
    let tab = "gen-p:abandon";
    let live = begin_spawn(tab);
    assert!(register_tab(tab, Some("gen-p"), live));
    let failed = begin_spawn(tab);
    abandon_spawn(tab, failed);
    assert_eq!(fenced_scope_of_tab(tab).as_deref(), Some("gen-p"));
    assert!(on_tab_gone(tab, live), "the live spawn is the newest again");
    // A first spawn that fails leaves nothing, its proxy token included.
    let only = begin_spawn(tab);
    let token = crate::services::api_proxy::issue_for_test("gen-p", tab).unwrap();
    abandon_spawn(tab, only);
    assert!(!crate::services::api_proxy::token_live(&token));
    assert!(!register_tab(tab, None, only));
}

#[test]
fn a_live_spawn_names_its_vibe_home_until_it_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("vibe_local").join("llama3");
    let tab = "gen-p:vibe-home";
    let seq = begin_spawn(tab);
    note_vibe_home(tab, seq, &home);
    assert!(live_tabs_in_vibe_home(&home).is_empty(), "not live before the commit");
    assert!(register_tab(tab, None, seq));
    note_vibe_home(tab, seq + 1_000_000, &home);
    assert!(live_tabs_in_vibe_home(&home).is_empty(), "another spawn's note is ignored");
    note_vibe_home(tab, seq, &home);
    assert_eq!(live_tabs_in_vibe_home(&home), vec![tab.to_string()]);
    assert!(live_tabs_in_vibe_home(&dir.path().join("vibe_local").join("other")).is_empty());
    assert!(on_tab_gone(tab, seq));
    assert!(live_tabs_in_vibe_home(&home).is_empty());
}

#[test]
fn an_unfenced_spawn_registers_without_a_scope() {
    let tab = "gen-p:unfenced";
    let seq = begin_spawn(tab);
    assert!(register_tab(tab, None, seq));
    assert_eq!(fenced_scope_of_tab(tab), None);
    assert!(on_tab_gone(tab, seq));
}

#[test]
fn a_failed_probe_under_the_userns_profile_names_the_namespace_not_the_package() {
    // The Mobile sidecar's case: bwrap installed and root-owned, the
    // window fencing fine, and the probe still failing because systemd put
    // the service in a user namespace Ubuntu's AppArmor confines.
    let note = probe_failure_note(
        "bwrap: No permissions to create a new namespace\n",
        Some("unprivileged_userns (enforce)\n"),
    );
    assert!(note.contains("unprivileged_userns (enforce)"), "{note}");
    assert!(note.contains("No permissions to create a new namespace"), "{note}");
    assert!(note.contains("mount-namespace directive"), "{note}");
    // An unconfined process that fails gets bwrap's words and no such guess.
    let plain = probe_failure_note("", Some("unconfined\n"));
    assert!(plain.contains("unconfined"), "{plain}");
    assert!(plain.contains("no output"), "{plain}");
    assert!(!plain.contains("mount-namespace"), "{plain}");
    assert!(probe_failure_note("x", None).contains("label of this process: unknown"));
}

#[cfg(target_os = "linux")]
#[test]
fn the_keyring_table_matches_the_native_syscall_numbers() {
    let (_, _, native, ioctl) = KEYRING_SYSCALLS[0];
    assert_eq!(
        native.map(i64::from),
        [libc::SYS_add_key, libc::SYS_request_key, libc::SYS_keyctl].map(i64::from)
    );
    assert_eq!([ioctl].map(i64::from), [libc::SYS_ioctl].map(i64::from));
    assert_eq!([libc::TIOCSTI as u32, libc::TIOCLINUX as u32], [0x5412, 0x541C]);
}

/// Loads the real program into a child and calls the keyring from there:
/// every keyring syscall is refused, and the `exec` and shell that follow
/// (everything else) still run.
#[cfg(target_os = "linux")]
#[test]
fn the_keyring_filter_denies_the_keyring_and_nothing_else() {
    use std::os::unix::process::CommandExt;
    let prog = keyring_seccomp_filter().expect("a filter for this architecture");
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.args(["-c", "exit 7"]);
    // SAFETY: only syscalls between fork and exec; `prog` was built before.
    unsafe {
        cmd.pre_exec(move || {
            let fprog = libc::sock_fprog {
                len: (prog.len() / 8) as u16,
                filter: prog.as_ptr() as *mut libc::sock_filter,
            };
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                || libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &fprog) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let denied = |r: libc::c_long| {
                r == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
            };
            let session: libc::c_long = -3; // KEY_SPEC_SESSION_KEYRING
            let calls = [
                libc::syscall(libc::SYS_keyctl, 0 as libc::c_long, session, 0 as libc::c_long),
                libc::syscall(libc::SYS_add_key, c"user".as_ptr(), c"probe".as_ptr(), c"x".as_ptr(), 1usize, session),
                libc::syscall(libc::SYS_request_key, c"user".as_ptr(), c"probe".as_ptr(), 0usize, 0 as libc::c_long),
            ];
            // Read before the `ioctl`s below overwrite `errno`.
            let keyring_denied = calls.iter().all(|r| denied(*r));
            // An invalid descriptor, so that no terminal can be touched even
            // if a request got through: the filter answers before the kernel
            // looks at the descriptor, which is what tells them apart.
            let tty = |request: libc::c_ulong| libc::ioctl(-1, request, 0 as libc::c_long);
            let sti = denied(tty(libc::TIOCSTI).into());
            let linux = denied(tty(libc::TIOCLINUX).into());
            let other = tty(libc::TIOCGWINSZ);
            let other_allowed = other == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF);
            if keyring_denied && sti && linux && other_allowed {
                Ok(())
            } else {
                Err(std::io::Error::from_raw_os_error(libc::EBADMSG))
            }
        });
    }
    let status = cmd.status().expect("the filtered child refused a keyring call and exec'd");
    assert_eq!(status.code(), Some(7));
}

#[cfg(unix)]
#[test]
fn the_seccomp_launcher_hands_bwrap_the_filter_on_fd_9() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let filter = dir.path().join("filter.bpf");
    std::fs::write(&filter, b"program bytes").unwrap();
    let fake = dir.path().join("bwrap");
    std::fs::write(&fake, "#!/bin/sh\ncat <&9 >\"$OUT/fd9\"\nprintf '%s\\n' \"$@\" >\"$OUT/args\"\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let argv = vec!["--ro-bind".to_string(), "/a b".to_string(), "--".to_string(), "it's".to_string()];
    let (cmd, args) = seccomp_launcher(&fake.to_string_lossy(), None, &filter, argv.clone());
    assert_eq!(cmd, "/bin/sh");
    let status = std::process::Command::new(cmd).args(args).env("OUT", dir.path()).status().unwrap();
    assert!(status.success());
    assert_eq!(std::fs::read(dir.path().join("fd9")).unwrap(), b"program bytes");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("args")).unwrap(),
        "--seccomp\n9\n--ro-bind\n/a b\n--\nit's\n"
    );
    // With a step, it runs first and is handed its mode, bwrap and fd 9.
    for mode in ["--fence-scope", crate::services::agent_exec::MODE_FLAG] {
        std::fs::remove_file(dir.path().join("fd9")).unwrap();
        let fake = fake.to_string_lossy();
        let (cmd, args) = seccomp_launcher("/usr/bin/bwrap", Some((&fake, mode)), &filter, argv.clone());
        let status = std::process::Command::new(cmd).args(args).env("OUT", dir.path()).status().unwrap();
        assert!(status.success());
        assert_eq!(std::fs::read(dir.path().join("fd9")).unwrap(), b"program bytes");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("args")).unwrap(),
            format!("{mode}\n/usr/bin/bwrap\n--seccomp\n9\n--ro-bind\n/a b\n--\nit's\n")
        );
    }
}

#[test]
fn a_carried_secret_gets_the_exec_step_even_without_the_scope() {
    let bin = || "/opt/app/bin".to_string();
    // The scope's helper maps carriers too, so it is the one step.
    assert_eq!(
        launcher_step(Some("/proc/1/exe".into()), true, bin),
        Some(("/proc/1/exe".to_string(), "--fence-scope"))
    );
    assert_eq!(
        launcher_step(Some("/proc/1/exe".into()), false, bin),
        Some(("/proc/1/exe".to_string(), "--fence-scope"))
    );
    // No Landlock scope here: a carried secret still gets mapped.
    assert_eq!(
        launcher_step(None, true, bin),
        Some(("/opt/app/bin".to_string(), crate::services::agent_exec::MODE_FLAG))
    );
    // Nothing to map, nothing in front of bwrap (as before).
    assert_eq!(launcher_step(None, false, || unreachable!()), None);
}

#[test]
fn bwrap_masks_the_keyring_listing() {
    let out = bwrap_args("/home/u", None, "/p", "sh", &[], &[], &[], &[]);
    for file in ["/proc/keys", "/proc/key-users"] {
        let at = out.iter().position(|a| a == file).unwrap();
        assert_eq!(&out[at - 2..at], ["--ro-bind", "/dev/null"]);
    }
    let proc_mount = out.windows(2).position(|p| p == ["--proc", "/proc"]).unwrap();
    assert!(proc_mount < out.iter().position(|a| a == "/proc/keys").unwrap());
}

fn proc_(argv0: &str, argv1: Option<&str>, host_ns: bool) -> ProcView {
    ProcView {
        argv0: argv0.to_string(),
        argv1: argv1.map(str::to_string),
        host_ns,
    }
}

#[test]
fn a_host_namespace_agent_is_unfenced() {
    // The shape of a tab started while the fence was off: tmux's pane shell
    // runs the agent directly.
    let procs = [
        proc_("bash", Some("-c"), true),
        proc_("claude", Some("--session-id"), true),
    ];
    assert_eq!(classify_live("claude", &procs), LiveFence::Unfenced);
}

#[test]
fn a_fenced_agent_is_judged_by_itself_not_by_its_bwrap_parent() {
    let procs = [
        proc_("bash", Some("-c"), true),
        proc_("bwrap", Some("--ro-bind"), true),
        proc_("bwrap", Some("--ro-bind"), false),
        proc_("/home/u/.local/bin/claude", Some("--resume"), false),
    ];
    assert_eq!(classify_live("claude", &procs), LiveFence::Fenced);
}

#[test]
fn an_unfenced_agents_own_sandboxed_child_does_not_make_it_fenced() {
    let procs = [
        proc_("codex", None, true),
        proc_("codex", Some("--sandbox-child"), false),
    ];
    assert_eq!(classify_live("codex", &procs), LiveFence::Unfenced);
}

#[test]
fn an_interpreter_run_agent_is_recognised() {
    let procs = [proc_("node", Some("/home/u/.nvm/bin/gemini"), true)];
    assert_eq!(classify_live("/usr/bin/gemini", &procs), LiveFence::Unfenced);
}

#[test]
fn a_tab_whose_agent_exited_counts_neither_way() {
    // The pane falls back to a login shell once the agent quits.
    let procs = [proc_("-bash", None, true), proc_("vim", Some("notes"), true)];
    assert_eq!(classify_live("claude", &procs), LiveFence::Idle);
    assert_eq!(classify_live("claude", &[]), LiveFence::Idle);
}

#[test]
fn tmux_pane_pids_parse_and_keep_the_first_pane() {
    let panes = parse_tmux_pane_pids(concat!(crate::app_slug!(), "-a--agent-1\t100\n", crate::app_slug!(), "-a--agent-1\t200\nbad line\nx\tnope\n"));
    assert_eq!(panes.get(concat!(crate::app_slug!(), "-a--agent-1")), Some(&100));
    assert_eq!(panes.len(), 1);
}

#[test]
fn an_unavailable_tool_is_retried_and_success_is_cached() {
    let cache = Mutex::new(false);
    assert!(!probe_until_available(&cache, || false));
    assert!(probe_until_available(&cache, || true));
    assert!(probe_until_available(&cache, || panic!("successful probe must be cached")));
}

/// `root_fence_projects_readable`: on, every project directory, box folder
/// and remote mirror reaches a root spawn's argv as `--ro-bind-try` and
/// never as a `--bind`; off, none of them appears; a project scope's roots
/// are the same either way. Unix paths: the fence exists on Linux/macOS only.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn the_root_fence_exposes_projects_read_only_only_when_switched_on() {
    let projects: ProjectsList = serde_json::from_str(
        r#"[{"id":"p1","name":"Alpha","status":"active","position":0,"local_file":"","directory":"/w/alpha"},
                {"id":"p2","name":"Beta","status":"active","position":1,"local_file":"","remote":{"host":"h"},"mirror":"/w/beta-mirror"},
                {"id":"p3","name":"Gamma","status":"active","position":2,"local_file":"","remote":{"host":"h"}}]"#,
    )
    .unwrap();
    let boxes: BoxesList = serde_json::from_str(
        r#"[{"id":"b1","name":"Box","member_ids":["p1"],"position":0,"folder":"/w/box"}]"#,
    )
    .unwrap();
    let state = Path::new("/state");
    let off = crate::schema::Settings::default();
    assert!(root_project_read_only_paths(&off, &projects, &boxes, state).is_empty());
    let on: crate::schema::Settings =
        serde_json::from_str(r#"{"root_fence_projects_readable":true}"#).unwrap();
    let paths = root_project_read_only_paths(&on, &projects, &boxes, state);
    assert_eq!(
        paths,
        ["/w/alpha", "/w/beta-mirror", "/state/remote-projects/p3/mirror", "/w/box"],
        "a remote project's mirror, never its remote directory string"
    );
    let args = bwrap_args("/home/u", None, concat!("/home/u/", crate::app_slug!(), "/root"), "claude", &[], &[PathBuf::from(concat!("/home/u/", crate::app_slug!(), "/root"))], &paths, &[]);
    for p in &paths {
        assert!(args.windows(3).any(|w| w[0] == "--ro-bind-try" && w[1] == *p && w[2] == *p), "{p} not read-only: {args:?}");
        assert!(!args.windows(2).any(|w| (w[0] == "--bind" || w[0] == "--bind-try") && w[1] == *p), "{p} bound read-write");
    }
    let plain = bwrap_args("/home/u", None, concat!("/home/u/", crate::app_slug!(), "/root"), "claude", &[], &[PathBuf::from(concat!("/home/u/", crate::app_slug!(), "/root"))], &[], &[]);
    assert!(!plain.iter().any(|a| a == "/w/alpha"));
    // A project scope: the flag changes nothing about its roots.
    assert_eq!(compute_fence_roots(&boxes, &projects, "p1", true), Some(vec![PathBuf::from("/w/alpha"), PathBuf::from("/w/box")]));
}

/// #158: the pin and the read-only control binds land after the root's
/// read-write grant (bubblewrap applies mounts in argv order, later wins)
/// and before `--`, pin first so the read-only binds sit inside it.
#[test]
fn git_control_files_are_rebound_read_only_after_the_root_grant() {
    let mut args = bwrap_args("/home/u", None, "/p", "claude", &[], &[PathBuf::from("/p")], &[], &[]);
    guard_git_control(
        &mut args,
        crate::services::git_guard::GuardPaths {
            pinned: vec![PathBuf::from("/p/.git")],
            read_only: vec![PathBuf::from("/p/.git/config"), PathBuf::from("/p/.git/hooks")],
        },
    );
    let at = |flag: &str, path: &str| {
        args.windows(3)
            .position(|w| w[0] == flag && w[1] == path && w[2] == path)
            .unwrap_or_else(|| panic!("{flag} {path} missing: {args:?}"))
    };
    let grant = at("--bind-try", "/p");
    let pin = at("--bind", "/p/.git");
    let config = at("--ro-bind", "/p/.git/config");
    let hooks = at("--ro-bind", "/p/.git/hooks");
    let separator = args.iter().position(|a| a == "--").unwrap();
    assert!(grant < pin && pin < config && config < hooks && hooks < separator);
    assert_eq!(args[separator + 1], "claude");
}

#[test]
fn cargo_tokens_are_masked_after_root_grants_and_opt_in_removes_masks() {
    let home = tempfile::tempdir().unwrap();
    let cargo = home.path().join(".cargo");
    std::fs::create_dir(&cargo).unwrap();
    for name in ["credentials", "credentials.toml"] {
        std::fs::write(cargo.join(name), "fixture registry token").unwrap();
    }
    let hidden = cargo_credential_paths(home.path(), Some(Path::new("custom-cargo")), home.path(), false);
    // Joined per component: a literal "custom-cargo/credentials.toml" keeps its `/`
    // on Windows, where the function under test produces a `\` path.
    assert!(hidden.contains(&home.path().join("custom-cargo").join("credentials.toml").to_string_lossy().into_owned()));
    let mut args = bwrap_args("/home/u", None, "/p", "codex", &[], &[home.path().to_owned()], &[], &[]);
    mask_cargo_credentials(&mut args, hidden.clone());
    let grant = args.iter().position(|a| a == "--bind-try").unwrap();
    for name in ["credentials", "credentials.toml"] {
        let path = cargo.join(name).to_string_lossy().into_owned();
        let mask = args.iter().position(|a| a == &path).unwrap();
        assert!(mask > grant);
        assert_eq!(&args[mask - 2..mask], &["--ro-bind", "/dev/null"]);
        assert_eq!(std::fs::read_to_string(cargo.join(name)).unwrap(), "fixture registry token");
    }
    assert!(cargo_credential_paths(home.path(), Some(&cargo), home.path(), true).is_empty());
    let profile = sandbox_exec_profile(&SeatbeltInputs {
        home: home.path().to_string_lossy().into_owned(),
        readable: vec![cargo.to_string_lossy().into_owned()],
        hidden,
        ..Default::default()
    });
    assert!(profile.rfind("(deny file-read* file-write*").unwrap() > profile.rfind("(allow file-read*").unwrap());
}

#[cfg(unix)]
#[test]
fn cargo_masks_include_symlink_targets() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join(".cargo")).unwrap();
    let target = home.path().join("registry-secret");
    std::fs::write(&target, "fixture").unwrap();
    std::os::unix::fs::symlink(&target, home.path().join(".cargo/credentials.toml")).unwrap();
    let paths = cargo_credential_paths(home.path(), None, home.path(), false);
    assert!(paths.contains(&target.canonicalize().unwrap().to_string_lossy().into_owned()));
}

#[test]
fn state_is_masked_after_overlapping_project_grants() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    std::fs::create_dir_all(state.join("hooks")).unwrap();
    std::fs::write(state.join("calendar.json"), "secret").unwrap();
    let mut args = vec!["--bind".into(), dir.path().display().to_string(), dir.path().display().to_string(), "--".into(), "agent".into()];
    let hook = state.join("hooks").display().to_string();
    mask_private_state(&mut args, &state, &[BindMount { src: hook.clone(), dst: hook.clone(), read_only: true }]);
    let mask = args.iter().position(|a| a == "--tmpfs").unwrap();
    assert!(mask > 2);
    assert!(args.iter().rposition(|a| a == &hook).unwrap() > mask);
    assert!(args.iter().position(|a| a == "--").unwrap() > mask);
    assert!(private_state_paths(&state).contains(&state.join("calendar.json")));
}

#[test]
fn owned_installs_survive_the_final_state_mask_read_only() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let install = crate::services::agent_install::install_root_in(&state);
    let command = install.join("bin/agent");
    std::fs::create_dir_all(command.parent().unwrap()).unwrap();
    std::fs::write(&command, "fixture").unwrap();
    std::fs::create_dir_all(state.join("agent-global")).unwrap();
    let mut support = Vec::new();
    add_install_mount(&mut support, &state);
    let mut args = bwrap_args(
        "/home/u", None, "/p", &command.to_string_lossy(), &[],
        std::slice::from_ref(&state), &[], &support,
    );
    mask_private_state(&mut args, &state, &support);
    let state_s = state.to_string_lossy();
    let install_s = install.to_string_lossy();
    let mask = args.windows(2).rposition(|w| w[0] == "--tmpfs" && w[1] == state_s).unwrap();
    let restored = args.windows(3).rposition(|w| {
        w[0] == "--ro-bind" && w[1] == install_s && w[2] == install_s
    }).unwrap();
    assert!(restored > mask);
    assert!(!args.windows(2).any(|w| w[0] == "--bind" && w[1] == install_s));
    assert!(args.iter().position(|a| a == "--").unwrap() > restored);
    // A missing install does not create a mount point on the host.
    let mut missing = Vec::new();
    add_install_mount(&mut missing, &dir.path().join("missing"));
    assert!(missing.is_empty());
}

fn project(id: &str, dir: &str) -> ProjectEntry {
    let mut extra = HashMap::new();
    extra.insert("directory".into(), Value::String(dir.into()));
    ProjectEntry {
        id: id.into(),
        name: id.into(),
        status: "active".into(),
        position: 0,
        local_file: format!("{dir}/project.json"),
        extra,
    }
}

fn opts(cmd: &str) -> PtyOptions {
    PtyOptions {
        login: None,
        assistant: None,
        id: "p:t".into(),
        cmd: cmd.into(),
        args: Vec::new(),
        env: HashMap::new(),
        cwd: "/p".into(),
        cols: 80,
        rows: 24,
        local_only: false,
        sandbox: false,
        agent: false,
        project_id: Some("p".into()),
        remote_host_id: None,
        tmux_session: None,
        tmux_attach: None,
        host_bound_uid: None,
        local_model: false,
        schedule_target_id: None,
        host_session: false,
        api_key: None,
    }
}

#[test]
fn seatbelt_profile_denies_writes_then_restores_roots_and_protects_hooks() {
    let inputs = SeatbeltInputs {
        home: "/Users/a".into(),
        roots: vec![concat!("/Users/a/", crate::app_slug!(), "/projects/p").into()],
        writable: vec!["/Users/a/.claude".into(), "/private/tmp".into()],
        readable: vec!["/Users/a/.gitconfig".into()],
        protected: vec![
            "/Users/a/.claude/settings.json".into(),
            concat!("/Users/a/.local/share/", crate::app_slug!(), "/hooks").into(),
        ],
        pinned: Vec::new(),
        hidden: Vec::new(),
        own_home: None,
    };
    let profile = sandbox_exec_profile(&inputs);
    let lines: Vec<&str> = profile.lines().collect();
    assert_eq!(lines[0], "(version 1)");
    assert_eq!(lines[1], "(allow default)");
    let pos = |needle: &str| {
        lines
            .iter()
            .position(|l| l.contains(needle))
            .unwrap_or_else(|| panic!("missing: {needle}"))
    };
    // Home is hidden before anything under it is restored.
    assert!(pos("(deny file-read* (subpath \"/Users/a\"))") < pos("(allow file-read* (subpath \"/Users/a/.gitconfig\"))"));
    assert!(profile.contains("(allow file-read-metadata (literal \"/Users/a\"))"));
    // Writes are denied globally, then the root and the agent state come back.
    assert!(pos("(deny file-write*)") < pos(concat!("(allow file-write* (subpath \"/Users/a/", crate::app_slug!(), "/projects/p\"))")));
    assert!(pos("(deny file-write*)") < pos("(allow file-write* (subpath \"/Users/a/.claude\"))"));
    // The device allowlist comes right after the global deny, before any
    // protected deny, and never opens other terminals' ttys.
    let devices = pos("(literal \"/dev/null\")");
    assert_eq!(devices, pos("(deny file-write*)") + 1);
    for dev in ["/dev/zero", "/dev/tty\"", "/dev/dtracehelper"] {
        assert!(lines[devices].contains(dev), "missing {dev}");
    }
    assert!(lines[devices].contains("(subpath \"/dev/fd\")"));
    assert!(devices < pos("(deny file-write* (subpath \"/Users/a/.claude/settings.json\"))"));
    assert!(!profile.contains("ttys"), "no /dev/ttys* rule");
    // The protected paths are denied LAST so they win over the .claude allow.
    let hook_deny = pos("(deny file-write* (subpath \"/Users/a/.claude/settings.json\"))");
    assert!(hook_deny > pos("(allow file-write* (subpath \"/Users/a/.claude\"))"));
    assert_eq!(lines.last().unwrap(), &concat!("(deny file-write* (subpath \"/Users/a/.local/share/", crate::app_slug!(), "/hooks\"))"));
    // Quoting: a path with a quote or backslash stays one Scheme string.
    assert_eq!(sbpl_string("/a/b\"c\\d"), "\"/a/b\\\"c\\\\d\"");
}

#[test]
fn the_one_shot_profile_guards_git_and_hides_state_without_an_agent_home() {
    let state = Path::new("/Users/a/state");
    let guard = crate::services::git_guard::GuardPaths {
        pinned: vec!["/Users/a/proj/.git".into()],
        read_only: vec!["/Users/a/proj/.git/config".into(), "/Users/a/proj/.git/hooks".into()],
    };
    let inputs = one_shot_seatbelt_inputs(
        "/Users/a",
        state,
        &[PathBuf::from("/Users/a/proj")],
        vec!["/Users/a/.gitconfig".into()],
        guard,
        vec!["/Users/a/.cargo/credentials.toml".into()],
        Some("/var/folders/xy/T/".into()),
    );
    assert_eq!(inputs.own_home, None);
    let profile = sandbox_exec_profile(&inputs);
    let lines: Vec<&str> = profile.lines().collect();
    let pos = |needle: &str| {
        lines
            .iter()
            .position(|l| *l == needle)
            .unwrap_or_else(|| panic!("missing: {needle}\n{profile}"))
    };
    let root_write = pos("(allow file-write* (subpath \"/Users/a/proj\"))");
    assert!(pos("(deny file-write*)") < root_write);
    assert!(pos("(allow file-read* (subpath \"/Users/a/proj\"))") > pos("(deny file-read* (subpath \"/Users/a\"))"));
    pos("(allow file-read* (subpath \"/Users/a/.gitconfig\"))");
    // Temp is writable, as the Linux one-shot's private /tmp.
    assert!(pos("(allow file-write* (subpath \"/var/folders/xy/T/\"))") > pos("(deny file-write*)"));
    pos("(allow file-write* (subpath \"/private/tmp\"))");
    // The git control files and the pinned `.git` come after the root allow.
    assert!(pos("(deny file-write* (subpath \"/Users/a/proj/.git/hooks\"))") > root_write);
    assert!(pos("(deny file-write* (subpath \"/Users/a/proj/.git/config\"))") > root_write);
    assert!(pos("(deny file-write* (literal \"/Users/a/proj/.git\"))") > root_write);
    assert!(!profile.contains("(deny file-write* (subpath \"/Users/a/proj/.git\"))"), "only the entry, not the tree");
    // The whole state dir and the Cargo token are hidden, and nothing is
    // restored after them: no agent home, no tool mount.
    pos("(deny file-read* file-write* (subpath \"/Users/a/state\"))");
    // Joined and quoted as the profile does it (on Windows the join adds a
    // `\`, which the Scheme string literal doubles).
    pos(&format!(
        "(deny file-read* file-write* (subpath {}))",
        sbpl_string(&state.join("settings.json").to_string_lossy())
    ));
    pos("(deny file-read* file-write* (subpath \"/Users/a/.cargo/credentials.toml\"))");
    assert!(!profile.contains("(allow file-read* file-write*"), "{profile}");
    assert!(lines.last().unwrap().starts_with("(deny file-read* file-write*"));

    // A tab's profile keeps its own home, allowed after every hidden deny.
    let tab = SeatbeltInputs {
        own_home: Some("/Users/a/state/agent-homes/k".into()),
        ..inputs
    };
    let profile = sandbox_exec_profile(&tab);
    assert_eq!(
        profile.lines().last(),
        Some("(allow file-read* file-write* (subpath \"/Users/a/state/agent-homes/k\"))")
    );
}

#[test]
fn fence_install_command_follows_the_distribution() {
    let cmd = |release: &str| package_install_cmd(release, InstallPkg::Bubblewrap);
    assert_eq!(
        cmd("NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n").as_deref(),
        Some("sudo apt install -y bubblewrap")
    );
    assert_eq!(cmd("ID=debian\n").as_deref(), Some("sudo apt install -y bubblewrap"));
    assert_eq!(cmd("ID=fedora\n").as_deref(), Some("sudo dnf install -y bubblewrap"));
    assert_eq!(cmd("ID=arch\n").as_deref(), Some("sudo pacman -S --needed bubblewrap"));
    assert_eq!(
        cmd("ID=\"opensuse-tumbleweed\"\nID_LIKE=\"opensuse suse\"\n").as_deref(),
        Some("sudo zypper install -y bubblewrap")
    );
    // An unrecognized ID falls through to ID_LIKE, in its order.
    assert_eq!(
        cmd("ID=\"someforge\"\nID_LIKE=\"rhel fedora\"\n").as_deref(),
        Some("sudo dnf install -y bubblewrap")
    );
    // ID wins over ID_LIKE.
    assert_eq!(
        cmd("ID=ubuntu\nID_LIKE=\"arch\"\n").as_deref(),
        Some("sudo apt install -y bubblewrap")
    );
    // Unknown distributions and an empty file offer nothing to run.
    assert_eq!(cmd("ID=nixos\n"), None);
    assert_eq!(cmd("ID=gentoo\n"), None);
    assert_eq!(cmd(""), None);
}

#[test]
fn decision_matrix() {
    let roots = vec![PathBuf::from("/p")];
    assert_eq!(
        decide(&opts("bash"), roots.clone(), false, true, true, true),
        FenceDecision::NotApplicable { reason: "shell" }
    );
    let mut container = opts("claude");
    container.sandbox = true;
    assert_eq!(
        decide(&container, roots.clone(), false, true, true, true),
        FenceDecision::NotApplicable {
            reason: "container"
        }
    );
    assert_eq!(
        decide(&opts("claude"), roots.clone(), true, true, true, true),
        FenceDecision::NotApplicable {
            reason: "remote host"
        }
    );
    let mut local_mirror = opts("claude");
    local_mirror.local_only = true;
    assert!(matches!(
        decide(&local_mirror, vec![PathBuf::from("/mirror/p")], false, true, true, true),
        FenceDecision::Fenced { roots }
            if roots == vec![PathBuf::from("/mirror/p")]
    ));
    // The fence has no "off": the one unfenced local agent is the root
    // console's explicit Host session, and only there.
    let mut host = opts("claude");
    host.host_session = true;
    assert!(matches!(
        decide(&host, roots.clone(), false, true, true, true),
        FenceDecision::Fenced { .. }
    ));
    host.project_id = None;
    assert_eq!(
        decide(&host, roots.clone(), false, true, true, true),
        FenceDecision::NotApplicable { reason: HOST_SESSION_REASON }
    );
    assert!(matches!(
        decide(&opts("claude"), roots.clone(), false, true, true, false),
        FenceDecision::Unavailable
    ));
    // No fence on this platform: refused until accepted once, then plain
    // "not applicable" — whatever the policy or the (irrelevant) tool says.
    assert_eq!(
        decide(&opts("claude"), roots.clone(), false, false, true, false),
        FenceDecision::NotApplicable { reason: "platform" }
    );
    // Shells, containers and remote runs never ask: nothing of the user's
    // machine is at stake that isn't already.
    assert_eq!(
        decide(&opts("bash"), roots.clone(), false, false, false, false),
        FenceDecision::NotApplicable { reason: "shell" }
    );
    assert_eq!(
        decide(&opts("claude"), roots.clone(), true, false, false, false),
        FenceDecision::NotApplicable {
            reason: "remote host"
        }
    );
    assert!(platform_unaccepted_message().starts_with(PLATFORM_UNACCEPTED_SENTINEL));
    let mut custom = opts("my-agent-wrapper");
    custom.agent = true;
    assert!(matches!(
        decide(&custom, roots, false, true, true, true),
        FenceDecision::Fenced { .. }
    ));
}

/// A member that is really a link an agent planted inside the box folder
/// is no root: bubblewrap binds a root at its own path, so it would bind
/// wherever the link now points. Dropped, not rewritten; the project's own
/// root being the planted one leaves it no roots at all.
#[cfg(unix)]
#[test]
fn a_root_through_a_planted_link_is_not_bound() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let at = |rel: &str| base.join(rel);
    std::fs::create_dir_all(at("box/real")).unwrap();
    std::fs::create_dir_all(at("secret")).unwrap();
    std::os::unix::fs::symlink(at("secret"), at("box/planted")).unwrap();
    let dir = |rel: &str| at(rel).to_string_lossy().into_owned();
    let projects = vec![project("real", &dir("box/real")), project("planted", &dir("box/planted"))];
    let boxes = vec![ProjectBox {
        id: "b".into(),
        name: "B".into(),
        member_ids: vec!["real".into(), "planted".into()],
        folder: Some(dir("box")),
        ..ProjectBox::default()
    }];

    let real = compute_fence_roots(&boxes, &projects, "real", false).unwrap();
    assert_eq!(real, vec![at("box/real"), at("box")]);
    let boxed = compute_fence_roots(&boxes, &projects, "box:b", false).unwrap();
    assert_eq!(boxed, vec![at("box"), at("box/real")]);
    assert!(compute_fence_roots(&boxes, &projects, "planted", false).is_none(), "its own root is the planted one");
    // A link spelled outside every root is the user's own and is followed.
    std::os::unix::fs::symlink(at("box/real"), at("user-link")).unwrap();
    let outside = vec![project("u", &dir("user-link"))];
    assert_eq!(compute_fence_roots(&Vec::new(), &outside, "u", false).unwrap(), vec![at("user-link")]);
}

#[test]
fn roots_cover_plain_multi_box_and_box_scope() {
    let p1 = project("p1", "/work/p1");
    let mut p2 = project("p2", "/remote/p2");
    p2.extra.insert("remote".into(), json!({"host":"h"}));
    p2.extra.insert("mirror".into(), json!("/mirrors/p2"));
    let boxes = vec![
        ProjectBox {
            id: "a".into(),
            name: "A".into(),
            member_ids: vec!["p1".into(), "p2".into()],
            folder: Some("/boxes/a".into()),
            ..ProjectBox::default()
        },
        ProjectBox {
            id: "b".into(),
            name: "B".into(),
            member_ids: vec!["p1".into()],
            folder: Some("/boxes/b".into()),
            ..ProjectBox::default()
        },
    ];
    let projects = vec![p1, p2];
    assert_eq!(
        compute_fence_roots(&Vec::new(), &projects, "p2", true).unwrap(),
        vec![PathBuf::from("/mirrors/p2")]
    );
    let p1_roots = compute_fence_roots(&boxes, &projects, "p1", false).unwrap();
    for expected in [
        "/work/p1",
        "/boxes/a",
        "/remote/p2",
        "/mirrors/p2",
        "/boxes/b",
    ] {
        assert!(p1_roots.contains(&PathBuf::from(expected)), "{p1_roots:?}");
    }
    let box_roots = compute_fence_roots(&boxes, &projects, "box:a", false).unwrap();
    assert!(box_roots.contains(&PathBuf::from("/boxes/a")));
    assert!(compute_fence_roots(&boxes, &projects, "ghost", false).is_none());
    assert!(compute_fence_roots(&boxes, &projects, "box:ghost", false).is_none());
}

#[test]
fn bwrap_argv_orders_home_mounts_roots_and_command() {
    let roots = vec![PathBuf::from("/home/u/work/p")];
    let mounts = vec![BindMount {
        src: "/state/live_sessions/p".into(),
        dst: "/state/live_sessions".into(),
        read_only: false,
    }];
    let out = bwrap_args(
        "/home/u",
        Some("/state/agent-homes/p"),
        "/home/u/work/p",
        "codex",
        &["resume".into(), "abc".into()],
        &roots,
        &["/home/u/.cargo".into()],
        &mounts,
    );
    // The scope home replaces the user's home, and its cache is a tmpfs.
    let home = out
        .windows(3)
        .position(|p| p == ["--bind", "/state/agent-homes/p", "/home/u"])
        .unwrap();
    let cache = out
        .windows(2)
        .position(|p| p == ["--tmpfs", "/home/u/.cache"])
        .unwrap();
    assert!(!out.windows(2).any(|p| p == ["--tmpfs", "/home/u"]));
    let cargo = out.iter().position(|p| p == "/home/u/.cargo").unwrap();
    let live = out.iter().position(|p| p == "/state/live_sessions").unwrap();
    let root = out.iter().rposition(|p| p == "/home/u/work/p").unwrap();
    assert!(home < cache && cache < cargo && cargo < live && live < root);
    assert!(!out.iter().any(|p| p == "--new-session" || p == "--symlink"));
    let separator = out.iter().position(|p| p == "--").unwrap();
    assert_eq!(&out[separator + 1..], &["codex", "resume", "abc"]);
    assert_eq!(out[separator - 2], "--chdir");
    assert_eq!(out[separator - 1], "/home/u/work/p");
    // Without a scope home (a one-shot command) the home is an empty tmpfs.
    let one_shot = bwrap_args("/home/u", None, "/p", "sh", &[], &roots, &[], &[]);
    assert!(one_shot.windows(2).any(|p| p == ["--tmpfs", "/home/u"]));
}

#[cfg(unix)]
#[test]
fn command_bind_paths_follow_installer_symlinks_under_home() {
    let tmp = std::env::temp_dir().join(format!(
        concat!(crate::app_slug!(), "-fence-bind-{}-{}"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let home = tmp.join("home");
    let bin = home.join(".local/bin");
    let versions = home.join(".local/share/claude/versions");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&versions).unwrap();
    let real = versions.join("2.1.251");
    std::fs::write(&real, "#!/bin/sh\n").unwrap();
    // ~/.local/bin/claude -> ../share/claude/versions/2.1.251 (relative hop)
    std::os::unix::fs::symlink("../share/claude/versions/2.1.251", bin.join("claude"))
        .unwrap();
    // /usr/bin-style link outside home -> under home (absolute hop)
    let usr_bin = tmp.join("usr/bin");
    std::fs::create_dir_all(&usr_bin).unwrap();
    std::os::unix::fs::symlink(bin.join("claude"), usr_bin.join("claude")).unwrap();
    let dirs = vec![usr_bin.clone(), bin.clone()];

    let bin_s = bin.to_string_lossy().into_owned();
    let versions_s = versions.to_string_lossy().into_owned();
    // Nothing visible yet: both home-side hops are restored, the usr hop is
    // already covered by the read-only host root and stays out.
    assert_eq!(
        command_bind_paths("claude", &dirs, &home, &[]),
        vec![bin_s.clone(), versions_s.clone()]
    );
    // The default allowlist already covers ~/.local/bin; only the target is added.
    assert_eq!(
        command_bind_paths("claude", &dirs, &home, std::slice::from_ref(&bin_s)),
        vec![versions_s.clone()]
    );
    // An ancestor in the allowlist covers the whole chain.
    let share = home.join(".local/share").to_string_lossy().into_owned();
    assert_eq!(
        command_bind_paths("claude", &dirs, &home, &[bin_s.clone(), share]),
        Vec::<String>::new()
    );
    // Explicit path and an unknown command.
    assert_eq!(
        command_bind_paths(&bin.join("claude").to_string_lossy(), &[], &home, &[]),
        vec![bin_s, versions_s]
    );
    assert!(command_bind_paths("no-such-agent", &dirs, &home, &[]).is_empty());
    let _ = std::fs::remove_dir_all(&tmp);
}

/// Mistral's installer is `uv tool install mistral-vibe`: `~/.local/bin/vibe`
/// links to a script in the tool's venv, whose `#!` interpreter links into
/// uv's managed Python. Binding only the hop directories left the
/// interpreter dangling and the new tab failed with `vibe` not found.
#[cfg(unix)]
#[test]
fn command_bind_paths_bring_a_uv_tool_venv_and_its_python() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let bin = home.join(".local/bin");
    let venv = home.join(".local/share/uv/tools/mistral-vibe");
    let python = home.join(".local/share/uv/python/cpython-3.12.9-linux-x86_64-gnu");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(venv.join("bin")).unwrap();
    std::fs::create_dir_all(venv.join("lib/python3.12/site-packages")).unwrap();
    std::fs::create_dir_all(python.join("bin")).unwrap();
    std::fs::write(python.join("bin/python3.12"), b"\x7fELF").unwrap();
    std::os::unix::fs::symlink(python.join("bin/python3.12"), venv.join("bin/python")).unwrap();
    std::fs::write(
        venv.join("pyvenv.cfg"),
        format!("home = {}\nimplementation = CPython\n", python.join("bin").display()),
    )
    .unwrap();
    std::fs::write(
        venv.join("bin/vibe"),
        format!("#!{}\nimport sys\n", venv.join("bin/python").display()),
    )
    .unwrap();
    std::os::unix::fs::symlink(venv.join("bin/vibe"), bin.join("vibe")).unwrap();

    let s = |p: &Path| p.to_string_lossy().into_owned();
    assert_eq!(
        command_bind_paths("vibe", std::slice::from_ref(&bin), &home, std::slice::from_ref(&s(&bin))),
        vec![s(&venv), s(&python)]
    );
    // `#!/usr/bin/env node` resolves the interpreter on PATH.
    let node_bin = home.join(".nvm/versions/node/v22/bin");
    std::fs::create_dir_all(&node_bin).unwrap();
    std::fs::write(node_bin.join("node"), b"\x7fELF").unwrap();
    let pkg = home.join(".npm-global/lib/node_modules/cli");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(pkg.join("cli.js"), "#!/usr/bin/env -S node --no-warnings\n").unwrap();
    std::os::unix::fs::symlink(pkg.join("cli.js"), bin.join("cli")).unwrap();
    assert_eq!(
        command_bind_paths("cli", &[bin.clone(), node_bin.clone()], &home, &[s(&bin)]),
        vec![s(&pkg), s(&node_bin)]
    );
}

/// A CLI installed on the host by its native installer — a launcher link
/// in `~/.local/bin` into a payload under `~/.local/share/<tool>` — is
/// bound into the fence read-only, every hop of it. Until 2026-09-26 the
/// payload root came back read-write for the CLI's self-update, which let
/// one scope's agent replace the binary every other scope and the user's
/// own shell run next (agent_authority reevaluation, item 2).
#[cfg(unix)]
#[test]
fn a_host_installed_cli_is_read_only_in_the_fence() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let bin = home.join(".local/bin");
    let versions = home.join(".local/share/claude/versions");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&versions).unwrap();
    std::fs::write(versions.join("2.1.270"), "#!/bin/sh\n").unwrap();
    std::os::unix::fs::symlink(versions.join("2.1.270"), bin.join("claude")).unwrap();
    let dirs = vec![bin.clone()];
    let hops = command_bind_paths("claude", &dirs, &home, &[]);
    assert!(hops.iter().any(|h| Path::new(h) == bin));
    assert!(hops.iter().any(|h| Path::new(h) == versions));
    let args = bwrap_args("/home/u", None, "/p", "claude", &[], &[], &hops, &[]);
    let home_s = home.to_string_lossy().into_owned();
    // Each bind is `<flag> <src> <dst>` with src == dst; count the flags
    // ahead of every src under the home.
    let mut n = 0;
    for i in 1..args.len() - 1 {
        if args[i].starts_with(&home_s) && args[i + 1] == args[i] {
            assert_eq!(args[i - 1], "--ro-bind-try", "{} bound writable: {args:?}", args[i]);
            n += 1;
        }
    }
    assert_eq!(n, 2, "{args:?}");
}

#[test]
fn later_rw_mount_shadows_the_allowlist_read_only_bin() {
    let bin = "/home/u/.local/bin".to_string();
    let mounts = vec![BindMount {
        src: "/state/sandbox-stage/p/private/local-bin".to_string(),
        dst: bin.clone(),
        read_only: false,
    }];
    let out = bwrap_args(
        "/home/u",
        None,
        "/p",
        "claude",
        &[],
        &[],
        std::slice::from_ref(&bin),
        &mounts,
    );
    let ro = out
        .iter()
        .position(|a| a == "--ro-bind-try")
        .expect("allowlist bind");
    let rw = out
        .iter()
        .enumerate()
        .position(|(i, a)| a == "--bind" && out.get(i + 2) == Some(&bin))
        .expect("read-write bind");
    // bubblewrap applies mounts in order: an explicit support mount of a
    // path the allowlist already restored read-only is the one the agent
    // sees, which is what lets the state masks be re-opened selectively.
    assert!(rw > ro, "{out:?}");
}

#[test]
fn only_the_spawns_own_local_model_home_is_mounted() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("vibe_local");
    std::fs::create_dir_all(root.join("gemma4-e4b")).unwrap();
    std::fs::create_dir_all(root.join("qwen3-coder")).unwrap();
    let env = |v: &str| std::collections::HashMap::from([("VIBE_HOME".to_string(), v.to_string())]);

    // Not a local-model tab (a Claude tab, the root console's agent): nothing.
    assert_eq!(local_model_home(&Default::default(), state.path()), None);
    assert!(local_model_mounts(None).unwrap().0.is_empty());
    // The renderer names the home; only a direct, existing child counts.
    for bad in [
        root.to_string_lossy().into_owned(),
        root.join("gemma4-e4b/logs").to_string_lossy().into_owned(),
        root.join("../vibe_local/gemma4-e4b").to_string_lossy().into_owned(),
        root.join("missing").to_string_lossy().into_owned(),
        "/home/u/.vibe".to_string(),
    ] {
        assert_eq!(local_model_home(&env(&bad), state.path()), None, "{bad}");
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(state.path(), root.join("link")).unwrap();
        let link = root.join("link").to_string_lossy().into_owned();
        assert_eq!(local_model_home(&env(&link), state.path()), None);
    }

    let own = root.join("gemma4-e4b");
    let home = local_model_home(&env(&own.to_string_lossy()), state.path()).unwrap();
    let (mounts, pins) = local_model_mounts(Some(&home)).unwrap();
    assert_eq!(pins.len(), LOCAL_MODEL_CONTROL.len());
    verify_control_pins(&pins).unwrap();
    let own_str = own.to_string_lossy().into_owned();
    // The home itself, writable — vibe keeps its logs and history there —
    // and never the sibling models' homes or the directory above.
    assert_eq!(
        mounts[0],
        BindMount { src: own_str.clone(), dst: own_str.clone(), read_only: false }
    );
    assert!(mounts.iter().all(|m| Path::new(&m.dst).starts_with(&own)));
    // Every control path is shadowed read-only, created where missing.
    for &(name, is_dir) in LOCAL_MODEL_CONTROL {
        let path = own.join(name);
        assert_eq!(path.is_dir(), is_dir, "{name}");
        let dst = path.to_string_lossy().into_owned();
        let pos = mounts.iter().position(|m| m.dst == dst).unwrap_or_else(|| panic!("{name}"));
        assert!(mounts[pos].read_only, "{name}");
        assert!(pos > 0, "{name} must come after the home mount");
    }
    // Vibe's own state stays writable: no mount for logs/ or vibehistory.
    assert!(!mounts.iter().any(|m| m.dst.ends_with("/logs") || m.dst.ends_with("vibehistory")));
}

#[cfg(unix)]
#[test]
fn a_symlinked_control_path_is_replaced_not_followed() {
    let state = tempfile::tempdir().unwrap();
    let home = state.path().join("vibe_local/gemma4-e4b");
    std::fs::create_dir_all(&home).unwrap();
    let outside = state.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, home.join("tools")).unwrap();
    std::os::unix::fs::symlink(outside.join("x.toml"), home.join("hooks.toml")).unwrap();
    local_model_control_paths(&home).unwrap();
    assert!(!std::fs::symlink_metadata(home.join("tools")).unwrap().file_type().is_symlink());
    assert!(home.join("tools").is_dir());
    assert!(!std::fs::symlink_metadata(home.join("hooks.toml")).unwrap().file_type().is_symlink());
    assert!(!outside.join("x.toml").exists());
}

/// Gap 30: the swap another tab of the model makes *after* setup — a link
/// in place of a pinned file or folder — refuses the spawn.
#[cfg(unix)]
#[test]
fn a_control_path_swapped_after_setup_refuses_the_spawn() {
    let state = tempfile::tempdir().unwrap();
    let home = state.path().join("vibe_local/gemma4-e4b");
    std::fs::create_dir_all(&home).unwrap();
    let outside = state.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let pins = local_model_control_paths(&home).unwrap();
    verify_control_pins(&pins).unwrap();
    // A raced link where a file was.
    std::fs::remove_file(home.join("config.toml")).unwrap();
    std::os::unix::fs::symlink(outside.join("c.toml"), home.join("config.toml")).unwrap();
    let err = verify_control_pins(&pins).unwrap_err();
    assert!(err.contains("config.toml"), "{err}");
    // Set up again: the link is replaced and the new pins hold.
    let pins = local_model_control_paths(&home).unwrap();
    verify_control_pins(&pins).unwrap();
    // A raced link where a folder was.
    std::fs::remove_dir(home.join("plugins")).unwrap();
    std::os::unix::fs::symlink(&outside, home.join("plugins")).unwrap();
    assert!(verify_control_pins(&pins).unwrap_err().contains("plugins"));
    // A different real file (a new inode) is a swap too. Made while the old
    // one still exists and renamed over it: remove-then-create can be handed
    // the freed inode straight back (ext4 on CI does).
    let pins = local_model_control_paths(&home).unwrap();
    std::fs::write(home.join(".env.new"), "").unwrap();
    std::fs::rename(home.join(".env.new"), home.join(".env")).unwrap();
    assert!(verify_control_pins(&pins).unwrap_err().contains(".env"));
    // Gone altogether: refused.
    let pins = local_model_control_paths(&home).unwrap();
    std::fs::remove_file(home.join("AGENTS.md")).unwrap();
    assert!(verify_control_pins(&pins).is_err());
}

/// A FIFO planted at a control name is replaced without blocking the spawn,
/// and a home that is not a plain folder refuses it.
#[cfg(unix)]
#[test]
fn a_fifo_at_a_control_path_is_replaced_without_blocking() {
    let state = tempfile::tempdir().unwrap();
    let home = state.path().join("vibe_local/gemma4-e4b");
    std::fs::create_dir_all(&home).unwrap();
    crate::services::home_io::mkfifo(&home.join("config.toml"));
    crate::services::home_io::mkfifo(&home.join("tools"));
    let at = home.clone();
    let pins = crate::services::home_io::within_deadline(move || local_model_control_paths(&at)).unwrap();
    verify_control_pins(&pins).unwrap();
    assert!(std::fs::symlink_metadata(home.join("config.toml")).unwrap().is_file());
    assert!(std::fs::symlink_metadata(home.join("tools")).unwrap().is_dir());
    let missing = state.path().join("vibe_local/missing");
    assert!(local_model_control_paths(&missing).is_err());
}

#[test]
fn add_dir_flags_are_agent_specific_and_idempotent() {
    let roots = vec![PathBuf::from("/p"), PathBuf::from("/sibling")];
    let mut claude = opts("claude");
    add_box_root_args(&mut claude, &roots, Path::new("/p"));
    add_box_root_args(&mut claude, &roots, Path::new("/p"));
    assert_eq!(claude.args, vec!["--add-dir", "/sibling"]);
    let mut gemini = opts("gemini");
    add_box_root_args(&mut gemini, &roots, Path::new("/p"));
    assert_eq!(gemini.args, vec!["--include-directories", "/sibling"]);
    let mut shell = opts("bash");
    add_box_root_args(&mut shell, &roots, Path::new("/p"));
    assert!(shell.args.is_empty());
    let mut one = opts("codex");
    add_box_root_args(&mut one, &roots, Path::new("/p"));
    assert!(one.args.is_empty());
    // A sign-in tab runs a subcommand, which takes no session flags.
    let mut login = opts("claude");
    login.args = vec!["auth".into(), "login".into(), "--claudeai".into()];
    add_box_root_args(&mut login, &roots, Path::new("/p"));
    assert_eq!(login.args, vec!["auth", "login", "--claudeai"]);
    assert!(runs_subcommand(&login.args));
    assert!(!runs_subcommand(&["--resume".to_string(), "id".to_string()]));
    assert!(!runs_subcommand(&[]));
}

// ── the assistant scope (docs/assistant_plan.md, S1b) ───────────────────

fn planted(id: &str, dir: &str) -> (BoxesList, ProjectsList) {
    let boxes: BoxesList =
        serde_json::from_value(json!([{"id": "b1", "name": "Box", "member_ids": [id], "position": 0, "folder": "/w/box"}])).unwrap();
    (boxes, vec![project(id, dir)])
}

#[test]
fn the_assistant_scope_yields_no_root_whatever_projects_json_holds() {
    for id in ["assistant", "Assistant", " assistant", "ASSISTANT\n"] {
        assert!(is_assistant_scope(id), "{id:?}");
        // A hand-written or imported record with the id: never its directory.
        let (boxes, projects) = planted(id, "/w/planted");
        assert_eq!(compute_fence_roots(&boxes, &projects, id, true), Some(Vec::new()), "{id:?}");
        assert_eq!(compute_fence_roots(&boxes, &projects, id, false), Some(Vec::new()), "{id:?}");
        assert_eq!(attach_roots(&boxes, &projects, id, Path::new("/state")), None, "{id:?}");
        assert_eq!(roots_for_scope(Some(id), true), Some(Vec::new()), "{id:?}");
        assert_eq!(roots_for_scope(Some(id), false), Some(Vec::new()), "{id:?}");
    }
    for id in ["root", "assistants", "my-assistant", "box:assistant", "p1", ""] {
        assert!(!is_assistant_scope(id), "{id:?}");
    }
    // Another id still resolves from the lists, and an unknown one is refused.
    let (boxes, projects) = planted("p1", "/w/alpha");
    assert_eq!(compute_fence_roots(&boxes, &projects, "p1", true), Some(vec![PathBuf::from("/w/alpha"), PathBuf::from("/w/box")]));
    assert_eq!(compute_fence_roots(&boxes, &projects, "ghost", true), None);
    assert_eq!(roots_for_scope(None, true), Some(vec![storage::root_work_dir()]));
}

#[test]
fn the_assistant_gets_no_toolchain_allowlist_and_no_root_project_view() {
    let configured = || vec!["/home/u/.cargo".to_string()];
    assert!(read_only_for_scope("assistant", || panic!("the allowlist is not even read")).is_empty());
    assert!(read_only_for_scope("Assistant", || panic!("the allowlist is not even read")).is_empty());
    assert_eq!(read_only_for_scope("p1", configured), ["/home/u/.cargo"]);
    assert_eq!(read_only_for_scope("root", configured), ["/home/u/.cargo"]);
    // The root console's read-only project view is empty for any other
    // scope, whatever the switch says.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    for scope in [storage::ASSISTANT_SCOPE, "Assistant", "p1"] {
        assert!(root_project_read_only_paths_for("assistant-tab", scope).is_empty(), "{scope}");
    }
}

const CHAT_UID: &str = "0b9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a10";
const SIBLING_UID: &str = "7c1e2a90-5b3d-4f68-8e21-9d0a4b6c3f15";

/// A state dir with the chat folders the spawn gate would have created.
fn state_with_chats(tmp: &Path) -> PathBuf {
    let state = tmp.join("state");
    for uid in [CHAT_UID, SIBLING_UID] {
        std::fs::create_dir_all(crate::services::assistant::chat_dir(&state, uid).unwrap()).unwrap();
    }
    state
}

#[test]
fn the_assistant_binds_only_its_own_chat_folder_and_creates_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state_with_chats(tmp.path());
    let chat = crate::services::assistant::chat_dir(&state, CHAT_UID).unwrap();
    let cwd = chat.to_string_lossy().into_owned();
    assert!(scope_extra_mounts("p1", &state, &cwd).unwrap().is_empty());
    assert!(scope_extra_mounts("root", &state, &cwd).unwrap().is_empty());
    let mounts = scope_extra_mounts("assistant", &state, &cwd).unwrap();
    assert_eq!(mounts, vec![BindMount { src: cwd.clone(), dst: cwd, read_only: false }]);
    // The mount never creates the folder: that is the spawn gate's job.
    let fresh = tmp.path().join("fresh");
    let missing = crate::services::assistant::chat_dir(&fresh, CHAT_UID).unwrap().to_string_lossy().into_owned();
    assert!(scope_extra_mounts("assistant", &fresh, &missing).is_err());
    assert!(!fresh.exists());
    // Only a uuid-shaped single component below the work folder is bound.
    let work = crate::services::assistant::work_root(&state);
    std::fs::create_dir_all(work.join("notes").join(CHAT_UID)).unwrap();
    let sibling = work.join(SIBLING_UID).to_string_lossy().into_owned();
    let bad = [
        work.to_string_lossy().into_owned(),
        work.join("notes").to_string_lossy().into_owned(),
        work.join("notes").join(CHAT_UID).to_string_lossy().into_owned(),
        chat.join("deeper").to_string_lossy().into_owned(),
        work.join("..").join("work").join(CHAT_UID).to_string_lossy().into_owned(),
        state.to_string_lossy().into_owned(),
        String::new(),
        "relative".to_string(),
    ];
    for cwd in &bad {
        assert!(scope_extra_mounts("assistant", &state, cwd).is_err(), "{cwd:?}");
    }
    assert_eq!(scope_extra_mounts("assistant", &state, &sibling).unwrap()[0].src, sibling);
    #[cfg(unix)]
    {
        // A link at the chat name or at the work folder is refused, never bound.
        let linked = tmp.path().join("linked");
        std::fs::create_dir_all(linked.join("assistant/work")).unwrap();
        std::fs::create_dir_all(tmp.path().join("elsewhere")).unwrap();
        let via = linked.join("assistant/work").join(CHAT_UID);
        std::os::unix::fs::symlink(tmp.path().join("elsewhere"), &via).unwrap();
        assert!(scope_extra_mounts("assistant", &linked, &via.to_string_lossy()).is_err());
        let relinked = tmp.path().join("relinked");
        std::fs::create_dir_all(relinked.join("assistant")).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("elsewhere"), relinked.join("assistant/work")).unwrap();
        std::fs::create_dir_all(tmp.path().join("elsewhere").join(CHAT_UID)).unwrap();
        let through = relinked.join("assistant/work").join(CHAT_UID);
        assert!(scope_extra_mounts("assistant", &relinked, &through.to_string_lossy()).is_err());
    }
}

/// The bubblewrap argv of an assistant spawn built from the same pieces the
/// wrapper uses (no roots, no allowlist, the support mounts, the state
/// mask): no project, box, `agent-global` or `agent_fence_paths` path is
/// bound, and the chat's own folder (not the work folder, not a sibling) is
/// re-bound read-write after the mask.
#[test]
fn the_assistant_bwrap_argv_binds_only_its_home_and_its_own_chat_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    for dir in ["agent-global", "sessions", "remote-projects", "hooks"] {
        std::fs::create_dir_all(state.join(dir)).unwrap();
    }
    std::fs::write(state.join("projects.json"), "[]").unwrap();
    std::fs::create_dir_all(state.join("agent-homes/assistant")).unwrap();
    let _ = state_with_chats(tmp.path());
    let chat = crate::services::assistant::chat_dir(&state, CHAT_UID).unwrap();
    let sibling = crate::services::assistant::chat_dir(&state, SIBLING_UID).unwrap().to_string_lossy().into_owned();
    let home = crate::services::agent_home::scope_home_in(&state, "assistant");
    let live = BindMount { src: state.join("live/assistant").to_string_lossy().into_owned(), dst: state.join("live").to_string_lossy().into_owned(), read_only: false };
    let mut mounts = vec![live];
    mounts.extend(scope_extra_mounts("assistant", &state, &chat.to_string_lossy()).unwrap());
    let allowlist = ["/home/u/.cargo", "/home/u/.rustup"].map(String::from).to_vec();
    let extra_ro = read_only_for_scope("assistant", || allowlist.clone());
    assert!(extra_ro.is_empty());
    let roots = compute_fence_roots(&Vec::new(), &vec![project("assistant", "/w/planted")], "assistant", true).unwrap();
    assert!(roots.is_empty());
    let mut args = bwrap_args(
        "/home/u",
        Some(&home.to_string_lossy()),
        &chat.to_string_lossy(),
        "claude",
        &["--tools".into(), "WebSearch".into()],
        &roots,
        &extra_ro,
        &mounts,
    );
    mask_private_state(&mut args, &state, &mounts);
    let sep = args.iter().position(|a| a == "--").unwrap();
    // Only `--tmpfs` may name the private folders; nothing is bound from them.
    let binds: Vec<&[String]> = args[..sep]
        .windows(3)
        .filter(|w| ["--bind", "--ro-bind", "--bind-try", "--ro-bind-try"].contains(&w[0].as_str()))
        // `/dev/null` over a private file is the mask, not an exposure.
        .filter(|w| w[1] != "/dev/null")
        .collect();
    let work = crate::services::assistant::work_root(&state).to_string_lossy().into_owned();
    for w in &binds {
        for forbidden in ["agent-global", "projects.json", "/w/planted", "/w/box", ".cargo", ".rustup", "remote-projects", "sessions"] {
            assert!(!w[1].contains(forbidden) && !w[2].contains(forbidden), "{w:?} binds {forbidden}");
        }
    }
    assert!(!args.iter().any(|a| a == "--bind-try"), "no root is bound: {args:?}");
    // The home is the assistant's own.
    assert!(args.windows(3).any(|w| w[0] == "--bind" && w[1] == home.to_string_lossy() && w[2] == "/home/u"));
    // The mask hides the state dir, then the chat's own folder comes back writable.
    let chat_s = chat.to_string_lossy().into_owned();
    let mask = args.windows(2).rposition(|w| w[0] == "--tmpfs" && w[1] == state.to_string_lossy()).unwrap();
    let rebound = args.windows(3).rposition(|w| w[0] == "--bind" && w[1] == chat_s && w[2] == chat_s).unwrap();
    assert!(mask < rebound && rebound < sep, "{args:?}");
    // Neither the work folder nor a sibling chat is bound, in any mode.
    for hidden in [&work, &sibling] {
        assert!(!args[..sep].windows(3).any(|w| w[0].contains("bind") && (&w[1] == hidden || &w[2] == hidden)), "{hidden}: {args:?}");
    }
    // The chat folder is the working directory.
    let chdir = args.iter().position(|a| a == "--chdir").unwrap();
    assert_eq!(args[chdir + 1], chat_s);
    assert!(chat.starts_with(&work));
}

/// Seatbelt: an empty `roots` list still renders, names the assistant's home
/// and the chat's own folder (writable), and no root, allowlist path, other
/// chat folder or other scope's home.
#[test]
fn the_assistant_seatbelt_profile_names_the_home_and_its_chat_folder_and_no_root() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state_with_chats(tmp.path());
    let chat = crate::services::assistant::chat_dir(&state, CHAT_UID).unwrap().to_string_lossy().into_owned();
    let sibling = crate::services::assistant::chat_dir(&state, SIBLING_UID).unwrap().to_string_lossy().into_owned();
    let mut mounts = vec![BindMount { src: state.join("live/assistant").to_string_lossy().into_owned(), dst: state.join("live").to_string_lossy().into_owned(), read_only: false }];
    mounts.extend(scope_extra_mounts("assistant", &state, &chat).unwrap());
    mounts.push(BindMount { src: state.join("hooks").to_string_lossy().into_owned(), dst: state.join("hooks").to_string_lossy().into_owned(), read_only: true });
    let (mut writable, readable) = seatbelt_mount_paths(&mounts);
    writable.extend(seatbelt_temp_dirs(None));
    let home = crate::services::agent_home::scope_home_in(&state, "assistant");
    let inputs = seatbelt_scope_inputs(
        "/Users/a".into(),
        &state,
        &home,
        &[],
        writable,
        readable.into_iter().chain(read_only_for_scope("assistant", || vec!["/Users/a/.cargo".into()])).collect(),
        vec![],
        vec![],
    );
    assert!(inputs.roots.is_empty());
    assert!(!inputs.readable.iter().any(|p| p.contains(".cargo")));
    let profile = sandbox_exec_profile(&inputs);
    let work = crate::services::assistant::work_root(&state).to_string_lossy().into_owned();
    assert!(profile.starts_with("(version 1)\n(allow default)\n"));
    assert!(profile.contains(&format!("(allow file-write* (subpath {}))", sbpl_string(&chat))), "{profile}");
    assert!(!profile.contains(&sibling) && !profile.contains(&format!("(allow file-write* (subpath {}))", sbpl_string(&work))), "{profile}");
    assert!(profile.contains(&format!("(allow file-read* file-write* (subpath {}))", sbpl_string(&home.to_string_lossy()))));
    assert!(profile.contains(&format!("(deny file-read* file-write* (subpath {}))", sbpl_string(&crate::services::agent_home::homes_root_in(&state).to_string_lossy()))));
    assert!(!profile.contains(".cargo") && !profile.contains("/w/planted"));
    // Every write allow is the work folder, the live slice or a temp dir.
    let mut allowed = vec![chat.clone(), state.join("live/assistant").to_string_lossy().into_owned()];
    allowed.extend(seatbelt_temp_dirs(None));
    let allowed: Vec<String> = allowed.iter().map(|p| format!("(allow file-write* (subpath {}))", sbpl_string(p))).collect();
    for line in profile.lines().filter(|l| l.starts_with("(allow file-write*") && !l.contains("literal")) {
        assert!(allowed.iter().any(|ok| ok == line), "{line}");
    }
}

#[test]
fn an_assistant_spawn_with_roots_a_foreign_home_or_a_stray_cwd_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path();
    let work = crate::services::assistant::work_root(state);
    let chat = work.join("0b9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a10");
    let chat_s = chat.to_string_lossy().into_owned();
    let own = crate::services::agent_home::scope_home_in(state, "assistant");
    let local = crate::services::agent_home::local_model_home_in(state, "assistant");
    let check = |scope: &str, roots: &[PathBuf], home: &Path, cwd: &str| check_assistant_spawn(scope, roots, home, cwd, state);
    check("assistant", &[], &own, &chat_s).unwrap();
    check("assistant", &[], &local, &chat_s).unwrap();
    assert!(check("assistant", &[PathBuf::from("/w/p")], &own, &chat_s).unwrap_err().contains("no project or box roots"));
    for foreign in [crate::services::agent_home::scope_home_in(state, "p1"), crate::services::agent_home::scope_home_in(state, "root"), state.to_path_buf(), crate::services::agent_home::host_home_in(state)] {
        assert!(check("assistant", &[], &foreign, &chat_s).is_err(), "{}", foreign.display());
    }
    let outside = state.join("elsewhere").to_string_lossy().into_owned();
    let dotted = work.join("..").join("x").to_string_lossy().into_owned();
    for cwd in [work.to_string_lossy().as_ref(), outside.as_str(), dotted.as_str(), "", "relative/dir"] {
        assert!(check("assistant", &[], &own, cwd).is_err(), "{cwd:?}");
    }
    // Not the assistant: untouched.
    check("p1", &[PathBuf::from("/w/p")], &crate::services::agent_home::scope_home_in(state, "p1"), "/w/p").unwrap();
    check("root", &[], &own, "").unwrap();
}

#[test]
fn the_assistant_scope_has_no_fence_status_and_no_one_shot_command() {
    for id in ["assistant", "Assistant", " assistant"] {
        let status = status_for_scope(id);
        assert!(!status.enforced, "{id:?}");
        assert_eq!(status.reason, "assistant scope");
        assert!(status.roots.is_empty());
        let err = one_shot_command(id, "git", &["status".to_string()], Path::new("/tmp")).unwrap_err();
        assert!(err.contains("assistant"), "{err}");
    }
}

