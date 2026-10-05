//! The migrator on this machine: where its folders are, and how it reaches
//! the service manager. Everything here touches the real system, so none of
//! it runs under test — the steps themselves take an [`Env`] and a [`World`]
//! and are tested with temp dirs and a recording world.

use std::path::Path;

use super::{Env, World};
use crate::brand::{Name, Pair, PAIR};

/// The production [`World`].
pub struct Host;

impl World for Host {
    fn retire_legacy_mobile_host(&self, pair: &Pair, legacy_state_dir: &Path) -> Result<bool, String> {
        retire_legacy_mobile_host(pair, legacy_state_dir)
    }

    fn stop_host_in(&self, state_dir: &Path) {
        shut_down_host_in(state_dir);
        // Its executable locks the folder until the process is gone.
        #[cfg(windows)]
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// Ask a host that still answers on `state_dir`'s control socket to shut
/// down. Best effort and bounded; nothing listening answers at once.
fn shut_down_host_in(state_dir: &Path) {
    use crate::services::mobile_control::{admin, protocol::AdminRequest};
    let socket = state_dir.join("mobile-control").join("admin.sock");
    let _ = tauri::async_runtime::block_on(admin::admin_call(&socket, &AdminRequest::Shutdown));
}

#[cfg(target_os = "linux")]
fn retire_legacy_mobile_host(pair: &Pair, legacy_state_dir: &Path) -> Result<bool, String> {
    let Some(unit) = pair.legacy(Name::MOBILE_HOST_UNIT) else {
        return Ok(false);
    };
    let unit_path = crate::paths::home_dir().join(".config").join("systemd").join("user").join(&unit);
    if !unit_path.exists() {
        return Ok(false);
    }
    shut_down_host_in(legacy_state_dir);
    // A unit that is not loaded makes `disable --now` fail, which is the
    // state wanted anyway; the file's removal below is what counts.
    let _ = crate::paths::command_no_window("systemctl")
        .args(["--user", "disable", "--now", &unit])
        .status();
    std::fs::remove_file(&unit_path).map_err(|e| format!("remove {}: {e}", unit_path.display()))?;
    let _ = crate::paths::command_no_window("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    Ok(true)
}

#[cfg(target_os = "macos")]
fn retire_legacy_mobile_host(pair: &Pair, legacy_state_dir: &Path) -> Result<bool, String> {
    let Some(label) = pair.legacy(Name::MOBILE_HOST_LAUNCHD_LABEL) else {
        return Ok(false);
    };
    let plist = crate::paths::home_dir()
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{label}.plist"));
    if !plist.exists() {
        return Ok(false);
    }
    shut_down_host_in(legacy_state_dir);
    let uid = unsafe { libc::getuid() };
    // Fails when the agent is not loaded, which is the state wanted anyway.
    let _ = crate::paths::command_no_window("launchctl")
        .args(["bootout", &format!("gui/{uid}/{label}")])
        .status();
    std::fs::remove_file(&plist).map_err(|e| format!("remove {}: {e}", plist.display()))?;
    Ok(true)
}

#[cfg(windows)]
fn retire_legacy_mobile_host(pair: &Pair, legacy_state_dir: &Path) -> Result<bool, String> {
    let Some(value) = pair.legacy(Name::MOBILE_HOST_RUN_VALUE) else {
        return Ok(false);
    };
    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let registered = crate::paths::command_no_window("reg")
        .args(["query", RUN_KEY, "/v", &value])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    // The old host answers on a pipe named after the old state dir's socket
    // path and the old prefix; `admin::pipe::connect` tries that name too.
    // Its executable locks the folder until it is gone, so give it a moment.
    shut_down_host_in(legacy_state_dir);
    std::thread::sleep(std::time::Duration::from_millis(500));
    if !registered {
        return Ok(false);
    }
    let _ = crate::paths::command_no_window("reg")
        .args(["delete", RUN_KEY, "/v", &value, "/f"])
        .status();
    Ok(true)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn retire_legacy_mobile_host(_pair: &Pair, _legacy_state_dir: &Path) -> Result<bool, String> {
    Ok(false)
}

impl<'a> Env<'a> {
    /// The running app's folders.
    ///
    /// A state dir named by the environment marks a sandboxed instance (a
    /// dev window beside the daily-driver one, a test). It gets no
    /// machine-wide step: its state dir stays where the environment put it,
    /// and it must not stop the real phone host, move the real per-user
    /// folder or copy the real webview data.
    pub fn for_this_machine(world: &'a dyn World) -> Env<'a> {
        let pair = PAIR;
        let sandboxed = crate::storage::state_dir_override().is_some();
        let old_name = pair.legacy(Name::STATE_DIR_NAME);
        let cur_name = pair.cur(Name::STATE_DIR_NAME);
        let base = crate::storage::state_dir_base();
        let (state_dir, legacy_state_dir) = match crate::storage::state_dir_override() {
            Some(dir) => (dir, None),
            None => (base.join(&cur_name), old_name.as_ref().map(|old| base.join(old))),
        };
        let share_base = crate::storage::home_share_base();
        let share_dir = old_name
            .as_ref()
            .filter(|_| !sandboxed)
            .map(|old| (share_base.join(old), share_base.join(&cur_name)))
            .filter(|(old, _)| Some(old) != legacy_state_dir.as_ref());
        let webview_data = pair
            .legacy(Name::APP_IDENTIFIER)
            .filter(|_| !sandboxed)
            .and_then(|old| {
                Some((
                    crate::services::state_gc::webview_data_root(&old)?,
                    crate::services::state_gc::webview_data_root(&pair.cur(Name::APP_IDENTIFIER))?,
                ))
            });
        Env {
            pair,
            state_dir,
            legacy_state_dir,
            share_dir,
            webview_data,
            home_trees: vec![crate::paths::app_home()],
            machine_wide: !sandboxed,
            world,
            now: crate::storage::iso_now,
            crash_at: None,
            fail_at: None,
        }
    }
}

/// Run the launch steps on this machine. Called at the top of `run`, before
/// anything creates or opens the state dir and before the webview exists.
/// Returns at once while the name is unchanged.
pub fn run_at_launch() {
    if !PAIR.renamed() {
        return;
    }
    let report = super::run_startup(&Env::for_this_machine(&Host));
    for (step, reason) in &report.pending {
        eprintln!("brand migration: {step} is pending: {reason}");
    }
}
