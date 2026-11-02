//! The `agent` group of `services/`: every module here is re-exported from
//! `services/mod.rs`, so `crate::services::<module>` keeps resolving.

// Provider API keys (keychain) handed to the CLIs the user switched on, at spawn.
pub mod agent_api_keys;
// The Claude credential mirror: one Tabtivity-owned inode mounted into every
// fenced/contained tab in place of `~/.claude/.credentials.json`, kept in step
// with the host file by in-place writes — a file bind mount pins an inode, and
// Claude rotates that file by rename.
pub mod agent_auth;
pub mod agent_bin;
// The files that conversation changed, as the diffs its CLI recorded — the
// desktop Reader's Changes panel.
pub mod agent_changes;
pub mod agent_defaults;
pub mod agent_chats;
// `--agent-exec`: an agent's secrets mapped from their app-named carriers to
// the CLI's own variable names, just before the agent runs (no common name on
// the user's tmux server).
pub mod agent_exec;
// What a live agent tab was handed (sandbox, MCP servers, skills, API key),
// for the tab hover card.
pub mod agent_features;
// Default-on Linux filesystem boundary for local agent tabs.  The authority
// decision and root computation stay AppHandle-free; terminal spawn only applies
// the resulting bubblewrap argv.
pub mod agent_fence;
pub mod agent_global;
pub mod agent_hint;
// Where each CLI keeps its conversations in an agent home, for export/import.
pub mod agent_history;
pub mod agent_home;
pub mod agent_install;
pub mod agent_latest;
pub mod agent_prompts;
// The built-in agent-CLI registry (`AGENTS`) and its lookups.
pub mod agent_registry;
// An agent tab's conversation taken along to another worktree (the Reader's
// branch chip).
pub mod agent_relocate;
pub mod agent_session;
pub mod agent_shim;
pub mod agent_sqlite;
pub mod agent_tasks;
// The stored conversation behind an agent tab (Claude's session log, Codex's
// rollout) as the prompt/answer entries the phone's Focus view lays out.
pub mod agent_transcript;
// The turn state an agent's own hooks report (working / decision / done),
// relayed from the hook script's per-tab record to the window's activity
// store — the authority for the tab's working and finished marks.
pub mod agent_turn;
// Which release of each agent CLI is installed vs. the one Tabtivity's parsers
// were checked against: the version recipes, the "verified against" notes from
// docs/third_party_update_checklist.md as data, and the day-long probe cache.
pub mod agent_versions;
// One overview of the CLIs in use: plan, account, usage windows
// (docs/cli_overview_plan.md).
pub mod cli_overview;
pub mod codex_bind;
// Codex's release package, fetched ahead of its installer with no deadline and
// a resumable `.part`; the installer's own download has neither.
#[cfg(unix)]
pub mod codex_package;
// Codex's own SQLite thread store (`~/.codex/state_<n>.sqlite`), read
// read-only for the model a Codex tab is running now that its releases
// no longer write the JSONL rollout the model tag used to come from.
pub mod codex_store;
// Copilot CLI sign-in for fenced tabs: Tabtivity keeps the token in its own
// keyring entry (the fence hides the keyring) and hands it to each fenced
// Copilot as COPILOT_GITHUB_TOKEN.
pub mod copilot_auth;
// Copilot CLI's own session store: the tab's pinned session, its events, its
// folder's chats (the Reader's chat, Diffs and Resume menu).
pub mod copilot_session;
pub mod opencode_models;
pub mod opencode_session;
pub mod opencode_store;
pub mod google_chat;
// Change notifications for the transcripts the desktop Reader shows.
pub mod transcript_watch;
// The chat assistant's profiles, system prompt and chat folder (docs/assistant_plan.md).
pub mod assistant;
// Claude's own `/model` list for the assistant's chats, read by a short-lived probe.
pub mod assistant_model_probe;
// The rows each CLI's own model picker last drew, per installed build.
pub mod model_rows;
