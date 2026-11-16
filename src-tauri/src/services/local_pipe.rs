//! Same-user local IPC over a Windows named pipe: the admin control pipe
//! (`mobile_control::admin`), the desktop bridge and the session host
//! (`session_host::win::pipe`) all ride it.
//!
//! Three layers keep a pipe to its owner:
//! - The pipe is created with an explicit protected DACL
//!   ([`protected_pipe_sddl`]): the user and SYSTEM only, network logons
//!   denied, nothing inherited; remote clients are rejected outright. No
//!   AppContainer or restricted SID is granted, so a future sandboxed agent
//!   fails closed.
//! - Each side checks the other's process user: the server the client's
//!   (`GetNamedPipeClientProcessId`), the client the server's
//!   (`GetNamedPipeServerProcessId`). A pipe squatted by another user, or an
//!   AppContainer peer, is refused.
//! - A random token the listener writes owner-only into the state dir is the
//!   peer's credential, compared in constant time ([`token_matches`]).
//!
//! The naming, token and SDDL helpers are pure and build everywhere; the pipe
//! calls are Windows-only.

use std::path::{Path, PathBuf};

/// Stable per-path pipe name under `prefix`, so two state dirs never collide.
pub fn pipe_name_with(prefix: &str, key: &Path) -> String {
    format!(r"\\.\pipe\{prefix}{}", path_hash(key))
}

/// The 32-hex-digit hash a pipe or mutex name derives from `key`.
pub fn path_hash(key: &Path) -> String {
    crate::digest::sha256_hex(key.to_string_lossy().as_bytes())[..32].to_string()
}

/// The 32-hex-digit hash of an arbitrary key string.
pub fn key_hash(key: &str) -> String {
    crate::digest::sha256_hex(key.as_bytes())[..32].to_string()
}

/// A path spelled one way however it was reached: the verbatim prefix
/// (`\\?\`, `\\?\UNC\`) dropped, `/` as `\`, trailing separators trimmed,
/// case folded (Windows paths are case-insensitive). Pure; see
/// [`normalized_path_key`] for the canonicalising half.
pub fn normalize_path_text(path: &str) -> String {
    let mut s = path.replace('/', "\\");
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        s = format!(r"\\{rest}");
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = rest.to_string();
    }
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s.to_lowercase()
}

/// [`normalize_path_text`] of `path` resolved as far as the filesystem allows:
/// the key a single-instance name hashes, so `C:\State`, `c:\state\` and a
/// junction to it agree. The deepest part that exists is canonicalised and
/// the rest joined on, so a path hashes the same before it is created as
/// after: the host makes its state dir and then names its pipe, while a
/// client may name the pipe first. Canonicalising only a path that exists
/// gave the two different names under a linked parent (a CI runner's 8.3
/// `RUNNER~1` temp dir), and the client waited on a pipe nobody served.
pub fn normalized_path_key(path: &Path) -> String {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut missing = Vec::new();
    let mut existing = absolute.as_path();
    let resolved = loop {
        if let Ok(real) = std::fs::canonicalize(existing) {
            break missing.iter().rev().fold(real, |path, part| path.join(part));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name);
                existing = parent;
            }
            _ => break absolute.clone(),
        }
    };
    normalize_path_text(&resolved.to_string_lossy())
}

/// The token file beside a nominal socket path.
pub fn token_path(socket: &Path) -> PathBuf {
    socket.with_extension("token")
}

/// Mints a fresh token and writes it owner-only at `path`.
pub fn create_token_at(path: &Path) -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("no system randomness: {e}"))?;
    let token = crate::digest::hex(&bytes);
    crate::storage::write_private_atomic(path, token.as_bytes()).map_err(|e| format!("write control token: {e}"))?;
    Ok(token)
}

pub fn read_token_at(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path)
        .map(|token| token.trim().to_string())
        .map_err(|e| format!("read control token: {e}"))
}

/// Mint and persist the listener-side token beside `socket`.
pub fn create_token(socket: &Path) -> Result<String, String> {
    create_token_at(&token_path(socket))
}

pub fn read_token(socket: &Path) -> Result<String, String> {
    read_token_at(&token_path(socket))
}

pub fn token_matches(presented: &str, expected: &str) -> bool {
    use subtle::ConstantTimeEq;
    !expected.is_empty() && bool::from(presented.as_bytes().ct_eq(expected.as_bytes()))
}

/// The pipe's DACL: protected (`P`, nothing inherited), network logons denied
/// first (an access check stops at the first ACE that grants, so a deny after
/// the user's allow would never apply), then all access for `user_sid` and
/// SYSTEM.
pub fn protected_pipe_sddl(user_sid: &str) -> String {
    format!("D:P(D;;GA;;;NU)(A;;GA;;;{user_sid})(A;;GA;;;SY)")
}

#[cfg(windows)]
pub use win::*;
/// The DACL read-back helpers, for the session host's tests.
#[cfg(all(test, windows))]
pub(crate) use win::tests as test_support;

#[cfg(windows)]
mod win {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use std::time::Duration;

    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions};
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenElevation, TokenIntegrityLevel,
        TokenIsAppContainer, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_ELEVATION,
        TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::protected_pipe_sddl;

    /// `ERROR_PIPE_BUSY`: every instance is taken.
    pub const ERROR_PIPE_BUSY: i32 = 231;
    /// How long a client rides out a busy pipe.
    const BUSY_WAIT: Duration = Duration::from_secs(2);

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the handle was opened by this module and is closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// Who a process runs as.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ProcessUser {
        pub sid: String,
        pub app_container: bool,
        /// An elevated (UAC "run as administrator") token.
        pub elevated: bool,
        /// The mandatory integrity level's RID (`0x2000` medium, `0x3000` high).
        pub integrity: u32,
    }

    /// One fixed-size `GetTokenInformation` class into a `u64`-aligned buffer.
    ///
    /// # Safety
    /// `token` must be a token handle open for `TOKEN_QUERY`.
    unsafe fn token_info(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> io::Result<Vec<u64>> {
        // SAFETY: the buffer is sized by the first call and written by the
        // second within that size.
        unsafe {
            let mut needed = 0u32;
            let _ = GetTokenInformation(token, class, None, 0, &mut needed);
            if needed == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
            GetTokenInformation(token, class, Some(buf.as_mut_ptr().cast()), needed, &mut needed)?;
            Ok(buf)
        }
    }

    /// The user SID (spelled `S-1-5-…`), AppContainer flag, elevation and
    /// integrity level of a token.
    fn token_user(token: HANDLE) -> io::Result<ProcessUser> {
        // SAFETY: the TokenUser buffer is sized by the first call and
        // u64-aligned; the SID inside it is read only while it lives; the
        // string ConvertSidToStringSidW allocates is freed with LocalFree.
        unsafe {
            let mut needed = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
            if needed == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
            GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), needed, &mut needed)?;
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut text = PWSTR::null();
            ConvertSidToStringSidW(user.User.Sid, &mut text)?;
            let sid = text.to_string();
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
            let sid = sid.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "SID is not UTF-16"))?;
            let mut is_app_container = 0u32;
            let mut len = 0u32;
            GetTokenInformation(
                token,
                TokenIsAppContainer,
                Some((&mut is_app_container as *mut u32).cast()),
                4,
                &mut len,
            )?;
            let elevation = token_info(token, TokenElevation)?;
            let elevated = (*(elevation.as_ptr() as *const TOKEN_ELEVATION)).TokenIsElevated != 0;
            let label = token_info(token, TokenIntegrityLevel)?;
            let label_sid = (*(label.as_ptr() as *const TOKEN_MANDATORY_LABEL)).Label.Sid;
            let count = *GetSidSubAuthorityCount(label_sid);
            if count == 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "integrity label without a RID"));
            }
            let integrity = *GetSidSubAuthority(label_sid, u32::from(count) - 1);
            Ok(ProcessUser { sid, app_container: is_app_container != 0, elevated, integrity })
        }
    }

    fn process_handle_user(process: HANDLE) -> io::Result<ProcessUser> {
        // SAFETY: the token handle is opened here and closed by its guard.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(process, TOKEN_QUERY, &mut token)?;
            let token = OwnedHandle(token);
            token_user(token.0)
        }
    }

    /// Who process `pid` runs as.
    pub fn process_user(pid: u32) -> io::Result<ProcessUser> {
        // SAFETY: the process handle is opened here and closed by its guard.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)? };
        let process = OwnedHandle(process);
        process_handle_user(process.0)
    }

    /// Who this process runs as, read once.
    pub fn current_user() -> io::Result<ProcessUser> {
        static ME: OnceLock<Result<ProcessUser, String>> = OnceLock::new();
        ME.get_or_init(|| {
            // SAFETY: GetCurrentProcess is a pseudo-handle; nothing to close.
            process_handle_user(unsafe { GetCurrentProcess() }).map_err(|e| e.to_string())
        })
        .clone()
        .map_err(io::Error::other)
    }

    /// This process's user SID.
    pub fn current_user_sid() -> io::Result<String> {
        current_user().map(|u| u.sid)
    }

    /// Whether this process runs elevated (a failed read counts as not).
    pub fn current_elevated() -> bool {
        current_user().is_ok_and(|u| u.elevated)
    }

    /// Whether a peer running as `peer` may talk to `me`: the same user
    /// SID, neither in an AppContainer, and the same elevation and integrity
    /// level — a medium-integrity process never reaches an elevated one, nor
    /// the reverse.
    pub fn peer_matches(me: &ProcessUser, peer: &ProcessUser) -> bool {
        !me.app_container
            && !peer.app_container
            && me.sid == peer.sid
            && me.elevated == peer.elevated
            && me.integrity == peer.integrity
    }

    fn is_same_user(user: &ProcessUser) -> bool {
        current_user().is_ok_and(|me| peer_matches(&me, user))
    }

    /// A security descriptor parsed from SDDL, freed on drop.
    pub struct PipeSecurity {
        sd: PSECURITY_DESCRIPTOR,
        attrs: SECURITY_ATTRIBUTES,
    }

    impl PipeSecurity {
        pub fn from_sddl(sddl: &str) -> io::Result<Self> {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            // SAFETY: the out pointer is a local; the descriptor it receives
            // is LocalAlloc'd and freed in Drop.
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(sddl), SDDL_REVISION_1, &mut sd, None)?;
            }
            let attrs = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd.0,
                bInheritHandle: false.into(),
            };
            Ok(Self { sd, attrs })
        }

        /// [`protected_pipe_sddl`] for this process's user.
        pub fn for_current_user() -> io::Result<Self> {
            Self::from_sddl(&protected_pipe_sddl(&current_user_sid()?))
        }

        /// The `SECURITY_ATTRIBUTES` (not inheritable) pointing at the
        /// descriptor; valid while `self` lives.
        pub fn attributes(&self) -> *const SECURITY_ATTRIBUTES {
            &self.attrs
        }
    }

    impl Drop for PipeSecurity {
        fn drop(&mut self) {
            // SAFETY: `sd` came from ConvertStringSecurityDescriptor…, which
            // allocates with LocalAlloc; freed once.
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.sd.0)));
            }
        }
    }

    /// A pipe server instance with the protected DACL that rejects remote
    /// clients. `first` refuses to create it when the name already exists
    /// (`first_pipe_instance`). Call inside a tokio runtime.
    pub fn create_server(name: &str, first: bool) -> io::Result<NamedPipeServer> {
        let mut security = PipeSecurity::for_current_user()?;
        let mut opts = ServerOptions::new();
        opts.first_pipe_instance(first).reject_remote_clients(true);
        // SAFETY: the attributes and the descriptor they point at outlive the
        // call; CreateNamedPipeW copies the descriptor into the object.
        unsafe { opts.create_with_security_attributes_raw(name, (&mut security.attrs as *mut SECURITY_ATTRIBUTES).cast()) }
    }

    /// Whether the client connected to `server` runs as this user.
    pub fn client_is_same_user(server: &NamedPipeServer) -> bool {
        let mut pid = 0u32;
        // SAFETY: the raw handle belongs to `server`, alive for the call.
        let ok = unsafe { GetNamedPipeClientProcessId(HANDLE(server.as_raw_handle()), &mut pid).is_ok() };
        ok && process_user(pid).is_ok_and(|u| is_same_user(&u))
    }

    /// Whether the server behind `client` runs as this user.
    pub fn server_is_same_user(client: &NamedPipeClient) -> bool {
        let mut pid = 0u32;
        // SAFETY: the raw handle belongs to `client`, alive for the call.
        let ok = unsafe { GetNamedPipeServerProcessId(HANDLE(client.as_raw_handle()), &mut pid).is_ok() };
        ok && process_user(pid).is_ok_and(|u| is_same_user(&u))
    }

    /// Waits for the next client on `server`, re-creates the listening
    /// instance and returns the connected one. A client of another user is
    /// dropped unanswered and the wait goes on. Errors are the caller's to
    /// retry: `server` is left listening, never holding a connected client
    /// (whose `connect()` would answer at once, forever).
    pub async fn accept(server: &mut NamedPipeServer, name: &str) -> io::Result<NamedPipeServer> {
        loop {
            server.connect().await?;
            let next = match create_server(name, false) {
                Ok(next) => next,
                Err(e) => {
                    // Drop the stale client; if the instance cannot go back
                    // to listening, replace it with a fresh one.
                    if server.disconnect().is_err() {
                        if let Ok(fresh) = create_server(name, false) {
                            *server = fresh;
                        }
                    }
                    return Err(e);
                }
            };
            let stream = std::mem::replace(server, next);
            if client_is_same_user(&stream) {
                return Ok(stream);
            }
        }
    }

    /// Opens `name` once, riding out a busy pipe (the listener re-creates its
    /// instance right after each accept). Any other failure, above all "no
    /// such pipe" (`NotFound`), is the answer, not a wait. A server of
    /// another user is `PermissionDenied`.
    pub async fn open_client(name: &str) -> io::Result<NamedPipeClient> {
        let deadline = tokio::time::Instant::now() + BUSY_WAIT;
        loop {
            match ClientOptions::new().open(name) {
                Ok(client) => {
                    if !server_is_same_user(&client) {
                        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the pipe's server is another user"));
                    }
                    return Ok(client);
                }
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }

    #[cfg(test)]
    pub(crate) mod tests {
        use super::*;
        use windows::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT,
        };
        use windows::Win32::Security::DACL_SECURITY_INFORMATION;

        pub(crate) fn unique_pipe(tag: &str) -> String {
            let mut bytes = [0u8; 8];
            getrandom::fill(&mut bytes).unwrap();
            format!(r"\\.\pipe\local-pipe-test-{tag}-{}", crate::digest::hex(&bytes))
        }

        /// The DACL of a pipe handle, read back as SDDL.
        pub(crate) fn dacl_sddl(handle: HANDLE) -> String {
            // SAFETY: GetSecurityInfo allocates the descriptor (LocalFree'd
            // below); the string the conversion allocates is freed too.
            unsafe {
                let mut sd = PSECURITY_DESCRIPTOR::default();
                let err = GetSecurityInfo(
                    handle,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    None,
                    None,
                    Some(&mut sd),
                );
                assert_eq!(err.0, 0, "GetSecurityInfo");
                let mut text = PWSTR::null();
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    sd,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    None,
                )
                .unwrap();
                let out = text.to_string().unwrap();
                let _ = LocalFree(Some(HLOCAL(text.0.cast())));
                let _ = LocalFree(Some(HLOCAL(sd.0)));
                out
            }
        }

        /// The ACEs of an SDDL DACL, `(type, rights, sid)`.
        pub(crate) fn aces(sddl: &str) -> Vec<(String, String, String)> {
            sddl.split('(')
                .skip(1)
                .map(|ace| {
                    let parts: Vec<&str> = ace.trim_end_matches(')').split(';').collect();
                    (parts[0].to_string(), parts[2].to_string(), parts[5].to_string())
                })
                .collect()
        }

        /// What [`create_server`] asked for, read back from the kernel object:
        /// protected, network denied first, then the user and SYSTEM only.
        pub(crate) fn assert_protected_dacl(handle: HANDLE) {
            let sddl = dacl_sddl(handle);
            assert!(sddl.starts_with("D:P"), "{sddl}");
            let me = current_user_sid().unwrap();
            let got: Vec<(String, String)> = aces(&sddl).into_iter().map(|(t, _, sid)| (t, sid)).collect();
            assert_eq!(
                got,
                vec![("D".to_string(), "NU".to_string()), ("A".to_string(), me), ("A".to_string(), "SY".to_string())],
                "{sddl}"
            );
            // Each ACE covers all access (GA, mapped to the pipe's own rights).
            for (_, rights, _) in aces(&sddl) {
                assert!(rights == "GA" || rights == "FA", "{sddl}");
            }
        }

        #[tokio::test]
        async fn the_pipe_dacl_reads_back_protected_and_owner_only() {
            let name = unique_pipe("dacl");
            let server = create_server(&name, true).unwrap();
            assert_protected_dacl(HANDLE(server.as_raw_handle()));
        }

        #[tokio::test]
        async fn a_second_first_instance_is_refused() {
            let name = unique_pipe("first");
            let _server = create_server(&name, true).unwrap();
            assert!(create_server(&name, true).is_err());
            assert!(create_server(&name, false).is_ok());
        }

        #[tokio::test]
        async fn a_same_user_client_and_server_accept_each_other() {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let name = unique_pipe("peer");
            let mut server = create_server(&name, true).unwrap();
            let accepted = {
                let name = name.clone();
                tokio::spawn(async move {
                    let mut stream = accept(&mut server, &name).await.unwrap();
                    let mut buf = [0u8; 4];
                    stream.read_exact(&mut buf).await.unwrap();
                    buf
                })
            };
            let mut client = open_client(&name).await.unwrap();
            client.write_all(b"ping").await.unwrap();
            assert_eq!(&accepted.await.unwrap(), b"ping");
        }

        #[tokio::test]
        async fn no_such_pipe_is_not_found_at_once() {
            let start = std::time::Instant::now();
            let err = open_client(&unique_pipe("absent")).await.unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::NotFound);
            assert!(start.elapsed() < Duration::from_secs(1));
        }

        #[test]
        fn this_process_is_its_own_user() {
            let me = process_user(std::process::id()).unwrap();
            assert!(me.sid.starts_with("S-1-5-"), "{me:?}");
            assert!(is_same_user(&me));
            assert!(me.integrity >= 0x1000, "{me:?}");
            assert!(!is_same_user(&ProcessUser { sid: "S-1-5-18".into(), ..me.clone() }));
            assert!(!is_same_user(&ProcessUser { app_container: true, ..me.clone() }));
            assert!(!is_same_user(&ProcessUser { elevated: !me.elevated, ..me.clone() }), "elevation differs");
            assert!(!is_same_user(&ProcessUser { integrity: me.integrity + 0x1000, ..me.clone() }), "integrity differs");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_names_are_stable_per_path_and_differ_between_paths() {
        let a = pipe_name_with("p-", Path::new("one"));
        assert_eq!(a, pipe_name_with("p-", Path::new("one")));
        assert_ne!(a, pipe_name_with("p-", Path::new("two")));
        assert!(a.starts_with(r"\\.\pipe\p-"));
        assert_eq!(a.len(), r"\\.\pipe\p-".len() + 32);
    }

    #[test]
    fn a_path_key_is_one_spelling_however_it_was_written() {
        let want = r"c:\users\me\state";
        for p in [r"C:\Users\Me\State", r"c:\users\me\state\", r"\\?\C:\Users\ME\State", "C:/Users/Me/State/"] {
            assert_eq!(normalize_path_text(p), want, "{p}");
        }
        assert_eq!(normalize_path_text(r"\\?\UNC\Srv\Share\X"), r"\\srv\share\x");
        assert_eq!(normalize_path_text(r"C:\"), r"c:\");
        assert_ne!(key_hash("a"), key_hash("b"));
        assert_eq!(key_hash("a").len(), 32);
    }

    /// The host creates its state dir and then names its pipe; a client may
    /// name the pipe first. Reached through a link, as a temp dir is on a
    /// Windows CI runner (the 8.3 `RUNNER~1`) and on macOS (`/var`).
    #[test]
    fn a_path_key_does_not_change_when_the_path_comes_to_exist() {
        let (_dir, link) = crate::test_util::tempdir_via_symlink();
        let state = link.join("made").join("later");
        let before = normalized_path_key(&state);
        std::fs::create_dir_all(&state).unwrap();
        assert_eq!(normalized_path_key(&state), before);
    }

    #[test]
    fn the_sddl_denies_the_network_before_any_grant() {
        assert_eq!(protected_pipe_sddl("S-1-5-21-1"), "D:P(D;;GA;;;NU)(A;;GA;;;S-1-5-21-1)(A;;GA;;;SY)");
    }

    #[test]
    fn tokens_compare_exactly_and_an_empty_one_matches_nothing() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abd", "abc"));
        assert!(!token_matches("ab", "abc"));
        assert!(!token_matches("", ""));
    }

    #[test]
    fn a_token_round_trips_through_its_file() {
        let tmp = tempfile::tempdir().unwrap();
        let socket = tmp.path().join("x").join("host.sock");
        let token = create_token(&socket).unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(read_token(&socket).unwrap(), token);
        assert_eq!(token_path(&socket), tmp.path().join("x").join("host.token"));
    }
}
