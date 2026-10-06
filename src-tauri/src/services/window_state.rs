//! Startup geometry for the MAIN window: decide where to reopen it from the
//! rect saved on the last run (`settings.window_state`).
//!
//! Pure and `AppHandle`-free so every rule below is unit-tested on any OS; the
//! Tauri calls that consume the result live in `lib.rs`'s `setup`.
//!
//! The job is *not* "apply the saved rect". It is "apply the saved rect only if a
//! currently-connected monitor can still host it". A user who saved Tabtivity on an
//! external display and then undocked would otherwise get a window mapped at
//! x=2400 on a laptop whose only screen ends at 1920 — off-screen, unreachable,
//! and indistinguishable from "Tabtivity didn't start". Whenever we can't place the
//! rect confidently we return `None`, which means "leave the window exactly as
//! `tauri.conf.json` configured it" (maximized, WM's choice of monitor) — i.e. we
//! degrade to today's behaviour rather than to a broken one.
//!
//! All coordinates are PHYSICAL desktop pixels (see `schema::settings::WindowState`).

use crate::schema::settings::WindowState;

/// Native Wayland's fallback park: a popout of an inactive scope that still
/// holds unsaved work (or never answered the retire request) is minimized
/// instead of closed. GTK never reports minimization there, so this set is the
/// only record of our requests — and what `sync_detached_scope` presents again
/// when the scope returns.
#[derive(Default)]
pub struct DetachedParking {
    parked: std::collections::HashSet<String>,
}

impl DetachedParking {
    pub fn is_parked(&self, label: &str) -> bool {
        self.parked.contains(label)
    }

    /// True only when this scope transition needs a minimize/present request.
    pub fn transition(&mut self, label: &str, visible: bool) -> bool {
        if visible {
            self.parked.remove(label)
        } else {
            self.parked.insert(label.to_owned())
        }
    }

    pub fn forget(&mut self, label: &str) {
        self.parked.remove(label);
    }
}

/// Native Wayland: an inactive scope's popout is CLOSED, not minimized, and
/// respawned from its kept store record when the scope comes back. A minimized
/// popout could not be tracked there (GTK never reports the state), so any way
/// the compositor put it back on screen — ignoring the request, Alt+Tab, the
/// overview — left a blank window over the other project (the renderer hides a
/// parked popout's panes).
///
/// A retire runs in two steps, and this is the bookkeeping for both:
/// - **pending**: the popout was asked to flush its unsaved work
///   (`detached-retire-request-<label>`) and has not answered. Tokened, so a
///   scope that comes back first cancels it, and an answer to an older request
///   is ignored.
/// - **retiring**: `destroy()` has been issued. The `Destroyed` hook reads this
///   to tell an intended close (keep the record; it will respawn) from a crash
///   (dock the tabs back, #224), and a respawn of the same label waits for it.
///
/// AppHandle-free, so every transition is unit-tested.
#[derive(Default)]
pub struct DetachedRetire {
    next_token: u64,
    pending: std::collections::HashMap<String, u64>,
    retiring: std::collections::HashSet<String>,
    acks: std::collections::HashMap<String, (u64, std::sync::mpsc::Sender<bool>)>,
    /// Popouts whose renderer has attached its retire listener. One that has
    /// not (still loading, or a renderer from before this protocol) can hold
    /// no unsaved work and could not answer anyway, so it is closed directly.
    ready: std::collections::HashSet<String>,
}

impl DetachedRetire {
    /// Open a retire handshake for `label`. `None` when one is already running
    /// or the window is already on its way out — a repeated sync never asks twice.
    pub fn begin(&mut self, label: &str) -> Option<u64> {
        if self.pending.contains_key(label) || self.retiring.contains(label) {
            return None;
        }
        self.next_token += 1;
        self.pending.insert(label.to_owned(), self.next_token);
        Some(self.next_token)
    }

    /// The popout's scope is active again before it answered: keep the window.
    pub fn cancel(&mut self, label: &str) -> bool {
        self.acks.remove(label);
        self.pending.remove(label).is_some()
    }

    /// Close the handshake `token` opened. True only while it is still the live
    /// request for `label` — false once cancelled or superseded.
    pub fn take(&mut self, label: &str, token: u64) -> bool {
        if self.pending.get(label) == Some(&token) {
            self.pending.remove(label);
            if self.acks.get(label).is_some_and(|(t, _)| *t == token) {
                self.acks.remove(label);
            }
            true
        } else {
            false
        }
    }

    /// The popout's renderer can now answer a retire request.
    pub fn mark_ready(&mut self, label: &str) {
        self.ready.insert(label.to_owned());
    }

    pub fn is_ready(&self, label: &str) -> bool {
        self.ready.contains(label)
    }

    /// Drop everything but an issued retire (whose `Destroyed` must still be
    /// recognised): the label's window is being released.
    pub fn forget(&mut self, label: &str) {
        self.cancel(label);
        self.ready.remove(label);
    }

    pub fn is_pending(&self, label: &str) -> bool {
        self.pending.contains_key(label)
    }

    /// Where the popout's answer goes for request `token`.
    pub fn await_ack(&mut self, label: &str, token: u64, tx: std::sync::mpsc::Sender<bool>) {
        if self.pending.get(label) == Some(&token) {
            self.acks.insert(label.to_owned(), (token, tx));
        }
    }

    /// Deliver the popout's answer (`clean` = nothing unsaved is left in it).
    pub fn ack(&mut self, label: &str, clean: bool) -> bool {
        match self.acks.remove(label) {
            Some((_, tx)) => tx.send(clean).is_ok(),
            None => false,
        }
    }

    pub fn mark_retiring(&mut self, label: &str) {
        self.pending.remove(label);
        self.acks.remove(label);
        self.retiring.insert(label.to_owned());
    }

    pub fn is_retiring(&self, label: &str) -> bool {
        self.retiring.contains(label)
    }

    /// An issued retire is taken back and the window KEPT (its scope came back
    /// before the destroy, or the destroy failed). Only the retiring mark goes:
    /// the popout's renderer is still attached and can still answer, so it
    /// stays ready — forgetting that would close it unasked, unsaved work and
    /// all, at the next scope-out.
    pub fn withdraw(&mut self, label: &str) -> bool {
        self.retiring.remove(label)
    }

    /// The window died. True when it was an intended retire (and clears it);
    /// false for every other death, which must still dock its tabs back.
    pub fn finish(&mut self, label: &str) -> bool {
        self.forget(label);
        self.retiring.remove(label)
    }
}

/// One connected monitor's position and size in physical desktop px, as reported
/// by Tauri's `available_monitors()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// How much of the saved window must still land on a real monitor for us to trust
/// it. Sized to be a grabbable strip of title bar — enough that the user can
/// always drag the window back into view. Below this we discard the saved rect
/// entirely rather than place a window the user can't reach.
const MIN_VISIBLE_W: i64 = 200;
const MIN_VISIBLE_H: i64 = 80;

/// Floor for a restored window, matching `minWidth`/`minHeight` in
/// `tauri.conf.json`. A corrupt or hand-edited `settings.json` can't shrink the
/// window to nothing.
const MIN_W: u32 = 800;
const MIN_H: u32 = 600;

/// The geometry to apply to the main window at startup, or `None` to leave it as
/// `tauri.conf.json` configured it.
///
/// `None` is returned when there is nothing saved, when Tauri reports no monitors
/// (it can return an empty list on a compositor that hasn't settled — guessing
/// from a saved rect we can't validate is worse than the default), or when the
/// saved rect no longer meaningfully overlaps any connected monitor.
///
/// Otherwise the rect is fitted to the monitor it overlaps most: clamped to that
/// monitor's size and shifted so it sits fully inside it. `maximized` passes
/// straight through — a maximized window still needs its rect resolved, because
/// that rect is what decides *which monitor* it re-maximizes on.
pub fn resolve_startup_geometry(
    saved: Option<WindowState>,
    monitors: &[MonitorRect],
) -> Option<WindowState> {
    let saved = saved?;
    if monitors.is_empty() {
        return None;
    }
    // A zero/negative-sized saved rect can't be intersected meaningfully.
    if saved.w == 0 || saved.h == 0 {
        return None;
    }

    let best = monitors
        .iter()
        .max_by_key(|m| overlap_area(&saved, m))
        .copied()?;

    let (ow, oh) = overlap_dims(&saved, &best);
    if ow < MIN_VISIBLE_W || oh < MIN_VISIBLE_H {
        return None;
    }

    // Fit to the monitor: never wider/taller than the screen, never below the
    // configured minimum, then slid back inside if it hangs off an edge.
    let w = saved.w.clamp(MIN_W.min(best.w), best.w);
    let h = saved.h.clamp(MIN_H.min(best.h), best.h);
    let x = saved.x.clamp(best.x, best.x + best.w as i32 - w as i32);
    let y = saved.y.clamp(best.y, best.y + best.h as i32 - h as i32);

    Some(WindowState {
        x,
        y,
        w,
        h,
        maximized: saved.maximized,
    })
}

/// Geometry to re-apply to a DETACHED popout on project switch-back (#42).
///
/// The switch path hides an inactive project's popouts and re-shows them on
/// switch-back; `hide()`/`show()` lets the WM move the window — typically onto
/// the primary monitor — so the geometry captured just before hiding must be
/// re-applied, or a multi-monitor popout lands on the wrong screen. This
/// validates that captured rect against the CURRENTLY connected monitors (the
/// same monitor-fit the main window uses at startup) so a monitor unplugged
/// while the project was inactive can't strand the popout off-screen.
///
/// Two things differ from [`resolve_startup_geometry`]:
///   * An **empty** monitor list re-applies the captured rect unchanged rather
///     than giving up — mid-session the rect is known-good (the popout was just
///     visible there) and a transient empty read is no reason to leave it
///     WM-misplaced.
///   * It imposes **no minimum size**. A borderless popout has no configured
///     `minWidth`/`minHeight` (the main window does), so growing it to 800×600
///     would silently resize a deliberately small popout.
///
/// Returns `None` only when the captured rect is degenerate, or when it no
/// longer meaningfully overlaps any connected monitor (the display it lived on
/// was unplugged) — in which case the caller leaves the WM's placement rather
/// than flinging the window off-screen.
pub fn resolve_detached_geometry(
    saved: WindowState,
    monitors: &[MonitorRect],
) -> Option<WindowState> {
    if saved.w == 0 || saved.h == 0 {
        return None;
    }
    if monitors.is_empty() {
        return Some(saved);
    }

    let best = monitors
        .iter()
        .max_by_key(|m| overlap_area(&saved, m))
        .copied()?;

    let (ow, oh) = overlap_dims(&saved, &best);
    if ow < MIN_VISIBLE_W || oh < MIN_VISIBLE_H {
        return None;
    }

    // Fit to the monitor WITHOUT a minimum-size floor: never larger than the
    // screen, then slid back inside if it hangs off an edge.
    let w = saved.w.min(best.w);
    let h = saved.h.min(best.h);
    let x = saved.x.clamp(best.x, best.x + best.w as i32 - w as i32);
    let y = saved.y.clamp(best.y, best.y + best.h as i32 - h as i32);
    Some(WindowState {
        x,
        y,
        w,
        h,
        maximized: false,
    })
}

/// Geometry that fits a detached popout entirely onto the screen it is on
/// (Group B #240) — the "snap to this screen" rescue.
///
/// Used by two callers with the same need: the title-bar double-click gesture,
/// and the monitor-arrangement watcher that runs when a display is unplugged.
/// Both start from a window whose rect may be *larger than* or *entirely off*
/// every remaining screen — undocking from a 2560x1440 external onto a
/// 1920x1080 laptop panel leaves a popout wider and taller than the only screen
/// left, with its bottom-right corner (and, borderless, every resize edge)
/// past the panel.
///
/// Unlike [`resolve_detached_geometry`], which validates a *remembered* rect and
/// answers `None` when it can no longer be trusted (leaving the WM's placement),
/// this one is about a window that is on screen right now and must stay
/// reachable, so it never gives up on a live monitor list:
///   * zero overlap with every monitor picks the monitor whose centre is
///     nearest, rather than returning `None`;
///   * the rect is clamped to that monitor's size and slid fully inside it.
///
/// `None` means "nothing to do": no monitors to fit onto, a degenerate rect, or
/// a window that already fits exactly where it is — which is what keeps the
/// watcher from re-applying the same geometry on every poll.
pub fn snap_detached_geometry(
    current: WindowState,
    monitors: &[MonitorRect],
) -> Option<WindowState> {
    if current.w == 0 || current.h == 0 {
        return None;
    }
    let best = monitors
        .iter()
        .copied()
        .max_by_key(|m| overlap_area(&current, m))
        .filter(|m| overlap_area(&current, m) > 0)
        .or_else(|| nearest_monitor(&current, monitors))?;

    let w = current.w.min(best.w);
    let h = current.h.min(best.h);
    let x = current.x.clamp(best.x, best.x + best.w as i32 - w as i32);
    let y = current.y.clamp(best.y, best.y + best.h as i32 - h as i32);
    let fitted = WindowState {
        x,
        y,
        w,
        h,
        maximized: false,
    };
    (fitted.x != current.x || fitted.y != current.y || fitted.w != current.w || fitted.h != current.h)
        .then_some(fitted)
}

/// Where a popout goes whose own screen is gone: `w`×`h` (fitted to the
/// screen) centred on `monitor` — the main window's, so it stays a separate
/// window beside the main one rather than landing wherever the WM puts new
/// windows. `None` for a degenerate size.
pub fn center_on_monitor(w: u32, h: u32, monitor: MonitorRect) -> Option<WindowState> {
    if w == 0 || h == 0 || monitor.w == 0 || monitor.h == 0 {
        return None;
    }
    let (w, h) = (w.min(monitor.w), h.min(monitor.h));
    Some(WindowState {
        x: monitor.x + ((monitor.w - w) / 2) as i32,
        y: monitor.y + ((monitor.h - h) / 2) as i32,
        w,
        h,
        maximized: false,
    })
}

/// The monitor whose centre is closest to the window's centre. Only consulted
/// when the window overlaps none of them (its display was unplugged and the WM
/// left it in the void), so "closest" is the best available notion of which
/// screen the user last had it on.
fn nearest_monitor(s: &WindowState, monitors: &[MonitorRect]) -> Option<MonitorRect> {
    let (cx, cy) = (s.x as i64 + s.w as i64 / 2, s.y as i64 + s.h as i64 / 2);
    monitors.iter().copied().min_by_key(|m| {
        let (mx, my) = (m.x as i64 + m.w as i64 / 2, m.y as i64 + m.h as i64 / 2);
        (cx - mx).pow(2) + (cy - my).pow(2)
    })
}

/// Width/height of the intersection between a saved window rect and a monitor, in
/// physical px. `i64` because `x + w` on two `i32`s can overflow in principle and
/// these feed a comparison, not a coordinate.
fn overlap_dims(s: &WindowState, m: &MonitorRect) -> (i64, i64) {
    let (sx, sy) = (s.x as i64, s.y as i64);
    let (sx2, sy2) = (sx + s.w as i64, sy + s.h as i64);
    let (mx, my) = (m.x as i64, m.y as i64);
    let (mx2, my2) = (mx + m.w as i64, my + m.h as i64);
    let w = (sx2.min(mx2) - sx.max(mx)).max(0);
    let h = (sy2.min(my2) - sy.max(my)).max(0);
    (w, h)
}

fn overlap_area(s: &WindowState, m: &MonitorRect) -> i64 {
    let (w, h) = overlap_dims(s, m);
    w * h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_popout_without_its_screen_is_centred_on_the_main_windows() {
        let laptop = MonitorRect { x: 0, y: 0, w: 1920, h: 1080 };
        let g = center_on_monitor(1000, 600, laptop).unwrap();
        assert_eq!((g.x, g.y, g.w, g.h), (460, 240, 1000, 600));
        // Sized on a bigger external screen: shrunk to fit, never past an edge.
        let g = center_on_monitor(2560, 1400, laptop).unwrap();
        assert_eq!((g.x, g.y, g.w, g.h), (0, 0, 1920, 1080));
        // A main window on a screen right of the primary.
        let right = MonitorRect { x: 1920, y: 0, w: 1280, h: 1024 };
        let g = center_on_monitor(800, 600, right).unwrap();
        assert_eq!((g.x, g.y), (2160, 212));
        assert!(center_on_monitor(0, 600, laptop).is_none());
    }

    #[test]
    fn wayland_scope_parking_is_independent_and_idempotent() {
        let mut parking = DetachedParking::default();
        // An active window is never presented just because sync ran again.
        assert!(!parking.transition("detached-p1-g1", true));
        for label in ["detached-p1-g1", "detached-p1-g2", "detached-box:b1-g1"] {
            assert!(parking.transition(label, false));
            assert!(parking.is_parked(label));
            // Backend switch and frontend scope sync both park the same set.
            assert!(!parking.transition(label, false));
        }
        for label in ["detached-p1-g1", "detached-p1-g2"] {
            assert!(parking.transition(label, true));
            assert!(!parking.is_parked(label));
            assert!(!parking.transition(label, true));
        }
        assert!(parking.is_parked("detached-box:b1-g1"));
        assert!(parking.transition("detached-p1-g1", false));
    }

    #[test]
    fn a_retire_handshake_is_asked_once_and_a_returning_scope_cancels_it() {
        let mut r = DetachedRetire::default();
        let t = r.begin("detached-p1-g1").expect("first sync asks");
        // A second sync away from the same scope does not ask again.
        assert_eq!(r.begin("detached-p1-g1"), None);
        assert!(r.is_pending("detached-p1-g1"));
        // The scope comes back before the popout answered.
        assert!(r.cancel("detached-p1-g1"));
        // The late answer finds nothing to act on.
        assert!(!r.take("detached-p1-g1", t));
        // A fresh switch away opens a NEW request; the old token stays dead.
        let t2 = r.begin("detached-p1-g1").unwrap();
        assert_ne!(t, t2);
        assert!(!r.take("detached-p1-g1", t));
        assert!(r.take("detached-p1-g1", t2));
        assert!(!r.is_pending("detached-p1-g1"));
    }

    #[test]
    fn the_popouts_answer_reaches_only_the_live_request() {
        let mut r = DetachedRetire::default();
        let t = r.begin("detached-p1-g1").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        r.await_ack("detached-p1-g1", t, tx);
        assert!(r.ack("detached-p1-g1", false));
        assert!(!rx.recv().unwrap());
        // Nothing waits any more: a duplicate answer is dropped.
        assert!(!r.ack("detached-p1-g1", true));
        // A stale token cannot install a waiter.
        let (tx2, _rx2) = std::sync::mpsc::channel();
        r.await_ack("detached-p1-g1", t + 99, tx2);
        assert!(!r.ack("detached-p1-g1", true));
    }

    #[test]
    fn readiness_is_per_window_life() {
        let mut r = DetachedRetire::default();
        assert!(!r.is_ready("detached-p1-g1"));
        r.mark_ready("detached-p1-g1");
        assert!(r.is_ready("detached-p1-g1"));
        // A released or destroyed window's successor must announce itself anew.
        r.forget("detached-p1-g1");
        assert!(!r.is_ready("detached-p1-g1"));
        r.mark_ready("detached-p1-g1");
        r.mark_retiring("detached-p1-g1");
        assert!(r.finish("detached-p1-g1"));
        assert!(!r.is_ready("detached-p1-g1"));
    }

    #[test]
    fn a_withdrawn_retire_keeps_the_popout_ready() {
        let mut r = DetachedRetire::default();
        r.mark_ready("detached-p1-g1");
        r.mark_retiring("detached-p1-g1");
        assert!(r.withdraw("detached-p1-g1"));
        assert!(!r.is_retiring("detached-p1-g1"));
        // The kept window can still answer: the next scope-out asks it.
        assert!(r.is_ready("detached-p1-g1"));
        assert!(r.begin("detached-p1-g1").is_some());
    }

    #[test]
    fn only_an_intended_retire_is_kept_out_of_crash_recovery() {
        let mut r = DetachedRetire::default();
        r.begin("detached-p1-g1").unwrap();
        r.mark_retiring("detached-p1-g1");
        assert!(r.is_retiring("detached-p1-g1"));
        assert!(!r.is_pending("detached-p1-g1"));
        // Retiring windows are not asked again by a repeated sync.
        assert_eq!(r.begin("detached-p1-g1"), None);
        // Its Destroyed: a planned close, cleared exactly once.
        assert!(r.finish("detached-p1-g1"));
        assert!(!r.finish("detached-p1-g1"));
        // Any other death (crash, seed timeout) is not a retire.
        assert!(!r.finish("detached-p2-g1"));
    }

    #[test]
    fn closed_wayland_popout_leaves_no_parked_state_for_a_reused_label() {
        let mut parking = DetachedParking::default();
        parking.transition("detached-p1-g1", false);
        parking.forget("detached-p1-g1");
        parking.forget("detached-p1-g1");
        assert!(!parking.is_parked("detached-p1-g1"));
        assert!(!parking.transition("detached-p1-g1", true));
        assert!(parking.transition("detached-p1-g1", false));
    }

    /// The dev desk this feature was written for: two 1920x1080 monitors side by
    /// side, DP-6 at the origin and DP-7 to its right.
    fn two_monitors() -> Vec<MonitorRect> {
        vec![
            MonitorRect {
                x: 0,
                y: 0,
                w: 1920,
                h: 1080,
            },
            MonitorRect {
                x: 1920,
                y: 0,
                w: 1920,
                h: 1080,
            },
        ]
    }

    fn only_primary() -> Vec<MonitorRect> {
        vec![MonitorRect {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
        }]
    }

    fn ws(x: i32, y: i32, w: u32, h: u32) -> WindowState {
        WindowState {
            x,
            y,
            w,
            h,
            maximized: false,
        }
    }

    #[test]
    fn nothing_saved_keeps_the_configured_default() {
        assert_eq!(resolve_startup_geometry(None, &two_monitors()), None);
    }

    #[test]
    fn no_monitors_reported_keeps_the_configured_default() {
        // Rather than trust a rect we cannot validate against anything.
        assert_eq!(
            resolve_startup_geometry(Some(ws(0, 0, 1400, 900)), &[]),
            None
        );
    }

    #[test]
    fn window_on_the_secondary_monitor_is_returned_unchanged() {
        // THE core case: Tabtivity was on DP-7, it must come back on DP-7.
        let saved = ws(2200, 100, 1400, 900);
        assert_eq!(
            resolve_startup_geometry(Some(saved), &two_monitors()),
            Some(saved)
        );
    }

    #[test]
    fn unplugging_the_saved_monitor_falls_back_to_the_default() {
        // Saved on DP-7 (x=2200), which is now gone. The rect overlaps the
        // remaining monitor by nothing at all, so we must NOT place the window
        // there-ish — we hand back None and let the config maximize it.
        let saved = ws(2200, 100, 1400, 900);
        assert_eq!(resolve_startup_geometry(Some(saved), &only_primary()), None);
    }

    #[test]
    fn a_sliver_of_overlap_is_not_enough_to_trust_the_rect() {
        // 20px of the window pokes onto the primary monitor — far too little to
        // grab. Treated the same as the monitor being gone.
        let saved = ws(1900, 100, 1400, 900);
        assert_eq!(resolve_startup_geometry(Some(saved), &only_primary()), None);
    }

    #[test]
    fn a_window_hanging_off_an_edge_is_slid_back_inside() {
        // Mostly on the primary monitor but running past its right edge.
        let saved = ws(1000, 400, 1400, 900);
        let got = resolve_startup_geometry(Some(saved), &only_primary()).unwrap();
        assert_eq!(got.w, 1400, "size is fine, only the origin was wrong");
        assert_eq!(got.h, 900);
        assert_eq!(got.x, 520, "flush against the monitor's right edge");
        assert_eq!(got.y, 180, "flush against its bottom edge");
    }

    #[test]
    fn a_window_larger_than_its_monitor_is_shrunk_to_fit() {
        // e.g. saved on a 4K screen, reopened on a 1080p one.
        let saved = ws(0, 0, 3840, 2160);
        let got = resolve_startup_geometry(Some(saved), &only_primary()).unwrap();
        assert_eq!((got.x, got.y, got.w, got.h), (0, 0, 1920, 1080));
    }

    #[test]
    fn a_maximized_window_still_resolves_its_rect() {
        // The rect is what decides WHICH monitor it re-maximizes on, so it must
        // survive even though the window will immediately be maximized over it.
        let saved = WindowState {
            x: 2200,
            y: 100,
            w: 1400,
            h: 900,
            maximized: true,
        };
        let got = resolve_startup_geometry(Some(saved), &two_monitors()).unwrap();
        assert!(got.maximized);
        assert_eq!(
            got.x, 2200,
            "still on DP-7, so it maximizes there and not on DP-6"
        );
    }

    #[test]
    fn a_degenerate_saved_rect_is_ignored() {
        // A hand-edited or truncated settings.json must not produce a 0-px window.
        assert_eq!(
            resolve_startup_geometry(Some(ws(0, 0, 0, 900)), &only_primary()),
            None
        );
        assert_eq!(
            resolve_startup_geometry(Some(ws(0, 0, 1400, 0)), &only_primary()),
            None
        );
    }

    #[test]
    fn a_tiny_saved_rect_is_discarded_rather_than_grown() {
        // 100x50 is smaller than the grabbable minimum however it is placed, so it
        // fails the visibility check and we fall back to the default. We never
        // invent a geometry the user never had.
        assert_eq!(
            resolve_startup_geometry(Some(ws(10, 10, 100, 50)), &only_primary()),
            None
        );
    }

    #[test]
    fn an_ordinary_rect_well_inside_a_monitor_is_left_alone() {
        let got = resolve_startup_geometry(Some(ws(10, 10, 900, 700)), &only_primary()).unwrap();
        assert_eq!((got.x, got.y, got.w, got.h), (10, 10, 900, 700));
    }

    #[test]
    fn the_monitor_with_the_most_overlap_wins() {
        // Straddling the seam, but mostly on DP-7 → fitted onto DP-7.
        let saved = ws(1800, 100, 1400, 900);
        let got = resolve_startup_geometry(Some(saved), &two_monitors()).unwrap();
        assert_eq!(got.x, 1920, "slid right, flush with DP-7's left edge");
        assert_eq!(got.w, 1400, "not resized — it fits DP-7 fine");
    }

    // ── resolve_detached_geometry (#42 switch-back popout restore) ──────────

    #[test]
    fn detached_popout_on_the_secondary_monitor_is_restored_there() {
        // THE bug: switching back must land the popout on DP-7, not DP-6.
        let saved = ws(2200, 150, 900, 640);
        assert_eq!(
            resolve_detached_geometry(saved, &two_monitors()),
            Some(saved),
        );
    }

    #[test]
    fn detached_empty_monitor_list_reapplies_the_captured_rect() {
        // Mid-session the captured rect was valid moments ago; a transient empty
        // monitor read is no reason to leave the popout WM-misplaced. Unlike the
        // startup resolver, which returns None here.
        let saved = ws(2200, 150, 900, 640);
        assert_eq!(resolve_detached_geometry(saved, &[]), Some(saved));
    }

    #[test]
    fn detached_small_popout_is_not_grown_to_a_minimum() {
        // A borderless popout has no configured minimum size — a deliberately
        // small one must come back the same size, not grown to 800×600 the way
        // the main-window resolver would.
        let saved = ws(300, 300, 420, 320);
        let got = resolve_detached_geometry(saved, &only_primary()).unwrap();
        assert_eq!((got.w, got.h), (420, 320), "kept its small size");
        assert_eq!((got.x, got.y), (300, 300));
    }

    #[test]
    fn detached_popout_on_an_unplugged_monitor_falls_back_to_wm_placement() {
        // The display it lived on is gone → None, so the caller leaves the WM's
        // placement rather than flinging it off-screen.
        let saved = ws(2200, 150, 900, 640);
        assert_eq!(resolve_detached_geometry(saved, &only_primary()), None);
    }

    #[test]
    fn detached_popout_hanging_off_an_edge_is_slid_back_inside() {
        let saved = ws(1600, 800, 900, 640);
        let got = resolve_detached_geometry(saved, &only_primary()).unwrap();
        assert_eq!(got.w, 900, "size fine, only origin was off");
        assert_eq!(got.x, 1020, "flush against the monitor's right edge");
        assert_eq!(got.y, 440, "flush against its bottom edge");
    }

    #[test]
    fn detached_degenerate_rect_is_ignored() {
        assert_eq!(
            resolve_detached_geometry(ws(0, 0, 0, 640), &only_primary()),
            None
        );
        assert_eq!(
            resolve_detached_geometry(ws(0, 0, 900, 0), &only_primary()),
            None
        );
    }

    // ── snap_detached_geometry (#240 fit-to-this-screen) ────────────────────

    /// Undocked: the 2560x1440 external is gone, only the laptop panel is left.
    fn only_laptop() -> Vec<MonitorRect> {
        vec![MonitorRect {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
        }]
    }

    #[test]
    fn snap_shrinks_a_popout_bigger_than_the_screen_it_sits_on() {
        // THE bug: a popout sized on the external monitor keeps that size when
        // the WM drops it onto the laptop panel, hanging off two edges.
        let got = snap_detached_geometry(ws(0, 0, 2400, 1400), &only_laptop()).unwrap();
        assert_eq!((got.w, got.h), (1920, 1080), "clamped to the screen");
        assert_eq!((got.x, got.y), (0, 0));
    }

    #[test]
    fn snap_slides_an_overhanging_popout_fully_into_view() {
        let got = snap_detached_geometry(ws(1600, 800, 900, 640), &only_laptop()).unwrap();
        assert_eq!((got.w, got.h), (900, 640), "it fits — only the origin was off");
        assert_eq!((got.x, got.y), (1020, 440), "flush against right/bottom edges");
    }

    #[test]
    fn snap_rescues_a_popout_left_on_no_monitor_at_all() {
        // Unlike the switch-back resolver, zero overlap is not a reason to give
        // up: this window is live and unreachable, so it lands on the nearest
        // screen instead.
        let got = snap_detached_geometry(ws(2600, 200, 900, 640), &only_laptop()).unwrap();
        assert_eq!((got.x, got.y), (1020, 200), "pulled onto the laptop panel");
        assert_eq!((got.w, got.h), (900, 640));
    }

    #[test]
    fn snap_keeps_a_popout_on_the_secondary_monitor_it_is_already_on() {
        // Two screens still connected: snapping fits it to DP-7, never yanks it
        // to the primary.
        let got = snap_detached_geometry(ws(3200, 900, 900, 640), &two_monitors()).unwrap();
        assert_eq!((got.x, got.y), (2940, 440), "slid inside DP-7, not moved to DP-6");
    }

    #[test]
    fn snap_is_a_no_op_for_a_popout_that_already_fits() {
        // What keeps the monitor watcher from re-applying geometry every poll.
        assert_eq!(
            snap_detached_geometry(ws(200, 150, 900, 640), &two_monitors()),
            None
        );
    }

    #[test]
    fn snap_without_monitors_or_with_a_degenerate_rect_does_nothing() {
        assert_eq!(snap_detached_geometry(ws(0, 0, 900, 640), &[]), None);
        assert_eq!(snap_detached_geometry(ws(0, 0, 0, 640), &only_laptop()), None);
    }
}
