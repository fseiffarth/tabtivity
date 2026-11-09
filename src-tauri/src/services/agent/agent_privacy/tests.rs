use super::*;
use serde_json::json;
use std::collections::HashMap;

fn list(value: Value) -> ProjectsList {
    serde_json::from_value(value).unwrap()
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// A tab id of its own per call: the registry of verified tabs is process-wide
/// and the tests run in parallel.
fn fresh_tab_id() -> String {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    format!("tab-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

fn opts(cmd: &str, args: &[&str], project: Option<&str>, cwd: &Path) -> PtyOptions {
    PtyOptions {
        login: None,
        assistant: None,
        id: fresh_tab_id(),
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
    pins_claude: bool,
    can_cut: bool,
}

impl World {
    fn healthy() -> Self {
        World { local: Ok(()), endpoint: Ok("127.0.0.1:11434".into()), ambient: None, pins_claude: true, can_cut: true }
    }

    fn gate(&self, opts: PtyOptions, projects: &ProjectsList, share: &Path) -> Result<PtyOptions, String> {
        let endpoint = || self.endpoint.clone();
        let local = |_: &str, _: &str| self.local;
        let probe = Probe { endpoint: &endpoint, local: &local, ambient_host: self.ambient.clone(), pins_claude: self.pins_claude, can_cut: self.can_cut };
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
fn cut_network_is_accepted_where_the_sandbox_can_cut_and_only_beneath_local_models_only() {
    let on = Privacy { local_models_only: true, cut_network: true };
    assert!(check_set(on, true).is_ok());
    assert!(check_set(Privacy { local_models_only: true, cut_network: false }, false).is_ok());
    // macOS (phase 3) and Windows: the existing fail-closed text.
    assert_eq!(check_set(on, false).unwrap_err(), CUT_NETWORK_UNAVAILABLE);
    // Not without Local models only.
    assert!(check_set(Privacy { local_models_only: false, cut_network: true }, true).unwrap_err().contains("Local models only"));
    assert_eq!(cut_platform(), cfg!(target_os = "linux"));
    // `set` takes the same decisions before it reads the registry.
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
        ("DROP_ME".into(), "1".into()),
        (crate::app_env!("TAB_UID").into(), "uid".into()),
        (crate::app_env!("LOCAL_MODEL").into(), "qwen3:8b".into()),
    ]);
    scrub_env(&mut env);
    assert_eq!(env.len(), 2, "{env:?}");
    assert!(env.contains_key(crate::app_env!("TAB_UID")) && env.contains_key(crate::app_env!("LOCAL_MODEL")));
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
    tab.env.insert(crate::app_env!("TAB_UID").into(), "uid".into());
    let out = World::healthy().gate(tab, &projects, tmp.path()).unwrap();
    assert_eq!(out.env.get(STAMP_ENV).map(String::as_str), Some("lock"));
    assert_eq!(out.env.get("OLLAMA_HOST").map(String::as_str), Some("127.0.0.1:11434"));
    assert_eq!(out.env.get(crate::app_env!("TAB_UID")).map(String::as_str), Some("uid"));
    assert!(!out.env.contains_key("ANTHROPIC_API_KEY") && !out.env.contains_key("OPENAI_BASE_URL"));
    assert!(out.local_model, "the home without logins");
    assert_eq!(out.args, LINE, "the argv is the one that was verified");
    assert!(is_verified(&out.id, "lock"));
    assert!(stamped(&out));
}

/// A CLI reads more of its environment than any list of keys and base URLs
/// covers: `vibe` takes every `VIBE_*` variable as a config field, Codex's
/// `--oss` reads `CODEX_OSS_BASE_URL`. A tab verified for a local model keeps
/// only the two variables the frontend itself sets.
#[test]
fn a_verified_tab_keeps_none_of_the_renderers_other_variables() {
    let tmp = tempfile::tempdir().unwrap();
    let share = tmp.path().join("share");
    let projects = locked_registry(tmp.path());
    let secret = tmp.path().join("secret");
    let hostile = [
        ("VIBE_PROVIDERS", "[{\"name\":\"ollama\",\"api_base\":\"https://api.example.invalid/v1\"}]"),
        ("VIBE_MODELS", "[]"),
        ("CODEX_OSS_BASE_URL", "https://api.example.invalid/v1"),
        ("CODEX_OSS_PORT", "1"),
        ("CLAUDE_CODE_USE_BEDROCK", "1"),
        ("HTTPS_PROXY", "http://proxy.example.invalid"),
        ("NODE_OPTIONS", "--require /tmp/x.js"),
    ];
    let mut codex = opts("codex", &["--oss", "-c", "oss_provider=\"ollama\"", "-m", "qwen3:8b"], Some("lock"), &secret);
    let mut vibe = opts("vibe", &[], Some("lock"), &secret);
    vibe.env.insert(crate::app_env!("LOCAL_MODEL").into(), "qwen3:8b".into());
    for tab in [&mut codex, &mut vibe] {
        tab.env.extend(hostile.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        tab.env.insert(crate::app_env!("TAB_UID").into(), "uid".into());
    }
    for tab in [codex, vibe] {
        let out = World::healthy().gate(tab, &projects, &share).unwrap();
        for (name, _) in hostile {
            assert!(!out.env.contains_key(name), "{name} survived: {:?}", out.env.keys());
        }
        assert_eq!(out.env.get(crate::app_env!("TAB_UID")).map(String::as_str), Some("uid"));
    }
}

#[test]
fn every_driver_line_is_recognised_and_a_tampered_one_is_not() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let cwd = tmp.path().join("secret");
    for (cmd, args) in [
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
    // Cut network on a platform whose sandbox cannot cut the network closes the project.
    let cut = registry(tmp.path(), json!({ "local_models_only": true, "cut_network": true }));
    let no_cut = World { can_cut: false, ..World::healthy() };
    let err = no_cut.gate(opts("ollama", LINE, Some("lock"), &secret), &cut, tmp.path()).unwrap_err();
    assert!(err.contains("Cut network") && err.contains("not available on this operating system"), "{err}");
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
    let down = World { local: Err(crate::services::ollama_client::MODEL_NOT_RUNNING), endpoint: Err("x".into()), ambient: None, pins_claude: true, can_cut: true };
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

/// The editor's Ollama completion sends the text around the caret to whatever
/// answers on the endpoint: a locked project's goes only to a confirmed local
/// model, never to an Ollama cloud model on the loopback endpoint.
#[test]
fn a_locked_projects_completion_refuses_a_model_that_is_not_confirmed_local() {
    let cloud = |_: &str, _: &str| Err("model_not_local");
    let local = |_: &str, _: &str| Ok(());
    let down = |_: &str, _: &str| Err(crate::services::ollama_client::MODEL_NOT_RUNNING);
    let refusal = completion_refusal_in(true, "127.0.0.1:11434", "gpt-oss:120b-cloud", &cloud).unwrap();
    assert!(refusal.starts_with(REFUSAL) && refusal.contains("gpt-oss:120b-cloud"), "{refusal}");
    assert!(completion_refusal_in(true, "127.0.0.1:11434", "qwen3:8b", &down).is_some(), "an unanswered list fails closed");
    assert_eq!(completion_refusal_in(true, "127.0.0.1:11434", "qwen3:8b", &local), None);
    assert_eq!(completion_refusal_in(false, "127.0.0.1:11434", "gpt-oss:120b-cloud", &cloud), None, "an open project is not asked");
    assert!(!completion_locked(None));
}

/// A project that contains a locked one can open its files in its own editor:
/// the path, not the editing project, decides whether Copilot may see the text.
#[test]
fn a_file_of_a_locked_project_is_inside_whatever_project_opened_it() {
    let tmp = tempfile::tempdir().unwrap();
    let locked = locked_projects(&locked_registry(tmp.path()));
    let secret = tmp.path().join("secret");
    assert!(inside_locked_in(&locked, &secret.join("src").join("main.rs")));
    assert!(inside_locked_in(&locked, &secret.join("a").join("..").join("b.txt")));
    assert!(!inside_locked_in(&locked, &tmp.path().join("open").join("main.rs")));
    assert!(!inside_locked_in(&locked, &tmp.path().join("secret-twin").join("main.rs")));
    assert!(!inside_locked_in(&[], &secret.join("main.rs")));
}

/// The editor-side calls that would hand a locked project's text to a cloud
/// service name their guard: the Ollama completion asks the model's locality,
/// Copilot's asks whether the file lies in a locked folder.
#[test]
fn the_completion_paths_call_their_guards() {
    let ollama = source("commands/ollama.rs");
    let complete = body_of(&ollama, "pub async fn complete_text(");
    assert!(complete.contains("agent_privacy::completion_locked(") && complete.contains("agent_privacy::completion_refusal("));
    let copilot = source("commands/copilot.rs");
    let complete = body_of(&copilot, "pub async fn copilot_complete(");
    assert!(complete.contains("agent_privacy::inside_locked("), "a file of a locked project opened through its parent");
}

/// `remote: null` is "not remote" everywhere else (`remote_target_for`), so the
/// setting and the gate must agree: a project that may be locked may start its
/// local tab, and a real remote record is refused by both.
#[test]
fn a_null_remote_or_vm_is_local_for_the_setting_and_the_gate_alike() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("secret")).unwrap();
    let boxes: BoxesList = Vec::new();
    let with = |extra: Value| {
        let mut entry = json!({ "id": "lock", "name": "Secret", "status": "active", "position": 0, "local_file": "",
            "directory": s(&tmp.path().join("secret")), "agent_privacy": { "local_models_only": true } });
        entry.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        list(json!([entry]))
    };
    let ok = || Ok("127.0.0.1:11434".to_string());
    let tab = || opts("ollama", LINE, Some("lock"), &tmp.path().join("secret"));
    for extra in [json!({ "remote": null }), json!({ "vm": null }), json!({ "remote": null, "vm": null })] {
        let projects = with(extra.clone());
        assert!(check_enable(&projects, &boxes, "lock", ok()).is_ok(), "{extra}: may be locked");
        assert!(World::healthy().gate(tab(), &projects, tmp.path()).is_ok(), "{extra}: its local tab starts");
    }
    for extra in [json!({ "remote": { "host": "h", "remote_path": "/r" } }), json!({ "vm": { "enabled": true } })] {
        let projects = with(extra.clone());
        assert!(check_enable(&projects, &boxes, "lock", ok()).is_err(), "{extra}: not lockable");
        assert!(World::healthy().gate(tab(), &projects, tmp.path()).is_err(), "{extra}: refused at the gate");
    }
}

/// An unreadable project list must not build a fence without masks: the roots
/// lookup and this read are two reads of the file, and a torn one between them
/// is the gap.
#[test]
fn an_unreadable_registry_builds_no_fence_instead_of_one_without_masks() {
    let err = mask_dirs_from(Err("torn read".into()), Some("open")).unwrap_err();
    assert!(err.starts_with(REFUSAL) && err.contains("torn read"), "{err}");
    let tmp = tempfile::tempdir().unwrap();
    let masks = mask_dirs_from(Ok(locked_registry(tmp.path())), Some("open")).unwrap();
    assert!(masks.contains(&tmp.path().join("secret")));
    // Every caller propagates the error instead of defaulting it away.
    let fence = source("services/agent/agent_fence.rs");
    assert_eq!(fence.matches("mask_dirs_now(").count(), fence.matches("then_some(scope_id))?").count(), "every call site ends in `?`");
}

fn view(visible: &[&Path], masked: &[&Path]) -> FenceView {
    FenceView { visible: visible.iter().map(|p| p.to_path_buf()).collect(), masked: masked.iter().map(|p| p.to_path_buf()).collect() }
}

/// Turning the switch on for a folder must end every live agent whose fence was
/// built before it and still shows the folder — not only the project's own tabs:
/// a parent project's, a box's, the root console's (read-only project view or an
/// allowlist), and leave alone what cannot see it.
#[test]
fn turning_the_switch_on_ends_every_live_tab_whose_fence_shows_the_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let parent = tmp.path().join("parent");
    let secret = parent.join("secret");
    let (open, other, boxed) = (tmp.path().join("open"), tmp.path().join("other"), tmp.path().join("box"));
    for d in [&secret, &open, &other, &boxed] {
        std::fs::create_dir_all(d).unwrap();
    }
    let ais: Vec<(String, String)> = [
        "lock:own-cloud", "lock:own-local", "parent:cloud", "box:cloud", "root:console", "root:allow", "open:cloud", "late:cloud", "other:cloud",
    ]
    .iter()
    .map(|t| (t.to_string(), t.to_string()))
    .chain([("parent:cloud:attach".to_string(), "parent:cloud".to_string())])
    .collect();
    let views = vec![
        ("lock:own-local".to_string(), view(&[&secret], &[])),
        ("parent:cloud".to_string(), view(&[&parent], &[])),
        ("box:cloud".to_string(), view(&[&boxed, &secret], &[])),
        ("root:console".to_string(), view(&[&tmp.path().join("work"), &secret], &[])),
        ("root:allow".to_string(), view(&[tmp.path()], &[])),
        ("open:cloud".to_string(), view(&[&open], &[])),
        // Spawned after the switch: the folder was masked in its fence.
        ("late:cloud".to_string(), view(&[&parent], &[&secret])),
        // A file of the folder on the allowlist.
        ("other:cloud".to_string(), view(&[&other, &secret.join("notes.md")], &[])),
    ];
    let mut ended = ptys_to_end("lock", Some(&secret), &ais, &views, &|tab| tab == "lock:own-local");
    ended.sort();
    assert_eq!(
        ended,
        ["box:cloud", "lock:own-cloud", "other:cloud", "parent:cloud", "parent:cloud:attach", "root:allow", "root:console"],
        "a verified local tab, an unrelated tab and a tab whose fence masked the folder stay"
    );
    // Without a recorded folder only the project's own unverified tabs go.
    assert_eq!(ptys_to_end("lock", None, &ais, &views, &|tab| tab == "lock:own-local"), ["lock:own-cloud"]);
    // The decision, alone: a sibling that shares the prefix is not the folder.
    assert!(!sees(&view(&[&tmp.path().join("parent2")], &[]), &parent));
    assert!(sees(&view(&[&secret], &[]), &secret));
}

/// The wrappers record what each fence shows and the switch's command asks for
/// it: a source scan, since the live pieces need a registry and a fence.
#[test]
fn the_wrappers_record_their_view_and_the_switch_uses_it() {
    let fence = source("services/agent/agent_fence.rs");
    for wrapper in ["pub fn wrap_pty_options_bwrap(", "fn sandbox_exec_inputs("] {
        assert!(body_of(&fence, wrapper).contains("note_fence_view("), "{wrapper} must record its fence view");
    }
    assert!(body_of(&source("services/launch_prep.rs"), "pub async fn prepare(").contains("take_fence_view("));
    assert!(source("commands/agent_privacy.rs").contains("agent_privacy::ptys_to_end("));
}

/// Content of a locked project goes only to the tabs of that same project: a
/// markup Submit of its file, rooted in the project itself, may; the same file
/// reached through a parent project or any other root may not. A file anywhere
/// else is unaffected.
#[test]
fn a_locked_projects_file_is_not_marked_up_into_another_projects_prompt() {
    let tmp = tempfile::tempdir().unwrap();
    let locked = locked_projects(&locked_registry(tmp.path()));
    let secret = tmp.path().join("secret");
    let file = secret.join("docs").join("paper.pdf");
    // Its own root: the tabs there are the gate's verified local ones.
    assert!(!foreign_source_in(&locked, &secret, &file));
    // Through a parent project, a sibling, or any other root: refused.
    assert!(foreign_source_in(&locked, tmp.path(), &file), "a parent project's root");
    assert!(foreign_source_in(&locked, &tmp.path().join("open"), &file), "another project's root");
    assert!(foreign_source_in(&locked, &secret.join("docs"), &file), "a root inside the folder is not the folder");
    // A file outside every locked folder, and a sibling that shares the prefix.
    assert!(!foreign_source_in(&locked, tmp.path(), &tmp.path().join("open").join("a.pdf")));
    assert!(!foreign_source_in(&locked, tmp.path(), &tmp.path().join("secret-twin").join("a.pdf")));
    assert!(!foreign_source_in(&[], tmp.path(), &file));
    // Read from a registry file, as the phone's host does with its own state dir.
    let state = tempfile::tempdir().unwrap();
    assert!(!foreign_source_at(state.path(), tmp.path(), &file), "no registry file lists no project");
    std::fs::write(state.path().join("projects.json"), serde_json::to_string(&locked_registry(tmp.path())).unwrap()).unwrap();
    assert!(foreign_source_at(state.path(), tmp.path(), &file));
    assert!(!foreign_source_at(state.path(), &secret, &file));
    std::fs::write(state.path().join("projects.json"), "{ torn").unwrap();
    assert!(foreign_source_at(state.path(), tmp.path(), &tmp.path().join("open").join("a.pdf")), "an unreadable registry refuses");
    // Both command layers that deliver a Submit's prompt, desktop and phone, ask first.
    assert!(body_of(&source("commands/pdf_markup.rs"), "pub async fn pdf_markup_submit(").contains("agent_privacy::foreign_source("));
    assert!(source("services/mobile_control/host.rs").contains("markup::not_foreign(&state_dir, &root, &source)?;"));
}

/// A project folder is attacker-controlled and the CLIs read config from it
/// (verified: Claude Code's `.claude/settings.json` `env` beats the environment
/// `ollama launch` sets, OpenCode's `opencode.json` and `.opencode` are loaded
/// from the cwd and every folder above it). The verified tab's fence covers
/// what exists on the way from its cwd to its root.
#[test]
fn a_verified_tabs_fence_hides_the_projects_cli_config() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("secret");
    let deeper = root.join("sub").join("deeper");
    std::fs::create_dir_all(root.join(".claude")).unwrap();
    std::fs::create_dir_all(root.join(".codex")).unwrap();
    std::fs::create_dir_all(root.join(".opencode")).unwrap();
    std::fs::create_dir_all(root.join(".vibe")).unwrap();
    std::fs::create_dir_all(deeper.join(".pi")).unwrap();
    for file in ["opencode.json", ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml", "sub/opencode.jsonc"] {
        std::fs::write(root.join(file), "{}").unwrap();
    }
    std::fs::write(root.join("README.md"), "not config").unwrap();
    // A sibling project's config is not this tab's business.
    std::fs::write(tmp.path().join("opencode.json"), "{}").unwrap();
    let masks = project_config_masks(std::slice::from_ref(&root), &deeper).unwrap();
    let mut got: Vec<(String, bool)> = masks
        .iter()
        .map(|m| (m.path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"), m.dir))
        .collect();
    got.sort();
    let mut want: Vec<(String, bool)> = [
        (".claude/settings.json", false),
        (".claude/settings.local.json", false),
        (".codex/config.toml", false),
        (".opencode", true),
        (".vibe", true),
        ("opencode.json", false),
        ("sub/deeper/.pi", true),
        ("sub/opencode.jsonc", false),
    ]
    .iter()
    .map(|(p, d)| (p.to_string(), *d))
    .collect();
    want.sort();
    assert_eq!(got, want, "what exists, from the cwd up to the root, and nothing else");
    // Nothing there, nothing to mount over (a mount over nothing would create a placeholder).
    let empty = tmp.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert!(project_config_masks(std::slice::from_ref(&empty), &empty).unwrap().is_empty());
    // The argv: a file is bound over with /dev/null, a folder with an empty tmpfs, before `--`.
    let mut args: Vec<String> = ["--bind", "/", "/", "--", "claude"].iter().map(|a| a.to_string()).collect();
    crate::services::agent_fence::mask_project_config(
        &mut args,
        &[ConfigMask { path: PathBuf::from("/w/p/opencode.json"), dir: false }, ConfigMask { path: PathBuf::from("/w/p/.opencode"), dir: true }],
    );
    assert_eq!(
        args[3..],
        ["--ro-bind", "/dev/null", "/w/p/opencode.json", "--tmpfs", "/w/p/.opencode", "--", "claude"]
    );
    // Both wrappers cover it for a verified tab.
    let fence = source("services/agent/agent_fence.rs");
    assert!(body_of(&fence, "pub fn wrap_pty_options_bwrap(").contains("mask_project_config("));
    assert!(body_of(&fence, "pub fn wrap_pty_options_sandbox_exec(").contains("project_config_masks("));
}

/// A name that is a link to nowhere cannot be covered, so the spawn is refused
/// instead of building a fence that leaves it to the CLI.
#[cfg(unix)]
#[test]
fn a_dangling_config_link_refuses_the_spawn() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("secret");
    std::fs::create_dir_all(&root).unwrap();
    std::os::unix::fs::symlink(tmp.path().join("nowhere.json"), root.join("opencode.json")).unwrap();
    let err = project_config_masks(std::slice::from_ref(&root), &root).unwrap_err();
    assert!(err.starts_with(REFUSAL) && err.contains("opencode.json"), "{err}");
}

/// The CLIs search upward from the directory the process is *in*, which is the
/// real path of a cwd given as a link or with `..` in it. A link inside the
/// folder (attacker-made: `link -> a/b`) must not hide `a/opencode.json` from the
/// chain, and the masks must not name a path through the link or the `..`.
#[test]
fn the_config_chain_follows_the_directory_the_process_is_in() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("secret");
    let deep = root.join("a").join("b");
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::write(root.join("a").join("opencode.json"), "{}").unwrap();
    std::fs::write(deep.join("opencode.jsonc"), "{}").unwrap();
    let real = |p: &Path| p.canonicalize().unwrap();
    let mut want = [real(&root.join("a").join("opencode.json")), real(&deep.join("opencode.jsonc"))];
    want.sort();
    // What the masks reach (a mask named through the link reaches the same file).
    let masked = |cwd: &Path| {
        let mut got: Vec<PathBuf> =
            project_config_masks(std::slice::from_ref(&root), cwd).unwrap().into_iter().map(|m| real(&m.path)).collect();
        got.sort();
        got.dedup();
        got
    };
    // `..` in the cwd: the folder the process is in is `secret/a/b`.
    let dotted = root.join("sub").join("..").join("a").join("b");
    assert_eq!(masked(&dotted), want, "a `..` in the cwd");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&deep, root.join("sub").join("link")).unwrap();
        assert_eq!(masked(&root.join("sub").join("link")), want, "a link inside the folder");
    }
}

/// An agent tab in a project's container sees the whole project folder through
/// the mount, and a locked project can lie inside it (`container_refusal` only
/// stops the *next* agent from starting there). Its spawn records that view too,
/// or turning the switch on leaves the running container agent reading the folder.
#[test]
fn a_running_container_agent_is_ended_when_a_folder_inside_its_mount_is_locked() {
    let tmp = tempfile::tempdir().unwrap();
    let mount = tmp.path().join("parent");
    let secret = mount.join("secret");
    std::fs::create_dir_all(&secret).unwrap();
    let view = container_fence_view(&s(&mount));
    let ais = vec![("parent:in-container".to_string(), "parent:in-container".to_string())];
    let views = vec![("parent:in-container".to_string(), view)];
    assert_eq!(ptys_to_end("lock", Some(&secret), &ais, &views, &|_| false), ["parent:in-container"]);
    assert!(ptys_to_end("lock", Some(&tmp.path().join("elsewhere")), &ais, &views, &|_| false).is_empty());
    // The spawn path records it for a container agent, as it does for a fenced one.
    let launch = source("services/launch_prep.rs");
    assert!(body_of(&launch, "pub async fn prepare(").contains("container_fence_view("), "prepare must record a container agent's view");
}

// ── Claude Code re-reads its settings: the pinned managed-settings file ─────

fn claude_line() -> Vec<&'static str> {
    vec!["launch", "claude", "--model", "qwen3:8b"]
}

#[test]
fn the_managed_claude_settings_pin_the_endpoint_the_model_and_every_way_around_them() {
    let text = crate::services::local_drivers::claude_managed_settings("qwen3:8b", "127.0.0.1:11434");
    let doc: Value = serde_json::from_str(&text).unwrap();
    let env = doc["env"].as_object().unwrap();
    assert_eq!(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:11434");
    for name in ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"] {
        assert_eq!(env[name], "qwen3:8b", "{name}");
    }
    // Emptied: a proxy variable in a settings file the agent writes carries the whole
    // request through its proxy, and the USE switches move it to a cloud provider.
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "CLAUDE_CODE_HTTP_PROXY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_UNIX_SOCKET"] {
        assert_eq!(env[name], "", "{name}");
    }
    assert_eq!(doc["model"], "qwen3:8b");
    assert_eq!(doc["availableModels"], json!(["qwen3:8b"]));
    assert_eq!(doc["allowedProviders"], json!(["customEndpoint"]));
}

#[test]
fn the_gate_remembers_a_claude_tabs_endpoint_and_model_for_the_fence() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let cwd = tmp.path().join("secret");
    let out = World::healthy().gate(opts("ollama", &claude_line(), Some("lock"), &cwd), &projects, tmp.path()).unwrap();
    let settings = claude_managed_for(&out).unwrap().expect("a verified Claude tab has settings to pin");
    let doc: Value = serde_json::from_str(&settings).unwrap();
    assert_eq!(doc["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:11434");
    assert_eq!(doc["model"], "qwen3:8b");
    // The record, not the argv, is what is pinned: a rewritten argv (a resume) changes nothing.
    let mut resumed = out.clone();
    resumed.args.extend(["--resume".into(), "x".into()]);
    assert_eq!(claude_managed_for(&resumed).unwrap().as_deref(), Some(settings.as_str()));
    // Another driver pins nothing here; a Claude launch the gate never saw is an error.
    let other = World::healthy()
        .gate(opts("ollama", &["launch", "pi", "--model", "qwen3:8b"], Some("lock"), &cwd), &projects, tmp.path())
        .unwrap();
    assert_eq!(claude_managed_for(&other).unwrap(), None);
    let unseen = opts("ollama", &claude_line(), Some("lock"), &cwd);
    assert!(claude_managed_for(&unseen).unwrap_err().starts_with(REFUSAL));
    let plain = opts("claude", &[], Some("lock"), &cwd);
    assert!(claude_managed_for(&plain).is_err());
}

#[test]
fn a_claude_launch_is_not_left_unpinned_when_a_second_spawn_of_its_tab_id_replaced_the_record() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let cwd = tmp.path().join("secret");
    let claude = World::healthy().gate(opts("ollama", &claude_line(), Some("lock"), &cwd), &projects, tmp.path()).unwrap();
    assert!(claude_managed_for(&claude).unwrap().is_some());
    // The record is kept per tab id: a second verified spawn of the id under another
    // driver replaces it, while the first spawn is still being fenced.
    let mut second = opts("ollama", &["launch", "pi", "--model", "qwen3:8b"], Some("lock"), &cwd);
    second.id = claude.id.clone();
    World::healthy().gate(second, &projects, tmp.path()).unwrap();
    assert!(
        claude_managed_for(&claude).unwrap_err().starts_with(REFUSAL),
        "a Claude launch without its record's pin must not start"
    );
}

#[test]
fn claude_is_refused_where_the_sandbox_cannot_pin_its_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let cwd = tmp.path().join("secret");
    let world = World { pins_claude: false, ..World::healthy() };
    let err = world.gate(opts("ollama", &claude_line(), Some("lock"), &cwd), &projects, tmp.path()).unwrap_err();
    assert!(err.starts_with(REFUSAL) && err.contains(CLAUDE_NOT_PINNABLE), "{err}");
    assert!(world.gate(opts("codex", &["--oss", "-c", "oss_provider=\"ollama\"", "-m", "qwen3:8b"], Some("lock"), &cwd), &projects, tmp.path()).is_ok());
    assert!(world.gate(opts("ollama", &["launch", "pi", "--model", "qwen3:8b"], Some("lock"), &cwd), &projects, tmp.path()).is_ok());
    assert_eq!(claude_pinned_platform(), cfg!(target_os = "linux"));
}

#[test]
fn opencode_is_refused_in_a_locked_project_whichever_way_it_gets_to_the_gate() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = locked_registry(tmp.path());
    let cwd = tmp.path().join("secret");
    let line = ["--model", "ollama/qwen3:8b"];
    // Its own project (window, phone, restore and schedule all arrive here), the root
    // console with a cwd inside, and another project (a box tab) with a cwd inside.
    for project in [Some("lock"), None, Some("open")] {
        let err = World::healthy().gate(opts("opencode", &line, project, &cwd), &projects, tmp.path()).unwrap_err();
        assert!(err.starts_with(REFUSAL) && err.contains("\"Secret\""), "{project:?}: {err}");
        assert!(err.contains("OpenCode") && err.contains("cannot be kept on the local model"), "{project:?}: {err}");
        // It names what can still run there, derived from the drivers.
        for label in ["Pi", "Claude Code", "Codex", "Mistral"] {
            assert!(err.contains(label), "{label} missing: {err}");
        }
    }
    // The refusal does not depend on Ollama or the model: a verified-looking line is
    // refused with the same words when Ollama is down.
    let down = World { local: Err(crate::services::ollama_client::MODEL_NOT_RUNNING), ..World::healthy() };
    let err = down.gate(opts("opencode", &line, Some("lock"), &cwd), &projects, tmp.path()).unwrap_err();
    assert!(err.contains("cannot be kept on the local model"), "{err}");
    // Where Claude cannot be pinned it is not offered as an alternative.
    let no_claude = World { pins_claude: false, ..World::healthy() };
    let err = no_claude.gate(opts("opencode", &line, Some("lock"), &cwd), &projects, tmp.path()).unwrap_err();
    assert!(!err.contains("Claude Code"), "{err}");
    // A project that is not locked still runs it; the shell-tab shim, which never
    // passed the gate and so has no stamp, is refused at the fence.
    let open = tmp.path().join("open");
    assert!(World::healthy().gate(opts("opencode", &line, Some("open"), &open), &projects, tmp.path()).is_ok());
    let locked = locked_projects(&projects);
    let shim = opts("opencode", &line, Some("lock"), &cwd);
    assert!(fence_gate_in(&locked, &shim, "lock").unwrap_err().starts_with(REFUSAL));
}

#[test]
fn the_agents_a_locked_project_can_run_are_derived_from_the_driver_registry() {
    let with_claude = agents_that_can_run_locked(true, false);
    let without = agents_that_can_run_locked(false, false);
    assert!(!with_claude.contains(&"OpenCode") && !without.contains(&"OpenCode"));
    assert!(with_claude.contains(&"Claude Code") && !without.contains(&"Claude Code"));
    // Every other registry driver is on the list, whatever the registry holds today.
    for d in crate::services::local_drivers::LOCAL_DRIVERS.iter().filter(|d| d.id != "opencode" && d.id != "claude") {
        assert!(without.contains(&d.label), "{} missing from {without:?}", d.label);
    }
    assert!(without.contains(&"Mistral (vibe)"));
    // The refused drivers are exactly the ones the gate turns away: nothing on the list is refused.
    for id in REFUSED_DRIVERS {
        let label = crate::services::local_drivers::LOCAL_DRIVERS.iter().find(|d| d.id == *id).unwrap().label;
        assert!(!with_claude.contains(&label), "{label}");
    }
}

/// A registry whose locked project has Cut network on.
fn cut_registry(root: &Path) -> ProjectsList {
    std::fs::create_dir_all(root.join("secret")).unwrap();
    std::fs::create_dir_all(root.join("open")).unwrap();
    registry(root, json!({ "local_models_only": true, "cut_network": true }))
}

#[test]
fn with_cut_network_on_the_verified_drivers_start_and_the_rest_are_refused_by_name() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = cut_registry(tmp.path());
    let cwd = tmp.path().join("secret");
    // OpenCode starts again (its only way out is the lane); Claude Code and Codex too.
    for (cmd, line) in [
        ("opencode", vec!["--model", "ollama/qwen3:8b"]),
        ("ollama", claude_line()),
        ("codex", vec!["--oss", "-c", "oss_provider=\"ollama\"", "-m", "qwen3:8b"]),
    ] {
        let out = World::healthy().gate(opts(cmd, &line, Some("lock"), &cwd), &projects, tmp.path()).unwrap_or_else(|e| panic!("{cmd}: {e}"));
        assert_eq!(out.env["OLLAMA_HOST"], "127.0.0.1:11434");
        assert!(verified_launch(&out.id).unwrap().cut);
    }
    // The others are refused, naming the agent and what can run.
    for (cmd, line, label) in [
        ("ollama", vec!["launch", "pi", "--model", "qwen3:8b"], "Pi"),
        ("ollama", vec!["launch", "droid", "--model", "qwen3:8b"], "Droid"),
        ("ollama", vec!["launch", "cline", "--model", "qwen3:8b"], "Cline"),
        ("ollama", vec!["launch", "openclaw", "--model", "qwen3:8b"], "OpenClaw"),
    ] {
        let err = World::healthy().gate(opts(cmd, &line, Some("lock"), &cwd), &projects, tmp.path()).unwrap_err();
        assert!(err.starts_with(REFUSAL) && err.contains(label) && err.contains("has not been verified with the network cut"), "{label}: {err}");
        for ok in ["OpenCode", "Claude Code", "Codex"] {
            assert!(err.contains(ok), "{ok} missing: {err}");
        }
        assert!(!err.contains("Mistral"), "{err}");
    }
    let mut vibe = opts("vibe", &[], Some("lock"), &cwd);
    vibe.env.insert(crate::app_env!("LOCAL_MODEL").to_string(), "qwen3:8b".into());
    let err = World::healthy().gate(vibe, &projects, tmp.path()).unwrap_err();
    assert!(err.contains("Mistral (vibe)") && err.contains("has not been verified"), "{err}");
    // Every verified driver is a driver the registry has (or vibe), and the network-on list
    // still refuses OpenCode.
    for id in CUT_VERIFIED_DRIVERS {
        assert!(*id == "vibe" || crate::services::local_drivers::LOCAL_DRIVERS.iter().any(|d| d.id == *id), "{id}");
    }
    assert!(agents_that_can_run_locked(true, true).contains(&"OpenCode"));
    assert!(!agents_that_can_run_locked(false, true).contains(&"Claude Code"));
    assert!(!agents_that_can_run_locked(true, false).contains(&"OpenCode"));
    // Without a cut platform nothing starts in a cut project, whatever the driver.
    let no_cut = World { can_cut: false, ..World::healthy() };
    assert!(no_cut.gate(opts("opencode", &["--model", "ollama/qwen3:8b"], Some("lock"), &cwd), &projects, tmp.path()).is_err());
}

#[test]
fn a_cut_tab_runs_its_driver_in_quiet_mode_and_an_open_one_does_not() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("secret");
    let cut = cut_registry(tmp.path());
    let plain = locked_registry(tmp.path());
    for (cmd, line, quiet) in [
        ("ollama", claude_line(), "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"),
        ("opencode", vec!["--model", "ollama/qwen3:8b"], "OPENCODE_DISABLE_AUTOUPDATE"),
    ] {
        let on = World::healthy().gate(opts(cmd, &line, Some("lock"), &cwd), &cut, tmp.path()).unwrap();
        assert_eq!(on.env.get(quiet).map(String::as_str), Some("1"), "{cmd}");
        if cmd == "ollama" {
            let off = World::healthy().gate(opts(cmd, &line, Some("lock"), &cwd), &plain, tmp.path()).unwrap();
            assert!(!off.env.contains_key(quiet), "a project with its network keeps the CLI's own behaviour");
        }
    }
    // Only drivers the table measured get a switch, and each driver's switches are its own.
    assert!(cut_quiet_env("codex").is_empty() && cut_quiet_env("pi").is_empty());
    assert!(cut_quiet_env("claude").iter().all(|(k, _)| !k.starts_with("OPENCODE")));
}

#[test]
fn a_cut_tabs_pins_name_the_relay_address_not_the_configured_host() {
    assert_eq!(fence_endpoint("localhost:9"), "127.0.0.1:9");
    assert_eq!(fence_endpoint("127.0.0.2:11434"), "127.0.0.1:11434");
    assert_eq!(fence_endpoint("[::1]:11434"), "127.0.0.1:11434");
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("secret");
    let world = World { endpoint: Ok("localhost:11500".into()), ..World::healthy() };
    // Network on: the judged address is what is pinned, as before.
    let on = world.gate(opts("ollama", &claude_line(), Some("lock"), &cwd), &locked_registry(tmp.path()), tmp.path()).unwrap();
    assert_eq!(on.env["OLLAMA_HOST"], "localhost:11500");
    let doc: Value = serde_json::from_str(&claude_managed_for(&on).unwrap().unwrap()).unwrap();
    assert_eq!(doc["env"]["ANTHROPIC_BASE_URL"], "http://localhost:11500");
    // Cut: the relay's address, in OLLAMA_HOST and in the Claude pin; the lane is
    // opened for the judged one.
    let cut = world.gate(opts("ollama", &claude_line(), Some("lock"), &cwd), &cut_registry(tmp.path()), tmp.path()).unwrap();
    assert_eq!(cut.env["OLLAMA_HOST"], "127.0.0.1:11500");
    let doc: Value = serde_json::from_str(&claude_managed_for(&cut).unwrap().unwrap()).unwrap();
    assert_eq!(doc["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:11500");
    let v = verified_launch(&cut.id).unwrap();
    assert_eq!((v.endpoint.as_str(), v.pinned_endpoint().as_str()), ("localhost:11500", "127.0.0.1:11500"));
    // A Mistral home would be written with the relay's address too.
    let verified = Verified { project: "lock".into(), driver: "vibe".into(), model: "m".into(), endpoint: "localhost:1".into(), cut: true };
    assert_eq!(verified.pinned_endpoint(), "127.0.0.1:1");
}

#[test]
fn the_fence_is_cut_by_what_the_gate_recorded_and_what_the_registry_says_now() {
    let tmp = tempfile::tempdir().unwrap();
    let (cut, plain) = (locked_projects(&cut_registry(tmp.path())), locked_projects(&locked_registry(tmp.path())));
    let rec = |cut: bool| Verified { project: "lock".into(), driver: "claude".into(), model: "m".into(), endpoint: "127.0.0.1:1".into(), cut };
    assert_eq!(fence_cut_in(&cut, "lock", Some(&rec(true))), Ok(true));
    assert_eq!(fence_cut_in(&plain, "lock", Some(&rec(false))), Ok(false));
    // The switch moved while the tab started: on refuses, off keeps the cut.
    assert!(fence_cut_in(&cut, "lock", Some(&rec(false))).unwrap_err().contains("Open it again"));
    assert_eq!(fence_cut_in(&plain, "lock", Some(&rec(true))), Ok(true));
    // No record: fine without the cut, refused with it.
    assert_eq!(fence_cut_in(&plain, "lock", None), Ok(false));
    assert!(fence_cut_in(&cut, "lock", None).unwrap_err().contains("Open it again"));
}

#[test]
fn changing_cut_network_names_the_running_tabs_on_the_other_setting() {
    let rec = |project: &str, cut: bool| Verified { project: project.into(), driver: "codex".into(), model: "m".into(), endpoint: "127.0.0.1:1".into(), cut };
    let tabs: HashMap<String, Verified> = [
        ("lock:a".to_string(), rec("lock", false)),
        ("lock:b".to_string(), rec("lock", true)),
        ("other:c".to_string(), rec("other", false)),
    ]
    .into();
    assert_eq!(restart_for_cut_in(&tabs, "lock", true), vec!["lock:a".to_string()]);
    assert_eq!(restart_for_cut_in(&tabs, "lock", false), vec!["lock:b".to_string()]);
    assert!(restart_for_cut_in(&tabs, "none", true).is_empty());
}

#[test]
fn an_old_or_unreadable_bubblewrap_is_refused_by_name_where_the_pin_needs_the_overlay() {
    use crate::services::agent_fence::{overlay_bwrap_check, parse_bwrap_version, HostClaudeDir};
    assert_eq!(parse_bwrap_version("bubblewrap 0.6.1\n"), Some((0, 6, 1)));
    assert_eq!(parse_bwrap_version("bubblewrap 0.11.1"), Some((0, 11, 1)));
    assert_eq!(parse_bwrap_version("bubblewrap 0.8"), Some((0, 8, 0)));
    assert_eq!(parse_bwrap_version("bubblewrap 0.9.0-rc1\nmore"), Some((0, 9, 0)));
    for junk in ["", "bubblewrap", "bubblewrap x.y", "bwrap: command not found", "0.8.0", "bubblewrap 1", "bubblewrapped 0.9.0"] {
        assert_eq!(parse_bwrap_version(junk), None, "{junk:?}");
    }
    // The overlay form (no `/etc/claude-code` on the host) needs 0.8.
    let err = overlay_bwrap_check(HostClaudeDir::Missing, Some((0, 6, 1))).unwrap_err();
    assert!(err.starts_with("Agent sandbox:") && err.contains("0.6.1") && err.contains("0.8"), "{err}");
    let err = overlay_bwrap_check(HostClaudeDir::Missing, Some((0, 7, 9))).unwrap_err();
    assert!(err.contains("0.7.9") && err.contains("0.8"), "{err}");
    for ok in [(0, 8, 0), (0, 11, 1), (1, 0, 0)] {
        assert!(overlay_bwrap_check(HostClaudeDir::Missing, Some(ok)).is_ok(), "{ok:?}");
    }
    // An unreadable version is refused the same way (closed), and says so.
    let err = overlay_bwrap_check(HostClaudeDir::Missing, None).unwrap_err();
    assert!(err.contains("0.8") && err.contains("could not be read"), "{err}");
    // The tmpfs form uses nothing newer than bubblewrap has had for years.
    assert!(overlay_bwrap_check(HostClaudeDir::Folder, Some((0, 6, 1))).is_ok());
    assert!(overlay_bwrap_check(HostClaudeDir::Folder, None).is_ok());
    // The wrapper asks before it builds the mounts, from the binary it will run.
    let fence = source("services/agent/agent_fence.rs");
    let body = body_of(&fence, "pub fn wrap_pty_options_bwrap(");
    let check = body.find("overlay_bwrap_check(").expect("the Linux wrapper checks the bubblewrap version");
    assert!(check < body.find("insert_managed_claude(").unwrap(), "the check comes before the mounts are inserted");
}

#[test]
fn the_bubblewrap_pin_covers_an_existing_policy_folder_with_a_tmpfs_and_a_missing_one_with_an_overlay() {
    use crate::services::agent_fence::{host_claude_dir, insert_managed_claude, managed_claude_args, HostClaudeDir};
    let file = Path::new("/state/claude_managed/ab/claude-code/managed-settings.json");
    let layer = Path::new("/state/claude_managed/ab");
    assert_eq!(
        managed_claude_args(HostClaudeDir::Folder, file, layer),
        [
            "--tmpfs",
            "/etc/claude-code",
            "--ro-bind",
            "/state/claude_managed/ab/claude-code/managed-settings.json",
            "/etc/claude-code/managed-settings.json",
            "--remount-ro",
            "/etc/claude-code"
        ]
    );
    assert_eq!(
        managed_claude_args(HostClaudeDir::Missing, file, layer),
        ["--overlay-src", "/etc", "--overlay-src", "/state/claude_managed/ab", "--ro-overlay", "/etc"]
    );
    // Before every other mount, so none of them under `/etc` is hidden by the overlay.
    let mut args: Vec<String> = ["--ro-bind", "/", "/", "--dev", "/dev", "--", "claude"].iter().map(|a| a.to_string()).collect();
    insert_managed_claude(&mut args, managed_claude_args(HostClaudeDir::Missing, file, layer));
    assert_eq!(args[..3], ["--ro-bind", "/", "/"]);
    assert_eq!(args[3], "--overlay-src");
    assert_eq!(args[args.len() - 4..], ["--dev", "/dev", "--", "claude"][..]);
    // The host's folder: a folder is covered, nothing there is overlaid, anything else refuses.
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(host_claude_dir(tmp.path()).unwrap(), HostClaudeDir::Folder);
    assert_eq!(host_claude_dir(&tmp.path().join("none")).unwrap(), HostClaudeDir::Missing);
    std::fs::write(tmp.path().join("file"), "x").unwrap();
    assert!(host_claude_dir(&tmp.path().join("file")).is_err());
}

#[test]
fn the_pinned_settings_file_is_written_once_per_content_and_pinned_by_inode() {
    use crate::services::agent_fence::{verify_control_pins, write_managed_claude};
    let tmp = tempfile::tempdir().unwrap();
    let (file, layer, pin) = write_managed_claude(tmp.path(), "{\"a\":1}").unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"a\":1}");
    assert!(file.starts_with(&layer) && file.ends_with("claude-code/managed-settings.json"));
    assert!(verify_control_pins(std::slice::from_ref(&pin)).is_ok());
    // The same content keeps the file (and so every running tab's bind); other content
    // gets a folder of its own.
    let (again, _, same) = write_managed_claude(tmp.path(), "{\"a\":1}").unwrap();
    assert_eq!(again, file);
    assert_eq!(same, pin);
    let (other, _, _) = write_managed_claude(tmp.path(), "{\"a\":2}").unwrap();
    assert_ne!(other, file);
    // A file swapped in behind the pin refuses the spawn.
    std::fs::remove_file(&file).unwrap();
    std::fs::write(&file, "{\"a\":1}").unwrap();
    assert!(verify_control_pins(&[pin]).is_err());
    // A link at the file's name is replaced, never written through.
    let (file2, _, _) = write_managed_claude(tmp.path(), "{\"b\":1}").unwrap();
    let outside = tmp.path().join("outside");
    std::fs::write(&outside, "keep").unwrap();
    std::fs::remove_file(&file2).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, &file2).unwrap();
        write_managed_claude(tmp.path(), "{\"b\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        assert!(!std::fs::symlink_metadata(&file2).unwrap().file_type().is_symlink());
    }
}

#[test]
fn both_wrappers_pin_or_refuse_a_verified_claude_tab() {
    let fence = source("services/agent/agent_fence.rs");
    let linux = body_of(&fence, "pub fn wrap_pty_options_bwrap(");
    assert!(linux.contains("claude_managed_for(opts)"), "the bubblewrap wrapper must build the pin");
    assert!(linux.contains("managed_claude_args("), "the bubblewrap wrapper must place the pin");
    assert!(linux.contains("verify_control_pins(&managed_pins)"), "the pinned file is checked last, like the other control paths");
    let mac = body_of(&fence, "pub fn wrap_pty_options_sandbox_exec(");
    assert!(mac.contains("claude_managed_for(opts)") && mac.contains("CLAUDE_NOT_PINNABLE"), "Seatbelt refuses a verified Claude tab");
}

#[test]
fn the_cut_fence_binds_the_lane_after_the_private_run_and_starts_the_cli_behind_the_relay() {
    use crate::services::agent_fence::{bwrap_args, insert_local_lane};
    use crate::services::local_lane::FenceLane;
    let plain = bwrap_args("/home/u", Some("/state/agent-homes/x"), "/w/p", "claude", &["--x".into()], &[PathBuf::from("/w/p")], &[], &[]);
    assert!(!plain.iter().any(|a| a == "--unshare-net"), "a project with its network on keeps it");
    let lane = FenceLane {
        ollama_socket: PathBuf::from("/state/local-lane/h.sock"),
        mcp_socket: Some(PathBuf::from("/state/local-lane/h.mcp.sock")),
        ollama_port: 11434,
        mcp_port: Some(40000),
    };
    let mut args = plain.clone();
    insert_local_lane(&mut args, lane.binds(Path::new("/opt/app/bin")), lane.command_prefix()).unwrap();
    let at = |needle: &str| args.iter().position(|a| a == needle).unwrap_or_else(|| panic!("{needle} missing in {args:?}"));
    let slug = crate::brand::SLUG;
    let run = args.windows(2).position(|w| w == ["--tmpfs", "/run"]).unwrap();
    let relay_bind = at(&format!("/run/{slug}-lane/relay"));
    let sock_bind = at(&format!("/run/{slug}-lane/ollama.sock"));
    let home_bind = args.windows(2).position(|w| w == ["--bind", "/state/agent-homes/x"]).unwrap();
    assert!(run < relay_bind && relay_bind < sock_bind, "the lane is bound after the private /run exists");
    assert!(sock_bind < home_bind, "the sources are resolved before the home is replaced");
    assert_eq!(args.iter().filter(|a| *a == "--unshare-net").count(), 1);
    let sep = at("--");
    assert!(at("--unshare-net") < sep && at("--unshare-pid") < at("--unshare-net"));
    // The fence's command is the relay, then the CLI's own line behind `--`.
    assert_eq!(args[sep + 1], format!("/run/{slug}-lane/relay"));
    assert_eq!(args[sep + 2], "--local-relay");
    assert_eq!(args[args.len() - 2..], ["claude", "--x"]);
    assert_eq!(args[args.len() - 3], "--");
    // A fence argv without a private /run, or without a command, is an error and not a guess.
    assert!(insert_local_lane(&mut vec!["--".to_string()], vec![], vec![]).is_err());
}

#[test]
fn the_wrappers_the_lane_and_the_exit_are_wired() {
    let fence = source("services/agent/agent_fence.rs");
    let linux = body_of(&fence, "pub fn wrap_pty_options_bwrap(");
    assert!(linux.contains("fence_cut(project, &opts.id)") && linux.contains("add_local_lane("), "the Linux wrapper opens the lane for a cut tab");
    let lane = linux.find("add_local_lane(").unwrap();
    assert!(lane > linux.find("mask_local_models_only(").unwrap(), "the lane is opened after every mask, so a refusal above leaves none");
    assert!(linux.contains("local_lane::close"), "a later failure closes the lane again");
    let mac = body_of(&fence, "pub fn wrap_pty_options_sandbox_exec(");
    assert!(mac.contains("fence_cut(project, &opts.id)?"), "Seatbelt refuses a cut project");
    for gone in ["pub fn on_tab_gone(", "pub fn abandon_spawn("] {
        assert!(body_of(&fence, gone).contains("local_lane::close(tab_id)"), "{gone}: the lane goes with its tab");
    }
    let lib = source("lib.rs");
    assert!(lib.contains("services::local_lane::stop_for_exit()"), "the lane's sockets are removed at quit");
    let main = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs")).unwrap();
    assert!(main.contains("local_lane::relay::MODE_FLAG"), "main dispatches the relay mode");
    // The relay mode keeps the CLI in its own process: it execs, it does not spawn.
    let relay = source("services/local_lane/relay.rs");
    assert!(relay.contains(".exec()") && !relay.contains(".spawn()"));
}

/// The names in `export const <name>: readonly string[] = ["a", "b"];` of the frontend's
/// `localModelsOnly.ts`.
fn ts_list(name: &str) -> Vec<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/projects/localModelsOnly.ts");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let head = format!("export const {name}: readonly string[] = [");
    let at = text.find(&head).unwrap_or_else(|| panic!("{name} not found in localModelsOnly.ts"));
    let rest = &text[at + head.len()..];
    rest[..rest.find(']').unwrap()].split(',').map(|s| s.trim().trim_matches('"').to_string()).filter(|s| !s.is_empty()).collect()
}

#[test]
fn the_frontends_driver_lists_are_the_backends() {
    // The menus (desktop and phone) hide what the gate refuses; two lists with nothing
    // tying them would drift. The frontend's list of what a locked project with its network
    // on refuses, and of what a cut project starts, are the backend's.
    assert_eq!(ts_list("LOCKED_REFUSED_DRIVERS"), REFUSED_DRIVERS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert_eq!(ts_list("CUT_VERIFIED_DRIVERS"), CUT_VERIFIED_DRIVERS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
}

// ── Agents no registry PTY holds: headless tabs and sessions that outlived a crash ──

fn agent_session(project: &str, n: u32) -> String {
    format!("{}{}--agent-{n:010}", crate::brand::TMUX_PREFIX, crate::storage::project_key(project))
}

fn tmux_agent(session: &str, cwd: &str) -> TmuxAgent {
    TmuxAgent { session: session.to_string(), cwd: cwd.to_string() }
}

fn known(tab: &str, session: &str, visible: &[&str], masked: &[&str]) -> KnownSession {
    KnownSession {
        tab: tab.to_string(),
        tmux: session.to_string(),
        view: Some(FenceView {
            visible: visible.iter().map(PathBuf::from).collect(),
            masked: masked.iter().map(PathBuf::from).collect(),
        }),
    }
}

#[test]
fn the_switch_ends_a_phone_started_headless_agent_and_a_session_that_outlived_a_crash() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("secret");
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    let dir_s = s(&dir);
    let (own, parent, other, hidden, verified, held, shell) = (
        agent_session("lock", 1),
        agent_session("parent", 2),
        agent_session("elsewhere", 3),
        agent_session("boxed", 4),
        agent_session("lock", 5),
        agent_session("lock", 6),
        format!("{}{}--shell-0000000007", crate::brand::TMUX_PREFIX, crate::storage::project_key("lock")),
    );
    let sessions = vec![
        tmux_agent(&own, &dir_s),
        tmux_agent(&parent, &s(tmp.path())),
        tmux_agent(&other, "/somewhere/else"),
        tmux_agent(&hidden, &s(tmp.path())),
        tmux_agent(&verified, &dir_s),
        tmux_agent(&held, &dir_s),
        tmux_agent(&shell, &dir_s),
    ];
    // A headless phone tab of the parent project: its recorded fence shows the folder.
    // A box tab's fence hid it. The verified tab is the gate's.
    let known = vec![
        known("parent:agent-2", &parent, &[&s(tmp.path())], &[]),
        known("boxed:agent-4", &hidden, &[&s(tmp.path())], &[&dir_s]),
        known("lock:agent-5", &verified, &[&dir_s], &[]),
    ];
    let is_verified = |tab: &str| tab == "lock:agent-5";
    let ended = tmux_sessions_to_end("lock", Some(&dir), &sessions, std::slice::from_ref(&held), &known, &is_verified);
    // `own` is unknown (a crash survivor) and the project's own; `parent` is known and sees the folder.
    // `other` is unknown and unrelated: stays. `hidden` saw nothing: stays. `verified` stays;
    // `held` is a registry PTY's (ended by the PTY path); a shell session is not an agent.
    assert_eq!(ended, vec![own.clone(), parent.clone()]);
}

#[test]
fn an_unknown_view_that_overlaps_the_folder_is_ended_and_one_that_does_not_is_left() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("work").join("secret");
    std::fs::create_dir_all(&dir).unwrap();
    let run = |cwd: &str| {
        let session = agent_session("someone", 9);
        tmux_sessions_to_end("lock", Some(&dir), &[tmux_agent(&session, cwd)], &[], &[], &|_| false).len()
    };
    assert_eq!(run(&s(&dir)), 1, "in the folder");
    assert_eq!(run(&s(&dir.join("deeper"))), 1, "below it");
    assert_eq!(run(&s(dir.parent().unwrap())), 1, "above it");
    assert_eq!(run(&s(tmp.path())), 1, "further above");
    assert_eq!(run(""), 1, "no folder known: fail closed");
    assert_eq!(run(&s(&tmp.path().join("work").join("secret-neighbour"))), 0, "a sibling sharing a prefix");
    assert_eq!(run("/somewhere/else"), 0);
    // A project id that itself holds `--` still names agent sessions as agents.
    let odd = agent_session("a--b", 3);
    assert_eq!(tmux_sessions_to_end("lock", Some(&dir), &[tmux_agent(&odd, &s(&dir))], &[], &[], &|_| false), vec![odd]);
    // A known spawn that recorded no view falls back to the same rule.
    let session = agent_session("someone", 9);
    let blind = KnownSession { tab: "someone:agent-9".into(), tmux: session.clone(), view: None };
    let sessions = [tmux_agent(&session, &s(&dir))];
    assert_eq!(tmux_sessions_to_end("lock", Some(&dir), &sessions, &[], &[blind], &|_| false), vec![session]);
}

#[test]
fn the_headless_spawn_records_its_view_and_session_and_the_switch_sweeps_them() {
    // `prepare` leaves the fence view and `commit` attaches it to the live spawn together
    // with the tmux session; the headless owner commits after the detached spawn.
    let prep = source("services/launch_prep.rs");
    let commit = body_of(&prep, "pub fn commit(mut self)");
    assert!(commit.contains("note_live_fence_view("), "commit records the view");
    assert!(commit.contains("note_live_tmux("), "commit records the session");
    let host = source("services/mobile_control/host.rs");
    let launch = body_of(&host, "impl Default for HeadlessSpawner");
    assert!(
        launch.find("spawn_detached_with(").unwrap() < launch.find("prepared.commit()").unwrap(),
        "the headless launch commits the prepared spawn"
    );
    let command = source("commands/agent_privacy.rs");
    let close = body_of(&command, "async fn close_unverified_agents(");
    assert!(close.contains("end_detached_agents("), "the switch sweeps the sessions no PTY holds");
    let sweep = body_of(&command, "fn end_detached_agents(");
    assert!(sweep.contains("tmux_sessions_to_end(") && sweep.contains("reap_child_subtree(") && sweep.contains("local_tmux_kill_args("));
}
