//! The host-neutral context a command body or a service gets in place of a
//! Tauri handle (docs/tabtivity_hosted_plan.md §3.2).
//!
//! `CoreCtx` is a concrete type, not a trait: command bodies compile once, and
//! every host — the desktop app, the per-user daemon — builds one from the two
//! things it owns, a [`CoreState`] (the managed singletons) and an
//! [`EventSink`] (how events reach its clients). Nothing in this crate knows
//! what a window is.

use std::any::{type_name, Any, TypeId};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use serde::Serialize;

// ── Clients ───────────────────────────────────────────────────────────────

/// One connected client of the host. On the desktop it is a Tauri window's
/// label (`main`, `detached-…`); on a server it is a connection's id. Opaque
/// to the core, which only ever hands it back to the sink that minted it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ClientId(String);

impl ClientId {
    /// The desktop's primary window, as `tauri.conf.json` labels it. The one
    /// client the core may assume exists while it runs inside the desktop app.
    pub const MAIN: &'static str = "main";

    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn main() -> Self {
        Self(Self::MAIN.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_main(&self) -> bool {
        self.0 == Self::MAIN
    }
}

impl fmt::Display for ClientId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for ClientId {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

impl From<String> for ClientId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

/// Who asked. A command body that must know *which* client it serves — the
/// viewer identity of `pty_set_visible`, the window `complete_text` answers —
/// reads it here instead of from a Tauri `Window`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Caller {
    /// The host itself: startup, a background task, an exit hook. No client.
    System,
    /// A window of the desktop app, by label.
    Local(ClientId),
    /// A client of a server host: a browser or the phone (P2+).
    Client(ClientId),
}

impl Caller {
    /// The client behind the call, if any.
    pub fn client(&self) -> Option<&ClientId> {
        match self {
            Caller::System => None,
            Caller::Local(c) | Caller::Client(c) => Some(c),
        }
    }
}

// ── Events ────────────────────────────────────────────────────────────────

/// Where a host delivers the events the core raises. Payloads arrive
/// serialized **once**, by [`EventSink::emit`] — a host that speaks JSON anyway
/// (Tauri's `emit_str`, a WebSocket text frame) forwards the string as it is,
/// so the terminal's output stream pays no second serialization.
///
/// Delivery is best-effort by contract: a client that is gone, a window with
/// no listener, is not an error, and no method returns one.
pub trait EventSink: Send + Sync {
    /// Broadcast `event` to every client.
    fn emit_json(&self, event: &str, payload: String);

    /// Deliver `event` to one client only. An unknown client drops it.
    fn emit_json_to(&self, client: &ClientId, event: &str, payload: String);
}

impl dyn EventSink {
    /// Serialize `payload` and broadcast it. Same shape as Tauri's `emit`, so
    /// a call site converts by swapping the receiver.
    pub fn emit<S: Serialize>(&self, event: &str, payload: S) {
        match serde_json::to_string(&payload) {
            Ok(json) => self.emit_json(event, json),
            Err(e) => eprintln!("events: serialize {event}: {e}"),
        }
    }

    /// Serialize `payload` and deliver it to one client.
    pub fn emit_to<S: Serialize>(&self, client: &ClientId, event: &str, payload: S) {
        match serde_json::to_string(&payload) {
            Ok(json) => self.emit_json_to(client, event, json),
            Err(e) => eprintln!("events: serialize {event}: {e}"),
        }
    }
}

/// A sink that drops everything. For a core run with no clients at all (a
/// unit test, a one-shot tool) — never a stand-in for a host's own sink.
pub struct NullEvents;

impl EventSink for NullEvents {
    fn emit_json(&self, _event: &str, _payload: String) {}
    fn emit_json_to(&self, _client: &ClientId, _event: &str, _payload: String) {}
}

/// A sink that keeps every event, in order, for a test to assert on.
#[derive(Default)]
pub struct RecordingEvents {
    events: Mutex<Vec<RecordedEvent>>,
}

/// One event a [`RecordingEvents`] saw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedEvent {
    /// `None` for a broadcast.
    pub client: Option<ClientId>,
    pub event: String,
    pub payload: String,
}

impl RecordingEvents {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Everything recorded so far, oldest first.
    pub fn take(&self) -> Vec<RecordedEvent> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    /// The payloads of every recorded `event`, parsed.
    pub fn payloads(&self, event: &str) -> Vec<serde_json::Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.event == event)
            .filter_map(|e| serde_json::from_str(&e.payload).ok())
            .collect()
    }
}

impl EventSink for RecordingEvents {
    fn emit_json(&self, event: &str, payload: String) {
        self.events.lock().unwrap().push(RecordedEvent {
            client: None,
            event: event.to_string(),
            payload,
        });
    }

    fn emit_json_to(&self, client: &ClientId, event: &str, payload: String) {
        self.events.lock().unwrap().push(RecordedEvent {
            client: Some(client.clone()),
            event: event.to_string(),
            payload,
        });
    }
}

// ── State ─────────────────────────────────────────────────────────────────

/// The managed singletons, one value per type — what Tauri's `.manage()` /
/// `State<'_, T>` held for the desktop, owned by the host instead and shared
/// with the core. Keyed by type so a singleton's type can stay where it is
/// defined while the command bodies that use it move; the hosts fill it at
/// startup (`manage`), the bodies read it (`get`).
///
/// A desktop host that also hands the same values to Tauri must pass *clones
/// of one `Arc`* to both, never two values: every managed type here is an
/// `Arc<…>` or wraps one, and a second instance is a silent split brain.
#[derive(Default)]
pub struct CoreState {
    items: HashMap<TypeId, Box<dyn Any + Send + Sync>>,
}

impl CoreState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `value` as the one instance of its type. Builder-style, so a
    /// host's startup reads as a list. Managing a type twice is a programming
    /// error and panics at once rather than letting one half win.
    pub fn manage<T: Any + Send + Sync>(mut self, value: T) -> Self {
        let was = self.items.insert(TypeId::of::<T>(), Box::new(value));
        assert!(was.is_none(), "CoreState: `{}` managed twice", type_name::<T>());
        self
    }

    /// The managed `T`, or `None` when the host never registered one.
    pub fn try_get<T: Any + Send + Sync>(&self) -> Option<&T> {
        self.items
            .get(&TypeId::of::<T>())
            .and_then(|b| b.downcast_ref::<T>())
    }

    /// The managed `T`. Panics when the host never registered one — the same
    /// contract as Tauri's `State<T>`, and like there a startup-order bug, not
    /// a runtime condition to handle.
    pub fn get<T: Any + Send + Sync>(&self) -> &T {
        self.try_get::<T>().unwrap_or_else(|| {
            panic!("CoreState: `{}` is not managed by this host", type_name::<T>())
        })
    }

    pub fn has<T: Any + Send + Sync>(&self) -> bool {
        self.items.contains_key(&TypeId::of::<T>())
    }
}

// ── The context ───────────────────────────────────────────────────────────

/// What a command body or a service gets in place of Tauri: the host's state,
/// its event sink, and who is calling. Cheap to clone (three handles), so a
/// background task takes one by value and keeps it for as long as it runs.
#[derive(Clone)]
pub struct CoreCtx {
    /// Every managed singleton; both hosts construct it.
    pub state: Arc<CoreState>,
    /// The host's events: `emit` broadcasts, `emit_to` targets one client.
    pub events: Arc<dyn EventSink>,
    /// Which client is asking; [`Caller::System`] for the host's own work.
    pub caller: Caller,
}

impl CoreCtx {
    pub fn new(state: Arc<CoreState>, events: Arc<dyn EventSink>, caller: Caller) -> Self {
        Self {
            state,
            events,
            caller,
        }
    }

    /// A context for the host's own work: startup, background tasks, exit.
    pub fn system(state: Arc<CoreState>, events: Arc<dyn EventSink>) -> Self {
        Self::new(state, events, Caller::System)
    }

    /// The same host, a different caller — how a host derives the context of
    /// one incoming call from the one it built at startup.
    pub fn with_caller(&self, caller: Caller) -> Self {
        Self {
            state: self.state.clone(),
            events: self.events.clone(),
            caller,
        }
    }

    /// The managed `T` (see [`CoreState::get`]).
    pub fn get<T: Any + Send + Sync>(&self) -> &T {
        self.state.get::<T>()
    }

    /// Broadcast an event to every client.
    pub fn emit<S: Serialize>(&self, event: &str, payload: S) {
        self.events.emit(event, payload);
    }

    /// Deliver an event to one client.
    pub fn emit_to<S: Serialize>(&self, client: &ClientId, event: &str, payload: S) {
        self.events.emit_to(client, event, payload);
    }

    /// Deliver an event to the calling client; a `System` caller gets a
    /// broadcast, since there is nobody more specific to answer.
    pub fn emit_to_caller<S: Serialize>(&self, event: &str, payload: S) {
        match self.caller.client() {
            Some(client) => self.events.emit_to(client, event, payload),
            None => self.events.emit(event, payload),
        }
    }
}

impl fmt::Debug for CoreCtx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CoreCtx")
            .field("caller", &self.caller)
            .field("managed", &self.state.items.len())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        project_id: &'static str,
    }

    fn ctx(events: Arc<dyn EventSink>, caller: Caller) -> CoreCtx {
        let state = CoreState::new().manage(Arc::new(Mutex::new(7u32)));
        CoreCtx::new(Arc::new(state), events, caller)
    }

    #[test]
    fn emit_serializes_once_and_broadcasts() {
        let rec = RecordingEvents::new();
        let ctx = ctx(rec.clone(), Caller::System);
        ctx.emit("git-peer-status", Payload { project_id: "p1" });
        let got = rec.take();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].client, None);
        assert_eq!(got[0].event, "git-peer-status");
        assert_eq!(got[0].payload, r#"{"projectId":"p1"}"#);
    }

    #[test]
    fn emit_to_caller_targets_the_client_or_broadcasts() {
        let rec = RecordingEvents::new();
        let win = ClientId::new("detached-1");
        ctx(rec.clone(), Caller::Local(win.clone())).emit_to_caller("done", ());
        ctx(rec.clone(), Caller::System).emit_to_caller("done", ());
        let got = rec.take();
        assert_eq!(got[0].client.as_ref(), Some(&win));
        assert_eq!(got[1].client, None);
        assert_eq!(rec.payloads("done").len(), 0, "take drained it");
    }

    #[test]
    fn state_is_keyed_by_type() {
        let ctx = ctx(Arc::new(NullEvents), Caller::System);
        assert_eq!(*ctx.get::<Arc<Mutex<u32>>>().lock().unwrap(), 7);
        assert!(ctx.state.try_get::<Arc<Mutex<u64>>>().is_none());
        assert!(!ctx.state.has::<String>());
    }

    #[test]
    #[should_panic(expected = "is not managed by this host")]
    fn an_unmanaged_type_panics_like_tauri_state() {
        let ctx = ctx(Arc::new(NullEvents), Caller::System);
        let _ = ctx.get::<String>();
    }

    #[test]
    #[should_panic(expected = "managed twice")]
    fn managing_a_type_twice_panics() {
        let _ = CoreState::new().manage(1u8).manage(2u8);
    }

    #[test]
    fn caller_client() {
        assert_eq!(Caller::System.client(), None);
        assert!(Caller::Local(ClientId::main()).client().unwrap().is_main());
        assert_eq!(
            Caller::Client("ws-3".into()).client().map(ClientId::as_str),
            Some("ws-3")
        );
        assert_eq!(ClientId::main().to_string(), "main");
    }

    #[test]
    fn with_caller_keeps_the_host() {
        let rec = RecordingEvents::new();
        let system = ctx(rec.clone(), Caller::System);
        let call = system.with_caller(Caller::Local(ClientId::main()));
        assert!(Arc::ptr_eq(&system.state, &call.state));
        call.emit_to_caller("x", 1);
        assert_eq!(rec.take()[0].client, Some(ClientId::main()));
    }
}
