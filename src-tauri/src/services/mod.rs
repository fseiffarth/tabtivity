pub mod agent_prompts;
pub mod agent_session;
// The turn state an agent's own hooks report (working / decision / done),
// relayed from the hook script's per-tab record to the window's activity
// store — the authority for the tab's working and finished marks.
pub mod agent_turn;
// The stored conversation behind an agent tab (Claude's session log, Codex's
// rollout) as the prompt/answer entries the phone's Focus view lays out.
pub mod agent_transcript;
// The files that conversation changed, as the diffs its CLI recorded — the
// desktop Reader's Changes panel.
pub mod agent_changes;
pub mod agent_bin;
pub mod agent_tasks;
pub mod schedule_mcp;
// Agent-requested pushes: the `/mcp/git` lane, its policy, the fenced
// tokenless preflight and the hooks-off host transport.
pub mod git_push_mcp;
pub mod git_release;
pub mod git_ci;
pub mod help_mcp;
pub mod markup_mcp;
// The Undo of a PDF markup round that applied the marks directly: git-tree
// snapshots of the work tree in the round's own object store under the state
// dir, reverse-applied only when nothing changed since.
pub mod markup_rounds;
pub mod schedule_usage;
// One agent CLI's own usage panel (Claude's `/usage`), read in print mode
// without a tab: recipe table, envelope parsing, and the short-lived cache
// that keeps a phone reopening the status sheet from spawning a CLI each
// time.
pub mod agent_usage;
// Which release of each agent CLI is installed vs. the one Tabtivity's parsers
// were checked against: the version recipes, the "verified against" notes from
// docs/third_party_update_checklist.md as data, and the day-long probe cache.
pub mod agent_versions;
pub mod agent_latest;
// Default-on Linux filesystem boundary for local agent tabs.  The authority
// decision and root computation stay AppHandle-free; terminal spawn only applies
// the resulting bubblewrap argv.
pub mod agent_fence;
// Landlock's abstract-socket scope (X11, D-Bus) the fence enters before bwrap.
#[cfg(target_os = "linux")]
pub mod fence_scope;
// `--agent-exec`: an agent's secrets mapped from their app-named carriers to
// the CLI's own variable names, just before the agent runs (no common name on
// the user's tmux server).
pub mod agent_exec;
// The Claude credential mirror: one Tabtivity-owned inode mounted into every
// fenced/contained tab in place of `~/.claude/.credentials.json`, kept in step
// with the host file by in-place writes — a file bind mount pins an inode, and
// Claude rotates that file by rename.
pub mod agent_auth;
// Provider API keys (keychain) handed to the CLIs the user switched on, at spawn.
pub mod agent_api_keys;
pub mod api_proxy;
pub mod api_meter;
pub mod api_prices;
pub mod api_usage;
pub mod agent_global;
pub mod agent_hint;
pub mod agent_home;
pub mod agent_install;
pub mod agent_shim;
// Copilot CLI sign-in for fenced tabs: Tabtivity keeps the token in its own
// keyring entry (the fence hides the keyring) and hands it to each fenced
// Copilot as COPILOT_GITHUB_TOKEN.
pub mod copilot_auth;
// "Check for a new Tabtivity" against the GitHub releases page: version compare,
// per-platform asset pick, staged download, per-platform install.
pub mod app_update;
pub mod big_folders;
// Ask-once approval for project-supplied programs Tabtivity runs on the host
// (git hooks, latexmkrc, a project's own prettier), re-asked when they change.
pub mod exec_trust;
// In-app browser (TODO J #61): reader-mode fetch+sanitize, the live-page window
// registry, and download quarantine. See docs/browser_plan_{b,c}.md.
pub mod brand_migration;
pub mod browser_engine;
// CalDAV accounts (docs/caldav_plan.md): the WebDAV transport half. Hand-rolled
// on reqwest + roxmltree; iCalendar itself is still parsed by src/lib/calendar/ics.ts.
pub mod caldav;
// Recurrence expansion and to-do board routing, the backend twins of
// `src/lib/calendar/recurrence.ts` and `src/lib/todoBoard.ts`, so the Mobile
// sidecar answers a month and the board with no window (headless owner, H0).
pub mod calendar_recurrence;
pub mod todo_board;
// What the phone's composer may attach from the desktop: recent screenshots and
// pictures by opaque id, copied into the project inbox on request.
pub mod desktop_images;
// What the background "Tabtivity (dev)" freeze (`scripts/package-dev-auto.sh`) is
// doing, read from that script's own state files for the header's dev-build
// chip. Compiled to "no chip" unless the binary was built from a checkout.
pub mod dev_build;
// The checkout's `todo/*.md` groups for the dev build's side-panel Todo view.
pub mod dev_todo;
pub mod codex_bind;
// Codex's own SQLite thread store (`~/.codex/state_<n>.sqlite`), read
// read-only for the model a Codex tab is running now that its releases
// no longer write the JSONL rollout the model tag used to come from.
pub mod codex_store;
pub mod copilot;
pub mod git_credentials;
// Bounded local git runs: FIFO pre-check + timeout that reaps the subtree (#2349).
pub mod git_bounded;
// The `.git` control files a sandbox keeps its occupant from writing (#158).
pub mod git_guard;
// The default branch (`main`) for repositories Tabtivity creates, and the
// unpublished-`master` rename that runs just before a publish.
pub mod git_init;
pub mod git_peer;
// Directory-handle-relative I/O inside agent-writable homes: what every
// unfenced write into a scope home goes through.
pub mod home_io;
pub mod hpc_mode;
// Which IDE a project tree belongs to (`.idea/`, `.vs/` + `*.sln`, `.vscode/`)
// and which installed program opens it — never one named inside the tree.
pub mod ide_detect;
pub mod local_loss;
// Local-model mail assistant (Group Q, #203–#208): the loopback-only /api/chat
// helper, prompt builders and defensive JSON parsers. AI never touches the net.
pub mod mail_ai;
// A root agent's `attach` on a mail draft: project files resolved under the
// same-roots rule and read without following a link (`docs/mail_mcp_attachments_plan.md`).
pub mod mail_attach;
pub mod mail_authres;
// The mail client's address book: cards, lists, collected addresses, vCard.
pub mod mail_contacts;
pub mod mail_crypt;
// Who may touch a file on Windows: `restrict_to_owner` (icacls, the Windows
// spelling of a 0600 key/state file) and `admin_locked` (the trusted-helper
// check of `paths::system_executable`). Pure SID/ACL decisions, tested
// everywhere.
pub mod private_file;
pub mod mail_crypto;
pub mod mail_engine;
pub mod mail_filters;
pub mod mail_pgp;
pub mod mail_reader;
pub mod mail_sanitize;
pub mod mail_store;
// Thunderbird address books (abook/history.sqlite), read from a temp copy.
pub mod mail_thunderbird;
pub mod mobile_control;
pub mod net_usage;
pub mod opencode_store;
pub mod openvpn;
pub mod project_runtime;
pub mod prompt_blame;
pub mod remote;
pub mod remote_agents;
pub mod remote_credentials;
pub mod remote_sync;
pub mod remote_usage;
pub mod restore_service;
pub mod root_mcp;
pub mod root_mcp_security;
pub mod root_mcp_import;
pub mod root_mcp_mail;
pub mod root_mcp_review;
// The project container bind-mounts host paths straight into a Linux container
// and maps the host uid/gid, so it is Unix-only today *at runtime*: Windows
// refuses at the `pty_spawn` call site (and `up_for_project` no-ops) rather
// than running a tab unwrapped. The module itself compiles everywhere — the
// kill/lifecycle seams (PtyRegistry, project switch, app exit) call into it
// unconditionally.
pub mod sandbox;
pub mod sftp;
// Spreadsheet parsing in a limited child process of the main binary.
pub mod sheet_reader;
pub mod skills;
// Dictionary-backed (Hunspell/spellbook) spell check for the native editors.
pub mod spell;
pub mod ssh_common;
pub mod ssh_exec;
pub mod state_gc;
pub mod sync_auto;
pub mod terminal_service;
pub mod tmux_local;
// The launch assembly `pty_spawn` and the sidecar's headless spawn share
// (headless owner plan, H1b).
pub mod launch_prep;
// The shared tab set with a version and per-operation merge (headless owner
// plan, H1): what `save_tab_layout`'s whole-snapshot write became.
pub mod workspace;
// The single-client timer lease (headless owner plan, H2, interim): one
// window fires schedules, alarms and syncs at a time.
pub mod timer_lease;
// Calendar reminders' due set and their cross-process fired record (headless
// owner plan, H2): the window claims before showing, the sidecar pushes with
// no window open.
pub mod calendar_alarms;
pub mod token_stats;
// The UI's main threads (this process's, each renderer's) asked to rtkit for
// nice -10, so the work agent tabs start cannot outrank typing.
#[cfg(target_os = "linux")]
pub mod ui_priority;
pub mod usage_stats;
// Project VMs (`docs/vm_projects_plan.md`): the third trust tier — the whole
// project inside a hardware-accelerated QEMU guest (KVM on Linux, HVF on
// macOS, WHPX on Windows) reached only over SSH/SFTP (no shared filesystem),
// plus its allowlisting egress proxy and the built-in cloud-init seed writer.
pub mod iso9660;
pub mod vm;
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
// GPU video decoders demoted while the DMA-BUF renderer is off, so the media
// viewer's frames decode where the software painter can draw them. Installed
// before the first webview, stripped from spawned children.
pub mod webkit_video;

// Privilege-free directory links on Windows (junctions via `mklink /J`),
// shared by box member links, the state-dir migration and project import.
pub mod win_links;
pub mod window_service;
pub mod window_state;
pub mod worker_sync;

pub mod text_completion;
