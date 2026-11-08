use super::*;
use serde_json::json;
use std::collections::HashMap;

fn list(value: Value) -> ProjectsList {
    serde_json::from_value(value).unwrap()
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn opts(cmd: &str, args: &[&str], project: Option<&str>, cwd: &Path) -> PtyOptions {
    PtyOptions {
        login: None,
        assistant: None,
        id: "tab-1".to_string(),
        cmd: cmd.to_string(),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: HashMap::new(),
        cwd: s(cwd),
        cols: 80,
        rows: 24,
        local_only: false,
        sandbox: false,
        agent: true,
        project_id: project.map(str::to_string),
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

/// A registry with a locked project `lock` and an open one `open` below `root`.
fn registry(root: &Path, lock_extra: Value) -> ProjectsList {
    list(json!([
        { "id": "lock", "name": "Secret", "status": "active", "position": 0, "local_file": "",
          "directory": s(&root.join("secret")), "agent_privacy": lock_extra },
        { "id": "open", "name": "Open", "status": "active", "position": 1, "local_file": "",
          "directory": s(&root.join("open")) },
    ]))
}

fn locked_registry(root: &Path) -> ProjectsList {
    std::fs::create_dir_all(root.join("secret")).unwrap();
    std::fs::create_dir_all(root.join("open")).unwrap();
    registry(root, json!({ "local_models_only": true, "cut_network": false }))
}

struct World {
    local: Result<(), &'static str>,
    endpoint: Result<String, String>,
    ambient: Option<String>,
}

impl World {
    fn healthy() -> Self {
        World { local: Ok(()), endpoint: Ok("127.0.0.1:11434".into()), ambient: None }
    }

    fn gate(&self, opts: PtyOptions, projects: &ProjectsList, share: &Path) -> Result<PtyOptions, String> {
        let endpoint = || self.endpoint.clone();
        let local = |_: &str, _: &str| self.local;
        let probe = Probe { endpoint: &endpoint, local: &local, ambient_host: self.ambient.clone() };
        gate_with(opts, projects, &probe, share)
    }
}

const LINE: &[&str] = &["launch", "claude", "--model", "qwen3:8b"];

#[test]
fn the_setting_reads_absent_off_and_malformed_as_on() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = |extra: Value| registry(tmp.path(), extra).into_iter().next().unwrap();
    assert_eq!(privacy_of(&entry(Value::Null)), Privacy::default());
    assert_eq!(privacy_of(&entry(json!({}))), Privacy::default());
    assert_eq!(privacy_of(&entry(json!({ "local_models_only": false }))), Privacy::default());
    assert_eq!(privacy_of(&entry(json!({ "local_models_only": true }))), Privacy { local_models_only: true, cut_network: false });
    assert!(privacy_of(&entry(json!({ "local_models_only": true, "cut_network": true }))).cut_network);
    // A shape this build never writes narrows instead of opening.
    assert!(privacy_of(&entry(json!("yes"))).local_models_only);
    assert!(privacy_of(&entry(json!({ "local_models_only": "true" }))).local_models_only);
    // No record at all: absent.
    let plain = list(json!([{ "id": "p", "name": "P", "status": "active", "position": 0, "local_file": "", "directory": "x" }]));
    assert_eq!(privacy_of(&plain[0]), Privacy::default());
}

#[test]
fn the_record_round_trips_and_unknown_fields_stay() {
    let mut extra: HashMap<String, Value> = HashMap::new();
    write_privacy(&mut extra, Privacy { local_models_only: true, cut_network: false });
    assert_eq!(extra[KEY], json!({ "local_models_only": true, "cut_network": false }));
    extra.get_mut(KEY).unwrap().as_object_mut().unwrap().insert("future".into(), json!(7));
    write_privacy(&mut extra, Privacy { local_models_only: false, cut_network: false });
    assert_eq!(extra[KEY]["future"], json!(7), "an unknown field survives the switch going off");
    assert_eq!(extra[KEY]["local_models_only"], json!(false));
    // Nothing on and nothing unknown: no record, today's shape.
    let mut bare: HashMap<String, Value> = HashMap::new();
    write_privacy(&mut bare, Privacy { local_models_only: true, cut_network: false });
    write_privacy(&mut bare, Privacy::default());
    assert!(!bare.contains_key(KEY));
    // Through the entry type, as projects.json holds it.
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let text = serde_json::to_string(&projects).unwrap();
    let back: ProjectsList = serde_json::from_str(&text).unwrap();
    assert_eq!(serde_json::to_value(&back).unwrap(), serde_json::to_value(&projects).unwrap());
    assert_eq!(locked_ids(&back), vec!["lock".to_string()]);
}

#[test]
fn only_a_set_cut_network_is_refused_until_it_is_enforced() {
    assert!(set("p", Privacy { local_models_only: true, cut_network: true }).unwrap_err().contains("not available yet"));
    assert!(set("p", Privacy { local_models_only: false, cut_network: true }).is_err());
}

#[test]
fn a_spawn_is_subject_to_its_project_and_to_a_cwd_inside_one() {
    let tmp = tempfile::tempdir().unwrap();
    let locked = locked_projects(&locked_registry(tmp.path()));
    assert_eq!(locked.len(), 1);
    let secret = tmp.path().join("secret");
    assert_eq!(subjects(&locked, Some("lock"), &s(tmp.path())).len(), 1, "its own project, wherever the cwd");
    assert_eq!(subjects(&locked, None, &s(&secret.join("sub"))).len(), 1, "the root console with a cwd inside");
    assert_eq!(subjects(&locked, Some("open"), &s(&secret)).len(), 1, "another project with a cwd inside");
    assert!(subjects(&locked, Some("open"), &s(&tmp.path().join("open"))).is_empty());
    assert!(subjects(&locked, None, &s(&tmp.path().join("secret-twin"))).is_empty(), "a sibling that shares the prefix");
    assert!(subjects(&locked, None, "").is_empty());
    // `..` cannot walk out of the compare.
    assert_eq!(subjects(&locked, None, &s(&secret.join("..").join("secret").join("x"))).len(), 1);
    assert!(path_inside(&secret.join("a").join("..").join("b"), &secret));
}

#[cfg(unix)]
#[test]
fn a_link_into_the_folder_counts_as_inside() {
    let tmp = tempfile::tempdir().unwrap();
    let locked = locked_projects(&locked_registry(tmp.path()));
    let link = tmp.path().join("open").join("door");
    std::os::unix::fs::symlink(tmp.path().join("secret"), &link).unwrap();
    assert_eq!(subjects(&locked, None, &s(&link)).len(), 1);
}

#[test]
fn the_mask_covers_every_other_locked_folder_that_exists() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = list(json!([
        { "id": "a", "name": "A", "status": "active", "position": 0, "local_file": "", "directory": s(&tmp.path().join("a")),
          "agent_privacy": { "local_models_only": true, "cut_network": false } },
        { "id": "b", "name": "B", "status": "active", "position": 1, "local_file": "", "directory": s(&tmp.path().join("b")),
          "agent_privacy": { "local_models_only": true, "cut_network": false } },
        { "id": "gone", "name": "G", "status": "active", "position": 2, "local_file": "", "directory": s(&tmp.path().join("gone")),
          "agent_privacy": { "local_models_only": true } },
        { "id": "c", "name": "C", "status": "active", "position": 3, "local_file": "", "directory": s(&tmp.path().join("c")) },
    ]));
    for d in ["a", "b", "c"] {
        std::fs::create_dir_all(tmp.path().join(d)).unwrap();
    }
    let locked = locked_projects(&projects);
    let has = |masks: &[PathBuf], d: &str| masks.iter().any(|m| m.ends_with(d));
    let for_other = mask_dirs(&locked, Some("c"));
    assert!(has(&for_other, "a") && has(&for_other, "b"));
    assert!(!has(&for_other, "c"), "an open project is never masked");
    assert!(!has(&for_other, "gone"), "a folder that is not there has nothing to hide");
    let for_a = mask_dirs(&locked, Some("a"));
    assert!(!has(&for_a, "a") && has(&for_a, "b"), "a locked project keeps its own folder, loses the others'");
    assert!(has(&mask_dirs(&locked, None), "a"), "the root console and boxes lose all of them");
}

#[test]
fn provider_variables_are_named_and_scrubbed() {
    for name in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MISTRAL_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "openai_api_key", "SOME_NEW_API_KEY", "X_AUTH_TOKEN"] {
        assert!(is_provider_env(name), "{name}");
    }
    for name in ["PATH", "HOME", "OLLAMA_HOST", "VIBE_HOME", "APIKEY"] {
        assert!(!is_provider_env(name), "{name}");
    }
    let mut env: HashMap<String, String> = HashMap::from([
        ("ANTHROPIC_API_KEY".into(), "k".into()),
        ("ANTHROPIC_BASE_URL".into(), "https://example.invalid".into()),
        ("OPENCODE_CONFIG_CONTENT".into(), "{}".into()),
        ("KEEP_ME".into(), "1".into()),
    ]);
    scrub_env(&mut env);
    assert_eq!(env.len(), 1);
    assert!(env.contains_key("KEEP_ME"));
    let names = unset_names(["MY_API_KEY".to_string()].iter());
    assert!(names.contains(&"MISTRAL_API_KEY".to_string()) && names.contains(&"MY_API_KEY".to_string()));
}

#[test]
fn a_cloud_cli_is_refused_in_a_locked_project() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    for cmd in ["claude", "codex", "gemini", "opencode", "vibe", "ollama"] {
        let err = World::healthy()
            .gate(opts(cmd, &[], Some("lock"), &tmp.path().join("secret")), &projects, tmp.path())
            .unwrap_err();
        assert!(err.starts_with(REFUSAL) && err.contains("Secret"), "{cmd}: {err}");
    }
    // The renderer's own claim of a local model grants nothing.
    let mut sly = opts("claude", &["--model", "qwen3:8b"], Some("lock"), &tmp.path().join("secret"));
    sly.local_model = true;
    sly.env.insert(crate::app_env!("LOCAL_MODEL").into(), "qwen3:8b".into());
    sly.env.insert(STAMP_ENV.into(), "lock".into());
    assert!(World::healthy().gate(sly, &projects, tmp.path()).is_err());
}

#[test]
fn a_genuine_local_launch_line_on_a_local_model_is_verified_and_scrubbed() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let mut tab = opts("ollama", LINE, Some("lock"), &tmp.path().join("secret").join("sub"));
    tab.env.insert("ANTHROPIC_API_KEY".into(), "sk-secret".into());
    tab.env.insert("OPENAI_BASE_URL".into(), "https://example.invalid".into());
    tab.env.insert("KEEP".into(), "1".into());
    let out = World::healthy().gate(tab, &projects, tmp.path()).unwrap();
    assert_eq!(out.env.get(STAMP_ENV).map(String::as_str), Some("lock"));
    assert_eq!(out.env.get("OLLAMA_HOST").map(String::as_str), Some("127.0.0.1:11434"));
    assert_eq!(out.env.get("KEEP").map(String::as_str), Some("1"));
    assert!(!out.env.contains_key("ANTHROPIC_API_KEY") && !out.env.contains_key("OPENAI_BASE_URL"));
    assert!(out.local_model, "the home without logins");
    assert_eq!(out.args, LINE, "the argv is the one that was verified");
    assert!(is_verified("tab-1", "lock"));
    assert!(stamped(&out));
    forget("tab-1");
}

#[test]
fn every_driver_line_is_recognised_and_a_tampered_one_is_not() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let cwd = tmp.path().join("secret");
    for (cmd, args) in [
        ("opencode", vec!["--model", "ollama/qwen3:8b"]),
        ("ollama", vec!["launch", "pi", "--model", "qwen3:8b"]),
        ("ollama", vec!["launch", "claude", "--model", "qwen3:8b"]),
        ("codex", vec!["--oss", "-c", "oss_provider=\"ollama\"", "-m", "qwen3:8b"]),
    ] {
        let out = World::healthy().gate(opts(cmd, &args, Some("lock"), &cwd), &projects, tmp.path());
        assert!(out.is_ok(), "{cmd} {args:?}: {out:?}");
    }
    for (cmd, args) in [
        ("opencode", vec!["--model", "ollama/qwen3:8b", "--model", "anthropic/claude"]),
        ("ollama", vec!["launch", "claude", "--model", "qwen3:8b", "--", "--model", "x"]),
        ("ollama", vec!["run", "qwen3:8b"]),
        ("opencode", vec!["--model", "anthropic/claude-sonnet"]),
        ("claude", vec!["--model", "qwen3:8b"]),
    ] {
        let err = World::healthy().gate(opts(cmd, &args, Some("lock"), &cwd), &projects, tmp.path()).unwrap_err();
        assert!(err.starts_with(REFUSAL), "{cmd} {args:?}: {err}");
    }
    forget("tab-1");
}

#[test]
fn a_cloud_model_an_absent_ollama_a_foreign_listener_or_a_remote_host_refuses() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let tab = || opts("ollama", LINE, Some("lock"), &tmp.path().join("secret"));
    let ollama = crate::services::ollama_client::MODEL_NOT_RUNNING;
    let listener = crate::services::ollama_client::LISTENER_REFUSED;
    for (world, needle) in [
        (World { local: Err("model_not_local"), ..World::healthy() }, "cloud model"),
        (World { local: Err("model_not_installed"), ..World::healthy() }, "not a model the local Ollama lists"),
        (World { local: Err(ollama), ..World::healthy() }, "not running"),
        (World { local: Err(listener), ..World::healthy() }, "not Ollama's"),
        (World { local: Err(crate::services::ollama_client::MODEL_ALIAS_SHARED), ..World::healthy() }, "shares the name"),
        (World { endpoint: Err("remote".into()), ..World::healthy() }, "not on this machine"),
        (World { ambient: Some("ollama.example.invalid:11434".into()), ..World::healthy() }, "OLLAMA_HOST"),
    ] {
        let err = world.gate(tab(), &projects, tmp.path()).unwrap_err();
        assert!(err.starts_with(REFUSAL) && err.contains(needle), "{needle}: {err}");
    }
    // A loopback OLLAMA_HOST is fine.
    let ok = World { ambient: Some("127.0.0.1:11500".into()), ..World::healthy() };
    assert!(ok.gate(tab(), &projects, tmp.path()).is_ok());
    forget("tab-1");
}

#[test]
fn the_host_session_the_root_console_and_other_kinds_of_project_refuse() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let secret = tmp.path().join("secret");
    // D1: the Host session is refused a cwd in the project.
    let mut host = opts("claude", &[], None, &secret);
    host.host_session = true;
    assert!(World::healthy().gate(host, &projects, tmp.path()).unwrap_err().contains("Host session"));
    // A root-console agent with its cwd in the folder.
    assert!(World::healthy().gate(opts("claude", &[], None, &secret), &projects, tmp.path()).is_err());
    // A container tab, a worker host, a remote record, Cut network on.
    let mut contained = opts("ollama", LINE, Some("lock"), &secret);
    contained.sandbox = true;
    assert!(World::healthy().gate(contained, &projects, tmp.path()).unwrap_err().contains("not a plain local folder"));
    let mut worker = opts("ollama", LINE, Some("lock"), &secret);
    worker.remote_host_id = Some("gpu-box".into());
    assert!(World::healthy().gate(worker, &projects, tmp.path()).is_err());
    let remote = list(json!([{ "id": "lock", "name": "Secret", "status": "active", "position": 0, "local_file": "",
        "directory": s(&secret), "remote": { "host": "h", "remote_path": "/r" },
        "agent_privacy": { "local_models_only": true } }]));
    assert!(World::healthy().gate(opts("ollama", LINE, Some("lock"), &secret), &remote, tmp.path()).is_err());
    let cut = registry(tmp.path(), json!({ "local_models_only": true, "cut_network": true }));
    let err = World::healthy().gate(opts("ollama", LINE, Some("lock"), &secret), &cut, tmp.path()).unwrap_err();
    assert!(err.contains("Cut network") && err.contains("not available yet"), "{err}");
}

#[test]
fn spawns_outside_every_locked_project_and_shells_pass_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let open = tmp.path().join("open");
    let cloud = opts("claude", &["--resume", "x"], Some("open"), &open);
    let out = World::healthy().gate(cloud.clone(), &projects, tmp.path()).unwrap();
    assert_eq!((out.cmd.as_str(), &out.args, &out.env, out.local_model), (cloud.cmd.as_str(), &cloud.args, &cloud.env, false));
    // A shell tab in the locked folder is the user's own.
    let mut shell = opts("", &[], Some("lock"), &tmp.path().join("secret"));
    shell.agent = false;
    assert!(World::healthy().gate(shell, &projects, tmp.path()).is_ok());
    // No Ollama needed for an unrelated project.
    let down = World { local: Err(crate::services::ollama_client::MODEL_NOT_RUNNING), endpoint: Err("x".into()), ambient: None };
    assert!(down.gate(opts("claude", &[], Some("open"), &open), &projects, tmp.path()).is_ok());
}

#[test]
fn a_vibe_tab_gets_a_home_and_config_of_its_own_per_project() {
    let tmp = tempfile::tempdir().unwrap();
    let share = tmp.path().join("share");
    let projects = locked_registry(tmp.path());
    let alias = crate::services::ollama_client::sanitize_alias("qwen3:8b");
    let mut tab = opts("vibe", &["--continue"], Some("lock"), &tmp.path().join("secret"));
    tab.env.insert(crate::app_env!("LOCAL_MODEL").into(), "qwen3:8b".into());
    tab.env.insert("VIBE_ACTIVE_MODEL".into(), alias.clone());
    // The renderer pointed it at the shared home and a cloud key.
    tab.env.insert("VIBE_HOME".into(), s(&share.join("vibe_local").join(&alias)));
    tab.env.insert("MISTRAL_API_KEY".into(), "k".into());
    let out = World::healthy().gate(tab, &projects, &share).unwrap();
    let home = vibe_home_in(&share, &alias, "lock");
    assert_eq!(out.env.get("VIBE_HOME").map(String::as_str), Some(s(&home).as_str()));
    assert_ne!(home, share.join("vibe_local").join(&alias), "not the home every scope shares");
    assert!(!out.env.contains_key("MISTRAL_API_KEY"));
    let config = std::fs::read_to_string(home.join("config.toml")).unwrap();
    assert!(config.contains("api_base = \"http://127.0.0.1:11434/v1\"") && config.contains("name = \"qwen3:8b\""), "{config}");
    assert_eq!(config.matches("[[providers]]").count(), 1, "one provider and no cloud default");
    assert_ne!(vibe_home_in(&share, &alias, "lock"), vibe_home_in(&share, &alias, "other"));
    // A disagreeing alias, no model, or a stray flag refuses.
    let mut bad = opts("vibe", &[], Some("lock"), &tmp.path().join("secret"));
    bad.env.insert(crate::app_env!("LOCAL_MODEL").into(), "qwen3:8b".into());
    bad.env.insert("VIBE_ACTIVE_MODEL".into(), "another".into());
    assert!(World::healthy().gate(bad, &projects, &share).is_err());
    assert!(World::healthy().gate(opts("vibe", &[], Some("lock"), &tmp.path().join("secret")), &projects, &share).is_err());
    let mut flagged = opts("vibe", &["--agent", "x"], Some("lock"), &tmp.path().join("secret"));
    flagged.env.insert(crate::app_env!("LOCAL_MODEL").into(), "qwen3:8b".into());
    assert!(World::healthy().gate(flagged, &projects, &share).is_err());
    forget("tab-1");
}

#[test]
fn the_fence_repeats_the_check_on_the_stamp() {
    let tmp = tempfile::tempdir().unwrap();
    let locked = locked_projects(&locked_registry(tmp.path()));
    let secret = tmp.path().join("secret");
    let bare = opts("claude", &[], Some("lock"), &secret);
    assert!(fence_gate_in(&locked, &bare, "lock").unwrap_err().starts_with(REFUSAL), "no stamp: refused (the shim)");
    let mut stamped_for_other = bare.clone();
    stamped_for_other.env.insert(STAMP_ENV.into(), "open".into());
    assert!(fence_gate_in(&locked, &stamped_for_other, "lock").is_err());
    let mut good = bare.clone();
    good.env.insert(STAMP_ENV.into(), "lock".into());
    assert_eq!(fence_gate_in(&locked, &good, "lock").unwrap(), Some("lock".to_string()));
    // The root scope with a cwd inside is subject; an unrelated one is not.
    assert!(fence_gate_in(&locked, &opts("claude", &[], None, &secret), crate::storage::ROOT_SCOPE).is_err());
    assert_eq!(fence_gate_in(&locked, &opts("claude", &[], Some("open"), &tmp.path().join("open")), "open").unwrap(), None);
}

#[test]
fn a_container_never_carries_a_locked_project_or_hides_one() {
    let tmp = tempfile::tempdir().unwrap();
    let locked = locked_projects(&locked_registry(tmp.path()));
    let secret = s(&tmp.path().join("secret"));
    assert!(container_refusal_in(&locked, "lock", Some(&secret)).is_some());
    assert!(container_refusal_in(&locked, "open", Some(&s(tmp.path()))).unwrap().contains("inside this project's container mount"));
    assert!(container_refusal_in(&locked, "open", Some(&s(&tmp.path().join("open")))).is_none());
}

#[test]
fn only_a_plain_local_project_with_nothing_inside_may_be_locked() {
    let tmp = tempfile::tempdir().unwrap();
    let ok = Ok("127.0.0.1:11434".to_string());
    let boxes: BoxesList = Vec::new();
    let base = |extra: Value| {
        let mut entry = json!({ "id": "p", "name": "Plain", "status": "active", "position": 0, "local_file": "", "directory": s(&tmp.path().join("p")) });
        entry.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        list(json!([entry]))
    };
    assert!(check_enable(&base(json!({})), &boxes, "p", ok.clone()).is_ok());
    for (extra, needle) in [
        (json!({ "remote": { "host": "h", "remote_path": "/r" } }), "remote or VM"),
        (json!({ "vm": { "enabled": true } }), "remote or VM"),
        (json!({ "sandbox": { "enabled": true } }), "container"),
    ] {
        let err = check_enable(&base(extra), &boxes, "p", ok.clone()).unwrap_err();
        assert!(err.contains("Plain") && err.contains(needle), "{needle}: {err}");
    }
    let err = check_enable(&base(json!({})), &boxes, "p", Err("remote host".into())).unwrap_err();
    assert!(err.contains("Ollama host"), "{err}");
    assert!(check_enable(&base(json!({})), &boxes, "ghost", ok.clone()).is_err());
    // Another project inside, by directory or by mirror; a box folder inside.
    let nested = list(json!([
        { "id": "p", "name": "Plain", "status": "active", "position": 0, "local_file": "", "directory": s(&tmp.path().join("p")) },
        { "id": "q", "name": "Inner", "status": "active", "position": 1, "local_file": "", "directory": s(&tmp.path().join("p").join("q")) },
    ]));
    assert!(check_enable(&nested, &boxes, "p", ok.clone()).unwrap_err().contains("\"Inner\" lies inside"));
    assert!(check_enable(&nested, &boxes, "q", ok.clone()).is_ok(), "a project inside another may be locked");
    let mirrored = list(json!([
        { "id": "p", "name": "Plain", "status": "active", "position": 0, "local_file": "", "directory": s(&tmp.path().join("p")) },
        { "id": "r", "name": "Mirror", "status": "active", "position": 1, "local_file": "", "directory": s(&tmp.path().join("elsewhere")),
          "mirror": s(&tmp.path().join("p").join("m")) },
    ]));
    assert!(check_enable(&mirrored, &boxes, "p", ok.clone()).is_err());
    let boxed: BoxesList = serde_json::from_value(json!([{ "id": "b", "name": "Group", "folder": s(&tmp.path().join("p").join("box")) }])).unwrap();
    assert!(check_enable(&base(json!({})), &boxed, "p", ok).unwrap_err().contains("box \"Group\""));
}

#[test]
fn no_box_hands_out_a_locked_projects_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let boxes: BoxesList = serde_json::from_value(json!([{ "id": "b", "name": "Group", "member_ids": ["lock", "open"] }])).unwrap();
    let box_roots = crate::services::box_store::compute_box_allowed_roots(&boxes, &projects, "b").unwrap();
    assert_eq!(box_roots, vec![tmp.path().join("open")], "the box tab loses the locked member");
    // The locked project's own tab: its folder and nothing from the box.
    let own = crate::services::agent_fence::compute_fence_roots(&boxes, &projects, "lock", false).unwrap();
    assert_eq!(own, vec![tmp.path().join("secret")]);
    // The open member keeps the box, minus the locked member.
    let open = crate::services::agent_fence::compute_fence_roots(&boxes, &projects, "open", false).unwrap();
    assert_eq!(open, vec![tmp.path().join("open")]);
    // The box scope itself.
    let scope = crate::services::agent_fence::compute_fence_roots(&boxes, &projects, "box:b", false).unwrap();
    assert!(scope.iter().all(|r| !r.starts_with(tmp.path().join("secret"))));
}

#[test]
fn the_root_console_is_not_shown_a_locked_project_read_only() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let settings: crate::schema::Settings = serde_json::from_value(json!({ "root_fence_projects_readable": true })).unwrap();
    let paths = crate::services::agent_fence::root_project_read_only_paths(&settings, &projects, &Vec::new(), tmp.path());
    assert_eq!(paths, vec![s(&tmp.path().join("open"))]);
}

#[test]
fn the_bubblewrap_fence_masks_and_unsets_last() {
    let mut args: Vec<String> = ["--bind", "/", "/", "--", "claude"].iter().map(|a| a.to_string()).collect();
    crate::services::agent_fence::mask_local_models_only(&mut args, &[PathBuf::from("/w/secret")]);
    assert_eq!(args[args.len() - 4..], ["--tmpfs", "/w/secret", "--", "claude"]);
    crate::services::agent_fence::unset_env_in_fence(&mut args, &["OPENAI_API_KEY".to_string()]);
    assert_eq!(args[args.len() - 4..], ["--unsetenv", "OPENAI_API_KEY", "--", "claude"]);
}

/// The source scans: a spawn site that skips the gate would be the hole, so the
/// sites are named and each is held to call it.
fn source(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn body_of<'a>(text: &'a str, signature: &str) -> &'a str {
    let at = text.find(signature).unwrap_or_else(|| panic!("{signature} not found"));
    let rest = &text[at..];
    let end = rest.find("\n}\n").map_or(rest.len(), |e| e + 3);
    &rest[..end]
}

#[test]
fn every_agent_spawn_site_passes_the_gate() {
    // The one assembly every window and phone spawn runs: the gate is called
    // before anything is built for the agent.
    let prep = source("services/launch_prep.rs");
    let prepare = body_of(&prep, "pub async fn prepare(");
    assert!(prepare.contains("agent_privacy::gate("), "launch_prep::prepare must call the gate");
    assert!(
        prepare.find("agent_privacy::gate(").unwrap() < prepare.find("set_scope_env(").unwrap(),
        "the gate runs before the tab's scope and grants are built"
    );
    // Both fence wrappers repeat the check on the stamp.
    let fence = source("services/agent/agent_fence.rs");
    for wrapper in ["pub fn wrap_pty_options_bwrap(", "pub fn wrap_pty_options_sandbox_exec("] {
        let body = body_of(&fence, wrapper);
        assert!(body.contains("agent_privacy::fence_gate("), "{wrapper} must call the fence gate");
        assert!(body.contains("locked_project.is_none()"), "{wrapper} must skip API-key injection for a locked project");
    }
    // The container wrap refuses.
    assert!(body_of(&source("services/sandbox.rs"), "pub fn wrap_pty_options_docker(").contains("agent_privacy::container_refusal("));
    // No other file builds a fence around an agent: a new caller must be added
    // here, deliberately, and reach the gate through the wrapper.
    let mut callers = Vec::new();
    let mut stack = vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") && !path.to_string_lossy().contains("tests") {
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                if text.contains("wrap_pty_options_bwrap(") || text.contains("wrap_pty_options_sandbox_exec(") {
                    callers.push(path.file_name().unwrap().to_string_lossy().into_owned());
                }
            }
        }
    }
    callers.sort();
    assert_eq!(
        callers,
        ["agent_fence.rs", "agent_shim.rs", "assistant_model_probe.rs", "launch_prep.rs"],
        "a new site that wraps an agent in the fence must pass the gate (the wrapper does) and be listed here"
    );
}
