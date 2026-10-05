//! KDE Plasma (Wayland) workspace backend — workspace info only.
//!
//! - **No parking.** A Wayland client may not hide or move another app's
//!   toplevel, and no KWin script is installed, so `show_window`/`hide_window`
//!   are no-ops and `can_park` is false (Settings says so).
//! - **No sticky.** `make_sticky` is a no-op as well.
//! - `info()` asks KWin's `VirtualDesktopManager` over the session bus. Known
//!   gap: `current` and `desktops` are D-Bus *properties* there, not methods, so
//!   these calls fail and the label degrades to "KDE vd ?". Nothing renders the
//!   label today; fixing it needs a live KWin to verify against.
//! - Construction fails only without a session bus, and `detect_backend` then
//!   falls through to the next backend.

use zbus::blocking::Connection;

use super::{WorkspaceBackend, WorkspaceInfo};

// ── DBus service names and paths ──────────────────────────────────────────

// KDE 6 path
const KWIN_SERVICE: &str = "org.kde.KWin";
const VD_MANAGER_PATH: &str = "/VirtualDesktopManager";
const VD_MANAGER_IFACE: &str = "org.kde.KWin.VirtualDesktopManager";

// ── Backend ────────────────────────────────────────────────────────────────

pub struct KdeWaylandBackend {
    conn: Connection,
}

impl KdeWaylandBackend {
    pub fn try_new() -> Result<Self, String> {
        let conn = Connection::session().map_err(|e| format!("dbus session: {e}"))?;
        Ok(KdeWaylandBackend { conn })
    }

    fn current_desktop_id(&self) -> Option<String> {
        let msg = self.conn.call_method(
            Some(KWIN_SERVICE),
            VD_MANAGER_PATH,
            Some(VD_MANAGER_IFACE),
            "current",
            &(),
        );
        msg.ok().and_then(|r| r.body().deserialize::<String>().ok())
    }

    fn list_desktop_ids(&self) -> Vec<String> {
        let msg = self.conn.call_method(
            Some(KWIN_SERVICE),
            VD_MANAGER_PATH,
            Some(VD_MANAGER_IFACE),
            "desktops",
            &(),
        );
        msg.ok()
            .and_then(|r| r.body().deserialize::<Vec<String>>().ok())
            .unwrap_or_default()
    }
}

impl WorkspaceBackend for KdeWaylandBackend {
    fn name(&self) -> &'static str {
        "kde-wayland"
    }

    fn info(&self) -> WorkspaceInfo {
        let current = self.current_desktop_id().unwrap_or_else(|| "?".to_string());
        let count = self.list_desktop_ids().len();
        let short: String = current.chars().take(8).collect();
        WorkspaceInfo {
            label: format!("KDE vd {short}"),
            current_desktop: None, // IDs are UUIDs, not indices.
            desktop_count: Some(count),
        }
    }

    fn show_window(&self, _window_id: u64) -> Result<(), String> {
        Ok(())
    }

    fn hide_window(&self, _window_id: u64) -> Result<(), String> {
        Ok(())
    }

    fn can_park(&self) -> bool {
        // show/hide above are no-ops: a project switch leaves every window.
        false
    }

    fn make_sticky(&self, _app_pid: u32) -> Result<(), String> {
        // Not implemented: making a window sticky on KWin/Wayland needs the KWin
        // scripting API, which this backend does not use.
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        // Leave the virtual desktops in place; user may have customized them.
        // Tracked as a cleanup option in Phase 8 settings.
        Ok(())
    }
}
