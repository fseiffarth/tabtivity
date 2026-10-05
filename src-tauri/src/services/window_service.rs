use crate::brand::SLUG;
use std::collections::HashMap;

use crate::commands::apps::{TrackedWindow, ORIGIN_DETACHED_SUBWINDOW};
use crate::platform::WorkspaceBackend;
use crate::schema::session::WindowSession;
use crate::services::terminal_service::app_sessions_dir;
use crate::storage;

/// Physical monitor rects as reported by a live window (#42), for validating a
/// detached popout's restore geometry on switch-back. Mirrors the mapping
/// `lib.rs` uses at startup for the main window.
pub fn monitor_rects(
    win: &tauri::WebviewWindow,
) -> Vec<crate::services::window_state::MonitorRect> {
    win.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| crate::services::window_state::MonitorRect {
            x: m.position().x,
            y: m.position().y,
            w: m.size().width,
            h: m.size().height,
        })
        .collect()
}

/// The Tauri label of Tabtivity's primary window (`tauri.conf.json`).
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Labels of the windows that must be torn down when the MAIN window closes.
///
/// Every secondary window Tabtivity opens — a detached popout (`detached-*`), the
/// deck presenter (`present-*`), a live browser page (`browser-*`) — is a
/// SIBLING of the main window in the same process, not a child of it: neither
/// the OS nor Tauri closes it when `main` goes away. Left alone it strands on
/// screen *and* keeps the process alive, because Tauri only exits once the LAST
/// window is gone — so quitting Tabtivity would leave an unreachable popout and a
/// live headless app behind it. The main window's own close path
/// (`shutdownDetachedWindows` in the shell) already does this for popouts it
/// still tracks, and does it *before* `destroy()` so bounds reach project.json;
/// this is the choke point behind it, catching the windows that path misses
/// (presenter/browser windows, a popout the store lost track of) and the case
/// where it never ran at all (a hung or crashed renderer, a WM kill).
///
/// Pure over its input so the "everything but `main`" rule is unit-tested; the
/// caller does the destroying. Order is stable (sorted) for the same reason.
pub fn windows_closed_with_main<'a>(labels: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = labels
        .into_iter()
        .filter(|l| *l != MAIN_WINDOW_LABEL)
        .map(String::from)
        .collect();
    out.sort();
    out
}

pub fn hide_windows(backend: &dyn WorkspaceBackend, window_ids: &[u64]) {
    for &wid in window_ids {
        if let Err(e) = backend.hide_window(wid) {
            eprintln!("WindowService: hide {wid}: {e}");
        }
    }
}

pub fn show_windows(backend: &dyn WorkspaceBackend, window_ids: &[u64]) {
    for &wid in window_ids {
        if let Err(e) = backend.show_window(wid) {
            eprintln!("WindowService: show {wid}: {e}");
        }
    }
}

/// X11/compositor window IDs for project-owned windows in the given scope.
pub fn project_window_ids(
    windows: &HashMap<String, TrackedWindow>,
    project_id: Option<&str>,
) -> Vec<u64> {
    project_owned_windows(windows, project_id)
        .filter_map(|w| w.window_id)
        .collect()
}

/// Tauri window labels of every live popout, split into (this scope's,
/// everyone else's) (#42).
///
/// The detached window's registry key IS its Tauri label, so callers can
/// `app.get_webview_window(label)` to drive a Tauri-level `hide()`/`show()`.
/// This runs REGARDLESS of the workspace backend: on X11 the desktop-park
/// (via `hide_window`) and this Tauri hide both apply; on Wayland/KDE/null —
/// where desktop-parking is a no-op — the Tauri hide is the ONLY mechanism that
/// keeps an inactive scope's detached window from floating over every other one.
///
/// Popouts are keyed by TAB SCOPE, not by project: `detach_subwindow` registers
/// each under the scope its group belonged to — a project id, `"root"`, or
/// `box:<id>` — in the registry's `project_id` field. Deriving visibility from
/// the ACTIVE SCOPE rather than from a project switch's `project_id` is what
/// makes the non-project scopes work: entering a box changes the scope without
/// any project switch at all, and the root scope is one no `project_id` can name
/// (it is `None` there, while its popouts are registered under `"root"`), so both
/// used to leave the outgoing scope's popout floating over the new one.
pub fn detached_labels_by_scope(
    windows: &HashMap<String, TrackedWindow>,
    scope: &str,
) -> (Vec<String>, Vec<String>) {
    let (mut mine, mut others) = (Vec::new(), Vec::new());
    for w in windows
        .values()
        .filter(|w| w.origin == ORIGIN_DETACHED_SUBWINDOW)
    {
        if w.project_id.as_deref() == Some(scope) {
            mine.push(w.id.clone());
        } else {
            others.push(w.id.clone());
        }
    }
    mine.sort();
    others.sort();
    (mine, others)
}

/// Registry keys for EVERY live detached popout, whatever project owns it —
/// what the monitor-arrangement watcher (#240) iterates when a display is
/// plugged in or unplugged, since that event has nothing to do with which
/// project is active. Sorted so the order is stable.
pub fn all_detached_labels(windows: &HashMap<String, TrackedWindow>) -> Vec<String> {
    let mut out: Vec<String> = windows
        .values()
        .filter(|w| w.origin == ORIGIN_DETACHED_SUBWINDOW)
        .map(|w| w.id.clone())
        .collect();
    out.sort();
    out
}

/// Registry keys for all project-owned tracked windows in the given scope.
pub fn project_tracked_ids(
    windows: &HashMap<String, TrackedWindow>,
    project_id: Option<&str>,
) -> Vec<String> {
    project_owned_windows(windows, project_id)
        .map(|w| w.id.clone())
        .collect()
}

/// Persist the project-owned window registry IDs to `.tabtivity/sessions/windows.json`.
pub fn save_window_session(local_file: &str, registry_ids: &[String]) {
    if let Some(sessions_dir) = app_sessions_dir(local_file) {
        let session = WindowSession {
            project_window_ids: registry_ids.to_vec(),
            extra: Default::default(),
        };
        if let Err(e) = storage::write_json(&sessions_dir.join("windows.json"), &session) {
            eprintln!("WindowService: write .{SLUG} session: {e}");
        }
    }
}

/// Load the window session from `.tabtivity/sessions/windows.json`.
/// Returns an empty session if the file is absent or unreadable.
pub fn load_window_session(local_file: &str) -> WindowSession {
    if let Some(sessions_dir) = app_sessions_dir(local_file) {
        let path = sessions_dir.join("windows.json");
        if path.exists() {
            if let Ok(session) = storage::read_json::<WindowSession>(&path) {
                return session;
            }
        }
    }
    WindowSession::default()
}

/// Back-populate `window_id` for project-owned windows whose id was never
/// resolved at launch time. For each window matching `project_id` that is
/// project-owned and currently has no `window_id`, call `resolve(pid)` and store
/// the result. Used on Windows just before the project-switch hide so a
/// launch-time miss (the visible top-level belonging to a child of the spawned
/// pid, or a cold-start race) is no longer permanent — the resolved id then
/// flows through the unchanged id-based hide AND switch-back show paths.
///
/// Pure over its inputs (the resolver is injected), so it is unit-tested with a
/// fake resolver on any OS. Only the `None`-id case is touched, so windows that
/// already resolved their id are left exactly as-is.
///
/// Detached subwindows (#42) are deliberately EXCLUDED even though they are
/// project-owned: they carry Tabtivity's OWN pid (subwindow.rs), so resolving by
/// pid here could match an arbitrary Tabtivity-owned top-level (the main window or
/// another detached window) and back-populate the wrong HWND. They resolve their
/// own id by Tauri label and park via the separate `hide()`/`show()` path
/// (project_runtime steps 5b/8b), so they never need — and must not undergo —
/// pid-based re-resolution. This keeps the never-touch-the-wrong-Tabtivity-window
/// invariant structural rather than reliant on label resolution always succeeding.
pub fn resolve_missing_window_ids(
    windows: &mut HashMap<String, TrackedWindow>,
    project_id: Option<&str>,
    resolve: impl Fn(u32) -> Option<u64>,
) {
    for w in windows.values_mut() {
        if w.project_id.as_deref() == project_id
            && is_project_owned(&w.origin)
            && w.origin != ORIGIN_DETACHED_SUBWINDOW
            && w.window_id.is_none()
        {
            w.window_id = resolve(w.pid);
        }
    }
}

/// Everything the Apps view lists (`is_project_opened_origin`) parks on a
/// project switch, plus detached subwindows — which park but are never listed
/// (they are Tabtivity's own windows, not launched apps).
fn is_project_owned(origin: &str) -> bool {
    crate::commands::apps::is_project_opened_origin(origin) || origin == ORIGIN_DETACHED_SUBWINDOW
}

fn project_owned_windows<'a, 'b>(
    windows: &'a HashMap<String, TrackedWindow>,
    project_id: Option<&'b str>,
) -> impl Iterator<Item = &'a TrackedWindow> + use<'a, 'b> {
    windows
        .values()
        .filter(move |w| w.project_id.as_deref() == project_id)
        .filter(|w| is_project_owned(&w.origin))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::apps::{
        ORIGIN_DETACHED_SUBWINDOW, ORIGIN_GLOBAL_APP, ORIGIN_SIDE_FILE_TREE,
    };

    fn tracked(id: &str, project: Option<&str>, origin: &str, wid: Option<u64>) -> TrackedWindow {
        TrackedWindow {
            id: id.to_string(),
            exec: "x".into(),
            file: None,
            pid: 1,
            project_id: project.map(String::from),
            role: None,
            opened_at: 0.0,
            window_id: wid,
            origin: origin.to_string(),
        }
    }

    fn registry(wins: Vec<TrackedWindow>) -> HashMap<String, TrackedWindow> {
        wins.into_iter().map(|w| (w.id.clone(), w)).collect()
    }

    #[test]
    fn closing_main_takes_every_other_app_window_with_it() {
        // Popouts, the presenter and live browser pages are siblings of `main`,
        // so all three must be in the teardown set — and `main` itself never is
        // (it is already gone by the time this runs).
        let labels = [
            "main",
            "detached-p1-g1",
            "detached-p2-g3",
            "present-deck-1",
            "browser-2",
        ];
        assert_eq!(
            windows_closed_with_main(labels),
            vec![
                "browser-2".to_string(),
                "detached-p1-g1".to_string(),
                "detached-p2-g3".to_string(),
                "present-deck-1".to_string(),
            ],
        );
        // A lone main window leaves nothing to close.
        assert!(windows_closed_with_main(["main"]).is_empty());
        assert!(windows_closed_with_main([]).is_empty());
    }

    #[test]
    fn detached_subwindow_origin_is_project_owned() {
        assert!(is_project_owned(ORIGIN_DETACHED_SUBWINDOW));
        assert!(is_project_owned(ORIGIN_SIDE_FILE_TREE));
        assert!(!is_project_owned(ORIGIN_GLOBAL_APP));
    }

    #[test]
    fn apps_view_origins_all_park_on_project_switch() {
        // The parking set is the Apps-view set plus detached subwindows, so
        // everything the view lists is hidden/shown with its project.
        use crate::commands::apps::{
            ORIGIN_BLOB_FILE_VIEWER, ORIGIN_DOWNLOADS, ORIGIN_MANUAL_LAUNCH,
            ORIGIN_MIDDLE_FILE_BROWSER, ORIGIN_RESTORED,
        };
        for origin in [
            ORIGIN_SIDE_FILE_TREE,
            ORIGIN_MIDDLE_FILE_BROWSER,
            ORIGIN_RESTORED,
            ORIGIN_DOWNLOADS,
            ORIGIN_BLOB_FILE_VIEWER,
            ORIGIN_DETACHED_SUBWINDOW,
        ] {
            assert!(is_project_owned(origin), "{origin} must park");
        }
        for origin in [ORIGIN_GLOBAL_APP, ORIGIN_MANUAL_LAUNCH] {
            assert!(!is_project_owned(origin), "{origin} must not park");
        }
    }

    #[test]
    fn detached_window_is_in_its_project_hide_set_only() {
        let wins = registry(vec![
            tracked("d1", Some("p1"), ORIGIN_DETACHED_SUBWINDOW, Some(101)),
            tracked("d2", Some("p2"), ORIGIN_DETACHED_SUBWINDOW, Some(202)),
            tracked("g1", Some("p1"), ORIGIN_GLOBAL_APP, Some(303)),
        ]);
        let p1_ids = project_window_ids(&wins, Some("p1"));
        assert!(
            p1_ids.contains(&101),
            "p1's detached window is hidden with p1"
        );
        assert!(!p1_ids.contains(&202), "p2's detached window is not p1's");
        assert!(
            !p1_ids.contains(&303),
            "a global app is not project-owned, so it is not parked on switch"
        );
        let p2_ids = project_window_ids(&wins, Some("p2"));
        assert_eq!(p2_ids, vec![202]);
    }

    #[test]
    fn detached_window_registry_id_is_tracked_for_persistence() {
        let wins = registry(vec![tracked(
            "detached-p1-g3",
            Some("p1"),
            ORIGIN_DETACHED_SUBWINDOW,
            Some(101),
        )]);
        let ids = project_tracked_ids(&wins, Some("p1"));
        assert_eq!(ids, vec!["detached-p1-g3".to_string()]);
    }

    #[test]
    fn resolve_missing_window_ids_back_populates_only_unresolved_project_owned() {
        let mut wins = registry(vec![
            tracked("a", Some("p1"), ORIGIN_SIDE_FILE_TREE, None), // pid 10
            tracked("b", Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(5)), // pid 11
            tracked("c", Some("p1"), ORIGIN_GLOBAL_APP, None),      // pid 12
            tracked("d", Some("p2"), ORIGIN_SIDE_FILE_TREE, None), // pid 13
        ]);
        // Give each a distinct pid so the fake resolver can be asserted per-window.
        wins.get_mut("a").unwrap().pid = 10;
        wins.get_mut("b").unwrap().pid = 11;
        wins.get_mut("c").unwrap().pid = 12;
        wins.get_mut("d").unwrap().pid = 13;

        resolve_missing_window_ids(&mut wins, Some("p1"), |pid| Some(pid as u64 * 100));

        // (a) unresolved + project-owned + this project → back-populated.
        assert_eq!(wins["a"].window_id, Some(1000));
        // (b) already resolved → left untouched (not overwritten).
        assert_eq!(wins["b"].window_id, Some(5));
        // (c) global app is not project-owned → never resolved.
        assert_eq!(wins["c"].window_id, None);
        // (d) different project → out of scope.
        assert_eq!(wins["d"].window_id, None);
    }

    #[test]
    fn resolve_missing_window_ids_leaves_none_when_resolver_fails() {
        let mut wins = registry(vec![tracked("a", Some("p1"), ORIGIN_SIDE_FILE_TREE, None)]);
        // A window the OS could not map (e.g. opener::open pid=0) stays unparked.
        resolve_missing_window_ids(&mut wins, Some("p1"), |_pid| None);
        assert_eq!(wins["a"].window_id, None);
    }

    #[test]
    fn resolve_missing_window_ids_never_touches_detached_subwindows() {
        // Detached subwindows carry Tabtivity's OWN pid, so pid-based resolution
        // could match an arbitrary Tabtivity top-level. They must be excluded from
        // re-resolution even though they are project-owned (they park via the
        // Tauri label path instead). A resolver that would resolve anything must
        // still leave a None-id detached window untouched.
        let mut wins = registry(vec![tracked(
            "detached-p1-g1",
            Some("p1"),
            ORIGIN_DETACHED_SUBWINDOW,
            None,
        )]);
        resolve_missing_window_ids(&mut wins, Some("p1"), |pid| Some(pid as u64 * 100));
        assert_eq!(
            wins["detached-p1-g1"].window_id, None,
            "a detached subwindow must never be pid-resolved at hide time"
        );
    }

    #[test]
    fn detached_labels_split_by_scope() {
        // #42: the Wayland/null fallback hides/shows detached windows by Tauri
        // LABEL (== registry id). The active scope's popouts are shown, EVERY
        // other popout is hidden, and non-detached project-owned windows (which
        // go through the X11/desktop path) appear in neither list.
        let wins = registry(vec![
            tracked(
                "detached-p1-g3",
                Some("p1"),
                ORIGIN_DETACHED_SUBWINDOW,
                Some(101),
            ),
            tracked(
                "detached-p2-g1",
                Some("p2"),
                ORIGIN_DETACHED_SUBWINDOW,
                Some(202),
            ),
            tracked("file-p1", Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(303)),
        ]);
        let (mine, others) = detached_labels_by_scope(&wins, "p1");
        assert_eq!(mine, vec!["detached-p1-g3".to_string()]);
        assert_eq!(others, vec!["detached-p2-g1".to_string()]);
        let (mine, others) = detached_labels_by_scope(&wins, "p2");
        assert_eq!(mine, vec!["detached-p2-g1".to_string()]);
        assert_eq!(others, vec!["detached-p1-g3".to_string()]);
        // A detached window with no resolved X11 id is STILL hidden via Tauri
        // (its label exists regardless of `window_id`).
        let no_wid = registry(vec![tracked(
            "detached-p3-g1",
            Some("p3"),
            ORIGIN_DETACHED_SUBWINDOW,
            None,
        )]);
        assert_eq!(
            detached_labels_by_scope(&no_wid, "p3").0,
            vec!["detached-p3-g1".to_string()],
        );
    }

    #[test]
    fn detached_labels_hide_project_popouts_in_a_box_or_root_scope() {
        // The reported bug: a project's popout stayed floating after entering a
        // `box:<id>` scope, because the only hide path keyed off a project
        // switch's `project_id` and entering a box performs none. Scope-keyed,
        // a box scope shows its own popouts and hides every project's — and the
        // root scope (whose popouts register under "root", never `None`) does
        // the same.
        let wins = registry(vec![
            tracked(
                "detached-p1-g1",
                Some("p1"),
                ORIGIN_DETACHED_SUBWINDOW,
                Some(101),
            ),
            tracked(
                "detached-box:b7-g1",
                Some("box:b7"),
                ORIGIN_DETACHED_SUBWINDOW,
                Some(202),
            ),
            tracked(
                "detached-root-g1",
                Some("root"),
                ORIGIN_DETACHED_SUBWINDOW,
                Some(303),
            ),
        ]);
        let (mine, others) = detached_labels_by_scope(&wins, "box:b7");
        assert_eq!(mine, vec!["detached-box:b7-g1".to_string()]);
        assert_eq!(
            others,
            vec![
                "detached-p1-g1".to_string(),
                "detached-root-g1".to_string()
            ],
        );
        let (mine, others) = detached_labels_by_scope(&wins, "root");
        assert_eq!(mine, vec!["detached-root-g1".to_string()]);
        assert_eq!(
            others,
            vec![
                "detached-box:b7-g1".to_string(),
                "detached-p1-g1".to_string()
            ],
        );
    }

    #[test]
    fn all_detached_labels_spans_every_project() {
        // #240: unplugging a monitor strands popouts regardless of which project
        // owns them, so the watcher must see them all — and nothing else.
        let wins = registry(vec![
            tracked(
                "detached-p2-g1",
                Some("p2"),
                ORIGIN_DETACHED_SUBWINDOW,
                Some(202),
            ),
            tracked(
                "detached-p1-g3",
                Some("p1"),
                ORIGIN_DETACHED_SUBWINDOW,
                Some(101),
            ),
            tracked("file-p1", Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(303)),
        ]);
        assert_eq!(
            all_detached_labels(&wins),
            vec![
                "detached-p1-g3".to_string(),
                "detached-p2-g1".to_string(),
            ],
            "both popouts, sorted, and no side file tree",
        );
        assert!(all_detached_labels(&registry(vec![])).is_empty());
    }
}
