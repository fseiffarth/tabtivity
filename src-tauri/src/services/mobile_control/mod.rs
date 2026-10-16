//! Tabtivity Mobile's AppHandle-free control plane.
//!
//! The sidecar reads only the state-dir project/session snapshots, resolves all
//! client ids through a keyed catalog, and attaches only to exact tmux sessions
//! discovered locally. Tauri-specific lifecycle and event routing live in
//! `commands::mobile_control`.

pub mod admin;
pub mod alarms;
pub mod assistant;
pub mod auth;
pub mod chat_uncommitted;
pub mod config;
pub mod discovery;
pub mod files;
pub mod git_overview;
pub mod headless;
pub mod headless_board;
pub mod host;
pub mod inbox;
pub mod local_models;
pub mod markup;
pub mod markup_pdf;
pub mod outbox;
pub mod phone_origin;
pub mod limits;
pub mod protocol;
pub mod pty_bridge;
pub mod scheduler;
pub mod push;
pub mod sign_in;
pub mod store;
pub mod uploads;
// The browser desktop client's transport (hosted plan §3.5, §10 P2).
pub mod web_client;

// The bundle baked in at compile time: the only phone app any build serves
// (the dev-only `live_pwa` overlay read a fence-writable folder and is gone,
// threat recheck 2026-10-08 gap 20).
include!(concat!(env!("OUT_DIR"), "/mobile_assets.rs"));
