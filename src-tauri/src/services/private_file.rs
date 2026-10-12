//! Who may touch a file, on Windows: the two directions of "owner only".
//!
//! - [`restrict_to_owner`] makes a file Tabtivity writes (a key, a token
//!   store, a private state file) readable by the signed-in user alone: an
//!   explicit full-control grant to the user's SID, then the inherited
//!   entries dropped (`icacls`). The Unix callers keep their mode bits
//!   (`0600`); this is their Windows spelling. A failure is logged, never
//!   fatal — the file then keeps the profile directory's ACL, as before.
//! - [`restrict_dir_to_owner_inheritable`] does the same for a folder
//!   Tabtivity owns outright (the mail store). The user's grant carries
//!   `(OI)(CI)`, so every file already inside, and every file written there
//!   later, inherits "owner only" without an `icacls` run of its own. A
//!   folder already in that shape is left alone ([`dir_is_owner_inheritable`]),
//!   because rewriting a folder's ACL walks everything below it.
//! - [`admin_locked`] is the Windows reading of `paths::root_owned_file`: a
//!   program only an administrator can have put there or changed, i.e. the
//!   file and its folder are owned by Administrators, SYSTEM or
//!   TrustedInstaller and no allow entry lets anyone else write either.
//!   `paths::system_executable` takes a trusted helper only when this holds.
//!
//! The decisions are pure ([`classify_sid`], [`sid_string`],
//! [`windows_acl_is_locked`], [`icacls_restrict_steps`],
//! [`icacls_restrict_dir_steps`], [`dir_is_owner_inheritable`]) and tested on every
//! OS; only reading the security descriptor and spawning `icacls` are
//! Windows code. Verifying an existing file's ACL (the Windows half of
//! `mobile_control::store::ensure_private_file`) is a second reader and not
//! done here.

use std::ffi::OsString;
use std::path::Path;

/// The principals whose write access does not make a system file untrusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WinPrincipal {
    /// `BUILTIN\Administrators`, S-1-5-32-544.
    Administrators,
    /// `NT AUTHORITY\SYSTEM`, S-1-5-18.
    System,
    /// `NT SERVICE\TrustedInstaller`.
    TrustedInstaller,
    /// Anyone else, including the signed-in user and `CREATOR OWNER`.
    Other,
}

const NT_AUTHORITY: [u8; 6] = [0, 0, 0, 0, 0, 5];
/// `NT SERVICE\TrustedInstaller`: S-1-5-80 followed by the hash of the
/// service name, the same on every Windows install.
const TRUSTED_INSTALLER: [u32; 6] = [
    80,
    956_008_885,
    3_418_522_649,
    1_831_038_044,
    1_853_292_631,
    2_271_478_464,
];

/// Which of the trusted principals a SID is, from its identifier authority
/// and sub-authorities.
pub fn classify_sid(authority: [u8; 6], subs: &[u32]) -> WinPrincipal {
    if authority != NT_AUTHORITY {
        return WinPrincipal::Other;
    }
    match subs {
        [18] => WinPrincipal::System,
        [32, 544] => WinPrincipal::Administrators,
        s if s == TRUSTED_INSTALLER => WinPrincipal::TrustedInstaller,
        _ => WinPrincipal::Other,
    }
}

/// The `S-1-…` spelling of a SID (the form `icacls` takes after a `*`): the
/// authority in decimal when it fits 32 bits, else as 12 hex digits.
pub fn sid_string(authority: [u8; 6], subs: &[u32]) -> String {
    let mut out = if authority[0] == 0 && authority[1] == 0 {
        let value = u32::from_be_bytes([authority[2], authority[3], authority[4], authority[5]]);
        format!("S-1-{value}")
    } else {
        let hex: String = authority.iter().map(|b| format!("{b:02X}")).collect();
        format!("S-1-0x{hex}")
    };
    for sub in subs {
        out.push_str(&format!("-{sub}"));
    }
    out
}

/// One entry of a file's DACL, as far as the lock check needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AceEntry {
    /// `false` for an access-denied entry (it only ever takes rights away).
    pub allow: bool,
    pub who: WinPrincipal,
    pub mask: u32,
    /// Applies to children created later, not to this object.
    pub inherit_only: bool,
}

/// Every right that lets its holder change the file, its data, its name or
/// its ACL: write/append data (add file/subfolder on a folder), extended
/// attributes, delete child, attributes, `DELETE`, `WRITE_DAC`,
/// `WRITE_OWNER`, `GENERIC_ALL`, `GENERIC_WRITE`.
const WRITE_RIGHTS: u32 = 0x0002
    | 0x0004
    | 0x0010
    | 0x0040
    | 0x0100
    | 0x0001_0000
    | 0x0004_0000
    | 0x0008_0000
    | 0x1000_0000
    | 0x4000_0000;

/// Whether a file (or folder) with this owner and DACL can be changed only by
/// administrators: a trusted owner (an owner may always rewrite the DACL) and
/// no allow entry granting another principal a write right. A missing DACL
/// (`None`) grants everyone everything, so it is never locked.
pub fn windows_acl_is_locked(owner: WinPrincipal, dacl: Option<&[AceEntry]>) -> bool {
    if owner == WinPrincipal::Other {
        return false;
    }
    let Some(dacl) = dacl else {
        return false;
    };
    dacl.iter().all(|ace| {
        !ace.allow
            || ace.inherit_only
            || ace.who != WinPrincipal::Other
            || ace.mask & WRITE_RIGHTS == 0
    })
}

/// The two `icacls` runs that make `path` the user's alone, in order: first
/// grant the user full control explicitly (replacing any explicit entry of
/// theirs), then drop the inherited entries. In that order a failure halfway
/// leaves the file readable by its user, never with an empty ACL.
pub fn icacls_restrict_steps(path: &Path, user_sid: &str) -> [Vec<OsString>; 2] {
    [
        vec![
            path.as_os_str().to_owned(),
            "/grant:r".into(),
            format!("*{user_sid}:F").into(),
            "/Q".into(),
        ],
        vec![
            path.as_os_str().to_owned(),
            "/inheritance:r".into(),
            "/Q".into(),
        ],
    ]
}

/// The two `icacls` runs that make the folder `dir` and everything in it the
/// user's alone: [`icacls_restrict_steps`] with an inheritable grant
/// (`(OI)(CI)`: files and subfolders, present and future). Windows pushes the
/// change down to what is already inside, so a child that still inherits
/// loses the profile's entries and gains the user's; a child with its own
/// protected ACL (an older per-file restriction) keeps its explicit grant.
pub fn icacls_restrict_dir_steps(dir: &Path, user_sid: &str) -> [Vec<OsString>; 2] {
    [
        vec![
            dir.as_os_str().to_owned(),
            "/grant:r".into(),
            format!("*{user_sid}:(OI)(CI)F").into(),
            "/Q".into(),
        ],
        vec![
            dir.as_os_str().to_owned(),
            "/inheritance:r".into(),
            "/Q".into(),
        ],
    ]
}

/// One entry of a folder's DACL, as [`dir_is_owner_inheritable`] reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirAce {
    /// `false` for an access-denied entry.
    pub allow: bool,
    /// `S-1-…`, or `None` for an entry type that is not parsed.
    pub sid: Option<String>,
    /// The ACE header's flags (`OBJECT_INHERIT_ACE`, …).
    pub flags: u8,
    pub mask: u32,
}

const OBJECT_INHERIT_ACE: u8 = 0x01;
const CONTAINER_INHERIT_ACE: u8 = 0x02;
const INHERIT_ONLY_ACE: u8 = 0x08;
/// `FILE_ALL_ACCESS`, what `icacls … :F` grants.
const FILE_ALL_ACCESS: u32 = 0x001F_01FF;
const GENERIC_ALL: u32 = 0x1000_0000;

/// Whether a folder's DACL already is what [`icacls_restrict_dir_steps`]
/// leaves: protected (nothing inherited from above), every allow entry the
/// user's, and one of them full control that files and subfolders inherit.
/// A NULL DACL (`None`) lets everyone in.
pub fn dir_is_owner_inheritable(protected: bool, dacl: Option<&[DirAce]>, user_sid: &str) -> bool {
    let Some(dacl) = dacl else {
        return false;
    };
    let inherits = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    protected
        && dacl
            .iter()
            .all(|ace| !ace.allow || ace.sid.as_deref() == Some(user_sid))
        && dacl.iter().any(|ace| {
            ace.allow
                && ace.flags & inherits == inherits
                && ace.flags & INHERIT_ONLY_ACE == 0
                && (ace.mask & FILE_ALL_ACCESS == FILE_ALL_ACCESS || ace.mask & GENERIC_ALL != 0)
        })
}

/// Make `path` readable and writable by the signed-in user only (see the
/// module docs). Logged, not returned: callers write the file either way.
#[cfg(windows)]
pub fn restrict_to_owner(path: &Path) {
    if let Err(e) = try_restrict_to_owner(path) {
        eprintln!(
            "private_file: could not restrict {} to its owner: {e}",
            path.display()
        );
    }
}

#[cfg(windows)]
fn try_restrict_to_owner(path: &Path) -> Result<(), String> {
    let sid = win::current_user_sid().ok_or("the user's SID is unreadable")?;
    run_icacls(icacls_restrict_steps(path, &sid))
}

/// Make the folder `dir` and everything in it readable and writable by the
/// signed-in user only, now and for files created there later (see the
/// module docs). Only for a folder Tabtivity owns outright, never a project
/// folder or one another program shares. Idempotent, and cheap once done: a
/// folder already in that shape is not touched. Logged, not returned, like
/// [`restrict_to_owner`].
#[cfg(windows)]
pub fn restrict_dir_to_owner_inheritable(dir: &Path) {
    if let Err(e) = try_restrict_dir_to_owner_inheritable(dir) {
        eprintln!(
            "private_file: could not restrict the folder {} to its owner: {e}",
            dir.display()
        );
    }
}

#[cfg(windows)]
fn try_restrict_dir_to_owner_inheritable(dir: &Path) -> Result<(), String> {
    let sid = win::current_user_sid().ok_or("the user's SID is unreadable")?;
    let done = win::read_dir_dacl(dir).is_some_and(|(protected, dacl)| {
        dir_is_owner_inheritable(protected, dacl.as_deref(), &sid)
    });
    if done {
        return Ok(());
    }
    run_icacls(icacls_restrict_dir_steps(dir, &sid))
}

/// Run `icacls` once per step, in order, stopping at the first failure.
#[cfg(windows)]
fn run_icacls(steps: [Vec<OsString>; 2]) -> Result<(), String> {
    // `icacls` from System32 when its ACL checks out, by bare name otherwise
    // (`paths::command_no_window` puts it through the same trusted-helper
    // lookup).
    for args in steps {
        let out = crate::paths::command_no_window("icacls")
            .args(&args)
            .output()
            .map_err(|e| format!("icacls: {e}"))?;
        if !out.status.success() {
            let text = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            return Err(format!("icacls: {} {}", text.trim(), stdout.trim()));
        }
    }
    Ok(())
}

/// Whether `path` is a regular file only administrators can have put there
/// or changed (see the module docs). Links are resolved first; anything
/// unreadable counts as not locked.
#[cfg(windows)]
pub fn admin_locked(path: &Path) -> bool {
    let Ok(real) = path.canonicalize() else {
        return false;
    };
    let locked = |p: &Path| {
        win::read_security(p)
            .is_some_and(|(owner, dacl)| windows_acl_is_locked(owner, dacl.as_deref()))
    };
    std::fs::metadata(&real).is_ok_and(|m| m.is_file())
        && locked(&real)
        && real.parent().is_some_and(locked)
}

#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetAce, GetFileSecurityW, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        GetSecurityDescriptorOwner,
        GetSidIdentifierAuthority, GetSidSubAuthority, GetSidSubAuthorityCount,
        GetTokenInformation, IsValidSid, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::{classify_sid, sid_string, AceEntry, DirAce, WinPrincipal};

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;
    const ACCESS_DENIED_OBJECT_ACE_TYPE: u8 = 6;
    const ACCESS_DENIED_CALLBACK_ACE_TYPE: u8 = 10;
    const ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE: u8 = 12;
    const INHERIT_ONLY_ACE: u8 = 0x08;
    /// `SE_DACL_PROTECTED`: the DACL takes nothing from the parent.
    const SE_DACL_PROTECTED: u16 = 0x1000;

    /// The identifier authority and sub-authorities of a SID.
    ///
    /// # Safety
    /// `sid` must point into memory that stays valid for the call.
    unsafe fn sid_parts(sid: PSID) -> Option<([u8; 6], Vec<u32>)> {
        // SAFETY: the caller hands a SID inside a live buffer; IsValidSid
        // checks its revision and sub-authority count before anything else
        // is read, and every sub-authority index is below that count.
        unsafe {
            if sid.is_invalid() || !IsValidSid(sid).as_bool() {
                return None;
            }
            let authority = (*GetSidIdentifierAuthority(sid)).Value;
            let count = *GetSidSubAuthorityCount(sid);
            let subs = (0..u32::from(count))
                .map(|i| *GetSidSubAuthority(sid, i))
                .collect();
            Some((authority, subs))
        }
    }

    /// The signed-in user's SID, from this process's token.
    pub(super) fn current_user_sid() -> Option<String> {
        // SAFETY: the token handle is opened and closed here; the TokenUser
        // buffer is sized by the first call, u64-aligned, and outlives every
        // read of the SID inside it.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
            let mut needed = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
            let mut buf = vec![0u64; (needed as usize).div_ceil(8).max(1)];
            let got = GetTokenInformation(
                token,
                TokenUser,
                Some(buf.as_mut_ptr().cast()),
                needed,
                &mut needed,
            );
            let _ = CloseHandle(token);
            got.ok()?;
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let (authority, subs) = sid_parts(user.User.Sid)?;
            Some(sid_string(authority, &subs))
        }
    }

    /// The security descriptor of `path` (the parts `info` names), in a
    /// u64-aligned buffer the caller reads it from.
    fn descriptor(path: &Path, info: u32) -> Option<Vec<u64>> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: the buffer is sized by the first call, and the second call
        // writes at most `needed` bytes into it.
        unsafe {
            let mut needed = 0u32;
            let _ = GetFileSecurityW(PCWSTR(wide.as_ptr()), info, None, 0, &mut needed);
            if needed == 0 {
                return None;
            }
            let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
            let sd = PSECURITY_DESCRIPTOR(buf.as_mut_ptr().cast());
            if !GetFileSecurityW(PCWSTR(wide.as_ptr()), info, Some(sd), needed, &mut needed)
                .as_bool()
            {
                return None;
            }
            Some(buf)
        }
    }

    /// Whether a folder's DACL is protected, and its entries with their SIDs
    /// spelled out. `Some((_, None))` is a NULL DACL.
    pub(super) fn read_dir_dacl(path: &Path) -> Option<(bool, Option<Vec<DirAce>>)> {
        let mut buf = descriptor(path, DACL_SECURITY_INFORMATION.0)?;
        // SAFETY: as in `read_security`: the ACL and every ACE are read only
        // while `buf` lives, through the API's own accessors, and only ACEs
        // below the ACL's own count are fetched.
        unsafe {
            let sd = PSECURITY_DESCRIPTOR(buf.as_mut_ptr().cast());
            let mut control = 0u16;
            let mut revision = 0u32;
            GetSecurityDescriptorControl(sd, &mut control, &mut revision).ok()?;
            let protected = control & SE_DACL_PROTECTED != 0;
            let mut present = windows::core::BOOL(0);
            let mut defaulted = windows::core::BOOL(0);
            let mut dacl: *mut ACL = std::ptr::null_mut();
            GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted).ok()?;
            if !present.as_bool() || dacl.is_null() {
                return Some((protected, None));
            }
            let mut entries = Vec::new();
            for i in 0..u32::from((*dacl).AceCount) {
                let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                GetAce(dacl, i, &mut ace).ok()?;
                let header = &*(ace as *const ACE_HEADER);
                let entry = match header.AceType {
                    ACCESS_ALLOWED_ACE_TYPE | ACCESS_DENIED_ACE_TYPE => {
                        // The SID pointer comes from the raw ACE pointer, as
                        // in `read_security`.
                        let body = ace as *const ACCESS_ALLOWED_ACE;
                        let sid = PSID(std::ptr::addr_of!((*body).SidStart) as *mut _);
                        let (authority, subs) = sid_parts(sid)?;
                        DirAce {
                            allow: header.AceType == ACCESS_ALLOWED_ACE_TYPE,
                            sid: Some(sid_string(authority, &subs)),
                            flags: header.AceFlags,
                            mask: (*body).Mask,
                        }
                    }
                    ACCESS_DENIED_OBJECT_ACE_TYPE
                    | ACCESS_DENIED_CALLBACK_ACE_TYPE
                    | ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE => DirAce {
                        allow: false,
                        sid: None,
                        flags: header.AceFlags,
                        mask: 0,
                    },
                    // Any other allow entry is not parsed: counted as
                    // someone else's.
                    _ => DirAce {
                        allow: true,
                        sid: None,
                        flags: header.AceFlags,
                        mask: u32::MAX,
                    },
                };
                entries.push(entry);
            }
            Some((protected, Some(entries)))
        }
    }

    /// The owner and DACL of `path`. `Some((owner, None))` is a NULL DACL.
    pub(super) fn read_security(path: &Path) -> Option<(WinPrincipal, Option<Vec<AceEntry>>)> {
        let info = (OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION).0;
        let mut buf = descriptor(path, info)?;
        // SAFETY: the descriptor buffer is u64-aligned; the owner SID, the
        // ACL and every ACE are read only while it lives, through the API's
        // own accessors, and only ACEs below the ACL's own count are fetched.
        unsafe {
            let sd = PSECURITY_DESCRIPTOR(buf.as_mut_ptr().cast());
            let mut owner = PSID::default();
            let mut defaulted = windows::core::BOOL(0);
            GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted).ok()?;
            let (authority, subs) = sid_parts(owner)?;
            let owner = classify_sid(authority, &subs);
            let mut present = windows::core::BOOL(0);
            let mut dacl: *mut ACL = std::ptr::null_mut();
            GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted).ok()?;
            if !present.as_bool() || dacl.is_null() {
                return Some((owner, None));
            }
            let mut entries = Vec::new();
            for i in 0..u32::from((*dacl).AceCount) {
                let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                GetAce(dacl, i, &mut ace).ok()?;
                let header = &*(ace as *const ACE_HEADER);
                let inherit_only = header.AceFlags & INHERIT_ONLY_ACE != 0;
                let entry = match header.AceType {
                    ACCESS_ALLOWED_ACE_TYPE | ACCESS_DENIED_ACE_TYPE => {
                        // The SID runs past the struct's one-`u32` `SidStart`,
                        // so its pointer comes from the raw ACE pointer, not
                        // from a reference that covers the struct alone.
                        let body = ace as *const ACCESS_ALLOWED_ACE;
                        let sid = PSID(std::ptr::addr_of!((*body).SidStart) as *mut _);
                        let (authority, subs) = sid_parts(sid)?;
                        AceEntry {
                            allow: header.AceType == ACCESS_ALLOWED_ACE_TYPE,
                            who: classify_sid(authority, &subs),
                            mask: (*body).Mask,
                            inherit_only,
                        }
                    }
                    ACCESS_DENIED_OBJECT_ACE_TYPE
                    | ACCESS_DENIED_CALLBACK_ACE_TYPE
                    | ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE => AceEntry {
                        allow: false,
                        who: WinPrincipal::Other,
                        mask: 0,
                        inherit_only,
                    },
                    // Any other (object, callback, compound) allow entry is
                    // not parsed: counted as "anyone may write".
                    _ => AceEntry {
                        allow: true,
                        who: WinPrincipal::Other,
                        mask: u32::MAX,
                        inherit_only,
                    },
                };
                entries.push(entry);
            }
            Some((owner, Some(entries)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NT: [u8; 6] = NT_AUTHORITY;

    #[test]
    fn the_trusted_principals_are_told_apart_by_sid() {
        assert_eq!(classify_sid(NT, &[18]), WinPrincipal::System);
        assert_eq!(classify_sid(NT, &[32, 544]), WinPrincipal::Administrators);
        assert_eq!(
            classify_sid(NT, &TRUSTED_INSTALLER),
            WinPrincipal::TrustedInstaller
        );
        // Users, Authenticated Users, a real account, CREATOR OWNER, Everyone.
        assert_eq!(classify_sid(NT, &[32, 545]), WinPrincipal::Other);
        assert_eq!(classify_sid(NT, &[11]), WinPrincipal::Other);
        assert_eq!(classify_sid(NT, &[21, 1, 2, 3, 1001]), WinPrincipal::Other);
        assert_eq!(classify_sid([0, 0, 0, 0, 0, 3], &[0]), WinPrincipal::Other);
        assert_eq!(classify_sid([0, 0, 0, 0, 0, 1], &[0]), WinPrincipal::Other);
        // Another authority with the same numbers is not SYSTEM.
        assert_eq!(
            classify_sid([0, 0, 0, 0, 0, 16], &[18]),
            WinPrincipal::Other
        );
    }

    #[test]
    fn a_sid_is_spelled_like_windows_spells_it() {
        assert_eq!(
            sid_string(NT, &[21, 1_004_336_348, 1_177_238_915, 682_003_330, 1001]),
            "S-1-5-21-1004336348-1177238915-682003330-1001"
        );
        assert_eq!(sid_string(NT, &[18]), "S-1-5-18");
        assert_eq!(sid_string([0, 0, 0, 0, 0, 0], &[]), "S-1-0");
        assert_eq!(sid_string([0, 1, 0, 0, 0, 2], &[7]), "S-1-0x000100000002-7");
    }

    fn allow(who: WinPrincipal, mask: u32) -> AceEntry {
        AceEntry {
            allow: true,
            who,
            mask,
            inherit_only: false,
        }
    }

    /// `icacls "C:\Program Files\Git\cmd\git.exe"` on a stock install:
    /// SYSTEM:(I)(F), Administrators:(I)(F), Users:(I)(RX),
    /// ALL APPLICATION PACKAGES:(I)(RX), ALL RESTRICTED APPLICATION
    /// PACKAGES:(I)(RX); System32 adds TrustedInstaller:(F) and a
    /// CREATOR OWNER:(OI)(CI)(IO)(F) on the folder.
    #[test]
    fn a_stock_program_files_acl_is_locked() {
        const FULL: u32 = 0x001F_01FF;
        const READ_EXECUTE: u32 = 0x0012_00A9;
        let stock = [
            allow(WinPrincipal::System, FULL),
            allow(WinPrincipal::Administrators, FULL),
            allow(WinPrincipal::TrustedInstaller, FULL),
            allow(WinPrincipal::Other, READ_EXECUTE),
            allow(WinPrincipal::Other, READ_EXECUTE),
            AceEntry {
                allow: true,
                who: WinPrincipal::Other,
                mask: FULL,
                inherit_only: true,
            },
        ];
        assert!(windows_acl_is_locked(
            WinPrincipal::Administrators,
            Some(&stock)
        ));
        assert!(windows_acl_is_locked(
            WinPrincipal::TrustedInstaller,
            Some(&stock)
        ));
        assert!(windows_acl_is_locked(WinPrincipal::System, Some(&stock)));
        // Owned by the user: they may rewrite the DACL at will.
        assert!(!windows_acl_is_locked(WinPrincipal::Other, Some(&stock)));
        // A NULL DACL lets everyone in.
        assert!(!windows_acl_is_locked(WinPrincipal::Administrators, None));
        // A deny entry for anyone never unlocks.
        let mut denied = stock.to_vec();
        denied.push(AceEntry {
            allow: false,
            who: WinPrincipal::Other,
            mask: FULL,
            inherit_only: false,
        });
        assert!(windows_acl_is_locked(
            WinPrincipal::Administrators,
            Some(&denied)
        ));
    }

    #[test]
    fn any_write_right_for_another_principal_unlocks() {
        for right in [
            0x0002,
            0x0004,
            0x0010,
            0x0040,
            0x0100,
            0x0001_0000,
            0x0004_0000,
            0x0008_0000,
            0x1000_0000,
            0x4000_0000,
        ] {
            let acl = [
                allow(WinPrincipal::Administrators, 0x001F_01FF),
                allow(WinPrincipal::Other, 0x0012_00A9 | right),
            ];
            assert!(
                !windows_acl_is_locked(WinPrincipal::Administrators, Some(&acl)),
                "right {right:#x}"
            );
        }
        // Users:(M) — the per-user-install / writable-folder shape.
        let modify = [allow(WinPrincipal::Other, 0x0013_01BF)];
        assert!(!windows_acl_is_locked(
            WinPrincipal::Administrators,
            Some(&modify)
        ));
        // An unparsed allow entry counts as everything.
        let unknown = [allow(WinPrincipal::Other, u32::MAX)];
        assert!(!windows_acl_is_locked(WinPrincipal::System, Some(&unknown)));
    }

    #[test]
    fn restricting_grants_before_it_drops_inheritance() {
        let path = Path::new(r"C:\Users\u\AppData\Roaming\x\key.bin");
        let [grant, strip] = icacls_restrict_steps(path, "S-1-5-21-1-2-3-1001");
        let s = |v: &[OsString]| {
            v.iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            s(&grant),
            [
                r"C:\Users\u\AppData\Roaming\x\key.bin",
                "/grant:r",
                "*S-1-5-21-1-2-3-1001:F",
                "/Q"
            ]
        );
        assert_eq!(
            s(&strip),
            [
                r"C:\Users\u\AppData\Roaming\x\key.bin",
                "/inheritance:r",
                "/Q"
            ]
        );
    }

    #[test]
    fn a_folder_grant_is_inheritable_and_comes_before_dropping_inheritance() {
        let dir = Path::new(r"C:\Users\u\AppData\Roaming\x\mail");
        let [grant, strip] = icacls_restrict_dir_steps(dir, "S-1-5-21-1-2-3-1001");
        let s = |v: &[OsString]| {
            v.iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            s(&grant),
            [
                r"C:\Users\u\AppData\Roaming\x\mail",
                "/grant:r",
                "*S-1-5-21-1-2-3-1001:(OI)(CI)F",
                "/Q"
            ]
        );
        assert_eq!(
            s(&strip),
            [r"C:\Users\u\AppData\Roaming\x\mail", "/inheritance:r", "/Q"]
        );
        // The file form never asks for inheritance: a file has no children.
        let [file_grant, _] = icacls_restrict_steps(dir, "S-1-5-21-1-2-3-1001");
        assert!(!s(&file_grant)[2].contains("(OI)"));
    }

    #[test]
    fn only_a_protected_user_only_inheritable_folder_counts_as_done() {
        const ME: &str = "S-1-5-21-1-2-3-1001";
        let mine = |flags: u8, mask: u32| DirAce {
            allow: true,
            sid: Some(ME.into()),
            flags,
            mask,
        };
        let oici = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
        // What the two icacls steps leave.
        let done = [mine(oici, FILE_ALL_ACCESS)];
        assert!(dir_is_owner_inheritable(true, Some(&done), ME));
        assert!(dir_is_owner_inheritable(
            true,
            Some(&[mine(oici, GENERIC_ALL)]),
            ME
        ));
        // Still inheriting the profile's entries from above.
        assert!(!dir_is_owner_inheritable(false, Some(&done), ME));
        // A NULL DACL, or an empty one that grants no one anything.
        assert!(!dir_is_owner_inheritable(true, None, ME));
        assert!(!dir_is_owner_inheritable(true, Some(&[]), ME));
        // Another user's SID.
        assert!(!dir_is_owner_inheritable(
            true,
            Some(&done),
            "S-1-5-21-1-2-3-1002"
        ));
        // The grant reaches files only, folders only, or not the folder itself.
        for flags in [
            OBJECT_INHERIT_ACE,
            CONTAINER_INHERIT_ACE,
            oici | INHERIT_ONLY_ACE,
            0,
        ] {
            assert!(
                !dir_is_owner_inheritable(true, Some(&[mine(flags, FILE_ALL_ACCESS)]), ME),
                "flags {flags:#x}"
            );
        }
        // Read-only is not the full control the steps grant.
        assert!(!dir_is_owner_inheritable(
            true,
            Some(&[mine(oici, 0x0012_00A9)]),
            ME
        ));
        // Anyone else allowed in, by SID or by an entry not parsed, undoes it;
        // a deny entry does not.
        let others = [
            DirAce {
                allow: true,
                sid: Some("S-1-5-18".into()),
                flags: oici,
                mask: FILE_ALL_ACCESS,
            },
            DirAce {
                allow: true,
                sid: None,
                flags: 0,
                mask: u32::MAX,
            },
        ];
        for other in others {
            assert!(!dir_is_owner_inheritable(
                true,
                Some(&[mine(oici, FILE_ALL_ACCESS), other]),
                ME
            ));
        }
        let denied = DirAce {
            allow: false,
            sid: None,
            flags: 0,
            mask: 0,
        };
        assert!(dir_is_owner_inheritable(
            true,
            Some(&[denied, mine(oici, FILE_ALL_ACCESS)]),
            ME
        ));
    }
}
