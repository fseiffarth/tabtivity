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

/// Gaps 25 and 33: a local tab's model is fixed at spawn from its env —
/// raw, else the alias mapped back through the chipped models, nothing
/// when the pair disagrees or the alias is ambiguous — and a new tab of a
/// model that read mail in another tab starts tainted.
#[test]
fn a_local_tab_records_its_model_and_starts_with_the_models_taint() {
    let raw = crate::app_env!("LOCAL_MODEL");
    let tagged = vec!["gemma4:e4b".to_string(), "qwen3:8b".to_string()];
    let vibe = |env: &[(&str, &str)]| {
        let mut o = opts("vibe", &[], None);
        for (k, v) in env {
            o.env.insert(k.to_string(), v.to_string());
        }
        o
    };
    let of = |env: &[(&str, &str)], models: &[String]| local_model_of(&vibe(env), models);
    assert_eq!(of(&[(raw, "gemma4:e4b"), ("VIBE_ACTIVE_MODEL", "gemma4-e4b")], &tagged).as_deref(), Some("gemma4:e4b"));
    assert_eq!(of(&[(raw, "llama3:latest")], &tagged).as_deref(), Some("llama3:latest"));
    assert_eq!(of(&[("VIBE_ACTIVE_MODEL", "gemma4-e4b")], &tagged).as_deref(), Some("gemma4:e4b"), "a restored tab: alias only");
    assert_eq!(of(&[(raw, "gemma4:e4b"), ("VIBE_ACTIVE_MODEL", "gpt-oss-120b-cloud")], &tagged), None, "the pair disagrees");
    assert_eq!(of(&[("VIBE_ACTIVE_MODEL", "llama3-latest")], &tagged), None, "an alias of no chipped model");
    let twins = vec!["a:b-c".to_string(), "a-b:c".to_string()];
    assert_eq!(of(&[("VIBE_ACTIVE_MODEL", "a-b-c")], &twins), None, "an alias two models share");
    assert_eq!(of(&[(raw, "  ")], &tagged), None);

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("settings.json"), json!({ "ollama_mcp_models": tagged, "root_mcp_agents": ["claude"] }).to_string()).unwrap();
    let trusted = Trusted::read(dir.path(), None);
    let store = TokenStore::default();
    let spawn = |tab: &str, env: &[(&str, &str)]| {
        let mut o = vibe(env);
        o.id = tab.to_string();
        grant_root(&mut o, &rt(), &store, &trusted);
        store.authenticate(Some(&format!("Bearer {}", o.env[TOKEN_ENV]))).unwrap()
    };
    let gemma = [(raw, "gemma4:e4b"), ("VIBE_ACTIVE_MODEL", "gemma4-e4b")];
    let first = spawn("root:model-a", &gemma);
    assert_eq!(first.identity.caller, Caller::LocalModel);
    assert_eq!(first.identity.model.as_deref(), Some("gemma4:e4b"));
    assert_eq!(first.identity.endpoint.as_deref(), Some("127.0.0.1:11434"));
    assert!(!first.has_read_mail());
    // Its first mail read, as `root_mcp_mail::call` records it.
    record_read_mail(dir.path(), "root:model-a", first.identity.model.as_deref()).unwrap();
    assert!(spawn("root:model-b", &gemma).has_read_mail(), "a new tab of that model");
    assert!(spawn("root:model-c", &[("VIBE_ACTIVE_MODEL", "gemma4-e4b")]).has_read_mail(), "alias only, same model");
    assert!(!spawn("root:model-d", &[(raw, "qwen3:8b")]).has_read_mail(), "another model is untouched");
    let mut cloud = opts("claude", &[], None);
    cloud.id = "root:model-e".into();
    grant_root(&mut cloud, &rt(), &store, &trusted);
    assert_eq!(store.authenticate(Some(&format!("Bearer {}", cloud.env[TOKEN_ENV]))).unwrap().identity.model, None, "a cloud agent has no model");
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
    crate::commands::ollama::test_tags::set(Some(tags));
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
    crate::commands::ollama::test_tags::set(None);
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
    let [delete, upsert] = changes.as_slice() else { panic!("two rows: {changes:?}") };
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
    let [change] = changes.as_slice() else { panic!("one row: {changes:?}") };
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
    let [delete, upsert] = changes.as_slice() else { panic!("two rows: {changes:?}") };
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
