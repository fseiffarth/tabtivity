//! The per-folder serial worker: two tabs in one folder never snapshot at
//! once, and a queued duplicate is coalesced. A worker thread exists only while
//! its folder has jobs.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use app_core::sync::LockExt;
use app_core::CoreCtx;

use super::snapshot::{self, Who};
use super::store::{Kind, Row, Store};

/// One queued snapshot.
pub struct Job {
    pub folder: PathBuf,
    pub kind: Kind,
    pub who: Who,
    pub prompt_at: Option<u64>,
    /// Told the outcome (a user's "Checkpoint now" waits for it).
    pub reply: Option<Sender<Result<Row, String>>>,
}

/// What a queue does with a job and when its folder goes idle.
pub struct Runner {
    pub run: Box<dyn Fn(Job) + Send + Sync>,
    pub idle: Box<dyn Fn(&Path) + Send + Sync>,
}

/// Queue `job` behind its folder's earlier ones. A job that nobody waits on
/// and that repeats a queued one (same tab, same kind) is merged into it: a
/// `post` is replaced by the newer (it saw more), anything else is dropped.
fn coalesce(queue: &mut VecDeque<Job>, job: Job) {
    if job.reply.is_none() {
        if let Some(queued) = queue
            .iter_mut()
            .find(|q| q.reply.is_none() && q.kind == job.kind && q.who.tab_uid == job.who.tab_uid)
        {
            if job.kind == Kind::Post {
                *queued = job;
            }
            return;
        }
    }
    queue.push_back(job);
}

/// The queues of every folder with work.
pub struct Queues {
    map: Mutex<HashMap<PathBuf, VecDeque<Job>>>,
    active: AtomicUsize,
    stopping: AtomicBool,
}

impl Queues {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { map: Mutex::new(HashMap::new()), active: AtomicUsize::new(0), stopping: AtomicBool::new(false) })
    }

    /// Queue `job`; start the folder's worker if it has none.
    pub fn submit(self: &Arc<Self>, job: Job, runner: Arc<Runner>) {
        if self.stopping.load(Ordering::SeqCst) {
            if let Some(reply) = job.reply {
                let _ = reply.send(Err("quitting".into()));
            }
            return;
        }
        let folder = job.folder.clone();
        {
            let mut map = self.map.lock_ok();
            if let Some(queue) = map.get_mut(&folder) {
                coalesce(queue, job);
                return;
            }
            map.insert(folder.clone(), VecDeque::from([job]));
            self.active.fetch_add(1, Ordering::SeqCst);
        }
        let queues = Arc::clone(self);
        let spawned = std::thread::Builder::new().name("checkpoints".into()).spawn({
            let folder = folder.clone();
            move || queues.drain(&folder, &runner)
        });
        if spawned.is_err() {
            self.map.lock_ok().remove(&folder);
            self.active.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn drain(&self, folder: &Path, runner: &Runner) {
        loop {
            let next = {
                let mut map = self.map.lock_ok();
                let job = map.get_mut(folder).and_then(VecDeque::pop_front);
                if job.is_none() {
                    map.remove(folder);
                }
                job
            };
            let Some(job) = next else { break };
            if self.stopping.load(Ordering::SeqCst) {
                if let Some(reply) = job.reply {
                    let _ = reply.send(Err("quitting".into()));
                }
                continue;
            }
            (runner.run)(job);
        }
        if !self.stopping.load(Ordering::SeqCst) {
            (runner.idle)(folder);
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
    }

    /// Whether no folder has a worker running.
    pub fn is_idle(&self) -> bool {
        self.active.load(Ordering::SeqCst) == 0
    }

    /// Take no more work and wait up to `wait` for the running jobs.
    pub fn stop(&self, wait: Duration) {
        self.stopping.store(true, Ordering::SeqCst);
        let until = Instant::now() + wait;
        while self.active.load(Ordering::SeqCst) > 0 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn queues() -> &'static Arc<Queues> {
    static Q: OnceLock<Arc<Queues>> = OnceLock::new();
    Q.get_or_init(Queues::new)
}

static CTX: OnceLock<CoreCtx> = OnceLock::new();

pub fn set_ctx(ctx: CoreCtx) {
    let _ = CTX.set(ctx);
}

/// Announce a snapshot to the window.
pub fn emit<S: serde::Serialize>(payload: S) {
    if let Some(ctx) = CTX.get() {
        ctx.emit(super::EVENT, payload);
    }
}

fn runner() -> Arc<Runner> {
    static R: OnceLock<Arc<Runner>> = OnceLock::new();
    R.get_or_init(|| {
        Arc::new(Runner {
            run: Box::new(run_job),
            idle: Box::new(|folder| {
                let root = super::root();
                if let Err(e) = maintain(&root, folder) {
                    eprintln!("checkpoints: maintenance: {e}");
                }
            }),
        })
    })
    .clone()
}

/// Queue a snapshot for the real worker.
pub fn submit(job: Job) {
    queues().submit(job, runner());
}

pub fn stop(wait: Duration) {
    queues().stop(wait);
}

fn run_job(job: Job) {
    let root = super::root();
    let result = snapshot::snapshot(&root, &job.folder, job.kind, &job.who, job.prompt_at);
    match &result {
        Ok(row) => {
            super::announce(&job.who.tab_uid, &row.id, row.kind);
            if let Err(e) = prune(&root, &job.folder) {
                eprintln!("checkpoints: prune: {e}");
            }
        }
        Err(e) => eprintln!("checkpoints: snapshot of {}: {e}", job.folder.display()),
    }
    if let Some(reply) = job.reply {
        let _ = reply.send(result);
    }
}

fn prune(root: &Path, folder: &Path) -> Result<(), String> {
    let store = Store::for_folder(root, folder)?;
    let _lock = store.lock()?;
    super::prune_locked(&store, crate::clock::now_ms()).map(|_| ())
}

/// Repack when the folder's worker has nothing left to do.
fn maintain(root: &Path, folder: &Path) -> Result<(), String> {
    let store = Store::for_folder(root, folder)?;
    if !store.git_dir().is_dir() {
        return Ok(());
    }
    let _lock = store.lock()?;
    super::gc_locked(&store).map(|_| ())
}
