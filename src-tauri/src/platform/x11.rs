//! X11 workspace backend — EWMH two-desktop parking model.
//!
//! Matches the Python kde_kwin.py (X11 path) behavior:
//! - Two desktops: desktop 0 = active project, desktop 1 = parked windows.
//! - Hiding a project window parks it on desktop 1; showing one restores it
//!   to desktop 0.
//! - Protected WM_CLASS names are never moved.
//! - All window management uses ClientMessage events (proper EWMH), not
//!   ChangeProperty, so KWin intercepts and honors the requests.
//!
//! Runs on KDE, Cinnamon (Muffin) and GNOME (Mutter), X11 and — for GNOME and
//! a KDE whose `kde-wayland` connect failed — Wayland, where it reaches the
//! XWayland clients only (`super::route`). On Cinnamon and GNOME the workspace
//! GSettings are taken over while it runs and given back in `cleanup`
//! (`super::workspace_settings`). Under Wayland it embeds nothing and
//! positions nothing ([`embeds`], [`positions`]).

use std::collections::HashSet;
use app_core::sync::LockExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use xcb::x::{self, Atom, Window};
use xcb::{Connection, Xid, XidNew};

use super::workspace_settings::{self, DesktopSettings, Op, Recorded};
use super::{WorkspaceBackend, WorkspaceInfo, X11Desktop};

// ── Constants ─────────────────────────────────────────────────────────────

const ACTIVE_DESKTOP: u32 = 0;
const PARKED_DESKTOP: u32 = 1;

// The app's own windows under its current binary name and under the one an
// older build runs as (the same entry twice until the name changes).
const PROTECTED_CLASSES: &[&str] =
    &[crate::brand::BIN_NAME, crate::brand::LEGACY_BIN_NAME, "plasmashell", "kwin", "cinnamon"];

// ── Backend ────────────────────────────────────────────────────────────────

pub struct X11Backend {
    conn: Connection,
    screen_num: i32,
    atoms: Atoms,
    original_desktop_count: u32,
    /// The desktop's workspace settings table (Cinnamon, GNOME); `None` on KDE.
    settings: Option<&'static DesktopSettings>,
    /// What the table changed, for `cleanup` to give back.
    settings_record: Vec<Recorded>,
    /// `<state_dir>/workspace_settings_restore.json`.
    restore_file: PathBuf,
    /// A Wayland session: only XWayland windows are reachable.
    wayland: bool,
    cleaned_up: Mutex<bool>,
    /// Tabtivity-owned window ids that are explicitly opted in to project-switch
    /// parking despite carrying the protected `tabtivity` WM_CLASS (#42 detached
    /// subwindows). The MAIN window id can NEVER enter this set — `set_parkable`
    /// refuses it structurally (see `parkable_state`).
    parkable: Mutex<ParkableState>,
}

/// The parkable override + the structurally-protected main window id.
#[derive(Default)]
struct ParkableState {
    override_ids: HashSet<u64>,
    /// The main Tabtivity window's X11 id, once known. `add_parkable` refuses to
    /// add this id, keeping "the main window is never parked" structural.
    main_window_id: Option<u64>,
}

impl ParkableState {
    /// Add `id` to the override unless it is the main window id. Returns whether
    /// it was added. Pure over its own state — unit-testable without X11.
    fn add_parkable(&mut self, id: u64) -> bool {
        if self.main_window_id == Some(id) {
            // STRUCTURAL GUARD: the main window must never be parkable, even if a
            // caller mistakenly asks. Refuse silently (debug-assert in tests).
            debug_assert!(false, concat!("attempted to mark the MAIN ", crate::app_name!(), " window parkable"));
            return false;
        }
        self.override_ids.insert(id)
    }

    fn is_parkable(&self, id: u64) -> bool {
        self.override_ids.contains(&id)
    }
}

struct Atoms {
    net_current_desktop: Atom,
    net_number_of_desktops: Atom,
    net_wm_desktop: Atom,
    net_client_list: Atom,
    net_wm_name: Atom,
    utf8_string: Atom,
    wm_state: Atom,
}

/// Whether the backend may reparent a foreign window into a Tabtivity one:
/// never under Wayland, where Tabtivity's own windows are native.
fn embeds(wayland: bool) -> bool {
    !wayland
}

/// Whether `position_window` may move a window: never under Wayland, where
/// the drop point the frontend sends is no global coordinate and Mutter would
/// honour the `ConfigureWindow` on an XWayland window — moving the app to a
/// wrong place.
fn positions(wayland: bool) -> bool {
    !wayland
}

impl X11Backend {
    pub fn try_new(desktop: X11Desktop) -> Result<Self, String> {
        let (conn, screen_num) =
            xcb::Connection::connect(None).map_err(|e| format!("xcb connect: {e}"))?;

        let atoms = intern_atoms(&conn)?;
        let original_desktop_count =
            get_cardinal(&conn, screen_num, atoms.net_number_of_desktops).unwrap_or(1);
        // Before `ensure_desktop_count`: with the count raised in GSettings
        // that call finds two desktops and sends nothing.
        let settings = desktop.settings();
        let restore_file = crate::storage::state_dir().join(workspace_settings::RESTORE_FILE);
        let settings_record =
            workspace_settings::take_over(settings, &restore_file, gsettings_get, gsettings_run)?;
        // The window manager applies a GSettings write asynchronously. Asking
        // for the count by EWMH before it has would, on Mutter, write
        // `num-workspaces` itself — a value nothing recorded — so give the
        // settings a second to land first.
        if !settings_record.is_empty() {
            for _ in 0..20 {
                if get_cardinal(&conn, screen_num, atoms.net_number_of_desktops).unwrap_or(1) >= 2 {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }

        if let Err(e) = ensure_desktop_count(&conn, screen_num, &atoms, 2) {
            workspace_settings::give_back(&settings_record, &restore_file, gsettings_run);
            return Err(e);
        }

        Ok(X11Backend {
            conn,
            screen_num,
            atoms,
            original_desktop_count,
            settings,
            settings_record,
            restore_file,
            wayland: session_is_wayland(),
            cleaned_up: Mutex::new(false),
            parkable: Mutex::new(ParkableState::default()),
        })
    }
}

impl WorkspaceBackend for X11Backend {
    fn name(&self) -> &'static str {
        "x11"
    }

    fn supports_embedding(&self) -> bool {
        // X11 is the only backend that can reparent an external app's top-level
        // into a Tabtivity-owned container for frameless in-tab embedding — on a
        // real X server only.
        embeds(self.wayland)
    }

    fn info(&self) -> WorkspaceInfo {
        let current =
            get_cardinal(&self.conn, self.screen_num, self.atoms.net_current_desktop).unwrap_or(0);
        let count = get_cardinal(
            &self.conn,
            self.screen_num,
            self.atoms.net_number_of_desktops,
        )
        .unwrap_or(2);
        WorkspaceInfo {
            label: format!("ws {}", current + 1),
            current_desktop: Some(current as usize),
            desktop_count: Some(count as usize),
        }
    }

    fn show_window(&self, window_id: u64) -> Result<(), String> {
        let wid = window_from_u64(window_id)
            .ok_or_else(|| format!("invalid x11 window id {window_id}"))?;
        // The parkable override is consulted BEFORE the protected-class skip so a
        // detached Tabtivity subwindow (WM_CLASS `tabtivity`, normally skipped) is still
        // moved/raised. The main window is never in the override (structural
        // guard in `add_parkable`), so it can never reach here.
        if !self.is_parkable(window_id) && is_protected(&self.conn, wid) {
            return Ok(());
        }
        ensure_desktop_count(&self.conn, self.screen_num, &self.atoms, 2)?;
        self.move_window(wid, ACTIVE_DESKTOP)?;
        switch_current_desktop(&self.conn, self.screen_num, &self.atoms, ACTIVE_DESKTOP)?;
        // A window the user minimized stays minimized: mapping an iconic
        // window asks the WM to restore it (ICCCM 4.1.4), and raising it would
        // too. Back on the active desktop is all a switch owes it.
        if is_iconic(&self.conn, wid, &self.atoms) {
            return self.conn.flush().map_err(|e| e.to_string());
        }
        self.conn
            .send_and_check_request(&x::MapWindow { window: wid })
            .map_err(|e| e.to_string())?;
        self.conn
            .send_and_check_request(&x::ConfigureWindow {
                window: wid,
                value_list: &[x::ConfigWindow::StackMode(x::StackMode::Above)],
            })
            .map_err(|e| e.to_string())?;
        self.conn.flush().map_err(|e| e.to_string())
    }

    fn hide_window(&self, window_id: u64) -> Result<(), String> {
        let wid = window_from_u64(window_id)
            .ok_or_else(|| format!("invalid x11 window id {window_id}"))?;
        // See show_window: the override lets a detached `tabtivity` subwindow park.
        // The main window can never be in the override (structural guard).
        if !self.is_parkable(window_id) && is_protected(&self.conn, wid) {
            return Ok(());
        }
        ensure_desktop_count(&self.conn, self.screen_num, &self.atoms, 2)?;
        self.move_window(wid, PARKED_DESKTOP)
    }

    fn make_sticky(&self, _app_pid: u32) -> Result<(), String> {
        Ok(())
    }

    fn set_parkable(&self, window_id: u64) {
        self.parkable.lock_ok().add_parkable(window_id);
    }

    fn unset_parkable(&self, window_id: u64) {
        self.parkable
            .lock_ok()
            .override_ids
            .remove(&window_id);
    }

    fn set_main_window_id(&self, window_id: u64) {
        self.parkable.lock_ok().main_window_id = Some(window_id);
    }

    fn position_window(&self, window_id: u64, x: i32, y: i32) -> Result<(), String> {
        if !positions(self.wayland) {
            return Ok(());
        }
        let wid = window_from_u64(window_id)
            .ok_or_else(|| format!("invalid x11 window id {window_id}"))?;
        // Geometry only — root-window pixels map to whichever monitor contains
        // (x, y), so no monitor enumeration is needed. Do NOT touch
        // _NET_WM_DESKTOP here: this is placement, not workspace parking.
        // Best-effort re-apply: an app can force its own geometry right after
        // mapping, so re-issue a few times. Never a hard error — positioning a
        // foreign app is inherently best-effort.
        let mut last_err = None;
        for attempt in 0..3 {
            if attempt > 0 {
                thread::sleep(Duration::from_millis(40));
            }
            last_err = self
                .conn
                .send_and_check_request(&x::ConfigureWindow {
                    window: wid,
                    value_list: &[x::ConfigWindow::X(x), x::ConfigWindow::Y(y)],
                })
                .map_err(|e| e.to_string())
                .and_then(|()| self.conn.flush().map_err(|e| e.to_string()))
                .err();
        }
        match last_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    fn cleanup(&self) -> Result<(), String> {
        let mut cleaned_up = self.cleaned_up.lock_ok();
        if *cleaned_up {
            return Ok(());
        }
        *cleaned_up = true;
        drop(cleaned_up);

        if let Ok(windows) = list_client_windows(&self.conn, self.screen_num, &self.atoms) {
            for wid in windows {
                if get_window_desktop(&self.conn, wid, &self.atoms) != Some(PARKED_DESKTOP) {
                    continue;
                }
                if is_protected(&self.conn, wid) {
                    continue;
                }
                if let Err(e) = self.move_window(wid, ACTIVE_DESKTOP) {
                    eprintln!("{e}");
                }
            }
        }

        // KDE only: on a desktop with a settings table the window manager
        // turns this request into a write of its own count setting (Mutter;
        // under dynamic workspaces the original count was just the momentary
        // one), so there the table's restore is the only thing that restores
        // the count.
        if self.settings.is_none() && self.original_desktop_count < 2 {
            request_desktop_count(
                &self.conn,
                self.screen_num,
                &self.atoms,
                self.original_desktop_count,
            )
            .ok();
        }
        workspace_settings::give_back(&self.settings_record, &self.restore_file, gsettings_run);
        self.conn.flush().ok();
        Ok(())
    }
}

impl X11Backend {
    fn is_parkable(&self, window_id: u64) -> bool {
        self.parkable.lock_ok().is_parkable(window_id)
    }

    fn move_window(&self, wid: Window, desktop: u32) -> Result<(), String> {
        send_wm_desktop(&self.conn, self.screen_num, wid, &self.atoms, desktop)?;
        self.conn.flush().map_err(|e| e.to_string())?;

        for _ in 0..5 {
            if get_window_desktop(&self.conn, wid, &self.atoms) == Some(desktop) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(30));
        }

        if self.settings.is_some_and(|s| s.property_fallback) {
            set_window_desktop_property(&self.conn, wid, &self.atoms, desktop)?;
            self.conn.flush().map_err(|e| e.to_string())?;
            for _ in 0..5 {
                if get_window_desktop(&self.conn, wid, &self.atoms) == Some(desktop) {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(30));
            }
        }

        let actual = get_window_desktop(&self.conn, wid, &self.atoms);
        Err(format!(
            "workspace move failed: window={} class={:?} title={:?} target={} actual={:?}",
            wid.resource_id(),
            get_wm_class(&self.conn, wid),
            get_window_title(&self.conn, wid, &self.atoms),
            desktop,
            actual,
        ))
    }
}

impl Drop for X11Backend {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

// ── EWMH ClientMessage helpers ─────────────────────────────────────────────

/// Send a _NET_WM_DESKTOP ClientMessage to move `wid` to `desktop`.
/// KWin requires a ClientMessage sent to root (not direct ChangeProperty).
fn send_wm_desktop(
    conn: &Connection,
    screen_num: i32,
    wid: Window,
    atoms: &Atoms,
    desktop: u32,
) -> Result<(), String> {
    let root = root_window(conn, screen_num);
    let event = x::ClientMessageEvent::new(
        wid,
        atoms.net_wm_desktop,
        x::ClientMessageData::Data32([desktop, 2, 0, 0, 0]),
    );
    conn.send_and_check_request(&x::SendEvent {
        propagate: false,
        destination: x::SendEventDest::Window(root),
        event_mask: x::EventMask::SUBSTRUCTURE_REDIRECT | x::EventMask::SUBSTRUCTURE_NOTIFY,
        event: &event,
    })
    .map_err(|e| e.to_string())
}

/// Send a _NET_CURRENT_DESKTOP ClientMessage to switch the active desktop.
fn switch_current_desktop(
    conn: &Connection,
    screen_num: i32,
    atoms: &Atoms,
    desktop: u32,
) -> Result<(), String> {
    let root = root_window(conn, screen_num);
    let event = x::ClientMessageEvent::new(
        root,
        atoms.net_current_desktop,
        x::ClientMessageData::Data32([desktop, x::CURRENT_TIME, 0, 0, 0]),
    );
    conn.send_and_check_request(&x::SendEvent {
        propagate: false,
        destination: x::SendEventDest::Window(root),
        event_mask: x::EventMask::SUBSTRUCTURE_REDIRECT | x::EventMask::SUBSTRUCTURE_NOTIFY,
        event: &event,
    })
    .map_err(|e| e.to_string())
}

/// Request the window manager to change the desktop count via EWMH.
fn request_desktop_count(
    conn: &Connection,
    screen_num: i32,
    atoms: &Atoms,
    count: u32,
) -> Result<(), String> {
    let root = root_window(conn, screen_num);
    let event = x::ClientMessageEvent::new(
        root,
        atoms.net_number_of_desktops,
        x::ClientMessageData::Data32([count, 0, 0, 0, 0]),
    );
    conn.send_and_check_request(&x::SendEvent {
        propagate: false,
        destination: x::SendEventDest::Window(root),
        event_mask: x::EventMask::SUBSTRUCTURE_REDIRECT | x::EventMask::SUBSTRUCTURE_NOTIFY,
        event: &event,
    })
    .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())
}

fn ensure_desktop_count(
    conn: &Connection,
    screen_num: i32,
    atoms: &Atoms,
    min_count: u32,
) -> Result<(), String> {
    if get_cardinal(conn, screen_num, atoms.net_number_of_desktops).unwrap_or(1) >= min_count {
        return Ok(());
    }

    request_desktop_count(conn, screen_num, atoms, min_count)?;
    for _ in 0..10 {
        if get_cardinal(conn, screen_num, atoms.net_number_of_desktops).unwrap_or(1) >= min_count {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }

    let actual = get_cardinal(conn, screen_num, atoms.net_number_of_desktops).unwrap_or(1);
    Err(format!(
        "window manager kept {actual} desktop(s) after requesting {min_count}"
    ))
}

// ── Low-level X helpers ────────────────────────────────────────────────────

fn root_window(conn: &Connection, screen_num: i32) -> Window {
    conn.get_setup()
        .roots()
        .nth(screen_num as usize)
        .unwrap()
        .root()
}

fn window_from_u64(window_id: u64) -> Option<Window> {
    u32::try_from(window_id).ok().map(Window::new)
}

pub(crate) fn intern_atom(conn: &Connection, name: &[u8]) -> Result<Atom, String> {
    conn.wait_for_reply(conn.send_request(&x::InternAtom {
        only_if_exists: false,
        name,
    }))
    .map(|r| r.atom())
    .map_err(|e| format!("InternAtom {}: {e}", String::from_utf8_lossy(name)))
}

fn intern_atoms(conn: &Connection) -> Result<Atoms, String> {
    Ok(Atoms {
        net_current_desktop: intern_atom(conn, b"_NET_CURRENT_DESKTOP")?,
        net_number_of_desktops: intern_atom(conn, b"_NET_NUMBER_OF_DESKTOPS")?,
        net_wm_desktop: intern_atom(conn, b"_NET_WM_DESKTOP")?,
        net_client_list: intern_atom(conn, b"_NET_CLIENT_LIST")?,
        net_wm_name: intern_atom(conn, b"_NET_WM_NAME")?,
        utf8_string: intern_atom(conn, b"UTF8_STRING")?,
        wm_state: intern_atom(conn, b"WM_STATE")?,
    })
}

fn get_cardinal(conn: &Connection, screen_num: i32, atom: Atom) -> Option<u32> {
    let root = root_window(conn, screen_num);
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: root,
        property: atom,
        r#type: x::ATOM_CARDINAL,
        long_offset: 0,
        long_length: 1,
    });
    conn.wait_for_reply(cookie)
        .ok()
        .and_then(|r| r.value::<u32>().first().copied())
}

fn list_client_windows(
    conn: &Connection,
    screen_num: i32,
    atoms: &Atoms,
) -> Result<Vec<Window>, String> {
    let root = root_window(conn, screen_num);
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: root,
        property: atoms.net_client_list,
        r#type: x::ATOM_WINDOW,
        long_offset: 0,
        long_length: 1024,
    });
    let reply = conn.wait_for_reply(cookie).map_err(|e| e.to_string())?;
    Ok(reply.value::<Window>().to_vec())
}

fn get_window_desktop(conn: &Connection, wid: Window, atoms: &Atoms) -> Option<u32> {
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: wid,
        property: atoms.net_wm_desktop,
        r#type: x::ATOM_CARDINAL,
        long_offset: 0,
        long_length: 1,
    });
    conn.wait_for_reply(cookie)
        .ok()
        .and_then(|r| r.value::<u32>().first().copied())
}

/// ICCCM `WM_STATE` IconicState: the WM holds the window minimized.
const ICONIC_STATE: u32 = 3;

fn is_iconic(conn: &Connection, wid: Window, atoms: &Atoms) -> bool {
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: wid,
        property: atoms.wm_state,
        r#type: atoms.wm_state,
        long_offset: 0,
        long_length: 1,
    });
    // Any client can write WM_STATE; xcb's `value` panics on a format mismatch.
    conn.wait_for_reply(cookie)
        .ok()
        .filter(|r| r.format() == 32)
        .and_then(|r| r.value::<u32>().first().copied())
        == Some(ICONIC_STATE)
}

fn set_window_desktop_property(
    conn: &Connection,
    wid: Window,
    atoms: &Atoms,
    desktop: u32,
) -> Result<(), String> {
    conn.send_and_check_request(&x::ChangeProperty {
        mode: x::PropMode::Replace,
        window: wid,
        property: atoms.net_wm_desktop,
        r#type: x::ATOM_CARDINAL,
        data: &[desktop],
    })
    .map_err(|e| e.to_string())
}

fn get_wm_class(conn: &Connection, wid: Window) -> Option<String> {
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: wid,
        property: x::ATOM_WM_CLASS,
        r#type: x::ATOM_STRING,
        long_offset: 0,
        long_length: 64,
    });
    conn.wait_for_reply(cookie)
        .ok()
        .map(|r| String::from_utf8_lossy(r.value::<u8>()).to_string())
}

fn get_window_title(conn: &Connection, wid: Window, atoms: &Atoms) -> Option<String> {
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: wid,
        property: atoms.net_wm_name,
        r#type: atoms.utf8_string,
        long_offset: 0,
        long_length: 128,
    });
    conn.wait_for_reply(cookie).ok().and_then(|r| {
        let title = String::from_utf8_lossy(r.value::<u8>()).to_string();
        if title.is_empty() {
            None
        } else {
            Some(title)
        }
    })
}

fn is_protected(conn: &Connection, wid: Window) -> bool {
    let class = get_wm_class(conn, wid).unwrap_or_default();
    is_protected_class(&class)
}

/// Pure string check — shared with the app launcher's window scanner.
///
/// WM_CLASS raw bytes hold NUL-separated instance/class strings; reverse-DNS
/// names like "org.kde.plasmashell" are common. Matching whole segments
/// (split on NUL and name separators) instead of raw substrings keeps an app
/// merely *containing* a protected token (e.g. "kwinter") parkable.
pub(crate) fn is_protected_class(wm_class_raw: &str) -> bool {
    wm_class_raw
        .to_lowercase()
        .split(['\0', '.', '-', '_', ' '])
        .any(|segment| PROTECTED_CLASSES.contains(&segment))
}

/// Pure title-match predicate for the detached-window resolver (#42 Phase 0).
///
/// CRITICAL: unlike `find_window_for_pid`/`find_new_window` (apps.rs), this match
/// must NOT filter on the protected WM_CLASS. A detached Tabtivity subwindow carries
/// WM_CLASS `tabtivity` (protected), so a protected-filtering scan would never
/// return it. Matching purely on the exact `_NET_WM_NAME` title (which embeds a
/// unique `project:group`) finds the right window regardless of WM_CLASS.
pub fn title_matches(net_wm_name: Option<&str>, target: &str) -> bool {
    !target.is_empty() && net_wm_name == Some(target)
}

/// Whether this process is running inside a Wayland session, from the
/// `WAYLAND_DISPLAY` the compositor exports (the same test `detect_backend`
/// makes). Pure and value-in so it can be unit-tested on any host.
pub fn is_wayland_session(wayland_display: Option<&std::ffi::OsStr>) -> bool {
    wayland_display.is_some_and(|d| !d.is_empty())
}

/// Whether this process runs in a Wayland session, where an X connection sees
/// only the XWayland clients.
///
/// Under Wayland, `DISPLAY` is still set (XWayland), so `xcb` connects fine and
/// the scans *run* — but the client list holds only XWayland clients.
/// Tabtivity's own windows are native Wayland toplevels, so
/// [`find_window_for_title`] (which looks for them) answers `None` at once
/// here instead of running to its retry cap — 2 s of unpainted black popout
/// inside every `detach_subwindow` otherwise (user, 2026-09-07). The app
/// launcher's scans (`commands::apps`) run one pass without sleeping, which
/// gives an XWayland app (JetBrains, VS Code) its window id for parking. The
/// `x11` backend asks it once at startup to gate embedding and positioning.
pub fn session_is_wayland() -> bool {
    is_wayland_session(std::env::var_os("WAYLAND_DISPLAY").as_deref())
}

/// Resolve a Tabtivity-owned window's X11 id by its exact `_NET_WM_NAME` title,
/// ignoring the protected-class filter (see `title_matches`). Mirrors
/// `find_window_for_pid`'s retry loop. Returns the first matching window id.
/// Answers `None` at once under Wayland — see [`session_is_wayland`].
pub fn find_window_for_title(target: &str, attempts: usize) -> Option<u64> {
    if target.is_empty() || session_is_wayland() {
        return None;
    }
    let (conn, screen_num) = xcb::Connection::connect(None).ok()?;
    let atoms = intern_atoms(&conn).ok()?;
    for _ in 0..attempts {
        if let Ok(windows) = list_client_windows(&conn, screen_num, &atoms) {
            for wid in windows {
                let title = get_window_title(&conn, wid, &atoms);
                if title_matches(title.as_deref(), target) {
                    return Some(wid.resource_id() as u64);
                }
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    None
}

/// Every client window with its `WM_CLASS` and title, for
/// [`super::named_windows`]. Unlike the scans above this one runs under
/// Wayland too: there it sees the XWayland clients, which is where the IDEs
/// that run on XWayland (JetBrains, VS Code by default) put their windows.
pub fn named_client_windows() -> Vec<super::NamedWindow> {
    let Ok((conn, screen_num)) = xcb::Connection::connect(None) else {
        return Vec::new();
    };
    let Ok(atoms) = intern_atoms(&conn) else {
        return Vec::new();
    };
    list_client_windows(&conn, screen_num, &atoms)
        .unwrap_or_default()
        .into_iter()
        .map(|wid| super::NamedWindow {
            id: wid.resource_id() as u64,
            class: get_wm_class(&conn, wid).unwrap_or_default(),
            title: get_window_title(&conn, wid, &atoms).unwrap_or_default(),
        })
        .collect()
}

/// Ask the window manager to raise and focus `window_id` (switching to its
/// desktop) with an EWMH `_NET_ACTIVE_WINDOW` request. Source indication 2
/// (pager) marks it as on the user's behalf, which Mutter, Muffin and KWin
/// honour past their focus-stealing prevention. Under Wayland it reaches
/// XWayland windows only.
pub fn activate_window(window_id: u64) -> Result<(), String> {
    let wid = window_from_u64(window_id)
        .ok_or_else(|| format!("invalid x11 window id {window_id}"))?;
    let (conn, screen_num) =
        xcb::Connection::connect(None).map_err(|e| format!("xcb connect: {e}"))?;
    let net_active_window = intern_atom(&conn, b"_NET_ACTIVE_WINDOW")?;
    let root = root_window(&conn, screen_num);
    let event = x::ClientMessageEvent::new(
        wid,
        net_active_window,
        x::ClientMessageData::Data32([2, x::CURRENT_TIME, 0, 0, 0]),
    );
    conn.send_and_check_request(&x::SendEvent {
        propagate: false,
        destination: x::SendEventDest::Window(root),
        event_mask: x::EventMask::SUBSTRUCTURE_REDIRECT | x::EventMask::SUBSTRUCTURE_NOTIFY,
        event: &event,
    })
    .map_err(|e| e.to_string())
}

/// The topmost (front-most) mapped client window under the X11 pointer, by its
/// X11 id, or `None` if the pointer is over no client (bare root) or the query
/// fails. Used to decide whether a detached subwindow is actually at the front
/// at a drop point: an occluded popout (covered by the main window or another
/// app) must NOT capture a file drop dragged "onto" it (#42).
///
/// Walks `_NET_CLIENT_LIST_STACKING` top-to-bottom (it is stored bottom-to-top),
/// skipping non-viewable windows and windows on another desktop, and returns the
/// first whose root-space geometry contains the pointer. Uses the pointer's
/// *current* position (the release point), so no logical/physical px conversion
/// is needed — everything stays in X11 physical coords.
pub fn frontmost_window_under_pointer() -> Option<u64> {
    let (conn, screen_num) = xcb::Connection::connect(None).ok()?;
    let root = root_window(&conn, screen_num);

    let ptr = conn
        .wait_for_reply(conn.send_request(&x::QueryPointer { window: root }))
        .ok()?;
    let (px, py) = (ptr.root_x() as i32, ptr.root_y() as i32);

    let stacking_atom = intern_atom(&conn, b"_NET_CLIENT_LIST_STACKING").ok()?;
    let net_current_desktop = intern_atom(&conn, b"_NET_CURRENT_DESKTOP").ok()?;
    let net_wm_desktop = intern_atom(&conn, b"_NET_WM_DESKTOP").ok()?;
    let cur_desktop = get_cardinal(&conn, screen_num, net_current_desktop);

    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: root,
        property: stacking_atom,
        r#type: x::ATOM_WINDOW,
        long_offset: 0,
        long_length: 1024,
    });
    let reply = conn.wait_for_reply(cookie).ok()?;
    let windows = reply.value::<Window>();

    for &wid in windows.iter().rev() {
        // Skip windows that aren't actually on screen.
        let viewable = conn
            .wait_for_reply(conn.send_request(&x::GetWindowAttributes { window: wid }))
            .map(|a| a.map_state() == x::MapState::Viewable)
            .unwrap_or(false);
        if !viewable {
            continue;
        }
        // Skip windows on a different desktop (a parked popout, another ws).
        // `0xFFFF_FFFF` means "all desktops" (sticky) and always qualifies.
        if let Some(cur) = cur_desktop {
            let desktop = conn
                .wait_for_reply(conn.send_request(&x::GetProperty {
                    delete: false,
                    window: wid,
                    property: net_wm_desktop,
                    r#type: x::ATOM_CARDINAL,
                    long_offset: 0,
                    long_length: 1,
                }))
                .ok()
                .and_then(|r| r.value::<u32>().first().copied());
            if let Some(d) = desktop {
                if d != cur && d != 0xFFFF_FFFF {
                    continue;
                }
            }
        }
        // Root-space geometry: TranslateCoordinates handles WM reparenting, so the
        // origin is correct even though the window sits inside a frame.
        let geo = match conn.wait_for_reply(conn.send_request(&x::GetGeometry {
            drawable: x::Drawable::Window(wid),
        })) {
            Ok(g) => g,
            Err(_) => continue,
        };
        let trans = match conn.wait_for_reply(conn.send_request(&x::TranslateCoordinates {
            src_window: wid,
            dst_window: root,
            src_x: 0,
            src_y: 0,
        })) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let (ox, oy) = (trans.dst_x() as i32, trans.dst_y() as i32);
        let (w, h) = (geo.width() as i32, geo.height() as i32);
        if px >= ox && px < ox + w && py >= oy && py < oy + h {
            return Some(wid.resource_id() as u64);
        }
    }
    None
}

// ── Workspace GSettings ─────────────────────────────────────────────────────

use crate::commands::os_clock::gsettings_get;

/// Run one `gsettings` call for [`workspace_settings`].
fn gsettings_run(op: &Op) -> Result<(), String> {
    let (args, schema, key) = match op {
        Op::Set { schema, key, value } => {
            (vec!["set", schema.as_str(), key.as_str(), value.as_str()], schema, key)
        }
        Op::Reset { schema, key } => (vec!["reset", schema.as_str(), key.as_str()], schema, key),
    };
    let output = Command::new("gsettings")
        .args(&args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("gsettings {} {schema} {key}: {e}", args[0]))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("gsettings {} {schema} {key}: {}", args[0], stderr.trim()))
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_session_is_a_non_empty_wayland_display() {
        use std::ffi::OsStr;
        assert!(is_wayland_session(Some(OsStr::new("wayland-0"))));
        assert!(!is_wayland_session(Some(OsStr::new(""))));
        assert!(!is_wayland_session(None));
    }

    // ── is_protected_class ─────────────────────────────────────────────────

    #[test]
    fn app_wm_class_is_always_protected() {
        // The most critical invariant: Tabtivity's own window must NEVER be sent
        // to PARKED_DESKTOP.  X11 WM_CLASS is two NUL-separated strings:
        // "<instance>\0<class>\0".
        assert!(is_protected_class(concat!(crate::app_slug!(), "\0", crate::app_name!(), "\0")));
        assert!(is_protected_class(concat!(crate::app_name!(), "\0", crate::app_name!(), "\0")));
        assert!(is_protected_class(crate::app_slug!())); // instance name only
        assert!(is_protected_class(crate::app_upper!())); // all-caps (case-insensitive)
    }

    #[test]
    fn protected_classes_constant_includes_app() {
        // Regression guard: if someone removes "tabtivity" from PROTECTED_CLASSES
        // by accident, this test fails immediately.
        assert!(
            PROTECTED_CLASSES.contains(&crate::app_slug!()),
            concat!("PROTECTED_CLASSES must contain \"", crate::app_slug!(), "\" or ", crate::app_name!(), " will be hidden on project switch")
        );
    }

    #[test]
    fn shell_class_is_not_protected() {
        // Ordinary app windows must be parkable.
        assert!(!is_protected_class("konsole\0konsole\0"));
        assert!(!is_protected_class("firefox\0Firefox\0"));
        assert!(!is_protected_class("code\0Code\0"));
        assert!(!is_protected_class("")); // empty → not protected
        assert!(!is_protected_class("\0\0")); // blank WM_CLASS → not protected
    }

    #[test]
    fn desktop_shell_classes_are_protected() {
        assert!(is_protected_class("plasmashell\0plasmashell\0"));
        assert!(is_protected_class("kwin\0kwin_x11\0"));
        assert!(is_protected_class("cinnamon\0Cinnamon\0"));
    }

    #[test]
    fn protected_class_reverse_dns_match() {
        // Reverse-DNS WM_CLASS names must still match the protected token.
        assert!(is_protected_class("org.kde.plasmashell\0plasmashell\0"));
    }

    // ── parkable override (#42) ────────────────────────────────────────────

    #[test]
    fn overridden_id_is_parkable_even_though_app_is_protected() {
        // A detached subwindow's id, opted in, must be parkable despite its
        // `tabtivity` WM_CLASS being protected — that is the whole #42 parking link.
        let mut state = ParkableState::default();
        assert!(state.add_parkable(42));
        assert!(state.is_parkable(42));
        // Sanity: the WM_CLASS itself is still protected by default.
        assert!(is_protected_class(concat!(crate::app_slug!(), "\0", crate::app_name!(), "\0")));
    }

    #[test]
    fn non_overridden_app_id_is_not_parkable() {
        let state = ParkableState::default();
        assert!(!state.is_parkable(99), "ids not opted in stay non-parkable");
    }

    #[test]
    fn main_window_id_can_never_become_parkable() {
        // The single most safety-critical invariant: the MAIN window must never
        // be parked. `add_parkable` refuses its id structurally.
        let mut state = ParkableState {
            main_window_id: Some(7),
            ..Default::default()
        };
        // In debug builds add_parkable debug_asserts; call it in a way that
        // checks the *return*/effect without tripping the assert path. We test
        // the effect via release semantics: the id must not be inserted.
        let added =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| state.add_parkable(7)));
        // Either it returned false (release) or panicked via debug_assert (debug);
        // either way the id must NOT be in the override set afterwards.
        let _ = added; // result intentionally ignored
        assert!(
            !state.is_parkable(7),
            "the main window id must never enter the parkable override"
        );
    }

    #[test]
    fn other_ids_still_parkable_after_main_window_set() {
        let mut state = ParkableState {
            main_window_id: Some(7),
            ..Default::default()
        };
        assert!(state.add_parkable(8));
        assert!(state.is_parkable(8));
        assert!(!state.is_parkable(7));
    }

    // ── title_matches (#42 detached-window resolver) ───────────────────────

    #[test]
    fn title_matches_exact_project_group_title() {
        let target = concat!(crate::app_name!(), " — p1 — g-3");
        assert!(title_matches(Some(target), target));
    }

    #[test]
    fn title_matches_rejects_mismatch_and_empty() {
        assert!(!title_matches(
            Some(concat!(crate::app_name!(), " — p1 — g-3")),
            concat!(crate::app_name!(), " — p2 — g-3")
        ));
        assert!(!title_matches(None, concat!(crate::app_name!(), " — p1 — g-3")));
        // An empty target must never match (a window with no title shouldn't be
        // resolved by accident).
        assert!(!title_matches(Some(""), ""));
        assert!(!title_matches(None, ""));
    }

    #[test]
    fn class_merely_containing_protected_token_is_parkable() {
        // Segment matching, not substring matching: an unrelated app whose name
        // happens to contain "kwin"/"tabtivity" must remain parkable.
        assert!(!is_protected_class("kwinter\0Kwinter\0"));
        assert!(!is_protected_class(concat!(crate::app_slug!(), "ner\0", crate::app_name!(), "ner\0")));
    }

    // ── window_from_u64 ────────────────────────────────────────────────────

    #[test]
    fn window_from_u64_accepts_valid_u32() {
        assert!(window_from_u64(12345).is_some());
        assert!(window_from_u64(u32::MAX as u64).is_some());
    }

    #[test]
    fn window_from_u64_rejects_above_u32() {
        assert!(window_from_u64(u64::from(u32::MAX) + 1).is_none());
        assert!(window_from_u64(u64::MAX).is_none());
    }

    // ── Wayland gates ──────────────────────────────────────────────────────

    #[test]
    fn wayland_embeds_and_positions_nothing() {
        assert!(embeds(false) && positions(false), "a real X server does both");
        assert!(!embeds(true), "no reparenting into a native Wayland window");
        assert!(!positions(true), "the drop point is no global coordinate there");
    }
}
