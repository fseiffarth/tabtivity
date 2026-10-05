//! Tripwire: **nothing may read executable intent out of the project tree.**
//!
//! `docs/sandbox_hardening_plan.md` Phase 1d. The audit found the same bug twice
//! for the same reason: Tabtivity's own control files live inside the project
//! container's writable mount (and inside any repository that gets cloned or
//! imported as a project), while the host reads them back as commands to run —
//! `project.json`'s `open_apps` became a host-side `spawn_reaped` on every
//! activation, and the persisted layout's `cmd`/`args`/`env`/`location` became a
//! `pty_spawn`. Both were fixed with validators, and a validator list can never be
//! shown to be complete. Phase 1 replaced them with a structural property: the
//! state moved to `<state_dir>/sessions/<project id>/`, which no container mounts.
//!
//! A structural property is only worth more than the validators it replaced if it
//! is *checkable*. This is that check. Until it existed the rule was unwritten,
//! and an unwritten rule is what was forgotten twice.
//!
//! ## What it enforces
//!
//! Outside the files that *define* these fields, any source line naming one of
//! them must be one of:
//!
//!   - a **clear** (`= None`) or an absence assertion (`.is_none()`) — neither can
//!     execute anything;
//!   - a line covered by the marker [`ALLOW_MARKER`] — on the line itself, or
//!     anywhere in the paragraph above it (up to the nearest blank line), with a
//!     reason. That is the deliberate escape hatch: `TerminalSession` and
//!     the frontend's project-switch snapshot have identically-named fields and
//!     are read all over, and a textual check cannot tell one type from another.
//!
//! So the marker is what a reviewer looks for. Adding one is cheap; adding one
//! that says "read from project.json" is the thing this test exists to make
//! impossible to do by accident.

use std::path::{Path, PathBuf};

/// The `Project` fields the host reads back as something to execute.
const INTENT_FIELDS: &[&str] = &[
    ".tab_layout",
    ".tab_groups",
    ".open_tab_sessions",
    ".open_apps",
];

/// Files that define or own these fields, where naming them is the point.
const DEFINING_FILES: &[&str] = &[
    // The `Project` struct itself.
    "schema/project.rs",
    // The `TerminalSession` struct — the state-dir replacement.
    "schema/session.rs",
    // The migration shim and the adopt path: the *only* code allowed to read the
    // project-tree copy at all, and both sanitize what they read.
    "services/terminal_service.rs",
    // The shared tab set's owner (headless owner plan, H1): it reads and writes
    // the state-dir session by project id and never a project tree.
    "services/workspace.rs",
];

/// Put this on (or directly above) a line that names an intent field for a reason
/// other than clearing it, and say why.
const ALLOW_MARKER: &str = "project-tree-read: ok";

fn src_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Whether a line is a comment (or the body of a block/doc comment). Crude on
/// purpose: it only has to keep prose about these fields from tripping the check,
/// and prose about them is exactly what this module is full of.
fn is_comment(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("//") || t.starts_with("*") || t.starts_with("/*")
}

/// Whether this line only *clears* or *asserts the absence of* a field.
fn is_clear_or_absence(line: &str, field: &str) -> bool {
    let name = &field[1..];
    line.contains(&format!("{field} = None"))
        || line.contains(&format!("{field}.is_none()"))
        // A struct literal that sets the field to None, e.g. `open_apps: None,`.
        || line.trim_start().starts_with(&format!("{name}: None"))
}

/// Whether a marker above line `i` covers it.
///
/// **A marker's scope is its paragraph**: everything from it down to the next
/// blank line. That is what makes it usable — one justification covers the whole
/// statement it explains, including a multi-line call whose second argument also
/// names a field, and a reason worth writing down is rarely one line long. A blank
/// line ends the scope, so the next statement has to justify itself again.
fn marker_covers(lines: &[&str], i: usize) -> bool {
    let mut j = i;
    while j > 0 {
        j -= 1;
        if lines[j].trim().is_empty() {
            return false;
        }
        if lines[j].contains(ALLOW_MARKER) {
            return true;
        }
    }
    false
}

#[test]
fn no_executable_intent_is_read_from_the_project_tree() {
    let root = src_root();
    let mut files = Vec::new();
    rust_files(&root, &mut files);
    assert!(!files.is_empty(), "found no backend sources to scan");

    let mut offenders: Vec<String> = Vec::new();

    for file in &files {
        let rel = file
            .strip_prefix(&root)
            .unwrap_or(file)
            .to_string_lossy()
            .replace('\\', "/");
        if DEFINING_FILES.iter().any(|f| rel == *f) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if is_comment(line) {
                continue;
            }
            for field in INTENT_FIELDS {
                if !line.contains(field) {
                    continue;
                }
                if is_clear_or_absence(line, field) {
                    continue;
                }
                let marked = line.contains(ALLOW_MARKER) || marker_covers(&lines, i);
                if !marked {
                    offenders.push(format!("{rel}:{}: {}", i + 1, line.trim()));
                }
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "\n{} line(s) read a project-tree control field with no `{ALLOW_MARKER}` marker.\n\n\
         These fields live in `project.json`, which sits inside the project container's\n\
         writable rw mount and inside any cloned/imported repository — and the host reads\n\
         them back as things to execute (an app to launch, a tab's cmd/env/cwd). The state\n\
         moved to `<state_dir>/sessions/<project id>/`; read it from there via\n\
         `services::terminal_service`, keyed by PROJECT ID rather than by a path.\n\n\
         If the receiver here is a `TerminalSession` or the frontend's switch snapshot\n\
         (same field names, different type), add `// {ALLOW_MARKER} — <reason>` on the line\n\
         or the one above.\n\n{}\n",
        offenders.len(),
        offenders.join("\n"),
    );
}

/// The companion half: the invariant is only real if the *replacement* is where it
/// claims to be. A per-project session path must be under the state dir and must
/// reduce the project id to a single component.
#[test]
fn the_session_dir_is_in_the_state_dir_and_is_one_component_deep() {
    let tmp = tempfile::TempDir::new().unwrap();
    std::env::set_var(app_lib::app_env!("STATE_DIR"), tmp.path());

    let state = app_lib::storage::state_dir();
    for id in [
        "plain-id",
        "../../etc",
        "a/b/c",
        "..",
        "with spaces",
        "",
        "unicode-é",
    ] {
        let dir = app_lib::storage::project_session_dir(id);
        assert!(
            dir.starts_with(&state),
            "session dir for {id:?} escaped the state dir: {dir:?}"
        );
        assert_eq!(
            dir.strip_prefix(state.join("sessions"))
                .unwrap()
                .components()
                .count(),
            1,
            "session dir for {id:?} must be exactly one component under sessions/: {dir:?}"
        );
    }
}
