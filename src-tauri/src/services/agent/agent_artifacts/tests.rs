use super::*;
use std::fs;

const ID: &str = "ddb72054-fb3d-493d-8ddb-e7f6c32bb591";
const OTHER: &str = "11111111-2222-3333-4444-555555555555";

fn names(target: &str) -> Option<Vec<String>> {
    artifact_names(target, ID)
}

fn link(rest: &str) -> String {
    format!("file:///home/user/.gemini/antigravity-cli/brain/{ID}/{rest}")
}

#[test]
fn a_file_link_or_absolute_path_into_the_conversations_folder_names_the_file() {
    assert_eq!(names(&link("plan.md")), Some(vec!["plan.md".into()]));
    assert_eq!(names(&link("sub/notes.md")), Some(vec!["sub".into(), "notes.md".into()]));
    assert_eq!(names(&link("my%20plan.md")), Some(vec!["my plan.md".into()]));
    let absolute = format!("/home/user/.gemini/antigravity-cli/brain/{ID}/plan.md");
    assert_eq!(names(&absolute), Some(vec!["plan.md".into()]));
}

#[test]
fn nothing_else_names_a_file() {
    let other = format!("file:///home/user/.gemini/antigravity-cli/brain/{OTHER}/plan.md");
    for target in [
        other.as_str(),
        "file:///home/user/project/plan.md",
        "plan.md",
        "https://example.com/brain/x/plan.md",
        "file://host/home/user/brain/x/plan.md",
        &link(""),
        &link("../plan.md"),
        &link("a/../plan.md"),
        &link("%2e%2e/plan.md"),
        &link(".system_generated/logs/transcript.jsonl"),
        &link(".hidden.md"),
        &link("a%2F..%2Fplan.md/x"),
        &link("a/b/c/d/e.md"),
        &link("plan.md%00.txt"),
        &link("a%5Cb.md"),
        &link("bad%zz.md"),
    ] {
        assert_eq!(names(target), None, "{target}");
    }
    assert_eq!(artifact_names(&link("plan.md"), ""), None);
    assert_eq!(artifact_names(&link("plan.md"), "a/b"), None);
}

fn home_with(files: &[(&str, &str)]) -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    for (rel, body) in files {
        let path = home.path().join(".gemini").join("antigravity-cli").join("brain").join(ID).join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }
    home
}

#[test]
fn a_document_of_the_conversation_is_read_as_text() {
    let home = home_with(&[("plan.md", "# Plan\n"), ("sub/notes.txt", "n")]);
    assert_eq!(read(home.path(), ID, &link("plan.md")), Some(Artifact { name: "plan.md".into(), text: "# Plan\n".into() }));
    assert_eq!(read(home.path(), ID, &link("sub/notes.txt")).map(|a| a.text), Some("n".into()));
}

#[test]
fn only_this_conversations_text_files_are_read() {
    let home = home_with(&[("plan.md", "x"), ("pic.png", "x"), ("bin.md", "")]);
    fs::write(
        home.path().join(".gemini").join("antigravity-cli").join("brain").join(ID).join("bin.md"),
        [0xff, 0xfe, 0x00],
    )
    .unwrap();
    // Another conversation's id, a missing file, a non-text extension, bytes that are not text.
    assert_eq!(read(home.path(), OTHER, &link("plan.md")), None);
    assert_eq!(read(home.path(), ID, &link("missing.md")), None);
    assert_eq!(read(home.path(), ID, &link("pic.png")), None);
    assert_eq!(read(home.path(), ID, &link("bin.md")), None);
    assert_eq!(read(home.path(), "not-a-uuid", &link("plan.md")), None);
}

#[test]
fn a_document_over_the_cap_is_not_read() {
    let big = "x".repeat(MAX_BYTES as usize + 1);
    let home = home_with(&[("big.md", big.as_str()), ("ok.md", "x")]);
    assert_eq!(read(home.path(), ID, &link("big.md")), None);
    assert!(read(home.path(), ID, &link("ok.md")).is_some());
}

#[cfg(unix)]
#[test]
fn a_link_is_not_followed_out_of_the_conversations_folder() {
    let home = home_with(&[("plan.md", "x")]);
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.md"), "secret").unwrap();
    let dir = home.path().join(".gemini").join("antigravity-cli").join("brain").join(ID);
    std::os::unix::fs::symlink(outside.path().join("secret.md"), dir.join("link.md")).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.join("folder")).unwrap();
    assert_eq!(read(home.path(), ID, &link("link.md")), None);
    assert_eq!(read(home.path(), ID, &link("folder/secret.md")), None);
}
