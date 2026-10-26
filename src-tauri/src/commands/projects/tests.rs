/// The Mobile keys follow the switch: a list is written only with access
/// on, "every phone" removes it, off removes both — and every other key
/// of the entry, Python-era ones included, rides through untouched.
#[test]
fn mobile_access_writes_and_removes_both_keys_and_keeps_the_rest() {
    let access = crate::brand::MOBILE_ACCESS_KEY;
    let devices = crate::brand::MOBILE_DEVICES_KEY;
    let raw = serde_json::json!({
        "id": "p", "name": "P", "status": "active", "position": 3, "local_file": "/p/project.json",
        "directory": "/p", "python_era_field": { "kept": [1, 2] },
    });
    let mut entry: super::ProjectEntry = serde_json::from_value(raw.clone()).unwrap();
    let ids = vec!["a".repeat(27)];

    super::apply_mobile_access(&mut entry, true, Some(&ids));
    let on = serde_json::to_value(&entry).unwrap();
    assert_eq!(on[access], true);
    assert_eq!(on[devices], serde_json::json!(ids));
    assert_eq!(on["python_era_field"], raw["python_era_field"]);

    super::apply_mobile_access(&mut entry, true, None);
    let all = serde_json::to_value(&entry).unwrap();
    assert_eq!(all[access], true);
    assert!(all.get(devices).is_none(), "every phone is the key's absence");

    super::apply_mobile_access(&mut entry, true, Some(&ids));
    super::apply_mobile_access(&mut entry, false, None);
    assert_eq!(serde_json::to_value(&entry).unwrap(), raw, "off leaves the entry as it was");
}

/// An omitted list is every phone, and asks nothing of `devices.json`
/// (the asked-list checks are `auth::scope_device_list`'s tests).
#[test]
fn an_omitted_device_list_is_every_phone() {
    assert_eq!(super::mobile_scope_devices(None), Ok(None));
}

use super::*;

/// A minted id is a real v4 UUID: `claude --session-id` rejects anything else.
#[test]
fn uuid_v4_is_a_real_v4_uuid() {
    let a = uuid_v4();
    assert_eq!(a.len(), 36);
    assert!(crate::services::agent_session::is_uuid_shaped(&a), "{a}");
    assert_eq!(&a[14..15], "4");
    assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"), "{a}");
    assert_ne!(a, uuid_v4());
}

/// git writes a worktree's `gitdir` with `/` on every OS; the folder paths
/// come from `projects.json` in the OS's own form (`\` on Windows). The
/// worktree under the renamed folder is still found.
#[test]
fn moved_linked_worktrees_matches_gits_slashes() {
    let tmp = tempfile::tempdir().unwrap();
    let old = tmp.path().join("before");
    let new = tmp.path().join("after");
    let (old_s, new_s) = (old.to_string_lossy().to_string(), new.to_string_lossy().to_string());
    let meta = new.join(".git").join("worktrees").join("feature");
    std::fs::create_dir_all(&meta).unwrap();
    let gitdir = format!("{}/wt/feature/.git\n", old_s.replace('\\', "/"));
    std::fs::write(meta.join("gitdir"), gitdir).unwrap();

    let moved = moved_linked_worktrees(&new, &old_s, &new_s);
    assert_eq!(moved.len(), 1, "{moved:?}");
    assert_eq!(moved[0], new.join("wt").join("feature"));
}

/// A folder rename re-points the linked worktree that moved inside it, so
/// it still works from both ends.
#[test]
fn a_renamed_folder_repairs_the_worktree_inside_it() {
    use crate::test_util::git;
    let tmp = tempfile::tempdir().unwrap();
    // Resolved (macOS' /var symlink), without Windows' `\\?\` prefix.
    let root = PathBuf::from(crate::commands::fs::display_path(&tmp.path().canonicalize().unwrap()));
    let old = root.join("before");
    std::fs::create_dir_all(&old).unwrap();
    git(&old, &["init", "-q", "-b", "main"]);
    std::fs::write(old.join("a.txt"), b"a\n").unwrap();
    git(&old, &["add", "a.txt"]);
    git(&old, &["commit", "-q", "-m", "first"]);
    let inside = Path::new("wt").join("feature");
    git(&old, &["worktree", "add", "-q", "-b", "feature", &old.join(&inside).to_string_lossy()]);

    let new = root.join("after");
    std::fs::rename(&old, &new).unwrap();
    repair_moved_worktrees(&new, &old.to_string_lossy(), &new.to_string_lossy()).unwrap();

    let worktree = new.join(&inside);
    assert_eq!(git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]), "feature");
    assert_eq!(git(&worktree, &["status", "--porcelain"]), "");
    let listed = git(&new, &["worktree", "list", "--porcelain"]);
    assert!(!listed.contains("prunable"), "{listed}");
}

/// `forget_project` purges only Tabtivity's state dirs about a project: a dir
/// that is there goes, one that never existed is not an error, and a
/// sibling that is not on the list — the project folder — is untouched.
#[test]
fn remove_dirs_if_present_skips_missing_and_leaves_siblings_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions = tmp.path().join("sessions").join("p1");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(sessions.join("layout.json"), b"{}").unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("README.md"), b"mine").unwrap();
    std::fs::write(project.join("project.json"), b"{}").unwrap();
    let never_created = tmp.path().join("live_sessions").join("p1");

    remove_dirs_if_present(&[sessions.clone(), never_created.clone()]).unwrap();

    assert!(!sessions.exists(), "the session dir is gone");
    assert!(!never_created.exists());
    assert_eq!(std::fs::read(project.join("README.md")).unwrap(), b"mine");
    assert!(project.join("project.json").exists());
}

/// A VM project's overlay disk is its tree, so "keep the folder" has no
/// meaning for it — `forget_project` dispatches on this and refuses.
#[test]
fn entry_is_vm_reads_the_vm_spec() {
    let mut entry = ProjectEntry {
        id: "p1".into(),
        name: "P".into(),
        status: "inactive".into(),
        position: 0,
        local_file: "/tmp/p1/project.json".into(),
        extra: HashMap::new(),
    };
    assert!(!entry_is_vm(&entry));
    entry
        .extra
        .insert("vm".to_string(), Value::Null);
    assert!(!entry_is_vm(&entry), "an explicit null is not a VM");
    entry
        .extra
        .insert("vm".to_string(), serde_json::json!({ "image": "x" }));
    assert!(entry_is_vm(&entry));
}

/// An interrupted archive leaves a partial destination, and a retry must
/// resume *into* it. `rename` onto a non-empty directory fails with
/// `ENOTEMPTY`, not a cross-device error, so `move_tree` keeps copying when
/// the destination already exists.
#[test]
fn move_tree_resumes_into_a_partial_destination() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::write(src.join("a.txt"), b"new-a").unwrap();
    std::fs::write(src.join("sub/b.txt"), b"new-b").unwrap();

    let dst = tmp.path().join("archive").join("dir");
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(dst.join("a.txt"), b"partial").unwrap();

    move_tree(&src, &dst).unwrap();

    assert!(!src.exists(), "the source is removed once the copy completed");
    assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"new-a");
    assert_eq!(std::fs::read(dst.join("sub/b.txt")).unwrap(), b"new-b");
}

/// A rename refused for any reason other than a cross-device move, with no
/// destination in the way, is reported — never answered with a full copy
/// that then cannot remove its source.
#[cfg(unix)]
#[test]
fn move_tree_surfaces_a_non_cross_device_rename_error() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        // Root ignores the directory permission this test relies on.
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let locked = tmp.path().join("locked");
    let src = locked.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("a.txt"), b"x").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

    let dst = tmp.path().join("dst");
    let result = move_tree(&src, &dst);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(result.is_err(), "EACCES must surface: {result:?}");
    assert!(!dst.exists(), "no copy was made");
    assert!(src.join("a.txt").exists(), "the source is untouched");
}

/// #23 D3. `copy_dir_all` skipped `.git` only when `is_dir()`, so in a linked
/// worktree the one-line `.git` FILE (`gitdir: <main>/.git/worktrees/<name>`)
/// was copied — producing a second directory claiming the SAME admin entry, in
/// which git writes into the original's index and HEAD.
#[test]
fn copying_a_tree_never_carries_a_git_pointer_of_either_kind() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    std::fs::create_dir_all(src.join(".git")).unwrap();
    std::fs::write(src.join(".git/HEAD"), b"ref: refs/heads/main").unwrap();
    std::fs::write(src.join("a.txt"), b"x").unwrap();

    // A linked worktree inside the tree: `.git` is a file, not a directory.
    let wt = src.join("wt");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join(".git"), b"gitdir: /elsewhere/.git/worktrees/wt").unwrap();
    std::fs::write(wt.join("b.txt"), b"x").unwrap();

    let dst = tmp.path().join("dst");
    copy_dir_all(&src, &dst).unwrap();

    assert!(dst.join("a.txt").exists());
    assert!(
        !dst.join(".git").exists(),
        "the repo's own .git must not travel"
    );
    assert!(
        !dst.join("wt").exists(),
        "a directory holding a .git of either kind is not this tree's content"
    );
}

/// §9.4: the archive/move copy (`keep_git: true`) carries `.git` verbatim —
/// the tree IS the project, history included — where the duplicate path
/// (`copy_dir_all`) leaves it behind.
#[test]
fn the_move_copy_carries_git_state_verbatim() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    std::fs::create_dir_all(src.join(".git")).unwrap();
    std::fs::write(src.join(".git/HEAD"), b"ref: refs/heads/main").unwrap();
    std::fs::write(src.join("a.txt"), b"x").unwrap();

    let dst = tmp.path().join("dst");
    copy_tree_core(&src, &dst, true).unwrap();
    assert!(dst.join("a.txt").exists());
    assert!(dst.join(".git/HEAD").exists());
}

/// §9.4: symlinks are recreated as links (never followed), and a DANGLING
/// one — a stale venv/node `bin` pointer is the ordinary case — is copied
/// rather than erroring out the whole move partway, which used to strand a
/// cross-device `archive_project` in an unretryable half-moved state.
#[cfg(unix)]
#[test]
fn symlinks_are_preserved_and_a_dangling_one_is_tolerated() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("real.txt"), b"x").unwrap();
    std::os::unix::fs::symlink("real.txt", src.join("live-link")).unwrap();
    std::os::unix::fs::symlink("/nonexistent/python", src.join("dangling")).unwrap();

    let dst = tmp.path().join("dst");
    copy_tree_core(&src, &dst, true).unwrap();

    assert_eq!(
        std::fs::read_link(dst.join("live-link")).unwrap(),
        std::path::PathBuf::from("real.txt"),
        "a live link must stay a link, not become a second copy"
    );
    assert_eq!(
        std::fs::read_link(dst.join("dangling")).unwrap(),
        std::path::PathBuf::from("/nonexistent/python"),
        "a dangling link is carried, not an error"
    );
    // Re-run over the same destination: a resumed archive pass must be
    // idempotent, including replacing the links it already made.
    copy_tree_core(&src, &dst, true).unwrap();
}

/// A worktree copied as a bare directory would be worse than useless — but a
/// stray `.git` FILE at the top level must be dropped too, whatever the tree
/// around it looks like.
#[test]
fn a_worktree_rooted_source_copies_its_files_without_its_git_file() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("wt");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::write(src.join(".git"), b"gitdir: /elsewhere/.git/worktrees/wt").unwrap();
    std::fs::write(src.join("sub/a.txt"), b"x").unwrap();

    let dst = tmp.path().join("dst");
    copy_dir_all(&src, &dst).unwrap();
    assert!(dst.join("sub/a.txt").exists());
    assert!(!dst.join(".git").exists());
}

// ── Duplicate registration ─────────────────────────────────────────────

fn entry(id: &str, name: &str, extra: Vec<(&str, Value)>) -> ProjectEntry {
    ProjectEntry {
        id: id.to_string(),
        name: name.to_string(),
        status: "inactive".to_string(),
        position: 10,
        local_file: format!("/p/{id}/project.json"),
        extra: extra.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
    }
}

// ── Reserved scope ids (`storage::is_reserved_scope`) ──────────────────

/// A project record that names a scope the app keeps for itself — root's,
/// the chat assistant's — is not a project: never read, never written, and
/// not an id a command may validate.
#[test]
fn a_project_cannot_take_a_reserved_scope_id() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("projects.json");
    let hand_edited = vec![
        entry("p1", "Real", vec![]),
        entry("assistant", "Borrowed", vec![("directory", serde_json::json!("/home/u/secret"))]),
        entry("Assistant", "Borrowed", vec![]),
        entry("root", "Borrowed", vec![]),
        entry("assistant ", "Borrowed", vec![]),
    ];
    std::fs::write(&path, serde_json::to_vec(&hand_edited).unwrap()).unwrap();

    // Dropped on the way in; the next write lands without them.
    let mut list = hand_edited.clone();
    assert!(drop_reserved_projects(&mut list));
    assert_eq!(list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["p1"]);
    assert!(!drop_reserved_projects(&mut list));
    let seen = patch_projects_list_at(&path, |list| Ok(list.iter().map(|p| p.id.clone()).collect::<Vec<_>>())).unwrap();
    assert_eq!(seen, ["p1"]);
    let stored: ProjectsList = storage::read_json(&path).unwrap();
    assert_eq!(stored.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["p1"], "rewritten without the borrowed records");

    // A patch that adds one — create, import, clone, VM, share — is refused
    // whole, and the file is as it was.
    for id in ["assistant", "ASSISTANT", " assistant", "root", "Root"] {
        let before = std::fs::read(&path).unwrap();
        let refused = patch_projects_list_at(&path, |list| {
            list.push(entry(id, "New", vec![]));
            Ok(())
        });
        assert!(refused.is_err(), "{id:?}");
        assert_eq!(std::fs::read(&path).unwrap(), before, "{id:?}");
    }
    // An ordinary id still goes through.
    patch_projects_list_at(&path, |list| {
        list.push(entry("assistant2", "Fine", vec![]));
        Ok(())
    })
    .unwrap();

    for id in ["assistant", "Assistant", "root", "assistant "] {
        assert!(validate_project_id(id).is_err(), "{id:?}");
    }
    assert!(validate_project_id("0b9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a10").is_ok());
    assert!(validate_project_id("assistant2").is_ok());
    // And no folder is ever looked up for one, planted or not.
    assert_eq!(crate::services::sandbox::project_dir_for("assistant"), None);
}

/// A project keeps an old-named screenshots or mail folder it already
/// has, so the default ignore list names both spellings: regenerating a
/// `.gitignore` must never un-ignore a folder of filed private data.
#[test]
fn the_default_gitignore_covers_the_generated_folders_under_both_names() {
    let lines: Vec<&str> = GITIGNORE_DEFAULT.lines().collect();
    for dir in [
        crate::brand::SCREENSHOTS_DIR,
        crate::brand::EMAILS_DIR,
        crate::brand::LEGACY_SCREENSHOTS_DIR,
        crate::brand::LEGACY_EMAILS_DIR,
    ] {
        assert!(lines.contains(&format!("{dir}/").as_str()), "{dir}/ is ignored");
    }
    assert!(lines.contains(&crate::brand::PROJECT_DIR_EXCLUDE_RULE));
    assert!(lines.contains(&"screenshots/") && lines.contains(&"emails/"));
}

#[test]
fn the_retired_trash_workspace_entry_is_dropped_and_nothing_else() {
    let mut list = vec![
        // The entry an old build wrote: its id and its marker carry the old name.
        entry(paths::LEGACY_TRASH_PROJECT_ID, "Trash", vec![(concat!(crate::legacy_slug!(), "_trash"), Value::Bool(true))]),
        entry("p1", "Trash", vec![]),
    ];
    drop_legacy_trash_project(&mut list);
    let ids: Vec<&str> = list.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, ["p1"]);
}

fn local_entry(id: &str, name: &str, dir: &str) -> ProjectEntry {
    entry(
        id,
        name,
        vec![("directory", Value::String(dir.to_string()))],
    )
}

// ── Project folder rename ──────────────────────────────────────────────

fn dir_rename_status(list: &ProjectsList, id: &str, leaf: &str) -> String {
    plan_dir_rename(list, id, false, leaf).unwrap().status
}

#[test]
fn dir_rename_plan_refuses_anything_already_at_the_target() {
    let tmp = tempfile::tempdir().unwrap();
    let old = tmp.path().join("alpha");
    fs::create_dir(&old).unwrap();
    fs::create_dir(tmp.path().join("taken")).unwrap();
    fs::write(tmp.path().join("afile"), "x").unwrap();
    let list = vec![local_entry("a", "Alpha", &old.to_string_lossy())];

    assert_eq!(dir_rename_status(&list, "a", "beta"), "ok");
    assert_eq!(dir_rename_status(&list, "a", "  beta "), "ok");
    assert_eq!(dir_rename_status(&list, "a", "alpha"), "same");
    assert_eq!(dir_rename_status(&list, "a", "taken"), "exists");
    assert_eq!(dir_rename_status(&list, "a", "afile"), "exists");
    let plan = plan_dir_rename(&list, "a", false, "beta").unwrap();
    assert_eq!(plan.target_dir, tmp.path().join("beta").to_string_lossy());
}

#[test]
fn dir_rename_plan_rejects_bad_leaves_and_unsupported_projects() {
    let tmp = tempfile::tempdir().unwrap();
    let old = tmp.path().join("alpha");
    fs::create_dir(&old).unwrap();
    let dir = old.to_string_lossy().to_string();
    let mut vm = local_entry("v", "Vm", &dir);
    vm.extra
        .insert("vm".into(), serde_json::json!({ "enabled": true }));
    let list = vec![
        local_entry("a", "Alpha", &dir),
        vm,
        local_entry("gone", "Gone", &tmp.path().join("nope").to_string_lossy()),
    ];
    for bad in ["", "..", "a/b", "a\\b", "x:", "trail.", "a\tb"] {
        assert_eq!(dir_rename_status(&list, "a", bad), "invalid", "{bad:?}");
    }
    assert_eq!(plan_dir_rename(&list, "a", true, "b").unwrap().status, "unsupported");
    assert_eq!(dir_rename_status(&list, "v", "b"), "unsupported");
    assert_eq!(dir_rename_status(&list, "gone", "b"), "missing");
    assert!(plan_dir_rename(&list, "nobody", false, "b").is_err());
}

#[test]
fn dir_rename_plan_guards_other_projects_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let old = tmp.path().join("alpha");
    fs::create_dir(&old).unwrap();
    let dir = old.to_string_lossy().to_string();
    // A registered project whose folder was deleted still owns its path.
    let registered = local_entry("r", "R", &tmp.path().join("beta").to_string_lossy());
    let list = vec![local_entry("a", "Alpha", &dir), registered];
    assert_eq!(dir_rename_status(&list, "a", "beta"), "registered");

    // Another project living inside this folder would lose its path.
    let inner = local_entry("i", "Inner", &format!("{dir}/sub"));
    let list = vec![local_entry("a", "Alpha", &dir), inner];
    assert_eq!(dir_rename_status(&list, "a", "gamma"), "nested");
    // …but a sibling that merely shares the prefix does not.
    let sibling = local_entry("s", "S", &format!("{dir}x"));
    let list = vec![local_entry("a", "Alpha", &dir), sibling];
    assert_eq!(dir_rename_status(&list, "a", "gamma"), "ok");
}

#[test]
fn rename_dir_no_replace_never_touches_an_existing_target() {
    let tmp = tempfile::tempdir().unwrap();
    let old = tmp.path().join("alpha");
    fs::create_dir(&old).unwrap();
    fs::write(old.join("keep.txt"), "mine").unwrap();
    // An EMPTY directory is exactly what plain `rename(2)` would replace.
    let empty = tmp.path().join("empty");
    fs::create_dir(&empty).unwrap();
    assert!(rename_dir_no_replace(&old, &empty).is_err());
    assert!(old.join("keep.txt").exists());
    assert!(empty.is_dir());

    let full = tmp.path().join("full");
    fs::create_dir(&full).unwrap();
    fs::write(full.join("theirs.txt"), "theirs").unwrap();
    assert!(rename_dir_no_replace(&old, &full).is_err());
    assert!(!full.join("keep.txt").exists());

    let free = tmp.path().join("beta");
    rename_dir_no_replace(&old, &free).unwrap();
    assert!(!old.exists());
    assert_eq!(fs::read_to_string(free.join("keep.txt")).unwrap(), "mine");
}

fn spec(user: Option<&str>, host: &str, port: Option<u16>, path: &str) -> RemoteSpec {
    RemoteSpec {
        user: user.map(str::to_string),
        host: host.to_string(),
        port,
        remote_path: path.to_string(),
        openvpn: None,
        auto_connect: None,
        key_auth: None,
        persist_sessions: None,
        vm: None,
        label: None,
        extra: HashMap::new(),
    }
}

fn remote_entry(id: &str, name: &str, spec: &RemoteSpec, mirror: Option<&str>) -> ProjectEntry {
    let mut extra = vec![
        (
            "directory",
            Value::String(format!("/state/remote-projects/{id}")),
        ),
        ("remote", serde_json::to_value(spec).unwrap()),
    ];
    if let Some(mirror) = mirror {
        extra.push(("mirror", Value::String(mirror.to_string())));
    }
    entry(id, name, extra)
}

#[test]
fn lexical_normalize_drops_cur_dir_and_trailing_separator() {
    assert_eq!(
        lexical_normalize(Path::new("/a/./foo/")),
        PathBuf::from("/a/foo")
    );
}

#[test]
fn lexical_normalize_pops_parent_dir() {
    assert_eq!(
        lexical_normalize(Path::new("/a/b/../foo")),
        PathBuf::from("/a/foo")
    );
}

#[test]
fn lexical_normalize_keeps_leading_parent_dir_of_relative_path() {
    // Nothing to pop, so `..` has to survive or the path changes meaning.
    assert_eq!(lexical_normalize(Path::new("../a")), PathBuf::from("../a"));
}

#[test]
fn lexical_normalize_cannot_climb_above_root() {
    assert_eq!(lexical_normalize(Path::new("/../a")), PathBuf::from("/a"));
}

#[test]
fn local_dir_key_ignores_trailing_separator() {
    // The case the old string compare missed: one folder, two spellings.
    assert_eq!(
        local_dir_key("/no/such/dir/foo/"),
        local_dir_key("/no/such/dir/foo")
    );
}

#[test]
fn local_dir_key_is_empty_for_blank_input() {
    assert_eq!(local_dir_key("   "), "");
}

#[test]
fn remote_path_key_normalizes_separators() {
    assert_eq!(remote_path_key("/home//alice/./work/"), "/home/alice/work");
}

#[test]
fn remote_path_key_keeps_root() {
    assert_eq!(remote_path_key("/"), "/");
}

#[test]
fn remote_path_key_leaves_tilde_unexpanded() {
    // Only the host knows what `~` resolves to; guessing would merge or split
    // two folders on no evidence.
    assert_eq!(remote_path_key("~/work"), "~/work");
    assert_ne!(
        remote_path_key("~/work"),
        remote_path_key("/home/alice/work")
    );
}

#[test]
fn ssh_target_key_defaults_port_and_lowercases_host() {
    assert_eq!(
        ssh_target_key(&spec(Some("alice"), "Build.Example.COM", None, "/w")),
        ssh_target_key(&spec(Some("alice"), "build.example.com", Some(22), "/w"))
    );
}

#[test]
fn ssh_target_key_treats_blank_user_as_absent() {
    assert_eq!(
        ssh_target_key(&spec(Some("  "), "h", None, "/w")),
        ssh_target_key(&spec(None, "h", None, "/w"))
    );
}

#[test]
fn conflict_finds_same_local_directory() {
    let list = vec![local_entry("a", "Foo", "/no/such/dir/foo")];
    let found = find_project_conflict(
        &list,
        &ProjectSite::Local {
            dir: "/no/such/dir/foo/",
        },
        None,
    )
    .expect("trailing separator must not hide a duplicate");
    assert_eq!(found.id, "a");
    assert_eq!(found.name, "Foo");
    assert_eq!(found.kind, "directory");
}

#[test]
fn conflict_ignores_an_unrelated_directory() {
    let list = vec![local_entry("a", "Foo", "/no/such/dir/foo")];
    assert!(find_project_conflict(
        &list,
        &ProjectSite::Local {
            dir: "/no/such/dir/bar"
        },
        None
    )
    .is_none());
}

#[test]
fn conflict_flags_a_remote_projects_mirror() {
    // The mirror is a real local tree lockstep already owns — importing it as
    // its own project puts two projects on one working copy.
    let list = vec![remote_entry(
        "a",
        "Foo",
        &spec(Some("alice"), "h", None, "/work"),
        Some("/no/such/dir/mirror"),
    )];
    let found = find_project_conflict(
        &list,
        &ProjectSite::Local {
            dir: "/no/such/dir/mirror",
        },
        None,
    )
    .expect("a mirror is an owned tree");
    assert_eq!(found.kind, "mirror");
}

#[test]
fn conflict_finds_same_host_path() {
    // The gap the old check could not see at all: a remote project's registered
    // `directory` is a per-id state dir, so it never matched twice.
    let list = vec![remote_entry(
        "a",
        "Foo",
        &spec(Some("alice"), "build.example.com", None, "/home/alice/work"),
        None,
    )];
    let found = find_project_conflict(
        &list,
        &ProjectSite::Remote {
            spec: &spec(
                Some("alice"),
                "Build.Example.com",
                Some(22),
                "/home/alice/work/",
            ),
        },
        None,
    )
    .expect("same login, same host, same path");
    assert_eq!(found.kind, "remote-path");
    assert_eq!(found.id, "a");
}

#[test]
fn conflict_treats_a_different_login_as_a_different_site() {
    let list = vec![remote_entry(
        "a",
        "Foo",
        &spec(Some("alice"), "h", None, "/work"),
        None,
    )];
    assert!(find_project_conflict(
        &list,
        &ProjectSite::Remote {
            spec: &spec(Some("bob"), "h", None, "/work")
        },
        None
    )
    .is_none());
}

#[test]
fn conflict_treats_a_different_port_as_a_different_site() {
    let list = vec![remote_entry(
        "a",
        "Foo",
        &spec(Some("alice"), "h", Some(22), "/work"),
        None,
    )];
    assert!(find_project_conflict(
        &list,
        &ProjectSite::Remote {
            spec: &spec(Some("alice"), "h", Some(2222), "/work")
        },
        None
    )
    .is_none());
}

#[test]
fn conflict_does_not_match_a_nested_host_path() {
    // A subfolder of a paired root is its own site; a prefix compare would
    // wrongly claim `/work2` collides with `/work`.
    let list = vec![remote_entry(
        "a",
        "Foo",
        &spec(Some("alice"), "h", None, "/work"),
        None,
    )];
    for path in ["/work2", "/work/sub"] {
        assert!(
            find_project_conflict(
                &list,
                &ProjectSite::Remote {
                    spec: &spec(Some("alice"), "h", None, path)
                },
                None
            )
            .is_none(),
            "{path} must not collide with /work"
        );
    }
}

#[test]
fn conflict_skips_the_project_being_repointed() {
    // Extend-to-remote edits an entry that is already in the list.
    let list = vec![remote_entry(
        "a",
        "Foo",
        &spec(Some("alice"), "h", None, "/work"),
        None,
    )];
    let site = ProjectSite::Remote {
        spec: &spec(Some("alice"), "h", None, "/work"),
    };
    assert!(find_project_conflict(&list, &site, Some("a")).is_none());
    assert!(find_project_conflict(&list, &site, Some("other")).is_some());
}

#[test]
fn conflict_message_names_the_existing_project() {
    let conflict = ProjectConflict {
        id: "a".to_string(),
        name: "Foo".to_string(),
        kind: "directory".to_string(),
    };
    assert!(conflict_message(&conflict).contains("Foo"));
}

// ── sanitize_name ──────────────────────────────────────────────────────

#[test]
fn sanitize_name_lowercase_alphanumeric() {
    assert_eq!(sanitize_name("MyProject"), "myproject");
}

#[test]
fn sanitize_name_replaces_spaces_with_dash() {
    assert_eq!(sanitize_name("my project"), "my-project");
}

#[test]
fn sanitize_name_replaces_special_chars() {
    assert_eq!(sanitize_name("my!project@2"), "my-project-2");
}

#[test]
fn sanitize_name_collapses_consecutive_dashes() {
    assert_eq!(sanitize_name("my  project"), "my-project");
    assert_eq!(sanitize_name("a---b"), "a-b");
}

#[test]
fn sanitize_name_trims_leading_trailing_dashes() {
    assert_eq!(sanitize_name("  hello  "), "hello");
    assert_eq!(sanitize_name("!hello!"), "hello");
}

#[test]
fn sanitize_name_preserves_underscore() {
    assert_eq!(sanitize_name("my_project"), "my_project");
}

#[test]
fn sanitize_name_empty_after_stripping() {
    assert_eq!(sanitize_name("!!!"), "");
    assert_eq!(sanitize_name(""), "");
    assert_eq!(sanitize_name("   "), "");
}

#[test]
fn sanitize_name_numeric_only() {
    assert_eq!(sanitize_name("123"), "123");
}

#[test]
fn sanitize_name_unicode_becomes_dash() {
    // Non-ASCII chars are replaced with '-', then collapsed.
    let result = sanitize_name("café");
    assert!(!result.contains("é"), "unicode must be replaced");
    assert!(!result.contains("--"), "consecutive dashes collapsed");
}

// ── normalize_git_type ─────────────────────────────────────────────────

#[test]
fn normalize_git_type_migrates_legacy_values() {
    assert_eq!(normalize_git_type("private"), "remote-private");
    assert_eq!(normalize_git_type("public"), "remote-public");
}

#[test]
fn normalize_git_type_passes_through_canonical_values() {
    assert_eq!(normalize_git_type("local"), "local");
    assert_eq!(normalize_git_type("none"), "none");
    assert_eq!(normalize_git_type("remote-private"), "remote-private");
    assert_eq!(normalize_git_type("remote-public"), "remote-public");
}

#[test]
fn normalize_git_type_unknown_falls_back_to_local() {
    assert_eq!(normalize_git_type(""), "local");
    assert_eq!(normalize_git_type("weird"), "local");
    assert_eq!(normalize_git_type("  public  "), "remote-public");
}

#[test]
fn git_provider_rides_only_on_a_hosted_project() {
    // The clone/fork URL's own host, kept for the two providers Tabtivity speaks.
    assert_eq!(
        normalize_git_provider(Some("GitHub"), "remote-private").as_deref(),
        Some("github")
    );
    assert_eq!(
        normalize_git_provider(Some(" gitlab "), "remote-public").as_deref(),
        Some("gitlab")
    );
    // A project pushed nowhere must not carry a hosting badge…
    assert_eq!(normalize_git_provider(Some("github"), "local"), None);
    assert_eq!(normalize_git_provider(Some("github"), "none"), None);
    // …and neither does an unrecognized (self-hosted) host.
    assert_eq!(normalize_git_provider(Some("gitea"), "remote-private"), None);
    assert_eq!(normalize_git_provider(None, "remote-private"), None);
}

// ── normalize_entry ────────────────────────────────────────────────────

fn legacy_entry() -> ProjectEntry {
    // A pre-Group-D stub like the self-hosting checkout's entry: core fields only,
    // no `directory`, no `git_type`.
    ProjectEntry {
        id: "legacy-id".to_string(),
        name: concat!("Project", crate::app_name!()).to_string(),
        status: "active".to_string(),
        position: 10,
        local_file: concat!("/home/u/", crate::app_slug!(), "/projects/project", crate::app_slug!(), "/project.json").to_string(),
        extra: HashMap::new(),
    }
}

#[test]
fn normalize_entry_backfills_directory_from_local_file() {
    let mut entry = legacy_entry();
    normalize_entry(&mut entry);
    assert_eq!(
        entry.extra.get("directory").and_then(Value::as_str),
        Some(concat!("/home/u/", crate::app_slug!(), "/projects/project", crate::app_slug!())),
    );
}

#[test]
fn normalize_entry_keeps_existing_directory() {
    let mut entry = legacy_entry();
    entry.extra.insert(
        "directory".to_string(),
        Value::String("/custom/dir".to_string()),
    );
    normalize_entry(&mut entry);
    assert_eq!(
        entry.extra.get("directory").and_then(Value::as_str),
        Some("/custom/dir"),
    );
}

#[test]
fn normalize_entry_canonicalizes_legacy_git_type() {
    let mut entry = legacy_entry();
    entry
        .extra
        .insert("git_type".to_string(), Value::String("public".to_string()));
    normalize_entry(&mut entry);
    assert_eq!(
        entry.extra.get("git_type").and_then(Value::as_str),
        Some("remote-public"),
    );
}

// ── Step-by-step migration ─────────────────────────────────────────────

#[test]
fn migration_plan_lists_one_step_per_missing_piece() {
    let tmp = tempfile::tempdir().unwrap();
    let steps = migration_steps_at(tmp.path(), true).unwrap();
    // Every scaffold file + .claude/settings.json as createFile, plus the
    // gitignore and git-init steps.
    let create: Vec<&str> = steps
        .iter()
        .filter(|s| s.kind == "createFile")
        .filter_map(|s| s.path.as_deref())
        .collect();
    assert_eq!(create.len(), SCAFFOLD_FILES.len() + 1);
    assert!(create.contains(&"AGENTS.md"));
    assert!(create.contains(&".claude/settings.json"));
    let gitignore = steps.iter().find(|s| s.id == "gitignore").unwrap();
    assert!(gitignore.details.contains(&"project.json".to_string()));
    assert!(steps.iter().any(|s| s.id == "git_init"));
}

#[test]
fn migration_plan_offers_a_stub_upgrade_not_a_create_for_a_legacy_doc() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), false).unwrap();
    std::fs::write(tmp.path().join("CLAUDE.md"), "# Claude Context\n").unwrap();
    let steps = migration_steps_at(tmp.path(), false).unwrap();
    assert_eq!(
        steps,
        vec![MigrationStep {
            id: "stub:CLAUDE.md".to_string(),
            kind: "upgradeStub".to_string(),
            path: Some("CLAUDE.md".to_string()),
            details: vec![],
        }],
        "a complete no-git scaffold with one legacy stub has exactly that one step"
    );
}

#[test]
fn migration_apply_honours_declines_step_by_step() {
    let tmp = tempfile::tempdir().unwrap();
    // Accept only two of the plan's steps; everything declined must stay
    // exactly as it was — including git init.
    let accepted: HashSet<String> = ["file:AGENTS.md".to_string(), "gitignore".to_string()]
        .into_iter()
        .collect();
    let report = apply_migration_steps_at(tmp.path(), true, &accepted).unwrap();
    assert_eq!(report.created_files, vec!["AGENTS.md"]);
    assert!(!report.gitignore_lines_added.is_empty());
    assert!(tmp.path().join(".gitignore").exists());
    assert!(!tmp.path().join("TODO.md").exists(), "declined file created");
    assert!(
        !tmp.path().join(".claude/settings.json").exists(),
        "declined settings created"
    );
    assert!(!report.git_initialized);
    assert!(!tmp.path().join(".git").exists(), "declined git init ran");
}

#[test]
fn migration_apply_rechecks_disk_so_a_stale_accept_never_overwrites() {
    let tmp = tempfile::tempdir().unwrap();
    // Planned as missing, but the user (or an agent) wrote real content
    // before the apply landed — the accepted create must become a no-op.
    std::fs::write(tmp.path().join("AGENTS.md"), "# Agents\n\nReal guidance.\n").unwrap();
    let accepted: HashSet<String> =
        ["file:AGENTS.md".to_string(), "stub:AGENTS.md".to_string()]
            .into_iter()
            .collect();
    let report = apply_migration_steps_at(tmp.path(), false, &accepted).unwrap();
    assert!(report.created_files.is_empty());
    assert!(report.updated_files.is_empty());
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("AGENTS.md")).unwrap(),
        "# Agents\n\nReal guidance.\n",
    );
}

#[test]
fn entry_migration_details_previews_the_normalize_diff() {
    let mut entry = legacy_entry();
    entry
        .extra
        .insert("git_type".to_string(), Value::String("private".to_string()));
    let details = entry_migration_details(&entry);
    assert_eq!(
        details,
        vec![
            concat!("directory → /home/u/", crate::app_slug!(), "/projects/project", crate::app_slug!()).to_string(),
            "git_type: private → remote-private".to_string(),
        ],
    );
    // An already-normalized entry previews no step.
    let mut probe = entry.clone();
    normalize_entry(&mut probe);
    assert!(entry_migration_details(&probe).is_empty());
}

// ── scaffold_project ───────────────────────────────────────────────────

#[test]
fn scaffold_project_creates_all_files() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), true).unwrap();

    // Derived from SCAFFOLD_FILES rather than a hand-kept copy, so a file
    // added to the scaffold later is covered here without an edit.
    for (name, _) in SCAFFOLD_FILES {
        assert!(tmp.path().join(name).exists(), "missing: {name}");
    }
    assert!(tmp.path().join(".gitignore").exists());
    assert!(tmp.path().join(".claude/settings.json").exists());
}

/// A screen grab holds whatever was on the screen, and a project with a
/// public remote is one `git add -A` away from publishing it. The default
/// is what makes a saved shot ignored rather than staged.
#[test]
fn scaffold_project_gitignores_screenshots() {
    let dir = tempfile::tempdir().unwrap();
    scaffold_project(dir.path(), true).unwrap();
    let gitignore = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
    assert!(gitignore.lines().any(|line| line == concat!(crate::app_slug!(), "-screenshots/")));
    // The pre-rename folder stays ignored: projects still hold one.
    assert!(gitignore.lines().any(|line| line == "screenshots/"));
}

/// A saved attachment is someone's mail, filed into the tree by a user who
/// wanted to keep it — not to push it to a public remote. Scaffold repair
/// appends the pattern to projects whose `.gitignore` predates it.
#[test]
fn scaffold_project_gitignores_saved_emails() {
    let dir = tempfile::tempdir().unwrap();
    scaffold_project(dir.path(), true).unwrap();
    let gitignore = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
    assert!(gitignore.lines().any(|line| line == concat!(crate::app_slug!(), "-emails/")));
    assert!(gitignore.lines().any(|line| line == "emails/"));
}

/// The write paths cannot wait for a scaffold repair that may never be run:
/// a project whose `.gitignore` predates the folder gets the pattern before
/// the first file lands in it.
#[test]
fn a_project_keeps_the_generated_folder_it_already_has() {
    use crate::brand::{Name, PAIR};
    use crate::services::brand_migration::testing::RENAMED;
    let name = Name::SCREENSHOTS_DIR;
    let (cur, old) = (RENAMED.cur(name), RENAMED.legacy(name).unwrap());

    // Nothing there yet: the current name.
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(generated_dir_name_for(&RENAMED, dir.path(), name), cur);
    // Only the old folder: it is kept.
    fs::create_dir(dir.path().join(&old)).unwrap();
    assert_eq!(generated_dir_name_for(&RENAMED, dir.path(), name), old);
    // Both: the current one.
    fs::create_dir(dir.path().join(&cur)).unwrap();
    assert_eq!(generated_dir_name_for(&RENAMED, dir.path(), name), cur);

    // A link under the old name is not a folder the app made.
    #[cfg(unix)]
    {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join(&old)).unwrap();
        assert_eq!(generated_dir_name_for(&RENAMED, dir.path(), name), cur);
    }

    // An unchanged name is answered without a second lookup.
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(generated_dir_name_for(&PAIR, dir.path(), name), PAIR.cur(name));
    assert_eq!(project_generated_dir_blocking(dir.path().to_string_lossy().into_owned(), "emails".into()).unwrap(), EMAILS_DIR);
    assert!(project_generated_dir_blocking(String::new(), "other".into()).is_err());
}

#[test]
fn ensure_generated_dir_ignored_appends_once_and_only_for_app_folders() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(".gitignore"), "node_modules/\n").unwrap();

    assert!(ensure_generated_dir_ignored(dir.path(), SCREENSHOTS_DIR).unwrap());
    // Idempotent: a second save appends nothing.
    assert!(!ensure_generated_dir_ignored(dir.path(), SCREENSHOTS_DIR).unwrap());
    assert!(ensure_generated_dir_ignored(dir.path(), EMAILS_DIR).unwrap());

    let gitignore = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
    assert_eq!(
        gitignore
            .lines()
            .filter(|l| *l == concat!(crate::app_slug!(), "-screenshots/"))
            .count(),
        1
    );
    assert!(gitignore.lines().any(|line| line == "node_modules/"));

    // Not a folder Tabtivity generates: the file is left alone.
    assert!(!ensure_generated_dir_ignored(dir.path(), "src").unwrap());
    let after = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
    assert!(!after.contains("src"));
}

/// No `.gitignore` at all: saving a shot writes the one pattern it needs and
/// does not quietly scaffold the rest of the project around it.
#[cfg(unix)]
#[test]
fn ensure_generated_dir_ignored_never_writes_through_a_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let victim = dir.path().join("victim");
    fs::write(&victim, "precious\n").unwrap();
    std::os::unix::fs::symlink(&victim, dir.path().join(".gitignore")).unwrap();
    assert!(ensure_generated_dir_ignored(dir.path(), EMAILS_DIR).is_err());
    assert_eq!(fs::read_to_string(&victim).unwrap(), "precious\n");

    // Dangling: `exists()` says no, and a plain write would create the target.
    let dir = tempfile::tempdir().unwrap();
    let elsewhere = dir.path().join("elsewhere");
    std::os::unix::fs::symlink(&elsewhere, dir.path().join(".gitignore")).unwrap();
    assert!(ensure_generated_dir_ignored(dir.path(), EMAILS_DIR).is_err());
    assert!(!elsewhere.exists());
}

/// Scaffold repair appends the default patterns to the project's own
/// `.gitignore`: a committed `.gitignore -> ~/.bashrc` must not get them.
#[cfg(unix)]
#[test]
fn ensure_gitignore_defaults_never_writes_through_a_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let victim = dir.path().join("victim");
    fs::write(&victim, "precious\n").unwrap();
    std::os::unix::fs::symlink(&victim, dir.path().join(".gitignore")).unwrap();
    assert_eq!(ensure_gitignore_defaults(dir.path()).unwrap(), Vec::<String>::new());
    assert_eq!(fs::read_to_string(&victim).unwrap(), "precious\n");

    let dir = tempfile::tempdir().unwrap();
    let elsewhere = dir.path().join("elsewhere");
    std::os::unix::fs::symlink(&elsewhere, dir.path().join(".gitignore")).unwrap();
    assert_eq!(ensure_gitignore_defaults(dir.path()).unwrap(), Vec::<String>::new());
    assert!(!elsewhere.exists());
}

/// A planted FIFO `.gitignore` is left alone, never waited on.
#[cfg(unix)]
#[test]
fn a_fifo_gitignore_is_left_alone_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    crate::services::home_io::mkfifo(&dir.path().join(".gitignore"));
    let root = dir.path().to_path_buf();
    assert!(crate::services::home_io::within_deadline(move || missing_gitignore_lines_at(&root)).unwrap().is_empty());
    let root = dir.path().to_path_buf();
    assert!(crate::services::home_io::within_deadline(move || ensure_gitignore_defaults(&root)).unwrap().is_empty());
}

/// A linked `.gitignore` is left alone like every scaffold path, not a
/// failure of the whole repair or migration plan: the other steps
/// (`.claude/settings.json`) still run, and the project stops reading as
/// missing its scaffold once they have.
#[cfg(unix)]
#[test]
fn a_linked_gitignore_does_not_stop_the_rest_of_the_scaffold() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("p");
    fs::create_dir(&dir).unwrap();
    fs::create_dir(dir.join(".git")).unwrap();
    let elsewhere = tmp.path().join("elsewhere");
    std::os::unix::fs::symlink(&elsewhere, dir.join(".gitignore")).unwrap();

    let steps = migration_steps_at(&dir, true).unwrap();
    assert!(!steps.iter().any(|step| step.id == "gitignore"));
    assert!(steps.iter().any(|step| step.id == "claude_settings"));

    let report = repair_project_scaffold_at(&dir, true).unwrap();
    assert!(report.gitignore_lines_added.is_empty());
    assert!(dir.join(".claude").join("settings.json").is_file());
    assert!(!elsewhere.exists());
    assert!(!scaffold_is_missing_at(&dir, true), "a dangling link counts as present");

    // A dangling `.claude` or `settings.json` link is left alone by the
    // repair, so it must not read as missing for good either.
    fs::remove_dir_all(dir.join(".claude")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, dir.join(".claude")).unwrap();
    repair_project_scaffold_at(&dir, true).unwrap();
    assert!(!scaffold_is_missing_at(&dir, true), "a linked .claude is left alone");
    fs::remove_file(dir.join(".claude")).unwrap();
    fs::create_dir(dir.join(".claude")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, dir.join(".claude").join("settings.json")).unwrap();
    repair_project_scaffold_at(&dir, true).unwrap();
    assert!(!scaffold_is_missing_at(&dir, true), "a dangling settings.json is left alone");
    assert!(!elsewhere.exists());
}

/// Re-enabling git writes the default `.gitignore` only where there is
/// nothing: a dangling link would otherwise create its target outside the
/// project.
#[cfg(unix)]
#[test]
fn the_default_gitignore_is_never_written_through_a_dangling_link() {
    let dir = tempfile::tempdir().unwrap();
    let elsewhere = dir.path().join("elsewhere");
    std::os::unix::fs::symlink(&elsewhere, dir.path().join(".gitignore")).unwrap();
    let _ = write_default_gitignore_if_missing(dir.path());
    assert!(!elsewhere.exists());

    let dir = tempfile::tempdir().unwrap();
    write_default_gitignore_if_missing(dir.path()).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join(".gitignore")).unwrap(), GITIGNORE_DEFAULT);
    fs::write(dir.path().join(".gitignore"), "mine\n").unwrap();
    write_default_gitignore_if_missing(dir.path()).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join(".gitignore")).unwrap(), "mine\n");
}

/// Extend and detach delete the `project.json` they move: one that does not
/// parse must stop them, not be replaced by a blank project (losing its
/// time, created_at and description).
#[test]
fn an_unparsable_project_json_stops_the_move() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("project.json");
    assert_eq!(read_project_to_move(&file).unwrap().id, Project::default().id);
    fs::write(&file, "{ not json").unwrap();
    assert!(read_project_to_move(&file).is_err());
    fs::write(&file, r#"{"id":"p1","name":"P","directory":"d","description":"kept"}"#).unwrap();
    let project = read_project_to_move(&file).unwrap();
    assert_eq!(project.description.as_deref(), Some("kept"));
}

/// Extend reads the `project.json` it moves out of the project folder: a
/// link there is not read through (its target would be adopted into the
/// state dir), a dangling one is not taken for "none", and a FIFO is
/// refused without waiting on it.
#[cfg(unix)]
#[test]
fn a_linked_or_fifo_project_json_stops_the_move() {
    let dir = tempfile::tempdir().unwrap();
    let elsewhere = dir.path().join("elsewhere.json");
    fs::write(&elsewhere, r#"{"id":"x","name":"X","directory":"d","description":"not yours"}"#).unwrap();
    let linked = dir.path().join("project.json");
    std::os::unix::fs::symlink(&elsewhere, &linked).unwrap();
    assert!(read_project_to_move(&linked).is_err());
    fs::remove_file(&elsewhere).unwrap();
    assert!(read_project_to_move(&linked).is_err(), "a dangling link is not a missing file");

    let fifo = dir.path().join("fifo.json");
    crate::services::home_io::mkfifo(&fifo);
    assert!(crate::services::home_io::within_deadline(move || read_project_to_move(&fifo)).is_err());
}

/// An import writes its project over the folder's `project.json`: a
/// regular one past the size cap must stop it, not be taken for blank and
/// overwritten (losing its time and description). One that does not parse
/// is still replaced by a blank project, as it always was.
#[test]
fn an_oversized_project_json_stops_the_import() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("project.json");
    assert!(project_json_to_adopt(&file).unwrap().is_none());
    fs::write(&file, r#"{"id":"p1","name":"P","directory":"d","description":"kept"}"#).unwrap();
    assert_eq!(project_json_to_adopt(&file).unwrap().unwrap().description.as_deref(), Some("kept"));
    fs::write(&file, "{ not json").unwrap();
    assert_eq!(project_json_to_adopt(&file).unwrap().unwrap().id, Project::default().id);

    // Sparse: past the cap without writing 64 MB.
    let big = fs::File::create(&file).unwrap();
    big.set_len(storage::MAX_TREE_JSON_BYTES + 1).unwrap();
    drop(big);
    assert!(project_json_to_adopt(&file).is_err());
    assert_eq!(fs::metadata(&file).unwrap().len(), storage::MAX_TREE_JSON_BYTES + 1);
}

/// A linked or FIFO `project.json` stops the import too (the write would
/// refuse it anyway), and `load_project` refuses either without
/// following the link or waiting on the FIFO.
#[cfg(unix)]
#[test]
fn a_linked_or_fifo_project_json_is_not_adopted_or_loaded() {
    let dir = tempfile::tempdir().unwrap();
    let elsewhere = dir.path().join("elsewhere.json");
    fs::write(&elsewhere, r#"{"id":"x","name":"X","directory":"d"}"#).unwrap();
    let linked = dir.path().join("project.json");
    std::os::unix::fs::symlink(&elsewhere, &linked).unwrap();
    assert!(project_json_to_adopt(&linked).is_err());
    assert!(load_project_blocking(linked.to_string_lossy().into_owned()).is_err());

    let fifo = dir.path().join("fifo.json");
    crate::services::home_io::mkfifo(&fifo);
    let at = fifo.clone();
    assert!(crate::services::home_io::within_deadline(move || project_json_to_adopt(&at)).is_err());
    assert!(crate::services::home_io::within_deadline(move || load_project_blocking(fifo.to_string_lossy().into_owned())).is_err());
}

/// `write_no_follow` rewrites only a regular file: a FIFO swapped in after
/// the caller's check is refused at once, never waited on for a reader.
#[cfg(unix)]
#[test]
fn write_no_follow_refuses_a_fifo_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join(".gitignore");
    crate::services::home_io::mkfifo(&fifo);
    assert!(crate::services::home_io::within_deadline(move || write_no_follow(&fifo, b"x\n", false)).is_err());

    let plain = dir.path().join("plain");
    fs::write(&plain, "a much longer old text\n").unwrap();
    write_no_follow(&plain, b"new\n", false).unwrap();
    assert_eq!(fs::read_to_string(&plain).unwrap(), "new\n", "an existing file is truncated first");
}

/// The project list asks every project whether its scaffold is complete,
/// reading its agent docs: a FIFO planted as `CLAUDE.md` must not hang it,
/// nor the migration plan or the repair.
#[cfg(unix)]
#[test]
fn a_fifo_agent_doc_does_not_block_the_scaffold_checks() {
    let dir = tempfile::tempdir().unwrap();
    crate::services::home_io::mkfifo(&dir.path().join("CLAUDE.md"));
    let root = dir.path().to_path_buf();
    crate::services::home_io::within_deadline(move || scaffold_is_missing_at(&root, false));
    let root = dir.path().to_path_buf();
    let steps = crate::services::home_io::within_deadline(move || migration_steps_at(&root, false)).unwrap();
    assert!(!steps.iter().any(|step| step.path.as_deref() == Some("CLAUDE.md")), "the FIFO is left alone");
    let root = dir.path().to_path_buf();
    let accepted: HashSet<String> = ["stub:CLAUDE.md".to_string()].into();
    crate::services::home_io::within_deadline(move || apply_migration_steps_at(&root, false, &accepted)).unwrap();
    let root = dir.path().to_path_buf();
    let report = crate::services::home_io::within_deadline(move || repair_project_scaffold_at(&root, false)).unwrap();
    assert!(!report.updated_files.iter().any(|f| f == "CLAUDE.md"));
}

/// Detach removes the state-dir `project.json` only once the registry
/// points at the mirror: a refused patch leaves the project as it was.
#[test]
fn detach_drops_the_state_only_after_the_registry_moved() {
    let tmp = tempfile::tempdir().unwrap();
    let state_dir = tmp.path().join("remote-projects").join("p1");
    fs::create_dir_all(&state_dir).unwrap();
    let file = state_dir.join("project.json");
    fs::write(&file, "{}").unwrap();
    let refused: Result<(), String> =
        repoint_then_drop_state(|| Err("Project is not remote".to_string()), &file, &state_dir);
    assert!(refused.is_err());
    assert!(file.is_file(), "the state-dir project.json survives a failed patch");

    let mut moved = false;
    repoint_then_drop_state(
        || {
            moved = file.is_file();
            Ok(())
        },
        &file,
        &state_dir,
    )
    .unwrap();
    assert!(moved, "the registry moves while the state is still there");
    assert!(!state_dir.exists());
}

/// Tab cwds are compared by path components, so a cwd written with the
/// platform's own separator (`\` on Windows) is re-pointed too.
#[test]
fn a_tab_cwd_under_the_state_dir_moves_to_the_mirror() {
    let tmp = tempfile::tempdir().unwrap();
    let state_dir = tmp.path().join("remote-projects").join("p1");
    let mirror = tmp.path().join("mirror");
    let mirror_s = mirror.to_string_lossy().into_owned();
    let at = |p: &Path| p.to_string_lossy().into_owned();
    assert_eq!(rehome_tab_cwd(&at(&state_dir), &state_dir, &mirror_s), Some(mirror_s.clone()));
    assert_eq!(
        rehome_tab_cwd(&at(&state_dir.join("sub").join("deep")), &state_dir, &mirror_s),
        Some(at(&mirror.join("sub").join("deep")))
    );
    assert_eq!(rehome_tab_cwd(&at(&tmp.path().join("other")), &state_dir, &mirror_s), None);
    // A sibling whose name only starts with the state dir's is not under it.
    assert_eq!(rehome_tab_cwd(&format!("{}-x", at(&state_dir)), &state_dir, &mirror_s), None);
}

#[test]
fn ensure_generated_dir_ignored_creates_a_minimal_file() {
    let dir = tempfile::tempdir().unwrap();
    assert!(ensure_generated_dir_ignored(dir.path(), EMAILS_DIR).unwrap());
    let gitignore = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
    assert_eq!(gitignore, concat!(crate::app_slug!(), "-emails/\n"));
}

#[test]
fn scaffold_project_gitignores_project_json() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), true).unwrap();

    let content = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
    assert!(
        content.lines().any(|l| l == "project.json"),
        "default .gitignore must exclude project.json"
    );
}

#[test]
fn scaffold_project_does_not_overwrite_existing_files() {
    let tmp = tempfile::tempdir().unwrap();
    let todo_path = tmp.path().join("TODO.md");
    std::fs::write(&todo_path, "original content").unwrap();

    scaffold_project(tmp.path(), true).unwrap();

    let content = std::fs::read_to_string(&todo_path).unwrap();
    assert_eq!(
        content, "original content",
        "existing file must not be overwritten"
    );
}

#[test]
fn scaffold_project_does_not_overwrite_claude_settings() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join(".claude")).unwrap();
    let cs = tmp.path().join(".claude/settings.json");
    std::fs::write(&cs, r#"{"custom": true}"#).unwrap();

    scaffold_project(tmp.path(), true).unwrap();

    let content = std::fs::read_to_string(&cs).unwrap();
    assert!(
        content.contains("custom"),
        "custom settings must not be overwritten"
    );
}

#[test]
fn scaffold_project_keeps_every_existing_scaffold_file() {
    let tmp = tempfile::tempdir().unwrap();
    let mut ours: Vec<String> = SCAFFOLD_FILES.iter().map(|(n, _)| n.to_string()).collect();
    ours.push(".gitignore".to_string());
    ours.push(".claude/settings.json".to_string());
    std::fs::create_dir_all(tmp.path().join(".claude")).unwrap();
    for name in &ours {
        std::fs::write(tmp.path().join(name), format!("user's own {name}")).unwrap();
    }

    scaffold_project(tmp.path(), true).unwrap();

    for name in &ours {
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(name)).unwrap(),
            format!("user's own {name}"),
            "{name} must survive an import's scaffold"
        );
    }
}

#[cfg(unix)]
#[test]
fn scaffold_project_never_writes_through_a_shipped_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    // A tree can ship a dangling link: `exists()` says false, and a plain
    // write would create the link's target outside the project.
    let outside = tmp.path().join("outside.md");
    std::os::unix::fs::symlink(&outside, project.join("CLAUDE.md")).unwrap();
    let elsewhere = tmp.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, project.join(".claude")).unwrap();

    scaffold_project(&project, false).unwrap();

    assert!(!outside.exists(), "the link's target must not be created");
    assert!(!elsewhere.join("settings.json").exists());
    assert!(std::fs::symlink_metadata(project.join("CLAUDE.md"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(project.join("AGENTS.md").is_file(), "the rest is still scaffolded");
    let preview = scaffold_preview(&project);
    let claude = preview.iter().find(|i| i.path == "CLAUDE.md").unwrap();
    assert!(claude.exists, "the preview must call the kept link present");
}

#[test]
fn claim_new_project_dir_refuses_anything_already_there() {
    let tmp = tempfile::tempdir().unwrap();
    let fresh = tmp.path().join("parent/fresh");
    claim_new_project_dir(&fresh).unwrap();
    assert!(fresh.is_dir());
    assert!(project_folder_exists_blocking(fresh.to_string_lossy().to_string()));

    let err = claim_new_project_dir(&fresh).unwrap_err();
    assert!(err.contains("already exists"), "{err}");

    let file = tmp.path().join("a-file");
    std::fs::write(&file, "keep me").unwrap();
    assert!(claim_new_project_dir(&file).is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep me");

    assert!(claim_new_project_dir(Path::new("")).is_err());
    assert!(!project_folder_exists_blocking(String::new()));
    assert!(!project_folder_exists_blocking(
        tmp.path().join("nope").to_string_lossy().to_string()
    ));
}

#[cfg(unix)]
#[test]
fn claim_new_project_dir_refuses_a_dangling_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let link = tmp.path().join("link");
    std::os::unix::fs::symlink(tmp.path().join("missing"), &link).unwrap();
    assert!(project_folder_exists_blocking(link.to_string_lossy().to_string()));
    assert!(claim_new_project_dir(&link).is_err());
    assert!(!tmp.path().join("missing").exists());
}

#[test]
fn scaffold_project_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), true).unwrap();
    scaffold_project(tmp.path(), true).unwrap(); // second call must not error
    assert!(tmp.path().join("TODO.md").exists());
}

#[test]
fn scaffold_project_commits_scaffold_files() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), true).unwrap();

    // A commit exists (HEAD is born) so lockstep pairing has a tree to check out.
    let head = crate::paths::command_no_window("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(tmp.path())
        .output()
        .unwrap();
    assert!(
        head.status.success(),
        "scaffold must create an initial commit"
    );

    // The .claude settings and docs are TRACKED, not just present on disk — that
    // is what lets `extend` seed them onto the remote via the lockstep bundle.
    for path in &[".claude/settings.json", "CLAUDE.md", ".gitignore"] {
        let tracked = crate::paths::command_no_window("git")
            .args(["ls-files", "--error-unmatch", path])
            .current_dir(tmp.path())
            .output()
            .unwrap();
        assert!(tracked.status.success(), "{path} must be tracked by git");
    }
    assert!(
        !git_head_unborn(tmp.path()),
        "HEAD must be born after scaffold"
    );
}

#[test]
fn scaffold_project_without_git_skips_init() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), false).unwrap();
    // Scaffold files are still written, but no git repo is initialized.
    assert!(tmp.path().join("TODO.md").exists());
    assert!(tmp.path().join(".claude/settings.json").exists());
    assert!(
        !tmp.path().join(".git").exists(),
        "git must not be initialized when with_git is false"
    );
}

#[test]
fn scaffold_project_without_git_skips_gitignore() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), false).unwrap();
    // No git → no `.gitignore` (it's a git-axis artifact), but the docs and
    // .claude settings are still written.
    assert!(
        !tmp.path().join(".gitignore").exists(),
        ".gitignore must not be written for a no-git project"
    );
    assert!(tmp.path().join("TODO.md").exists());
    assert!(tmp.path().join(".claude/settings.json").exists());
}

#[test]
fn scaffold_preview_reports_git_directory_status() {
    let tmp = tempfile::tempdir().unwrap();

    let missing = scaffold_preview(tmp.path())
        .into_iter()
        .find(|item| item.path == ".git")
        .expect(".git preview item");
    assert!(!missing.exists);
    assert_eq!(missing.kind, "directory");

    std::fs::create_dir_all(tmp.path().join(".git")).unwrap();
    let present = scaffold_preview(tmp.path())
        .into_iter()
        .find(|item| item.path == ".git")
        .expect(".git preview item");
    assert!(present.exists);
    assert_eq!(present.kind, "directory");
}

// ── repair_project_scaffold_at ─────────────────────────────────────────

#[test]
fn repair_fills_missing_scaffold_docs_and_settings() {
    let tmp = tempfile::tempdir().unwrap();
    // Simulate a project scaffolded before DOCUMENTATION.md / .claude
    // settings existed: only a couple of the current scaffold files.
    std::fs::write(tmp.path().join("TODO.md"), "# TODO\n").unwrap();
    std::fs::write(tmp.path().join(".gitignore"), "node_modules/\n").unwrap();

    let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

    assert!(report.created_files.contains(&"AGENTS.md".to_string()));
    assert!(report
        .created_files
        .contains(&".claude/settings.json".to_string()));
    assert!(!report.created_files.contains(&"TODO.md".to_string()));
    assert!(tmp.path().join("DOCUMENTATION.md").exists());
    assert!(tmp.path().join(".claude/settings.json").exists());
}

#[test]
fn repair_merges_missing_gitignore_lines_without_clobbering() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(".gitignore"), "# my custom rule\nfoo/\n").unwrap();

    // `.gitignore` is a git-axis artifact, so the merge only runs for
    // git-backed projects.
    let report = repair_project_scaffold_at(tmp.path(), true).unwrap();

    assert!(report
        .gitignore_lines_added
        .contains(&"project.json".to_string()));
    let content = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
    assert!(content.contains("# my custom rule"));
    assert!(content.contains("foo/"));
    assert!(content.lines().any(|l| l == "project.json"));
}

#[test]
fn repair_without_git_does_not_touch_gitignore() {
    let tmp = tempfile::tempdir().unwrap();
    // A no-git project missing `.gitignore` entirely.
    let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

    assert!(
        !tmp.path().join(".gitignore").exists(),
        "no-git repair must not create a .gitignore"
    );
    assert!(report.gitignore_lines_added.is_empty());
    // Docs/settings are still filled in as usual.
    assert!(tmp.path().join("DOCUMENTATION.md").exists());
    assert!(tmp.path().join(".claude/settings.json").exists());
}

#[test]
fn repair_is_a_noop_when_scaffold_is_already_current() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), false).unwrap();

    let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

    assert!(report.is_empty());
}

#[test]
fn agents_empty_at_matches_missing_empty_stub_and_guidance() {
    let tmp = tempfile::tempdir().unwrap();
    // No AGENTS.md at all.
    assert!(agents_empty_at(tmp.path()));

    // Empty and whitespace-only.
    std::fs::write(tmp.path().join("AGENTS.md"), "").unwrap();
    assert!(agents_empty_at(tmp.path()));
    std::fs::write(tmp.path().join("AGENTS.md"), "  \n").unwrap();
    assert!(agents_empty_at(tmp.path()));

    // Untouched legacy stub and an untouched earlier template.
    std::fs::write(tmp.path().join("AGENTS.md"), "# Agents\n").unwrap();
    assert!(agents_empty_at(tmp.path()));
    std::fs::write(tmp.path().join("AGENTS.md"), AGENTS_HISTORY[0]).unwrap();
    assert!(agents_empty_at(tmp.path()));

    // Real project guidance is not empty.
    std::fs::write(tmp.path().join("AGENTS.md"), "# Agents\n\nRun `npm test`.\n").unwrap();
    assert!(!agents_empty_at(tmp.path()));
}

/// PROJECT.md is the navigation hub: a scaffold file it does not link is
/// unreachable by walking the map. Checked against `SCAFFOLD_FILES` rather
/// than a hand-kept list, so adding a scaffold file (REMARKS.md was the
/// one that slipped through) fails here until the map links it too.
#[test]
fn project_map_links_every_scaffold_file() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), true).unwrap();

    let map = std::fs::read_to_string(tmp.path().join("PROJECT.md")).unwrap();
    for (name, _) in SCAFFOLD_FILES {
        if *name == "PROJECT.md" {
            continue; // the map does not link itself
        }
        assert!(
            map.contains(&format!("(./{name})")),
            "PROJECT.md missing link to {name}"
        );
    }
    // The config files are scaffolded outside SCAFFOLD_FILES but belong on
    // the map all the same.
    for link in &["(./.claude/settings.json)", "(./.gitignore)"] {
        assert!(map.contains(link), "PROJECT.md missing link {link}");
    }
}

#[test]
fn agent_docs_point_at_agents_md_and_link_each_other() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), false).unwrap();

    let agents = std::fs::read_to_string(tmp.path().join("AGENTS.md")).unwrap();
    // AGENTS.md carries the instructions and points at the map; it is
    // loaded every session, so it doesn't repeat the map's links.
    assert!(agents.contains("(./PROJECT.md)"), "AGENTS.md must link PROJECT.md");
    for link in &["(./README.md)", "(./TODO.md)", "(./AGENTS.md)"] {
        assert!(!agents.contains(link), "AGENTS.md repeats the map: {link}");
    }
    assert!(!agents.contains(concat!(crate::app_slug!(), "-send")), concat!(crate::app_name!(), "'s own hint is not the project's"));

    // The agent-specific docs carry no instructions of their own: each
    // imports AGENTS.md and links the other agent files.
    for (name, sibling) in &[
        ("CLAUDE.md", "(./GEMINI.md)"),
        ("GEMINI.md", "(./CLAUDE.md)"),
    ] {
        let doc = std::fs::read_to_string(tmp.path().join(name)).unwrap();
        assert!(
            doc.lines().any(|l| l.trim() == "@AGENTS.md"),
            "{name} must import AGENTS.md"
        );
        assert!(doc.contains("(./AGENTS.md)"), "{name} must link AGENTS.md");
        assert!(doc.contains(sibling), "{name} must link {sibling}");
    }
}

#[test]
fn legacy_stub_detection_only_matches_untouched_agent_docs() {
    assert!(is_legacy_agent_stub("CLAUDE.md", "# Claude Context\n"));
    assert!(is_legacy_agent_stub("AGENTS.md", "# Agents\n"));
    assert!(is_legacy_agent_stub("GEMINI.md", "   \n"));
    // Real content, a non-agent doc, and the current template all fail.
    assert!(!is_legacy_agent_stub(
        "CLAUDE.md",
        "# Claude Context\n\nRun `make test`.\n"
    ));
    assert!(!is_legacy_agent_stub("TODO.md", "# TODO\n"));
    assert!(!is_legacy_agent_stub("AGENTS.md", AGENTS_SCAFFOLD));
}

#[test]
fn legacy_agent_stubs_mark_an_otherwise_complete_scaffold_missing() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), true).unwrap();
    assert!(!scaffold_is_missing_at(tmp.path(), true));

    // Die Crew predates AGENTS.md being canonical and has exactly these
    // untouched placeholders. They must keep the visible warning on until
    // the user repairs the project scaffold.
    for (name, content) in LEGACY_AGENT_STUBS {
        std::fs::write(tmp.path().join(name), content).unwrap();
    }

    assert!(scaffold_is_missing_at(tmp.path(), true));
    repair_project_scaffold_at(tmp.path(), true).unwrap();
    assert!(!scaffold_is_missing_at(tmp.path(), true));
}

#[test]
fn untouched_earlier_agents_templates_are_upgraded_and_edited_ones_kept() {
    for old in AGENTS_HISTORY {
        assert_ne!(*old, AGENTS_SCAFFOLD);
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), false).unwrap();
        std::fs::write(tmp.path().join("AGENTS.md"), old.replace('\n', "\r\n")).unwrap();
        assert!(scaffold_is_missing_at(tmp.path(), false));
        let report = repair_project_scaffold_at(tmp.path(), false).unwrap();
        assert_eq!(report.updated_files, vec!["AGENTS.md".to_string()]);
        assert_eq!(std::fs::read_to_string(tmp.path().join("AGENTS.md")).unwrap(), AGENTS_SCAFFOLD);

        let edited = format!("{old}\n## Mine\n");
        std::fs::write(tmp.path().join("AGENTS.md"), &edited).unwrap();
        assert!(!scaffold_is_missing_at(tmp.path(), false));
        repair_project_scaffold_at(tmp.path(), false).unwrap();
        assert_eq!(std::fs::read_to_string(tmp.path().join("AGENTS.md")).unwrap(), edited);
    }
}

/// Pins the shipped `AGENTS.md` template. When this fails, the template
/// changed: copy the *previous* text byte for byte into
/// `scaffold_history/AGENTS.<date>.md`, add it to `AGENTS_HISTORY`, then
/// update the pin — otherwise every project scaffolded with it keeps it.
#[test]
fn the_agents_template_is_pinned_so_its_predecessor_stays_upgradable() {
    let fnv1a = AGENTS_SCAFFOLD.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    assert_eq!(fnv1a, 0x75197758527454ff, "AGENTS_SCAFFOLD changed; see this test's doc");
}

#[test]
fn repair_upgrades_untouched_legacy_agent_stubs() {
    let tmp = tempfile::tempdir().unwrap();
    // A project scaffolded before AGENTS.md became canonical: three stubs,
    // one of which the user has since written real content into.
    std::fs::write(tmp.path().join("AGENTS.md"), "# Agents\n").unwrap();
    std::fs::write(tmp.path().join("CLAUDE.md"), "# Claude Context\n").unwrap();
    std::fs::write(tmp.path().join("GEMINI.md"), "# Gemini Context\n\nMine.\n").unwrap();

    let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

    assert!(report.updated_files.contains(&"AGENTS.md".to_string()));
    assert!(report.updated_files.contains(&"CLAUDE.md".to_string()));
    assert!(
        !report.updated_files.contains(&"GEMINI.md".to_string()),
        "a doc the user wrote must never be overwritten"
    );
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("GEMINI.md")).unwrap(),
        "# Gemini Context\n\nMine.\n"
    );
    assert!(std::fs::read_to_string(tmp.path().join("CLAUDE.md"))
        .unwrap()
        .contains("@AGENTS.md"));
}

#[test]
fn repair_leaves_current_agent_docs_alone() {
    let tmp = tempfile::tempdir().unwrap();
    scaffold_project(tmp.path(), false).unwrap();

    let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

    assert!(report.updated_files.is_empty());
    assert!(report.is_empty());
}

#[test]
fn repair_initializes_git_when_missing_and_requested() {
    let tmp = tempfile::tempdir().unwrap();

    let report = repair_project_scaffold_at(tmp.path(), true).unwrap();

    assert!(report.git_initialized);
    assert!(tmp.path().join(".git").is_dir());
}

#[test]
fn adopted_project_json_loses_every_executable_intent_field() {
    let mut project = Project {
        id: "old".to_string(),
        name: "Hostile".to_string(),
        directory: "/somewhere".to_string(),
        description: Some("keep me".to_string()),
        git_type: Some("local".to_string()),
        created_at: Some("2020-01-01".to_string()),
        open_apps: Some(vec![crate::schema::project::OpenApp {
            exec: "/tmp/pwn.sh".to_string(),
            file: None,
            mode: Some("standalone".to_string()),
            opened_at: None,
            pid: None,
            extra: Default::default(),
        }]),
        tab_layout: Some(vec![crate::schema::project::TabEntry {
            key: "t1".to_string(),
            label: "Shell".to_string(),
            cmd: "/tmp/pwn.sh".to_string(),
            cwd: "/".to_string(),
            session_id: None,
            extra: Default::default(),
        }]),
        tab_groups: Some(serde_json::json!({ "type": "group" })),
        open_tab_sessions: Some(serde_json::json!(["uuid"])),
        sandbox: Some(SandboxSpec {
            enabled: true,
            dockerfile: Some("Dockerfile".to_string()),
            network: Some("host".to_string()),
            ..Default::default()
        }),
        default_apps: Some(HashMap::from([(
            ".md".to_string(),
            "/tmp/pwn.sh".to_string(),
        )])),
        python_interpreter: Some("./pwn".to_string()),
        ..Default::default()
    };

    strip_untrusted_project_fields(&mut project);

    assert!(project.open_apps.is_none());
    assert!(project.tab_layout.is_none());
    assert!(project.tab_groups.is_none());
    assert!(project.open_tab_sessions.is_none());
    assert!(project.sandbox.is_none());
    assert!(project.default_apps.is_none());
    assert!(project.python_interpreter.is_none());
    // Descriptive fields survive — the import still adopts the metadata.
    assert_eq!(project.description.as_deref(), Some("keep me"));
    assert_eq!(project.git_type.as_deref(), Some("local"));
    assert_eq!(project.created_at.as_deref(), Some("2020-01-01"));
}

/// Sync commands that may stay sync in the files B1 (code screen 2026-10-25)
/// moved off the window's thread: each touches only the app's own state
/// dir (the registry, a session, the time log, the archive list) — plus,
/// for the registry setters, the one `project.json` mirror write — or
/// nothing at all. A sync command runs on the main thread, so one that
/// walks the project tree, stats a user-picked path or spawns a process
/// freezes the window while it works.
const SYNC_COMMANDS_ALLOWED: &[(&str, &str)] = &[
    ("projects.rs", "get_project_panel_prefs"),
    ("projects.rs", "set_project_panel_prefs"),
    ("projects.rs", "check_project_site"),
    ("projects.rs", "get_projects"),
    ("projects.rs", "save_projects"),
    ("projects.rs", "list_archived_projects"),
    ("projects.rs", "set_project_description"),
    ("projects.rs", "set_project_name"),
    ("projects.rs", "set_project_sandbox_spec"),
    ("projects.rs", "set_project_remote_control"),
    ("projects.rs", "set_project_schedule_mcp"),
    ("projects.rs", "set_project_git_push_mcp"),
    ("projects.rs", "set_project_openvpn"),
    ("projects.rs", "set_project_auto_connect"),
    ("projects.rs", "set_project_persist_sessions"),
    ("projects.rs", "set_project_mobile_access"),
    ("projects.rs", "set_project_remote_label"),
    ("projects.rs", "set_project_remote_user"),
    ("projects.rs", "set_project_run_host"),
    ("projects.rs", "add_compute_host"),
    ("projects.rs", "remove_compute_host"),
    ("projects.rs", "patch_compute_host"),
    ("projects.rs", "set_project_categories"),
    ("projects.rs", "load_tab_session"),
    ("projects.rs", "workspace_snapshot"),
    ("projects.rs", "workspace_sync"),
    ("projects.rs", "save_tab_layout"),
    ("projects.rs", "root_work_dir"),
    ("projects.rs", "projects_root_dir"),
    ("projects.rs", "remote_mirror_root_dir"),
    ("projects.rs", "get_time_today"),
    ("git.rs", "git_worktree_selection_supported"),
];

/// The sync Tauri commands of `src/commands/<file>`: `(name, body)` of the
/// `fn` after each `tauri::command` attribute that is not `async`. The body
/// runs to the closing `}` in column 0 (a command is a top-level item).
fn sync_commands_in(file: &str) -> Vec<(String, String)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("commands").join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        // `tauri::command(async)` on a sync fn counts as sync: Tauri polls
        // the body inside a future on an async-runtime worker, so blocking
        // work there pins that worker instead of the window.
        if !line.trim_start().starts_with("#[cfg_attr(feature = \"desktop\", tauri::command") {
            continue;
        }
        let Some(at) = (i + 1..lines.len()).find(|&j| lines[j].contains("fn ")) else { continue };
        let sig = lines[at].trim();
        if sig.contains("async fn ") {
            continue;
        }
        let name = sig.split("fn ").nth(1).unwrap_or("");
        let name: String = name.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        let end = (at..lines.len()).find(|&j| lines[j] == "}").unwrap_or(lines.len() - 1);
        out.push((name, lines[at..=end].join("\n")));
    }
    out
}

/// Every `src/commands/*.rs` file name.
fn command_files() -> Vec<String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("commands");
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .filter(|n| n.ends_with(".rs"))
        .collect();
    files.sort();
    files
}

/// Sync commands outside the B1 files whose body may name `remove_dir_all`,
/// `.output(` or `ollama_http`: `(file, fn, why)`. Empty today — every one
/// of those is on a worker (`async` over a `*_blocking` body).
const SYNC_BODY_ALLOWED: &[(&str, &str, &str)] = &[];

/// B1's guard, over every `commands/*.rs` (code screen 2026-10-25, G):
/// a sync command runs on the window's thread (or pins an async worker), so
/// none may walk a tree, spawn a process or ask Ollama.
///  - In the files B1 moved off the window's thread (`projects.rs`, `fs.rs`,
///    `git.rs`, `git_fork.rs`) a new sync command is either `async` over a
///    `*_blocking` body (`app_core::rt::try_blocking`) or, when it touches
///    only the state dir, a row in [`SYNC_COMMANDS_ALLOWED`].
///  - Anywhere else a sync command's body must not name `remove_dir_all`,
///    `.output(` or `ollama_http` ([`SYNC_BODY_ALLOWED`] for a reasoned
///    exception). Work a body hands to a helper is not seen: review it.
#[test]
fn sync_commands_keep_disk_and_process_work_off_the_windows_thread() {
    const B1_FILES: [&str; 4] = ["projects.rs", "fs.rs", "git.rs", "git_fork.rs"];
    let mut unexpected = Vec::new();
    let mut seen = Vec::new();
    let mut blocking = Vec::new();
    let mut body_used = Vec::new();
    for file in command_files() {
        for (name, body) in sync_commands_in(&file) {
            if B1_FILES.contains(&file.as_str()) {
                match SYNC_COMMANDS_ALLOWED.iter().find(|(f, n)| *f == file && *n == name) {
                    Some(row) => seen.push(*row),
                    None => unexpected.push(format!("{file}: {name}")),
                }
                continue;
            }
            let Some(token) = ["remove_dir_all", ".output(", "ollama_http"].into_iter().find(|t| body.contains(t)) else {
                continue;
            };
            match SYNC_BODY_ALLOWED.iter().find(|(f, n, _)| *f == file && *n == name) {
                Some(row) => body_used.push(*row),
                None => blocking.push(format!("{file}: {name} ({token})")),
            }
        }
    }
    assert!(unexpected.is_empty(), "sync commands that should be async over a *_blocking body: {unexpected:?}");
    assert!(blocking.is_empty(), "sync commands doing tree, process or Ollama work on the window's thread — make them async over a *_blocking body, or allow one in SYNC_BODY_ALLOWED with its reason: {blocking:?}");
    let stale: Vec<_> = SYNC_COMMANDS_ALLOWED.iter().filter(|row| !seen.contains(row)).collect();
    assert!(stale.is_empty(), "SYNC_COMMANDS_ALLOWED rows that match no sync command any more: {stale:?}");
    let stale: Vec<_> = SYNC_BODY_ALLOWED.iter().filter(|row| !body_used.contains(row)).collect();
    assert!(stale.is_empty(), "SYNC_BODY_ALLOWED rows that match no sync command any more: {stale:?}");
}

/// `tauri::command(async)` on a sync fn runs the body inside a future on an
/// async-runtime worker, not on the blocking pool: blocking work there pins
/// that worker. A command that blocks is `async` over a `*_blocking` body.
#[test]
fn no_command_marks_a_sync_fn_async() {
    let mut found = Vec::new();
    for file in command_files() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("commands").join(&file);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !line.trim_start().starts_with("#[cfg_attr(feature = \"desktop\", tauri::command(async")
                && !line.trim_start().starts_with("#[tauri::command(async")
            {
                continue;
            }
            if let Some(sig) = lines[i + 1..].iter().find(|l| l.contains("fn ")) {
                if !sig.contains("async fn ") {
                    found.push(format!("{file}: {}", sig.trim()));
                }
            }
        }
    }
    assert!(found.is_empty(), "tauri::command(async) on a sync fn — make it async over a *_blocking body: {found:?}");
}

#[test]
fn the_sync_command_scan_sees_attribute_bodies_and_skips_async() {
    // The scan reads real files; pin that it finds the known sync and async shapes.
    let projects = sync_commands_in("projects.rs");
    assert!(projects.iter().any(|(n, body)| n == "get_projects" && body.ends_with('}')));
    assert!(!projects.iter().any(|(n, _)| n == "project_folder_exists"), "an async command is not a sync one");
    assert!(command_files().iter().any(|f| f == "ollama.rs"));
}
