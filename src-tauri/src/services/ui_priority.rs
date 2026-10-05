//! The UI's threads outrank the work Tabtivity's own tabs start.
//!
//! Typing into an agent terminal or the Reader's composer runs on two threads:
//! this process's main thread (GTK, every IPC call) and each webview renderer's
//! main thread (JS, style, layout and — with DMABUF off — software paint, all
//! serialized). Everything an agent starts (cargo, rustc, vitest workers) runs
//! at the same nice 0 in the same flat `app.slice` (its children get no `cpu`
//! controller), so under a load of 100+ on 24 cores the renderer is scheduled
//! one-for-one against them. A terminal emulator gets away with that because
//! it sleeps between keys and wakes with lag credit; the renderer is never idle
//! (~25% of a core at rest), so EEVDF treats it like the batch jobs. Measured
//! 2026-10-01 at load 121: a round trip through the renderer's JS took 48 ms
//! median, 126 ms p90, 270 ms p99, 440 ms worst; the same path's floor is 6 ms.
//!
//! The fix is the desktop's own: RealtimeKit (`rtkit-daemon`, what PipeWire and
//! GNOME Shell use) grants an unprivileged process a negative nice for chosen
//! threads. [`UI_NICE`] gives each of those two threads ~9× the weight of a
//! nice-0 compile job — they win the CPU when they want it, and still use little
//! of it. Every thread raised here first gets `SCHED_RESET_ON_FORK`, so nothing
//! it spawns (a PTY, tmux, an agent, a WebKit helper thread) inherits the boost.
//!
//! Best effort: no rtkit (other distros, containers), a polkit
//! denial, and the threads simply stay at their nice — exactly what they had
//! before. `TABTIVITY_UI_PRIORITY=0` turns it off. Linux only (the module is
//! compiled for nothing else).

use std::collections::HashSet;
use zbus::blocking::Connection;

/// The nice the UI threads ask for. rtkit's floor is -15 by default; -10 is
/// what desktop shells take and leaves room below for audio.
pub const UI_NICE: i32 = -10;

/// The opt-out.
pub const OPT_OUT_VAR: &str = crate::app_env!("UI_PRIORITY");

/// How often the renderer set is looked at again: a crash reload or the memory
/// watchdog's renderer replacement brings a new process, and a popout its own.
const RESCAN: std::time::Duration = std::time::Duration::from_secs(15);

/// Whether a value of [`OPT_OUT_VAR`] turns the boost off.
fn opted_out(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|v| {
        matches!(
            v.to_string_lossy().trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        )
    })
}

/// The nice value in a `/proc/<pid>/task/<tid>/stat` line (field 19), read
/// after the last `)` because `comm` may hold spaces and parentheses.
fn stat_nice(stat: &str) -> Option<i32> {
    stat.rsplit_once(')')?.1.split_whitespace().nth(16)?.parse().ok()
}

/// Whether a thread still needs raising: one already at or below [`UI_NICE`]
/// (the user's own `renice`, an earlier pass) is left alone.
fn needs_raise(current_nice: Option<i32>) -> bool {
    current_nice.is_some_and(|nice| nice > UI_NICE)
}

/// Start raising this process's main thread and every renderer under it, on a
/// thread of its own (rtkit answers over the system bus, and a renderer only
/// exists once the first webview is built).
pub fn install() {
    if opted_out(crate::brand::env_os("UI_PRIORITY").as_deref()) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("ui-priority".into())
        .spawn(watch);
    if let Err(e) = spawned {
        eprintln!("[ui-priority] not started: {e}");
    }
}

const RTKIT_SERVICE: &str = "org.freedesktop.RealtimeKit1";
const RTKIT_PATH: &str = "/org/freedesktop/RealtimeKit1";

fn thread_nice(pid: u32, tid: u32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/task/{tid}/stat")).ok()?;
    stat_nice(&stat)
}

/// `SCHED_RESET_ON_FORK` on a nice-0 `SCHED_OTHER` thread: unprivileged
/// (only clearing it needs a capability), and it is what keeps a raised
/// thread's children at nice 0 whatever rtkit itself does.
fn reset_on_fork(tid: u32) -> Result<(), String> {
    let param = libc::sched_param { sched_priority: 0 };
    // SAFETY: plain syscall on a thread id with a valid, initialized param.
    let rc = unsafe {
        libc::sched_setscheduler(
            tid as libc::pid_t,
            libc::SCHED_OTHER | libc::SCHED_RESET_ON_FORK,
            &param,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!("sched_setscheduler: {}", std::io::Error::last_os_error()))
    }
}

fn raise(bus: &Connection, pid: u32, tid: u32) -> Result<(), String> {
    reset_on_fork(tid)?;
    bus.call_method(
        Some(RTKIT_SERVICE),
        RTKIT_PATH,
        Some(RTKIT_SERVICE),
        "MakeThreadHighPriorityWithPID",
        &(u64::from(pid), u64::from(tid), UI_NICE),
    )
    .map(|_| ())
    .map_err(|e| format!("rtkit: {e}"))
}

fn is_renderer(pid: u32) -> bool {
    crate::sysstat::cmdline(pid).is_some_and(|cmd| cmd.contains("WebKitWebProcess"))
}

fn watch() {
    let bus = match Connection::system() {
        Ok(bus) => bus,
        Err(e) => {
            eprintln!("[ui-priority] no system bus, UI threads keep their nice: {e}");
            return;
        }
    };
    let own = std::process::id();
    // Each process is tried once: a failure is rtkit's or polkit's answer
    // and would be the same again, and rtkit rate-limits every caller.
    let mut tried: HashSet<u32> = HashSet::new();
    loop {
        let mut pids = vec![own];
        pids.extend(
            crate::sysstat::descendant_pids(&[own])
                .into_iter()
                .filter(|&pid| is_renderer(pid)),
        );
        tried.retain(|pid| pids.contains(pid));
        for pid in pids {
            if !tried.insert(pid) || !needs_raise(thread_nice(pid, pid)) {
                continue;
            }
            match raise(&bus, pid, pid) {
                Ok(()) => eprintln!("[ui-priority] pid {pid} main thread at nice {UI_NICE}"),
                Err(e) => {
                    eprintln!("[ui-priority] pid {pid} keeps its nice: {e}");
                    // No rtkit on this system: nothing later will differ.
                    if e.contains("ServiceUnknown") {
                        return;
                    }
                }
            }
        }
        std::thread::sleep(RESCAN);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn opt_out_only_on_an_explicit_no() {
        assert!(!opted_out(None));
        assert!(!opted_out(Some(OsStr::new(""))));
        assert!(!opted_out(Some(OsStr::new("1"))));
        assert!(opted_out(Some(OsStr::new("0"))));
        assert!(opted_out(Some(OsStr::new(" Off "))));
    }

    #[test]
    fn nice_is_read_past_a_comm_with_spaces_and_parens() {
        let stat = "713478 (Web (Kit) Proc) S 712285 712285 712285 0 -1 4194560 \
                    1 0 0 0 10 5 0 0 20 -10 37 0 1234 0 0";
        assert_eq!(stat_nice(stat), Some(-10));
        assert_eq!(stat_nice("713478 (x) S 1 2 3"), None);
        assert_eq!(stat_nice("garbage"), None);
    }

    #[test]
    fn only_threads_above_the_target_are_raised() {
        assert!(needs_raise(Some(0)));
        assert!(needs_raise(Some(5)));
        assert!(!needs_raise(Some(UI_NICE)));
        assert!(!needs_raise(Some(-15)));
        assert!(!needs_raise(None));
    }

    #[test]
    fn own_main_thread_nice_is_readable() {
        let pid = std::process::id();
        let stat = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/stat")).unwrap();
        assert!(stat_nice(&stat).is_some());
    }
}
