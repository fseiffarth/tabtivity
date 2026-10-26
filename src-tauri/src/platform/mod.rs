//! WorkspaceBackend trait and auto-detect factory.
//!
//! Detection (`detect_backend`; the Linux decision is the pure [`route`]):
//!   - Windows → `windows`; macOS → `macos` (one backend each, always).
//!   - Linux, KDE/Plasma in a Wayland session ([`session_is_wayland`]) →
//!     `kde-wayland`, which reports workspace info but cannot park windows.
//!   - Linux, KDE/Plasma (or a failed `kde-wayland` connect) → `x11`.
//!   - Linux, Cinnamon → `x11`, with Cinnamon's workspace settings.
//!   - Linux, GNOME (an `XDG_CURRENT_DESKTOP` segment `GNOME`), X11 *and*
//!     Wayland → `x11`, with GNOME's workspace settings
//!     ([`workspace_settings`]). Under Wayland it parks XWayland windows only;
//!     native Wayland windows never get an X id, so they stay where they are.
//!   - Everything else — XFCE, sway, …, or an `x11` connect that failed (no
//!     `DISPLAY`, XWayland disabled) → `null`, which parks nothing.

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
/// The desktop workspace settings the `x11` backend takes over while it runs.
/// Pure (injected `gsettings`), compiled on every OS so its tests run on all.
pub mod workspace_settings;
#[cfg(all(target_os = "linux", feature = "desktop"))]
pub mod x11;

// ── Other apps' windows ───────────────────────────────────────────────────

/// A top-level window of any app, as [`named_windows`] lists it.
#[derive(Debug, Clone)]
pub struct NamedWindow {
    /// The X11 window id / Windows `HWND`, as the backends number windows.
    pub id: u64,
    /// The X11 `WM_CLASS` (raw, NUL-separated) or the Windows executable's
    /// file name.
    pub class: String,
    pub title: String,
}

/// Every top-level window this platform lets Tabtivity see by class and title:
/// the X11 client list (under Wayland, its XWayland clients) and Windows'
/// visible top-levels. Empty on macOS and wherever the scan fails.
pub fn named_windows() -> Vec<NamedWindow> {
    #[cfg(all(target_os = "linux", feature = "desktop"))]
    {
        x11::named_client_windows()
    }
    #[cfg(target_os = "windows")]
    {
        windows::named_windows()
    }
    #[cfg(not(any(all(target_os = "linux", feature = "desktop"), target_os = "windows")))]
    {
        Vec::new()
    }
}

/// Raise and focus a window [`named_windows`] listed, past the window
/// manager's focus-stealing prevention where the platform allows it.
pub fn activate_window(window_id: u64) -> Result<(), String> {
    #[cfg(all(target_os = "linux", feature = "desktop"))]
    {
        x11::activate_window(window_id)
    }
    #[cfg(target_os = "windows")]
    {
        windows::activate_window(window_id)
    }
    #[cfg(not(any(all(target_os = "linux", feature = "desktop"), target_os = "windows")))]
    {
        let _ = window_id;
        Err("window activation is not supported here".into())
    }
}

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

/// The desktop an `x11` backend runs on: which workspace settings it takes
/// over ([`X11Desktop::settings`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum X11Desktop {
    /// KDE/Plasma: no settings table (KWin honours `_NET_NUMBER_OF_DESKTOPS`).
    Kde,
    Cinnamon,
    Gnome,
}

impl X11Desktop {
    /// The GSettings this desktop's workspaces live in, if the backend has to
    /// take them over (and so must not restore the count by EWMH request).
    pub fn settings(self) -> Option<&'static workspace_settings::DesktopSettings> {
        match self {
            X11Desktop::Kde => None,
            X11Desktop::Cinnamon => Some(&workspace_settings::CINNAMON),
            X11Desktop::Gnome => Some(&workspace_settings::GNOME),
        }
    }
}

/// Which backend a Linux desktop gets, before any connection is tried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// KDE under Wayland: `kde-wayland`, then `x11` (KDE) if that fails.
    KdeWayland,
    /// `x11` for this desktop.
    X11(X11Desktop),
    /// Nothing parks here.
    Null,
}

/// The Linux routing table, pure so every CI leg tests it. `desktop` is
/// `XDG_CURRENT_DESKTOP` (`:`-separated, any case); `wayland` is
/// [`session_is_wayland`]. A failed connect falls back to `null` in
/// [`detect_backend`].
pub fn route(desktop: &str, wayland: bool) -> Route {
    let d = desktop.to_lowercase();
    if d.contains("kde") || d.contains("plasma") {
        return if wayland { Route::KdeWayland } else { Route::X11(X11Desktop::Kde) };
    }
    if d.contains("cinnamon") {
        return Route::X11(X11Desktop::Cinnamon);
    }
    if d.split(':').any(|segment| segment.trim() == "gnome") {
        return Route::X11(X11Desktop::Gnome);
    }
    Route::Null
}

pub fn detect_backend() -> Box<dyn WorkspaceBackend> {
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsBackend::new())
    }

    // The server daemon's build has no X11 client (no `xcb`): a headless
    // server parks nothing.
    #[cfg(all(target_os = "linux", feature = "desktop"))]
    {
        let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
        let x11_desktop = match route(&desktop, x11::session_is_wayland()) {
            Route::KdeWayland => match wayland_kde::KdeWaylandBackend::try_new() {
                Ok(b) => return Box::new(b),
                Err(e) => {
                    eprintln!("workspace backend kde-wayland unavailable: {e}");
                    Some(X11Desktop::Kde)
                }
            },
            Route::X11(d) => Some(d),
            Route::Null => None,
        };
        // Under Wayland this X connection starts an on-demand XWayland if
        // none runs yet, and keeps it while the app runs.
        if let Some(d) = x11_desktop {
            match x11::X11Backend::try_new(d) {
                Ok(b) => return Box::new(b),
                Err(e) => eprintln!("workspace backend x11 unavailable: {e}"),
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacBackend::new())
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
    #[cfg(all(target_os = "linux", feature = "desktop"))]
    {
        x11::session_is_wayland()
    }
    #[cfg(all(target_os = "linux", not(feature = "desktop")))]
    {
        std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
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

    // The `detect_backend` tests never run on a Linux desktop build: there the
    // factory may connect to the session's X server and take over its
    // workspace settings (gsettings) — the test suite must never touch the
    // developer's desktop. `route`'s table test covers the decision.
    #[test]
    #[cfg(not(all(target_os = "linux", feature = "desktop")))]
    fn detect_backend_always_returns_a_backend() {
        let b = detect_backend();
        let name = b.name();
        assert!(
            ["null", "x11", "kde-wayland", "windows", "macos"].contains(&name),
            "unknown backend name: {name}"
        );
    }

    #[test]
    #[cfg(not(all(target_os = "linux", feature = "desktop")))]
    fn detected_backend_info_does_not_panic() {
        let b = detect_backend();
        let _ = b.info(); // must not panic
    }

    #[test]
    #[cfg(not(all(target_os = "linux", feature = "desktop")))]
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
    fn routes_each_desktop_to_its_backend() {
        use X11Desktop::*;
        let table = [
            ("ubuntu:GNOME", true, Route::X11(Gnome)),
            ("ubuntu:GNOME", false, Route::X11(Gnome)),
            ("GNOME", false, Route::X11(Gnome)),
            ("pop:GNOME", true, Route::X11(Gnome)),
            ("budgie:GNOME", false, Route::X11(Gnome)),
            ("KDE", false, Route::X11(Kde)),
            ("KDE", true, Route::KdeWayland),
            ("plasma", true, Route::KdeWayland),
            ("X-Cinnamon", false, Route::X11(Cinnamon)),
            ("XFCE", false, Route::Null),
            ("sway", true, Route::Null),
            // A segment must *be* GNOME, not merely contain it.
            ("GNOME-Classic-ish", false, Route::Null),
            ("Unity", false, Route::Null),
            ("", false, Route::Null),
        ];
        for (desktop, wayland, want) in table {
            assert_eq!(route(desktop, wayland), want, "{desktop} wayland={wayland}");
        }
    }

    #[test]
    fn only_gnome_and_cinnamon_take_settings_over() {
        assert!(X11Desktop::Kde.settings().is_none());
        assert_eq!(X11Desktop::Cinnamon.settings().unwrap().desktop, "cinnamon");
        assert_eq!(X11Desktop::Gnome.settings().unwrap().desktop, "gnome");
    }

    #[test]
    #[cfg(not(all(target_os = "linux", feature = "desktop")))]
    fn workspace_info_label_is_not_empty() {
        let b = detect_backend();
        let info = b.info();
        assert!(
            !info.label.is_empty(),
            "WorkspaceInfo.label must not be empty"
        );
    }
}
