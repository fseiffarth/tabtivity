//! Starting a program in a pty without forking the app.
//!
//! `portable-pty` spawns with a `pre_exec` hook (reset signals, `setsid`,
//! `TIOCSCTTY`, close fds), and a `pre_exec` makes the standard library
//! `fork` instead of `posix_spawn`. A `fork` of this process — gigabytes
//! resident, hundreds of threads — copies its page tables under the address
//! space lock, and every other thread, the window's included, waits on that
//! lock for its next page fault: each tab opened froze the app for a second
//! or more (`paths::command_on_path` has the numbers).
//!
//! Linux: the program is started by util-linux `setsid --ctty`, from the
//! root-owned system directories (`paths::spawn_wrapper`), with the
//! pty's slave as stdin/stdout/stderr. `setsid` becomes a session leader,
//! makes stdin the controlling terminal and `exec`s the program in the same
//! process, so the child is what the hook produced — a session and process
//! group of its own with the pty as its terminal — and its pid is the one
//! `Child` and the subtree reaper know. Everything else is `posix_spawn`.
//! Elsewhere, and on a Linux without that `setsid`, the slave spawns it as
//! before.
//!
//! What the hook did that this does not: reset signal dispositions (the
//! app ignores none, `std` puts `SIGPIPE` back itself, and an `exec` resets
//! every handler), and close every inherited fd above 2. The second is a
//! real difference: it relies on every fd the app opens being close-on-exec,
//! as the hundreds of other spawns in the app already do (see
//! `docs/context/agent_authority.md`, inherited descriptors).
//! `CommandBuilder` is read through its public getters because its
//! `as_command` is private; [`linux::resolve_program`] and the environment
//! copy follow it.

use portable_pty::{Child, CommandBuilder, MasterPty, SlavePty};

/// Run `builder` in the pty `master`/`slave` belong to, as a session leader
/// with that pty as its controlling terminal.
pub(crate) fn spawn_in_pty(
    master: &dyn MasterPty,
    slave: &dyn SlavePty,
    builder: CommandBuilder,
) -> Result<Box<dyn Child + Send + Sync>, String> {
    #[cfg(target_os = "linux")]
    if let (Some(setsid), Some(tty), true) = (linux::setsid(), master.tty_name(), linux::eligible(&builder)) {
        return linux::spawn(setsid, &tty, &builder);
    }
    let _ = master;
    slave.spawn_command(builder).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
mod linux {
    use portable_pty::{Child, CommandBuilder};
    use std::ffi::{CString, OsStr, OsString};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::{Component, Path, PathBuf};
    use std::process::{Command, Stdio};

    /// The system's `setsid`, once. `None` without a root-owned one.
    pub(super) fn setsid() -> Option<&'static Path> {
        static SETSID: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
        SETSID.get_or_init(|| crate::paths::spawn_wrapper("setsid")).as_deref()
    }

    /// What `setsid` can stand in for: a program named by `args[0]`, the
    /// pty as controlling terminal. The login-shell default program (a
    /// different `argv[0]`) and a pty that is not to be the terminal go the
    /// old way; nothing in the app asks for either.
    pub(super) fn eligible(builder: &CommandBuilder) -> bool {
        !builder.is_default_prog() && builder.get_controlling_tty()
    }

    pub(super) fn spawn(
        setsid: &Path,
        tty: &Path,
        builder: &CommandBuilder,
    ) -> Result<Box<dyn Child + Send + Sync>, String> {
        let home = home_dir(builder);
        let dir = builder
            .get_cwd()
            .map(PathBuf::from)
            .filter(|dir| dir.is_dir())
            .unwrap_or_else(|| PathBuf::from(&home));
        let argv = builder.get_argv();
        let program = resolve_program(&argv[0], &dir, builder.get_env("PATH"))?;

        // Not the controlling terminal yet: `setsid` makes it one after it
        // leads a session of its own. `O_NOCTTY` keeps this open from
        // claiming it for the app, which has none.
        let slave = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOCTTY)
            .open(tty)
            .map_err(|e| format!("open {}: {e}", tty.display()))?;
        let clone = |file: &std::fs::File| file.try_clone().map_err(|e| format!("dup {}: {e}", tty.display()));

        let mut command = Command::new(setsid);
        command.arg("-c").arg("--").arg(&program).args(&argv[1..]);
        command.current_dir(&dir);
        command.env_clear();
        command.env("SHELL", builder.get_shell());
        command.envs(environment(builder));
        command.stdin(Stdio::from(clone(&slave)?)).stdout(Stdio::from(clone(&slave)?)).stderr(Stdio::from(slave));
        let mut child = command.spawn().map_err(|e| format!("{e}"))?;
        // The slave ends the std `Child` keeps: none, but be explicit.
        child.stdin.take();
        child.stdout.take();
        child.stderr.take();
        Ok(Box::new(child))
    }

    /// The child's whole environment: `portable-pty` hands over only what is
    /// valid UTF-8, so a variable of this process's that is not stays as the
    /// builder left it (unchanged, or gone).
    fn environment(builder: &CommandBuilder) -> Vec<(OsString, OsString)> {
        let mut env: Vec<(OsString, OsString)> =
            builder.iter_full_env_as_str().map(|(k, v)| (k.into(), v.into())).collect();
        for (key, value) in std::env::vars_os() {
            if (key.to_str().is_none() || value.to_str().is_none()) && builder.get_env(&key) == Some(value.as_os_str()) {
                env.push((key, value));
            }
        }
        env
    }

    fn home_dir(builder: &CommandBuilder) -> String {
        if let Some(home) = builder.get_env("HOME").and_then(OsStr::to_str) {
            return home.to_string();
        }
        // SAFETY: `getpwuid` returns null or a pointer to a static entry
        // read before any other call here.
        let entry = unsafe { libc::getpwuid(libc::getuid()) };
        if entry.is_null() {
            return "/".to_string();
        }
        // SAFETY: non-null `pw_dir` of a live entry is a NUL-terminated string.
        let dir = unsafe { std::ffi::CStr::from_ptr((*entry).pw_dir) };
        dir.to_str().map(str::to_owned).unwrap_or_else(|_| "/".to_string())
    }

    fn executable(path: &Path) -> bool {
        CString::new(path.as_os_str().as_bytes())
            // SAFETY: a valid NUL-terminated path.
            .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::X_OK) } == 0)
    }

    fn exists(path: &Path) -> bool {
        CString::new(path.as_os_str().as_bytes())
            // SAFETY: a valid NUL-terminated path.
            .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::F_OK) } == 0)
    }

    /// The file `exe` names, found the way `portable-pty` finds it: an
    /// absolute path as it is; `./x` and `../x` from `cwd`; a bare name
    /// along `path`, each entry taken from `cwd` when relative. A miss says
    /// why, so the tab shows more than "could not start".
    pub(super) fn resolve_program(exe: &OsStr, cwd: &Path, path: Option<&OsStr>) -> Result<OsString, String> {
        let exe_path = Path::new(exe);
        if exe_path.is_relative() {
            if matches!(exe_path.components().next(), Some(Component::CurDir | Component::ParentDir)) {
                let abs = cwd.join(exe_path);
                if abs.is_dir() {
                    return Err(format!("Unable to spawn {} because it is a directory", abs.display()));
                } else if executable(&abs) {
                    return Ok(abs.into_os_string());
                } else if exists(&abs) {
                    return Err(format!("Unable to spawn {} because it is not executable", abs.display()));
                }
                return Err(format!("Unable to spawn {} because it does not exist", abs.display()));
            }
            let mut errors = Vec::new();
            if let Some(path) = path {
                for entry in std::env::split_paths(path) {
                    let candidate = cwd.join(&entry).join(exe);
                    if candidate.is_dir() {
                        errors.push(format!("{} exists but is a directory", candidate.display()));
                    } else if executable(&candidate) {
                        return Ok(candidate.into_os_string());
                    } else if exists(&candidate) {
                        errors.push(format!("{} exists but is not executable", candidate.display()));
                    }
                }
                errors.push(format!("No viable candidates found in PATH {path:?}"));
            } else {
                errors.push("Unable to resolve the PATH".to_string());
            }
            return Err(format!("Unable to spawn {} because:\n{}", exe_path.display(), errors.join(".\n")));
        }
        if exe_path.is_dir() {
            return Err(format!("Unable to spawn {} because it is a directory", exe_path.display()));
        }
        if executable(exe_path) {
            Ok(exe.to_owned())
        } else if exists(exe_path) {
            Err(format!("Unable to spawn {} because it is not executable", exe_path.display()))
        } else {
            Err(format!("Unable to spawn {} because it doesn't exist on the filesystem", exe_path.display()))
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, PtySize};
    use std::ffi::OsStr;
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    struct Session {
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send + Sync>,
        output: std::sync::mpsc::Receiver<Vec<u8>>,
        seen: Vec<u8>,
        tty: std::path::PathBuf,
    }

    impl Session {
        /// `sh -c script` in a fresh 24x80 pty, started through `spawn`.
        fn start(script: &str, spawn: impl FnOnce(&dyn MasterPty, &dyn SlavePty, CommandBuilder) -> Box<dyn Child + Send + Sync>) -> Self {
            let pair = native_pty_system()
                .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                .expect("openpty");
            let mut builder = CommandBuilder::new("sh");
            builder.args(["-c", script]);
            builder.cwd("/");
            let tty = pair.master.tty_name().expect("tty name");
            let child = spawn(&*pair.master, &*pair.slave, builder);
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().expect("reader");
            let (tx, output) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n @ 1..) = reader.read(&mut buf) {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            });
            Self { master: pair.master, child, output, seen: Vec::new(), tty }
        }

        fn through_setsid(script: &str) -> Self {
            assert!(linux::setsid().is_some(), "no setsid: these tests would only exercise the fallback");
            Self::start(script, |master, slave, builder| spawn_in_pty(master, slave, builder).expect("spawn"))
        }

        fn through_portable_pty(script: &str) -> Self {
            Self::start(script, |_, slave, builder| slave.spawn_command(builder).expect("spawn"))
        }

        /// Everything printed so far, once it contains `needle` (or panics).
        fn wait_for(&mut self, needle: &str) -> String {
            let until = Instant::now() + Duration::from_secs(20);
            loop {
                let text = String::from_utf8_lossy(&self.seen).into_owned();
                if text.contains(needle) {
                    return text;
                }
                assert!(Instant::now() < until, "no {needle:?} in {text:?}");
                if let Ok(chunk) = self.output.recv_timeout(Duration::from_millis(50)) {
                    self.seen.extend(chunk);
                }
            }
        }

        fn wait_exit(&mut self) -> portable_pty::ExitStatus {
            let until = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(status) = self.child.try_wait().unwrap() {
                    return status;
                }
                assert!(Instant::now() < until, "the child did not exit; output {:?}", String::from_utf8_lossy(&self.seen));
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// The word after the last `key=` in `text`.
    fn field(text: &str, key: &str) -> String {
        let at = text.rfind(&format!("{key}=")).unwrap_or_else(|| panic!("no {key} in {text:?}"));
        text[at + key.len() + 1..].split(['\r', '\n', ' ']).next().unwrap().to_string()
    }

    /// The same report the child prints about itself, with the end marker.
    const REPORT: &str = r#"set -- $(cat /proc/$$/stat | sed 's/^[0-9]* ([^)]*) //'); \
        echo "pid=$$ pgrp=$3 sid=$4 tty=$5 tpgid=$6 name=$(tty) end=1""#;

    /// Not on the thread that would be fooled by a test's own session: the
    /// child is a session leader and process group leader of its own, its
    /// terminal is this pty, and it is the pty's foreground group.
    #[test]
    fn the_child_leads_a_session_with_the_pty_as_its_terminal() {
        let mut session = Session::through_setsid(REPORT);
        let text = session.wait_for("end=1");
        let (pid, pgrp, sid, tpgid) = (field(&text, "pid"), field(&text, "pgrp"), field(&text, "sid"), field(&text, "tpgid"));
        assert_eq!(pid, sid, "a session leader: {text}");
        assert_eq!(pid, pgrp, "a process group leader: {text}");
        assert_eq!(pid, tpgid, "the foreground group: {text}");
        assert_eq!(field(&text, "name").split(' ').next().unwrap(), session.tty.to_str().unwrap(), "{text}");
        assert_ne!(field(&text, "tty"), "0", "{text}");
        assert_eq!(session.child.process_id().map(|p| p.to_string()), Some(pid), "the pid the app tracks leads it");
    }

    /// Job control needs the controlling terminal: Ctrl+C reaches the
    /// foreground program as `SIGINT`.
    #[test]
    fn ctrl_c_on_the_master_interrupts_the_foreground_program() {
        let mut session = Session::through_setsid("echo ready; exec sleep 60");
        session.wait_for("ready");
        std::thread::sleep(Duration::from_millis(100));
        session.master.take_writer().unwrap().write_all(&[3]).unwrap();
        let status = session.wait_exit();
        assert!(!status.success(), "{status:?}");
        assert_eq!(status.signal(), Some("Interrupt"), "{status:?}");
    }

    /// A resize reaches the program as `SIGWINCH` (a missing controlling
    /// terminal would not deliver it).
    #[test]
    fn a_resize_delivers_sigwinch() {
        let mut session = Session::through_setsid(
            r#"trap 'echo winch=$(stty size)' WINCH; echo ready; while :; do sleep 0.05; done"#,
        );
        session.wait_for("ready");
        session.master.resize(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 }).unwrap();
        session.wait_for("winch=30 100");
    }

    /// What the old hook set up, compared to what it still gets: no ignored
    /// or blocked signal, and the same open files as through `portable-pty`
    /// (`/dev/pts/N` three times, nothing of the master).
    #[test]
    fn signals_and_open_files_match_the_portable_pty_spawn() {
        let script = r#"echo "sig=$(grep -E '^(SigIgn|SigBlk)' /proc/$$/status | tr -d '\t ' | tr '\n' ',')" "fds=$(ls /proc/$$/fd | tr '\n' ',') end=1""#;
        // An fd the test process got already open and inheritable from
        // whatever started it (CI's runner hands down two) reaches every
        // `posix_spawn` of it, not just this one; the app opens none such.
        // `portable-pty` closes those too, so they are left out here.
        // Taken before either spawn, so nothing of theirs is left out.
        let outside = inheritable_fds();
        let mut old = Session::through_portable_pty(script);
        let old_text = old.wait_for("end=1");
        let mut new = Session::through_setsid(script);
        let new_text = new.wait_for("end=1");
        let own = |text: &str| -> String {
            field(text, "fds").split(',').filter(|fd| !fd.is_empty() && !outside.iter().any(|out| out == fd)).map(|fd| format!("{fd},")).collect()
        };
        assert_eq!(field(&new_text, "sig"), field(&old_text, "sig"), "{new_text} vs {old_text}");
        assert_eq!(own(&new_text), own(&old_text), "{new_text} vs {old_text} (left out: {outside:?})");
    }

    /// This process's fds above 2 without close-on-exec.
    fn inheritable_fds() -> Vec<String> {
        std::fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<i32>().ok())
            .filter(|&fd| fd > 2 && unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC == 0)
            .map(|fd| fd.to_string())
            .collect()
    }

    /// The environment is the builder's alone, a relative directory that is
    /// not one falls back to home, and arguments arrive unchanged.
    #[test]
    fn environment_directory_and_arguments_arrive_as_built() {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let home = tempfile::tempdir().unwrap();
        let mut builder = CommandBuilder::new("sh");
        builder.args(["-c", r#"echo "cwd=$(pwd) a=$A gone=${GONE-unset} arg=$1 end=1""#, "sh", "two words"]);
        builder.cwd("/does/not/exist");
        builder.env("HOME", home.path());
        builder.env("A", "kept");
        builder.env_remove("GONE");
        let mut child = spawn_in_pty(&*pair.master, &*pair.slave, builder).unwrap();
        drop(pair.slave);
        let mut text = String::new();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        let mut buf = [0u8; 1024];
        while !text.contains("end=1") && Instant::now() < until {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => text.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
        }
        let _ = child.wait();
        let home = std::fs::canonicalize(home.path()).unwrap();
        assert!(text.contains(&format!("cwd={} a=kept gone=unset arg=two words", home.display())), "{text}");
    }

    /// A program that is not there is refused at the spawn, not as noise in
    /// the tab.
    #[test]
    fn a_missing_program_is_refused_at_the_spawn() {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let error = spawn_in_pty(&*pair.master, &*pair.slave, CommandBuilder::new("/no/such/program")).expect_err("refused");
        assert!(error.contains("doesn't exist"), "{error}");
        let mut named = CommandBuilder::new("no-such-program-anywhere");
        named.env("PATH", "/usr/bin");
        let error = spawn_in_pty(&*pair.master, &*pair.slave, named).expect_err("refused");
        assert!(error.contains("No viable candidates"), "{error}");
    }

    /// `resolve_program` follows `portable-pty`: first executable on the
    /// path, relative entries from the working directory, `./x` from there.
    #[test]
    fn programs_resolve_as_portable_pty_resolves_them() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path();
        std::fs::create_dir(cwd.join("plain")).unwrap();
        std::fs::create_dir(cwd.join("bin")).unwrap();
        std::fs::write(cwd.join("plain").join("tool"), "").unwrap();
        std::fs::write(cwd.join("bin").join("tool"), "").unwrap();
        std::fs::set_permissions(cwd.join("bin").join("tool"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths(["plain", "bin"]).unwrap();
        let found = linux::resolve_program(OsStr::new("tool"), cwd, Some(&path)).unwrap();
        assert_eq!(std::path::Path::new(&found), cwd.join("bin").join("tool"));
        assert!(linux::resolve_program(OsStr::new("tool"), cwd, None).is_err());
        let found = linux::resolve_program(OsStr::new("./bin/tool"), cwd, None).unwrap();
        assert_eq!(std::path::Path::new(&found), cwd.join("bin").join("tool"));
        assert!(linux::resolve_program(OsStr::new("./plain/tool"), cwd, None).unwrap_err().contains("not executable"));
        assert!(linux::resolve_program(OsStr::new("./bin"), cwd, None).unwrap_err().contains("directory"));
    }
}
