//! The async runtime the core spawns on, whoever owns it.
//!
//! The desktop app's runtime belongs to Tauri (`tauri::async_runtime`), the
//! daemon's to its own `main`. Core code calls `rt::spawn` / `rt::spawn_blocking`
//! / `rt::block_on` and never names either — the mechanical swap §3.2 of the
//! hosted plan asks for. A host installs its handle once at startup
//! (`install`); until then, or when nothing installs one (a unit test), a call
//! runs on the current runtime if there is one and otherwise on a private
//! runtime built on first use — the same lazy behaviour Tauri's wrapper had, so
//! no caller gains a new way to panic.

use std::future::Future;
use std::sync::OnceLock;

use tokio::runtime::{Builder, Handle, Runtime};
use tokio::task::JoinHandle;

static INSTALLED: OnceLock<Handle> = OnceLock::new();

/// Make `handle` the runtime every later `spawn` lands on. The first call
/// wins; a second is ignored and reported, since two hosts in one process is
/// a bug.
pub fn install(handle: Handle) -> bool {
    INSTALLED.set(handle).is_ok()
}

fn fallback() -> &'static Runtime {
    static FALLBACK: OnceLock<Runtime> = OnceLock::new();
    FALLBACK.get_or_init(|| {
        Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("rt: build the fallback tokio runtime")
    })
}

/// The runtime handle: the installed one, else the current thread's, else the
/// lazily built fallback.
pub fn handle() -> Handle {
    if let Some(h) = INSTALLED.get() {
        return h.clone();
    }
    if let Ok(h) = Handle::try_current() {
        return h;
    }
    fallback().handle().clone()
}

/// Spawn a future on the host's runtime, from any thread.
pub fn spawn<F>(task: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(task)
}

/// Run blocking work on the runtime's blocking pool, from any thread.
pub fn spawn_blocking<F, R>(func: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    handle().spawn_blocking(func)
}

/// Drive a future to completion on the current thread. Like tokio's own
/// `Handle::block_on`, this must not be called from inside a runtime worker —
/// it is for plain threads (a watcher thread, a startup step).
pub fn block_on<F: Future>(task: F) -> F::Output {
    handle().block_on(task)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_works_without_an_installed_runtime() {
        // No runtime is current on a plain test thread: the fallback serves.
        let out = block_on(async { spawn(async { 40 + 2 }).await.unwrap() });
        assert_eq!(out, 42);
        let blocking = block_on(spawn_blocking(|| 7)).unwrap();
        assert_eq!(blocking, 7);
    }

    #[tokio::test]
    async fn spawn_inside_a_runtime_lands_on_it() {
        // Nothing installed: the current runtime is used, so the spawned task
        // can be awaited from this one.
        assert_eq!(spawn(async { 1 }).await.unwrap(), 1);
        assert_eq!(spawn_blocking(|| 2).await.unwrap(), 2);
    }
}
