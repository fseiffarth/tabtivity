//! Tabtivity's Tauri-free core (docs/tabtivity_hosted_plan.md §3.2).
//!
//! Every host — the desktop app in `src-tauri/`, later the per-user daemon —
//! links this crate and supplies the two things it does not have: a
//! [`CoreState`] of managed singletons and an [`EventSink`] that reaches its
//! clients. Command bodies and services take a [`CoreCtx`] built from those
//! and never a Tauri type. What has moved here so far is listed in
//! `docs/hosted_handoff.md` (P1); the rest of the services and the command
//! bodies still live in `src-tauri/src` and migrate one file at a time.

pub mod brand;
pub mod ctx;
pub mod rt;
pub mod services;
pub mod sync;

pub use ctx::{Caller, ClientId, CoreCtx, CoreState, EventSink, NullEvents, RecordingEvents};
