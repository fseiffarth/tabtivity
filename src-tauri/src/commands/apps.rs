//! External app launching and window tracking.
//!
//! Tabtivity's X11 window embedding model is intentionally dropped in the Tauri
//! rewrite (fundamentally incompatible with the WebView). Instead, external
//! apps are tracked by PID and launched/raised as separate windows.
//! `project.json["open_apps"]` is preserved for backward compatibility but
//! treated as best-effort restore metadata.
//!
//! ## Per-OS backends (TODO 30d)
//!
//! App discovery, icon resolution and launching are inherently OS-specific, so
//! the platform-divergent pieces are gated behind `cfg`:
//! - **Linux** uses the freedesktop/XDG model: it scans `.desktop` entries under
//!   `$XDG_DATA_HOME/applications` and every `$XDG_DATA_DIRS` entry's
//!   `applications` dir (see [`xdg_application_dirs`]) — which, since desktop
//!   sessions add Flatpak/Snap export paths to `XDG_DATA_DIRS`, is what makes
//!   apps installed that way discoverable too — resolves icons through the
//!   icon-theme directories, and launches the `Exec=` line. Multi-word `Exec=`
//!   values (Flatpak's `flatpak run --branch=... app.id`) are preserved in full
//!   by [`parse_exec_command`] and shell-split back into program+args at launch
//!   time by [`split_exec_command`], rather than truncated to their first token.
//! - **Windows** has no XDG layer, so [`list_installed_apps`] instead enumerates
//!   Start-Menu `.lnk` shortcuts under `%ProgramData%`/`%APPDATA%`, reading each
//!   shortcut's display name and resolving its target executable via
//!   `IShellLinkW` (see [`windows_shortcuts`]). Launching resolves a bare app
//!   name or `.lnk` back to that target exe ([`resolve_windows_launch_exec`]) and
//!   spawns it; [`run_script_detached`] runs scripts through `cmd`/PowerShell
//!   rather than `bash`. Icons are best-effort: a `.png`/`.ico` referenced by the
//!   shortcut is inlined as a data URL, otherwise the target path is returned for
//!   the frontend to resolve lazily (no native HICON rasterization — that would
//!   need GDI, which is out of scope here).
//! - **Other OSes** fall back to empty/no-op results so the commands never fail
//!   to build or error at runtime.

use std::collections::{HashMap, HashSet};
use app_core::sync::LockExt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
#[cfg(feature = "desktop")]
use tauri::{Emitter, State};

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
    /// environment ([`new_launch_id`]): every process the launch starts carries
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
    /// ([`resolve_window_for_launch`]); `None` resolves none.
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
    /// id; an entry outliving its row is swept by [`prune_dead_windows`].
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

fn default_window_origin() -> String {
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

// ── Core launch helper ────────────────────────────────────────────────────

pub fn do_launch(
    registry: &WindowRegistryState,
    exec: &str,
    args: &[String],
    file: Option<&str>,
    project_id: Option<&str>,
    role: Option<&str>,
    origin: &str,
) -> Result<TrackedWindow, String> {
    launch_tracked(registry, exec, args, file, project_id, role, origin, None)
}

/// [`do_launch`] for "Open in <IDE>" (`commands::ide`): an
/// [`ORIGIN_PROJECT_IDE`] row whose launch knows the IDE and the names its
/// window titles the project with ([`LaunchTrack::ide_project`]) — recorded
/// before the exit watcher starts, so even a launcher that hands the folder to
/// a running instance and exits at once is judged with them.
pub fn do_launch_project_ide(
    registry: &WindowRegistryState,
    exec: &str,
    args: &[String],
    target: &str,
    project_id: &str,
    ide: crate::services::ide_detect::IdeId,
    names: Vec<String>,
) -> Result<TrackedWindow, String> {
    launch_tracked(
        registry,
        exec,
        args,
        Some(target),
        Some(project_id),
        Some("ide"),
        ORIGIN_PROJECT_IDE,
        Some((ide, names)),
    )
}

#[allow(clippy::too_many_arguments)]
fn launch_tracked(
    registry: &WindowRegistryState,
    exec: &str,
    args: &[String],
    file: Option<&str>,
    project_id: Option<&str>,
    role: Option<&str>,
    origin: &str,
    ide_project: Option<(crate::services::ide_detect::IdeId, Vec<String>)>,
) -> Result<TrackedWindow, String> {
    let launch_exec = resolve_launch_exec(exec);
    let launch_id = new_launch_id();
    let mut cmd = launch_command(&launch_exec, args, file, launch_id.as_deref());
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let before = list_window_ids();
    let child = cmd.spawn().map_err(|e| format!("launch {launch_exec}: {e}"))?;
    let pid = child.id();
    // Read before the watcher reaps it: an exited, unreaped launcher still
    // answers as a zombie.
    let since = crate::services::proc_table::start_time(pid).unwrap_or(0);
    let window_id = find_window_for_pid(pid, 20);

    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();

    let safe_exec = launch_exec.replace(['/', '\\', ' '], "-");
    let id = format!("{safe_exec}-{pid}");
    let win = TrackedWindow {
        id: id.clone(),
        exec: launch_exec,
        file: file.map(String::from),
        pid,
        project_id: project_id.map(String::from),
        role: role.map(String::from),
        opened_at,
        window_id,
        origin: origin.to_string(),
        launch_id,
    };
    {
        let mut reg = registry.lock_ok();
        reg.windows.insert(id.clone(), win.clone());
        record_launch(&mut reg, &id, since, ide_project);
    }
    watch_child_exit(child, registry.clone(), id, before);
    Ok(win)
}

/// A fresh launch marker: 32 hex characters of OS randomness, never a path,
/// a project id or anything else a process could be traced back by. `None`
/// (an unmarked launch, judged as before) when the OS has no randomness.
fn new_launch_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(crate::digest::hex(&bytes))
}

/// Start the launch bookkeeping of row `id` once it is in the registry, when
/// its launch was marked. `ide_project`: see [`LaunchTrack::ide_project`].
fn record_launch(
    reg: &mut WindowRegistry,
    id: &str,
    since: u64,
    ide_project: Option<(crate::services::ide_detect::IdeId, Vec<String>)>,
) {
    if reg.windows.get(id).is_some_and(|w| w.launch_id.is_some()) {
        reg.launches.insert(
            id.to_string(),
            LaunchTrack { since, family: None, ide_project },
        );
    }
}

/// How much the window list can say about a row's window (`window_id`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WindowList {
    /// Every window an app can open is listed (X11, Windows, macOS).
    Complete(Vec<u64>),
    /// A Wayland session: only XWayland windows are listed. Authoritative
    /// for a row holding a window id (one only an XWayland window can
    /// have), silent about a row without one — its window may be native.
    XWaylandOnly(Vec<u64>),
    /// The enumeration failed: it says nothing about any row.
    Unknown,
}

impl WindowList {
    /// `Some(true)`: the row's window is listed; `Some(false)`: it provably
    /// has none on screen; `None`: the list cannot tell.
    fn shows(&self, window_id: Option<u64>) -> Option<bool> {
        match (self, window_id) {
            (Self::Unknown, _) | (Self::XWaylandOnly(_), None) => None,
            (Self::Complete(ids) | Self::XWaylandOnly(ids), Some(wid)) => Some(ids.contains(&wid)),
            (Self::Complete(_), None) => Some(false),
        }
    }
}

/// The family member a kept row is owned by — its oldest (the app the
/// launcher handed over to, before anything that app started) — or `None`
/// for an empty family.
fn family_lead(family: &[FamilyMember]) -> Option<u32> {
    family.iter().min_by_key(|m| (m.start, m.pid)).map(|m| m.pid)
}

/// The lead of `family`'s members that still run (same pid, same start).
fn live_family_lead(family: &[FamilyMember]) -> Option<u32> {
    let live: Vec<FamilyMember> = family
        .iter()
        .copied()
        .filter(|m| crate::services::proc_table::start_time(m.pid) == Some(m.start))
        .collect();
    family_lead(&live)
}

/// The marked processes of launch `id` alive right now (a fresh walk of the
/// process table), as family members. Empty off Linux.
fn launch_family_now(id: &str, since: u64) -> Vec<FamilyMember> {
    let snap = crate::services::proc_table::snapshot_within(std::time::Duration::ZERO);
    crate::services::proc_table::marked_procs(&snap, id, since)
        .into_iter()
        .map(|p| FamilyMember { pid: p.pid, start: p.start })
        .collect()
}

/// What happens to a tracked window's registry row when the child Tabtivity
/// spawned for it exits.
#[derive(Debug, PartialEq, Eq)]
enum ExitAction {
    /// The app is gone: drop the row.
    Remove,
    /// The launcher exited but a window it produced is still on screen — a
    /// hand-off to an existing instance (a browser, `code`). Keep the row as a
    /// pid-0, delist-only entry, adopting the given window id when the launch
    /// never resolved one.
    KeepDemoted(Option<u64>),
    /// The launcher exited but processes of its launch family live on (a
    /// wrapper that forked the app, `flatpak run`): keep the row, now owned
    /// by `lead` ([`family_lead`]), adopting `adopt` when the launch never
    /// resolved a window.
    KeepFamily { lead: u32, adopt: Option<u64> },
}

/// Pure keep-vs-remove decision for a launched child's exit, so the policy is
/// unit-testable apart from the wait-thread that applies it.
///
/// A live launch family keeps the row whatever the window list says. Without
/// one, the window decides: an adopted or still-listed window keeps the row
/// delist-only, a window provably gone removes it. A list that cannot tell
/// (Wayland, for a row without an XWayland window id; a failed enumeration)
/// never removes a project-opened row — it is kept delist-only for the user
/// to remove — while a machine-wide launch (`global_app`, `manual_launch`)
/// goes as before.
fn launched_exit_action(
    entry_window_id: Option<u64>,
    windows: &WindowList,
    adopted_window: Option<u64>,
    family: &[FamilyMember],
    project_opened: bool,
) -> ExitAction {
    let adopt = adopted_window.filter(|_| entry_window_id.is_none());
    if let Some(lead) = family_lead(family) {
        return ExitAction::KeepFamily { lead, adopt };
    }
    if adopt.is_some() {
        return ExitAction::KeepDemoted(adopt);
    }
    match windows.shows(entry_window_id) {
        Some(true) => ExitAction::KeepDemoted(None),
        Some(false) => ExitAction::Remove,
        None if project_opened => ExitAction::KeepDemoted(None),
        None => ExitAction::Remove,
    }
}

/// The window a launch row without one adopts when its launcher exits, from
/// one scan's `windows`: the window of a family member
/// ([`resolve_window_for_launch`]) — and, when no family is left (a hand-off
/// to a running instance), a guess. For an IDE row that knows its project
/// (`ide`), the guess is the IDE's window showing the project
/// ([`adopt_project_window`]); for any other row it is `new_window` ("any
/// window that appeared since the launch"). A live family that shows no
/// window has not mapped it yet: no guess.
fn exit_adoption(
    row: &TrackedWindow,
    windows: &[ClientWindow],
    family_pids: &[u32],
    held: &HashSet<u64>,
    ide: Option<(crate::services::ide_detect::IdeId, &[String])>,
    new_window: impl FnOnce() -> Option<u64>,
) -> Option<u64> {
    let resolved = resolve_window_for_launch(row, windows, family_pids, held, ide);
    if resolved.is_some() || !family_pids.is_empty() {
        return resolved;
    }
    match ide {
        Some((ide, names)) if row.origin == ORIGIN_PROJECT_IDE => {
            adopt_project_window(windows, held, ide, names)
        }
        _ => new_window(),
    }
}

/// Wait on a launched child from a background thread (which also keeps
/// `spawn_reaped`'s zombie-reaping duty) and reconcile the registry when it
/// exits: remove the row — the fix for dead apps sitting in the Apps view
/// forever — unless its launch family or a window survives the launcher
/// ([`launched_exit_action`]), then notify the frontend via the registry's
/// `notify` hook.
fn watch_child_exit(
    mut child: std::process::Child,
    registry: WindowRegistryState,
    id: String,
    before: Vec<u64>,
) {
    std::thread::spawn(move || {
        let _ = child.wait();
        let (entry, track, held) = {
            let reg = registry.lock_ok();
            // Already closed/untracked while the app ran: nothing to reconcile.
            let Some(entry) = reg.windows.get(&id).cloned() else {
                return;
            };
            (entry, reg.launches.get(&id).cloned(), held_window_ids(&reg, &id))
        };
        // Probes run OUTSIDE the lock: a walk of the process table and one
        // X11/OS window enumeration.
        let family = match (&entry.launch_id, &track) {
            (Some(launch_id), Some(track)) => launch_family_now(launch_id, track.since),
            _ => Vec::new(),
        };
        let (windows, clients) = window_scan();
        let adopted = if entry.window_id.is_none() {
            let pids: Vec<u32> = family.iter().map(|m| m.pid).collect();
            let ide_project = track.as_ref().and_then(|t| t.ide_project.as_ref());
            let ide = ide_project.map(|(ide, names)| (*ide, names.as_slice()));
            exit_adoption(&entry, &clients, &pids, &held, ide, || find_new_window(&before, 1))
        } else {
            None
        };
        let action = launched_exit_action(
            entry.window_id,
            &windows,
            adopted,
            &family,
            is_project_opened_window(&entry),
        );
        let (project_id, notify) = {
            let mut reg = registry.lock_ok();
            let Some(project_id) = reg.windows.get(&id).map(|e| e.project_id.clone()) else {
                return;
            };
            match action {
                ExitAction::Remove => {
                    reg.windows.remove(&id);
                    reg.launches.remove(&id);
                }
                ExitAction::KeepDemoted(adopt) => {
                    if let Some(entry) = reg.windows.get_mut(&id) {
                        entry.pid = 0;
                        if adopt.is_some() {
                            entry.window_id = adopt;
                        }
                    }
                    if let Some(track) = reg.launches.get_mut(&id) {
                        track.family = Some(Vec::new());
                    }
                }
                ExitAction::KeepFamily { lead, adopt } => {
                    if let Some(entry) = reg.windows.get_mut(&id) {
                        entry.pid = lead;
                        if adopt.is_some() {
                            entry.window_id = adopt;
                        }
                    }
                    if let Some(track) = reg.launches.get_mut(&id) {
                        track.family = Some(family);
                    }
                }
            }
            (project_id, reg.notify.clone())
        };
        if let Some(notify) = notify {
            notify(project_id);
        }
    });
}

/// Split an exec string into the literal program to spawn and any leading
/// arguments already baked into it (e.g. Flatpak's
/// `flatpak run --branch=stable --command=... app.id`, from
/// [`parse_exec_command`]).
///
/// An exec with no whitespace is always a single program. One that does
/// contain whitespace is still treated as a single program when the whole
/// string exists as a literal path on disk — this covers Windows targets like
/// `C:\Program Files\App\app.exe` and any manually typed Linux path with a
/// space, both of which must be spawned whole, not split. Only when the whole
/// string is *not* a real path do we fall back to splitting on whitespace,
/// which is exactly the multi-word-launcher case: the single-program
/// interpretation could never have spawned it anyway (no file is literally
/// named `flatpak run --branch=stable ...`).
fn split_exec_command(exec: &str) -> (&str, Vec<&str>) {
    if !exec.contains(' ') || Path::new(exec).exists() {
        return (exec, Vec::new());
    }
    let mut parts = exec.split_whitespace();
    let program = parts.next().unwrap_or(exec);
    (program, parts.collect())
}

/// The `Command` that launches `exec`, carrying `launch_id` (when the launch
/// has one) as `TABTIVITY_LAUNCH_ID` — inherited by every process the app
/// starts, so its windows and liveness are found after the launcher exits
/// (`proc_table::launch_id`). The token is not a secret: it names one launch
/// and nothing else.
fn launch_command(exec: &str, args: &[String], file: Option<&str>, launch_id: Option<&str>) -> Command {
    let mut cmd = unmarked_launch_command(exec, args, file);
    if let Some(launch_id) = launch_id {
        cmd.env(crate::app_env!("LAUNCH_ID"), launch_id);
    }
    cmd
}

fn unmarked_launch_command(exec: &str, args: &[String], file: Option<&str>) -> Command {
    #[cfg(target_os = "macos")]
    if Path::new(exec)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
    {
        let mut cmd = crate::paths::command_no_window("/usr/bin/open");
        cmd.arg("-a").arg(exec);
        if let Some(file) = file {
            cmd.arg(file);
        }
        if !args.is_empty() {
            cmd.arg("--args").args(args);
        }
        return cmd;
    }

    let (program, leading_args) = split_exec_command(exec);
    let mut cmd = crate::paths::command_for_program(Path::new(program));
    // Same reason as the terminal spawn: Tabtivity's AT-SPI opt-out covers Tabtivity's
    // own window, not the app the user is launching (`services::webkit_a11y`).
    #[cfg(target_os = "linux")]
    if crate::services::webkit_a11y::installed() {
        cmd.env_remove(crate::services::webkit_a11y::BUS_ADDRESS_VAR);
    }
    // Nor does its GPU-decoder demotion (`services::webkit_video`).
    #[cfg(target_os = "linux")]
    if crate::services::webkit_video::installed() {
        cmd.env_remove(crate::services::webkit_video::RANK_VAR);
    }
    cmd.args(leading_args);
    cmd.args(args);
    if let Some(file) = file {
        cmd.arg(file);
    }
    cmd
}

// ── Commands ───────────────────────────────────────────────────────────────
//
// The launch commands are `async` + `spawn_blocking` because `do_launch` /
// `open_file` resolve the spawned app's window via `find_window_for_pid` /
// `find_new_window` — up to 20 × 100 ms sleep-polls each (a fresh xcb
// connection per poll on X11), i.e. 2–4 s of main-thread stall per launch when
// run synchronously (the freeze class `commands::git`'s off-thread note
// describes). Single-instance apps, whose spawned pid execs and exits without
// ever mapping a window, hit the full budget every time.

#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn launch_app(
    registry: State<'_, WindowRegistryState>,
    exec: String,
    args: Option<Vec<String>>,
    file: Option<String>,
    project_id: Option<String>,
    role: Option<String>,
    origin: Option<String>,
) -> Result<TrackedWindow, String> {
    let registry = registry.inner().clone();
    app_core::rt::try_blocking("app", move || {
        let origin = origin.unwrap_or_else(|| {
            if role.is_some() {
                ORIGIN_GLOBAL_APP.to_string()
            } else {
                ORIGIN_MANUAL_LAUNCH.to_string()
            }
        });
        do_launch(
            &registry,
            &exec,
            &args.unwrap_or_default(),
            file.as_deref(),
            project_id.as_deref(),
            role.as_deref(),
            &origin,
        )
    })
    .await
}

/// Icon lookups walk desktop-entry and icon-theme directories recursively, so
/// results (including misses) are cached per exec for the app's lifetime.
static ICON_CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn resolve_app_icon(exec: String) -> Option<String> {
    if let Some(cached) = ICON_CACHE
        .lock_ok()
        .get_or_insert_with(HashMap::new)
        .get(&exec)
    {
        return cached.clone();
    }
    let icon = resolve_app_icon_uncached(&exec);
    ICON_CACHE
        .lock_ok()
        .get_or_insert_with(HashMap::new)
        .insert(exec, icon.clone());
    icon
}

fn resolve_app_icon_uncached(exec: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(icon) = resolve_windows_app_icon(exec) {
            return Some(icon);
        }
    }

    let (exec_program, _) = split_exec_command(exec);
    let exec_base = Path::new(exec_program)
        .file_name()?
        .to_string_lossy()
        .to_lowercase();
    for desktop_file in desktop_files() {
        if let Some(entry) = parse_desktop_entry(&desktop_file) {
            let (entry_program, _) = split_exec_command(&entry.exec);
            let Some(entry_base) = Path::new(entry_program)
                .file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
            else {
                continue;
            };
            if entry.exec == exec || entry_base == exec_base {
                if let Some(icon_path) = resolve_icon_path(&entry.icon) {
                    return icon_to_data_url(&icon_path);
                }
            }
        }
    }
    None
}

fn icon_to_data_url(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("xpm") => "image/x-xpixmap",
        _ => "image/png",
    };
    Some(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize]);
        out.push(T[((n >> 12) & 63) as usize]);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize]
        } else {
            b'='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize]
        } else {
            b'='
        });
    }
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn open_file(
    registry: State<'_, WindowRegistryState>,
    workspace: State<'_, crate::commands::workspace::WorkspaceStateArc>,
    path: String,
    handler: Option<String>,
    project_id: Option<String>,
    origin: Option<String>,
    // Physical desktop coordinates to place the launched window at (the point a
    // file was dropped, on the target monitor). Both must be present to apply;
    // absent on double-click / manual launch, leaving WM placement untouched.
    x: Option<i32>,
    y: Option<i32>,
    // Threat recheck gap 21 (C2): answer only whether this open would be
    // refused, opening and spawning nothing (`Ok(None)` = it would go
    // ahead). The window asks the user between the two calls.
    check_only: Option<bool>,
) -> Result<Option<TrackedWindow>, String> {
    let registry = registry.inner().clone();
    let workspace = workspace.inner().clone();
    // Worst case (X11) chains `find_window_for_pid` AND `find_new_window` → ~4 s;
    // under Wayland both answer at once (`platform::x11::session_is_wayland`).
    app_core::rt::try_blocking("app", move || {
        let effective = effective_handler(handler, &path, project_id.as_deref());
        if !open_goes_ahead(effective.as_deref(), &path, check_only.unwrap_or(false))? {
            return Ok(None);
        }
        open_file_blocking(&registry, &workspace, path, effective, project_id, origin, (x, y)).map(Some)
    })
    .await
}

/// Gap 21 (C2): may an `open_file` go on to open? An OS-default open
/// (`effective` is `None`) of a launcher or executable is refused; a check
/// (`check_only`) answers `false` once it passed, so nothing is opened.
fn open_goes_ahead(effective: Option<&str>, path: &str, check_only: bool) -> Result<bool, String> {
    if effective.is_none() {
        crate::services::os_open::check(Path::new(path))?;
    }
    Ok(!check_only)
}

/// The program a file opens with: an explicit handler always wins; otherwise
/// the project-then-global default-app map (keyed by extension). `None`
/// leaves it to the OS default, which `services::os_open::check` judges
/// first (gap 21, C2): a handler or a configured default app is the user's
/// own choice.
fn effective_handler(handler: Option<String>, path: &str, project_id: Option<&str>) -> Option<String> {
    match handler {
        Some(h) => Some(h),
        None => {
            let global_apps = crate::commands::default_apps::get_default_apps()
                .map(|d| d.0)
                .unwrap_or_default();
            let project_apps = project_apps_for_id(project_id);
            Path::new(path)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                .and_then(|ext| {
                    project_apps
                        .get(&ext)
                        .or_else(|| global_apps.get(&ext))
                        .cloned()
                })
                .filter(|s| !s.trim().is_empty())
        }
    }
}

fn open_file_blocking(
    registry: &WindowRegistryState,
    workspace: &crate::commands::workspace::WorkspaceStateArc,
    path: String,
    effective: Option<String>,
    project_id: Option<String>,
    origin: Option<String>,
    (x, y): (Option<i32>, Option<i32>),
) -> Result<TrackedWindow, String> {
    let origin = origin.unwrap_or_else(|| ORIGIN_MANUAL_LAUNCH.to_string());
    // Best-effort: move a resolved window to the drop point so an externally
    // launched app lands on the screen the file was dropped onto. Placement
    // failure never fails the open (X11-only; a no-op elsewhere).
    let place = |window_id: Option<u64>| {
        if let (Some(wid), Some(px), Some(py)) = (window_id, x, y) {
            if let Err(e) = workspace
                .lock_ok()
                .backend
                .position_window(wid, px, py)
            {
                eprintln!("position_window failed: {e}");
            }
        }
    };
    let before = list_window_ids();
    // `effective` is [`effective_handler`]'s answer; `None` is the OS
    // default below, which the caller has already judged.
    if let Some(exec) = effective {
        let launch_exec = resolve_launch_exec(&exec);
        let launch_id = new_launch_id();
        let mut cmd = launch_command(&launch_exec, &[], Some(&path), launch_id.as_deref());
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = cmd
            .spawn()
            .map_err(|e| format!("open with {launch_exec}: {e}"))?;
        let pid = child.id();
        let since = crate::services::proc_table::start_time(pid).unwrap_or(0);
        let window_id = find_window_for_pid(pid, 20).or_else(|| find_new_window(&before, 20));
        place(window_id);
        let mut win = track_opened_file(
            registry,
            launch_exec,
            path,
            pid,
            project_id,
            window_id,
            origin,
        )?;
        if let Some(launch_id) = launch_id {
            let mut reg = registry.lock_ok();
            if let Some(row) = reg.windows.get_mut(&win.id) {
                row.launch_id = Some(launch_id.clone());
            }
            record_launch(&mut reg, &win.id, since, None);
            win.launch_id = Some(launch_id);
        }
        watch_child_exit(child, registry.clone(), win.id.clone(), before);
        return Ok(win);
    }
    opener::open(&path).map_err(|e| e.to_string())?;
    let window_id = find_new_window(&before, 20);
    place(window_id);
    track_opened_file(
        registry,
        "open-file".to_string(),
        path,
        0,
        project_id,
        window_id,
        origin,
    )
}

/// Run a shell script as a fire-and-forget detached process.
///
/// Used by the side-panel "run in background" mode: the script is spawned with
/// stdio fully detached, and is not tracked as a window or tab. No output is
/// surfaced — callers that want to watch a script should open a terminal tab
/// instead. When a `run_id` is supplied, a background thread waits for the
/// process and emits a `script-finished` event (`{ runId, success }`) so the UI
/// can show a running animation that clears on completion.
///
/// `args` is the per-file argument string set from the ▶ button's right-click
/// popover — the same raw string the foreground tab appends to its command line.
///
/// On Linux/Unix the script is run with `bash <path>`. Windows has no `bash`, so
/// [`windows_script_command`] picks an interpreter by extension (`.ps1` →
/// PowerShell, everything else → `cmd /C`, which honours `.bat`/`.cmd` and the
/// file's shell association) while still yielding a waitable child process.
///
/// `script_path` is **confined** to `project_id`'s project tree (and its box
/// siblings) by the same check every file command uses
/// (`commands::fs::confine_project_path`). This is a raw exec primitive — `bash
/// <any path>` — so without confinement one `invoke` runs any script on the host;
/// the only legitimate caller is the file tree's "run in background" on a file it
/// is displaying, which is by construction inside the project.
#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn run_script_detached(
    app: tauri::AppHandle,
    script_path: String,
    cwd: Option<String>,
    run_id: Option<String>,
    project_id: Option<String>,
    args: Option<String>,
) -> Result<(), String> {
    let path = Path::new(&script_path);
    if !path.is_absolute() {
        return Err(format!("run {script_path}: script path must be absolute"));
    }
    crate::commands::fs::confine_project_path(path, project_id.as_deref())?;
    #[cfg(target_os = "windows")]
    let mut cmd = windows_script_command(&script_path, args.as_deref());
    #[cfg(not(target_os = "windows"))]
    let mut cmd = unix_script_command(&script_path, args.as_deref());
    if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::paths::augment_command_path(&mut cmd);
    crate::paths::spawn_reaped_then(cmd, move |success| {
        if let Some(run_id) = run_id {
            let _ = app.emit(
                "script-finished",
                serde_json::json!({ "runId": run_id, "success": success }),
            );
        }
    })
    .map(|_| ())
    .map_err(|e| format!("run {script_path}: {e}"))
}

// ── Frameless embedding capability (TODO Group K #40, Phase 1) ──────────────

/// Conservative allowlist of app executables (by basename) we'll attempt to
/// embed frameless into a tab. These are single-window, single-process apps
/// that map exactly one stable top-level window we can reparent.
///
/// CAVEAT — fork-and-exit: an embeddable app MUST keep running under the PID we
/// spawn and own its top-level directly. Single-instance D-Bus apps
/// (e.g. `gnome-text-editor`, `kate`) fork a server and exit the launched
/// process, so our spawned PID dies before mapping a window — there is nothing
/// to reparent and `find_window_for_pid` would fail. Those remain excluded.
///
/// `gedit` and `code` are included by explicit request even though they exhibit
/// this single-instance behavior (gedit forks a D-Bus server; VS Code is
/// multi-window Electron and reuses an existing instance). Phase-2 embedding may
/// need `--new-window`/`--wait`-style flags or a different window-find strategy
/// to make them reparent reliably; until then they at least get the drag-to-tab
/// affordance. Keep this list small; expand only after verifying an app maps a
/// single stable top-level under its own PID.
pub const EMBEDDABLE_EXECS: &[&str] = &[
    "xterm", "xev", "mousepad", "okular", "evince", "eog", "feh", "mpv", "qpdfview", "gedit",
    "code", "blender",
];

/// Whether `exec` (a path, bare command, or multi-word launcher line) names an
/// embeddable app, matched by the basename of its program (see
/// [`split_exec_command`]) against `EMBEDDABLE_EXECS`.
pub fn is_embeddable_exec(exec: &str) -> bool {
    let (program, _) = split_exec_command(exec);
    let base = Path::new(program)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| program.to_lowercase());
    EMBEDDABLE_EXECS.iter().any(|&e| e == base)
}

/// Resolve the executable that would open `path`, in precedence order:
///   1. an explicitly passed `handler`;
///   2. the project's `default_apps` map, then the global one, keyed by the
///      file extension (including the leading dot, e.g. `.md`);
///   3. the system default: `xdg-mime query default <mime>` → the matching
///      `.desktop` entry's `Exec` first token on Linux, the shell association
///      on Windows, LaunchServices on macOS.
///
/// Returns `None` when nothing resolves (capability then degrades to external).
///
/// Pure with respect to the app maps (passed in) so it is unit-testable; only
/// the xdg/mime fallback touches the system.
pub fn resolve_default_handler(
    path: &str,
    handler: Option<&str>,
    project_apps: Option<&HashMap<String, String>>,
    global_apps: &HashMap<String, String>,
) -> Option<String> {
    if let Some(h) = handler.map(str::trim).filter(|h| !h.is_empty()) {
        return Some(h.to_string());
    }
    let ext = Path::new(path)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()));
    if let Some(ext) = ext.as_deref() {
        if let Some(app) = project_apps.and_then(|m| m.get(ext)) {
            if !app.is_empty() {
                return Some(app.clone());
            }
        }
        if let Some(app) = global_apps.get(ext) {
            if !app.is_empty() {
                return Some(app.clone());
            }
        }
    }
    resolve_handler_via_mime(path)
}

/// The system's default handler for `path`, by each OS's own registry:
/// `xdg-mime` → `.desktop` `Exec` first token on Linux, the shell file
/// association (`AssocQueryString`) on Windows, LaunchServices on macOS.
/// `None` when nothing is registered, so the caller falls back to
/// `opener::open` / the OS default.
fn resolve_handler_via_mime(path: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        windows_default_handler(path)
    }
    #[cfg(target_os = "macos")]
    {
        macos_default_handler(path)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = path;
        None
    }
    #[cfg(target_os = "linux")]
    {
        let mime = Command::new("xdg-mime")
            .args(["query", "filetype", path])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())?;
        let desktop = Command::new("xdg-mime")
            .args(["query", "default", &mime])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())?;
        // Locate the named .desktop file and pull its Exec first token.
        for dir in desktop_app_dirs() {
            let candidate = dir.join(&desktop);
            if candidate.exists() {
                if let Some(entry) = parse_desktop_entry(&candidate) {
                    return Some(entry.exec);
                }
            }
        }
        None
    }
}

/// Windows: the executable the shell would launch for the file's extension,
/// via `AssocQueryStringW(ASSOCSTR_EXECUTABLE)` — the same registry walk
/// (`HKCR\.ext` → ProgId → `shell\open\command`, honouring the user's
/// per-extension choice) Explorer's double-click does. Two calls: the first
/// with no buffer sizes the answer.
#[cfg(target_os = "windows")]
fn windows_default_handler(path: &str) -> Option<String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::UI::Shell::{AssocQueryStringW, ASSOCF_NONE, ASSOCSTR_EXECUTABLE};

    let ext = Path::new(path).extension()?.to_string_lossy();
    let assoc: Vec<u16> = format!(".{ext}").encode_utf16().chain(Some(0)).collect();
    let mut len: u32 = 0;
    // SAFETY: `assoc` is NUL-terminated; with no out buffer the call only
    // writes the required length into `len`. The second call's buffer is sized
    // from that answer and `len` bounds what is read back.
    unsafe {
        let probe = AssocQueryStringW(
            ASSOCF_NONE,
            ASSOCSTR_EXECUTABLE,
            PCWSTR(assoc.as_ptr()),
            PCWSTR::null(),
            None,
            &mut len,
        );
        // S_OK / S_FALSE both mean "length written"; a failure HRESULT means
        // no association.
        if probe.is_err() || len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        AssocQueryStringW(
            ASSOCF_NONE,
            ASSOCSTR_EXECUTABLE,
            PCWSTR(assoc.as_ptr()),
            PCWSTR::null(),
            Some(PWSTR(buf.as_mut_ptr())),
            &mut len,
        )
        .ok()
        .ok()?;
        let end = buf.iter().position(|&u| u == 0).unwrap_or(buf.len());
        let exe = String::from_utf16_lossy(&buf[..end]);
        (!exe.is_empty()).then_some(exe)
    }
}

/// macOS: the application bundle LaunchServices would open `path` with
/// (`LSCopyDefaultApplicationURLForURL`, all roles) — the user's "Open With →
/// Always Open With" choice included. Returns the `.app` path, which the
/// launcher already knows how to run (see the `.app` branch in
/// `launch_command`). Raw CoreFoundation FFI in the same style as
/// `platform/macos.rs`: every Create/Copy ref is released before returning.
#[cfg(target_os = "macos")]
fn macos_default_handler(path: &str) -> Option<String> {
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;
    type CFURLRef = *const c_void;
    type CFStringRef = *const c_void;
    /// `kLSRolesAll`.
    const LS_ROLES_ALL: u32 = 0xFFFF_FFFF;
    /// `kCFURLPOSIXPathStyle`.
    const POSIX_PATH_STYLE: isize = 0;
    /// `kCFStringEncodingUTF8`.
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(
            alloc: *const c_void,
            buffer: *const u8,
            buf_len: isize,
            is_directory: bool,
        ) -> CFURLRef;
        fn CFURLCopyFileSystemPath(url: CFURLRef, style: isize) -> CFStringRef;
        fn CFStringGetCString(
            string: CFStringRef,
            buffer: *mut std::ffi::c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> bool;
        fn CFRelease(cf: CFTypeRef);
    }
    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyDefaultApplicationURLForURL(
            url: CFURLRef,
            role_mask: u32,
            out_error: *mut *const c_void,
        ) -> CFURLRef;
    }

    let bytes = path.as_bytes();
    // SAFETY: every ref created here is released on every path out; the
    // C-string buffer is sized for `PATH_MAX` and `CFStringGetCString` reports
    // truncation as `false`.
    unsafe {
        let file_url = CFURLCreateFromFileSystemRepresentation(
            std::ptr::null(),
            bytes.as_ptr(),
            bytes.len() as isize,
            false,
        );
        if file_url.is_null() {
            return None;
        }
        let app_url =
            LSCopyDefaultApplicationURLForURL(file_url, LS_ROLES_ALL, std::ptr::null_mut());
        CFRelease(file_url);
        if app_url.is_null() {
            return None;
        }
        let app_path = CFURLCopyFileSystemPath(app_url, POSIX_PATH_STYLE);
        CFRelease(app_url);
        if app_path.is_null() {
            return None;
        }
        let mut buf = [0i8; 1024];
        let ok = CFStringGetCString(app_path, buf.as_mut_ptr(), buf.len() as isize, UTF8);
        CFRelease(app_path);
        if !ok {
            return None;
        }
        let out = std::ffi::CStr::from_ptr(buf.as_ptr())
            .to_string_lossy()
            .into_owned();
        (!out.is_empty()).then_some(out)
    }
}

/// XDG application directories, in precedence order: `$XDG_DATA_HOME/applications`
/// (falling back to `~/.local/share/applications`), then each dir in
/// `$XDG_DATA_DIRS` (falling back to `/usr/local/share:/usr/share`) joined with
/// `applications`. Respecting `XDG_DATA_DIRS` (rather than hardcoding just
/// `/usr/share` + `/usr/local/share`) is what picks up Flatpak/Snap exports
/// (e.g. `/var/lib/flatpak/exports/share`), which the desktop session already
/// adds to that variable.
fn xdg_application_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    if let Some(home) = data_home {
        dirs.push(home.join("applications"));
    }
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    for dir in data_dirs.split(':').filter(|s| !s.is_empty()) {
        dirs.push(PathBuf::from(dir).join("applications"));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// Linux-only after the mime-resolver was platform-gated; the icon resolver still
/// uses the separate `desktop_files`, so keep this compiled but quiet elsewhere.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn desktop_app_dirs() -> Vec<PathBuf> {
    xdg_application_dirs()
}

/// Return the native file-drag preview icon as a PNG `data:` URL.
///
/// `tauri-plugin-drag`'s `startDrag` icon field is deserialized through an
/// untagged enum whose only string form is a base64 PNG **data URL**
/// (`data:image/png;base64,…`) — a bare file path fails to deserialize and the
/// whole drag command rejects before it starts. So embed the app icon at compile
/// time and hand back a data URL the frontend can pass straight to `startDrag`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn drag_preview_icon() -> String {
    use base64::Engine;
    const ICON_PNG: &[u8] = include_bytes!("../../icons/128x128.png");
    let b64 = base64::engine::general_purpose::STANDARD.encode(ICON_PNG);
    format!("data:image/png;base64,{b64}")
}

#[cfg(all(target_os = "linux", feature = "desktop"))]
thread_local! {
    /// The in-flight GTK drag, so `cancel_file_drag` can abort it when the
    /// cursor comes back into the window. GTK/GDK objects are not `Send`, and
    /// every access is on the GTK main thread (sync Tauri commands and GTK
    /// signal handlers both run there), so a thread-local is the right home.
    static ACTIVE_DRAG: std::cell::RefCell<Option<gtk::gdk::DragContext>> =
        const { std::cell::RefCell::new(None) };
    /// Set by `cancel_file_drag` so the `cancel` signal it provokes is
    /// recognised as OURS: the gesture is being handed back to the in-app drag
    /// and is NOT over, so it must not emit `FILE_DRAG_ENDED`.
    static CANCEL_REQUESTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Emitted when a native drag reaches its true end (dropped, failed, or
/// cancelled by the user/WM). The frontend keeps a gesture alive across the
/// handoff, so it needs to hear the end from the OS: once GTK owns the pointer,
/// the webview never sees the `pointerup` that would otherwise end it.
#[cfg(target_os = "linux")]
pub const FILE_DRAG_ENDED: &str = crate::brand::FILE_DRAG_ENDED_EVENT;

/// Start a native OS drag-out of `paths` from the calling window (Linux/GTK).
///
/// Replaces `tauri-plugin-drag`'s GTK path for the Ctrl-drag file export. That
/// path LOOKS right (OS drag icon, drop animation) but delivers an empty
/// payload to external targets: it disconnects its `drag-data-get` handler on
/// `drop-performed` — emitted at the instant of the drop, BEFORE the target
/// asynchronously requests the `text/uri-list` selection — so a browser's or
/// file manager's data request finds no provider and the drop silently does
/// nothing. It also builds `file://{path}` with no percent-encoding (a space
/// in the name yields an invalid URI strict consumers discard) and passes
/// `GDK_BUTTON1_MASK` (256) where GTK expects the button NUMBER (1).
///
/// Here URIs are encoded canonically (`glib::filename_to_uri`) and teardown is
/// deferred to `dnd-finished` (the target has read the data), with `cancel` /
/// `drag-failed` covering the abort paths. Windows/macOS keep the plugin
/// (their OLE/NSDragging backends are sound).
///
/// Deliberately a SYNC command: Tauri dispatches those on the main (GTK)
/// thread, which is exactly where every call below must run.
#[cfg(feature = "desktop")]
#[cfg(target_os = "linux")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn start_file_drag(window: tauri::Window, paths: Vec<String>) -> Result<(), String> {
    use gtk::{gdk, glib, prelude::*};
    use std::cell::RefCell;
    use std::rc::Rc;

    if paths.is_empty() {
        return Err("start_file_drag: no paths".into());
    }
    let uris: Vec<String> = paths
        .iter()
        .map(|p| {
            glib::filename_to_uri(p, None)
                .map(|u| u.to_string())
                .map_err(|e| format!("start_file_drag: invalid path {p:?}: {e}"))
        })
        .collect::<Result<_, _>>()?;

    let win = window.gtk_window().map_err(|e| e.to_string())?;
    win.drag_source_set(gdk::ModifierType::BUTTON1_MASK, &[], gdk::DragAction::COPY);
    win.drag_source_add_uri_targets();

    // Window-level signal handlers live until an end-of-drag signal fires;
    // the drag-data-get one MUST survive past the drop itself (see above).
    let handler_ids: Rc<RefCell<Vec<glib::SignalHandlerId>>> = Rc::new(RefCell::new(Vec::new()));
    {
        let uris = uris.clone();
        handler_ids
            .borrow_mut()
            .push(win.connect_drag_data_get(move |_, _, data, _, _| {
                let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
                data.set_uris(&refs);
            }));
    }

    let target_list = win
        .drag_source_get_target_list()
        .ok_or("start_file_drag: empty target list")?;
    let context = win
        .drag_begin_with_coordinates(&target_list, gdk::DragAction::COPY, 1, None, -1, -1)
        .ok_or("start_file_drag: drag_begin refused (no pointer grab?)")?;
    ACTIVE_DRAG.with(|c| *c.borrow_mut() = Some(context.clone()));

    // Idempotent teardown shared by every end-of-drag signal — a cancelled drag
    // can raise more than one of them for the same gesture. `ours` marks the
    // cancel WE asked for (handing the gesture back to the in-app drag): the
    // GTK drag is over, but the user's gesture is not, so no end event.
    let cleanup = {
        let win = win.clone();
        let window = window.clone();
        let handler_ids = handler_ids.clone();
        move || {
            for id in handler_ids.borrow_mut().drain(..) {
                win.disconnect(id);
            }
            win.drag_source_unset();
            ACTIVE_DRAG.with(|c| *c.borrow_mut() = None);
            let ours = CANCEL_REQUESTED.with(|f| f.replace(false));
            if !ours {
                use tauri::Emitter;
                let _ = window.emit(FILE_DRAG_ENDED, ());
            }
        }
    };
    {
        let cleanup = cleanup.clone();
        context.connect_dnd_finished(move |_| cleanup());
    }
    {
        let cleanup = cleanup.clone();
        context.connect_cancel(move |_, _| cleanup());
    }
    {
        let cleanup = cleanup.clone();
        let id = win.connect_drag_failed(move |_, _, _| {
            cleanup();
            // Proceed keeps GTK's snap-back animation for the failed drop.
            glib::Propagation::Proceed
        });
        handler_ids.borrow_mut().push(id);
    }

    // Same OS drag icon the plugin path used (the app icon).
    const ICON_PNG: &[u8] = include_bytes!("../../icons/128x128.png");
    let loader = gtk::gdk_pixbuf::PixbufLoader::new();
    if loader.write(ICON_PNG).and_then(|_| loader.close()).is_ok() {
        if let Some(pixbuf) = loader.pixbuf() {
            context.drag_set_icon_pixbuf(&pixbuf, 0, 0);
        }
    }
    Ok(())
}

/// Abort the in-flight native drag, handing the still-held button back to the
/// in-app pointer drag (the cursor re-entered the Tabtivity window, so the ghost
/// and hover take over again from the OS drag icon). A no-op when no native
/// drag is running, so the frontend can call it unconditionally.
#[cfg(all(target_os = "linux", feature = "desktop"))]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn cancel_file_drag() {
    use gtk::prelude::DragContextExtManual;
    let Some(context) = ACTIVE_DRAG.with(|c| c.borrow().clone()) else {
        return;
    };
    // Read back in `cleanup` (via the `cancel` signal this raises) to tell our
    // own abort apart from a real one.
    CANCEL_REQUESTED.with(|f| f.set(true));
    context.drag_cancel();
}

#[cfg(any(not(target_os = "linux"), not(feature = "desktop")))]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn cancel_file_drag() {}

/// Non-Linux stub so the command registers everywhere; the frontend only
/// routes to it on Linux (Windows/macOS stay on `tauri-plugin-drag`).
#[cfg(any(not(target_os = "linux"), not(feature = "desktop")))]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn start_file_drag(paths: Vec<String>) -> Result<(), String> {
    let _ = paths;
    Err("start_file_drag is Linux-only; use tauri-plugin-drag".into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedCapability {
    /// OS can host an embedded frameless window (X11 backend, not XWayland).
    pub os_embeddable: bool,
    /// The resolved default app is on the conservative allowlist.
    pub app_embeddable: bool,
    /// The executable we would embed (or launch externally on fallback).
    pub resolved_exec: Option<String>,
}

/// Report whether `path` can be opened as a frameless embedded tab.
///
/// `os_embeddable` is true only when the active workspace backend supports
/// embedding (X11) AND we're not on Wayland (XWayland reparenting is
/// unreliable). `app_embeddable` is true when the resolved default handler is
/// on the conservative allowlist. The frontend gates the tab-bar drop target on
/// `os_embeddable && app_embeddable`; otherwise the file opens externally.
///
/// Phase 1: this reports capability only — no reparenting happens yet.
#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn embed_capability(
    workspace: State<'_, crate::commands::workspace::WorkspaceStateArc>,
    path: String,
    handler: Option<String>,
    project_id: Option<String>,
) -> EmbedCapability {
    let os_embeddable = {
        let ws = workspace.lock_ok();
        ws.backend.supports_embedding()
    } && !crate::platform::session_is_wayland();

    let global_apps = crate::commands::default_apps::get_default_apps()
        .map(|d| d.0)
        .unwrap_or_default();
    // Resolution precedence: explicit handler → project default_apps → global →
    // system mime default. A project override therefore wins over the global map.
    let project_apps = project_apps_for_id(project_id.as_deref());
    let resolved_exec =
        resolve_default_handler(&path, handler.as_deref(), Some(&project_apps), &global_apps);
    let app_embeddable = resolved_exec.as_deref().is_some_and(is_embeddable_exec);

    EmbedCapability {
        os_embeddable,
        app_embeddable,
        resolved_exec,
    }
}

/// Project-level default-app map for `project_id`, from the projects.json entry's
/// `extra["default_apps"]`. Returns an empty map when the id is absent or any
/// read fails, so resolution then falls back to the global map / system default.
pub(crate) fn project_apps_for_id(project_id: Option<&str>) -> HashMap<String, String> {
    let Some(id) = project_id else {
        return HashMap::new();
    };
    crate::services::remote::project_entry(id)
        .map(|e| project_apps_from_entry(&e))
        .unwrap_or_default()
}

/// The project map as the trusted `projects.json` entry holds it
/// (`extra["default_apps"]`). Never the in-folder `project.json` copy: that file
/// is writable by a fenced agent, a container tab, a `git pull` or byte-sync, and
/// an exec it names would launch on the host, unfenced, at the next open.
fn project_apps_from_entry(entry: &crate::schema::ProjectEntry) -> HashMap<String, String> {
    entry
        .extra
        .get("default_apps")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

/// The project-level default-app map, from the trusted registry only.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_project_default_apps(project_id: String) -> HashMap<String, String> {
    project_apps_for_id(Some(&project_id))
}

/// Replace the project-level default-app map. Written to both stores like
/// `set_project_python`: the `projects.json` mirror is what the open path reads,
/// `project.json` keeps it with the project for display/export.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn set_project_default_apps(
    project_id: String,
    default_apps: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let apps: HashMap<String, String> = default_apps
        .into_iter()
        .map(|(ext, exec)| (ext, exec.trim().to_string()))
        .filter(|(ext, exec)| !ext.is_empty() && !exec.is_empty())
        .collect();
    crate::commands::projects::patch_project_entry_mirrored(
        &project_id,
        |entry| {
            if apps.is_empty() {
                entry.extra.remove("default_apps");
            } else {
                let value = serde_json::to_value(&apps).map_err(|e| e.to_string())?;
                entry.extra.insert("default_apps".into(), value);
            }
            Ok(())
        },
        |project, ()| project.default_apps = (!apps.is_empty()).then(|| apps.clone()),
    )?;
    Ok(apps)
}

/// One installed application, surfaced to the "set default app" picker.
#[derive(Debug, Clone, Serialize)]
pub struct InstalledApp {
    /// Display name (`Name=` from the `.desktop` entry).
    pub name: String,
    /// Launch command line, parsed from `Exec=` with desktop field codes
    /// (`%f`/`%U`/...) and Flatpak's `@@` quoting markers stripped. Kept as the
    /// full command line (not just the first token) so multi-word launchers like
    /// `flatpak run --branch=stable --command=... app.id` still work — see
    /// [`parse_exec_command`].
    pub exec: String,
    /// Raw `Icon=` value (theme name or path); the frontend resolves it lazily.
    pub icon: Option<String>,
}

/// List installed applications, powering the search box in the "set default app"
/// dialog. On Linux this scans `.desktop` entries in the standard application
/// directories (skipping hidden entries and non-`Application` types, deduped by
/// executable basename with user dirs taking precedence); on Windows it
/// enumerates Start-Menu shortcuts. Sorted by name.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn list_installed_apps() -> Vec<InstalledApp> {
    #[cfg(target_os = "windows")]
    {
        windows_installed_apps()
    }
    #[cfg(target_os = "macos")]
    {
        macos_installed_apps()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut apps: Vec<InstalledApp> = Vec::new();
        for dir in desktop_app_dirs() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                    continue;
                }
                if let Some(app) = parse_installed_app(&path) {
                    let key = Path::new(&app.exec)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_lowercase())
                        .unwrap_or_else(|| app.exec.to_lowercase());
                    if seen.insert(key) {
                        apps.push(app);
                    }
                }
            }
        }
        apps.sort_by_key(|a| a.name.to_lowercase());
        apps
    }
}

/// Windows installed-app list: every Start-Menu `.lnk` shortcut, mapped to its
/// display name and resolved target executable (which is what the picker stores
/// and later launches). Deduped by target-exe path (case-insensitive), sorted by
/// name. The icon is left to lazy resolution via [`resolve_app_icon`].
#[cfg(target_os = "windows")]
fn windows_installed_apps() -> Vec<InstalledApp> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut apps: Vec<InstalledApp> = Vec::new();
    for shortcut in windows_shortcuts() {
        let exec = shortcut.target_path.to_string_lossy().into_owned();
        if exec.trim().is_empty() {
            continue;
        }
        if seen.insert(exec.to_lowercase()) {
            apps.push(InstalledApp {
                name: shortcut.display_name,
                exec,
                icon: None,
            });
        }
    }
    apps.sort_by_key(|a| a.name.to_lowercase());
    apps
}

/// macOS installed-app list from each bundle's Info.plist. The picker persists
/// the bundle path so launch goes through LaunchServices.
#[cfg(target_os = "macos")]
fn macos_installed_apps() -> Vec<InstalledApp> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.insert(0, PathBuf::from(home).join("Applications"));
    }

    macos_installed_apps_in(&roots)
}

#[cfg(target_os = "macos")]
fn macos_installed_apps_in(roots: &[PathBuf]) -> Vec<InstalledApp> {
    let mut seen = std::collections::HashSet::new();
    let mut apps: Vec<InstalledApp> = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("app") {
                continue;
            }
            let Some(app) = parse_macos_app_bundle(&path) else {
                continue;
            };
            if !seen.insert(app.exec.to_lowercase()) {
                continue;
            }
            apps.push(app);
        }
    }
    apps.sort_by_key(|a| a.name.to_lowercase());
    apps
}

#[cfg(target_os = "macos")]
fn parse_macos_app_bundle(app: &Path) -> Option<InstalledApp> {
    let plist = plist::Value::from_file(app.join("Contents").join("Info.plist")).ok()?;
    let dict = plist.as_dictionary()?;
    let executable = dict.get("CFBundleExecutable")?.as_string()?.trim();
    if executable.is_empty()
        || !app
            .join("Contents")
            .join("MacOS")
            .join(executable)
            .is_file()
    {
        return None;
    }
    let name = ["CFBundleDisplayName", "CFBundleName"]
        .iter()
        .find_map(|key| dict.get(key).and_then(plist::Value::as_string))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            app.file_stem()
                .map(|name| name.to_string_lossy().into_owned())
        })?;
    Some(InstalledApp {
        name,
        exec: app.to_string_lossy().into_owned(),
        icon: None,
    })
}

/// Parse a single `.desktop` file into an `InstalledApp`, or `None` when it is
/// hidden, not an application, or has no `Exec`. First value of each key wins so
/// the unlocalized `Name=`/`Exec=` take precedence over later `[Action]` groups.
/// Linux-only (Windows lists Start-Menu shortcuts instead); kept compiled for the
/// shared unit tests.
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
fn parse_installed_app(path: &Path) -> Option<InstalledApp> {
    let content = fs::read_to_string(path).ok()?;
    let mut in_entry = false;
    let mut name: Option<String> = None;
    let mut exec: Option<String> = None;
    let mut icon: Option<String> = None;
    let mut no_display = false;
    let mut is_app = true;
    for raw in content.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some(v) = line.strip_prefix("Name=") {
            if name.is_none() {
                name = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("Exec=") {
            if exec.is_none() {
                exec = parse_exec_command(v);
            }
        } else if let Some(v) = line.strip_prefix("Icon=") {
            if icon.is_none() {
                icon = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("NoDisplay=") {
            no_display = v.eq_ignore_ascii_case("true");
        } else if let Some(v) = line.strip_prefix("Type=") {
            is_app = v == "Application";
        }
    }
    if no_display || !is_app {
        return None;
    }
    let exec = exec?;
    Some(InstalledApp {
        name: name.unwrap_or_else(|| exec.clone()),
        exec,
        icon,
    })
}

struct DesktopEntry {
    exec: String,
    icon: String,
}

fn resolve_launch_exec(exec: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some(resolved) = resolve_windows_launch_exec(exec) {
            return resolved;
        }
    }
    exec.to_string()
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct ShortcutEntry {
    display_name: String,
    shortcut_path: PathBuf,
    target_path: PathBuf,
    icon_path: Option<PathBuf>,
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
fn shortcut_matches(query: &str, shortcut: &ShortcutEntry) -> bool {
    let query = normalize_app_match(query);
    if query.is_empty() {
        return false;
    }

    let display = normalize_app_match(&shortcut.display_name);
    let shortcut_path = normalize_app_match(&shortcut.shortcut_path.to_string_lossy());
    let target_path = normalize_app_match(&shortcut.target_path.to_string_lossy());
    let shortcut_stem = normalized_path_stem(&shortcut_path);
    let target_base = normalized_path_basename(&target_path);
    let target_stem = normalized_path_stem(&target_path);

    [
        display,
        shortcut_stem,
        shortcut_path,
        target_path,
        target_base,
        target_stem,
    ]
    .into_iter()
    .any(|candidate| candidate == query)
}

fn normalize_app_match(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .to_lowercase()
        .replace('\\', "/")
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
fn normalized_path_basename(normalized_path: &str) -> String {
    normalized_path
        .rsplit('/')
        .next()
        .unwrap_or(normalized_path)
        .to_string()
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
fn normalized_path_stem(normalized_path: &str) -> String {
    let base = normalized_path_basename(normalized_path);
    base.rsplit_once('.')
        .map(|(stem, _)| stem.to_string())
        .unwrap_or(base)
}

#[cfg(target_os = "windows")]
fn resolve_windows_launch_exec(exec: &str) -> Option<String> {
    let direct = PathBuf::from(exec.trim_matches('"'));
    if direct.exists() {
        return Some(direct.to_string_lossy().into_owned());
    }
    windows_shortcuts()
        .into_iter()
        .find(|shortcut| shortcut_matches(exec, shortcut))
        .map(|shortcut| shortcut.target_path.to_string_lossy().into_owned())
}

/// Build the [`Command`] that runs `script_path` on Windows, choosing an
/// interpreter by extension: `.ps1` is run through PowerShell with an execution
/// policy bypass; anything else is handed to `cmd /C`, which executes `.bat`/
/// `.cmd` directly and otherwise opens the file via its shell association. Either
/// way the returned command spawns a child whose exit status the caller can wait
/// on for the `script-finished` event.
///
/// `args` is the raw argument string from the file tree's ▶ popover, appended
/// unparsed (`raw_arg`) so the interpreter splits it exactly as it would in the
/// foreground terminal tab.
#[cfg(target_os = "windows")]
fn windows_script_command(script_path: &str, args: Option<&str>) -> Command {
    use std::os::windows::process::CommandExt;
    let is_ps1 = Path::new(script_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ps1"));
    // `command_no_window` sets CREATE_NO_WINDOW so a background "run script"
    // action doesn't pop a transient console window — its output is intentionally
    // not surfaced (callers wanting output open a terminal tab instead).
    let mut cmd = if is_ps1 {
        let mut cmd = crate::paths::command_no_window("powershell");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
        cmd.arg(script_path);
        cmd
    } else {
        let mut cmd = crate::paths::command_no_window("cmd");
        cmd.args(["/D", "/C", script_path]);
        cmd
    };
    if let Some(extra) = args.map(str::trim).filter(|a| !a.is_empty()) {
        cmd.raw_arg(extra);
    }
    cmd
}

/// Build the [`Command`] that runs `script_path` detached on Unix: `bash <path>`,
/// or — when the ▶ popover set arguments — `bash -c 'exec bash "$0" <args>' <path>`,
/// so the raw argument string is word-split, quote-removed and expanded by a shell
/// exactly as the foreground terminal tab's command line would be. The path rides
/// as `$0`, never inside the `-c` string, so a path with quotes cannot break it.
#[cfg(not(target_os = "windows"))]
fn unix_script_command(script_path: &str, args: Option<&str>) -> Command {
    let mut cmd = Command::new("bash");
    match args.map(str::trim).filter(|a| !a.is_empty()) {
        Some(extra) => {
            cmd.arg("-c")
                .arg(format!("exec bash \"$0\" {extra}"))
                .arg(script_path);
        }
        None => {
            cmd.arg(script_path);
        }
    }
    cmd
}

#[cfg(target_os = "windows")]
fn resolve_windows_app_icon(exec: &str) -> Option<String> {
    let direct = PathBuf::from(exec.trim_matches('"'));
    if direct.exists() {
        if direct
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
        {
            return resolve_windows_shortcut(&direct)
                .and_then(|shortcut| shortcut.icon_path.or(Some(shortcut.target_path)))
                .and_then(|path| windows_icon_to_data_url(&path));
        }
        return windows_icon_to_data_url(&direct);
    }

    windows_shortcuts()
        .into_iter()
        .find(|shortcut| shortcut_matches(exec, shortcut))
        .and_then(|shortcut| shortcut.icon_path.or(Some(shortcut.target_path)))
        .and_then(|path| windows_icon_to_data_url(&path))
}

#[cfg(target_os = "windows")]
fn windows_shortcuts() -> Vec<ShortcutEntry> {
    let mut roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(
            PathBuf::from(appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    if let Some(program_data) = std::env::var_os("ProgramData") {
        roots.push(
            PathBuf::from(program_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }

    let mut shortcuts = Vec::new();
    for root in roots {
        collect_windows_shortcuts(&root, 4, &mut shortcuts);
    }
    shortcuts
}

#[cfg(target_os = "windows")]
fn collect_windows_shortcuts(dir: &Path, depth: usize, out: &mut Vec<ShortcutEntry>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_windows_shortcuts(&path, depth - 1, out);
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
        {
            if let Some(shortcut) = resolve_windows_shortcut(&path) {
                out.push(shortcut);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn resolve_windows_shortcut(path: &Path) -> Option<ShortcutEntry> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist: IPersistFile = link.cast().ok()?;
        let wide = wide_null(path.as_os_str());
        persist.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;

        let mut target_buf = [0u16; 32768];
        link.GetPath(&mut target_buf, std::ptr::null_mut(), 0)
            .ok()?;
        let target = utf16_buf_to_path(&target_buf)?;

        let mut icon_buf = [0u16; 32768];
        let mut icon_index = 0i32;
        let icon_path = link
            .GetIconLocation(&mut icon_buf, &mut icon_index)
            .ok()
            .and_then(|_| utf16_buf_to_path(&icon_buf));

        Some(ShortcutEntry {
            display_name: path.file_stem()?.to_string_lossy().into_owned(),
            shortcut_path: path.to_path_buf(),
            target_path: target,
            icon_path,
        })
    }
}

#[cfg(target_os = "windows")]
fn windows_icon_to_data_url(path: &Path) -> Option<String> {
    // A raster `.png` is already a valid `<img>` source, so inline it directly
    // with the correct MIME. Everything else — `.exe`/`.dll` (no embedded raster),
    // `.ico` (whose `image/png` mislabel did not render reliably), or an extension-
    // less target — is rasterized through the shell to a real PNG data URL below.
    // Returning a bare filesystem path here (the prior behaviour) produced an
    // `<img src="C:\...\app.exe">` the WebView cannot load, hence blank icons.
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
    {
        return icon_to_data_url(path);
    }
    extract_windows_icon_png(path)
}

/// Rasterize the shell icon for `path` (an `.exe`/`.ico`/`.dll`/associated file)
/// to a base64 PNG data URL via GDI. Returns `None` on any failure so the
/// frontend falls back to its glyph rather than rendering a broken image. Every
/// GDI/shell handle acquired here is released on all paths.
#[cfg(target_os = "windows")]
fn extract_windows_icon_png(path: &Path) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    // SAFETY: the HICON returned in `info.hIcon` is destroyed before returning on
    // both the success and failure paths.
    unsafe {
        let wide = wide_null(path.as_os_str());
        let mut info = SHFILEINFOW::default();
        let res = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if res == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let rgba = hicon_to_rgba(info.hIcon);
        let _ = DestroyIcon(info.hIcon);
        let (width, height, pixels) = rgba?;
        encode_png_data_url(width, height, &pixels)
    }
}

/// Convert an `HICON` to a top-down RGBA buffer `(width, height, pixels)`. The
/// icon's color bitmap supplies BGR (and per-pixel alpha for modern 32-bit
/// icons); when that alpha channel is entirely zero — legacy icons — opacity is
/// reconstructed from the 1-bpp AND mask instead. The color/mask GDI bitmaps from
/// `GetIconInfo` are deleted on every path.
#[cfg(target_os = "windows")]
unsafe fn hicon_to_rgba(
    hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
) -> Option<(u32, u32, Vec<u8>)> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    let mut icon_info = ICONINFO::default();
    if GetIconInfo(hicon, &mut icon_info).is_err() {
        return None;
    }
    let color = icon_info.hbmColor;
    let mask = icon_info.hbmMask;

    let result = (|| {
        if color.is_invalid() {
            return None;
        }
        let mut bmp = BITMAP::default();
        let got = GetObjectW(
            HGDIOBJ(color.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut BITMAP as *mut c_void),
        );
        if got == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
            return None;
        }
        let width = bmp.bmWidth;
        let height = bmp.bmHeight;
        let pixel_count = (width as usize) * (height as usize);

        // Negative biHeight requests top-down rows (the order the PNG encoder
        // wants); 32-bit BI_RGB unpacks any source depth to BGRA scanlines.
        let header = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };

        let dc = GetDC(None);
        if dc.is_invalid() {
            return None;
        }

        let read_dib = |hbm: windows::Win32::Graphics::Gdi::HBITMAP, buf: &mut [u8]| -> bool {
            let mut info = BITMAPINFO {
                bmiHeader: header,
                ..Default::default()
            };
            GetDIBits(
                dc,
                hbm,
                0,
                height as u32,
                Some(buf.as_mut_ptr() as *mut c_void),
                &mut info,
                DIB_RGB_COLORS,
            ) != 0
        };

        let mut pixels = vec![0u8; pixel_count * 4];
        let outcome = (|| {
            if !read_dib(color, &mut pixels) {
                return None;
            }
            // Reconstruct alpha from the AND mask when the color bitmap carries
            // none (mask: 0 = opaque, white = transparent).
            if !pixels.as_chunks::<4>().0.iter().any(|px| px[3] != 0) && !mask.is_invalid() {
                let mut mask_px = vec![0u8; pixel_count * 4];
                if read_dib(mask, &mut mask_px) {
                    for (px, m) in pixels.as_chunks_mut::<4>().0.iter_mut().zip(mask_px.as_chunks::<4>().0) {
                        px[3] = if m[0] == 0 { 0xFF } else { 0x00 };
                    }
                } else {
                    for px in pixels.as_chunks_mut::<4>().0 {
                        px[3] = 0xFF;
                    }
                }
            }
            // GDI delivers BGRA; the PNG encoder wants RGBA.
            for px in pixels.as_chunks_mut::<4>().0 {
                px.swap(0, 2);
            }
            Some((width as u32, height as u32, pixels))
        })();

        ReleaseDC(None, dc);
        outcome
    })();

    if !color.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(color.0));
    }
    if !mask.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(mask.0));
    }
    result
}

/// Encode a top-down RGBA buffer to a base64 `data:image/png` URL in memory.
#[cfg(target_os = "windows")]
fn encode_png_data_url(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    let mut buf = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buf, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64_encode(&buf)))
}

#[cfg(target_os = "windows")]
fn wide_null(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn utf16_buf_to_path(buf: &[u16]) -> Option<PathBuf> {
    let len = buf.iter().position(|&ch| ch == 0).unwrap_or(buf.len());
    if len == 0 {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
}

fn desktop_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    for dir in xdg_application_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("desktop") {
                files.push(path);
            }
        }
    }
    files
}

fn parse_desktop_entry(path: &Path) -> Option<DesktopEntry> {
    let content = fs::read_to_string(path).ok()?;
    let mut in_desktop_entry = false;
    let mut exec = None;
    let mut icon = None;
    for raw in content.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        if let Some(value) = line.strip_prefix("Exec=") {
            exec = parse_exec_command(value);
        } else if let Some(value) = line.strip_prefix("Icon=") {
            icon = Some(value.to_string());
        }
    }
    Some(DesktopEntry {
        exec: exec?,
        icon: icon?,
    })
}

/// Parse a desktop-entry `Exec=` value into the literal command line to launch.
///
/// Desktop field codes (`%f`, `%U`, `%i`, ...) are placeholders the file/URL
/// argument fills in separately (see `file` in [`launch_command`]), and
/// Flatpak's `@@...@@` quoting markers wrap those placeholders, so both are
/// dropped. Every remaining token is kept and rejoined with single spaces —
/// unlike a first-token-only parse, this preserves multi-word launchers such as
/// Flatpak's `flatpak run --branch=stable --command=entrypoint app.id`, which
/// would otherwise be truncated to a bare `flatpak` with no way to know which
/// app to run.
pub(crate) fn parse_exec_command(value: &str) -> Option<String> {
    let tokens: Vec<&str> = value
        .split_whitespace()
        .filter(|part| !part.starts_with('%') && !part.starts_with("@@"))
        .map(|part| part.trim_matches('"'))
        .filter(|part| !part.is_empty())
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

fn resolve_icon_path(icon: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(icon);
    if direct.is_absolute() && direct.exists() {
        return Some(direct);
    }

    let names = [
        format!("{icon}.svg"),
        format!("{icon}.png"),
        format!("{icon}.xpm"),
        icon.to_string(),
    ];
    let mut roots = vec![
        PathBuf::from("/usr/share/pixmaps"),
        PathBuf::from("/usr/local/share/pixmaps"),
        PathBuf::from("/usr/share/icons/hicolor"),
        PathBuf::from("/usr/share/icons/Adwaita"),
        PathBuf::from("/usr/share/icons/breeze"),
        PathBuf::from("/usr/share/icons/breeze-dark"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        roots.insert(0, home.join(".local/share/icons"));
        roots.insert(1, home.join(".icons"));
    }

    for root in roots {
        if let Some(path) = find_icon_file(&root, &names, 5) {
            return Some(path);
        }
    }
    None
}

fn find_icon_file(dir: &Path, names: &[String], depth: usize) -> Option<PathBuf> {
    if depth == 0 || !dir.is_dir() {
        return None;
    }
    let entries: Vec<_> = fs::read_dir(dir).ok()?.flatten().collect();
    for entry in &entries {
        let path = entry.path();
        if path.is_file() {
            let file_name = path.file_name()?.to_string_lossy();
            if names.iter().any(|name| name == file_name.as_ref()) {
                return Some(path);
            }
        }
    }
    for entry in &entries {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_icon_file(&path, names, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn list_tracked_windows(
    registry: State<'_, WindowRegistryState>,
    project_id: Option<String>,
) -> Vec<TrackedWindow> {
    let reg = registry.lock_ok();
    reg.windows
        .values()
        .filter(|w| {
            project_id
                .as_deref()
                .is_none_or(|pid| w.project_id.as_deref() == Some(pid))
        })
        .cloned()
        .collect()
}

#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn untrack_window(registry: State<'_, WindowRegistryState>, id: String) -> bool {
    registry.lock_ok().windows.remove(&id).is_some()
}

/// Close a tracked app from the Apps view: SIGTERM its whole process subtree
/// (SIGKILL after a grace — `terminal`'s tab-close primitive), remove the
/// registry row, and announce the change. Refuses rows that cannot be safely
/// signalled: detached subwindows and anything carrying Tabtivity's own pid
/// (killing that subtree would kill Tabtivity), and pid-0 rows (OS-default opens,
/// demoted hand-offs — nothing to signal; the frontend falls back to a plain
/// untrack).
///
/// The row is removed HERE rather than by the exit watcher: the watcher's
/// hand-off guard can still see the dying window on screen and would demote
/// the row to a pid-0 ghost instead of dropping it.
#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn close_tracked_window(
    registry: State<'_, WindowRegistryState>,
    id: String,
) -> Result<(), String> {
    let (entry, notify) = {
        let reg = registry.lock_ok();
        (reg.windows.get(&id).cloned(), reg.notify.clone())
    };
    let Some(entry) = entry else {
        return Err("unknown window".into());
    };
    if entry.origin == ORIGIN_DETACHED_SUBWINDOW || entry.pid == std::process::id() {
        return Err("not closeable: app-owned window".into());
    }
    if entry.pid == 0 {
        return Err("not closeable: no tracked pid".into());
    }
    crate::terminal::reap_child_subtree(entry.pid, crate::terminal::ReapMode::Graceful);
    registry.lock_ok().windows.remove(&id);
    if let Some(notify) = notify {
        notify(entry.project_id.clone());
    }
    Ok(())
}

/// Backstop for the exit watcher: drop Apps-view rows in the given scope whose
/// app is gone AND whose window (when one was resolved) is no longer on
/// screen. Catches any wait-thread miss; PID reuse can keep a dead row listed
/// (documented limitation, `docs/CODE_REVIEW_SECURITY.md`).
///
/// A row's app is its pid until the launcher exits, then its launch family
/// (any member alive; the row moves to the oldest live one). A row whose
/// launcher died but whose exit watcher has not decided yet is left to the
/// watcher. When the window list cannot tell — Wayland, for a row without an
/// XWayland window id — a dead row is demoted to pid 0 (delist-only) instead
/// of removed; a failed enumeration changes nothing. A pid-0 row holding a
/// window id (a hand-off that adopted one, a raised IDE window) lives while
/// that window does, on Linux, whose X client list keeps a parked window
/// listed; elsewhere, and without a window id, a pid-0 row has no liveness
/// signal and is never pruned.
///
/// Every windowless row of the scope also gets one try at its window
/// ([`resolve_missing_launch_windows`]), so the view sees a late window
/// without waiting for a project switch. The two share one window scan, made
/// only when either needs it.
///
/// The Apps-view read (`get_opened_windows`, off the main thread): the
/// registry is locked only to pick the candidates and to apply the answers —
/// the marked-process lookups and the window scan (an X round trip; under
/// Wayland it may start XWayland) run unlocked, so a launch, an exit watcher
/// or a project switch never waits on them behind a read. A row that changed
/// in between is left for the next read. Returns the scope's Apps-view rows.
pub fn prune_dead_windows(registry: &WindowRegistryState, project_id: Option<&str>) -> Vec<TrackedWindow> {
    // An unprobeable pid (`EPERM`) is not dead: its window stays tracked.
    let alive = |pid| crate::services::proc_table::pid_state(pid) != crate::services::proc_table::PidState::Gone;
    let resolve = cfg!(all(target_os = "linux", feature = "desktop"));
    prune_dead_windows_unlocked(
        registry,
        project_id,
        resolve,
        alive,
        live_family_lead,
        marked_pids_now,
        window_scan,
    )
}

/// [`prune_dead_windows`] with every probe injected: `resolve` turns the
/// read-time window resolve on (Linux desktop), `marked` and `scan` are only
/// ever called with the registry unlocked.
fn prune_dead_windows_unlocked(
    registry: &WindowRegistryState,
    project_id: Option<&str>,
    resolve: bool,
    alive: impl Fn(u32) -> bool,
    live_lead: impl Fn(&[FamilyMember]) -> Option<u32>,
    marked: impl Fn(&str, u64) -> Vec<u32>,
    scan: impl FnOnce() -> (WindowList, Vec<ClientWindow>),
) -> Vec<TrackedWindow> {
    // 1. Locked: what the resolve asks about, and the prune's candidates.
    let (asks, dead) = {
        let mut reg = registry.lock_ok();
        let asks = if resolve { resolve_asks(&reg, project_id) } else { Vec::new() };
        let dead = prune_candidates(&mut reg, project_id, alive, live_lead, PID0_WINDOW_LIVENESS);
        (asks, dead)
    };
    // 2. Unlocked: the marked processes per launch, and the one scan.
    let mut marked_by_launch: HashMap<String, Vec<u32>> = HashMap::new();
    let mut resolve_needs_scan = false;
    for ask in &asks {
        let pids = match &ask.launch {
            Some((launch_id, since)) => marked_by_launch
                .entry(launch_id.clone())
                .or_insert_with(|| marked(launch_id, *since))
                .clone(),
            None => Vec::new(),
        };
        resolve_needs_scan |= ask.pid != 0 || ask.adopt || !pids.is_empty();
    }
    let scanned = (resolve_needs_scan || !dead.is_empty()).then(scan);
    // 3. Locked: apply. A row new since step 1 resolves next read.
    let mut reg = registry.lock_ok();
    if let Some((list, clients)) = &scanned {
        if resolve {
            resolve_missing_launch_windows_with(
                &mut reg,
                project_id,
                || clients.as_slice(),
                |launch_id, _| marked_by_launch.get(launch_id).cloned().unwrap_or_default(),
            );
        }
        apply_prune(&mut reg, dead, list);
    }
    opened_windows_for_project(reg.windows.values(), project_id)
}

/// One windowless row the read-time resolve may look up: its launch marker
/// and floor (for `proc_table::marked_procs`), its pid, and whether it is a
/// pid-0 IDE row that adopts by project title.
struct ResolveAsk {
    launch: Option<(String, u64)>,
    pid: u32,
    adopt: bool,
}

/// The rows [`resolve_missing_launch_windows_with`] would try in `project_id`,
/// read without touching the registry.
fn resolve_asks(reg: &WindowRegistry, project_id: Option<&str>) -> Vec<ResolveAsk> {
    reg.windows
        .values()
        // `window_service::resolve_missing_window_ids`'s row filter.
        .filter(|w| {
            w.project_id.as_deref() == project_id && is_project_opened_window(w) && w.window_id.is_none()
        })
        .map(|w| {
            let track = reg.launches.get(&w.id);
            ResolveAsk {
                launch: w.launch_id.clone().zip(track.map(|t| t.since)),
                pid: w.pid,
                adopt: w.pid == 0
                    && w.origin == ORIGIN_PROJECT_IDE
                    && track.is_some_and(|t| t.ide_project.is_some()),
            }
        })
        .collect()
}

/// Whether a pid-0 row with a window id is judged by its window alone. Only
/// the X client list (Linux) lists a window the parking backend hid; Windows
/// and macOS enumerate visible windows, which would prune a parked one.
const PID0_WINDOW_LIVENESS: bool = cfg!(target_os = "linux");

/// The prune alone, over one registry already in hand — [`prune_candidates`]
/// then [`apply_prune`] with the window list fetched only for a candidate.
/// The tests' seam; [`prune_dead_windows`] splits the two around its scan.
#[cfg(test)]
fn prune_dead_windows_with(
    reg: &mut WindowRegistry,
    project_id: Option<&str>,
    alive: impl Fn(u32) -> bool,
    live_lead: impl Fn(&[FamilyMember]) -> Option<u32>,
    window_list: impl FnOnce() -> WindowList,
    pid0_window_liveness: bool,
) {
    let dead = prune_candidates(reg, project_id, alive, live_lead, pid0_window_liveness);
    if dead.is_empty() {
        return;
    }
    // Paid only when a dead candidate exists — one OS window enumeration.
    apply_prune(reg, dead, &window_list());
}

/// A row [`prune_candidates`] found dead: its id, and the window id and pid it
/// had then — [`apply_prune`] leaves a row that has changed since alone.
type DeadRow = (String, Option<u64>, u32);

/// The first half of the prune: sweeps launch tracks without a row, moves a
/// family-kept row to its live lead, and returns the rows whose app is gone
/// (and, with `pid0_window_liveness`, every pid-0 row holding a window id),
/// for [`apply_prune`] to judge by the window list.
fn prune_candidates(
    reg: &mut WindowRegistry,
    project_id: Option<&str>,
    alive: impl Fn(u32) -> bool,
    live_lead: impl Fn(&[FamilyMember]) -> Option<u32>,
    pid0_window_liveness: bool,
) -> Vec<DeadRow> {
    let WindowRegistry { windows, launches, .. } = reg;
    launches.retain(|id, _| windows.contains_key(id));
    let mut dead: Vec<DeadRow> = Vec::new();
    for w in windows.values_mut() {
        if w.project_id.as_deref() != project_id || !is_project_opened_window(w) {
            continue;
        }
        if w.pid == 0 {
            if pid0_window_liveness && w.window_id.is_some() {
                dead.push((w.id.clone(), w.window_id, 0));
            }
            continue;
        }
        match launches.get(&w.id) {
            // The exit watcher owns a launcher that just died.
            Some(LaunchTrack { family: None, .. }) => {}
            Some(LaunchTrack { family: Some(family), .. }) => match live_lead(family) {
                Some(lead) => w.pid = lead,
                None => dead.push((w.id.clone(), w.window_id, w.pid)),
            },
            None if !alive(w.pid) => dead.push((w.id.clone(), w.window_id, w.pid)),
            None => {}
        }
    }
    dead
}

/// The second half of the prune: each `dead` row still as it was found is
/// removed when `list` proves its window gone, demoted to pid 0 when the list
/// cannot tell, and kept when its window is listed. An `Unknown` list changes
/// nothing.
fn apply_prune(reg: &mut WindowRegistry, dead: Vec<DeadRow>, list: &WindowList) {
    if *list == WindowList::Unknown {
        return;
    }
    let WindowRegistry { windows, launches, .. } = reg;
    for (id, wid, pid) in dead {
        let unchanged = windows.get(&id).is_some_and(|w| w.window_id == wid && w.pid == pid);
        if !unchanged {
            continue;
        }
        match list.shows(wid) {
            Some(true) => {}
            Some(false) => {
                windows.remove(&id);
                launches.remove(&id);
            }
            None => {
                if let Some(w) = windows.get_mut(&id) {
                    w.pid = 0;
                }
            }
        }
    }
}

fn track_opened_file(
    registry: &WindowRegistryState,
    exec: String,
    path: String,
    pid: u32,
    project_id: Option<String>,
    window_id: Option<u64>,
    origin: String,
) -> Result<TrackedWindow, String> {
    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let id_suffix = window_id.unwrap_or(pid as u64);
    let id = format!("file-{id_suffix}-{opened_at:.0}");
    let win = TrackedWindow {
        id: id.clone(),
        exec,
        file: Some(path),
        pid,
        project_id,
        role: None,
        opened_at,
        window_id,
        origin,
        launch_id: None,
    };
    registry.lock_ok().windows.insert(id, win.clone());
    Ok(win)
}

/// One client window as launch tracking sees it: its id (X11 window id /
/// Windows `HWND`), `_NET_WM_PID`, whether its class is protected
/// (`platform::x11::is_protected_class`), its `WM_CLASS` (raw,
/// NUL-separated) and its `_NET_WM_NAME` title.
#[derive(Debug, Clone, Default)]
pub(crate) struct ClientWindow {
    pub id: u64,
    pub pid: Option<u32>,
    pub protected: bool,
    pub class: String,
    pub title: String,
}

/// The window ids rows other than `own` hold.
fn held_window_ids(reg: &WindowRegistry, own: &str) -> HashSet<u64> {
    reg.windows
        .values()
        .filter(|w| w.id != own)
        .filter_map(|w| w.window_id)
        .collect()
}

/// The window launch row `row` shows, among one scan's `windows`: a
/// non-protected client window whose `_NET_WM_PID` is one of `marked` (the
/// launch's marked processes) and that no other row holds (`held`). For an
/// `ORIGIN_PROJECT_IDE` row the window must also show the row's project
/// (`ide`: the IDE and its project-window names; `None` resolves nothing for
/// such a row) — one JVM can host several projects' windows, and the marker
/// leaks into whatever the app starts, so a marked pid alone does not make a
/// window the row's. Native Wayland windows are never listed, so never found.
pub(crate) fn resolve_window_for_launch(
    row: &TrackedWindow,
    windows: &[ClientWindow],
    marked: &[u32],
    held: &HashSet<u64>,
    ide: Option<(crate::services::ide_detect::IdeId, &[String])>,
) -> Option<u64> {
    let ide_row = row.origin == ORIGIN_PROJECT_IDE;
    windows
        .iter()
        .filter(|w| !w.protected && !held.contains(&w.id))
        .filter(|w| w.pid.is_some_and(|pid| marked.contains(&pid)))
        .find(|w| {
            !ide_row
                || ide.is_some_and(|(ide, names)| {
                    crate::services::ide_detect::window_shows_project(ide, &w.class, &w.title, names)
                })
        })
        .map(|w| w.id)
}

/// The window of `ide` that shows the project (`names`, see
/// `ide_detect::window_shows_project`) among one scan's `windows`, skipping
/// protected windows and those another row holds — what an IDE hand-off
/// adopts, since its window belongs to the running instance, not to a
/// process of the launch.
fn adopt_project_window(
    windows: &[ClientWindow],
    held: &HashSet<u64>,
    ide: crate::services::ide_detect::IdeId,
    names: &[String],
) -> Option<u64> {
    windows
        .iter()
        .filter(|w| !w.protected && !held.contains(&w.id))
        .find(|w| crate::services::ide_detect::window_shows_project(ide, &w.class, &w.title, names))
        .map(|w| w.id)
}

/// One-pass resolve of every window id `project_id`'s project-owned rows
/// still lack (`window_service::resolve_missing_window_ids`), from one window
/// scan: a JVM window mapped after the launch's own 2 s budget, or an XWayland
/// window that appeared later. Run at project-switch time (before the hide)
/// and on every Apps-view read ([`prune_dead_windows`]). Linux only — Windows
/// and macOS resolve by pid (`resolve_window_id_for_pid`); a no-op elsewhere.
/// The scan runs only when a row has something to resolve by.
pub fn resolve_missing_launch_windows(reg: &mut WindowRegistry, project_id: Option<&str>) {
    if !cfg!(all(target_os = "linux", feature = "desktop")) {
        return;
    }
    let scan = std::cell::OnceCell::new();
    resolve_missing_launch_windows_with(
        reg,
        project_id,
        || scan.get_or_init(window_scan).1.as_slice(),
        marked_pids_now,
    );
}

/// The pids of launch `launch_id`'s marked processes, from the cached process
/// table (`proc_table::snapshot`). Empty off Linux.
fn marked_pids_now(launch_id: &str, since: u64) -> Vec<u32> {
    let snap = crate::services::proc_table::snapshot();
    crate::services::proc_table::marked_procs(&snap, launch_id, since)
        .into_iter()
        .map(|p| p.pid)
        .collect()
}

/// [`resolve_missing_launch_windows`] with the scan (`windows`, called only
/// when a row has pids or an IDE project to resolve by) and the marked-process
/// lookup (`marked(launch_id, since)`) injected. A row resolves through
/// [`resolve_window_for_launch`] over its marked pids plus its own pid (none
/// for a pid-0 row); a pid-0 IDE row that knows its project (a hand-off, a
/// launch whose family died) adopts the IDE's window showing the project
/// ([`adopt_project_window`]). A window one row takes is held for the rest.
fn resolve_missing_launch_windows_with<'a>(
    reg: &mut WindowRegistry,
    project_id: Option<&str>,
    windows: impl Fn() -> &'a [ClientWindow],
    marked: impl Fn(&str, u64) -> Vec<u32>,
) {
    let WindowRegistry { windows: rows, launches, .. } = reg;
    let mut held: HashSet<u64> = rows.values().filter_map(|w| w.window_id).collect();
    crate::services::window_service::resolve_missing_window_ids(rows, project_id, |row| {
        let track = launches.get(&row.id);
        let mut pids = match (&row.launch_id, track) {
            (Some(launch_id), Some(track)) => marked(launch_id, track.since),
            _ => Vec::new(),
        };
        if row.pid != 0 && !pids.contains(&row.pid) {
            pids.push(row.pid);
        }
        let ide = track
            .and_then(|t| t.ide_project.as_ref())
            .map(|(ide, names)| (*ide, names.as_slice()));
        let adopt = row.pid == 0 && row.origin == ORIGIN_PROJECT_IDE && ide.is_some();
        if pids.is_empty() && !adopt {
            return None;
        }
        let clients = windows();
        let found = resolve_window_for_launch(row, clients, &pids, &held, ide).or_else(|| {
            ide.filter(|_| adopt)
                .and_then(|(ide, names)| adopt_project_window(clients, &held, ide, names))
        });
        if let Some(id) = found {
            held.insert(id);
        }
        found
    });
}

/// The row "Open in <IDE>" records for a window it raised instead of
/// launching — one this run never launched (the IDE was open before Tabtivity
/// started, or was opened outside it): a pid-0 [`ORIGIN_PROJECT_IDE`] row
/// holding that window, so the window is listed in the project's Apps view
/// and parked on a switch. It lives while the window does
/// ([`prune_dead_windows`]). `exec` is the IDE's launcher, `target` what it
/// is handed.
pub fn row_for_raised_window(
    window_id: u64,
    exec: &str,
    target: &str,
    project_id: &str,
    opened_at: f64,
) -> TrackedWindow {
    TrackedWindow {
        id: format!("ide-window-{window_id}"),
        exec: exec.to_string(),
        file: Some(target.to_string()),
        pid: 0,
        project_id: Some(project_id.to_string()),
        role: Some("ide".to_string()),
        opened_at,
        window_id: Some(window_id),
        origin: ORIGIN_PROJECT_IDE.to_string(),
        launch_id: None,
    }
}

/// The registry row holding `window_id`, or — when none does — a new
/// [`row_for_raised_window`] inserted for it. The raise path of "Open in
/// <IDE>" (`commands::ide`).
pub fn track_raised_window(
    reg: &mut WindowRegistry,
    window_id: u64,
    exec: &str,
    target: &str,
    project_id: &str,
) -> TrackedWindow {
    if let Some(row) = reg.windows.values().find(|w| w.window_id == Some(window_id)) {
        return row.clone();
    }
    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let row = row_for_raised_window(window_id, exec, target, project_id, opened_at);
    reg.windows.insert(row.id.clone(), row.clone());
    row
}

/// How many passes a window scan with a budget of `attempts` makes. Under
/// Wayland a scan sees only XWayland windows and most launched apps are
/// native, so it is one pass and never the retry loop's 100 ms sleeps (the
/// stall 5a0b51c1 removed); X11 keeps the loop.
#[cfg(all(target_os = "linux", feature = "desktop"))]
fn scan_attempts(attempts: usize) -> usize {
    if crate::platform::x11::session_is_wayland() {
        attempts.min(1)
    } else {
        attempts
    }
}

/// One window enumeration: what the list can say ([`WindowList`]) and, where
/// the platform reports them, each window's pid, class and title.
#[cfg(all(target_os = "linux", feature = "desktop"))]
fn window_scan() -> (WindowList, Vec<ClientWindow>) {
    match x11_client_windows() {
        Ok(windows) => {
            let ids = windows.iter().map(|w| w.id).collect();
            let list = if crate::platform::x11::session_is_wayland() {
                WindowList::XWaylandOnly(ids)
            } else {
                WindowList::Complete(ids)
            };
            (list, windows)
        }
        Err(_) => (WindowList::Unknown, Vec::new()),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn window_scan() -> (WindowList, Vec<ClientWindow>) {
    (WindowList::Complete(list_window_ids()), Vec::new())
}

#[cfg(any(not(any(target_os = "linux", target_os = "windows", target_os = "macos")), all(target_os = "linux", not(feature = "desktop"))))]
fn window_scan() -> (WindowList, Vec<ClientWindow>) {
    (WindowList::Unknown, Vec::new())
}

#[cfg(all(target_os = "linux", feature = "desktop"))]
fn list_window_ids() -> Vec<u64> {
    // Under Wayland this lists the XWayland clients only — still the
    // baseline `find_new_window` diffs against.
    x11_client_windows()
        .map(|windows| windows.into_iter().map(|w| w.id).collect())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn list_window_ids() -> Vec<u64> {
    crate::platform::windows::list_window_ids()
}

#[cfg(target_os = "macos")]
fn list_window_ids() -> Vec<u64> {
    crate::platform::macos::list_window_ids()
}

#[cfg(any(not(any(target_os = "linux", target_os = "windows", target_os = "macos")), all(target_os = "linux", not(feature = "desktop"))))]
fn list_window_ids() -> Vec<u64> {
    Vec::new()
}

#[cfg(all(target_os = "linux", feature = "desktop"))]
fn find_window_for_pid(pid: u32, attempts: usize) -> Option<u64> {
    for attempt in 0..scan_attempts(attempts) {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if let Ok(windows) = x11_client_windows() {
            if let Some(window) = windows
                .into_iter()
                .find(|w| w.pid == Some(pid) && !w.protected)
            {
                return Some(window.id);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn find_window_for_pid(pid: u32, attempts: usize) -> Option<u64> {
    crate::platform::windows::find_window_for_pid(pid, attempts)
}

#[cfg(target_os = "macos")]
fn find_window_for_pid(pid: u32, attempts: usize) -> Option<u64> {
    crate::platform::macos::find_window_for_pid(pid, attempts)
}

/// Single-pass, non-blocking window-id resolver injected into `window_service`
/// at project-switch (hide) time. A launch-time miss (race, or the visible
/// top-level belonging to a child of the spawned pid) leaves `window_id` None;
/// re-resolving here just before hiding lets such a window still be parked, and
/// the back-populated id keeps the later switch-back SHOW symmetric. `attempts:
/// 1` does one enumeration with no `thread::sleep`, so it never stalls the
/// switch worker.
#[cfg(target_os = "windows")]
pub fn resolve_window_id_for_pid(pid: u32) -> Option<u64> {
    crate::platform::windows::find_window_for_pid(pid, 1)
}

/// macOS twin of the Windows resolver above — the launcher-stub → child-pid
/// hand-off happens with `open`-style launches too.
#[cfg(target_os = "macos")]
pub fn resolve_window_id_for_pid(pid: u32) -> Option<u64> {
    crate::platform::macos::find_window_for_pid(pid, 1)
}

#[cfg(any(not(any(target_os = "linux", target_os = "windows", target_os = "macos")), all(target_os = "linux", not(feature = "desktop"))))]
fn find_window_for_pid(_pid: u32, _attempts: usize) -> Option<u64> {
    None
}

#[cfg(all(target_os = "linux", feature = "desktop"))]
fn find_new_window(before: &[u64], attempts: usize) -> Option<u64> {
    // One pass under Wayland, as in `find_window_for_pid`: `open_file` chains
    // the two, so the loop here was the second half of the up-to-4 s stall.
    for attempt in 0..scan_attempts(attempts) {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if let Ok(windows) = x11_client_windows() {
            if let Some(window) = windows
                .into_iter()
                .find(|w| !before.contains(&w.id) && !w.protected)
            {
                return Some(window.id);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn find_new_window(before: &[u64], attempts: usize) -> Option<u64> {
    crate::platform::windows::find_new_window(before, attempts)
}

#[cfg(target_os = "macos")]
fn find_new_window(before: &[u64], attempts: usize) -> Option<u64> {
    crate::platform::macos::find_new_window(before, attempts)
}

#[cfg(any(not(any(target_os = "linux", target_os = "windows", target_os = "macos")), all(target_os = "linux", not(feature = "desktop"))))]
fn find_new_window(_before: &[u64], _attempts: usize) -> Option<u64> {
    None
}

/// Every `_NET_CLIENT_LIST` window with its pid, class and title, the
/// property requests for all windows sent before any reply is awaited (one
/// round trip, not three per window). Under Wayland the list holds the
/// XWayland clients.
#[cfg(all(target_os = "linux", feature = "desktop"))]
fn x11_client_windows() -> Result<Vec<ClientWindow>, String> {
    use xcb::x::{self, Window};
    use xcb::{Connection, Xid};

    let (conn, screen_num) = Connection::connect(None).map_err(|e| format!("xcb connect: {e}"))?;
    let root = conn
        .get_setup()
        .roots()
        .nth(screen_num as usize)
        .ok_or_else(|| "missing x11 screen".to_string())?
        .root();
    let net_client_list = crate::platform::x11::intern_atom(&conn, b"_NET_CLIENT_LIST")?;
    let net_wm_pid = crate::platform::x11::intern_atom(&conn, b"_NET_WM_PID")?;
    let net_wm_name = crate::platform::x11::intern_atom(&conn, b"_NET_WM_NAME")?;
    let utf8_string = crate::platform::x11::intern_atom(&conn, b"UTF8_STRING")?;
    let reply = conn
        .wait_for_reply(conn.send_request(&x::GetProperty {
            delete: false,
            window: root,
            property: net_client_list,
            r#type: x::ATOM_WINDOW,
            long_offset: 0,
            long_length: 2048,
        }))
        .map_err(|e| e.to_string())?;

    let property = |window: Window, property: x::Atom, r#type: x::Atom, long_length: u32| {
        conn.send_request(&x::GetProperty {
            delete: false,
            window,
            property,
            r#type,
            long_offset: 0,
            long_length,
        })
    };
    let pending: Vec<_> = reply
        .value::<Window>()
        .iter()
        .map(|&window| {
            (
                window,
                property(window, net_wm_pid, x::ATOM_CARDINAL, 1),
                property(window, x::ATOM_WM_CLASS, x::ATOM_STRING, 64),
                property(window, net_wm_name, utf8_string, 128),
            )
        })
        .collect();
    let text = |reply: Result<x::GetPropertyReply, xcb::Error>| {
        reply
            .ok()
            .map(|r| String::from_utf8_lossy(r.value::<u8>()).into_owned())
            .unwrap_or_default()
    };
    Ok(pending
        .into_iter()
        .map(|(window, pid, class, title)| {
            let pid = conn
                .wait_for_reply(pid)
                .ok()
                .and_then(|r| r.value::<u32>().first().copied());
            let class = text(conn.wait_for_reply(class));
            let title = text(conn.wait_for_reply(title));
            ClientWindow {
                id: u64::from(window.resource_id()),
                pid,
                protected: crate::platform::x11::is_protected_class(&class),
                class,
                title,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tracked(project_id: Option<&str>, origin: &str, window_id: Option<u64>) -> TrackedWindow {
        TrackedWindow {
            id: format!("{}-{window_id:?}", project_id.unwrap_or("root")),
            exec: "editor".to_string(),
            file: Some("/tmp/file.txt".to_string()),
            pid: 42,
            project_id: project_id.map(String::from),
            role: None,
            opened_at: 1.0,
            window_id,
            origin: origin.to_string(),
            launch_id: None,
        }
    }

    #[test]
    fn opened_windows_are_only_project_file_ui_windows() {
        let windows = [
            tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(10)),
            tracked(Some("p1"), ORIGIN_MIDDLE_FILE_BROWSER, Some(11)),
            tracked(Some("p1"), ORIGIN_GLOBAL_APP, Some(12)),
            tracked(Some("p1"), ORIGIN_MANUAL_LAUNCH, Some(13)),
            tracked(Some("p2"), ORIGIN_SIDE_FILE_TREE, Some(20)),
            tracked(None, ORIGIN_SIDE_FILE_TREE, Some(30)),
        ];

        let opened = opened_windows_for_project(windows.iter(), Some("p1"));
        let ids = opened
            .into_iter()
            .filter_map(|window| window.window_id)
            .collect::<Vec<_>>();

        assert_eq!(ids, vec![10, 11]);
    }

    #[test]
    fn project_opened_window_predicate_matches_file_ui_origins() {
        assert!(is_project_opened_window(&tracked(
            Some("p1"),
            ORIGIN_SIDE_FILE_TREE,
            Some(1),
        )));
        assert!(is_project_opened_window(&tracked(
            Some("p1"),
            ORIGIN_MIDDLE_FILE_BROWSER,
            Some(1),
        )));
        assert!(!is_project_opened_window(&tracked(
            Some("p1"),
            ORIGIN_GLOBAL_APP,
            Some(1),
        )));
        assert!(!is_project_opened_window(&tracked(
            Some("p1"),
            ORIGIN_MANUAL_LAUNCH,
            Some(1),
        )));
    }

    #[test]
    fn tracked_window_defaults_missing_origin_to_manual_launch() {
        let raw = r#"{
            "id": "old",
            "exec": "editor",
            "file": null,
            "pid": 7,
            "project_id": "p1",
            "role": null,
            "opened_at": 1.0,
            "window_id": 99
        }"#;

        let window: TrackedWindow = serde_json::from_str(raw).unwrap();

        assert_eq!(window.origin, ORIGIN_MANUAL_LAUNCH);
        assert!(!is_project_opened_window(&window));
    }

    // ── base64_encode ──────────────────────────────────────────────────────

    #[test]
    fn base64_empty_input() {
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn base64_one_byte() {
        // "M" = 0x4D → base64 "TQ=="
        assert_eq!(base64_encode(b"M"), "TQ==");
    }

    #[test]
    fn base64_two_bytes() {
        // "Ma" = 0x4D 0x61 → base64 "TWE="
        assert_eq!(base64_encode(b"Ma"), "TWE=");
    }

    #[test]
    fn base64_three_bytes_no_padding() {
        // "Man" = 0x4D 0x61 0x6E → base64 "TWFu"
        assert_eq!(base64_encode(b"Man"), "TWFu");
    }

    #[test]
    fn base64_hello_world() {
        assert_eq!(base64_encode(b"Hello, World!"), "SGVsbG8sIFdvcmxkIQ==");
    }

    #[test]
    fn base64_roundtrip_via_reference_crate() {
        use base64::Engine;

        let input = b"A workspace manager";
        let encoded = base64_encode(input);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("custom encoder should produce valid base64");

        assert_eq!(decoded, input.as_ref());
    }

    #[test]
    fn base64_output_length_is_multiple_of_four() {
        for n in 0..=12usize {
            let input: Vec<u8> = (0..n).map(|i| i as u8).collect();
            let encoded = base64_encode(&input);
            assert_eq!(
                encoded.len() % 4,
                0,
                "length must be divisible by 4 for n={n}"
            );
        }
    }

    // ── origin predicates ──────────────────────────────────────────────────

    #[test]
    fn apps_view_origin_set_is_exactly_the_project_launch_surfaces() {
        // Every origin a project surface launches with shows in the Apps view;
        // global launches and Tabtivity's own detached windows never do.
        for origin in [
            ORIGIN_SIDE_FILE_TREE,
            ORIGIN_MIDDLE_FILE_BROWSER,
            ORIGIN_RESTORED,
            ORIGIN_DOWNLOADS,
            ORIGIN_BLOB_FILE_VIEWER,
            ORIGIN_PROJECT_IDE,
        ] {
            assert!(is_project_opened_origin(origin), "{origin} must be listed");
        }
        for origin in [
            ORIGIN_GLOBAL_APP,
            ORIGIN_MANUAL_LAUNCH,
            ORIGIN_DETACHED_SUBWINDOW,
        ] {
            assert!(
                !is_project_opened_origin(origin),
                "{origin} must not be listed"
            );
        }
    }

    // ── launched_exit_action ───────────────────────────────────────────────

    fn member(pid: u32, start: u64) -> FamilyMember {
        FamilyMember { pid, start }
    }

    #[test]
    fn exit_of_app_whose_window_is_gone_removes_the_row() {
        let x11 = WindowList::Complete(vec![20, 30]);
        assert_eq!(launched_exit_action(Some(10), &x11, None, &[], true), ExitAction::Remove);
        // No window ever resolved and none appeared: on X11 the list is the
        // whole truth, so nothing is left to manage.
        assert_eq!(launched_exit_action(None, &x11, None, &[], true), ExitAction::Remove);
        // Under Wayland the list is still the truth for an XWayland id.
        let wayland = WindowList::XWaylandOnly(vec![20]);
        assert_eq!(launched_exit_action(Some(10), &wayland, None, &[], true), ExitAction::Remove);
    }

    #[test]
    fn exit_with_surviving_window_demotes_to_pid_zero() {
        // Hand-off (browser, `code`): the launcher exited but its window lives.
        let list = WindowList::Complete(vec![10, 20]);
        assert_eq!(
            launched_exit_action(Some(10), &list, None, &[], true),
            ExitAction::KeepDemoted(None)
        );
        // Unresolved launch that produced a new window: keep and adopt it.
        assert_eq!(
            launched_exit_action(None, &list, Some(42), &[], false),
            ExitAction::KeepDemoted(Some(42))
        );
    }

    #[test]
    fn a_live_launch_family_keeps_the_row_under_its_oldest_member() {
        // A wrapper that forked the app and exited: the app runs on.
        let family = [member(301, 90), member(300, 80), member(302, 80)];
        let gone = WindowList::Complete(Vec::new());
        assert_eq!(
            launched_exit_action(Some(10), &gone, None, &family, true),
            ExitAction::KeepFamily { lead: 300, adopt: None }
        );
        // A global launch is kept by its family too.
        assert_eq!(
            launched_exit_action(None, &gone, Some(7), &family, false),
            ExitAction::KeepFamily { lead: 300, adopt: Some(7) }
        );
        // A row that already has a window keeps it: nothing is adopted over it.
        assert_eq!(
            launched_exit_action(Some(10), &gone, Some(7), &family, true),
            ExitAction::KeepFamily { lead: 300, adopt: None }
        );
    }

    #[test]
    fn an_unknowable_window_list_never_removes_a_project_row() {
        // Wayland, no XWayland window id, family dead, nothing adopted: the
        // app may well be a native window nobody can list.
        let wayland = WindowList::XWaylandOnly(vec![1, 2]);
        assert_eq!(
            launched_exit_action(None, &wayland, None, &[], true),
            ExitAction::KeepDemoted(None)
        );
        // A machine-wide launch goes as before.
        assert_eq!(launched_exit_action(None, &wayland, None, &[], false), ExitAction::Remove);
        // A failed enumeration says nothing about any row.
        assert_eq!(
            launched_exit_action(Some(10), &WindowList::Unknown, None, &[], true),
            ExitAction::KeepDemoted(None)
        );
        assert_eq!(
            launched_exit_action(Some(10), &WindowList::Unknown, None, &[], false),
            ExitAction::Remove
        );
    }

    #[test]
    fn window_list_tells_what_it_can() {
        assert_eq!(WindowList::Complete(vec![1]).shows(Some(1)), Some(true));
        assert_eq!(WindowList::Complete(vec![1]).shows(Some(2)), Some(false));
        assert_eq!(WindowList::Complete(vec![1]).shows(None), Some(false));
        assert_eq!(WindowList::XWaylandOnly(vec![1]).shows(Some(1)), Some(true));
        assert_eq!(WindowList::XWaylandOnly(vec![1]).shows(Some(2)), Some(false));
        assert_eq!(WindowList::XWaylandOnly(vec![1]).shows(None), None);
        assert_eq!(WindowList::Unknown.shows(Some(1)), None);
        assert_eq!(WindowList::Unknown.shows(None), None);
    }

    #[test]
    fn family_lead_is_the_oldest_member() {
        assert_eq!(family_lead(&[]), None);
        assert_eq!(family_lead(&[member(9, 50), member(5, 70)]), Some(9));
        // Same start tick: the lower pid.
        assert_eq!(family_lead(&[member(9, 50), member(5, 50)]), Some(5));
    }

    // ── prune_dead_windows ─────────────────────────────────────────────────

    fn registry_of(wins: Vec<TrackedWindow>) -> WindowRegistry {
        let mut reg = WindowRegistry::default();
        for (i, mut w) in wins.into_iter().enumerate() {
            w.id = format!("w{i}");
            reg.windows.insert(w.id.clone(), w);
        }
        reg
    }

    /// `prune_dead_windows_with` for scope p1, with no family member alive.
    fn prune(reg: &mut WindowRegistry, alive: impl Fn(u32) -> bool, list: WindowList) {
        prune_dead_windows_with(reg, Some("p1"), alive, |_| None, move || list, false);
    }

    fn with_family(reg: &mut WindowRegistry, id: &str, family: Option<Vec<FamilyMember>>) {
        reg.launches.insert(id.to_string(), LaunchTrack { since: 1, family, ide_project: None });
    }

    #[test]
    fn prune_drops_dead_pid_rows_and_keeps_live_and_pid_zero_ones() {
        let mut dead = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        dead.pid = 100;
        let mut alive = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        alive.pid = 200;
        let mut opener = tracked(Some("p1"), ORIGIN_DOWNLOADS, Some(7));
        opener.pid = 0; // OS-default open: no liveness signal, never pruned.
        let mut reg = registry_of(vec![dead, alive, opener]);

        prune(&mut reg, |pid| pid == 200, WindowList::Complete(Vec::new()));

        let pids: Vec<u32> = reg.windows.values().map(|w| w.pid).collect();
        assert_eq!(reg.windows.len(), 2);
        assert!(pids.contains(&200), "live pid stays");
        assert!(pids.contains(&0), "pid-0 row stays");
    }

    #[test]
    fn prune_keeps_dead_pid_row_while_its_window_is_still_on_screen() {
        // Hand-off the watcher missed: pid gone, window alive → not pruned.
        let mut w = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(55));
        w.pid = 100;
        let mut reg = registry_of(vec![w]);
        prune(&mut reg, |_| false, WindowList::Complete(vec![55]));
        assert_eq!(reg.windows.len(), 1);
        prune(&mut reg, |_| false, WindowList::Complete(Vec::new()));
        assert!(reg.windows.is_empty(), "window gone too → pruned");
    }

    #[test]
    fn prune_only_touches_the_requested_scope() {
        let mut other = tracked(Some("p2"), ORIGIN_SIDE_FILE_TREE, None);
        other.pid = 100;
        let mut reg = registry_of(vec![other]);
        prune(&mut reg, |_| false, WindowList::Complete(Vec::new()));
        assert_eq!(reg.windows.len(), 1, "p2's row is not p1's to prune");
    }

    #[test]
    fn prune_judges_a_launched_row_by_its_family_once_the_launcher_exited() {
        let mut w = tracked(Some("p1"), ORIGIN_PROJECT_IDE, None);
        w.pid = 100; // the launcher, dead
        let mut reg = registry_of(vec![w]);
        with_family(&mut reg, "w0", Some(vec![member(300, 5), member(301, 6)]));
        // Only 301 still runs: the row stays and moves to it.
        let world = [member(301, 6)];
        let live_lead = |family: &[FamilyMember]| {
            let live: Vec<FamilyMember> = family.iter().copied().filter(|m| world.contains(m)).collect();
            family_lead(&live)
        };
        let list = || WindowList::Complete(Vec::new());
        prune_dead_windows_with(&mut reg, Some("p1"), |_| false, live_lead, list, false);
        assert_eq!(reg.windows["w0"].pid, 301);
        // Family dead, no window: gone.
        prune_dead_windows_with(&mut reg, Some("p1"), |_| true, |_| None, list, false);
        assert!(reg.windows.is_empty());
        assert!(reg.launches.is_empty(), "its launch bookkeeping goes with it");
    }

    #[test]
    fn a_later_marked_process_does_not_keep_a_row_alive() {
        // A Gradle daemon the IDE started after the launcher exited carries
        // the marker and runs on — but it is not in the family.
        let mut w = tracked(Some("p1"), ORIGIN_PROJECT_IDE, None);
        w.pid = 300;
        let mut reg = registry_of(vec![w]);
        with_family(&mut reg, "w0", Some(vec![member(300, 5)]));
        let daemon = member(400, 9);
        let live_lead = |family: &[FamilyMember]| {
            let live: Vec<FamilyMember> = family.iter().copied().filter(|m| *m == daemon).collect();
            family_lead(&live)
        };
        // Even a pid probe that calls the daemon's pid alive is not asked.
        let alive = |pid| pid == 400;
        prune_dead_windows_with(&mut reg, Some("p1"), alive, live_lead, || WindowList::Complete(Vec::new()), false);
        assert!(reg.windows.is_empty());
    }

    #[test]
    fn prune_leaves_a_just_exited_launcher_to_its_watcher() {
        let mut w = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        w.pid = 100;
        let mut reg = registry_of(vec![w]);
        with_family(&mut reg, "w0", None);
        prune(&mut reg, |_| false, WindowList::Complete(Vec::new()));
        assert_eq!(reg.windows["w0"].pid, 100, "the watcher decides, not the read");
    }

    #[test]
    fn under_wayland_a_dead_row_without_a_window_id_is_demoted_not_removed() {
        let mut windowless = tracked(Some("p1"), ORIGIN_PROJECT_IDE, None);
        windowless.pid = 100;
        let mut xwayland = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(55));
        xwayland.pid = 101;
        let mut reg = registry_of(vec![windowless, xwayland]);
        prune(&mut reg, |_| false, WindowList::XWaylandOnly(vec![9]));
        // No id: the list cannot tell → delist-only, still listed.
        assert_eq!(reg.windows["w0"].pid, 0);
        // An XWayland id the list no longer shows: gone.
        assert!(!reg.windows.contains_key("w1"));
    }

    #[test]
    fn a_failed_window_enumeration_prunes_nothing() {
        let mut w = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(55));
        w.pid = 100;
        let mut windowless = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        windowless.pid = 101;
        let mut reg = registry_of(vec![w, windowless]);
        prune(&mut reg, |_| false, WindowList::Unknown);
        assert_eq!(reg.windows["w0"].pid, 100);
        assert_eq!(reg.windows["w1"].pid, 101);
    }

    #[test]
    fn prune_sweeps_launch_bookkeeping_of_rows_gone_elsewhere() {
        let mut reg = registry_of(vec![tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None)]);
        with_family(&mut reg, "w0", None);
        with_family(&mut reg, "closed", Some(Vec::new()));
        prune(&mut reg, |_| true, WindowList::Unknown);
        assert!(reg.launches.contains_key("w0"));
        assert!(!reg.launches.contains_key("closed"));
    }

    // ── resolve_window_for_launch ──────────────────────────────────────────

    fn client(id: u64, pid: Option<u32>, class: &str, title: &str) -> ClientWindow {
        ClientWindow { id, pid, protected: false, class: class.to_string(), title: title.to_string() }
    }

    fn pycharm_windows() -> Vec<ClientWindow> {
        let class = "jetbrains-pycharm\0jetbrains-pycharm\0";
        vec![
            client(1, Some(999), class, "proj – main.py"),
            ClientWindow { protected: true, ..client(2, Some(300), "plasmashell\0plasmashell\0", "") },
            client(3, Some(300), class, "other – util.py"),
            client(4, Some(301), class, "proj – main.py"),
        ]
    }

    #[test]
    fn resolver_takes_a_marked_pid_window_no_other_row_holds() {
        let row = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        let windows = pycharm_windows();
        let none = HashSet::new();
        // 1 is unmarked, 2 protected: the first marked one is 3.
        assert_eq!(resolve_window_for_launch(&row, &windows, &[300, 301], &none, None), Some(3));
        // Another row holds 3.
        let held: HashSet<u64> = [3].into();
        assert_eq!(resolve_window_for_launch(&row, &windows, &[300, 301], &held, None), Some(4));
        // No marked process: nothing.
        assert_eq!(resolve_window_for_launch(&row, &windows, &[], &none, None), None);
    }

    #[test]
    fn resolver_takes_only_a_window_showing_the_project_for_an_ide_row() {
        use crate::services::ide_detect::IdeId;
        let row = tracked(Some("p1"), ORIGIN_PROJECT_IDE, None);
        let windows = pycharm_windows();
        let names = vec!["proj".to_string()];
        let none = HashSet::new();
        let ide = Some((IdeId::PyCharm, names.as_slice()));
        // 3 is the same JVM's window on another project.
        assert_eq!(resolve_window_for_launch(&row, &windows, &[300, 301], &none, ide), Some(4));
        let held: HashSet<u64> = [4].into();
        assert_eq!(resolve_window_for_launch(&row, &windows, &[300, 301], &held, ide), None);
        // Unmarked even though it shows the project.
        assert_eq!(resolve_window_for_launch(&row, &windows, &[300], &none, ide), None);
        // No IDE facts for the row: nothing is resolved.
        assert_eq!(resolve_window_for_launch(&row, &windows, &[300, 301], &none, None), None);
    }

    // ── IDE hand-off adoption at launcher exit ─────────────────────────────

    fn no_new_window() -> Option<u64> {
        panic!("the any-new-window guess must not be asked")
    }

    #[test]
    fn an_ide_hand_off_adopts_the_window_showing_the_project() {
        use crate::services::ide_detect::IdeId;
        // The launcher handed the folder to a running PyCharm (pid 999) and
        // exited: no family, so no marked pid owns the window.
        let row = tracked(Some("p1"), ORIGIN_PROJECT_IDE, None);
        let windows = pycharm_windows();
        let names = vec!["proj".to_string()];
        let ide = Some((IdeId::PyCharm, names.as_slice()));
        let none = HashSet::new();
        let adopted = exit_adoption(&row, &windows, &[], &none, ide, no_new_window);
        assert_eq!(adopted, Some(1), "the project window, not 'any new window'");
        // The row is kept delist-only, holding the adopted window.
        let list = WindowList::XWaylandOnly(vec![1, 2, 3, 4]);
        assert_eq!(
            launched_exit_action(None, &list, adopted, &[], true),
            ExitAction::KeepDemoted(Some(1))
        );
        // A window another row holds is skipped.
        let held: HashSet<u64> = [1].into();
        assert_eq!(exit_adoption(&row, &windows, &[], &held, ide, no_new_window), Some(4));
        // No window shows the project: nothing adopted, and still no guess.
        let other = vec!["elsewhere".to_string()];
        let ide = Some((IdeId::PyCharm, other.as_slice()));
        assert_eq!(exit_adoption(&row, &windows, &[], &none, ide, no_new_window), None);
    }

    #[test]
    fn exit_adoption_guesses_only_without_a_family_and_without_ide_facts() {
        let windows = pycharm_windows();
        let none = HashSet::new();
        let plain = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        // No family, not an IDE row: the old any-new-window guess.
        assert_eq!(exit_adoption(&plain, &windows, &[], &none, None, || Some(42)), Some(42));
        // An IDE row that does not know its project falls back to it too.
        let ide_row = tracked(Some("p1"), ORIGIN_PROJECT_IDE, None);
        assert_eq!(exit_adoption(&ide_row, &windows, &[], &none, None, || Some(42)), Some(42));
        // A live family's window: resolved by pid.
        assert_eq!(exit_adoption(&plain, &windows, &[301], &none, None, no_new_window), Some(4));
        // A live family that has not mapped a window yet: no guess.
        assert_eq!(exit_adoption(&plain, &windows, &[555], &none, None, no_new_window), None);
    }

    // ── read-time / switch-time resolve ────────────────────────────────────

    #[test]
    fn missing_windows_resolve_by_marker_and_by_ide_project_from_one_scan() {
        use crate::services::ide_detect::IdeId;
        use std::cell::Cell;
        // w0: a marked launch whose family member 300 mapped window 3 late.
        let mut marked = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        marked.pid = 100;
        marked.launch_id = Some("tok".into());
        // w1: a demoted IDE hand-off (pid 0) that knows its project.
        let mut handed = tracked(Some("p1"), ORIGIN_PROJECT_IDE, None);
        handed.pid = 0;
        handed.launch_id = Some("ide-tok".into());
        // w2: another row already holds window 1 (also titled "proj").
        let holder = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(1));
        // w3: a pid-0 OS-default open: nothing to resolve by.
        let mut opener = tracked(Some("p1"), ORIGIN_DOWNLOADS, None);
        opener.pid = 0;
        let mut reg = registry_of(vec![marked, handed, holder, opener]);
        with_family(&mut reg, "w0", None);
        reg.launches.get_mut("w0").unwrap().since = 40;
        reg.launches.insert(
            "w1".into(),
            LaunchTrack { since: 1, family: Some(Vec::new()), ide_project: Some((IdeId::PyCharm, vec!["proj".into()])) },
        );
        let windows = pycharm_windows();
        let scans = Cell::new(0);
        let marked_for = |id: &str, since: u64| match (id, since) {
            ("tok", 40) => vec![300],
            _ => Vec::new(),
        };
        resolve_missing_launch_windows_with(
            &mut reg,
            Some("p1"),
            || {
                scans.set(scans.get() + 1);
                windows.as_slice()
            },
            marked_for,
        );
        assert_eq!(reg.windows["w0"].window_id, Some(3), "family member's window");
        assert_eq!(reg.windows["w1"].window_id, Some(4), "the project window no row holds");
        assert_eq!(reg.windows["w2"].window_id, Some(1));
        assert_eq!(reg.windows["w3"].window_id, None);
        assert!(scans.get() >= 1);
    }

    #[test]
    fn missing_window_resolve_scans_only_when_a_row_can_resolve() {
        let mut opener = tracked(Some("p1"), ORIGIN_DOWNLOADS, None);
        opener.pid = 0;
        // An IDE pid-0 row without project facts has nothing to go by either.
        let mut ide_row = tracked(Some("p1"), ORIGIN_PROJECT_IDE, None);
        ide_row.pid = 0;
        let mut reg = registry_of(vec![opener, ide_row]);
        resolve_missing_launch_windows_with(
            &mut reg,
            Some("p1"),
            || -> &'static [ClientWindow] { panic!("no row needs a scan") },
            |_, _| Vec::new(),
        );
        assert!(reg.windows.values().all(|w| w.window_id.is_none()));
    }

    #[test]
    fn two_rows_never_resolve_the_same_window() {
        // Both launches' marked processes include 301 (the marker leaked):
        // whichever row asks first takes window 4, the other gets nothing.
        let mut a = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        a.pid = 301;
        let mut b = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        b.pid = 301;
        let mut reg = registry_of(vec![a, b]);
        let windows: Vec<ClientWindow> = pycharm_windows().into_iter().filter(|w| w.id == 4).collect();
        resolve_missing_launch_windows_with(&mut reg, Some("p1"), || windows.as_slice(), |_, _| Vec::new());
        let ids: Vec<Option<u64>> = reg.windows.values().map(|w| w.window_id).collect();
        assert_eq!(ids.iter().filter(|id| **id == Some(4)).count(), 1);
        assert_eq!(ids.iter().filter(|id| id.is_none()).count(), 1);
    }

    // ── the Apps-view read: probes run with the registry unlocked ──────────

    #[test]
    fn the_apps_view_read_scans_and_probes_with_the_registry_unlocked() {
        // w0: windowless marked launch whose family member 300 shows window 3.
        let mut marked = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        marked.pid = 299;
        marked.launch_id = Some("tok".into());
        // w1: dead app whose window is gone → removed.
        let mut dead = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(9));
        dead.pid = 100;
        // w2: another scope, untouched and not returned.
        let other = tracked(Some("p2"), ORIGIN_SIDE_FILE_TREE, None);
        let mut reg = registry_of(vec![marked, dead, other]);
        with_family(&mut reg, "w0", None);
        reg.launches.get_mut("w0").unwrap().since = 40;
        let registry: WindowRegistryState = Arc::new(Mutex::new(reg));
        let unlocked = |what: &str| assert!(registry.try_lock().is_ok(), "{what} ran under the registry lock");
        let windows = pycharm_windows();
        let scans = std::cell::Cell::new(0);
        let rows = prune_dead_windows_unlocked(
            &registry,
            Some("p1"),
            true,
            |pid| pid != 100,
            |_| None,
            |id, since| {
                unlocked("the marked-process lookup");
                if (id, since) == ("tok", 40) { vec![300] } else { Vec::new() }
            },
            || {
                unlocked("the window scan");
                scans.set(scans.get() + 1);
                (WindowList::Complete(windows.iter().map(|w| w.id).collect()), windows.clone())
            },
        );
        assert_eq!(scans.get(), 1, "one scan for the resolve and the prune");
        let reg = registry.lock_ok();
        assert_eq!(reg.windows["w0"].window_id, Some(3), "resolved by its marked process");
        assert!(!reg.windows.contains_key("w1"), "dead and its window gone");
        assert!(reg.windows.contains_key("w2"));
        let ids: Vec<&str> = rows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["w0"], "the scope's rows, after the sweep");
    }

    #[test]
    fn the_apps_view_read_makes_no_scan_without_a_question() {
        // A live row with its window, and a pid-0 open without one: nothing
        // to resolve, nothing dead.
        let mut live = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(5));
        live.pid = 200;
        let mut opener = tracked(Some("p1"), ORIGIN_DOWNLOADS, None);
        opener.pid = 0;
        let registry: WindowRegistryState = Arc::new(Mutex::new(registry_of(vec![live, opener])));
        let rows = prune_dead_windows_unlocked(
            &registry,
            Some("p1"),
            true,
            |_| true,
            |_| None,
            |_, _| Vec::new(),
            || panic!("no row needs a scan"),
        );
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn a_row_that_changed_during_the_unlocked_scan_is_left_for_the_next_read() {
        let mut dead = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(9));
        dead.pid = 100;
        let registry: WindowRegistryState = Arc::new(Mutex::new(registry_of(vec![dead])));
        prune_dead_windows_unlocked(
            &registry,
            Some("p1"),
            false,
            |_| false,
            |_| None,
            |_, _| Vec::new(),
            || {
                // The exit watcher demoted it meanwhile (adopting window 4).
                let mut reg = registry.lock_ok();
                let w = reg.windows.get_mut("w0").unwrap();
                w.pid = 0;
                w.window_id = Some(4);
                (WindowList::Complete(Vec::new()), Vec::new())
            },
        );
        assert!(registry.lock_ok().windows.contains_key("w0"), "judged on what it was, not removed");
    }

    // ── raise path + window-only liveness ──────────────────────────────────

    #[test]
    fn a_raised_ide_window_gets_a_pid_0_project_row() {
        let row = row_for_raised_window(77, "pycharm", "/work/proj", "p1", 5.0);
        assert_eq!(row.pid, 0, "nothing of ours to signal");
        assert_eq!(row.window_id, Some(77));
        assert_eq!(row.origin, ORIGIN_PROJECT_IDE);
        assert_eq!(row.project_id.as_deref(), Some("p1"));
        assert_eq!(row.file.as_deref(), Some("/work/proj"));
        assert_eq!(row.role.as_deref(), Some("ide"));
        assert!(row.launch_id.is_none());
        assert!(is_project_opened_window(&row), "listed and parked");

        let mut reg = WindowRegistry::default();
        let first = track_raised_window(&mut reg, 77, "pycharm", "/work/proj", "p1");
        assert_eq!(reg.windows.len(), 1);
        // Raised again: the same row, not a second one.
        let again = track_raised_window(&mut reg, 77, "pycharm", "/work/proj", "p1");
        assert_eq!(again.id, first.id);
        assert_eq!(reg.windows.len(), 1);
        // A window a launched row already holds is answered with that row.
        let mut launched = tracked(Some("p1"), ORIGIN_PROJECT_IDE, Some(88));
        launched.id = "launched".into();
        launched.pid = 300;
        reg.windows.insert(launched.id.clone(), launched);
        assert_eq!(track_raised_window(&mut reg, 88, "pycharm", "/work/proj", "p1").id, "launched");
        assert_eq!(reg.windows.len(), 2);
    }

    #[test]
    fn a_pid_0_row_with_a_window_lives_while_the_window_does() {
        let raised = row_for_raised_window(77, "pycharm", "/work/proj", "p1", 5.0);
        let mut windowless = tracked(Some("p1"), ORIGIN_PROJECT_IDE, None);
        windowless.pid = 0;
        windowless.id = "windowless".into();
        let mut reg = WindowRegistry::default();
        for w in [raised.clone(), windowless] {
            reg.windows.insert(w.id.clone(), w);
        }
        let run = |reg: &mut WindowRegistry, list: WindowList, liveness: bool| {
            prune_dead_windows_with(reg, Some("p1"), |_| false, |_| None, move || list, liveness);
        };
        // Still listed (XWayland lists it: authoritative for an id).
        run(&mut reg, WindowList::XWaylandOnly(vec![77]), true);
        assert!(reg.windows.contains_key(&raised.id));
        // A failed enumeration says nothing.
        run(&mut reg, WindowList::Unknown, true);
        assert!(reg.windows.contains_key(&raised.id));
        // Off Linux the visible-window list cannot judge it (parked = hidden).
        run(&mut reg, WindowList::Complete(Vec::new()), false);
        assert!(reg.windows.contains_key(&raised.id));
        // The window left the client list: the row goes.
        run(&mut reg, WindowList::XWaylandOnly(vec![9]), true);
        assert!(!reg.windows.contains_key(&raised.id));
        // A pid-0 row without a window stays delist-only.
        assert_eq!(reg.windows["windowless"].pid, 0);
    }

    #[test]
    fn an_adopted_hand_off_row_is_pruned_once_its_window_closes() {
        let mut row = tracked(Some("p1"), ORIGIN_PROJECT_IDE, Some(4));
        row.pid = 0; // KeepDemoted(Some(4)) at launcher exit
        let mut reg = registry_of(vec![row]);
        with_family(&mut reg, "w0", Some(Vec::new()));
        prune_dead_windows_with(&mut reg, Some("p1"), |_| false, |_| None, || WindowList::Complete(vec![4]), true);
        assert!(reg.windows.contains_key("w0"));
        prune_dead_windows_with(&mut reg, Some("p1"), |_| false, |_| None, || WindowList::Complete(Vec::new()), true);
        assert!(reg.windows.is_empty());
        assert!(reg.launches.is_empty());
    }

    #[test]
    fn record_launch_keeps_the_ide_project() {
        use crate::services::ide_detect::IdeId;
        let mut row = tracked(Some("p1"), ORIGIN_PROJECT_IDE, None);
        row.launch_id = Some("0f3a".into());
        let mut reg = registry_of(vec![row]);
        record_launch(&mut reg, "w0", 5, Some((IdeId::PyCharm, vec!["proj".into()])));
        let (ide, names) = reg.launches["w0"].ide_project.clone().expect("IDE facts");
        assert_eq!(ide, IdeId::PyCharm);
        assert_eq!(names, ["proj"]);
    }

    #[test]
    fn record_launch_tracks_only_marked_rows() {
        let mut marked = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        marked.launch_id = Some("0f3a".into());
        let mut reg = registry_of(vec![marked, tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None)]);
        record_launch(&mut reg, "w0", 77, None);
        record_launch(&mut reg, "w1", 77, None);
        assert_eq!(reg.launches.len(), 1);
        assert_eq!(reg.launches["w0"].since, 77);
        assert!(reg.launches["w0"].family.is_none());
    }

    #[test]
    fn the_launch_marker_is_opaque_and_never_serialized() {
        let a = new_launch_id().expect("OS randomness");
        let b = new_launch_id().expect("OS randomness");
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        let mut row = tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, None);
        row.launch_id = Some(a.clone());
        let json = serde_json::to_string(&row).unwrap();
        assert!(!json.contains(&a) && !json.contains("launch"), "{json}");
        // An older payload without the field still reads.
        let back: TrackedWindow = serde_json::from_str(&json).unwrap();
        assert_eq!(back.launch_id, None);
    }

    #[test]
    fn launch_command_sets_the_marker_only_when_there_is_one() {
        let var = std::ffi::OsStr::new(crate::app_env!("LAUNCH_ID"));
        let marked = launch_command("editor", &[], None, Some("0f3a"));
        let value = marked.get_envs().find(|(k, _)| *k == var).and_then(|(_, v)| v);
        assert_eq!(value, Some(std::ffi::OsStr::new("0f3a")));
        let unmarked = launch_command("editor", &[], None, None);
        assert!(unmarked.get_envs().all(|(k, _)| k != var));
    }

    #[test]
    fn opened_windows_returns_empty_for_wrong_project() {
        let windows = [
            tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(10)),
            tracked(Some("p1"), ORIGIN_MIDDLE_FILE_BROWSER, Some(11)),
        ];
        let opened = opened_windows_for_project(windows.iter(), Some("p2"));
        assert!(opened.is_empty());
    }

    #[test]
    fn opened_windows_returns_empty_for_root_scope_when_all_in_project() {
        let windows = [tracked(Some("p1"), ORIGIN_SIDE_FILE_TREE, Some(10))];
        let opened = opened_windows_for_project(windows.iter(), None);
        assert!(
            opened.is_empty(),
            "root scope (None) must not see project windows"
        );
    }

    // ── parse_exec_command ──────────────────────────────────────────────────

    #[test]
    fn parse_exec_command_plain_path() {
        assert_eq!(
            parse_exec_command("/usr/bin/firefox"),
            Some("/usr/bin/firefox".into())
        );
    }

    #[test]
    fn parse_exec_command_strips_desktop_field_codes() {
        // %U, %F etc. must be skipped.
        assert_eq!(
            parse_exec_command("/usr/bin/code %F"),
            Some("/usr/bin/code".into())
        );
    }

    #[test]
    fn parse_exec_command_strips_leading_percent_args() {
        assert_eq!(
            parse_exec_command("%u /usr/bin/app"),
            Some("/usr/bin/app".into())
        );
    }

    #[test]
    fn parse_exec_command_empty_string() {
        assert_eq!(parse_exec_command(""), None);
    }

    #[test]
    fn parse_exec_command_only_field_codes() {
        assert_eq!(parse_exec_command("%U %F %i"), None);
    }

    #[test]
    fn parse_exec_command_quoted_token_outer_quotes_stripped() {
        // The function strips outer quotes from the final string but splits on
        // whitespace first, so a quoted path with spaces is split at the space.
        // This documents the actual behavior.
        let result = parse_exec_command("\"/usr/bin/myapp\"");
        assert_eq!(result, Some("/usr/bin/myapp".into()));
    }

    #[test]
    fn parse_exec_command_preserves_multi_token_flatpak_launcher() {
        // A first-token-only parse would truncate this to a bare `flatpak`
        // with no way to know which app to run — the full command line
        // (minus field codes/@@ markers) must survive.
        let result = parse_exec_command(
            "/usr/bin/flatpak run --branch=stable --arch=x86_64 \
             --command=entrypoint --file-forwarding com.prusa3d.PrusaSlicer \
             --single-instance-on-url @@u %u @@",
        );
        assert_eq!(
            result,
            Some(
                "/usr/bin/flatpak run --branch=stable --arch=x86_64 \
                 --command=entrypoint --file-forwarding com.prusa3d.PrusaSlicer \
                 --single-instance-on-url"
                    .into()
            )
        );
    }

    // ── split_exec_command ──────────────────────────────────────────────────

    #[test]
    fn split_exec_command_no_whitespace_is_single_program() {
        assert_eq!(
            split_exec_command("/usr/bin/firefox"),
            ("/usr/bin/firefox", vec![])
        );
    }

    #[test]
    fn split_exec_command_splits_nonexistent_multi_word_launcher() {
        let (program, args) =
            split_exec_command("/usr/bin/flatpak run --branch=stable com.prusa3d.PrusaSlicer");
        assert_eq!(program, "/usr/bin/flatpak");
        assert_eq!(
            args,
            vec!["run", "--branch=stable", "com.prusa3d.PrusaSlicer"]
        );
    }

    #[test]
    fn split_exec_command_keeps_existing_path_with_spaces_whole() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(concat!(crate::app_slug!(), " test app {}.txt"), std::process::id()));
        fs::write(&path, b"").unwrap();
        let exec = path.to_string_lossy().into_owned();
        assert_eq!(split_exec_command(&exec), (exec.as_str(), vec![]));
        let _ = fs::remove_file(&path);
    }

    // ── installed-app parsing / embeddable allowlist ───────────────────────

    fn write_desktop(body: &str) -> PathBuf {
        // A wall-clock stamp is not unique enough: macOS resolves `now()` to
        // roughly a microsecond, so two tests writing in parallel can land on
        // the same name and read each other's body. A counter cannot collide.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            concat!(crate::app_slug!(), "-test-{}-{}.desktop"),
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn parse_installed_app_extracts_name_exec_icon() {
        let path = write_desktop(
            "[Desktop Entry]\nType=Application\nName=Blender\nExec=/opt/blender/blender %f\nIcon=blender\n",
        );
        let app = parse_installed_app(&path).expect("should parse");
        fs::remove_file(&path).ok();
        assert_eq!(app.name, "Blender");
        assert_eq!(app.exec, "/opt/blender/blender");
        assert_eq!(app.icon.as_deref(), Some("blender"));
    }

    #[test]
    fn parse_installed_app_skips_nodisplay_and_non_application() {
        let hidden = write_desktop(
            "[Desktop Entry]\nType=Application\nName=Hidden\nExec=foo\nNoDisplay=true\n",
        );
        let link =
            write_desktop("[Desktop Entry]\nType=Link\nName=Bookmark\nExec=foo\nURL=http://x\n");
        let no_exec = write_desktop("[Desktop Entry]\nType=Application\nName=NoExec\n");
        assert!(parse_installed_app(&hidden).is_none());
        assert!(parse_installed_app(&link).is_none());
        assert!(parse_installed_app(&no_exec).is_none());
        for p in [hidden, link, no_exec] {
            fs::remove_file(&p).ok();
        }
    }

    #[test]
    fn blender_is_on_embeddable_allowlist() {
        assert!(is_embeddable_exec("/opt/blender-5.1.2-linux-x64/blender"));
        assert!(is_embeddable_exec("blender"));
    }

    /// An entry whose in-folder `project.json` carries `folder_json` — the file a
    /// fenced agent, a container tab or a `git pull` can rewrite.
    fn entry_with_poisoned_folder(
        dir: &std::path::Path,
        folder_json: &str,
        extra: serde_json::Value,
    ) -> crate::schema::ProjectEntry {
        let local_file = dir.join("project.json");
        std::fs::write(&local_file, folder_json).unwrap();
        crate::schema::ProjectEntry {
            id: "p".into(),
            name: "p".into(),
            status: "active".into(),
            position: 0,
            local_file: local_file.to_string_lossy().into_owned(),
            extra: serde_json::from_value(extra).unwrap(),
        }
    }
    #[test]
    fn project_apps_ignore_the_in_folder_project_json() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = entry_with_poisoned_folder(
            tmp.path(),
            r#"{"id":"p","name":"p","directory":"/x","default_apps":{".pdf":"/x/evil.sh"}}"#,
            serde_json::json!({}),
        );
        assert!(project_apps_from_entry(&entry).is_empty());
    }

    #[test]
    fn project_apps_come_from_the_registry_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = entry_with_poisoned_folder(
            tmp.path(),
            r#"{"id":"p","name":"p","directory":"/x","default_apps":{".pdf":"/x/evil.sh"}}"#,
            serde_json::json!({"default_apps": {".pdf": "okular"}}),
        );
        assert_eq!(project_apps_from_entry(&entry)[".pdf"], "okular");
    }

    #[test]
    fn an_os_default_open_refuses_launchers_and_a_check_opens_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("paper.pdf");
        std::fs::write(&doc, b"%PDF").unwrap();
        let doc = doc.to_string_lossy().into_owned();
        // A check passes and says "do not open now"; the real call goes on.
        assert_eq!(open_goes_ahead(None, &doc, true), Ok(false));
        assert_eq!(open_goes_ahead(None, &doc, false), Ok(true));
        let launcher = dir.path().join(if cfg!(windows) { "run.lnk" } else if cfg!(target_os = "macos") { "go.command" } else { "run.desktop" });
        std::fs::write(&launcher, b"x").unwrap();
        let launcher = launcher.to_string_lossy().into_owned();
        for check_only in [true, false] {
            assert_eq!(
                open_goes_ahead(None, &launcher, check_only).unwrap_err(),
                crate::services::os_open::REFUSED_LAUNCHER
            );
        }
        // A handler the user picked (explicit or a configured default app)
        // is their choice: not judged.
        assert_eq!(open_goes_ahead(Some("gedit"), &launcher, false), Ok(true));
        // The check wrote nothing beside the files.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn project_apps_for_id_empty_without_id() {
        assert!(project_apps_for_id(None).is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_bundle_discovery_uses_info_plist_and_bundle_path() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("Filename.app");
        let contents = app.join("Contents");
        let executable = contents.join("MacOS").join("real-bin");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"binary").unwrap();

        let mut info = plist::Dictionary::new();
        info.insert(
            "CFBundleDisplayName".into(),
            plist::Value::String("Preferred Name".into()),
        );
        info.insert(
            "CFBundleName".into(),
            plist::Value::String("Fallback Name".into()),
        );
        info.insert(
            "CFBundleExecutable".into(),
            plist::Value::String("real-bin".into()),
        );
        plist::Value::Dictionary(info)
            .to_file_xml(contents.join("Info.plist"))
            .unwrap();

        let apps = macos_installed_apps_in(&[temp.path().to_path_buf()]);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].name, "Preferred Name");
        assert_eq!(apps[0].exec, app.to_string_lossy().into_owned());
    }

    // ── Windows Start Menu matching ────────────────────────────────────────

    fn shortcut() -> ShortcutEntry {
        ShortcutEntry {
            display_name: "Visual Studio Code".to_string(),
            shortcut_path: PathBuf::from(
                r"C:\Users\alice\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Visual Studio Code.lnk",
            ),
            target_path: PathBuf::from(
                r"C:\Users\alice\AppData\Local\Programs\Microsoft VS Code\Code.exe",
            ),
            icon_path: Some(PathBuf::from(
                r"C:\Users\alice\AppData\Local\Programs\Microsoft VS Code\Code.exe",
            )),
        }
    }

    #[test]
    fn shortcut_matches_display_name() {
        assert!(shortcut_matches("visual studio code", &shortcut()));
    }

    #[test]
    fn shortcut_matches_target_basename() {
        assert!(shortcut_matches("Code.exe", &shortcut()));
    }

    #[test]
    fn shortcut_matches_direct_executable_path() {
        assert!(shortcut_matches(
            r"C:\Users\alice\AppData\Local\Programs\Microsoft VS Code\Code.exe",
            &shortcut()
        ));
    }

    #[test]
    fn shortcut_does_not_match_unrelated_name() {
        assert!(!shortcut_matches("notepad", &shortcut()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_script_command_picks_interpreter_by_extension() {
        // .ps1 → PowerShell; .bat / .cmd / everything else → cmd /C. The
        // program is the System32 path `paths::helper_program` resolves, so
        // only its stem is compared.
        let stem = |c: &std::process::Command| {
            Path::new(c.get_program()).file_stem().unwrap().to_string_lossy().to_ascii_lowercase()
        };
        let ps1 = windows_script_command(r"C:\tmp\build.ps1", None);
        assert_eq!(stem(&ps1), "powershell");

        for script in [r"C:\tmp\build.bat", r"C:\tmp\run.cmd", r"C:\tmp\go.sh"] {
            let cmd = windows_script_command(script, Some("--x 1"));
            assert_eq!(stem(&cmd), "cmd");
            // `/D`: no AutoRun from the user's registry before the script.
            let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
            assert_eq!(&args[..2], ["/D", "/C"]);
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unix_script_command_runs_bare_without_args() {
        let cmd = unix_script_command("/p/run.sh", Some("   "));
        assert_eq!(cmd.get_program().to_string_lossy(), "bash");
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, vec!["/p/run.sh"]);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unix_script_command_hands_args_to_a_shell_with_the_path_as_dollar_zero() {
        let cmd = unix_script_command("/p/it's.sh", Some(" --n 2 \"a b\" "));
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, vec!["-c", "exec bash \"$0\" --n 2 \"a b\"", "/p/it's.sh"]);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unix_script_command_passes_args_through_to_the_script() {
        let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-args-{}"), std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("echo args.sh");
        std::fs::write(&script, "printf '%s|' \"$@\"\n").unwrap();
        let out = unix_script_command(script.to_str().unwrap(), Some("one \"two three\""))
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(String::from_utf8_lossy(&out.stdout), "one|two three|");
    }
}
