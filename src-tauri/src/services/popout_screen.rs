//! Which screen a native-Wayland popout belongs on, and when what the toolkit
//! says about it may become that record.
//!
//! A Wayland client cannot read where its window is, only which output its
//! surface last entered (GDK's `monitor_at_window`). That answer is a fact only
//! for a window the compositor has shown, finished placing and left alone for a
//! moment: for a window that entered no output GDK answers with a geometric
//! guess (the origin monitor), mid-placement it answers the fullscreen hop's
//! screen, and a retired or hidden window answers nothing. So the record of
//! "the screen this popout was last truly shown on" is kept apart from the
//! readings, and a reading becomes the record only through [`PopoutScreens::observe`]:
//!
//! - not shown, fullscreen, placing ([`PopoutScreens::set_placing`]) or not yet
//!   settled: the previous record stands (a fast A to B to A, a window retired
//!   mid-hop, a size read while it was fullscreen);
//! - the first settled reading after a landing is a BASELINE, not a choice: a
//!   window that landed elsewhere than asked keeps the wanted screen;
//! - a later settled reading that differs from the baseline is the user's own
//!   move (or an unplug moving it): that is the new record.
//!
//! The record also survives a crash or a signal: it is kept in a small file in
//! the state dir ([`KeptScreen`]) when it changes, off the GTK thread, because
//! the saved layout is only written by the window's clean quit.
//!
//! Pure and `AppHandle`-free so the rules are unit-tested on any OS; the GDK
//! reads live in `commands::subwindow`.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::services::ordered_lane::OrderedLane;
use crate::services::window_state::MonitorRect;

/// How long a window must have sat un-placed, shown and not fullscreen before a
/// reading of it counts. Longer than the compositor's reply to an unfullscreen
/// plus the size restore and the first-paint nudge.
pub const SETTLE: Duration = Duration::from_millis(1500);

/// A placement mark older than this is treated as lost (a hop that never
/// cleared it), so a missing clear can never freeze the record for good. The
/// hop itself gives up after 4 s.
pub const PLACING_MAX: Duration = Duration::from_secs(10);

/// The most popouts the kept-screens file remembers.
const KEPT_MAX: usize = 64;

/// A screen: GDK's logical rect plus a stable hash of its make and model.
/// The rect changes with a resolution, scale or arrangement change; the id
/// does not. `id` 0 = unknown (an older record, or GDK could not say).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Screen {
    pub rect: MonitorRect,
    pub id: u64,
}

/// FNV-1a over `manufacturer`, a separator and `model`. 0 when neither is
/// known, which is how "unknown" is spelled everywhere here.
pub fn identity_hash(manufacturer: Option<&str>, model: Option<&str>) -> u64 {
    let (m, n) = (
        manufacturer.map(str::trim).unwrap_or_default(),
        model.map(str::trim).unwrap_or_default(),
    );
    if m.is_empty() && n.is_empty() {
        return 0;
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in m.bytes().chain(std::iter::once(0)).chain(n.bytes()) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    // 0 is reserved for "unknown".
    h.max(1)
}

/// Whether two readings name the same monitor: the same make and model when
/// both are known (a resolution or scale change moves the rect, not the
/// monitor), else the same rect. `twins`: another connected monitor has that
/// make and model too, so only the rect tells them apart.
pub fn same_screen(a: &Screen, b: &Screen, twins: bool) -> bool {
    if a.id != 0 && b.id != 0 {
        a.id == b.id && (!twins || a.rect == b.rect)
    } else {
        a.rect == b.rect
    }
}

/// The live monitor `wanted` names, by index into `live`.
///
/// 1. Its make and model, when known on both sides. One match is the answer
///    (whatever its rect says now); several (identical monitors) take the one
///    whose rect is equal, else the nearest origin.
/// 2. A wanted screen whose make and model nothing connected carries is gone,
///    unless some live monitor's identity is unknown: then by rect.
/// 3. No identity (an older record): by rect.
///
/// `None` = gone; the caller falls back to the main window's screen.
pub fn match_monitor(wanted: &Screen, live: &[Screen]) -> Option<usize> {
    let by_rect = |only_unknown: bool| {
        live.iter()
            .position(|m| m.rect == wanted.rect && (!only_unknown || m.id == 0))
    };
    if wanted.id == 0 {
        return by_rect(false);
    }
    let same: Vec<usize> = (0..live.len()).filter(|&i| live[i].id == wanted.id).collect();
    match same.as_slice() {
        [] => by_rect(true),
        [one] => Some(*one),
        many => many
            .iter()
            .copied()
            .find(|&i| live[i].rect == wanted.rect)
            .or_else(|| {
                many.iter().copied().min_by_key(|&i| {
                    i64::from(live[i].rect.x - wanted.rect.x).abs()
                        + i64::from(live[i].rect.y - wanted.rect.y).abs()
                })
            }),
    }
}

/// What the client can see of one popout at one look.
#[derive(Debug, Clone, Copy)]
pub struct View {
    /// Visible and mapped.
    pub shown: bool,
    /// GTK's FULLSCREEN state.
    pub fullscreen: bool,
    /// The output GDK says the surface is on, with its identity.
    pub seen: Option<Screen>,
    /// Another connected monitor has `seen`'s make and model ([`same_screen`]).
    pub twins: bool,
    /// `inner_size` now.
    pub size: Option<(u32, u32)>,
}

/// Why [`PopoutScreens::observe`] answered as it did (for the trace line).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// Hidden, unmapped or unreadable: nothing is known.
    NotShown,
    /// Fullscreen: the hop's screen and size, not the window's own.
    Fullscreen,
    /// A placement is under way.
    Placing,
    /// Placed (or built) less than [`SETTLE`] ago.
    Unsettled,
    /// No record yet: this reading is the first.
    First,
    /// Where the baseline (or record) says; the rect is refreshed.
    Unchanged,
    /// It landed on another screen than the record and has not been moved
    /// since: the record keeps the wanted screen.
    LandedElsewhere,
    /// It left the screen it settled on: the user's own move.
    UserMoved,
}

/// What to record after one look. `None` = leave that part of the record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Verdict {
    pub why: Why,
    pub screen: Option<Screen>,
    pub size: Option<(u32, u32)>,
}

impl Verdict {
    fn keep(why: Why) -> Self {
        Self { why, screen: None, size: None }
    }
}

#[derive(Debug, Clone, Copy)]
struct Track {
    /// When the window was built or its last placement ended.
    since: Instant,
    /// When the placement mark was set; `None` = not placing.
    placing_since: Option<Instant>,
    /// Where it sat at its first settled reading after landing.
    baseline: Option<Screen>,
}

/// Per-popout placement bookkeeping, keyed by window label.
#[derive(Default)]
pub struct PopoutScreens {
    tracks: HashMap<String, Track>,
    /// The identity of each label's recorded screen. Kept across a retire (the
    /// record is), dropped with the window's entry.
    ids: HashMap<String, u64>,
}

impl PopoutScreens {
    /// A window was built for `label`: nothing it shows counts until it settles.
    pub fn built(&mut self, label: &str, now: Instant) {
        self.tracks.insert(
            label.to_string(),
            Track { since: now, placing_since: None, baseline: None },
        );
    }

    /// Mark a placement begun (`true`) or finished (`false`). Either way the
    /// window must settle again, and its landing is a new baseline.
    pub fn set_placing(&mut self, label: &str, placing: bool, now: Instant) {
        let t = self.tracks.entry(label.to_string()).or_insert(Track {
            since: now,
            placing_since: None,
            baseline: None,
        });
        t.placing_since = placing.then_some(now);
        t.since = now;
        t.baseline = None;
    }

    pub fn is_placing(&self, label: &str, now: Instant) -> bool {
        self.tracks
            .get(label)
            .and_then(|t| t.placing_since)
            .is_some_and(|since| now.saturating_duration_since(since) < PLACING_MAX)
    }

    /// The recorded screen's identity (0 = unknown).
    pub fn id(&self, label: &str) -> u64 {
        self.ids.get(label).copied().unwrap_or(0)
    }

    pub fn set_id(&mut self, label: &str, id: u64) {
        if id == 0 {
            self.ids.remove(label);
        } else {
            self.ids.insert(label.to_string(), id);
        }
    }

    /// The window is gone for good (or retired: the caller re-seeds the id).
    pub fn release(&mut self, label: &str) {
        self.tracks.remove(label);
        self.ids.remove(label);
    }

    /// Decide what one look at `label` changes in its record. `recorded` is the
    /// current record. Pure over `self`'s per-label state (the baseline moves).
    pub fn observe(
        &mut self,
        label: &str,
        now: Instant,
        view: View,
        recorded: Option<Screen>,
    ) -> Verdict {
        if !view.shown || view.seen.is_none() {
            return Verdict::keep(Why::NotShown);
        }
        if view.fullscreen {
            return Verdict::keep(Why::Fullscreen);
        }
        if self.is_placing(label, now) {
            return Verdict::keep(Why::Placing);
        }
        let t = self.tracks.entry(label.to_string()).or_insert(Track {
            since: now,
            placing_since: None,
            baseline: None,
        });
        if now.saturating_duration_since(t.since) < SETTLE {
            return Verdict::keep(Why::Unsettled);
        }
        let Some(seen) = view.seen else {
            return Verdict::keep(Why::NotShown);
        };
        let size = view.size;
        let (previous, baseline) = (recorded, t.baseline);
        t.baseline = Some(seen);
        let moved = baseline.is_some_and(|b| !same_screen(&b, &seen, view.twins));
        let (why, screen) = match (previous, moved) {
            (None, _) => (Why::First, Some(seen)),
            (Some(_), true) => (Why::UserMoved, Some(seen)),
            (Some(p), false) if same_screen(&p, &seen, view.twins) => (Why::Unchanged, Some(seen)),
            (Some(_), false) => (Why::LandedElsewhere, None),
        };
        Verdict { why, screen, size }
    }
}

// ── The kept file ──────────────────────────────────────────────────────────

/// One popout's screen and size as the kept file holds it. `id`, `at` default,
/// so a file from before they existed (or by hand) still loads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KeptScreen {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub id: u64,
    /// The popout's size on that screen.
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    /// Seconds since the epoch of the last change (oldest are dropped first).
    #[serde(default)]
    pub at: u64,
}

impl KeptScreen {
    pub fn new(screen: Screen, size: (u32, u32), at: u64) -> Self {
        Self {
            x: screen.rect.x,
            y: screen.rect.y,
            w: screen.rect.w,
            h: screen.rect.h,
            id: screen.id,
            width: size.0,
            height: size.1,
            at,
        }
    }

    pub fn screen(&self) -> Option<Screen> {
        (self.w > 0 && self.h > 0).then_some(Screen {
            rect: MonitorRect { x: self.x, y: self.y, w: self.w, h: self.h },
            id: self.id,
        })
    }
}

/// `<state_dir>/detached-screens.json`.
pub fn kept_path() -> PathBuf {
    crate::storage::state_dir().join("detached-screens.json")
}

/// The kept record for `label`; missing or unreadable file = none.
pub fn load_kept(path: &Path, label: &str) -> Option<KeptScreen> {
    crate::storage::read_json::<BTreeMap<String, KeptScreen>>(path)
        .ok()?
        .remove(label)
}

/// Insert (`Some`) or drop (`None`) one label, keeping at most [`KEPT_MAX`]
/// entries (the oldest go). A file that does not parse is left untouched.
pub fn patch_kept(path: &Path, label: &str, kept: Option<KeptScreen>) -> Result<(), String> {
    crate::storage::patch_json(path, BTreeMap::<String, KeptScreen>::new(), |m| {
        match kept {
            Some(k) => {
                m.insert(label.to_string(), k);
            }
            None => {
                m.remove(label);
            }
        }
        while m.len() > KEPT_MAX {
            let Some(oldest) = m.iter().min_by_key(|(_, k)| k.at).map(|(l, _)| l.clone()) else {
                break;
            };
            m.remove(&oldest);
        }
        Ok(())
    })
}

/// Writes of the kept file go through one worker: never on the GTK thread, in
/// the order they were made.
static LANE: OrderedLane = OrderedLane::new("popout-screens");

/// Queue `label`'s record (or its removal) for the kept file.
pub fn persist(label: &str, kept: Option<KeptScreen>) {
    let label = label.to_string();
    LANE.run(move || {
        if let Err(e) = patch_kept(&kept_path(), &label, kept) {
            eprintln!("popout {label}: kept screen not saved: {e}");
        }
    });
}

/// Let queued writes land before the process exits. Bounded.
pub fn drain_at_exit() {
    if !LANE.drain(Duration::from_secs(2)) {
        eprintln!("popout screens still being saved at exit; the last one may be lost");
    }
}

/// Seconds since the epoch, for [`KeptScreen::at`].
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, w: u32, h: u32) -> MonitorRect {
        MonitorRect { x, y, w, h }
    }
    fn scr(x: i32, id: u64) -> Screen {
        Screen { rect: rect(x, 0, 1920, 1080), id }
    }
    fn view(seen: Screen) -> View {
        View { shown: true, fullscreen: false, seen: Some(seen), twins: false, size: Some((900, 640)) }
    }
    const LABEL: &str = "detached-p1-g-1";

    /// A tracker whose window was built at `t0`, plus a clock helper.
    fn built() -> (PopoutScreens, Instant) {
        let t0 = Instant::now();
        let mut p = PopoutScreens::default();
        p.built(LABEL, t0);
        (p, t0)
    }
    fn later(t0: Instant, ms: u64) -> Instant {
        t0 + Duration::from_millis(ms)
    }

    #[test]
    fn a_window_that_has_not_settled_never_replaces_the_record() {
        // The fast A to B to A / early-return / retired-mid-hop cases: GDK's
        // answer for a window built a moment ago is its geometric guess (the
        // origin monitor); it must not overwrite the good record.
        let (mut p, t0) = built();
        let good = scr(1920, 7);
        let guess = scr(0, 3);
        let v = p.observe(LABEL, later(t0, 200), view(guess), Some(good));
        assert_eq!((v.why, v.screen, v.size), (Why::Unsettled, None, None));
        // Settled, it is believed (and being a first reading it is a baseline,
        // so the wanted screen still stands over a landing elsewhere).
        let v = p.observe(LABEL, later(t0, 2000), view(guess), Some(good));
        assert_eq!(v.why, Why::LandedElsewhere);
        assert_eq!(v.screen, None);
    }

    #[test]
    fn a_window_in_placement_or_fullscreen_or_hidden_keeps_the_record() {
        let (mut p, t0) = built();
        let good = scr(1920, 7);
        p.set_placing(LABEL, true, later(t0, 10));
        let v = p.observe(LABEL, later(t0, 5000), view(scr(0, 3)), Some(good));
        assert_eq!((v.why, v.screen, v.size), (Why::Placing, None, None));
        // The mark expires, so a hop that never cleared it cannot freeze the record.
        assert!(p.is_placing(LABEL, later(t0, 5000)));
        assert!(!p.is_placing(LABEL, later(t0, 10 + 10_000)));
        p.set_placing(LABEL, false, later(t0, 6000));
        // Just placed: unsettled.
        let v = p.observe(LABEL, later(t0, 6100), view(good), Some(good));
        assert_eq!(v.why, Why::Unsettled);
        // Fullscreen (the hop's own) and not shown read nothing at all.
        let fs = View { fullscreen: true, ..view(good) };
        assert_eq!(p.observe(LABEL, later(t0, 9000), fs, Some(good)).why, Why::Fullscreen);
        let hidden = View { shown: false, ..view(good) };
        assert_eq!(p.observe(LABEL, later(t0, 9000), hidden, Some(good)).why, Why::NotShown);
        let blind = View { seen: None, ..view(good) };
        assert_eq!(p.observe(LABEL, later(t0, 9000), blind, Some(good)).why, Why::NotShown);
    }

    #[test]
    fn the_size_is_not_taken_while_the_window_is_not_settled() {
        let (mut p, t0) = built();
        let good = scr(0, 7);
        let fs = View { fullscreen: true, size: Some((2560, 1440)), ..view(good) };
        assert_eq!(p.observe(LABEL, later(t0, 5000), fs, Some(good)).size, None);
        p.set_placing(LABEL, true, later(t0, 5000));
        assert_eq!(p.observe(LABEL, later(t0, 5100), view(good), Some(good)).size, None);
        p.set_placing(LABEL, false, later(t0, 5200));
        assert_eq!(p.observe(LABEL, later(t0, 5300), view(good), Some(good)).size, None);
        let v = p.observe(LABEL, later(t0, 7000), view(good), Some(good));
        assert_eq!(v.size, Some((900, 640)));
    }

    #[test]
    fn the_first_reading_ever_is_the_record() {
        let (mut p, t0) = built();
        let here = scr(1920, 7);
        let v = p.observe(LABEL, later(t0, 2000), view(here), None);
        assert_eq!((v.why, v.screen), (Why::First, Some(here)));
    }

    #[test]
    fn a_wrong_landing_does_not_become_the_choice_but_the_users_move_does() {
        let (mut p, t0) = built();
        let wanted = scr(1920, 7);
        let landed = scr(0, 3);
        let other = scr(3840, 9);
        p.set_placing(LABEL, true, later(t0, 10));
        p.set_placing(LABEL, false, later(t0, 900));
        // It settled on the wrong screen: the wanted one stands, every look.
        for ms in [3000, 4000, 9000] {
            let v = p.observe(LABEL, later(t0, ms), view(landed), Some(wanted));
            assert_eq!((v.why, v.screen), (Why::LandedElsewhere, None));
        }
        // The user drags it to a third screen: that is the choice now.
        let v = p.observe(LABEL, later(t0, 10_000), view(other), Some(wanted));
        assert_eq!((v.why, v.screen), (Why::UserMoved, Some(other)));
        // ... and dragging it back onto the screen it first landed on counts too.
        let v = p.observe(LABEL, later(t0, 11_000), view(landed), Some(other));
        assert_eq!((v.why, v.screen), (Why::UserMoved, Some(landed)));
    }

    #[test]
    fn a_window_that_landed_right_follows_the_user_off_it_and_back() {
        let (mut p, t0) = built();
        let wanted = scr(1920, 7);
        let v = p.observe(LABEL, later(t0, 2000), view(wanted), Some(wanted));
        assert_eq!((v.why, v.screen), (Why::Unchanged, Some(wanted)));
        let away = scr(0, 3);
        let v = p.observe(LABEL, later(t0, 3000), view(away), Some(wanted));
        assert_eq!((v.why, v.screen), (Why::UserMoved, Some(away)));
    }

    #[test]
    fn a_drag_between_identical_monitors_is_a_move() {
        let (mut p, t0) = built();
        let (left, right) = (scr(0, 7), scr(1920, 7));
        let twin = |s| View { twins: true, ..view(s) };
        p.observe(LABEL, later(t0, 2000), twin(left), Some(left));
        let v = p.observe(LABEL, later(t0, 3000), twin(right), Some(left));
        assert_eq!((v.why, v.screen), (Why::UserMoved, Some(right)));
    }

    #[test]
    fn a_new_placement_starts_a_new_baseline() {
        let (mut p, t0) = built();
        let (a, b) = (scr(0, 3), scr(1920, 7));
        // Settled on A, user-chosen.
        p.observe(LABEL, later(t0, 2000), view(a), None);
        // Retired and shown again, wanting A, landing on B: A stands.
        p.set_placing(LABEL, true, later(t0, 3000));
        p.set_placing(LABEL, false, later(t0, 3500));
        let v = p.observe(LABEL, later(t0, 6000), view(b), Some(a));
        assert_eq!((v.why, v.screen), (Why::LandedElsewhere, None));
    }

    #[test]
    fn a_resolution_change_is_not_a_move_and_refreshes_the_rect() {
        let (mut p, t0) = built();
        let old = Screen { rect: rect(1920, 0, 1920, 1080), id: 7 };
        let new = Screen { rect: rect(1920, 0, 2560, 1440), id: 7 };
        p.observe(LABEL, later(t0, 2000), view(old), Some(old));
        let v = p.observe(LABEL, later(t0, 3000), view(new), Some(old));
        assert_eq!((v.why, v.screen), (Why::Unchanged, Some(new)));
    }

    #[test]
    fn the_hash_is_stable_and_zero_means_unknown() {
        assert_eq!(identity_hash(None, None), 0);
        assert_eq!(identity_hash(Some(" "), Some("")), 0);
        let a = identity_hash(Some("DEL"), Some("U2720Q"));
        assert_ne!(a, 0);
        assert_eq!(a, identity_hash(Some("DEL"), Some("U2720Q")));
        assert_ne!(a, identity_hash(Some("DELU"), Some("2720Q")));
        assert_ne!(a, identity_hash(None, Some("U2720Q")));
    }

    #[test]
    fn a_monitor_is_found_again_after_its_resolution_or_scale_changed() {
        // The geometry-equality lookup lost it and fell to the main window's.
        let wanted = Screen { rect: rect(1920, 0, 1920, 1080), id: 7 };
        let live = [scr(0, 3), Screen { rect: rect(1920, 0, 2560, 1440), id: 7 }];
        assert_eq!(match_monitor(&wanted, &live), Some(1));
        // Rearranged: the same monitor now sits to the left.
        let live = [Screen { rect: rect(0, 0, 1920, 1080), id: 7 }, Screen { rect: rect(1920, 0, 1920, 1080), id: 3 }];
        assert_eq!(match_monitor(&wanted, &live), Some(0));
    }

    #[test]
    fn identical_monitors_are_told_apart_by_their_rect() {
        let wanted = Screen { rect: rect(1920, 0, 1920, 1080), id: 7 };
        let live = [scr(0, 7), scr(1920, 7)];
        assert_eq!(match_monitor(&wanted, &live), Some(1));
        // Rearranged: nearest origin.
        let wanted = Screen { rect: rect(1900, 0, 1920, 1080), id: 7 };
        assert_eq!(match_monitor(&wanted, &[scr(0, 7), scr(1920, 7)]), Some(1));
    }

    #[test]
    fn a_gone_monitor_is_not_mistaken_for_another_at_its_position() {
        let wanted = scr(1920, 7);
        // Another monitor sits where it was: not the same monitor.
        assert_eq!(match_monitor(&wanted, &[scr(0, 3), scr(1920, 9)]), None);
        // GDK could not name a live one: the rect decides.
        assert_eq!(match_monitor(&wanted, &[scr(0, 3), scr(1920, 0)]), Some(1));
    }

    #[test]
    fn a_record_without_identity_matches_by_rect_as_before() {
        let wanted = scr(1920, 0);
        assert_eq!(match_monitor(&wanted, &[scr(0, 3), scr(1920, 9)]), Some(1));
        assert_eq!(match_monitor(&wanted, &[scr(0, 3), scr(3840, 9)]), None);
    }

    #[test]
    fn the_kept_file_loads_an_older_shape_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("popout-screens-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("detached-screens.json");
        // Only the fields the first version could have had.
        std::fs::write(&path, r#"{"a":{"x":0,"y":0,"w":1920,"h":1080}}"#).unwrap();
        let old = load_kept(&path, "a").expect("an older entry loads");
        assert_eq!((old.id, old.width, old.at), (0, 0, 0));
        let screen = Screen { rect: rect(1920, 0, 2560, 1440), id: 11 };
        patch_kept(&path, "b", Some(KeptScreen::new(screen, (900, 640), 5))).unwrap();
        let b = load_kept(&path, "b").unwrap();
        assert_eq!((b.screen(), b.width, b.height), (Some(screen), 900, 640));
        assert!(load_kept(&path, "a").is_some(), "another label survives a patch");
        patch_kept(&path, "a", None).unwrap();
        assert!(load_kept(&path, "a").is_none());
        // Beyond the cap the oldest go.
        for i in 0..(KEPT_MAX as u64 + 5) {
            patch_kept(&path, &format!("w{i}"), Some(KeptScreen::new(screen, (1, 1), 100 + i))).unwrap();
        }
        assert!(load_kept(&path, "w0").is_none() && load_kept(&path, "b").is_none());
        assert!(load_kept(&path, &format!("w{}", KEPT_MAX as u64 + 4)).is_some());
        // A garbled file is left alone, not replaced.
        std::fs::write(&path, "not json").unwrap();
        assert!(patch_kept(&path, "c", Some(KeptScreen::new(screen, (1, 1), 1))).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_degenerate_kept_screen_is_no_screen() {
        let k = KeptScreen { x: 0, y: 0, w: 0, h: 1080, id: 0, width: 1, height: 1, at: 0 };
        assert!(k.screen().is_none());
    }
}
