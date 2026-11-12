use crate::brand::SLUG;
use super::*;

/// A link at a hook file — planted by a fenced agent, or the old fence's
/// stage link — is replaced by a plain file; its target is never read or
/// written.
#[cfg(unix)]
#[test]
fn hook_registration_replaces_a_link_instead_of_following_it() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tmp.path().join("outside.toml");
    std::fs::write(&outside, "model = \"o3\"\n").unwrap();
    let home = tmp.path().join("home");
    let codex = home.join(".codex");
    std::fs::create_dir_all(&codex).unwrap();
    let config = codex.join("config.toml");
    std::os::unix::fs::symlink(&outside, &config).unwrap();
    register_codex_hook_in(&HomeFile::open(&home, ".codex/config.toml").unwrap()).unwrap();
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "model = \"o3\"\n");
    assert!(std::fs::symlink_metadata(&config).unwrap().is_file());
    let out = std::fs::read_to_string(&config).unwrap();
    assert!(out.contains("[[hooks.SessionStart]]"));
    assert!(!out.contains("model"));

    let outside_json = tmp.path().join("outside.json");
    std::fs::write(&outside_json, "{}").unwrap();
    let settings = home.join(".claude/settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&outside_json, &settings).unwrap();
    register_hook_in_settings(&HomeFile::open(&home, ".claude/settings.json").unwrap()).unwrap();
    assert_eq!(std::fs::read_to_string(&outside_json).unwrap(), "{}");
    assert!(std::fs::symlink_metadata(&settings).unwrap().is_file());

    let outside_hooks = tmp.path().join("outside-hooks.toml");
    std::fs::write(&outside_hooks, "").unwrap();
    let vibe = home.join(".vibe");
    std::fs::create_dir_all(&vibe).unwrap();
    std::os::unix::fs::symlink(&outside_hooks, vibe.join("hooks.toml")).unwrap();
    write_vibe_hooks(&HomeFile::open(&home, ".vibe/hooks.toml").unwrap(), false).unwrap();
    assert_eq!(std::fs::read_to_string(&outside_hooks).unwrap(), "");
    assert!(std::fs::symlink_metadata(vibe.join("hooks.toml")).unwrap().is_file());

    // The directory swapped after the file's handle was opened: the
    // registration lands in the moved directory, never at the link.
    let settings = HomeFile::open(&home, ".claude/settings.json").unwrap();
    std::fs::rename(home.join(".claude"), home.join(".claude.moved")).unwrap();
    std::os::unix::fs::symlink(tmp.path(), home.join(".claude")).unwrap();
    std::fs::write(home.join(".claude.moved/settings.json"), "{\"model\": \"x\"}").unwrap();
    register_hook_in_settings(&settings).unwrap();
    assert!(!tmp.path().join("settings.json").exists());
    let moved = std::fs::read_to_string(home.join(".claude.moved/settings.json")).unwrap();
    assert!(moved.contains("\"model\": \"x\"") && moved.contains(&hook_command()));

    // A linked config dir is skipped altogether.
    let home = tmp.path().join("linked");
    std::fs::create_dir_all(&home).unwrap();
    std::os::unix::fs::symlink(tmp.path().join("home/.codex"), home.join(".codex")).unwrap();
    register_hooks_in_home(&home);
    assert!(std::fs::symlink_metadata(home.join(".codex")).unwrap().file_type().is_symlink());
}

// ── agent session resolution ────────────────────────────────────────────

/// Process-and-test-unique temp path. Tests run in parallel threads sharing
/// one pid, so a counter keeps each test's dir distinct.
fn unique_tmp(prefix: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()))
}

fn opts_with_args(args: &[&str]) -> PtyOptions {
    PtyOptions {
        login: None,
        assistant: None,
        id: "t".to_string(),
        cmd: "claude".to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: Default::default(),
        cwd: "/".to_string(),
        cols: 80,
        rows: 24,
        local_only: false,
        sandbox: false,
        agent: true,
        project_id: None,
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
fn vibe_resumes_its_own_recorded_session_and_preserves_legacy_fallback() {
    let home = unique_tmp(concat!(crate::app_slug!(), "-vibe-resume"));
    let sessions = home.join("logs/session");
    let uid = "11111111-2222-4333-8444-555555555555";
    let own = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let other = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    std::fs::create_dir_all(sessions.join("unified").join(own)).unwrap();
    std::fs::write(sessions.join("unified").join(own).join("CURRENT"), "1").unwrap();
    let legacy = sessions.join("session_20260923_120000_ffffffff");
    std::fs::create_dir_all(&legacy).unwrap();
    // Vibe's real metadata carries its config, tool schemas and system
    // prompt: far past a small record's cap, and still read.
    let padding = "x".repeat(2 * crate::services::home_io::RECORD_CAP as usize);
    std::fs::write(
        legacy.join("meta.json"),
        format!("{{\"session_id\":\"{other}\",\"system_prompt\":{{\"content\":\"{padding}\"}}}}"),
    )
    .unwrap();

    let mut opts = opts_with_args(&["--continue"]);
    opts.cmd = "vibe".into();
    opts.env.insert(crate::app_env!("TAB_UID").into(), uid.into());
    let exact = resolve_vibe_session_impl(opts.clone(), &home, |_| Some(own.into()));
    assert_eq!(exact.args, ["--resume", own]);
    assert_eq!(exact.env.get(TAB_AGENT_ENV).map(String::as_str), Some("vibe"));
    let legacy_exact = resolve_vibe_session_impl(opts.clone(), &home, |_| Some(other.into()));
    assert_eq!(legacy_exact.args, ["--resume", other]);
    let missing = resolve_vibe_session_impl(opts, &home, |_| Some("cccccccc-dddd-4eee-8fff-000000000000".into()));
    assert_eq!(missing.args, ["--continue"]);
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn vibe_hook_registration_preserves_existing_hooks_and_is_idempotent() {
    let home = unique_tmp(concat!(crate::app_slug!(), "-vibe-hooks"));
    std::fs::create_dir_all(&home).unwrap();
    let hooks = home.join("hooks.toml");
    std::fs::write(&hooks, "[[hooks]]\nname = \"mine\"\ntype = \"post_agent\"\ncommand = \"true\"\n").unwrap();
    register_vibe_hook_in(&home).unwrap();
    let once = std::fs::read_to_string(&hooks).unwrap();
    register_vibe_hook_in(&home).unwrap();
    assert_eq!(std::fs::read_to_string(&hooks).unwrap(), once);
    assert!(once.contains("name = \"mine\""));
    assert_eq!(once.matches(concat!("name = \"", crate::app_slug!(), "-session\"")).count(), 1);
    std::fs::remove_dir_all(home).unwrap();
}

/// The assistant's local-Claude chats keep their transcripts in the
/// scope's local-model home, so its Claude roots name both homes; no
/// other scope's do.
#[test]
fn the_assistants_claude_roots_include_its_local_model_home() {
    let roots = claude_projects_roots(Some("assistant"));
    assert_eq!(roots.len(), 2);
    assert!(roots[1].starts_with(crate::services::agent_home::local_model_home(Some("assistant"))));
    assert_eq!(claude_projects_roots(Some(" Assistant ")).len(), 2);
    assert_eq!(claude_projects_roots(Some("p1")).len(), 1);
    assert_eq!(claude_projects_roots(None).len(), 1);
}

#[test]
fn a_local_model_home_keeps_only_apps_hook() {
    let home = unique_tmp(concat!(crate::app_slug!(), "-vibe-local-hooks"));
    std::fs::create_dir_all(&home).unwrap();
    let hooks = home.join("hooks.toml");
    std::fs::write(&hooks, "[[hooks]]\nname = \"planted\"\ntype = \"post_agent\"\ncommand = \"true\"\n").unwrap();
    let file = HomeFile::open(&home, "hooks.toml").unwrap();
    write_vibe_hooks(&file, true).unwrap();
    let once = std::fs::read_to_string(&hooks).unwrap();
    assert!(!once.contains("planted"));
    assert_eq!(once.matches(concat!("name = \"", crate::app_slug!(), "-session\"")).count(), 1);
    write_vibe_hooks(&file, true).unwrap();
    assert_eq!(std::fs::read_to_string(&hooks).unwrap(), once);
    std::fs::remove_dir_all(home).unwrap();
}

/// Two tabs of one local model starting together: the second spawn's
/// rewrite of a stale `hooks.toml` lands between the first spawn's pin and
/// its verify. The rewrite keeps the inode, so the first spawn is not
/// refused (and running tabs keep their read-only bind).
#[cfg(unix)]
#[test]
fn a_hooks_rewrite_between_pin_and_verify_keeps_the_pin_valid() {
    let state = tempfile::tempdir().unwrap();
    let home = state.path().join("vibe_local/gemma4-e4b");
    std::fs::create_dir_all(&home).unwrap();
    let hooks = home.join("hooks.toml");
    let file = HomeFile::open(&home, "hooks.toml").unwrap();
    // First tab ever: the first spawn creates the file and pins it.
    write_vibe_hooks(&file, true).unwrap();
    let pins = crate::services::agent_fence::local_model_control_paths(&home).unwrap();
    // The second spawn read stale content (an update changed the block,
    // or it raced the creation) and rewrites the file.
    std::fs::OpenOptions::new().write(true).truncate(true).open(&hooks).unwrap();
    write_vibe_hooks(&file, true).unwrap();
    crate::services::agent_fence::verify_control_pins(&pins).unwrap();
    let fresh = std::fs::read_to_string(&hooks).unwrap();
    assert_eq!(fresh, vibe_hook_block().unwrap());
    // Stale content under the pins: rewritten, still the pinned inode.
    std::fs::write(&hooks, "[[hooks]]\nname = \"planted\"\ntype = \"post_agent\"\ncommand = \"true\"\n").unwrap();
    write_vibe_hooks(&file, true).unwrap();
    crate::services::agent_fence::verify_control_pins(&pins).unwrap();
    assert_eq!(std::fs::read_to_string(&hooks).unwrap(), fresh);
}

#[test]
fn only_a_direct_child_of_vibe_local_is_a_local_model_home() {
    let root = std::path::Path::new(concat!("/s/", crate::app_slug!(), "/vibe_local"));
    assert!(is_local_vibe_home_in(&root.join("gemma4-e4b"), root));
    assert!(!is_local_vibe_home_in(root, root));
    assert!(!is_local_vibe_home_in(&root.join("a/b"), root));
    assert!(!is_local_vibe_home_in(&root.join("../x"), root));
    assert!(!is_local_vibe_home_in(std::path::Path::new("/home/u/.vibe"), root));
}

#[cfg(unix)]
#[test]
fn vibe_hook_records_only_top_level_post_agent() {
    let home = unique_tmp(concat!(crate::app_slug!(), "-vibe-hook-run"));
    let live = home.join("live");
    std::fs::create_dir_all(&live).unwrap();
    let script = home.join("hook.sh");
    std::fs::write(&script, posix_hook_script_body(&live.to_string_lossy())).unwrap();
    let uid = "11111111-2222-4333-8444-555555555555";
    let own = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let nested = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    let payload = |id: &str, parent: &str, event: &str| format!(
        "{{\"hook_event_name\":\"{event}\",\"session_id\":\"{id}\",\"parent_session_id\":{parent}}}"
    );
    assert_eq!(run_hook(&script, &live, uid, Some("vibe"), false,
        &payload(nested, "null", "post_tool")).0, None);
    assert_eq!(run_hook(&script, &live, uid, Some("vibe"), false,
        &payload(nested, &format!("\"{own}\""), "post_agent")).0, None);
    assert_eq!(run_hook(&script, &live, uid, Some("vibe"), false,
        &payload(own, "null", "post_agent")).0.as_deref(), Some(own));
    std::fs::remove_dir_all(home).unwrap();
}

/// Temp Claude `projects` root containing a persisted log for each given uuid.
fn projects_with_sessions(uuids: &[&str]) -> std::path::PathBuf {
    let tmp = unique_tmp(concat!(crate::app_slug!(), "-resolve"));
    let proj = tmp.join("-encoded-cwd");
    std::fs::create_dir_all(&proj).unwrap();
    for u in uuids {
        std::fs::write(proj.join(format!("{u}.jsonl")), b"{}").unwrap();
    }
    tmp
}

#[test]
fn resolve_dispatches_by_command() {
    // Non-tracked commands pass straight through.
    let mut opts = opts_with_args(&["--session-id", "abc-123"]);
    opts.cmd = "bash".to_string();
    let out = resolve_agent_session(opts);
    assert_eq!(out.cmd, "bash");
    assert_eq!(
        out.args,
        vec!["--session-id".to_string(), "abc-123".to_string()]
    );
}

#[test]
fn resolve_is_a_noop_once_command_is_wrapped_to_ssh() {
    // Regression for the ssh-resume ordering bug: `wrap_pty_options` rewrites
    // `opts.cmd` to "ssh". If resolution ran AFTER wrapping, the dispatcher
    // would see "ssh" (not "claude"/"codex") and never inject resume args.
    // This asserts that an already-wrapped command is untouched, which is why
    // `pty_spawn` must resolve BEFORE wrapping.
    let mut opts = opts_with_args(&["-tt", "host", "exec claude --session-id abc"]);
    opts.cmd = "ssh".to_string();
    let out = resolve_agent_session(opts);
    assert_eq!(out.cmd, "ssh");
    assert_eq!(
        out.args,
        vec![
            "-tt".to_string(),
            "host".to_string(),
            "exec claude --session-id abc".to_string()
        ]
    );
    // And resume args are only ever injected while the command is still the
    // bare agent CLI (the pre-wrap state) — proven by the claude/codex tests.
}

#[test]
fn resolve_keeps_session_id_when_no_log_exists() {
    // A never-used tab must not turn into `--resume` (Claude would exit with
    // "No conversation found with session ID ...").
    let uuid = "00000000-0000-0000-0000-000000000000";
    let projects = projects_with_sessions(&[]);
    let out =
        resolve_claude_session_impl(
            opts_with_args(&["--session-id", uuid]),
            &projects,
            |_| None,
            |_| None,
        );
    assert_eq!(out.args, vec!["--session-id".to_string(), uuid.to_string()]);
    // The launch id is always exposed to the SessionStart hook.
    assert_eq!(
        out.env.get(crate::app_env!("TAB_UID")).map(String::as_str),
        Some(uuid)
    );
    let _ = std::fs::remove_dir_all(&projects);
}

#[test]
fn resolve_resumes_launch_id_when_its_log_exists() {
    let uuid = "00000000-0000-0000-0000-000000000000";
    let projects = projects_with_sessions(&[uuid]);
    let out =
        resolve_claude_session_impl(
            opts_with_args(&["--session-id", uuid]),
            &projects,
            |_| None,
            |_| None,
        );
    assert_eq!(out.args, vec!["--resume".to_string(), uuid.to_string()]);
    let _ = std::fs::remove_dir_all(&projects);
}

#[test]
fn resolve_follows_live_id_after_clear() {
    // After /clear the hook records a fresh live id under the launch key; we
    // resume that, not the (pre-clear) launch id.
    let launch = "00000000-0000-0000-0000-000000000000";
    let live = "99999999-8888-7777-6666-555555555555";
    let projects = projects_with_sessions(&[launch, live]);
    let out = resolve_claude_session_impl(
        // restore path passes `--resume <launch>`; we rewrite the id to live.
        opts_with_args(&["--resume", launch]),
        &projects,
        |uid| (uid == launch).then(|| live.to_string()),
        |_| None,
    );
    assert_eq!(out.args, vec!["--resume".to_string(), live.to_string()]);
    assert_eq!(
        out.env.get(crate::app_env!("TAB_UID")).map(String::as_str),
        Some(launch)
    );
    let _ = std::fs::remove_dir_all(&projects);
}

#[test]
fn transcript_ids_skip_the_cleared_launch_only_when_asked() {
    let launch = "00000000-0000-0000-0000-000000000000";
    let live = "99999999-8888-7777-6666-555555555555";
    // Before any `/clear` no live id is recorded: the launch id either way.
    assert_eq!(claude_transcript_ids(None, launch, false), vec![launch.to_string()]);
    assert_eq!(claude_transcript_ids(None, launch, true), vec![launch.to_string()]);
    // After one, the prompt reads see only the new session — whose file
    // Claude writes with its first turn, so until then they see nothing.
    assert_eq!(claude_transcript_ids(Some(live.to_string()), launch, false), vec![live.to_string()]);
    assert_eq!(
        claude_transcript_ids(Some(live.to_string()), launch, true),
        vec![live.to_string(), launch.to_string()]
    );
}

#[test]
fn resolve_downgrades_resume_without_log_to_session_id() {
    // Restore asked for `--resume <launch>` but no log exists (never-used tab)
    // → downgrade to `--session-id` so Claude starts fresh instead of erroring.
    let launch = "00000000-0000-0000-0000-000000000000";
    let projects = projects_with_sessions(&[]);
    let out =
        resolve_claude_session_impl(opts_with_args(&["--resume", launch]), &projects, |_| None, |_| None);
    assert_eq!(
        out.args,
        vec!["--session-id".to_string(), launch.to_string()]
    );
    let _ = std::fs::remove_dir_all(&projects);
}

#[test]
fn resolve_ignores_non_claude_commands() {
    let mut opts = opts_with_args(&["--session-id", "abc-123"]);
    opts.cmd = "bash".to_string();
    let projects = projects_with_sessions(&[]);
    let out = resolve_claude_session_impl(opts, &projects, |_| Some("x".to_string()), |_| None);
    assert_eq!(
        out.args,
        vec!["--session-id".to_string(), "abc-123".to_string()]
    );
    assert!(!out.env.contains_key(crate::app_env!("TAB_UID")));
    let _ = std::fs::remove_dir_all(&projects);
}

#[test]
fn claude_session_exists_detects_persisted_log() {
    let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-sess-test-{}"), std::process::id()));
    let proj = tmp.join("-some-encoded-cwd");
    std::fs::create_dir_all(&proj).unwrap();
    let uuid = "11111111-2222-3333-4444-555555555555";
    std::fs::write(proj.join(format!("{uuid}.jsonl")), b"{}").unwrap();

    assert!(claude_session_exists(&tmp, uuid));
    assert!(!claude_session_exists(&tmp, "no-such-uuid"));

    let _ = std::fs::remove_dir_all(&tmp);
}

#[cfg(unix)]
#[test]
fn a_linked_slug_folder_is_not_this_scopes_conversation() {
    let home = unique_tmp(concat!(crate::app_slug!(), "-claude-link"));
    let other = unique_tmp(concat!(crate::app_slug!(), "-claude-other"));
    let uuid = "11111111-2222-3333-4444-555555555555";
    let projects = home.join(".claude").join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join(format!("{uuid}.jsonl")), b"{}").unwrap();
    std::os::unix::fs::symlink(&other, projects.join("-slug")).unwrap();
    assert!(!claude_session_exists(&projects, uuid));
    assert!(claude_chat_log(&projects.join("-slug"), uuid).is_none());

    let own = projects.join("-own");
    std::fs::create_dir_all(&own).unwrap();
    std::fs::write(own.join(format!("{uuid}.jsonl")), b"{}").unwrap();
    assert_eq!(claude_session_log(&projects, uuid), Some(own.join(format!("{uuid}.jsonl"))));
    assert_eq!(claude_chat_log(&own, uuid), Some(own.join(format!("{uuid}.jsonl"))));

    let projects_link = unique_tmp(concat!(crate::app_slug!(), "-claude-plink"));
    std::fs::create_dir_all(projects_link.join(".claude")).unwrap();
    std::os::unix::fs::symlink(&projects, projects_link.join(".claude").join("projects")).unwrap();
    assert!(!claude_session_exists(&projects_link.join(".claude").join("projects"), uuid));
    for dir in [home, other, projects_link] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn resolve_leaves_args_without_session_flag_untouched() {
    let projects = projects_with_sessions(&[]);
    let out =
        resolve_claude_session_impl(opts_with_args(&["--foo", "bar"]), &projects, |_| None, |_| None);
    assert_eq!(out.args, vec!["--foo".to_string(), "bar".to_string()]);
    let _ = std::fs::remove_dir_all(&projects);
}

/// Temp Codex sessions root with a `YYYY/MM/DD/rollout-…-<uuid>.jsonl` log.
fn codex_sessions_with(uuid: &str) -> std::path::PathBuf {
    let tmp = unique_tmp(concat!(crate::app_slug!(), "-codex-sess"));
    let day = tmp.join("2026").join("06").join("08");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::write(
        day.join(format!("rollout-2026-06-08T17-10-09-{uuid}.jsonl")),
        b"{}",
    )
    .unwrap();
    tmp
}

fn codex_opts() -> PtyOptions {
    let mut o = opts_with_args(&[]);
    o.cmd = "codex".to_string();
    o
}

#[test]
fn codex_resumes_live_id_when_rollout_exists() {
    let live = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";
    let root = codex_sessions_with(live);
    let mut opts = codex_opts();
    opts.env
        .insert(crate::app_env!("TAB_UID").to_string(), "tab-key-123".to_string());
    let out = resolve_codex_session_impl(opts, &root, &[], |uid| {
        (uid == "tab-key-123").then(|| live.to_string())
    });
    assert_eq!(out.args, vec!["resume".to_string(), live.to_string()]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn codex_starts_fresh_without_record_or_without_uid() {
    let root = codex_sessions_with("00000000-0000-0000-0000-000000000000");
    // No live record → fresh launch (args stay empty).
    let mut opts = codex_opts();
    opts.env
        .insert(crate::app_env!("TAB_UID").to_string(), "tab-key".to_string());
    let out = resolve_codex_session_impl(opts, &root, &[], |_| None);
    assert!(out.args.is_empty());
    // No TABTIVITY_TAB_UID at all → cannot track → fresh launch.
    let out2 =
        resolve_codex_session_impl(codex_opts(), &root, &[], |_| Some("x".to_string()));
    assert!(out2.args.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn codex_ignores_when_recorded_session_missing_on_disk() {
    let root = codex_sessions_with("aaaaaaaa-0000-0000-0000-000000000000");
    let mut opts = codex_opts();
    opts.env
        .insert(crate::app_env!("TAB_UID").to_string(), "tab-key".to_string());
    // Recorded id has no rollout log → don't pass a bad `resume` arg.
    let out = resolve_codex_session_impl(opts, &root, &[], |_| {
        Some("ffffffff-1111-2222-3333-444444444444".to_string())
    });
    assert!(out.args.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

/// The 0.153.4 regression: Codex records the thread in `state_<n>.sqlite`
/// and writes no rollout file at all, so a sessions-only check finds
/// nothing and the tab relaunches fresh.
#[test]
fn codex_resumes_a_thread_that_exists_only_in_the_sqlite_store() {
    let live = "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a";
    // A `sessions/` dir that is not merely empty but absent, as it is on a
    // machine where Codex never wrote one.
    let root = std::env::temp_dir().join(format!(
        "{SLUG}-codex-nosessions-{}-{live}",
        std::process::id()
    ));
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-codex-db-{}"), std::process::id()));
    // A store left behind by an earlier run would fail the CREATE below.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("state_5.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0)",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO threads (id) VALUES (?1)", [live])
        .unwrap();
    drop(conn);

    let mut opts = codex_opts();
    opts.env
        .insert(crate::app_env!("TAB_UID").to_string(), "tab-key".to_string());
    let out = resolve_codex_session_impl(opts, &root, std::slice::from_ref(&db), |_| {
        Some(live.to_string())
    });
    assert_eq!(out.args, vec!["resume".to_string(), live.to_string()]);

    // An id neither store has heard of still starts fresh.
    let mut other = codex_opts();
    other
        .env
        .insert(crate::app_env!("TAB_UID").to_string(), "tab-key".to_string());
    let out = resolve_codex_session_impl(other, &root, std::slice::from_ref(&db), |_| {
        Some("ffffffff-1111-2222-3333-444444444444".to_string())
    });
    assert!(out.args.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn codex_does_not_resume_an_archived_thread_with_a_rollout() {
    let archived = "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a";
    let root = codex_sessions_with(archived);
    let db = root.join("state_5.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0)",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO threads (id, archived) VALUES (?1, 1)", [archived])
        .unwrap();
    drop(conn);

    assert!(!codex_session_exists(&root, Some(&db), archived));
    let mut opts = codex_opts();
    opts.env
        .insert(crate::app_env!("TAB_UID").to_string(), "tab-key".to_string());
    let out = resolve_codex_session_impl(opts, &root, std::slice::from_ref(&db), |_| {
        Some(archived.to_string())
    });
    assert!(out.args.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

// ── hook installer ──────────────────────────────────────────────────────

#[test]
fn read_live_session_round_trips_and_rejects_junk() {
    let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-live-{}"), std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let uid = "11111111-2222-3333-4444-555555555555";
    let live = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    std::fs::write(tmp.join(uid), format!("{live}\n")).unwrap();

    assert_eq!(read_live_session_in(&tmp, uid).as_deref(), Some(live));
    assert_eq!(read_live_session_in(&tmp, "no-such-uid"), None);
    // path-traversal / non-uuid keys are refused before any read.
    assert_eq!(read_live_session_in(&tmp, "../etc/passwd"), None);

    // malformed stored value is rejected.
    std::fs::write(tmp.join(uid), "not a uuid!").unwrap();
    assert_eq!(read_live_session_in(&tmp, uid), None);

    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn tab_keys_must_be_uuid_shaped_before_becoming_a_path_component() {
    // `TABTIVITY_TAB_UID` arrives in the renderer-supplied `PtyOptions.env`, so the
    // key is validated by SHAPE rather than by "happens to contain no slash".
    assert!(is_uuid_shaped("11111111-2222-3333-4444-555555555555"));
    assert!(is_uuid_shaped("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"));
    assert!(!is_uuid_shaped(""));
    assert!(!is_uuid_shaped("----"));
    assert!(!is_uuid_shaped("deadbeef"));
    assert!(!is_uuid_shaped("../etc/passwd"));
    assert!(!is_uuid_shaped(
        "11111111-2222-3333-4444-555555555555-extra"
    ));
    assert!(!is_uuid_shaped("11111111-2222-3333-4444-55555555555"));
    assert!(!is_uuid_shaped("g1111111-2222-3333-4444-555555555555"));
    // A key that only passed the looser value guard is now refused as a key.
    assert!(is_uuidish("deadbeef"));
    assert!(!is_uuid_shaped("deadbeef"));
}

#[test]
fn per_project_live_session_records_are_separate_and_the_newer_one_wins() {
    // The S-4 primitive: with one shared directory a contained agent could
    // overwrite another project's tab record and so pick which conversation an
    // UNCONTAINED agent resumes. Records now live in per-project subdirs.
    let root = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-live-pp-{}"), std::process::id()));
    let own = root.join("p1");
    std::fs::create_dir_all(&own).unwrap();
    let uid = "11111111-2222-3333-4444-555555555555";
    let host_id = "aaaaaaaa-1111-1111-1111-111111111111";
    let contained_id = "bbbbbbbb-2222-2222-2222-222222222222";

    // Host-run agent's record (shared root) only.
    std::fs::write(root.join(uid), host_id).unwrap();
    assert_eq!(read_live_session_in(&root, uid).as_deref(), Some(host_id));
    assert_eq!(read_live_session_in(&own, uid), None);

    // The containerized agent's own record, written later, wins.
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(own.join(uid), contained_id).unwrap();
    assert_eq!(
        read_live_session_in(&own, uid).as_deref(),
        Some(contained_id)
    );

    // A DIFFERENT project's subdir is not consulted for this project.
    let other = root.join("p2");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join(uid), "cccccccc-3333-3333-3333-333333333333").unwrap();
    assert_eq!(
        read_live_session_in(&own, uid).as_deref(),
        Some(contained_id)
    );

    // The source record sits beside the id in whichever root holds it, and
    // only a word the hook can have written counts.
    assert_eq!(read_live_source_in(&own, uid), None);
    std::fs::write(own.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "clear\n").unwrap();
    assert_eq!(read_live_source_in(&own, uid).as_deref(), Some("clear"));
    std::fs::write(own.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "--resume x").unwrap();
    assert_eq!(read_live_source_in(&own, uid), None);
    assert_eq!(read_live_source_in(&own, "not-a-uid"), None);

    // "Undo clear" names the cleared conversation only while the session is
    // the one that clear started, the record is an id, and its transcript
    // is there to resume.
    let cleared = "dddddddd-4444-4444-4444-444444444444";
    let prev_path = own.join(format!("{uid}{LIVE_CLEARED_SUFFIX}"));
    assert_eq!(cleared_session_in(&own, uid, |_| true), None);
    std::fs::write(&prev_path, format!("{cleared}\n")).unwrap();
    assert_eq!(cleared_session_in(&own, uid, |_| true), None, "source is not clear");
    std::fs::write(own.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "clear").unwrap();
    assert_eq!(cleared_session_in(&own, uid, |_| true).as_deref(), Some(cleared));
    assert_eq!(cleared_session_in(&own, uid, |id| id != cleared), None, "no transcript");
    std::fs::write(&prev_path, contained_id).unwrap();
    assert_eq!(cleared_session_in(&own, uid, |_| true), None, "that is the live session");
    std::fs::write(&prev_path, "../../etc/passwd").unwrap();
    assert_eq!(cleared_session_in(&own, uid, |_| true), None);
    std::fs::write(own.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "resume").unwrap();

    // Codex's undo points the record back at the cleared conversation and
    // calls it a resume: the relaunch resumes it, and no second undo is left.
    std::fs::write(own.join(format!("{uid}{LIVE_SOURCE_SUFFIX}")), "clear").unwrap();
    std::fs::write(&prev_path, cleared).unwrap();
    restore_cleared_in(&own, uid, cleared).unwrap();
    assert_eq!(read_live_session_in(&own, uid).as_deref(), Some(cleared));
    assert_eq!(read_live_source_in(&own, uid).as_deref(), Some("resume"));
    assert_eq!(cleared_session_in(&own, uid, |_| true), None);
    // An agent without an id to resume by gets no plan from here; the window
    // relaunches it on its own resume flag.
    assert_eq!(undo_clear_plan("gemini", None, uid), None);

    // The project id is reduced to exactly one path-safe component.
    assert_eq!(storage::project_key("my proj/../x"), "my_proj____x");
    assert_eq!(storage::project_key(""), "x");
    assert!(project_live_sessions_dir("p1").ends_with("live_sessions/p1"));

    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(not(windows))]
#[test]
fn hook_body_is_no_op_without_env_and_bakes_dir() {
    let body = hook_script_body(concat!("/home/x/.local/share/", crate::app_slug!(), "/live_sessions"));
    assert!(body.starts_with("#!/bin/sh"));
    assert!(body.contains(concat!("[ -n \"$", crate::app_upper!(), "_TAB_UID\" ] || exit 0")));
    assert!(body.contains(concat!("/home/x/.local/share/", crate::app_slug!(), "/live_sessions")));
    assert!(body.contains("\"session_id\""));
    assert!(body.contains("\"permission_mode\""));
    assert!(body.contains(".mode"));
}

#[cfg(windows)]
#[test]
fn hook_body_is_no_op_without_env_and_bakes_dir() {
    let body = hook_script_body(concat!(r"C:\Users\x\AppData\Roaming\", crate::app_slug!(), r"\live_sessions"));
    assert!(body.contains(concat!("$uid = $env:", crate::app_upper!(), "_TAB_UID")));
    assert!(body.contains("if ([string]::IsNullOrEmpty($uid)) { exit 0 }"));
    assert!(body.contains(concat!(r"C:\Users\x\AppData\Roaming\", crate::app_slug!(), r"\live_sessions")));
    assert!(body.contains("\"session_id\""));
    assert!(body.contains("\"permission_mode\""));
    assert!(body.contains(".mode"));
    assert!(body.contains("forked_from_id"));
    // The container twin bakes the container-side path, POSIX-style.
    let twin = posix_hook_script_body(concat!("/c/Users/x/AppData/Roaming/", crate::app_slug!(), "/live_sessions"));
    assert!(twin.starts_with("#!/bin/sh"));
    assert!(twin.contains(concat!("/c/Users/x/AppData/Roaming/", crate::app_slug!(), "/live_sessions")));
}

/// `/fork` starts a thread with no `SessionStart` the matcher lets through, so
/// the fork's rollout is what moves the record (Codex 0.166.0, payloads and
/// rollout header as captured). The move comes on the fork's first event, or a
/// restart mid-turn would resume the parent.
#[cfg(unix)]
#[test]
fn a_codex_tab_follows_its_fork_and_nothing_else_that_forked() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("hook.sh");
    let live = dir.path().join("live");
    std::fs::write(&script, hook_script_body(&live.to_string_lossy())).unwrap();
    let uid = "66666666-6666-4666-8666-666666666666";
    let parent = "01a18e92-e049-7d11-b744-6b4974752c34";
    let fork = "01a18e93-61d1-7b43-88ec-612383137525";
    let other = "01a18e94-0000-7000-8000-000000000000";
    let event = |sid: &str, name: &str, rollout: &str| {
        format!(r#"{{"session_id":"{sid}","hook_event_name":"{name}","transcript_path":"{rollout}"}}"#)
    };
    let rollout = |name: &str, meta: &str| {
        let path = dir.path().join(name);
        std::fs::write(&path, format!("{{\"type\":\"session_meta\",\"payload\":{{{meta}}}}}\n{{\"type\":\"turn_context\"}}\n")).unwrap();
        path.to_string_lossy().into_owned()
    };
    let start = format!(r#"{{"session_id":"{parent}","hook_event_name":"SessionStart","source":"startup"}}"#);
    let (rec, _) = run_hook(&script, &live, uid, Some("codex"), false, &start);
    assert_eq!(rec.as_deref(), Some(parent));
    let turn = || std::fs::read_to_string(live.join(format!("{uid}.turn"))).unwrap_or_default();

    // A thread that is no fork, a subagent forked off this one, a user's fork
    // of some other thread: none of them is the tab.
    let plain = rollout("plain.jsonl", r#""thread_source":"user""#);
    let subagent = rollout("subagent.jsonl", &format!(r#""forked_from_id":"{parent}","thread_source":"subagent""#));
    let unrelated = rollout("unrelated.jsonl", &format!(r#""forked_from_id":"{other}","thread_source":"user""#));
    for path in [&plain, &subagent, &unrelated, &dir.path().join("gone.jsonl").to_string_lossy().into_owned()] {
        let (rec, _) = run_hook(&script, &live, uid, Some("codex"), false, &event(fork, "UserPromptSubmit", path));
        assert_eq!(rec.as_deref(), Some(parent), "{path}");
        assert!(!turn().starts_with("working"), "{path}");
    }

    // The tab's own fork moves the record at its first prompt, and its turn
    // marks count from there.
    assert!(live.join(format!("{uid}.src")).exists());
    let forked = rollout("fork.jsonl", &format!(r#""forked_from_id":"{parent}","source":"cli","thread_source":"user""#));
    let (rec, _) = run_hook(&script, &live, uid, Some("codex"), false, &event(fork, "UserPromptSubmit", &forked));
    assert_eq!(rec.as_deref(), Some(fork));
    assert!(turn().starts_with("working"));
    assert!(!live.join(format!("{uid}.src")).exists(), "no source word says how a fork came about");
    let (rec, _) = run_hook(&script, &live, uid, Some("codex"), false, &event(fork, "Stop", &forked));
    assert_eq!(rec.as_deref(), Some(fork));
    assert!(turn().starts_with("done"));

    // The parent is somebody else now.
    let (rec, _) = run_hook(&script, &live, uid, Some("codex"), false, &event(parent, "Stop", &plain));
    assert_eq!(rec.as_deref(), Some(fork));
}

/// Run the POSIX hook body as the agents would: `sh <script>` with the tab
/// env and the hook JSON on stdin. Returns the record and mode files' text.
#[cfg(unix)]
fn run_hook(
    script: &std::path::Path,
    live_dir: &std::path::Path,
    uid: &str,
    agent: Option<&str>,
    claudecode: bool,
    payload: &str,
) -> (Option<String>, Option<String>) {
    use std::io::Write as _;
    let mut cmd = std::process::Command::new("sh");
    cmd.arg(script)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env(crate::app_env!("TAB_UID"), uid)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if let Some(a) = agent {
        cmd.env(TAB_AGENT_ENV, a);
    }
    if claudecode {
        cmd.env("CLAUDECODE", "1");
    }
    let mut child = cmd.spawn().expect("sh");
    child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
    let read = |name: String| std::fs::read_to_string(live_dir.join(name)).ok();
    (read(uid.to_string()), read(format!("{uid}.mode")))
}

#[cfg(unix)]
#[test]
fn phone_hint_only_reaches_a_scoped_claude_or_codex_session_start() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("hook.sh");
    std::fs::write(&script, posix_hook_script_body(&dir.path().join("live").to_string_lossy())).unwrap();
    for (agent, scoped, sid, event, expected) in [
        ("claude", true, "aaaa", "SessionStart", true),
        ("claude", false, "aaaa", "SessionStart", false),
        ("claude", true, "bbbb", "SessionStart", false),
        ("claude", true, "aaaa", "Stop", false),
        ("codex", true, "cccc", "SessionStart", true),
        ("codex", false, "cccc", "SessionStart", false),
        ("codex", true, "cccc", "Stop", false),
    ] {
        let mut cmd = std::process::Command::new("sh");
        cmd.arg(&script).env_clear().env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env(crate::app_env!("TAB_UID"), "aaaa").env(crate::app_env!("TAB_AGENT"), agent)
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
        if scoped { cmd.env(crate::app_env!("PROJECT_DIR"), dir.path()); }
        let mut child = cmd.spawn().unwrap();
        write!(child.stdin.take().unwrap(), "{{\"session_id\":\"{sid}\",\"hook_event_name\":\"{event}\",\"source\":\"startup\"}}").unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).contains(concat!(crate::app_slug!(), "-send <file>")), expected, "{agent} {scoped} {sid} {event}");
    }
}

#[cfg(unix)]
#[test]
fn hook_script_lets_only_the_tabs_own_session_move_the_record() {
    let tmp = unique_tmp(concat!(crate::app_slug!(), "-hook-run"));
    let live = tmp.join("live");
    std::fs::create_dir_all(&tmp).unwrap();
    let script = tmp.join("hook.sh");
    std::fs::write(&script, hook_script_body(&live.to_string_lossy())).unwrap();
    let uid = "11111111-1111-4111-8111-111111111111";
    let nested = "22222222-2222-4222-8222-222222222222";
    let cleared = "33333333-3333-4333-8333-333333333333";
    let start = |sid: &str, src: &str| {
        format!(r#"{{"session_id":"{sid}","hook_event_name":"SessionStart","source":"{src}"}}"#)
    };
    let stop = |sid: &str, mode: &str| {
        format!(r#"{{"session_id":"{sid}","hook_event_name":"Stop","permission_mode":"{mode}"}}"#)
    };
    let claude = Some("claude");

    // The tab's own start records its launch id and how it started; Stop
    // records the mode and leaves the source alone.
    let source = || read_live_source_in(&live, uid);
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(uid, "startup"));
    assert_eq!(rec.as_deref(), Some(uid));
    assert_eq!(source().as_deref(), Some("startup"));
    let (rec, mode) = run_hook(&script, &live, uid, claude, true, &stop(uid, "acceptEdits"));
    assert_eq!(rec.as_deref(), Some(uid));
    assert_eq!(mode.as_deref(), Some("acceptEdits"));
    assert_eq!(source().as_deref(), Some("startup"));

    // A nested `claude -p` under the tab (same env, CLAUDECODE set) is refused
    // on both events: neither record moves.
    let (rec, mode) = run_hook(&script, &live, uid, claude, true, &start(nested, "startup"));
    assert_eq!(rec.as_deref(), Some(uid));
    assert_eq!(mode.as_deref(), Some("acceptEdits"));
    let (rec, mode) = run_hook(&script, &live, uid, claude, true, &stop(nested, "default"));
    assert_eq!(rec.as_deref(), Some(uid));
    assert_eq!(mode.as_deref(), Some("acceptEdits"));
    assert_eq!(source().as_deref(), Some("startup"));

    // `/clear` rolls the id — and says so — and the following Stop is
    // accepted for the new one.
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(cleared, "clear"));
    assert_eq!(rec.as_deref(), Some(cleared));
    assert_eq!(source().as_deref(), Some("clear"));
    // The conversation the clear ended is kept beside it, for "Undo clear".
    let prev = || std::fs::read_to_string(live.join(format!("{uid}{LIVE_CLEARED_SUFFIX}"))).ok();
    assert_eq!(prev().as_deref(), Some(uid));
    assert_eq!(cleared_session_in(&live, uid, |_| true).as_deref(), Some(uid));
    let (rec, mode) = run_hook(&script, &live, uid, claude, true, &stop(cleared, "plan"));
    assert_eq!(rec.as_deref(), Some(cleared));
    assert_eq!(mode.as_deref(), Some("plan"));
    // A session command reported as a prompt leaves the undo standing; a
    // prompt in the new chat ends it — resuming the cleared conversation
    // would leave that prompt behind (a second `/clear` queued behind its
    // turn was undone onto the first clear's conversation).
    let prompt = |text: &str| {
        format!(r#"{{"session_id":"{cleared}","hook_event_name":"UserPromptSubmit","prompt":"{text}"}}"#)
    };
    run_hook(&script, &live, uid, claude, true, &prompt("/clear"));
    assert_eq!(cleared_session_in(&live, uid, |_| true).as_deref(), Some(uid));
    run_hook(&script, &live, uid, claude, true, &prompt("fix the build"));
    assert_eq!(prev(), None);
    assert_eq!(cleared_session_in(&live, uid, |_| true), None);
    // …and the launch id itself is always the tab's (a relaunch on `--resume
    // <launch>` after a lost record) — that resume is also the undo, after
    // which there is no clear left to take back.
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(uid, "resume"));
    assert_eq!(rec.as_deref(), Some(uid));
    assert_eq!(cleared_session_in(&live, uid, |_| true), None);
    // A `resume` start to another conversation is the user's choice.
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(nested, "resume"));
    assert_eq!(rec.as_deref(), Some(nested));
    assert_eq!(source().as_deref(), Some("resume"));

    // A Codex started from the tab's shell fires the same `clear` start
    // after its own `/clear` — with no rollout yet (null) or a rollout file,
    // never Claude's `<session_id>.jsonl`. It must not take the record.
    let codex_nested = "01a0d043-b4df-7e63-9813-002da0a652e9";
    let codex_start = |path: &str| {
        format!(r#"{{"session_id":"{codex_nested}","transcript_path":{path},"cwd":"/p","hook_event_name":"SessionStart","model":"m","permission_mode":"default","source":"clear"}}"#)
    };
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &codex_start("null"));
    assert_eq!(rec.as_deref(), Some(nested));
    let rollout = format!(r#""/h/.codex/sessions/2026/09/23/rollout-2026-09-23T23-54-53-{codex_nested}.jsonl""#);
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &codex_start(&rollout));
    assert_eq!(rec.as_deref(), Some(nested));
    assert_eq!(source().as_deref(), Some("resume"));
    // Claude's own `/clear` names its transcript after the new session.
    let claude_clear = format!(
        r#"{{"session_id":"{cleared}","transcript_path":"/h/.claude/projects/-p/{cleared}.jsonl","hook_event_name":"SessionStart","source":"clear"}}"#
    );
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &claude_clear);
    assert_eq!(rec.as_deref(), Some(cleared));
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(nested, "resume"));
    assert_eq!(rec.as_deref(), Some(nested));

    // No agent marker (an older launch): the strict rule applies.
    let (rec, _) = run_hook(&script, &live, uid, None, true, &start(cleared, "startup"));
    assert_eq!(rec.as_deref(), Some(nested));

    // A Codex tab mints its own ids, so its record is free-form — but a
    // Claude fired under it (CLAUDECODE set) is refused.
    let codex_uid = "44444444-4444-4444-8444-444444444444";
    let codex_id = "55555555-5555-4555-8555-555555555555";
    let (rec, _) = run_hook(&script, &live, codex_uid, Some("codex"), false, &start(codex_id, "startup"));
    assert_eq!(rec.as_deref(), Some(codex_id));
    let (rec, _) = run_hook(&script, &live, codex_uid, Some("codex"), true, &start(nested, "startup"));
    assert_eq!(rec.as_deref(), Some(codex_id));

    // No session id → nothing written, not even a mode.
    let other = "66666666-6666-4666-8666-666666666666";
    let (rec, mode) = run_hook(&script, &live, other, claude, true, r#"{"permission_mode":"plan"}"#);
    assert!(rec.is_none() && mode.is_none());
    let _ = std::fs::remove_dir_all(&tmp);
}

/// A `claude --resume` (or a `/clear`) nested under the tab's own Claude —
/// the agent's Bash tool running the CLI — sends the same start a `/resume`
/// typed in the tab does. Only the process chain tells them apart: a
/// `claude` (here: `sh` under that name) under another one, both carrying
/// the tab's id, is refused; one alone, or under a `claude` that is not the
/// tab's, is followed.
#[cfg(target_os = "linux")]
#[test]
fn hook_script_refuses_a_clear_or_resume_from_a_claude_nested_under_the_tabs() {
    let tmp = unique_tmp(concat!(crate::app_slug!(), "-hook-nested"));
    let live = tmp.join("live");
    let bin = tmp.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = tmp.join("hook.sh");
    std::fs::write(&script, hook_script_body(&live.to_string_lossy())).unwrap();
    let claude_bin = bin.join("claude");
    std::os::unix::fs::symlink("/bin/sh", &claude_bin).unwrap();
    let uid = "11111111-1111-4111-8111-111111111111";
    let other = "22222222-2222-4222-8222-222222222222";
    let payload = tmp.join("payload.json");
    // `; true` keeps each shell alive under its command (no exec tail call).
    let hook = r#"sh "$SCRIPT" < "$PAYLOAD"; true"#;
    // An install upgraded across the rename: the hook takes the tab id from
    // the legacy name when the current one is unset, and the tab carries both.
    let legacy_script = tmp.join("hook-legacy.sh");
    let legacy_preamble =
        crate::services::brand_migration::compat::legacy_env_preamble_sh(&crate::brand::PAIR, HOOK_ENV);
    assert!(!legacy_preamble.is_empty());
    std::fs::write(&legacy_script, legacy_preamble + &hook_script_body(&live.to_string_lossy())).unwrap();
    let legacy_tab_uid = crate::brand::PAIR.legacy_env_name("TAB_UID").unwrap();
    let run_with = |script: &std::path::Path, legacy: bool, src: &str, chain: &str| {
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join(uid), uid).unwrap();
        std::fs::write(&payload, format!(r#"{{"session_id":"{other}","hook_event_name":"SessionStart","source":"{src}"}}"#)).unwrap();
        let mut cmd = std::process::Command::new(&claude_bin);
        cmd.arg("-c")
            .arg(chain)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env(crate::app_env!("TAB_UID"), uid)
            .env(TAB_AGENT_ENV, "claude")
            .env("SCRIPT", script)
            .env("PAYLOAD", &payload)
            .env("CLAUDE_BIN", &claude_bin)
            .env("HOOK", hook);
        if legacy {
            cmd.env(&legacy_tab_uid, uid);
        }
        assert!(cmd.status().unwrap().success());
        std::fs::read_to_string(live.join(uid)).unwrap()
    };
    let run = |src: &str, chain: &str| run_with(&script, false, src, chain);
    let alone = format!("{hook}; true");
    let nested = r#""$CLAUDE_BIN" -c "$HOOK"; true"#.to_string();
    // A `claude` above the tab's own (the app launched from a Claude session).
    let tab_uid = crate::app_env!("TAB_UID");
    let outside = format!(r#"env -u {tab_uid} "$CLAUDE_BIN" -c '{tab_uid}="$0" "$CLAUDE_BIN" -c "$HOOK"; true' "${tab_uid}"; true"#);
    for src in ["resume", "clear"] {
        assert_eq!(run(src, &alone), other, "{src} from the tab's own claude");
        assert_eq!(run(src, &nested), uid, "{src} from a claude nested under it");
        assert_eq!(run(src, &outside), other, "{src} under a claude outside the tab");
        // A probe that unsets only the current name still reaches the hook
        // through the legacy one — and must still be seen as nested.
        let half_unset = format!(r#"env -u {tab_uid} "$CLAUDE_BIN" -c "$HOOK"; true"#);
        assert_eq!(run_with(&legacy_script, true, src, &half_unset), uid, "{src} nested, current name unset");
        assert_eq!(run_with(&legacy_script, true, src, &alone), other, "{src} from the tab's own claude, legacy install");
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

/// The same guard where `/proc` is unreadable (macOS): the hook walks the
/// chain with `ps` instead. The procfs root is an empty directory and a
/// `ps` shim answers `ppid=` / `comm=` / `command=` (the environment only
/// with `-E`) from a scripted chain that starts at the hook's parent — this
/// test process. Like BSD `ps` with no tty, it cuts its line at 79 columns
/// unless given `-ww`.
#[cfg(unix)]
#[test]
fn hook_script_walks_the_chain_with_ps_where_proc_is_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = unique_tmp(concat!(crate::app_slug!(), "-hook-nested-ps"));
    let live = tmp.join("live");
    let bin = tmp.join("bin");
    let no_proc = tmp.join("no-proc");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&no_proc).unwrap();
    let script = tmp.join("hook.sh");
    std::fs::write(&script, posix_hook_script_body_with(&live.to_string_lossy(), &no_proc.to_string_lossy())).unwrap();
    // The production body is this one with `/proc` baked in.
    assert_eq!(posix_hook_script_body("/l"), posix_hook_script_body_with("/l", "/proc"));
    let chain = tmp.join("chain");
    let ps = bin.join("ps");
    std::fs::write(
        &ps,
        format!(
            "#!/bin/sh\nf= p= env= w=\nwhile [ $# -gt 0 ]; do\n\
                 \x20 case \"$1\" in -E) env=1 ;; -ww) w=1 ;; -o) f=$2; shift ;; -p) p=$2; shift ;; esac\n\
                 \x20 shift\ndone\n\
                 while IFS='|' read -r pid ppid comm args envs; do\n\
                 \x20 [ \"$pid\" = \"$p\" ] || continue\n\
                 \x20 case \"$f\" in\n\
                 \x20   ppid=) out=\"  $ppid\" ;;\n\
                 \x20   comm=) out=$comm ;;\n\
                 \x20   command=) if [ -n \"$env\" ]; then out=\"$args $envs\"; else out=$args; fi ;;\n\
                 \x20 esac\n\
                 \x20 if [ -n \"$w\" ]; then printf '%s\\n' \"$out\"; else printf '%s\\n' \"$out\" | cut -c1-79; fi\n\
                 \x20 exit 0\ndone < '{}'\nexit 1\n",
            chain.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&ps, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
    let uid = "11111111-1111-4111-8111-111111111111";
    let other = "22222222-2222-4222-8222-222222222222";
    let tab_uid = crate::app_env!("TAB_UID");
    let legacy_tab_uid = crate::brand::PAIR.legacy_env_name("TAB_UID").unwrap();
    let me = std::process::id();
    let run = |src: &str, lines: &[String]| {
        use std::io::Write as _;
        std::fs::write(&chain, lines.join("\n") + "\n").unwrap();
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join(uid), uid).unwrap();
        let mut child = std::process::Command::new("sh")
            .arg(&script)
            .env_clear()
            .env("PATH", &path)
            .env(tab_uid, uid)
            .env(TAB_AGENT_ENV, "claude")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        write!(
            child.stdin.take().unwrap(),
            r#"{{"session_id":"{other}","hook_event_name":"SessionStart","source":"{src}"}}"#
        )
        .unwrap();
        assert!(child.wait().unwrap().success());
        std::fs::read_to_string(live.join(uid)).unwrap()
    };
    let launchd = "1|0|/sbin/launchd|/sbin/launchd|".to_string();
    for src in ["resume", "clear"] {
        // The tab's own Claude (full executable path, as macOS `comm` prints it).
        let alone = [format!("{me}|1|/Users/x/.local/bin/claude|claude --resume|{tab_uid}={uid} HOME=/h"), launchd.clone()];
        assert_eq!(run(src, &alone), other, "{src} from the tab's own claude");
        // A `claude -p --resume` from the agent's Bash tool, under the tab's.
        let nested = [
            format!("{me}|500|claude|claude -p --resume x|{tab_uid}={uid}"),
            format!("500|1|/Users/x/.local/bin/claude|claude|{tab_uid}={uid}"),
            launchd.clone(),
        ];
        assert_eq!(run(src, &nested), uid, "{src} from a claude nested under it");
        // A `claude` above the tab's own that is not the tab's (no tab id).
        let outside = [format!("{me}|500|claude|claude|{tab_uid}={uid}"), "500|1|claude|claude|PATH=/bin".to_string(), launchd.clone()];
        assert_eq!(run(src, &outside), other, "{src} under a claude outside the tab");
        // Only the legacy name set on the nested run, and an executable named
        // otherwise whose argv[0] is `claude` (a retitled node): still nested.
        let legacy = [
            format!("{me}|500|node|claude -p|{legacy_tab_uid}={uid}"),
            format!("500|1|claude|claude|{tab_uid}={uid} {legacy_tab_uid}={uid}"),
            launchd.clone(),
        ];
        assert_eq!(run(src, &legacy), uid, "{src} nested, current name unset");
        // Real lines are long: the native installer's versioned executable,
        // and the tab id somewhere in a full environment. BSD `ps` without
        // `-ww` would cut both at 79 columns and the nested run would pass.
        let exe = "/Users/someone/.local/share/claude/versions/2.1.294/claude";
        let envs = format!("TERM=xterm-256color SHELL=/bin/zsh HOME=/Users/someone LANG=en_US.UTF-8 {tab_uid}={uid}");
        let long = [
            format!("{me}|500|{exe}|claude -p --resume 33333333-3333-4333-8333-333333333333 --output-format json|{envs}"),
            format!("500|1|/Users/someone/Library/Application Support/SomeLauncher/runtime/node_modules/.bin/claude|node|{envs}"),
            launchd.clone(),
        ];
        assert_eq!(run(src, &long), uid, "{src} nested, long ps lines");
        // Another tab's id stops the walk; a `ps` that knows nothing counts nothing.
        let foreign = [format!("{me}|500|claude|claude|{tab_uid}={other}"), format!("500|1|claude|claude|{tab_uid}={uid}")];
        assert_eq!(run(src, &foreign), other, "{src} under another tab's id");
        assert_eq!(run(src, &[]), other, "{src} with nothing to walk");
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

/// Claude relaunching itself before the first prompt (renderer switch,
/// update) comes back under a fresh id with a plain `startup`: the record
/// follows it while the tab's own session has no transcript, and only then.
#[cfg(unix)]
#[test]
fn hook_script_follows_a_relaunch_that_minted_a_fresh_id() {
    let tmp = unique_tmp(concat!(crate::app_slug!(), "-hook-relaunch"));
    let live = tmp.join("live");
    let transcripts = tmp.join("projects").join("-p");
    std::fs::create_dir_all(&transcripts).unwrap();
    let script = tmp.join("hook.sh");
    std::fs::write(&script, hook_script_body(&live.to_string_lossy())).unwrap();
    let uid = "11111111-1111-4111-8111-111111111111";
    let fresh = "22222222-2222-4222-8222-222222222222";
    let again = "33333333-3333-4333-8333-333333333333";
    let path = |sid: &str| transcripts.join(format!("{sid}.jsonl"));
    let start = |sid: &str, tpath: &str| {
        format!(r#"{{"session_id":"{sid}","transcript_path":{tpath},"hook_event_name":"SessionStart","source":"startup"}}"#)
    };
    let own = |sid: &str| format!("\"{}\"", path(sid).display());
    let claude = Some("claude");
    let source = || read_live_source_in(&live, uid);

    // The launch id starts the tab; nothing has been written for it yet.
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(uid, &own(uid)));
    assert_eq!(rec.as_deref(), Some(uid));
    // A Codex under the tab (null path, then a rollout) is still refused.
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(fresh, "null"));
    assert_eq!(rec.as_deref(), Some(uid));
    let rollout = format!(r#""/h/.codex/sessions/rollout-2026-09-25T20-46-46-{fresh}.jsonl""#);
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(fresh, &rollout));
    assert_eq!(rec.as_deref(), Some(uid));
    // The relaunched Claude, transcript named after its fresh id: followed.
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(fresh, &own(fresh)));
    assert_eq!(rec.as_deref(), Some(fresh));
    assert_eq!(source().as_deref(), Some("startup"));
    let stop = format!(r#"{{"session_id":"{fresh}","hook_event_name":"Stop","permission_mode":"acceptEdits"}}"#);
    let (rec, mode) = run_hook(&script, &live, uid, claude, true, &stop);
    assert_eq!(rec.as_deref(), Some(fresh));
    assert_eq!(mode.as_deref(), Some("acceptEdits"));

    // Once the session has been prompted (its transcript exists), a plain
    // start under another id is a CLI nested under the tab: refused.
    std::fs::write(path(fresh), "{}").unwrap();
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(again, &own(again)));
    assert_eq!(rec.as_deref(), Some(fresh));
    // …also when it runs from another cwd: its transcript lands in that
    // cwd's project folder, where the tab's own is not.
    let elsewhere = tmp.join("projects").join("-tmp");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let away = format!("\"{}\"", elsewhere.join(format!("{again}.jsonl")).display());
    let (rec, _) = run_hook(&script, &live, uid, claude, true, &start(again, &away));
    assert_eq!(rec.as_deref(), Some(fresh));
    // …as it is without the agent marker, whatever the transcripts say.
    std::fs::remove_file(path(fresh)).unwrap();
    let (rec, _) = run_hook(&script, &live, uid, None, true, &start(again, &own(again)));
    assert_eq!(rec.as_deref(), Some(fresh));

    // A tab whose first start was already the relaunch has no record at
    // all: the launch id's missing transcript is what lets it in.
    let other = "44444444-4444-4444-8444-444444444444";
    let (rec, _) = run_hook(&script, &live, other, claude, true, &start(again, &own(again)));
    assert_eq!(rec.as_deref(), Some(again));
    // …and a launch id that did write one keeps the record where it is.
    std::fs::write(path(again), "{}").unwrap();
    let (rec, _) = run_hook(&script, &live, other, claude, true, &start(fresh, &own(fresh)));
    assert_eq!(rec.as_deref(), Some(again));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn a_resume_record_is_four_bounded_fields_and_nothing_else() {
    let ok = parse_resume_record("4 25960 0.1038 false\n").unwrap();
    assert_eq!(
        ok,
        ResumeCost { seconds_idle: 4, context_tokens: 25960, cache_write_usd: 0.1038, cache_expired: false }
    );
    assert!(parse_resume_record("90000 183000 0.42 true").unwrap().cache_expired);
    for junk in ["", "4 25960 0.1038", "4 25960 0.1038 maybe", "4 25960 0.1038 true extra", "x 1 1 true", "1 1 -2 true", "1 1 NaN true", "1 999999999999 1 true", "1 1 1e9 true"] {
        assert_eq!(parse_resume_record(junk), None, "{junk:?}");
    }
}

#[cfg(unix)]
#[test]
fn hook_script_records_what_a_resume_will_cost_and_clears_it_on_any_other_start() {
    let tmp = unique_tmp(concat!(crate::app_slug!(), "-hook-resume"));
    let live = tmp.join("live");
    std::fs::create_dir_all(&tmp).unwrap();
    let script = tmp.join("hook.sh");
    std::fs::write(&script, hook_script_body(&live.to_string_lossy())).unwrap();
    let uid = "11111111-1111-4111-8111-111111111111";
    let claude = Some("claude");
    let cost = || read_live_resume_in(&live, uid);
    let start = |source: &str, extra: &str| {
        format!(r#"{{"session_id":"{uid}","hook_event_name":"SessionStart","source":"{source}"{extra}}}"#)
    };

    // The 2.1.306 payload: the figures in the order the CLI sends them, and
    // in another one — keys are matched by name.
    let figures = r#","seconds_since_last_response":90000,"context_tokens":183000,"prompt_cache_likely_expired":true,"estimated_cache_write_usd":0.4213"#;
    run_hook(&script, &live, uid, claude, true, &start("resume", figures));
    assert_eq!(
        cost(),
        Some(ResumeCost { seconds_idle: 90000, context_tokens: 183000, cache_write_usd: 0.4213, cache_expired: true })
    );
    // A warm resume says so.
    let warm = r#","seconds_since_last_response":4,"context_tokens":25960,"estimated_cache_write_usd":0.1038,"prompt_cache_likely_expired":false"#;
    run_hook(&script, &live, uid, claude, true, &start("resume", warm));
    assert_eq!(cost().map(|c| c.cache_expired), Some(false));
    // A resume start without the fields (an older CLI) leaves none.
    run_hook(&script, &live, uid, claude, true, &start("resume", ""));
    assert_eq!(cost(), None);
    // Any other start clears the last one, and a Stop does not write one.
    run_hook(&script, &live, uid, claude, true, &start("resume", figures));
    assert!(cost().is_some());
    let stop = format!(r#"{{"session_id":"{uid}","hook_event_name":"Stop"{figures}}}"#);
    run_hook(&script, &live, uid, claude, true, &stop);
    assert!(cost().is_some(), "a Stop leaves the record alone");
    run_hook(&script, &live, uid, claude, true, &start("clear", figures));
    assert_eq!(cost(), None);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[cfg(unix)]
#[test]
fn hook_script_records_the_turn_state_for_the_tabs_own_session_only() {
    let tmp = unique_tmp(concat!(crate::app_slug!(), "-hook-turn"));
    let live = tmp.join("live");
    std::fs::create_dir_all(&tmp).unwrap();
    let script = tmp.join("hook.sh");
    std::fs::write(&script, hook_script_body(&live.to_string_lossy())).unwrap();
    let uid = "11111111-1111-4111-8111-111111111111";
    let nested = "22222222-2222-4222-8222-222222222222";
    let claude = Some("claude");
    let turn = || {
        std::fs::read_to_string(live.join(format!("{uid}.turn")))
            .ok()
            .map(|t| t.split_whitespace().next().unwrap_or("").to_string())
    };
    let ev = |sid: &str, event: &str, extra: &str| {
        format!(r#"{{"session_id":"{sid}","hook_event_name":"{event}"{extra}}}"#)
    };

    // Nothing until a turn event: a start writes the session record only.
    run_hook(&script, &live, uid, claude, true, &ev(uid, "SessionStart", r#","source":"startup""#));
    assert_eq!(turn(), None);
    run_hook(&script, &live, uid, claude, true, &ev(uid, "UserPromptSubmit", ""));
    assert_eq!(turn().as_deref(), Some("working"));
    run_hook(&script, &live, uid, claude, true, &ev(uid, "Notification", r#","notification_type":"permission_prompt""#));
    assert_eq!(turn().as_deref(), Some("decision"));
    run_hook(&script, &live, uid, claude, true, &ev(uid, "PostToolUse", r#","tool_name":"Bash""#));
    assert_eq!(turn().as_deref(), Some("working"));
    // A Bash call put in the background leaves its task id for the job scan
    // (the result's shape as Claude 2.1.300 records it); a foreground call,
    // even one whose OUTPUT quotes such a field, leaves none.
    let bg = || std::fs::read_to_string(live.join(format!("{uid}.bg"))).ok();
    let fg_result = r#","tool_name":"Bash","tool_response":{"stdout":"{\"backgroundTaskId\":\"zzz9\"}","stderr":""}"#;
    run_hook(&script, &live, uid, claude, true, &ev(uid, "PostToolUse", fg_result));
    assert_eq!(bg(), None);
    let bg_result = |id: &str| {
        format!(r#","tool_name":"Bash","tool_response":{{"stdout":"","stderr":"","interrupted":false,"backgroundTaskId":"{id}"}}"#)
    };
    run_hook(&script, &live, uid, claude, true, &ev(uid, "PostToolUse", &bg_result("brwkwm4yv")));
    assert_eq!(bg().as_deref(), Some("brwkwm4yv\n"));
    assert_eq!(turn().as_deref(), Some("working"));
    // Only the last sixteen are kept.
    for i in 0..20 {
        run_hook(&script, &live, uid, claude, true, &ev(uid, "PostToolUse", &bg_result(&format!("t{i}"))));
    }
    let kept: Vec<String> = bg().unwrap().lines().map(str::to_string).collect();
    assert_eq!(kept, (4..20).map(|i| format!("t{i}")).collect::<Vec<_>>());
    // A notification that is not a wait leaves the state alone.
    run_hook(&script, &live, uid, claude, true, &ev(uid, "Notification", r#","notification_type":"auth_success""#));
    assert_eq!(turn().as_deref(), Some("working"));
    let (rec, mode) = run_hook(&script, &live, uid, claude, true, &ev(uid, "Stop", r#","permission_mode":"plan""#));
    assert_eq!(turn().as_deref(), Some("done"));
    // Stop still keeps the session record and the mode current.
    assert_eq!(rec.as_deref(), Some(uid));
    assert_eq!(mode.as_deref(), Some("plan"));
    run_hook(&script, &live, uid, claude, true, &ev(uid, "Notification", r#","notification_type":"idle_prompt""#));
    assert_eq!(turn().as_deref(), Some("done"));

    // A nested `claude -p` under the tab fires the same events for its own
    // session: none of them may move this tab's state.
    run_hook(&script, &live, uid, claude, true, &ev(nested, "UserPromptSubmit", ""));
    assert_eq!(turn().as_deref(), Some("done"));
    run_hook(&script, &live, uid, claude, true, &ev(nested, "Stop", ""));
    assert_eq!(turn().as_deref(), Some("done"));

    // A /clear ends the session but not the CLI: the tab is still at its
    // prompt, so its `done` stands instead of handing the tab back to its
    // screen (where the last reply could read as a question).
    run_hook(&script, &live, uid, claude, true, &ev(uid, "SessionEnd", r#","reason":"clear""#));
    assert_eq!(turn().as_deref(), Some("done"));
    run_hook(&script, &live, uid, claude, true, &ev(uid, "SessionEnd", r#","reason":"prompt_input_exit""#));
    assert_eq!(turn().as_deref(), Some("idle"));

    // Codex: its start is free-form, and from then on only that session's
    // turn events count — a nested `codex exec` is somebody else.
    let codex_uid = "44444444-4444-4444-8444-444444444444";
    let codex_id = "55555555-5555-4555-8555-555555555555";
    let cturn = || {
        std::fs::read_to_string(live.join(format!("{codex_uid}.turn")))
            .ok()
            .map(|t| t.split_whitespace().next().unwrap_or("").to_string())
    };
    run_hook(&script, &live, codex_uid, Some("codex"), false, &ev(codex_id, "SessionStart", r#","source":"startup""#));
    run_hook(&script, &live, codex_uid, Some("codex"), false, &ev(codex_id, "UserPromptSubmit", ""));
    assert_eq!(cturn().as_deref(), Some("working"));
    run_hook(&script, &live, codex_uid, Some("codex"), false, &ev(nested, "Stop", ""));
    assert_eq!(cturn().as_deref(), Some("working"));
    let (rec, _) = run_hook(&script, &live, codex_uid, Some("codex"), false, &ev(codex_id, "Stop", ""));
    assert_eq!(cturn().as_deref(), Some("done"));
    // …and the nested Stop did not steal the session record either.
    assert_eq!(rec.as_deref(), Some(codex_id));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn resolve_finds_a_log_under_any_of_several_roots() {
    // The fenced/contained stage holds a transcript until the tab goes away;
    // a respawn meanwhile must still see it — reusing the `--session-id`
    // would be refused by Claude.
    let uuid = "9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d";
    let empty = projects_with_sessions(&[]);
    let stage = projects_with_sessions(&[uuid]);
    let out = resolve_claude_session_in(
        opts_with_args(&["--session-id", uuid]),
        &[empty.as_path(), stage.as_path()],
        |_| None,
        |_| None,
    );
    assert_eq!(out.args, vec!["--resume".to_string(), uuid.to_string()]);
    assert_eq!(out.env.get(TAB_AGENT_ENV).map(String::as_str), Some("claude"));
}

#[test]
fn resolvers_stamp_the_tab_agent_over_whatever_the_layout_carried() {
    let projects = projects_with_sessions(&[]);
    let mut opts = opts_with_args(&["--session-id", "abc-123"]);
    opts.env.insert(TAB_AGENT_ENV.to_string(), "codex".to_string());
    let out = resolve_claude_session_impl(opts, &projects, |_| None, |_| None);
    assert_eq!(out.env.get(TAB_AGENT_ENV).map(String::as_str), Some("claude"));

    let mut opts = opts_with_args(&[]);
    opts.cmd = "codex".to_string();
    opts.env
        .insert(crate::app_env!("TAB_UID").to_string(), "11111111-1111-4111-8111-111111111111".to_string());
    let out = resolve_codex_session_impl(opts, &projects, &[], |_| None);
    assert_eq!(out.env.get(TAB_AGENT_ENV).map(String::as_str), Some("codex"));
}

#[test]
fn register_hook_is_idempotent_and_preserves_other_keys() {
    let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-settings-{}"), std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let settings = tmp.join("settings.json");
    std::fs::write(
        &settings,
        r#"{"model":"opus","hooks":{"Stop":[{"hooks":[]}]}}"#,
    )
    .unwrap();

    register_hook_in_settings(&HomeFile::open(&tmp, "settings.json").unwrap()).unwrap();
    register_hook_in_settings(&HomeFile::open(&tmp, "settings.json").unwrap()).unwrap(); // second call must not duplicate

    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    // unrelated keys survive
    assert_eq!(v["model"], "opus");
    assert!(v["hooks"]["Stop"].is_array());
    // exactly one SessionStart handler was added
    let ss = v["hooks"]["SessionStart"].as_array().unwrap();
    assert_eq!(ss.len(), 1);
    let cmd = ss[0]["hooks"][0]["command"].as_str().unwrap();
    // unix registers the bare script path (ends with the name); Windows wraps it
    // in a `powershell ... -File "<path>"` invocation, so assert containment.
    assert!(cmd.contains(HOOK_SCRIPT_NAME));
    // The Stop handler (permission-mode capture) is registered too — appended
    // AFTER the user's own Stop group, which survives untouched.
    let stop = v["hooks"]["Stop"].as_array().unwrap();
    assert_eq!(stop.len(), 2);
    let ours = |g: &serde_json::Value| {
        g["hooks"].as_array().is_some_and(|hs| {
            hs.iter()
                .any(|h| h["command"].as_str().is_some_and(|c| c.contains(HOOK_SCRIPT_NAME)))
        })
    };
    assert!(!ours(&stop[0]) && ours(&stop[1]));
    // The turn-state events are registered too, one group each.
    for ev in ["UserPromptSubmit", "PostToolUse", "Notification", "SessionEnd"] {
        let groups = v["hooks"][ev].as_array().unwrap();
        assert_eq!(groups.len(), 1, "{ev}");
        assert!(ours(&groups[0]), "{ev}");
    }
    // An install that predates the turn events gains exactly those.
    std::fs::write(
        &settings,
        format!(
            r#"{{"hooks":{{"SessionStart":[{{"hooks":[{{"type":"command","command":{cmd}}}]}}],"Stop":[{{"hooks":[{{"type":"command","command":{cmd}}}]}}]}}}}"#,
            cmd = serde_json::to_string(&hook_command()).unwrap()
        ),
    )
    .unwrap();
    register_hook_in_settings(&HomeFile::open(&tmp, "settings.json").unwrap()).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    for ev in HOOK_EVENTS {
        assert_eq!(v["hooks"][ev].as_array().unwrap().len(), 1, "{ev}");
    }

    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn register_codex_hook_appends_once_and_preserves_toml() {
    let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-codex-{}"), std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let config = tmp.join("config.toml");
    // A realistic pre-existing config with project tables.
    std::fs::write(
        &config,
        "model = \"o3\"\n\n[projects.\"/home/x\"]\ntrust_level = \"trusted\"\n",
    )
    .unwrap();

    register_codex_hook_in(&HomeFile::open(&tmp, "config.toml").unwrap()).unwrap();
    register_codex_hook_in(&HomeFile::open(&tmp, "config.toml").unwrap()).unwrap(); // idempotent

    let out = std::fs::read_to_string(&config).unwrap();
    // original content preserved verbatim at the top
    assert!(out.starts_with("model = \"o3\""));
    assert!(out.contains("[projects.\"/home/x\"]"));
    // hook appended exactly once per event
    assert_eq!(out.matches("[[hooks.SessionStart]]").count(), 1);
    assert!(out.contains("matcher = \"startup|resume|clear|compact\""));
    assert!(out.contains(HOOK_SCRIPT_NAME));
    for ev in CODEX_HOOK_EVENTS {
        assert_eq!(out.matches(&format!("[[hooks.{ev}]]")).count(), 1, "{ev}");
        assert_eq!(out.matches(&format!("[[hooks.{ev}.hooks]]")).count(), 1, "{ev}");
    }
    // Only SessionStart carries a matcher.
    assert_eq!(out.matches("matcher =").count(), 1);
    let have = codex_registered_events(&out, &hook_command());
    assert!(CODEX_HOOK_EVENTS.iter().all(|ev| have.contains(*ev)));

    // An install that registered SessionStart alone gains the turn events
    // and keeps its one SessionStart block.
    std::fs::write(
        &config,
        format!(
            "model = \"o3\"\n\n[[hooks.SessionStart]]\nmatcher = \"startup\"\n\n\
                 [[hooks.SessionStart.hooks]]\ntype = \"command\"\ncommand = '{}'\ntimeout = 10\n",
            hook_command()
        ),
    )
    .unwrap();
    register_codex_hook_in(&HomeFile::open(&tmp, "config.toml").unwrap()).unwrap();
    let out = std::fs::read_to_string(&config).unwrap();
    assert_eq!(out.matches("[[hooks.SessionStart]]").count(), 1);
    assert_eq!(out.matches("[[hooks.Stop]]").count(), 1);
    assert_eq!(out.matches("[[hooks.UserPromptSubmit]]").count(), 1);
    // Somebody else's hook on an event we register does not count as ours.
    assert_eq!(
        codex_registered_events(
            "[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = '/theirs.sh'\n",
            &hook_command()
        )
        .len(),
        0
    );

    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn codex_session_end_hook_stays_under_codexs_clamp() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.toml");
    let cmd = hook_command();
    let timeout_of = |src: &str, ev: &str| -> Vec<String> {
        let mut cur = String::new();
        src.lines()
            .filter_map(|l| {
                if l.starts_with('[') {
                    cur = l.to_string();
                }
                toml_value(l, "timeout").filter(|_| cur == format!("[[hooks.{ev}.hooks]]"))
            })
            .collect()
    };

    // A fresh registration writes 3 on SessionEnd, 10 elsewhere.
    register_codex_hook_in(&HomeFile::open(tmp.path(), "config.toml").unwrap()).unwrap();
    let out = std::fs::read_to_string(&config).unwrap();
    assert_eq!(timeout_of(&out, "SessionEnd"), ["3"]);
    assert_eq!(timeout_of(&out, "Stop"), ["10"]);

    // An older build's `timeout = 10` on our SessionEnd is lowered in
    // place; the user's own SessionEnd hook, the trust state and CRLF line
    // ends survive untouched.
    let old = format!(
        "[[hooks.SessionEnd]]\r\n\r\n[[hooks.SessionEnd.hooks]]\r\ntype = \"command\"\r\ncommand = '/theirs.sh'\r\ntimeout = 30\r\n\r\n\
             [[hooks.SessionEnd]]\r\n\r\n[[hooks.SessionEnd.hooks]]\r\ntype = \"command\"\r\ncommand = '{cmd}'\r\ntimeout = 10\r\n\r\n\
             [hooks.state.\"{CFG}:session_end:1:0\"]\r\ntrusted_hash = \"sha256:d709\"\r\n"
    );
    let capped = cap_codex_session_end_timeout(&old, &cmd).unwrap();
    assert_eq!(capped, old.replace("'\r\ntimeout = 10\r\n", "'\r\ntimeout = 3\r\n"));
    assert!(capped.contains("timeout = 30\r\n"));
    // Already low enough: nothing to do.
    assert_eq!(cap_codex_session_end_timeout(&capped, &cmd), None);

    // Registration applies it even when every event is already there.
    std::fs::write(&config, out.replace("timeout = 3\n", "timeout = 10\n")).unwrap();
    register_codex_hook_in(&HomeFile::open(tmp.path(), "config.toml").unwrap()).unwrap();
    let again = std::fs::read_to_string(&config).unwrap();
    assert_eq!(again, out);
}

// ── Codex hook trust state ──────────────────────────────────────────────

const CFG: &str = "/home/x/.codex/config.toml";
const CMD: &str = concat!("/home/x/.local/share/", crate::app_slug!(), "/hooks/", crate::app_slug!(), "_session_start.sh");

/// Our hook block as `register_codex_hook_in` writes it.
fn our_hook() -> String {
    format!(
        "[[hooks.SessionStart]]\n\
             matcher = \"startup|resume|clear|compact\"\n\n\
             [[hooks.SessionStart.hooks]]\n\
             type = \"command\"\n\
             command = '{CMD}'\n\
             timeout = 10\n"
    )
}

#[test]
fn codex_hook_state_reports_disabled_when_the_trust_gate_is_off() {
    // Regression test for the bug this whole path exists to fix: Codex had
    // hashed our hook and recorded `enabled = false`, so it never ran and
    // Codex tabs silently restored blank.
    let src = format!(
        "model = \"o3\"\n\n{}\n[hooks.state]\n\n[hooks.state.\"{CFG}:session_start:0:0\"]\n\
             trusted_hash = \"sha256:93f0\"\nenabled = false\n",
        our_hook()
    );
    assert_eq!(
        codex_hook_state_in(&src, CFG, CMD),
        CodexHookState::Disabled
    );
}

#[test]
fn codex_hook_state_reports_untrusted_without_a_verdict() {
    let src = our_hook();
    assert_eq!(
        codex_hook_state_in(&src, CFG, CMD),
        CodexHookState::Untrusted
    );
}

#[test]
fn codex_hook_state_reports_enabled_when_trusted() {
    let src = format!(
        "{}\n[hooks.state.\"{CFG}:session_start:0:0\"]\nenabled = true\n",
        our_hook()
    );
    assert_eq!(codex_hook_state_in(&src, CFG, CMD), CodexHookState::Enabled);
}

#[test]
fn codex_hook_state_reads_a_bare_trusted_hash_as_enabled() {
    // Codex 0.159 writes a trusted hook as its hash alone. Read as
    // untrusted, the cwd binder kept guessing beside the live hook and gave
    // one tab's fresh `/clear` rollout to its sibling: two phone tabs, one
    // conversation.
    let src = format!(
        "{}\n[hooks.state]\n\n[hooks.state.\"{CFG}:post_tool_use:0:0\"]\ntrusted_hash = \"sha256:c6bc\"\n\n\
             [hooks.state.\"{CFG}:session_start:0:0\"]\ntrusted_hash = \"sha256:93f0\"\n\n\
             [projects.\"/home/x\"]\ntrust_level = \"trusted\"\n",
        our_hook()
    );
    assert_eq!(codex_hook_state_in(&src, CFG, CMD), CodexHookState::Enabled);
    // `enabled = false` after the hash still switches it off.
    let off = src.replace("sha256:93f0\"\n", "sha256:93f0\"\nenabled = false\n");
    assert_eq!(codex_hook_state_in(&off, CFG, CMD), CodexHookState::Disabled);
}

#[test]
fn codex_hook_state_indexes_our_hook_past_the_users_own() {
    // A user hook group precedes ours, so our verdict key is `:0:0` → no,
    // `:1:0`. Their `enabled = true` at `:0:0` must not be read as ours.
    let src = format!(
        "[[hooks.SessionStart]]\n\n[[hooks.SessionStart.hooks]]\n\
             type = \"command\"\ncommand = '/usr/bin/their-hook.sh'\n\n\
             {}\n[hooks.state.\"{CFG}:session_start:0:0\"]\nenabled = true\n",
        our_hook()
    );
    assert_eq!(
        codex_hook_state_in(&src, CFG, CMD),
        CodexHookState::Untrusted
    );

    // And with the verdict at *our* index, we read it.
    let trusted = format!("{src}\n[hooks.state.\"{CFG}:session_start:1:0\"]\nenabled = true\n");
    assert_eq!(
        codex_hook_state_in(&trusted, CFG, CMD),
        CodexHookState::Enabled
    );
}

#[test]
fn codex_hook_state_is_not_registered_without_our_command() {
    let src = "model = \"o3\"\n\n[projects.\"/home/x\"]\ntrust_level = \"trusted\"\n";
    assert_eq!(
        codex_hook_state_in(src, CFG, CMD),
        CodexHookState::NotRegistered
    );
}

/// What Codex 0.164.0 itself wrote for a hook whose command is
/// `/opt/hooks/session.sh`, through "Trust all and continue" (live,
/// 2026-10-23; its `SessionEnd` had `timeout = 10`, which Codex clamps).
const LIVE_HASHES: [(&str, &str); 5] = [
    ("session_start", "sha256:0eed17ea75189a772936e59f60528cdb269f4990d139cbfd832a665def39a987"),
    ("stop", "sha256:884a6ed2800a693aac33a14bfacb450c35e4d68b5e7dd76b5309cc70c25b86c0"),
    ("user_prompt_submit", "sha256:996b5f251186849e3aba28f25377d93afe0f19f6b88580139513994a85c183da"),
    ("post_tool_use", "sha256:cae7882a9a43fe21630abbbcd77dbc94a79f8deccdc8105baeaf5748f50f9151"),
    ("session_end", "sha256:0aee76ee8e8150b8b99cbacae20528f5663be4655b1590fc1749d43d6291b54b"),
];

/// Our five hook blocks for `cmd`, exactly as registration writes them.
fn registered_codex_config(cmd: &str, before: &str) -> String {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join(".codex")).unwrap();
    std::fs::write(tmp.path().join(".codex/config.toml"), before).unwrap();
    register_codex_hook_as(&HomeFile::open(tmp.path(), ".codex/config.toml").unwrap(), cmd).unwrap();
    std::fs::read_to_string(tmp.path().join(".codex/config.toml")).unwrap()
}

#[test]
fn codex_hooks_are_trusted_with_the_hash_codex_writes() {
    let cmd = "/opt/hooks/session.sh";
    let cfg = "/c/.codex/config.toml";
    let src = registered_codex_config(cmd, "model = \"o3\"\n");
    let out = trust_codex_hooks_in(&src, &[cfg.to_string()], cmd).expect("something to trust");
    for (label, hash) in LIVE_HASHES {
        let table = format!("[hooks.state.\"{cfg}:{label}:0:0\"]\ntrusted_hash = \"{hash}\"\n");
        assert!(out.contains(&table), "{label} missing in\n{out}");
    }
    assert!(out.starts_with(&src), "the existing text is kept byte for byte");
    assert_eq!(codex_hook_state_in(&out, cfg, cmd), CodexHookState::Enabled);
    // Run again: nothing left to do.
    assert_eq!(trust_codex_hooks_in(&out, &[cfg.to_string()], cmd), None);
}

#[test]
fn codex_hook_trust_fixes_a_stale_or_disabled_verdict_in_place() {
    let cmd = "/opt/hooks/session.sh";
    let codex_cfg = "/c/.codex/config.toml";
    let src = format!(
        "{}[hooks.state]\n\n[hooks.state.\"{codex_cfg}:session_start:0:0\"]\n\
             trusted_hash = \"sha256:0bad\"\nenabled = false\n\n[tui]\nx = 1\n",
        registered_codex_config(cmd, ""),
    );
    let out = trust_codex_hooks_in(&src, &[codex_cfg.to_string()], cmd).unwrap();
    let start = format!(
        "[hooks.state.\"{codex_cfg}:session_start:0:0\"]\ntrusted_hash = \"{}\"\n\n[tui]\nx = 1\n",
        LIVE_HASHES[0].1
    );
    assert!(out.contains(&start), "{out}");
    assert!(!out.contains("sha256:0bad") && !out.contains("enabled = false"));
    assert_eq!(out.matches(&format!("[hooks.state.\"{codex_cfg}:session_start:0:0\"]")).count(), 1);
    assert_eq!(codex_hook_state_in(&out, codex_cfg, cmd), CodexHookState::Enabled);
}

#[test]
fn codex_hook_trust_counts_positions_and_leaves_other_hooks_alone() {
    let cmd = "/opt/hooks/session.sh";
    let cfg = "/c/.codex/config.toml";
    // The user's own SessionStart hook comes first, so ours is 1:0; their
    // hook gets no verdict. A Stop of ours with an extra field is skipped,
    // since its hash would cover that field.
    let src = format!(
        "[[hooks.SessionStart]]\n\n[[hooks.SessionStart.hooks]]\ntype = \"command\"\ncommand = 'mine.sh'\n\n\
             [[hooks.SessionStart]]\nmatcher = \"startup|resume|clear|compact\"\n\n\
             [[hooks.SessionStart.hooks]]\ntype = \"command\"\ncommand = '{cmd}'\ntimeout = 10\n\n\
             [[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = '{cmd}'\ntimeout = 10\nstatusMessage = \"x\"\n"
    );
    let out = trust_codex_hooks_in(&src, &[cfg.to_string()], cmd).unwrap();
    assert!(out.contains(&format!("[hooks.state.\"{cfg}:session_start:1:0\"]\ntrusted_hash = \"{}\"", LIVE_HASHES[0].1)));
    assert!(!out.contains(":session_start:0:0") && !out.contains(":stop:"), "{out}");
    assert_eq!(trust_codex_hooks_in("model = \"o3\"\n", &[cfg.to_string()], cmd), None);
}

#[test]
fn codex_hook_state_tolerates_a_config_path_spelled_differently() {
    // Codex builds the key from the path *it* resolved (symlinked CODEX_HOME,
    // macOS `/private` prefix …), so we fall back to matching our position.
    let src = format!(
        "{}\n[hooks.state.\"/private{CFG}:session_start:0:0\"]\nenabled = false\n",
        our_hook()
    );
    assert_eq!(
        codex_hook_state_in(&src, CFG, CMD),
        CodexHookState::Disabled
    );
}

#[test]
fn write_live_session_round_trips_and_refuses_junk_keys() {
    let tmp = unique_tmp(concat!(crate::app_slug!(), "-live-write"));
    let uid = "11111111-2222-3333-4444-555555555555";
    let id = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";

    write_live_session_in(&tmp, uid, id).unwrap();
    assert_eq!(read_live_session_in(&tmp, uid).as_deref(), Some(id));

    // The uid becomes a filename, so a traversal key must never be written.
    assert!(write_live_session_in(&tmp, "../../etc/passwd", id).is_err());
    assert!(write_live_session_in(&tmp, uid, "not a uuid!").is_err());
    // …and the good value survives the refused writes.
    assert_eq!(read_live_session_in(&tmp, uid).as_deref(), Some(id));

    let _ = std::fs::remove_dir_all(&tmp);
}

/// A project's slice is the agent's to write: links it plants at the
/// record, the old fixed temporary or the source record are replaced, and
/// the user's file they point at keeps its bytes.
#[cfg(unix)]
#[test]
fn live_records_replace_a_planted_link_and_never_write_through_it() {
    let dir = tempfile::tempdir().unwrap();
    let slice = dir.path().join("slice");
    std::fs::create_dir_all(&slice).unwrap();
    let users = dir.path().join("bashrc");
    std::fs::write(&users, "keep").unwrap();
    let uid = "11111111-2222-3333-4444-555555555555";
    let id = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";
    for name in [uid.to_string(), format!(".{uid}.tmp"), format!("{uid}{LIVE_SOURCE_SUFFIX}")] {
        std::os::unix::fs::symlink(&users, slice.join(name)).unwrap();
    }
    restore_cleared_in(&slice, uid, id).unwrap();
    assert_eq!(std::fs::read_to_string(&users).unwrap(), "keep");
    assert_eq!(read_live_session_in(&slice, uid).as_deref(), Some(id));
    assert_eq!(std::fs::read_to_string(slice.join(format!("{uid}{LIVE_SOURCE_SUFFIX}"))).unwrap(), "resume");
}

#[test]
fn resolve_codex_session_reads_a_binder_written_record() {
    // The seam the hook-free fallback relies on: whatever `codex_bind` writes
    // with `write_live_session_in` must come back out of the *unchanged*
    // resolve path as `codex resume <id>`.
    let live = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";
    let uid = "11111111-2222-3333-4444-555555555555";
    let root = codex_sessions_with(live);
    let live_dir = unique_tmp(concat!(crate::app_slug!(), "-live-seam"));

    write_live_session_in(&live_dir, uid, live).unwrap();

    let mut opts = codex_opts();
    opts.env
        .insert(crate::app_env!("TAB_UID").to_string(), uid.to_string());
    let out =
        resolve_codex_session_impl(opts, &root, &[], |u| read_live_session_in(&live_dir, u));
    assert_eq!(out.args, vec!["resume".to_string(), live.to_string()]);

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&live_dir);
}

// ── permission-mode resume ──────────────────────────────────────────────

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn resolve_reapplies_recorded_permission_mode_on_resume() {
    let uuid = "00000000-0000-0000-0000-000000000000";
    let projects = projects_with_sessions(&[uuid]);
    let out = resolve_claude_session_impl(
        opts_with_args(&["--session-id", uuid]),
        &projects,
        |_| None,
        |_| Some("acceptEdits".to_string()),
    );
    assert_eq!(
        out.args,
        strs(&["--resume", uuid, "--permission-mode", "acceptEdits"])
    );
    let _ = std::fs::remove_dir_all(&projects);
}

#[test]
fn resolve_never_applies_a_mode_record_to_a_fresh_session() {
    // No session log → fresh `--session-id` launch; a leftover mode record
    // must not steer a conversation that does not exist yet.
    let uuid = "00000000-0000-0000-0000-000000000000";
    let projects = projects_with_sessions(&[]);
    let out = resolve_claude_session_impl(
        opts_with_args(&["--session-id", uuid]),
        &projects,
        |_| None,
        |_| Some("plan".to_string()),
    );
    assert_eq!(out.args, strs(&["--session-id", uuid]));
    let _ = std::fs::remove_dir_all(&projects);
}

#[test]
fn resolve_lets_an_explicit_mode_flag_outrank_the_record() {
    // A custom agent whose argv already names `--permission-mode` keeps it;
    // the hook record must neither override it nor stack a second pair behind
    // it.
    let uuid = "00000000-0000-0000-0000-000000000000";
    let projects = projects_with_sessions(&[uuid]);
    let out = resolve_claude_session_impl(
        opts_with_args(&["--session-id", uuid, "--permission-mode", "plan"]),
        &projects,
        |_| None,
        |_| Some("acceptEdits".to_string()),
    );
    assert_eq!(out.args, strs(&["--resume", uuid, "--permission-mode", "plan"]));
    let _ = std::fs::remove_dir_all(&projects);
}

#[test]
fn resolve_discards_junk_mode_records() {
    // The record is hook-parsed JSON becoming a CLI argument: only the known
    // mode set may pass.
    let uuid = "00000000-0000-0000-0000-000000000000";
    let projects = projects_with_sessions(&[uuid]);
    let out = resolve_claude_session_impl(
        opts_with_args(&["--session-id", uuid]),
        &projects,
        |_| None,
        |_| Some("acceptEdits; rm -rf /".to_string()),
    );
    assert_eq!(out.args, strs(&["--resume", uuid]));
    let _ = std::fs::remove_dir_all(&projects);
}

#[test]
fn mode_records_round_trip_and_reject_junk() {
    let tmp = unique_tmp(concat!(crate::app_slug!(), "-mode"));
    std::fs::create_dir_all(&tmp).unwrap();
    let uid = "11111111-2222-3333-4444-555555555555";
    std::fs::write(tmp.join(format!("{uid}.mode")), "acceptEdits\n").unwrap();
    assert_eq!(read_live_mode_in(&tmp, uid).as_deref(), Some("acceptEdits"));
    // unknown values and traversal keys are refused
    std::fs::write(tmp.join(format!("{uid}.mode")), "yolo").unwrap();
    assert_eq!(read_live_mode_in(&tmp, uid), None);
    assert_eq!(read_live_mode_in(&tmp, "../etc/passwd"), None);
    assert!(is_permission_mode("plan") && is_permission_mode("bypassPermissions"));
    // "manual" is a CLI-only alias — hooks report it as "default".
    assert!(!is_permission_mode("manual") && !is_permission_mode(""));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn the_model_tag_is_the_last_real_answer_in_the_transcript_tail() {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("s.jsonl");
    std::fs::write(
        &claude,
        concat!(
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-1-20250805\",\"role\":\"assistant\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-5-20250929\",\"role\":\"assistant\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"<synthetic>\",\"role\":\"assistant\"}}\n",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"more\"}}\n",
        ),
    )
    .unwrap();
    assert_eq!(
        last_model_in_transcript(&claude, TranscriptKind::Claude).as_deref(),
        Some("claude-sonnet-4-5-20250929")
    );
    // A Codex rollout names the model in its turn context, not its answers.
    let codex = dir.path().join("rollout.jsonl");
    std::fs::write(
        &codex,
        concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"x\"}}\n",
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\"}}\n",
        ),
    )
    .unwrap();
    assert_eq!(
        last_model_in_transcript(&codex, TranscriptKind::Codex).as_deref(),
        Some("gpt-5-codex")
    );
    // No answer yet, or a dialect mismatch, is no tag — never a guess.
    assert_eq!(last_model_in_transcript(&codex, TranscriptKind::Claude), None);
    std::fs::write(&claude, "{\"type\":\"user\"}\n").unwrap();
    assert_eq!(last_model_in_transcript(&claude, TranscriptKind::Claude), None);
    assert_eq!(last_model_in_transcript(&dir.path().join("missing.jsonl"), TranscriptKind::Claude), None);
}

#[test]
fn a_model_switch_in_the_session_retags_before_the_next_answer() {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("s.jsonl");
    let switch = |text: &str| {
        serde_json::json!({"type": "user", "message": {"role": "user", "content": text}}).to_string()
    };
    let answer = "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5\",\"role\":\"assistant\"}}";
    let write = |lines: &[String]| std::fs::write(&claude, lines.join("\n") + "\n").unwrap();
    let read = || last_model_in_transcript(&claude, TranscriptKind::Claude);

    write(&[answer.into(), switch("<local-command-stdout>Set model to `Fable 5.1` and saved as your default for new sessions</local-command-stdout>")]);
    assert_eq!(read().as_deref(), Some("fable-5-1"));
    // Older releases bold the name with ANSI instead of backticks.
    write(&[answer.into(), switch("<local-command-stdout>Set model to \u{1b}[1mSonnet 4.5\u{1b}[22m and saved as your default for new sessions</local-command-stdout>")]);
    assert_eq!(read().as_deref(), Some("sonnet-4-5"));
    // Annotations are not part of the model.
    write(&[answer.into(), switch("<local-command-stdout>Set model to `Opus 5 (1M context) (default)` and saved as your default</local-command-stdout>")]);
    assert_eq!(read().as_deref(), Some("opus-5"));
    write(&[answer.into(), switch("<local-command-stdout>Kept model as `Fable 5`</local-command-stdout>")]);
    assert_eq!(read().as_deref(), Some("fable-5"));
    // A later answer wins again; a quoted mention in a prompt is not a switch.
    write(&[switch("<local-command-stdout>Set model to `Fable 5` and saved</local-command-stdout>"), answer.into()]);
    assert_eq!(read().as_deref(), Some("claude-opus-5"));
    write(&[answer.into(), switch("why does it say Set model to `Fable 5`?")]);
    assert_eq!(read().as_deref(), Some("claude-opus-5"));
    // A name that folds to nothing useful leaves the last answer standing.
    write(&[answer.into(), switch("<local-command-stdout>Set model to Default</local-command-stdout>")]);
    assert_eq!(read().as_deref(), Some("claude-opus-5"));
    // Current releases write the confirmation as a `local_command` system record.
    let system = serde_json::json!({"type": "system", "subtype": "local_command", "content": "<local-command-stdout>Kept model as `Sonnet 5.5`</local-command-stdout>"}).to_string();
    write(&[answer.into(), system]);
    assert_eq!(read().as_deref(), Some("sonnet-5-5"));
}

#[test]
fn recent_prompts_carry_their_times_and_take_in_mid_turn_messages() {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("s.jsonl");
    std::fs::write(
        &claude,
        concat!(
            "{\"type\":\"user\",\"timestamp\":\"2026-09-15T08:20:44.127Z\",\"message\":{\"role\":\"user\",\"content\":\"add an edge option\"}}\n",
            "{\"type\":\"assistant\",\"timestamp\":\"2026-09-15T08:20:50.000Z\",\"message\":{\"model\":\"claude-opus-5\"}}\n",
            // Sent while the agent worked: an attachment, never a user record.
            "{\"type\":\"attachment\",\"timestamp\":\"2026-09-15T08:21:48.991Z\",\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"zoom to 5 min\",\"commandMode\":\"prompt\",\"origin\":{\"kind\":\"human\"}}}\n",
            // Queued by something that is not the user, or not a prompt.
            "{\"type\":\"attachment\",\"timestamp\":\"2026-09-15T08:22:00.000Z\",\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"task done\",\"commandMode\":\"prompt\",\"origin\":{\"kind\":\"task\"}}}\n",
            "{\"type\":\"attachment\",\"timestamp\":\"2026-09-15T08:22:01.000Z\",\"attachment\":{\"type\":\"queued_command\",\"prompt\":\"git status\",\"commandMode\":\"bash\"}}\n",
            // No timestamp: it cannot be placed, so it is not offered.
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"when was this\"}}\n",
            "{\"type\":\"user\",\"timestamp\":\"2026-09-15T08:24:22.470Z\",\"message\":{\"role\":\"user\",\"content\":\"not live\"}}\n",
            "{\"type\":\"user\",\"timestamp\":\"2026-09-15T08:24:30.000Z\",\"message\":{\"role\":\"user\",\"content\":\"not live\"}}\n",
        ),
    )
    .unwrap();
    let prompts = recent_prompts_in_transcript(&claude, TranscriptKind::Claude).unwrap();
    let texts: Vec<&str> = prompts.iter().map(|p| p.text.as_str()).collect();
    assert_eq!(texts, ["add an edge option", "zoom to 5 min", "not live"]);
    assert_eq!(prompts[1].at, "2026-09-15T08:21:48.991Z");
    std::fs::write(&claude, "{\"type\":\"assistant\"}\n").unwrap();
    assert_eq!(recent_prompts_in_transcript(&claude, TranscriptKind::Claude), None);
}

#[test]
fn the_last_prompt_is_what_the_user_said_not_what_the_cli_told_itself() {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("s.jsonl");
    // A prompt, then everything Claude writes as a "user" turn that is not
    // one: a tool result, a meta caveat, a reminder, a captured stdout.
    std::fs::write(
        &claude,
        concat!(
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"fix the\\n  failing tests\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-1\",\"role\":\"assistant\"}}\n",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"t1\",\"type\":\"tool_result\",\"content\":\"ok\"}]}}\n",
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"pretend this is a prompt\"}}\n",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<system-reminder>\\nnot a prompt\\n</system-reminder>\"}}\n",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<local-command-stdout>Set model</local-command-stdout>\"}}\n",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"[Request interrupted by user for tool use]\"}]}}\n",
        ),
    )
    .unwrap();
    assert_eq!(
        last_prompt_in_transcript(&claude, TranscriptKind::Claude).as_deref(),
        Some("fix the failing tests")
    );
    // A slash command and a `!` line are the user's doing, and read as such.
    std::fs::write(
        &claude,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/model</command-name>\\n  <command-message>model</command-message>\\n  <command-args>opus</command-args>\"}}\n",
    )
    .unwrap();
    assert_eq!(
        last_prompt_in_transcript(&claude, TranscriptKind::Claude).as_deref(),
        Some("/model opus")
    );
    std::fs::write(
        &claude,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<bash-input> git status</bash-input>\"}}\n",
    )
    .unwrap();
    assert_eq!(
        last_prompt_in_transcript(&claude, TranscriptKind::Claude).as_deref(),
        Some("! git status")
    );
    // An image paste carries its words as text blocks beside the image,
    // and the reminder Claude attaches rides along as a block to skip.
    std::fs::write(
        &claude,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"source\":{}},{\"type\":\"text\",\"text\":\"what is this?\"},{\"type\":\"text\",\"text\":\"<system-reminder>x</system-reminder>\"}]}}\n",
    )
    .unwrap();
    assert_eq!(
        last_prompt_in_transcript(&claude, TranscriptKind::Claude).as_deref(),
        Some("what is this?")
    );
    // Codex: the typed message event, and the model-facing copy without
    // the context Codex injects around it.
    let codex = dir.path().join("rollout.jsonl");
    std::fs::write(
        &codex,
        concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>cwd</environment_context>\"}]}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"add a test\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n",
        ),
    )
    .unwrap();
    assert_eq!(
        last_prompt_in_transcript(&codex, TranscriptKind::Codex).as_deref(),
        Some("add a test")
    );
    std::fs::write(
        &codex,
        concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"rename it\"}]}}\n",
        ),
    )
    .unwrap();
    assert_eq!(
        last_prompt_in_transcript(&codex, TranscriptKind::Codex).as_deref(),
        Some("rename it")
    );
    // A dialect mismatch, or no prompt at all, is no answer — never a guess.
    assert_eq!(last_prompt_in_transcript(&codex, TranscriptKind::Claude), None);
    assert_eq!(last_prompt_in_transcript(&dir.path().join("missing.jsonl"), TranscriptKind::Codex), None);
    // The shown text is one bounded printable line.
    assert_eq!(clean_prompt_text("  a\n\n b\tc \u{1b}[0m "), Some("a b c [0m".to_string()));
    assert_eq!(clean_prompt_text(" \n "), None);
    let long = clean_prompt_text(&"p".repeat(MAX_PROMPT_CHARS + 50)).unwrap();
    assert_eq!(long.chars().count(), MAX_PROMPT_CHARS + 1);
    assert!(long.ends_with('…'));
}

#[test]
fn a_claude_goal_runs_from_its_sentinel_until_met_failed_or_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    let set = r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"fix it"}}"#;
    let typed = r#"{"type":"user","message":{"role":"user","content":"<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>fix it</command-args>"}}"#;
    let answer = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"On it."}]}}"#;
    let unmet = r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"reason":"not yet"}}"#;
    let met = r#"{"type":"attachment","attachment":{"type":"goal_status","met":true,"condition":"fix it"}}"#;
    let failed = r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"failed":true,"iterations":4}}"#;
    let cleared = r#"{"type":"user","message":{"role":"user","content":"<command-name>/goal</command-name>\n<command-args>clear</command-args>"}}"#;
    let sidechain = r#"{"type":"attachment","isSidechain":true,"attachment":{"type":"goal_status","met":false,"sentinel":true}}"#;
    let read = |lines: &[&str]| {
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        claude_goal_in_transcript(&path)
    };
    assert_eq!(read(&[answer]), None);
    assert_eq!(read(&[set, typed, answer]), Some(true));
    assert_eq!(read(&[set, typed, answer, unmet, answer]), Some(true));
    assert_eq!(read(&[set, typed, answer, met, answer]), Some(false));
    assert_eq!(read(&[set, typed, answer, failed]), Some(false));
    assert_eq!(read(&[set, typed, answer, cleared]), Some(false));
    assert_eq!(read(&[met, sidechain]), Some(false));
    // Current releases record the typed command as a `local_command` system record.
    let cleared = r#"{"type":"system","subtype":"local_command","content":"<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>clear</command-args>"}"#;
    assert_eq!(read(&[set, typed, answer, cleared]), Some(false));
}

#[test]
fn markup_the_user_pasted_stays_their_prompt() {
    // Bounded by shape alone, the block test ate all of these — silently,
    // with no marker, from the bubble and the last-prompt line both.
    let html = "fix this:\n<div>\n  <span>x</span>\n</div>";
    assert_eq!(claude_prompt_text(html).as_deref(), Some(html));
    let xml = "review this xml:\n<config>\n  <name>x</name>\n</config>";
    assert_eq!(claude_prompt_text(xml).as_deref(), Some(xml));
    assert_eq!(
        claude_prompt_text("compare <a>one</a> and <a>two</a>").as_deref(),
        Some("compare <a>one</a> and <a>two</a>")
    );
    // Wholly one element, and still the user's.
    assert_eq!(claude_prompt_text("<div>hello</div>").as_deref(), Some("<div>hello</div>"));
    assert_eq!(claude_prompt_text("<p>a paragraph</p>").as_deref(), Some("<p>a paragraph</p>"));
    // An attribute never was the thing that saved it.
    assert_eq!(
        claude_prompt_text("<div class=\"x\">hello</div>").as_deref(),
        Some("<div class=\"x\">hello</div>")
    );
    // The CLI's own tags are still refused, and still stripped off a tail.
    assert_eq!(claude_prompt_text("<system-reminder>x</system-reminder>"), None);
    assert_eq!(
        claude_prompt_text("ship it\n<system-reminder>x</system-reminder>").as_deref(),
        Some("ship it")
    );
}

#[test]
fn a_compact_summary_is_never_a_prompt() {
    let summary: serde_json::Value = serde_json::from_str(concat!(
        "{\"type\":\"user\",\"isCompactSummary\":true,\"message\":{\"role\":\"user\",",
        "\"content\":\"This session is being continued from a previous conversation.\"}}",
    ))
    .unwrap();
    assert_eq!(claude_prompt_in_record(&summary), None);
    let transcript_only: serde_json::Value = serde_json::from_str(concat!(
        "{\"type\":\"user\",\"isVisibleInTranscriptOnly\":true,\"message\":{\"role\":\"user\",",
        "\"content\":\"a note the CLI left itself\"}}",
    ))
    .unwrap();
    assert_eq!(claude_prompt_in_record(&transcript_only), None);
}

#[test]
fn a_block_the_cli_wrote_to_itself_is_never_a_prompt() {
    // Read by shape, not off a list: none of these tags was ever on the
    // prefix list, and each one reached the phone inside a bubble.
    assert_eq!(claude_prompt_text("<tool_use_error>File has not been read yet</tool_use_error>"), None);
    assert_eq!(claude_prompt_text("<total_tokens>128000</total_tokens>"), None);
    assert_eq!(claude_prompt_text("<user-prompt-submit-hook>blocked</user-prompt-submit-hook>"), None);
    assert_eq!(claude_prompt_text("<bash-stderr>fatal: not a repo</bash-stderr>"), None);
    assert_eq!(claude_prompt_text("  <local-command-stderr>oops</local-command-stderr>  "), None);
    // A reminder appended behind the words the user typed is cut off them.
    assert_eq!(
        claude_prompt_text("fix the tests\n<system-reminder>be careful</system-reminder>").as_deref(),
        Some("fix the tests")
    );
    // Angle brackets somebody typed stay theirs.
    assert_eq!(claude_prompt_text("<Vec<T>> or a slice?").as_deref(), Some("<Vec<T>> or a slice?"));
    assert_eq!(claude_prompt_text("what does <T> mean here?").as_deref(), Some("what does <T> mean here?"));
    // The two tags that are the user's doing are still read first.
    assert_eq!(claude_prompt_text("<command-name>/clear</command-name>").as_deref(), Some("/clear"));
    // A paste rides in its own block; the card shows it as the CLI does.
    assert_eq!(
        claude_prompt_text("\n\n<pasted_content id=\"d95e\">\nline one\nline two\n</pasted_content id=\"d95e\">\n\n implement it")
            .as_deref(),
        Some("[Pasted text #1 +2 lines]\n\n implement it")
    );
    assert_eq!(
        claude_prompt_text("a <pasted_content id=\"1\">x</pasted_content id=\"1\"> b <pasted_content id=\"2\">y\nz</pasted_content id=\"2\">")
            .as_deref(),
        Some("a [Pasted text #1 +1 lines] b [Pasted text #2 +2 lines]")
    );
    // Unclosed, or closed under another id: the user's text, untouched.
    assert_eq!(
        claude_prompt_text("see <pasted_content id=\"1\">x").as_deref(),
        Some("see <pasted_content id=\"1\">x")
    );
    assert_eq!(claude_prompt_text("<bash-input>git status</bash-input>").as_deref(), Some("! git status"));

    // Codex injects its instructions as blocks beside the typed words.
    let injected: serde_json::Value = serde_json::from_str(concat!(
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[",
        "{\"type\":\"input_text\",\"text\":\"<user_instructions>be brief</user_instructions>\"},",
        "{\"type\":\"input_text\",\"text\":\"rename it\"}]}}",
    ))
    .unwrap();
    assert_eq!(codex_prompt_in_record(&injected).as_deref(), Some("rename it"));
}

#[test]
fn a_prompt_behind_a_megabyte_of_tool_output_is_still_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollout.jsonl");
    // Codex 0.155's shape: the prompt, then a turn of tool results each
    // written twice, far past the model's window.
    let prompt = r#"{"timestamp":"2026-09-19T17:25:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant_x","content":[]}}
{"timestamp":"2026-09-19T17:25:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Implement these"}]}}
"#;
    let output = "o".repeat(40 * 1024);
    let mut body = prompt.to_string();
    for _ in 0..40 {
        body.push_str(&format!(
            "{{\"type\":\"response_item\",\"payload\":{{\"type\":\"custom_tool_call_output\",\"output\":\"{output}\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"item_completed\",\"output\":\"{output}\"}}}}\n"
        ));
    }
    std::fs::write(&path, body).unwrap();
    assert!(std::fs::metadata(&path).unwrap().len() > 3 * MODEL_TAIL_BYTES);
    assert_eq!(last_prompt_in_transcript(&path, TranscriptKind::Codex).as_deref(), Some("Implement these"));
    let recent = recent_prompts_in_transcript(&path, TranscriptKind::Codex).unwrap();
    assert_eq!(recent.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), ["Implement these"]);
}

#[test]
fn a_conversation_tail_counts_and_keeps_no_request_replay_record() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.jsonl");
    let read = |budget: u64| {
        let mut file = std::fs::File::open(&path).unwrap();
        let len = file.metadata().unwrap().len();
        read_conversation_tail(&mut file, len, budget).unwrap()
    };

    // Without replay records it is the plain byte window, across chunks.
    let line = format!("{{\"type\":\"user\",\"n\":\"{}\"}}\n", "u".repeat(1000));
    std::fs::write(&path, line.repeat(3000)).unwrap();
    let len = std::fs::metadata(&path).unwrap().len();
    for budget in [10, line.len() as u64, 5 * SCAN_CHUNK / 2, len - 1, len, len + 9] {
        let (text, cut) = read(budget);
        let mut plain = std::fs::read_to_string(&path).unwrap();
        let start = len.saturating_sub(budget) as usize;
        plain.drain(..start);
        if start > 0 {
            plain.drain(..=plain.find('\n').unwrap());
        }
        assert_eq!((text.len(), cut), (plain.len(), start > 0), "budget {budget}");
    }

    // Replay records are skipped, even one split over a chunk boundary:
    // two prompts with three times their size of replay between and after
    // them both fit a window of the two.
    let line = format!("{{\"type\":\"user\",\"n\":\"{}\"}}\n", "u".repeat(400_000));
    let replay = format!("{{\"type\":\"api-request\",\"body\":\"{}\"}}\n", "r".repeat(SCAN_CHUNK as usize / 3));
    std::fs::write(&path, format!("{line}{}{line}{}", replay.repeat(3), replay.repeat(3))).unwrap();
    assert_eq!(read(2 * line.len() as u64), (line.repeat(2), false));
    assert_eq!(read(line.len() as u64 + 5), (line.clone(), true));
    // Past the scan's reach the window is cut where the reach ends.
    assert_eq!(read(1024), (String::new(), true));
}

#[test]
fn the_model_tag_skips_the_line_the_tail_cut_and_refuses_unprintable_names() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.jsonl");
    // One answer far past the tail window, then a line the window cuts in
    // half, then an ordinary user turn: the cut line would parse as garbage
    // and must not be mistaken for a record.
    let filler = "x".repeat(MODEL_TAIL_BYTES as usize + 100);
    let body = format!(
        "{{\"type\":\"assistant\",\"message\":{{\"model\":\"claude-opus-4-1-20250805\"}}}}\n{{\"type\":\"user\",\"message\":{{\"content\":\"{filler}\"}}}}\n{{\"type\":\"user\"}}\n"
    );
    std::fs::write(&path, body).unwrap();
    assert_eq!(last_model_in_transcript(&path, TranscriptKind::Claude), None);
    assert_eq!(clean_model_name("  claude-opus-4-1  ").as_deref(), Some("claude-opus-4-1"));
    assert_eq!(clean_model_name("<synthetic>"), None);
    assert_eq!(clean_model_name("evil\u{1b}]0;x\u{7}"), None);
    assert_eq!(clean_model_name("two words"), None);
    assert_eq!(clean_model_name(&"m".repeat(MAX_MODEL_NAME + 1)), None);
}

/// Gap 29: every record the host reads from the live-session slice, Vibe's
/// session metadata and a transcript are agent-writable. A planted FIFO
/// reads as nothing without blocking (a regression fails on the deadline
/// instead of hanging), so does a link or an oversized record, and a
/// normal record still reads.
#[cfg(unix)]
#[test]
fn planted_fifos_links_and_oversized_records_read_as_nothing() {
    use crate::services::home_io::{mkfifo, within_deadline, RECORD_CAP};
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("live");
    std::fs::create_dir_all(&dir).unwrap();
    let uid = "0a1b2c3d-0000-4000-8000-00000000abcd";
    let prev = "0a1b2c3d-1111-4000-8000-00000000abcd";
    let id_rec = dir.join(uid);
    let src = dir.join(format!("{uid}{LIVE_SOURCE_SUFFIX}"));
    let mode = dir.join(format!("{uid}.mode"));
    let cleared = dir.join(format!("{uid}{LIVE_CLEARED_SUFFIX}"));
    let write_all = || {
        std::fs::write(&id_rec, format!("{uid}\n")).unwrap();
        std::fs::write(&src, "clear\n").unwrap();
        std::fs::write(&mode, "plan\n").unwrap();
        std::fs::write(&cleared, format!("{prev}\n")).unwrap();
    };
    write_all();
    assert_eq!(read_live_session_in(&dir, uid).as_deref(), Some(uid));
    assert_eq!(read_live_source_in(&dir, uid).as_deref(), Some("clear"));
    assert_eq!(read_live_mode_in(&dir, uid).as_deref(), Some("plan"));
    assert_eq!(cleared_session_in(&dir, uid, |_| true).as_deref(), Some(prev));

    // One FIFO at a time, the others valid, so each reader reaches its own file.
    for fifo in [&id_rec, &src, &mode, &cleared] {
        write_all();
        std::fs::remove_file(fifo).unwrap();
        mkfifo(fifo);
        let at = dir.clone();
        let got = within_deadline(move || {
            (
                read_live_session_in(&at, uid),
                read_live_source_in(&at, uid),
                read_live_mode_in(&at, uid),
                cleared_session_in(&at, uid, |_| true),
            )
        });
        let want = |hit: bool, ok: Option<&str>| if hit { None } else { ok.map(str::to_string) };
        assert_eq!(got.0, want(fifo == &id_rec, Some(uid)), "{}", fifo.display());
        assert_eq!(got.1, want(fifo == &src, Some("clear")), "{}", fifo.display());
        assert_eq!(got.2, want(fifo == &mode, Some("plan")), "{}", fifo.display());
        let undo = fifo == &mode;
        assert_eq!(got.3, want(!undo, Some(prev)), "{}", fifo.display());
        // Writing the next round's records must not open this FIFO.
        std::fs::remove_file(fifo).unwrap();
    }

    // A link to a valid record elsewhere is not followed.
    let outside = tmp.path().join("outside");
    std::fs::write(&outside, format!("{uid}\n")).unwrap();
    write_all();
    std::fs::remove_file(&id_rec).unwrap();
    std::os::unix::fs::symlink(&outside, &id_rec).unwrap();
    assert_eq!(read_live_session_in(&dir, uid), None);

    // An oversized record is refused even where its trimmed text is valid.
    let mut huge = format!("{uid}\n").into_bytes();
    huge.resize(RECORD_CAP as usize + 1, b' ');
    std::fs::remove_file(&id_rec).unwrap();
    std::fs::write(&id_rec, &huge).unwrap();
    assert_eq!(read_live_session_in(&dir, uid), None);
    std::fs::write(&id_rec, &huge[..RECORD_CAP as usize]).unwrap();
    assert_eq!(read_live_session_in(&dir, uid).as_deref(), Some(uid));

    // Vibe's `meta.json`.
    let home = tmp.path().join("vibe");
    let session = home.join("logs/session/session_1");
    std::fs::create_dir_all(&session).unwrap();
    std::fs::write(session.join("meta.json"), format!(r#"{{"session_id":"{uid}"}}"#)).unwrap();
    assert!(vibe_session_exists(&home, uid));
    std::fs::remove_file(session.join("meta.json")).unwrap();
    mkfifo(&session.join("meta.json"));
    let at = home.clone();
    assert!(!within_deadline(move || vibe_session_exists(&at, uid)));

    // A transcript tail.
    let transcript = tmp.path().join("t.jsonl");
    std::fs::write(&transcript, "{\"a\":1}\n").unwrap();
    assert_eq!(with_transcript_tail(&transcript, 1024, |lines| Some(lines.len())), Some(1));
    std::fs::remove_file(&transcript).unwrap();
    mkfifo(&transcript);
    assert_eq!(within_deadline(move || with_transcript_tail(&transcript, 1024, |lines| Some(lines.len()))), None);

    // Codex's config in an agent home, read for the hook check.
    let agent_home = tmp.path().join("agent");
    std::fs::create_dir_all(agent_home.join(".codex")).unwrap();
    mkfifo(&agent_home.join(".codex/config.toml"));
    within_deadline(move || codex_hook_state_of_home(&agent_home));
}
