//! The tracked-window registry the app keeps in managed state: every external
//! app window Tabtivity launched or adopted ([`TrackedWindow`]), the detached
//! sub-window bookkeeping, and the launch origins that say which windows a
//! project opened. Moved down from `commands::apps` (S5), which keeps the
//! launcher and the app commands and re-exports these names.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

// ── Types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackedWindow {
    pub id: String,
    pub exec: String,
    pub file: Option<String>,
    pub pid: u32,
    pub project_id: Option<String>,
    pub role: Option<String>,
    pub opened_at: f64,
    pub window_id: Option<u64>,
    #[serde(default = "default_window_origin")]
    pub origin: String,
    /// The opaque token this launch set as `TABTIVITY_LAUNCH_ID` in the app's
    /// environment (`commands::apps::new_launch_id`): every process the launch starts carries
    /// it, so the app is still found after its launcher exits. `None` for a
    /// window Tabtivity did not spawn a `Command` for. Never serialized — the
    /// frontend has no use for it.
    #[serde(default, skip_serializing)]
    pub launch_id: Option<String>,
}

/// One process of a launch family: pid plus start time, so a reused pid is
/// never taken for the member ([`crate::services::proc_table::start_time`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FamilyMember {
    pub pid: u32,
    pub start: u64,
}

/// What the registry knows about a marked launch beyond its
/// [`TrackedWindow`], keyed by the row's id in [`WindowRegistry::launches`].
/// In memory only.
#[derive(Debug, Clone, Default)]
pub struct LaunchTrack {
    /// The launcher's start time (clock ticks since boot): no process of the
    /// launch can have started before it. 0 = unknown, no floor.
    pub since: u64,
    /// The marked processes alive when the launcher exited — the launch
    /// *family*. `None` while the launcher runs (its exit watcher has not
    /// decided yet). From then on the row lives while any member does;
    /// marked processes started later (a Gradle daemon, an IDE terminal)
    /// never extend it.
    pub family: Option<Vec<FamilyMember>>,
    /// For an `ORIGIN_PROJECT_IDE` row: the IDE and the names its window may
    /// title the project with (`ide_detect::project_window_names`). A window
    /// is only resolved for such a row when it shows the project
    /// (`commands::apps::resolve_window_for_launch`); `None` resolves none.
    pub ide_project: Option<(crate::services::ide_detect::IdeId, Vec<String>)>,
}

/// A detached popout's last on-screen geometry in PHYSICAL desktop px (#42).
///
/// Captured by the project-switch path just BEFORE it hides an inactive
/// project's popout, and re-applied right after it re-shows it on switch-back —
/// `hide()`/`show()` lets the WM re-place the window (typically onto the primary
/// monitor), so switch-back must put it back explicitly or a multi-monitor
/// popout jumps to the wrong screen. Physical px are scale-invariant for
/// placement, so no per-monitor scale conversion is needed on re-apply.
/// Transient (not persisted): the *restart* path restores popouts from the
/// frontend's saved bounds instead.
///
/// Native Wayland has no position to capture, so a retired popout records the
/// screen it was on instead (`monitor`, GDK's own logical rect for it) and is
/// rebuilt onto that screen when its scope returns.
#[derive(Debug, Clone, Copy)]
pub struct DetachedBounds {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub monitor: Option<crate::services::window_state::MonitorRect>,
}

/// Called with the changed row's `project_id` whenever the registry mutates
/// outside a frontend-initiated command (a launched child exiting). Installed
/// once in `lib.rs` setup to emit `app-windows-changed`; `None` in tests and
/// AppHandle-free service paths, where the mutation simply goes unannounced.
pub type WindowsChangedNotifier = Arc<dyn Fn(Option<String>) + Send + Sync>;

#[derive(Default)]
pub struct WindowRegistry {
    pub windows: HashMap<String, TrackedWindow>,
    /// Launch bookkeeping of the rows that carry a `launch_id`, keyed by row
    /// id; an entry outliving its row is swept by `commands::apps::prune_dead_windows`.
    pub launches: HashMap<String, LaunchTrack>,
    pub notify: Option<WindowsChangedNotifier>,
    /// Detached-subwindow display numbers, keyed by the window's stable label.
    /// Assigned in `detach_subwindow` (lowest free positive int) so each popout's
    /// OS title reads "Tabtivity win-N", and freed on dock-back/close
    /// (`attach_subwindow`) and on any other window destruction (the
    /// `WindowEvent::Destroyed` hook in `lib.rs`) so numbers stay small and
    /// reuse freed slots — a lone popout is always "win-1".
    pub detached_seqs: HashMap<String, u32>,
    /// Last on-screen geometry of each detached popout, keyed by its stable label
    /// (see [`DetachedBounds`]). Written just before a switch-away hides the
    /// popout; read just after switch-back re-shows it, to restore its monitor.
    pub detached_bounds: HashMap<String, DetachedBounds>,
    /// Popouts that were minimized when a switch-away hid them, so the
    /// switch-back shows them minimized again instead of restoring them.
    pub detached_minimized: std::collections::HashSet<String>,
    /// Wayland popouts parked without unmapping their compositor-owned surfaces.
    /// Only the fallback now: a popout holding unsaved work (or one that never
    /// answered the retire request) is minimized instead of closed.
    pub detached_parking: crate::services::window_state::DetachedParking,
    /// Wayland retire bookkeeping (close on scope-out, respawn on scope-in).
    pub detached_retire: crate::services::window_state::DetachedRetire,
    /// Labels a `detach_subwindow` call is building right now. Reserved under
    /// this lock before `build()`, so a second call for the same label returns
    /// instead of racing the build — and a failed build releases only its own
    /// reservation, never a live window's entry.
    pub detached_building: std::collections::HashSet<String>,
    /// The tab scope the main window shows, as last told by
    /// `sync_detached_scope` (`None` until the first scope change). A popout
    /// built for another scope retires as soon as its build completes.
    pub detached_active_scope: Option<String>,
}

pub type WindowRegistryState = Arc<Mutex<WindowRegistry>>;

/// Opened from the side panel's file tree (or a viewer reached from it).
///
/// Renamed from `right_file_tree` along with the panel, which no value on disk
/// depends on: the registry is `WindowRegistry::default()`ed at every startup
/// (`lib.rs`) and the one persisted window record, [`schema::project::OpenApp`],
/// carries no origin — so the token only ever travels in memory and over IPC
/// between the two halves of one build. The one skew that exists is the ordinary
/// `src/` hot-reload one: a frontend sending the new spelling to a backend that
/// predates it leaves the window unrecognized (and so unparked on a project
/// switch) until `src-tauri/` is rebuilt.
pub const ORIGIN_SIDE_FILE_TREE: &str = "side_file_tree";
pub const ORIGIN_MIDDLE_FILE_BROWSER: &str = "middle_file_browser";
pub const ORIGIN_GLOBAL_APP: &str = "global_app";
pub const ORIGIN_MANUAL_LAUNCH: &str = "manual_launch";
pub const ORIGIN_RESTORED: &str = "restored";
/// Opened from the Downloads section below the file tree
/// (`DownloadsSection.tsx`).
pub const ORIGIN_DOWNLOADS: &str = "downloads";
/// Opened from the blob/file viewer's "open externally" affordance
/// (`ProjectBlobPane.tsx`).
pub const ORIGIN_BLOB_FILE_VIEWER: &str = "blob_file_viewer";
/// A tiling subwindow popped out into its own borderless Tauri WebviewWindow
/// (#42). Project-owned: it follows the same project-switch hide/show parking
/// path as the other project-owned window origins.
pub const ORIGIN_DETACHED_SUBWINDOW: &str = "detached_subwindow";
/// The project opened in the IDE its tree carries markers for ("Open in
/// <IDE>" on the pill / file-tree root menu — `commands::ide`). Project-owned:
/// listed in the Apps view and parked on project switch like a file opened
/// from the tree.
pub const ORIGIN_PROJECT_IDE: &str = "project_ide";

pub(crate) fn default_window_origin() -> String {
    ORIGIN_MANUAL_LAUNCH.to_string()
}

/// Origins that belong to a project's Apps view (and, together with
/// [`ORIGIN_DETACHED_SUBWINDOW`], to project-switch parking — see
/// `window_service::is_project_owned`). Global launches (`global_app`,
/// `manual_launch`) stay out: they are the machine's, not a project's.
pub fn is_project_opened_origin(origin: &str) -> bool {
    matches!(
        origin,
        ORIGIN_SIDE_FILE_TREE
            | ORIGIN_MIDDLE_FILE_BROWSER
            | ORIGIN_RESTORED
            | ORIGIN_DOWNLOADS
            | ORIGIN_BLOB_FILE_VIEWER
            | ORIGIN_PROJECT_IDE
    )
}

pub fn is_project_opened_window(window: &TrackedWindow) -> bool {
    is_project_opened_origin(&window.origin)
}

pub fn opened_windows_for_project<'a>(
    windows: impl Iterator<Item = &'a TrackedWindow>,
    project_id: Option<&str>,
) -> Vec<TrackedWindow> {
    windows
        .filter(|window| window.project_id.as_deref() == project_id)
        .filter(|window| is_project_opened_window(window))
        .cloned()
        .collect()
}
