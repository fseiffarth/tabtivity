//! Window/project/editor-owned reservations. Cancellation can arrive while a
//! server is starting, before a document opens or before the RPC id exists.
use std::collections::HashMap;
use app_core::sync::LockExt;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::watch;

struct Request { owner: String, created: Instant, started: bool, cancel: watch::Sender<bool> }
fn requests() -> &'static Mutex<HashMap<String, Request>> {
    static REQUESTS: OnceLock<Mutex<HashMap<String, Request>>> = OnceLock::new();
    REQUESTS.get_or_init(Default::default)
}

pub fn reserve(owner: String) -> Result<String, String> {
    let mut map = requests().lock_ok();
    map.retain(|_, request| request.started || request.created.elapsed() < Duration::from_secs(60));
    if map.len() >= 128 { return Err("copilot_request_limit".into()); }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed).to_string();
    let (cancel, _) = watch::channel(false);
    map.insert(id.clone(), Request { owner, created: Instant::now(), started: false, cancel });
    Ok(id)
}

pub struct RequestLease { id: String, pub signal: watch::Receiver<bool> }
impl Drop for RequestLease {
    fn drop(&mut self) { requests().lock_ok().remove(&self.id); }
}

pub fn start(owner: &str, id: &str) -> Result<RequestLease, String> {
    let mut map = requests().lock_ok();
    let request = map.get_mut(id).filter(|request| request.owner == owner && !request.started)
        .ok_or("copilot_cancelled")?;
    request.started = true;
    Ok(RequestLease { id: id.to_owned(), signal: request.cancel.subscribe() })
}

pub fn cancel(owner: &str, id: &str) {
    let mut map = requests().lock_ok();
    if map.get(id).is_some_and(|request| request.owner == owner) { map.remove(id); }
}

pub fn cancel_owner(owner: &str) {
    requests().lock_ok().retain(|_, request| request.owner != owner);
}

pub fn cancel_all() { requests().lock_ok().clear(); }

/// Synchronous form, for the points where an await must not be abandoned.
pub fn is_cancelled(signal: &watch::Receiver<bool>) -> bool {
    *signal.borrow() || signal.has_changed().unwrap_or(true)
}

pub async fn cancelled(signal: &mut watch::Receiver<bool>) {
    if *signal.borrow() { return; }
    let _ = signal.changed().await; // sender drop cancels too
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn early_cancel_and_wrong_window_never_start_work() {
        let id = reserve("window-a/project/editor".into()).unwrap();
        assert!(start("window-b/project/editor", &id).is_err());
        cancel("window-b/project/editor", &id);
        let mut lease = start("window-a/project/editor", &id).unwrap();
        assert!(start("window-a/project/editor", &id).is_err());
        cancel("window-a/project/editor", &id);
        tokio::time::timeout(Duration::from_millis(100), cancelled(&mut lease.signal)).await.unwrap();
        let early = reserve("early".into()).unwrap();
        cancel("early", &early);
        assert!(start("early", &early).is_err());
    }
    #[tokio::test]
    async fn cancelling_old_request_leaves_replacement_alive() {
        let old = reserve("replacement".into()).unwrap();
        let new = reserve("replacement".into()).unwrap();
        let mut old_lease = start("replacement", &old).unwrap();
        let new_lease = start("replacement", &new).unwrap();
        cancel("replacement", &old);
        cancelled(&mut old_lease.signal).await;
        assert!(new_lease.signal.has_changed().is_ok());
    }
}
