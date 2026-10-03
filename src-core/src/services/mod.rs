//! The services that have moved out of `src-tauri` so far (hosted plan §3.2).
//! A module lands here once nothing it reaches is still in the desktop crate;
//! the desktop's `services/mod.rs` re-exports each one, so `crate::services::…`
//! paths there keep resolving.

pub mod schedule_usage;
// One agent CLI's own usage panel (Claude's `/usage`), read in print mode
// without a tab: recipe table, envelope parsing, and the short-lived cache
// that keeps a phone reopening the status sheet from spawning a CLI each
// time.
pub mod agent_usage;
// Landlock's abstract-socket scope (X11, D-Bus) the fence enters before bwrap:
// Linux-only code (`libc`, `CommandExt::exec`), gated here as the desktop's
// `services/mod.rs` gates its re-export.
#[cfg(target_os = "linux")]
pub mod fence_scope;
pub mod big_folders;
// The `.git` control files a sandbox keeps its occupant from writing (#158).
pub mod git_guard;
pub mod remote_agents;
pub mod vm_proxy;
// Shared web-safety primitives (URL policy, host display, filename sanitizing)
// used by BOTH the mail client and the in-app browser. `mail_sanitize`
// re-exports what it used to own.
pub mod web_safety;
// The WebKitGTK accessibility (AT-SPI) opt-out: WebKit 2.48's ATSPI text
// handler aborts the whole web process on an out-of-range offset, which a
// continuously rewriting UI hands it routinely. Installed before the first
// webview, stripped from spawned children.
pub mod webkit_a11y;
pub mod text_completion;
