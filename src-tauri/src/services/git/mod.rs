//! The `git` group of `services/`: every module here is re-exported from
//! `services/mod.rs`, so `crate::services::<module>` keeps resolving.

// Bounded local git runs: FIFO pre-check + timeout that reaps the subtree (#2349).
pub mod git_bounded;
pub mod git_ci;
pub mod git_credentials;
// The `.git` control files a sandbox keeps its occupant from writing (#158);
// back in this crate since #2347 gave it `home_io`.
pub mod git_guard;
// How Tabtivity runs git: the hardened builder, `run_git`, push/clone transport.
pub mod git_hardened;
// Which hosting credentials apply to a project, and where a token may go.
pub mod git_hosting;
// The default branch (`main`) for repositories Tabtivity creates, and the
// unpublished-`master` rename that runs just before a publish.
pub mod git_init;
pub mod git_peer;
pub mod git_release;
