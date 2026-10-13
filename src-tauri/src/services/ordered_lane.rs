//! One worker thread that runs jobs strictly in the order they were handed in.
//!
//! The persistence commands (`commands::persist_lane`) used to run on the GTK
//! main thread, which froze the window for two fsyncs per save but also gave
//! them an order for free: a later save could never land before an earlier
//! one. A thread pool would lose that order, so they run here instead — off
//! the main thread, still first in, first out.

use std::panic::{catch_unwind, AssertUnwindSafe};
use app_core::sync::LockExt;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

type Job = Box<dyn FnOnce() + Send + 'static>;

/// A first-in-first-out job queue with a single worker thread.
pub struct OrderedLane {
    name: &'static str,
    /// `None` until the first job; the worker is spawned lazily so a lane that
    /// is never used costs no thread. The mutex also orders concurrent senders.
    sender: Mutex<Option<Sender<Job>>>,
}

impl OrderedLane {
    pub const fn new(name: &'static str) -> Self {
        Self { name, sender: Mutex::new(None) }
    }

    /// Queue `job` behind every job handed in before it. Never blocks on the
    /// jobs themselves. If the worker cannot be started the job runs on the
    /// caller's thread: slower, but nothing is dropped and the order holds.
    pub fn run(&self, job: impl FnOnce() + Send + 'static) {
        let mut job: Job = Box::new(job);
        let mut sender = self.sender.lock_ok();
        for _ in 0..2 {
            if sender.is_none() {
                *sender = spawn_worker(self.name);
            }
            let Some(tx) = sender.as_ref() else { break };
            match tx.send(job) {
                Ok(()) => return,
                // The worker is gone; start a fresh one and hand the job over.
                Err(returned) => {
                    job = returned.0;
                    *sender = None;
                }
            }
        }
        job();
    }

    /// Wait until every job queued so far has run, at most `timeout`. Answers
    /// whether the lane emptied in time. Called at exit so a save the window
    /// sent just before quitting is on disk before the process goes.
    pub fn drain(&self, timeout: Duration) -> bool {
        if self.sender.lock_ok().is_none() {
            return true;
        }
        let (done_tx, done_rx) = channel();
        self.run(move || {
            let _ = done_tx.send(());
        });
        done_rx.recv_timeout(timeout).is_ok()
    }
}

fn spawn_worker(name: &'static str) -> Option<Sender<Job>> {
    let (tx, rx) = channel::<Job>();
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            for job in rx {
                // One panicking job must not strand everything queued behind it.
                if catch_unwind(AssertUnwindSafe(job)).is_err() {
                    eprintln!("{name}: a queued job panicked");
                }
            }
        })
        .ok()
        .map(|_| tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn jobs_run_in_submission_order_off_the_calling_thread() {
        static LANE: OrderedLane = OrderedLane::new("test-lane-order");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let caller = std::thread::current().id();
        for index in 0..200 {
            let seen = seen.clone();
            LANE.run(move || {
                // Early jobs are the slow ones: a pool would let later ones overtake.
                if index < 3 {
                    std::thread::sleep(Duration::from_millis(5));
                }
                seen.lock().unwrap().push((index, std::thread::current().id()));
            });
        }
        assert!(LANE.drain(Duration::from_secs(10)));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.iter().map(|(index, _)| *index).collect::<Vec<_>>(), (0..200).collect::<Vec<_>>());
        assert!(seen.iter().all(|(_, thread)| *thread != caller));
    }

    #[test]
    fn a_panicking_job_does_not_stop_the_lane() {
        static LANE: OrderedLane = OrderedLane::new("test-lane-panic");
        let ran = Arc::new(Mutex::new(false));
        LANE.run(|| panic!("boom"));
        let flag = ran.clone();
        LANE.run(move || *flag.lock().unwrap() = true);
        assert!(LANE.drain(Duration::from_secs(10)));
        assert!(*ran.lock().unwrap());
    }

    #[test]
    fn drain_reports_a_lane_that_is_still_busy() {
        static LANE: OrderedLane = OrderedLane::new("test-lane-busy");
        assert!(LANE.drain(Duration::from_millis(1)), "an unused lane is empty");
        let (release_tx, release_rx) = channel::<()>();
        LANE.run(move || {
            let _ = release_rx.recv();
        });
        assert!(!LANE.drain(Duration::from_millis(20)));
        release_tx.send(()).unwrap();
        assert!(LANE.drain(Duration::from_secs(10)));
    }
}
