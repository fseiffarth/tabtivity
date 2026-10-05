//! Screenshots: capture the screen into a staging area and let the user decide
//! where — or whether — the PNG is filed.
//!
//! Tabtivity's global "Screenshot" app already launches a region-capture tool, but
//! each tool otherwise saves to its own default location (`~/Pictures`, a
//! prompt, …). This command instead drives the capture's *output path* into a
//! staging directory under the state dir, then reports the shot to the frontend
//! so `ScreenshotSaveOverlay` can ask for a destination.
//!
//! **Nothing is written into a project without that answer.** An earlier version
//! filed every shot straight into the active project's screenshots folder,
//! which for a project with a public remote is a private-data leak one `git add
//! -A` away — a screen grab holds whatever happened to be on the screen. The
//! overlay is the consent step, and `tabtivity-screenshots/` is in `GITIGNORE_DEFAULT` so
//! a saved shot is ignored by default even after the user picks a project.
//!
//! The shot is *also* put on the system clipboard, so it can be pasted straight
//! into a chat or an agent tab without going hunting for the file (see
//! [`clipboard::copy_image_to_clipboard`]). That is why Discard is a safe
//! answer: the pixels are still on the clipboard, only the file is dropped.
//!
//! The platform-neutral layer (staging dir + timestamped filename + reporting)
//! is shared; the actual capture is delegated to a per-OS [`platform`] backend:
//! - **Linux** spawns an interactive native region tool (`spectacle`/`grim`/…),
//!   directed to write its PNG into the staging folder — or, under Wayland
//!   with no tool configured, asks the desktop portal
//!   (`org.freedesktop.portal.Screenshot`) and copies what it hands back.
//! - **Windows** grabs the whole virtual screen natively via GDI and encodes it
//!   to PNG with the `png` crate — no external tool required.
//! - **macOS** drives the built-in `screencapture` CLI in interactive region
//!   mode, writing the PNG into the staging folder.
//! - **Any other OS** returns an error rather than failing to build.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::fs::enforce_confinement;
use crate::services::remote::RemotePoolState;

/// Emitted once a capture's PNG is on disk in the staging area. The frontend
/// answers with `save_pending_screenshot` or `discard_pending_screenshot`.
const EV_CAPTURED: &str = "screenshot-captured";

/// A staged shot is abandoned when the overlay never gets an answer (a crash, a
/// relaunch). Anything older than this is swept on the next capture.
const PENDING_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// What a capture hands back once its PNG exists: copy it to the clipboard and
/// report it. Boxed because each backend reaches it from a different place —
/// the Linux/macOS poll thread, or straight-line on Windows.
type OnShot = Box<dyn FnOnce(&Path) + Send + 'static>;

/// How long, after the capture tool exits, we keep looking for the PNG it was
/// supposed to write before giving up on the clipboard copy.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const SHOT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
#[cfg(any(target_os = "linux", target_os = "macos"))]
const SHOT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// One staged shot, as reported to the frontend.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturedShot {
    /// Absolute path in the staging area — the handle for save/discard.
    path: String,
    /// The suggested file name, pre-filled in the overlay's name field.
    name: String,
}

/// Capture a screenshot into the staging area.
///
/// `exec` is the command configured for the global Screenshot app (a full path
/// or bare name); the Linux backend uses it to pick a tool it can direct, while
/// the Windows backend ignores it (it always does a native grab). Returns as
/// soon as the tool is launched — region selection blocks the *tool*, not
/// Tabtivity — and the shot itself arrives later as an [`EV_CAPTURED`] event. A
/// cancelled capture writes no file and so reports nothing, which is normal.
#[tauri::command]
pub fn capture_screenshot(app: AppHandle, exec: Option<String>) -> Result<(), String> {
    let dir = ensure_pending_dir()?;
    prune_stale_pending(&dir);
    let report: OnShot = Box::new(move |shot: &Path| {
        let _ = app.emit(
            EV_CAPTURED,
            CapturedShot {
                path: shot.to_string_lossy().to_string(),
                name: shot
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(screenshot_filename),
            },
        );
    });
    platform::capture(&dir, exec.as_deref(), report)
}

/// The bytes of a staged shot, for the overlay's preview. Confined to the
/// staging area: this is the one command that reads a path outside every
/// project tree, so it must never be talked into reading anything else.
#[tauri::command]
pub fn read_pending_screenshot(path: String) -> Result<tauri::ipc::Response, String> {
    let shot = pending_shot(&path)?;
    std::fs::read(&shot)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// File a staged shot into a project at `rel_path`, and drop the staged copy.
///
/// The write goes through `fs::write_project_file_bytes`, so it is confined to
/// the project root exactly like every other project write — and reaches a
/// remote project's host over SFTP rather than writing a local orphan.
#[tauri::command]
pub async fn save_pending_screenshot(
    path: String,
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<String, String> {
    let shot = pending_shot(&path)?;
    let bytes = std::fs::read(&shot).map_err(|e| e.to_string())?;
    // When the shot goes to Tabtivity's own folder, make sure git ignores that
    // folder before the PNG lands in it: scaffold repair is the only other way
    // the pattern arrives and it only runs when the user asks. A folder the
    // user typed instead is theirs, and `ensure_generated_dir_ignored` refuses
    // to touch `.gitignore` for it. Local trees only — a remote project's
    // bytes go over SFTP, and its `.gitignore` is the host's.
    let root = std::path::Path::new(&project_dir);
    if root.is_dir() {
        if let Some(first) = rel_path.split(['/', '\\']).find(|s| !s.is_empty()) {
            let _ = crate::commands::projects::ensure_generated_dir_ignored(root, first);
        }
    }
    crate::commands::fs::write_project_file_bytes(
        project_dir.clone(),
        rel_path.clone(),
        bytes,
        pool,
    )
    .await?;
    // The staged copy has served its purpose. A failed cleanup must not fail a
    // save whose bytes landed — the sweep catches it later.
    let _ = std::fs::remove_file(&shot);
    Ok(format!(
        "{}/{}",
        project_dir.trim_end_matches(['/', '\\']),
        rel_path.trim_start_matches('/')
    ))
}

/// Drop a staged shot the user chose not to file. The clipboard copy stands.
#[tauri::command]
pub fn discard_pending_screenshot(path: String) -> Result<(), String> {
    let shot = pending_shot(&path)?;
    std::fs::remove_file(&shot).map_err(|e| e.to_string())
}

/// `<state_dir>/screenshots-pending/`, created if missing.
///
/// Deliberately outside every project tree: a shot that has not been filed yet
/// must not be visible to a file watcher, a git status, or a sync loop.
fn ensure_pending_dir() -> Result<PathBuf, String> {
    let dir = crate::storage::state_dir().join("screenshots-pending");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::canonicalize(&dir).map_err(|e| e.to_string())
}

/// Resolve a caller-supplied path to a staged PNG, or refuse it. Canonicalized
/// before the check so `..` and symlinks cannot walk out of the staging area.
fn pending_shot(path: &str) -> Result<PathBuf, String> {
    let root = ensure_pending_dir()?;
    let shot = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    enforce_confinement(&root, &shot)?;
    if !shot.is_file() {
        return Err("not a file".to_string());
    }
    if !shot
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
    {
        return Err("not a PNG".to_string());
    }
    Ok(shot)
}

/// Sweep shots the overlay never answered for (a crash, a relaunch), so an
/// abandoned capture does not sit in the state dir forever.
fn prune_stale_pending(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| m.elapsed().map(|age| age > PENDING_TTL).unwrap_or(false))
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// `Screenshot-YYYYMMDD-HHMMSS.png` in UTC — sortable and collision-resistant.
fn screenshot_filename() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let tod = secs.rem_euclid(86_400);
    let (h, mi, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    format!("Screenshot-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}.png")
}

/// Spawn a capture tool detached and, once it exits, copy the PNG it produced
/// onto the clipboard and hand it to `on_shot`.
///
/// Region selection blocks the *tool*, not Tabtivity, so the shot does not exist
/// until the child is gone — the wait therefore happens on a background thread,
/// which also reaps the child (as `spawn_reaped` otherwise would). `expected` is
/// the path the tool was directed at, or `None` for tools that name the file
/// themselves (flameshot), where the newest PNG to appear is taken instead. A
/// cancelled capture writes no file at all, so finding nothing is a normal
/// outcome and stays silent — no event, no overlay.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn spawn_and_report(
    mut cmd: std::process::Command,
    dir: &std::path::Path,
    expected: Option<PathBuf>,
    on_shot: OnShot,
) -> std::io::Result<()> {
    // Filesystem mtimes can be coarser than `SystemTime::now()`, so leave slack
    // rather than let a just-written file look older than the spawn.
    let since = SystemTime::now()
        .checked_sub(SHOT_WAIT)
        .unwrap_or_else(SystemTime::now);
    let mut child = cmd.spawn()?;
    let dir = dir.to_path_buf();
    std::thread::spawn(move || {
        if child.wait().is_err() {
            return;
        }
        // The PNG lands as the tool exits; poll briefly for it to appear (and to
        // be readable — a decode can lose a race with the tool's final flush).
        let polls = SHOT_WAIT.as_millis() / SHOT_POLL.as_millis();
        let mut found: Option<PathBuf> = None;
        for _ in 0..polls {
            if let Some(shot) = locate_shot(&dir, expected.as_deref(), since) {
                if crate::commands::clipboard::copy_png_file_to_clipboard(&shot).is_ok() {
                    on_shot(&shot);
                    return;
                }
                found = Some(shot);
            }
            std::thread::sleep(SHOT_POLL);
        }
        // The file is the product, the clipboard the convenience: a shot whose
        // copy never took still has to reach the overlay, or it is stranded in
        // the staging area with nothing to answer for it.
        if let Some(shot) = found {
            on_shot(&shot);
        }
    });
    Ok(())
}

/// The PNG a capture just produced: the path the tool was directed at, or — for
/// tools that choose their own filename — the newest PNG in `dir` written since
/// the tool was spawned. `None` when the capture was cancelled and wrote nothing.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn locate_shot(
    dir: &std::path::Path,
    expected: Option<&std::path::Path>,
    since: SystemTime,
) -> Option<PathBuf> {
    if let Some(path) = expected {
        return path.is_file().then(|| path.to_path_buf());
    }
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
        })
        .filter_map(|entry| {
            let mtime = entry.metadata().ok()?.modified().ok()?;
            (mtime >= since).then_some((mtime, entry.path()))
        })
        .max_by_key(|(mtime, _)| *mtime)
        .map(|(_, path)| path)
}

/// Civil date from days since the Unix epoch (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ── Linux backend (drive an interactive native region tool) ──────────────────
#[cfg(target_os = "linux")]
mod platform {
    //! Spawns the user-configured (or first available) native region-capture
    //! tool, routing its output into the staging folder. The tool is spawned
    //! detached — region selection blocks the *tool*, not Tabtivity — and the shot
    //! reaches the save overlay through `on_shot` once it lands.

    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    /// Native region-capture tools we know how to drive, in preference order. The
    /// first one present on `PATH` is used when the global Screenshot app has no
    /// usable command. `grim` additionally needs `slurp` for region selection.
    const NATIVE_TOOLS: &[&str] = &[
        "spectacle",
        "gnome-screenshot",
        "flameshot",
        "grim",
        "scrot",
        "maim",
        "xfce4-screenshooter",
        "ksnip",
        "shutter",
        "import",
    ];

    /// Pick a tool (configured `exec` if directable, else the first native one on
    /// `PATH`) and spawn it detached, writing into `dir` — or go through the
    /// desktop portal instead.
    ///
    /// Which comes first is the session's call. Under **Wayland** a configured
    /// tool is still honoured (it is the user's word), but with none set the
    /// portal is tried before any tool on `PATH`: the X11 grabbers (`scrot`,
    /// `maim`, `import`) see only XWayland there, `grim` needs a wlroots
    /// compositor GNOME is not, and GNOME ≥ 42 ships no `gnome-screenshot` at
    /// all — a fresh GNOME box has nothing on the list (user, 2026-09-07). On
    /// **X11** the tools keep coming first, exactly as before, and the portal is
    /// the last resort when none is installed.
    pub fn capture(dir: &Path, exec: Option<&str>, on_shot: super::OnShot) -> Result<(), String> {
        let configured = exec
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .filter(|e| is_directable(&basename(e)));
        let mut portal_err: Option<String> = None;
        if configured.is_none() && crate::platform::x11::session_is_wayland() {
            match portal::request() {
                Ok(responses) => {
                    portal::watch(responses, dir.to_path_buf(), on_shot);
                    return Ok(());
                }
                Err(e) => portal_err = Some(e),
            }
        }
        let program = match configured.map(str::to_string).or_else(pick_native_tool) {
            Some(p) => p,
            None => {
                if portal_err.is_none() {
                    match portal::request() {
                        Ok(responses) => {
                            portal::watch(responses, dir.to_path_buf(), on_shot);
                            return Ok(());
                        }
                        Err(e) => portal_err = Some(e),
                    }
                }
                return Err(format!(
                    "no usable screenshot tool found (desktop portal: {}); set one for the Screenshot global app",
                    portal_err.unwrap_or_default()
                ));
            }
        };

        let (mut cmd, expected) = capture_command(&program, dir)
            .ok_or_else(|| format!("don't know how to capture with '{}'", basename(&program)))?;
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::paths::augment_command_path(&mut cmd);
        super::spawn_and_report(cmd, dir, expected, on_shot)
            .map_err(|e| format!("launch {program}: {e}"))?;
        Ok(())
    }

    /// Build the capture `Command` for a tool, routing its output into `dir`, plus
    /// the file it will write. Tools that take an explicit output file get a
    /// timestamped path; flameshot only takes a directory and names the file
    /// itself, so it reports no expected path. Returns `None` for tools we don't
    /// know how to direct.
    pub fn capture_command(program: &str, dir: &Path) -> Option<(Command, Option<PathBuf>)> {
        let base = basename(program);
        let file = dir.join(super::screenshot_filename());
        let f = file.to_string_lossy().to_string();
        let d = dir.to_string_lossy().to_string();

        let mut cmd = Command::new(program);
        match base.as_str() {
            // region + headless save, no desktop notification, -o output
            "spectacle" => cmd.args(["-r", "-b", "-n", "-o", &f]),
            "gnome-screenshot" => cmd.args(["--area", "--file", &f]),
            // flameshot names the file itself; -p sets the directory it saves into
            "flameshot" => {
                cmd.args(["gui", "--path", &d]);
                return Some((cmd, None));
            }
            "scrot" => cmd.args(["--select", &f]),
            "maim" => cmd.args(["--select", &f]),
            "xfce4-screenshooter" => cmd.args(["--region", "--save", &f]),
            "ksnip" => cmd.args(["--rectarea", "-s", &f]),
            "shutter" => cmd.args(["--select", "--exit_after_capture", "-o", &f]),
            // ImageMagick: bare `import <file>` lets the user click/drag a region
            "import" => cmd.arg(&f),
            // Wayland: slurp selects the region, grim captures it — needs a shell
            "grim" => {
                let mut sh = Command::new("sh");
                sh.arg("-c")
                    .arg(format!("grim -g \"$(slurp)\" {}", shell_quote(&f)));
                return Some((sh, Some(file)));
            }
            _ => return None,
        };
        Some((cmd, Some(file)))
    }

    /// Whether `capture_command` knows how to direct a tool's output, by basename.
    pub fn is_directable(base: &str) -> bool {
        NATIVE_TOOLS.contains(&base)
    }

    /// First native tool present on `PATH` (grim additionally requires `slurp`).
    fn pick_native_tool() -> Option<String> {
        NATIVE_TOOLS
            .iter()
            .copied()
            .find(|&tool| on_path(tool) && (tool != "grim" || on_path("slurp")))
            .map(String::from)
    }

    /// Whether an executable named `name` exists on `PATH`.
    fn on_path(name: &str) -> bool {
        match std::env::var_os("PATH") {
            Some(path) => std::env::split_paths(&path).any(|dir| dir.join(name).is_file()),
            None => false,
        }
    }

    pub fn basename(exec: &str) -> String {
        Path::new(exec)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    }

    pub(crate) use crate::services::ssh_exec::shell_quote;

    /// The desktop portal's interactive screenshot
    /// (`org.freedesktop.portal.Screenshot.Screenshot`, `interactive: true`),
    /// which on GNOME opens the shell's own region/window/screen picker and on
    /// KDE Spectacle's — the one capture path a Wayland compositor lets a
    /// client take without a compositor-specific protocol.
    ///
    /// Portal calls are two-step: the method returns a *request* object at once
    /// and the outcome arrives later as that object's `Response` signal, with
    /// the shot's `uri` in the results. The request path is predictable from
    /// our own bus name and the `handle_token` we pass, which is what lets the
    /// signal subscription go up *before* the call — a fast portal can answer
    /// before the method reply is even read, and a subscription made after
    /// would miss it. `request` does the synchronous half (so a bus without a
    /// portal fails right here, and `capture` can still fall back to a tool);
    /// `watch` blocks a thread on the signal, exactly the way the tool path
    /// blocks one on the child's exit.
    pub(super) mod portal {
        use std::collections::HashMap;
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU32, Ordering};

        use zbus::blocking::{Connection, Proxy};
        use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

        const DEST: &str = "org.freedesktop.portal.Desktop";
        const PATH: &str = "/org/freedesktop/portal/desktop";
        const SCREENSHOT_IFACE: &str = "org.freedesktop.portal.Screenshot";
        const REQUEST_IFACE: &str = "org.freedesktop.portal.Request";

        /// `Response` codes, per the portal spec.
        const RESPONSE_OK: u32 = 0;
        const RESPONSE_CANCELLED: u32 = 1;

        /// Makes each request's `handle_token` unique within the process.
        static SEQ: AtomicU32 = AtomicU32::new(0);

        /// The object path the portal will create for a request from `sender`
        /// (our unique bus name, e.g. `:1.42`) with `token`: the sender minus
        /// its leading colon with dots turned into underscores, then the token.
        pub fn request_path(sender: &str, token: &str) -> String {
            let sender = sender.trim_start_matches(':').replace('.', "_");
            format!("/org/freedesktop/portal/desktop/request/{sender}/{token}")
        }

        /// The synchronous half: subscribe, call, and hand back the signal
        /// iterator the outcome will arrive on. Errors mean "no portal here".
        pub fn request() -> Result<zbus::blocking::proxy::SignalIterator<'static>, String> {
            let conn = Connection::session().map_err(|e| format!("session bus: {e}"))?;
            let sender = conn
                .unique_name()
                .ok_or_else(|| "session bus assigned no unique name".to_string())?
                .to_string();
            let token = format!(
                concat!(crate::app_slug!(), "_{}_{}"),
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            );
            let expected = request_path(&sender, &token);
            let mut responses = subscribe(&conn, &expected)?;

            let screenshot = Proxy::new(&conn, DEST, PATH, SCREENSHOT_IFACE)
                .map_err(|e| format!("portal proxy: {e}"))?;
            let mut options: HashMap<&str, Value<'_>> = HashMap::new();
            options.insert("handle_token", Value::from(token.as_str()));
            options.insert("interactive", Value::from(true));
            // An empty parent handle: a Wayland parent needs an xdg-foreign
            // export we do not have, and the picker is a whole-screen overlay
            // anyway. Only the dialog's transient-for placement is lost.
            let handle: OwnedObjectPath = screenshot
                .call_method("Screenshot", &("", options))
                .map_err(|e| format!("portal Screenshot: {e}"))?
                .body()
                .deserialize()
                .map_err(|e| format!("portal Screenshot reply: {e}"))?;
            // A portal older than the handle_token convention answers with a
            // path of its own; follow it (accepting the small race the
            // convention exists to close).
            if handle.as_str() != expected {
                responses = subscribe(&conn, handle.as_str())?;
            }
            Ok(responses)
        }

        fn subscribe(
            conn: &Connection,
            path: &str,
        ) -> Result<zbus::blocking::proxy::SignalIterator<'static>, String> {
            let path = ObjectPath::try_from(path.to_string())
                .map_err(|e| format!("portal request path: {e}"))?;
            let request: Proxy<'static> = Proxy::new(conn, DEST, path, REQUEST_IFACE)
                .map_err(|e| format!("portal request proxy: {e}"))?;
            request
                .receive_signal("Response")
                .map_err(|e| format!("portal Response subscription: {e}"))
        }

        /// The asynchronous half, on its own thread: wait for the `Response`,
        /// copy the shot into `dir`, put it on the clipboard, report it.
        ///
        /// The portal's file is *copied*, not moved: where it lands is the
        /// portal's business (GNOME's keeps it under the user's Pictures), and
        /// a file the user can already see must not vanish because Tabtivity
        /// asked for a copy. A cancelled picker (`RESPONSE_CANCELLED`) writes
        /// nothing and stays silent, like a cancelled tool.
        pub fn watch(
            responses: zbus::blocking::proxy::SignalIterator<'static>,
            dir: PathBuf,
            on_shot: super::super::OnShot,
        ) {
            std::thread::spawn(move || {
                for msg in responses {
                    let Ok((code, results)) = msg
                        .body()
                        .deserialize::<(u32, HashMap<String, OwnedValue>)>()
                    else {
                        continue;
                    };
                    match code {
                        RESPONSE_OK => {}
                        RESPONSE_CANCELLED => return,
                        other => {
                            eprintln!("screenshot portal: request ended with code {other}");
                            return;
                        }
                    }
                    let Some(uri) = results
                        .get("uri")
                        .and_then(|v| <&str>::try_from(&**v).ok())
                        .map(str::to_owned)
                    else {
                        eprintln!("screenshot portal: response carried no uri");
                        return;
                    };
                    match stage(&uri, &dir) {
                        Ok(shot) => {
                            let _ = crate::commands::clipboard::copy_png_file_to_clipboard(&shot);
                            on_shot(&shot);
                        }
                        Err(e) => eprintln!("screenshot portal: {e}"),
                    }
                    return;
                }
            });
        }

        /// Copy the portal's `file://` result into the staging `dir` under the
        /// usual timestamped name, and return the staged path.
        fn stage(uri: &str, dir: &Path) -> Result<PathBuf, String> {
            let (src, _host) = gtk::glib::filename_from_uri(uri)
                .map_err(|e| format!("portal uri {uri:?}: {e}"))?;
            let shot = dir.join(super::super::screenshot_filename());
            std::fs::copy(&src, &shot)
                .map_err(|e| format!("copy {} into staging: {e}", src.display()))?;
            Ok(shot)
        }
    }
}

// ── Windows backend (Win32 GDI virtual-screen grab) ──────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    //! Native full virtual-screen capture via GDI. Windows has no equally
    //! ubiquitous interactive region CLI, so rather than shelling out we grab the
    //! entire virtual screen (every monitor) with `BitBlt` + `GetDIBits` and
    //! encode it to PNG with the `png` crate, writing the file directly into the
    //! project's `tabtivity-screenshots/` folder. This is deterministic — it always
    //! produces image data — and needs no external tool. The configured `exec`
    //! (which names a Linux tool) is ignored. Every GDI object acquired here is
    //! released on both the success and error paths.

    use std::ffi::c_void;
    use std::path::Path;

    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HDC, HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    /// Grab the virtual screen, write the PNG into `dir`, put the same pixels on
    /// the clipboard, and report the shot. Unlike the spawn-a-tool backends, the
    /// buffer is already in hand here, so neither the copy nor the report needs a
    /// wait — and a clipboard failure must not fail a capture whose file landed
    /// fine. `_exec` is unused on Windows (the native grab is always preferred).
    pub fn capture(dir: &Path, _exec: Option<&str>, on_shot: super::OnShot) -> Result<(), String> {
        let (width, height, rgba) = grab_virtual_screen()?;
        let file = dir.join(super::screenshot_filename());
        encode_png_file(&file, width, height, &rgba)?;
        let _ = crate::commands::clipboard::copy_image_to_clipboard(
            width as usize,
            height as usize,
            rgba,
        );
        on_shot(&file);
        Ok(())
    }

    /// Capture all monitors as a single top-down RGBA buffer `(width, height, px)`.
    fn grab_virtual_screen() -> Result<(u32, u32, Vec<u8>), String> {
        // SAFETY: every GDI handle acquired below is released before this function
        // returns, on both the success and error paths.
        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if width <= 0 || height <= 0 {
                return Err("virtual screen has no area".to_string());
            }

            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err("GetDC failed for the screen".to_string());
            }
            let result = capture_to_buffer(screen_dc, x, y, width, height);
            ReleaseDC(None, screen_dc);
            result
        }
    }

    /// BitBlt the screen region into a memory bitmap, then read it back as RGBA.
    /// Caller owns `screen_dc`; the memory DC and bitmap are created and freed here.
    unsafe fn capture_to_buffer(
        screen_dc: HDC,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<(u32, u32, Vec<u8>), String> {
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        if mem_dc.is_invalid() {
            return Err("CreateCompatibleDC failed".to_string());
        }
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if bitmap.is_invalid() {
            let _ = DeleteDC(mem_dc);
            return Err("CreateCompatibleBitmap failed".to_string());
        }
        let prev = SelectObject(mem_dc, HGDIOBJ(bitmap.0));

        let result = (|| {
            BitBlt(mem_dc, 0, 0, width, height, Some(screen_dc), x, y, SRCCOPY)
                .map_err(|e| format!("BitBlt failed: {e}"))?;

            // Negative biHeight requests top-down rows, so the buffer is already in
            // the row order the PNG encoder expects.
            let header = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0 as u32,
                ..Default::default()
            };
            let mut info = BITMAPINFO {
                bmiHeader: header,
                ..Default::default()
            };

            let mut buffer = vec![0u8; (width as usize) * (height as usize) * 4];
            let scanlines = GetDIBits(
                mem_dc,
                bitmap,
                0,
                height as u32,
                Some(buffer.as_mut_ptr() as *mut c_void),
                &mut info,
                DIB_RGB_COLORS,
            );
            if scanlines == 0 {
                return Err("GetDIBits failed".to_string());
            }
            // GDI delivers BGRA with an unused alpha byte; convert to opaque RGBA.
            for px in buffer.chunks_exact_mut(4) {
                px.swap(0, 2);
                px[3] = 0xFF;
            }
            Ok((width as u32, height as u32, buffer))
        })();

        let _ = SelectObject(mem_dc, prev);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem_dc);
        result
    }

    /// Encode an RGBA buffer to a PNG file (matching `clipboard`'s encoder setup).
    fn encode_png_file(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let writer = std::io::BufWriter::new(file);
        let mut encoder = png::Encoder::new(writer, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ── macOS backend (built-in `screencapture` CLI) ─────────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    //! Drives macOS's built-in `screencapture` in interactive region mode,
    //! routing its output into the staging folder. Like the Linux backend, the
    //! tool is spawned detached — region selection blocks the *tool*, not Tabtivity
    //! — and the shot reaches the save overlay through `on_shot` once it lands.
    //! The configured `exec` is ignored (the OS tool is always used).

    use std::path::Path;
    use std::process::{Command, Stdio};

    /// Spawn `screencapture -i <file>` (interactive region capture) writing into
    /// `dir`. `_exec` is unused on macOS.
    pub fn capture(dir: &Path, _exec: Option<&str>, on_shot: super::OnShot) -> Result<(), String> {
        let file = dir.join(super::screenshot_filename());
        let mut cmd = crate::paths::command_no_window("screencapture");
        cmd.arg("-i")
            .arg(&file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        super::spawn_and_report(cmd, dir, Some(file), on_shot)
            .map_err(|e| format!("launch screencapture: {e}"))?;
        Ok(())
    }
}

// ── Fallback backend (other OSes) ────────────────────────────────────────────
// Any remaining target has no native path wired yet; capture fails with a clear
// error rather than the crate failing to build.
#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
mod platform {
    use std::path::Path;

    pub fn capture(
        _dir: &Path,
        _exec: Option<&str>,
        _on_shot: super::OnShot,
    ) -> Result<(), String> {
        Err("screenshot capture is not supported on this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn filename_has_expected_shape() {
        let name = screenshot_filename();
        assert!(name.starts_with("Screenshot-"));
        assert!(name.ends_with(".png"));
        // Screenshot-YYYYMMDD-HHMMSS.png == 11 + 8 + 1 + 6 + 4
        assert_eq!(name.len(), 30);
    }

    /// The staging area is the one path outside every project tree that a
    /// command here will read or delete, so the confinement on it is the whole
    /// of that command's safety.
    #[test]
    fn pending_shot_refuses_paths_outside_the_staging_area() {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var(crate::app_env!("STATE_DIR"), tmp.path());
        let dir = ensure_pending_dir().unwrap();

        let shot = dir.join("Screenshot-20260101-000000.png");
        std::fs::write(&shot, b"png").unwrap();
        assert_eq!(pending_shot(&shot.to_string_lossy()).unwrap(), shot);

        // A file that is simply elsewhere, and the same file reached through a
        // traversal out of the staging area and back to it.
        let outside = tmp.path().join("elsewhere.png");
        std::fs::write(&outside, b"png").unwrap();
        assert!(pending_shot(&outside.to_string_lossy()).is_err());
        let traversal = dir.join("..").join("elsewhere.png");
        assert!(pending_shot(&traversal.to_string_lossy()).is_err());

        // Not a PNG, and not a file at all.
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, b"txt").unwrap();
        assert!(pending_shot(&txt.to_string_lossy()).is_err());
        assert!(pending_shot(&dir.to_string_lossy()).is_err());
        assert!(pending_shot(&dir.join("gone.png").to_string_lossy()).is_err());

        std::env::remove_var(crate::app_env!("STATE_DIR"));
    }

    /// An overlay that never got an answer (a crash, a relaunch) must not leave
    /// its shot in the state dir forever — but a fresh one has an overlay open
    /// on it and must survive the next capture's sweep.
    #[test]
    fn prune_stale_pending_drops_only_the_abandoned_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let fresh = dir.join("fresh.png");
        let stale = dir.join("stale.png");
        std::fs::write(&fresh, b"png").unwrap();
        std::fs::write(&stale, b"png").unwrap();
        let old = std::time::SystemTime::now() - PENDING_TTL - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();

        prune_stale_pending(dir);
        assert!(fresh.is_file());
        assert!(!stale.exists());
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(18_993), (2022, 1, 1));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn basename_lowercases_and_strips_dir() {
        assert_eq!(platform::basename("/usr/bin/Spectacle"), "spectacle");
        assert_eq!(platform::basename("flameshot"), "flameshot");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn portal_request_path_follows_the_sender_convention() {
        assert_eq!(
            platform::portal::request_path(":1.42", concat!(crate::app_slug!(), "_7_0")),
            concat!("/org/freedesktop/portal/desktop/request/1_42/", crate::app_slug!(), "_7_0")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn directable_matches_known_tools() {
        assert!(platform::is_directable("scrot"));
        assert!(platform::is_directable("grim"));
        assert!(!platform::is_directable("totally-unknown-tool"));
    }

    /// The directed-output case: the tool's file is taken when it exists, and a
    /// cancelled capture (no file) yields nothing rather than an older shot.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn locate_shot_uses_the_expected_path_when_written() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join("Screenshot-20200101-000000.png");
        std::fs::write(&stale, b"old").unwrap();
        let expected = dir.path().join("Screenshot-20260101-000000.png");
        let since = SystemTime::now() - SHOT_WAIT;

        assert_eq!(locate_shot(dir.path(), Some(&expected), since), None);
        std::fs::write(&expected, b"new").unwrap();
        assert_eq!(
            locate_shot(dir.path(), Some(&expected), since),
            Some(expected)
        );
    }

    /// The self-naming case (flameshot): the newest PNG written since the spawn
    /// wins, and PNGs predating it — or non-PNGs — are ignored.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn locate_shot_picks_the_newest_png_since_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.png");
        std::fs::write(&old, b"old").unwrap();

        // mtimes come from a coarse kernel clock that only advances on a timer
        // tick (~1-4ms), so a file written right after a fine-grained `now()` can
        // land *before* it and be filtered out by the `mtime >= since` cutoff. A
        // real capture writes seconds later, so straddle the cutoff with sleeps
        // past one tick instead of racing it.
        std::thread::sleep(Duration::from_millis(20));

        // Spawned now: anything already on disk is older than the cutoff.
        let since = SystemTime::now();
        assert_eq!(locate_shot(dir.path(), None, since), None);
        std::thread::sleep(Duration::from_millis(20));

        std::fs::write(dir.path().join("notes.txt"), b"txt").unwrap();
        let shot = dir.path().join("shot.png");
        std::fs::write(&shot, b"new").unwrap();
        assert_eq!(locate_shot(dir.path(), None, since), Some(shot));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn capture_command_reports_the_file_it_directs() {
        let dir = std::path::Path::new(concat!("/tmp/", crate::app_slug!(), "-shots"));
        let (_, expected) = platform::capture_command("scrot", dir).unwrap();
        let expected = expected.expect("scrot is directed at an explicit file");
        assert_eq!(expected.parent(), Some(dir));
        assert!(expected.extension().is_some_and(|e| e == "png"));

        // flameshot names the file itself, so there is no path to expect.
        let (_, expected) = platform::capture_command("flameshot", dir).unwrap();
        assert_eq!(expected, None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(platform::shell_quote("/a/b.png"), "'/a/b.png'");
        assert_eq!(platform::shell_quote("/o'dir/x.png"), r"'/o'\''dir/x.png'");
    }
}
