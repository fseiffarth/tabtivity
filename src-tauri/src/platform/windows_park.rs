//! Pure parking logic for the Windows backend — OS-agnostic, FFI-free.
//!
//! Windows ships only the documented `IVirtualDesktopManager` (which can query a
//! window's desktop GUID and move a window to an *existing* desktop, but cannot
//! create or switch desktops); creating a dedicated "parked" desktop needs the
//! undocumented `IVirtualDesktopManagerInternal`, whose IID/vtable churn across
//! Windows 10/11 builds makes it unsafe to rely on. The Windows backend therefore
//! "parks" a project's windows by `SW_HIDE`-ing them, tracking the hidden set as
//! a logical "parked desktop" here.
//!
//! This module holds only the pure decision logic so the safety-critical
//! invariants can be unit tested on any OS (it is NOT `#[cfg]`-gated):
//!   - `WindowsParkState` — the parkable override + the structural main-window
//!     guard (mirroring x11.rs `ParkableState`) + the SW_HIDE "parked set" that
//!     stands in for X11's PARKED_DESKTOP membership.
//!   - `is_protected_process_name` — the Windows analog of x11.rs
//!     `is_protected_class` (there is no WM_CLASS on Windows, so protection keys
//!     on the owning process executable basename; owning-process *identity* is
//!     handled in the FFI layer via Tabtivity's own pid).

use std::collections::HashSet;

/// Executable basenames whose top-level windows must NEVER be parked: the
/// desktop shell and Tabtivity-named helpers. Mirrors x11.rs `PROTECTED_CLASSES`.
/// Tabtivity's own windows are additionally shielded by owning-process identity in
/// the FFI layer, so `tabtivity` here only guards same-named helper processes.
pub const PROTECTED_PROCESSES: &[&str] = &[
    crate::brand::BIN_NAME,
    // An older build still running under the app's old name (the same
    // entry twice until the name changes).
    crate::brand::LEGACY_BIN_NAME,
    "explorer",
    "dwm",
    "shellexperiencehost",
    "startmenuexperiencehost",
    "searchhost",
    "textinputhost",
    "applicationframehost",
];

/// Pure process-name check — the Windows analog of `is_protected_class`.
///
/// Lowercases, drops a trailing `.exe`, and matches whole segments (split on the
/// usual name separators) against `PROTECTED_PROCESSES`. Matching whole segments
/// rather than raw substrings keeps a process merely *containing* a protected
/// token (e.g. `tabtivityner.exe`) parkable — directly mirroring the X11 segment
/// logic and its `kwinter`/`tabtivityner` regression tests.
pub fn is_protected_process_name(exe_basename: &str) -> bool {
    let lowered = exe_basename.to_lowercase();
    let stem = lowered.strip_suffix(".exe").unwrap_or(&lowered);
    stem.split(['.', '-', '_', ' '])
        .any(|segment| PROTECTED_PROCESSES.contains(&segment))
}

/// The parkable override + the structurally-protected main window id + the set
/// of currently-hidden ("parked") window ids. Pure over its own state —
/// unit-testable without Win32. Mirrors x11.rs `ParkableState`, with the added
/// `parked` set as the SW_HIDE analog of X11's PARKED_DESKTOP membership: it
/// records exactly which HWNDs Tabtivity hid so cleanup restores precisely those.
#[derive(Default)]
pub struct WindowsParkState {
    override_ids: HashSet<u64>,
    /// The main Tabtivity window's HWND id, once known. `add_parkable` refuses to
    /// add this id, keeping "the main window is never parked" structural.
    main_window_id: Option<u64>,
    /// Window ids currently `SW_HIDE`-parked by Tabtivity.
    parked: HashSet<u64>,
}

impl WindowsParkState {
    /// Add `id` to the parkable override unless it is the main window id. Returns
    /// whether it was added. Pure over its own state — unit-testable without
    /// Win32. Mirrors x11.rs `ParkableState::add_parkable`.
    pub fn add_parkable(&mut self, id: u64) -> bool {
        if self.main_window_id == Some(id) {
            // STRUCTURAL GUARD: the main window must never be parkable, even if a
            // caller mistakenly asks. Refuse silently (debug-assert in tests).
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

    /// Record `id` as `SW_HIDE`-parked.
    pub fn mark_parked(&mut self, id: u64) {
        self.parked.insert(id);
    }

    /// Forget `id` from the parked set (it was shown again).
    pub fn unmark_parked(&mut self, id: u64) {
        self.parked.remove(&id);
    }

    /// Take the whole parked set, clearing it. Used by `cleanup` to restore
    /// exactly the windows Tabtivity hid (the SW_HIDE analog of X11 moving
    /// PARKED_DESKTOP windows back to ACTIVE_DESKTOP).
    pub fn drain_parked(&mut self) -> Vec<u64> {
        self.parked.drain().collect()
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────
//
// These exercise only the pure structs/fns (no Win32 calls), so they compile and
// run on any OS (Linux/macOS CI included), even though the FFI backend in
// `windows.rs` is `#[cfg(target_os = "windows")]`.

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_protected_process_name ──────────────────────────────────────────

    #[test]
    fn app_process_is_always_protected() {
        // The most critical invariant: Tabtivity's own helper processes must NEVER
        // be SW_HIDE-parked. (The main window is doubly protected via self_pid.)
        assert!(is_protected_process_name(concat!(crate::app_slug!(), ".exe")));
        assert!(is_protected_process_name(crate::app_slug!()));
        assert!(is_protected_process_name(crate::app_upper!())); // case-insensitive
        assert!(is_protected_process_name(concat!(crate::app_name!(), ".EXE")));
    }

    #[test]
    fn protected_processes_constant_includes_app() {
        // Regression guard: if someone removes "tabtivity" from PROTECTED_PROCESSES
        // by accident, this test fails immediately.
        assert!(
            PROTECTED_PROCESSES.contains(&crate::app_slug!()),
            concat!("PROTECTED_PROCESSES must contain \"", crate::app_slug!(), "\" or ", crate::app_name!(), " helpers could be hidden")
        );
    }

    #[test]
    fn desktop_shell_processes_are_protected() {
        assert!(is_protected_process_name("explorer.exe"));
        assert!(is_protected_process_name("dwm.exe"));
        assert!(is_protected_process_name("ShellExperienceHost.exe"));
        assert!(is_protected_process_name("ApplicationFrameHost.exe"));
    }

    #[test]
    fn ordinary_app_process_is_not_protected() {
        // Ordinary app windows must be parkable.
        assert!(!is_protected_process_name("code.exe"));
        assert!(!is_protected_process_name("firefox.exe"));
        assert!(!is_protected_process_name("konsole"));
        assert!(!is_protected_process_name("")); // empty → not protected
    }

    #[test]
    fn process_merely_containing_protected_token_is_parkable() {
        // Segment matching, not substring matching: an unrelated process whose
        // name happens to contain "tabtivity"/"explorer" must remain parkable — the
        // direct analog of x11's `kwinter`/`tabtivityner` test.
        assert!(!is_protected_process_name(concat!(crate::app_slug!(), "ner.exe")));
        assert!(!is_protected_process_name("explorerplus.exe"));
    }

    #[test]
    fn find_new_window_protection_rejects_shell_accepts_ordinary() {
        // The FFI-free name half of `windows.rs::is_protected_owner`, which
        // `find_new_window` uses to skip Tabtivity-self/shell windows that appear
        // during the launch poll. A protected basename is rejected; an ordinary
        // app basename is accepted (and would thus be a candidate new window).
        assert!(is_protected_process_name("explorer.exe"));
        assert!(is_protected_process_name("ApplicationFrameHost.exe"));
        assert!(!is_protected_process_name("code.exe"));
    }

    // ── parkable override (#42) ─────────────────────────────────────────────

    #[test]
    fn overridden_id_is_parkable() {
        // A detached subwindow's id, opted in, must be parkable despite its
        // owning process being Tabtivity (protected) — that is the #42 parking link.
        let mut state = WindowsParkState::default();
        assert!(state.add_parkable(42));
        assert!(state.is_parkable(42));
    }

    #[test]
    fn non_overridden_id_is_not_parkable() {
        let state = WindowsParkState::default();
        assert!(!state.is_parkable(99), "ids not opted in stay non-parkable");
    }

    #[test]
    fn main_window_id_can_never_become_parkable() {
        // The single most safety-critical invariant: the MAIN window must never
        // be parked. `add_parkable` refuses its id structurally.
        let mut state = WindowsParkState::default();
        state.set_main(7);
        // In debug builds add_parkable debug_asserts; in release it returns false.
        // Either way the id must NOT be in the override set afterwards.
        let added =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| state.add_parkable(7)));
        let _ = added; // result intentionally ignored
        assert!(
            !state.is_parkable(7),
            "the main window id must never enter the parkable override"
        );
    }

    #[test]
    fn other_ids_still_parkable_after_main_window_set() {
        let mut state = WindowsParkState::default();
        state.set_main(7);
        assert!(state.add_parkable(8));
        assert!(state.is_parkable(8));
        assert!(!state.is_parkable(7));
    }

    #[test]
    fn remove_parkable_clears_override() {
        let mut state = WindowsParkState::default();
        state.add_parkable(8);
        assert!(state.is_parkable(8));
        state.remove_parkable(8);
        assert!(!state.is_parkable(8));
    }

    // ── parked-set bookkeeping (SW_HIDE analog of PARKED_DESKTOP) ───────────

    #[test]
    fn mark_unmark_drain_parked_round_trips() {
        let mut state = WindowsParkState::default();
        state.mark_parked(10);
        state.mark_parked(11);
        state.unmark_parked(10);
        let drained = state.drain_parked();
        assert_eq!(drained, vec![11]);
        // drain_parked clears the set, so a second drain is empty.
        assert!(state.drain_parked().is_empty());
    }
}
