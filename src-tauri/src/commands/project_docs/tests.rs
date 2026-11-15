use super::*;

/// The name is checked against the catalog before any project is looked up:
/// no path, unknown name, pointer file or `REMARKS.md` reaches the disk.
#[test]
fn a_create_only_takes_a_creatable_catalog_name() {
    for name in [
        "",
        "nope.md",
        "../AGENTS.md",
        "sub/TODO.md",
        "sub\\TODO.md",
        "/etc/passwd",
        "todo.md",
        "TODO.md ",
        ".gitignore",
        "CLAUDE.md",
        "GEMINI.md",
        "REMARKS.md",
    ] {
        let err = create_project_doc_blocking("no-such-project", name).unwrap_err();
        assert!(err.contains("not a doc that can be created"), "{name:?}: {err}");
    }
}

/// The commands hand their work to a worker: each is `async` over a
/// `*_blocking` body (the project tree and the agent home are read).
#[test]
fn every_command_is_async_over_a_blocking_body() {
    let src = include_str!("../project_docs.rs");
    let body = src.split("#[cfg(test)]").next().unwrap();
    for name in ["project_docs_status", "create_project_doc", "project_agent_memory", "project_agent_memory_read"] {
        assert!(body.contains(&format!("pub async fn {name}(")), "{name} is async");
        assert!(body.contains(&format!("fn {name}_blocking(")), "{name} has a blocking body");
    }
    assert!(!body.contains("AppHandle"));
    assert!(!body.contains("use tauri"));
}
