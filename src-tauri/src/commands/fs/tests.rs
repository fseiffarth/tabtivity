use super::*;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::test_util::init_repo;
use std::path::PathBuf;

#[test]
fn list_dir_all_splits_folders_from_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    std::fs::write(dir.path().join("b.txt"), b"xy").unwrap();
    std::fs::write(dir.path().join("A.md"), b"x").unwrap();
    let listing = list_local_dir(&dir.path().to_string_lossy(), false).unwrap();
    assert_eq!(listing.dirs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["sub"]);
    assert_eq!(listing.files.iter().map(|f| (f.name.as_str(), f.size)).collect::<Vec<_>>(), [("A.md", 1), ("b.txt", 2)]);
    assert!(listing.parent.is_some());
    assert!(list_local_dir("/definitely/not/here", false).is_err());
}

/// The folder picker's half (`list_dirs`) reads the same body with
/// `dirs_only`: the same folders, no files.
#[test]
fn list_local_dir_dirs_only_drops_the_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("Zed")).unwrap();
    std::fs::create_dir(dir.path().join("alpha")).unwrap();
    std::fs::write(dir.path().join("b.txt"), b"xy").unwrap();
    let listing = list_local_dir(&dir.path().to_string_lossy(), true).unwrap();
    assert_eq!(listing.dirs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["alpha", "Zed"]);
    assert!(listing.files.is_empty());
}

fn ignore_rule(dir: &Path, rel: &str) -> Result<(), String> {
    update_gitignore_rule_blocking(dir.to_string_lossy().into_owned(), rel.into(), false, "ignore".into())
}

#[test]
fn update_gitignore_rule_edits_the_projects_own_file() {
    let dir = tempfile::tempdir().unwrap();
    ignore_rule(dir.path(), "a.log").unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(), "/a.log\n");
    ignore_rule(dir.path(), "b.log").unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(), "/a.log\n\n/b.log\n");
}

/// A committed `.gitignore -> ~/.bashrc` must not get a rule appended, and
/// a dangling one must not create its target.
#[cfg(unix)]
#[test]
fn update_gitignore_rule_never_writes_through_a_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("p");
    std::fs::create_dir(&project).unwrap();
    let victim = dir.path().join("victim");
    std::fs::write(&victim, "precious\n").unwrap();
    std::os::unix::fs::symlink(&victim, project.join(".gitignore")).unwrap();
    assert!(ignore_rule(&project, "a.log").is_err());
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious\n");

    std::fs::remove_file(project.join(".gitignore")).unwrap();
    let elsewhere = dir.path().join("elsewhere");
    std::os::unix::fs::symlink(&elsewhere, project.join(".gitignore")).unwrap();
    assert!(ignore_rule(&project, "a.log").is_err());
    assert!(!elsewhere.exists());
}

/// The command runs on workers now, so two rule edits can overlap; each
/// reads, edits and writes the whole file, and without the edit lock the
/// later write dropped the earlier one's rule.
#[test]
fn concurrent_gitignore_rule_edits_keep_every_rule() {
    let dir = tempfile::tempdir().unwrap();
    let names: Vec<String> = (0..16).map(|i| format!("f{i}.log")).collect();
    let start = std::sync::Arc::new(std::sync::Barrier::new(names.len()));
    let workers: Vec<_> = names
        .iter()
        .cloned()
        .map(|name| {
            let (root, start) = (dir.path().to_path_buf(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                ignore_rule(&root, &name)
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap().unwrap();
    }
    let text = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
    for name in &names {
        assert!(text.lines().any(|l| l == format!("/{name}")), "lost /{name}:\n{text}");
    }
}

#[cfg(unix)]
#[test]
fn update_gitignore_rule_refuses_a_fifo_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    crate::services::home_io::mkfifo(&dir.path().join(".gitignore"));
    let project = dir.path().to_path_buf();
    assert!(crate::services::home_io::within_deadline(move || ignore_rule(&project, "a.log")).is_err());
}

// ── The raw-body write's two decoders ──────────────────────────────────
// `write_file_bytes` takes its path from a header (a header is ASCII; a project
// path is not) and, on Tauri's postMessage fallback, its content as JSON. Both
// decode a value the *renderer* wrote, so both are worth pinning down.

#[test]
fn percent_decode_reads_what_encode_uri_component_writes() {
    assert_eq!(
        percent_decode(concat!("/home/f/", crate::app_slug!(), "/projects/thesis/thesis.pdf")).as_deref(),
        Some(concat!("/home/f/", crate::app_slug!(), "/projects/thesis/thesis.pdf"))
    );
    // Non-ASCII: `encodeURIComponent("Übung")` is the UTF-8 bytes, percent-escaped.
    assert_eq!(
        percent_decode("%C3%9Cbung/a%20b.pdf").as_deref(),
        Some("Übung/a b.pdf")
    );
    // A `+` is a literal here — encodeURIComponent never writes one for a space.
    assert_eq!(percent_decode("a+b").as_deref(), Some("a+b"));
}

#[test]
fn percent_decode_refuses_a_malformed_escape() {
    assert_eq!(percent_decode("%zz"), None);
    assert_eq!(percent_decode("trailing%"), None);
    // Valid escapes that are not valid UTF-8 are refused rather than lossily
    // replaced: a path is being reconstructed, not text being displayed.
    assert_eq!(percent_decode("%FF%FE"), None);
}

#[test]
fn json_byte_array_accepts_only_bytes() {
    assert_eq!(
        json_byte_array(&serde_json::json!([37, 80, 68, 70])),
        Some(vec![37, 80, 68, 70])
    );
    assert_eq!(json_byte_array(&serde_json::json!([])), Some(vec![]));
    assert_eq!(json_byte_array(&serde_json::json!([256])), None);
    assert_eq!(json_byte_array(&serde_json::json!([-1])), None);
    assert_eq!(
        json_byte_array(&serde_json::json!({ "content": [1] })),
        None
    );
    assert_eq!(json_byte_array(&serde_json::json!("nope")), None);
}

// ── join_remote_dir / remote_file_entry ────────────────────────────────

#[test]
fn join_remote_dir_root_is_remote_path() {
    assert_eq!(join_remote_dir("/srv/project", ""), "/srv/project");
    // Trailing slash on the root is trimmed.
    assert_eq!(join_remote_dir("/srv/project/", ""), "/srv/project");
}

#[test]
fn join_remote_dir_appends_relative() {
    assert_eq!(
        join_remote_dir("/srv/project", "sub/dir"),
        "/srv/project/sub/dir"
    );
    // A leading slash on the rel is normalized away (no doubled slash).
    assert_eq!(join_remote_dir("/srv/project", "/sub"), "/srv/project/sub");
    assert_eq!(join_remote_dir("/srv/project/", "sub"), "/srv/project/sub");
}

#[test]
fn join_remote_dir_handles_filesystem_root() {
    // remote_path "/" trims to empty; results stay single-leading-slash.
    assert_eq!(join_remote_dir("/", ""), "/");
    assert_eq!(join_remote_dir("/", "etc"), "/etc");
}

#[test]
fn remote_file_entry_maps_path_and_mime() {
    let entry = crate::services::sftp::Entry {
        name: "notes.txt".to_string(),
        is_dir: false,
        size: 42,
        modified_secs: Some(1000),
    };
    let fe = remote_file_entry("/srv/project/src", entry);
    assert_eq!(fe.path, "/srv/project/src/notes.txt");
    assert_eq!(fe.extension.as_deref(), Some(".txt"));
    assert_eq!(fe.mime.as_deref(), Some("text/plain"));
    assert_eq!(fe.size, 42);
    assert_eq!(fe.modified_secs, Some(1000));
    assert_eq!(fe.created_secs, None);
    assert!(!fe.is_dir);
}

#[test]
fn remote_file_entry_dir_has_no_extension() {
    let entry = crate::services::sftp::Entry {
        name: "src".to_string(),
        is_dir: true,
        size: 0,
        modified_secs: None,
    };
    let fe = remote_file_entry("/srv/project", entry);
    assert_eq!(fe.path, "/srv/project/src");
    assert_eq!(fe.extension, None);
    assert_eq!(fe.mime, None);
    assert!(fe.is_dir);
}

// ── resolve_text_paths ─────────────────────────────────────────────────

#[test]
fn text_paths_resolve_under_the_bases_only() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(project.join("docs")).unwrap();
    fs::write(project.join("docs/plan.md"), "x").unwrap();
    fs::write(tmp.path().join("secret.txt"), "x").unwrap();
    let base = project.to_string_lossy().to_string();
    // Per component: Windows keeps a joined `/`, the resolved path has `\`.
    let abs_inside = project.join("docs").join("plan.md").to_string_lossy().to_string();
    let abs_outside = tmp.path().join("secret.txt").to_string_lossy().to_string();
    let got = resolve_text_paths_blocking(
        vec![base],
        vec![
            "docs/plan.md".into(),
            "./docs/../docs/plan.md".into(),
            "docs".into(),
            abs_inside.clone(),
            "missing.md".into(),
            "../secret.txt".into(),
            abs_outside,
        ],
    );
    let found = |i: usize| got[i].as_ref().map(|e| (e.path.clone(), e.is_dir));
    assert_eq!(found(0), Some((abs_inside.clone(), false)));
    assert_eq!(found(1), Some((abs_inside.clone(), false)));
    assert_eq!(found(2).map(|(_, dir)| dir), Some(true));
    assert_eq!(found(3), Some((abs_inside, false)));
    assert_eq!(found(4), None);
    assert_eq!(found(5), None);
    assert_eq!(found(6), None);
}

#[test]
fn text_paths_try_each_base_in_order() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    let sub = project.join("crate");
    fs::create_dir_all(sub.join("src")).unwrap();
    fs::write(sub.join("src/lib.rs"), "x").unwrap();
    fs::write(project.join("README.md"), "x").unwrap();
    let got = resolve_text_paths_blocking(
        vec![sub.to_string_lossy().into(), project.to_string_lossy().into()],
        vec!["src/lib.rs".into(), "README.md".into()],
    );
    assert_eq!(got[0].as_ref().map(|e| e.name.as_str()), Some("lib.rs"));
    assert_eq!(got[1].as_ref().map(|e| e.name.as_str()), Some("README.md"));
}

#[cfg(unix)]
#[test]
fn text_paths_refuse_a_symlink_out_of_the_base() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(tmp.path().join("secret.txt"), "x").unwrap();
    std::os::unix::fs::symlink(tmp.path().join("secret.txt"), project.join("link.txt")).unwrap();
    let got = resolve_text_paths_blocking(vec![project.to_string_lossy().into()], vec!["link.txt".into()]);
    assert!(got[0].is_none());
}

#[test]
fn text_paths_skip_the_project_state_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join(crate::brand::PROJECT_DIR);
    fs::create_dir_all(&state).unwrap();
    fs::write(state.join("project.json"), "{}").unwrap();
    let rel = format!("{}/project.json", crate::brand::PROJECT_DIR);
    let got = resolve_text_paths_blocking(vec![tmp.path().to_string_lossy().into()], vec![rel]);
    assert!(got[0].is_none());
}

#[test]
fn normalize_lexical_folds_dots() {
    assert_eq!(normalize_lexical(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
    assert_eq!(normalize_lexical(Path::new("/..")), PathBuf::from("/"));
    assert_eq!(normalize_lexical(Path::new("../a")), PathBuf::from("../a"));
}

// ── enforce_confinement ────────────────────────────────────────────────

#[test]
fn enforce_confinement_allows_exact_root() {
    let root = PathBuf::from("/tmp/project");
    assert!(enforce_confinement(&root, &root).is_ok());
}

#[test]
fn enforce_confinement_allows_child() {
    let root = PathBuf::from("/tmp/project");
    let child = PathBuf::from("/tmp/project/src/main.rs");
    assert!(enforce_confinement(&root, &child).is_ok());
}

#[test]
fn enforce_confinement_blocks_parent_escape() {
    let root = PathBuf::from("/tmp/project");
    let parent = PathBuf::from("/tmp");
    assert!(enforce_confinement(&root, &parent).is_err());
}

#[test]
fn enforce_confinement_blocks_sibling() {
    let root = PathBuf::from("/tmp/project");
    let sibling = PathBuf::from("/tmp/other");
    assert!(enforce_confinement(&root, &sibling).is_err());
}

#[test]
fn enforce_confinement_blocks_absolute_escape() {
    let root = PathBuf::from("/tmp/project");
    let escape = PathBuf::from("/etc/passwd");
    assert!(enforce_confinement(&root, &escape).is_err());
}

#[test]
fn enforce_confinement_error_message_mentions_root() {
    let root = PathBuf::from("/tmp/project");
    let escape = PathBuf::from("/etc/passwd");
    let err = enforce_confinement(&root, &escape).unwrap_err();
    assert!(
        err.contains("/tmp/project"),
        "error must mention root: {err}"
    );
}

// ── dir_size_breakdown ──────────────────────────────────────────────────

fn git_available() -> bool {
    crate::paths::command_no_window("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[test]
fn dir_size_breakdown_splits_ignored_from_tracked() {
    if !git_available() {
        eprintln!("git not on PATH — skipping dir_size_breakdown_splits_ignored_from_tracked");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    init_repo(dir);

    std::fs::write(dir.join(".gitignore"), "whole/\n").unwrap();
    std::fs::create_dir(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/main.rs"), "12345").unwrap(); // 5 bytes, tracked/untracked
    std::fs::create_dir_all(dir.join("src/whole/sub")).unwrap();
    std::fs::write(dir.join("src/whole/a.txt"), "1234567890").unwrap(); // 10 bytes, ignored
    std::fs::write(dir.join("src/whole/sub/b.txt"), "12345678901234567890").unwrap(); // 20 bytes, ignored

    let breakdown =
        dir_size_breakdown_local(&dir.to_string_lossy(), "src", &[]).expect("breakdown");
    assert_eq!(breakdown.total, 35);
    assert_eq!(breakdown.ignored, 30);
}

#[test]
fn dir_size_breakdown_no_git_yields_zero_ignored() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(dir.join("a.txt"), "hello").unwrap();

    let breakdown =
        dir_size_breakdown_local(&dir.to_string_lossy(), "", &[]).expect("breakdown");
    assert_eq!(breakdown.total, 5);
    assert_eq!(breakdown.ignored, 0);
}

// ── copy_path / move_path ──────────────────────────────────────────────

/// A rename that fails for a reason other than a cross-device move must be
/// reported as it is. The old fallback copied the file first and only then
/// failed to remove the source, leaving a duplicate behind an error.
#[cfg(unix)]
#[test]
fn move_path_surfaces_a_non_cross_device_rename_error() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().to_string();
    let locked = tmp.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("a.txt"), "hello").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

    let result =
        move_path_blocking(dir.clone(), "locked/a.txt".into(), dir.clone(), "b.txt".into());
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(result.is_err(), "EACCES must surface: {result:?}");
    assert!(!tmp.path().join("b.txt").exists(), "no copy was made");
    assert!(locked.join("a.txt").exists(), "the source is untouched");
}

#[test]
fn copy_path_duplicates_a_file() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().to_string();
    std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();

    copy_path_blocking(dir.clone(), "a.txt".into(), dir.clone(), "b.txt".into()).unwrap();

    assert_eq!(
        std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
        "hello"
    );
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("b.txt")).unwrap(),
        "hello"
    );
}

#[test]
fn copy_path_recurses_into_directories() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().to_string();
    std::fs::create_dir(tmp.path().join("src")).unwrap();
    std::fs::write(tmp.path().join("src/main.rs"), "fn main() {}").unwrap();

    copy_path_blocking(dir.clone(), "src".into(), dir.clone(), "src2".into()).unwrap();

    assert_eq!(
        std::fs::read_to_string(tmp.path().join("src2/main.rs")).unwrap(),
        "fn main() {}"
    );
    assert!(tmp.path().join("src/main.rs").exists());
}

#[cfg(unix)]
#[test]
fn copy_path_keeps_a_planted_link_a_link_and_reports_a_pipe() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().to_string();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
    std::fs::create_dir(tmp.path().join("src")).unwrap();
    std::os::unix::fs::symlink(outside.path(), tmp.path().join("src/planted")).unwrap();
    let fifo = std::ffi::CString::new(tmp.path().join("src/pipe").to_str().unwrap()).unwrap();
    // SAFETY: a valid NUL-terminated path.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

    let report = copy_path_blocking(dir.clone(), "src".into(), dir.clone(), "src2".into()).unwrap();

    assert_eq!(report.skipped, vec!["pipe".to_string()]);
    let copied = tmp.path().join("src2/planted");
    assert!(std::fs::symlink_metadata(&copied).unwrap().file_type().is_symlink());
    assert!(!tmp.path().join("src2/pipe").exists());
}

#[test]
fn copy_path_refuses_existing_destination() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().to_string();
    std::fs::write(tmp.path().join("a.txt"), "1").unwrap();
    std::fs::write(tmp.path().join("b.txt"), "2").unwrap();

    let err = copy_path_blocking(dir.clone(), "a.txt".into(), dir.clone(), "b.txt".into()).unwrap_err();
    assert!(err.contains("already exists"), "{err}");
    // The pre-existing destination is untouched.
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("b.txt")).unwrap(),
        "2"
    );
}

// ── extract_archive ────────────────────────────────────────────────────

/// Write a minimal .zip (stored, no compression) at `path` from
/// (entry-name, contents) pairs. An entry name ending in `/` is a directory.
fn write_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, data) in entries {
        if name.ends_with('/') {
            zip.add_directory(*name, opts).unwrap();
        } else {
            use std::io::Write;
            zip.start_file(*name, opts).unwrap();
            zip.write_all(data).unwrap();
        }
    }
    zip.finish().unwrap();
}

#[test]
fn extract_archive_unpacks_into_named_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().to_string();
    write_test_zip(
        &tmp.path().join("bundle.zip"),
        &[("a.txt", b"hello"), ("sub/", b""), ("sub/b.txt", b"world")],
    );

    let folder = extract_archive_blocking(dir.clone(), "bundle.zip".into()).unwrap();

    assert_eq!(folder, "bundle");
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("bundle/a.txt")).unwrap(),
        "hello"
    );
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("bundle/sub/b.txt")).unwrap(),
        "world"
    );
}

#[test]
fn extract_archive_dedupes_existing_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().to_string();
    std::fs::create_dir(tmp.path().join("bundle")).unwrap();
    write_test_zip(&tmp.path().join("bundle.zip"), &[("a.txt", b"x")]);

    let folder = extract_archive_blocking(dir.clone(), "bundle.zip".into()).unwrap();

    assert_eq!(folder, "bundle (1)");
    assert!(tmp.path().join("bundle (1)/a.txt").exists());
}

#[test]
fn extract_archive_ignores_zip_slip_entries() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().to_string();
    // A crafted entry trying to escape the destination via `..`.
    write_test_zip(
        &tmp.path().join("evil.zip"),
        &[("../escaped.txt", b"pwned"), ("safe.txt", b"ok")],
    );

    extract_archive_blocking(dir.clone(), "evil.zip".into()).unwrap();

    // The traversal entry is dropped; the sibling escape file never appears.
    assert!(!tmp.path().join("escaped.txt").exists());
    assert!(tmp.path().join("evil/safe.txt").exists());
}

#[test]
fn copy_path_refuses_directory_into_itself() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().to_string();
    std::fs::create_dir(tmp.path().join("src")).unwrap();

    let err =
        copy_path_blocking(dir.clone(), "src".into(), dir.clone(), "src/inner".into()).unwrap_err();
    assert!(err.contains("into itself"), "{err}");
}

#[test]
fn move_path_relocates_a_file() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().to_string();
    std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();

    move_path_blocking(dir.clone(), "a.txt".into(), dir.clone(), "sub/b.txt".into()).unwrap();

    assert!(!tmp.path().join("a.txt").exists());
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("sub/b.txt")).unwrap(),
        "hello"
    );
}

/// Two DIFFERENT roots — the box view's cross-project drag-and-drop (and a
/// side-panel → other project's Files tab drop) depend on this shape: the
/// frontend routes the drop to `dest_project_dir = <target tree's root>`.
/// Locks that a folder moves wholesale into the other root and leaves
/// nothing behind in the source project.
#[test]
fn move_path_moves_a_folder_between_roots() {
    let src = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    std::fs::create_dir(src.path().join("data")).unwrap();
    std::fs::write(src.path().join("data/x.txt"), "payload").unwrap();
    std::fs::create_dir(dest.path().join("incoming")).unwrap();

    move_path_blocking(
        src.path().to_string_lossy().to_string(),
        "data".into(),
        dest.path().to_string_lossy().to_string(),
        "incoming/data".into(),
    )
    .unwrap();

    assert!(!src.path().join("data").exists());
    assert_eq!(
        std::fs::read_to_string(dest.path().join("incoming/data/x.txt")).unwrap(),
        "payload"
    );
}

// ── import_external_file ───────────────────────────────────────────────

#[test]
fn an_inferred_drop_path_must_match_the_dropped_files_size() {
    let ext = tempfile::tempdir().unwrap();
    let file = ext.path().join("b.png");
    std::fs::write(&file, "img").unwrap();
    let path = file.to_string_lossy().to_string();
    assert!(check_inferred_drop(&path, 3).is_ok());
    assert!(check_inferred_drop(&path, 4).is_err());
    assert!(check_inferred_drop(&ext.path().to_string_lossy(), 0).is_err());
    assert!(check_inferred_drop(&ext.path().join("c.png").to_string_lossy(), 3).is_err());
}

#[test]
fn import_external_file_copies_into_subfolder() {
    let ext = tempfile::tempdir().unwrap();
    std::fs::write(ext.path().join("photo.png"), "img").unwrap();
    let proj = tempfile::tempdir().unwrap();
    std::fs::create_dir(proj.path().join("assets")).unwrap();

    let rel = import_external_file_blocking(
        proj.path().to_string_lossy().to_string(),
        ext.path().join("photo.png").to_string_lossy().to_string(),
        "assets".into(),
        false,
        None,
    )
    .unwrap();

    assert_eq!(rel, "assets/photo.png");
    assert_eq!(
        std::fs::read_to_string(proj.path().join("assets/photo.png")).unwrap(),
        "img"
    );
    // Source is left in place (copy, not move).
    assert!(ext.path().join("photo.png").exists());
}

#[test]
fn import_external_file_renames_on_collision() {
    let ext = tempfile::tempdir().unwrap();
    std::fs::write(ext.path().join("a.txt"), "new").unwrap();
    let proj = tempfile::tempdir().unwrap();
    std::fs::write(proj.path().join("a.txt"), "old").unwrap();

    let rel = import_external_file_blocking(
        proj.path().to_string_lossy().to_string(),
        ext.path().join("a.txt").to_string_lossy().to_string(),
        "".into(),
        false,
        None,
    )
    .unwrap();

    assert_eq!(rel, "a (1).txt");
    // The pre-existing file is untouched; the import lands beside it.
    assert_eq!(
        std::fs::read_to_string(proj.path().join("a.txt")).unwrap(),
        "old"
    );
    assert_eq!(
        std::fs::read_to_string(proj.path().join("a (1).txt")).unwrap(),
        "new"
    );
}

#[test]
fn import_external_file_replace_overwrites() {
    let ext = tempfile::tempdir().unwrap();
    std::fs::write(ext.path().join("a.txt"), "new").unwrap();
    let proj = tempfile::tempdir().unwrap();
    std::fs::write(proj.path().join("a.txt"), "old").unwrap();

    let rel = import_external_file_blocking(
        proj.path().to_string_lossy().to_string(),
        ext.path().join("a.txt").to_string_lossy().to_string(),
        "".into(),
        true,
        None,
    )
    .unwrap();

    // Same name, content overwritten — no " (1)" copy created.
    assert_eq!(rel, "a.txt");
    assert_eq!(
        std::fs::read_to_string(proj.path().join("a.txt")).unwrap(),
        "new"
    );
    assert!(!proj.path().join("a (1).txt").exists());
}

#[test]
fn import_external_file_honours_a_chosen_name() {
    let ext = tempfile::tempdir().unwrap();
    std::fs::write(ext.path().join("a.txt"), "new").unwrap();
    let proj = tempfile::tempdir().unwrap();
    std::fs::write(proj.path().join("a.txt"), "old").unwrap();

    // The collision prompt's "keep both, as …": the second copy is named by
    // the user rather than suffixed.
    let rel = import_external_file_blocking(
        proj.path().to_string_lossy().to_string(),
        ext.path().join("a.txt").to_string_lossy().to_string(),
        "".into(),
        false,
        Some("  a-draft.txt  ".into()),
    )
    .unwrap();

    assert_eq!(rel, "a-draft.txt");
    assert_eq!(
        std::fs::read_to_string(proj.path().join("a.txt")).unwrap(),
        "old"
    );
    assert_eq!(
        std::fs::read_to_string(proj.path().join("a-draft.txt")).unwrap(),
        "new"
    );
}

#[test]
fn chosen_name_that_also_collides_is_suffixed_not_overwritten() {
    let ext = tempfile::tempdir().unwrap();
    std::fs::write(ext.path().join("a.txt"), "new").unwrap();
    let proj = tempfile::tempdir().unwrap();
    std::fs::write(proj.path().join("a.txt"), "old").unwrap();
    std::fs::write(proj.path().join("taken.txt"), "mine").unwrap();

    // Without `replace`, a name is a request and never an overwrite — the
    // prompt's suggestion can be stale by the time the copy runs.
    let rel = import_external_file_blocking(
        proj.path().to_string_lossy().to_string(),
        ext.path().join("a.txt").to_string_lossy().to_string(),
        "".into(),
        false,
        Some("taken.txt".into()),
    )
    .unwrap();

    assert_eq!(rel, "taken (1).txt");
    assert_eq!(
        std::fs::read_to_string(proj.path().join("taken.txt")).unwrap(),
        "mine"
    );
}

#[test]
fn import_external_file_rejects_a_chosen_name_with_a_separator() {
    let ext = tempfile::tempdir().unwrap();
    std::fs::write(ext.path().join("a.txt"), "x").unwrap();
    let proj = tempfile::tempdir().unwrap();
    std::fs::create_dir(proj.path().join("sub")).unwrap();

    for name in ["../escape.txt", "sub/a.txt", "..", "."] {
        let err = import_external_file_blocking(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("a.txt").to_string_lossy().to_string(),
            "".into(),
            false,
            Some(name.into()),
        )
        .unwrap_err();
        assert!(err.contains("invalid file name"), "{name}: {err}");
    }
    // Nothing landed anywhere.
    assert!(!proj.path().join("sub/a.txt").exists());
}

#[test]
fn blank_chosen_name_falls_back_to_the_source_name() {
    let ext = tempfile::tempdir().unwrap();
    std::fs::write(ext.path().join("a.txt"), "x").unwrap();
    let proj = tempfile::tempdir().unwrap();

    let rel = import_external_file_blocking(
        proj.path().to_string_lossy().to_string(),
        ext.path().join("a.txt").to_string_lossy().to_string(),
        "".into(),
        false,
        Some("   ".into()),
    )
    .unwrap();
    assert_eq!(rel, "a.txt");
}

#[test]
fn project_path_exists_reports_presence() {
    let proj = tempfile::tempdir().unwrap();
    std::fs::write(proj.path().join("here.txt"), "x").unwrap();
    let dir = proj.path().to_string_lossy().to_string();
    assert!(project_path_exists_blocking(dir.clone(), "here.txt".into()).unwrap());
    assert!(!project_path_exists_blocking(dir, "missing.txt".into()).unwrap());
}

#[test]
fn import_external_file_recurses_into_directories() {
    let ext = tempfile::tempdir().unwrap();
    std::fs::create_dir(ext.path().join("pkg")).unwrap();
    std::fs::write(ext.path().join("pkg/mod.rs"), "fn x() {}").unwrap();
    let proj = tempfile::tempdir().unwrap();

    let rel = import_external_file_blocking(
        proj.path().to_string_lossy().to_string(),
        ext.path().join("pkg").to_string_lossy().to_string(),
        "".into(),
        false,
        None,
    )
    .unwrap();

    assert_eq!(rel, "pkg");
    assert_eq!(
        std::fs::read_to_string(proj.path().join("pkg/mod.rs")).unwrap(),
        "fn x() {}"
    );
}

#[test]
fn import_external_file_rejects_escaping_dest() {
    let ext = tempfile::tempdir().unwrap();
    std::fs::write(ext.path().join("a.txt"), "x").unwrap();
    let proj = tempfile::tempdir().unwrap();

    let err = import_external_file_blocking(
        proj.path().to_string_lossy().to_string(),
        ext.path().join("a.txt").to_string_lossy().to_string(),
        "../escape".into(),
        false,
        None,
    )
    .unwrap_err();
    assert!(err.contains("invalid path component"), "{err}");
}

// ── list_project_endings ───────────────────────────────────────────────

#[test]
#[cfg(unix)]
fn list_project_endings_does_not_follow_self_symlink() {
    // A symlink pointing back at the project root (`repo -> .`) must not
    // cause the recursive ending scan to loop. Before the fix this hung
    // until the OS path-length limit, walking the tree hundreds of times.
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("main.rs"), "fn main() {}").unwrap();
    std::fs::create_dir(tmp.path().join("src")).unwrap();
    std::fs::write(tmp.path().join("src/lib.py"), "x = 1").unwrap();
    std::os::unix::fs::symlink(tmp.path(), tmp.path().join("repo")).unwrap();

    let endings = list_project_endings_blocking(tmp.path().to_string_lossy().to_string()).unwrap();

    // Real file endings are collected; the self-symlink is never entered.
    assert!(endings.contains(&".rs".to_string()));
    assert!(endings.contains(&".py".to_string()));
}

// ── write_project_file / rename_path ────────────────────────────────────

#[test]
fn write_project_file_creates_nested_file_inside_project() {
    let tmp = tempfile::tempdir().unwrap();
    write_project_file_local(
        &tmp.path().to_string_lossy(),
        concat!(".", crate::app_slug!(), "/scaffold-fill-claude.md"),
        "fill AGENTS.md",
    )
    .unwrap();

    let content =
        std::fs::read_to_string(tmp.path().join(concat!(".", crate::app_slug!(), "/scaffold-fill-claude.md"))).unwrap();
    assert_eq!(content, "fill AGENTS.md");
}

#[test]
fn rename_path_renames_file_in_place() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("old.txt"), "content").unwrap();

    rename_path_local(&tmp.path().to_string_lossy(), "old.txt", "new.txt").unwrap();

    assert!(!tmp.path().join("old.txt").exists());
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("new.txt")).unwrap(),
        "content"
    );
}

#[test]
fn rename_path_rejects_non_bare_names() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("a.txt"), "x").unwrap();
    let dir = tmp.path().to_string_lossy().to_string();

    for bad in ["", " ", ".", "..", "sub/name", "..\\name", "a\0b"] {
        let err = rename_path_local(&dir, "a.txt", bad);
        assert!(err.is_err(), "name {bad:?} must be rejected");
    }
    assert!(tmp.path().join("a.txt").exists(), "file must be untouched");
}

#[test]
fn write_project_file_blocks_parent_escape() {
    let tmp = tempfile::tempdir().unwrap();
    let err =
        write_project_file_local(&tmp.path().to_string_lossy(), "../outside.md", "escape")
            .unwrap_err();

    assert!(
        err.contains("escapes project root"),
        "unexpected error: {err}"
    );
}

#[test]
fn write_project_file_blocks_escape_through_a_missing_folder() {
    // `missing/..` cannot be canonicalized, so the confinement check used
    // to compare the raw path — whose components still start with the root.
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let dir = root.to_string_lossy().to_string();

    assert!(write_project_file_local(&dir, "missing/../../outside.md", "x").is_err());
    assert!(write_project_file_bytes_local(&dir, "missing/../../outside.png", b"x").is_err());
    assert!(!outer.path().join("outside.md").exists());
    assert!(!outer.path().join("outside.png").exists());
}

#[cfg(unix)]
#[test]
fn write_project_file_never_follows_a_dangling_link_out_of_the_project() {
    // A link to a not-yet-existing file outside passes `exists()` as false,
    // so only its parent was canonicalized — and the write then created
    // the link's target outside the project.
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("project");
    std::fs::create_dir_all(root.join(concat!(crate::app_slug!(), "-screenshots"))).unwrap();
    let outside = outer.path().join("planted.desktop");
    std::os::unix::fs::symlink(&outside, root.join(concat!(crate::app_slug!(), "-screenshots/shot.png"))).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("notes.md")).unwrap();
    let dir = root.to_string_lossy().to_string();

    assert!(
        write_project_file_bytes_local(&dir, concat!(crate::app_slug!(), "-screenshots/shot.png"), b"png").is_err()
    );
    assert!(write_project_file_local(&dir, "notes.md", "text").is_err());
    assert!(!outside.exists(), "nothing may land outside the project");
}

#[cfg(unix)]
#[test]
fn write_project_file_still_saves_through_a_link_inside_the_project() {
    // A symlinked file whose target is inside the project is the user's own
    // layout; saving it must keep writing the target, as before.
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("real.md"), "old").unwrap();
    std::os::unix::fs::symlink(tmp.path().join("real.md"), tmp.path().join("alias.md"))
        .unwrap();

    write_project_file_local(&tmp.path().to_string_lossy(), "alias.md", "new").unwrap();

    assert_eq!(
        std::fs::read_to_string(tmp.path().join("real.md")).unwrap(),
        "new"
    );
}

// ── Remote path join / confinement (mount-free remote, Phase 3) ─────────

#[test]
fn remote_join_confined_joins_clean_rel() {
    assert_eq!(
        remote_join_confined("/srv/project", "src/main.rs").unwrap(),
        "/srv/project/src/main.rs"
    );
    // Empty rel resolves to the project root itself.
    assert_eq!(
        remote_join_confined("/srv/project", "").unwrap(),
        "/srv/project"
    );
}

#[test]
fn remote_join_confined_rejects_traversal() {
    assert!(remote_join_confined("/srv/project", "../escape").is_err());
    assert!(remote_join_confined("/srv/project", "a/../../b").is_err());
    // A leading slash (absolute rel) is a RootDir component → rejected, so a
    // caller can never pivot the join off the project root.
    assert!(remote_join_confined("/srv/project", "/etc/passwd").is_err());
}

#[test]
fn confine_remote_abs_allows_paths_under_root() {
    assert!(confine_remote_abs("/srv/project", "/srv/project").is_ok());
    assert!(confine_remote_abs("/srv/project", "/srv/project/src/main.rs").is_ok());
    // Trailing slash on the root is tolerated.
    assert!(confine_remote_abs("/srv/project/", "/srv/project/a").is_ok());
}

#[test]
fn confine_remote_abs_blocks_outside_and_prefix_sibling() {
    // A sibling that merely shares a string prefix must NOT be inside.
    assert!(confine_remote_abs("/srv/project", "/srv/project-evil/loot").is_err());
    // Unrelated absolute path.
    assert!(confine_remote_abs("/srv/project", "/etc/passwd").is_err());
    // Parent-dir traversal is refused even if it would resolve back inside.
    assert!(confine_remote_abs("/srv/project", "/srv/project/../secret").is_err());
}

// ── Absolute-path confinement (Security #1) ─────────────────────────────

fn entry(id: &str, status: &str, dir: &str) -> ProjectEntry {
    let mut extra = std::collections::HashMap::new();
    extra.insert("directory".to_string(), Value::String(dir.to_string()));
    ProjectEntry {
        id: id.to_string(),
        name: id.to_string(),
        status: status.to_string(),
        position: 0,
        local_file: format!("{dir}/project.json"),
        extra,
    }
}

/// The root terminal folder the tests thread through `compute_allowed_roots`.
const ROOT_WORK: &str = concat!("/home/u/", crate::app_slug!(), "/root");

#[test]
fn state_json_cache_follows_a_same_length_rewrite() {
    // A project switch rewrites projects.json in place with two statuses
    // swapped — same length, possibly the same mtime tick. The cache must
    // still hand back the new current project.
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("projects.json");
    let write = |x: &str, y: &str| {
        let list = vec![entry("x", x, "/home/u/code/projectx"), entry("y", y, "/home/u/code/projecty")];
        fs::write(&path, serde_json::to_string(&list).unwrap()).unwrap();
    };
    let cache: StateJsonCache<ProjectsList> = StateJsonCache::new();
    let current = |list: &ProjectsList| list.iter().find(|e| e.status == "current").unwrap().id.clone();

    write("current", "stopped");
    let first = cache.load(path.clone());
    assert_eq!(current(&first), "x");
    assert!(std::sync::Arc::ptr_eq(&first, &cache.load(path.clone())), "unchanged bytes reuse the parse");

    write("stopped", "current");
    assert_eq!(current(&cache.load(path.clone())), "y");

    fs::write(&path, "{ not json").unwrap();
    assert!(cache.load(path.clone()).is_empty(), "unparseable fails closed");
    fs::remove_file(&path).unwrap();
    assert!(cache.load(path).is_empty(), "absent fails closed");
}

#[test]
fn allowed_roots_scoped_to_named_project_not_current() {
    // The scope is the *viewer's own* project, not whichever is current. A
    // viewer owned by Y stays able to reach Y even while X is current — and
    // X's tree is NOT reachable through Y's scope (per-project isolation).
    let projects = vec![
        entry("x", "current", "/home/u/code/projectx"),
        entry("y", "inactive", "/home/u/code/projecty"),
    ];
    let roots = compute_allowed_roots(&projects, &Vec::new(), Some("y"), Path::new(ROOT_WORK));
    assert!(
        roots.iter().any(|r| r.ends_with("projecty")),
        "the scope project must be reachable even when it is not current"
    );
    assert!(
        !roots.iter().any(|r| r.ends_with("projectx")),
        "a project outside the scope must not be reachable"
    );
}

#[test]
fn allowed_roots_falls_back_to_current_when_no_scope() {
    // No scope id (root scope / legacy caller) → the current project.
    let projects = vec![
        entry("x", "current", "/home/u/code/projectx"),
        entry("y", "inactive", "/home/u/code/projecty"),
    ];
    let roots = compute_allowed_roots(&projects, &Vec::new(), None, Path::new(ROOT_WORK));
    assert!(roots.iter().any(|r| r.ends_with("projectx")));
    assert!(!roots.iter().any(|r| r.ends_with("projecty")));
}

#[test]
fn allowed_roots_includes_box_siblings_of_scope() {
    let projects = vec![
        entry("x", "current", "/home/u/code/projectx"),
        entry("y", "inactive", "/home/u/code/projecty"),
        entry("z", "inactive", "/home/u/code/projectz"),
    ];
    let boxes = vec![crate::schema::boxes::ProjectBox {
        id: "b1".to_string(),
        name: "grp".to_string(),
        member_ids: vec!["y".to_string(), "z".to_string()],
        ..Default::default()
    }];
    // Scope is Y; its box sibling Z is co-accessible, X (current) is not.
    let roots = compute_allowed_roots(&projects, &boxes, Some("y"), Path::new(ROOT_WORK));
    assert!(roots.iter().any(|r| r.ends_with("projecty")));
    assert!(roots.iter().any(|r| r.ends_with("projectz")));
    assert!(
        !roots.iter().any(|r| r.ends_with("projectx")),
        "a project outside the scope's box must not be reachable"
    );
}

#[test]
fn allowed_roots_includes_remote_mirror_override() {
    // A remote (SSH) project's browsable tree is its local mirror, relocated
    // outside the state dir via extra["mirror"]. That mirror must be reachable
    // or opening a mirrored local file fails confinement (#28k regression).
    let mut r = entry(
        "r",
        "current",
        concat!("/home/u/.local/share/", crate::app_slug!(), "/remote-projects/r"),
    );
    r.extra.insert(
        "mirror".to_string(),
        Value::String(concat!("/home/u/", crate::app_slug!(), "/projects-ssh/myproj").to_string()),
    );
    let roots = compute_allowed_roots(&vec![r], &Vec::new(), Some("r"), Path::new(ROOT_WORK));
    assert!(
        roots.iter().any(|p| p.ends_with("projects-ssh/myproj")),
        "the relocated local mirror must be an allowed root"
    );
}

#[test]
fn allowed_roots_empty_when_scope_unknown() {
    let projects = vec![entry("x", "current", "/home/u/code/projectx")];
    // An unknown scope id resolves to no project → fail closed.
    assert!(
        compute_allowed_roots(&projects, &Vec::new(), Some("nope"), Path::new(ROOT_WORK))
            .is_empty()
    );
}

fn mk_box(id: &str, members: &[&str], folder: Option<&str>) -> crate::schema::boxes::ProjectBox {
    crate::schema::boxes::ProjectBox {
        id: id.to_string(),
        name: id.to_string(),
        member_ids: members.iter().map(|s| s.to_string()).collect(),
        folder: folder.map(|s| s.to_string()),
        ..Default::default()
    }
}

#[test]
fn user_roots_cover_every_project_mirror_box_folder_and_base_and_nothing_else() {
    let tmp = tempfile::tempdir().unwrap();
    let at = |rel: &str| tmp.path().join(rel);
    let dir = |rel: &str| at(rel).to_string_lossy().into_owned();
    let mut y = entry("y", "inactive", &dir("code-y"));
    y.extra.insert("mirror".to_string(), Value::String(dir("mirror-y")));
    let projects = vec![entry("x", "current", &dir("code-x")), y, entry("rel", "inactive", "relative/dir")];
    let boxes = vec![mk_box("b1", &["x"], Some(dir("box-b1").as_str())), mk_box("b2", &[], None)];
    let roots = compute_user_roots(&projects, &boxes, &[at("work")], &[]);
    let held = |p: PathBuf| confine_abs_within(&p, &roots).is_ok();
    for inside in ["work/a", "code-x/src/main.rs", "code-y", "mirror-y/f", "box-b1/notes.md"] {
        assert!(held(at(inside)), "{inside} is a user's");
    }
    assert!(!held(at("elsewhere/f")), "a sibling of the roots is not");
    assert!(!held(tmp.path().to_path_buf()), "nor their parent");
    assert!(!held(at("code-x/../elsewhere")), "a `..` never passes");
    assert!(roots.iter().all(|r| r.is_absolute()), "a relative entry is never a root");
}

/// A registered folder the user turns into a link after registering it
/// (a branch checkout, a move) must not widen their roots to its target.
#[cfg(unix)]
#[test]
fn a_registered_root_swapped_for_a_link_never_widens_the_roots() {
    let tmp = tempfile::tempdir().unwrap();
    let at = |rel: &str| tmp.path().join(rel);
    let dir = |rel: &str| at(rel).to_string_lossy().into_owned();
    let outside = at("outside");
    fs::create_dir_all(outside.join("etc")).unwrap();
    fs::create_dir_all(at("work/c")).unwrap();
    fs::create_dir_all(at("work/d")).unwrap();
    // The registered folder itself became a link.
    std::os::unix::fs::symlink(&outside, at("work/c/p")).unwrap();
    // A folder above the registered one became a link (`d/x/etc` resolves
    // to `outside/etc`).
    std::os::unix::fs::symlink(&outside, at("work/d/x")).unwrap();
    // A project registered under a link in a registered project's tree.
    fs::create_dir_all(at("code-y/sub")).unwrap();
    std::os::unix::fs::symlink(&outside, at("code-y/sub/q")).unwrap();
    // A link above every root is the system's (`/home` → `/data/home`).
    fs::create_dir_all(at("data/z")).unwrap();
    std::os::unix::fs::symlink(at("data"), at("sys")).unwrap();
    // A folder that resolves to the home folder or above.
    fs::create_dir_all(at("home/u")).unwrap();
    let projects = vec![
        entry("p", "inactive", &dir("work/c/p")),
        entry("x", "inactive", &dir("work/d/x/etc")),
        entry("y", "inactive", &dir("code-y")),
        entry("q", "inactive", &dir("code-y/sub/q")),
        entry("z", "current", &dir("sys/z")),
        entry("h", "inactive", &dir("home")),
    ];
    let roots = compute_user_roots(&projects, &Vec::new(), &[at("work")], &[at("home/u")]);
    let held = |p: PathBuf| confine_abs_within(&p, &roots).is_ok();
    assert!(!held(outside.join("etc").join("passwd")), "a link planted in a root is not followed to a root: {roots:?}");
    assert!(!held(outside.clone()));
    assert!(held(at("sys/z/f")), "a link above every root is followed");
    assert!(held(at("data/z/f")));
    assert!(held(at("code-y/f")));
    assert!(!held(at("home/u/f")), "a root covering the home folder is dropped");
    assert!(held(at("work/c/other")), "the base root itself still holds");
}

/// A box folder holding a project that is really a link an agent planted:
/// the project's root is dropped (not rewritten to the link's target), the
/// box's own folder and an ordinary member stay, and a link above every
/// root, or spelled outside them, is followed.
#[cfg(unix)]
#[test]
fn a_registered_root_through_a_planted_link_is_dropped_everywhere() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let at = |rel: &str| base.join(rel);
    let secret = at("secret");
    fs::create_dir_all(&secret).unwrap();
    fs::create_dir_all(at("box/real")).unwrap();
    fs::create_dir_all(at("elsewhere/mine")).unwrap();
    symlink(&secret, at("box/planted")).unwrap();
    symlink(at("elsewhere/mine"), at("user-link")).unwrap();
    let dir = |rel: &str| at(rel).to_string_lossy().into_owned();
    let projects = vec![
        entry("real", "inactive", &dir("box/real")),
        entry("planted", "current", &dir("box/planted")),
        entry("viawards", "inactive", &dir("box/planted/inner")),
        entry("mine", "inactive", &dir("user-link")),
    ];
    let boxes = vec![mk_box("b", &["real", "planted", "viawards", "mine"], Some(&dir("box")))];

    let roots = compute_allowed_roots(&projects, &boxes, Some("box:b"), Path::new(ROOT_WORK));

    assert!(roots.contains(&at("box")), "{roots:?}");
    assert!(roots.contains(&at("box/real")), "{roots:?}");
    assert!(roots.contains(&at("elsewhere/mine")), "a link spelled outside every root is the user's: {roots:?}");
    assert!(!roots.iter().any(|r| r.starts_with(&secret) || r.ends_with("planted")), "dropped: {roots:?}");
    // The project scope sees the same rule through its box.
    let scoped = compute_allowed_roots(&projects, &boxes, Some("planted"), Path::new(ROOT_WORK));
    assert!(!scoped.iter().any(|r| r.starts_with(&secret)), "{scoped:?}");
    assert!(scoped.contains(&at("box/real")), "{scoped:?}");
}

#[cfg(unix)]
#[test]
fn the_phones_project_root_is_refused_through_a_planted_link() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let at = |rel: &str| base.join(rel);
    fs::create_dir_all(at("work")).unwrap();
    fs::create_dir_all(at("secret")).unwrap();
    symlink(at("secret"), at("work/planted")).unwrap();
    let dir = |rel: &str| at(rel).to_string_lossy().into_owned();
    let projects = vec![entry("w", "current", &dir("work")), entry("p", "inactive", &dir("work/planted"))];

    assert!(is_planted_root_in(&at("work/planted"), &projects, &Vec::new(), &[]));
    assert!(!is_planted_root_in(&at("work"), &projects, &Vec::new(), &[]));
    assert!(!is_planted_root_in(&at("secret"), &projects, &Vec::new(), &[]));
}

#[test]
fn drop_planted_roots_drops_a_root_spelled_with_dotdot() {
    let roots = vec![PathBuf::from("/w/a"), PathBuf::from("/w/a/../b")];
    assert_eq!(drop_planted_roots(roots, &[], &[]), vec![PathBuf::from("/w/a")]);
}

#[test]
fn a_local_file_must_be_a_known_projects() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("p");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("project.json"), "{}").unwrap();
    let projects = vec![entry("p", "current", &dir.to_string_lossy())];
    let known = dir.join("project.json");
    assert!(is_local_file_in(&projects, &known.to_string_lossy()));
    // The same file under another spelling resolves to it.
    let spelled = tmp.path().join("p").join(".").join("project.json");
    assert!(is_local_file_in(&projects, &spelled.to_string_lossy()));
    assert!(!is_local_file_in(&projects, &tmp.path().join("other.json").to_string_lossy()));
    assert!(!is_local_file_in(&projects, ""));
}

#[test]
fn allowed_roots_box_scope_covers_folder_and_member_roots() {
    let mut y = entry("y", "inactive", "/home/u/code/projecty");
    y.extra.insert(
        "mirror".to_string(),
        Value::String(concat!("/home/u/", crate::app_slug!(), "/projects-ssh/y").to_string()),
    );
    let projects = vec![entry("x", "current", "/home/u/code/projectx"), y];
    let boxes = vec![mk_box("b1", &["x", "y"], Some(concat!("/home/u/", crate::app_slug!(), "/boxes/b1")))];
    let roots = compute_allowed_roots(&projects, &boxes, Some("box:b1"), Path::new(ROOT_WORK));
    assert!(roots.iter().any(|r| r.ends_with("boxes/b1")));
    assert!(roots.iter().any(|r| r.ends_with("projectx")));
    assert!(roots.iter().any(|r| r.ends_with("projecty")));
    assert!(roots.iter().any(|r| r.ends_with("projects-ssh/y")));
    // A box viewer is not the root scope.
    assert!(!roots.iter().any(|r| r == Path::new(ROOT_WORK)));
}

#[test]
fn allowed_roots_box_scope_excludes_non_members() {
    let projects = vec![
        entry("x", "current", "/home/u/code/projectx"),
        entry("y", "inactive", "/home/u/code/projecty"),
    ];
    let boxes = vec![mk_box("b1", &["y"], None)];
    let roots = compute_allowed_roots(&projects, &boxes, Some("box:b1"), Path::new(ROOT_WORK));
    assert!(roots.iter().any(|r| r.ends_with("projecty")));
    assert!(
        !roots.iter().any(|r| r.ends_with("projectx")),
        "the current project is not reachable through a box it is not in"
    );
}

#[test]
fn allowed_roots_unknown_box_scope_fails_closed() {
    let projects = vec![entry("x", "current", "/home/u/code/projectx")];
    let boxes = vec![mk_box("b1", &["x"], None)];
    assert!(compute_allowed_roots(
        &projects,
        &boxes,
        Some("box:ghost"),
        Path::new(ROOT_WORK)
    )
    .is_empty());
}

#[test]
fn allowed_roots_no_current_and_no_scope_is_root_folder_only() {
    // With no owning project and no current one, the root scope can still
    // read its own folder — and nothing else.
    let projects = vec![entry("x", "inactive", "/home/u/code/projectx")];
    let roots = compute_allowed_roots(&projects, &Vec::new(), None, Path::new(ROOT_WORK));
    assert_eq!(roots, vec![PathBuf::from(ROOT_WORK)]);
}

#[test]
fn allowed_roots_root_scope_includes_root_folder_beside_current() {
    // The ROOT scope (scope_id None) reads the root terminal folder — the
    // regression here was a PDF opened from the root tree failing every
    // byte read and hanging on "Loading" (~/tabtivity/root was never a root).
    let projects = vec![entry("x", "current", "/home/u/code/projectx")];
    let roots = compute_allowed_roots(&projects, &Vec::new(), None, Path::new(ROOT_WORK));
    assert!(roots.iter().any(|r| r == Path::new(ROOT_WORK)));
    assert!(roots.iter().any(|r| r.ends_with("projectx")));
}

#[test]
fn allowed_roots_project_scope_excludes_root_folder() {
    // A project-scoped viewer stays project-isolated: it does not gain the
    // root terminal folder.
    let projects = vec![entry("x", "current", "/home/u/code/projectx")];
    let roots = compute_allowed_roots(&projects, &Vec::new(), Some("x"), Path::new(ROOT_WORK));
    assert!(!roots.iter().any(|r| r == Path::new(ROOT_WORK)));
}

#[test]
fn confine_abs_within_blocks_outside_roots() {
    // With the current project at projectx, classic exploit targets and a
    // sibling project alike must be refused.
    let roots = vec![PathBuf::from("/home/u/code/projectx")];
    for p in [
        "/home/u/.ssh/id_rsa",
        "/home/u/.aws/credentials",
        "/etc/passwd",
        "/home/u/code/projecty/secret", // sibling project
    ] {
        assert!(
            confine_abs_within(Path::new(p), &roots).is_err(),
            "must refuse {p}"
        );
    }
}

#[test]
fn confine_abs_within_allows_paths_inside_current_project() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let roots = vec![root.clone()];
    // A file inside the project tree must pass even before it exists, and
    // so must one in a folder not made yet (the nearest existing ancestor
    // is resolved and the rest re-joined).
    assert!(confine_abs_within(&root.join("main.rs"), &roots).is_ok());
    assert!(confine_abs_within(&root.join("src").join("main.rs"), &roots).is_ok());
}

/// `base` with `parts` appended as written. `Path::join` onto a Windows
/// verbatim path (what `canonicalize` returns there) resolves `..` as it
/// joins, so a joined path would test a plain one instead (ci-cd #389).
fn spelled(base: &Path, parts: &[&str]) -> PathBuf {
    let mut path = base.as_os_str().to_owned();
    for part in parts {
        path.push(std::path::MAIN_SEPARATOR_STR);
        path.push(part);
    }
    PathBuf::from(path)
}

#[test]
fn confine_abs_within_refuses_a_dot_dot_through_a_missing_folder() {
    // `root/missing/../..` used to pass the prefix check lexically.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap().join("p");
    fs::create_dir(&root).unwrap();
    let roots = vec![root.clone()];
    let escape = spelled(&root, &["missing", "..", "..", "loot"]);
    assert!(confine_abs_within(&escape, &roots).is_err());
    // Even one that would land back inside is refused: `..` is never needed.
    let back = spelled(&root, &["missing", "..", "x"]);
    assert!(confine_abs_within(&back, &roots).is_err());
}

#[cfg(unix)]
#[test]
fn confine_abs_within_judges_a_dangling_link_by_its_target() {
    // Gap 22: `exists()` is false for a dangling link, so it used to be
    // judged as a new file at its own (in-root) name.
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = project.path().canonicalize().unwrap();
    let link = root.join("x.pdf");
    std::os::unix::fs::symlink(outside.path().join("new.pdf"), &link).unwrap();
    assert!(confine_abs_within(&link, std::slice::from_ref(&root)).is_err());
    // A missing folder below an in-root link out of the project is judged
    // by where the link leads, not lexically.
    std::os::unix::fs::symlink(outside.path(), root.join("out")).unwrap();
    let deep = root.join("out").join("missing").join("x");
    assert!(confine_abs_within(&deep, &[root]).is_err());
}

// ── open_confined: the viewers' held-handle I/O (gaps 22, 31; D1) ──────

/// A canonical project root in a fresh temp dir, and a second temp dir
/// outside it.
fn confined_fixture() -> (tempfile::TempDir, PathBuf, tempfile::TempDir) {
    let project = tempfile::tempdir().unwrap();
    let root = project.path().canonicalize().unwrap();
    (project, root, tempfile::tempdir().unwrap())
}

fn save(path: &Path, roots: &[PathBuf], mode: Confined, content: &[u8]) -> Result<(), String> {
    write_opened(open_confined(path, roots, mode)?, content)
}

fn load(path: &Path, roots: &[PathBuf]) -> Result<Vec<u8>, String> {
    read_opened(open_confined(path, roots, Confined::Read)?, MAX_BINARY_VIEW_BYTES)
}

#[cfg(unix)]
#[test]
fn a_viewer_save_refuses_a_dangling_leaf_link_and_creates_nothing_at_its_target() {
    let (_p, root, outside) = confined_fixture();
    let roots = vec![root.clone()];
    let victim = outside.path().join("autostart.desktop");
    let link = root.join("deck.eldeck.json");
    std::os::unix::fs::symlink(&victim, &link).unwrap();
    for mode in [Confined::Write, Confined::Overwrite] {
        let refused = save(&link, &roots, mode, b"payload").unwrap_err();
        assert!(refused.contains("is a link"), "{mode:?}: {refused}");
    }
    assert!(!victim.exists(), "nothing was created at the link's target");
    // A dangling link to a missing in-root name is refused the same way.
    let inner = root.join("figure.png");
    std::os::unix::fs::symlink(root.join("not-yet.png"), &inner).unwrap();
    assert!(save(&inner, &roots, Confined::Write, b"png").unwrap_err().contains("is a link"));
    assert!(!root.join("not-yet.png").exists());
}

#[cfg(unix)]
#[test]
fn a_viewer_save_refuses_an_in_root_link_that_still_reads() {
    // D1: every symlinked leaf is refused for a save, in-root ones too —
    // but a read follows it as it always did.
    let (_p, root, _outside) = confined_fixture();
    let roots = vec![root.clone()];
    fs::write(root.join("real.md"), "hello").unwrap();
    let link = root.join("link.md");
    std::os::unix::fs::symlink(root.join("real.md"), &link).unwrap();
    for mode in [Confined::Write, Confined::Overwrite] {
        assert!(save(&link, &roots, mode, b"bye").unwrap_err().contains("is a link"), "{mode:?}");
    }
    assert_eq!(fs::read_to_string(root.join("real.md")).unwrap(), "hello");
    assert_eq!(load(&link, &roots).unwrap(), b"hello");
    assert!(open_confined(&link, &roots, Confined::Stat).is_ok());
    // A link out of the project neither reads nor stats.
    let (_q, _other_root, outside) = confined_fixture();
    fs::write(outside.path().join("secret"), "s").unwrap();
    let out = root.join("out.md");
    std::os::unix::fs::symlink(outside.path().join("secret"), &out).unwrap();
    assert!(load(&out, &roots).unwrap_err().contains("not in the current project"));
    assert!(open_confined(&out, &roots, Confined::Stat).is_err());
}

#[cfg(unix)]
#[test]
fn a_viewer_save_through_a_linked_folder_inside_the_project_still_works() {
    // Only the leaf is held to D1: a folder reached through an in-root
    // link is resolved first, then walked by its real path.
    let (_p, root, _outside) = confined_fixture();
    fs::create_dir(root.join("real")).unwrap();
    std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();
    save(&root.join("alias").join("a.png"), std::slice::from_ref(&root), Confined::Write, b"png").unwrap();
    assert_eq!(fs::read(root.join("real").join("a.png")).unwrap(), b"png");
}

#[test]
fn a_figure_save_makes_its_own_folder_and_refuses_an_8_3_alias() {
    let (_p, root, _outside) = confined_fixture();
    let roots = vec![root.clone()];
    let figures = root.join("talk.tex-figures");
    save(&figures.join("f1.png"), &roots, Confined::WriteOwnFolder, b"png").unwrap();
    assert_eq!(fs::read(figures.join("f1.png")).unwrap(), b"png");
    save(&figures.join("f1.png"), &roots, Confined::WriteOwnFolder, b"png2").unwrap();
    assert_eq!(fs::read(figures.join("f1.png")).unwrap(), b"png2");
    assert!(save(&figures.join("EVIL~1.PNG"), &roots, Confined::WriteOwnFolder, b"x").unwrap_err().contains('~'));
    assert!(!figures.join("EVIL~1.PNG").exists());
    // Only the own folder is made, never one above it.
    assert!(save(&root.join("gone").join("x.tex-figures").join("f.png"), &roots, Confined::WriteOwnFolder, b"x").is_err());
    assert!(!root.join("gone").exists());
}

#[cfg(unix)]
#[test]
fn a_figure_save_refuses_a_figure_folder_that_is_a_link_even_to_a_root() {
    // Threat recheck gap 23 review (0b): a fenced agent points the deck's
    // figure folder at a box sibling it cannot see. An ordinary save
    // resolves the folder (and lands in the sibling); a figure save walks
    // it by name and refuses it.
    let (_p, root, outside) = confined_fixture();
    let sibling = outside.path().canonicalize().unwrap();
    fs::write(sibling.join("paper.png"), b"theirs").unwrap();
    std::os::unix::fs::symlink(&sibling, root.join("talk.tex-figures")).unwrap();
    let roots = vec![root.clone(), sibling.clone()];
    let target = root.join("talk.tex-figures").join("paper.png");
    let err = save(&target, &roots, Confined::WriteOwnFolder, b"mine").unwrap_err();
    assert!(err.contains("folder that is a link"), "{err}");
    assert!(save(&root.join("talk.tex-figures").join("new.png"), &roots, Confined::WriteOwnFolder, b"x").is_err());
    assert_eq!(fs::read(sibling.join("paper.png")).unwrap(), b"theirs");
    assert!(!sibling.join("new.png").exists());
    // What the plain mode does with the same path (why the deck asks for
    // the strict one).
    save(&target, &roots, Confined::Write, b"mine").unwrap();
    assert_eq!(fs::read(sibling.join("paper.png")).unwrap(), b"mine");
    // A dangling folder link is not "missing, so make it" either.
    std::os::unix::fs::symlink(root.join("nowhere"), root.join("b.tex-figures")).unwrap();
    assert!(save(&root.join("b.tex-figures").join("f.png"), &roots, Confined::WriteOwnFolder, b"x").is_err());
    assert!(!root.join("nowhere").exists());
}

#[test]
fn a_viewer_save_rewrites_a_regular_file_in_place() {
    let (_p, root, _outside) = confined_fixture();
    let roots = vec![root.clone()];
    let file = root.join("notes.md");
    fs::write(&file, "a much longer original text").unwrap();
    #[cfg(unix)]
    let before = {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
        fs::metadata(&file).unwrap().ino()
    };
    save(&file, &roots, Confined::Overwrite, b"short").unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "short", "emptied before the write");
    save(&file, &roots, Confined::Write, b"again").unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "again");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let meta = fs::metadata(&file).unwrap();
        assert_eq!(meta.ino(), before, "the same file, not a replacement");
        assert_eq!(meta.permissions().mode() & 0o777, 0o640, "its mode is kept");
    }
    assert_eq!(load(&file, &roots).unwrap(), b"again");
}

#[test]
fn a_viewer_save_creates_a_missing_file_but_never_a_missing_folder() {
    let (_p, root, _outside) = confined_fixture();
    let roots = vec![root.clone()];
    let fresh = root.join("annotated.png");
    assert!(save(&fresh, &roots, Confined::Overwrite, b"x").is_err(), "a text save never creates");
    assert!(!fresh.exists());
    save(&fresh, &roots, Confined::Write, b"png").unwrap();
    assert_eq!(fs::read(&fresh).unwrap(), b"png");
    let nested = root.join("missing").join("x.png");
    assert!(save(&nested, &roots, Confined::Write, b"x").is_err());
    assert!(!root.join("missing").exists());
    // A folder is not a file, for a save or a read; its metadata still serves.
    fs::create_dir(root.join("dir")).unwrap();
    assert!(save(&root.join("dir"), &roots, Confined::Write, b"x").unwrap_err().contains("not a file"));
    assert!(load(&root.join("dir"), &roots).unwrap_err().contains("not a file"));
    assert!(open_confined(&root.join("dir"), &roots, Confined::Stat).unwrap().metadata().unwrap().is_dir());
    assert!(open_confined(&root, &roots, Confined::Stat).is_ok());
    assert!(load(&root, &roots).is_err());
}

#[test]
fn open_confined_refuses_dot_components_outside_roots_and_relative_paths() {
    let (_p, root, outside) = confined_fixture();
    let roots = vec![root.clone()];
    fs::write(root.join("x"), "x").unwrap();
    let dotted = spelled(&root, &["missing", "..", "x"]);
    for mode in [Confined::Read, Confined::Stat, Confined::Overwrite, Confined::Write] {
        assert!(open_confined(&dotted, &roots, mode).is_err(), "{mode:?}");
        assert!(open_confined(Path::new("x"), &roots, mode).is_err(), "{mode:?}");
    }
    let elsewhere = outside.path().join("y");
    assert!(save(&elsewhere, &roots, Confined::Write, b"y").unwrap_err().contains("not in the current project"));
    assert!(!elsewhere.exists());
    assert!(open_confined(&root.join("x"), &[], Confined::Read).is_err(), "no roots, nothing opens");
}

#[test]
fn open_confined_walks_from_the_longest_root() {
    // A box folder holding a member project: both are roots, and the path
    // opens under either.
    let (_p, root, _outside) = confined_fixture();
    let member = root.join("member");
    fs::create_dir(&member).unwrap();
    fs::write(member.join("a.txt"), "a").unwrap();
    let roots = vec![root.clone(), member.clone()];
    assert_eq!(load(&member.join("a.txt"), &roots).unwrap(), b"a");
    assert_eq!(load(&member.join("a.txt"), &[root]).unwrap(), b"a");
}

#[test]
fn read_opened_refuses_a_file_over_the_cap() {
    let (_p, root, _outside) = confined_fixture();
    fs::write(root.join("big"), vec![b'x'; 11]).unwrap();
    let file = open_confined(&root.join("big"), std::slice::from_ref(&root), Confined::Read).unwrap();
    assert!(read_opened(file, 10).unwrap_err().contains("too large"));
    let file = open_confined(&root.join("big"), &[root], Confined::Read).unwrap();
    assert_eq!(read_opened(file, 11).unwrap().len(), 11);
}

#[cfg(windows)]
#[test]
fn a_viewer_save_refuses_a_reparse_point_leaf_on_windows() {
    // Creating a symbolic link needs Developer Mode or the privilege; a
    // runner without it has nothing to test here.
    let (_p, root, outside) = confined_fixture();
    let roots = vec![root.clone()];
    let victim = outside.path().join("victim.txt");
    fs::write(&victim, "original").unwrap();
    let link = root.join("link.txt");
    if std::os::windows::fs::symlink_file(&victim, &link).is_err() {
        return;
    }
    for mode in [Confined::Write, Confined::Overwrite] {
        assert!(save(&link, &roots, mode, b"payload").unwrap_err().contains("is a link"), "{mode:?}");
    }
    assert_eq!(fs::read_to_string(&victim).unwrap(), "original");
    // A dangling one creates nothing at its target.
    let gone = outside.path().join("gone.txt");
    let dangling = root.join("dangling.txt");
    std::os::windows::fs::symlink_file(&gone, &dangling).unwrap();
    assert!(save(&dangling, &roots, Confined::Write, b"x").is_err());
    assert!(!gone.exists());
}

#[test]
fn confine_abs_within_blocks_prefix_sibling() {
    // /home/u/code/projectx-evil must NOT be treated as inside projectx.
    let roots = vec![PathBuf::from("/home/u/code/projectx")];
    let sibling = Path::new("/home/u/code/projectx-evil/loot");
    assert!(confine_abs_within(sibling, &roots).is_err());
}

#[test]
fn confine_abs_within_empty_roots_refuses_everything() {
    assert!(confine_abs_within(Path::new("/home/u/code/projectx/a"), &[]).is_err());
}

// ── display_path ───────────────────────────────────────────────────────

#[test]
fn display_path_is_noop_without_verbatim_prefix() {
    // A plain path is returned unchanged on every platform.
    let p = if cfg!(target_os = "windows") {
        r"C:\Users\u\proj\file.txt"
    } else {
        "/home/u/proj/file.txt"
    };
    assert_eq!(display_path(Path::new(p)), p);
}

#[test]
fn excluded_rel_set_normalises_every_spelling_to_one() {
    let set = excluded_rel_set(&[
        "venv".into(),
        "./data/raw".into(),
        "/results/".into(),
        "a\\b".into(),
        "  spaced  ".into(),
        String::new(),
        "/".into(),
    ]);
    assert!(set.contains("venv"));
    assert!(set.contains("data/raw"));
    assert!(set.contains("results"));
    assert!(set.contains("a/b"));
    assert!(set.contains("spaced"));
    // Empty and separator-only entries are dropped rather than becoming an
    // empty-string key, which would match the project root and prune the lot.
    assert_eq!(set.len(), 5);
}

#[test]
fn dir_size_skips_an_excluded_subtree() {
    let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-excl-{}"), std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(tmp.join("keep")).unwrap();
    fs::create_dir_all(tmp.join("venv/lib")).unwrap();
    fs::write(tmp.join("keep/a.txt"), vec![b'x'; 100]).unwrap();
    fs::write(tmp.join("venv/lib/big.bin"), vec![b'x'; 5000]).unwrap();
    let root = tmp.to_string_lossy().to_string();

    let all = dir_size_local(&root, "", &[]).unwrap();
    assert_eq!(all, 5100, "baseline walks everything");

    let pruned = dir_size_local(&root, "", &["venv".into()]).unwrap();
    assert_eq!(pruned, 100, "the excluded subtree contributes nothing");

    // Exclusions are project-root-relative, so they still bite when the walk
    // starts deeper — here the walk root IS the excluded folder's parent.
    let nested = dir_size_local(&root, "venv", &["venv/lib".into()]).unwrap();
    assert_eq!(nested, 0);

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
#[cfg(target_os = "windows")]
fn display_path_strips_windows_verbatim_prefixes() {
    // Drive verbatim prefix is removed so the frontend sees a native path.
    assert_eq!(
        display_path(Path::new(r"\\?\C:\proj\file.txt")),
        r"C:\proj\file.txt"
    );
    // UNC verbatim prefix collapses back to a `\\server\share` path.
    assert_eq!(
        display_path(Path::new(r"\\?\UNC\server\share\file.txt")),
        r"\\server\share\file.txt"
    );
}
