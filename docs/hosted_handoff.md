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
→ 539 `core`, 84 `client`, 51 `admin`, 9 `off` (after the review below:
536 / 84 / 54 / 9; after the P1 review applied the user's three decisions of
2026-10-03: **521 / 85 / 68 / 9**). The plan's §1, §3.3, §4.3 and
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
  `mail_attachment_save`): the bytes are the daemon's. P2's server-side file
  picker (§3.5 transport table) must replace the dialog in these five bodies
  (`app.dialog()` in `commands/mail.rs`). *Corrected in review:* this list
  originally also named `export_project`, `remote_download_to` and
  `calendar_read_ics`/`calendar_write_ics`; those take a path the **frontend**
  picked through `@tauri-apps/plugin-dialog` (`ProjectExportDialog.tsx`,
  `FileTree.tsx`, `CalendarPane.tsx`), so P2 replaces the picker on the
  frontend side for them, not in Rust.
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
- **`install_ollama` is `admin`** (sudo + systemd service); the agent CLI
  installs (`install_agent`, `update_agent`, …) were `core` because they
  install into Tabtivity's own install home (`services::agent_install`).
  *Flipped in the P1 review (user decision 2026-10-03): every CLI
  install/update/remove is `admin`, and so is the shared Ollama's model
  management — see § P1 review.*
  *Corrected in review:* `install_vibe` is `core` too but **not** for that
  reason — it runs `curl … | bash` into the daemon user's own `$HOME`
  (`~/.vibe`, `ensure_vibe_ollama_model` appends to `~/.vibe/config.toml`);
  still bounded by that uid.
- **`dev_build_*` are `admin`**, `app_build_commit` `core`. *Corrected in
  review:* `dev_todo_*` are `admin` as well — they read and write `todo/*.md`
  under `dev_build::SOURCE_ROOT`, a checkout path baked into the binary at
  build time (the server's, not a user's).
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

## P0 review

*Written 2026-10-03 by the P0 reviewer. Range reviewed `f3efd50b..8d4e4384`;
fix `e4ce7f26`; this section the commit after it. Nothing run live.*

### What was checked

- **Classification**, by reading command bodies, not names: every command
  in `agents`, `apps`, `browser`, `calendar` (fetch/ics), `credentials`,
  `debug`, `exec_trust`, `fs` (external paths), `markdown`, `mobile_control`,
  `monitor`, `net_usage`, `network`, `ollama` (install/run/model management),
  `openvpn`, `projects` (sandbox, remote-control, compute hosts, saves),
  `project_runtime`, `remote`, `root_mcp`, `skills`, `spell`, `ssh`,
  `terminal` (`pty_spawn`, `register_host_bound_tab`, tmux), `vm`
  (`remote_download_to`), plus a sweep of the remaining modules and the
  services behind them (`agent_install`, `sandbox`, `spell`, `dev_todo`,
  `mobile_control::protocol::AdminRequest`, `browser_engine`'s hop gate).
  Also: every `opener::open` / `app.dialog()` / `arboard` call site in
  `commands/` against its row (all `client`, or one of the five documented
  mail dialogs); `exec_trust::require` sits in `format_source` and
  `compile_tex`. The four `Off(WholeDocumentSave)` rows are exactly the saves
  `headless_owner_plan.md` H1 refuses or replaces by CAS.
- **The completeness test**, with three mutations, each reverted: a
  `#[cfg(unix)]` line inside `generate_handler!`, a `crate::commands::…`
  path, and a renamed table row. All three fail loudly (the first two on the
  `unexpected entry` assert, the third naming the row). The `> 600` floor
  guards the zero-parse case; the handler list has no `#[cfg]` today (686
  `commands::` tokens in the range = 683 entries + 3 in comments).
- Code: `AppHandle`-free, matches `services/` style, file-map row accurate.

### Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | medium | `dev_todo_groups/read/write` were `core`: they read and write `todo/*.md` under `dev_build::SOURCE_ROOT`, a checkout path baked in at build time — the server's filesystem, same lane as `dev_build_*`. | fixed `e4ce7f26` → `admin` |
| 2 | low (docs) | Module notes and handoff said `export_project`, `remote_download_to`, `calendar_read_ics`/`write_ics` raise Rust-side dialogs; only the five `mail_*` ones do, the others take a frontend-picked path. P2 would have looked in the wrong place. | fixed `e4ce7f26` + this section |
| 3 | low (docs) | Handoff said `install_vibe` installs into the state dir like `install_agent`; it is `curl … \| bash` into the daemon user's `$HOME`. Class unchanged (uid-bounded). | fixed `e4ce7f26` + this section |

No `core` row was found that reaches another user's data, machine-wide
state, or runs project code outside `exec_trust`. Raw paths and ids in
`core` commands are the §4.3 relaxation (own user, own daemon); the phone
API's `mobile_control` invariant is untouched (`mobile_opaque_id` mints, the
sidecar's admin socket is per user).

### Open judgment calls (not flipped)

- **Ollama model management** (`pull_ollama_model`, `delete_ollama_model`,
  `load_ollama_model`, `stop_ollama_model`, `pause_ollama_pull`) is `core`.
  Against a *per-user* `ollama serve` that is right; against one shared
  system `ollama.service` (which `ensure_ollama_running` tries to
  `systemctl start` first on Linux) one user deletes everyone's models. The
  §4.4 loopback inventory already has "per-user ollama on 11434" as an open
  item — decide there, then revisit these rows (→ `admin` if shared).
- **`list_recent_downloads(paths)`** is `core` but the frontend feeds it the
  *desktop's* Downloads folder; on a server it lists the server-side path. A
  browser cannot list the client's downloads either, so P2 probably hides
  the feature (→ `client`) rather than serving it.
- **`switch_project_runtime`** is `client` (hides/shows OS windows) but its
  body also runs `brand_migration::project::on_project_open` and reads
  `projects.json`. A browser adapter that hides it drops the per-project
  migration — P2 should split the daemon half out. Not a class error, a
  mixed body.
- **`install_agent_remote*`** (`core`) resolve their target through
  `global_machines::find_by_id`, whose module is `admin`. Fine if admin
  machines are visible to users; otherwise these two fail on a server.
- **Fetchers** (`browser_reader_fetch`, `markdown_remote_image`,
  `calendar_fetch_ics`, `caldav_*`) fetch from the daemon. `browser_engine`
  blocks loopback/private *redirect* hops but allows the user's own hop 0,
  so a user can point the daemon at another user's loopback listener. §4.4
  files that under "every user has a shell" — same residual, nothing new.
- **`ensure_ollama_running`** attempts `systemctl start ollama` (system
  unit) before a user-level `ollama serve`; harmless without polkit rights,
  left `core`.

### Gates (worktree, 2026-10-03, after `e4ce7f26`)

| Gate | Result |
|---|---|
| `npm run build` | green |
| `npm test -- --reporter=dot` (alone) | 691 files, 7045 tests, all pass |
| `cargo test -q` | 3408 passed, 2 ignored |
| `npm run lint` | 0 errors, 31 warnings — the same pre-existing ones P0 listed, none in P0/review files |
| `cargo clippy --all-targets -- -D warnings` | No issues found |
| `scripts/brand-check.sh` | green |
| `scripts/privacy-check.sh` | green (and in the pre-commit hook) |
| `git diff --check f3efd50b HEAD` | clean |

## P1 (crate split, part 1) (partial)

*Written 2026-10-03 by the P1 crate-split agent. Base `a2f9f7f5` (P0 + review).
The headless-owner half of P1 (H0–H3) was already on `develop`; this section is
only the §3.2 extraction. Nothing run live.*

### Commits

| Commit | Content |
|---|---|
| `8c4e689a` | The `app-core` crate (`src-core/`): `CoreCtx`, `CoreState`, `EventSink`, `Caller`, `ClientId`, `rt`; `src-tauri/src/tauri_host.rs` (Tauri as the sink, `Ctx` extractor, `install`); `lib.rs` builds `CoreState`; CI tests/lints the crate. |
| `f3477d51` | `brand.rs` and the ten leaf services move into the crate; the desktop re-exports them. Brand tooling follows the file. |
| `84d3991d` | `terminal/mod.rs` emits through `CoreCtx`. |
| `d160cd70` | The seven services → `CoreCtx`; `commands/{git_peer,remote,project_runtime}.rs` → `Ctx`; the `tauri::async_runtime` users among services → `app_core::rt`. |
| `e174948e` | `commands/terminal.rs` → `Ctx`; `CONVERTED_COMMAND_FILES` + its guard test. |
| `e59074e0` … `643d17a0` | One commit per command file (17): projects, sync, fs_watch, disk_usage, usage_stats, caldav, credentials, network, hpc_ws, ssh, git, agent_prompts, agent_tasks, app_update, project_transfer, pdf_markup, os_clock. |
| `331f5403` … `0b8baf43` | One commit per file: agents, spell, tex, vm, openvpn, copilot (`Window` → `ctx.caller`), ollama (`complete_text` → `emit_to_caller`). |
| `a23d0185` | `mobile_control.rs` + `root_mcp.rs` together with the `lib.rs` change that hands both the system `CoreCtx` at setup. |
| `be19e3f5` | `mail.rs`: 69 commands → `Ctx`; the five Rust-raised dialogs keep an `AppHandle`, so the file is not in the guard list. |
| `f1f8a761` | the frontend tests and tooling follow the moved files (see Gates). |
| the commit after | this section, the plan's P1 bullet. |

### Crate layout

```
Cargo.toml                 workspace: members = ["src-core", "src-tauri"]
src-core/                  package `app-core`, lib `app_core`   ← the plan's "tabtivity-core"
  Cargo.toml               no `tauri`, ever; deps the moved modules need (+ rustls as a dev-dep)
  src/lib.rs               brand, ctx, rt, services; re-exports the ctx types
  src/brand.rs             moved as-is (the ONE place the name is spelled; build.rs includes it by path)
  src/ctx.rs               CoreCtx / CoreState / EventSink / Caller / ClientId / NullEvents / RecordingEvents
  src/rt.rs                spawn / spawn_blocking / block_on over the host-installed tokio handle
  src/services/mod.rs      agent_usage big_folders fence_scope git_guard remote_agents
                           schedule_usage text_completion vm_proxy web_safety webkit_a11y
src-tauri/                 the desktop host (unchanged package `tabtivity`, lib `app_lib`)
  src/tauri_host.rs        TauriEvents, install, system_ctx, Ctx (CommandArg), CONVERTED_COMMAND_FILES
  src/lib.rs               `pub use app_core::brand;` + the macros; `core_state(...)`; `tauri_host::install` first in setup
  src/services/mod.rs      `pub use app_core::services::<x>;` for each moved module
```

**Why `app-core`, not `tabtivity-core`.** `scripts/brand-check.sh` forbids the
app's name in code, and every `tabtivity_core::` path would be a hit; the
desktop lib is `app_lib` for the same reason. Rename when the brand rule says
so, not before.

**Why only ten services moved.** `scripts`-free dependency closure
(`deps.py`, not committed): 126 `crate::commands::…` references from
`services/` (plus `storage → brand_migration → commands::git`,
`paths → agent_bin → commands::agents`) pin almost everything to the desktop
crate until the command bodies move too. Moving a module means: nothing it
reaches via `crate::` is still in `src-tauri`. P3's finishing move is therefore
mostly one big closure, not many small ones — convert bodies first (this
section's pattern), then move whole subtrees.

### `CoreCtx` design (as built)

```rust
pub struct CoreCtx { pub state: Arc<CoreState>, pub events: Arc<dyn EventSink>, pub caller: Caller }
pub enum Caller { System, Local(ClientId), Client(ClientId) }      // client() -> Option<&ClientId>
pub struct ClientId(String);  // desktop: the window label; ClientId::MAIN == "main"
pub trait EventSink: Send + Sync {
    fn emit_json(&self, event: &str, payload: String);            // broadcast
    fn emit_json_to(&self, client: &ClientId, event: &str, payload: String);
}
impl dyn EventSink { fn emit<S: Serialize>(..); fn emit_to<S: Serialize>(..) }  // serialize ONCE
impl CoreCtx { fn get<T>(&self) -> &T; fn emit(..); fn emit_to(..); fn emit_to_caller(..); fn with_caller(..); fn system(..) }
```

- `CoreState` is a **type-keyed map** (`manage` builder / `get` panics like
  Tauri's `State` / `try_get`), not named fields: the singleton types still
  live in `commands/*.rs` (`RegistryState`, `MailState`, …) and could not be
  named from the core. `lib.rs::core_state` fills it with **clones of the same
  `Arc`s Tauri manages** — never two values, or the two halves of the app see
  different state. `core_state_types_are_distinct` guards the keying (two
  aliases over one `Arc<Mutex<HashMap<String, …>>>` would collide). P3 may turn
  the hot ones into fields once their types are in the core.
- The plan's `ClientTarget` is `ClientId`: a broadcast is `emit`, one client is
  `emit_to`. Nothing needed a third shape yet.
- Payloads cross the sink **already serialized** (`emit_str`/`emit_str_to` on
  the Tauri side), so the terminal output path pays no second serialization.
- `rt::install(handle)` is called from `tauri_host::install` with Tauri's
  runtime; with nothing installed `rt` uses the current runtime, else a lazy
  fallback — `tauri::async_runtime`'s own semantics, so `block_on` from a
  runtime worker still panics exactly as before.
- **`Ctx` (src-tauri) is a newtype over `CoreCtx`** because the orphan rule
  forbids `impl CommandArg for CoreCtx` outside Tauri. It derefs; a body that
  needs the owned context writes `ctx.0.clone()`. Its caller is
  `Caller::Local(<calling webview's label>)` — the window label comes from the
  invoke, never from payload (the `pty_set_visible` rule, now the extractor's).
- `tauri_host::system_ctx(&app)` is the bridge for `lib.rs` hooks and the
  not-yet-converted callers.

### What "converted" means, and the guard

A `commands/*.rs` file is converted when nothing of `tauri` is left in it but
the `#[tauri::command]` attribute: no `use tauri::…`, so no `State`,
`AppHandle`, `Window`, `Emitter`, `Manager`, `async_runtime`. The body then
depends only on `Ctx`/`CoreCtx`, and P2's dispatcher can call it as a plain
function (`#[tauri::command]` leaves the fn callable) with a `Caller::Client`
context — the attribute is the only thing P3 removes when the body moves.
`tauri_host::CONVERTED_COMMAND_FILES` lists them;
`converted_command_files_stay_tauri_free` fails if one slides back. Add a file
to the list in the commit that converts it, never before.

Conversion was mechanical (`convert_cmds.py`, scratch, not committed):
`app: AppHandle` → `ctx: Ctx`; `x: State<'_, T>` → removed, `let x =
ctx.get::<T>();` first in the body, `x.inner()` → `x`; `&app` → `&ctx`,
by-value `app` → `ctx.0.clone()`, `app.emit` → `ctx.emit`;
`tauri::async_runtime::` → `app_core::rt::`; helper fns `app: &AppHandle` →
`ctx: &CoreCtx`. Hand work: `Window`-taking commands (`pty_set_visible`,
`complete_text`, the six `copilot_*`) read `ctx.caller`; commands that call
another command directly pass `ctx` on (`mail_search → mail_headers`); a
spawned thread that outlives the call clones the context first (`watch_dir`).

### Converted / remaining

**Converted (in `CONVERTED_COMMAND_FILES`, 56 files):** `agent_prompts.rs`, `agent_tasks.rs`, `agents.rs`, `app_update.rs`, `boxes.rs`, `brand_migration.rs`, `caldav.rs`, `calendar.rs`, `copilot.rs`, `crash.rs`, `credentials.rs`, `default_apps.rs`, `disk_usage.rs`, `exec_trust.rs`, `format.rs`, `fs_watch.rs`, `git.rs`, `git_fork.rs`, `git_hosting.rs`, `git_peer.rs`, `git_publish.rs`, `git_pull.rs`, `global_machines.rs`, `hpc_ws.rs`, `local_loss.rs`, `markdown.rs`, `mobile_control.rs`, `monitor.rs`, `net_usage.rs`, `network.rs`, `ollama.rs`, `openvpn.rs`, `os_clock.rs`, `pdf_markup.rs`, `power.rs`, `project_runtime.rs`, `project_transfer.rs`, `projects.rs`, `python.rs`, `remote.rs`, `root_mcp.rs`, `search.rs`, `settings.rs`, `sheets.rs`, `skills.rs`, `slurm.rs`, `spell.rs`, `sqlite.rs`, `ssh.rs`, `sync.rs`, `synctex.rs`, `terminal.rs`, `tex.rs`, `timer.rs`, `usage_stats.rs`, `vm.rs`.

Of these, 30 needed nothing (their bodies never touched Tauri); the plan's
"388 move as they are" is them.

**Remaining (`commands/*.rs` still reaching Tauri):**

| File | What is left | Class / note |
|---|---|---|
| `mail.rs` | 5 Rust-raised dialogs (`app.dialog()`) keep an `AppHandle`; the other 69 commands take `Ctx` | core — P2's server-side picker replaces the five bodies |
| `fs.rs` | 17 `State` params are convertible; 4 commands return `tauri::ipc::Response` and 1 takes `ipc::Request` (`fs.rs:1580/1702`) | core — the binary-frame transport of §3.5 (P2) decides their shape; convert the rest then |
| `apps.rs` | `start_file_drag(Window)` + the drag plugin; the default-app map and `run_script_detached` are core | mixed — split the file or convert the core part |
| `browser.rs` | live-window commands build webviews; `browser_check_url`, `browser_reader_fetch` are core | mixed — same |
| `debug.rs` | webview/renderer introspection | client |
| `workspace.rs`, `subwindow.rs`, `presenter.rs`, `screenshot.rs`, `clipboard.rs`, `printing.rs`, `print_native.rs`, `pdf_clip.rs`, `ide.rs` | window / OS / dialog work | client — stay in `src-tauri` by the table |

Services still taking Tauri: only `window_service.rs` (`WebviewWindow`,
client by design). `grep -rn 'tauri' src-tauri/src/services` finds nothing
else but prose.

### Gotchas for P2 / P3

- **A Tauri `emit` is a broadcast to every webview**, and the terminal uses
  that: `terminal-output:<label>` is a *name*, not a target. Keep the names
  until the browser client speaks; the daemon's sink can then route by
  `ClientId` and drop the suffixing (`terminal/mod.rs::emit_output`).
- **`Caller::System` has no client.** `pty_set_visible` and the `copilot_*`
  commands refuse it; `emit_to_caller` degrades to a broadcast. A dispatcher
  must always build `Caller::Client(id)` for an incoming call.
- **`CoreState::get` panics for an unmanaged type** (Tauri's contract). The
  daemon must manage every type `lib.rs::core_state` manages, or `try_get`.
  The mobile desktop bridge already uses `try_get` for `MailState`.
- **Sync commands may spawn**: `app_core::rt::spawn` works from any thread
  once `install` ran; in a daemon call `rt::install` before serving.
- **The lib tests take ~12 min** on this machine; run them alone, never beside
  `npm test`.
- The `text_completion` tests need a rustls provider in whichever binary
  runs them (`tests::client` installs ring); a future daemon binary must call
  `mail_engine::install_crypto_provider()` before any `reqwest` client, as
  `lib.rs::run` does.
- `scripts/backend-stale.sh` only looks under `src-tauri/`; a `src-core/` edit
  is a backend edit too but is not yet reported as stale. Small follow-up.
- The `rust-cache` step in CI still says `workspaces: ./src-tauri -> target`
  (pre-existing; the real target dir is the workspace root's). Harmless but
  worth correcting to `. -> target` when someone touches CI.
- `command_class.rs` stayed in `src-tauri` on purpose: its test parses
  `generate_handler!` out of `lib.rs`. It goes wherever the
  `tabtivity_commands!` macro goes (P2).

### Open for the P1 reviewer — user decisions (2026-10-03)

Recorded here as the user stated them; not yet applied to
`services/command_class.rs` or the plan. The reviewer (or P2) flips the rows
and updates §3.3/§4.4:

1. **One shared Ollama per server; only the admin changes or starts models.**
   `pull_ollama_model`, `delete_ollama_model`, `pause_ollama_pull`,
   `load_ollama_model`, `stop_ollama_model` → `Admin` (the P0 review's open
   call, decided). Because Ollama auto-loads whatever a request names, user
   requests (`complete_text`, chat, embeddings) must be limited to the
   admin-allowed models — a server-side allowlist check before the request
   reaches Ollama, not a UI filter. Plan §3.3 and the §4.4 loopback inventory
   assumed a per-user `ollama serve` on 11434 and need updating.
2. **`list_recent_downloads` → `Client`**: it means the client device's own
   downloads, never the server's.
3. **Only the admin installs, updates or removes agent CLIs.** `install_agent`,
   `install_agent_remote*`, `install_vibe`, and the CLI update/uninstall
   commands → `Admin`. A CLI's self-updater must not install per user on a
   server (the server-wide install root of §5.1 is admin-owned); the
   `claude_native_updater`-style flows need a server-mode guard.

### Gates (worktree, 2026-10-03, at the final commit)

| Gate | Result |
|---|---|
| `npm run build` | green (tsc + both bundles) |
| `npm test -- --reporter=dot` (alone) | **691 files, 7045 tests, all pass** at `f1f8a761`. **Not green between `f3477d51` and `be19e3f5`**: four files read `brand.rs`/`web_safety.rs` by their old path (ENOENT); `f1f8a761` repoints them. Run `npm test` after every backend file move, not only at the end — the lesson of this section. |
| `cargo test -q` (src-tauri) | 3155 lib (2 ignored) + 168 integration, all pass; `codex_bind::a_watched_tree_is_walked_only_after_a_change` failed once while a second test binary ran beside it, 3/3 alone |
| `cargo test -q` (src-core) | 97 passed |
| `npm run lint` | 0 errors, 31 warnings — the same pre-existing ones P0 listed, none in P1 files |
| `cargo clippy --all-targets -- -D warnings` | clean for both crates |
| `scripts/brand-check.sh` | green (48 entries; `src-core/src/brand.rs` is the brand module now) |
| `scripts/privacy-check.sh` | green on every commit (pre-commit hook) |
| `git diff --check` | clean |

The frontend gates were run at the end rather than per commit; every
Rust gate ran per commit (`cargo check --all-targets` and clippy on each, the
module tests per batch, the full lib suite three times). Remaining P1 work for
whoever continues: `fs.rs`'s 17 `State` params (leave the five binary-frame
commands), the core halves of `apps.rs` and `browser.rs`, and the three class
flips under *Open for the P1 reviewer*.

## P1 review

*Written 2026-10-03 by the P1 reviewer. Range reviewed `a2f9f7f5..71751236`
(33 commits); fixes and decisions in the commits listed below; this section the
commit after them. Nothing run live.*

### What was checked

- **Behaviour preservation on the desktop**, by reading the diffs of
  `terminal/mod.rs`, the seven services, `commands/{terminal, projects, sync,
  remote, git_peer, mobile_control, root_mcp, agents, copilot, ollama, mail}.rs`
  in full and the other 15 converted command files hunk by hunk. Every `app.emit`
  became `ctx.emit` (Tauri `emit` = `EventTarget::Any`, and `TauriEvents::emit_json`
  is `emit_str` to the same target); event names and payload types are unchanged
  (the sink serializes the same `Serialize` value once; `json!` payloads are the
  same objects). The two targeted emits kept their target: `complete_text` went
  from `window.emit_to(window.label(), …)` to `emit_to_caller` → `emit_str_to(<label>)`,
  the mobile bridge from `emit_to("main", …)` to `emit_json_to(ClientId::main())`.
  `Ctx`'s caller is the calling **webview's** label; the old `Window` arg was the
  **window's**. They are the same string here: every webview the app builds is a
  `WebviewWindowBuilder` (browser.rs too, no `unstable` multi-webview), so
  `pty_set_visible`'s viewer identity and `copilot`'s editor key are unchanged.
- **Startup order.** Config windows are built and `setup` runs before Tauri's
  event loop processes any IPC (`tauri-2.11.3/src/app.rs:2525-2531`), so no command
  can extract `Ctx` before `tauri_host::install` has managed the `CoreCtx`. Every
  `app_core::rt::spawn` caller in `lib.rs::run` (`net_usage`, `usage_stats`,
  `start_host_on_launch`, `root_mcp`, `brand_migration::sweep_at_launch`) sits in
  `setup` after `install`, so nothing lands on the fallback runtime; `block_on`
  callers (`root_mcp::stop_for_exit`, `copilot_auth`, `AgentMail`) run on plain or
  blocking-pool threads as before. The `--mobile-host` sidecar path
  (`main.rs`, `mobile_control/host.rs`, `HeadlessSpawner`) is untouched by the
  range and links nothing that now needs a `CoreCtx`.
- **State sharing.** Every type `core_state` manages is an `Arc<…>` or wraps one
  (`UsageWatchState`'s two fields, `MobileDesktopState.pending`), so Tauri's
  `State<T>` and `ctx.get::<T>()` see one instance; `core_state_types_are_distinct`
  covers the type keying. No lock is held across an `await` that was not before
  (`ctx.get` returns a borrow of the owned context, like `State<'_, T>` did).
- **The guard test** (`converted_command_files_stay_tauri_free`): checked that
  `use tauri::State;`, `tauri::Window` in a signature and a `::tauri::` path all
  trip it, that `tauri_host`, `src-tauri` in strings and `//` comments do not.
  The P0 completeness test is unchanged and still parses `lib.rs`'s handler list.
- **Build/CI plumbing**: `build.rs` includes the brand module by its new path;
  `scripts/{brand-check,brand-flip,lib/brand,rename-codemods/prose-pass}.sh`
  follow it; CI tests and lints `src-core` on all three OSes; `package-dev.sh`
  builds from a detached worktree of the whole tree (so `src-core/` is in a frozen
  build); `Cargo.lock` carries `app-core`.
- **Windows/macOS**: `cargo check --target x86_64-pc-windows-msvc` (the RC/lib
  shims of `docs`/memory) on the range's tip, then on the fixes.

### Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **high** (Windows/macOS build) | `src-core/src/services/mod.rs` declared `pub mod fence_scope;` unconditionally; in `src-tauri` it was `#[cfg(target_os = "linux")]`. The module uses `libc`, `PermissionsExt::mode` and `CommandExt::exec`, so `app-core` failed to compile for `x86_64-pc-windows-msvc` (14 errors) and would for macOS — CI's `test-windows`/`test-macos` jobs red. | fixed ``41aff999``: gated like the desktop's re-export |
| 2 | **high** (Windows build) | `commands/mobile_control.rs`, the `#[cfg(windows)]` arm of `start_desktop_bridge`: the conversion left `let app = ctx.clone();` unused and moved `ctx` into the per-connection task inside the accept loop (E0382 on the second iteration). The `#[cfg(not(any(unix, windows)))]` stub still named the removed `AppHandle` import. | fixed ``9f644149`` |
| 3 | medium (tooling) | `scripts/backend-stale.sh` scanned only `src-tauri/`; an edit under `src-core/`, or to the root `Cargo.toml`/`Cargo.lock` (which the workspace moved up), was a backend edit the window could not pick up and the script called current. | fixed `add3f1c0` |
| 4 | low (CI) | `rust-cache`'s `workspaces: ./src-tauri -> target` named a target dir that does not exist (the workspace root's `target/` is the real one, and so is `Cargo.lock`), so the cache never hit. Pre-existing, flagged by the P1 handoff. | fixed `b183fb3a`: `. -> target` |

No behaviour change was found in the converted desktop paths. Noted, not
changed: `complete_text` used to turn an `emit_to` error into the completion's
`Err`; the sink is best-effort by contract, so a failed delivery now ends the
stream silently — Tauri's `emit_to` only fails on serialization, which a
`String` payload cannot. `handle_desktop_stream` likewise answers "unavailable"
only when serialization fails (the one thing that could fail before, too).

### The three user decisions (2026-10-03), applied in `b4fab29e`

| Decision | Rows flipped | Where written |
|---|---|---|
| One shared Ollama per server; only the admin changes or starts models | `pull_ollama_model`, `pause_ollama_pull`, `delete_ollama_pull`, `delete_ollama_model`, `delete_partial_blob`, `load_ollama_model`, `stop_ollama_model` → `admin`; **also `ensure_ollama_running`** (its fallback is a user-level `ollama serve`, which on a server would take the shared port with that user's own store — the reviewer's extension of "start models", flagged in the report). `clear_pending_ollama_pull` (a record in the caller's own state) and the read-only `list_*`/`ollama_*_status` rows stay `core`. The admin-allowed model list for completion/chat/local-model tabs is written into §3.3 and P2 of §10, not built. | plan §3.3 (table rows + decided block), §4.4 (one shared loopback listener, its residual), §10 P2/P3; `command_class.rs` module doc |
| `list_recent_downloads` is the client device's | → `client` | §3.3 |
| Only the admin installs, updates or removes agent CLIs | `install_agent`, `install_agent_remote`, `install_agent_remote_command`, `update_agent`, `uninstall_agent`, `install_vibe` → `admin`. `check_agent_updates`, `agent_versions`, `agent_is_installed`, `dismiss_agent_version` (reads and a per-user dismissal) and `ensure_vibe_ollama_model` (the user's own `~/.vibe` alias; allowlist-bound later) stay `core`. | §3.3, §5.1 (per-user install root gone in server mode; self-updaters switched off per home; remote installs are the admin's), §10 P3 |

Counts: 683 commands → **521 `core`, 85 `client`, 68 `admin`, 9 `off`** (were
536 / 84 / 54 / 9). `the_examples_of_the_plan_hold` and the completeness tests
pass; the P0 section's counts carry the new numbers.

### Gates (worktree, 2026-10-03, at ``9f644149``, run alone in sequence)

| Gate | Result |
|---|---|
| `cargo check --target x86_64-pc-windows-msvc` (src-tauri, pulls in src-core) | green (36 s incremental; 5 pre-existing warnings in files the range did not touch: `home_io.rs`, `agent_auth.rs`, `copilot/process.rs`, `headless.rs`). Red before finding 1 (14 errors in `app-core`). |
| `npm run build` | green (tsc + both bundles) |
| `npm test -- --reporter=dot` | **691 files, 7045 tests, all pass** (105 s) |
| `cargo test -q` (src-tauri) | 3155 lib (2 ignored) + 168 integration = 3323 passed, 0 failed, 14 binaries |
| `cargo test -q` (src-core) | 97 passed |
| `npm run lint` | 0 errors, 31 warnings — the same pre-existing ones P0/P1 listed (via `rtk proxy`; the RTK wrapper garbles eslint's output) |
| `cargo clippy --all-targets -- -D warnings` (src-tauri) | clean |
| `cargo clippy --all-targets -- -D warnings` (src-core) | clean |
| `scripts/brand-check.sh` | green (48 entries) |
| `scripts/privacy-check.sh` | green, and in the pre-commit hook on every commit |
| `git diff --check` | clean |

### Left for P2

- The handoff's own P1 list (`fs.rs`'s 17 `State` params, the core halves of
  `apps.rs`/`browser.rs`) stands.
- `switch_project_runtime` (P0 review) is still a mixed body.
- When a non-`WebviewWindow` webview ever invokes a command, `Ctx` should take
  `webview.window().label()` to keep the `Window` semantics; today the two
  labels coincide everywhere.
