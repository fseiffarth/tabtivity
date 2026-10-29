use super::*;

fn spec(user: Option<&str>, host: &str, port: Option<u16>, remote_path: &str) -> RemoteSpec {
    RemoteSpec {
        user: user.map(str::to_string),
        host: host.to_string(),
        port,
        remote_path: remote_path.to_string(),
        openvpn: None,
        auto_connect: None,
        key_auth: None,
        persist_sessions: None,
        vm: None,
        remote_only: None,
        label: None,
        extra: HashMap::new(),
    }
}

// ── shell_quote ────────────────────────────────────────────────────────

#[test]
fn reader_secret_never_enters_the_ssh_command_line() {
    let mut env = HashMap::new();
    env.insert(crate::services::root_mcp::TOKEN_ENV.into(), "secret-token-fixture".into());
    for tmux in [None, Some(TmuxWrap::Session("reader".into()))] {
        let command = remote_command("claude", &[], &env, "/work", tmux.as_ref());
        assert!(!command.contains("secret-token-fixture"));
        assert!(command.contains(concat!("LC_", crate::app_upper!(), "_ROOT_MCP_TOKEN")));
        assert!(command.contains("MCP credential channel unavailable"));
    }
}

#[test]
fn shell_quote_wraps_and_escapes() {
    assert_eq!(shell_quote("abc"), "'abc'");
    assert_eq!(shell_quote("a b"), "'a b'");
    assert_eq!(shell_quote("$HOME"), "'$HOME'");
    // embedded single quote → '\''
    assert_eq!(shell_quote("a'b"), "'a'\\''b'");
}

// ── remote_command ─────────────────────────────────────────────────────

#[test]
fn remote_command_shell_uses_login_shell() {
    let cmd = remote_command("", &[], &HashMap::new(), "/srv/p", None);
    assert_eq!(cmd, "cd '/srv/p' && exec \"${SHELL:-/bin/bash}\" -l");
}

#[test]
fn remote_command_agent_runs_under_login_shell() {
    // `mytool` is not a recognised agent, so there is no install prelude —
    // this isolates the login-shell wrapping. Agent tabs go through
    // `$SHELL -lc '<inner>'` so the remote PATH is set up; the inner command
    // line is `exec 'mytool' '--foo' 'bar baz'`, single-quoted again as the
    // lone -lc argument.
    let cmd = remote_command(
        "mytool",
        &["--foo".to_string(), "bar baz".to_string()],
        &HashMap::new(),
        "/srv/p",
        None,
    );
    assert_eq!(
        cmd,
        "cd '/srv/p' && exec \"${SHELL:-/bin/bash}\" -lc \
             'exec '\\''mytool'\\'' '\\''--foo'\\'' '\\''bar baz'\\'''"
    );
}

#[test]
fn remote_command_agent_bootstraps_known_cli() {
    let cmd = remote_command("claude", &[], &HashMap::new(), "/srv/p", None);
    // Runs inside a login shell …
    assert!(cmd.starts_with("cd '/srv/p' && exec \"${SHELL:-/bin/bash}\" -lc "));
    // … with a detect-and-install prelude for the known CLI …
    assert!(cmd.contains("command -v claude >/dev/null 2>&1"));
    assert!(cmd.contains("curl -fsSL https://claude.ai/install.sh | bash"));
    assert!(cmd.contains("exit 127"));
    // … finally exec'ing the agent (single quotes escaped by the outer wrap).
    assert!(cmd.contains("exec '\\''claude'\\''"));
}

/// #28b's open half: the prelude used to fire for `claude` alone, so a Codex
/// or Gemini tab on a host without the CLI exec'd straight into a bare
/// "command not found". The recipe table decides; this pins that the seam
/// actually consults it for more than one agent.
#[test]
fn remote_command_bootstraps_the_other_agent_clis() {
    for (bin, needle) in [
        (
            "codex",
            "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        ),
        ("gemini", "npm install -g @google/gemini-cli"),
        (
            "agy",
            "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        ),
        (
            "vibe",
            "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
        ),
        ("opencode", "curl -fsSL https://opencode.ai/v2/install | bash"),
    ] {
        let cmd = remote_command(bin, &[], &HashMap::new(), "/srv/p", None);
        assert!(
            cmd.contains(&format!("command -v {bin} >/dev/null 2>&1")),
            "{bin} gets no probe"
        );
        assert!(cmd.contains(needle), "{bin} gets no installer");
        assert!(cmd.contains("exit 127"), "{bin} does not abort on failure");
    }
}

/// An unrecognised command still gets **no** prelude — we never try to
/// install something we don't know, and the generalization must not have
/// turned the lookup into a catch-all.
#[test]
fn remote_command_leaves_an_unknown_cli_alone() {
    let cmd = remote_command("mytool", &[], &HashMap::new(), "/srv/p", None);
    assert!(!cmd.contains("command -v"));
    assert!(!cmd.contains("exit 127"));
}

/// A master's temporary socket must fit `sun_path`, or ssh logs in and then
/// exits: the state dir is kept while it fits, the runtime dir takes over
/// when it does not, and with no usable runtime dir nothing changes.
/// Unix only: Windows has no control socket (`resolve_control_path`).
#[cfg(not(target_os = "windows"))]
#[test]
fn the_control_dir_leaves_room_for_the_master_socket() {
    use std::path::Path;
    let rt = Path::new("/run/user/1000");
    let short = Path::new(concat!("/s/", crate::app_slug!()));
    let long = Path::new(concat!("/home/someone/.local/share/", crate::app_slug!()));
    let no_tmp = || None;
    assert_eq!(pick_control_dir(Some(rt), short, no_tmp), short.join("ssh-control"));
    let moved = pick_control_dir(Some(rt), long, no_tmp);
    assert_eq!(moved, rt.join(concat!(crate::app_slug!(), "-ssh")));
    assert!(moved.as_os_str().len() + CONTROL_SOCKET_SUFFIX <= SOCKET_PATH_MAX);
    assert_eq!(pick_control_dir(None, long, no_tmp), long.join("ssh-control"));
    assert_eq!(pick_control_dir(Some(Path::new("run")), long, no_tmp), long.join("ssh-control"));
    // The server daemon: no runtime dir, and `<slug>-server` never fits
    // even for a one-letter user — the private /tmp dir takes over.
    let server = Path::new(concat!("/home/a/.local/share/", crate::app_slug!(), "-server"));
    assert!(server.join("ssh-control").as_os_str().len() + CONTROL_SOCKET_SUFFIX > SOCKET_PATH_MAX);
    let tmp_dir = PathBuf::from(concat!("/tmp/", crate::app_slug!(), "-ssh-4294967294"));
    assert_eq!(pick_control_dir(None, server, || Some(tmp_dir.clone())), tmp_dir);
    assert!(tmp_dir.as_os_str().len() + CONTROL_SOCKET_SUFFIX <= SOCKET_PATH_MAX);
    assert_eq!(pick_control_dir(None, server, no_tmp), server.join("ssh-control"), "unusable: unchanged");
    // The exact bytes OpenSSH binds: `<dir>/cm-<40 hex>.<16 chars>`.
    let tmp = format!("{}/cm-{}.{}", moved.display(), "0".repeat(40), "x".repeat(16));
    assert_eq!(tmp.len(), moved.as_os_str().len() + CONTROL_SOCKET_SUFFIX);
}

/// The `/tmp` fallback is used only when this uid owns it privately:
/// a directory someone else made first, or a loose one, is refused.
#[cfg(unix)]
#[test]
fn the_tmp_control_dir_must_be_private_and_ours() {
    use std::os::unix::fs::PermissionsExt;
    let base = tempfile::tempdir().unwrap();
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    let dir = base.path().join("ctl");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(owned_private_dir(&dir, uid));
    assert!(!owned_private_dir(&dir, uid.wrapping_add(1)), "someone else's");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!owned_private_dir(&dir, uid), "others can enter it");
    let link = base.path().join("link");
    std::os::unix::fs::symlink(&dir, &link).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!owned_private_dir(&link, uid), "a link is never followed");
    assert!(!owned_private_dir(&base.path().join("missing"), uid));
}

/// **G.25's kill predicate.** The sweep signals a pid, so the one thing that
/// must never be loose is *which rows it claims*: socketless-ours → reapable,
/// socket-present-ours → left alone, anything foreign → not ours at all.
#[cfg(not(target_os = "windows"))]
#[test]
fn mux_row_predicate_claims_only_our_own_masters() {
    let dir = std::path::Path::new(concat!("/home/u/.local/share/", crate::app_slug!(), "/ssh-control"));
    let ours = concat!("ssh: /home/u/.local/share/", crate::app_slug!(), "/ssh-control/cm-a1b2c3 [mux]");
    assert_eq!(
        mux_socket_in_row(ours, dir).as_deref(),
        Some(std::path::Path::new(
            concat!("/home/u/.local/share/", crate::app_slug!(), "/ssh-control/cm-a1b2c3")
        ))
    );

    // Somebody else's multiplexer, in somebody else's directory.
    assert!(mux_socket_in_row("ssh: /tmp/other/cm-a1b2c3 [mux]", dir).is_none());
    // Our directory, but not a mux master — an ordinary session that merely
    // names the socket on its command line must never be signalled.
    assert!(mux_socket_in_row(
        concat!("ssh -o ControlPath=/home/u/.local/share/", crate::app_slug!(), "/ssh-control/cm-a1b2c3 host"),
        dir
    )
    .is_none());
    // A mux master of a *different* tool.
    assert!(mux_socket_in_row("ssh: /home/u/.ssh/cm-a1b2c3 [mux]", dir).is_none());
    // Unrelated processes.
    assert!(mux_socket_in_row("sshd: u@pts/3", dir).is_none());
    assert!(mux_socket_in_row("", dir).is_none());
}

/// A state directory inside a path with a space in it is why the path is read
/// by anchoring on the whole prefix rather than by splitting the row.
#[cfg(not(target_os = "windows"))]
#[test]
fn mux_row_predicate_survives_a_space_in_the_state_dir() {
    let dir = std::path::Path::new(concat!("/home/My User/.local/share/", crate::app_slug!(), "/ssh-control"));
    let row = concat!("ssh: /home/My User/.local/share/", crate::app_slug!(), "/ssh-control/cm-ff00 [mux]");
    assert_eq!(
        mux_socket_in_row(row, dir).as_deref(),
        Some(std::path::Path::new(
            concat!("/home/My User/.local/share/", crate::app_slug!(), "/ssh-control/cm-ff00")
        ))
    );
}

/// The sweep reads `ps -eo pid=,args=`, whose rows are right-aligned pids
/// followed by a full argv. A header or a blank line yields nothing.
#[cfg(not(target_os = "windows"))]
#[test]
fn ps_rows_split_into_pid_and_argv() {
    assert_eq!(
        parse_ps_row("  12345 ssh: /x/cm-a [mux]"),
        Some((12345, "ssh: /x/cm-a [mux]"))
    );
    assert_eq!(parse_ps_row("1 init"), Some((1, "init")));
    assert!(parse_ps_row("  PID COMMAND").is_none());
    assert!(parse_ps_row("").is_none());
    assert!(parse_ps_row("noPidHere").is_none());
}

/// The reaper resolves rows to pids by socket path, so a sweep of one dead
/// socket cannot take a *sibling* master (a different host, its own live
/// socket) down with it.
#[cfg(not(target_os = "windows"))]
#[test]
fn reaping_a_socket_never_matches_a_sibling_master() {
    let dir = control_dir();
    let target = dir.join("cm-dead");
    let sibling = dir.join("cm-live");
    let rows = [
        (111, format!("ssh: {} [mux]", target.display())),
        (222, format!("ssh: {} [mux]", sibling.display())),
    ];
    let matched: Vec<i32> = rows
        .iter()
        .filter(|(_, args)| mux_socket_in_row(args, &dir).as_deref() == Some(target.as_path()))
        .map(|(pid, _)| *pid)
        .collect();
    assert_eq!(matched, vec![111]);
}

#[test]
fn remote_command_exports_env_sorted_and_skips_term() {
    let mut env = HashMap::new();
    env.insert("TERM".to_string(), "xterm".to_string());
    env.insert("COLORTERM".to_string(), "truecolor".to_string());
    env.insert("B_VAR".to_string(), "2".to_string());
    env.insert("A_VAR".to_string(), "x y".to_string());
    let cmd = remote_command("sh", &[], &env, "/srv/p", None);
    assert_eq!(
        cmd,
        "cd '/srv/p' && export A_VAR='x y' && export B_VAR='2' && \
             exec \"${SHELL:-/bin/bash}\" -lc 'exec '\\''sh'\\'''"
    );
}

#[test]
fn remote_command_strips_agent_auth_env() {
    let mut env = HashMap::new();
    env.insert("ANTHROPIC_API_KEY".to_string(), "sk-local".to_string());
    env.insert("OPENAI_API_KEY".to_string(), "sk-oai".to_string());
    env.insert("KEEP_ME".to_string(), "1".to_string());
    let cmd = remote_command("sh", &[], &env, "/srv/p", None);
    // Auth vars (and their values) are never exported to the remote …
    assert!(!cmd.contains("ANTHROPIC_API_KEY"));
    assert!(!cmd.contains("OPENAI_API_KEY"));
    assert!(!cmd.contains("sk-local"));
    assert!(!cmd.contains("sk-oai"));
    // … but ordinary env still is.
    assert!(cmd.contains("export KEEP_ME='1'"));
}

#[test]
fn remote_command_drops_env_key_with_shell_metachars() {
    // A key carrying shell metacharacters can't be made safe by quoting the
    // value (the key sits left of `=`), so it must be dropped entirely rather
    // than emitted as `export <metachars>=…`.
    let mut env = HashMap::new();
    env.insert("A; touch /tmp/pwned #".to_string(), "v".to_string());
    env.insert("GOOD_VAR".to_string(), "1".to_string());
    let cmd = remote_command("sh", &[], &env, "/srv/p", None);
    assert!(!cmd.contains("touch /tmp/pwned"));
    assert!(!cmd.contains("export A;"));
    assert!(cmd.contains("export GOOD_VAR='1'"));
}

// ── tmux wrap (TODO #85) ───────────────────────────────────────────────

#[test]
fn remote_command_off_is_unchanged() {
    // With no tmux wrap the output is byte-for-byte the pre-#85 command: the
    // cd/exports/exec nesting is untouched.
    let mut env = HashMap::new();
    env.insert("K".to_string(), "v".to_string());
    assert_eq!(
        remote_command("", &[], &env, "/srv/p", None),
        "cd '/srv/p' && export K='v' && exec \"${SHELL:-/bin/bash}\" -l"
    );
}

#[test]
fn remote_command_tmux_wraps_shell_tab() {
    let wrap = TmuxWrap::Session(concat!(crate::app_slug!(), "-p1_shell-1").to_string());
    let cmd = remote_command("", &[], &HashMap::new(), "/srv/p", Some(&wrap));
    // cd prefix is preserved verbatim…
    assert!(cmd.starts_with("cd '/srv/p' && "));
    // …and the exec is a new-session -A -D on the derived name, with the login
    // shell exec nested as tmux's (quoted) command argument.
    assert!(cmd.contains("command -v tmux >/dev/null 2>&1"));
    // history-limit precedes new-session — a pane copies it at creation, so
    // chaining it after (like status/mouse) would leave the default 2000.
    assert!(cmd.contains(
        concat!("exec tmux set -g history-limit 10000 ';' new-session -A -D -s '", crate::app_slug!(), "-p1_shell-1' ")
    ));
    assert!(cmd.contains("'exec \"${SHELL:-/bin/bash}\" -l'"));
    // status/mouse options are chained as separate tmux commands; the
    // prefix is switched off for this session alone, never globally.
    assert!(cmd.contains(concat!("';' set -g status off ';' set -g mouse on ';' set -t '", crate::app_slug!(), "-p1_shell-1' prefix None;")));
    // Fallback: a host without tmux still runs the plain exec.
    assert!(cmd.contains("session persistence is OFF"));
    assert!(cmd.contains("; exec \"${SHELL:-/bin/bash}\" -l; fi"));
}

#[test]
fn remote_command_lets_the_host_decide_a_claude_resume() {
    // The local probe cannot see the host's transcripts, so a restored remote
    // Claude tab arrives as `--session-id <launch>`; the host checks for a
    // log named after the id and resumes it, else starts fresh under it.
    let id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
    let args = vec!["--session-id".to_string(), id.to_string()];
    let cmd = remote_command("claude", &args, &HashMap::new(), "/srv/p", None);
    // Inside the `$SHELL -lc '…'` argument every single quote is `'\''`.
    let q = |tok: &str| format!("'\\''{tok}'\\''");
    let expected = format!(
        "if ls \"$HOME\"/.claude/projects/*/{} >/dev/null 2>&1; then exec {} {} {}; else exec {} {} {}; fi",
        q(&format!("{id}.jsonl")),
        q("claude"),
        q("--resume"),
        q(id),
        q("claude"),
        q("--session-id"),
        q(id),
    );
    assert!(cmd.contains(&expected), "cmd: {cmd}\nexpected: {expected}");

    // A tab moved here from this machine arrives as `--resume <id>` (the local
    // probe found its local log); with no log on the host it must start fresh,
    // since `claude --resume` of an unknown id exits at once.
    let args = vec!["--resume".to_string(), id.to_string()];
    let cmd = remote_command("claude", &args, &HashMap::new(), "/srv/p", None);
    assert!(cmd.contains(&expected), "cmd: {cmd}\nexpected: {expected}");

    // Not uuid-shaped → no glob is built from it; plain exec as before.
    let args = vec!["--session-id".to_string(), "not-a-uuid".to_string()];
    let cmd = remote_command("claude", &args, &HashMap::new(), "/srv/p", None);
    assert!(!cmd.contains("if ls"));
    assert!(cmd.contains("exec '\\''claude'\\'' '\\''--session-id'\\'' '\\''not-a-uuid'\\''"));
    // Other agents are untouched.
    let args = vec!["resume".to_string(), id.to_string()];
    let cmd = remote_command("codex", &args, &HashMap::new(), "/srv/p", None);
    assert!(!cmd.contains("if ls"));
}

#[test]
fn remote_command_tmux_repeats_env_inside_the_session() {
    // The outer exports run in the shell that launches the tmux CLIENT, and a
    // new session takes its environment from the tmux SERVER — so without the
    // repeat inside the target, the pane would get whichever tab started the
    // server (which is what stopped agents recording their session id).
    let mut env = HashMap::new();
    env.insert(crate::app_env!("TAB_UID").to_string(), "tab-1".to_string());
    let wrap = TmuxWrap::Session(concat!(crate::app_slug!(), "-p1_a1").to_string());
    let cmd = remote_command("claude", &[], &env, "/srv/p", Some(&wrap));
    assert!(cmd.starts_with(concat!("cd '/srv/p' && export ", crate::app_upper!(), "_TAB_UID='tab-1' && ")));
    // Inside tmux's (quoted) command argument, the same export leads the line.
    assert!(cmd.contains(concat!("'export ", crate::app_upper!(), "_TAB_UID='\\''tab-1'\\''; exec ")));
}

#[test]
fn remote_command_tmux_wraps_command_tab_preserving_prelude() {
    let wrap = TmuxWrap::Session(concat!(crate::app_slug!(), "-p1_a1").to_string());
    let cmd = remote_command("claude", &[], &HashMap::new(), "/srv/p", Some(&wrap));
    // The agent bootstrap prelude is nested INSIDE the tmux target unchanged…
    assert!(cmd.contains("command -v claude >/dev/null 2>&1"));
    assert!(cmd.contains("curl -fsSL https://claude.ai/install.sh | bash"));
    // …and the whole `$SHELL -lc '<prelude; exec claude>'` line is tmux's
    // (quoted) command argument on the persistent session.
    assert!(cmd.contains(concat!("';' new-session -A -D -s '", crate::app_slug!(), "-p1_a1' ")));
}

#[test]
fn remote_command_tmux_wraps_agent_resume_tab_preserving_resume_and_prelude() {
    // A remote agent tab now persists too (Claude/Codex/…): its `cli --resume …`
    // target, with the bootstrap prelude, is nested INSIDE `new-session -A` on the
    // frontend-minted per-tab name. `-A` reattaches the live agent on relaunch
    // (ignoring this target) or, if the session is gone, runs it — resuming the
    // conversation as before.
    let wrap = TmuxWrap::Session(concat!(crate::app_slug!(), "-p1--agent-uuid").to_string());
    let cmd = remote_command(
        "claude",
        &["--resume".to_string(), "sess-abc".to_string()],
        &HashMap::new(),
        "/srv/p",
        Some(&wrap),
    );
    // The cd prefix is preserved verbatim before the tmux launch.
    assert!(cmd.starts_with("cd '/srv/p' && "));
    // The bootstrap prelude is nested inside the tmux target unchanged…
    assert!(cmd.contains("command -v claude >/dev/null 2>&1"));
    assert!(cmd.contains("curl -fsSL https://claude.ai/install.sh | bash"));
    // …the resume args survive into the nested exec (run only on a fresh create)…
    assert!(cmd.contains("--resume"));
    assert!(cmd.contains("sess-abc"));
    // …and the whole thing is tmux's command argument on the persistent session.
    assert!(cmd.contains(concat!("';' new-session -A -D -s '", crate::app_slug!(), "-p1--agent-uuid' ")));
    // tmux-absent still runs the plain exec fallback.
    assert!(cmd.contains("session persistence is OFF"));
}

#[test]
fn remote_command_tmux_attach_ignores_target() {
    let wrap = TmuxWrap::Attach("train".to_string());
    // Even with a target command, an attach ignores it and just reattaches the
    // named (possibly hand-started) session.
    let cmd = remote_command(
        "python",
        &["run.py".to_string()],
        &HashMap::new(),
        "/srv/p",
        Some(&wrap),
    );
    assert!(cmd.contains("exec tmux set -g history-limit 10000 ';' new-session -A -D -s 'train' "));
    // No fresh target is exec'd inside the attach (the session already runs).
    assert!(!cmd.contains("run.py"));
}

#[test]
fn tmux_kill_session_script_quotes_name() {
    assert_eq!(
        tmux_kill_session_script(concat!(crate::app_slug!(), "-p1_shell-1")),
        concat!("tmux kill-session -t '", crate::app_slug!(), "-p1_shell-1' 2>/dev/null || true")
    );
    // An arbitrary/foreign name is single-quoted so it can't break out.
    assert!(tmux_kill_session_script("a'b").contains("'a'\\''b'"));
}

#[test]
fn tmux_kill_server_script_is_best_effort() {
    assert_eq!(
        tmux_kill_server_script(),
        "tmux kill-server 2>/dev/null || true"
    );
}

#[test]
fn parse_tmux_ls_reads_rows_and_tolerates_empty() {
    let out = concat!(crate::app_slug!(), "-p1_shell-1\t2\t1700000000\t1\t1700003600\t-bash\t/code/p1\ntrain\t1\t1700000500\t0\t1700009000\tpython\t/code/p1/run\n");
    let v = parse_tmux_ls(out);
    assert_eq!(v.len(), 2);
    assert_eq!(
        v[0],
        TmuxSession {
            name: concat!(crate::app_slug!(), "-p1_shell-1").into(),
            windows: 2,
            created: 1_700_000_000,
            attached: true,
            activity: 1_700_003_600,
            current_command: "-bash".into(),
            working: false,
            current_path: "/code/p1".into()
        }
    );
    assert_eq!(
        v[1],
        TmuxSession {
            name: "train".into(),
            windows: 1,
            created: 1_700_000_500,
            attached: false,
            activity: 1_700_009_000,
            current_command: "python".into(),
            working: true,
            current_path: "/code/p1/run".into()
        }
    );
    // "no server running" / absent tmux → empty output → zero sessions.
    assert!(parse_tmux_ls("").is_empty());
    assert!(parse_tmux_ls("\n").is_empty());
    // A malformed row is skipped, not fatal.
    assert!(parse_tmux_ls("onlyname\n").is_empty());
}

#[test]
fn parse_tmux_ls_defaults_missing_trailing_fields() {
    // A row from an older-format `tmux ls` (missing activity/current_command)
    // still surfaces, rather than being dropped, with activity falling back to
    // `created` and the session read as idle.
    let v = parse_tmux_ls("legacy\t1\t1700000000\t0\n");
    assert_eq!(v.len(), 1);
    assert_eq!(v[0].activity, 1_700_000_000);
    assert_eq!(v[0].current_command, "");
    assert_eq!(v[0].current_path, "");
    assert!(!v[0].working);
}

#[test]
fn path_within_respects_segment_boundaries() {
    assert!(path_within("/code/proj", "/code/proj"));
    assert!(path_within("/code/proj/sub/dir", "/code/proj"));
    assert!(path_within("/code/proj/", "/code/proj"));
    // A sibling that merely shares a prefix is NOT inside it.
    assert!(!path_within("/code/proj2", "/code/proj"));
    assert!(!path_within("/code", "/code/proj"));
    // Nothing is inside an unknown root.
    assert!(!path_within("/code/proj", ""));
}

#[test]
fn session_visible_scopes_by_name_then_by_working_directory() {
    let root = "/code/p1";
    // 1. The name settles it when it carries a project id, whatever the path.
    assert!(session_visible_for_project(
        concat!(crate::app_slug!(), "-p1--abcd"),
        "/somewhere/else",
        "p1",
        root
    ));
    assert!(!session_visible_for_project(
        concat!(crate::app_slug!(), "-p2--abcd"),
        "/code/p1",
        "p1",
        root
    ));
    // 2. Otherwise the working directory does. A legacy (pre-scoping) session
    //    running in this project's tree is this project's.
    assert!(session_visible_for_project(
        concat!(crate::app_slug!(), "-legacyuuid"),
        "/code/p1/src",
        "p1",
        root
    ));
    // …and one running in ANOTHER project's tree is not.
    assert!(!session_visible_for_project(
        concat!(crate::app_slug!(), "-legacyuuid"),
        "/code/p2",
        "p1",
        root
    ));
    // A hand-started session is attributed the same way.
    assert!(session_visible_for_project("train", "/code/p1", "p1", root));
    assert!(!session_visible_for_project(
        "train", "/home/me", "p1", root
    ));
    // A row whose host reported no path at all is unattributable → shown,
    // never silently dropped.
    assert!(session_visible_for_project("train", "", "p1", root));
    // An id needing sanitizing is matched consistently on both sides.
    assert!(session_visible_for_project(
        concat!(crate::app_slug!(), "-we_rd--abcd"),
        "/elsewhere",
        "we:rd",
        root
    ));
}

#[test]
fn filter_sessions_for_project_scopes_and_honours_include_all() {
    let s = |name: &str, path: &str| TmuxSession {
        name: name.into(),
        windows: 1,
        created: 0,
        attached: false,
        activity: 0,
        current_command: "".into(),
        working: false,
        current_path: path.into(),
    };
    let sessions = vec![
        s(concat!(crate::app_slug!(), "-p1--a"), "/code/p1"),
        s(concat!(crate::app_slug!(), "-p2--b"), "/code/p2"),
        s("train", "/code/p1"), // hand-started inside this project
        s("other", "/home/me"), // hand-started elsewhere
        s(concat!(crate::app_slug!(), "-legacyuuid"), "/code/p1/run"), // pre-scoping, this project's tree
        s(concat!(crate::app_slug!(), "-legacyother"), "/code/p2/run"), // pre-scoping, another's tree
    ];
    let kept = filter_sessions_for_project(sessions.clone(), "p1", "/code/p1", false);
    let names: Vec<&str> = kept.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, vec![concat!(crate::app_slug!(), "-p1--a"), "train", concat!(crate::app_slug!(), "-legacyuuid")]);
    // The escape hatch returns the host listing untouched, so an orphaned run
    // is always reachable to kill.
    assert_eq!(
        filter_sessions_for_project(sessions, "p1", "/code/p1", true).len(),
        6
    );
}

#[test]
fn tmux_ls_script_tolerates_no_server() {
    let s = tmux_ls_script();
    assert!(s.contains("tmux ls -F"));
    // "no server running" (non-zero exit) and absent tmux both collapse to
    // empty output rather than an error.
    assert!(s.contains("2>/dev/null || true"));
}

#[test]
fn is_valid_env_key_matches_posix_identifiers() {
    assert!(is_valid_env_key(crate::app_env!("TAB_UID")));
    assert!(is_valid_env_key("_x9"));
    assert!(!is_valid_env_key("9leading"));
    assert!(!is_valid_env_key("has space"));
    assert!(!is_valid_env_key("a;b"));
    assert!(!is_valid_env_key(""));
}

// ── host_mux_args (the phone's no-dial lane) ───────────────────────────

/// A literal socket path, absolute on either OS.
fn socket_path() -> std::path::PathBuf {
    let root = if cfg!(windows) { std::path::PathBuf::from(r"C:\") } else { std::path::PathBuf::from("/") };
    root.join("run").join("ssh-control").join("cm-0123abcd")
}

/// The SFTP lane is the same no-dial argv with the subsystem asked for:
/// `-s` among the options, the target, then `-- sftp`.
#[test]
fn host_mux_sftp_args_ask_for_the_subsystem_over_the_same_master() {
    let s = spec(Some("alice"), "host.example", Some(2222), "/srv/p");
    let path = socket_path();
    let args = host_mux_sftp_args(&s, &path).unwrap();
    assert_eq!(&args[args.len() - 4..], ["-s", "alice@host.example", "--", "sftp"]);
    let mut plain = host_mux_args(&s, &path, false, "sftp").unwrap();
    plain.insert(plain.len() - 3, "-s".to_string());
    assert_eq!(args, plain);
    assert!(args.contains(&"ControlMaster=no".to_string()) && args.contains(&"ProxyCommand=false".to_string()));
}

#[test]
fn host_mux_args_ride_the_literal_master_and_cannot_dial() {
    let s = spec(Some("alice"), "host.example", Some(2222), "/srv/p");
    let path = socket_path();
    let args = host_mux_args(&s, &path, false, "tmux ls").unwrap();
    // No ssh_config: this lane needs nothing from it, and a `Match exec`
    // in it would run on every probe.
    assert_eq!(&args[..6], ["-F", "none", "-T", "-q", "-e", "none"]);
    let options: Vec<&str> = args
        .windows(2)
        .filter(|w| w[0] == "-o")
        .map(|w| w[1].as_str())
        .collect();
    let literal = format!("ControlPath={}", path.to_string_lossy());
    for wanted in [
        "BatchMode=yes",
        "ControlMaster=no",
        literal.as_str(),
        "ProxyCommand=false",
        "ClearAllForwardings=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
        "PermitLocalCommand=no",
        "RemoteCommand=none",
    ] {
        assert!(options.contains(&wanted), "{wanted} in {args:?}");
    }
    // Never the template, never a master of its own, never a keepalive
    // that would hold a connection this lane does not own.
    assert!(!args.iter().any(|a| a.contains("%C")));
    assert!(!args.iter().any(|a| a.starts_with("ControlPersist") || a == "ControlMaster=auto"));
    assert!(!args.iter().any(|a| a.starts_with("ServerAlive")));
    // The port before the target, `--` between the target and the command.
    let target = args.iter().position(|a| a == "alice@host.example").unwrap();
    assert_eq!(&args[target - 2..target], ["-p", "2222"]);
    assert_eq!(&args[target + 1..], ["--", "tmux ls"]);

    let attach = host_mux_args(&s, &path, true, "exec tmux").unwrap();
    assert_eq!(attach[2], "-tt");
}

#[test]
fn host_mux_args_refuse_a_bad_target_or_a_path_ssh_would_rewrite() {
    let path = socket_path();
    for host in ["-oProxyCommand=evil", "a@b", "two words", ""] {
        assert!(host_mux_args(&spec(None, host, None, "/p"), &path, false, "x").is_err(), "{host}");
    }
    let s = spec(None, "host.example", None, "/p");
    let dir = socket_path().parent().unwrap().to_path_buf();
    for bad in [
        std::path::PathBuf::from("cm-relative"),
        dir.join("cm-%C"),
        dir.join("cm two"),
        dir.join("cm\nx"),
    ] {
        assert!(host_mux_args(&s, &bad, false, "x").is_err(), "{bad:?}");
        assert!(master_check_args(&bad).is_err(), "{bad:?}");
    }
}

#[test]
fn master_check_asks_the_socket_and_nothing_else() {
    let path = socket_path();
    let args = master_check_args(&path).unwrap();
    assert!(args.contains(&format!("ControlPath={}", path.to_string_lossy())));
    assert!(args.contains(&"ProxyCommand=false".to_string()));
    assert!(args.contains(&"ControlMaster=no".to_string()));
    assert_eq!(&args[..2], ["-F", "none"]);
    let o = args.iter().position(|a| a == "-O").unwrap();
    assert_eq!(args[o + 1], "check");
    // Strict: a socket nobody listens on is not alive (and on Windows
    // nothing is).
    let gone = tempfile::tempdir().unwrap();
    assert!(!master_alive(&gone.path().join("cm-none"), std::time::Duration::from_secs(5)));
}

#[test]
fn host_tmux_commands_embed_a_validated_name_and_refuse_any_other() {
    let name = concat!(crate::app_slug!(), "-p--agent-0123456789");
    let attach = host_tmux_attach_command(name).unwrap();
    assert_eq!(
        attach,
        format!("exec sh -c '{HOST_TMUX_EXACT}tmux -u has-session -t \"$e\"{name} 2>/dev/null && exec tmux -u attach-session -t \"$e\"{name} 2>/dev/null'")
    );
    let capture = host_tmux_capture_command(name, 10_000).unwrap();
    assert_eq!(
        capture,
        format!("exec sh -c '{HOST_TMUX_EXACT}tmux -u capture-pane -p -e -J -S -10000 -E -1 -t \"$e\"{name}\"$c\"'")
    );
    let size = host_tmux_window_size_command(name).unwrap();
    assert_eq!(
        size,
        format!("exec sh -c '{HOST_TMUX_EXACT}tmux -u display-message -p -t \"$e\"{name}\"$c\" \"#{{window_width}}x#{{window_height}}\"'")
    );
    // One shell word the remote `$SHELL -c` cannot split or expand: the body
    // holds no single quote of its own.
    for script in [&attach, &capture, &size] {
        assert_eq!(script.matches('\'').count(), 2, "{script}");
    }
    for hostile in ["x'; rm -rf ~; '", "a b", "a:1", "a.b", "$(id)", ""] {
        assert!(host_tmux_attach_command(hostile).is_none(), "{hostile}");
        assert!(host_tmux_capture_command(hostile, 10).is_none(), "{hostile}");
        assert!(host_tmux_window_size_command(hostile).is_none(), "{hostile}");
    }
}

/// A stub `tmux` on a private PATH (plus an `sh`), the script run through a
/// real `/bin/sh -c` as the remote's `$SHELL -c` would. `body` runs after
/// the `-V` answer `version` (none: no stub at all).
#[cfg(unix)]
fn run_host_script(script: &str, stub: Option<(&str, &str)>) -> std::process::Output {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink("/bin/sh", dir.path().join("sh")).unwrap();
    if let Some((version, body)) = stub {
        let tmux = dir.path().join("tmux");
        let source = format!("#!/bin/sh\n[ \"$1\" = -V ] && {{ echo 'tmux {version}'; exit 0; }}\n{body}\n");
        std::fs::write(&tmux, source).unwrap();
        std::fs::set_permissions(&tmux, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .env("PATH", dir.path())
        .output()
        .unwrap()
}

/// The host attach runs in the remote's `$SHELL -c` and its output is the
/// phone's screen: a session that has ended, a tmux server that is not
/// running and a host with no tmux at all print nothing — tmux's refusal
/// would name the session (and with it the scope's raw id) or the
/// server's socket path. Run through a real `sh` with a stub `tmux`.
#[cfg(unix)]
#[test]
fn host_tmux_attach_says_nothing_when_it_cannot_attach() {
    let name = concat!(crate::app_slug!(), "-p--agent-0123456789");
    let script = host_tmux_attach_command(name).unwrap();
    let gone = run_host_script(&script, Some(("3.4", r#"echo "can't find session: $4" >&2; exit 1"#)));
    let no_server = run_host_script(&script, Some(("3.4", r#"echo "no server running on /tmp/tmux-1000/default" >&2; exit 1"#)));
    let no_tmux = run_host_script(&script, None);
    for (what, out) in [("gone", gone), ("no server", no_server), ("no tmux", no_tmux)] {
        assert!(!out.status.success(), "{what}");
        assert!(out.stdout.is_empty() && out.stderr.is_empty(), "{what}: {out:?}");
    }
    // A live session attaches: the client's screen is its stdout.
    let live = run_host_script(&script, Some(("3.4", r#"[ "$2" = has-session ] && exit 0; echo "attached $4""#)));
    assert!(live.status.success());
    assert_eq!(String::from_utf8_lossy(&live.stdout).trim(), format!("attached ={name}"));
}

/// B12: a host whose tmux has the exact-match prefix (2.1 and later) is
/// asked for the exact session — a longer name of the user's own is never
/// attached to by prefix — and one without it (an HPC image's 1.8) for the
/// bare name. Every one-shot carries the same rule.
#[cfg(unix)]
#[test]
fn host_tmux_targets_are_exact_where_the_host_tmux_has_it() {
    let name = concat!(crate::app_slug!(), "-p--agent-0123456789");
    let echo_target = r#"for a; do t=$a; done; echo "$t""#;
    for (version, exact) in [
        ("3.6", true),
        ("3.3a", true),
        ("2.1", true),
        ("next-3.4", true),
        ("master", true),
        ("2.0", false),
        ("1.9a", false),
        ("1.8", false),
    ] {
        let target = |script: &str, stub_body: &str| {
            let out = run_host_script(script, Some((version, stub_body)));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let attach = target(
            &host_tmux_attach_command(name).unwrap(),
            r#"[ "$2" = has-session ] && exit 0; for a; do t=$a; done; echo "$t""#,
        );
        let capture = target(&host_tmux_capture_command(name, 10).unwrap(), echo_target);
        let (session, window) = if exact { (format!("={name}"), format!("={name}:")) } else { (name.to_string(), name.to_string()) };
        assert_eq!(attach, session, "{version}");
        assert_eq!(capture, window, "{version}");
    }
    // The size probe's target is the argument after `-t`.
    let probe = |version: &str| {
        let body = r#"while [ $# -gt 0 ]; do [ "$1" = -t ] && { echo "$2"; exit 0; }; shift; done"#;
        let out = run_host_script(&host_tmux_window_size_command(name).unwrap(), Some((version, body)));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    assert_eq!(probe("3.6"), format!("={name}:"));
    assert_eq!(probe("1.8"), name);
}

/// The host-side Send now presses Esc into the exact pane only while the
/// queue hint is on its screen, and says so; with no hint, or the hint's
/// words only in the conversation above, it presses nothing.
#[cfg(unix)]
#[test]
fn host_send_now_presses_esc_only_while_the_queue_hint_shows() {
    let name = concat!(crate::app_slug!(), "-p--agent-0123456789");
    let script = host_tmux_send_now_command(name, "❯", "Press up to edit queued messages").unwrap();
    let run = |screen: &str| {
        let body = format!(
            "case \"$1 $2\" in \"-u capture-pane\") printf '%s\\n' '{screen}';; \"send-keys \"*) shift; echo \"pressed $*\";; esac"
        );
        let out = run_host_script(&script, Some(("3.6", &body)));
        // Shown only when the test fails.
        eprintln!("stderr: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let queued = run("✻ Pondering… (9s)\n───\n❯ Press up to edit queued messages\n───");
    assert!(queued.contains("sent"), "{queued}");
    assert!(queued.contains(&format!("-t ={name}: Escape")), "{queued}");
    assert_eq!(run("✻ Pondering… (9s)\n───\n❯ \n───"), "");
    assert_eq!(run("  the box said Press up to edit queued messages\n❯ "), "");
    // A hint that could leave its quotes is refused outright.
    assert!(host_tmux_send_now_command(name, "❯", "a\"; rm -rf ~; \"").is_none());
    assert!(host_tmux_send_now_command("bad name", "❯", "words").is_none());
}

/// The no-dial claim against the real `ssh` (run with `--ignored`): with
/// no master on the socket the client falls through to the
/// `ProxyCommand=false` connection, fails at once with 255, and never
/// resolves or connects to the host (`-v` would say "Connecting to").
#[test]
#[ignore = "runs the real ssh client"]
fn host_mux_args_fail_fast_without_dialing_when_no_master_listens() {
    let dir = tempfile::tempdir().unwrap();
    let s = spec(None, "no-such-host.invalid", None, "/p");
    let mut args = host_mux_args(&s, &dir.path().join("cm-none"), false, "true").unwrap();
    args.retain(|a| a != "-q");
    args.insert(0, "-v".to_string());
    let started = std::time::Instant::now();
    let out = std::process::Command::new("ssh").args(&args).output().expect("ssh runs");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(255), "{stderr}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert!(!stderr.contains("Connecting to"), "{stderr}");
    assert!(stderr.contains("proxy command") || stderr.contains("ProxyCommand"), "{stderr}");
}

// ── ssh_pty_args ───────────────────────────────────────────────────────

#[test]
fn ssh_pty_args_shape() {
    let s = spec(Some("alice"), "host.example", None, "/srv/p");
    let args = ssh_pty_args(&s, "cd '/srv/p' && exec sh").unwrap();

    assert_eq!(args[0], "-tt");
    // Multiplexing is Unix-only: present on Unix, omitted on Windows.
    #[cfg(not(target_os = "windows"))]
    {
        assert!(args.iter().any(|a| a == "ControlMaster=auto"));
        assert!(args.iter().any(|a| a.starts_with("ControlPath=")));
        assert!(args.iter().any(|a| a.starts_with("ControlPersist=")));
    }
    #[cfg(target_os = "windows")]
    assert!(!args.iter().any(|a| a == "ControlMaster=auto"));
    assert!(args.iter().any(|a| a == "ServerAliveInterval=15"));
    // Interactive PTY: BatchMode must NOT be forced.
    assert!(!args.iter().any(|a| a == "BatchMode=yes"));
    // No port flag when port is None.
    assert!(!args.iter().any(|a| a == "-p"));
    // Target is a single argv item; remote command is the final item.
    assert!(args.iter().any(|a| a == "alice@host.example"));
    assert_eq!(args.last().unwrap(), "cd '/srv/p' && exec sh");
}

#[test]
fn ssh_pty_args_includes_port() {
    let s = spec(None, "h", Some(2222), "/p");
    let args = ssh_pty_args(&s, "exec sh").unwrap();
    let pos = args.iter().position(|a| a == "-p").expect("-p present");
    assert_eq!(args[pos + 1], "2222");
}

#[test]
fn ssh_pty_args_rejects_bad_host() {
    let s = spec(None, "-evil", None, "/p");
    assert!(ssh_pty_args(&s, "exec sh").is_err());
}

#[test]
fn ssh_control_check_uses_shared_path_and_target() {
    let args =
        ssh_control_check_args(&spec(Some("alice"), "host.example", Some(2200), "/p")).unwrap();
    assert_eq!(args[0], "-S");
    assert!(args[1].contains("cm-%C"));
    assert!(args.windows(2).any(|w| w == ["-O", "check"]));
    assert!(args.windows(2).any(|w| w == ["-p", "2200"]));
    assert_eq!(args.last().unwrap(), "alice@host.example");
}

// ── interactive_login_args ─────────────────────────────────────────────

#[test]
fn interactive_login_args_shape() {
    let args =
        interactive_login_args(&Some("alice".to_string()), "host.example", None).unwrap();
    // The program is ssh itself and the target is the last item — an argv,
    // nothing quoted.
    assert_eq!(args[0], "ssh");
    assert_eq!(args.last().unwrap(), "alice@host.example");
    // Multiplexing master is SHARED with ssh_pty_args (same cm-%C socket), so a
    // root-terminal login's auth is reused by the headless mount/check.
    #[cfg(not(target_os = "windows"))]
    {
        assert!(args.iter().any(|a| a == "ControlMaster=auto"));
        assert!(args.iter().any(|a| a.contains("cm-%C")));
        assert!(args.iter().any(|a| a.starts_with("ControlPersist=")));
    }
    #[cfg(target_os = "windows")]
    assert!(!args.iter().any(|a| a == "ControlMaster=auto"));
}

#[test]
fn interactive_login_args_include_port() {
    let args = interactive_login_args(&None, "h", Some(2222)).unwrap();
    assert!(args.windows(2).any(|w| w == ["-p", "2222"]));
    assert_eq!(args.last().unwrap(), "h");
}

#[test]
fn interactive_login_args_reject_bad_target() {
    assert!(interactive_login_args(&None, "-evil", None).is_err());
    assert!(interactive_login_args(&Some("-evil".to_string()), "h", None).is_err());
}

// ── wrap_pty_options detection ─────────────────────────────────────────

fn local_opts(cwd: &str, project_id: Option<&str>) -> PtyOptions {
    PtyOptions {
        login: None,
        assistant: None,
        id: "t".to_string(),
        cmd: "bash".to_string(),
        args: vec![],
        env: HashMap::new(),
        cwd: cwd.to_string(),
        cols: 80,
        rows: 24,
        local_only: false,
        sandbox: false,
        agent: false,
        project_id: project_id.map(str::to_string),
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
fn wrap_pty_options_none_id_is_local_noop() {
    // No explicit project_id (root/connection/local_only spawn) → always
    // local, so the spawn is left untouched (mount-free: there is no cwd
    // mountpoint to sniff).
    let mut opts = local_opts("/home/user/proj", None);
    wrap_pty_options(&mut opts).unwrap();
    assert_eq!(opts.cmd, "bash");
    assert!(opts.args.is_empty());
}

// ── git over ssh ───────────────────────────────────────────────────────

#[test]
fn remote_git_command_quotes_path_and_each_arg() {
    let cmd = remote_git_command(
        "/srv/my project",
        &["status".to_string(), "--porcelain".to_string()],
    );
    assert_eq!(cmd, "cd '/srv/my project' && git 'status' '--porcelain'");
}

#[test]
fn remote_git_command_no_args_is_bare_git() {
    assert_eq!(remote_git_command("/srv/p", &[]), "cd '/srv/p' && git");
}

#[test]
fn git_ssh_args_shape_target_then_remote_command_last() {
    let s = spec(Some("alice"), "host.example", None, "/srv/p");
    let args = git_ssh_args(&s, &["status".to_string(), "--porcelain".to_string()]).unwrap();
    // BatchMode (rides/falls-back to key auth), target present as one item.
    assert!(args.iter().any(|a| a == "BatchMode=yes"));
    assert!(args.iter().any(|a| a == "alice@host.example"));
    // The remote $SHELL -c string is the final argv item.
    assert_eq!(
        args.last().unwrap(),
        "cd '/srv/p' && git 'status' '--porcelain'"
    );
    // Opportunistic ControlMaster reuse on Unix (shared cm-%C socket).
    #[cfg(not(target_os = "windows"))]
    {
        assert!(args.iter().any(|a| a == "ControlMaster=no"));
        assert!(args.iter().any(|a| a.contains("cm-%C")));
    }
}

#[test]
fn git_ssh_args_includes_port() {
    let s = spec(None, "h", Some(2222), "/p");
    let args = git_ssh_args(&s, &["log".to_string()]).unwrap();
    let pos = args.iter().position(|a| a == "-p").expect("-p present");
    assert_eq!(args[pos + 1], "2222");
}

#[test]
fn git_ssh_args_rejects_bad_remote_path_and_host() {
    // A remote path that could be read as an option is rejected before any
    // ssh runs (it would otherwise be embedded in the remote shell string).
    assert!(git_ssh_args(&spec(None, "h", None, "-rf"), &["status".to_string()]).is_err());
    assert!(git_ssh_args(&spec(None, "-evil", None, "/p"), &["status".to_string()]).is_err());
}

// ── bounded one-shot helpers (remote_mkdir_p, remote_git_init) ─────────

/// A hung one-shot ssh helper is stopped at its ceiling and says what it was,
/// instead of holding project creation forever; a quick one answers its output.
#[cfg(unix)]
#[test]
fn a_hung_one_shot_ssh_helper_is_stopped_and_named() {
    use crate::services::git_bounded::{NOT_A_HANG, TEST_TIMEOUT};
    use std::time::{Duration, Instant};
    TEST_TIMEOUT.with(|t| t.set(Some(Duration::from_millis(300))));
    let mut cmd = std::process::Command::new("sh");
    cmd.args(["-c", "sleep 30"]);
    let started = Instant::now();
    let err = bounded_ssh_output(cmd, "mkdir").expect_err("times out");
    TEST_TIMEOUT.with(|t| t.set(None));
    assert!(err.starts_with("mkdir over ssh timed out"), "{err}");
    assert!(started.elapsed() < NOT_A_HANG, "took {:?}", started.elapsed());

    let mut ok = std::process::Command::new("sh");
    ok.args(["-c", "printf done"]);
    assert_eq!(bounded_ssh_output(ok, "git init").expect("ran").stdout, b"done");
}

/// `remote_mkdir_p` and `remote_git_init` run through the bound, never a bare
/// `.output()` (plan review sibling fix): read off the source so a later edit
/// cannot quietly unbound them.
#[test]
fn the_one_shot_ssh_helpers_are_bounded() {
    let src = include_str!("../ssh_exec.rs");
    for name in ["pub fn remote_mkdir_p(", "pub fn remote_git_init("] {
        let start = src.find(name).unwrap_or_else(|| panic!("{name} not found"));
        let body = &src[start..];
        let end = body.find("\n}\n").expect("fn end");
        let body = &body[..end];
        assert!(body.contains("bounded_ssh_output("), "{name} is not bounded");
        assert!(!body.contains(".output()"), "{name} runs a bare .output()");
    }
}
