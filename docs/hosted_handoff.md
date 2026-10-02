# Tabtivity Hosted — handoff

*One section per phase of [`tabtivity_hosted_plan.md`](tabtivity_hosted_plan.md).
Each phase's agent appends its own section; nothing here was run live unless a
section says so. Worktree: `.claude/worktrees/hosted`, branch `hosted`,
created from `develop` at `f3efd50b`.*

## P0

*Written 2026-10-03 by the P0 agent. Base `f3efd50b`. Nothing run live.*

### Commits

| Commit | Content |
|---|---|
| `161b41a0` | `src-tauri/src/services/command_class.rs` (the class table + four tests), its `pub mod` in `services/mod.rs`, its `docs/filemap_backend.md` row. |
| the commit after it | this section, the plan's P0 bullet struck. |

Q1, Q3, Q4 and all of §12 were answered before P0 started (plan §14); P0 did
not reopen them.

### What was built

`services::command_class` — `AppHandle`-free, as §3.3 and the P2 dispatcher
need it:

- `enum CommandClass { Core, Client, Admin, Off(OffReason) }` with
  `as_str()` wire tokens (`core` / `client` / `admin` / `off`) and `is_core()`.
- `enum OffReason { OsKeychain, WholeDocumentSave, HeadlessOwner, LocalCliFiles }`
  with `as_str()` tokens (`os-keychain`, `whole-document-save`,
  `headless-owner`, `local-cli-files`) — the "named reason" §3.3 asks `off`
  to refuse with; the frontend turns the token into an i18n sentence later.
- `static TABLE: &[(&str, CommandClass)]`, one row per registered command,
  keyed by the **bare command name** (what `invoke` passes; Tauri already
  requires it to be unique), grouped by `commands/*.rs` file in the order
  `lib.rs` lists them.
- `class_of(name) -> Option<CommandClass>`, `all()`, `names_in(class)`.

**Counts, from the actual registration, not the plan's 658:** 683 commands
→ 539 `core`, 84 `client`, 51 `admin`, 9 `off`. The plan's §1, §3.3, §4.3 and
§14 still say 658 (and 388/57/211); those are the 2026-09-29 numbers and were
left as history — the P0 bullet carries the current count.

### The completeness test (the gate)

`tests::registered_commands()` reads `include_str!("../lib.rs")`, finds
`generate_handler![`, and collects every `commands::…::name` token up to the
line that starts with `])`, ignoring `//` comments (one entry carries a
trailing `// deprecated` comment). Four tests:

- `every_registered_command_has_a_class` — the one §3.3 asks for; names the
  missing commands.
- `every_classified_command_is_registered` — a row for a removed command fails
  too, so the table cannot rot.
- `table_has_no_duplicate_rows`.
- `the_examples_of_the_plan_hold` — one representative per §3.3 cell.

Verified negative: deleting the `pty_write` row makes three of the four fail,
the first with the missing name in its message.

The parser only understands `commands::a::b` paths. If someone registers a
command through another path, the test says so (`unexpected entry in
generate_handler!`) rather than silently skipping it — extend the parser then,
do not loosen it. When P1/P2 replace the list with the `tabtivity_commands!`
macro of §3.2, the macro should **emit this table** (or be generated from it)
and this parser goes away; until then the two lists are kept in step only by
the test.

### Classification decisions worth knowing

The module header documents the rows that look misplaced. The short list:

- **Whole-document saves are `off`** (`WholeDocumentSave`): `save_settings`,
  `save_boxes`, `save_default_apps`, `save_tab_layout`. The headless owner
  (H1, on `develop`) already refuses `save_tab_layout` once a scope is
  versioned and gives the other three CAS/patch siblings (`patch_settings`,
  `patch_default_apps`, `workspace_sync`), which are `core`.
- **`mobile_desktop_respond` is `off`** (`HeadlessOwner`): it is the window
  answering the phone, which H3 made the owner's job; no browser client should
  take that role.
- **`agent_login_import` and `agent_global_import` are `off`**
  (`LocalCliFiles`): both read *this computer's* `~/.claude`/`~/.codex`/
  `~/.gemini`. On a server the user signs in through sign-in tabs (§5.1). A
  P5 Tauri-shell Connect mode could revive them as `client`.
- **Only the keychain *unlock* pair is `off`** (`keyring_state`,
  `keyring_unlock`). Every `*_password_state` / `*_forget_password` /
  `*_has_saved_password` command is `core`: §6.8 moves the opt-in store off the
  OS keychain, the commands' meaning survives. The `vpn_*` ones are `admin`
  with the rest of OpenVPN.
- **Rust-raised file dialogs stay `core`** (`mail_attach_pick`,
  `mail_pgp_import_pick`, `mail_contacts_import`, `mail_contacts_export`,
  `mail_attachment_save`, `export_project`, `remote_download_to`,
  `calendar_read_ics`/`calendar_write_ics`): the bytes are the daemon's. P2's
  server-side file picker (§3.5 transport table) must replace the dialog in
  these bodies — they take an `AppHandle` today for the dialog alone. Grep
  `dialog` in `commands/mail.rs` and `commands/project_transfer.rs` when you
  get there.
- **`system_monitor_snapshot` is `core`** (host-aware: a project's remote host,
  else the daemon's machine); the bare this-machine `monitor` readings
  (`gpu_memory_snapshot`, `gpu_process_snapshot`, `machine_load_snapshot`),
  `debug_app_resource_usage`, the `webview_renderer_*` family and
  `get_net_usage`'s siblings follow §3.3's "sysstat/gpustat of *this* machine"
  → `client`. `get_net_usage(project_id)` itself is `core` (the sampler runs
  where the project runs). If the user wants the *server's* load in the
  header, that is a P2 UI question, not a table change.
- **Containers are `admin`** (`sandbox_preflight`, `set_project_sandbox`,
  `set_project_sandbox_spec`) per §9 ("the Docker socket is root on the host";
  rootless Podman is P5). `register_host_bound_tab` is `core` (a grant file in
  the state dir).
- **`install_ollama` is `admin`** (sudo + systemd service); `install_vibe`
  and the agent CLI installs (`install_agent`, `update_agent`, …) are `core`
  because they install into the user's own state dir.
- **`dev_build_*` are `admin`**, `dev_todo_*` and `app_build_commit` `core`.
- **Mobile host plumbing is `admin`** (`mobile_host_apply`,
  `mobile_host_status`, `mobile_tailscale_serve_status`,
  `mobile_verify_tailscale_serve`): starting the per-user unit is the admin
  helper's job on a server (§3.1). Pairing (`mobile_admin`), the opaque-id
  minting and the global inbox listing are `core`; `global_inbox_open/reveal`
  and the desktop-images pair are `client`.
- **The whole `workspace` command module is `client`** (OS virtual desktops,
  window show/hide, the super key, Wi-Fi SSID / connection type / network
  identity), as is `switch_project_runtime` (hides and shows OS windows).
- **`ide`, `apps` (except the two default-app map commands and
  `run_script_detached`), `printing`, `presenter`, `subwindow`,
  `screenshot`, `clipboard`, `browser`'s live-window commands** → `client`.
  `browser_check_url` and `browser_reader_fetch` are `core` (policy gate +
  a network fetch from the daemon).

### Gates (worktree, 2026-10-03)

| Gate | Result |
|---|---|
| `npm run build` | green (tsc + both bundles) |
| `npm test -- --reporter=dot` | **691 files, 7045 tests, all pass** when run alone. A first run concurrent with `cargo clippy` showed 41 timeouts in 5 files — CPU contention, not a regression; re-run alone was clean. |
| `cargo test -q` | green; `command_class` adds 4 tests (3238 others filtered in the targeted run) |
| `npm run lint` | 0 errors, **31 pre-existing warnings** (`no-explicit-any` and friends in 18 files none of which P0 touched — `TableView.tsx`, `YamlGrid.tsx`, `Deck*.tsx`, `PdfViewer.tsx`, `FileBrowser.tsx`, `FileTree.tsx`, `ProjectFilesView.tsx`, `CalendarIndicator.tsx`, `TodoIndicator.tsx`, `VpnPasswordPrompt.tsx`, `SystemMonitorPane.tsx`, `TerminalView.tsx`, `TodoAgendaRail.tsx`, `notebook.ts`, `mobile-web/.../Terminal.tsx`). They are on `develop` at `f3efd50b` as well; AGENTS.md says the gates sit at zero warnings, so someone should look — not P0's to fix. |
| `cargo clippy --all-targets -- -D warnings` | "No issues found" |
| `scripts/brand-check.sh` | green |
| `scripts/privacy-check.sh` | green (also ran in the pre-commit hook) |
| `git diff --check` | clean |

The post-commit hook queued the usual frozen dev build and printed that the
*running* sidecar's embedded PWA differs from this worktree's fresh
`mobile-dist/` — expected for a worktree build; nothing was started or
stopped.

### Deferred / for P1 and P2

- **Nothing of §3.3 is left.** No `tabtivity_commands!` macro, no
  `commandClasses.ts`, no `server_capabilities` — all P1/P2 by the plan.
- P2's `commandClasses.ts` generator: emit from `command_class::all()` (a
  `build.rs` step or a `cargo test`-checked committed file, like the
  `untested` register). The wire tokens are already fixed by `as_str()`.
- P2's `server_capabilities` should carry `(name, class, off_reason?)` for
  every row plus `HOST_OS`; `names_in(CommandClass::Core)` is the dispatcher's
  allowlist. Make the daemon check `class_of(cmd) == Some(Core)` **before**
  argument parsing, so an unknown name is refused, never defaulted.
- P1's seven `AppHandle`-taking services and `terminal/mod.rs` (§3.2) are
  untouched here.
- Gotcha: the table is by bare name, so if two modules ever define the same
  command name Tauri fails first — but a renamed command needs its row renamed
  too (the stale-row test tells you).
- Gotcha: `rtk` rewrites what Bash prints; read `command_class.rs` through
  `rtk proxy cat` or the Read tool when checking rows.
