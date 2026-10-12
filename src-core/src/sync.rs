//! Poison-tolerant locking for `std::sync::Mutex`.
//!
//! A panic while a guard is held poisons the mutex, and every later
//! `lock().unwrap()` panics too — one panic under the PTY, window or VPN
//! registry used to take down every later call on it, the exit teardown
//! included. The locks this is used on hold plain data (registries, caches,
//! counters) that stays consistent across one interrupted update, so a
//! poisoned lock is taken anyway: `m.lock_ok()` in place of
//! `m.lock().unwrap()` / `m.lock().unwrap_or_else(PoisonError::into_inner)`.
//! A lock whose data a half-done update could leave unsafe keeps its own
//! poison handling instead (the mail store maps it to an error).

use std::sync::{Mutex, MutexGuard, PoisonError};

/// `lock_ok` on `std::sync::Mutex`: lock it, recovering the guard if a
/// panicking holder poisoned it.
pub trait LockExt<T: ?Sized> {
    fn lock_ok(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> LockExt<T> for Mutex<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_poisoned_mutex_is_still_lockable_and_keeps_its_data() {
        let m = Arc::new(Mutex::new(vec![1, 2]));
        let held = Arc::clone(&m);
        let panicked = std::thread::spawn(move || {
            let mut guard = held.lock().unwrap();
            guard.push(3);
            panic!("poison the lock");
        })
        .join();
        assert!(panicked.is_err());
        assert!(m.is_poisoned());
        assert_eq!(*m.lock_ok(), vec![1, 2, 3]);
        m.lock_ok().push(4);
        assert_eq!(*m.lock_ok(), vec![1, 2, 3, 4]);
    }

    #[test]
    fn an_unpoisoned_mutex_locks_normally() {
        let m = Mutex::new(7);
        *m.lock_ok() += 1;
        assert_eq!(*m.lock_ok(), 8);
        assert!(!m.is_poisoned());
    }
}
