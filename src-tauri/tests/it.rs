//! The integration tests' one binary: every `tests/*.rs` is a module here, so
//! the library and its dependencies are linked once, not once per file
//! (`autotests = false` and the `[[test]]` rows in `Cargo.toml`). Two files
//! stay binaries of their own:
//! * `server_secrets.rs` — CI and AGENTS.md build it alone for the daemon,
//!   `--no-default-features --test server_secrets`;
//! * `projects_commands.rs` — it points `HOME` (and `APPDATA`) at a temp home
//!   per test, which in this process would move every other module's home
//!   and state dir under it mid-test.
//!
//! A test's name now starts with its file's: `cargo test --test it
//! schema_roundtrip::`. All modules share one process and run on parallel
//! threads, so process state is shared: a test that needs the state dir
//! somewhere uses [`isolated_state_dir`], never a `set_var` of its own.
//! `every_test_file_is_built` fails on a `tests/*.rs` nothing builds.

mod capability_scope;
mod embed_capability_tests;
mod file_ops_tests;
mod mail_hostile_crypto;
mod mail_hostile_message;
mod no_foreign_config_writes;
mod project_tree_intent;
mod schema_edge_cases;
mod schema_roundtrip;
mod services_tests;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Points `storage::state_dir()` at a temp directory, once for the whole
/// binary, and returns it. Set once and never changed, so the parallel test
/// threads all agree on it; nothing else here sets the variable. Tests write
/// per-project session state there, and a suite writing into the developer's
/// real state dir would clobber their running workspace.
pub fn isolated_state_dir() -> &'static Path {
    static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    DIR.get_or_init(|| {
        let tmp = tempfile::TempDir::new().expect("temp state dir");
        std::env::set_var(app_lib::app_env!("STATE_DIR"), tmp.path());
        tmp
    })
    .path()
}

/// With `autotests = false`, a new `tests/*.rs` builds only if this file names
/// it as a module or `Cargo.toml` gives it a `[[test]]` row; otherwise its
/// tests silently never run.
#[test]
fn every_test_file_is_built() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let this = include_str!("it.rs");
    let manifest = std::fs::read_to_string(dir.join("Cargo.toml")).expect("read Cargo.toml");
    let mut orphans = Vec::new();
    for entry in std::fs::read_dir(dir.join("tests")).expect("read tests/") {
        let path = entry.expect("tests/ entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let file = path.file_name().and_then(|n| n.to_str()).expect("utf-8 name").to_string();
        let stem = file.trim_end_matches(".rs");
        let as_module = this.lines().any(|l| l.trim() == format!("mod {stem};"));
        let as_target = manifest.contains(&format!("path = \"tests/{file}\""));
        if !as_module && !as_target {
            orphans.push(file);
        }
    }
    assert!(
        orphans.is_empty(),
        "tests/ files no test target builds (add `mod <name>;` to tests/it.rs): {orphans:?}"
    );
}
