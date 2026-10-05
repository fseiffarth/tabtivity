//! Tests for file-tree commands: list_dir, create_file, create_dir,
//! delete_file, delete_dir, rename_path.
//!
//! All tests use a tempdir so no real project state is touched.

use app_lib::brand::SLUG;
use std::fs;

use app_lib::commands::fs::{
    create_dir_local, create_file_local, delete_dir_local, delete_file_local, list_dir_local,
    rename_path_local,
};
use app_lib::commands::projects::scaffold_project;
use tempfile::TempDir;

// ── helpers ────────────────────────────────────────────────────────────────

fn setup() -> TempDir {
    let tmp = tempfile::tempdir().expect("tempdir");
    // list_dir / rename / delete require canonical paths, so the root must exist.
    tmp
}

fn project_dir(tmp: &TempDir) -> String {
    tmp.path().to_string_lossy().to_string()
}

// ── list_dir ──────────────────────────────────────────────────────────────

#[test]
fn list_dir_lists_files_and_dirs() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::write(tmp.path().join("README.md"), "# readme").unwrap();
    fs::create_dir_all(tmp.path().join("src")).unwrap();
    fs::write(tmp.path().join("src/main.rs"), "fn main() {}").unwrap();

    let entries = list_dir_local(&dir, "").unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"src"), "src dir must appear");
    assert!(names.contains(&"README.md"), "README.md must appear");
}

#[test]
fn list_dir_dirs_come_before_files() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::write(tmp.path().join("aaa.txt"), "").unwrap();
    fs::create_dir_all(tmp.path().join("zzz_dir")).unwrap();

    let entries = list_dir_local(&dir, "").unwrap();
    let first = entries.first().expect("at least one entry");
    assert!(first.is_dir, "directories must sort before files");
}

#[test]
fn list_dir_hides_app_directory() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::create_dir_all(tmp.path().join(concat!(".", app_lib::app_slug!(), "/sessions"))).unwrap();
    fs::write(tmp.path().join(concat!(".", app_lib::app_slug!(), "/sessions/terminals.json")), "{}").unwrap();
    fs::write(tmp.path().join("visible.txt"), "hi").unwrap();

    let entries = list_dir_local(&dir, "").unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(!names.contains(&concat!(".", app_lib::app_slug!())), concat!(".", app_lib::app_slug!(), " must be hidden"));
    assert!(names.contains(&"visible.txt"));
}

#[test]
fn list_dir_rejects_path_traversal() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    let result = list_dir_local(&dir, "../");
    assert!(result.is_err(), "path traversal must be rejected");
}

#[test]
fn list_dir_returns_subdirectory_contents() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::create_dir_all(tmp.path().join("sub")).unwrap();
    fs::write(tmp.path().join("sub/child.txt"), "hello").unwrap();

    let entries = list_dir_local(&dir, "sub").unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"child.txt"));
}

#[test]
fn list_dir_entry_has_extension_field() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::write(tmp.path().join("notes.md"), "# notes").unwrap();

    let entries = list_dir_local(&dir, "").unwrap();
    let md = entries.iter().find(|e| e.name == "notes.md").unwrap();
    assert_eq!(md.extension.as_deref(), Some(".md"));
}

#[test]
fn list_dir_directory_has_zero_size() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::create_dir_all(tmp.path().join("subdir")).unwrap();

    let entries = list_dir_local(&dir, "").unwrap();
    let subdir = entries
        .iter()
        .find(|e| e.name == "subdir" && e.is_dir)
        .unwrap();
    assert_eq!(subdir.size, 0);
}

// ── create_file ───────────────────────────────────────────────────────────

#[test]
fn create_file_creates_an_empty_file() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    create_file_local(&dir, "new_file.txt").unwrap();

    assert!(tmp.path().join("new_file.txt").exists());
}

#[test]
fn create_file_creates_parent_dirs() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    create_file_local(&dir, "deep/nested/file.rs").unwrap();

    assert!(tmp.path().join("deep/nested/file.rs").exists());
}

#[test]
fn create_file_rejects_path_traversal() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    let result = create_file_local(&dir, "../escape.txt");
    assert!(result.is_err(), "traversal must be rejected");
}

// ── create_dir ────────────────────────────────────────────────────────────

#[test]
fn create_dir_makes_new_directory() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    create_dir_local(&dir, "new_dir").unwrap();

    assert!(tmp.path().join("new_dir").is_dir());
}

#[test]
fn create_dir_creates_nested_dirs() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    create_dir_local(&dir, "a/b/c").unwrap();

    assert!(tmp.path().join("a/b/c").is_dir());
}

#[test]
fn create_dir_rejects_path_traversal() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    let result = create_dir_local(&dir, "../evil_dir");
    assert!(result.is_err(), "traversal must be rejected");
}

// ── delete_file ───────────────────────────────────────────────────────────

#[test]
fn delete_file_removes_a_file() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    let f = tmp.path().join("todelete.txt");
    fs::write(&f, "bye").unwrap();

    delete_file_local(&dir, "todelete.txt").unwrap();

    assert!(!f.exists(), "file must be deleted");
}

#[test]
fn delete_file_rejects_directories() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::create_dir_all(tmp.path().join("mydir")).unwrap();

    let result = delete_file_local(&dir, "mydir");
    assert!(result.is_err(), "delete_file must refuse directories");
}

#[test]
fn delete_file_rejects_path_traversal() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    let result = delete_file_local(&dir, "../somewhere.txt");
    assert!(result.is_err());
}

// ── delete_dir ────────────────────────────────────────────────────────────

#[test]
fn delete_dir_removes_directory_tree() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::create_dir_all(tmp.path().join("subtree/inner")).unwrap();
    fs::write(tmp.path().join("subtree/inner/file.txt"), "data").unwrap();

    delete_dir_local(&dir, "subtree").unwrap();

    assert!(
        !tmp.path().join("subtree").exists(),
        "dir tree must be removed"
    );
}

#[test]
fn delete_dir_rejects_project_root() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    let result = delete_dir_local(&dir, "");
    // Either error, or we pass root as rel and it canonicalizes to root.
    // The command uses canonical() so passing "" will fail to canonicalize.
    // Passing "." expands to root — that must be rejected.
    let result2 = delete_dir_local(&dir, ".");
    // At least one of these must error.
    assert!(
        result.is_err() || result2.is_err(),
        "deleting project root must be rejected"
    );
}

#[test]
fn delete_dir_rejects_files() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::write(tmp.path().join("afile.txt"), "content").unwrap();

    let result = delete_dir_local(&dir, "afile.txt");
    assert!(result.is_err(), "delete_dir must refuse files");
}

#[test]
fn delete_dir_rejects_path_traversal() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    let result = delete_dir_local(&dir, "../outside");
    assert!(result.is_err());
}

// ── rename_path ───────────────────────────────────────────────────────────

#[test]
fn rename_path_renames_a_file() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::write(tmp.path().join("old.txt"), "content").unwrap();

    rename_path_local(&dir, "old.txt", "new.txt").unwrap();

    assert!(!tmp.path().join("old.txt").exists());
    assert!(tmp.path().join("new.txt").exists());
    assert_eq!(
        fs::read_to_string(tmp.path().join("new.txt")).unwrap(),
        "content"
    );
}

#[test]
fn rename_path_renames_a_directory() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::create_dir_all(tmp.path().join("old_dir")).unwrap();
    fs::write(tmp.path().join("old_dir/file.txt"), "hi").unwrap();

    rename_path_local(&dir, "old_dir", "new_dir").unwrap();

    assert!(!tmp.path().join("old_dir").exists());
    assert!(tmp.path().join("new_dir").is_dir());
    assert!(tmp.path().join("new_dir/file.txt").exists());
}

#[test]
fn rename_path_rejects_source_traversal() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    let result = rename_path_local(&dir, "../outside.txt", "safe.txt");
    assert!(result.is_err(), "traversal of old path must be rejected");
}

#[test]
fn rename_path_rejects_dest_traversal() {
    let tmp = setup();
    let dir = project_dir(&tmp);

    fs::write(tmp.path().join("file.txt"), "content").unwrap();

    let result = rename_path_local(&dir, "file.txt", "../../../evil.txt");
    assert!(result.is_err(), "traversal of new name must be rejected");
}

// ── scaffold_project (integration) ────────────────────────────────────────

#[test]
fn scaffold_project_integration_creates_full_structure() {
    let tmp = setup();
    scaffold_project(tmp.path(), true).unwrap();

    // Every canonical scaffold file must be present.
    for f in &[
        "AGENTS.md",
        "CLAUDE.md",
        "GEMINI.md",
        "TODO.md",
        "ROADMAP.md",
        "STATUS.md",
        "README.md",
        ".gitignore",
        ".claude/settings.json",
    ] {
        assert!(tmp.path().join(f).exists(), "missing scaffold: {f}");
    }
}

#[test]
fn scaffold_project_gitignore_contains_app() {
    let tmp = setup();
    scaffold_project(tmp.path(), true).unwrap();

    let gitignore = fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
    assert!(
        gitignore.contains(concat!(".", app_lib::app_slug!(), "/")),
        ".gitignore must exclude .{SLUG}/: {gitignore}"
    );
}

#[test]
fn scaffold_project_claude_settings_is_valid_json() {
    let tmp = setup();
    scaffold_project(tmp.path(), true).unwrap();

    let content = fs::read_to_string(tmp.path().join(".claude/settings.json")).unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(&content).expect(".claude/settings.json must be valid JSON");
    assert!(parsed.is_object());
}
