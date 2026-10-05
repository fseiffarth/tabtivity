//! Tests for the file→tab frameless embed capability layer (TODO Group K #40,
//! Phase 1). Covers `resolve_default_handler` precedence, the `EMBEDDABLE_EXECS`
//! allowlist, and `supports_embedding()` per backend.
//!
//! `resolve_default_handler`'s mime fallback shells out to `xdg-mime`; these
//! tests exercise the pure precedence paths (handler / project / global) so they
//! never depend on the host's mime database.

use std::collections::HashMap;

use app_lib::commands::apps::{is_embeddable_exec, resolve_default_handler, EMBEDDABLE_EXECS};
use app_lib::platform::null::NullBackend;
use app_lib::platform::WorkspaceBackend;

fn apps(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

// ── resolve_default_handler precedence ──────────────────────────────────────

#[test]
fn explicit_handler_wins_over_everything() {
    let project = apps(&[(".md", "kate")]);
    let global = apps(&[(".md", "gedit")]);
    let resolved =
        resolve_default_handler("/tmp/notes.md", Some("mousepad"), Some(&project), &global);
    assert_eq!(resolved.as_deref(), Some("mousepad"));
}

#[test]
fn blank_handler_is_ignored_and_falls_through() {
    let global = apps(&[(".md", "mousepad")]);
    let resolved = resolve_default_handler("/tmp/notes.md", Some("   "), None, &global);
    assert_eq!(resolved.as_deref(), Some("mousepad"));
}

#[test]
fn project_default_takes_precedence_over_global() {
    let project = apps(&[(".md", "okular")]);
    let global = apps(&[(".md", "evince")]);
    let resolved = resolve_default_handler("/tmp/notes.md", None, Some(&project), &global);
    assert_eq!(resolved.as_deref(), Some("okular"));
}

#[test]
fn global_default_used_when_no_project_entry() {
    let project = apps(&[(".pdf", "okular")]);
    let global = apps(&[(".md", "mousepad")]);
    let resolved = resolve_default_handler("/tmp/notes.md", None, Some(&project), &global);
    assert_eq!(resolved.as_deref(), Some("mousepad"));
}

#[test]
fn extension_match_is_case_insensitive() {
    let global = apps(&[(".md", "mousepad")]);
    let resolved = resolve_default_handler("/tmp/README.MD", None, None, &global);
    assert_eq!(resolved.as_deref(), Some("mousepad"));
}

#[test]
fn empty_app_value_is_skipped() {
    // An empty mapping value must not resolve to "" — fall through to global.
    let project = apps(&[(".md", "")]);
    let global = apps(&[(".md", "feh")]);
    let resolved = resolve_default_handler("/tmp/x.md", None, Some(&project), &global);
    assert_eq!(resolved.as_deref(), Some("feh"));
}

// ── EMBEDDABLE_EXECS membership ─────────────────────────────────────────────

#[test]
fn allowlist_contains_expected_apps_and_excludes_fork_and_exit() {
    for app in [
        "xterm", "xev", "mousepad", "okular", "evince", "eog", "feh", "mpv", "qpdfview",
        // Added by explicit request despite single-instance behavior (see the
        // EMBEDDABLE_EXECS doc comment).
        "gedit", "code",
    ] {
        assert!(
            EMBEDDABLE_EXECS.contains(&app),
            "{app} should be embeddable"
        );
    }
    // Single-instance D-Bus / fork-and-exit editors that remain excluded.
    for app in ["kate", "gnome-text-editor", "firefox"] {
        assert!(!EMBEDDABLE_EXECS.contains(&app), "{app} must be excluded");
    }
}

#[test]
fn is_embeddable_exec_matches_by_basename() {
    assert!(is_embeddable_exec("mousepad"));
    assert!(is_embeddable_exec("/usr/bin/mousepad"));
    assert!(is_embeddable_exec("/usr/local/bin/MPV")); // case-insensitive
    assert!(is_embeddable_exec("gedit"));
    assert!(is_embeddable_exec("/usr/bin/code"));
    assert!(!is_embeddable_exec("kate"));
}

// ── supports_embedding() per backend ────────────────────────────────────────

#[test]
fn null_backend_does_not_support_embedding() {
    assert!(!NullBackend.supports_embedding());
}

#[test]
fn null_backend_via_trait_object_does_not_support_embedding() {
    let b: Box<dyn WorkspaceBackend> = Box::new(NullBackend);
    assert!(!b.supports_embedding());
}

#[cfg(target_os = "linux")]
#[test]
fn x11_backend_supports_embedding_when_available() {
    // X11Backend::try_new requires a live X server; only assert when present so
    // the test is robust on headless CI. The trait default (false) is covered by
    // the null tests above; this confirms X11's override is true.
    use app_lib::platform::x11::X11Backend;
    if let Ok(backend) = X11Backend::try_new() {
        assert!(backend.supports_embedding());
    }
}
