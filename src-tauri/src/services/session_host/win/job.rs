//! A session's Job Object: its whole process subtree in one handle.
//! `KILL_ON_JOB_CLOSE` ends every member once the last handle closes — the
//! host dropping the session, or the host process dying (plan §2: host exit ⇒
//! its sessions die, like a tmux server crash). Breakaway is not allowed, so
//! a grandchild cannot leave. The ConPTY spawn assigns the child atomically
//! (`PROC_THREAD_ATTRIBUTE_JOB_LIST`), so nothing it starts escapes either.

use std::io;

use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

use super::OwnedHandle;

pub struct Job {
    handle: OwnedHandle,
}

impl Job {
    /// An unnamed job (not inheritable) that kills its members on close.
    pub fn new() -> io::Result<Self> {
        // SAFETY: the handle is owned by the guard from here on; the limit
        // struct lives across the call that copies it.
        unsafe {
            let handle = OwnedHandle(CreateJobObjectW(None, PCWSTR::null())?);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle.0,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )?;
            Ok(Self { handle })
        }
    }

    pub fn raw(&self) -> HANDLE {
        self.handle.0
    }

    /// Ends every process in the job.
    pub fn terminate(&self, exit_code: u32) -> io::Result<()> {
        // SAFETY: the job handle is alive while `self` is.
        unsafe { TerminateJobObject(self.handle.0, exit_code)? };
        Ok(())
    }

    /// Whether process `pid` is a member (`Ok(false)` once it is gone).
    pub fn contains(&self, pid: u32) -> io::Result<bool> {
        // SAFETY: the process handle is owned by its guard; the job handle is
        // alive while `self` is.
        unsafe {
            let process = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(h) => OwnedHandle(h),
                // ERROR_INVALID_PARAMETER: no such process.
                Err(e) if e.code().0 as u32 == 0x8007_0057 => return Ok(false),
                Err(e) => return Err(e.into()),
            };
            let mut inside = windows::core::BOOL(0);
            IsProcessInJob(process.0, Some(self.handle.0), &mut inside)?;
            Ok(inside.as_bool())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_job_holds_no_stranger() {
        let job = Job::new().unwrap();
        assert!(!job.contains(std::process::id()).unwrap());
        assert!(!job.contains(u32::MAX - 3).unwrap());
        job.terminate(1).unwrap();
    }
}
