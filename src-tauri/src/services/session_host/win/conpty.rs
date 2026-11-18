//! The host's [`PtySpawner`] on Windows: its own ConPTY spawn, with the child
//! put into a fresh [`Job`] by `PROC_THREAD_ATTRIBUTE_JOB_LIST` — assigned at
//! creation, before its first instruction, so no grandchild can start outside
//! it (plan §2, option a). `argv[0]` is `lpApplicationName` (the command line
//! never picks the program, `PATH` is never searched); the environment block
//! is exactly the client's env. Resize is `ResizePseudoConsole`; kill is
//! `TerminateJobObject`, the whole subtree at once.
//!
//! A waiter thread per child closes the pseudoconsole once the child has
//! exited (after a short grace so conhost paints its last frame): that is
//! what ends the output pipe, so the host's reader sees EOF. Processes still
//! attached to the console end with it; anything else left in the job ends
//! when the session drops its [`ConPty`] (`KILL_ON_JOB_CLOSE`).

use std::fs::File;
use std::io;
use std::os::windows::io::FromRawHandle;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList,
    UpdateProcThreadAttribute, WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
    INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use super::job::Job;
use super::OwnedHandle;
use crate::services::session_host::cmdline::{command_line, env_block};
use crate::services::session_host::server::{Pty, PtySpawner, SpawnSpec, Spawned};

/// How long the waiter lets conhost flush after the child exited before the
/// pseudoconsole closes.
const EXIT_GRACE: Duration = Duration::from_millis(200);

struct Hpc(HPCON);
// SAFETY: an HPCON is an opaque handle value; the console API may be called
// on it from any thread, and the mutex below serialises close vs resize.
unsafe impl Send for Hpc {}

type SharedHpc = Arc<Mutex<Option<Hpc>>>;

/// Closes the pseudoconsole once, outside the lock (it may wait for the
/// output pipe to drain on older Windows).
fn close_hpc(hpc: &SharedHpc) {
    let taken = hpc.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(Hpc(h)) = taken {
        // SAFETY: `h` came from CreatePseudoConsole and is closed exactly once.
        unsafe { ClosePseudoConsole(h) };
    }
}

fn coord(cols: u16, rows: u16) -> COORD {
    COORD { X: cols.clamp(1, i16::MAX as u16) as i16, Y: rows.clamp(1, i16::MAX as u16) as i16 }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// One ConPTY child and its job.
pub struct ConPty {
    job: Job,
    process: Arc<OwnedHandle>,
    pid: u32,
    hpc: SharedHpc,
}

impl ConPty {
    pub fn job(&self) -> &Job {
        &self.job
    }
}

impl Pty for ConPty {
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let guard = self.hpc.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Hpc(h)) = guard.as_ref() {
            // SAFETY: the pseudoconsole is open while it is in the slot.
            unsafe { ResizePseudoConsole(*h, coord(cols, rows))? };
        }
        Ok(())
    }

    fn kill(&self) -> io::Result<()> {
        self.job.terminate(1)
    }

    fn try_wait(&self) -> io::Result<Option<i32>> {
        // SAFETY: the process handle is alive while `self` is.
        unsafe {
            if WaitForSingleObject(self.process.0, 0) != WAIT_OBJECT_0 {
                return Ok(None);
            }
            let mut code = 0u32;
            GetExitCodeProcess(self.process.0, &mut code)?;
            Ok(Some(code as i32))
        }
    }

    fn pid(&self) -> Option<u32> {
        Some(self.pid)
    }
}

/// Deletes an initialised attribute list on every path out.
struct AttrList(LPPROC_THREAD_ATTRIBUTE_LIST);

impl Drop for AttrList {
    fn drop(&mut self) {
        // SAFETY: initialised by InitializeProcThreadAttributeList; its buffer
        // outlives this guard (declared before it).
        unsafe { DeleteProcThreadAttributeList(self.0) };
    }
}

/// The ConPTY + Job Object spawner.
#[derive(Debug, Clone, Copy, Default)]
pub struct ConPtySpawner;

impl PtySpawner for ConPtySpawner {
    fn spawn(&self, spec: &SpawnSpec) -> io::Result<Spawned> {
        let (pty, input, output) = spawn_conpty(spec)?;
        Ok(Spawned { pty: Arc::new(pty), input: Box::new(input), output: Box::new(output) })
    }
}

fn invalid(msg: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg)
}

/// Spawns `spec` in a new pseudoconsole and job: the control, the input
/// writer and the output reader.
pub fn spawn_conpty(spec: &SpawnSpec) -> io::Result<(ConPty, File, File)> {
    let program = spec.argv.first().ok_or(invalid("argv is empty"))?;
    let mut cmdline = wide(&command_line(&spec.argv).map_err(invalid)?);
    let app = wide(program);
    let cwd = spec.cwd.as_deref().map(wide);
    let env = env_block(&spec.env);
    let job = Job::new()?;

    // SAFETY: every handle is owned by a guard from creation on; the
    // attribute list, its buffer, the job-handle array and every string
    // buffer outlive CreateProcessW; the pseudoconsole is closed on every
    // failure path after it exists.
    unsafe {
        let (mut in_read, mut in_write) = (HANDLE::default(), HANDLE::default());
        CreatePipe(&mut in_read, &mut in_write, None, 0)?;
        let (in_read, in_write) = (OwnedHandle(in_read), OwnedHandle(in_write));
        let (mut out_read, mut out_write) = (HANDLE::default(), HANDLE::default());
        CreatePipe(&mut out_read, &mut out_write, None, 0)?;
        let (out_read, out_write) = (OwnedHandle(out_read), OwnedHandle(out_write));

        let hpc_raw = CreatePseudoConsole(coord(spec.cols, spec.rows), in_read.0, out_write.0, 0)?;
        let hpc: SharedHpc = Arc::new(Mutex::new(Some(Hpc(hpc_raw))));
        // The pseudoconsole holds its own copies; ours would keep the output
        // pipe from ever reaching EOF.
        drop(in_read);
        drop(out_write);

        let created = (|| -> io::Result<PROCESS_INFORMATION> {
            let mut size = 0usize;
            let _ = InitializeProcThreadAttributeList(None, 2, None, &mut size);
            let mut buf = vec![0u64; size.div_ceil(8).max(1)];
            let list = LPPROC_THREAD_ATTRIBUTE_LIST(buf.as_mut_ptr().cast());
            InitializeProcThreadAttributeList(Some(list), 2, None, &mut size)?;
            let list = AttrList(list);
            UpdateProcThreadAttribute(
                list.0,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                Some(hpc_raw.0 as *const core::ffi::c_void),
                std::mem::size_of::<HPCON>(),
                None,
                None,
            )?;
            let jobs = [job.raw()];
            UpdateProcThreadAttribute(
                list.0,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                Some(jobs.as_ptr().cast()),
                std::mem::size_of_val(&jobs),
                None,
                None,
            )?;
            let mut si = STARTUPINFOEXW::default();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            // Invalid std handles: without them a child of a host whose own
            // stdio is redirected would inherit those handles instead of the
            // pseudoconsole's.
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
            si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
            si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
            si.lpAttributeList = list.0;
            let mut pi = PROCESS_INFORMATION::default();
            let cwd_ptr = cwd.as_ref().map_or(PCWSTR::null(), |c| PCWSTR(c.as_ptr()));
            CreateProcessW(
                PCWSTR(app.as_ptr()),
                Some(PWSTR(cmdline.as_mut_ptr())),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                Some(env.as_ptr().cast()),
                cwd_ptr,
                &si.StartupInfo,
                &mut pi,
            )?;
            drop(list);
            drop(buf);
            Ok(pi)
        })();
        let pi = match created {
            Ok(pi) => pi,
            Err(e) => {
                close_hpc(&hpc);
                return Err(e);
            }
        };
        drop(OwnedHandle(pi.hThread));
        let process = Arc::new(OwnedHandle(pi.hProcess));

        let waiter = (process.clone(), hpc.clone());
        let spawned_waiter = std::thread::Builder::new().name(format!("session-host-wait-{}", pi.dwProcessId)).spawn(
            move || {
                let (process, hpc) = waiter;
                WaitForSingleObject(process.0, INFINITE);
                std::thread::sleep(EXIT_GRACE);
                close_hpc(&hpc);
            },
        );
        let pty = ConPty { job, process, pid: pi.dwProcessId, hpc: hpc.clone() };
        if let Err(e) = spawned_waiter {
            let _ = pty.kill();
            close_hpc(&hpc);
            return Err(e);
        }
        let input = File::from_raw_handle(in_write.into_raw().0);
        let output = File::from_raw_handle(out_read.into_raw().0);
        Ok((pty, input, output))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Read;

    use super::*;
    use crate::services::session_host::win::test_support::{
        child_pids, cmd_exe, current_env, ping_exe, process_alive, wait_until,
    };

    fn spec(argv: Vec<String>) -> SpawnSpec {
        SpawnSpec { argv, env: current_env(), cwd: None, cols: 80, rows: 25 }
    }

    /// Reads `output` on a thread until EOF, returning everything.
    fn drain(mut output: File) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = output.read(&mut buf) {
                if n == 0 {
                    break;
                }
                all.extend_from_slice(&buf[..n]);
            }
            all
        })
    }

    #[test]
    fn an_echo_comes_back_and_the_pipe_ends_when_the_child_does() {
        let (pty, _input, output) =
            spawn_conpty(&spec(vec![cmd_exe(), "/c".into(), "echo".into(), "conpty-echo-71".into()])).unwrap();
        let reader = drain(output);
        assert!(wait_until(Duration::from_secs(10), || matches!(pty.try_wait(), Ok(Some(_)))));
        assert_eq!(pty.try_wait().unwrap(), Some(0));
        let text = String::from_utf8_lossy(&reader.join().unwrap()).to_string();
        assert!(text.contains("conpty-echo-71"), "{text:?}");
    }

    #[test]
    fn a_grandchild_is_in_the_job_and_kill_ends_it() {
        let argv = vec![cmd_exe(), "/c".into(), ping_exe(), "-n".into(), "30".into(), "127.0.0.1".into()];
        let (pty, _input, output) = spawn_conpty(&spec(argv)).unwrap();
        let _reader = drain(output);
        let cmd_pid = pty.pid().unwrap();
        assert!(pty.job().contains(cmd_pid).unwrap());
        let mut pings = Vec::new();
        assert!(wait_until(Duration::from_secs(10), || {
            pings = child_pids(cmd_pid, "ping");
            !pings.is_empty()
        }));
        let ping = pings[0];
        assert!(pty.job().contains(ping).unwrap(), "the grandchild is a job member");
        pty.kill().unwrap();
        assert!(wait_until(Duration::from_secs(10), || !process_alive(ping)), "kill ends the grandchild");
        assert!(wait_until(Duration::from_secs(10), || matches!(pty.try_wait(), Ok(Some(_)))));
    }

    #[test]
    fn dropping_the_pty_ends_its_subtree() {
        let argv = vec![ping_exe(), "-n".into(), "30".into(), "127.0.0.1".into()];
        let (pty, input, output) = spawn_conpty(&spec(argv)).unwrap();
        let _reader = drain(output);
        let pid = pty.pid().unwrap();
        assert!(process_alive(pid));
        drop(input);
        drop(pty);
        assert!(wait_until(Duration::from_secs(10), || !process_alive(pid)), "closing the job ends the child");
    }

    #[test]
    fn resize_works_while_open_and_after_the_end() {
        let argv = vec![ping_exe(), "-n".into(), "30".into(), "127.0.0.1".into()];
        let (pty, _input, output) = spawn_conpty(&spec(argv)).unwrap();
        let _reader = drain(output);
        pty.resize(120, 40).unwrap();
        pty.kill().unwrap();
        assert!(wait_until(Duration::from_secs(10), || matches!(pty.try_wait(), Ok(Some(_)))));
        assert!(wait_until(Duration::from_secs(5), || pty.hpc.lock().unwrap().is_none()));
        pty.resize(90, 30).unwrap();
    }

    #[test]
    fn a_quote_in_the_program_is_refused_before_any_spawn() {
        let err = spawn_conpty(&spec(vec!["C:\\x\"y.exe".into()])).err().unwrap();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }
}
