use super::*;

fn names(docs: impl Iterator<Item = &'static ScaffoldDoc>) -> Vec<&'static str> {
    docs.map(|d| d.name).collect()
}

#[test]
fn the_catalog_has_unique_names_and_the_lean_default_set() {
    let all = names(DOCS.iter());
    let mut unique = all.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), all.len(), "duplicate catalog name: {all:?}");
    assert_eq!(names(defaults()), ["AGENTS.md", "README.md"]);
    for name in ["PROJECT.md", "TODO.md", "ROADMAP.md", "STATUS.md", "DOCUMENTATION.md"] {
        let d = doc(name).unwrap();
        assert!(!d.default && d.creatable && !d.pointer, "{name}: create on demand");
    }
    for name in ["CLAUDE.md", "GEMINI.md"] {
        let d = doc(name).unwrap();
        assert!(d.pointer && !d.default && !d.creatable, "{name}: recognised, never written");
    }
    let remarks = doc("REMARKS.md").unwrap();
    assert!(!remarks.default && !remarks.creatable && !remarks.pointer);
    for d in DOCS {
        assert!(!d.name.contains('/') && !d.name.contains('\\'), "{} is a leaf name", d.name);
        assert!(!d.default || d.creatable, "a default doc is creatable");
        assert!(!d.pointer || !d.creatable, "a pointer is never offered for creation");
        for old in d.history {
            assert_ne!(*old, d.template, "{}: history must hold earlier texts only", d.name);
        }
    }
    assert!(doc("../AGENTS.md").is_none());
    assert!(doc("agents.md").is_none(), "names match exactly");
}

#[test]
fn state_is_missing_template_or_edited() {
    let todo = doc("TODO.md").unwrap();
    assert_eq!(todo.state_of(None), DocState::Missing);
    assert_eq!(todo.state_of(Some("")), DocState::Template);
    assert_eq!(todo.state_of(Some(" \n\t\n")), DocState::Template);
    assert_eq!(todo.state_of(Some("# TODO\n")), DocState::Template);
    assert_eq!(todo.state_of(Some("# TODO\r\n")), DocState::Template, "CRLF checkouts");
    assert_eq!(todo.state_of(Some("# TODO")), DocState::Template);
    assert_eq!(todo.state_of(Some("# TODO\n\n- [ ] ship\n")), DocState::Edited);
    assert_eq!(todo.state_of(Some("# Roadmap\n")), DocState::Edited, "another doc's stub is text");

    let agents = doc("AGENTS.md").unwrap();
    assert_eq!(agents.state_of(Some(AGENTS_SCAFFOLD)), DocState::Template);
    for old in AGENTS_HISTORY {
        assert_eq!(agents.state_of(Some(old)), DocState::Template);
        assert_eq!(agents.state_of(Some(&old.replace('\n', "\r\n"))), DocState::Template);
        assert_eq!(agents.state_of(Some(&format!("{old}\n## Mine\n"))), DocState::Edited);
    }
}

#[test]
fn every_old_stub_reads_as_a_template_and_the_pointers_as_pointers() {
    for (name, old) in [
        ("TODO.md", "# TODO\n"),
        ("ROADMAP.md", "# Roadmap\n"),
        ("STATUS.md", "# Status\n"),
        ("README.md", "# Project\n"),
        ("DOCUMENTATION.md", "# Documentation\n"),
        ("AGENTS.md", "# Agents\n"),
        ("REMARKS.md", REMARKS_SCAFFOLD),
        ("PROJECT.md", PROJECT_SCAFFOLD_2026_11_13),
        ("PROJECT.md", PROJECT_SCAFFOLD),
    ] {
        assert_eq!(doc(name).unwrap().state_of(Some(old)), DocState::Template, "{name}");
    }
    for (name, old) in [
        ("CLAUDE.md", "# Claude Context\n"),
        ("CLAUDE.md", CLAUDE_POINTER),
        ("GEMINI.md", "# Gemini Context\n"),
        ("GEMINI.md", GEMINI_POINTER),
        ("CLAUDE.md", ""),
    ] {
        assert_eq!(doc(name).unwrap().state_of(Some(old)), DocState::Pointer, "{name}");
    }
    // A pointer the user wrote in is theirs.
    let mine = format!("{CLAUDE_POINTER}\nAlways answer in German.\n");
    assert_eq!(doc("CLAUDE.md").unwrap().state_of(Some(&mine)), DocState::Edited);
    assert_eq!(doc("CLAUDE.md").unwrap().state_of(None), DocState::Missing);
}

/// The remarks feature starts `REMARKS.md` with its own TS template; the
/// catalog's copy must be the same bytes or a freshly made file would read as
/// `edited`.
#[test]
fn the_remarks_template_is_the_ts_one() {
    let ts = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("lib")
        .join("projects")
        .join("projectRemarks.ts");
    let src = std::fs::read_to_string(&ts).expect("projectRemarks.ts");
    let start = src.find("export const REMARKS_TEMPLATE = `").expect("REMARKS_TEMPLATE") + "export const REMARKS_TEMPLATE = `".len();
    let end = start + src[start..].find("`;").expect("closing backtick");
    let literal = src[start..end].replace("\\`", "`");
    assert_eq!(literal, REMARKS_SCAFFOLD);
    assert_eq!(doc("REMARKS.md").unwrap().template, literal);
}

#[test]
fn create_never_overwrites_and_upgrade_touches_only_an_untouched_agents_md() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();

    // Create writes the template once.
    let todo = doc("TODO.md").unwrap();
    assert!(create_doc_at(dir, todo).unwrap());
    assert_eq!(std::fs::read_to_string(dir.join("TODO.md")).unwrap(), "# TODO\n");
    std::fs::write(dir.join("TODO.md"), "mine").unwrap();
    assert!(!create_doc_at(dir, todo).unwrap(), "a second create is a no-op");
    assert_eq!(std::fs::read_to_string(dir.join("TODO.md")).unwrap(), "mine");

    // A folder at the name is kept too.
    std::fs::create_dir(dir.join("STATUS.md")).unwrap();
    assert!(!create_doc_at(dir, doc("STATUS.md").unwrap()).unwrap());
    assert!(dir.join("STATUS.md").is_dir());

    // Upgrade: only AGENTS.md, only while untouched.
    let agents = doc("AGENTS.md").unwrap();
    assert!(!upgrade_doc_at(dir, agents).unwrap(), "nothing there");
    std::fs::write(dir.join("AGENTS.md"), "# Agents\n").unwrap();
    assert!(upgrade_doc_at(dir, agents).unwrap());
    assert_eq!(std::fs::read_to_string(dir.join("AGENTS.md")).unwrap(), AGENTS_SCAFFOLD);
    assert!(!upgrade_doc_at(dir, agents).unwrap(), "the current template is left as is");
    std::fs::write(dir.join("AGENTS.md"), "# Agents\n\nMine.\n").unwrap();
    assert!(!upgrade_doc_at(dir, agents).unwrap());
    assert_eq!(std::fs::read_to_string(dir.join("AGENTS.md")).unwrap(), "# Agents\n\nMine.\n");

    // No other doc is ever rewritten, not even an empty one.
    std::fs::write(dir.join("README.md"), "").unwrap();
    assert!(!upgrade_doc_at(dir, doc("README.md").unwrap()).unwrap());
    std::fs::write(dir.join("CLAUDE.md"), "# Claude Context\n").unwrap();
    assert!(!upgrade_doc_at(dir, doc("CLAUDE.md").unwrap()).unwrap());
    assert_eq!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), "# Claude Context\n");
}

#[cfg(unix)]
#[test]
fn a_link_or_fifo_is_missing_and_never_followed_or_written_through() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("p");
    std::fs::create_dir(&dir).unwrap();
    let outside = tmp.path().join("outside.md");

    // Dangling link: a create must not make its target.
    std::os::unix::fs::symlink(&outside, dir.join("AGENTS.md")).unwrap();
    let agents = doc("AGENTS.md").unwrap();
    assert!(!create_doc_at(&dir, agents).unwrap());
    assert!(!outside.exists());
    assert!(present_at(&dir, "AGENTS.md"), "a dangling link is 'there' for the tag");
    assert_eq!(state_at(&dir, agents), DocState::Missing);
    assert!(agents_empty_at(&dir));

    // Link to a stub: not read, so not upgraded either.
    std::fs::write(&outside, "# Agents\n").unwrap();
    assert_eq!(state_at(&dir, agents), DocState::Missing);
    assert!(!upgrade_doc_at(&dir, agents).unwrap());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "# Agents\n");

    // A FIFO is never waited on.
    let fifo = dir.join("README.md");
    crate::services::home_io::mkfifo(&fifo);
    let d = dir.clone();
    let state = crate::services::home_io::within_deadline(move || state_at(&d, doc("README.md").unwrap()));
    assert_eq!(state, DocState::Missing);
    let d = dir.clone();
    assert!(!crate::services::home_io::within_deadline(move || create_doc_at(&d, doc("README.md").unwrap()).unwrap()));
}

#[test]
fn a_doc_over_the_read_cap_is_not_a_stub() {
    let tmp = tempfile::tempdir().unwrap();
    let big = vec![b' '; (MAX_SCAFFOLD_DOC_BYTES + 1) as usize];
    std::fs::write(tmp.path().join("TODO.md"), big).unwrap();
    // Unreadable under the cap reads as missing (and is present on disk).
    assert_eq!(state_at(tmp.path(), doc("TODO.md").unwrap()), DocState::Missing);
    assert!(present_at(tmp.path(), "TODO.md"));
}

#[test]
fn the_status_lists_present_docs_and_ghost_rows_only() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(dir.join("AGENTS.md"), "# Agents\n\nReal.\n").unwrap();
    std::fs::write(dir.join("CLAUDE.md"), "# Claude Context\n").unwrap();
    std::fs::write(dir.join("TODO.md"), "# TODO\n").unwrap();

    let status = docs_status_at(dir);
    let row = |name: &str| status.iter().find(|s| s.name == name).cloned();
    assert_eq!(
        row("AGENTS.md"),
        Some(DocStatus { name: "AGENTS.md", state: DocState::Edited, nested_under: None, creatable: true })
    );
    assert_eq!(
        row("CLAUDE.md"),
        Some(DocStatus { name: "CLAUDE.md", state: DocState::Pointer, nested_under: Some("AGENTS.md"), creatable: false })
    );
    assert_eq!(row("TODO.md").unwrap().state, DocState::Template);
    // A ghost row: missing and creatable.
    assert_eq!(row("README.md").unwrap().state, DocState::Missing);
    assert!(row("README.md").unwrap().creatable);
    assert_eq!(row("PROJECT.md").unwrap().state, DocState::Missing);
    // Absent and not creatable: no row.
    assert!(row("GEMINI.md").is_none());
    assert!(row("REMARKS.md").is_none());

    let json = serde_json::to_value(&status[0]).unwrap();
    assert_eq!(json["nestedUnder"], serde_json::Value::Null);
    assert_eq!(json["state"], "edited");
    let pointer = serde_json::to_value(row("CLAUDE.md").unwrap()).unwrap();
    assert_eq!(pointer["nestedUnder"], "AGENTS.md");
    assert_eq!(pointer["state"], "pointer");
}

#[test]
fn missing_defaults_names_what_a_repair_would_create() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(missing_defaults_at(tmp.path()), ["AGENTS.md", "README.md"]);
    std::fs::write(tmp.path().join("README.md"), "").unwrap();
    assert_eq!(missing_defaults_at(tmp.path()), ["AGENTS.md"]);
    std::fs::write(tmp.path().join("AGENTS.md"), "# Agents\n").unwrap();
    assert!(missing_defaults_at(tmp.path()).is_empty(), "a template-state doc is not missing");
}
