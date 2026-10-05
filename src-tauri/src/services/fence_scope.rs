//! Landlock's abstract-socket scope for the agent fence:
//! `tabtivity --fence-scope <bwrap> [args…]`.
//!
//! bubblewrap unshares only the pid namespace, so a fenced agent shares the
//! host's network namespace and with it every abstract Unix socket
//! (`@/tmp/.X11-unix/X0`, the systemd/D-Bus buses, IDE daemons). The private
//! `/tmp` and `/run` hide path-named sockets, not these. The X server is the
//! one that matters: only its cookie check stands behind it, and a host that
//! ran `xhost +local:` or `+si:localuser:$USER` (or an unauthenticated
//! `startx`) lets any fenced agent log keystrokes and type into unfenced
//! windows — the Tabtivity window and shell tabs included. Landlock's
//! `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET` (ABI 6, Linux 6.12) refuses every
//! connect to an abstract socket created outside the domain; sockets the
//! agent creates inside it keep working, and the network is untouched.
//!
//! No spawn path can run code between fork and exec (see
//! `agent_fence::seccomp_launcher`), so the Tabtivity binary itself is the step
//! before bwrap: it enters the domain and execs bwrap. Best-effort per host:
//! an older kernel, or a setuid bwrap (the domain needs `no_new_privs`, which
//! would strip it), launches without the step as before. Where the step is
//! used it fails closed. It also maps `agent_exec`'s carriers, so a host
//! with the scope runs one step in front of bwrap, not two.

use std::path::{Path, PathBuf};

const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1;
const CREATE_RULESET_VERSION: u32 = 1;
/// The first Landlock ABI with scopes.
const SCOPE_ABI: i64 = 6;

/// `struct landlock_ruleset_attr` up to ABI 6.
#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}

/// The running kernel's Landlock ABI; negative when Landlock is absent or off.
pub fn abi() -> i64 {
    // SAFETY: the version query takes no attribute pointer.
    unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<RulesetAttr>(),
            0usize,
            CREATE_RULESET_VERSION,
        ) as i64
    }
}

/// Enter a domain that scopes abstract Unix sockets, for this thread and all it
/// execs. Plain syscalls only, so it is also safe between fork and exec.
pub fn restrict_self() -> std::io::Result<()> {
    let attr = RulesetAttr {
        handled_access_fs: 0,
        handled_access_net: 0,
        scoped: SCOPE_ABSTRACT_UNIX_SOCKET,
    };
    // SAFETY: `attr` outlives the call; `fd` is ours and closed on every path.
    unsafe {
        let fd = libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0u32,
        );
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let fd = fd as libc::c_int;
        let result = if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            || libc::syscall(libc::SYS_landlock_restrict_self, fd, 0u32) != 0
        {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        };
        libc::close(fd);
        result
    }
}

/// The helper to run in front of `bwrap`, or `None` where this kernel or this
/// bwrap can't take the scope.
pub fn helper_for(bwrap: &Path) -> Option<String> {
    if abi() < SCOPE_ABI || is_setuid(bwrap) {
        return None;
    }
    Some(running_binary())
}

/// The running Tabtivity binary as a path another process can exec now — the
/// helper here and `agent_exec`'s.
pub fn running_binary() -> String {
    helper_path(std::env::current_exe().ok(), std::process::id())
}

fn is_setuid(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o4000 != 0)
}

/// The running binary by path, or by `/proc/<pid>/exe` once a rebuild or an
/// update has replaced it on disk (`current_exe` then ends in ` (deleted)`).
/// The helper is exec'd at once, by Tabtivity or its tmux server, while Tabtivity
/// still runs.
fn helper_path(exe: Option<PathBuf>, pid: u32) -> String {
    match exe {
        Some(exe) if exe.is_file() => exe.to_string_lossy().into_owned(),
        _ => format!("/proc/{pid}/exe"),
    }
}

/// `tabtivity --fence-scope <prog> [args…]`: enter the domain, then exec `prog`
/// with the environment `agent_exec` would give it (its carriers mapped), so
/// a spawn needs one step in front of bwrap, not two.
/// Returns only on failure, with the exit code.
pub fn run(args: &[std::ffi::OsString]) -> i32 {
    use std::os::unix::process::CommandExt;
    let Some((prog, rest)) = args.split_first() else {
        eprintln!(concat!("Agent sandbox: usage: ", crate::app_slug!(), " --fence-scope <program> [args…]"));
        return 2;
    };
    if let Err(e) = restrict_self() {
        eprintln!("Agent sandbox: abstract-socket scope: {e}");
        return 126;
    }
    let mut cmd = std::process::Command::new(prog);
    cmd.args(rest);
    crate::services::agent_exec::apply(&mut cmd);
    let e = cmd.exec();
    eprintln!("Agent sandbox: {}: {e}", Path::new(prog).display());
    127
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abstract_addr(name: &[u8]) -> (libc::sockaddr_un, libc::socklen_t) {
        // SAFETY: all-zero is a valid `sockaddr_un`.
        let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (i, b) in name.iter().enumerate() {
            addr.sun_path[i + 1] = *b as libc::c_char;
        }
        let len = std::mem::size_of::<libc::sa_family_t>() + 1 + name.len();
        (addr, len as libc::socklen_t)
    }

    /// A child enters the domain, then may not reach the parent's abstract
    /// socket but may reach one it created itself, and still execs.
    #[test]
    fn the_scope_refuses_outside_abstract_sockets_only() {
        use std::os::linux::net::SocketAddrExt;
        use std::os::unix::net::{SocketAddr, UnixListener};
        use std::os::unix::process::CommandExt;
        if abi() < SCOPE_ABI {
            eprintln!("skipped: Landlock ABI {} has no scopes", abi());
            return;
        }
        let outside = format!(concat!(crate::app_slug!(), "-fence-scope-out-{}"), std::process::id());
        let inside = format!(concat!(crate::app_slug!(), "-fence-scope-in-{}"), std::process::id());
        let _listener = UnixListener::bind_addr(&SocketAddr::from_abstract_name(&outside).unwrap()).unwrap();
        let (out_addr, out_len) = abstract_addr(outside.as_bytes());
        let (in_addr, in_len) = abstract_addr(inside.as_bytes());
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", "exit 7"]);
        // SAFETY: only syscalls between fork and exec; addresses built before.
        unsafe {
            cmd.pre_exec(move || {
                restrict_self()?;
                let connect = |addr: &libc::sockaddr_un, len| {
                    let s = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
                    let r = libc::connect(s, addr as *const _ as *const libc::sockaddr, len);
                    let errno = std::io::Error::last_os_error().raw_os_error();
                    libc::close(s);
                    (r, errno)
                };
                if connect(&out_addr, out_len) != (-1, Some(libc::EPERM)) {
                    return Err(std::io::Error::from_raw_os_error(libc::EBADMSG));
                }
                let l = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
                if libc::bind(l, &in_addr as *const _ as *const libc::sockaddr, in_len) != 0
                    || libc::listen(l, 1) != 0
                    || connect(&in_addr, in_len).0 != 0
                {
                    return Err(std::io::Error::from_raw_os_error(libc::EPROTO));
                }
                libc::close(l);
                Ok(())
            });
        }
        let status = cmd.status().expect("the scoped child was refused outside, reached inside and exec'd");
        assert_eq!(status.code(), Some(7));
    }

    #[test]
    fn the_helper_is_the_running_binary_even_once_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(crate::app_slug!());
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(helper_path(Some(exe.clone()), 42), exe.to_string_lossy());
        let gone = PathBuf::from(format!("{} (deleted)", exe.display()));
        assert_eq!(helper_path(Some(gone), 42), "/proc/42/exe");
        assert_eq!(helper_path(None, 42), "/proc/42/exe");
    }

    #[test]
    fn a_setuid_bwrap_gets_no_helper() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bwrap = dir.path().join("bwrap");
        std::fs::write(&bwrap, b"").unwrap();
        std::fs::set_permissions(&bwrap, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!is_setuid(&bwrap));
        std::fs::set_permissions(&bwrap, std::fs::Permissions::from_mode(0o4755)).unwrap();
        assert!(is_setuid(&bwrap));
        assert!(helper_for(&bwrap).is_none());
    }
}
