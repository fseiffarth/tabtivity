//! Tabtivity Mobile's AppHandle-free control plane.
//!
//! The sidecar reads only the state-dir project/session snapshots, resolves all
//! client ids through a keyed catalog, and attaches only to exact tmux sessions
//! discovered locally. Tauri-specific lifecycle and event routing live in
//! `commands::mobile_control`.

pub mod admin;
pub mod alarms;
pub mod auth;
pub mod config;
pub mod discovery;
pub mod files;
pub mod git_overview;
pub mod headless;
pub mod headless_board;
pub mod host;
pub mod inbox;
pub mod live_pwa;
pub mod markup;
pub mod markup_pdf;
pub mod outbox;
pub mod limits;
pub mod protocol;
pub mod pty_bridge;
pub mod scheduler;
pub mod push;
pub mod sign_in;
pub mod store;

// The bundle baked in at compile time, when it was built, and the directory a
// dev build may serve a newer one from. Included here rather than in `host`
// because `live_pwa` needs the timestamp and the path, and `host` needs the
// assets; a shared parent is the one place neither has to reach into the
// other.
include!(concat!(env!("OUT_DIR"), "/mobile_assets.rs"));
