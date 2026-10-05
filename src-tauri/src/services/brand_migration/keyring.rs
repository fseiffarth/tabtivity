//! The OS keyring entries: a secret saved under a service named after the
//! app's old name is found there when the current service has none, and
//! copied to the current service on the way.
//!
//! Lazy by nature. A keyring cannot be listed, so there is no "move them
//! all": an entry moves the first time it is read. And it only ever happens
//! on a read the caller was going to make anyway, against a keyring that
//! read just proved open — nothing here unlocks or prompts.
//!
//! The old entry stays (an older build on the same machine still reads it)
//! until a later release deletes it; a secret the user clears is cleared
//! under both names, or the old one would come straight back.

use crate::brand::{Name, Pair};

/// A keyring, as far as the dual read needs it. Production implements it
/// over the `keyring` crate; the tests over a map.
pub trait Store {
    /// The secret of `account` under `service`; `None` when there is none
    /// or it cannot be read.
    fn get(&self, service: &str, account: &str) -> Option<String>;
    /// Save `secret`. Called only right after a successful `get`.
    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String>;
    /// Remove the entry; a missing one is fine.
    fn clear(&self, service: &str, account: &str) -> Result<(), String>;
}

/// Read `account` from the service `name`: the current service first, then
/// the old one (counted as a legacy hit under `hit_id`, and copied to the
/// current service). `may_copy` is false where a write must not be tried
/// (a keyring known to be locked).
pub fn get(pair: &Pair, name: Name, store: &dyn Store, account: &str, hit_id: &str, may_copy: bool) -> Option<String> {
    if let Some(secret) = store.get(&pair.cur(name), account) {
        return Some(secret);
    }
    let old_service = pair.legacy(name)?;
    let secret = store.get(&old_service, account)?;
    crate::brand::legacy_hit(hit_id);
    if may_copy && store.set(&pair.cur(name), account, &secret).is_ok() {
        super::lazy_ran(pair, &crate::storage::state_dir(), "keyring", "an entry was copied to the current service");
    }
    Some(secret)
}

/// Clear `account` under the old service too, after the caller cleared it
/// under the current one. Does nothing while the name is unchanged.
pub fn clear_legacy(pair: &Pair, name: Name, store: &dyn Store, account: &str) {
    if let Some(old_service) = pair.legacy(name) {
        let _ = store.clear(&old_service, account);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::hits;
    use super::super::testing::{RENAMED, UNCHANGED};
    use super::*;
    use crate::brand::LEGACY;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    /// A keyring in memory that also records what was asked of it.
    #[derive(Default)]
    pub(crate) struct MemoryStore {
        pub entries: RefCell<BTreeMap<(String, String), String>>,
        pub reads: RefCell<Vec<String>>,
    }

    impl MemoryStore {
        pub fn with(entries: &[(&str, &str, &str)]) -> Self {
            let store = Self::default();
            for (service, account, secret) in entries {
                store
                    .entries
                    .borrow_mut()
                    .insert((service.to_string(), account.to_string()), secret.to_string());
            }
            store
        }
        fn has(&self, service: &str, account: &str) -> Option<String> {
            self.entries.borrow().get(&(service.to_string(), account.to_string())).cloned()
        }
    }

    impl Store for MemoryStore {
        fn get(&self, service: &str, account: &str) -> Option<String> {
            self.reads.borrow_mut().push(service.to_string());
            self.has(service, account)
        }
        fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
            self.entries
                .borrow_mut()
                .insert((service.to_string(), account.to_string()), secret.to_string());
            Ok(())
        }
        fn clear(&self, service: &str, account: &str) -> Result<(), String> {
            self.entries.borrow_mut().remove(&(service.to_string(), account.to_string()));
            Ok(())
        }
    }

    const NAME: Name = Name::KEYRING_REMOTE;

    #[test]
    fn an_old_entry_is_found_copied_and_kept() {
        let old_service = LEGACY.name(NAME);
        let store = MemoryStore::with(&[(&old_service, "ssh:host", "hunter2")]);
        let _ = hits::taken();
        assert_eq!(get(&RENAMED, NAME, &store, "ssh:host", "keyring-remote", true), Some("hunter2".into()));
        assert_eq!(hits::taken_here(), ["keyring-remote"]);
        assert_eq!(store.has("newname-remote", "ssh:host"), Some("hunter2".into()));
        assert_eq!(store.has(&old_service, "ssh:host"), Some("hunter2".into()));
        // The second read finds it under the current service: no more hits.
        assert_eq!(get(&RENAMED, NAME, &store, "ssh:host", "keyring-remote", true), Some("hunter2".into()));
        assert!(hits::taken().is_empty());
    }

    #[test]
    fn a_locked_keyring_is_read_but_not_written() {
        let old_service = LEGACY.name(NAME);
        let store = MemoryStore::with(&[(&old_service, "ssh:host", "hunter2")]);
        assert_eq!(get(&RENAMED, NAME, &store, "ssh:host", "keyring-remote", false), Some("hunter2".into()));
        assert_eq!(store.has("newname-remote", "ssh:host"), None);
    }

    #[test]
    fn the_current_entry_wins_and_a_miss_is_a_miss() {
        let old_service = LEGACY.name(NAME);
        let store = MemoryStore::with(&[(&old_service, "a", "old"), ("newname-remote", "a", "new")]);
        let _ = hits::taken();
        assert_eq!(get(&RENAMED, NAME, &store, "a", "keyring-remote", true), Some("new".into()));
        assert_eq!(get(&RENAMED, NAME, &store, "b", "keyring-remote", true), None);
        assert!(hits::taken().is_empty());
    }

    #[test]
    fn a_cleared_secret_does_not_come_back_from_the_old_service() {
        let old_service = LEGACY.name(NAME);
        let store = MemoryStore::with(&[(&old_service, "a", "old"), ("newname-remote", "a", "old")]);
        store.clear("newname-remote", "a").expect("clear");
        clear_legacy(&RENAMED, NAME, &store, "a");
        assert_eq!(get(&RENAMED, NAME, &store, "a", "keyring-remote", true), None);
    }

    #[test]
    fn the_unchanged_pair_reads_one_service_once() {
        let store = MemoryStore::default();
        assert_eq!(get(&UNCHANGED, NAME, &store, "a", "keyring-remote", true), None);
        assert_eq!(*store.reads.borrow(), [crate::brand::KEYRING_REMOTE]);
        clear_legacy(&UNCHANGED, NAME, &store, "a");
        assert!(store.entries.borrow().is_empty());
    }
}
