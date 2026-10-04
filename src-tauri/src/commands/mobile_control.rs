use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use crate::{
    services::desktop_images::{self, DesktopImage, ImageFolder},
    services::mobile_control::{
        admin::{self, read_frame, write_frame},
        auth,
        config::{
            detect_serve_settings_json, serve_status_json, verify_tailscale_serve,
            DetectedServeSettings, HostConfig,
        },
        discovery::opaque_control_id,
        inbox,
        protocol::{
            AdminDevice, AdminRequest, AdminResponse, DesktopRequest, DesktopResponse,
            MobileInboxAttachment,
        },
    },
    storage,
};

pub const MOBILE_DESKTOP_EVENT: &str = crate::brand::MOBILE_DESKTOP_EVENT;
#[cfg(not(windows))]
const INSTALL_PHONE_SCRIPT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../scripts/install_phone.sh"
));
/// The PowerShell twin (same checks, same output) for Windows, where the root
/// terminal has no bash/jq to run the POSIX script with.
#[cfg(windows)]
const INSTALL_PHONE_SCRIPT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../scripts/install_phone.ps1"
));
#[cfg(not(windows))]
const INSTALL_PHONE_SCRIPT_NAME: &str = "install_phone.sh";
#[cfg(windows)]
const INSTALL_PHONE_SCRIPT_NAME: &str = "install_phone.ps1";

#[derive(Clone, Default)]
pub struct MobileDesktopState {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<DesktopResponse>>>>,
}

#[tauri::command]
pub fn mobile_desktop_respond(
    state: State<'_, MobileDesktopState>,
    request_id: String,
    response: DesktopResponse,
) -> Result<(), String> {
    let sender = state
        .pending
        .lock()
        .unwrap()
        .remove(&request_id)
        .ok_or("mobile request expired")?;
    sender
        .send(response)
        .map_err(|_| "mobile request receiver closed".into())
}

#[tauri::command]
pub fn mobile_opaque_id(domain: String, value: String) -> Result<String, String> {
    if value.is_empty() || value.len() > 256 {
        return Err("invalid opaque id input".into());
    }
    opaque_control_id(&storage::state_dir(), &domain, &value)
}

// ── Composer + → From the desktop ────────────────────────────────────────────
// The phone lists what the desktop would copy into the project inbox and
// names one entry by the opaque id the list gave it. The folder scan and the
// id scheme live in `services::desktop_images`; this adapter adds the two
// things that need the desktop process — the platform's folder set and the
// clipboard, which needs a display connection — and writes through the same
// `inbox::store` a file sent from the phone goes through.

/// The platform's folder set, shared with the sidecar's headless answer
/// (`services::desktop_images::default_folders`).
fn desktop_image_folders() -> Vec<ImageFolder> {
    desktop_images::default_folders(&storage::state_dir())
}

/// The clipboard's image as a list entry, or `None` when it holds none — or
/// when the probe does not answer in time: on X11 `arboard` waits out a
/// selection transfer timeout when there is no image, and the sidecar's
/// deadline for the whole list is a few seconds.
async fn clipboard_image_entry() -> Option<DesktopImage> {
    let probe = tauri::async_runtime::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new().ok()?;
        let image = clipboard.get_image().ok()?;
        Some((image.width as u32, image.height as u32))
    });
    let (width, height) = tokio::time::timeout(Duration::from_secs(3), probe)
        .await
        .ok()?
        .ok()??;
    Some(DesktopImage {
        id: desktop_images::CLIPBOARD_ID.into(),
        name: "Clipboard image".into(),
        source: "Clipboard".into(),
        size: None,
        age_secs: None,
        width: Some(width),
        height: Some(height),
    })
}

/// Everything the phone may attach from this desktop, clipboard first.
#[tauri::command]
pub async fn mobile_desktop_images() -> Vec<DesktopImage> {
    let folders = desktop_image_folders();
    let (clipboard, files) = tokio::join!(clipboard_image_entry(), async {
        tauri::async_runtime::spawn_blocking(move || {
            desktop_images::list(&folders, SystemTime::now())
        })
        .await
        .unwrap_or_default()
    });
    let mut images = Vec::with_capacity(files.len() + 1);
    images.extend(clipboard);
    images.extend(files);
    images
}

/// Copy one listed image into `project_dir`'s inbox. The `Err` is a wire code
/// the phone maps to a sentence — never a path or an OS message.
#[tauri::command]
pub async fn mobile_attach_desktop_image(
    project_dir: String,
    image_id: String,
) -> Result<MobileInboxAttachment, String> {
    if !desktop_images::valid_id(&image_id) {
        return Err("image_not_found".into());
    }
    let root = PathBuf::from(project_dir);
    tauri::async_runtime::spawn_blocking(move || {
        let (name, bytes) = if image_id == desktop_images::CLIPBOARD_ID {
            let mut clipboard =
                arboard::Clipboard::new().map_err(|_| "no_clipboard_image".to_string())?;
            let image = clipboard
                .get_image()
                .map_err(|_| "no_clipboard_image".to_string())?;
            let png =
                crate::commands::clipboard::encode_png(image.width, image.height, &image.bytes)
                    .map_err(|_| "no_clipboard_image".to_string())?;
            ("clipboard.png".to_string(), png)
        } else {
            let path = desktop_images::resolve(&desktop_image_folders(), &image_id)
                .ok_or_else(|| "image_not_found".to_string())?;
            let bytes = std::fs::read(&path).map_err(|_| "image_not_found".to_string())?;
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "image".into());
            (name, bytes)
        };
        inbox::store(&root, &name, &bytes)
            .map(|stored| MobileInboxAttachment {
                name: stored.name,
                reference: stored.reference,
                size: stored.size,
            })
            .map_err(|error| error.code().to_string())
    })
    .await
    .map_err(|_| "write_failed".to_string())?
}

// ── Global inbox (phone → Send to desktop) ──────────────────────────────────
// Files the phone sent to no project wait in `<state_dir>/inbox/`; the
// header's inbox button lists them. Every command names a file by the leaf the
// listing gave out and `inbox::global_file` re-checks it, so a name from the
// webview can never reach outside that folder.

/// The global inbox, newest first.
#[tauri::command]
pub async fn global_inbox_list() -> Vec<inbox::GlobalInboxFile> {
    tauri::async_runtime::spawn_blocking(|| inbox::list_global(&storage::state_dir()))
        .await
        .unwrap_or_default()
}

/// Open one inbox file with the OS default application.
#[tauri::command]
pub fn global_inbox_open(name: String) -> Result<(), String> {
    let path = inbox::global_file(&storage::state_dir(), &name).ok_or("file_not_found")?;
    opener::open(&path).map_err(|e| e.to_string())
}

/// Open the global inbox folder in the OS file manager, creating it first so
/// the button works before the first file arrives.
#[tauri::command]
pub fn global_inbox_reveal() -> Result<(), String> {
    let dir = storage::state_dir().join(inbox::GLOBAL_INBOX_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    opener::open(&dir).map_err(|e| e.to_string())
}

/// Delete one inbox file. `false` when it was already gone.
#[tauri::command]
pub fn global_inbox_delete(name: String) -> Result<bool, String> {
    inbox::remove_global(&storage::state_dir(), &name).map_err(|e| e.code().to_string())
}

/// Materialize the phone-install handoff where the root terminal can run it,
/// returning the script's path — the state dir differs per OS, so the caller
/// must not re-derive it. Keep the script embedded so this action also works
/// from a packaged app, whose installation directory does not contain the
/// source checkout. POSIX shell on Linux/macOS, PowerShell on Windows; the
/// frontend picks the matching interpreter from the extension.
#[tauri::command]
pub fn mobile_prepare_phone_install_script() -> Result<String, String> {
    let path = storage::state_dir()
        .join("mobile-control")
        .join(INSTALL_PHONE_SCRIPT_NAME);
    let parent = path
        .parent()
        .ok_or("could not determine the Mobile control directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    std::fs::write(&path, INSTALL_PHONE_SCRIPT).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// The paired phones, read off `mobile-control/devices.json` whether or not
/// the host runs — what the per-phone Mobile access picker lists. Read-only;
/// `online` is always false here (`mobile_admin` `devices` adds it while the
/// host runs).
#[tauri::command]
pub async fn mobile_paired_devices() -> Result<Vec<AdminDevice>, String> {
    tauri::async_runtime::spawn_blocking(|| auth::read_paired_devices(&storage::state_dir().join("mobile-control")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mobile_admin(request: AdminRequest) -> Result<AdminResponse, String> {
    admin::admin_call(
        &storage::state_dir().join("mobile-control/admin.sock"),
        &request,
    )
    .await
}

#[derive(serde::Serialize)]
pub struct MobileHostRuntimeStatus {
    pub configured: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub origin: Option<String>,
    pub error: Option<String>,
    pub installed_version: Option<String>,
    pub update_available: bool,
}

/// The leaf name every install writes and every start looks for.
#[cfg(windows)]
const HOST_BINARY_NAME: &str = crate::brand::MOBILE_HOST_EXE;
#[cfg(not(windows))]
const HOST_BINARY_NAME: &str = crate::brand::MOBILE_HOST_BIN;

/// Whether the installed sidecar is a *superseded copy of the same version*.
///
/// `update_available` was a version-string comparison alone — and `bin/<version>/`
/// is keyed by that same string, so two builds of one version share the
/// directory and the copy answering the phone is whichever build installed
/// first. Between two pushes that is every dev build, and the gap is not
/// cosmetic: the phone's bundle can run ahead through the live overlay
/// (`live_pwa`), but the HTTP API answering it is the installed sidecar's own,
/// so a route added after that copy was made 404s and the feature renders as
/// "the desktop sent nothing" — which is how the project screen's outbox shelf
/// stayed invisible with its code plainly in the window (2026-09-20). Nothing
/// offered the update, because the versions matched.
///
/// An install copies the running image byte for byte, so a copy of a different
/// size, or one older than that image, is behind it. Comparing the bytes
/// themselves is not worth a debug binary's 700 MB on every status poll.
fn binary_behind(installed: &Path, running: &Path) -> bool {
    let (Ok(installed), Ok(running)) = (
        std::fs::metadata(installed),
        std::fs::metadata(running),
    ) else {
        // Nothing installed, or a running image no path names any more (a dev
        // rebuild over the file): neither is a superseded copy, and claiming an
        // update that `mobile_host_apply` would then fail to read is worse than
        // staying quiet.
        return false;
    };
    if installed.len() != running.len() {
        return true;
    }
    match (installed.modified(), running.modified()) {
        (Ok(installed), Ok(running)) => installed < running,
        _ => false,
    }
}

/// [`binary_behind`] for the copy this version's install would have written.
fn sidecar_behind_window(control_dir: &Path) -> bool {
    let Ok(running) = mobile_binary_source() else {
        return false;
    };
    binary_behind(
        &control_dir
            .join("bin")
            .join(env!("CARGO_PKG_VERSION"))
            .join(HOST_BINARY_NAME),
        &running,
    )
}

#[tauri::command]
pub async fn mobile_host_status() -> MobileHostRuntimeStatus {
    let config = HostConfig::load(&storage::state_dir()).ok();
    match mobile_admin(AdminRequest::Status).await {
        Ok(AdminResponse::Host {
            running,
            port,
            origin,
            version,
        }) => MobileHostRuntimeStatus {
            configured: config.is_some(),
            running,
            port: Some(port),
            origin,
            error: None,
            update_available: version.as_deref() != Some(env!("CARGO_PKG_VERSION"))
                || config
                    .as_ref()
                    .is_some_and(|config| sidecar_behind_window(&config.control_dir)),
            installed_version: version,
        },
        Ok(_) => MobileHostRuntimeStatus {
            configured: config.is_some(),
            running: false,
            port: config.as_ref().map(|c| c.host.port),
            origin: config.as_ref().map(|c| c.origin.clone()),
            error: Some("unexpected sidecar response".into()),
            installed_version: None,
            update_available: false,
        },
        Err(error) => MobileHostRuntimeStatus {
            configured: config.is_some(),
            running: false,
            port: config.as_ref().map(|c| c.host.port),
            origin: config.as_ref().map(|c| c.origin.clone()),
            error: Some(error),
            installed_version: None,
            update_available: false,
        },
    }
}

/// The sidecar is the Tabtivity binary itself, run with `--mobile-host`. A
/// separate `tabtivity-mobile-host` bin target used to exist, but it linked the
/// whole `app_lib` anyway (same size, nothing gained) and Tauri's
/// `universal-apple-darwin` build never lipo-merges secondary cargo binaries,
/// which broke every macOS bundle at the copy step.
///
/// On Linux that source is the magic link itself, not the path
/// `std::env::current_exe()` resolves it to. The two differ exactly when the
/// running image's path no longer holds it — a dev rebuild over
/// `target/debug/tabtivity`, a re-run of `package:dev`, an in-app update swapping
/// the AppImage — where the kernel appends ` (deleted)` and the resolved path
/// opens as `ENOENT`. [`mobile_host_apply`] then fails at its copy step with
/// `read mobile host: No such file or directory (os error 2)` *before* it
/// reaches the service manager, so Reconnect cannot bring Mobile back at all
/// and the journal records nothing to say why — while the binary being
/// replaced under a live window is the very moment the user reaches for that
/// button. Opening `/proc/self/exe` reads the running inode whether or not any
/// path still names it. Other platforms have no such link and keep the path.
#[cfg(target_os = "linux")]
fn mobile_binary_source() -> Result<PathBuf, String> {
    Ok(PathBuf::from("/proc/self/exe"))
}

#[cfg(not(target_os = "linux"))]
fn mobile_binary_source() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn systemd_path(path: &Path) -> Result<String, String> {
    let raw = path.to_string_lossy();
    if raw.contains(['\n', '\r', '\0']) {
        return Err("Mobile service path contains unsupported control characters".into());
    }
    Ok(format!(
        "\"{}\"",
        raw.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    ))
}

/// Deliberately **no `PrivateTmp=`**.
///
/// The sidecar's entire job is reaching the desktop's tmux server, whose socket
/// lives at `$TMUX_TMPDIR/tmux-$UID/default` — and `TMUX_TMPDIR` is unset in a
/// normal desktop session, so that is `/tmp`. A private `/tmp` hands the service
/// an empty directory instead: `tmux ls` finds nothing, every tab reports
/// `available: false`, and no error anywhere explains why.
///
/// It did not fail that way in testing only because a systemd *user* manager
/// needs an unprivileged user namespace to build a mount namespace, and
/// distributions that set `kernel.apparmor_restrict_unprivileged_userns=1`
/// (Ubuntu 24.04+) do not let it finish. systemd then skips the namespacing
/// options silently — `systemctl show` still reports `PrivateTmp=yes` while
/// the process runs on the host mount table. So the directive bought nothing
/// where userns is restricted and broke tab discovery where it is allowed,
/// with the outcome decided by a kernel policy this unit never checks.
///
/// **No mount-namespace directive of any kind** (`ProtectSystem=`,
/// `ProtectHome=`, `ReadWritePaths=`, `PrivateTmp=`, `BindPaths=`, …), for
/// a worse reason than the skipped sandbox. Where userns is restricted, the
/// user manager's `unshare(CLONE_NEWUSER)` still *succeeds*: Ubuntu's AppArmor
/// transitions the unconfined process into its `unprivileged_userns` profile,
/// which denies every capability. The mount setup that follows then fails,
/// systemd treats that as "containerized, ignore" and runs the service anyway
/// — inside a capability-less user namespace, confined for life, and so is
/// every child it spawns (`pix /** -> &unprivileged_userns`). The sidecar's
/// own work survives that; its agent fence does not: `bwrap` stacked under
/// that profile cannot create its sandbox, `agent_fence::bwrap_available`
/// fails closed, and every phone "+ Claude" with the window closed was refused
/// with "bubblewrap is unavailable" on a machine where the window fenced
/// every tab with it. The window process never asked systemd for a namespace,
/// which is the whole difference. (`BindPaths=-/tmp/tmux-%U` was also worse
/// on its own terms: the directory does not exist before tmux has started,
/// and one created later never appears inside an already-built namespace.)
///
/// `NoNewPrivileges` is a `prctl`, needs no namespace, and does not get in
/// the fence's way: AppArmor allows an *unconfined* task to attach to `bwrap`'s
/// profile under `no_new_privs`, and bwrap sets that bit on itself anyway.
///
/// **`StartLimitIntervalSec=0` is load-bearing.** The sidecar exits non-zero on
/// a Tailscale Serve verification failure precisely so `Restart=on-failure`
/// brings it back — but while tailscaled is down, the *startup* verification
/// fails too, and under systemd's default start limit (5 starts in 10 s) a
/// `RestartSec=2` crash loop trips it in ~10 seconds and leaves the unit
/// permanently `failed`: Mobile stays down after the outage ends, the exact
/// outcome the non-zero exit was chosen to avoid. Disabling the limit and
/// pacing the retries at 5 s keeps the loop cheap and self-healing. A disabled
/// configuration cannot spin here: the binary exits 0 for it, which
/// `on-failure` does not restart.
#[cfg(target_os = "linux")]
fn systemd_unit(binary: &Path) -> Result<String, String> {
    Ok(format!(concat!("[Unit]\nDescription=", crate::app_name!(), " Mobile Host\nAfter=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nExecStart={} --mobile-host\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n"), systemd_path(binary)?))
}

/// Every `[Service]` directive that makes systemd build a mount namespace for
/// the unit (systemd's `exec_needs_mount_namespace`, "Sandboxing" in
/// `systemd.exec(5)`), plus `PrivateUsers`, the user namespace an unprivileged
/// manager has to open first. [`systemd_unit`] must emit none of them, see its
/// rationale; the test holds it to this list.
#[cfg(all(test, target_os = "linux"))]
const MOUNT_NAMESPACE_DIRECTIVES: &[&str] = &[
    "BindPaths",
    "BindReadOnlyPaths",
    "ExecPaths",
    "ExtensionDirectories",
    "ExtensionImages",
    "InaccessiblePaths",
    "LogNamespace",
    "MountAPIVFS",
    "MountFlags",
    "MountImages",
    "NoExecPaths",
    "PrivateDevices",
    "PrivateIPC",
    "PrivateMounts",
    "PrivateTmp",
    "PrivateUsers",
    "ProcSubset",
    "ProtectControlGroups",
    "ProtectHome",
    "ProtectKernelLogs",
    "ProtectKernelModules",
    "ProtectKernelTunables",
    "ProtectProc",
    "ProtectSystem",
    "ReadOnlyPaths",
    "ReadWritePaths",
    "RootDirectory",
    "RootImage",
    "TemporaryFileSystem",
];

/// Delete every `bin/<version>/` directory except `keep`.
///
/// The sidecar is versioned per directory so an install can never write over the
/// executable a running host is executing (see [`install_mobile_binary`]) — but
/// nothing removed the superseded ones, so every Tabtivity version the user has
/// ever enabled Mobile under left a full copy of the binary behind forever. On a
/// packaged build that is ~40 MB apiece; in a dev session it is whatever
/// `target/debug/tabtivity` weighs, because [`mobile_binary_source`] is
/// `current_exe` and a debug binary carries its DWARF — 700 MB each, three of
/// them, 2.0 GB of the 3.3 GB state dir measured on 2026-09-01.
///
/// Called **after** the install succeeded, never before: a failed install must
/// leave the previous version's directory exactly where it is, because that is
/// the copy the currently-running host is executing from. Best-effort by
/// construction — a directory that will not delete (a host still running out of
/// it, a permissions oddity) is left for the next install to retry, and must
/// never turn a working install into an error.
fn prune_old_versions(bin_root: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(bin_root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name == keep {
            continue;
        }
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Replace the installed sidecar without opening its live executable for
/// writing. A service-manager restart leaves the old process running until
/// after this install, so copying directly over the target intermittently
/// fails on Linux with `ETXTBSY` ("Text file busy"). Renaming a completed
/// sibling is atomic; the old process keeps its inode while the restarted
/// service sees the new one.
#[cfg(unix)]
fn install_mobile_binary(source: &Path, target_dir: &Path) -> Result<PathBuf, String> {
    let target = target_dir.join(HOST_BINARY_NAME);
    let mut staged = tempfile::NamedTempFile::new_in(target_dir)
        .map_err(|error| format!("stage mobile host: {error}"))?;
    let mut source_file =
        std::fs::File::open(source).map_err(|error| format!("read mobile host: {error}"))?;
    std::io::copy(&mut source_file, staged.as_file_mut())
        .map_err(|error| format!("stage mobile host: {error}"))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| format!("stage mobile host: {error}"))?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(staged.path(), std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("stage mobile host: {error}"))?;
    staged
        .persist(&target)
        .map_err(|error| format!("install mobile host: {}", error.error))?;
    Ok(target)
}

/// Stage the sidecar copy on Windows. `NamedTempFile::persist` is a `rename`,
/// which Windows refuses over an existing file — and refuses entirely while
/// that file backs a running process, so callers stop the live host first.
#[cfg(windows)]
fn install_mobile_binary(source: &Path, target_dir: &Path) -> Result<PathBuf, String> {
    let target = target_dir.join(HOST_BINARY_NAME);
    let mut staged = tempfile::NamedTempFile::new_in(target_dir)
        .map_err(|error| format!("stage mobile host: {error}"))?;
    let mut source_file =
        std::fs::File::open(source).map_err(|error| format!("read mobile host: {error}"))?;
    std::io::copy(&mut source_file, staged.as_file_mut())
        .map_err(|error| format!("stage mobile host: {error}"))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| format!("stage mobile host: {error}"))?;
    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }
    staged
        .persist(&target)
        .map_err(|error| format!("install mobile host: {}", error.error))?;
    Ok(target)
}

#[cfg(target_os = "macos")]
const LAUNCHD_LABEL: &str = crate::brand::MOBILE_HOST_LAUNCHD_LABEL;

#[cfg(target_os = "macos")]
fn plist_escape(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The macOS twin of `systemd_unit`, with the same two lifecycle rules mapped
/// onto launchd's vocabulary. `KeepAlive.SuccessfulExit=false` is
/// `Restart=on-failure`: a Tailscale Serve verification failure exits non-zero
/// so launchd brings the agent back, while the disabled configuration exits 0
/// and stays down. `ThrottleInterval` paces the retries the way `RestartSec`
/// does — and launchd has no systemd-style start limit, so a transient
/// tailscaled outage can never park the agent in a permanently failed state.
#[cfg(target_os = "macos")]
fn launchd_plist(binary: &Path) -> String {
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" ",
            "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
            "<plist version=\"1.0\">\n",
            "<dict>\n",
            "\t<key>Label</key>\n\t<string>{label}</string>\n",
            "\t<key>ProgramArguments</key>\n",
            "\t<array>\n\t\t<string>{binary}</string>\n\t\t<string>--mobile-host</string>\n\t</array>\n",
            "\t<key>RunAtLoad</key>\n\t<true/>\n",
            "\t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>\n",
            "\t<key>ThrottleInterval</key>\n\t<integer>5</integer>\n",
            "\t<key>ProcessType</key>\n\t<string>Background</string>\n",
            "</dict>\n",
            "</plist>\n",
        ),
        label = LAUNCHD_LABEL,
        binary = plist_escape(&binary.to_string_lossy()),
    )
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = crate::brand::MOBILE_HOST_RUN_VALUE;

#[cfg(windows)]
fn run_command_line(binary: &Path) -> Result<String, String> {
    let raw = binary.to_string_lossy();
    if raw.contains('"') || raw.contains(['\n', '\r', '\0']) {
        return Err("Mobile service path contains unsupported characters".into());
    }
    Ok(format!("\"{raw}\" --mobile-host"))
}

/// Windows has no user service manager watching the host, so stopping it is a
/// cooperative shutdown over the admin pipe followed by waiting for it to be
/// gone — the port must be free before a replacement can bind, and the staged
/// executable cannot be renamed over while the old process still backs it.
#[cfg(windows)]
async fn stop_running_host() {
    if mobile_admin(AdminRequest::Shutdown).await.is_err() {
        return;
    }
    for _ in 0..12 {
        if mobile_admin(AdminRequest::Status).await.is_err() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

#[cfg(target_os = "linux")]
async fn disable_host_service() -> Result<(), String> {
    // Stop the live listener through its authenticated same-user socket
    // first. This remains effective even if systemd is temporarily
    // unavailable; the unit command then prevents it returning at login.
    let shutdown = mobile_admin(AdminRequest::Shutdown).await;
    let stop = crate::paths::command_no_window("systemctl")
        .args(["--user", "disable", "--now", crate::brand::MOBILE_HOST_UNIT])
        .status()
        .map_err(|error| error.to_string())?;
    if !stop.success() {
        return Err(if shutdown.is_ok() {
            "Mobile host stopped, but its systemd user service could not be disabled".into()
        } else {
            concat!("Could not stop or disable the ", crate::app_name!(), " Mobile user service").into()
        });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
async fn enable_host_service(target: &Path, _config: &HostConfig) -> Result<(), String> {
    let unit_dir = crate::paths::home_dir().join(".config/systemd/user");
    std::fs::create_dir_all(&unit_dir).map_err(|e| e.to_string())?;
    std::fs::write(unit_dir.join(crate::brand::MOBILE_HOST_UNIT), systemd_unit(target)?)
        .map_err(|e| e.to_string())?;
    let reload = crate::paths::command_no_window("systemctl")
        .args(["--user", "daemon-reload"])
        .status()
        .map_err(|e| e.to_string())?;
    if !reload.success() {
        return Err("systemd user daemon-reload failed".into());
    }
    let start = crate::paths::command_no_window("systemctl")
        .args(["--user", "enable", crate::brand::MOBILE_HOST_UNIT])
        .status()
        .map_err(|e| e.to_string())?;
    if !start.success() {
        return Err(concat!("could not enable the ", crate::app_name!(), " Mobile user service").into());
    }
    let restart = crate::paths::command_no_window("systemctl")
        .args(["--user", "restart", crate::brand::MOBILE_HOST_UNIT])
        .status()
        .map_err(|e| e.to_string())?;
    if !restart.success() {
        return Err(concat!("could not start the ", crate::app_name!(), " Mobile user service").into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
async fn disable_host_service() -> Result<(), String> {
    let shutdown = mobile_admin(AdminRequest::Shutdown).await;
    let uid = unsafe { libc::getuid() };
    let service_target = format!("gui/{uid}/{LAUNCHD_LABEL}");
    // `bootout` fails when the agent is not loaded, which is not a problem —
    // ask first so a genuine unload failure is not confused with "was off".
    let loaded = crate::paths::command_no_window("launchctl")
        .args(["print", &service_target])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if loaded {
        let bootout = crate::paths::command_no_window("launchctl")
            .args(["bootout", &service_target])
            .status()
            .map_err(|error| error.to_string())?;
        if !bootout.success() {
            return Err(if shutdown.is_ok() {
                "Mobile host stopped, but its launch agent could not be unloaded".into()
            } else {
                concat!("Could not stop or unload the ", crate::app_name!(), " Mobile launch agent").into()
            });
        }
    }
    let plist = crate::paths::home_dir()
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist"));
    let _ = std::fs::remove_file(plist);
    Ok(())
}

#[cfg(target_os = "macos")]
async fn enable_host_service(target: &Path, _config: &HostConfig) -> Result<(), String> {
    let plist_dir = crate::paths::home_dir().join("Library/LaunchAgents");
    std::fs::create_dir_all(&plist_dir).map_err(|e| e.to_string())?;
    let plist_path = plist_dir.join(format!("{LAUNCHD_LABEL}.plist"));
    std::fs::write(&plist_path, launchd_plist(target)).map_err(|e| e.to_string())?;
    let uid = unsafe { libc::getuid() };
    let service_target = format!("gui/{uid}/{LAUNCHD_LABEL}");
    // Replace any loaded copy; a failure here just means it was not loaded.
    let _ = crate::paths::command_no_window("launchctl")
        .args(["bootout", &service_target])
        .status();
    // Lift a persisted disable from an earlier launchctl-level opt-out.
    let _ = crate::paths::command_no_window("launchctl")
        .args(["enable", &service_target])
        .status();
    let bootstrap = crate::paths::command_no_window("launchctl")
        .args(["bootstrap", &format!("gui/{uid}")])
        .arg(&plist_path)
        .status()
        .map_err(|e| e.to_string())?;
    if !bootstrap.success() {
        return Err(concat!("could not start the ", crate::app_name!(), " Mobile launch agent").into());
    }
    Ok(())
}

#[cfg(windows)]
async fn disable_host_service() -> Result<(), String> {
    let shutdown = mobile_admin(AdminRequest::Shutdown).await;
    // A missing value makes `reg delete` fail, which is the state we want
    // anyway; HKCU needs no elevation, so other failures are not expected.
    let _ = crate::paths::command_no_window("reg")
        .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
        .status();
    if shutdown.is_err() && mobile_admin(AdminRequest::Status).await.is_ok() {
        return Err(concat!("Could not stop the ", crate::app_name!(), " Mobile host").into());
    }
    Ok(())
}

#[cfg(windows)]
async fn enable_host_service(target: &Path, _config: &HostConfig) -> Result<(), String> {
    let command_line = run_command_line(target)?;
    let add = crate::paths::command_no_window("reg")
        .args([
            "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &command_line, "/f",
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if !add.success() {
        return Err(concat!("could not register the ", crate::app_name!(), " Mobile autostart entry").into());
    }
    let mut child = crate::paths::command_no_window(target)
        .arg("--mobile-host")
        .spawn()
        .map_err(|e| format!("start mobile host: {e}"))?;
    // No service manager is watching this process: confirm it came up, and
    // surface an immediate exit (bad config, port taken) instead of silence.
    for _ in 0..12 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if mobile_admin(AdminRequest::Status).await.is_ok() {
            return Ok(());
        }
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
    }
    Err(concat!("the ", crate::app_name!(), " Mobile host did not start").into())
}

/// The Mobile host's lifetime is the app's, and these two are the pair that
/// make it so. The service manager still supervises the sidecar *while Tabtivity
/// runs* (a Tailscale Serve verification failure exits non-zero and
/// `Restart=on-failure` brings it back), but a host with no desktop behind it
/// can create no tab and — since the clean quit now reaps every local tmux
/// session too — has no session left to attach a phone to. It used to keep
/// listening after the window was gone anyway, one of several leftovers a quit
/// left running on the machine.
///
/// Stop is best-effort and bounded: the cooperative admin `Shutdown` (the
/// sidecar exits 0, which `on-failure` does not restart), then the platform's
/// own stop as the net for a wedged host. The `enable` (login autostart) is
/// deliberately left as the Settings toggle set it — it is the user's stated
/// choice, and the next launch's [`start_host_on_launch`] starts the host
/// whether or not the login did.
///
/// The one exception is the user's own: with "Keep running when Tabtivity is
/// closed" on (`stay_after_quit`), the host is left up, because since the
/// headless owner (`docs/headless_owner_plan.md`) it is no longer a listener
/// with nothing behind it — it answers the phone, starts tabs, and fires
/// scheduled prompts and reminders with no window.
pub async fn stop_host_for_exit() {
    let config = HostConfig::load(&storage::state_dir());
    if config.as_ref().is_ok_and(stays_after_quit) {
        return;
    }
    // A missing socket answers immediately (ENOENT / connection refused);
    // only a live-but-wedged host costs the admin timeouts.
    let shutdown = mobile_admin(AdminRequest::Shutdown).await;
    if config.is_err() {
        return;
    }
    stop_installed_host(shutdown.is_ok()).await;
}

/// Whether a quit leaves the Mobile host running. Only an enabled, loadable
/// configuration gets here; unset is off.
fn stays_after_quit(config: &HostConfig) -> bool {
    config.host.stay_after_quit == Some(true)
}

/// What a launch does with the Mobile host.
#[derive(Debug, PartialEq, Eq)]
enum LaunchHost {
    /// It answers, and it is this window's build.
    Keep,
    /// Installed and current, but not running: start that copy.
    Start,
    /// Reinstall from the running image, as Settings → Mobile → Update host
    /// does: this version has no copy yet, the copy is an earlier build
    /// ([`binary_behind`]), or the host answering is another version.
    Update,
}

/// The launch's choice. `answering` is the running host's reported version
/// (`Some(None)` when it answers without one), `None` when nothing answers.
///
/// The sidecar is a *copy* of the binary under `bin/<version>/`, run by the
/// service manager, and a launch used to start whatever copy was there — so a
/// rebuilt or updated window kept serving the phone the old HTTP API until
/// someone found the Update host button, and a feature whose routes were new
/// (the outbox shelf, 2026-09-20; the project files 📁, 2026-09-28) simply
/// did not appear on the phone.
fn launch_host(answering: Option<Option<&str>>, copy: &Path, running: &Path, version: &str) -> LaunchHost {
    let stale_version = matches!(answering, Some(reported) if reported != Some(version));
    if !copy.is_file() || binary_behind(copy, running) || stale_version {
        LaunchHost::Update
    } else if answering.is_some() {
        LaunchHost::Keep
    } else {
        LaunchHost::Start
    }
}

/// Start the Mobile host at launch when the configuration says it should be
/// running — the counterpart of [`stop_host_for_exit`], without which the
/// first quit would leave Mobile down until the next login — and bring its
/// copy up to this window's build first when it is behind ([`launch_host`]).
/// Off the main thread; a no-op when Mobile is off (`HostConfig::load` refuses
/// a disabled or absent configuration).
///
/// An update that fails (Tailscale Serve down, the image unreadable) falls
/// back to starting the installed copy: an old host is still a working phone,
/// and Settings → Mobile keeps offering the update by hand.
pub fn start_host_on_launch() {
    tauri::async_runtime::spawn(async {
        let Ok(config) = HostConfig::load(&storage::state_dir()) else {
            return;
        };
        let status = mobile_admin(AdminRequest::Status).await;
        let answering = match &status {
            Ok(AdminResponse::Host { version, .. }) => Some(version.as_deref()),
            Ok(_) => Some(None),
            Err(_) => None,
        };
        let version = env!("CARGO_PKG_VERSION");
        let copy = config.control_dir.join("bin").join(version).join(HOST_BINARY_NAME);
        let action = match mobile_binary_source() {
            Ok(running) => launch_host(answering, &copy, &running, version),
            Err(_) if answering.is_some() => LaunchHost::Keep,
            Err(_) => LaunchHost::Start,
        };
        match action {
            LaunchHost::Keep => return,
            LaunchHost::Update => match mobile_host_apply(true).await {
                Ok(()) => return,
                Err(error) => eprintln!("mobile host: update at launch: {error}"),
            },
            LaunchHost::Start => {}
        }
        if mobile_admin(AdminRequest::Status).await.is_ok() {
            return;
        }
        if let Err(error) = start_installed_host(&config).await {
            eprintln!("mobile host: start at launch: {error}");
        }
    });
}

#[cfg(target_os = "linux")]
async fn stop_installed_host(_shutdown_ok: bool) {
    // `--no-block`: the unit is normally already inactive after the admin
    // shutdown, and a wedged one should not hold the app's exit for systemd's
    // stop timeout.
    let _ = crate::paths::command_no_window("systemctl")
        .args(["--user", "stop", "--no-block", crate::brand::MOBILE_HOST_UNIT])
        .status();
}

#[cfg(target_os = "linux")]
async fn start_installed_host(_config: &HostConfig) -> Result<(), String> {
    // `start`, not `restart`: idempotent against a host the login already
    // brought up between the status probe and here.
    let status = crate::paths::command_no_window("systemctl")
        .args(["--user", "start", crate::brand::MOBILE_HOST_UNIT])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("systemctl --user start failed (Settings → Mobile can reinstall the service)".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
async fn stop_installed_host(shutdown_ok: bool) {
    if shutdown_ok {
        return;
    }
    let uid = unsafe { libc::getuid() };
    let _ = crate::paths::command_no_window("launchctl")
        .args(["kill", "TERM", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
        .status();
}

#[cfg(target_os = "macos")]
async fn start_installed_host(_config: &HostConfig) -> Result<(), String> {
    let uid = unsafe { libc::getuid() };
    let service_target = format!("gui/{uid}/{LAUNCHD_LABEL}");
    // A loaded agent that exited 0 stays loaded and idle; `kickstart` runs it
    // again. One that was never bootstrapped this login is loaded from its
    // plist instead.
    let kicked = crate::paths::command_no_window("launchctl")
        .args(["kickstart", &service_target])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if kicked {
        return Ok(());
    }
    let plist = crate::paths::home_dir()
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist"));
    if !plist.exists() {
        return Err("launch agent is not installed (Settings → Mobile can reinstall it)".into());
    }
    let bootstrap = crate::paths::command_no_window("launchctl")
        .args(["bootstrap", &format!("gui/{uid}")])
        .arg(&plist)
        .status()
        .map_err(|e| e.to_string())?;
    if !bootstrap.success() {
        return Err("launchctl bootstrap failed".into());
    }
    Ok(())
}

/// No service manager to ask on Windows: the cooperative shutdown already sent
/// is the whole stop, and waiting for the process to be gone (what
/// `stop_running_host` adds for a reinstall) is nothing an exit needs.
#[cfg(windows)]
async fn stop_installed_host(_shutdown_ok: bool) {}

/// Windows has no service manager holding the binary's path, so the launch
/// start looks in the install directory itself: this version's copy first,
/// else the newest one present (an older host still serves; the Settings
/// panel offers the update).
#[cfg(windows)]
async fn start_installed_host(config: &HostConfig) -> Result<(), String> {
    let bin_dir = config.control_dir.join("bin");
    let current = bin_dir
        .join(env!("CARGO_PKG_VERSION"))
        .join(HOST_BINARY_NAME);
    let target = if current.is_file() {
        current
    } else {
        let mut candidates: Vec<PathBuf> = std::fs::read_dir(&bin_dir)
            .map_err(|e| format!("mobile host is not installed: {e}"))?
            .flatten()
            .map(|entry| entry.path().join(HOST_BINARY_NAME))
            .filter(|path| path.is_file())
            .collect();
        candidates.sort();
        candidates
            .pop()
            .ok_or("mobile host is not installed (Settings → Mobile can install it)")?
    };
    crate::paths::command_no_window(&target)
        .arg("--mobile-host")
        .spawn()
        .map_err(|e| format!("start mobile host: {e}"))?;
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
async fn stop_installed_host(_shutdown_ok: bool) {}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
async fn start_installed_host(_config: &HostConfig) -> Result<(), String> {
    Err("unsupported platform".into())
}

#[tauri::command]
pub async fn mobile_host_apply(enabled: bool) -> Result<(), String> {
    if !enabled {
        return disable_host_service().await;
    }
    let config = HostConfig::load(&storage::state_dir())?;
    verify_tailscale_serve(&config.origin, config.host.port)?;
    let source = mobile_binary_source()?;
    let version = env!("CARGO_PKG_VERSION");
    let bin_root = config.control_dir.join("bin");
    let target_dir = bin_root.join(version);
    // Windows locks a running executable's file: the live host must be gone
    // before its same-version copy can be replaced. The Unix installs rename
    // atomically and restart through the service manager instead.
    #[cfg(windows)]
    stop_running_host().await;
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let target = install_mobile_binary(&source, &target_dir)?;
    prune_old_versions(&bin_root, version);
    enable_host_service(&target, &config).await
}

#[derive(serde::Serialize)]
pub struct TailscaleServeStatus {
    pub installed: bool,
    pub json: Option<serde_json::Value>,
    pub error: Option<String>,
    pub detected: Option<DetectedServeSettings>,
    pub detection_error: Option<String>,
}

#[tauri::command]
pub async fn mobile_verify_tailscale_serve(origin: String, port: u16) -> Result<(), String> {
    verify_tailscale_serve(&origin, port)
}

#[tauri::command]
pub async fn mobile_tailscale_serve_status() -> TailscaleServeStatus {
    match serve_status_json() {
        Ok(json) => {
            let detection = detect_serve_settings_json(&json);
            TailscaleServeStatus {
                installed: true,
                json: Some(json),
                error: None,
                detected: detection.as_ref().ok().cloned(),
                detection_error: detection.err(),
            }
        }
        Err(error) if error == "Tailscale is not installed" => TailscaleServeStatus {
            installed: false,
            json: None,
            error: None,
            detected: None,
            detection_error: None,
        },
        Err(error) => TailscaleServeStatus {
            installed: true,
            json: None,
            error: Some(error),
            detected: None,
            detection_error: None,
        },
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{install_mobile_binary, mobile_binary_source, systemd_unit};
    use std::path::Path;

    /// The install must read the running *image*, not a path that may no longer
    /// name it: a rebuild or an update over a live Tabtivity makes
    /// `current_exe()` resolve to `… (deleted)`, and the reinstall behind
    /// Reconnect then dies at its copy step with `os error 2` before the
    /// service manager is asked for anything.
    #[test]
    fn the_sidecar_is_copied_from_the_running_image_not_a_path_that_can_vanish() {
        let source = mobile_binary_source().expect("source");
        assert_eq!(
            source,
            Path::new("/proc/self/exe"),
            "a resolved path can carry ` (deleted)` and open as ENOENT"
        );
        let temp = tempfile::tempdir().expect("temp directory");
        let target = install_mobile_binary(&source, temp.path()).expect("install");
        assert_eq!(
            std::fs::read(&target).expect("installed bytes"),
            std::fs::read(&source).expect("running image"),
            "the installed sidecar should be this binary"
        );
    }

    #[test]
    fn systemd_unit_quotes_the_installed_path() {
        let unit = systemd_unit(Path::new("/tmp/mobile host%1")).expect("unit");
        assert!(unit.contains("ExecStart=\"/tmp/mobile host%%1\" --mobile-host"));
    }

    #[test]
    fn systemd_unit_never_hides_the_tmux_socket_behind_a_private_tmp() {
        let unit =
            systemd_unit(Path::new(concat!("/opt/", crate::app_slug!(), "-mobile-host"))).expect("unit");
        // tmux listens on /tmp/tmux-$UID/default. A private /tmp makes every tab
        // report `available: false` with nothing in the log to explain it, on
        // exactly those systems that permit unprivileged user namespaces.
        assert!(
            !unit.contains("PrivateTmp"),
            "PrivateTmp hides the desktop's tmux socket from the sidecar"
        );
        assert!(!unit.contains("BindPaths"), "see systemd_unit's rationale");
        // The hardening that costs nothing stays.
        assert!(unit.contains("NoNewPrivileges=true"));
    }

    /// The sidecar now spawns fenced agents itself (a phone "+ Claude" with the
    /// window closed). Any directive that has systemd build a mount namespace
    /// makes an unprivileged user manager open a user namespace first — which
    /// Ubuntu's AppArmor confines into `unprivileged_userns` (every capability
    /// denied) instead of refusing — and systemd then runs the service inside
    /// it when the mounts fail. Every `bwrap` the sidecar spawns inherits that
    /// profile, cannot create its sandbox, and the fence fails closed with
    /// "bubblewrap is unavailable" on a machine where the window fences fine.
    #[test]
    fn systemd_unit_asks_systemd_for_no_namespace_at_all() {
        let unit =
            systemd_unit(Path::new(concat!("/opt/", crate::app_slug!(), "-mobile-host"))).expect("unit");
        let service = unit
            .split("[Service]")
            .nth(1)
            .and_then(|rest| rest.split("\n[").next())
            .expect("a [Service] section");
        let offending: Vec<&str> = service
            .lines()
            .filter(|line| {
                line.split_once('=')
                    .is_some_and(|(key, _)| super::MOUNT_NAMESPACE_DIRECTIVES.contains(&key.trim()))
            })
            .collect();
        assert!(
            offending.is_empty(),
            "these directives put the sidecar — and its agent fence — in a capability-less user namespace: {offending:?}"
        );
    }

    #[test]
    fn systemd_unit_survives_a_transient_tailscale_outage() {
        let unit =
            systemd_unit(Path::new(concat!("/opt/", crate::app_slug!(), "-mobile-host"))).expect("unit");
        // The sidecar exits non-zero while tailscaled is down so it is
        // restarted — but systemd's default start limit (5 in 10s) turns a
        // fast crash loop into a permanently `failed` unit. The limit must be
        // off and the retries paced.
        assert!(
            unit.contains("StartLimitIntervalSec=0"),
            "the default start limit permanently kills the unit mid-outage"
        );
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("RestartSec=5"));
    }
}


#[cfg(test)]
mod sidecar_staleness_tests {
    use super::{binary_behind, launch_host, LaunchHost};
    use std::{
        path::Path,
        time::{Duration, SystemTime},
    };

    /// Write `bytes` and stamp the file `age` seconds before now, so the two
    /// sides' order is the test's rather than the filesystem's timestamp
    /// granularity.
    fn file(path: &Path, bytes: &[u8], age: u64) {
        std::fs::write(path, bytes).expect("write");
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open")
            .set_modified(SystemTime::now() - Duration::from_secs(age))
            .expect("stamp");
    }

    /// A version string cannot see this: the installed copy and the window are
    /// the same version, and the copy is an earlier build of it.
    #[test]
    fn an_older_same_version_copy_is_behind_the_running_image() {
        let temp = tempfile::tempdir().expect("temp directory");
        let installed = temp.path().join("installed");
        let running = temp.path().join("running");
        file(&installed, b"sidecar bytes", 600);
        file(&running, b"sidecar bytes", 60);

        assert!(binary_behind(&installed, &running));
    }

    #[test]
    fn a_copy_of_another_size_is_behind_whichever_way_the_clock_went() {
        let temp = tempfile::tempdir().expect("temp directory");
        let installed = temp.path().join("installed");
        let running = temp.path().join("running");
        file(&installed, b"an older, longer sidecar", 60);
        file(&running, b"sidecar bytes", 600);

        assert!(binary_behind(&installed, &running));
    }

    /// What a finished install leaves: the same bytes, written after the image
    /// they were copied from. The panel must stop offering the update.
    #[test]
    fn the_copy_an_install_just_wrote_is_not_behind() {
        let temp = tempfile::tempdir().expect("temp directory");
        let installed = temp.path().join("installed");
        let running = temp.path().join("running");
        file(&running, b"sidecar bytes", 600);
        file(&installed, b"sidecar bytes", 60);

        assert!(!binary_behind(&installed, &running));
    }

    /// Nothing installed yet, or a running image no path names any more: quiet,
    /// not an update the install step would then fail to read.
    #[test]
    fn a_missing_file_on_either_side_claims_nothing() {
        let temp = tempfile::tempdir().expect("temp directory");
        let running = temp.path().join("running");
        file(&running, b"sidecar bytes", 60);

        assert!(!binary_behind(&temp.path().join("absent"), &running));
        assert!(!binary_behind(&running, &temp.path().join("absent")));
    }

    /// A launch brings the phone's host up to the window's build by itself —
    /// the Update host button was the only way, and a new route stayed 404.
    #[test]
    fn a_launch_updates_a_host_that_is_behind_and_only_starts_a_current_one() {
        let temp = tempfile::tempdir().expect("temp directory");
        let running = temp.path().join("running");
        let copy = temp.path().join("copy");
        let absent = temp.path().join("absent");
        file(&running, b"sidecar bytes", 600);
        file(&copy, b"sidecar bytes", 60);

        // Current copy: keep a running host, start a stopped one.
        assert_eq!(launch_host(Some(Some("1.2.3")), &copy, &running, "1.2.3"), LaunchHost::Keep);
        assert_eq!(launch_host(None, &copy, &running, "1.2.3"), LaunchHost::Start);
        // This version was never installed (a version bump): the unit still
        // points at the last version's copy.
        assert_eq!(launch_host(None, &absent, &running, "1.2.3"), LaunchHost::Update);
        // The host answering is another version, though this one's copy exists.
        assert_eq!(launch_host(Some(Some("1.2.2")), &copy, &running, "1.2.3"), LaunchHost::Update);
        assert_eq!(launch_host(Some(None), &copy, &running, "1.2.3"), LaunchHost::Update);
        // Same version, an earlier build — the dev-build case.
        file(&copy, b"sidecar bytes", 900);
        assert_eq!(launch_host(Some(Some("1.2.3")), &copy, &running, "1.2.3"), LaunchHost::Update);
        assert_eq!(launch_host(None, &copy, &running, "1.2.3"), LaunchHost::Update);
    }
}

#[cfg(all(test, unix))]
mod unix_install_tests {
    use super::install_mobile_binary;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn install_mobile_binary_atomically_replaces_an_existing_target() {
        let temp = tempfile::tempdir().expect("temp directory");
        let source = temp.path().join("source");
        let target_dir = temp.path().join("bin");
        std::fs::create_dir(&target_dir).expect("target directory");
        std::fs::write(&source, b"new mobile host").expect("source");
        std::fs::write(target_dir.join(concat!(crate::app_slug!(), "-mobile-host")), b"old mobile host")
            .expect("existing target");

        let target = install_mobile_binary(&source, &target_dir).expect("install");

        assert_eq!(
            std::fs::read(&target).expect("installed bytes"),
            b"new mobile host"
        );
        assert_eq!(
            std::fs::metadata(&target)
                .expect("installed metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::read_dir(&target_dir)
                .expect("target directory")
                .count(),
            1,
            "atomic install should not leave its staged file behind"
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
mod launchd_tests {
    use super::{launchd_plist, LAUNCHD_LABEL};
    use std::path::Path;

    #[test]
    fn launchd_plist_escapes_the_binary_path_and_runs_the_host_flag() {
        let plist = launchd_plist(Path::new("/tmp/mobile <&> host"));
        assert!(plist.contains("<string>/tmp/mobile &lt;&amp;&gt; host</string>"));
        assert!(plist.contains("<string>--mobile-host</string>"));
        assert!(plist.contains(&format!("<string>{LAUNCHD_LABEL}</string>")));
    }

    #[test]
    fn launchd_plist_restarts_on_failure_but_not_on_a_disabled_exit() {
        let plist = launchd_plist(Path::new(concat!("/opt/", crate::app_slug!(), "-mobile-host")));
        // The disabled configuration exits 0 and must stay down; a Serve
        // verification failure exits non-zero and must come back.
        assert!(plist.contains("<key>SuccessfulExit</key>"));
        assert!(plist.contains("<false/>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<key>ThrottleInterval</key>"));
    }
}

#[cfg(all(test, windows))]
mod windows_service_tests {
    use super::run_command_line;
    use std::path::Path;

    #[test]
    fn run_command_line_quotes_the_binary_and_refuses_quote_smuggling() {
        let line = run_command_line(Path::new(concat!(r"C:\Users\a b\", crate::app_slug!(), r"-mobile-host.exe")))
            .expect("command line");
        assert_eq!(line, concat!("\"C:\\Users\\a b\\", crate::app_slug!(), "-mobile-host.exe\" --mobile-host"));
        assert!(run_command_line(Path::new("C:\\a\"b.exe")).is_err());
    }
}

#[cfg(unix)]
fn trusted_peer(stream: &tokio::net::UnixStream) -> bool {
    stream
        .peer_cred()
        .ok()
        .map(|c| c.uid())
        .is_some_and(|uid| uid == unsafe { libc::geteuid() })
}

/// One accepted, already-authenticated desktop-control connection: read the
/// sidecar's request, relay it to the main window, and write the answer back.
async fn handle_desktop_stream<S>(mut stream: S, app: AppHandle, state: MobileDesktopState)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let Ok(Ok(request)) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        read_frame::<DesktopRequest>(&mut stream),
    )
    .await
    else {
        return;
    };
    let id = request.request_id().to_string();
    // Reading an uncached message may perform one bounded BODY.PEEK, and an
    // agent status may run the agent's CLI once. Both stay below the sidecar's
    // own deadline so a slow answer is stated, not lost; every other control
    // request keeps its short SLA.
    let response_timeout = request.desktop_timeout();
    let mutation = request.is_mutation();
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id.clone(), tx);
    if app.emit_to("main", MOBILE_DESKTOP_EVENT, request).is_err() {
        state.pending.lock().unwrap().remove(&id);
        let _ = write_frame(
            &mut stream,
            &DesktopResponse::Error {
                code: "desktop_unavailable".into(),
                message: "No desktop window is available".into(),
            },
        )
        .await;
        return;
    }
    let response = tokio::time::timeout(response_timeout, rx)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(DesktopResponse::Error {
            code: "desktop_unavailable".into(),
            message: "Desktop did not answer".into(),
        });
    state.pending.lock().unwrap().remove(&id);
    // Under the response cap, not the request one; an answer too large even
    // for that is stated to the sidecar rather than dropped — and for a
    // mutation, stated as applied: the window has made the change by now, so
    // the phone must reload rather than be invited to send it again.
    let _ = admin::write_desktop_response(&mut stream, &response, mutation).await;
}

/// Binds of the desktop bridge's socket before it gives up, a second apart.
#[cfg(unix)]
const DESKTOP_BRIDGE_BIND_TRIES: u32 = 5;

#[cfg(unix)]
pub fn start_desktop_bridge(app: AppHandle, state: MobileDesktopState) {
    let socket = storage::state_dir().join("mobile-control/desktop-control.sock");
    tauri::async_runtime::spawn(async move {
        use std::os::unix::fs::PermissionsExt;
        if let Some(parent) = socket.parent() {
            let _ = std::fs::create_dir_all(parent);
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
        // A bridge that never listens leaves every phone request that needs
        // the desktop reading `desktop_unavailable` for the whole session, and
        // it used to give up on the first failed bind without a word. A few
        // tries a second apart ride out a state dir or a stale socket file
        // that is still settling — the `remove_file` goes before each one —
        // and a bind that still fails is said on stderr.
        let mut tries = 0;
        let listener = loop {
            let _ = std::fs::remove_file(&socket);
            match tokio::net::UnixListener::bind(&socket) {
                Ok(listener) => break listener,
                Err(error) => {
                    tries += 1;
                    if tries >= DESKTOP_BRIDGE_BIND_TRIES {
                        eprintln!(
                            "mobile host: desktop bridge cannot listen on {} after {tries} tries: {error}",
                            socket.display()
                        );
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        };
        let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));
        loop {
            // One transient accept failure (EMFILE, ECONNABORTED) must not end
            // the bridge for the rest of the session — it did, and from then
            // on every phone request that needs the desktop read
            // `desktop_unavailable` with the window wide open. The same net
            // `admin::serve` has.
            let Ok((stream, _)) = listener.accept().await else {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            };
            if !trusted_peer(&stream) {
                continue;
            }
            let app = app.clone();
            let state = state.clone();
            tauri::async_runtime::spawn(handle_desktop_stream(stream, app, state));
        }
    });
}

/// The Windows bridge speaks the same frames over a named pipe, with the
/// sidecar proving itself via the same-user token the listener writes beside
/// the nominal socket path — see `services::mobile_control::admin::pipe`.
#[cfg(windows)]
pub fn start_desktop_bridge(app: AppHandle, state: MobileDesktopState) {
    use crate::services::mobile_control::admin::pipe;
    let socket = storage::state_dir().join("mobile-control/desktop-control.sock");
    tauri::async_runtime::spawn(async move {
        use tokio::net::windows::named_pipe::ServerOptions;
        let name = pipe::pipe_name(&socket);
        // Either failure leaves every phone request that needs the desktop
        // reading `desktop_unavailable` for the whole session; say why.
        let token = match pipe::create_token(&socket) {
            Ok(token) => token,
            Err(error) => {
                eprintln!("mobile host: desktop bridge cannot write its pipe token: {error}");
                return;
            }
        };
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(server) => server,
            Err(error) => {
                eprintln!("mobile host: desktop bridge cannot create its pipe: {error}");
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
            let Ok(next) = ServerOptions::new().create(&name) else {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            };
            let mut stream = std::mem::replace(&mut server, next);
            let app = app.clone();
            let state = state.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                let presented = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    read_frame::<String>(&mut stream),
                )
                .await;
                let authorized =
                    matches!(&presented, Ok(Ok(value)) if pipe::token_matches(value, &token));
                if !authorized {
                    return;
                }
                handle_desktop_stream(stream, app, state).await;
            });
        }
    });
}

#[cfg(not(any(unix, windows)))]
pub fn start_desktop_bridge(_: AppHandle, _: MobileDesktopState) {}

#[cfg(test)]
mod prune_tests {
    use super::prune_old_versions;

    #[test]
    fn prune_keeps_the_installed_version_and_removes_every_other() {
        let temp = tempfile::tempdir().expect("temp directory");
        let bin = temp.path().join("bin");
        for version in ["0.1.52", "0.1.57", "0.1.58"] {
            let dir = bin.join(version);
            std::fs::create_dir_all(&dir).expect("version directory");
            std::fs::write(dir.join(concat!(crate::app_slug!(), "-mobile-host")), b"host").expect("binary");
        }
        // A stray file beside the version directories — the control dir also
        // holds sockets and json, and a sweep here must not reach outside its
        // own shape.
        std::fs::write(bin.join("notes.txt"), b"x").expect("stray");

        prune_old_versions(&bin, "0.1.58");

        assert!(bin.join("0.1.58").exists(), "the installed version stays");
        assert!(!bin.join("0.1.52").exists());
        assert!(!bin.join("0.1.57").exists());
        assert!(bin.join("notes.txt").exists(), "files are not version dirs");
    }

    #[test]
    fn prune_is_a_no_op_when_the_store_does_not_exist_yet() {
        let temp = tempfile::tempdir().expect("temp directory");
        prune_old_versions(&temp.path().join("nope"), "0.1.58");
    }
}

#[cfg(test)]
mod stay_after_quit_tests {
    use super::{stays_after_quit, HostConfig};

    fn config(host: &str) -> HostConfig {
        let temp = tempfile::tempdir().expect("temp directory");
        let settings = format!(
            r#"{{"{}":{{"enabled":true,"serve_origin":"https://desk.example.ts.net"{host}}}}}"#,
            crate::brand::MOBILE_HOST_KEY
        );
        std::fs::write(temp.path().join("settings.json"), settings).expect("settings");
        HostConfig::load(temp.path()).expect("config")
    }

    /// A quit stops the host unless the user switched it to stay; an older
    /// settings file without the key keeps the old behaviour.
    #[test]
    fn a_quit_leaves_the_host_up_only_when_the_user_asked() {
        assert!(!stays_after_quit(&config("")));
        assert!(!stays_after_quit(&config(r#","stay_after_quit":false"#)));
        assert!(stays_after_quit(&config(r#","stay_after_quit":true"#)));
    }
}
