/// The detail payload's `terminals` field has exactly two values, and the
/// host's own answer is the one `live_tmux` short-circuits on: a Windows
/// build says `unsupported` and lists no session, every other says `tmux`.
#[test]
fn terminals_support_names_tmux_or_unsupported() {
    assert_eq!(super::terminals_support_on(false), super::TERMINALS_TMUX);
    assert_eq!(super::terminals_support_on(true), super::TERMINALS_UNSUPPORTED);
    assert_eq!(super::terminals_support(), super::terminals_support_on(cfg!(target_os = "windows")));
    for value in [super::TERMINALS_TMUX, super::TERMINALS_UNSUPPORTED] {
        let row = serde_json::json!({ "shells": false, "terminals": value });
        assert_eq!(row["terminals"].as_str(), Some(value));
    }
    if cfg!(target_os = "windows") {
        assert!(super::live_tmux().is_ok_and(|live| live.is_empty()));
    }
}

/// A saved tab keeps the session name it was created with, and a remote
/// session keeps running across an update: the name an older build
/// minted still matches its tab, and is counted.
#[test]
fn a_session_minted_under_the_old_prefix_still_matches_its_tab() {
    use crate::brand::{Name, LEGACY};
    use crate::services::brand_migration::{hits, testing::RENAMED};
    let _ = hits::taken();
    let old = format!("{}p1--agent-123456789", LEGACY.name(Name::TMUX_PREFIX));
    assert!(super::expected_tmux_for(&RENAMED, "p1", "agent", &old));
    assert_eq!(hits::taken(), ["tmux-prefix"]);
    assert!(super::expected_tmux_for(&RENAMED, "p1", "agent", "newname-p1--agent-123456789"));
    assert!(!super::expected_tmux_for(&RENAMED, "p2", "agent", &old));
    assert!(!super::expected_tmux_for(&RENAMED, "p1", "agent", "other-p1--agent-123456789"));
}

/// The serde keys are literals in the attributes; this ties them to the
/// brand module so they cannot drift.
#[test]
fn the_mobile_access_key_is_the_brand_constant() {
    let key = crate::brand::MOBILE_ACCESS_KEY;
    let project: super::ProjectRecord =
        serde_json::from_str(&format!(r#"{{"id":"p","name":"P","status":"active","{key}":true}}"#)).unwrap();
    assert!(project.app_mobile_access);
    let b: super::BoxRecord = serde_json::from_str(&format!(r#"{{"id":"b","name":"B","{key}":true}}"#)).unwrap();
    assert!(b.app_mobile_access);
}

/// The per-phone list's serde key is a literal too, and it is read
/// leniently: absent is every phone, a list is those ids, anything else
/// is no phone — and never a parse error for the record.
#[test]
fn the_mobile_devices_key_is_the_brand_constant_and_read_leniently() {
    let key = crate::brand::MOBILE_DEVICES_KEY;
    let project = |value: &str| -> super::ProjectRecord {
        let extra = if value.is_empty() { String::new() } else { format!(r#","{key}":{value}"#) };
        serde_json::from_str(&format!(r#"{{"id":"p","name":"P","status":"active"{extra}}}"#)).unwrap()
    };
    assert_eq!(project("").app_mobile_devices, None);
    assert_eq!(project(r#"["d1","d2"]"#).app_mobile_devices, Some(vec!["d1".to_string(), "d2".to_string()]));
    for malformed in ["[]", "null", r#""d1""#, r#"["d1",2]"#, "{}"] {
        assert_eq!(project(malformed).app_mobile_devices, Some(vec![]), "{malformed}");
    }
    let b: super::BoxRecord = serde_json::from_str(&format!(r#"{{"id":"b","name":"B","{key}":7}}"#)).unwrap();
    assert_eq!(b.app_mobile_devices, Some(vec![]));
}

/// The phone's access is read under the current key only. A key an older
/// build left behind must not open a project the window (which reads the
/// current key) shows as closed; and a record with both keys still parses.
#[test]
fn a_leftover_old_access_key_opens_nothing() {
    if !crate::brand::PAIR.renamed() {
        return;
    }
    let old = crate::brand::LEGACY_MOBILE_ACCESS_KEY;
    let new = crate::brand::MOBILE_ACCESS_KEY;
    let project: super::ProjectRecord =
        serde_json::from_str(&format!(r#"{{"id":"p","name":"P","status":"active","{old}":true}}"#)).unwrap();
    assert!(!project.app_mobile_access);
    let b: super::BoxRecord =
        serde_json::from_str(&format!(r#"{{"id":"b","name":"B","{old}":true,"{new}":false}}"#)).unwrap();
    assert!(!b.app_mobile_access);
}

use crate::brand::SLUG;
use super::*;
use super::super::host_live::HostReach;

#[test]
fn agent_counts_keep_working_question_and_done_and_skip_the_rest() {
    let mut counts = AgentCounts::default();
    assert!(!counts.any());
    for status in ["working", "question", "done", "done", "interrupted", "bogus"] {
        counts.add(status);
    }
    assert_eq!(counts, AgentCounts { working: 1, question: 1, done: 2 });
    assert!(counts.any());
    assert_eq!(
        serde_json::to_value(counts).unwrap(),
        serde_json::json!({ "working": 1, "question": 1, "done": 2 })
    );
}

#[test]
fn tmux_ls_runs_through_app_path() {
    let command = tmux_ls_command("#{session_name}");
    let path = command
        .get_envs()
        .find(|(key, _)| *key == "PATH")
        .and_then(|(_, value)| value)
        .expect("PATH is set on the tmux ls spawn");
    let first = std::env::split_paths(path).next().expect("non-empty PATH");
    assert_eq!(first, crate::paths::extra_path_dirs()[0]);
}

#[test]
fn opaque_ids_are_domain_separated_and_stable() {
    let key = [7u8; 32];
    assert_eq!(
        key_id(&key, "project", &["a"]),
        key_id(&key, "project", &["a"])
    );
    assert_ne!(key_id(&key, "project", &["a"]), key_id(&key, "tab", &["a"]));
    assert!(!key_id(&key, "project", &["secret-project"]).contains("secret"));
}

#[test]
fn mobile_protocol_domains_are_accepted_but_arbitrary_ones_are_not() {
    for domain in [
        "agent", "request", "task", "mail", "calendar", "event", "project", "subtask",
        "worktree", "alert",
    ] {
        assert!(valid_opaque_control_domain(domain), "{domain}");
    }
    assert!(!valid_opaque_control_domain("filesystem_path"));
}

/// Every literal domain the desktop bridge mints an opaque id under must be
/// on the allow list. The bridge swallows the command's error in places
/// (the ＋ sheet's worktrees, the alert strip), and vitest mocks `invoke`, so
/// a missing domain otherwise fails silently in production only.
#[test]
fn every_domain_the_bridge_mints_is_allowed() {
    let source = include_str!("../../../../../src/components/mobile/MobileBridgeHost.tsx");
    let mut seen = Vec::new();
    // `invoke("mobile_opaque_id", { domain: "<x>", … })`
    for (at, _) in source.match_indices("\"mobile_opaque_id\"") {
        let rest = source[at + "\"mobile_opaque_id\"".len()..]
            .trim_start_matches(|c: char| c == ',' || c == '{' || c.is_whitespace());
        if let Some(after) = rest.strip_prefix("domain:") {
            if let Some(literal) = after.trim_start().strip_prefix('"') {
                let domain = &literal[..literal.find('"').expect("closed literal")];
                seen.push(domain.to_string());
            }
        }
    }
    // `opaqueId("<x>", …)`, the bridge's own wrapper
    for (at, _) in source.match_indices("opaqueId(\"") {
        let literal = &source[at + "opaqueId(\"".len()..];
        seen.push(literal[..literal.find('"').expect("closed literal")].to_string());
    }
    for domain in ["worktree", "alert", "request", "task", "agent"] {
        assert!(seen.iter().any(|d| d == domain), "scan found no {domain:?} call: {seen:?}");
    }
    for domain in &seen {
        assert!(valid_opaque_control_domain(domain), "the bridge mints {domain:?} ids");
    }
}

#[test]
fn exact_session_names_only() {
    assert!(expected_tmux("p1", "shell", concat!(crate::app_slug!(), "-p1--shell-123456789")));
    assert!(!expected_tmux("p1", "shell", concat!(crate::app_slug!(), "-p2--shell-123456789")));
    assert!(!expected_tmux("p1", "shell", concat!(crate::app_slug!(), "-p1--agent-123456789")));
}

#[test]
fn one_corrupt_session_file_costs_that_project_its_tabs_not_the_whole_catalog() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    allow_shells(state);
    let root_a = state.join("a");
    let root_b = state.join("b");
    fs::create_dir_all(&root_a).expect("root a");
    fs::create_dir_all(&root_b).expect("root b");
    let project = |id: &str, name: &str, root: &Path| {
        serde_json::json!({
            "id": id,
            "name": name,
            "status": "active",
            "directory": root.to_string_lossy(),
            concat!(crate::app_slug!(), "_mobile_access"): true,
        })
    };
    fs::write(
        state.join("projects.json"),
        serde_json::to_vec(&serde_json::json!([
            project("p-a", "A", &root_a),
            project("p-b", "B", &root_b),
        ]))
        .expect("projects"),
    )
    .expect("write projects");
    let sessions = state.join("sessions");
    fs::create_dir_all(sessions.join("p-a")).expect("session a");
    fs::create_dir_all(sessions.join("p-b")).expect("session b");
    fs::write(
        sessions.join("p-a").join("terminals.json"),
        serde_json::to_vec(&serde_json::json!({
            "tabLayout": [{
                "label": "Shell",
                "cmd": "bash",
                "cwd": root_a.to_string_lossy(),
                "kind": "shell",
                "tmuxSession": concat!(crate::app_slug!(), "-p-a--shell-123456789"),
            }]
        }))
        .expect("session"),
    )
    .expect("write session a");
    fs::write(sessions.join("p-b").join("terminals.json"), b"{ not json").expect("corrupt b");

    let catalog = Catalog::load(state, &[7; 32])
        .expect("one unreadable session file must not fail the whole catalog");
    assert_eq!(catalog.projects.len(), 2);
    let a = catalog.projects.iter().find(|p| p.raw_id == "p-a").expect("A");
    let b = catalog.projects.iter().find(|p| p.raw_id == "p-b").expect("B");
    assert_eq!(a.tabs.len(), 1, "the healthy project keeps its tabs");
    assert!(b.tabs.is_empty(), "the corrupt one has none, and is still listed");
}

/// The cache is what keeps an idle phone from forking `tmux ls` twice a
/// second, and it is also what could answer a poll with a tab the reader
/// has just closed: the desktop rewrites the session file before it says
/// "closed", so the only stale thing left is the snapshot's remaining TTL.
/// The close route drops it (`invalidate`) and the next read goes to disk.
#[test]
fn an_invalidated_cache_re_reads_within_the_ttl() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    allow_shells(state);
    let root = state.join("p");
    fs::create_dir_all(&root).expect("root dir");
    fs::write(
        state.join("projects.json"),
        serde_json::to_vec(&serde_json::json!([{
            "id": "p-1",
            "name": "P",
            "status": "active",
            "directory": root.to_string_lossy(),
            concat!(crate::app_slug!(), "_mobile_access"): true,
        }]))
        .expect("projects"),
    )
    .expect("write projects");
    let sessions = state.join("sessions").join("p-1");
    fs::create_dir_all(&sessions).expect("session dir");
    let write_tabs = |tabs: serde_json::Value| {
        fs::write(
            sessions.join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({ "tabLayout": tabs })).expect("session"),
        )
        .expect("write session");
    };
    write_tabs(serde_json::json!([{
        "label": "Shell",
        "cmd": "bash",
        "cwd": root.to_string_lossy(),
        "kind": "shell",
        "tmuxSession": concat!(crate::app_slug!(), "-p-1--shell-123456789"),
    }]));

    let mut cache = CatalogCache::default();
    let tabs = |catalog: &Catalog| catalog.projects[0].tabs.len();
    assert_eq!(tabs(&cache.load(state, &[7; 32]).expect("first read")), 1);

    // The close: the tab leaves the session file the catalog is read from.
    write_tabs(serde_json::json!([]));
    assert_eq!(
        tabs(&cache.load(state, &[7; 32]).expect("cached read")),
        1,
        "the snapshot is still young, so the closed tab is still in it"
    );
    cache.invalidate();
    assert_eq!(
        tabs(&cache.load(state, &[7; 32]).expect("re-read")),
        0,
        "an invalidated cache reads the file the close rewrote"
    );
}

/// A tab colour (#264) is published as the palette id the desktop stored, so
/// the phone resolves it to the same hex — and an id this build does not have
/// is dropped rather than passed on for the phone to guess at, which is the
/// same posture `clean_tab_color` takes on the way in.
#[test]
fn a_tab_publishes_a_palette_colour_and_drops_anything_else() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    allow_shells(state);
    let root = state.join("p");
    fs::create_dir_all(&root).expect("root dir");
    fs::write(
        state.join("projects.json"),
        serde_json::to_vec(&serde_json::json!([{
            "id": "p-1",
            "name": "P",
            "status": "active",
            "directory": root.to_string_lossy(),
            concat!(crate::app_slug!(), "_mobile_access"): true,
        }]))
        .expect("projects"),
    )
    .expect("write projects");
    let sessions = state.join("sessions").join("p-1");
    fs::create_dir_all(&sessions).expect("session dir");
    let tab = |suffix: &str, color: serde_json::Value| {
        serde_json::json!({
            "label": format!("Shell {suffix}"),
            "cmd": "bash",
            "cwd": root.to_string_lossy(),
            "kind": "shell",
            "tmuxSession": format!("{SLUG}-p-1--shell-10000000{suffix}"),
            "color": color,
        })
    };
    fs::write(
        sessions.join("terminals.json"),
        serde_json::to_vec(&serde_json::json!({
            "tabLayout": [
                tab("1", serde_json::json!("teal")),
                tab("2", serde_json::json!("chartreuse")),
                tab("3", serde_json::Value::Null),
            ]
        }))
        .expect("session"),
    )
    .expect("write session");

    let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
    let project = catalog.projects.first().expect("project");
    let colors: Vec<Option<&str>> = project
        .tabs
        .iter()
        .map(|t| t.public.color.as_deref())
        .collect();
    assert_eq!(colors, vec![Some("teal"), None, None]);
}

/// The root console reaches the phone by its own switch and gate only
/// (`root_open`) — never through a `projects.json` record hand-edited to
/// take the root scope's id (and with it `sessions/root/`).
#[test]
fn the_root_scope_is_listed_by_its_switch_and_gate_alone() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let root = state.join("root");
    fs::create_dir_all(&root).expect("root dir");
    fs::write(
        state.join("projects.json"),
        serde_json::to_vec(&serde_json::json!([{
            "id": "root",
            "name": "Borrowed",
            "status": "active",
            "directory": root.to_string_lossy(),
            concat!(crate::app_slug!(), "_mobile_access"): true,
        }]))
        .expect("projects"),
    )
    .expect("write projects");
    fs::create_dir_all(state.join("sessions").join("root")).expect("session dir");
    fs::write(
        state.join("sessions").join("root").join("terminals.json"),
        serde_json::to_vec(&serde_json::json!({
            "tabLayout": [{
                "label": "Claude",
                "cmd": "claude",
                "cwd": root.to_string_lossy(),
                "kind": "agent",
                "sessionId": "s1",
                "tmuxSession": concat!(crate::app_slug!(), "-root--agent-123456789"),
            }]
        }))
        .expect("session"),
    )
    .expect("write session");
    let fenced = RootEnv { dir: root.clone(), fenced: || true };
    let unfenced = RootEnv { dir: root.clone(), fenced: || false };
    let load = |settings: Option<serde_json::Value>, env: &RootEnv| {
        match settings {
            Some(mut value) => {
                // The assistant (on by default) would list a scope of its own;
                // this test is about root.
                if let Some(object) = value.as_object_mut() {
                    object.entry("assistant").or_insert(false.into());
                }
                fs::write(state.join("settings.json"), value.to_string()).expect("settings")
            }
            None => { let _ = fs::remove_file(state.join("settings.json")); }
        }
        Catalog::load_with(state, &[7; 32], env, &HashMap::new(), &HostLive::default(), true).expect("catalog").projects
    };
    let host = |on: bool| serde_json::json!({ "enabled": true, "root_access": on });

    // No settings, or the switch unset/off: the borrowed record is refused
    // and nothing else lists root.
    assert!(load(None, &fenced).is_empty());
    assert!(load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true } })), &fenced).is_empty());
    assert!(load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(false) })), &fenced).is_empty());

    // Switched on, default review, fenced: one Root row — the gate's, not
    // the borrowed record's — with its tab and a pending count.
    let listed = load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(true) })), &fenced);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].public.kind, ScopeKind::Root);
    assert_eq!(listed[0].public.label, "Root");
    assert_eq!(listed[0].raw_id, "root");
    assert_eq!(listed[0].tabs.len(), 1);
    assert_eq!(listed[0].public.pending_reviews, Some(0));
    // An unknown review value reads as `all`, as it does for the tools.
    assert_eq!(load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(true), "root_mcp_review": "later" })), &fenced).len(), 1);

    // Tools on but writes not staged behind a fence: closed.
    assert!(load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(true) })), &unfenced).is_empty());
    for level in ["destructive", "off"] {
        assert!(
            load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(true), "root_mcp_review": level })), &fenced).is_empty(),
            "{level}"
        );
    }
    // Tools off: a root agent holds nothing extra, so neither matters.
    assert_eq!(
        load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(true), "root_mcp": false, "root_mcp_review": "off" })), &unfenced).len(),
        1
    );
    // Unreadable settings refuse.
    fs::write(state.join("settings.json"), b"{").expect("corrupt settings");
    assert!(Catalog::load_with(state, &[7; 32], &fenced, &HashMap::new(), &HostLive::default(), true).expect("catalog").projects.is_empty());

    assert!(is_root_scope_id("root"));
    assert!(!is_root_scope_id("rooted"));
}

const CHAT_A: &str = "0b9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a10";
const CHAT_B: &str = "1c9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a11";

/// One saved assistant tab: `launch` is the strict block, `cwd` the folder.
fn chat_tab(uid: &str, cwd: &Path, launch: serde_json::Value, tmux_tail: &str) -> serde_json::Value {
    serde_json::json!({
        "label": "Claude", "cmd": "claude", "cwd": cwd.to_string_lossy(), "kind": "agent",
        "sessionId": uid, "assistant": launch,
        "tmuxSession": format!("{}assistant--agent-{tmux_tail}", crate::brand::TMUX_PREFIX),
    })
}

fn assistant_state(settings: Option<serde_json::Value>, tabs: Vec<serde_json::Value>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    fs::write(state.join("projects.json"), "[]").expect("projects");
    if let Some(settings) = settings {
        fs::write(state.join("settings.json"), settings.to_string()).expect("settings");
    }
    let sessions = state.join("sessions").join("assistant");
    fs::create_dir_all(&sessions).expect("session dir");
    fs::write(sessions.join("terminals.json"), serde_json::json!({ "tabLayout": tabs }).to_string()).expect("session");
    dir
}

fn load_assistant(state: &Path) -> Vec<ResolvedProject> {
    let env = RootEnv { dir: state.join("root"), fenced: || true };
    Catalog::load_with(state, &[7; 32], &env, &HashMap::new(), &HostLive::default(), true).expect("catalog").projects
}

/// Decision D9 (gap 57): the assistant scope has a per-phone list like a
/// project or box. Absent reaches every phone; a list only those; an empty
/// or malformed one, none. The catalog, the per-phone view (`for_device`)
/// and the checks a phone's prompt or schedule faces (`ScopeAccess`) agree.
#[test]
fn the_assistant_scope_has_a_per_phone_list_absent_is_every_phone_empty_is_none() {
    let host = crate::brand::MOBILE_HOST_KEY;
    let settings = |devices: Option<serde_json::Value>| {
        let mut block = serde_json::json!({ "enabled": true });
        if let Some(devices) = devices {
            block["assistant_devices"] = devices;
        }
        serde_json::json!({ "assistant": true, host: block })
    };
    let reaching = |devices: Option<serde_json::Value>, phone: &str| {
        let dir = assistant_state(Some(settings(devices)), vec![]);
        let env = RootEnv { dir: dir.path().join("root"), fenced: || true };
        let catalog = Catalog::load_with(dir.path(), &[7; 32], &env, &HashMap::new(), &HostLive::default(), true).expect("catalog");
        let listed = catalog.projects.iter().any(|p| p.raw_id == "assistant");
        let seen = catalog.for_device(phone).projects.iter().any(|p| p.raw_id == "assistant");
        let access = ScopeAccess::load_with(dir.path(), &env).expect("access").reaches("assistant", phone);
        (listed, seen, access)
    };
    // Absent: every phone, those paired later too.
    assert_eq!(reaching(None, "d1"), (true, true, Ok(true)));
    assert_eq!(reaching(None, "d9"), (true, true, Ok(true)));
    // A list: those phones only. The scope stays in the snapshot.
    let list = Some(serde_json::json!(["d1", "d2"]));
    assert_eq!(reaching(list.clone(), "d1"), (true, true, Ok(true)));
    assert_eq!(reaching(list, "d3"), (true, false, Ok(false)));
    // Empty, or anything that is not a list of strings: no phone.
    for none in [serde_json::json!([]), serde_json::json!("d1"), serde_json::json!(["d1", 2]), serde_json::Value::Null] {
        assert_eq!(reaching(Some(none.clone()), "d1"), (true, false, Ok(false)), "{none}");
    }
    // The list narrows the switch; it never opens a closed one.
    let dir = assistant_state(
        Some(serde_json::json!({ "assistant": true, host: { "assistant_access": false, "assistant_devices": ["d1"] } })),
        vec![],
    );
    assert!(load_assistant(dir.path()).is_empty());
    // Unreadable settings are no phone either.
    let dir = tempfile::tempdir().expect("state dir");
    fs::write(dir.path().join("settings.json"), b"{").expect("corrupt");
    assert_eq!(assistant_devices(dir.path()), Some(Vec::new()));
}

/// The chat assistant reaches the phone by its switch and gate alone
/// (`assistant_open`), as a scope of its own kind rooted in the work
/// folder: listed before its folder exists (so the phone can start the
/// first chat), with only the tabs that carry a valid launch and live in
/// their own `work/<uid>` folder.
#[test]
fn the_assistant_scope_is_listed_by_its_gate_alone_and_keeps_only_chats() {
    let on = serde_json::json!({ "assistant": true });
    let work = |state: &Path| crate::services::assistant::work_root(state);
    let valid = serde_json::json!({ "cli": "claude" });

    // Off: the flag written false, or the Mobile switch off, or no settings,
    // or an unreadable file. (Unset is on.)
    assert!(!load_assistant(assistant_state(Some(serde_json::json!({})), vec![]).path()).is_empty());
    for settings in [
        None,
        Some(serde_json::json!({ "assistant": false })),
        Some(serde_json::json!({ "assistant": true, crate::brand::MOBILE_HOST_KEY: { "assistant_access": false } })),
    ] {
        let dir = assistant_state(settings, vec![]);
        assert!(load_assistant(dir.path()).is_empty());
    }
    let dir = assistant_state(None, vec![]);
    fs::write(dir.path().join("settings.json"), b"{").expect("corrupt");
    assert!(load_assistant(dir.path()).is_empty());

    // On, no work folder yet: one assistant row, no tab.
    let dir = assistant_state(Some(on.clone()), vec![]);
    let listed = load_assistant(dir.path());
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].public.kind, ScopeKind::Assistant);
    assert_eq!(listed[0].public.label, crate::brand::ASSISTANT_NAME);
    assert_eq!(listed[0].raw_id, "assistant");
    assert!(listed[0].tabs.is_empty());
    assert_eq!(listed[0].public.pending_reviews, None);
    assert_eq!(serde_json::to_value(&listed[0].public).unwrap()["kind"], "assistant");

    // Chats: A is good, the rest are each wrong in one way.
    let dir = assistant_state(Some(on.clone()), vec![]);
    let state = dir.path();
    let (a, b) = (work(state).join(CHAT_A), work(state).join(CHAT_B));
    fs::create_dir_all(&a).expect("chat a");
    fs::create_dir_all(&b).expect("chat b");
    let outside = state.join("elsewhere");
    fs::create_dir_all(&outside).expect("outside");
    let mut local = chat_tab(CHAT_A, &a, serde_json::json!({ "cli": "opencode_local", "model": "qwen3:8b" }), "ccccccccc1");
    local["cmd"] = "opencode".into();
    let mut shell = chat_tab(CHAT_A, &a, valid.clone(), "ccccccccc2");
    shell["kind"] = "shell".into();
    let mut local_launch = chat_tab(CHAT_A, &a, valid.clone(), "ccccccccc3");
    local_launch["localLaunch"] = serde_json::json!({ "driver": "claude", "model": "m", "args": [] });
    let mut sign_in = chat_tab(CHAT_A, &a, valid.clone(), "ccccccccc4");
    sign_in["signIn"] = true.into();
    let mut wrong_bin = chat_tab(CHAT_A, &a, valid.clone(), "ccccccccc5");
    wrong_bin["cmd"] = "codex".into();
    let mut no_block = chat_tab(CHAT_A, &a, valid.clone(), "ccccccccc6");
    no_block.as_object_mut().unwrap().remove("assistant");
    let tabs = vec![
        chat_tab(CHAT_A, &a, valid.clone(), "bbbbbbbbb1"),
        local,
        shell,
        local_launch,
        sign_in,
        wrong_bin,
        no_block,
        // An unknown key in the block, a bad model, an unoffered cli.
        chat_tab(CHAT_A, &a, serde_json::json!({ "cli": "claude", "args": ["--x"] }), "ddddddddd1"),
        chat_tab(CHAT_A, &a, serde_json::json!({ "cli": "claude", "model": "--evil" }), "ddddddddd2"),
        chat_tab(CHAT_A, &a, serde_json::json!({ "cli": "gemini" }), "ddddddddd3"),
        // Not uuid-shaped, another chat's folder, a folder elsewhere, a project folder.
        chat_tab("not-a-uuid", &a, valid.clone(), "eeeeeeeee1"),
        chat_tab(CHAT_A, &b, valid.clone(), "eeeeeeeee2"),
        chat_tab(CHAT_A, &outside, valid.clone(), "eeeeeeeee3"),
        chat_tab(CHAT_A, &work(state), valid.clone(), "eeeeeeeee4"),
        // A tmux name of another scope.
        {
            let mut other = chat_tab(CHAT_B, &b, valid.clone(), "fffffffff1");
            other["tmuxSession"] = format!("{}p1--agent-fffffffff1", crate::brand::TMUX_PREFIX).into();
            other
        },
        chat_tab(CHAT_B, &b, valid, "bbbbbbbbb2"),
    ];
    fs::write(
        state.join("sessions").join("assistant").join("terminals.json"),
        serde_json::json!({ "tabLayout": tabs }).to_string(),
    )
    .expect("session");
    let listed = load_assistant(state);
    assert_eq!(listed.len(), 1);
    let kept: Vec<_> = listed[0].tabs.iter().map(|t| (t.session_id.as_deref().unwrap(), t.cmd.as_str(), t.local_model)).collect();
    assert_eq!(kept, [(CHAT_A, "claude", false), (CHAT_A, "opencode", true), (CHAT_B, "claude", false)]);
    assert!(listed[0].tabs.iter().all(|t| t.public.kind == "agent"));
    // Each chat names its launch by the id `launch-options` lists for it.
    use crate::services::assistant::AssistantCli;
    let launches: Vec<_> = listed[0].tabs.iter().map(|t| t.public.assistant_launch.clone()).collect();
    assert_eq!(
        launches,
        [
            Some(super::super::assistant::launch_handle(&[7; 32], AssistantCli::Claude, None)),
            Some(super::super::assistant::launch_handle(&[7; 32], AssistantCli::OpenCodeLocal, Some("qwen3:8b"))),
            Some(super::super::assistant::launch_handle(&[7; 32], AssistantCli::Claude, None)),
        ]
    );
    assert_eq!(listed[0].root, work(state).canonicalize().unwrap());

    // A symlinked chat folder that points out is not "below" the work folder.
    #[cfg(unix)]
    {
        let link = work(state).join("1d9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a12");
        std::os::unix::fs::symlink(&outside, &link).expect("link");
        let linked = chat_tab("1d9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a12", &link, serde_json::json!({ "cli": "claude" }), "ggggggggg1");
        let mut tabs = tabs.clone();
        tabs.push(linked);
        fs::write(state.join("sessions").join("assistant").join("terminals.json"), serde_json::json!({ "tabLayout": tabs }).to_string()).expect("session");
        assert_eq!(load_assistant(state)[0].tabs.len(), 3);
    }
}

/// The raw-JSON gate and `Settings::assistant_phone_open` are one rule:
/// every combination of the flag, Debug mode, the explicit marker and the
/// Mobile switch, and a value of the wrong type (which fails the typed
/// parse, so reads as off, and closes this reader too).
#[test]
fn the_raw_json_gate_agrees_with_the_typed_settings() {
    let dir = tempfile::tempdir().expect("state dir");
    let agree = |settings: serde_json::Value| {
        fs::write(dir.path().join("settings.json"), settings.to_string()).expect("settings");
        let typed = serde_json::from_value::<crate::schema::Settings>(settings.clone())
            .map(|s| s.assistant_phone_open())
            .unwrap_or(false);
        assert_eq!(assistant_open(dir.path()), typed, "{settings}");
        typed
    };
    let states = [None, Some(true), Some(false)];
    let mut opened = 0;
    for flag in states {
        for debug in states {
            for explicit in states {
                for access in states {
                    let mut settings = serde_json::Map::new();
                    for (key, value) in [("assistant", flag), ("debug", debug), ("experimental_explicit", explicit)] {
                        if let Some(value) = value {
                            settings.insert(key.into(), value.into());
                        }
                    }
                    let mut host = serde_json::Map::from_iter([("enabled".to_string(), true.into())]);
                    if let Some(access) = access {
                        host.insert("assistant_access".into(), access.into());
                    }
                    settings.insert(crate::brand::MOBILE_HOST_KEY.into(), host.into());
                    opened += usize::from(agree(settings.into()));
                }
            }
        }
    }
    assert!(opened > 0 && opened < 81);
    // No Mobile block at all.
    assert!(agree(serde_json::json!({ "assistant": true })));
    // On by default, Debug mode or not; only an explicit `false` closes it.
    assert!(agree(serde_json::json!({})));
    assert!(agree(serde_json::json!({ "debug": true, "experimental_explicit": true })));
    assert!(!agree(serde_json::json!({ "assistant": false })));
    // Wrong types close both.
    for bad in [
        serde_json::json!({ "assistant": "yes" }),
        serde_json::json!({ "assistant": true, "debug": 1 }),
        serde_json::json!({ "assistant": true, crate::brand::MOBILE_HOST_KEY: { "assistant_access": "no" } }),
    ] {
        assert!(!agree(bad));
    }
    // Missing and unreadable files refuse.
    fs::remove_file(dir.path().join("settings.json")).expect("remove");
    assert!(!assistant_open(dir.path()));
}

/// A phone-made prompt or schedule is checked against the same gate
/// (`phone_origin`): the assistant scope reaches every paired phone while
/// open, none once either switch is off, and is unknown (`Err`) while the
/// settings file cannot be read. Spellings of its id never reach a project.
#[test]
fn scope_access_follows_the_assistant_gate() {
    let dir = assistant_state(Some(serde_json::json!({ "assistant": true })), vec![]);
    let env = RootEnv { dir: dir.path().join("root"), fenced: || true };
    let access = ScopeAccess::load_with(dir.path(), &env).expect("access");
    assert_eq!(access.reaches("assistant", "PHONE"), Ok(true));
    assert_eq!(access.reaches("Assistant", "PHONE"), Ok(false), "only the scope's own spelling is a scope id");
    fs::write(dir.path().join("settings.json"), serde_json::json!({ "assistant": true, crate::brand::MOBILE_HOST_KEY: { "assistant_access": false } }).to_string()).expect("off");
    let access = ScopeAccess::load_with(dir.path(), &env).expect("access");
    assert_eq!(access.reaches("assistant", "PHONE"), Ok(false));
    fs::write(dir.path().join("settings.json"), b"{").expect("corrupt");
    let access = ScopeAccess::load_with(dir.path(), &env).expect("access");
    assert!(access.reaches("assistant", "PHONE").is_err());
    assert!(is_assistant_scope_id("assistant") && is_assistant_scope_id(" Assistant ") && !is_assistant_scope_id("assistants"));
    assert!(valid_opaque_control_domain("assistant"));
}

/// An open chat terminal is granted by the catalog while the gate is open
/// and loses the grant at the next load once either switch goes off —
/// which is what `pty_bridge`'s five-second re-check closes it on
/// (`recheck`: a catalog that no longer lists the tab is `access_revoked`).
#[test]
fn an_open_chat_loses_its_grant_when_the_gate_closes() {
    let tmux = format!("{}assistant--agent-bbbbbbbbb1", crate::brand::TMUX_PREFIX);
    let dir = assistant_state(Some(serde_json::json!({ "assistant": true })), vec![]);
    let state = dir.path();
    let chat = crate::services::assistant::work_root(state).join(CHAT_A);
    fs::create_dir_all(&chat).expect("chat folder");
    fs::write(
        state.join("sessions").join("assistant").join("terminals.json"),
        serde_json::json!({ "tabLayout": [chat_tab(CHAT_A, &chat, serde_json::json!({ "cli": "claude" }), "bbbbbbbbb1")] }).to_string(),
    )
    .expect("session");
    let live = HashMap::from([(tmux.clone(), LiveTmux { activity: 5, cwd: chat.canonicalize().unwrap() })]);
    let env = RootEnv { dir: state.join("root"), fenced: || true };
    let load = || Catalog::load_with(state, &[7; 32], &env, &live, &HostLive::default(), true).expect("catalog");
    let open = load();
    let tab_id = open.projects[0].tabs[0].public.id.clone();
    assert!(open.grants(&tab_id, &tmux));
    assert!(open.projects[0].tabs[0].public.available);
    for off in [
        serde_json::json!({ "assistant": false }),
        serde_json::json!({ "assistant": true, crate::brand::MOBILE_HOST_KEY: { "assistant_access": false } }),
    ] {
        fs::write(state.join("settings.json"), off.to_string()).expect("off");
        let closed = load();
        assert!(!closed.grants(&tab_id, &tmux), "{off}");
        assert!(closed.projects.is_empty());
    }
}

/// A `projects.json` record that takes the chat assistant's id — or root's
/// in another spelling — is listed by nobody: the catalog has no such
/// source (until the assistant's own switch lists it), and the record does
/// not borrow its session folder.
#[test]
fn a_project_record_cannot_borrow_a_reserved_scope() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let folder = state.join("folder");
    fs::create_dir_all(&folder).expect("folder");
    let records: Vec<serde_json::Value> = ["assistant", "Assistant", "assistant ", "ASSISTANT", "Root"]
        .iter()
        .map(|id| {
            serde_json::json!({
                "id": id, "name": "Borrowed", "status": "active",
                "directory": folder.to_string_lossy(),
                concat!(crate::app_slug!(), "_mobile_access"): true,
            })
        })
        .chain(std::iter::once(serde_json::json!({
            "id": "p1", "name": "Real", "status": "active",
            "directory": folder.to_string_lossy(),
            concat!(crate::app_slug!(), "_mobile_access"): true,
        })))
        .collect();
    fs::write(state.join("projects.json"), serde_json::to_vec(&records).expect("projects")).expect("write projects");
    let env = RootEnv { dir: folder, fenced: || true };
    let sources = scope_sources(state, &env).expect("sources");
    assert_eq!(sources.iter().map(|s| s.raw_id.as_str()).collect::<Vec<_>>(), ["p1"]);
}

/// A tab a headless create stamped reads only sessions begun since its
/// launch; one started on `--continue`, or never stamped, reads the
/// folder's newest.
#[test]
fn a_fresh_tab_reads_since_its_launch_unless_continued() {
    let saved = |args: Value, launched_at: Option<Value>| {
        serde_json::from_value::<SavedTab>(serde_json::json!({
            "label": "OpenCode", "cmd": "opencode", "cwd": "/p", "kind": "agent",
            "args": args, "launchedAt": launched_at,
        }))
        .expect("saved tab")
    };
    assert_eq!(fresh_since(&saved(serde_json::json!([]), Some(serde_json::json!(1_700_000_000_123_i64)))), Some(1_700_000_000_123));
    assert_eq!(fresh_since(&saved(serde_json::json!(["--continue"]), Some(serde_json::json!(5)))), None);
    for args in [serde_json::json!(["--resume", "latest"]), serde_json::json!(["-r", "latest"]), serde_json::json!(["-c"])] {
        assert_eq!(fresh_since(&saved(args, Some(serde_json::json!(5)))), None);
    }
    assert_eq!(fresh_since(&saved(serde_json::json!([]), None)), None);
    // An odd shape is no stamp, never a file that fails to parse.
    assert_eq!(fresh_since(&saved(serde_json::json!("x"), Some(serde_json::json!("soon")))), None);
}

/// The phone learns which agent a tab runs from the registry, not from the
/// tab's label, so a renamed tab still says "Claude"; an unlisted agent
/// keeps its label, and the command itself is never what is published.
#[test]
fn agent_label_names_the_cli_not_the_tab() {
    let tab = |label: &str, cmd: &str| SavedTab {
        label: label.to_string(),
        cmd: cmd.to_string(),
        cwd: String::new(),
        kind: "agent".to_string(),
        session_id: None,
        resume_args: None,
        tmux_session: None,
        tmux_attach: None,
        location: None,
        ephemeral: false,
        color: None,
        local_launch: None,
        schedule_target_id: None,
        sign_in: false,
        cloud: false,
        args: None,
        launched_at: None,
        assistant: None,
    };
    assert_eq!(agent_label_of(&tab("release review", "claude")), "Claude");
    assert_eq!(agent_label_of(&tab("Codex", "codex")), "Codex");
    assert_eq!(agent_label_of(&tab("My bot", "/opt/bot --x")), "My bot");
    // A local-model tab names its driver's CLI, not `ollama`.
    let mut local = tab("qwen3:8b · Claude Code", "ollama");
    local.local_launch = Some(serde_json::json!({ "driver": "claude" }));
    assert_eq!(agent_label_of(&local), "Claude");
}

/// A local-model tab driving OpenCode reads its transcript as `opencode`
/// (found by folder); the other drivers keep `ollama`, whose Claude or
/// Codex transcript needs a launch id the tab never has.
#[test]
fn a_local_opencode_tab_reads_as_opencode() {
    let local = |driver: &str| {
        serde_json::from_value::<SavedTab>(serde_json::json!({
            "label": "m · OpenCode", "cmd": "ollama", "cwd": "/p", "kind": "local_agent",
            "localLaunch": { "driver": driver, "model": "m", "args": ["launch", driver, "--model", "m"] },
        }))
        .expect("saved tab")
    };
    assert_eq!(transcript_cmd_of(&local("opencode")), "opencode");
    assert_eq!(transcript_cmd_of(&local("claude")), "ollama");
    let mut agent = local("opencode");
    agent.kind = "agent".into();
    assert_eq!(transcript_cmd_of(&agent), "ollama", "only a local-model tab is remapped");
}

/// Local-model tabs reach the phone as agent tabs (#31bl): Mistral's by its
/// resumable session, the other drivers by a `localLaunch` line Tabtivity
/// builds — never by one it does not, and never without the `agent` token
/// every agent tab's tmux name carries.
#[test]
fn local_model_tabs_are_listed_as_agent_tabs() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let root = state.join("p");
    fs::create_dir_all(&root).expect("root dir");
    fs::write(
        state.join("projects.json"),
        serde_json::to_vec(&serde_json::json!([{
            "id": "p-1",
            "name": "P",
            "status": "active",
            "directory": root.to_string_lossy(),
            concat!(crate::app_slug!(), "_mobile_access"): true,
        }]))
        .expect("projects"),
    )
    .expect("write projects");
    let sessions = state.join("sessions").join("p-1");
    fs::create_dir_all(&sessions).expect("session dir");
    let tab = |n: &str, cmd: &str, extra: serde_json::Value| {
        let mut row = serde_json::json!({
            "label": format!("Local {n}"),
            "cmd": cmd,
            "cwd": root.to_string_lossy(),
            "kind": "local_agent",
            "tmuxSession": format!("{SLUG}-p-1--agent-10000000{n}"),
        });
        row.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        row
    };
    let launch = |args: serde_json::Value| {
        serde_json::json!({ "localLaunch": { "driver": "claude", "model": "qwen3:8b", "args": args } })
    };
    // The wrong token.
    let mut wrong_token = tab("5", "vibe", serde_json::json!({ "sessionId": "s5" }));
    wrong_token["tmuxSession"] = serde_json::json!(concat!(crate::app_slug!(), "-p-1--local_agent-100000005"));
    fs::write(
        sessions.join("terminals.json"),
        serde_json::to_vec(&serde_json::json!({
            "tabLayout": [
                tab("1", "vibe", serde_json::json!({ "sessionId": "s1" })),
                tab("2", "ollama", launch(serde_json::json!(["launch", "claude", "--model", "qwen3:8b"]))),
                // Not a line Tabtivity builds.
                tab("3", "ollama", launch(serde_json::json!(["serve"]))),
                // Neither resumable nor relaunchable.
                tab("4", "ollama", serde_json::json!({})),
                wrong_token,
            ]
        }))
        .expect("session"),
    )
    .expect("write session");

    let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
    let tabs = &catalog.projects.first().expect("project").tabs;
    let listed: Vec<(&str, &str, Option<&str>)> = tabs
        .iter()
        .map(|t| (t.public.label.as_str(), t.public.kind.as_str(), t.public.agent_label.as_deref()))
        .collect();
    assert_eq!(
        listed,
        vec![("Local 1", "agent", Some("Mistral")), ("Local 2", "agent", Some("Claude"))]
    );
    // Flagged as local, so the phone shows the model and offers no list —
    // and no worktree move, which the desktop offers none of either.
    for listed in tabs {
        let row = serde_json::to_value(&listed.public).expect("row");
        assert_eq!(row["local_model"], serde_json::json!(true));
        assert!(row.get("worktree_movable").is_none(), "{row}");
    }
}

/// The phone's ⎇ chip moves exactly the tabs the desktop Reader's does: a
/// resumable agent of a local project (`worktreeMoveDir`) — never a
/// shell, nor a remote project's agent.
#[test]
fn a_local_resumable_agent_is_flagged_movable_between_worktrees() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let (local, remote) = (state.join("p"), state.join("r"));
    fs::create_dir_all(&local).expect("local dir");
    fs::create_dir_all(&remote).expect("remote dir");
    let access = concat!(crate::app_slug!(), "_mobile_access");
    fs::write(
        state.join("projects.json"),
        serde_json::to_vec(&serde_json::json!([
            { "id": "p-1", "name": "P", "status": "active", "directory": local.to_string_lossy(), access: true },
            { "id": "r-1", "name": "R", "status": "active", "directory": state.join("r-state").to_string_lossy(), access: true,
              "remote": { "host": "h" }, "mirror": remote.to_string_lossy() },
        ]))
        .expect("projects"),
    )
    .expect("write projects");
    let session = |id: &str, root: &Path, tabs: serde_json::Value| {
        let dir = state.join("sessions").join(id);
        fs::create_dir_all(&dir).expect("session dir");
        let rows: Vec<serde_json::Value> = tabs.as_array().unwrap().iter().map(|t| {
            let mut row = t.clone();
            row["cwd"] = serde_json::json!(root.to_string_lossy());
            row
        }).collect();
        fs::write(dir.join("terminals.json"), serde_json::to_vec(&serde_json::json!({ "tabLayout": rows })).expect("json"))
            .expect("write session");
    };
    session("p-1", &local, serde_json::json!([
        { "label": "Claude", "cmd": "claude", "kind": "agent", "sessionId": "s1", "tmuxSession": format!("{SLUG}-p-1--agent-100000001") },
    ]));
    session("r-1", &remote, serde_json::json!([
        { "label": "Claude", "cmd": "claude", "kind": "agent", "sessionId": "s2", "tmuxSession": format!("{SLUG}-r-1--agent-100000002") },
    ]));

    let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
    let movable = |raw: &str| {
        catalog
            .projects
            .iter()
            .find(|p| p.raw_id == raw)
            .map(|p| p.tabs.iter().map(|t| t.public.worktree_movable).collect::<Vec<_>>())
    };
    assert_eq!(movable("p-1"), Some(vec![true]));
    assert_eq!(movable("r-1"), Some(vec![false]));
}

/// A sign-in tab and a cloud session have no session to resume, yet the
/// phone that asked for one has to attach: the desktop saves it (flagged
/// `signIn` / `cloud`) while it runs, and the catalog lists it. Both
/// flags reach the phone: a sign-in tab opens on its sign-in sheet, a
/// cloud tab on its screen. An agent tab with neither stays unlisted.
#[test]
fn sign_in_and_cloud_tabs_are_listed_without_a_session() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let root = state.join("p");
    fs::create_dir_all(&root).expect("root dir");
    fs::write(
        state.join("projects.json"),
        serde_json::to_vec(&serde_json::json!([{
            "id": "p-1",
            "name": "P",
            "status": "active",
            "directory": root.to_string_lossy(),
            concat!(crate::app_slug!(), "_mobile_access"): true,
        }]))
        .expect("projects"),
    )
    .expect("write projects");
    let sessions = state.join("sessions").join("p-1");
    fs::create_dir_all(&sessions).expect("session dir");
    let tab = |n: &str, marker: serde_json::Value| {
        let mut row = serde_json::json!({
            "label": format!("Tab {n}"),
            "cmd": "claude",
            "cwd": root.to_string_lossy(),
            "kind": "agent",
            "tmuxSession": format!("{SLUG}-p-1--agent-10000000{n}"),
        });
        row.as_object_mut().unwrap().extend(marker.as_object().unwrap().clone());
        row
    };
    fs::write(
        sessions.join("terminals.json"),
        serde_json::to_vec(&serde_json::json!({ "tabLayout": [
            tab("1", serde_json::json!({ "signIn": true })),
            tab("2", serde_json::json!({ "cloud": true })),
            tab("3", serde_json::json!({ "signIn": false })),
        ] }))
        .expect("session"),
    )
    .expect("write session");

    let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
    let tabs = &catalog.projects.first().expect("project").tabs;
    let listed: Vec<(&str, Option<&str>, bool, bool)> = tabs
        .iter()
        .map(|t| (t.public.label.as_str(), t.public.agent_label.as_deref(), t.public.sign_in, t.public.cloud))
        .collect();
    assert_eq!(
        listed,
        vec![("Tab 1", Some("Claude"), true, false), ("Tab 2", Some("Claude"), false, true)]
    );
    let json = serde_json::to_value(&tabs[1].public).expect("public tab");
    assert!(json.get("sign_in").is_none(), "an unset flag is left out");
    assert_eq!(json.get("cloud"), Some(&serde_json::json!(true)));
    let json = serde_json::to_value(&tabs[0].public).expect("public tab");
    assert!(json.get("cloud").is_none(), "an unset flag is left out");
}

/// A mobile-enabled box is a scope of its own (#31aa): listed as `kind:
/// box` under its own opaque id, with tabs from `sessions/box_<id>/` whose
/// cwd is the box folder OR a member's phone folder. Its switch is the only
/// consent consulted — a member's own Mobile bit is not — and every member
/// contributes its folder (a remote member its mirror), except a VM
/// without a mirror, which has none; a box with the bit off or no folder
/// is not listed at all.
#[test]
fn a_mobile_enabled_box_is_a_scope_with_the_folder_and_member_roots() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    allow_shells(state);
    let folder = state.join("boxes").join("paper");
    let member = state.join("lib");
    let remote_mirror = state.join("mirror");
    for d in [&folder, &member, &remote_mirror] {
        fs::create_dir_all(d).expect("dir");
    }
    fs::write(
        state.join("projects.json"),
        serde_json::to_vec(&serde_json::json!([
            // The member has Mobile OFF itself: the box's switch covers it.
            { "id": "p-lib", "name": "Lib", "status": "inactive",
              "directory": member.to_string_lossy() },
            { "id": "p-remote", "name": "Remote", "status": "active",
              "directory": state.join("remote-projects").join("p-remote").to_string_lossy(),
              "remote": { "host": "h" }, "mirror": remote_mirror.to_string_lossy() },
            // A VM project without a mirror has no folder to give.
            { "id": "p-vm", "name": "Vm", "status": "active",
              "directory": state.join("remote-projects").join("p-vm").to_string_lossy(),
              "remote": { "host": "h" }, "vm": { "enabled": true } },
        ]))
        .expect("projects"),
    )
    .expect("write projects");
    fs::write(
        state.join("boxes.json"),
        serde_json::to_vec(&serde_json::json!([
            { "id": "b1", "name": "Paper", "member_ids": ["p-lib", "p-remote", "p-vm", "p-gone"],
              "folder": folder.to_string_lossy(), concat!(crate::app_slug!(), "_mobile_access"): true },
            { "id": "b2", "name": "Off", "folder": folder.to_string_lossy() },
            { "id": "b3", "name": "Unopened", concat!(crate::app_slug!(), "_mobile_access"): true },
        ]))
        .expect("boxes"),
    )
    .expect("write boxes");
    let sessions = state.join("sessions").join("box_b1");
    fs::create_dir_all(&sessions).expect("session dir");
    let tab = |label: &str, cwd: &Path, tmux: &str| {
        serde_json::json!({
            "label": label, "cmd": "bash", "kind": "shell",
            "cwd": cwd.to_string_lossy(), "tmuxSession": tmux,
        })
    };
    fs::write(
        sessions.join("terminals.json"),
        serde_json::to_vec(&serde_json::json!({ "tabLayout": [
            tab("Box shell", &folder, concat!(crate::app_slug!(), "-box_b1--shell-123456789")),
            tab("Lib shell", &member, concat!(crate::app_slug!(), "-box_b1--shell-223456789")),
            tab("Remote shell", &remote_mirror, concat!(crate::app_slug!(), "-box_b1--shell-323456789")),
            tab("Foreign", &folder, concat!(crate::app_slug!(), "-p-lib--shell-423456789")),
        ]}))
        .expect("session"),
    )
    .expect("write session");

    let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
    assert_eq!(catalog.projects.len(), 1, "only the enabled, opened box is listed");
    let b = &catalog.projects[0];
    assert_eq!(b.raw_id, "box:b1");
    assert_eq!(b.public.kind, ScopeKind::Box);
    assert_eq!(b.public.label, "Paper");
    assert_eq!(b.public.status, "active");
    assert_eq!(b.root, folder.canonicalize().unwrap());
    assert_eq!(b.roots.len(), 3, "the folder, the local member and the remote member's mirror: {:?}", b.roots);
    assert!(b.roots.contains(&remote_mirror.canonicalize().unwrap()));
    assert_eq!((b.host, b.folder, b.create), (ProjectHost::Local, true, CreateVerdict::All));
    let labels: Vec<&str> = b.tabs.iter().map(|t| t.public.label.as_str()).collect();
    assert_eq!(labels, vec!["Box shell", "Lib shell", "Remote shell"]);
    assert!(!b.public.id.contains("b1"), "the opaque id must not carry the box id");
}

/// One project record per host type, each with Mobile on.
fn typed_projects(state: &Path) -> Vec<serde_json::Value> {
    let access = crate::brand::MOBILE_ACCESS_KEY;
    let record = |id: &str, extra: serde_json::Value| {
        let mut record = serde_json::json!({
            "id": id, "name": id, "status": "active",
            "directory": state.join("dirs").join(id).to_string_lossy(), access: true,
        });
        for (key, value) in extra.as_object().expect("object") {
            record[key] = value.clone();
        }
        record
    };
    vec![
        record("p-local", serde_json::json!({})),
        record("p-box", serde_json::json!({ "sandbox": { "enabled": true } })),
        record("p-remote", serde_json::json!({ "remote": { "host": "h" } })),
        record(
            "p-moved",
            serde_json::json!({ "remote": { "host": "h" }, "mirror": state.join("moved").to_string_lossy() }),
        ),
        record("p-vm", serde_json::json!({ "remote": { "host": "h" }, "vm": { "enabled": true } })),
        record(
            "p-vm-mirror",
            serde_json::json!({
                "remote": { "host": "h" }, "vm": { "enabled": true },
                "mirror": state.join("vm-mirror").to_string_lossy(),
            }),
        ),
    ]
}

fn load_all(state: &Path, live: &HashMap<String, LiveTmux>) -> Vec<ResolvedProject> {
    let env = RootEnv { dir: state.join("root"), fenced: || true };
    Catalog::load_with(state, &[7; 32], &env, live, &HostLive::default(), true).expect("catalog").projects
}

fn tab_json(label: &str, kind: &str, cwd: &Path, tmux: &str, extra: serde_json::Value) -> serde_json::Value {
    let mut tab = serde_json::json!({
        "label": label, "cmd": if kind == "shell" { "bash" } else { "claude" }, "kind": kind,
        "cwd": cwd.to_string_lossy(), "tmuxSession": tmux, "signIn": kind == "agent",
    });
    for (key, value) in extra.as_object().expect("object") {
        tab[key] = value.clone();
    }
    tab
}

fn write_session(state: &Path, id: &str, tabs: Vec<serde_json::Value>) {
    let sessions = state.join("sessions").join(id);
    fs::create_dir_all(&sessions).expect("session dir");
    fs::write(sessions.join("terminals.json"), serde_json::json!({ "tabLayout": tabs }).to_string())
        .expect("write session");
}

/// No project type is special (plan step 1): a local, container, remote
/// and VM project each opted in are listed, with the folder their type
/// gives the phone — the entry's `directory` for a local or container
/// project, the mirror for a remote one (the default under the state dir,
/// or the entry's `mirror`), a VM's only if it has opted into one — and
/// the create verdict their type allows.
#[test]
fn every_project_type_is_listed_with_its_own_folder() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let default_mirror = crate::services::remote_sync::default_mirror_dir_in(state, "p-remote");
    for d in [
        state.join("dirs").join("p-local"),
        state.join("dirs").join("p-box"),
        default_mirror.clone(),
        state.join("moved"),
        state.join("vm-mirror"),
    ] {
        fs::create_dir_all(d).expect("dir");
    }
    fs::write(state.join("projects.json"), serde_json::to_vec(&typed_projects(state)).expect("projects"))
        .expect("write projects");
    let listed = load_all(state, &HashMap::new());
    let row = |id: &str| listed.iter().find(|p| p.raw_id == id).unwrap_or_else(|| panic!("{id} is listed"));
    let canon = |p: &Path| p.canonicalize().expect("canonical");

    let local = row("p-local");
    assert_eq!((local.host, local.folder, local.create), (ProjectHost::Local, true, CreateVerdict::All));
    assert_eq!(local.root, canon(&state.join("dirs").join("p-local")));
    let container = row("p-box");
    assert_eq!((container.host, container.folder, container.create), (ProjectHost::Container, true, CreateVerdict::None));
    assert_eq!(container.root, canon(&state.join("dirs").join("p-box")));
    let remote = row("p-remote");
    assert_eq!((remote.host, remote.folder, remote.create), (ProjectHost::Remote, true, CreateVerdict::Agents));
    assert_eq!(remote.root, canon(&default_mirror), "not the entry's directory");
    let moved = row("p-moved");
    assert_eq!(moved.root, canon(&state.join("moved")), "an explicit mirror wins over the default");
    let vm = row("p-vm");
    assert_eq!((vm.host, vm.folder, vm.create), (ProjectHost::Vm, false, CreateVerdict::None));
    assert!(vm.roots.is_empty() && vm.tabs.is_empty());
    assert!(!vm.root.exists(), "a folder-less project's root names nothing that exists");
    let vm_mirror = row("p-vm-mirror");
    assert_eq!((vm_mirror.host, vm_mirror.folder, vm_mirror.create), (ProjectHost::Vm, true, CreateVerdict::None));
    assert_eq!(vm_mirror.root, canon(&state.join("vm-mirror")));
    assert_eq!(listed.len(), 6);

    // The per-phone check agrees with the catalog, for every type.
    let env = RootEnv { dir: state.join("root"), fenced: || true };
    let access = ScopeAccess::load_with(state, &env).expect("access");
    for id in ["p-local", "p-box", "p-remote", "p-moved", "p-vm", "p-vm-mirror"] {
        assert_eq!(access.reaches(id, "any-phone"), Ok(true), "{id}");
    }
}

/// A remote project whose mirror is not there yet (never opened on the
/// desktop) and a VM project without one are listed, with no tab and no
/// folder, so the Mobile switch shows on the phone. A local project whose
/// folder is gone is still dropped.
#[test]
fn a_remote_project_without_a_mirror_is_listed_empty() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    allow_shells(state);
    fs::write(state.join("projects.json"), serde_json::to_vec(&typed_projects(state)).expect("projects"))
        .expect("write projects");
    // Saved tabs exist, but nothing can be checked against a missing root.
    let tmux = concat!(crate::app_slug!(), "-p-remote--agent-123456789");
    write_session(state, "p-remote", vec![tab_json("Agent", "agent", &state.join("dirs").join("p-remote"), tmux, serde_json::json!({}))]);
    let listed = load_all(state, &HashMap::new());
    let mut ids: Vec<&str> = listed.iter().map(|p| p.raw_id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["p-moved", "p-remote", "p-vm", "p-vm-mirror"], "the local and container folders are missing: dropped");
    for p in &listed {
        assert!(!p.folder && !p.has_folder() && p.tabs.is_empty(), "{}", p.raw_id);
        assert_eq!(p.create, CreateVerdict::None, "{}", p.raw_id);
    }
    let remote = listed.iter().find(|p| p.raw_id == "p-remote").unwrap();
    assert_eq!(remote.root, crate::services::remote_sync::default_mirror_dir_in(state, "p-remote"));
}

/// A remote project's desktop-made agent is saved with `cwd` = the entry's
/// state-dir `directory` (the window swaps the mirror in only at spawn):
/// it is listed, and read as running in the mirror. Any other cwd must lie
/// below the mirror; one that does not is dropped.
#[test]
fn a_remote_tab_saved_with_the_project_directory_is_read_in_the_mirror() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    allow_shells(state);
    let mirror = crate::services::remote_sync::default_mirror_dir_in(state, "p-remote");
    let directory = state.join("dirs").join("p-remote");
    for d in [&mirror, &directory, &mirror.join("src"), &state.join("elsewhere")] {
        fs::create_dir_all(d).expect("dir");
    }
    let projects = typed_projects(state).into_iter().filter(|p| p["id"] == "p-remote").collect::<Vec<_>>();
    fs::write(state.join("projects.json"), serde_json::to_vec(&projects).expect("projects")).expect("write projects");
    let name = |n: u32| format!("{}-p-remote--agent-{n}23456789", crate::app_slug!());
    write_session(
        state,
        "p-remote",
        vec![
            tab_json("Window made", "agent", &directory, &name(1), serde_json::json!({})),
            tab_json("In the mirror", "agent", &mirror.join("src"), &name(2), serde_json::json!({})),
            tab_json("Elsewhere", "agent", &state.join("elsewhere"), &name(3), serde_json::json!({})),
        ],
    );
    let listed = load_all(state, &HashMap::new());
    let remote = &listed[0];
    let tabs: Vec<(&str, PathBuf)> = remote.tabs.iter().map(|t| (t.public.label.as_str(), PathBuf::from(&t.cwd))).collect();
    assert_eq!(
        tabs,
        [
            ("Window made", remote.root.clone()),
            ("In the mirror", mirror.join("src")),
        ],
    );
}

/// A record from before `directory` was persisted names its folder only
/// through `local_file` (`<dir>/project.json`), as the window's
/// `resolveProjectDirectory` reads it: a remote project's window-made agent
/// (saved with that folder as its `cwd`) is still read in the mirror, and a
/// local one's root is that folder. A `local_file` that is not a
/// `project.json` gives nothing.
#[test]
fn a_legacy_record_without_a_directory_key_still_names_its_folder() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    allow_shells(state);
    let mirror = crate::services::remote_sync::default_mirror_dir_in(state, "p-remote");
    let remote_dir = state.join("dirs").join("p-remote");
    let local_dir = state.join("dirs").join("p-local");
    for d in [&mirror, &remote_dir, &local_dir] {
        fs::create_dir_all(d).expect("dir");
    }
    let legacy = |id: &str, folder: &Path, extra: serde_json::Value| {
        let mut row = serde_json::json!({
            "id": id, "name": id, "status": "active",
            "local_file": folder.join("project.json").to_string_lossy(),
            crate::brand::MOBILE_ACCESS_KEY: true,
        });
        row.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        row
    };
    let projects = [
        legacy("p-remote", &remote_dir, serde_json::json!({ "remote": { "host": "h.invalid" } })),
        legacy("p-local", &local_dir, serde_json::json!({})),
    ];
    fs::write(state.join("projects.json"), serde_json::to_vec(&projects).expect("projects")).expect("write projects");
    write_session(
        state,
        "p-remote",
        vec![tab_json("Window made", "agent", &remote_dir, &format!("{}-p-remote--agent-123456789", crate::app_slug!()), serde_json::json!({}))],
    );
    let listed = load_all(state, &HashMap::new());
    let by_id = |id: &str| listed.iter().find(|p| p.raw_id == id).unwrap_or_else(|| panic!("{id} not listed"));
    let canon = |p: &Path| p.canonicalize().expect("canonical");
    let remote = by_id("p-remote");
    let cwds: Vec<PathBuf> = remote.tabs.iter().map(|t| PathBuf::from(&t.cwd)).collect();
    assert_eq!(cwds.len(), 1);
    assert_eq!(cwds[0], remote.root);
    assert_eq!(remote.root, canon(&mirror));
    assert_eq!(by_id("p-local").root, canon(&local_dir));
    // Only a `project.json` names a folder; a bare file name has no parent to give.
    let record = |local_file: &str| -> ProjectRecord {
        serde_json::from_value(serde_json::json!({ "id": "p", "name": "P", "status": "active", "local_file": local_file })).unwrap()
    };
    assert_eq!(record("/a/b/project.json").directory(), Some(PathBuf::from("/a/b")));
    for odd in ["/a/b/notes.json", "project.json", "/project.json", ""] {
        assert_eq!(record(odd).directory(), None, "{odd}");
    }
}

/// On a remote or VM project the catalog lists only the tabs the window
/// runs locally: a location-less shell is remote, a `host:w1` or `remote`
/// agent is on a host, a location-less agent is local. A container project
/// drops what runs in the container — every agent, and a shell while the
/// spec's scope is `all` — and lists a scope-`agents` spec's shells.
#[test]
fn only_tabs_with_a_local_session_are_listed_on_remote_vm_and_container_projects() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    allow_shells(state);
    let mut projects = typed_projects(state);
    projects.push(serde_json::json!({
        "id": "p-agents", "name": "p-agents", "status": "active",
        "directory": state.join("dirs").join("p-agents").to_string_lossy(),
        crate::brand::MOBILE_ACCESS_KEY: true,
        "sandbox": { "enabled": true, "scope": "agents" },
    }));
    fs::write(state.join("projects.json"), serde_json::to_vec(&projects).expect("projects")).expect("write projects");
    let dirs = state.join("dirs");
    let roots = [
        ("p-local", dirs.join("p-local")),
        ("p-box", dirs.join("p-box")),
        ("p-agents", dirs.join("p-agents")),
        ("p-vm-mirror", state.join("vm-mirror")),
        ("p-remote", crate::services::remote_sync::default_mirror_dir_in(state, "p-remote")),
    ];
    for (id, root) in &roots {
        fs::create_dir_all(root).expect("root");
        let n = |kind: &str, i: u32| format!("{}-{id}--{kind}-{i}23456789", crate::app_slug!());
        let tabs = vec![
            tab_json("agent", "agent", root, &n("agent", 1), serde_json::json!({})),
            tab_json("agent remote", "agent", root, &n("agent", 2), serde_json::json!({ "location": "remote" })),
            tab_json("agent w1", "agent", root, &n("agent", 3), serde_json::json!({ "location": "host:w1" })),
            tab_json("shell", "shell", root, &n("shell", 4), serde_json::json!({})),
            tab_json("shell local", "shell", root, &n("shell", 5), serde_json::json!({ "location": "local" })),
        ];
        write_session(state, id, tabs);
    }
    let listed = load_all(state, &HashMap::new());
    let labels = |id: &str| -> Vec<String> {
        listed.iter().find(|p| p.raw_id == id).unwrap_or_else(|| panic!("{id}")).tabs.iter().map(|t| t.public.label.clone()).collect()
    };
    assert_eq!(labels("p-local"), ["agent", "agent remote", "agent w1", "shell", "shell local"], "a local project is unfiltered");
    assert_eq!(labels("p-remote"), ["agent", "shell local"]);
    assert!(labels("p-vm-mirror").is_empty(), "a VM project is pinned to the VM");
    assert!(labels("p-box").is_empty(), "scope all: agents and shells run in the container");
    assert_eq!(labels("p-agents"), ["shell", "shell local"], "scope agents leaves the shells on the host");
}

/// The tab-locality rule is the window's `effectiveTabLocation`, pinned
/// to it by one table both sides read
/// (`src/__tests__/mobile/tabLocality.fixture.json`).
#[test]
fn the_tab_locality_rule_matches_the_windows_table() {
    let table: Vec<serde_json::Value> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/__tests__/mobile/tabLocality.fixture.json"
    )))
    .expect("fixture");
    assert!(table.len() > 10);
    for row in table {
        let (kind, location, pinned) = (row["kind"].as_str().unwrap(), row["location"].as_str(), row["pinned"].as_bool().unwrap());
        assert_eq!(tab_is_local(kind, location, pinned), row["local"].as_bool().unwrap(), "{row}");
    }
}

/// The project-type table the window's `projectTabHost` reads too
/// (`src/__tests__/mobile/projectHostReach.fixture.json`): the host word,
/// whether a tab of a kind and location runs on this machine, and the
/// create verdict of a project with a folder.
#[test]
fn the_project_host_table_matches_the_windows() {
    let table: Vec<serde_json::Value> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/__tests__/mobile/projectHostReach.fixture.json"
    )))
    .expect("fixture");
    assert!(table.len() > 50);
    for row in table {
        let mut record = serde_json::json!({ "id": "p", "name": "P", "status": "active" });
        for (key, value) in row["record"].as_object().expect("record") {
            record[key] = value.clone();
        }
        let project: ProjectRecord = serde_json::from_value(record).expect("record");
        let host = project_host(&project);
        assert_eq!(serde_json::to_value(host).unwrap(), row["host"], "{row}");
        let reach = runs_on_this_machine(host, container_shells(&project), row["kind"].as_str().unwrap(), row["location"].as_str());
        assert_eq!(reach, row["reach"].as_bool().unwrap(), "{row}");
        let lists = phone_lists_tab(host, container_shells(&project), row["kind"].as_str().unwrap(), row["location"].as_str());
        assert_eq!(lists, row["lists"].as_bool().unwrap(), "{row}");
        assert_eq!(serde_json::to_value(create_verdict(host, true)).unwrap(), row["create"], "{row}");
    }
}

/// A remote project with Mobile on: its primary host, worker `w1`, and its
/// tabs as the window saved them — `persist_sessions` as given.
fn host_tab_state(persist: Option<bool>, vm: bool) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let mut remote = serde_json::json!({ "user": "alice", "host": "primary.example", "remote_path": "/srv/p" });
    if let Some(persist) = persist {
        remote["persist_sessions"] = persist.into();
    }
    let mut record = serde_json::json!({
        "id": "p-host", "name": "Host project", "status": "active",
        "directory": state.join("dirs").join("p-host").to_string_lossy(),
        crate::brand::MOBILE_ACCESS_KEY: true,
        "remote": remote,
        "compute_hosts": [{ "id": "w1", "user": "alice", "host": "w1.example", "remote_path": "/srv/w" }],
    });
    if vm {
        record["vm"] = serde_json::json!({ "enabled": true });
    }
    fs::write(state.join("projects.json"), serde_json::to_vec(&[record]).unwrap()).unwrap();
    let name = |kind: &str, n: u32| format!("{}-p-host--{kind}-{n}23456789", crate::app_slug!());
    let cwd = state.join("dirs").join("p-host");
    let agent = |label: &str, n: u32, extra: serde_json::Value| {
        let mut tab = tab_json(label, "agent", &cwd, &name("agent", n), serde_json::json!({ "signIn": false, "sessionId": format!("sess-{n}") }));
        tab.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        tab
    };
    write_session(
        state,
        "p-host",
        vec![
            agent("on primary", 1, serde_json::json!({ "location": "remote" })),
            agent("on the worker", 2, serde_json::json!({ "location": "host:w1" })),
            agent("on a gone worker", 3, serde_json::json!({ "location": "host:w9" })),
            agent("local, no mirror", 4, serde_json::json!({})),
            agent("sign-in", 5, serde_json::json!({ "location": "remote", "signIn": true })),
            agent("cloud", 6, serde_json::json!({ "location": "remote", "cloud": true })),
            agent("ephemeral", 7, serde_json::json!({ "location": "remote", "ephemeral": true })),
            agent("attached", 8, serde_json::json!({ "location": "remote", "tmuxAttach": "foreign" })),
            agent("no session id", 9, serde_json::json!({ "location": "remote", "sessionId": null })),
            tab_json("host shell", "shell", &cwd, &name("shell", 10), serde_json::json!({})),
            tab_json("foreign name", "shell", &cwd, "someone-elses-session", serde_json::json!({})),
        ],
    );
    (dir, name("agent", 1))
}

fn load_hosts(state: &Path, hosts: &HostLive, host_tabs: bool) -> ResolvedProject {
    let env = RootEnv { dir: state.join("root"), fenced: || true };
    let mut listed = Catalog::load_with(state, &[7; 32], &env, &HashMap::new(), hosts, host_tabs).expect("catalog").projects;
    assert_eq!(listed.len(), 1);
    listed.remove(0)
}

fn spec_of(host: &str) -> RemoteSpec {
    serde_json::from_value(serde_json::json!({ "user": "alice", "host": host, "remote_path": "/x" })).unwrap()
}

/// The machines a phone-made agent may start on: the primary then each
/// worker, under the window's location words — and none where a tab
/// started there would never be listed (no tmux on the host, no host
/// tabs in this build, a VM).
#[test]
fn a_remote_project_offers_its_machines_only_where_host_tabs_are_listed() {
    let (dir, _) = host_tab_state(None, false);
    let project = load_hosts(dir.path(), &HostLive::default(), true);
    let machines: Vec<_> = project.machines.iter().map(|m| (m.location.as_str(), m.label.as_str(), m.primary, m.runnable)).collect();
    assert_eq!(machines, [("remote", "primary.example", true, true), ("host:w1", "w1.example", false, true)]);
    assert!(load_hosts(dir.path(), &HostLive::default(), false).machines.is_empty(), "no host tabs in this build");
    let (off, _) = host_tab_state(Some(false), false);
    assert!(load_hosts(off.path(), &HostLive::default(), true).machines.is_empty(), "persist_sessions off");
    let (vm, _) = host_tab_state(None, true);
    assert!(load_hosts(vm.path(), &HostLive::default(), true).machines.is_empty(), "a VM project");
}

/// A worker's own label names it; one that neither shares the primary's
/// folder nor keeps a synced copy has no tree to run in.
#[test]
fn a_machine_is_named_by_its_label_and_runnable_only_with_the_code() {
    let worker = |extra: serde_json::Value| {
        let mut host = serde_json::json!({ "id": "w2", "user": "alice", "host": "w2.example", "remote_path": "/srv/w" });
        host.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value::<ComputeHost>(host).unwrap()
    };
    let hosts = ProjectHosts {
        primary: Some(serde_json::from_value(serde_json::json!({ "host": "p.example", "remote_path": "/x", "label": " gpu-1 " })).unwrap()),
        workers: vec![
            worker(serde_json::json!({ "label": "gpu-2" })),
            worker(serde_json::json!({ "sync_code": false })),
            worker(serde_json::json!({ "sync_code": false, "shared_fs": true })),
        ],
        persist: true,
    };
    let machines: Vec<_> = hosts.machines().into_iter().map(|m| (m.label, m.runnable)).collect();
    assert_eq!(
        machines,
        [("gpu-1".to_string(), true), ("gpu-2".to_string(), true), ("w2.example".to_string(), false), ("w2.example".to_string(), true)]
    );
}

/// Plan step 2: a remote project's host tabs are listed off the session
/// file with no mirror on disk — a resumable agent on the primary or on a
/// worker the record names, and a shell behind `shell_tabs` — and nothing
/// else (a gone worker, sign-in, cloud, ephemeral, attached, unresumable,
/// foreign-named). They are available only by the host snapshot, carry
/// no cwd, and cross as `on_host` with nothing raw.
#[test]
fn remote_host_tabs_are_listed_by_the_record_and_reached_through_the_snapshot() {
    let (dir, primary_session) = host_tab_state(None, false);
    let state = dir.path();
    let labels = |p: &ResolvedProject| p.tabs.iter().map(|t| t.public.label.clone()).collect::<Vec<_>>();

    let project = load_hosts(state, &HostLive::default(), true);
    assert!(!project.folder, "no mirror on disk");
    assert_eq!(labels(&project), ["on primary", "on the worker"]);
    for tab in &project.tabs {
        assert!(tab.public.on_host && tab.place.on_host() && tab.cwd.is_empty(), "{}", tab.public.label);
        assert!(!tab.public.available, "no master known: {}", tab.public.label);
        assert!(tab.public.host_down, "no master known: {}", tab.public.label);
        assert!(tab.place.host_ssh().is_none());
    }
    assert_eq!(project.public.live_sessions, 0);

    allow_shells(state);
    assert_eq!(labels(&load_hosts(state, &HostLive::default(), true)), ["on primary", "on the worker", "host shell"]);

    // The primary's master is up with no session list (no window, or an
    // HPC host); w1's tmux answered without the tab's session.
    let mut hosts = HostLive::default();
    let socket = std::env::temp_dir().join("cm-primary");
    hosts.insert(&spec_of("primary.example"), HostReach { control_path: socket.clone(), sessions: None });
    let listed: std::collections::HashSet<String> = [primary_session.clone()].into();
    hosts.insert(&spec_of("w1.example"), HostReach { control_path: std::env::temp_dir().join("cm-w1"), sessions: Some(listed) });
    let project = load_hosts(state, &hosts, true);
    let by_label = |label: &str| project.tabs.iter().find(|t| t.public.label == label).unwrap_or_else(|| panic!("{label}"));
    assert!(by_label("on primary").public.available);
    assert!(by_label("host shell").public.available, "a location-less shell is on the primary");
    assert!(!by_label("on the worker").public.available, "w1's tmux does not hold it");
    // The master answers, so the session ended on the host: not host_down.
    assert!(project.tabs.iter().all(|t| !t.public.host_down));
    let ssh = by_label("on primary").place.host_ssh().expect("rides the primary's master");
    assert_eq!((ssh.spec.host.as_str(), ssh.control_path.clone()), ("primary.example", socket));
    assert!(by_label("on the worker").place.host_ssh().is_some(), "w1's master is up; its session is not");
    assert_eq!(project.public.live_sessions, 2);

    let wire = serde_json::to_string(&project.tabs.iter().map(|t| &t.public).collect::<Vec<_>>()).unwrap();
    assert!(wire.contains(r#""on_host":true"#), "{wire}");
    for raw in ["primary.example", "w1.example", "w1", "/srv/", "cm-", &primary_session, "sess-1", "alice"] {
        assert!(!wire.contains(raw), "{raw} crossed: {wire}");
    }
}

/// No host session exists for a minted name while the project does not
/// persist sessions; a VM project keeps its rule (pinned to the VM, out of
/// scope here); a Windows build lists no host tab.
#[test]
fn host_tabs_need_persisted_sessions_a_non_vm_project_and_tmux_terminals() {
    let (dir, _) = host_tab_state(Some(false), false);
    assert!(load_hosts(dir.path(), &HostLive::default(), true).tabs.is_empty());
    let (dir, _) = host_tab_state(Some(true), false);
    assert_eq!(load_hosts(dir.path(), &HostLive::default(), true).tabs.len(), 2);
    let (dir, _) = host_tab_state(None, true);
    assert!(load_hosts(dir.path(), &HostLive::default(), true).tabs.is_empty(), "a VM project lists no host tab");
    assert!(!host_tabs_on(terminals_support_on(true)), "Windows");
    assert!(host_tabs_on(terminals_support_on(false)));
    let (dir, _) = host_tab_state(None, false);
    assert!(load_hosts(dir.path(), &HostLive::default(), host_tabs_on(terminals_support_on(true))).tabs.is_empty());
}

/// The refresher probes exactly the hosts the catalog would list a tab
/// on, each once; a project without listable host tabs adds none.
#[test]
fn the_probe_targets_are_the_hosts_of_listable_host_tabs() {
    let (dir, _) = host_tab_state(None, false);
    let hosts = |state: &Path| {
        let mut names: Vec<String> = host_probe_targets(state).into_iter().map(|spec| spec.host).collect();
        names.sort();
        names
    };
    if !host_tabs_here() {
        assert!(hosts(dir.path()).is_empty());
        return;
    }
    assert_eq!(hosts(dir.path()), ["primary.example", "w1.example"], "the gone worker w9 is not probed");
    let (dir, _) = host_tab_state(Some(false), false);
    assert!(hosts(dir.path()).is_empty());
    let (dir, _) = host_tab_state(None, true);
    assert!(hosts(dir.path()).is_empty());
}

/// The `mirror` key is read leniently: a string is the folder, anything
/// else is none, and a record with an odd one still parses.
#[test]
fn the_mirror_key_is_read_leniently() {
    let project = |value: &str| -> ProjectRecord {
        serde_json::from_str(&format!(r#"{{"id":"p","name":"P","status":"active","mirror":{value}}}"#)).unwrap()
    };
    assert_eq!(project(r#""/m""#).mirror.as_deref(), Some("/m"));
    for odd in ["7", "null", "[]", r#"{"a":1}"#, "true"] {
        assert_eq!(project(odd).mirror, None, "{odd}");
    }
    let absent: ProjectRecord = serde_json::from_str(r#"{"id":"p","name":"P","status":"active"}"#).unwrap();
    assert_eq!(absent.mirror, None);
    // A blank mirror is no mirror: the default stands in.
    let blank = project(r#""  ""#);
    let state = Path::new("state");
    assert_eq!(mobile_root(state, &blank), None, "a local record keeps its directory rule");
    let remote = ProjectRecord { remote: Some(serde_json::json!({ "host": "h" })), ..blank };
    assert_eq!(mobile_root(state, &remote), Some(crate::services::remote_sync::default_mirror_dir_in(state, "p")));
}

/// The per-phone list, end to end through a load: absent reaches every
/// phone, a list only its ids, an empty or malformed one none — and a
/// malformed value costs that scope alone, never the rest of the file. A
/// list on a scope whose switch is off opens nothing.
#[test]
fn a_scope_with_a_device_list_reaches_only_those_phones() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let devices = crate::brand::MOBILE_DEVICES_KEY;
    let access = crate::brand::MOBILE_ACCESS_KEY;
    let folder = state.join("boxes").join("paper");
    fs::create_dir_all(&folder).expect("box folder");
    let mut projects = Vec::new();
    for id in ["p-all", "p-one", "p-empty", "p-bad", "p-off"] {
        let root = state.join(id);
        fs::create_dir_all(&root).expect("root");
        let mut record = serde_json::json!({
            "id": id, "name": id, "status": "active",
            "directory": root.to_string_lossy(), access: id != "p-off",
        });
        match id {
            "p-one" | "p-off" => record[devices] = serde_json::json!(["d1"]),
            "p-empty" => record[devices] = serde_json::json!([]),
            "p-bad" => record[devices] = serde_json::json!("d1"),
            _ => {}
        }
        projects.push(record);
    }
    fs::write(state.join("projects.json"), serde_json::to_vec(&projects).expect("projects"))
        .expect("write projects");
    fs::write(
        state.join("boxes.json"),
        serde_json::to_vec(&serde_json::json!([
            { "id": "b-all", "name": "All", "folder": folder.to_string_lossy(), access: true },
            { "id": "b-two", "name": "Two", "folder": folder.to_string_lossy(), access: true,
              devices: ["d2"] },
            { "id": "b-bad", "name": "Bad", "folder": folder.to_string_lossy(), access: true,
              devices: [1] },
        ]))
        .expect("boxes"),
    )
    .expect("write boxes");

    let catalog = Catalog::load(state, &[7; 32]).expect("a malformed list must not fail the load");
    let ids = |catalog: &Catalog| {
        let mut ids: Vec<String> = catalog.projects.iter().map(|p| p.raw_id.clone()).collect();
        ids.sort();
        ids
    };
    assert_eq!(
        ids(&catalog),
        ["box:b-all", "box:b-bad", "box:b-two", "p-all", "p-bad", "p-empty", "p-one"],
        "the unfiltered snapshot lists every opted-in scope"
    );
    assert_eq!(ids(&catalog.clone().for_device("d1")), ["box:b-all", "p-all", "p-one"]);
    assert_eq!(ids(&catalog.clone().for_device("d2")), ["box:b-all", "box:b-two", "p-all"]);
    assert_eq!(ids(&catalog.clone().for_device("d3")), ["box:b-all", "p-all"]);
    // A filtered-out scope answers like an unknown one.
    let one = catalog.projects.iter().find(|p| p.raw_id == "p-one").expect("p-one").public.id.clone();
    assert!(catalog.clone().for_device("d1").project(&one).is_some());
    assert!(catalog.for_device("d2").project(&one).is_none());
}

#[test]
fn no_tmux_server_is_an_answer_and_any_other_failure_is_not() {
    // tmux's ways of saying "no server", i.e. zero sessions.
    for stderr in [
        "no server running on /tmp/tmux-1000/default",
        "error connecting to /tmp/tmux-1000/default (No such file or directory)",
        "error connecting to /tmp/tmux-1000/default (Connection refused)",
        "failed to connect to server: Connection refused",
    ] {
        let live = live_from_ls(false, b"", stderr.as_bytes());
        assert!(live.is_ok_and(|live| live.is_empty()), "{stderr}");
    }
    // tmux not answering: never "zero sessions".
    for stderr in [
        "error connecting to /tmp/tmux-1000/default (Permission denied)",
        "error connecting to /tmp/tmux-1000/default (Resource temporarily unavailable)",
        "server exited unexpectedly",
        "lost server",
        "",
    ] {
        assert!(live_from_ls(false, b"", stderr.as_bytes()).is_err(), "{stderr:?}");
    }
    // An answer: its rows, and a malformed one costs only itself.
    let live = live_from_ls(
        true,
        concat!(crate::app_slug!(), "-p--shell-1\t1700000000\t/home/u/p\nbroken row\nwork\t5\t/tmp\n").as_bytes(),
        b"",
    )
    .expect("listing");
    assert_eq!(live.len(), 2);
    assert_eq!(live[concat!(crate::app_slug!(), "-p--shell-1")].activity, 1_700_000_000);
    assert_eq!(live["work"].cwd, PathBuf::from("/tmp"));
    assert!(live_from_ls(true, b"", b"").expect("empty listing").is_empty());
}

#[cfg(unix)]
#[test]
fn a_command_that_hangs_is_killed_at_its_deadline() {
    let mut hung = Command::new("sleep");
    hung.arg("30");
    let started = Instant::now();
    let error = output_within(hung, Duration::from_millis(150)).expect_err("deadline");
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(10), "returned at the deadline, not the child's exit");

    // One that answers in time is read whole, both pipes and its status.
    let mut quick = Command::new("sh");
    quick.args(["-c", "printf out; printf err >&2; exit 3"]);
    let out = output_within(quick, Duration::from_secs(10)).expect("output");
    assert_eq!(out.status.code(), Some(3));
    assert_eq!(out.stdout, b"out");
    assert_eq!(out.stderr, b"err");

    let missing = Command::new("no-such-binary-for-this-test");
    let error = output_within(missing, Duration::from_secs(1)).expect_err("spawn");
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
}

#[test]
fn shell_tabs_are_off_the_phone_unless_switched_on() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let (live, _) = live_tab_fixture(state);
    let kinds = |state: &Path| {
        Catalog::load_with(state, &[7; 32], &RootEnv { dir: state.join("root"), fenced: || true }, &live, &HostLive::default(), true)
            .expect("catalog")
            .projects
            .iter()
            .flat_map(|p| p.tabs.iter().map(|t| t.public.kind.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(kinds(state), vec!["shell"]);
    for settings in [
        serde_json::json!({ crate::brand::MOBILE_HOST_KEY: { "enabled": true } }),
        serde_json::json!({ crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": false } }),
    ] {
        fs::write(state.join("settings.json"), settings.to_string()).expect("settings");
        assert!(kinds(state).is_empty(), "{settings}");
    }
    fs::write(state.join("settings.json"), b"{").expect("corrupt settings");
    assert!(kinds(state).is_empty(), "unreadable settings refuse");
    fs::remove_file(state.join("settings.json")).expect("remove");
    assert!(kinds(state).is_empty(), "no settings is the default");
}

/// Shell tabs are off the phone by default; the fixtures that list them
/// switch them on.
fn allow_shells(state: &Path) {
    fs::write(
        state.join("settings.json"),
        // The assistant is on by default and would add its own scope; these
        // fixtures are about project tabs.
        serde_json::json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true } }).to_string(),
    )
    .expect("settings");
}

/// One project with one shell tab, and the tmux row that makes it live.
fn live_tab_fixture(state: &Path) -> (HashMap<String, LiveTmux>, impl Fn(bool) + '_) {
    const TMUX: &str = concat!(crate::app_slug!(), "-p-1--shell-123456789");
    allow_shells(state);
    let root = state.join("p");
    fs::create_dir_all(&root).expect("root dir");
    let sessions = state.join("sessions").join("p-1");
    fs::create_dir_all(&sessions).expect("session dir");
    fs::write(
        sessions.join("terminals.json"),
        serde_json::to_vec(&serde_json::json!({ "tabLayout": [{
            "label": "Shell",
            "cmd": "bash",
            "cwd": root.to_string_lossy(),
            "kind": "shell",
            "tmuxSession": TMUX,
        }] }))
        .expect("session"),
    )
    .expect("write session");
    let live = HashMap::from([(TMUX.to_string(), LiveTmux { activity: 7, cwd: root.clone() })]);
    let write_project = move |access: bool| {
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "p-1",
                "name": "P",
                "status": "active",
                "directory": root.to_string_lossy(),
                crate::brand::MOBILE_ACCESS_KEY: access,
            }]))
            .expect("projects"),
        )
        .expect("write projects");
    };
    write_project(true);
    (live, write_project)
}

#[test]
fn a_tmux_that_cannot_be_asked_changes_no_tabs_availability() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let (live, write_project) = live_tab_fixture(state);
    const TMUX: &str = concat!(crate::app_slug!(), "-p-1--shell-123456789");
    let key = [7u8; 32];
    let mut cache = CatalogCache::default();
    let available = |catalog: &Catalog| catalog.projects[0].tabs[0].public.available;

    let first = cache
        .load_fresh_with(state, &key, || Ok(live.clone()))
        .expect("tmux answered");
    assert!(available(&first));
    let tab_id = first.projects[0].tabs[0].public.id.clone();
    assert!(first.grants(&tab_id, TMUX));
    assert!(!first.grants(&tab_id, concat!(crate::app_slug!(), "-p-1--shell-other6789")), "another session");
    assert!(!first.grants("no-such-tab", TMUX));

    // The fork failed, or the server hung: the tab is still what tmux last
    // said it was — and an open terminal on it is still granted.
    let next = cache
        .load_fresh_with(state, &key, || Err("tmux ls: timed out".into()))
        .expect("carried forward");
    assert!(available(&next));
    assert!(next.grants(&tab_id, TMUX));

    // Inside the retry window tmux is not asked again at all…
    let again = cache
        .load_fresh_with(state, &key, || panic!("asked a tmux that just failed"))
        .expect("carried forward");
    assert!(available(&again));
    // …but the files are still read: switching phone access off revokes
    // on time, wedged tmux or not.
    write_project(false);
    let revoked = cache
        .load_fresh_with(state, &key, || panic!("asked a tmux that just failed"))
        .expect("load");
    assert!(revoked.projects.is_empty());
    assert!(!revoked.grants(&tab_id, TMUX));
    write_project(true);

    // Once it may be asked again, its answer stands — including "no
    // sessions", which is an answer.
    cache.tmux_failed_at = None;
    let gone = cache
        .load_fresh_with(state, &key, || Ok(HashMap::new()))
        .expect("tmux answered");
    assert!(!available(&gone));
    assert!(!gone.grants(&tab_id, TMUX));
}

#[test]
fn with_no_tmux_answer_yet_the_load_fails_rather_than_listing_every_session_as_gone() {
    let dir = tempfile::tempdir().expect("state dir");
    let state = dir.path();
    let (live, _write_project) = live_tab_fixture(state);
    let mut cache = CatalogCache::default();
    assert!(cache
        .load_fresh_with(state, &[7; 32], || Err("tmux ls: timed out".into()))
        .is_err());
    // The failure is not pinned past the retry window.
    cache.tmux_failed_at = None;
    let catalog = cache
        .load_fresh_with(state, &[7; 32], || Ok(live))
        .expect("tmux answered");
    assert!(catalog.projects[0].tabs[0].public.available);
}

#[test]
fn cache_retains_last_valid_snapshot_during_partial_write() {
    let dir = tempfile::tempdir().expect("state dir");
    fs::write(dir.path().join("projects.json"), b"[]").expect("projects");
    let mut cache = CatalogCache::default();
    assert!(cache.load(dir.path(), &[7; 32]).is_ok());
    fs::write(dir.path().join("projects.json"), b"[").expect("partial projects");
    assert!(cache.load_fresh(dir.path(), &[7; 32]).is_ok());
}

#[test]
fn repeat_loads_inside_the_ttl_do_not_touch_the_disk() {
    let dir = tempfile::tempdir().expect("state dir");
    fs::write(dir.path().join("projects.json"), b"[]").expect("projects");
    let mut cache = CatalogCache::default();
    cache.load(dir.path(), &[7; 32]).expect("first load");
    // Removing the file would fail an uncached load; the TTL must absorb it.
    fs::remove_file(dir.path().join("projects.json")).expect("remove");
    assert!(cache.load(dir.path(), &[7; 32]).is_ok());
    assert!(cache.load_fresh(dir.path(), &[7; 32]).is_ok());
}
