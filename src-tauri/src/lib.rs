// `cargo clippy -- -D warnings` is a CI gate (TODO group Y #163). This is the
// one lint turned off crate-wide, and only because it is structurally wrong for
// this crate rather than inconvenient: a `#[tauri::command]` takes its injected
// `AppHandle` and every `State<'_, …>` it touches as leading parameters before a
// single one of its own arguments, so the 7-argument threshold is spent on
// dependency injection. The functions it fires on (`remote_connect` at 11,
// `detach_subwindow` at 9) are wide because the IPC boundary is wide — bundling
// them into a struct would move the same fields behind one more indirection and
// change nothing about the call site the lint is worried about.
#![allow(clippy::too_many_arguments)]

pub mod brand;
pub mod commands;
pub mod duscan;
pub mod gpustat;
pub mod paths;
pub mod platform;
pub mod schema;
pub mod services;
pub mod storage;
pub mod sysstat;
pub mod terminal;

use commands::apps::{WindowRegistry, WindowRegistryState};
use commands::terminal::RegistryState;
use commands::workspace::{WorkspaceState, WorkspaceStateArc};
use std::sync::{Arc, Mutex};
use terminal::PtyRegistry;

/// Raw fd kept open so the async-signal-safe crash handler can write to it.
#[cfg(unix)]
static CRASH_LOG_FD: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

/// Raw file HANDLE kept open so the SEH crash filter can write to it — the
/// Windows analog of `CRASH_LOG_FD`. `0` (null, never a valid file handle)
/// means "not installed".
#[cfg(windows)]
static CRASH_LOG_HANDLE: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// The short commit this binary was built from (`src-tauri/build.rs`), or
/// "unknown" outside git. Written into every `=== STARTED` and crash header:
/// the frozen dev binary is replaced on every commit, so the path a crash
/// records is gone by the time anyone looks, and the commit is what
/// `scripts/crash-symbolize.sh` needs to find the retained copy
/// (`scripts/retain-dev-build.sh`).
const BUILD_COMMIT: &str = match option_env!(crate::app_env!("BUILD_COMMIT")) {
    Some(c) => c,
    None => "unknown",
};

/// Install a panic hook + OS signal handlers that append to crash.log.
fn install_crash_logger() {
    let state_dir = storage::state_dir();
    let _ = std::fs::create_dir_all(&state_dir);
    let path = state_dir.join("crash.log");

    append_to_log(
        &path,
        &format!("=== STARTED {} commit={} ===", iso_now(), BUILD_COMMIT),
    );

    let path2 = path.clone();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        let msg = format!("=== PANIC {} ===\n{info}\nbacktrace:\n{bt}\n", iso_now());
        append_to_log(&path2, &msg);
        eprintln!("{msg}");
    }));

    #[cfg(unix)]
    // SAFETY: called once at startup before any threads that touch signals.
    unsafe {
        install_signal_handlers(&path)
    };

    #[cfg(windows)]
    // SAFETY: called once at startup before any thread can crash.
    unsafe {
        install_seh_filter(&path)
    };
}

/// Append one entry to crash.log in the state dir.
pub(crate) fn crash_log_append(msg: &str) {
    append_to_log(&storage::state_dir().join("crash.log"), msg);
}

fn append_to_log(path: &std::path::Path, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{msg}");
    }
}

/// Human-readable ISO 8601 UTC timestamp with no external dependencies.
pub(crate) fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = storage::epoch_to_utc(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Register async-signal-safe handlers for fatal signals.
///
/// `SA_RESETHAND` asks the kernel to restore the default disposition before it
/// enters our handler, so that returning re-executes the faulting instruction
/// and the default action (terminate, core dump, proper exit status) fires. That
/// promise only holds when the *kernel* dispatches to us — and on Linux it does
/// not. WebKit's WTF signal layer (`Source/WTF/wtf/threads/Signals.cpp`)
/// initialises after this, takes SIGSEGV/SIGBUS for its wasm/JIT fault handling,
/// and saves whatever handler it found as `oldAction`. When none of its own
/// handlers claims a fault it calls `oldAction.sa_sigaction(sig, info, ctx)`
/// **directly as a function** and returns, its own handler still installed.
/// Ours then runs as a plain callee: nothing is reset, the fault re-executes,
/// and the faulting thread loops forever — one `=== CRASH: SIGSEGV ===` per
/// pass at ~6 MB/s, a half-gigabyte crash.log, and a window that "stopped
/// reacting" instead of a dead process (2026-09-05, frozen dev build, after a
/// TeX compile). So the handler restores `SIG_DFL` itself and re-raises, which
/// is correct whichever way it was reached; `SA_RESETHAND` stays as belt to
/// those braces.
///
/// `SA_ONSTACK` runs it on an alternate stack, so a stack overflow — a SIGSEGV
/// on the guard page — is logged instead of faulting again inside the handler.
/// Rust's runtime gives every `std::thread` a minimal one (a few KB, sized for
/// its own overflow message); the main thread, where GTK and WebKit's UI side
/// run and the likeliest native crasher, gets a roomier one here so the
/// unwinder below has stack to work in.
///
/// glibc's `backtrace()` is called once at install: the first call loads
/// `libgcc_s` through the dynamic loader, which mallocs, and that is the one
/// thing a crash handler must never do. Pre-loaded, `backtrace` and
/// `backtrace_symbols_fd` allocate nothing (documented in `backtrace(3)`).
#[cfg(unix)]
unsafe fn install_signal_handlers(path: &std::path::Path) {
    use std::os::unix::io::IntoRawFd;
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        CRASH_LOG_FD.store(file.into_raw_fd(), std::sync::atomic::Ordering::Relaxed);
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // Load libgcc_s now so the handler's backtrace does not dlopen it.
        let mut warm = [std::ptr::null_mut::<libc::c_void>(); 4];
        libc::backtrace(warm.as_mut_ptr(), warm.len() as libc::c_int);
        // A 64 KB alternate stack for the main thread. Leaked on purpose: it
        // must outlive every frame the process will ever run.
        let alt: &'static mut [u8] = Box::leak(vec![0u8; 64 * 1024].into_boxed_slice());
        let ss = libc::stack_t {
            ss_sp: alt.as_mut_ptr() as *mut libc::c_void,
            ss_flags: 0,
            ss_size: alt.len(),
        };
        libc::sigaltstack(&ss, std::ptr::null_mut());
    }
    for &sig in &[libc::SIGSEGV, libc::SIGABRT, libc::SIGBUS, libc::SIGFPE] {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = signal_crash_handler as *const () as libc::sighandler_t;
        sa.sa_flags = libc::SA_SIGINFO | libc::SA_RESETHAND | libc::SA_ONSTACK;
        libc::sigaction(sig, &sa, std::ptr::null_mut());
    }
}

/// Async-signal-safe crash handler. Order matters:
///
///  1. **Restore `SIG_DFL` first.** From here on any fault inside the handler —
///     an unwinder tripping over a corrupt frame, the alternate stack running
///     out — kills the process outright instead of looping (see
///     `install_signal_handlers`). Whatever was logged by then stays logged.
///  2. Write the one-line header the tests pin down (`format_signal_line`):
///     signal, `si_code`, faulting address.
///  3. Write the context that turns a header into a lead: UTC time, program
///     counter, thread id and name (the GTK/WebKit UI thread is the process
///     name; tokio workers are `tokio-runtime-w`), the executable's path and
///     version — the offsets below only resolve against *that* binary.
///  4. Write a glibc backtrace as `module(+offset) [absolute]` lines, one per
///     frame. `alarm(5)` stands guard: should the unwinder hang on a mangled
///     stack, SIGALRM's default action ends the process with the partial trace
///     on disk rather than reproducing the hang this handler exists to end.
///  5. Re-raise, so the process dies of its own signal (and dumps core where
///     the system allows), whether the kernel or a chaining handler got us here.
///     The signal is blocked while its handler runs, so the raise is pended and
///     delivered — to `SIG_DFL` — the moment every handler on the way back
///     returns; that also covers `raise`d SIGABRT/SIGFPE, where returning would
///     resume the code that raised them.
///
/// Only `sigaction`, `write`, `clock_gettime`, `syscall(gettid)`, `open`/`read`/
/// `close`, `readlink`, `alarm`, `backtrace`, `backtrace_symbols_fd` and `raise`
/// are called — every one async-signal-safe or made so at install — and every
/// line is formatted into a stack buffer. `scripts/crash-symbolize.sh` turns
/// the trace into file:line.
#[cfg(unix)]
extern "C" fn signal_crash_handler(
    sig: libc::c_int,
    info: *mut libc::siginfo_t,
    ctx: *mut libc::c_void,
) {
    // SAFETY: `sigaction` is async-signal-safe; the struct is fully initialised.
    unsafe {
        let mut dfl: libc::sigaction = std::mem::zeroed();
        dfl.sa_sigaction = libc::SIG_DFL;
        libc::sigaction(sig, &dfl, std::ptr::null_mut());
    }
    let fd = CRASH_LOG_FD.load(std::sync::atomic::Ordering::Relaxed);
    if fd >= 0 {
        let name: &[u8] = match sig {
            libc::SIGSEGV => b"SIGSEGV",
            libc::SIGABRT => b"SIGABRT",
            libc::SIGBUS => b"SIGBUS",
            libc::SIGFPE => b"SIGFPE",
            _ => b"SIGNAL",
        };
        // SAFETY: the kernel — or a chaining handler forwarding the kernel's
        // arguments — hands a valid `siginfo_t`; null-checked before the read.
        let (code, addr) = unsafe {
            if info.is_null() {
                (0, 0)
            } else {
                ((*info).si_code, siginfo_addr(&*info))
            }
        };
        let mut buf = [0u8; 512];
        let len = format_signal_line(name, code, addr, &mut buf);
        sig_write(fd, &buf[..len]);
        let len = format_crash_context(fault_pc(ctx), &mut buf);
        sig_write(fd, &buf[..len]);
        write_crash_backtrace(fd);
        sig_write(fd, b"=== CRASH END ===\n");
    }
    // SAFETY: `raise` is async-signal-safe per POSIX.
    unsafe {
        libc::raise(sig);
    }
}

/// The faulting address a fatal signal reports. Linux's `libc` exposes it as an
/// accessor over the union; the BSD-shaped platforms as a plain field.
#[cfg(all(unix, any(target_os = "linux", target_os = "android")))]
fn siginfo_addr(info: &libc::siginfo_t) -> usize {
    // SAFETY: only read for the fault signals installed above, whose siginfo
    // carries `si_addr`; a `raise`d one reads as a meaningless but harmless value.
    unsafe { info.si_addr() as usize }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
fn siginfo_addr(info: &libc::siginfo_t) -> usize {
    info.si_addr as usize
}

/// The program counter at the fault, read off the `ucontext_t` the kernel hands
/// the handler — the one address that is right even when the unwinder cannot
/// walk out of the signal frame. `0` where the register layout is not mapped.
#[cfg(all(target_os = "linux", target_env = "gnu", target_arch = "x86_64"))]
fn fault_pc(ctx: *mut libc::c_void) -> usize {
    if ctx.is_null() {
        return 0;
    }
    // SAFETY: the third handler argument is a `ucontext_t*` under `SA_SIGINFO`.
    unsafe { (*(ctx as *const libc::ucontext_t)).uc_mcontext.gregs[libc::REG_RIP as usize] as usize }
}

#[cfg(all(target_os = "linux", target_env = "gnu", target_arch = "aarch64"))]
fn fault_pc(ctx: *mut libc::c_void) -> usize {
    if ctx.is_null() {
        return 0;
    }
    // SAFETY: the third handler argument is a `ucontext_t*` under `SA_SIGINFO`.
    unsafe { (*(ctx as *const libc::ucontext_t)).uc_mcontext.pc as usize }
}

#[cfg(all(
    unix,
    not(all(
        target_os = "linux",
        target_env = "gnu",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))
))]
fn fault_pc(_ctx: *mut libc::c_void) -> usize {
    0
}

/// Format the context line under the crash header without allocating:
/// `  at <UTC> pc=0x… tid=<n> thread=<comm> exe=<path> v<version> commit=<sha>\n`.
#[cfg(unix)]
fn format_crash_context(pc: usize, buf: &mut [u8]) -> usize {
    let mut pos = 0;
    pos = crash_push(buf, pos, b"  at ");
    // SAFETY: `clock_gettime` is async-signal-safe; `ts` is a plain out-param.
    let secs = unsafe {
        let mut ts: libc::timespec = std::mem::zeroed();
        libc::clock_gettime(libc::CLOCK_REALTIME, &mut ts);
        ts.tv_sec.max(0) as u64
    };
    let (y, mo, d, h, mi, s) = storage::epoch_to_utc(secs);
    pos = crash_push_dec(buf, pos, y, 4);
    pos = crash_push(buf, pos, b"-");
    pos = crash_push_dec(buf, pos, mo, 2);
    pos = crash_push(buf, pos, b"-");
    pos = crash_push_dec(buf, pos, d, 2);
    pos = crash_push(buf, pos, b"T");
    pos = crash_push_dec(buf, pos, h, 2);
    pos = crash_push(buf, pos, b":");
    pos = crash_push_dec(buf, pos, mi, 2);
    pos = crash_push(buf, pos, b":");
    pos = crash_push_dec(buf, pos, s, 2);
    pos = crash_push(buf, pos, b"Z pc=0x");
    pos = crash_push_hex(buf, pos, pc as u64, 1);
    #[cfg(target_os = "linux")]
    {
        pos = crash_push(buf, pos, b" tid=");
        // SAFETY: raw `gettid` syscall, async-signal-safe, no arguments.
        let tid = unsafe { libc::syscall(libc::SYS_gettid) };
        pos = crash_push_dec(buf, pos, tid.max(0) as u64, 1);
        pos = crash_push(buf, pos, b" thread=");
        let mut comm = [0u8; 32];
        let n = read_small_file(c"/proc/thread-self/comm", &mut comm);
        let n = comm[..n].iter().position(|&c| c == b'\n').unwrap_or(n);
        pos = crash_push(buf, pos, &comm[..n]);
        pos = crash_push(buf, pos, b" exe=");
        let mut exe = [0u8; 256];
        // SAFETY: `readlink` is async-signal-safe; the path is NUL-terminated
        // and the buffer length is passed alongside it.
        let n = unsafe {
            libc::readlink(
                c"/proc/self/exe".as_ptr(),
                exe.as_mut_ptr() as *mut libc::c_char,
                exe.len(),
            )
        };
        pos = crash_push(buf, pos, &exe[..n.max(0) as usize]);
    }
    pos = crash_push(buf, pos, b" v");
    pos = crash_push(buf, pos, env!("CARGO_PKG_VERSION").as_bytes());
    pos = crash_push(buf, pos, b" commit=");
    pos = crash_push(buf, pos, BUILD_COMMIT.as_bytes());
    crash_push(buf, pos, b"\n")
}

/// Read up to `buf.len()` bytes of a small file with raw syscalls; returns the
/// byte count (0 on any failure).
#[cfg(target_os = "linux")]
fn read_small_file(path: &std::ffi::CStr, buf: &mut [u8]) -> usize {
    // SAFETY: `open`/`read`/`close` are async-signal-safe; the path is a
    // NUL-terminated C string and the read is bounded by `buf.len()`.
    unsafe {
        let fd = libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC);
        if fd < 0 {
            return 0;
        }
        let n = libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len());
        libc::close(fd);
        n.max(0) as usize
    }
}

/// Write the faulting thread's stack, one `module(+offset) [abs]` line per
/// frame, straight to `fd`. Guarded by `alarm(5)` — see `signal_crash_handler`.
/// glibc-only: `backtrace(3)` is an execinfo extension, and the loop this
/// diagnoses is a WebKitGTK one.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn write_crash_backtrace(fd: i32) {
    sig_write(
        fd,
        b"  backtrace (module+offset; scripts/crash-symbolize.sh resolves it):\n",
    );
    // SAFETY: `alarm`, `sigaction`, `backtrace` (libgcc_s pre-loaded at
    // install) and `backtrace_symbols_fd` are async-signal-safe here; the
    // frame buffer lives on this stack and outlives both calls.
    unsafe {
        let mut dfl: libc::sigaction = std::mem::zeroed();
        dfl.sa_sigaction = libc::SIG_DFL;
        libc::sigaction(libc::SIGALRM, &dfl, std::ptr::null_mut());
        libc::alarm(5);
        let mut frames = [std::ptr::null_mut::<libc::c_void>(); 96];
        let n = libc::backtrace(frames.as_mut_ptr(), frames.len() as libc::c_int);
        if n > 0 {
            libc::backtrace_symbols_fd(frames.as_ptr(), n, fd);
        }
        libc::alarm(0);
    }
}

#[cfg(all(unix, not(all(target_os = "linux", target_env = "gnu"))))]
fn write_crash_backtrace(fd: i32) {
    sig_write(fd, b"  backtrace: not available on this platform\n");
}

#[cfg(unix)]
#[inline(always)]
fn sig_write(fd: i32, buf: &[u8]) {
    // SAFETY: `write` is async-signal-safe per POSIX.
    unsafe { libc::write(fd, buf.as_ptr() as *const libc::c_void, buf.len()) };
}

/// Format `=== CRASH: <name> code=0x… addr=0x… ===\n` into `buf` without
/// allocating and return the byte length — the Unix signal handler's line.
/// `code` is `si_code` (for SIGSEGV: 1 = `SEGV_MAPERR`, 2 = `SEGV_ACCERR`),
/// `addr` is `si_addr`, the address the fault was at — `0x0` reads as a null
/// dereference, a guard-page address as a stack overflow. Compiled for tests on
/// every OS; only the Unix handler consumes it at runtime.
#[cfg(any(unix, test))]
pub fn format_signal_line(name: &[u8], code: i32, addr: usize, buf: &mut [u8]) -> usize {
    let mut pos = 0;
    pos = crash_push(buf, pos, b"=== CRASH: ");
    pos = crash_push(buf, pos, name);
    pos = crash_push(buf, pos, b" code=0x");
    pos = crash_push_hex(buf, pos, code as u32 as u64, 1);
    pos = crash_push(buf, pos, b" addr=0x");
    pos = crash_push_hex(buf, pos, addr as u64, 1);
    pos = crash_push(buf, pos, b" ===\n");
    pos
}

/// Append `bytes` to `buf` at `pos`, truncating silently; returns the new `pos`.
fn crash_push(buf: &mut [u8], pos: usize, bytes: &[u8]) -> usize {
    let n = bytes.len().min(buf.len().saturating_sub(pos));
    buf[pos..pos + n].copy_from_slice(&bytes[..n]);
    pos + n
}

/// Append `v` as upper-case hex with at least `min_digits` digits.
fn crash_push_hex(buf: &mut [u8], pos: usize, mut v: u64, min_digits: usize) -> usize {
    let mut digits = [0u8; 16];
    let mut i = 0;
    loop {
        let d = (v & 0xF) as u8;
        digits[i] = if d < 10 { b'0' + d } else { b'A' + (d - 10) };
        i += 1;
        v >>= 4;
        if (v == 0 && i >= min_digits) || i == digits.len() {
            break;
        }
    }
    let mut pos = pos;
    while i > 0 {
        i -= 1;
        pos = crash_push(buf, pos, &digits[i..i + 1]);
    }
    pos
}

/// Append `v` in decimal, zero-padded to at least `min_digits` digits.
#[cfg(any(unix, test))]
fn crash_push_dec(buf: &mut [u8], pos: usize, mut v: u64, min_digits: usize) -> usize {
    let mut digits = [0u8; 20];
    let mut i = 0;
    loop {
        digits[i] = b'0' + (v % 10) as u8;
        i += 1;
        v /= 10;
        if (v == 0 && i >= min_digits) || i == digits.len() {
            break;
        }
    }
    let mut pos = pos;
    while i > 0 {
        i -= 1;
        pos = crash_push(buf, pos, &digits[i..i + 1]);
    }
    pos
}

/// Register a Windows SEH unhandled-exception filter that appends a
/// `=== CRASH: … ===` line to crash.log — the native-fault analog of the Unix
/// signal handlers above (a Rust panic is already covered by the panic hook;
/// this catches access violations and friends that never unwind).
#[cfg(windows)]
unsafe fn install_seh_filter(path: &std::path::Path) {
    use std::os::windows::io::IntoRawHandle;
    use windows::Win32::System::Diagnostics::Debug::SetUnhandledExceptionFilter;
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        CRASH_LOG_HANDLE.store(
            file.into_raw_handle() as isize,
            std::sync::atomic::Ordering::Relaxed,
        );
    }
    // SAFETY: `crash_filter` matches the required `extern "system"` signature
    // and only performs handle writes on pre-opened state.
    unsafe {
        SetUnhandledExceptionFilter(Some(crash_filter));
    }
}

/// SEH top-level filter: write one crash line to the pre-opened handle, then
/// return `EXCEPTION_CONTINUE_SEARCH` (0) so default termination (WER, exit
/// code) proceeds — the moral equivalent of `SA_RESETHAND` on Unix. Runs on
/// the crashing thread with a possibly corrupt heap, so it formats into a
/// stack buffer via the allocation-free `format_crash_line`.
#[cfg(windows)]
unsafe extern "system" fn crash_filter(
    info: *const windows::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS,
) -> i32 {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::WriteFile;

    // SAFETY: the OS hands us a valid EXCEPTION_POINTERS for the duration of
    // the filter call; both pointers are null-checked before dereference.
    let (code, addr) = unsafe {
        if info.is_null() || (*info).ExceptionRecord.is_null() {
            (0u32, 0usize)
        } else {
            let rec = &*(*info).ExceptionRecord;
            (rec.ExceptionCode.0 as u32, rec.ExceptionAddress as usize)
        }
    };
    let handle = CRASH_LOG_HANDLE.load(std::sync::atomic::Ordering::Relaxed);
    if handle != 0 {
        let mut buf = [0u8; 64];
        let len = format_crash_line(code, addr, &mut buf);
        // SAFETY: the handle was opened at install time and is kept open for
        // the process lifetime; WriteFile on a file handle is safe here.
        unsafe {
            let _ = WriteFile(
                HANDLE(handle as *mut core::ffi::c_void),
                Some(&buf[..len]),
                None,
                None,
            );
        }
    }
    0 // EXCEPTION_CONTINUE_SEARCH
}

/// Format `=== CRASH: code=0x… addr=0x… ===\n` into `buf` without allocating
/// (an SEH filter runs on a crashing thread whose heap may be corrupt) and
/// return the byte length. Truncates silently if `buf` is too small. Compiled
/// on every OS so its unit tests run on Linux; only the Windows crash filter
/// consumes it at runtime.
pub fn format_crash_line(code: u32, addr: usize, buf: &mut [u8]) -> usize {
    let mut pos = 0;
    pos = crash_push(buf, pos, b"=== CRASH: code=0x");
    pos = crash_push_hex(buf, pos, code as u64, 8);
    pos = crash_push(buf, pos, b" addr=0x");
    pos = crash_push_hex(buf, pos, addr as u64, 1);
    pos = crash_push(buf, pos, b" ===\n");
    pos
}

/// Webview renderer crashes (e.g. WebKitWebProcess SIGBUS) happen in a child
/// process, so the signal handlers above never fire and the window keeps
/// showing its last frame — an apparent freeze. Hook WebKit's
/// web-process-terminated signal to log the reason to crash.log and reload
/// the page, which respawns the renderer.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn install_webview_crash_reporter(app: &tauri::App) {
    use tauri::Manager;

    // This loop runs ONCE, at setup, so it only ever sees the windows declared
    // in `tauri.conf.json`. Any window created later — a detached popout, the
    // presenter, an in-app browser's live page — has to be hooked at its own
    // creation via `hook_webview_crash_reporter`, or the crash it suffers is a
    // blank window with no `crash.log` line. That matters most for the browser:
    // a hostile page is precisely the thing that induces a renderer crash.
    for window in app.webview_windows().values() {
        hook_webview_crash_reporter(window);
    }
}

/// How many times ONE window's renderer is reloaded after it dies before the
/// reporter stops trying — a page that kills its renderer on load would
/// otherwise loop forever.
const MAX_RENDERER_RELOADS: u32 = 5;

/// The reload budget, pure: `prior` is how many crashes this window had already
/// counted. Kept **per window** by every caller. It was one process-wide static
/// per OS, so a popout or a live browser page crash-looping five times used up
/// the main window's reloads for the rest of the session.
fn renderer_reload_allowed(prior: u32) -> bool {
    prior < MAX_RENDERER_RELOADS
}

/// macOS's hook is app-wide (one builder callback for every window), so the
/// per-window count there lives in a map keyed by webview label. Counts the
/// crash and answers whether that window may reload.
#[cfg(any(target_os = "macos", test))]
fn bump_renderer_reloads(counts: &mut std::collections::BTreeMap<String, u32>, label: &str) -> bool {
    let n = counts.entry(label.to_string()).or_insert(0);
    let allowed = renderer_reload_allowed(*n);
    *n = n.saturating_add(1);
    allowed
}

/// Hook one window's renderer-crash signal. Safe to call on any window, at any
/// point after it is built.
#[cfg(target_os = "linux")]
pub(crate) fn hook_webview_crash_reporter(window: &tauri::WebviewWindow) {
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

    let label = window.label().to_string();
    let _ = window.with_webview(move |webview| {
        let label = label.clone();
        // This window's own budget: the hook runs once per window, so a counter
        // made here and moved into the handler is per-window by construction.
        let crashes = std::sync::atomic::AtomicU32::new(0);
        webview
            .inner()
            .connect_web_process_terminated(move |view, reason| {
                let msg = format!(
                    "=== WEBVIEW '{label}' TERMINATED {} reason={reason:?} ===",
                    iso_now()
                );
                crash_log_append(&msg);
                eprintln!("{msg}");
                // An intentional restart (the memory watchdog's) is not a crash
                // and must not spend the budget — so this stays before the count.
                if reason == WebProcessTerminationReason::TerminatedByApi {
                    return;
                }
                if renderer_reload_allowed(
                    crashes.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                ) {
                    view.reload();
                }
            });
    });
}

/// Windows: hook WebView2's `ProcessFailed` event on the window's
/// `ICoreWebView2` — the WebView2 spelling of WebKitGTK's
/// `web-process-terminated`. A renderer that exits (crash, OOM kill) leaves the
/// same last-frame "freeze" it does on Linux, so it is logged to crash.log and
/// the page reloaded, under the same reload cap. A dead *browser* process is
/// logged only: the whole WebView2 is gone with it and `Reload` has nothing to
/// talk to (the user's remedy is a relaunch, which the log line now explains).
/// An unresponsive renderer is logged and left alone — it may recover, and a
/// reload would destroy whatever it was doing.
#[cfg(target_os = "windows")]
pub(crate) fn hook_webview_crash_reporter(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    use webview2_com::ProcessFailedEventHandler;

    let label = window.label().to_string();
    let _ = window.with_webview(move |webview| {
        // This window's own reload budget (see `renderer_reload_allowed`).
        let crashes = std::sync::atomic::AtomicU32::new(0);
        // SAFETY: COM calls on the live controller Tauri handed us, on the
        // thread `with_webview` runs on (the webview's own); the handler is
        // reference-counted by WebView2 for as long as it is registered.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                if let Some(args) = args.as_ref() {
                    let _ = args.ProcessFailedKind(&mut kind);
                }
                let what = match kind {
                    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "renderer exited",
                    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
                        "renderer unresponsive"
                    }
                    COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
                        concat!("browser process exited (WebView2 is gone; relaunch ", crate::app_name!(), ")")
                    }
                    _ => "helper process failed",
                };
                let msg = format!(
                    "=== WEBVIEW '{label}' PROCESS FAILED {} kind={} ({what}) ===",
                    iso_now(),
                    kind.0
                );
                crash_log_append(&msg);
                eprintln!("{msg}");
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                    && renderer_reload_allowed(
                        crashes.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                    )
                {
                    if let Some(view) = sender.as_ref() {
                        let _ = view.Reload();
                    }
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_ProcessFailed(&handler, &mut token);
        }
    });
}

/// macOS: `webViewWebContentProcessDidTerminate` is delivered through wry's
/// navigation delegate, which Tauri exposes only as ONE app-wide hook on the
/// builder (`on_web_content_process_terminate`), not per window — so the
/// per-window call is a no-op here and [`with_webview_crash_reporter`] installs
/// the hook once for every window, present and future. (Any other platform
/// reports through its signal handlers.)
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub(crate) fn hook_webview_crash_reporter(window: &tauri::WebviewWindow) {
    let _ = window;
}

/// macOS: install the app-wide content-process-terminated hook on the builder.
/// WebKit does NOT reload on its own after its WebContent process dies — the
/// window keeps its last frame, the same apparent freeze the Linux hook
/// exists for — so the handler logs to crash.log and reloads, under the same
/// reload cap. Applies to every window the app ever builds (popouts, the
/// presenter, live browser pages), which is why it lives on the builder rather
/// than beside the per-window Linux/Windows hooks.
#[cfg(target_os = "macos")]
fn with_webview_crash_reporter(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    // Per-window budgets behind one app-wide hook: keyed by webview label.
    static RELOADS: std::sync::Mutex<std::collections::BTreeMap<String, u32>> =
        std::sync::Mutex::new(std::collections::BTreeMap::new());
    builder.on_web_content_process_terminate(|webview| {
        let msg = format!(
            "=== WEBVIEW '{}' TERMINATED {} (WebContent process died) ===",
            webview.label(),
            iso_now()
        );
        crash_log_append(&msg);
        eprintln!("{msg}");
        let allowed = RELOADS
            .lock()
            .map(|mut counts| bump_renderer_reloads(&mut counts, webview.label()))
            .unwrap_or(false);
        if allowed {
            let _ = webview.reload();
        }
    })
}

/// Linux and Windows hook each window as it is built (see
/// [`hook_webview_crash_reporter`]); nothing to add to the builder.
#[cfg(not(target_os = "macos"))]
fn with_webview_crash_reporter(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
}

/// One item of the explicit macOS menu bar, as data — so the one decision that
/// matters (what is in it, and what is not) is testable on Linux, where the
/// builder below cannot even compile.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MacMenuItem {
    About,
    Services,
    Hide,
    HideOthers,
    /// Tabtivity's own "Quit Tabtivity" (⌘Q, id [`MAC_MENU_QUIT_ID`]), not the
    /// predefined `terminate:` one.
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Fullscreen,
    Separator,
}

#[cfg(any(target_os = "macos", test))]
const MAC_MENU_QUIT_ID: &str = concat!(crate::app_slug!(), "-quit");

/// The macOS menu bar: (submenu title, items). Tauri would otherwise install
/// its default menu, and that one is wrong for Tabtivity in two ways:
///
/// - It binds **⌘W to Close Window**. The webview sees the key first, but from
///   a terminal or editor the frontend used to let it pass, and the menu then
///   closed the main window — i.e. quit the whole app — for a "close tab".
///   So there is **no Close Window item anywhere** here, and ⌘W is the
///   frontend's close-tab (`useKeyboard`).
/// - Its Quit is `terminate:`, which skips the window's close handler (layout
///   flush, tmux reap). The custom Quit closes the main window instead, so
///   AppShell's `onCloseRequested` teardown runs, then `RunEvent::Exit`.
///
/// The **Edit submenu is mandatory**: its predefined Copy/Paste dispatch
/// `copy:`/`paste:` to WKWebView, which is how ⌘C/⌘V reach xterm and every
/// input. A frontend ⌘V handler instead would double-paste.
#[cfg(any(target_os = "macos", test))]
fn macos_menu_plan() -> Vec<(&'static str, Vec<MacMenuItem>)> {
    use MacMenuItem::*;
    vec![
        (
            crate::brand::DISPLAY,
            vec![About, Separator, Services, Separator, Hide, HideOthers, Separator, Quit],
        ),
        ("Edit", vec![Undo, Redo, Separator, Cut, Copy, Paste, SelectAll]),
        ("Window", vec![Minimize, Fullscreen]),
    ]
}

#[cfg(target_os = "macos")]
fn build_macos_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
    type Item = Box<dyn IsMenuItem<tauri::Wry>>;

    let mut submenus: Vec<Submenu<tauri::Wry>> = Vec::new();
    for (title, entries) in macos_menu_plan() {
        let mut items: Vec<Item> = Vec::new();
        for entry in entries {
            let item: Item = match entry {
                MacMenuItem::About => Box::new(PredefinedMenuItem::about(app, None, None)?),
                MacMenuItem::Services => Box::new(PredefinedMenuItem::services(app, None)?),
                MacMenuItem::Hide => Box::new(PredefinedMenuItem::hide(app, None)?),
                MacMenuItem::HideOthers => Box::new(PredefinedMenuItem::hide_others(app, None)?),
                MacMenuItem::Quit => Box::new(MenuItem::with_id(
                    app,
                    MAC_MENU_QUIT_ID,
                    concat!("Quit ", crate::app_name!()),
                    true,
                    Some("CmdOrCtrl+Q"),
                )?),
                MacMenuItem::Undo => Box::new(PredefinedMenuItem::undo(app, None)?),
                MacMenuItem::Redo => Box::new(PredefinedMenuItem::redo(app, None)?),
                MacMenuItem::Cut => Box::new(PredefinedMenuItem::cut(app, None)?),
                MacMenuItem::Copy => Box::new(PredefinedMenuItem::copy(app, None)?),
                MacMenuItem::Paste => Box::new(PredefinedMenuItem::paste(app, None)?),
                MacMenuItem::SelectAll => Box::new(PredefinedMenuItem::select_all(app, None)?),
                MacMenuItem::Minimize => Box::new(PredefinedMenuItem::minimize(app, None)?),
                MacMenuItem::Fullscreen => Box::new(PredefinedMenuItem::fullscreen(app, None)?),
                MacMenuItem::Separator => Box::new(PredefinedMenuItem::separator(app)?),
            };
            items.push(item);
        }
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|i| i.as_ref()).collect();
        submenus.push(Submenu::with_items(app, title, true, &refs)?);
    }
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = submenus
        .iter()
        .map(|s| s as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    Menu::with_items(app, &refs)
}

/// macOS: install the explicit menu bar (see [`macos_menu_plan`]) and route its
/// custom Quit through the main window's close, so the frontend teardown runs.
#[cfg(target_os = "macos")]
fn with_macos_menu(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .menu(build_macos_menu)
        .on_menu_event(|app, event| {
            if event.id().0 != MAC_MENU_QUIT_ID {
                return;
            }
            use tauri::Manager;
            match app.get_webview_window("main") {
                Some(main) => {
                    if main.close().is_err() {
                        app.exit(0);
                    }
                }
                None => app.exit(0),
            }
        })
}

/// Linux and Windows get no menu bar: Tauri installs none there, and one would
/// draw into Windows' undecorated overlay header.
#[cfg(not(target_os = "macos"))]
fn with_macos_menu(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
}

/// WebKitGTK draws the scrollbars INSIDE the web content with the native GTK
/// theme, not the page's CSS — the standard `scrollbar-color` property is ignored
/// on this WebKitGTK build (confirmed on 2.50.x). On a light GTK system theme
/// that leaves a white trough + grey slider regardless of Tabtivity's in-app theme.
///
/// WebKit's scrollbar renderer queries the default screen's GTK style providers,
/// so an APPLICATION-priority `GtkCssProvider` that recolors the `scrollbar`
/// nodes is picked up for the in-content bars. We apply a theme-agnostic look —
/// a translucent-grey trough (subtle on both light and dark surfaces) with a
/// solid accent-blue slider — so it reads as "Tabtivity blue" without having to
/// follow the live in-app theme. Best-effort and behind an env opt-out: any
/// failure simply leaves the native scrollbar untouched.
#[cfg(target_os = "linux")]
fn install_scrollbar_theme() {
    use gtk::prelude::*;

    if crate::brand::env_os("NO_SCROLLBAR_THEME").is_some() {
        return;
    }

    // GTK3 scrollbar node structure: `scrollbar > contents > trough > slider`.
    // Recolor the trough + slider; `min-width/height` keep the thin overlay bar
    // wide enough to see. Colors mirror the frontend's fancy_dark accent so the
    // native bar matches the webview's themed bars on every surface.
    const CSS: &str = "
        scrollbar trough {
            background-color: rgba(127, 127, 127, 0.14);
            border-radius: 8px;
            border: none;
        }
        scrollbar slider {
            background-color: #36c5f0;
            border: 2px solid transparent;
            border-radius: 8px;
            min-width: 8px;
            min-height: 8px;
        }
        scrollbar slider:hover { background-color: #5edcff; }
        scrollbar slider:active { background-color: #1ca7d8; }
    ";

    let provider = gtk::CssProvider::new();
    if let Err(e) = provider.load_from_data(CSS.as_bytes()) {
        eprintln!("scrollbar theme: load css: {e}");
        return;
    }
    match gtk::gdk::Screen::default() {
        Some(screen) => gtk::StyleContext::add_provider_for_screen(
            &screen,
            &provider,
            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
        ),
        None => eprintln!("scrollbar theme: no default GDK screen"),
    }
}

/// Reopen the main window on the monitor and at the geometry it was last closed
/// at, then show it. The counterpart of the debounced save in `AppShell.tsx`.
///
/// The window is declared `"visible": false` in `tauri.conf.json` purely so this
/// can run before the first frame: it opens `maximized`, so on a multi-monitor
/// desk the WM maps it on the primary monitor and a restore onto the *other*
/// monitor would be a visible jump. Hidden → placed → shown, and the user only
/// ever sees the final position. The cost is that `win.show()` below is now
/// load-bearing; every call in here is best-effort (`let _ =`) so no failure can
/// skip it.
///
/// Geometry rules (which monitor, what if it was unplugged) live in
/// `services::window_state::resolve_startup_geometry`, which is pure and tested.
fn restore_main_window(app: &tauri::App) {
    use tauri::Manager;

    let Some(win) = app.get_webview_window("main") else {
        return; // No main window: nothing to place and nothing to show.
    };

    // Guard against a stray fullscreen state surviving into this launch. On Linux
    // this is not cosmetic: a window the WM has put into fullscreen keeps
    // `_NET_WM_STATE_FULLSCREEN`, which under KWin wins over MAXIMIZED and makes
    // the window UNMOVABLE — KWin refuses the `_NET_WM_MOVERESIZE` that
    // `startDragging` sends, so the header title-bar drag silently no-ops. A
    // maximized window fills the monitor identically yet stays draggable and
    // edge-snappable, so that is what Tabtivity uses instead. macOS is excluded: real
    // fullscreen (its own Space) is the platform-expected behaviour there, and
    // `AppShell.tsx` opts into it explicitly after load.
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_fullscreen(false);

    let saved = storage::read_json::<schema::Settings>(&storage::state_dir().join("settings.json"))
        .ok()
        .and_then(|s| s.window_state);
    let monitors: Vec<services::window_state::MonitorRect> = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| services::window_state::MonitorRect {
            x: m.position().x,
            y: m.position().y,
            w: m.size().width,
            h: m.size().height,
        })
        .collect();
    if saved.is_some() && monitors.is_empty() {
        // We have a rect to restore but nothing to validate it against, so it is
        // dropped and the window opens at the configured default. Not fatal, but
        // it silently defeats the whole feature — say so rather than leave the
        // user wondering why their window never comes back where they left it.
        eprintln!("window_state: no monitors reported at startup; ignoring the saved geometry");
    }

    match services::window_state::resolve_startup_geometry(saved, &monitors) {
        Some(g) => {
            // Unmaximize FIRST, even when we are about to re-maximize immediately:
            // the window is mapped maximized, and assigning a size/position while
            // it is in that state is what gives the WM a genuine restore geometry
            // to fall back to. Without it the WM's only record of a "normal" size
            // is the full monitor, so the maximize button appears to do nothing —
            // the exact bug `WindowControls.tsx` has to work around today.
            let _ = win.unmaximize();
            let _ = win.set_size(tauri::PhysicalSize::new(g.w, g.h));
            let _ = win.set_position(tauri::PhysicalPosition::new(g.x, g.y));
            if g.maximized {
                let _ = win.maximize();
            }
        }
        None => {
            // Fresh install, or a saved rect no connected monitor can host (the
            // undocked-external-display case). Fall back to the configured default
            // and re-assert it, in case the WM dropped the `maximized` hint at map
            // time.
            #[cfg(not(target_os = "macos"))]
            let _ = win.maximize();
        }
    }

    let _ = win.show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKit's DMA-BUF renderer SIGBUSes inside Mesa on some driver stacks
    // (seen 2026-06-11 with Mesa 26.0.3: renderer died, window froze). Fall
    // back to shared-memory rendering unless the user explicitly overrides.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // WebKit's AT-SPI bridge aborts the web process on a stale text offset, and
    // Tabtivity's constantly rewriting UI produces those by the second whenever a
    // screen reader is attached (2026-09-17: two renderer SIGABRTs, both taking
    // the window's tabs with them). Opt out before the first webview is built;
    // `TABTIVITY_ENABLE_A11Y=1` keeps the bridge. See `services::webkit_a11y`.
    #[cfg(target_os = "linux")]
    services::webkit_a11y::install();

    // The main thread and every webview renderer's main thread ask rtkit for
    // nice -10, so the compile and test jobs agent tabs start cannot starve
    // typing (2026-10-01: 48 ms median / 440 ms worst to reach the renderer's
    // JS at load 121). Best effort; see `services::ui_priority`.
    #[cfg(target_os = "linux")]
    services::ui_priority::install();

    services::brand_migration::hits::install();
    // Before anything creates or opens the state dir, and before the webview
    // context exists: what an older build wrote under the app's old name moves
    // to the current one (`services::brand_migration`). Returns at once while
    // the name is unchanged.
    services::brand_migration::run_at_launch();

    // First, so nothing below creates the state dir with the umask's mode.
    storage::ensure_private_state_dir();

    // Before the logger appends this run's `=== STARTED … ===` line, so the cap
    // is enforced against what previous runs left rather than a moment later.
    services::state_gc::cap_crash_log();
    install_crash_logger();

    // The webview's data directory is `<data dir>/<identifier>` on Linux, and
    // the identifier is the Tauri config's — asked for rather than hardcoded, so
    // a rename cannot leave this sweeping a directory nothing writes to any
    // more. Built here, at the top of `run`, because the cache has to be judged
    // and dropped BEFORE wry constructs the WebContext that opens it; the
    // context is handed to `build` unchanged at the bottom of the chain.
    let context = tauri::generate_context!();
    if let Some(root) = services::state_gc::webview_data_root(&context.config().identifier) {
        services::state_gc::trim_webview_cache(&root);
    }

    // More than one crate in the tree can supply a rustls `CryptoProvider`, and
    // rustls refuses to guess — it panics at the *first handshake* instead, i.e.
    // at runtime, mid-connect, on a user's machine. Install ours explicitly
    // before anything can reach TLS, and ignore an already-installed one.
    services::mail_engine::install_crypto_provider();

    // Anything left in the browser's download quarantine is by definition
    // abandoned: the user either saved it (so a copy exists where they chose)
    // or declined it. Same posture `services::sandbox::sweep_orphans` takes
    // with stale containers — a crash must not leave un-consented bytes on
    // disk indefinitely.
    services::browser_engine::sweep_quarantine();

    let pty_registry: RegistryState = Arc::new(Mutex::new(PtyRegistry::default()));
    let win_registry: WindowRegistryState = Arc::new(Mutex::new(WindowRegistry::default()));
    let workspace: WorkspaceStateArc = Arc::new(Mutex::new(WorkspaceState::new()));
    let fs_watch = commands::fs_watch::new_state();
    // Pooled SSH/SFTP connections, one per active remote project (Phase 0 of the
    // mount-free remote model). Opened on activation, torn down at exit below.
    let remote_pool = services::remote::new_pool();
    // Single-writer cache of per-project sync manifests (SSH-sync Phase 1). Guards
    // every `sync.json` mutation so concurrent syncs/saves can't clobber it (G7).
    let sync_manifest = services::remote_sync::new_manifest_state();
    // Registry of per-project auto-sync tasks (started on remote_connect, stopped
    // on remote_disconnect / app exit). See `services::sync_auto`.
    let auto_sync = services::sync_auto::new_state();
    // Registry of per-project git lockstep tasks (.git watcher + host poll; started
    // on remote_connect when enabled, stopped on disconnect / exit). See
    // `services::git_peer` (TODO #28n).
    let git_peer = services::git_peer::new_registry();
    // Registry of per-(project,worker) code-sync fan-outs (multi-host remote,
    // `docs/multi_host_remote_plan.md`). Kicked on a worker connect / commit /
    // manual "Push code to machines". See `services::worker_sync`.
    let worker_sync = services::worker_sync::new_state();
    // Cancel flags for in-flight disk-usage scans, one per scanning pane. See
    // `commands::disk_usage`.
    let disk_scans = commands::disk_usage::new_state();
    // The mail client's session state: the lazily-opened local store, the
    // in-memory-only passwords for accounts the user chose not to persist, and
    // the per-account sync cancel flags. See `commands::mail`.
    let mail_state = commands::mail::new_state();
    // CalDAV: session-only passwords for accounts the user chose not to persist
    // (docs/caldav_plan.md). Nothing here is ever serialized.
    let caldav_state: commands::caldav::CalDavState = Default::default();
    // Recursive file-churn watcher on the active project + the counters it has
    // seen since the last flush (see `services::usage_stats`).
    let usage_watch = services::usage_stats::new_state();
    let mobile_desktop = commands::mobile_control::MobileDesktopState::default();

    with_macos_menu(with_webview_crash_reporter(tauri::Builder::default()))
        .manage(pty_registry)
        .manage(win_registry)
        .manage(workspace)
        .manage(fs_watch)
        .manage(remote_pool)
        // Carries PDF pages between two Tabtivity windows: they are separate WebViews
        // with separate JS heaps, so the bytes must cross the process boundary.
        .manage(commands::pdf_clip::PdfClipboard::default())
        .manage(sync_manifest)
        .manage(auto_sync)
        .manage(git_peer)
        .manage(worker_sync)
        .manage(disk_scans)
        .manage(mail_state)
        .manage(caldav_state)
        .manage(usage_watch.clone())
        .manage(mobile_desktop.clone())
        .setup(move |_app| {
            commands::mobile_control::start_desktop_bridge(
                _app.handle().clone(),
                mobile_desktop.clone(),
            );
            // The Mobile host's lifetime is the app's: `RunEvent::Exit` stops
            // it, so an enabled configuration has to bring it back here rather
            // than waiting for the next login. Off the main thread, bounded,
            // and a no-op when Mobile is off or the host is already up.
            commands::mobile_control::start_host_on_launch();
            // Projects an older build worked in: bring what the app keeps
            // inside each one to the current names, off the main thread.
            // Returns at once while the name is unchanged.
            services::brand_migration::project::sweep_at_launch();
            // The root console's MCP endpoint (`services::root_mcp`): loopback,
            // token minted here per run, handed only to root-scope agent tabs.
            commands::root_mcp::start(_app.handle().clone());
            // A SIGTERM/SIGINT (the dev launcher's Ctrl+C, a `kill`, a session
            // logout) used to end the process with none of the teardown the
            // window's × runs: PTY subtrees, local tmux sessions, the Mobile
            // host, containers, VMs and tunnels all outlived it. Route the
            // signal into the ordinary exit instead, so `RunEvent::Exit` runs
            // the same cleanup for every clean exit. `AppHandle::exit` from a
            // runtime thread goes through the event-loop proxy, which is what
            // makes the exit events deliverable at all. Unix only: Windows has
            // no such signals, and needs no bridge for the session-end case —
            // tao's hidden top-level window receives `WM_ENDSESSION` at logoff
            // or shutdown and ends the loop, which Tauri delivers as
            // `RunEvent::Exit`, so the same teardown runs there already. (A
            // console close only exists in the debug build's console.)
            #[cfg(unix)]
            {
                let handle = _app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::signal::unix::{signal, SignalKind};
                    let (Ok(mut term), Ok(mut int)) = (
                        signal(SignalKind::terminate()),
                        signal(SignalKind::interrupt()),
                    ) else {
                        return;
                    };
                    tokio::select! {
                        _ = term.recv() => {}
                        _ = int.recv() => {}
                    }
                    handle.exit(0);
                });
            }
            // Announce window-registry mutations made outside a frontend command
            // (a launched app exiting) so every window's Apps view refreshes.
            {
                use tauri::{Emitter, Manager};
                let handle = _app.handle().clone();
                _app.state::<WindowRegistryState>().lock().unwrap().notify =
                    Some(Arc::new(move |project_id: Option<String>| {
                        let _ = handle.emit(
                            "app-windows-changed",
                            serde_json::json!({ "project_id": project_id }),
                        );
                    }));
            }
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            install_webview_crash_reporter(_app);
            // Recolor WebKitGTK's native in-content scrollbars (page CSS can't —
            // `scrollbar-color` is ignored on this build). Runs on the GTK main
            // thread, which `setup` is, after GTK is initialized.
            #[cfg(target_os = "linux")]
            install_scrollbar_theme();
            // Record the MAIN window's X11 id so the workspace backend can
            // STRUCTURALLY refuse to ever park it (#42 detached-subwindow
            // parkable override). Resolved off-thread so a slow compositor never
            // blocks startup; the main window has a stable title from
            // tauri.conf.json so `find_window_for_title` finds it.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                let workspace = _app.state::<WorkspaceStateArc>().inner().clone();
                std::thread::spawn(move || {
                    if let Some(id) = platform::x11::find_window_for_title(crate::brand::DISPLAY, 30) {
                        workspace.lock().unwrap().backend.set_main_window_id(id);
                    }
                });
            }
            // Windows: the HWND is known synchronously from Tauri, so no off-thread
            // title scan is needed. Binding the main-window id arms the structural
            // guard so the override can never park the main window (defense-in-depth
            // on top of the self_pid protection that already shields it).
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                let workspace = _app.state::<WorkspaceStateArc>().inner().clone();
                if let Some(hwnd) = _app.get_webview_window("main").and_then(|w| w.hwnd().ok()) {
                    let id = hwnd.0 as usize as u64;
                    workspace.lock().unwrap().backend.set_main_window_id(id);
                    // Add the WS_MAXIMIZEBOX/WS_THICKFRAME styles a borderless wry
                    // window lacks, so dragging the header against a screen edge
                    // triggers the native Aero Snap (top → maximize, sides → half).
                    platform::windows::enable_aero_snap(id);
                }
            }
            // macOS: bind the MAIN window's CGWindowID (== NSWindow.windowNumber)
            // for the structural parkable guard, like the Windows arm above.
            // `ns_window()` must be used on the main thread, which setup is.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                let workspace = _app.state::<WorkspaceStateArc>().inner().clone();
                if let Some(id) = _app
                    .get_webview_window("main")
                    .and_then(|w| w.ns_window().ok())
                    .and_then(|ns| platform::macos::ns_window_id(ns as *mut std::ffi::c_void))
                {
                    workspace.lock().unwrap().backend.set_main_window_id(id);
                }
            }
            // #240: watch for the display arrangement changing and re-fit every
            // detached popout onto a screen that still exists. Undocking from an
            // external monitor otherwise leaves a borderless popout larger than
            // the laptop panel, with its title bar and resize edges off-screen.
            commands::subwindow::spawn_monitor_watcher(_app.handle().clone());
            // Relay the turn state the agents' own hooks record per tab
            // (working / decision / done) to the window's activity store.
            services::agent_turn::start(_app.handle().clone());
            // Install the global Claude SessionStart hook so Tabtivity can follow a
            // tab's live session id across `/clear` (see services::agent_session).
            if let Err(e) = services::agent_bin::install() {
                eprintln!("agent_bin: install commands: {e}");
            }
            if let Err(e) = services::agent_session::install_session_start_hook() {
                eprintln!("agent_session: install SessionStart hook: {e}");
            }
            // Bring legacy `projects.json` entries (written by older Tabtivity
            // versions) up to the current shape and refresh their scaffold, then
            // persist. Off-thread so file I/O never blocks startup; additive and
            // idempotent, so a race with the frontend's first load is benign.
            std::thread::spawn(|| {
                commands::projects::migrate_legacy_projects();
            });
            // One-shot: adopt every existing project's tab layout / `open_apps`
            // out of its project tree and into `<state_dir>/sessions/<id>/`.
            // Synchronous on purpose — it must complete before the frontend's
            // first `load_tab_session`, or a pre-existing project comes up with
            // no tabs and the debounced autosave then persists that emptiness.
            // Cheap: one small file per project, and it no-ops after the first
            // run. See `services::terminal_service::migrate_project_sessions_once`.
            services::terminal_service::migrate_project_sessions_once();
            commands::projects::migrate_panel_prefs_once();
            // A previous run's per-scope stage (private launcher dirs, Seatbelt
            // profiles) is wiped BEFORE the window can restore a tab, so no
            // fenced spawn can race it.
            services::sandbox::clear_stage();
            // The per-CLI login store (`services::agent_auth`): adopt the
            // Claude mirror an older Tabtivity kept, then keep every agent home's
            // links in step with the store. One detached thread; dies with
            // the process.
            services::agent_install::migrate_legacy_stores();
            // Once, at the first start with per-scope homes: this computer's
            // logins and its ~/.claude, ~/.codex, ~/.gemini config, so no
            // agent comes back signed out or without its instructions. Before
            // the keeper and before any tab can spawn.
            services::agent_auth::import_once();
            services::agent_global::import_once();
            services::agent_auth::start();
            // Moves a fenced Copilot's `/login` token out of its private config
            // into the keyring, for every later fenced Copilot tab (the fence
            // hides the keyring Copilot would use). Linux only, like the fence.
            #[cfg(target_os = "linux")]
            services::copilot_auth::start();
            // Remove project containers a previous run left behind (a crash
            // skips the exit teardown). Off-thread: docker may be slow or
            // absent, and neither may block startup.
            std::thread::spawn(services::sandbox::sweep_orphans);
            // Reap project VMs a previous (crashed) run left behind, by
            // pidfile — a VM's lifetime is its app session, so anything alive
            // at startup is an orphan (`docs/vm_projects_plan.md`). Off-thread,
            // same posture as the container sweep above.
            std::thread::spawn(services::vm::sweep_orphans);
            // Unlink ssh ControlMaster sockets a previous run left behind. The
            // master is killed by signal rather than `ssh -O exit`, so the socket
            // outlives it — and a stale one makes OpenSSH disable multiplexing for
            // that target, quietly turning every later channel into its own login.
            // Off-thread: one cheap local `ssh -O check` per file.
            std::thread::spawn(services::ssh_exec::sweep_stale_control_sockets);
            // Remove askpass shims a previous run left behind. Same posture as
            // the socket sweep above and for the same reason: the `Askpass`
            // guard deletes its own file, so anything still there belongs to a
            // process that died before it could. Off-thread — one `kill(pid, 0)`
            // per file, and the directory can hold thousands.
            std::thread::spawn(services::ssh_common::sweep_stale_askpass);
            // Re-adopt OpenVPN tunnels a previous run left running (a crash, an OOM
            // kill, a refused quit-time prompt): the daemon runs as root and outlives
            // the app, still rerouting the machine, but the live-tunnel registries are
            // in-memory and start empty — so without this the VPN lamp reads grey while
            // the machines are in fact reachable through the still-up tunnel. Off-thread
            // (a few pidfile stats); additive and idempotent, so racing the frontend's
            // first `openvpn_active` refresh is benign.
            #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
            std::thread::spawn(services::openvpn::adopt_orphans);
            // Start the background per-project SSH-link traffic sampler so each
            // remote project's daily/monthly/overall usage accrues even when its
            // Network Traffic tab is closed (see services::net_usage). No-op on
            // non-Linux.
            {
                use tauri::Manager;
                let pool = _app
                    .state::<services::remote::RemotePoolState>()
                    .inner()
                    .clone();
                services::net_usage::start(pool);
            }
            // Periodically fold the file-churn the watcher has seen into
            // `usage_stats.json` (see services::usage_stats). The watcher itself is
            // attached on project activation, via `usage_watch_project`.
            services::usage_stats::start(usage_watch);
            // Place the main window where it was last closed and MAKE IT VISIBLE.
            // Must stay last in `setup`: the window is created hidden (see
            // `restore_main_window`), so anything that returns early before this
            // leaves Tabtivity running with no window on screen.
            restore_main_window(_app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::patch_settings,
            commands::settings::save_window_state,
            commands::os_clock::os_clock_format,
            // Per-tab scheduled agent prompts. Definitions and receipts live in
            // local-only agent_tasks.json; the frontend owns wall-clock delivery.
            commands::agent_tasks::agent_schedules_list,
            commands::agent_tasks::timer_lease_acquire,
            commands::agent_tasks::timer_lease_release,
            commands::agent_tasks::agent_schedule_upsert,
            commands::agent_tasks::agent_schedule_delete,
            commands::agent_tasks::agent_schedules_delete_target,
            commands::agent_tasks::agent_schedule_claim,
            commands::agent_tasks::agent_schedule_complete,
            commands::agent_tasks::agent_schedules_cleanup_orphans,
            // Project-scoped prompt collection (agent_prompts.json): text with no
            // tab binding until the user aims it at an agent tab.
            commands::agent_prompts::agent_prompts_list,
            commands::agent_prompts::agent_prompt_links_list,
            commands::agent_prompts::agent_prompt_link_upsert,
            commands::agent_prompts::agent_prompt_link_delete,
            commands::agent_prompts::agent_prompt_upsert,
            commands::agent_prompts::agent_prompt_delete,
            commands::agent_prompts::agent_prompt_reorder,
            commands::agent_prompts::agent_prompt_history_list,
            commands::agent_prompts::agent_prompt_archive,
            commands::agent_prompts::agent_prompt_record,
            commands::agent_prompts::agent_prompt_blame,
            commands::agent_prompts::agent_prompt_history_clear,
            // Updates (Settings → Updates): check the GitHub releases page,
            // download this platform's artifact, hand it to its installer.
            commands::brand_migration::legacy_name_status,
            commands::app_update::check_app_update,
            commands::app_update::download_app_update,
            commands::app_update::install_app_update,
            commands::app_update::app_update_staged,
            commands::app_update::app_update_releases_url,
            commands::mobile_control::mobile_desktop_respond,
            commands::mobile_control::mobile_opaque_id,
            commands::mobile_control::mobile_prepare_phone_install_script,
            commands::mobile_control::mobile_admin,
            commands::mobile_control::mobile_paired_devices,
            commands::mobile_control::mobile_host_status,
            commands::mobile_control::mobile_host_apply,
            commands::mobile_control::mobile_verify_tailscale_serve,
            commands::mobile_control::mobile_tailscale_serve_status,
            commands::mobile_control::mobile_desktop_images,
            commands::mobile_control::mobile_attach_desktop_image,
            commands::mobile_control::global_inbox_list,
            commands::mobile_control::global_inbox_open,
            commands::mobile_control::global_inbox_reveal,
            commands::mobile_control::global_inbox_delete,
            commands::default_apps::get_default_apps,
            commands::default_apps::save_default_apps,
            commands::default_apps::patch_default_apps,
            // Projects
            commands::projects::get_projects,
            commands::projects::save_projects,
            commands::projects::load_project,
            commands::projects::save_project,
            commands::projects::set_project_description,
            commands::projects::set_project_name,
            commands::projects::plan_project_dir_rename,
            commands::projects::rename_project_dir,
            commands::projects::set_project_sandbox,
            commands::projects::set_project_sandbox_spec,
            commands::vm::vm_doctor,
            commands::vm::vm_status,
            commands::vm::vm_boot,
            commands::vm::vm_shutdown,
            commands::vm::vm_rebuild,
            commands::vm::vm_blocked,
            commands::vm::vm_allow_temporarily,
            commands::vm::vm_set_spec,
            commands::vm::vm_unpushed_commits,
            commands::vm::remote_download_size,
            commands::vm::remote_download_to,
            commands::projects::set_project_remote_control,
                        commands::projects::set_project_schedule_mcp,
            commands::projects::set_project_git_push_mcp,
            commands::root_mcp::git_push_mcp_proposals,
            commands::root_mcp::git_push_mcp_decide,
            commands::root_mcp::git_push_mcp_clear,
            commands::markup_mcp::markup_mcp_list,
            commands::markup_mcp::markup_mcp_answer,
            commands::markup_mcp::markup_mcp_dismiss,
            commands::markup_mcp::markup_mcp_reopen,
            commands::projects::set_project_mobile_access,
            commands::projects::sandbox_preflight,
            commands::python::python_interpreters,
            commands::python::python_interpreter_for,
            commands::python::set_project_python,
            commands::slurm::slurm_available,
            commands::slurm::slurm_submit,
            commands::slurm::slurm_queue,
            commands::slurm::slurm_job_out,
            commands::slurm::slurm_cancel,
            commands::hpc_ws::hpc_ws_available,
            commands::hpc_ws::hpc_ws_list,
            commands::hpc_ws::hpc_ws_allocate,
            commands::hpc_ws::hpc_ws_extend,
            commands::hpc_ws::hpc_ws_release,
            commands::hpc_ws::hpc_ws_link,
            commands::hpc_ws::hpc_ws_anchor,
            commands::hpc_ws::hpc_scratch_candidates,
            commands::hpc_ws::hpc_ws_pull_logs,
            commands::hpc_ws::hpc_ws_move_root,
            commands::hpc_ws::set_project_hpc,
            commands::projects::set_project_openvpn,
            commands::projects::set_project_auto_connect,
            commands::projects::set_project_persist_sessions,
            commands::projects::set_project_remote_label,
            commands::projects::set_project_remote_user,
            commands::projects::add_compute_host,
            commands::projects::remove_compute_host,
            commands::projects::patch_compute_host,
            commands::projects::set_project_run_host,
            commands::projects::set_project_categories,
            commands::projects::set_project_git_disabled,
            commands::projects::save_tab_layout,
            commands::projects::load_tab_session,
            commands::projects::workspace_snapshot,
            commands::projects::workspace_sync,
            commands::projects::adopt_folder_tab_layout,
            commands::projects::root_work_dir,
            commands::root_mcp::root_mcp_status,
            commands::root_mcp::help_search,
            commands::root_mcp::help_read,
            commands::root_mcp::help_topics,
            commands::root_mcp::root_mcp_security_status,
            commands::root_mcp::root_mcp_session_access,
            commands::root_mcp::root_mcp_session_revoke,
            commands::root_mcp::root_mcp_review_list,
            commands::root_mcp::root_mcp_review_apply,
            commands::root_mcp::root_mcp_review_reject,
            commands::root_mcp::root_mcp_review_apply_all,
            commands::root_mcp::root_mcp_review_undo,
            commands::root_mcp::root_mcp_import_list,
            commands::root_mcp::root_mcp_import_remove,
            commands::projects::projects_root_dir,
            commands::projects::remote_mirror_root_dir,
            commands::projects::open_in_file_manager,
            commands::projects::remote_mirror_status,
            commands::projects::set_remote_mirror_dir,
            commands::projects::move_remote_mirror,
            commands::projects::create_project,
            commands::projects::preview_project_scaffold,
            commands::projects::project_scaffold_missing,
            commands::projects::repair_project_scaffold,
            commands::projects::repair_all_project_scaffolds,
            commands::projects::project_migration_plan,
            commands::projects::project_migration_apply,
            commands::projects::import_project,
            commands::projects::check_project_site,
            commands::projects::project_folder_exists,
            commands::projects::extend_project_to_remote,
            commands::projects::detach_project_from_remote,
            commands::projects::get_time_today,
            commands::projects::archive_project,
            commands::projects::forget_project,
            commands::projects::list_archived_projects,
            commands::projects::restore_archived_project,
            commands::projects::delete_archived_project,
            commands::projects::archived_mirror_unsynced,
            commands::projects::clear_archive,
            // Full project export / import (docs/context/project_transfer.md)
            commands::project_transfer::preview_project_export,
            commands::project_transfer::export_project,
            commands::project_transfer::inspect_project_export,
            commands::project_transfer::import_project_export,
            // Project boxes (meta-project grouping)
            commands::boxes::get_boxes,
            commands::boxes::save_boxes,
            commands::boxes::create_box,
            commands::boxes::rename_box,
            commands::boxes::delete_box,
            commands::boxes::set_box_members,
            commands::boxes::ensure_box_folder,
            commands::boxes::refresh_box_agent_docs,
            commands::boxes::set_box_relations,
            commands::boxes::set_box_mobile_access,
            // Native calendar (local event store)
            commands::calendar::calendar_load,
            commands::calendar::calendar_save,
            commands::calendar::create_event,
            commands::calendar::update_event,
            commands::calendar::delete_event,
            commands::calendar::create_task,
            commands::calendar::update_task,
            commands::calendar::delete_task,
            commands::calendar::todo_move_tasks,
            commands::calendar::todo_columns_set,
            commands::calendar::create_calendar,
            commands::calendar::update_calendar,
            commands::calendar::delete_calendar,
            commands::calendar::restore_calendar,
            commands::calendar::calendar_read_ics,
            commands::calendar::calendar_write_ics,
            commands::calendar::calendar_fetch_ics,
            commands::calendar::calendar_alarms_claim,
            commands::markdown::markdown_remote_image,
            commands::calendar::calendar_replace_events,
            // CalDAV accounts (docs/caldav_plan.md, Phases 1-3).
            // A sync is deliberately two commands: `caldav_fetch` speaks the
            // protocol and hands back iCalendar text unparsed, the frontend
            // parses it with `src/lib/calendar/ics.ts` (the one parser that understands
            // folding/RRULE/VALARM), and `caldav_apply` reconciles the result
            // into calendar.json by `caldav_href` — a field-level merge, never
            // the delete-and-reinsert `calendar_replace_events` does, because
            // an unattended sync must not evict a card from the to-do column
            // the user dragged it into.
            commands::caldav::caldav_accounts_list,
            commands::caldav::caldav_account_upsert,
            commands::caldav::caldav_account_delete,
            commands::caldav::caldav_password_state,
            commands::caldav::caldav_forget_password,
            commands::caldav::caldav_discover,
            commands::caldav::caldav_fetch,
            commands::caldav::caldav_apply,
            // The push half, same seam mirrored: `ics.ts` serializes, these
            // speak the protocol. Every write is conditional (If-Match /
            // If-None-Match), a 412 comes back as a *conflict value* rather
            // than an error, and both the account's opt-in and the server's
            // own privilege report have to allow it before either runs.
            commands::caldav::caldav_push,
            commands::caldav::caldav_delete,
            commands::caldav::caldav_resource_etag,
            commands::caldav::caldav_refresh_access,
            // Embedded mail client (docs/mail_client_plan_{a,b}.md). Every one
            // of these is `async` on purpose — a sync command runs on the main
            // thread, and an unreachable IMAP server would freeze the whole
            // window for the TCP timeout. None of them takes a path: files
            // cross the boundary only through `mail_attach_pick` /
            // `mail_attachment_save`, which raise the OS dialog inside Rust.
            commands::mail::mail_accounts_list,
            commands::mail::mail_account_set_ai,
            commands::mail::mail_account_upsert,
            commands::mail::mail_account_delete,
            commands::mail::mail_account_test,
            commands::mail::mail_password_state,
            commands::mail::mail_forget_password,
            commands::mail::mail_folders,
            commands::mail::mail_sync,
            commands::mail::mail_sync_cancel,
            commands::mail::mail_headers,
            commands::mail::mail_search,
            commands::mail::mail_replies,
            commands::mail::mail_body,
            commands::mail::mail_flag,
            commands::mail::mail_mark_folder_read,
            commands::mail::mail_move,
            commands::mail::mail_purge,
            // Priority marks (Important / Urgent). The only mail commands that
            // touch no network at all: the lists span every account, and no IMAP
            // folder can hold two accounts' mail, so the mark is a local column
            // rather than a move (schema::mail::MailPriority).
            commands::mail::mail_priority_set,
            commands::mail::mail_priority_page,
            commands::mail::mail_priority_counts,
            commands::mail::mail_priority_clear,
            // The keyword rules that set those marks automatically. Local for
            // the same reason: a rule writes the same column the right-click
            // menu writes, so nothing here reaches a server either.
            commands::mail::mail_filters_list,
            commands::mail::mail_filters_set,
            commands::mail::mail_contacts_get,
            commands::mail::mail_contact_upsert,
            commands::mail::mail_contacts_delete,
            commands::mail::mail_contact_list_upsert,
            commands::mail::mail_contact_list_delete,
            commands::mail::mail_contacts_set_collect,
            commands::mail::mail_contacts_import,
            commands::mail::mail_contacts_import_thunderbird,
            commands::mail::mail_contacts_harvest_inbox,
            commands::mail::mail_contacts_export,
            commands::mail::mail_filters_apply,
            // Local-model mail assistant (Group Q, #203–#208). Every one runs a
            // prompt against a loopback Ollama via `services::mail_ai`, which
            // refuses a remote host even with `ollama_allow_remote_host` on —
            // nothing about a message ever leaves this machine.
            commands::mail::mail_summarize,
            commands::mail::mail_formalize_reply,
            commands::mail::mail_extract_event,
            commands::mail::mail_extract_task,
            commands::mail::mail_ai_classify_apply,
            commands::mail::mail_draft_save,
            commands::mail::mail_agent_drafts,
            commands::mail::mail_draft_discard,
            commands::mail::mail_agent_drafts_file,
            commands::mail::mail_agent_mark,
            commands::mail::mail_agent_mark_folder,
            commands::mail::mail_agent_mark_sender,
            commands::mail::mail_agent_marks,
            commands::mail::mail_draft_send,
            commands::mail::mail_attach_pick,
            commands::mail::mail_attach_remove,
            commands::mail::mail_attachment_save,
            commands::mail::mail_attachment_save_to_project,
            commands::mail::mail_attachment_preview,
            commands::mail::mail_staged_preview,
            // Encryption at rest (docs/mail_encryption_plan.md). Four verbs
            // rather than a toggle, because the states are not symmetric: a
            // store waiting for a passphrase, and one running memory-only
            // because its key could not be reached, both look like a working
            // mailbox and neither is.
            commands::mail::mail_encryption_state,
            commands::mail::mail_encryption_enable,
            commands::mail::mail_encryption_unlock,
            commands::mail::mail_encryption_decline,
            commands::mail::mail_encryption_reset,
            // OpenPGP (docs/mail_encryption_plan.md §6). The keyring needs an
            // encrypted store — a private key in a plaintext file would make
            // the whole feature theatre — so `mail_pgp_available` is the one
            // bool the UI gates the whole surface on.
            commands::mail::mail_pgp_available,
            commands::mail::mail_pgp_keys,
            commands::mail::mail_pgp_generate,
            commands::mail::mail_pgp_import,
            commands::mail::mail_pgp_import_pick,
            commands::mail::mail_pgp_export,
            commands::mail::mail_pgp_set_verified,
            commands::mail::mail_pgp_bind,
            commands::mail::mail_pgp_delete,
            commands::mail::mail_pgp_recipients_ready,
            // In-app browser (docs/browser_plan_{a,b,c}.md, TODO J #61). Two
            // surfaces, neither an embedded pane: a JS-free reader tab that is
            // fetched and sanitized in Rust, and a separate hardened
            // `browser-*` window with an ephemeral profile that no capability
            // grants anything to. Every one is `async` (a sync command would
            // freeze the window for the fetch timeout or the window build), and
            // none takes a path — `url` is the one deliberate exception and it
            // goes through the navigation gate before anything else touches it.
            commands::browser::browser_capabilities,
            commands::browser::browser_check_url,
            commands::browser::browser_reader_fetch,
            commands::browser::browser_open_live,
            commands::browser::browser_close_live,
            commands::browser::browser_list_live,
            commands::browser::browser_download_decide,
            commands::browser::browser_clear_data,
            // SSH / remote projects
            commands::ssh::ssh_connect,
            commands::ssh::ssh_probe,
            commands::ssh::remote_has_saved_password,
            commands::ssh::remote_saved_password_state,
            commands::ssh::remote_forget_password,
            commands::ssh::remote_kill_all_jobs,
            commands::ssh::ssh_close_master,
            commands::ssh::remote_login_command,
            commands::ssh::ssh_default_dir,
            commands::ssh::ssh_list_dir,
            commands::ssh::ssh_mkdir,
            // Pooled SSH/SFTP connection lifecycle (mount-free remote, Phase 0)
            commands::remote::remote_connect,
            commands::remote::remote_disconnect,
            commands::remote::remote_disconnect_all_hosts,
            commands::remote::remote_connected_ids,
            commands::remote::remote_connected_targets,
            commands::remote::worker_sync_now,
            commands::remote::worker_outputs_preview,
            commands::remote::worker_pull_outputs,
            commands::remote::remote_upload_file,
            commands::remote::remote_usage_check,
            // Global machines (cross-project compute host registry)
            commands::global_machines::global_machines_list,
            commands::global_machines::global_machine_add,
            commands::global_machines::global_machine_update,
            commands::global_machines::global_machine_set_auto_connect,
            commands::global_machines::global_machine_remove,
            commands::global_machines::global_machine_reorder,
            commands::global_machines::global_machine_monitor_snapshot,
            commands::global_machines::global_machine_usage_check,
            commands::global_machines::global_machine_tmux_list,
            commands::global_machines::global_machines_export,
            commands::global_machines::global_machines_import_read,
            commands::remote::remote_tmux_list,
            commands::remote::remote_tmux_kill,
            commands::remote::remote_tmux_rename,
            // Read-only local/remote host + SSH transport monitoring.
            commands::network::network_host_snapshot,
            commands::network::network_ssh_link_snapshot,
            commands::net_usage::get_net_usage,
            // Usage counters + daily recap.
            commands::usage_stats::usage_bump,
            commands::usage_stats::usage_summary,
            commands::usage_stats::usage_token_stats,
            commands::usage_stats::usage_watch_project,
            commands::usage_stats::usage_git_stats,
            commands::monitor::system_monitor_snapshot,
            commands::monitor::gpu_memory_snapshot,
            commands::monitor::machine_load_snapshot,
            commands::monitor::gpu_process_snapshot,
            // AC-vs-battery detection for Energy Saver mode.
            commands::power::get_power_state,
            // SSH-sync (Phase 1): selective local↔remote mirror sync.
            commands::sync::sync_pull,
            commands::sync::sync_whole_project,
            commands::sync::sync_push,
            commands::sync::sync_mark_selected,
            commands::sync::sync_set_auto,
            commands::sync::sync_auto_preview,
            commands::sync::sync_transfer_preview,
            commands::sync::sync_big_folders,
            commands::sync::sync_set_excluded,
            commands::sync::sync_status,
            commands::sync::sync_file_meta,
            commands::sync::sync_resolve_if_identical,
            commands::sync::sync_apply_delete,
            commands::sync::sync_diff,
            commands::ssh::ssh_tooling_status,
            commands::ssh::ssh_host_key_preview,
            commands::ssh::ssh_trust_host_key,
            commands::ssh::ssh_list_addresses,
            commands::ssh::ssh_remember_address,
            commands::ssh::remote_list_paths,
            commands::ssh::remote_remember_path,
            commands::ssh::remote_list_default_paths,
            commands::ssh::remote_get_default_path,
            commands::ssh::remote_set_default_path,
            commands::ssh::open_external_url,
            // OpenVPN tunnels for VPN-gated remote projects
            commands::openvpn::openvpn_connect,
            commands::openvpn::openvpn_auth_needs,
            commands::openvpn::vpn_has_saved_password,
            commands::openvpn::vpn_saved_password_state,
            commands::openvpn::vpn_can_connect_silently,
            commands::openvpn::vpn_forget_password,
            commands::openvpn::openvpn_login_command,
            commands::openvpn::openvpn_disconnect,
            commands::openvpn::openvpn_disconnect_all_on_quit,
            commands::openvpn::openvpn_status,
            commands::openvpn::openvpn_active,
            commands::openvpn::openvpn_store_config,
            commands::openvpn::openvpn_list_configs,
            commands::openvpn::openvpn_remove_config,
            // The credential store itself (locked vs readable), shared by SSH + VPN
            commands::credentials::keyring_state,
            commands::credentials::keyring_unlock,
            commands::credentials::credential_paste_to_pty,
            // Git hosting (GitHub / GitLab) publishing
            commands::git_publish::publish_project,
            commands::git_publish::project_has_origin,
            commands::git_publish::unpublish_project,
            commands::git_publish::set_project_visibility,
            commands::git_publish::switch_project_provider,
            // Fork + clone (the import dialog's "fork a repository" source)
            commands::git_fork::git_fork_clone,
            commands::git_fork::provider_cli_available,
            commands::git_hosting::get_project_git_hosting,
            commands::git_hosting::set_project_git_hosting,
            // Timer flush + activity
            commands::timer::timer_flush_app,
            commands::timer::timer_flush_project,
            commands::timer::get_project_activity,
            commands::timer::get_time_activity_all,
            // File tree + file I/O (commands::fs)
            commands::fs::list_dir,
            commands::fs::list_recent_downloads,
            commands::fs::dir_size,
            commands::fs::dir_size_breakdown,
            commands::fs::list_dirs,
            commands::fs::list_project_endings,
            commands::fs::list_project_paths,
            commands::fs::rename_path,
            commands::fs::copy_path,
            commands::fs::move_path,
            commands::fs::import_external_file,
            commands::fs::project_path_exists,
            commands::fs::extract_archive,
            commands::clipboard::clipboard_has_image,
            commands::clipboard::save_clipboard_image,
            commands::clipboard::copy_png_bytes_to_clipboard,
            commands::clipboard::copy_text_to_clipboard,
            commands::screenshot::capture_screenshot,
            commands::projects::project_generated_dir,
            commands::screenshot::read_pending_screenshot,
            commands::screenshot::save_pending_screenshot,
            commands::screenshot::discard_pending_screenshot,
            commands::fs::delete_file,
            commands::fs::delete_dir,
            commands::fs::create_file,
            commands::fs::write_project_file,
            commands::fs::write_project_file_bytes,
            commands::fs::update_gitignore_rule,
            commands::fs::create_dir,
            commands::fs::detect_mime,
            commands::fs::file_source,
            commands::fs::read_file_text,
            commands::fs::write_file_text,
            commands::fs::read_file_bytes,
            commands::fs::write_file_bytes,
            commands::pdf_clip::pdf_clip_set,
            commands::pdf_clip::pdf_clip_get,
            commands::pdf_markup::pdf_markup_submit,
            commands::fs::file_mtime,
            commands::format::format_source,
            commands::format::formatter_available,
            commands::format::check_syntax,
            commands::fs_watch::watch_dir,
            commands::fs_watch::unwatch_dir,
            // Print manager (commands::printing)
            commands::printing::print_system_snapshot,
            commands::printing::print_job_cancel,
            commands::printing::print_jobs_cancel_all,
            commands::printing::print_set_default,
            commands::printing::print_set_enabled,
            commands::printing::print_test_page,
            commands::print_native::print_pdf_native,
            // Disk usage analyzer (commands::disk_usage)
            commands::disk_usage::disk_usage_scan,
            commands::disk_usage::disk_usage_cancel,
            commands::disk_usage::disk_usage_devices,
            // LaTeX view / compile (gated on a TeX engine being on PATH)
            commands::tex::tex_capability,
            commands::tex::compile_tex,
            commands::tex::tex_preview_snippet,
            commands::tex::synctex_edit,
            commands::tex::synctex_status,
            commands::tex::synctex_view,
            commands::tex::synctex_page_lines,
            commands::tex::list_fonts,
            commands::tex::resolve_tex_root,
            // Terminal
            commands::terminal::pty_spawn,
            commands::terminal::agent_fence_status,
            commands::terminal::copilot_fence_auth_status,
            commands::terminal::copilot_fence_sign_out,
            commands::terminal::agent_fence_marks,
            commands::terminal::register_host_bound_tab,
            commands::terminal::pty_write,
            commands::terminal::pty_resize,
            commands::terminal::pty_kill,
            commands::terminal::pty_kill_scope,
            commands::terminal::pty_set_visible,
            commands::terminal::pty_remove_view,
            commands::terminal::pty_scrollback,
            commands::terminal::pty_watch,
            commands::terminal::pty_unwatch,
            commands::terminal::local_tmux_list,
            commands::terminal::local_tmux_kill,
            commands::terminal::local_tmux_kill_app_sessions,
            commands::terminal::local_tmux_rename,
            commands::terminal::local_tmux_screen,
            commands::terminal::project_cpu_percent,
            // External apps / window tracking
            commands::apps::launch_app,
            commands::apps::resolve_app_icon,
            commands::apps::open_file,
            commands::apps::list_tracked_windows,
            commands::apps::untrack_window,
            commands::apps::close_tracked_window,
            commands::apps::check_pid_alive,
            commands::apps::restore_open_apps,
            commands::apps::run_script_detached,
            commands::apps::drag_preview_icon,
            commands::apps::start_file_drag,
            commands::apps::cancel_file_drag,
            commands::apps::embed_capability,
            commands::apps::get_project_default_apps,
            commands::apps::set_project_default_apps,
            commands::exec_trust::exec_trust_approve,
            commands::projects::set_project_panel_prefs,
            commands::projects::get_project_panel_prefs,
            commands::apps::list_installed_apps,
            commands::ide::detect_project_ides,
            commands::ide::open_project_in_ide,
            commands::ide::set_ide_launcher,
            // Workspace / network
            commands::workspace::workspace_info,
            commands::workspace::workspace_capabilities,
            commands::workspace::workspace_switch,
            commands::workspace::desktop_owns_super_key,
            commands::workspace::show_window,
            commands::workspace::hide_window,
            commands::workspace::get_opened_windows,
            commands::workspace::switch_project_windows, // deprecated; use switch_project_runtime
            // Detached subwindows (#42)
            commands::subwindow::detach_subwindow,
            commands::subwindow::attach_subwindow,
            commands::subwindow::detached_window_frontmost,
            commands::subwindow::desktop_coordinates_supported,
            commands::subwindow::snap_detached_window,
            commands::subwindow::focus_detached_window,
            commands::subwindow::sync_detached_scope,
            commands::subwindow::detached_window_is_parked,
            commands::subwindow::detached_retire_ack,
            commands::subwindow::detached_retire_ready,
            // The deck presenter's audience window (M#90)
            commands::presenter::open_presenter_window,
            commands::presenter::close_presenter_window,
            commands::presenter::presenter_inhibit_sleep,
            commands::presenter::presenter_release_sleep,
            commands::workspace::workspace_name,
            commands::workspace::network_conn_type,
            commands::workspace::network_wifi_ssid,
            commands::workspace::network_identity,
            // Project-runtime switching (replaces switch_project_windows)
            commands::project_runtime::switch_project_runtime,
            commands::project_runtime::load_side_panel_folder,
            commands::project_runtime::save_side_panel_folder,
            // Git
            commands::git::git_available,
            commands::git::git_status,
            commands::git::git_dirty_probe,
            commands::git::git_repo_root,
            commands::git::detect_git_providers,
            commands::git::git_add_all,
            commands::git::git_generate_commit_message,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_release_preview,
            commands::git::git_release_tag,
            commands::git_pull::git_fetch,
            commands::git_pull::git_pull_preview,
            commands::git_pull::git_pull_apply,
            commands::git_pull::git_merge_state,
            commands::git_pull::git_merge_abort,
            commands::git_pull::git_merge_commit,
            commands::git_pull::git_merge_sides,
            commands::git::git_clone,
            commands::git::git_remote_visibility,
            commands::git::git_file_statuses,
            commands::git::git_unpushed_commits,
            commands::git::git_change_stats,
            commands::git::git_add_path,
            commands::git::git_log,
            commands::git::git_log_search,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_commit_message,
            commands::git::git_reword_head,
            commands::git_peer::git_peer_status,
            commands::git_peer::git_peer_set_enabled,
            commands::git_peer::git_peer_sync_now,
            commands::git_peer::git_peer_checkout,
            commands::git_peer::git_peer_resolve,
            commands::git_peer::git_peer_pair_confirm,
            commands::git_peer::git_peer_backups,
            commands::git_peer::git_peer_restore_backup,
            commands::git_peer::git_peer_mirror_dir,
            // Local-loss warnings (#28q): what lockstep/sync destroyed in the mirror.
            commands::local_loss::local_loss_list,
            commands::local_loss::local_loss_ack,
            commands::git::git_diff_file,
            commands::git::git_blame,
            commands::git::git_file_log,
            commands::git::git_file_at_rev,
            // Project-wide content search
            commands::search::project_search,
            // SQLite database browser (Dev C)
            commands::sqlite::sqlite_tables,
            commands::sqlite::sqlite_page,
            // Spreadsheet (.xlsx/.xls) reader (Dev G)
            commands::sheets::read_spreadsheet,
            // Skills Library (docs/skills_plan.md)
            commands::skills::skills_list_sources,
            commands::skills::skills_add_source,
            commands::skills::skills_remove_source,
            commands::skills::skills_refresh_source,
            commands::skills::skills_list_catalog,
            commands::skills::skills_get_detail,
            commands::skills::skills_install,
            commands::skills::skills_uninstall,
            commands::skills::skills_list_installed,
            // Git worktrees (TODO Group E #23)
            commands::git::git_worktree_list,
            commands::git::git_worktree_selection_supported,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_worktree_lock,
            commands::git::git_worktree_unlock,
            commands::git::git_worktree_prune,
            // Crash reporting
            commands::crash::report_frontend_error,
            // Debug diagnostics
            commands::debug::debug_app_resource_usage,
            commands::debug::app_build_commit,
            commands::debug::dev_build_status,
            commands::debug::dev_build_relaunch,
            commands::debug::dev_build_set_paused,
            commands::debug::dev_build_now,
            commands::debug::dev_todo_groups,
            commands::debug::dev_todo_read,
            commands::debug::dev_todo_write,
            commands::debug::webview_rss_kib,
            commands::debug::webview_renderer_rss,
            commands::debug::webview_renderer_claim,
            commands::debug::webview_renderer_memory,
            commands::debug::webview_renderer_restart,
            // Ollama local models
            commands::ollama::list_ollama_models,
            commands::ollama::ensure_vibe_ollama_model,
            commands::ollama::prepare_local_agent,
            commands::ollama::list_local_drivers,
            commands::ollama::prepare_local_launch,
            commands::ollama::ensure_ollama_running,
            // Ollama model management
            commands::ollama::ollama_is_installed,
            commands::ollama::install_ollama,
            commands::ollama::ollama_install_strategy,
            commands::ollama::vibe_is_installed,
            commands::ollama::install_vibe,
            commands::ollama::vibe_install_strategy,
            commands::agents::agent_is_installed,
            commands::agents::node_runtime_status,
            commands::agents::probe_binaries,
            commands::agents::list_agents,
            commands::agents::codex_hook_status,
            commands::agents::install_agent,
            commands::agents::install_agent_remote,
            commands::agents::install_agent_remote_command,
            commands::agents::uninstall_agent,
            commands::agents::agent_warmup,
            commands::agents::claude_folder_trusted,
            commands::agents::agent_logins,
            commands::agents::agent_login_import,
            commands::agents::agent_login_sign_out,
            commands::agents::agent_global_status,
            commands::agents::agent_global_import,
            commands::agents::agent_global_set_codex_auto_review,
            commands::agents::agent_global_open,
            commands::agents::agent_usage,
            commands::agents::agent_versions,
            commands::agents::dismiss_agent_version,
            commands::agents::check_agent_updates,
            commands::agents::update_agent,
            commands::agents::agent_tab_model,
            commands::agents::agent_tab_goal,
            commands::agents::agent_tab_last_prompt,
            commands::agents::agent_tab_recent_prompts,
            commands::agents::agent_tab_transcript,
            commands::agents::agent_tab_changes,
            commands::agents::agent_tab_undo_clear,
            commands::ollama::ollama_is_running,
            commands::ollama::ollama_status,
            commands::ollama::ollama_gpu_status,
            commands::ollama::ollama_models_dir_plan,
            commands::ollama::ollama_registry_size,
            commands::ollama::ollama_registry_details,
            commands::ollama::list_ollama_models_detailed,
            commands::ollama::stop_ollama_model,
            commands::ollama::load_ollama_model,
            commands::ollama::list_pending_ollama_pulls,
            commands::ollama::clear_pending_ollama_pull,
            commands::ollama::list_orphan_partial_blobs,
            commands::ollama::delete_partial_blob,
            commands::ollama::pull_ollama_model,
            commands::ollama::pause_ollama_pull,
            commands::ollama::delete_ollama_pull,
            commands::ollama::delete_ollama_model,
            commands::ollama::ollama_check_updates,
            commands::ollama::ollama_version_status,
            commands::ollama::list_installable_models,
            commands::ollama::search_ollama_registry,
            // Local code/text autocomplete (opt-in, local-only)
            commands::ollama::complete_text,
            commands::ollama::prepare_text_completion,
            commands::ollama::cancel_text_completion,
            commands::copilot::copilot_setup,
            commands::copilot::copilot_project_policy,
            commands::copilot::copilot_set_project_policy,
            commands::copilot::copilot_complete,
            commands::copilot::copilot_prepare,
            commands::copilot::copilot_cancel,
            commands::copilot::copilot_close_editor,
            commands::copilot::copilot_shown,
            commands::copilot::copilot_accepted,
            commands::copilot::copilot_account,
            commands::copilot::copilot_message_action,
            commands::copilot::copilot_sign_in,
            commands::copilot::copilot_finish_sign_in,
            commands::copilot::copilot_sign_out,
            commands::copilot::copilot_stop,
            // Dictionary spell check (Hunspell dictionaries, local-only)
            commands::spell::spell_check,
            commands::spell::spell_languages,
            commands::spell::spell_add_word,
            commands::spell::spell_dictionaries,
            commands::spell::spell_install_language,
            commands::spell::spell_remove_language,
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_notification::init())
        .build(context)
        .expect("error while building tauri application")
        .run(|_app, event| {
            // A detached popout can die WITHOUT going through `attach_subwindow`
            // (seed-timeout self-destroy, last-tab close, the WM-close safety
            // net in DetachedApp). Free its registry footprint — display number
            // ("Tabtivity win-N"), TrackedWindow, parkable override — here, the one
            // choke point every destruction passes, so freed numbers get reused
            // and a lone popout is always "win-1". The dock-back path fires this
            // after `attach_subwindow` already freed; the release is idempotent.
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                use tauri::{Emitter, Manager};
                // The main window going away must take every other Tabtivity window
                // with it. Popouts, the deck presenter and live browser pages are
                // siblings of `main` in this process, not children of it, so
                // nothing closes them on their own: they would strand on screen
                // and — since Tauri exits only on the LAST window — keep a
                // windowless Tabtivity running behind them. The shell's own
                // `shutdownDetachedWindows` already tears popouts down (before
                // `destroy()`, so their bounds are persisted first); this is the
                // net under it, for the windows it does not cover and for the
                // quits it never runs on (hung/crashed renderer, WM kill).
                if label == services::window_service::MAIN_WINDOW_LABEL {
                    let open: Vec<String> = _app.webview_windows().into_keys().collect();
                    for other in services::window_service::windows_closed_with_main(
                        open.iter().map(String::as_str),
                    ) {
                        if let Some(win) = _app.get_webview_window(&other) {
                            if let Err(e) = win.destroy() {
                                eprintln!("close with main: destroy {other}: {e}");
                            }
                        }
                    }
                }
                // Group B #238: every teardown of a secondary window uses
                // `destroy()`, which runs no renderer cleanup — so its panes
                // never call `pty_remove_view` and the output router keeps a
                // `visible: true` viewer under a dead window's uuid. The PTY
                // then streams over IPC for the rest of the session, for every
                // tab that ever lived in that window. Drop the whole window's
                // registrations here, the one choke point every death passes.
                // Not limited to popouts: the presenter and live browser
                // windows are destroyed the same way.
                if label != services::window_service::MAIN_WINDOW_LABEL {
                    crate::terminal::route_drop_window_views(label);
                }
                if label.starts_with("detached-") {
                    // Guard against a same-label window already re-created
                    // (rapid destroy → re-detach): only clean up when no live
                    // window holds the label, else we'd free the NEW window's
                    // number while it is still on screen.
                    if _app.get_webview_window(label).is_none() {
                        let reg = _app.state::<WindowRegistryState>();
                        // A Wayland scope-out retire is an intended close whose
                        // record stays for the respawn: released, not reported.
                        let (wid, report) = commands::subwindow::on_detached_destroyed(
                            &mut reg.lock().unwrap(),
                            label,
                        );
                        if let Some(wid) = wid {
                            let ws = _app.state::<commands::workspace::WorkspaceStateArc>();
                            ws.lock().unwrap().backend.unset_parkable(wid);
                        }
                        // Group B #224: tell the frontend a popout died. A
                        // legitimate teardown drops the store record BEFORE the
                        // window goes, so the host finds none and does nothing;
                        // a record still standing means the window died behind
                        // the store's back (xkill, a renderer crash, the
                        // seed-timeout self-destroy) — and without this its tabs
                        // were stranded in a `detached: true` record with no
                        // window, no dock-back path, their PTYs running hidden,
                        // and the failure repeated at every launch.
                        if report {
                            let _ = _app.emit(
                                "detached-window-destroyed",
                                serde_json::json!({ "label": label }),
                            );
                        }
                    }
                }
            }
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                // Old-name lookups counted since the last write (nothing
                // while the app's name is unchanged).
                services::brand_migration::hits::flush();
                // Stop the Tabtivity Mobile host first: its lifetime is the app's
                // (started again at the next launch, see `setup`), and once the
                // desktop is gone it can neither create tabs nor reach the
                // sessions reaped below, so a host left running would only be a
                // listener with nothing behind it. Bounded (admin-socket
                // timeouts), best-effort, and a no-op when Mobile is off.
                tauri::async_runtime::block_on(commands::mobile_control::stop_host_for_exit());
                // The root MCP listener: stop accepting, drain in-flight
                // workers briefly, and drop every per-tab calendar copy so
                // nothing of the endpoint outlives the quit.
                commands::root_mcp::stop_for_exit();
                // Abort every terminal's process subtree so no inner process (a
                // dev server, a build, a training run) outlives Tabtivity. Runs
                // before the container teardown below, since a containerized
                // tab's in-container process is TERMed via its still-live
                // container. Dropping the registry alone would kill only the
                // shell leaders and orphan everything they spawned.
                _app.state::<RegistryState>().lock().unwrap().kill_all();
                // The local tmux servers those PTYs were clients of survive the
                // clients by design (that is what makes a crash resumable), so a
                // clean quit ends Tabtivity's own sessions explicitly. The window's
                // close handler already does this before `destroy()`; repeating
                // it here is what covers the exits that never run frontend code
                // — the dev launcher's Ctrl+C (SIGINT/SIGTERM → `app.exit`),
                // an `app.exit()` from the backend. Idempotent: a second pass
                // finds no server and returns.
                if let Err(e) = services::tmux_local::kill_app_sessions() {
                    eprintln!("tmux_local: quit reap: {e}");
                }
                // Stop the Ollama server *this run started* — the spawned
                // `ollama serve` (with the runner child holding the weights) or
                // the systemd unit that was inactive until Tabtivity asked for it.
                // A server that was already running, or one on another machine,
                // is deliberately left alone: Ollama is a machine service as
                // often as it is a Tabtivity detail.
                commands::ollama::shutdown_owned_server();
                // The fenced Copilot language servers (one per consented project).
                tauri::async_runtime::block_on(commands::copilot::stop_all_for_exit());
                // Let the machine sleep again if a talk was on: the presenter's
                // own unmount never runs on an exit the frontend didn't drive.
                // Idempotent, and non-blocking on every OS (Windows only drops
                // the parked thread's sender — no join inside the shutdown
                // budget).
                let _ = commands::presenter::presenter_release_sleep();
                // Tear down any OpenVPN tunnels brought up for VPN-gated
                // remote projects so no privileged tunnel outlives the app.
                // Best-effort: a tunnel the close-path already asked about and was
                // told to leave up (`declined_configs`) is skipped here rather than
                // re-prompted with no window left to hold the dialog.
                services::openvpn::disconnect_all();
                // Remove every project container this run created — container
                // lifetime is the project session, never longer than the app.
                services::sandbox::down_all();
                // Shut down every project VM this run booted — VM lifetime is
                // the app session, like the containers above (ACPI powerdown
                // via QMP, escalating to a kill after a short grace).
                services::vm::down_all();
                // Tear down pooled SSH/SFTP connections. This ends the `ssh`
                // *clients* Tabtivity spawned; the ControlMaster behind them is a
                // separate backgrounded process (`ssh: … [mux]`, reparented to
                // init) that `ControlPersist` keeps for its idle window whatever
                // we do here, so it is deliberately left with its socket intact
                // rather than orphaned socketless — the next launch's
                // `sweep_stale_control_sockets` finds it still answering, keeps
                // it, and the first reconnect rides it with no re-auth.
                // Stop every auto-sync task first (cancel loops + drop watchers)
                // so none races the pool teardown below.
                let auto = _app
                    .state::<services::sync_auto::AutoSyncState>()
                    .inner()
                    .clone();
                tauri::async_runtime::block_on(services::sync_auto::stop_all(&auto));
                // Stop every git-peer lockstep task (cancel poll loops + drop .git
                // watchers) before the pool teardown.
                let git_peer = _app
                    .state::<services::git_peer::GitPeerRegistry>()
                    .inner()
                    .clone();
                tauri::async_runtime::block_on(services::git_peer::stop_all(&git_peer));
                let pool = _app
                    .state::<services::remote::RemotePoolState>()
                    .inner()
                    .clone();
                tauri::async_runtime::block_on(services::remote::disconnect_all(&pool));
            }
        });
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// tauri-utils merges `tauri.macos.conf.json` over the base config with RFC
    /// 7396 merge-patch, which REPLACES arrays: a `windows` array there drops
    /// every key of the base window it does not repeat. `visible: false` is the
    /// one that matters — the window must stay hidden until
    /// `restore_main_window` has placed it.
    #[test]
    fn every_window_config_starts_hidden() {
        for (name, text) in [
            ("tauri.conf.json", include_str!("../tauri.conf.json")),
            ("tauri.macos.conf.json", include_str!("../tauri.macos.conf.json")),
        ] {
            let conf: serde_json::Value = serde_json::from_str(text).unwrap();
            let windows = conf["app"]["windows"].as_array().unwrap();
            assert!(!windows.is_empty(), "{name}");
            for w in windows {
                assert_eq!(w["visible"], serde_json::Value::Bool(false), "{name}: {w}");
            }
        }
    }

    #[test]
    fn macos_menu_never_offers_close_window_and_keeps_edit() {
        let plan = macos_menu_plan();
        let titles: Vec<&str> = plan.iter().map(|(t, _)| *t).collect();
        assert_eq!(titles, [crate::brand::DISPLAY, "Edit", "Window"]);
        // No item of any submenu is a window close (⌘W is the frontend's).
        for (_, items) in &plan {
            for item in items {
                assert!(!format!("{item:?}").contains("Close"), "{item:?}");
            }
        }
        // Edit carries the four ⌘-editing items xterm and inputs rely on.
        let edit = &plan[1].1;
        for needed in [MacMenuItem::Copy, MacMenuItem::Paste, MacMenuItem::Cut, MacMenuItem::SelectAll] {
            assert!(edit.contains(&needed), "{needed:?}");
        }
        // Exactly one Quit, in the app menu, and it is Tabtivity's own.
        let quits: usize = plan
            .iter()
            .map(|(_, items)| items.iter().filter(|i| **i == MacMenuItem::Quit).count())
            .sum();
        assert_eq!(quits, 1);
        assert_eq!(plan[0].1.last(), Some(&MacMenuItem::Quit));
        assert!(!MAC_MENU_QUIT_ID.is_empty());
        assert!(plan[2].1.contains(&MacMenuItem::Minimize));
        assert!(plan[2].1.contains(&MacMenuItem::Fullscreen));
    }

    #[test]
    fn renderer_reload_budget_allows_five() {
        assert!((0..MAX_RENDERER_RELOADS).all(renderer_reload_allowed));
        assert!(!renderer_reload_allowed(MAX_RENDERER_RELOADS));
        assert!(!renderer_reload_allowed(u32::MAX));
    }

    #[test]
    fn renderer_reload_budgets_are_per_window() {
        let mut counts = std::collections::BTreeMap::new();
        // A popout crash-looping spends only its own budget …
        for _ in 0..MAX_RENDERER_RELOADS {
            assert!(bump_renderer_reloads(&mut counts, "detached-p-g1"));
        }
        assert!(!bump_renderer_reloads(&mut counts, "detached-p-g1"));
        // … and the main window still gets all of its reloads.
        for _ in 0..MAX_RENDERER_RELOADS {
            assert!(bump_renderer_reloads(&mut counts, "main"));
        }
        assert!(!bump_renderer_reloads(&mut counts, "main"));
    }

    #[test]
    fn iso_now_uses_z_suffix() {
        let s = iso_now();
        assert!(s.ends_with('Z'), "crash-log timestamps end with Z: {s}");
        assert!(s.contains('T'));
    }

    fn crash_line(code: u32, addr: usize, cap: usize) -> (String, usize) {
        let mut buf = vec![0u8; cap];
        let len = format_crash_line(code, addr, &mut buf);
        (String::from_utf8(buf[..len].to_vec()).unwrap(), len)
    }

    #[test]
    fn crash_push_dec_pads_and_truncates() {
        let mut buf = [0u8; 16];
        let mut pos = crash_push_dec(&mut buf, 0, 7, 2);
        pos = crash_push_dec(&mut buf, pos, 2026, 4);
        pos = crash_push_dec(&mut buf, pos, 0, 1);
        assert_eq!(std::str::from_utf8(&buf[..pos]).unwrap(), "0720260");
        // The buffer bounds every write; u64::MAX has 20 digits.
        let mut small = [0u8; 6];
        assert_eq!(crash_push_dec(&mut small, 0, u64::MAX, 1), 6);
        assert_eq!(&small, b"184467");
    }

    #[test]
    fn format_signal_line_names_signal_code_and_address() {
        let mut buf = [0u8; 96];
        // SEGV_MAPERR at a null page: the shape of a plain null dereference.
        let len = format_signal_line(b"SIGSEGV", 1, 0x10, &mut buf);
        assert_eq!(
            std::str::from_utf8(&buf[..len]).unwrap(),
            "=== CRASH: SIGSEGV code=0x1 addr=0x10 ===\n"
        );
        // A `raise`d SIGABRT carries si_code SI_TKILL (-6): the cast keeps it a
        // fixed-width value rather than a sign-extended 16-digit one.
        let len = format_signal_line(b"SIGABRT", -6, 0, &mut buf);
        assert_eq!(
            std::str::from_utf8(&buf[..len]).unwrap(),
            "=== CRASH: SIGABRT code=0xFFFFFFFA addr=0x0 ===\n"
        );
        // Never overruns a short buffer.
        let mut small = [0u8; 8];
        let len = format_signal_line(b"SIGBUS", 2, usize::MAX, &mut small);
        assert_eq!(len, 8);
    }

    #[test]
    fn format_crash_line_access_violation() {
        // 0xC0000005 = STATUS_ACCESS_VIOLATION, the canonical native crash.
        let (s, _) = crash_line(0xC000_0005, 0x7FF6_1234_ABCD, 64);
        assert_eq!(s, "=== CRASH: code=0xC0000005 addr=0x7FF61234ABCD ===\n");
    }

    #[test]
    fn format_crash_line_pads_code_to_8_digits_and_addr_to_1() {
        let (s, _) = crash_line(0x5, 0x0, 64);
        assert_eq!(s, "=== CRASH: code=0x00000005 addr=0x0 ===\n");
    }

    #[test]
    fn format_crash_line_truncates_without_panicking() {
        for cap in 0..48 {
            let (s, len) = crash_line(0xC000_0005, usize::MAX, cap);
            assert!(len <= cap, "len {len} must fit cap {cap}");
            assert!("=== CRASH: code=0xC0000005 addr=0xFFFFFFFFFFFFFFFF ===\n".starts_with(&s));
        }
    }

    #[test]
    fn format_crash_line_max_values_fit_a_64_byte_buffer() {
        let (s, len) = crash_line(u32::MAX, usize::MAX, 64);
        assert!(len < 64, "worst case must fit the filter's stack buffer");
        assert_eq!(
            s,
            "=== CRASH: code=0xFFFFFFFF addr=0xFFFFFFFFFFFFFFFF ===\n"
        );
    }
}
