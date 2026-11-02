//! Detached subwindow commands (#42).
//!
//! A tiling subwindow (a tab group) is "popped out" into its own borderless
//! Tauri `WebviewWindow` rendering the same React bundle under a
//! `?detached=<scope>&group=<group>` query. The detached window is registered as
//! a scope-owned `TrackedWindow` (origin `detached_subwindow`) and its resolved
//! native id (X11 window on Linux, HWND on Windows, CGWindowID on macOS) is
//! opted into the workspace
//! backend's parkable override, so the existing `project_runtime::switch`
//! hide/show path parks it when its project goes inactive and re-shows it on
//! switch-back — no parallel parking path.
//!
//! A popout belongs to a tab SCOPE (a project id, `"root"`, or `box:<id>`), and
//! the scope changes in ways no project switch describes — entering a box is one,
//! and the root is a scope a switch's `project_id` cannot name. So the Tauri-level
//! park is expressed once, over scopes ([`sync_detached_visibility`]), driven by
//! the frontend's `setScope` alone.
//!
//! Native Wayland retires instead of parking: an inactive scope's popout is
//! closed (after it settles its unsaved work) and rebuilt from the kept store
//! record when the scope returns — see [`plan_detached_sync`].
//!
//! The MAIN window owns project.json writes; the detached window never persists.

use std::time::{SystemTime, UNIX_EPOCH};
use app_core::sync::LockExt;

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, State, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::commands::apps::{
    DetachedBounds, TrackedWindow, WindowRegistry, WindowRegistryState, ORIGIN_DETACHED_SUBWINDOW,
};
use crate::commands::workspace::WorkspaceStateArc;
#[cfg(target_os = "linux")]
use crate::services::popout_screen::{identity_hash, match_monitor};
use crate::services::popout_screen::{self, Screen, Verdict, View, Why};
use crate::services::window_state::MonitorRect;

/// Stable Tauri window label for a detached group. One window per (project,
/// group); the label is also how `attach_subwindow` finds the window to close.
pub fn detached_label(scope: &str, group_id: &str) -> String {
    format!("detached-{scope}-{group_id}")
}

/// Human-friendly, per-session-unique OS window title for a detached group,
/// e.g. "Tabtivity win-1". This string is load-bearing on X11: the resolver in
/// `platform::x11::find_window_for_title` matches on it exactly to recover the
/// native window id, so it must stay unique among live detached windows.
/// Uniqueness comes from the caller assigning a distinct sequence number per
/// live window (lowest free positive int); see `detach_subwindow`.
pub fn detached_title(seq: u32) -> String {
    format!("{app} win-{seq}", app = crate::brand::DISPLAY)
}

/// The query string the DetachedApp renderer reads to mount a single group.
///
/// Two SEPARATE keys, percent-encoded, rather than the single `scope:group`
/// value this used to write (Group B #224). A scope is not colon-free: a box
/// scope is `box:<id>`, so the renderer's parser — which split on the first
/// colon — read `box:abc:g-3` as scope `"box"`, group `"abc:g-3"`. The host had
/// no record under that scope, never answered the seed, and after 8 s the popout
/// destroyed itself: the group's tabs were gone from the layout with no window
/// to get them back from, their PTYs running hidden, and the record persisted
/// `detached: true` so the failure repeated at every launch. Box-scope detach
/// could therefore never work at all.
pub fn detached_query(scope: &str, group_id: &str) -> String {
    format!(
        "index.html?detached={}&group={}",
        urlencode(scope),
        urlencode(group_id)
    )
}

/// Percent-encode the characters that would end or re-split a query value.
/// Deliberately tiny and local: a scope is an id or a `box:<id>`, a group id is
/// `g-<n>`/`s-<n>`, so this is a guard against the shapes we mint rather than a
/// general URL encoder.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
            _ => {
                let mut buf = [0u8; 4];
                for b in ch.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    out
}

pub fn detached_decorations(os: crate::paths::OsKind) -> bool {
    os == crate::paths::OsKind::Macos
}

/// Reserve the lowest free display number for `label` (the N in "Tabtivity
/// win-N"). Must run under the registry lock so a concurrent detach (or a
/// restart batch respawning several popouts) can't pick the same one.
pub fn reserve_detached_seq(reg: &mut WindowRegistry, label: &str) -> u32 {
    let used: std::collections::HashSet<u32> = reg.detached_seqs.values().copied().collect();
    let n = (1u32..)
        .find(|n| !used.contains(n))
        .expect("a free u32 always exists");
    reg.detached_seqs.insert(label.to_string(), n);
    n
}

/// Drop a detached window's registry footprint: its display number (so the
/// next detach can reuse it — "the second window is always win-1") and its
/// `TrackedWindow`. Returns the native window id (if one was resolved) so the
/// caller can unset the parkable override. Idempotent: a label with no
/// footprint is a no-op returning `None`, which is what makes it safe to call
/// from BOTH `attach_subwindow` and the `WindowEvent::Destroyed` hook — the
/// dock-back path fires it twice.
pub fn release_detached_entry(reg: &mut WindowRegistry, label: &str) -> Option<u64> {
    reg.detached_seqs.remove(label);
    // Drop any captured switch-back geometry too, so a docked/closed label never
    // leaves a stale bounds entry a reused label could later pick up (#42).
    reg.detached_bounds.remove(label);
    reg.detached_minimized.remove(label);
    reg.detached_parking.forget(label);
    // A handshake still in flight has nothing left to retire, and the label's
    // next window must announce its own readiness.
    reg.detached_retire.forget(label);
    reg.detached_screens.release(label);
    reg.windows.remove(label).and_then(|w| w.window_id)
}

/// What one `detach_subwindow` call does for its label, decided under the
/// registry lock so two calls for the same label can't both build.
#[derive(Debug, PartialEq, Eq)]
pub enum DetachPlan {
    /// A window for this label is live or being built: the call is idempotent.
    AlreadyOpen,
    /// The label's previous window is being retired (Wayland scope-out) and
    /// has not died yet — a fast A→B→A. Wait for it, then build.
    WaitForRetire,
    /// This call reserved the label (and the display number) and builds it.
    Build(u32),
}

/// Reserve `label` for a build, or say why not. `live` is whether Tauri holds a
/// window under the label right now (read by the caller).
pub fn plan_detach(reg: &mut WindowRegistry, label: &str, live: bool) -> DetachPlan {
    if reg.detached_retire.is_retiring(label) {
        return DetachPlan::WaitForRetire;
    }
    if live || reg.detached_building.contains(label) || reg.windows.contains_key(label) {
        return DetachPlan::AlreadyOpen;
    }
    reg.detached_building.insert(label.to_string());
    DetachPlan::Build(reserve_detached_seq(reg, label))
}

/// Undo a reservation whose build failed: only what THIS call took — its
/// building flag and display number. Never a live window's entry (the
/// check-then-build race this replaces could untrack a window on screen).
pub fn release_detach_reservation(reg: &mut WindowRegistry, label: &str) {
    if reg.detached_building.remove(label) && !reg.windows.contains_key(label) {
        reg.detached_seqs.remove(label);
    }
}

/// Registry cleanup when a popout's window is destroyed. Returns the native id
/// whose parkable override to drop, and whether the frontend must be told the
/// window died (`detached-window-destroyed` → its tabs dock back, #224).
///
/// An intended Wayland retire is the one death that is NOT reported: its store
/// record stays, and the popout is rebuilt from it when its scope comes back.
/// The size captured at retire time is kept for that rebuild. If the record is
/// dropped instead (docked, hidden or closed from the main window while its
/// scope is away), that path's `attach_subwindow` releases the label and the
/// kept size with it; a record dropped without the backend (crash recovery)
/// leaves one small entry under a label never minted again (group ids only grow).
pub fn on_detached_destroyed(reg: &mut WindowRegistry, label: &str) -> (Option<u64>, bool) {
    if reg.detached_retire.finish(label) {
        let kept = reg.detached_bounds.get(label).copied();
        let kept_id = reg.detached_screens.id(label);
        let wid = release_detached_entry(reg, label);
        if let Some(b) = kept {
            reg.detached_bounds.insert(label.to_string(), b);
            reg.detached_screens.set_id(label, kept_id);
        }
        (wid, false)
    } else {
        (release_detached_entry(reg, label), true)
    }
}

/// PHYSICAL-pixel position to apply to a freshly-built detached window from the
/// optional restore-geometry args, or `None` to let the WM place it.
///
/// The frontend's bounds are PHYSICAL desktop px (the canonical cross-window
/// space — `src/lib/window/coords.ts`), so they MUST be applied via the `Physical`
/// dpi variant. The builder's `.position()` takes LOGICAL px; feeding physical
/// numbers to it multiplied them by the display scale, placing the window
/// off-screen on every scale != 1.0 display — invisible on a scaled Windows
/// display, while harmless on the scale-1.0 Linux dev box (#42).
pub fn detached_position(x: Option<f64>, y: Option<f64>) -> Option<Position> {
    match (x, y) {
        (Some(x), Some(y)) => Some(Position::Physical(PhysicalPosition::new(
            x as i32, y as i32,
        ))),
        _ => None,
    }
}

/// PHYSICAL-pixel size to apply to a freshly-built detached window, or `None`
/// to keep the default size. Same physical-vs-logical rationale as
/// [`detached_position`] (the builder's `.inner_size()` is LOGICAL). Non-positive
/// dimensions are rejected so a stale/zero payload can never yield a 0×0 window.
pub fn detached_size(width: Option<f64>, height: Option<f64>) -> Option<Size> {
    match (width, height) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => {
            Some(Size::Physical(PhysicalSize::new(w as u32, h as u32)))
        }
        _ => None,
    }
}

/// Pop a tab group out into its own borderless OS window bound to `project_id`.
///
/// Resolves the window's native id *before returning* so the
/// registry always carries a `window_id` before the window is usable — an
/// unresolved id would float across projects until resolved (reviewer Finding 7).
/// Returns the registry id the frontend uses to later dock it back.
///
/// MUST be `async`. A synchronous Tauri command runs on the main (UI) thread, and
/// `WebviewWindowBuilder::build()` on Windows blocks waiting for the main-thread
/// event loop to pump WebView2's `create_controller` callback — which the in-flight
/// sync command is itself blocking → deadlock (wry#583 / tauri#4121), surfacing as
/// a blank white popout that never renders. An `async` command is driven off the
/// main thread, so `.build()` can dispatch to and await the (now free) event loop.
/// This body holds no lock guard across an `.await` (it has none), so the future
/// stays `Send`. On Linux/macOS the loop isn't blocked the same way, which is why a
/// sync command worked on the dev box but not on Windows (#42).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn detach_subwindow(
    app: AppHandle,
    workspace: State<'_, WorkspaceStateArc>,
    win_registry: State<'_, WindowRegistryState>,
    project_id: String,
    group_id: String,
    // Optional restore geometry (physical px). When all four are present (a popout
    // re-opened on restart), the window is placed/sized to its prior bounds;
    // otherwise it opens at the default size, WM-placed.
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    // Native Wayland: the screen the saved layout recorded for it at the last
    // quit (`detached_window_screens`), GDK's logical rect. Ignored elsewhere,
    // and once this run has a record of its own.
    monitor: Option<MonitorRect>,
) -> Result<String, String> {
    let label = detached_label(&project_id, &group_id);

    // Reserve the label under the registry lock, or return: a live (or
    // in-flight) window makes the call idempotent — which is what lets the
    // frontend ask for every record of a scope it enters, on every platform —
    // and a window of the same label still being retired (a fast A→B→A on
    // Wayland) is waited out, bounded, before the rebuild.
    //
    // The reservation carries the lowest free display number. It becomes the
    // OS title "Tabtivity win-N" and, on X11, the resolver key — hence it must be
    // unique per live window. It's freed on dock-back/close
    // (`attach_subwindow`) AND on any other destruction via the
    // `WindowEvent::Destroyed` hook in `lib.rs` (the popout self-destroys on
    // seed timeout, last-tab close and the WM-close safety net without ever
    // calling attach), so freed numbers get reused and a lone popout is always
    // "win-1".
    let deadline = std::time::Instant::now() + RETIRE_WAIT;
    let seq = loop {
        let live = app.get_webview_window(&label).is_some();
        let plan = plan_detach(&mut win_registry.lock_ok(), &label, live);
        match plan {
            DetachPlan::AlreadyOpen => return Ok(label),
            DetachPlan::Build(seq) => break seq,
            DetachPlan::WaitForRetire => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!("detached window {label} is still closing"));
                }
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            }
        }
    };
    let title = detached_title(seq);

    // The size the popout had when a Wayland scope-out retired it. There the
    // compositor owns placement, so only the size can come back — and the
    // store's rect is unreliable (a Wayland popout never learns its position, so
    // its bounds stream rarely flushes), which is why the backend's own capture
    // wins on Wayland. Elsewhere it is only the fallback for a caller with none.
    //
    // The first respawn after a restart has no capture yet: it takes the screen
    // and size the saved layout kept from the last quit, so it too comes back on
    // its own screen rather than the pointer's.
    //
    // That respawn's screen is the one this machine kept the last time the
    // popout's placement settled or the user moved it (`popout_screen`), which
    // outranks the saved layout's: the layout only learns it at a clean quit.
    let kept = (!window_positions_readable())
        .then(|| {
            crate::services::popout_screen::load_kept(
                &crate::services::popout_screen::kept_path(),
                &label,
            )
        })
        .flatten();
    let saved = {
        let mut reg = win_registry.lock_ok();
        let mut saved = reg.detached_bounds.get(&label).copied();
        if saved.is_none_or(|b| b.monitor.is_none()) {
            if let Some((from_layout, id)) =
                restart_bounds(window_positions_readable(), width, height, monitor, kept)
            {
                // Record it now: a popout retired before its placement ran
                // (a fast A to B to A) must still have this screen to come back to.
                let merged = DetachedBounds {
                    w: saved.map_or(from_layout.w, |b| b.w),
                    h: saved.map_or(from_layout.h, |b| b.h),
                    ..from_layout
                };
                reg.detached_bounds.insert(label.clone(), merged);
                reg.detached_screens.set_id(&label, id);
                saved = Some(merged);
            }
        }
        saved
    };
    let saved_size = saved.map(|b| (f64::from(b.w), f64::from(b.h)));
    // A Wayland respawn (the scope just came back) must not take the focus
    // the user is typing into in the main window.
    let respawn = saved_size.is_some() && !window_positions_readable();
    // ...and goes back onto the screen it was retired from. It is built hidden
    // so it can be told that screen before GNOME first places it
    // (`present_on_monitor`).
    let respawn_monitor = saved.and_then(|b| b.monitor).filter(|_| respawn);
    let (width, height) = match saved_size {
        Some((w, h)) if !window_positions_readable() || detached_size(width, height).is_none() => {
            (Some(w), Some(h))
        }
        _ => (width, height),
    };

    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(detached_query(&project_id, &group_id).into()),
    )
    .title(&title)
    .decorations(detached_decorations(crate::paths::OsKind::current()))
    // Decision D6: a new-window request never opens an app webview.
    .on_new_window(crate::app_new_window(app.clone()))
    // Built mid-talk: hidden from capture before its renderer can raise its
    // own privacy curtain (docs/privacy_curtain_plan.md).
    .content_protected(crate::commands::presenter::protect_new_window(&app));
    // Windows: a freshly runtime-created WebView2 window commonly presents a blank
    // WHITE surface until it is shown/focused or genuinely resized — and the rapid
    // +1/-1px resize nudge that fixes the analogous BLACK WebKitGTK surface tends
    // to coalesce without a repaint here. Build it HIDDEN and reveal it once the
    // webview has initialized (the deferred thread below): toggling visibility
    // forces WebView2's first composite. Linux keeps building visible so the X11
    // title-based id resolver can find the mapped window.
    #[cfg(target_os = "windows")]
    {
        builder = builder.visible(false);
    }
    // Default LOGICAL size only. Any caller-supplied geometry is PHYSICAL px
    // (frontend canonical space, `src/lib/window/coords.ts`) and is applied AFTER build
    // via the physical setters below — routing it through the builder's LOGICAL
    // `.position()`/`.inner_size()` placed/sized the window wrong on every
    // scale != 1.0 display, which is why detach worked on the scale-1.0 Linux dev
    // box but spawned an invisible, off-screen window on scaled Windows (#42).
    builder = builder.inner_size(900.0, 640.0);
    if respawn {
        builder = builder.focused(false);
    }
    if respawn_monitor.is_some() {
        builder = builder.visible(false);
    }
    let win = match builder.build() {
        Ok(win) => win,
        Err(e) => {
            // Release THIS call's reservation so a rare failed build doesn't
            // permanently skip a slot — and nothing a live window owns.
            release_detach_reservation(&mut win_registry.lock_ok(), &label);
            return Err(format!("build detached window: {e}"));
        }
    };

    // Apply restore geometry in PHYSICAL px. Missing/zero bounds keep the logical
    // default size and let the WM place the window. Size before position so a
    // resize can't shift the placement. Best-effort: a failed setter still leaves
    // a usable (default-placed) window rather than aborting the detach.
    //
    // Group B #236: the saved rect is VALIDATED against the monitors connected
    // right now, exactly as the project-switch-back path already does
    // (`show_detached_windows`). Only that path ran the resolver, so a
    // popout whose display had been unplugged (or the arrangement rearranged)
    // between sessions respawned at coordinates on a screen that no longer
    // exists — a borderless window, off-screen, with nothing to grab. When the
    // rect no longer meaningfully overlaps any monitor the resolver answers
    // `None` and we leave the WM's own placement, which is on a real screen.
    let fitted = fit_detached_bounds(&win, x, y, width, height);
    if let Some(size) = fitted.1 {
        let _ = win.set_size(size);
    }
    if let Some(pos) = fitted.0 {
        let _ = win.set_position(pos);
    }

    // Resolve the native window id so the switch path can park this popout. On
    // X11 we match the unique title (bypasses the protected filter); on Windows
    // and macOS we read the HWND / NSWindow number straight off the Tauri
    // window by its label.
    let window_id = resolve_detached_window_id(&app, &label, &title);

    if let Some(wid) = window_id {
        // Opt the detached window into the parkable override so the switch path
        // can actually park it despite its `tabtivity` WM_CLASS. The MAIN window id
        // can never enter this set (structural guard in the backend).
        workspace.lock_ok().backend.set_parkable(wid);
    }

    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let scope = project_id.clone();
    let win = TrackedWindow {
        id: label.clone(),
        exec: concat!(crate::app_slug!(), "-detached").to_string(),
        file: None,
        pid: std::process::id(),
        project_id: Some(project_id),
        role: Some(group_id),
        opened_at,
        window_id,
        origin: ORIGIN_DETACHED_SUBWINDOW.to_string(),
        launch_id: None,
    };
    // Register and drop the reservation in ONE critical section, so no other
    // call ever sees this label as neither building nor registered.
    let retire_now = {
        let mut reg = win_registry.lock_ok();
        reg.windows.insert(label.clone(), win);
        reg.detached_building.remove(&label);
        // Nothing GDK says of it counts until it has been placed and settled.
        reg.detached_screens.built(&label, std::time::Instant::now());
        // Wayland: the scope this popout belongs to was left while it was
        // being built (a respawn racing the next switch). No sync will look at
        // it again, so retire it here; it is brand new, so there is no unsaved
        // work to ask about.
        let out = !window_positions_readable()
            && reg
                .detached_active_scope
                .as_deref()
                .is_some_and(|active| active != scope);
        if out {
            reg.detached_retire.mark_retiring(&label);
        }
        out
    };
    if retire_now {
        close_retiring_window(&app, &label);
        return Ok(label);
    }

    match respawn_monitor {
        Some(monitor) => present_on_monitor(&app, &label, monitor, fitted.1),
        None => spawn_first_paint_nudge(app, label.clone()),
    }

    Ok(label)
}

/// The Wayland record a restart respawns from, when this run has no capture of
/// its own, with the identity of its screen (0 = unknown). The screen is the
/// one the kept file holds (written when a placement settled or the user moved
/// the popout, so it survives a signal or a crash), else the saved layout's.
/// The size is the layout's when real, else the kept file's. Nothing where
/// positions are readable (the saved rect places it) or without a screen and a
/// real size.
fn restart_bounds(
    positions_readable: bool,
    width: Option<f64>,
    height: Option<f64>,
    monitor: Option<MonitorRect>,
    kept: Option<crate::services::popout_screen::KeptScreen>,
) -> Option<(DetachedBounds, u64)> {
    if positions_readable {
        return None;
    }
    let (monitor, id) = match kept.and_then(|k| k.screen()) {
        Some(s) => (s.rect, s.id),
        None => (monitor?, 0),
    };
    let real = |w: f64, h: f64| w >= 1.0 && h >= 1.0 && w.is_finite() && h.is_finite();
    let (w, h) = match (width, height) {
        (Some(w), Some(h)) if real(w, h) => (w as u32, h as u32),
        _ => kept
            .filter(|k| k.width >= 1 && k.height >= 1)
            .map(|k| (k.width, k.height))?,
    };
    if monitor.w == 0 || monitor.h == 0 {
        return None;
    }
    Some((DetachedBounds { x: 0, y: 0, w, h, monitor: Some(monitor) }, id))
}

/// Force a fresh popout's first paint shortly after creation, deferred on a
/// thread so the webview has mounted. The window stays mapped throughout, so
/// the X11 id `detach_subwindow` resolved remains valid.
///
/// - Linux/WebKitGTK: a freshly-created second webview presents an unpainted
///   (BLACK) GL surface until a real OS-level size change forces the compositor
///   to allocate and paint it — the main window only avoids this because its
///   startup fullscreen transition is itself such a resize. The borderless
///   detached window gets no such resize, so nudge its size by 1px and back.
/// - Windows/WebView2: the same window instead presents a blank WHITE surface
///   and the resize nudge is unreliable (rapid +1/-1 resizes coalesce without a
///   repaint). The window was built HIDDEN; show()+set_focus() here
///   toggles WebView2's visibility, which forces the first composite. The resize
///   nudge is kept as a belt-and-suspenders kick.
fn spawn_first_paint_nudge(app: AppHandle, label: String) {
    let (nudge_app, nudge_label) = (app, label);
    std::thread::spawn(move || {
        // Marshal every window op onto the main (UI) thread. Tauri window methods
        // are `Send` so they compile from a worker thread, but on Windows calling
        // show()/set_focus()/set_size() off the thread that owns the HWND is
        // unreliable — it can no-op the repaint or deadlock against the event loop
        // — so dispatch through `run_on_main_thread`.
        let kick = |app: AppHandle, label: String, reveal: bool| {
            let app_main = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(w) = app_main.get_webview_window(&label) {
                    #[cfg(target_os = "windows")]
                    if reveal {
                        // Built hidden on Windows; toggling visibility forces
                        // WebView2's first composite (a fresh runtime-created
                        // window otherwise shows a blank white surface until it is
                        // shown/focused).
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    if let Ok(sz) = w.inner_size() {
                        // A real ±1px size change forces the compositor to allocate
                        // and paint the surface (WebKitGTK's second webview is an
                        // unpainted BLACK GL surface until a genuine OS resize).
                        let delta: i32 = if reveal { 1 } else { -1 };
                        let next = (sz.width as i32 + delta).max(1) as u32;
                        let _ = w.set_size(PhysicalSize::new(next, sz.height));
                    }
                }
            });
        };
        std::thread::sleep(std::time::Duration::from_millis(250));
        kick(nudge_app.clone(), nudge_label.clone(), true);
        // A short gap so the grow then restore aren't coalesced into a no-op.
        std::thread::sleep(std::time::Duration::from_millis(50));
        kick(nudge_app, nudge_label, false);
    });
}

/// The logical rect GDK gives a monitor: how a popout's screen is remembered
/// across a Wayland retire and found again on the respawn.
#[cfg(target_os = "linux")]
fn gdk_monitor_rect(m: &gtk::gdk::Monitor) -> MonitorRect {
    use gtk::gdk::prelude::MonitorExt;
    let g = m.geometry();
    MonitorRect {
        x: g.x(),
        y: g.y(),
        w: g.width().max(0) as u32,
        h: g.height().max(0) as u32,
    }
}

/// A monitor with its identity: the rect plus a hash of its make and model,
/// which survive a resolution, scale or arrangement change that the rect does not.
#[cfg(target_os = "linux")]
fn gdk_screen(m: &gtk::gdk::Monitor) -> Screen {
    use gtk::gdk::prelude::MonitorExt;
    Screen {
        rect: gdk_monitor_rect(m),
        id: identity_hash(m.manufacturer().as_deref(), m.model().as_deref()),
    }
}

/// Every connected monitor, in GDK's order. Main thread (GTK).
#[cfg(target_os = "linux")]
fn live_screens(d: &gtk::gdk::Display) -> Vec<Screen> {
    (0..d.n_monitors())
        .filter_map(|i| d.monitor(i))
        .map(|m| gdk_screen(&m))
        .collect()
}

/// The index into GDK's monitors of the screen a popout's record names — by
/// make and model first, so a resolution or scale change does not lose it to
/// the main window's screen ([`match_monitor`]). Main thread (GTK).
#[cfg(target_os = "linux")]
fn target_monitor_index(
    d: &gtk::gdk::Display,
    app: &AppHandle,
    label: &str,
    rect: MonitorRect,
) -> Option<i32> {
    let id = app.state::<WindowRegistryState>().lock_ok().detached_screens.id(label);
    match_monitor(&Screen { rect, id }, &live_screens(d)).map(|i| i as i32)
}

/// One look at a popout, for [`popout_screen::PopoutScreens::observe`]: is it
/// shown and fullscreen, which monitor GDK says its surface is on, and its size.
/// A window that is not mapped reads as not shown, and GDK's answer for one
/// that entered no output (the origin monitor) is never trusted on its own: the
/// observation also needs the window to have settled. Main thread (GTK).
#[cfg(target_os = "linux")]
fn sample_popout(win: &tauri::WebviewWindow) -> View {
    use gtk::prelude::*;
    let blind = View { shown: false, fullscreen: false, seen: None, twins: false, size: None };
    let Some(gdk_win) = win.gtk_window().ok().and_then(|w| w.window()) else {
        return blind;
    };
    let d = gdk_win.display();
    let seen = d.monitor_at_window(&gdk_win).map(|m| gdk_screen(&m));
    let twins = seen.is_some_and(|s| s.id != 0 && live_screens(&d).iter().filter(|m| m.id == s.id).count() > 1);
    View {
        shown: win.is_visible().unwrap_or(false) && gdk_win.is_viewable(),
        fullscreen: gdk_win.state().contains(gtk::gdk::WindowState::FULLSCREEN),
        seen,
        twins,
        size: win.inner_size().ok().map(|s| (s.width, s.height)),
    }
}

#[cfg(not(target_os = "linux"))]
fn sample_popout(_win: &tauri::WebviewWindow) -> View {
    View { shown: false, fullscreen: false, seen: None, twins: false, size: None }
}

/// The screen GDK says `win` is on. On Wayland that is the output its surface
/// last entered — the one thing a client there knows about where it is — or,
/// for a surface that entered none, a geometric guess (the origin monitor).
/// A raw reading, good for "which screen is the main window on"; a popout's
/// RECORD never comes from it, only from [`record_popout`].
/// Main thread (GTK).
#[cfg(target_os = "linux")]
fn gdk_monitor_of(win: &tauri::WebviewWindow) -> Option<MonitorRect> {
    use gtk::prelude::*;
    let gdk_win = win.gtk_window().ok()?.window()?;
    gdk_win
        .display()
        .monitor_at_window(&gdk_win)
        .map(|m| gdk_monitor_rect(&m))
}

#[cfg(not(target_os = "linux"))]
fn gdk_monitor_of(_win: &tauri::WebviewWindow) -> Option<MonitorRect> {
    None
}

/// Where a [`present_on_monitor`] popout is in its fullscreen round trip.
#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MonitorHop {
    /// Asked to go fullscreen on its screen; the compositor has not shown it
    /// there yet.
    Entering,
    /// Fullscreen there, asked to leave it again.
    Leaving,
    /// Out of fullscreen: waiting for GDK's answer to catch up with where the
    /// compositor put the window, to check it landed ([`MONITOR_HOP_SETTLE`]).
    Settling,
    /// A normal window (or given up on): nothing more to do.
    Done,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, PartialEq, Eq)]
enum HopAction {
    Nothing,
    Unfullscreen,
    RestoreSize,
    /// It landed on the wrong screen (or something else took it out of
    /// fullscreen first): ask for the fullscreen on its screen once more. A
    /// window that is already shown is moved by it all the same.
    Refullscreen,
    /// Past [`MONITOR_HOP_TIMEOUT`]: leave fullscreen wherever it is and take
    /// the size back, rather than stay a fullscreen window.
    GiveUp,
}

/// What the client can see of its window at one look during the round trip.
#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug)]
struct HopView {
    /// GTK's FULLSCREEN state.
    fullscreen: bool,
    /// It was fullscreen during this attempt and is not any more.
    lost_fullscreen: bool,
    /// GDK's monitor index for the surface (`monitor_at_window`).
    answer: Option<usize>,
    /// What GDK would answer had the surface entered no output
    /// ([`gdk_fallback_monitor`]); `None` once the surface is known to have
    /// entered one (a retry), when the answer is never that guess.
    guess: Option<usize>,
    /// Since this attempt asked for the fullscreen.
    elapsed: std::time::Duration,
    /// Since the window left fullscreen; only read while settling.
    settled: std::time::Duration,
    /// The window is on screen (not hidden by something else meanwhile).
    mapped: bool,
    /// Another attempt is still allowed ([`MONITOR_HOP_RETRIES`]).
    retry_left: bool,
}

/// The whole round-trip decision for one look, from a window-state report or
/// the poll: the shown proof ([`entered_target`], else the unproven delay),
/// the step, the check that it landed, and the give-up past the timeout. Pure;
/// the compositor model in the tests drives it the way `present_on_monitor`
/// does.
#[cfg(any(target_os = "linux", test))]
fn hop_tick(hop: MonitorHop, view: HopView, target: usize) -> (MonitorHop, HopAction) {
    match hop {
        MonitorHop::Done => (hop, HopAction::Nothing),
        MonitorHop::Settling => {
            if view.settled < MONITOR_HOP_SETTLE {
                return (hop, HopAction::Nothing);
            }
            // After the settle GDK's answer is where the compositor has the
            // window (probed on Mutter 50.1: it matched the real position both
            // after a wrong landing and a right one).
            match view.answer {
                Some(i) if i != target && view.retry_left && view.mapped => {
                    (MonitorHop::Entering, HopAction::Refullscreen)
                }
                _ => (MonitorHop::Done, HopAction::Nothing),
            }
        }
        MonitorHop::Entering | MonitorHop::Leaving => {
            if view.elapsed >= MONITOR_HOP_TIMEOUT {
                return (MonitorHop::Done, HopAction::GiveUp);
            }
            // Something else (the compositor refusing, the page's own
            // stray-fullscreen guard) took it out of fullscreen before we did:
            // it is out wherever that left it, so check where.
            if hop == MonitorHop::Entering && view.lost_fullscreen {
                return (MonitorHop::Settling, HopAction::RestoreSize);
            }
            let shown = hop == MonitorHop::Entering
                && view.fullscreen
                && entered_target(view.answer, view.guess, target)
                    .unwrap_or(view.elapsed >= MONITOR_HOP_UNPROVEN_DELAY);
            monitor_hop_step(hop, view.fullscreen, shown)
        }
    }
}

/// One look at the round trip: GTK's fullscreen state and whether the
/// compositor has shown the window on its screen yet. Pure, so the order the
/// reports arrive in is unit-tested without a compositor.
///
/// It leaves fullscreen only once SHOWN. GTK reports fullscreen from the first
/// configure, before the compositor has acted on the request, and Mutter
/// places a window that leaves fullscreen before that on the pointer's screen
/// — the main window's, right after the switch. That is how every respawn came
/// back beside the main window. Probed on Mutter 50.1 (a private headless
/// session, two screens, the pointer on the other one): leaving at the first
/// report, or within ~15 ms of the show, lands on the pointer's screen; from
/// ~20 ms on, on the fullscreen's; the surface's `wl_surface.enter` (what GDK
/// answers from) follows at ~25 ms.
#[cfg(any(target_os = "linux", test))]
fn monitor_hop_step(hop: MonitorHop, fullscreen: bool, shown: bool) -> (MonitorHop, HopAction) {
    match (hop, fullscreen) {
        (MonitorHop::Entering, true) if shown => (MonitorHop::Leaving, HopAction::Unfullscreen),
        (MonitorHop::Leaving, false) => (MonitorHop::Settling, HopAction::RestoreSize),
        (hop, _) => (hop, HopAction::Nothing),
    }
}

/// Which monitor GDK answers for a toplevel that has entered no output yet:
/// `gdk_display_get_monitor_at_window`'s geometric fallback, which on Wayland
/// sees every toplevel at (0,0) — the largest overlap of `(0,0,w,h)`, first
/// one on a tie, else the one holding its centre. `None`: no monitor matches.
#[cfg(any(target_os = "linux", test))]
fn gdk_fallback_monitor(w: i32, h: i32, monitors: &[MonitorRect]) -> Option<usize> {
    let overlap = |m: &MonitorRect| {
        let iw = (m.x + m.w as i32).min(w) - m.x.max(0);
        let ih = (m.y + m.h as i32).min(h) - m.y.max(0);
        i64::from(iw.max(0)) * i64::from(ih.max(0))
    };
    let mut best: Option<(usize, i64)> = None;
    for (i, m) in monitors.iter().enumerate() {
        let area = overlap(m);
        if area > best.map_or(0, |(_, a)| a) {
            best = Some((i, area));
        }
    }
    best.map(|(i, _)| i).or_else(|| {
        let (cx, cy) = (w / 2, h / 2);
        monitors.iter().position(|m| {
            cx >= m.x && cy >= m.y && cx < m.x + m.w as i32 && cy < m.y + m.h as i32
        })
    })
}

/// Whether GDK's monitor for a surface proves the compositor has shown it on
/// `target`: Mutter sends a surface `wl_surface.enter` only once its actor is
/// on that output, and GDK's answer is that output from then on. `None` when
/// the answer can't tell — `target` is also what GDK guesses for a surface
/// that entered nothing.
#[cfg(any(target_os = "linux", test))]
fn entered_target(answer: Option<usize>, fallback: Option<usize>, target: usize) -> Option<bool> {
    match answer {
        Some(i) if i == target && fallback == Some(target) => None,
        Some(i) => Some(i == target),
        None => Some(false),
    }
}

/// How long one attempt may take before the popout is simply dropped out of
/// fullscreen and resized (a compositor that never confirms the fullscreen, or
/// never shows it). Generous: the respawn runs during a project switch.
#[cfg(any(target_os = "linux", test))]
const MONITOR_HOP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// When [`entered_target`] can't tell, how long after the fullscreen the
/// window counts as shown. Mutter shows a window within a frame or two of its
/// first buffer (~20 ms probed); this leaves room for a loaded switch, and a
/// premature leave is caught by the landing check anyway.
#[cfg(any(target_os = "linux", test))]
const MONITOR_HOP_UNPROVEN_DELAY: std::time::Duration = std::time::Duration::from_millis(700);

/// How long after leaving fullscreen GDK's answer is taken as where the window
/// landed (its `enter`/`leave` follow the move within a frame or two).
#[cfg(any(target_os = "linux", test))]
const MONITOR_HOP_SETTLE: std::time::Duration = std::time::Duration::from_millis(300);

/// Further attempts after a wrong landing. A second round trip works on the
/// then-shown window (probed: it moves it onto the named screen and back), so
/// one is enough to undo a stray early unfullscreen; more would only flash.
#[cfg(any(target_os = "linux", test))]
const MONITOR_HOP_RETRIES: u32 = 1;

/// How often the round trip looks for the shown proof (GTK raises no signal
/// for an output enter that doesn't change the scale).
#[cfg(target_os = "linux")]
const MONITOR_HOP_POLL: std::time::Duration = std::time::Duration::from_millis(40);

/// Show a hidden Wayland respawn on the screen it was retired from, at `size`.
///
/// A Wayland client cannot place its window, and GNOME puts every new one on
/// the screen under the pointer — the main window's, right after the project
/// switch that brought the popout back. The one output a client may name is
/// the one it wants to be fullscreen ON (`gtk_window_fullscreen_on_monitor`,
/// as the presenter does). Mutter places a window that was fullscreen from its
/// first frame only when it leaves fullscreen, and places it then on the
/// screen it is on (`meta_window_unmake_fullscreen` → `meta_window_place`,
/// once no longer "showing for the first time"). So the popout is shown
/// fullscreen on its screen, dropped out of fullscreen once the compositor has
/// shown it there ([`monitor_hop_step`]), then given its size back. That round
/// trip is a real OS resize, which is also what paints WebKitGTK's first
/// frame, so no nudge. A screen that is gone → the main window's screen, the
/// size capped to it; no screen to name at all → a plain show wherever the
/// compositor puts it.
///
/// Probed against a real Mutter 50.1 (a private headless GNOME Shell, two
/// 1280x720 screens, GTK 3.24 and WebKitGTK 2.52 clients; the window's real
/// screen read off a compositor screenshot): this round trip lands the window
/// on the named screen, with the pointer on either screen, for a rebuilt
/// window and for a hidden-then-reshown one, as long as it leaves fullscreen
/// after the compositor has acted on the request (see [`monitor_hop_step`]).
/// GDK's `monitor_at_window` matched the real screen every time once the
/// window had settled, so the hop checks its landing with it and, if the
/// window came out on another screen (something took it out of fullscreen
/// early), goes round once more ([`MONITOR_HOP_RETRIES`]). Every decision is
/// traced to stderr as `popout-place #n +ms: …` so a live run shows which
/// link broke.
///
/// Every end of the placement is in the poll below: the window gone, the
/// round trip [`MonitorHop::Done`] (landed, hidden meanwhile, no retry left,
/// or [`HopAction::GiveUp`] at the timeout); the early returns here (no
/// window, no screen to name) never start one.
#[cfg(target_os = "linux")]
fn present_on_monitor(app: &AppHandle, label: &str, monitor: MonitorRect, size: Option<Size>) {
    static PLACEMENTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    // A run counter, not the label: the label carries the project id.
    let id = PLACEMENTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let on_main = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        use gtk::prelude::*;
        let t0 = std::time::Instant::now();
        let say = move |msg: String| {
            eprintln!("popout-place #{id} +{}ms: {msg}", t0.elapsed().as_millis());
        };
        let Some(win) = on_main.get_webview_window(&label) else {
            say("window gone before the placement started".to_string());
            return;
        };
        mark_placing(&on_main, &label, true);
        // The screen it was retired from, or — that display unplugged since —
        // the main window's, so it comes back as its own window beside the main
        // one rather than on whatever screen the pointer is on.
        let main = on_main.get_webview_window(crate::services::window_service::MAIN_WINDOW_LABEL);
        let index = gtk::gdk::Display::default().and_then(|d| {
            let index_of = |rect: MonitorRect| {
                (0..d.n_monitors())
                    .find(|&i| d.monitor(i).is_some_and(|m| gdk_monitor_rect(&m) == rect))
            };
            match target_monitor_index(&d, &on_main, &label, monitor) {
                Some(i) => Some((i, None)),
                None => main
                    .as_ref()
                    .and_then(gdk_monitor_of)
                    .and_then(|rect| index_of(rect).map(|i| (i, Some(rect)))),
            }
        });
        let (Some((index, fallback)), Ok(gtk_win), Some(screen)) =
            (index, win.gtk_window(), gtk::gdk::Screen::default())
        else {
            say("no screen to name (the saved one and the main window's are both unknown to GDK): plain show".to_string());
            mark_placing(&on_main, &label, false);
            let _ = win.show();
            spawn_first_paint_nudge(on_main.clone(), label);
            return;
        };
        {
            let d = gtk::gdk::Display::default();
            let target_size = d.as_ref().and_then(|d| d.monitor(index)).map(|m| gdk_monitor_rect(&m));
            say(format!(
                "start target={index}/{} ({}x{}) saved screen {} size={:?}",
                d.as_ref().map_or(0, |d| d.n_monitors()),
                target_size.map_or(0, |r| r.w),
                target_size.map_or(0, |r| r.h),
                if fallback.is_some() { "gone, main window's used" } else { "found" },
                size,
            ));
        }
        // Sized on the screen that is gone: no larger than the one it lands on.
        let size = match (size, fallback) {
            (Some(size), Some(rect)) => {
                let scale = win.scale_factor().unwrap_or(1.0);
                Some(fit_size_to(size, rect, scale))
            }
            (size, _) => size,
        };
        let restore = {
            let win = win.clone();
            move || {
                if let Some(size) = size {
                    let _ = win.set_size(size);
                }
            }
        };
        use std::cell::Cell;
        /// The round trip's own state, shared by the state reports and the poll.
        struct Run {
            hop: Cell<MonitorHop>,
            /// 0 for the first attempt, then one per [`HopAction::Refullscreen`].
            attempt: Cell<u32>,
            /// When this attempt asked for the fullscreen.
            started: Cell<std::time::Instant>,
            /// When the window left fullscreen (set while settling).
            left_at: Cell<Option<std::time::Instant>>,
            /// GTK has reported fullscreen during this attempt.
            was_fullscreen: Cell<bool>,
            /// The last look that was traced (a look that changes nothing isn't).
            traced: Cell<Option<(MonitorHop, bool, Option<usize>)>>,
        }
        let run = std::rc::Rc::new(Run {
            hop: Cell::new(MonitorHop::Entering),
            attempt: Cell::new(0),
            started: Cell::new(std::time::Instant::now()),
            left_at: Cell::new(None),
            was_fullscreen: Cell::new(false),
            traced: Cell::new(None),
        });
        // One look at the round trip ([`hop_tick`]), from a window-state report
        // (its new state) or the poll (the window's current one).
        let step = std::rc::Rc::new({
            let (run, gtk_win, screen) = (run.clone(), gtk_win.clone(), screen.clone());
            move |reported: Option<bool>| {
                let hop = run.hop.get();
                if hop == MonitorHop::Done {
                    return;
                }
                let now = std::time::Instant::now();
                let gdk_win = gtk_win.window();
                let fullscreen = reported.unwrap_or_else(|| {
                    gdk_win
                        .as_ref()
                        .is_some_and(|w| w.state().contains(gtk::gdk::WindowState::FULLSCREEN))
                });
                let (answer, guess) = gdk_win.map_or((None, None), |gdk_win| {
                    let d = gdk_win.display();
                    let monitors: Vec<_> = (0..d.n_monitors()).map(|i| d.monitor(i)).collect();
                    let answer = d
                        .monitor_at_window(&gdk_win)
                        .and_then(|m| monitors.iter().position(|o| o.as_ref() == Some(&m)));
                    let none = MonitorRect { x: 0, y: 0, w: 0, h: 0 };
                    let rects: Vec<MonitorRect> =
                        monitors.iter().map(|m| m.as_ref().map_or(none, gdk_monitor_rect)).collect();
                    (answer, gdk_fallback_monitor(gdk_win.width(), gdk_win.height(), &rects))
                });
                // A retry works on a window that has entered an output already:
                // GDK's answer is then never its no-output guess.
                let guess = guess.filter(|_| run.attempt.get() == 0);
                if fullscreen {
                    run.was_fullscreen.set(true);
                }
                let view = HopView {
                    fullscreen,
                    lost_fullscreen: run.was_fullscreen.get() && !fullscreen,
                    answer,
                    guess,
                    elapsed: now.duration_since(run.started.get()),
                    settled: run.left_at.get().map_or(std::time::Duration::ZERO, |t| now.duration_since(t)),
                    mapped: gtk_win.is_mapped(),
                    retry_left: run.attempt.get() < MONITOR_HOP_RETRIES,
                };
                // One line per change of what is seen, never one per poll.
                let seen = (hop, fullscreen, answer);
                if run.traced.get() != Some(seen) {
                    run.traced.set(Some(seen));
                    say(format!(
                        "{hop:?}: fullscreen={fullscreen} gdk={answer:?} (unentered guess {guess:?}, \
                         target {index})"
                    ));
                }
                let (next, action) = hop_tick(hop, view, index as usize);
                run.hop.set(next);
                if next == MonitorHop::Settling && hop != MonitorHop::Settling {
                    run.left_at.set(Some(now));
                }
                match action {
                    HopAction::Unfullscreen => {
                        let proof = match entered_target(answer, guess, index as usize) {
                            Some(true) => "the surface entered the target",
                            _ => "the screen can't be told from GDK's guess; delay elapsed",
                        };
                        say(format!("leaving fullscreen: {proof}"));
                        gtk_win.unfullscreen();
                    }
                    HopAction::RestoreSize => {
                        if hop == MonitorHop::Entering {
                            say("something else left fullscreen before we did; checking where it landed".to_string());
                        }
                        say("out of fullscreen: restoring the size".to_string());
                        restore();
                    }
                    HopAction::Refullscreen => {
                        run.attempt.set(run.attempt.get() + 1);
                        run.started.set(now);
                        run.left_at.set(None);
                        run.was_fullscreen.set(false);
                        say(format!(
                            "landed on screen {answer:?}, wanted {index}: fullscreen on it again \
                             (attempt {})",
                            run.attempt.get() + 1
                        ));
                        gtk_win.fullscreen_on_monitor(&screen, index);
                    }
                    HopAction::GiveUp => {
                        say(format!(
                            "gave up after {} ms: fullscreen={fullscreen} gdk={answer:?}; leaving \
                             fullscreen where it is",
                            view.elapsed.as_millis()
                        ));
                        gtk_win.unfullscreen();
                        restore();
                    }
                    HopAction::Nothing => {
                        if hop == MonitorHop::Settling && next == MonitorHop::Done {
                            let verdict = if answer == Some(index as usize) {
                                "landed on its screen"
                            } else if !view.mapped {
                                "hidden meanwhile, not checked"
                            } else {
                                "still on another screen, no retry left"
                            };
                            say(format!("settled: gdk={answer:?} target={index}: {verdict}"));
                        }
                    }
                }
            }
        });
        let on_event = step.clone();
        gtk_win.connect_window_state_event(move |_, ev| {
            on_event(Some(ev.new_window_state().contains(gtk::gdk::WindowState::FULLSCREEN)));
            gtk::glib::Propagation::Proceed
        });
        run.started.set(std::time::Instant::now());
        gtk_win.fullscreen_on_monitor(&screen, index);
        let _ = win.show();
        say("fullscreen requested, shown".to_string());

        // GTK raises nothing when the surface enters its output, so look again
        // until the round trip is over (or given up on, or the window is gone).
        let (gone_app, gone_label) = (on_main.clone(), label.clone());
        gtk::glib::timeout_add_local(MONITOR_HOP_POLL, move || {
            if gone_app.get_webview_window(&gone_label).is_none() {
                say("window gone: placement stopped".to_string());
                run.hop.set(MonitorHop::Done);
                mark_placing(&gone_app, &gone_label, false);
                return gtk::glib::ControlFlow::Break;
            }
            step(None);
            if run.hop.get() == MonitorHop::Done {
                // Only here: restoring the size comes before the landing check
                // and any retry, and the window is still moving until then.
                mark_placing(&gone_app, &gone_label, false);
                gtk::glib::ControlFlow::Break
            } else {
                gtk::glib::ControlFlow::Continue
            }
        });
    });
}

/// `size` capped to `monitor` (GDK's logical rect, `scale` to physical px).
#[cfg(any(target_os = "linux", test))]
fn fit_size_to(size: Size, monitor: MonitorRect, scale: f64) -> Size {
    let cap = |logical: u32| (f64::from(logical) * scale).round() as u32;
    match size {
        Size::Physical(p) => Size::Physical(PhysicalSize::new(
            p.width.min(cap(monitor.w)),
            p.height.min(cap(monitor.h)),
        )),
        Size::Logical(l) => Size::Logical(tauri::LogicalSize::new(
            l.width.min(f64::from(monitor.w)),
            l.height.min(f64::from(monitor.h)),
        )),
    }
}

#[cfg(not(target_os = "linux"))]
fn present_on_monitor(app: &AppHandle, label: &str, _monitor: MonitorRect, _size: Option<Size>) {
    spawn_first_paint_nudge(app.clone(), label.to_string());
}

/// The position/size to actually apply to a respawning popout: the caller's
/// saved rect, fitted to the monitors this window can currently see (#236).
///
/// A rect with no complete position+size pair is passed through unchanged (the
/// WM places it, at the default size); a complete one that no longer overlaps
/// any monitor yields `(None, None)`, i.e. the WM's placement rather than a
/// window flung off-screen. Live monitors are read from the freshly-built
/// window, so this can only run after `build()`.
fn fit_detached_bounds(
    win: &tauri::WebviewWindow,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> (Option<Position>, Option<Size>) {
    if !window_positions_readable() {
        return wayland_detached_fit(width, height);
    }
    let (pos, size) = (detached_position(x, y), detached_size(width, height));
    let (Some(_), Some(_)) = (&pos, &size) else {
        // A partial rect was never a restore — nothing to validate.
        return (pos, size);
    };
    let saved = crate::schema::settings::WindowState {
        x: x.unwrap_or_default() as i32,
        y: y.unwrap_or_default() as i32,
        w: width.unwrap_or_default() as u32,
        h: height.unwrap_or_default() as u32,
        maximized: false,
    };
    let monitors = crate::services::window_service::monitor_rects(win);
    // The screen it was on is gone: onto the main window's screen, as its own
    // window still — never docked, never wherever the WM drops new windows.
    let g = crate::services::window_state::resolve_detached_geometry(saved, &monitors)
        .or_else(|| onto_main_screen(win.app_handle(), saved.w, saved.h));
    match g {
        Some(g) => (
            Some(Position::Physical(PhysicalPosition::new(g.x, g.y))),
            Some(Size::Physical(PhysicalSize::new(g.w, g.h))),
        ),
        None => (None, None),
    }
}

/// What a native-Wayland respawn applies of its saved rect: the size, as it
/// was, and no position. There the saved x/y are (0,0) filler, so fitting the
/// rect to the monitors would measure it against the ORIGIN monitor and shrink
/// a big popout to that one's size; and the compositor drops a position
/// anyway. The size was real on the screen the popout comes back to
/// (`present_on_monitor`); a screen that is gone caps it there (`fit_size_to`).
fn wayland_detached_fit(width: Option<f64>, height: Option<f64>) -> (Option<Position>, Option<Size>) {
    (None, detached_size(width, height))
}

/// `w`×`h` centred on the screen the main window is on (physical px), for a
/// popout whose own screen was unplugged. `None` without a main window or a
/// monitor reading — the caller then leaves the WM's placement.
fn onto_main_screen(
    app: &AppHandle,
    w: u32,
    h: u32,
) -> Option<crate::schema::settings::WindowState> {
    let main = app.get_webview_window(crate::services::window_service::MAIN_WINDOW_LABEL)?;
    let m = main.current_monitor().ok()??;
    let monitor = MonitorRect {
        x: m.position().x,
        y: m.position().y,
        w: m.size().width,
        h: m.size().height,
    };
    crate::services::window_state::center_on_monitor(w, h, monitor)
}

/// Whether a window's on-screen position can be read back and set at all.
///
/// Wayland deliberately gives a client neither: `set_position` is dropped by
/// the compositor and `outer_position()` reads back `(0,0)` for every window
/// (GTK3 has no toplevel coordinates to report). Sizes are still real. Every
/// geometry-by-position path below — the #240 snap, the switch-back
/// re-placement — therefore has to know it is working on `(0,0)` filler rather
/// than a location, or it "corrects" windows that were fine (user, 2026-09-07,
/// first session on GNOME/Wayland). X11, Windows and macOS all report real
/// positions.
fn window_positions_readable() -> bool {
    #[cfg(target_os = "linux")]
    {
        !crate::platform::x11::session_is_wayland()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Fit ONE live popout entirely onto the screen it is currently on (#240):
/// never larger than that monitor, never hanging off an edge. Returns whether
/// anything moved (a popout that already fits is left alone).
///
/// Reads the window's real geometry rather than any remembered rect — the whole
/// point is to correct a window the *WM* just re-placed (a display was
/// unplugged) or that the user dragged onto a smaller screen. Geometry is
/// PHYSICAL px throughout, the canonical cross-window space.
///
/// A popout parked by a project switch is skipped: it is hidden, its on-screen
/// geometry is whatever the WM left it while invisible, and the switch-back path
/// (`show_detached_windows`) is what re-places it — snapping a hidden
/// window would only persist that garbage rect.
///
/// A maximized popout is unmaximized first, so the gesture always leaves a
/// normal, draggable, edge-snappable window rather than a maximized one whose
/// `set_size` the WM may ignore.
pub fn snap_detached_to_screen(app: &AppHandle, label: &str) -> bool {
    // Under Wayland there is no real geometry to read (see
    // `window_positions_readable`): every popout reports (0,0), i.e. the origin
    // of the primary monitor, and fitting it "onto the screen it is on" would
    // shrink a popout that actually sits on a larger secondary display to the
    // primary's size. The compositor constrains its own windows when a display
    // goes away, so there is nothing for this rescue to do there.
    if !window_positions_readable() {
        return false;
    }
    let Some(win) = app.get_webview_window(label) else {
        return false;
    };
    if !win.is_visible().unwrap_or(false) {
        return false;
    }
    let (Ok(pos), Ok(inner), Ok(outer)) = (win.outer_position(), win.inner_size(), win.outer_size())
    else {
        return false;
    };
    // Fit the OUTER rect — what the screen actually has to hold — while setting
    // the INNER one, which is all `set_size` can set. The two differ only where a
    // popout is decorated (macOS; `detached_decorations`), and there by exactly
    // the title bar we'd otherwise push off the bottom of the screen.
    let chrome_w = outer.width.saturating_sub(inner.width);
    let chrome_h = outer.height.saturating_sub(inner.height);
    let current = crate::schema::settings::WindowState {
        x: pos.x,
        y: pos.y,
        w: outer.width,
        h: outer.height,
        maximized: false,
    };
    let monitors = crate::services::window_service::monitor_rects(&win);
    let Some(g) = crate::services::window_state::snap_detached_geometry(current, &monitors) else {
        return false;
    };
    if win.is_maximized().unwrap_or(false) {
        let _ = win.unmaximize();
    }
    // Size before position so a resize can't shift the placement (same order the
    // respawn and switch-back paths use).
    let _ = win.set_size(PhysicalSize::new(
        g.w.saturating_sub(chrome_w).max(1),
        g.h.saturating_sub(chrome_h).max(1),
    ));
    let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
    true
}

/// The scope string the ROOT terminal's tabs — and its popouts — live under.
/// The frontend's `ROOT_SCOPE`; a switch's `project_id` of `None` means exactly
/// this scope, which is why the popout paths must translate rather than pass the
/// `Option` through (a root popout registers under `"root"`, never `None`).
pub const ROOT_SCOPE: &str = "root";

/// Park the given popouts, preserving their monitor (#42).
///
/// Every backend whose window positions are readable (X11, Windows, macOS). On
/// X11 it complements the desktop-park in `project_runtime::switch`. Native
/// Wayland does not park at all: [`sync_detached_visibility`] retires
/// (closes) an inactive scope's popouts there instead, and only falls back to
/// [`hide_parked_window`] for one holding unsaved work.
///
/// The geometry is captured in PHYSICAL px (scale-invariant, so it re-applies
/// onto the SAME monitor) BEFORE hiding, because `hide()`/`show()` lets the WM
/// re-place the window — typically onto the primary monitor — so the un-park
/// must put it back explicitly ([`show_detached_windows`]) or a multi-monitor
/// popout lands on the wrong screen. An ALREADY-hidden popout is skipped for the
/// capture: its on-screen geometry while invisible is whatever the WM left it,
/// and recording that would overwrite the good rect taken when it was parked.
pub fn hide_detached_windows(
    app: &AppHandle,
    win_registry: &WindowRegistryState,
    labels: &[String],
) {
    for label in labels {
        let Some(win) = app.get_webview_window(label) else {
            continue;
        };
        if win.is_visible().unwrap_or(false) {
            // A minimized popout stays minimized across the switch. Its geometry
            // is not captured: a minimized window's rect is the WM's icon slot
            // (Windows reports -32000,-32000), and the rect taken while it was
            // last on screen is the one to keep.
            let minimized = win.is_minimized().unwrap_or(false);
            let rect = if minimized {
                None
            } else {
                win.outer_position().ok().zip(win.inner_size().ok())
            };
            let mut reg = win_registry.lock_ok();
            if minimized {
                reg.detached_minimized.insert(label.clone());
            } else {
                reg.detached_minimized.remove(label);
            }
            if let Some((pos, size)) = rect {
                reg.detached_bounds.insert(
                    label.clone(),
                    crate::commands::apps::DetachedBounds {
                        x: pos.x,
                        y: pos.y,
                        w: size.width,
                        h: size.height,
                        monitor: None,
                    },
                );
            }
        }
        let _ = win.hide();
    }
}

/// Un-park the given popouts, back onto the screen they were parked from (#42).
///
/// Wayland re-shows a popout hidden by the unsaved-work fallback
/// ([`hide_parked_window`]) — the only kind parked there; other backends use
/// `unminimize()` first in case a backend minimized rather than hid them,
/// except for a popout the user had minimized, which comes back minimized
/// (`detached_minimized`). The remembered rect
/// is then validated against
/// the currently-connected monitors, so an unplugged display can't strand a
/// popout off-screen.
pub fn show_detached_windows(
    app: &AppHandle,
    win_registry: &WindowRegistryState,
    labels: &[String],
) {
    let main = app.get_webview_window(crate::services::window_service::MAIN_WINDOW_LABEL);
    let restore_main_focus = !window_positions_readable()
        && main.as_ref().is_some_and(|win| win.is_focused().unwrap_or(false));
    let mut presented = false;
    for label in labels {
        let Some(win) = app.get_webview_window(label) else {
            continue;
        };
        if !window_positions_readable() {
            let saved = {
                let mut reg = win_registry.lock_ok();
                reg.detached_parking
                    .transition(label, true)
                    .then(|| reg.detached_bounds.get(label).copied())
            };
            if let Some(saved) = saved {
                // Hidden by the unsaved-work fallback: a plain show() would
                // land on the pointer's screen, so it goes back the way a
                // respawn does — onto the screen it was hidden from — and, like
                // a respawn (`focused(false)`), without taking the focus the
                // user is typing into in the main window.
                #[cfg(target_os = "linux")]
                if let Ok(gtk_win) = win.gtk_window() {
                    use gtk::prelude::GtkWindowExt;
                    gtk_win.set_focus_on_map(false);
                }
                match saved.and_then(|b| b.monitor) {
                    Some(monitor) => {
                        let size = saved
                            .map(|b| Size::Physical(PhysicalSize::new(b.w, b.h)));
                        present_on_monitor(app, label, monitor, size);
                    }
                    None => {
                        let _ = win.show();
                        spawn_first_paint_nudge(app.clone(), label.clone());
                    }
                }
                presented = true;
            }
            continue;
        }
        // A popout the user had minimized comes back minimized. Minimizing the
        // still-hidden window first makes the show map it straight to its icon
        // (GTK's iconify-initially hint) instead of flashing it up; the second
        // call covers the X11 backend's `show_window` having mapped it already.
        let minimized = win_registry.lock_ok().detached_minimized.remove(label);
        if minimized {
            let _ = win.minimize();
            let _ = win.show();
            let _ = win.minimize();
        } else {
            let _ = win.unminimize();
            let _ = win.show();
        }
        // Put the popout back where it was before it was parked: the show()
        // above lets the WM move it (often onto the wrong monitor), so re-apply
        // the geometry captured at hide time. Size before position so a resize
        // can't shift the placement. PHYSICAL px → correct monitor regardless of
        // per-monitor scaling (#42).
        let saved = win_registry
            .lock_ok()
            .detached_bounds
            .get(label)
            .copied();
        let Some(b) = saved else { continue };
        let monitors = crate::services::window_service::monitor_rects(&win);
        match crate::services::window_state::resolve_detached_geometry(
            crate::schema::settings::WindowState {
                x: b.x,
                y: b.y,
                w: b.w,
                h: b.h,
                maximized: false,
            },
            &monitors,
        ) {
            Some(g) => {
                let _ = win.set_size(PhysicalSize::new(g.w, g.h));
                let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
            }
            // The display this popout was parked on is gone. Leaving the WM's
            // placement puts it on a real screen but at the size it had on the
            // old one — on a laptop panel that is a borderless window hanging off
            // two edges, with no resize border left to grab. Put it on the main
            // window's screen, fitted; failing that, fit it to the screen it
            // actually landed on (#240).
            None => match onto_main_screen(app, b.w, b.h) {
                Some(g) => {
                    let _ = win.set_size(PhysicalSize::new(g.w, g.h));
                    let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
                }
                None => {
                    snap_detached_to_screen(app, label);
                }
            },
        }
    }
    if presented && restore_main_focus {
        if let Some(main) = main {
            let _ = main.set_focus();
        }
    }
}

/// Which popouts a scope change touches, and how.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DetachedSyncPlan {
    /// Hidden with their geometry captured (positions readable: X11/Windows/macOS).
    pub hide: Vec<String>,
    /// Shown again (there: all of the scope's; Wayland: those hidden by the
    /// unsaved-work fallback).
    pub show: Vec<String>,
    /// Wayland: asked to settle their unsaved work, then closed, each with the
    /// token of its retire request.
    pub retire: Vec<(String, u64)>,
    /// Wayland: closed at once, already marked retiring — popouts whose
    /// renderer never announced it could answer (still loading, or from before
    /// this protocol). A popout that has not attached its listener holds no work.
    pub close: Vec<String>,
}

/// Decide a scope change under the registry lock, and record the scope as the
/// active one. Pure over the registry, so the platform split is unit-tested.
///
/// On native Wayland an inactive scope's popout is closed rather than hidden:
/// a minimized surface cannot be tracked there (GTK never reports it), so any
/// way the compositor brought it back left a blank window over the other
/// project. Its store record stays and the frontend respawns it when the scope
/// returns (`respawnDetachedForScope`). A scope that returns before its popouts
/// answered the retire request simply keeps them.
pub fn plan_detached_sync(
    reg: &mut WindowRegistry,
    scope: &str,
    positions_readable: bool,
) -> DetachedSyncPlan {
    reg.detached_active_scope = Some(scope.to_string());
    let (mine, others) =
        crate::services::window_service::detached_labels_by_scope(&reg.windows, scope);
    if positions_readable {
        return DetachedSyncPlan {
            hide: others,
            show: mine,
            ..Default::default()
        };
    }
    for label in &mine {
        reg.detached_retire.cancel(label);
    }
    let show = mine
        .into_iter()
        .filter(|l| reg.detached_parking.is_parked(l))
        .collect();
    let (mut retire, mut close) = (Vec::new(), Vec::new());
    for label in others {
        let r = &reg.detached_retire;
        // Already hidden for unsaved work (it stays so until its scope
        // returns), or already being asked / closed: nothing new to do.
        if reg.detached_parking.is_parked(&label) || r.is_pending(&label) || r.is_retiring(&label)
        {
            continue;
        }
        if reg.detached_retire.is_ready(&label) {
            if let Some(token) = reg.detached_retire.begin(&label) {
                retire.push((label, token));
            }
        } else {
            reg.detached_retire.mark_retiring(&label);
            close.push(label);
        }
    }
    DetachedSyncPlan {
        hide: Vec::new(),
        show,
        retire,
        close,
    }
}

/// What a retire does once its popout answered (or timed out).
#[derive(Debug, PartialEq, Eq)]
pub enum RetireOutcome {
    /// Cancelled, superseded, released, or its scope is active again.
    Abandon,
    /// Clean: marked retiring; destroy it.
    Close,
    /// Unsaved work (or no answer): marked parked; hide it.
    Hide,
}

/// Whether `label`'s scope is still one the main window is NOT showing.
pub fn retire_still_wanted(reg: &WindowRegistry, label: &str) -> bool {
    let scope = reg.windows.get(label).and_then(|w| w.project_id.as_deref());
    scope.is_some() && scope != reg.detached_active_scope.as_deref()
}

/// Settle a retire in ONE critical section: close the handshake, re-check the
/// scope, and record the outcome (retiring / parked) before the lock drops — so
/// a `sync_detached_scope` for the popout's scope can never slip in between
/// the check and the record and leave the active scope's popout hidden.
pub fn settle_retire(
    reg: &mut WindowRegistry,
    label: &str,
    token: u64,
    clean: bool,
) -> RetireOutcome {
    if !reg.detached_retire.take(label, token) || !retire_still_wanted(reg, label) {
        return RetireOutcome::Abandon;
    }
    if clean {
        reg.detached_retire.mark_retiring(label);
        RetireOutcome::Close
    } else if reg.detached_parking.transition(label, false) {
        RetireOutcome::Hide
    } else {
        RetireOutcome::Abandon
    }
}

/// Main thread, right before `destroy()`: is the close still wanted? If the
/// scope came back since it was decided, the retire is withdrawn (the window
/// stays, and a respawn waiting on it finds it live). Serialized with
/// `sync_detached_scope`, which also runs on the main thread.
pub fn confirm_close(reg: &mut WindowRegistry, label: &str) -> bool {
    if reg.detached_retire.is_retiring(label) && retire_still_wanted(reg, label) {
        return true;
    }
    reg.detached_retire.withdraw(label);
    false
}

/// Main thread, right before `hide()`: the same re-check for the
/// unsaved-work fallback. A sync that already presented the popout cleared its
/// parked mark; one that finds its scope active again drops the mark.
pub fn confirm_park(reg: &mut WindowRegistry, label: &str) -> bool {
    if reg.detached_parking.is_parked(label) && retire_still_wanted(reg, label) {
        return true;
    }
    reg.detached_parking.forget(label);
    false
}

/// Bring every live popout in line with the scope the main window is showing:
/// this scope's are shown, every other scope's is parked (or, on Wayland,
/// retired).
///
/// The ONE place popout visibility is decided, for every way the scope can
/// change — a project switch, the root, and entering a box (which performs no
/// project switch at all). Its one caller is the frontend's `setScope`: the
/// project switch used to run the same sync from its worker thread, unordered
/// against this one, and a stale run could park the active scope's popout.
pub fn sync_detached_visibility(app: &AppHandle, win_registry: &WindowRegistryState, scope: &str) {
    let plan = plan_detached_sync(
        &mut win_registry.lock_ok(),
        scope,
        window_positions_readable(),
    );
    hide_detached_windows(app, win_registry, &plan.hide);
    show_detached_windows(app, win_registry, &plan.show);
    for label in plan.close {
        close_retiring_window(app, &label);
    }
    for (label, token) in plan.retire {
        retire_detached_window(app.clone(), label, token);
    }
}

/// Frontend hook for the above: the tabs store calls this whenever the active
/// scope changes, then asks `detach_subwindow` for each of the new scope's
/// popouts (a no-op for a live one; the rebuild of one a Wayland scope-out
/// retired).
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn sync_detached_scope(
    app: AppHandle,
    win_registry: State<'_, WindowRegistryState>,
    scope: String,
) {
    sync_detached_visibility(&app, &win_registry, &scope);
}

/// Event a popout listens on (suffixed with its label) for "your scope was
/// left: save what autosave would, and say whether anything unsaved remains".
pub const RETIRE_REQUEST_EVENT_PREFIX: &str = "detached-retire-request-";

/// How long a ready popout gets to answer. Covers an autosave flush to a remote
/// project; one that does not answer in time (hung) is hidden instead of
/// closed, so nothing it holds is lost.
const RETIRE_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(2500);

/// How long `detach_subwindow` waits for a retiring window of its label to go.
const RETIRE_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// Ask one popout to settle, then close it — or, if it still holds unsaved
/// work, hide it. Off the main thread: the answer arrives through a
/// command the main thread must be free to run.
fn retire_detached_window(app: AppHandle, label: String, token: u64) {
    std::thread::spawn(move || {
        let reg = app.state::<WindowRegistryState>().inner().clone();
        let (tx, rx) = std::sync::mpsc::channel();
        reg.lock_ok()
            .detached_retire
            .await_ack(&label, token, tx);
        use tauri::Emitter;
        let clean = app
            .emit(&format!("{RETIRE_REQUEST_EVENT_PREFIX}{label}"), ())
            .is_ok()
            // A cancel (the scope came back) drops the sender: Err → Abandon.
            && rx.recv_timeout(RETIRE_ACK_TIMEOUT).unwrap_or(false);
        let outcome = settle_retire(&mut reg.lock_ok(), &label, token, clean);
        eprintln!("popout {label}: retire answered clean={clean} -> {outcome:?}");
        match outcome {
            // The window stays: if it answered clean it went inert waiting to
            // be closed, so tell it it is staying.
            RetireOutcome::Abandon => emit_retire_withdrawn(&app, &label),
            RetireOutcome::Close => close_retiring_window(&app, &label),
            RetireOutcome::Hide => hide_parked_window(&app, &label),
        }
    });
}

/// Destroy a popout already marked retiring, keeping its size for the respawn.
/// The `Destroyed` hook sees the mark and keeps the frontend's record.
fn close_retiring_window(app: &AppHandle, label: &str) {
    let on_main = app.clone();
    let label = label.to_string();
    let fallback = (app.clone(), label.clone());
    let dispatched = app.run_on_main_thread(move || {
        let reg = on_main.state::<WindowRegistryState>();
        if !confirm_close(&mut reg.lock_ok(), &label) {
            emit_retire_withdrawn(&on_main, &label);
            return;
        }
        let Some(win) = on_main.get_webview_window(&label) else {
            reg.lock_ok().detached_retire.finish(&label);
            return;
        };
        remember_wayland_bounds(&reg, &win, &label);
        // No registry lock held here: `destroy()` may run the `Destroyed` hook,
        // which takes it.
        if win.destroy().is_err() {
            reg.lock_ok().detached_retire.withdraw(&label);
            emit_retire_withdrawn(&on_main, &label);
        }
    });
    if dispatched.is_err() {
        let (app, label) = fallback;
        app.state::<WindowRegistryState>()
            .lock_ok()
            .detached_retire
            .withdraw(&label);
        emit_retire_withdrawn(&app, &label);
    }
}

/// Event (suffixed with the label) telling a popout that a retire it may have
/// answered "clean" to is off and the window stays: lift the input block.
pub const RETIRE_WITHDRAWN_EVENT_PREFIX: &str = "detached-retire-withdrawn-";

fn emit_retire_withdrawn(app: &AppHandle, label: &str) {
    use tauri::Emitter;
    let _ = app.emit(&format!("{RETIRE_WITHDRAWN_EVENT_PREFIX}{label}"), ());
}

/// Mark `label`'s placement begun or finished (`set_detached_placing`): what
/// GDK says of a popout while it is placed, and for a moment after, is not
/// recorded as its screen or size. `present_on_monitor` sets it as the hop
/// starts and clears it where the hop ends.
fn mark_placing(app: &AppHandle, label: &str, placing: bool) {
    let reg = app.state::<WindowRegistryState>();
    let mut reg = reg.lock_ok();
    // A window released meanwhile (destroyed mid-hop) has no placement left to mark.
    if placing || reg.windows.contains_key(label) {
        reg.set_detached_placing(label, placing);
    }
}

/// The screen `label`'s record names, with its identity.
fn recorded_screen(reg: &WindowRegistry, label: &str) -> Option<Screen> {
    let rect = reg.detached_bounds.get(label)?.monitor?;
    Some(Screen { rect, id: reg.detached_screens.id(label) })
}

/// Fold one [`Verdict`] into the registry's record for `label`. Answers whether
/// the recorded screen changed (so the kept file needs the new one).
fn apply_verdict(reg: &mut WindowRegistry, label: &str, v: &Verdict) -> bool {
    if v.screen.is_none() && v.size.is_none() {
        return false;
    }
    let old = reg.detached_bounds.get(label).copied();
    let Some((w, h)) = v.size.or(old.map(|b| (b.w, b.h))) else {
        return false;
    };
    let before = recorded_screen(reg, label);
    let monitor = v.screen.map(|s| s.rect).or(old.and_then(|b| b.monitor));
    reg.detached_bounds
        .insert(label.to_string(), DetachedBounds { x: 0, y: 0, w, h, monitor });
    if let Some(s) = v.screen {
        reg.detached_screens.set_id(label, s.id);
    }
    recorded_screen(reg, label) != before
}

/// How much of a look at a popout to say in the log.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Say {
    /// Only what changed the record (the once-a-second poll).
    Changes,
    /// Every outcome (a retire, a hide, the quit).
    Always,
}

/// Look at one popout now and fold what is trustworthy into its record
/// ([`popout_screen::PopoutScreens::observe`]): the screen it was last truly
/// shown on and its settled size, never a guess, a fullscreen size or a
/// mid-placement reading. A reading that does not qualify leaves the previous
/// record. The kept file is written (off this thread) when the screen changed,
/// or whenever `Say::Always` found a settled window. Main thread (GTK).
fn record_popout(reg: &WindowRegistryState, win: &tauri::WebviewWindow, label: &str, say: Say) -> Verdict {
    let view = sample_popout(win);
    let (verdict, changed, kept) = {
        let mut g = reg.lock_ok();
        let recorded = recorded_screen(&g, label);
        let verdict = g
            .detached_screens
            .observe(label, std::time::Instant::now(), view, recorded);
        let changed = apply_verdict(&mut g, label, &verdict);
        let kept = g.detached_bounds.get(label).and_then(|b| {
            let screen = recorded_screen(&g, label)?;
            Some(popout_screen::KeptScreen::new(screen, (b.w, b.h), popout_screen::now_secs()))
        });
        (verdict, changed, kept)
    };
    let settled = verdict.size.is_some();
    if changed || (say == Say::Always && settled) {
        if let Some(kept) = kept {
            popout_screen::persist(label, Some(kept));
        }
    }
    if say == Say::Always || changed || verdict.why == Why::UserMoved {
        let seen = view.seen.map(|s| (s.rect.x, s.rect.y, s.rect.w, s.rect.h));
        eprintln!(
            "popout {label}: screen record {:?} (gdk says {seen:?}, shown {}, fullscreen {}) -> {:?}",
            verdict.why,
            view.shown,
            view.fullscreen,
            kept.map(|k| (k.x, k.y, k.w, k.h)),
        );
    }
    verdict
}

/// The size and screen a Wayland popout has right now, kept for the moment it
/// comes back (a respawn, or the re-show of a hidden one): the screen it was
/// last truly shown on, so it lands there again rather than wherever GNOME
/// puts new windows (the pointer's screen). A popout that is not placed yet,
/// whose placement has not finished, or that is fullscreen keeps its previous
/// record whole — a fast A to B to A, or a retire mid-hop, must not replace a
/// good record with GDK's guess or the hop's fullscreen size.
fn remember_wayland_bounds(reg: &WindowRegistryState, win: &tauri::WebviewWindow, label: &str) {
    record_popout(reg, win, label, Say::Always);
}

/// One popout's screen and size for the saved layout (native Wayland).
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct DetachedScreen {
    pub w: u32,
    pub h: u32,
    pub monitor: MonitorRect,
}

/// The screen and size each of `labels` has, for the saved layout to keep at
/// quit so a restart respawns it there (`detach_subwindow`'s `monitor`). Native
/// Wayland only — elsewhere the saved position already says it, and this
/// answers nothing. A shown popout is looked at now; every answer is the
/// RECORD ([`record_popout`]), never a bare reading, so a retired, hidden or
/// not-yet-placed one answers its last good one; one with none is left out.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn detached_window_screens(
    app: AppHandle,
    labels: Vec<String>,
) -> std::collections::HashMap<String, DetachedScreen> {
    if window_positions_readable() {
        return Default::default();
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let on_main = app.clone();
    let dispatched = app.run_on_main_thread(move || {
        let reg = on_main.state::<WindowRegistryState>();
        let mut out = std::collections::HashMap::new();
        for label in labels {
            if let Some(win) = on_main
                .get_webview_window(&label)
                .filter(|w| w.is_visible().unwrap_or(false))
            {
                record_popout(&reg, &win, &label, Say::Always);
            }
            let screen = reg.lock_ok().detached_bounds.get(&label).and_then(|b| {
                (b.w >= 1 && b.h >= 1).then_some(DetachedScreen { w: b.w, h: b.h, monitor: b.monitor? })
            });
            if let Some(screen) = screen {
                out.insert(label, screen);
            }
        }
        let _ = tx.send(out);
    });
    if dispatched.is_err() {
        return Default::default();
    }
    rx.await.unwrap_or_default()
}

/// Native Wayland, on every way out of the process that gets this far (a
/// SIGTERM or SIGINT, `app.exit`, a `pkill`): look at every shown popout one
/// last time and let the kept file take it, before the windows go. The
/// window's own quit does this through `detached_window_screens`; the signal
/// path never ran that, and the file is also written whenever the record
/// changes, which is all a SIGKILL or a crash leaves. Main thread (GTK).
pub fn remember_screens_at_exit(app: &AppHandle) {
    if window_positions_readable() {
        return;
    }
    let reg = app.state::<WindowRegistryState>();
    let labels = crate::services::window_service::all_detached_labels(&reg.lock_ok().windows);
    for label in labels {
        if let Some(win) = app
            .get_webview_window(&label)
            .filter(|w| w.is_visible().unwrap_or(false))
        {
            record_popout(&reg, &win, &label, Say::Always);
        }
    }
    popout_screen::drain_at_exit();
}

/// How often the screen tracker looks at the popouts.
const SCREEN_TRACK_POLL: std::time::Duration = std::time::Duration::from_secs(1);

/// Native Wayland: keep every shown popout's record current as it settles and
/// as the user moves it, so the kept file is right whenever the process ends —
/// not only at a clean quit. One look a second, only while a popout exists, the
/// reading on the main thread and the file write on its own worker.
pub fn spawn_screen_tracker(app: AppHandle) {
    if window_positions_readable() {
        return;
    }
    let busy = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    std::thread::spawn(move || loop {
        std::thread::sleep(SCREEN_TRACK_POLL);
        let labels = {
            let reg = app.state::<WindowRegistryState>();
            let reg = reg.lock_ok();
            crate::services::window_service::all_detached_labels(&reg.windows)
        };
        // A look still queued behind a busy main thread is not stacked up.
        if labels.is_empty() || busy.swap(true, std::sync::atomic::Ordering::AcqRel) {
            continue;
        }
        let (on_main, flag) = (app.clone(), busy.clone());
        if app
            .run_on_main_thread(move || {
                let reg = on_main.state::<WindowRegistryState>();
                for label in labels {
                    if let Some(win) = on_main.get_webview_window(&label) {
                        record_popout(&reg, &win, &label, Say::Changes);
                    }
                }
                flag.store(false, std::sync::atomic::Ordering::Release);
            })
            .is_err()
        {
            busy.store(false, std::sync::atomic::Ordering::Release);
        }
    });
}

/// The unsaved-work fallback, already marked parked by [`settle_retire`]:
/// hide instead of close, so the unsaved buffer survives. Shown again by
/// [`show_detached_windows`] when its scope returns. Hidden, not minimized: GTK
/// never reports a Wayland minimize, so a popout GNOME left on screen (or that
/// Alt+Tab / the overview brought back) stayed live over the other project,
/// still marked parked, and every later switch skipped it. A hidden window has
/// no surface for the compositor to bring back. Re-showing one used to land on
/// the pointer's screen; it now goes through [`present_on_monitor`] like a
/// respawn.
fn hide_parked_window(app: &AppHandle, label: &str) {
    let on_main = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        let reg = on_main.state::<WindowRegistryState>();
        if !confirm_park(&mut reg.lock_ok(), &label) {
            eprintln!("popout {label}: unsaved-work park withdrawn (scope back)");
            return;
        }
        let hidden = on_main.get_webview_window(&label).is_some_and(|win| {
            remember_wayland_bounds(&reg, &win, &label);
            win.hide().is_ok()
        });
        if hidden {
            eprintln!("popout {label}: hidden with unsaved work");
        } else {
            eprintln!("popout {label}: hide failed, stays on screen");
            reg.lock_ok().detached_parking.forget(&label);
        }
    });
}

/// A popout's answer to [`RETIRE_REQUEST_EVENT_PREFIX`]: `clean` = nothing
/// unsaved is left in it. Bound to the calling window's own label, so a popout
/// can only answer for itself.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn detached_retire_ack(
    window: tauri::WebviewWindow,
    win_registry: State<'_, WindowRegistryState>,
    clean: bool,
) -> bool {
    win_registry
        .lock_ok()
        .detached_retire
        .ack(window.label(), clean)
}

/// A popout's renderer has attached its retire listener and can answer from
/// now on. Until then a scope-out closes it directly: it is still loading and
/// holds no work. (A renderer from before this protocol never calls this, so
/// it is closed directly too — it could not answer anyway.)
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn detached_retire_ready(window: tauri::WebviewWindow, win_registry: State<'_, WindowRegistryState>) {
    win_registry
        .lock_ok()
        .detached_retire
        .mark_ready(window.label());
}

/// Whether the calling popout should stop rendering because it is parked.
///
/// Native Wayland: never. A popout of an inactive scope is closed there, and
/// the one kept alive for unsaved work stays rendered — GTK cannot report
/// minimization, so the compositor may show it at any time, and a parked
/// renderer blanks every pane (the "empty third window" bug). Elsewhere
/// parking is a real `hide()` the renderer reads through `isVisible()`, and
/// this set is empty. Kept as a command for hot-reload compatibility.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn detached_window_is_parked(
    window: tauri::WebviewWindow,
    win_registry: State<'_, WindowRegistryState>,
) -> bool {
    window_positions_readable()
        && win_registry
            .lock_ok()
            .detached_parking
            .is_parked(window.label())
}

/// Double-clicking a popout's title bar snaps it onto the screen it is on
/// (#240). The rescue gesture for the window the user can no longer resize:
/// a borderless popout sized on an external monitor keeps that size when the
/// display goes away, and its resize edges go with it off the panel.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn snap_detached_window(app: AppHandle, label: String) -> bool {
    snap_detached_to_screen(&app, &label)
}

/// Raise one of the active scope's popouts and give it the keyboard —
/// steering's J (the main window walks no popout itself). Popout labels only,
/// so this can never bring up the main window or a presenter. Wayland's
/// `set_focus` presents the surface (`gtk_window_present_with_time`), which
/// also undoes a minimize there.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn focus_detached_window(app: AppHandle, label: String) -> bool {
    if !label.starts_with("detached-") {
        return false;
    }
    let Some(win) = app.get_webview_window(&label) else {
        return false;
    };
    let _ = win.unminimize();
    let _ = win.show();
    win.set_focus().is_ok()
}

/// How often the monitor-arrangement watcher re-reads the connected displays.
/// One cheap runtime query; the cost of noticing an unplug late is a popout the
/// user cannot reach, so this stays in the "within a breath" range rather than
/// being tuned down to nothing.
const MONITOR_POLL: std::time::Duration = std::time::Duration::from_secs(3);

/// How long to let the WM finish its own re-placement of every window before
/// correcting the popouts. Unplugging a display moves windows in several steps
/// on X11; snapping mid-flight would fight it and leave the popout wherever the
/// last step put it.
const MONITOR_SETTLE: std::time::Duration = std::time::Duration::from_millis(1200);

/// Watch for the display arrangement changing and re-fit every live popout onto
/// a real screen (#240).
///
/// Polled, not event-driven: neither Tauri nor tao surfaces a monitor
/// hot-plug event, and the renderer sees nothing either (WebKitGTK stays silent
/// for a monitor change that doesn't resize the window). One
/// `available_monitors()` read every few seconds is far cheaper than the failure
/// it prevents — undocking from an external display leaves a borderless popout
/// larger than the laptop panel, with its title bar and every resize edge past
/// the screen, i.e. a window with no way back.
///
/// The main window's own geometry is deliberately NOT touched: it is decorated,
/// WM-managed, and the user can always grab it.
pub fn spawn_monitor_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut seen: Option<Vec<crate::services::window_state::MonitorRect>> = None;
        loop {
            std::thread::sleep(MONITOR_POLL);
            // Nothing to rescue → don't even read the monitors. The read is a
            // round trip through the main-thread event loop, and the overwhelmingly
            // common case is a session with no popout at all; waking the UI thread
            // every few seconds for it would be a pure battery cost. Forgetting the
            // baseline here is deliberate: the first poll after a popout appears
            // re-establishes it, so a popout is never snapped for having been born
            // between two reads.
            let has_popouts = {
                let reg = app.state::<WindowRegistryState>();
                let reg = reg.lock_ok();
                !crate::services::window_service::all_detached_labels(&reg.windows).is_empty()
            };
            if !has_popouts {
                seen = None;
                continue;
            }
            let Some(main) = app.get_webview_window(
                crate::services::window_service::MAIN_WINDOW_LABEL,
            ) else {
                // No main window: shutting down, or not built yet.
                continue;
            };
            let now = crate::services::window_service::monitor_rects(&main);
            // An empty read is a compositor that hasn't settled, not "every
            // display was unplugged" — treating it as a change would snap every
            // popout against no monitors at all.
            if now.is_empty() || seen.as_ref() == Some(&now) {
                continue;
            }
            let first = seen.is_none();
            seen = Some(now);
            // The first read is the baseline, not a change.
            if first {
                continue;
            }
            std::thread::sleep(MONITOR_SETTLE);
            let labels = {
                let reg = app.state::<WindowRegistryState>();
                let reg = reg.lock_ok();
                crate::services::window_service::all_detached_labels(&reg.windows)
            };
            for label in labels {
                snap_detached_to_screen(&app, &label);
            }
        }
    });
}

/// Close a detached subwindow and remove it from the registry + parkable
/// override. Idempotent: a missing window/registry entry is not an error (the
/// group still docks back in the frontend store).
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn attach_subwindow(
    app: AppHandle,
    workspace: State<'_, WorkspaceStateArc>,
    win_registry: State<'_, WindowRegistryState>,
    registry_id: String,
) -> Result<(), String> {
    // Drop the parkable override first so a stray park can't target a closing id.
    // Free the display number in the same critical section so it can be reused.
    let wid = release_detached_entry(&mut win_registry.lock_ok(), &registry_id);
    if let Some(wid) = wid {
        workspace.lock_ok().backend.unset_parkable(wid);
    }
    // Docked or closed for good: the kept screen goes with the popout, so a
    // later group of the same label starts clean.
    if !window_positions_readable() {
        popout_screen::persist(&registry_id, None);
    }
    if let Some(window) = app.get_webview_window(&registry_id) {
        // `destroy()` (not `close()`) so the removal is immediate: `close()` fires
        // the detached window's `onCloseRequested`, which preventDefaults and waits
        // out a 1500ms dock-back grace — leaving the popout visible alongside the
        // freshly-docked group for ~1s. `destroy()` bypasses that handler entirely.
        let _ = window.destroy();
    }
    Ok(())
}

/// Desktop coordinates are unavailable on native Wayland: tao reports a dummy
/// (0, 0) cursor there. Query GDK's actual backend, so XWayland still works.
/// This synchronous command runs on the main thread, as GTK requires.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn desktop_coordinates_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        gtk::gdk::Display::default().is_some_and(|display| display.backend().is_x11())
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Whether the detached window registered under `registry_id` is the front-most
/// window at the current pointer location. The frontend calls this on a file
/// drop that lands over a popout's bounds: if the popout is occluded (behind the
/// main window or another app) it is NOT at front, so the caller keeps its local
/// drop target instead of merging into a window the user can't see (#42).
///
/// Unknown identity or stacking order cannot authorize a dock. In particular,
/// XWayland can expose desktop geometry while our native-id lookup is disabled
/// for the Wayland session; assuming that popout is on top steals local drops.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn detached_window_frontmost(
    win_registry: State<'_, WindowRegistryState>,
    registry_id: String,
) -> bool {
    let wid = win_registry
        .lock_ok()
        .windows
        .get(&registry_id)
        .and_then(|w| w.window_id);
    match wid {
        None => false,
        Some(wid) => {
            #[cfg(target_os = "linux")]
            {
                crate::platform::x11::frontmost_window_under_pointer()
                    .map(|top| top == wid)
                    .unwrap_or(false)
            }
            #[cfg(target_os = "windows")]
            {
                crate::platform::windows::frontmost_window_under_cursor()
                    .map(|top| top == wid)
                    .unwrap_or(false)
            }
            // macOS: the popout's CGWindowID comes from its NSWindow number
            // (`resolve_detached_window_id`), the same id space CGWindowList
            // enumerates, so the occlusion walk compares like with like.
            #[cfg(target_os = "macos")]
            {
                crate::platform::macos::frontmost_window_under_pointer()
                    .map(|top| top == wid)
                    .unwrap_or(false)
            }
            #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
            {
                let _ = wid;
                false
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn resolve_detached_window_id(_app: &AppHandle, _label: &str, title: &str) -> Option<u64> {
    crate::platform::x11::find_window_for_title(title, 20)
}

/// Windows: read the popout's HWND directly from the Tauri window by its stable
/// label (more robust than title enumeration, and the window is already built),
/// so the parkable override (#42) is reachable on Windows too — not X11-only.
#[cfg(target_os = "windows")]
fn resolve_detached_window_id(app: &AppHandle, label: &str, _title: &str) -> Option<u64> {
    let win = app.get_webview_window(label)?;
    let hwnd = win.hwnd().ok()?;
    Some(hwnd.0 as usize as u64)
}

/// macOS: the popout's `CGWindowID` is its `NSWindow.windowNumber`, read off
/// the Tauri window by its label — the same binding `lib.rs` does for the MAIN
/// window at setup. AppKit wants NSWindow access on the main thread, and this
/// runs from an async command on a worker, so the read is marshalled through
/// `run_on_main_thread` and awaited with a bound (a wedged main loop must not
/// hang the detach; the popout then simply is not parkable this session).
#[cfg(target_os = "macos")]
fn resolve_detached_window_id(app: &AppHandle, label: &str, _title: &str) -> Option<u64> {
    let win = app.get_webview_window(label)?;
    let (tx, rx) = std::sync::mpsc::channel::<Option<u64>>();
    let on_main = win.clone();
    win.run_on_main_thread(move || {
        let id = on_main
            .ns_window()
            .ok()
            .and_then(crate::platform::macos::ns_window_id);
        let _ = tx.send(id);
    })
    .ok()?;
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .ok()
        .flatten()
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn resolve_detached_window_id(_app: &AppHandle, _label: &str, _title: &str) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_embeds_scope_and_group() {
        assert_eq!(detached_label("p1", "g-3"), "detached-p1-g-3");
    }

    #[test]
    fn title_is_a_human_friendly_sequence_name() {
        assert_eq!(detached_title(1), concat!(crate::app_name!(), " win-1"));
        assert_eq!(detached_title(2), concat!(crate::app_name!(), " win-2"));
        // Distinct numbers produce distinct titles (the X11 resolver key must be
        // unique per live window).
        assert_ne!(detached_title(1), detached_title(2));
    }

    #[test]
    fn query_carries_scope_and_group_as_separate_keys() {
        assert_eq!(
            detached_query("p1", "g-3"),
            "index.html?detached=p1&group=g-3"
        );
        assert_eq!(
            detached_query("root", "g-1"),
            "index.html?detached=root&group=g-1"
        );
    }

    #[test]
    fn a_box_scopes_colon_survives_the_query() {
        // The #224 bug: one `scope:group` value split on the first colon read
        // `box:abc:g-3` as scope "box", so a box popout could never be seeded.
        // Two keys make the scope opaque — encoded, so it cannot end the value.
        let q = detached_query("box:abc", "g-3");
        assert_eq!(q, "index.html?detached=box%3Aabc&group=g-3");
        assert!(!q.trim_start_matches("index.html?detached=box%3Aabc").contains(':'));
    }

    #[test]
    fn urlencode_escapes_separators_and_keeps_id_characters() {
        assert_eq!(urlencode("g-3"), "g-3");
        assert_eq!(urlencode("box:abc"), "box%3Aabc");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencode("a b"), "a%20b");
    }

    #[test]
    fn only_macos_detached_windows_use_native_decorations() {
        assert!(detached_decorations(crate::paths::OsKind::Macos));
        assert!(!detached_decorations(crate::paths::OsKind::Windows));
        assert!(!detached_decorations(crate::paths::OsKind::Unix));
    }

    #[test]
    fn restore_geometry_is_applied_as_physical_pixels() {
        // The frontend ships PHYSICAL desktop px (`src/lib/window/coords.ts`); a detached
        // window MUST apply them via the `Physical` dpi variant, NOT the builder's
        // LOGICAL setters — otherwise it lands off-screen on any scale != 1.0
        // display (the #42 Windows regression). Pin both the variant and value so a
        // revert to logical (or to LogicalPosition/LogicalSize) fails the build.
        match detached_position(Some(1500.0), Some(820.0)) {
            Some(Position::Physical(p)) => {
                assert_eq!(p.x, 1500);
                assert_eq!(p.y, 820);
            }
            other => panic!("expected a physical position, got {other:?}"),
        }
        match detached_size(Some(900.0), Some(640.0)) {
            Some(Size::Physical(s)) => {
                assert_eq!(s.width, 900);
                assert_eq!(s.height, 640);
            }
            other => panic!("expected a physical size, got {other:?}"),
        }
    }

    fn tracked(label: &str, window_id: Option<u64>) -> TrackedWindow {
        TrackedWindow {
            id: label.to_string(),
            exec: concat!(crate::app_slug!(), "-detached").to_string(),
            file: None,
            pid: 1,
            project_id: Some("p1".to_string()),
            role: Some("g-1".to_string()),
            opened_at: 0.0,
            window_id,
            origin: ORIGIN_DETACHED_SUBWINDOW.to_string(),
            launch_id: None,
        }
    }

    #[test]
    fn released_numbers_are_reused_lowest_first() {
        // The user-visible guarantee: a lone popout is always "win-1". Reserve
        // three, release the first two (whichever way their windows died), and
        // the next detach must take 1 — not climb to 4.
        let mut reg = WindowRegistry::default();
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-1"), 1);
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-2"), 2);
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-3"), 3);
        release_detached_entry(&mut reg, "detached-p1-g-1");
        release_detached_entry(&mut reg, "detached-p1-g-2");
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-4"), 1);
        // 3 is still live, so the one after takes 2, never a duplicate 3.
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-5"), 2);
    }

    #[test]
    fn release_is_idempotent_and_returns_the_native_id() {
        // The Destroyed hook fires after `attach_subwindow` already freed the
        // entry, so a second release of the same label must be a clean no-op.
        let mut reg = WindowRegistry::default();
        let label = "detached-p1-g-1";
        reserve_detached_seq(&mut reg, label);
        reg.detached_parking.transition(label, false);
        reg.windows
            .insert(label.to_string(), tracked(label, Some(42)));
        assert_eq!(release_detached_entry(&mut reg, label), Some(42));
        assert!(reg.detached_seqs.is_empty());
        assert!(reg.windows.is_empty());
        assert!(!reg.detached_parking.is_parked(label));
        // Second release (and a never-registered label): no-op, no id.
        assert_eq!(release_detached_entry(&mut reg, label), None);
        assert_eq!(release_detached_entry(&mut reg, "detached-p1-g-9"), None);
    }

    fn tracked_in(label: &str, scope: &str) -> TrackedWindow {
        TrackedWindow {
            project_id: Some(scope.to_string()),
            ..tracked(label, None)
        }
    }

    #[test]
    fn a_second_detach_of_a_label_in_flight_never_builds_or_untracks() {
        let mut reg = WindowRegistry::default();
        let label = "detached-p1-g-1";
        assert_eq!(plan_detach(&mut reg, label, false), DetachPlan::Build(1));
        // A concurrent call (restart respawn + the scope respawn) while the
        // first is building: idempotent, no second number burned.
        assert_eq!(plan_detach(&mut reg, label, false), DetachPlan::AlreadyOpen);
        assert_eq!(reg.detached_seqs.len(), 1);
        // The first build registers its window; a later call still sees it.
        reg.windows.insert(label.to_string(), tracked(label, None));
        reg.detached_building.remove(label);
        assert_eq!(plan_detach(&mut reg, label, false), DetachPlan::AlreadyOpen);
        assert_eq!(plan_detach(&mut reg, label, true), DetachPlan::AlreadyOpen);
        // A stray failed build's cleanup must not touch the live window.
        release_detach_reservation(&mut reg, label);
        assert!(reg.windows.contains_key(label));
        assert_eq!(reg.detached_seqs.get(label), Some(&1));
    }

    #[test]
    fn a_failed_build_frees_only_its_own_reservation() {
        let mut reg = WindowRegistry::default();
        assert_eq!(plan_detach(&mut reg, "detached-p1-g-1", false), DetachPlan::Build(1));
        release_detach_reservation(&mut reg, "detached-p1-g-1");
        assert!(reg.detached_building.is_empty());
        assert!(reg.detached_seqs.is_empty());
        // The slot is reusable at once.
        assert_eq!(plan_detach(&mut reg, "detached-p1-g-1", false), DetachPlan::Build(1));
    }

    #[test]
    fn a_label_still_retiring_is_waited_for_then_rebuilt() {
        let mut reg = WindowRegistry::default();
        let label = "detached-p1-g-1";
        reg.windows.insert(label.to_string(), tracked(label, None));
        reserve_detached_seq(&mut reg, label);
        reg.detached_retire.mark_retiring(label);
        assert_eq!(plan_detach(&mut reg, label, true), DetachPlan::WaitForRetire);
        // Its Destroyed lands: the retire was planned, so no dock-back report.
        assert_eq!(on_detached_destroyed(&mut reg, label), (None, false));
        assert_eq!(plan_detach(&mut reg, label, false), DetachPlan::Build(1));
    }

    #[test]
    fn a_respawn_on_the_main_windows_screen_is_capped_to_it() {
        let laptop = MonitorRect { x: 0, y: 0, w: 1280, h: 800 };
        let big = Size::Physical(PhysicalSize::new(2400, 1300));
        assert_eq!(
            fit_size_to(big, laptop, 1.5),
            Size::Physical(PhysicalSize::new(1920, 1200))
        );
        let small = Size::Physical(PhysicalSize::new(900, 640));
        assert_eq!(fit_size_to(small, laptop, 1.0), small);
    }

    #[test]
    fn a_monitor_hop_leaves_fullscreen_once_then_restores_the_size_once() {
        use HopAction::*;
        use MonitorHop::*;
        // Reports before the fullscreen lands change nothing.
        assert_eq!(monitor_hop_step(Entering, false, false), (Entering, Nothing));
        // Fullscreen but not yet shown on its screen: leaving now would let
        // Mutter place it on the pointer's screen.
        assert_eq!(monitor_hop_step(Entering, true, false), (Entering, Nothing));
        assert_eq!(monitor_hop_step(Entering, true, true), (Leaving, Unfullscreen));
        // A repeated fullscreen report does not ask twice.
        assert_eq!(monitor_hop_step(Leaving, true, true), (Leaving, Nothing));
        // Out of fullscreen: the size comes back once, then the landing is checked.
        assert_eq!(monitor_hop_step(Leaving, false, false), (Settling, RestoreSize));
        // Afterwards the popout is an ordinary window: a later fullscreen is
        // someone's own, never undone here.
        assert_eq!(monitor_hop_step(Done, true, true), (Done, Nothing));
        assert_eq!(monitor_hop_step(Done, false, false), (Done, Nothing));
    }

    fn rect(x: i32, y: i32, w: u32, h: u32) -> MonitorRect {
        MonitorRect { x, y, w, h }
    }

    /// Mutter 50.1's side of a respawn's fullscreen hop, as PROBED (a private
    /// headless GNOME Shell with two screens, a GTK 3.24 client; the window's
    /// real screen read off a compositor screenshot — see [`present_on_monitor`]):
    ///
    /// * a window that leaves fullscreen before the compositor has acted on the
    ///   request (`shown_at`: ~15–20 ms after the show on an idle machine; 0 and
    ///   12 ms failed, 20 ms and later landed) is placed on the pointer's screen;
    ///   one that leaves after it, on the screen it is fullscreen on;
    /// * the surface's `wl_surface.enter` (GDK's answer) follows ~25 ms after the
    ///   show; GDK's answer then matches the window's real screen;
    /// * a window already shown that is asked fullscreen on a screen is moved
    ///   there, and leaving fullscreen keeps it there (the retry).
    ///
    /// Times in ms after the popout was asked fullscreen on `target` and shown.
    struct Compositor {
        monitors: Vec<MonitorRect>,
        /// The screen under the pointer: the main window's, after the switch.
        pointer: usize,
        /// The first configure: GTK reports FULLSCREEN from here.
        configure_at: u64,
        /// The compositor has acted on the fullscreen request: shown there.
        shown_at: u64,
        /// Then sends `wl_surface.enter` for the output.
        enter_after: u64,
        /// Something else (the page's stray-fullscreen guard) leaves fullscreen
        /// at this time, once.
        stray_at: Option<u64>,
    }

    impl Compositor {
        fn new(monitors: Vec<MonitorRect>, pointer: usize, timing: (u64, u64, u64)) -> Self {
            Compositor {
                monitors,
                pointer,
                configure_at: timing.0,
                shown_at: timing.1,
                enter_after: timing.2,
                stray_at: None,
            }
        }
    }

    #[derive(Debug, PartialEq)]
    struct Landing {
        /// The screen Mutter placed it on when it last left fullscreen.
        placed: Option<usize>,
        /// Size restores sent (one per time it left fullscreen).
        restores: u32,
        /// Round trips made (1 + retries).
        attempts: u32,
    }

    /// Drive `policy` the way `present_on_monitor` does — a look at each
    /// window-state report and at every 40 ms poll — against [`Compositor`].
    fn land(
        c: &Compositor,
        target: usize,
        policy: impl Fn(MonitorHop, HopView, usize) -> (MonitorHop, HopAction),
    ) -> Landing {
        use std::time::Duration;
        let (w, h) = (900, 640);
        let guess = gdk_fallback_monitor(w, h, &c.monitors);
        let mut hop = MonitorHop::Entering;
        let mut out = Landing { placed: None, restores: 0, attempts: 1 };
        // This attempt's start, and the compositor's delays within it: a retry
        // works on a shown window, which the compositor moves at once.
        let mut t0 = 0u64;
        let mut left_at: Option<u64> = None;
        let mut settle_from: Option<u64> = None;
        let mut was_fullscreen = false;
        let mut stray = c.stray_at;
        // Where the compositor has the window and from when GDK knows it, and
        // the last screen GDK knows it on.
        let mut on: Option<(usize, u64)> = None;
        let mut known: Option<usize> = None;
        let mut now = 0;
        while now <= 12_000 && hop != MonitorHop::Done {
            let first = out.attempts == 1;
            let (configure, shown) = if first { (c.configure_at, c.shown_at) } else { (10, 10) };
            let rel = now - t0;
            // Leaving fullscreen: placed by what the compositor has done by now.
            let leave = |now: u64,
                         out: &mut Landing,
                         left_at: &mut Option<u64>,
                         on: &mut Option<(usize, u64)>| {
                let screen = if rel >= shown { target } else { c.pointer };
                out.placed = Some(screen);
                *on = Some((screen, now + c.enter_after));
                *left_at = Some(now);
            };
            if left_at.is_none() && rel >= shown && on.map(|(s, _)| s) != Some(target) {
                on = Some((target, t0 + shown + c.enter_after));
            }
            if let Some(s) = stray {
                if left_at.is_none() && now >= s && rel >= configure {
                    stray = None;
                    leave(now, &mut out, &mut left_at, &mut on);
                }
            }
            if let Some((screen, at)) = on {
                if now >= at {
                    known = Some(screen);
                }
            }
            // GTK sees the unfullscreen confirmed on the next configure.
            let fullscreen = rel >= configure && left_at.is_none_or(|t| now < t + 10);
            let reported = now == t0 + configure || left_at.is_some_and(|t| now == t + 10);
            if reported || now % 40 == 0 {
                was_fullscreen |= fullscreen;
                let view = HopView {
                    fullscreen,
                    lost_fullscreen: was_fullscreen && !fullscreen,
                    answer: known.or(first.then_some(guess).flatten()),
                    guess: first.then_some(guess).flatten(),
                    elapsed: Duration::from_millis(rel),
                    settled: settle_from.map_or(Duration::ZERO, |t| Duration::from_millis(now - t)),
                    mapped: true,
                    retry_left: out.attempts - 1 < MONITOR_HOP_RETRIES,
                };
                let (next, action) = policy(hop, view, target);
                if next == MonitorHop::Settling && hop != MonitorHop::Settling {
                    settle_from = Some(now);
                }
                hop = next;
                if matches!(action, HopAction::Unfullscreen | HopAction::GiveUp) && left_at.is_none() {
                    leave(now, &mut out, &mut left_at, &mut on);
                }
                if matches!(action, HopAction::RestoreSize | HopAction::GiveUp) {
                    out.restores += 1;
                }
                if action == HopAction::Refullscreen {
                    out.attempts += 1;
                    t0 = now;
                    left_at = None;
                    settle_from = None;
                    was_fullscreen = false;
                }
            }
            now += 10;
        }
        out
    }

    /// Two externals side by side; laptop panel + two externals; two externals
    /// at different heights (nothing at the origin's right).
    fn layouts() -> Vec<Vec<MonitorRect>> {
        vec![
            vec![rect(0, 0, 2560, 1440), rect(2560, 0, 2560, 1440)],
            vec![rect(0, 0, 1920, 1200), rect(1920, 0, 2560, 1440), rect(4480, 0, 2560, 1440)],
            vec![rect(0, 300, 1920, 1080), rect(1920, 0, 2560, 1440)],
            vec![rect(2560, 0, 1920, 1080), rect(0, 0, 2560, 1440)],
        ]
    }

    /// Every layout, every (target, pointer) pair with the two apart.
    fn cases() -> Vec<(Vec<MonitorRect>, usize, usize)> {
        let mut out = Vec::new();
        for monitors in layouts() {
            for target in 0..monitors.len() {
                for pointer in (0..monitors.len()).filter(|&p| p != target) {
                    out.push((monitors.clone(), target, pointer));
                }
            }
        }
        out
    }

    #[test]
    fn the_old_hop_lands_on_the_pointers_screen_in_the_compositor_model() {
        // The model finds the bug the user kept hitting: leaving fullscreen at
        // GTK's first fullscreen report, before the compositor has acted.
        let c = Compositor::new(layouts()[0].clone(), 0, (20, 60, 10));
        let old = |hop, v: HopView, _| {
            let (next, action) = monitor_hop_step(hop, v.fullscreen, true);
            (if next == MonitorHop::Settling { MonitorHop::Done } else { next }, action)
        };
        assert_eq!(land(&c, 1, old).placed, Some(0));
    }

    #[test]
    fn a_respawn_lands_on_its_own_screen_whatever_the_layout_and_timing() {
        // (configure, shown, enter after shown): a quick show, a loaded
        // switch, a very slow first frame.
        let timings = [(10, 30, 10), (20, 200, 20), (30, 1500, 30), (50, 3000, 40)];
        for (monitors, target, pointer) in cases() {
            let guess = gdk_fallback_monitor(900, 640, &monitors);
            for &timing in &timings {
                let c = Compositor::new(monitors.clone(), pointer, timing);
                let out = land(&c, target, hop_tick);
                let case = format!("{monitors:?}, target {target}, pointer {pointer}, timing {timing:?}");
                assert_eq!(out.placed, Some(target), "{case}");
                if guess == Some(target) && timing.1 + timing.2 >= 700 {
                    // Meant for the screen GDK guesses anyway, only the unproven
                    // delay stands in for the proof: leaving early lands on the
                    // pointer's screen, and the landing check goes round again.
                    assert_eq!((out.restores, out.attempts), (2, 2), "{case}");
                } else {
                    assert_eq!((out.restores, out.attempts), (1, 1), "{case}");
                }
            }
        }
    }

    #[test]
    fn something_else_leaving_fullscreen_early_is_undone_by_one_more_round_trip() {
        // The page's stray-fullscreen guard (or a compositor that refuses the
        // fullscreen) takes the window out before it was shown: it lands on the
        // pointer's screen, and the hop notices and moves it onto its own.
        for (monitors, target, pointer) in cases() {
            let mut c = Compositor::new(monitors.clone(), pointer, (20, 60, 10));
            c.stray_at = Some(30);
            assert_eq!(
                land(&c, target, hop_tick),
                Landing { placed: Some(target), restores: 2, attempts: 2 },
                "{monitors:?}, target {target}, pointer {pointer}",
            );
            // The same stray, after the window was shown there already (the
            // hop is still waiting on its unproven delay when it is the screen
            // GDK guesses): nothing to undo.
            c.stray_at = Some(100);
            let out = land(&c, target, hop_tick);
            assert_eq!(out.placed, Some(target), "{monitors:?}, target {target}");
            assert_eq!(out.attempts, 1, "{monitors:?}, target {target}");
        }
    }

    #[test]
    fn a_hop_the_compositor_never_shows_gives_up_once_at_the_timeout() {
        let c = Compositor::new(layouts()[0].clone(), 0, (20, u64::MAX / 4, 0));
        let out = land(&c, 1, hop_tick);
        // It does not stay a fullscreen window: it leaves once, sized once, and
        // a give-up is not retried.
        assert_eq!((out.restores, out.attempts), (1, 1));
        assert!(out.placed.is_some());
    }

    fn view() -> HopView {
        use std::time::Duration;
        HopView {
            fullscreen: false,
            lost_fullscreen: false,
            answer: Some(0),
            guess: Some(0),
            elapsed: Duration::ZERO,
            settled: Duration::ZERO,
            mapped: true,
            retry_left: true,
        }
    }

    #[test]
    fn the_landing_is_checked_after_the_settle_and_retried_at_most_once() {
        use std::time::Duration;
        use HopAction::*;
        use MonitorHop::*;
        let late = Duration::from_secs(1);
        // Out of fullscreen on another screen than meant, but too soon to say.
        let v = HopView { settled: Duration::from_millis(100), ..view() };
        assert_eq!(hop_tick(Settling, v, 1), (Settling, Nothing));
        // Settled on the wrong screen: once more; on none left: done.
        let wrong = HopView { settled: late, ..view() };
        assert_eq!(hop_tick(Settling, wrong, 1), (Entering, Refullscreen));
        assert_eq!(hop_tick(Settling, HopView { retry_left: false, ..wrong }, 1), (Done, Nothing));
        // On the right screen, or hidden meanwhile (a re-fullscreen would
        // bring a parked window back fullscreen): done.
        assert_eq!(hop_tick(Settling, HopView { answer: Some(1), ..wrong }, 1), (Done, Nothing));
        assert_eq!(hop_tick(Settling, HopView { mapped: false, ..wrong }, 1), (Done, Nothing));
        assert_eq!(hop_tick(Settling, HopView { answer: None, ..wrong }, 1), (Done, Nothing));
    }

    #[test]
    fn a_fullscreen_lost_before_we_left_it_is_checked_not_waited_for() {
        use HopAction::*;
        use MonitorHop::*;
        let lost = HopView { lost_fullscreen: true, ..view() };
        assert_eq!(hop_tick(Entering, lost, 1), (Settling, RestoreSize));
        // Leaving it is our own doing: no check needed for the report itself.
        assert_eq!(hop_tick(Leaving, lost, 1), (Settling, RestoreSize));
        // Never fullscreen yet (the show is still on its way): wait.
        assert_eq!(hop_tick(Entering, view(), 1), (Entering, Nothing));
    }

    #[test]
    fn a_retry_trusts_gdks_answer_because_the_surface_has_entered_an_output() {
        use std::time::Duration;
        use HopAction::*;
        use MonitorHop::*;
        // Meant for the screen GDK guesses for an unentered surface: on the first
        // attempt the answer proves nothing before the delay...
        let first = HopView { fullscreen: true, answer: Some(0), guess: Some(0), ..view() };
        assert_eq!(hop_tick(Entering, first, 0), (Entering, Nothing));
        assert_eq!(
            hop_tick(Entering, HopView { elapsed: Duration::from_millis(700), ..first }, 0),
            (Leaving, Unfullscreen)
        );
        // ...on a retry (no guess) the answer coming round to it does.
        let retry = HopView { guess: None, ..first };
        assert_eq!(hop_tick(Entering, HopView { answer: Some(1), ..retry }, 0), (Entering, Nothing));
        assert_eq!(hop_tick(Entering, retry, 0), (Leaving, Unfullscreen));
    }

    #[test]
    fn a_timeout_gives_up_in_either_fullscreen_step_but_not_while_settling() {
        use std::time::Duration;
        use HopAction::*;
        use MonitorHop::*;
        let slow = HopView { elapsed: MONITOR_HOP_TIMEOUT + Duration::from_millis(1), ..view() };
        assert_eq!(hop_tick(Entering, slow, 1), (Done, GiveUp));
        assert_eq!(hop_tick(Leaving, slow, 1), (Done, GiveUp));
        assert_eq!(hop_tick(Done, slow, 1), (Done, Nothing));
        assert_eq!(hop_tick(Settling, slow, 1), (Settling, Nothing));
    }

    #[test]
    fn gdk_guesses_the_origin_monitor_for_a_surface_that_entered_none() {
        // Two external screens side by side: every unentered toplevel "is" on
        // the left one, whatever screen it is meant for.
        let two = [rect(0, 0, 2560, 1440), rect(2560, 0, 2560, 1440)];
        assert_eq!(gdk_fallback_monitor(900, 640, &two), Some(0));
        // Laptop panel right of the externals, listed first.
        let three = [rect(5120, 0, 1920, 1200), rect(0, 0, 2560, 1440), rect(2560, 0, 2560, 1440)];
        assert_eq!(gdk_fallback_monitor(900, 640, &three), Some(1));
        // Nothing covers the origin's window: the one holding its centre, or none.
        let offset = [rect(0, 400, 1920, 1080), rect(1920, 0, 1920, 1080)];
        assert_eq!(gdk_fallback_monitor(100, 100, &offset), None);
        assert_eq!(gdk_fallback_monitor(100, 900, &offset), Some(0));
    }

    #[test]
    fn only_an_answer_the_fallback_cannot_give_proves_the_screen_was_entered() {
        // Meant for the right screen, GDK still guesses the left: not shown.
        assert_eq!(entered_target(Some(0), Some(0), 1), Some(false));
        // GDK answers the right screen, which it never guesses: shown there.
        assert_eq!(entered_target(Some(1), Some(0), 1), Some(true));
        // Meant for the screen GDK guesses anyway: can't tell.
        assert_eq!(entered_target(Some(0), Some(0), 0), None);
        // Entered another screen: not shown on its own.
        assert_eq!(entered_target(Some(2), Some(0), 1), Some(false));
        assert_eq!(entered_target(None, None, 1), Some(false));
    }

    #[test]
    fn a_retired_popout_keeps_its_size_and_a_crashed_one_is_reported() {
        let mut reg = WindowRegistry::default();
        let bounds = crate::commands::apps::DetachedBounds {
            x: 0,
            y: 0,
            w: 700,
            h: 500,
            monitor: None,
        };
        for label in ["detached-p1-g-1", "detached-p1-g-2"] {
            reserve_detached_seq(&mut reg, label);
            reg.windows.insert(label.to_string(), tracked(label, Some(7)));
            reg.detached_bounds.insert(label.to_string(), bounds);
            reg.detached_minimized.insert(label.to_string());
        }
        reg.detached_retire.mark_retiring("detached-p1-g-1");
        // Planned: released, NOT reported, size kept for the respawn.
        assert_eq!(on_detached_destroyed(&mut reg, "detached-p1-g-1"), (Some(7), false));
        assert!(!reg.windows.contains_key("detached-p1-g-1"));
        assert!(!reg.detached_seqs.contains_key("detached-p1-g-1"));
        assert_eq!(reg.detached_bounds.get("detached-p1-g-1").map(|b| b.w), Some(700));
        // A crash / seed-timeout self-destroy: reported → the tabs dock back.
        assert_eq!(on_detached_destroyed(&mut reg, "detached-p1-g-2"), (Some(7), true));
        assert!(!reg.detached_bounds.contains_key("detached-p1-g-2"));
        // A reused label never inherits a minimized flag.
        assert!(reg.detached_minimized.is_empty());
    }

    fn two_scopes() -> WindowRegistry {
        let mut reg = WindowRegistry::default();
        for (label, scope) in [
            ("detached-A-g-1", "A"),
            ("detached-A-g-2", "A"),
            ("detached-B-g-1", "B"),
        ] {
            reg.windows.insert(label.to_string(), tracked_in(label, scope));
            // Every renderer has attached its retire listener.
            reg.detached_retire.mark_ready(label);
        }
        reg
    }

    #[test]
    fn a_popout_that_never_announced_itself_is_closed_without_asking() {
        let mut reg = two_scopes();
        // Still loading (or a pre-protocol renderer): no listener, no work.
        reg.detached_retire.forget("detached-A-g-2");
        let plan = plan_detached_sync(&mut reg, "B", false);
        let asked: Vec<&str> = plan.retire.iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(asked, vec!["detached-A-g-1"]);
        assert_eq!(plan.close, vec!["detached-A-g-2"]);
        assert!(reg.detached_retire.is_retiring("detached-A-g-2"));
        // Nothing is decided twice by a repeated sync.
        let again = plan_detached_sync(&mut reg, "B", false);
        assert!(again.retire.is_empty() && again.close.is_empty());
        // The scope returns before the main thread got to destroy it: withdrawn.
        plan_detached_sync(&mut reg, "A", false);
        assert!(!confirm_close(&mut reg, "detached-A-g-2"));
        assert!(!reg.detached_retire.is_retiring("detached-A-g-2"));
        // Readable positions never close anything.
        assert!(plan_detached_sync(&mut two_scopes(), "B", true).close.is_empty());
    }

    #[test]
    fn a_withdrawn_close_keeps_the_kept_popout_on_the_handshake() {
        // A ready popout answered clean, then its scope came back before the
        // destroy: the window stays, and it must still be ASKED next time — a
        // kept window may gather unsaved work.
        let mut reg = two_scopes();
        let plan = plan_detached_sync(&mut reg, "B", false);
        let (label, token) = plan.retire[0].clone();
        assert_eq!(settle_retire(&mut reg, &label, token, true), RetireOutcome::Close);
        plan_detached_sync(&mut reg, "A", false);
        assert!(!confirm_close(&mut reg, &label));
        assert!(reg.detached_retire.is_ready(&label));
        let next = plan_detached_sync(&mut reg, "B", false);
        assert!(next.retire.iter().any(|(l, _)| *l == label));
        assert!(!next.close.contains(&label));
    }

    #[test]
    fn a_clean_answer_closes_and_a_dirty_or_missing_one_minimizes() {
        let mut reg = two_scopes();
        let plan = plan_detached_sync(&mut reg, "B", false);
        let (l1, t1) = plan.retire[0].clone();
        let (l2, t2) = plan.retire[1].clone();
        assert_eq!(settle_retire(&mut reg, &l1, t1, true), RetireOutcome::Close);
        assert!(reg.detached_retire.is_retiring(&l1));
        assert!(confirm_close(&mut reg, &l1));
        assert_eq!(settle_retire(&mut reg, &l2, t2, false), RetireOutcome::Hide);
        assert!(reg.detached_parking.is_parked(&l2));
        assert!(confirm_park(&mut reg, &l2));
        // A second settle of the same request does nothing.
        assert_eq!(settle_retire(&mut reg, &l2, t2, false), RetireOutcome::Abandon);
    }

    #[test]
    fn a_sync_between_the_answer_and_the_minimize_keeps_the_popout_up() {
        // The race: A's popout answered dirty and was marked parked, then the
        // user switched back to A before the main thread minimized it.
        let mut reg = two_scopes();
        let plan = plan_detached_sync(&mut reg, "B", false);
        let (label, token) = plan.retire[0].clone();
        assert_eq!(settle_retire(&mut reg, &label, token, false), RetireOutcome::Hide);
        let back = plan_detached_sync(&mut reg, "A", false);
        // The sync sees the mark and presents it (clearing the mark) …
        assert!(back.show.contains(&label));
        reg.detached_parking.transition(&label, true);
        // … and the queued minimize, re-checking on the main thread, stands down.
        assert!(!confirm_park(&mut reg, &label));
        assert!(!reg.detached_parking.is_parked(&label));

        // Same race before the sync has presented it: the scope check alone
        // stands the minimize down and drops the stale mark.
        let mut reg = two_scopes();
        let plan = plan_detached_sync(&mut reg, "B", false);
        let (label, token) = plan.retire[0].clone();
        settle_retire(&mut reg, &label, token, false);
        reg.detached_active_scope = Some("A".into());
        assert!(!confirm_park(&mut reg, &label));
        assert!(!reg.detached_parking.is_parked(&label));
    }

    #[test]
    fn an_answer_arriving_after_the_scope_returned_is_abandoned() {
        let mut reg = two_scopes();
        let plan = plan_detached_sync(&mut reg, "B", false);
        let (label, token) = plan.retire[0].clone();
        // Back to A: the sync cancels the request, so the late answer finds no
        // live request (the one-lock settle never records a park or a close).
        plan_detached_sync(&mut reg, "A", false);
        assert_eq!(settle_retire(&mut reg, &label, token, false), RetireOutcome::Abandon);
        assert!(!reg.detached_parking.is_parked(&label));
        assert!(!reg.detached_retire.is_retiring(&label));
    }

    #[test]
    fn readable_positions_keep_the_hide_show_park() {
        let mut reg = two_scopes();
        let plan = plan_detached_sync(&mut reg, "B", true);
        assert_eq!(plan.hide, vec!["detached-A-g-1", "detached-A-g-2"]);
        assert_eq!(plan.show, vec!["detached-B-g-1"]);
        assert!(plan.retire.is_empty());
        assert_eq!(reg.detached_active_scope.as_deref(), Some("B"));
    }

    #[test]
    fn wayland_retires_the_outgoing_scope_and_hides_nothing() {
        let mut reg = two_scopes();
        let plan = plan_detached_sync(&mut reg, "B", false);
        assert!(plan.hide.is_empty());
        assert!(plan.show.is_empty());
        let labels: Vec<&str> = plan.retire.iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(labels, vec!["detached-A-g-1", "detached-A-g-2"]);
        // A repeated sync to the same scope does not ask twice.
        assert!(plan_detached_sync(&mut reg, "B", false).retire.is_empty());
        // Back to A before they answered: their requests are cancelled, and
        // B's popout is now the one asked.
        let back = plan_detached_sync(&mut reg, "A", false);
        for (label, token) in &plan.retire {
            assert!(!reg.detached_retire.take(label, *token));
        }
        let labels: Vec<&str> = back.retire.iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(labels, vec!["detached-B-g-1"]);
    }

    #[test]
    fn wayland_presents_only_what_the_unsaved_work_fallback_minimized() {
        let mut reg = two_scopes();
        reg.detached_parking.transition("detached-A-g-2", false);
        let plan = plan_detached_sync(&mut reg, "B", false);
        // The minimized one is not asked again while away …
        let labels: Vec<&str> = plan.retire.iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(labels, vec!["detached-A-g-1"]);
        // … and is the one presented on return.
        let back = plan_detached_sync(&mut reg, "A", false);
        assert_eq!(back.show, vec!["detached-A-g-2"]);
    }

    #[test]
    fn release_without_native_id_still_frees_the_number() {
        // A popout whose native id never resolved (e.g. macOS) must still give
        // its display number back.
        let mut reg = WindowRegistry::default();
        let label = "detached-p1-g-1";
        reserve_detached_seq(&mut reg, label);
        reg.windows.insert(label.to_string(), tracked(label, None));
        assert_eq!(release_detached_entry(&mut reg, label), None);
        assert_eq!(reserve_detached_seq(&mut reg, "detached-p1-g-2"), 1);
    }

    #[test]
    fn missing_or_invalid_geometry_keeps_the_default() {
        // A partial position is ignored (WM places the window).
        assert!(detached_position(Some(10.0), None).is_none());
        assert!(detached_position(None, Some(10.0)).is_none());
        assert!(detached_position(None, None).is_none());
        // Non-positive or partial size keeps the logical default — never a 0×0 or
        // negative window from a stale/garbage payload.
        assert!(detached_size(Some(0.0), Some(640.0)).is_none());
        assert!(detached_size(Some(900.0), Some(0.0)).is_none());
        assert!(detached_size(Some(900.0), Some(-1.0)).is_none());
        assert!(detached_size(None, Some(640.0)).is_none());
        assert!(detached_size(Some(900.0), None).is_none());
    }

    #[test]
    fn a_wayland_restart_respawns_on_the_screen_the_layout_kept() {
        let right = rect(2560, 0, 2560, 1440);
        let (b, id) = restart_bounds(false, Some(900.0), Some(640.0), Some(right), None).expect("a record");
        assert_eq!((b.w, b.h, b.monitor, id), (900, 640, Some(right), 0));
        // Readable positions: the saved rect places it, no screen record.
        assert!(restart_bounds(true, Some(900.0), Some(640.0), Some(right), None).is_none());
        // No screen kept (an older layout) or no real size: the plain respawn.
        assert!(restart_bounds(false, Some(900.0), Some(640.0), None, None).is_none());
        assert!(restart_bounds(false, Some(0.0), Some(640.0), Some(right), None).is_none());
        assert!(restart_bounds(false, None, Some(640.0), Some(right), None).is_none());
        assert!(restart_bounds(false, Some(900.0), Some(640.0), Some(rect(0, 0, 0, 0)), None).is_none());
    }

    fn kept(x: i32, w: u32, id: u64, size: (u32, u32)) -> popout_screen::KeptScreen {
        popout_screen::KeptScreen::new(Screen { rect: rect(x, 0, w, 1440), id }, size, 1)
    }

    #[test]
    fn a_restart_prefers_the_screen_the_machine_kept_over_the_layouts() {
        // The signal path never saved the layout's screen; the kept file has
        // it (with the monitor's identity). It outranks an older layout value
        // and supplies the size when the layout has none.
        let (layout, file) = (rect(0, 0, 1920, 1080), kept(2560, 2560, 9, (1200, 800)));
        let (b, id) = restart_bounds(false, Some(900.0), Some(640.0), Some(layout), Some(file)).unwrap();
        assert_eq!((b.monitor, b.w, b.h, id), (Some(rect(2560, 0, 2560, 1440)), 900, 640, 9));
        let (b, _) = restart_bounds(false, None, None, Some(layout), Some(file)).unwrap();
        assert_eq!((b.w, b.h), (1200, 800));
        // Nothing in the layout at all (an upgrade, a layout that never saw a
        // quit): the kept file alone is enough.
        assert!(restart_bounds(false, None, None, None, Some(file)).is_some());
        // A kept entry without a usable screen falls back to the layout's.
        let bad = popout_screen::KeptScreen { w: 0, ..file };
        let (b, id) = restart_bounds(false, Some(900.0), Some(640.0), Some(layout), Some(bad)).unwrap();
        assert_eq!((b.monitor, id), (Some(layout), 0));
    }

    fn registry_with_record(label: &str, screen: Screen) -> WindowRegistry {
        let mut reg = WindowRegistry::default();
        reg.detached_bounds.insert(
            label.to_string(),
            DetachedBounds { x: 0, y: 0, w: 900, h: 640, monitor: Some(screen.rect) },
        );
        reg.detached_screens.set_id(label, screen.id);
        reg
    }

    #[test]
    fn a_verdict_that_kept_the_screen_keeps_the_record_and_takes_the_settled_size() {
        let (label, good) = ("detached-p1-g-1", Screen { rect: rect(1920, 0, 1920, 1080), id: 7 });
        let mut reg = registry_with_record(label, good);
        // Not settled: nothing at all changes (the fullscreen size included).
        let unsettled = Verdict { why: Why::Unsettled, screen: None, size: None };
        assert!(!apply_verdict(&mut reg, label, &unsettled));
        let b = reg.detached_bounds[label];
        assert_eq!((b.w, b.h, b.monitor), (900, 640, Some(good.rect)));
        // It landed elsewhere: the wanted screen stays, the size is the window's.
        let landed = Verdict { why: Why::LandedElsewhere, screen: None, size: Some((1000, 700)) };
        assert!(!apply_verdict(&mut reg, label, &landed));
        let b = reg.detached_bounds[label];
        assert_eq!((b.w, b.h, b.monitor), (1000, 700, Some(good.rect)));
        assert_eq!(reg.detached_screens.id(label), 7);
        // The user moved it: the record follows, identity included.
        let there = Screen { rect: rect(0, 0, 1920, 1080), id: 3 };
        let moved = Verdict { why: Why::UserMoved, screen: Some(there), size: Some((1000, 700)) };
        assert!(apply_verdict(&mut reg, label, &moved));
        assert_eq!(reg.detached_bounds[label].monitor, Some(there.rect));
        assert_eq!(reg.detached_screens.id(label), 3);
    }

    #[test]
    fn a_retire_keeps_the_screen_identity_with_the_record_and_a_release_drops_both() {
        let (label, good) = ("detached-p1-g-1", Screen { rect: rect(1920, 0, 1920, 1080), id: 7 });
        let mut reg = registry_with_record(label, good);
        reg.windows.insert(label.to_string(), tracked(label, None));
        reg.detached_retire.mark_retiring(label);
        on_detached_destroyed(&mut reg, label);
        assert_eq!(recorded_screen(&reg, label), Some(good));
        reg.detached_retire.mark_retiring(label);
        reg.windows.insert(label.to_string(), tracked(label, None));
        release_detached_entry(&mut reg, label);
        assert_eq!(recorded_screen(&reg, label), None);
        assert_eq!(reg.detached_screens.id(label), 0);
    }

    #[test]
    fn the_placement_mark_is_the_registrys() {
        let mut reg = WindowRegistry::default();
        let label = "detached-p1-g-1";
        assert!(!reg.is_detached_placing(label));
        reg.set_detached_placing(label, true);
        assert!(reg.is_detached_placing(label));
        reg.set_detached_placing(label, false);
        assert!(!reg.is_detached_placing(label));
        reg.set_detached_placing(label, true);
        release_detached_entry(&mut reg, label);
        assert!(!reg.is_detached_placing(label));
    }

    #[test]
    fn a_wayland_respawn_applies_the_saved_size_and_never_a_position() {
        // x/y are (0,0) filler there; fitting them against the monitors shrank a
        // big popout to the origin monitor's size.
        let (pos, size) = wayland_detached_fit(Some(3000.0), Some(1800.0));
        assert!(pos.is_none());
        match size {
            Some(Size::Physical(s)) => assert_eq!((s.width, s.height), (3000, 1800)),
            other => panic!("expected the saved physical size, got {other:?}"),
        }
        let partial = wayland_detached_fit(None, Some(10.0));
        assert!(partial.0.is_none() && partial.1.is_none());
    }
}
