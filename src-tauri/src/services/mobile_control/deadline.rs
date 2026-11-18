//! A deadline for the files browser's blocking calls on this computer's
//! side (list, entry, search, the raw open). A folder on a stalled network
//! mount blocks its thread in the kernel for as long as the mount stalls;
//! the phone gets `timeout` after [`LOCAL_DEADLINE`] instead of a request
//! that never answers.
//!
//! A blocked thread cannot be cancelled, so the calls still running past
//! their deadline are counted: while [`MAX_STALLED`] are, a new call answers
//! `timeout` at once instead of parking yet another blocking thread on the
//! same mount.

use std::sync::{
    atomic::{AtomicU8, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use super::files::FilesError;

/// How long one local files call may hold a request.
pub const LOCAL_DEADLINE: Duration = Duration::from_secs(20);

/// How many calls may run on past their deadline before new ones are
/// turned away.
pub const MAX_STALLED: usize = 4;

const RUNNING: u8 = 0;
const DONE: u8 = 1;
const STALLED: u8 = 2;

/// The count of calls past their deadline that have not ended yet.
#[derive(Default)]
pub struct Deadline {
    stalled: AtomicUsize,
}

/// The one the phone's files routes share.
pub static LOCAL: Deadline = Deadline { stalled: AtomicUsize::new(0) };

impl Deadline {
    /// How many calls are running past their deadline.
    pub fn stalled(&self) -> usize {
        self.stalled.load(Ordering::SeqCst)
    }

    /// Runs `work` on a blocking thread and waits at most `limit` for it.
    pub async fn run<T, F>(&'static self, limit: Duration, work: F) -> Result<T, FilesError>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, FilesError> + Send + 'static,
    {
        if self.stalled() >= MAX_STALLED {
            return Err(FilesError::TimedOut);
        }
        let state = Arc::new(AtomicU8::new(RUNNING));
        let ended = state.clone();
        let task = tokio::task::spawn_blocking(move || {
            let answer = work();
            // Counted as stalled meanwhile: it no longer is.
            if ended.swap(DONE, Ordering::SeqCst) == STALLED {
                self.stalled.fetch_sub(1, Ordering::SeqCst);
            }
            answer
        });
        match tokio::time::timeout(limit, task).await {
            Ok(joined) => joined.unwrap_or_else(|error| Err(FilesError::Io(error.to_string()))),
            Err(_) => {
                // Counted before it is marked, so the thread's own decrement
                // (which needs the mark) never runs ahead of the count.
                self.stalled.fetch_add(1, Ordering::SeqCst);
                if state.compare_exchange(RUNNING, STALLED, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                    // It ended just now: nothing is left running.
                    self.stalled.fetch_sub(1, Ordering::SeqCst);
                }
                Err(FilesError::TimedOut)
            }
        }
    }
}

/// [`Deadline::run`] on the shared count with [`LOCAL_DEADLINE`].
pub async fn local<T, F>(work: F) -> Result<T, FilesError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, FilesError> + Send + 'static,
{
    LOCAL.run(LOCAL_DEADLINE, work).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stalled_call_times_out_and_enough_of_them_turn_new_ones_away() {
        static OWN: Deadline = Deadline { stalled: AtomicUsize::new(0) };
        // Only calls that must time out get the short limit; a call that
        // must finish gets a long one, since under a loaded test run the
        // blocking pool alone can take longer than 50 ms to start a thread.
        let short = Duration::from_millis(50);
        let ample = Duration::from_secs(30);
        assert_eq!(OWN.run(ample, || Ok(7)).await, Ok(7));

        let mut releases = Vec::new();
        for _ in 0..MAX_STALLED {
            let (release, held) = mpsc::channel::<()>();
            releases.push(release);
            let answer = OWN.run(short, move || {
                let _ = held.recv();
                Ok(())
            });
            assert_eq!(answer.await, Err(FilesError::TimedOut));
        }
        assert_eq!(OWN.stalled(), MAX_STALLED);
        // Turned away at once, without waiting out the deadline.
        let started = std::time::Instant::now();
        assert_eq!(OWN.run(Duration::from_secs(30), || Ok(1)).await, Err(FilesError::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(5));

        // The stalled calls end: the count drains and calls run again.
        drop(releases);
        let drained = std::time::Instant::now();
        while OWN.stalled() > 0 && drained.elapsed() < Duration::from_secs(30) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(OWN.stalled(), 0);
        assert_eq!(OWN.run(ample, || Ok(2)).await, Ok(2));
    }
}
