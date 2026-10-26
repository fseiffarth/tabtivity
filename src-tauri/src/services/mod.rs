pub mod api;
pub use api::{api_meter, api_prices, api_proxy, api_proxy_port, api_usage};
pub mod agent;
pub use agent::{agent_api_keys, agent_auth, agent_bin, agent_changes, agent_chats, agent_exec, agent_features, agent_fence, agent_global, agent_hint, agent_history, agent_home, agent_install, agent_latest, agent_prompts, agent_relocate, agent_session, agent_shim, agent_sqlite, agent_tasks, agent_transcript, agent_turn, agent_versions, assistant, assistant_model_probe, codex_bind, codex_store, copilot_auth, copilot_session, google_chat, model_rows, opencode_models, opencode_session, opencode_store, transcript_watch};
pub mod git;
pub use git::{git_bounded, git_ci, git_credentials, git_guard, git_init, git_peer, git_release};
pub mod mail;
pub use mail::{mail_ai, mail_attach, mail_authres, mail_contacts, mail_crypt, mail_crypto, mail_engine, mail_filters, mail_pgp, mail_reader, mail_rekey, mail_sanitize, mail_store, mail_thunderbird};
// One shared, at-most-a-second-old reading of the process table for the
// background loops that each walked `/proc` on their own timer.
pub mod proc_table;
pub mod schedule_mcp;
// Agent-requested pushes: the `/mcp/git` lane, its policy, the fenced
// tokenless preflight and the hooks-off host transport.
pub mod git_push_mcp;
pub mod help_mcp;
// The chat assistant's guarded web lane (docs/assistant_plan.md, A2).
pub mod web_lane;
pub use app_core::services::schedule_usage;
pub use app_core::services::agent_usage;
pub mod markup_mcp;
// The Undo of a PDF markup round that applied the marks directly: git-tree
// snapshots of the work tree in the round's own object store under the state
// dir, reverse-applied only when nothing changed since.
pub mod markup_rounds;
// Landlock's abstract-socket scope (X11, D-Bus) the fence enters before bwrap.
#[cfg(target_os = "linux")]
pub use app_core::services::fence_scope;
// The AI switch: the side panel's power button, read by every AI gate.
pub mod ai_switch;
// "Check for a new Tabtivity" against the GitHub releases page: version compare,
// per-platform asset pick, staged download, per-platform install.
pub mod app_update;
pub use app_core::services::big_folders;
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
pub mod copilot;
// Directory-handle-relative I/O inside agent-writable homes: what every
// unfenced write into a scope home goes through.
pub mod home_io;
// Folder copy for the file tree: no link below the top level is followed, no
// special file is read, and bytes and entries are bounded.
pub mod tree_copy;
pub mod hpc_mode;
// Which IDE a project tree belongs to (`.idea/`, `.vs/` + `*.sln`, `.vscode/`)
// and which installed program opens it — never one named inside the tree.
pub mod ide_detect;
pub mod local_loss;
// Who owns a loopback listener (`/proc/net/tcp{,6}`, Linux): Ollama, the API
// proxy's remembered port and the phone's sign-in relay judge the owner, not
// the address.
pub mod loopback_owner;
// Hosted plan §3.3: every registered Tauri command's class (core / client /
// admin / off) and the test that fails when one is added without a row.
pub mod command_class;
// Hosted plan §10 P2: the generated `core` dispatcher a server host answers a
// browser's `invoke` with, the class check in front of it, and
// `server_capabilities`.
pub mod core_dispatch;
// Hosted plan §3.3: the admin-allowed model list a browser client's
// completion / local-model requests are held to before they reach Ollama.
pub mod model_allowlist;
// Hosted plan §3.5: a picked server file as a single-use grant, so the mail
// commands never take a frontend path even in the browser client.
pub mod pick_grants;
// Server mode: the per-user daemon behind the gateway (hosted plan §10 P3).
pub mod server;
// Who may touch a file on Windows: `restrict_to_owner` (icacls, the Windows
// spelling of a 0600 key/state file) and `admin_locked` (the trusted-helper
// check of `paths::system_executable`). Pure SID/ACL decisions, tested
// everywhere.
pub mod private_file;
// Connect to a server (hosted plan §7.2, P5): pairing, sign-in and the
// desktop socket a Connect window is bridged to.
pub mod connect;
pub mod mobile_control;
pub mod net_usage;
pub mod openvpn;
pub mod process_lease;
pub mod project_runtime;
pub mod prompt_blame;
pub mod remote;
pub use remote::{remote_credentials, remote_sync, remote_transcript, remote_usage, sftp, ssh_common, ssh_exec, sync_auto, sync_op, tar_stream, worker_sync};
pub use app_core::services::remote_agents;
pub mod restore_service;
pub mod root_mcp;
pub use root_mcp::{root_mcp_import, root_mcp_mail, root_mcp_review, root_mcp_security};
// The project container bind-mounts host paths straight into a Linux container
// and maps the host uid/gid, so it is Unix-only today *at runtime*: Windows
// refuses at the `pty_spawn` call site (and `up_for_project` no-ops) rather
// than running a tab unwrapped. The module itself compiles everywhere — the
// kill/lifecycle seams (PtyRegistry, project switch, app exit) call into it
// unconditionally.
pub mod sandbox;
// Spreadsheet parsing in a limited child process of the main binary.
pub mod sheet_reader;
pub mod skills;
// Dictionary-backed (Hunspell/spellbook) spell check for the native editors.
pub mod spell;
pub mod state_gc;
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
// The desktop's speech engine (docs/desktop_voice_plan.md): the microphone,
// whisper and read-aloud belong to the machine the user sits at, so the
// daemon's build leaves it out.
#[cfg(feature = "desktop")]
pub mod voice;
pub use app_core::services::vm_proxy;
pub use app_core::services::web_safety;
pub use app_core::services::webkit_a11y;
// GPU video decoders demoted while the DMA-BUF renderer is off, so the media
// viewer's frames decode where the software painter can draw them. Installed
// before the first webview, stripped from spawned children.
pub mod webkit_video;
// Whether the window starts on WebKit's GPU paint path (the experimental
// `gpu_compositing` setting), and the 2D-canvas switch every webview gets.
pub mod webkit_gpu;

// Privilege-free directory links on Windows (junctions via `mklink /J`),
// shared by box member links, the state-dir migration and project import.
pub mod win_links;
pub mod window_service;
pub mod window_state;

pub use app_core::services::text_completion;
// One FIFO worker thread: the state-file commands' way off the GTK thread.
pub mod ordered_lane;
// Handing a file to the OS default app: launcher types and executables are
// refused (threat recheck gap 21, decision C2).
pub mod os_open;
// The app windows' navigation and new-window gate (decision D6).
pub mod nav_gate;
