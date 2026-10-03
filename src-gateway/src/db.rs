//! The gateway's account table (hosted plan §4.1): which Unix accounts are
//! server users, their role, and which device ids route to which account.
//! One JSON file, `gateway.json`, in the gateway's state dir; the helper
//! (root) and the gateway both edit it, each under an exclusive `flock` on
//! `gateway.lock`, each write atomic.
//!
//! What it never holds: content. No subjects, titles, paths, project names
//! or counts — device names are the only free text, and they are the user's
//! own label for a device (§6.7 "the gateway never holds any of it").

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DB_FILE: &str = "gateway.json";
pub const LOCK_FILE: &str = "gateway.lock";
const SCHEMA: u32 = 1;
const MAX_DEVICE_NAME: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    User,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::User => "user",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub name: String,
    pub uid: u32,
    pub role: Role,
    pub created_at: u64,
    #[serde(default)]
    pub devices: Vec<Device>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Db {
    pub schema: u32,
    #[serde(default)]
    pub accounts: Vec<Account>,
}

impl Default for Db {
    fn default() -> Self {
        Self { schema: SCHEMA, accounts: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbError {
    Io(String),
    UnknownAccount,
    AccountExists,
    /// The device id already routes to another account: a daemon that
    /// answered a pair with someone else's id is refused, never remapped.
    DeviceTaken,
    InvalidName,
    InvalidDevice,
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Io(e) => write!(f, "{e}"),
            DbError::UnknownAccount => f.write_str("no such server account"),
            DbError::AccountExists => f.write_str("the account is already a server user"),
            DbError::DeviceTaken => f.write_str("the device id belongs to another account"),
            DbError::InvalidName => f.write_str("not a valid account name"),
            DbError::InvalidDevice => f.write_str("not a valid device id"),
        }
    }
}

impl Db {
    pub fn path_in(dir: &Path) -> PathBuf {
        dir.join(DB_FILE)
    }

    /// Read the table; a missing file is an empty table, a corrupt one an
    /// error (never silently empty: that would drop every account).
    pub fn load(dir: &Path) -> Result<Db, DbError> {
        match crate::read_regular(&Self::path_in(dir)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| DbError::Io(format!("{}: {e}", Self::path_in(dir).display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Db::default()),
            Err(e) => Err(DbError::Io(e.to_string())),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), DbError> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| DbError::Io(e.to_string()))?;
        crate::write_atomic(&Self::path_in(dir), &bytes, 0o640).map_err(|e| DbError::Io(e.to_string()))
    }

    pub fn account(&self, name: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.name == name)
    }

    /// The account a device routes to.
    pub fn owner_of(&self, device_id: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.devices.iter().any(|d| d.id == device_id))
    }

    /// Is `device_id` still a device of `user`? What every routed request and
    /// every live socket is re-checked against.
    pub fn routes(&self, user: &str, device_id: &str) -> bool {
        self.account(user).is_some_and(|a| a.devices.iter().any(|d| d.id == device_id))
    }

    pub fn add_account(&mut self, name: &str, uid: u32, role: Role, now: u64) -> Result<(), DbError> {
        if !crate::wire::valid_account_name(name) {
            return Err(DbError::InvalidName);
        }
        if self.accounts.iter().any(|a| a.name == name || a.uid == uid) {
            return Err(DbError::AccountExists);
        }
        self.accounts.push(Account { name: name.into(), uid, role, created_at: now, devices: Vec::new() });
        Ok(())
    }

    pub fn remove_account(&mut self, name: &str) -> Result<Account, DbError> {
        let index = self.accounts.iter().position(|a| a.name == name).ok_or(DbError::UnknownAccount)?;
        Ok(self.accounts.remove(index))
    }

    pub fn set_role(&mut self, name: &str, role: Role) -> Result<(), DbError> {
        self.accounts.iter_mut().find(|a| a.name == name).ok_or(DbError::UnknownAccount)?.role = role;
        Ok(())
    }

    pub fn add_device(&mut self, user: &str, id: &str, name: &str, now: u64) -> Result<(), DbError> {
        if !crate::wire::valid_device_id(id) {
            return Err(DbError::InvalidDevice);
        }
        if let Some(owner) = self.owner_of(id) {
            return if owner.name == user { Ok(()) } else { Err(DbError::DeviceTaken) };
        }
        let name: String = name.chars().filter(|c| !c.is_control()).take(MAX_DEVICE_NAME).collect();
        let account = self.accounts.iter_mut().find(|a| a.name == user).ok_or(DbError::UnknownAccount)?;
        account.devices.push(Device { id: id.into(), name, paired_at: now });
        Ok(())
    }

    /// Drop a device's route. `Ok(false)` when it had none.
    pub fn revoke_device(&mut self, user: &str, id: &str) -> Result<bool, DbError> {
        let account = self.accounts.iter_mut().find(|a| a.name == user).ok_or(DbError::UnknownAccount)?;
        let before = account.devices.len();
        account.devices.retain(|d| d.id != id);
        Ok(account.devices.len() != before)
    }
}

/// Read-modify-write the table under the exclusive lock.
pub fn update<T>(dir: &Path, f: impl FnOnce(&mut Db) -> Result<T, DbError>) -> Result<T, DbError> {
    let _lock = Lock::exclusive(dir)?;
    let mut db = Db::load(dir)?;
    let out = f(&mut db)?;
    db.save(dir)?;
    Ok(out)
}

/// An exclusive `flock` on `gateway.lock`, released on drop.
pub struct Lock {
    _file: std::fs::File,
}

impl Lock {
    pub fn exclusive(dir: &Path) -> Result<Lock, DbError> {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(false).write(true);
        // The helper takes this lock as root in a directory the gateway's
        // account owns: never through a planted symlink (root would create
        // or open whatever it names).
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(dir.join(LOCK_FILE)).map_err(|e| DbError::Io(format!("{}: {e}", dir.join(LOCK_FILE).display())))?;
        if !file.metadata().is_ok_and(|m| m.is_file()) {
            return Err(DbError::Io(format!("{}: not a regular file", dir.join(LOCK_FILE).display())));
        }
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            // SAFETY: flock on a descriptor this function owns.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
                return Err(DbError::Io(std::io::Error::last_os_error().to_string()));
            }
        }
        Ok(Lock { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_routes_to_one_account_only() {
        let mut db = Db::default();
        db.add_account("alice", 1001, Role::User, 1).unwrap();
        db.add_account("bob", 1002, Role::Admin, 1).unwrap();
        assert_eq!(db.add_account("alice", 1003, Role::User, 1), Err(DbError::AccountExists));
        assert_eq!(db.add_account("carol", 1001, Role::User, 1), Err(DbError::AccountExists), "one uid, one account");
        assert_eq!(db.add_account("Bad-name", 1004, Role::User, 1), Err(DbError::InvalidName));
        db.add_device("alice", "dev_alice_0001", "Phone\u{7}", 2).unwrap();
        assert_eq!(db.account("alice").unwrap().devices[0].name, "Phone", "control characters dropped");
        // Bob's daemon claiming Alice's device id is refused, not remapped.
        assert_eq!(db.add_device("bob", "dev_alice_0001", "x", 3), Err(DbError::DeviceTaken));
        assert!(db.routes("alice", "dev_alice_0001"));
        assert!(!db.routes("bob", "dev_alice_0001"));
        assert_eq!(db.add_device("bob", "a.b", "x", 3), Err(DbError::InvalidDevice));
        assert!(db.revoke_device("alice", "dev_alice_0001").unwrap());
        assert!(!db.routes("alice", "dev_alice_0001"));
        assert!(!db.revoke_device("alice", "dev_alice_0001").unwrap());
    }

    #[test]
    fn updates_round_trip_through_the_file_and_corruption_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        update(dir.path(), |db| db.add_account("alice", 1001, Role::User, 5)).unwrap();
        update(dir.path(), |db| db.add_device("alice", "dev_alice_0001", "Laptop", 6)).unwrap();
        let db = Db::load(dir.path()).unwrap();
        assert_eq!(db.owner_of("dev_alice_0001").unwrap().uid, 1001);
        std::fs::write(Db::path_in(dir.path()), b"{not json").unwrap();
        assert!(Db::load(dir.path()).is_err());
        assert!(update(dir.path(), |db| db.add_account("bob", 1002, Role::User, 7)).is_err(), "a corrupt table is never overwritten");
    }

    /// The helper edits the table as root in the gateway's own directory: a
    /// symlink the gateway's account planted there leads nowhere.
    #[cfg(unix)]
    #[test]
    fn planted_symlinks_are_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let state = dir.path().join("state");
        std::fs::create_dir(&state).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("created-by-root"), state.join(LOCK_FILE)).unwrap();
        assert!(update(&state, |db| db.add_account("alice", 1001, Role::User, 5)).is_err());
        assert!(!elsewhere.join("created-by-root").exists(), "the lock's symlink was not followed");
        std::fs::remove_file(state.join(LOCK_FILE)).unwrap();
        std::fs::write(elsewhere.join("secret"), b"{}").unwrap();
        std::os::unix::fs::symlink(elsewhere.join("secret"), Db::path_in(&state)).unwrap();
        assert!(Db::load(&state).is_err(), "the table's symlink is not read");
    }
}
