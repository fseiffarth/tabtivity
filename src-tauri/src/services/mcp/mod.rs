//! The `mcp` group of `services/`: every module here is re-exported from
//! `services/mod.rs`, so `crate::services::<module>` keeps resolving.

pub mod schedule_mcp;
// Agent-requested pushes: the `/mcp/git` lane, its policy, the fenced
// tokenless preflight and the hooks-off host transport.
pub mod git_push_mcp;
pub mod help_mcp;
pub mod cockpit_mcp;
pub mod markup_mcp;
// Agent print requests, approved in the window's print preview.
pub mod print_mcp;
// Per-project switches for the lanes above (`projects.json` `mcp_off`).
pub mod project_lanes;
// Messages between the agent tabs of one project (`/mcp/tabs`).
pub mod tabs_mcp;
// The chat assistant's guarded web lane (docs/done/assistant_plan.md, A2).
pub mod web_lane;
