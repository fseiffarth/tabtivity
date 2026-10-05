//! The presentation windows: the deck presenter's **audience window** (TODO
//! M#90, `docs/deck_presenter_plan.md`) and the PDF viewer's **fullscreen present
//! window** (`src/components/embed/pdf/present.ts`).
//!
//! A talk wants two surfaces: the slide the room sees, and the notes/timer the
//! speaker sees. The second one is an OS window rendering the same React bundle
//! under `?present=<label>`, which the frontend drives entirely over Tauri events
//! (`src/lib/viewers/deck/present.ts`) — this module only opens it, puts it on
//! the right monitor, and closes it. The PDF present window is that same window
//! under a `present-pdf-` label, and differs in the one thing this module decides:
//! it asks to be fullscreen even on a single-monitor machine. A talk keeps a
//! notes view on the laptop, so an audience window has somewhere else to be; a PDF
//! shown fullscreen has not — the screen becoming the sheet IS the button.
//!
//! Deliberately NOT a detached subwindow (#42): a popout is a tab group with a
//! layout, a seed protocol, dock-back, parking and persistence. None of that
//! applies here — an audience window has no tabs, must survive nothing, and above
//! all must **not be parked**: `project_runtime::switch` hides a project-owned
//! window when its project goes inactive, which mid-talk would blank the
//! projector. So it is registered nowhere and owned only by the presenter that
//! opened it.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

/// A monitor's placement, in physical desktop px — the shape both the real
/// `tauri::Monitor` and the unit tests reduce to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Whether `label` is one this command may open.
///
/// The label comes from the frontend and becomes both a window label and a URL
/// query value, so it is validated rather than trusted. The `present-` prefix is
/// also what `capabilities/default.json` grants window permissions by, so a
/// label outside this shape would open a window that cannot call anything.
pub fn valid_presenter_label(label: &str) -> bool {
    label.len() <= 64
        && label.starts_with("present-")
        && label.len() > "present-".len()
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The query the audience renderer reads.
pub fn presenter_query(label: &str) -> String {
    format!("index.html?present={label}")
}

/// Which monitor the audience window should take over, if any.
///
/// The whole point of the feature is "audience there, notes here", so a single
/// monitor yields `None` — the window then opens ordinary and windowed, which the
/// speaker can drag wherever they like. With two or more, take the first monitor
/// that is not the one the main window is on. `main` unknown falls back to the
/// *second* monitor rather than the first: the first is nearly always the
/// built-in panel the presenter is sitting at.
pub fn choose_audience_monitor(
    monitors: &[MonitorRect],
    main: Option<MonitorRect>,
) -> Option<MonitorRect> {
    if monitors.len() < 2 {
        return None;
    }
    match main {
        Some(m) => monitors
            .iter()
            .find(|c| (c.x, c.y) != (m.x, m.y))
            .copied()
            .or_else(|| monitors.get(1).copied()),
        None => monitors.get(1).copied(),
    }
}

/// Index into `monitors` of the one [`choose_audience_monitor`] picks — what a
/// "fullscreen on THIS output" request wants, where a position is not enough
/// (see `fullscreen_on`).
pub fn choose_audience_monitor_index(
    monitors: &[MonitorRect],
    main: Option<MonitorRect>,
) -> Option<usize> {
    let chosen = choose_audience_monitor(monitors, main)?;
    monitors.iter().position(|m| *m == chosen)
}

/// Open (or focus) a presentation window.
///
/// `fullscreen` forces the takeover even when there is only one monitor. Left
/// unset (the deck's audience window), a lone monitor yields an ordinary windowed
/// surface the speaker can drag onto a projector by hand; with a second monitor
/// both callers get the same fullscreen takeover of it either way.
///
/// MUST be `async`, for the same reason `detach_subwindow` is: a synchronous
/// Tauri command runs on the main thread, and `WebviewWindowBuilder::build()` on
/// Windows blocks on the main-thread event loop pumping WebView2's controller
/// callback — which the in-flight sync command is itself blocking (wry#583 /
/// tauri#4121), surfacing as a blank window that never renders.
#[tauri::command]
pub async fn open_presenter_window(
    app: AppHandle,
    label: String,
    fullscreen: Option<bool>,
) -> Result<String, String> {
    if !valid_presenter_label(&label) {
        return Err("invalid presenter window label".into());
    }

    // Idempotent: presenting the same deck twice re-uses (and re-focuses) the
    // window already on the projector rather than stacking a second one on it.
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        return Ok(label);
    }

    let target = audience_monitor(&app);
    let target_index = target.map(|(i, _)| i);
    let target = target.map(|(_, m)| m);

    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(presenter_query(&label).into()),
    )
    .title(concat!(crate::app_name!(), " — Presentation"))
    // Decorated on purpose, unlike a popout: with one monitor this window is
    // dragged to a projector by hand, and a borderless window is awkward to move
    // and impossible to close if the renderer never seeds.
    .decorations(true);
    // LOGICAL default size only; any monitor geometry below is PHYSICAL and is
    // applied through the physical setters after the build.
    builder = builder.inner_size(960.0, 600.0);
    #[cfg(target_os = "windows")]
    {
        // Same first-paint story as the detached window: a fresh WebView2 surface
        // shows blank white until it is shown/focused, so build hidden and reveal
        // it in the deferred kick below.
        builder = builder.visible(false);
    }

    let win = builder
        .build()
        .map_err(|e| format!("build presenter window: {e}"))?;

    // Physical setters, never the builder's logical ones: a monitor's origin/size
    // are PHYSICAL px, and feeding those to a logical setter multiplies them by
    // the display scale — the bug that put a detached window off-screen on every
    // scaled display (#42).
    //
    // Placed here, pre-fullscreen. Going fullscreen is DEFERRED into the kick
    // below and deliberately not done here: the resize nudge that forces
    // WebKitGTK to paint at all was guarded by `is_fullscreen() == false`, so
    // whenever a second monitor was found the window was already fullscreen and
    // the nudge never ran — i.e. the workaround skipped exactly the case it
    // exists for, and first real use was a black projector (TODO V #97).
    if let Some(m) = target {
        let _ = win.set_position(PhysicalPosition::new(m.x, m.y));
        let _ = win.set_size(PhysicalSize::new(m.w, m.h));
    }

    // Force the first paint, deferred so the webview has mounted. Same two
    // platform quirks the detached path documents: WebKitGTK presents an
    // unpainted BLACK GL surface until a genuine OS-level resize, WebView2 a
    // blank WHITE one until it is shown/focused.
    let nudge_app = app.clone();
    let nudge_label = label.clone();
    // A second monitor is a takeover either way; a single one only when the caller
    // asked for it. Both go through the deferred kick below rather than happening
    // here — see the placement note above.
    let go_fullscreen = target.is_some() || fullscreen.unwrap_or(false);
    std::thread::spawn(move || {
        let kick = |app: AppHandle, label: String, reveal: bool| {
            let app_main = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(w) = app_main.get_webview_window(&label) {
                    #[cfg(target_os = "windows")]
                    if reveal {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    // A fullscreen window must not be resized — that would drop it
                    // out of fullscreen — so the nudge only runs while the window
                    // is still windowed, which is now every window on its first
                    // kick.
                    if let Ok(false) = w.is_fullscreen() {
                        if let Ok(sz) = w.inner_size() {
                            let delta: i32 = if reveal { 1 } else { -1 };
                            let next = (sz.width as i32 + delta).max(1) as u32;
                            let _ = w.set_size(PhysicalSize::new(next, sz.height));
                        }
                    }
                }
            });
        };
        std::thread::sleep(std::time::Duration::from_millis(250));
        kick(nudge_app.clone(), nudge_label.clone(), true);
        std::thread::sleep(std::time::Duration::from_millis(50));
        kick(nudge_app.clone(), nudge_label.clone(), false);

        // Only now go fullscreen, on the monitor the window has already been
        // moved to — after the ±1 nudge has produced the genuine OS-level resize
        // WebKitGTK needs, and with the fullscreen transition as a second one.
        if go_fullscreen {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let app_main = nudge_app.clone();
            let fs_label = nudge_label.clone();
            let _ = nudge_app.run_on_main_thread(move || {
                if let Some(w) = app_main.get_webview_window(&fs_label) {
                    fullscreen_on(&w, target_index);
                }
            });
        }
    });

    Ok(label)
}

/// Close the audience window. Idempotent — a window already gone is the state the
/// caller wanted, so it is not an error (the presenter closes on unmount too,
/// which races the user closing it from the WM).
#[tauri::command]
pub fn close_presenter_window(app: AppHandle, label: String) -> Result<(), String> {
    if !valid_presenter_label(&label) {
        return Err("invalid presenter window label".into());
    }
    if let Some(win) = app.get_webview_window(&label) {
        // `destroy()`, not `close()`: `close()` fires the audience window's
        // `onCloseRequested`, which reports back that it went away — a message the
        // presenter that just asked for this does not need.
        let _ = win.destroy();
    }
    Ok(())
}

// ── Keeping the projector awake ──────────────────────────────────────────────
//
// A 45-minute talk with a long Q&A pause has no pointer movement and no key
// presses, so the screensaver blanks the projector mid-answer. Nothing in the
// deck subsystem asked the OS not to, so it did.
//
// Every desktop gets the real thing, each through its own native spelling:
// Linux holds a `systemd-inhibit` child, macOS a `caffeinate` child, Windows a
// thread that asserted `SetThreadExecutionState`. The cost of being wrong here
// is asymmetric — an inhibit that never released would leave the user's machine
// unable to sleep for the rest of the session — so the holder lives in a mutex,
// is idempotent, and is released on the presenter's unmount, on a clean exit
// (`RunEvent::Exit` calls `presenter_release_sleep`), and — for a crash, where
// neither runs — by a lifetime tie each mechanism carries on its own: see the
// variants below.

/// What is keeping the machine awake. One variant per mechanism; dropping the
/// value is not enough on its own (a `Child` needs its kill), so release goes
/// through [`Inhibitor::release`].
enum Inhibitor {
    /// A long-lived child whose lifetime *is* the inhibition. Killing it
    /// releases. How a *crashed* Tabtivity releases it differs per OS:
    ///
    /// - Linux: `systemd-inhibit … cat` with a piped stdin whose write end
    ///   stays inside this `Child` (never taken). When Tabtivity dies the kernel
    ///   closes that end, `cat` reads EOF and exits, and `systemd-inhibit`
    ///   releases the lock and exits with it. Nothing else inherits the write
    ///   end: std's pipes are `O_CLOEXEC`. (A child does NOT die with its
    ///   parent by default — the previous `sleep infinity` outlived a crash —
    ///   and `PR_SET_PDEATHSIG` would follow the forking *thread*, not the
    ///   process, so it would drop mid-talk if the spawn ever moved off the
    ///   main thread.)
    /// - macOS: `caffeinate -w <our pid>` exits when the pid it watches does.
    #[cfg(not(target_os = "windows"))]
    Child(std::process::Child),
    /// A thread holding `ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED`.
    /// The execution state is per-*thread* and stays asserted while the thread
    /// lives, so the thread parks on this channel and clears the state when the
    /// sender is dropped. A crashed Tabtivity takes the thread with it, and the
    /// kernel drops a dead thread's request.
    #[cfg(target_os = "windows")]
    Thread(std::sync::mpsc::Sender<()>),
}

impl Inhibitor {
    fn release(self) {
        match self {
            #[cfg(not(target_os = "windows"))]
            Inhibitor::Child(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(target_os = "windows")]
            Inhibitor::Thread(sender) => drop(sender),
        }
    }
}

/// The live inhibitor, if any. `None` = nothing is held.
static INHIBIT: std::sync::Mutex<Option<Inhibitor>> = std::sync::Mutex::new(None);

/// Clip the user-facing reason to something a desktop's "what is keeping this
/// machine awake" list can render: no control characters, at most 80 chars,
/// never empty.
fn inhibit_reason(reason: &str) -> String {
    let why: String = reason
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    if why.is_empty() {
        "Presenting".to_string()
    } else {
        why
    }
}

/// The `systemd-inhibit` argv (program excluded). The inhibited child is
/// `cat`, which blocks on a stdin pipe Tabtivity holds open — see
/// [`Inhibitor::Child`] for why that, and not `sleep infinity`, is the
/// lifetime tie. The reason is a single argv element (never a shell), since
/// the desktop's own "what is keeping this machine awake" UI shows it.
#[cfg(any(target_os = "linux", test))]
fn linux_inhibit_argv(reason: &str) -> Vec<String> {
    vec![
        "--what=idle:sleep".to_string(),
        concat!("--who=", crate::app_name!()).to_string(),
        format!("--why={}", inhibit_reason(reason)),
        "--mode=block".to_string(),
        "cat".to_string(),
    ]
}

/// Linux: `systemd-inhibit` with a long-lived child. `xdg-screensaver suspend
/// <window-id>` is the portable spelling and needs an X11 window id we do not
/// have here, so the inhibition lasts exactly as long as the child instead.
/// `None` when there is no `systemd-inhibit` on PATH.
#[cfg(target_os = "linux")]
fn acquire_inhibitor(reason: &str) -> Option<Inhibitor> {
    let child = crate::paths::command_no_window("systemd-inhibit")
        .args(linux_inhibit_argv(reason))
        // Piped, and the handle deliberately left in `child.stdin`: its write
        // end closing (release's kill, or Tabtivity dying) is what ends `cat`.
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    Some(Inhibitor::Child(child))
}

/// macOS: the system's own `caffeinate`, asserting "no display sleep" (`-d`) and
/// "no idle sleep" (`-i`). `-w <pid>` ties its lifetime to Tabtivity's: it exits on
/// its own the moment this process is gone, which is the crash-safety the Linux
/// child gets from its stdin pipe closing. Always present on macOS (it ships in
/// `/usr/bin`), so a `None` here means the spawn itself failed.
#[cfg(target_os = "macos")]
fn acquire_inhibitor(reason: &str) -> Option<Inhibitor> {
    // `caffeinate` shows no reason string anywhere; keep the parameter for the
    // shared signature and the log line.
    let _ = inhibit_reason(reason);
    let child = crate::paths::command_no_window("caffeinate")
        .args(["-d", "-i", "-w", &std::process::id().to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    Some(Inhibitor::Child(child))
}

/// Windows: `SetThreadExecutionState` on a dedicated thread. The request is
/// per-thread, so the thread that asserts it must stay alive for as long as the
/// inhibition should hold — it parks on a channel and clears the state when the
/// holder is dropped. `None` when the assertion itself was refused.
#[cfg(target_os = "windows")]
fn acquire_inhibitor(reason: &str) -> Option<Inhibitor> {
    use windows::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
    };

    let _ = inhibit_reason(reason);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<bool>();
    let spawned = std::thread::Builder::new()
        .name(concat!(crate::app_slug!(), "-presenter-awake").to_string())
        .spawn(move || {
            // SAFETY: plain Win32 call with no pointer arguments; a zero return
            // means the request was refused.
            let asserted = unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
            };
            let ok = asserted.0 != 0;
            let _ = ready_tx.send(ok);
            if !ok {
                return;
            }
            // Parks until the sender is dropped (release, or app exit).
            let _ = rx.recv();
            // SAFETY: as above; clearing the flags is the documented release.
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        });
    if spawned.is_err() {
        return None;
    }
    match ready_rx.recv() {
        Ok(true) => Some(Inhibitor::Thread(tx)),
        _ => None,
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn acquire_inhibitor(reason: &str) -> Option<Inhibitor> {
    let _ = inhibit_reason(reason);
    None
}

/// Ask the OS not to blank the screen or sleep while a talk is on.
///
/// Falls back to reporting `false` rather than erroring — a talk must not fail to
/// start because a desktop has no inhibit mechanism, and a modal about it
/// mid-presentation would be worse than the thing it warns about.
#[tauri::command]
pub fn presenter_inhibit_sleep(reason: String) -> Result<bool, String> {
    let mut held = INHIBIT
        .lock()
        .map_err(|_| "inhibit lock poisoned".to_string())?;
    if held.is_some() {
        // Idempotent: two presenters (main window + a popout) share one.
        return Ok(true);
    }
    match acquire_inhibitor(&reason) {
        Some(inhibitor) => {
            *held = Some(inhibitor);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Release the inhibitor. Idempotent — nothing held is the state the caller
/// wanted, and the presenter's unmount races app exit's own release.
#[tauri::command]
pub fn presenter_release_sleep() -> Result<(), String> {
    let mut held = INHIBIT
        .lock()
        .map_err(|_| "inhibit lock poisoned".to_string())?;
    if let Some(inhibitor) = held.take() {
        inhibitor.release();
    }
    Ok(())
}

/// Fullscreen the presentation window on the monitor at `index` (into the
/// app's `available_monitors()` order), or on whichever it is on when there is
/// no index.
///
/// The `set_position(monitor origin)` + `set_fullscreen(true)` pair above is
/// how every desktop but one picks the output: the position lands the window
/// on it, the fullscreen takes it over. Wayland drops the position — a client
/// may not place its own toplevel — so the window stays on whatever output the
/// compositor opened it on (the speaker's, next to the main window) and
/// fullscreens *there*, leaving the projector showing the desktop. Wayland
/// does let a client name the output it wants to be fullscreen ON, which GTK
/// exposes as `gtk_window_fullscreen_on_monitor`; that is also honoured on X11
/// (`_NET_WM_FULLSCREEN_MONITORS`), so Linux takes it for both. GDK numbers
/// monitors the way tao enumerates them, so the index carries over.
///
/// Must run on the GTK main thread — the kick's `run_on_main_thread` closure.
#[cfg(target_os = "linux")]
fn fullscreen_on(w: &tauri::WebviewWindow, index: Option<usize>) {
    use gtk::prelude::*;
    if let (Some(i), Ok(gtk_win)) = (index, w.gtk_window()) {
        if let Some(screen) = gtk::gdk::Screen::default() {
            gtk_win.fullscreen_on_monitor(&screen, i as i32);
            return;
        }
    }
    let _ = w.set_fullscreen(true);
}

/// Windows and macOS: the `set_position` above already put the window on the
/// chosen monitor, so a plain fullscreen takes over the right one.
#[cfg(not(target_os = "linux"))]
fn fullscreen_on(w: &tauri::WebviewWindow, _index: Option<usize>) {
    let _ = w.set_fullscreen(true);
}

/// Resolve the monitor to hand the audience window, from the live app: its
/// index in `available_monitors()` order plus its rect.
fn audience_monitor(app: &AppHandle) -> Option<(usize, MonitorRect)> {
    let to_rect = |m: &tauri::Monitor| MonitorRect {
        x: m.position().x,
        y: m.position().y,
        w: m.size().width,
        h: m.size().height,
    };
    let monitors: Vec<MonitorRect> = app.available_monitors().ok()?.iter().map(to_rect).collect();
    let main = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .map(|m| to_rect(&m));
    let index = choose_audience_monitor_index(&monitors, main)?;
    Some((index, monitors[index]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audience_monitor_index_names_the_chosen_output() {
        let monitors = [rect(0, 0), rect(1920, 0), rect(3840, 0)];
        // Main on the first → the second; main on the second → the first.
        assert_eq!(
            choose_audience_monitor_index(&monitors, Some(rect(0, 0))),
            Some(1)
        );
        assert_eq!(
            choose_audience_monitor_index(&monitors, Some(rect(1920, 0))),
            Some(0)
        );
        // Unknown main → the second; a single monitor → none.
        assert_eq!(choose_audience_monitor_index(&monitors, None), Some(1));
        assert_eq!(choose_audience_monitor_index(&monitors[..1], None), None);
    }

    fn rect(x: i32, y: i32) -> MonitorRect {
        MonitorRect {
            x,
            y,
            w: 1920,
            h: 1080,
        }
    }

    #[test]
    fn labels_are_validated() {
        assert!(valid_presenter_label("present-1a2b3c"));
        assert!(valid_presenter_label("present-A_b-9"));
        // The PDF present window shares the prefix — and must, since that prefix
        // is what `capabilities/default.json` grants window permissions by.
        assert!(valid_presenter_label("present-pdf-1a2b3c"));
        // Not a presenter window at all.
        assert!(!valid_presenter_label("main"));
        assert!(!valid_presenter_label("detached-p-g1"));
        // The prefix alone is not a label.
        assert!(!valid_presenter_label("present-"));
        // Path/query injection into the window URL.
        assert!(!valid_presenter_label("present-../../etc"));
        assert!(!valid_presenter_label("present-x?y=1"));
        assert!(!valid_presenter_label(&format!(
            "present-{}",
            "x".repeat(80)
        )));
    }

    #[test]
    fn query_carries_the_label() {
        assert_eq!(
            presenter_query("present-zz"),
            "index.html?present=present-zz"
        );
    }

    #[test]
    fn one_monitor_means_no_takeover() {
        assert_eq!(
            choose_audience_monitor(&[rect(0, 0)], Some(rect(0, 0))),
            None
        );
        assert_eq!(choose_audience_monitor(&[], None), None);
    }

    #[test]
    fn picks_the_monitor_the_main_window_is_not_on() {
        let ms = [rect(0, 0), rect(1920, 0)];
        assert_eq!(
            choose_audience_monitor(&ms, Some(rect(0, 0))),
            Some(rect(1920, 0))
        );
        assert_eq!(
            choose_audience_monitor(&ms, Some(rect(1920, 0))),
            Some(rect(0, 0))
        );
    }

    #[test]
    fn unknown_main_monitor_falls_back_to_the_second() {
        // Not the first: that is nearly always the built-in panel the speaker is
        // sitting at, i.e. the one surface the audience must NOT get.
        let ms = [rect(0, 0), rect(1920, 0), rect(3840, 0)];
        assert_eq!(choose_audience_monitor(&ms, None), Some(rect(1920, 0)));
    }

    #[test]
    fn linux_inhibit_blocks_on_cat_not_sleep() {
        let argv = linux_inhibit_argv("Talk\nwith\u{7} controls");
        assert_eq!(argv.last().map(String::as_str), Some("cat"));
        assert!(!argv.iter().any(|a| a == "sleep" || a == "infinity"));
        assert!(argv.contains(&"--mode=block".to_string()));
        let why = argv.iter().find(|a| a.starts_with("--why=")).unwrap();
        assert!(!why.chars().any(|c| c.is_control()), "{why}");
        let long = linux_inhibit_argv(&"x".repeat(500));
        let why = long.iter().find(|a| a.starts_with("--why=")).unwrap();
        assert_eq!(why.len(), "--why=".len() + 80);
    }

    /// The lifetime tie itself, without logind: a `cat` on a piped stdin exits
    /// once the write end is gone — which is what the kernel does to it when
    /// Tabtivity dies holding the handle.
    #[cfg(unix)]
    #[test]
    fn cat_exits_when_its_stdin_write_end_closes() {
        let mut child = std::process::Command::new("cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("cat is on every unix");
        drop(child.stdin.take());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                panic!("cat outlived its closed stdin");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn releasing_an_unheld_inhibitor_is_not_an_error() {
        // The presenter's unmount races app exit's own release, and a talk that
        // never managed to inhibit at all (no systemd-inhibit on PATH) still
        // releases on the way out.
        assert!(presenter_release_sleep().is_ok());
        assert!(presenter_release_sleep().is_ok());
    }

    #[test]
    fn main_on_an_unknown_monitor_still_yields_one() {
        // The main window reported a monitor that is not in the list (a hot-plug
        // between the two reads). Any second screen beats refusing to open.
        let ms = [rect(0, 0), rect(1920, 0)];
        assert_eq!(
            choose_audience_monitor(&ms, Some(rect(-1080, 0))),
            Some(rect(0, 0))
        );
    }
}
