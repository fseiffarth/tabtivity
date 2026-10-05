//! Pure parking logic for the macOS backend — OS-agnostic, FFI-free.
//!
//! macOS has no public API to hide a single *window* of another application:
//! per-window manipulation of foreign apps needs the private CGS (SkyLight)
//! calls, which are rejected here for the same build-fragility reason the
//! undocumented `IVirtualDesktopManagerInternal` is rejected on Windows. The
//! macOS backend therefore parks at **app granularity**: hiding a tracked
//! window means `NSRunningApplication hide` on its owning app, and showing it
//! means `unhide`. A hidden app's windows leave the on-screen `CGWindowList`,
//! so show cannot re-resolve the owner from a live enumeration — the pid is
//! recorded at hide time in the parked map keyed by window id.
//!
//! This module holds only the pure decision logic so the safety-critical
//! invariants can be unit tested on any OS (it is NOT `#[cfg]`-gated):
//!   - `MacParkState` — the parkable override + the structural main-window
//!     guard (mirroring `windows_park::WindowsParkState`) + the parked
//!     window-id → owner-pid map that stands in for X11's PARKED_DESKTOP
//!     membership.
//!   - `is_protected_owner_name` — the macOS analog of
//!     `is_protected_process_name`, keyed on `kCGWindowOwnerName`.
//!   - `frontmost_at_point` — the occlusion geometry for the popout drop-merge
//!     check, over `CGWindowList` bounds snapshots.

use std::collections::HashMap;
use std::collections::HashSet;

/// Owner names (per `kCGWindowOwnerName`, lowercased) whose windows must NEVER
/// be parked: Tabtivity itself plus the macOS shell surfaces. Mirrors
/// `windows_park::PROTECTED_PROCESSES`. Tabtivity's own windows are additionally
/// shielded by owning-process identity (self pid) in the FFI layer, so
/// `tabtivity` here only guards same-named helper processes.
pub const PROTECTED_OWNERS: &[&str] = &[
    crate::brand::BIN_NAME,
    // An older build still running under the app's old name (the same
    // entry twice until the name changes).
    crate::brand::LEGACY_BIN_NAME,
    "dock",
    "finder",
    "windowserver",
    "systemuiserver",
    "controlcenter",
    "notificationcenter",
];

/// Pure owner-name check — the macOS analog of `is_protected_process_name`.
///
/// Lowercases, drops a trailing `.app`, and matches whole segments (split on
/// the usual name separators) against [`PROTECTED_OWNERS`]. Segment matching
/// rather than raw substring matching keeps an owner merely *containing* a
/// protected token (e.g. "Docker" contains "dock"? no — segments — or
/// "tabtivityner") parkable, directly mirroring the X11 `kwinter`/`tabtivityner`
/// regression tests.
pub fn is_protected_owner_name(owner: &str) -> bool {
    let lowered = owner.to_lowercase();
    let stem = lowered.strip_suffix(".app").unwrap_or(&lowered);
    stem.split(['.', '-', '_', ' '])
        .any(|segment| PROTECTED_OWNERS.contains(&segment))
}

/// The parkable override + the structurally-protected main window id + the
/// map of currently-hidden ("parked") window ids to the owner pid recorded at
/// hide time. Pure over its own state — unit-testable without CoreGraphics.
/// Mirrors `windows_park::WindowsParkState`; the map (not a set) exists
/// because a hidden app's windows vanish from the on-screen `CGWindowList`,
/// so `show_window`/`cleanup` must key the `unhide` on the remembered pid.
#[derive(Default)]
pub struct MacParkState {
    override_ids: HashSet<u64>,
    /// The main Tabtivity window's `CGWindowID`, once known. `add_parkable`
    /// refuses to add this id, keeping "the main window is never parked"
    /// structural.
    main_window_id: Option<u64>,
    /// window id → owner pid recorded when the app was hidden.
    parked: HashMap<u64, u32>,
}

impl MacParkState {
    /// Add `id` to the parkable override unless it is the main window id.
    /// Returns whether it was added. Mirrors `WindowsParkState::add_parkable`.
    pub fn add_parkable(&mut self, id: u64) -> bool {
        if self.main_window_id == Some(id) {
            // STRUCTURAL GUARD: the main window must never be parkable, even if
            // a caller mistakenly asks. Refuse silently (debug-assert in tests).
            debug_assert!(false, concat!("attempted to mark the MAIN ", crate::app_name!(), " window parkable"));
            return false;
        }
        self.override_ids.insert(id)
    }

    /// Remove `id` from the parkable override (on dock-back / close).
    pub fn remove_parkable(&mut self, id: u64) {
        self.override_ids.remove(&id);
    }

    pub fn is_parkable(&self, id: u64) -> bool {
        self.override_ids.contains(&id)
    }

    /// Record the MAIN Tabtivity window's id so `add_parkable` can structurally
    /// refuse to ever add it to the override.
    pub fn set_main(&mut self, id: u64) {
        self.main_window_id = Some(id);
    }

    /// Record window `id` as parked, remembering the owning `pid` the hide was
    /// issued against (the app has left the on-screen list by the time show
    /// runs, so this pid is the only way back).
    pub fn mark_parked(&mut self, id: u64, pid: u32) {
        self.parked.insert(id, pid);
    }

    /// The pid recorded for a parked window id, if any.
    pub fn parked_pid(&self, id: u64) -> Option<u32> {
        self.parked.get(&id).copied()
    }

    /// Forget `id` from the parked map (its app was unhidden again).
    pub fn unmark_parked(&mut self, id: u64) {
        self.parked.remove(&id);
    }

    /// Take the whole parked map, clearing it. Used by `cleanup` to unhide
    /// exactly the apps Tabtivity hid.
    pub fn drain_parked(&mut self) -> Vec<(u64, u32)> {
        self.parked.drain().collect()
    }
}

/// One on-screen window's geometry as snapshotted from `CGWindowList`, in the
/// CG global coordinate space (origin top-left, y growing downward — the same
/// space `CGEventGetLocation` reports the pointer in).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WinRect {
    pub id: u64,
    /// `kCGWindowLayer`. Layer 0 is the normal app-window layer; anything else
    /// (menu bar, Dock, overlays) is not a candidate for the drop-merge check.
    pub layer: i32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The id of the front-most **layer-0** window containing point `(x, y)`,
/// given `windows` in front-to-back order (the order `CGWindowListCopyWindowInfo`
/// returns on-screen windows in). Containment is half-open, `[x, x+w)` /
/// `[y, y+h)`, matching pixel ownership. `None` when no normal window is under
/// the point. The macOS analog of x11.rs `frontmost_window_under_pointer`'s
/// stacking walk, used by the popout occlusion check (#42).
pub fn frontmost_at_point(windows: &[WinRect], x: f64, y: f64) -> Option<u64> {
    windows
        .iter()
        .find(|w| w.layer == 0 && x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h)
        .map(|w| w.id)
}

// ── Tests ──────────────────────────────────────────────────────────────────
//
// These exercise only the pure structs/fns (no CoreGraphics calls), so they
// compile and run on any OS, even though the FFI backend in `macos.rs` is
// `#[cfg(target_os = "macos")]` and cannot even be compile-checked on Linux.

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_protected_owner_name ─────────────────────────────────────────────

    #[test]
    fn app_owner_is_always_protected() {
        // The most critical invariant: Tabtivity-named apps must NEVER be hidden.
        // (The main window is doubly protected via the self-pid check.)
        assert!(is_protected_owner_name(crate::app_name!()));
        assert!(is_protected_owner_name(crate::app_slug!()));
        assert!(is_protected_owner_name(crate::app_upper!()));
        assert!(is_protected_owner_name(concat!(crate::app_name!(), ".app")));
    }

    #[test]
    fn protected_owners_constant_includes_app() {
        assert!(
            PROTECTED_OWNERS.contains(&crate::app_slug!()),
            concat!("PROTECTED_OWNERS must contain \"", crate::app_slug!(), "\" or ", crate::app_name!(), " helpers could be hidden")
        );
    }

    #[test]
    fn macos_shell_owners_are_protected() {
        assert!(is_protected_owner_name("Dock"));
        assert!(is_protected_owner_name("Finder"));
        assert!(is_protected_owner_name("WindowServer"));
        assert!(is_protected_owner_name("SystemUIServer"));
        assert!(is_protected_owner_name("ControlCenter"));
        assert!(is_protected_owner_name("NotificationCenter"));
    }

    #[test]
    fn ordinary_app_owner_is_not_protected() {
        assert!(!is_protected_owner_name("Safari"));
        assert!(!is_protected_owner_name("Visual Studio Code"));
        assert!(!is_protected_owner_name("kitty"));
        assert!(!is_protected_owner_name("")); // empty → not protected
    }

    #[test]
    fn owner_merely_containing_protected_token_is_parkable() {
        // Segment matching, not substring matching — the macOS analog of the
        // x11 `kwinter`/`tabtivityner` regression tests.
        assert!(!is_protected_owner_name(concat!(crate::app_slug!(), "ner")));
        assert!(!is_protected_owner_name("Docker")); // contains "dock" as substring only
        assert!(!is_protected_owner_name("Pathfinder")); // contains "finder" as substring only
    }

    // ── parkable override (#42) ─────────────────────────────────────────────

    #[test]
    fn overridden_id_is_parkable() {
        let mut state = MacParkState::default();
        assert!(state.add_parkable(42));
        assert!(state.is_parkable(42));
    }

    #[test]
    fn non_overridden_id_is_not_parkable() {
        let state = MacParkState::default();
        assert!(!state.is_parkable(99));
    }

    #[test]
    fn main_window_id_can_never_become_parkable() {
        // The single most safety-critical invariant, structural like on the
        // other backends: the MAIN window id is refused by add_parkable.
        let mut state = MacParkState::default();
        state.set_main(7);
        let added =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| state.add_parkable(7)));
        let _ = added; // debug builds panic on the debug_assert; either way:
        assert!(
            !state.is_parkable(7),
            "the main window id must never enter the parkable override"
        );
    }

    #[test]
    fn other_ids_still_parkable_after_main_window_set() {
        let mut state = MacParkState::default();
        state.set_main(7);
        assert!(state.add_parkable(8));
        assert!(state.is_parkable(8));
        assert!(!state.is_parkable(7));
    }

    #[test]
    fn remove_parkable_clears_override() {
        let mut state = MacParkState::default();
        state.add_parkable(8);
        state.remove_parkable(8);
        assert!(!state.is_parkable(8));
    }

    // ── parked map (hide-time pid round-trip) ───────────────────────────────

    #[test]
    fn park_records_pid_for_show() {
        // Hidden apps leave the on-screen CGWindowList, so show must key on
        // the pid recorded at hide time — the map is the only way back.
        let mut state = MacParkState::default();
        state.mark_parked(10, 501);
        assert_eq!(state.parked_pid(10), Some(501));
        assert_eq!(state.parked_pid(11), None);
    }

    #[test]
    fn unmark_and_drain_parked_round_trip() {
        let mut state = MacParkState::default();
        state.mark_parked(10, 501);
        state.mark_parked(11, 502);
        state.unmark_parked(10);
        let drained = state.drain_parked();
        assert_eq!(drained, vec![(11, 502)]);
        assert!(state.drain_parked().is_empty(), "drain clears the map");
    }

    #[test]
    fn repark_overwrites_recorded_pid() {
        // A window id re-hidden after its app restarted must track the NEW pid.
        let mut state = MacParkState::default();
        state.mark_parked(10, 501);
        state.mark_parked(10, 601);
        assert_eq!(state.parked_pid(10), Some(601));
    }

    // ── occlusion geometry (popout drop-merge check, #42) ───────────────────

    fn rect(id: u64, layer: i32, x: f64, y: f64, w: f64, h: f64) -> WinRect {
        WinRect {
            id,
            layer,
            x,
            y,
            w,
            h,
        }
    }

    #[test]
    fn topmost_containing_window_wins() {
        // Front-to-back order: window 1 overlaps window 2; the point is inside
        // both, so the front one (listed first) must win.
        let wins = [
            rect(1, 0, 0.0, 0.0, 100.0, 100.0),
            rect(2, 0, 50.0, 50.0, 100.0, 100.0),
        ];
        assert_eq!(frontmost_at_point(&wins, 60.0, 60.0), Some(1));
        // A point only inside the back window resolves to it.
        assert_eq!(frontmost_at_point(&wins, 120.0, 120.0), Some(2));
    }

    #[test]
    fn non_zero_layer_windows_are_skipped() {
        // The menu bar / Dock / overlay layers must never win the check — a
        // popout under the menu bar is still the frontmost *app* window.
        let wins = [
            rect(9, 25, 0.0, 0.0, 100.0, 100.0), // overlay layer in front
            rect(1, 0, 0.0, 0.0, 100.0, 100.0),
        ];
        assert_eq!(frontmost_at_point(&wins, 10.0, 10.0), Some(1));
    }

    #[test]
    fn point_outside_every_window_is_none() {
        let wins = [rect(1, 0, 0.0, 0.0, 100.0, 100.0)];
        assert_eq!(frontmost_at_point(&wins, 500.0, 500.0), None);
        assert_eq!(frontmost_at_point(&[], 0.0, 0.0), None);
    }

    #[test]
    fn containment_is_half_open() {
        // [x, x+w): the left/top edge belongs to the window, the right/bottom
        // edge does not — matching pixel ownership.
        let wins = [rect(1, 0, 10.0, 10.0, 100.0, 100.0)];
        assert_eq!(frontmost_at_point(&wins, 10.0, 10.0), Some(1));
        assert_eq!(frontmost_at_point(&wins, 110.0, 50.0), None);
        assert_eq!(frontmost_at_point(&wins, 50.0, 110.0), None);
        assert_eq!(frontmost_at_point(&wins, 109.999, 109.999), Some(1));
    }
}
