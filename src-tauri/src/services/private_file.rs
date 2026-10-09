//! Who may touch a file, on Windows: the two directions of "owner only".
//!
//! - [`restrict_to_owner`] makes a file Tabtivity writes (a key, a token
//!   store, a private state file) readable by the signed-in user alone: an
//!   explicit full-control grant to the user's SID, then the inherited
//!   entries dropped (`icacls`). The Unix callers keep their mode bits
//!   (`0600`); this is their Windows spelling. A failure is logged, never
//!   fatal — the file then keeps the profile directory's ACL, as before.
//! - [`admin_locked`] is the Windows reading of `paths::root_owned_file`: a
//!   program only an administrator can have put there or changed, i.e. the
//!   file and its folder are owned by Administrators, SYSTEM or
//!   TrustedInstaller and no allow entry lets anyone else write either.
//!   `paths::system_executable` takes a trusted helper only when this holds.
//!
//! The decisions are pure ([`classify_sid`], [`sid_string`],
//! [`windows_acl_is_locked`], [`icacls_restrict_steps`]) and tested on every
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
    // `icacls` from System32 when its ACL checks out, by bare name otherwise
    // (`paths::command_no_window` puts it through the same trusted-helper
    // lookup).
    for args in icacls_restrict_steps(path, &sid) {
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
        GetAce, GetFileSecurityW, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner,
        GetSidIdentifierAuthority, GetSidSubAuthority, GetSidSubAuthorityCount,
        GetTokenInformation, IsValidSid, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::{classify_sid, sid_string, AceEntry, WinPrincipal};

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;
    const ACCESS_DENIED_OBJECT_ACE_TYPE: u8 = 6;
    const ACCESS_DENIED_CALLBACK_ACE_TYPE: u8 = 10;
    const ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE: u8 = 12;
    const INHERIT_ONLY_ACE: u8 = 0x08;

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

    /// The owner and DACL of `path`. `Some((owner, None))` is a NULL DACL.
    pub(super) fn read_security(path: &Path) -> Option<(WinPrincipal, Option<Vec<AceEntry>>)> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let info = (OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION).0;
        // SAFETY: the descriptor buffer is sized by the first call and
        // u64-aligned; the owner SID, the ACL and every ACE are read only
        // while it lives, through the API's own accessors, and only ACEs
        // below the ACL's own count are fetched.
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
}
