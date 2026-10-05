//! WorkspaceBackend trait and auto-detect factory.
//!
//! Detection (`detect_backend`):
//!   - Windows → `windows`; macOS → `macos` (one backend each, always).
//!   - Linux, KDE/Plasma in a Wayland session ([`session_is_wayland`]) →
//!     `kde-wayland`, which reports workspace info but cannot park windows.
//!   - Linux, KDE/Plasma (or a failed `kde-wayland` connect) → `x11`.
//!   - Linux, Cinnamon → `x11`.
//!   - Everything else — GNOME, XFCE, sway, …, or an `x11` connect that failed
//!     → `null`, which parks nothing. There is no GNOME backend.

use serde::{Deserialize, Serialize};

pub mod null;

#[cfg(target_os = "macos")]
pub mod macos;
/// Pure parking logic for the macOS backend. Compiled on every OS (not
/// `#[cfg]`-gated) so its safety-critical unit tests run on any platform; the
/// CoreGraphics/objc FFI that consumes it lives in `macos.rs`.
pub mod macos_park;
#[cfg(target_os = "linux")]
pub mod wayland_kde;
#[cfg(target_os = "windows")]
pub mod windows;
/// Pure parking logic for the Windows backend. Compiled on every OS (not
/// `#[cfg]`-gated) so its safety-critical unit tests run on any platform; the
/// Win32 FFI that consumes it lives in `windows.rs`.
pub mod windows_park;
#[cfg(target_os = "linux")]
pub mod x11;

// ── Backend trait ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    /// Human-readable name for the status lamp.
    pub label: String,
    /// Current desktop/workspace index (0-based).
    pub current_desktop: Option<usize>,
    /// Total number of desktops/workspaces.
    pub desktop_count: Option<usize>,
}

pub trait WorkspaceBackend: Send + Sync {
    fn name(&self) -> &'static str;
    fn info(&self) -> WorkspaceInfo;
    /// Make a tracked window visible according to this backend's workspace
    /// model. X11 moves it to desktop 0; other backends may restore/raise it.
    fn show_window(&self, window_id: u64) -> Result<(), String>;
    /// Hide a tracked window according to this backend's workspace model. X11
    /// parks it on desktop 1, the Tabtivity hidden workspace.
    fn hide_window(&self, window_id: u64) -> Result<(), String>;
    /// Compatibility helper for older command paths. Backend implementations
    /// should normally only need to implement show_window/hide_window.
    fn switch_to_project(
        &self,
        _project_id: Option<&str>,
        _previous_project_id: Option<&str>,
        previous_window_ids: &[u64],
        current_window_ids: &[u64],
    ) -> Result<(), String> {
        for &window_id in previous_window_ids {
            self.hide_window(window_id)?;
        }
        for &window_id in current_window_ids {
            self.show_window(window_id)?;
        }
        Ok(())
    }
    /// Whether this backend can host a frameless embedded external window
    /// (e.g. via X11 reparenting). Only X11 returns true; every other backend
    /// (null, KDE-Wayland, Windows) degrades the file→tab embed feature to a
    /// plain external launch. Default false so new backends are safe.
    fn supports_embedding(&self) -> bool {
        false
    }
    /// Whether a project switch actually hides the previous project's app
    /// windows on this desktop (desktop-parking on X11, SW_HIDE on Windows,
    /// app hide on macOS). `false` for a backend whose `show_window` /
    /// `hide_window` are no-ops — null (GNOME, XFCE, …) and KDE Wayland — so
    /// Settings can say so instead of the switch silently leaving every window
    /// where it was. Default true: the three parking backends inherit it.
    fn can_park(&self) -> bool {
        true
    }
    /// Called at startup to make Tabtivity visible on all desktops (sticky).
    fn make_sticky(&self, app_pid: u32) -> Result<(), String>;
    /// Called when the app exits — restore original desktop configuration.
    fn cleanup(&self) -> Result<(), String>;

    /// Mark a Tabtivity-owned window id as PARKABLE (#42). Detached subwindows
    /// share Tabtivity's `tabtivity` WM_CLASS, which is normally never parked so the
    /// MAIN window is never hidden. A detached subwindow is a *different* window
    /// that DOES want to follow the project-switch hide/show path, so it is
    /// explicitly opted in by id here.
    ///
    /// STRUCTURAL SAFETY: implementations MUST refuse the main window id so the
    /// "Tabtivity's own window is never parked" invariant holds even if a caller is
    /// buggy. The default no-op (null/Wayland/Windows) is safe — those backends
    /// don't desktop-park at all.
    fn set_parkable(&self, _window_id: u64) {}
    /// Remove a window id from the parkable override (on dock-back / close).
    fn unset_parkable(&self, _window_id: u64) {}
    /// Record the MAIN Tabtivity window's id so `set_parkable` can structurally
    /// refuse to ever add it to the override. Called once at startup when the
    /// main window's X11 id is resolved. Default no-op.
    fn set_main_window_id(&self, _window_id: u64) {}

    /// Move an already-mapped window to absolute physical root coordinates so it
    /// lands on the monitor containing (x, y). Used to place an externally
    /// launched app on the screen where a file was dropped. Best-effort;
    /// implemented on X11 (ConfigureWindow) and Windows (SetWindowPos). The
    /// default is a no-op for backends that cannot position foreign windows
    /// (KDE-Wayland forbids a client positioning another app's window; macOS
    /// has no public API for it; null has no windowing), which degrades
    /// gracefully to "the WM places it wherever it likes".
    fn position_window(&self, _window_id: u64, _x: i32, _y: i32) -> Result<(), String> {
        Ok(())
    }
}

// ── Factory ────────────────────────────────────────────────────────────────

pub fn detect_backend() -> Box<dyn WorkspaceBackend> {
    #[cfg(target_os = "windows")]
    {
        return Box::new(windows::WindowsBackend::new());
    }

    #[cfg(target_os = "linux")]
    {
        let desktop = std::env::var("XDG_CURRENT_DESKTOP")
            .unwrap_or_default()
            .to_lowercase();
        let wayland = x11::session_is_wayland();

        if wayland && (desktop.contains("kde") || desktop.contains("plasma")) {
            match wayland_kde::KdeWaylandBackend::try_new() {
                Ok(b) => return Box::new(b),
                Err(e) => eprintln!("workspace backend kde-wayland unavailable: {e}"),
            }
        }

        if desktop.contains("kde") || desktop.contains("plasma") {
            match x11::X11Backend::try_new() {
                Ok(b) => return Box::new(b),
                Err(e) => eprintln!("workspace backend x11 unavailable: {e}"),
            }
        }

        if desktop.contains("cinnamon") || desktop.contains("x-cinnamon") {
            match x11::X11Backend::try_new() {
                Ok(b) => return Box::new(b),
                Err(e) => eprintln!("workspace backend x11 unavailable: {e}"),
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        return Box::new(macos::MacBackend::new());
    }

    // Fallback for Linux desktops that matched no backend above, plus other
    // platforms. On Windows/macOS the early returns above are the only paths,
    // so gating this keeps it from being flagged as unreachable.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Box::new(null::NullBackend)
    }
}

/// Whether this process runs in a Wayland session — the ONE predicate every
/// "not under Wayland" branch asks, callable from code that compiles on every
/// OS. Linux delegates to [`x11::session_is_wayland`] (a non-empty
/// `WAYLAND_DISPLAY`); no other OS has a Wayland session.
pub fn session_is_wayland() -> bool {
    #[cfg(target_os = "linux")]
    {
        x11::session_is_wayland()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

// ── Super key ownership ───────────────────────────────────────────────────

/// Whether the desktop shell claims the lone Super/Meta key for itself.
///
/// Tabtivity binds the bare Super key to the panel toggle, which only works on a
/// desktop that leaves that key to the focused window. Cinnamon does — it is
/// the desktop the binding was written on. GNOME does not: Super opens the
/// Activities overview, and every `Super+<key>` shell shortcut (the apps grid,
/// the dock's Super+1..9, tiling, workspace switching) delivers a lone `Meta`
/// keydown to the focused window on the way past. On such a desktop the bare
/// binding fires on presses meant for the shell and the panels vanish with no
/// visible cause. That is the same reason Windows already uses F9 instead —
/// see the comment on the binding in `src/hooks/useKeyboard.ts`.
///
/// KDE/Plasma claims Meta for its launcher and Unity for the dash, so both are
/// treated the same way. Pure and string-in so it can be unit-tested on any
/// host; `desktop_owns_super_key` reads the environment and delegates here.
pub fn desktop_claims_super(desktop: &str) -> bool {
    let d = desktop.to_lowercase();
    d.contains("gnome") || d.contains("kde") || d.contains("plasma") || d.contains("unity")
}

/// The running desktop's answer to [`desktop_claims_super`].
///
/// Non-Linux hosts report `true` (the OS owns the key) — Windows opens the
/// Start menu on release and macOS uses Meta as the chord modifier, and the
/// frontend already routes both to F9 without asking.
pub fn desktop_owns_super_key() -> bool {
    #[cfg(target_os = "linux")]
    {
        desktop_claims_super(&std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default())
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_backend_always_returns_a_backend() {
        let b = detect_backend();
        let name = b.name();
        assert!(
            ["null", "x11", "kde-wayland", "windows", "macos"].contains(&name),
            "unknown backend name: {name}"
        );
    }

    #[test]
    fn detected_backend_info_does_not_panic() {
        let b = detect_backend();
        let _ = b.info(); // must not panic
    }

    #[test]
    fn detected_backend_show_hide_window_zero_does_not_panic() {
        let b = detect_backend();
        // 0 is an invalid window ID — backend must handle it gracefully.
        let _ = b.show_window(0);
        let _ = b.hide_window(0);
    }

    #[test]
    fn gnome_kde_and_unity_claim_the_super_key() {
        for desktop in ["ubuntu:GNOME", "GNOME", "KDE", "plasma", "Unity"] {
            assert!(
                desktop_claims_super(desktop),
                "{desktop} must be treated as owning the Super key"
            );
        }
    }

    #[test]
    fn cinnamon_and_unknown_desktops_leave_the_super_key_alone() {
        for desktop in ["X-Cinnamon", "cinnamon", "XFCE", "sway", ""] {
            assert!(
                !desktop_claims_super(desktop),
                "{desktop} must leave the Super key to the focused window"
            );
        }
    }

    #[test]
    fn null_backend_satisfies_workspace_backend_trait() {
        let b: Box<dyn WorkspaceBackend> = Box::new(null::NullBackend);
        assert_eq!(b.name(), "null");
        assert!(b.cleanup().is_ok());
    }

    #[test]
    fn null_backend_cannot_park() {
        let b: Box<dyn WorkspaceBackend> = Box::new(null::NullBackend);
        assert!(!b.can_park());
    }

    #[test]
    fn workspace_info_label_is_not_empty() {
        let b = detect_backend();
        let info = b.info();
        assert!(
            !info.label.is_empty(),
            "WorkspaceInfo.label must not be empty"
        );
    }
}
