//! The session host's Windows layer (plan §2): the Job Object, the ConPTY
//! spawner, the named pipe and [`run_host`], the `--session-host` process.

pub mod conpty;
pub mod job;
pub mod pipe;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE};

use super::copies;
use super::server::{Host, HostConfig};
use super::table::SystemClock;
use crate::services::local_pipe;

/// A kernel handle closed on drop.
pub(crate) struct OwnedHandle(pub(crate) HANDLE);

// SAFETY: a kernel handle value may be used and closed from any thread.
unsafe impl Send for OwnedHandle {}
// SAFETY: as above; nothing here mutates through a shared reference.
unsafe impl Sync for OwnedHandle {}

impl OwnedHandle {
    /// Gives the handle up without closing it.
    pub(crate) fn into_raw(self) -> HANDLE {
        let h = self.0;
        std::mem::forget(self);
        h
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // SAFETY: owned and closed exactly once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// How a host process runs.
#[derive(Debug, Clone)]
pub struct HostOptions {
    /// Exit after this long with no sessions and no connections.
    pub idle_exit_ms: u64,
    /// How often exited children are reaped, the idle rule is checked and
    /// `sessions.json` is refreshed.
    pub tick: Duration,
}

impl Default for HostOptions {
    fn default() -> Self {
        Self { idle_exit_ms: 60_000, tick: Duration::from_secs(1) }
    }
}

/// How [`run_host`] ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostEnd {
    /// Idle past its limit, or `Shutdown` asked.
    Exited,
    /// Another host already serves this state dir; this one never started.
    AlreadyRunning,
}

/// The `--session-host` process for `state_dir`: claim the single instance,
/// mint the token, bind the pipe, serve until idle or shut down. Writes
/// `session-host/sessions.json` at start-up and whenever the set changes. Its
/// sessions die with it (`KILL_ON_JOB_CLOSE`).
pub async fn run_host(state_dir: &Path, opts: HostOptions) -> Result<HostEnd, String> {
    let control_dir = crate::services::mobile_control::config::control_dir_for(state_dir);
    let root = copies::host_root(&control_dir);
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let instance =
        pipe::claim_instance(&pipe::mutex_name(state_dir)).map_err(|e| format!("session host mutex: {e}"))?;
    let Some(instance) = instance else {
        return Ok(HostEnd::AlreadyRunning);
    };
    // Only the one host writes the token, before the pipe exists: a client
    // that can open the pipe finds the token beside it.
    let token = local_pipe::create_token_at(&copies::token_path(&control_dir))?;
    let name = pipe::pipe_name(state_dir);
    let listener = pipe::Listener::bind(&name).map_err(|e| format!("bind session host pipe: {e}"))?;
    // `<version>+<build>`: a client of another build of this version
    // retires this host once it is idle (`copies::should_retire`).
    let exe = std::env::current_exe().ok();
    let build = exe.as_deref().and_then(copies::read_build_id);
    let identity = copies::identity(env!("CARGO_PKG_VERSION"), build.as_deref());
    let running_dir =
        exe.as_deref().and_then(|exe| exe.parent()?.file_name()).map(|n| n.to_string_lossy().into_owned());
    let mut running = vec![identity.as_str()];
    running.extend(running_dir.as_deref());
    super::launch::prune_copies(&control_dir, &identity, &running);

    let mut cfg = HostConfig::new(token, identity.clone(), std::process::id());
    cfg.idle_exit_ms = opts.idle_exit_ms;
    let host = Host::new(cfg, conpty::ConPtySpawner, Arc::new(SystemClock));
    let mut accept = tokio::spawn(pipe::serve(host.clone(), listener));
    let sessions_path = copies::sessions_path(&control_dir);
    let mut written: Option<Vec<u8>> = None;
    let mut interval = tokio::time::interval(opts.tick);
    loop {
        interval.tick().await;
        let exit = host.tick();
        let bytes = copies::sessions_json(&host.sessions());
        if written.as_ref() != Some(&bytes) && crate::storage::write_private_atomic(&sessions_path, &bytes).is_ok() {
            written = Some(bytes);
        }
        if !exit {
            continue;
        }
        // Stop accepting, then look again: a client accepted before the stop
        // is counted (`Host::spawn_serve`) and calls the exit off.
        accept.abort();
        let _ = (&mut accept).await;
        if !host.resume_if_connected() {
            break;
        }
        match pipe::Listener::bind_more(&name) {
            Ok(listener) => accept = tokio::spawn(pipe::serve(host.clone(), listener)),
            Err(e) => {
                eprintln!("session host: cannot listen again after a called-off exit: {e}");
                break;
            }
        }
    }
    // The pipe is gone (the accept task awaited) before the name is free
    // for the next host.
    drop(instance);
    Ok(HostEnd::Exited)
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::WAIT_TIMEOUT;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    use super::OwnedHandle;

    pub fn system_dir() -> std::path::PathBuf {
        let mut buf = [0u16; 512];
        // SAFETY: the buffer is passed with its length.
        let n = unsafe { GetSystemDirectoryW(Some(&mut buf)) } as usize;
        assert!(n > 0 && n < buf.len());
        std::path::PathBuf::from(String::from_utf16(&buf[..n]).unwrap())
    }

    pub fn cmd_exe() -> String {
        system_dir().join("cmd.exe").to_string_lossy().into_owned()
    }

    pub fn ping_exe() -> String {
        system_dir().join("PING.EXE").to_string_lossy().into_owned()
    }

    pub fn current_env() -> Vec<(String, String)> {
        std::env::vars().collect()
    }

    pub fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if f() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub async fn wait_until_async(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if f() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Children of `parent` whose program's file stem is `stem` (any case).
    pub fn child_pids(parent: u32, stem: &str) -> Vec<u32> {
        let mut out = Vec::new();
        // SAFETY: the snapshot handle is owned by its guard; each entry is
        // read after the call that filled it.
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let snap = OwnedHandle(snap);
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut ok = Process32FirstW(snap.0, &mut entry).is_ok();
            while ok {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
                let exe_stem = std::path::Path::new(&exe).file_stem().map(|s| s.to_string_lossy().to_lowercase());
                if entry.th32ParentProcessID == parent && exe_stem.as_deref() == Some(&stem.to_lowercase()) {
                    out.push(entry.th32ProcessID);
                }
                ok = Process32NextW(snap.0, &mut entry).is_ok();
            }
        }
        out
    }

    /// A test's state dir with an in-process host (real ConPTYs) on its
    /// pipe, and the [`Launch`](crate::services::session_host::launch::Launch)
    /// a client uses to reach it. The source is this test binary: a lazy
    /// start never happens, the host is already up.
    pub(crate) struct TestHost {
        pub _tmp: tempfile::TempDir,
        pub launch: crate::services::session_host::launch::Launch,
        pub _host: crate::services::session_host::server::Host,
    }

    /// Needs a runtime: the host's accept loop is spawned on it.
    pub(crate) fn test_host() -> TestHost {
        use crate::services::session_host::{copies, launch::Launch, server, table::SystemClock};
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let control = crate::services::mobile_control::config::control_dir_for(&state);
        std::fs::create_dir_all(copies::host_root(&control)).unwrap();
        let token = crate::services::local_pipe::create_token_at(&copies::token_path(&control)).unwrap();
        let launch = Launch {
            state_dir: state.clone(),
            control_dir: control,
            source: std::env::current_exe().unwrap(),
            version: env!("CARGO_PKG_VERSION").into(),
        };
        let host = server::Host::new(
            server::HostConfig::new(token, launch.identity(), std::process::id()),
            super::conpty::ConPtySpawner,
            std::sync::Arc::new(SystemClock),
        );
        let listener = super::pipe::Listener::bind(&super::pipe::pipe_name(&state)).unwrap();
        tokio::spawn(super::pipe::serve(host.clone(), listener));
        TestHost { _tmp: tmp, launch, _host: host }
    }

    const ECHO_LOG_ENV: &str = "SESSION_HOST_TEST_ECHO_LOG";

    /// The stand-in TUI's argv and env: this test binary re-run as just
    /// [`echo_entry`], logging every byte it reads to `log`.
    pub(crate) fn echo_program(log: &std::path::Path) -> (Vec<String>, Vec<(String, String)>) {
        let exe = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let path = format!("{}::echo_entry", module_path!());
        let entry = path.split_once("::").map_or(path.clone(), |(_, rest)| rest.to_string());
        let argv = vec![exe, "--exact".into(), entry, "--ignored".into(), "--test-threads=1".into(), "-q".into()];
        let mut env = current_env();
        env.push((ECHO_LOG_ENV.into(), log.to_string_lossy().into_owned()));
        (argv, env)
    }

    /// Run by the host as a session's program: its console raw as node's raw
    /// mode sets it (VT input on; processed, line and echo input off — so
    /// Ctrl+C is the byte 0x03, no `CTRL_C_EVENT`), bracketed paste on, every
    /// byte read appended to the log.
    #[test]
    #[ignore]
    fn echo_entry() {
        use std::io::{Read, Write};
        use windows::Win32::System::Console::{
            GetConsoleMode, GetStdHandle, SetConsoleCP, SetConsoleMode, SetConsoleOutputCP, CONSOLE_MODE,
            ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT, ENABLE_QUICK_EDIT_MODE,
            ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        };
        let Ok(log) = std::env::var(ECHO_LOG_ENV) else { return };
        // SAFETY: plain console calls on this process's own std handles.
        unsafe {
            let input = GetStdHandle(STD_INPUT_HANDLE).unwrap();
            let output = GetStdHandle(STD_OUTPUT_HANDLE).unwrap();
            let _ = SetConsoleCP(65001);
            let _ = SetConsoleOutputCP(65001);
            let mut mode = CONSOLE_MODE(0);
            if GetConsoleMode(input, &mut mode).is_ok() {
                let raw = (mode | ENABLE_VIRTUAL_TERMINAL_INPUT)
                    & !(ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_QUICK_EDIT_MODE);
                let _ = SetConsoleMode(input, raw);
            }
            let mut mode = CONSOLE_MODE(0);
            if GetConsoleMode(output, &mut mode).is_ok() {
                let _ = SetConsoleMode(output, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
            }
        }
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&log).unwrap();
        let mut out = std::io::stdout();
        let _ = out.write_all(b"\x1b[?2004hECHO-READY\r\n");
        let _ = out.flush();
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        while let Ok(n) = stdin.read(&mut buf) {
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).unwrap();
            file.flush().unwrap();
            let _ = out.write_all(format!("got {n}\r\n").as_bytes());
            let _ = out.flush();
        }
    }

    pub fn process_alive(pid: u32) -> bool {
        // SAFETY: the handle is owned by its guard.
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let h = OwnedHandle(h);
            WaitForSingleObject(h.0, 0) == WAIT_TIMEOUT
        }
    }
}

#[cfg(test)]
mod tests;
