use super::*;
use std::collections::HashMap;

/// Gap 18: the spawn path stamps the fence scope onto the tab's push
/// identity once the fence wrapped it; nothing else takes one.
#[test]
fn only_a_pusher_binding_takes_a_fence_scope() {
    let store = TokenStore::default();
    let identity = |caller, push| Identity { tab: "stamp:a".into(), caller, project: Some("p".into()), schedule_target: None, push, endpoint: None, model: None };
    let pusher = mint_token().unwrap();
    store.register(pusher.clone(), identity(Caller::Pusher, Some(PushBinding { dir: "/p".into(), fence_scope: None, git_at_spawn: None })), false);
    let helper = mint_token().unwrap();
    store.register(helper.clone(), identity(Caller::Helper, None), false);
    assert!(!store.stamp_push_fence_scope(&helper, "p"));
    assert!(!store.stamp_push_fence_scope("not-a-token", "p"));
    let before = store.authenticate(Some(&format!("Bearer {pusher}"))).unwrap();
    assert_eq!(before.identity.push.unwrap().fence_scope, None);
    assert!(store.stamp_push_fence_scope(&pusher, "p"));
    let after = store.authenticate(Some(&format!("Bearer {pusher}"))).unwrap();
    assert_eq!(after.identity.push.unwrap().fence_scope.as_deref(), Some("p"));
}

/// Gap 19: the push binding records the `.git` entry git discovery
/// finds at spawn — none for a repo-less folder — so a repo made later is
/// told apart (`git_push_mcp::repo_changed`).
#[test]
fn a_push_grant_records_the_git_dir_found_at_spawn() {
    let store = TokenStore::default();
    let root = tempfile::tempdir().unwrap();
    let (plain, repo) = (root.path().join("plain"), root.path().join("repo"));
    // What git discovery counts as a repo: `HEAD`, `objects`, `refs`.
    let make_git_dir = |dir: &std::path::Path| {
        for sub in ["objects", "refs"] { std::fs::create_dir_all(dir.join(".git").join(sub)).unwrap(); }
        std::fs::write(dir.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
    };
    make_git_dir(&repo);
    std::fs::create_dir(&plain).unwrap();
    let before = super::super::git_push_mcp::git_entry_identity(&plain);
    for (dir, want) in [(plain.clone(), before), (repo.clone(), super::super::git_push_mcp::git_entry_identity(&repo))] {
        let mut spawn = opts("claude", &[], Some("p"));
        spawn.id = format!("grant:{}", dir.display());
        grant_git_push(&mut spawn, &rt(), &store, dir.clone(), &[]);
        let token = spawn.env.get(GIT_TOKEN_ENV).cloned().expect("a claude tab gets the push token");
        let binding = store.authenticate(Some(&format!("Bearer {token}"))).unwrap().identity.push.unwrap();
        assert_eq!((binding.dir, binding.git_at_spawn), (dir, want));
    }
    assert!(super::super::git_push_mcp::git_entry_identity(&repo).is_some());
    make_git_dir(&plain);
    assert_ne!(super::super::git_push_mcp::git_entry_identity(&plain), before, "a .git made later is another entry");
}

#[test]
fn narrowing_invalidates_already_authenticated_requests() {
    let (token, old) = test_session(Caller::Agent);
    let mut access = old.access.clone(); access.write = false;
    set_access(&old.id, access).unwrap();
    assert!(old.check().is_err());
    let current = authenticate(Some(&format!("Bearer {token}"))).unwrap();
    assert!(current.check().is_ok());
    assert!(!current.access.allows(Caller::Agent, "todo_delete"));
    revoke_session(&current.id).unwrap();
    assert!(current.check().is_err());
}

#[test]
fn rpc_types_and_scope_filters_cannot_be_bypassed() {
    let f = Fixture::new();
    let mut stores = f.stores();
    stores.access.projects = security::Scope { all: false, ids: vec!["p1".into()] };
    let list = projects_list(&stores).unwrap();
    assert_eq!(list["projects"].as_array().unwrap().len(), 1);
    assert!(resolve_project(&stores, "p2").is_err());
    assert!(resolve_project(&stores, "Beta").is_err());
    for message in [json!({"method":"ping", "id":1}), json!({"jsonrpc":"2.0","method":"ping","id":[]})] {
        assert_eq!(handle_message(&stores, "t", &message).0.unwrap()["error"]["code"], -32600);
    }
    for args in [json!([]), json!({"title":"test","start":7}), json!({"title":"test","start":"2026-09-20","unexpected":true})] {
        let message = json!({"jsonrpc":"2.0","id":1,"method":"tools/call", "params":{"name":"calendar_add_event","arguments":args}});
        let (reply, effects) = handle_message(&stores, "t", &message);
        assert_eq!(reply.unwrap()["result"]["isError"], true);
        assert!(effects.changes.is_empty());
        assert!(!f.calendar.exists());
    }
}

#[test]
fn policy_change_refuses_a_queued_request() {
    let f = Fixture::new();
    let (_, session) = test_session(Caller::Agent);
    let stores = Stores { session: Some(&session), ..f.stores() };
    assert!(stores.check().is_ok());
    f.write_state("settings.json", json!({"root_mcp":false}));
    assert!(stores.check().is_err());
    revoke_tab(&session.identity.tab);
}

fn opts(cmd: &str, args: &[&str], project_id: Option<&str>) -> PtyOptions {
    PtyOptions {
        login: None,
        assistant: None,
        cmd: cmd.to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        project_id: project_id.map(str::to_string),
        env: HashMap::new(),
        id: "root:t".to_string(),
        cwd: String::new(),
        cols: 80,
        rows: 24,
        local_only: false,
        sandbox: false,
        agent: true,
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
fn schedule_wiring_is_disjoint_scoped_and_secret_free() {
    let runtime = Runtime { port: 8765, serves_root: true, serves_markup: true, serves_web: false };
    for cli in WIRED_CLIS {
        let mut spawn = opts(cli, &[], Some("p"));
        apply_schedule_to_spawn_with(&mut spawn, &runtime, "secret", &[]);
        assert!(!spawn.env.contains_key(SCHEDULE_TOKEN_ENV), "missing target");
        spawn.schedule_target_id = Some("t".into());
        spawn.sandbox = true;
        apply_schedule_to_spawn_with(&mut spawn, &runtime, "secret", &[]);
        assert!(!spawn.env.contains_key(SCHEDULE_TOKEN_ENV), "container");
        spawn.sandbox = false;
        apply_schedule_to_spawn_with(&mut spawn, &runtime, "secret", &[]);
        assert_eq!(spawn.env[SCHEDULE_TOKEN_ENV], "secret");
        assert!(!spawn.env.contains_key(TOKEN_ENV));
        assert!(spawn.args.join(" ").contains(concat!(crate::app_slug!(), "-schedule")));
        assert!(!spawn.args.join(" ").contains("secret"));
    }
    let mut root = opts("claude", &[], None);
    root.schedule_target_id = Some("t".into());
    apply_schedule_to_spawn_with(&mut root, &runtime, "secret", &[]);
    assert!(root.env.is_empty());
}

fn rt() -> Runtime {
    Runtime { port: 4321, serves_root: true, serves_markup: true, serves_web: false }
}

/// One lane rule: a profile gets the web lane exactly when
/// `AssistantCli::uses_lane` says so, for every profile there is.
#[test]
fn the_assistant_grant_follows_the_profiles_own_lane_rule() {
    use super::super::assistant::{AssistantCli, AssistantLaunch};
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("settings.json"), json!({"assistant": true}).to_string()).unwrap();
    let serving = Runtime { port: 4321, serves_root: true, serves_markup: true, serves_web: true };
    for cli in AssistantCli::ALL {
        let mut spawn = opts(cli.bin(), &[], Some(crate::storage::ASSISTANT_SCOPE));
        spawn.assistant = Some(AssistantLaunch { cli, model: None });
        grant_assistant(&mut spawn, Some(&serving), &TokenStore::default(), dir.path());
        assert_eq!(spawn.env.contains_key(WEB_TOKEN_ENV), cli.uses_lane(), "{cli:?}");
    }
}

/// The assistant arm of [`grant_lanes`] (plan "Call sites" row 5): the web
/// lane's token and URL and the help lane's, and no other lane, whatever
/// the caller sent — and only while this process serves the lane and the
/// `assistant` flag is on; the web lane only for a profile that wants it
/// (Codex searches natively), the help lane only while `help_mcp` is on.
#[test]
fn an_assistant_spawn_gets_the_web_and_help_lanes_alone_and_only_when_everything_allows_it() {
    use super::super::assistant::{AssistantCli, AssistantLaunch};
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path();
    let settings = |value: Value| std::fs::write(state.join("settings.json"), value.to_string()).unwrap();
    // Every other lane's switch is on, to show none of them is granted.
    let on = json!({"assistant": true, "schedule_mcp": true, "help_mcp": true, "markup_mcp": true, "root_mcp": true, "root_mcp_agents": ["claude"], "root_mcp_mail": true});
    settings(on.clone());
    let chat = |cli: AssistantCli| {
        let mut spawn = opts(cli.bin(), &["--sent-by-the-renderer"], Some(crate::storage::ASSISTANT_SCOPE));
        spawn.assistant = Some(AssistantLaunch { cli, model: None });
        spawn.schedule_target_id = Some("target-1".into());
        spawn.env.insert("KEPT".into(), "1".into());
        spawn
    };
    let serving = Runtime { port: 4321, serves_root: true, serves_markup: true, serves_web: true };
    let lane_tokens = |spawn: &PtyOptions| {
        let mut keys: Vec<String> = spawn.env.keys().filter(|k| k.ends_with("_MCP_TOKEN") || k.ends_with("_MCP_URL")).cloned().collect();
        keys.sort();
        keys
    };
    for cli in [AssistantCli::Claude, AssistantCli::OpenCodeLocal, AssistantCli::ClaudeLocal] {
        let store = TokenStore::default();
        let mut spawn = chat(cli);
        assert!(!grant_lanes(&mut spawn, true, Some(&serving), &store, state), "never a root agent");
        let mut want = [WEB_TOKEN_ENV, WEB_URL_ENV, HELP_TOKEN_ENV, HELP_URL_ENV].map(str::to_string).to_vec();
        want.sort();
        assert_eq!(lane_tokens(&spawn), want, "{cli:?}");
        assert_eq!(spawn.env[WEB_URL_ENV], "http://127.0.0.1:4321/mcp/web");
        assert_eq!(spawn.env[HELP_URL_ENV], "http://127.0.0.1:4321/mcp/help");
        let help = store.authenticate(Some(&format!("Bearer {}", spawn.env[HELP_TOKEN_ENV]))).expect("registered");
        assert_eq!((help.identity.caller, help.identity.tab.as_str(), help.identity.project.as_deref()), (Caller::Helper, "root:t", None), "{cli:?}");
        assert_eq!(spawn.args, ["--sent-by-the-renderer"], "the grant never touches argv: launch_line owns it");
        assert_eq!(spawn.env["KEPT"], "1");
        let session = store.authenticate(Some(&format!("Bearer {}", spawn.env[WEB_TOKEN_ENV]))).expect("registered");
        assert_eq!((session.identity.caller, session.identity.tab.as_str(), session.identity.project.as_deref()), (Caller::Web, "root:t", None), "{cli:?}");
        assert!(session.identity.schedule_target.is_none() && session.identity.push.is_none());
        assert_eq!(session.access, Access::initial(Caller::Web));
    }
    // Codex: native search, no web lane, the help lane and no other.
    let store = TokenStore::default();
    let mut codex = chat(AssistantCli::Codex);
    assert!(!grant_lanes(&mut codex, true, Some(&serving), &store, state));
    assert_eq!(lane_tokens(&codex), [HELP_TOKEN_ENV, HELP_URL_ENV], "{:?}", codex.env.keys());
    // `help_mcp` off: the web lane alone, and Codex nothing.
    let mut help_off = on.clone();
    help_off["help_mcp"] = json!(false);
    settings(help_off);
    let mut spawn = chat(AssistantCli::Claude);
    grant_lanes(&mut spawn, true, Some(&serving), &store, state);
    assert_eq!(lane_tokens(&spawn), [WEB_TOKEN_ENV, WEB_URL_ENV]);
    let mut codex = chat(AssistantCli::Codex);
    grant_lanes(&mut codex, true, Some(&serving), &store, state);
    assert!(lane_tokens(&codex).is_empty(), "{:?}", codex.env.keys());
    settings(on.clone());
    // A runtime that does not serve the lane (a server daemon's), none at all.
    for runtime in [Some(Runtime { serves_web: false, ..serving.clone() }), None] {
        let mut spawn = chat(AssistantCli::Claude);
        grant_lanes(&mut spawn, true, runtime.as_ref(), &store, state);
        assert!(lane_tokens(&spawn).is_empty(), "{runtime:?}");
    }
    // The flag: off, an unreadable file. (Absent is on.)
    for body in [json!({"assistant": false, "schedule_mcp": true}), json!({"assistant": false, "debug": true, "schedule_mcp": true})] {
        settings(body);
        let mut spawn = chat(AssistantCli::Claude);
        grant_lanes(&mut spawn, true, Some(&serving), &store, state);
        assert!(lane_tokens(&spawn).is_empty());
    }
    std::fs::write(state.join("settings.json"), "{ nope").unwrap();
    let mut spawn = chat(AssistantCli::Claude);
    grant_lanes(&mut spawn, true, Some(&serving), &store, state);
    assert!(lane_tokens(&spawn).is_empty(), "unreadable settings grant nothing");
    // The token ends with the tab, and a respawn replaces it.
    settings(on);
    let mut first = chat(AssistantCli::Claude);
    grant_lanes(&mut first, true, Some(&serving), tokens(), state);
    let token = first.env[WEB_TOKEN_ENV].clone();
    assert!(authenticate(Some(&format!("Bearer {token}"))).is_some());
    let mut second = chat(AssistantCli::Claude);
    grant_lanes(&mut second, true, Some(&serving), tokens(), state);
    assert!(authenticate(Some(&format!("Bearer {token}"))).is_none(), "a respawn replaces the lane's session");
    assert!(revoke_tab("root:t"));
    assert!(authenticate(Some(&format!("Bearer {}", second.env[WEB_TOKEN_ENV]))).is_none(), "revoked with the tab");
    // Without the assistant block a spawn takes the ordinary arm: no web lane.
    let mut plain = opts("claude", &[], Some("p"));
    grant_lanes(&mut plain, true, Some(&serving), &store, state);
    assert!(!plain.env.contains_key(WEB_TOKEN_ENV));
}

/// Every agent CLI gets the help pair; Claude and Codex are also named the
/// server, beside a root or schedule server already wired, never twice and
/// never with the token in argv. A container tab gets nothing.
#[test]
fn help_wiring_joins_the_other_servers_and_stays_secret_free() {
    let runtime = rt();
    for cli in super::super::help_mcp::WIRED_CLIS {
        // A root tab: root server first, then help.
        let mut root = opts(cli, &[], None);
        apply_to_spawn_with(&mut root, &runtime, "roottok", &[cli.to_string()], &[], false);
        apply_help_to_spawn_with(&mut root, &runtime, "helptok", &[]);
        apply_help_to_spawn_with(&mut root, &runtime, "helptok", &[]);
        let argv = root.args.join(" ");
        assert!(argv.contains(concat!("\"", crate::app_slug!(), "\":")) || argv.contains(concat!("mcp_servers.", crate::app_slug!(), ".url")), "{argv}");
        assert!(argv.contains("http://127.0.0.1:4321/mcp/help"), "{argv}");
        assert_eq!(argv.matches("/mcp/help").count(), 1, "never twice: {argv}");
        assert!(!argv.contains("helptok") && !argv.contains("roottok"));
        assert_eq!(root.env[HELP_TOKEN_ENV], "helptok");
        assert_eq!(root.env[HELP_URL_ENV], "http://127.0.0.1:4321/mcp/help");
        // A project tab with a schedule server.
        let mut project = opts(cli, &[], Some("p"));
        project.schedule_target_id = Some("t".into());
        apply_schedule_to_spawn_with(&mut project, &runtime, "schedtok", &[]);
        apply_help_to_spawn_with(&mut project, &runtime, "helptok", &[]);
        let argv = project.args.join(" ");
        assert!(argv.contains(concat!(crate::app_slug!(), "-schedule")) && argv.contains(concat!(crate::app_slug!(), "-help")), "{argv}");
        // A container tab.
        let mut boxed = opts(cli, &[], Some("p"));
        boxed.sandbox = true;
        apply_help_to_spawn_with(&mut boxed, &runtime, "helptok", &[]);
        assert!(boxed.env.is_empty() && boxed.args.is_empty());
        assert!(!help_reaches(&boxed, &Trusted::read(Path::new("/nonexistent"), Some("p"))));
    }
    // Claude's `--mcp-config` stays one variadic flag holding both configs.
    let mut claude = opts("claude", &[], None);
    apply_to_spawn_with(&mut claude, &runtime, "roottok", &["claude".into()], &[], false);
    apply_help_to_spawn_with(&mut claude, &runtime, "helptok", &[]);
    assert_eq!(claude.args.iter().filter(|a| *a == "--mcp-config").count(), 1);
    assert_eq!(claude.args.len(), 3);
    // A sign-in tab (`claude auth login`) refuses `--mcp-config`.
    let mut login = opts("claude", &["auth", "login", "--claudeai"], Some("p"));
    login.schedule_target_id = Some("t".into());
    apply_to_spawn_with(&mut login, &runtime, "roottok", &["claude".into()], &[], false);
    apply_schedule_to_spawn_with(&mut login, &runtime, "schedtok", &[]);
    apply_help_to_spawn_with(&mut login, &runtime, "helptok", &[]);
    assert_eq!(login.args, ["auth", "login", "--claudeai"]);
    // An unwired CLI: the env pair only.
    let mut gemini = opts("gemini", &[], Some("p"));
    apply_help_to_spawn_with(&mut gemini, &runtime, "helptok", &[]);
    assert!(gemini.args.is_empty());
    assert_eq!(gemini.env[HELP_TOKEN_ENV], "helptok");
}

#[test]
fn help_merges_into_a_local_models_vibe_servers() {
    let tagged = vec!["gemma4:e4b".to_string()];
    let mut o = opts("vibe", &[], None);
    o.env.insert(crate::app_env!("LOCAL_MODEL").into(), "gemma4:e4b".into());
    apply_to_spawn_with(&mut o, &rt(), "roottok", &[], &tagged, false);
    apply_help_to_spawn_with(&mut o, &rt(), "helptok", &tagged);
    apply_help_to_spawn_with(&mut o, &rt(), "helptok", &tagged);
    let servers: Value = serde_json::from_str(&o.env["VIBE_MCP_SERVERS"]).unwrap();
    let names: Vec<_> = servers.as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, [crate::app_slug!(), concat!(crate::app_slug!(), "-help")]);
    assert_eq!(servers[1]["api_key_env"], HELP_TOKEN_ENV);
    assert_eq!(o.env["VIBE_ENABLED_TOOLS"], concat!(r#"[""#, crate::app_slug!(), r#"_*",""#, crate::app_slug!(), r#"-help_*"]"#));
    assert!(!o.env["VIBE_MCP_SERVERS"].contains("helptok"));
    // An untagged model cannot call tools: nothing at all.
    let mut o = opts("vibe", &[], None);
    o.env.insert(crate::app_env!("LOCAL_MODEL").into(), "llama3:latest".into());
    apply_help_to_spawn_with(&mut o, &rt(), "helptok", &tagged);
    assert!(!o.env.contains_key(HELP_TOKEN_ENV) && !o.env.contains_key("VIBE_MCP_SERVERS"));
}

/// The help lane rides beside a tab's root-lane token: registering one
/// never revokes the other, closing the tab revokes both, and a help
/// session is neither listed nor re-grantable nor keeps a tab "active".
#[test]
fn help_tokens_are_a_separate_lane_per_tab() {
    let tab = "root:help-lane";
    let (root_token, root) = test_session_with(Caller::Agent, tab, Path::new("/nonexistent"), None);
    let (help_token, help) = test_session_with(Caller::Helper, tab, Path::new("/nonexistent"), None);
    assert!(root.check().is_ok() && help.check().is_ok(), "neither revoked the other");
    assert!(sessions().iter().all(|s| s.caller != Caller::Helper));
    assert!(set_access(&help.id, Access::initial(Caller::Helper)).is_err());
    let (_, help2) = test_session_with(Caller::Helper, tab, Path::new("/nonexistent"), None);
    assert!(help.check().is_err() && help2.check().is_ok() && root.check().is_ok(), "a respawn replaces its own lane");
    assert!(authenticate(Some(&format!("Bearer {help_token}"))).is_none());
    revoke_token(&root_token);
    assert!(!tab_active(tab), "a help session alone does not hold the tab's sandbox view");
    assert!(revoke_tab(tab));
    assert!(help2.check().is_err());
}

/// The markup lane: only a project tab with a schedule target, never a
/// container tab or an untagged local model; Claude and Codex are named
/// the server beside help, never twice, never with the token in argv.
#[test]
fn markup_wiring_needs_a_target_and_joins_the_other_servers() {
    let runtime = rt();
    for cli in super::super::markup_mcp::WIRED_CLIS {
        let mut root = opts(cli, &[], None);
        root.schedule_target_id = Some("t".into());
        apply_markup_to_spawn_with(&mut root, &runtime, "marktok", &[]);
        assert!(root.env.is_empty() && root.args.is_empty(), "root scope");
        let mut project = opts(cli, &[], Some("p"));
        apply_markup_to_spawn_with(&mut project, &runtime, "marktok", &[]);
        assert!(project.env.is_empty(), "no target");
        project.schedule_target_id = Some(String::new());
        apply_markup_to_spawn_with(&mut project, &runtime, "marktok", &[]);
        assert!(project.env.is_empty(), "empty target");
        project.schedule_target_id = Some("t".into());
        project.sandbox = true;
        apply_markup_to_spawn_with(&mut project, &runtime, "marktok", &[]);
        assert!(project.env.is_empty(), "container tab");
        project.sandbox = false;
        apply_help_to_spawn_with(&mut project, &runtime, "helptok", &[]);
        apply_markup_to_spawn_with(&mut project, &runtime, "marktok", &[]);
        apply_markup_to_spawn_with(&mut project, &runtime, "marktok", &[]);
        let argv = project.args.join(" ");
        assert!(argv.contains(concat!(crate::app_slug!(), "-help")) && argv.contains(concat!(crate::app_slug!(), "-markup")), "{argv}");
        assert_eq!(argv.matches("/mcp/markup").count(), 1, "never twice: {argv}");
        assert!(!argv.contains("marktok") && !argv.contains("helptok"));
        assert_eq!(project.env[MARKUP_TOKEN_ENV], "marktok");
        assert_eq!(project.env[MARKUP_URL_ENV], "http://127.0.0.1:4321/mcp/markup");
    }
    let mut claude = opts("claude", &[], Some("p"));
    claude.schedule_target_id = Some("t".into());
    apply_help_to_spawn_with(&mut claude, &runtime, "helptok", &[]);
    apply_markup_to_spawn_with(&mut claude, &runtime, "marktok", &[]);
    assert_eq!(claude.args.iter().filter(|a| *a == "--mcp-config").count(), 1);
    let mut gemini = opts("gemini", &[], Some("p"));
    gemini.schedule_target_id = Some("t".into());
    apply_markup_to_spawn_with(&mut gemini, &runtime, "marktok", &[]);
    assert!(gemini.args.is_empty());
    assert_eq!(gemini.env[MARKUP_TOKEN_ENV], "marktok");
    // A tool-tagged local model: merged after help; an untagged one: nothing.
    let tagged = vec!["gemma4:e4b".to_string()];
    let mut o = opts("vibe", &[], Some("p"));
    o.schedule_target_id = Some("t".into());
    o.env.insert(crate::app_env!("LOCAL_MODEL").into(), "gemma4:e4b".into());
    apply_help_to_spawn_with(&mut o, &rt(), "helptok", &tagged);
    apply_markup_to_spawn_with(&mut o, &rt(), "marktok", &tagged);
    let servers: Value = serde_json::from_str(&o.env["VIBE_MCP_SERVERS"]).unwrap();
    let names: Vec<_> = servers.as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, [concat!(crate::app_slug!(), "-help"), concat!(crate::app_slug!(), "-markup")]);
    assert_eq!(servers[1]["api_key_env"], MARKUP_TOKEN_ENV);
    assert!(!o.env["VIBE_MCP_SERVERS"].contains("marktok"));
    let mut o = opts("vibe", &[], Some("p"));
    o.schedule_target_id = Some("t".into());
    o.env.insert(crate::app_env!("LOCAL_MODEL").into(), "llama3:latest".into());
    apply_markup_to_spawn_with(&mut o, &rt(), "marktok", &tagged);
    assert!(!o.env.contains_key(MARKUP_TOKEN_ENV));
}

/// The markup lane rides beside the others like help: hidden from MCP
/// session access, not re-grantable, never keeps a tab "active", and a
/// respawn replaces only its own lane.
#[test]
fn markup_tokens_are_a_separate_lane_per_tab() {
    let tab = "p:markup-lane";
    let (root_token, root) = test_session_with(Caller::Scheduler, tab, Path::new("/nonexistent"), None);
    let (_, help) = test_session_with(Caller::Helper, tab, Path::new("/nonexistent"), None);
    let (_, mark) = test_session_bound(Caller::Marker, tab, "p", "t");
    assert!(root.check().is_ok() && help.check().is_ok() && mark.check().is_ok());
    assert!(sessions().iter().all(|s| s.caller != Caller::Marker));
    assert!(set_access(&mark.id, Access::initial(Caller::Marker)).is_err());
    let (_, mark2) = test_session_bound(Caller::Marker, tab, "p", "t");
    assert!(mark.check().is_err() && mark2.check().is_ok() && help.check().is_ok(), "a respawn replaces its own lane");
    revoke_token(&root_token);
    assert!(!tab_active(tab), "help and markup sessions do not hold the tab's sandbox view");
    assert!(revoke_tab(tab));
    assert!(mark2.check().is_err() && !session_alive(&mark2.id));
}

/// Missing keys retain old defaults; an unavailable policy file refuses.
#[test]
fn the_switch_is_on_unless_stored_off() {
    let fx = Fixture::new();
    std::fs::remove_file(&fx.settings).unwrap();
    assert!(!enabled_in(&fx.settings), "missing security settings refuse access");
    fx.write_state("settings.json", json!({ "debug": true }));
    assert!(enabled_in(&fx.settings));
    fx.write_state("settings.json", json!({ "root_mcp": false }));
    assert!(!enabled_in(&fx.settings));
    fx.write_state("settings.json", json!({ "root_mcp": true }));
    assert!(enabled_in(&fx.settings));
}

struct Fixture {
    dir: tempfile::TempDir,
    calendar: std::path::PathBuf,
    projects: std::path::PathBuf,
    settings: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let calendar = dir.path().join("calendar.json");
        let projects = dir.path().join("projects.json");
        std::fs::write(
            &projects,
            r#"[{"id":"p1","name":"Alpha","status":"active","position":0,"local_file":"","directory":"/w/alpha"},
                    {"id":"p2","name":"Beta","status":"inactive","position":1,"local_file":"","remote":{"host":"h"}}]"#,
        )
        .unwrap();
        let settings = dir.path().join("settings.json");
        // Mail is off by default; the class tables below cover every tool.
        std::fs::write(&settings, r#"{"root_mcp_mail":true}"#).unwrap();
        Fixture { dir, calendar, projects, settings }
    }
    fn stores(&self) -> Stores<'_> {
        Stores {
            calendar: &self.calendar,
            projects: &self.projects,
            settings: &self.settings,
            state: self.dir.path(),
            caller: Caller::Agent,
            mail: None,
            reader_refusal: None,
            policy: Policy::load(&self.settings).unwrap(),
            access: Access::initial(Caller::Agent), session: None, deadline: None,
        }
    }
    /// Write one of the flat state files the read-only sweeps roll up.
    fn write_state(&self, name: &str, body: Value) {
        std::fs::write(self.dir.path().join(name), body.to_string()).unwrap();
    }
    /// Write one of a remote project's per-project state files.
    fn write_remote_state(&self, project_id: &str, name: &str, body: Value) {
        let dir = self.dir.path().join("remote-projects").join(project_id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), body.to_string()).unwrap();
    }
    fn call_fx(&self, name: &str, args: Value) -> (Value, Effects) {
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                          "params": { "name": name, "arguments": args } });
        let mut settings: Value = crate::storage::read_json(&self.settings).unwrap_or(json!({}));
        settings["root_mcp_review"] = json!("off");
        self.write_state("settings.json", settings);
        let (reply, effects) = handle_message(&self.stores(), "root:test", &msg);
        (reply.unwrap()["result"].clone(), effects)
    }
    fn call(&self, name: &str, args: Value) -> (Value, Vec<Change>) {
        let (result, effects) = self.call_fx(name, args);
        (result, effects.changes)
    }
    /// The tool itself, past the review layer: for what a write hands the
    /// window once applied. (A write that reaches a CalDAV server stages
    /// at every level, so through [`Self::call`] it reports no changes.)
    fn call_unreviewed(&self, name: &str, args: Value) -> (Value, Vec<Change>) {
        match call_tool(&self.stores(), name, &args) {
            Ok((value, effects)) => (json!({ "content": [{ "type": "text", "text": value.to_string() }], "isError": false }), effects.changes),
            Err(e) => (json!({ "content": [{ "type": "text", "text": e }], "isError": true }), Vec::new()),
        }
    }
}

/// Every CLI the spawn tests use, all wearing the "MCP" chip.
fn every_agent() -> Vec<String> {
    WIRED_CLIS.iter().chain(&["gemini", "vibe"]).map(|c| c.to_string()).collect()
}

fn text(result: &Value) -> Value {
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap_or(Value::Null)
}

#[test]
fn only_a_root_scope_agent_is_a_root_agent() {
    assert!(is_root_agent(&opts("claude", &[], None), true));
    assert!(!is_root_agent(&opts("claude", &[], Some("p1")), true));
    assert!(!is_root_agent(&opts("claude", &[], Some("box:b")), true));
    // A root *shell* is not an agent and gets nothing.
    assert!(!is_root_agent(&opts("bash", &[], None), false));
}

#[test]
fn claude_gets_an_inline_config_last_in_argv() {
    let mut o = opts("claude", &["--resume", "abc"], None);
    apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
    assert_eq!(&o.args[..2], ["--resume", "abc"]);
    assert_eq!(o.args[2], "--mcp-config");
    let cfg: Value = serde_json::from_str(&o.args[3]).unwrap();
    let server = &cfg["mcpServers"][crate::app_slug!()];
    assert_eq!(server["url"], "http://127.0.0.1:4321/mcp");
    assert_eq!(server["headers"]["Authorization"], concat!("Bearer ${", crate::app_upper!(), "_ROOT_MCP_TOKEN}"));
    assert_eq!(o.env[TOKEN_ENV], "tok");
    assert!(!o.args.iter().any(|a| a.contains("Bearer tok")), "the token is never in Claude's argv");
    // A respawn that re-runs the wiring must not stack the flag.
    apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
    assert_eq!(o.args.iter().filter(|a| *a == "--mcp-config").count(), 1);
}

#[test]
fn every_wired_cli_is_named_the_server() {
    for cli in WIRED_CLIS {
        let mut o = opts(cli, &[], None);
        apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
        assert!(!o.args.is_empty(), "{cli} is listed as wired but gets no server");
    }
    // An unlisted CLI gets the env pair only — which is what the chip says.
    let mut o = opts("gemini", &[], None);
    apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
    assert!(o.args.is_empty() && o.env.contains_key(TOKEN_ENV));
}

#[test]
fn codex_overrides_precede_the_resume_subcommand_and_name_the_token() {
    let mut o = opts("/usr/bin/codex", &["resume", "abc"], None);
    apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
    assert_eq!(o.args[0], "-c");
    assert_eq!(o.args[1], concat!("mcp_servers.", crate::app_slug!(), ".url=\"http://127.0.0.1:4321/mcp\""));
    assert_eq!(o.args[3], concat!("mcp_servers.", crate::app_slug!(), ".bearer_token_env_var=\"", crate::app_upper!(), "_ROOT_MCP_TOKEN\""));
    assert_eq!(&o.args[4..], ["resume", "abc"]);
    assert!(!o.args.iter().any(|a| a.contains("tok\"")), "the token is never in Codex's argv");
}

#[test]
fn vibe_gets_the_server_only_for_a_model_wearing_the_mcp_chip() {
    let tagged = vec!["gemma4:e4b".to_string()];
    let vibe = |env: &[(&str, &str)]| {
        let mut o = opts("vibe", &[], None);
        for (k, v) in env {
            o.env.insert(k.to_string(), v.to_string());
        }
        o
    };

    let mut o = vibe(&[(crate::app_env!("LOCAL_MODEL"), "gemma4:e4b"), ("VIBE_ACTIVE_MODEL", "gemma4-e4b")]);
    apply_to_spawn_with(&mut o, &rt(), "tok", &[], &tagged, false);
    let servers: Value = serde_json::from_str(&o.env["VIBE_MCP_SERVERS"]).unwrap();
    assert_eq!(servers[0]["name"], crate::app_slug!());
    assert_eq!(servers[0]["url"], "http://127.0.0.1:4321/mcp");
    assert_eq!(servers[0]["api_key_env"], TOKEN_ENV);
    assert_eq!(o.env["VIBE_ENABLED_TOOLS"], concat!(r#"[""#, crate::app_slug!(), r#"_*"]"#));
    assert!(!o.env["VIBE_MCP_SERVERS"].contains("tok"), "the token is named, never inlined");
    assert!(o.args.is_empty());

    // A restored tab carries only the alias.
    let mut o = vibe(&[("VIBE_ACTIVE_MODEL", "gemma4-e4b")]);
    apply_to_spawn_with(&mut o, &rt(), "tok", &[], &tagged, false);
    assert!(o.env.contains_key("VIBE_MCP_SERVERS"));

    // Untagged model ("Root" without "MCP"): tools stay off and it gets
    // nothing — not even the env pair, whichever agents wear the chip.
    let mut o = vibe(&[(crate::app_env!("LOCAL_MODEL"), "llama3:latest"), ("VIBE_ACTIVE_MODEL", "llama3-latest")]);
    apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &tagged, false);
    assert!(!o.env.contains_key("VIBE_MCP_SERVERS"));
    assert!(!o.env.contains_key("VIBE_ENABLED_TOOLS"));
    assert!(!o.env.contains_key(URL_ENV) && !o.env.contains_key(TOKEN_ENV));
}

/// A `vibe_local/<leaf>` home under `share`, with the config
/// `prepare_local_agent` (and the privacy gate) writes for `model` at `addr`.
fn local_vibe_home(share: &Path, leaf: &str, model: &str, addr: &str) -> String {
    let home = share.join("vibe_local").join(leaf);
    std::fs::create_dir_all(&home).unwrap();
    let alias = crate::services::ollama_client::sanitize_alias(model);
    std::fs::write(home.join("config.toml"), crate::services::local_drivers::vibe_local_config(model, &alias, addr)).unwrap();
    home.to_string_lossy().into_owned()
}

/// Gaps 25 and 33, and the local-model caller's provenance: a tab is a
/// `LocalModel` caller only when the backend reads a loopback Ollama model out of
/// the home it runs from. Its model and endpoint come from that config, a new tab of
/// a model that read mail in another tab starts tainted, and the renderer's label
/// alone (or a cloud argv, a foreign home, a hand-edited config) is no local model
/// and is handed no token at all.
#[test]
fn a_local_tab_is_what_its_home_says_and_starts_with_the_models_taint() {
    let raw = crate::app_env!("LOCAL_MODEL");
    let tagged = vec!["gemma4:e4b".to_string(), "qwen3:8b".to_string()];
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("settings.json"), json!({ "ollama_mcp_models": tagged, "root_mcp_agents": ["claude"] }).to_string()).unwrap();
    let share = tempfile::tempdir().unwrap();
    let mut trusted = Trusted::read(dir.path(), None);
    trusted.share = share.path().to_path_buf();
    let store = TokenStore::default();
    let gemma_home = local_vibe_home(share.path(), "gemma4-e4b", "gemma4:e4b", "127.0.0.1:11434");
    let qwen_home = local_vibe_home(share.path(), "qwen3-8b", "qwen3:8b", "127.0.0.1:11434");
    let vibe = |tab: &str, env: &[(&str, &str)]| {
        let mut o = opts("vibe", &[], None);
        o.id = tab.to_string();
        for (k, v) in env {
            o.env.insert(k.to_string(), v.to_string());
        }
        o
    };
    let spawn = |tab: &str, env: &[(&str, &str)]| {
        let mut o = vibe(tab, env);
        grant_root(&mut o, &rt(), &store, &trusted);
        o.env.get(TOKEN_ENV).and_then(|t| store.authenticate(Some(&format!("Bearer {t}"))))
    };
    let gemma = [(raw, "gemma4:e4b"), ("VIBE_ACTIVE_MODEL", "gemma4-e4b"), ("VIBE_HOME", gemma_home.as_str())];
    let first = spawn("root:model-a", &gemma).unwrap();
    assert_eq!(first.identity.caller, Caller::LocalModel);
    assert_eq!(first.identity.model.as_deref(), Some("gemma4:e4b"));
    assert_eq!(first.identity.endpoint.as_deref(), Some("127.0.0.1:11434"));
    assert!(!first.has_read_mail());
    // Its first mail read, as `root_mcp_mail::call` records it.
    record_read_mail(dir.path(), "root:model-a", first.identity.model.as_deref()).unwrap();
    assert!(spawn("root:model-b", &gemma).unwrap().has_read_mail(), "a new tab of that model");
    // A restored tab carries the alias and the home, not the label.
    let restored = spawn("root:model-c", &[("VIBE_ACTIVE_MODEL", "gemma4-e4b"), ("VIBE_HOME", gemma_home.as_str())]).unwrap();
    assert_eq!((restored.identity.caller, restored.identity.model.as_deref()), (Caller::LocalModel, Some("gemma4:e4b")));
    assert!(restored.has_read_mail(), "alias only, same model");
    let qwen = spawn("root:model-d", &[(raw, "qwen3:8b"), ("VIBE_HOME", qwen_home.as_str())]).unwrap();
    assert!(!qwen.has_read_mail(), "another model is untouched");

    // The label alone: no home, a home that is not Tabtivity's, or a label that
    // names another model than the home runs (an Ollama cloud model, say).
    let foreign = tempfile::tempdir().unwrap();
    std::fs::write(foreign.path().join("config.toml"), "active_model = \"mistral-vibe-cli-latest\"\n").unwrap();
    let foreign_home = foreign.path().to_string_lossy().into_owned();
    assert!(spawn("root:claim-a", &[(raw, "gemma4:e4b")]).is_none(), "a label and no home");
    assert!(spawn("root:claim-b", &[(raw, "gemma4:e4b"), ("VIBE_HOME", foreign_home.as_str())]).is_none(), "a home of the user's");
    assert!(spawn("root:claim-c", &[(raw, "gpt-oss:120b-cloud"), ("VIBE_HOME", gemma_home.as_str())]).is_none(), "a label naming another model");
    assert!(spawn("root:claim-d", &[("VIBE_ACTIVE_MODEL", "gemma4-e4b"), ("VIBE_HOME", qwen_home.as_str())]).is_none(), "an alias that is not the home's");
    assert!(spawn("root:claim-e", &[(raw, "gemma4:e4b"), ("VIBE_HOME", gemma_home.as_str()), ("VIBE_PROVIDERS", "[]")]).is_none(), "a config override in env");
    // A cloud argv with the label is no local model either: not for vibe with
    // other flags, not for another CLI.
    let mut flagged = vibe("root:claim-f", &gemma);
    flagged.args = vec!["--agent".into(), "x".into()];
    grant_root(&mut flagged, &rt(), &store, &trusted);
    assert!(!flagged.env.contains_key(TOKEN_ENV));
    let mut cloud = opts("claude", &[], None);
    cloud.id = "root:claim-g".into();
    cloud.env.insert(raw.into(), "gemma4:e4b".into());
    cloud.env.insert("VIBE_HOME".into(), gemma_home.clone());
    grant_root(&mut cloud, &rt(), &store, &trusted);
    let session = store.authenticate(Some(&format!("Bearer {}", cloud.env[TOKEN_ENV]))).unwrap();
    assert_eq!((session.identity.caller, session.identity.model), (Caller::Agent, None), "a cloud CLI with the label is a cloud agent");
    // A home whose config was edited to another endpoint or an extra provider.
    let remote_home = local_vibe_home(share.path(), "gemma4-e4b.remote", "gemma4:e4b", "203.0.113.5:11434");
    assert!(spawn("root:claim-h", &[(raw, "gemma4:e4b"), ("VIBE_HOME", remote_home.as_str())]).is_none(), "a remote Ollama is not local");
    let edited = Path::new(&gemma_home).join("config.toml");
    let mut text = std::fs::read_to_string(&edited).unwrap();
    text.push_str("\n[[providers]]\nname = \"cloud\"\napi_base = \"https://api.example/v1\"\n");
    std::fs::write(&edited, text).unwrap();
    assert!(spawn("root:claim-i", &gemma).is_none(), "an extra provider");
}

#[test]
fn local_only_hands_cloud_agents_nothing_and_local_models_their_own_token() {
    for cmd in ["claude", "codex", "gemini", "vibe"] {
        let mut o = opts(cmd, &[], None);
        apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], true);
        assert!(o.args.is_empty(), "{cmd}");
        assert!(!o.env.contains_key(TOKEN_ENV), "{cmd}");
        assert!(!o.env.contains_key(URL_ENV), "{cmd}");
    }
    let tagged = vec!["gemma4:e4b".to_string()];
    let mut o = opts("vibe", &[], None);
    o.env.insert(crate::app_env!("LOCAL_MODEL").into(), "gemma4:e4b".into());
    apply_to_spawn_with(&mut o, &rt(), "tok", &[], &tagged, true);
    assert!(o.env.contains_key("VIBE_MCP_SERVERS"));
    assert_eq!(o.env[TOKEN_ENV], "tok");
    // The local token is the local tab's with the switch off too, so
    // flipping it on later keeps that tab served.
    let mut o = opts("vibe", &[], None);
    o.env.insert(crate::app_env!("LOCAL_MODEL").into(), "gemma4:e4b".into());
    apply_to_spawn_with(&mut o, &rt(), "tok", &[], &tagged, false);
    assert_eq!(o.env[TOKEN_ENV], "tok");
}

#[test]
fn stale_spawn_teardown_cannot_revoke_a_replacement_token() {
    let tab = "root:token-generation";
    register_token("generation-old".into(), Identity { schedule_target: None, push: None, tab: tab.into(), caller: Caller::Agent, project: None, endpoint: None, model: None }, false);
    register_token("generation-new".into(), Identity { schedule_target: None, push: None, tab: tab.into(), caller: Caller::LocalModel, project: None, endpoint: None, model: None }, false);
    assert!(revoke_token("generation-old").is_none());
    assert_eq!(caller(Some("Bearer generation-new")).unwrap().tab, tab);
    let mut options = opts("vibe", &[], None);
    options.env.insert(TOKEN_ENV.into(), "generation-new".into());
    drop(SpawnTokenGuard::new(&options));
    assert!(caller(Some("Bearer generation-new")).is_none());
}

#[test]
fn the_endpoint_tells_callers_apart_and_local_only_refuses_agents() {
    register_token("tok".into(), Identity { schedule_target: None, push: None, tab: "root:auth-agent".into(), caller: Caller::Agent, project: None, endpoint: None, model: None }, false);
    register_token("loc".into(), Identity { schedule_target: None, push: None, tab: "root:auth-local".into(), caller: Caller::LocalModel, project: None, endpoint: None, model: None }, false);
    assert_eq!(caller(Some("Bearer tok")).unwrap().caller, Caller::Agent);
    assert_eq!(caller(Some("Bearer loc")).unwrap().caller, Caller::LocalModel);
    assert_eq!(caller(Some("Bearer nope")), None);
    assert_eq!(caller(None), None);
    revoke_tab("root:auth-agent");
    assert_eq!(caller(Some("Bearer tok")), None);
    assert!(caller(Some("Bearer loc")).is_some());
    revoke_tab("root:auth-local");

    let fx = Fixture::new();
    assert!(serves(&fx.settings, Caller::Agent), "absent means every root agent");
    fx.write_state("settings.json", json!({ "root_mcp_local_only": true }));
    assert!(!serves(&fx.settings, Caller::Agent));
    assert!(serves(&fx.settings, Caller::LocalModel));
    fx.write_state("settings.json", json!({ "root_mcp": false, "root_mcp_local_only": true }));
    assert!(!serves(&fx.settings, Caller::LocalModel), "the global switch outranks it");
}

/// Mail has its own switch and it starts off: `root_mcp` alone lists no
/// mail tool, refuses a call to one by name, and serves a reader nothing.
#[test]
fn mail_tools_are_off_until_switched_on_separately() {
    use crate::services::root_mcp_mail::is_mail_tool;
    let fx = Fixture::new();
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let draft = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                        "params": { "name": "mail_drafts_list", "arguments": {} } });
    let listed_mail = |fx: &Fixture| {
        let (reply, _) = handle_message(&fx.stores(), "t", &list);
        reply.unwrap()["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| is_mail_tool(t["name"].as_str().unwrap()))
            .count()
    };
    for off in [Some(json!({})), Some(json!({ "root_mcp": true })), Some(json!({ "root_mcp_mail": false }))] {
        match &off {
            Some(body) => fx.write_state("settings.json", body.clone()),
            None => std::fs::remove_file(&fx.settings).unwrap(),
        }
        assert_eq!(listed_mail(&fx), 0, "{off:?}");
        let (reply, _) = handle_message(&fx.stores(), "t", &draft);
        let result = reply.unwrap()["result"].clone();
        assert_eq!(result["isError"], true, "{off:?}");
        assert_eq!(result["content"][0]["text"], MAIL_OFF, "{off:?}");
        assert!(serves(&fx.settings, Caller::Agent), "the other tools stay on: {off:?}");
        assert!(!serves(&fx.settings, Caller::Reader), "a reader is mail only: {off:?}");
    }
    fx.write_state("settings.json", json!({ "root_mcp_mail": true }));
    assert!(listed_mail(&fx) > 0);
    assert!(serves(&fx.settings, Caller::Reader));
    fx.write_state("settings.json", json!({ "root_mcp": false, "root_mcp_mail": true }));
    assert!(!serves(&fx.settings, Caller::Reader), "the global switch outranks it");
}

#[test]
fn a_root_agent_without_the_mcp_chip_gets_nothing() {
    let only_codex = vec!["codex".to_string()];
    for cmd in ["claude", "/usr/bin/claude", "gemini"] {
        let mut o = opts(cmd, &["--resume", "abc"], None);
        apply_to_spawn_with(&mut o, &rt(), "tok", &only_codex, &[], false);
        assert_eq!(o.args, ["--resume", "abc"], "{cmd}");
        assert!(o.env.is_empty(), "{cmd}");
    }
    let mut o = opts("/usr/bin/codex", &[], None);
    apply_to_spawn_with(&mut o, &rt(), "tok", &only_codex, &[], false);
    assert_eq!(o.env[TOKEN_ENV], "tok");
}

#[test]
fn the_mcp_agent_list_falls_back_to_the_root_agents() {
    let s: crate::schema::Settings =
        serde_json::from_value(json!({ "root_agents": ["claude", "gemini"] })).unwrap();
    assert_eq!(s.root_mcp_agent_list(), ["claude", "gemini"], "pre-chip root agents keep the tools");
    let s: crate::schema::Settings =
        serde_json::from_value(json!({ "root_agents": ["claude"], "root_mcp_agents": [] })).unwrap();
    assert!(s.root_mcp_agent_list().is_empty(), "an explicit empty list is none");
}

#[test]
fn other_agents_get_the_env_pair_only() {
    let mut o = opts("gemini", &[], None);
    apply_to_spawn_with(&mut o, &rt(), "tok", &every_agent(), &[], false);
    assert!(o.args.is_empty());
    assert_eq!(o.env[URL_ENV], "http://127.0.0.1:4321/mcp");
}

#[test]
fn bearer_check() {
    assert!(authorized(Some("Bearer tok"), "tok"));
    assert!(!authorized(Some("Bearer to"), "tok"));
    assert!(!authorized(Some("tok"), "tok"));
    assert!(!authorized(None, "tok"));
}

#[test]
fn minted_tokens_are_long_and_distinct() {
    let (a, b) = (mint_token().unwrap(), mint_token().unwrap());
    assert_eq!(a.len(), 64);
    assert_ne!(a, b);
}

#[test]
fn notifications_get_no_reply_and_unknown_methods_an_error() {
    let f = Fixture::new();
    let (reply, _) = handle_message(&f.stores(), "root:test", &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    assert!(reply.is_none());
    let (reply, _) = handle_message(&f.stores(), "root:test", &json!({ "jsonrpc": "2.0", "id": 7, "method": "nope" }));
    assert_eq!(reply.unwrap()["error"]["code"], -32601);
}

/// `root_mcp_mail_local_only`, end to end through `handle_message`: a
/// cloud agent loses exactly the mail tools (unlisted, refused by name with
/// a message that says which switch), a local model keeps them, a reader
/// is refused outright, and a flip applies to the next request.
#[test]
fn mail_local_only_withholds_mail_from_cloud_agents_only() {
    use crate::services::root_mcp_mail::is_mail_tool;
    let fx = Fixture::new();
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let call = |name: &str| json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                    "params": { "name": name, "arguments": {} } });
    // Fresh stores per request, as the HTTP layer loads policy per request.
    let stores = |caller| Stores { caller, access: Access::initial(caller), ..fx.stores() };
    let listed = |caller| -> Vec<String> {
        let (reply, _) = handle_message(&stores(caller), "t", &list);
        reply.unwrap()["result"]["tools"].as_array().unwrap().iter()
            .map(|t| t["name"].as_str().unwrap().to_string()).collect()
    };
    let text = |caller, name: &str| -> String {
        let (reply, _) = handle_message(&stores(caller), "t", &call(name));
        reply.unwrap()["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
    };
    let mail_of = |names: &[String]| names.iter().filter(|n| is_mail_tool(n)).cloned().collect::<Vec<_>>();

    // Baseline, companion off: both root classes list their draft tools.
    let agent_before = listed(Caller::Agent);
    let local_before = listed(Caller::LocalModel);
    assert!(!mail_of(&agent_before).is_empty() && !mail_of(&local_before).is_empty());

    fx.write_state("settings.json", json!({ "root_mcp_mail": true, "root_mcp_mail_local_only": true }));
    // Cloud agent: every non-mail tool still listed, no mail tool.
    let agent = listed(Caller::Agent);
    let expected: Vec<String> = agent_before.iter().filter(|n| !is_mail_tool(n)).cloned().collect();
    assert_eq!(agent, expected);
    for name in mail_of(&agent_before) {
        assert_eq!(text(Caller::Agent, &name), MAIL_LOCAL_ONLY, "{name}");
    }
    // Its calendar tools keep working.
    assert!(!text(Caller::Agent, "calendar_list").starts_with("mail tools"));
    // Local model: its list is unchanged, and a mail call reaches the mail
    // layer (the fixture has no store, so it is refused as locked instead).
    assert_eq!(listed(Caller::LocalModel), local_before);
    for name in mail_of(&local_before) {
        let t = text(Caller::LocalModel, &name);
        assert!(t != MAIL_LOCAL_ONLY && t != MAIL_OFF && !t.starts_with("unknown tool"), "{name}: {t}");
    }
    // Reader: the endpoint refuses it before any method.
    assert!(!serves(&fx.settings, Caller::Reader));
    let (reply, _) = handle_message(&stores(Caller::Reader), "t", &list);
    assert_eq!(reply.unwrap()["error"]["code"], -32000);

    // With mail itself off the answer names that switch, for every class.
    fx.write_state("settings.json", json!({ "root_mcp_mail": false, "root_mcp_mail_local_only": true }));
    for caller in [Caller::Agent, Caller::LocalModel] {
        assert!(mail_of(&listed(caller)).is_empty(), "{caller:?}");
        assert_eq!(text(caller, "mail_drafts_list"), MAIL_OFF, "{caller:?}");
    }

    // Stacked with the endpoint-wide local-only: agents get nothing at all,
    // a local model still gets mail.
    fx.write_state("settings.json", json!({ "root_mcp_mail": true, "root_mcp_mail_local_only": true, "root_mcp_local_only": true }));
    let (reply, _) = handle_message(&stores(Caller::Agent), "t", &list);
    assert_eq!(reply.unwrap()["error"]["code"], -32000);
    assert_eq!(listed(Caller::LocalModel), local_before);

    // The global switch outranks both.
    fx.write_state("settings.json", json!({ "root_mcp": false, "root_mcp_mail": true, "root_mcp_mail_local_only": true }));
    let (reply, _) = handle_message(&stores(Caller::LocalModel), "t", &list);
    assert_eq!(reply.unwrap()["error"]["code"], -32000);

    // Flipped back off: the running agent gets mail again on its next request.
    fx.write_state("settings.json", json!({ "root_mcp_mail": true, "root_mcp_mail_local_only": false }));
    assert_eq!(listed(Caller::Agent), agent_before);
    assert!(serves(&fx.settings, Caller::Reader));
}

/// The gap 25 sibling: "kept to local models" means the model. A
/// local-model tab on an Ollama cloud model (or on a model its endpoint
/// does not list, or none recorded) is refused the whole endpoint under
/// `root_mcp_local_only` and the mail tools under
/// `root_mcp_mail_local_only`, as a cloud agent is; an installed model
/// keeps both, and with both switches off nothing is asked.
#[test]
fn local_only_switches_refuse_a_local_tab_on_a_cloud_model() {
    let fx = Fixture::new();
    let tags = r#"{"models":[{"name":"llama3:latest"},{"name":"gpt-oss:120b-cloud","remote_host":"https://ollama.com:443"}]}"#;
    crate::services::ollama_client::test_tags::set(Some(tags));
    let ep = Some("127.0.0.1:11434".to_string());
    let session_of = |tab: &str, model: Option<&str>| test_session_model(Caller::LocalModel, tab, fx.dir.path(), ep.clone(), model.map(String::from)).1;
    let local = session_of("root:lo-local", Some("llama3:latest"));
    let cloud = session_of("root:lo-cloud", Some("gpt-oss:120b-cloud"));
    let unknown = session_of("root:lo-unknown", Some("mistral:7b"));
    let none = session_of("root:lo-none", None);
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let draft = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "mail_drafts_list", "arguments": {} } });
    let reply = |session: &Session, msg: &Value| {
        let stores = Stores { caller: Caller::LocalModel, access: Access::initial(Caller::LocalModel), session: Some(session), ..fx.stores() };
        handle_message(&stores, &session.identity.tab, msg).0.unwrap()
    };
    let text = |session: &Session| reply(session, &draft)["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string();

    // Both switches off: every local tab is served as before.
    for s in [&local, &cloud, &unknown, &none] {
        assert!(reply(s, &list)["result"]["tools"].is_array(), "{}", s.identity.tab);
        assert_ne!(text(s), MAIL_LOCAL_ONLY);
    }
    fx.write_state("settings.json", json!({ "root_mcp_mail": true, "root_mcp_local_only": true }));
    assert!(reply(&local, &list)["result"]["tools"].is_array());
    for s in [&cloud, &unknown, &none] {
        assert_eq!(reply(s, &list)["error"]["code"], -32000, "{}", s.identity.tab);
    }
    fx.write_state("settings.json", json!({ "root_mcp_mail": true, "root_mcp_mail_local_only": true }));
    assert_ne!(text(&local), MAIL_LOCAL_ONLY);
    for s in [&cloud, &unknown, &none] {
        assert_eq!(text(s), MAIL_LOCAL_ONLY, "{}", s.identity.tab);
        assert!(reply(s, &list)["result"]["tools"].is_array(), "its other tools stay: {}", s.identity.tab);
    }
    // No server to ask: not confirmed, refused.
    crate::services::ollama_client::test_tags::set(None);
    assert_eq!(text(&local), MAIL_LOCAL_ONLY);
    for tab in ["root:lo-local", "root:lo-cloud", "root:lo-unknown", "root:lo-none"] { revoke_tab(tab); }
}

#[test]
fn tools_list_matches_the_advertised_names() {
    let f = Fixture::new();
    let (reply, _) = handle_message(&f.stores(), "root:test", &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
    let listed: Vec<String> = reply.unwrap()["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    // A root tab is shown everything but the mail read tools.
    let served_root: Vec<&str> = tool_names().into_iter().filter(|n| served(Caller::Agent, n)).collect();
    assert_eq!(listed, served_root);
    assert!(!listed.iter().any(|n| crate::services::root_mcp_mail::is_read_tool(n)));
}

/// Table-driven over every tool × every class: `tools/list` equals the
/// served set exactly, and a call outside it is an unknown tool. A tool
/// added later is in no class until someone places it on purpose.
#[test]
fn every_tool_has_a_class_and_dispatch_follows_it() {
    use crate::services::root_mcp_mail::READ_TOOLS;
    const SWEEP: &[&str] =
        &["projects_list", "projects_git_status", "sync_status", "time_summary", "usage_recap", "boxes_list", "project_activity"];
    let f = Fixture::new();
    // A local-model tab twice: its read tools follow `root_mcp_mail_local_read`.
    for (caller, local_read) in [(Caller::Agent, true), (Caller::LocalModel, false), (Caller::LocalModel, true), (Caller::Reader, false)] {
        let mut stores = Stores { caller, ..f.stores() };
        stores.policy.mail_local_read = local_read;
        let (reply, _) = handle_message(&stores, "t", &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        let listed: Vec<String> = reply.unwrap()["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        for name in tool_names() {
            // A reader gets no sweep and no file import (it is handed no attachment).
            let expected = if caller == Caller::Reader {
                !SWEEP.contains(&name) && name != crate::services::root_mcp_import::TOOL
            } else {
                !READ_TOOLS.contains(&name) || (caller == Caller::LocalModel && local_read)
            };
            // The class table serves a local-model tab its read tools; the
            // switch decides per request whether they exist.
            let class = expected || (caller == Caller::LocalModel && READ_TOOLS.contains(&name));
            assert_eq!(served(caller, name), class, "{caller:?} × {name}");
            assert_eq!(listed.iter().any(|l| l == name), expected, "tools/list: {caller:?} × {name}");
            let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                              "params": { "name": name, "arguments": {} } });
            let (reply, _) = handle_message(&stores, "t", &msg);
            let text = reply.unwrap()["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string();
            // A local-model tab's read tools with the switch off exist and
            // say so (`LOCAL_READ_OFF`); every other unserved name is unknown.
            let switched_off = text == crate::services::root_mcp_mail::LOCAL_READ_OFF;
            assert_eq!(switched_off, class && !expected, "switch: {caller:?} × {name}: {text}");
            assert_eq!(!text.starts_with("unknown tool") && !switched_off, expected, "dispatch: {caller:?} × {name}: {text}");
        }
    }
    // A root tab's draft tools have no recipient and no reply argument.
    let (reply, _) = handle_message(&f.stores(), "t", &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
    let tools = reply.unwrap()["result"]["tools"].clone();
    let create = tools.as_array().unwrap().iter().find(|t| t["name"] == "mail_draft_create").unwrap().clone();
    for absent in ["to", "cc", "bcc", "reply_to_message_id"] {
        assert!(create["inputSchema"]["properties"].get(absent).is_none(), "{absent}");
    }
}

/// The reader wiring names the guest-side URL and the token only by name.
#[test]
fn a_reader_is_wired_to_the_guest_side_address_and_only_a_wired_cli() {
    let mut args = vec!["resume".to_string(), "abc".to_string()];
    let env = reader_wiring("codex", &mut args, "s3cret").unwrap();
    assert!(args[1].contains(&reader_endpoint_url()), "{args:?}");
    assert!(!args.iter().any(|a| a.contains("s3cret") || a.contains("127.0.0.1")), "{args:?}");
    assert_eq!(args[args.len() - 2..], ["resume".to_string(), "abc".to_string()]);
    assert!(env.contains(&(TOKEN_ENV.to_string(), "s3cret".to_string())));
    let mut args = Vec::new();
    reader_wiring("/usr/bin/claude", &mut args, "s3cret").unwrap();
    assert_eq!(args[0], "--mcp-config");
    assert!(args[1].contains(&reader_endpoint_url()) && !args[1].contains("s3cret"));
    assert!(reader_wiring("bash", &mut Vec::new(), "s3cret").is_none(), "a plain shell is handed nothing");
}

/// Two spawns get different tokens, each bound to its own tab and class; a
/// closed tab's token is refused.
#[test]
fn tokens_are_per_tab_and_die_with_it() {
    let (a, b) = (mint_token().unwrap(), mint_token().unwrap());
    assert_ne!(a, b);
    register_token(a.clone(), Identity { schedule_target: None, push: None, tab: "root:pt-a".into(), caller: Caller::Agent, project: None, endpoint: None, model: None }, false);
    register_token(b.clone(), Identity { schedule_target: None, push: None, tab: "vm:pt-b".into(), caller: Caller::Reader, project: Some("p1".into()), endpoint: None, model: None }, false);
    let ida = caller(Some(&format!("Bearer {a}"))).unwrap();
    let idb = caller(Some(&format!("Bearer {b}"))).unwrap();
    assert_eq!((ida.tab.as_str(), ida.caller), ("root:pt-a", Caller::Agent));
    assert_eq!((idb.tab.as_str(), idb.caller, idb.project.as_deref()), ("vm:pt-b", Caller::Reader, Some("p1")));
    revoke_tab("root:pt-a");
    assert!(caller(Some(&format!("Bearer {a}"))).is_none(), "a closed tab's token is refused");
    assert!(caller(Some(&format!("Bearer {b}"))).is_some());
    revoke_tab("vm:pt-b");
}

/// Codex prompts before any tool that does not say it is read-only, so the
/// classification is listed here in full rather than derived from the name: a
/// tool added without deciding which side it is on fails this test.
#[test]
fn every_tool_is_deliberately_classified() {
    const READ_ONLY: &[&str] = &[
        "proposals_list",
        "projects_list",
        "projects_git_status",
        "boxes_list",
        "calendar_list",
        "todo_list",
        "time_summary",
        "usage_recap",
        "sync_status",
        "project_activity",
        "calendar_free_busy",
        "mail_accounts_list",
        "mail_folders",
        "mail_search",
        "mail_read",
        "mail_thread",
        "mail_drafts_list",
    ];
    const DESTRUCTIVE: &[&str] = &[
        "calendar_update_event",
        "calendar_move_events",
        "calendar_delete_event",
        "todo_update",
        "todo_delete",
        "mail_draft_update",
        "mail_draft_delete",
    ];
    // The two classes between them list every tool.
    let mut tools = tool_definitions(Caller::Agent, true, false).as_array().unwrap().clone();
    for tool in tool_definitions(Caller::Reader, true, true).as_array().unwrap() {
        if !tools.iter().any(|t| t["name"] == tool["name"]) {
            tools.push(tool.clone());
        }
    }
    assert_eq!(tools.len(), tool_names().len());
    for tool in &tools {
        let name = tool["name"].as_str().unwrap();
        let hints = &tool["annotations"];
        assert_eq!(hints["readOnlyHint"], READ_ONLY.contains(&name), "{name}");
        if !READ_ONLY.contains(&name) {
            assert_eq!(hints["destructiveHint"], DESTRUCTIVE.contains(&name), "{name}");
        }
    }
    // Every listed tool is dispatched: a schema with no arm would be a tool
    // the agent can see and never call.
    let f = Fixture::new();
    for name in tool_names().into_iter().filter(|n| served(Caller::Agent, n)) {
        let (result, _) = f.call_fx(name, json!({}));
        let error = result["content"][0]["text"].as_str().unwrap_or_default();
        assert!(!error.starts_with("unknown tool"), "{name}");
    }
}

#[test]
fn an_event_defaults_to_one_hour_and_rolls_midnight() {
    let f = Fixture::new();
    let (result, change) = f.call("calendar_add_event", json!({ "title": "Review", "start": "2026-09-18T23:30:00" }));
    assert_eq!(result["isError"], false);
    let row = text(&result);
    assert_eq!(row["start"], "2026-09-18T23:30");
    assert_eq!(row["end"], "2026-09-19T00:30");
    let change = change.into_iter().next().unwrap();
    assert_eq!((change.kind, change.op), ("event", "upsert"));
    assert_eq!(change.row["id"], row["id"]);

    let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-18", "to": "2026-09-19" }));
    assert_eq!(text(&listed)["events"].as_array().unwrap().len(), 1);
    // Still running at midnight, so it is part of the 19th too — and gone
    // by the 20th.
    let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-19" }));
    assert_eq!(text(&listed)["events"].as_array().unwrap().len(), 1);
    let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-20" }));
    assert_eq!(text(&listed)["events"].as_array().unwrap().len(), 0);
}

#[test]
fn a_series_expands_and_free_busy_finds_the_gaps() {
    let f = Fixture::new();
    // Mondays and Wednesdays 09:00–10:00, three weeks from Monday 2026-09-21.
    let (r, _) = f.call("calendar_add_event", json!({ "title": "Standup", "start": "2026-09-21T09:00",
        "repeat": { "freq": "weekly", "weekdays": [1, 3], "until": "2026-10-07" }, "reminders": [10] }));
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(text(&r)["rrule"]["byweekday"], json!([1, 3]));
    assert_eq!(text(&r)["alarms"][0]["minutes_before"], 10);
    f.call("calendar_add_event", json!({ "title": "Lunch", "start": "2026-09-21T12:00" }));

    let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-21", "to": "2026-09-28", "expand": true }));
    let events = text(&listed)["events"].clone();
    let series = events.as_array().unwrap().iter().find(|e| e["title"] == "Standup").unwrap();
    let starts: Vec<&str> = series["occurrences"].as_array().unwrap().iter().map(|o| o["start"].as_str().unwrap()).collect();
    assert_eq!(starts, ["2026-09-21T09:00", "2026-09-23T09:00"]);
    // Past `until`, the series has nothing to show and is left out.
    let (later, _) = f.call("calendar_list", json!({ "from": "2026-10-12", "to": "2026-10-19", "expand": true }));
    assert!(text(&later)["events"].as_array().unwrap().is_empty());

    let (fb, _) = f.call("calendar_free_busy", json!({ "from": "2026-09-21", "to": "2026-09-22" }));
    let fb = text(&fb);
    assert_eq!(fb["busy"].as_array().unwrap().len(), 2);
    let free: Vec<(&str, &str)> = fb["free"].as_array().unwrap().iter()
        .map(|g| (g["start"].as_str().unwrap(), g["end"].as_str().unwrap())).collect();
    assert_eq!(free, [
        ("2026-09-21T08:00", "2026-09-21T09:00"),
        ("2026-09-21T10:00", "2026-09-21T12:00"),
        ("2026-09-21T13:00", "2026-09-21T18:00"),
    ]);
    let (wide, _) = f.call("calendar_free_busy", json!({ "from": "2026-01-01", "to": "2026-12-31" }));
    assert_eq!(wide["isError"], true);
}

#[test]
fn a_read_shows_fields_not_the_stored_row() {
    let f = Fixture::new();
    let mut data = crate::services::calendar_store::read_data(&f.calendar).unwrap();
    data.calendars.push(crate::schema::calendar::Calendar {
        rev: 0,
        id: "feed".into(), name: "Feed".into(), color: "#4aa3df".into(), visible: true, readonly: true,
        extra: HashMap::new(),
    });
    let server = HashMap::from([
        ("caldav_href".to_string(), json!("https://dav.example/u/1.ics")),
        ("caldav_etag".to_string(), json!("\"abc\"")),
    ]);
    data.events.push(CalendarEvent {
        id: "inv".into(), calendar_id: "default".into(), start: "2026-09-21T09:00".into(), end: "2026-09-21T10:00".into(),
        title: "Sync\u{200b}\u{202e}".into(), extra: server.clone(), ..Default::default()
    });
    data.events.push(CalendarEvent {
        id: "ext".into(), calendar_id: "feed".into(), start: "2026-09-21T11:00".into(), end: "2026-09-21T12:00".into(),
        title: "Talk".into(), notes: "slides at https://evil.example/x?d=".into(),
        conference: "https://meet.example/abc".into(), ..Default::default()
    });
    crate::storage::write_json_atomic(&f.calendar, &data).unwrap();

    let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-21", "to": "2026-09-22" }));
    let raw = listed["content"][0]["text"].as_str().unwrap().to_string();
    assert!(!raw.contains("caldav_") && !raw.contains("dav.example") && !raw.contains("evil.example") && !raw.contains("meet.example"), "{raw}");
    let events = text(&listed)["events"].clone();
    let by_id = |id: &str| events.as_array().unwrap().iter().find(|e| e["id"] == id).unwrap().clone();
    assert_eq!(by_id("inv")["title"], "Sync");
    assert_eq!(by_id("inv")["synced"], true);
    assert_eq!(by_id("ext")["external"], true);
    assert_eq!(by_id("ext")["notes"], "slides at [link]");
}

#[test]
fn a_calendar_imported_from_a_file_reads_as_external() {
    let f = Fixture::new();
    let mut data = crate::services::calendar_store::read_data(&f.calendar).unwrap();
    data.calendars.push(crate::schema::calendar::Calendar {
        rev: 0,
        id: "file".into(), name: "Conf".into(), color: "#8d8fd6".into(), visible: true, readonly: false,
        extra: HashMap::from([("imported".to_string(), json!(true))]),
    });
    data.events.push(CalendarEvent {
        id: "e".into(), calendar_id: "file".into(), start: "2026-09-21T11:00".into(), end: "2026-09-21T12:00".into(),
        title: "Talk".into(), notes: "post to https://evil.example/x".into(), ..Default::default()
    });
    data.tasks.push(CalendarTask {
        id: "t".into(), calendar_id: "file".into(), title: "see https://evil.example/y".into(), ..Default::default()
    });
    crate::storage::write_json_atomic(&f.calendar, &data).unwrap();
    let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-21", "to": "2026-09-22" }));
    let (cards, _) = f.call("todo_list", json!({}));
    for reply in [&listed, &cards] {
        assert!(!reply["content"][0]["text"].as_str().unwrap().contains("evil.example"));
    }
    assert_eq!(text(&listed)["events"][0]["external"], true);
    let card = text(&cards)["cards"].as_array().unwrap().iter().find(|c| c["id"] == "t").unwrap().clone();
    assert_eq!(card["external"], true);
}

/// E3: an event made from a mail (`from_mail`), a card made from a mail
/// (`mail`) or from such an event, and a card in a read-only calendar read
/// as `external`, links removed, title and notes kept — in the lists and in
/// a write's receipt, for every caller. The user's own rows do not.
#[test]
fn mail_derived_rows_read_as_external() {
    use crate::schema::calendar::{TaskEventLink, TaskMailLink};
    let f = Fixture::new();
    let mut data = crate::services::calendar_store::read_data(&f.calendar).unwrap();
    data.calendars.push(crate::schema::calendar::Calendar {
        rev: 0,
        id: "feed".into(), name: "Feed".into(), color: "#4aa3df".into(), visible: true, readonly: true,
        extra: HashMap::new(),
    });
    let stamp = HashMap::from([(
        crate::services::calendar_store::FROM_MAIL_KEY.to_string(),
        json!({ "message_id": "INBOX-7", "account_id": "a1" }),
    )]);
    data.events.push(CalendarEvent {
        id: "mail".into(), calendar_id: "default".into(), start: "2026-09-21T09:00".into(), end: "2026-09-21T10:00".into(),
        title: "Kick-off, agenda at https://evil.example/a".into(), notes: "Ann <ann@partner.example>".into(),
        extra: stamp, ..Default::default()
    });
    data.events.push(CalendarEvent {
        id: "mine".into(), calendar_id: "default".into(), start: "2026-09-21T11:00".into(), end: "2026-09-21T12:00".into(),
        title: "Mine".into(), notes: "see https://my.example/notes".into(), ..Default::default()
    });
    let card = |id: &str, calendar: &str, title: &str| CalendarTask {
        id: id.into(), calendar_id: calendar.into(), title: title.into(), notes: "at https://evil.example/n".into(),
        ..Default::default()
    };
    data.tasks.push(CalendarTask {
        mail: Some(TaskMailLink { message_id: "INBOX-7".into(), subject: "Offer".into(), ..Default::default() }),
        ..card("from-mail", "default", "Reply https://evil.example/t")
    });
    data.tasks.push(CalendarTask {
        event: Some(TaskEventLink { event_id: "mail".into(), ..Default::default() }),
        ..card("from-event", "default", "Prepare kick-off")
    });
    data.tasks.push(CalendarTask {
        event: Some(TaskEventLink { event_id: "mine".into(), ..Default::default() }),
        ..card("from-mine", "default", "Prepare mine")
    });
    data.tasks.push(card("feed-card", "feed", "Feed todo"));
    data.tasks.push(card("plain", "default", "Plain"));
    crate::storage::write_json_atomic(&f.calendar, &data).unwrap();

    let (listed, _) = f.call("calendar_list", json!({ "from": "2026-09-21", "to": "2026-09-22" }));
    let events = text(&listed)["events"].clone();
    let event = |id: &str| events.as_array().unwrap().iter().find(|e| e["id"] == id).unwrap().clone();
    assert_eq!(event("mail")["external"], true);
    assert_eq!(event("mail")["title"], "Kick-off, agenda at [link]", "the title stays, its link goes");
    assert_eq!(event("mail")["notes"], "Ann <ann@partner.example>");
    assert!(event("mine").get("external").is_none());
    assert_eq!(event("mine")["notes"], "see https://my.example/notes");

    let (cards, _) = f.call("todo_list", json!({}));
    let cards = text(&cards)["cards"].clone();
    let card = |id: &str| cards.as_array().unwrap().iter().find(|c| c["id"] == id).unwrap().clone();
    for id in ["from-mail", "from-event", "feed-card"] {
        assert_eq!(card(id)["external"], true, "{id}");
        assert_eq!(card(id)["notes"], "at [link]", "{id}");
        assert!(!card(id).to_string().contains("evil.example"), "{id}");
    }
    assert_eq!(card("from-mail")["title"], "Reply [link]");
    for id in ["from-mine", "plain"] {
        assert!(card(id).get("external").is_none(), "{id}");
        assert_eq!(card(id)["notes"], "at https://evil.example/n", "{id}");
    }

    // A write's receipt goes through the same views, and an agent's edit
    // does not take the stamp away.
    let (r, _) = f.call("todo_update", json!({ "id": "from-mail", "priority": 1 }));
    assert_eq!(text(&r)["external"], true);
    assert!(!r["content"][0]["text"].as_str().unwrap().contains("evil.example"));
    let (r, _) = f.call("calendar_update_event", json!({ "id": "mail", "location": "Room 2" }));
    assert_eq!(text(&r)["external"], true);
    let (r, _) = f.call("todo_move", json!({ "id": "from-event", "column": "doing" }));
    assert_eq!(text(&r)["external"], true, "{r}");
    let stored = crate::services::calendar_store::read_data(&f.calendar).unwrap();
    let stored = stored.events.iter().find(|e| e.id == "mail").unwrap();
    assert_eq!(stored.location, "Room 2");
    assert!(stored.extra.contains_key(crate::services::calendar_store::FROM_MAIL_KEY));
}

#[test]
fn root_lane_refusals_are_audited_under_fixed_categories() {
    let error = |text: &str| json!({ "result": { "content": [{ "type": "text", "text": text }], "isError": true } });
    assert_eq!(refusal_reason(&json!({ "result": { "content": [], "isError": false } })), None);
    assert_eq!(refusal_reason(&json!({ "error": { "code": -32000, "message": "MCP access unavailable" } })), Some("access_unavailable"));
    assert_eq!(refusal_reason(&json!({ "error": { "code": -32601, "message": "method not found" } })), Some("protocol"));
    for (text, reason) in [
        (ACCESS_NARROWED, "access_narrowed"),
        (MAIL_OFF, "mail_off"),
        (MAIL_LOCAL_ONLY, "mail_local_only"),
        (super::super::root_mcp_mail::LOCKED, "mail_locked"),
        (super::super::root_mcp_mail::LOCAL_READ_OFF, "local_read_off"),
        (super::super::root_mcp_mail::LOCAL_READ_REMOTE, "local_read_remote"),
        (super::super::root_mcp_mail::LOCAL_READ_CLOUD, "local_read_cloud"),
        (super::super::root_mcp_mail::LOCAL_READ_UNRECORDED, "local_read_unrecorded"),
        (super::super::root_mcp_review::CONFLICT, "conflict"),
        (super::super::root_mcp_review::FAILED, "store_failed"),
        (super::super::root_mcp_review::PENDING_LIMIT, "pending_limit"),
        (super::super::root_mcp_review::OUTSIDE_GRANT, "outside_grant"),
        ("Change touches 300 rows, more than the 200 one proposal may hold; split it", "too_many_rows"),
        ("MCP request deadline exceeded", "deadline"),
        ("unknown tool 'x'", "unknown_tool"),
        // A tool's own words (which can carry the agent's arguments) are
        // never the category.
        ("event 'secret plans' not found", "invalid_or_unavailable"),
    ] {
        assert_eq!(refusal_reason(&error(text)), Some(reason), "{text}");
    }
    // Through the lane: a narrowed tool is refused under its category.
    let f = Fixture::new();
    let mut stores = f.stores();
    stores.access.write = false;
    let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": { "name": "todo_add", "arguments": { "title": "x" } } });
    let (reply, _) = handle_message(&stores, "root:test", &msg);
    assert_eq!(refusal_reason(&reply.unwrap()), Some("access_narrowed"));
}

#[test]
fn an_ics_import_is_staged_for_the_window_whatever_the_review_level() {
    let f = Fixture::new();
    std::fs::write(&f.settings, r#"{"root_mcp_review":"off"}"#).unwrap();
    let ics = format!("BEGIN:VCALENDAR\r\n{}END:VCALENDAR\r\n", "X-PAD:0123456789\r\n".repeat(2500));
    assert!(ics.len() > 32 * 1024);
    let before = std::fs::read(&f.calendar).ok();
    let (reply, effects) = f.call(crate::services::root_mcp_import::TOOL, json!({ "ics_text": ics }));
    assert_eq!(reply["isError"], false, "{reply}");
    assert_eq!(text(&reply)["staged"], true);
    assert!(effects.is_empty());
    assert_eq!(std::fs::read(&f.calendar).ok(), before);
    assert_eq!(crate::services::root_mcp_import::list(f.dir.path()).len(), 1);
    // No path, no URL: an argument the schema does not name is refused.
    let (path, _) = f.call(crate::services::root_mcp_import::TOOL, json!({ "path": "/tmp/a.ics" }));
    assert_eq!(path["isError"], true);
    assert!(!served(Caller::Reader, crate::services::root_mcp_import::TOOL));
}

#[test]
fn a_page_cuts_only_the_rows_it_is_about() {
    let f = Fixture::new();
    for n in 0..3 {
        f.call("todo_add", json!({ "title": format!("card {n}"), "priority": 1 }));
    }
    let (page, _) = f.call("todo_list", json!({ "offset": 2, "limit": 1 }));
    let page = text(&page);
    assert_eq!(page["cards"].as_array().unwrap().len(), 1);
    assert_eq!(page["cards"][0]["priority"], 1);
    // The columns are context for every page, not rows to page through.
    let (first, _) = f.call("todo_list", json!({ "limit": 1 }));
    let first = text(&first);
    assert_eq!(first["columns"], page["columns"]);
    assert_eq!(first["next_offsets"]["cards"], 1);
    assert!(first["truncated"].as_str().unwrap().contains("offset 1"));
}

/// A tool the user took away in *MCP session access* is named as such; a
/// tool outside the caller's class stays `unknown tool`, so a cloud tab
/// never learns from the refusal that mail read tools exist.
#[test]
fn a_narrowed_tool_is_named_and_a_foreign_one_stays_unknown() {
    let f = Fixture::new();
    let text = |stores: &Stores, name: &str| {
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": {} } });
        let (reply, _) = handle_message(stores, "t", &msg);
        reply.unwrap()["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
    };
    let mut read_only = f.stores();
    read_only.access.write = false;
    assert_eq!(text(&read_only, "calendar_add_event"), ACCESS_NARROWED);
    assert_eq!(text(&read_only, "mail_draft_create"), ACCESS_NARROWED);
    assert!(text(&read_only, "mail_read").starts_with("unknown tool"), "not of a cloud tab's class, narrowed or not");
    assert!(text(&read_only, "no_such_tool").starts_with("unknown tool"));
    let mut no_board = f.stores();
    no_board.access.families.retain(|f| f != "board");
    assert_eq!(text(&no_board, "todo_list"), ACCESS_NARROWED);
    assert!(!text(&no_board, "calendar_list").starts_with("unknown tool"));
    let reader = Stores { caller: Caller::Reader, access: Access::initial(Caller::Reader), ..f.stores() };
    assert!(text(&reader, "projects_list").starts_with("unknown tool"), "never of a reader's class");
    let mut local = Stores { caller: Caller::LocalModel, ..f.stores() };
    local.policy.mail_local_read = false;
    assert_eq!(text(&local, "mail_read"), crate::services::root_mcp_mail::LOCAL_READ_OFF, "of its class; the switch is named");
    local.access.families.retain(|f| f != "mail");
    assert_eq!(text(&local, "mail_read"), ACCESS_NARROWED, "the user's grant outranks the switch in the answer");
}

/// A reply past the response limit: a write's receipt keeps the staged
/// flag and the proposal id (the change has landed or is staged), a read
/// is told to narrow the query.
#[test]
fn an_oversized_reply_becomes_a_receipt() {
    let (receipt, is_error) = oversized_receipt("todo_add", &json!({"staged": true, "proposal": "p1", "card": "…"}));
    let receipt: Value = serde_json::from_str(&receipt).unwrap();
    assert!(!is_error);
    assert_eq!((receipt["result_omitted"].as_bool(), receipt["staged"].as_bool(), receipt["proposal"].as_str()), (Some(true), Some(true), Some("p1")));
    let (receipt, is_error) = oversized_receipt("todo_add", &json!({"id": "direct"}));
    assert!(!is_error && serde_json::from_str::<Value>(&receipt).unwrap()["staged"] == false);
    let (receipt, is_error) = oversized_receipt("todo_list", &json!({"cards": []}));
    assert!(is_error && receipt.contains("narrow"));
    // Through the endpoint: seventeen cards of 31 KiB pass the per-string
    // bound and together exceed the reply limit.
    let f = Fixture::new();
    for n in 0..17 {
        f.call("todo_add", json!({ "title": format!("big {n}"), "notes": "n".repeat(31 * 1024) }));
    }
    let (result, _) = f.call("todo_list", json!({}));
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"].as_str().unwrap().contains("narrow"));
    let (result, _) = f.call("todo_list", json!({ "limit": 1 }));
    assert_eq!(result["isError"], false);
}

/// Branch names and lockstep detail are the repository's and the host's
/// text: the invisible characters go, as they do for a commit subject.
#[test]
fn sweeps_strip_invisible_text_from_recorded_names() {
    let f = Fixture::new();
    f.write_remote_state("p2", "git_peer.json", json!({
        "enabled": true, "status": "desynchronized", "detail": "both\u{202e} sides moved",
        "localHead": { "kind": "branch", "name": "ma\u{200b}in", "sha": "abcdef1234567890" },
    }));
    f.write_remote_state("p2", "local_loss.json", json!([
        { "ts": 1_789_600_000, "source": "git", "kind": "deleted", "op": "pull", "paths": ["a\u{202e}.txt"], "total": 1, "recovery": "git\u{200b} reflog", "acked": false }
    ]));
    let (result, _) = f.call("sync_status", json!({}));
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(!text.contains('\u{202e}') && !text.contains('\u{200b}'), "{text}");
    assert!(text.contains("both sides moved") && text.contains("main @") && text.contains("a.txt") && text.contains("git reflog"), "{text}");
}

#[test]
fn explicit_duration_all_day_and_bad_input() {
    let f = Fixture::new();
    let (r, _) = f.call("calendar_add_event", json!({ "title": "A", "start": "2026-09-18T09:00", "duration_minutes": 90 }));
    assert_eq!(text(&r)["end"], "2026-09-18T10:30");
    let (r, _) = f.call("calendar_add_event", json!({ "title": "B", "start": "2026-09-30", "all_day": true }));
    assert_eq!(text(&r)["end"], "2026-10-01");

    for bad in [
        json!({ "title": "x", "start": "tomorrow" }),
        json!({ "title": "x", "start": "2026-13-01T09:00" }),
        json!({ "title": "x", "start": "2026-09-18T09:00", "end": "2026-09-18T08:00" }),
        json!({ "title": "x", "start": "2026-09-18T09:00", "duration_minutes": 0 }),
        json!({ "start": "2026-09-18T09:00" }),
        json!({ "title": "x", "start": "2026-09-18T09:00", "calendar": "nope" }),
    ] {
        let (r, change) = f.call("calendar_add_event", bad.clone());
        assert_eq!(r["isError"], true, "{bad}");
        assert!(change.is_empty());
    }
}

#[test]
fn deleting_an_event_hands_the_row_over() {
    let f = Fixture::new();
    let (r, _) = f.call("calendar_add_event", json!({ "title": "Gone", "start": "2026-09-18T09:00" }));
    let id = text(&r)["id"].as_str().unwrap().to_string();
    let (r, change) = f.call("calendar_delete_event", json!({ "id": id }));
    assert_eq!(r["isError"], false);
    let change = change.into_iter().next().unwrap();
    assert_eq!(change.op, "delete");
    assert_eq!(change.row["title"], "Gone");
    let (r, _) = f.call("calendar_delete_event", json!({ "id": id }));
    assert_eq!(r["isError"], true);
}

#[test]
fn a_card_links_to_a_project_by_name_and_completes() {
    let f = Fixture::new();
    let (r, change) = f.call("todo_add", json!({ "title": "Ship", "project": "alpha", "due": "2026-09-20" }));
    assert_eq!(r["isError"], false);
    let card = text(&r);
    assert_eq!(card["project_id"], "p1");
    assert_eq!(change[0].kind, "task");

    let (r, _) = f.call("todo_list", json!({ "project": "Beta" }));
    assert_eq!(text(&r)["cards"].as_array().unwrap().len(), 0);
    let (r, _) = f.call("todo_add", json!({ "title": "x", "project": "Gamma" }));
    assert_eq!(r["isError"], true);

    let id = card["id"].as_str().unwrap();
    let (r, _) = f.call("todo_complete", json!({ "id": id, "completed_at": "2026-09-17T12:00" }));
    assert_eq!(text(&r)["completed"], "2026-09-17T12:00");
    let (r, _) = f.call("todo_list", json!({}));
    assert_eq!(text(&r)["cards"].as_array().unwrap().len(), 0);
}

fn add_card(f: &Fixture, title: &str) -> String {
    let (r, _) = f.call("todo_add", json!({ "title": title }));
    text(&r)["id"].as_str().unwrap().to_string()
}

fn column_id(f: &Fixture, pick: impl Fn(&Value) -> bool) -> String {
    let data: Value = crate::storage::read_json(&f.calendar).unwrap();
    let cols = data["task_columns"].as_array().unwrap();
    cols.iter().find(|c| pick(c)).unwrap()["id"].as_str().unwrap().to_string()
}

#[test]
fn a_card_is_edited_field_by_field_and_cleared_by_an_empty_string() {
    let f = Fixture::new();
    let (r, _) = f.call("todo_add", json!({ "title": "Draft", "notes": "n", "due": "2026-09-20", "project": "p1", "tags": ["a"] }));
    let id = text(&r)["id"].as_str().unwrap().to_string();

    let (r, change) = f.call("todo_update", json!({ "id": id, "title": "Final", "priority": 1, "tags": ["b", "c"] }));
    assert_eq!(r["isError"], false);
    let card = text(&r);
    assert_eq!(card["title"], "Final");
    assert_eq!(card["priority"], 1);
    assert_eq!(card["tags"], json!(["b", "c"]));
    // Untouched fields survive.
    assert_eq!((card["notes"].clone(), card["due"].clone(), card["project_id"].clone()), (json!("n"), json!("2026-09-20"), json!("p1")));
    assert_eq!((change[0].kind, change[0].op, change[0].local), ("task", "upsert", false));

    let (r, _) = f.call("todo_update", json!({ "id": id, "notes": "", "due": "", "project": "" }));
    let card = text(&r);
    assert!(card.get("notes").is_none() && card.get("due").is_none() && card.get("project_id").is_none());

    for bad in [
        json!({ "id": id, "title": " " }),
        json!({ "id": id, "due": "soon" }),
        json!({ "id": id, "priority": 12 }),
        json!({ "id": id, "project": "Gamma" }),
        json!({ "id": "nope", "title": "x" }),
    ] {
        let (r, change) = f.call("todo_update", bad.clone());
        assert_eq!(r["isError"], true, "{bad}");
        assert!(change.is_empty());
    }
    let (r, _) = f.call("todo_list", json!({}));
    assert_eq!(text(&r)["cards"][0]["title"], "Final", "a refused edit wrote nothing");
}

/// Every field the card dialog edits is reachable: calendar, progress and
/// the checklist too, not only the title-row fields.
#[test]
fn a_card_takes_its_calendar_progress_and_checklist() {
    let f = Fixture::new();
    f.call("calendar_create", json!({ "name": "Work" }));
    let (r, _) = f.call("todo_add", json!({
        "title": "Plan", "calendar": "Work", "percent": 40,
        "subtasks": [{ "title": "Outline" }, { "title": "Draft", "done": true }],
    }));
    assert_eq!(r["isError"], false, "{r}");
    let card = text(&r);
    let id = card["id"].as_str().unwrap().to_string();
    let work = card["calendar_id"].clone();
    assert_ne!(work, "default");
    assert_eq!(card["percent"], 40);
    let steps = card["subtasks"].clone();
    assert_eq!((steps[0]["title"].clone(), steps[0]["done"].clone()), (json!("Outline"), json!(false)));
    assert_eq!(steps[1]["done"], true);
    let outline = steps[0]["id"].as_str().unwrap().to_string();
    let draft = steps[1]["id"].as_str().unwrap().to_string();

    // The list is replaced as given: a kept id keeps its tick unless told,
    // a dropped item goes, and a new one gets an id no kept item holds.
    let (r, change) = f.call("todo_update", json!({
        "id": id, "percent": 60,
        "subtasks": [{ "id": draft, "title": "Draft v2" }, { "title": "Review" }, { "title": "Ship" }],
    }));
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(change.len(), 1);
    let card = text(&r);
    assert_eq!(card["percent"], 60);
    let steps = card["subtasks"].as_array().unwrap().clone();
    assert_eq!(steps.len(), 3);
    assert_eq!((steps[0]["id"].as_str().unwrap(), steps[0]["title"].clone(), steps[0]["done"].clone()), (draft.as_str(), json!("Draft v2"), json!(true)));
    let ids: std::collections::HashSet<_> = steps.iter().map(|s| s["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids.len(), 3, "ids stay unique: {steps:?}");
    assert!(!ids.contains(&outline), "the dropped item is gone");

    f.call("calendar_create", json!({ "name": "Home" }));
    let (r, change) = f.call("todo_update", json!({ "id": id, "calendar": "Home" }));
    assert_eq!(r["isError"], false, "{r}");
    assert_ne!(text(&r)["calendar_id"], work);
    assert_eq!(change.len(), 1, "an unsynced card owes no server delete");

    for bad in [
        json!({ "id": id, "percent": 100 }),
        json!({ "id": id, "percent": -1 }),
        json!({ "id": id, "subtasks": [{ "title": " " }] }),
        json!({ "id": id, "subtasks": "x" }),
        json!({ "id": id, "calendar": "" }),
        json!({ "id": id, "calendar": "nowhere" }),
    ] {
        let (r, change) = f.call("todo_update", bad.clone());
        assert_eq!(r["isError"], true, "{bad}");
        assert!(change.is_empty(), "{bad}");
    }
    let (r, _) = f.call("todo_add", json!({ "title": "x", "percent": 100 }));
    assert_eq!(r["isError"], true);

    // A done card's progress is its done-ness: reopen first.
    f.call("todo_complete", json!({ "id": id, "completed_at": "2026-09-17T12:00" }));
    let (r, _) = f.call("todo_update", json!({ "id": id, "percent": 50 }));
    assert!(r["content"][0]["text"].as_str().unwrap().contains("todo_reopen"));
}

/// As for an event: a synced card moved to another calendar retires its
/// server copy first and arrives with no address to `PUT` back to.
#[test]
fn moving_a_synced_card_deletes_the_server_copy_first() {
    let f = Fixture::new();
    f.call("calendar_create", json!({ "name": "Work" }));
    let id = add_card(&f, "Synced");
    let mut data = crate::services::calendar_store::read_data(&f.calendar).unwrap();
    let task = data.tasks.iter_mut().find(|t| t.id == id).unwrap();
    task.extra.insert("caldav_href".into(), json!("/cal/personal/t.ics"));
    task.extra.insert("caldav_etag".into(), json!("\"e1\""));
    std::fs::write(&f.calendar, serde_json::to_string(&data).unwrap()).unwrap();

    let (_, changes) = f.call_unreviewed("todo_update", json!({ "id": id, "calendar": "Work" }));
    let [delete, upsert] = changes.as_slice() else { panic!("two rows, got {}", changes.len()) };
    assert_eq!((delete.kind, delete.op), ("task", "delete"));
    assert_eq!(delete.row["calendar_id"], "default");
    assert_eq!(delete.row["caldav_href"], "/cal/personal/t.ics");
    assert_eq!((upsert.kind, upsert.op), ("task", "upsert"));
    assert!(upsert.row.get("caldav_href").is_none() && upsert.row.get("caldav_etag").is_none(), "{}", upsert.row);

    // An edit that stays put keeps the address.
    let (_, changes) = f.call_unreviewed("todo_update", json!({ "id": id, "calendar": "Work", "title": "Still" }));
    assert_eq!(changes.len(), 1);
}

#[test]
fn deleting_a_card_hands_the_row_over() {
    let f = Fixture::new();
    let id = add_card(&f, "Gone");
    let (r, change) = f.call("todo_delete", json!({ "id": id }));
    assert_eq!(text(&r)["deleted"], id.as_str());
    assert_eq!((change[0].kind, change[0].op), ("task", "delete"));
    assert_eq!(change[0].row["title"], "Gone");
    let (r, change) = f.call("todo_delete", json!({ "id": id }));
    assert_eq!(r["isError"], true);
    assert!(change.is_empty());
}

#[test]
fn a_move_seeds_the_board_completes_into_done_and_reopens_out_of_it() {
    let f = Fixture::new();
    let (a, b) = (add_card(&f, "A"), add_card(&f, "B"));

    // The file has no board yet; the move creates it and the name resolves.
    let (r, change) = f.call("todo_move", json!({ "id": a, "column": "done", "completed_at": "2026-09-17T12:00" }));
    assert_eq!(r["isError"], false, "{r}");
    let done = column_id(&f, |c| c["done"] == true);
    let card = text(&r);
    assert_eq!((card["column"].as_str(), card["percent"].as_i64()), (Some(done.as_str()), Some(100)));
    assert_eq!(card["completed"], "2026-09-17T12:00");
    let moved = change.iter().find(|c| c.row["id"] == a.as_str()).unwrap();
    assert!(!moved.local, "a completion is something a server stores");

    // Reopen: out of done, no stamp left behind.
    let (r, _) = f.call("todo_reopen", json!({ "id": a }));
    let card = text(&r);
    assert_eq!(card["percent"], 0);
    assert!(card.get("completed").is_none());
    assert_ne!(card["column"], done.as_str());

    // A plain reorder is board-only, and a replay changes nothing.
    let home = text(&f.call("todo_list", json!({})).0)["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == b.as_str())
        .unwrap()["column"]
        .as_str()
        .unwrap()
        .to_string();
    let (r, change) = f.call("todo_move", json!({ "id": b, "column": home, "position": 0 }));
    assert_eq!(r["isError"], false);
    assert!(change.iter().all(|c| c.local));
    let (r, change) = f.call("todo_move", json!({ "id": b, "column": home, "position": 0 }));
    assert_eq!(text(&r)["id"], b.as_str());
    assert!(change.is_empty());

    // Moving out of done reopens, which is not board-only.
    f.call("todo_complete", json!({ "id": b }));
    let (r, change) = f.call("todo_move", json!({ "id": b, "column": home }));
    assert_eq!(text(&r)["percent"], 0);
    assert!(!change.iter().find(|c| c.row["id"] == b.as_str()).unwrap().local);

    for bad in [
        json!({ "id": b, "column": "nowhere" }),
        json!({ "id": "nope", "column": home }),
        json!({ "id": b, "column": home, "position": -1 }),
        json!({ "id": b }),
    ] {
        let (r, change) = f.call("todo_move", bad.clone());
        assert_eq!(r["isError"], true, "{bad}");
        assert!(change.is_empty());
    }
}

#[test]
fn projects_list_reports_remoteness_and_hides_nothing_else() {
    let f = Fixture::new();
    let (r, _) = f.call("projects_list", json!({}));
    let projects = text(&r)["projects"].clone();
    assert_eq!(projects[0]["directory"], "/w/alpha");
    assert_eq!(projects[0]["remote"], false);
    assert_eq!(projects[1]["remote"], true);
    assert_eq!(projects[0]["remote_only"], false);
    assert_eq!(projects[1]["remote_only"], false, "a plain Remote keeps its mirror");
}

/// A remote-only project (and a VM, remote-only by default) says so in the
/// list and in `sync_status`, which reports the posture instead of a lockstep
/// the user could take for something switched off; it is never read through a
/// stale `mirror` in the sweep.
#[test]
fn a_remote_only_project_reports_its_posture() {
    let f = Fixture::new();
    std::fs::write(
        &f.projects,
        r#"[{"id":"p1","name":"Alpha","status":"active","position":0,"local_file":"","directory":"/w/alpha"},
            {"id":"p2","name":"Beta","status":"inactive","position":1,"local_file":"","remote":{"host":"h","remote_path":"/srv/b"}},
            {"id":"p3","name":"Gamma","status":"inactive","position":2,"local_file":"","mirror":"/w/stale",
             "remote":{"host":"h","remote_path":"/srv/g","remote_only":true}},
            {"id":"p4","name":"Delta","status":"inactive","position":3,"local_file":"",
             "remote":{"host":"127.0.0.1","remote_path":"/home/u/d","vm":true}}]"#,
    )
    .unwrap();
    f.write_remote_state("p3", "git_peer.json", json!({ "enabled": true, "status": "inStep" }));
    let (r, _) = f.call("projects_list", json!({}));
    let rows = text(&r)["projects"].clone();
    let flag = |id: &str| rows.as_array().unwrap().iter().find(|p| p["id"] == id).unwrap()["remote_only"].clone();
    assert_eq!((flag("p1"), flag("p2"), flag("p3"), flag("p4")), (json!(false), json!(false), json!(true), json!(true)));

    let (r, _) = f.call("sync_status", json!({}));
    let out = text(&r);
    let row = |id: &str| out["remote_projects"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap().clone();
    assert_eq!(row("p2")["posture"], "mirrored");
    assert!(row("p2")["lockstep"].is_object());
    for id in ["p3", "p4"] {
        let pinned = row(id);
        assert_eq!(pinned["posture"], "remote_only", "{id}");
        assert!(pinned.get("lockstep").is_none() && pinned.get("byte_sync").is_none(), "{id}: {pinned}");
        assert!(pinned["warnings"].is_array());
    }

    let gamma = read_projects(&f.projects).into_iter().find(|p| p.id == "p3").unwrap();
    let checkout = local_checkout(&gamma);
    assert!(checkout.unwrap_err().contains("remote-only"), "never the stale mirror");
}

// ── calendar_update_event ───────────────────────────────────────────────

/// Add an event and hand back its id.
fn add_event(f: &Fixture, args: Value) -> String {
    let (r, _) = f.call("calendar_add_event", args);
    assert_eq!(r["isError"], false, "{r}");
    text(&r)["id"].as_str().unwrap().to_string()
}

/// The point of the tool: "move it to 15:00" must not also resize it.
#[test]
fn moving_an_event_keeps_its_length() {
    let f = Fixture::new();
    let id = add_event(&f, json!({ "title": "Review", "start": "2026-09-18T09:00", "duration_minutes": 180 }));
    let (r, changes) = f.call("calendar_update_event", json!({ "id": id, "start": "2026-09-18T15:00" }));
    let row = text(&r);
    assert_eq!(row["start"], "2026-09-18T15:00");
    assert_eq!(row["end"], "2026-09-18T18:00", "three hours stay three hours");
    assert_eq!(row["title"], "Review");
    let change = changes.into_iter().next().unwrap();
    assert_eq!((change.kind, change.op, change.local), ("event", "upsert", false));
    assert_eq!(change.row["id"], id);

    // An explicit length still wins, in either spelling.
    let (r, _) = f.call("calendar_update_event", json!({ "id": id, "duration_minutes": 30 }));
    assert_eq!(text(&r)["end"], "2026-09-18T15:30");
    let (r, _) = f.call("calendar_update_event", json!({ "id": id, "end": "2026-09-18T16:00" }));
    assert_eq!(text(&r)["end"], "2026-09-18T16:00");
}

#[test]
fn an_edit_touches_only_the_fields_it_is_given() {
    let f = Fixture::new();
    let id = add_event(&f, json!({
        "title": "Standup", "start": "2026-09-18T09:00", "location": "Room 2", "notes": "bring the plan"
    }));
    let (r, _) = f.call("calendar_update_event", json!({ "id": id, "title": "Standup (short)" }));
    let row = text(&r);
    assert_eq!(row["title"], "Standup (short)");
    assert_eq!(row["start"], "2026-09-18T09:00");
    assert_eq!(row["end"], "2026-09-18T10:00", "an untouched span is left byte for byte");
    assert_eq!(row["location"], "Room 2");
    // Present-but-empty clears, as in todo_update.
    let (r, _) = f.call("calendar_update_event", json!({ "id": id, "notes": "", "location": "Room 3" }));
    let row = text(&r);
    assert!(row["notes"].is_null(), "a cleared note is not serialized at all");
    assert_eq!(row["location"], "Room 3");
}

#[test]
fn an_edit_can_turn_an_event_all_day_and_back() {
    let f = Fixture::new();
    let id = add_event(&f, json!({ "title": "Trip", "start": "2026-09-18", "end": "2026-09-21", "all_day": true }));
    // A moved all-day event keeps its three-day span.
    let (r, _) = f.call("calendar_update_event", json!({ "id": id, "start": "2026-09-25" }));
    let row = text(&r);
    assert_eq!((row["start"].as_str(), row["end"].as_str()), (Some("2026-09-25"), Some("2026-09-28")));
    assert_eq!(row["all_day"], true);
    // Turning it into a timed event needs an hour to put it at.
    let (r, changes) = f.call("calendar_update_event", json!({ "id": id, "all_day": false }));
    assert_eq!(r["isError"], true);
    assert!(changes.is_empty());
    let (r, _) = f.call("calendar_update_event", json!({ "id": id, "all_day": false, "start": "2026-09-25T10:00" }));
    let row = text(&r);
    assert_eq!(row["all_day"], false);
    assert_eq!((row["start"].as_str(), row["end"].as_str()), (Some("2026-09-25T10:00"), Some("2026-09-25T11:00")));
    // And back: an event becoming all-day covers the day it starts on.
    let (r, _) = f.call("calendar_update_event", json!({ "id": id, "all_day": true }));
    let row = text(&r);
    assert_eq!((row["start"].as_str(), row["end"].as_str()), (Some("2026-09-25"), Some("2026-09-26")));
}

#[test]
fn an_edit_is_refused_where_it_could_not_be_pushed() {
    let f = Fixture::new();
    let id = add_event(&f, json!({ "title": "Talk", "start": "2026-09-18T09:00" }));
    for bad in [
        json!({ "id": "nope", "title": "x" }),
        json!({ "id": id, "title": "" }),
        json!({ "id": id, "start": "Friday" }),
        json!({ "id": id, "end": "2026-09-18T08:00" }),
        json!({ "id": id, "duration_minutes": 0 }),
        json!({ "id": id, "calendar": "nowhere" }),
        json!({}),
    ] {
        let (r, changes) = f.call("calendar_update_event", bad.clone());
        assert_eq!(r["isError"], true, "{bad}");
        assert!(changes.is_empty(), "{bad}");
    }

    // A calendar Tabtivity may show but not write back to.
    let mut data = crate::services::calendar_store::read_data(&f.calendar).unwrap();
    data.calendars.push(crate::schema::calendar::Calendar {
        id: "sub".into(),
        name: "Subscribed".into(),
        readonly: true,
        ..crate::schema::calendar::Calendar::default_calendar()
    });
    if let Some(event) = data.events.iter_mut().find(|e| e.id == id) {
        event.calendar_id = "sub".into();
    }
    std::fs::write(&f.calendar, serde_json::to_string(&data).unwrap()).unwrap();
    let (r, changes) = f.call("calendar_update_event", json!({ "id": id, "title": "Moved" }));
    assert_eq!(r["isError"], true);
    assert!(r["content"][0]["text"].as_str().unwrap().contains("read-only"));
    assert!(changes.is_empty());
}

#[test]
fn a_calendar_is_created_once_per_name_in_the_palette() {
    let f = Fixture::new();
    let (r, changes) = f.call("calendar_create", json!({ "name": "Work" }));
    assert_eq!(r["isError"], false, "{r}");
    let row = text(&r);
    assert_eq!(row["name"], "Work");
    // The default calendar is the first; the next palette colour is ours.
    assert_eq!(row["color"], CALENDAR_COLORS[1]);
    assert_eq!(row["visible"], true);
    let change = changes.into_iter().next().unwrap();
    assert_eq!((change.kind, change.op, change.local), ("calendar", "upsert", true));
    // Reachable by name from then on.
    add_event(&f, json!({ "title": "Sprint", "start": "2026-09-18T09:00", "calendar": "work" }));

    let (r, _) = f.call("calendar_create", json!({ "name": "Garden", "color": "#A0B0C0" }));
    assert_eq!(text(&r)["color"], "#a0b0c0");
    for bad in [
        json!({ "name": "WORK" }),
        json!({ "name": "  " }),
        json!({ "name": "Red", "color": "red" }),
        json!({ "name": "Red", "color": "#abc" }),
    ] {
        let (r, changes) = f.call("calendar_create", bad.clone());
        assert_eq!(r["isError"], true, "{bad}");
        assert!(changes.is_empty(), "{bad}");
    }
    let (listed, _) = f.call("calendar_list", json!({}));
    assert_eq!(text(&listed)["calendars"].as_array().unwrap().len(), 3);
}

/// Give an event the address a CalDAV sync would have left on it.
fn mark_synced(f: &Fixture, id: &str, href: &str) {
    let mut data = crate::services::calendar_store::read_data(&f.calendar).unwrap();
    let event = data.events.iter_mut().find(|e| e.id == id).unwrap();
    event.extra.insert("caldav_href".into(), json!(href));
    event.extra.insert("caldav_etag".into(), json!("\"e1\""));
    std::fs::write(&f.calendar, serde_json::to_string(&data).unwrap()).unwrap();
}

#[test]
fn events_move_between_calendars_by_id_or_all_at_once() {
    let f = Fixture::new();
    f.call("calendar_create", json!({ "name": "Work" }));
    f.call("calendar_create", json!({ "name": "Archive" }));
    let a = add_event(&f, json!({ "title": "A", "start": "2026-09-18T09:00", "duration_minutes": 90 }));
    let b = add_event(&f, json!({ "title": "B", "start": "2026-09-19T09:00" }));

    let (r, changes) = f.call("calendar_move_events", json!({ "ids": [a, a], "to": "Work" }));
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(text(&r)["moved"], json!([a]), "a repeated id moves once");
    let [change] = changes.as_slice() else { panic!("expected exactly one row") };
    assert_eq!((change.kind, change.op, change.local), ("event", "upsert", false));
    assert_eq!(change.row["id"], a, "a move keeps the event's identity");
    assert_eq!(change.row["end"], "2026-09-18T10:30", "and its times");
    let work = change.row["calendar_id"].clone();
    assert_ne!(work, "default");

    // Already there: nothing to do, nothing reported.
    let (r, changes) = f.call("calendar_move_events", json!({ "ids": [a], "to": "Work" }));
    assert_eq!(text(&r)["moved"], json!([]));
    assert!(changes.is_empty());

    // `from` empties a calendar.
    let (r, changes) = f.call("calendar_move_events", json!({ "from": "Personal", "to": "Archive" }));
    assert_eq!(text(&r)["moved"], json!([b]));
    assert_eq!(changes.len(), 1);
    let (listed, _) = f.call("calendar_list", json!({}));
    let events = text(&listed)["events"].clone();
    let calendar_of = |id: &str| {
        events.as_array().unwrap().iter().find(|e| e["id"] == id).unwrap()["calendar_id"].clone()
    };
    assert_eq!(calendar_of(&a), work);
    assert_ne!(calendar_of(&b), work);
}

#[test]
fn a_move_is_all_or_nothing_and_refused_where_it_could_not_be_pushed() {
    let f = Fixture::new();
    f.call("calendar_create", json!({ "name": "Work" }));
    let a = add_event(&f, json!({ "title": "A", "start": "2026-09-18T09:00" }));
    for bad in [
        json!({ "ids": [a, "nope"], "to": "Work" }),
        json!({ "ids": [a], "to": "nowhere" }),
        json!({ "ids": [a], "from": "Personal", "to": "Work" }),
        json!({ "ids": [], "to": "Work" }),
        json!({ "ids": "a", "to": "Work" }),
        json!({ "to": "Work" }),
        json!({ "ids": [a] }),
    ] {
        let (r, changes) = f.call("calendar_move_events", bad.clone());
        assert_eq!(r["isError"], true, "{bad}");
        assert!(changes.is_empty(), "{bad}");
    }
    let (listed, _) = f.call("calendar_list", json!({}));
    assert_eq!(text(&listed)["events"][0]["calendar_id"], "default", "the good id did not move either");

    // Neither into nor out of a calendar Tabtivity may not write back to.
    let mut data = crate::services::calendar_store::read_data(&f.calendar).unwrap();
    data.calendars.push(crate::schema::calendar::Calendar {
        id: "sub".into(),
        name: "Subscribed".into(),
        readonly: true,
        ..crate::schema::calendar::Calendar::default_calendar()
    });
    std::fs::write(&f.calendar, serde_json::to_string(&data).unwrap()).unwrap();
    let (r, _) = f.call("calendar_move_events", json!({ "ids": [a], "to": "Subscribed" }));
    assert!(r["content"][0]["text"].as_str().unwrap().contains("read-only"));
    let mut data = crate::services::calendar_store::read_data(&f.calendar).unwrap();
    data.events[0].calendar_id = "sub".into();
    std::fs::write(&f.calendar, serde_json::to_string(&data).unwrap()).unwrap();
    let (r, changes) = f.call("calendar_move_events", json!({ "ids": [a], "to": "Work" }));
    assert!(r["content"][0]["text"].as_str().unwrap().contains("read-only"));
    assert!(changes.is_empty());
}

/// A synced row is a resource in its old collection: the move must retire
/// that copy and hand the new calendar a row with no address to `PUT` to.
#[test]
fn moving_a_synced_event_deletes_the_server_copy_first() {
    let f = Fixture::new();
    f.call("calendar_create", json!({ "name": "Work" }));
    let a = add_event(&f, json!({ "title": "A", "start": "2026-09-18T09:00" }));
    mark_synced(&f, &a, "/cal/personal/a.ics");

    let (_, changes) = f.call_unreviewed("calendar_move_events", json!({ "ids": [a], "to": "Work" }));
    let [delete, upsert] = changes.as_slice() else { panic!("two rows, got {}", changes.len()) };
    assert_eq!((delete.kind, delete.op), ("event", "delete"));
    assert_eq!(delete.row["calendar_id"], "default", "addressed in the calendar it left");
    assert_eq!(delete.row["caldav_href"], "/cal/personal/a.ics");
    assert_eq!(delete.row["caldav_etag"], "\"e1\"");
    assert_eq!(upsert.op, "upsert");
    assert_ne!(upsert.row["calendar_id"], "default");
    assert!(upsert.row.get("caldav_href").is_none(), "{}", upsert.row);
    assert!(upsert.row.get("caldav_etag").is_none());
    let stored = crate::services::calendar_store::read_data(&f.calendar).unwrap();
    assert!(!stored.events[0].extra.contains_key("caldav_href"), "and on disk");

    // `calendar_update_event`'s `calendar` is the same move.
    let b = add_event(&f, json!({ "title": "B", "start": "2026-09-19T09:00" }));
    mark_synced(&f, &b, "/cal/personal/b.ics");
    let (r, changes) = f.call_unreviewed("calendar_update_event", json!({ "id": b, "calendar": "Work", "title": "B2" }));
    assert_eq!(text(&r)["title"], "B2");
    let ops: Vec<_> = changes.iter().map(|c| c.op).collect();
    assert_eq!(ops, ["delete", "upsert"]);
    assert!(changes[1].row.get("caldav_href").is_none());
    // An edit that does not move keeps the address and deletes nothing.
    let c = add_event(&f, json!({ "title": "C", "start": "2026-09-20T09:00" }));
    mark_synced(&f, &c, "/cal/personal/c.ics");
    let (_, changes) = f.call_unreviewed("calendar_update_event", json!({ "id": c, "calendar": "Personal", "title": "C2" }));
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].row["caldav_href"], "/cal/personal/c.ics");
}

#[test]
fn a_synced_series_with_server_overrides_does_not_move_in_pieces() {
    let f = Fixture::new();
    f.call("calendar_create", json!({ "name": "Work" }));
    let master = add_event(&f, json!({ "title": "Weekly", "start": "2026-09-18T09:00" }));
    let moved = add_event(&f, json!({ "title": "Weekly (moved)", "start": "2026-09-25T10:00" }));
    mark_synced(&f, &master, "/cal/personal/weekly.ics");
    mark_synced(&f, &moved, "/cal/personal/weekly.ics");
    let (r, changes) = f.call("calendar_move_events", json!({ "ids": [master], "to": "Work" }));
    assert_eq!(r["isError"], true);
    assert!(r["content"][0]["text"].as_str().unwrap().contains("recurring series"));
    assert!(changes.is_empty());
}

// ── The read-only sweeps ────────────────────────────────────────────────

#[test]
fn time_summary_ranges_by_day_and_keeps_the_app_out_of_the_projects() {
    let f = Fixture::new();
    f.write_state(
        "time_summary.json",
        json!({ "version": 1, "migrated": true, "days": {
            "2026-09-15": { "p1": 3600.0, concat!("__", crate::app_slug!(), "__"): 60.0 },
            "2026-09-16": { "p1": 1800.0, "p2": 7200.0 },
            "2026-09-17": { "p1": 900.0 },
        }}),
    );
    let (r, _) = f.call("time_summary", json!({ "from": "2026-09-15", "to": "2026-09-17" }));
    let out = text(&r);
    assert_eq!(out["total_seconds"], 3600 + 1800 + 7200);
    assert_eq!(out["app_seconds"], 60, concat!(crate::app_name!(), "'s own window time is never a project's"));
    // Sorted by time spent, and named.
    assert_eq!(out["projects"][0]["id"], "p2");
    assert_eq!(out["projects"][0]["name"], "Beta");
    assert_eq!(out["projects"][1]["seconds"], 5400);
    assert_eq!(out["days"].as_array().unwrap().len(), 2, "`to` is exclusive");
    assert_eq!(out["days"][0]["date"], "2026-09-15");

    let (r, _) = f.call("time_summary", json!({ "project": "Alpha" }));
    let out = text(&r);
    assert_eq!(out["total_seconds"], 6300);
    assert_eq!(out["projects"].as_array().unwrap().len(), 1);
    assert_eq!(f.call("time_summary", json!({ "from": "nope" })).0["isError"], true);
}

#[test]
fn usage_recap_totals_and_breaks_down_only_when_asked() {
    let f = Fixture::new();
    f.write_state(
        "usage_stats.json",
        json!({ "version": 1, "hours": {}, "days": {
            "2026-09-16": { "p1": { "agent.prompt.claude": 3, "shell.command": 10 }, "p2": { "agent.prompt.claude": 4 } },
            "2026-09-17": { "p1": { "agent.prompt.claude": 1 } },
        }}),
    );
    let (r, _) = f.call("usage_recap", json!({}));
    let out = text(&r);
    assert_eq!(out["totals"]["agent.prompt.claude"], 8);
    assert_eq!(out["totals"]["shell.command"], 10);
    assert_eq!(out["days_counted"], 2);
    assert!(out["projects"].is_null(), "the breakdown is opt-in");

    let (r, _) = f.call("usage_recap", json!({ "by_project": true, "to": "2026-09-17" }));
    let out = text(&r);
    assert_eq!(out["totals"]["agent.prompt.claude"], 7);
    assert_eq!(out["projects"][0]["id"], "p1", "the busiest project leads");
    assert_eq!(out["projects"][0]["counters"]["shell.command"], 10);
    assert_eq!(out["projects"][1]["name"], "Beta");

    // Naming a project is asking for its own numbers.
    let (r, _) = f.call("usage_recap", json!({ "project": "p2" }));
    let out = text(&r);
    assert_eq!(out["totals"]["agent.prompt.claude"], 4);
    assert_eq!(out["projects"].as_array().unwrap().len(), 1);
}

#[test]
fn boxes_list_names_its_members() {
    let f = Fixture::new();
    f.write_state(
        "boxes.json",
        json!([
            { "id": "b2", "name": "Later", "member_ids": ["p2"], "position": 20 },
            { "id": "b1", "name": "Thesis", "member_ids": ["p1", "p2", "gone"], "position": 10,
              "folder": concat!("/home/u/", crate::app_slug!(), "/boxes/thesis"),
              "relations": [{ "source": "p1", "target": "p2", "kind": "python-lib" }] },
        ]),
    );
    let (r, _) = f.call("boxes_list", json!({}));
    let boxes = text(&r)["boxes"].clone();
    assert_eq!(boxes[0]["name"], "Thesis", "ordered by position, not by file order");
    assert_eq!(boxes[0]["members"][0]["name"], "Alpha");
    // A member whose project is gone keeps its id rather than vanishing.
    assert_eq!(boxes[0]["members"][2]["name"], "gone");
    assert_eq!(boxes[0]["relations"][0]["source"], "Alpha");
    assert_eq!(boxes[0]["folder"], concat!("/home/u/", crate::app_slug!(), "/boxes/thesis"));
    assert!(boxes[1]["folder"].is_null());

    let (r, _) = f.call("boxes_list", json!({ "project": "Alpha" }));
    let boxes = text(&r)["boxes"].clone();
    assert_eq!(boxes.as_array().unwrap().len(), 1);
    assert_eq!(boxes[0]["id"], "b1");
    assert_eq!(f.call("boxes_list", json!({ "project": "nope" })).0["isError"], true);
}

#[test]
fn a_branch_header_is_read_in_every_shape_git_writes_it() {
    let cases = [
        ("## main", (Some("main"), None, 0, 0)),
        ("## main...origin/main", (Some("main"), Some("origin/main"), 0, 0)),
        ("## main...origin/main [ahead 2]", (Some("main"), Some("origin/main"), 2, 0)),
        ("## main...origin/main [behind 3]", (Some("main"), Some("origin/main"), 0, 3)),
        ("## dev...origin/dev [ahead 1, behind 2]", (Some("dev"), Some("origin/dev"), 1, 2)),
        ("## main...origin/main [gone]", (Some("main"), Some("origin/main"), 0, 0)),
        ("## No commits yet on main", (Some("main"), None, 0, 0)),
        ("## HEAD (no branch)", (None, None, 0, 0)),
    ];
    for (line, want) in cases {
        let (branch, upstream, ahead, behind) = parse_branch_header(line.trim_start_matches("## "));
        let got = (branch.as_deref(), upstream.as_deref(), ahead, behind);
        assert_eq!(got, want, "{line}");
    }
}

#[test]
fn porcelain_counts_split_staged_unstaged_and_untracked() {
    let snap = parse_porcelain(
        "## dev...origin/dev [ahead 1]\nM  staged.rs\n M unstaged.rs\nMM both.rs\n?? new.rs\nR  old.rs -> new_name.rs\n",
    );
    assert_eq!(snap.branch.as_deref(), Some("dev"));
    assert_eq!(snap.ahead, 1);
    assert_eq!((snap.staged, snap.unstaged, snap.untracked), (3, 2, 1));
}

/// A real repo, because the point of the tool is the answer about a folder.
#[test]
fn the_git_sweep_reads_local_copies_and_says_why_it_skipped_the_rest() {
    if !crate::services::git_hardened::git_available_blocking() {
        return; // Reported honestly by the tool itself; nothing to test here.
    }
    let f = Fixture::new();
    let repo = f.dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        crate::paths::command_no_window("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    if !git(&["init", "-q", "-b", "main"]) {
        return; // A git too old for `init -b`; the parser tests still hold.
    }
    git(&["config", "user.email", "t@example.invalid"]);
    git(&["config", "user.name", "T"]);
    std::fs::write(repo.join("a.txt"), "one").unwrap();
    git(&["add", "a.txt"]);
    git(&["commit", "-qm", "first"]);
    std::fs::write(repo.join("a.txt"), "two").unwrap();
    std::fs::write(repo.join("b.txt"), "new").unwrap();

    let plain = f.dir.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::write(
        &f.projects,
        json!([
            { "id": "p1", "name": "Alpha", "status": "active", "position": 0, "local_file": "", "directory": repo.to_str().unwrap() },
            { "id": "p2", "name": "Beta", "status": "active", "position": 1, "local_file": "", "remote": { "host": "h" } },
            { "id": "p3", "name": "Gamma", "status": "active", "position": 2, "local_file": "", "directory": plain.to_str().unwrap() },
            { "id": "p4", "name": "Delta", "status": "active", "position": 3, "local_file": "", "directory": "/nope/gone" },
        ])
        .to_string(),
    )
    .unwrap();

    let (r, changes) = f.call("projects_git_status", json!({}));
    assert_eq!(r["isError"], false, "{r}");
    assert!(changes.is_empty(), "a sweep writes nothing");
    let out = text(&r);
    let row = &out["projects"][0];
    assert_eq!(row["id"], "p1");
    assert_eq!(row["source"], "project");
    assert_eq!(row["branch"], "main");
    assert!(row["upstream"].is_null());
    assert_eq!((row["unstaged"].as_u64(), row["untracked"].as_u64()), (Some(1), Some(1)));
    assert_eq!(row["clean"], false);
    assert_eq!(out["projects"].as_array().unwrap().len(), 1);

    let reasons: HashMap<&str, &str> = out["skipped"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["id"].as_str().unwrap(), s["reason"].as_str().unwrap()))
        .collect();
    assert!(reasons["p2"].contains("no local mirror"), "never over SSH: {:?}", reasons["p2"]);
    assert_eq!(reasons["p3"], "not a git repository");
    assert!(reasons["p4"].starts_with("folder is missing"));

    // `dirty_only` keeps a sweep over many projects short.
    git(&["checkout", "-q", "--", "a.txt"]);
    std::fs::remove_file(repo.join("b.txt")).unwrap();
    let (r, _) = f.call("projects_git_status", json!({ "dirty_only": true }));
    assert!(text(&r)["projects"].as_array().unwrap().is_empty());
    let (r, _) = f.call("projects_git_status", json!({ "project": "Alpha" }));
    assert_eq!(text(&r)["projects"][0]["clean"], true);

    // Short of time, the sweep answers with what it has instead of failing:
    // the repo it could not start is named, not dropped.
    let short = Stores { deadline: Some(std::time::Instant::now() + std::time::Duration::from_secs(1)), ..f.stores() };
    let swept = projects_git_status(&short, &json!({})).unwrap();
    assert!(swept["incomplete"].is_string());
    assert!(swept["skipped"].as_array().unwrap().iter().any(|s| s["name"] == "Alpha"));
    let log = project_activity(&f.stores(), &json!({ "project": "Alpha", "commits": 1 })).unwrap();
    assert_eq!(log["commits"].as_array().unwrap().len(), 1);
    assert!(log["commits"][0]["subject"].is_string());
}

/// A local-models-only project's working copy is read for a local-model tab
/// whose model is confirmed local, and for nobody else: not a root agent, not
/// a call with no session, and not a Mistral tab on an Ollama cloud model, which
/// is a `LocalModel` caller whose answers come from ollama.com.
#[test]
fn a_locked_projects_working_copy_is_read_only_for_a_confirmed_local_model() {
    let f = Fixture::new();
    std::fs::write(
        &f.projects,
        json!([{ "id": "p1", "name": "Alpha", "status": "active", "position": 0, "local_file": "",
                 "directory": f.dir.path().join("nowhere").to_str().unwrap(),
                 "agent_privacy": { "local_models_only": true, "cut_network": false } }])
        .to_string(),
    )
    .unwrap();
    let hidden = |stores: &Stores| {
        let sweep = projects_git_status(stores, &json!({})).unwrap();
        let swept = sweep["skipped"].as_array().unwrap().iter().any(|s| s["reason"] == LOCAL_MODELS_ONLY_READ);
        let activity = project_activity(stores, &json!({ "project": "Alpha" })).err();
        assert_eq!(swept, activity.as_deref() == Some(LOCAL_MODELS_ONLY_READ), "the two tools agree");
        swept
    };
    let ep = Some("127.0.0.1:11434".to_string());
    let state = f.dir.path();
    crate::services::ollama_client::test_tags::set(Some(r#"{"models":[{"name":"llama3:latest"},{"name":"gpt-oss:120b-cloud","remote_host":"https://ollama.com"}]}"#));
    assert!(hidden(&f.stores()), "a root agent");
    let (_, local) = test_session_model(Caller::LocalModel, "root:locked-local", state, ep.clone(), Some("llama3:latest".into()));
    assert!(!hidden(&Stores { caller: Caller::LocalModel, session: Some(&local), ..f.stores() }), "a confirmed local model reads");
    assert!(hidden(&Stores { caller: Caller::LocalModel, session: None, ..f.stores() }), "nothing recorded to confirm");
    let (_, cloud) = test_session_model(Caller::LocalModel, "root:locked-cloud", state, ep.clone(), Some("gpt-oss:120b-cloud".into()));
    assert!(hidden(&Stores { caller: Caller::LocalModel, session: Some(&cloud), ..f.stores() }), "an Ollama cloud model does not");
    let (_, unrecorded) = test_session_model(Caller::LocalModel, "root:locked-none", state, ep, None);
    assert!(hidden(&Stores { caller: Caller::LocalModel, session: Some(&unrecorded), ..f.stores() }), "no recorded model");
    for tab in ["root:locked-local", "root:locked-cloud", "root:locked-none"] { revoke_tab(tab); }
}

#[test]
fn sync_status_reports_the_last_pass_and_the_unseen_warnings() {
    let f = Fixture::new();
    f.write_remote_state(
        "p2",
        "git_peer.json",
        json!({
            "enabled": true,
            "status": "desynchronized",
            "detail": "both sides moved",
            "localHead": { "kind": "branch", "name": "main", "sha": "abcdef1234567890" },
            "remoteHead": { "kind": "detached", "sha": "0123456789abcdef" },
            "lastSyncTs": 1_789_603_200,
        }),
    );
    f.write_remote_state(
        "p2",
        "sync.json",
        json!({
            "data/big.csv": { "selected": true, "is_dir": false, "last_pull_ts": 1_789_500_000, "auto_sync": true },
            "data": { "selected": true, "is_dir": true },
            "scratch": { "selected": false, "is_dir": true, "excluded": true },
        }),
    );
    f.write_remote_state(
        "p2",
        "local_loss.json",
        json!([
            { "ts": 1_789_600_000, "source": "git", "kind": "deleted", "op": "fast-forward from the host",
              "paths": ["a.rs", "b.rs"], "total": 2, "recovery": "git checkout HEAD@{1}", "acked": false },
            { "ts": 1_789_000_000, "source": "sync", "kind": "overwritten", "op": "manual pull",
              "paths": ["notes.md"], "total": 1, "recovery": null, "acked": true },
        ]),
    );

    let (r, changes) = f.call("sync_status", json!({}));
    assert!(changes.is_empty());
    let out = text(&r);
    assert_eq!(out["local_projects_skipped"], 1, "a local project has no host to be in step with");
    let row = &out["remote_projects"][0];
    assert_eq!((row["id"].as_str(), row["host"].as_str()), (Some("p2"), Some("h")));
    assert_eq!(row["lockstep"]["status"], "desynchronized");
    assert_eq!(row["lockstep"]["local_head"], "main @ abcdef12");
    assert_eq!(row["lockstep"]["remote_head"], "detached @ 01234567");
    assert_eq!(row["lockstep"]["last_pass"], "2026-09-17T00:00:00Z");
    assert_eq!(row["lockstep"]["blocked_by_pairing_conflict"], false);
    assert_eq!(row["byte_sync"]["tracked_files"], 1);
    assert_eq!(row["byte_sync"]["tracked_folders"], 1);
    assert_eq!(row["byte_sync"]["auto_paths"], 1);
    assert_eq!(row["byte_sync"]["excluded_paths"], 1);
    assert!(row["byte_sync"]["last_push"].is_null(), "never pushed is not 1970");
    let warnings = row["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1, "an acknowledged warning is not raised again");
    assert_eq!(warnings[0]["source"], "git");
    assert_eq!(warnings[0]["kind"], "deleted");
    assert_eq!(warnings[0]["total"], 2);

    let (r, _) = f.call("sync_status", json!({ "include_acked": true }));
    assert_eq!(text(&r)["remote_projects"][0]["warnings"].as_array().unwrap().len(), 2);

    // A remote project with no recorded state is still listed, at its defaults.
    let f = Fixture::new();
    let (r, _) = f.call("sync_status", json!({ "project": "Beta" }));
    let row = text(&r)["remote_projects"][0].clone();
    assert_eq!(row["lockstep"]["enabled"], false);
    assert_eq!(row["byte_sync"]["tracked_files"], 0);
    assert!(row["warnings"].as_array().unwrap().is_empty());
}


/// The cockpit capability is bound to a saved identity, not the tool arguments.
#[test]
fn cockpit_rename_is_self_only_versioned_and_revocable() {
    use crate::services::{cockpit_mcp as cockpit, workspace};
    let state = tempfile::tempdir().unwrap();
    crate::storage::write_json(&state.path().join("settings.json"), &json!({})).unwrap();
    let path = crate::services::mobile_control::headless::session_file(state.path(), "p");
    let tab = |key: &str| serde_json::from_value(json!({"key":key,"label":key,"cmd":"claude",
        "cwd":state.path().to_string_lossy(),"kind":"agent","unknownFutureField":{"keep":true}})).unwrap();
    let mine = workspace::create_tab_in(&path, "p", tab("mine"), None).unwrap().tab;
    let other = workspace::create_tab_in(&path, "p", tab("other"), None).unwrap().tab;
    let mut spawn = opts("claude", &[], Some("p"));
    spawn.id = "p:mine".into();
    spawn.tmux_session = workspace::tmux_of(&mine).map(str::to_string);
    let runtime = Runtime { port: 4321, serves_root: true, serves_markup: true, serves_web: true };
    let store = TokenStore::default();
    grant_cockpit(&mut spawn, &runtime, &store, state.path(), &[]);
    let token = spawn.env[COCKPIT_TOKEN_ENV].clone();
    let session = store.authenticate(Some(&format!("Bearer {token}"))).unwrap();
    assert!(spawn.args.join(" ").contains("/mcp/cockpit"));
    let request = |args: Value| json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
        "params":{"name":"tab_rename","arguments":args}});
    let call = |args| cockpit::handle_message(&session, &request(args)).unwrap()["result"]["structuredContent"].clone();
    let before = workspace::snapshot_in(&path).unwrap();
    assert_eq!(call(json!({"label":"Foreign", "tabId":workspace::tab_id(&other)}))["category"], "invalid_label");
    assert_eq!(call(json!({"label":"Foreign", "projectId":"other"}))["category"], "invalid_label");
    assert_eq!(call(json!({"label":"Task", "expectedLabel":"stale"}))["category"], "conflict");
    for label in ["", " ", "bad\u{001b}[31m", "bad\u{202e}", "bad\u{200b}"] {
        assert_eq!(call(json!({"label":label}))["category"], "invalid_label");
    }
    assert_eq!(call(json!({"label":"  Aufgabe 日本語  ","expectedLabel":"mine"})),
        json!({"status":"renamed","label":"Aufgabe 日本語"}));
    let renamed = workspace::snapshot_in(&path).unwrap();
    assert_eq!(renamed.version, before.version + 1);
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    assert_eq!(renamed.session.tab_layout[1].label, "other");
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    assert_eq!(renamed.session.tab_layout[0].extra["unknownFutureField"], json!({"keep":true}));
    assert_eq!(call(json!({"label":"Aufgabe 日本語"}))["status"], "unchanged");
    assert_eq!(workspace::snapshot_in(&path).unwrap().version, renamed.version);
    // A client with the old snapshot must adopt, rather than erase, the rename.
    let stale = workspace::sync_in(&path, "p", workspace::ClientSync {
        // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
        base_version: before.version, tabs: before.session.tab_layout, allow_clear: true, ..Default::default()
    }).unwrap();
    assert_eq!(stale.tabs[0].label, "Aufgabe 日本語");
    crate::storage::write_json(&state.path().join("settings.json"), &json!({"cockpit_mcp":false})).unwrap();
    assert_eq!(call(json!({"label":"Disabled"}))["category"], "unavailable");
    crate::storage::write_json(&state.path().join("settings.json"), &json!({})).unwrap();
    // Closing cannot be undone by a late call, including after a reopen.
    workspace::close_tab_in(&path, "p", workspace::tmux_of(&mine).unwrap(), 1).unwrap();
    assert_eq!(call(json!({"label":"Late"}))["category"], "tab_not_found");
    grant_cockpit(&mut spawn, &runtime, &store, state.path(), &[]);
    // Replace the lane directly to model a new successful spawn generation.
    store.register("replacement-cockpit-token".into(), session.identity.clone(), false);
    assert!(session.check().is_err());
    assert!(cockpit::handle_message(&session, &request(json!({"label":"Old generation"}))).unwrap().get("error").is_some());
}

#[test]
fn cockpit_grants_require_a_saved_tab_and_do_not_change_assistant_tools() {
    let state = tempfile::tempdir().unwrap();
    let runtime = Runtime { port: 4321, serves_root: true, serves_markup: true, serves_web: true };
    let store = TokenStore::default();
    let mut spawn = opts("codex", &[], Some("p"));
    grant_cockpit(&mut spawn, &runtime, &store, state.path(), &[]);
    assert!(!spawn.env.contains_key(COCKPIT_TOKEN_ENV));
    for caller in [Caller::Agent, Caller::Reader, Caller::LocalModel, Caller::Helper, Caller::Marker, Caller::Scheduler, Caller::Pusher, Caller::Web] {
        assert!(!security::tool("tab_rename").unwrap().serves(caller));
    }
    assert!(security::tool("tab_rename").unwrap().serves(Caller::Cockpit));
    for name in ["projects_list", "mail_read", "markup_ask", "web_fetch", crate::brand::HELP_TOOL_READ] {
        assert!(!security::tool(name).unwrap().serves(Caller::Cockpit));
    }
}

#[test]
fn cockpit_budget_counts_malformed_calls_and_storage_errors_are_opaque() {
    use crate::services::cockpit_mcp;
    let state = tempfile::tempdir().unwrap();
    crate::storage::write_json(&state.path().join("settings.json"), &json!({})).unwrap();
    let (_, mut session) = test_session(Caller::Cockpit);
    session.cockpit = Some(cockpit_mcp::Binding { state: state.path().into(), scope: "p".into(), id: "saved-id".into(), spawn: "s".into() });
    let call = |args| cockpit_mcp::handle_message(&session,
        &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tab_rename","arguments":args}})).unwrap();
    let path = crate::services::mobile_control::headless::session_file(state.path(), "p");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "corrupt existing state").unwrap();
    let reply = call(json!({"label":"Task"}));
    assert_eq!(reply["result"]["structuredContent"]["category"], "storage_error");
    assert!(!reply.to_string().contains(&*state.path().to_string_lossy()));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "corrupt existing state");
    for _ in 1..30 { assert_eq!(call(json!({}))["result"]["structuredContent"]["category"], "invalid_label"); }
    assert_eq!(call(json!({"label":"Task"}))["result"]["structuredContent"]["category"], "rate_limited");
}

/// A granted cockpit session over two saved agent tabs in scope `p`, driven
/// through the JSON-RPC handler like an agent's own client.
struct CockpitFixture {
    state: tempfile::TempDir,
    path: std::path::PathBuf,
    store: TokenStore,
    spawn: PtyOptions,
    runtime: Runtime,
    session: Session,
    mine: crate::schema::project::TabEntry,
}
impl CockpitFixture {
    fn new() -> Self {
        use crate::services::workspace;
        let state = tempfile::tempdir().unwrap();
        crate::storage::write_json(&state.path().join("settings.json"), &json!({})).unwrap();
        let path = crate::services::mobile_control::headless::session_file(state.path(), "p");
        let tab = |key: &str| serde_json::from_value(json!({"key":key,"label":key,"cmd":"claude",
            "cwd":state.path().to_string_lossy(),"kind":"agent","unknownFutureField":{"keep":true}})).unwrap();
        let mine = workspace::create_tab_in(&path, "p", tab("mine"), None).unwrap().tab;
        workspace::create_tab_in(&path, "p", tab("other"), None).unwrap();
        let mut spawn = opts("claude", &[], Some("p"));
        spawn.id = "p:mine".into();
        spawn.tmux_session = workspace::tmux_of(&mine).map(str::to_string);
        let runtime = Runtime { port: 4321, serves_root: true, serves_markup: true, serves_web: true };
        let store = TokenStore::default();
        grant_cockpit(&mut spawn, &runtime, &store, state.path(), &[]);
        let session = Self::session_of(&store, &spawn);
        Self { state, path, store, spawn, runtime, session, mine }
    }
    fn session_of(store: &TokenStore, spawn: &PtyOptions) -> Session {
        store.authenticate(Some(&format!("Bearer {}", spawn.env[COCKPIT_TOKEN_ENV]))).unwrap()
    }
    /// A new spawn of the same tab: a new token and generation nonce.
    fn respawn(&mut self) -> Session {
        grant_cockpit(&mut self.spawn, &self.runtime, &self.store, self.state.path(), &[]);
        Self::session_of(&self.store, &self.spawn)
    }
    fn reply_in(session: &Session, name: &str, args: Value) -> Value {
        crate::services::cockpit_mcp::handle_message(session,
            &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}})).unwrap()
    }
    fn reply(&self, name: &str, args: Value) -> Value { Self::reply_in(&self.session, name, args) }
    fn call(&self, name: &str, args: Value) -> Value { self.reply(name, args)["result"]["structuredContent"].clone() }
    fn stored(&self, index: usize) -> crate::schema::project::TabEntry {
        // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
        crate::services::workspace::snapshot_in(&self.path).unwrap().session.tab_layout[index].clone()
    }
    fn set_switch(&self, on: bool) {
        crate::storage::write_json(&self.state.path().join("settings.json"), &json!({"cockpit_mcp":on})).unwrap();
    }
}

#[test]
fn cockpit_metadata_tools_are_self_only_strict_and_conflict_checked() {
    use crate::services::cockpit_mcp as cockpit;
    let f = CockpitFixture::new();
    let listed = cockpit::handle_message(&f.session, &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
    let names: Vec<&str> = listed["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["tab_rename", "tab_get_info", "tab_set_activity", "tab_set_handoff", "tab_set_results",
        "tab_set_progress", "tab_set_blocker", "tab_set_verification", "tab_request_attention", "tab_add_milestone"]);
    for tool in listed["result"]["tools"].as_array().unwrap() {
        assert_eq!(tool["inputSchema"]["additionalProperties"], false, "{tool}");
    }
    // Own context only: the label, the revision and nothing about the other tab.
    let info = f.call("tab_get_info", json!({}));
    assert_eq!(info["status"], "ok");
    assert_eq!(info["label"], "mine");
    assert_eq!(info["revision"], 0);
    assert!(info["activity"].is_null() && info["handoff"].is_null());
    assert!(info["progress"].is_null() && info["blocker"].is_null() && info["verification"].is_null());
    assert_eq!(info["blockerExpired"], false);
    assert!(!info.to_string().contains("other"));
    assert!(!info.to_string().contains(&*f.state.path().to_string_lossy()));
    assert_eq!(f.call("tab_get_info", json!({"tabId":"x"}))["category"], "invalid_request");
    assert_eq!(f.call("tab_get_info", json!("nope"))["category"], "invalid_request");

    // Strict arguments.
    let long = "a".repeat(161);
    for bad in [
        json!({}), json!({"expectedRevision":0}), json!({"text":"x"}),
        json!({"expectedRevision":0,"text":"x","tabId":"other"}),
        json!({"expectedRevision":0,"text":"x","projectId":"other"}),
        json!({"expectedRevision":-1,"text":"x"}), json!({"expectedRevision":1.5,"text":"x"}),
        json!({"expectedRevision":"0","text":"x"}), json!({"expectedRevision":0,"text":7}),
        json!({"expectedRevision":0,"text":""}), json!({"expectedRevision":0,"text":"  "}),
        json!({"expectedRevision":0,"text":"two\nlines"}), json!({"expectedRevision":0,"text":"bidi\u{202e}"}),
        json!({"expectedRevision":0,"text":"zero\u{200b}width"}), json!({"expectedRevision":0,"text":long}),
    ] {
        assert_eq!(f.call("tab_set_activity", bad.clone())["category"], "invalid_request", "{bad}");
    }
    for bad in [
        json!({"expectedRevision":0}), json!({"expectedRevision":0,"handoff":"text"}),
        json!({"expectedRevision":0,"handoff":{}}), json!({"expectedRevision":0,"handoff":{"checks":"x"}}),
        json!({"expectedRevision":0,"handoff":{"summary":"s","extra":"x"}}),
        json!({"expectedRevision":0,"handoff":{"summary":7}}), json!({"expectedRevision":0,"handoff":{"summary":"s","checks":null}}),
        json!({"expectedRevision":0,"handoff":{"summary":"s\u{200b}"}}),
        json!({"expectedRevision":0,"handoff":{"summary":"x".repeat(1001)}}),
        json!({"expectedRevision":0,"handoff":{"summary":"x".repeat(1000),"checks":"y".repeat(1000),"remaining":"z".repeat(1000)},"tabId":"o"}),
    ] {
        assert_eq!(f.call("tab_set_handoff", bad.clone())["category"], "invalid_request", "{bad}");
    }
    assert_eq!(f.stored(0).extra.get("cockpitMeta"), None, "nothing was written by a refused call");
}

#[test]
fn cockpit_activity_and_handoff_update_unchange_conflict_and_clear() {
    // A fresh session: the strict-argument test above spends most of one minute's budget.
    let f = CockpitFixture::new();

    // Activity: updated, then unchanged, then a stale revision conflicts.
    let set = f.call("tab_set_activity", json!({"expectedRevision":0,"text":"  Prüfe 日本語 Layout  "}));
    assert_eq!((set["status"].as_str(), set["revision"].as_u64()), (Some("updated"), Some(1)));
    assert_eq!(set["activity"]["text"], "Prüfe 日本語 Layout");
    assert!(set["activity"]["setAt"].as_u64().unwrap() > 0, "host timestamp");
    let again = f.call("tab_set_activity", json!({"expectedRevision":1,"text":"Prüfe 日本語 Layout"}));
    assert_eq!((again["status"].as_str(), again["revision"].as_u64()), (Some("unchanged"), Some(1)));
    assert_eq!(f.call("tab_set_activity", json!({"expectedRevision":0,"text":"Stale"}))["category"], "conflict");
    let info = f.call("tab_get_info", json!({}));
    assert_eq!(info["activity"]["text"], "Prüfe 日本語 Layout");
    assert_eq!(info["activityExpired"], false);

    // Handoff: optional fields default empty; a clear.
    let h = f.call("tab_set_handoff", json!({"expectedRevision":1,"handoff":{"summary":"Done a\nand b","remaining":"UI check"}}));
    assert_eq!((h["status"].as_str(), h["revision"].as_u64()), (Some("updated"), Some(2)));
    assert_eq!(h["handoff"]["summary"], "Done a\nand b");
    assert_eq!(h["handoff"]["checks"], "");
    assert_eq!(f.call("tab_set_handoff", json!({"expectedRevision":2,"handoff":{"summary":"Done a\nand b","remaining":"UI check"}}))["status"], "unchanged");
    let cleared = f.call("tab_set_handoff", json!({"expectedRevision":2,"handoff":null}));
    assert_eq!((cleared["status"].as_str(), cleared["revision"].as_u64()), (Some("updated"), Some(3)));
    assert!(cleared["handoff"].is_null());
    assert_eq!(f.call("tab_set_activity", json!({"expectedRevision":3,"text":null}))["activity"], Value::Null);

    // The other tab and unrelated fields are untouched; the key is versioned.
    let (mine, other) = (f.stored(0), f.stored(1));
    assert_eq!(other.label, "other");
    assert!(!other.extra.contains_key("cockpitMeta"));
    assert_eq!(mine.extra["unknownFutureField"], json!({"keep":true}));
    assert_eq!(mine.extra["cockpitMeta"]["v"], 1);
    assert_eq!(mine.extra["cockpitMeta"]["revision"], 4);
    assert_eq!(f.call("tab_rename", json!({"label":"Renamed"}))["status"], "renamed", "tab_rename keeps working");
    assert_eq!(f.stored(0).extra["cockpitMeta"]["revision"], 4, "a rename does not touch the metadata revision");
}

/// After a `/clear`, the next conversation may rename a tab only while the
/// label is the one an agent gave it: `labelByAgent` tells it apart from the
/// CLI's name and from a name the user typed.
#[test]
fn cockpit_label_by_agent_marks_the_agents_own_title() {
    use crate::services::workspace;
    let mut f = CockpitFixture::new();
    assert_eq!(f.call("tab_get_info", json!({}))["labelByAgent"], false, "the CLI's own label");
    assert_eq!(f.call("tab_rename", json!({"label":"Fix tab names","expectedLabel":"mine"}))["status"], "renamed");
    assert_eq!(f.call("tab_get_info", json!({}))["labelByAgent"], true);
    assert_eq!(f.stored(0).extra["cockpitMeta"]["revision"], 0, "the note takes no revision");
    // A later spawn (the conversation after a /clear) still sees it as the agent's.
    let next = f.respawn();
    assert_eq!(CockpitFixture::reply_in(&next, "tab_get_info", json!({}))["result"]["structuredContent"]["labelByAgent"], true);
    // The user renames the tab (desktop or phone): it is theirs from then on.
    workspace::rename_tab_in(&f.path, "p", workspace::tmux_of(&f.mine).unwrap(), "My name").unwrap();
    assert_eq!(CockpitFixture::reply_in(&next, "tab_get_info", json!({}))["result"]["structuredContent"]["labelByAgent"], false);
}

#[test]
fn cockpit_activity_expires_on_read_and_republishing_renews_it() {
    use crate::services::{cockpit_meta, workspace};
    let f = CockpitFixture::new();
    let spawn = f.session.cockpit.as_ref().unwrap().spawn.clone();
    let id = workspace::tab_id(&f.mine).unwrap().to_string();
    let plant = |set_at: u64, owner: &str| {
        workspace::edit_in(&f.path, "p", |session| {
            // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
            let tab = session.tab_layout.iter_mut().find(|t| workspace::tab_id(t) == Some(id.as_str())).unwrap();
            tab.extra.insert(cockpit_meta::KEY.into(), json!({"v":1,"revision":7,
                "activity":{"text":"Old line","setAt":set_at,"spawn":owner}}));
            Ok(())
        }).unwrap();
    };
    let now = crate::clock::now_ms();
    plant(now - cockpit_meta::ACTIVITY_TTL_MS - 1_000, &spawn);
    let info = f.call("tab_get_info", json!({}));
    assert!(info["activity"].is_null());
    assert_eq!(info["activityExpired"], true, "the agent is told it expired");
    // The same text, published again, is a change with a new stamp.
    let again = f.call("tab_set_activity", json!({"expectedRevision":7,"text":"Old line"}));
    assert_eq!(again["status"], "updated");
    assert!(again["activity"]["setAt"].as_u64().unwrap() >= now);
    // Another spawn's line is never shown to this one.
    plant(now, "someone-else");
    let info = f.call("tab_get_info", json!({}));
    assert!(info["activity"].is_null());
    assert_eq!(info["activityExpired"], false);
}

#[test]
fn cockpit_grant_clears_activity_an_older_spawn_published() {
    let mut f = CockpitFixture::new();
    assert_eq!(f.call("tab_set_handoff", json!({"expectedRevision":0,"handoff":{"summary":"kept"}}))["status"], "updated");
    assert_eq!(f.call("tab_set_activity", json!({"expectedRevision":1,"text":"Old spawn work"}))["status"], "updated");
    let version = crate::services::workspace::snapshot_in(&f.path).unwrap().version;
    let old = f.session.clone();
    let fresh = f.respawn();
    assert!(old.check().is_err(), "the earlier token is gone");
    assert_ne!(old.cockpit.as_ref().unwrap().spawn, fresh.cockpit.as_ref().unwrap().spawn, "a new nonce per grant");
    let meta = f.stored(0).extra["cockpitMeta"].clone();
    assert!(meta.get("activity").is_none(), "{meta}");
    assert_eq!(meta["handoff"]["summary"], "kept", "the historical handoff stays");
    assert_eq!(meta["revision"], 3);
    assert_eq!(crate::services::workspace::snapshot_in(&f.path).unwrap().version, version + 1, "one write");
    // Another grant with nothing to clear writes nothing.
    f.respawn();
    assert_eq!(crate::services::workspace::snapshot_in(&f.path).unwrap().version, version + 1);
    // The revoked session is refused; the new one starts from the stored revision.
    assert!(CockpitFixture::reply_in(&old, "tab_get_info", json!({})).get("error").is_some());
    let session = CockpitFixture::session_of(&f.store, &f.spawn);
    let info = CockpitFixture::reply_in(&session, "tab_get_info", json!({}))["result"]["structuredContent"].clone();
    assert_eq!(info["revision"], 3);
    assert_eq!(CockpitFixture::reply_in(&session, "tab_set_activity", json!({"expectedRevision":3,"text":"New spawn"}))
        ["result"]["structuredContent"]["status"], "updated");
}

impl CockpitFixture {
    /// Register scope `p` as a project whose folder is `<state>/proj`, with `extra` on its record.
    fn project(&self, extra: Value) -> std::path::PathBuf {
        let dir = self.state.path().join("proj");
        std::fs::create_dir_all(dir.join("out")).unwrap();
        let mut record = json!({"id":"p","name":"p","status":"inactive","position":0,"local_file":"","directory":dir.to_string_lossy()});
        for (key, value) in extra.as_object().cloned().unwrap_or_default() { record[key] = value; }
        crate::storage::write_json(&self.state.path().join("projects.json"), &json!([record])).unwrap();
        dir
    }
    fn stored_results(&self) -> Value {
        self.stored(0).extra.get("cockpitMeta").map_or(Value::Null, |m| m["results"].clone())
    }
}

#[test]
fn cockpit_results_are_strict_bounded_and_refuse_bad_paths_without_writing() {
    let f = CockpitFixture::new();
    f.project(json!({}));
    let one = |label: &str, path: &str| json!({"label":label,"relativePath":path});
    // The argument shape.
    for bad in [
        json!({}), json!({"expectedRevision":0}), json!({"results":[]}),
        json!({"expectedRevision":0,"results":null}), json!({"expectedRevision":0,"results":"a.png"}),
        json!({"expectedRevision":0,"results":{}}), json!({"expectedRevision":"0","results":[]}),
        json!({"expectedRevision":0,"results":[],"tabId":"other"}), json!({"expectedRevision":0,"results":[],"projectDir":"/"}),
    ] {
        assert_eq!(f.call("tab_set_results", bad.clone())["category"], "invalid_request", "{bad}");
    }
    assert_eq!(f.stored(0).extra.get("cockpitMeta"), None);
    // The items (a fresh session: the budget is 30 calls a minute): bounds, shape
    // and every path form the plan rules out.
    let f = CockpitFixture::new();
    f.project(json!({}));
    let call = |results: Value| f.call("tab_set_results", json!({"expectedRevision":0,"results":results}));
    let nine: Vec<Value> = (0..9).map(|i| one("L", &format!("f{i}.png"))).collect();
    let absolute = f.state.path().join("proj").join("out").join("plot.png").to_string_lossy().into_owned();
    for bad in [
        json!(nine), json!([one(&"x".repeat(121), "a.png")]), json!([one("L", &"a".repeat(513))]), json!([one("", "a.png")]),
        json!([{"label":"L"}]), json!([{"label":"L","relativePath":"a","extra":1}]), json!(["a.png"]), json!([[]]),
        json!([one("L", "../a.png")]), json!([one("L", "out/../../a.png")]), json!([one("L", &absolute)]),
        json!([one("L", "/etc/passwd")]), json!([one("L", "C:\\Windows\\win.ini")]), json!([one("L", "C:/x")]),
        json!([one("L", "\\\\host\\share\\x")]), json!([one("L", "//host/share/x")]), json!([one("L", "out\\plot.png")]),
        json!([one("L", "file:///etc/passwd")]), json!([one("L", "https://example.com/a.png")]), json!([one("L", "javascript:alert(1)")]),
        json!([one("L", "out/")]), json!([one("L", "a\u{202e}b.png")]), json!([one("L", "a\nb.png")]),
        json!([one("Plot\u{202e}", "a.png")]), json!([one("two\nlines", "a.png")]),
        json!([one("ok", "a.png"), one("bad", "../x")]),
    ] {
        assert_eq!(call(bad.clone())["category"], "invalid_request", "{bad}");
    }
    assert_eq!(f.stored_results(), Value::Null, "a refused call writes nothing");
    assert_eq!(f.stored(0).extra.get("cockpitMeta"), None);
}

#[test]
fn cockpit_results_publish_accept_missing_targets_and_report_through_get_info() {
    let f = CockpitFixture::new();
    let dir = f.project(json!({}));
    std::fs::write(dir.join("out").join("plot.png"), "png").unwrap();
    // 8 items of 120-character labels and 512-character paths are the bound.
    let wide: Vec<Value> = (0..8).map(|i| json!({"label":"日".repeat(120),"relativePath":format!("{}{i}", "d".repeat(500))})).collect();
    let set = f.call("tab_set_results", json!({"expectedRevision":0,"results":wide}));
    assert_eq!((set["status"].as_str(), set["revision"].as_u64()), (Some("updated"), Some(1)), "{set}");
    assert_eq!(f.call("tab_set_results", json!({"expectedRevision":1,"results":[]}))["results"], Value::Null);

    let list = json!([{"label":"  Plot  ","relativePath":"out/plot.png"},{"label":"Not yet made","relativePath":"out/later.png"},{"label":"Deep","relativePath":"nothing/here/yet.csv"}]);
    let set = f.call("tab_set_results", json!({"expectedRevision":2,"results":list}));
    assert_eq!((set["status"].as_str(), set["revision"].as_u64()), (Some("updated"), Some(3)), "{set}");
    assert_eq!(set["results"]["items"][0], json!({"label":"Plot","relativePath":"out/plot.png"}));
    assert_eq!(set["results"]["items"].as_array().unwrap().len(), 3, "a missing target is accepted");
    assert!(set["results"]["setAt"].as_u64().unwrap() > 0, "host timestamp");
    // The same list again: unchanged, the revision does not move; a stale revision conflicts.
    let again = f.call("tab_set_results", json!({"expectedRevision":3,"results":[{"label":"Plot","relativePath":"out/plot.png"},{"label":"Not yet made","relativePath":"out/later.png"},{"label":"Deep","relativePath":"nothing/here/yet.csv"}]}));
    assert_eq!((again["status"].as_str(), again["revision"].as_u64()), (Some("unchanged"), Some(3)));
    assert_eq!(f.call("tab_set_results", json!({"expectedRevision":2,"results":[]}))["category"], "conflict");
    // Nothing was created: publishing reads, previews and generates nothing.
    assert!(!dir.join("out").join("later.png").exists());
    assert!(!dir.join("nothing").exists());
    // The agent reads its own list back.
    let info = f.call("tab_get_info", json!({}));
    assert_eq!(info["results"]["items"].as_array().unwrap().len(), 3);
    assert!(info["results"]["ageSeconds"].as_u64().is_some());
    assert!(!info.to_string().contains(&*f.state.path().to_string_lossy()), "no storage paths");
    // The other tab and the other notes are untouched; a clear leaves the key.
    assert!(!f.stored(1).extra.contains_key("cockpitMeta"));
    let cleared = f.call("tab_set_results", json!({"expectedRevision":3,"results":[]}));
    assert_eq!((cleared["status"].as_str(), cleared["revision"].as_u64()), (Some("updated"), Some(4)));
    assert!(f.call("tab_get_info", json!({}))["results"].is_null());
    assert_eq!(f.call("tab_set_results", json!({"expectedRevision":4,"results":[]}))["status"], "unchanged");
    // A committed update tells the views, an unchanged call does not.
    let updated = f.reply("tab_set_results", json!({"expectedRevision":4,"results":[{"label":"A","relativePath":"a.md"}]}));
    assert!(crate::services::cockpit_mcp::refresh_patch(&f.session, &updated).is_some());
    let same = f.reply("tab_set_results", json!({"expectedRevision":5,"results":[{"label":"A","relativePath":"a.md"}]}));
    assert!(crate::services::cockpit_mcp::refresh_patch(&f.session, &same).is_none());
}

#[cfg(unix)]
#[test]
fn cockpit_results_refuse_a_link_out_of_the_project_and_the_switch_is_rechecked() {
    use std::os::unix::fs::symlink;
    let f = CockpitFixture::new();
    let dir = f.project(json!({}));
    let outside = f.state.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "s").unwrap();
    symlink(outside.join("secret.txt"), dir.join("leak.txt")).unwrap();
    symlink(&outside, dir.join("leakdir")).unwrap();
    symlink(dir.join("out"), dir.join("finedir")).unwrap();
    std::fs::write(dir.join("out").join("ok.txt"), "ok").unwrap();
    let call = |path: &str| f.call("tab_set_results", json!({"expectedRevision":0,"results":[{"label":"L","relativePath":path}]}));
    for escaping in ["leak.txt", "leakdir/secret.txt", "leakdir/not-yet.txt", "leakdir/new/deeper.txt"] {
        assert_eq!(call(escaping)["category"], "invalid_request", "{escaping}");
    }
    assert_eq!(f.stored_results(), Value::Null);
    assert_eq!(call("finedir/ok.txt")["status"], "updated", "a link that stays inside is fine");
    // Off: refused for a running tab.
    f.set_switch(false);
    assert_eq!(f.call("tab_set_results", json!({"expectedRevision":1,"results":[]}))["category"], "unavailable");
}

#[test]
fn cockpit_results_are_unavailable_outside_a_local_registered_project() {
    use crate::services::cockpit_mcp;
    let args = json!({"expectedRevision":0,"results":[{"label":"L","relativePath":"a.png"}]});
    // No registry at all, then a registry of other shapes.
    let f = CockpitFixture::new();
    assert_eq!(f.call("tab_set_results", args.clone())["category"], "unavailable");
    assert_eq!(f.call("tab_set_results", json!({"expectedRevision":0,"results":[]}))["category"], "unavailable", "even a clear");
    for (what, extra) in [
        ("remote", json!({"remote":{"host":"h.example","remote_path":"/srv/p"}})),
        ("remote-only", json!({"remote":{"host":"h.example","remote_path":"/srv/p","remote_only":true}})),
        ("worker-hosted", json!({"compute_hosts":[{"id":"w1","host":"gpu.example","remote_path":"/srv/p"}]})),
        ("vm", json!({"vm":{"name":"v"}})),
    ] {
        let g = CockpitFixture::new();
        g.project(extra);
        assert_eq!(g.call("tab_set_results", args.clone())["category"], "unavailable", "{what}");
        assert_eq!(g.stored_results(), Value::Null, "{what}");
    }
    // The root scope and a box scope, whatever the registry says.
    for scope in ["root", "box:b1"] {
        let f = CockpitFixture::new();
        f.project(json!({}));
        let (_, mut session) = test_session(Caller::Cockpit);
        session.cockpit = Some(cockpit_mcp::Binding { state: f.state.path().into(), scope: scope.into(), id: "saved-id".into(), spawn: "s".into() });
        let reply = CockpitFixture::reply_in(&session, "tab_set_results", args.clone());
        assert_eq!(reply["result"]["structuredContent"]["category"], "unavailable", "{scope}");
        assert_eq!(cockpit_mcp::refusal_reason(&reply), Some("unavailable"));
    }
}

#[test]
fn cockpit_metadata_calls_honour_the_switch_the_budget_closed_tabs_and_corrupt_state() {
    use crate::services::{cockpit_mcp as cockpit, workspace};
    let f = CockpitFixture::new();
    // The switch is read for every call, writes and reads alike.
    f.set_switch(false);
    for (name, args) in [("tab_get_info", json!({})), ("tab_set_activity", json!({"expectedRevision":0,"text":"x"})),
        ("tab_set_handoff", json!({"expectedRevision":0,"handoff":null}))] {
        assert_eq!(f.call(name, args)["category"], "unavailable", "{name}");
    }
    f.set_switch(true);
    assert_eq!(f.call("tab_get_info", json!({}))["status"], "ok");

    // A refresh hint follows any committed change, and only those.
    let patch = |reply: &Value| cockpit::refresh_patch(&f.session, reply);
    let updated = f.reply("tab_set_activity", json!({"expectedRevision":0,"text":"x"}));
    let (scope, version) = patch(&updated).expect("an update tells the views");
    assert_eq!(scope, "p");
    assert_eq!(version, workspace::snapshot_in(&f.path).unwrap().version);
    assert!(patch(&f.reply("tab_set_activity", json!({"expectedRevision":1,"text":"x"}))).is_none(), "unchanged");
    assert!(patch(&f.reply("tab_get_info", json!({}))).is_none());
    assert!(patch(&f.reply("tab_set_activity", json!({"expectedRevision":0,"text":"y"}))).is_none(), "conflict");
    // Refusals are fixed categories, never text.
    for category in ["invalid_request", "too_large", "conflict", "unavailable", "storage_error", "rate_limited", "tab_not_found"] {
        assert_eq!(cockpit::refusal_reason(&json!({"result":{"structuredContent":{"category":category}}})), Some(category));
    }

    // The policy knows every tool by name (the audit would say "protocol"), serves the cockpit
    // lane only, and marks the read as a read.
    for name in ["tab_get_info", "tab_set_activity", "tab_set_handoff", "tab_set_results", "tab_set_progress", "tab_set_blocker", "tab_set_verification",
        "tab_request_attention", "tab_add_milestone"] {
        let policy = security::tool(name).unwrap();
        assert!(policy.serves(Caller::Cockpit), "{name}");
        assert_eq!(policy.write, name != "tab_get_info", "{name}");
        for caller in [Caller::Agent, Caller::Reader, Caller::LocalModel, Caller::Helper, Caller::Marker, Caller::Scheduler, Caller::Pusher, Caller::Web] {
            assert!(!policy.serves(caller), "{name} {caller:?}");
        }
    }

    // One budget for every tool, reads and malformed calls included: 30 a minute.
    // (Four calls were charged above and in the checks before.)
    let mut used = 0;
    while f.call("tab_get_info", json!({}))["category"] != "rate_limited" { used += 1; assert!(used <= 30); }
    assert_eq!(f.call("tab_set_activity", json!({"expectedRevision":1,"text":"z"}))["category"], "rate_limited");
    assert_eq!(f.call("tab_rename", json!({"label":"L"}))["category"], "rate_limited");

    // A closed tab is never recreated by a late call; corrupt state fails opaquely, unwritten.
    let g = CockpitFixture::new();
    workspace::close_tab_in(&g.path, "p", workspace::tmux_of(&g.mine).unwrap(), 1).unwrap();
    let version = workspace::snapshot_in(&g.path).unwrap().version;
    for (name, args) in [("tab_get_info", json!({})), ("tab_set_activity", json!({"expectedRevision":0,"text":"late"})),
        ("tab_set_handoff", json!({"expectedRevision":0,"handoff":{"summary":"late"}}))] {
        assert_eq!(g.call(name, args)["category"], "tab_not_found", "{name}");
    }
    let after = workspace::snapshot_in(&g.path).unwrap();
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    assert_eq!((after.version, after.session.tab_layout.len()), (version, 1));
    let h = CockpitFixture::new();
    std::fs::write(&h.path, "corrupt existing state").unwrap();
    for (name, args) in [("tab_get_info", json!({})), ("tab_set_activity", json!({"expectedRevision":0,"text":"x"})),
        ("tab_set_handoff", json!({"expectedRevision":0,"handoff":null}))] {
        let reply = h.reply(name, args);
        assert_eq!(reply["result"]["structuredContent"]["category"], "storage_error", "{name}");
        assert!(!reply.to_string().contains(&*h.state.path().to_string_lossy()));
    }
    assert_eq!(std::fs::read_to_string(&h.path).unwrap(), "corrupt existing state");
}

fn step(id: &str, label: &str, state: &str) -> Value { json!({"id":id,"label":label,"state":state}) }

#[test]
fn cockpit_progress_blocker_and_verification_are_strict_and_bounded_and_write_nothing_when_refused() {
    let f = CockpitFixture::new();
    // The argument shape, for each tool.
    for (tool, field, empty) in [("tab_set_progress", "steps", json!([])), ("tab_set_verification", "entries", json!([]))] {
        for bad in [
            json!({}), json!({"expectedRevision":0}), json!({field:empty}), json!({"expectedRevision":0,field:null}),
            json!({"expectedRevision":0,field:"x"}), json!({"expectedRevision":0,field:{}}), json!({"expectedRevision":"0",field:empty}),
            json!({"expectedRevision":-1,field:empty}), json!({"expectedRevision":0,field:empty,"tabId":"other"}),
            json!({"expectedRevision":0,field:empty,"projectId":"p"}),
        ] {
            assert_eq!(f.call(tool, bad.clone())["category"], "invalid_request", "{tool} {bad}");
        }
    }
    // (A fresh session each time: the budget is 30 calls a minute.)
    let f = CockpitFixture::new();
    for bad in [
        json!({}), json!({"expectedRevision":0}), json!({"text":"x"}), json!({"expectedRevision":0,"text":"x","tabId":"o"}),
        json!({"expectedRevision":0,"text":7}), json!({"expectedRevision":0,"text":""}), json!({"expectedRevision":0,"text":" "}),
        json!({"expectedRevision":0,"text":"two\nlines"}), json!({"expectedRevision":0,"text":"a\rb"}),
        json!({"expectedRevision":0,"text":"bidi\u{202e}"}), json!({"expectedRevision":0,"text":"zero\u{200b}w"}),
        json!({"expectedRevision":0,"text":"a".repeat(301)}),
    ] {
        assert_eq!(f.call("tab_set_blocker", bad.clone())["category"], "invalid_request", "{bad}");
    }
    let f = CockpitFixture::new();
    let progress = |steps: Value| f.call("tab_set_progress", json!({"expectedRevision":0,"steps":steps}));
    let nine: Vec<Value> = (0..9).map(|i| step(&format!("s{i}"), "L", "pending")).collect();
    for bad in [
        json!(nine), json!([step("", "L", "done")]), json!([step(&"a".repeat(41), "L", "done")]), json!([step("Upper", "L", "done")]),
        json!([step("has space", "L", "done")]), json!([step("a.b", "L", "done")]), json!([step("日本", "L", "done")]),
        json!([step("a", "L", "done"), step("a", "M", "done")]), json!([step("a", "", "done")]), json!([step("a", &"x".repeat(121), "done")]),
        json!([step("a", "two\nlines", "done")]), json!([step("a", "bidi\u{202e}", "done")]),
        json!([step("a", "L", "running")]), json!([step("a", "L", "Done")]), json!([step("a", "L", "")]),
        json!([step("a", "L", "active"), step("b", "L", "active")]),
        json!([{"id":"a","label":"L"}]), json!([{"id":"a","label":"L","state":"done","extra":1}]), json!(["a"]), json!([null]),
    ] {
        assert_eq!(progress(bad.clone())["category"], "invalid_request", "{bad}");
    }
    assert_eq!(f.stored(0).extra.get("cockpitMeta"), None, "nothing was written by a refused progress call");
    let f = CockpitFixture::new();
    let verify = |entries: Value| f.call("tab_set_verification", json!({"expectedRevision":0,"entries":entries}));
    let entry = |label: &str, outcome: &str| json!({"label":label,"outcome":outcome});
    let nine: Vec<Value> = (0..9).map(|i| entry(&format!("L{i}"), "passed")).collect();
    for bad in [
        json!(nine), json!([entry("", "passed")]), json!([entry(&"x".repeat(121), "passed")]), json!([entry("two\nlines", "passed")]),
        json!([entry("L", "verified")]), json!([entry("L", "Passed")]), json!([entry("L", "not run")]), json!([entry("L", "")]),
        json!([{"label":"L"}]), json!([{"outcome":"passed"}]), json!([{"label":"L","outcome":"passed","at":1}]),
        json!([{"label":"L","outcome":"passed","note":null}]), json!([{"label":"L","outcome":"passed","note":"x".repeat(301)}]),
        json!([{"label":"L","outcome":"passed","note":"a\u{1b}b"}]), json!([{"label":"L","outcome":"passed","note":7}]),
    ] {
        assert_eq!(verify(bad.clone())["category"], "invalid_request", "{bad}");
    }
    assert_eq!(f.stored(0).extra.get("cockpitMeta"), None, "nothing was written by a refused call");
}

#[test]
fn cockpit_progress_blocker_and_verification_update_unchange_conflict_clear_and_read_back() {
    let f = CockpitFixture::new();
    let steps = json!([step("plan", "  Plan the change  ", "done"), step("code", "Write 日本語 code", "active"), step("ship", "Ship", "pending")]);
    let set = f.call("tab_set_progress", json!({"expectedRevision":0,"steps":steps}));
    assert_eq!((set["status"].as_str(), set["revision"].as_u64()), (Some("updated"), Some(1)), "{set}");
    assert_eq!(set["progress"]["steps"][0], json!({"id":"plan","label":"Plan the change","state":"done"}));
    assert!(set["progress"]["setAt"].as_u64().unwrap() > 0, "host timestamp");
    let again = f.call("tab_set_progress", json!({"expectedRevision":1,"steps":[step("plan", "Plan the change", "done"), step("code", "Write 日本語 code", "active"), step("ship", "Ship", "pending")]}));
    assert_eq!((again["status"].as_str(), again["revision"].as_u64()), (Some("unchanged"), Some(1)));
    assert_eq!(f.call("tab_set_progress", json!({"expectedRevision":0,"steps":[]}))["category"], "conflict");

    let blocked = f.call("tab_set_blocker", json!({"expectedRevision":1,"text":"  Waiting for the API key  "}));
    assert_eq!((blocked["status"].as_str(), blocked["revision"].as_u64()), (Some("updated"), Some(2)));
    assert_eq!(blocked["blocker"]["text"], "Waiting for the API key");
    assert_eq!(f.call("tab_set_blocker", json!({"expectedRevision":2,"text":"Waiting for the API key"}))["status"], "unchanged");

    let entries = json!([{"label":"Unit tests","outcome":"passed","note":"12 passed\nno failures"},{"label":"Live check","outcome":"not_run"}]);
    let reported = f.call("tab_set_verification", json!({"expectedRevision":2,"entries":entries}));
    assert_eq!((reported["status"].as_str(), reported["revision"].as_u64()), (Some("updated"), Some(3)));
    assert_eq!(reported["verification"]["entries"][0]["note"], "12 passed\nno failures");
    assert!(reported["verification"]["entries"][1].get("note").is_none());
    assert_eq!(f.call("tab_set_verification", json!({"expectedRevision":3,"entries":entries}))["status"], "unchanged");

    // The agent reads all three back: the progress with whether it still counts as running.
    let info = f.call("tab_get_info", json!({}));
    assert_eq!(info["progress"]["steps"].as_array().unwrap().len(), 3);
    assert_eq!(info["progress"]["current"], true);
    assert!(info["progress"]["ageSeconds"].as_u64().is_some());
    assert_eq!(info["blocker"]["text"], "Waiting for the API key");
    assert_eq!(info["blockerExpired"], false);
    assert_eq!(info["verification"]["entries"][0]["outcome"], "passed");
    assert!(!info.to_string().contains(&*f.state.path().to_string_lossy()), "no storage paths");
    assert!(!f.stored(1).extra.contains_key("cockpitMeta"), "the other tab is untouched");
    assert_eq!(f.stored(0).extra["unknownFutureField"], json!({"keep":true}));

    // A committed update tells the views; an unchanged call does not.
    let updated = f.reply("tab_set_blocker", json!({"expectedRevision":3,"text":null}));
    assert_eq!(updated["result"]["structuredContent"]["status"], "updated");
    assert!(crate::services::cockpit_mcp::refresh_patch(&f.session, &updated).is_some());
    let same = f.reply("tab_set_blocker", json!({"expectedRevision":4,"text":null}));
    assert_eq!(same["result"]["structuredContent"]["status"], "unchanged");
    assert!(crate::services::cockpit_mcp::refresh_patch(&f.session, &same).is_none());
    // Clears.
    assert_eq!(f.call("tab_set_progress", json!({"expectedRevision":4,"steps":[]}))["progress"], Value::Null);
    assert_eq!(f.call("tab_set_verification", json!({"expectedRevision":5,"entries":[]}))["verification"], Value::Null);
    let info = f.call("tab_get_info", json!({}));
    assert!(info["progress"].is_null() && info["blocker"].is_null() && info["verification"].is_null());
    assert_eq!(f.stored(0).extra["cockpitMeta"], json!({"v":1,"revision":6}));
}

#[test]
fn cockpit_blocker_expires_on_read_is_never_another_spawns_and_is_cleared_at_the_next_grant() {
    use crate::services::{cockpit_meta, workspace};
    let mut f = CockpitFixture::new();
    let spawn = f.session.cockpit.as_ref().unwrap().spawn.clone();
    let id = workspace::tab_id(&f.mine).unwrap().to_string();
    let plant = |meta: Value| {
        workspace::edit_in(&f.path, "p", |session| {
            // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
            let tab = session.tab_layout.iter_mut().find(|t| workspace::tab_id(t) == Some(id.as_str())).unwrap();
            tab.extra.insert(cockpit_meta::KEY.into(), meta.clone());
            Ok(())
        }).unwrap();
    };
    let now = crate::clock::now_ms();
    // Past 30 minutes: absent from the read, told as expired, and publishing the same text renews it.
    plant(json!({"v":1,"revision":7,"blocker":{"text":"Old blocker","setAt":now - cockpit_meta::ACTIVITY_TTL_MS - 1_000,"spawn":spawn},
        "progress":{"steps":[{"id":"a","label":"L","state":"active"}],"setAt":now - cockpit_meta::ACTIVITY_TTL_MS - 1_000,"spawn":spawn}}));
    let info = f.call("tab_get_info", json!({}));
    assert!(info["blocker"].is_null());
    assert_eq!(info["blockerExpired"], true);
    assert_eq!(info["progress"]["current"], false, "older than 30 minutes: history, not running");
    assert_eq!(info["progress"]["steps"][0]["state"], "active", "the steps themselves are kept");
    let again = f.call("tab_set_blocker", json!({"expectedRevision":7,"text":"Old blocker"}));
    assert_eq!(again["status"], "updated");
    let same_steps = f.call("tab_set_progress", json!({"expectedRevision":8,"steps":[step("a", "L", "active")]}));
    assert_eq!(same_steps["status"], "updated", "a stale report published again is running again");
    assert_eq!(f.call("tab_get_info", json!({}))["progress"]["current"], true);
    // Another spawn's blocker is never shown; its progress is history.
    plant(json!({"v":1,"revision":9,"blocker":{"text":"Theirs","setAt":now,"spawn":"someone-else"},
        "progress":{"steps":[{"id":"a","label":"L","state":"active"}],"setAt":now,"spawn":"someone-else"}}));
    let info = f.call("tab_get_info", json!({}));
    assert!(info["blocker"].is_null());
    assert_eq!(info["blockerExpired"], false);
    assert_eq!(info["progress"]["current"], false, "an older spawn's report reads as history");

    // A new grant clears the blocker, ends the progress (kept as history) and leaves the verification.
    plant(json!({"v":1,"revision":10,"blocker":{"text":"Mine","setAt":now,"spawn":spawn},
        "progress":{"steps":[{"id":"a","label":"L","state":"active"}],"setAt":now,"spawn":spawn},
        "verification":{"entries":[{"label":"T","outcome":"passed"}],"setAt":now}}));
    let version = workspace::snapshot_in(&f.path).unwrap().version;
    let old = f.session.clone();
    let fresh = f.respawn();
    assert!(old.check().is_err());
    let stored = f.stored(0).extra["cockpitMeta"].clone();
    assert!(stored.get("blocker").is_none(), "{stored}");
    assert_eq!(stored["progress"]["ended"], true);
    assert_eq!(stored["progress"]["steps"][0]["id"], "a");
    assert_eq!(stored["verification"]["entries"][0]["label"], "T");
    assert_eq!(stored["revision"], 11);
    assert_eq!(workspace::snapshot_in(&f.path).unwrap().version, version + 1, "one write");
    let info = CockpitFixture::reply_in(&fresh, "tab_get_info", json!({}))["result"]["structuredContent"].clone();
    assert!(info["blocker"].is_null());
    assert_eq!(info["progress"]["current"], false, "the new spawn did not report it");
    assert_eq!(info["verification"]["entries"].as_array().unwrap().len(), 1);
}

#[test]
fn cockpit_reports_stay_inside_32_kib_and_honour_the_switch_the_budget_and_closed_tabs() {
    use crate::services::workspace;
    // The whole-object bound through the handler: multi-byte text at every bound.
    let f = CockpitFixture::new();
    f.project(json!({}));
    let wide = "日";
    let big_results: Vec<Value> = (0..8).map(|i| json!({"label":wide.repeat(120),"relativePath":format!("{}{i}", wide.repeat(500))})).collect();
    let note = |n: usize| wide.repeat(n);
    let reply = f.call("tab_set_results", json!({"expectedRevision":0,"results":big_results}));
    assert_eq!(reply["status"], "updated", "{reply}");
    let reply = f.call("tab_set_handoff", json!({"expectedRevision":1,"handoff":{"summary":note(1000),"checks":note(1000),"remaining":note(1000)}}));
    assert_eq!(reply["status"], "updated", "{reply}");
    let entries: Vec<Value> = (0..8).map(|i| json!({"label":format!("{}{i}", note(119)),"outcome":"passed","note":note(300)})).collect();
    let before = std::fs::read(&f.path).unwrap();
    let over = f.call("tab_set_verification", json!({"expectedRevision":2,"entries":entries}));
    assert_eq!(over["category"], "too_large", "{over}");
    assert_eq!(std::fs::read(&f.path).unwrap(), before, "refused before any mutation");
    // The same note ends smaller once the bulky older one is cleared.
    assert_eq!(f.call("tab_set_results", json!({"expectedRevision":2,"results":[]}))["status"], "updated");
    assert_eq!(f.call("tab_set_verification", json!({"expectedRevision":3,"entries":entries}))["status"], "updated");

    // Off: refused for all three, writes and the read alike.
    let g = CockpitFixture::new();
    g.set_switch(false);
    for (name, args) in [("tab_set_progress", json!({"expectedRevision":0,"steps":[]})), ("tab_set_blocker", json!({"expectedRevision":0,"text":null})),
        ("tab_set_verification", json!({"expectedRevision":0,"entries":[]}))] {
        assert_eq!(g.call(name, args)["category"], "unavailable", "{name}");
    }
    g.set_switch(true);
    // One shared budget: 30 a minute, charged for these tools too.
    let mut used = 0;
    while g.call("tab_set_blocker", json!({}))["category"] != "rate_limited" { used += 1; assert!(used <= 30); }
    assert_eq!(g.call("tab_set_progress", json!({"expectedRevision":0,"steps":[]}))["category"], "rate_limited");
    assert_eq!(g.call("tab_set_verification", json!({"expectedRevision":0,"entries":[]}))["category"], "rate_limited");

    // A closed tab is never recreated by a late call; corrupt state fails opaquely, unwritten.
    let h = CockpitFixture::new();
    workspace::close_tab_in(&h.path, "p", workspace::tmux_of(&h.mine).unwrap(), 1).unwrap();
    let version = workspace::snapshot_in(&h.path).unwrap().version;
    for (name, args) in [("tab_set_progress", json!({"expectedRevision":0,"steps":[step("a", "L", "active")]})),
        ("tab_set_blocker", json!({"expectedRevision":0,"text":"late"})),
        ("tab_set_verification", json!({"expectedRevision":0,"entries":[{"label":"L","outcome":"passed"}]}))] {
        assert_eq!(h.call(name, args)["category"], "tab_not_found", "{name}");
    }
    let after = workspace::snapshot_in(&h.path).unwrap();
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    assert_eq!((after.version, after.session.tab_layout.len()), (version, 1));
    let k = CockpitFixture::new();
    std::fs::write(&k.path, "corrupt existing state").unwrap();
    for (name, args) in [("tab_set_progress", json!({"expectedRevision":0,"steps":[]})), ("tab_set_blocker", json!({"expectedRevision":0,"text":"x"})),
        ("tab_set_verification", json!({"expectedRevision":0,"entries":[]}))] {
        let reply = k.reply(name, args);
        assert_eq!(reply["result"]["structuredContent"]["category"], "storage_error", "{name}");
        assert!(!reply.to_string().contains(&*k.state.path().to_string_lossy()));
    }
    assert_eq!(std::fs::read_to_string(&k.path).unwrap(), "corrupt existing state");
}

// ── Step 5: attention and milestones ────────────────────────────────────────

impl CockpitFixture {
    /// The stored `cockpitMeta` of the agent's tab.
    fn meta(&self) -> Value { self.stored(0).extra.get("cockpitMeta").cloned().unwrap_or(Value::Null) }
    /// Overwrite the agent's `cockpitMeta` as a stale or hostile record would be.
    fn plant(&self, meta: Value) {
        use crate::services::workspace;
        let id = workspace::tab_id(&self.mine).unwrap().to_string();
        workspace::edit_in(&self.path, "p", |session| {
            // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
            let tab = session.tab_layout.iter_mut().find(|t| workspace::tab_id(t) == Some(id.as_str())).unwrap();
            tab.extra.insert("cockpitMeta".into(), meta.clone());
            Ok(())
        }).unwrap();
    }
}

#[test]
fn cockpit_attention_and_milestone_arguments_are_strict_and_bounded_and_write_nothing_when_refused() {
    let f = CockpitFixture::new();
    for bad in [
        json!({}), json!({"expectedRevision":0}), json!({"question":"Q?"}), json!({"expectedRevision":0,"question":7}),
        json!({"expectedRevision":"0","question":"Q?"}), json!({"expectedRevision":-1,"question":"Q?"}),
        json!({"expectedRevision":0,"question":"Q?","options":["a","b"]}), json!({"expectedRevision":0,"question":"Q?","answer":"yes"}),
        json!({"expectedRevision":0,"question":"Q?","tabId":"other"}), json!({"expectedRevision":0,"question":""}),
        json!({"expectedRevision":0,"question":"  \n "}), json!({"expectedRevision":0,"question":"a".repeat(501)}),
        json!({"expectedRevision":0,"question":"bidi\u{202e}x"}), json!({"expectedRevision":0,"question":"zero\u{200b}w"}),
        json!({"expectedRevision":0,"question":"esc\u{1b}[31m"}), json!({"expectedRevision":0,"question":"tab\there"}),
    ] {
        assert_eq!(f.call("tab_request_attention", bad.clone())["category"], "invalid_request", "{bad}");
    }
    let f = CockpitFixture::new();
    for bad in [
        json!({}), json!({"requestId":"a"}), json!({"text":"x"}), json!({"requestId":"a","text":"x","expectedRevision":0}),
        json!({"requestId":"a","text":"x","extra":1}), json!({"requestId":"","text":"x"}), json!({"requestId":"has space","text":"x"}),
        json!({"requestId":"dot.id","text":"x"}), json!({"requestId":"日本","text":"x"}), json!({"requestId":"a".repeat(65),"text":"x"}),
        json!({"requestId":7,"text":"x"}), json!({"requestId":"a","text":7}), json!({"requestId":"a","text":null}),
        json!({"requestId":"a","text":""}), json!({"requestId":"a","text":" "}), json!({"requestId":"a","text":"two\nlines"}),
        json!({"requestId":"a","text":"x".repeat(201)}), json!({"requestId":"a","text":"bidi\u{202e}"}), json!({"requestId":"a","text":"zero\u{200b}w"}),
    ] {
        assert_eq!(f.call("tab_add_milestone", bad.clone())["category"], "invalid_request", "{bad}");
    }
    assert_eq!(f.stored(0).extra.get("cockpitMeta"), None, "nothing was written by a refused call");
    // The bounds themselves are fine, counted in characters.
    let ok_ask = f.call("tab_request_attention", json!({"expectedRevision":0,"question":"日".repeat(500)}));
    assert_eq!(ok_ask["status"], "updated", "{ok_ask}");
    let ok_ms = f.call("tab_add_milestone", json!({"requestId":"a".repeat(64),"text":"日".repeat(200)}));
    assert_eq!(ok_ms["status"], "updated", "{ok_ms}");
}

#[test]
fn cockpit_attention_mints_a_fresh_id_per_question_and_a_retry_never_resurfaces_a_dismissed_one() {
    use crate::services::{cockpit_meta, workspace};
    let f = CockpitFixture::new();
    let first = f.call("tab_request_attention", json!({"expectedRevision":0,"question":"  Which branch\nshould I use?  "}));
    assert_eq!((first["status"].as_str(), first["revision"].as_u64()), (Some("updated"), Some(1)), "{first}");
    let a1 = first["attention"].clone();
    assert_eq!(a1["question"], "Which branch\nshould I use?");
    assert_eq!(a1["dismissed"], false);
    assert!(a1["setAt"].as_u64().unwrap() > 0, "host timestamp");
    let id1 = a1["id"].as_str().unwrap().to_string();
    assert!(id1.len() >= 32 && id1.chars().all(|c| c.is_ascii_hexdigit()));
    // The same question while open: unchanged, same id, the revision does not move; a changed one is new.
    let same = f.call("tab_request_attention", json!({"expectedRevision":1,"question":"Which branch\nshould I use?"}));
    assert_eq!((same["status"].as_str(), same["revision"].as_u64()), (Some("unchanged"), Some(1)));
    assert_eq!(same["attention"]["id"], id1.as_str());
    let second = f.call("tab_request_attention", json!({"expectedRevision":1,"question":"Which branch, develop or main?"}));
    assert_eq!(second["status"], "updated");
    let id2 = second["attention"]["id"].as_str().unwrap().to_string();
    assert_ne!(id1, id2, "a changed question is a new item");
    assert_eq!(f.call("tab_request_attention", json!({"expectedRevision":1,"question":"x"}))["category"], "conflict");
    // The user dismisses it (the narrow command's body); the agent sees that on read.
    let tab_id = workspace::tab_id(&f.mine).unwrap().to_string();
    assert_eq!(cockpit_meta::dismiss_in(&f.path, "p", &tab_id, &id1).unwrap(), cockpit_meta::Dismissal::Stale, "the first id is gone");
    assert_eq!(cockpit_meta::dismiss_in(&f.path, "p", &tab_id, &id2).unwrap(), cockpit_meta::Dismissal::Dismissed);
    let info = f.call("tab_get_info", json!({}));
    assert_eq!(info["revision"], 3);
    assert_eq!(info["attention"]["dismissed"], true);
    // A retry of the identical question does nothing and does not tell the views.
    let retry = f.reply("tab_request_attention", json!({"expectedRevision":3,"question":"Which branch, develop or main?"}));
    let retried = &retry["result"]["structuredContent"];
    assert_eq!((retried["status"].as_str(), retried["revision"].as_u64()), (Some("unchanged"), Some(3)));
    assert_eq!(retried["attention"]["id"], id2.as_str());
    assert_eq!(retried["attention"]["dismissed"], true);
    assert_eq!(f.meta()["attention"]["dismissed"], true);
    assert!(crate::services::cockpit_mcp::refresh_patch(&f.session, &retry).is_none());
    // A different question is a new open item; a clear removes it, and clearing nothing is a no-op.
    let third = f.call("tab_request_attention", json!({"expectedRevision":3,"question":"Deploy to staging?"}));
    assert_eq!(third["attention"]["dismissed"], false);
    assert_ne!(third["attention"]["id"], id2.as_str());
    let cleared = f.call("tab_request_attention", json!({"expectedRevision":4,"question":null}));
    assert_eq!((cleared["status"].as_str(), cleared["attention"].is_null()), (Some("updated"), true));
    assert_eq!(f.call("tab_request_attention", json!({"expectedRevision":5,"question":null}))["status"], "unchanged");
    assert!(f.call("tab_get_info", json!({}))["attention"].is_null());
    // The other tab is untouched.
    assert!(!f.stored(1).extra.contains_key("cockpitMeta"));
    // A committed ask tells the views.
    let fresh = f.reply("tab_request_attention", json!({"expectedRevision":5,"question":"One more?"}));
    assert!(crate::services::cockpit_mcp::refresh_patch(&f.session, &fresh).is_some());
}

/// A failed random generator is never an all-zero nonce or id: no grant for the
/// spawn (as for an unbound tab), and a question is refused with nothing written.
#[test]
fn cockpit_fails_closed_when_the_random_generator_fails() {
    use crate::services::{cockpit_mcp as cockpit, workspace};
    let f = CockpitFixture::new();
    let version = workspace::snapshot_in(&f.path).unwrap().version;
    let ask = json!({"expectedRevision":0,"question":"Deploy now?"});
    let refused = cockpit::set_attention_with(&f.session, &ask, || None);
    assert_eq!(refused["category"], "storage_error", "{refused}");
    assert_eq!(f.stored(0).extra.get("cockpitMeta"), None, "nothing was written");
    assert_eq!(workspace::snapshot_in(&f.path).unwrap().version, version);
    // Clearing needs no id, so it does not depend on the generator.
    let cleared = cockpit::set_attention_with(&f.session, &json!({"expectedRevision":0,"question":null}), || None);
    assert_ne!(cleared["status"], "refused", "{cleared}");
    // A working generator asks as before, with the id it minted.
    let asked = cockpit::set_attention_with(&f.session, &ask, || Some("ab".repeat(16)));
    assert_eq!((asked["status"].as_str(), asked["attention"]["id"].as_str()), (Some("updated"), Some("ab".repeat(16).as_str())), "{asked}");
    // The spawn nonce: no nonce, no binding (and so no grant); a nonce binds.
    assert!(cockpit::binding_for_spawn_with(f.state.path(), &f.spawn, || None).is_none());
    let binding = cockpit::binding_for_spawn_with(f.state.path(), &f.spawn, || Some("n".repeat(32))).unwrap();
    assert_eq!(binding.spawn, "n".repeat(32));
}

#[test]
fn cockpit_attention_is_read_back_only_while_open_and_its_own_and_goes_with_the_spawn() {
    use crate::services::cockpit_meta;
    let mut f = CockpitFixture::new();
    let spawn = f.session.cockpit.as_ref().unwrap().spawn.clone();
    let now = crate::clock::now_ms();
    // Open: returned with its age. Past 24 hours: absent, told as expired, and the same text is asked again with a new id.
    f.plant(json!({"v":1,"revision":4,"attention":{"id":"old-id","question":"Lapsed?","setAt":now - cockpit_meta::ATTENTION_TTL_MS - 1_000,"spawn":spawn}}));
    let info = f.call("tab_get_info", json!({}));
    assert!(info["attention"].is_null());
    assert_eq!(info["attentionExpired"], true);
    let again = f.call("tab_request_attention", json!({"expectedRevision":4,"question":"Lapsed?"}));
    assert_eq!(again["status"], "updated");
    assert_ne!(again["attention"]["id"], "old-id");
    let info = f.call("tab_get_info", json!({}));
    assert_eq!(info["attention"]["question"], "Lapsed?");
    assert_eq!(info["attentionExpired"], false);
    assert!(info["attention"]["ageSeconds"].as_u64().is_some());
    // Another spawn's question is never shown to this one.
    f.plant(json!({"v":1,"revision":9,"attention":{"id":"theirs","question":"Theirs?","setAt":now,"spawn":"someone-else"}}));
    let info = f.call("tab_get_info", json!({}));
    assert!(info["attention"].is_null());
    assert_eq!(info["attentionExpired"], false);
    // A new grant removes the old spawn's question (one write) and leaves the history.
    f.plant(json!({"v":1,"revision":10,"attention":{"id":"mine","question":"Mine?","setAt":now,"spawn":spawn},
        "milestones":[{"requestId":"m1","text":"Done","at":now}],"handoff":{"summary":"S","checks":"","remaining":"","setAt":now}}));
    let old = f.session.clone();
    let fresh = f.respawn();
    assert!(old.check().is_err());
    let stored = f.meta();
    assert!(stored.get("attention").is_none(), "{stored}");
    assert_eq!(stored["milestones"][0]["requestId"], "m1");
    assert_eq!(stored["handoff"]["summary"], "S");
    assert_eq!(stored["revision"], 11);
    let info = CockpitFixture::reply_in(&fresh, "tab_get_info", json!({}))["result"]["structuredContent"].clone();
    assert!(info["attention"].is_null());
    assert_eq!(info["milestones"].as_array().unwrap().len(), 1);
}

#[test]
fn cockpit_milestones_dedup_by_request_id_cap_at_20_use_host_time_and_take_no_revision() {
    let f = CockpitFixture::new();
    let before = crate::clock::now_ms();
    let first = f.call("tab_add_milestone", json!({"requestId":"build-1","text":"  Build is green  "}));
    assert_eq!((first["status"].as_str(), first["revision"].as_u64()), (Some("updated"), Some(1)), "{first}");
    assert_eq!(first["milestone"]["text"], "Build is green");
    assert_eq!(first["milestone"]["requestId"], "build-1");
    let at = first["milestone"]["at"].as_u64().unwrap();
    assert!(at >= before, "the host stamped it");
    // A retry with the same id, whatever its text: unchanged, the existing entry comes back, nothing tells the views.
    let retry = f.reply("tab_add_milestone", json!({"requestId":"build-1","text":"Something else"}));
    let r = &retry["result"]["structuredContent"];
    assert_eq!((r["status"].as_str(), r["revision"].as_u64()), (Some("unchanged"), Some(1)));
    assert_eq!(r["milestone"], json!({"requestId":"build-1","text":"Build is green","at":at}));
    assert!(crate::services::cockpit_mcp::refresh_patch(&f.session, &retry).is_none());
    // A new one moves the revision (so the next setter must re-read) and tells the views.
    let next = f.reply("tab_add_milestone", json!({"requestId":"build-2","text":"Docs updated"}));
    assert_eq!(next["result"]["structuredContent"]["revision"], 2);
    assert!(crate::services::cockpit_mcp::refresh_patch(&f.session, &next).is_some());
    assert_eq!(f.call("tab_set_activity", json!({"expectedRevision":1,"text":"x"}))["category"], "conflict");
    // Up to 20 are kept, oldest dropped; the agent reads them back, oldest first.
    // (A fresh session: the budget is 30 calls a minute.)
    let g = CockpitFixture::new();
    for i in 1..=22 {
        let reply = g.call("tab_add_milestone", json!({"requestId":format!("m{i}"),"text":format!("Milestone {i}")}));
        assert_eq!(reply["status"], "updated", "{i}");
    }
    let info = g.call("tab_get_info", json!({}));
    let kept: Vec<&str> = info["milestones"].as_array().unwrap().iter().map(|m| m["requestId"].as_str().unwrap()).collect();
    assert_eq!(kept.len(), 20);
    assert_eq!((kept[0], kept[19]), ("m3", "m22"));
    assert_eq!(info["revision"], 22);
    assert!(g.meta()["milestones"].as_array().unwrap().iter().all(|m| m["at"].as_u64().unwrap() > 0));
    assert!(!info.to_string().contains(&*g.state.path().to_string_lossy()), "no storage paths");
    assert!(!g.stored(1).extra.contains_key("cockpitMeta"), "the other tab is untouched");
}

#[test]
fn cockpit_attention_and_milestones_honour_the_switch_the_budget_closed_tabs_and_corrupt_state() {
    use crate::services::workspace;
    let ask = || json!({"expectedRevision":0,"question":"Q?"});
    let ms = || json!({"requestId":"a","text":"T"});
    let f = CockpitFixture::new();
    f.set_switch(false);
    assert_eq!(f.call("tab_request_attention", ask())["category"], "unavailable");
    assert_eq!(f.call("tab_add_milestone", ms())["category"], "unavailable");
    f.set_switch(true);
    // One shared budget: 30 a minute, malformed calls included.
    let mut used = 0;
    while f.call("tab_add_milestone", json!({}))["category"] != "rate_limited" { used += 1; assert!(used <= 30); }
    assert_eq!(f.call("tab_request_attention", ask())["category"], "rate_limited");
    assert_eq!(f.call("tab_add_milestone", ms())["category"], "rate_limited");
    // A closed tab is never recreated by a late call.
    let g = CockpitFixture::new();
    workspace::close_tab_in(&g.path, "p", workspace::tmux_of(&g.mine).unwrap(), 1).unwrap();
    let version = workspace::snapshot_in(&g.path).unwrap().version;
    assert_eq!(g.call("tab_request_attention", ask())["category"], "tab_not_found");
    assert_eq!(g.call("tab_add_milestone", ms())["category"], "tab_not_found");
    let after = workspace::snapshot_in(&g.path).unwrap();
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    assert_eq!((after.version, after.session.tab_layout.len()), (version, 1));
    // Corrupt state fails opaquely, unwritten.
    let k = CockpitFixture::new();
    std::fs::write(&k.path, "corrupt existing state").unwrap();
    for (name, args) in [("tab_request_attention", ask()), ("tab_add_milestone", ms())] {
        let reply = k.reply(name, args);
        assert_eq!(reply["result"]["structuredContent"]["category"], "storage_error", "{name}");
        assert!(!reply.to_string().contains(&*k.state.path().to_string_lossy()));
    }
    assert_eq!(std::fs::read_to_string(&k.path).unwrap(), "corrupt existing state");
    // An unreadable attention or milestone list is the same: refused, no write.
    let h = CockpitFixture::new();
    h.plant(json!({"v":1,"revision":0,"attention":{"id":3},"milestones":"x"}));
    let bytes = std::fs::read(&h.path).unwrap();
    assert_eq!(h.call("tab_request_attention", ask())["category"], "storage_error");
    assert_eq!(h.call("tab_add_milestone", ms())["category"], "storage_error");
    assert_eq!(h.call("tab_get_info", json!({}))["category"], "storage_error");
    assert_eq!(std::fs::read(&h.path).unwrap(), bytes);
}

#[test]
fn cockpit_attention_and_milestones_are_in_the_tool_list_with_closed_schemas_and_the_policy() {
    use crate::services::cockpit_mcp as cockpit;
    let listed = cockpit::tools();
    let find = |name: &str| listed.as_array().unwrap().iter().find(|t| t["name"] == name).unwrap().clone();
    let attention = find("tab_request_attention");
    assert_eq!(attention["inputSchema"]["additionalProperties"], false);
    assert_eq!(attention["inputSchema"]["required"], json!(["expectedRevision", "question"]));
    assert!(attention["inputSchema"]["properties"].get("options").is_none(), "no answer payload");
    assert_eq!(attention["inputSchema"]["properties"]["question"]["maxLength"], 500);
    let milestone = find("tab_add_milestone");
    assert_eq!(milestone["inputSchema"]["required"], json!(["requestId", "text"]));
    assert!(milestone["inputSchema"]["properties"].get("expectedRevision").is_none());
    assert_eq!(milestone["inputSchema"]["properties"]["text"]["maxLength"], 200);
    for name in ["tab_request_attention", "tab_add_milestone"] {
        let policy = security::tool(name).unwrap();
        assert!(policy.write && policy.serves(Caller::Cockpit), "{name}");
        for caller in [Caller::Agent, Caller::Reader, Caller::LocalModel, Caller::Helper, Caller::Marker, Caller::Scheduler, Caller::Pusher, Caller::Web] {
            assert!(!policy.serves(caller), "{name} {caller:?}");
        }
    }
    // The attention notice cannot ask the app to answer or approve anything.
    let text = attention["description"].as_str().unwrap();
    assert!(text.contains("cannot carry options"), "{text}");
}

/// The switch and the revocation are checked again inside the workspace lock,
/// not only at the top of a call: a switch turned off (or a spawn replaced)
/// after a tool passed its early check cannot still commit.
#[test]
fn cockpit_switch_and_revocation_are_rechecked_inside_the_workspace_lock() {
    use crate::services::{cockpit_meta as meta, cockpit_mcp as cockpit, workspace};
    let f = CockpitFixture::new();
    let binding = f.session.cockpit.as_ref().unwrap().clone();
    let id = workspace::tab_id(&f.mine).unwrap().to_string();
    let change = meta::Change::Handoff(Some(meta::HandoffText { summary: "late".into(), checks: String::new(), remaining: String::new() }));
    // The early check passed; then the user switched the lane off.
    f.set_switch(false);
    let before = std::fs::read(&f.path).unwrap();
    let wrote = meta::update_in(&f.path, "p", &id, 0, 5, &change, cockpit::guard(&f.session, &binding));
    assert_eq!(wrote.unwrap_err(), "unavailable");
    assert!(meta::read_in(&f.path, &id, cockpit::guard(&f.session, &binding)).is_err(), "a read is rechecked too");
    assert_eq!(std::fs::read(&f.path).unwrap(), before, "nothing was written");
    // Switched back on: the same guard lets the write through ...
    f.set_switch(true);
    assert!(meta::update_in(&f.path, "p", &id, 0, 5, &change, cockpit::guard(&f.session, &binding)).is_ok());
    // ... until the spawn is replaced.
    f.store.register("replacement-cockpit-token".into(), f.session.identity.clone(), false);
    let again = meta::Change::Handoff(None);
    assert_eq!(meta::update_in(&f.path, "p", &id, 1, 6, &again, cockpit::guard(&f.session, &binding)).unwrap_err(), "unavailable");
}
